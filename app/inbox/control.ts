import { z } from 'zod';
import { isOpenQuestion } from '../../lib/applications/buckets';
import { DraftVault, unlockDraftKey } from '../../lib/profile-drafts';
import {
  AnswerBatchResultSchema, AnswerCommandSchema, AnswerResultSchema, FocusCommandSchema, FocusResultSchema,
  InboxPageSchema, QuestionDetailSchema,
  type AnswerCommand, type QuestionDetail,
} from '../../lib/applications/question-protocol';
import { privateJson, PrivateRequestError, type PrivateApi } from '../profile/api';

const accountSchema = z.object({ ownerId: z.string().min(1) });
const keySchema = z.object({ ownerId: z.string(), keyVersion: z.string(), key: z.string() });
export const EditSchema = z.object({
  input: z.string().max(100_000), choices: z.array(z.string()).max(100),
  mode: z.enum(['answer', 'blank', 'decline']),
});
export type Edit = z.infer<typeof EditSchema>;
const draftSchema = z.object({ question: QuestionDetailSchema, desired: EditSchema, dirty: z.boolean() });
const pendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), questionId: z.uuid(), body: AnswerCommandSchema, sent: EditSchema }),
  z.object({ kind: z.literal('focus'), questionId: z.uuid(), body: FocusCommandSchema }),
]);
const snapshotSchema = z.object({
  revision: z.literal(1), drafts: z.record(z.uuid(), draftSchema), pending: pendingSchema.nullable(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
type Pending = z.infer<typeof pendingSchema>;
type Recovery = { slot: string; snapshot: Snapshot };
type Page = z.infer<typeof InboxPageSchema>;
export type InboxView = {
  ownerId: string | null; inbox: Page | null; selected: QuestionDetail | null;
  locked: boolean; loading: boolean; busy: boolean; error: string; notice: string;
  draftError: string; recoveries: Recovery[]; snapshot: Snapshot; failures: number;
};
const emptySnapshot = (): Snapshot => ({ revision: 1, drafts: {}, pending: null });
export const initialView = (): InboxView => ({
  ownerId: null, inbox: null, selected: null, locked: true, loading: true, busy: false,
  error: '', notice: '', draftError: '', recoveries: [], snapshot: emptySnapshot(), failures: 0,
});
export const emptyEdit = (): Edit => ({ input: '', choices: [], mode: 'answer' });
export function sameQuestion(a: QuestionDetail, b: QuestionDetail) {
  return a.revision === b.revision && a.expectedScopeHash === b.expectedScopeHash &&
    a.expectedProfileRevision === b.expectedProfileRevision && a.expectedPolicyRevision === b.expectedPolicyRevision &&
    JSON.stringify(a.factVersions) === JSON.stringify(b.factVersions) &&
    JSON.stringify(a.descriptor) === JSON.stringify(b.descriptor);
}
export const pollingDelay = (failures: number) => Math.min(120_000, 15_000 * 2 ** Math.min(failures, 3));

class RequestError extends Error {
  constructor(readonly status: number, readonly code = '') {
    super(code === 'PRINCIPAL_CHANGED' ? 'Account changed. Unlock the current account.' :
      status === 401 ? 'Unlock Workie to view your private inbox.' :
        status === 403 ? 'Applicant access is not permitted. Check your account.' :
          status === 409 ? 'Question, policy or profile changed. Review the current question before answering.' :
            status === 429 ? 'Too many requests. Wait before retrying.' :
              status === 503 ? 'Private inbox unavailable. Retry later; public jobs remain available.' :
                status === 400 || status === 422 ? 'Answer rejected. Check the current question and fields.' :
                  'Connection interrupted. Retry the pending request; your latest edit is retained.');
  }
}

/** Private client state only. Reads, recovery and polling never replay a mutation. */
export class InboxControl {
  view = initialView();
  private operation: AbortController | null = null;
  private ownerAbort = new AbortController();
  private vault: DraftVault | null = null;
  private keyVersion = '';
  private disposed = false;
  private persisted: Promise<boolean> = Promise.resolve(true);
  private waiting = new Set<string>();
  constructor(private readonly publish: (view: InboxView) => void, private readonly storage: Storage | null) {}
  get signal() { return this.ownerAbort.signal; }
  get dirty() {
    return !!this.view.snapshot.pending || Object.values(this.view.snapshot.drafts).some((d) => d.dirty) || !!this.vault?.pending;
  }
  private update(patch: Partial<InboxView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.publish(this.view);
  }
  private begin() {
    this.operation?.abort();
    this.operation = new AbortController();
    return this.operation.signal;
  }
  private clearOwner() {
    this.ownerAbort.abort();
    this.ownerAbort = new AbortController();
    this.vault?.dispose();
    this.vault = null;
    this.keyVersion = '';
    this.update(initialView());
  }
  private async request(path: string, signal: AbortSignal, owner?: string, init: RequestInit = {}) {
    try {
      return await privateJson(path, { ...init, signal, owner, timeout: 15_000 });
    } catch (error) {
      if (!(error instanceof PrivateRequestError)) throw error;
      if (owner && error.status === 403 && error.code !== 'PRINCIPAL_CHANGED') await this.assertOwner(owner, signal);
      throw new RequestError(error.status, error.code);
    }
  }
  private async assertOwner(owner: string, signal: AbortSignal) {
    const account = accountSchema.parse(await this.request('/api/auth/applicant', signal));
    signal.throwIfAborted();
    if (account.ownerId !== owner) {
      this.clearOwner();
      throw new RequestError(403, 'PRINCIPAL_CHANGED');
    }
  }
  private fail(error: unknown) {
    if (error instanceof RequestError && error.code === 'PRINCIPAL_CHANGED') this.clearOwner();
    this.update({
      error: error instanceof RequestError ? error.message : error instanceof z.ZodError ?
        'Incompatible inbox response. Refresh before continuing.' : 'Connection interrupted. Your draft and pending request are retained.',
      failures: this.view.failures + 1,
      ...(error instanceof RequestError && [401, 403].includes(error.status) || error instanceof z.ZodError ? { locked: true } : {}),
    });
  }
  private persist() {
    const vault = this.vault;
    if (!vault) return Promise.resolve(false);
    this.persisted = vault.save(this.view.snapshot).then((saved) => {
      if (this.vault === vault && saved) this.update({ draftError: '' });
      return saved;
    }).catch(() => {
      if (this.vault === vault) this.update({ draftError: 'Encrypted recovery could not be saved. Keep this tab open.' });
      return false;
    });
    return this.persisted;
  }
  private async unlockVault(owner: string, signal: AbortSignal) {
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      const key = keySchema.parse(await this.request('/api/profile/draft-key', signal, owner));
      if (key.ownerId !== owner) throw new RequestError(403, 'PRINCIPAL_CHANGED');
      if (this.vault && this.keyVersion === key.keyVersion) return;
      const cryptoKey = await unlockDraftKey(key.key);
      signal.throwIfAborted();
      const previous = this.vault;
      const vault = new DraftVault(this.storage, owner, 1, key.keyVersion, cryptoKey, undefined, undefined, 'inbox');
      const recoveries: Recovery[] = [];
      let inaccessible = false;
      if (!previous) {
        for (const slot of vault.slots()) {
          try {
            const snapshot = snapshotSchema.parse(await vault.read(slot));
            if (snapshot.pending || Object.values(snapshot.drafts).some((d) => d.dirty)) recoveries.push({ slot, snapshot });
          } catch { inaccessible = true; }
        }
      }
      signal.throwIfAborted();
      this.vault = vault;
      this.keyVersion = key.keyVersion;
      previous?.dispose();
      this.update({ recoveries, draftError: inaccessible ?
        'A saved draft could not be unlocked. Its key may have rotated; the encrypted copy is unchanged.' : '' });
      if (previous) {
        await this.persist();
        this.update({ notice: 'Draft key rotated. Current unsaved edits and pending request IDs were retained.' });
      }
    } catch (error) {
      if (error instanceof RequestError && [401, 403].includes(error.status)) throw error;
      if (signal.aborted) throw error;
      this.update({ draftError: 'Encrypted recovery unavailable. Keep this tab open until your answer is acknowledged.' });
    }
  }
  /** Applications waiting on answers; any whose questions are older than the pages loaded below are read on their own. */
  need(applicationIds: string[]) {
    const added = applicationIds.some((id) => !this.waiting.has(id));
    this.waiting = new Set(applicationIds);
    if (added && this.view.inbox?.nextCursor) void this.refresh();
  }
  private async load(owner: string, signal: AbortSignal, cursor?: string) {
    const page = async (after?: string, applicationId?: string) => {
      const next = InboxPageSchema.parse(await this.request(`/api/inbox?limit=${after || applicationId ? 50 : 250}${after ? `&cursor=${encodeURIComponent(after)}` : ''}${
        applicationId ? `&applicationId=${applicationId}` : ''}`, signal, owner));
      if (next.ownerId !== owner) throw new RequestError(403, 'PRINCIPAL_CHANGED');
      return next;
    };
    const inbox = await page(cursor);
    // Past 250 notifications, a waiting application with none of its questions loaded reads its own, so Answer still works.
    // ponytail: one that has only some of its questions in the newest 250 still shows only those.
    if (!cursor && inbox.nextCursor) {
      const loaded = new Set(inbox.items.flatMap((item) => item.question && isOpenQuestion(item.question) ? [item.applicationId] : []));
      for (const id of this.waiting) {
        for (let next: Page | null = null, more = 0; !loaded.has(id) && (!next || next.nextCursor) && more < 3; more++) {
          next = await page(next?.nextCursor ?? undefined, id);
          inbox.items.push(...next.items);
        }
      }
    }
    let selected = this.view.selected;
    if (selected) {
      selected = QuestionDetailSchema.parse(await this.request(`/api/questions/${selected.id}`, signal, owner));
      if (selected.ownerId !== owner) throw new RequestError(403, 'PRINCIPAL_CHANGED');
    }
    await this.assertOwner(owner, signal);
    const items = cursor ? [...(this.view.inbox?.items ?? []), ...inbox.items] : inbox.items;
    this.update({ inbox: { ...inbox, items: [...new Map(items.map((item) => [item.eventId, item])).values()] }, selected });
  }
  async refresh(cursor?: string) {
    if (this.disposed || this.view.busy) return;
    const signal = this.begin();
    this.update({ loading: true });
    try {
      const account = accountSchema.parse(await this.request('/api/auth/applicant', signal));
      if (this.view.ownerId && this.view.ownerId !== account.ownerId) this.clearOwner();
      this.update({ ownerId: account.ownerId });
      await this.unlockVault(account.ownerId, signal);
      await this.load(account.ownerId, signal, cursor);
      this.update({ locked: false, error: '', failures: 0 });
    } catch (error) {
      if (!signal.aborted) this.fail(error);
    } finally {
      if (this.operation?.signal === signal) {
        this.operation = null;
        this.update({ loading: false });
      }
    }
  }
  suspend() {
    this.operation?.abort();
    this.update({ locked: true, loading: false, busy: false });
  }
  offline() {
    this.operation?.abort();
    this.update({ loading: false, busy: false, error: 'Offline. Latest known counts and unsaved answers are retained.', failures: this.view.failures + 1 });
  }
  readonly api: PrivateApi = async (path, init = {}) => {
    const owner = this.view.ownerId;
    if (!owner || this.view.locked) throw new RequestError(401);
    const signal = init.signal ? AbortSignal.any([this.ownerAbort.signal, init.signal]) : this.ownerAbort.signal;
    try {
      await this.assertOwner(owner, signal);
      const result = await this.request(path, signal, owner, init);
      await this.assertOwner(owner, signal);
      return result;
    } catch (error) {
      if (!signal.aborted) this.fail(error);
      throw error;
    }
  };
  async select(question: QuestionDetail) {
    if (this.view.locked || this.view.busy) return;
    const signal = this.begin();
    this.update({ busy: true, error: '', notice: '' });
    try {
      const selected = QuestionDetailSchema.parse(await this.api(`/api/questions/${question.id}`, { signal }));
      if (selected.ownerId !== this.view.ownerId) throw new RequestError(403, 'PRINCIPAL_CHANGED');
      const drafts = this.view.snapshot.drafts;
      this.update({ selected, snapshot: { ...this.view.snapshot, drafts: {
        ...drafts, [selected.id]: drafts[selected.id] ?? { question: selected, desired: emptyEdit(), dirty: false },
      } } });
    } catch (error) { if (!signal.aborted) this.fail(error); }
    finally { if (!signal.aborted) this.update({ busy: false }); }
  }
  back() { this.update({ selected: null, notice: '' }); }
  /** Any listed question takes an edit; every application's questions are answered together. */
  edit(desired: Edit, question = this.view.selected) {
    if (!question || this.view.locked) return;
    const draft = this.view.snapshot.drafts[question.id];
    this.update({ snapshot: { ...this.view.snapshot, drafts: { ...this.view.snapshot.drafts,
      [question.id]: { question: draft?.question ?? question, desired, dirty: true } } } });
    void this.persist();
  }
  async recover(index: number) {
    const recovery = this.view.recoveries[index];
    if (!recovery || !this.vault || this.view.locked || this.dirty) return;
    this.update({ snapshot: structuredClone(recovery.snapshot), selected: null });
    if (await this.persist()) {
      await this.vault.retire(recovery.slot, recovery.snapshot).catch(() => {});
      this.update({ recoveries: this.view.recoveries.filter((item) => item !== recovery), notice: 'Draft recovered. Review before answering or retrying.' });
    }
  }
  answer(body: AnswerCommand, question = this.view.selected) {
    if (!question) return;
    const draft = this.view.snapshot.drafts[question.id];
    if (!draft || !sameQuestion(question, draft.question)) {
      this.update({ error: 'Question changed. Review the current question before answering.' });
      return;
    }
    return this.execute({ kind: 'answer', questionId: question.id, body: AnswerCommandSchema.parse(body), sent: structuredClone(draft.desired) });
  }
  /** Sends an application's answers in one request: all are saved, or none and the form shows why. */
  async answerAll(answers: { question: QuestionDetail; body: AnswerCommand }[]) {
    const owner = this.view.ownerId;
    if (!owner || this.view.locked || this.view.busy || this.disposed || !answers.length) return;
    if (this.view.snapshot.pending) { this.update({ error: 'Retry the pending answer first.' }); return; }
    const signal = this.begin();
    this.update({ busy: true, error: '', notice: '' });
    try {
      // A request carries at most 128 KB; a form of long essays goes in a few requests, each saved whole.
      const chunks: typeof answers[] = [[]];
      let bytes = 0;
      for (const item of answers) {
        const size = JSON.stringify(item.body).length + 64;
        if (bytes + size > 120_000 && chunks[chunks.length - 1].length) { chunks.push([]); bytes = 0; }
        chunks[chunks.length - 1].push(item);
        bytes += size;
      }
      for (const chunk of chunks) {
        const ack = AnswerBatchResultSchema.parse(await this.api('/api/questions/answers', { signal, method: 'POST',
          body: JSON.stringify({ answers: chunk.map(({ question, body }) => ({ questionId: question.id, command: AnswerCommandSchema.parse(body) })) }) }));
        if (ack.ownerId !== owner || ack.results.length !== chunk.length) throw new RequestError(502);
      }
      const drafts = { ...this.view.snapshot.drafts };
      for (const { question } of answers) if (drafts[question.id]) drafts[question.id] = { ...drafts[question.id], dirty: false };
      this.update({ snapshot: { ...this.view.snapshot, drafts },
        notice: `${answers.length} answer${answers.length === 1 ? '' : 's'} saved. Workie continues this application.` });
      await this.persist();
      await this.load(owner, signal);
    } catch (error) {
      if (signal.aborted) return;
      // this.api reports its own request errors; a bad acknowledgement is reported here.
      if (!(error instanceof RequestError) || error.status === 502) this.fail(error);
      try { await this.load(owner, signal); } catch (next) { if (!signal.aborted) this.fail(next); }
    } finally { if (!signal.aborted) this.update({ busy: false }); }
  }
  focus() {
    const q = this.view.selected;
    if (q) return this.execute({ kind: 'focus', questionId: q.id, body: {
      requestId: crypto.randomUUID(), expectedRevision: q.revision,
    } });
  }
  retry() {
    if (this.view.snapshot.pending) return this.execute(this.view.snapshot.pending);
  }
  private async execute(work: Pending) {
    const owner = this.view.ownerId;
    if (!owner || this.view.locked || this.view.busy || this.disposed ||
        this.view.snapshot.pending && this.view.snapshot.pending !== work) return;
    const signal = this.begin();
    this.update({ busy: true, error: '', notice: '', snapshot: { ...this.view.snapshot, pending: work } });
    await this.persist();
    try {
      signal.throwIfAborted();
      const raw = await this.api(`/api/questions/${work.questionId}/${work.kind}`, {
        signal, method: 'POST', body: JSON.stringify(work.body),
      });
      signal.throwIfAborted();
      let notice = '';
      let drafts = this.view.snapshot.drafts;
      if (work.kind === 'answer') {
        const ack = AnswerResultSchema.parse(raw);
        if (ack.ownerId !== owner || ack.questionId !== work.questionId) throw new RequestError(502);
        const draft = drafts[work.questionId];
        const newer = !!draft && JSON.stringify(draft.desired) !== JSON.stringify(work.sent);
        if (draft) drafts = { ...drafts, [work.questionId]: { ...draft, dirty: newer } };
        notice = `Answer acknowledged. ${ack.resumedApplicationIds.length} applications resumed.${newer ? ' Your newer edit is retained and was not sent.' : ''}`;
      } else {
        const ack = FocusResultSchema.parse(raw);
        if (ack.questionId !== work.questionId) throw new RequestError(502);
        notice = ack.status === 'unavailable' ? 'Paired browser unavailable. This application is still waiting.' :
          'Browser focus request acknowledged. Completion still requires worker observation.';
      }
      this.update({ snapshot: { ...this.view.snapshot, drafts, pending: null }, notice });
      await this.persist();
      await this.load(owner, signal);
    } catch (error) {
      if (signal.aborted) return;
      this.fail(error);
      if (error instanceof RequestError && [400, 404, 409, 422].includes(error.status) && this.view.ownerId === owner) {
        this.update({ snapshot: { ...this.view.snapshot, pending: null } });
        await this.persist();
        try { await this.load(owner, signal); } catch (next) { if (!signal.aborted) this.fail(next); }
      }
    } finally { if (!signal.aborted) this.update({ busy: false }); }
  }
  async markRead(eventId: string) {
    if (this.view.locked || this.view.busy) return;
    const signal = this.begin();
    this.update({ busy: true, error: '' });
    try {
      const ack = z.object({ ownerId: z.string(), eventIds: z.array(z.uuid()) }).parse(await this.api('/api/inbox/read', {
        signal, method: 'POST', body: JSON.stringify({ eventIds: [eventId] }),
      }));
      if (ack.ownerId !== this.view.ownerId || !ack.eventIds.includes(eventId)) throw new RequestError(502);
      await this.load(ack.ownerId, signal);
    } catch (error) { if (!signal.aborted) this.fail(error); }
    finally { if (!signal.aborted) this.update({ busy: false }); }
  }
  dispose() {
    this.disposed = true;
    this.operation?.abort();
    this.ownerAbort.abort();
    const vault = this.vault;
    this.vault = null;
    if (vault) void vault.save(this.view.snapshot).catch(() => {}).finally(() => vault.dispose());
    this.view = initialView();
  }
}
