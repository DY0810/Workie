import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { disclosureAnswerKey } from '../../lib/applications/application-context-protocol.ts';
import { SUBMIT_WAIT_MS } from '../../lib/applications/worker-protocol.ts';
import { AtsError, AtsObservationSchema, fillEach, type AtsAdapter, type AtsApplication, type AtsField, atsFieldKey, commonAnswer, formQuestionKey, observeReceipt, fillField, verifyField } from './protocol.ts';

const VERIFICATION_WAIT_MS = SUBMIT_WAIT_MS; // time for the applicant to find the emailed code

const fields: AtsField[] = [
  { key: 'first_name', label: 'First name', kind: 'text', required: true },
  { key: 'last_name', label: 'Last name', kind: 'text', required: true },
  { key: 'email', label: 'Email', kind: 'email', required: true },
  { key: 'work_authorization', label: 'Work authorization', kind: 'select', required: true, options: ['Yes', 'No'] },
  { key: 'resume', label: 'Resume', kind: 'file', required: true },
];

async function pageFor(input: AtsApplication, runtime: Parameters<AtsAdapter['observe']>[0]) {
  const page = await runtime.page();
  return runtime.navigate(page, input.applicationUrl);
}

function hosted(input: AtsApplication, href = input.applicationUrl, suffix = '') {
  const url = new URL(href), { tenant, requisition } = input.identity;
  return url.origin === 'https://job-boards.greenhouse.io' && (url.pathname === `/${tenant}/jobs/${requisition}${suffix}` ||
    // The embed form of a board on the company's own site, named by its exact board and job.
    url.pathname === `/embed/job_app${suffix}` && url.searchParams.getAll('for').join() === tenant && url.searchParams.getAll('token').join() === requisition);
}

export function greenhouseAnswer(input: AtsApplication, field: AtsField) {
  // Every hosted form puts the same phone-country picker beside Phone. Before a typed answer: the picker takes only its
  // exact "United States +1", so "United States" typed in the inbox was asked again on every fill (Schonfeld, 2026-11-10).
  if (field.key === 'country' && field.label === 'Country' && input.answers.phone_country === 'US') return 'United States +1';
  if (input.answers[formQuestionKey(field)] !== undefined) return input.answers[formQuestionKey(field)];
  // Greenhouse's education dropdown names the degree; the profile stores a level (doctorates are ambiguous, so asked).
  if (field.key === 'degree--0' && field.label === 'Degree') {
    const degree = ({ high_school: 'High School', associate: "Associate's Degree", bachelor: "Bachelor's Degree", master: "Master's Degree" } as
      Record<string, string>)[String(input.answers['degree--0'])];
    if (degree) return degree;
  }
  // The dropdown lists single majors; for a joint major that includes Computer Science the applicant chose it
  // (September 26, 2026). ponytail: one rule for CS joint majors; a per-applicant preference if another is needed.
  if (field.key === 'discipline--0' && field.label === 'Discipline' && typeof input.answers['discipline--0'] === 'string' &&
      input.answers['discipline--0'].split('/').map(part => part.trim()).includes('Computer Science')) return 'Computer Science';
  if (input.answers[field.key] !== undefined) return input.answers[field.key];
  if (input.answers[disclosureAnswerKey(field.label)] !== undefined) return input.answers[disclosureAnswerKey(field.label)];
  // The "Candidate Demographic Survey" numbers its questions ("75902") and words them per employer. A voluntary fact answers
  // a question about its one topic, only when the form offers that exact option; anything else is asked.
  if (/^\d+$/.test(field.key)) {
    const text = field.label.toLowerCase();
    const about = ([['voluntary_gender', /\bgender\b/], ['voluntary_hispanic', /\b(hispanic|latin[aox])\b/], ['voluntary_veteran', /\bveteran\b/],
      ['voluntary_disability', /\bdisabilit(y|ies)\b/], [null, /\brac(e|ial)\b|\bethnic|transgender|orientation|pronoun|\bsex\b|\bnot\b/]] as const)
      .filter(([, pattern]) => pattern.test(text));
    const value = about.length === 1 && about[0][0] ? input.answers[about[0][0]] : undefined;
    return typeof value === 'string' && field.options?.includes(value) ? value : undefined;
  }
  if (field.key === 'candidate-location' && field.label === 'Location (City)') return input.answers.current_location;
  const month = (value: string) => new Date(`${value}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  if (field.key === 'end-month--0' && field.label === 'End date month' && typeof input.answers.expected_graduation_month === 'string') {
    return month(input.answers.expected_graduation_month);
  }
  if (field.key === 'start-month--0' && field.label === 'Start date month' && typeof input.answers.start_month === 'string') return month(input.answers.start_month);
  if (/^pronouns?$/i.test(field.label.trim())) return input.answers.voluntary_pronouns;
  if (input.identity.tenant === 'figma' && input.identity.requisition === '6143238004') {
    if (field.key === 'question_19438735004' && field.label === 'LinkedIn Profile') return input.answers.linkedin;
    if (field.key === 'question_19438736004' && field.label === 'Other Website') return input.answers.portfolio;
    if (field.key === 'question_19438730004' && field.label === 'If you are currently enrolled in university or a program, what is your expected graduation date?' &&
        input.answers.expected_graduation_month === '2028-12') return 'Fall 2028';
  }
  // Greenhouse's standard voluntary self-identification fields, answered only from confirmed profile facts.
  if (field.key === 'gender' && field.label === 'Gender') return input.answers.voluntary_gender;
  if (field.key === 'hispanic_ethnicity' && field.label === 'Are you Hispanic/Latino?') return input.answers.voluntary_hispanic;
  if (field.key === 'veteran_status' && field.label === 'Veteran Status') return input.answers.voluntary_veteran;
  if (field.key === 'disability_status' && field.label === 'Disability Status') return input.answers.voluntary_disability;
  return commonAnswer(input, field);
}

// document.title collapses runs of spaces, so HP IQ's "Productivity  (Summer 2027)" must be compared collapsed.
export const hostedTitle = (role: string, company: string) => `Job Application for ${role} at ${company}`.replace(/\s+/g, ' ').trim();

export async function hostedFields(form: import('playwright').Locator): Promise<AtsField[]> {
  const raw = await form.evaluate(element => [...element.querySelectorAll('input[id],textarea[id],select[id]')].filter(node => {
    const input = node as HTMLInputElement;
    return input.type !== 'hidden' && !input.disabled && !input.id.endsWith('-search');
  }).map(node => {
    const input = node as HTMLInputElement;
    // A checkbox group's boxes ("question_1[]_2": question, then option) sit in a fieldset "question_1[]" whose legend asks it.
    const group = input.type === 'checkbox' ? /^(question_\d+\[\])_\d+$/.exec(input.id)?.[1] : undefined;
    const fieldset = group ? document.getElementById(group) : null, key = group ?? input.id;
    const own = document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent;
    const label = group ? (fieldset?.querySelector('legend')?.textContent ?? group).replace(/\s+/g, ' ') :
      document.getElementById(`${input.id}-label`)?.textContent ?? document.getElementById(`upload-label-${input.id}`)?.textContent ??
      own ?? input.getAttribute('aria-label') ?? input.id;
    // Helper text under a question ("Commitment" with the real question below it) is part of what the applicant answers.
    const helper = (document.getElementById(`${key}-description`)?.textContent ?? '').replace(/\s+/g, ' ').trim();
    // A label can hold a whole statement to attest to (ParetoHealth, 1,308 characters, 2026-11-13): its question stays the label, the rest is described.
    const whole = label.trim().replace(/\*\s*$/, '').trim(), cut = whole.length > 1000 ? whole.slice(0, 1000).indexOf('?') + 1 || 1000 : whole.length;
    const description = `${whole.slice(cut).trim()} ${helper}`.trim().slice(0, 2000);
    return { key, label: whole.slice(0, cut), ...(description ? { description } : {}),
      kind: group ? 'radio' : input.type === 'file' ? 'file' : input.getAttribute('role') === 'combobox' ? 'combobox' :
        input.tagName === 'SELECT' ? 'select' : input.type === 'checkbox' ? 'checkbox' : input.type === 'radio' ? 'radio' :
          input.type === 'email' ? 'email' : input.type === 'textarea' ? 'textarea' : 'text',
      // A hosted upload marks "required" only with an asterisk in its upload label, never on the input.
      required: input.id === 'resume' || input.getAttribute('aria-required') === 'true' || input.required ||
        fieldset?.getAttribute('aria-required') === 'true' || Boolean(document.getElementById(`upload-label-${input.id}`)?.querySelector('.required')),
      options: group ? [own?.trim() ?? ''] : node instanceof HTMLSelectElement ? [...node.options].map(option => option.label).filter(Boolean) : undefined,
    };
  }));
  // A group's boxes are one multi-choice question, as Lever's are; the "[]" key makes its answer a list.
  const fields: typeof raw = [];
  for (const item of raw) {
    const group = item.kind === 'radio' && item.key.endsWith('[]') ? fields.find(field => field.key === item.key) : undefined;
    if (group) group.options!.push(...item.options!); else fields.push(item);
  }
  if (fields.some(item => !atsFieldKey.test(item.key) || item.options?.includes('')) || fields.length > 64) throw new AtsError('GREENHOUSE_FIELD_UNSUPPORTED');
  return fields.map(item => ({ ...item, kind: item.kind as AtsField['kind'] }));
}

// A react-select dropdown lists its options only while its menu is open; an autocomplete lists none until typed into.
async function menuOptions(page: import('playwright').Page, field: AtsField) {
  const input = page.locator(`[id="${field.key}"]`).first();
  // The form is server-rendered and React hydrates it after the load event (Riot, 2026-10-06); a click before then
  // opens nothing, so click again until the menu opens. An autocomplete opens an empty menu, so it stops too.
  for (let attempt = 0; attempt < 5; attempt++) {
    await input.click();
    if (await page.getByRole('option').first().waitFor({ timeout: 1_000 }).then(() => true, () => false) ||
        await input.getAttribute('aria-expanded') === 'true') break;
  }
  const options = [...new Set((await page.getByRole('option').allTextContents()).map(item => item.trim()).filter(Boolean))];
  await page.keyboard.press('Escape');
  // Greenhouse's school list loads 100 at a time, so a full page is not the whole list (USC was missing, 2026-11-08):
  // leave it unread and let the profile answer be checked against the live list on fill, as for a longer list.
  return options.length && options.length < 100 && options.every(option => option.length <= 300) ? options : undefined;
}

export const greenhouse: AtsAdapter = {
  id: 'greenhouse',
  hosts: ['job-boards.greenhouse.io'],
  origins: ['https://job-boards.cdn.greenhouse.io', 'https://s4-recruiting.cdn.greenhouse.io', 'https://my.greenhouse.io', 'https://boards.greenhouse.io',
    // The Location (City) autocomplete; without it the profile's location can never be selected.
    'https://api-geocode-earth-proxy.greenhouse.io',
    // Attached files upload on attach (a blocked upload removes the file input); Email is validated on blur.
    'https://grnhse-prod-jben-us-west-2.s3.us-west-2.amazonaws.com', 'https://email-address-validator.us.greenhouse.io',
    // Greenhouse runs reCAPTCHA Enterprise on submit, as in any browser; blocking it can leave a submit unconfirmed.
    'https://www.recaptcha.net', 'https://www.gstatic.com'],
  answer: greenhouseAnswer,
  async observe(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = await pageFor(input, runtime);
    const form = page.locator('form[data-ats="greenhouse"], form#application-form').first();
    if (!await form.count()) throw new AtsError('GREENHOUSE_FORM_NOT_FOUND');
    const live = hosted(input) && await form.getAttribute('id') === 'application-form';
    if (!live && await form.getAttribute('id') === 'application-form') throw new AtsError('ATS_IDENTITY_MISMATCH');
    if (live) await page.waitForLoadState('load', { timeout: 5_000 });
    // The page is Remix: React hydrates the form after load, and text typed before then is reset (xAI, 2026-10-26).
    // Hydration covers the form at once, so the first input stands for it (the phone widget's search box is never React's).
    if (live) await page.waitForFunction(() => { const input = document.querySelector('#application-form input');
      return !('__remixContext' in window) || !input || Object.keys(input).some(key => key.startsWith('__reactProps')); }, null, { timeout: 30_000 }).catch(() => {});
    // The loaded page must still be this job's own URL; that, not the title's company, pins tenant and requisition.
    if (live && !hosted(input, page.url())) throw new AtsError('ATS_IDENTITY_MISMATCH');
    // The title can lag the load event (seen in the visible submit window); a real mismatch still fails. Boards get renamed
    // (xAI's titles say "SpaceXAI", 2026-10-05), so any company passes after the exact role, unless it holds " at " (an ambiguous role split).
    if (live && !await page.waitForFunction(([title, prefix]) => document.title === title || document.title.startsWith(prefix) &&
      document.title.length > prefix.length && !document.title.slice(prefix.length).includes(' at '),
    [hostedTitle(input.role, input.company), `${hostedTitle(input.role, '')} `], { timeout: 10_000 }).then(() => true, () => false)) {
      throw new AtsError('ATS_IDENTITY_MISMATCH');
    }
    const identity = {
      ats: 'greenhouse' as const,
      tenant: await form.getAttribute('data-tenant') ?? input.identity.tenant,
      requisition: await form.getAttribute('data-requisition') ?? input.identity.requisition,
    };
    const company = await form.getAttribute('data-company') ?? input.company;
    const role = await form.getAttribute('data-role') ?? input.role;
    const observed = live ? await hostedFields(form) : fields;
    // Only a question that will go to the inbox needs its choices; it must be answered with one of them.
    // A survey question's choices are read first, since its profile answer must be one of them.
    for (const field of observed) {
      if (field.kind === 'combobox' && !field.options && (/^\d+$/.test(field.key) || field.required && greenhouseAnswer(input, field) === undefined)) {
        field.options = await menuOptions(page, field);
      }
    }
    const observation = AtsObservationSchema.parse({ identity, company, role, fields: observed, actions: ['fill'] });
    if (JSON.stringify(observation.identity) !== JSON.stringify(input.identity) || observation.company !== input.company || observation.role !== input.role) {
      throw new AtsError('ATS_IDENTITY_MISMATCH');
    }
    return observation;
  },
  async fill(runtime, input, observation, signal) {
    signal?.throwIfAborted();
    const page = await runtime.page();
    await fillEach(observation.fields, async field => {
      const value = greenhouseAnswer(input, field);
      if (field.key === 'resume' || (field.key === 'cover_letter' && input.documents.cover_letter) || value !== undefined || field.required) {
        await fillField(page, field, value, input.documents);
        if (!await verifyField(page, field, value, input.documents)) throw new AtsError('FIELD_RECONCILIATION_FAILED', field.key);
      }
    });
  },
  async submit(runtime, input, signal, code) {
    signal?.throwIfAborted();
    const page = await runtime.page();
    const button = page.getByRole('button', { name: 'Submit application', exact: true });
    if (!await button.count()) throw new AtsError('SUBMIT_CONTROL_NOT_FOUND');
    await button.click();
    if (hosted(input)) {
      const confirmation = (url: URL) => hosted(input, url.href, '/confirmation');
      const prompt = page.getByText('A verification code was sent to', { exact: false }).first();
      // A busy computer can take well over 15 s to send the form and show what came back.
      await Promise.race([page.waitForURL(confirmation, { timeout: 45_000 }), prompt.waitFor({ timeout: 45_000 })]).catch(() => {});
      if (confirmation(new URL(page.url()))) return;
      // Greenhouse's human check: the applicant enters the emailed code on Workie, which the worker types into its
      // eight one-character boxes and submits again, or types it into this visible window themselves.
      if (await prompt.isVisible()) {
        process.stdout.write(JSON.stringify({ at: new Date().toISOString(), status: 'verification-code-required', company: input.company, role: input.role }) + '\n');
        const deadline = Date.now() + VERIFICATION_WAIT_MS;
        while (Date.now() < deadline) {
          if (await page.waitForURL(confirmation, { timeout: 5_000 }).then(() => true, () => false)) return;
          // A real timer between looks: a tab or request that fails at once must never hold the event loop (heartbeats,
          // the watchdog, the code poll) for the whole wait, as MEMX's froze for 26 minutes on 2026-10-27.
          await delay(1_000, undefined, { signal }).catch(() => {});
          signal?.throwIfAborted();
          const value = await code?.().catch(() => null);
          if (!value || value.length !== await page.locator('input[id^="security-input-"]').count()) continue;
          // A code the form will not take waits for the applicant to enter another one; the submission is never lost over it.
          try {
            for (const [index, character] of [...value].entries()) await page.locator(`#security-input-${index}`).fill(character, { timeout: 5_000 });
            await button.click({ timeout: 5_000 });
          } catch { /* next check */ }
        }
        throw new AtsError('VERIFICATION_CODE_TIMEOUT');
      }
      throw new AtsError('SUBMISSION_CONFIRMATION_TIMEOUT');
    }
  },
  async receipt(runtime, input, signal) {
    signal?.throwIfAborted();
    const page = await runtime.page();
    if (!hosted(input)) return observeReceipt(page, input);
    const url = new URL(page.url());
    if (!hosted(input, url.href, '/confirmation')) throw new AtsError('RECEIPT_NOT_VERIFIED');
    const backlink = page.getByRole('link', { name: 'Back to job post', exact: true });
    const back = await backlink.count() ? new URL(await backlink.getAttribute('href') ?? '', url) : null;
    // The message is the employer's own (Lyft's never says "applying"; Inversion's heading names itself and Parallel's has
    // none, 2026-10-29), so Greenhouse's title and the link back to this job pin the receipt. An embed's link goes to the
    // job on the employer's site by gh_jid (seen on Databricks, Stripe and Lyft, 2026-10-26).
    const verified = await page.title() === 'Thank you for applying' && (url.pathname.startsWith('/embed/')
      ? back?.searchParams.get('gh_jid') === input.identity.requisition || Boolean(back && hosted(input, back.href))
      : back?.pathname === `/${input.identity.tenant}/jobs/${input.identity.requisition}`);
    if (!verified) throw new AtsError('RECEIPT_NOT_VERIFIED');
    return { identity: input.identity, company: input.company, role: input.role,
      receiptId: `gh-${createHash('sha256').update(url.href).digest('hex').slice(0, 32)}`, submittedAt: Date.now() };
  },
};
