import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as dbModule from '../private-db/index.ts';
import { workers, workerPairings, policyHeads, policyVersions, applicationRuns, applications, rateLimit } from '../private-db/schema.ts';
import { outreach } from '../private-db/outreach-schema.ts';
import { POST as createPairingRoute } from '../../app/api/workers/pairings/route.ts';
import { GET as listWorkersRoute } from '../../app/api/workers/route.ts';
import { POST as pairRoute } from '../../app/api/worker/pair/route.ts';
import { POST as pollRoute } from '../../app/api/worker/poll/route.ts';
import { POST as heartbeatRoute } from '../../app/api/worker/heartbeat/route.ts';
import { POST as providerConfigRoute } from '../../app/api/worker/provider-config/route.ts';
import { POST as submissionIntentRoute } from '../../app/api/worker/applications/[id]/submission-intent/route.ts';
import { POST as receiptRoute } from '../../app/api/worker/applications/[id]/receipt/route.ts';
import { POST as outreachResultRoute } from '../../app/api/worker/outreach/[id]/result/route.ts';
import { DELETE as revokeRoute } from '../../app/api/workers/[id]/route.ts';
import { POST as createRunRoute } from '../../app/api/application-runs/route.ts';
import { enqueueApplication } from './test-enqueue.ts';
import { createEmptyPolicy } from './policy.ts';
import { createEmptyProfile } from './profile.ts';
import { hashValue } from './stores.ts';
import { ProviderConfigSchema } from './provider-protocol.ts';
import { buildProviderConfig } from './worker-http.ts';
import * as p from './worker-protocol.ts';
import { householdApplicant, stubHousehold } from '../test-household.ts';

vi.mock('server-only', () => ({}));
let db: dbModule.PrivateDb, dir: string, origin: string, server: Server;
let alice: { id: string; cookie: string }, bob: { id: string; cookie: string };
const nativeFetch = globalThis.fetch;
const fresh = (expectedRevision = 0) => ({ requestId: randomUUID(), expectedRevision });
async function http(path: string, body?: unknown, cookie = '', extra: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { origin, ...body === undefined ? {} : { 'content-type': 'application/json' }, cookie, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function paired(owner = alice) {
  const approved = await http('/api/workers/pairings', { ...fresh(), label: 'Synthetic host' }, owner.cookie,
    { 'x-workie-applicant': owner.id });
  expect(approved.status).toBe(200);
  const grant = p.PairingGrantSchema.parse(await approved.json());
  const input: p.PairRequest = { protocolVersion: 1, requestId: randomUUID(), workerId: randomUUID(), grant: grant.grant,
    workerToken: randomBytes(32).toString('base64url'), workerVersion: '0.1.0', capabilities: ['control-v1'] };
  const response = await http('/api/worker/pair', input);
  expect(response.status).toBe(200);
  return { ...p.PairResponseSchema.parse(await response.json()), input, token: input.workerToken, grant };
}
async function running(workerId: string) {
  const policy = createEmptyPolicy(), hash = hashValue(policy), now = Date.now();
  await db.insert(policyVersions).values({ ownerId: alice.id, version: 1, policy, hash, createdAt: now });
  await db.insert(policyHeads).values({ ownerId: alice.id, revision: 1, policyVersion: 1, enabled: true,
    acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
  const created = await http('/api/application-runs', { ...fresh(), workerId }, alice.cookie, { 'x-workie-applicant': alice.id });
  expect(created.status).toBe(200);
  const run = p.RunSchema.parse(await created.json());
  await enqueueApplication(db, alice.id, run.id, { ats: 'fixture', tenant: 'synthetic', requisition: 'role' });
  return run;
}
async function poll(token: string) {
  return http('/api/worker/poll', { protocolVersion: 1 }, '', { authorization: `Bearer ${token}` });
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase3-http-'));
  db = dbModule.openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await dbModule.migratePrivateDb(db);
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) });
      const path = new URL(request.url).pathname;
      let response: Response;
      if (path === '/api/workers/pairings') response = await createPairingRoute(request);
      else if (path === '/api/workers') response = await listWorkersRoute(request);
      else if (path === '/api/worker/pair') response = await pairRoute(request);
      else if (path === '/api/worker/poll') response = await pollRoute(request);
      else if (path === '/api/worker/heartbeat') response = await heartbeatRoute(request);
      else if (path === '/api/worker/provider-config') response = await providerConfigRoute(request);
      else if (path === '/api/application-runs') response = await createRunRoute(request);
      else {
        const submission = path.match(/^\/api\/worker\/applications\/([^/]+)\/submission-intent$/);
        const receipt = path.match(/^\/api\/worker\/applications\/([^/]+)\/receipt$/);
        const sent = path.match(/^\/api\/worker\/outreach\/([^/]+)\/result$/);
        if (submission) response = await submissionIntentRoute(request, { params: Promise.resolve({ id: submission[1] }) });
        else if (receipt) response = await receiptRoute(request, { params: Promise.resolve({ id: receipt[1] }) });
        else if (sent) response = await outreachResultRoute(request, { params: Promise.resolve({ id: sent[1] }) });
        else response = new Response(null, { status: 404 });
      }
      res.statusCode = response.status;
      for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('Synthetic fixture error'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.origin !== origin) throw new Error('External network forbidden.');
    return nativeFetch(url, init);
  });
  stubHousehold(origin);
  vi.spyOn(dbModule, 'getPrivateDb').mockReturnValue(db);
  alice = await householdApplicant(db, 'dy');
  bob = await householdApplicant(db, 'may');
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});
describe('Phase 3 real route handlers over loopback with household auth', () => {
  it('requires session owner precondition and origin, rejects owner authority and never returns credential material', async () => {
    const deniedHeaders: Record<string, string>[] = [{}, { 'x-workie-applicant': bob.id }, { 'x-workie-applicant': alice.id, origin: 'https://evil.example.test' }];
    for (const headers of deniedHeaders) {
      expect((await http('/api/workers/pairings', { ...fresh(), label: 'Host' }, alice.cookie, headers)).status).toBe(403);
    }
    expect((await http('/api/workers/pairings', { ...fresh(), label: 'Host', ownerId: bob.id }, alice.cookie,
      { 'x-workie-applicant': alice.id })).status).toBe(400);
    expect((await http('/api/workers/pairings', { ...fresh(), label: 'Host' }, '', { 'x-workie-applicant': alice.id })).status).toBe(401);
    const worker = await paired();
    const response = await http('/api/workers', undefined, alice.cookie);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('cdn-cache-control')).toBe('no-store');
    const text = await response.text();
    const summary = p.WorkerListSchema.parse(JSON.parse(text));
    expect(summary.workers).toHaveLength(1);
    for (const forbidden of [worker.token, worker.grant.grant, 'credentialBinding', 'tokenHash', 'password']) expect(text).not.toContain(forbidden);
    expect(p.WorkerListSchema.parse(await (await http('/api/workers', undefined, bob.cookie)).json()).workers).toEqual([]);
    const forged = await http('/api/worker/poll', { protocolVersion: 1 }, alice.cookie,
      { 'x-workie-send-token': 'synthetic-shared', authorization: 'Bearer synthetic-session' });
    expect(forged.status).toBe(401);
    expect((await http('/api/worker/pair', { ...worker.input, ownerId: bob.id })).status).toBe(400);
    const denied = await revokeRoute(new Request(`${origin}/api/workers/${worker.workerId}`, { method: 'DELETE',
      headers: { origin, cookie: bob.cookie, 'content-type': 'application/json', 'x-workie-applicant': bob.id }, body: JSON.stringify(fresh(1)) }),
    { params: Promise.resolve({ id: worker.workerId }) });
    expect(denied.status).toBe(404);
  });
  it('returns an owner-scoped provider config and fails closed before any provider credential is involved', async () => {
    const worker = await paired();
    const response = await http('/api/worker/provider-config', { protocolVersion: 1, providerProtocolVersion: 1 }, '',
      { authorization: `Bearer ${worker.token}` });
    expect(response.status).toBe(200);
    const config = ProviderConfigSchema.parse(await response.json());
    expect(config).toMatchObject({ ownerId: alice.id, enabled: false, provider: 'none', maxUsd: 0 });
    expect((await http('/api/worker/provider-config', { protocolVersion: 1, providerProtocolVersion: 1 }, '',
      { authorization: `Bearer ${randomBytes(32).toString('base64url')}` })).status).toBe(401);
    expect((await http('/api/worker/provider-config', { protocolVersion: 2, providerProtocolVersion: 1 }, '',
      { authorization: `Bearer ${worker.token}` })).status).toBe(426);
  });
  it('enables only the priced OpenAI Luna BYOK destination', () => {
    const profile = createEmptyProfile();
    const confirmed = <T extends { state: string; value: unknown; confirmedAt: string | null }>(fact: T, value: T['value']) =>
      ({ ...fact, state: 'confirmed' as const, value, confirmedAt: new Date().toISOString() });
    profile.documentsProvider.provider = confirmed(profile.documentsProvider.provider, 'remote');
    profile.documentsProvider.model = confirmed(profile.documentsProvider.model, 'gpt-6-luna');
    profile.documentsProvider.endpoint = confirmed(profile.documentsProvider.endpoint, 'https://api.openai.com/v1/chat/completions');
    const policy = createEmptyPolicy();
    Object.assign(policy, { privacy: 'approved_remote', remoteProviderConsent: true, allowedProviders: ['byok:compatible'],
      budget: { currency: 'USD', perRequest: 0.1, perRun: 0.5, perDay: 1, allowUnknownCost: false } });
    const current = () => buildProviderConfig('synthetic-owner', { ownerId: 'synthetic-owner', revision: 2, profile },
      { revision: 3, policy, enabled: true, policyVersion: 1, policyHash: null, acceptedPolicyVersion: 1,
        acceptedPolicyHash: null, acceptedAt: null, runnerAvailable: true });
    expect(current()).toMatchObject({ enabled: true, provider: 'byok', pricing: { known: true,
      inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 } });
    profile.documentsProvider.endpoint = confirmed(profile.documentsProvider.endpoint, 'https://other.example/v1/chat/completions');
    expect(current()).toMatchObject({ enabled: false, pricing: { known: false } });
  });
  it('persists a submission intent and exact receipt through authenticated worker routes', async () => {
    const worker = await paired();
    await running(worker.workerId);
    const lease = p.PollResponseSchema.parse(await (await poll(worker.token)).json()).lease!;
    await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 0 } }).where(eq(applications.id, lease.applicationId));
    const identity = { ats: lease.ats, tenant: lease.tenant, requisition: lease.requisition };
    const intent = await http(`/api/worker/applications/${lease.applicationId}/submission-intent`, {
      protocolVersion: 1, intentId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision, identity,
      company: 'Fixture Co', role: 'Synthetic Intern', manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)],
    }, '', { authorization: `Bearer ${worker.token}` });
    expect(intent.status).toBe(200);
    const started = p.SubmissionIntentResponseSchema.parse(await intent.json());
    const receipt = await http(`/api/worker/applications/${lease.applicationId}/receipt`, {
      protocolVersion: 1, intentId: started.intentId, identity, company: 'Fixture Co', role: 'Synthetic Intern',
      receiptId: 'receipt-123', submittedAt: Date.now(),
      evidence: { source: 'confirmation_page', pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Fixture Co Synthetic Intern' },
    }, '', { authorization: `Bearer ${worker.token}` });
    expect(receipt.status).toBe(200);
    expect(p.ReceiptResponseSchema.parse(await receipt.json())).toMatchObject({ state: 'submitted', replayed: false });
    expect((await db.select().from(applications).where(eq(applications.id, lease.applicationId)))[0]).toMatchObject({ state: 'submitted' });
  });
  it('hands an approved recruiter message to its owner\'s asking worker and takes that worker\'s report', async () => {
    const worker = await paired(), other = await paired(bob), id = randomUUID(), now = Date.now();
    await db.insert(outreach).values({ id, ownerId: alice.id, companyKey: 'fixture co', company: 'Fixture Co',
      roles: [{ applicationId: randomUUID(), role: 'Synthetic Intern', submittedAt: now }],
      recruiter: { name: 'Sam Fixture', title: null, url: 'https://www.linkedin.com/in/sam-fixture' },
      subject: '', body: 'Hi Sam.', state: 'approved', createdAt: now, updatedAt: now });
    const ask = async (token: string, outreach = true) => p.PollResponseSchema.parse(await (await http('/api/worker/poll',
      { protocolVersion: 1, ...(outreach ? { outreach: true } : {}) }, '', { authorization: `Bearer ${token}` })).json());
    const report = (token: string | null, body: object) => http(`/api/worker/outreach/${id}/result`, { protocolVersion: 1, ...body }, '',
      token ? { authorization: `Bearer ${token}` } : {});
    // Never to another applicant's worker, nor to a worker that did not ask.
    expect((await ask(other.token)).outreach).toBeUndefined();
    expect((await ask(worker.token, false)).outreach).toBeUndefined();
    expect((await ask(worker.token)).outreach).toMatchObject({ id, name: 'Sam Fixture', body: 'Hi Sam.', approvedAt: now });
    expect((await ask(worker.token)).outreach).toBeUndefined();
    const sent = { outcome: 'sent', threadUrl: 'https://www.linkedin.com/messaging/thread/2-abc/' };
    expect((await report(null, sent)).status).toBe(401);
    expect((await report(other.token, sent)).status).toBe(404);
    expect((await report(worker.token, { outcome: 'sent', threadUrl: 'https://evil.example.test/' })).status).toBe(400);
    const taken = await report(worker.token, sent);
    expect([taken.status, await taken.json()]).toEqual([200, { state: 'sent' }]);
    expect((await db.select().from(outreach).where(eq(outreach.id, id)))[0]).toMatchObject({ state: 'sent', threadUrl: sent.threadUrl });
  });

  it('PIN rotation revokes workers and pauses leases, while browser sessions stay valid', async () => {
    const worker = await paired();
    const run = await running(worker.workerId);
    const lease = p.PollResponseSchema.parse(await (await poll(worker.token)).json()).lease!;
    expect((await poll(worker.token)).status).toBe(200);
    vi.stubEnv('WORKIE_HOUSEHOLD_PASSCODE', '1357');
    expect((await poll(worker.token)).status).toBe(401);
    const heartbeat = await http('/api/worker/heartbeat', { protocolVersion: 1, lease: {
      applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision,
    } }, '', { authorization: `Bearer ${worker.token}` });
    expect(heartbeat.status).toBe(401);
    expect((await db.select().from(applicationRuns).where(eq(applicationRuns.id, run.id)))[0].state).toBe('paused');
    expect((await db.select().from(applications))[0].leaseUntil).toBeNull();
    expect((await db.select().from(workers))[0].revokedAt).not.toBeNull();
    expect((await db.select().from(workerPairings))[0].revokedAt).not.toBeNull();
    expect((await http('/api/workers', undefined, bob.cookie)).status).toBe(200);
  });
  it('PIN rotation also invalidates pending pairing grants', async () => {
    const worker = await paired();
    const approved = await http('/api/workers/pairings', { ...fresh(), label: 'Unconsumed host' }, alice.cookie,
      { 'x-workie-applicant': alice.id });
    const pending = p.PairingGrantSchema.parse(await approved.json());
    vi.stubEnv('WORKIE_HOUSEHOLD_PASSCODE', '1357');
    expect((await http('/api/worker/pair', { ...worker.input, requestId: randomUUID(), workerId: randomUUID(),
      workerToken: randomBytes(32).toString('base64url'), grant: pending.grant })).status).toBe(401);
    expect((await db.select().from(workerPairings).where(eq(workerPairings.id, pending.pairingId)))[0].revokedAt).not.toBeNull();
    expect((await poll(worker.token)).status).toBe(401);
  });
  it('rejects unsupported versions, oversized bodies and unsupported media, and applies durable bounded rate buckets', async () => {
    const worker = await paired();
    expect((await http('/api/worker/poll', { protocolVersion: 2 }, '', { authorization: `Bearer ${worker.token}` })).status).toBe(426);
    expect((await http('/api/worker/pair', { ...worker.input, capabilities: ['submit-anything'] })).status).toBe(426);
    expect((await http('/api/worker/poll', { protocolVersion: 1, oversized: 'x'.repeat(128 * 1024) }, '',
      { authorization: `Bearer ${worker.token}` })).status).toBe(413);
    expect((await http('/api/worker/poll', {}, '', { authorization: `Bearer ${worker.token}`, 'content-type': 'text/plain' })).status).toBe(415);
    await db.update(rateLimit).set({ count: 120 }).where(eq(rateLimit.key, `private-worker:${worker.workerId}`));
    const limited = await poll(worker.token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    const before = (await db.select().from(rateLimit)).length;
    for (let i = 0; i < 3; i++) expect((await poll(randomBytes(32).toString('base64url'))).status).toBe(401);
    expect((await db.select().from(rateLimit)).length).toBe(before);
  });
  it('times out an unending JSON body and does not pair from a URL or revoke on a forged session', async () => {
    const input = new Request(`${origin}/api/worker/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }),
      duplex: 'half',
    } as RequestInit);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = pairRoute(input);
    await vi.advanceTimersByTimeAsync(8_100);
    const response = await pending;
    expect(response.status).toBe(408);
    vi.useRealTimers();
    const badPath = await pairRoute(new Request(`${origin}/api/worker/pair?grant=forbidden`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }));
    expect(badPath.status).toBe(400);
    expect((await http('/api/workers', undefined, `${alice.cookie}invalid`)).status).toBe(401);
  });
});
