import 'server-only';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import {
  applications, applicationEvents, documents, inboxReads, questionAnswers, questionInterventions,
  questions, workers, workerPairings,
} from '../private-db/schema.ts';
import { getPolicy, getProfile, hashValue } from './stores.ts';
import { checkedLease } from './leases.ts';
import { isWaitingState } from './state.ts';
import {
  appScope, credentialBinding, fail, liveRun, nowAt, one, randomUUID, replayCommand, saveCommand,
  withWorker, workerTransaction, WorkerError, type ApplicationRow, type WorkerOptions, type WorkerTx,
} from './worker-store.ts';
import {
  AnswerBatchSchema, AnswerCommandSchema, FocusCommandSchema, InboxQuerySchema, QuestionBatchSchema, QuestionDetailSchema,
  ReadCommandSchema, InterventionAckSchema, validQuestionAnswer,
  type AnswerBatch, type AnswerCommand, type AnswerResult, type AnswerValue, type FocusCommand, type FocusResult,
  type InboxPage, type InboxStatus, type QuestionBatch, type QuestionBatchResult, type QuestionDescriptor,
  type QuestionDetail, type ReadCommand, type InterventionAck, type InterventionPage,
} from './question-protocol.ts';

type QuestionRow = typeof questions.$inferSelect;
type AnswerRow = typeof questionAnswers.$inferSelect;
type Context = Awaited<ReturnType<typeof context>>;
const INTERVENTION_PAGE_BYTES = 120 * 1024;
const qScope = (ownerId: string, id: string) => and(eq(questions.ownerId, ownerId), eq(questions.id, id));
const unsent = ['queued', 'screening', 'tailoring', 'filling', 'ready', 'needs_answer', 'needs_document',
  'needs_policy_decision', 'needs_login', 'needs_verification', 'provider_unavailable'];

async function context(tx: WorkerTx, ownerId: string, options: WorkerOptions) {
  const now = nowAt(options), profile = await getProfile(tx, ownerId), policy = await getPolicy(tx, ownerId, now);
  const facts = new Map<string, number>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if ('state' in item) {
      if (typeof item.id === 'string' && typeof item.version === 'number') facts.set(item.id, item.version);
      return;
    }
    Object.values(item).forEach(visit);
  }
  visit(profile.profile);
  return { ownerId, now, profile, policy, facts, options };
}
function factVersions(q: QuestionDescriptor, ctx: Context) {
  return [...q.factIds].sort().map(id => ({ id, version: ctx.facts.get(id) ?? 0 }));
}
function semanticHash(q: QuestionDescriptor) {
  // Transport tenant is not an applicant/country fact. Employer and application scopes retain it.
  const scope = { ...q.scope, tenant: ['applicant', 'country'].includes(q.scope.kind) ? null : q.scope.tenant };
  return hashValue({ wording: q.originalWording, meaning: q.meaning.id, kind: q.kind, required: q.required,
    schemaVersion: q.schemaVersion, field: q.field, scope, sensitive: q.sensitive, factIds: [...q.factIds].sort() });
}
function currentTimeframe(q: QuestionDescriptor, now: number) {
  const { timeframe, validFrom, validUntil } = q.scope, today = new Date(now).toISOString().slice(0, 10);
  if (timeframe === 'historical' || timeframe === 'ever') return true;
  const expired = validUntil && today.slice(0, validUntil.value.length) > validUntil.value;
  const notStarted = timeframe === 'current' && validFrom && today.slice(0, validFrom.value.length) < validFrom.value;
  return !expired && !notStarted;
}
function currentDescriptor(row: QuestionRow, ctx: Context) {
  const facts = factVersions(row.descriptor, ctx);
  return row.active && row.policyRevision === ctx.policy.revision && facts.every(f => f.version > 0) &&
    row.scopeHash === hashValue(row.descriptor.scope) && row.semanticHash === semanticHash(row.descriptor) &&
    currentTimeframe(row.descriptor, ctx.now);
}
// Fact versions pin the facts an answer depends on. The profile revision is not compared: any unrelated
// profile save used to reopen every answered question and strand applications with none left in the inbox.
function fresh(row: QuestionRow, ctx: Context) {
  return currentDescriptor(row, ctx) && hashValue(factVersions(row.descriptor, ctx)) === hashValue(row.factVersions);
}
async function workerAvailable(tx: WorkerTx, app: ApplicationRow, ctx: Context) {
  const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ctx.ownerId), eq(workers.id, app.workerId)));
  if (!worker || worker.revokedAt !== null) return false;
  const [pairing] = await tx.select().from(workerPairings).where(and(
    eq(workerPairings.ownerId, ctx.ownerId), eq(workerPairings.id, worker.pairingId),
  ));
  if (!pairing || pairing.revokedAt !== null) return false;
  const binding = await credentialBinding(tx, ctx.ownerId);
  return binding !== null && worker.credentialBinding === binding && pairing.credentialBinding === binding;
}
async function eligible(tx: WorkerTx, app: ApplicationRow, ctx: Context) {
  if (isWaitingState(app.state) && app.reasonCode === 'run_paused') {
    // Pause replaces reasonCode; recover the blocker authority from immutable revisioned events.
    const [last] = await tx.select({ ack: applicationEvents.acknowledgement }).from(applicationEvents).where(and(
      eq(applicationEvents.ownerId, ctx.ownerId), eq(applicationEvents.applicationId, app.id),
      sql`(json_extract(${applicationEvents.acknowledgement}, '$.questionIds') is not null
        or json_extract(${applicationEvents.acknowledgement}, '$.state') is not null)`,
    )).orderBy(desc(sql`json_extract(${applicationEvents.acknowledgement}, '$.revision')`)).limit(1);
    if (!last || !Array.isArray((last.ack as { questionIds?: unknown }).questionIds)) return false;
  }
  return app.ownerId === ctx.ownerId && unsent.includes(app.state) && ctx.policy.enabled &&
    (!isWaitingState(app.state) || app.reasonCode === 'question_unresolved' || app.reasonCode === 'run_paused') &&
    await liveRun(tx, app, ctx.now) && await workerAvailable(tx, app, ctx);
}
const documentPermission = (kind: typeof documents.$inferSelect['kind']) =>
  kind === 'resume_master' || kind === 'resume_source' || kind === 'resume_artifact' ? 'resume' :
    kind === 'portfolio' || kind === 'artwork' ? 'portfolio' : kind === 'supporting' ? null : kind;
function permitted(q: QuestionDescriptor, ctx: Context) {
  if (!ctx.policy.policy.actions.includes('fill_forms') || q.field.type === 'intervention') return false;
  if (q.field.type === 'document') return q.field.documentKinds.some(kind => {
    const permission = documentPermission(kind);
    return permission !== null && ctx.policy.policy.documentKinds.includes(permission);
  });
  return true;
}
const allowOptional = (q: QuestionDescriptor, ctx: Context) =>
  !q.sensitive || ctx.policy.policy.disclosure === 'confirmed_only';
async function canAnswer(tx: WorkerTx, row: QuestionRow, app: ApplicationRow, ctx: Context, isEligible = () => eligible(tx, app, ctx)) {
  return currentDescriptor(row, ctx) && permitted(row.descriptor, ctx) && await isEligible();
}
async function ownedQuestion(tx: WorkerTx, ownerId: string, id: string) {
  const [row] = await tx.select().from(questions).where(qScope(ownerId, id));
  if (!row) fail(404, 'NOT_FOUND', 'Question not found.');
  const [app] = await tx.select().from(applications).where(appScope(ownerId, row.applicationId));
  if (!app) fail(404, 'NOT_FOUND', 'Question not found.');
  return { row, app };
}
// An answer belongs to the one application it was given for; answers are never saved for other applications.
const sameApplication = (answer: Pick<AnswerRow, 'reuse' | 'applicationId'>, row: QuestionRow) =>
  answer.reuse === 'application' && answer.applicationId === row.applicationId;
// A retry is a new attempt of the same role: the same question asked there reuses the answer given to an earlier attempt.
const roleHash = (q: QuestionDescriptor) => semanticHash({ ...q, scope: { ...q.scope, applicationId: null } });
export async function attemptIds(tx: WorkerTx, app: ApplicationRow) {
  const ids = [app.id];
  for (let previous = app.previousApplicationId; previous && ids.length < 50;) {
    const [row] = await tx.select().from(applications).where(appScope(app.ownerId, previous));
    if (!row || row.ats !== app.ats || row.tenant !== app.tenant || row.requisition !== app.requisition) break;
    ids.push(row.id); previous = row.previousApplicationId;
  }
  return ids;
}
async function answerValid(tx: WorkerTx, row: QuestionRow, value: AnswerValue, ctx: Context) {
  if (!validQuestionAnswer(row.descriptor, value, allowOptional(row.descriptor, ctx))) return false;
  if (value.type !== 'document') return true;
  const field = row.descriptor.field;
  if (field.type !== 'document') return false;
  const [document] = await tx.select().from(documents).where(and(
    eq(documents.ownerId, ctx.ownerId), eq(documents.id, value.documentId), eq(documents.version, value.version),
    eq(documents.sha256, value.sha256), eq(documents.state, 'available'), eq(documents.safetyCheck, 'passed'),
  ));
  if (!document) return false;
  const permission = documentPermission(document.kind);
  const fieldKinds = document.kind === 'resume_artifact' ? ['resume_master', 'resume_source'] : [document.kind];
  return permission !== null && ctx.policy.policy.documentKinds.includes(permission) &&
    fieldKinds.some((kind) => field.documentKinds.includes(kind as typeof field.documentKinds[number])) &&
    field.mimeTypes.includes(document.mime as typeof field.mimeTypes[number]) &&
    document.size <= field.maxBytes;
}
const focusResult = (row: typeof questionInterventions.$inferSelect): FocusResult => ({
  id: row.id, questionId: row.questionId, applicationId: row.applicationId, workerId: row.workerId,
  revision: row.revision, status: row.status, reason: row.reason,
});

type Intervention = typeof questionInterventions.$inferSelect;
async function detail(tx: WorkerTx, row: QuestionRow, app: ApplicationRow, ctx: Context,
  known?: { eligible: () => Promise<boolean>; focus: Intervention | undefined }): Promise<QuestionDetail> {
  const available = await canAnswer(tx, row, app, ctx, known?.eligible);
  const focus = known ? known.focus : (await tx.select().from(questionInterventions).where(and(
    eq(questionInterventions.ownerId, ctx.ownerId), eq(questionInterventions.questionId, row.id),
  )).orderBy(desc(questionInterventions.createdAt), desc(questionInterventions.id)).limit(1))[0];
  const waiting = row.resolvedAt === null && fresh(row, ctx) && (unsent.includes(app.state) || isWaitingState(app.state));
  return QuestionDetailSchema.parse({
    id: row.id, ownerId: ctx.ownerId, revision: row.revision,
    descriptor: { ...row.descriptor, meaning: { ...row.descriptor.meaning, reviewId: null } },
    application: { id: app.id, workerId: app.workerId, ats: app.ats, tenant: app.tenant, requisition: app.requisition,
      company: row.company, role: row.role },
    waitingCount: Number(waiting), resolved: row.resolvedAt !== null, expectedProfileRevision: ctx.profile.revision,
    expectedPolicyRevision: ctx.policy.revision || row.policyRevision, expectedScopeHash: row.scopeHash,
    factVersions: factVersions(row.descriptor, ctx).filter(f => f.version > 0),
    allowedReuse: available ? ['application'] : [],
    canAnswer: available, canBlank: available && !row.descriptor.required && row.descriptor.field.allowBlank && allowOptional(row.descriptor, ctx),
    canDecline: available && row.descriptor.field.declineValue !== null && allowOptional(row.descriptor, ctx),
    focus: focus ? focusResult(focus) : null,
  });
}
export async function getQuestion(db: PrivateDb, ownerId: string, id: string, options: WorkerOptions = {}): Promise<QuestionDetail> {
  return workerTransaction(db, async tx => {
    const { row, app } = await ownedQuestion(tx, ownerId, id);
    return detail(tx, row, app, await context(tx, ownerId, options));
  });
}

async function notify(tx: WorkerTx, app: ApplicationRow, kind: string, questionId: string | null, now: number) {
  const acknowledgement = { kind, questionId };
  one(await tx.insert(applicationEvents).values({ ownerId: app.ownerId, applicationId: app.id, eventId: randomUUID(),
    requestHash: hashValue(acknowledgement), acknowledgement, createdAt: now }).returning({ eventId: applicationEvents.eventId }));
}
// Batch and ordinary checkpoint acknowledgements are not notifications. Terminal receipts stay questionless.
const notification = sql`(json_extract(${applicationEvents.acknowledgement}, '$.kind') is not null
  or json_extract(${applicationEvents.acknowledgement}, '$.state') in ('submitted','failed'))`;
const readJoin = and(eq(inboxReads.ownerId, applicationEvents.ownerId),
  eq(inboxReads.applicationId, applicationEvents.applicationId), eq(inboxReads.eventId, applicationEvents.eventId));
async function inboxStatus(tx: WorkerTx, ownerId: string, now: number): Promise<InboxStatus> {
  const [unread] = await tx.select({ count: sql<number>`count(*)` }).from(applicationEvents)
    .leftJoin(inboxReads, readJoin).where(and(eq(applicationEvents.ownerId, ownerId), notification, isNull(inboxReads.eventId)));
  const [unresolved] = await tx.select({ count: sql<number>`count(*)`, applications: sql<number>`count(distinct ${questions.applicationId})` })
    .from(questions).innerJoin(applications, and(eq(applications.ownerId, questions.ownerId), eq(applications.id, questions.applicationId)))
    .where(and(eq(questions.ownerId, ownerId), eq(questions.active, true), isNull(questions.resolvedAt),
      inArray(applications.state, [...unsent, 'retryable_failure', 'blocked_unsupported'] as ApplicationRow['state'][])));
  return { ownerId, unread: unread.count, unresolved: unresolved.count, waitingApplications: unresolved.applications, serverTime: now };
}
export async function getInboxStatus(db: PrivateDb, ownerId: string, options: WorkerOptions = {}): Promise<InboxStatus> {
  return workerTransaction(db, tx => inboxStatus(tx, ownerId, nowAt(options)));
}
export async function getInbox(
  db: PrivateDb, ownerId: string, input: { limit?: number; cursor?: string; applicationId?: string } = {}, options: WorkerOptions = {},
): Promise<InboxPage> {
  const query = InboxQuerySchema.parse(input);
  return workerTransaction(db, async tx => {
    const ctx = await context(tx, ownerId, options);
    let cursor: typeof applicationEvents.$inferSelect | undefined;
    if (query.cursor) {
      const rows = await tx.select().from(applicationEvents).where(and(
        eq(applicationEvents.ownerId, ownerId), eq(applicationEvents.eventId, query.cursor), notification,
      ));
      if (!rows.length) fail(404, 'NOT_FOUND', 'Inbox cursor not found.');
      cursor = one(rows);
    }
    const rows = await tx.select({ event: applicationEvents, read: inboxReads.eventId }).from(applicationEvents)
      .leftJoin(inboxReads, readJoin).where(and(eq(applicationEvents.ownerId, ownerId), notification,
        query.applicationId ? eq(applicationEvents.applicationId, query.applicationId) : undefined,
        cursor && sql`(${applicationEvents.createdAt}, ${applicationEvents.eventId}, ${applicationEvents.applicationId})
          < (${cursor.createdAt}, ${cursor.eventId}, ${cursor.applicationId})`))
      .orderBy(desc(applicationEvents.createdAt), desc(applicationEvents.eventId), desc(applicationEvents.applicationId)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    // Each statement is a round trip to the hosted database, so the page's questions, applications and focus
    // requests are read once each, and each application's eligibility is checked once, not per notification.
    const ids = [...new Set(page.flatMap(({ event }) => (event.acknowledgement as { questionId?: string }).questionId ?? []))];
    const found = ids.length ? await tx.select().from(questions).where(and(eq(questions.ownerId, ownerId), inArray(questions.id, ids))) : [];
    const appIds = [...new Set(found.map(row => row.applicationId))];
    const apps = new Map((appIds.length ? await tx.select().from(applications)
      .where(and(eq(applications.ownerId, ownerId), inArray(applications.id, appIds))) : []).map(app => [app.id, app]));
    const focus = new Map<string, Intervention>();
    for (const row of ids.length ? await tx.select().from(questionInterventions)
      .where(and(eq(questionInterventions.ownerId, ownerId), inArray(questionInterventions.questionId, ids)))
      .orderBy(desc(questionInterventions.createdAt), desc(questionInterventions.id)) : []) {
      if (!focus.has(row.questionId)) focus.set(row.questionId, row);
    }
    const byId = new Map(found.map(row => [row.id, row])), checks = new Map<string, Promise<boolean>>();
    const items: InboxPage['items'] = [];
    for (const { event, read } of page) {
      const ack = event.acknowledgement as { kind?: string; state?: string; questionId?: string };
      let question: QuestionDetail | null = null;
      if (ack.questionId) {
        const row = byId.get(ack.questionId), app = row && apps.get(row.applicationId);
        if (!row || !app) fail(404, 'NOT_FOUND', 'Question not found.');
        if (app.id !== event.applicationId) fail();
        const once = () => checks.get(app.id) ?? checks.set(app.id, eligible(tx, app, ctx)).get(app.id)!;
        question = await detail(tx, row, app, ctx, { eligible: once, focus: focus.get(row.id) });
      }
      items.push({ eventId: event.eventId, applicationId: event.applicationId, kind: ack.kind ?? ack.state!,
        createdAt: event.createdAt, read: read !== null, question });
    }
    return { ...await inboxStatus(tx, ownerId, ctx.now), items,
      nextCursor: rows.length > query.limit ? items[items.length - 1].eventId : null };
  });
}
export async function markInboxRead(db: PrivateDb, ownerId: string, input: ReadCommand): Promise<{ ownerId: string; eventIds: string[] }> {
  const command = ReadCommandSchema.parse(input);
  return workerTransaction(db, async tx => {
    for (const eventId of new Set(command.eventIds)) {
      const rows = await tx.select().from(applicationEvents).where(and(
        eq(applicationEvents.ownerId, ownerId), eq(applicationEvents.eventId, eventId), notification,
      ));
      if (!rows.length) fail(404, 'NOT_FOUND', 'Notification not found.');
      const event = one(rows);
      await tx.insert(inboxReads).values({ ownerId, applicationId: event.applicationId, eventId, readAt: Date.now() }).onConflictDoNothing();
      const [receipt] = await tx.select().from(inboxReads).where(and(eq(inboxReads.ownerId, ownerId),
        eq(inboxReads.applicationId, event.applicationId), eq(inboxReads.eventId, eventId)));
      if (!receipt) fail();
    }
    return { ownerId, eventIds: command.eventIds };
  });
}

async function reschedule(tx: WorkerTx, app: ApplicationRow, ctx: Context): Promise<boolean> {
  if (!await eligible(tx, app, ctx)) fail();
  const rows = await tx.select().from(questions).where(and(eq(questions.ownerId, ctx.ownerId),
    eq(questions.applicationId, app.id), eq(questions.active, true))).orderBy(questions.createdAt, questions.id);
  const blocker = rows.find(q => q.resolvedAt === null || !fresh(q, ctx));
  const state = blocker ? (blocker.descriptor.kind === 'failed' ? 'blocked_unsupported' :
    blocker.resolvedAt !== null ? 'needs_answer' : blocker.descriptor.kind) : 'screening';
  const updated = one(await tx.update(applications).set({ state, revision: app.revision + 1, fence: app.fence + 1,
    leaseUntil: null, leaseCheckedAt: null, checkpoint: { stage: 'screening', sequence: (app.checkpoint?.sequence ?? 0) + 1 },
    reasonCode: blocker ? 'question_unresolved' : null, availableAt: ctx.now,
  }).where(and(appScope(ctx.ownerId, app.id), eq(applications.revision, app.revision), eq(applications.fence, app.fence))).returning());
  if (!blocker) await notify(tx, updated, 'question_resumed', null, ctx.now);
  return !blocker;
}

export async function answerQuestion(db: PrivateDb, ownerId: string, id: string, input: AnswerCommand, options: WorkerOptions = {}): Promise<AnswerResult> {
  const command = AnswerCommandSchema.parse(input);
  return workerTransaction(db, tx => answerIn(tx, ownerId, id, command, options));
}

/** One transaction for a whole form, so a rejected answer saves none and one request counts once against the rate limit. */
export async function answerQuestions(db: PrivateDb, ownerId: string, input: AnswerBatch, options: WorkerOptions = {}) {
  const batch = AnswerBatchSchema.parse(input);
  if (new Set(batch.answers.map(item => item.questionId)).size !== batch.answers.length) fail(400, 'INVALID_INPUT', 'Each question is answered once.');
  return workerTransaction(db, async tx => {
    const results: AnswerResult[] = [];
    for (const { questionId, command } of batch.answers) results.push(await answerIn(tx, ownerId, questionId, command, options));
    return { ownerId, results };
  });
}

async function answerIn(tx: WorkerTx, ownerId: string, id: string, command: AnswerCommand, options: WorkerOptions): Promise<AnswerResult> {
  const scope = `question:answer:${id}`;
  const { row, app } = await ownedQuestion(tx, ownerId, id);
  const replay = await replayCommand<AnswerResult>(tx, ownerId, scope, command);
  if (replay) return { ...replay, replayed: true };
  const ctx = await context(tx, ownerId, options), facts = factVersions(row.descriptor, ctx);
  if (command.expectedRevision !== row.revision || command.expectedProfileRevision !== ctx.profile.revision ||
      command.expectedPolicyRevision !== ctx.policy.revision || command.expectedScopeHash !== row.scopeHash ||
      hashValue(command.factVersions) !== hashValue(facts) || !await canAnswer(tx, row, app, ctx) ||
      command.reuse !== 'application' || !await answerValid(tx, row, command.answer, ctx)) fail();
  const answer = one(await tx.insert(questionAnswers).values({
    id: randomUUID(), ownerId, applicationId: app.id, questionId: row.id, semanticHash: row.semanticHash, scopeHash: row.scopeHash,
    meaningReviewId: null, profileRevision: ctx.profile.revision, policyRevision: ctx.policy.revision,
    factVersions: facts, reuse: command.reuse, value: command.answer, descriptor: row.descriptor,
    provenance: { source: 'user', confirmedAt: ctx.now }, createdAt: ctx.now,
  }).returning());
  const candidates = await tx.select({ question: questions, app: applications }).from(questions)
    .innerJoin(applications, and(eq(applications.ownerId, questions.ownerId), eq(applications.id, questions.applicationId)))
    .where(and(eq(questions.ownerId, ownerId), eq(questions.semanticHash, row.semanticHash), eq(questions.active, true)))
    .orderBy(questions.createdAt, questions.id);
  const resolvedQuestionIds: string[] = [], changedApps = new Map<string, ApplicationRow>();
  for (const candidate of candidates) {
    if (!sameApplication(answer, candidate.question) || !await canAnswer(tx, candidate.question, candidate.app, ctx)) continue;
    one(await tx.update(questions).set({ answerId: answer.id, resolvedAt: ctx.now, revision: candidate.question.revision + 1,
      profileRevision: ctx.profile.revision, factVersions: facts })
      .where(and(qScope(ownerId, candidate.question.id), eq(questions.revision, candidate.question.revision))).returning());
    resolvedQuestionIds.push(candidate.question.id); changedApps.set(candidate.app.id, candidate.app);
  }
  if (!resolvedQuestionIds.includes(id)) fail();
  const resumedApplicationIds: string[] = [];
  for (const app of changedApps.values()) if (await reschedule(tx, app, ctx)) resumedApplicationIds.push(app.id);
  const result: AnswerResult = { ownerId, answerId: answer.id, questionId: id, resolvedQuestionIds, resumedApplicationIds, replayed: false };
  await saveCommand(tx, ownerId, scope, command, result, ctx.now);
  return result;
}

/**
 * A run carried to a newly enabled policy keeps each answered question that policy still allows: it moves to the new
 * revision, so the application context still passes its answer and Apply submits the form the applicant reviewed. Every
 * other active question closes, its answer staying bound to the policy it was given under. Returns the applications that
 * lost one.
 */
export async function carryQuestions(tx: WorkerTx, ownerId: string, applicationIds: string[], now: number) {
  const lost = new Set<string>(), kept: string[] = [], closed: string[] = [];
  if (!applicationIds.length) return lost;
  const ctx = await context(tx, ownerId, { now: () => now });
  for (const { question, answer } of await tx.select({ question: questions, answer: questionAnswers }).from(questions)
    .leftJoin(questionAnswers, and(eq(questionAnswers.ownerId, questions.ownerId), eq(questionAnswers.id, questions.answerId)))
    .where(and(eq(questions.ownerId, ownerId), inArray(questions.applicationId, applicationIds), eq(questions.active, true)))) {
    const moved = { ...question, policyRevision: ctx.policy.revision }, q = question.descriptor;
    // What lets the question be answered, and its answer (or blank) be given, under the new policy.
    const keep = question.resolvedAt !== null && fresh(moved, ctx) && permitted(q, ctx) && (answer
      ? await answerValid(tx, moved, answer.value, ctx)
      : !q.required && (q.field.allowBlank || q.field.declineValue !== null) && allowOptional(q, ctx));
    (keep ? kept : closed).push(question.id);
    if (!keep) lost.add(question.applicationId);
  }
  const ids = (list: string[]) => and(eq(questions.ownerId, ownerId), inArray(questions.id, list));
  if (kept.length) await tx.update(questions).set({ policyRevision: ctx.policy.revision, revision: sql`${questions.revision} + 1` }).where(ids(kept));
  if (closed.length) await tx.update(questions).set({ active: false, revision: sql`${questions.revision} + 1` }).where(ids(closed));
  return lost;
}

const wording = (q: QuestionDescriptor) => q.originalWording.toLowerCase().replace(/\s+/g, ' ').replace(/[\s*:?.]+$/, '').trim();
/**
 * A form question worded like one the applicant already answered on another application takes that answer, so
 * "Are you 18 or older?" is asked once. Only choices, dates, numbers and short text carry over: an essay is never
 * sent to a second employer unseen. A question naming its employer only matches that employer's forms.
 */
// "Have you worked here before?" or "Are you related to an employee?" is true of one employer, not the next.
const employerFact = /\b(before|previously|prior|ever|relatives?|related|family)\b/;
export const equivalentAnswer = (q: QuestionDescriptor, answer: Pick<AnswerRow, 'descriptor' | 'value'>) =>
  q.key.startsWith('form-') && answer.descriptor.key.startsWith('form-') && q.kind === 'needs_answer' && !employerFact.test(wording(q)) &&
  answer.descriptor.field.type === q.field.type && q.field.type !== 'textarea' && wording(answer.descriptor) === wording(q) &&
  answer.value.type !== 'document' && (answer.value.type !== 'text' || answer.value.value.trim().length <= 60);
// One read of the applicant's answers per question batch, newest first.
const ANSWER_LOOKBACK = 1000;
type Answers = () => Promise<AnswerRow[]>;
async function reusableAnswer(tx: WorkerTx, row: QuestionRow, app: ApplicationRow, ctx: Context, owned: Answers) {
  if (!fresh(row, ctx) || !await canAnswer(tx, row, app, ctx)) return;
  // rowid breaks same-millisecond ties by committed insertion order, not random UUID order.
  const answers = await tx.select().from(questionAnswers).where(and(eq(questionAnswers.ownerId, ctx.ownerId),
    inArray(questionAnswers.applicationId, await attemptIds(tx, app)))).orderBy(desc(sql`rowid`));
  const hash = roleHash(row.descriptor);
  const earlier = answers.find(answer => answer.reuse === 'application' && roleHash(answer.descriptor) === hash);
  if (earlier) return earlier.policyRevision === ctx.policy.revision && hashValue(earlier.factVersions) === hashValue(row.factVersions) &&
    await answerValid(tx, row, earlier.value, ctx) ? earlier : undefined;
  // Form answers are sensitive: another form takes one only when the policy sends confirmed answers without asking each time.
  if (!row.key.startsWith('form-') || ctx.policy.policy.disclosure !== 'confirmed_only') return;
  for (const answer of await owned()) {
    if (equivalentAnswer(row.descriptor, answer) && hashValue(answer.factVersions) === hashValue(row.factVersions) &&
        await answerValid(tx, row, answer.value, ctx)) return answer;
  }
}

export async function registerQuestionBatch(
  db: PrivateDb, token: string, applicationId: string, input: QuestionBatch, options: WorkerOptions = {},
): Promise<QuestionBatchResult> {
  const command = QuestionBatchSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(command)) > 128 * 1024) fail(413, 'INVALID_INPUT', 'Question batch is too large.');
  return withWorker<QuestionBatchResult>(db, token, options, async (tx, worker, now) => {
    const [owned] = await tx.select().from(applications).where(and(appScope(worker.ownerId, applicationId), eq(applications.workerId, worker.id)));
    if (!owned) fail(404, 'NOT_FOUND', 'Application not found.');
    const requestHash = hashValue(['question:batch', command]);
    const [previous] = await tx.select().from(applicationEvents).where(and(eq(applicationEvents.ownerId, worker.ownerId),
      eq(applicationEvents.applicationId, applicationId), eq(applicationEvents.eventId, command.eventId)));
    if (previous) {
      if (previous.requestHash !== requestHash) fail();
      return { ...previous.acknowledgement as QuestionBatchResult, replayed: true, lease: null };
    }
    const app = await checkedLease(tx, worker, { applicationId, expectedRevision: command.expectedRevision, fence: command.fence }, now);
    if (app instanceof WorkerError) return app;
    if (!['screening', 'tailoring', 'filling', 'ready'].includes(app.state) ||
        command.checkpoint.stage !== app.state || command.checkpoint.sequence !== (app.checkpoint?.sequence ?? 0) + 1) fail();
    const ctx = await context(tx, worker.ownerId, options);
    if (command.expectedProfileRevision !== ctx.profile.revision) fail();
    const questionIds: string[] = [];
    let loaded: Promise<AnswerRow[]> | undefined;
    const priorAnswers: Answers = () => loaded ??= tx.select().from(questionAnswers).where(eq(questionAnswers.ownerId, worker.ownerId))
      .orderBy(desc(sql`rowid`)).limit(ANSWER_LOOKBACK);
    for (const descriptor of command.questions) {
      const facts = factVersions(descriptor, ctx), semantic = semanticHash(descriptor);
      if (descriptor.scope.ats !== app.ats || descriptor.scope.tenant !== app.tenant ||
          (descriptor.scope.applicationId !== null && descriptor.scope.applicationId !== app.id) ||
          facts.some(f => f.version === 0)) fail();
      if (descriptor.meaning.reviewId) fail();
      const values = {
        descriptor: { ...descriptor, meaning: { ...descriptor.meaning, reviewId: null } },
        company: command.company, role: command.role, semanticHash: semantic, scopeHash: hashValue(descriptor.scope),
        profileRevision: ctx.profile.revision, policyRevision: ctx.policy.revision, factVersions: facts,
      };
      if (Buffer.byteLength(JSON.stringify(values.descriptor)) > 64 * 1024)
        fail(413, 'INVALID_INPUT', 'Question descriptor exceeds its stored byte limit.');
      const [old] = await tx.select().from(questions).where(and(eq(questions.ownerId, worker.ownerId),
        eq(questions.applicationId, applicationId), eq(questions.key, descriptor.key)));
      const changed = !old || old.semanticHash !== semantic || old.scopeHash !== values.scopeHash || !fresh(old, ctx);
      // The worker asks an answered question again only when the form rejected that answer. Resuming would
      // loop (fill, ask, auto-resolve, fill); reopen it in the inbox for a new answer instead.
      const rejected = !!old && !changed && old.resolvedAt !== null;
      let row: QuestionRow;
      if (old && !changed && !rejected) row = old;
      else if (old) row = one(await tx.update(questions).set({ ...values, active: true, answerId: null, resolvedAt: null, revision: old.revision + 1 })
        .where(and(qScope(worker.ownerId, old.id), eq(questions.revision, old.revision))).returning());
      else row = one(await tx.insert(questions).values({ ...values, id: randomUUID(), ownerId: worker.ownerId,
        applicationId, key: descriptor.key, createdAt: now }).returning());
      const reusable = rejected ? undefined : await reusableAnswer(tx, row, app, ctx, priorAnswers);
      const optional = !rejected && !descriptor.required && (descriptor.field.allowBlank || descriptor.field.declineValue !== null) &&
        allowOptional(descriptor, ctx) && await canAnswer(tx, row, app, ctx);
      if (reusable || optional) {
        if (row.resolvedAt === null || (reusable && row.answerId !== reusable.id))
          row = one(await tx.update(questions).set({ answerId: reusable?.id ?? null, resolvedAt: now, revision: row.revision + 1 })
            .where(and(qScope(worker.ownerId, row.id), eq(questions.revision, row.revision))).returning());
      }
      if (row.resolvedAt === null && (changed || rejected)) await notify(tx, app, descriptor.kind, row.id, now);
      questionIds.push(row.id);
    }
    // Omitted fields remain active. A partial batch cannot silently erase another blocker.
    const rows = await tx.select().from(questions).where(and(eq(questions.ownerId, worker.ownerId),
      eq(questions.applicationId, applicationId), eq(questions.active, true))).orderBy(questions.createdAt, questions.id);
    const blocker = rows.find(q => q.resolvedAt === null || !fresh(q, ctx));
    const state = blocker ? (blocker.descriptor.kind === 'failed' ? 'blocked_unsupported' :
      blocker.resolvedAt !== null ? 'needs_answer' : blocker.descriptor.kind) : 'screening';
    const updated = one(await tx.update(applications).set({ state, revision: app.revision + 1, fence: app.fence + 1,
      leaseUntil: null, leaseCheckedAt: null, checkpoint: blocker ? command.checkpoint : { ...command.checkpoint, stage: 'screening' },
      reasonCode: blocker ? 'question_unresolved' : null, availableAt: now,
    }).where(and(appScope(worker.ownerId, applicationId), eq(applications.revision, app.revision), eq(applications.fence, app.fence))).returning());
    const result: QuestionBatchResult = { applicationId, eventId: command.eventId, revision: updated.revision, questionIds, replayed: false, lease: null };
    one(await tx.insert(applicationEvents).values({ ownerId: worker.ownerId, applicationId, eventId: command.eventId,
      requestHash, acknowledgement: result, createdAt: now }).returning({ eventId: applicationEvents.eventId }));
    return result;
  });
}

export async function requestQuestionFocus(
  db: PrivateDb, ownerId: string, id: string, input: FocusCommand, options: WorkerOptions = {},
): Promise<FocusResult> {
  const command = FocusCommandSchema.parse(input), scope = `question:focus:${id}`;
  return workerTransaction(db, async tx => {
    const { row, app } = await ownedQuestion(tx, ownerId, id);
    const replay = await replayCommand<FocusResult>(tx, ownerId, scope, command);
    if (replay) return replay;
    const ctx = await context(tx, ownerId, options);
    if (command.expectedRevision !== row.revision || row.resolvedAt !== null || !fresh(row, ctx) ||
        !['needs_login', 'needs_verification'].includes(row.descriptor.kind) ||
        !ctx.policy.policy.actions.includes('fill_forms') || !await eligible(tx, app, ctx)) fail();
    const pending = one(await tx.insert(questionInterventions).values({ id: randomUUID(), ownerId, questionId: id,
      applicationId: app.id, workerId: app.workerId, applicationRevision: app.revision, fence: app.fence,
      questionRevision: row.revision, createdAt: ctx.now }).returning());
    const result = focusResult(pending);
    await saveCommand(tx, ownerId, scope, command, result, ctx.now);
    return result;
  });
}

async function currentIntervention(
  tx: WorkerTx, intervention: typeof questionInterventions.$inferSelect, row: QuestionRow,
  app: ApplicationRow, workerId: string, ctx: Context,
) {
  return intervention.ownerId === ctx.ownerId && intervention.workerId === workerId && app.workerId === workerId &&
    intervention.applicationId === app.id && row.applicationId === app.id && intervention.questionId === row.id &&
    intervention.questionRevision === row.revision && intervention.applicationRevision === app.revision &&
    intervention.fence === app.fence && ['pending', 'focused'].includes(intervention.status) &&
    row.resolvedAt === null && ['needs_login', 'needs_verification'].includes(row.descriptor.kind) &&
    ctx.policy.policy.actions.includes('fill_forms') && fresh(row, ctx) && await eligible(tx, app, ctx);
}

export async function pollQuestionInterventions(
  db: PrivateDb, token: string, options: WorkerOptions = {},
): Promise<InterventionPage> {
  return withWorker(db, token, options, async (tx, worker) => {
    const ctx = await context(tx, worker.ownerId, options);
    const pending = await tx.select({ intervention: questionInterventions, question: questions, app: applications })
      .from(questionInterventions).innerJoin(questions, and(eq(questions.ownerId, questionInterventions.ownerId),
        eq(questions.id, questionInterventions.questionId)))
      .innerJoin(applications, and(eq(applications.ownerId, questionInterventions.ownerId),
        eq(applications.id, questionInterventions.applicationId)))
      .where(and(eq(questionInterventions.ownerId, worker.ownerId), eq(questionInterventions.workerId, worker.id),
        inArray(questionInterventions.status, ['pending', 'focused'])))
      // Acknowledged focused commands rotate behind untouched commands, including across byte-limited pages.
      .orderBy(questionInterventions.revision, questionInterventions.createdAt, questionInterventions.id);
    const commands: InterventionPage['commands'] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ questionProtocolVersion: 1, commands }));
    for (const { intervention, question, app } of pending) {
      if (!await currentIntervention(tx, intervention, question, app, worker.id, ctx)) continue;
      const command = { ...focusResult(intervention), expectedApplicationRevision: app.revision, fence: app.fence,
        descriptor: question.descriptor, checkpoint: app.checkpoint };
      const added = Buffer.byteLength(JSON.stringify(command)) + Number(commands.length > 0);
      if (bytes + added > INTERVENTION_PAGE_BYTES) {
        if (!commands.length) fail(413, 'INVALID_INPUT', 'Intervention exceeds the worker response byte limit.');
        break;
      }
      commands.push(command); bytes += added;
      if (commands.length === 20) break;
    }
    return { questionProtocolVersion: 1, commands };
  });
}

export async function ackQuestionIntervention(
  db: PrivateDb, token: string, id: string, input: InterventionAck, options: WorkerOptions = {},
): Promise<FocusResult> {
  const command = InterventionAckSchema.parse(input), scope = `question:intervention:${id}`;
  const receipt = { ...command, requestId: command.eventId };
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [intervention] = await tx.select().from(questionInterventions).where(and(
      eq(questionInterventions.ownerId, worker.ownerId), eq(questionInterventions.workerId, worker.id),
      eq(questionInterventions.id, id),
    ));
    if (!intervention) fail(404, 'NOT_FOUND', 'Intervention not found.');
    const replay = await replayCommand<FocusResult>(tx, worker.ownerId, scope, receipt);
    if (replay) return replay; // Historical acknowledgement only; no observation, lease or resume is repeated.
    const { row, app } = await ownedQuestion(tx, worker.ownerId, intervention.questionId);
    const ctx = await context(tx, worker.ownerId, options);
    if (command.expectedRevision !== intervention.revision || command.expectedApplicationRevision !== app.revision ||
        command.fence !== app.fence || !await currentIntervention(tx, intervention, row, app, worker.id, ctx)) fail();
    if (command.result === 'observed') {
      const observation = command.observation!;
      if (observation.kind !== (row.descriptor.kind === 'needs_login' ? 'login_complete' : 'verification_complete') ||
          observation.ats !== app.ats || observation.tenant !== app.tenant || observation.requisition !== app.requisition ||
          observation.observedAt < intervention.createdAt || observation.observedAt > now) fail();
      one(await tx.update(questions).set({ resolvedAt: now, revision: row.revision + 1 })
        .where(and(qScope(worker.ownerId, row.id), eq(questions.revision, row.revision), isNull(questions.resolvedAt))).returning());
      await reschedule(tx, app, ctx);
      const acknowledgement = { kind: 'intervention_observed', questionId: row.id, interventionId: id, observation };
      one(await tx.insert(applicationEvents).values({ ownerId: worker.ownerId, applicationId: app.id, eventId: command.eventId,
        requestHash: hashValue([scope, receipt]), acknowledgement, createdAt: now }).returning({ eventId: applicationEvents.eventId }));
    }
    const updated = one(await tx.update(questionInterventions).set({
      status: command.result, reason: command.reason, revision: intervention.revision + 1,
    }).where(and(eq(questionInterventions.ownerId, worker.ownerId), eq(questionInterventions.workerId, worker.id),
      eq(questionInterventions.id, id), eq(questionInterventions.revision, intervention.revision))).returning());
    const result = focusResult(updated);
    await saveCommand(tx, worker.ownerId, scope, receipt, result, now);
    return result;
  });
}
