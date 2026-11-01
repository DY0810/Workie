import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { and, eq, sql } from 'drizzle-orm';
import type { TransactionMode } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratePrivateDb, openPrivateDb, type PrivateDb } from '../private-db/index.ts';
import {
  applications, applicationEvents, documents, legacyImportPreviews, manualApplicationMarks,
  policyHeads, policyVersions, profileHeads, profileVersions, user,
  questions, questionAnswers, questionInterventions, inboxReads,
} from '../private-db/schema.ts';
import { createEmptyProfile, type Profile } from './profile.ts';
import { createEmptyPolicy, PolicySchema, type Policy } from './policy.ts';
import { hashValue, mutatePolicy, saveProfile } from './stores.ts';
import { createPairing, pairWorker, revokeWorker } from './pairing.ts';
import { createRun, commandRun, commandApplication } from './runs.ts';
import { enqueueApplication } from './test-enqueue.ts';
import { pollWorker, heartbeatWorker } from './leases.ts';
import { recordWorkerEvent } from './events.ts';
import { type WorkerOptions } from './worker-store.ts';
import { workerTransport } from '../../worker/transport.ts';
import { formQuestions, screeningQuestions } from '../../worker/screening.ts';
import {
  AnswerCommandSchema, QuestionDescriptorSchema, QuestionDetailSchema, validQuestionAnswer,
  type AnswerCommand, type AnswerValue, type QuestionDescriptor, type QuestionField, type QuestionBatch,
  type InterventionAck,
} from './question-protocol.ts';
import {
  answerQuestion, answerQuestions, getInbox, getInboxStatus, getQuestion, markInboxRead, registerQuestionBatch,
  requestQuestionFocus,
  pollQuestionInterventions, ackQuestionIntervention,
} from './questions.ts';

import { stubHousehold } from '../test-household.ts';
vi.mock('server-only', () => ({}));
const nativeFetch = globalThis.fetch;
let db: PrivateDb, other: PrivateDb, dir: string, now: number, options: WorkerOptions, profile: Profile;
const request = () => ({ requestId: randomUUID() });
const secret = () => randomBytes(32).toString('base64url');
const field: QuestionField = { type: 'boolean', allowBlank: false, declineValue: null, units: null, precision: null };
const descriptor = (overrides: Partial<QuestionDescriptor> = {}): QuestionDescriptor => ({
  key: 'availability', kind: 'needs_answer', originalWording: 'Can you work the stated hours?',
  reason: 'User confirmation required.', required: true, meaning: { id: 'stated-hours', reviewId: null },
  schemaVersion: 1, scope: { kind: 'applicant', country: null, employer: null, applicationId: null,
    includesSubsidiaries: false, timeframe: 'current', validFrom: null, validUntil: null,
    ats: 'fixture', tenant: 'employer', version: 1 },
  provenance: { source: 'user', sourceId: null, sourceVersion: null, excerpt: null },
  field, factIds: [], sensitive: false, ...overrides,
});
const appRow = async (id: string) => (await db.select().from(applications).where(eq(applications.id, id)))[0];
const qRow = async (id: string) => (await db.select().from(questions).where(eq(questions.id, id)))[0];
async function prepared(ownerId = 'alice', tenant = 'employer') {
  const grant = await createPairing(db, ownerId, { ...request(), expectedRevision: 0, label: 'Synthetic' }, options);
  const token = secret(), worker = await pairWorker(db, { ...request(), protocolVersion: 1, workerId: randomUUID(),
    grant: grant.grant, workerToken: token, workerVersion: '0.1.0', capabilities: ['control-v1'] }, options);
  const run = await createRun(db, ownerId, { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
  const app = await enqueueApplication(db, ownerId, run.id, { ats: 'fixture', tenant, requisition: randomUUID() }, options);
  return { ownerId, token, worker, run, app };
}
type Fixture = Awaited<ReturnType<typeof prepared>>;
async function batch(f: Fixture, values: QuestionDescriptor[] = [descriptor()]) {
  const lease = (await pollWorker(db, f.token, { protocolVersion: 1 }, options)).lease!;
  expect(lease?.applicationId).toBe(f.app.id);
  const input: QuestionBatch = {
    questionProtocolVersion: 1, eventId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision,
    expectedProfileRevision: f.ownerId === 'alice' ? (await db.select().from(profileHeads))[0].revision : 0,
    checkpoint: { stage: lease.state as 'screening', sequence: (lease.checkpoint?.sequence ?? 0) + 1 },
    company: 'Synthetic Employer', role: 'Synthetic Engineer',
    questions: values.map(q => ({ ...q, scope: { ...q.scope, ats: lease.ats, tenant: lease.tenant } })),
  };
  const result = await registerQuestionBatch(db, f.token, f.app.id, input, options);
  return { result, input, lease, id: result.questionIds[0] };
}
async function answerInput(id: string, answer: AnswerValue = { type: 'boolean', value: true }): Promise<AnswerCommand> {
  const q = await getQuestion(db, 'alice', id, options);
  return { ...request(), expectedRevision: q.revision, expectedProfileRevision: q.expectedProfileRevision,
    expectedPolicyRevision: q.expectedPolicyRevision, expectedScopeHash: q.expectedScopeHash, factVersions: q.factVersions,
    reuse: 'application', answer };
}
async function editProfile(referenced: boolean) {
  vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
  const next = structuredClone(profile);
  if (referenced) next.availability.hoursDuringClasses = { ...next.availability.hoursDuringClasses,
    state: 'confirmed', value: 20, confirmedAt: new Date(now).toISOString() };
  else next.identity.preferredName = { ...next.identity.preferredName,
    state: 'confirmed', value: 'Updated synthetic name', confirmedAt: new Date(now).toISOString() };
  return saveProfile(db, 'alice', { ...request(), expectedRevision: 1, profile: next });
}
async function setProfile(next: Profile) {
  const revision = (await db.select().from(profileHeads))[0].revision + 1;
  await db.insert(profileVersions).values({ ownerId: 'alice', revision, profile: next,
    ...request(), requestHash: hashValue(next), createdAt: now });
  await db.update(profileHeads).set({ revision }).where(eq(profileHeads.ownerId, 'alice'));
}
async function setPolicy(changes: Partial<Policy>) {
  const [head] = await db.select().from(policyHeads).where(eq(policyHeads.ownerId, 'alice'));
  const old = (await db.select().from(policyVersions).where(eq(policyVersions.ownerId, 'alice')))
    .find(row => row.version === head.policyVersion)!;
  const policy = { ...PolicySchema.parse(old.policy), ...changes }, hash = hashValue(policy), version = head.policyVersion + 1;
  await db.insert(policyVersions).values({ ownerId: 'alice', version, hash, policy, createdAt: now });
  await db.update(policyHeads).set({ revision: head.revision + 1, policyVersion: version,
    acceptedPolicyVersion: version, acceptedPolicyHash: hash }).where(eq(policyHeads.ownerId, 'alice'));
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase5-dal-'));
  now = Date.UTC(2026, 8, 21, 12);
  options = { now: () => now };
  stubHousehold();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden'); }));
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` }); await migratePrivateDb(db);
  other = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  for (const id of ['alice', 'bob']) {
    await db.insert(user).values({ id, name: 'Synthetic', email: `${id}@example.test`, emailVerified: true });
    const policy: Policy = { ...createEmptyPolicy(), actions: ['read_jobs', 'fill_forms'], documentKinds: ['resume', 'transcript'] };
    const hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: id, version: 1, hash, policy, createdAt: now });
    await db.insert(policyHeads).values({ ownerId: id, revision: 1, policyVersion: 1, enabled: true,
      acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
  }
  profile = createEmptyProfile();
  await db.insert(profileVersions).values({ ownerId: 'alice', revision: 1, profile,
    ...request(), requestHash: hashValue(profile), createdAt: now });
  await db.insert(profileHeads).values({ ownerId: 'alice', revision: 1 });
});
afterEach(() => {
  other?.$client.close(); db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('question DAL atomic answers, one application each', () => {
  it('stores a missing screening fact for its applicant and resumes only its application once', async () => {
    const a = await prepared(), b = await prepared();
    const context = { applicationId: a.app.id, profileRevision: 1, company: 'Synthetic Employer', role: 'Intern',
      identity: { ats: 'fixture', tenant: 'employer', requisition: a.app.requisition },
      requirements: { sourceUrl: 'https://example.test/role', excerpts: ['Graduating December 2028'] } };
    const generated = screeningQuestions(context as never, ['graduation_unknown']);
    const first = await batch(a, generated.questions);
    expect((await getInboxStatus(db, 'alice', options)).unresolved).toBe(1);
    expect((await getInbox(db, 'alice', {}, options)).items[0].question?.id).toBe(first.id);
    await expect(getQuestion(db, 'bob', first.id, options)).rejects.toMatchObject({ status: 404 });
    const answer = await answerQuestion(db, 'alice', first.id, await answerInput(first.id, { type: 'text', value: '2028-12' }), options);
    expect(answer.resumedApplicationIds).toEqual([a.app.id]);
    expect((await appRow(b.app.id)).state).toBe('queued');
    expect((await db.select().from(questionAnswers)).length).toBe(1);
  });
  it('saves a whole form in one request, or none of it when one answer is rejected', async () => {
    const a = await prepared(), form = await batch(a, [descriptor(), descriptor({ key: 'other', meaning: { id: 'other', reviewId: null },
      originalWording: 'Do you have another restriction?' })]);
    const [first, second] = form.result.questionIds;
    const stale = { ...await answerInput(second), expectedRevision: 99 };
    await expect(answerQuestions(db, 'alice', { answers: [
      { questionId: first, command: await answerInput(first) }, { questionId: second, command: stale },
    ] }, options)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(questionAnswers)).toHaveLength(0);
    expect((await qRow(first)).resolvedAt).toBeNull();
    const saved = await answerQuestions(db, 'alice', { answers: [
      { questionId: first, command: await answerInput(first) }, { questionId: second, command: await answerInput(second) },
    ] }, options);
    expect(saved.results.map(result => result.questionId)).toEqual([first, second]);
    expect(saved.results[1].resumedApplicationIds).toEqual([a.app.id]);
    expect(await appRow(a.app.id)).toMatchObject({ state: 'screening' });
  });
  it('keeps each answer with its own application, waits for every blocker, and replays after reopening', async () => {
    const a = await prepared(), first = await batch(a);
    const b = await prepared(), second = await batch(b, [descriptor(), descriptor({ key: 'other', meaning: { id: 'other', reviewId: null },
      originalWording: 'Do you have another restriction?' })]);
    const foreign = await prepared('bob'), bob = await batch(foreign);
    expect(await getQuestion(db, 'alice', first.id, options)).toMatchObject({ allowedReuse: ['application'], waitingCount: 1 });
    const input = await answerInput(first.id, { type: 'boolean', value: true });
    const result = await answerQuestion(db, 'alice', first.id, input, options);
    // The same wording on another application is that application's own question.
    expect(result.resolvedQuestionIds).toEqual([first.id]);
    expect(result.resumedApplicationIds).toEqual([a.app.id]);
    expect(await appRow(a.app.id)).toMatchObject({ state: 'screening', leaseUntil: null, checkpoint: { stage: 'screening', sequence: 2 } });
    expect((await qRow(second.id)).resolvedAt).toBeNull();
    expect((await qRow(bob.id)).resolvedAt).toBeNull();
    await answerQuestion(db, 'alice', second.id, await answerInput(second.id), options);
    expect(await appRow(b.app.id)).toMatchObject({ state: 'needs_answer' });
    const remaining = second.result.questionIds[1];
    const last = await answerQuestion(db, 'alice', remaining, await answerInput(remaining), options);
    expect(last.resumedApplicationIds).toEqual([b.app.id]);
    const count = (await db.select().from(questionAnswers)).length;
    db.$client.close(); db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    expect(await answerQuestion(db, 'alice', first.id, input, options)).toEqual({ ...result, replayed: true });
    expect(await db.select().from(questionAnswers)).toHaveLength(count);
    await expect(answerQuestion(db, 'alice', first.id, { ...input, answer: { type: 'boolean', value: false } }, options))
      .rejects.toMatchObject({ status: 409 });
    // A later application asking the same question asks the applicant again.
    const future = await prepared('alice', 'another-employer'), matching = await batch(future);
    expect(await qRow(matching.id)).toMatchObject({ answerId: null, resolvedAt: null });
    expect(await appRow(future.app.id)).toMatchObject({ state: 'needs_answer' });
  });


  it("a retried role reuses the answers given to its earlier attempt instead of asking again", async () => {
    const scoped = (applicationId: string) => descriptor({ key: 'onsite', originalWording: 'Can you work on site?',
      meaning: { id: 'onsite', reviewId: null }, scope: { ...descriptor().scope, kind: 'application', applicationId } });
    const a = await prepared(), first = await batch(a, [scoped(a.app.id)]);
    const answered = await answerQuestion(db, 'alice', first.id, await answerInput(first.id), options);
    await db.update(applications).set({ state: 'cancelled', reasonCode: 'restarted', leaseUntil: null, leaseCheckedAt: null })
      .where(eq(applications.id, a.app.id));
    // Discovery owns real successors; the synthetic fixture has no snapshot for the guard to check.
    await db.run(sql`drop trigger private_application_successor_guard`);
    const retryId = randomUUID(), previous = await appRow(a.app.id);
    await db.insert(applications).values({ id: retryId, ownerId: 'alice', runId: previous.runId, workerId: previous.workerId,
      ats: previous.ats, tenant: previous.tenant, requisition: previous.requisition, attempt: 2, previousApplicationId: previous.id,
      availableAt: now, createdAt: now });
    const retry = await batch({ ...a, app: { ...a.app, id: retryId } }, [scoped(retryId)]);
    expect(await qRow(retry.id)).toMatchObject({ answerId: answered.answerId });
    expect((await qRow(retry.id)).resolvedAt).not.toBeNull();
    expect(await appRow(retryId)).toMatchObject({ state: 'screening', reasonCode: null });
  });
  it('a form question worded like one answered on another application takes that answer; essays and long text are asked again', async () => {
    const choice: QuestionField = { type: 'select', allowBlank: false, declineValue: null, units: null, precision: null,
      options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }], minSelections: 1, maxSelections: 1 };
    const textField: QuestionField = { type: 'text', allowBlank: false, declineValue: null, units: null, precision: null, minLength: 1, maxLength: 4000, format: 'plain' };
    await setPolicy({ actions: ['read_jobs', 'fill_forms'], disclosure: 'confirmed_only' });
    const form = (applicationId: string, key: string, originalWording: string, f: QuestionField) => descriptor({ key, originalWording,
      meaning: { id: key, reviewId: null }, field: f, sensitive: true, scope: { ...descriptor().scope, kind: 'application', applicationId } });
    const a = await prepared(), first = await batch(a, [
      form(a.app.id, `form-${'a'.repeat(32)}`, 'Are you 18 years of age or older?', choice),
      form(a.app.id, `form-${'b'.repeat(32)}`, 'Which US state do you reside in?', textField),
      form(a.app.id, `form-${'c'.repeat(32)}`, 'What is the most impressive thing you have built?', textField),
      form(a.app.id, `form-${'d'.repeat(32)}`, 'Why this team?', { ...textField, type: 'textarea' }),
      form(a.app.id, `form-${'e'.repeat(32)}`, 'Have you worked for us before?', choice),
    ]);
    const [adult, state, impressive, why, before] = first.result.questionIds;
    await answerQuestions(db, 'alice', { answers: [
      { questionId: adult, command: await answerInput(adult, { type: 'choice', value: 'Yes' }) },
      { questionId: state, command: await answerInput(state, { type: 'text', value: 'California' }) },
      { questionId: impressive, command: await answerInput(impressive, { type: 'text', value: 'x'.repeat(61) }) },
      { questionId: why, command: await answerInput(why, { type: 'text', value: 'Short.' }) },
      { questionId: before, command: await answerInput(before, { type: 'choice', value: 'No' }) },
    ] }, options);
    // Another employer's form: its own field keys, the same wording (case, spacing and the trailing "*" do not matter).
    const b = await prepared('alice', 'another-employer'), second = await batch(b, [
      form(b.app.id, `form-${'1'.repeat(32)}`, 'Are you 18 years of age  or older? *', choice),
      form(b.app.id, `form-${'2'.repeat(32)}`, 'which US state do you reside in?', textField),
    ]);
    const [adult2, state2] = second.result.questionIds;
    expect(await qRow(adult2)).toMatchObject({ answerId: (await qRow(adult)).answerId });
    expect(await qRow(state2)).toMatchObject({ answerId: (await qRow(state)).answerId });
    expect(await appRow(b.app.id)).toMatchObject({ state: 'screening', reasonCode: null });
    expect(await getInboxStatus(db, 'alice', options)).toMatchObject({ unresolved: 0 });
    // Long text and a textarea answer are asked again, and so is a choice the new form does not offer.
    const c = await prepared('alice', 'third-employer'), third = await batch(c, [
      form(c.app.id, `form-${'3'.repeat(32)}`, 'What is the most impressive thing you have built?', textField),
      form(c.app.id, `form-${'4'.repeat(32)}`, 'Why this team?', { ...textField, type: 'textarea' }),
      form(c.app.id, `form-${'5'.repeat(32)}`, 'Are you 18 years of age or older?', { ...choice, options: [{ value: 'Y', label: 'Y' }, { value: 'N', label: 'N' }] }),
      // True of one employer, not the next.
      form(c.app.id, `form-${'6'.repeat(32)}`, 'Have you worked for us before?', choice),
    ]);
    for (const id of third.result.questionIds) expect(await qRow(id)).toMatchObject({ answerId: null, resolvedAt: null });
    expect(await appRow(c.app.id)).toMatchObject({ state: 'needs_answer' });
    // A policy that asks before each sensitive answer gets each form's question asked.
    await setPolicy({ actions: ['read_jobs', 'fill_forms'], disclosure: 'ask_each_sensitive' });
    const d = await prepared('alice', 'fourth-employer'), fourth = await batch(d, [
      form(d.app.id, `form-${'7'.repeat(32)}`, 'Are you 18 years of age or older?', choice)]);
    expect(await qRow(fourth.id)).toMatchObject({ answerId: null, resolvedAt: null });
  });
  it('refuses saving an answer for other applications', async () => {
    const a = await prepared(), first = await batch(a);
    const input = await answerInput(first.id);
    for (const reuse of ['employer', 'equivalent'])
      await expect(answerQuestion(db, 'alice', first.id, { ...input, reuse } as never, options)).rejects.toBeDefined();
    expect(await db.select().from(questionAnswers)).toHaveLength(0);
    // A worker cannot claim a reviewed meaning either.
    const b = await prepared(), lease = (await pollWorker(db, b.token, { protocolVersion: 1 }, options)).lease!;
    await expect(registerQuestionBatch(db, b.token, b.app.id, { ...first.input, eventId: randomUUID(),
      expectedRevision: lease.revision, fence: lease.fence,
      questions: [descriptor({ meaning: { id: 'stated-hours', reviewId: randomUUID() } })],
    }, options)).rejects.toMatchObject({ status: 409 });
  });


  it.each(['submitting', 'submission_unknown', 'submitted', 'failed', 'skipped', 'cancelled'] as const)(
    'an explicit newer answer fences unsent work while preserving %s history', async state => {
      const a = await prepared(), first = await batch(a), b = await prepared(), second = await batch(b);
      const original = await answerQuestion(db, 'alice', first.id,
        await answerInput(first.id, { type: 'boolean', value: true }), options);
      const lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
      await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 8 } }).where(eq(applications.id, a.app.id));
      await db.update(applications).set({ state }).where(eq(applications.id, b.app.id));
      const beforeApp = await appRow(b.app.id), beforeQuestion = await qRow(second.id);
      expect((await getQuestion(db, 'alice', second.id, options)).canAnswer).toBe(false);
      await expect(answerQuestion(db, 'alice', second.id, await answerInput(second.id), options)).rejects.toMatchObject({ status: 409 });
      const updated = await answerQuestion(db, 'alice', first.id,
        await answerInput(first.id, { type: 'boolean', value: false }), options);
      expect(updated.answerId).not.toBe(original.answerId);
      expect(updated.resolvedQuestionIds).toEqual([first.id]);
      expect(await appRow(a.app.id)).toMatchObject({ state: 'screening', leaseUntil: null, checkpoint: { stage: 'screening', sequence: 9 } });
      expect((await appRow(a.app.id)).fence).toBeGreaterThan(lease.fence);
      await expect(heartbeatWorker(db, a.token, { protocolVersion: 1, lease: {
        applicationId: a.app.id, expectedRevision: lease.revision, fence: lease.fence,
      } }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(await appRow(b.app.id)).toEqual(beforeApp); expect(await qRow(second.id)).toEqual(beforeQuestion);
      expect((await db.select().from(questionAnswers).where(eq(questionAnswers.id, original.answerId)))[0].value)
        .toEqual({ type: 'boolean', value: true });
      const future = await prepared('alice', 'future'), later = await batch(future);
      expect((await qRow(later.id)).answerId).toBeNull();
      await expect(db.update(questionAnswers).set({ value: { type: 'boolean', value: false } })).rejects.toThrow();
      await expect(db.delete(questionAnswers)).rejects.toThrow();
    });

  it.each(['policy', 'profile', 'fact', 'scope', 'revision', 'fact-list', 'owner', 'stop', 'pause', 'revoke', 'credential', 'manual'] as const)(
    'rejects stale or ineligible %s without writing an answer or scheduling work', async cause => {
      const fact = profile.availability.hoursDuringClasses;
      const a = await prepared(), q = await batch(a, [descriptor({ factIds: [fact.id] })]);
      const input = await answerInput(q.id);
      if (cause === 'policy') await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
      if (cause === 'profile' || cause === 'fact') {
        const next = structuredClone(profile); if (cause === 'fact') next.availability.hoursDuringClasses.version++;
        await setProfile(next);
      }
      if (cause === 'scope') input.expectedScopeHash = '0'.repeat(64);
      if (cause === 'revision') input.expectedRevision++;
      if (cause === 'fact-list') input.factVersions = [];
      if (cause === 'stop' || cause === 'pause') await commandRun(db, 'alice', a.run.id,
        { ...request(), expectedRevision: 1, action: cause }, options);
      if (cause === 'revoke') await revokeWorker(db, 'alice', a.worker.workerId, { ...request(), expectedRevision: 1 }, options);
      if (cause === 'credential') vi.stubEnv('WORKIE_HOUSEHOLD_PASSCODE', '1357');
      if (cause === 'manual') {
        const previewId = randomUUID(), evidence = { postingId: 1, company: 'Synthetic', title: 'Engineer', url: null,
          identity: { ats: 'fixture', tenant: a.app.tenant, requisition: a.app.requisition }, resolution: 'resolved' as const, reason: null };
        await db.insert(legacyImportPreviews).values({ id: previewId, ownerId: 'alice', ...request(), requestHash: '0'.repeat(64),
          preview: { ownerId: 'alice', previewToken: previewId, previewHash: '0'.repeat(64), expiresAt: now + 1000, rows: [evidence] },
          createdAt: now, expiresAt: now + 1000 });
        await db.insert(manualApplicationMarks).values({ id: randomUUID(), ownerId: 'alice', postingId: 1, previewId, evidence,
          ats: 'fixture', tenant: a.app.tenant, requisition: a.app.requisition, createdAt: now });
      }
      const before = await appRow(a.app.id);
      await expect(answerQuestion(db, cause === 'owner' ? 'bob' : 'alice', q.id, input, options)).rejects.toBeDefined();
      expect(await db.select().from(questionAnswers)).toEqual([]);
      expect(await appRow(a.app.id)).toEqual(before);
      if (!['scope', 'revision', 'fact-list', 'owner', 'profile', 'fact'].includes(cause))
        expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(false);
    });


  it('serializes competing answers, rolls back failed resume and retains one row per field', async () => {
    const a = await prepared(), q = await batch(a), input = await answerInput(q.id);
    await db.run(sql`create trigger fixture_fail_resume before update on private_application begin select raise(ignore); end`);
    await expect(answerQuestion(db, 'alice', q.id, input, options)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(questionAnswers)).toHaveLength(0); expect((await qRow(q.id)).resolvedAt).toBeNull();
    await db.run(sql`drop trigger fixture_fail_resume`);
    const responses = await Promise.all([answerQuestion(db, 'alice', q.id, input, options), answerQuestion(other, 'alice', q.id, input, options)]);
    expect(responses[0].answerId).toBe(responses[1].answerId);
    expect(await db.select().from(questionAnswers)).toHaveLength(1);
    expect(await registerQuestionBatch(db, a.token, a.app.id, q.input, options)).toEqual({ ...q.result, replayed: true });
    await expect(registerQuestionBatch(db, a.token, a.app.id, { ...q.input, role: 'Different' }, options)).rejects.toMatchObject({ status: 409 });
    const reobserved = await batch(a, [descriptor({ field: { type: 'select', allowBlank: false, declineValue: null, units: null,
      precision: null, options: [{ value: 'yes', label: 'Yes' }], minSelections: 1, maxSelections: 1 } })]);
    expect(reobserved.id).toBe(q.id);
    expect(await db.select().from(questions)).toHaveLength(1);
    expect((await qRow(q.id)).resolvedAt).toBeNull();
    await expect(answerQuestion(db, 'alice', q.id, { ...input, ...request() }, options)).rejects.toMatchObject({ status: 409 });
  });



  it.each(['lease', 'profile', 'scope', 'fact', 'checkpoint', 'owner'] as const)(
    'rejects invalid %s registration with no question or notification', async change => {
      const a = await prepared(), lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
      const input: QuestionBatch = { questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: lease.revision,
        fence: lease.fence, expectedProfileRevision: 1, checkpoint: { stage: 'screening', sequence: 1 },
        company: 'Synthetic', role: 'Engineer', questions: [descriptor()] };
      if (change === 'lease') input.fence++;
      if (change === 'profile') input.expectedProfileRevision++;
      if (change === 'scope') input.questions[0].scope.tenant = 'unrelated';
      if (change === 'fact') input.questions[0].factIds = [randomUUID()];
      if (change === 'checkpoint') input.checkpoint.sequence++;
      const b = change === 'owner' ? await prepared('bob') : null;
      await expect(registerQuestionBatch(db, b?.token ?? a.token, a.app.id, input, options)).rejects.toBeDefined();
      expect(await db.select().from(questions)).toHaveLength(0);
      expect(await db.select().from(applicationEvents)).toHaveLength(0);
    });

  it.each([false, true])('cannot clear an independent worker blocker by updating an old answer (pause/resume: %s)', async pause => {
    const a = await prepared(), q = await batch(a);
    await answerQuestion(db, 'alice', q.id, await answerInput(q.id), options);
    const lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
    await recordWorkerEvent(db, a.token, a.app.id, { protocolVersion: 1, eventId: randomUUID(), expectedRevision: lease.revision,
      fence: lease.fence, state: 'needs_verification', reasonCode: 'separate_verification',
      checkpoint: { stage: 'screening', sequence: lease.checkpoint!.sequence + 1 } }, options);
    if (pause) {
      await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 1, action: 'pause' }, options);
      await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 2, action: 'resume' }, options);
    }
    const before = await appRow(a.app.id);
    expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(false);
    await expect(answerQuestion(db, 'alice', q.id, await answerInput(q.id, { type: 'boolean', value: false }), options))
      .rejects.toMatchObject({ status: 409 });
    expect(await appRow(a.app.id)).toEqual(before);
    expect(await db.select().from(questionAnswers)).toHaveLength(1);
  });

  it('still answers an original question blocker after an authorized run pause and resume', async () => {
    const a = await prepared(), q = await batch(a);
    await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 1, action: 'pause' }, options);
    await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 2, action: 'resume' }, options);
    expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(true);
    expect((await answerQuestion(db, 'alice', q.id, await answerInput(q.id), options)).resumedApplicationIds).toEqual([a.app.id]);
  });

  it.each([true, false])('recovers a waiting question after a real profile save (referenced: %s)', async referenced => {
    const a = await prepared(), q = await batch(a, [descriptor({ factIds: [profile.availability.hoursDuringClasses.id] })]);
    const staleAnswer = await answerInput(q.id);
    await editProfile(referenced);
    await expect(answerQuestion(db, 'alice', q.id, staleAnswer, options)).rejects.toMatchObject({ status: 409 });
    const current = await getQuestion(db, 'alice', q.id, options);
    expect(current).toMatchObject({ canAnswer: true, expectedProfileRevision: 2,
      factVersions: [{ id: profile.availability.hoursDuringClasses.id, version: referenced ? 2 : 1 }] });
    expect(await appRow(a.app.id)).toMatchObject({ state: 'needs_answer', leaseUntil: null });
    const result = await answerQuestion(db, 'alice', q.id, await answerInput(q.id), options);
    expect(result.resumedApplicationIds).toEqual([a.app.id]);
    expect(await qRow(q.id)).toMatchObject({ profileRevision: 2, factVersions: current.factVersions });
  });

  it('an unrelated profile save neither reopens answered form questions nor strands the application', async () => {
    const form = (label: string, key = 'question_1') => ({ key, label, kind: 'text' as const, required: true });
    const contextFor = (f: Fixture) => ({ applicationId: f.app.id, profileRevision: 1, company: 'Synthetic Employer', role: 'Intern',
      applicationUrl: 'https://example.test/apply', identity: { ats: 'fixture', tenant: 'employer', requisition: f.app.requisition } }) as never;
    const a = await prepared(), asked = formQuestions(contextFor(a), [form('How did you hear about us?')]).questions;
    const first = await batch(a, asked);
    await answerQuestion(db, 'alice', first.id, await answerInput(first.id, { type: 'text', value: 'LinkedIn' }), options);
    const b = await prepared('alice', 'second');
    const pair = await batch(b, formQuestions(contextFor(b), [form('Why us?'), form('Why this role?', 'question_2')]).questions);
    await answerQuestion(db, 'alice', pair.id, await answerInput(pair.id, { type: 'text', value: 'Mission' }), options);
    await editProfile(false);
    // The save leaves the stored answer in place for the worker to use.
    expect((await qRow(first.id)).resolvedAt).not.toBeNull();
    expect(await appRow(a.app.id)).toMatchObject({ state: 'screening' });
    // Answering the last open question resumes the application even though its earlier answer predates the save.
    const last = pair.result.questionIds[1];
    const resumed = await answerQuestion(db, 'alice', last, await answerInput(last, { type: 'text', value: 'Scope' }), options);
    expect(resumed.resumedApplicationIds).toEqual([b.app.id]);
    expect((await getInboxStatus(db, 'alice', options)).unresolved).toBe(0);
  });

  it('a question the worker asks again after its answer failed on the form reopens instead of looping', async () => {
    const college = { key: 'question_1', label: 'Which college or university do you currently attend?', kind: 'combobox' as const, required: true };
    const contextFor = (f: Fixture) => ({ applicationId: f.app.id, profileRevision: 1, company: 'Synthetic Employer', role: 'Intern',
      applicationUrl: 'https://example.test/apply', identity: { ats: 'fixture', tenant: 'employer', requisition: f.app.requisition } }) as never;
    const a = await prepared(), asked = formQuestions(contextFor(a), [college]).questions;
    const first = await batch(a, asked);
    await answerQuestion(db, 'alice', first.id, await answerInput(first.id, { type: 'text', value: 'UCLA' }), options);
    expect(await appRow(a.app.id)).toMatchObject({ state: 'screening' });
    // "UCLA" is not one of the form's options, so the worker asks the same question again.
    await batch(a, asked);
    expect(await appRow(a.app.id)).toMatchObject({ state: 'needs_answer' }); // not screening again, which looped
    expect((await qRow(first.id)).resolvedAt).toBeNull();
    expect((await getInboxStatus(db, 'alice', options)).unresolved).toBe(1);
    // When the worker saw the dropdown's choices, the question lists them so the next answer is an exact one.
    const choices = formQuestions(contextFor(a), [{ ...college, options: ['University of California, Los Angeles', 'Other'] }]).questions;
    expect(choices[0].field).toMatchObject({ type: 'select', minSelections: 1, maxSelections: 1,
      options: [{ value: 'University of California, Los Angeles', label: 'University of California, Los Angeles' }, { value: 'Other', label: 'Other' }] });
  });

  it('a revised answer fences active work without touching another application or rewriting submitted answers', async () => {
    const descriptorWithFact = descriptor({ factIds: [profile.availability.hoursDuringClasses.id] });
    const a = await prepared(), first = await batch(a, [descriptorWithFact]);
    const b = await prepared(), second = await batch(b, [descriptorWithFact]);
    const original = await answerQuestion(db, 'alice', first.id, await answerInput(first.id, { type: 'boolean', value: true }), options);
    await db.update(applications).set({ state: 'submitted' }).where(eq(applications.id, b.app.id));
    const historical = await qRow(second.id), oldAnswer = (await db.select().from(questionAnswers))[0];
    const lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
    await editProfile(true);
    const c = await prepared('alice', 'new'), third = await batch(c, [descriptorWithFact]);
    const revised = await answerQuestion(db, 'alice', first.id, await answerInput(first.id, { type: 'boolean', value: false }), options);
    expect(revised.answerId).not.toBe(original.answerId);
    expect(revised.resolvedQuestionIds).toEqual([first.id]);
    expect((await qRow(third.id)).resolvedAt).toBeNull();
    expect(await appRow(a.app.id)).toMatchObject({ state: 'screening', leaseUntil: null });
    expect((await appRow(a.app.id)).fence).toBeGreaterThan(lease.fence);
    expect(await qRow(second.id)).toEqual(historical);
    expect((await db.select().from(questionAnswers).where(eq(questionAnswers.id, original.answerId)))[0]).toEqual(oldAnswer);
  });

  it('asks again under a newly enabled policy: a row waiting on answers goes back to screening and its new questions can be answered', async () => {
    vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
    const confirmedAt = new Date(now).toISOString(), applicant = structuredClone(profile);
    for (const [key, value] of [['legalFirstName', 'Synthetic'], ['legalLastName', 'Applicant'], ['personalEmail', 'alice@example.test']] as const) {
      Object.assign(applicant.identity[key], { value, state: 'confirmed', confirmedAt });
    }
    await setProfile(applicant);
    await setPolicy({ destinations: ['boards.greenhouse.io'], countries: ['US'] });
    const f = await prepared();
    const optional = descriptor({ key: 'note', originalWording: 'Anything else?', meaning: { id: 'note', reviewId: null },
      required: false, field: { ...field, allowBlank: true } });
    const first = await batch(f, [descriptor(), optional]);
    expect(await appRow(f.app.id)).toMatchObject({ state: 'needs_answer', reasonCode: 'question_unresolved' });
    // Profile's save turns the policy off and Enable turns it on: two new policy revisions.
    const [bound] = await db.select().from(policyVersions).where(and(eq(policyVersions.ownerId, 'alice'), eq(policyVersions.version, 2)));
    const saved = await mutatePolicy(db, 'alice', { ...request(), expectedRevision: 2,
      policy: { ...PolicySchema.parse(bound.policy), documentKinds: ['resume'] } });
    await mutatePolicy(db, 'alice', { ...request(), expectedRevision: saved.revision, action: 'enable', acceptedPolicyHash: saved.policyHash! });
    expect(await appRow(f.app.id)).toMatchObject({ state: 'screening', reasonCode: 'policy_changed', leaseUntil: null });
    // The open question closes; the optional one left blank, which the new policy still allows, stays answered.
    expect((await qRow(first.id)).active).toBe(false);
    expect(await qRow(first.result.questionIds[1])).toMatchObject({ active: true, policyRevision: 4 });
    // The worker screens again and asks only what it still needs; nothing from the old policy blocks the row.
    const again = await batch(f);
    expect(again.id).toBe(first.id);
    expect((await getQuestion(db, 'alice', again.id, options)).canAnswer).toBe(true);
    const answer = await answerQuestion(db, 'alice', again.id, await answerInput(again.id), options);
    expect(answer.resumedApplicationIds).toEqual([f.app.id]);
    expect(await appRow(f.app.id)).toMatchObject({ state: 'screening', reasonCode: null });
  });

  it('keeps the answers a newly enabled policy still allows, so Apply submits the form the applicant reviewed', async () => {
    vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
    const confirmedAt = new Date(now).toISOString(), applicant = structuredClone(profile);
    for (const [key, value] of [['legalFirstName', 'Synthetic'], ['legalLastName', 'Applicant'], ['personalEmail', 'alice@example.test']] as const) {
      Object.assign(applicant.identity[key], { value, state: 'confirmed', confirmedAt });
    }
    await setProfile(applicant);
    await setPolicy({ destinations: ['boards.greenhouse.io'], countries: ['US'], actions: ['read_jobs', 'fill_forms', 'submit'] });
    const change = async (changes: Partial<Policy>) => {
      const [head] = await db.select().from(policyHeads).where(eq(policyHeads.ownerId, 'alice'));
      const [bound] = await db.select().from(policyVersions).where(and(eq(policyVersions.ownerId, 'alice'), eq(policyVersions.version, head.policyVersion)));
      const saved = await mutatePolicy(db, 'alice', { ...request(), expectedRevision: head.revision, policy: { ...PolicySchema.parse(bound.policy), ...changes } });
      await mutatePolicy(db, 'alice', { ...request(), expectedRevision: saved.revision, action: 'enable', acceptedPolicyHash: saved.policyHash! });
    };
    const f = await prepared();
    // A sensitive optional question is left blank on its own under confirmed_only disclosure.
    const sensitive = descriptor({ key: 'note', originalWording: 'Anything else?', meaning: { id: 'note', reviewId: null },
      required: false, sensitive: true, field: { ...field, allowBlank: true } });
    const first = await batch(f, [descriptor(), sensitive]);
    const answer = await answerQuestion(db, 'alice', first.id, await answerInput(first.id), options);
    // The worker fills the form with that answer and parks it for approval.
    const lease = (await pollWorker(db, f.token, { protocolVersion: 1 }, options)).lease!;
    await recordWorkerEvent(db, f.token, f.app.id, { protocolVersion: 1, eventId: randomUUID(), fence: lease.fence,
      expectedRevision: lease.revision, state: 'needs_policy_decision', reasonCode: 'submit_approval',
      checkpoint: { stage: 'screening', sequence: (lease.checkpoint?.sequence ?? 0) + 1 } }, options);
    await change({ dailyApplicationCap: 5 });
    const parked = await appRow(f.app.id);
    expect(parked).toMatchObject({ state: 'needs_policy_decision', reasonCode: 'submit_approval' });
    await commandApplication(db, 'alice', f.run.id, f.app.id, { ...request(), expectedRevision: parked.revision, action: 'approve-submit' }, options);
    const submit = (await pollWorker(db, f.token, { protocolVersion: 1 }, options)).lease!;
    expect(submit).toMatchObject({ applicationId: f.app.id, state: 'ready' });
    // The application context passes the worker each active answer bound to the lease's policy revision.
    expect(await qRow(first.id)).toMatchObject({ active: true, answerId: answer.answerId, policyRevision: submit.policyRevision });
    // A policy that asks about each sensitive question cannot keep the one left blank: the form is filled and reviewed again.
    await change({ disclosure: 'ask_each_sensitive' });
    expect(await appRow(f.app.id)).toMatchObject({ state: 'screening', reasonCode: 'policy_changed', leaseUntil: null });
    expect(await qRow(first.result.questionIds[1])).toMatchObject({ active: false });
    expect(await qRow(first.id)).toMatchObject({ active: true, answerId: answer.answerId });
  });

  it('sends an approved form back to be filled and reviewed when the newly enabled policy changes what fills or screens it', async () => {
    vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
    const confirmedAt = new Date(now).toISOString(), applicant = structuredClone(profile);
    for (const [key, value] of [['legalFirstName', 'Synthetic'], ['legalLastName', 'Applicant'], ['personalEmail', 'alice@example.test']] as const) {
      Object.assign(applicant.identity[key], { value, state: 'confirmed', confirmedAt });
    }
    await setProfile(applicant);
    await setPolicy({ destinations: ['boards.greenhouse.io'], countries: ['US'], actions: ['read_jobs', 'tailor_documents', 'fill_forms', 'submit'],
      documentKinds: ['resume', 'cover_letter'] });
    const change = async (changes: Partial<Policy>) => {
      const [head] = await db.select().from(policyHeads).where(eq(policyHeads.ownerId, 'alice'));
      const [bound] = await db.select().from(policyVersions).where(and(eq(policyVersions.ownerId, 'alice'), eq(policyVersions.version, head.policyVersion)));
      const saved = await mutatePolicy(db, 'alice', { ...request(), expectedRevision: head.revision, policy: { ...PolicySchema.parse(bound.policy), ...changes } });
      await mutatePolicy(db, 'alice', { ...request(), expectedRevision: saved.revision, action: 'enable', acceptedPolicyHash: saved.policyHash! });
    };
    const f = await prepared();
    const lease = (await pollWorker(db, f.token, { protocolVersion: 1 }, options)).lease!;
    await recordWorkerEvent(db, f.token, f.app.id, { protocolVersion: 1, eventId: randomUUID(), fence: lease.fence,
      expectedRevision: lease.revision, state: 'needs_policy_decision', reasonCode: 'submit_approval',
      checkpoint: { stage: 'screening', sequence: (lease.checkpoint?.sequence ?? 0) + 1 } }, options);
    const parked = await appRow(f.app.id);
    await commandApplication(db, 'alice', f.run.id, f.app.id, { ...request(), expectedRevision: parked.revision, action: 'approve-submit' }, options);
    // Pacing changes leave the reviewed form as it is: the approval stands.
    await change({ dailyApplicationCap: 5 });
    expect(await appRow(f.app.id)).toMatchObject({ state: 'ready' });
    // Dropping the cover letter changes what the refill at submit would send, so the approval cannot cover it.
    await change({ documentKinds: ['resume'] });
    expect(await appRow(f.app.id)).toMatchObject({ state: 'screening', reasonCode: 'policy_changed', leaseUntil: null });
    // So does a change to who is eligible, for a form waiting for its approval.
    const g = await appRow(f.app.id);
    const again = (await pollWorker(db, f.token, { protocolVersion: 1 }, options)).lease!;
    expect(again).toMatchObject({ applicationId: g.id });
    await recordWorkerEvent(db, f.token, f.app.id, { protocolVersion: 1, eventId: randomUUID(), fence: again.fence,
      expectedRevision: again.revision, state: 'needs_policy_decision', reasonCode: 'submit_approval',
      checkpoint: { stage: 'screening', sequence: (again.checkpoint?.sequence ?? 0) + 1 } }, options);
    await change({ degreeEligibility: ['Bachelor of Science'] });
    expect(await appRow(f.app.id)).toMatchObject({ state: 'screening', reasonCode: 'policy_changed' });
  });
});

describe('typed validation, optional questions and inbox receipts', () => {
  it.each(['needs_login', 'needs_verification', 'provider_unavailable', 'failed'] as const)(
    'keeps unresolved %s interventions visible without allowing a typed answer', async kind => {
      const a = await prepared(), q = await batch(a, [descriptor({ kind,
        field: { type: 'intervention', allowBlank: false, declineValue: null, units: null, precision: null } })]);
      expect(await getInboxStatus(db, 'alice', options)).toMatchObject({ unread: 1, unresolved: 1, waitingApplications: 1 });
      expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(false);
      expect((await getInbox(db, 'alice', {}, options)).items[0].kind).toBe(kind);
    });

  it('reads an inbox page in a fixed number of statements, however many questions it holds', async () => {
    // Each statement is a round trip to the hosted database; per-question lookups made the page take seconds.
    const statements = async (count: number) => {
      const a = await prepared('alice', `employer-${count}`);
      await batch(a, Array.from({ length: count }, (_, i) => descriptor({ key: `q${i}`, meaning: { id: `q${i}`, reviewId: null },
        originalWording: `Question ${i}?` })));
      const transaction = db.$client.transaction.bind(db.$client);
      let executed = 0;
      const spy = vi.spyOn(db.$client, 'transaction').mockImplementation((async (mode: TransactionMode) => {
        const tx = await transaction(mode), execute = tx.execute.bind(tx);
        tx.execute = (statement => { executed++; return execute(statement); }) as typeof tx.execute;
        return tx;
      }) as never);
      const page = await getInbox(db, 'alice', {}, options);
      spy.mockRestore();
      expect(page.items.filter(item => item.question?.canAnswer)).toHaveLength(page.items.length);
      return executed;
    };
    // The second page adds 20 questions on one more application: only that application's eligibility check is new.
    const one = await statements(1), many = await statements(20);
    expect(many - one).toBeLessThan(20);
  });

  it("lists one application's notifications when asked", async () => {
    const a = await prepared('alice', 'first'); await batch(a);
    const b = await prepared('alice', 'second'); await batch(b);
    expect((await getInbox(db, 'alice', {}, options)).items).toHaveLength(2);
    const page = await getInbox(db, 'alice', { applicationId: a.app.id }, options);
    expect(page.items.map(item => item.applicationId)).toEqual([a.app.id]);
    expect((await getInbox(db, 'bob', { applicationId: a.app.id }, options)).items).toEqual([]);
  });

  it('keeps reads private, paginates stably and never resolves through read receipts', async () => {
    const a = await prepared(), q = await batch(a, [descriptor(), descriptor({ key: 'second' })]);
    const initial = await getInboxStatus(db, 'alice', options);
    expect(initial).toMatchObject({ unread: 2, unresolved: 2, waitingApplications: 1 });
    const page = await getInbox(db, 'alice', { limit: 1 }, options);
    expect(page.items).toHaveLength(1); expect(page.nextCursor).not.toBeNull();
    const next = await getInbox(db, 'alice', { limit: 1, cursor: page.nextCursor! }, options);
    expect(next.items[0].eventId).not.toBe(page.items[0].eventId);
    expect(await getInboxStatus(db, 'alice', options)).toEqual(initial);
    await expect(markInboxRead(db, 'bob', { eventIds: [page.items[0].eventId] })).rejects.toMatchObject({ status: 404 });
    const command = { eventIds: [page.items[0].eventId] };
    expect(await markInboxRead(db, 'alice', command)).toEqual({ ownerId: 'alice', ...command });
    expect(await markInboxRead(other, 'alice', command)).toEqual({ ownerId: 'alice', ...command });
    expect(await db.select().from(inboxReads)).toHaveLength(1);
    expect(await getInboxStatus(db, 'alice', options)).toMatchObject({ unread: 1, unresolved: 2, waitingApplications: 1 });
    expect((await getQuestion(db, 'alice', q.id, options)).resolved).toBe(false);
    await expect(getQuestion(db, 'bob', q.id, options)).rejects.toMatchObject({ status: 404 });
    expect((await getInbox(db, 'bob', {}, options)).items).toEqual([]);
  });

  it('optional policy-permitted blanks do not block or fabricate a user answer', async () => {
    const a = await prepared(), q = await batch(a, [descriptor({ required: false, field: { ...field, allowBlank: true } })]);
    expect(await qRow(q.id)).toMatchObject({ resolvedAt: now, answerId: null });
    expect(await appRow(a.app.id)).toMatchObject({ state: 'screening', leaseUntil: null });
    expect(await getInboxStatus(db, 'alice', options)).toMatchObject({ unread: 0, unresolved: 0, waitingApplications: 0 });
    expect(await db.select().from(questionAnswers)).toHaveLength(0);
  });

  it('requires fill permission and keeps sensitive answers to their application', async () => {
    await setPolicy({ actions: ['read_jobs'] });
    const a = await prepared(), q = await batch(a);
    expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(false);
    await expect(answerQuestion(db, 'alice', q.id, await answerInput(q.id), options)).rejects.toMatchObject({ status: 409 });
    await setPolicy({ actions: ['read_jobs', 'fill_forms'], disclosure: 'ask_each_sensitive' });
    const b = await prepared(), sensitive = await batch(b, [descriptor({ sensitive: true })]);
    expect((await getQuestion(db, 'alice', sensitive.id, options)).allowedReuse).toEqual(['application']);
    expect((await answerQuestion(db, 'alice', sensitive.id, await answerInput(sensitive.id), options)).resolvedQuestionIds).toEqual([sensitive.id]);
  });

  it('requires owned, available, policy-permitted document version and exact hash', async () => {
    const id = randomUUID(), bad = randomUUID();
    for (const [documentId, ownerId, state] of [[id, 'alice', 'available'], [bad, 'bob', 'available']] as const) {
      await db.insert(documents).values({ id: documentId, masterId: documentId, ownerId, kind: 'transcript', name: 'Synthetic.pdf',
        version: 1, objectKey: documentId, storage: 'local', mime: 'application/pdf', size: 100, sha256: 'a'.repeat(64),
        state, safetyCheck: 'passed', createdAt: now });
    }
    const a = await prepared(), q = await batch(a, [descriptor({ kind: 'needs_document', field: {
      type: 'document', allowBlank: false, declineValue: null, units: null, precision: null,
      documentKinds: ['transcript'], mimeTypes: ['application/pdf'], maxBytes: 1000,
    } })]);
    for (const value of [{ documentId: bad, version: 1, sha256: 'a'.repeat(64) },
      { documentId: id, version: 2, sha256: 'a'.repeat(64) }, { documentId: id, version: 1, sha256: 'b'.repeat(64) }]) {
      await expect(answerQuestion(db, 'alice', q.id, await answerInput(q.id, { type: 'document', ...value }), options)).rejects.toMatchObject({ status: 409 });
    }
    const input = await answerInput(q.id, { type: 'document', documentId: id, version: 1, sha256: 'a'.repeat(64) });
    expect((await answerQuestion(db, 'alice', q.id, input, options)).resumedApplicationIds).toEqual([a.app.id]);
  });

  it('validates actual date, option, units and precision without coercion', () => {
    const date = descriptor({ field: { type: 'date', allowBlank: false, declineValue: null, units: null,
      precision: 'day', min: '2026-01-01', max: '2026-12-31' } });
    for (const value of ['2026-02-30', '2025-12-31', '2027-01-01', '2026-06'])
      expect(validQuestionAnswer(date, { type: 'date', value, precision: 'day' }, false)).toBe(false);
    expect(validQuestionAnswer(date, { type: 'date', value: '2026-09-21', precision: 'day' }, false)).toBe(true);
    const number = descriptor({ field: { type: 'number', allowBlank: false, declineValue: null, min: 0, max: 40,
      units: 'hours', precision: 1, integer: false } });
    for (const answer of [{ type: 'number', value: 20.11, units: 'hours', precision: 1 },
      { type: 'number', value: 20, units: 'days', precision: 1 }, { type: 'text', value: '20' }] as AnswerValue[])
      expect(validQuestionAnswer(number, answer, false)).toBe(false);
    expect(QuestionDescriptorSchema.safeParse({ ...date, required: true, field: { ...date.field, allowBlank: true } }).success).toBe(false);
    expect(AnswerCommandSchema.safeParse({ ownerId: 'bob' }).success).toBe(false);
  });

  it('does not bypass blank, decline or safe numeric precision through another answer variant', () => {
    const text = descriptor({ required: false, field: { type: 'text', allowBlank: false, declineValue: null,
      minLength: 0, maxLength: 20, format: 'plain', units: null, precision: null } });
    expect(validQuestionAnswer(text, { type: 'text', value: '' }, true)).toBe(false);
    const choice = descriptor({ required: false, field: { type: 'multiselect', allowBlank: false, declineValue: 'decline',
      options: [{ value: 'yes', label: 'Yes' }, { value: 'decline', label: 'Decline' }],
      minSelections: 0, maxSelections: 2, units: null, precision: null } });
    expect(validQuestionAnswer(choice, { type: 'choices', value: [] }, true)).toBe(false);
    expect(validQuestionAnswer(choice, { type: 'choices', value: ['decline'] }, false)).toBe(false);
    const numeric = descriptor({ field: { type: 'number', allowBlank: false, declineValue: null,
      min: 0, max: 1e30, units: 'dollars', precision: 2, integer: false } });
    expect(validQuestionAnswer(numeric, { type: 'number', value: 1e25, units: 'dollars', precision: 2 }, false)).toBe(false);
  });

  it('focus is an idempotent assigned-worker request, never resolution or a synthetic observation', async () => {
    const a = await prepared(), q = await batch(a, [descriptor({ kind: 'needs_login',
      field: { type: 'intervention', allowBlank: false, declineValue: null, units: null, precision: null } })]);
    const detail = await getQuestion(db, 'alice', q.id, options);
    expect(QuestionDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.canAnswer).toBe(false);
    const input = { ...request(), expectedRevision: detail.revision };
    const result = await requestQuestionFocus(db, 'alice', q.id, input, options);
    expect(result).toMatchObject({ questionId: q.id, applicationId: a.app.id, workerId: a.worker.workerId, status: 'pending' });
    expect(await requestQuestionFocus(other, 'alice', q.id, input, options)).toEqual(result);
    expect(await db.select().from(questionInterventions)).toHaveLength(1);
    expect((await qRow(q.id)).resolvedAt).toBeNull();
    expect(await appRow(a.app.id)).toMatchObject({ state: 'needs_login' });
    await expect(requestQuestionFocus(db, 'bob', q.id, input, options)).rejects.toMatchObject({ status: 404 });
  });
});

describe('worker intervention DAL', () => {
  async function pending(kind: 'needs_login' | 'needs_verification' = 'needs_login', blocker = false) {
    const a = await prepared(), q = await batch(a, [descriptor({ kind, key: 'human',
      factIds: [profile.availability.hoursDuringClasses.id],
      field: { type: 'intervention', allowBlank: false, declineValue: null, units: null, precision: null } }),
    ...(blocker ? [descriptor()] : [])]);
    const focus = await requestQuestionFocus(db, 'alice', q.id, { ...request(), expectedRevision: (await qRow(q.id)).revision }, options);
    const app = await appRow(a.app.id);
    const input: InterventionAck = { questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: focus.revision,
      expectedApplicationRevision: app.revision, fence: app.fence, result: 'observed', reason: null,
      observation: { kind: kind === 'needs_login' ? 'login_complete' : 'verification_complete',
        ats: app.ats, tenant: app.tenant, requisition: app.requisition, observedAt: now } };
    return { a, q, focus, input };
  }

  it('byte-bounds twenty large commands through real worker transport and fairly advances focused work', async () => {
    const a = await prepared(), ids = new Set<string>(), wording = '\u4e2d'.repeat(4000), reason = '\u6587'.repeat(4000);
    for (let index = 0; index < 20; index++) {
      const app = index === 0 ? a.app : await enqueueApplication(db, 'alice', a.run.id,
        { ats: 'fixture', tenant: `large-${index}`, requisition: randomUUID() }, options);
      const q = await batch({ ...a, app }, [descriptor({ kind: 'needs_login', originalWording: wording, reason,
        field: { type: 'intervention', allowBlank: false, declineValue: null, units: null, precision: null } })]);
      ids.add((await requestQuestionFocus(db, 'alice', q.id,
        { ...request(), expectedRevision: (await qRow(q.id)).revision }, options)).id);
    }
    const responseBytes: number[] = [];
    const server = createServer(async (request, response) => {
      request.resume();
      if (request.url !== '/api/worker/interventions' || request.method !== 'POST' ||
          request.headers.authorization !== `Bearer ${a.token}`) { response.writeHead(403).end(); return; }
      try {
        const body = JSON.stringify(await pollQuestionInterventions(db, a.token, options));
        responseBytes.push(Buffer.byteLength(body));
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
      } catch { response.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback fixture address.');
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (new URL(url).origin !== origin) throw new Error('External network forbidden.');
      return nativeFetch(input, init);
    });
    try {
      const transport = workerTransport({ origin, token: a.token, allowLoopback: true }), processed = new Set<string>();
      for (let index = 0; index < 20; index++) {
        const page = await transport.interventions();
        expect(page.commands.length).toBeGreaterThan(0);
        expect(page.commands.length).toBeLessThan(20);
        expect(page.commands.every(c => c.descriptor.originalWording === wording && c.descriptor.reason === reason)).toBe(true);
        const command = page.commands[0];
        expect(processed.has(command.id)).toBe(false);
        processed.add(command.id);
        await ackQuestionIntervention(db, a.token, command.id, {
          questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: command.revision,
          expectedApplicationRevision: command.expectedApplicationRevision, fence: command.fence,
          result: 'focused', reason: null, observation: null,
        }, options);
      }
      expect(processed).toEqual(ids);
      expect(responseBytes).toHaveLength(20);
      expect(responseBytes.every(bytes => bytes < 128 * 1024)).toBe(true);
      expect((await getInboxStatus(db, 'alice', options)).unresolved).toBe(20);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 20_000); // ~0.5s alone, but crossed the 5s default under a loaded CI runner.

  it('rejects a descriptor exceeding the stored byte limit before it can enter a worker page', async () => {
    const a = await prepared(), lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
    const oversized = descriptor({ originalWording: '\u4e2d'.repeat(4000), reason: '\u6587'.repeat(4000), field: {
      type: 'select', allowBlank: false, declineValue: null, units: null, precision: null, minSelections: 1, maxSelections: 1,
      options: Array.from({ length: 100 }, (_, i) => ({ value: `${String(i).padStart(3, '0')}${'v'.repeat(297)}`, label: 'l'.repeat(300) })),
    } });
    expect(QuestionDescriptorSchema.safeParse(oversized).success).toBe(true);
    const input: QuestionBatch = { questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: lease.revision,
      fence: lease.fence, expectedProfileRevision: 1, checkpoint: { stage: 'screening', sequence: 1 },
      company: 'Synthetic', role: 'Engineer', questions: [oversized] };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(128 * 1024);
    await expect(registerQuestionBatch(db, a.token, a.app.id, input, options)).rejects.toMatchObject({ status: 413 });
    expect(await db.select().from(questions)).toHaveLength(0);
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
  });

  it('polls only the assigned worker and keeps focused/unavailable acknowledgements separate from resolution', async () => {
    const { a, q, focus, input } = await pending();
    const wrong = await prepared(), bob = await prepared('bob');
    expect((await pollQuestionInterventions(db, wrong.token, options)).commands).toEqual([]);
    expect((await pollQuestionInterventions(db, bob.token, options)).commands).toEqual([]);
    const page = await pollQuestionInterventions(db, a.token, options);
    expect(page).toMatchObject({ questionProtocolVersion: 1, commands: [{ id: focus.id, questionId: q.id,
      workerId: a.worker.workerId, expectedApplicationRevision: input.expectedApplicationRevision, fence: input.fence, status: 'pending' }] });
    const before = await appRow(a.app.id), row = await qRow(q.id);
    const focused = { ...input, result: 'focused' as const, observation: null };
    const result = await ackQuestionIntervention(db, a.token, focus.id, focused, options);
    expect(result).toMatchObject({ status: 'focused', revision: focus.revision + 1 });
    expect(await ackQuestionIntervention(other, a.token, focus.id, focused, options)).toEqual(result);
    expect(await appRow(a.app.id)).toEqual(before); expect(await qRow(q.id)).toEqual(row);
    expect((await pollQuestionInterventions(db, a.token, options)).commands[0].revision).toBe(result.revision);
    const unavailable = await ackQuestionIntervention(db, a.token, focus.id, { ...input, eventId: randomUUID(),
      expectedRevision: result.revision, result: 'unavailable', reason: 'No paired browser window.', observation: null }, options);
    expect(unavailable.status).toBe('unavailable');
    expect((await pollQuestionInterventions(db, a.token, options)).commands).toEqual([]);
    expect(await appRow(a.app.id)).toEqual(before); expect(await qRow(q.id)).toEqual(row);
    await expect(ackQuestionIntervention(db, a.token, focus.id,
      { ...input, eventId: randomUUID(), expectedRevision: unavailable.revision }, options)).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    { kind: 'needs_login' as const, blocker: false }, { kind: 'needs_login' as const, blocker: true },
    { kind: 'needs_verification' as const, blocker: false }, { kind: 'needs_verification' as const, blocker: true },
  ])('observed $kind resolves only its question and respects other blockers ($blocker)', async ({ kind, blocker }) => {
    const { a, q, focus, input } = await pending(kind, blocker);
    const result = await ackQuestionIntervention(db, a.token, focus.id, input, options);
    expect(result.status).toBe('observed');
    expect(await qRow(q.id)).toMatchObject({ resolvedAt: now, answerId: null });
    expect(await appRow(a.app.id)).toMatchObject({ state: blocker ? 'needs_answer' : 'screening', leaseUntil: null,
      checkpoint: { stage: 'screening', sequence: 2 } });
    expect((await pollQuestionInterventions(db, a.token, options)).commands).toEqual([]);
    expect(await db.select().from(questionAnswers)).toHaveLength(0);
    const events = await db.select().from(applicationEvents);
    expect(events.some(e => (e.acknowledgement as { observation?: unknown }).observation &&
      hashValue((e.acknowledgement as { observation: unknown }).observation) === hashValue(input.observation))).toBe(true);
    expect(await ackQuestionIntervention(other, a.token, focus.id, input, options)).toEqual(result);
    expect(await db.select().from(applicationEvents)).toEqual(events);
    if (blocker) {
      const remaining = q.result.questionIds[1];
      expect((await answerQuestion(db, 'alice', remaining, await answerInput(remaining), options)).resumedApplicationIds).toEqual([a.app.id]);
    }
  });

  it.each(['owner', 'worker', 'command-revision', 'question-revision', 'application-revision', 'fence', 'role', 'tenant',
    'ats', 'observation-kind', 'future-observation', 'old-observation', 'profile', 'policy', 'revoke', 'submit', 'answer-update', 'stop'] as const)(
    'rejects %s intervention acknowledgement without resolving or resuming', async fault => {
      const { a, q, focus, input } = await pending('needs_login', true);
      let token = a.token;
      if (fault === 'owner' || fault === 'worker') token = (await prepared(fault === 'owner' ? 'bob' : 'alice')).token;
      if (fault === 'command-revision') input.expectedRevision++;
      if (fault === 'question-revision') await db.update(questions).set({ revision: 2 }).where(eq(questions.id, q.id));
      if (fault === 'application-revision') input.expectedApplicationRevision++;
      if (fault === 'fence') input.fence++;
      if (fault === 'role') input.observation!.requisition = 'other-role';
      if (fault === 'tenant') input.observation!.tenant = 'other-tenant';
      if (fault === 'ats') input.observation!.ats = 'other-ats';
      if (fault === 'observation-kind') input.observation!.kind = 'verification_complete';
      if (fault === 'future-observation') input.observation!.observedAt++;
      if (fault === 'old-observation') input.observation!.observedAt--;
      if (fault === 'profile') await editProfile(true);
      if (fault === 'policy') await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
      if (fault === 'revoke') await revokeWorker(db, 'alice', a.worker.workerId, { ...request(), expectedRevision: 1 }, options);
      if (fault === 'submit') await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, a.app.id));
      if (fault === 'answer-update') {
        const other = q.result.questionIds[1];
        await answerQuestion(db, 'alice', other, await answerInput(other), options);
      }
      if (fault === 'stop') await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 1, action: 'stop' }, options);
      const before = await appRow(a.app.id), question = await qRow(q.id);
      await expect(ackQuestionIntervention(db, token, focus.id, input, options)).rejects.toBeDefined();
      expect(await appRow(a.app.id)).toEqual(before); expect(await qRow(q.id)).toEqual(question);
      expect((await db.select().from(questionInterventions))[0].status).toBe('pending');
      if (['question-revision', 'profile', 'policy', 'submit', 'answer-update', 'stop'].includes(fault))
        expect((await pollQuestionInterventions(db, a.token, options)).commands).toEqual([]);
      if (fault === 'revoke') await expect(pollQuestionInterventions(db, a.token, options)).rejects.toMatchObject({ status: 401 });
    });

  it('rolls back observation and receipt if the application resume fails', async () => {
    const { a, q, focus, input } = await pending();
    const before = await db.select().from(applicationEvents);
    await db.run(sql`create trigger fixture_intervention_fail before update on private_application begin select raise(ignore); end`);
    await expect(ackQuestionIntervention(db, a.token, focus.id, input, options)).rejects.toMatchObject({ status: 409 });
    expect((await qRow(q.id)).resolvedAt).toBeNull();
    expect((await db.select().from(questionInterventions))[0].status).toBe('pending');
    expect(await db.select().from(applicationEvents)).toEqual(before);
    await db.run(sql`drop trigger fixture_intervention_fail`);
    expect((await ackQuestionIntervention(db, a.token, focus.id, input, options)).status).toBe('observed');
  });
});
