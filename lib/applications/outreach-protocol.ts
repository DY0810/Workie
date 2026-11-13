import { z } from 'zod';
// `sending`: the worker took it and may have pressed Send; it is never sent a second time.
export const OUTREACH_STATES = ['draft', 'approved', 'sending', 'sent', 'skipped', 'failed'] as const;

/** A LinkedIn member profile, kept as `https://www.linkedin.com/in/<handle>` so one person is one URL. */
export const LinkedinProfileSchema = z.string().trim().max(400).transform((value, context) => {
  const match = /^https:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#\s]{1,200})\/?(?:[?#].*)?$/i.exec(value);
  if (!match) { context.addIssue({ code: 'custom', message: 'Not a LinkedIn profile URL.' }); return z.NEVER; }
  return `https://www.linkedin.com/in/${match[1].toLowerCase()}`;
});
export const OutreachPersonSchema = z.strictObject({
  name: z.string().trim().min(1).max(120), title: z.string().trim().max(300).nullable(), url: LinkedinProfileSchema,
});
const message = z.string().trim().min(1).max(4000);
const subject = z.string().trim().max(200);

export const OutreachItemSchema = z.strictObject({
  id: z.uuid(), company: z.string(),
  roles: z.array(z.strictObject({ applicationId: z.uuid(), role: z.string(), submittedAt: z.number().int() })),
  recruiter: OutreachPersonSchema.nullable(),
  overlap: z.string().nullable(), subject: z.string().nullable(), body: z.string().nullable(),
  state: z.enum(OUTREACH_STATES), reason: z.string().nullable(),
  createdAt: z.number().int(), sentAt: z.number().int().nullable(), threadUrl: z.string().nullable(),
});
export const OutreachListSchema = z.strictObject({
  ownerId: z.string(), template: z.string().nullable(), enabledAt: z.number().int().nullable(), items: z.array(OutreachItemSchema),
});
export const OutreachSettingsSchema = z.strictObject({ template: z.string().trim().min(1).max(8000) });
export const OutreachCommandSchema = z.discriminatedUnion('action', [
  // Keeps the applicant's edits on a draft without sending anything. A null body follows the template.
  z.strictObject({ action: z.literal('save'), recruiter: OutreachPersonSchema.nullable(), overlap: z.string().trim().max(1000).nullable(),
    subject: subject.nullable(), body: message.nullable() }),
  // The applicant read this exact text for this exact person: the worker sends it as is.
  z.strictObject({ action: z.literal('approve'), recruiter: OutreachPersonSchema, subject, body: message }),
  // The applicant sent it on LinkedIn themself.
  z.strictObject({ action: z.literal('mark-sent'), recruiter: OutreachPersonSchema, subject, body: message }),
  z.strictObject({ action: z.literal('skip') }),
  z.strictObject({ action: z.literal('reopen') }),
]);

export type OutreachItem = z.infer<typeof OutreachItemSchema>;
export type OutreachList = z.infer<typeof OutreachListSchema>;
export type OutreachCommand = z.infer<typeof OutreachCommandSchema>;
