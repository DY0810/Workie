/**
 * The complete Workie schema — three tables.
 *
 * There is no `enrichment_cache`. It existed to avoid re-billing an LLM; extraction is now
 * deterministic and free, so a cache would buy nothing and cost correctness — change one
 * rule in `lib/extract.ts` and every cached row silently keeps serving the old answer.
 * Re-running the whole corpus is the correct behaviour and takes seconds.
 */

import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { SourceFields } from '../extract.ts';

/** One row per job. Known publisher identities keep distinct requisitions separate. */
export const postings = sqliteTable(
  'postings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dedupeKey: text('dedupe_key').notNull().unique(),
    /** The ATS URL when any source is an ATS, else the highest-priority source URL. */
    canonicalUrl: text('canonical_url').notNull(),
    /** MIN across sources, floored at the ATS date when one exists (finding D). */
    postedAt: integer('posted_at', { mode: 'timestamp_ms' }).notNull(),
    /** Set by the ghost pass after 2 consecutive absences from *successful* polls (finding C). */
    delistedAt: integer('delisted_at', { mode: 'timestamp_ms' }),
    /**
     * WHICH pass delisted this, and the reason the two do not undo each other.
     *
     * `ghost` — every source stopped listing it across two successful polls. Reversible: if a
     * source lists it again the ghost pass clears both columns.
     * `linkcheck` — its apply URL serves a gone page. The sources may well still list it, so
     * its absence counts stay at zero and the ghost pass must NOT read "not a ghost" as
     * "bring it back". Only `linkcheck` clears a `linkcheck` delisting.
     */
    delistedReason: text('delisted_reason', { enum: ['ghost', 'linkcheck'] }),
    firstSeenRun: text('first_seen_run').notNull(),

    // As listed by the highest-priority source. Display only — dedupe never reads these.
    company: text('company').notNull(),
    title: text('title').notNull(),
    /** Full normalized body. Drawer-only; never selected into the table query. */
    description: text('description'),
    /**
     * What the source API already returned as fields — employment type, work mode, location
     * parts, department/team, and the sections it structured itself. `lib/extract.ts` reads
     * this BEFORE the prose; see `SourceFields`.
     */
    sourceFields: text('source_fields', { mode: 'json' }).$type<SourceFields>(),

    // Normalized components, from lib/normalize.ts.
    companyNorm: text('company_norm').notNull(),
    titleNorm: text('title_norm').notNull(),
    locationKey: text('location_key').notNull(),
    cityNorm: text('city_norm'),
    state: text('state'),
    country: text('country'),
    isRemote: integer('is_remote', { mode: 'boolean' }).notNull().default(false),

    // Extraction (lib/extract.ts). Null until `npm run enrich` runs.
    enrichedAt: integer('enriched_at', { mode: 'timestamp_ms' }),
    track: text('track', { enum: ['design', 'engineering'] }),
    seniority: text('seniority', { enum: ['entry', 'junior', 'mid', 'senior+'] }),
    employmentType: text('employment_type', {
    enum: ['full-time', 'part-time', 'contract', 'freelance', 'internship'],
    }),
    internshipSeason: text('internship_season', { enum: ['summer', 'fall', 'winter', 'spring'] }),
    /** true | false | NULL. NULL is "unknown": it matches neither pay chip (finding G). */
    paid: integer('paid', { mode: 'boolean' }),
    workMode: text('work_mode', { enum: ['remote', 'hybrid', 'onsite'] }),
    /** The human-readable location as classified. `city_norm`/`state` above are the keys. */
    location: text('location'),
    payRateMin: real('pay_rate_min'),
    payRateMax: real('pay_rate_max'),
    payRatePeriod: text('pay_rate_period', { enum: ['hour', 'week', 'month', 'year'] }),
    payCurrencySymbol: text('pay_currency_symbol', { enum: ['$', '€', '£'] }),
    expectedGrad: text('expected_grad'),
    /** Engineering only — the Design tab has no summary column, so none is generated. */
    summary: text('summary'),
    responsibilities: text('responsibilities', { mode: 'json' }).$type<string[]>(),
    skills: text('skills', { mode: 'json' }).$type<string[]>(),
    education: text('education', { mode: 'json' }).$type<string[]>(),
    /** Filter chips, e.g. `voice-ai` (phase 5). Badges are controls, not decoration. */
    badges: text('badges', { mode: 'json' }).$type<string[]>(),
  },
  /**
   * The shape every page load asks for: one track, not delisted, inside the 60-day window,
   * newest first. Without it SQLite full-scans a table whose rows average 6.7 KB — a 5,074-byte
   * description plus 1,687 bytes of `source_fields` each — so reading 15,000 rows to return 900
   * meant touching ~126 MB, and a cold cache made that a 1.6-SECOND query on a local file.
   *
   * Column order is the usable order: the equality columns first, then the board's date
   * (`effectiveAt` in `lib/query.ts`, written out again here unqualified). The cutoff and the
   * sort are on that expression, so with `posted_at` in this slot SQLite read every live row in
   * the track (~100k on Engineering) per list and per count, which Turso bills as rows read.
   * On the expression, the cutoff is a range: it reads only the rows inside the window.
   *
   * Every other column the board's WHERE reads rides along, so the filter never touches a row.
   * Each of them is stored after `description`, so reading one from the table walks that row's
   * overflow pages: with only the three key columns, an Engineering count read ~4,800 pages
   * where this reads ~120, on every render, against Turso. `query.test.ts` holds the board to
   * this index; a new filter column goes in here too. It replaces the three-column index it
   * starts with, so nothing that used that one loses it.
   */
  (table) => [
    index('postings_board_idx').on(
      table.track, table.delistedAt, sql`max(posted_at, coalesce(unixepoch(first_seen_run) * 1000, 0))`, table.postedAt,
      table.firstSeenRun, table.seniority, table.companyNorm, table.country, table.cityNorm, table.state,
      table.workMode, table.isRemote, table.employmentType, table.internshipSeason, table.paid, table.badges,
      table.canonicalUrl,
    ),
  ],
);

/** One row per (posting, source). A source is NEVER discarded, only added to. */
export const postingSources = sqliteTable(
  'posting_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postingId: integer('posting_id')
      .notNull()
      .references(() => postings.id, { onDelete: 'cascade' }),
    /** Connector name, e.g. `greenhouse`, `remoteok`. */
    source: text('source').notNull(),
    sourceUrl: text('source_url').notNull(),
    publisherId: text('publisher_id'),
    /** This source's own date, never the merged one. */
    postedAt: integer('posted_at', { mode: 'timestamp_ms' }).notNull(),
    /** 1 ATS · 2 aggregator · 3 RSS · 4 scraped · 5 GitHub repo. See SOURCE_PRIORITY. */
    sourcePriority: integer('source_priority').notNull(),
    lastSeenRun: text('last_seen_run').notNull(),
    /** Consecutive absences from SUCCESSFUL polls of this source only (finding C). */
    absenceCount: integer('absence_count').notNull().default(0),
  },
  (table) => [
    uniqueIndex('posting_sources_posting_url_idx').on(table.postingId, table.sourceUrl),
    index('posting_sources_url_idx').on(table.sourceUrl),
    index('posting_sources_publisher_idx').on(table.source, table.publisherId),
  ],
);

/**
 * One row per (run, connector). The ghost pass reads this to tell a real absence from a
 * failed fetch, which is why it exists from phase 1 rather than arriving with ops.
 */
export const connectorRuns = sqliteTable(
  'connector_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    connector: text('connector').notNull(),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    fetched: integer('fetched').notNull().default(0),
    newPostings: integer('new_postings').notNull().default(0),
    merged: integer('merged').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    /** Message only — never a key, never a full response body. */
    error: text('error'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('connector_runs_run_connector_idx').on(table.runId, table.connector),
    // The board and refresh read the latest run on every request; without this each read scans every run.
    index('connector_runs_started_idx').on(table.startedAt),
  ],
);

/**
 * Talkie: shared post-it notes. Its page and API were removed on 2026-11-05; the tables stay so
 * existing notes are not destroyed. Lives in whichever database the app is READING — the hosted
 * replica is the shared board, written by the Vercel function itself. Deliberately absent
 * from `push:remote`'s table list, which mirrors the corpus up and deletes strays: a table the
 * hosted site writes must never be overwritten by the laptop's copy.
 *
 * Geometry is in board pixels; a note never moves after it is drawn, so there is no layout
 * engine to keep in sync. `created_at` is the week bucket and the unread cursor at once.
 */
export const notes = sqliteTable(
  'notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    body: text('body').notNull(),
    author: text('author'),
    /** Browser-generated key for retry-safe autosave of a newly drawn note. */
    clientKey: text('client_key'),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    w: integer('w').notNull(),
    h: integer('h').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('notes_created_idx').on(table.createdAt), uniqueIndex('notes_client_key_idx').on(table.clientKey)],
);

/**
 * A thread under a note. Was deleted with its note explicitly in the removed `lib/notes.ts` rather than by
 * ON DELETE CASCADE: SQLite only honours foreign keys when the connection turns the pragma on,
 * and neither driver here promises that.
 */
export const noteComments = sqliteTable(
  'note_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    noteId: integer('note_id').notNull(),
    body: text('body').notNull(),
    author: text('author'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('note_comments_note_idx').on(table.noteId), index('note_comments_created_idx').on(table.createdAt)],
);

/**
 * A refresh asked for from the hosted site. The pipeline runs on the machine that holds
 * `workie.db`, so a visitor cannot start one directly — they leave a request here and the
 * laptop claims it on its next poll.
 *
 * Written by the Vercel function, so this table is deliberately absent from `push:remote`'s
 * mirror list: the laptop reads it from Turso and must never overwrite it with its own copy.
 * `claimed_at` null is the queue; one unclaimed row is enough, however many people ask.
 */
export const refreshRequests = sqliteTable(
  'refresh_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requestedBy: text('requested_by'),
    requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).notNull(),
    claimedAt: integer('claimed_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    error: text('error'),
  },
  (table) => [
    index('refresh_requests_claimed_idx').on(table.claimedAt),
    uniqueIndex('refresh_requests_active_idx').on(sql`(1)`).where(sql`${table.completedAt} is null`),
  ],
);
