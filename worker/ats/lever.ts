import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { disclosureAnswerKey } from '../../lib/applications/application-context-protocol.ts';
import { SUBMIT_WAIT_MS } from '../../lib/applications/worker-protocol.ts';
import { AtsError, AtsObservationSchema, fillEach, type AtsAdapter, type AtsApplication, type AtsField, type AtsIdentity, type AtsValue, commonAnswer, fieldKeyFor, formQuestionKey, nameKey } from './protocol.ts';

const CAPTCHA_WAIT_MS = SUBMIT_WAIT_MS; // time for the applicant to solve an hCaptcha challenge in the visible window

// EU postings carry the host in the tenant ("jobs.eu.lever.co:acme"); the official posting is its host, tenant and lowercase UUID.
function posting(identity: AtsIdentity) {
  const eu = identity.tenant.startsWith('jobs.eu.lever.co:');
  return `https://${eu ? 'jobs.eu.lever.co' : 'jobs.lever.co'}/${eu ? identity.tenant.slice('jobs.eu.lever.co:'.length) : identity.tenant}/${identity.requisition}`;
}
/** Whether href is this posting's page with the given suffix ('' for the posting, '/apply', '/thanks'). */
function at(href: string, input: AtsApplication, suffix: string) {
  const url = new URL(href);
  return `${url.origin}${url.pathname}`.replace(/\/$/, '').toLowerCase() === `${posting(input.identity)}${suffix}`.toLowerCase();
}
const collapsed = (text: string) => text.replace(/\s+/g, ' ').trim();
const named = (page: Page, field: AtsField) => page.locator(`[name="${field.name}"]`);

function leverAnswer(input: AtsApplication, field: AtsField): AtsValue | undefined {
  const { answers } = input;
  if (answers[formQuestionKey(field)] !== undefined) return answers[formQuestionKey(field)];
  // Lever's EEO choices differ by employer ("I am not a veteran" vs "I am not a protected veteran"); only an exact one is used.
  const choice = (value: AtsValue | undefined) => typeof value === 'string' && field.options?.includes(value) ? value : undefined;
  switch (field.name) {
    case 'name': return typeof answers.first_name === 'string' && typeof answers.last_name === 'string' ? `${answers.first_name} ${answers.last_name}` : undefined;
    case 'email': return answers.email;
    case 'phone': return answers.phone;
    case 'location': return answers.current_location;
    case 'urls[LinkedIn]': return answers.linkedin;
    case 'urls[GitHub]': return answers.github;
    case 'urls[Portfolio]': return answers.portfolio;
    case 'eeo[gender]': return choice(answers.voluntary_gender);
    case 'eeo[veteran]': return choice(answers.voluntary_veteran);
  }
  if (answers[disclosureAnswerKey(field.label)] !== undefined) return answers[disclosureAnswerKey(field.label)];
  return commonAnswer(input, field);
}

export async function leverFields(form: Locator): Promise<AtsField[]> {
  const raw = await form.evaluate(element => {
    const fields = new Map<string, { name: string; label: string; kind: string; required: boolean; options?: string[] }>();
    for (const node of element.querySelectorAll('input[name],select[name],textarea[name]')) {
      const input = node as HTMLInputElement;
      // Hidden inputs carry Lever's own state (card templates, captcha token); hidden questions (a disability signature) are not asked.
      if (input.type === 'hidden' || input.disabled || !input.checkVisibility()) continue;
      const question = input.closest('.application-question');
      const labelNode = question?.querySelector('.application-label') ?? (input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null);
      const label = (labelNode?.textContent ?? '').replace(/✱/g, ' ').replace(/\s+/g, ' ').trim() || input.placeholder || input.name;
      // The resume input is marked required only by the asterisk in its label.
      const required = input.required || input.getAttribute('aria-required') === 'true' || Boolean(question?.querySelector('.application-label .required'));
      const existing = fields.get(input.name);
      if (existing && (input.type === 'radio' || input.type === 'checkbox')) {
        existing.options!.push(input.value);
        existing.required ||= required;
        continue;
      }
      fields.set(input.name, { name: input.name, label, required,
        kind: input.type === 'file' ? 'file' : input.type === 'radio' ? 'radio' : input.type === 'checkbox' ? 'checkbox' :
          node instanceof HTMLSelectElement ? 'select' : input.type === 'email' ? 'email' : input.type === 'textarea' ? 'textarea' : 'text',
        options: input.type === 'radio' || input.type === 'checkbox' ? [input.value] :
          node instanceof HTMLSelectElement ? [...node.options].filter(option => option.value).map(option => option.label.trim()).filter(Boolean) : undefined });
    }
    return [...fields.values()];
  });
  if (raw.length > 64) throw new AtsError('LEVER_FIELD_UNSUPPORTED');
  return raw.map(({ kind, options, ...item }) => ({ ...item, label: item.label.slice(0, 1000),
    // Boxes sharing one name are one multi-select question; the "[]" key makes its answer a list.
    key: `${fieldKeyFor(item.name)}${kind === 'checkbox' ? '[]' : ''}`, kind: (kind === 'checkbox' ? 'radio' : kind) as AtsField['kind'],
    // A long dropdown (Palantir lists every university) is asked as text and checked against the live options on fill.
    options: options && options.length <= 100 && options.every(option => option.length <= 300) ? options : undefined }));
}

// A long list (Palantir's universities) is asked as text: the exact option, or the one option the typed name matches
// written another way (nameKey), or, when loose, the one that contains it ("Stanford" picks "Stanford University").
// Anything ambiguous is asked again.
export function matchOption(options: string[], value: string, loose = true) {
  const key = nameKey(value);
  if (options.includes(value) || !key) return options.includes(value) ? value : undefined;
  const equal = options.filter(option => nameKey(option) === key);
  if (equal.length || !loose) return equal.length === 1 ? equal[0] : undefined;
  const containing = options.filter(option => nameKey(option).includes(key));
  return containing.length === 1 ? containing[0] : undefined;
}

async function liveOptions(locator: Locator) {
  return locator.evaluate(node => [...(node as HTMLSelectElement).options].filter(option => option.value).map(option => option.label.trim()));
}

// The location box only accepts a pick from Lever's own suggestions, which spell places their own way ("San Francisco, CA, USA").
async function suggestions(page: Page, input: Locator, text: string) {
  await input.fill('');
  await input.pressSequentially(text, { delay: 20 });
  const items = page.locator('.dropdown-results .dropdown-location');
  await items.first().waitFor({ timeout: 5_000 }).catch(() => {});
  return items;
}

async function fillLever(page: Page, field: AtsField, value: AtsValue | undefined, documents: Record<string, string>, loose: boolean) {
  if (field.required && value === undefined && field.kind !== 'file') throw new AtsError('REQUIRED_ANSWER_MISSING', field.key);
  const locator = named(page, field).first();
  if (!await locator.count()) throw new AtsError('FIELD_NOT_FOUND', field.key);
  if (field.kind === 'file') {
    const path = documents[field.key];
    if (!path) throw new AtsError('REQUIRED_DOCUMENT_MISSING', field.key);
    await locator.setInputFiles(path);
    // Lever parses the resume and prefills the form from it; wait so that prefill cannot overwrite the profile's answers.
    if (field.name === 'resume' && await page.locator('.resume-upload-success').count()) await page.locator('.resume-upload-success, .resume-upload-failure').filter({ visible: true }).first().waitFor({ timeout: 20_000 }).catch(() => {});
    return;
  }
  if (value === undefined) return;
  if (field.kind === 'radio') {
    const picks = typeof value === 'string' ? [value] : Array.isArray(value) && field.key.endsWith('[]') ? value : [];
    if (!picks.length || !picks.every(pick => field.options?.includes(pick))) throw new AtsError('ANSWER_OPTION_INVALID', field.key, field.options);
    for (const pick of picks) await page.locator(`[name="${field.name}"][value="${pick.replace(/["\\]/g, '\\$&')}"]`).check();
  } else if (field.kind === 'select') {
    const options = await liveOptions(locator), pick = typeof value === 'string' ? matchOption(options, value, loose) : undefined;
    if (!pick) throw new AtsError('ANSWER_OPTION_INVALID', field.key, options.length <= 100 ? options : undefined);
    await locator.selectOption({ label: pick });
  } else if (typeof value !== 'string') {
    throw new AtsError('ANSWER_TYPE_MISMATCH', field.key);
  } else if (field.name === 'location') {
    let items = await suggestions(page, locator, value);
    const texts = (await items.allTextContents()).map(collapsed);
    const matches = texts.filter(text => text === value || text.startsWith(`${value}, `));
    const match = texts.includes(value) ? value : matches.length === 1 ? matches[0] : undefined;
    if (match === undefined) {
      // Offer the city's own suggestions so the applicant can pick Lever's spelling once.
      items = await suggestions(page, locator, value.split(',')[0]);
      const offered = [...new Set((await items.allTextContents()).map(collapsed).filter(Boolean))];
      await locator.fill('');
      throw new AtsError('ANSWER_OPTION_INVALID', field.key, offered.length ? offered : undefined);
    }
    await items.nth(texts.indexOf(match)).click();
  } else {
    await locator.fill(value);
  }
}

async function verifyLever(page: Page, field: AtsField, value: AtsValue | undefined) {
  const locator = named(page, field).first();
  if (field.kind === 'file') return locator.evaluate(node => node instanceof HTMLInputElement && Boolean(node.files?.length));
  if (field.kind === 'radio') {
    const checked = await page.locator(`[name="${field.name}"]:checked`).evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value));
    const picks = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    return checked.length === picks.length && picks.every(pick => checked.includes(pick));
  }
  if (field.kind === 'select') return locator.evaluate(node => (node as HTMLSelectElement).selectedOptions[0]?.label.trim())
    .then(label => typeof value === 'string' && !!label && matchOption([label], value) === label);
  if (typeof value !== 'string') return false;
  const actual = await locator.inputValue();
  // A picked suggestion fills Lever's hidden selectedLocation ({"name":"San Francisco, CA, USA","id":...}); typed text alone is rejected on submit.
  if (field.name === 'location') {
    return (actual === value || actual.startsWith(`${value}, `)) && (await page.locator('[name="selectedLocation"]').inputValue()).includes(JSON.stringify(actual));
  }
  return actual === value;
}

// hCaptcha nests its challenge frame inside an "enclave" frame (seen 2026-11-10), where a page-level selector cannot reach it.
export async function hcaptchaChallengeShown(page: Page) {
  for (const frame of page.frames()) {
    if (!/hcaptcha\.com\/.*frame=challenge/.test(frame.url())) continue;
    const element = await frame.frameElement().catch(() => null);
    if (element && await element.isVisible().catch(() => false)) return true;
  }
  return false;
}

export const lever: AtsAdapter = {
  id: 'lever',
  hosts: ['jobs.lever.co', 'jobs.eu.lever.co'],
  // Location search and resume parsing are served by jobs.lever.co itself. hCaptcha runs on submit, as in any browser;
  // blocking it leaves a submit unconfirmed. With its *.w.hcaptcha.com probes blocked, Lever refused even a solved
  // challenge ("There was an error verifying your application", Pivotal 2026-11-10), so they load as in any browser.
  origins: ['https://cdn.lever.co', 'https://js.hcaptcha.com', 'https://newassets.hcaptcha.com', 'https://api.hcaptcha.com',
    'https://imgs.hcaptcha.com', 'https://imgs3.hcaptcha.com', 'https://*.w.hcaptcha.com'],
  answer: leverAnswer,
  async observe(runtime, input, signal) {
    signal?.throwIfAborted();
    if (!at(input.applicationUrl, input, '') && !at(input.applicationUrl, input, '/apply')) throw new AtsError('ATS_IDENTITY_MISMATCH');
    const page = await runtime.navigate(await runtime.page(), `${posting(input.identity)}/apply`);
    // A closed posting redirects to the company's job list.
    if (!at(page.url(), input, '/apply')) throw new AtsError('ATS_IDENTITY_MISMATCH');
    const form = page.locator('form#application-form');
    if (!await form.count()) throw new AtsError('LEVER_FORM_NOT_FOUND');
    // Lever titles the page "<company> - <role>"; boards name the company their own way, so any company passes after the exact role.
    const title = collapsed(await page.title()), role = collapsed(input.role);
    if (!title.endsWith(` - ${role}`) || title.length === role.length + 3) throw new AtsError('ATS_IDENTITY_MISMATCH');
    return AtsObservationSchema.parse({ identity: input.identity, company: input.company, role: input.role, fields: await leverFields(form), actions: ['fill'] });
  },
  async fill(runtime, input, observation, signal) {
    signal?.throwIfAborted();
    const page = await runtime.page();
    // The resume goes first: Lever's resume parsing prefills fields it finds.
    await fillEach([...observation.fields].sort((a, b) => Number(b.kind === 'file') - Number(a.kind === 'file')), async field => {
      const value = leverAnswer(input, field);
      if (field.kind === 'file' ? field.required || input.documents[field.key] : value !== undefined || field.required) {
        // A long list the applicant never saw (the profile school on Palantir's) takes only the one option that is the answer.
        await fillLever(page, field, value, input.documents, !!field.options || input.answers[formQuestionKey(field)] !== undefined);
        if (!await verifyLever(page, field, value)) throw new AtsError('FIELD_RECONCILIATION_FAILED', field.key);
      }
    });
  },
  async submit(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = await runtime.page();
    const button = page.locator('#btn-submit');
    if (!await button.count()) throw new AtsError('SUBMIT_CONTROL_NOT_FOUND');
    await button.click();
    const thanks = (url: URL) => at(url.href, input, '/thanks');
    // hCaptcha shows its challenge only when it doubts the browser; otherwise the form posts and redirects to /thanks.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !at(page.url(), input, '/thanks') && !await hcaptchaChallengeShown(page)) await page.waitForTimeout(500);
    if (!at(page.url(), input, '/thanks') && await hcaptchaChallengeShown(page)) {
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), status: 'captcha-required', company: input.company, role: input.role }) + '\n');
      await page.waitForURL(thanks, { timeout: CAPTCHA_WAIT_MS }).catch(() => {});
    }
    if (!at(page.url(), input, '/thanks')) {
      // Neither outcome showed: log what the page does show (field errors, a dead button), as the Ashby adapter does.
      const shown = await page.locator('form#application-form [role="alert"], form#application-form .error-message, .application-error')
        .filter({ visible: true }).allInnerTexts().catch(() => []);
      // Kept on this machine only: what the page showed, for the next look at an unconfirmed submit.
      const screenshot = join(tmpdir(), `workie-lever-unconfirmed-${Date.now()}.png`);
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), status: 'submit-unconfirmed', company: input.company, role: input.role,
        url: page.url(), screenshot, shown: shown.map((text) => text.trim().slice(0, 300)).filter(Boolean).slice(0, 10),
        buttonEnabled: await button.isEnabled().catch(() => null) }) + '\n');
      throw new AtsError('SUBMISSION_CONFIRMATION_TIMEOUT');
    }
  },
  async receipt(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = await runtime.page();
    if (!at(page.url(), input, '/thanks')) throw new AtsError('RECEIPT_NOT_VERIFIED');
    // The thanks page also renders for a plain visit, so it only counts after this run's own submit reached it.
    const message = page.locator('[data-qa="msg-submit-success"]');
    const headline = page.locator('.posting-headline h2');
    if (!await message.count() || collapsed(await message.innerText()) !== 'Application submitted!' ||
        !await headline.count() || collapsed(await headline.innerText()) !== collapsed(input.role)) {
      throw new AtsError('RECEIPT_NOT_VERIFIED');
    }
    return { identity: input.identity, company: input.company, role: input.role,
      receiptId: `lv-${createHash('sha256').update(page.url()).digest('hex').slice(0, 32)}`, submittedAt: Date.now() };
  },
};
