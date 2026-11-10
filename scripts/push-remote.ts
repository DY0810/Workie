/**
 * `npm run push:remote` — mirror the local corpus into the hosted Turso database.
 *
 * The write pipeline stays where it is. Ingest, enrich, ghost and linkcheck all run against
 * the local `workie.db` with the synchronous driver and their transactions intact; this
 * copies the result up afterwards, so a hosted read replica costs the pipeline nothing.
 *
 * Idempotent, by upsert rather than by replace: every row is written under its local id and
 * overwrites whatever is there. That is what makes it safe to run at the end of every refresh
 * cycle, and it means a batch that fails leaves the site serving a complete-but-older corpus
 * rather than a half-empty one.
 *
 * Migrations are applied first, and drizzle's migrator skips the ones already recorded — so a
 * first run bootstraps an empty database and later runs are a no-op on that step.
 *
 *   npm run push:remote
 *   npm run push:remote -- --to=file:/tmp/mirror.db     a local libSQL file, no account
 *
 * Strays ARE deleted, and they have to be. This used to say that nothing here deletes, on the
 * grounds that ingest never removes a posting — delisting is a column. `merge:duplicates`
 * broke that: it collapses duplicate rows, and an upsert alone cannot express a deletion, so
 * the remote kept serving rows the local corpus had merged away. It also FAILED outright, and
 * the failure is worth keeping in mind because it is not obvious. Merging freed a `dedupe_key`
 * locally, the next ingest moved that key onto the surviving row, and upserting that row into a
 * remote where the deleted twin still held the key violated the UNIQUE index. Deleting first is
 * what makes the key available before anything claims it.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createClient, type Client } from '@libsql/client';
import { getTableColumns, getTableName, gt, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

import { MIGRATIONS_DIR, openDb, retryingFetch, type Db, type TursoDb } from '../lib/db/index.ts';
import * as schema from '../lib/db/schema.ts';

/** Parents before children: `posting_sources.posting_id` references `postings.id`. */
export const TABLES = [schema.postings, schema.postingSources, schema.connectorRuns] as const;
export type Mirrored = (typeof TABLES)[number];

/**
 * Rows per statement. Every column of every row is a bind parameter, and `postings` is ~30
 * columns wide with a full description in one of them — 100 keeps both the parameter count
 * and the request body well inside SQLite's and Turso's limits.
 */
const BATCH = 100;
/** Local rows read per page while mirroring. */
const PAGE = 5000;

/** `set` for an upsert that overwrites every non-key column with the row being inserted. */
function overwrite(table: Mirrored): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([, column]) => !column.primary)
      .map(([key, column]) => [key, sql.raw(`excluded.${column.name}`)]),
  );
}

/**
 * Remote ids the local corpus no longer has. Read back and diffed in memory rather than
 * expressed as `delete where id not in (...)`: the local corpus is ~15,000 rows, and inlining
 * that many bind parameters is the one thing BATCH exists to avoid.
 *
 * Children first at the call site, for the same reason the insert order is parents first.
 */
async function deleteStrays(remote: TursoDb, table: Mirrored, keep: Set<number>): Promise<number> {
  const remoteIds = (await remote.select({ id: table.id }).from(table)).map((row) => row.id);
  const strays = remoteIds.filter((id) => !keep.has(id));
  for (let start = 0; start < strays.length; start += BATCH) {
    await remote.delete(table).where(inArray(table.id, strays.slice(start, start + BATCH)));
  }
  return strays.length;
}

/**
 * What was last successfully pushed, by content hash. LOCAL ONLY — deliberately not in
 * `TABLES`, created here with raw DDL rather than a migration, so it never reaches the remote
 * schema and no migration has to run to introduce it.
 *
 * It rides inside `workie.db`, which means it travels with the Actions cache for free and a
 * cold start (an empty file rebuilt by `pull-remote`) simply finds no hashes and mirrors
 * everything once, exactly as before.
 *
 * Keyed by TARGET as well as row: `--to=file:/tmp/mirror.db` is a supported destination, and
 * without the target in the key a mirror to a scratch file would convince the next Turso push
 * that every row had already been sent.
 */
const MIRROR_STATE_DDL = `create table if not exists mirror_state (
  target text not null,
  table_name text not null,
  row_id integer not null,
  hash text not null,
  primary key (target, table_name, row_id)
) without rowid`;

/**
 * Columns that change on every run WITHOUT the row's meaning changing, and so must not count
 * as a difference worth a write.
 *
 * `enriched_at` is the whole reason this exists. `enrich` stamps one timestamp per run onto
 * every row it processes — all 24,544 of them, whether the extraction changed or not — so
 * hashing the raw row made every posting look new on every cycle and the "incremental" mirror
 * still wrote the entire corpus. That is 35M writes a month against a 10M allowance.
 *
 * Safe to ignore because nothing hosted reads it: `enrichedAt` is referenced only by
 * `status.ts` and `merge-duplicates.ts`, both local-only, and never by `lib/query.ts` or any
 * page. The remote's copy simply lags, and any row written for a REAL change carries the
 * current value along with it.
 */
const VOLATILE: Record<string, readonly string[]> = {
  postings: ['enrichedAt'],
  // `last_seen_run` is stamped with the current run id on EVERY source the cycle polled, so
  // every one of ~26,000 source rows differed every cycle and the "incremental" mirror wrote
  // all of them — ~18.7M row writes a month against a 10M allowance. Same argument as
  // `enrichedAt`: it records when we last looked, not what we found, and nothing hosted reads
  // it. `lib/query.ts` never selects from posting_sources at all; only dedupe/ghost/ingest do,
  // and those run locally against workie.db.
  posting_sources: ['lastSeenRun'],
};

/** Stable because drizzle returns row objects in schema column order on every call. */
function rowHash(row: Record<string, unknown>, table: Mirrored): string {
  const skip = VOLATILE[getTableName(table)];
  const content = skip
    ? Object.fromEntries(Object.entries(row).filter(([key]) => !skip.includes(key)))
    : row;
  return createHash('sha1').update(JSON.stringify(content)).digest('hex');
}

/**
 * Mirror only what CHANGED.
 *
 * This used to upsert every local row every cycle: ~53,000 writes for `postings` +
 * `posting_sources` + `connector_runs`, 48 times a day, ~76M row writes a month. Turso counts
 * an upsert that changes nothing as a write like any other, and eventually answered every
 * statement with `BLOCKED: SQL write operations are forbidden`, which stopped the dashboard
 * updating at all. Real churn is a few hundred rows a cycle — new postings, a delisting, that
 * cycle's connector_runs — so hashing each row against what was last pushed cuts the write
 * volume by one to two orders of magnitude and keeps the result byte-identical.
 */
export async function mirrorTable(
  remote: TursoDb,
  local: Db,
  table: Mirrored,
  target: string,
): Promise<number> {
  local.run(sql.raw(MIRROR_STATE_DDL));
  const name = getTableName(table);

  const seen = new Map(
    (local.all(sql`select row_id, hash from mirror_state where target = ${target} and table_name = ${name}`) as {
      row_id: number;
      hash: string;
    }[]).map((r) => [r.row_id, r.hash]),
  );

  // One page of rows in memory at a time: loading all of `postings` (a full description per
  // row) at once passed Node's 4 GB heap on 2026-11-10 and no cycle could mirror.
  const live = new Set<number>();
  let pushed = 0;
  for (let after = 0; ; ) {
    // `select()` decodes (Date, boolean, parsed JSON) and `insert()` re-encodes, so the round
    // trip goes through the schema rather than around it.
    const rows = local.select().from(table).where(gt(table.id, after)).orderBy(table.id).limit(PAGE).all() as {
      id: number;
    }[];
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    const changed: { row: { id: number }; hash: string }[] = [];
    for (const row of rows) {
      live.add(row.id);
      const hash = rowHash(row as Record<string, unknown>, table);
      if (seen.get(row.id) !== hash) changed.push({ row, hash });
    }
    pushed += changed.length;

    for (let start = 0; start < changed.length; start += BATCH) {
      const slice = changed.slice(start, start + BATCH);
      await remote
        .insert(table)
        // The three row shapes differ; the loop is the same. One cast here beats three copies.
        .values(slice.map((c) => c.row) as never)
        .onConflictDoUpdate({ target: table.id, set: overwrite(table) });
      // Recorded only AFTER the remote accepted the batch, so a failure mid-mirror leaves those
      // rows looking unpushed and the next run retries them rather than skipping them forever.
      for (const c of slice) {
        local.run(
          sql`insert into mirror_state (target, table_name, row_id, hash)
              values (${target}, ${name}, ${c.row.id}, ${c.hash})
              on conflict (target, table_name, row_id) do update set hash = excluded.hash`,
        );
      }
    }
  }

  // Forget rows that no longer exist locally; `deleteStrays` has already removed them remotely.
  for (const id of seen.keys()) {
    if (!live.has(id))
      local.run(sql`delete from mirror_state where target = ${target} and table_name = ${name} and row_id = ${id}`);
  }
  return pushed;
}

/**
 * Apply pending migrations on a client of their own, over plain `fetch` rather than
 * `retryingFetch`. A migration batch whose response is lost may have committed anyway (on 10/23,
 * building postings_board_idx over 370k rows outlasted the wait), and resending the same request
 * re-runs its statements: `DROP INDEX` failed on the index it had just dropped. Running `migrate`
 * again instead re-reads `__drizzle_migrations` and skips whatever the first attempt committed.
 */
export async function migrateRemote(client: Client): Promise<void> {
  const db = drizzle(client);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } catch {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }
}

export async function pushRemote(
  url: string,
  authToken: string | undefined,
): Promise<{ rows: number; deleted: number }[]> {
  await migrateRemote(createClient({ url, authToken }));
  const remote = drizzle(createClient({ url, authToken, fetch: retryingFetch }), { schema });

  const local = openDb();

  /**
   * Two passes, in opposite orders, and they cannot be folded into one: a stray
   * `posting_sources` row must be deleted BEFORE the posting it points at, while a new source
   * row must be inserted AFTER it. Doing both per-table in one reversed loop inserts the
   * children first and trips the foreign key — which is exactly what it did on the first try.
   */
  const deleted = new Map<Mirrored, number>();
  for (const table of [...TABLES].reverse()) {
    const keep = new Set((local.select({ id: table.id }).from(table).all() as { id: number }[]).map((row) => row.id));
    deleted.set(table, await deleteStrays(remote, table, keep));
  }

  const counts: { rows: number; deleted: number }[] = [];
  for (const table of TABLES) {
    counts.push({ rows: await mirrorTable(remote, local, table, url), deleted: deleted.get(table) ?? 0 });
  }
  return counts;
}

async function main(to: string | undefined): Promise<void> {
  const url = to ?? process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error(
      'no target: set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN), or pass --to=file:/path.db',
    );
  }

  const started = Date.now();
  // The token is never logged, and `url` is printed only when it carries no credentials.
  const counts = await pushRemote(url, process.env.TURSO_AUTH_TOKEN);
  const lines = TABLES.map(
    (table, index) =>
      `  ${getTableName(table)}  ${counts[index].rows}` +
      (counts[index].deleted > 0 ? `  (${counts[index].deleted} stray row(s) deleted)` : ''),
  );
  console.log(
    [`pushed to ${url.startsWith('file:') ? url : new URL(url).host}`, ...lines, `  ${Date.now() - started}ms`].join(
      '\n',
    ),
  );
}

/**
 * The same lock `scripts/refresh.sh` takes for a whole cycle, because a cycle ends with this
 * script and a hand-run `npm run push:remote` would otherwise mirror alongside it. Two
 * mirrors race: one deletes strays computed from its own snapshot while the other inserts
 * children, and `posting_sources.posting_id` trips — Turso enforces foreign keys, local
 * SQLite does not, so it only ever fails against the hosted database. Observed exactly that
 * way: a scheduled cycle and a manual push overlapped and the run died mid-table.
 *
 * A cycle already running will push when it finishes, so refusing here loses nothing.
 */
function takeLock(inCycle: boolean): (() => void) | null {
  // `refresh.sh` holds this lock for its whole cycle and calls this script at the end of it.
  // Without this the cycle's own mirror refuses its own lock — exit 0, nothing pushed, the
  // hosted site frozen at the previous cycle. Caught only by checking the remote's newest
  // run against the local one after a cycle that reported success.
  if (inCycle) return () => {};

  const dir = join(process.cwd(), 'logs');
  const lock = join(dir, '.refresh.lock');
  mkdirSync(dir, { recursive: true });
  try {
    mkdirSync(lock);
  } catch {
    const holder = Number(readFileSync(join(lock, 'pid'), 'utf8').trim());
    try {
      process.kill(holder, 0);
      return null; // A live cycle owns it; it will mirror at the end of its run.
    } catch {
      rmSync(lock, { recursive: true, force: true }); // Left by a cycle that died.
      mkdirSync(lock);
    }
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  return () => rmSync(lock, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ strict: true, options: { to: { type: 'string' }, 'in-cycle': { type: 'boolean' } } });
  const release = takeLock(values['in-cycle'] === true);
  if (!release) {
    console.log('a refresh cycle is running; it will mirror when it finishes');
    process.exit(0);
  }
  try {
    await main(values.to);
  } finally {
    release();
  }
}
