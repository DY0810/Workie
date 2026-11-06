# Workie

Job dashboard. Next.js 15 (App Router) + TypeScript + Tailwind v4 + Drizzle ORM.
GitHub Actions owns the collection database; the hosted site reads its Turso mirror.
Local development uses a separate SQLite snapshot.

## Commands

```bash
npm run dev          # dev server at http://localhost:3000
npm run build        # production build
npm run db:migrate   # apply schema to workie.db (run `db:generate` first after schema changes)
npm test             # run the vitest suite

npm run ingest       # poll every due connector, dedupe, write postings
npm run enrich       # deterministic extraction over the whole corpus (~2s, no network, no cost)
npm run linkcheck    # does every stored apply link still lead to a live posting?
npm run status       # last run per connector, what it brought back, when it goes again
npm run refresh      # one full cycle, exactly as launchd runs it
```

## Unattended refresh

`scripts/refresh.sh` runs ingest, then enrich, plus linkcheck once a week. The scheduled home
for it is **GitHub Actions** (`.github/workflows/refresh.yml`): at minutes 17 and 47 a runner
restores `workie.db` from the Actions cache (or rebuilds it from Turso via
`npm run pull:remote` when the cache is cold), runs the same script, and mirrors the result
back up. It needs two repository secrets — `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` — and
no laptop. GitHub can delay scheduled runs; the cron expression is not a freshness guarantee.
The cache key includes the run attempt, so rerunning an old workflow restores the newest
writer state instead of that workflow's historical snapshot. A cold bootstrap publishes its
database atomically and is never cached if bootstrap fails.

**Exactly one machine may run the cycle.** Two writers each ingesting into their own
`workie.db` assign different ids to new postings, and each mirror then deletes the other's
rows as strays. With the workflow live, keep the launchd agent below uninstalled.

The hosted refresh button queues one active request in `refresh_requests`; simultaneous
clicks share it. Set `WORKIE_GH_TOKEN` (a fine-grained PAT restricted to this repository,
Actions read/write) in the Vercel project for immediate dispatch. Without that token the UI
reports that it is waiting for the next scheduled run, rather than promising a start time.
The runner records success only after the mirror completes; failures retain their outcome,
and completed requests are never claimed again. A lost claim is recoverable after the
workflow's maximum runtime.

### Independent Scheduler

The GitHub `schedule` event is a best-effort fallback, not a dependable half-hour clock.
The production-only `GET /api/cron/refresh` endpoint lets an external scheduler such as
cron-job.org wake the same Actions workflow without adding another database writer.
Vercel Hobby does not support a cron expression that runs every 30 minutes.

Configure these **Production environment variables in Vercel**, then redeploy:

- `WORKIE_GH_TOKEN`: a fine-grained GitHub token restricted to `DY0810/Workie`
  with Actions read/write and the required Metadata read permission. Renew it before expiry.
- `CRON_SECRET`: a separate, randomly generated secret. Keep the GitHub token in Vercel;
  give the external scheduler only this narrower trigger secret.

Configure the external job for every 30 minutes, method GET:

```text
URL: https://job-dashboard-one-sigma.vercel.app/api/cron/refresh
Authorization: Bearer <CRON_SECRET>
```

A 202 response means GitHub accepted the dispatch or an existing claim is still active,
not that ingestion has finished. Failed dispatches return 502; missing configuration
returns 503. Later authenticated ticks retry unclaimed requests and expired claims,
while ordinary public refresh clicks remain coalesced. Keep the GitHub schedule enabled
as a fallback and verify the external job's execution history after enabling it.

### Source Configuration And Catch-up

Collection keys belong in **GitHub repository Actions secrets**, not only in Vercel.
The workflow forwards `JOOBLE_KEY` and `MUSE_API_KEY` when present. A configured key does not override a source's
robots policy.

Remotive uses its explicitly published public RSS feed, not its robots-blocked JSON API.
Listings retain Remotive links and attribution, and an entry aging out of the feed is not
treated as a closed job. Glean uses the `gleanwork` Greenhouse board linked by its own
careers page; the former SmartRecruiters mapping was not its current board.

SmartRecruiters, Adzuna, Careerjet and USAJobs connectors were removed: each API host's robots.txt refuses
crawling, and API documentation alone does not override this project's robots policy. The
`smartrecruiters` entries left in `scripts/companies.json` are not polled. Muse and Jooble still need their
provider-issued API keys in GitHub Actions secrets.

The Muse requires app registration beyond testing. It is disabled without its
registered API key. Its public API rejects page 100, so the connector walks the
company directory and company/category partitions, splitting oversized partitions
by supported levels and reporting any remaining provider limits.

Large paginated feeds keep `connector_checkpoints` inside the Actions database cache.
A checkpoint advances only after its returned postings commit. Pending imports bypass the
normal completed-scan cadence, but retain the per-host rate limit and robots checks.
Incremental chunks do not ghost-delist jobs from other chunks.

For a bounded initial catch-up **on the cloud writer**, use:

```bash
gh workflow run refresh.yml --repo DY0810/Workie -f catch_up=true
```

The runner refreshes normally, then advances only pending catalogs, enriching and mirroring
after each batch. Manual catch-up uses up to 1,000 source pages per batch; ordinary cycles
use 100. Both retain the same per-host rate limits. It stops on error, no progress, or
its 75-minute catch-up budget. Exit 75
means more catch-up remains; a later dispatch resumes from the saved cursor. This mode
defers the lengthy weekly link check to an ordinary run.

To verify particular connectors before their next scheduled poll:

```bash
gh workflow run refresh.yml --repo DY0810/Workie -f refresh_sources=amazon,workday
```

This bypasses only the polling interval for those names. Credential requirements,
robots rules and request rate limits still apply; the ordinary cycle then enriches
and mirrors their results.

### GitHub Job Lists

The following additional repositories are polled every three hours through GitHub's
rendered-content API. The Actions job uses its built-in, read-only `GITHUB_TOKEN`;
no extra repository secret is required.

| Connector | Repository | Lists |
| --- | --- | --- |
| `vansh-internships` | `vanshb03/Summer2027-Internships` | Summer internships |
| `speedyapply-ai` | `speedyapply/2027-AI-College-Jobs` | US and international internships and new-grad roles |
| `speedyapply-swe` | `speedyapply/2027-SWE-College-Jobs` | US and international internships and new-grad roles |
| `jobright-software` | `jobright-ai/2026-Software-Engineer-Internship` | Recent software internships |
| `jobright-engineering` | `jobright-ai/2026-Engineer-Internship` | Recent engineering internships |
| `jobright-marketing` | `jobright-ai/2026-Marketing-Internship` | Recent marketing internships |
| `jobright-design` | `jobright-ai/2026-Design-Internship` | Recent design internships |
| `jobright-art` | `jobright-ai/2026-Art-Internship` | Recent art internships |

The Vansh and SpeedyApply 2026 repository URLs now redirect to their 2027 names.
Jobright's URLs retain 2026. Jobright supplies links to its own listings, not
employer-direct application links; company links to LinkedIn are never followed.
Existing track, location, seniority and pay filters still apply. Missing pay stays
unknown, and any salary is source-supplied rather than independently verified.
Select **paid** and **pay not listed** together to include unknown pay while excluding
explicitly unpaid jobs; **save defaults** keeps that choice in this browser.
Unknown pay is labeled on each row, and explicit pay statements in job titles count too.

These are curated snapshots, not complete employer catalogs. Their runs are marked
partial so a row aging out of a list does not count as evidence that the job closed.
Normal link checks still apply. A failed file does not discard successful sibling
files or stop the other connectors.

### Browsing Jobs

Each page contains at most 200 jobs; Previous/Next reaches the remaining matching results.
Filters reset pagination, while opening and closing a job preserves it. The Seen filter,
fresh band and ordering use the same effective first-seen clock; the source's original
posting date remains in the timestamp tooltip.

The desktop view remains a table. On phones the same rows arrange title, company, Apply,
pay and badges vertically without hiding the other fields. Salary symbols are preserved;
wellness budgets and other benefits are not treated as the salary.

Applied checkboxes appear at the end of each row and posting detail. Checkmarks and
**Save defaults** preferences stay in this browser, not on the shared board. Saved defaults
fill a bare landing URL; explicit filters and **Clear** override them without erasing them.

## Refreshing from the page

On local development servers, `POST /api/refresh` starts a cycle on that machine, so it is off unless
`WORKIE_ALLOW_LOCAL_REFRESH=1`. That request carries no body or custom header, which makes it
a CORS simple request any page could fire at a dev server — and the cycle it starts ends by
mirroring to the hosted database, deleting rows the Actions lineage wrote.

### Running it on a laptop instead

Install it as a launchd user agent (from the repo root) to have it run every 30 minutes:

```bash
mkdir -p logs   # launchd opens StandardOutPath before the script runs; it will not create it
sed -e "s|__WORKIE_DIR__|$PWD|g" -e "s|__NODE_BIN__|$(dirname "$(command -v node)")|g" \
  scripts/com.workie.refresh.plist > ~/Library/LaunchAgents/com.workie.refresh.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.workie.refresh.plist
```

Both substitutions matter. launchd hands a job a bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
so an nvm- or homebrew-installed `node` is not found — the usual reason a launchd job appears
to do nothing at all.

```bash
launchctl kickstart -p gui/$(id -u)/com.workie.refresh   # run one cycle now
launchctl print gui/$(id -u)/com.workie.refresh          # state and last exit status
launchctl bootout gui/$(id -u)/com.workie.refresh        # stop and uninstall
```

Logs land in `logs/refresh-YYYY-MM-DD.log`, one file a day, pruned after a fortnight.

### Poll cadence

The 30-minute cycle is a ceiling, not a schedule. Each connector declares a `minIntervalMs`
and is skipped while its last **successful** run is more recent than that, so the sources that
cannot have changed are not asked.

| Source | Interval | Why |
| --- | --- | --- |
| ATS boards — Greenhouse, Lever, Ashby, Workable, Recruitee | every cycle | Where a new posting appears first. This is the point of the tool. |
| `hn` | 6h | "Who is Hiring" is one thread a month. |
| Repository lists: Simplify, Vansh, SpeedyApply, Jobright | 3h | Curated GitHub job tables. |
| RSS + smaller aggregators — Remotive, WeWorkRemotely, Dribbble, Jobspresso, Working Nomads, RemoteOK, Arbeitnow, Braintrust, Jobicy | 1h | Provider feeds may expose a bounded window rather than the full catalog. |
| Muse | 1h after a completed sweep | Design and Science-and-Engineering scopes, with resumable category pagination. |
| Keyed aggregators — Jooble | 6h | Metered free tiers, measured in calls per month. |

A cadence skip and a missing-key skip are logged apart (`kind: cadence` / `kind: config`) and
neither writes a `connector_runs` row — ghost detection counts a posting absent only against
a run that actually succeeded, so a source that sat out a cycle accrues nothing.

## Design sources

The Design tab is fed differently from Engineering, because design work is published
differently. Three tiers, in descending order of how much they actually contribute:

| Source | What it adds | Note |
| --- | --- | --- |
| `companies.json` design employers | US-based, non-remote, employed design roles | 16 studios and 23 design-led product companies were seeded; 29 confirmed a board. The ATS tier is the only one that reaches an employer's own listing, and the only one carrying office-based US roles. |
| `weworkremotely-design`, `dribbble` | Design-only boards | WWR's design feed states employment type per item in `<type>`, which is where contract design work comes from. Dribbble is design-only but publishes no description — the whole posting is one sentence in the title. |
| `braintrust` | US freelance design | `?role=3` is Braintrust's own Design filter. Every row is freelance with structured US city/state. Small (single digits) but the only verified source of its kind. |

Sources that were evaluated and rejected, so they are not re-litigated: Freelancer.com
ignores its own `category` parameter and publishes company-less gig projects; Authentic Jobs'
feed is now a blog; Coroflot's robots.txt is `Disallow: /`; Core77, Krop, AIGA and Contra
publish no usable feed.

### The Design freelance split

The Design tab is partitioned, not filtered — `employed` and `freelance`, one always on,
`?basis=freelance` in the URL. `freelance` covers `contract` as well, because the extractor
writes `freelance` only when a posting says the word and the same engagement described as "a
6-month contract role" lands as `contract`. An employment type that was never determined
belongs to the employed side; it is not freelance, and a row that matched neither side would
vanish from the tab entirely.

The `type` dropdown narrows to the side being shown, so no reachable URL asks for a full-time
freelance posting. Engineering has no split and no `basis`.

## Deploying

Hosted on the **personal** Vercel account (`dongyeop0810@gmail.com`) reading the Turso mirror.
`scripts/setup-hosting.sh` walks the parts that cannot be automated.

Commits land on `main` by **direct push, not through pull requests**, and that is deliberate.
Vercel only deploys a pushed commit when its author is an identity on the Vercel account, and
GitHub re-authors a squash-merged PR to the public email of the account that opened it — which
put a work address back on `main` even with `user.email` set correctly here. A direct push keeps
the author this repo is configured with:

```bash
git config user.email    # dongyeop0810@gmail.com, set repo-locally
```

A deployment already blocked this way needs no new commit — Redeploy from the dashboard is
authorized by you rather than by the commit author.

## Database

SQLite file at `./workie.db`, created by `npm run db:migrate`. Not committed — see
`.gitignore`. Schema lives in `lib/db/schema.ts`, migrations in `./drizzle`.

## Everything else

See [`plans/workie.md`](plans/workie.md) for architecture, phases, and gates.
