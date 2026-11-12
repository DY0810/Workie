import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import { drizzle as sqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as libsql } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, type ReadDb } from '../db/index.ts';
import * as schema from '../db/schema.ts';
import { normalizeCompany } from '../normalize.ts';
import { listPostings } from '../query.ts';
import { createEmptyPolicy, type Policy } from './policy.ts';
import { captureCandidateSnapshot, captureLegacyPostings, MAX_SNAPSHOT_POSTINGS } from './discovery-source.ts';

const NOW = Date.UTC(2026, 8, 21, 12);
const DAY = 86_400_000;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture(kind: 'sqlite' | 'libsql') {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-source-'));
  const path = join(dir, 'corpus.db');
  const connection = new Database(path);
  connection.pragma('journal_mode = WAL');
  const writer = sqlite(connection, { schema });
  migrate(writer, { migrationsFolder: MIGRATIONS_DIR });
  const queries: string[] = [], params: unknown[][] = [];
  const logger = { logQuery(query: string, values: unknown[]) { queries.push(query); params.push(values); } };
  const client = kind === 'libsql' ? createClient({ url: `file:${path}` }) : null;
  const db: ReadDb = client ? libsql(client, { schema, logger }) : sqlite(connection, { schema, logger });
  cleanups.push(() => { client?.close(); connection.close(); rmSync(dir, { recursive: true, force: true }); });
  function add(id: number, over: Partial<typeof schema.postings.$inferInsert> = {}, req = String(id)) {
    const url = `https://job-boards.greenhouse.io/acme/jobs/${req}`;
    writer.insert(schema.postings).values({
      id, dedupeKey: `fixture-${id}`, canonicalUrl: url, postedAt: new Date(NOW), firstSeenRun: 'SEED_RUN',
      company: 'Acme', companyNorm: 'acme', title: 'Software Engineer', titleNorm: 'software engineer',
      locationKey: 'US', country: 'US', location: 'California', track: 'engineering',
      seniority: 'entry', paid: true, description: 'Fixture description', ...over,
    }).run();
    writer.insert(schema.postingSources).values({
      postingId: id, source: 'greenhouse', sourceUrl: url, publisherId: req, postedAt: new Date(NOW),
      sourcePriority: 1, lastSeenRun: 'fixture',
    }).run();
  }
  return { db, writer, connection, queries, params, add };
}
const policy = (over: Partial<Policy> = {}): Policy => ({
  ...createEmptyPolicy(), destinations: ['job-boards.greenhouse.io'], undisclosedPay: 'include', ...over,
});

// Turso bills every index entry a query walks: the capture has to seek the 60-day window, not walk the whole track.
it('captures candidates from the 60-day window of the board index, not every live posting in the track', async () => {
  const f = fixture('sqlite');
  f.add(1);
  await captureCandidateSnapshot(f.db, policy(), NOW);
  const at = f.queries.findIndex((query) => /from "postings"/.test(query) && /order by "postings"."id"/.test(query));
  const plan = f.connection.prepare(`explain query plan ${f.queries[at]}`).all(...(f.params[at] as unknown[])) as { detail: string }[];
  expect(plan.map((row) => row.detail).join('\n')).toMatch(/SEARCH postings USING (COVERING )?INDEX postings_board_idx \(track=\? AND delisted_at=\? AND <expr>>\?/);
});

describe.each(['sqlite', 'libsql'] as const)('%s consistent compact capture', (kind) => {
  it('captures all 601 native requisitions plus duplicate evidence in one SELECT without offsets or bodies', async () => {
    const f = fixture(kind);
    f.connection.transaction(() => {
      for (let id = 1; id <= 601; id++) f.add(id, { description: 'OMITTED_BODY', sourceFields: { location: 'OMITTED_SOURCE' } });
      f.add(602, {}, '1');
      f.add(603, {}, '601');
    })();
    const snapshot = await captureCandidateSnapshot(f.db, policy(), NOW);
    expect(snapshot.capturedAt).toBe(NOW);
    expect(snapshot.postingCount).toBe(603);
    expect(snapshot.candidates).toHaveLength(601);
    expect(new Set(snapshot.candidates.map((c) => c.targetKey)).size).toBe(601);
    expect(snapshot.candidates.every((c) => c.disposition === 'candidate')).toBe(true);
    expect(snapshot.candidates.find((c) => c.identity?.requisition === '1')?.postings).toHaveLength(2);
    expect(f.queries).toHaveLength(2);
    expect(f.queries[0]).toMatch(/json_group_array/i);
    expect(f.queries[0]).not.toMatch(/\boffset\b|description|source_fields/i);
    expect(f.queries[1]).toMatch(/description|source_fields/i);
    expect(JSON.stringify(snapshot)).not.toContain('OMITTED');
    expect(snapshot.scope).toMatchObject({ pagination: false, publicGeographyCeiling: false, publicSeniorityCeiling: false });
    const publicRows = await listPostings(f.db, { ...policy().filters, page: 1, job: null }, NOW);
    // Every fixture posting is a Greenhouse role, which Applications lists instead of the board.
    expect(publicRows).toHaveLength(0);
  });

  it('names the posting that carries the official embed URL, which the worker re-resolves from that posting alone', async () => {
    const f = fixture(kind);
    const embed = 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1';
    f.add(1);
    f.add(2, { canonicalUrl: embed }, '1');
    const [candidate] = (await captureCandidateSnapshot(f.db, policy(), NOW)).candidates;
    expect([candidate.officialUrl, candidate.officialPostingId, candidate.disposition]).toEqual([embed, 2, 'candidate']);
  });

  it('takes the official content from the board row when a list row for the same role was collected first', async () => {
    const f = fixture(kind);
    f.add(1, { canonicalUrl: 'https://go.example.test/1', description: null });
    f.add(2, {}, '1');
    const [candidate] = (await captureCandidateSnapshot(f.db, policy(), NOW)).candidates;
    expect([candidate.officialPostingId, candidate.disposition, candidate.reasons]).toEqual([2, 'candidate', []]);
  });

  it('uses only explicit SQL filters, live state and fixed effective age, not public geography/seniority', async () => {
    const f = fixture(kind);
    f.add(1, { seniority: 'senior+', country: 'DE', workMode: 'onsite' });
    f.add(2, { postedAt: new Date(NOW - 61 * DAY) });
    f.add(3, { postedAt: new Date(NOW - 400 * DAY), firstSeenRun: new Date(NOW - 1000).toISOString() });
    f.add(4, { delistedAt: new Date(NOW) });
    f.add(5, { track: 'design' });
    f.add(6, { postedAt: new Date(NOW - 60 * DAY) });
    const result = await captureCandidateSnapshot(f.db, policy(), NOW);
    expect(result.candidates.flatMap((c) => c.postings.map((p) => p.postingId))).toEqual([1, 3, 6]);
    expect(result.candidates[1].postings[0].effectiveAt).toBe(NOW - 1000);
    expect((await listPostings(f.db, { ...policy().filters, job: null, page: 1 }, NOW)).map((p) => p.id)).not.toContain(1);
    const narrowed = policy();
    narrowed.filters = { ...narrowed.filters, posted: 'day', level: ['entry'] };
    expect((await captureCandidateSnapshot(f.db, narrowed, NOW)).postingCount).toBe(1);
  });

  it('retains country, role, source and employer dispositions instead of dropping their evidence', async () => {
    const f = fixture(kind);
    f.add(1, { country: 'DE' });
    f.add(2, { country: null });
    f.add(3, { company: '  BLOCKED   CO ' });
    f.add(4, { title: 'Designer' });
    f.add(5);
    f.writer.update(schema.postingSources).set({ source: 'other' }).where(eq(schema.postingSources.postingId, 5)).run();
    f.add(6);
    const result = await captureCandidateSnapshot(f.db, policy({
      countries: ['US'], targetRoles: ['Software Engineer'], employerBlocklist: ['blocked co'],
      sourceRestrictions: ['greenhouse'],
    }), NOW);
    expect(result.candidates.map((c) => c.disposition)).toEqual([
      'blocked', 'needs_question', 'blocked', 'blocked', 'blocked', 'candidate',
    ]);
    expect(result.candidates.slice(0, 5).every((c) => c.reasons.length > 0)).toBe(true);
  });

  it('never captures a blocked employer, whatever the policy says', async () => {
    const f = fixture(kind);
    f.add(1, { company: 'hussh 🤫', companyNorm: normalizeCompany('hussh 🤫') });
    f.add(2);
    const snapshot = await captureCandidateSnapshot(f.db, policy(), NOW);
    expect(snapshot.postingCount).toBe(1);
    expect(snapshot.candidates.flatMap((c) => c.postings.map((p) => p.company))).toEqual(['Acme']);
  });

  it('matches Software Engineering Intern to an approved Software Engineer role', async () => {
    const f = fixture(kind);
    f.add(1, { title: 'Software Engineering Intern' });
    f.add(2, { title: 'Design Engineering Intern' });
    const result = await captureCandidateSnapshot(f.db, policy({ targetRoles: ['Software Engineer'] }), NOW);
    expect(result.candidates.map((candidate) => candidate.disposition)).toEqual(['candidate', 'blocked']);
    expect(result.candidates[1].reasons).toContain('role_not_selected');
  });

  it('blocks resolved applications outside the explicitly approved destination hosts', async () => {
    const f = fixture(kind);
    f.add(1);
    const result = await captureCandidateSnapshot(f.db, policy({ destinations: ['careers.example.test'] }), NOW);
    expect(result.candidates[0]).toMatchObject({ disposition: 'blocked', reasons: ['destination_restricted'] });
  });

  it('blocks resolved applications without official job content', async () => {
    const f = fixture(kind);
    f.add(1, { description: null });
    const result = await captureCandidateSnapshot(f.db, policy(), NOW);
    expect(result.candidates[0]).toMatchObject({ disposition: 'blocked', reasons: ['official_content_unavailable'] });
  });

  it('preserves paid/unpaid/unknown and does not invent dollar currency or annual conversion', async () => {
    const f = fixture(kind);
    f.add(1, { paid: null });
    f.add(2, { paid: false });
    f.add(3, { payRateMin: 100, payRatePeriod: 'hour', payCurrencySymbol: '$' });
    f.add(4, { payRateMin: 100, payRatePeriod: 'year', payCurrencySymbol: '€' });
    f.add(5, { payRateMin: 10, payRateMax: 30, payRatePeriod: 'hour', payCurrencySymbol: '€' });
    f.add(6, { payRateMin: 30, payRatePeriod: 'hour', payCurrencySymbol: '€' });
    f.add(7, { payRateMin: 10, payRateMax: 15, payRatePeriod: 'hour', payCurrencySymbol: '€' });
    f.add(8);
    const floor = policy({ payFloor: { amount: 20, currency: 'EUR', period: 'hour' } });
    expect((await captureCandidateSnapshot(f.db, floor, NOW)).candidates.map((c) => c.disposition)).toEqual([
      'needs_question', 'blocked', 'needs_question', 'needs_question', 'needs_question', 'candidate', 'blocked', 'needs_question',
    ]);
    for (const [undisclosedPay, expected] of [
      ['include', 'candidate'], ['ask', 'needs_question'], ['exclude', 'blocked'],
    ] as const) {
      const result = await captureCandidateSnapshot(f.db, policy({ undisclosedPay }), NOW);
      expect(result.candidates[0].disposition).toBe(expected);
      expect(result.candidates[7].disposition).toBe('candidate');
      expect(result.candidates[0].postings[0].paid).toBeNull();
      expect(result.candidates[1].postings[0].paid).toBe(false);
    }
  });

  it('retains unresolved and conflicts; one conflicting duplicate cannot become an eligible alternative', async () => {
    const f = fixture(kind);
    f.add(1);
    f.add(2, {}, '1');
    f.writer.update(schema.postingSources).set({ publisherId: '999' })
      .where(eq(schema.postingSources.postingId, 2)).run();
    f.add(3, { canonicalUrl: 'https://unsupported.test/job/3' });
    f.writer.delete(schema.postingSources).where(eq(schema.postingSources.postingId, 3)).run();
    const result = await captureCandidateSnapshot(f.db, policy(), NOW);
    expect(result.postingCount).toBe(3);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ identityStatus: 'conflict', disposition: 'blocked', identity: null });
    expect(result.candidates[0].postings).toHaveLength(2);
    expect(result.candidates[1]).toMatchObject({ identityStatus: 'unresolved', disposition: 'needs_question' });
  });

  it('does not infer GBP from a pound symbol on a US posting', async () => {
    const f = fixture(kind);
    f.add(1, { payRateMin: 30, payRatePeriod: 'hour', payCurrencySymbol: '£' });
    const result = await captureCandidateSnapshot(f.db, policy({
      payFloor: { amount: 20, currency: 'GBP', period: 'hour' },
    }), NOW);
    expect(result.candidates[0].disposition).toBe('needs_question');
    expect(result.candidates[0].reasons).toContain('pay_currency_or_period_unverified');
  });

  it('reads a dollar floor only on US postings and a pound floor only on GB postings', async () => {
    const f = fixture(kind);
    f.add(1, { payRateMin: 40, payRateMax: 60, payRatePeriod: 'hour', payCurrencySymbol: '$' });
    f.add(2, { payRateMin: 40, payRatePeriod: 'hour', payCurrencySymbol: '$', country: 'CA' });
    f.add(3, { payRateMin: 40, payRatePeriod: 'hour', payCurrencySymbol: '$', country: null });
    f.add(4, { payRateMin: 10, payRateMax: 15, payRatePeriod: 'hour', payCurrencySymbol: '$' });
    const usd = await captureCandidateSnapshot(f.db, policy({ payFloor: { amount: 20, currency: 'USD', period: 'hour' } }), NOW);
    expect(usd.candidates.map((c) => c.disposition)).toEqual(['candidate', 'needs_question', 'needs_question', 'blocked']);
    expect(usd.candidates[1].reasons).toEqual(['pay_currency_or_period_unverified']);
    const g = fixture(kind);
    g.add(1, { payRateMin: 30, payRatePeriod: 'hour', payCurrencySymbol: '£', country: 'GB' });
    const gbp = await captureCandidateSnapshot(g.db, policy({ payFloor: { amount: 20, currency: 'GBP', period: 'hour' } }), NOW);
    expect(gbp.candidates[0].disposition).toBe('candidate');
  });

  it('rejects malformed filters before touching the database, including pagination and cross-tab values', async () => {
    const f = fixture(kind);
    for (const filters of [
      { mode: ['hybrdi'] }, { tab: 'invalid' }, { pay: ['unknown', 'unknown'] },
      { page: 2 }, { type: ['contract'] }, { basis: 'freelance' }, { badge: 'a" OR 1=1' },
    ]) {
      await expect(captureCandidateSnapshot(f.db, { ...policy(), filters: { ...policy().filters, ...filters } }, NOW))
        .rejects.toThrow();
    }
    await expect(captureCandidateSnapshot(f.db, policy(), NaN)).rejects.toThrow();
    expect(f.queries).toHaveLength(0);
  });

  it('fails the entire capture at 10000+1 and at the 16 MiB serialized byte bound', async () => {
    const f = fixture(kind);
    f.connection.transaction(() => {
      for (let id = 1; id <= MAX_SNAPSHOT_POSTINGS; id++) f.add(id);
    })();
    expect((await captureCandidateSnapshot(f.db, policy(), NOW)).postingCount).toBe(MAX_SNAPSHOT_POSTINGS);
    f.add(MAX_SNAPSHOT_POSTINGS + 1);
    await expect(captureCandidateSnapshot(f.db, policy(), NOW)).rejects.toThrow(/posting.*limit|10000/i);
    f.writer.delete(schema.postingSources).run();
    f.writer.delete(schema.postings).run();
    f.add(1, { company: 'x'.repeat(16 * 1024 * 1024) });
    await expect(captureCandidateSnapshot(f.db, policy(), NOW)).rejects.toThrow(/byte|16777216/i);
    // Raw read fits, but the final artifact repeats the URL as a retained alias. UTF-8,
    // not JS code-unit length, defines the immutable artifact's resource boundary.
    f.writer.update(schema.postings).set({
      company: 'Acme', canonicalUrl: `https://unsupported.test/${'字'.repeat(3 * 1024 * 1024)}`,
    }).run();
    await expect(captureCandidateSnapshot(f.db, policy(), NOW)).rejects.toThrow(/byte|16777216/i);
  }, 30_000);

  it('legacy lookup captures explicit IDs including delisted/old/other-track rows with one compact read', async () => {
    const f = fixture(kind);
    f.add(1, { delistedAt: new Date(NOW), track: 'design', postedAt: new Date(0) });
    expect((await captureLegacyPostings(f.db, [1, 999])).map((p) => p.postingId)).toEqual([1]);
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]).not.toMatch(/\boffset\b|description/i);
    for (const ids of [[0], [1, 1], Array.from({ length: 1001 }, (_, i) => i + 1), [NaN]]) {
      await expect(captureLegacyPostings(f.db, ids)).rejects.toThrow();
    }
    expect(f.queries).toHaveLength(1);
  });
});

it('a commit during an active WAL SELECT cannot mix old identities with new source rows; the next scan reconciles', async () => {
  const f = fixture('sqlite');
  f.add(1);
  f.add(2);
  const second = new Database(f.connection.name);
  cleanups.push(() => second.close());
  let changed = false;
  f.connection.exec('alter table postings rename to postings_data');
  second.exec('pragma foreign_keys = off');
  f.connection.function('capture_barrier', () => {
    if (!changed) {
      changed = true;
      second.exec(`begin;
        update postings_data set canonical_url = 'https://job-boards.greenhouse.io/acme/jobs/99' where id = 1;
        update posting_sources set source_url = 'https://job-boards.greenhouse.io/acme/jobs/99', publisher_id = '99' where posting_id = 1;
        delete from posting_sources where posting_id = 2;
        delete from postings_data where id = 2;
        insert into postings_data (id, dedupe_key, canonical_url, posted_at, first_seen_run,
          company, title, company_norm, title_norm, location_key, track, paid)
          values (3, 'new', 'https://job-boards.greenhouse.io/acme/jobs/3', ${NOW}, 'SEED_RUN',
            'Acme', 'Software Engineer', 'acme', 'engineer', 'US', 'engineering', 1);
        commit;`);
    }
    return 0;
  });
  // A view invokes the concurrent writer during the real SELECT; no production test hooks.
  f.connection.exec(`create view postings as select id, dedupe_key, canonical_url, posted_at, first_seen_run,
      company || substr('', 1, capture_barrier()) as company, company_norm, title, country, location,
      description, source_fields, track, seniority, delisted_at, paid, pay_rate_min, pay_rate_max, pay_rate_period, pay_currency_symbol
      from postings_data;`);
  const first = await captureCandidateSnapshot(f.db, policy(), NOW);
  const saved = JSON.stringify(first);
  expect(changed).toBe(true);
  expect(first.candidates.map((c) => c.identity?.requisition)).toEqual(['1', '2']);
  expect(first.candidates[0].postings[0].sources[0].publisherId).toBe('1');
  expect((await captureCandidateSnapshot(f.db, policy(), NOW)).candidates.map((c) => c.identity?.requisition))
    .toEqual(['99', '3']);
  expect(JSON.stringify(first)).toBe(saved);
});
