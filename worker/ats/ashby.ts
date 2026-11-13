import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page, Request } from 'playwright';
import { disclosureAnswerKey } from '../../lib/applications/application-context-protocol.ts';
import { SUBMIT_WAIT_MS } from '../../lib/applications/worker-protocol.ts';
import { AtsError, AtsObservationSchema, fillEach, type AtsAdapter, type AtsApplication, type AtsField, type AtsValue, commonAnswer, fieldKeyFor, formQuestionKey } from './protocol.ts';

const VERIFICATION_WAIT_MS = SUBMIT_WAIT_MS; // time for the applicant to pass the captcha in the visible window

// The hosted form lives at /<tenant>/<posting uuid>/application on the posting's own origin.
const formPath = (input: AtsApplication) => `/${input.identity.tenant}/${input.identity.requisition}/application`;
function hosted(input: AtsApplication, href: string) {
  const url = new URL(href);
  return url.origin === new URL(input.applicationUrl).origin && url.pathname === formPath(input);
}
const page = async (runtime: Parameters<AtsAdapter['observe']>[0]) => await runtime.page();

// Ashby saves each answer to its server as it changes, and its server can drop one of two saves in flight at once
// (Rivian's certification box, 2026-10-27), so each answer's save lands before the next answer is touched.
function saves(form: Page) {
  let pending = 0;
  const isSave = (request: Request) => request.url().includes('op=ApiSetFormValue');
  const start = (request: Request) => { if (isSave(request)) pending++; };
  const end = (request: Request) => { if (isSave(request)) pending--; };
  form.on('request', start); form.on('requestfinished', end); form.on('requestfailed', end);
  return {
    async settle() {
      await form.waitForTimeout(250); // a change saves once the page renders it
      for (const until = Date.now() + 15_000; pending > 0 && Date.now() < until;) await form.waitForTimeout(50);
    },
    stop() { form.off('request', start); form.off('requestfinished', end); form.off('requestfailed', end); },
  };
}
// Every question is a field entry titled by a label whose `for` is the question's path; the entry holds its input.
const entry = (page: Page, field: AtsField) => page.locator(`label.ashby-application-form-question-title[for="${field.name}"]`).locator('xpath=..');

// The tab title is "<role> @ <company>"; boards get renamed, so any company passes after the exact role unless it holds another " @ ".
async function titleFits(page: Page, role: string) {
  return page.waitForFunction((prefix) => {
    const title = document.title.replace(/\s+/g, ' ').trim();
    return title.startsWith(prefix) && title.length > prefix.length && !title.slice(prefix.length).includes(' @ ');
  }, `${role.replace(/\s+/g, ' ').trim()} @ `, { timeout: 10_000 }).then(() => true, () => false);
}

export function ashbyAnswer(input: AtsApplication, field: AtsField): AtsValue | undefined {
  if (input.answers[formQuestionKey(field)] !== undefined) return input.answers[formQuestionKey(field)];
  const { first_name: first, last_name: last } = input.answers;
  if (field.name === '_systemfield_name') return typeof first === 'string' && typeof last === 'string' ? `${first} ${last}` : undefined;
  if (field.name === '_systemfield_email') return input.answers.email;
  if (field.name === '_systemfield_location') return input.answers.current_location;
  if (input.answers[disclosureAnswerKey(field.label)] !== undefined) return input.answers[disclosureAnswerKey(field.label)];
  if (field.kind === 'text' && /^(phone|mobile)( number)?$/i.test(field.label.trim())) return input.answers.phone;
  // Ashby's standard self-identification radios, answered only when the profile's answer is one of the offered options.
  const voluntary = ({ _systemfield_eeoc_gender: 'voluntary_gender', _systemfield_eeoc_veteran_status: 'voluntary_veteran' } as Record<string, string>)[field.name ?? ''];
  if (voluntary) {
    const value = input.answers[voluntary];
    return typeof value === 'string' && field.options?.includes(value) ? value : undefined;
  }
  const common = commonAnswer(input, field);
  // A Yes/No profile fact cannot answer a question whose choices are visa types; the applicant picks one.
  return typeof common === 'string' && field.options && !field.options.includes(common) ? undefined : common;
}

async function formFields(page: Page): Promise<AtsField[]> {
  // An education entry is titled twice ("College/University" around "School"); the inner title is the question.
  const raw = await page.evaluate(() => [...document.querySelectorAll('label.ashby-application-form-question-title')]
    .filter(node => node.parentElement!.querySelectorAll('label.ashby-application-form-question-title').length === 1).map(node => {
    const label = node as HTMLLabelElement, box = label.parentElement!;
    const has = (selector: string) => Boolean(box.matches(selector) || box.querySelector(selector));
    const labels = (selector: string) => [...box.querySelectorAll(selector)].map(item => item.textContent?.trim() ?? '');
    const group = labels('.ashby-application-form-input-checkbox-group-option-label');
    // Checked in this order: a file entry also holds buttons, and a phone entry can hold a texting-consent radio.
    const kind = has('input[type=file]') ? 'file' : has('.ashby-application-form-input-yesno') ? 'yesno' :
      has('.ashby-application-form-input-radio-group') ? 'radio' : has('.ashby-application-form-input-checkbox-group') ? (group.length === 1 ? 'checkbox' : 'multi') :
        has('select') ? 'select' : has('.ashby-application-form-input-autocomplete') ? 'combobox' : has('.ashby-application-form-input-date') ? 'date' :
          has('input[type=email]') ? 'email' : has('textarea.ashby-application-form-input-textarea') ? 'textarea' : has('input.ashby-application-form-input-text') ? 'text' : null;
    const title = (label.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    // A heading-only title ("Applicant Arbitration Agreement Acknowledgement") keeps its question in the description and checkbox sentence.
    const description = [...labels('.ashby-application-form-question-description'), ...(kind === 'checkbox' ? group : [])]
      .map(text => text.replace(/\s+/g, ' ').trim()).filter(text => text && text !== title).join(' ').slice(0, 2000);
    return { path: label.htmlFor, label: title, description, kind,
      required: /(^|\s)_required_/.test(label.className),
      options: kind === 'yesno' ? ['Yes', 'No'] : kind === 'radio' ? labels('.ashby-application-form-input-radio-group-option-label') : kind === 'multi' ? group :
        kind === 'select' ? [...box.querySelectorAll('option')].filter(option => !option.disabled).map(option => option.label.trim()) : undefined };
  }));
  // An education history or other composite entry has no single answer; only an optional one can be left empty.
  if (raw.some(item => !item.kind && item.required) || raw.length > 64) throw new AtsError('ASHBY_FIELD_UNSUPPORTED');
  return raw.filter(item => item.kind).map(item => ({
    // The worker attaches the tailored resume under "resume"; Ashby's own cover letter path is already "cover_letter".
    key: item.path === '_systemfield_resume' ? 'resume' : `${fieldKeyFor(item.path)}${item.kind === 'multi' ? '[]' : ''}`,
    label: item.label || item.path, name: item.path, required: item.required, ...(item.description ? { description: item.description } : {}),
    kind: (item.kind === 'yesno' ? 'radio' : item.kind === 'multi' ? 'select' : item.kind) as AtsField['kind'],
    options: item.options?.length && item.options.length <= 100 && item.options.every(option => option && option.length <= 300) ? item.options : undefined,
  }));
}

function choices(field: AtsField, value: AtsValue) {
  const picked = typeof value === 'string' ? [value] : Array.isArray(value) && field.key.endsWith('[]') && value.length ? value : undefined;
  if (!picked) throw new AtsError('ANSWER_TYPE_MISMATCH', field.key);
  if (!picked.every(choice => field.options?.includes(choice))) throw new AtsError('ANSWER_OPTION_INVALID', field.key, field.options);
  return picked;
}

async function fillOne(page: Page, box: Locator, field: AtsField, value: AtsValue, settle: () => Promise<void>) {
  const yesno = box.locator('.ashby-application-form-input-yesno');
  if (field.kind === 'checkbox') {
    if (typeof value !== 'boolean') throw new AtsError('ANSWER_TYPE_MISMATCH', field.key);
    await box.locator('input[type=checkbox]').setChecked(value);
  } else if (field.kind === 'radio' && await yesno.count()) {
    const [choice] = choices(field, value);
    await yesno.getByRole('button', { name: choice, exact: true }).click();
  } else if (field.kind === 'radio') {
    await box.getByLabel(choices(field, value)[0], { exact: true }).check();
  } else if (field.kind === 'select' && field.key.endsWith('[]')) {
    const picked = choices(field, value);
    for (const option of field.options!) { await box.getByLabel(option, { exact: true }).setChecked(picked.includes(option)); await settle(); }
  } else if (field.kind === 'select') {
    await box.locator('select').selectOption({ label: choices(field, value)[0] });
  } else if (typeof value !== 'string') {
    throw new AtsError('ANSWER_TYPE_MISMATCH', field.key);
  } else if (field.kind === 'combobox') {
    const input = box.locator('input[role=combobox]');
    await input.click();
    await input.fill(value);
    const options = page.getByRole('option');
    if (!await options.first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) throw new AtsError('ANSWER_OPTION_INVALID', field.key);
    // Only the exact place, or the one suggestion that extends it ("San Francisco" -> "San Francisco, California, ..."),
    // is the applicant's; anything else goes to the inbox with the geocoder's own spellings to pick from.
    // A school suggestion is three lines (name, country, website: Saronic, 2026-11-13); joined, the name alone is extended by it.
    const texts = (await options.allInnerTexts()).map(item => item.trim().split(/\s*\n\s*/).join(', '));
    const matches = texts.includes(value) ? [value] : texts.filter(item => item.startsWith(`${value}, `));
    if (matches.length !== 1) {
      await page.keyboard.press('Escape');
      throw new AtsError('ANSWER_OPTION_INVALID', field.key, texts.length ? texts.slice(0, 100) : undefined);
    }
    const text = matches[0];
    await options.nth(texts.indexOf(text)).click(); // by position: a multi-line suggestion's own text has no separators to match
    // The input takes the picked suggestion a moment after the click.
    await page.waitForFunction(([node, text]) => { const shown = (node as HTMLInputElement).value;
      return shown === text || Boolean(shown) && text.startsWith(`${shown}, `); },[await input.elementHandle(), text] as const, { timeout: 5_000 }).catch(() => {});
  } else {
    const input = box.locator('input.ashby-application-form-input-text, textarea, input.ashby-application-form-input-date').first();
    await input.fill(field.kind === 'date' ? pickerDate(value) : value);
    // The date picker stays open over the next question until dismissed.
    if (field.kind === 'date') await input.press('Escape');
    await input.blur(); // a typed answer saves on blur, not half a second later while the next answer saves
  }
}

async function verifyOne(box: Locator, field: AtsField, value: AtsValue) {
  const yesno = box.locator('.ashby-application-form-input-yesno');
  if (field.kind === 'checkbox') return await box.locator('input[type=checkbox]').isChecked() === value;
  if (field.kind === 'radio' && await yesno.count()) {
    return await yesno.getByRole('button', { name: String(value), exact: true }).getAttribute('aria-pressed') === 'true';
  }
  if (field.kind === 'radio' || (field.kind === 'select' && field.key.endsWith('[]'))) {
    const picked = typeof value === 'string' ? [value] : value as string[];
    for (const option of field.options!) if (await box.getByLabel(option, { exact: true }).isChecked() !== picked.includes(option)) return false;
    return true;
  }
  if (field.kind === 'select') return await box.locator('select').evaluate(node => (node as HTMLSelectElement).selectedOptions[0]?.label) === value;
  // An autocomplete holds the suggestion it picked: the answer itself or the one place extending it.
  if (field.kind === 'combobox' && typeof value === 'string') {
    const shown = (await box.locator('input[role=combobox]').inputValue()).trim();
    // A school picker shows only the name of the suggestion picked ("Stanford University, United States, stanford.edu").
    return shown === value || shown.startsWith(`${value}, `) || Boolean(shown) && value.startsWith(`${shown}, `);
  }
  return await box.locator('input.ashby-application-form-input-text, textarea, input.ashby-application-form-input-date').first().inputValue() ===
    (field.kind === 'date' && typeof value === 'string' ? pickerDate(value) : value);
}

/** Ashby's date picker shows the day it parsed as MM/DD/YYYY ("December 2028" -> 12/01/2028); an ISO date is that calendar day. */
export function pickerDate(value: string) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = iso ? new Date(+iso[1], +iso[2] - 1, +iso[3]) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`;
}

export const ashby: AtsAdapter = {
  id: 'ashby',
  hosts: ['jobs.ashbyhq.com'],
  // The app's scripts and styles; attached files upload straight to this bucket (a blocked upload never shows the file);
  // reCAPTCHA Enterprise scores every submission, and a blocked one is refused as spam. Locations autocomplete on jobs.ashbyhq.com itself.
  origins: ['https://cdn.ashbyprd.com', 'https://ashbyhq-infra-prd-main-app-uploaded-files-us-east-1.s3.us-east-1.amazonaws.com',
    'https://www.recaptcha.net', 'https://www.gstatic.com'],
  answer: ashbyAnswer,
  async observe(runtime, input, signal) {
    signal?.throwIfAborted();
    const url = new URL(input.applicationUrl);
    const form = await runtime.navigate(await page(runtime), `${url.origin}${formPath(input)}`);
    // The form renders client-side; a closed posting renders the job board instead.
    if (!await form.locator('label.ashby-application-form-question-title').first().waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
      throw new AtsError('ASHBY_FORM_NOT_FOUND');
    }
    if (!hosted(input, form.url()) || !await titleFits(form, input.role)) throw new AtsError('ATS_IDENTITY_MISMATCH');
    return AtsObservationSchema.parse({ identity: input.identity, company: input.company, role: input.role, fields: await formFields(form), actions: ['fill'] });
  },
  async fill(runtime, input, observation, signal) {
    signal?.throwIfAborted();
    const form = await page(runtime);
    // Files go first: attaching a resume autofills the form and clears what it does not hold (Harvey, 2026-10-26).
    const fields = [...observation.fields].sort((a, b) => Number(b.kind === 'file') - Number(a.kind === 'file'));
    const saved = saves(form);
    try {
      await fillEach(fields, async field => {
        const box = entry(form, field);
        if (field.kind === 'file') {
          const path = input.documents[field.key];
          if (!path) { if (field.required) throw new AtsError('REQUIRED_DOCUMENT_MISSING', field.key); return; }
          await box.locator('input[type=file]').setInputFiles(path);
          // Ashby uploads on attach and lists the file by name only once the upload is done.
          const name = path.split('/').pop()!;
          if (!await box.locator('.ashby-application-form-input-file-item-name', { hasText: name }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
            throw new AtsError('FIELD_RECONCILIATION_FAILED', field.key);
          }
          await form.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}); // let the resume autofill land
          return;
        }
        const value = ashbyAnswer(input, field);
        if (value === undefined) { if (field.required) throw new AtsError('REQUIRED_ANSWER_MISSING', field.key); return; }
        await fillOne(form, box, field, value, saved.settle);
        await saved.settle();
        if (!await verifyOne(box, field, value)) throw new AtsError('FIELD_RECONCILIATION_FAILED', field.key);
      });
    } finally { saved.stop(); }
    // A field cleared after its own check would only show after Submit, as a timeout; recheck them all before.
    for (const field of fields) {
      const value = field.kind === 'file' ? undefined : ashbyAnswer(input, field);
      if (value !== undefined && !await verifyOne(entry(form, field), field, value)) throw new AtsError('FIELD_RECONCILIATION_FAILED', field.key);
    }
  },
  async submit(runtime, input, signal) {
    signal?.throwIfAborted();
    const form = await page(runtime);
    const button = form.getByRole('button', { name: 'Submit Application', exact: true });
    if (!await button.count()) throw new AtsError('SUBMIT_CONTROL_NOT_FOUND');
    await button.click();
    const success = form.locator('.ashby-application-form-success-container');
    // A low reCAPTCHA score replaces the form with "There was a problem verifying this submission with CAPTCHA..."; a challenge opens its own frame.
    const captcha = form.locator('.ashby-application-form-failure-container', { hasText: 'CAPTCHA' }).or(form.locator('iframe[title*="challenge" i]'));
    // Ashby's spam filter refuses the submit outright and keeps the form (Rivian, 2026-10-27): it was not sent.
    const refused = form.locator('.ashby-application-form-failure-container', { hasText: /flagged as possible spam/i });
    await success.or(captcha).or(refused).first().waitFor({ timeout: 60_000 }).catch(() => {});
    if (await success.isVisible()) return;
    if (await refused.first().isVisible()) {
      const screenshot = join(tmpdir(), `workie-ashby-refused-${Date.now()}.png`);
      await form.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), status: 'submit-refused', company: input.company, role: input.role, url: form.url(), screenshot }) + '\n');
      throw new AtsError('SUBMISSION_REFUSED_SPAM');
    }
    if (await captcha.first().isVisible()) {
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), status: 'captcha-required', company: input.company, role: input.role }) + '\n');
      try { await success.waitFor({ timeout: VERIFICATION_WAIT_MS }); return; }
      catch { throw new AtsError('CAPTCHA_TIMEOUT'); }
    }
    // Neither outcome showed: log what the page does show (a rejection, field errors, a dead button) to tell them apart.
    const shown = await form.locator('.ashby-application-form-failure-container, [role="alert"]').allInnerTexts().catch(() => []);
    // Kept on this machine only: what the page showed, for the next look at an unconfirmed submit.
    const screenshot = join(tmpdir(), `workie-ashby-unconfirmed-${Date.now()}.png`);
    await form.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    process.stdout.write(JSON.stringify({ at: new Date().toISOString(), status: 'submit-unconfirmed', company: input.company, role: input.role,
      url: form.url(), screenshot, shown: shown.map((text) => text.trim().slice(0, 300)).filter(Boolean).slice(0, 10),
      buttonEnabled: await button.isEnabled().catch(() => null) }) + '\n');
    throw new AtsError('SUBMISSION_CONFIRMATION_TIMEOUT');
  },
  async receipt(runtime, input, signal) {
    signal?.throwIfAborted();
    const form = await page(runtime);
    // The success message replaces the form in place: same posting URL, same "<role> @ <company>" title.
    if (!hosted(input, form.url()) || !await form.locator('.ashby-application-form-success-container').isVisible() || !await titleFits(form, input.role)) {
      throw new AtsError('RECEIPT_NOT_VERIFIED');
    }
    return { identity: input.identity, company: input.company, role: input.role,
      receiptId: `ab-${createHash('sha256').update(form.url() + input.identity.requisition).digest('hex').slice(0, 32)}`, submittedAt: Date.now() };
  },
};
