import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { credentials, nativeCredentialBackend, type CredentialBackend, type WorkerScope } from "./credentials.ts";
import { bootId, privateStore } from "./storage.ts";
import { controlOrigin, workerTransport, TransportError, type WorkerTransport } from "./transport.ts";
import { PairingMetadataSchema, WorkerCredentialSchema, pairWorker, sameScope, ScopeSchema } from "./pairing.ts";
import { readMaskedGrant, readMaskedSecret } from "./input.ts";
import { runWorker, type WorkerSetup } from "./runtime.ts";
import { openApplicationTab, type BrowserRuntime } from "./browser.ts";
import { liveView } from "./live.ts";
import { greenhouse } from "./ats/greenhouse.ts";
import { lever } from "./ats/lever.ts";
import { ashby } from "./ats/ashby.ts";
import { runAtsApplication, fillAtsApplication } from "./application-runner.ts";
import { screenApplication, screeningQuestions, formQuestions } from "./screening.ts";
import { AtsError } from "./ats/protocol.ts";
import { AtsAnswerErrors, AtsIdentitySchema, answerError, atsFieldKey, formQuestionKey, undergraduateTranscript, type AtsApplication } from "./ats/protocol.ts";
import type { StageDispatch, StructuredGenerator } from "./runtime.ts";
import type { StructuredGenerationResult } from "./providers.ts";
import { createStructuredProvider, ProviderError, storeProviderApiKey, structuredBudgetLedger } from "./providers.ts";
import {
  BYOK_PROVIDER_ID, LOCAL_OLLAMA_PROVIDER_ID, OMNIROUTE_PROVIDER_ID,
  ProviderCapabilitySchema, type ProviderCapability, type ProviderConfig,
} from "../lib/applications/provider-protocol.ts";
import type { ApplicationContext } from "../lib/applications/application-context-protocol.ts";
import type { PrivateStore } from "./storage.ts";
import { ApplicationArtifactManifestSchema, type ApplicationArtifactManifest, artifactManifestHash, artifactRequestId } from "../lib/applications/artifact-protocol.ts";
import { SUBMIT_APPROVAL } from "../lib/applications/state.ts";
import { PARKED_STEPS, STAGING_FIXTURE_TENANT } from "../lib/applications/worker-protocol.ts";
import { serveStagingFixture } from "./ats/greenhouse-fixture.ts";
import { createTemplateManifest, DocumentRuntimeError, relevantAnchors, tailorDocument } from "./documents/runtime.ts";
import { renderCoverLetter } from "./documents/cover-letter.ts";

const ERROR_CODES = new Set([
  "NODE_22_REQUIRED", "UNSUPPORTED_PLATFORM", "CONFIGURATION_REQUIRED", "INVALID_ORIGIN",
  "LOOPBACK_DISABLED", "TLS_BYPASS_FORBIDDEN", "PRIVATE_DIRECTORY_REQUIRED", "UNSAFE_DIRECTORY",
  "DATA_DIRECTORY_IN_REPOSITORY", "NOT_PAIRED", "WORKER_LOCKED", "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_MISSING", "PAIRING_INCOMPLETE", "BINDING_CHANGED", "TTY_REQUIRED", "INVALID_GRANT",
  "INPUT_TIMEOUT", "INPUT_CLOSED", "STOPPED", "CLOCK_UNSAFE", "LEASE_LOST", "LEASE_EXPIRED",
  "INVALID_RESPONSE", "INVALID_ACKNOWLEDGEMENT", "NETWORK_UNAVAILABLE",
  "UNSAFE_STATE_FILE", "LOCAL_STATE_UNREADABLE", "LOCAL_STATE_LIMIT", "EXECUTION_DISABLED",
  "PROVIDER_DISABLED", "REMOTE_PROVIDER_DENIED", "PROVIDER_NOT_ALLOWED", "REMOTE_FALLBACK_DENIED",
  "PROVIDER_OWNER_UNBOUND", "PROVIDER_CREDENTIAL_UNAVAILABLE", "PROVIDER_CREDENTIAL_MISSING",
  "PROVIDER_LEDGER_INVALID", "PROVIDER_LEDGER_LOCKED", "PROVIDER_BUDGET_EXCEEDED", "PROVIDER_NETWORK_UNAVAILABLE",
  "PROVIDER_INVALID_RESPONSE", "PROVIDER_RESPONSE_TOO_LARGE", "PROVIDER_REQUEST_TOO_LARGE", "PROVIDER_USAGE_INVALID",
  "PROVIDER_RESERVATION_MISSING", "PROVIDER_LOW_CONFIDENCE", "PROVIDER_POLICY_INVALID", "PROVIDER_CAPABILITY_MISMATCH", "INVALID_PROVIDER_ENDPOINT", "FETCH_UNAVAILABLE",
  "PROVIDER_FALLBACK_UNSUPPORTED", "PROVIDER_UNKNOWN_COST", "PROVIDER_AUTH_UNAVAILABLE", "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_CREDENTIAL_INVALID", "PROVIDER_MODEL_INVALID", "PROVIDER_ID_INVALID", "LOCAL_PROVIDER_POLICY_INVALID", "LOCAL_PROVIDER_ENDPOINT_REQUIRED",
  "REMOTE_PROVIDER_ENDPOINT_INVALID", "STAGE_TIMEOUT",
]);

const PROVIDER_CAPABILITY_CACHE = "provider-capability";
const PROVIDER_CAPABILITY_TTL_MS = 24 * 60 * 60_000;
const CapabilityCacheSchema = z.strictObject({
  configHash: z.string().regex(/^[a-f0-9]{64}$/), checkedAt: z.iso.datetime(), capability: z.unknown(),
});
type CapabilityChecker = { check(signal?: AbortSignal): Promise<ProviderCapability> };

function providerConfigHash(config: ProviderConfig) {
  const withoutCapability = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "capability"));
  return createHash("sha256").update(JSON.stringify(withoutCapability)).digest("hex");
}

/** Cache the explicit synthetic check locally; a worker restart must not spend a new request for the same config. */
export async function ensureProviderCapability(
  config: ProviderConfig, provider: CapabilityChecker, store: PrivateStore, signal?: AbortSignal,
) {
  const configHash = providerConfigHash(config);
  const cached = CapabilityCacheSchema.safeParse(await store.read(PROVIDER_CAPABILITY_CACHE));
  if (cached.success && cached.data.configHash === configHash && Date.parse(cached.data.checkedAt) > Date.now() - PROVIDER_CAPABILITY_TTL_MS) {
    return ProviderCapabilitySchema.parse(cached.data.capability);
  }
  const capability = ProviderCapabilitySchema.parse(await provider.check(signal));
  if (!capability || capability.protocol !== config.protocol || capability.locality !== config.locality || !capability.structuredOutput || capability.tools) {
    throw new ProviderError("PROVIDER_CAPABILITY_MISMATCH");
  }
  await store.write(PROVIDER_CAPABILITY_CACHE, { configHash, checkedAt: capability.checkedAt, capability });
  return capability;
}

export function createConfiguredStructuredProvider(
  scope: WorkerScope, config: ProviderConfig, providerStore: PrivateStore, credentialBackend: CredentialBackend,
  fetchImpl?: typeof fetch,
) {
  if (!config.enabled || !["local_ollama", "omniroute", "byok"].includes(config.provider)) return undefined;
  const providerId = config.provider === "local_ollama" ? LOCAL_OLLAMA_PROVIDER_ID : config.provider === "omniroute" ? OMNIROUTE_PROVIDER_ID : BYOK_PROVIDER_ID;
  const protocol = config.protocol === "ollama_native" || config.protocol === "openai_compatible" ? config.protocol : null;
  const locality = config.locality === "local" || config.locality === "remote" ? config.locality : null;
  if (!protocol || !locality || !config.endpoint || !config.model) throw new ProviderError("PROVIDER_POLICY_INVALID");
  const provider = createStructuredProvider({
    scope, approvedOwnerId: config.ownerId, providerId, protocol, locality, endpoint: config.endpoint, model: config.model,
    policy: { enabled: config.enabled, privacy: config.privacy, remoteProviderConsent: config.remoteProviderConsent,
      allowedProviders: config.allowedProviders, fallbackOrder: config.fallbackOrder, budget: { currency: "USD", ...config.budget } },
    pricing: config.pricing, ledger: structuredBudgetLedger(providerStore), credentialBackend, credentialRequired: config.credential !== "none", fetchImpl,
  });
  return provider;
}

export function providerFailureResult(error: unknown) {
  if (!(error instanceof ProviderError)) return null;
  return {
    state: "provider_unavailable" as const,
    reasonCode: `${error.code}${error.diagnostic ? `_${error.diagnostic}` : ""}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80),
  };
}

export function atsFailureReason(error: unknown) {
  if (error instanceof AtsError) {
    // A field key names the failing field; any other message may hold a private value and is dropped.
    const field = error.message !== error.code && atsFieldKey.test(error.message) ? `_${error.message}` : '';
    return `ats_${error.code.toLowerCase()}${field}`.replace(/[^a-z0-9_]/g, '_').slice(0, 80);
  }
  if (error instanceof z.ZodError) return "ats_schema_invalid";
  if (error instanceof Error && error.name === "TimeoutError") return "ats_timeout";
  // Workie's own error codes (e.g. COVER_LETTER_EXCEEDS_ONE_PAGE) hold no private value, so the reason names them.
  if (error instanceof Error && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(error.message)) return `ats_${error.message.toLowerCase()}`.slice(0, 80);
  return "ats_execution_failed";
}

export function hasVerifiedTailoredArtifact(context: Pick<ApplicationContext, "documents" | "tailoredArtifact" | "manifestHash" | "artifactHashes">) {
  const output = context.documents.resume, source = context.documents.resumeMaster, artifact = context.tailoredArtifact;
  return Boolean(output && source && artifact && artifact.documentId === output.documentId && artifact.version === output.version &&
    artifact.sourceDocumentId === source.documentId && artifact.sourceVersion === source.version && artifact.sourceHash === source.sha256 &&
    artifact.outputHash === output.sha256 && context.manifestHash === artifact.verificationManifestHash &&
    context.artifactHashes.includes(artifact.outputHash));
}

type TailorGenerated = Extract<StructuredGenerationResult, { task: "tailor" }>;
export function createApplicationArtifactManifest(input: {
  applicationId: string; source: ApplicationContext["documents"][string];
  template: Awaited<ReturnType<typeof createTemplateManifest>>; evidence: { id: string; confirmed: true; excerpt: string }[];
  generated: TailorGenerated; tailored: Awaited<ReturnType<typeof tailorDocument>>;
}) {
  const request = { role: input.template.role, masterHash: input.template.sourceHash, evidence: input.evidence, edits: input.generated.edits };
  const manifest = ApplicationArtifactManifestSchema.parse({
    schemaVersion: 1, applicationId: input.applicationId,
    source: { documentId: input.source.documentId, version: input.source.version, sha256: input.source.sha256 },
    output: { sha256: input.tailored.sha256, mime: input.source.mime, size: input.tailored.bytes.length },
    template: input.tailored.manifest, request, checks: input.tailored.checks,
    tool: { name: "workie-document-runtime", version: "1" },
  });
  return { manifest, request };
}

/** The master resume as the application's artifact, unchanged, when no safe edit could be made to it. */
export function untailoredArtifactManifest(applicationId: string, source: ApplicationContext["documents"][string],
  template: Awaited<ReturnType<typeof createTemplateManifest>>, bytes: Uint8Array, reason: string) {
  return ApplicationArtifactManifestSchema.parse({
    schemaVersion: 1, applicationId,
    source: { documentId: source.documentId, version: source.version, sha256: source.sha256 },
    output: { sha256: source.sha256, mime: source.mime, size: bytes.length },
    template, request: { untailored: true, reason },
    checks: { pageCount: template.pageCount, linksPreserved: true, frozenTextPreserved: true, anchorsFit: true },
    tool: { name: "workie-document-runtime", version: "1" },
  });
}

/** Runs one leased stage. Exported so tests can drive the real pipeline against fixture forms. */
export function createStageDispatch(control: WorkerTransport, directory: string, signal: AbortSignal,
  browser: typeof openApplicationTab = openApplicationTab): StageDispatch {
  return async (lease, guard, context) => {
    let applicationContext;
    try {
      applicationContext = await control.applicationContext(lease.applicationId, {
        protocolVersion: 1, applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision,
      }, signal);
      guard.check();
    } catch (error) {
      // The posting changed since discovery froze it. Park this one; a throw would restart the
      // worker into the same lease and stall the whole queue.
      if (error instanceof TransportError && error.status === 409 &&
          (error.code === "CONTEXT_UNAVAILABLE" || error.code === "IDENTITY_MISMATCH")) {
        return { state: "retryable_failure" as const, reasonCode: error.code.toLowerCase() };
      }
      throw error;
    }
    const adapters = { greenhouse, lever, ashby } as const;
    const adapter = adapters[applicationContext.identity.ats as keyof typeof adapters];
    if (!adapter) return { state: "blocked_unsupported" as const, reasonCode: "adapter_unavailable" };
    const identity = AtsIdentitySchema.parse(applicationContext.identity);
    const requirement = screenApplication(applicationContext.facts, applicationContext.requirements);
    if (lease.state === "screening") {
      // Keep which requirements failed (as many whole codes as fit the 80-character reason) so the card can say why.
      if (requirement.status === "blocked") return { state: "skipped" as const,
        reasonCode: requirement.reasons.filter((_, i, all) => all.slice(0, i + 1).join(",").length <= 80).join(",") || "screening_ineligible" };
      if (requirement.status === "needs_question") return screeningQuestions(applicationContext, requirement.reasons);
      return { state: "tailoring" as const, reasonCode: "screened" };
    }
    if (lease.state === "tailoring") {
      if (hasVerifiedTailoredArtifact(applicationContext)) return { state: "filling" as const, reasonCode: "artifact_verified", evidence: { artifactVerified: true } };
      const source = applicationContext.documents.resumeMaster;
      // A profile with no master resume is the applicant's to fix, so it must be a hold they can continue once fixed.
      if (!source) return { state: "needs_document" as const, reasonCode: "resume_required" };
      if (!context.generate) return { state: "needs_document" as const, reasonCode: "tailored_artifact_required" };
      const upload = async (manifest: ApplicationArtifactManifest, output: Uint8Array) => {
        const requestId = artifactRequestId({ applicationId: lease.applicationId, sourceHash: source.sha256,
          policyRevision: applicationContext.policyRevision, manifestHash: artifactManifestHash(manifest) });
        guard.check();
        const intent = await control.artifactIntent(lease.applicationId, { protocolVersion: 1, requestId, fence: lease.fence,
          expectedRevision: lease.revision, manifest }, signal);
        await control.uploadArtifact(lease.applicationId, intent.artifactId, intent.uploadPath,
          { protocolVersion: 1, requestId, fence: lease.fence, expectedRevision: lease.revision }, output, source.mime, signal);
      };
      let master: { bytes: Uint8Array; template: Awaited<ReturnType<typeof createTemplateManifest>> } | undefined;
      try {
        guard.check();
        const bytes = await control.downloadDocument(lease.applicationId, source.documentId, source.path, signal);
        if (bytes.length !== source.size || createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new DocumentRuntimeError("DOCUMENT_RECONCILIATION_FAILED");
        const template = await createTemplateManifest(bytes, source.mime, applicationContext.role);
        master = { bytes, template };
        const evidence = template.anchors.slice(0, 32).map((anchor, index) => ({
          id: artifactRequestId({ applicationId: lease.applicationId, sourceHash: source.sha256, anchorId: anchor.id, index }),
          confirmed: true as const, excerpt: anchor.text.slice(0, 1000),
        }));
        const editableAnchors = relevantAnchors(template.anchors, applicationContext.requirements.officialDescription);
        const generated = await context.generate({ task: "tailor", role: template.role,
          jobSummary: applicationContext.requirements.officialDescription.slice(0, 12_000),
          evidence: evidence.map(({ id, excerpt }) => ({ id, excerpt })),
          anchors: editableAnchors.map(({ id, text, maxChars }) => ({ id, text, maxChars })),
        }, { signal, runId: lease.runId });
        if (generated.task !== "tailor" || generated.confidence < 0.75) throw new ProviderError("PROVIDER_LOW_CONFIDENCE");
        const request = { role: template.role, masterHash: template.sourceHash, evidence, edits: generated.edits };
        const tailored = await tailorDocument({ bytes, mime: source.mime, manifest: template, request });
        const artifact = createApplicationArtifactManifest({ applicationId: lease.applicationId, source, template,
          evidence, generated, tailored });
        await upload(artifact.manifest, tailored.bytes);
        return { state: "filling" as const, reasonCode: "artifact_verified", evidence: { artifactVerified: true } };
      } catch (caught) {
        let error = caught;
        if (signal.aborted) throw error;
        // No rewrite fit its line (each ran to its length limit), which is a resume that cannot be edited safely, not a provider outage.
        const overflow = error instanceof ProviderError && error.diagnostic === "edit_overflow";
        const providerFailure = overflow ? null : providerFailureResult(error);
        if (providerFailure) return providerFailure;
        if ((error instanceof DocumentRuntimeError || overflow) && master) {
          // The resume could not be edited safely (e.g. a compressed PDF), so apply with the verified master unchanged.
          try {
            await upload(untailoredArtifactManifest(lease.applicationId, source, master.template, master.bytes,
              error instanceof DocumentRuntimeError ? error.code : "EDIT_OVERFLOW"), master.bytes);
            return { state: "filling" as const, reasonCode: "master_resume_used", evidence: { artifactVerified: true } };
          } catch (fallback) {
            if (signal.aborted) throw fallback;
            error = fallback;
          }
        }
        if (error instanceof DocumentRuntimeError) return { state: "needs_document" as const, reasonCode: "document_tailoring_unavailable" };
        return { state: "retryable_failure" as const, reasonCode: error instanceof TransportError ? `tailoring_transport_${error.status}` :
          error instanceof z.ZodError ? "tailoring_schema_invalid" : "tailoring_failed" };
      }
    }
    const workDirectory = await mkdtemp(join(directory, "application-"));
    let runtime: BrowserRuntime | undefined;
    let application: AtsApplication | null = null;
    let submissionStarted = false;
    let live: ReturnType<typeof liveView> | undefined;
    // What the applicant reviews before approving: each field Workie filled and its value.
    let review: { label: string; value: string }[] | undefined;
    // Set when the form waits on the applicant's answers: like a form waiting on approval, it keeps its last picture.
    let asking = false;
    try {
      const localDocuments: Record<string, string> = {};
      const applicant = [applicationContext.answers.first_name, applicationContext.answers.last_name].filter((item): item is string => typeof item === 'string').join(' ');
      // Employers see the uploaded file's name, so the resume goes up as the applicant's, e.g. DongYeopLee_Resume.docx.
      const resumeName = applicant.replace(/[^\p{L}\p{N}]/gu, '');
      for (const [key, document] of Object.entries(applicationContext.documents)) {
        guard.check();
        const bytes = await control.downloadDocument(lease.applicationId, document.documentId, document.path, signal);
        if (bytes.length !== document.size || createHash("sha256").update(bytes).digest("hex") !== document.sha256) {
          throw new Error("DOCUMENT_RECONCILIATION_FAILED");
        }
        const extension = document.mime === "application/pdf" ? ".pdf" : ".docx";
        const path = join(workDirectory, `${key === 'resume' && resumeName ? `${resumeName}_Resume` : key}${extension}`);
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        localDocuments[key] = path;
      }
      if (!localDocuments.resume || !hasVerifiedTailoredArtifact(applicationContext)) {
        return { state: "needs_document" as const, reasonCode: "tailored_artifact_required" };
      }
      application = {
        identity, company: applicationContext.company, role: applicationContext.role,
        applicationUrl: applicationContext.applicationUrl, answers: applicationContext.answers, documents: localDocuments,
        manifestHash: applicationContext.manifestHash!, artifactHashes: applicationContext.artifactHashes,
        submissionIntentId: lease.applicationId,
      };
      const hostname = new URL(application.applicationUrl).hostname;
      runtime = await browser({
        userDataDir: join(directory, "browser", "applications"),
        approvedOrigins: [new URL(application.applicationUrl).origin, ...(adapter.hosts.includes(hostname) ? adapter.origins : [])],
        // Every application opens in a new tab of one visible window, so the applicant can watch it fill
        // and type an emailed code or solve a captcha the form asks for at submit.
        allowLoopback: /^127\./.test(hostname), headless: false,
      });
      if (identity.ats === "greenhouse" && identity.tenant === STAGING_FIXTURE_TENANT) await serveStagingFixture(runtime.context);
      live = liveView(async frame => control.live(lease.applicationId, { protocolVersion: 1, ...frame }, signal), runtime);
      live.step(lease.state === "filling" ? "Reading the form" : "Opening the approved application");
      const observed = await adapter.observe(runtime, application, signal);
      const currentApplication = application;
      for (const field of observed.fields) {
        const reviewed = currentApplication.answers[formQuestionKey(field)];
        if (reviewed !== undefined) currentApplication.answers[field.key] = reviewed;
      }
      const missing = observed.fields.filter(field => field.required && field.kind !== 'file' &&
        adapter.answer(currentApplication, field) === undefined);
      if (missing.length) { asking = true; return formQuestions(applicationContext, missing); }
      // A transcript upload takes the applicant's undergraduate transcript.
      for (const field of observed.fields) {
        if (field.kind === 'file' && localDocuments.transcript && undergraduateTranscript(field.label)) currentApplication.documents[field.key] = localDocuments.transcript;
      }
      // A required upload Workie has no document for would fail the form's own check after submit.
      const unavailable = observed.fields.find(field => field.kind === 'file' && field.required && field.key !== 'cover_letter' && !currentApplication.documents[field.key]);
      if (unavailable) {
        // Named so the applicant knows to add a transcript or allow transcripts in the policy.
        return { state: "needs_document" as const, reasonCode: undergraduateTranscript(unavailable.label) ? "transcript_unavailable" : "required_document_unavailable" };
      }
      const writeLetter = async () => {
        // The letter saved when the form was filled is the one the applicant approved; reuse it.
        const saved = applicationContext.letter;
        if (saved) return { task: 'cover_letter' as const, introduction: saved.introduction, body: saved.body.map(text => ({ text, evidenceIds: [] })),
          conclusion: saved.conclusion, companyParagraph: saved.companyParagraph, confidence: 1,
          model: 'saved', usage: { input_tokens: 0, output_tokens: 0 } };
        const source = await readFile(localDocuments.resumeMaster);
        const template = await createTemplateManifest(source, applicationContext.documents.resumeMaster.mime, applicationContext.role);
        const evidence = template.anchors.slice(0, 32).map((anchor, index) => ({
          id: artifactRequestId({ applicationId: lease.applicationId, sourceHash: template.sourceHash, anchorId: anchor.id, index }),
          excerpt: anchor.text.slice(0, 1000),
        }));
        const letter = await context.generate!({ task: 'cover_letter', company: applicationContext.company, role: applicationContext.role,
          jobSummary: applicationContext.requirements.officialDescription.slice(0, 12_000), evidence }, { signal, runId: lease.runId });
        if (letter.task !== 'cover_letter' || letter.confidence < 0.75) throw new ProviderError('PROVIDER_LOW_CONFIDENCE');
        return letter;
      };
      let letter: Awaited<ReturnType<typeof writeLetter>> | undefined;
      // An optional letter field is left empty when the policy does not allow cover letters.
      if (observed.fields.some(field => field.key === 'cover_letter' && field.kind === 'file' && (field.required || applicationContext.coverLetterAllowed))) {
        if (!applicationContext.coverLetterAllowed || !context.generate || !localDocuments.resumeMaster) {
          return { state: "needs_document" as const, reasonCode: "cover_letter_unavailable" };
        }
        live.step("Writing the cover letter");
        letter = await writeLetter();
        if (!applicant) throw new AtsError('REQUIRED_ANSWER_MISSING', 'first_name');
        const path = join(workDirectory, 'cover_letter.pdf');
        await writeFile(path, await renderCoverLetter(letter, applicant), { mode: 0o600, flag: 'wx' });
        application.documents.cover_letter = path;
      }
      live.step(lease.state === "filling" ? "Filling the form" : "Filling the form again and submitting it");
      if (lease.state === "filling") {
        const result = await fillAtsApplication({ runtime, adapter, application, facts: applicationContext.facts,
          requirements: applicationContext.requirements, signal, runId: lease.runId });
        // A profile edit since screening can leave a requirement unconfirmed: ask it, as screening does.
        if (result.state === "needs_answer") return screeningQuestions(applicationContext, result.reasons);
        if (result.state === "skipped") return { state: "skipped" as const, reasonCode: "form_ineligible" };
        if (letter) await control.letter(lease.applicationId, { protocolVersion: 1, introduction: letter.introduction,
          body: letter.body.map(item => item.text), conclusion: letter.conclusion, companyParagraph: letter.companyParagraph }, signal);
        review = observed.fields.map(field => {
          const value = field.kind === 'file' ? currentApplication.documents[field.key] && basename(currentApplication.documents[field.key])
            : adapter.answer(currentApplication, field);
          const text = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
          // An optional field Workie had no answer for is listed too, so the applicant sees it went in empty.
          return { label: field.label.slice(0, 1000), value: text ? text.slice(0, 4000) : 'Left blank' };
        }).slice(0, 64);
        // Nothing is submitted until the applicant reviews the filled form, resume and letter and approves it.
        return { state: "needs_policy_decision" as const, reasonCode: SUBMIT_APPROVAL };
      }
      const result = await runAtsApplication({ runtime, adapter, application, facts: applicationContext.facts,
        requirements: applicationContext.requirements, signal, runId: lease.runId, submission: {
          begin: async ({ intentId, identity, company, role, manifestHash, artifactHashes }) => {
            submissionStarted = true;
            const intent = await control.submissionIntent(lease.applicationId, { protocolVersion: 1, intentId, fence: lease.fence,
              expectedRevision: lease.revision, identity, company, role, manifestHash, artifactHashes }, signal);
            context.advance?.({ revision: intent.revision, fence: intent.fence, state: intent.state });
            return intent;
          },
          receipt: async ({ intentId, receipt, evidence }) => {
            const body = { protocolVersion: 1 as const, intentId, identity: receipt.identity, company: receipt.company, role: receipt.role,
              receiptId: receipt.receiptId, submittedAt: receipt.submittedAt, evidence };
            // The employer confirmed it: a receipt Workie's server did not take is kept and sent under the next reconcile lease.
            try { return await control.receipt(lease.applicationId, body, signal); }
            catch (error) { await context.keepReceipt?.(body); throw error; }
          },
          code: async () => (await control.verificationCode(lease.applicationId, signal)).code,
        } });
      if (result.state === "submitted" && letter && application.documents.cover_letter) {
        // Keep the letter that went out so the applicant can read it; never affects the outcome.
        await control.letter(lease.applicationId, { protocolVersion: 1, introduction: letter.introduction,
          body: letter.body.map(item => item.text), conclusion: letter.conclusion, companyParagraph: letter.companyParagraph }, signal).catch(() => {});
      }
      if (result.state === "submitted" || result.state === "submission_unknown") {
        return { state: result.state, reasonCode: result.reasons[0]?.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80) || "submission_unknown", durable: true };
      }
      if (result.state === "needs_answer") return screeningQuestions(applicationContext, result.reasons);
      if (result.state === "skipped") return { state: "skipped" as const, reasonCode: "screening_ineligible" };
      return { state: "retryable_failure" as const, reasonCode: "application_failed" };
    } catch (error) {
      if (signal.aborted) throw error;
      const providerFailure = providerFailureResult(error);
      if (providerFailure) return providerFailure;
      // An answer the form rejected is asked; one whose field cannot be read again is retried below,
      // since a needs_answer with no question has nothing to answer and nothing resumes it.
      if (answerError(error) && runtime && application && !submissionStarted) {
        const observed = await adapter.observe(runtime, application, signal).catch(() => null);
        const fields = (error instanceof AtsAnswerErrors ? error.errors : [error]).flatMap(item => {
          const field = observed?.fields.find(candidate => candidate.key === item.message);
          return field ? [{ ...field, options: item.options ?? field.options }] : [];
        });
        if (fields.length) { asking = true; return formQuestions(applicationContext, fields); }
      }
      if (submissionStarted) return { state: "submission_unknown" as const, reasonCode: "submission_response_lost", durable: true };
      // Only this computer's log: a timeout's first line names the step that waited, which the bounded reason cannot.
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), status: "application-failed", company: application?.company ?? null,
        reason: atsFailureReason(error), detail: error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : null }) + "\n");
      return { state: "retryable_failure" as const, reasonCode: atsFailureReason(error) };
    } finally {
      await live?.stop(review ? PARKED_STEPS.approval : asking ? PARKED_STEPS.answers : "Workie left this application",
        review, !!review || asking);
      if (runtime) await runtime.close().catch(() => {});
      await rm(workDirectory, { recursive: true, force: true });
    }
  };
}

export async function main(args = process.argv.slice(2)) {
  if (process.versions.node.split(".")[0] !== "22") throw new Error("NODE_22_REQUIRED");
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("UNSUPPORTED_PLATFORM");
  if (args.length !== 1 || !["pair", "start", "status", "stop", "recover", "set-provider-key"].includes(args[0])) {
    process.stdout.write("Usage: npm run worker -- pair|start|status|stop|recover|set-provider-key\n");
    return;
  }
  const allowLoopback = process.env.WORKIE_WORKER_ALLOW_LOOPBACK === "1";
  const origin = controlOrigin(process.env.WORKIE_WORKER_ORIGIN ?? "", allowLoopback);
  const ownerId = z.string().min(1).max(256).parse(process.env.WORKIE_WORKER_OWNER);
  const directory = process.env.WORKIE_WORKER_DIRECTORY;
  if (!directory || !isAbsolute(directory)) throw new Error("CONFIGURATION_REQUIRED");
  const repo = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const inside = (path: string) => { const rel = relative(repo, path); return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); };
  if (inside(resolve(directory))) throw new Error("DATA_DIRECTORY_IN_REPOSITORY");
  const configStore = await privateStore(directory, { origin, ownerId, workerId: "identity" });
  if (inside(await realpath(directory))) throw new Error("DATA_DIRECTORY_IN_REPOSITORY");
  const unlockConfig = await configStore.lock();
  let scope;
  try {
    scope = await configStore.read("identity");
    if (!scope) {
      if (args[0] !== "pair") throw new Error("NOT_PAIRED");
      scope = { origin, ownerId, workerId: randomUUID() };
      await configStore.write("identity", scope);
    }
    scope = ScopeSchema.parse(scope);
    sameScope(scope, { origin, ownerId, workerId: scope.workerId });
  } finally { await unlockConfig(); }
  const store = await privateStore(directory, scope);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (args[0] === "status") {
      const metadata = await store.read("pairing");
      if (!metadata) throw new Error("NOT_PAIRED");
      const parsed = PairingMetadataSchema.parse(metadata);
      sameScope(scope, parsed.scope);
      // Local status does not consult the keychain or falsely claim online/server validity.
      process.stdout.write(JSON.stringify({ ...scope, status: parsed.status, online: "not-checked" }) + "\n");
      return;
    }
    if (args[0] === "stop") {
      const lock = await store.read("lock") as { pid?: number; boot?: string } | null;
      const boot = await bootId();
      // A lock from an earlier boot is stale, and its pid may now be some other process: never signal it.
      if (!lock || (boot && lock.boot && lock.boot !== boot)) {
        process.stdout.write(JSON.stringify({ ...scope, status: "not-running" }) + "\n");
        return;
      }
      if (!Number.isSafeInteger(lock.pid) || lock.pid! <= 0) throw new Error("WORKER_LOCKED");
      try { process.kill(lock.pid!, "SIGTERM"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("WORKER_LOCKED");
      }
      process.stdout.write(JSON.stringify({ ...scope, status: "stop-requested" }) + "\n");
      return;
    }
    if (args[0] === "recover") {
      const unlock = await store.lock();
      await unlock();
      process.stdout.write(JSON.stringify({ ...scope, status: "recovered" }) + "\n");
      return;
    }
    if (args[0] === "pair") {
      const unlock = await store.lock();
      try {
        const vault = credentials(scope, await nativeCredentialBackend());
        const metadata = await pairWorker({
          scope, store, vault, transport: workerTransport({ origin, allowLoopback }),
          readGrant: () => readMaskedGrant(process.stdin, process.stderr, controller.signal), signal: controller.signal,
        });
        process.stdout.write(JSON.stringify({ ...scope, status: metadata.status }) + "\n");
      } finally { await unlock(); }
      return;
    }
    if (args[0] === "set-provider-key") {
      const configuredProviderId = process.env.WORKIE_PROVIDER_ID;
      const providerId = configuredProviderId === BYOK_PROVIDER_ID || configuredProviderId === OMNIROUTE_PROVIDER_ID ? configuredProviderId : null;
      if (!providerId) throw new Error("PROVIDER_ID_INVALID");
      const value = await readMaskedSecret(process.stdin, process.stderr, `API key for ${providerId} (hidden): `, undefined, controller.signal);
      await storeProviderApiKey(scope, scope.ownerId, providerId, value, await nativeCredentialBackend());
      process.stdout.write(JSON.stringify({ ...scope, status: "provider-key-saved", providerId }) + "\n");
      return;
    }
    const backend = await nativeCredentialBackend();
    const transport = async () => {
      const metadata = PairingMetadataSchema.parse(await store.read("pairing"));
      sameScope(scope, metadata.scope);
      if (metadata.status !== "paired") throw new Error("NOT_PAIRED");
      const vault = credentials(scope, backend);
      const saved = vault.get("worker");
      if (!saved) throw new Error("CREDENTIAL_MISSING");
      const credential = WorkerCredentialSchema.parse(JSON.parse(saved));
      return workerTransport({ origin, token: credential.workerToken, allowLoopback });
    };
    const setup: WorkerSetup = async (control, signal) => {
      let providerConfig;
      try { providerConfig = await control.providerConfig(signal); }
      catch (error) {
        // Older control-v1 servers fail closed to deterministic execution until upgraded.
        if (!(error instanceof TransportError) || error.status !== 404) throw error;
        return {};
      }
      if (!providerConfig.enabled) return {};
      const providerStore = await privateStore(directory, { ...scope, workerId: `${scope.workerId}:provider` });
      const configuredForChecked = async (current: ProviderConfig, checkSignal?: AbortSignal) => {
        const provider = current.enabled ? createConfiguredStructuredProvider(scope, current, providerStore, backend) : undefined;
        if (!provider) return null;
        await ensureProviderCapability(current, provider, providerStore, checkSignal);
        return provider;
      };
      const generate: StructuredGenerator = async (input, options) => {
        const current = await control.providerConfig(options?.signal);
        const configured = await configuredForChecked(current, options?.signal);
        if (!configured) throw new ProviderError("PROVIDER_DISABLED");
        return configured.generate(input, options);
      };
      const dispatch = createStageDispatch(control, directory, signal);
      return { generate, dispatch };
    };
    await runWorker({ scope, store, transport, configure: setup,
      signal: controller.signal, status: status => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), status }) + "\n") });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error instanceof TransportError ? error.message :
      error instanceof Error && ERROR_CODES.has(error.message) ? error.message : "WORKER_FAILED";
    // An unnamed failure keeps its type and first line (schema paths only, never values) so it can be diagnosed.
    const detail = code !== "WORKER_FAILED" ? undefined : error instanceof z.ZodError
      ? `ZodError ${error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}:${issue.code}`).join(" ")}`
      : error instanceof Error ? `${error.name}${error instanceof AtsError ? ` ${error.code}` : ""}: ${error.message.split("\n")[0].slice(0, 160)}` : typeof error;
    process.stderr.write(JSON.stringify({ at: new Date().toISOString(), error: code, ...(detail ? { detail } : {}) }) + "\n");
    process.exitCode = 1;
  }).finally(() => {
    // The shared Chromium window keeps the event loop busy, so after a stop or an error the process would linger
    // and launchd would never restart it. Give the abandoned stage a moment to clean up, then exit (the window
    // closes with the process).
    setTimeout(() => process.exit(), 5000).unref();
  });
}
