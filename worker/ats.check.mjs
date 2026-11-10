import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserEgressError, createBrowserRuntime, openApplicationTab } from './browser.ts';
import { greenhouse, greenhouseAnswer, hostedFields, hostedTitle } from './ats/greenhouse.ts';
import { hcaptchaChallengeShown, lever, matchOption } from './ats/lever.ts';
import { fieldKeyFor, fillField, formQuestionKey as leverQuestionKey, locateField, undergraduateTranscript, verifyField } from './ats/protocol.ts';
import { fillAtsApplication, runAtsApplication } from './application-runner.ts';
import { AtsIdentitySchema, AtsObservationSchema } from './ats/protocol.ts';
import { resolveApplicationIdentity } from '../lib/applications/application-identity.ts';
import { formQuestions } from './screening.ts';

const browserReady = existsSync(chromium.executablePath());
test('hosted fields resolve their exact ID when visible labels collide', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<label for="other">Attach</label><input id="other"><label for="resume">Attach</label><input id="resume" type="file">');
    assert.equal(await (await locateField(page, { key: 'resume', label: 'Attach', kind: 'file', required: true })).getAttribute('id'), 'resume');
  } finally { await browser.close(); }
});
test('a hosted upload marked required only by its label asterisk is required', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Verkada's live markup: the input carries no required attribute; only the upload label's asterisk says so.
    await page.setContent('<form id="application-form">' +
      '<div id="upload-label-question_1">Undergraduate Transcript<span class="required">*</span></div><input id="question_1" type="file">' +
      '<div id="upload-label-question_2">Graduate Transcript</div><input id="question_2" type="file"></form>');
    const fields = await hostedFields(page.locator('form'));
    assert.deepEqual(fields.map(field => [field.key, field.label, field.required]),
      [['question_1', 'Undergraduate Transcript', true], ['question_2', 'Graduate Transcript', false]]);
  } finally { await browser.close(); }
});
test('the applicant transcript fits an undergraduate or plain transcript upload, never a graduate one', () => {
  for (const label of ['Undergraduate Transcript', 'Transcript', 'Unofficial Transcript']) assert.equal(undergraduateTranscript(label), true, label);
  for (const label of ['Graduate Transcript', 'Resume/CV', 'Cover Letter']) assert.equal(undergraduateTranscript(label), false, label);
});
test('every identity the server derives parses on the worker, including hostname tenants', () => {
  for (const url of ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/Software-Intern_R12345',
    'https://abc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345',
    'https://careers-acme.icims.com/jobs/1234/job', 'https://jobs.eu.lever.co/acme/0b2c3d4e-1111-4222-8333-944455566677',
    'https://job-boards.greenhouse.io/figma/jobs/6143238004']) {
    const { identity } = resolveApplicationIdentity(url, []);
    assert.ok(identity, url);
    assert.deepEqual(AtsIdentitySchema.parse(identity), identity, url);
  }
});
test('a role title with a double space matches the page title the browser collapses', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const role = 'Software Engineering Intern, Product & Developer Productivity  (Summer 2027)';
    await page.setContent(`<title>Job Application for ${role.replace('&', '&amp;')} at HP IQ</title>`);
    assert.equal(await page.title(), hostedTitle(role, 'HP IQ'));
  } finally { await browser.close(); }
});
test('a renamed Greenhouse board passes on the exact role and job URL; a wrong role or job URL still fails', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const role = 'Spring 2027 Software Engineering Internship/Co-op', job = 'https://job-boards.greenhouse.io/xai/jobs/5252108007';
    // Seen live on 2026-10-05: xAI's board now titles its pages "at SpaceXAI".
    const observe = (title, redirect) => {
      context.route(redirect ?? job, route => route.fulfill({ contentType: 'text/html',
        body: `<title>${title}</title><form id="application-form"><label for="first_name">First name</label><input id="first_name"></form>` }), { times: 1 });
      return greenhouse.observe({ context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(redirect ?? url); return page; } },
        { identity: { ats: 'greenhouse', tenant: 'xai', requisition: '5252108007' }, company: 'xAI', role, applicationUrl: job });
    };
    const observation = await observe(`Job Application for ${role} at SpaceXAI`);
    assert.deepEqual([observation.company, observation.role, observation.fields.map(field => field.key)], ['xAI', role, ['first_name']]);
    await assert.rejects(observe(`Job Application for Other Internship at SpaceXAI`), /ATS_IDENTITY_MISMATCH/);
    await assert.rejects(observe(`Job Application for ${role} at Night at SpaceXAI`), /ATS_IDENTITY_MISMATCH/);
    await assert.rejects(observe(`Job Application for ${role} at SpaceXAI`, 'https://job-boards.greenhouse.io/xai/jobs/1'), /ATS_IDENTITY_MISMATCH/);
  } finally { await browser.close(); }
});
test('a Greenhouse embed form for a board on the company site is filled, submitted and receipted by its exact board and job', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-embed-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  const role = 'Software Engineering Intern', form = 'https://job-boards.greenhouse.io/embed/job_app?for=fixture&token=123';
  const confirmation = 'https://job-boards.greenhouse.io/embed/job_app/confirmation?for=fixture&token=123';
  // Databricks's live embed (2026-10-26): the hosted form's markup at /embed/job_app; submit lands on /embed/job_app/confirmation,
  // whose message is the employer's own (Lyft's) and whose "Back to job post" goes to the employer's site with gh_jid.
  const run = async ({ redirect = null, backlink = 'https://www.fixture.example/careers/job?gh_jid=123' } = {}) => {
    const context = await browser.newContext();
    await context.route(redirect ?? form, route => route.fulfill({ contentType: 'text/html', body: `<title>Job Application for ${role} at Fixture Co</title>
      <form method="get" action="/embed/job_app?for=fixture&amp;token=123" id="application-form" class="application--form">
      <label id="first_name-label" for="first_name">First Name*</label><input id="first_name" aria-required="true">
      <label id="last_name-label" for="last_name">Last Name*</label><input id="last_name" aria-required="true">
      <label id="email-label" for="email">Email*</label><input id="email" type="email" aria-required="true">
      <div id="upload-label-resume">Resume/CV<span class="required">*</span></div><input id="resume" type="file">
      <button type="button">Submit application</button></form>
      <script>document.querySelector('button').onclick = () => { location.href = '/embed/job_app/confirmation?for=fixture&token=123'; };</script>` }));
    await context.route(confirmation, route => route.fulfill({ contentType: 'text/html', body: `<title>Thank you for applying</title>
      <main><div class="confirmation"><h1>Thank you for your interest in Fixture Co!</h1>
      <a class="link" target="_top" href="${backlink}">Back to job post</a></div></main>` }));
    const runtime = { context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(redirect ?? url); return page; } };
    const application = { identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' }, company: 'Fixture Co', role, applicationUrl: form,
      answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com' }, documents: { resume },
      manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)], submissionIntentId: crypto.randomUUID() };
    const evidence = [];
    try {
      const result = await runAtsApplication({ runtime, adapter: greenhouse, application, facts, requirements, submission: {
        begin: async value => ({ intentId: value.intentId }), receipt: async value => { evidence.push(value.evidence); } } });
      return { result, evidence };
    } finally { await context.close(); }
  };
  try {
    const { result, evidence } = await run();
    assert.equal(result.state, 'submitted');
    assert.deepEqual(result.receipt.identity, { ats: 'greenhouse', tenant: 'fixture', requisition: '123' });
    assert.equal(evidence[0].pageUrl, confirmation);
    assert.match(evidence[0].observedText, /Thank you for your interest in Fixture Co!/);
    // A confirmation linking back to another job is not this job's receipt.
    assert.deepEqual((await run({ backlink: 'https://www.fixture.example/careers/job?gh_jid=999' })).result.reasons, ['receipt_not_verified']);
    // A form reached anywhere but this board's job (a closed job redirects to the board) is never filled.
    for (const redirect of ['https://job-boards.greenhouse.io/embed/job_app?for=fixture&token=999', 'https://job-boards.greenhouse.io/embed/job_app?for=other&token=123']) {
      await assert.rejects(run({ redirect }), /ATS_IDENTITY_MISMATCH/);
    }
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('a hosted Greenhouse confirmation with the employer\'s own message is this job\'s receipt; one linking to another job is not', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  // Live confirmations (2026-10-29), trimmed: Sigma keeps Greenhouse's stock message, Inversion writes its own heading,
  // Parallel has no heading and links back to the job on boards.greenhouse.io.
  const confirmations = [
    ['sigmacomputing', '8015269003', '<h1>Thank you for applying.</h1><p>Your application has been received. If there is a fit, someone will be getting back to you.</p>',
      'https://job-boards.greenhouse.io/sigmacomputing/jobs/8015269003'],
    ['inversionspace', '4745076005', '<h1 style="text-align: center;">Thank you for applying to Inversion!&nbsp;</h1><p><strong>Inversion</strong> is always looking for top talent, so we\'re thrilled to receive your application!</p>',
      'https://job-boards.greenhouse.io/inversionspace/jobs/4745076005'],
    ['parallel', '5259777007', '<div>Hello,</div><div>Thank you for your interest in Parallel Systems. We wanted to let you know we received your application.</div>',
      'https://boards.greenhouse.io/parallel/jobs/5259777007?gh_jid=5259777007'],
  ];
  const receipt = async (tenant, requisition, message, backlink) => {
    const context = await browser.newContext();
    try {
      const url = `https://job-boards.greenhouse.io/${tenant}/jobs/${requisition}/confirmation`;
      await context.route(url, route => route.fulfill({ contentType: 'text/html', body: `<title>Thank you for applying</title>
        <main class="main font-secondary"><div class="confirmation"><div class="confirmation__content"><div><div class="body"><span>${message}</span></div>
        <div class="confirmation__links"><a href="https://job-boards.greenhouse.io/${tenant}" target="_top" class="btn btn--pill">View more jobs</a>
        <a class="link" target="_top" href="${backlink}">Back to job post</a></div></div></div></div></main>` }));
      const page = await context.newPage();
      await page.goto(url);
      return await greenhouse.receipt({ page: async () => page }, { identity: { ats: 'greenhouse', tenant, requisition }, company: 'Fixture Co',
        role: 'Software Engineering Intern', applicationUrl: `https://job-boards.greenhouse.io/${tenant}/jobs/${requisition}`, answers: {}, documents: {} });
    } finally { await context.close(); }
  };
  try {
    for (const [tenant, requisition, message, backlink] of confirmations) {
      assert.deepEqual((await receipt(tenant, requisition, message, backlink)).identity, { ats: 'greenhouse', tenant, requisition }, tenant);
    }
    const [, , message] = confirmations[1];
    await assert.rejects(receipt('inversionspace', '4745076005', message, 'https://job-boards.greenhouse.io/inversionspace/jobs/999'), /RECEIPT_NOT_VERIFIED/);
  } finally { await browser.close(); }
});
test('a hosted Remix form is filled only after React hydrates it, so typed text is not reset', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const role = 'Spring 2027 Software Engineering Internship/Co-op', job = 'https://job-boards.greenhouse.io/xai/jobs/5252108007';
    // xAI's live form (2026-10-26) is a Remix page; text typed before React hydrated it was reset and failed the field check.
    await context.route(job, route => route.fulfill({ contentType: 'text/html', body: `<title>Job Application for ${role} at SpaceXAI</title>
      <form id="application-form"><label for="first_name">First Name*</label><input id="first_name" aria-required="true">
      <label for="email">Email*</label><input id="email" aria-required="true"></form><script>
      window.__remixContext = {};
      addEventListener('load', () => setTimeout(() => { for (const input of document.querySelectorAll('input')) { input.value = ''; input.__reactProps$x = {}; } }, 800));
    </script>` }));
    const runtime = { context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } };
    const input = { identity: { ats: 'greenhouse', tenant: 'xai', requisition: '5252108007' }, company: 'xAI', role, applicationUrl: job,
      answers: { first_name: 'Test', email: 'test@example.com' }, documents: {} };
    await greenhouse.fill(runtime, input, await greenhouse.observe(runtime, input));
    const page = context.pages()[0];
    await page.waitForTimeout(1_000);
    assert.deepEqual([await page.inputValue('#first_name'), await page.inputValue('#email')], ['Test', 'test@example.com']);
  } finally { await browser.close(); }
});
test('an unanswered required Greenhouse dropdown reaches the inbox as a choice of the options its menu lists', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const role = 'Software Engineering Intern', job = 'https://job-boards.greenhouse.io/riotgamesup/jobs/8222015';
    // Riot's live form (2026-10-05): every choice question, acknowledgements included, is a react-select whose
    // options exist only while its menu is open. The location box is an autocomplete with no menu until typed into.
    await context.route(job, route => route.fulfill({ contentType: 'text/html', body: `<title>Job Application for ${role} at Riot Games</title>
      <form id="application-form">
      <label id="question_1-label" for="question_1">Please select the year you anticipate graduating from your academic program.*</label>
      <div class="select__control"><input id="question_1" role="combobox" aria-required="true"></div>
      <label id="question_2[]-label" for="question_2[]">I acknowledge the Riot Games Candidate Privacy Notice.*</label>
      <div class="select__control"><input id="question_2[]" role="combobox" aria-required="true"></div>
      <label id="candidate-location-label" for="candidate-location">Location (City)*</label>
      <div class="select__control"><input id="candidate-location" role="combobox" aria-required="true"></div>
      <div id="menu"></div></form><script>
      const choices = { question_1: ['2028', '2027', 'Already Graduated'], 'question_2[]': ['Yes'], 'candidate-location': [] };
      const menu = document.getElementById('menu');
      for (const input of document.querySelectorAll('input')) {
        input.addEventListener('click', () => { menu.innerHTML = ''; for (const choice of choices[input.id]) {
          const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = choice; menu.append(item); } });
        input.addEventListener('keydown', event => { if (event.key === 'Escape') menu.innerHTML = ''; });
      }
    </script>` }));
    const observation = await greenhouse.observe({ context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } },
      { identity: { ats: 'greenhouse', tenant: 'riotgamesup', requisition: '8222015' }, company: 'Riot Games', role, applicationUrl: job, answers: {} });
    assert.deepEqual(observation.fields.map(field => [field.key, field.options]),
      [['question_1', ['2028', '2027', 'Already Graduated']], ['question_2[]', ['Yes']], ['candidate-location', undefined]]);
    const { questions } = formQuestions({ profileRevision: 1, company: 'Riot Games', role, applicationUrl: job, applicationId: crypto.randomUUID(),
      identity: observation.identity }, observation.fields);
    assert.deepEqual(questions.map(question => [question.field.type, question.field.options?.map(option => option.value)]),
      [['select', ['2028', '2027', 'Already Graduated']], ['multiselect', ['Yes']], ['text', undefined]]);
  } finally { await browser.close(); }
});
test('a Riot-like form hydrated after load asks its dropdowns as choices and its multi-select as several, then fills every pick', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const role = 'Software Engineering Intern - Summer 2027 (Remote)', job = 'https://job-boards.greenhouse.io/riotgamesup/jobs/8222015';
    // Riot's live form (2026-10-06) is server-rendered; React attaches the menus after the load event, so an early click opens nothing.
    await context.route(job, route => route.fulfill({ contentType: 'text/html', body: `<title>Job Application for ${role} at Riot Games</title>
      <form id="application-form">
      <label id="question_1-label" for="question_1">Please indicate your gender.*</label>
      <div class="select__control"><input id="question_1" role="combobox" aria-required="true" aria-expanded="false"></div>
      <label id="question_2[]-label" for="question_2[]">In which language(s) are you business fluent?*</label>
      <div class="select__control"><span id="chips"></span><input id="question_2[]" role="combobox" aria-required="true" aria-expanded="false"></div>
      <div id="menu"></div></form><script>
      const choices = { question_1: ['Male', 'Female', 'Decline to state'], 'question_2[]': ['English', 'French', 'Korean'] };
      const menu = document.getElementById('menu'), chips = document.getElementById('chips');
      addEventListener('load', () => setTimeout(() => { for (const input of document.querySelectorAll('input')) {
        const render = () => { menu.innerHTML = ''; input.setAttribute('aria-expanded', 'true');
          for (const choice of choices[input.id].filter(c => c.toLowerCase().includes(input.value.toLowerCase()))) {
            const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = choice;
            item.addEventListener('click', () => { const chip = document.createElement('div'); chip.className = 'select__multi-value__label';
              chip.textContent = choice; chips.append(chip); input.value = ''; menu.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); });
            menu.append(item); } };
        input.addEventListener('click', render); input.addEventListener('input', render);
        input.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); } });
      } }, 1_500));
    </script>` }));
    const runtime = { context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } };
    const observation = await greenhouse.observe(runtime,
      { identity: { ats: 'greenhouse', tenant: 'riotgamesup', requisition: '8222015' }, company: 'Riot Games', role, applicationUrl: job, answers: {} });
    const { questions } = formQuestions({ profileRevision: 1, company: 'Riot Games', role, applicationUrl: job, applicationId: crypto.randomUUID(),
      identity: observation.identity }, observation.fields);
    assert.deepEqual(questions.map(question => [question.field.type, question.field.options?.map(option => option.value), question.field.maxSelections]),
      [['select', ['Male', 'Female', 'Decline to state'], 1], ['multiselect', ['English', 'French', 'Korean'], 3]]);
    const page = context.pages()[0], languages = observation.fields[1];
    await fillField(page, languages, ['English', 'Korean'], {});
    assert.equal(await verifyField(page, languages, ['English', 'Korean']), true);
    assert.equal(await verifyField(page, languages, ['English']), false);
  } finally { await browser.close(); }
});
test('a dropdown answer the form does not offer fails with every choice the form does offer', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Like a react-select dropdown: typing filters the choices; an empty search lists them all.
    await page.setContent(`<div class="select__control"><input id="school" role="combobox"></div><div id="menu"></div><script>
      const choices = ['University of California, Los Angeles', 'Binghamton University', 'Other'];
      const input = document.getElementById('school'), menu = document.getElementById('menu');
      const render = () => { menu.innerHTML = ''; for (const choice of choices.filter(c => c.toLowerCase().includes(input.value.toLowerCase()))) {
        const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = choice; menu.append(item); } };
      input.addEventListener('input', render); input.addEventListener('click', render);
    </script>`);
    const field = { key: 'school', label: 'Which college or university do you currently attend?', kind: 'combobox', required: true };
    const error = await fillField(page, field, 'UCLA', {}).then(() => null, error => error);
    assert.equal(error?.code, 'ANSWER_OPTION_INVALID');
    assert.deepEqual(error.options, ['University of California, Los Angeles', 'Binghamton University', 'Other']);
  } finally { await browser.close(); }
});
test('a hosted multi-select question (id ending in []) is observed and filled like a single dropdown', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Riot's live markup (2026-10-05): react-select multi input id="question_69351151[]"; a pick becomes a chip and closes the menu.
    await page.setContent(`<form id="application-form"><label id="question_1[]-label" for="question_1[]">In which language(s) are you business fluent?*</label>
      <div class="select__control"><div id="chips"></div><input id="question_1[]" role="combobox" aria-required="true"></div><div id="menu"></div></form><script>
      const choices = ['English', 'French', 'Korean'];
      const input = document.getElementById('question_1[]'), menu = document.getElementById('menu'), chips = document.getElementById('chips');
      const render = () => { menu.innerHTML = ''; for (const choice of choices.filter(c => c.toLowerCase().includes(input.value.toLowerCase()))) {
        const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = choice;
        item.addEventListener('click', () => { const chip = document.createElement('div'); chip.textContent = choice; chips.append(chip); input.value = ''; menu.innerHTML = ''; });
        menu.append(item); } };
      input.addEventListener('input', render); input.addEventListener('click', render);
    </script>`);
    const fields = await hostedFields(page.locator('form'));
    assert.deepEqual(fields, [{ key: 'question_1[]', label: 'In which language(s) are you business fluent?', kind: 'combobox', required: true, options: undefined }]);
    const [field] = AtsObservationSchema.parse({ identity: { ats: 'greenhouse', tenant: 'riotgamesup', requisition: '8222015' },
      company: 'Riot Games', role: 'Intern', fields, actions: ['fill'] }).fields;
    await fillField(page, field, 'English', {});
    assert.equal(await verifyField(page, field, 'English'), true);
    assert.equal(await verifyField(page, field, 'French'), false);
  } finally { await browser.close(); }
});
// A react-select single dropdown: its options exist only while its menu is open, and a pick shows in the control.
const surveyScript = choices => `<div id="menu"></div><script>
  const choices = ${JSON.stringify(choices)}, menu = document.getElementById('menu');
  for (const input of document.querySelectorAll('input[role=combobox]')) {
    const render = () => { menu.innerHTML = ''; for (const choice of choices[input.id].filter(c => c.toLowerCase().includes(input.value.toLowerCase()))) {
      const item = document.createElement('div'); item.setAttribute('role', 'option'); item.textContent = choice;
      item.addEventListener('click', () => { input.previousElementSibling.textContent = choice; input.value = ''; menu.innerHTML = ''; });
      menu.append(item); } };
    input.addEventListener('click', render); input.addEventListener('input', render);
    input.addEventListener('keydown', event => { if (event.key === 'Escape') menu.innerHTML = ''; });
  }
</script>`;
const surveySelect = (id, label) => `<label id="${id}-label" for="${id}">${label}<span aria-hidden="true">*</span></label>
  <div class="select__control"><div class="select__single-value"></div><input id="${id}" type="text" aria-labelledby="${id}-label" aria-required="true" role="combobox" value=""></div>`;
test('a Greenhouse checkbox group is one multi-choice question, filled box by box inside its own group, beside a numbered survey dropdown', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const role = 'Software Engineering Intern', job = 'https://job-boards.greenhouse.io/datadog/jobs/8181440';
    // Datadog's live form (2026-10-26): one checkbox per option, "question_<question>[]_<option>", in a fieldset named for the
    // question; the demographic survey's dropdown has a bare number for its id. The second group (also offering "No") is not Datadog's.
    const box = (question, option, label) => `<div><div><input required="" type="checkbox" id="question_${question}[]_${option}" name="question_${question}[]"
      aria-describedby="question_${question}[]-description question_${question}[]-error" value="${option}"/></div><label for="question_${question}[]_${option}">${label}</label></div>`;
    await context.route(job, route => route.fulfill({ contentType: 'text/html', body: `<title>Job Application for ${role} at Datadog</title>
      <form id="application-form">
      <fieldset class="checkbox" id="question_69008302[]" aria-required="true"><legend class="label checkbox__description">Do you have any specific academic requirements for your internship?<!-- --> <span class="required">*</span></legend>
      ${box(69008302, 750299547, 'International internship')}${box(69008302, 750299548, 'Master&#x27;s thesis')}${box(69008302, 750299549, 'Specific internship focus')}
      ${box(69008302, 750299550, 'Other (please specify at the top of your CV)')}${box(69008302, 750299551, 'No')}</fieldset>
      <fieldset class="checkbox" id="question_2[]"><legend class="label checkbox__description">Have you interned at Datadog before?
        Select all that apply.</legend>${box(2, 1, 'Yes')}${box(2, 2, 'No')}</fieldset>
      ${surveySelect(1757, 'Voluntary Self-Identification of Gender:\t')}
      </form>${surveyScript({ 1757: ['Female', 'Male', 'Non-binary/third gender', 'Prefer to self describe as', "I don't wish to answer"] })}` }));
    const runtime = { context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } };
    const input = { identity: { ats: 'greenhouse', tenant: 'datadog', requisition: '8181440' }, company: 'Datadog', role, applicationUrl: job, answers: {} };
    const observation = await greenhouse.observe(runtime, input);
    const academic = ['International internship', "Master's thesis", 'Specific internship focus', 'Other (please specify at the top of your CV)', 'No'];
    assert.deepEqual(observation.fields.map(({ key, label, kind, required, options }) => [key, label, kind, required, options]), [
      ['question_69008302[]', 'Do you have any specific academic requirements for your internship?', 'radio', true, academic],
      ['question_2[]', 'Have you interned at Datadog before? Select all that apply.', 'radio', true, ['Yes', 'No']],
      ['1757', 'Voluntary Self-Identification of Gender:', 'combobox', true, ['Female', 'Male', 'Non-binary/third gender', 'Prefer to self describe as', "I don't wish to answer"]],
    ]);
    const { questions } = formQuestions({ profileRevision: 1, company: 'Datadog', role, applicationUrl: job, applicationId: crypto.randomUUID(),
      identity: observation.identity }, observation.fields);
    assert.deepEqual(questions.map(question => [question.field.type, question.field.maxSelections]), [['multiselect', 5], ['multiselect', 2], ['select', 1]]);
    const page = context.pages()[0], [requirements, before, gender] = observation.fields;
    await fillField(page, requirements, ['International internship', 'No'], {});
    assert.equal(await verifyField(page, requirements, ['International internship', 'No']), true);
    assert.equal(await verifyField(page, requirements, ['No']), false);
    assert.equal(await page.isChecked('[id="question_2[]_2"]'), false, 'the other group\'s "No" is untouched');
    assert.equal(await verifyField(page, before, ['No']), false);
    // Filling again checks exactly the new answer.
    await fillField(page, requirements, ['No'], {});
    assert.equal(await verifyField(page, requirements, ['No']), true);
    await assert.rejects(fillField(page, requirements, ['Maybe'], {}), error => error.code === 'ANSWER_OPTION_INVALID' && error.options.length === 5);
    await fillField(page, gender, 'Male', {});
    assert.equal(await verifyField(page, gender, 'Male'), true);
    assert.equal(await verifyField(page, gender, 'Female'), false);
  } finally { await browser.close(); }
});
test('a numbered demographic survey question takes a voluntary fact only when it is about that one topic and the form offers it', () => {
  const answers = { voluntary_gender: 'Male', voluntary_hispanic: 'No', voluntary_veteran: 'I am not a protected veteran',
    voluntary_disability: 'No, I do not have a disability and have not had one in the past' };
  const input = { identity: { ats: 'greenhouse', tenant: 'mongodb', requisition: '8209134' }, company: 'MongoDB', role: 'Intern', applicationUrl: 'https://example.test', answers };
  const answer = (label, options, key = '1653') => greenhouseAnswer(input, { key, label, kind: 'combobox', required: true, options });
  const decline = "I don't wish to answer";
  // Live wording and options (2026-10-26): Waymo, Datadog, MongoDB, Samsara, Roblox.
  assert.equal(answer('Please indicate your gender', ['Male', 'Female', 'Non-Binary', decline]), 'Male');
  assert.equal(answer('Voluntary Self-Identification of Gender:', ['Female', 'Male', 'Non-binary/third gender', decline]), 'Male');
  assert.equal(answer('Gender Identity', ['Woman', 'Man', 'Non Binary', 'I want to self describe', decline]), undefined);
  assert.equal(answer('Are you Hispanic/Latino?', ['Yes', 'No', decline]), 'No');
  assert.equal(answer('Race', ['Asian', 'Latinx or Hispanic', 'White', decline]), undefined);
  assert.equal(answer('Please indicate your race / ethnic group (choose all that apply)', ['Asian', 'Hispanic or Latino', decline]), undefined);
  assert.equal(answer('Veteran Status', ['I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran', decline]), 'I am not a protected veteran');
  assert.equal(answer('If you are based in the US, what is your veteran status?', ['I am a protected veteran', 'I am not a protected veteran', decline]), 'I am not a protected veteran');
  assert.equal(answer('Please indicate if you are a veteran or active member of the United States Armed Forces.',
    ['Yes, I am a veteran or active member', 'No, I am not a veteran or active member', decline]), undefined);
  assert.equal(answer('Disability Status', ['Yes, I have a disability, or have had one in the past', 'No, I do not have a disability and have not had one in the past', decline]),
    'No, I do not have a disability and have not had one in the past');
  assert.equal(answer('Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, other)?', ['Yes', 'No', decline]), undefined);
  assert.equal(answer('Do you identify as transgender?', ['Yes', 'No', 'Male']), undefined);
  assert.equal(answer('Gender', undefined), undefined, 'without the form\'s options nothing is picked');
  // Under ask_each_sensitive the profile sends no voluntary facts, so every survey question is asked.
  assert.equal(greenhouseAnswer({ ...input, answers: {} }, { key: '1653', label: 'Gender', kind: 'combobox', required: true, options: ['Male', 'Female'] }), undefined);
  // An inbox answer wins, keyed as every form question is.
  const field = { key: '1654', label: 'Gender Identity', kind: 'combobox', required: true, options: ['Woman', 'Man'] };
  assert.equal(greenhouseAnswer({ ...input, answers: { ...answers, [leverQuestionKey(field)]: 'Man' } }, field), 'Man');
  // The phone-country picker: the profile's country, even over an answer typed for it that the picker cannot match.
  const country = { key: 'country', label: 'Country', kind: 'combobox', required: true };
  assert.equal(greenhouseAnswer({ ...input, answers: { phone_country: 'US', [leverQuestionKey(country)]: 'United States' } }, country), 'United States +1');
  assert.equal(greenhouseAnswer({ ...input, answers: { [leverQuestionKey(country)]: 'Canada +1' } }, country), 'Canada +1');
  // Survey numbers and checkbox groups are valid keys; a single box's id is not. A bare-number Ashby or Lever id is still hashed.
  for (const key of ['75902', 'question_69008302[]']) AtsObservationSchema.parse({ identity: input.identity, company: 'MongoDB', role: 'Intern', fields: [{ key, label: 'Q', kind: 'radio', required: true }], actions: ['fill'] });
  assert.throws(() => AtsObservationSchema.parse({ identity: input.identity, company: 'MongoDB', role: 'Intern', fields: [{ key: 'question_1[]_2', label: 'Q', kind: 'radio', required: true }], actions: ['fill'] }));
  assert.match(fieldKeyFor('75902'), /^f-/);
  assert.match(fieldKeyFor('3f2a9c1e-1111-4222-8333-944455566677'), /^f-/);
  assert.equal(fieldKeyFor('question_1'), 'question_1');
});
test('a numbered survey dropdown reads its options first, fills a voluntary fact the form offers, and asks the rest', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const role = 'Software Engineering Intern', job = 'https://job-boards.greenhouse.io/waymo/jobs/8234553';
    // Waymo's live "Candidate Demographic Survey" (2026-10-26).
    const choices = { 75902: ['Male', 'Female', 'Non-Binary', "I don't wish to answer"],
      75903: ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Hispanic or Latino', "I don't wish to answer"],
      75904: ['Yes, I am a veteran or active member', 'No, I am not a veteran or active member', "I don't wish to answer"] };
    await context.route(job, route => route.fulfill({ contentType: 'text/html', body: `<title>Job Application for ${role} at Waymo</title>
      <form id="application-form"><div id="demographic-section"><h3>Candidate Demographic Survey</h3>
      ${surveySelect(75902, 'Please indicate your gender')}${surveySelect(75903, 'Please indicate your race / ethnic group (choose all that apply)')}
      ${surveySelect(75904, 'Please indicate if you are a veteran or active member of the United States Armed Forces.')}
      <input required="" tabindex="-1" aria-hidden="true" value=""/></div></form>${surveyScript(choices)}` }));
    const runtime = { context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } };
    const input = { identity: { ats: 'greenhouse', tenant: 'waymo', requisition: '8234553' }, company: 'Waymo', role, applicationUrl: job,
      answers: { voluntary_gender: 'Male', voluntary_veteran: 'I am not a protected veteran' } };
    const observation = await greenhouse.observe(runtime, input);
    assert.deepEqual(observation.fields.map(field => [field.key, field.options]), Object.entries(choices));
    assert.deepEqual(observation.fields.map(field => greenhouse.answer(input, field)), ['Male', undefined, undefined]);
    const missing = observation.fields.filter(field => field.required && greenhouse.answer(input, field) === undefined);
    const { questions } = formQuestions({ profileRevision: 1, company: 'Waymo', role, applicationUrl: job, applicationId: crypto.randomUUID(),
      identity: observation.identity }, missing);
    assert.deepEqual(questions.map(question => [question.originalWording, question.field.type, question.field.options.length]), [
      ['Please indicate your race / ethnic group (choose all that apply)', 'select', 5],
      ['Please indicate if you are a veteran or active member of the United States Armed Forces.', 'select', 3]]);
    const page = context.pages()[0];
    await fillField(page, observation.fields[0], 'Male', {});
    assert.equal(await verifyField(page, observation.fields[0], 'Male'), true);
  } finally { await browser.close(); }
});
test('a radio question fills and verifies the exact option the answer names', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<fieldset><legend>Are you authorized to work?</legend><label><input type="radio" name="authorized" value="Yes">Yes</label>' +
      '<label><input type="radio" name="authorized" value="No">No</label></fieldset>');
    const field = { key: 'authorized', label: 'Are you authorized to work?', kind: 'radio', required: true, name: 'authorized', options: ['Yes', 'No'] };
    await fillField(page, field, 'Yes', {});
    assert.equal(await verifyField(page, field, 'Yes'), true);
    assert.equal(await verifyField(page, field, 'No'), false);
    await assert.rejects(fillField(page, field, 'Maybe', {}), error => error.code === 'ANSWER_OPTION_INVALID');
  } finally { await browser.close(); }
});
test('an uploaded Greenhouse file verifies by the name shown in place of its input', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // The live form after a successful upload: no #resume input, only the uploaded file's name.
    await page.setContent('<div role="group" aria-labelledby="upload-label-resume"><div id="upload-label-resume">Resume/CV</div>' +
      '<div class="file-upload__filename"><p>resume.docx</p><button aria-label="Remove file"></button></div></div>');
    const field = { key: 'resume', label: 'Resume/CV', kind: 'file', required: true };
    assert.equal(await verifyField(page, field, undefined, { resume: '/tmp/application-x/resume.docx' }), true);
    assert.equal(await verifyField(page, field, undefined, { resume: '/tmp/application-x/other.docx' }), false);
  } finally { await browser.close(); }
});
const facts = {
  countries: { state: 'confirmed', values: ['US'] }, degreeLevels: { state: 'confirmed', values: ['bachelor'] },
  majors: { state: 'confirmed', values: ['computer science'] }, availableTerms: { state: 'confirmed', values: ['summer 2027'] },
  expectedGraduation: { state: 'confirmed', month: '2028-12' },
  workAuthorization: { state: 'confirmed', values: ['authorized'] },
  pay: { state: 'unknown', currency: null, amount: null, period: null },
};
const requirements = {
  sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/123', officialDescription: 'US work authorization required.', excerpts: ['US work authorization required.'],
  countries: ['US'], degreeLevels: ['bachelor'], majors: ['computer science'], terms: ['summer 2027'],
  graduationWindow: null,
  authorizationRequired: true, paid: true, payFloor: { currency: 'USD', amount: 20, period: 'hour' },
};

test('long official questions retain exact wording and fill without a model choosing the action', async () => {
  const label = 'Export controls: '.repeat(20);
  const observation = AtsObservationSchema.parse({
    identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' },
    company: 'Fixture Co', role: 'Software Engineering Intern',
    fields: [{ key: 'question_123', label, kind: 'combobox', required: true }], actions: ['fill', 'inspect'],
  });
  let selected = false;
  const result = await fillAtsApplication({ runtime: {}, adapter: {
    observe: async () => observation,
    fill: async () => { selected = true; },
  }, application: {}, facts, requirements });
  assert.equal(result.state, 'ready');
  assert.equal(selected, true);
  assert.equal(observation.fields[0].label, label.trim());
});

test('a confirmation reached after the worker stopped is still read and handed on to be kept', async () => {
  const controller = new AbortController(), handed = [];
  const page = { url: () => 'https://job-boards.greenhouse.io/fixture/jobs/123/confirmation',
    locator: () => ({ first: () => ({ count: async () => 0 }), innerText: async () => 'Thank you for applying.' }) };
  const receipt = { identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' }, company: 'Fixture Co',
    role: 'Software Engineering Intern', receiptId: 'gh-1', submittedAt: Date.now() };
  const result = await runAtsApplication({ runtime: { page: async () => page }, signal: controller.signal, facts, requirements,
    application: { ...application('https://job-boards.greenhouse.io', 'greenhouse'), manifestHash: 'a'.repeat(64),
      artifactHashes: ['b'.repeat(64)], submissionIntentId: crypto.randomUUID() },
    adapter: { observe: async () => ({ fields: [] }), fill: async () => {},
      // The worker stops (a lost heartbeat) while the applicant types the emailed code; then the employer confirms.
      submit: async () => { controller.abort(); },
      receipt: async (_runtime, _input, signal) => { signal?.throwIfAborted(); return receipt; } },
    submission: { begin: async (value) => ({ intentId: value.intentId }),
      receipt: async (value) => { handed.push(value.receipt); throw new Error('STOPPED'); } } });
  assert.deepEqual(handed, [receipt]);
  assert.deepEqual(result, { state: 'submission_unknown', reasons: ['receipt_persistence_failed'], receipt: null, reconciled: false });
});

test('the Greenhouse code wait sleeps on a real timer and stops with the worker, even when the tab and Workie fail at once', async () => {
  const controller = new AbortController();
  const url = 'https://job-boards.greenhouse.io/fixture/jobs/123';
  const page = { url: () => url,
    getByRole: () => ({ count: async () => 1, click: async () => {} }),
    getByText: () => ({ first: () => ({ waitFor: async () => {}, isVisible: async () => true }) }),
    // A closed or crashed tab answers at once instead of waiting out its timeout.
    waitForURL: async () => { throw new Error('Target page, context or browser has been closed'); },
    locator: () => ({ count: async () => 8, fill: async () => {} }) };
  const realNow = Date.now;
  let calls = 0;
  // Each look at the clock moves it on a minute, so a wait that never sleeps ends at once instead of hanging the test.
  Date.now = () => realNow() + 60_000 * calls++;
  setTimeout(() => controller.abort(new Error('STOPPED')), 50);
  try {
    await assert.rejects(greenhouse.submit({ page: async () => page }, { identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' },
      company: 'Fixture Co', role: 'Software Engineering Intern', applicationUrl: url, answers: {}, documents: {} },
    controller.signal, async () => { throw new Error('STOPPED'); }), /STOPPED/);
  } finally { Date.now = realNow; }
});

function pageMarkup(ats, wrongRole = false) {
  const role = wrongRole ? 'Other role' : 'Software Engineering Intern';
  const authorized = '<label>Work authorization<select><option value="Yes">Yes</option><option value="No">No</option></select></label>';
  return `<!doctype html><form data-ats="${ats}" data-tenant="fixture" data-requisition="123" data-company="Fixture Co" data-role="${role}">
    <label>First name<input name="firstName"></label><label>Last name<input name="lastName"></label><label>Email<input type="email" name="email"></label>
    ${authorized}<label>Resume<input type="file" name="resume"></label>
    <button type="button">Submit application</button>
    <script>document.querySelector('button').onclick=()=>{document.querySelector('form').insertAdjacentHTML('beforeend', '<div data-receipt="application" data-ats="${ats}" data-tenant="fixture" data-requisition="123" data-company="Fixture Co" data-role="${role}" data-receipt-id="receipt-123" data-submitted-at="1727000000000">Application received</div>')}</script>
  </form>`;
}

async function fixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pageMarkup('greenhouse', url.searchParams.get('wrong') === '1'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function application(origin, ats, query = '') {
  return {
    identity: { ats, tenant: 'fixture', requisition: '123' }, company: 'Fixture Co', role: 'Software Engineering Intern',
    applicationUrl: `${origin}/${ats}${query}`,
    answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', work_authorization: 'Yes' },
    documents: {},
  };
}

test('the Greenhouse fixture fills an uploaded document and verifies an exact-role receipt', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  try {
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'greenhouse'), approvedOrigins: [fixture.origin], allowLoopback: true });
    const input = application(fixture.origin, 'greenhouse');
    input.documents.resume = resume;
    try {
      const result = await runAtsApplication({ runtime, adapter: greenhouse, application: input, facts, requirements });
      assert.equal(result.state, 'submitted');
      assert.equal(result.receipt.identity.ats, 'greenhouse');
      assert.equal(result.receipt.identity.requisition, '123');
      assert.equal(result.receipt.role, input.role);
    } finally { await runtime.close(); }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('screening and receipt binding refuse ineligible or wrong-role applications', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-negative-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  try {
    const blockedRuntime = await createBrowserRuntime({ userDataDir: join(directory, 'blocked'), approvedOrigins: [fixture.origin], allowLoopback: true });
    const ineligible = await runAtsApplication({
      runtime: blockedRuntime,
      adapter: greenhouse, application: application(fixture.origin, 'greenhouse'), facts: { ...facts, countries: { state: 'confirmed', values: ['CA'] } }, requirements,
    });
    assert.equal(ineligible.state, 'skipped');
    await blockedRuntime.close();
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'wrong'), approvedOrigins: [fixture.origin], allowLoopback: true });
    const input = application(fixture.origin, 'greenhouse', '?wrong=1'); input.documents.resume = resume;
    try { await assert.rejects(runAtsApplication({ runtime, adapter: greenhouse, application: input, facts, requirements }), /ATS_IDENTITY_MISMATCH/); }
    finally { await runtime.close(); }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('submission uses one deterministic intent', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-submit-'));
  const resume = join(directory, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  try {
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'browser'), approvedOrigins: [fixture.origin], allowLoopback: true });
    const input = application(fixture.origin, 'greenhouse');
    input.documents.resume = resume;
    input.manifestHash = 'a'.repeat(64);
    input.artifactHashes = ['b'.repeat(64)];
    input.submissionIntentId = crypto.randomUUID();
    const calls = [];
    try {
      const result = await runAtsApplication({ runtime, adapter: greenhouse, application: input, facts, requirements,
        submission: {
          begin: async (value) => { calls.push({ kind: 'begin', value }); return { intentId: value.intentId }; },
          receipt: async (value) => { calls.push({ kind: 'receipt', value }); },
        },
      });
      assert.equal(result.state, 'submitted');
      assert.equal(calls[0].value.intentId, input.submissionIntentId);
      assert.equal(calls[1].value.intentId, input.submissionIntentId);
      assert.equal(calls[1].value.evidence.pageUrl, input.applicationUrl);
      assert.equal(calls[1].value.evidence.observedText, 'Application received');
    } finally { await runtime.close(); }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('persistent browser egress rejects unapproved origins before navigation', { skip: !browserReady }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-egress-'));
  try {
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'browser'), approvedOrigins: [fixture.origin], allowLoopback: true });
    try {
      const page = await runtime.page();
      await assert.rejects(runtime.navigate(page, 'https://example.com/'), (error) => error instanceof BrowserEgressError);
    } finally { await runtime.close(); }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// Ashby: the hosted form's own markup (observed on OpenAI, Ramp and Notion postings, 2026-10-12), served on loopback.
const { ashby, pickerDate } = await import('./ats/ashby.ts');
const { formQuestionKey } = await import('./ats/protocol.ts');
const ashbyPosting = '3813977e-5940-456d-bf5a-16efcdc3a6dc';
const ashbyEntry = (path, label, input, required = true) => `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title${required ? ' _required_f7cvd_91' : ''}" for="${path}">${label}</label>${input}</div>`;
const ashbyYesNo = (path) => `<div class="ashby-application-form-input-yesno"><button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="false">No</button><input type="checkbox" tabindex="-1" name="${path}"></div>`;
function ashbyMarkup(title) {
  const group = ['Product', 'Infra', 'AI'].map((option, index) => `<div class="ashby-application-form-input-checkbox-group-option"><input type="checkbox" id="g-${index}" name="${option}"><label for="g-${index}" class="ashby-application-form-input-checkbox-group-option-label">${option}</label></div>`).join('');
  return `<!doctype html><title>${title}</title><div class="ashby-application-form-container">
    ${ashbyEntry('_systemfield_name', 'Legal Name', '<input class="ashby-application-form-input-text" name="_systemfield_name" id="_systemfield_name">')}
    ${ashbyEntry('_systemfield_email', 'Email', '<input class="ashby-application-form-input-text" type="email" name="_systemfield_email" id="_systemfield_email">')}
    ${ashbyEntry('_systemfield_resume', 'Resume', '<div class="ashby-application-form-input-file"><input type="file" id="_systemfield_resume"><button>Upload File</button></div>')}
    ${ashbyEntry('09a328e0-8d57-4f88-86ab-688de1657b17', 'What are you most proud of?', '<textarea class="ashby-application-form-input-textarea" name="09a328e0-8d57-4f88-86ab-688de1657b17"></textarea>')}
    ${ashbyEntry('bed95633-1b6e-4cd0-9eaf-c5a9f75ac35d', 'Are you authorized to work lawfully in the United States?', ashbyYesNo('bed95633-1b6e-4cd0-9eaf-c5a9f75ac35d'))}
    ${ashbyEntry('d33e2a8f-3742-4e5e-b91c-b7607d3cdf63', 'Are you able to work from our office three days per week?', ashbyYesNo('d33e2a8f-3742-4e5e-b91c-b7607d3cdf63'))}
    <fieldset class="ashby-application-form-input-checkbox-group"><label class="ashby-application-form-question-title _required_f7cvd_91" for="5f7757f0-b2ee-41b2-b9d0-0212461ed5a2">What type of engineering role are you interested in?</label>${group}</fieldset>
    <button type="button" class="ashby-application-form-submit-button">Submit Application</button></div>
    <script>
      // Like Ashby, every answer saves to the server as it changes: typing half a second after the last key or at once on blur.
      const save = (path, value) => fetch('/api/non-user-graphql?op=ApiSetFormValue', { method: 'POST', body: JSON.stringify({ path, value }) });
      document.querySelectorAll('input.ashby-application-form-input-text, textarea').forEach(input => {
        let timer;
        const flush = () => { if (timer) { clearTimeout(timer); timer = undefined; save(input.name, input.value); } };
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 500); });
        input.addEventListener('blur', flush);
      });
      document.querySelectorAll('.ashby-application-form-input-yesno button').forEach(button => button.onclick = () => {
        for (const other of button.parentElement.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
        save(button.parentElement.querySelector('input').name, button.textContent);
      });
      const group = document.querySelector('fieldset.ashby-application-form-input-checkbox-group');
      group.addEventListener('change', () => save(group.querySelector('label').htmlFor, [...group.querySelectorAll('input:checked')].map(box => box.name)));
      // Like Harvey's live form (2026-10-26), attaching a resume autofills the form and clears what the resume does not hold.
      document.getElementById('_systemfield_resume').onchange = (event) => { event.target.insertAdjacentHTML('afterend',
        '<p class="ashby-application-form-input-file-item-name"><span>' + event.target.files[0].name + '</span></p>');
        save('_systemfield_resume', event.target.files[0].name);
        document.getElementById('_systemfield_email').value = ''; };
      // Like Ashby, Submit checks the answers the server holds, not the ones on screen.
      document.querySelector('.ashby-application-form-submit-button').onclick = async () => {
        const { missing, spam } = await fetch('/api/submit', { method: 'POST' }).then(response => response.json());
        // Rivian's form, 2026-10-27: Ashby's spam filter refuses the submit and leaves the form in place.
        if (spam) return document.querySelector('.ashby-application-form-container').insertAdjacentHTML('afterbegin',
          '<div class="ashby-application-form-failure-container" role="alert"><p>We couldn\\'t submit your application</p><p>Your application submission was flagged as possible spam. If you believe this was a mistake, please submit your application again.</p></div>');
        if (missing.length) return document.querySelector('.ashby-application-form-container').insertAdjacentHTML('afterbegin',
          '<div class="ashby-application-form-failure-container" role="alert">Your form needs corrections. Missing entry for required field: ' + missing.join(', ') + '</div>');
        document.querySelector('.ashby-application-form-container').outerHTML =
        '<div class="ashby-application-form-success-container" role="status"><h2>Success</h2><p>Your application was successfully submitted. We\\'ll contact you if there are next steps.</p></div>'; };
    </script>`;
}
const ashbyRequired = ['_systemfield_name', '_systemfield_email', '_systemfield_resume', '09a328e0-8d57-4f88-86ab-688de1657b17',
  'bed95633-1b6e-4cd0-9eaf-c5a9f75ac35d', 'd33e2a8f-3742-4e5e-b91c-b7607d3cdf63', '5f7757f0-b2ee-41b2-b9d0-0212461ed5a2'];
async function ashbyFixture(title = 'Product Designer @ Fixture Co') {
  const fixture = { saved: {} };
  const server = createServer(async (request, response) => {
    if (request.url.includes('op=ApiSetFormValue')) {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { path, value } = JSON.parse(body);
      // Like Rivian's form (2026-10-27), a save rewrites the whole form from what it read, so of two saves at once the later drops the other.
      const before = { ...fixture.saved };
      await new Promise((resolve) => setTimeout(resolve, 300));
      fixture.saved = { ...before, [path]: value };
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end('{}');
    }
    if (request.url === '/api/submit') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ missing: ashbyRequired.filter(path => !fixture.saved[path]?.length), spam: !!fixture.spam }));
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(ashbyMarkup(title));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const input = { identity: { ats: 'ashby', tenant: 'fixture', requisition: ashbyPosting }, company: 'Fixture Co', role: 'Product Designer',
    applicationUrl: `${origin}/fixture/${ashbyPosting}`, documents: {},
    answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', us_authorized: 'Yes' } };
  return Object.assign(fixture, { server, origin, input });
}

test('an Ashby date is filled and checked the way its picker shows it', () => {
  // Harvey's Graduation Date showed "December 2028" as 12/01/2028, and the check against the typed text failed the fill.
  assert.equal(pickerDate('December 2028'), '12/01/2028');
  assert.equal(pickerDate('Dec 15, 2028'), '12/15/2028');
  assert.equal(pickerDate('12/15/2028'), '12/15/2028');
  // A calendar day, not UTC midnight: the picker showed 2028-12-15 as 12/14/2028 west of UTC.
  assert.equal(pickerDate('2028-12-15'), '12/15/2028');
  assert.equal(pickerDate('not a date'), 'not a date');
});
test('the Ashby fixture is observed, answered from the profile and the inbox, filled, submitted and receipted', { skip: !browserReady }, async () => {
  const fixture = await ashbyFixture();
  const { server, origin, input } = fixture;
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-ashby-'));
  input.documents.resume = join(directory, 'resume.pdf');
  await writeFile(input.documents.resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'browser'), approvedOrigins: [origin], allowLoopback: true });
  try {
    const observed = await ashby.observe(runtime, input);
    assert.deepEqual(observed.fields.map(({ key, kind, required, options }) => ({ key, kind, required, options })), [
      { key: observed.fields[0].key, kind: 'text', required: true, options: undefined },
      { key: observed.fields[1].key, kind: 'email', required: true, options: undefined },
      { key: 'resume', kind: 'file', required: true, options: undefined },
      { key: observed.fields[3].key, kind: 'textarea', required: true, options: undefined },
      { key: observed.fields[4].key, kind: 'radio', required: true, options: ['Yes', 'No'] },
      { key: observed.fields[5].key, kind: 'radio', required: true, options: ['Yes', 'No'] },
      { key: observed.fields[6].key, kind: 'select', required: true, options: ['Product', 'Infra', 'AI'] },
    ]);
    assert.match(observed.fields[3].key, /^f-[0-9a-f]{24}$/); // a bare UUID cannot be a key
    assert.match(observed.fields[6].key, /^f-[0-9a-f]{24}\[\]$/);
    const [name, email, , proud, authorized, office, roles] = observed.fields;
    assert.equal(ashby.answer(input, name), 'Test Applicant');
    assert.equal(ashby.answer(input, email), 'test@example.com');
    assert.equal(ashby.answer(input, authorized), 'Yes');
    // Unrecognized questions go to the inbox; their answers come back under the question's own key.
    assert.deepEqual([proud, office, roles].map(field => ashby.answer(input, field)), [undefined, undefined, undefined]);
    input.answers[formQuestionKey(proud)] = 'A payments redesign.';
    input.answers[formQuestionKey(office)] = 'No';
    input.answers[formQuestionKey(roles)] = ['Product', 'AI'];
    const result = await runAtsApplication({ runtime, adapter: ashby, application: input, facts, requirements });
    assert.equal(result.state, 'submitted');
    assert.match(result.receipt.receiptId, /^ab-[0-9a-f]{32}$/);
    assert.equal(result.receipt.identity.requisition, ashbyPosting);
    // Every answer reached the server, none dropped by a save that overlapped another.
    assert.deepEqual(fixture.saved, { _systemfield_resume: 'resume.pdf', _systemfield_name: 'Test Applicant', _systemfield_email: 'test@example.com',
      '09a328e0-8d57-4f88-86ab-688de1657b17': 'A payments redesign.', 'bed95633-1b6e-4cd0-9eaf-c5a9f75ac35d': 'Yes',
      'd33e2a8f-3742-4e5e-b91c-b7607d3cdf63': 'No', '5f7757f0-b2ee-41b2-b9d0-0212461ed5a2': ['Product', 'AI'] });
  } finally {
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('an Ashby submit its spam filter refuses ends as refused, not as a timeout', { skip: !browserReady }, async () => {
  const fixture = await ashbyFixture();
  fixture.spam = true;
  const { server, origin, input } = fixture;
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-ashby-spam-'));
  input.documents.resume = join(directory, 'resume.pdf');
  await writeFile(input.documents.resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
  const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'browser'), approvedOrigins: [origin], allowLoopback: true });
  try {
    const [, , , proud, , office, roles] = (await ashby.observe(runtime, input)).fields;
    input.answers[formQuestionKey(proud)] = 'A payments redesign.';
    input.answers[formQuestionKey(office)] = 'No';
    input.answers[formQuestionKey(roles)] = ['Product', 'AI'];
    const started = Date.now();
    const result = await runAtsApplication({ runtime, adapter: ashby, application: input, facts, requirements });
    assert.deepEqual([result.state, result.reasons], ['submission_unknown', ['SUBMISSION_REFUSED_SPAM']]);
    assert.ok(Date.now() - started < 50_000, 'the refusal is read at once, not after the 60 s confirmation wait');
  } finally {
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('an Ashby form for another role is refused, and an unanswered required question stops the fill', { skip: !browserReady }, async () => {
  const wrong = await ashbyFixture('Other role @ Fixture Co');
  const directory = await mkdtemp(join(tmpdir(), 'workie-ats-ashby-negative-'));
  try {
    const runtime = await createBrowserRuntime({ userDataDir: join(directory, 'wrong'), approvedOrigins: [wrong.origin], allowLoopback: true });
    try { await assert.rejects(ashby.observe(runtime, wrong.input), /ATS_IDENTITY_MISMATCH/); }
    finally { await runtime.close(); }
    const right = await ashbyFixture();
    const runtime2 = await createBrowserRuntime({ userDataDir: join(directory, 'right'), approvedOrigins: [right.origin], allowLoopback: true });
    try {
      right.input.documents.resume = join(directory, 'resume.pdf');
      await writeFile(right.input.documents.resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
      const observed = await ashby.observe(runtime2, right.input);
      await assert.rejects(ashby.fill(runtime2, right.input, observed), (error) => error.code === 'REQUIRED_ANSWER_MISSING' && error.message === observed.fields[3].key);
    } finally {
      await runtime2.close();
      await new Promise((resolve) => right.server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => wrong.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// Lever's live markup (Palantir, Shield AI, Ro; 2026-10-12): standard inputs by name, custom questions as "cards[<uuid>][fieldN]"
// (a checkbox group shares one name), a location box that accepts only a picked suggestion, and a POST that redirects to /thanks.
const leverJob = 'https://jobs.lever.co/fixture/0b2c3d4e-1111-4222-8333-944455566677';
const leverRole = 'Software Engineer Intern';
const leverForm = (role) => `<title>Fixture Co - ${role}</title><form id="application-form" method="POST" enctype="multipart/form-data"><ul>
  <li class="application-question resume"><label><div class="application-label">Resume/CV <span class="required">✱</span></div><input type="file" name="resume" id="resume-upload-input"></label></li>
  <li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div><input type="text" name="name" required></label></li>
  <li class="application-question"><label><div class="application-label">Email<span class="required">✱</span></div><input type="email" name="email" required></label></li>
  <li class="application-question"><label><div class="application-label">Current location <span class="required">✱</span></div><input id="location-input" name="location" required>
    <input id="selected-location" type="hidden" name="selectedLocation"><div class="dropdown-results"></div></label></li>
  <li class="application-question"><label><div class="application-label">LinkedIn URL</div><input type="text" name="urls[LinkedIn]"></label></li>
  <li class="application-question custom-question"><div class="application-label"><div class="text">Language Skill(s) (Check all that apply)<span class="required">✱</span></div></div><ul>
    <li><label><input type="checkbox" name="cards[c1][field0]" value="English" required>English</label></li><li><label><input type="checkbox" name="cards[c1][field0]" value="Korean" required>Korean</label></li>
    <li><label><input type="checkbox" name="cards[c1][field0]" value="French" required>French</label></li></ul></li>
  <li class="application-question custom-question"><div class="application-label"><div class="text">Are you authorized to work in the United States?<span class="required">✱</span></div></div><ul>
    <li><label><input type="radio" name="cards[c1][field1]" value="Yes" required>Yes</label></li><li><label><input type="radio" name="cards[c1][field1]" value="No" required>No</label></li></ul></li>
  <li class="application-question custom-question"><div class="application-label"><div class="text">Why this team?<span class="required">✱</span></div></div><textarea name="cards[c1][field2]" required></textarea></li></ul>
  <div class="application-question"><label><div class="application-label">Gender</div><select name="eeo[gender]"><option value="">Select ...</option><option value="Male">Male</option><option value="Female">Female</option></select></label></div>
  <div class="application-question"><label><div class="application-label">Veteran status</div><select name="eeo[veteran]"><option value="">Select ...</option><option value="I am not a veteran">I am not a veteran</option></select></label></div>
  <input type="hidden" name="cards[c1][baseTemplate]" value="{}"><button type="button" id="btn-submit">Submit application</button></form><script>
  const input = document.getElementById('location-input'), results = document.querySelector('.dropdown-results');
  input.addEventListener('input', () => { results.replaceChildren(); for (const place of ['San Francisco, CA, USA', 'San Francisco, Córdoba, ARG'].filter(p => p.toLowerCase().startsWith(input.value.toLowerCase()))) {
    const item = document.createElement('div'); item.className = 'dropdown-location'; item.textContent = place;
    item.addEventListener('click', () => { input.value = place; document.getElementById('selected-location').value = JSON.stringify({ name: place }); results.replaceChildren(); });
    results.append(item); } });
  document.getElementById('btn-submit').onclick = () => document.querySelector('form').submit();
  </script>`;
async function leverFixture(browser, title = leverRole) {
  const context = await browser.newContext();
  const posted = [];
  await context.route(`${leverJob}/apply`, route => {
    if (route.request().method() !== 'POST') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: leverForm(title) });
    posted.push(route.request().postData() ?? '');
    // Lever answers with a redirect; a fulfilled redirect would leave the routed context, so the fixture navigates itself.
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<script>location.replace('${leverJob}/thanks')</script>` });
  });
  await context.route(`${leverJob}/thanks`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<title>Fixture Co - ${title}</title>
    <div class="posting-headline"><h2>${title}</h2></div><div class="confirmation-message"><h3 data-qa="msg-submit-success">Application submitted!</h3></div>` }));
  return { posted, runtime: { context, page: async () => context.pages()[0] ?? context.newPage(), navigate: async (page, url) => { await page.goto(url); return page; } } };
}
const leverApplication = (answers = {}) => ({ identity: { ats: 'lever', tenant: 'fixture', requisition: '0b2c3d4e-1111-4222-8333-944455566677' },
  company: 'Fixture Co', role: leverRole, applicationUrl: leverJob, documents: {},
  answers: { first_name: 'Test', last_name: 'Applicant', email: 'test@example.com', current_location: 'San Francisco, CA', us_authorized: 'Yes',
    voluntary_gender: 'Male', voluntary_veteran: 'I am not a protected veteran', ...answers } });

test('a Lever form is observed, answered from the profile, filled, submitted and receipted', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = await mkdtemp(join(tmpdir(), 'workie-lever-'));
  try {
    const resume = join(directory, 'resume.pdf');
    await writeFile(resume, '%PDF-1.4 synthetic resume', { mode: 0o600 });
    const { runtime, posted } = await leverFixture(browser);
    const input = leverApplication();
    input.documents.resume = resume;
    const observation = await lever.observe(runtime, input);
    assert.deepEqual(observation.fields.map(field => [field.name, field.kind, field.required, field.options, field.key.endsWith('[]')]), [
      ['resume', 'file', true, undefined, false], ['name', 'text', true, undefined, false], ['email', 'email', true, undefined, false],
      ['location', 'text', true, undefined, false], ['urls[LinkedIn]', 'text', false, undefined, false],
      ['cards[c1][field0]', 'radio', true, ['English', 'Korean', 'French'], true], ['cards[c1][field1]', 'radio', true, ['Yes', 'No'], false],
      ['cards[c1][field2]', 'textarea', true, undefined, false], ['eeo[gender]', 'select', false, ['Male', 'Female'], false],
      ['eeo[veteran]', 'select', false, ['I am not a veteran'], false]]);
    // The veteran wording differs from the profile's, so it is left blank rather than guessed.
    assert.deepEqual(observation.fields.map(field => lever.answer(input, field)),
      [undefined, 'Test Applicant', 'test@example.com', 'San Francisco, CA', undefined, undefined, 'Yes', undefined, 'Male', undefined]);
    const [languages, why] = [observation.fields[5], observation.fields[7]];
    // An unanswered required question stops the fill so the worker can ask the applicant.
    await assert.rejects(lever.fill(runtime, input, observation), error => error.code === 'REQUIRED_ANSWER_MISSING' && error.message === languages.key);
    input.answers[leverQuestionKey(languages)] = ['English', 'Korean'];
    input.answers[leverQuestionKey(why)] = 'Because of the fixture.';
    const result = await runAtsApplication({ runtime, adapter: lever, application: input, facts, requirements });
    assert.equal(result.state, 'submitted');
    assert.match(result.receipt.receiptId, /^lv-[0-9a-f]{32}$/);
    assert.deepEqual(result.receipt.identity, input.identity);
    for (const value of ['Test Applicant', 'San Francisco, CA, USA', 'English', 'Korean', 'Because of the fixture.', 'Male', 'filename="resume.pdf"']) assert.ok(posted[0].includes(value), value);
    assert.ok(!posted[0].includes('French') && !posted[0].includes('I am not a veteran'));
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('an hCaptcha challenge nested in its enclave frame counts only while it is shown', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const html = body => ({ contentType: 'text/html; charset=utf-8', body });
    await context.route('https://newassets.hcaptcha.com/**', route => route.fulfill(html(route.request().url().includes('enclave.html')
      ? '<div><div id="box" style="visibility:hidden"><iframe src="https://newassets.hcaptcha.com/hcaptcha.html#frame=challenge&id=1"></iframe></div></div>' : 'puzzle')));
    await context.route(`${leverJob}/apply`, route => route.fulfill(html('<iframe src="https://newassets.hcaptcha.com/enclave.html#frame=enclave"></iframe>')));
    const page = await context.newPage();
    await page.goto(`${leverJob}/apply`);
    await page.frames().find(frame => frame.url().includes('frame=enclave')).waitForSelector('iframe', { state: 'attached' });
    assert.equal(await hcaptchaChallengeShown(page), false);
    await page.frames().find(frame => frame.url().includes('frame=enclave')).evaluate(() => { document.getElementById('box').style.visibility = 'visible'; });
    assert.equal(await hcaptchaChallengeShown(page), true);
  } finally { await browser.close(); }
});
test('a Lever location not among the suggestions asks the applicant to pick one of them', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { runtime } = await leverFixture(browser);
    const input = leverApplication({ current_location: 'San Francisco, California' });
    const observation = await lever.observe(runtime, input);
    const location = observation.fields.find(field => field.name === 'location');
    await assert.rejects(lever.fill(runtime, input, { ...observation, fields: [location] }),
      error => error.code === 'ANSWER_OPTION_INVALID' && error.options.join('|') === 'San Francisco, CA, USA|San Francisco, Córdoba, ARG');
  } finally { await browser.close(); }
});
test('a Lever form for another role or posting is an identity mismatch', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await assert.rejects(lever.observe((await leverFixture(browser, 'Other Intern')).runtime, leverApplication()), /ATS_IDENTITY_MISMATCH/);
    const { runtime } = await leverFixture(browser);
    await assert.rejects(lever.observe(runtime, { ...leverApplication(), applicationUrl: 'https://jobs.lever.co/fixture/11111111-1111-4111-8111-111111111111/apply' }), /ATS_IDENTITY_MISMATCH/);
    await assert.rejects(lever.observe(runtime, { ...leverApplication(), applicationUrl: 'https://jobs.eu.lever.co/fixture/0b2c3d4e-1111-4222-8333-944455566677' }), /ATS_IDENTITY_MISMATCH/);
  } finally { await browser.close(); }
});

test('applications open as tabs of one window, each reaching only its own origins', { skip: !browserReady }, async () => {
  const listen = () => new Promise(resolve => { const server = createServer((_, response) => response.end('<title>ok</title>'));
    server.listen(0, '127.0.0.1', () => resolve(server)); });
  const [a, b] = await Promise.all([listen(), listen()]);
  const origin = server => `http://127.0.0.1:${server.address().port}`;
  const userDataDir = await mkdtemp(join(tmpdir(), 'workie-tabs-'));
  const open = server => openApplicationTab({ userDataDir, approvedOrigins: [`${origin(server)}/`], allowLoopback: true, headless: true });
  let first;
  try {
    first = await open(a); const second = await open(b);
    const pageA = await first.navigate(await first.page(), `${origin(a)}/`);
    const pageB = await second.navigate(await second.page(), `${origin(b)}/`);
    assert.equal(first.context, second.context, 'one window');
    assert.notEqual(pageA, pageB, 'one tab per application');
    assert.equal(await pageA.evaluate(url => fetch(url).then(() => 'reached', () => 'blocked'), `${origin(b)}/`), 'blocked');
    await second.close();
    assert.ok(pageB.isClosed(), 'a finished application closes its tab');
    await first.close();
    assert.equal(first.context.pages().length, 1, 'the last tab stays so the window stays up');
    const third = await open(a);
    assert.equal(await third.page(), pageA, 'the idle tab is reused');
    await third.close();
    // The applicant closes the blank window between applications: the next one opens a fresh tab.
    await pageA.close();
    const fourth = await open(a);
    const pageD = await fourth.navigate(await fourth.page(), `${origin(a)}/`);
    assert.equal(await pageD.title(), 'ok', 'a closed idle tab is never handed out');
  } finally {
    await first?.context.close(); a.close(); b.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('a long Lever list takes the one option a typed name matches', () => {
  const schools = ['Stanford University', 'University of Southern California', 'University of California, Los Angeles', 'Other (School Not Listed)'];
  assert.equal(matchOption(schools, 'Stanford University'), 'Stanford University');
  assert.equal(matchOption(schools, '  stanford  university '), 'Stanford University');
  assert.equal(matchOption(schools, 'Stanford'), 'Stanford University');
  assert.equal(matchOption(schools, 'other'), 'Other (School Not Listed)');
  assert.equal(matchOption(schools, 'University of'), undefined);
  assert.equal(matchOption(schools, ''), undefined);
});

// Palantir's live label (2026-10): a long university list with an instruction after the question.
const palantirSchool = 'Which university are you currently attending or did you last attend? Please select "Other (School Not Listed)" if your school is not listed.';
test("the profile school answers a school list only with the option that is that school", () => {
  const ask = (school, field) => lever.answer(leverApplication({ 'school--0': school }), { key: 'f-1', name: 'cards[c][field0]', required: true, ...field });
  // Too many options to carry: the profile school goes to the fill, which checks it against the live list.
  assert.equal(ask('Stanford University', { label: palantirSchool, kind: 'select' }), 'Stanford University');
  // Only a list's trailing instruction is dropped: a text question that asks for more than the school is asked.
  assert.equal(ask('Stanford University', { label: palantirSchool, kind: 'text' }), undefined);
  assert.equal(ask('Stanford University', { label: 'What school do you attend? Please also list your GPA.', kind: 'text' }), undefined);
  const options = ['Stanford University', 'The University of Texas at Austin', 'Texas A&M University', 'Other (School Not Listed)'];
  assert.equal(ask('University of Texas at Austin', { label: 'School', kind: 'select', options }), 'The University of Texas at Austin');
  assert.equal(ask('texas a and m university', { label: 'School', kind: 'select', options }), 'Texas A&M University');
  assert.equal(ask('Stanford', { label: 'School', kind: 'select', options }), undefined); // close is not the same school
  assert.equal(matchOption(options, 'stanford university.', false), 'Stanford University');
  assert.equal(matchOption(options, 'Stanford', false), undefined);
});
test('a long Lever list takes the profile school only when it is one option exactly', { skip: !browserReady }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const schools = ['Stanford University', ...Array.from({ length: 120 }, (_, i) => `College ${i}`), 'Other (School Not Listed)'];
    await page.setContent(`<select name="cards[c][field0]"><option value="">Select ...</option>${schools.map(school => `<option value="${school}">${school}</option>`).join('')}</select>`);
    const field = { key: 'f-1', name: 'cards[c][field0]', label: palantirSchool, kind: 'select', required: true };
    const fill = school => lever.fill({ page: async () => page }, leverApplication({ 'school--0': school }), { fields: [field] });
    await assert.rejects(fill('Stanford'), error => error.code === 'ANSWER_OPTION_INVALID'); // asked, not guessed
    await fill('stanford university');
    assert.equal(await page.locator('select').evaluate(node => node.selectedOptions[0].label), 'Stanford University');
  } finally { await browser.close(); }
});
