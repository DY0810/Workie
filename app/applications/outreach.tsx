'use client';

import { useCallback, useEffect, useState } from 'react';
import type { BadgeTone } from '../../lib/applications/badges';
import { OUTREACH_DAILY_CAP, OutreachListSchema, OutreachPersonSchema, type OutreachCommand, type OutreachItem, type OutreachList } from '../../lib/applications/outreach-protocol';
import { renderOutreach, unfilledSlots } from '../../lib/outreach-message';
import { linkedinSearches } from '../../lib/recruiters';
import { privateJson, PrivateRequestError } from '../profile/api';
import { StatusBadge } from '../status-badge';
import { Command } from './command';
import styles from '../workers/workers.module.css';

// In the order the tab lists them: what waits on the applicant first.
const BADGES: Record<OutreachItem['state'], { tone: BadgeTone; label: string }> = {
  draft: { tone: 'approval', label: 'draft' }, failed: { tone: 'failed', label: 'not sent' },
  approved: { tone: 'queued', label: 'waiting to send' }, sending: { tone: 'progress', label: 'sending' }, sent: { tone: 'applied', label: 'sent' },
  skipped: { tone: 'skipped', label: 'skipped' },
};
const ORDER = Object.keys(BADGES);
// What the worker reported, in the applicant's terms, with what to do next.
const REASONS: Record<string, string> = {
  dry_run: 'Test run passed: Workie reached the message box for this person and typed nothing. Approve again to send it.',
  approval_expired: 'Approved on an earlier day and not sent, so it came back in case the text says "today". Check it and approve again.',
  prior_thread: 'LinkedIn already shows a conversation with this person, so nothing was sent.',
  login_required: 'The worker is signed out of LinkedIn. On its computer run "npm run worker -- linkedin", sign in, then approve again.',
  profile_moved: 'That profile link now leads somewhere else. Open it, copy the link from the address bar, then approve again.',
  recipient_mismatch: 'The name on that LinkedIn profile does not match the name here, so nothing was sent. Check both.',
  compose_unavailable: 'LinkedIn offers no message box for this person (not an open profile, no credit left, or already written to).',
  thread_not_loaded: 'LinkedIn did not finish loading the conversation, so nothing was sent. Approve again to retry.',
  body_mismatch: 'LinkedIn\'s message box changed the text, so nothing was sent.',
  send_disabled: 'LinkedIn kept its Send button off, so nothing was sent.',
  page_error: 'LinkedIn did not load as expected, so nothing was sent. Approve again to retry.',
  timeout: 'LinkedIn took too long, so nothing was sent. Approve again to retry.',
  browser_unavailable: 'The worker could not open its LinkedIn window, so nothing was sent. Approve again to retry.',
  send_unconfirmed: 'Workie pressed Send but could not confirm the message went. Check LinkedIn: mark it sent if it is there, or reopen it if not.',
};
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/** The server's own words for a refused message ("Sam was already messaged"); the shared helper swaps them for profile copy. */
const said = (error: unknown) => {
  const body = error instanceof PrivateRequestError && [400, 409].includes(error.status) ? error.body as { error?: unknown } | null : null;
  return new Error(typeof body?.error === 'string' ? body.error : error instanceof Error ? error.message : 'Request failed. Retry.');
};
const post = (path: string, ownerId: string, method: string, body: object) =>
  privateJson(path, { method, owner: ownerId, timeout: 15_000, body: JSON.stringify(body) }).then(() => undefined, (error) => { throw said(error); });

function Template({ ownerId, template, onSaved }: { ownerId: string; template: string | null; onSaved: () => void }) {
  const [text, setText] = useState(template ?? '');
  const form = <div className={styles.reviewEdit}>
    <label>Message template<textarea value={text} onChange={(event) => setText(event.target.value)} /></label>
    <p className={styles.muted}>Workie fills {'{Name}'}, {'{Company}'}, {'{Roles}'}, {'{When}'} (&quot;today&quot; or the date) and {'{Overlap}'}.
      Anything else in braces, such as {'{City}'}, you fill in on each message.</p>
    <div className={styles.actions}>
      <Command label={template === null ? 'Turn on outreach' : 'Save template'} busyLabel="Saving..." primary={template === null} onDone={onSaved}
        run={async () => { if (!text.trim()) throw new Error('Write your message first.'); await post('/api/outreach', ownerId, 'PATCH', { template: text }); }} />
    </div>
  </div>;
  return template === null ? <>
    <p className={styles.message}>After Workie submits an application, it drafts one LinkedIn message to a recruiter at that employer.
      You choose the recruiter and approve the message, and your worker sends it from your LinkedIn account; or you send it yourself
      and mark it sent here. Only applications submitted after you turn this on get one.</p>
    {form}
  </> : <details><summary className={styles.muted}>Message template</summary>{form}</details>;
}

function Message({ item, template, now, ownerId, onDone }: { item: OutreachItem; template: string; now: number; ownerId: string; onDone: () => void }) {
  const [name, setName] = useState(item.recruiter?.name ?? '');
  const [title, setTitle] = useState(item.recruiter?.title ?? '');
  const [url, setUrl] = useState(item.recruiter?.url ?? '');
  const [overlap, setOverlap] = useState(item.overlap ?? '');
  const [subject, setSubject] = useState(item.subject ?? '');
  // The applicant's own wording, once they type in the message; until then it follows the template.
  const [edited, setEdited] = useState(item.body);
  const editable = item.state === 'draft' || item.state === 'failed';
  // It may already be in the recruiter's inbox: no second send without a look at LinkedIn and a reopen.
  const unconfirmed = item.reason === 'send_unconfirmed';
  // Slots still in braces fill in as their values arrive, in the template and in edited text alike.
  const text = renderOutreach(edited ?? template, { recruiter: name || null, company: item.company, roles: item.roles, overlap: overlap || null, now });
  const missing = unfilledSlots(`${subject} ${text}`);
  // Edited text does not pick up a role that was applied to later.
  const unnamed = edited === null ? [] : item.roles.filter((role) => !text.includes(role.role)).map((role) => role.role);
  const send = (command: OutreachCommand) => post(`/api/outreach/${item.id}`, ownerId, 'POST', command);
  const person = () => {
    const parsed = OutreachPersonSchema.safeParse({ name, title: title.trim() || null, url });
    if (!parsed.success) throw new Error('Enter the recruiter\'s name and their LinkedIn profile link (linkedin.com/in/...).');
    return parsed.data;
  };
  const finish = (action: 'approve' | 'mark-sent') => async () => {
    const recruiter = person();
    if (!text.trim()) throw new Error('Write the message first.');
    if (missing.length) throw new Error(`Fill in ${missing.join(', ')} first.`);
    await send({ action, recruiter, subject: subject.trim(), body: text.trim() });
  };
  const save = async () => send({ action: 'save', recruiter: name.trim() || url.trim() ? person() : null, overlap: overlap.trim() || null,
    subject: subject.trim() || null, body: edited?.trim() || null });

  return <li className={styles.card}>
    <div className={styles.cardTitle}><h2 title={item.company}>{item.company}</h2><StatusBadge {...BADGES[item.state]} /></div>
    <span className={styles.muted}>{item.roles.map((role) => `${role.role}, applied ${day(role.submittedAt)}`).join(' · ')}</span>
    {!editable && item.recruiter && <span className={styles.muted}>
      To <a href={item.recruiter.url} target="_blank" rel="noreferrer">{item.recruiter.name}</a>{item.recruiter.title && `, ${item.recruiter.title}`}
      {item.sentAt && `, sent ${day(item.sentAt)}`}{item.reason === 'sent_by_applicant' && ' by you'}
      {item.threadUrl && <> · <a href={item.threadUrl} target="_blank" rel="noreferrer">Open thread</a></>}
    </span>}
    {item.state === 'skipped' && item.reason && REASONS[item.reason] && <span className={styles.muted}>{REASONS[item.reason]}</span>}
    {item.state === 'approved' && <span className={styles.muted}>Your worker sends it when it is between applications.</span>}
    {!editable && item.body && <details><summary className={styles.muted}>Message</summary>
      <pre className={styles.preview}>{item.subject ? `${item.subject}\n\n` : ''}{item.body}</pre></details>}
    {editable && <>
      {item.state === 'failed' && <p className={styles.issue}>{REASONS[item.reason ?? ''] ?? 'Workie could not send this.'}</p>}
      {item.state === 'draft' && item.reason && REASONS[item.reason] && <p className={styles.message}>{REASONS[item.reason]}</p>}
      <div className={styles.reviewEdit}>
        <span className={styles.muted}>Find someone who works there now:{linkedinSearches(item.company).map((search, index) =>
          <span key={search.url}>{index ? ' · ' : ' '}<a href={search.url} target="_blank" rel="noreferrer">{search.label}</a></span>)}</span>
        <label>Recruiter&apos;s name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" /></label>
        <label>Their title (optional)<input value={title} onChange={(event) => setTitle(event.target.value)} autoComplete="off" /></label>
        <label>LinkedIn profile link<input type="url" inputMode="url" placeholder="https://www.linkedin.com/in/..." value={url}
          onChange={(event) => setUrl(event.target.value)} autoComplete="off" /></label>
        <label>Overlap line<textarea value={overlap} onChange={(event) => setOverlap(event.target.value)} /></label>
        <label>Subject (optional)<input value={subject} onChange={(event) => setSubject(event.target.value)} autoComplete="off" /></label>
        <label>Message<textarea value={text} onChange={(event) => setEdited(event.target.value)} /></label>
      </div>
      {missing.length > 0 && <p className={styles.issue}>Fill in {missing.join(', ')} before sending.</p>}
      {unnamed.length > 0 && <p className={styles.issue}>This text does not mention: {unnamed.join(', ')}.</p>}
    </>}
    <div className={styles.actions}>
      {editable && <>
        {edited !== null && <button className={styles.button} type="button" onClick={() => setEdited(null)}>Reset to template</button>}
        <Command label="Skip" busyLabel="Skipping..." run={() => send({ action: 'skip' })} onDone={onDone} />
        <Command label="Save" busyLabel="Saving..." run={save} onDone={onDone} />
        <Command label="Mark sent" busyLabel="Saving..." confirm={`Record this as sent to ${name.trim() || 'the recruiter'} by you on LinkedIn?`}
          run={finish('mark-sent')} onDone={onDone} />
        {unconfirmed ? <Command label="Reopen" busyLabel="Reopening..." run={() => send({ action: 'reopen' })} onDone={onDone} />
          : <Command label="Approve and send" busyLabel="Approving..." primary
            confirm={`Send this to ${name.trim() || 'the recruiter'} from your LinkedIn account? It cannot be unsent.`}
            run={finish('approve')} onDone={onDone} />}
      </>}
      {item.state === 'approved' && <Command label="Take back" busyLabel="Taking back..." run={() => send({ action: 'reopen' })} onDone={onDone} />}
      {item.state === 'skipped' && <Command label="Reopen" busyLabel="Reopening..." run={() => send({ action: 'reopen' })} onDone={onDone} />}
    </div>
  </li>;
}

/** The Outreach tab: one LinkedIn recruiter message per employer applied to, each approved by the applicant. */
export default function Outreach({ ownerId }: { ownerId: string }) {
  const [view, setView] = useState<{ list: OutreachList; at: number } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const list = OutreachListSchema.parse(await privateJson('/api/outreach', { owner: ownerId, timeout: 15_000 }));
      if (list.ownerId !== ownerId) throw new PrivateRequestError('Account changed. Refresh the current applicant.', 409, null, '', null);
      setView({ list, at: Date.now() }); setError('');
    } catch (e) { setError(e instanceof PrivateRequestError ? e.message : 'Outreach is unavailable. Retry.'); }
  }, [ownerId]);
  useEffect(() => { void load(); }, [load]);
  // A message on its way to the worker settles within a poll or two, so the tab follows it.
  const pending = view?.list.items.some((item) => item.state === 'approved' || item.state === 'sending') ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [pending, load]);
  const reload = () => void load();

  if (!view) return <p role={error ? 'alert' : 'status'} className={`${styles.message} ${styles.muted}`}>{error || 'Loading messages...'}</p>;
  const { list, at } = view;
  const items = [...list.items].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  return <>
    {error && <p role="alert" className={styles.message}>{error}</p>}
    <Template key={list.template === null ? 'off' : 'on'} ownerId={ownerId} template={list.template} onSaved={reload} />
    {list.template !== null && <>
      <p className={styles.muted}>Workie sends at most {OUTREACH_DAILY_CAP} approved messages in any 24 hours ({list.sentToday} so far), one at a time.
        Your worker has to be signed in to LinkedIn first: on its computer, set up as for its other commands, run{' '}
        <code>npm run worker -- linkedin</code> and sign in.
        The first message after that is a test run that types nothing.</p>
      {!items.length ? <p className={`${styles.message} ${styles.muted}`}>No messages yet. One appears here after Workie submits an application.</p> :
        <ul className={styles.cards} aria-label="Outreach">
          {items.map((item) => <Message key={item.id} item={item} template={list.template!} now={at} ownerId={ownerId} onDone={reload} />)}
        </ul>}
    </>}
  </>;
}
