import type { BrowserContext } from 'playwright';
import { STAGING_FIXTURE_TENANT } from '../../lib/applications/worker-protocol.ts';

// A Greenhouse-shaped application form served by the worker itself, never fetched from Greenhouse.
// The e2e test drives it, and a staging worker serves it for the one fixture tenant staging may submit to.
// Submitting it asks for an emailed code; the code that passes is ABCD1234.
const combobox = (id: string, label: string) => `<label id="${id}-label" for="${id}">${label}*</label>
  <div class="select__control"><div class="select__single-value"></div><input id="${id}" name="${id}" role="combobox" aria-required="true"></div>`;
const text = (id: string, label: string, required = true, tag = 'input') => `<label id="${id}-label" for="${id}">${label}${required ? '*' : ''}</label>
  <${tag} id="${id}" name="${id}" ${required ? 'aria-required="true"' : ''}>${tag === 'textarea' ? '</textarea>' : ''}`;
// A native <select> with a blank first option, as Greenhouse's older custom questions render; no profile fact answers it.
export const HEARD = ['LinkedIn', 'University career fair', 'Company website', 'Referral', 'Other'];
export const FIXTURE_FORM = `<!doctype html><title>Job Application for Software Engineering Intern at Fixture Co</title>
<form id="application-form">
  ${text('first_name', 'First Name')}${text('last_name', 'Last Name')}${text('email', 'Email')}${text('phone', 'Phone', false)}
  <label id="country-label" for="country">Country</label>
  <div class="select__control"><div class="select__single-value"></div><input id="country" name="country" role="combobox" aria-required="false"></div>
  <label id="resume-label" for="resume">Resume/CV*</label><input id="resume" name="resume" type="file">
  <label id="cover_letter-label" for="cover_letter">Cover Letter</label><input id="cover_letter" name="cover_letter" type="file">
  ${text('question_101', 'LinkedIn Profile')}
  ${combobox('question_102', 'Are you legally authorized to work in the country for which you are applying?')}
  ${combobox('question_103', 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa)?')}
  ${text('question_104', 'Why are you interested in Fixture Co?', true, 'textarea')}
  <label id="question_105-label" for="question_105">How did you hear about this job?*</label>
  <select id="question_105" name="question_105" aria-required="true"><option value=""></option>${
    HEARD.map(option => `<option>${option}</option>`).join('')}</select>
  <button type="button" id="submit">Submit application</button>
</form>
<script>
for (const input of document.querySelectorAll('input[role="combobox"]')) input.addEventListener('input', () => {
  document.querySelectorAll('[role="listbox"]').forEach(node => node.remove());
  const list = document.createElement('div'); list.setAttribute('role', 'listbox');
  // Like the live phone-country picker: "United States +1" is shown as a flag and "+1".
  const options = input.id === 'country' ? [['United States +1', 'us'], ['Canada +1', 'ca']] : [['Yes'], ['No']];
  for (const [option, flag] of options) {
    const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = option;
    item.onclick = () => {
      input.closest('.select__control').querySelector('.select__single-value').innerHTML = flag ? '<div class="iti__flag iti__' + flag + '"></div><span>+1</span>' : option;
      input.value = ''; list.remove();
    };
    list.append(item);
  }
  input.closest('.select__control').after(list);
});
// Like the live form, the phone is reformatted as it is typed.
document.getElementById('phone').addEventListener('input', event => {
  const d = event.target.value.replace(/[^0-9]/g, '');
  if (d.length === 10) event.target.value = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
});
document.getElementById('submit').onclick = async () => {
  // Like Greenhouse's human check: the first submit emails a code that the applicant must type in.
  // Eight one-character boxes, #security-input-0 to #security-input-7, like the live form.
  const boxes = [...document.querySelectorAll('input[id^="security-input-"]')];
  if (!boxes.length) {
    const prompt = document.createElement('p');
    prompt.textContent = 'A verification code was sent to test@example.com. To submit your application, enter the 8-character code to confirm you are a human.';
    document.body.append(prompt);
    for (let i = 0; i < 8; i++) { const input = document.createElement('input'); input.id = 'security-input-' + i; input.maxLength = 1; document.body.append(input); }
    return;
  }
  if (boxes.map(box => box.value).join('') !== 'ABCD1234') return;
  const base64 = async file => { let out = ''; for (const byte of new Uint8Array(await file.arrayBuffer())) out += String.fromCharCode(byte); return btoa(out); };
  const files = {}, fields = {};
  for (const input of document.querySelectorAll('input[type=file]')) if (input.files.length) files[input.id] = { name: input.files[0].name, base64: await base64(input.files[0]) };
  for (const input of document.querySelectorAll('#application-form input:not([type=file]), #application-form textarea, #application-form select')) {
    fields[input.id] = input.getAttribute('role') === 'combobox' ? input.closest('.select__control').textContent.trim() : input.value;
  }
  await fetch(location.pathname + '/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields, files }) });
  location.assign(location.pathname + '/confirmation');
};
</script>`;

export const fixtureConfirmation = (jobPath: string) => `<!doctype html><title>Thank you for applying</title><h1>Thank you for applying.</h1>
<p>Your application has been received.</p><a href="${jobPath}">Back to job post</a>`;

/** Answers every job-boards.greenhouse.io/workie-staging-fixture page locally, so nothing reaches Greenhouse. */
export async function serveStagingFixture(context: BrowserContext) {
  await context.route(`https://job-boards.greenhouse.io/${STAGING_FIXTURE_TENANT}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const job = /^(\/[^/]+\/jobs\/\d+)(\/confirmation|\/capture)?$/.exec(path);
    if (!job) return route.fulfill({ status: 404, body: '' });
    if (job[2] === '/capture') return route.fulfill({ status: 204 });
    return route.fulfill({ contentType: 'text/html', body: job[2] ? fixtureConfirmation(job[1]) : FIXTURE_FORM });
  });
}
