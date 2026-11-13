import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { readCapped } from "../lib/read-capped.ts";
import {
  QuestionBatchSchema, QuestionBatchResultSchema, InterventionPollSchema,
  InterventionPageSchema, InterventionAckSchema, FocusResultSchema,
} from "../lib/applications/question-protocol.ts";
import type { QuestionBatch, InterventionAck } from "../lib/applications/question-protocol.ts";
import {
  PairRequestSchema, PairResponseSchema, PollRequestSchema, PollResponseSchema,
  HeartbeatRequestSchema, EventRequestSchema, EventResponseSchema, WORKER_PROTOCOL_VERSION, POLL_TIMEOUT_MS,
  SubmissionIntentSchema, SubmissionIntentResponseSchema, ReceiptCommandSchema, ReceiptResponseSchema,
  SubmittedLetterSchema, SubmittedLetterAckSchema, LiveFrameSchema, LiveFrameAckSchema,
  VerificationCodeTakeSchema, VerificationCodeResponseSchema, OutreachResultSchema, OutreachResultAckSchema,
} from "../lib/applications/worker-protocol.ts";
import type { PairRequest, HeartbeatRequest, EventRequest, OutreachResult } from "../lib/applications/worker-protocol.ts";
import {
  ProviderConfigRequestSchema, ProviderConfigSchema,
} from "../lib/applications/provider-protocol.ts";
import { ApplicationContextRequestSchema, ApplicationContextSchema } from "../lib/applications/application-context-protocol.ts";
import {
  ArtifactIntentSchema, ArtifactIntentResponseSchema, ArtifactUploadHeaderSchema, ArtifactUploadResponseSchema,
} from "../lib/applications/artifact-protocol.ts";

export function controlOrigin(input: string, allowLoopback = false) {
  let url;
  try { url = new URL(input); } catch { throw new Error("INVALID_ORIGIN"); }
  if (input !== url.origin || url.username || url.password || url.search || url.hash) throw new Error("INVALID_ORIGIN");
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
    (!loopback && (url.hostname.startsWith("127.") || url.hostname.startsWith("[::ffff:")))) {
    throw new Error("INVALID_ORIGIN");
  }
  if (loopback && !allowLoopback) throw new Error("LOOPBACK_DISABLED");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && allowLoopback)) throw new Error("INVALID_ORIGIN");
  return url.origin;
}

export class TransportError extends Error {
  status: number;
  /** The server's error code (e.g. CONTEXT_UNAVAILABLE), when its error body named one. */
  code?: string;
  constructor(message: string, status = 0, code?: string) { super(message); this.status = status; this.code = code; }
}

async function httpError(response: Response): Promise<TransportError> {
  let code: string | undefined;
  try {
    const text = new TextDecoder().decode(await readCapped(response.body!, 4096, { overflow: () => new Error("LIMIT") }));
    const parsed = z.object({ code: z.string().regex(/^[A-Z_]{1,64}$/) }).safeParse(JSON.parse(text));
    if (parsed.success) code = parsed.data.code;
  } catch { /* An unreadable body only loses the code. */ }
  return new TransportError(`HTTP_${response.status}`, response.status, code);
}

export function workerTransport(options: {
  origin: string; token?: string; allowLoopback?: boolean; timeoutMs?: number;
}) {
  const origin = controlOrigin(options.origin, options.allowLoopback);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS_BYPASS_FORBIDDEN");
  if (options.token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error("INVALID_CREDENTIAL");
  const timeout = options.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 8000) throw new Error("INVALID_TIMEOUT");
  // A fetch can be dropped without ever settling, and its AbortSignal.timeout (an unref'd timer) goes with it;
  // both live workers froze for good that way on 2026-10-22. A plain timer is the backstop the event loop keeps.
  const bounded = <T>(ms: number, work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransportError("NETWORK_UNAVAILABLE")), ms);
    });
    return Promise.race([work(), expired]).finally(() => clearTimeout(timer));
  };
  async function post<T>(
    path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal, checkpoint = false,
    requestTimeoutMs = timeout,
  ): Promise<T> {
    return bounded(requestTimeoutMs, () => send(path, body, schema, signal, checkpoint, requestTimeoutMs));
  }
  async function send<T>(
    path: string, body: unknown, schema: z.ZodType<T>, signal: AbortSignal | undefined, checkpoint: boolean,
    requestTimeoutMs: number,
  ): Promise<T> {
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > 128 * 1024) throw new TransportError("REQUEST_LIMIT");
    const deadline = AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), ...(signal ? [signal] : [])]);
    // Only idempotent checkpoint events retry automatically, with the same serialized body/key.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${origin}${path}`, {
          method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
          headers: {
            "Content-Type": "application/json", Accept: "application/json",
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          },
          body: payload,
          signal: deadline,
        });
        try {
          if (!response.ok) throw response.body ? await httpError(response) : new TransportError(`HTTP_${response.status}`, response.status);
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) {
            throw new TransportError("INVALID_RESPONSE");
          }
          const length = Number(response.headers.get("content-length"));
          if (!Number.isFinite(length) || length > 128 * 1024) throw new TransportError("RESPONSE_LIMIT");
          const bytes = await readCapped(response.body, 128 * 1024, { overflow: () => new TransportError("RESPONSE_LIMIT") });
          let parsed;
          try { parsed = schema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
          catch { throw new TransportError("INVALID_RESPONSE"); }
          if (!parsed.success) throw new TransportError("INVALID_RESPONSE");
          return parsed.data;
        } finally {
          // An unread body (an early throw above) is released; readCapped already cancelled a read one.
          if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
        }
      } catch (error) {
        const safe = error instanceof TransportError ? error : new TransportError(signal?.aborted ? "STOPPED" : "NETWORK_UNAVAILABLE");
        if (!checkpoint || attempt >= 2 || deadline.aborted ||
          !(safe.message === "NETWORK_UNAVAILABLE" || safe.status >= 500)) throw safe;
        try { await delay(100 * 2 ** attempt, undefined, { signal: deadline }); }
        catch { throw safe; }
      }
    }
  }
  const version = { protocolVersion: WORKER_PROTOCOL_VERSION };
  return {
    pair: (input: PairRequest, signal?: AbortSignal) =>
      post("/api/worker/pair", PairRequestSchema.parse(input), PairResponseSchema, signal),
    // `outreach`: this worker is signed in to LinkedIn and will take one approved recruiter message.
    poll: (signal?: AbortSignal, outreach = false) =>
      post("/api/worker/poll", PollRequestSchema.parse(outreach ? { ...version, outreach: true } : version), PollResponseSchema, signal, false,
        options.timeoutMs ?? POLL_TIMEOUT_MS),
    // Idempotent on the server (a settled message only acknowledges), so it retries like a checkpoint.
    outreachResult: (id: string, input: OutreachResult, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(id).success) throw new TransportError("INVALID_OUTREACH");
      return post(`/api/worker/outreach/${id}/result`, OutreachResultSchema.parse(input), OutreachResultAckSchema, signal, true);
    },
    heartbeat: (lease: HeartbeatRequest["lease"], signal?: AbortSignal) =>
      post("/api/worker/heartbeat", HeartbeatRequestSchema.parse({ ...version, lease }), PollResponseSchema, signal),
    providerConfig: (signal?: AbortSignal) =>
      post("/api/worker/provider-config", ProviderConfigRequestSchema.parse({
        ...version, providerProtocolVersion: 1,
      }), ProviderConfigSchema, signal),
    applicationContext: (applicationId: string, input: z.input<typeof ApplicationContextRequestSchema>, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/context`,
        ApplicationContextRequestSchema.parse(input), ApplicationContextSchema, signal);
    },
    artifactIntent: (applicationId: string, input: z.input<typeof ArtifactIntentSchema>, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/artifacts`, ArtifactIntentSchema.parse(input), ArtifactIntentResponseSchema, signal);
    },
    uploadArtifact: (applicationId: string, artifactId: string, path: string, input: z.input<typeof ArtifactUploadHeaderSchema>,
      bytes: Uint8Array, mime: string, signal?: AbortSignal) => bounded(timeout, async () => {
      if (!z.uuid().safeParse(applicationId).success || !z.uuid().safeParse(artifactId).success ||
          path !== `/api/worker/applications/${applicationId}/artifacts/${artifactId}/upload` || bytes.length > 10 * 1024 * 1024) {
        throw new TransportError("INVALID_ARTIFACT");
      }
      const header = ArtifactUploadHeaderSchema.parse(input);
      const deadline = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
      let response: Response;
      try {
        response = await fetch(`${origin}${path}`, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
          headers: { "Content-Type": mime, "Content-Length": String(bytes.length),
            "x-workie-protocol-version": String(header.protocolVersion), "x-workie-request-id": header.requestId,
            "x-workie-fence": String(header.fence), "x-workie-revision": String(header.expectedRevision),
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, body: Buffer.from(bytes), signal: deadline });
      } catch { throw new TransportError(signal?.aborted ? "STOPPED" : "NETWORK_UNAVAILABLE"); }
      if (!response.ok) throw new TransportError(`HTTP_${response.status}`, response.status);
      const body = await response.text();
      if (Buffer.byteLength(body) > 128 * 1024) throw new TransportError("RESPONSE_LIMIT");
      let parsed;
      try { parsed = ArtifactUploadResponseSchema.safeParse(JSON.parse(body)); } catch { parsed = { success: false } as const; }
      if (!parsed.success) throw new TransportError("INVALID_RESPONSE");
      return parsed.data;
    }),
    downloadDocument: (applicationId: string, documentId: string, path: string, signal?: AbortSignal) => bounded(timeout, async () => {
      if (!z.uuid().safeParse(applicationId).success || !z.uuid().safeParse(documentId).success) {
        throw new TransportError("INVALID_DOCUMENT");
      }
      if (path !== `/api/worker/applications/${applicationId}/documents/${documentId}`) {
        throw new TransportError("INVALID_DOCUMENT");
      }
      const deadline = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
      const response = await fetch(`${origin}${path}`, { method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
        headers: { Accept: "application/octet-stream", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, signal: deadline });
      if (!response.ok) throw new TransportError(`HTTP_${response.status}`, response.status);
      const length = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(length) || length < 1 || length > 10 * 1024 * 1024) throw new TransportError("INVALID_DOCUMENT");
      if (!response.body) throw new TransportError("INVALID_DOCUMENT");
      const bytes = await readCapped(response.body, 10 * 1024 * 1024, { overflow: () => new TransportError("RESPONSE_LIMIT") });
      if (bytes.length !== length) throw new TransportError("INVALID_DOCUMENT");
      return bytes;
    }),
    event: (applicationId: string, input: EventRequest, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/events`,
        EventRequestSchema.parse(input), EventResponseSchema, signal, true);
    },
    submissionIntent: (applicationId: string, input: z.infer<typeof SubmissionIntentSchema>, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/submission-intent`,
        SubmissionIntentSchema.parse(input), SubmissionIntentResponseSchema, signal, true);
    },
    receipt: (applicationId: string, input: z.infer<typeof ReceiptCommandSchema>, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/receipt`,
        ReceiptCommandSchema.parse(input), ReceiptResponseSchema, signal, true);
    },
    letter: (applicationId: string, input: z.input<typeof SubmittedLetterSchema>, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/letter`, SubmittedLetterSchema.parse(input), SubmittedLetterAckSchema, signal, true);
    },
    // Not a checkpoint: a lost frame is replaced by the next one, so it is never retried.
    live: (applicationId: string, input: z.input<typeof LiveFrameSchema>, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/live`, LiveFrameSchema.parse(input), LiveFrameAckSchema, signal);
    },
    // A security code the applicant entered on Workie, taken once; null until there is one.
    verificationCode: (applicationId: string, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/verification-code`,
        VerificationCodeTakeSchema.parse({ protocolVersion: WORKER_PROTOCOL_VERSION }), VerificationCodeResponseSchema, signal);
    },
    questionBatch: (applicationId: string, input: QuestionBatch, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(applicationId).success) throw new TransportError("INVALID_APPLICATION");
      return post(`/api/worker/applications/${applicationId}/questions`,
        QuestionBatchSchema.parse(input), QuestionBatchResultSchema, signal, true);
    },
    interventions: (signal?: AbortSignal) =>
      post("/api/worker/interventions", InterventionPollSchema.parse({ questionProtocolVersion: 1 }), InterventionPageSchema, signal),
    ackIntervention: (id: string, input: InterventionAck, signal?: AbortSignal) => {
      if (!z.uuid().safeParse(id).success) throw new TransportError("INVALID_INTERVENTION");
      return post(`/api/worker/interventions/${id}/ack`,
        InterventionAckSchema.parse(input), FocusResultSchema, signal, true);
    },
  };
}
export type WorkerTransport = ReturnType<typeof workerTransport>;
