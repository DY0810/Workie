import 'server-only';
import { z } from 'zod';
import { privateJson } from '../applicant-access.ts';
import { getPrivateDb } from '../private-db/index.ts';
import { privateEndpoint, readPrivateJson, PrivateInputError } from './private-http.ts';
import { WorkerError, withWorker } from './worker-store.ts';
import { limitWorkerRequests } from './worker-http.ts';
import * as p from './question-protocol.ts';
import { formOptions } from './form-options.ts';
import {
  getInbox, getInboxStatus, getQuestion, markInboxRead, answerQuestion, answerQuestions,
  requestQuestionFocus, registerQuestionBatch, pollQuestionInterventions, ackQuestionIntervention,
} from './questions.ts';

type BrowserAction = 'inbox' | 'status' | 'read' | 'question' | 'options' | 'answer' | 'answers' | 'focus';
function checkPath(request: Request, id?: string, pagination = false) {
  const query = new URL(request.url).searchParams;
  if ((id !== undefined && !z.uuid().safeParse(id).success) ||
      [...query.keys()].some(key => !pagination || !['limit', 'cursor', 'applicationId'].includes(key) || query.getAll(key).length !== 1) ||
      (query.has('limit') && !/^(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/.test(query.get('limit')!))) {
    throw new PrivateInputError(400, 'Invalid request path.');
  }
  return query;
}
// Never reflect schema diagnostics, question wording, answers, or storage exception text.
function rejection(error: WorkerError): PrivateInputError {
  const code = /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'UNAVAILABLE';
  return new PrivateInputError(error.status, 'Question request rejected.', code);
}
export function questionsEndpoint(request: Request, action: BrowserAction, id?: string) {
  return privateEndpoint(request, async ownerId => {
    try {
      const query = checkPath(request, id, action === 'inbox' && request.method === 'GET');
      const db = getPrivateDb(), options = {};
      switch (action) {
        case 'inbox': {
          const input = p.InboxQuerySchema.safeParse(Object.fromEntries(query));
          if (!input.success) throw new PrivateInputError(400, 'Invalid request fields.');
          return p.InboxPageSchema.parse(await getInbox(db, ownerId, input.data, options));
        }
        case 'status': return p.InboxStatusSchema.parse(await getInboxStatus(db, ownerId, options));
        case 'question': return p.QuestionDetailSchema.parse(await getQuestion(db, ownerId, id!, options));
        case 'options': {
          const { descriptor, application } = await getQuestion(db, ownerId, id!, options);
          return { options: descriptor.field.type === 'text' && descriptor.key.startsWith('form-')
            ? await formOptions(application.ats, application.tenant, application.requisition, descriptor.originalWording) : [] };
        }
        case 'read': return z.strictObject({ ownerId: z.string(), eventIds: z.array(z.uuid()).max(50) })
          .parse(await markInboxRead(db, ownerId, await readPrivateJson(request, p.ReadCommandSchema)));
        case 'answer': return p.AnswerResultSchema.parse(await answerQuestion(db, ownerId, id!,
          await readPrivateJson(request, p.AnswerCommandSchema), options));
        case 'answers': return p.AnswerBatchResultSchema.parse(await answerQuestions(db, ownerId,
          await readPrivateJson(request, p.AnswerBatchSchema), options));
        case 'focus': return p.FocusResultSchema.parse(await requestQuestionFocus(db, ownerId, id!,
          await readPrivateJson(request, p.FocusCommandSchema), options));
      }
    } catch (error) {
      if (error instanceof WorkerError) throw rejection(error);
      throw error;
    }
  });
}

export async function workerQuestionsEndpoint(request: Request, action: 'batch' | 'poll' | 'ack', id?: string) {
  try {
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new PrivateInputError(401, 'Worker authorization required.', 'WORKER_UNAUTHORIZED');
    const db = getPrivateDb(), options = {};
    // No session-cookie authority and no attacker-created per-token rate buckets.
    const workerId = await withWorker(db, token, options, async (_tx, worker) => worker.id);
    await limitWorkerRequests(`private-worker:${workerId}`, 120);
    checkPath(request, id);
    const raw = await readPrivateJson(request, z.unknown());
    if (!raw || typeof raw !== 'object' || !('questionProtocolVersion' in raw) || raw.questionProtocolVersion !== 1) {
      throw new PrivateInputError(426, 'Question protocol not supported.', 'PROTOCOL_MISMATCH');
    }
    const schema = action === 'batch' ? p.QuestionBatchSchema : action === 'poll' ? p.InterventionPollSchema : p.InterventionAckSchema;
    const input = schema.safeParse(raw);
    if (!input.success) throw new PrivateInputError(400, 'Invalid request fields.', 'INVALID_INPUT');
    switch (action) {
      case 'batch': return privateJson(p.QuestionBatchResultSchema.parse(await registerQuestionBatch(db, token, id!,
        input.data as p.QuestionBatch, options)));
      case 'poll': return privateJson(p.InterventionPageSchema.parse(await pollQuestionInterventions(db, token, options)));
      case 'ack': return privateJson(p.FocusResultSchema.parse(await ackQuestionIntervention(db, token, id!,
        input.data as p.InterventionAck, options)));
    }
  } catch (error) {
    const known = error instanceof WorkerError ? rejection(error) : error instanceof PrivateInputError ? error : null;
    const status = known?.status ?? 503;
    return privateJson({ error: known?.message ?? 'Private question storage unavailable.', code: known?.code ?? 'UNAVAILABLE' },
      { status, headers: status === 429 ? { 'Retry-After': '60' } : undefined });
  }
}
