import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { pairWorker, startWorker } from './worker.mjs';

const state = JSON.parse(readFileSync(process.env.E2E_STATE!, 'utf8'));
const root = resolve(state.out, '../../..');
const screens = join(dirname(state.out), 'screens');
mkdirSync(screens, { recursive: true });
const QUESTION = 'Why are you interested in Fixture Co?';
const HEARD_QUESTION = 'How did you hear about this job?';
const HEARD = ['LinkedIn', 'University career fair', 'Company website', 'Referral', 'Other'];
const ANSWER = ['I use Fixture Co tools every week.', 'I build TypeScript APIs and want to work on reliability.',
  'Your interns ship real features.', 'I like CI that catches bugs early.', 'The team writes about its incidents openly.',
  'I want to learn from that.', 'Remote work suits how I study.', 'Thank you for reading.'].join('\n');
const EDITED = 'I rely on Fixture Co every week and want to make its APIs faster.';
const ROLE2_ANSWER = 'New York is close to my school, and I want to build Fixture Co APIs.';

// A tiny master resume, as in tests/auto-apply/greenhouse-pipeline.mjs.
function masterDocx() {
  const paragraphs = ['Test Applicant', 'Built REST APIs in TypeScript for a scheduling product used by students',
    'Reduced dashboard query time by 95 percent with indexed joins', 'Skills: TypeScript, PostgreSQL, React'];
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
      paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`),
  }));
}

async function pane(page: Page, hash: string) {
  await page.getByRole('navigation', { name: 'Profile sections' }).locator(`a[href="#${hash}"]`).click();
  await expect(page.locator(`section#${hash}`)).toBeVisible();
}
const saved = (page: Page) => expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
const tab = (page: Page, name: 'Needs action' | 'Live' | 'Applied') =>
  page.getByRole('navigation', { name: 'Applications' }).getByRole('button', { name: new RegExp(`^${name}`) });
const list = (page: Page, name: 'Needs action' | 'Live' | 'Applied') => page.getByRole('list', { name, exact: true });
/** One role's card in a list, told apart by its job post link (both fixture roles share company and title). */
const card = (page: Page, name: 'Needs action' | 'Live' | 'Applied', requisition: string) =>
  list(page, name).getByRole('listitem').filter({ has: page.locator(`a[href$="/jobs/${requisition}"]`) });
const VIEW = { 'Needs action': '/applications', Live: '/applications?view=live', Applied: '/applications?view=applied' } as const;
/** Reloads the tab until `check` passes: rows refresh on their own only once a minute. Every 15 s at most: each load is
 * about eight private requests, and the server allows an applicant 60 a minute (lib/applications/private-http.ts). */
async function until(page: Page, name: keyof typeof VIEW, check: () => Promise<void>, timeout: number, log?: () => Promise<void>) {
  await expect(async () => {
    if (!page.url().endsWith(VIEW[name])) await page.goto(VIEW[name]); else await page.reload();
    await log?.();
    await check();
  }).toPass({ timeout, intervals: [15_000] });
}
// Rows show the employer's name only once a submission names it; before that the card names the board's tenant.
const SCREEN = /^Workie's browser filling the .+ application$/;
/** Notes every step and picture a Live card shows, twice a second, until stopped (the tab polls frames every 3 s). */
function record(card: Locator) {
  const seen = { steps: new Set<string>(), srcs: new Set<string>() };
  const step = card.locator('p[aria-live="polite"]'), img = card.getByRole('img', { name: SCREEN });
  let on = true;
  const loop = (async () => {
    while (on) {
      const text = await step.textContent({ timeout: 500 }).catch(() => null);
      const src = await img.getAttribute('src', { timeout: 500 }).catch(() => null);
      if (text && src) { seen.steps.add(text.replace(/ · updated.*$/, '')); seen.srcs.add(src); }
      await card.page().waitForTimeout(500).catch(() => { on = false; });
    }
  })();
  return { seen, stop: async () => { on = false; await loop; } };
}
/** A filled-answer row on a card: its value and whether the applicant changed it. */
const answerRow = (scope: Locator, label: string) => scope.locator('dl > div').filter({ has: scope.page().locator('dt', { hasText: new RegExp(`^${label.replace(/[?.]/g, '\\$&')}$`) }) }).locator('dd');

test('a run fills, asks, takes review changes, reuses a choice on the next form and submits with an emailed code', async ({ page }) => {
  test.setTimeout(40 * 60_000);
  // Sign in as DY with the local household passcode.
  await page.goto('/sign-in');
  await page.getByLabel('Applicant').selectOption('dy');
  await page.getByLabel('Passcode').fill(state.passcode);
  await page.getByRole('button', { name: 'Unlock Workie' }).click();
  await page.waitForURL('/');
  const account = await page.evaluate(() => fetch('/api/auth/applicant').then((r) => r.json()));
  const ownerId: string = account.ownerId;
  // Diagnostics only: the assertions below read the UI.
  const states = () => page.evaluate((owner) => fetch('/api/application-runs', { headers: { 'x-workie-applicant': owner } })
    .then((r) => r.json()).then((body) => body.applications.map((app: { requisition: string; state: string; reasonCode: string | null }) =>
      `${app.requisition}:${app.state}/${app.reasonCode}`)), ownerId);
  const logStates = async () => console.log(`applications: ${(await states()).join(', ') || 'none yet'}`);

  await test.step('profile: identity, authorization, country and resume (no provider yet)', async () => {
    await page.goto('/profile#identity');
    await saved(page);
    await page.getByRole('textbox', { name: 'Legal first name' }).fill('Test');
    await page.getByRole('textbox', { name: 'Legal last name' }).fill('Applicant');
    await page.getByRole('textbox', { name: 'Personal email', exact: true }).fill('test-applicant@example.com');
    await page.getByRole('textbox', { name: 'LinkedIn' }).fill('https://www.linkedin.com/in/test-applicant');
    await page.getByRole('button', { name: 'Add phones entry' }).click();
    await page.getByRole('textbox', { name: 'Phone number' }).fill('4155550123');
    await page.getByRole('textbox', { name: 'Calling code' }).fill('+1');
    await page.getByRole('textbox', { name: 'Country (2-letter code)', exact: true }).fill('US');
    await saved(page);

    await pane(page, 'authorization');
    await page.getByRole('button', { name: 'Add countries entry' }).click();
    const authorization = page.locator('section#authorization');
    await authorization.getByRole('textbox', { name: 'Country (2-letter code)', exact: true }).fill('US');
    // Each authorization fact must be scoped to the same country; the editor opens its scope controls to ask.
    for (const [fact, answer] of [['Right to work', 'Yes'], ['Sponsorship required now', 'No'], ['Sponsorship required in future', 'No']]) {
      await authorization.getByRole('radio', { name: `${fact}: ${answer}` }).check();
      await authorization.getByRole('combobox', { name: `${fact} scope: Kind` }).selectOption({ label: 'Country (2-letter code)' });
      await authorization.getByRole('textbox', { name: `${fact} scope: Country (2-letter code)` }).fill('US');
    }
    await saved(page);

    await pane(page, 'preferences');
    const preferences = page.locator('section#preferences');
    await preferences.getByRole('group', { name: 'Countries', exact: true }).getByRole('button', { name: 'Add countries entry' }).click();
    await preferences.getByRole('textbox', { name: 'Countries 1' }).fill('US');
    await saved(page);

    await pane(page, 'documentsProvider');
    const documents = page.locator('section#documentsProvider');
    await documents.getByLabel('Upload file (up to 10 MB)').setInputFiles({ name: 'TestApplicant_Resume.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: masterDocx() });
    await documents.getByRole('button', { name: 'Upload document' }).click();
    await expect(documents.getByRole('cell', { name: /^Available/ })).toBeVisible({ timeout: 60_000 });
    await documents.getByRole('button', { name: 'Add resume masters by role entry' }).click();
    await documents.getByRole('textbox', { name: 'Role', exact: true }).fill('Software Engineering Intern');
    await documents.getByRole('combobox', { name: 'Document version' }).selectOption({ index: 1 });
    await saved(page);
  });

  // (a) The worker starts while no provider is set; enabling it afterwards must not need a restart (worker/main.ts setup).
  let worker: ReturnType<typeof startWorker> | undefined;
  try {
    await test.step('a: pair and start the worker before any provider is enabled', async () => {
      await page.goto('/applications?settings=1');
      const drawer = page.getByRole('dialog', { name: 'Settings' });
      await drawer.getByRole('textbox', { name: 'Worker label' }).fill('e2e worker');
      await drawer.getByRole('button', { name: 'Create pairing grant' }).click();
      const grant = await drawer.getByRole('textbox', { name: 'Pairing grant' }).inputValue();
      await pairWorker(state, ownerId, grant);
      await drawer.getByRole('button', { name: 'Dismiss secret' }).click();
      worker = startWorker(state, ownerId);
      await expect(async () => {
        await drawer.getByRole('button', { name: 'Refresh' }).click();
        await expect(drawer.getByRole('list', { name: 'Workers' })).toContainText('Online', { timeout: 3_000 });
      }).toPass({ timeout: 90_000, intervals: [5_000] });
    });

    await test.step('a: then pick the local provider and enable the policy', async () => {
      await page.goto('/profile#documentsProvider');
      const documents = page.locator('section#documentsProvider');
      await expect(documents).toBeVisible();
      await documents.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('local');
      await documents.getByRole('textbox', { name: 'Model', exact: true }).fill(state.ollama.model);
      await documents.getByRole('textbox', { name: 'Endpoint', exact: true }).fill(state.ollama.endpoint);
      await saved(page);

      // Policy: Greenhouse, US, read/tailor/fill/submit. Not submit_without_review: Apply stays a manual click.
      await pane(page, 'auto-apply-policy');
      const policy = page.locator('#auto-apply-policy');
      for (const action of ['Read jobs', 'Tailor documents', 'Fill forms', 'Submit']) await policy.getByRole('checkbox', { name: `Policy: Actions: ${action}`, exact: true }).check();
      await policy.getByRole('button', { name: 'Add policy: destinations entry' }).click();
      await policy.getByRole('textbox', { name: 'Policy: Destinations 1' }).fill('job-boards.greenhouse.io');
      await policy.getByRole('button', { name: 'Add policy: countries entry' }).click();
      await policy.getByRole('textbox', { name: 'Policy: Countries 1' }).fill('US');
      await policy.getByRole('checkbox', { name: 'Policy: Document Kinds: Resume' }).check();
      await policy.getByRole('button', { name: 'Add policy: allowed providers entry' }).click();
      await policy.getByRole('textbox', { name: 'Policy: Allowed Providers 1' }).fill('local:ollama');
      // Both fixture roles are Fixture Co's: two per employer. A confirmed choice carries over to the next form only
      // when the policy sends confirmed answers without asking each time (questions.ts reusableAnswer).
      await policy.getByRole('spinbutton', { name: 'Policy: Per Employer Cap' }).fill('2');
      await policy.getByRole('combobox', { name: 'Policy: Disclosure' }).selectOption('confirmed_only');
      await policy.getByRole('button', { name: 'Save policy' }).click();
      await expect(policy.getByRole('status')).toContainText('saved');
      await policy.getByRole('checkbox', { name: /^Accept policy version/ }).check();
      await policy.getByRole('button', { name: 'Enable Auto Apply' }).click();
      await expect(policy.getByRole('status')).toContainText('accepted');

      // Started from Settings over the Live tab, so Live is already polling when the worker opens the form.
      await page.goto('/applications?view=live&settings=1');
      const drawer = page.getByRole('dialog', { name: 'Settings' });
      await expect(async () => {
        await drawer.getByRole('button', { name: 'Refresh' }).click();
        await expect(drawer.getByRole('button', { name: 'Start auto apply now' })).toBeEnabled({ timeout: 3_000 });
      }).toPass({ timeout: 60_000, intervals: [5_000] });
      await drawer.getByRole('button', { name: 'Start auto apply now' }).click();
      await expect(drawer.getByText('A run is going.')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(tab(page, 'Live')).toHaveAttribute('aria-current', 'page');
    });

    // Every step and picture role 1's Live card shows from here to the end of d.
    const recorder = record(card(page, 'Live', '4000001'));
    await test.step('b: role 1 shows on Live with the worker\'s picture, then waits in Needs action', async () => {
      const live = card(page, 'Live', '4000001');
      // Screening and tailoring come first; the picture shows once the worker opens the form.
      await expect(live.getByRole('img', { name: SCREEN })).toBeVisible({ timeout: 8 * 60_000 });
      await page.screenshot({ path: join(screens, '1-live-reading.png'), fullPage: true });
      await expect(live.getByRole('button', { name: 'Answer', exact: true })).toBeVisible({ timeout: 5 * 60_000 });
      // The first pass only reads the form (about 3 s here) and asks before typing anything, so Live may show only the
      // parked picture; the fill proper, with its changing picture, is checked in d.
      console.log(`b saw: ${[...recorder.seen.steps].join(' | ')}; ${recorder.seen.srcs.size} pictures`);

      // The worker was never restarted: the provider it found off at start is used now (tailoring went through it).
      expect(worker!.child.exitCode).toBeNull();
      await until(page, 'Needs action', async () => {
        const row = card(page, 'Needs action', '4000001');
        await expect(row.getByText(QUESTION)).toBeVisible({ timeout: 5_000 });
        await expect(row.getByText(HEARD_QUESTION)).toBeVisible({ timeout: 1_000 });
        await expect(row.getByRole('button', { name: 'Answer', exact: true })).toBeVisible({ timeout: 1_000 });
      }, 6 * 60_000, logStates);
      expect(JSON.parse(readFileSync(join(state.out, 'ollama-calls.json'), 'utf8'))).toContain('tailor');
    });

    await test.step('c: answer both questions: the textarea grows, the dropdown lists every option', async () => {
      // Answered from the Live card, so the refill that follows is on screen from its first frame.
      await page.goto(VIEW.Live);
      await card(page, 'Live', '4000001').getByRole('button', { name: 'Answer', exact: true }).click();
      const form = page.getByRole('form', { name: 'Answer questions' });
      const text = form.getByRole('textbox', { name: QUESTION });
      const select = form.getByRole('combobox', { name: HEARD_QUESTION });
      await expect(text).toBeVisible();
      expect(await text.evaluate((node) => node.tagName)).toBe('TEXTAREA');
      await expect(select.locator('option')).toHaveText(['Choose...', ...HEARD]);
      const before = (await text.boundingBox())!.height;
      await text.fill(ANSWER);
      await expect.poll(async () => (await text.boundingBox())!.height).toBeGreaterThan(before + 40);
      await select.selectOption('University career fair');
      await page.screenshot({ path: join(screens, '2-answer-form.png'), fullPage: true });
      await form.getByRole('button', { name: 'Submit 2 answers' }).click();
      await expect(form).toBeHidden({ timeout: 60_000 });
    });

    await test.step('d: role 1 refills on Live; changed answers persist across a reload', async () => {
      const live = card(page, 'Live', '4000001');
      await expect(live.getByText('Filled. Waiting for your approval')).toBeVisible({ timeout: 8 * 60_000 });
      await recorder.stop();
      const { seen } = recorder;
      console.log(`b+d saw: ${[...seen.steps].join(' | ')}; ${seen.srcs.size} pictures`);
      expect(seen.steps, 'Live showed the form while the worker filled it').toContain('Filling the form');
      expect(seen.srcs.size, 'the live picture changed while the worker filled').toBeGreaterThanOrEqual(2);
      await expect(live.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
      // What the worker filled from the inbox answers.
      await expect(answerRow(live, HEARD_QUESTION)).toContainText('University career fair');
      await expect(answerRow(live, QUESTION)).toContainText('I use Fixture Co tools every week.');

      await live.getByRole('button', { name: `Change the answer to ${HEARD_QUESTION}` }).click();
      const choice = live.getByLabel('New answer');
      await expect(choice.locator('option')).toHaveText(HEARD);
      await choice.selectOption('Referral');
      await live.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(answerRow(live, HEARD_QUESTION)).toContainText('Referral');
      await expect(answerRow(live, HEARD_QUESTION)).toContainText('Changed by you');

      await live.getByRole('button', { name: `Change the answer to ${QUESTION}` }).click();
      const essay = live.getByLabel('New answer');
      expect(await essay.evaluate((node) => node.tagName)).toBe('TEXTAREA');
      await expect(essay).toHaveValue(ANSWER);
      await essay.fill(EDITED);
      await live.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(answerRow(live, QUESTION)).toContainText(EDITED);

      await page.reload();
      await expect(answerRow(live, HEARD_QUESTION)).toContainText('Referral', { timeout: 30_000 });
      await expect(answerRow(live, HEARD_QUESTION)).toContainText('Changed by you');
      await expect(answerRow(live, QUESTION)).toContainText(EDITED);
      await expect(answerRow(live, QUESTION)).toContainText('Changed by you');
      await live.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(screens, '3-live-edits.png'), fullPage: true });
    });

    await test.step('e: role 2 appears mid-run and asks only the essay; the choice is reused', async () => {
      execFileSync(process.execPath, ['tests/auto-apply-e2e/catalog.mjs', state.catalog, '4000002'],
        { cwd: root, env: { PATH: state.worker.PATH, HOME: state.worker.HOME, NODE_ENV: 'production' }, stdio: 'inherit' });
      await until(page, 'Needs action', async () => {
        const row = card(page, 'Needs action', '4000002');
        await expect(row.getByText(QUESTION)).toBeVisible({ timeout: 5_000 });
        await expect(row.getByRole('button', { name: 'Answer', exact: true })).toBeVisible({ timeout: 1_000 });
      }, 8 * 60_000, logStates);
      await expect(card(page, 'Needs action', '4000002').getByText(HEARD_QUESTION)).toHaveCount(0);
      // Not yet submitted, so the employer's name comes from its question, not the board tenant.
      await expect(card(page, 'Needs action', '4000002').getByRole('heading', { level: 2 })).toHaveText('Fixture Co / Software Engineering Intern');
    });

    await test.step('f: Apply role 1, enter the emailed code, and it lands in Applied with the changed answers', async () => {
      await page.goto(VIEW.Live);
      const live = card(page, 'Live', '4000001');
      await live.getByRole('button', { name: 'Apply', exact: true }).click();
      await live.getByRole('button', { name: 'Yes, apply' }).click();
      const code = live.getByLabel(/emailed you a security code/);
      // Live reloads a row as soon as its frame shows it moved; no page reload needed.
      await expect(code).toBeVisible({ timeout: 5 * 60_000 });
      await code.fill('ABCD1234');
      await page.screenshot({ path: join(screens, '4-code-box.png'), fullPage: true });
      await live.getByRole('button', { name: 'Send code' }).click();
      await expect(live.getByRole('status').filter({ hasText: /^Sent\./ })).toBeVisible();

      const applied = card(page, 'Applied', '4000001');
      await until(page, 'Applied', () => expect(applied).toBeVisible({ timeout: 5_000 }), 6 * 60_000, logStates);
      await expect(applied.getByText(/^Applied /)).toBeVisible();
      await applied.getByText('What you sent').click();
      // Tailored through the provider enabled after the worker started (a).
      await expect(applied.getByText(/^Tailored resume: 1 line rewritten/)).toBeVisible();
      await expect(answerRow(applied, HEARD_QUESTION)).toHaveText('Referral');
      await expect(answerRow(applied, QUESTION)).toHaveText(EDITED);
      await page.screenshot({ path: join(screens, '5-applied.png'), fullPage: true });
      await page.goto(VIEW.Live);
      await expect(page.locator('a[href$="/jobs/4000002"]').first()).toBeVisible();
      await expect(card(page, 'Live', '4000001')).toHaveCount(0);
      await page.goto(VIEW['Needs action']);
      await expect(card(page, 'Needs action', '4000002')).toBeVisible();
      await expect(card(page, 'Needs action', '4000001')).toHaveCount(0);
    });

    await test.step('g: answer role 2\'s essay; it reaches approval with the reused choice filled', async () => {
      await card(page, 'Needs action', '4000002').getByRole('button', { name: 'Answer', exact: true }).click();
      const form = page.getByRole('form', { name: 'Answer questions' });
      await expect(form.getByRole('textbox', { name: QUESTION })).toBeVisible();
      await expect(form.getByRole('combobox', { name: HEARD_QUESTION })).toHaveCount(0);
      await form.getByRole('textbox', { name: QUESTION }).fill(ROLE2_ANSWER);
      await form.getByRole('button', { name: 'Submit 1 answer' }).click();
      await expect(form).toBeHidden({ timeout: 60_000 });
      const live = card(page, 'Live', '4000002');
      await page.goto(VIEW.Live);
      await expect(live.getByText('Filled. Waiting for your approval')).toBeVisible({ timeout: 8 * 60_000 });
      await expect(live.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
      await expect(answerRow(live, HEARD_QUESTION)).toContainText('University career fair');
      await expect(answerRow(live, QUESTION)).toContainText(ROLE2_ANSWER);
      await logStates();
    });
  } finally {
    worker?.stop();
  }
});
