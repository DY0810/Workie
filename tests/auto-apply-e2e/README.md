# Auto Apply local end-to-end harness

A real Next server, real local databases and a real worker process, driven through the real UI.
Nothing touches production: no `.env` file is loaded (the stack refuses to start if one exists here),
every child gets an allowlisted environment with no `TURSO_*`, and the keychain is never opened.

## Run

```sh
node tests/auto-apply-e2e/stack.mjs test              # next build, bring the stack up, run the spec, tear down
node tests/auto-apply-e2e/stack.mjs test --no-build   # reuse the existing .next build (~35 s)
```

To keep the stack up and iterate on the spec:

```sh
node tests/auto-apply-e2e/stack.mjs --no-build        # prints the state.json path; Ctrl-C stops everything
E2E_STATE=<state.json> npx playwright test --config=tests/auto-apply-e2e/playwright.config.ts
```

Set `E2E_WORKER_HEADED=1` to watch the worker's Chrome window fill the form. The worker's browser waits
`E2E_WORKER_SLOWMO` ms (default 400) per action: the local fixture otherwise fills in about a second, too fast for
Live's 3 s poll to show a fill in progress.

Each run writes to `logs/auto-apply-e2e/<timestamp>/` (gitignored): `catalog.db`, `private.db`, `server.log`,
`worker.log`, `worker-pair.log`, `ollama-calls.json`, `state.json` (base URL and the local passcode) and
Playwright traces. Documents, the worker directory and the worker's credential file go in
`$TMPDIR/workie-auto-apply-e2e-<timestamp>/`, because the app and the worker refuse directories inside the repository.
Neither folder is deleted on teardown, so you can inspect it afterwards; delete old ones yourself.

## What the spec does

`auto-apply.pw.ts`, one ordered test, all through the UI:

- **a.** Unlocks as DY, fills the Profile (name, email, LinkedIn, phone, US work authorization with no sponsorship, US
  country preference) and uploads a generated DOCX resume as the role's master. Pairs and starts the worker CLI *before*
  any provider is set, then picks the local provider and saves and enables a policy (Greenhouse, US, read/tailor/fill/submit,
  resume only, `local:ollama`, two per employer, `confirmed_only` disclosure) and presses **Start auto apply now**.
- **b.** Only role 4000001 is in the catalog. Live shows its card with the worker's screenshot, which changes while it fills;
  it then waits in **Needs action** on "Why are you interested in Fixture Co?" and "How did you hear about this job?".
- **c.** Answers both: the textarea grows as it is typed into, the dropdown lists every option.
- **d.** The form is filled again and waits for approval on Live; two answers are changed there and survive a reload.
- **e.** Adds role 4000002 to the catalog (`catalog.mjs`); the run's next rescan (about a minute) queues it, and it asks
  only the essay: the dropdown answer is reused from role 1.
- **f.** Presses Apply on role 1, enters the fixture's emailed code `ABCD1234` in the Live card, and the role lands in
  **Applied** with the changed answers under "What you sent".
- **g.** Answers role 2's essay; it waits for approval with the reused choice filled. It is never submitted.

Screenshots of the key moments go to `logs/auto-apply-e2e/screens/` (overwritten each run).

## Real vs faked

| Piece | |
| --- | --- |
| Next app, routes, auth, household passcode | Real (`next build` + `next start` on 127.0.0.1) |
| Catalog DB | Real SQLite, migrated fresh; Fixture Co "Software Engineering Intern" 4000001 at start, 4000002 added mid-run |
| Private DB, document storage | Real local SQLite and a private local directory |
| Worker | Real `worker/main.ts` pair/start, real Playwright Chrome (headless by default) |
| Keychain, grant prompt | Faked by `worker-preload.mjs`: a 0600 JSON file instead of the OS keychain, the grant on stdin instead of a TTY |
| Tailoring provider | Fake Ollama in `stack.mjs`: the capability check picks the first label; tailor drops the last word of one resume line. The worker's real document runtime makes and verifies the tailored DOCX |
| Greenhouse form | The worker's own fixture (`worker/ats/greenhouse-fixture.ts`), served by Playwright routing; no request reaches Greenhouse |
| Emailed code | The fixture's `ABCD1234`, typed into the Live card's code box |

## Things to know

- **Submit is not guarded locally.** `lib/applications/submissions.ts` only limits submits to the fixture tenant when
  `VERCEL` is set. Locally any tenant could be submitted, so this harness is safe only because the catalog holds
  fixture roles alone, served by the worker's own fixture route, and the policy leaves out `submit_without_review`.
- **DNS is needed.** `worker/browser.ts` resolves `job-boards.greenhouse.io` before the fixture route answers, so the
  machine must be online even though no HTTP request leaves it.
- **Both roles have the same title.** The worker compares the page's `<title>` with the role
  (`worker/ats/greenhouse.ts`, `ATS_IDENTITY_MISMATCH`), and the fixture page always names "Software Engineering Intern".
- **The worker may start before the provider is enabled.** Its setup re-reads the provider config on each call
  (`worker/main.ts`), so the spec enables it after the worker is online to prove no restart is needed.
- The per-employer cap defaults to 1; the spec sets 2 so both Fixture Co roles run (for answer-reuse tests).
