'use client';

import { Archive } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { EXPECTED_APPLICANT_HEADER } from '../../lib/applications/applicant-precondition';
import { discoveryProblem, heldForDecision, queuedDetail, statusBadge, type BadgeTone } from '../../lib/applications/badges';
import { DiscoveryStatusSchema, type DiscoveryStatus } from '../../lib/applications/discovery-protocol';
import { archivedAt, bucket, inLive, isWatching, LIVE_STATES, openQuestions, rowAsks, rowsBehind } from '../../lib/applications/buckets';
import { postingUrl } from '../../lib/applications/posting-url';
import type { QuestionDetail } from '../../lib/applications/question-protocol';
import { formatDailyStart, offlineNotice, scheduledWorker } from '../../lib/applications/schedule';
import { HEARTBEAT_MS, LiveListSchema, MaterialsSchema, ReviewEditsAckSchema, RunListSchema, WorkerListSchema, type ApplicationSummary, type Run } from '../../lib/applications/worker-protocol';
import { PolicySchema } from '../../lib/applications/policy';
import { isAwaitingSubmitApproval, isSafeRetryState, isTerminalState } from '../../lib/applications/state';
import { Modal } from '../modal';
import { privateJson, PrivateRequestError, type PrivateApi } from '../profile/api';
import DocumentsPane from '../profile/documents-pane';
import { SettingsButton, setSettingsOpen } from '../settings-drawer';
import { CountBadge, StatusBadge } from '../status-badge';
import { ApplicationQuestions, useQuestions } from './questions';
import styles from '../workers/workers.module.css';

const ApplicantSchema = z.strictObject({ ownerId: z.string().min(1), email: z.email(), name: z.string() });
const PolicyResponseSchema = z.strictObject({
  revision: z.number().int().nonnegative(), policy: PolicySchema, enabled: z.boolean(),
  policyVersion: z.number().int().nonnegative(), policyHash: z.string().nullable(),
  acceptedPolicyVersion: z.number().nullable(), acceptedPolicyHash: z.string().nullable(),
  acceptedAt: z.string().nullable(), runnerAvailable: z.boolean(),
});
const humanize = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replaceAll('_', ' ');
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

type View = {
  account: z.infer<typeof ApplicantSchema> | null;
  workers: z.infer<typeof WorkerListSchema> | null;
  runs: z.infer<typeof RunListSchema> | null;
  /** Discovery of each running run: why it finds or starts nothing, and the roles it holds for the applicant. */
  discovery: DiscoveryStatus[];
  policy: z.infer<typeof PolicyResponseSchema> | null;
  materials: Material[];
  live: Frame[];
  loading: boolean;
  locked: boolean;
  error: string;
  loadedAt: number;
};

type Material = z.infer<typeof MaterialsSchema>['materials'][number];
type Frame = z.infer<typeof LiveListSchema>['live'][number];
const initialView: View = { account: null, workers: null, runs: null, discovery: [], policy: null, materials: [], live: [], loading: true, locked: true, error: '', loadedAt: 0 };

async function request(path: string, owner?: string) {
  try {
    return await privateJson(path, { owner, timeout: 15_000 });
  } catch (error) {
    if (!(error instanceof PrivateRequestError)) throw error;
    throw new Error(error.status === 401 ? 'Unlock Workie to view private applications.' :
      error.status === 403 ? 'Applicant access denied.' : 'Private application status is unavailable.');
  }
}

type Tab = 'action' | 'live' | 'applied' | 'archived';
/** States in which the worker has the form open: filling it, or filling it again to submit it after Apply. */
const FORM_STATES: readonly string[] = ['filling', 'ready', 'submitting'];
const LIVE_POLL_MS = 3_000;
/** `?view=` on the current URL, other params kept. Native pushState: Next syncs useSearchParams without a server round trip. */
function showTab(tab: Tab) {
  const url = new URL(window.location.href);
  if (tab === 'action') url.searchParams.delete('view'); else url.searchParams.set('view', tab);
  window.history.pushState(null, '', url);
}

type Field = NonNullable<Frame['fields']>[number];
type Edit = NonNullable<Field['edit']>;
const editText = (edit: Edit) => Array.isArray(edit) ? edit.join(', ') : typeof edit === 'boolean' ? (edit ? 'Yes' : 'No') : edit;
/** What goes into the field at submit: the applicant's change, else what Workie filled. */
const shown = (field: Field) => field.edit === undefined ? field.value : editText(field.edit);

/** The tailored resume (and the lines it changed) and the cover letter for this application, and once submitted, the answers it sent. */
function MaterialsPanel({ item }: { item: Material }) {
  const { resume, letter, answers } = item;
  return <>
    {resume && <div>
      <div className={styles.row}>
        <span>Tailored resume: {resume.changes.length ? `${resume.changes.length} line${resume.changes.length === 1 ? '' : 's'} rewritten for this posting` : 'saved'}</span>
        <a href={`/api/documents/${resume.documentId}/download`} download>Download</a>
      </div>
      {resume.changes.length > 0 && <details><summary className={styles.muted}>What changed</summary>
        <ul className={styles.changes}>{resume.changes.map((change, index) =>
          <li key={index}><del>{change.before}</del><ins>{change.after}</ins></li>)}</ul>
      </details>}
    </div>}
    {letter && <details><summary className={styles.muted}>Cover letter</summary>
      <pre className={styles.preview}>{['Dear Hiring Manager,', letter.introduction, ...letter.body, letter.companyParagraph, letter.conclusion].join('\n\n')}</pre>
    </details>}
    {answers && <dl className={styles.review}>{answers.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{shown(field)}</dd></div>)}</dl>}
  </>;
}

/** One answer being changed: a choice from the form's own options, Yes or No for a checkbox, otherwise text. */
function ReviewEditor({ field, onSave, onCancel }: { field: Field; onSave: (edit: Edit | null) => Promise<void>; onCancel: () => void }) {
  const start = field.edit ?? (field.value === 'Left blank' ? '' : field.kind === 'checkbox' ? field.value === 'Yes' : field.multiple ? field.value.split(', ') : field.value);
  const [draft, setDraft] = useState<Edit | ''>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = `edit-${field.key}`;
  const save = async (edit: Edit | null) => {
    setBusy(true); setError('');
    try { await onSave(edit); } catch { setError('Could not save. Refresh and try again.'); setBusy(false); }
  };
  const empty = draft === '' || (Array.isArray(draft) && !draft.length) || (typeof draft === 'string' && !draft.trim());
  const input = field.kind === 'checkbox'
    ? <select id={id} value={draft ? 'Yes' : 'No'} onChange={(event) => setDraft(event.target.value === 'Yes')}><option>Yes</option><option>No</option></select>
    : field.options && field.multiple
      ? <fieldset id={id}>{field.options.map((option) => <label key={option}><input type="checkbox" checked={Array.isArray(draft) && draft.includes(option)}
          onChange={(event) => setDraft(event.target.checked ? [...(Array.isArray(draft) ? draft : []), option] : (Array.isArray(draft) ? draft : []).filter((item) => item !== option))} /> {option}</label>)}</fieldset>
      : field.options
        ? <select id={id} value={typeof draft === 'string' ? draft : ''} onChange={(event) => setDraft(event.target.value)}>
            {!field.options.includes(String(draft)) && <option value="">Choose one</option>}
            {field.options.map((option) => <option key={option}>{option}</option>)}</select>
        : <textarea id={id} rows={Math.min(8, Math.max(2, Math.ceil(String(draft).length / 60)))} maxLength={4000} value={String(draft)}
            onChange={(event) => setDraft(event.target.value)} />;
  return <form className={styles.reviewEdit} onSubmit={(event) => { event.preventDefault(); if (!empty) void save(typeof draft === 'string' ? draft.trim() : draft); }}>
    <label className={styles.muted} htmlFor={id}>New answer</label>
    {input}
    {error && <span role="alert" className={styles.reason}>{error}</span>}
    <div className={styles.actions}>
      <button className={`${styles.button} ${styles.primary}`} type="submit" disabled={busy || empty}>{busy ? 'Saving...' : 'Save'}</button>
      {field.edit !== undefined && <button className={styles.button} type="button" disabled={busy} onClick={() => void save(null)}>Use Workie&apos;s answer</button>}
      <button className={styles.button} type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

/** What the worker typed into each field, and the filled form as it looked, for review before Apply. Any answer but a file can be changed. */
function FilledReview({ frame, ownerId, onSaved }: { frame: Frame | undefined; ownerId: string; onSaved: (fields: Field[]) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (!frame?.fields?.length) return <p className={styles.muted}>This form was filled before Workie kept a copy of the answers. Open the job post to compare, or retry to fill it again.</p>;
  const save = (key: string) => async (edit: Edit | null) => {
    const ack = ReviewEditsAckSchema.parse(await privateJson(`/api/applications/${frame.applicationId}/answers`, {
      method: 'POST', owner: ownerId, timeout: 30_000, body: JSON.stringify({ edits: { [key]: edit } }) }));
    onSaved(ack.fields); setEditing(null);
  };
  return <>
    <details open><summary className={styles.muted}>Filled answers ({frame.fields.length})</summary>
      <dl className={styles.review}>{frame.fields.map((field, index) => <div key={field.key ?? index}><dt>{field.label}</dt><dd>
        {editing === field.key && field.key ? <ReviewEditor field={field} onSave={save(field.key)} onCancel={() => setEditing(null)} /> : <>
          {shown(field)}
          {field.edit !== undefined && <span className={styles.muted}>{'\n'}Changed by you. Workie types this in when you press Apply.</span>}
          {field.key && field.kind !== 'file' && <>{' '}<button className={styles.button} type="button" onClick={() => setEditing(field.key!)}
            aria-label={`Change the answer to ${field.label}`}>Change</button></>}
        </>}
      </dd></div>)}</dl>
    </details>
    {frame.image && <details><summary className={styles.muted}>Filled form</summary>
      {/* eslint-disable-next-line @next/next/no-img-element -- a private data URL, not an optimizable asset */}
      <img className={styles.screen} src={`data:image/jpeg;base64,${frame.image}`} alt="The filled application form in Workie's browser" />
    </details>}
  </>;
}

const ago = (ms: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
};

/** One application the worker is on, or one waiting on the applicant: its newest step and what its browser shows, refreshed every few seconds. */
function LiveCard({ app, frame, role, asked, questions, ownerId, onAnswer, onDone }: {
  app: App; frame: Frame | undefined; role: string | null | undefined; asked: QuestionDetail[];
  questions: ReturnType<typeof useQuestions>; ownerId: string; onAnswer: () => void; onDone: () => void;
}) {
  const company = app.company ?? app.tenant;
  const href = postingUrl(app.ats, app.tenant, app.requisition);
  const approval = isAwaitingSubmitApproval(app.state, app.reasonCode);
  const watching = isWatching(app, frame, Date.now());
  const step = watching ? frame!.step : asked.length ? 'Waiting for your answers' : approval ? 'Filled. Waiting for your approval'
    : app.state === 'ready' ? 'Approved. Waiting for the worker to submit it' : app.state === 'screening' ? 'Checking the posting against your profile'
    : app.state === 'tailoring' ? 'Tailoring your resume' : 'Waiting for the worker to open the form';
  // A form waiting on the applicant keeps its last picture so they can see what they are answering or approving, or approved.
  const image = (watching || approval || app.state === 'ready' || asked.length > 0) ? frame?.image : undefined;
  // Full screen is a fixed overlay rather than the Fullscreen API, which iPhone Safari does not offer for images.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [full]);
  const apply = approval
    ? <Command label="Apply" busyLabel="Applying..." primary confirm="Submit this application to the employer now? This cannot be undone."
      run={() => approve(app, ownerId)} onDone={onDone} />
    : <button className={styles.button} type="button" disabled
      title={asked.length ? 'Answer the questions first.' : ['ready', 'submitting'].includes(app.state) ? 'Approved. Workie is submitting it.'
        : 'Apply opens once Workie has filled the form.'}>Apply</button>;
  return <li className={`${styles.card} ${styles.liveCard}`}>
    <div className={styles.cardTitle}>
      <h2 title={role ? `${company} / ${role}` : company}>{company}{role && <><span className={styles.slash}> / </span>{role}</>}</h2>
      <StatusBadge {...statusBadge(app.state, app.reasonCode)} />
    </div>
    <div className={full ? styles.fullScreen : undefined} role={full ? 'dialog' : undefined} aria-modal={full || undefined}
      aria-label={full ? `${company} application, full screen` : undefined}>
      <p className={styles.step} aria-live="polite">{watching && <span className={styles.pulse} aria-hidden="true" />}{step}
        {frame && <span className={styles.muted}> · updated {ago(frame.updatedAt)}</span>}
        {full && <button className={styles.button} type="button" autoFocus onClick={() => setFull(false)}>Exit full screen</button>}</p>
      {app.state === 'submitting' && <CodeBox app={app} company={company} ownerId={ownerId} />}
      <div className={full ? styles.fullBody : undefined}>
        {image
          // eslint-disable-next-line @next/next/no-img-element -- a private data URL, not an optimizable asset
          ? <img className={styles.screen} src={`data:image/jpeg;base64,${image}`} alt={`Workie's browser filling the ${company} application`}
            onClick={() => setFull(!full)} />
          : <div className={styles.screenEmpty}>{FORM_STATES.includes(app.state)
            ? 'The form appears here as soon as the worker opens it.' : 'The form appears here when filling starts.'}</div>}
        {full && <div className={styles.fullPanel}>
          {asked.length > 0 && <>
            {questions.view.error && <p role="alert" className={styles.message}>{questions.view.error}</p>}
            <ApplicationQuestions applicationId={app.id} view={questions.view} control={questions.control} />
          </>}
          {frame?.fields?.length ? <details open={!asked.length}><summary className={styles.muted}>Filled answers ({frame.fields.length})</summary>
            <dl className={styles.review}>{frame.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{shown(field)}</dd></div>)}</dl>
          </details> : !asked.length && <p className={styles.muted}>The answers Workie fills show here.</p>}
          <div className={styles.actions}>{apply}</div>
        </div>}
      </div>
    </div>
    <div className={styles.actions}>
      <button className={styles.button} type="button" onClick={() => setFull(true)}>Full screen</button>
      {href && <a className={styles.button} href={href} target="_blank" rel="noopener noreferrer">Open job post</a>}
      {asked.length > 0 && <button className={buttonClass(true)} type="button" onClick={onAnswer}>Answer</button>}
      {apply}
    </div>
  </li>;
}

const documentHelp: Record<string, string> = {
  transcript_unavailable: 'This form requires a transcript. Upload it, then retry.',
  required_document_unavailable: 'This form requires an upload Workie has no file for, usually a transcript. Upload it, then retry.',
  resume_required: 'Upload your resume, then retry.',
  cover_letter_unavailable: 'This form asks for a cover letter, and your Auto Apply policy does not allow them. Allow cover letters in Profile, then retry.',
  document_tailoring_unavailable: 'Workie could not tailor your resume for this role. Retry to try again.',
};
/** Why screening skipped a role: the posting's requirement the profile does not meet. */
const skipHelp: Record<string, string> = {
  country_ineligible: 'the role is in a country your profile does not list',
  degree_ineligible: 'the posting asks for a degree level your profile does not list',
  major_ineligible: 'the posting asks for a major your profile does not list',
  term_ineligible: 'the internship term is not one you are available for',
  graduation_ineligible: 'your expected graduation is outside the graduation dates the posting accepts',
  work_authorization_ineligible: 'the posting needs work authorization your profile says you do not have',
  unpaid_below_preference: 'the role is unpaid and your profile sets a minimum pay',
  screening_ineligible: 'your profile does not meet one of the posting\'s requirements',
};
const skipReasons = (app: App) => app.state === 'skipped' ? (app.reasonCode ?? '').split(',').flatMap((code) => skipHelp[code] ?? []) : [];
/** The upload that clears each hold; the worker attaches a transcript to any required file field it fits. */
const uploadKind: Record<string, 'transcript' | 'resume_master'> = {
  transcript_unavailable: 'transcript', required_document_unavailable: 'transcript', resume_required: 'resume_master',
};
// ponytail: an upload outlives the modal it started in, so it is never aborted.
const uploadSignal = new AbortController().signal;
const ignoreDocuments = () => {};

type App = ApplicationSummary;
const commandPath = (app: App) => `/api/application-runs/${app.runId}/applications/${app.id}/actions`;
const postCommand = (path: string, ownerId: string, expectedRevision: number, body: object) => fetch(path, {
  method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
  headers: { 'content-type': 'application/json', [EXPECTED_APPLICANT_HEADER]: ownerId },
  body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision, ...body }),
});
const errorCode = async (response: Response) => (await response.clone().json().catch(() => null))?.code as string | undefined;

/** A submit the employer held for the applicant, who never finished it in the worker's window (see worker/ats). */
const UNSENT: Record<string, string> = {
  verification_code_timeout: 'The employer emailed you a security code that was not entered on Workie or in Workie\'s browser window within 30 minutes, so it most likely was not sent.',
  captcha_timeout: 'The employer asked for a captcha that was not solved in Workie\'s browser window within 30 minutes, so it most likely was not sent.',
  submission_refused_spam: 'Ashby\'s spam filter refused this application, so it was not sent. Half an hour after the submit, press "It did not go through, try again" to fill it again for your approval.',
};

// Only a role that stopped needs a fresh attempt; a queued or waiting row resumes by itself once its hold clears.
const RESTARTABLE = ['failed', 'skipped', 'cancelled', 'retryable_failure', 'blocked_unsupported', 'provider_unavailable', 'needs_document'];
/** A failed fill or fixed document hold resumes from its checkpoint in its own run unless that run stopped (a paused run
 * continues it on resume): a fresh attempt would lose its answers and count again against the daily and per-employer caps.
 * A posting re-crawled since the row was queued (context_unavailable) needs a fresh attempt: only that takes the new snapshot. */
const resumable = (app: App, runs: Run[]) => !!app.checkpoint && isSafeRetryState(app.state, app.reasonCode) && (app.retries ?? 0) < 3 &&
  app.reasonCode !== 'context_unavailable' &&
  runs.some((run) => run.id === app.runId && run.state !== 'stopped');

/** A fresh attempt of a role the employer never received: its own run first, then other running runs newest first.
 * `retry-unsubmitted` is the applicant saying an unconfirmed submission never went through. */
async function restart(app: App, runs: Run[], ownerId: string, action: 'restart' | 'retry-unsubmitted' = 'restart') {
  // The server takes only a running run on the current policy.
  const targets = runs.filter((run) => run.state === 'running').sort((a, b) => Number(b.id === app.runId) - Number(a.id === app.runId));
  const unsubmitted = action === 'retry-unsubmitted';
  if (!targets.length && !unsubmitted) throw new Error('No run is running. Start auto apply, then retry.');
  let response: Response | null = null;
  for (const run of targets) {
    response = await postCommand(`/api/application-runs/${run.id}/${action}`, ownerId, app.revision, { previousApplicationId: app.id });
    if (response.ok || !['POLICY_CHANGED', 'DISCOVERY_REQUIRED'].includes(await errorCode(response) ?? '')) break;
  }
  // No running run can fill it again (none is running, on the current policy, or has found the role, which a closed
  // posting never will): the applicant's answer still closes it, and the role can be applied to again later.
  if (unsubmitted && (!response || ['POLICY_CHANGED', 'DISCOVERY_REQUIRED'].includes(await errorCode(response) ?? ''))) {
    response = await postCommand(commandPath(app), ownerId, app.revision, { action: 'confirm-not-submitted' });
  }
  if (!response!.ok) {
    const code = await errorCode(response!);
    throw new Error(code === 'POLICY_CHANGED' ? 'The Auto Apply policy changed since the running run started. Start a new run from Settings, then retry.'
      : code === 'DISCOVERY_REQUIRED' ? 'No running run has found this role yet. Retry after its discovery finishes.'
      : code === 'DUPLICATE_BLOCKED' ? 'This role was already retried or marked applied.'
      : code === 'SUBMISSION_MAY_STILL_COMPLETE' ? 'The employer window may still be open, so this could still go through. Try again in half an hour.'
      : 'Could not retry. Refresh and try again.');
  }
}

/** A row resumes in its own run; after a policy change a document hold moves to the newest running run. */
async function retrySafe(app: App, runs: Run[], ownerId: string) {
  const post = (path: string, body: object) => postCommand(path, ownerId, app.revision, body);
  let response = await post(commandPath(app), { action: 'retry-safe' });
  const code = async () => response.status === 409 ? (await response.clone().json().catch(() => null))?.code : undefined;
  // Only a document hold carries over to another run; any other failure starts over there.
  if (await code() === 'POLICY_CHANGED' && app.state !== 'needs_document') return restart(app, runs, ownerId);
  if (await code() === 'POLICY_CHANGED') {
    // The server accepts only a run on the current policy; try running runs newest first.
    for (const run of runs.filter((item) => item.state === 'running' && item.id !== app.runId)) {
      response = await post(`/api/application-runs/${run.id}/retry-unsubmitted`, { previousApplicationId: app.id });
      if (await code() !== 'POLICY_CHANGED') break;
    }
    if (await code() === 'POLICY_CHANGED') throw new Error('The Auto Apply policy changed after this run started. Start a new run from Settings, then retry.');
    if (await code() === 'DISCOVERY_REQUIRED') throw new Error('The new run has not found this role yet. Retry after its discovery finishes.');
  }
  if (!response.ok) throw new Error('Could not retry. Refresh and try again.');
}

const retry = (app: App, runs: Run[], ownerId: string) => resumable(app, runs) ? retrySafe(app, runs, ownerId) : restart(app, runs, ownerId);

/** The security code an employer emails at submit: sent to Workie, the worker types it into the form within seconds. */
function CodeBox({ app, company, ownerId }: { app: App; company: string; ownerId: string }) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('');
  const send = async () => {
    setStatus('Sending...');
    try {
      await privateJson(`/api/applications/${app.id}/verification-code`, { method: 'POST', owner: ownerId, body: JSON.stringify({ code: code.trim() }) });
      setCode(''); setStatus('Sent. Workie enters it in the form within a few seconds.');
    } catch { setStatus('Could not send that code. Check it and try again.'); }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
    <label className={styles.muted} htmlFor={`code-${app.id}`}>If {company} emailed you a security code, paste it here within 30 minutes.
      A captcha has to be solved in Workie&apos;s browser window on your computer.</label>
    <div className={styles.actions}>
      <input id={`code-${app.id}`} value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code"
        pattern="\s*[A-Za-z0-9]{4,16}\s*" required />
      <button className={styles.button} type="submit">Send code</button>
    </div>
    {status && <p role="status" className={styles.muted}>{status}</p>}
  </form>;
}

async function approve(app: App, ownerId: string) {
  try {
    await privateJson(commandPath(app), {
      method: 'POST', owner: ownerId, timeout: 30_000,
      body: JSON.stringify({ action: 'approve-submit', requestId: crypto.randomUUID(), expectedRevision: app.revision }),
    });
  } catch (e) {
    throw e instanceof PrivateRequestError ? new Error(e.status === 403 ? 'Turn on Submit in the Auto Apply policy first.' : 'Could not apply. Refresh and try again.') : e;
  }
}

/** The applicant saw the employer confirm a submission Workie could not: it moves to Applied, with no receipt of Workie's. */
async function confirmSubmitted(app: App, ownerId: string) {
  const response = await postCommand(commandPath(app), ownerId, app.revision, { action: 'confirm-submitted' });
  if (!response.ok) throw new Error('Could not save. Refresh and try again.');
}

/** Archiving hides the row, and cancels it if it is still live. */
async function archive(app: App, ownerId: string) {
  const response = await postCommand(commandPath(app), ownerId, app.revision, { action: 'delete' });
  if (!response.ok) throw new Error('Could not archive. Refresh and try again.');
}

const buttonClass = (primary?: boolean) => primary ? `${styles.button} ${styles.primary}` : styles.button;

/** One command button with its own busy label, and its error beside it. */
function Command({ label, busyLabel, confirm, primary, run, onDone }: {
  label: string; busyLabel: string; confirm?: string; primary?: boolean; run: () => Promise<void>; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Asked on the page, not with window.confirm: embedded browsers (the Claude app's pane, in-app web views)
  // drop that prompt and return false, so Apply and Archive did nothing there.
  const [asking, setAsking] = useState(false);
  const go = async () => {
    setAsking(false); setBusy(true); setError('');
    try { await run(); onDone(); } catch (e) { setError(e instanceof Error ? e.message : `Could not ${label.toLowerCase()}.`); }
    finally { setBusy(false); }
  };
  if (asking) return <>
    <span className={styles.muted}>{confirm}</span>
    <button className={buttonClass(primary)} type="button" onClick={() => void go()}>Yes, {label.toLowerCase()}</button>
    <button className={styles.button} type="button" autoFocus onClick={() => setAsking(false)}>Cancel</button>
  </>;
  return <>
    {error && <span role="alert" className={styles.reason}>{error}</span>}
    <button className={buttonClass(primary)} type="button" disabled={busy} onClick={() => confirm ? setAsking(true) : void go()}>
      {busy ? busyLabel : label}</button>
  </>;
}

/** A schedule in another time zone names it; one in the browser's own zone does not need to. */
function zone(timeZone: string | null) {
  if (!timeZone || timeZone === Intl.DateTimeFormat().resolvedOptions().timeZone) return '';
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts().find((part) => part.type === 'timeZoneName')?.value;
  return ` ${name ?? timeZone}`;
}

// `open` goes false on close while kind and id stay, so the modal fades out with its content instead of empty.
type Dialog = { kind: 'answer' | 'upload' | 'approve' | 'materials'; id: string; open: boolean };
const DIALOG_TITLES: Record<Dialog['kind'], string> = {
  answer: 'Answer', upload: 'Upload', approve: 'Approve', materials: 'Materials',
};
const EMPTY: Record<Tab, string> = { action: 'Nothing needs action.', live: 'Nothing is being applied right now. When the worker starts an application, you can watch it fill here.',
  applied: 'No submitted applications yet.', archived: 'Nothing archived.' };
const LIST_NAMES: Record<Tab, string> = { action: 'Needs action', live: 'Live', applied: 'Applied', archived: 'Archived' };
/** Rows waiting on the applicant first; queued and running rows need nothing from them. */
const waitRank = (app: App) => ['queued', 'progress'].includes(statusBadge(app.state, app.reasonCode).tone) ? 1 : 0;

export default function Applications() {
  const [view, setView] = useState(initialView);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const param = useSearchParams().get('view');
  const tab: Tab = param === 'applied' || param === 'archived' || param === 'live' ? param : 'action';
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setView((current) => ({ ...current, loading: true, locked: true, error: '' }));
    try {
      const account = ApplicantSchema.parse(await request('/api/auth/applicant'));
      const [workers, runs, policy, materials, live] = await Promise.all([
        WorkerListSchema.parse(await request('/api/workers', account.ownerId)),
        RunListSchema.parse(await request('/api/application-runs', account.ownerId)),
        PolicyResponseSchema.parse(await request('/api/auto-apply/policies', account.ownerId)),
        request('/api/applications/materials', account.ownerId).then((body) => MaterialsSchema.parse(body)).catch(() => null),
        request('/api/applications/live', account.ownerId).then((body) => LiveListSchema.parse(body)).catch(() => null),
      ]);
      if (workers.ownerId !== account.ownerId || runs.ownerId !== account.ownerId ||
          (materials && materials.ownerId !== account.ownerId) || (live && live.ownerId !== account.ownerId)) {
        throw new Error('Account changed. Refresh the current applicant.');
      }
      const running = runs.runs.filter((run) => run.state === 'running');
      // Discovery status follows the list, so a slow status read never holds the page back.
      setView((current) => ({ account, workers, runs, policy, materials: materials?.materials ?? [], live: live?.live ?? [],
        discovery: current.discovery.filter((status) => status.ownerId === account.ownerId && running.some((run) => run.id === status.runId)),
        loading: false, locked: false, error: '', loadedAt: Date.now() }));
      const discovery = (await Promise.all(running.map((run) =>
        request(`/api/application-runs/${run.id}/discovery`, account.ownerId).then((body) => DiscoveryStatusSchema.parse(body)).catch(() => null))))
        .flatMap((status) => status?.ownerId === account.ownerId ? [status] : []);
      setView((current) => current.account?.ownerId === account.ownerId ? { ...current, discovery } : current);
    } catch (error) {
      setView((current) => ({ ...current, loading: false, locked: true,
        error: error instanceof z.ZodError ? 'Private service returned an incompatible response.' :
          error instanceof Error ? error.message : 'Private application status is unavailable.' }));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, HEARTBEAT_MS * 3);
    const focus = () => { if (document.visibilityState === 'visible') void load(true); };
    const manual = () => void load(true);
    window.addEventListener('focus', focus);
    window.addEventListener('workie:refresh', manual);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('workie:refresh', manual); };
  }, [load]);
  const reload = useCallback(() => void load(true), [load]);
  const ownerKey = view.account?.ownerId ?? '';
  const rows = useRef<App[]>([]), shown = useRef<Frame[]>([]);
  useEffect(() => { rows.current = view.runs?.applications ?? []; shown.current = view.live; }, [view.runs, view.live]);
  // The Live tab refreshes the screenshots on their own, and the rows as soon as a frame shows a row moved.
  useEffect(() => {
    if (tab !== 'live' || !ownerKey) return;
    let alive = true, tried = '';
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const live = LiveListSchema.parse(await privateJson('/api/applications/live', { owner: ownerKey, timeout: 10_000 }));
        // A row joined, moved in or left Live since the rows loaded: fetch them now instead of at the next minute's refresh.
        const behind = rowsBehind(live.live, rows.current, shown.current);
        const runs = behind && behind !== tried
          ? RunListSchema.parse(await privateJson('/api/application-runs', { owner: ownerKey, timeout: 10_000 })) : null;
        if (!alive || live.ownerId !== ownerKey || (runs && runs.ownerId !== ownerKey)) return;
        tried = behind;
        setView((current) => ({ ...current, live: live.live, ...(runs ? { runs } : {}) }));
      } catch { /* The next poll retries; the page keeps the last picture. */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), LIVE_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [tab, ownerKey]);
  const questions = useQuestions(reload);
  const ownerId = view.account?.ownerId ?? '';
  const api = useCallback<PrivateApi>((path, init) => privateJson(path, { ...init, owner: ownerId }), [ownerId]);

  const applications = view.runs?.applications ?? [];
  const runs = view.runs?.runs ?? [];
  const lists: Record<Tab, App[]> = { action: [], live: [], applied: [], archived: [] };
  for (const app of applications) {
    const list = bucket(app, view.loadedAt);
    if (list) lists[list].push(app);
    if (inLive(app)) lists.live.push(app);
  }
  // The row being filled right now first.
  lists.live.sort((a, b) => Number(FORM_STATES.includes(b.state)) - Number(FORM_STATES.includes(a.state)));
  const frames = new Map(view.live.map((frame) => [frame.applicationId, frame]));
  lists.action.sort((a, b) => waitRank(a) - waitRank(b));
  const counts = new Map<string, { tone: BadgeTone; count: number }>();
  for (const app of lists.action) {
    const { tone, label } = statusBadge(app.state, app.reasonCode);
    counts.set(label, { tone, count: (counts.get(label)?.count ?? 0) + 1 });
  }
  const scheduled = scheduledWorker(view.workers?.workers);
  const discovery = new Map(view.discovery.map((status) => [status.runId, status]));
  const openSettings = (event: { preventDefault(): void }) => { event.preventDefault(); setSettingsOpen(true); };
  const offline = offlineNotice(view.workers?.workers);
  const caps = view.policy?.policy;
  const materials = new Map(view.materials.map((item) => [item.applicationId, item]));
  const asked = openQuestions(questions.view.inbox?.items ?? []);
  const questionRole = new Map((questions.view.inbox?.items ?? []).flatMap((item) => item.question ? [[item.applicationId, item.question.application.role] as const] : []));

  const open = dialog && applications.find((app) => app.id === dialog.id);
  const answering = dialog?.open && dialog.kind === 'answer';
  const hide = () => setDialog((current) => current && { ...current, open: false });
  // An answered application has no open question left: the modal has done its job.
  const answered = answering && !asked.has(dialog.id);
  useEffect(() => { if (answered) hide(); }, [answered]);
  const waiting = applications.filter((app) => app.reasonCode === 'question_unresolved' && app.hiddenAt === null).map((app) => app.id).join(',');
  useEffect(() => { questions.control?.need(waiting ? waiting.split(',') : []); }, [questions.control, waiting]);
  const close = () => { if (answering) questions.control?.back(); hide(); };
  const done = () => { hide(); reload(); };

  return <>
    <div className={styles.toolbar}>
      <h1>Auto Apply</h1>
      {!view.locked && [...counts].map(([label, { tone, count }]) => <StatusBadge key={label} tone={tone} label={`${count} ${label}`} />)}
      <div className={styles.tools}>
        <button type="button" className="btn icon" aria-pressed={tab === 'archived'} aria-label="Archived" title="Archived"
          onClick={() => showTab(tab === 'archived' ? 'action' : 'archived')}>
          <Archive size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <SettingsButton />
      </div>
    </div>
    {!view.locked && <p className={`${styles.muted} ${styles.schedule}`}>
      {scheduled?.dailyStartMinute != null ? `Starts daily at ${formatDailyStart(scheduled.dailyStartMinute)}${zone(scheduled.timeZone)}` : <>
        No daily start set. <a href="?settings=1" onClick={openSettings}>Set one in Settings</a></>}
    </p>}
    {!view.locked && view.discovery.flatMap((status) => {
      const problem = discoveryProblem(status), held = !problem && heldForDecision(status);
      return [
        problem && <p key={`${status.runId}:problem`} role="status" className={styles.message}>{problem} <a href="?settings=1" onClick={openSettings}>Open Settings</a></p>,
        held && <p key={`${status.runId}:held`} role="status" className={styles.message}>{held} <Link href="/profile#auto-apply-policy" prefetch={false}>Edit policy</Link></p>,
      ];
    })}
    {!view.locked && offline && <p role="status" className={styles.message}>{offline}</p>}
    {!(view.locked && !view.loading) && <>
      {view.error && <p role="alert" className={styles.message}>{view.error}</p>}
      {questions.view.error && !answering && <p role="alert" className={styles.message}>{questions.view.error}</p>}
      {questions.view.notice && <p role="status" className={styles.message}>{questions.view.notice}</p>}
    </>}
    {view.locked && !view.loading && <div className="empty-state">
      <p className="empty-title">Applications are private to the signed-in applicant.</p>
      {view.error && <p role="alert">{view.error}</p>}
      {questions.view.error && <p role="alert">{questions.view.error}</p>}
      <Link className="link" href="/sign-in" prefetch={false}>Sign in</Link>
    </div>}
    {!view.locked && <>
      <nav className="board-track" aria-label="Applications">
        {(['action', 'live', 'applied'] as const).map((item) => <button key={item} type="button" className={`board-track-link ${styles.tab}`}
          aria-current={tab === item ? 'page' : undefined} onClick={() => showTab(item)}>
          {LIST_NAMES[item]}<CountBadge count={lists[item].length} />
        </button>)}
      </nav>
      {tab === 'archived' && <p className={`${styles.message} ${styles.muted}`}>Archived items are removed 30 days after archiving.</p>}
      {tab === 'live' && lists.live.length > 0 && <ul className={styles.liveCards} aria-label="Live">
        {lists.live.map((app) => <LiveCard key={app.id} app={app} frame={frames.get(app.id)} role={app.role ?? questionRole.get(app.id)}
          asked={asked.get(app.id) ?? []} questions={questions} ownerId={ownerId} onDone={reload} onAnswer={() => {
            const here = asked.get(app.id) ?? [];
            if (here.length === 1) void questions.control?.select(here[0]);
            setDialog({ kind: 'answer', id: app.id, open: true });
          }} />)}
      </ul>}
      {tab === 'live' && lists.live.length > 0 ? null : !lists[tab].length ? <p className={`${styles.message} ${styles.muted}`}>{tab === 'action' && !applications.length
        ? 'No applications yet. Start auto apply from Settings after enabling a policy.' : EMPTY[tab]}</p> :
        <ul className={styles.cards} aria-label={LIST_NAMES[tab]}>
          {lists[tab].map((app) => {
            const badge = statusBadge(app.state, app.reasonCode);
            // Auto-archiving only hides: the worker can still finish the row, so it keeps its actions. The applicant's own archive is read-only.
            const archived = tab === 'archived';
            const live = !archived || app.hiddenAt === null;
            const { questions: questionsHere, restart: restartable } = rowAsks(app, asked.get(app.id));
            const approval = isAwaitingSubmitApproval(app.state, app.reasonCode);
            const upload = app.state === 'needs_document' && !!uploadKind[app.reasonCode ?? ''];
            const retryable = resumable(app, runs) || RESTARTABLE.includes(app.state) || restartable;
            const material = materials.get(app.id);
            const href = postingUrl(app.ats, app.tenant, app.requisition);
            const company = app.company ?? app.tenant;
            const role = app.role ?? questionRole.get(app.id);
            // Screening skips again until the profile changes, so Retry is not the suggested next step there.
            const primary = !live ? null : questionsHere.length ? 'answer' : upload ? 'upload' : approval ? 'approve'
              : retryable && !skipReasons(app).length ? 'retry' : null;
            const detail = app.state === 'queued' && caps ? queuedDetail(runs.find((run) => run.id === app.runId), discovery.get(app.runId), caps)
              : approval ? 'Form filled. Review the answers, resume and cover letter, then approve to submit.'
              : app.state === 'needs_document' && documentHelp[app.reasonCode ?? ''] ? documentHelp[app.reasonCode!]
              : skipReasons(app).length ? `Skipped: ${skipReasons(app).join('; ')}. If your profile is wrong, fix it, then retry.`
              // runs.ts sends a role that stops again after a retry back to the Jobs board; it stays listed here too.
              : (app.retries ?? 0) > 0 && ['failed', 'retryable_failure', 'blocked_unsupported', 'provider_unavailable'].includes(app.state)
                ? `${humanize(app.reasonCode ?? 'failed')}. It stopped again after a retry, so it is also back on the Jobs board. Retry once more, or archive it.`
              // An earlier version of this page had a Skip button; it recorded the applicant's own choice as "skip".
              : app.state === 'skipped' && app.reasonCode === 'skip' ? 'You skipped this role.'
              // Questions arrive with the inbox, a moment after the rows; older ones may sit past the pages loaded here.
              : app.reasonCode === 'question_unresolved' ? questions.view.inbox ? 'Waiting for your answers.' : 'Loading questions...'
              // Nothing resolves this by itself: only the applicant knows whether the employer got it.
              : app.state === 'submission_unknown' ? app.reasonCode === 'submission_refused_spam' ? UNSENT.submission_refused_spam
                : `${UNSENT[app.reasonCode ?? ''] ?? `Workie could not confirm the employer received this${app.reasonCode ? ` (${humanize(app.reasonCode)})` : ''}.`} Check your email or the job post, then say whether it went through.`
              : (app.reasonCode && !isTerminalState(app.state)) || app.state === 'failed' ? humanize(app.reasonCode ?? 'failed') : null;
            const show = (kind: Dialog['kind']) => () => setDialog({ kind, id: app.id, open: true });
            return <li key={app.id} className={styles.card}>
              <div className={styles.cardTitle}>
                <h2 title={role ? `${company} / ${role}` : company}>{company}{role && <><span className={styles.slash}> / </span>{role}</>}</h2>
                <StatusBadge {...badge} />
                {archived && <StatusBadge tone="archived" />}
              </div>
              {tab === 'applied' && app.submittedAt && <span className={styles.muted}>Applied {day(app.submittedAt)}</span>}
              {archived && <span className={styles.muted}>Archived {day(archivedAt(app))}</span>}
              {questionsHere.length ? <div className={styles.issue}>{questionsHere.map((question) =>
                <p key={question.id}>{question.descriptor.originalWording.split('\n\n')[0]}</p>)}</div>
                : detail && <p className={styles.issue}>{detail}
                  {(app.reasonCode === 'cover_letter_unavailable' || skipReasons(app).length > 0) && <> <Link href="/profile" prefetch={false}>Open Profile</Link></>}</p>}
              {tab === 'applied' && material && <details><summary className={styles.muted}>What you sent</summary><MaterialsPanel item={material} /></details>}
              <div className={styles.actions}>
                {!archived && !['submitting', 'submission_unknown'].includes(app.state) && <Command label="Archive" busyLabel="Archiving..."
                  confirm={isTerminalState(app.state) ? 'Archive this application?' : 'Archive this application? It is still live, so this also cancels it.'}
                  run={() => archive(app, ownerId)} onDone={reload} />}
                {href && <a className={styles.button} href={href} target="_blank" rel="noopener noreferrer">Open job post</a>}
                {live && LIVE_STATES.includes(app.state) && <button className={buttonClass(primary === null)} type="button" onClick={() => showTab('live')}>Watch live</button>}
                {material && tab !== 'applied' && !(live && approval) && <button className={styles.button} type="button" onClick={show('materials')}>Materials</button>}
                {live && retryable && <Command label="Retry" busyLabel="Retrying..." primary={primary === 'retry'} run={() => retry(app, runs, ownerId)} onDone={reload} />}
                {live && app.state === 'submission_unknown' && <>
                  <Command label="It went through" busyLabel="Saving..." confirm="Mark this as applied? Do this only if the employer confirmed it, by email or on its site."
                    run={() => confirmSubmitted(app, ownerId)} onDone={reload} />
                  <Command label="It did not go through, try again" busyLabel="Retrying..." confirm="Fill this application again? Nothing is submitted until you press Apply. If no running run has this role, it just closes."
                    run={() => restart(app, runs, ownerId, 'retry-unsubmitted')} onDone={reload} />
                </>}
                {live && approval && <button className={buttonClass(primary === 'approve')} type="button" onClick={show('approve')}>Approve</button>}
                {live && upload && <button className={buttonClass(primary === 'upload')} type="button" onClick={show('upload')}>Upload</button>}
                {live && questionsHere.length > 0 && <button className={buttonClass(true)} type="button" onClick={() => {
                  if (questionsHere.length === 1) void questions.control?.select(questionsHere[0]);
                  setDialog({ kind: 'answer', id: app.id, open: true });
                }}>Answer</button>}
              </div>
            </li>;
          })}
        </ul>}
    </>}
    <Modal open={!!open && dialog!.open} onClose={close} title={open ? `${DIALOG_TITLES[dialog!.kind]} / ${open.company ?? open.tenant}` : ''}
      footer={open && dialog!.kind === 'upload' ? <Command label="Retry" busyLabel="Retrying..." primary run={() => retry(open, runs, ownerId)} onDone={done} />
        : open && dialog!.kind === 'approve' ? <Command label="Apply" busyLabel="Applying..." primary
          confirm="Submit this application to the employer now? This cannot be undone." run={() => approve(open, ownerId)} onDone={done} />
        : undefined}>
      {open && dialog!.kind === 'answer' && <>
        {questions.view.error && <p role="alert" className={styles.message}>{questions.view.error}</p>}
        <ApplicationQuestions applicationId={open.id} view={questions.view} control={questions.control} />
      </>}
      {open && dialog!.kind === 'upload' && <>
        <p className={styles.issue}>{documentHelp[open.reasonCode ?? '']}</p>
        <DocumentsPane api={api} ownerId={ownerId} signal={uploadSignal} onDocuments={ignoreDocuments}
          idPrefix={`auto-apply-${open.id}`} initialKind={uploadKind[open.reasonCode ?? '']} />
      </>}
      {open && dialog!.kind === 'approve' && <>
        <p className={styles.issue}>Form filled. Review what Workie entered, the resume and cover letter, then press Apply to submit.
          Change any answer below first: Workie fills the form again with your changes when you press Apply, so the picture shows what it filled before.</p>
        <FilledReview frame={frames.get(open.id)} ownerId={ownerId} onSaved={(fields) => setView((current) => ({ ...current,
          live: current.live.map((frame) => frame.applicationId === open.id ? { ...frame, fields } : frame) }))} />
        {materials.get(open.id) && <MaterialsPanel item={materials.get(open.id)!} />}
      </>}
      {open && dialog!.kind === 'materials' && materials.get(open.id) && <MaterialsPanel item={materials.get(open.id)!} />}
    </Modal>
  </>;
}
