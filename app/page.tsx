import { desc } from "drizzle-orm";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TURSO_ENV, driver, getDb, needsTurso } from "@/lib/db";
import { connectorRuns } from "@/lib/db/schema";
import {
  BASES,
  TABS,
  WINDOW_MS,
  bare,
  cleared,
  parseParams,
  type Params,
  type RawSearchParams,
  type Tab,
  withBasis,
  withJob,
  withPage,
  withTab,
} from "@/lib/params";
import { rowChips } from "@/lib/chips";
import { countPostings, listPostings, outsideTargetLocations, ROW_CAP, tabIsEmpty, type Row } from "@/lib/query";
import { Drawer } from "./drawer";
import { BadgeChip, Filters, RowChip } from "./filters";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AppliedCheckbox } from "./applied-checkbox";
import { AppliedSync } from "./applied-sync";
import { AppHeader } from "./app-header";
import { getPrivateDb } from "@/lib/private-db";
import { returnedPostingUrls } from "@/lib/applications/runs";

/**
 * The table, described once: header label and width class together, in render order. `grow`
 * absorbs the slack and `clip` is capped; both truncate rather than wrap, and everything else
 * is sized by its content — so every row stays one line tall whatever the title length. The
 * full title is in the drawer, one click away, which is the right place for it. Engineering
 * caps the title because summary is the column that needs the slack there.
 */
interface Column {
  label: string;
  field?: string;
  className?: string;
}

const COLUMNS: Record<Tab, Column[]> = {
  design: [
    { label: "seen" },
    { label: "badges" },
    { label: "title", className: "grow" },
    { label: "pay rate", field: "pay" },
    { label: "location", className: "clip" },
    { label: "company" },
    { label: "apply" },
    { label: "applied" },
  ],
  engineering: [
    { label: "seen" },
    { label: "badges" },
    { label: "title", className: "clip" },
    { label: "summary", className: "grow" },
    { label: "pay rate", field: "pay" },
    { label: "level" },
    // `grad` was here and was empty on 2,427 of 2,511 rows (96.7%) — ~94px of em dashes
    // on a board whose first principle is density. `location` is null on 2. The 84 real
    // grad dates are not lost; they moved to the drawer, where a rare field belongs.
    { label: "location", className: "clip" },
    { label: "company" },
    { label: "apply" },
    { label: "applied" },
  ],
};

/** The width class for one column of the current tab, by the label it renders under. */
function width(tab: Tab, label: string): string | undefined {
  return COLUMNS[tab].find((column) => column.label === label)?.className;
}

/** Relative, because the only question ever asked of this column is "how stale is it". */
function ago(date: Date, now: number): string {
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const PERIOD: Record<string, string> = {
  hour: "hr",
  week: "wk",
  month: "mo",
  year: "yr",
};

function payRate(row: Row): string | null {
  const { payRateMin: min, payRateMax: max, payRatePeriod: period } = row;
  if (min === null && max === null) return null;
  const one = (n: number) =>
    period === "year" ? `${Math.round(n / 1000)}k` : String(Math.round(n));
  const span =
    min !== null && max !== null && min !== max
      ? `${one(min)}–${one(max)}`
      : one(min ?? max!);
  return `${row.payCurrencySymbol ?? "$"}${span}/${period ? PERIOD[period] : ""}`;
}

/** A cell with no value still says so. `fg-dim`, not `fg-faint`: it is content, and content
 *  has to clear AA — `fg-faint` is reserved for disabled controls, which WCAG exempts. */
function Nothing() {
  return <span className="text-fg-dim">&mdash;</span>;
}

function Badges({ row, p }: { row: Row; p: Params }) {
  return (
    // Never wraps: a badge cell that stacks would cost four rows of density for one posting.
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {/* `rowChips` decides what appears and in what order, and drops a label the row states
          twice — `employment_type` and `badges` both carry `internship`, which printed it twice
          here. Its own tests pin the rule; this maps the result to controls. */}
      {rowChips(row, p.tab).map((chip) =>
        chip.group === null ? (
          <BadgeChip key={`badge:${chip.value}`} p={p} value={chip.value} />
        ) : (
          <RowChip key={`${chip.group}:${chip.value}`} p={p} group={chip.group} value={chip.value} />
        ),
      )}
    </span>
  );
}

function PostingRow({ row, p, now }: { row: Row; p: Params; now: number }) {
  const pay = payRate(row);
  // The clock the table SORTS by. Showing `postedAt` here while ordering by `effectiveAt`
  // put "LAST 24 HOURS" above rows whose own cell read `668d`. The requisition date is not
  // lost — it stays in the tooltip, which is where a date you rarely need belongs.
  const seen = new Date(row.effectiveAt);
  const fresh = now - row.effectiveAt < WINDOW_MS.day;
  return (
    <tr data-fresh={fresh || undefined}>
      <td data-field="seen" className={fresh ? "nums" : "nums text-fg-dim"}>
        <time
          dateTime={seen.toISOString()}
          title={`first seen ${seen.toLocaleString()} · listed ${row.postedAt.toLocaleString()}`}
        >
          {ago(seen, now)}
        </time>
      </td>
      <td data-field="badges">
        <Badges row={row} p={p} />
      </td>
      {/* Identifying text, not a facet: no badge, no filter. `title` gives the long tail back
          on hover without costing a row of height. */}
      <td data-field="title" className={width(p.tab, "title")} title={row.title}>
        <span className="posting-title">{row.title}</span>
        <span className="posting-location">{row.location ?? <Nothing />}</span>
      </td>
      {p.tab === "engineering" ? (
        <td data-field="summary" className={`${width(p.tab, "summary")} text-fg-dim`}>
          {row.summary ?? <Nothing />}
        </td>
      ) : null}
      <td data-field="pay" className="nums">{pay ?? <Nothing />}</td>
      {p.tab === "engineering" ? (
        <td data-field="level" className="text-fg-dim">{row.seniority ?? <Nothing />}</td>
      ) : null}
      <td data-field="location" className={`text-fg-dim ${width(p.tab, "location") ?? ""}`} title={row.location ?? undefined}>
        {row.location ?? <Nothing />}
      </td>
      {/* The drawer trigger. One per row, so the tab order through the table stays short. A
          plain anchor: the drawer opens it through native history (see `Drawer`). */}
      <td data-field="company">
        <a
          href={withJob(p, row.id)}
          data-job
          title={row.company}
          className="icon-chevron inline-flex max-w-full items-center gap-1"
        >
          <span>{row.company}</span>
        </a>
      </td>
      <td data-field="apply">
        <a
          className="link-out icon-external"
          data-posting-id={row.id}
          href={row.canonicalUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {row.canonicalUrl.startsWith("https://remotive.com/") ? "Apply via Remotive" : "Apply"}
        </a>
      </td>
      <td data-field="applied">
        <AppliedCheckbox postingId={row.id} title={row.title} company={row.company} compact />
      </td>
    </tr>
  );
}

function Command({ children }: { children: string }) {
  return <code>{children}</code>;
}

/** Design's location rule is not a filter, so `clear` cannot lift it. An empty table that
 *  blames the ingest when geography is the real cause sends the reader to run a command that
 *  already worked, so the count decides which of the two true explanations to give. */
function Elsewhere({ count }: { count: number }) {
  return (
    <p className="mt-3">
      Design shows the target locations only. {count}{" "}
      {count === 1
        ? "posting is listed outside them and is not"
        : "postings are listed outside them and are not"}{" "}
      on this tab; Engineering shows every location.
    </p>
  );
}

function Empty({ outside }: { outside: number }) {
  return (
    <div className="prose max-w-lg py-12">
      {outside > 0 ? (
        <>
          <p>Nothing on this tab is in the target locations.</p>
          <Elsewhere count={outside} />
        </>
      ) : (
        <>
          <p>
            Nothing in the database for this tab. Run{" "}
            <Command>npm run ingest</Command> to poll the connectors, then{" "}
            <Command>npm run enrich</Command> to classify what came back.
          </p>
          <p className="mt-3">
            For fixtures instead of live postings: <Command>npm run seed</Command>.
          </p>
        </>
      )}
    </div>
  );
}

/** The deployment URL exists before the Turso database does, so the first thing the hosted
 *  site is asked to render is often this. Name the two variables rather than throwing. */
function NotConfigured() {
  return (
    <main className="board-page" id="main-content">
      <AppHeader current="/" />
      <h1 className="board-title">Job board unavailable</h1>
      <div className="prose max-w-lg py-12">
        <p>No database is configured for this deployment.</p>
        <p className="mt-3">
          Create a Turso database and set{" "}
          {TURSO_ENV.map((name, index) => (
            <span key={name}>
              {index > 0 ? " and " : ""}
              <Command>{name}</Command>
            </span>
          ))}{" "}
          in the project&rsquo;s environment variables, then redeploy. Mirror the local corpus
          into it with <Command>npm run push:remote</Command>.
        </p>
      </div>
    </main>
  );
}

function NoMatches({ p, outside }: { p: Params; outside: number }) {
  return (
    <div className="prose max-w-lg py-12">
      <span className="flex items-baseline gap-3">
        <p>No postings match these filters.</p>
        <Link href={cleared(p)} className="btn" scroll={false}>
          Clear filters
        </Link>
      </span>
      {outside > 0 ? <Elsewhere count={outside} /> : null}
    </div>
  );
}

/** One step of the pager. At either end it stays in place, disabled, so the count never shifts. */
function PageStep({ p, to, pages, label }: { p: Params; to: number; pages: number; label: string }) {
  const icon = to < p.page
    ? <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
    : <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />;
  return to >= 1 && to <= pages ? (
    <Link className="btn icon" href={withPage(p, to)} aria-label={label} title={label}>{icon}</Link>
  ) : (
    <span className="btn icon" role="link" aria-disabled="true" aria-label={label}>{icon}</span>
  );
}

const CRAWLER = /bot|crawl|spider|externalagent|externalhit|externalfetcher/i;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const p = parseParams(raw);

  // NO REDIRECT HERE, and it is not an omission.
  //
  // The filter form is a GET form, so it submits every control including the ones left on
  // "any" — `?type=&pay=&mode=`. This used to `redirect(href(p))` to tidy those away so the
  // address bar matched what the badge links write. That redirect broke the filter button
  // outright: `next/form` submits through a client-side navigation, and a `redirect()` thrown
  // while this page is already streaming (it has a `loading.tsx`) leaves the router with an
  // empty tree — a blank page at the un-normalized URL, no table, no filter row. Reproduced on
  // both a real click and a plain navigation; a native full-page GET redirected fine, which is
  // exactly why it survived being tested by hand.
  //
  // Nothing needs the redirect. `parseParams` already reads `?type=` as "no filter", so this
  // renders precisely what the tidy URL would have rendered — asserted in query.test.ts — and
  // every link on the page is written by `href(p)`, so the empty params never propagate. The
  // only cost is a scruffy address bar until the next badge, tab or clear click rewrites it.
  //
  // To tidy it anyway, do it AFTER render from the client (`router.replace` in an effect), not
  // by refusing to render on the server.

  // robots.txt already forbids query-string views; meta-externalagent ignored it and made 1.5M
  // board requests in Oct 2026, each reading ~100k rows (list + count over every live posting).
  if (Object.keys(raw).length && CRAWLER.test((await headers()).get("user-agent") ?? "")) notFound();

  if (needsTurso()) return <NotConfigured />;

  const now = Date.now();
  const db = getDb();
  // Roles Auto Apply gave up on come back here. The board still renders when the private store is down.
  const returned = await Promise.resolve().then(() => returnedPostingUrls(getPrivateDb())).catch(() => []);

  // In parallel: independent reads, and against Turso every await is a network round trip.
  const [fetched, total, lastRun] = await Promise.all([
    listPostings(db, p, now, returned),
    countPostings(db, p, now, returned),
    driver(db)
      .select({ startedAt: connectorRuns.startedAt })
      .from(connectorRuns)
      .orderBy(desc(connectorRuns.startedAt))
      .limit(1)
      .get(),
  ]);

  // `listPostings` returns one more than it will render; the count, in the same round trip,
  // is what says how many pages there are.
  const rows = fetched.slice(0, ROW_CAP);
  const pages = Math.max(1, Math.ceil(total / ROW_CAP));

  const freshCount = rows.filter(
    (row) => now - row.effectiveAt < WINDOW_MS.day,
  ).length;
  const columns = COLUMNS[p.tab];

  return (
    <main className="board-page" id="main-content">
      <AppHeader current="/" />

      <section className="board-intro" aria-label="Job board overview">
        <div className="board-heading">
          <h1 className="board-title">{p.tab === "design" ? "Design" : "Engineering"} jobs</h1>
          <p className="board-summary nums">
            <span className="stat"><b>{rows.length}</b> {rows.length === 1 ? "role" : "roles"} on this page</span>
            <span className="stat ready"><b>{freshCount}</b> new in the last 24 hours</span>
            <span className="board-updated">
              {lastRun ? `Updated ${ago(lastRun.startedAt, now)} ago` : "No ingest run yet"}
            </span>
          </p>
        </div>
        <div className="board-switches">
        <nav className="board-track" aria-label="Track">
          {TABS.map((tab) => (
            <Link
              key={tab}
              href={withTab(p, tab)}
              scroll={false}
              aria-current={tab === p.tab ? "page" : undefined}
              className="board-track-link"
            >
              {tab === "design" ? "Design" : "Engineering"}
            </Link>
          ))}
        </nav>
        {/* The Design split. A partition of the tab rather than a filter, so it sits with the
            tabs and not in the filter row: there is no "any", one side is always showing, and
            `clear` does not reset it. Absent on Engineering, where `basis` is null. */}
        {p.basis ? (
          <nav className="board-track" aria-label="Engagement">
            {BASES.map((basis) => (
              <Link
                key={basis}
                href={withBasis(p, basis)}
                scroll={false}
                aria-current={basis === p.basis ? "true" : undefined}
                className="board-track-link"
              >
                {basis}
              </Link>
            ))}
          </nav>
        ) : null}

        </div>
      </section>

      <Filters p={p} />

      {/* Filter changes navigate on the client and replace only what is in here; the filter
          form dims it while the new rows are on their way. */}
      <div id="board-results" className="board-results">
      {rows.length === 0 && p.page > 1 ? (
        <div className="flex items-center gap-3 py-8">
          <p>No jobs on this page.</p>
          <Link href={withPage(p, 1)} className="btn">First page</Link>
        </div>
      ) : rows.length === 0 ? (
        // The counts below are the only extra queries, and only on a page with no rows: the
        // empty state asks about the tab, the zero-result state asks about these filters.
        (await tabIsEmpty(db, p, now, returned)) ? (
          <Empty outside={await outsideTargetLocations(db, bare(p), now, returned)} />
        ) : (
          <NoMatches p={p} outside={await outsideTargetLocations(db, p, now, returned)} />
        )
      ) : (
        <div className="sheet-wrap min-h-0 flex-1 overflow-auto" role="region" aria-label="Job results" tabIndex={0}>
          <table className="rows" data-track={p.tab} style={{ minWidth: p.tab === "design" ? 900 : 1384 }}>
            <caption className="sr-only">
              {p.tab} postings, newest first
              {p.tab === "design" ? ", target locations only" : ""}
              {p.basis ? `, ${p.basis} roles` : ""}
            </caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.label} data-field={column.field ?? column.label} scope="col" className={column.className}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <PostingRow key={row.id} row={row} p={p} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && p.page <= pages ? (
        <nav aria-label="Job pages" className="board-pages">
          <PageStep p={p} to={p.page - 1} pages={pages} label="Previous page" />
          <span className="nums">page {p.page} of {pages}</span>
          <PageStep p={p} to={p.page + 1} pages={pages} label="Next page" />
        </nav>
      ) : null}
      </div>

      <Drawer closeHref={withJob(p, null)} />
      <AppliedSync />
    </main>
  );
}

export const dynamic = "force-dynamic";
