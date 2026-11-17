import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atsFailureReason, createApplicationArtifactManifest, ensureProviderCapability, hasVerifiedTailoredArtifact, onceMoreIfMalformed, providerFailureResult } from "./main.ts";
import { AtsError } from "./ats/protocol.ts";
import { artifactManifestHash, artifactRequestId } from "../lib/applications/artifact-protocol.ts";
import { ProviderError } from "./providers.ts";
import { privateStore } from "./storage.ts";
import { runWorker } from "./runtime.ts";

const scope = { origin: "https://workie.example", ownerId: "synthetic-owner", workerId: "synthetic-worker" };
const config = {
  providerProtocolVersion: 1, ownerId: scope.ownerId, profileRevision: 2, policyRevision: 3,
  policyVersion: 1, policyHash: null, enabled: true, provider: "byok", model: "synthetic-model",
  endpoint: "https://provider.example/v1/chat/completions", privacy: "approved_remote", remoteProviderConsent: true,
  allowedProviders: ["byok:compatible"], fallbackOrder: [], maxUsd: 0,
};

test("ATS failures report bounded codes without including field values", () => {
  assert.equal(atsFailureReason(new AtsError("FIELD_NOT_FOUND", "private field value")), "ats_field_not_found");
  assert.equal(atsFailureReason(new AtsError("FIELD_RECONCILIATION_FAILED", "candidate-location")), "ats_field_reconciliation_failed_candidate_location");
  assert.equal(atsFailureReason(new Error("private field value")), "ats_execution_failed");
  assert.equal(atsFailureReason(new Error("COVER_LETTER_EXCEEDS_ONE_PAGE")), "ats_cover_letter_exceeds_one_page");
});

test("tailored artifact verification binds the output to the selected master and manifest", () => {
  const resume = { documentId: "00000000-0000-4000-8000-000000000001", version: 2, sha256: "a".repeat(64) };
  const source = { ...resume, documentId: "b".repeat(8) + "-" + "b".repeat(4) + "-4" + "b".repeat(3) + "-8" + "b".repeat(3) + "-" + "b".repeat(12) };
  const output = { ...resume, documentId: "c".repeat(8) + "-" + "c".repeat(4) + "-4" + "c".repeat(3) + "-8" + "c".repeat(3) + "-" + "c".repeat(12) };
  const artifact = { documentId: output.documentId, version: output.version, sourceDocumentId: source.documentId,
    sourceVersion: source.version, sourceHash: source.sha256, verificationManifestHash: "d".repeat(64), outputHash: output.sha256 };
  const valid = { documents: { resume: output, resumeMaster: source }, tailoredArtifact: artifact, manifestHash: artifact.verificationManifestHash,
    artifactHashes: [artifact.outputHash] };
  assert.equal(hasVerifiedTailoredArtifact(valid), true);
  assert.equal(hasVerifiedTailoredArtifact({ ...valid, manifestHash: "e".repeat(64) }), false);
  assert.equal(hasVerifiedTailoredArtifact({ ...valid, tailoredArtifact: { ...artifact, version: 1 } }), false);
  assert.equal(hasVerifiedTailoredArtifact({ ...valid, artifactHashes: [] }), false);
});

test("provider capability checks are cached per owner-approved configuration", async () => {
  const localDirectory = await mkdtemp(join(tmpdir(), "main-provider-capability-"));
  const store = await privateStore(localDirectory, { ...scope, workerId: `${scope.workerId}:provider` });
  const capabilityConfig = {
    ...config, protocol: "openai_compatible", locality: "remote", credential: "os_keychain",
    budget: { perRequestUsd: 1, perRunUsd: 1, perDayUsd: 1, allowUnknownCost: false },
    pricing: { known: true, inputUsdPerMillion: 0.042, outputUsdPerMillion: 0 }, capability: null,
  };
  let checks = 0;
  const checker = { check: async () => { checks++; return { checkedAt: new Date().toISOString(), protocol: "openai_compatible", model: "synthetic-model", locality: "remote", structuredOutput: true, tools: false, maxContextTokens: null, maxOutputTokens: null }; } };
  try {
    await ensureProviderCapability(capabilityConfig, checker, store);
    await ensureProviderCapability(capabilityConfig, checker, store);
    assert.equal(checks, 1);
    await ensureProviderCapability({ ...capabilityConfig, model: "synthetic-next" }, checker, store);
    assert.equal(checks, 2);
  } finally {
    await rm(localDirectory, { recursive: true, force: true });
  }
});

test("tailoring manifest binds the generated edits to the selected master and output", () => {
  const applicationId = "00000000-0000-4000-8000-000000000010";
  const source = { documentId: "00000000-0000-4000-8000-000000000011", version: 2, sha256: "a".repeat(64),
    size: 10, mime: "application/pdf" };
  const evidence = [{ id: "00000000-0000-4000-8000-000000000012", confirmed: true, excerpt: "Python" }];
  const generated = { task: "tailor", confidence: 0.9, edits: [{ anchorId: "bullet-1", replacement: "Built Python tooling", evidenceIds: [evidence[0].id] }] };
  const result = createApplicationArtifactManifest({ applicationId, source, template: { role: "Engineer", sourceHash: source.sha256 }, evidence,
    generated, tailored: { bytes: new Uint8Array([1]), sha256: "b".repeat(64), format: "pdf", manifest: { role: "Engineer" },
      checks: { pageCount: 1, linksPreserved: true, frozenTextPreserved: true, anchorsFit: true } } });
  assert.equal(result.manifest.applicationId, applicationId);
  assert.deepEqual(result.manifest.source, { documentId: source.documentId, version: source.version, sha256: source.sha256 });
  assert.equal(result.manifest.output.sha256, "b".repeat(64));
  assert.deepEqual(result.request.edits, generated.edits);
  const requestId = (manifest) => artifactRequestId({ applicationId, sourceHash: source.sha256,
    policyRevision: 1, manifestHash: artifactManifestHash(manifest) });
  assert.equal(requestId(result.manifest), requestId(result.manifest));
  assert.notEqual(requestId(result.manifest), requestId({ ...result.manifest,
    output: { ...result.manifest.output, sha256: "c".repeat(64) } }));
});

test("provider failures checkpoint as resumable state and do not block the next application", async () => {
  const localScope = { ...scope, workerId: randomUUID() };
  const localDirectory = await mkdtemp(join(tmpdir(), "main-provider-continuation-"));
  const store = await privateStore(localDirectory, localScope);
  const assignment = () => ({ applicationId: randomUUID(), runId: randomUUID(), workerId: localScope.workerId,
    ownerId: localScope.ownerId, policyRevision: 1, ats: "fixture", tenant: "tenant", requisition: "role",
    state: "screening", revision: 1, fence: 1, leaseUntil: Date.now() + 120_000, checkpoint: null, mode: "safe" });
  const first = assignment(), second = assignment(), jobs = [first, second], events = [], controller = new AbortController();
  try {
    await runWorker({ scope: localScope, store, signal: controller.signal,
      transport: {
        poll: async () => ({ protocolVersion: 1, serverTime: Date.now(), heartbeatMs: 20_000, leaseMs: 120_000, lease: jobs.shift() ?? null }),
        heartbeat: async () => ({ protocolVersion: 1, serverTime: Date.now(), heartbeatMs: 20_000, leaseMs: 120_000, lease: null }),
        event: async (applicationId, event) => {
          events.push(event);
          if (events.length === 2) controller.abort();
          return { applicationId, eventId: event.eventId, revision: event.expectedRevision + 1,
            state: event.state, replayed: false, lease: null, serverTime: Date.now() };
        },
      },
      dispatch: async (lease) => lease.applicationId === first.applicationId
        ? providerFailureResult(new ProviderError("PROVIDER_LOW_CONFIDENCE"))
        : { state: "blocked_unsupported", reasonCode: "fixture" },
    });
    assert.deepEqual(events.map((event) => [event.state, event.reasonCode]), [
      ["provider_unavailable", "provider_low_confidence"], ["blocked_unsupported", "fixture"],
    ]);
  } finally {
    await rm(localDirectory, { recursive: true, force: true });
  }
});

test("a malformed provider reply is asked once more; other provider failures are not", async () => {
  const calls = (errors) => { let n = 0; return { count: () => n, call: async () => { const error = errors[n++]; if (error) throw error; return "ok"; } }; };
  const malformed = calls([new ProviderError("PROVIDER_INVALID_RESPONSE", "schema")]);
  assert.equal(await onceMoreIfMalformed(malformed.call), "ok");
  assert.equal(malformed.count(), 2);
  const twice = calls([new ProviderError("PROVIDER_INVALID_RESPONSE", "json"), new ProviderError("PROVIDER_INVALID_RESPONSE", "json")]);
  await assert.rejects(onceMoreIfMalformed(twice.call), { code: "PROVIDER_INVALID_RESPONSE" });
  assert.equal(twice.count(), 2);
  const quota = calls([new ProviderError("PROVIDER_QUOTA_EXCEEDED")]);
  await assert.rejects(onceMoreIfMalformed(quota.call), { code: "PROVIDER_QUOTA_EXCEEDED" });
  assert.equal(quota.count(), 1);
});
