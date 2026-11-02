import { expect, test, type Locator, type Page } from '@playwright/test';
import { SUBMIT_APPROVAL } from '../../lib/applications/state';
import { PAIRING_TTL_MS, PARKED_STEPS } from '../../lib/applications/worker-protocol';
import { WorkerFixture, syntheticGrant, workerId } from './fixture';

// Real Next UI, strict synthetic APIs. No keychain, real clipboard, browser profile,
// live account, service or employer. No nested agents or cross-task messaging.
const fixtures = new WeakMap<Page, WorkerFixture>();
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ context, page, baseURL }) => {
  const fixture = new WorkerFixture();
  const failures: string[] = [];
  fixtures.set(page, fixture); errors.set(page, failures);
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.text().includes(syntheticGrant)) failures.push('Pairing secret leaked to console'); });
  await page.addInitScript(() => {
    const state = window as unknown as { copiedGrants: number };
    state.copiedGrants = 0;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { state.copiedGrants++; } } });
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href.includes(syntheticGrant)) failures.push('Pairing secret leaked to URL');
    if (url.origin === baseURL && request.method() === 'GET' &&
        (url.pathname === '/applications' || url.pathname.startsWith('/_next/static/'))) return route.continue();
    if (url.origin !== baseURL || !url.pathname.startsWith('/api/')) return route.abort();
    try {
      const response = await fixture.handle(url.pathname, request.method(), new Headers(request.headers()),
        request.postData() ? request.postDataJSON() : null);
      await route.fulfill({ ...response, headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      if (!(error instanceof TypeError && error.message === 'Synthetic lost acknowledgement')) {
        failures.push(error instanceof Error ? error.message : 'Fixture failure');
      }
      await route.abort('failed');
    }
  });
  test.info().annotations.push({ type: 'evidence', description: 'Real Next UI with strict synthetic worker APIs; no backend or live execution proof.' });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

// Workers lives in the settings drawer over Auto Apply; the drawer's Refresh reloads it (the header is inert under the modal).
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const alert = (page: Page) => settings(page).getByRole('region', { name: 'Workers', exact: true }).getByRole('alert');
const checking = (page: Page) => page.getByText('Checking applicant session...', { exact: true });
async function ready(page: Page) {
  await page.goto('/applications?settings=1');
  await expect(settings(page)).toBeVisible();
  await expect(page.getByLabel('Worker label', { exact: true })).toBeVisible();
}
/** A manual refresh locks Workers and shows the session check until it finishes, like the old Refresh status button. */
async function refresh(page: Page) {
  const before = fixtures.get(page)!.requests.length;
  await settings(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => fixtures.get(page)!.requests.length).toBeGreaterThan(before);
  await expect(checking(page)).toHaveCount(0);
}
/** A dropdown shows the global chevron: its SVG background, with room for it on the right. */
async function expectChevron(select: Locator) {
  const style = await select.evaluate((node) => ({ image: getComputedStyle(node).backgroundImage, padding: parseFloat(getComputedStyle(node).paddingRight) }));
  expect(style.image).toContain('data:image/svg+xml');
  expect(style.padding).toBeGreaterThanOrEqual(24);
}
/** Closing the drawer with a request unresolved is refused, as leaving the Workers page was. */
async function tryToLeave(page: Page) {
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]settings=1/);
  await expect(alert(page)).toContainText('request is unresolved');
}
const grants = (page: Page) => page.getByRole('textbox', { name: 'Pairing grant', exact: true });
const run = (page: Page) => page.getByRole('list', { name: 'Runs', exact: true }).getByRole('listitem');

test('pairing approval is explicit, secret stays transient, copy is direct and expiry removes it', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  expect(fixture.writes).toHaveLength(0);
  await page.getByLabel('Worker label', { exact: true }).fill('Synthetic pairing');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(grants(page)).toBeVisible();
  const copies = () => page.evaluate(() => (window as unknown as { copiedGrants: number }).copiedGrants);
  expect(await copies()).toBe(0);
  expect(await page.evaluate((secret) => !location.href.includes(secret) &&
    !JSON.stringify(localStorage).includes(secret) && !JSON.stringify(sessionStorage).includes(secret), syntheticGrant)).toBe(true);
  expect(fixture.writes.every((request) => !JSON.stringify(request).includes(syntheticGrant))).toBe(true);
  await page.getByRole('button', { name: 'Copy grant', exact: true }).click();
  await expect.poll(copies).toBe(1);
  fixture.now += PAIRING_TTL_MS;
  await refresh(page);
  await expect(grants(page)).toHaveCount(0);
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();
  await page.reload();
  await expect(grants(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create pairing grant', exact: true })).toBeVisible();
});

test('lost pairing create replays the same request after same-owner auth refresh and reports hash-only conflict', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  fixture.loseNext = true;
  await page.getByLabel('Worker label', { exact: true }).fill('Unacknowledged pairing');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  fixture.authStatus = 401;
  await refresh(page);
  await expect(page.getByText('Workers locked.', { exact: true })).toBeVisible();
  fixture.authStatus = 200;
  await refresh(page);
  await expect(page.getByLabel('Worker label', { exact: true })).toHaveValue('Unacknowledged pairing');
  await page.getByRole('button', { name: 'Retry pending request' }).click();
  await expect(alert(page)).toContainText('secret is unavailable');
  await expect(grants(page)).toHaveCount(0);
  expect(fixture.pairings).toHaveLength(1);
  expect(fixture.writes[0].body).toEqual(fixture.writes[1].body);
  await page.getByRole('button', { name: 'Cancel pairing Unacknowledged pairing', exact: true }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
});

test('principal switch clears the grant, selected worker, label and in-flight response', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByLabel('Worker label', { exact: true }).fill('Owner A only');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(grants(page)).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  let release!: () => void;
  fixture.afterWrite = () => new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Create run', exact: true }).click();
  await expect.poll(() => typeof release).toBe('function');
  fixture.switchOwner();
  await refresh(page);
  release();
  await expect(grants(page)).toHaveCount(0);
  await expect(page.getByLabel('Worker label', { exact: true })).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Run worker', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toHaveCount(0);
  await expect(page.getByText('No runs.', { exact: true })).toBeVisible();
});

test('same-owner reauthentication retains selection grant and pending intent until explicit retry', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByLabel('Worker label', { exact: true }).fill('Owner A only');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(grants(page)).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  fixture.loseNext = true;
  await page.getByRole('button', { name: 'Create run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  fixture.authStatus = 401;
  await refresh(page);
  await expect(grants(page)).toBeHidden();
  fixture.authStatus = 200;
  await refresh(page);
  await expect(page.getByRole('combobox', { name: 'Run worker', exact: true })).toHaveValue(workerId);
  await expect(page.getByLabel('Worker label', { exact: true })).toHaveValue('Owner A only');
  await expect(grants(page)).toBeVisible();
  expect(fixture.writes).toHaveLength(2);
  await tryToLeave(page);
  await page.getByRole('button', { name: 'Retry pending request' }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toHaveCount(0);
  expect(fixture.writes[1].body).toEqual(fixture.writes[2].body);
  expect(fixture.runs).toHaveLength(1);
  await page.getByRole('button', { name: 'Dismiss secret', exact: true }).click();
  await refresh(page);
  await expect(grants(page)).toHaveCount(0);
});

test('worker revoke and pairing cancellation reconcile CAS and current heads', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  await ready(page);
  fixture.workers[0].revision++;
  await page.getByRole('button', { name: 'Revoke Synthetic laptop', exact: true }).click();
  await expect(alert(page)).toContainText('State changed');
  await expect(page.getByRole('button', { name: 'Revoke Synthetic laptop', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Revoke Synthetic laptop', exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(run(page).getByText('paused', { exact: true })).toBeVisible();
  await expect(run(page).getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  expect(fixture.writes[0].body!.requestId).not.toBe(fixture.writes[1].body!.requestId);
});

test('run create replay shows the newer stopped head and controls persist across reload', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  fixture.loseNext = true;
  await page.getByRole('button', { name: 'Create run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  fixture.runs[0].state = 'stopped'; fixture.runs[0].revision++;
  await refresh(page);
  await page.getByRole('button', { name: 'Retry pending request' }).click();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier request acknowledged. Current state loaded.', { exact: true })).toBeVisible();
  await expect(run(page).getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  expect(fixture.runs).toHaveLength(1);
  expect(fixture.writes[0].body).toEqual(fixture.writes[1].body);
  await page.reload();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await expect(page.getByText('Policy enabled / Runner online', { exact: true })).toBeVisible();
});

for (const target of ['same', 'different'] as const) {
  test(`delayed-before-commit resume survives only an unrelated emergency stop: ${target} run`, async ({ page }) => {
    const fixture = fixtures.get(page)!;
    const a = fixture.addRun('paused'), b = target === 'same' ? a : fixture.addRun();
    const app = fixture.addApplication('submitting', 'submit_started', b.id);
    await ready(page);
    const aRow = page.getByRole('listitem', { name: `Run ${a.id.slice(0, 8)}`, exact: true });
    const bRow = page.getByRole('listitem', { name: `Run ${b.id.slice(0, 8)}`, exact: true });
    let release!: () => void;
    fixture.beforeWrite = () => new Promise<void>((resolve) => { release = resolve; });
    await aRow.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect.poll(() => typeof release).toBe('function');
    const body = structuredClone(fixture.writes[0].body);
    expect(a.state).toBe('paused');
    fixture.beforeWrite = undefined;
    await bRow.getByRole('button', { name: 'Emergency stop', exact: true }).click();
    await expect(bRow.getByText('stopped', { exact: true })).toBeVisible();
    release();
    const retry = page.getByRole('button', { name: 'Retry pending request', exact: true });
    if (target === 'same') {
      await expect(retry).toHaveCount(0);
      await refresh(page);
      await expect(aRow.getByText('stopped', { exact: true })).toBeVisible();
      expect(fixture.writes).toHaveLength(2);
    } else {
      await expect(retry).toBeEnabled();
      await expect(aRow.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
      await tryToLeave(page);
      await refresh(page);
      await expect(aRow.getByText('running', { exact: true })).toBeVisible();
      await retry.click();
      await expect(retry).toHaveCount(0);
      expect(fixture.writes).toHaveLength(3);
      expect(fixture.writes[2].body).toEqual(body);
    }
    expect(app.state).toBe('submission_unknown');
  });
}

test('a delayed head cannot republish an expired grant or an artificially online worker', async ({ page }) => {
  await page.addInitScript(() => {
    const clock = window as unknown as { workerMonotonic: number };
    clock.workerMonotonic = 0;
    Object.defineProperty(performance, 'now', { value: () => clock.workerMonotonic });
  });
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByLabel('Worker label', { exact: true }).fill('Expiring pairing');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(grants(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toHaveCount(0);
  const handle = fixture.handle.bind(fixture);
  // Workers, Settings and the Auto Apply page each read runs on refresh; hold all three.
  const releases: (() => void)[] = [];
  fixture.handle = async (...args) => {
    const response = await handle(...args);
    if (args[0] === '/api/application-runs') await new Promise<void>((resolve) => { releases.push(resolve); });
    return response;
  };
  await settings(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => releases.length).toBe(3);
  await page.evaluate((elapsed) => { (window as unknown as { workerMonotonic: number }).workerMonotonic = elapsed; }, PAIRING_TTL_MS + 1);
  fixture.now += PAIRING_TTL_MS + 1;
  fixture.handle = handle;
  for (const release of releases) release();
  await expect(checking(page)).toHaveCount(0);
  await expect(grants(page)).toHaveCount(0);
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copiedGrants: number }).copiedGrants)).toBe(0);
});

test('pause resume stop and emergency stop are durable', async ({ page }) => {
  fixtures.get(page)!.addRun();
  await ready(page);
  await run(page).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(run(page).getByText('paused', { exact: true })).toBeVisible();
  await page.reload();
  await run(page).getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(run(page).getByText('running', { exact: true })).toBeVisible();
  await run(page).getByRole('button', { name: 'Emergency stop', exact: true }).click();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await page.reload();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  await page.getByRole('button', { name: 'Create run', exact: true }).click();
  const next = run(page).filter({ has: page.getByRole('button', { name: 'Stop', exact: true }) });
  await expect(next).toHaveCount(1);
  await next.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(next).toHaveCount(0);
  await page.reload();
  await expect(run(page).getByText('stopped', { exact: true })).toHaveCount(2);
});

test('offline unpaired disabled-policy configuration and unknown-protocol states remain honest', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.workers[0].online = false;
  fixture.policy.enabled = false;
  await ready(page);
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  // Auto Apply itself says so too, not only Settings.
  await expect(page.getByText(/^Your worker is offline, last seen .+\. Nothing is applied until it is back online\.$/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  await expect(page.getByRole('button', { name: 'Create run', exact: true })).toBeDisabled();
  fixture.workers = [];
  await refresh(page);
  await expect(page.getByText('Unpaired / no workers.', { exact: true })).toBeVisible();
  fixture.addRun(); fixture.invalidState = true;
  await refresh(page);
  await expect(alert(page)).toContainText('Incompatible worker response');
  await expect(page.getByLabel('Worker label', { exact: true })).toBeHidden();
  fixture.invalidState = false; fixture.authStatus = 503;
  await refresh(page);
  await expect(alert(page)).toContainText('configuration');
});

// Embedded browsers (the Claude app's pane, in-app web views) return false from window.confirm without asking,
// so Apply and Archive did nothing there. They ask on the page instead.
test('Apply and Archive ask on the page, never through a browser prompt', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('needs_policy_decision', SUBMIT_APPROVAL);
  page.on('dialog', (dialog) => { errors.get(page)!.push(`Browser prompt: ${dialog.message()}`); void dialog.dismiss(); });
  const writes = () => fixture.requests.filter((request) => request.method !== 'GET');
  await page.goto('/applications');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Archive this application? It is still live, so this also cancels it.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes()).toEqual([]);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Approve / fixture-employer', exact: true });
  await review.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(review.getByText('Submit this application to the employer now? This cannot be undone.', { exact: true })).toBeVisible();
  expect(writes()).toEqual([]);
  await review.getByRole('button', { name: 'Yes, apply', exact: true }).click();
  await expect.poll(() => writes().map((request) => request.body?.action)).toEqual(['approve-submit']);
  expect(writes()[0].path).toBe(`/api/application-runs/${app.runId}/applications/${app.id}/actions`);
});

test('the applications list shows without waiting for a slow discovery status', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  const run = fixture.addRun();
  fixture.addApplication('queued');
  fixture.discovery.set(run.id, { errorCode: 'POLICY_STALE' });
  let release = () => {};
  fixture.discoveryGate = new Promise((resolve) => { release = resolve; });
  await page.goto('/applications');
  await expect(page.getByText(/^Waiting its turn/)).toBeVisible();
  release();
  await expect(page.getByText(/^It will not start: your Auto Apply policy changed after its run started\./)).toBeVisible();
});

test('a run that starts nothing and roles held for a decision are named, not shown as waiting', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  const stale = fixture.addRun(), current = fixture.addRun();
  fixture.addApplication('queued');
  fixture.discovery.set(stale.id, { errorCode: 'POLICY_STALE' });
  fixture.discovery.set(current.id, { heldQuestions: { pay_undisclosed: 2 } });
  await page.goto('/applications');
  await expect(page.getByText(/^It will not start: your Auto Apply policy changed after its run started\./)).toBeVisible();
  await expect(page.getByText(/^Waiting its turn/)).toHaveCount(0);
  await expect(page.getByText(/^A run started before your last Auto Apply policy change finds and starts nothing\./)).toBeVisible();
  await expect(page.getByText(/^Not started under your current policy: pay not listed \(2\)\./)).toBeVisible();
});

test('a submit Ashby refused as spam says it was not sent and offers a retry', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  fixture.addApplication('submission_unknown', 'submission_refused_spam');
  await page.goto('/applications');
  await expect(page.getByText('Ashby\'s spam filter refused this application, so it was not sent.', { exact: false })).toBeVisible();
  await expect(page.getByText('Check your email or the job post', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'It did not go through, try again', exact: true })).toBeVisible();
});

// An unconfirmed submission (the worker could not confirm the employer got it) has no way out but the applicant's word.
test('an unconfirmed submission says why, and the applicant says whether it went through', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const sent = fixture.addApplication('submission_unknown', 'verification_code_timeout');
  await page.goto('/applications');
  await expect(page.getByText('The employer emailed you a security code that was not entered on Workie or in Workie\'s browser window within 30 minutes', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'It went through', exact: true }).click();
  await expect(page.getByText('Mark this as applied? Do this only if the employer confirmed it, by email or on its site.', { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  await page.getByRole('button', { name: 'Yes, it went through', exact: true }).click();
  await expect.poll(() => fixture.writes.map((request) => [request.path, request.body?.action]))
    .toEqual([[`/api/application-runs/${sent.runId}/applications/${sent.id}/actions`, 'confirm-submitted']]);
  await expect(page.getByText('Nothing needs action.', { exact: true })).toBeVisible();

  const lost = fixture.addApplication('submission_unknown', 'submission_response_lost');
  await page.reload();
  await page.getByRole('button', { name: 'It did not go through, try again', exact: true }).click();
  await expect(page.getByText('Fill this application again? Nothing is submitted until you press Apply. If no running run has this role, it just closes.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, it did not go through, try again', exact: true }).click();
  await expect.poll(() => fixture.writes.at(-1)?.path).toBe(`/api/application-runs/${lost.runId}/retry-unsubmitted`);
  expect(fixture.writes.at(-1)?.body).toMatchObject({ previousApplicationId: lost.id, expectedRevision: 1 });

  // With no running run to fill it again (its posting closed, or Auto Apply is off), the answer still closes it.
  fixture.runs[0].state = 'stopped';
  const closed = fixture.addApplication('submission_unknown', 'verification_code_timeout');
  await page.reload();
  await page.getByRole('button', { name: 'It did not go through, try again', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, it did not go through, try again', exact: true }).click();
  await expect.poll(() => fixture.writes.at(-1)?.body?.action).toBe('confirm-not-submitted');
  expect(fixture.writes.at(-1)?.path).toBe(`/api/application-runs/${closed.runId}/applications/${closed.id}/actions`);
  await expect(page.getByRole('button', { name: 'It did not go through, try again', exact: true })).toHaveCount(0);
});

test('Applied shows the resume, cover letter and answers each application sent', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const sent = fixture.addApplication('submitted');
  const documentId = crypto.randomUUID();
  fixture.materials = [{ applicationId: sent.id, resume: { documentId, mime: 'application/pdf', createdAt: fixture.now, changes: [] },
    letter: { introduction: 'I am applying.', body: ['I build things.'], conclusion: 'Thank you.', companyParagraph: 'Your work matters.' },
    answers: [{ label: 'First Name', value: 'Dong Yeop' }, { label: 'Resume/CV', value: 'DongYeopLee_Resume.pdf' }] }];
  await page.goto('/applications');
  await page.getByRole('button', { name: /^Applied/ }).click();
  await page.getByText('What you sent', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/api/documents/${documentId}/download`);
  await expect(page.getByText('Dong Yeop', { exact: true })).toBeVisible();
  await expect(page.getByText('DongYeopLee_Resume.pdf', { exact: true })).toBeVisible();
  await page.getByText('Cover letter', { exact: true }).click();
  await expect(page.getByText('Your work matters.')).toBeVisible();
});

// A fresh attempt counts against the daily and per-employer caps and loses the attempt's answers, so a failed fill resumes.
test('Retry resumes a failed fill in its own run, and starts over only when that run stopped', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  const own = fixture.addRun();
  const failed = fixture.addApplication('retryable_failure', 'ats_timeout');
  await page.goto('/applications');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => fixture.writes.map((request) => [request.path, request.body?.action]))
    .toEqual([[`/api/application-runs/${own.id}/applications/${failed.id}/actions`, 'retry-safe']]);
  expect(failed.state).toBe('screening');

  // A paused run keeps it and continues it on resume.
  own.state = 'paused';
  const parked = fixture.addApplication('retryable_failure', 'ats_timeout', own.id);
  await page.reload();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => fixture.writes.at(-1)?.path).toBe(`/api/application-runs/${own.id}/applications/${parked.id}/actions`);
  expect(fixture.writes.at(-1)?.body?.action).toBe('retry-safe');

  // Its own run stopped, so nothing can resume it there: a fresh attempt queues in the running run.
  own.state = 'stopped';
  const other = fixture.addRun();
  const stranded = fixture.addApplication('retryable_failure', 'ats_timeout', own.id);
  await page.reload();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => fixture.writes.at(-1)?.path).toBe(`/api/application-runs/${other.id}/restart`);
  expect(fixture.writes.at(-1)?.body).toMatchObject({ previousApplicationId: stranded.id, expectedRevision: 1 });
});

/** A 1x1 PNG: the browser shows it under the page's image/jpeg data URL like the worker's screenshot. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Apply moves the row to 'ready' while the worker fills the form again and submits it; Live used to drop it, closing full screen.
test('Apply in Live full screen keeps the form on screen while the worker submits it', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('needs_policy_decision', SUBMIT_APPROVAL);
  // Fresh, as when the applicant presses Apply right after the fill: the frame the worker parked the form with is not the refill.
  fixture.frames = [{ applicationId: app.id, step: PARKED_STEPS.approval, image: PIXEL,
    fields: [{ label: 'First Name', value: 'Test' }], updatedAt: Date.now() }];
  await page.goto('/applications?view=live');
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  const full = page.getByRole('dialog', { name: 'fixture-employer application, full screen', exact: true });
  await full.getByRole('button', { name: 'Apply', exact: true }).click();
  await full.getByRole('button', { name: 'Yes, apply', exact: true }).click();
  await expect(full.getByText(/^Approved\. Waiting for the worker to submit it/)).toBeVisible();
  await expect(full.getByRole('img', { name: 'Workie\'s browser filling the fixture-employer application', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Live', exact: true }).getByRole('listitem')).toHaveCount(1);
  expect(fixture.writes.map((request) => request.body?.action)).toEqual(['approve-submit']);
});

// listLive stops sending a row's frame once it leaves Live; the card used to stay, saying the form had not gone out, until the minute's refresh.
test('Live drops a form the worker submitted at its next frame poll', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('submitting');
  fixture.frames = [{ applicationId: app.id, step: 'Filling the form again and submitting it', image: PIXEL, fields: null, updatedAt: Date.now() }];
  await page.goto('/applications?view=live');
  await expect(page.getByRole('list', { name: 'Live', exact: true }).getByText(/^Filling the form again and submitting it · updated/)).toBeVisible();
  app.state = 'submitted';
  await expect(page.getByText(/^Nothing is being applied right now\./)).toBeVisible({ timeout: 10_000 });
});

// Greenhouse emails a security code at submit: the applicant pastes it on the Live card and the worker types it into the form.
test('Live sends the security code for a form being submitted', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('submitting');
  fixture.frames = [{ applicationId: app.id, step: 'Filling the form again and submitting it', image: PIXEL, fields: null, updatedAt: Date.now() }];
  await page.goto('/applications?view=live');
  await page.getByLabel(/emailed you a security code/).fill(' ja5oTXoY ');
  await page.getByRole('button', { name: 'Send code', exact: true }).click();
  await expect(page.getByText('Sent. Workie enters it in the form within a few seconds.', { exact: true })).toBeVisible();
  expect(fixture.writes.map((request) => [request.path, request.body])).toEqual([[`/api/applications/${app.id}/verification-code`, { code: 'ja5oTXoY' }]]);
});

// Rows reload once a minute and frames every 3 s; Live used to wait for the rows to show a form the worker had started filling.
test('Live shows a form the worker starts filling after the page loaded, at its next frame', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('queued');
  await page.goto('/applications?view=live');
  await expect(page.getByText(/^Nothing is being applied right now\./)).toBeVisible();
  app.state = 'filling';
  fixture.frames = [{ applicationId: app.id, step: 'Filling the form', image: PIXEL, fields: null, updatedAt: Date.now() }];
  const live = page.getByRole('list', { name: 'Live', exact: true });
  await expect(live.getByText(/^Filling the form · updated/)).toBeVisible({ timeout: 10_000 });
  await expect(live.getByRole('img', { name: 'Workie\'s browser filling the fixture-employer application', exact: true })).toBeVisible();
});

// Two tabs on Live can spend the applicant's 60-a-minute private limit; a 429 used to replace the page with Sign in.
test('Live keeps its card through a rate limit and updates at the next poll that succeeds', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('filling');
  fixture.frames = [{ applicationId: app.id, step: 'Filling the form', image: PIXEL, fields: null, updatedAt: Date.now() }];
  await page.goto('/applications?view=live');
  const live = page.getByRole('list', { name: 'Live', exact: true });
  await expect(live.getByText(/^Filling the form · updated/)).toBeVisible();
  fixture.rateLimited = true;
  // The full refresh (once a minute and on focus) is what locked the page, not the frame poll.
  const refused = page.waitForResponse((response) => response.url().endsWith('/api/workers') && response.status() === 429);
  await page.evaluate(() => window.dispatchEvent(new Event('workie:refresh')));
  await refused;
  // A frame poll after that refusal is refused too, and the page has handled both.
  await page.waitForResponse((response) => response.url().endsWith('/api/applications/live') && response.status() === 429);
  await expect(live.getByText(/^Filling the form · updated/)).toBeVisible();
  await expect(page.getByText('Private application status is unavailable.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  fixture.rateLimited = false;
  fixture.frames[0] = { ...fixture.frames[0], step: 'Filling the form, page 2', updatedAt: Date.now() };
  await expect(live.getByText(/^Filling the form, page 2 · updated/)).toBeVisible({ timeout: 10_000 });
});

// A filled form waiting for Apply takes answer changes on the Live card and in its full-screen panel, not only in the Approve dialog.
test('Live card awaiting approval changes a filled free-text answer and a dropdown answer', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('needs_policy_decision', SUBMIT_APPROVAL);
  const why = `form-${'a'.repeat(32)}`, pronouns = `form-${'b'.repeat(32)}`;
  fixture.frames = [{ applicationId: app.id, step: PARKED_STEPS.approval, image: PIXEL, updatedAt: Date.now(), fields: [
    { label: 'Why are you interested?', value: 'Workie wrote this.', key: why, kind: 'textarea' },
    { label: 'Pronouns', value: 'he/him', key: pronouns, kind: 'select', options: ['he/him', 'she/her', 'they/them'] },
    { label: 'Resume', value: 'resume.pdf', key: `form-${'c'.repeat(32)}`, kind: 'file' }] }];
  await page.goto('/applications?view=live');
  const card = page.getByRole('list', { name: 'Live', exact: true }).getByRole('listitem');
  // A file is attached, not typed: it has no Change.
  await expect(card.getByRole('button', { name: /^Change the answer to/ })).toHaveCount(2);
  await card.getByRole('button', { name: 'Change the answer to Why are you interested?', exact: true }).click();
  await card.getByLabel('New answer', { exact: true }).fill('I use Fixture Co every week.\nAnd I want to make it faster.');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByText('Changed by you. Workie types this in when you press Apply.')).toBeVisible();
  await expect(card.locator('dd').first()).toContainText('I use Fixture Co every week.');
  // The full-screen panel edits the same list; a dropdown offers every option the form has.
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  const full = page.getByRole('dialog', { name: 'fixture-employer application, full screen', exact: true });
  await full.getByRole('button', { name: 'Change the answer to Pronouns', exact: true }).click();
  const select = full.getByLabel('New answer', { exact: true });
  await expect(select.locator('option')).toHaveText(['he/him', 'she/her', 'they/them']);
  await expectChevron(select);
  await select.selectOption('they/them');
  await full.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(full.locator('dd').nth(1)).toContainText('they/them');
  await expect(full.getByText('Changed by you. Workie types this in when you press Apply.')).toHaveCount(2);
  expect(fixture.writes.map((request) => [request.path, request.body])).toEqual([
    [`/api/applications/${app.id}/answers`, { edits: { [why]: 'I use Fixture Co every week.\nAnd I want to make it faster.' } }],
    [`/api/applications/${app.id}/answers`, { edits: { [pronouns]: 'they/them' } }]]);
});

// A form's free-response question is a textarea that grows with the answer; choice questions list every choice.
test('a card waiting on answers names the employer its questions name, not the board tenant', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('needs_answer', 'question_unresolved');
  const text = { allowBlank: false, declineValue: null, units: null, precision: null, type: 'text', minLength: 1, maxLength: 4000, format: 'plain' } as const;
  // Two questions: with one, Answer opens it directly, which reads it from an endpoint this fixture does not serve.
  fixture.addQuestion(app, 'Why are you interested in Fixture Co?', text);
  fixture.addQuestion(app, 'Pronouns', text);
  await page.goto('/applications');
  await expect(page.getByRole('list', { name: 'Needs action', exact: true }).getByRole('heading', { level: 2 })).toHaveText('Fixture Co / Intern');
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Answer / Fixture Co', exact: true })).toBeVisible();
  await page.goto('/applications?view=live');
  await expect(page.getByRole('list', { name: 'Live', exact: true }).getByRole('heading', { level: 2 })).toHaveText('Fixture Co / Intern');
  await expect(page.getByText('fixture-employer')).toHaveCount(0);
});

test('question form grows a textarea answer and lists every choice', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('needs_answer', 'question_unresolved');
  const base = { allowBlank: false, declineValue: null, units: null, precision: null };
  const choices = (...labels: string[]) => labels.map((label) => ({ value: label, label }));
  fixture.addQuestion(app, 'Why are you interested in Fixture Co?', { ...base, type: 'textarea', minLength: 1, maxLength: 4000, format: 'plain' });
  fixture.addQuestion(app, 'Which office?', { ...base, type: 'select', options: choices('New York', 'San Francisco', 'Remote'), minSelections: 1, maxSelections: 1 });
  fixture.addQuestion(app, 'Can you start in May?', { ...base, type: 'radio', options: choices('Yes', 'No'), minSelections: 1, maxSelections: 1 });
  fixture.addQuestion(app, 'Which languages?', { ...base, type: 'multiselect', options: choices('English', 'Korean', 'French'), minSelections: 1, maxSelections: 3 });
  await page.goto('/applications?view=live');
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  const form = page.getByRole('form', { name: 'Answer questions', exact: true });
  const why = form.getByRole('textbox', { name: 'Why are you interested in Fixture Co?', exact: true });
  await expect(why).toHaveJSProperty('tagName', 'TEXTAREA');
  const before = (await why.boundingBox())!.height;
  await why.fill(Array.from({ length: 10 }, (_, line) => `Line ${line + 1} of why I want this role.`).join('\n'));
  const after = (await why.boundingBox())!.height;
  expect(after).toBeGreaterThan(before + 50);
  // It grows instead of scrolling inside.
  expect(await why.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await why.fill('Short.');
  await expect.poll(async () => (await why.boundingBox())!.height).toBeLessThan(after);
  await expect(form.getByRole('combobox', { name: 'Which office?', exact: true }).locator('option'))
    .toHaveText(['Choose...', 'New York', 'San Francisco', 'Remote']);
  await expectChevron(form.getByRole('combobox', { name: 'Which office?', exact: true }));
  for (const [group, options] of [['Can you start in May?', ['Yes', 'No']], ['Which languages?', ['English', 'Korean', 'French']]] as const) {
    const set = form.getByRole('group', { name: group, exact: true });
    for (const option of options) await expect(set.getByLabel(option, { exact: true })).toBeVisible();
  }
});

test('sidebar keeps a fixed width, ignores a stale saved width, and collapses to the rail', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const side = page.locator('#side');
  // The drag-to-resize edge is gone; a width an earlier build saved must not come back.
  await page.addInitScript(() => localStorage.setItem('workie-side-width', '400'));
  if (info.project.use.isMobile) {
    await page.goto('/applications');
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
    await expect(side.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
    await expect(side).toHaveCSS('width', '300px');
    await expect(page.locator('body')).toHaveCSS('padding-left', '0px');
    return;
  }
  const width = async (px: number) => {
    await expect(side).toHaveCSS('width', `${px}px`);
    await expect(page.locator('body')).toHaveCSS('padding-left', `${px}px`);
  };
  await page.goto('/applications');
  await expect(side.getByRole('separator', { name: 'Resize sidebar', includeHidden: true })).toHaveCount(0);
  await width(260);
  const toggle = side.locator('.side-collapse');
  await toggle.click();
  await width(56);
  await toggle.click();
  await width(260);
  await page.screenshot({ path: info.outputPath('sidebar-fixed.png') });
});

test('dense layout has native labels keyboard focus and no overflow in light and dark', async ({ page }, info) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  fixture.workers[0].label = 'Synthetic workstation with a deliberately long but valid worker label';
  fixture.addApplication('needs_policy_decision', 'country_scope_requires_owner_confirmation');
  // Measure the drawer where it rests, not mid slide-in.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  const input = page.getByLabel('Worker label', { exact: true });
  await input.fill('Keyboard pairing');
  await input.focus();
  await expect(input).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create pairing grant', exact: true })).toBeFocused();
  // On a phone the sidebar stays hidden until its menu button slides it in.
  if (info.project.use.isMobile) await expect(page.getByRole('button', { name: 'Open sidebar', exact: true })).toBeVisible();
  await expect(page.locator('#side').getByRole('link', { name: 'Profile', exact: true, includeHidden: true })).toHaveAttribute('href', '/profile');
  await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The shared header has its own layout; this checks the page and the drawer.
  const controls = await page.locator('main button:visible, main input:visible, main select:visible').evaluateAll((elements) =>
    elements.filter((element) => !element.closest('.app-header')).map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, right: box.right, width: box.width, height: box.height,
        overflow: element.scrollWidth > element.clientWidth + 1 };
    }));
  for (const box of controls) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(info.project.use.viewport!.width + 1);
    // Postie's buttons and inputs are 34px (workers.module.css .button); 28px is the floor.
    expect(box.height).toBeGreaterThanOrEqual(28);
    expect(box.width).toBeGreaterThan(0);
    expect(box.overflow).toBe(false);
  }
  await page.screenshot({ path: info.outputPath('workers.png'), fullPage: true });
});
