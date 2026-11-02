import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationEvents, applications } from '../private-db/schema.ts';
import { getPolicy, hashValue } from './stores.ts';
import { canTransition, isTerminalState, isWaitingState } from './state.ts';
import { EventRequestSchema, type EventRequest, type EventResponse } from './worker-protocol.ts';
import { checkedLease } from './leases.ts';
import { withWorker, appScope, one, leaseOf, fail, WorkerError, type WorkerOptions } from './worker-store.ts';

export async function recordWorkerEvent(
  db: PrivateDb, token: string, applicationId: string, input: EventRequest, options: WorkerOptions = {},
): Promise<EventResponse> {
  const command = EventRequestSchema.parse(input);
  return withWorker<EventResponse>(db, token, options, async (tx, worker, now) => {
    const [owned] = await tx.select().from(applications).where(and(appScope(worker.ownerId, applicationId), eq(applications.workerId, worker.id)));
    if (!owned) fail(404, 'NOT_FOUND', 'Application not found.');
    const [previous] = await tx.select().from(applicationEvents).where(and(
      eq(applicationEvents.ownerId, worker.ownerId), eq(applicationEvents.applicationId, applicationId), eq(applicationEvents.eventId, command.eventId),
    ));
    if (previous) {
      if (previous.requestHash !== hashValue(command)) fail();
      const ack = previous.acknowledgement as EventResponse;
      // A historical acknowledgement is not a renewed lease or a browser mutation permit.
      return { ...ack, replayed: true, lease: null, serverTime: now };
    }
    const app = await checkedLease(tx, worker, { applicationId, fence: command.fence, expectedRevision: command.expectedRevision }, now);
    if (app instanceof WorkerError) return app;
    if (!canTransition(app.state, command.state, command.evidence ?? {})) {
      fail(409, 'EXECUTION_DISABLED', 'Transition requires unavailable execution evidence.');
    }
    // A filled form waits for the applicant's Apply unless the policy lets it go out unreviewed.
    if (app.state === 'filling' && command.state === 'ready') {
      const policy = await getPolicy(tx, worker.ownerId, now);
      if (!policy.enabled || !policy.policy.actions.includes('submit_without_review')) fail(403, 'SUBMIT_DISABLED', 'Submitting without review is not enabled in the policy.');
    }
    // A submission the worker could not confirm releases like a hold, naming why; it started from ready, so the checkpoint stays there.
    const release = isWaitingState(command.state) || isTerminalState(command.state) || command.state === 'submission_unknown';
    const stage = release ? (app.state === 'submitting' ? 'ready' : app.state) : command.state;
    if (command.checkpoint.stage !== stage || command.checkpoint.sequence !== (app.checkpoint?.sequence ?? 0) + 1) {
      fail(409, 'CONFLICT', 'Checkpoint is not the next safe checkpoint.');
    }
    if (release && !command.reasonCode) {
      fail(400, 'INVALID_INPUT', 'A reason code is required.');
    }
    const updated = one(await tx.update(applications).set({
      state: command.state, checkpoint: command.checkpoint, reasonCode: command.reasonCode,
      revision: app.revision + 1, ...(release ? { leaseUntil: null, leaseCheckedAt: null, fence: app.fence + 1 } : {}),
    }).where(and(appScope(worker.ownerId, applicationId), eq(applications.revision, app.revision), eq(applications.fence, app.fence))).returning());
    const acknowledgement: EventResponse = {
      applicationId, eventId: command.eventId, revision: updated.revision, state: updated.state,
      replayed: false, lease: release ? null : await leaseOf(tx, updated), serverTime: now,
    };
    one(await tx.insert(applicationEvents).values({
      ownerId: worker.ownerId, applicationId, eventId: command.eventId, requestHash: hashValue(command),
      acknowledgement: { ...acknowledgement, lease: null }, createdAt: now,
    }).returning({ eventId: applicationEvents.eventId }));
    return acknowledgement;
  });
}
