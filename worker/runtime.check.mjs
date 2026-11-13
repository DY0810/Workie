import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { privateStore } from "./storage.ts";
import { credentials } from "./credentials.ts";
import { pairWorker } from "./pairing.ts";
import { runWorker } from "./runtime.ts";
import { TransportError } from "./transport.ts";

const scope = () => ({ origin: "https://workie.example", ownerId: "synthetic-owner-a", workerId: randomUUID() });
const clockResponse = (lease = null) => ({ protocolVersion: 1, serverTime: Date.now(), heartbeatMs: 20000, leaseMs: 120000, lease });
const pairResponse = s => ({ protocolVersion: 1, serverTime: Date.now(), heartbeatMs: 20000,
  leaseMs: 120000, workerId: s.workerId, ownerId: s.ownerId, revision: 1 });
const assignment = s => ({ applicationId: randomUUID(), runId: randomUUID(), workerId: s.workerId,
  ownerId: s.ownerId, policyRevision: 1, ats: "fixture", tenant: "tenant", requisition: "role",
  state: "screening", revision: 1, fence: 1, leaseUntil: Date.now() + 120000, checkpoint: null, mode: "safe" });
const directories = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
async function storeFor(s) {
  const directory = await mkdtemp(join(tmpdir(), "worker-runtime-"));
  directories.push(directory);
  return privateStore(directory, s);
}
function backend() {
  const items = new Map();
  return (service, account) => {
    const key = JSON.stringify([service, account]);
    return { getPassword: () => items.get(key) ?? null, setPassword: value => items.set(key, value),
      deletePassword: () => items.delete(key) };
  };
}

test("pairing saves credential before registration and reconciles identical request after lost response", async () => {
  const s = scope(), store = await storeFor(s), vault = credentials(s, backend());
  const calls = [];
  const transport = { pair: async request => {
    assert(vault.get("worker"));
    calls.push(request);
    if (calls.length === 1) throw new Error("NETWORK_UNAVAILABLE");
    return pairResponse(s);
  } };
  await assert.rejects(pairWorker({ scope: s, store, vault, transport, readGrant: async () => "G".repeat(43) }));
  await pairWorker({ scope: s, store, vault, transport, readGrant: async () => { throw new Error("must not prompt again"); } });
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].expectedOwnerId, s.ownerId);
  const metadata = await readFile(store.path("pairing"), "utf8");
  assert(!metadata.includes(calls[0].workerToken));
  assert(!metadata.includes(calls[0].grant));
  assert.equal(JSON.parse(metadata).status, "paired");
  assert(!vault.get("worker").includes('"grant"'));
});

test("a refused grant is forgotten so the next pair asks for a new one", async () => {
  const s = scope(), store = await storeFor(s), vault = credentials(s, backend());
  let prompts = 0;
  const readGrant = async () => { prompts++; return "G".repeat(43); };
  await assert.rejects(pairWorker({ scope: s, store, vault, readGrant,
    transport: { pair: async () => { throw new TransportError("HTTP_409", 409); } } }), /HTTP_409/);
  assert.equal(vault.get("worker"), null);
  await pairWorker({ scope: s, store, vault, readGrant, transport: { pair: async () => pairResponse(s) } });
  assert.equal(prompts, 2);
});

test("wrong owner pairing response never marks local metadata paired", async () => {
  const s = scope(), store = await storeFor(s), vault = credentials(s, backend());
  await assert.rejects(pairWorker({ scope: s, store, vault, readGrant: async () => "G".repeat(43),
    transport: { pair: async () => ({ ...pairResponse(s), ownerId: "synthetic-owner-b" }) } }), /BINDING_CHANGED/);
  assert.equal((await store.read("pairing")).status, "pending");
});

test("default dispatch releases waiting slot, emits no submitted state, and runs unrelated work", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  const jobs = [assignment(s), assignment(s)], events = [];
  const transport = {
    poll: async () => clockResponse(jobs.shift() ?? null), heartbeat: async () => clockResponse(),
    event: async (id, input) => {
      events.push(input);
      if (events.length === 2) setTimeout(() => controller.abort(), 10);
      return { applicationId: id, eventId: input.eventId, revision: input.expectedRevision + 1,
        state: input.state, replayed: false, lease: null, serverTime: Date.now() };
    },
  };
  await runWorker({ scope: s, store, transport, signal: controller.signal });
  assert.equal(events.length, 2);
  assert(events.every(e => e.state === "blocked_unsupported" && e.reasonCode === "adapter_unavailable"));
  assert.equal((await store.read("checkpoint")).pending, null);
});

test("a network blip on poll or intervention poll keeps the worker running; an unexpected transport error still stops it", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  let polls = 0, interventionPolls = 0;
  const running = runWorker({ scope: s, store, signal: controller.signal, transport: {
    poll: async () => { polls += 1; throw new TransportError("NETWORK_UNAVAILABLE"); }, heartbeat: async () => clockResponse(),
    interventions: async () => { interventionPolls += 1; throw new TransportError("NETWORK_UNAVAILABLE"); },
  } });
  const stopped = await Promise.race([running.then(() => "exited", error => error.message), sleep(300).then(() => "running")]);
  assert.equal(stopped, "running", "a failed poll used to end the worker with NETWORK_UNAVAILABLE");
  assert.equal(polls, 1);
  assert.equal(interventionPolls, 1);
  controller.abort();
  await running;
  const s2 = scope();
  await assert.rejects(runWorker({ scope: s2, store: await storeFor(s2), signal: new AbortController().signal, transport: {
    poll: async () => { throw new TransportError("HTTP_409", 409); }, heartbeat: async () => clockResponse(),
  } }), /HTTP_409/);
});

test("checkpoint survives failed acknowledgement; restart replays same key before a new poll", async () => {
  const s = scope(), store = await storeFor(s), job = assignment(s);
  let first;
  await assert.rejects(runWorker({ scope: s, store, signal: new AbortController().signal,
    transport: { poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
      event: async (id, input) => { first = input; throw new Error("NETWORK_UNAVAILABLE"); } } }), /NETWORK_UNAVAILABLE/);
  const pending = (await store.read("checkpoint")).pending;
  assert.deepEqual(pending.event, first);
  const controller = new AbortController(), order = [];
  await runWorker({ scope: s, store, signal: controller.signal, transport: {
    event: async (id, input) => {
      order.push("event"); assert.deepEqual(input, first);
      return { applicationId: id, eventId: input.eventId, revision: 2, state: input.state,
        replayed: true, lease: null, serverTime: Date.now() };
    },
    poll: async () => { order.push("poll"); controller.abort(); return clockResponse(); },
    heartbeat: async () => clockResponse(),
  } });
  assert.deepEqual(order, ["event", "poll"]);
  assert.equal((await store.read("checkpoint")).pending, null);
});

test("stop during awaited stage revokes mutation ability and does not report cancelled/submitted", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  let writes = 0, events = 0, stageFinished;
  const finished = new Promise(resolve => stageFinished = resolve);
  await runWorker({ scope: s, store, signal: controller.signal,
    transport: { poll: async () => clockResponse(assignment(s)), heartbeat: async () => clockResponse(),
      event: async () => { events++; } },
    dispatch: async (lease, guard) => {
      controller.abort();
      await sleep(10);
      await assert.rejects(guard.boundary(() => { writes++; }));
      stageFinished();
      return { state: "blocked_unsupported", reasonCode: "adapter_unavailable" };
    } });
  await finished;
  assert.equal(writes, 0); assert.equal(events, 0);
});

test("submission_unknown has no mutable dispatch or event", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  let dispatches = 0, events = 0;
  await runWorker({ scope: s, store, signal: controller.signal,
    transport: { poll: async () => {
      setTimeout(() => controller.abort(), 20);
      return clockResponse({ ...assignment(s), state: "submission_unknown", mode: "reconcile" });
    }, heartbeat: async () => clockResponse(), event: async () => { events++; } },
    dispatch: async () => { dispatches++; } });
  assert.equal(dispatches, 0); assert.equal(events, 0);
});

test("an unknown submission names its reason once, then the worker leaves the row alone", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController(), events = [];
  const job = { ...assignment(s), state: "ready", checkpoint: { stage: "filling", sequence: 3 } };
  let polls = 0;
  await runWorker({ scope: s, store, signal: controller.signal,
    transport: { poll: async () => { if (++polls > 1) controller.abort(); return clockResponse(polls === 1 ? job : null); },
      heartbeat: async () => clockResponse(),
      event: async (id, input) => { events.push(input); return { applicationId: id, eventId: input.eventId,
        revision: input.expectedRevision + 1, state: input.state, replayed: false, lease: null, serverTime: Date.now() }; } },
    dispatch: async (_lease, _guard, context) => {
      context.advance({ revision: 2, fence: 1, state: "submitting" });
      return { state: "submission_unknown", reasonCode: "verification_code_timeout", durable: true };
    } });
  assert.deepEqual(events.map(e => [e.state, e.reasonCode, e.fence, e.expectedRevision, e.checkpoint]),
    [["submission_unknown", "verification_code_timeout", 1, 2, { stage: "ready", sequence: 4 }]]);
});

test("a verified receipt the server did not take is sent on the next reconcile lease until it is accepted or refused", async () => {
  const s = scope(), job = assignment(s);
  const receipt = { protocolVersion: 1, intentId: job.applicationId, identity: { ats: "fixture", tenant: "tenant", requisition: "role" },
    company: "Fixture Co", role: "Intern", receiptId: "gh-1", submittedAt: Date.now(),
    evidence: { source: "confirmation_page", pageUrl: "https://job-boards.greenhouse.io/tenant/jobs/role/confirmation", observedText: "Thank you for applying." } };
  const reconcile = { ...job, state: "submission_unknown", mode: "reconcile" };
  // The submit's receipt POST failed: the dispatch keeps the receipt (main.ts), and the next poll is that row read-only.
  const run = async (store, answer, jobs = [{ ...job, state: "ready" }, reconcile]) => {
    const controller = new AbortController(), sent = [], stuck = setTimeout(() => controller.abort(), 3000);
    await runWorker({ scope: s, store, signal: controller.signal,
      transport: { poll: async () => clockResponse(jobs.shift() ?? null), heartbeat: async () => clockResponse(),
        event: async (id, input) => ({ applicationId: id, eventId: input.eventId, revision: input.expectedRevision + 1,
          state: input.state, replayed: false, lease: null, serverTime: Date.now() }),
        receipt: async (id, input) => { sent.push([id, input]); setTimeout(() => controller.abort(), 20); return answer(id, input); } },
      dispatch: async (_lease, _guard, context) => {
        await context.keepReceipt?.(receipt);
        return { state: "submission_unknown", reasonCode: "receipt_persistence_failed", durable: true };
      } });
    clearTimeout(stuck);
    return sent;
  };
  const store = await storeFor(s);
  // Workie's server is still down: the receipt stays for the next lease.
  assert.deepEqual(await run(store, () => { throw new TransportError("NETWORK_UNAVAILABLE"); }), [[job.applicationId, receipt]]);
  assert.deepEqual(await run(store, (id, input) => ({ applicationId: id, intentId: input.intentId, state: "submitted", revision: 9, replayed: false }),
    [reconcile]), [[job.applicationId, receipt]]);
  assert.deepEqual(await store.read("receipts"), {});
  // The applicant already resolved the row: the server refuses it for good, so it is dropped rather than resent forever.
  const refused = await storeFor(s);
  await run(refused, () => { throw new TransportError("HTTP_409", 409, "EXECUTION_DISABLED"); });
  assert.deepEqual(await refused.read("receipts"), {});
});

test("every safe-stage checkpoint restarts with its exact event ID, sequence and revision", async () => {
  for (const stage of ["screening", "tailoring", "filling", "ready"]) {
    const s = scope(), store = await storeFor(s), job = { ...assignment(s),
      state: stage, checkpoint: { stage, sequence: 4 } };
    const transport = {
      poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
      event: async () => { throw new Error("NETWORK_UNAVAILABLE"); },
    };
    await assert.rejects(runWorker({ scope: s, store, signal: new AbortController().signal, transport }));
    const pending = (await store.read("checkpoint")).pending;
    assert.deepEqual(pending.event.checkpoint, { stage, sequence: 5 });
    const controller = new AbortController();
    await runWorker({ scope: s, store, signal: controller.signal, transport: {
      ...transport,
      event: async (id, event) => {
        assert.deepEqual(event, pending.event);
        return { applicationId: id, eventId: event.eventId, revision: 2, state: event.state,
          replayed: true, lease: null, serverTime: Date.now() };
      },
      poll: async () => { controller.abort(); return clockResponse(); },
    } });
    assert.equal((await store.read("checkpoint")).pending, null);
  }
});

test("cross-owner, wrong-worker and changed-protocol assignments never dispatch or write events", async () => {
  const s = scope();
  for (const change of [{ ownerId: "synthetic-owner-b" }, { workerId: randomUUID() }, { policyRevision: 0 }]) {
    let writes = 0;
    const job = { ...assignment(s), ...change };
    await assert.rejects(runWorker({ scope: s, store: await storeFor(s), signal: new AbortController().signal,
      transport: { poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
        event: async () => { writes++; } },
      dispatch: async () => { writes++; },
    }));
    assert.equal(writes, 0);
  }
  await assert.rejects(runWorker({ scope: s, store: await storeFor(s), signal: new AbortController().signal,
    transport: { poll: async () => ({ ...clockResponse(), protocolVersion: 2 }), heartbeat: async () => clockResponse() },
  }));
});

test("failed durable checkpoint write sends no event; invalid acknowledgements remain pending", async () => {
  for (const fault of ["write", "event-id", "application-id", "revision", "state"]) {
    const s = scope(), store = await storeFor(s), job = assignment(s);
    let sent = 0;
    const guardedStore = fault === "write" ? { ...store, write: async () => { throw new Error("SYNTHETIC_DISK_FAILURE"); } } : store;
    await assert.rejects(runWorker({ scope: s, store: guardedStore, signal: new AbortController().signal,
      transport: {
        poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
        event: async (id, event) => {
          sent++;
          return { applicationId: fault === "application-id" ? randomUUID() : id,
            eventId: fault === "event-id" ? randomUUID() : event.eventId,
            revision: fault === "revision" ? 99 : event.expectedRevision + 1,
            state: fault === "state" ? "submitted" : event.state, replayed: false, lease: null, serverTime: Date.now() };
        },
      },
    }), fault === "write" ? /SYNTHETIC_DISK_FAILURE/ : /INVALID_ACKNOWLEDGEMENT/);
    assert.equal(sent, fault === "write" ? 0 : 1);
    assert.equal(Boolean((await store.read("checkpoint"))?.pending), fault !== "write");
    assert.equal(await store.read("lock"), null);
  }
});

test("stale pending checkpoint is retained diagnostically and re-polled without dispatching its old lease", async () => {
  const s = scope(), store = await storeFor(s), job = assignment(s);
  await assert.rejects(runWorker({ scope: s, store, signal: new AbortController().signal,
    transport: { poll: async () => clockResponse(job), heartbeat: async () => clockResponse(),
      event: async () => { throw new TransportError("HTTP_503", 503); } } }));
  const journal = await store.read("checkpoint"), order = [], controller = new AbortController();
  await runWorker({ scope: s, store, signal: controller.signal,
    dispatch: async () => assert.fail("Old assignment is not mutation authority"),
    transport: {
      event: async (_id, event) => {
        order.push("event"); assert.deepEqual(event, journal.pending.event);
        throw new TransportError("HTTP_409", 409);
      },
      poll: async () => { order.push("poll"); controller.abort(); return clockResponse(); },
      heartbeat: async () => clockResponse(),
    },
  });
  assert.deepEqual(order, ["event", "poll"]);
  assert.equal((await store.read("checkpoint")).pending, null);
  assert.deepEqual(await store.read("rejected-checkpoint"), journal);
});

test("a screening skip for several requirements reports them all instead of crashing the worker", async () => {
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  const events = [];
  // DY's worker crash-looped on this on 2026-10-23: the comma list the skipped card reads failed the result schema.
  await runWorker({ scope: s, store, signal: controller.signal,
    transport: { poll: async () => clockResponse(assignment(s)), heartbeat: async () => clockResponse(),
      event: async (id, input) => {
        events.push(input); controller.abort();
        return { applicationId: id, eventId: input.eventId, revision: input.expectedRevision + 1,
          state: input.state, replayed: false, lease: null, serverTime: Date.now() };
      } },
    dispatch: async () => ({ state: "skipped", reasonCode: "graduation_ineligible,term_ineligible" }) });
  assert.deepEqual(events.map(e => [e.state, e.reasonCode]), [["skipped", "graduation_ineligible,term_ineligible"]]);
});

test("a missed heartbeat keeps the lease until its deadline; a refused one still stops the worker", { timeout: 40000 }, async () => {
  // One timed-out heartbeat during a fill, or during the 30-minute verification-code wait, used to end the worker.
  async function run(heartbeat, { leaseMs = 120000, settle = false } = {}) {
    const s = scope(), store = await storeFor(s), controller = new AbortController();
    const job = { ...assignment(s), leaseUntil: Date.now() + leaseMs };
    let polled = false, beats = 0, aborted = false;
    const events = [];
    const outcome = await runWorker({ scope: s, store, signal: controller.signal,
      transport: {
        poll: async () => { const lease = polled ? null : job; polled = true; return clockResponse(lease); },
        heartbeat: async () => { beats++; return heartbeat(job); },
        event: async (id, input) => {
          events.push(input); controller.abort();
          return { applicationId: id, eventId: input.eventId, revision: input.expectedRevision + 1,
            state: input.state, replayed: false, lease: null, serverTime: Date.now() };
        },
      },
      dispatch: (_lease, _guard, { signal }) => new Promise((resolve, reject) => {
        const stop = () => { aborted = true; reject(new Error("STOPPED")); };
        signal.addEventListener("abort", stop);
        if (!settle) return;
        const beaten = setInterval(() => {
          if (!beats) return;
          clearInterval(beaten);
          signal.removeEventListener("abort", stop);
          resolve({ state: "blocked_unsupported", reasonCode: "adapter_unavailable" });
        }, 100);
      }),
    }).then(() => "finished", error => error.message);
    return { outcome, events: events.length, aborted };
  }
  const [blip, outage, deadline, revoked, lost, released] = await Promise.all([
    run(() => { throw new TransportError("NETWORK_UNAVAILABLE"); }, { settle: true }),
    run(() => { throw new TransportError("HTTP_503", 503); }, { settle: true }),
    // Contact never comes back: the guard's own deadline still stops the stage (fail closed).
    run(() => { throw new TransportError("NETWORK_UNAVAILABLE"); }, { leaseMs: 25000 }),
    run(() => { throw new TransportError("HTTP_401", 401); }),
    run(() => { throw new TransportError("HTTP_409", 409, "LEASE_LOST"); }),
    run(() => clockResponse(null)),
  ]);
  assert.deepEqual(blip, { outcome: "finished", events: 1, aborted: false });
  assert.deepEqual(outage, { outcome: "finished", events: 1, aborted: false });
  assert.deepEqual(deadline, { outcome: "LEASE_EXPIRED", events: 0, aborted: true });
  assert.deepEqual(revoked, { outcome: "HTTP_401", events: 0, aborted: true });
  assert.deepEqual(lost, { outcome: "HTTP_409", events: 0, aborted: true });
  assert.deepEqual(released, { outcome: "LEASE_LOST", events: 0, aborted: true });
});

test("an error tied to one application fails that application and the worker moves on", async () => {
  // The server hands a restarted worker the same lease first, so a crash on one bad posting used to stop
  // every application (the HTTP 409 context loop and the comma reason-code loop).
  const s = scope(), store = await storeFor(s), controller = new AbortController();
  const stages = [
    async () => { throw new TransportError("HTTP_409", 409, "ARTIFACT_INVALID"); },
    async () => ({ state: "skipped", reasonCode: "Bad Reason" }),
    async () => ({ state: "filling", reasonCode: "screened" }),
    async () => { throw new TypeError("Cannot read properties of undefined (reading 'ats')"); },
    async () => ({ state: "blocked_unsupported", reasonCode: "adapter_unavailable" }),
  ];
  const events = [];
  const outcome = await runWorker({ scope: s, store, signal: controller.signal,
    transport: { poll: async () => clockResponse(assignment(s)), heartbeat: async () => clockResponse(),
      event: async (id, input) => {
        events.push(input);
        if (events.length === stages.length) controller.abort();
        return { applicationId: id, eventId: input.eventId, revision: input.expectedRevision + 1,
          state: input.state, replayed: false, lease: null, serverTime: Date.now() };
      } },
    dispatch: async () => stages[events.length](),
  }).then(() => "finished", error => error.message);
  assert.equal(outcome, "finished");
  assert.deepEqual(events.map(e => [e.state, e.reasonCode]), [
    ["retryable_failure", "worker_http_409_artifact_invalid"], ["retryable_failure", "worker_schema_invalid"],
    ["retryable_failure", "worker_execution_disabled"], ["retryable_failure", "worker_typeerror"],
    ["blocked_unsupported", "adapter_unavailable"],
  ]);
});

test("worker-wide failures, and any failure past a submission intent, still stop the worker without an event", async () => {
  for (const [fault, expected] of [
    [() => { throw new TransportError("HTTP_401", 401); }, "HTTP_401"],
    [() => { throw new TransportError("HTTP_403", 403, "POLICY_CHANGED"); }, "HTTP_403"],
    [() => { throw new TransportError("HTTP_404", 404, "NOT_FOUND"); }, "HTTP_404"],
    [() => { throw new TransportError("HTTP_409", 409, "LEASE_LOST"); }, "HTTP_409"],
    [() => { throw new TransportError("NETWORK_UNAVAILABLE"); }, "NETWORK_UNAVAILABLE"],
    // A server deployed ahead of the worker answers in a shape it does not know, for every application alike.
    [() => { throw new TransportError("INVALID_RESPONSE"); }, "INVALID_RESPONSE"],
    [() => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC", syscall: "write" }); }, "ENOSPC: no space left on device"],
    [guard => { guard.revoke("LEASE_LOST"); throw new Error("after the lease"); }, "LEASE_LOST"],
    [(_guard, { advance }) => { advance({ revision: 2, fence: 1, state: "submitting" }); throw new TypeError("after the intent"); }, "after the intent"],
  ]) {
    const s = scope(), store = await storeFor(s);
    let events = 0;
    const outcome = await runWorker({ scope: s, store, signal: new AbortController().signal,
      transport: { poll: async () => clockResponse(assignment(s)), heartbeat: async () => clockResponse(),
        event: async () => { events++; } },
      dispatch: async (_lease, guard, context) => fault(guard, context),
    }).then(() => "finished", error => error.message);
    assert.equal(outcome, expected);
    assert.equal(events, 0);
  }
});

test("a stage that never settles gives up after an hour, never inside the 30-minute verification wait", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = scope(), store = await storeFor(s), job = assignment(s);
  let started, aborted = false;
  const dispatching = new Promise(resolve => started = resolve);
  const outcome = runWorker({ scope: s, store, signal: new AbortController().signal,
    transport: { poll: async () => clockResponse(job), heartbeat: async () => clockResponse(job) },
    dispatch: (_lease, _guard, { signal }) => new Promise((_, reject) => {
      started();
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("STOPPED")); });
    }),
  }).then(() => "finished", error => error.message);
  await dispatching;
  t.mock.timers.tick(45 * 60_000);
  await sleep(20);
  assert.equal(aborted, false, "a stage still inside its budget, e.g. fill plus the 30-minute code wait, keeps going");
  t.mock.timers.tick(15 * 60_000);
  // A wedged stage used to hold the only lease forever while heartbeats kept the worker Online.
  assert.equal(await Promise.race([outcome, sleep(1000).then(() => "still running")]), "STAGE_TIMEOUT");
  assert.equal(aborted, true);
});

test("the same failure on application after application stops the worker instead of failing the whole queue", async () => {
  // A code bug every posting hits (or anything else that is not one bad posting) used to park the queue one by one.
  const s = scope(), store = await storeFor(s);
  const bug = "Cannot read properties of undefined (reading 'gpa')";
  const crash = async () => { throw new TypeError(bug); };
  const works = async () => ({ state: "blocked_unsupported", reasonCode: "adapter_unavailable" });
  async function run(stages) {
    const controller = new AbortController(), events = [];
    let leased = 0;
    const outcome = await runWorker({ scope: s, store, signal: controller.signal,
      transport: {
        poll: async () => { if (++leased > 8) { controller.abort(); return clockResponse(); } return clockResponse(assignment(s)); },
        heartbeat: async () => clockResponse(),
        event: async (id, input) => {
          events.push(input.reasonCode);
          return { applicationId: id, eventId: input.eventId, revision: input.expectedRevision + 1,
            state: input.state, replayed: false, lease: null, serverTime: Date.now() };
        } },
      dispatch: async () => stages[Math.min(leased, stages.length) - 1](),
    }).then(() => "finished", error => error.message);
    return { outcome, events };
  }
  assert.deepEqual(await run([crash]), { outcome: bug, events: ["worker_typeerror", "worker_typeerror", "worker_typeerror"] });
  // launchd restarts the worker: the count is kept, so the next application is not failed too.
  assert.deepEqual(await run([crash]), { outcome: bug, events: [] });
  // An application that works ends the run of failures.
  assert.deepEqual(await run([works, crash]), { outcome: bug,
    events: ["adapter_unavailable", "worker_typeerror", "worker_typeerror", "worker_typeerror"] });
});

test("a fatal error past a submission intent leaves the code window open until the stage ends", { timeout: 10000 }, async () => {
  // main exits (closing the window) once runWorker stops, so stopping mid-wait took the form from the applicant.
  const s = scope(), store = await storeFor(s);
  let skew = 0, typed, settled = false;
  const code = new Promise(resolve => typed = resolve);
  const outcome = runWorker({ scope: s, store, signal: new AbortController().signal,
    clock: () => ({ mono: performance.now(), wall: Date.now() + skew }),
    transport: { poll: async () => clockResponse(assignment(s)), heartbeat: async () => clockResponse(),
      event: async () => assert.fail("no event after a submission intent") },
    dispatch: async (_lease, _guard, { advance }) => {
      advance({ revision: 2, fence: 1, state: "submitting" });
      skew = 10_000; // the laptop slept during the verification-code wait
      await code; // like page.waitForURL, the wait does not watch the signal
      return { state: "submitted", reasonCode: "confirmed", durable: true };
    },
  }).then(() => "finished", error => error.message).finally(() => { settled = true; });
  await sleep(2500);
  assert.equal(settled, false, "the worker stopped while the applicant could still type the code");
  typed();
  assert.equal(await outcome, "CLOCK_UNSAFE");
});

test("a recruiter message is taken with no application to work on, and its outcome is kept until the server has it", async () => {
  const s = scope(), store = await storeFor(s);
  const message = () => ({ id: randomUUID(), name: "Sam Fixture", profileUrl: "https://www.linkedin.com/in/sam-fixture",
    subject: "", body: "Hi Sam.", approvedAt: Date.now() });
  const run = async ({ response, send, answer, enabled = true, posts = 1 }) => {
    const controller = new AbortController(), seen = { asked: [], posted: [], dispatches: 0, events: 0 };
    const stuck = setTimeout(() => controller.abort(), 3000), done = () => setTimeout(() => controller.abort(), 20);
    await runWorker({ scope: s, store, signal: controller.signal,
      transport: { poll: async (_signal, asks) => { seen.asked.push(asks); if (!response.outreach) done(); return response; },
        heartbeat: async () => clockResponse(), event: async () => { seen.events++; },
        outreachResult: async (id, input) => { seen.posted.push([id, input.outcome]); if (seen.posted.length === posts) done(); return answer(); } },
      outreach: { enabled: async () => enabled, send },
      dispatch: async () => { seen.dispatches++; } });
    clearTimeout(stuck);
    return seen;
  };
  // Send was pressed, then the window died and Workie's server was down: "may have been sent" stays on disk.
  const first = message();
  let seen = await run({ response: { ...clockResponse(), outreach: first },
    send: async (_task, beforeClick) => { await beforeClick(); throw new Error("window closed"); },
    answer: () => { throw new TransportError("NETWORK_UNAVAILABLE"); } });
  assert.deepEqual(seen.posted, [[first.id, "unknown"]]);
  assert.deepEqual(await store.read("outreach-result"), { id: first.id, result: { protocolVersion: 1, outcome: "unknown" } });
  // The next start reports it before anything else. A worker stuck on an unconfirmed submission still takes a message.
  const second = message();
  seen = await run({ response: { ...clockResponse({ ...assignment(s), state: "submission_unknown", mode: "reconcile" }), outreach: second },
    send: async () => ({ outcome: "sent", threadUrl: null }), answer: () => ({ state: "sent" }), posts: 2 });
  assert.deepEqual(seen.posted, [[first.id, "unknown"], [second.id, "sent"]]);
  assert.deepEqual([seen.asked, seen.dispatches, seen.events], [[true], 0, 0]);
  assert.equal(await store.read("outreach-result"), null);
  // A failure before Send is the message's own, and the server refusing the outcome for good drops it.
  seen = await run({ response: { ...clockResponse(), outreach: message() },
    send: async () => { throw new Error("no window"); }, answer: () => { throw new TransportError("HTTP_409", 409, "OUTREACH_SETTLED"); } });
  assert.deepEqual(seen.posted.map(([, outcome]) => outcome), ["not_sent"]);
  assert.equal(await store.read("outreach-result"), null);
  // Not signed in to LinkedIn: the poll does not ask.
  seen = await run({ response: clockResponse(), enabled: false, send: async () => assert.fail("sent"), answer: () => assert.fail("posted") });
  assert.deepEqual([seen.asked, seen.posted], [[false], []]);
});
