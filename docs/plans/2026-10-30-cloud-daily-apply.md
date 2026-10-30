# Daily cloud auto-apply (6 pm Pacific, Mac closed)

Goal: every day at 18:00 America/Los_Angeles, with DY's Mac off, the Workie
worker finds and fills applications, then a Claude scheduled task fills what the
worker could not, runs long answers through Walter Writes, and approves the safe
ones so the worker submits them.

## Pieces

| Piece | Where | Job |
|---|---|---|
| Worker | Persistent Vercel Sandbox `workie-dy-worker` (team dy0810s-projects, Pro: 24 h sessions) | Same `npm run worker -- start` as the Mac, under `xvfb-run` (worker opens a visible Chromium) and an unlocked gnome-keyring on a D-Bus session (worker refuses any other Linux keychain). |
| Private files | Inside the sandbox only (`/home/vercel-sandbox/private/`) | `ANSWER_BANK.md`, resume evidence files, `answers-log.md`, Walter browser profile. The repo is public, so none of this goes in git. |
| Walter | Playwright script in the sandbox (`scripts/cloud/walter.ts`) | Opens app.walterwrites.ai/en/humanizer with a saved login, sets Purpose = Letter and Bypass = Standard, humanizes one text, returns the output. No API key (DY's choice). |
| Brain | Claude Code scheduled task, cron `0 18 * * *` America/Los_Angeles | Resumes the sandbox, starts the worker, answers questions, humanizes, fact-checks, approves, emails DY a summary, stops the sandbox. |

Persistence: a persistent sandbox snapshots its disk on stop and resumes from it,
so the pairing, keychain file, Chromium profiles and private files survive
between days. The worker's lock uses boot id, so a resumed VM is not blocked by
yesterday's lock.

## Daily flow (scheduled task prompt)

1. Resume the sandbox; start D-Bus + keyring + Xvfb + worker in the background.
2. Log in to Workie once (`POST /api/auth/household`, profile dy), keep the
   cookie for the run. Make sure a run exists for the sandbox worker
   (`POST /api/application-runs` with its workerId).
3. Loop up to ~3 h, every 60 s:
   - `GET /api/inbox`: for each open question, answer from the answer bank and
     resume evidence only (`POST /api/questions/answers`).
   - Free-text answers of 50+ words: draft in DY's voice (voice-dy rules) →
     Walter (Letter/Standard) → fact-check against the source draft and
     evidence; fix only changed facts, numbers, names and dropped sentences.
     Shorter answers are not humanized (Walter's 50-word minimum).
   - `GET /api/application-runs`: for each application waiting for submit
     approval, approve (`approve-submit`) only if it is safe (below).
4. When nothing is left to do (or at the time limit): stop the worker, stop the
   sandbox, email DY a summary: submitted, held (with the reason), needs a code.

## "Safe to submit" rule

Approve only when every answer came from the answer bank or resume evidence,
or is a humanized essay that passed the fact-check. Hold for DY:
- any guessed answer, or a question the bank does not cover;
- non-compete/confidentiality agreements, part-time, co-op, PhD-only,
  high-school, start-immediately, relocation outside the US;
- employer caps from memory (Ramp, Coinbase, Waymo, TikTok, Rivian 5/90 days).

## Left to DY (cannot be automated)

- Greenhouse "verification code" emails: a human check. The task never reads or
  enters them; those applications wait up to 30 min, then time out, and the
  summary lists them so DY can retry.
- CAPTCHAs: never solved; such applications are left for DY.

## One-time setup

Claude does:
1. Create the persistent sandbox; install Node 22.23.2, Xvfb, gnome-keyring,
   dbus, XeLaTeX, Playwright Chromium + deps; clone Workie at the worker-run
   commit; `npm ci`.
2. Copy the private files into the sandbox.
3. Write `scripts/cloud/` (start/stop helpers, Walter script) and the task
   prompt; open a PR.
4. Create the scheduled task (cron, prompt, repo).

DY does (credentials):
1. Create a pairing grant in Workie, then `sandbox connect` and paste it into
   `npm run worker -- pair` (hidden prompt).
2. Same terminal: `npm run worker -- set-provider-key` and paste the
   OpenAI-compatible key the Mac worker uses.
3. Log in to Walter once inside the sandbox browser (Claude opens a
   noVNC/remote view, or DY runs a local login script that uploads the session).
4. Add the task's secrets in the cloud environment: Vercel access token
   (sandbox scope), Workie household passcode.
5. Set the sandbox worker's policy in Workie (same as the Mac worker's).

## Build order

1. Prove the sandbox worker first: install, pair, `status`, stop the sandbox,
   resume, `status` again. If the keyring does not survive resume, stop and
   redesign before writing anything else. Chromium may need `--no-sandbox`
   (one line in `worker/browser.ts`).
2. Set snapshot expiration explicitly (14 days) so one missed day does not
   lose the pairing.
3. Dry run on prod with the policy's `submit` action off (approve returns
   `SUBMIT_DISABLED`), so nothing is sent; then turn `submit` back on.
4. Then the Walter script, then the task prompt.

## Details settled

- Origin: pair to the same origin the Mac worker uses
  (`job-dashboard-one-sigma.vercel.app`; it answers without a redirect).
- Workie login: the task's script posts the passcode from an environment
  variable DY sets; Claude never types it.
- Walter login: DY runs a local script, logs in himself in a normal browser
  window; it saves the session file and uploads it into the sandbox.
- Walter script must: wait for the editor before typing, send one paragraph
  and restore breaks after, set Letter/Standard every time and check they
  stuck, wait for the result to finish, enforce 50-1500 words. The
  fact-check reverts any number, name, date or sentence the humanizer changed.
- Cloud sessions are not built for 3-hour loops. The worker keeps running in
  the sandbox on its own (worker daily start 18:00, sandbox timeout 4 h);
  the task runs at 18:00, 19:30 and 21:00, each doing one answer/approve pass;
  the 21:00 pass stops the worker and sends the summary.
- Approve Ashby and Lever first, Greenhouse last: one Greenhouse code prompt
  blocks the single-job worker for 30 minutes.
- Private files (home address, phone) live on DY's Vercel account disk and
  snapshots.

## Open risks

- Walter's web login may expire; then the task skips humanizing and holds
  essay applications instead of sending un-humanized text.
- Vercel Sandbox egress IPs may trip Ashby's spam filter more often than the
  Mac did.
- The Mac worker stays paired; turn its LaunchAgent off so both workers don't
  take DY's daily cap.
