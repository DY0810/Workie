import type { BrowserRuntime } from './browser.ts';
import type { AtsField } from './ats/protocol.ts';

/** One filled field as the applicant reviews it; see the server's LiveFrameSchema. */
export type ReviewField = { label: string; value: string; key?: string; kind?: AtsField['kind']; options?: string[]; multiple?: true };
type Frame = { step: string; image?: string | null; fields?: ReviewField[] };

/**
 * Sends Workie a screenshot of the application tab every few seconds while the worker fills it, so the
 * applicant can watch from any device. Best effort: a failed frame never affects the application.
 */
export function liveView(post: (frame: Frame) => Promise<unknown>, runtime: BrowserRuntime, everyMs = 2_500) {
  let step = 'Opening the application', busy: Promise<void> | null = null, stopped = false, again = false;
  const shot = async () => {
    const page = await runtime.page();
    // The worker sends at most 128 KB a request; a busy page retries smaller once, then goes without a picture.
    for (const quality of [50, 25]) {
      const image = (await page.screenshot({ type: 'jpeg', quality, timeout: 3_000, caret: 'initial' })).toString('base64');
      if (image.length <= 120_000) return image;
    }
  };
  // A new step that arrives while a frame is still sending goes right after it, not at the next tick.
  const send = (queue = false): Promise<void> => {
    if (busy) { again ||= queue; return busy; }
    return busy = (async () => {
      try {
        const image = await shot().catch(() => undefined);
        if (!stopped) await post({ step, ...(image ? { image } : {}) });
      } catch { /* The next frame replaces a lost one. */ } finally {
        busy = null;
        if (again) { again = false; void send(); }
      }
    })();
  };
  const timer = setInterval(() => void send(), everyMs);
  timer.unref?.();
  return {
    step(next: string) { step = next; void send(true); },
    /** Ends the view. The last picture stays only for a form waiting on the applicant's answers or approval. */
    async stop(last: string, fields?: Frame['fields'], keepImage = false) {
      clearInterval(timer);
      // Frames still sending, including a queued step, land before the last one so they never replace it.
      while (busy) await busy;
      stopped = true;
      // The filled form, taken after the last field; a separate request from the answers so each fits in 128 KB.
      const image = keepImage ? await shot().catch(() => undefined) : null;
      await post({ step: last, ...(image !== undefined ? { image } : {}) }).catch(() => {});
      // ponytail: when the whole list would not fit one request, choices go first (those rows can then only be read),
      // then long essays are cut to 1500 characters.
      const big = (list?: ReviewField[]) => !!list && JSON.stringify(list).length > 110_000;
      const bare = big(fields) ? fields!.map(field => field.options ? { label: field.label, value: field.value } : field) : fields;
      const fit = big(bare)
        ? bare!.map(field => ({ ...field, value: field.value.length > 1500 ? `${field.value.slice(0, 1500)}…` : field.value })) : bare;
      if (fit?.length) await post({ step: last, fields: fit }).catch(() => {});
    },
  };
}
