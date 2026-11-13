import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createBrowserRuntime } from "./browser.ts";
import { approvalExpired, linkedinOutreach, linkedinSignIn, profileName, sameRecipient, sendLinkedinMessage } from "./linkedin.ts";
import { linkedinStandIn } from "./linkedin-fixture.mjs";
import { privateStore } from "./storage.ts";

// Everything here runs against a local stand-in for LinkedIn (linkedin-fixture.mjs). It cannot show that the real pages
// still look like that: the worker's first message after sign-in is a rehearsal for that reason.
let standIn, sent, origin, browser, directory;
before(async () => {
  standIn = await linkedinStandIn();
  ({ sent, origin } = standIn);
  directory = await mkdtemp(join(tmpdir(), "workie-linkedin-"));
  browser = await createBrowserRuntime({ userDataDir: join(directory, "check"), approvedOrigins: [origin], allowLoopback: true, headless: true });
});
after(async () => {
  await browser?.close().catch(() => {});
  standIn?.close();
  await rm(directory, { recursive: true, force: true });
});

const BODY = `Hi Sam, I applied to the <b>Intern</b> role & wanted to say "hello".\n\nSecond paragraph.\nIts second line.`;
const task = (handle, name = "Sam Fixture", extra = {}) => ({ id: randomUUID(), name, profileUrl: `https://www.linkedin.com/in/${handle}`,
  subject: "A question", body: BODY, approvedAt: Date.now(), ...extra });

test("sends the approved text once, to the profile's own recipient, and reports the thread", async () => {
  const order = [];
  const result = await sendLinkedinMessage(browser, task("sam-fixture"), { origin, beforeClick: async () => { order.push(`before:${sent.length}`); } });
  assert.deepEqual(result, { outcome: "sent", threadUrl: "https://www.linkedin.com/messaging/thread/2-sam-fixture/" });
  // The exact lines, as text (never markup), and the outcome was journaled before Send was pressed.
  assert.deepEqual(sent.splice(0), [{ recipient: "sam-fixture", subject: "A question", lines: BODY.split("\n") }]);
  assert.deepEqual(order, ["before:0"]);
});

test("types nothing unless the profile, the recipient and an empty thread all check out", async () => {
  const cases = [
    ["threaded", "Thread Fixture", "prior_thread"],
    // History that loads a moment after the box does is still found.
    ["late-thread", "Late Fixture", "prior_thread"],
    // The profile's first message link belongs to someone else.
    ["wrong-link", "Wrong Fixture", "recipient_mismatch"],
    // The applicant approved a message to another name than the profile's.
    ["sam-fixture", "Pat Other", "recipient_mismatch"],
    ["bare", "Bare Fixture", "compose_unavailable"],
    ["signed-out", "Sam Fixture", "login_required"],
    ["moved", "Sam Fixture", "profile_moved"],
  ];
  for (const [handle, name, reasonCode] of cases) {
    let pressed = 0;
    assert.deepEqual(await sendLinkedinMessage(browser, task(handle, name), { origin, beforeClick: async () => { pressed++; } }),
      { outcome: "not_sent", reasonCode }, handle);
    assert.equal(pressed, 0, handle);
  }
  assert.deepEqual(sent, []);
});

test("a rehearsal runs every check, types nothing, and says what the pages showed", async () => {
  const seen = {};
  assert.deepEqual(await sendLinkedinMessage(browser, task("sam-fixture"), { origin, dryRun: true, seen }), { outcome: "not_sent", reasonCode: "dry_run" });
  assert.deepEqual(seen, { composeLink: true, recipients: 1, prior: 0, box: true, subject: true, free: false });
  assert.equal((await (await browser.page()).locator(".msg-form__contenteditable").innerText()).trim(), "");
  assert.deepEqual(sent, []);
});

test("a send the thread never shows is reported as unconfirmed, never as not sent", async () => {
  let pressed = 0;
  assert.deepEqual(await sendLinkedinMessage(browser, task("silent", "Silent Fixture"), { origin, beforeClick: async () => { pressed++; } }), { outcome: "unknown" });
  assert.equal(pressed, 1);
  // No subject box on this page: the message still goes, without one.
  assert.deepEqual(sent.splice(0), [{ recipient: "silent", subject: null, lines: BODY.split("\n") }]);
  // A thread that shows only part of the approved text is not a confirmed send either.
  assert.deepEqual(await sendLinkedinMessage(browser, task("clipped", "Clipped Fixture"), { origin }), { outcome: "unknown" });
  assert.equal(sent.splice(0).length, 1);
});

test("a shutdown before Send is pressed sends nothing, even at the last moment", async () => {
  const stopped = new AbortController();
  stopped.abort();
  assert.deepEqual(await sendLinkedinMessage(browser, task("sam-fixture"), { origin, signal: stopped.signal }), { outcome: "not_sent", reasonCode: "timeout" });
  const late = new AbortController();
  assert.deepEqual(await sendLinkedinMessage(browser, task("sam-fixture"), { origin, signal: late.signal, beforeClick: async () => late.abort() }),
    { outcome: "not_sent", reasonCode: "timeout" });
  assert.deepEqual(sent, []);
});

test("names match by word, and an approval lasts for its own day", () => {
  assert.equal(profileName("(12) Sam Fixture, MBA | LinkedIn"), "Sam Fixture, MBA");
  assert.equal(profileName("LinkedIn"), "");
  assert.equal(sameRecipient("Sam Fixture", "Sam Fixture, MBA"), true);
  assert.equal(sameRecipient("Sám  FIXTURE", "Sam Fixture"), true);
  assert.equal(sameRecipient("Sam Fixture", "Samuel Fixture"), false);
  assert.equal(sameRecipient(" ", "Sam Fixture"), false);
  const noon = new Date(2026, 10, 12, 12).getTime();
  assert.equal(approvalExpired(noon, noon + 6 * 3_600_000), false);
  assert.equal(approvalExpired(noon, noon + 13 * 3_600_000), true);
});

test("the worker asks for messages only once signed in, rehearses the first one, and stops when signed out", async () => {
  const store = await privateStore(join(directory, "store"), { origin: "https://workie.example", ownerId: "synthetic-owner-a", workerId: randomUUID() });
  const logs = [], pressed = [];
  const outreach = linkedinOutreach({ store, directory, origin, headless: true, log: (entry) => logs.push(entry) });
  const run = (item) => outreach.send(item, async () => { pressed.push(item.id); });
  assert.equal(await outreach.enabled(), false);
  assert.deepEqual(await run(task("sam-fixture")), { outcome: "not_sent", reasonCode: "login_required" });
  await store.write("linkedin", { signedInAt: new Date().toISOString(), verified: false });
  assert.equal(await outreach.enabled(), true);
  // An approval from an earlier day never opens the window.
  assert.deepEqual(await run(task("sam-fixture", "Sam Fixture", { approvedAt: Date.now() - 2 * 86_400_000 })), { outcome: "not_sent", reasonCode: "approval_expired" });
  assert.deepEqual(await run(task("sam-fixture")), { outcome: "not_sent", reasonCode: "dry_run" });
  assert.deepEqual(sent, []);
  assert.equal((await store.read("linkedin")).verified, true);
  const real = task("sam-fixture");
  assert.equal((await run(real)).outcome, "sent");
  assert.equal(sent.splice(0).length, 1);
  assert.deepEqual(pressed, [real.id]);
  assert.deepEqual(await run(task("signed-out")), { outcome: "not_sent", reasonCode: "login_required" });
  assert.equal(await outreach.enabled(), false);
  // The log names messages by id and outcome only.
  assert.equal(logs.length, 5);
  assert.doesNotMatch(JSON.stringify(logs), /Sam|Fixture|Hi |question/);
  assert.deepEqual(logs[3], { status: "outreach", id: real.id, outcome: "sent", composeLink: true, recipients: 1, prior: 0, box: true, subject: true, free: false });
});

test("the sign-in command waits for the applicant to sign in, and keeps a passed rehearsal", async () => {
  const store = await privateStore(join(directory, "sign-in-store"), { origin: "https://workie.example", ownerId: "synthetic-owner-a", workerId: randomUUID() });
  const signIn = (signal = new AbortController().signal) => linkedinSignIn({ store, directory: join(directory, "sign-in"), origin, headless: true, signal });
  // Given up on (the command was stopped): nothing is recorded.
  assert.equal(await signIn(AbortSignal.abort()), false);
  assert.equal(await store.read("linkedin"), null);
  assert.equal(await signIn(), true);
  assert.equal((await store.read("linkedin")).verified, false);
  await store.write("linkedin", { ...await store.read("linkedin"), verified: true });
  assert.equal(await signIn(), true);
  assert.equal((await store.read("linkedin")).verified, true);
});
