import 'server-only';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationArtifacts, applicationEvents, applicationLive, applicationReceipts, applications, documents } from '../private-db/schema.ts';
import { artifactRequestId, type ApplicationArtifactManifest } from './artifact-protocol.ts';
import { hashValue } from './stores.ts';
import { appScope, fail, withWorker, type WorkerOptions } from './worker-store.ts';
import { SubmittedLetterSchema, type ReviewedField } from './worker-protocol.ts';

/** What each application sent: its tailored resume (with the lines that changed), its cover letter and, once submitted, its filled answers. */
type Letter = { letter: 'submitted'; introduction: string; body: string[]; conclusion: string; companyParagraph: string };
type Material = { applicationId: string;
  resume: { documentId: string; mime: string; createdAt: number; changes: { before: string; after: string }[] } | null;
  letter: Omit<Letter, 'letter'> | null; answers: ReviewedField[] | null };

/** Worker call when the form is filled (or after a verified receipt): keeps the cover letter, once, in the event log. */
export async function recordSubmittedLetter(db: PrivateDb, token: string, applicationId: string, input: unknown, options: WorkerOptions = {}) {
  const letter = SubmittedLetterSchema.parse(input);
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [app] = await tx.select().from(applications).where(and(appScope(worker.ownerId, applicationId), eq(applications.workerId, worker.id)));
    const [receipt] = await tx.select({ id: applicationReceipts.intentId }).from(applicationReceipts).where(and(
      eq(applicationReceipts.ownerId, worker.ownerId), eq(applicationReceipts.applicationId, applicationId)));
    // Kept when the form is filled, so the applicant reviews the exact letter before approving the submit.
    if (!app || !(app.state === 'filling' || (app.state === 'submitted' && receipt))) fail(409, 'CONFLICT', 'A cover letter is kept only for a filled or submitted application.');
    const entry: Letter = { letter: 'submitted', introduction: letter.introduction, body: letter.body,
      conclusion: letter.conclusion, companyParagraph: letter.companyParagraph };
    await tx.insert(applicationEvents).values({ ownerId: worker.ownerId, applicationId, eventId: artifactRequestId({ letter: applicationId }),
      requestHash: hashValue(entry), acknowledgement: entry, createdAt: now }).onConflictDoNothing();
    return { applicationId, stored: true as const };
  });
}

const Anchors = z.array(z.object({ id: z.string(), text: z.string() })).catch([]);
const Edits = z.array(z.object({ anchorId: z.string(), replacement: z.string() })).catch([]);
function resumeChanges(manifest: ApplicationArtifactManifest) {
  const anchors = Anchors.parse(manifest.template.anchors);
  return Edits.parse(manifest.request.edits).flatMap((edit) => {
    const before = anchors.find((anchor) => anchor.id === edit.anchorId)?.text;
    return before ? [{ before, after: edit.replacement }] : [];
  });
}

export async function listMaterials(db: PrivateDb, ownerId: string) {
  const byApplication = new Map<string, Material>();
  const material = (applicationId: string) => byApplication.get(applicationId) ??
    byApplication.set(applicationId, { applicationId, resume: null, letter: null, answers: null }).get(applicationId)!;
  const artifacts = await db.select({ applicationId: applicationArtifacts.applicationId, documentId: applicationArtifacts.documentId,
    manifest: applicationArtifacts.manifest, createdAt: applicationArtifacts.createdAt, mime: documents.mime })
    .from(applicationArtifacts).innerJoin(documents, and(eq(documents.ownerId, applicationArtifacts.ownerId),
      eq(documents.id, applicationArtifacts.documentId), eq(documents.state, 'available')))
    .where(eq(applicationArtifacts.ownerId, ownerId)).orderBy(desc(applicationArtifacts.createdAt));
  for (const artifact of artifacts) {
    const item = material(artifact.applicationId);
    item.resume ??= { documentId: artifact.documentId, mime: artifact.mime, createdAt: artifact.createdAt, changes: resumeChanges(artifact.manifest) };
  }
  const letters = await db.select().from(applicationEvents).where(and(eq(applicationEvents.ownerId, ownerId),
    sql`json_extract(${applicationEvents.acknowledgement}, '$.letter') = 'submitted'`));
  for (const row of letters) {
    const { introduction, body, conclusion, companyParagraph } = row.acknowledgement as Letter;
    material(row.applicationId).letter = { introduction, body, conclusion, companyParagraph };
  }
  // The Live tab stops sending a form once it is submitted; its last frame still holds what the worker typed.
  const sent = await db.select({ applicationId: applicationLive.applicationId, fields: applicationLive.fields }).from(applicationLive)
    .innerJoin(applications, and(eq(applications.ownerId, applicationLive.ownerId), eq(applications.id, applicationLive.applicationId)))
    .where(and(eq(applicationLive.ownerId, ownerId), eq(applications.state, 'submitted'), isNotNull(applicationLive.fields)));
  for (const row of sent) material(row.applicationId).answers = row.fields;
  return { ownerId, materials: [...byApplication.values()] };
}

/** The letter kept for this application, which the worker reuses at submit. */
export async function savedLetter(db: Pick<PrivateDb, 'select'>, ownerId: string, applicationId: string) {
  const [row] = await db.select().from(applicationEvents).where(and(eq(applicationEvents.ownerId, ownerId),
    eq(applicationEvents.applicationId, applicationId), eq(applicationEvents.eventId, artifactRequestId({ letter: applicationId }))));
  if (!row) return null;
  const { introduction, body, conclusion, companyParagraph } = row.acknowledgement as Letter;
  return { introduction, body, conclusion, companyParagraph };
}
