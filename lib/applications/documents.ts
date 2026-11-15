import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, lt, or, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PrivateDb } from '../private-db';
import { documents, documentUploadGrants } from '../private-db/document-schema';
import { DOCUMENT_KINDS, DOCUMENT_MIMES, allowedDocumentMimes } from './document-types';
import { validateDocumentBytes } from './documents-validation';
import { transaction } from './stores.ts';
import {
  assertDocumentBlobUrl, boundedDocumentBytes, DocumentError, MAX_DOCUMENT_BYTES,
  readDocumentObject, removeDocumentObject, writeDocumentObject, type DocumentStorage,
} from './documents-storage';

export { DocumentError } from './documents-storage';
const uploadInput = z.strictObject({
  requestId: z.uuid(),
  kind: z.enum(DOCUMENT_KINDS).exclude(['resume_artifact']),
  name: z.string().trim().min(1).max(180).refine((s) => !/[\/\\\x00-\x1f\x7f]/.test(s)),
  mime: z.enum(DOCUMENT_MIMES),
  size: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  role: z.string().trim().min(1).max(100).optional(),
  parentId: z.uuid().optional(),
}).superRefine((value, context) => {
  if (!allowedDocumentMimes(value.kind).includes(value.mime)) {
    context.addIssue({ code: 'custom', path: ['mime'], message: 'Document type is not allowed for this kind.' });
  }
  const validFilename = value.mime === 'application/pdf' ? /\.pdf$/i.test(value.name) :
    value.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? /\.docx$/i.test(value.name) :
      value.mime === 'image/png' ? /\.png$/i.test(value.name) : /\.jpe?g$/i.test(value.name);
  if (!validFilename) {
    context.addIssue({ code: 'custom', path: ['name'], message: 'Filename does not match document type.' });
  }
});
type DocumentRow = typeof documents.$inferSelect;
export type DocumentSummary = Pick<DocumentRow, 'id' | 'kind' | 'name' | 'role' | 'parentId' | 'masterId' |
  'version' | 'mime' | 'size' | 'sha256' | 'state' | 'safetyCheck'> & { createdAt: string; downloadUrl: string | null };
export function documentSummary(row: DocumentRow): DocumentSummary {
  const { id, kind, name, role, parentId, masterId, version, mime, size, sha256, state, safetyCheck } = row;
  return { id, kind, name, role, parentId, masterId, version, mime, size, sha256, state, safetyCheck,
    createdAt: new Date(row.createdAt).toISOString(), downloadUrl: state === 'available' ? `/api/documents/${id}/download` : null };
}
const owned = (ownerId: string, id: string) => and(eq(documents.ownerId, ownerId), eq(documents.id, id));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const leaseFree = (now: number) => or(isNull(documents.leaseUntil), lt(documents.leaseUntil, now));
export async function getDocument(db: PrivateDb, ownerId: string, id: string): Promise<DocumentRow> {
  const [row] = await db.select().from(documents).where(owned(ownerId, id));
  if (!row) throw new DocumentError(404, 'Document not found.');
  return row;
}
export async function listDocuments(db: PrivateDb, ownerId: string): Promise<DocumentSummary[]> {
  return (await db.select().from(documents).where(eq(documents.ownerId, ownerId))
    .orderBy(desc(documents.createdAt)).limit(100)).map(documentSummary);
}
async function grantForOwner(db: PrivateDb, ownerId: string, grantId: string) {
  const [grant] = await db.select().from(documentUploadGrants)
    .where(and(eq(documentUploadGrants.ownerId, ownerId), eq(documentUploadGrants.id, grantId)));
  if (!grant) throw new DocumentError(404, 'Upload grant not found.');
  return { grant, document: await getDocument(db, ownerId, grant.documentId) };
}
function grantResponse(row: DocumentRow, grantId: string) {
  return {
    document: documentSummary(row), grantId, pathname: row.objectKey, uploadMode: row.storage,
    uploadUrl: row.storage === 'local' ? `/api/documents/uploads/${grantId}` : '/api/documents/upload',
  };
}
export async function createDocumentGrant(db: PrivateDb, ownerId: string, raw: unknown, storage: DocumentStorage) {
  if (storage.mode === 'unconfigured') throw new DocumentError(503, 'Configure private document storage first.');
  const parsed = uploadInput.safeParse(raw);
  if (!parsed.success) throw new DocumentError(400, 'Invalid document upload request.');
  const input = parsed.data;
  const inputHash = digest(input);
  await cleanupExpiredGrants(db, ownerId, storage);
  // libSQL write transactions reserve quota/version and create the grant atomically.
  // Local SQLite can report BUSY rather than wait; bounded retries also cover peers.
  return transaction(db, async (tx) => {
    const [existing] = await tx.select().from(documentUploadGrants).where(and(
      eq(documentUploadGrants.ownerId, ownerId), eq(documentUploadGrants.requestId, input.requestId),
    ));
    if (existing) {
      const [row] = await tx.select().from(documents).where(owned(ownerId, existing.documentId));
      if (!row || existing.inputHash !== inputHash || row.storage !== storage.mode ||
        row.state !== 'pending' || existing.expiresAt <= Date.now()) {
        throw new DocumentError(409, 'Upload request already used or expired.');
      }
      return grantResponse(row, existing.id);
    }
    let parent: DocumentRow | undefined;
    if (input.parentId) {
      [parent] = await tx.select().from(documents).where(owned(ownerId, input.parentId));
      if (!parent) throw new DocumentError(404, 'Parent document not found.');
      if (parent.state !== 'available' || parent.kind !== input.kind) {
        throw new DocumentError(409, 'Parent must be an available document of the same kind.');
      }
    }
    const [usage] = await tx.select({
      bytes: sql<number>`coalesce(sum(${documents.size}), 0)`, count: sql<number>`count(*)`,
    // The resumes the worker stores per application are not uploads: counted, they filled the quota and nothing removes them.
    }).from(documents).where(and(eq(documents.ownerId, ownerId), sql`${documents.state} != 'expired'`,
      sql`${documents.kind} != 'resume_artifact'`));
    if (usage.bytes + input.size > 100 * 1024 * 1024 || usage.count >= 100) {
      throw new DocumentError(429, 'Private document quota exceeded.');
    }
    const id = randomUUID(), grantId = randomUUID(), now = Date.now();
    let version = 1;
    if (parent) {
      const [latest] = await tx.select({ version: sql<number>`max(${documents.version})` }).from(documents)
        .where(and(eq(documents.ownerId, ownerId), eq(documents.masterId, parent.masterId)));
      version = latest.version + 1;
    }
    const [row] = await tx.insert(documents).values({
      id, ownerId, kind: input.kind, name: input.name, role: input.role ?? null,
      parentId: parent?.id ?? null, masterId: parent?.masterId ?? id, version,
      objectKey: `documents/${randomUUID()}`, storage: storage.mode as 'local' | 'blob',
      mime: input.mime, size: input.size, createdAt: now,
    }).returning();
    await tx.insert(documentUploadGrants).values({
      id: grantId, ownerId, documentId: id, requestId: input.requestId, inputHash,
      expiresAt: now + 15 * 60_000, createdAt: now,
    });
    return grantResponse(row, grantId);
  }, 12, (attempt) => Math.min(10 * (attempt + 1), 100));
}
export async function cleanupExpiredGrants(db: PrivateDb, ownerId: string, storage: DocumentStorage, now = Date.now()) {
  const stale = await db.select({ document: documents }).from(documentUploadGrants)
    .innerJoin(documents, and(eq(documents.id, documentUploadGrants.documentId), eq(documents.ownerId, documentUploadGrants.ownerId)))
    .where(and(eq(documents.ownerId, ownerId), eq(documents.storage, storage.mode as 'local' | 'blob'),
      eq(documents.state, 'pending'), lt(documentUploadGrants.expiresAt, now - 60_000), leaseFree(now)))
    .limit(8);
  for (const { document } of stale) {
    const leaseId = randomUUID();
    const claimed = await db.update(documents).set({ leaseId, leaseUntil: now + 30_000 })
      .where(and(owned(ownerId, document.id), eq(documents.state, 'pending'), leaseFree(now))).returning({ id: documents.id });
    if (!claimed.length) continue;
    try {
      // Bytes are deleted before releasing reserved quota. Failed deletion retains it.
      await removeDocumentObject(storage, document.objectKey);
      await db.update(documents).set({ state: 'expired', leaseId: null, leaseUntil: null })
        .where(and(owned(ownerId, document.id), eq(documents.leaseId, leaseId)));
    } catch {
      await db.update(documents).set({ leaseId: null, leaseUntil: null })
        .where(and(owned(ownerId, document.id), eq(documents.leaseId, leaseId)));
    }
  }
}
export async function receiveLocalDocument(db: PrivateDb, ownerId: string, grantId: string, request: Request, storage: DocumentStorage) {
  const { grant, document } = await grantForOwner(db, ownerId, grantId);
  if (document.storage !== 'local' || storage.mode !== 'local') throw new DocumentError(409, 'Upload requires private Blob.');
  if (grant.expiresAt <= Date.now() || document.state !== 'pending') throw new DocumentError(409, 'Upload grant expired or already used.');
  if (request.headers.get('content-type')?.split(';')[0] !== document.mime) throw new DocumentError(415, 'Document type does not match its grant.');
  const leaseId = randomUUID();
  const claimed = await db.update(documents).set({ leaseId, leaseUntil: Date.now() + 30_000 })
    .where(and(owned(ownerId, document.id), eq(documents.state, 'pending'), leaseFree(Date.now()))).returning();
  if (!claimed.length) throw new DocumentError(409, 'Upload is already in progress.');
  try {
    const bytes = await boundedDocumentBytes(request.body, document.size);
    if (bytes.length !== document.size) throw inexactSize();
    await writeDocumentObject(storage, document.objectKey, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const updated = await db.update(documents).set({
      state: 'quarantined', sha256, leaseId: null, leaseUntil: null,
    }).where(and(owned(ownerId, document.id), eq(documents.leaseId, leaseId))).returning();
    if (!updated.length) throw new DocumentError(409, 'Upload lease changed.');
    return retryDocumentValidation(db, ownerId, document.id, storage);
  } catch (error) {
    await db.update(documents).set({ leaseId: null, leaseUntil: null })
      .where(and(owned(ownerId, document.id), eq(documents.leaseId, leaseId)));
    throw error;
  }
}
const inexactSize = () => new DocumentError(413, 'Document byte count does not match its grant.');
export async function authorizeBlobGrant(db: PrivateDb, ownerId: string, grantId: string, pathname: string) {
  const { grant, document } = await grantForOwner(db, ownerId, grantId);
  if (grant.expiresAt <= Date.now() || document.state !== 'pending' || document.storage !== 'blob' ||
    pathname !== document.objectKey) throw new DocumentError(409, 'Upload grant does not match.');
  await db.update(documentUploadGrants).set({ tokenIssued: true }).where(and(
    eq(documentUploadGrants.id, grant.id), eq(documentUploadGrants.ownerId, ownerId),
  ));
  return { document, grant };
}
export async function completeBlobDocument(db: PrivateDb, grantId: string, blob: {
  url: string; pathname: string; contentType: string;
}, storage: DocumentStorage) {
  // Only the SDK-verified callback may call this entrypoint. Client payload is not used.
  const [grant] = await db.select().from(documentUploadGrants).where(eq(documentUploadGrants.id, grantId));
  if (!grant || !grant.tokenIssued) throw new DocumentError(404, 'Upload grant not found.');
  const document = await getDocument(db, grant.ownerId, grant.documentId);
  if (document.storage !== 'blob' || blob.pathname !== document.objectKey || blob.contentType !== document.mime) {
    throw new DocumentError(409, 'Upload object does not match its grant.');
  }
  assertDocumentBlobUrl(storage, document.objectKey, blob.url);
  const callbackHash = digest({ url: blob.url, pathname: blob.pathname, contentType: blob.contentType });
  if (document.callbackHash && document.callbackHash !== callbackHash) throw new DocumentError(409, 'Conflicting upload callback.');
  if (document.state === 'available' || document.state === 'rejected') return documentSummary(document);
  if (document.state === 'expired' || (document.state === 'pending' && grant.expiresAt <= Date.now())) {
    throw new DocumentError(409, 'Upload grant expired.');
  }
  await db.update(documents).set({ state: 'quarantined', callbackHash })
    .where(and(owned(grant.ownerId, document.id), eq(documents.state, 'pending'), leaseFree(Date.now())));
  return retryDocumentValidation(db, grant.ownerId, document.id, storage);
}
export async function retryDocumentValidation(db: PrivateDb, ownerId: string, id: string, storage: DocumentStorage): Promise<DocumentSummary> {
  const document = await getDocument(db, ownerId, id);
  if (storage.mode !== document.storage) throw new DocumentError(503, 'Document storage configuration changed.');
  if (document.state === 'available' || document.state === 'rejected') return documentSummary(document);
  if (document.state !== 'quarantined') throw new DocumentError(409, 'Document has not finished uploading.');
  const leaseId = randomUUID();
  const claimed = await db.update(documents).set({
    leaseId, leaseUntil: Date.now() + 30_000, attempts: sql`${documents.attempts} + 1`,
  }).where(and(owned(ownerId, id), eq(documents.state, 'quarantined'), leaseFree(Date.now()))).returning();
  if (!claimed.length) return documentSummary(await getDocument(db, ownerId, id));
  try {
    const bytes = await readDocumentObject(storage, document.objectKey);
    if (bytes.length !== document.size) throw inexactSize();
    const validation = await validateDocumentBytes(bytes, document.mime);
    if (document.sha256 && document.sha256 !== validation.sha256) throw new DocumentError(422, 'Document bytes changed.');
    const state = validation.status === 'passed' ? 'available' : validation.status === 'rejected' ? 'rejected' : 'quarantined';
    await db.update(documents).set({
      sha256: validation.sha256, state, safetyCheck: validation.status, leaseId: null, leaseUntil: null,
    }).where(and(owned(ownerId, id), eq(documents.state, 'quarantined'), eq(documents.leaseId, leaseId)));
  } catch (error) {
    const rejected = error instanceof DocumentError && [413, 422].includes(error.status);
    await db.update(documents).set({
      state: rejected ? 'rejected' : 'quarantined', safetyCheck: rejected ? 'rejected' : 'deferred',
      leaseId: null, leaseUntil: null,
    }).where(and(owned(ownerId, id), eq(documents.state, 'quarantined'), eq(documents.leaseId, leaseId)));
  }
  return documentSummary(await getDocument(db, ownerId, id));
}
export async function downloadDocument(db: PrivateDb, ownerId: string, id: string, storage: DocumentStorage) {
  const document = await getDocument(db, ownerId, id);
  if (document.state !== 'available' || document.safetyCheck !== 'passed') throw new DocumentError(409, 'Document is not available.');
  if (document.storage !== storage.mode) throw new DocumentError(503, 'Document storage configuration changed.');
  const bytes = await readDocumentObject(storage, document.objectKey);
  if (bytes.length !== document.size || createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
    throw new DocumentError(503, 'Document integrity check failed.');
  }
  return { document, bytes };
}
