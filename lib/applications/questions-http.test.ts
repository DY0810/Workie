import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as dbModule from '../private-db/index.ts';
import { applications, applicationEvents, policyHeads, policyVersions, questions, rateLimit } from '../private-db/schema.ts';
import { createEmptyPolicy } from './policy.ts';
import { hashValue } from './stores.ts';
import { createPairing, pairWorker, revokeWorker } from './pairing.ts';
import { createRun, commandRun } from './runs.ts';
import { enqueueApplication } from './test-enqueue.ts';
import * as p from './question-protocol.ts';
import { householdApplicant, stubHousehold } from '../test-household.ts';
import { workerTransport } from '../../worker/transport.ts';
import { privateStore } from '../../worker/storage.ts';
import { runWorker } from '../../worker/runtime.ts';
import { GET as inboxRoute } from '../../app/api/inbox/route.ts';
import { GET as statusRoute } from '../../app/api/inbox/status/route.ts';
import { POST as readRoute } from '../../app/api/inbox/read/route.ts';
import { GET as questionRoute } from '../../app/api/questions/[id]/route.ts';
import { POST as answerRoute } from '../../app/api/questions/[id]/answer/route.ts';
import { POST as focusRoute } from '../../app/api/questions/[id]/focus/route.ts';
import { POST as batchRoute } from '../../app/api/worker/applications/[id]/questions/route.ts';
import { POST as interventionRoute } from '../../app/api/worker/interventions/route.ts';
import { POST as ackRoute } from '../../app/api/worker/interventions/[id]/ack/route.ts';
import { POST as pollRoute } from '../../app/api/worker/poll/route.ts';
import { POST as heartbeatRoute } from '../../app/api/worker/heartbeat/route.ts';
import { POST as eventRoute } from '../../app/api/worker/applications/[id]/events/route.ts';

vi.mock('server-only', () => ({}));
type Applicant = { id: string; cookie: string };
let dir: string, origin: string, server: Server, db: dbModule.PrivateDb;
let alice: Applicant, bob: Applicant, children: ChildProcess[], errors: unknown[];
let exchanges: { path: string; body: string; status: number }[], drops: Map<string, number>;
const nativeFetch = globalThis.fetch;
const fresh = (expectedRevision = 0) => ({ requestId: randomUUID(), expectedRevision });
const descriptor = (kind: 'needs_answer' | 'needs_login' | 'needs_verification' = 'needs_answer'): p.QuestionDescriptor => ({
  key: 'hours', kind, originalWording: 'Can you work the stated hours?', reason: 'User confirmation required.',
  required: true, meaning: { id: 'stated-hours', reviewId: null }, schemaVersion: 1,
  scope: { kind: 'applicant', country: null, employer: null, applicationId: null, includesSubsidiaries: false,
    timeframe: 'current', validFrom: null, validUntil: null, ats: 'fixture', tenant: 'synthetic', version: 1 },
  provenance: { source: 'user', sourceId: null, sourceVersion: null, excerpt: null },
  field: { type: kind === 'needs_answer' ? 'boolean' : 'intervention', allowBlank: false, declineValue: null, units: null, precision: null },
  factIds: [], sensitive: false,
});
const row = async (id: string) => (await db.select().from(applications).where(eq(applications.id, id)))[0];
async function http(path: string, body?: unknown, owner?: Applicant, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(owner ? { cookie: owner.cookie, 'x-workie-applicant': owner.id } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function prepared(owner = alice) {
  const options = {};
  const grant = await createPairing(db, owner.id, { ...fresh(), expectedRevision: 0, label: 'Synthetic' }, options);
  const token = randomBytes(32).toString('base64url');
  const worker = await pairWorker(db, { requestId: randomUUID(), protocolVersion: 1, workerId: randomUUID(),
    grant: grant.grant, workerToken: token, workerVersion: '0.1.0', capabilities: ['control-v1'] }, options);
  const run = await createRun(db, owner.id, { ...fresh(), expectedRevision: 0, workerId: worker.workerId }, options);
  const app = await enqueueApplication(db, owner.id, run.id, { ats: 'fixture', tenant: 'synthetic', requisition: 'ask' });
  const scope = { origin, ownerId: owner.id, workerId: worker.workerId };
  const store = await privateStore(join(dir, worker.workerId), scope);
  return { token, run, app, scope, store, transport: workerTransport({ origin, token, allowLoopback: true }), options };
}
type Fixture = Awaited<ReturnType<typeof prepared>>;
async function batch(f: Fixture, kind: Parameters<typeof descriptor>[0] = 'needs_answer', large = false) {
  const lease = (await f.transport.poll()).lease!;
  const input: p.QuestionBatch = { questionProtocolVersion: 1, eventId: randomUUID(), fence: lease.fence,
    expectedRevision: lease.revision, expectedProfileRevision: 0,
    checkpoint: { stage: 'screening', sequence: (lease.checkpoint?.sequence ?? 0) + 1 },
    company: 'Synthetic', role: 'Engineer', questions: [{ ...descriptor(kind),
      ...(large ? { originalWording: 'x'.repeat(4000), reason: 'y'.repeat(4000) } : {}) }] };
  const result = await f.transport.questionBatch(f.app.id, input);
  return { input, result, id: result.questionIds[0] };
}
async function detail(id: string, owner = alice) {
  return p.QuestionDetailSchema.parse(await (await http(`/api/questions/${id}`, undefined, owner)).json());
}
async function answerInput(id: string): Promise<p.AnswerCommand> {
  const q = await detail(id);
  return { ...fresh(q.revision), expectedProfileRevision: q.expectedProfileRevision,
    expectedPolicyRevision: q.expectedPolicyRevision, expectedScopeHash: q.expectedScopeHash,
    factVersions: q.factVersions, reuse: 'application', answer: { type: 'boolean', value: true } };
}
async function focus(id: string) {
  const q = await detail(id);
  return p.FocusResultSchema.parse(await (await http(`/api/questions/${id}/focus`, fresh(q.revision), alice)).json());
}
async function until(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Synthetic fixture deadline exceeded.');
    await delay(20);
  }
}
function processWorker(f: Fixture, mode: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../worker/fixtures/question-worker.mjs', import.meta.url))], {
    cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NODE_ENV: 'test' },
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', data => { output += data; });
  child.stderr!.on('data', data => { output += data; });
  const done = new Promise<number | null>(resolve => child.once('exit', resolve));
  child.stdin!.end(JSON.stringify({ fixture: 'question-integration', scope: f.scope,
    directory: join(dir, f.scope.workerId), token: f.token, mode, descriptor: descriptor() }));
  return { child, done, output: () => output };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase5-http-runtime-'));
  children = []; errors = []; exchanges = []; drops = new Map();
  vi.stubEnv('WORKIE_DB', join(dir, 'corpus-unused.db'));
  vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
  db = dbModule.openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await dbModule.migratePrivateDb(db);
  const routes: Record<string, (r: Request) => Promise<Response>> = {
    '/api/inbox': inboxRoute, '/api/inbox/status': statusRoute, '/api/inbox/read': readRoute,
    '/api/worker/poll': pollRoute, '/api/worker/heartbeat': heartbeatRoute, '/api/worker/interventions': interventionRoute,
  };
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks), headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method!) ? undefined : body });
      const path = new URL(request.url).pathname;
      const q = path.match(/^\/api\/questions\/([^/]+)(?:\/(answer|focus))?$/);
      const w = path.match(/^\/api\/worker\/applications\/([^/]+)\/(questions|events)$/);
      const a = path.match(/^\/api\/worker\/interventions\/([^/]+)\/ack$/);
      let response: Response;
      if (q) response = await ({ answer: answerRoute, focus: focusRoute }[q[2]] ?? questionRoute)(
        request, { params: Promise.resolve({ id: q[1] }) });
      else if (w) response = await (w[2] === 'questions' ? batchRoute : eventRoute)(request, { params: Promise.resolve({ id: w[1] }) });
      else if (a) response = await ackRoute(request, { params: Promise.resolve({ id: a[1] }) });
      else response = await routes[path]?.(request) ?? new Response(null, { status: 404 });
      const bytes = Buffer.from(await response.arrayBuffer());
      exchanges.push({ path, body: body.toString(), status: response.status });
      if (response.ok && (drops.get(path) ?? 0) > 0) { drops.set(path, drops.get(path)! - 1); res.destroy(); return; }
      res.statusCode = response.status;
      for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(bytes);
    } catch (error) { errors.push(error); res.writeHead(500).end('Synthetic fixture error'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(url instanceof Request ? url.url : url).origin !== origin) throw new Error('External network forbidden.');
    return nativeFetch(url, init);
  });
  stubHousehold(origin);
  vi.spyOn(dbModule, 'getPrivateDb').mockReturnValue(db);
  async function enroll(profile: 'dy' | 'may') {
    const owner = await householdApplicant(db, profile);
    const policy = { ...createEmptyPolicy(), actions: ['read_jobs', 'fill_forms'] }, hash = hashValue(policy), now = Date.now();
    await db.insert(policyVersions).values({ ownerId: owner.id, version: 1, policy, hash, createdAt: now });
    await db.insert(policyHeads).values({ ownerId: owner.id, revision: 1, policyVersion: 1, enabled: true,
      acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
    return owner;
  }
  alice = await enroll('dy'); bob = await enroll('may');
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
    await done; clearTimeout(deadline);
  }
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  db?.$client.close();
  const corpusCreated = existsSync(join(dir, 'corpus-unused.db'));
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  expect(errors).toEqual([]); expect(corpusCreated).toBe(false);
});

it('real session routes isolate owners, validate pagination and separate read/answer with exact replay', async () => {
  const f = await prepared(), q = await batch(f);
  expect((await http('/api/inbox')).status).toBe(401);
  const response = await http('/api/inbox?limit=1', undefined, alice);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('cdn-cache-control')).toBe('no-store');
  const page = p.InboxPageSchema.parse(await response.json());
  expect(page).toMatchObject({ ownerId: alice.id, unread: 1, unresolved: 1 });
  expect((await http(`/api/questions/${q.id}`, undefined, bob)).status).toBe(404);
  expect(p.InboxPageSchema.parse(await (await http('/api/inbox?limit=250', undefined, bob)).json()).items).toEqual([]);
  for (const suffix of ['?ownerId=alice', '?limit=1&limit=2', '?limit=1e1', '?limit=01', '?limit=', '?limit=251', '?cursor=not-a-uuid']) {
    expect((await http(`/api/inbox${suffix}`, undefined, alice)).status).toBe(400);
  }
  expect((await http('/api/inbox/status?limit=1', undefined, alice)).status).toBe(400);
  const path = `/api/questions/${q.id}/answer`, answer = await answerInput(q.id);
  const rejectedHeaders: Record<string, string>[] = [
    { 'x-workie-applicant': '' }, { 'x-workie-applicant': bob.id }, { origin: 'https://evil.example.test' },
  ];
  for (const headers of rejectedHeaders) {
    expect((await http(path, answer, alice, headers)).status).toBe(403);
  }
  expect((await http(path, { ...answer, ownerId: alice.id }, alice)).status).toBe(400);
  expect((await http(path, answer, bob)).status).toBe(404);
  expect((await http('/api/inbox/read', { eventIds: [page.items[0].eventId] }, bob)).status).toBe(404);
  expect((await http('/api/inbox/read', { eventIds: [page.items[0].eventId] }, alice)).status).toBe(200);
  expect(p.InboxStatusSchema.parse(await (await http('/api/inbox/status', undefined, alice)).json()))
    .toMatchObject({ unread: 0, unresolved: 1 });
  expect((await http(`/api/questions/${q.id}/review`, {}, alice)).status).toBe(404);
  expect((await http(path, { ...answer, reuse: 'equivalent' }, alice)).status).toBe(400);
  const input = await answerInput(q.id);
  const result = p.AnswerResultSchema.parse(await (await http(path, input, alice)).json());
  expect(result.resumedApplicationIds).toEqual([f.app.id]);
  const count = (await db.select().from(applicationEvents)).length;
  expect(await (await http(path, input, alice)).json()).toEqual({ ...result, replayed: true });
  expect(await db.select().from(applicationEvents)).toHaveLength(count);
  expect((await http(path, { ...input, requestId: randomUUID(), expectedRevision: 999 }, alice)).status).toBe(409);
  expect((await f.transport.poll()).lease).toMatchObject({ applicationId: f.app.id, state: 'screening' });
});

it('worker routes authorize before parsing/bucket allocation, enforce limits, and sanitize private failures', async () => {
  const f = await prepared(), before = (await db.select().from(rateLimit)).length;
  for (const token of ['', 'invalid', randomBytes(32).toString('base64url')]) {
    expect((await http('/api/worker/interventions', { private: 'x'.repeat(140000) }, alice,
      { authorization: `Bearer ${token}` })).status).toBe(401);
  }
  expect(await db.select().from(rateLimit)).toHaveLength(before);
  vi.mocked(dbModule.getPrivateDb).mockClear();
  expect((await interventionRoute(new Request(`${origin}/api/worker/interventions`, { method: 'POST' }))).status).toBe(401);
  expect(dbModule.getPrivateDb).not.toHaveBeenCalled();
  const headers = { authorization: `Bearer ${f.token}` };
  for (const [body, status] of [[{ questionProtocolVersion: 2 }, 426], [{ questionProtocolVersion: 1, ownerId: alice.id }, 400],
    [{ questionProtocolVersion: 1, private: 'x'.repeat(140000) }, 413]] as const) {
    expect((await http('/api/worker/interventions', body, undefined, headers)).status).toBe(status);
  }
  expect((await http('/api/worker/interventions', {}, undefined, { ...headers, 'content-type': 'text/plain' })).status).toBe(415);
  expect((await http('/api/worker/interventions?owner=alice', { questionProtocolVersion: 1 }, undefined, headers)).status).toBe(400);
  await db.update(rateLimit).set({ count: 120 }).where(eq(rateLimit.key, `private-worker:${f.scope.workerId}`));
  const limited = await http('/api/worker/interventions', { questionProtocolVersion: 1 }, undefined, headers);
  expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
  vi.mocked(dbModule.getPrivateDb).mockImplementationOnce(() => { throw new Error(`private-answer ${f.token}`); });
  const failure = await http('/api/worker/interventions', {}, undefined, headers);
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain(f.token);
});

it('valid worker body stalls hit the existing eight-second deadline without delaying reader cancellation', async () => {
  const f = await prepared();
  const req = new Request(`${origin}/api/worker/interventions`, { method: 'POST',
    headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { return new Promise(() => {}); } }),
    duplex: 'half' } as RequestInit);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = interventionRoute(req);
  for (let i = 0; i < 50 && !req.body!.locked; i++) await delay(10);
  expect(req.body!.locked).toBe(true);
  await vi.advanceTimersByTimeAsync(8000);
  expect((await response).status).toBe(408);
  expect(req.body!.locked).toBe(false);
  vi.useRealTimers();
});

it('durable question checkpoint retries exact bytes across a lost acknowledgement and restart without duplicate events', async () => {
  const f = await prepared(), path = `/api/worker/applications/${f.app.id}/questions`;
  drops.set(path, 3);
  await expect(runWorker({ scope: f.scope, store: f.store, transport: f.transport, signal: new AbortController().signal,
    dispatch: async () => ({ kind: 'questions', expectedProfileRevision: 0, company: 'Synthetic', role: 'Engineer', questions: [descriptor()] }),
  })).rejects.toThrow('NETWORK_UNAVAILABLE');
  const pending = await f.store.read('question-checkpoint'), count = (await db.select().from(applicationEvents)).length;
  expect(pending).toMatchObject({ pending: { applicationId: f.app.id } });
  expect((await row(f.app.id)).state).toBe('needs_answer');
  const stop = new AbortController();
  await runWorker({ scope: f.scope, store: f.store, transport: f.transport, signal: stop.signal,
    status: state => { if (state === 'idle') stop.abort(); } });
  const requests = exchanges.filter(e => e.path === path);
  expect(requests).toHaveLength(4); expect(new Set(requests.map(e => e.body)).size).toBe(1);
  expect(await db.select().from(applicationEvents)).toHaveLength(count);
  expect(await f.store.read('question-checkpoint')).toMatchObject({ pending: null });
  expect(await f.store.read('lock')).toBeNull();
});

it('real Node 22 process releases question waits, progresses other work and resumes only after owner answer', async () => {
  const f = await prepared();
  const other = await enqueueApplication(db, alice.id, f.run.id, { ats: 'fixture', tenant: 'other', requisition: 'other' });
  const child = processWorker(f, 'register');
  // Answer only once the worker is idle; an answer that beats its next poll resumes before any heartbeat.
  await until(async () => (await row(f.app.id)).state === 'needs_answer' && (await row(other.id)).state === 'blocked_unsupported' &&
    child.output().includes('"status":"idle"'));
  const [q] = await db.select().from(questions).where(eq(questions.applicationId, f.app.id));
  expect((await row(f.app.id)).leaseUntil).toBeNull();
  const response = await http(`/api/questions/${q.id}/answer`, await answerInput(q.id), alice);
  expect(p.AnswerResultSchema.parse(await response.json()).resumedApplicationIds).toEqual([f.app.id]);
  await until(async () => (await row(f.app.id)).state === 'blocked_unsupported', 24000);
  child.child.kill('SIGTERM');
  expect(await child.done).toBe(0);
  expect(child.output()).not.toContain(f.token);
  expect(exchanges.some(e => e.path === '/api/worker/heartbeat')).toBe(true);
  expect(await f.store.read('lock')).toBeNull();
}, 35000);

it('focus remains pending then unavailable from a real worker process', async () => {
  const f = await prepared(), q = await batch(f, 'needs_login'), requested = await focus(q.id);
  expect(requested.status).toBe('pending'); expect((await detail(q.id)).resolved).toBe(false);
  const first = processWorker(f, 'unavailable');
  await until(async () => (await detail(q.id)).focus?.status === 'unavailable');
  expect((await detail(q.id)).focus?.reason).toBe('browser_not_implemented');
  expect((await row(f.app.id)).state).toBe('needs_login');
  first.child.kill('SIGTERM'); expect(await first.done).toBe(0);
}, 15000);

it.each(['wrong-owner', 'wrong-role', 'stale-fence', 'stop', 'revoke'] as const)(
  'worker intervention %s cannot resolve or resume', async fault => {
    const f = await prepared(), q = await batch(f, 'needs_verification'), requested = await focus(q.id);
    const command = (await f.transport.interventions()).commands.find(c => c.id === requested.id)!;
    const ack: p.InterventionAck = { questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: command.revision,
      expectedApplicationRevision: command.expectedApplicationRevision, fence: command.fence, result: 'observed', reason: null,
      observation: { kind: 'verification_complete', ats: 'fixture', tenant: 'synthetic', requisition: 'ask', observedAt: Date.now() } };
    let transport = f.transport;
    if (fault === 'wrong-owner') transport = (await prepared(bob)).transport;
    if (fault === 'wrong-role') ack.observation!.requisition = 'another-role';
    if (fault === 'stale-fence') ack.fence++;
    if (fault === 'stop') await commandRun(db, alice.id, f.run.id, { ...fresh(f.run.revision), action: 'stop' }, f.options);
    if (fault === 'revoke') await revokeWorker(db, alice.id, f.scope.workerId, fresh(1), f.options);
    await expect(transport.ackIntervention(requested.id, ack)).rejects.toMatchObject({
      status: fault === 'wrong-owner' ? 404 : fault === 'revoke' ? 401 : 409,
    });
    expect((await detail(q.id)).resolved).toBe(false);
    expect((await row(f.app.id)).state).not.toBe('screening');
  });

it('intervention pages fit the real 128 KiB transport budget without truncating descriptors', async () => {
  const f = await prepared(), q = await batch(f, 'needs_login', true);
  for (let i = 0; i < 16; i++) await focus(q.id);
  const response = await http('/api/worker/interventions', { questionProtocolVersion: 1 }, undefined,
    { authorization: `Bearer ${f.token}` });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128 * 1024);
  const page = p.InterventionPageSchema.parse(JSON.parse(text));
  expect(page.commands.length).toBeGreaterThan(0);
  expect(page.commands.every(c => c.descriptor.originalWording === 'x'.repeat(4000) && c.descriptor.reason === 'y'.repeat(4000))).toBe(true);
  expect((await f.transport.interventions()).commands.length).toBe(page.commands.length);
});
