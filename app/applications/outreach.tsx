'use client';

import { useCallback, useEffect, useState } from 'react';
import type { BadgeTone } from '../../lib/applications/badges';
import { OutreachListSchema, OutreachPersonSchema, type OutreachCommand, type OutreachItem, type OutreachList } from '../../lib/applications/outreach-protocol';
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
      You choose the recruiter, send it on LinkedIn, and mark it sent here. Only applications submitted after you turn this on get one.</p>
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
  const finish = (action: 'mark-sent') => async () => {
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
    {!editable && item.body && <details><summary className={styles.muted}>Message</summary>
      <pre className={styles.preview}>{item.subject ? `${item.subject}\n\n` : ''}{item.body}</pre></details>}
    {editable && <>
      {item.state === 'failed' && <p className={styles.issue}>Workie could not send this{item.reason && ` (${item.reason.replaceAll('_', ' ')})`}.</p>}
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
        <Command label="Mark sent" busyLabel="Saving..." primary confirm={`Record this as sent to ${name.trim() || 'the recruiter'} by you on LinkedIn?`}
          run={finish('mark-sent')} onDone={onDone} />
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
  const reload = () => void load();

  if (!view) return <p role={error ? 'alert' : 'status'} className={`${styles.message} ${styles.muted}`}>{error || 'Loading messages...'}</p>;
  const { list, at } = view;
  const items = [...list.items].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  return <>
    {error && <p role="alert" className={styles.message}>{error}</p>}
    <Template key={list.template === null ? 'off' : 'on'} ownerId={ownerId} template={list.template} onSaved={reload} />
    {list.template !== null && <>
      {!items.length ? <p className={`${styles.message} ${styles.muted}`}>No messages yet. One appears here after Workie submits an application.</p> :
        <ul className={styles.cards} aria-label="Outreach">
          {items.map((item) => <Message key={item.id} item={item} template={list.template!} now={at} ownerId={ownerId} onDone={reload} />)}
        </ul>}
    </>}
  </>;
}
