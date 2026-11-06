'use client';

import { RefreshCw } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { HostedRefreshStatus, Phase } from '@/lib/refresh-status';

type Status = { hosted: boolean; running: boolean; phase: Phase };

const LABEL: Record<Phase, string> = {
  idle: 'refresh',
  ingesting: 'polling every source…',
  enriching: 'classifying what came in…',
  syncing: 'new jobs in — syncing the hosted copy…',
  done: 'refreshed',
};

/**
 * Runs the real refresh cycle on demand, and shows which step it is on. New jobs appear the
 * moment enrich finishes — the table re-renders then, while the push to the hosted copy
 * carries on behind it.
 *
 * On the hosted site there is no pipeline to run, so the button ASKS: it records a request
 * in the shared database, nudges the GitHub Actions cycle to start, and watches for that
 * cycle to land. That is what lets anyone with the link fetch new jobs — no laptop involved,
 * so the wait is the cycle's real duration (about ten minutes), which the label says.
 *
 * Off the board there is no ingest to run: it announces `workie:refresh` and the page's own
 * panels reload their data.
 */
export function RefreshButton({ hosted }: { hosted?: boolean }) {
  const router = useRouter();
  const board = usePathname() === '/';
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const refreshedTable = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  // ponytail: one blind retry. Opening or closing a posting writes history, and Next drops a
  // refresh still in flight when that happens; re-issue on drop if one retry proves too few.
  const refreshTable = () => {
    router.refresh();
    setTimeout(() => router.refresh(), 3000);
  };

  const poll = () => {
    stop();
    refreshedTable.current = false;
    timer.current = setInterval(async () => {
      const res = await fetch('/api/refresh', { cache: 'no-store' }).catch(() => null);
      if (!res?.ok) return;
      const status = (await res.json()) as Status;
      const next: Phase = status.running ? status.phase : 'done';
      setPhase(next);
      // The table is worth re-rendering once enrich has run: that is when new rows exist.
      if ((next === 'syncing' || next === 'done') && !refreshedTable.current) {
        refreshedTable.current = true;
        refreshTable();
      }
      if (next === 'done') {
        stop();
        setTimeout(() => setPhase('idle'), 4000);
      }
    }, 2000);
  };

  /**
   * On the hosted site there is no pipeline to start: it runs in GitHub Actions, against
   * the workie.db that rides the Actions cache. The ask is recorded in the shared database
   * (and the workflow nudged directly, when the server holds a token), so this watches for
   * that cycle's mirror to land rather than pretending to run one.
   */
  const askRunner = async () => {
    setWaiting(true);
    const res = await fetch('/api/refresh', {
      method: 'POST',
    }).catch(() => null);
    if (!res?.ok) {
      setWaiting(false);
      return setNote('could not ask for a refresh');
    }
    const initial = await res.json() as HostedRefreshStatus;
    if (!initial.request) {
      setWaiting(false);
      return setNote('refresh request was not recorded');
    }
    const requestId = initial.request.id;
    setNote(initial.dispatch === 'started'
      ? 'cloud run requested'
      : initial.request.status === 'running'
        ? 'cloud refresh is running'
        : 'queued for the next cloud run; the schedule can be delayed');
    const askedAt = Date.now();
    stop();
    timer.current = setInterval(async () => {
      const poll = await fetch(`/api/refresh?request=${requestId}`, { cache: 'no-store' }).catch(() => null);
      if (!poll?.ok) return;
      const state = await poll.json() as HostedRefreshStatus;
      if (state.request?.status === 'succeeded') {
        stop();
        setWaiting(false);
        setNote('cloud refresh complete');
        refreshTable();
        setTimeout(() => setNote(null), 5000);
        return;
      }
      if (state.request?.status === 'failed') {
        stop();
        setWaiting(false);
        setNote('cloud refresh failed; please retry');
        return;
      }
      if (state.request?.status === 'running') setNote('cloud refresh is running');
      if (Date.now() - askedAt > 130 * 60_000) {
        stop();
        setWaiting(false);
        setNote('no completion reported; the request remains queued for recovery');
      }
    }, 5000);
  };

  const start = async () => {
    setNote(null);
    if (!board) return void window.dispatchEvent(new Event('workie:refresh'));
    // Unknown on a client-rendered page: GET /api/refresh says whether this server is the hosted copy.
    const onHost = hosted ?? (await fetch('/api/refresh', { cache: 'no-store' }).then((res) => res.json()).catch(() => null))?.hosted;
    if (onHost === undefined) return setNote('could not reach the server');
    if (onHost) return askRunner();
    const res = await fetch('/api/refresh', { method: 'POST' }).catch(() => null);
    if (!res) return setNote('could not reach the server');
    if (res.status === 409) {
      setNote('a cycle is already running');
      setPhase('ingesting');
      return poll();
    }
    if (!res.ok) return setNote('could not start a cycle');
    setPhase('ingesting');
    poll();
  };

  const busy = waiting || (phase !== 'idle' && phase !== 'done');
  const status = waiting ? 'refreshing in the cloud…' : LABEL[phase];
  // A stable label, like Postie's Add platform row; progress goes in the note under it.
  const label = board ? 'Refresh jobs' : 'Refresh';
  return (
    <div className="side-refresh">
      <button
        type="button"
        className="side-action"
        onClick={start}
        disabled={busy}
        aria-busy={busy}
        aria-label={label}
        title={busy || note ? note ?? status : label}
      >
        <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="label-text">{label}</span>
      </button>
      {note || busy || phase === 'done' ? (
        <p role="status" aria-live="polite" className="side-note">{note ?? status}</p>
      ) : null}
    </div>
  );
}
