/**
 * The sort and visibility gate. Every case here is one a plausible implementation gets wrong:
 * an ordering that is not plain recency, Design's location rule leaking onto Engineering or
 * failing to hide anything, a location spelling the rule does not recognize being deleted
 * rather than merely mis-sorted, a tie-break that stops one key short, or a `senior+` row
 * surviving a filter combination.
 *
 * Runs against a real SQLite database with the committed migrations applied, because both the
 * ordering and the location rule are produced by SQL, not by JavaScript.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { REFS, fixtures, refKey } from '../scripts/seed.ts';
import type { Db } from './db/index.ts';
import { postings, postingSources } from './db/schema.ts';
import { GEO_TIER, geoTier } from './geo.ts';
import { normalizeCompany } from './normalize.ts';
import {
  countPostings,
  geoTierSql,
  getPostingDetail,
  listPostings,
  outsideTargetLocations,
  ROW_CAP,
  tabIsEmpty,
} from './query.ts';
import {
  DEFAULT_BASIS,
  FILTERS,
  GROUPS,
  POSTED_WINDOWS,
  TABS,
  WINDOW_MS,
  cleared,
  href,
  parseParams,
  type Params,
  type Tab,
  vocab,
  withBasis,
  withPage,
  toggleFilter,
  withFilter,
} from './params.ts';

const NOW = Date.UTC(2026, 2, 17, 12, 0, 0);

let db: Db;
/** Row id -> fixture ref, so assertions read as the handles the fixtures are named by. */
let refOf: Map<number, string>;

function params(tab: Tab, over: Partial<Params> = {}): Params {
  return {
    tab,
    // Faithful to `parseParams`: Design always lands on a side of the freelance split,
    // Engineering has no split at all.
    basis: tab === 'design' ? DEFAULT_BASIS : null,
    posted: null,
    type: [],
    pay: [],
    mode: [],
    season: [],
    level: [],
    badge: null,
    job: null,
    page: 1,
    ...over,
  };
}

async function order(p: Params): Promise<string[]> {
  return (await listPostings(db, p, NOW)).map((row) => refOf.get(row.id)!);
}

/**
 * `effectiveAt`, not `postedAt` — the clock the query actually orders by. Reading `postedAt`
 * here asserted an invariant the board does not hold: the fixtures happen to keep the two
 * dates equal, so the test stayed green while production ordered by one and rendered the
 * other, and the accent band ended up labelling rows whose cell read `668d`.
 */
async function times(p: Params): Promise<number[]> {
  return (await listPostings(db, p, NOW)).map((row) => row.effectiveAt);
}

function idOf(ref: string): number {
  return [...refOf].find(([, r]) => r === ref)![0];
}

function fromUrl(url: string): Params {
  return parseParams(Object.fromEntries(new URL(`http://workie.local${url}`).searchParams));
}

/** Fails loudly on a typo'd ref rather than silently comparing -1 to -1. */
function before(list: string[], a: string, b: string) {
  expect(list, `${a} missing`).toContain(a);
  expect(list, `${b} missing`).toContain(b);
  expect(list.indexOf(a), `${a} should sort above ${b}`).toBeLessThan(list.indexOf(b));
}

const SF = { cityNorm: 'sf', state: 'CA', country: 'US', isRemote: false };
const BERLIN = { cityNorm: 'berlin', state: null, country: 'DE', isRemote: false };
const AUSTIN = { cityNorm: 'austin', state: 'TX', country: 'US', isRemote: false };
const BERLIN_REMOTE = { ...BERLIN, isRemote: true };

beforeEach(() => {
  db = drizzle(new Database(':memory:')) as unknown as Db;
  migrate(db, { migrationsFolder: 'drizzle' });
  db.insert(postings).values(fixtures(NOW)).run();

  const byKey = new Map(REFS.map((ref) => [refKey(ref), ref]));
  refOf = new Map(
    db
      .select({ id: postings.id, key: postings.dedupeKey })
      .from(postings)
      .all()
      .map((row) => [row.id, byKey.get(row.key)!]),
  );
});

describe('recency first, on both tabs', () => {
  it.each(TABS)('%s: posted_at descends, with no exceptions', async (tab) => {
    const list = await times(params(tab));
    expect(list.length).toBeGreaterThan(5);
    expect(list).toEqual([...list].sort((a, b) => b - a));
  });

  // All three are employed-side rows, which is the side `params('design')` lands on. The
  // 6h-old `d-unknown-pay` used to be the newest here and is freelance, so it now sits on the
  // other side of the split — see the split's own describe block for the ordering there.
  it('design: three known timestamps come back newest first', async () => {
    const list = await order(params('design'));
    before(list, 'd-remote-mid', 'd-unpaid-intern'); // 9h before 2d
    before(list, 'd-unpaid-intern', 'd-sparse'); // 2d before 21d
  });

  it('engineering: three known timestamps come back newest first', async () => {
    const list = await order(params('engineering'));
    before(list, 'e-voice', 'e-intern-summer'); // 3h before 5h
    before(list, 'e-intern-summer', 'e-sf-3d'); // 5h before 3d
  });

  it.each(TABS)('%s: identical posted_at, entry above mid', async (tab) => {
    before(await order(params(tab)), `${tab[0]}-tie-entry`, `${tab[0]}-tie-mid`);
  });

  /**
   * The page renders the "last 24 hours" band as `rows.slice(0, freshCount)` — a prefix, not a
   * partition. That is only correct while `posted_at desc` is the FIRST sort key, and the
   * explicit fresh-bucket key that used to guarantee it is exactly what this change removed.
   * Put any key ahead of recency and stale rows render under the accent band.
   */
  it.each(TABS)('%s: the fresh rows are a prefix, which is what the band renders', async (tab) => {
    const fresh = (await times(params(tab))).map((t) => NOW - t < WINDOW_MS.day);
    const firstStale = fresh.indexOf(false);
    expect(firstStale, 'the corpus needs both fresh and stale rows to test this').toBeGreaterThan(0);
    expect(fresh.slice(firstStale), 'a fresh row sorted below a stale one').not.toContain(true);
  });
});

describe('design shows the target locations, engineering shows every location', () => {
  it('hides an onsite Berlin posting on BOTH tabs — nobody reading this can take it', async () => {
    expect(await order(params('design'))).not.toContain('d-berlin-3d');
    expect(await order(params('engineering'))).not.toContain('e-berlin-3d');
  });

  /** Remote does not rescue a role abroad: it is usually hired in that country. */
  it('hides the same Berlin posting when it is remote, on both tabs', async () => {
    db.update(postings).set({ ...BERLIN_REMOTE, workMode: null }).where(eq(postings.id, idOf('e-berlin-3d'))).run();
    db.update(postings).set({ ...BERLIN_REMOTE, workMode: null }).where(eq(postings.id, idOf('d-berlin-3d'))).run();

    expect(await order(params('engineering'))).not.toContain('e-berlin-3d');
    expect(await order(params('design'))).not.toContain('d-berlin-3d');
  });

  it('hides it even when it would otherwise lead the table', async () => {
    // Two hours old against a nine-hour-old survivor: recency does not buy an exemption.
    expect(await order(params('design'))).not.toContain('d-berlin-2h');
    expect((await order(params('design')))[0]).toBe('d-remote-mid');
  });

  it('keeps tier 0, tier 1 and tier 2', async () => {
    const list = await order(params('design'));
    expect(list).toContain('d-sf-3d'); // tier 0, a target metro
    expect(list).toContain('d-oakland-entry'); // tier 1, California outside the metros
    expect(list).toContain('d-remote-mid'); // tier 2, remote
  });

  /**
   * The regression this rule invited: 137 live postings arrive spelled "New York City" or
   * "San Francisco Office". As a sort key the missed alias cost them a few positions; as a
   * visibility rule it would delete them. `normalizeLocation` resolves the spelling now, so
   * these two carry the canonical key — `normalize.test.ts` guards the resolution itself.
   */
  it('keeps target metros that arrived with a board-flavoured spelling', async () => {
    const list = await order(params('design'));
    expect(list).toContain('d-nyc-loose'); // "New York City, New York, United States"
    expect(list).toContain('d-sf-office'); // "San Francisco Office"
  });

  it('hides a remote role based in London', async () => {
    expect(await order(params('design'))).not.toContain('d-london-remote');
  });

  it('does not treat explicit onsite or hybrid work abroad as remotely eligible', async () => {
    const id = idOf('e-berlin-3d');
    for (const workMode of ['onsite', 'hybrid'] as const) {
      db.update(postings).set({ ...BERLIN, isRemote: true, workMode }).where(eq(postings.id, id)).run();
      expect(await getPostingDetail(db, id, NOW)).toBeNull();
    }
  });

  it('keeps a posting whose location never normalized, rather than dropping it silently', async () => {
    expect(await order(params('design'))).toContain('d-nowhere');
  });

  it('a non-California US city is elsewhere, so Design hides it too', async () => {
    expect(await order(params('design'))).not.toContain('d-austin');
    expect(await order(params('engineering'))).toContain('e-austin');
  });

  it('the rule reads the row, not a list of refs: moving a posting moves it in or out', async () => {
    db.update(postings).set(BERLIN).where(eq(postings.id, idOf('d-sf-3d'))).run();
    db.update(postings).set(SF).where(eq(postings.id, idOf('d-berlin-3d'))).run();

    const list = await order(params('design'));
    expect(list).not.toContain('d-sf-3d'); // now in Berlin
    expect(list).toContain('d-berlin-3d'); // now in SF
  });

  /**
   * Narrower than it used to be, and deliberately so: Engineering ignores WHERE in the US a job
   * is — Austin ranks with San Francisco — but it no longer ignores location entirely, because
   * onsite-abroad is now hidden there too. Swapping two US cities is the strongest form of the
   * claim that still holds.
   */
  it('engineering ignores location within the US: swapping two US ones changes nothing', async () => {
    const first = await order(params('engineering'));
    db.update(postings).set(AUSTIN).where(eq(postings.id, idOf('e-sf-3d'))).run();
    db.update(postings).set(SF).where(eq(postings.id, idOf('e-austin'))).run();

    expect(await order(params('engineering'))).toEqual(first);
  });

  /**
   * The hole this class of rule keeps reopening: the table is not the only way in. A Design
   * posting the table refuses to list must not be reachable through `?job=<id>` either, and
   * the same rule has to hold for a track the detail query never sees.
   */
  it('the deep link obeys the location rule, not just the table', async () => {
    expect(await getPostingDetail(db, idOf('d-berlin-3d'), NOW), 'design, elsewhere').toBeNull();
    expect(await getPostingDetail(db, idOf('d-nowhere'), NOW), 'design, unknown').not.toBeNull();
    expect(await getPostingDetail(db, idOf('e-berlin-3d'), NOW), 'engineering, onsite abroad').toBeNull();
    expect(await getPostingDetail(db, idOf('e-austin'), NOW), 'engineering, elsewhere but US').not.toBeNull();
  });

  it('counts what geography hides, so an empty table can say so', async () => {
    // d-berlin-3d, d-berlin-2h, d-austin, d-london-remote. Not d-old-berlin, which is elsewhere too but 62
    // days old — a row the tab would not show anyway must not inflate the count.
    expect(await outsideTargetLocations(db, params('design'), NOW)).toBe(4);
  });

  /** The count sits under "no postings match these filters", so it has to be an answer to
   *  that question rather than a fact about the whole tab. */
  it('counts under the same filters it is explaining', async () => {
    expect(await outsideTargetLocations(db, params('design', { mode: ['onsite'] }), NOW)).toBe(1);
    expect(await outsideTargetLocations(db, params('design', { mode: ['remote'] }), NOW)).toBe(1);
  });
});

describe('SQL geo tier matches lib/geo.ts', () => {
  it('agrees with geoTier() on every fixture', async () => {
    const rows = db
      .select({
        tier: geoTierSql,
        cityNorm: postings.cityNorm,
        state: postings.state,
        country: postings.country,
        isRemote: postings.isRemote,
        workMode: postings.workMode,
      })
      .from(postings)
      .all();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.tier), JSON.stringify(row)).toBe(
        geoTier(
          {
            city_norm: row.cityNorm,
            state: row.state,
            country: row.country,
            is_remote: row.isRemote,
          },
          row.workMode,
        ),
      );
    }
    // Guards against a corpus that only exercises some branches of the CASE.
    expect(new Set(rows.map((r) => Number(r.tier)))).toEqual(
      new Set([GEO_TIER.metro, GEO_TIER.california, GEO_TIER.remote, GEO_TIER.elsewhere, GEO_TIER.unknown]),
    );
  });
});

describe('rows that must never render', () => {
  /** Every single-value setting of every filter, and every filter cleared. */
  function everyFilter(tab: Tab): Params[] {
    const out = [params(tab)];
    for (const filter of FILTERS) {
      for (const value of vocab(tab, filter)) out.push(params(tab, { [filter]: [value] }));
    }
    out.push(params(tab, { badge: 'voice-ai' }));
    return out;
  }

  /**
   * The ceiling is ENGINEERING-only now. Design carries `senior+` deliberately: entry-level
   * design is scarce enough that holding it to the same bar left the tab near-empty. The
   * assertion is split rather than dropped — engineering must still never show one.
   */
  it('engineering: no senior+ row under any filter', async () => {
    const combos = everyFilter('engineering');
    expect(combos.length).toBeGreaterThan(8);
    for (const p of combos) {
      expect(await order(p), JSON.stringify(p)).not.toContain('e-senior');
    }
  });

  it('design: senior+ IS listed, and is filterable on its own', async () => {
    expect(await order(params('design'))).toContain('d-senior');
    // Its own option, so it can be excluded in one click...
    expect(vocab('design', 'level')).toContain('senior+');
    expect(await order(params('design', { level: ['senior+'] }))).toContain('d-senior');
    // ...and asking for entry-level must not smuggle it back in.
    expect(await order(params('design', { level: ['entry'] }))).not.toContain('d-senior');
  });
  /**
   * `first_seen_run` is a free-text RUN IDENTIFIER, not a timestamp — `seed.ts` writes the
   * literal SEED_RUN. The cutoff floors `posted_at` at it, and SQLite's scalar `max()`
   * returns NULL if any argument is NULL, so without the `coalesce` in `effectiveAt` every
   * row whose run id does not parse as a date silently leaves the board. This pins that.
   */
  it.each(TABS)('%s: a non-timestamp first_seen_run does not hide the row', async (tab) => {
    const rows = await order(params(tab));
    expect(rows.length).toBeGreaterThan(5);
  });


  it.each(TABS)('%s: nothing older than 60 days', async (tab) => {
    expect(await order(params(tab))).not.toContain(`${tab[0]}-old`);
  });

  it.each(TABS)('%s: nothing delisted', async (tab) => {
    expect(await order(params(tab))).not.toContain(`${tab[0]}-delisted`);
  });

  // Hussh posts scam roles. However its name is spelled, no listing, count or deep link shows it.
  it.each(TABS)('%s: nothing from a blocked employer', async (tab) => {
    const [first] = await listPostings(db, params(tab), NOW);
    const total = await countPostings(db, params(tab), NOW);
    db.update(postings).set({ company: 'hussh 🤫', companyNorm: normalizeCompany('hussh 🤫') }).where(eq(postings.id, first.id)).run();
    expect((await listPostings(db, params(tab), NOW)).map((row) => row.id)).not.toContain(first.id);
    expect(await countPostings(db, params(tab), NOW)).toBe(total - 1);
    expect(await getPostingDetail(db, first.id, NOW)).toBeNull();
  });

  // The table is not the only way in: `?job=<id>` reaches a posting directly.
  it.each(['old', 'delisted'])('the %s posting is not reachable by deep link', async (kind) => {
    for (const tab of ['d', 'e'] as const) {
      const id = idOf(`${tab}-${kind}`);
      expect(await getPostingDetail(db, id, NOW), `${tab}-${kind}`).toBeNull();
    }
  });

  /**
   * `structural()` writes the ceiling against the ROW's track rather than the requested tab,
   * precisely so it still decides correctly here, where there is no tab at all.
   */
  it('senior+ deep-links on Design and stays blocked on Engineering', async () => {
    expect(await getPostingDetail(db, idOf('e-senior'), NOW), 'e-senior').toBeNull();
    expect(await getPostingDetail(db, idOf('d-senior'), NOW), 'd-senior').not.toBeNull();
  });

  it('a visible posting is reachable by deep link', async () => {
    expect((await getPostingDetail(db, idOf('e-sf-3d'), NOW))?.company).toBe('Northline');
  });

  it('retains a Remotive credit link when an employer owns the application URL', async () => {
    const id = idOf('e-sf-3d');
    const original = await getPostingDetail(db, id, NOW);
    const sourceUrl = 'https://remotive.com/remote-jobs/software-development/engineer-1234';
    db.insert(postingSources).values({
      postingId: id, source: 'remotive', sourceUrl, sourcePriority: 3,
      postedAt: new Date(NOW), lastSeenRun: 'attribution-test',
    }).run();
    const detail = await getPostingDetail(db, id, NOW);
    expect(detail?.remotiveSourceUrl).toBe(sourceUrl);
    expect(detail?.canonicalUrl).toBe(original?.canonicalUrl);
    expect(detail?.canonicalUrl).not.toBe(sourceUrl);
  });

  it('a tab never shows the other track', async () => {
    expect((await order(params('design'))).every((ref) => ref.startsWith('d-'))).toBe(true);
    expect((await order(params('engineering'))).every((ref) => ref.startsWith('e-'))).toBe(true);
  });
});

describe('filters', () => {
  it.each([
    { pay: 'paid,unknown', allowed: [true, null] },
    { pay: 'unknown', allowed: [null] },
    { pay: 'unpaid,unknown', allowed: [false, null] },
    { pay: 'paid,unpaid,unknown', allowed: [true, false, null] },
  ])('includes exactly the selected pay states for $pay on both tabs', async ({ pay, allowed }) => {
    for (const tab of TABS) {
      const all = await listPostings(db, params(tab), NOW);
      expect(new Set(all.map((row) => row.paid))).toEqual(new Set([true, false, null]));
      const selected = await listPostings(db, parseParams({ tab, pay }), NOW);
      expect(selected.map((row) => row.id)).toEqual(
        all.filter((row) => allowed.includes(row.paid)).map((row) => row.id),
      );
    }
  });

  // `d-sparse` rather than `d-unknown-pay`: both have no pay, and this one is on the employed
  // side, so the assertion is about the pay rule and not about which side of the split it is on.
  it('pay unknown matches neither value but stays visible with the filter off (finding G)', async () => {
    expect(await order(params('design'))).toContain('d-sparse');
    expect(await order(params('design', { pay: ['paid'] }))).not.toContain('d-sparse');
    expect(await order(params('design', { pay: ['unpaid'] }))).not.toContain('d-sparse');
    expect(await order(params('design', { pay: ['unpaid'] }))).toContain('d-unpaid-intern');
  });

  /**
   * Was "the junior option covers entry as well (finding F)". Entry has its own option now, so
   * the two are asserted apart: each level option returns its own rows and nothing else. The
   * fold was hiding the larger group (281 entry engineering postings against 13 junior) behind
   * the smaller one's label.
   */
  it.each(['entry', 'junior', 'mid'] as const)('the %s option means exactly that level', async (level) => {
    const list = await order(params('engineering', { level: [level] }));
    const others = { entry: ['e-sf-3d', 'e-tie-mid'], junior: ['e-nyc-entry', 'e-tie-mid'], mid: ['e-nyc-entry', 'e-sf-3d'] }[level];
    const own = { entry: 'e-nyc-entry', junior: 'e-sf-3d', mid: 'e-tie-mid' }[level];
    expect(list, `${level} should list its own rows`).toContain(own);
    for (const ref of others) expect(list, `${level} must not list ${ref}`).not.toContain(ref);
  });

  /**
   * The point of the whole change: a group is a UNION, not a second `eq` that intersects to
   * nothing. Asserted as set algebra against the real corpus rather than against a fixed count,
   * so it keeps holding as the fixtures grow.
   */
  it.each([
    ['level', 'entry', 'junior'],
    ['mode', 'remote', 'hybrid'],
    ['type', 'full-time', 'internship'],
  ] as const)('%s: selecting two values returns exactly the union of selecting each', async (group, a, b) => {
    const onlyA = await order(params('engineering', { [group]: [a] }));
    const onlyB = await order(params('engineering', { [group]: [b] }));
    const both = await order(params('engineering', { [group]: [a, b] }));

    expect(onlyA.length, `${group}=${a} needs rows to be a real test`).toBeGreaterThan(0);
    expect(onlyB.length, `${group}=${b} needs rows to be a real test`).toBeGreaterThan(0);
    expect([...both].sort()).toEqual([...new Set([...onlyA, ...onlyB])].sort());
    // And a union is at least as wide as either half — the bug this replaces made it empty.
    expect(both.length).toBeGreaterThan(Math.max(onlyA.length, onlyB.length) - 1);
  });

  it('an empty set is "any", not "none"', async () => {
    expect((await order(params('engineering', { level: [] }))).length).toBe(
      (await order(params('engineering'))).length,
    );
  });

  it('selecting every value of a group is the same as selecting none of it', async () => {
    const all = await order(params('engineering', { mode: ['remote', 'hybrid', 'onsite'] }));
    const none = await order(params('engineering'));
    // Not identical: a posting with NO work_mode matches "any" but no explicit value.
    expect(all.length).toBeLessThanOrEqual(none.length);
    expect(none).toEqual(expect.arrayContaining(all));
  });

  /**
   * `pay` is the group where picking BOTH values differs from picking neither, because
   * `paid = NULL` means "the posting does not say" (finding G). Both = "it says something";
   * neither = "do not ask". If those two ever return the same rows, the multi-select on this
   * filter has quietly become decorative.
   */
  it('pay: both values means "stated", which is narrower than not asking', async () => {
    const both = await order(params('design', { pay: ['paid', 'unpaid'] }));
    const neither = await order(params('design'));
    const paid = await order(params('design', { pay: ['paid'] }));
    const unpaid = await order(params('design', { pay: ['unpaid'] }));

    expect([...both].sort()).toEqual([...new Set([...paid, ...unpaid])].sort());
    expect(both.length, 'the corpus needs a pay-unknown row for this to mean anything').toBeLessThan(
      neither.length,
    );
    // `d-sparse` has no pay at all, so it is in neither half.
    expect(neither).toContain('d-sparse');
    expect(both).not.toContain('d-sparse');
  });

  it('posted-within windows narrow monotonically', async () => {
    const count = async (posted: Params['posted']) => (await order(params('engineering', { posted }))).length;
    expect(await count('month')).toBeGreaterThan(await count('week'));
    expect(await count('week')).toBeGreaterThan(await count('day'));
    expect(await count('day')).toBeGreaterThan(await count('hour'));
    expect(await count('hour')).toBe(0);
  });

  it('every dropdown narrows on its own', async () => {
    for (const tab of TABS) {
      const all = (await order(params(tab))).length;
      for (const filter of FILTERS) {
        for (const value of vocab(tab, filter)) {
          const narrowed = await order(params(tab, { [filter]: [value] }));
          expect(narrowed.length, `${tab} ${filter}=${value}`).toBeLessThan(all);
          expect(await order(params(tab)), `${tab} ${filter}=${value}`).toEqual(
            expect.arrayContaining(narrowed),
          );
        }
      }
    }
  });

  it('filters AND across groups', async () => {
    const remote = await order(params('engineering', { mode: ['remote'] }));
    expect(remote).toContain('e-remote-mid');
    expect(remote).toContain('e-intern-winter');

    const narrowed = await order(params('engineering', { mode: ['remote'], type: ['internship'] }));
    expect(narrowed).toContain('e-intern-winter');
    expect(narrowed).not.toContain('e-remote-mid'); // remote, but full-time
  });

  it('design: the window and a group narrow together', async () => {
    const week = await order(params('design', { posted: 'week' }));
    expect(week).toContain('d-sf-3d'); // 3 days old
    expect(week).not.toContain('d-freelance'); // 11 days old
    expect(await order(params('design', { posted: 'week', type: ['internship'] }))).toEqual([
      'd-unpaid-intern',
    ]);
  });

  it('season filters internships', async () => {
    expect(await order(params('engineering', { season: ['summer'] }))).toEqual(['e-intern-summer']);
  });

  it('a badge is a filter value', async () => {
    expect(await order(params('engineering', { badge: 'voice-ai' }))).toEqual(['e-voice', 'e-voice-remote']);
    expect(await order(params('engineering', { badge: 'design-systems' }))).toEqual([]);
  });

  it('reports zero results without claiming the tab is empty', async () => {
    const p = params('design', { type: ['part-time'], mode: ['remote'] });
    expect(await order(p)).toEqual([]);
    expect(await tabIsEmpty(db, p, NOW)).toBe(false);
  });
});

describe('badges and dropdowns write the same filter', () => {
  /**
   * The two controls reach the same param by different routes — a badge renders a link built by
   * `toggleFilter`, a checkbox submits `<input name={group}>` with the raw value — so the
   * property that matters is that both land on the same state for every value on offer. Both
   * read their vocabulary from `vocab()`, which is what stops one of them drifting.
   */
  it('every value of every group arrives the same way from either control', async () => {
    for (const tab of TABS) {
      for (const group of GROUPS) {
        for (const value of vocab(tab, group)) {
          const badge = fromUrl(toggleFilter(params(tab), group, value));
          const checkbox = parseParams({ tab, [group]: value });
          expect(badge[group], `${tab} ${group}=${value} via badge`).toEqual([value]);
          expect(checkbox[group], `${tab} ${group}=${value} via checkbox`).toEqual([value]);
          expect(href(badge)).toBe(href(checkbox));
        }
      }
    }
  });

  /**
   * The behaviour that made single-valued groups feel broken: clicking a second badge in the
   * same group used to throw the first away. It must now ADD, and clicking an on badge must
   * remove only itself.
   */
  it('a second badge in the same group adds to the filter rather than replacing it', async () => {
    const one = fromUrl(toggleFilter(params('engineering'), 'level', 'entry'));
    expect(one.level).toEqual(['entry']);

    const two = fromUrl(toggleFilter(one, 'level', 'junior'));
    expect(two.level, 'the second click must not evict the first').toEqual(['entry', 'junior']);

    const back = fromUrl(toggleFilter(two, 'level', 'entry'));
    expect(back.level, 'un-ticking one leaves the rest').toEqual(['junior']);
  });

  it('clicking the badge that is already selected clears just that filter', async () => {
    const on = fromUrl(toggleFilter(params('engineering', { level: ['junior'] }), 'mode', 'remote'));
    expect([on.mode, on.level]).toEqual([['remote'], ['junior']]);

    const off = fromUrl(toggleFilter(on, 'mode', 'remote'));
    expect(off.mode).toEqual([]);
    expect(off.level, 'clearing one filter must not clear the others').toEqual(['junior']);
  });

  /**
   * Vocabulary order, not click order. `?level=junior,entry` and `?level=entry,junior` are the
   * same filter, so they have to serialize identically or the same table has two addresses and
   * `href` stops being idempotent.
   */
  it('serializes a set in vocabulary order however it was built', async () => {
    const forwards = fromUrl(toggleFilter(fromUrl(toggleFilter(params('engineering'), 'level', 'entry')), 'level', 'mid'));
    const backwards = fromUrl(toggleFilter(fromUrl(toggleFilter(params('engineering'), 'level', 'mid')), 'level', 'entry'));
    expect(href(forwards)).toBe(href(backwards));
    expect(href(forwards)).toContain('level=entry%2Cmid');
    expect(fromUrl('/?tab=engineering&level=mid,entry').level).toEqual(['entry', 'mid']);
  });

  it('a filter link cannot carry a value the tab does not offer', async () => {
    // Season is Engineering's; `posted` is now shared, so it survives on both tabs.
    expect(withFilter(params('design'), 'season', 'summer')).toBe('/?filters=all');
    expect(withFilter(params('design'), 'posted', 'hour')).toBe('/?posted=hour');
    expect(withFilter(params('engineering'), 'posted', 'hour')).toBe('/?tab=engineering&posted=hour');
  });

  /** Design offered `week` alone until a one-option dropdown read as a broken control. */
  it.each(TABS)('%s offers every posted window', (tab) => {
    expect(vocab(tab, 'posted')).toEqual([...POSTED_WINDOWS]);
  });

  it('changing a filter closes the drawer rather than carrying it along', async () => {
    expect(withFilter(params('engineering', { job: 12 }), 'mode', 'remote')).not.toContain('job=');
  });
});

/**
 * The Design freelance split. A partition, not a filter: the properties worth pinning are that
 * it loses nothing and duplicates nothing, because either failure is silent — a posting that
 * falls between the sides is simply never seen again, and nothing else in the app would notice.
 */
describe('the Design freelance split', () => {
  const both = async () => [
    await order(params('design', { basis: 'employed' })),
    await order(params('design', { basis: 'freelance' })),
  ];

  it('puts every visible Design posting on exactly one side', async () => {
    const [employed, freelance] = await both();
    const overlap = employed.filter((ref) => freelance.includes(ref));
    expect(overlap, 'a posting on both sides would be double-counted').toEqual([]);
    // The union has to equal what the tab shows with no split applied at all, which is what
    // `basis: null` asks for — a shape only reachable here, never from a URL.
    const whole = await order(params('design', { basis: null }));
    expect([...employed, ...freelance].sort()).toEqual([...whole].sort());
  });

  it('routes freelance and contract to the freelance side', async () => {
    const [employed, freelance] = await both();
    expect(freelance).toContain('d-unknown-pay'); // type: freelance
    expect(freelance).toContain('d-contract'); // type: contract — the case a literal match misses
    expect(freelance).toContain('d-freelance');
    expect(employed).not.toContain('d-contract');
  });

  it('keeps an undetermined employment type on the employed side rather than dropping it', async () => {
    // `d-sparse` has no employment type at all. `NULL not in (...)` is NULL, so without the
    // coalesce in `isEmployed` this row would belong to neither side and vanish from the tab.
    const [employed, freelance] = await both();
    expect(employed).toContain('d-sparse');
    expect(freelance).not.toContain('d-sparse');
  });

  it('sorts each side by the same two keys as the tab', async () => {
    before(await order(params('design', { basis: 'freelance' })), 'd-unknown-pay', 'd-contract'); // 6h before 7h
    before(await order(params('design', { basis: 'freelance' })), 'd-contract', 'd-freelance'); // 7h before 11d
  });

  it('still obeys the location rule and the structural rules on both sides', async () => {
    for (const list of await both()) {
      expect(list).not.toContain('d-berlin-3d'); // elsewhere
      expect(list).not.toContain('d-delisted');
      expect(list).not.toContain('d-old'); // past the 60-day cutoff
    }
  });

  it('is a Design control only — Engineering has no side', async () => {
    expect(parseParams({ tab: 'engineering', basis: 'freelance' }).basis).toBeNull();
    expect(parseParams({ tab: 'design' }).basis).toBe(DEFAULT_BASIS);
    expect(parseParams({ tab: 'design', basis: 'nonsense' }).basis).toBe(DEFAULT_BASIS);
  });

  it('writes only the non-default side into the URL', async () => {
    expect(href(params('design', { basis: 'employed' }))).toBe('/');
    expect(href(params('design', { basis: 'freelance' }))).toBe('/?basis=freelance');
    expect(withBasis(params('design'), 'freelance')).toBe('/?basis=freelance');
    expect(withBasis(params('design', { basis: 'freelance' }), 'employed')).toBe('/');
  });

  it('drops a type the destination side does not offer when crossing', async () => {
    // Carrying `type=part-time` onto the freelance side would show an empty table under a
    // control set to a value that side cannot have.
    expect(withBasis(params('design', { type: ['part-time'] }), 'freelance')).toBe('/?basis=freelance&filters=all');
    expect(withBasis(params('design', { type: ['contract'], basis: 'freelance' }), 'employed')).toBe('/?filters=all');
  });

  it('survives clearing the filters — clear is not a way across the split', async () => {
    expect(cleared(params('design', { basis: 'freelance', type: ['contract'] }))).toBe('/?basis=freelance&filters=all');
  });
});

describe('search params are validated, not trusted', () => {
  /**
   * The invariant the filter button rests on. That GET form submits every control, including
   * the ones left on "any", so the page is asked for `?type=&pay=&mode=` constantly. The page
   * used to refuse to render those and `redirect()` to the tidy URL instead, which broke the
   * button outright — `next/form` navigates on the client and a redirect thrown mid-stream
   * leaves an empty tree. Nothing needs the redirect as long as a form-shaped URL parses to
   * exactly what the tidy one parses to, which is what this pins.
   */
  it.each([
    ['design employed', { tab: 'design', basis: 'employed', posted: 'week' }, { posted: 'week' }],
    ['design freelance', { tab: 'design', basis: 'freelance', type: ['contract'] }, { basis: 'freelance', type: ['contract'] }],
    ['engineering', { tab: 'engineering', posted: 'day', level: ['entry'] }, { tab: 'engineering', posted: 'day', level: ['entry'] }],
    ['nothing chosen', { tab: 'design', basis: 'employed' }, { filters: 'all' }],
  ])('%s: a form submission parses to the same params as the tidy URL', (_label, chosen, tidy) => {
    const empties = { type: '', pay: '', mode: '', season: '', level: '', posted: '' };
    // The form sends every control; the chosen ones overwrite their empty defaults.
    const submitted = parseParams({ ...empties, ...chosen });
    expect(submitted).toEqual(parseParams(tidy));
    // And the URL the page would tidy to is reachable from what was submitted.
    expect(fromUrl(href(submitted))).toEqual(submitted);
  });

  it('drops values outside the tab vocabulary', async () => {
    const p = parseParams({ tab: 'design', posted: 'hour', season: ['summer'], type: ['part-time'] });
    expect(p.posted).toBe('hour'); // every window is offered on both tabs now
    expect(p.season).toEqual([]); // Design has no seasons
    expect(p.type).toEqual(['part-time']);
  });

  /** A set drops only the members the tab does not know, not the whole filter. */
  it('keeps the known members of a partly-unknown set', async () => {
    expect(parseParams({ tab: 'engineering', level: 'entry,principal,mid' }).level).toEqual(['entry', 'mid']);
    expect(parseParams({ tab: 'engineering', mode: 'nonsense,hybrid' }).mode).toEqual(['hybrid']);
    expect(parseParams({ tab: 'engineering', level: 'principal,staff' }).level).toEqual([]);
  });

  /** Both spellings of a set parse: a checkbox group repeats the key, `href` writes a list. */
  it('parses a repeated key and a comma list to the same set', async () => {
    const repeated = parseParams({ tab: 'engineering', level: ['entry', 'junior'] });
    const commas = parseParams({ tab: 'engineering', level: 'entry,junior' });
    expect(repeated.level).toEqual(['entry', 'junior']);
    expect(repeated).toEqual(commas);
  });

  it('dedupes a value repeated in either spelling', async () => {
    expect(parseParams({ tab: 'engineering', level: 'mid,mid,mid' }).level).toEqual(['mid']);
    expect(parseParams({ tab: 'engineering', level: ['mid', 'mid'] }).level).toEqual(['mid']);
  });

  /**
   * The vocabulary a value is checked against depends on the side of the split, so `type` is
   * validated after `basis` is resolved. Both directions matter: a bookmarked
   * `?type=freelance` must not survive onto the employed side and quietly return nothing.
   */
  it('drops a type belonging to the other side of the split', async () => {
    expect(parseParams({ tab: 'design', type: ['freelance'] }).type).toEqual([]);
    expect(parseParams({ tab: 'design', basis: 'freelance', type: ['freelance'] }).type).toEqual(['freelance']);
    expect(parseParams({ tab: 'design', basis: 'freelance', type: ['full-time'] }).type).toEqual([]);
    expect(parseParams({ tab: 'design', basis: 'freelance', type: ['contract'] }).type).toEqual(['contract']);
    // A set spanning both sides keeps only the side it is on.
    expect(parseParams({ tab: 'design', type: 'full-time,contract' }).type).toEqual(['full-time']);
    expect(parseParams({ tab: 'design', basis: 'freelance', type: 'full-time,contract' }).type).toEqual(['contract']);
  });

  it('falls back rather than throwing on junk', async () => {
    const p = parseParams({
      tab: 'marketing',
      level: 'principal,mid',
      pay: ' ',
      job: '-4',
      badge: 'DROP TABLE',
    });
    expect(p.tab).toBe('design');
    expect(p.level).toEqual(['mid']);
    expect(p.pay).toEqual([]);
    expect(p.job).toBeNull();
    expect(p.badge).toBeNull();
  });

  it('reads `job` and `page` as safe whole numbers in range, or not at all', async () => {
    for (const job of ['0', '1.5', 'abc', '9007199254740993', 'Infinity']) expect(parseParams({ job }).job).toBeNull();
    expect(parseParams({ job: ' 7 ' }).job).toBe(7);
    for (const page of ['0', '10001', '2.5', 'x', '']) expect(parseParams({ page }).page).toBe(1);
    expect(parseParams({ page: '10000' }).page).toBe(10_000);
  });

  /**
   * A comma list used to yield ONE value, because one was all a dropdown could show and a
   * control that misreports its filter is worse than a narrower filter. Checkboxes can show a
   * set, so the whole list is honoured now — the old URL means more than it used to, which is
   * the right direction: it never meant "only onsite".
   */
  it('honours every value of a legacy comma list now that a control can show them', async () => {
    expect(parseParams({ tab: 'engineering', mode: 'onsite,remote' }).mode).toEqual(['remote', 'onsite']);
  });

  it('round-trips through the URL', async () => {
    const p = parseParams({ tab: 'engineering', mode: ['remote'], level: ['junior'], job: '12' });
    expect(fromUrl(href(p))).toEqual(p);
  });

  /** Idempotence with sets, which is what the vocabulary ordering in `pickAll` buys. */
  it('round-trips a multi-value filter set', async () => {
    const p = parseParams({
      tab: 'engineering',
      level: 'mid,entry',
      mode: 'onsite,remote',
      pay: 'unpaid,paid',
      type: 'internship,full-time',
      season: 'winter,summer',
      posted: 'week',
    });
    expect(p.level).toEqual(['entry', 'mid']);
    expect(fromUrl(href(p))).toEqual(p);
    expect(href(fromUrl(href(p)))).toBe(href(p));
  });
});

/**
 * The Engineering tab had 920 rows and paid for every one of them at once — 3.7 MB of markup,
 * ~14,000 DOM nodes, 978 KB out of Turso on a 591ms query. The cap is what makes a tab switch
 * cost the same whatever the corpus grows to.
 */
describe('row cap', () => {
  /** One more engineering row than the cap allows, all inside the window and visible. */
  function flood(count: number): void {
    const template = fixtures(NOW).find((row) => row.track === 'engineering' && row.seniority === 'mid')!;
    db.insert(postings)
      .values(
        Array.from({ length: count }, (_, index) => ({
          ...template,
          id: 50_000 + index,
          dedupeKey: `flood-${index}`,
          canonicalUrl: `https://flood.test/${index}`,
          // Distinct timestamps so the order is total and the slice is deterministic.
          postedAt: new Date(NOW - index * 1000),
        })),
      )
      .run();
  }

  it('asks for exactly one row more than it will render', async () => {
    flood(ROW_CAP + 50);
    const rows = await listPostings(db, params('engineering'), NOW);

    // The extra row is the "there is more" signal the page reads instead of a second count.
    expect(rows).toHaveLength(ROW_CAP + 1);
  });

  it('does not cap a tab that has fewer rows than the cap', async () => {
    const rows = await listPostings(db, params('engineering'), NOW);
    expect(rows.length).toBeLessThan(ROW_CAP);
  });

  it('caps the NEWEST rows, so the cap never hides something recent', async () => {
    flood(ROW_CAP + 50);
    const rows = await listPostings(db, params('engineering'), NOW);
    const times = rows.map((row) => row.effectiveAt);

    expect(times).toEqual([...times].sort((a, b) => b - a));
    // The oldest row in the corpus must be the one dropped, not one of these.
    expect(Math.min(...times)).toBeGreaterThan(NOW - (ROW_CAP + 50) * 1000);
  });

  it('reaches jobs beyond the first page without repeating its displayed rows', async () => {
    flood(ROW_CAP + 50);
    const first = (await listPostings(db, params('engineering'), NOW)).slice(0, ROW_CAP);
    const second = await listPostings(db, params('engineering', { page: 2 }), NOW);
    const firstIds = new Set(first.map((row) => row.id));
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((row) => firstIds.has(row.id))).toBe(false);
    expect(second[0].id).toBe(50_000 + ROW_CAP);
  });

  it('counts exactly the rows every page lists, under the same filters', async () => {
    flood(ROW_CAP + 50);
    for (const p of [params('engineering'), params('engineering', { level: ['mid'] }), params('design')]) {
      const pages = [];
      for (let page = 1; ; page++) {
        const rows = (await listPostings(db, { ...p, page }, NOW)).slice(0, ROW_CAP);
        if (rows.length === 0) break;
        pages.push(...rows);
      }
      expect(await countPostings(db, p, NOW)).toBe(pages.length);
    }
  });

  it('validates page numbers and resets pagination when filters change', () => {
    for (const page of ['0', '-1', '1.2', 'Infinity', '10001', 'bad']) {
      expect(parseParams({ page }).page).toBe(1);
    }
    const second = parseParams({ tab: 'engineering', level: 'entry', page: '2' });
    expect(fromUrl(withPage(second, 3))).toMatchObject({ page: 3, level: ['entry'], tab: 'engineering' });
    expect(fromUrl(withFilter(second, 'level', 'junior')).page).toBe(1);
    expect(fromUrl(cleared(second)).page).toBe(1);
  });

  it('filters on the same seen date as the fresh band, not an old ATS creation date', async () => {
    const id = idOf('e-sf-3d');
    db.update(postings).set({
      postedAt: new Date(NOW - 90 * WINDOW_MS.day),
      firstSeenRun: new Date(NOW - WINDOW_MS.hour / 2).toISOString(),
    }).where(eq(postings.id, id)).run();
    expect((await listPostings(db, params('engineering', { posted: 'hour' }), NOW))
      .map((row) => row.id)).toContain(id);
  });
});

describe('roles auto-apply can fill live in Applications, not on the board', () => {
  it.each([
    'https://job-boards.greenhouse.io/acme/jobs/123',
    'https://jobs.lever.co/acme/0f6c2c9e-1111-4222-8333-944455556666',
    'https://jobs.eu.lever.co/acme/0f6c2c9e-1111-4222-8333-944455556666',
    'https://jobs.ashbyhq.com/acme/0f6c2c9e-1111-4222-8333-944455556666',
  ])('hides %s', async (url) => {
    db.update(postings).set({ canonicalUrl: url }).where(eq(postings.id, idOf('d-sf-3d'))).run();
    expect(await order(params('design'))).not.toContain('d-sf-3d');
  });

  it('shows a role Auto Apply gave up on again', async () => {
    db.update(postings).set({ canonicalUrl: 'https://jobs.ashbyhq.com/Acme/0F6C2C9E-1111-4222-8333-944455556666/' }).where(eq(postings.id, idOf('d-sf-3d'))).run();
    const returned = ['https://jobs.ashbyhq.com/acme/0f6c2c9e-1111-4222-8333-944455556666'];
    expect((await listPostings(db, params('design'), NOW, returned)).map((row) => refOf.get(row.id))).toContain('d-sf-3d');
  });

  it('keeps a role whose link the worker cannot fill', async () => {
    db.update(postings).set({ canonicalUrl: 'https://careers.acme.com/jobs/123' }).where(eq(postings.id, idOf('d-sf-3d'))).run();
    expect(await order(params('design'))).toContain('d-sf-3d');
  });
});

/**
 * Every filter column lives after `description` in the row, so a WHERE that reaches the table
 * reads each live row's ~7 KB of overflow pages. On the 10/23 corpus that was ~4,800 pages per
 * Engineering count instead of ~120, every render, on Turso. The board's WHERE has to stay
 * answerable from `postings_board_idx` alone: a new filter column goes into that index too.
 */
describe('the board filters from the index, not the rows', () => {
  async function plans(run: (db: Db) => Promise<unknown>): Promise<string[]> {
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    const seen: { query: string; params: unknown[] }[] = [];
    await run(drizzle(sqlite, { logger: { logQuery: (query, params) => void seen.push({ query, params }) } }) as unknown as Db);
    return seen.flatMap(({ query, params }) => sqlite.prepare(`explain query plan ${query}`).all(...params)
      .map((row) => (row as { detail: string }).detail));
  }

  it.each([
    ['engineering', params('engineering', { posted: 'week', type: ['internship'], mode: ['remote'], season: ['summer'], level: ['entry'], pay: ['unknown'], badge: 'voice-ai' })],
    ['design', params('design', { basis: 'freelance', posted: 'week', mode: ['remote'], pay: ['paid'] })],
  ] as const)('%s: counting and the empty-tab checks read only a covering index', async (_, p) => {
    const returned = ['https://jobs.ashbyhq.com/acme/0f6c2c9e-1111-4222-8333-944455556666'];
    const details = await plans((logged) => Promise.all([
      countPostings(logged, p, NOW, returned),
      tabIsEmpty(logged, p, NOW, returned),
      outsideTargetLocations(logged, p, NOW, returned),
    ]));
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) expect(detail).toMatch(/USING COVERING INDEX postings_board_idx/);
  });

  // Turso bills every index entry a query walks. A cutoff the index can't seek walked every live row in the track.
  it.each(['engineering', 'design'] as const)('%s: the list and the count read only the rows inside the 60-day window', async (tab) => {
    const details = await plans((logged) => Promise.all([listPostings(logged, params(tab), NOW), countPostings(logged, params(tab), NOW)]));
    const searches = details.filter((detail) => /^(SEARCH|SCAN) postings\b/.test(detail));
    expect(searches).toHaveLength(2);
    for (const detail of searches) expect(detail).toMatch(/postings_board_idx \(track=\? AND delisted_at=\? AND <expr>[<>]\?/);
  });
});
