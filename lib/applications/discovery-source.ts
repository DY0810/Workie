import { createHash } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { driver, type ReadDb } from '../db/index.ts';
import { postings, postingSources } from '../db/schema.ts';
import { cutoffTimestamp } from '../dedupe.ts';
import { effectiveAt, notBlockedEmployer, userFilters } from '../query.ts';
import { PolicySchema, type Policy } from './policy.ts';
import { resolveApplicationIdentity, type IdentitySource, type OfficialIdentity } from './application-identity.ts';

export const MAX_SNAPSHOT_POSTINGS = 10_000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export type CandidatePosting = {
  postingId: number; canonicalUrl: string; company: string; title: string;
  country: string | null; location: string | null; postedAt: number; effectiveAt: number;
  paid: boolean | null; payRateMin: number | null; payRateMax: number | null;
  payRatePeriod: string | null; payCurrencySymbol: string | null; sources: IdentitySource[];
};
export type DiscoveryCandidate = {
  targetKey: string; identity: OfficialIdentity | null;
  identityStatus: 'resolved' | 'unresolved' | 'conflict'; officialUrl: string | null;
  officialPostingId: number | null; officialContentHash: string | null;
  aliases: string[]; postings: CandidatePosting[];
  disposition: 'candidate' | 'needs_question' | 'blocked'; reasons: string[];
};
export type SnapshotScope = Pick<Policy, 'filters' | 'countries' | 'sourceRestrictions' | 'targetRoles' |
  'employerBlocklist' | 'payFloor' | 'undisclosedPay'> & {
  corpus: 'collected_postings'; excludeDelisted: true; effectiveAtCutoff: number;
  pagination: false; publicGeographyCeiling: false; publicSeniorityCeiling: false;
  laterOfficialScreen: string[];
};
export type CandidateSnapshot = {
  schemaVersion: 2; capturedAt: number; scope: SnapshotScope; postingCount: number; candidates: DiscoveryCandidate[];
};

export type OfficialPostingContent = {
  canonicalUrl: string; company: string; title: string; country: string | null; location: string | null;
  description: string | null; sourceFields: unknown;
};

const sourceSchema = z.array(z.strictObject({
  source: z.string(), sourceUrl: z.string(), publisherId: z.string().nullable(),
}));
const selection = {
  postingId: postings.id, canonicalUrl: postings.canonicalUrl, company: postings.company, title: postings.title,
  country: postings.country, location: postings.location, postedAt: sql<number>`${postings.postedAt}`, effectiveAt,
  paid: postings.paid, payRateMin: postings.payRateMin, payRateMax: postings.payRateMax,
  payRatePeriod: postings.payRatePeriod, payCurrencySymbol: postings.payCurrencySymbol,
  // Qualify the outer column explicitly: Drizzle strips qualifiers in selected expressions.
  sources: sql<string>`(select json_group_array(json_object(
    'source', s.source, 'sourceUrl', s.source_url, 'publisherId', s.publisher_id
  )) from (select ${postingSources.source}, ${postingSources.sourceUrl}, ${postingSources.publisherId}
    from ${postingSources} where ${postingSources.postingId} = "postings"."id"
    order by ${postingSources.source}, ${postingSources.sourceUrl}, ${postingSources.publisherId}) s)`,
};

function assertBytes(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Discovery snapshot byte limit exceeded (${MAX_SNAPSHOT_BYTES})`);
  }
}

async function capturePostings(db: ReadDb, predicate: SQL, limit: number): Promise<CandidatePosting[]> {
  const rows = await driver(db).select(selection).from(postings).where(predicate)
    .orderBy(asc(postings.id)).limit(limit + 1).all();
  if (rows.length > limit) throw new Error(`Discovery snapshot posting limit exceeded (${limit})`);
  assertBytes(rows);
  return rows.map((row) => ({ ...row, sources: sourceSchema.parse(JSON.parse(row.sources)) }));
}

const legacyIds = z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(1000)
  .refine((ids) => new Set(ids).size === ids.length, 'Posting IDs must be unique');
export async function captureLegacyPostings(db: ReadDb, postingIds: number[]): Promise<CandidatePosting[]> {
  const ids = legacyIds.parse(postingIds);
  const captured = await capturePostings(db, inArray(postings.id, ids), 1000);
  assertBytes(captured);
  return captured;
}

const label = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const roleLabel = (value: string) => label(value).replace(/\bengineering\b/g, 'engineer');
const identityKey = (identity: OfficialIdentity) => JSON.stringify([identity.ats, identity.tenant, identity.requisition]);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const officialContentHash = (content: OfficialPostingContent) => hash({
  ...content, description: content.description ?? null, sourceFields: content.sourceFields ?? null,
});

function screen(candidate: DiscoveryCandidate, policy: Policy) {
  const blocked = new Set<string>(), questions = new Set<string>();
  if (candidate.identityStatus === 'conflict') blocked.add('official_identity_conflict');
  if (candidate.identityStatus === 'unresolved') questions.add('official_identity_unresolved');
  if (candidate.officialUrl && !policy.destinations.includes(new URL(candidate.officialUrl).hostname.toLowerCase())) {
    blocked.add('destination_restricted');
  }
  if (policy.sourceRestrictions.length && !candidate.postings.some((p) =>
    p.sources.some((source) => policy.sourceRestrictions.includes(source.source)))) blocked.add('source_restricted');
  for (const p of candidate.postings) {
    if (policy.countries.length) {
      if (!p.country) questions.add('country_unknown');
      else if (!policy.countries.includes(p.country)) blocked.add('country_restricted');
    }
    if (policy.employerBlocklist.some((company) => label(company) === label(p.company))) blocked.add('employer_blocked');
    if (policy.targetRoles.length && !policy.targetRoles.some((role) => roleLabel(p.title).includes(roleLabel(role)))) {
      blocked.add('role_not_selected');
    }
    if (p.paid === null) {
      if (policy.undisclosedPay === 'exclude') blocked.add('pay_undisclosed_excluded');
      if (policy.undisclosedPay === 'ask') questions.add('pay_undisclosed');
    }
    const floor = policy.payFloor;
    if (!floor) continue;
    if (p.paid === false) {
      if (floor.amount > 0) blocked.add('pay_below_floor');
      continue;
    }
    const min = p.payRateMin, max = p.payRateMax;
    // The corpus keeps only the symbol, and every dollar (CA$, A$, S$...) is stored as '$'. So '$' is USD only on a
    // US posting and '£' is GBP only on a GB one; anywhere else the currency stays unverified.
    const currency = p.payCurrencySymbol === '€' ? 'EUR' : p.payCurrencySymbol === '$' && p.country === 'US' ? 'USD'
      : p.payCurrencySymbol === '£' && p.country === 'GB' ? 'GBP' : null;
    if ((min !== null && (!Number.isFinite(min) || min < 0)) ||
        (max !== null && (!Number.isFinite(max) || max < 0)) || (min !== null && max !== null && min > max)) {
      questions.add('pay_evidence_invalid');
    } else if (currency !== floor.currency || p.payRatePeriod !== floor.period) {
      questions.add('pay_currency_or_period_unverified');
    } else if (max !== null && max < floor.amount) blocked.add('pay_below_floor');
    else if (min === null || min < floor.amount) questions.add('pay_floor_unverified');
  }
  candidate.disposition = blocked.size ? 'blocked' : questions.size ? 'needs_question' : 'candidate';
  candidate.reasons = [...new Set([...candidate.reasons, ...blocked, ...questions])].sort();
}

export async function captureCandidateSnapshot(db: ReadDb, policyInput: unknown, now: number = Date.now()): Promise<CandidateSnapshot> {
  const policy = PolicySchema.parse(policyInput);
  z.number().int().min(0).max(8_640_000_000_000_000).parse(now);
  const captured = await capturePostings(db, and(
    eq(postings.track, policy.filters.tab), isNull(postings.delistedAt), notBlockedEmployer,
    gte(effectiveAt, cutoffTimestamp(now)), ...userFilters(policy.filters, now),
  )!, MAX_SNAPSHOT_POSTINGS);

  // Union exact official identities/canonical URLs, including conflicts. A clean duplicate
  // must not bypass a conflicting sibling. Numeric corpus IDs never define application identity.
  const parents = captured.map((_, index) => index), seen = new Map<string, number>();
  function root(index: number): number {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
    return index;
  }
  captured.forEach((p, index) => {
    const keys = new Set([`url:${p.canonicalUrl}`]);
    for (const url of [p.canonicalUrl, ...p.sources.map((source) => source.sourceUrl)]) {
      const identity = resolveApplicationIdentity(url, []).identity;
      if (identity) keys.add(`official:${identityKey(identity)}`);
    }
    for (const key of keys) {
      const prior = seen.get(key);
      if (prior === undefined) seen.set(key, index);
      else parents[root(index)] = root(prior);
    }
  });
  const groups = new Map<number, CandidatePosting[]>();
  captured.forEach((p, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  });
  const carriers = new Map<DiscoveryCandidate, number[]>();
  const candidates = [...groups.values()].map((group): DiscoveryCandidate => {
    const resolution = resolveApplicationIdentity(group[0].canonicalUrl, group.flatMap((p) => [
      ...p.sources, { source: '', sourceUrl: p.canonicalUrl, publisherId: null },
    ]));
    // The postings that carry the official URL themselves, so the worker's re-resolution of one (application-context.ts) agrees.
    const carrierIds = resolution.officialUrl
      ? group.filter((posting) => [posting.canonicalUrl, ...posting.sources.map((source) => source.sourceUrl)].some((url) =>
        resolveApplicationIdentity(url, []).officialUrl === resolution.officialUrl)).map((posting) => posting.postingId)
      : [];
    const candidate: DiscoveryCandidate = {
      targetKey: resolution.identity ? `official:${identityKey(resolution.identity)}` :
        `${resolution.status}:${hash(resolution.aliases)}`,
      identity: resolution.identity, identityStatus: resolution.status, officialUrl: resolution.officialUrl,
      officialPostingId: carrierIds[0] ?? null, officialContentHash: null,
      aliases: resolution.aliases, postings: group, disposition: 'candidate', reasons: resolution.reasons,
    };
    carriers.set(candidate, carrierIds);
    screen(candidate, policy);
    return candidate;
  });
  const officialIds = [...carriers.values()].flat();
  if (officialIds.length) {
    const rows = await driver(db).select({
      postingId: postings.id, canonicalUrl: postings.canonicalUrl, company: postings.company, title: postings.title,
      country: postings.country, location: postings.location, description: postings.description, sourceFields: postings.sourceFields,
    }).from(postings).where(inArray(postings.id, officialIds)).all();
    assertBytes(rows);
    const byId = new Map(rows.map((row) => [row.postingId, row]));
    for (const candidate of candidates) {
      // A list row collected before the board's own row has no description: the official posting is the first carrier with one.
      candidate.officialPostingId = carriers.get(candidate)!.find((id) => byId.get(id)?.description?.trim()) ?? candidate.officialPostingId;
      const row = candidate.officialPostingId === null ? undefined : byId.get(candidate.officialPostingId);
      if (row?.description?.trim()) candidate.officialContentHash = officialContentHash({
        canonicalUrl: row.canonicalUrl, company: row.company, title: row.title,
        country: row.country, location: row.location, description: row.description, sourceFields: row.sourceFields,
      });
      if (candidate.identityStatus === 'resolved' && !candidate.officialContentHash) {
        candidate.disposition = 'blocked';
        candidate.reasons = [...new Set([...candidate.reasons, 'official_content_unavailable'])].sort();
      }
    }
  }
  const snapshot: CandidateSnapshot = {
    schemaVersion: 2, capturedAt: now, postingCount: captured.length, candidates,
    scope: {
      corpus: 'collected_postings', filters: policy.filters, countries: policy.countries,
      sourceRestrictions: policy.sourceRestrictions, targetRoles: policy.targetRoles,
      employerBlocklist: policy.employerBlocklist, payFloor: policy.payFloor, undisclosedPay: policy.undisclosedPay,
      excludeDelisted: true, effectiveAtCutoff: cutoffTimestamp(now), pagination: false,
      publicGeographyCeiling: false, publicSeniorityCeiling: false,
      laterOfficialScreen: [
        'official_identity_and_active_requisition', 'country_location_and_role', 'compensation',
        'degree_and_term_eligibility', 'required_questions_and_documents', 'destination_and_action_consent',
        'account_privacy_and_provider_policy', 'duplicate_cooldown_and_caps', 'verified_employer_receipt_after_submission',
      ],
    },
  };
  assertBytes(snapshot);
  return snapshot;
}
