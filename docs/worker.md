# Standalone Worker

The worker is a Node 22 process, not a Workie browser tab, Vercel request, or
Codex session. Closing a client does not stop it. Host sleep or disconnect is
not continuous operation: a lost heartbeat, unsafe clock, expired lease, or
revocation closes mutation authority. Nothing is installed as a service.

The worker currently has a qualified Greenhouse browser adapter (any other ATS
lands in `blocked_unsupported`/`adapter_unavailable`), an owner-approved
structured provider contract (local Ollama, OmniRoute-compatible and BYOK
adapters) used for tailoring, cover letters and outreach, and immutable PDF/DOCX
artifact verification. A master resume alone is not treated as tailored: the
application stays at `needs_document` until a real edited artifact and
verification manifest are persisted. Filling is deterministic: the runner
observes the form and fills confirmed answers; no model chooses the action. A
low-confidence generation or a provider fault becomes resumable
`provider_unavailable` state, and the worker can continue with the next
application. Unapproved browser egress fails closed. Local Ollama requires a
numeric loopback endpoint; remote OmniRoute/BYOK
requires explicit consent and trusted non-unknown pricing, so it stays disabled
until those settings are persisted. Fallback execution and hosted encrypted
credential envelopes are not implemented. All ATS fixtures are synthetic; live
employer forms, provider requests and real submissions remain unverified.

## Runtime And Credentials

- Qualified runtime: Node **22.23.2**. Other Node major versions are rejected.
- Pinned worker-only dependency: `@napi-rs/keyring` **2.1.0**, MIT. Installation
  used `npm install --ignore-scripts --no-audit --no-fund` in the worktree with
  isolated HOME, TMPDIR, npm cache and unused scratch WORKIE_DB.
- macOS arm64: the native binding loads and exposes the declared methods.
  No personal keychain entry was constructed, read, enumerated, or written in
  qualification. Successful real keychain access/persistence is **not proven**.
- Linux: the pinned `Entry(service, account, {linux: {store: "secret-service"}})`
  API requires Secret Service; it throws instead of silently choosing volatile
  kernel keyutils. An unlocked persistent Secret Service, user D-Bus session,
  and supported packaged native architecture are prerequisites. Headless hosts
  without them fail closed. Linux runtime/keychain persistence was not tested.
- Windows: upstream has a Credential Manager binding, but this CLI rejects
  Windows until private-directory ACLs, atomic persistence, signals and process
  tests are qualified. POSIX mode bits alone are not a Windows security boundary.
  Other operating systems are unsupported.

Credentials are scoped by normalized control-plane origin, owner ID, worker UUID,
and purpose. The generated token and pending grant are stored only in the OS
keychain. There is no plaintext backup, environment-token option, token URL,
command-argument secret, credential enumeration, or volatile fallback. Store
failure stops pairing before registration. Provider credentials must use a
different purpose reference and never enter stage inputs.

The TypeSafe Jev provider and its `Workie TypeSafe API` keychain entry were
removed in October 2026; a stored `typesafe_jev` profile choice now yields a
disabled (`none`) provider config.

Compatible providers use the same schema-validated structured contract. The
worker sends no tools, rejects truncated or malformed output, bounds requests
and responses, and reserves request/run/day budget before dispatch. On first use
of a new provider configuration it performs one synthetic capability check and
stores the redacted receipt in the protected worker directory for 24 hours;
configuration changes invalidate that cache. Use the
following only for a paired local worker and never put the key in a command
argument, URL, environment file or log:

```sh
export WORKIE_PROVIDER_ID=byok:compatible
npm run worker -- set-provider-key
```

The hidden prompt stores the key in the OS keychain under the paired owner and
worker scope. Set `WORKIE_PROVIDER_ID=omniroute:compatible` for that adapter.
This command stores a credential only; the server-side provider policy and
pricing/capability checks still decide whether a request may run.

Official sources checked:

- `https://registry.npmjs.org/@napi-rs%2fkeyring/latest`
- `https://raw.githubusercontent.com/Brooooooklyn/keyring-node/1635ed458e8349ba28233728a8238ad99a5b2817/index.d.ts`
- `https://raw.githubusercontent.com/Brooooooklyn/keyring-node/main/README.md`

## Pair And Run

Use an independently opened terminal on the worker host. Configure only
non-secrets, using the owner ID displayed by the authenticated Workie controls:

```sh
export WORKIE_WORKER_ORIGIN=https://your-workie-host.example
export WORKIE_WORKER_OWNER=your-authenticated-owner-id
export WORKIE_WORKER_DIRECTORY="$HOME/.local/share/workie-worker"
umask 077
mkdir -p "$WORKIE_WORKER_DIRECTORY"
npm run worker -- pair
npm run worker -- status
npm run worker -- start
```

`start` runs in the foreground of that terminal. Closing the Workie page or
another client is independent; closing the worker's own terminal may stop it.
The CLI does not detach itself, install a daemon, or provision an always-on host.
`stop` sends a graceful signal to the PID recorded by the private worker lock;
it does not cancel an external action already in flight. `recover` acquires and
releases the same lock so an abandoned dead-process lock can be cleaned up;
an active or ambiguous lock fails closed.

For a local install, use Node 22 and keep the checkout separate from the worker
data directory:

```sh
nvm use 22
npm ci
export WORKIE_WORKER_DIRECTORY="$HOME/.local/share/workie-worker"
npm run worker -- status
npm run worker -- start
# another terminal, same non-secret environment:
npm run worker -- stop
npm run worker -- recover
```

Create the grant in authenticated Workie, then paste it into the CLI's hidden
TTY stdin prompt. Never put the grant in a shell command, URL, environment
variable, log or file. Piped input is refused. The CLI prints only non-secret
pairing metadata. The owner configured locally must match the server's response;
changing it does not authorize another owner's access.

The local metadata freezes the request ID, worker UUID and worker version.
The CLI secures a random 32-byte worker token before making the registration
request. After a timeout/lost response, rerun `pair`: it reuses the exact saved
grant/token/request and reconciles the same worker. After acknowledgement,
the consumed grant is removed from the keychain bundle. A paired `pair` command
does not claim to revalidate server authorization. `status` is local-only and
explicitly says server online status was not checked.

The worker never loads `.env.local`, needs no database or SMTP credential,
and has no public inbound listener. Production uses HTTPS with normal certificate
validation and rejects redirects. Local development alone may set
`WORKIE_WORKER_ALLOW_LOOPBACK=1` with an explicit numeric `127.0.0.1` or `[::1]`
origin. `localhost`, abbreviated IPs, other HTTP hosts, credentials/path/query
in origins, and `NODE_TLS_REJECT_UNAUTHORIZED=0` are rejected.

## Recruiter Messages On LinkedIn

A worker sends the recruiter messages its applicant approved on the Outreach
tab only after that applicant has signed in to LinkedIn in the worker's own
browser window. With the same non-secret environment as above:

```sh
npm run worker -- linkedin
```

This opens LinkedIn in a window that belongs to the worker (its profile is
`browser/linkedin` under the data directory, apart from the employers' forms).
The applicant signs in there themself; the worker never sees or stores the
password, and the command ends once LinkedIn shows a signed-in page. It can run
while `start` is running.

From then on the worker asks for one approved message on each poll that leaves
it without an application to work on. Before typing, it checks that the profile
did not redirect, that the name matches the one approved, that the message box
is addressed to that one person, and that LinkedIn shows no earlier
conversation. It sends only on the day of the approval, at most
`OUTREACH_DAILY_CAP` messages in 24 hours, each in a visible window. The first
message after a sign-in is a rehearsal: every check runs, nothing is typed, and
the message returns to the tab to be approved again.

A message is reported as sent only once the conversation shows the whole
approved text. If Send was pressed and that never appears, or the worker
stopped in between, the tab says the send is unconfirmed and nothing is sent
again until the applicant has looked at LinkedIn. When LinkedIn asks to sign in
again, the worker stops asking for messages until `linkedin` is run again.

## Leases, Checkpoints And Recovery

The shared `lib/applications/worker-protocol.ts` is the wire authority. Requests
use only its published pair, poll, heartbeat and event endpoints. Strict Zod
schemas, 128 KiB response bounds, 8-second request deadlines and no redirects
apply. Pairing and polls are not automatically retried. Only an identical
checkpoint request can retry (at most three attempts, each with an 8-second
deadline covering headers and body, at most 24 seconds of request deadlines).
Caller abort stops retries; authorization, conflict, version and rate-limit
responses are not retried. No external action is retried.

Assignments use 120-second server leases and 20-second heartbeats. A local
monotonic deadline subtracts request transit time and a 1-second margin.
Owner, worker, application, run, policy revision, ATS/tenant/requisition, fence,
state and revision are bound to the guard. Clock disagreement over 2 seconds,
an observed scheduler gap over 30 seconds, backward monotonic time, heartbeat
failure, changed binding, or lease expiry closes the guard. A 1-second watchdog
and checks before/after awaited operations detect these conditions.

Compiled adapters receive `lease` and `guard`:

- `guard.boundary(() => operation())` checks before and after awaited work.
- Pass `guard.signal` to cancellable browser/provider operations.
- Invoke the guard for **each** mutation, including after every awaited lookup;
  wrapping a whole multi-action callback is not sufficient.
- No guard is a submit permit. Irreversible actions require fresh server intent
  plus manifest and receipt-specific guards. The current ATS runner persists
  submission intent and accepts only an exact-role receipt; an upload or
  successful click is not a submission receipt.

Checkpoints contain only stage/sequence/event metadata, not answers, files or
credentials. The worker writes and fsyncs a 0600 temporary file, atomically
renames it and fsyncs its 0700 directory before sending the event. Restart
replays the same pending event **before** polling for a new fence. A historical
acknowledgement never grants mutation authority. A stale rejected event is
retained for diagnosis, then the worker asks for the server's current assignment.
Never derive application status from a local optimistic event.

Only one process per origin/owner/worker local store may run. Both `pair` and
`start` acquire that lock before reading or changing pairing credentials;
a losing contender does not access the keychain. A dead PID's lock
can be recovered under an exclusive recovery mutex. An ambiguous PID, malformed
lock or abandoned recovery mutex fails closed; inspect these manually only
after confirming the old worker is gone. Never remove a live worker's lock.
Do not run one worker identity in two data directories/hosts.

## Stop And Revocation

Ctrl-C or SIGTERM closes the local guard and stops the worker; a crashed worker
loses the server lease. Restart with `start` to reconcile durable checkpoints.
Network/protocol/credential faults exit visibly instead of running an
unbounded retry loop. Provider faults are checkpointed as
`provider_unavailable` for explicit recovery; they do not authorize a fallback
action. Retain the same data directory and keychain for recovery.

Pause/resume/skip/cancel/emergency-stop and credential revocation are durable
server controls, not claims made by this local CLI. Revoke the worker in
authenticated Workie before retiring its host. This CLI does not erase credentials
as a substitute for revocation. Ordinary UI logout is separate from worker
revocation.

Stopping cannot retract an external action already in flight. If submission
intent was persisted, server recovery must preserve `submission_unknown`,
not declare cancellation or retry submission. This runtime does not dispatch a
mutable adapter or a new event for `submitting`/`submission_unknown`; later
read-only reconciliation must prove the outcome.

## Synthetic Verification

```sh
npm run test:worker
```

Normal tests use an injected in-memory credential backend, synthetic identities,
and explicit ephemeral numeric-loopback servers. The actual `worker/main.ts`
CLI runs in child processes with a test-only module preload replacing the
keychain binding and TTY input. Synthetic credentials cross anonymous stdin/IPC,
never arguments, output, or a backup file. There is no production fixture flag.

The focused checks cover:

- Lost pairing response reconciled through a fresh CLI process; local-only
  `status`, piped-input rejection, and pair/start lock contention.
- SIGKILL after an accepted checkpoint at screening, tailoring, filling and
  ready; fresh processes recover dead locks and replay the exact event before
  polling. The fixture server applies each logical event only once.
- Detached child surviving its launcher; measured real 20-second heartbeat,
  HTTP revocation, socket loss, changed policy, clock jump, SIGTERM, and
  31-second SIGSTOP/SIGCONT with no post-resume mutation.
- Monotonic expiry, unsupported/submission-unknown guards, failed durable
  writes, invalid acknowledgements, stale pending events, scoped credentials,
  masked-input cleanup/deadline, bounded streams and abort/retry behavior.

These are real local processes and HTTP using the shared protocol schemas,
but the remote endpoints and TTY/keychain are synthetic. They do not run the
Next routes/private database or establish browser/server integration acceptance;
that remains the parent gate. All scratch uses the configured OS temporary
directory outside the checkout; tests remove their stores and stop child
processes/listeners. The 120-second input deadline uses Node's experimental
MockTimers in one test; process heartbeats and suspension use real time.

CI no longer loads the real `@napi-rs/keyring` native binding; every check
injects a fake backend and only `tsc` checks the declared Entry surface.
The scripts do not prove real keychain persistence, Linux/Windows qualification,
24/7 laptop availability or any live employer submission. The separate live
synthetic canary above is not a substitute for a configured production pilot.

## Backup, Rollback And Retention

Back up only the private worker directory and the matching OS-keychain entries;
never copy the keychain secret into a dotfile, archive, shell history or cloud
drive. Keep one encrypted offline backup before upgrades and delete old backups
according to the host's retention policy. A restored directory must stay paired
to the same origin, owner and worker identity; otherwise re-pair after revoking
the old worker.

To roll back the application safely, disable the owner policy in Workie, stop
the worker, preserve the directory and private database, then run the previous
worker version with the same data directory. Rollback must not delete questions,
artifacts, submission intents or receipts. A `submission_unknown` record is
reconciled read-only before any future safe work; it is never submitted again
just because the worker version changed.

## Private Operations View

`/applications` is an authenticated, force-dynamic view over the owner-scoped
run and application endpoints. It shows current state, checkpoint, reason code,
worker heartbeat status and policy status. It intentionally shows the frozen
ATS identity (`ats / tenant / requisition`) because the summary endpoint does
not claim a mutable posting title. Use `/workers` for durable run controls and
the notification bell for private questions and interventions.
