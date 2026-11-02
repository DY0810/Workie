import { z } from 'zod';
import { BASES, POSTED_WINDOWS, TABS, SHARED_VOCAB, vocab } from '../params.ts';

export const PolicyFiltersSchema = z.strictObject({
  tab: z.enum(TABS), basis: z.enum(BASES).nullable(), posted: z.enum(POSTED_WINDOWS).nullable(),
  type: z.array(z.enum(['full-time', 'part-time', 'internship', 'freelance', 'contract'])).max(5),
  pay: z.array(z.enum(SHARED_VOCAB.pay)).max(3),
  mode: z.array(z.enum(SHARED_VOCAB.mode)).max(3),
  season: z.array(z.enum(['summer', 'fall', 'winter', 'spring'])).max(4),
  level: z.array(z.enum(['entry', 'junior', 'mid', 'senior+'])).max(4),
  badge: z.string().regex(/^[a-z0-9-]{1,32}$/).nullable(),
}).superRefine((filters, ctx) => {
  if ((filters.tab === 'design') !== (filters.basis !== null)) {
    ctx.addIssue({ code: 'custom', path: ['basis'], message: 'Employment basis applies only to the design board.' });
  }
  for (const key of ['type', 'pay', 'mode', 'season', 'level'] as const) {
    const allowed = vocab(filters.tab, key, filters.basis);
    if (filters[key].some((value) => !allowed.includes(value)) || new Set(filters[key]).size !== filters[key].length) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'Filter does not match this board or contains duplicates.' });
    }
  }
});

export const PolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  filters: PolicyFiltersSchema,
  sourceRestrictions: z.array(z.string().trim().min(1).max(200)).max(100),
  // email_recruiters and auto_send_recruiter_email are retired: nothing reads them, and they stay
  // in the enum only so stored policies that contain them still parse with the same hash.
  // submit_without_review sends a filled form with only short answers and no cover letter without the Apply click.
  actions: z.array(z.enum(['read_jobs', 'tailor_documents', 'fill_forms', 'submit', 'email_recruiters', 'auto_send_recruiter_email', 'submit_without_review'])).max(7),
  destinations: z.array(z.string().regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)).max(100),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(100),
  targetRoles: z.array(z.string().trim().min(1).max(300)).max(100),
  employerBlocklist: z.array(z.string().trim().min(1).max(300)).max(100),
  degreeEligibility: z.array(z.string().trim().min(1).max(300)).max(100),
  termEligibility: z.array(z.string().trim().min(1).max(300)).max(100),
  payFloor: z.strictObject({
    amount: z.number().min(0).max(1_000_000_000), currency: z.string().regex(/^[A-Z]{3}$/),
    period: z.enum(['hour', 'day', 'week', 'month', 'year', 'project']),
  }).nullable(),
  undisclosedPay: z.enum(['include', 'exclude', 'ask']),
  documentKinds: z.array(z.enum(['resume', 'cover_letter', 'transcript', 'certificate', 'portfolio'])).max(5),
  disclosure: z.enum(['confirmed_only', 'ask_each_sensitive']),
  accountPolicy: z.enum(['skip_new_accounts', 'existing_only', 'allow_new_with_consent']),
  privacy: z.enum(['local_inference_only', 'fully_local', 'approved_remote']),
  remoteProviderConsent: z.boolean(),
  allowedProviders: z.array(z.string().trim().min(1).max(200)).max(20),
  fallbackOrder: z.array(z.string().trim().min(1).max(200)).max(20),
  budget: z.strictObject({
    currency: z.string().regex(/^[A-Z]{3}$/),
    perRequest: z.number().min(0).max(1000), perRun: z.number().min(0).max(10_000),
    perDay: z.number().min(0).max(10_000), allowUnknownCost: z.literal(false),
  }),
  dailyApplicationCap: z.number().int().min(1).max(1000),
  perEmployerCap: z.number().int().min(1).max(100),
  reapplication: z.strictObject({ allowed: z.boolean(), minimumDays: z.number().int().min(1).max(3650) }),
  expiresAt: z.iso.datetime().nullable(),
}).superRefine((p, ctx) => {
  if (p.privacy !== 'approved_remote' && (p.remoteProviderConsent || p.fallbackOrder.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['privacy'], message: 'Local inference forbids remote consent or fallback.' });
  }
  if (p.privacy === 'approved_remote' && !p.remoteProviderConsent) {
    ctx.addIssue({ code: 'custom', path: ['remoteProviderConsent'], message: 'Remote inference needs explicit consent.' });
  }
  if (p.fallbackOrder.some((provider) => !p.allowedProviders.includes(provider))) {
    ctx.addIssue({ code: 'custom', path: ['fallbackOrder'], message: 'Fallback must be explicitly allowed.' });
  }
  if (p.budget.perRequest > p.budget.perRun || p.budget.perRun > p.budget.perDay) {
    ctx.addIssue({ code: 'custom', path: ['budget'], message: 'Request budget must fit run and daily budgets.' });
  }
  if (p.actions.includes('submit_without_review') && !p.actions.includes('submit')) {
    ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Submitting without review needs Submit on.' });
  }
  if (p.actions.includes('auto_send_recruiter_email') && !p.actions.includes('email_recruiters')) {
    ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Sending recruiter email automatically needs recruiter email on.' });
  }
});
export type Policy = z.infer<typeof PolicySchema>;
export function createEmptyPolicy(): Policy {
  return {
    schemaVersion: 1, actions: [], destinations: [], countries: [], targetRoles: [], employerBlocklist: [],
    filters: { tab: 'engineering', basis: null, posted: null, type: [], pay: [], mode: [], season: [], level: [], badge: null },
    sourceRestrictions: [], degreeEligibility: [], termEligibility: [], payFloor: null, undisclosedPay: 'ask',
    documentKinds: [], disclosure: 'confirmed_only', accountPolicy: 'skip_new_accounts',
    privacy: 'local_inference_only', remoteProviderConsent: false, allowedProviders: [], fallbackOrder: [],
    budget: { currency: 'USD', perRequest: 0, perRun: 0, perDay: 0, allowUnknownCost: false },
    dailyApplicationCap: 10, perEmployerCap: 1, reapplication: { allowed: false, minimumDays: 365 },
    expiresAt: null,
  };
}
const command = {
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  requestId: z.uuid(),
};
export const PolicySaveSchema = z.strictObject({ ...command, policy: PolicySchema });
export const PolicyCommandSchema = z.strictObject({
  ...command, action: z.enum(['enable', 'disable']),
  acceptedPolicyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type PolicySave = z.infer<typeof PolicySaveSchema>;
export type PolicyCommand = z.infer<typeof PolicyCommandSchema>;
export type PolicyResponse = {
  revision: number; policy: Policy; enabled: boolean; policyVersion: number;
  policyHash: string | null; acceptedPolicyVersion: number | null; acceptedPolicyHash: string | null;
  acceptedAt: string | null; runnerAvailable: boolean;
};
