// E2E preload for the real worker CLI (node --import this worker/main.ts ...), modeled on worker/fixtures/cli-keychain.mjs.
// Replaces only what a harness cannot drive: the OS keychain (a 0600 file in the stack's private scratch dir,
// so `pair` and `start` share it) and the hidden TTY grant prompt (the grant arrives on stdin).
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PassThrough } from 'node:stream';

const vault = process.env.E2E_WORKER_VAULT;
if (!vault || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.WORKIE_WORKER_ORIGIN ?? '')) throw new Error('E2E_ONLY');
const read = () => { try { return JSON.parse(readFileSync(vault, 'utf8')); } catch { return {}; } };
const write = (items) => writeFileSync(vault, JSON.stringify(items), { mode: 0o600 });

export class Entry {
  constructor(service, account) { this.key = `${service}/${account}`; }
  getPassword() { return read()[this.key] ?? null; }
  setPassword(value) { write({ ...read(), [this.key]: value }); }
  deletePassword() { const items = read(), had = this.key in items; delete items[this.key]; write(items); return had; }
}
registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@napi-rs/keyring' ? { url: import.meta.url, shortCircuit: true } : next(specifier, context);
  },
});

if (process.argv.at(-1) === 'pair') {
  const grant = readFileSync(0, 'utf8').trim();
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true, isRaw: false,
    setRawMode(raw) { this.isRaw = raw; if (raw) queueMicrotask(() => input.write(`${grant}\r`)); },
  });
  Object.defineProperty(process, 'stdin', { value: input });
}

// The worker opens a visible Chrome window; keep it headless unless E2E_WORKER_HEADED=1. The local fixture answers in
// microseconds and reads in about a second, faster than Live's 3 s poll can show; a live form takes tens of seconds,
// so each browser action waits E2E_WORKER_SLOWMO ms (default 400) to give Live a form being read and filled to watch.
{
  const { chromium } = await import('playwright');
  const launch = chromium.launchPersistentContext.bind(chromium);
  const slowMo = Number(process.env.E2E_WORKER_SLOWMO ?? 400);
  chromium.launchPersistentContext = (directory, options) => launch(directory,
    { ...options, slowMo, ...(process.env.E2E_WORKER_HEADED === '1' ? {} : { headless: true }) });
}
