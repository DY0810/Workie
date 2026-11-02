import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lookupApplicant, privateJson, privateResponse } from '../applicant-access.ts';
import { countRequest, getPrivateDb } from '../private-db/index.ts';
import { getDiscoveryCorpus } from './discovery-corpus.ts';
import { assertExpectedApplicant, ApplicantPreconditionError } from './applicant-precondition.ts';
import { readPrivateJson, PrivateInputError } from './private-http.ts';
import { WorkerError, withWorker, type WorkerOptions } from './worker-store.ts';
import * as p from './worker-protocol.ts';
import { createPairing, pairWorker, listWorkers, revokeWorker, revokePairing, scheduleWorker } from './pairing.ts';
import { createRun, listRuns, commandRun, commandApplication } from './runs.ts';
import { pollWorker, heartbeatWorker } from './leases.ts';
import { recordWorkerEvent } from './events.ts';
import { beginSubmission, recordReceipt } from './submissions.ts';
import { applicationContext, applicationDocumentOwner } from './application-context.ts';
import { createArtifactIntent, uploadArtifact } from './artifacts.ts';
import { listMaterials, recordSubmittedLetter } from './materials.ts';
import { listLive, recordLiveFrame, setReviewEdits, setVerificationCode, takeVerificationCode } from './live.ts';
import { documentStorageConfig, readDocumentObject } from './documents-storage.ts';
import { getPolicy, getProfile } from './stores.ts';
import { ApplicationContextSchema, ApplicationContextRequestSchema } from './application-context-protocol.ts';
import {
  BYOK_PROVIDER_ID, LOCAL_OLLAMA_ENDPOINT, LOCAL_OLLAMA_PROVIDER_ID, OMNIROUTE_PROVIDER_ID,
  ProviderConfigRequestSchema, ProviderConfigSchema,
} from './provider-protocol.ts';
import { ArtifactIntentSchema, ArtifactIntentResponseSchema, ArtifactUploadResponseSchema } from './artifact-protocol.ts';

async function limit(key: string, max: number) {
  if (await countRequest(getPrivateDb(), key) > max) throw new WorkerError(429, 'RATE_LIMITED', 'Too many requests. Retry next minute.');
}
export { limit as limitWorkerRequests };
function errorResponse(error: unknown, headers?: HeadersInit) {
  let status = 503, code = 'UNAVAILABLE', message = 'Private worker storage unavailable.';
  if (error instanceof WorkerError) { status = error.status; code = error.code; message = error.message; }
  else if (error instanceof ApplicantPreconditionError) { status = 403; code = 'PRINCIPAL_CHANGED'; message = error.message; }
  else if (error instanceof PrivateInputError) { status = error.status; code = 'INVALID_INPUT'; message = error.message; }
  else if (error instanceof z.ZodError) { status = 400; code = 'INVALID_INPUT'; message = 'Invalid request fields.'; }
  const responseHeaders = new Headers(headers);
  if (status === 429) responseHeaders.set('Retry-After', '60');
  return privateJson({ error: message, code }, { status, headers: responseHeaders });
}
function checkPath(request: Request, ids: string[]) {
  if (new URL(request.url).search || ids.some((id) => !z.uuid().safeParse(id).success)) {
    throw new WorkerError(400, 'INVALID_INPUT', 'Invalid request path.');
  }
}
type BrowserAction = 'list-workers' | 'create-pairing' | 'revoke-pairing' | 'revoke-worker' | 'schedule-worker' |
  'list-runs' | 'create-run' | 'command-run' | 'command-application' | 'list-materials' | 'list-live' | 'verification-code' | 'review-edits';

const confirmed = <T>(fact: { state: string; value: T | null }) => fact.state === 'confirmed' ? fact.value : null;
export function buildProviderConfig(
  ownerId: string,
  profileResponse: Awaited<ReturnType<typeof getProfile>>,
  policy: Awaited<ReturnType<typeof getPolicy>>,
) {
  const profile = profileResponse.profile.documentsProvider;
  const currentPolicy = policy.policy;
  const selected = confirmed(profile.provider);
  // A stored legacy 'typesafe_jev' choice falls through to 'none': the worker no longer has that provider.
  const provider = selected === 'local' ? 'local_ollama' :
    selected === 'omniroute' ? 'omniroute' : selected === 'remote' ? 'byok' : 'none';
  const providerId = provider === 'local_ollama' ? LOCAL_OLLAMA_PROVIDER_ID :
    provider === 'omniroute' ? OMNIROUTE_PROVIDER_ID : provider === 'byok' ? BYOK_PROVIDER_ID : null;
  const local = provider === 'local_ollama';
  const remote = provider !== 'none' && !local;
  const endpoint = provider === 'local_ollama' ? (confirmed(profile.endpoint) ?? LOCAL_OLLAMA_ENDPOINT) : confirmed(profile.endpoint);
  const model = confirmed(profile.model);
  const protocol = provider === 'local_ollama' ? 'ollama_native' : 'openai_compatible';
  const locality = provider === 'none' ? 'none' : local ? 'local' : 'remote';
  // Only this exact OpenAI endpoint/model has verified public pricing. Other BYOK hosts remain blocked.
  const openAiLuna = provider === 'byok' && endpoint === 'https://api.openai.com/v1/chat/completions' && model === 'gpt-6-luna';
  const pricing = local ? { known: true, inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
    : openAiLuna ? { known: true, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 }
      : { known: false, inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  const budgetConfig = { perRequestUsd: currentPolicy.budget.perRequest, perRunUsd: currentPolicy.budget.perRun,
    perDayUsd: currentPolicy.budget.perDay, allowUnknownCost: false as const };
  const policyReady = !!providerId && currentPolicy.allowedProviders.includes(providerId) && currentPolicy.fallbackOrder.length === 0;
  const localPolicyReady = local && currentPolicy.privacy !== 'approved_remote' && !currentPolicy.remoteProviderConsent;
  const remotePolicyReady = remote && currentPolicy.privacy === 'approved_remote' && currentPolicy.remoteProviderConsent;
  const enabled = provider !== 'none' && !!model && !!endpoint && policy.enabled && policyReady &&
    (localPolicyReady || remotePolicyReady) && (local || pricing.known);
  return ProviderConfigSchema.parse({
    providerProtocolVersion: 1, ownerId, profileRevision: profileResponse.revision,
    policyRevision: policy.revision, policyVersion: policy.policyVersion, policyHash: policy.policyHash, enabled, provider,
    model: provider === 'none' ? null : model, endpoint: provider === 'none' ? null : endpoint,
    privacy: currentPolicy.privacy, remoteProviderConsent: currentPolicy.remoteProviderConsent,
    allowedProviders: currentPolicy.allowedProviders, fallbackOrder: currentPolicy.fallbackOrder,
    // Kept on the wire (always 0) until every worker parsing the old strict schema has restarted.
    maxUsd: 0,
    protocol: provider === 'none' ? null : protocol, locality, credential: provider === 'none' || local ? 'none' : 'os_keychain',
    budget: budgetConfig, pricing, capability: null,
  });
}
async function providerConfig(db: Parameters<typeof getProfile>[0], ownerId: string) {
  const [profileResponse, policy] = await Promise.all([getProfile(db, ownerId), getPolicy(db, ownerId)]);
  return buildProviderConfig(ownerId, profileResponse, policy);
}

export async function browserWorkerEndpoint(request: Request, action: BrowserAction, ...ids: string[]) {
  let headers: Headers | undefined;
  try {
    checkPath(request, ids);
    const result = await lookupApplicant(request);
    if (result instanceof Response) {
      const body = await result.json().catch(() => ({}));
      return privateJson({ error: body.error ?? 'Applicant authorization required.',
        code: result.status === 401 ? 'AUTH_REQUIRED' : result.status === 403 ? 'FORBIDDEN' :
          result.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE' },
      { status: result.status, headers: result.headers });
    }
    headers = result.response.headers;
    const ownerId = result.applicant.ownerId;
    assertExpectedApplicant(request, ownerId);
    await limit(`private-worker-browser:${ownerId}`, 60);
    const db = getPrivateDb(), options: WorkerOptions = {};
    let body: unknown;
    switch (action) {
      case 'list-workers': body = p.WorkerListSchema.parse(await listWorkers(db, ownerId, options)); break;
      case 'create-pairing': body = p.PairingGrantSchema.parse(await createPairing(db, ownerId, await readPrivateJson(request, p.PairingCreateSchema), options)); break;
      case 'revoke-worker': body = p.RevocationSchema.parse(await revokeWorker(db, ownerId, ids[0], await readPrivateJson(request, p.RevisionCommandSchema), options)); break;
      case 'schedule-worker': body = p.WorkerScheduleAckSchema.parse(await scheduleWorker(db, ownerId, ids[0], await readPrivateJson(request, p.WorkerScheduleSchema), options)); break;
      case 'revoke-pairing': body = p.RevocationSchema.parse(await revokePairing(db, ownerId, ids[0], await readPrivateJson(request, p.RevisionCommandSchema), options)); break;
      case 'list-runs': body = p.RunListSchema.parse(await listRuns(db, ownerId)); break;
      case 'create-run': body = p.RunSchema.parse(await createRun(db, ownerId, await readPrivateJson(request, p.RunCreateSchema), options)); break;
      case 'command-run': body = p.RunSchema.parse(await commandRun(db, ownerId, ids[0], await readPrivateJson(request, p.RunCommandSchema), options)); break;
      case 'command-application': body = p.ApplicationSummarySchema.parse(await commandApplication(db, ownerId, ids[0], ids[1], await readPrivateJson(request, p.ApplicationCommandSchema), options)); break;
      case 'list-materials': body = p.MaterialsSchema.parse(await listMaterials(db, ownerId)); break;
      case 'list-live': body = p.LiveListSchema.parse(await listLive(db, ownerId)); break;
      case 'verification-code': body = p.VerificationCodeAckSchema.parse(await setVerificationCode(db, ownerId, ids[0], await readPrivateJson(request, p.VerificationCodeSchema))); break;
      case 'review-edits': body = p.ReviewEditsAckSchema.parse(await setReviewEdits(db, ownerId, ids[0], await readPrivateJson(request, p.ReviewEditsSchema))); break;
    }
    return privateJson(body, { headers });
  } catch (error) { return errorResponse(error, headers); }
}
export async function workerEndpoint(request: Request, action: 'pair' | 'poll' | 'heartbeat' | 'event' | 'submission-intent' | 'receipt' | 'provider-config' | 'context' | 'artifact-intent' | 'letter' | 'live' | 'verification-code', id?: string) {
  try {
    checkPath(request, id ? [id] : []);
    const db = getPrivateDb(), options: WorkerOptions = {};
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
    let workerOwnerId: string | undefined;
    if (action === 'pair') await limit('private-worker-pair', 30);
    else {
      // Authentication runs before allocating a bucket, so arbitrary tokens cannot grow it.
      const worker = await withWorker(db, token, options, async (_tx, row) => ({ id: row.id, ownerId: row.ownerId }));
      workerOwnerId = worker.ownerId;
      await limit(`private-worker:${worker.id}`, 120);
    }
    const raw = await readPrivateJson(request, z.unknown());
    if (!raw || typeof raw !== 'object' || !('protocolVersion' in raw) || raw.protocolVersion !== p.WORKER_PROTOCOL_VERSION ||
        ('capabilities' in raw && JSON.stringify(raw.capabilities) !== JSON.stringify(p.WORKER_CAPABILITIES))) {
      throw new WorkerError(426, 'PROTOCOL_MISMATCH', 'Worker protocol or capabilities are not supported.');
    }
    let body: unknown;
    switch (action) {
      case 'pair': body = p.PairResponseSchema.parse(await pairWorker(db, p.PairRequestSchema.parse(raw), options)); break;
      case 'poll': body = p.PollResponseSchema.parse(await pollWorker(db, token, p.PollRequestSchema.parse(raw), { ...options, corpus: getDiscoveryCorpus })); break;
      case 'heartbeat': body = p.PollResponseSchema.parse(await heartbeatWorker(db, token, p.HeartbeatRequestSchema.parse(raw), options)); break;
      case 'event': body = p.EventResponseSchema.parse(await recordWorkerEvent(db, token, id!, p.EventRequestSchema.parse(raw), options)); break;
      case 'submission-intent': body = p.SubmissionIntentResponseSchema.parse(await beginSubmission(db, token, id!, p.SubmissionIntentSchema.parse(raw), options)); break;
      case 'receipt': body = p.ReceiptResponseSchema.parse(await recordReceipt(db, token, id!, p.ReceiptCommandSchema.parse(raw), options)); break;
      case 'context': body = ApplicationContextSchema.parse(await applicationContext(db, token, id!, ApplicationContextRequestSchema.parse(raw), options)); break;
      case 'artifact-intent': body = ArtifactIntentResponseSchema.parse(await createArtifactIntent(db, token, id!, ArtifactIntentSchema.parse(raw), options)); break;
      case 'letter': body = p.SubmittedLetterAckSchema.parse(await recordSubmittedLetter(db, token, id!, p.SubmittedLetterSchema.parse(raw), options)); break;
      case 'live': body = p.LiveFrameAckSchema.parse(await recordLiveFrame(db, token, id!, p.LiveFrameSchema.parse(raw), options)); break;
      case 'verification-code': body = p.VerificationCodeResponseSchema.parse(await takeVerificationCode(db, token, id!, raw, options)); break;
      case 'provider-config': {
        ProviderConfigRequestSchema.parse(raw);
        body = await providerConfig(db, workerOwnerId!);
        body = ProviderConfigSchema.parse(body);
        break;
      }
    }
    return privateJson(body);
  } catch (error) { return errorResponse(error); }
}

export async function workerArtifactUploadEndpoint(request: Request, applicationId: string, artifactId: string) {
  try {
    checkPath(request, [applicationId, artifactId]);
    const db = getPrivateDb(), options: WorkerOptions = {};
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
    const worker = await withWorker(db, token, options, async (_tx, row) => ({ id: row.id }));
    await limit(`private-worker:${worker.id}`, 120);
    return privateJson(ArtifactUploadResponseSchema.parse(await uploadArtifact(db, token, applicationId, artifactId, request, options)));
  } catch (error) { return errorResponse(error); }
}

export async function workerDocumentEndpoint(request: Request, applicationId: string, documentId: string) {
  try {
    if (request.method !== 'GET' || new URL(request.url).search) throw new WorkerError(400, 'INVALID_INPUT', 'Invalid document request.');
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
    const db = getPrivateDb(), options: WorkerOptions = {};
    const worker = await withWorker(db, token, options, async (_tx, row) => ({ id: row.id }));
    await limit(`private-worker:${worker.id}`, 120);
    const document = await applicationDocumentOwner(db, token, applicationId, documentId, options);
    const bytes = await readDocumentObject(documentStorageConfig(), document.objectKey);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== document.sha256 || bytes.length !== document.size) throw new WorkerError(503, 'DOCUMENT_CHANGED', 'Document bytes are unavailable.');
    const headers = new Headers({ 'Content-Type': document.mime, 'Content-Length': String(bytes.length) });
    return privateResponse(new Response(Buffer.from(bytes), { headers }));
  } catch (error) { return errorResponse(error); }
}
