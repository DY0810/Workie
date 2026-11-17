import 'server-only';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ReadDb } from '../db/index.ts';
import type { PrivateDb } from '../private-db/index.ts';
import {
  applicationEvents, applicationRuns, applications, applicationSubmissions, discoveryManifests, discoveryTargets, manualApplicationMarks, workers, workerCommands,
} from '../private-db/schema.ts';
import { captureCandidateSnapshot, type CandidateSnapshot, type DiscoveryCandidate } from './discovery-source.ts';
import { getPolicy, hashValue } from './stores.ts';
import { isSafeRetryState, isTerminalState } from './state.ts';
import type { Policy } from './policy.ts';
import { applicationSummary, refuseOpenSubmission, releaseRunApplications } from './runs.ts';
import { dailyStartInstant } from './schedule.ts';
import {
  AbandonDiscoverySchema, AbandonDiscoveryResponseSchema, DiscoveryStatusSchema, ReapplyRequestSchema,
  type DiscoveryStatus, type ReapplyRequest, type TargetDisposition,
} from './discovery-protocol.ts';
import {
  currentWorker, fail, nowAt, one, randomUUID, replayCommand, saveCommand, withWorker, workerTransaction,
  WorkerError, type ApplicationRow, type WorkerOptions, type WorkerTx,
} from './worker-store.ts';

export const DISCOVERY_INTERVAL_MS = 60_000;
export const STAGING_CHUNK_SIZE = 200;
const CAPTURE_LEASE_MS = 120_000;
const DAY_MS = 86_400_000;
type RunRow = typeof applicationRuns.$inferSelect;
export type CorpusProvider = () => ReadDb | Promise<ReadDb>;
const runScope = (ownerId: string, id: string) => and(eq(applicationRuns.ownerId, ownerId), eq(applicationRuns.id, id));
const manifestScope = (ownerId: string, id: string) => and(eq(discoveryManifests.ownerId, ownerId), eq(discoveryManifests.id, id));
const identityMatch = (app: Pick<ApplicationRow, 'ownerId' | 'ats' | 'tenant' | 'requisition'>) => and(
  eq(applications.ownerId, app.ownerId), eq(applications.ats, app.ats),
  eq(applications.tenant, app.tenant), eq(applications.requisition, app.requisition),
);
export async function currentDiscoveryPolicy(tx: WorkerTx, run: RunRow, now: number) {
  const policy = await getPolicy(tx, run.ownerId, now);
  if (run.state !== 'running' || !policy.enabled || policy.revision !== run.policyRevision ||
      policy.policyVersion !== run.policyVersion || policy.policyHash !== run.policyHash ||
      !policy.policy.actions.includes('read_jobs')) return null;
  return policy.policy;
}
export async function manuallySuppressed(tx: WorkerTx, app: Pick<ApplicationRow, 'ownerId' | 'ats' | 'tenant' | 'requisition'>) {
  const [mark] = await tx.select({ id: manualApplicationMarks.id }).from(manualApplicationMarks).where(and(
    eq(manualApplicationMarks.ownerId, app.ownerId), eq(manualApplicationMarks.ats, app.ats),
    eq(manualApplicationMarks.tenant, app.tenant), eq(manualApplicationMarks.requisition, app.requisition),
  )).limit(1);
  return !!mark;
}
/** The snapshot as if captured at `capturedAt`: rescans of an unchanged corpus differ only in capture time and its cutoff. */
const capturedAtTime = (snapshot: CandidateSnapshot, capturedAt: number): CandidateSnapshot => ({
  ...snapshot, capturedAt, scope: { ...snapshot.scope, effectiveAtCutoff: snapshot.scope.effectiveAtCutoff - snapshot.capturedAt + capturedAt },
});
/** Employer labels group caps only; they are never application identity. */
const employerKeyOf = (candidate: DiscoveryCandidate) => candidate.postings[0]?.company.trim().toLowerCase().replace(/\s+/g, ' ') || null;
const initialDisposition = (candidate: DiscoveryCandidate): TargetDisposition =>
  !candidate.identity || candidate.identityStatus !== 'resolved' ? 'unresolved' :
    candidate.disposition !== 'candidate' ? 'held_policy' : 'eligible';

/** Outbound worker polling is the scheduler. Corpus access occurs only after worker authorization. */
export async function discoverWorkerRuns(db: PrivateDb, token: string, corpus: CorpusProvider, options: WorkerOptions = {}) {
  const selected = await withWorker(db, token, options, async (tx, worker, now) => {
    const [run] = await tx.select().from(applicationRuns).where(and(
      eq(applicationRuns.ownerId, worker.ownerId), eq(applicationRuns.workerId, worker.id), eq(applicationRuns.state, 'running'),
      sql`coalesce(${applicationRuns.captureUntil}, 0) <= ${now} and
        (${applicationRuns.discoveryState} = 'staging' or coalesce(${applicationRuns.lastScanAt}, 0) <= ${now - DISCOVERY_INTERVAL_MS})`,
    )).orderBy(asc(sql`coalesce(${applicationRuns.lastAttemptAt}, 0)`), asc(applicationRuns.id)).limit(1);
    if (!run) return null;
    if (!await currentDiscoveryPolicy(tx, run, now)) {
      one(await tx.update(applicationRuns).set({ discoveryError: 'POLICY_STALE', captureUntil: now + DISCOVERY_INTERVAL_MS })
        .where(and(runScope(worker.ownerId, run.id), eq(applicationRuns.revision, run.revision))).returning());
      return null;
    }
    if (run.discoveryState === 'staging' && run.currentManifestId) return { run, manifestId: run.currentManifestId, captureToken: null };
    const captureToken = randomUUID();
    one(await tx.update(applicationRuns).set({
      discoveryState: 'capturing', captureToken, captureUntil: now + CAPTURE_LEASE_MS, lastAttemptAt: now, discoveryError: null,
    }).where(and(runScope(worker.ownerId, run.id), eq(applicationRuns.revision, run.revision),
      sql`${applicationRuns.captureToken} is ${run.captureToken}`)).returning());
    return { run, manifestId: null, captureToken };
  });
  if (!selected) return;
  let manifestId = selected.manifestId;
  if (!manifestId) {
    try {
      // Recheck credentials/policy before even resolving the injected corpus handle.
      const policy = await withWorker(db, token, options, async (tx, worker, now) => {
        const [run] = await tx.select().from(applicationRuns).where(and(runScope(worker.ownerId, selected.run.id),
          eq(applicationRuns.captureToken, selected.captureToken!)));
        const active = run && await currentDiscoveryPolicy(tx, run, now);
        if (!active) fail(409, 'POLICY_STALE', 'Discovery policy changed.');
        return active;
      });
      const snapshot = await captureCandidateSnapshot(await corpus(), policy, nowAt(options));
      const hash = hashValue(snapshot);
      manifestId = await withWorker(db, token, options, async (tx, worker, now) => {
        const [run] = await tx.select().from(applicationRuns).where(and(runScope(worker.ownerId, selected.run.id),
          eq(applicationRuns.captureToken, selected.captureToken!)));
        if (!run || !await currentDiscoveryPolicy(tx, run, now) || run.captureUntil! <= now) {
          fail(409, 'CAPTURE_STALE', 'Discovery capture no longer owns the run.');
        }
        const [current] = run.currentManifestId ? await tx.select({
          hash: discoveryManifests.hash, capturedAt: discoveryManifests.capturedAt, state: discoveryManifests.state,
        }).from(discoveryManifests).where(manifestScope(run.ownerId, run.currentManifestId)) : [];
        // An unchanged corpus keeps the current snapshot: no new manifest and no restaging, only the scan clock moves.
        // ponytail: a role another run releases unsubmitted is reconsidered at the next changed snapshot, not on a rescan.
        if (current?.state === 'ready' && hashValue(capturedAtTime(snapshot, current.capturedAt)) === current.hash) {
          one(await tx.update(applicationRuns).set({
            discoveryState: 'ready', captureToken: null, captureUntil: now + DISCOVERY_INTERVAL_MS, lastScanAt: now, discoveryError: null,
          }).where(and(runScope(run.ownerId, run.id), eq(applicationRuns.captureToken, selected.captureToken!),
            eq(applicationRuns.revision, run.revision))).returning());
          return null;
        }
        const id = randomUUID();
        one(await tx.insert(discoveryManifests).values({
          id, ownerId: run.ownerId, runId: run.id, policyRevision: run.policyRevision,
          artifact: snapshot, hash, capturedAt: snapshot.capturedAt, candidateCount: snapshot.candidates.length,
        }).returning({ id: discoveryManifests.id }));
        one(await tx.update(applicationRuns).set({
          discoveryState: 'staging', currentManifestId: id, captureToken: null, captureUntil: null,
        }).where(and(runScope(run.ownerId, run.id), eq(applicationRuns.captureToken, selected.captureToken!),
          eq(applicationRuns.revision, run.revision))).returning());
        return id;
      });
    } catch (error) {
      await workerTransaction(db, async (tx) => {
        await tx.update(applicationRuns).set({
          discoveryState: 'failed', captureToken: null, captureUntil: nowAt(options) + DISCOVERY_INTERVAL_MS,
          discoveryError: error instanceof WorkerError ? error.code : 'CAPTURE_FAILED',
        }).where(and(runScope(selected.run.ownerId, selected.run.id), eq(applicationRuns.captureToken, selected.captureToken!)));
      });
      return;
    }
  }
  if (!manifestId) return;
  try {
    await stageDiscoveryManifest(db, token, manifestId, options);
  } catch (error) {
    if (error instanceof WorkerError && error.status === 401) throw error;
    // The failed chunk rolled back; keep its manifest/cursor available for the next poll.
    await workerTransaction(db, async (tx) => {
      await tx.update(applicationRuns).set({ discoveryError: error instanceof WorkerError ? error.code : 'STAGING_FAILED' })
        .where(and(runScope(selected.run.ownerId, selected.run.id), eq(applicationRuns.currentManifestId, manifestId),
          eq(applicationRuns.state, 'running'), eq(applicationRuns.discoveryState, 'staging')));
    });
  }
}

/** On an `applications a` row: no submission intent was ever recorded for it. */
const noSubmission = sql`not exists (select 1 from ${applicationSubmissions} s where s.owner_id = a.owner_id and s.application_id = a.id)`;

/** Each committed chunk is resumable. Only the final transaction makes any member claimable. */
export async function stageDiscoveryManifest(db: PrivateDb, token: string, id: string, options: WorkerOptions = {}) {
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [manifest] = await tx.select().from(discoveryManifests).where(manifestScope(worker.ownerId, id));
    if (!manifest) fail(404, 'NOT_FOUND', 'Discovery manifest not found.');
    const [run] = await tx.select().from(applicationRuns).where(and(runScope(worker.ownerId, manifest.runId),
      eq(applicationRuns.workerId, worker.id)));
    if (!run) fail(404, 'NOT_FOUND', 'Discovery run not found.');
    if (manifest.state !== 'staging') return;
    if (!await currentDiscoveryPolicy(tx, run, now)) {
      one(await tx.update(applicationRuns).set({ discoveryError: 'POLICY_STALE' })
        .where(and(runScope(worker.ownerId, run.id), eq(applicationRuns.revision, run.revision))).returning());
      return;
    }
    if (run.currentManifestId !== id || hashValue(manifest.artifact) !== manifest.hash ||
        manifest.artifact.candidates.length !== manifest.candidateCount) {
      fail(409, 'MANIFEST_CORRUPT', 'Discovery manifest failed integrity validation.');
    }
    const chunk = manifest.artifact.candidates.slice(manifest.stagedCount, manifest.stagedCount + STAGING_CHUNK_SIZE);
    if (chunk.length) {
      // A mark imported while its posting's link could not be resolved has no identity; its posting still names the role.
      const marked = new Set((await tx.select({ postingId: manualApplicationMarks.postingId }).from(manualApplicationMarks)
        .where(and(eq(manualApplicationMarks.ownerId, worker.ownerId), sql`${manualApplicationMarks.requisition} is null`)))
        .map((mark) => mark.postingId));
      // A role another run held is evaluated afresh once that run stopped and released it with nothing submitted,
      // even if it had started (screened, tailored, waiting on answers).
      await tx.update(discoveryTargets).set({ applicationId: null }).where(and(
        eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.runId, run.id), eq(discoveryTargets.disposition, 'duplicate'),
        inArray(discoveryTargets.targetKey, chunk.map((candidate) => candidate.targetKey)),
        sql`exists (select 1 from ${applications} a where a.owner_id = ${discoveryTargets.ownerId} and a.id = ${discoveryTargets.applicationId}
          and a.state = 'cancelled' and a.reason_code = 'run_stopped' and ${noSubmission})`,
      ));
      await tx.insert(discoveryTargets).values(chunk.map((candidate, index) => ({
        id: randomUUID(), ownerId: worker.ownerId, runId: run.id, manifestId: id, targetKey: candidate.targetKey,
        candidateIndex: manifest.stagedCount + index, candidateHash: hashValue(candidate),
        ats: candidate.identity?.ats ?? null, tenant: candidate.identity?.tenant ?? null,
        requisition: candidate.identity?.requisition ?? null,
        employerKey: employerKeyOf(candidate),
        disposition: candidate.postings.some((posting) => marked.has(posting.postingId)) ? 'manual_reported' : initialDisposition(candidate),
      }))).onConflictDoUpdate({
        target: [discoveryTargets.ownerId, discoveryTargets.runId, discoveryTargets.targetKey],
        set: {
          manifestId: sql`excluded.manifest_id`, candidateIndex: sql`excluded.candidate_index`,
          candidateHash: sql`excluded.candidate_hash`, ats: sql`excluded.ats`, tenant: sql`excluded.tenant`,
          requisition: sql`excluded.requisition`, employerKey: sql`excluded.employer_key`, disposition: sql`excluded.disposition`,
        },
        setWhere: sql`${discoveryTargets.applicationId} is null and ${discoveryTargets.disposition} != 'manual_reported'`,
      });
      const persisted = await tx.select({ key: discoveryTargets.targetKey }).from(discoveryTargets).where(and(
        eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.runId, run.id),
        inArray(discoveryTargets.targetKey, chunk.map((candidate) => candidate.targetKey)),
      ));
      if (persisted.length !== chunk.length) fail(409, 'STAGING_INCOMPLETE', 'Target staging did not persist.');
    }
    const stagedCount = manifest.stagedCount + chunk.length;
    one(await tx.update(discoveryManifests).set({ stagedCount, revision: manifest.revision + 1 })
      .where(and(manifestScope(worker.ownerId, id), eq(discoveryManifests.revision, manifest.revision),
        eq(discoveryManifests.state, 'staging'))).returning());
    if (stagedCount !== manifest.candidateCount) return;
    await tx.update(discoveryTargets).set({ disposition: 'manual_reported' }).where(and(
      eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.manifestId, id),
      sql`exists (select 1 from ${manualApplicationMarks} m where m.owner_id = ${discoveryTargets.ownerId}
        and m.ats = ${discoveryTargets.ats} and m.tenant = ${discoveryTargets.tenant} and m.requisition = ${discoveryTargets.requisition})`,
    ));
    // One INSERT SELECT is bounded by the captured manifest, not a changing corpus or UI page.
    await tx.run(sql`insert into ${applications}
      (id, owner_id, run_id, worker_id, ats, tenant, requisition, attempt, previous_application_id, available_at, created_at,
       snapshot_manifest_id, snapshot_target_key, snapshot_hash, employer_key)
      select t.id, t.owner_id, t.run_id, ${worker.id}, t.ats, t.tenant, t.requisition,
        coalesce((select max(a.attempt) from ${applications} a where a.owner_id = t.owner_id
          and a.ats = t.ats and a.tenant = t.tenant and a.requisition = t.requisition), 0) + 1,
        (select a.id from ${applications} a where a.owner_id = t.owner_id
          and a.ats = t.ats and a.tenant = t.tenant and a.requisition = t.requisition
          order by a.attempt desc limit 1), ${now}, ${now},
        t.manifest_id, t.target_key, t.candidate_hash, t.employer_key
      from ${discoveryTargets} t where t.owner_id = ${worker.ownerId} and t.manifest_id = ${id}
        and t.disposition = 'eligible'
        and not exists (select 1 from ${applications} a where a.owner_id = t.owner_id
          and a.ats = t.ats and a.tenant = t.tenant and a.requisition = t.requisition
          -- A restarted row was replaced by a newer attempt, which this check sees on its own.
          and (a.state != 'cancelled' or coalesce(a.reason_code, '') not in ('run_stopped', 'restarted') or not ${noSubmission}))
      on conflict (owner_id, ats, tenant, requisition, attempt) do nothing`);
    const appId = sql<string>`(select a.id from ${applications} a where a.owner_id = ${discoveryTargets.ownerId}
      and a.ats = ${discoveryTargets.ats} and a.tenant = ${discoveryTargets.tenant}
      and a.requisition = ${discoveryTargets.requisition} order by a.attempt desc limit 1)`;
    await tx.update(discoveryTargets).set({
      applicationId: appId, disposition: sql`case when exists (select 1 from ${applications} a
        where a.id = ${appId} and a.owner_id = ${worker.ownerId} and a.run_id = ${run.id}) then 'eligible' else 'duplicate' end`,
    }).where(and(eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.manifestId, id),
      eq(discoveryTargets.disposition, 'eligible')));
    const [missing] = await tx.select({ id: discoveryTargets.id }).from(discoveryTargets).where(and(
      eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.manifestId, id),
      inArray(discoveryTargets.disposition, ['eligible', 'duplicate']), sql`${discoveryTargets.applicationId} is null`,
    )).limit(1);
    if (missing) fail(409, 'STAGING_INCOMPLETE', 'Applications did not persist.');
    one(await tx.update(discoveryManifests).set({ state: 'ready' }).where(and(
      manifestScope(worker.ownerId, id), eq(discoveryManifests.revision, manifest.revision + 1),
      eq(discoveryManifests.stagedCount, manifest.candidateCount),
    )).returning());
    one(await tx.update(applicationRuns).set({
      discoveryState: 'ready', lastScanAt: now, captureUntil: now + DISCOVERY_INTERVAL_MS, discoveryError: null,
    }).where(and(runScope(worker.ownerId, run.id), eq(applicationRuns.revision, run.revision),
      eq(applicationRuns.currentManifestId, id))).returning());
    // Superseded snapshots of this run that no run, target or application points at; the delete trigger keeps any other.
    // ponytail: at most 5 per completed snapshot, so a backlog drains slowly; a large one is a one-off batched delete.
    await tx.run(sql`delete from ${discoveryManifests} where id in (select m.id from ${discoveryManifests} m
      where m.owner_id = ${worker.ownerId} and m.run_id = ${run.id} and m.id != ${id}
        and not exists (select 1 from ${applicationRuns} r where r.owner_id = m.owner_id and r.current_manifest_id = m.id)
        and not exists (select 1 from ${discoveryTargets} t where t.owner_id = m.owner_id and t.manifest_id = m.id)
        and not exists (select 1 from ${applications} a where a.owner_id = m.owner_id and a.snapshot_manifest_id = m.id)
      limit 5)`);
  });
}

/**
 * Limits an employer's ATS enforces per candidate and only reveals at submit, after the whole form
 * is filled. They bind every applicant, whatever their policy, and count applications the
 * applicant reported as made by hand (manual marks) as well as Workie's own. Of Workie's, every started attempt
 * counts while it may still reach the employer, waiting ones too (an answer or Apply resumes them), so a third is
 * never filled only to be rejected. Skipped, cancelled (deleted, restarted, stopped) and failed attempts never had a
 * submission accepted or in flight: a submitting one only ends submitted, or failed when the applicant confirms it was not.
 * ponytail: Ramp's cap is on Software Engineering roles only; this counts every Ramp role. Add a
 * title match here if Workie ever applies to non-engineering Ramp roles.
 */
const EMPLOYER_LIMITS = [
  // Ashby rejects the third: "a total of 2 over a span of 60 days" (seen 2026-09-27).
  { ats: 'ashby', tenant: 'ramp', max: 2, days: 60 },
] as const;

function employerLimitReached(now: number) {
  return sql.join(EMPLOYER_LIMITS.map(({ ats, tenant, max, days }) => {
    const since = now - days * DAY_MS;
    return sql`(${applications}.ats = ${ats} and lower(${applications}.tenant) = ${tenant} and (
      (select count(*) from ${applications} used where used.owner_id = ${applications}.owner_id
        and used.ats = ${ats} and lower(used.tenant) = ${tenant} and used.started_at >= ${since}
        and used.state not in ('skipped', 'cancelled', 'failed'))
      + (select count(*) from ${manualApplicationMarks} m where m.owner_id = ${applications}.owner_id
        and m.ats = ${ats} and lower(m.tenant) = ${tenant} and m.created_at >= ${since})) >= ${max})`;
  }), sql` or `);
}

/** The day caps count in: the applicant's local day in the worker's time zone (the daily start's), else the UTC day. */
function capDay(now: number, timeZone: string | null): [number, number] {
  if (!timeZone) {
    const day = Math.floor(now / DAY_MS) * DAY_MS;
    return [day, day + DAY_MS];
  }
  // A local day is 23 to 25 hours long, so 36 hours after its midnight is always inside the next one.
  const next = (start: number) => dailyStartInstant(start + 36 * 3_600_000, 0, timeZone);
  const start = dailyStartInstant(now, 0, timeZone), end = next(start);
  // A midnight in a spring-forward gap resolves an hour early, so the hour before it opens the next day's window.
  return end > now ? [start, end] : [end, next(end)];
}

/**
 * Whether the policy's caps or an employer's limit hold a row today, as SQL on `applications`. Today's starts load once
 * and are matched from a JSON list, so checking many rows costs one query, not a scan of the owner's applications each.
 */
async function capHeld(tx: WorkerTx, ownerId: string, policy: Policy, now: number, timeZone: string | null) {
  const [day, end] = capDay(now, timeZone);
  const started = await tx.select({
    employerKey: applications.employerKey, ats: applications.ats, tenant: applications.tenant,
    // An attempt stopped, failed or skipped before it pressed submit never reached the employer, so its cap skips it.
    reached: sql<number>`not (${applications}.state in ('cancelled', 'failed', 'skipped') and not exists (
      select 1 from ${applicationSubmissions} s where s.owner_id = ${applications}.owner_id and s.application_id = ${applications}.id))`,
  }).from(applications).where(and(eq(applications.ownerId, ownerId), sql`${applications.startedAt} >= ${day} and ${applications.startedAt} < ${end}`,
      // Screening skips (reason codes ending _ineligible) never reached the employer; an applicant's own skip still counts.
      sql`not (${applications.state} = 'skipped' and coalesce(${applications.reasonCode}, '') like '%\\_ineligible%' escape '\\')`));
  if (started.length >= policy.dailyApplicationCap) return sql<boolean>`1`;
  const reached = started.filter((row) => row.reached).map(({ employerKey, ats, tenant }) => ({ employerKey, ats, tenant }));
  // Qualify the outer row: an unqualified column resolves to the inner table in SQLite.
  return sql<boolean>`(
    (select count(*) from json_each(${JSON.stringify(reached)}) used
      where json_extract(used.value, '$.employerKey') = ${applications}.employer_key or
        (json_extract(used.value, '$.ats') = ${applications}.ats and json_extract(used.value, '$.tenant') = ${applications}.tenant)) >= ${policy.perEmployerCap}
    or ${employerLimitReached(now)}
  )`;
}
/**
 * Rows the poll's scan can lease now, as SQL on `applications`, so it does not check one by one (about 13 statements a
 * row) rows of a run not live on the owner's current policy, or unstarted discovery rows the caps hold.
 * submission_unknown reconciles in any run. liveRun and discoveryClaimAllowed still check the row the poll picks.
 */
export async function claimableNow(tx: WorkerTx, ownerId: string, now: number, timeZone: string | null) {
  const head = await getPolicy(tx, ownerId, now);
  if (!head.enabled) return sql`${applications.state} = 'submission_unknown'`;
  const held = head.policy.actions.includes('read_jobs') ? await capHeld(tx, ownerId, head.policy, now, timeZone) : sql`1`;
  return sql`(${applications.state} = 'submission_unknown' or (
    exists (select 1 from ${applicationRuns} run where run.owner_id = ${applications}.owner_id and run.id = ${applications}.run_id
      and run.state = 'running' and run.policy_revision = ${head.revision} and run.policy_version = ${head.policyVersion}
      and run.policy_hash = ${head.policyHash})
    and (${applications.startedAt} is not null or ${applications.snapshotManifestId} is null or not coalesce(${held}, 0))))`;
}
export async function discoveryClaimAllowed(tx: WorkerTx, app: ApplicationRow, now: number, timeZone: string | null): Promise<boolean> {
  if (!app.snapshotManifestId) return true; // Phase 3's private synthetic enqueue has no public route.
  const [manifest] = await tx.select({ state: discoveryManifests.state }).from(discoveryManifests)
    .where(manifestScope(app.ownerId, app.snapshotManifestId));
  if (!manifest || manifest.state !== 'ready' || await manuallySuppressed(tx, app)) return false;
  const [run] = await tx.select().from(applicationRuns).where(runScope(app.ownerId, app.runId));
  const policy = run && await currentDiscoveryPolicy(tx, run, now);
  if (!policy) return false;
  if (app.startedAt !== null) return true;
  const [{ held }] = await tx.select({ held: await capHeld(tx, app.ownerId, policy, now, timeZone) }).from(applications)
    .where(and(eq(applications.ownerId, app.ownerId), eq(applications.id, app.id)));
  await tx.update(discoveryTargets).set({ disposition: held ? 'held_cap' : 'eligible' }).where(and(
    eq(discoveryTargets.ownerId, app.ownerId), eq(discoveryTargets.runId, app.runId),
    eq(discoveryTargets.applicationId, app.id), inArray(discoveryTargets.disposition, ['eligible', 'held_cap']),
  ));
  return !held;
}

export async function getDiscoveryStatus(db: PrivateDb, ownerId: string, runId: string, options: WorkerOptions = {}): Promise<DiscoveryStatus> {
  return workerTransaction(db, async (tx) => {
    const [run] = await tx.select().from(applicationRuns).where(runScope(ownerId, runId));
    if (!run) fail(404, 'NOT_FOUND', 'Run not found.');
    const [manifest] = run.currentManifestId
      ? await tx.select().from(discoveryManifests).where(manifestScope(ownerId, run.currentManifestId)) : [];
    const now = nowAt(options), policy = await currentDiscoveryPolicy(tx, run, now);
    const [worker] = await tx.select({ timeZone: workers.timeZone }).from(workers)
      .where(and(eq(workers.ownerId, ownerId), eq(workers.id, run.workerId)));
    const timeZone = worker?.timeZone ?? null;
    const disposition = sql<TargetDisposition>`case
      when ${discoveryTargets.disposition} in ('eligible','held_cap') and ${applications.startedAt} is null
        and ${applications.state} = 'queued' then
        ${policy ? sql`case when ${await capHeld(tx, ownerId, policy, now, timeZone)} then 'held_cap' else 'eligible' end` : sql`'held_policy'`}
      else ${discoveryTargets.disposition} end`;
    const groups = await tx.select({ disposition, count: sql<number>`count(*)` })
      .from(discoveryTargets).leftJoin(applications, and(
        eq(applications.ownerId, discoveryTargets.ownerId), eq(applications.id, discoveryTargets.applicationId),
      )).where(and(eq(discoveryTargets.ownerId, ownerId), eq(discoveryTargets.runId, runId)))
      .groupBy(disposition);
    const counts = { eligible: 0, duplicate: 0, unresolved: 0, held_policy: 0, held_cap: 0, manual_reported: 0 };
    for (const group of groups) counts[group.disposition] = group.count;
    // Held roles that wait on the applicant (not ones the policy excludes), by reason, from the current snapshot.
    const heldQuestions: Record<string, number> = {};
    if (manifest) {
      for (const { index } of await tx.select({ index: discoveryTargets.candidateIndex }).from(discoveryTargets).where(and(
        eq(discoveryTargets.ownerId, ownerId), eq(discoveryTargets.runId, runId), eq(discoveryTargets.manifestId, manifest.id),
        eq(discoveryTargets.disposition, 'held_policy'),
      ))) {
        const candidate = manifest.artifact.candidates[index];
        if (candidate?.disposition !== 'needs_question') continue;
        for (const reason of candidate.reasons) heldQuestions[reason] = (heldQuestions[reason] ?? 0) + 1;
      }
    }
    return DiscoveryStatusSchema.parse({
      ownerId, runId, state: run.discoveryState, lastAttemptAt: run.lastAttemptAt, lastScanAt: run.lastScanAt,
      errorCode: run.discoveryError, manifestId: manifest?.id ?? null, manifestHash: manifest?.hash ?? null,
      capturedAt: manifest?.capturedAt ?? null, candidateCount: manifest?.candidateCount ?? 0,
      stagedCount: manifest?.stagedCount ?? 0, counts, heldQuestions,
      capAccounting: timeZone ? 'started_per_local_day' : 'started_per_utc_day',
    });
  });
}

export async function abandonDiscovery(db: PrivateDb, ownerId: string, runId: string, input: unknown, options: WorkerOptions = {}) {
  const command = AbandonDiscoverySchema.parse(input);
  return workerTransaction(db, async (tx) => {
    const replay = await replayCommand<{ runId: string; manifestId: string; state: 'abandoned' }>(tx, ownerId, `discovery:abandon:${runId}`, command);
    if (replay) return replay;
    const [run] = await tx.select().from(applicationRuns).where(runScope(ownerId, runId));
    const [manifest] = await tx.select().from(discoveryManifests).where(and(
      manifestScope(ownerId, command.manifestId), eq(discoveryManifests.runId, runId),
    ));
    if (!run || !manifest) fail(404, 'NOT_FOUND', 'Discovery manifest not found.');
    if (manifest.state !== 'staging' || run.currentManifestId !== manifest.id) fail();
    // Ending this run preserves its immutable targets; a replacement run gets fresh target keys.
    one(await tx.update(discoveryManifests).set({ state: 'abandoned', revision: manifest.revision + 1 })
      .where(and(manifestScope(ownerId, manifest.id), eq(discoveryManifests.revision, manifest.revision))).returning());
    one(await tx.update(applicationRuns).set({
      state: 'stopped', revision: run.revision + 1, discoveryState: 'abandoned', captureToken: null, captureUntil: null,
    })
      .where(and(runScope(ownerId, runId), eq(applicationRuns.revision, run.revision))).returning());
    await releaseRunApplications(tx, ownerId, runId, 'stopped');
    const acknowledgement = AbandonDiscoveryResponseSchema.parse({ runId, manifestId: manifest.id, state: 'abandoned' });
    await saveCommand(tx, ownerId, `discovery:abandon:${runId}`, command, acknowledgement, nowAt(options));
    return acknowledgement;
  });
}

/** The next attempt of `previous`'s role in `run`, from the run's complete discovery snapshot. */
async function nextAttempt(tx: WorkerTx, run: typeof applicationRuns.$inferSelect, previous: ApplicationRow, now: number, retries = 0,
  newerSnapshotOnly = false, beforeWrite?: () => Promise<unknown>) {
  const ownerId = run.ownerId, runId = run.id;
  const [target] = await tx.select().from(discoveryTargets).where(and(
    eq(discoveryTargets.ownerId, ownerId), eq(discoveryTargets.runId, runId), eq(discoveryTargets.ats, previous.ats),
    eq(discoveryTargets.tenant, previous.tenant), eq(discoveryTargets.requisition, previous.requisition),
    inArray(discoveryTargets.disposition, ['duplicate', 'eligible', 'held_cap']),
  )).limit(1);
  const [manifest] = target ? await tx.select().from(discoveryManifests).where(manifestScope(ownerId, target.manifestId)) : [];
  if (!target || !manifest || manifest.state !== 'ready' || hashValue(manifest.artifact) !== manifest.hash) {
    fail(409, 'DISCOVERY_REQUIRED', 'A complete matching discovery snapshot is required.');
  }
  let candidate = manifest.artifact.candidates[target.candidateIndex];
  if (!candidate || hashValue(candidate) !== target.candidateHash) fail();
  const targetScope = and(eq(discoveryTargets.ownerId, ownerId), eq(discoveryTargets.id, target.id));
  // Staging never re-points a target that holds an application, so a posting re-crawled after its role was queued left the
  // role frozen to content /context refuses. The next attempt takes the run's latest snapshot of the same role instead,
  // unless its identity or official URL changed or the previous attempt ever recorded a submission.
  // shortcut: a restart before the next rescan (60 s) still gets the old snapshot; re-point at staging if that bites.
  let refrozen: Pick<typeof target, 'manifestId' | 'candidateIndex' | 'candidateHash' | 'employerKey'> | null = null;
  if (run.currentManifestId && run.currentManifestId !== target.manifestId) {
    const [latest] = await tx.select().from(discoveryManifests).where(manifestScope(ownerId, run.currentManifestId));
    const index = latest?.state === 'ready' && hashValue(latest.artifact) === latest.hash
      ? latest.artifact.candidates.findIndex((c) => c.targetKey === target.targetKey) : -1;
    const next = index < 0 ? undefined : latest.artifact.candidates[index];
    const [submission] = next ? await tx.select({ id: applicationSubmissions.intentId }).from(applicationSubmissions)
      .where(and(eq(applicationSubmissions.ownerId, ownerId), eq(applicationSubmissions.applicationId, previous.id))).limit(1) : [];
    if (next && !submission && next.officialUrl === candidate.officialUrl && next.identity?.ats === previous.ats &&
        next.identity.tenant === previous.tenant && next.identity.requisition === previous.requisition) {
      candidate = next;
      refrozen = { manifestId: latest.id, candidateIndex: index, candidateHash: hashValue(next), employerKey: employerKeyOf(next) };
    }
  }
  if (candidate.disposition !== 'candidate') fail();
  if (newerSnapshotOnly && !refrozen) fail(409, 'DISCOVERY_REQUIRED', 'The run has not scanned the role again yet.');
  await beforeWrite?.();
  if (refrozen) {
    // A target's evidence is immutable while it holds an application, so release it first, as staging does for a stopped
    // run's unsubmitted role. The previous attempt still names its own snapshot, which stays retained.
    await tx.update(discoveryTargets).set({ applicationId: null }).where(targetScope);
    one(await tx.update(discoveryTargets).set(refrozen).where(targetScope).returning());
  }
  const frozen = refrozen ?? target;
  const row = one(await tx.insert(applications).values({
    id: randomUUID(), ownerId, runId, workerId: run.workerId, ats: previous.ats, tenant: previous.tenant,
    requisition: previous.requisition, attempt: previous.attempt + 1, previousApplicationId: previous.id,
    snapshotManifestId: frozen.manifestId, snapshotTargetKey: target.targetKey, snapshotHash: frozen.candidateHash,
    employerKey: frozen.employerKey, availableAt: now, createdAt: now, retries,
  }).returning());
  one(await tx.update(discoveryTargets).set({ applicationId: row.id, disposition: 'eligible' }).where(targetScope).returning());
  return row;
}

/** A role whose posting changed after it was queued continues at once as a fresh attempt from the run's newer scan of it,
 * so an answered question does not end on a failure the applicant must retry by hand. Without a newer scan it stays put. */
export async function continueChangedPosting(tx: WorkerTx, previous: ApplicationRow, now: number) {
  if (previous.retries >= 3) return null;
  const [run] = await tx.select().from(applicationRuns).where(runScope(previous.ownerId, previous.runId));
  if (!run || !await currentDiscoveryPolicy(tx, run, now)) return null;
  const [latest] = await tx.select().from(applications).where(identityMatch(previous)).orderBy(desc(applications.attempt)).limit(1);
  if (latest.id !== previous.id || await manuallySuppressed(tx, previous)) return null;
  // nextAttempt refuses before it writes anything, so a refusal leaves the transaction clean; the database takes a
  // successor only to a closed attempt, so this one closes once every check has passed.
  let closed = false;
  const close = async () => {
    closed = true;
    // Closed as a page Retry closes it, so the role is neither listed twice nor returned to the Jobs board.
    return one(await tx.update(applications).set({ state: 'cancelled', reasonCode: 'restarted', revision: previous.revision + 1,
      fence: previous.fence + 1, leaseUntil: null, leaseCheckedAt: null })
      .where(and(eq(applications.ownerId, previous.ownerId), eq(applications.id, previous.id), eq(applications.revision, previous.revision))).returning());
  };
  try { return await nextAttempt(tx, run, previous, now, previous.retries + 1, true, close); } catch (error) {
    // After the close, a failure must undo the whole event rather than strand a closed role with no successor.
    if (error instanceof WorkerError && !closed) return null;
    throw error;
  }
}
export async function reapplyApplication(
  db: PrivateDb, ownerId: string, runId: string, input: ReapplyRequest, options: WorkerOptions = {},
) {
  const command = ReapplyRequestSchema.parse(input), scope = `application:reapply:${runId}`;
  const result = await workerTransaction(db, async (tx) => {
    const replay = await replayCommand<ReturnType<typeof applicationSummary>>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [run] = await tx.select().from(applicationRuns).where(runScope(ownerId, runId));
    if (!run) fail(404, 'NOT_FOUND', 'Run not found.');
    const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.id, run.workerId)));
    if (!worker || !await currentWorker(tx, worker, options)) return new WorkerError(403, 'FORBIDDEN', 'Worker is revoked.');
    const now = nowAt(options), policy = await currentDiscoveryPolicy(tx, run, now);
    if (!policy?.reapplication.allowed) fail(403, 'REAPPLICATION_DISABLED', 'Policy does not permit reapplication.');
    const [previous] = await tx.select().from(applications).where(and(
      eq(applications.ownerId, ownerId), eq(applications.id, command.previousApplicationId),
    ));
    if (!previous) fail(404, 'NOT_FOUND', 'Previous application not found.');
    if (previous.revision !== command.expectedRevision || !isTerminalState(previous.state) || previous.leaseUntil !== null) fail();
    const [latest] = await tx.select().from(applications).where(identityMatch(previous)).orderBy(desc(applications.attempt)).limit(1);
    if (latest.id !== previous.id || await manuallySuppressed(tx, previous)) fail(409, 'DUPLICATE_BLOCKED', 'Application is suppressed.');
    const [event] = await tx.select({ latest: sql<number | null>`max(${applicationEvents.createdAt})` }).from(applicationEvents)
      .where(and(eq(applicationEvents.ownerId, ownerId), eq(applicationEvents.applicationId, previous.id)));
    const [terminalCommand] = await tx.select({ latest: sql<number | null>`max(${workerCommands.createdAt})` }).from(workerCommands)
      .where(and(eq(workerCommands.ownerId, ownerId), sql`(
        (json_extract(${workerCommands.acknowledgement}, '$.id') = ${previous.id}
          and json_extract(${workerCommands.acknowledgement}, '$.state') in ('submitted','failed','skipped','cancelled'))
        or (json_extract(${workerCommands.acknowledgement}, '$.id') = ${previous.runId}
          and json_extract(${workerCommands.acknowledgement}, '$.state') = 'stopped')
        or (json_extract(${workerCommands.acknowledgement}, '$.runId') = ${previous.runId}
          and json_extract(${workerCommands.acknowledgement}, '$.state') = 'abandoned'))`));
    if (now - Math.max(previous.createdAt, previous.startedAt ?? 0, event.latest ?? 0, terminalCommand.latest ?? 0) < policy.reapplication.minimumDays * DAY_MS) {
      fail(409, 'COOLDOWN', 'Reapplication cooldown has not elapsed.');
    }
    const row = await nextAttempt(tx, run, previous, now);
    const acknowledgement = applicationSummary(row);
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
  if (result instanceof WorkerError) throw result;
  return result;
}

/** An applicant-confirmed unsubmitted application (no receipt; Greenhouse sent only a security code, or refused the
 * form) closes as failed and its role gets a fresh attempt. The employer never received it, so this is not a
 * reapplication: no reapplication policy or cooldown, but the same suppression and latest-attempt checks.
 * A document hold the applicant cleared by changing the policy continues the same way in a run started under it,
 * since the held application's run stays bound to the old policy. */
export async function retryUnsubmittedApplication(
  db: PrivateDb, ownerId: string, runId: string, input: ReapplyRequest, options: WorkerOptions = {},
) {
  const command = ReapplyRequestSchema.parse(input), scope = `application:retry-unsubmitted:${runId}`;
  const result = await workerTransaction(db, async (tx) => {
    const replay = await replayCommand<ReturnType<typeof applicationSummary>>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [run] = await tx.select().from(applicationRuns).where(runScope(ownerId, runId));
    if (!run) fail(404, 'NOT_FOUND', 'Run not found.');
    if (run.state === 'stopped') fail(409, 'CONFLICT', 'Run is stopped.');
    const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.id, run.workerId)));
    if (!worker || !await currentWorker(tx, worker, options)) return new WorkerError(403, 'FORBIDDEN', 'Worker is revoked.');
    const now = nowAt(options);
    const [previous] = await tx.select().from(applications).where(and(
      eq(applications.ownerId, ownerId), eq(applications.id, command.previousApplicationId),
    ));
    if (!previous) fail(404, 'NOT_FOUND', 'Previous application not found.');
    const unsubmitted = previous.state === 'submission_unknown';
    // The retry budget carries over to the new attempt, so moving runs cannot reset it.
    const documentHold = previous.state === 'needs_document' && isSafeRetryState(previous.state, previous.reasonCode) &&
      previous.runId !== runId && previous.retries < 3;
    // An unknown submission is only ever leased read-only (reconcile), which bumps its revision every cycle; it leaves
    // unknown only for good, so the applicant's answer is checked against its state and ends that lease.
    if (!unsubmitted && (previous.revision !== command.expectedRevision || !documentHold || previous.leaseUntil !== null)) fail();
    if (unsubmitted) await refuseOpenSubmission(tx, ownerId, previous.id, now);
    // Only a run on the current policy can lease the new attempt; an older one would strand it.
    if (!await currentDiscoveryPolicy(tx, run, now)) fail(409, 'POLICY_CHANGED', 'The policy changed after this run started.');
    const [latest] = await tx.select().from(applications).where(identityMatch(previous)).orderBy(desc(applications.attempt)).limit(1);
    if (latest.id !== previous.id || await manuallySuppressed(tx, previous)) fail(409, 'DUPLICATE_BLOCKED', 'Application is suppressed.');
    one(await tx.update(applications).set({
      state: 'failed', reasonCode: unsubmitted ? 'applicant_confirmed_not_submitted' : 'continued_in_new_run', revision: previous.revision + 1, fence: previous.fence + 1,
      leaseUntil: null, leaseCheckedAt: null,
    }).where(and(eq(applications.ownerId, ownerId), eq(applications.id, previous.id), eq(applications.revision, previous.revision))).returning());
    const row = await nextAttempt(tx, run, previous, now, unsubmitted ? 0 : previous.retries + 1);
    const acknowledgement = applicationSummary(row);
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
  if (result instanceof WorkerError) throw result;
  return result;
}

/** The applicant restarts a role that never reached the employer (cancelled, failed, skipped, or stuck on a hold):
 * a live attempt is cancelled and a fresh one queues in `runId`, which must be running on the current policy.
 * Submitted or possibly-submitted attempts are excluded; those go through reapply or reconciliation. */
export async function restartApplication(
  db: PrivateDb, ownerId: string, runId: string, input: ReapplyRequest, options: WorkerOptions = {},
) {
  const command = ReapplyRequestSchema.parse(input), scope = `application:restart:${runId}`;
  const result = await workerTransaction(db, async (tx) => {
    const replay = await replayCommand<ReturnType<typeof applicationSummary>>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [run] = await tx.select().from(applicationRuns).where(runScope(ownerId, runId));
    if (!run) fail(404, 'NOT_FOUND', 'Run not found.');
    const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.id, run.workerId)));
    if (!worker || !await currentWorker(tx, worker, options)) return new WorkerError(403, 'FORBIDDEN', 'Worker is revoked.');
    const now = nowAt(options);
    if (!await currentDiscoveryPolicy(tx, run, now)) fail(409, 'POLICY_CHANGED', 'The run is not running on the current policy.');
    const [previous] = await tx.select().from(applications).where(and(
      eq(applications.ownerId, ownerId), eq(applications.id, command.previousApplicationId),
    ));
    if (!previous) fail(404, 'NOT_FOUND', 'Previous application not found.');
    if (previous.revision !== command.expectedRevision || previous.hiddenAt !== null ||
        ['submitted', 'submitting', 'submission_unknown'].includes(previous.state)) fail();
    const [latest] = await tx.select().from(applications).where(identityMatch(previous)).orderBy(desc(applications.attempt)).limit(1);
    if (latest.id !== previous.id || await manuallySuppressed(tx, previous)) fail(409, 'DUPLICATE_BLOCKED', 'Application is suppressed.');
    if (!isTerminalState(previous.state)) {
      one(await tx.update(applications).set({
        state: 'cancelled', reasonCode: 'restarted', revision: previous.revision + 1, fence: previous.fence + 1,
        leaseUntil: null, leaseCheckedAt: null,
      }).where(and(eq(applications.ownerId, ownerId), eq(applications.id, previous.id), eq(applications.revision, previous.revision))).returning());
    }
    const row = await nextAttempt(tx, run, previous, now);
    const acknowledgement = applicationSummary(row);
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
  if (result instanceof WorkerError) throw result;
  return result;
}
