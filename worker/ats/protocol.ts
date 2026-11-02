import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { BrowserRuntime } from '../browser.ts';
import { ApplicationIdentitySchema } from '../../lib/applications/worker-protocol.ts';

// Tenant and requisition take the server's rule: a narrower one rejected Workday, Oracle and iCIMS
// tenants (their hostname) and Lever EU's "jobs.eu.lever.co:<tenant>", and that ZodError stopped the worker.
export const AtsIdentitySchema = z.strictObject({
  ats: z.enum(['greenhouse', 'ashby', 'lever', 'jobvite', 'workday', 'oracle', 'icims']),
  tenant: ApplicationIdentitySchema.shape.tenant, requisition: ApplicationIdentitySchema.shape.requisition,
});
export type AtsIdentity = z.infer<typeof AtsIdentitySchema>;
// Greenhouse names a multi-select question's input "question_123[]"; the suffix is the only punctuation a key may carry.
// Its demographic survey numbers its questions ("75902").
export const atsFieldKey = /^(?:[a-z][a-z0-9_-]{0,63}(\[\])?|\d{1,20})$/;
export const AtsFieldSchema = z.strictObject({
  key: z.string().regex(atsFieldKey), label: z.string().trim().min(1).max(1000),
  // Text the form shows under a heading-only label (Ashby's checkbox sentence, Greenhouse's helper text). Shown in
  // the inbox, never part of the key or answer matching, so wording fixes do not orphan saved answers.
  description: z.string().trim().min(1).max(2000).optional(),
  kind: z.enum(['text', 'textarea', 'email', 'date', 'select', 'combobox', 'radio', 'checkbox', 'file']), required: z.boolean(),
  // Lever names inputs "cards[<uuid>][field0]"; Ashby uses bare UUIDs or the question's own wording.
  name: z.string().regex(/^[^"\\\r\n]{1,400}$/).optional(),
  options: z.array(z.string().trim().min(1).max(300)).max(100).optional(), // the inbox's own choice limits
});
export type AtsField = z.infer<typeof AtsFieldSchema>;
/** A form's own id when it already fits atsFieldKey, otherwise a stable key derived from it. */
// A bare number is hashed as it always was, so no Ashby or Lever question key (and its saved answer) changes.
export const fieldKeyFor = (raw: string) => atsFieldKey.test(raw) && !/^\d+$/.test(raw) ? raw :
  `f-${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
export const formQuestionKey = (field: Pick<AtsField, 'key' | 'label'>) =>
  `form-${createHash('sha256').update(`${field.key}\u0000${field.label}`).digest('hex').slice(0, 32)}`;
// Adapters list only actions Workie can perform. None implements 'inspect': offering it let the model
// park fully answered forms in needs_verification, with no inbox path out.
export const AtsObservationSchema = z.strictObject({
  identity: AtsIdentitySchema, company: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(300),
  fields: z.array(AtsFieldSchema).min(1).max(64), actions: z.array(z.enum(['fill', 'inspect'])).min(1).max(2),
});
export type AtsObservation = z.infer<typeof AtsObservationSchema>;
export const AtsReceiptSchema = z.strictObject({
  identity: AtsIdentitySchema, company: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(300),
  receiptId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), submittedAt: z.number().int().positive(),
});
export type AtsReceipt = z.infer<typeof AtsReceiptSchema>;
// A list answers a multi-select question (id ending in []), one option per entry.
export type AtsValue = string | boolean | string[];
export type AtsApplication = {
  identity: AtsIdentity; company: string; role: string; applicationUrl: string;
  answers: Record<string, AtsValue>; documents: Record<string, string>;
  manifestHash?: string; artifactHashes?: string[]; submissionIntentId?: string;
};

export class AtsError extends Error {
  readonly code: string;
  /** The choices the form offered when an answer was not one of them. */
  readonly options?: string[];
  constructor(code: string, message = code, options?: string[]) { super(message); this.code = code; this.options = options; }
}

/** Every field the form rejected an answer for, so the applicant answers them all at once. */
export class AtsAnswerErrors extends AtsError {
  readonly errors: AtsError[];
  constructor(errors: AtsError[]) { super(errors[0].code, errors[0].message, errors[0].options); this.errors = errors; }
}
export const answerError = (error: unknown): error is AtsError => error instanceof AtsError && /REQUIRED_ANSWER|ANSWER_/.test(error.code);
export async function fillEach<T>(fields: readonly T[], fill: (field: T) => Promise<void>) {
  const errors: AtsError[] = [];
  for (const field of fields) {
    try { await fill(field); } catch (error) { if (answerError(error)) errors.push(error); else throw error; }
  }
  if (errors.length) throw new AtsAnswerErrors(errors);
}

export type AtsAdapter = {
  readonly id: AtsIdentity['ats'];
  /** The vendor's hosted application hostnames; a ready form there opens visibly for the applicant's human check. */
  readonly hosts: readonly string[];
  /** Origins a hosted form needs besides its own (uploads, autocomplete, captcha). */
  readonly origins: readonly string[];
  /** The confirmed profile answer for a field, or undefined when the applicant must answer it. */
  answer(input: AtsApplication, field: AtsField): AtsValue | undefined;
  observe(runtime: BrowserRuntime, input: AtsApplication, signal?: AbortSignal): Promise<AtsObservation>;
  fill(runtime: BrowserRuntime, input: AtsApplication, observation: AtsObservation, signal?: AbortSignal): Promise<void>;
  /** `code` reads a security code the applicant entered on Workie, for an employer that emails one at submit. */
  submit(runtime: BrowserRuntime, input: AtsApplication, signal?: AbortSignal, code?: () => Promise<string | null>): Promise<void>;
  receipt(runtime: BrowserRuntime, input: AtsApplication, signal?: AbortSignal): Promise<AtsReceipt>;
};

/** A name as people write it: case, punctuation, a leading "The" and "&" for "and" do not matter. */
export const nameKey = (text: string) => text.toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^the /, '');

// Questions most employers ask in their own words, answered only from confirmed profile facts.
// Anything ambiguous (negations, combined questions, unrecognized wording) still goes to the inbox.
export function commonAnswer(input: AtsApplication, field: AtsField) {
  const text = field.label.toLowerCase().replace(/\s+/g, ' ').trim();
  // A list's instruction after its question ("select Other if your school is not listed") is not part of it;
  // a text question that asks for more than the school is a combined question and is asked.
  const question = field.kind === 'select' ? text.replace(/\?.*$/, '?') : text, school = input.answers['school--0'];
  if ((field.kind === 'text' || field.kind === 'select') && typeof school === 'string' &&
      /^((current|most recent) )?(school|university|college)( name)?$|^(what|which) (school|university|college) ((do|did) you (currently )?attend|are you (currently )?attending( or did you (last )?attend)?)\??$/.test(question)) {
    // A list takes only the option that is the profile school (a long one is checked against the live options on fill);
    // a near match is asked, never guessed.
    if (field.kind === 'text' || !field.options) return school;
    const matches = field.options.filter(option => nameKey(option) === nameKey(school));
    return matches.length === 1 ? matches[0] : undefined;
  }
  // A follow-up ("If yes, what type of sponsorship?") is not the yes/no question it follows.
  if (/\bnot\b|\bhear\b|^if (yes|so)\b/.test(text)) return undefined;
  if (field.kind === 'text') {
    if (/^linkedin\b|\blinkedin (profile|url|link)\b/.test(text)) return input.answers.linkedin;
    if (/^github\b|\bgithub (profile|url|link|username)\b/.test(text)) return input.answers.github;
    if (/^(personal |other )?(website|portfolio)( url| link)?( \(optional\))?$/.test(text)) return input.answers.portfolio;
  }
  const authorization = /\bauthori[sz]ed to work\b/.test(text), sponsorship = /\bsponsorship\b/.test(text);
  if (authorization === sponsorship) return undefined;
  // Uppercase US only: "work with us" is not a country.
  const us = /united states|\bh-?1b\b/.test(text) || /(^|[^A-Za-z])(U\.S\.A?\.?|USA|US)(?![A-Za-z])/.test(field.label);
  const postingCountry = /\bthe country\b/.test(text) && /\b(appl(y|ying|ied)|this (job|role|position))\b/.test(text);
  if (authorization) return us ? input.answers.us_authorized : postingCountry ? input.answers.posting_authorized : undefined;
  return input.answers[`${us ? 'us' : 'posting'}_sponsorship_${/\bfuture\b/.test(text) ? 'ever' : 'now'}`];
}

export async function locateField(page: Page, field: AtsField) {
  const byId = page.locator(`[id="${field.key}"]`).first();
  if (await byId.count()) return byId;
  const byLabel = page.getByLabel(field.label, { exact: false }).first();
  if (await byLabel.count()) return byLabel;
  if (field.name) {
    const byName = page.locator(`[name="${field.name}"]`).first();
    if (await byName.count()) return byName;
  }
  throw new AtsError('FIELD_NOT_FOUND', field.key);
}

// An undergraduate applicant's transcript fits "Transcript" or "Undergraduate Transcript", never "Graduate Transcript".
export const undergraduateTranscript = (label: string) =>
  /transcript/i.test(label) && !/\bgraduate\b/i.test(label.replace(/undergraduate/gi, ''));

export async function fillField(page: Page, field: AtsField, value: AtsValue | undefined, documents: Record<string, string>) {
  if (field.required && value === undefined && field.kind !== 'file') throw new AtsError('REQUIRED_ANSWER_MISSING', field.key);
  const locator = await locateField(page, field);
  if (field.kind === 'file') {
    const path = documents[field.key];
    if (!path) throw new AtsError('REQUIRED_DOCUMENT_MISSING', field.key);
    await locator.setInputFiles(path);
    return;
  }
  if (value === undefined) return;
  if (field.kind === 'checkbox') {
    if (typeof value !== 'boolean') throw new AtsError('ANSWER_TYPE_MISMATCH', field.key);
    if (value) await locator.check(); else await locator.uncheck();
  } else if (field.kind === 'combobox') {
    if (typeof value !== 'string' && !(Array.isArray(value) && value.length && field.key.endsWith('[]'))) throw new AtsError('ANSWER_TYPE_MISMATCH', field.key);
    for (const choice of typeof value === 'string' ? [value] : value) {
      await locator.click();
      await locator.fill(choice);
      const exact = page.getByRole('option', { name: choice, exact: true });
      try { await exact.first().click({ timeout: 3_000 }); }
      catch {
        // Clearing the search lists every choice of a fixed dropdown, so the applicant can pick an exact one.
        await locator.fill('');
        const options = [...new Set((await page.getByRole('option').allTextContents()).map(item => item.trim()).filter(Boolean))];
        await page.keyboard.press('Escape');
        throw new AtsError('ANSWER_OPTION_INVALID', field.key, options.length ? options : undefined);
      }
    }
  } else if (field.kind === 'select') {
    if (typeof value !== 'string' || !field.options?.includes(value)) throw new AtsError('ANSWER_OPTION_INVALID', field.key, field.options);
    await locator.selectOption({ label: value });
  } else if (field.kind === 'radio') {
    // A checkbox group (key ending in []) takes a list and checks exactly those boxes, each found inside the group:
    // another question may offer the same "No".
    const group = field.key.endsWith('[]'), picks = typeof value === 'string' ? [value] : group && Array.isArray(value) ? value : [];
    if (!picks.length || !picks.every(pick => field.options?.includes(pick))) throw new AtsError('ANSWER_OPTION_INVALID', field.key, field.options);
    for (const choice of group ? field.options! : picks) {
      const option = (group ? locator : page).getByLabel(choice, { exact: true }).first();
      if (!await option.count()) throw new AtsError('ANSWER_OPTION_NOT_FOUND', field.key);
      await option.setChecked(picks.includes(choice));
    }
  } else {
    if (typeof value !== 'string') throw new AtsError('ANSWER_TYPE_MISMATCH', field.key);
    await locator.fill(value);
  }
}

export async function verifyField(page: Page, field: AtsField, value: AtsValue | undefined, documents: Record<string, string> = {}) {
  if (field.kind === 'file') {
    // Hosted Greenhouse uploads the file on attach, then replaces the input with the uploaded file's name.
    const group = page.locator(`[aria-labelledby="upload-label-${field.key}"]`);
    const name = documents[field.key]?.split('/').pop();
    if (name && await group.count()) {
      const shown = group.locator('.file-upload__filename');
      await shown.first().waitFor({ timeout: 15_000 }).catch(() => {});
      return await shown.count() === 1 && (await shown.innerText()).trim() === name;
    }
    return await (await locateField(page, field)).evaluate((node) => node instanceof HTMLInputElement && Boolean(node.files?.length));
  }
  const locator = await locateField(page, field);
  if (field.kind === 'checkbox') return typeof value === 'boolean' && (await locator.isChecked()) === value;
  if (field.kind === 'radio') {
    const group = field.key.endsWith('[]'), picks = typeof value === 'string' ? [value] : group && Array.isArray(value) ? value : [];
    if (!picks.length || (group && !picks.every(pick => field.options?.includes(pick)))) return false;
    for (const choice of group ? field.options! : picks) {
      const option = (group ? locator : page).getByLabel(choice, { exact: true }).first();
      if (!await option.count() || await option.isChecked() !== picks.includes(choice)) return false;
    }
    return true;
  }
  if (field.kind === 'select') return typeof value === 'string' && (await locator.inputValue()) === value;
  if (field.kind === 'combobox' && Array.isArray(value)) {
    // react-select shows each pick of a multi-select as a chip.
    const shown = await locator.evaluate((node) => [...node.closest('.select__control')?.querySelectorAll('.select__multi-value__label') ?? []]
      .map(chip => chip.textContent?.trim() ?? ''));
    return shown.length === value.length && value.every(choice => shown.includes(choice));
  }
  if (field.kind === 'combobox') {
    if (typeof value !== 'string') return false;
    const shown = await locator.evaluate((node) => {
      const control = node.closest('.select__control');
      return { text: control?.textContent?.trim() ?? '', flag: /\biti__([a-z]{2})\b/.exec(control?.querySelector('.iti__flag')?.className ?? '')?.[1] };
    });
    // Greenhouse's phone-country picker shows "United States +1" as a US flag and "+1"; the flag tells +1 countries apart.
    return shown.text === value ||
      (shown.flag !== undefined && `${new Intl.DisplayNames(['en'], { type: 'region' }).of(shown.flag.toUpperCase())} ${shown.text}` === value);
  }
  if (typeof value !== 'string') return false;
  const actual = await locator.inputValue();
  // Greenhouse reformats phone numbers as they are typed: 4155550123 becomes (415) 555-0123.
  return actual === value || (/\bphone\b/i.test(field.label) && /\d/.test(value) && actual.replace(/\D/g, '') === value.replace(/\D/g, ''));
}

export async function observeReceipt(page: Page, expected: AtsApplication) {
  const receipt = page.locator('[data-receipt="application"]').first();
  if (!await receipt.count() || !await receipt.isVisible()) throw new AtsError('RECEIPT_NOT_VERIFIED');
  const actual = AtsReceiptSchema.safeParse({
    identity: {
      ats: await receipt.getAttribute('data-ats'), tenant: await receipt.getAttribute('data-tenant'),
      requisition: await receipt.getAttribute('data-requisition'),
    },
    company: await receipt.getAttribute('data-company'), role: await receipt.getAttribute('data-role'),
    receiptId: await receipt.getAttribute('data-receipt-id'), submittedAt: Number(await receipt.getAttribute('data-submitted-at')),
  });
  if (!actual.success || JSON.stringify(actual.data.identity) !== JSON.stringify(expected.identity) ||
      actual.data.company !== expected.company || actual.data.role !== expected.role) {
    throw new AtsError('RECEIPT_IDENTITY_MISMATCH');
  }
  return actual.data;
}
