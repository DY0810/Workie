import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenApplication, screeningQuestions, formQuestions } from './screening.ts';
import { QuestionDispatchSchema } from './question-client.ts';
import { AtsAnswerErrors, AtsError, fillEach, formQuestionKey } from './ats/protocol.ts';
import { createStageDispatch } from './main.ts';

const facts = {
  countries: { state: 'confirmed', values: ['US'] }, degreeLevels: { state: 'confirmed', values: ['bachelor'] },
  majors: { state: 'confirmed', values: ['computer science'] }, availableTerms: { state: 'confirmed', values: ['summer 2028'] },
  expectedGraduation: { state: 'confirmed', month: '2028-12' }, workAuthorization: { state: 'unknown', values: [] },
  pay: { state: 'unknown', amount: null, currency: null, period: null },
};
const requirements = {
  sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/123', officialDescription: 'Summer 2028 internship',
  excerpts: ['Summer 2028 internship'], countries: [], degreeLevels: [], majors: [], terms: ['summer 2028'],
  graduationWindow: { earliest: '2028-09', latest: '2029-08' }, authorizationRequired: false,
  paid: true, payFloor: { amount: 20, currency: 'USD', period: 'hour' },
};

test('graduation and pay screening use their own confirmed facts', () => {
  assert.equal(screenApplication(facts, requirements).status, 'eligible');
  assert.deepEqual(screenApplication(facts, { ...requirements, graduationWindow: { earliest: '2027-01', latest: '2028-08' } }).reasons, ['graduation_ineligible']);
  assert.deepEqual(screenApplication({ ...facts, expectedGraduation: { state: 'unknown', month: null } }, requirements).reasons, ['graduation_unknown']);
  assert.equal(screenApplication({ ...facts, pay: { state: 'confirmed', amount: 25, currency: 'USD', period: 'hour' } }, requirements).status, 'needs_question');
  assert.deepEqual(screenApplication({ ...facts, pay: { state: 'confirmed', amount: 25, currency: 'USD', period: 'hour' } }, { ...requirements, paid: false }).reasons, ['unpaid_below_preference']);
});

// 2026-10-19: Glean (graduation window Fall 2027 to Spring 2028) and Figma (PhD only) were skipped as plain
// "screening_ineligible", so DY's cards said "skipped" with no reason and offered a Retry that would skip again.
test('a screening skip records which requirement the applicant does not meet', async () => {
  const signal = new AbortController().signal;
  const skip = async (blocking) => createStageDispatch({ applicationContext: async () => ({
    identity: { ats: 'greenhouse', tenant: 'gleanwork', requisition: '4595665005' }, facts, requirements: { ...requirements, ...blocking },
  }) }, '/nonexistent', signal)({ applicationId: crypto.randomUUID(), runId: crypto.randomUUID(), fence: 1, revision: 1, state: 'screening', checkpoint: null },
  { check() {} }, { signal, advance() {}, generate: async () => { throw new Error('unused'); } });
  const graduation = { graduationWindow: { earliest: '2027-09', latest: '2028-05' } };
  assert.deepEqual(await skip(graduation), { state: 'skipped', reasonCode: 'graduation_ineligible' });
  assert.deepEqual(await skip({ ...graduation, degreeLevels: ['doctorate'] }), { state: 'skipped', reasonCode: 'degree_ineligible,graduation_ineligible' });
});

test('missing screening facts produce application-scoped durable question descriptors', () => {
  const applicationId = crypto.randomUUID();
  const result = screeningQuestions({ applicationId, profileRevision: 2, company: 'Fixture', role: 'Intern',
    identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' }, requirements },
    ['graduation_unknown', 'work_authorization_unknown']);
  assert.equal(result.expectedProfileRevision, 2);
  assert.deepEqual(result.questions.map(q => q.key), ['screening-graduation', 'screening-authorization']);
  assert(result.questions.every(q => q.scope.applicationId === applicationId && q.required));
});

test('yes/no screening questions are choices with the values application-context reads back', () => {
  const result = QuestionDispatchSchema.parse(screeningQuestions({ applicationId: crypto.randomUUID(), profileRevision: 2, company: 'Fixture', role: 'Intern',
    identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' }, requirements: { ...requirements, terms: ['Summer 2027', 'Summer 2027'] } },
    ['employer_pay_unknown', 'work_authorization_unknown', 'term_unknown', 'graduation_unknown']));
  const values = result.questions.map(q => q.field.type === 'select' ? q.field.options.map(o => o.value) : q.field.type);
  assert.deepEqual(values, [['accept'], ['authorized', 'not_authorized'], ['Summer 2027'], 'text']);
  assert(result.questions.every(q => !/\bEnter (accept|authorized)\b/.test(q.originalWording)));
});

test('unknown employer fields become scoped inbox questions with exact wording', () => {
  const applicationId = crypto.randomUUID();
  const context = { applicationId, profileRevision: 2, company: 'Fixture', role: 'Intern',
    identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' },
    applicationUrl: 'https://job-boards.greenhouse.io/fixture/jobs/123' };
  const batch = QuestionDispatchSchema.parse(formQuestions(context, [
    { key: 'question_123', label: 'Are you a U.S. citizen?', kind: 'combobox', required: true },
  ]));
  assert.equal(batch.questions[0].key, formQuestionKey({ key: 'question_123', label: 'Are you a U.S. citizen?' }));
  assert.equal(batch.questions[0].originalWording, 'Are you a U.S. citizen?');
  assert.equal(batch.questions[0].scope.applicationId, applicationId);
  assert.equal(batch.questions[0].sensitive, true);
  // A heading-only label shows the text under it; the key stays the label's, so saved answers still match.
  const described = QuestionDispatchSchema.parse(formQuestions(context, [{ key: 'question_9', label: 'Applicant Arbitration Agreement',
    description: 'I acknowledge that I have read the Arbitration Agreement.', kind: 'checkbox', required: true }]));
  assert.equal(described.questions[0].originalWording, 'Applicant Arbitration Agreement\n\nI acknowledge that I have read the Arbitration Agreement.');
  assert.equal(described.questions[0].key, formQuestionKey({ key: 'question_9', label: 'Applicant Arbitration Agreement' }));
  // A form textarea is asked as one, so the inbox gives the answer room; a one-line input stays text.
  const prose = QuestionDispatchSchema.parse(formQuestions(context, [{ key: 'question_10', label: 'Why us?', kind: 'textarea', required: true },
    { key: 'question_11', label: 'Pronouns', kind: 'text', required: true }]));
  assert.deepEqual(prose.questions.map(q => q.field.type), ['textarea', 'text']);
});

test('a fill keeps going past rejected answers so the whole form is asked at once', async () => {
  const filled = [];
  const error = await fillEach(['a', 'b', 'c', 'd'], async (key) => {
    if (key === 'a') throw new AtsError('REQUIRED_ANSWER_MISSING', key);
    if (key === 'c') throw new AtsError('ANSWER_OPTION_INVALID', key, ['Yes', 'No']);
    filled.push(key);
  }).catch(caught => caught);
  assert.ok(error instanceof AtsAnswerErrors);
  assert.deepEqual(error.errors.map(item => [item.message, item.options]), [['a', undefined], ['c', ['Yes', 'No']]]);
  assert.deepEqual(filled, ['b', 'd']);
  // Anything else still stops the fill at once.
  await assert.rejects(fillEach(['a', 'b'], async () => { throw new AtsError('FIELD_NOT_FOUND', 'a'); }), { code: 'FIELD_NOT_FOUND' });
  const many = Array.from({ length: 30 }, (_, index) => ({ key: `question_${index}`, label: `Question ${index}?`, kind: 'text', required: true }));
  assert.equal(formQuestions({ applicationId: crypto.randomUUID(), profileRevision: 1, company: 'Fixture', role: 'Intern',
    identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '1' }, applicationUrl: 'https://job-boards.greenhouse.io/fixture/jobs/1' },
  many).questions.length, 30);
});
