import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ApplicationIdentitySchema, WORKER_PROTOCOL_VERSION, hash, timestamp, uuid } from './worker-protocol.ts';

export const disclosureAnswerKey = (question: string) =>
  `disclosure_${createHash('sha256').update(question).digest('hex').slice(0, 32)}`;

// A list is a multi-select form question's chosen options.
const value = z.union([z.string().trim().max(4000), z.boolean(), z.array(z.string().trim().min(1).max(300)).min(1).max(100)]);

export const ScreeningFactsSchema = z.strictObject({
  countries: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  degreeLevels: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  majors: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  availableTerms: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  expectedGraduation: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), month: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).nullable() }),
  workAuthorization: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  pay: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    amount: z.number().finite().nonnegative().nullable(), period: z.enum(['hour', 'year']).nullable() }),
});

export const ScreeningRequirementsSchema = z.strictObject({
  sourceUrl: z.url({ protocol: /^https?$/ }),
  officialDescription: z.string().trim().min(1).max(100_000),
  excerpts: z.array(z.string().trim().min(1).max(1000)).min(1).max(32),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(100),
  degreeLevels: z.array(z.string().trim().min(1).max(100)).max(20),
  majors: z.array(z.string().trim().min(1).max(160)).max(100),
  terms: z.array(z.string().trim().min(1).max(100)).max(20),
  graduationWindow: z.strictObject({ earliest: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), latest: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/) }).nullable(),
  authorizationRequired: z.boolean(), paid: z.boolean().nullable(),
  payFloor: z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), amount: z.number().finite().nonnegative(), period: z.enum(['hour', 'year']) }).nullable(),
});

export const ApplicationContextRequestSchema = z.strictObject({
  protocolVersion: z.literal(WORKER_PROTOCOL_VERSION), applicationId: uuid, fence: z.number().int().positive().safe(),
  expectedRevision: z.number().int().positive().safe(),
});

export const ApplicationDocumentSchema = z.strictObject({
  documentId: uuid, version: z.number().int().positive().safe(), sha256: hash,
  size: z.number().int().positive().max(10 * 1024 * 1024), mime: z.enum([
    'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]), path: z.string().regex(/^\/api\/worker\/applications\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}$/),
});

export const TailoredArtifactSchema = z.strictObject({
  documentId: uuid, version: z.number().int().positive().safe(), sourceDocumentId: uuid,
  sourceVersion: z.number().int().positive().safe(), sourceHash: hash,
  verificationManifestHash: hash, outputHash: hash,
});

export const ApplicationContextSchema = z.strictObject({
  protocolVersion: z.literal(WORKER_PROTOCOL_VERSION), applicationId: uuid, runId: uuid, ownerId: z.string().min(1).max(256),
  policyRevision: z.number().int().positive().safe(), identity: ApplicationIdentitySchema,
  coverLetterAllowed: z.boolean().default(false),
  submitWithoutReview: z.boolean().default(false),
  track: z.enum(['engineering', 'design']).default('engineering'),
  // The cover letter written when the form was filled; the worker submits this one, not a new draft.
  letter: z.strictObject({ introduction: z.string().min(1).max(900), body: z.array(z.string().min(1).max(900)).min(1).max(4),
    conclusion: z.string().min(1).max(900), companyParagraph: z.string().min(1).max(900) }).nullable().default(null),
  profileRevision: z.number().int().nonnegative().safe(),
  company: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(300),
  applicationUrl: z.url({ protocol: /^https?$/ }), facts: ScreeningFactsSchema,
  requirements: ScreeningRequirementsSchema, answers: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), value).superRefine((items, ctx) => {
    if (Object.keys(items).length > 64) ctx.addIssue({ code: 'custom', message: 'Too many answers.' });
  }),
  documents: z.record(z.string().regex(/^[a-z][A-Za-z0-9_-]{0,63}$/), ApplicationDocumentSchema).superRefine((items, ctx) => {
    if (Object.keys(items).length > 16) ctx.addIssue({ code: 'custom', message: 'Too many documents.' });
  }),
  tailoredArtifact: TailoredArtifactSchema.nullable().default(null),
  manifestHash: hash.nullable(), artifactHashes: z.array(hash).max(16), createdAt: timestamp,
});

export type ApplicationContextRequest = z.infer<typeof ApplicationContextRequestSchema>;
export type ScreeningRequirements = z.infer<typeof ScreeningRequirementsSchema>;
export type ApplicationDocument = z.infer<typeof ApplicationDocumentSchema>;
export type ApplicationContext = z.infer<typeof ApplicationContextSchema>;
