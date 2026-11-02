import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '../private-db/index.ts';
import { applications, applicationLive, applicationReceipts, applicationRuns, applicationEvents, applicationSubmissions, policyHeads, policyVersions, user, workerPairings, workers, workerCommands } from '../private-db/schema.ts';
import { createEmptyPolicy, type Policy } from './policy.ts';
import { createEmptyProfile } from './profile.ts';
import { getPolicy, getProfile, hashValue, mutatePolicy, saveProfile } from './stores.ts';
import { APPLICATION_STATES, SAFE_STAGES, SUBMIT_APPROVAL, canTransition, type ApplicationState } from './state.ts';
import * as p from './worker-protocol.ts';
import { createPairing, pairWorker, listWorkers, revokeWorker, revokePairing, scheduleWorker } from './pairing.ts';
import { createRun, listRuns, commandRun, commandApplication, returnedPostingUrls } from './runs.ts';
import { enqueueApplication } from './test-enqueue.ts';
import { pollWorker, heartbeatWorker } from './leases.ts';
import { recordWorkerEvent } from './events.ts';
import { listLive } from './live.ts';
import { listMaterials } from './materials.ts';
import { setVerificationCode, takeVerificationCode } from './live.ts';
import { beginSubmission, recordReceipt } from './submissions.ts';
import { type WorkerOptions } from './worker-store.ts';
import { stubHousehold } from '../test-household.ts';

vi.mock('server-only', () => ({}));
let db: PrivateDb, other: PrivateDb, dir: string, now: number, options: WorkerOptions;
const secret = () => randomBytes(32).toString('base64url');
const revision = (expectedRevision: number) => ({ expectedRevision, requestId: randomUUID() });
const ref = (lease: p.Lease) => ({ applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision });
async function paired(ownerId = 'alice') {
  const grant = await createPairing(db, ownerId, { ...revision(0), expectedRevision: 0, label: 'Synthetic worker' }, options);
  const input: p.PairRequest = {
    protocolVersion: 1, workerId: randomUUID(), requestId: randomUUID(), grant: grant.grant,
    workerToken: secret(), workerVersion: '0.1.0', capabilities: ['control-v1'],
  };
  const worker = await pairWorker(db, input, options);
  return { ...worker, input, grant, token: input.workerToken };
}
async function prepared(ownerId = 'alice', tenant = 'fixture', requisition: string = randomUUID()) {
  const worker = await paired(ownerId);
  const run = await createRun(db, ownerId, { expectedRevision: 0, requestId: randomUUID(), workerId: worker.workerId }, options);
  const app = await enqueueApplication(db, ownerId, run.id, { ats: 'fixture', tenant, requisition }, options);
  return { worker, run, app };
}
async function claim(token: string) {
  const response = await pollWorker(db, token, { protocolVersion: 1 }, options);
  p.PollResponseSchema.parse(response);
  expect(response.lease).not.toBeNull();
  return response.lease!;
}
const event = (lease: p.Lease, state: ApplicationState = lease.state, sequence = (lease.checkpoint?.sequence ?? 0) + 1): p.EventRequest => ({
  protocolVersion: 1, eventId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision,
  state, checkpoint: { stage: lease.state as p.Checkpoint['stage'], sequence }, reasonCode: null,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase3-server-'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden.'); }));
  now = 1_800_000_000_000;
  options = { now: () => now };
  stubHousehold();
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await migratePrivateDb(db);
  other = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  for (const id of ['alice', 'bob']) {
    await db.insert(user).values({ id, name: 'Synthetic', email: `${id}@example.test`, emailVerified: true });
    const policy = createEmptyPolicy(), hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: id, version: 1, hash, policy, createdAt: now });
    await db.insert(policyHeads).values({ ownerId: id, revision: 1, policyVersion: 1, enabled: true,
      acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
  }
});
afterEach(() => {
  other?.$client.close(); db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('Phase 3 pure protocol and transition guards', () => {
  it('is strict, has no owner authority, and requires evidence for irreversible progression', () => {
    expect(p.PairingCreateSchema.safeParse({ ...revision(0), label: 'Host', ownerId: 'bob' }).success).toBe(false);
    expect(p.PollRequestSchema.safeParse({ protocolVersion: 2 }).success).toBe(false);
    expect(canTransition('queued', 'screening')).toBe(true);
    expect(canTransition('screening', 'tailoring')).toBe(true);
    expect(canTransition('tailoring', 'filling')).toBe(false);
    expect(canTransition('tailoring', 'filling', { artifactVerified: true })).toBe(true);
    expect(canTransition('filling', 'ready')).toBe(false);
    expect(canTransition('ready', 'submitting')).toBe(false);
    expect(canTransition('submitting', 'submission_unknown')).toBe(true);
    for (const state of APPLICATION_STATES) {
      expect(canTransition('submitted', state)).toBe(false);
      expect(canTransition('submission_unknown', state)).toBe(false);
    }
    expect(canTransition('submission_unknown', 'submitted', { receiptVerified: true })).toBe(true);
  });
});
describe('hashed owner-approved pairings', () => {
  it('binds a durable submission intent and immutable exact-role receipt', async () => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 0 } }).where(eq(applications.id, app.id));
    const intentId = randomUUID();
    const identity = { ats: app.ats, tenant: app.tenant, requisition: app.requisition };
    const started = await beginSubmission(db, worker.token, app.id, {
      protocolVersion: 1, intentId, fence: lease.fence, expectedRevision: lease.revision,
      identity, company: 'Fixture Co', role: 'Software Engineering Intern', manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)],
    }, options);
    expect(started).toMatchObject({ applicationId: app.id, intentId, state: 'submitting', replayed: false });
    const receipt = await recordReceipt(db, worker.token, app.id, {
      protocolVersion: 1, intentId, identity, company: 'Fixture Co', role: 'Software Engineering Intern',
      receiptId: 'receipt-123', submittedAt: now, evidence: {
        source: 'confirmation_page', pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Fixture Co Software Engineering Intern',
      },
    }, options);
    expect(receipt).toMatchObject({ applicationId: app.id, intentId, state: 'submitted', replayed: false });
    expect(await recordReceipt(db, worker.token, app.id, {
      protocolVersion: 1, intentId, identity, company: 'Fixture Co', role: 'Software Engineering Intern',
      receiptId: 'receipt-123', submittedAt: now, evidence: {
        source: 'confirmation_page', pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Fixture Co Software Engineering Intern',
      },
    }, options)).toMatchObject({ replayed: true, state: 'submitted' });
    expect((await db.select().from(applications).where(eq(applications.id, app.id)))[0]).toMatchObject({ state: 'submitted', leaseUntil: null });
  });
  it('fails closed for owner and identity mismatches and rejects receipt replay changes', async () => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 0 } }).where(eq(applications.id, app.id));
    const identity = { ats: app.ats, tenant: app.tenant, requisition: app.requisition };
    const base = {
      protocolVersion: 1 as const, intentId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision,
      identity, company: 'Fixture Co', role: 'Software Engineering Intern', manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)],
    };
    await expect(beginSubmission(db, worker.token, app.id, { ...base, identity: { ...identity, tenant: 'other' } }, options))
      .rejects.toMatchObject({ status: 409, code: 'IDENTITY_MISMATCH' });
    expect(await db.select().from(applicationSubmissions)).toHaveLength(0);
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'preview');
    await expect(beginSubmission(db, worker.token, app.id, base, options))
      .rejects.toMatchObject({ status: 403, code: 'STAGING_FIXTURE_ONLY' });
    vi.stubEnv('VERCEL_ENV', 'production');
    const intent = await beginSubmission(db, worker.token, app.id, base, options);
    await expect(recordReceipt(db, worker.token, app.id, {
      protocolVersion: 1, intentId: intent.intentId, identity, company: 'Fixture Co', role: 'Other role',
      receiptId: 'receipt-123', submittedAt: now, evidence: {
        source: 'confirmation_page', pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Other role',
      },
    }, options)).rejects.toMatchObject({ status: 409, code: 'RECEIPT_IDENTITY_MISMATCH' });
    const receipt = {
      protocolVersion: 1 as const, intentId: intent.intentId, identity, company: 'Fixture Co', role: 'Software Engineering Intern',
      receiptId: 'receipt-123', submittedAt: now, evidence: {
        source: 'confirmation_page' as const, pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Fixture Co Software Engineering Intern',
      },
    };
    await recordReceipt(db, worker.token, app.id, receipt, options);
    await expect(recordReceipt(db, worker.token, app.id, { ...receipt, receiptId: 'receipt-456' }, options))
      .rejects.toMatchObject({ status: 409 });
    const bob = await paired('bob');
    await expect(recordReceipt(db, bob.token, app.id, receipt, options)).rejects.toMatchObject({ status: 409 });
  });
  it('enforces immutable intent and receipt rows at the database boundary', async () => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 0 } }).where(eq(applications.id, app.id));
    const identity = { ats: app.ats, tenant: app.tenant, requisition: app.requisition };
    const intentId = randomUUID();
    await beginSubmission(db, worker.token, app.id, {
      protocolVersion: 1, intentId, fence: lease.fence, expectedRevision: lease.revision, identity,
      company: 'Fixture Co', role: 'Software Engineering Intern', manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)],
    }, options);
    await recordReceipt(db, worker.token, app.id, {
      protocolVersion: 1, intentId, identity, company: 'Fixture Co', role: 'Software Engineering Intern', receiptId: 'receipt-123',
      submittedAt: now, evidence: { source: 'confirmation_page', pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Fixture Co Software Engineering Intern' },
    }, options);
    await expect(db.update(applicationSubmissions).set({ role: 'Changed' }).where(eq(applicationSubmissions.intentId, intentId))).rejects.toThrow();
    await expect(db.delete(applicationSubmissions).where(eq(applicationSubmissions.intentId, intentId))).rejects.toThrow();
    await expect(db.update(applicationReceipts).set({ role: 'Changed' }).where(eq(applicationReceipts.intentId, intentId))).rejects.toThrow();
    await expect(db.delete(applicationReceipts).where(eq(applicationReceipts.intentId, intentId))).rejects.toThrow();
    const triggers = await db.all(sql`select name from sqlite_master where type = 'trigger' and name in
      ('private_submission_identity_immutable', 'private_submission_no_delete', 'private_receipt_no_update', 'private_receipt_no_delete')`);
    expect(triggers.map((row) => (row as { name: string }).name).sort()).toEqual([
      'private_receipt_no_delete', 'private_receipt_no_update', 'private_submission_identity_immutable', 'private_submission_no_delete',
    ]);
  });
  it.each(['pair', 'list'] as const)('persists stale pending-grant revocation on %s after a credential change', async (operation) => {
    const grant = await createPairing(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, label: 'Pending' }, options);
    const bob = await createPairing(db, 'bob', { requestId: randomUUID(), expectedRevision: 0, label: 'Other owner' }, options);
    vi.stubEnv('WORKIE_HOUSEHOLD_PASSCODE', '1357');
    if (operation === 'pair') {
      await expect(pairWorker(db, { protocolVersion: 1, requestId: randomUUID(), workerId: randomUUID(),
        workerToken: secret(), grant: grant.grant, workerVersion: '0.1', capabilities: ['control-v1'] }, options))
        .rejects.toMatchObject({ status: 401 });
    } else await listWorkers(db, 'alice', options);
    expect((await db.select().from(workerPairings).where(eq(workerPairings.id, grant.pairingId)))[0])
      .toMatchObject({ revokedAt: now, revision: 2, consumedAt: null });
    expect((await db.select().from(workerPairings).where(eq(workerPairings.id, bob.pairingId)))[0].revokedAt).toBeNull();
    expect(await db.select().from(workers)).toHaveLength(0);
  });
  it('reports lost grant creation explicitly without minting a replacement', async () => {
    const command = { requestId: randomUUID(), expectedRevision: 0 as const, label: 'Pending' };
    await createPairing(db, 'alice', command, options);
    await expect(createPairing(other, 'alice', command, options)).rejects.toMatchObject({ code: 'GRANT_UNAVAILABLE' });
    expect(await db.select().from(workerPairings)).toHaveLength(1);
  });
  it('reconciles a lost registration response after expiry, without another worker or secret persistence', async () => {
    const worker = await paired();
    now += p.PAIRING_TTL_MS + 1;
    const again = await pairWorker(other, worker.input, options);
    expect(again.workerId).toBe(worker.workerId);
    const stored = JSON.stringify([await db.select().from(workers), await db.select().from(workerPairings)]);
    expect(stored).not.toContain(worker.token);
    expect(stored).not.toContain(worker.grant.grant);
    expect(await db.select().from(workers)).toHaveLength(1);
    await expect(pairWorker(db, { ...worker.input, requestId: randomUUID() }, options)).rejects.toMatchObject({ status: 409 });
    await expect(pairWorker(db, { ...worker.input, workerToken: secret() }, options)).rejects.toMatchObject({ status: 409 });
  });
  it('atomically consumes once across async clients and rejects expired or revoked grants', async () => {
    const grant = await createPairing(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, label: 'Host' }, options);
    const input: p.PairRequest = { protocolVersion: 1, workerId: randomUUID(), requestId: randomUUID(), grant: grant.grant,
      workerToken: secret(), workerVersion: '0.1', capabilities: ['control-v1'] };
    const attempts = await Promise.allSettled([pairWorker(db, input, options),
      pairWorker(other, { ...input, workerId: randomUUID(), workerToken: secret() }, options)]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(workers)).toHaveLength(1);
    const expiring = await createPairing(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, label: 'Host' }, options);
    now = expiring.expiresAt;
    await expect(pairWorker(db, { ...input, grant: expiring.grant }, options)).rejects.toMatchObject({ status: 401 });
    await expect(revokePairing(db, 'bob', grant.pairingId, revision(2), options)).rejects.toMatchObject({ status: 404 });
  });
  it('rechecks household email, verified owner and credential binding, but does not bind browser sessions', async () => {
    const { worker, run } = await prepared();
    const lease = await claim(worker.token);
    vi.stubEnv('WORKIE_HOUSEHOLD_PASSCODE', '1357');
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ status: 401 });
    expect((await db.select().from(workers))[0].revokedAt).toBe(now);
    expect((await db.select().from(applicationRuns).where(eq(applicationRuns.id, run.id)))[0].state).toBe('paused');
    expect((await db.select().from(applications))[0].leaseUntil).toBeNull();
    const next = await paired();
    await db.update(user).set({ email: 'not-household@example.test' }).where(eq(user.id, 'alice'));
    await expect(pollWorker(db, next.token, { protocolVersion: 1 }, options))
      .rejects.toMatchObject({ status: 401 });
    const third = await paired('bob');
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, 'bob'));
    await expect(pollWorker(db, third.token, { protocolVersion: 1 }, options)).rejects.toMatchObject({ status: 401 });
    await expect(pollWorker(db, secret(), { protocolVersion: 1 }, options)).rejects.toMatchObject({ status: 401 });
  });
  it('revokes/removes pairing durably with exact command replay and owner isolation', async () => {
    const worker = await paired();
    const command = revision(2);
    const revoked = await revokePairing(db, 'alice', worker.grant.pairingId, command, options);
    expect(await revokePairing(other, 'alice', worker.grant.pairingId, command, options)).toEqual(revoked);
    await expect(pairWorker(db, worker.input, options)).rejects.toMatchObject({ status: 401 });
    await expect(pollWorker(db, worker.token, { protocolVersion: 1 }, options)).rejects.toMatchObject({ status: 401 });
    expect((await listWorkers(db, 'bob', options)).workers).toEqual([]);
    const current = await paired();
    await expect(revokeWorker(db, 'bob', current.workerId, revision(1), options)).rejects.toMatchObject({ status: 404 });
    expect((await listWorkers(db, 'alice', options)).workers.find((w) => w.id === current.workerId)?.online).toBe(true);
    now += p.HEARTBEAT_MS * 3;
    expect((await listWorkers(db, 'alice', options)).workers.find((w) => w.id === current.workerId)?.online).toBe(false);
  });
  it('refuses a grant made for another applicant before registering or consuming it', async () => {
    const grant = await createPairing(db, 'alice', { ...revision(0), expectedRevision: 0, label: 'Set up for Bob' }, options);
    const input: p.PairRequest = {
      protocolVersion: 1, workerId: randomUUID(), requestId: randomUUID(), grant: grant.grant,
      workerToken: secret(), workerVersion: '0.1.0', capabilities: ['control-v1'],
    };
    await expect(pairWorker(db, { ...input, expectedOwnerId: 'bob' }, options))
      .rejects.toMatchObject({ status: 409, code: 'OWNER_MISMATCH' });
    expect((await listWorkers(db, 'alice', options)).workers).toEqual([]);
    // The grant still works for the applicant it was made for.
    await expect(pairWorker(db, { ...input, expectedOwnerId: 'alice' }, options)).resolves.toMatchObject({ ownerId: 'alice' });
  });
});
describe('async leases, checkpoints and stable identity', () => {
  it('reclaims one active lease before assigning another role to the same worker', async () => {
    const worker = await paired();
    const run = await createRun(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, workerId: worker.workerId }, options);
    const first = await enqueueApplication(db, 'alice', run.id,
      { ats: 'fixture', tenant: 'first', requisition: 'one' }, options);
    const second = await enqueueApplication(db, 'alice', run.id,
      { ats: 'fixture', tenant: 'second', requisition: 'two' }, options);
    const lease = await claim(worker.token);
    const waiting = lease.applicationId === first.id ? second : first;
    const reclaimed = await claim(worker.token);
    expect(reclaimed.applicationId).toBe(lease.applicationId);
    expect(reclaimed.fence).toBeGreaterThan(lease.fence);
    expect((await db.select().from(applications).where(eq(applications.id, waiting.id)))[0].state).toBe('queued');
    await recordWorkerEvent(db, worker.token, reclaimed.applicationId,
      { ...event(reclaimed, 'skipped'), reasonCode: 'fixture_ineligible' }, options);
    expect((await claim(worker.token)).applicationId).toBe(waiting.id);
  });
  it.each(['paused', 'obsolete-policy', 'busy-tenant'] as const)(
    'finds runnable work beyond 250 %s candidates with tied creation times', async (reason) => {
      const worker = await paired();
      const blocked = await createRun(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, workerId: worker.workerId }, options);
      // Stable IDs make the runnable row last even when every creation time ties.
      await db.insert(applications).values(Array.from({ length: 250 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ownerId: 'alice', runId: blocked.id, workerId: worker.workerId, ats: 'fixture',
        tenant: 'blocked', requisition: `blocked-${index}`, availableAt: now, createdAt: now,
      })));
      if (reason === 'paused') await commandRun(db, 'alice', blocked.id, { ...revision(1), action: 'pause' }, options);
      if (reason === 'obsolete-policy') await db.update(policyHeads).set({ revision: 3 }).where(eq(policyHeads.ownerId, 'alice'));
      if (reason === 'busy-tenant') {
        const busy = await prepared('alice', 'blocked');
        await claim(busy.worker.token);
      }
      // A worker runs one live run at a time, so the busy tenant's run takes the runnable role too.
      const run = reason === 'busy-tenant' ? blocked
        : await createRun(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, workerId: worker.workerId }, options);
      const runnable = await enqueueApplication(db, 'alice', run.id,
        { ats: 'fixture', tenant: 'unrelated', requisition: 'runnable' }, options);
      expect(await db.select().from(applications).where(eq(applications.workerId, worker.workerId))).toHaveLength(251);
      const lease = await claim(worker.token);
      expect(lease).toMatchObject({ applicationId: runnable.id, runId: run.id, state: 'screening', mode: 'safe',
        policyRevision: reason === 'obsolete-policy' ? 3 : 1 });
      await recordWorkerEvent(db, worker.token, runnable.id,
        { ...event(lease, 'blocked_unsupported'), reasonCode: 'adapter_unavailable' }, options);
      expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    });
  it('defers abandoned unknown reconciliation durably on next poll and frees unrelated work without retrying', async () => {
    const { worker, app, run } = await prepared();
    const initial = await claim(worker.token), input = event(initial);
    const saved = await recordWorkerEvent(db, worker.token, app.id, input, options);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    now += p.LEASE_MS;
    const unknown = await claim(worker.token);
    expect(unknown).toMatchObject({ state: 'submission_unknown', mode: 'reconcile', checkpoint: { sequence: 1 } });
    const unrelated = await enqueueApplication(db, 'alice', run.id,
      { ats: 'fixture', tenant: 'unrelated', requisition: 'runnable' }, options);
    const next = await claim(worker.token);
    expect(next.applicationId).toBe(unrelated.id);
    const [deferred] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect(deferred).toMatchObject({ state: 'submission_unknown', leaseUntil: null, leaseCheckedAt: null,
      // Deferring keeps why the submission went unknown (its lease expired mid-submit) for the applicant.
      revision: unknown.revision + 1, fence: unknown.fence + 1, checkpoint: unknown.checkpoint, retries: 0,
      reasonCode: 'lease_expired' });
    expect(deferred.availableAt).toBeGreaterThan(now + p.HEARTBEAT_MS);
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(unknown) }, options))
      .rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(recordWorkerEvent(db, worker.token, app.id,
      { ...event(unknown), checkpoint: { stage: 'ready', sequence: 2 } }, options))
      .rejects.toMatchObject({ code: 'LEASE_LOST' });
    for (const action of ['retry-safe', 'cancel', 'skip'] as const) {
      await expect(commandApplication(db, 'alice', run.id, app.id, { ...revision(deferred.revision), action }, options))
        .rejects.toMatchObject({ status: 409 });
    }
    expect(await recordWorkerEvent(db, worker.token, app.id, input, options))
      .toMatchObject({ revision: saved.revision, replayed: true, lease: null });
    await recordWorkerEvent(db, worker.token, unrelated.id,
      { ...event(next, 'blocked_unsupported'), reasonCode: 'adapter_unavailable' }, options);
    db.$client.close();
    db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    now = deferred.availableAt - 1;
    expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    expect((await db.select().from(applications).where(eq(applications.id, app.id)))[0]).toEqual(deferred);
    now += 1;
    const reconciled = await claim(worker.token);
    expect(reconciled).toMatchObject({ applicationId: app.id, state: 'submission_unknown', mode: 'reconcile',
      checkpoint: unknown.checkpoint, fence: deferred.fence + 1 });
    expect(await db.select().from(applicationEvents)).toHaveLength(2);
  });
  it('another worker poll cannot defer an active unknown assignment', async () => {
    const { worker, app } = await prepared();
    await db.update(applications).set({ state: 'submission_unknown' }).where(eq(applications.id, app.id));
    const unknown = await claim(worker.token);
    const otherWorker = await prepared('alice', 'unrelated');
    expect((await claim(otherWorker.worker.token)).applicationId).toBe(otherWorker.app.id);
    expect((await heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(unknown) }, options)).lease)
      .toMatchObject({ applicationId: app.id, state: 'submission_unknown', fence: unknown.fence, revision: unknown.revision });
  });
  it('does not cycle deferred unknowns ahead of runnable work when backoffs expire', async () => {
    const { worker, run, app } = await prepared('alice', 'unrelated');
    await db.insert(applications).values(Array.from({ length: 8 }, (_, index) => ({
      id: randomUUID(), ownerId: 'alice', runId: run.id, workerId: worker.workerId, ats: 'fixture',
      tenant: `unknown-${index}`, requisition: 'unknown', state: 'submission_unknown' as const,
      availableAt: now - 8 + index, createdAt: now - 8 + index,
    })));
    const seen = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      const lease = await claim(worker.token);
      seen.push(lease.applicationId);
      if (lease.applicationId === app.id) break;
      expect(lease).toMatchObject({ state: 'submission_unknown', mode: 'reconcile' });
      now += p.HEARTBEAT_MS;
    }
    expect(seen).toContain(app.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
  it('allows exactly one selected worker and one active owner/ATS/tenant across connections', async () => {
    const a = await prepared(), b = await prepared();
    const results = await Promise.all([pollWorker(db, a.worker.token, { protocolVersion: 1 }, options),
      pollWorker(other, b.worker.token, { protocolVersion: 1 }, options)]);
    expect(results.filter((r) => r.lease !== null)).toHaveLength(1);
    expect(await db.select().from(applications).where(sql`${applications.leaseUntil} is not null`)).toHaveLength(1);
    const active = results.find((r) => r.lease)!.lease!;
    const loser = active.workerId === a.worker.workerId ? b : a;
    await expect(recordWorkerEvent(db, loser.worker.token, active.applicationId, event(active), options)).rejects.toMatchObject({ status: 404 });
    const bob = await prepared('bob');
    expect((await claim(bob.worker.token)).applicationId).toBe(bob.app.id);
  });
  it('deduplicates owner+ATS+tenant+requisition across runs without transferring the selected worker', async () => {
    const a = await prepared('alice', 'fixture', 'stable-role');
    const b = await paired();
    const run = await createRun(db, 'alice', { expectedRevision: 0, requestId: randomUUID(), workerId: b.workerId }, options);
    const duplicate = await enqueueApplication(other, 'alice', run.id, { ats: 'fixture', tenant: 'fixture', requisition: 'stable-role' }, options);
    expect(duplicate).toEqual(a.app);
    expect((await pollWorker(db, b.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    await expect(db.update(applications).set({ workerId: b.workerId }).where(eq(applications.id, a.app.id))).rejects.toThrow();
    await expect(db.insert(applications).values({ id: randomUUID(), ownerId: 'bob', runId: run.id, workerId: b.workerId,
      ats: 'fixture', tenant: 'test', requisition: 'test', availableAt: now, createdAt: now })).rejects.toThrow();
  });
  it.each(SAFE_STAGES)('reopens and reclaims %s without duplicate events; stale fences lose authority', async (stage) => {
    const { worker, app } = await prepared();
    // Fault injection at a persisted future stage, not an execution path or public test route.
    await db.update(applications).set({ state: stage }).where(eq(applications.id, app.id));
    const lease = await claim(worker.token), input = event(lease);
    const saved = await recordWorkerEvent(db, worker.token, app.id, input, options);
    expect(saved.replayed).toBe(false);
    db.$client.close();
    db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    const replay = await recordWorkerEvent(db, worker.token, app.id, input, options);
    expect(replay).toMatchObject({ revision: saved.revision, replayed: true, lease: null });
    const restarted = await claim(worker.token);
    expect(restarted.fence).toBeGreaterThan(lease.fence);
    expect(restarted.checkpoint?.sequence).toBe(1);
    await expect(heartbeatWorker(other, worker.token, { protocolVersion: 1, lease: ref(saved.lease!) }, options))
      .rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(recordWorkerEvent(db, worker.token, app.id, { ...input, state: 'needs_answer' }, options)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(applicationEvents)).toHaveLength(1);
    await expect(db.delete(applicationEvents)).rejects.toThrow();
  });
  it('releases waiting slots and resumes only explicit bounded safe retries after backoff', async () => {
    const a = await prepared(), b = await prepared();
    const first = await claim(a.worker.token);
    const blocked = await recordWorkerEvent(db, a.worker.token, a.app.id, { ...event(first, 'retryable_failure'), reasonCode: 'fixture_unavailable' }, options);
    expect(blocked.lease).toBeNull();
    expect((await claim(b.worker.token)).applicationId).toBe(b.app.id);
    const retry = await commandApplication(db, 'alice', a.run.id, a.app.id, { ...revision(blocked.revision), action: 'retry-safe' }, options);
    expect(retry.state).toBe('screening');
    expect((await pollWorker(db, a.worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    now += 5000;
    await commandApplication(db, 'alice', b.run.id, b.app.id, { ...revision((await listRuns(db, 'alice')).applications.find((v) => v.id === b.app.id)!.revision), action: 'skip' }, options);
    expect((await claim(a.worker.token)).applicationId).toBe(a.app.id);
  });
  it.each(['expiry', 'clock-backward', 'policy-disabled', 'policy-reenabled'] as const)('invalidates heartbeat at %s and commits release before returning the error', async (reason) => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    if (reason === 'expiry') now += p.LEASE_MS;
    if (reason === 'clock-backward') now -= 1;
    if (reason === 'policy-disabled') await db.update(policyHeads).set({ enabled: false, acceptedPolicyHash: null, acceptedPolicyVersion: null, acceptedAt: null });
    if (reason === 'policy-reenabled') await db.update(policyHeads).set({ revision: 3 });
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const [row] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect(row.leaseUntil).toBeNull();
    expect(row.fence).toBeGreaterThan(lease.fence);
  });
  it('same-content policy re-enable cannot restore an old run at event, claim or resume', async () => {
    const { worker, app, run } = await prepared();
    const lease = await claim(worker.token);
    expect(lease).toMatchObject({ ownerId: 'alice', policyRevision: 1 });
    const [accepted] = await db.select().from(policyHeads).where(eq(policyHeads.ownerId, 'alice'));
    await db.update(policyHeads).set({ enabled: false, revision: 2, acceptedPolicyHash: null,
      acceptedPolicyVersion: null, acceptedAt: null }).where(eq(policyHeads.ownerId, 'alice'));
    await db.update(policyHeads).set({ ...accepted, revision: 3 }).where(eq(policyHeads.ownerId, 'alice'));
    await expect(recordWorkerEvent(db, worker.token, app.id, event(lease), options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
    expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    const paused = await commandRun(db, 'alice', run.id, { ...revision(run.revision), action: 'pause' }, options);
    await expect(commandRun(db, 'alice', run.id, { ...revision(paused.revision), action: 'resume' }, options))
      .rejects.toMatchObject({ status: 403 });
    const freshRun = await createRun(db, 'alice', { expectedRevision: 0, requestId: randomUUID(), workerId: worker.workerId }, options);
    await enqueueApplication(db, 'alice', freshRun.id, { ats: 'fixture', tenant: 'fixture', requisition: 'new-role' }, options);
    expect(await claim(worker.token)).toMatchObject({ runId: freshRun.id, policyRevision: 3 });
  });
  it('expired submitting becomes read-only unknown, never a fresh submit or retry', async () => {
    const { worker, app, run } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    now += p.LEASE_MS + 1;
    const unknown = await claim(worker.token);
    expect(unknown).toMatchObject({ state: 'submission_unknown', mode: 'reconcile' });
    await expect(recordWorkerEvent(db, worker.token, app.id, event(lease), options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(commandApplication(db, 'alice', run.id, app.id, { ...revision(unknown.revision), action: 'retry-safe' }, options)).rejects.toMatchObject({ status: 409 });
    await expect(db.update(applications).set({ state: 'queued' }).where(eq(applications.id, app.id))).rejects.toThrow();
  });
  it('hands the worker a security code the applicant entered, once and only while the form is being submitted', async () => {
    const { worker, app } = await prepared();
    await claim(worker.token);
    const take = () => takeVerificationCode(db, worker.token, app.id, { protocolVersion: p.WORKER_PROTOCOL_VERSION }, options);
    await expect(setVerificationCode(db, 'alice', app.id, { code: 'ja5oTXoY' })).rejects.toMatchObject({ status: 409 });
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    await expect(setVerificationCode(db, 'bob', app.id, { code: 'ja5oTXoY' })).rejects.toMatchObject({ status: 409 });
    await expect(setVerificationCode(db, 'alice', app.id, { code: 'ja5o TXoY' })).rejects.toThrow();
    expect(await take()).toEqual({ code: null });
    await setVerificationCode(db, 'alice', app.id, { code: 'ja5oTXoY' });
    expect(await take()).toEqual({ code: 'ja5oTXoY' });
    expect(await take()).toEqual({ code: null });
  });
  it('the applicant says an unknown submission went through: applied without an invented receipt, never re-leased', async () => {
    const { worker, app, run } = await prepared();
    await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    now += p.LEASE_MS;
    // DY's Muon Space row: re-leased read-only every cycle; the applicant answers while the worker holds that lease.
    const unknown = await claim(worker.token);
    expect(unknown).toMatchObject({ state: 'submission_unknown', mode: 'reconcile' });
    // The page loaded before this cycle re-leased it, so the revision it sends is already stale.
    const confirm = { ...revision(unknown.revision - 1), action: 'confirm-submitted' as const };
    await expect(commandApplication(db, 'bob', run.id, app.id, confirm, options)).rejects.toMatchObject({ status: 404 });
    expect(await commandApplication(db, 'alice', run.id, app.id, confirm, options))
      .toMatchObject({ state: 'submitted', reasonCode: 'applicant_confirmed_submitted' });
    for (let cycle = 0; cycle < 3; cycle++) {
      now += p.LEASE_MS;
      expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    }
    expect((await db.select().from(applications).where(eq(applications.id, app.id)))[0]).toMatchObject({ state: 'submitted', leaseUntil: null });
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(unknown) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await db.select().from(applicationReceipts)).toHaveLength(0);
    expect((await listRuns(db, 'alice', options)).applications[0]).toMatchObject({ state: 'submitted', receiptId: null });
    // A submission still in flight is the worker's to finish; only an unknown one can be confirmed.
    const inFlight = await enqueueApplication(db, 'alice', run.id, { ats: 'fixture', tenant: 'other', requisition: 'role' }, options);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, inFlight.id));
    await expect(commandApplication(db, 'alice', run.id, inFlight.id, { ...revision(inFlight.revision), action: 'confirm-submitted' }, options))
      .rejects.toMatchObject({ status: 409 });
    await expect(commandApplication(db, 'alice', run.id, inFlight.id, { ...revision(inFlight.revision), action: 'confirm-not-submitted' }, options))
      .rejects.toMatchObject({ status: 409 });
  });
  it('keeps the worker\'s reason for an unknown submission through every reconcile cycle', async () => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'filling', sequence: 3 } }).where(eq(applications.id, app.id));
    const started = await beginSubmission(db, worker.token, app.id, {
      protocolVersion: 1, intentId: app.id, fence: lease.fence, expectedRevision: lease.revision,
      identity: { ats: app.ats, tenant: app.tenant, requisition: app.requisition }, company: 'Fixture Co', role: 'Intern',
      manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)],
    }, options);
    // Greenhouse emailed a code nobody typed in: the worker says so instead of leaving 'Reconciliation deferred'.
    expect(await recordWorkerEvent(db, worker.token, app.id, {
      protocolVersion: 1, eventId: randomUUID(), fence: started.fence, expectedRevision: started.revision,
      state: 'submission_unknown', checkpoint: { stage: 'ready', sequence: 4 }, reasonCode: 'verification_code_timeout',
    }, options)).toMatchObject({ state: 'submission_unknown', lease: null });
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await claim(worker.token)).toMatchObject({ applicationId: app.id, mode: 'reconcile' });
      now += p.HEARTBEAT_MS;
      expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
      now += p.LEASE_MS;
    }
    expect((await listRuns(db, 'alice', options)).applications[0]).toMatchObject({ state: 'submission_unknown', reasonCode: 'verification_code_timeout' });
    // A receipt the worker kept (its POST failed) lands under the next reconcile lease while the row is still unknown.
    expect(await claim(worker.token)).toMatchObject({ applicationId: app.id, mode: 'reconcile' });
    expect(await recordReceipt(db, worker.token, app.id, {
      protocolVersion: 1, intentId: app.id, identity: { ats: app.ats, tenant: app.tenant, requisition: app.requisition },
      company: 'Fixture Co', role: 'Intern', receiptId: 'gh-1', submittedAt: now,
      evidence: { source: 'confirmation_page', pageUrl: 'https://job-boards.greenhouse.io/fixture/jobs/1/confirmation', observedText: 'Thank you for applying.' },
    }, options)).toMatchObject({ state: 'submitted' });
    expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
  });
  it('unknown reconciliation after stop and policy disable cannot checkpoint any state or emit a receipt', async () => {
    const { worker, app, run } = await prepared();
    await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    await commandRun(db, 'alice', run.id, { ...revision(run.revision), action: 'stop' }, options);
    await db.update(policyHeads).set({ enabled: false, revision: 2, acceptedPolicyHash: null,
      acceptedPolicyVersion: null, acceptedAt: null }).where(eq(policyHeads.ownerId, 'alice'));
    const lease = await claim(worker.token);
    expect(lease).toMatchObject({ state: 'submission_unknown', mode: 'reconcile' });
    const heartbeat = await heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(lease) }, options);
    expect(heartbeat.lease).toMatchObject({ mode: 'reconcile', fence: lease.fence, revision: lease.revision });
    for (const state of APPLICATION_STATES) {
      await expect(recordWorkerEvent(db, worker.token, app.id, {
        ...event(lease, state), checkpoint: { stage: 'ready', sequence: 1 },
      }, options)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    }
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
    expect((await db.select().from(applications).where(eq(applications.id, app.id)))[0])
      .toMatchObject({ state: 'submission_unknown', revision: lease.revision, fence: lease.fence });
  });
  it('the applicant says an unknown submission never went through: it closes with no running run to retry it, never re-leased', async () => {
    const { worker, app, run } = await prepared();
    await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    // Its run stopped and Auto Apply is off, so no run can queue it again; only the applicant's answer can close it.
    await commandRun(db, 'alice', run.id, { ...revision(run.revision), action: 'stop' }, options);
    await db.update(policyHeads).set({ enabled: false, revision: 2, acceptedPolicyHash: null,
      acceptedPolicyVersion: null, acceptedAt: null }).where(eq(policyHeads.ownerId, 'alice'));
    const unknown = await claim(worker.token);
    expect(unknown).toMatchObject({ state: 'submission_unknown', mode: 'reconcile' });
    const answer = { ...revision(unknown.revision - 1), action: 'confirm-not-submitted' as const };
    await expect(commandApplication(db, 'bob', run.id, app.id, answer, options)).rejects.toMatchObject({ status: 404 });
    expect(await commandApplication(db, 'alice', run.id, app.id, answer, options))
      .toMatchObject({ state: 'failed', reasonCode: 'applicant_confirmed_not_submitted' });
    for (let cycle = 0; cycle < 3; cycle++) {
      now += p.LEASE_MS;
      expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    }
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(unknown) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it('rejects unsupported future evidence paths and stale zero-row checkpoints', async () => {
    const { worker, app } = await prepared();
    const first = await claim(worker.token);
    const tailored = await recordWorkerEvent(db, worker.token, app.id, {
      ...event(first, 'tailoring'), checkpoint: { stage: 'tailoring', sequence: 1 },
    }, options);
    await expect(recordWorkerEvent(db, worker.token, app.id, {
      ...event(tailored.lease!, 'filling'), checkpoint: { stage: 'filling', sequence: 2 },
    }, options)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    await expect(recordWorkerEvent(db, worker.token, app.id, event(first), options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it('caps retry-safe at three, rejects unresolved-answer retries, and preserves command idempotency', async () => {
    const { worker, app, run } = await prepared();
    for (let attempt = 0; attempt <= 3; attempt++) {
      const lease = await claim(worker.token);
      const blocked = await recordWorkerEvent(db, worker.token, app.id, {
        ...event(lease, 'retryable_failure'), reasonCode: 'fixture_retry',
      }, options);
      const command = { ...revision(blocked.revision), action: 'retry-safe' as const };
      if (attempt === 3) {
        await expect(commandApplication(db, 'alice', run.id, app.id, command, options)).rejects.toMatchObject({ status: 409 });
      } else {
        const retried = await commandApplication(db, 'alice', run.id, app.id, command, options);
        expect(await commandApplication(other, 'alice', run.id, app.id, command, options)).toEqual(retried);
        now += 5000 * 2 ** attempt;
      }
    }
    const next = await prepared('alice', 'other-tenant');
    const lease = await claim(next.worker.token);
    const blocked = await recordWorkerEvent(db, next.worker.token, next.app.id, {
      ...event(lease, 'needs_answer'), reasonCode: 'required_answer',
    }, options);
    await expect(commandApplication(db, 'alice', next.run.id, next.app.id,
      { ...revision(blocked.revision), action: 'retry-safe' }, options)).rejects.toMatchObject({ status: 409 });
    // Forms parked by the removed fill/inspect gate retry from their checkpoint; real verification holds do not.
    for (const [reasonCode, allowed] of [['provider_inspect_required', true], ['captcha_required', false]] as const) {
      const parked = await prepared('alice', `parked-${reasonCode}`);
      const held = await recordWorkerEvent(db, parked.worker.token, parked.app.id, {
        ...event(await claim(parked.worker.token), 'needs_verification'), reasonCode,
      }, options);
      const retry = commandApplication(db, 'alice', parked.run.id, parked.app.id, { ...revision(held.revision), action: 'retry-safe' }, options);
      if (allowed) expect(await retry).toMatchObject({ state: 'screening' });
      else await expect(retry).rejects.toMatchObject({ status: 409 });
    }
  });
  it('submits a filled form only after the applicant approves it, and only when the policy allows submit', async () => {
    const park = async (ownerId: string, tenant: string) => {
      const parked = await prepared(ownerId, tenant);
      const held = await recordWorkerEvent(db, parked.worker.token, parked.app.id, {
        ...event(await claim(parked.worker.token), 'needs_policy_decision'), reasonCode: 'submit_approval' }, options);
      return { ...parked, approve: { ...revision(held.revision), action: 'approve-submit' as const } };
    };
    // Bob's policy does not include submit.
    const bob = await park('bob', 'approval-bob');
    await expect(commandApplication(db, 'bob', bob.run.id, bob.app.id, bob.approve, options)).rejects.toMatchObject({ status: 403 });
    const policy = { ...createEmptyPolicy(), actions: ['fill_forms', 'submit'] as ['fill_forms', 'submit'] }, hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: 'alice', version: 2, hash, policy, createdAt: now });
    await db.update(policyHeads).set({ revision: 2, policyVersion: 2, acceptedPolicyVersion: 2, acceptedPolicyHash: hash }).where(eq(policyHeads.ownerId, 'alice'));
    // Approval is only for a form the worker filled and parked for review.
    const other = await prepared('alice', 'not-parked');
    const answer = await recordWorkerEvent(db, other.worker.token, other.app.id, {
      ...event(await claim(other.worker.token), 'needs_answer'), reasonCode: 'fixture_hold' }, options);
    await expect(commandApplication(db, 'alice', other.run.id, other.app.id, { ...revision(answer.revision), action: 'approve-submit' }, options))
      .rejects.toMatchObject({ status: 409 });
    const alice = await park('alice', 'approval-alice');
    expect((await pollWorker(db, alice.worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    expect(await commandApplication(db, 'alice', alice.run.id, alice.app.id, alice.approve, options))
      .toMatchObject({ state: 'ready', reasonCode: 'submit_approved' });
    expect((await pollWorker(db, alice.worker.token, { protocolVersion: 1 }, options)).lease).toMatchObject({ applicationId: alice.app.id, state: 'ready' });
  });
  it('never submits on Retry: an approved form held for a document fills again and waits for Apply', async () => {
    const policy = { ...createEmptyPolicy(), actions: ['fill_forms', 'submit'] as ['fill_forms', 'submit'] }, hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: 'alice', version: 2, hash, policy, createdAt: now });
    await db.update(policyHeads).set({ revision: 2, policyVersion: 2, acceptedPolicyVersion: 2, acceptedPolicyHash: hash }).where(eq(policyHeads.ownerId, 'alice'));
    const { worker, run, app } = await prepared();
    const parked = await recordWorkerEvent(db, worker.token, app.id, {
      ...event(await claim(worker.token), 'needs_policy_decision'), reasonCode: SUBMIT_APPROVAL }, options);
    await commandApplication(db, 'alice', run.id, app.id, { ...revision(parked.revision), action: 'approve-submit' }, options);
    const ready = await claim(worker.token);
    expect(ready.state).toBe('ready');
    // The worker stops before the submission intent, so the row's checkpoint stays at 'ready'.
    const held = await recordWorkerEvent(db, worker.token, app.id, { ...event(ready, 'needs_document'), reasonCode: 'resume_required' }, options);
    const retried = await commandApplication(db, 'alice', run.id, app.id, { ...revision(held.revision), action: 'retry-safe' }, options);
    expect(retried.state).toBe('filling');
    now += 5000;
    const refill = await claim(worker.token);
    expect(refill).toMatchObject({ applicationId: app.id, state: 'filling' });
    // The refilled form parks for review like any other, and only a new Apply sends it.
    const again = await recordWorkerEvent(db, worker.token, app.id, { ...event(refill, 'needs_policy_decision'), reasonCode: SUBMIT_APPROVAL }, options);
    expect(await commandApplication(db, 'alice', run.id, app.id, { ...revision(again.revision), action: 'approve-submit' }, options))
      .toMatchObject({ state: 'ready', reasonCode: 'submit_approved' });
  });
  it.each([
    [['fill_forms', 'submit'] as Policy['actions'], 'refused'],
    [['fill_forms', 'submit', 'submit_without_review'] as Policy['actions'], 'ready'],
  ])('a filled form skips Apply only when the policy allows submitting without review (%j)', async (actions, outcome) => {
    const policy = { ...createEmptyPolicy(), actions }, hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: 'alice', version: 2, hash, policy, createdAt: now });
    await db.update(policyHeads).set({ revision: 2, policyVersion: 2, acceptedPolicyVersion: 2, acceptedPolicyHash: hash }).where(eq(policyHeads.ownerId, 'alice'));
    const { worker, app } = await prepared();
    await db.update(applications).set({ state: 'filling' }).where(eq(applications.id, app.id));
    const lease = await claim(worker.token);
    const sent = recordWorkerEvent(db, worker.token, app.id, { ...event(lease, 'ready'), checkpoint: { stage: 'ready', sequence: (lease.checkpoint?.sequence ?? 0) + 1 },
      reasonCode: 'form_verified', evidence: { formVerified: true } }, options);
    if (outcome === 'refused') await expect(sent).rejects.toMatchObject({ status: 403, code: 'SUBMIT_DISABLED' });
    else expect(await sent).toMatchObject({ state: 'ready' });
  });
  it('revocation commits unknown submission and permanently rejects all subsequent token operations', async () => {
    const { worker, app, run } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    const command = revision(1);
    const revoked = await revokeWorker(db, 'alice', worker.workerId, command, options);
    expect(await revokeWorker(other, 'alice', worker.workerId, command, options)).toEqual(revoked);
    const current = (await listRuns(db, 'alice')).applications.find((row) => row.id === app.id)!;
    expect(current.state).toBe('submission_unknown');
    await expect(recordWorkerEvent(db, worker.token, app.id, event(lease), options)).rejects.toMatchObject({ status: 401 });
    await expect(commandRun(db, 'alice', run.id, { ...revision(2), action: 'resume' }, options)).rejects.toMatchObject({ status: 403 });
    const replacement = await paired();
    expect((await pollWorker(db, replacement.token, { protocolVersion: 1 }, options)).lease).toBeNull();
  });
});
describe('zero-row writes cannot acknowledge authority', () => {
  it('rolls back unknown release and next claim if the durable backoff write is ignored', async () => {
    const { worker, app, run } = await prepared();
    await db.update(applications).set({ state: 'submission_unknown' }).where(eq(applications.id, app.id));
    await claim(worker.token);
    await enqueueApplication(db, 'alice', run.id, { ats: 'fixture', tenant: 'unrelated', requisition: 'runnable' }, options);
    const before = await db.select().from(applications);
    await db.run(sql.raw('CREATE TRIGGER fixture_ignore BEFORE UPDATE OF available_at ON private_application BEGIN SELECT RAISE(IGNORE); END'));
    await expect(pollWorker(db, worker.token, { protocolVersion: 1 }, options)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(applications)).toEqual(before);
  });
  it.each(['private_application', 'private_application_event'] as const)('rolls back checkpoint when %s ignores its write', async (table) => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    const before = await db.select().from(applications);
    const operation = table === 'private_application' ? 'UPDATE' : 'INSERT';
    await db.run(sql.raw(`CREATE TRIGGER fixture_ignore BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(IGNORE); END`));
    await expect(recordWorkerEvent(db, worker.token, app.id, event(lease), options)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(applications)).toEqual(before);
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
  });
  it.each(['private_worker', 'private_worker_pairing', 'private_application_run', 'private_application', 'private_worker_command'] as const)(
    'rolls back revocation when %s ignores its write', async (table) => {
      const { worker } = await prepared();
      await claim(worker.token);
      const before = [await db.select().from(workers), await db.select().from(workerPairings),
        await db.select().from(applicationRuns), await db.select().from(applications)];
      const operation = table === 'private_worker_command' ? 'INSERT' : 'UPDATE';
      await db.run(sql.raw(`CREATE TRIGGER fixture_ignore BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(IGNORE); END`));
      await expect(revokeWorker(db, 'alice', worker.workerId, revision(1), options)).rejects.toMatchObject({ status: 409 });
      expect([await db.select().from(workers), await db.select().from(workerPairings),
        await db.select().from(applicationRuns), await db.select().from(applications)]).toEqual(before);
      expect(await db.select().from(workerCommands)).toHaveLength(1); // Only run creation.
    });
});
describe('durable owner controls', () => {
  it('lists the rows bucket() shows, so long-archived rows never take the 100-row limit', async () => {
    const { app } = await prepared();
    const DAY = 86_400_000;
    const row = async (state: ApplicationState, ageDays: number) => (await db.insert(applications).values({ id: randomUUID(), ownerId: 'alice',
      runId: app.runId, workerId: app.workerId, ats: 'fixture', tenant: 'fixture', requisition: randomUUID(), state,
      availableAt: 0, createdAt: now - ageDays * DAY }).returning())[0].id;
    const [expired, archived, submitted, unknown] = [await row('failed', 44), await row('failed', 43), await row('submitted', 400), await row('submission_unknown', 400)];
    const ids = (await listRuns(db, 'alice', options)).applications.map((item) => item.id);
    expect(ids).not.toContain(expired);
    expect(ids).toEqual(expect.arrayContaining([archived, submitted, unknown]));
  });
  it('lists the row being worked, a form awaiting approval and old applied rows behind 100 newer rows', async () => {
    const { app } = await prepared();
    const row = (state: ApplicationState, ageDays: number, reasonCode: string | null = null) => ({ id: randomUUID(), ownerId: 'alice',
      runId: app.runId, workerId: app.workerId, ats: 'fixture', tenant: 'fixture', requisition: randomUUID(), state, reasonCode,
      availableAt: 0, createdAt: now - ageDays * 86_400_000 });
    const kept = [row('filling', 3), row('needs_policy_decision', 3, SUBMIT_APPROVAL), row('submitted', 90), row('submission_unknown', 90)];
    const history = Array.from({ length: 120 }, (_, i) => row((['queued', 'skipped', 'cancelled', 'failed'] as const)[i % 4], 1));
    await db.insert(applications).values([...kept, ...history]);
    const listed = p.RunListSchema.parse(await listRuns(db, 'alice', options)).applications;
    expect(listed.map((item) => item.id)).toEqual(expect.arrayContaining(kept.map((item) => item.id)));
    // Only history is capped: the newest 100 queued, skipped, cancelled or failed rows (the 120 above and the prepared one).
    expect(listed).toHaveLength(kept.length + 100);
    expect(listed.map((item) => item.createdAt)).toEqual(listed.map((item) => item.createdAt).sort((a, b) => b - a));
  });
  it('lists a row waiting in Live however old it is, so Needs action and Live both show it', async () => {
    const { app } = await prepared();
    const row = (state: ApplicationState, reasonCode: string | null) => ({ id: randomUUID(), ownerId: 'alice', runId: app.runId,
      workerId: app.workerId, ats: 'fixture', tenant: 'fixture', requisition: randomUUID(), state, reasonCode,
      availableAt: 0, createdAt: now - 60 * 86_400_000 });
    const kept = [row('needs_answer', 'question_unresolved'), row('needs_policy_decision', SUBMIT_APPROVAL), row('filling', null)];
    const gone = row('needs_document', 'resume_required');
    await db.insert(applications).values([...kept, gone]);
    const ids = (await listRuns(db, 'alice', options)).applications.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(kept.map((item) => item.id)));
    expect(ids).not.toContain(gone.id);
  });
  it('lists the row being worked and the forms waiting in Live behind 500 newer rows waiting on the applicant', async () => {
    const { app } = await prepared();
    const row = (state: ApplicationState, ageDays: number, reasonCode: string | null = null) => ({ id: randomUUID(), ownerId: 'alice',
      runId: app.runId, workerId: app.workerId, ats: 'fixture', tenant: 'fixture', requisition: randomUUID(), state, reasonCode,
      availableAt: 0, createdAt: now - ageDays * 86_400_000 });
    const kept = [row('filling', 10), row('needs_policy_decision', 9, SUBMIT_APPROVAL), row('needs_answer', 8, 'question_unresolved')];
    await db.insert(applications).values([...kept, ...Array.from({ length: 500 }, () => row('blocked_unsupported', 1))]);
    const ids = p.RunListSchema.parse(await listRuns(db, 'alice', options)).applications.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(kept.map((item) => item.id)));
  });
  it('sends a role that stops again after a retry back to the Jobs board and keeps it in Auto Apply', async () => {
    const { app } = await prepared();
    await db.update(applications).set({ state: 'needs_document', reasonCode: 'document_tailoring_unavailable' }).where(eq(applications.id, app.id));
    expect((await listRuns(db, 'alice')).applications.map((row) => row.id)).toContain(app.id);
    await db.update(applications).set({ retries: 1 }).where(eq(applications.id, app.id));
    expect((await listRuns(db, 'alice')).applications.map((row) => row.id)).toContain(app.id);
    await db.update(applications).set({ state: 'failed', reasonCode: 'restarted' }).where(eq(applications.id, app.id));
    expect((await listRuns(db, 'alice')).applications.map((row) => row.id)).not.toContain(app.id);
    await db.insert(applications).values({ id: randomUUID(), ownerId: 'alice', runId: app.runId, workerId: app.workerId,
      ats: 'ashby', tenant: 'Acme', requisition: '0F6C2C9E-1111-4222-8333-944455556666', state: 'failed', retries: 1, availableAt: 0, createdAt: 0 });
    expect(await returnedPostingUrls(db)).toEqual(['https://jobs.ashbyhq.com/acme/0f6c2c9e-1111-4222-8333-944455556666']);
  });
  it('persists pause/resume/stop with command replay, conflicts and no destructive withdrawal claims', async () => {
    const { worker, app, run } = await prepared();
    const lease = await claim(worker.token), pause = { ...revision(1), action: 'pause' as const };
    const paused = await commandRun(db, 'alice', run.id, pause, options);
    expect(await commandRun(other, 'alice', run.id, pause, options)).toEqual(paused);
    expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(commandRun(db, 'bob', run.id, { ...revision(paused.revision), action: 'resume' }, options)).rejects.toMatchObject({ status: 404 });
    const resumed = await commandRun(db, 'alice', run.id, { ...revision(paused.revision), action: 'resume' }, options);
    expect((await claim(worker.token)).applicationId).toBe(app.id);
    const stopped = await commandRun(db, 'alice', run.id, { ...revision(resumed.revision), action: 'stop' }, options);
    expect(stopped.state).toBe('stopped');
    expect((await listRuns(db, 'alice')).applications[0].state).toBe('cancelled');
    await expect(commandRun(db, 'alice', run.id, { ...revision(stopped.revision), action: 'resume' }, options)).rejects.toMatchObject({ status: 409 });
    await expect(db.delete(workerCommands)).rejects.toThrow();
  });
  it('serializes command races and preserves unknown when emergency stop races submission', async () => {
    const { worker, run, app } = await prepared();
    await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    const outcomes = await Promise.allSettled([
      commandRun(db, 'alice', run.id, { ...revision(1), action: 'emergency-stop' }, options),
      commandRun(other, 'alice', run.id, { ...revision(1), action: 'pause' }, options),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await listRuns(db, 'alice')).applications[0].state).toBe('submission_unknown');
    expect((await claim(worker.token)).mode).toBe('reconcile');
  });
});
describe('live frames', () => {
  it('lists frames only for rows in Live, newest first, under Vercel\'s 4.5 MB response cap', async () => {
    const { app } = await prepared();
    const bob = (await prepared('bob')).app;
    await db.update(applications).set({ state: 'filling' }).where(eq(applications.id, bob.id));
    const row = (state: ApplicationState, reasonCode: string | null = null, hiddenAt: number | null = null) => ({ id: randomUUID(), ownerId: 'alice',
      runId: app.runId, workerId: app.workerId, ats: 'fixture', tenant: 'fixture', requisition: randomUUID(), state, reasonCode, hiddenAt,
      availableAt: 0, createdAt: now });
    const parked = Array.from({ length: 45 }, () => row('needs_policy_decision', SUBMIT_APPROVAL));
    const asking = row('needs_answer', 'question_unresolved'), filling = row('filling');
    const left = [row('submitted'), row('cancelled'), row('needs_policy_decision', SUBMIT_APPROVAL, now)];
    const skipped = Array.from({ length: 460 }, () => row('skipped'));
    await db.insert(applications).values([...parked, asking, filling, ...left, ...skipped]);
    const image = 'A'.repeat(120_000), fields = [{ label: 'First Name', value: 'Test' }];
    const frame = (ownerId: string, applicationId: string, updatedAt: number, picture: string | null = image) =>
      ({ ownerId, applicationId, step: 'Filled. Waiting for your approval', image: picture, fields, updatedAt });
    await db.insert(applicationLive).values([...parked.map((item, i) => frame('alice', item.id, now - 60_000 - i)),
      frame('alice', asking.id, now - 30_000), frame('alice', filling.id, now - 1_000), ...left.map((item) => frame('alice', item.id, now)),
      ...skipped.map((item) => frame('alice', item.id, now, null)), frame('bob', bob.id, now)]);
    const listed = p.LiveListSchema.parse(await listLive(db, 'alice'));
    expect(JSON.stringify(listed).length).toBeLessThan(4_500_000);
    expect(listed.live.map((item) => item.applicationId).sort()).toEqual([...parked, asking, filling].map((item) => item.id).sort());
    // The form being filled is the newest frame, so it keeps its picture; every form keeps its answers for review.
    expect(listed.live[0]).toMatchObject({ applicationId: filling.id, state: 'filling', image });
    expect(listed.live.every((item) => item.fields?.length === 1)).toBe(true);
  });
  it('gives the form being filled its picture before older forms\' answers, and sends an old form still waiting', async () => {
    const { app } = await prepared();
    const row = (state: ApplicationState, reasonCode: string | null = null, createdAt = now) => ({ id: randomUUID(), ownerId: 'alice',
      runId: app.runId, workerId: app.workerId, ats: 'fixture', tenant: 'fixture', requisition: randomUUID(), state, reasonCode,
      availableAt: 0, createdAt });
    const parked = Array.from({ length: 300 }, () => row('needs_policy_decision', SUBMIT_APPROVAL));
    const filling = row('filling'), old = row('needs_policy_decision', SUBMIT_APPROVAL, now - 60 * 86_400_000);
    await db.insert(applications).values([...parked, filling, old]);
    const image = 'A'.repeat(120_000), fields = Array.from({ length: 4 }, (_, i) => ({ label: `Essay ${i}`, value: 'B'.repeat(3_500) }));
    await db.insert(applicationLive).values([
      ...parked.map((item, i) => ({ ownerId: 'alice', applicationId: item.id, step: p.PARKED_STEPS.approval, image: null, fields, updatedAt: now - 60_000 - i })),
      { ownerId: 'alice', applicationId: filling.id, step: 'Filling the form', image, fields: null, updatedAt: now - 1_000 },
      { ownerId: 'alice', applicationId: old.id, step: p.PARKED_STEPS.approval, image, fields, updatedAt: now - 120_000 }]);
    const listed = p.LiveListSchema.parse(await listLive(db, 'alice'));
    expect(JSON.stringify(listed).length).toBeLessThan(4_500_000);
    expect(listed.live[0]).toMatchObject({ applicationId: filling.id, image });
    // A form waiting on the applicant never ages out of Live or listRuns, so its card shows its frame.
    expect(listed.live.map((item) => item.applicationId)).toContain(old.id);
  });
});
describe('materials', () => {
  it('sends the answers a submitted application filled in, not those of a form still being worked or another owner\'s', async () => {
    const { app } = await prepared();
    const bob = (await prepared('bob')).app;
    await db.update(applications).set({ state: 'submitted' }).where(eq(applications.id, bob.id));
    const row = (state: ApplicationState) => ({ id: randomUUID(), ownerId: 'alice', runId: app.runId, workerId: app.workerId, ats: 'fixture',
      tenant: 'fixture', requisition: randomUUID(), state, availableAt: 0, createdAt: now });
    const sent = row('submitted'), filling = row('filling');
    await db.insert(applications).values([sent, filling]);
    const fields = [{ label: 'First Name', value: 'Test' }, { label: 'Resume/CV', value: 'resume.pdf' }];
    const frame = (ownerId: string, applicationId: string) => ({ ownerId, applicationId, step: 'Submitted', image: 'A', fields, updatedAt: now });
    await db.insert(applicationLive).values([frame('alice', sent.id), frame('alice', filling.id), frame('bob', bob.id)]);
    const listed = p.MaterialsSchema.parse(await listMaterials(db, 'alice'));
    expect(listed.materials).toEqual([{ applicationId: sent.id, resume: null, letter: null, answers: fields }]);
  });
});
describe('daily start schedule', () => {
  it('starts exactly one run per day after the start time, only with an enabled policy, and validates the schedule', async () => {
    const worker = await paired();
    const runsOf = async () => (await db.select().from(applicationRuns).where(eq(applicationRuns.workerId, worker.workerId)));
    const schedule = { ...revision(1), dailyStart: '09:00', timeZone: 'America/New_York' };
    await expect(scheduleWorker(db, 'alice', worker.workerId, { ...schedule, timeZone: 'Mars/Olympus' }, options)).rejects.toThrow();
    await expect(scheduleWorker(db, 'alice', worker.workerId, { ...schedule, dailyStart: '24:00' }, options)).rejects.toThrow();
    await expect(scheduleWorker(db, 'bob', worker.workerId, schedule, options)).rejects.toMatchObject({ status: 404 });
    await expect(scheduleWorker(db, 'alice', worker.workerId, { ...schedule, expectedRevision: 2 }, options)).rejects.toMatchObject({ status: 409 });
    const ack = await scheduleWorker(db, 'alice', worker.workerId, schedule, options);
    expect(ack).toEqual({ id: worker.workerId, revision: 2, dailyStartMinute: 540, timeZone: 'America/New_York' });
    expect(await scheduleWorker(other, 'alice', worker.workerId, schedule, options)).toEqual(ack);
    expect((await listWorkers(db, 'alice', options)).workers[0]).toMatchObject({ dailyStartMinute: 540, timeZone: 'America/New_York' });
    await expect(db.update(workers).set({ dailyStartMinute: 1440 }).where(eq(workers.id, worker.workerId))).rejects.toThrow();
    // now is 03:00 in New York; 09:00 is 14:00Z.
    await pollWorker(db, worker.token, { protocolVersion: 1 }, options);
    expect(await runsOf()).toHaveLength(0);
    now += 6 * 3_600_000;
    await Promise.all([pollWorker(db, worker.token, { protocolVersion: 1 }, options), pollWorker(other, worker.token, { protocolVersion: 1 }, options)]);
    const [first] = await runsOf();
    expect(await runsOf()).toHaveLength(1);
    expect(first).toMatchObject({ state: 'running', createdAt: now });
    // Stopped later that day: no restart until tomorrow's start.
    await commandRun(db, 'alice', first.id, { ...revision(1), action: 'stop' }, options);
    now += 3_600_000;
    await pollWorker(db, worker.token, { protocolVersion: 1 }, options);
    expect(await runsOf()).toHaveLength(1);
    now += 24 * 3_600_000;
    const [head] = await db.select().from(policyHeads).where(eq(policyHeads.ownerId, 'alice'));
    await db.update(policyHeads).set({ enabled: false, acceptedPolicyHash: null, acceptedPolicyVersion: null, acceptedAt: null }).where(eq(policyHeads.ownerId, 'alice'));
    await pollWorker(db, worker.token, { protocolVersion: 1 }, options);
    expect(await runsOf()).toHaveLength(1);
    await db.update(policyHeads).set(head).where(eq(policyHeads.ownerId, 'alice'));
    await pollWorker(db, worker.token, { protocolVersion: 1 }, options);
    expect(await runsOf()).toHaveLength(2);
    // Clearing stops the schedule; a revoked worker cannot be scheduled.
    const cleared = await scheduleWorker(db, 'alice', worker.workerId, { ...revision(2), dailyStart: null, timeZone: 'UTC' }, options);
    expect(cleared).toMatchObject({ dailyStartMinute: null, timeZone: null });
    await revokeWorker(db, 'alice', worker.workerId, revision(cleared.revision), options);
    await expect(scheduleWorker(db, 'alice', worker.workerId, { ...schedule, ...revision(cleared.revision + 1) }, options))
      .rejects.toMatchObject({ status: 403 });
  });
  it('does not start a run for a start time that passed before the schedule was saved', async () => {
    const worker = await paired();
    const poll = () => pollWorker(db, worker.token, { protocolVersion: 1 }, options);
    // 15:00 in New York: today's 09:00 already passed, so the first run is tomorrow's.
    now += 12 * 3_600_000;
    await scheduleWorker(db, 'alice', worker.workerId, { ...revision(1), dailyStart: '09:00', timeZone: 'America/New_York' }, options);
    await poll();
    expect(await db.select().from(applicationRuns)).toHaveLength(0);
    now += 18 * 3_600_000;
    await poll();
    expect(await db.select().from(applicationRuns)).toHaveLength(1);
  });
});

describe('a policy change the applicant enables', () => {
  /** The enabled policy runs start under, with what discovery selects already chosen. */
  async function startPolicy() {
    const policy: Policy = { ...createEmptyPolicy(), actions: ['read_jobs', 'fill_forms', 'submit'], destinations: ['boards.greenhouse.io'], countries: ['US'] };
    const hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: 'alice', version: 2, hash, policy, createdAt: now });
    await db.update(policyHeads).set({ revision: 2, policyVersion: 2, acceptedPolicyVersion: 2, acceptedPolicyHash: hash }).where(eq(policyHeads.ownerId, 'alice'));
  }
  /** Saves and enables a policy the way Profile does: a save turns the policy off, Enable turns it back on. */
  async function changePolicy(changes: Partial<Policy>) {
    vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
    if (!(await getProfile(db, 'alice')).revision) {
      const profile = createEmptyProfile(), confirmedAt = new Date(now).toISOString();
      for (const [key, value] of [['legalFirstName', 'Synthetic'], ['legalLastName', 'Applicant'], ['personalEmail', 'alice@example.test']] as const) {
        Object.assign(profile.identity[key], { value, state: 'confirmed', confirmedAt });
      }
      await saveProfile(db, 'alice', { ...revision(0), profile });
    }
    const current = await getPolicy(db, 'alice');
    const saved = await mutatePolicy(db, 'alice', { ...revision(current.revision), policy: { ...current.policy, ...changes } });
    return mutatePolicy(db, 'alice', { ...revision(saved.revision), action: 'enable', acceptedPolicyHash: saved.policyHash! });
  }
  const row = async (id: string) => (await db.select().from(applications).where(eq(applications.id, id)))[0];
  const runRow = async (id: string) => (await db.select().from(applicationRuns).where(eq(applicationRuns.id, id)))[0];
  const park = async (token: string, id: string) => recordWorkerEvent(db, token, id, {
    ...event(await claim(token), 'needs_policy_decision'), reasonCode: 'submit_approval' }, options);

  it('moves the running run to the new policy so its rows lease again, and ends every lease from before', async () => {
    await startPolicy();
    const { worker, run } = await prepared();
    await enqueueApplication(db, 'alice', run.id, { ats: 'fixture', tenant: 'second', requisition: 'two' }, options);
    const lease = await claim(worker.token);
    const enabled = await changePolicy({ dailyApplicationCap: 5 });
    // The run's policy matches again, so only ending the lease keeps the worker from recording, renewing or submitting with it.
    await expect(recordWorkerEvent(db, worker.token, lease.applicationId, event(lease), options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await runRow(run.id)).toMatchObject({ state: 'running', policyRevision: enabled.revision,
      policyVersion: enabled.policyVersion, policyHash: enabled.policyHash });
    expect(await claim(worker.token)).toMatchObject({ runId: run.id, policyRevision: enabled.revision });
    expect(await db.select().from(applicationRuns)).toHaveLength(1);
  });

  it('approves a parked form only on a run bound to the enabled policy, and takes approvals back when Submit is turned off', async () => {
    await startPolicy();
    const { worker, run, app } = await prepared();
    const held = await park(worker.token, app.id);
    // A run left on an older policy (stale before runs followed the policy) is refused, not stranded at 'ready'.
    await db.update(policyHeads).set({ revision: 3 }).where(eq(policyHeads.ownerId, 'alice'));
    await expect(commandApplication(db, 'alice', run.id, app.id, { ...revision(held.revision), action: 'approve-submit' }, options))
      .rejects.toMatchObject({ status: 409, code: 'POLICY_CHANGED' });
    expect(await row(app.id)).toMatchObject({ state: 'needs_policy_decision', reasonCode: 'submit_approval' });
    // Enabling the policy again carries the run forward, and the approved form leases.
    await changePolicy({ dailyApplicationCap: 5 });
    expect(await commandApplication(db, 'alice', run.id, app.id, { ...revision(held.revision), action: 'approve-submit' }, options))
      .toMatchObject({ state: 'ready', reasonCode: 'submit_approved' });
    expect(await claim(worker.token)).toMatchObject({ applicationId: app.id, state: 'ready' });
    // A policy without Submit takes the approval back; nothing is submitted until the applicant approves under one with it.
    await changePolicy({ actions: ['read_jobs', 'fill_forms'] });
    const parked = await row(app.id);
    expect(parked).toMatchObject({ state: 'needs_policy_decision', reasonCode: 'submit_approval', leaseUntil: null });
    expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    await expect(commandApplication(db, 'alice', run.id, app.id, { ...revision(parked.revision), action: 'approve-submit' }, options))
      .rejects.toMatchObject({ status: 403 });
    await changePolicy({ actions: ['read_jobs', 'fill_forms', 'submit'] });
    await commandApplication(db, 'alice', run.id, app.id, { ...revision(parked.revision), action: 'approve-submit' }, options);
    expect(await claim(worker.token)).toMatchObject({ applicationId: app.id, state: 'ready' });
  });

  it('refuses Apply on a run its revoked worker paused, since no worker can lease the approved form there', async () => {
    await startPolicy();
    const { worker, run, app } = await prepared();
    const held = await park(worker.token, app.id);
    await revokeWorker(db, 'alice', worker.workerId, revision(1), options);
    expect(await runRow(run.id)).toMatchObject({ state: 'paused' });
    await expect(commandApplication(db, 'alice', run.id, app.id, { ...revision(held.revision), action: 'approve-submit' }, options))
      .rejects.toMatchObject({ status: 409 });
    expect(await row(app.id)).toMatchObject({ state: 'needs_policy_decision', reasonCode: 'submit_approval' });
  });

  it('leases a form the applicant approved before roles that have not started', async () => {
    await startPolicy();
    const { worker, run, app } = await prepared();
    const held = await park(worker.token, app.id);
    for (const tenant of ['older-a', 'older-b', 'older-c']) {
      await enqueueApplication(db, 'alice', run.id, { ats: 'fixture', tenant, requisition: tenant }, options);
    }
    now += 1000;
    await commandApplication(db, 'alice', run.id, app.id, { ...revision(held.revision), action: 'approve-submit' }, options);
    expect(await claim(worker.token)).toMatchObject({ applicationId: app.id, state: 'ready' });
  });
});
describe('reads Turso bills per row', () => {
  /** Every statement the client sends, so the test explains the real SQL rather than a copy of it. */
  function record(target: PrivateDb) {
    const seen: { sql: string; args: never }[] = [];
    type Exec = (stmt: unknown, args?: unknown) => unknown;
    const tap = (client: { execute: Exec }) => {
      const execute = client.execute.bind(client);
      client.execute = (stmt, args) => {
        seen.push(typeof stmt === 'string' ? { sql: stmt, args: (args ?? []) as never } : stmt as { sql: string; args: never });
        return execute(stmt, args);
      };
    };
    const client = target.$client as unknown as { execute: Exec; transaction: (mode: unknown) => Promise<{ execute: Exec }> };
    tap(client);
    const transaction = client.transaction.bind(client);
    client.transaction = async (mode) => { const tx = await transaction(mode); tap(tx); return tx; };
    return seen;
  }
  it('the worker poll and the board seek private_application, never walk it', async () => {
    const policy: Policy = { ...createEmptyPolicy(), actions: ['read_jobs'], destinations: ['boards.greenhouse.io'], countries: ['US'] };
    const hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: 'alice', version: 2, hash, policy, createdAt: now });
    await db.update(policyHeads).set({ revision: 2, policyVersion: 2, acceptedPolicyVersion: 2, acceptedPolicyHash: hash }).where(eq(policyHeads.ownerId, 'alice'));
    const { worker } = await prepared();
    const seen = record(db);
    await pollWorker(db, worker.token, { protocolVersion: 1 }, options);
    await returnedPostingUrls(db);
    const plans: string[] = [];
    for (const { sql: text, args } of seen.filter(({ sql: text }) => /^\s*select\b[\s\S]*"private_application"/i.test(text))) {
      const { rows } = await other.$client.execute({ sql: `explain query plan ${text}`, args });
      plans.push(...rows.map((row) => String(row.detail)).filter((detail) => / private_application( |$)/.test(detail)));
    }
    expect(plans.join('\n')).toContain('private_application_started (owner_id=? AND started_at>? AND started_at<?)');
    expect(plans.join('\n')).toContain('USING INDEX private_application_worker_state (owner_id=? AND worker_id=? AND state=? AND available_at<?)');
    expect(plans.join('\n')).toContain('USING INDEX private_application_by_state (state=?)');
    expect(plans.filter((detail) => detail.startsWith('SCAN'))).toEqual([]);
  });
});
