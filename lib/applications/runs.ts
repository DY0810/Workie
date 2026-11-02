import 'server-only';
import { and, desc, eq, exists, gt, inArray, isNull, not, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { PrivateDb } from '../private-db/index.ts';
import {
  applicationReceipts, applicationRuns, applications, applicationSubmissions, discoveryManifests, manualApplicationMarks, workers,
} from '../private-db/schema.ts';
import { getPolicy } from './stores.ts';
import { isAwaitingSubmitApproval, isSafeRetryState, isTerminalState, type ApplicationState } from './state.ts';
import { postingUrl } from './posting-url.ts';
import { ARCHIVE_AFTER_MS, ARCHIVE_KEEP_MS, IN_FLIGHT_STATES } from './buckets.ts';
import { liveRow } from './live.ts';
import {
  RunCreateSchema, RunCommandSchema, ApplicationCommandSchema, LEASE_MS, SUBMIT_WAIT_MS,
  type RunCreate, type RunCommand, type ApplicationCommand, type Run,
  type RunList, type ApplicationSummary,
} from './worker-protocol.ts';
import {
  workerTransaction, currentWorker, nowAt, one, fail, randomUUID, replayCommand, saveCommand,
  releaseApplication, appScope, WorkerError, type WorkerOptions, type ApplicationRow, type WorkerTx,
} from './worker-store.ts';

export const runSummary = ({ id, workerId, revision, state, createdAt }: typeof applicationRuns.$inferSelect): Run =>
  ({ id, workerId, revision, state, createdAt });
export const applicationSummary = ({ id, runId, workerId, ats, tenant, requisition, state, revision, reasonCode, checkpoint, retries, createdAt, hiddenAt }: ApplicationRow,
  meta: { company?: string | null; role?: string | null; receiptId?: string | null; submittedAt?: number | null } = {}): ApplicationSummary =>
  ({ id, runId, workerId, ats, tenant, requisition, state, revision, reasonCode, checkpoint, retries,
    company: meta.company ?? null, role: meta.role ?? null, receiptId: meta.receiptId ?? null, submittedAt: meta.submittedAt ?? null,
    provider: null, costUsd: null, createdAt, hiddenAt });

/** A worker runs one run per policy at a time: a second would capture and stage every snapshot again. */
async function refuseSecondRun(tx: WorkerTx, run: Pick<typeof applicationRuns.$inferSelect,
  'ownerId' | 'workerId' | 'policyRevision' | 'policyVersion' | 'policyHash'>) {
  const [live] = await tx.select({ id: applicationRuns.id }).from(applicationRuns).where(and(
    eq(applicationRuns.ownerId, run.ownerId), eq(applicationRuns.workerId, run.workerId), eq(applicationRuns.state, 'running'),
    eq(applicationRuns.policyRevision, run.policyRevision), eq(applicationRuns.policyVersion, run.policyVersion),
    eq(applicationRuns.policyHash, run.policyHash))).limit(1);
  if (live) fail(409, 'RUN_ACTIVE', 'This worker already has a running run.');
}
/** A new running run bound to the owner's current policy, or null when that policy is not enabled. */
export async function insertRun(tx: WorkerTx, ownerId: string, workerId: string, now: number) {
  const policy = await getPolicy(tx, ownerId, now);
  if (!policy.enabled || !policy.policyHash) return null;
  const run = {
    id: randomUUID(), ownerId, workerId, policyRevision: policy.revision,
    policyVersion: policy.policyVersion, policyHash: policy.policyHash, createdAt: now,
  };
  await refuseSecondRun(tx, run);
  return one(await tx.insert(applicationRuns).values(run).returning());
}
export async function createRun(db: PrivateDb, ownerId: string, input: RunCreate, options: WorkerOptions = {}): Promise<Run> {
  const command = RunCreateSchema.parse(input);
  const result = await workerTransaction(db, async (tx) => {
    const replay = await replayCommand<Run>(tx, ownerId, 'run:create', command);
    if (replay) return replay;
    const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.id, command.workerId)));
    if (!worker) fail(404, 'NOT_FOUND', 'Worker not found.');
    if (!await currentWorker(tx, worker, options)) return new WorkerError(403, 'FORBIDDEN', 'Worker is revoked.');
    const now = nowAt(options), row = await insertRun(tx, ownerId, worker.id, now);
    if (!row) fail(403, 'FORBIDDEN', 'An enabled current policy is required.');
    const acknowledgement = runSummary(row);
    await saveCommand(tx, ownerId, 'run:create', command, acknowledgement, now);
    return acknowledgement;
  });
  if (result instanceof WorkerError) throw result;
  return result;
}
/**
 * A role that stopped again after a retry (same-row retry or a restarted attempt) goes back to the Jobs board, but not
 * the attempt a restart replaced. Neither is ever re-queued by discovery: its identity already has rows.
 * The state list is a top-level term so the board's lookup seeks `private_application_by_state` instead of every row.
 */
const returnedToBoard = and(
  inArray(applications.state, ['failed', 'retryable_failure', 'blocked_unsupported', 'provider_unavailable', 'needs_document']),
  sql`(${applications.retries} > 0 or ${applications.attempt} > 1)`, sql`${applications.reasonCode} is not 'restarted'`);

/** Posting URLs, in `onlyOnBoard`'s lowercase form, of roles Auto Apply gave up on, for every applicant. */
export async function returnedPostingUrls(db: PrivateDb): Promise<string[]> {
  const rows = await db.selectDistinct({ ats: applications.ats, tenant: applications.tenant, requisition: applications.requisition })
    .from(applications).where(and(isNull(applications.hiddenAt), returnedToBoard));
  return rows.flatMap(({ ats, tenant, requisition }) => {
    const url = postingUrl(ats, tenant.toLowerCase(), requisition.toLowerCase());
    if (!url) return [];
    // Board rows carry either Greenhouse host, or the embed form of a board on the company's own site.
    return ats === 'greenhouse' ? [url, url.replace('://job-boards.', '://boards.'),
      `https://job-boards.greenhouse.io/embed/job_app?for=${tenant.toLowerCase()}&token=${requisition}`] : [url];
  });
}

const newer = alias(applications, 'newer');
/** Waiting or finished rows, which pile up (discovery queues every eligible posting at once); only these are capped. */
const HISTORY_STATES: ApplicationState[] = ['queued', 'skipped', 'cancelled', 'failed'];
/** Archived rows (hidden, or 14 days old) stay listed for 30 days after archiving; the same cutoff as `bucket`. */
export async function listRuns(db: PrivateDb, ownerId: string, options: WorkerOptions = {}): Promise<RunList> {
  return workerTransaction(db, async (tx) => {
    const sameRole = <T extends typeof applications | typeof newer | typeof manualApplicationMarks>(table: T) => and(
      eq(table.ownerId, applications.ownerId), eq(table.ats, applications.ats),
      eq(table.tenant, applications.tenant), eq(table.requisition, applications.requisition));
    // A stopped attempt Auto Apply can never retry needs nothing from the applicant: a newer attempt of the role exists,
    // or the applicant marked the role applied by hand. Restart refuses both (DUPLICATE_BLOCKED), so neither is listed.
    const cannotRetry = and(inArray(applications.state, ['failed', 'skipped', 'cancelled']), or(
      exists(tx.select({ id: newer.id }).from(newer).where(and(sameRole(newer), gt(newer.attempt, applications.attempt)))),
      exists(tx.select({ id: manualApplicationMarks.id }).from(manualApplicationMarks).where(sameRole(manualApplicationMarks)))));
    // A role back on the board stays in Needs action too, so a row that leaves Live never just vanishes;
    // only the attempt a restart replaced is dropped, since its newer attempt is listed.
    const listed = and(eq(applications.ownerId, ownerId), sql`coalesce(${applications.reasonCode}, '') <> 'restarted'`, not(cannotRetry!),
      or(and(isNull(applications.hiddenAt), inArray(applications.state, ['submitted', ...IN_FLIGHT_STATES])), liveRow,
        sql`coalesce(${applications.hiddenAt}, ${applications.createdAt} + ${ARCHIVE_AFTER_MS}) > ${nowAt(options) - ARCHIVE_KEEP_MS}`));
    const select = () => tx.select({ app: applications, submission: applicationSubmissions, receipt: applicationReceipts })
      .from(applications)
      .leftJoin(applicationSubmissions, and(eq(applicationSubmissions.ownerId, applications.ownerId), eq(applicationSubmissions.applicationId, applications.id)))
      .leftJoin(applicationReceipts, and(eq(applicationReceipts.ownerId, applications.ownerId), eq(applicationReceipts.applicationId, applications.id)));
    // The worker takes the oldest row first, so a newest-N list hid the row it was filling or waiting to submit behind newer
    // history. Rows being worked, waiting on the applicant or applied are listed; past 500, old applied rows drop first, then
    // old waiting rows. ponytail: rows Live shows come first and are never dropped below 500 of them; query them apart past that.
    const rows = [
      ...await select().where(and(listed, not(inArray(applications.state, HISTORY_STATES))))
        .orderBy(sql`case when ${liveRow} then 0 when ${applications.state} = 'submitted' then 2 else 1 end`, desc(applications.createdAt)).limit(500),
      ...await select().where(and(listed, inArray(applications.state, HISTORY_STATES))).orderBy(desc(applications.createdAt)).limit(100),
    ].sort((a, b) => b.app.createdAt - a.app.createdAt);
    return {
      ownerId,
      runs: (await tx.select().from(applicationRuns).where(eq(applicationRuns.ownerId, ownerId))
        .orderBy(desc(applicationRuns.createdAt)).limit(100)).map(runSummary),
      applications: rows.map(({ app, submission, receipt }) => applicationSummary(app, {
        company: submission?.company ?? receipt?.company, role: submission?.role ?? receipt?.role,
        receiptId: receipt?.receiptId, submittedAt: receipt?.submittedAt,
      })),
    };
  });
}
export async function releaseRunApplications(tx: WorkerTx, ownerId: string, runId: string, state: 'paused' | 'stopped') {
  for (const app of await tx.select().from(applications).where(and(eq(applications.ownerId, ownerId), eq(applications.runId, runId)))) {
    if (isTerminalState(app.state)) continue;
    const released = await releaseApplication(tx, app, state === 'paused' ? 'run_paused' : 'run_stopped');
    if (state === 'stopped' && released.state !== 'submission_unknown') {
      one(await tx.update(applications).set({ state: 'cancelled' }).where(and(
        appScope(ownerId, app.id), eq(applications.revision, released.revision),
      )).returning());
    }
  }
}
export async function commandRun(db: PrivateDb, ownerId: string, id: string, input: RunCommand, options: WorkerOptions = {}): Promise<Run> {
  const command = RunCommandSchema.parse(input), scope = `run:${id}`;
  const result = await workerTransaction(db, async (tx) => {
    const replay = await replayCommand<Run>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [row] = await tx.select().from(applicationRuns).where(and(eq(applicationRuns.ownerId, ownerId), eq(applicationRuns.id, id)));
    if (!row) fail(404, 'NOT_FOUND', 'Run not found.');
    if (row.revision !== command.expectedRevision || row.state === 'stopped') fail();
    const now = nowAt(options);
    if (command.action === 'resume') {
      if (row.state !== 'paused') fail();
      const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.id, row.workerId)));
      if (!worker || !await currentWorker(tx, worker, options)) return new WorkerError(403, 'FORBIDDEN', 'Worker is revoked.');
      const policy = await getPolicy(tx, ownerId, now);
      if (!policy.enabled || policy.revision !== row.policyRevision || policy.policyVersion !== row.policyVersion || policy.policyHash !== row.policyHash) {
        fail(403, 'FORBIDDEN', 'Run policy is no longer enabled.');
      }
      await refuseSecondRun(tx, row);
    }
    const state = command.action === 'resume' ? 'running' : command.action === 'pause' ? 'paused' : 'stopped';
    const incomplete = row.discoveryState === 'capturing' || row.discoveryState === 'staging';
    const updated = one(await tx.update(applicationRuns).set({
      state, revision: row.revision + 1,
      ...(state === 'stopped' ? { captureToken: null, captureUntil: null,
        ...(incomplete ? { discoveryState: 'abandoned' as const } : {}) } : {}),
    })
      .where(and(eq(applicationRuns.ownerId, ownerId), eq(applicationRuns.id, id), eq(applicationRuns.revision, row.revision))).returning());
    if (state === 'stopped' && row.discoveryState === 'staging' && row.currentManifestId) {
      one(await tx.update(discoveryManifests).set({ state: 'abandoned', revision: sql`${discoveryManifests.revision} + 1` })
        .where(and(eq(discoveryManifests.ownerId, ownerId), eq(discoveryManifests.id, row.currentManifestId),
          eq(discoveryManifests.runId, id), eq(discoveryManifests.state, 'staging'))).returning());
    }
    if (state !== 'running') await releaseRunApplications(tx, ownerId, id, state);
    const acknowledgement = runSummary(updated);
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
  if (result instanceof WorkerError) throw result;
  return result;
}
/** Every ATS adapter keeps the employer's window open up to SUBMIT_WAIT_MS after the submission intent, even after the lease
 * is gone, and the applicant can still finish it there. Until it closes nobody can say it never went through: closing the row
 * would refuse that late receipt, and one more Apply would send the application twice. */
export async function refuseOpenSubmission(tx: WorkerTx, ownerId: string, applicationId: string, now: number) {
  const [open] = await tx.select({ intentId: applicationSubmissions.intentId }).from(applicationSubmissions).where(and(
    eq(applicationSubmissions.ownerId, ownerId), eq(applicationSubmissions.applicationId, applicationId),
    gt(applicationSubmissions.createdAt, now - SUBMIT_WAIT_MS - LEASE_MS),
  )).limit(1);
  if (open) fail(409, 'SUBMISSION_MAY_STILL_COMPLETE', 'The employer window may still be open. Try again once it closes.');
}
export async function commandApplication(
  db: PrivateDb, ownerId: string, runId: string, id: string, input: ApplicationCommand, options: WorkerOptions = {},
): Promise<ApplicationSummary> {
  const command = ApplicationCommandSchema.parse(input), scope = `application:${runId}:${id}`;
  return workerTransaction(db, async (tx) => {
    const replay = await replayCommand<ApplicationSummary>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [row] = await tx.select().from(applications).where(and(appScope(ownerId, id), eq(applications.runId, runId)));
    if (!row) fail(404, 'NOT_FOUND', 'Application not found.');
    const now = nowAt(options);
    const ambiguous = row.state === 'submitting' || row.state === 'submission_unknown';
    if (command.action === 'delete') {
      // Hides the row (history is append-only); a live one is cancelled first, like `cancel`, so the worker drops it.
      if (row.revision !== command.expectedRevision || row.hiddenAt !== null) fail();
      if (ambiguous) fail(409, 'CONFLICT', 'Submission requires read-only reconciliation.');
      const updated = one(await tx.update(applications).set({
        hiddenAt: now, revision: row.revision + 1, fence: row.fence + 1,
        ...(isTerminalState(row.state) ? {} : { state: 'cancelled' as const, reasonCode: 'delete', leaseUntil: null, leaseCheckedAt: null }),
      }).where(and(appScope(ownerId, id), eq(applications.revision, row.revision), eq(applications.fence, row.fence))).returning());
      const acknowledgement = applicationSummary(updated);
      await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
      return acknowledgement;
    }
    // The worker's read-only reconcile lease bumps an unknown row's revision every cycle, and the row leaves unknown
    // only for good, so the applicant's answer to it is checked against its state instead.
    const answer = ['confirm-submitted', 'confirm-not-submitted'].includes(command.action) && row.state === 'submission_unknown';
    if ((row.revision !== command.expectedRevision && !answer) || isTerminalState(row.state)) fail();
    if (ambiguous && !['emergency-stop', 'confirm-submitted', 'confirm-not-submitted'].includes(command.action)) fail(409, 'CONFLICT', 'Submission requires read-only reconciliation.');
    let next = row.state, availableAt = row.availableAt, retries = row.retries;
    if (command.action === 'retry-safe') {
      const [run] = await tx.select().from(applicationRuns).where(and(eq(applicationRuns.id, runId), eq(applicationRuns.ownerId, ownerId)));
      if (!run || run.state === 'stopped' || !isSafeRetryState(row.state, row.reasonCode) ||
          !row.checkpoint || row.retries >= 3) fail(409, 'CONFLICT', 'No safe retry is available.');
      // A run stays bound to the policy it started with; after a policy change only a run started under the new one can continue.
      const policy = await getPolicy(tx, ownerId, now);
      if (!policy.enabled || policy.revision !== run.policyRevision || policy.policyVersion !== run.policyVersion || policy.policyHash !== run.policyHash) {
        fail(409, 'POLICY_CHANGED', 'The policy changed after this run started.');
      }
      // Only Apply sends a form: a hold after approval fills it again for a new review, since Submit or the form may have changed.
      next = row.checkpoint.stage === 'ready' ? 'filling' : row.checkpoint.stage; retries += 1; availableAt = now + 5000 * 2 ** row.retries;
    } else if (command.action === 'approve-submit') {
      // The worker parks every filled form here; only the applicant's approval lets it submit.
      const [run] = await tx.select().from(applicationRuns).where(and(eq(applicationRuns.id, runId), eq(applicationRuns.ownerId, ownerId)));
      if (!run || run.state === 'stopped' || !isAwaitingSubmitApproval(row.state, row.reasonCode)) fail(409, 'CONFLICT', 'No filled form is awaiting approval.');
      // Only a running run leases the approved form; on a paused one (its worker revoked) it would wait at 'ready' forever.
      if (run.state !== 'running') fail(409, 'CONFLICT', 'The run is paused.');
      const policy = await getPolicy(tx, ownerId, now);
      if (!policy.enabled || !policy.policy.actions.includes('submit')) fail(403, 'SUBMIT_DISABLED', 'Submit is not enabled in the policy.');
      // Only a run bound to the enabled policy leases the approved form; on any other it would wait at 'ready' forever.
      if (policy.revision !== run.policyRevision || policy.policyVersion !== run.policyVersion || policy.policyHash !== run.policyHash) {
        fail(409, 'POLICY_CHANGED', 'The policy changed after this run started.');
      }
      next = 'ready'; availableAt = now;
    } else if (command.action === 'confirm-submitted' || command.action === 'confirm-not-submitted') {
      // The applicant says whether the employer received it. No receipt is invented: 0009 lets an unknown submission become
      // submitted, or failed as applicant_confirmed_not_submitted, which needs no running run, so it closes even when none can retry it.
      if (row.state !== 'submission_unknown') fail(409, 'CONFLICT', 'Only an unconfirmed submission can be answered.');
      if (command.action === 'confirm-not-submitted') await refuseOpenSubmission(tx, ownerId, id, now);
      next = command.action === 'confirm-submitted' ? 'submitted' : 'failed';
    } else next = ambiguous ? 'submission_unknown' : command.action === 'skip' ? 'skipped' : 'cancelled';
    const updated = one(await tx.update(applications).set({
      state: next, revision: row.revision + 1, fence: row.fence + 1, leaseUntil: null, leaseCheckedAt: null,
      reasonCode: command.action === 'approve-submit' ? 'submit_approved' : command.action === 'confirm-submitted' ? 'applicant_confirmed_submitted'
        : command.action === 'confirm-not-submitted' ? 'applicant_confirmed_not_submitted' : command.action,
      availableAt, retries,
    }).where(and(appScope(ownerId, id), eq(applications.revision, row.revision), eq(applications.fence, row.fence))).returning());
    const acknowledgement = applicationSummary(updated);
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
}
