import { z } from 'zod';
import { APPLICATION_STATES, SAFE_STAGES } from './state.ts';

export const WORKER_PROTOCOL_VERSION = 1;
/** The only Greenhouse tenant a non-production deployment lets a worker submit to; the worker serves its pages locally. */
export const STAGING_FIXTURE_TENANT = 'workie-staging-fixture';
export const LEASE_MS = 120_000;
export const HEARTBEAT_MS = 20_000;
// Longest an ATS adapter keeps the employer's window open after submit, for the applicant's emailed code or captcha.
export const SUBMIT_WAIT_MS = 30 * 60_000;
// A poll may run a discovery scan before it assigns a lease.
export const POLL_TIMEOUT_MS = 30_000;
export const PAIRING_TTL_MS = 600_000;
export const WORKER_CAPABILITIES = ['control-v1'] as const;
export const uuid = z.uuid();
export const revision = z.number().int().positive().safe();
export const timestamp = z.number().int().nonnegative().safe();
export const count = z.number().int().nonnegative().safe();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const name = z.string().trim().min(1).max(80);
export const identity = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const capabilities = z.tuple([z.literal('control-v1')]);
const protocol = { protocolVersion: z.literal(WORKER_PROTOCOL_VERSION) };
const command = { requestId: uuid, expectedRevision: revision };
const clock = { ...protocol, serverTime: timestamp, heartbeatMs: z.literal(HEARTBEAT_MS), leaseMs: z.literal(LEASE_MS) };
export const ApplicationStateSchema = z.enum(APPLICATION_STATES);
export const PairingCreateSchema = z.strictObject({ ...command, expectedRevision: z.literal(0), label: name });
export const PairingGrantSchema = z.strictObject({
  pairingId: uuid, ownerId: z.string(), grant: secret, expiresAt: timestamp, revision: z.literal(1),
});
export const PairRequestSchema = z.strictObject({
  ...protocol, requestId: uuid, workerId: uuid, grant: secret, workerToken: secret,
  workerVersion: z.string().regex(/^[a-zA-Z0-9.+_-]{1,40}$/), capabilities,
  // A precondition, never authority: the grant alone decides the owner. Optional so a worker built before it still pairs.
  expectedOwnerId: z.string().min(1).max(256).optional(),
});
export const PairResponseSchema = z.strictObject({ ...clock, workerId: uuid, ownerId: z.string(), revision });
export const RevisionCommandSchema = z.strictObject(command);
export const RevocationSchema = z.strictObject({ id: uuid, revision, revokedAt: timestamp });
export const WorkerSummarySchema = z.strictObject({
  id: uuid, label: name, revision, workerVersion: z.string(), capabilities,
  createdAt: timestamp, lastSeenAt: timestamp.nullable(), revokedAt: timestamp.nullable(), online: z.boolean(),
  dailyStartMinute: z.number().int().min(0).max(1439).nullable(), timeZone: z.string().nullable(),
});
const timeZone = z.string().min(1).max(64).refine((value) => {
  try { new Intl.DateTimeFormat(undefined, { timeZone: value }); return true; } catch { return false; }
});
export const WorkerScheduleSchema = z.strictObject({ ...command, dailyStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(), timeZone });
export const WorkerScheduleAckSchema = z.strictObject({ id: uuid, revision, dailyStartMinute: z.number().int().min(0).max(1439).nullable(), timeZone: z.string().nullable() });
export const PairingSummarySchema = z.strictObject({
  id: uuid, label: name, revision, expiresAt: timestamp, consumedAt: timestamp.nullable(), revokedAt: timestamp.nullable(),
});
export const WorkerListSchema = z.strictObject({
  ownerId: z.string(), serverTime: timestamp, workers: z.array(WorkerSummarySchema), pairings: z.array(PairingSummarySchema),
});
export const PollRequestSchema = z.strictObject(protocol);
export const LeaseRefSchema = z.strictObject({ applicationId: uuid, fence: revision, expectedRevision: revision });
export const HeartbeatRequestSchema = z.strictObject({ ...protocol, lease: LeaseRefSchema.nullable() });
export const CheckpointSchema = z.strictObject({ stage: z.enum(SAFE_STAGES), sequence: timestamp });
export const EventEvidenceSchema = z.strictObject({
  artifactVerified: z.boolean().optional(), formVerified: z.boolean().optional(), submitPermit: z.boolean().optional(),
}).optional();
export const LeaseSchema = z.strictObject({
  applicationId: uuid, runId: uuid, workerId: uuid, ownerId: z.string().min(1), policyRevision: revision,
  ats: identity, tenant: identity, requisition: identity,
  state: ApplicationStateSchema, revision, fence: revision, leaseUntil: timestamp,
  checkpoint: CheckpointSchema.nullable(), mode: z.enum(['safe', 'reconcile']),
});
export const PollResponseSchema = z.strictObject({ ...clock, lease: LeaseSchema.nullable() });
export const EventRequestSchema = z.strictObject({
  ...protocol, eventId: uuid, fence: revision, expectedRevision: revision,
  state: ApplicationStateSchema, checkpoint: CheckpointSchema, reasonCode: name.nullable(), evidence: EventEvidenceSchema,
});
export const EventResponseSchema = z.strictObject({
  applicationId: uuid, eventId: uuid, revision, state: ApplicationStateSchema,
  replayed: z.boolean(), lease: LeaseSchema.nullable(), serverTime: timestamp,
});
export const RunCreateSchema = z.strictObject({ ...command, expectedRevision: z.literal(0), workerId: uuid });
export const RunCommandSchema = z.strictObject({ ...command, action: z.enum(['pause', 'resume', 'stop', 'emergency-stop']) });
export const ApplicationCommandSchema = z.strictObject({
  ...command, action: z.enum(['skip', 'retry-safe', 'cancel', 'emergency-stop', 'approve-submit', 'delete', 'confirm-submitted', 'confirm-not-submitted']),
});
export const RunSchema = z.strictObject({
  id: uuid, workerId: uuid, revision, state: z.enum(['running', 'paused', 'stopped']), createdAt: timestamp,
});
export const ApplicationSummarySchema = z.strictObject({
  id: uuid, runId: uuid, workerId: uuid, ats: identity, tenant: identity, requisition: identity,
  state: ApplicationStateSchema, revision, reasonCode: name.nullable(), checkpoint: CheckpointSchema.nullable(),
  retries: z.number().int().nonnegative().optional(),
  company: z.string().trim().min(1).max(200).nullable().optional(), role: z.string().trim().min(1).max(300).nullable().optional(),
  receiptId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).nullable().optional(), submittedAt: timestamp.nullable().optional(),
  provider: z.string().trim().min(1).max(100).nullable().optional(), costUsd: z.number().finite().nonnegative().nullable().optional(),
  createdAt: timestamp, hiddenAt: timestamp.nullable(),
});
// listRuns sends at most 100 runs, and 500 rows being worked, waiting or applied plus the newest 100 history rows.
export const RunListSchema = z.strictObject({
  ownerId: z.string(), runs: z.array(RunSchema).max(100), applications: z.array(ApplicationSummarySchema).max(600),
});
export const ApplicationIdentitySchema = z.strictObject({ ats: identity, tenant: identity, requisition: identity });
const role = z.string().trim().min(1).max(300);
const company = z.string().trim().min(1).max(200);
const receiptEvidence = z.strictObject({ source: z.enum(['confirmation_page', 'authorized_api']), pageUrl: z.url({ protocol: /^https?$/ }), observedText: z.string().trim().min(1).max(2000) });
export const SubmissionIntentSchema = z.strictObject({
  ...protocol, intentId: uuid, fence: revision, expectedRevision: revision, identity: ApplicationIdentitySchema,
  company, role, manifestHash: hash, artifactHashes: z.array(hash).min(1).max(16),
});
export const SubmissionIntentResponseSchema = z.strictObject({
  applicationId: uuid, intentId: uuid, state: z.literal('submitting'), revision, fence: revision, replayed: z.boolean(),
});
export const ReceiptCommandSchema = z.strictObject({
  ...protocol, intentId: uuid, identity: ApplicationIdentitySchema, company, role,
  receiptId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), submittedAt: timestamp, evidence: receiptEvidence,
});
export const ReceiptResponseSchema = z.strictObject({
  applicationId: uuid, intentId: uuid, state: z.literal('submitted'), revision, replayed: z.boolean(),
});
// The cover letter exactly as uploaded with a submitted application, and what the applicant can review.
const paragraph = z.string().trim().min(1).max(900);
const letterText = { introduction: paragraph, body: z.array(paragraph).min(1).max(4), conclusion: paragraph, companyParagraph: paragraph };
export const SubmittedLetterSchema = z.strictObject({ ...protocol, ...letterText });
export const SubmittedLetterAckSchema = z.strictObject({ applicationId: uuid, stored: z.literal(true) });
// A screenshot of the application tab while the worker works it; omitted keeps the last one, null drops it.
// A review row names its form question (formQuestionKey), kind and choices so the applicant can change it before Apply.
// Older workers send label and value only; those rows stay read-only.
const reviewField = { label: z.string().min(1).max(1000), value: z.string().max(4000), key: z.string().regex(/^form-[0-9a-f]{32}$/).optional(),
  kind: z.enum(['text', 'email', 'date', 'select', 'combobox', 'radio', 'checkbox', 'file']).optional(),
  options: z.array(z.string().trim().min(1).max(300)).max(100).optional(), multiple: z.literal(true).optional() };
const liveFields = z.array(z.strictObject(reviewField)).max(64);
/** An answer the applicant changed in review: the worker types it in at submit. Only the server stores it; workers never send it. */
export const ReviewEditSchema = z.union([z.string().trim().min(1).max(4000), z.boolean(), z.array(z.string().trim().min(1).max(300)).min(1).max(100)]);
const reviewedFields = z.array(z.strictObject({ ...reviewField, edit: ReviewEditSchema.optional() })).max(64);
export type ReviewedField = z.infer<typeof reviewedFields>[number];
/** At most this many changed answers per form, so they fit the worker context's 64 answers beside the profile's. */
export const MAX_REVIEW_EDITS = 16;
// null takes a change back.
export const ReviewEditsSchema = z.strictObject({ edits: z.record(z.string().regex(/^form-[0-9a-f]{32}$/), ReviewEditSchema.nullable())
  .refine(edits => Object.keys(edits).length >= 1 && Object.keys(edits).length <= MAX_REVIEW_EDITS) });
export const ReviewEditsAckSchema = z.strictObject({ applicationId: uuid, fields: reviewedFields });
const liveImage = z.string().max(120_000).regex(/^[A-Za-z0-9+/]*={0,2}$/);
export const LiveFrameSchema = z.strictObject({ ...protocol, step: z.string().trim().min(1).max(200),
  image: liveImage.nullable().optional(), fields: liveFields.optional() });
/** The last step the worker posts when it parks a form on the applicant. It has left the page, so Live never shows it as filling. */
export const PARKED_STEPS = { approval: 'Filled. Waiting for your approval', answers: 'Waiting for your answers' } as const;
export const LiveFrameAckSchema = z.strictObject({ applicationId: uuid, stored: z.literal(true) });
// An employer's emailed security code: the applicant enters it on Workie and the worker takes it once to type into the form.
const securityCode = z.string().regex(/^[A-Za-z0-9]{4,16}$/);
export const VerificationCodeSchema = z.strictObject({ code: securityCode });
export const VerificationCodeAckSchema = z.strictObject({ applicationId: uuid, stored: z.literal(true) });
export const VerificationCodeTakeSchema = z.strictObject({ ...protocol });
export const VerificationCodeResponseSchema = z.strictObject({ code: securityCode.nullable() });
export const LiveListSchema = z.strictObject({ ownerId: z.string().min(1), live: z.array(z.strictObject({
  applicationId: uuid, state: ApplicationStateSchema, step: z.string(), image: liveImage.nullable(), fields: reviewedFields.nullable(), updatedAt: timestamp,
})).max(500) });
export const MaterialsSchema = z.strictObject({ ownerId: z.string().min(1), materials: z.array(z.strictObject({
  applicationId: uuid,
  resume: z.strictObject({ documentId: uuid, mime: z.string(), createdAt: timestamp,
    changes: z.array(z.strictObject({ before: z.string(), after: z.string() })).max(64) }).nullable(),
  letter: z.strictObject(letterText).nullable(),
  // A submitted application's filled form, as the worker last typed it.
  answers: reviewedFields.nullable(),
})).max(500) });
export type PairingCreate = z.infer<typeof PairingCreateSchema>;
export type PairingGrant = z.infer<typeof PairingGrantSchema>;
export type PairRequest = z.infer<typeof PairRequestSchema>;
export type PairResponse = z.infer<typeof PairResponseSchema>;
export type RevisionCommand = z.infer<typeof RevisionCommandSchema>;
export type Revocation = z.infer<typeof RevocationSchema>;
export type WorkerSchedule = z.infer<typeof WorkerScheduleSchema>;
export type WorkerScheduleAck = z.infer<typeof WorkerScheduleAckSchema>;
export type WorkerSummary = z.infer<typeof WorkerSummarySchema>;
export type PairingSummary = z.infer<typeof PairingSummarySchema>;
export type WorkerList = z.infer<typeof WorkerListSchema>;
export type PollRequest = z.infer<typeof PollRequestSchema>;
export type LeaseRef = z.infer<typeof LeaseRefSchema>;
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type Lease = z.infer<typeof LeaseSchema>;
export type PollResponse = z.infer<typeof PollResponseSchema>;
export type EventRequest = z.infer<typeof EventRequestSchema>;
export type EventResponse = z.infer<typeof EventResponseSchema>;
export type RunCreate = z.infer<typeof RunCreateSchema>;
export type RunCommand = z.infer<typeof RunCommandSchema>;
export type ApplicationCommand = z.infer<typeof ApplicationCommandSchema>;
export type Run = z.infer<typeof RunSchema>;
export type ApplicationSummary = z.infer<typeof ApplicationSummarySchema>;
export type RunList = z.infer<typeof RunListSchema>;
export type SubmissionIntent = z.infer<typeof SubmissionIntentSchema>;
export type SubmissionIntentResponse = z.infer<typeof SubmissionIntentResponseSchema>;
export type ReceiptCommand = z.infer<typeof ReceiptCommandSchema>;
export type ReceiptResponse = z.infer<typeof ReceiptResponseSchema>;
export type ApplicationIdentity = z.infer<typeof ApplicationIdentitySchema>;
