import { z } from 'zod';
import { FactScopeSchema, PreciseDateSchema, ProvenanceSchema } from './profile.ts';
import { CheckpointSchema, count, hash, identity, revision, uuid } from './worker-protocol.ts';

const label = z.string().min(1).max(300), prose = z.string().min(1).max(4000);
const base = { allowBlank: z.boolean(), declineValue: label.nullable() };
const unitless = { units: z.null(), precision: z.null() };
const text = { ...base, ...unitless, minLength: count.max(4000), maxLength: revision.max(4000), format: z.enum(['plain', 'email', 'url']) };
const choice = {
  ...base, ...unitless, options: z.array(z.strictObject({ value: label, label })).min(1).max(100),
  minSelections: count.max(100), maxSelections: revision.max(100),
};
export const QuestionFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), ...text }),
  z.strictObject({ type: z.literal('textarea'), ...text }),
  z.strictObject({ type: z.literal('select'), ...choice }),
  z.strictObject({ type: z.literal('radio'), ...choice }),
  z.strictObject({ type: z.literal('multiselect'), ...choice }),
  z.strictObject({ type: z.literal('boolean'), ...base, ...unitless }),
  z.strictObject({ type: z.literal('number'), ...base, min: z.number().finite(), max: z.number().finite(),
    units: label, precision: count.max(8), integer: z.boolean() }),
  z.strictObject({ type: z.literal('date'), ...base, units: z.null(), precision: z.enum(['year', 'month', 'day']),
    min: z.string().max(10).nullable(), max: z.string().max(10).nullable() }),
  z.strictObject({ type: z.literal('document'), ...base, ...unitless,
    documentKinds: z.array(z.enum(['resume_master', 'resume_source', 'transcript', 'certificate', 'supporting', 'portfolio', 'artwork'])).min(1).max(5),
    mimeTypes: z.array(z.enum(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg'])).min(1).max(4),
    maxBytes: revision.max(10 * 1024 * 1024) }),
  z.strictObject({ type: z.literal('intervention'), ...base, ...unitless }),
]).superRefine((f, ctx) => {
  const invalid = () => ctx.addIssue({ code: 'custom', message: 'Inconsistent field schema.' });
  if ('minLength' in f && f.minLength > f.maxLength) invalid();
  if ('options' in f && (new Set(f.options.map(o => o.value)).size !== f.options.length ||
      f.minSelections > f.maxSelections || f.maxSelections > f.options.length ||
      (f.type !== 'multiselect' && f.maxSelections !== 1) ||
      (f.declineValue !== null && !f.options.some(o => o.value === f.declineValue)))) invalid();
  if (f.type === 'number' && (f.min > f.max || (f.integer && f.precision !== 0))) invalid();
  if (f.type === 'date') {
    for (const value of [f.min, f.max]) if (value !== null &&
        !PreciseDateSchema.safeParse({ value, precision: f.precision }).success) invalid();
    if (f.min !== null && f.max !== null && f.min > f.max) invalid();
  }
  if (f.type === 'intervention' && (f.allowBlank || f.declineValue !== null)) invalid();
});
export const QuestionScopeSchema = FactScopeSchema.safeExtend({ tenant: identity, ats: identity, version: revision });
export const QuestionDescriptorSchema = z.strictObject({
  key: label,
  kind: z.enum(['needs_answer', 'needs_document', 'needs_login', 'needs_verification', 'needs_policy_decision', 'provider_unavailable', 'failed']),
  originalWording: prose, reason: prose, required: z.boolean(),
  meaning: z.strictObject({ id: label, reviewId: uuid.nullable() }),
  schemaVersion: revision, scope: QuestionScopeSchema, provenance: ProvenanceSchema,
  field: QuestionFieldSchema, factIds: z.array(uuid).max(100), sensitive: z.boolean(),
}).superRefine((q, ctx) => {
  if (new Set(q.factIds).size !== q.factIds.length ||
      (q.kind === 'needs_document') !== (q.field.type === 'document') ||
      (['needs_login', 'needs_verification', 'provider_unavailable', 'failed'].includes(q.kind)) !== (q.field.type === 'intervention') ||
      (q.required && q.field.allowBlank)) {
    ctx.addIssue({ code: 'custom', message: 'Question kind, requiredness or facts are inconsistent.' });
  }
  if (['document', 'model'].includes(q.provenance.source) && (!q.provenance.sourceId || !q.provenance.sourceVersion)) {
    ctx.addIssue({ code: 'custom', message: 'A versioned provenance source is required.' });
  }
});
export const AnswerValueSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), value: z.string().max(4000) }),
  z.strictObject({ type: z.literal('choice'), value: label }),
  z.strictObject({ type: z.literal('choices'), value: z.array(label).max(100) }),
  z.strictObject({ type: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ type: z.literal('number'), value: z.number().finite(), units: label, precision: count.max(8) }),
  z.strictObject({ type: z.literal('date'), value: z.string().max(10), precision: z.enum(['year', 'month', 'day']) }),
  z.strictObject({ type: z.literal('document'), documentId: uuid, version: revision, sha256: hash }),
  z.strictObject({ type: z.literal('blank') }),
  z.strictObject({ type: z.literal('decline'), value: label }),
]);
export const FactVersionsSchema = z.array(z.strictObject({ id: uuid, version: revision })).max(100);
const questionPreconditions = {
  expectedRevision: revision, expectedProfileRevision: count,
  expectedPolicyRevision: revision, expectedScopeHash: hash, factVersions: FactVersionsSchema,
};
export const AnswerCommandSchema = z.strictObject({
  requestId: uuid, ...questionPreconditions,
  reuse: z.literal('application'), answer: AnswerValueSchema,
});
export const FocusCommandSchema = z.strictObject({ requestId: uuid, expectedRevision: revision });
export const ReadCommandSchema = z.strictObject({ eventIds: z.array(uuid).min(1).max(50) });
export const QuestionBatchSchema = z.strictObject({
  questionProtocolVersion: z.literal(1), eventId: uuid, fence: revision, expectedRevision: revision,
  expectedProfileRevision: count, checkpoint: CheckpointSchema, company: label, role: label,
  questions: z.array(QuestionDescriptorSchema).min(1).max(64), // a whole form at once
}).refine(v => new Set(v.questions.map(q => q.key)).size === v.questions.length, 'Duplicate question keys.');
export const QuestionBatchResultSchema = z.strictObject({
  applicationId: uuid, eventId: uuid, revision, questionIds: z.array(uuid).max(64), replayed: z.boolean(), lease: z.null(),
});
export const AnswerResultSchema = z.strictObject({
  ownerId: z.string(), answerId: uuid, questionId: uuid, resolvedQuestionIds: z.array(uuid),
  resumedApplicationIds: z.array(uuid), replayed: z.boolean(),
});
/** Every answer of one application form in one request: saved together or not at all. */
export const AnswerBatchSchema = z.strictObject({
  answers: z.array(z.strictObject({ questionId: uuid, command: AnswerCommandSchema })).min(1).max(64),
});
export const AnswerBatchResultSchema = z.strictObject({ ownerId: z.string(), results: z.array(AnswerResultSchema).max(64) });
export const FocusResultSchema = z.strictObject({
  id: uuid, questionId: uuid, applicationId: uuid, workerId: uuid, revision,
  status: z.enum(['pending', 'focused', 'unavailable', 'observed']), reason: z.string().max(300).nullable(),
});
export const QuestionDetailSchema = z.strictObject({
  id: uuid, ownerId: z.string(), revision, descriptor: QuestionDescriptorSchema,
  application: z.strictObject({ id: uuid, workerId: uuid, ats: identity, tenant: identity, requisition: identity, company: label, role: label }),
  waitingCount: count, resolved: z.boolean(), expectedProfileRevision: count, expectedPolicyRevision: revision,
  expectedScopeHash: hash, factVersions: FactVersionsSchema,
  allowedReuse: z.array(z.literal('application')).max(1),
  canAnswer: z.boolean(), canBlank: z.boolean(), canDecline: z.boolean(), focus: FocusResultSchema.nullable(),
});
export const InboxStatusSchema = z.strictObject({
  ownerId: z.string(), unread: count, unresolved: count, waitingApplications: count, serverTime: count,
});
export const InboxItemSchema = z.strictObject({
  eventId: uuid, applicationId: uuid, kind: label, createdAt: count, read: z.boolean(), question: QuestionDetailSchema.nullable(),
});
export const InboxPageSchema = InboxStatusSchema.extend({ items: z.array(InboxItemSchema).max(250), nextCursor: uuid.nullable() });
export const InboxQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(250).default(20), cursor: uuid.optional(), applicationId: uuid.optional(),
});
export const InterventionPollSchema = z.strictObject({ questionProtocolVersion: z.literal(1) });
export const InterventionCommandSchema = FocusResultSchema.extend({
  expectedApplicationRevision: revision, fence: revision, descriptor: QuestionDescriptorSchema, checkpoint: CheckpointSchema.nullable(),
});
export const InterventionPageSchema = z.strictObject({ questionProtocolVersion: z.literal(1), commands: z.array(InterventionCommandSchema).max(20) });
export const InterventionAckSchema = z.strictObject({
  questionProtocolVersion: z.literal(1), eventId: uuid, expectedRevision: revision, expectedApplicationRevision: revision, fence: revision,
  result: z.enum(['focused', 'unavailable', 'observed']), reason: z.string().max(300).nullable(),
  observation: z.strictObject({
    kind: z.enum(['login_complete', 'verification_complete']), ats: identity, tenant: identity, requisition: identity, observedAt: count,
  }).nullable(),
}).refine(v => (v.result === 'observed') === (v.observation !== null), 'Observation is required only for completion.');

export type QuestionDescriptor = z.infer<typeof QuestionDescriptorSchema>;
export type QuestionField = z.infer<typeof QuestionFieldSchema>;
export type AnswerValue = z.infer<typeof AnswerValueSchema>;
export type AnswerCommand = z.infer<typeof AnswerCommandSchema>;
export type AnswerResult = z.infer<typeof AnswerResultSchema>;
export type AnswerBatch = z.infer<typeof AnswerBatchSchema>;
export type FocusCommand = z.infer<typeof FocusCommandSchema>;
export type FocusResult = z.infer<typeof FocusResultSchema>;
export type ReadCommand = z.infer<typeof ReadCommandSchema>;
export type QuestionBatch = z.infer<typeof QuestionBatchSchema>;
export type QuestionBatchResult = z.infer<typeof QuestionBatchResultSchema>;
export type QuestionDetail = z.infer<typeof QuestionDetailSchema>;
export type InboxStatus = z.infer<typeof InboxStatusSchema>;
export type InboxPage = z.infer<typeof InboxPageSchema>;
export type InterventionCommand = z.infer<typeof InterventionCommandSchema>;
export type InterventionAck = z.infer<typeof InterventionAckSchema>;
export type InterventionPage = z.infer<typeof InterventionPageSchema>;

/** No coercion: exact options, units and supplied date/number precision are part of the answer. */
export function validQuestionAnswer(q: QuestionDescriptor, a: AnswerValue, allowOptional: boolean): boolean {
  const f = q.field;
  if (f.type === 'intervention') return false;
  if (a.type === 'blank') return !q.required && f.allowBlank && allowOptional;
  if (a.type === 'decline') return f.declineValue === a.value && allowOptional;
  if (f.type === 'text' || f.type === 'textarea') return a.type === 'text' &&
    a.value.length >= f.minLength && a.value.length <= f.maxLength && a.value.trim().length > 0 &&
    (f.format === 'plain' || (f.format === 'email' ? z.email().safeParse(a.value).success : z.url({ protocol: /^https?$/ }).safeParse(a.value).success));
  if ('options' in f) {
    const values = a.type === 'choice' && f.type !== 'multiselect' ? [a.value] :
      a.type === 'choices' && f.type === 'multiselect' ? a.value : null;
    return values !== null && values.length >= Math.max(1, f.minSelections) &&
      (allowOptional || !values.includes(f.declineValue ?? '')) &&
      values.length <= f.maxSelections && new Set(values).size === values.length && values.every(v => f.options.some(o => o.value === v));
  }
  if (f.type === 'boolean') return a.type === 'boolean';
  if (f.type === 'number') return a.type === 'number' && a.units === f.units && a.precision === f.precision &&
    a.value >= f.min && a.value <= f.max && (!f.integer || Number.isSafeInteger(a.value)) &&
    Math.abs(a.value * 10 ** f.precision) <= Number.MAX_SAFE_INTEGER &&
    Math.abs(a.value * 10 ** f.precision - Math.round(a.value * 10 ** f.precision)) < 1e-7;
  if (f.type === 'date') return a.type === 'date' && a.precision === f.precision &&
    PreciseDateSchema.safeParse({ precision: a.precision, value: a.value }).success &&
    (f.min === null || a.value >= f.min) && (f.max === null || a.value <= f.max);
  return f.type === 'document' && a.type === 'document';
}
