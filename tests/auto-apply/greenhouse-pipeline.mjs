import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { chromium } from 'playwright';
import { createBrowserRuntime } from '../../worker/browser.ts';
import { createStageDispatch } from '../../worker/main.ts';
import { ProviderError } from '../../worker/providers.ts';
import { artifactManifestHash } from '../../lib/applications/artifact-protocol.ts';

// Drives the real worker stage dispatch (screening -> tailoring -> filling -> submit) against a
// Greenhouse-shaped hosted form, with a fake control plane and a deterministic writer model.
const browserReady = existsSync(chromium.executablePath());
const toolsReady = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const JOB = '/fixtureco/jobs/4000001';
const URL_BASE = 'https://job-boards.greenhouse.io';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ORIGINAL = 'Built REST APIs in TypeScript for a scheduling product used by students';
const TAILORED = 'Built TypeScript REST APIs with CI tests for a student scheduling app';
const NARRATIVE = 'Fixture Co builds tools students rely on, and I want to make them faster.';
const JD = 'Fixture Co is hiring a Software Engineering Intern to build TypeScript APIs, write CI tests and improve reliability. ' +
  'Questions? Email university-recruiting@fixtureco.com or see https://www.fixtureco.com/careers and https://www.eeoc.gov/poster.';

function masterDocx() {
  const paragraphs = ['Test Applicant', ORIGINAL, 'Reduced dashboard query time by 95 percent with indexed joins', 'Skills: TypeScript, PostgreSQL, React'];
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
      paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`),
  }));
}

const combobox = (id, label) => `<label id="${id}-label" for="${id}">${label}*</label>
  <div class="select__control"><div class="select__single-value"></div><input id="${id}" name="${id}" role="combobox" aria-required="true"></div>`;
const text = (id, label, required = true, tag = 'input') => `<label id="${id}-label" for="${id}">${label}${required ? '*' : ''}</label>
  <${tag} id="${id}" name="${id}" ${required ? 'aria-required="true"' : ''}>${tag === 'textarea' ? '</textarea>' : ''}`;
const FORM = `<!doctype html><title>Job Application for Software Engineering Intern at Fixture Co</title>
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
  for (const input of document.querySelectorAll('#application-form input:not([type=file]), #application-form textarea')) {
    fields[input.id] = input.getAttribute('role') === 'combobox' ? input.closest('.select__control').textContent.trim() : input.value;
  }
  await fetch(location.pathname + '/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields, files }) });
  location.assign(location.pathname + '/confirmation');
};
</script>`;
const CONFIRMATION = `<!doctype html><title>Thank you for applying</title><h1>Thank you for applying.</h1>
<p>Your application has been received.</p><a href="${JOB}">Back to job post</a>`;

test('Greenhouse pipeline tailors the resume, asks only the new question, writes a cover letter and stores the exact receipt',
  { skip: !browserReady || !toolsReady }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workie-pipeline-'));
    const applicationId = randomUUID(), runId = randomUUID(), master = masterDocx();
    const masterRef = { documentId: randomUUID(), version: 1, sha256: sha256(master), size: master.length, mime: DOCX, path: '/master' };
    const stored = new Map([[masterRef.documentId, master]]);
    const calls = { tailor: [], letter: [], intents: [], submission: null, receipt: null, captured: null };
    const context = {
      protocolVersion: 1, applicationId, runId, ownerId: 'owner', policyRevision: 1, profileRevision: 1,
      identity: { ats: 'greenhouse', tenant: 'fixtureco', requisition: '4000001' }, company: 'Fixture Co', role: 'Software Engineering Intern',
      coverLetterAllowed: true, applicationUrl: `${URL_BASE}${JOB}`,
      facts: {
        countries: { state: 'confirmed', values: ['US'] }, degreeLevels: { state: 'confirmed', values: ['bachelor'] },
        majors: { state: 'confirmed', values: ['computer science'] }, availableTerms: { state: 'confirmed', values: ['summer 2027'] },
        expectedGraduation: { state: 'confirmed', month: '2028-12' }, workAuthorization: { state: 'confirmed', values: ['authorized'] },
        pay: { state: 'unknown', currency: null, amount: null, period: null },
      },
      requirements: {
        sourceUrl: `${URL_BASE}${JOB}`, officialDescription: JD, excerpts: [JD], countries: ['US'], degreeLevels: [], majors: [],
        terms: [], authorizationRequired: true, paid: true, graduationWindow: null, payFloor: null,
      },
      // What the server derives from confirmed profile facts (see applicationAnswers).
      answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', linkedin: 'https://linkedin.com/in/test',
        phone: '4155550123', phone_country: 'US', us_authorized: 'Yes', posting_authorized: 'Yes', us_sponsorship_ever: 'No', posting_sponsorship_ever: 'No' },
      documents: { resumeMaster: masterRef, resume: masterRef }, tailoredArtifact: null, manifestHash: null, artifactHashes: [], createdAt: Date.now(),
    };
    let intent, receiptFails = false, codes = [];
    const kept = [];
    const control = {
      applicationContext: async () => structuredClone(context),
      downloadDocument: async (_application, documentId) => stored.get(documentId),
      artifactIntent: async (_application, body) => { intent = body; calls.intents.push(body); return { artifactId: randomUUID(), uploadPath: '/upload' }; },
      uploadArtifact: async (_application, _artifact, _path, _header, bytes, mime) => {
        // Mirrors the server: the verified artifact becomes the application's resume.
        const documentId = randomUUID(), hash = sha256(bytes), manifestHash = artifactManifestHash(intent.manifest);
        stored.set(documentId, Buffer.from(bytes));
        context.documents.resume = { documentId, version: 1, sha256: hash, size: bytes.length, mime, path: '/tailored' };
        context.tailoredArtifact = { documentId, version: 1, sourceDocumentId: masterRef.documentId, sourceVersion: 1,
          sourceHash: masterRef.sha256, verificationManifestHash: manifestHash, outputHash: hash };
        context.manifestHash = manifestHash; context.artifactHashes = [hash];
      },
      submissionIntent: async (_application, body) => { calls.submission = body; return { intentId: body.intentId, state: 'submitting', revision: 2, fence: 1 }; },
      receipt: async (_application, body) => {
        calls.receipt = body;
        if (receiptFails) throw new Error('NETWORK_UNAVAILABLE');
        return {};
      },
      live: async (_application, body) => { (calls.live ??= []).push(body); return { applicationId, stored: true }; },
      // Codes the applicant entered on Workie, each taken once.
      verificationCode: async () => ({ code: codes.shift() ?? null }),
      letter: async (_application, body) => {
        // Mirrors the server: the first stored letter is kept and comes back in the context.
        calls.storedLetter ??= { body, afterReceipt: calls.receipt !== null };
        const { protocolVersion: _, ...text } = calls.storedLetter.body;
        context.letter = text;
        return { applicationId, stored: true };
      },
    };
    const usage = { input_tokens: 1, output_tokens: 1 };
    let generate = async (input) => {
      if (input.task === 'tailor') {
        calls.tailor.push(input);
        const anchor = input.anchors.find(item => item.text === ORIGINAL);
        return { task: 'tailor', edits: [{ anchorId: anchor.id, replacement: TAILORED, evidenceIds: [input.evidence[0].id] }], confidence: 0.9, model: 'fixture', usage };
      }
      calls.letter.push(input);
      const cite = [input.evidence[0].id];
      return { task: 'cover_letter', introduction: `I am applying for the ${input.role} role at ${input.company}.`,
        body: [{ text: 'I built TypeScript REST APIs for a scheduling product used by students.', evidenceIds: cite },
          { text: 'I reduced dashboard query time by 95 percent with indexed joins.', evidenceIds: cite }],
        conclusion: 'Thank you for considering my application.', companyParagraph: `${input.company} builds tools that students rely on every day.`,
        confidence: 0.9, model: 'fixture', usage };
    };
    let submitPage, submitPageOpened = new Promise(resolve => { submitPage = resolve; });
    const visible = {};
    let loads = 0, failingLoad = 0; // a form load that fails, as a navigation timeout would
    const browser = async (options) => {
      visible[stageNow] = options.headless === false;
      const runtime = await createBrowserRuntime({ ...options, headless: true });
      if (stageNow === 'ready') submitPage(await runtime.page());
      await runtime.context.route(`${URL_BASE}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === JOB) return route.fulfill({ contentType: 'text/html', body: FORM });
        if (path === `${JOB}/confirmation`) return route.fulfill({ contentType: 'text/html', body: CONFIRMATION });
        if (path === `${JOB}/capture`) { calls.captured = JSON.parse(route.request().postData()); return route.fulfill({ status: 204 }); }
        return route.fulfill({ status: 404, body: '' });
      });
      // The fixture replaces the network, so skip the DNS-backed public-host check for this one origin.
      return { ...runtime, navigate: async (page, url) => {
        if (++loads === failingLoad) throw new Error('NAVIGATION_TIMEOUT');
        await page.goto(url, { waitUntil: 'domcontentloaded' }); return page;
      } };
    };
    const signal = new AbortController().signal;
    const dispatch = createStageDispatch(control, directory, signal, browser);
    let stageNow, advanced = [];
    const stage = (state) => { stageNow = state; return dispatch({ applicationId, runId, fence: 1, revision: 1, state, checkpoint: null },
      { check() {} }, { signal, generate, advance: value => advanced.push(value), keepReceipt: async value => { kept.push(value); } }); };
    try {
      assert.deepEqual(await stage('screening'), { state: 'tailoring', reasonCode: 'screened' });
      // No master resume on the profile is a hold the applicant can clear and continue, not a provider failure.
      const master = context.documents.resumeMaster;
      delete context.documents.resumeMaster;
      assert.deepEqual(await stage('tailoring'), { state: 'needs_document', reasonCode: 'resume_required' });
      context.documents.resumeMaster = master;
      // A resume that cannot be edited safely (here the edit overflows its anchor) is applied with unchanged, not held.
      const realGenerate = generate;
      generate = async (input) => input.task === 'tailor'
        ? { ...(await realGenerate(input)), edits: [{ anchorId: input.anchors[0].id, replacement: 'x'.repeat(5000).slice(0, 2000), evidenceIds: [input.evidence[0].id] }] }
        : realGenerate(input);
      assert.deepEqual(await stage('tailoring'), { state: 'filling', reasonCode: 'master_resume_used', evidence: { artifactVerified: true } });
      assert.equal(context.documents.resume.sha256, master.sha256, 'the untailored master is the attached resume');
      assert.deepEqual(intent.manifest.request, { untailored: true, reason: 'EDIT_OVERFLOW' });
      // The provider drops rewrites that ran to their line's limit; when none is left, the master is used too, not a provider outage.
      Object.assign(context, { tailoredArtifact: null, manifestHash: null, artifactHashes: [] }); context.documents.resume = master;
      generate = async (input) => {
        if (input.task === 'tailor') throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'edit_overflow');
        return realGenerate(input);
      };
      assert.deepEqual(await stage('tailoring'), { state: 'filling', reasonCode: 'master_resume_used', evidence: { artifactVerified: true } });
      assert.equal(context.documents.resume.sha256, master.sha256, 'the untailored master is the attached resume');
      generate = realGenerate; calls.tailor.length = 0; calls.intents.length = 0;
      Object.assign(context, { tailoredArtifact: null, manifestHash: null, artifactHashes: [] }); context.documents.resume = master;

      assert.deepEqual(await stage('tailoring'), { state: 'filling', reasonCode: 'artifact_verified', evidence: { artifactVerified: true } });
      assert.equal(calls.tailor[0].jobSummary, JD, 'tailoring is driven by this posting');
      const tailored = strFromU8(unzipSync(stored.get(context.documents.resume.documentId))['word/document.xml']);
      assert.ok(tailored.includes(TAILORED) && !tailored.includes(ORIGINAL));

      // Only the role-specific narrative is new; profile facts answer LinkedIn, authorization and sponsorship.
      const asked = await stage('filling');
      assert.equal(asked.kind, 'questions');
      assert.deepEqual(asked.questions.map(item => item.originalWording), ['Why are you interested in Fixture Co?']);
      // The form waiting on the applicant's answers keeps its last picture, so Live shows what they are answering.
      assert.ok(calls.live.at(-1).image?.length > 1000, 'the form waiting on answers keeps its picture');
      assert.equal(calls.live.at(-1).step, 'Waiting for your answers');
      context.answers[asked.questions[0].key] = NARRATIVE; // the inbox answer, as the server returns it

      // A profile edit since screening that re-screening cannot settle is asked, not parked with nothing to answer.
      const authorization = context.facts.workAuthorization;
      context.facts.workAuthorization = { state: 'unknown', values: [] };
      const rescreened = await stage('filling');
      assert.equal(rescreened.kind, 'questions');
      assert.deepEqual(rescreened.questions.map(item => item.key), ['screening-authorization']);
      context.facts.workAuthorization = authorization;
      // A rejected answer whose form then fails to load again is retried, never left waiting on no question.
      // Loads: the form read, the fill's own read, then the read that would have found the rejected field.
      context.answers.posting_authorized = 'Maybe'; failingLoad = loads + 3;
      assert.deepEqual(await stage('filling'), { state: 'retryable_failure', reasonCode: 'ats_answer_option_invalid_question_102' });
      context.answers.posting_authorized = 'Yes'; calls.letter.length = 0;

      // A filled form waits for the applicant's approval; the server moves it to ready only after Approve and submit.
      assert.deepEqual(await stage('filling'), { state: 'needs_policy_decision', reasonCode: 'submit_approval' });
      assert.equal(calls.storedLetter.afterReceipt, false, 'the letter is kept for review before anything is submitted');
      // The applicant watched it fill and can review what was entered before approving.
      assert.ok(calls.live.some(frame => frame.step === 'Filling the form' && frame.image?.length > 1000), 'a screenshot of the form while filling');
      const review = calls.live.findLast(frame => frame.fields)?.fields ?? [];
      assert.deepEqual(review.find(field => field.label === 'Why are you interested in Fixture Co?')?.value, NARRATIVE);
      assert.ok(review.some(field => field.label === 'First Name' && field.value === 'Test'));
      assert.equal(calls.live.at(-1).step, 'Filled. Waiting for your approval');
      assert.ok(calls.live.findLast(frame => frame.image !== undefined)?.image, 'the filled form stays for review');
      const printed = [], write = process.stdout.write;
      process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return write.call(process.stdout, chunk, ...rest); };
      // The applicant enters the emailed code on Workie, mistyped first; the worker types each into the form and submits again.
      codes = ['ABCD9999', 'ABCD1234'];
      const submitted = stage('ready').finally(() => { process.stdout.write = write; });
      assert.deepEqual(await submitted, { state: 'submitted', reasonCode: 'exact_role_receipt', durable: true });
      assert.deepEqual(codes, [], 'the worker took both codes');
      assert.deepEqual(kept, [], 'a receipt the server took is not kept');
      assert.ok(printed.some(line => line.includes('"verification-code-required"') && !Number.isNaN(Date.parse(JSON.parse(line).at))),
        'the worker says, with the time, that a code is needed');
      assert.deepEqual(visible, { filling: false, ready: true }, 'filling runs hidden; only the submit shows a window');
      assert.deepEqual(advanced, [{ revision: 2, fence: 1, state: 'submitting' }], 'heartbeats move to the revision the intent created');

      assert.equal(calls.receipt.intentId, applicationId);
      assert.deepEqual(calls.receipt.identity, context.identity);
      assert.equal(calls.receipt.evidence.pageUrl, `${URL_BASE}${JOB}/confirmation`);
      const { fields, files } = calls.captured;
      assert.deepEqual(fields, { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', phone: '(415) 555-0123', country: '+1',
        question_101: 'https://linkedin.com/in/test', question_102: 'Yes', question_103: 'No', question_104: NARRATIVE });
      assert.equal(sha256(Buffer.from(files.resume.base64, 'base64')), context.tailoredArtifact.outputHash, 'the tailored resume is the one submitted');
      assert.match(files.resume.name, /^TestApplicant_Resume\.(docx|pdf)$/, 'the employer receives the resume under the applicant\'s name');
      assert.equal(calls.letter.at(-1).jobSummary, JD);
      const letterPath = join(directory, 'letter.pdf');
      await writeFile(letterPath, Buffer.from(files.cover_letter.base64, 'base64'));
      const letter = spawnSync('pdftotext', [letterPath, '-'], { encoding: 'utf8' }).stdout;
      assert.match(letter, /Software Engineering Intern role at Fixture Co/);
      assert.match(letter, /Sincerely,\s+Test Applicant/);

      // The letter reviewed before approval is the one that went out; it is written once.
      assert.equal(calls.letter.length, 1);
      assert.deepEqual(calls.storedLetter, { afterReceipt: false, body: { protocolVersion: 1,
        introduction: 'I am applying for the Software Engineering Intern role at Fixture Co.',
        body: ['I built TypeScript REST APIs for a scheduling product used by students.', 'I reduced dashboard query time by 95 percent with indexed joins.'],
        conclusion: 'Thank you for considering my application.', companyParagraph: 'Fixture Co builds tools that students rely on every day.' } });

      // The employer confirms the next one, but Workie's server does not take the receipt: it is kept for the next reconcile lease.
      receiptFails = true; submitPageOpened = new Promise(resolve => { submitPage = resolve; });
      const unconfirmed = stage('ready');
      const again = await submitPageOpened;
      await again.getByText('A verification code was sent to', { exact: false }).waitFor();
      // With no code on Workie, the applicant can still type it into the visible window.
      for (const [index, character] of [...'ABCD1234'].entries()) await again.locator(`#security-input-${index}`).fill(character);
      await again.getByRole('button', { name: 'Submit application', exact: true }).click();
      assert.deepEqual(await unconfirmed, { state: 'submission_unknown', reasonCode: 'receipt_persistence_failed', durable: true });
      assert.deepEqual(kept, [calls.receipt]);

    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
