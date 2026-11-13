// Pairs and starts the real worker CLI against the local stack described by state.json (see stack.mjs).
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const preload = join(root, 'tests/auto-apply-e2e/worker-preload.mjs');

function run(state, ownerId, command, stdio) {
  const env = { ...state.worker, WORKIE_WORKER_OWNER: ownerId, E2E_WORKER_VAULT: join(state.outside, 'worker-vault.json'),
    ...Object.fromEntries(['E2E_WORKER_HEADED', 'E2E_WORKER_SLOWMO'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])) };
  const child = spawn(process.execPath, ['--import', preload, 'worker/main.ts', command], { cwd: root, env, stdio, detached: true });
  appendFileSync(join(state.out, 'worker.pids'), `${child.pid}\n`);
  return child;
}

/** Runs `worker pair` with the grant on stdin; resolves with its output once paired. */
export function pairWorker(state, ownerId, grant) {
  const log = openSync(join(state.out, 'worker-pair.log'), 'a', 0o600);
  const child = run(state, ownerId, 'pair', ['pipe', log, log]);
  closeSync(log);
  child.stdin.end(grant);
  return new Promise((done, fail) => child.on('exit', (code) => code === 0 ? done() : fail(new Error(`worker pair exited ${code}; see ${state.out}/worker-pair.log`))));
}

/** Runs `worker linkedin` against the stack's stand-in, which signs in by itself; resolves once the worker may send. */
export function signInLinkedin(state, ownerId) {
  const log = openSync(join(state.out, 'worker-linkedin.log'), 'a', 0o600);
  const child = run(state, ownerId, 'linkedin', ['ignore', log, log]);
  closeSync(log);
  return new Promise((done, fail) => child.on('exit', (code) => code === 0 ? done() : fail(new Error(`worker linkedin exited ${code}; see ${state.out}/worker-linkedin.log`))));
}

/** Starts `worker start` in the background (logs to worker.log); stack.mjs also kills it on teardown. */
export function startWorker(state, ownerId) {
  const log = openSync(join(state.out, 'worker.log'), 'a', 0o600);
  const child = run(state, ownerId, 'start', ['ignore', log, log]);
  closeSync(log);
  return { child, stop: () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } } };
}
