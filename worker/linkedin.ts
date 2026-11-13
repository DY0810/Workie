import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { z } from "zod";
import { createBrowserRuntime, type BrowserRuntime } from "./browser.ts";
import type { PrivateStore } from "./storage.ts";
import type { OUTREACH_NOT_SENT, OutreachTask } from "../lib/applications/outreach-protocol.ts";

export const LINKEDIN_ORIGIN = "https://www.linkedin.com";
// What a real compose page loaded on 2026-11-13. Its ad and tracking hosts stay blocked.
const LINKEDIN_ORIGINS = [LINKEDIN_ORIGIN, "https://static.licdn.com", "https://media.licdn.com", "https://platform.linkedin.com"];
// Read from linkedin.com on 2026-11-13. The messaging pages keep these class names; the profile page's are generated,
// so only its link target is used there.
const COMPOSE_LINK = 'main a[href*="/messaging/compose/"]';
const PILL = ".msg-connections-typeahead__added-recipients .artdeco-pill__text";
const PRIOR = ".msg-s-event-listitem";
const LOADING = ".msg-s-message-list__loader:not(.hidden)";
const EDITOR = "form.msg-form .msg-form__contenteditable[contenteditable='true']";
const SEND = "form.msg-form button.msg-form__send-button";
// From the hand-sent messages of 2026-11-12, not seen since: it shows only for someone who is not a connection.
const SUBJECT = 'input[placeholder^="Subject"]';
// Longer than every wait below added up; past it the window is closed whatever it was doing.
const SEND_BUDGET_MS = 4 * 60_000;

export type SendOutcome = { outcome: "sent"; threadUrl: string | null }
  | { outcome: "not_sent"; reasonCode: typeof OUTREACH_NOT_SENT[number] } | { outcome: "unknown" };
const notSent = (reasonCode: typeof OUTREACH_NOT_SENT[number]): SendOutcome => ({ outcome: "not_sent", reasonCode });

const words = (name: string) => name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Every word of the name the applicant approved is in the name LinkedIn shows ("Sam Fixture" in "Sam Fixture, MBA"). */
export const sameRecipient = (approved: string, shown: string) => {
  const have = new Set(words(shown)), want = words(approved);
  return want.length > 0 && want.every((word) => have.has(word));
};
/** The profile's own name: its tab title without the unread count ("(5) ") and the site's suffix; "" for any other title. */
export const profileName = (title: string) => / \| LinkedIn$/.test(title) ? title.replace(/^\(\d+\+?\)\s*/, "").replace(/ \| LinkedIn$/, "").trim() : "";
const localDay = (at: number) => new Date(at).toLocaleDateString("en-CA");
/** The message may say "today", so it goes out on the day it was approved or not at all. This computer's clock is the applicant's. */
export const approvalExpired = (approvedAt: number, now = Date.now()) => localDay(approvedAt) !== localDay(now);
const wall = (url: string) => /^\/(?:login|authwall|checkpoint|uas|signup)(?:\/|$)/.test(new URL(url).pathname);

/**
 * Sends one approved message from the signed-in LinkedIn window, or says why it did not. Nothing is typed until the
 * profile, the recipient and an empty thread have all been checked. `seen` collects what the pages showed, for the log.
 */
export async function sendLinkedinMessage(browser: Pick<BrowserRuntime, "page" | "navigate">, task: OutreachTask, options: {
  origin?: string; dryRun?: boolean; signal?: AbortSignal; beforeClick?: () => Promise<void>; seen?: Record<string, unknown>;
} = {}): Promise<SendOutcome> {
  const origin = options.origin ?? LINKEDIN_ORIGIN, seen = options.seen ?? {};
  let clicked = false, expired = false;
  const run = async (): Promise<SendOutcome> => {
    const page = await browser.page();
    const handle = decodeURIComponent(new URL(task.profileUrl).pathname.split("/")[2]);
    await browser.navigate(page, `${origin}/in/${encodeURIComponent(handle)}/`);
    const link = page.locator(COMPOSE_LINK).first();
    if (!wall(page.url())) await link.waitFor({ state: "attached", timeout: 30_000 }).catch(() => {});
    if (wall(page.url())) return notSent("login_required");
    const at = new URL(page.url()).pathname.split("/");
    if (at[1] !== "in" || decodeURIComponent(at[2] ?? "").toLowerCase() !== handle) return notSent("profile_moved");
    const shown = profileName(await page.title());
    if (!sameRecipient(task.name, shown)) return notSent("recipient_mismatch");
    // No link: LinkedIn offers no message to this person (not an open profile, and no credit to spend).
    const href = await link.count() ? await link.getAttribute("href") : null;
    const compose = href ? new URL(href, page.url()) : null;
    // The link opens an overlay on the profile; without `interop` it is the same compose box on a page of its own.
    compose?.searchParams.delete("interop");
    seen.composeLink = !!compose;
    if (!compose || compose.origin !== origin || compose.pathname !== "/messaging/compose/") return notSent("compose_unavailable");
    await browser.navigate(page, compose.href);

    const pills = page.locator(PILL), prior = page.locator(PRIOR), editor = page.locator(EDITOR), send = page.locator(SEND);
    // Someone already written to shows the old thread and, often, no box at all: wait for either.
    await page.locator(`${EDITOR}, ${PRIOR}`).first().waitFor({ state: "attached", timeout: 30_000 }).catch(() => {});
    await pills.first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
    if (wall(page.url())) return notSent("login_required");
    // The first link on a profile can be someone else's ("People also viewed"); the one recipient here must be the profile's.
    const recipient = async () => await pills.count() === 1 && words(await pills.first().innerText()).join(" ") === words(shown).join(" ");
    seen.recipients = await pills.count();
    if (!await recipient()) return notSent("recipient_mismatch");
    seen.prior = await prior.count();
    if (seen.prior) return notSent("prior_thread");
    seen.box = await editor.count() === 1 && await send.count() === 1;
    if (!seen.box) return notSent("compose_unavailable");
    // Nothing on the page says "history loaded" for a new recipient, so the thread must read empty twice, a moment apart.
    await page.waitForTimeout(2_000);
    if (await prior.count()) return notSent("prior_thread");
    if (await page.locator(LOADING).count()) return notSent("thread_not_loaded");
    seen.subject = await page.locator(SUBJECT).count() > 0;
    seen.free = /free message/i.test(await page.locator("form.msg-form").innerText());
    if (options.dryRun) return notSent("dry_run");

    const subject = page.locator(SUBJECT).first();
    if (task.subject && seen.subject) await subject.fill(task.subject, { timeout: 10_000 });
    // One paragraph per line, as the box itself builds them. Typing Enter is avoided: it can send.
    const lines = task.body.replace(/\r\n?/g, "\n").split("\n");
    const write = (text: string[]) => editor.evaluate((node, text) => {
      node.replaceChildren(...text.map((line) => {
        const paragraph = document.createElement("p");
        paragraph.append(line || document.createElement("br"));
        return paragraph;
      }));
      node.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }, text);
    await write(lines);
    const typed = await editor.evaluate((node) => [...node.querySelectorAll("p")].map((paragraph) => paragraph.textContent ?? "").join("\n"));
    const ready = typed === lines.join("\n") && await page.waitForFunction((selector) => {
      const button = document.querySelector<HTMLButtonElement>(selector);
      return !!button && !button.disabled;
    }, SEND, { timeout: 10_000 }).then(() => true, () => false);
    // A last look before the one step that cannot be undone.
    const reason = !ready ? (typed === lines.join("\n") ? "send_disabled" : "body_mismatch")
      : await prior.count() ? "prior_thread" : !await recipient() ? "recipient_mismatch" : null;
    if (reason) { await write([""]); return notSent(reason); }
    await options.beforeClick?.();
    if (expired) { await write([""]); return notSent("timeout"); }
    clicked = true;
    await send.click({ timeout: 10_000 });
    // Sent once the thread shows the whole approved text (spacing aside): the box above was filled by script, so only
    // the thread says what LinkedIn took. The thread's address is kept when LinkedIn moves to it.
    const shownInThread = await page.waitForFunction(({ selector, body }) =>
      [...document.querySelectorAll(selector)].some((item) => (item.textContent ?? "").replace(/\s+/g, "").includes(body)),
    { selector: PRIOR, body: lines.join("").replace(/\s+/g, "") }, { timeout: 30_000 }).then(() => true, () => false);
    if (!shownInThread) return { outcome: "unknown" };
    const path = new URL(page.url()).pathname;
    return { outcome: "sent", threadUrl: /^\/messaging\/thread\/(?!new\/)[^/]+\/?$/.test(path) ? `${LINKEDIN_ORIGIN}${path}` : null };
  };
  let stop: () => void = () => {};
  const cut = new Promise<SendOutcome>((resolve) => {
    // Past the budget, or on shutdown: not sent unless Send was already pressed. `run` checks `expired` right before pressing.
    stop = () => { expired = true; resolve(clicked ? { outcome: "unknown" } : notSent("timeout")); };
  });
  const timer = setTimeout(stop, SEND_BUDGET_MS);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    return await Promise.race([cut, run().catch((error): SendOutcome => clicked ? { outcome: "unknown" }
      : notSent(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "page_error"))]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
}

const MarkerSchema = z.strictObject({ signedInAt: z.iso.datetime(), verified: z.boolean() });
const userDataDir = (directory: string) => join(directory, "browser", "linkedin");

/**
 * The worker's LinkedIn side: it asks for messages only once the applicant has signed in (`npm run worker -- linkedin`),
 * and its first message after that is a rehearsal that types nothing, since the real pages can change under it.
 */
export function linkedinOutreach(options: {
  store: PrivateStore; directory: string; origin?: string; headless?: boolean;
  log?: (entry: Record<string, unknown>) => void;
}) {
  const marker = async () => MarkerSchema.safeParse(await options.store.read("linkedin")).data;
  return {
    enabled: async () => !!await marker(),
    send: async (task: OutreachTask, beforeClick: () => Promise<void>, signal?: AbortSignal): Promise<SendOutcome> => {
      const signedIn = await marker(), seen: Record<string, unknown> = {};
      let result: SendOutcome;
      if (!signedIn) result = notSent("login_required");
      else if (approvalExpired(task.approvedAt)) result = notSent("approval_expired");
      else {
        // A window of its own: LinkedIn's session never shares a profile with the employers' forms.
        const browser = await createBrowserRuntime({ userDataDir: userDataDir(options.directory), headless: options.headless ?? false,
          approvedOrigins: options.origin ? [options.origin] : LINKEDIN_ORIGINS, allowLoopback: !!options.origin }).catch(() => null);
        if (!browser) result = notSent("browser_unavailable");
        else {
          try { result = await sendLinkedinMessage(browser, task, { origin: options.origin, dryRun: !signedIn.verified, signal, beforeClick, seen }); }
          finally { await browser.close().catch(() => {}); }
        }
      }
      const reasonCode = result.outcome === "not_sent" ? result.reasonCode : undefined;
      // Signed out: stop asking for messages until the applicant signs in again.
      if (reasonCode === "login_required") await options.store.remove("linkedin");
      if (reasonCode === "dry_run" && signedIn) await options.store.write("linkedin", { ...signedIn, verified: true });
      // Ids and codes only: never a name or the message.
      options.log?.({ status: "outreach", id: task.id, outcome: result.outcome, ...(reasonCode ? { reasonCode } : {}), ...seen });
      return result;
    },
  };
}

/**
 * Opens LinkedIn in the worker's own window for the applicant to sign in themself. Nothing is typed for them and no
 * page is filtered here, so a security check can load. True once LinkedIn shows a signed-in page.
 */
export async function linkedinSignIn(options: { store: PrivateStore; directory: string; signal: AbortSignal; origin?: string; headless?: boolean }) {
  const directory = userDataDir(options.directory), origin = options.origin ?? LINKEDIN_ORIGIN;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const context = await chromium.launchPersistentContext(directory, { headless: options.headless ?? false, timeout: 60_000 });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    for (let waited = 0; waited < 15 * 60 && !options.signal.aborted && context.pages().length; waited++) {
      const at = context.pages()[0]?.url() ?? "";
      const session = (await context.cookies(origin).catch(() => [])).some((cookie) => cookie.name === "li_at");
      if (at.startsWith(`${origin}/`) && !wall(at) && (session || new URL(at).pathname.startsWith("/feed"))) {
        const previous = MarkerSchema.safeParse(await options.store.read("linkedin")).data;
        await options.store.write("linkedin", { signedInAt: new Date().toISOString(), verified: previous?.verified ?? false });
        return true;
      }
      await delay(1000);
    }
    return false;
  } finally { await context.close().catch(() => {}); }
}
