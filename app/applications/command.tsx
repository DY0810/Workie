'use client';

import { useState } from 'react';
import styles from '../workers/workers.module.css';

export const buttonClass = (primary?: boolean) => primary ? `${styles.button} ${styles.primary}` : styles.button;

/** One command button with its own busy label, and its error beside it. */
export function Command({ label, busyLabel, confirm, primary, run, onDone }: {
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
