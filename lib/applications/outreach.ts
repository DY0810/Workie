import 'server-only';
import { and, desc, eq, gt, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { applications, applicationSubmissions, outreach, outreachSettings } from '../private-db/schema.ts';
import { unfilledSlots } from '../outreach-message.ts';
import { savedLetter } from './materials.ts';
import { OUTREACH_DAILY_CAP, type OutreachCommand, type OutreachItem, type OutreachList, type OutreachTask } from './outreach-protocol.ts';
import type { OutreachResult } from './worker-protocol.ts';
import { PrivateInputError } from './private-http.ts';
import { fail, nowAt, one, randomUUID, withWorker, workerTransaction, type WorkerOptions, type WorkerTx } from './worker-store.ts';

type Row = typeof outreach.$inferSelect;
/** The same key discovery gives an employer, so "Skydio" and "skydio " are one company. */
const companyKey = (company: string) => company.trim().toLowerCase().replace(/\s+/g, ' ');
const item = (row: Row): OutreachItem => ({
  id: row.id, company: row.company, roles: row.roles, recruiter: row.recruiter,
  overlap: row.overlap, subject: row.subject, body: row.body, state: row.state, reason: row.reason,
  createdAt: row.createdAt, sentAt: row.sentAt, threadUrl: row.threadUrl,
});

// The worker reports within minutes. Past this, a message it took is treated as possibly sent.
const SENDING_STALE_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Counts toward the daily cap: what the worker sent, or may have sent, in the last 24 hours. */
const sentByWorker = (row: Row, now: number) => row.updatedAt > now - DAY_MS &&
  ((row.state === 'sent' && row.reason === 'sent_by_worker') || (row.state === 'failed' && row.reason === 'send_unconfirmed'));
const stale = (row: Row, now: number) => row.state === 'sending' && row.updatedAt <= now - SENDING_STALE_MS;
/** A message the worker took and never reported on may have gone out: it fails as unconfirmed and is not sent again unasked. */
const expireSending = (tx: Pick<PrivateDb, 'update'>, ownerId: string, now: number) =>
  tx.update(outreach).set({ state: 'failed', reason: 'send_unconfirmed', updatedAt: now })
    .where(and(eq(outreach.ownerId, ownerId), eq(outreach.state, 'sending'), lte(outreach.updatedAt, now - SENDING_STALE_MS)));

type Reader = Pick<PrivateDb, 'select'>;
/** The queue as stored, plus the submitted applications that still need a draft (`fresh`, oldest first). */
async function read(db: Reader, ownerId: string) {
  const [settings] = await db.select().from(outreachSettings).where(eq(outreachSettings.ownerId, ownerId));
  const rows = await db.select().from(outreach).where(eq(outreach.ownerId, ownerId)).orderBy(desc(outreach.createdAt));
  if (!settings) return { settings: null, rows, fresh: [] };
  // A submission the applicant confirmed by hand has no receipt time; its intent time stands in.
  const at = sql<number>`coalesce(${applicationSubmissions.submittedAt}, ${applicationSubmissions.createdAt})`;
  // Only applications submitted since outreach was turned on, and never one the employer may not have received.
  const submitted = await db.select({ applicationId: applicationSubmissions.applicationId, company: applicationSubmissions.company,
    role: applicationSubmissions.role, at }).from(applicationSubmissions)
    .innerJoin(applications, and(eq(applications.ownerId, applicationSubmissions.ownerId), eq(applications.id, applicationSubmissions.applicationId)))
    .where(and(eq(applicationSubmissions.ownerId, ownerId), eq(applications.state, 'submitted'), gte(at, settings.enabledAt)))
    .orderBy(at);
  const draft = new Map(rows.map((row) => [row.companyKey, row.state === 'draft']));
  const queued = new Set(rows.flatMap((row) => row.roles.map((role) => role.applicationId)));
  // One message per employer names every role; once it is approved, sent or skipped, a later role adds nothing.
  return { settings, rows, fresh: submitted.filter((item) => !queued.has(item.applicationId) && draft.get(companyKey(item.company)) !== false) };
}

/** The queue, after drafting a message for each employer newly applied to. Run on read, so the submit path is untouched. */
export async function listOutreach(db: PrivateDb, ownerId: string, options: WorkerOptions = {}): Promise<OutreachList> {
  const now = nowAt(options);
  let state = await read(db, ownerId);
  // Only a new submission (or a send the worker never reported) writes, so opening the tab otherwise takes no write lock.
  if (state.fresh.length || state.rows.some((row) => stale(row, now))) state = await workerTransaction(db, async (tx) => {
    await expireSending(tx, ownerId, now);
    const { rows, fresh } = await read(tx, ownerId);
    const byCompany = new Map(rows.map((row) => [row.companyKey, row]));
    for (const application of fresh) {
      const key = companyKey(application.company), existing = byCompany.get(key);
      const role = { applicationId: application.applicationId, role: application.role, submittedAt: application.at };
      if (existing) {
        byCompany.set(key, one(await tx.update(outreach).set({ roles: [...existing.roles, role], updatedAt: now })
          .where(and(eq(outreach.ownerId, ownerId), eq(outreach.id, existing.id))).returning()));
        continue;
      }
      // The cover letter's company paragraph is the first draft of the overlap line, when a letter went out.
      // shortcut: an application with no letter starts with a blank line; draft it on the worker if that is common.
      const letter = await savedLetter(tx, ownerId, application.applicationId);
      byCompany.set(key, one(await tx.insert(outreach).values({ id: randomUUID(), ownerId, companyKey: key, company: application.company,
        roles: [role], overlap: letter?.companyParagraph ?? null, createdAt: now, updatedAt: now }).returning()));
    }
    return read(tx, ownerId);
  });
  return { ownerId, template: state.settings?.template ?? null, enabledAt: state.settings?.enabledAt ?? null,
    sentToday: state.rows.filter((row) => sentByWorker(row, now)).length, items: state.rows.map(item) };
}

/**
 * Inside the worker's poll: hands over the oldest approved message, one in flight per applicant and at most
 * OUTREACH_DAILY_CAP a day. It becomes `sending` here, before the worker opens LinkedIn, so it is never handed over twice.
 */
export async function claimOutreach(tx: WorkerTx, ownerId: string, now: number): Promise<OutreachTask | null> {
  // The one read every asking poll makes: with nothing approved or in flight it ends here.
  const waiting = await tx.select().from(outreach)
    .where(and(eq(outreach.ownerId, ownerId), inArray(outreach.state, ['approved', 'sending']))).orderBy(outreach.updatedAt);
  if (!waiting.length) return null;
  if (waiting.some((row) => row.state === 'sending')) {
    if (waiting.some((row) => row.state === 'sending' && !stale(row, now))) return null;
    await expireSending(tx, ownerId, now);
  }
  const next = waiting.find((row) => row.state === 'approved');
  if (!next) return null;
  const recent = await tx.select().from(outreach).where(and(eq(outreach.ownerId, ownerId), gt(outreach.updatedAt, now - DAY_MS)));
  if (recent.filter((row) => sentByWorker(row, now)).length >= OUTREACH_DAILY_CAP) return null;
  one(await tx.update(outreach).set({ state: 'sending', updatedAt: now })
    .where(and(eq(outreach.ownerId, ownerId), eq(outreach.id, next.id), eq(outreach.state, 'approved'))).returning());
  // `updatedAt` was the approval until this claim replaced it.
  return { id: next.id, name: next.recruiter!.name, profileUrl: next.recruiter!.url, subject: next.subject ?? '', body: next.body!, approvedAt: next.updatedAt };
}

/** The worker's report on a message it took. A row that is no longer `sending` was settled already, so a repeat is only acknowledged. */
export async function recordOutreachResult(db: PrivateDb, token: string, id: string, input: OutreachResult, options: WorkerOptions = {}) {
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [row] = await tx.select().from(outreach).where(and(eq(outreach.ownerId, worker.ownerId), eq(outreach.id, id)));
    if (!row) fail(404, 'NOT_FOUND', 'Message not found.');
    // A confirmed send still counts when its report arrives after the row timed out as unconfirmed.
    const late = input.outcome === 'sent' && row.state === 'failed' && row.reason === 'send_unconfirmed';
    if (row.state !== 'sending' && !late) return { state: row.state };
    const set = input.outcome === 'sent' ? { state: 'sent' as const, reason: 'sent_by_worker', sentAt: now, threadUrl: input.threadUrl }
      : input.outcome === 'unknown' ? { state: 'failed' as const, reason: 'send_unconfirmed' }
      // Nothing was typed. An expired approval or a rehearsal returns to the applicant; an existing thread is never written to.
      : input.reasonCode === 'approval_expired' || input.reasonCode === 'dry_run' ? { state: 'draft' as const, reason: input.reasonCode }
      : input.reasonCode === 'prior_thread' ? { state: 'skipped' as const, reason: 'prior_thread' }
      : { state: 'failed' as const, reason: input.reasonCode };
    return { state: one(await tx.update(outreach).set({ ...set, updatedAt: now })
      .where(and(eq(outreach.ownerId, worker.ownerId), eq(outreach.id, id), eq(outreach.state, row.state))).returning()).state };
  });
}

/** Saves the template. The first save turns outreach on, and only applications submitted after it are queued. */
export async function saveOutreachSettings(db: PrivateDb, ownerId: string, input: { template: string }, options: WorkerOptions = {}) {
  const now = nowAt(options);
  await db.insert(outreachSettings).values({ ownerId, template: input.template, enabledAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: outreachSettings.ownerId, set: { template: input.template, updatedAt: now } });
  return listOutreach(db, ownerId, options);
}

export async function commandOutreach(db: PrivateDb, ownerId: string, id: string, command: OutreachCommand, options: WorkerOptions = {}): Promise<OutreachItem> {
  return workerTransaction(db, async (tx) => {
    const now = nowAt(options);
    const [row] = await tx.select().from(outreach).where(and(eq(outreach.ownerId, ownerId), eq(outreach.id, id)));
    if (!row) throw new PrivateInputError(404, 'Message not found.');
    const from = (...states: Row['state'][]) => {
      if (!states.includes(row.state)) throw new PrivateInputError(409, 'This message changed. Refresh and try again.', 'CONFLICT');
    };
    let set: Partial<typeof outreach.$inferInsert>;
    if (command.action === 'save') {
      from('draft');
      set = { recruiter: command.recruiter, overlap: command.overlap, subject: command.subject, body: command.body };
    } else if (command.action === 'approve' || command.action === 'mark-sent') {
      from('draft', 'failed');
      // It may be in the recruiter's inbox already, so sending again takes a look at LinkedIn and a reopen first.
      if (command.action === 'approve' && row.reason === 'send_unconfirmed') {
        throw new PrivateInputError(409, 'This message may already have been sent. Check LinkedIn, then mark it sent or reopen it.', 'CHECK_LINKEDIN');
      }
      const unfilled = unfilledSlots(`${command.subject} ${command.body}`);
      if (unfilled.length) throw new PrivateInputError(400, `Fill in ${unfilled.join(', ')} before sending.`, 'UNFILLED');
      // "Even once": a person already messaged, or about to be, is never written to again.
      const others = await tx.select({ recruiter: outreach.recruiter, state: outreach.state, reason: outreach.reason }).from(outreach)
        .where(and(eq(outreach.ownerId, ownerId), ne(outreach.id, id)));
      // Also someone LinkedIn already shows a thread with, and someone a send may have reached.
      if (others.some((other) => other.recruiter?.url === command.recruiter.url && (['approved', 'sending', 'sent'].includes(other.state) ||
        other.reason === 'prior_thread' || other.reason === 'send_unconfirmed'))) {
        throw new PrivateInputError(409, `${command.recruiter.name} was already messaged.`, 'ALREADY_MESSAGED');
      }
      set = { recruiter: command.recruiter, subject: command.subject, body: command.body,
        ...(command.action === 'approve' ? { state: 'approved', reason: null }
          : { state: 'sent', reason: 'sent_by_applicant', sentAt: now }) };
    } else if (command.action === 'skip') {
      from('draft', 'failed', 'approved');
      set = { state: 'skipped', reason: null };
    } else {
      from('approved', 'skipped', 'failed');
      set = { state: 'draft', reason: null };
    }
    return item(one(await tx.update(outreach).set({ ...set, updatedAt: now })
      .where(and(eq(outreach.ownerId, ownerId), eq(outreach.id, id), eq(outreach.state, row.state))).returning()));
  });
}
