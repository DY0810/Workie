import { chmod, mkdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';

export class BrowserEgressError extends Error {
  readonly code = 'BROWSER_EGRESS_BLOCKED';
}

type BrowserOptions = {
  userDataDir: string;
  approvedOrigins: readonly string[];
  headless?: boolean;
  allowLoopback?: boolean;
};

function privateAddress(value: string) {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    const first = parts[0], second = parts[1];
    return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) || (first === 198 && (second === 18 || second === 19)) || first >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('2001:db8:') || normalized.startsWith('::ffff:');
  }
  return true;
}

async function publicHost(hostname: string, allowLoopback: boolean) {
  const literal = isIP(hostname) !== 0;
  if (literal) return !privateAddress(hostname) || (allowLoopback && privateAddress(hostname) && /^127\./.test(hostname));
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.length > 0 && answers.every(({ address }) => !privateAddress(address));
}

function canonicalOrigins(origins: readonly string[]) {
  const values = origins.map((value) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new BrowserEgressError('Invalid approved origin.'); }
    if (url.username || url.password || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^127\.0\.0\.1$/.test(url.hostname)))) {
      throw new BrowserEgressError('Invalid approved origin.');
    }
    return url.origin;
  });
  return new Set(values);
}

/** An approved origin, or one label under an approved "https://*.parent" entry (hCaptcha's per-load probe hosts). */
export function originApproved(url: URL, origins: ReadonlySet<string>) {
  return origins.has(url.origin) || (url.protocol === 'https:' && !url.port &&
    origins.has(`https://*.${url.hostname.split('.').slice(1).join('.')}`));
}

async function assertUrl(value: string, origins: ReadonlySet<string>, allowLoopback: boolean) {
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserEgressError('Invalid browser URL.'); }
  if (!originApproved(url, origins) || !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.hash || !(await publicHost(url.hostname, allowLoopback))) {
    throw new BrowserEgressError('Browser egress is outside the approved public origin.');
  }
  return url;
}

export type BrowserRuntime = {
  context: BrowserContext;
  /** This application's own tab, the same one on every call. */
  page(): Promise<Page>;
  navigate(page: Page, url: string): Promise<Page>;
  close(): Promise<void>;
};

/** One persistent context; each request is checked against the origins of the tab that made it. */
type Host = { context: BrowserContext; allowed: WeakMap<Page, ReadonlySet<string>>; idle: Page[] };

async function launch(options: BrowserOptions): Promise<Host> {
  await mkdir(options.userDataDir, { recursive: true, mode: 0o700 });
  await chmod(options.userDataDir, 0o700);
  const context = await chromium.launchPersistentContext(options.userDataDir, {
    headless: options.headless ?? true,
    serviceWorkers: 'block',
    // A busy computer can take well over 15 s to start Chrome; every fill then failed before opening the form.
    timeout: 60_000,
  });
  const allowed = new WeakMap<Page, ReadonlySet<string>>();
  await context.route('**/*', async (route) => {
    try {
      // A tab no application owns (a popup, the idle tab) reaches nothing.
      const origins = allowed.get(route.request().frame().page());
      if (!origins) throw new BrowserEgressError('Unassigned tab.');
      await assertUrl(route.request().url(), origins, options.allowLoopback === true);
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  });
  return { context, allowed, idle: [...context.pages()] };
}

function validate(options: BrowserOptions) {
  if (!isAbsolute(options.userDataDir)) throw new BrowserEgressError('Persistent browser directory is required.');
  const origins = canonicalOrigins(options.approvedOrigins);
  if (!origins.size) throw new BrowserEgressError('At least one approved origin is required.');
  return origins;
}

function tab(host: Host, origins: ReadonlySet<string>, allowLoopback: boolean): BrowserRuntime {
  let page: Promise<Page> | undefined;
  return {
    context: host.context,
    page: () => page ??= (async () => {
      // A blank tab the applicant closed between applications is gone; handing it out failed the next one at once.
      let opened = host.idle.pop();
      while (opened?.isClosed()) opened = host.idle.pop();
      opened ??= await host.context.newPage();
      host.allowed.set(opened, origins);
      return opened;
    })(),
    navigate: async (target, url) => {
      await assertUrl(url, origins, allowLoopback);
      // Like the launch, a page can take well over 15 s to load on a busy computer.
      await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await assertUrl(target.url(), origins, allowLoopback);
      return target;
    },
    close: async () => {
      const opened = await page;
      if (!opened || opened.isClosed()) return;
      host.allowed.delete(opened);
      // The last tab is blanked rather than closed so the window stays up between applications.
      if (host.context.pages().length > 1) return opened.close();
      await opened.goto('about:blank');
      host.idle.push(opened);
    },
  };
}

/** A browser of its own for one application, closed with it. */
export async function createBrowserRuntime(options: BrowserOptions): Promise<BrowserRuntime> {
  const origins = validate(options);
  const host = await launch(options);
  return { ...tab(host, origins, options.allowLoopback === true), close: () => host.context.close() };
}

const hosts = new Map<string, Promise<Host>>();

/**
 * The worker's one browser window: each application opens in a new tab of it, and closing the
 * application closes only its tab. Relaunched if the applicant closes the window.
 */
export async function openApplicationTab(options: BrowserOptions): Promise<BrowserRuntime> {
  const origins = validate(options);
  let host = hosts.get(options.userDataDir);
  if (!host) {
    host = launch(options);
    hosts.set(options.userDataDir, host);
    host.then((value) => value.context.on('close', () => hosts.delete(options.userDataDir)), () => hosts.delete(options.userDataDir));
  }
  return tab(await host, origins, options.allowLoopback === true);
}
