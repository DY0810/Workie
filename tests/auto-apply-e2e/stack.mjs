// Local full-stack Auto Apply harness: real Next server, real local SQLite catalog + private DB,
// a fake local Ollama for tailoring, and (from the spec) a real worker filling the fixture form.
//
//   node tests/auto-apply-e2e/stack.mjs            # bring the stack up; Ctrl-C tears it down
//   node tests/auto-apply-e2e/stack.mjs test       # bring it up, run the Playwright spec, tear down
//   add --no-build to reuse the existing .next build
//
// Nothing here reads .env files, TURSO_* or the keychain: every child gets an allowlisted env.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { seedRole } from './catalog.mjs';
import { linkedinStandIn } from '../../worker/linkedin-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const mode = args.includes('test') ? 'test' : 'up';
assert.equal(process.version.split('.')[0], 'v22', 'Use Node 22 (the worker refuses other majors)');
assert.deepEqual(readdirSync(root).filter((name) => /^\.env(?:$|\.)/.test(name) && name !== '.env.example'), [],
  'Refusing to start: a .env file here would be loaded by Next (it could point at production)');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = join(root, 'logs/auto-apply-e2e', stamp);
// Documents and the worker directory must live outside the repository (both refuse otherwise), with no symlinked parent.
const outside = join(realpathSync(tmpdir()), `workie-auto-apply-e2e-${stamp}`);
for (const dir of [out, outside, join(outside, 'documents'), join(outside, 'worker')]) mkdirSync(dir, { recursive: true, mode: 0o700 });

async function freePort() {
  const server = createNetServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

const children = new Set();
function launch(name, command, commandArgs, env, options = {}) {
  const fd = openSync(join(out, `${name}.log`), 'a', 0o600);
  const child = spawn(command, commandArgs, { cwd: root, env, detached: true, stdio: ['ignore', fd, fd], ...options });
  closeSync(fd);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function killAll(signal = 'SIGTERM') {
  for (const child of children) try { process.kill(-child.pid, signal); } catch { /* already gone */ }
  // Workers the spec started (tests/auto-apply-e2e/worker.mjs records their pids).
  try {
    for (const pid of readFileSync(join(out, 'worker.pids'), 'utf8').split('\n').filter(Boolean)) {
      try { process.kill(-Number(pid), signal); } catch { try { process.kill(Number(pid), signal); } catch { /* gone */ } }
    }
  } catch { /* none started */ }
}
let fake, linkedin;
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  killAll('SIGTERM');
  await delay(2000);
  killAll('SIGKILL');
  fake?.close();
  linkedin?.close();
  process.exit(code);
}
process.on('SIGINT', () => void stop(130));
process.on('SIGTERM', () => void stop(143));

// shortcut: deterministic stand-in for Ollama's /api/chat (one tailor edit, first label), upgrade to a real model only to test model quality.
function startFakeOllama(port) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const request = JSON.parse(body);
        const prompt = request.messages.at(-1).content;
        const input = JSON.parse(prompt.slice(prompt.indexOf('Task:\n') + 6));
        calls.push(input.task);
        let content;
        if (input.task === 'classify_question') content = { task: input.task, label: input.allowedLabels[0], confidence: 0.9 };
        else if (input.task === 'tailor') {
          // A real, shorter edit: the anchor without its last word.
          const anchor = input.anchors.find((item) => item.text.trim().split(/\s+/).length > 2) ?? input.anchors[0];
          content = { task: 'tailor', confidence: 0.9, edits: [{ anchorId: anchor.id,
            replacement: anchor.text.trim().split(/\s+/).slice(0, -1).join(' ').slice(0, anchor.maxChars - 1), evidenceIds: [input.evidence[0].id] }] };
        } else throw new Error(`fake ollama: unsupported task ${input.task}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: request.model, message: { role: 'assistant', content: JSON.stringify(content) },
          done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 10 }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error.message) }));
      }
      writeFileSync(join(out, 'ollama-calls.json'), JSON.stringify(calls));
    });
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}

try {
  const port = await freePort(), ollamaPort = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const catalog = join(out, 'catalog.db'), privateDb = join(out, 'private.db');
  const node = process.execPath;
  // Homebrew/TeX for the worker's document tools (pdftotext, soffice, xelatex).
  const PATH = `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const passcode = String(randomInt(1e9, 1e10));
  const serverEnv = {
    PATH, HOME: process.env.HOME, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    WORKIE_DB: catalog, WORKIE_PRIVATE_DATABASE_URL: `file:${privateDb}`,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), BETTER_AUTH_URL: `${baseURL}/`,
    WORKIE_HOUSEHOLD_PASSCODE: passcode,
    WORKIE_HOUSEHOLD_DY_EMAIL: 'dy-e2e@example.com', WORKIE_HOUSEHOLD_MAY_EMAIL: 'may-e2e@example.com',
    WORKIE_DRAFT_ENCRYPTION_KEY: randomBytes(32).toString('base64'), WORKIE_DRAFT_KEY_VERSION: '1',
    WORKIE_DOCUMENT_STORAGE: 'local', WORKIE_DOCUMENT_DIRECTORY: join(outside, 'documents'),
  };

  // Catalog: a fresh SQLite file with only the first fixture role; the spec adds the second mid-run (catalog.mjs).
  await seedRole(catalog, '4000001', { migrate: true });

  // Private DB: the app refuses a group/world-readable file, so create it 0600 before migrating.
  closeSync(openSync(privateDb, 'wx', 0o600));
  const migrate = launch('private-migrate', node, ['--conditions=react-server', 'scripts/private-migrate.ts'], serverEnv);
  assert.equal(await new Promise((done) => migrate.on('exit', done)), 0, `private migrate failed; see ${out}/private-migrate.log`);

  if (!args.includes('--no-build') || !existsSync(join(root, '.next/BUILD_ID'))) {
    console.log(`Building Next (logs: ${out}/build.log)...`);
    const build = launch('build', node, ['node_modules/next/dist/bin/next', 'build'],
      { PATH, HOME: process.env.HOME, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', WORKIE_DB: join(out, 'build-must-not-create.db') });
    assert.equal(await new Promise((done) => build.on('exit', done)), 0, `next build failed; see ${out}/build.log`);
  }

  fake = await startFakeOllama(ollamaPort);
  // The worker's recruiter messages go to a local stand-in, never to linkedin.com.
  linkedin = await linkedinStandIn({ session: true });
  launch('server', node, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], serverEnv);
  for (let attempt = 0; ; attempt++) {
    if (await fetch(`${baseURL}/sign-in`).then((r) => r.status < 500, () => false)) break;
    assert.ok(attempt < 120, `Next did not become ready; see ${out}/server.log`);
    await delay(1000);
  }

  const state = {
    baseURL, out, outside, passcode, catalog, dyEmail: serverEnv.WORKIE_HOUSEHOLD_DY_EMAIL,
    ollama: { endpoint: `http://127.0.0.1:${ollamaPort}/api/chat`, model: 'e2e-fake' },
    worker: { PATH, HOME: process.env.HOME, WORKIE_WORKER_ORIGIN: baseURL, WORKIE_WORKER_DIRECTORY: join(outside, 'worker'),
      WORKIE_WORKER_ALLOW_LOOPBACK: '1', WORKIE_WORKER_LINKEDIN_ORIGIN: linkedin.origin, WORKIE_DB: join(out, 'worker-must-not-create.db') },
  };
  writeFileSync(join(out, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`Stack up at ${baseURL}\nState: ${join(out, 'state.json')}`);

  if (mode === 'test') {
    const test = spawn(node, ['node_modules/@playwright/test/cli.js', 'test', '--config=tests/auto-apply-e2e/playwright.config.ts'],
      { cwd: root, stdio: 'inherit', env: { ...process.env, E2E_STATE: join(out, 'state.json') } });
    const code = await new Promise((done) => test.on('exit', (c) => done(c ?? 1)));
    await stop(code);
  } else {
    console.log(`Run the spec against it: E2E_STATE=${join(out, 'state.json')} npx playwright test --config=tests/auto-apply-e2e/playwright.config.ts\nCtrl-C to stop.`);
  }
} catch (error) {
  console.error(error);
  await stop(1);
}
