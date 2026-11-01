import { existsSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/index.ts';
import { postings } from '../db/schema.ts';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '../private-db/index.ts';
import {
  applications, applicationRuns, applicationEvents, applicationSubmissions, policyHeads, policyVersions, user, workers,
  discoveryManifests, discoveryTargets, manualApplicationMarks, legacyImportPreviews,
} from '../private-db/schema.ts';
import { createEmptyPolicy, type Policy } from './policy.ts';
import { createEmptyProfile } from './profile.ts';
import { getPolicy, getProfile, hashValue, mutatePolicy, saveProfile } from './stores.ts';
import { createPairing, pairWorker, revokeWorker } from './pairing.ts';
import { createRun, commandRun, commandApplication, listRuns } from './runs.ts';
import { pollWorker, heartbeatWorker } from './leases.ts';
import { recordWorkerEvent } from './events.ts';
import { beginSubmission } from './submissions.ts';
import {
  discoverWorkerRuns, stageDiscoveryManifest, getDiscoveryStatus, abandonDiscovery, reapplyApplication, retryUnsubmittedApplication, restartApplication,
  DISCOVERY_INTERVAL_MS,
} from './discovery.ts';
import { previewLegacyImport, confirmLegacyImport } from './imports.ts';
import { applicationContext } from './application-context.ts';
import { answerQuestion, getQuestion, registerQuestionBatch } from './questions.ts';
import { formQuestions } from '../../worker/screening.ts';
import { formQuestionKey, type AtsField } from '../../worker/ats/protocol.ts';
import { ImportConfirmRequestSchema, ImportPreviewRequestSchema, IMPORT_PREVIEW_TTL_MS } from './discovery-protocol.ts';
import * as source from './discovery-source.ts';
import { getDiscoveryCorpus } from './discovery-corpus.ts';
import type { WorkerOptions } from './worker-store.ts';
import { LEASE_MS, SUBMIT_WAIT_MS, type Lease } from './worker-protocol.ts';

import { stubHousehold } from '../test-household.ts';
vi.mock('server-only', () => ({}));
let db: PrivateDb, other: PrivateDb, corpus: Db, dir: string, now: number, options: WorkerOptions;
const DAY = 86_400_000;
const request = () => ({ requestId: randomUUID() });
const secret = () => randomBytes(32).toString('base64url');
const ref = (lease: Lease) => ({ applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision });
const provider = () => corpus;
const appRows = () => db.select().from(applications);
const manifests = () => db.select().from(discoveryManifests);
const targets = () => db.select().from(discoveryTargets);
function addPostings(count: number, start = 1, sameTenant = false) {
  corpus.insert(postings).values(Array.from({ length: count }, (_, i) => ({
    id: start + i, dedupeKey: `fixture-${start + i}`, canonicalUrl: `https://boards.greenhouse.io/${sameTenant ? 'shared' : `tenant${start + i}`}/jobs/${start + i}`,
    postedAt: new Date(now), firstSeenRun: 'synthetic', company: sameTenant ? 'Same Employer' : `Employer ${start + i}`,
    title: 'Software Engineer', companyNorm: `employer${start + i}`, titleNorm: 'software engineer', locationKey: 'US',
    country: 'US', track: 'engineering' as const, paid: true, description: 'Fixture description',
  }))).run();
}
async function policyFor(ownerId = 'alice', overrides: Partial<Policy> = {}) {
  const policy: Policy = { ...createEmptyPolicy(), actions: ['read_jobs'], destinations: ['job-boards.greenhouse.io'], undisclosedPay: 'include', ...overrides };
  const hash = hashValue(policy);
  await db.insert(policyVersions).values({ ownerId, version: 1, hash, policy, createdAt: now });
  await db.insert(policyHeads).values({ ownerId, revision: 1, policyVersion: 1, enabled: true,
    acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
}
async function pairedWorker(ownerId = 'alice') {
  const grant = await createPairing(db, ownerId, { ...request(), expectedRevision: 0, label: 'Synthetic' }, options);
  const token = secret();
  const worker = await pairWorker(db, {
    ...request(), protocolVersion: 1, workerId: randomUUID(), grant: grant.grant, workerToken: token,
    workerVersion: '0.1.0', capabilities: ['control-v1'],
  }, options);
  return { worker, token };
}
async function prepared(ownerId = 'alice', overrides: Partial<Policy> = {}) {
  await policyFor(ownerId, overrides);
  const { worker, token } = await pairedWorker(ownerId);
  const run = await createRun(db, ownerId, { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
  return { run, worker, token };
}
/** Saves and enables the policy with these changes, the way Profile does. */
async function enable(changes: Partial<Policy>) {
  vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
  if (!(await getProfile(db, 'alice')).revision) {
    const profile = createEmptyProfile(), confirmedAt = new Date(now).toISOString();
    for (const [key, value] of [['legalFirstName', 'Synthetic'], ['legalLastName', 'Applicant'], ['personalEmail', 'alice@example.test']] as const) {
      Object.assign(profile.identity[key], { value, state: 'confirmed', confirmedAt });
    }
    await saveProfile(db, 'alice', { ...request(), expectedRevision: 0, profile });
  }
  const current = await getPolicy(db, 'alice');
  const saved = await mutatePolicy(db, 'alice', { ...request(), expectedRevision: current.revision, policy: { ...current.policy, ...changes } });
  return mutatePolicy(db, 'alice', { ...request(), expectedRevision: saved.revision, action: 'enable', acceptedPolicyHash: saved.policyHash! });
}
async function complete(token: string, runId: string) {
  for (let i = 0; i < 60; i++) {
    await discoverWorkerRuns(db, token, provider, options);
    if ((await getDiscoveryStatus(db, 'alice', runId, options)).state === 'ready') return;
  }
  throw new Error('Discovery did not finish');
}
async function poll(token: string, discover = false) {
  return pollWorker(db, token, { protocolVersion: 1 }, { ...options, ...(discover ? { corpus: provider } : {}) });
}
async function skip(id: string) {
  const [app] = await db.select().from(applications).where(eq(applications.id, id));
  return commandApplication(db, app.ownerId, app.runId, id, { ...request(), expectedRevision: app.revision, action: 'skip' }, options);
}
/** Marks an attempt sent to the employer, so it charges the employer's cap. */
async function submit(id: string) {
  await db.update(applications).set({ state: 'submitted', reasonCode: null, leaseUntil: null, leaseCheckedAt: null }).where(eq(applications.id, id));
}
async function preview(ids: number[], ownerId = 'alice') {
  return previewLegacyImport(db, ownerId, provider, { ...request(), postingIds: ids }, options);
}
/** How many statements `d` runs inside transactions from now on. */
function countStatements(d: PrivateDb) {
  type Tx = { execute: (...args: unknown[]) => unknown };
  const client = d.$client as unknown as { transaction: (...args: unknown[]) => Promise<Tx> };
  const begin = client.transaction.bind(client);
  let count = 0;
  client.transaction = async (...args) => {
    const tx = await begin(...args), execute = tx.execute.bind(tx);
    tx.execute = (...rest) => { count++; return execute(...rest); };
    return tx;
  };
  return () => count;
}
const confirmInput = (p: Awaited<ReturnType<typeof preview>>, ids = p.rows.map((r) => r.postingId)) => ({
  ...request(), previewToken: p.previewToken, previewHash: p.previewHash, postingIds: ids, confirmOwnership: true as const,
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase4-backend-'));
  now = Date.UTC(2026, 8, 21, 12);
  options = { now: () => now };
  stubHousehold();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden'); }));
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await migratePrivateDb(db);
  other = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  corpus = openDb(join(dir, 'synthetic-corpus.db'), { migrate: true });
  for (const id of ['alice', 'bob']) {
    await db.insert(user).values({ id, name: 'Synthetic', email: `${id}@example.test`, emailVerified: true });
  }
});
afterEach(() => {
  (corpus as Db & { $client: Database.Database })?.$client.close(); other?.$client.close(); db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('immutable complete cohorts and standing reconciliation', () => {
  it('captures 601 unique requisitions plus duplicate rows; commits the manifest before staging and claims only all-ready', async () => {
    const { token, run, worker } = await prepared();
    addPostings(601); addPostings(50, 602);
    for (let i = 0; i < 50; i++) corpus.update(postings).set({ canonicalUrl: `https://boards.greenhouse.io/tenant${i + 1}/jobs/${i + 1}?utm_source=duplicate` })
      .where(eq(postings.id, 602 + i)).run();
    expect((await poll(token, true)).lease).toBeNull();
    const [manifest] = await manifests();
    expect(manifest).toMatchObject({ candidateCount: 601, stagedCount: 200, state: 'staging', capturedAt: now });
    expect(manifest.hash).toBe(hashValue(manifest.artifact));
    expect(await appRows()).toHaveLength(0);
    expect(await targets()).toHaveLength(200);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).lastScanAt).toBeNull();
    db.$client.close();
    db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    for (const n of [400, 600]) {
      expect((await poll(token, true)).lease).toBeNull();
      expect((await manifests())[0].stagedCount).toBe(n);
      expect(await appRows()).toHaveLength(0);
    }
    expect((await poll(token, true)).lease).not.toBeNull();
    expect(await appRows()).toHaveLength(601);
    expect((await manifests())[0]).toMatchObject({ hash: manifest.hash, state: 'ready', stagedCount: 601 });
    await stageDiscoveryManifest(other, token, manifest.id, options);
    await expect(createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options))
      .rejects.toMatchObject({ status: 409, code: 'RUN_ACTIVE' });
    const second = await pairedWorker();
    const overlapping = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: second.worker.workerId }, options);
    await complete(second.token, overlapping.id);
    expect(await appRows()).toHaveLength(601);
    expect((await getDiscoveryStatus(db, 'alice', overlapping.id, options)).counts.duplicate).toBe(601);
    now += DISCOVERY_INTERVAL_MS + 1;
    await complete(token, run.id);
    expect(await appRows()).toHaveLength(601);
  }, 30_000);

  it('starts the rescan interval when staging completes, not when capture began', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    now += DISCOVERY_INTERVAL_MS * 2;
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'ready', lastScanAt: now });
    await discoverWorkerRuns(db, token, provider, options);
    expect(await manifests()).toHaveLength(1);
  });

  it('rescans an unchanged corpus without a new snapshot or restaging, and snapshots again once it changes', async () => {
    const { token, run } = await prepared(); addPostings(3); await complete(token, run.id);
    const [first] = await manifests();
    now += DISCOVERY_INTERVAL_MS + 1;
    await discoverWorkerRuns(db, token, provider, options);
    expect(await manifests()).toEqual([first]);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'ready', lastScanAt: now, manifestId: first.id });
    now += DISCOVERY_INTERVAL_MS + 1; addPostings(1, 4);
    await discoverWorkerRuns(db, token, provider, options);
    // The first snapshot queued three applications, so it is kept as their evidence.
    expect((await manifests()).map((m) => m.id)).toContain(first.id);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'ready', candidateCount: 4, counts: { eligible: 4 } });
  });

  it('rolls back a failed final chunk and retries the exact hash without advancing progress or clocks', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [manifest] = await manifests();
    await db.run(sql`create trigger fixture_fail_application before insert on private_application begin select raise(abort,'synthetic failure'); end`);
    await expect(stageDiscoveryManifest(db, token, manifest.id, options)).rejects.toThrow();
    expect((await manifests())[0]).toMatchObject({ hash: manifest.hash, stagedCount: 200, state: 'staging' });
    expect(await targets()).toHaveLength(200);
    expect(await appRows()).toHaveLength(0);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).lastScanAt).toBeNull();
    await db.run(sql`drop trigger fixture_fail_application`);
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect(await appRows()).toHaveLength(201);
  });

  it('retains frozen identities through corpus deletion/reused numeric IDs and discovers new arrivals later', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [manifest] = await manifests();
    corpus.delete(postings).where(eq(postings.id, 201)).run();
    addPostings(1, 201);
    corpus.update(postings).set({ canonicalUrl: 'https://boards.greenhouse.io/replacement/jobs/9999' }).where(eq(postings.id, 201)).run();
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect((await appRows()).some((a) => a.requisition === '201')).toBe(true);
    expect((await appRows()).some((a) => a.requisition === '9999')).toBe(false);
    now += DISCOVERY_INTERVAL_MS + 1;
    await discoverWorkerRuns(db, token, provider, options);
    await complete(token, run.id);
    expect(await appRows()).toHaveLength(202);
    expect((await manifests())[0].hash).toBe(manifest.hash);
  });

  it('reconsiders previously held work from a new snapshot and drops the snapshot nothing refers to', async () => {
    const { token, run } = await prepared('alice', { undisclosedPay: 'ask' }); addPostings(1);
    corpus.update(postings).set({ paid: null }).run();
    await complete(token, run.id);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).counts.held_policy).toBe(1);
    const [first] = await manifests();
    corpus.update(postings).set({ paid: true, payRateMin: 50 }).run(); now += DISCOVERY_INTERVAL_MS + 1;
    await discoverWorkerRuns(db, token, provider, options);
    expect(await appRows()).toHaveLength(1);
    // No target, application or run points at the held-only snapshot any more.
    expect((await manifests()).map((m) => m.id)).not.toContain(first.id);
    expect(await manifests()).toHaveLength(1);
    await expect(db.run(sql`delete from private_discovery_manifest`)).rejects.toHaveProperty('cause.message', expect.stringMatching(/in use are retained/));
  });

  it('reports roles held for an applicant decision, and why, apart from roles the policy excludes', async () => {
    const { token, run } = await prepared('alice', { undisclosedPay: 'ask', employerBlocklist: ['Employer 2'] }); addPostings(3);
    corpus.update(postings).set({ paid: null }).where(eq(postings.id, 1)).run();
    await complete(token, run.id);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({
      counts: { held_policy: 2, eligible: 1 }, heldQuestions: { pay_undisclosed: 1 },
    });
  });

  it('retries stopped targets in a new run, started or not, as the next attempt of each role', async () => {
    const { token, run, worker } = await prepared(); addPostings(2); await complete(token, run.id);
    const started = (await poll(token)).lease!;
    const startedApp = (await appRows()).find((app) => app.id === started.applicationId)!;
    const unstartedRequisition = startedApp.requisition === '1' ? '2' : '1';
    await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: run.revision, action: 'stop' }, options);
    const replacement = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    await complete(token, replacement.id);
    const history = await appRows();
    const attempts = (requisition: string) => history.filter((app) => app.requisition === requisition).sort((a, b) => a.attempt - b.attempt);
    for (const [previous, retry] of [attempts(startedApp.requisition), attempts(unstartedRequisition)]) {
      expect(previous).toMatchObject({ runId: run.id, state: 'cancelled', reasonCode: 'run_stopped' });
      expect(retry).toMatchObject({ runId: replacement.id, state: 'queued', attempt: 2, previousApplicationId: previous.id });
    }
    expect(attempts(startedApp.requisition)[0].startedAt).not.toBeNull();
    expect(attempts(unstartedRequisition)[0].startedAt).toBeNull();
    expect((await targets()).filter((t) => t.runId === replacement.id).map((t) => t.disposition)).toEqual(['eligible', 'eligible']);
    // The stopped attempt never reached the employer, so the per-employer cap (1) holds neither retry.
    expect((await getDiscoveryStatus(db, 'alice', replacement.id, options)).counts).toMatchObject({ eligible: 2, held_cap: 0, duplicate: 0 });
    expect([attempts(startedApp.requisition)[1].id, attempts(unstartedRequisition)[1].id]).toContain((await poll(token)).lease?.applicationId);
  });

  it('retries a stopped target in a new run even after an earlier attempt of it was restarted', async () => {
    const { token, run, worker } = await prepared(); addPostings(1); await complete(token, run.id);
    const first = (await appRows())[0];
    await restartApplication(db, 'alice', run.id, { ...request(), previousApplicationId: first.id, expectedRevision: first.revision }, options);
    await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: run.revision, action: 'stop' }, options);
    now += DAY;
    const replacement = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    await complete(token, replacement.id);
    expect((await appRows()).sort((a, b) => a.attempt - b.attempt).map((a) => [a.attempt, a.state, a.reasonCode])).toEqual([
      [1, 'cancelled', 'restarted'], [2, 'cancelled', 'run_stopped'], [3, 'queued', null],
    ]);
  });

  it('never retries a stopped target that recorded a submission intent', async () => {
    const { token, run, worker } = await prepared(); addPostings(1); await complete(token, run.id);
    const app = (await appRows())[0]; await poll(token);
    await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: run.revision, action: 'stop' }, options);
    // No command leaves an intent on a cancelled row (stop turns submitting into submission_unknown); guard it anyway.
    await db.insert(applicationSubmissions).values({
      intentId: randomUUID(), ownerId: 'alice', applicationId: app.id, workerId: app.workerId, ats: app.ats, tenant: app.tenant,
      requisition: app.requisition, company: 'Employer 1', role: 'Software Engineer', manifestHash: hashValue('manifest'),
      artifactHashes: [], requestHash: hashValue('request'), createdAt: now,
    });
    now += DAY;
    const replacement = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    await complete(token, replacement.id);
    expect(await appRows()).toHaveLength(1);
    expect((await getDiscoveryStatus(db, 'alice', replacement.id, options)).counts).toMatchObject({ eligible: 0, duplicate: 1 });
  });

  it('keeps discovering and leasing in the same run after a policy change that selects the same roles', async () => {
    const { token, run } = await prepared('alice', { countries: ['US'] }); addPostings(2); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    const enabled = await enable({ dailyApplicationCap: 5 });
    await expect(heartbeatWorker(db, token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await poll(token)).lease).toMatchObject({ runId: run.id, policyRevision: enabled.revision });
    now += DISCOVERY_INTERVAL_MS + 1; addPostings(1, 3);
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ errorCode: null, counts: { eligible: 3 } });
  });

  it('discovers again under a policy change that narrows what discovery selects, in a new run', async () => {
    const { token, run } = await prepared('alice', { countries: ['US'] }); addPostings(3); await complete(token, run.id);
    const enabled = await enable({ employerBlocklist: ['Employer 1'] });
    expect((await db.select().from(applicationRuns).where(eq(applicationRuns.id, run.id)))[0].state).toBe('stopped');
    const [replacement] = await db.select().from(applicationRuns).where(eq(applicationRuns.state, 'running'));
    expect(replacement).toMatchObject({ policyRevision: enabled.revision });
    await complete(token, replacement.id);
    // The blocked employer's role stays cancelled; the other two queue again in the new run.
    expect((await appRows()).filter((row) => row.runId === replacement.id).map((row) => row.tenant).sort()).toEqual(['tenant2', 'tenant3']);
    expect((await poll(token)).lease).toMatchObject({ runId: replacement.id });
  });

  it('queues roles another worker\'s run marked duplicate at its next snapshot once the run holding them stops', async () => {
    const { token, run } = await prepared(); addPostings(3); await complete(token, run.id);
    const second = await pairedWorker();
    const replacement = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: second.worker.workerId }, options);
    await complete(second.token, replacement.id);
    expect((await getDiscoveryStatus(db, 'alice', replacement.id, options)).counts).toMatchObject({ eligible: 0, duplicate: 3 });
    await poll(token); // One role had started in the stopped run; it comes back too, and never reached the employer, so no cap holds it.
    await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: run.revision, action: 'stop' }, options);
    now += DISCOVERY_INTERVAL_MS + 1; addPostings(1, 4);
    await discoverWorkerRuns(db, second.token, provider, options);
    expect((await getDiscoveryStatus(db, 'alice', replacement.id, options)).counts).toMatchObject({ eligible: 4, held_cap: 0, duplicate: 0 });
    expect((await poll(second.token)).lease).toMatchObject({ runId: replacement.id });
  });

  it('runs one run at a time per worker on the current policy', async () => {
    const { run, worker } = await prepared();
    const create = () => createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    await expect(create()).rejects.toMatchObject({ status: 409, code: 'RUN_ACTIVE' });
    const paused = await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: run.revision, action: 'pause' }, options);
    await create();
    await expect(commandRun(db, 'alice', run.id, { ...request(), expectedRevision: paused.revision, action: 'resume' }, options))
      .rejects.toMatchObject({ status: 409, code: 'RUN_ACTIVE' });
  });

  it.each(['DELETE', 'WAL'])('reconciles a replaced %s corpus instead of advancing the scan clock on a cached old inode', async (journal) => {
    const { token, run } = await prepared(); addPostings(1);
    const path = join(dir, 'synthetic-corpus.db'), replacement = join(dir, 'replacement.db');
    const writer = (corpus as Db & { $client: Database.Database }).$client;
    writer.pragma(`journal_mode = ${journal}`); writer.close();
    vi.stubEnv('WORKIE_DB', path); vi.stubEnv('TURSO_DATABASE_URL', '');
    const cached = getDiscoveryCorpus() as Db & { $client: Database.Database };
    let current = cached;
    try {
      await discoverWorkerRuns(db, token, getDiscoveryCorpus, options);
      const [first] = await manifests();
      const before = await previewLegacyImport(db, 'alice', getDiscoveryCorpus, { ...request(), postingIds: [1] }, options);
      const oldInode = statSync(path).ino;
      corpus = openDb(replacement, { migrate: true }); addPostings(2);
      corpus.update(postings).set({ canonicalUrl: 'https://boards.greenhouse.io/replaced/jobs/9001' }).where(eq(postings.id, 1)).run();
      const nextWriter = (corpus as Db & { $client: Database.Database }).$client;
      nextWriter.pragma(`journal_mode = ${journal}`); nextWriter.close();
      renameSync(path, `${path}.stale`);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${path}.stale${suffix}`);
      }
      renameSync(replacement, path);
      expect(statSync(path).ino).not.toBe(oldInode);
      expect(cached.select().from(postings).all().map((p) => p.id)).toEqual([1]);
      now += DISCOVERY_INTERVAL_MS + 1;
      await discoverWorkerRuns(db, token, getDiscoveryCorpus, options);
      current = getDiscoveryCorpus() as typeof cached;
      expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({
        state: 'ready', lastScanAt: now, candidateCount: 2, stagedCount: 2,
      });
      expect((await appRows()).map((a) => a.requisition).sort()).toEqual(['1', '2', '9001']);
      expect((await manifests()).find((m) => m.id === first.id)).toEqual(first);
      expect(current).not.toBe(cached);
      expect(cached.$client.open).toBe(false);
      expect(() => current.delete(postings).run()).toThrow(/readonly/i);
      const after = await previewLegacyImport(db, 'alice', getDiscoveryCorpus, { ...request(), postingIds: [1] }, options);
      expect(after.rows[0].identity?.requisition).toBe('9001');
      await confirmLegacyImport(db, 'alice', confirmInput(before), options);
      expect((await db.select().from(manualApplicationMarks))[0].requisition).toBe('1');
      renameSync(path, replacement);
      expect(() => getDiscoveryCorpus()).toThrow();
      renameSync(replacement, path);
      expect(getDiscoveryCorpus()).toBe(current);
    } finally {
      if (current.$client.open) current.$client.close();
      if (cached.$client.open) cached.$client.close();
    }
  });

  it('does not call the corpus provider for invalid or revoked workers or obsolete policy', async () => {
    const { token, worker } = await prepared(); const getCorpus = vi.fn(provider);
    await expect(discoverWorkerRuns(db, secret(), getCorpus, options)).rejects.toMatchObject({ status: 401 });
    await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
    await discoverWorkerRuns(db, token, getCorpus, options);
    await revokeWorker(db, 'alice', worker.workerId, { ...request(), expectedRevision: 1 }, options);
    await expect(discoverWorkerRuns(db, token, getCorpus, options)).rejects.toMatchObject({ status: 401 });
    expect(getCorpus).not.toHaveBeenCalled();
  });

  it('backs off stale-policy staging so a replacement authorized run can complete', async () => {
    const { token, worker } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [stale] = await manifests();
    now += 1;
    await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
    const replacement = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    for (let i = 0; i < 4; i++) await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', replacement.id, options)).toMatchObject({
      state: 'ready', candidateCount: 201, stagedCount: 201, lastScanAt: now,
    });
    expect((await manifests()).find((m) => m.id === stale.id)).toEqual(stale);
    expect(await appRows()).toHaveLength(201);
    expect((await appRows()).every((app) => app.runId === replacement.id)).toBe(true);
  });

  it('reclaims an expired capture after a crash and preserves last successful scan on a failed capture', async () => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const scanAt = now;
    now += DISCOVERY_INTERVAL_MS + 1;
    await discoverWorkerRuns(db, token, () => { throw new Error('synthetic unavailable'); }, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'failed', lastScanAt: scanAt, lastAttemptAt: now });
    await db.update(applicationRuns).set({ discoveryState: 'capturing', captureToken: randomUUID(), captureUntil: now - 1 })
      .where(eq(applicationRuns.id, run.id));
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'ready', lastScanAt: now });
    expect(await appRows()).toHaveLength(1);
  });

  it('rejects an oversized corpus as a whole with a visible failure and no manifest or cursor', async () => {
    const { token, run } = await prepared();
    corpus.run(sql`with recursive n(i) as (select 1 union all select i + 1 from n where i <= 10000)
      insert into postings (dedupe_key,canonical_url,posted_at,first_seen_run,company,title,company_norm,title_norm,location_key,track,paid)
      select 'fixture-' || i, 'https://boards.greenhouse.io/fixture/jobs/' || i, ${now},
        'synthetic','Fixture','Engineer','fixture','engineer','US','engineering',1 from n`);
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({
      state: 'failed', errorCode: 'CAPTURE_FAILED', lastScanAt: null, candidateCount: 0, stagedCount: 0,
    });
    expect(await manifests()).toEqual([]);
    expect(await appRows()).toEqual([]);
  });

  it.each(['stop', 'policy', 'revoke'] as const)('rejects a capture completing after %s and never publishes its cohort', async (action) => {
    const { token, run, worker } = await prepared(); addPostings(1);
    const realCapture = source.captureCandidateSnapshot;
    vi.spyOn(source, 'captureCandidateSnapshot').mockImplementationOnce(async (...args) => {
      const snapshot = await realCapture(...args);
      if (action === 'stop') await commandRun(other, 'alice', run.id, { ...request(), expectedRevision: 1, action: 'stop' }, options);
      if (action === 'policy') await other.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
      if (action === 'revoke') await revokeWorker(other, 'alice', worker.workerId, { ...request(), expectedRevision: 1 }, options);
      return snapshot;
    });
    await discoverWorkerRuns(db, token, provider, options);
    expect(await manifests()).toEqual([]);
    expect(await targets()).toEqual([]);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).lastScanAt).toBeNull();
  });

  it('stops staging on policy change, supports explicit abandon, and never stages a stopped run', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [manifest] = await manifests();
    await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect((await manifests())[0].stagedCount).toBe(200);
    const command = { ...request(), manifestId: manifest.id };
    await expect(abandonDiscovery(db, 'bob', run.id, command, options)).rejects.toMatchObject({ status: 404 });
    const ack = await abandonDiscovery(db, 'alice', run.id, command, options);
    expect(await abandonDiscovery(other, 'alice', run.id, command, options)).toEqual(ack);
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect(await appRows()).toEqual([]);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'abandoned', lastScanAt: null });
  });

  it('serializes two polls and preserves one manifest and one complete logical cohort', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await Promise.all([discoverWorkerRuns(db, token, provider, options), discoverWorkerRuns(other, token, provider, options)]);
    await complete(token, run.id);
    expect(await manifests()).toHaveLength(1);
    expect(await targets()).toHaveLength(201);
    expect(await appRows()).toHaveLength(201);
  });

  it.each(['stop', 'abandon'] as const)('%s closes incomplete discovery and fences earlier ready work in the same transaction', async (action) => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    addPostings(201, 2); now += DISCOVERY_INTERVAL_MS + 1;
    await discoverWorkerRuns(db, token, provider, options);
    const current = await getDiscoveryStatus(db, 'alice', run.id, options);
    expect(current.state).toBe('staging');
    if (action === 'stop') {
      await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: 1, action: 'stop' }, options);
    } else await abandonDiscovery(db, 'alice', run.id, { ...request(), manifestId: current.manifestId! }, options);
    expect((await appRows())[0]).toMatchObject({ state: 'cancelled', leaseUntil: null });
    expect((await appRows())[0].fence).toBeGreaterThan(lease.fence);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'abandoned', lastScanAt: current.lastScanAt });
    await stageDiscoveryManifest(db, token, current.manifestId!, options);
    expect(await appRows()).toHaveLength(1);
  });

  it('pauses incomplete staging without losing its hash and resumes only the same authorized policy', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [manifest] = await manifests();
    await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: 1, action: 'pause' }, options);
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect((await manifests())[0]).toMatchObject({ hash: manifest.hash, stagedCount: 200 });
    await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: 2, action: 'resume' }, options);
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect((await manifests())[0]).toMatchObject({ hash: manifest.hash, state: 'ready' });
    expect(await appRows()).toHaveLength(201);
  });

  it('publishes a staging failure without advancing its cursor and retries on a later worker poll', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    await db.run(sql`create trigger fixture_stage_fail before insert on private_application begin select raise(abort,'fixture'); end`);
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({
      state: 'staging', errorCode: 'STAGING_FAILED', stagedCount: 200, lastScanAt: null,
    });
    await db.run(sql`drop trigger fixture_stage_fail`);
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'ready', errorCode: null, stagedCount: 201 });
  });
});

describe('cap-held backlog and explicit historical attempts', () => {
  it('reports every held daily-cap target and releases the backlog on the next UTC day', async () => {
    const { token, run } = await prepared('alice', { dailyApplicationCap: 1 }); addPostings(205); await complete(token, run.id);
    const first = (await poll(token)).lease!; expect(first).not.toBeNull();
    let status = await getDiscoveryStatus(db, 'alice', run.id, options);
    expect(status.counts.held_cap).toBe(204);
    await skip(first.applicationId);
    expect((await poll(token)).lease).toBeNull();
    expect(await appRows()).toHaveLength(205);
    now = Math.floor(now / DAY) * DAY + DAY;
    status = await getDiscoveryStatus(db, 'alice', run.id, options);
    expect(status.counts.held_cap).toBe(0);
    expect((await poll(token)).lease).not.toBeNull();
  }, 20_000);

  it('skips held rows in one query once the daily cap is used up, and still resumes a started one', async () => {
    const { token, run } = await prepared('alice', { dailyApplicationCap: 1 }); addPostings(100); await complete(token, run.id);
    const first = (await poll(token)).lease!;
    now += LEASE_MS + 1;
    let statements = countStatements(db);
    expect((await poll(token)).lease?.applicationId).toBe(first.applicationId);
    // Before the fix: 1293 statements here, about 13 for each of the 99 held rows.
    expect(statements()).toBeLessThan(30);
    await skip(first.applicationId);
    statements = countStatements(db);
    expect((await poll(token)).lease).toBeNull();
    expect(statements()).toBeLessThan(30);
  }, 20_000);

  it('skips rows held by the per-employer cap, or in a run on an outdated policy, in one query too', async () => {
    const { token, run } = await prepared('alice', { dailyApplicationCap: 1000, perEmployerCap: 1 }); addPostings(100, 1, true);
    await complete(token, run.id);
    await submit((await poll(token)).lease!.applicationId);
    let statements = countStatements(db);
    expect((await poll(token)).lease).toBeNull();
    // Before the fix: about 13 statements for each of the 99 held rows.
    expect(statements()).toBeLessThan(30);
    // A policy saved after the run started leaves the run running, but it can lease nothing.
    now += DAY;
    await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
    statements = countStatements(db);
    expect((await poll(token)).lease).toBeNull();
    expect(statements()).toBeLessThan(30);
  }, 20_000);

  it("resets the daily cap at the applicant's local midnight, not UTC midnight", async () => {
    now = Date.UTC(2026, 8, 21, 23); // 4 pm in Los Angeles
    const { token, run, worker } = await prepared('alice', { dailyApplicationCap: 1 }); addPostings(2);
    await db.update(workers).set({ dailyStartMinute: 1, timeZone: 'America/Los_Angeles' }).where(eq(workers.id, worker.workerId));
    await complete(token, run.id);
    await skip((await poll(token)).lease!.applicationId);
    now = Date.UTC(2026, 8, 22, 0, 30); // 5:30 pm, the same local day
    expect((await poll(token)).lease).toBeNull();
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({
      counts: { held_cap: 1 }, capAccounting: 'started_per_local_day',
    });
    now = Date.UTC(2026, 8, 22, 7, 1); // 12:01 am the next local day
    expect((await poll(token)).lease).not.toBeNull();
  });

  it('keeps the daily cap in the last hour before a midnight daylight-saving jump', async () => {
    now = Date.UTC(2026, 8, 6, 3, 10); // 11:10 pm in Santiago; at midnight its clocks jump to 1 am
    const { token, run, worker } = await prepared('alice', { dailyApplicationCap: 1 }); addPostings(2);
    await db.update(workers).set({ dailyStartMinute: 1, timeZone: 'America/Santiago' }).where(eq(workers.id, worker.workerId));
    await complete(token, run.id);
    await skip((await poll(token)).lease!.applicationId);
    now = Date.UTC(2026, 8, 6, 3, 40);
    expect((await poll(token)).lease).toBeNull();
  });

  it('enforces per-employer caps across runs while never charging a resumed lease twice', async () => {
    const { token, run } = await prepared('alice', { perEmployerCap: 1 }); addPostings(3, 1, true); await complete(token, run.id);
    const first = (await poll(token)).lease!;
    expect((await poll(token)).lease?.applicationId).toBe(first.applicationId);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).counts.held_cap).toBe(2);
    await submit(first.applicationId);
    expect((await poll(token)).lease).toBeNull();
    now += DAY;
    expect((await poll(token)).lease).not.toBeNull();
  });

  it('does not charge the caps for a role screening skipped before it reached the employer', async () => {
    const { token, run } = await prepared('alice', { perEmployerCap: 1 }); addPostings(2, 1, true); await complete(token, run.id);
    const first = (await poll(token)).lease!;
    // What the worker reports for a posting the applicant does not qualify for (worker/main.ts).
    await db.update(applications).set({ state: 'skipped', reasonCode: 'degree_ineligible', leaseUntil: null, leaseCheckedAt: null }).where(eq(applications.id, first.applicationId));
    const next = (await poll(token)).lease;
    expect(next).not.toBeNull();
    expect(next!.applicationId).not.toBe(first.applicationId);
  });

  it('charges the per-employer cap only for attempts that reached the employer or still may', async () => {
    const { token, run } = await prepared('alice', { perEmployerCap: 1 }); addPostings(3, 1, true); await complete(token, run.id);
    const end = (id: string, state: 'failed' | 'cancelled', reasonCode: string) => db.update(applications)
      .set({ state, reasonCode, leaseUntil: null, leaseCheckedAt: null }).where(eq(applications.id, id));
    // A fill that failed before submitting never reached the employer.
    const first = (await poll(token)).lease!;
    await end(first.applicationId, 'failed', 'ats_identity_mismatch');
    const second = (await poll(token)).lease!;
    expect(second.applicationId).not.toBe(first.applicationId);
    // One that pressed submit did, however it ended.
    const app = (await appRows()).find((row) => row.id === second.applicationId)!;
    await db.insert(applicationSubmissions).values({
      intentId: randomUUID(), ownerId: 'alice', applicationId: app.id, workerId: app.workerId, ats: app.ats, tenant: app.tenant,
      requisition: app.requisition, company: 'Employer 1', role: 'Software Engineer', manifestHash: hashValue('manifest'),
      artifactHashes: [], requestHash: hashValue('request'), createdAt: now,
    });
    await end(app.id, 'failed', 'applicant_confirmed_not_submitted');
    expect((await poll(token)).lease).toBeNull();
  });

  it("holds a third Ramp application inside Ramp's 60-day limit, counting applications made by hand", async () => {
    addPostings(3);
    corpus.update(postings).set({ company: 'Ramp', canonicalUrl: sql`'https://jobs.ashbyhq.com/ramp/0000000' || ${postings.id} || '-0000-4000-8000-000000000000'` }).run();
    const p = await preview([1]);
    expect(p.rows[0].identity).toMatchObject({ ats: 'ashby', tenant: 'ramp' });
    await confirmLegacyImport(db, 'alice', confirmInput(p), options);
    const { token, run } = await prepared('alice', { destinations: ['jobs.ashbyhq.com'], perEmployerCap: 10 });
    await complete(token, run.id);
    const second = (await poll(token)).lease!;
    await db.update(applications).set({ state: 'submitted', leaseUntil: null, leaseCheckedAt: null })
      .where(eq(applications.id, second.applicationId));
    now += DAY;
    expect((await poll(token)).lease).toBeNull();
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).counts.held_cap).toBe(1);
    now += 60 * DAY;
    expect((await poll(token)).lease).not.toBeNull();
  });

  it('counts Ramp attempts that may still reach Ramp, such as one waiting for Apply, but not skipped, deleted or failed ones', async () => {
    addPostings(6);
    corpus.update(postings).set({ company: 'Ramp', canonicalUrl: sql`'https://jobs.ashbyhq.com/ramp/0000000' || ${postings.id} || '-0000-4000-8000-000000000000'` }).run();
    const { token, run } = await prepared('alice', { destinations: ['jobs.ashbyhq.com'], perEmployerCap: 10 });
    await complete(token, run.id);
    const next = async () => {
      const { lease } = await poll(token);
      expect(lease).not.toBeNull();
      return lease!.applicationId;
    };
    const park = (id: string, state: 'needs_answer' | 'needs_policy_decision' | 'failed', reasonCode: string) => db.update(applications)
      .set({ state, reasonCode, leaseUntil: null, leaseCheckedAt: null }).where(eq(applications.id, id));
    await skip(await next());
    const deleted = await next(), [row] = await db.select().from(applications).where(eq(applications.id, deleted));
    await commandApplication(db, 'alice', row.runId, deleted, { ...request(), expectedRevision: row.revision, action: 'delete' }, options);
    await park(await next(), 'failed', 'applicant_confirmed_not_submitted');
    const answering = await next();
    await park(answering, 'needs_answer', 'form_question');
    await park(await next(), 'needs_policy_decision', 'submit_approval');
    now += DAY;
    // Two attempts can still reach Ramp once the applicant answers or presses Apply, so a third is not filled.
    expect((await poll(token)).lease).toBeNull();
    await skip(answering);
    await next();
  });

  it('allows only explicit policy-approved reapplication after cooldown measured from the terminal command', async () => {
    const { token, run } = await prepared('alice', { reapplication: { allowed: true, minimumDays: 1 } });
    addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    now += 2 * DAY;
    const previous = await skip(lease.applicationId);
    const command = { ...request(), previousApplicationId: previous.id, expectedRevision: previous.revision };
    await expect(reapplyApplication(db, 'alice', run.id, command, options)).rejects.toMatchObject({ code: 'COOLDOWN' });
    now += DAY;
    const next = await reapplyApplication(db, 'alice', run.id, command, options);
    expect(next.id).not.toBe(previous.id);
    expect(await reapplyApplication(other, 'alice', run.id, command, options)).toEqual(next);
    const history = await appRows();
    expect(history.find((a) => a.id === previous.id)).toMatchObject({ state: 'skipped', attempt: 1 });
    expect(history.find((a) => a.id === next.id)).toMatchObject({ state: 'queued', attempt: 2, previousApplicationId: previous.id });
    await expect(reapplyApplication(db, 'alice', run.id, { ...command, ...request() }, options)).rejects.toMatchObject({ code: 'DUPLICATE_BLOCKED' });
    // The skipped attempt can never be retried again, so only the newest attempt is listed.
    expect((await listRuns(db, 'alice', options)).applications.map((a) => a.id)).toEqual([next.id]);
    expect((await poll(token)).lease?.applicationId).toBe(next.id);
  });

  it('cancels a queued reapplication once the applicant turns reapplication off', async () => {
    const { token, run } = await prepared('alice', { countries: ['US'], reapplication: { allowed: true, minimumDays: 1 } });
    addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    await db.update(applications).set({ state: 'submitted', leaseUntil: null, leaseCheckedAt: null }).where(eq(applications.id, lease.applicationId));
    const [submitted] = await db.select().from(applications).where(eq(applications.id, lease.applicationId));
    now += 2 * DAY;
    const next = await reapplyApplication(db, 'alice', run.id, { ...request(), previousApplicationId: submitted.id, expectedRevision: submitted.revision }, options);
    await enable({ reapplication: { allowed: false, minimumDays: 1 } });
    expect((await appRows()).find((a) => a.id === next.id)).toMatchObject({ state: 'cancelled', reasonCode: 'reapplication_disabled' });
    expect((await poll(token)).lease).toBeNull();
  });

  it('gives an applicant-confirmed unsubmitted application one fresh attempt without reapplication policy', async () => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    await db.update(applications).set({ state: 'submission_unknown', leaseUntil: null, leaseCheckedAt: null })
      .where(eq(applications.id, lease.applicationId));
    const stuck = (await appRows()).find((a) => a.id === lease.applicationId)!;
    const command = { ...request(), previousApplicationId: stuck.id, expectedRevision: stuck.revision };
    await expect(reapplyApplication(db, 'alice', run.id, command, options)).rejects.toMatchObject({ code: 'REAPPLICATION_DISABLED' });
    await expect(retryUnsubmittedApplication(db, 'bob', run.id, command, options)).rejects.toMatchObject({ status: 404 });
    const next = await retryUnsubmittedApplication(db, 'alice', run.id, command, options);
    expect(await retryUnsubmittedApplication(other, 'alice', run.id, command, options)).toEqual(next);
    const history = await appRows();
    const closed = history.find((a) => a.id === stuck.id)!;
    expect(closed).toMatchObject({ state: 'failed', reasonCode: 'applicant_confirmed_not_submitted', attempt: 1 });
    expect(history.find((a) => a.id === next.id)).toMatchObject({ state: 'queued', attempt: 2, previousApplicationId: stuck.id });
    // Only an unknown submission qualifies, so neither the closed attempt nor the fresh one can be retried this way.
    for (const app of [closed, history.find((a) => a.id === next.id)!]) {
      await expect(retryUnsubmittedApplication(db, 'alice', run.id, { ...request(), previousApplicationId: app.id,
        expectedRevision: app.revision }, options)).rejects.toMatchObject({ status: 409 });
    }
    now += DAY; // The stuck attempt used today's per-employer start.
    expect((await poll(token)).lease?.applicationId).toBe(next.id);
  });

  it('retries an unknown submission the applicant says never went through, even while its reconcile lease is held', async () => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, lease.applicationId));
    now += LEASE_MS;
    const unknown = (await poll(token)).lease!;
    expect(unknown).toMatchObject({ applicationId: lease.applicationId, state: 'submission_unknown', mode: 'reconcile' });
    // The page loaded before this cycle re-leased it, so the revision it sends is already stale.
    const command = { ...request(), previousApplicationId: unknown.applicationId, expectedRevision: unknown.revision - 1 };
    // A run that is not on the current policy would never lease the fresh attempt.
    const [head] = await db.select().from(policyHeads).where(eq(policyHeads.ownerId, 'alice'));
    await db.update(policyHeads).set({ enabled: false, acceptedPolicyVersion: null, acceptedPolicyHash: null, acceptedAt: null })
      .where(eq(policyHeads.ownerId, 'alice'));
    await expect(retryUnsubmittedApplication(db, 'alice', run.id, command, options)).rejects.toMatchObject({ code: 'POLICY_CHANGED' });
    await db.update(policyHeads).set(head).where(eq(policyHeads.ownerId, 'alice'));
    const next = await retryUnsubmittedApplication(db, 'alice', run.id, { ...command, ...request() }, options);
    expect((await appRows()).find((a) => a.id === unknown.applicationId))
      .toMatchObject({ state: 'failed', reasonCode: 'applicant_confirmed_not_submitted', leaseUntil: null });
    await expect(heartbeatWorker(db, token, { protocolVersion: 1, lease: ref(unknown) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    now += DAY; // The unknown attempt used today's per-employer start.
    expect((await poll(token)).lease).toMatchObject({ applicationId: next.id, mode: 'safe' });
  });

  it('refuses "it did not go through" while the employer window may still be open, so a late finish is never sent twice', async () => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    await db.update(applications).set({ state: 'ready' }).where(eq(applications.id, lease.applicationId));
    const intent = await beginSubmission(db, token, lease.applicationId, {
      protocolVersion: 1, intentId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision,
      identity: { ats: lease.ats, tenant: lease.tenant, requisition: lease.requisition }, company: 'Employer 1', role: 'Software Engineer',
      manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)],
    }, options);
    // Stopped during Greenhouse's emailed-code wait: the worker's window stays open, and the applicant can still finish it there.
    now += 5000;
    const stopped = await commandApplication(db, 'alice', run.id, lease.applicationId, { ...request(), expectedRevision: intent.revision, action: 'emergency-stop' }, options);
    expect(stopped.state).toBe('submission_unknown');
    const retry = () => retryUnsubmittedApplication(db, 'alice', run.id, { ...request(), previousApplicationId: stopped.id, expectedRevision: stopped.revision }, options);
    await expect(retry()).rejects.toMatchObject({ code: 'SUBMISSION_MAY_STILL_COMPLETE' });
    await expect(commandApplication(db, 'alice', run.id, stopped.id, { ...request(), expectedRevision: stopped.revision, action: 'confirm-not-submitted' }, options))
      .rejects.toMatchObject({ code: 'SUBMISSION_MAY_STILL_COMPLETE' });
    expect((await appRows()).map((a) => a.state)).toEqual(['submission_unknown']);
    // Every adapter gives up and closes its window SUBMIT_WAIT_MS after the intent; after that the answer is taken.
    now += SUBMIT_WAIT_MS + LEASE_MS;
    expect(await retry()).toMatchObject({ state: 'queued' });
  });

  it('restarts a live application as a fresh attempt, refuses a submitted one, and deletes by hiding', async () => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    const live = (await appRows()).find((a) => a.id === lease.applicationId)!;
    const command = { ...request(), previousApplicationId: live.id, expectedRevision: live.revision };
    const next = await restartApplication(db, 'alice', run.id, command, options);
    expect(await restartApplication(other, 'alice', run.id, command, options)).toEqual(next);
    const history = await appRows();
    expect(history.find((a) => a.id === live.id)).toMatchObject({ state: 'cancelled', reasonCode: 'restarted', leaseUntil: null });
    expect(history.find((a) => a.id === next.id)).toMatchObject({ state: 'queued', attempt: 2, previousApplicationId: live.id });
    const fresh = history.find((a) => a.id === next.id)!;
    await db.update(applications).set({ state: 'submitted' }).where(eq(applications.id, fresh.id));
    await expect(restartApplication(db, 'alice', run.id, { ...request(), previousApplicationId: fresh.id, expectedRevision: fresh.revision }, options))
      .rejects.toMatchObject({ status: 409 });
    // Delete hides a terminal row without changing its state; the history row stays.
    const hidden = await commandApplication(db, 'alice', run.id, fresh.id, { ...request(), expectedRevision: fresh.revision, action: 'delete' }, options);
    expect(hidden.state).toBe('submitted');
    // Hidden rows stay listed (archived) for 30 days; the attempt a restart replaced left Auto Apply for good.
    expect((await listRuns(db, 'alice', options)).applications.map((a) => [a.id, a.hiddenAt])).toEqual([[fresh.id, now]]);
    expect((await listRuns(db, 'alice', { now: () => now + 30 * 86_400_000 })).applications).toEqual([]);
    expect((await appRows()).find((a) => a.id === fresh.id)?.hiddenAt).toBe(now);
  });

  it('hands a restarted role the answers given to its earlier attempt, so the worker fills them instead of asking again', async () => {
    const { token, run } = await prepared('alice', { actions: ['read_jobs', 'fill_forms'] }); addPostings(1); await complete(token, run.id);
    const field = { key: 'question_1', label: 'Which university do you attend?', kind: 'text' as const, required: true };
    const contextFor = async (lease: Lease) => applicationContext(db, token, lease.applicationId,
      { protocolVersion: 1, ...ref(lease) }, { ...options, corpus: provider });
    const ask = async (lease: Lease) => {
      const { expectedProfileRevision, company, role, questions } = formQuestions(await contextFor(lease), [field]);
      return registerQuestionBatch(db, token, lease.applicationId, { expectedProfileRevision, company, role, questions, questionProtocolVersion: 1, eventId: randomUUID(),
        fence: lease.fence, expectedRevision: lease.revision, checkpoint: { stage: lease.state as 'screening', sequence: (lease.checkpoint?.sequence ?? 0) + 1 } }, options);
    };
    const first = (await poll(token)).lease!;
    const [id] = (await ask(first)).questionIds, q = await getQuestion(db, 'alice', id, options);
    await answerQuestion(db, 'alice', id, { ...request(), expectedRevision: q.revision, expectedProfileRevision: q.expectedProfileRevision,
      expectedPolicyRevision: q.expectedPolicyRevision, expectedScopeHash: q.expectedScopeHash, factVersions: q.factVersions,
      reuse: 'application', answer: { type: 'text', value: 'Stanford University' } }, options);
    const previous = (await appRows()).find((a) => a.id === first.applicationId)!;
    const next = await restartApplication(db, 'alice', run.id, { ...request(), previousApplicationId: previous.id, expectedRevision: previous.revision }, options);
    now += DAY; // The first attempt used today's per-employer start.
    const retry = (await poll(token)).lease!;
    expect(retry.applicationId).toBe(next.id);
    await ask(retry); // Resolved from the earlier attempt's answer.
    expect((await appRows()).find((a) => a.id === next.id)).toMatchObject({ state: 'screening', reasonCode: null });
    expect((await contextFor((await poll(token)).lease!)).answers[formQuestionKey(field)]).toBe('Stanford University');
  });

  it("hands another role the answer to a same-worded form question, under that form's own field key", async () => {
    const { token, run } = await prepared('alice', { actions: ['read_jobs', 'fill_forms'], perEmployerCap: 5 }); addPostings(2); await complete(token, run.id);
    const contextFor = async (lease: Lease) => applicationContext(db, token, lease.applicationId,
      { protocolVersion: 1, ...ref(lease) }, { ...options, corpus: provider });
    const ask = async (lease: Lease, ...fields: AtsField[]) => {
      const { expectedProfileRevision, company, role, questions } = formQuestions(await contextFor(lease), fields);
      return registerQuestionBatch(db, token, lease.applicationId, { expectedProfileRevision, company, role, questions, questionProtocolVersion: 1, eventId: randomUUID(),
        fence: lease.fence, expectedRevision: lease.revision, checkpoint: { stage: lease.state as 'screening', sequence: (lease.checkpoint?.sequence ?? 0) + 1 } }, options);
    };
    const asked = { key: 'question_1', label: 'Which US state do you live in?', kind: 'text' as const, required: true };
    // The first form also asks a question left unanswered, so it waits and the worker moves on to the second.
    const first = (await poll(token)).lease!;
    const [id] = (await ask(first, asked, { key: 'question_2', label: 'Anything else?', kind: 'text' as const, required: true })).questionIds;
    const q = await getQuestion(db, 'alice', id, options);
    await answerQuestion(db, 'alice', id, { ...request(), expectedRevision: q.revision, expectedProfileRevision: q.expectedProfileRevision,
      expectedPolicyRevision: q.expectedPolicyRevision, expectedScopeHash: q.expectedScopeHash, factVersions: q.factVersions,
      reuse: 'application', answer: { type: 'text', value: 'California' } }, options);
    const second = (await poll(token)).lease!;
    expect(second.applicationId).not.toBe(first.applicationId);
    const same = { ...asked, key: 'question_77' };
    await ask(second, same);
    expect((await appRows()).find((a) => a.id === second.applicationId)).toMatchObject({ state: 'screening', reasonCode: null });
    const next = (await poll(token)).lease!;
    expect(next.applicationId).toBe(second.applicationId);
    expect((await contextFor(next)).answers[formQuestionKey(same)]).toBe('California');
  });

  /** Leases the role, re-crawls its posting with `changes`, parks it the way the worker does, and takes the next snapshot. */
  async function recrawled(token: string, runId: string, changes: Partial<typeof postings.$inferInsert>) {
    const contextFor = async (lease: Lease) => applicationContext(db, token, lease.applicationId,
      { protocolVersion: 1, ...ref(lease) }, { ...options, corpus: provider });
    const first = (await poll(token)).lease!;
    const frozen = (await getDiscoveryStatus(db, 'alice', runId, options)).manifestId;
    corpus.update(postings).set(changes).run();
    await expect(contextFor(first)).rejects.toMatchObject({ status: 409, code: 'CONTEXT_UNAVAILABLE' });
    await recordWorkerEvent(db, token, first.applicationId, { protocolVersion: 1, eventId: randomUUID(), fence: first.fence,
      expectedRevision: first.revision, state: 'retryable_failure', checkpoint: { stage: first.state as 'screening', sequence: (first.checkpoint?.sequence ?? 0) + 1 },
      reasonCode: 'context_unavailable' }, options);
    now += DISCOVERY_INTERVAL_MS + 1;
    await complete(token, runId);
    const latest = (await getDiscoveryStatus(db, 'alice', runId, options)).manifestId;
    expect(latest).not.toBe(frozen);
    const previous = (await appRows()).find((a) => a.id === first.applicationId)!;
    const restart = () => restartApplication(db, 'alice', runId, { ...request(), previousApplicationId: previous.id, expectedRevision: previous.revision }, options);
    return { contextFor, latest, restart };
  }

  it('restarts a role whose posting was re-crawled after it was queued from the snapshot that saw the new posting', async () => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const { contextFor, latest, restart } = await recrawled(token, run.id, { description: 'Fixture description, revised by the employer' });
    const next = await restart();
    expect((await appRows()).find((a) => a.id === next.id)).toMatchObject({ snapshotManifestId: latest, attempt: 2, state: 'queued' });
    now += DAY; // The first attempt used today's start.
    const retry = (await poll(token)).lease!;
    expect(retry.applicationId).toBe(next.id);
    expect(await contextFor(retry)).toMatchObject({ applicationId: next.id });
  });

  it('does not queue a re-crawled role that the policy now holds', async () => {
    const { token, run } = await prepared('alice', { employerBlocklist: ['Blocked Co'] }); addPostings(1); await complete(token, run.id);
    const { restart } = await recrawled(token, run.id, { company: 'Blocked Co' });
    await expect(restart()).rejects.toMatchObject({ status: 409 });
    expect(await appRows()).toHaveLength(1);
  });

  it('resumes a document hold the applicant fixed: in its own run, or after a policy change in a run started under it', async () => {
    const { token, run, worker } = await prepared(); addPostings(1); await complete(token, run.id);
    const hold = async () => {
      const lease = (await poll(token)).lease!;
      return recordWorkerEvent(db, token, lease.applicationId, { protocolVersion: 1, eventId: randomUUID(), fence: lease.fence,
        expectedRevision: lease.revision, state: 'needs_document', checkpoint: { stage: lease.state as 'screening', sequence: (lease.checkpoint?.sequence ?? 0) + 1 },
        reasonCode: 'required_document_unavailable' }, options);
    };
    const held = await hold();
    // The transcript was added to the profile: the same run retries from its checkpoint.
    expect(await commandApplication(db, 'alice', run.id, held.applicationId, { ...request(), expectedRevision: held.revision, action: 'retry-safe' }, options))
      .toMatchObject({ state: 'screening' });
    now += 5_000;
    const again = await hold();
    // A second run (another worker's) still on the old policy cannot take the role: it would never lease it.
    const second = await pairedWorker();
    const stale = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: second.worker.workerId }, options);
    await complete(second.token, stale.id);
    // Transcripts allowed in a new policy: the old run stays bound to the old one, so the role continues in a new run.
    const policy: Policy = { ...createEmptyPolicy(), actions: ['read_jobs'], destinations: ['job-boards.greenhouse.io'], undisclosedPay: 'include', documentKinds: ['transcript'] };
    await db.insert(policyVersions).values({ ownerId: 'alice', version: 2, hash: hashValue(policy), policy, createdAt: now });
    await db.update(policyHeads).set({ revision: 2, policyVersion: 2, acceptedPolicyVersion: 2, acceptedPolicyHash: hashValue(policy) })
      .where(eq(policyHeads.ownerId, 'alice'));
    await expect(commandApplication(db, 'alice', run.id, again.applicationId, { ...request(), expectedRevision: again.revision, action: 'retry-safe' }, options))
      .rejects.toMatchObject({ code: 'POLICY_CHANGED' });
    const replacement = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    await complete(token, replacement.id);
    const command = { ...request(), previousApplicationId: again.applicationId, expectedRevision: again.revision };
    await expect(retryUnsubmittedApplication(db, 'alice', run.id, command, options)).rejects.toMatchObject({ status: 409 });
    await expect(retryUnsubmittedApplication(db, 'alice', stale.id, { ...command, ...request() }, options)).rejects.toMatchObject({ code: 'POLICY_CHANGED' });
    expect((await appRows()).find((a) => a.id === again.applicationId)).toMatchObject({ state: 'needs_document', runId: run.id });
    // An exhausted retry budget cannot be reset by moving runs.
    await db.update(applications).set({ retries: 3 }).where(eq(applications.id, again.applicationId));
    await expect(retryUnsubmittedApplication(db, 'alice', replacement.id, { ...command, ...request() }, options)).rejects.toMatchObject({ status: 409 });
    await db.update(applications).set({ retries: 1 }).where(eq(applications.id, again.applicationId));
    const next = await retryUnsubmittedApplication(db, 'alice', replacement.id, command, options);
    const history = await appRows();
    expect(history.find((a) => a.id === again.applicationId)).toMatchObject({ state: 'failed', reasonCode: 'continued_in_new_run' });
    expect(history.find((a) => a.id === next.id)).toMatchObject({ state: 'queued', runId: replacement.id, attempt: 2, previousApplicationId: again.applicationId, retries: 2 });
    now += DAY;
    expect((await poll(token)).lease?.applicationId).toBe(next.id);
  });

  it('keeps default suppression even after cooldown and rejects cross-owner and unapproved reapply', async () => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const previous = await skip((await appRows())[0].id); now += 400 * DAY;
    const command = { ...request(), previousApplicationId: previous.id, expectedRevision: previous.revision };
    await expect(reapplyApplication(db, 'bob', run.id, command, options)).rejects.toMatchObject({ status: 404 });
    await expect(reapplyApplication(db, 'alice', run.id, command, options)).rejects.toMatchObject({ code: 'REAPPLICATION_DISABLED' });
    await discoverWorkerRuns(db, token, provider, options);
    expect(await appRows()).toHaveLength(1);
    expect((await poll(token)).lease).toBeNull();
  });

  it('counts an explicit abandonment as the terminal time when reapplying into a replacement run', async () => {
    const { token, run, worker } = await prepared('alice', { reapplication: { allowed: true, minimumDays: 1 } });
    addPostings(1); await complete(token, run.id);
    // Skipped, so the replacement run's discovery leaves it alone (a stopped, unsubmitted row would come back on its own).
    const first = (await poll(token)).lease!; await skip(first.applicationId);
    now += 2 * DAY; addPostings(201, 2);
    await discoverWorkerRuns(db, token, provider, options);
    const status = await getDiscoveryStatus(db, 'alice', run.id, options);
    await abandonDiscovery(db, 'alice', run.id, { ...request(), manifestId: status.manifestId! }, options);
    const [previous] = await db.select().from(applications).where(eq(applications.id, first.applicationId));
    const replacement = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    await complete(token, replacement.id);
    const command = { ...request(), previousApplicationId: previous.id, expectedRevision: previous.revision };
    await expect(reapplyApplication(db, 'alice', replacement.id, command, options)).rejects.toMatchObject({ code: 'COOLDOWN' });
    now += DAY;
    const next = await reapplyApplication(db, 'alice', replacement.id, command, options);
    expect(next.runId).toBe(replacement.id);
    expect((await appRows()).find((a) => a.id === first.applicationId)).toMatchObject({ state: 'skipped', runId: run.id });
  });
});

describe('owner-confirmed frozen legacy imports', () => {
  it('freezes preview identity despite numeric reuse and preserves missing IDs as unresolved manual evidence', async () => {
    addPostings(1);
    const p = await preview([1, 999]);
    corpus.update(postings).set({ canonicalUrl: 'https://boards.greenhouse.io/changed/jobs/2000' }).run();
    const command = confirmInput(p);
    const result = await confirmLegacyImport(db, 'alice', command, options);
    expect(result).toMatchObject({ status: 'manual_reported', resolvedCount: 1, unresolvedCount: 1, importedPostingIds: [1, 999] });
    const marks = await db.select().from(manualApplicationMarks);
    expect(marks.find((m) => m.postingId === 1)).toMatchObject({ ats: 'greenhouse', tenant: 'tenant1', requisition: '1' });
    expect(marks.find((m) => m.postingId === 999)).toMatchObject({ ats: null, tenant: null, requisition: null });
    expect(await db.select().from(applicationEvents)).toEqual([]);
    expect(await appRows()).toEqual([]);
    now += IMPORT_PREVIEW_TTL_MS + 1;
    expect(await confirmLegacyImport(other, 'alice', command, options)).toEqual(result);
  });

  it('serializes raced previews and confirmations with exact retries; rejects altered commands, hashes, selections and other owners', async () => {
    addPostings(2);
    const input = { ...request(), postingIds: [1, 2] };
    const previews = await Promise.all([
      previewLegacyImport(db, 'alice', provider, input, options),
      previewLegacyImport(other, 'alice', provider, input, options),
    ]);
    expect(previews[0]).toEqual(previews[1]);
    expect(await db.select().from(legacyImportPreviews)).toHaveLength(1);
    const p = previews[0], command = confirmInput(p, [1]);
    await expect(confirmLegacyImport(db, 'bob', command, options)).rejects.toMatchObject({ status: 404 });
    await expect(confirmLegacyImport(db, 'alice', { ...command, postingIds: [3] }, options)).rejects.toMatchObject({ status: 400 });
    await expect(confirmLegacyImport(db, 'alice', { ...command, previewHash: '0'.repeat(64) }, options)).rejects.toMatchObject({ status: 409 });
    const acks = await Promise.all([confirmLegacyImport(db, 'alice', command, options), confirmLegacyImport(other, 'alice', command, options)]);
    expect(acks[0]).toEqual(acks[1]);
    expect(await db.select().from(manualApplicationMarks)).toHaveLength(1);
    await expect(confirmLegacyImport(db, 'alice', { ...command, postingIds: [2] }, options)).rejects.toMatchObject({ status: 409 });
    await expect(previewLegacyImport(db, 'alice', provider, { ...input, postingIds: [2] }, options)).rejects.toMatchObject({ status: 409 });
  });

  it('does not confirm expired previews or silently mint a replacement on retry', async () => {
    addPostings(1); const input = { ...request(), postingIds: [1] };
    const p = await previewLegacyImport(db, 'alice', provider, input, options);
    now = p.expiresAt;
    await expect(confirmLegacyImport(db, 'alice', confirmInput(p), options)).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
    const denied = vi.fn(() => { throw new Error('must not reread'); });
    expect(await previewLegacyImport(db, 'alice', denied, input, options)).toEqual(p);
    expect(denied).not.toHaveBeenCalled();
    expect(await db.select().from(manualApplicationMarks)).toEqual([]);
  });

  it('never picks a role marked applied while its link could not be resolved, once the link resolves', async () => {
    addPostings(1);
    corpus.update(postings).set({ canonicalUrl: 'https://careers.employer1.example/jobs/1' }).run();
    const p = await preview([1]);
    await confirmLegacyImport(db, 'alice', confirmInput(p), options);
    expect((await db.select().from(manualApplicationMarks))[0]).toMatchObject({ postingId: 1, requisition: null });
    // The collector later finds an apply link it can resolve (as with Greenhouse boards on company sites).
    corpus.update(postings).set({ canonicalUrl: 'https://boards.greenhouse.io/tenant1/jobs/1' }).run();
    const { token, run } = await prepared('alice');
    await complete(token, run.id);
    expect(await appRows()).toEqual([]);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).counts.manual_reported).toBe(1);
  });

  it.each(['screening', 'submitting'] as const)('fences an active %s import; preserves reconciliation and forbids stale events', async (state) => {
    const { token, run } = await prepared('alice', { reapplication: { allowed: true, minimumDays: 1 } });
    addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    if (state === 'submitting') await db.update(applications).set({ state }).where(eq(applications.id, lease.applicationId));
    const p = await preview([1]);
    await confirmLegacyImport(db, 'alice', confirmInput(p), options);
    const [app] = await appRows();
    expect(app).toMatchObject({ state: state === 'submitting' ? 'submission_unknown' : 'skipped', leaseUntil: null });
    // A role marked applied by hand can't be retried, so its skipped attempt leaves the list; an unknown submission stays.
    expect((await listRuns(db, 'alice', options)).applications.map((a) => a.id)).toEqual(state === 'screening' ? [] : [app.id]);
    expect(app.fence).toBeGreaterThan(lease.fence);
    await expect(heartbeatWorker(db, token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(recordWorkerEvent(db, token, lease.applicationId, {
      protocolVersion: 1, eventId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision,
      state: 'screening', checkpoint: { stage: 'screening', sequence: 1 }, reasonCode: null,
    }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const next = (await poll(token)).lease;
    if (state === 'submitting') expect(next?.mode).toBe('reconcile'); else expect(next).toBeNull();
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).counts.manual_reported).toBe(1);
    if (state === 'screening') {
      now += DAY;
      await expect(reapplyApplication(db, 'alice', run.id, {
        ...request(), previousApplicationId: app.id, expectedRevision: app.revision,
      }, options)).rejects.toMatchObject({ code: 'DUPLICATE_BLOCKED' });
    }
  });

  it('suppresses marks confirmed during staging and never suppresses another owner', async () => {
    const a = await prepared(); const b = await prepared('bob');
    addPostings(201); await discoverWorkerRuns(db, a.token, provider, options);
    const p = await preview([201]); await confirmLegacyImport(db, 'alice', confirmInput(p), options);
    await stageDiscoveryManifest(db, a.token, (await manifests())[0].id, options);
    expect(await db.select().from(applications).where(and(eq(applications.ownerId, 'alice'), eq(applications.requisition, '201')))).toEqual([]);
    await discoverWorkerRuns(db, b.token, provider, options);
    const [bm] = await db.select().from(discoveryManifests).where(eq(discoveryManifests.runId, b.run.id));
    await stageDiscoveryManifest(db, b.token, bm.id, options);
    expect(await db.select().from(applications).where(eq(applications.ownerId, 'bob'))).toHaveLength(201);
  });

  it('rejects unsafe IDs, duplicate selections and unconfirmed ownership at the command boundary', () => {
    for (const ids of [[], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], [1, 1], Array.from({ length: 1001 }, (_, i) => i + 1)]) {
      expect(ImportPreviewRequestSchema.safeParse({ ...request(), postingIds: ids }).success).toBe(false);
    }
    expect(ImportPreviewRequestSchema.safeParse({ ...request(), postingIds: [1], ownerId: 'bob' }).success).toBe(false);
    expect(ImportConfirmRequestSchema.safeParse({
      ...request(), previewToken: randomUUID(), previewHash: '0'.repeat(64), postingIds: [1], confirmOwnership: false,
    }).success).toBe(false);
  });
});
