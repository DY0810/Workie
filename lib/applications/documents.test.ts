import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { migratePrivateDb, openPrivateDb, type PrivateDb } from '../private-db';
import { user } from '../private-db/schema';
import { documents, documentUploadGrants } from '../private-db/document-schema';
import { createDocumentGrant, getDocument, listDocuments, receiveLocalDocument, retryDocumentValidation, cleanupExpiredGrants, downloadDocument } from './documents';
import { documentStorageConfig, readDocumentObject, writeDocumentObject, type DocumentStorage } from './documents-storage';
import { PDFDocument } from 'pdf-lib';

vi.mock('server-only', () => ({}));
let dir: string;
let db: PrivateDb;
let storage: DocumentStorage;
const input = (size = 100) => ({
  requestId: randomUUID(), kind: 'resume_master', name: 'synthetic.pdf', mime: 'application/pdf', size,
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlUfJQAAAAASUVORK5CYII=', 'base64');
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'workie-documents-')));
  db = openPrivateDb({ url: pathToFileURL(join(dir, 'private.db')).href });
  await migratePrivateDb(db);
  for (const id of ['one', 'two']) {
    await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  }
  storage = { mode: 'local', directory: join(dir, 'objects') };
});
afterEach(() => {
  vi.restoreAllMocks();
  db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
describe('owner-scoped immutable document grants', () => {
  it('isolates lists, documents, uploads and parent references for two owners', async () => {
    const grant = await createDocumentGrant(db, 'one', input(), storage);
    expect(await listDocuments(db, 'two')).toEqual([]);
    await expect(getDocument(db, 'two', grant.document.id)).rejects.toMatchObject({ status: 404 });
    await expect(receiveLocalDocument(db, 'two', grant.grantId, new Request('http://localhost', { method: 'PUT', body: 'x' }), storage)).rejects.toMatchObject({ status: 404 });
    await expect(createDocumentGrant(db, 'two', { ...input(), parentId: grant.document.id }, storage)).rejects.toMatchObject({ status: 404 });
  });
  it('reuses matching request IDs but rejects conflicts and expiry', async () => {
    const data = input();
    const first = await createDocumentGrant(db, 'one', data, storage);
    expect(await createDocumentGrant(db, 'one', data, storage)).toEqual(first);
    await expect(createDocumentGrant(db, 'one', { ...data, size: 101 }, storage)).rejects.toMatchObject({ status: 409 });
    await cleanupExpiredGrants(db, 'one', storage, Date.now() + 60 * 60_000);
    await expect(createDocumentGrant(db, 'one', data, storage)).rejects.toMatchObject({ status: 409 });
    expect((await listDocuments(db, 'one'))[0].state).toBe('expired');
  });
  it('reserves pending quota atomically across concurrent uploads', async () => {
    const results = await Promise.allSettled(Array.from({ length: 11 }, () =>
      createDocumentGrant(db, 'one', input(10 * 1024 * 1024), storage)));
    expect(results.filter((r) => r.status === 'fulfilled'), JSON.stringify(results.filter((r) => r.status === 'rejected').map((r) => r.reason.stack))).toHaveLength(10);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 429 } });
    expect((await listDocuments(db, 'one')).reduce((sum, d) => sum + d.size, 0)).toBe(100 * 1024 * 1024);
  });
  it('validates actual local bytes, preserves immutable master versions and private permissions', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    const grant = await createDocumentGrant(db, 'one', input(bytes.length), storage);
    const request = () => new Request('http://localhost', { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes });
    const result = await receiveLocalDocument(db, 'one', grant.grantId, request(), storage);
    expect(result).toMatchObject({ state: 'available', size: bytes.length, safetyCheck: 'passed' });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(join(dir, 'objects')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'objects', grant.pathname.split('/').pop()!)).mode & 0o777).toBe(0o600);
    await expect(receiveLocalDocument(db, 'one', grant.grantId, request(), storage)).rejects.toMatchObject({ status: 409 });
    const child = await createDocumentGrant(db, 'one', { ...input(bytes.length), parentId: result.id }, storage);
    expect(child.document).toMatchObject({ masterId: result.id, version: 2, state: 'pending' });
    expect((await getDocument(db, 'one', result.id)).sha256).toBe(result.sha256);
    await expect(db.update(documents).set({ name: 'overwrite.pdf' }).where(eq(documents.id, result.id))).rejects.toThrow();
    await expect(db.update(documents).set({ sha256: 'a'.repeat(64) }).where(eq(documents.id, result.id))).rejects.toThrow();
    await expect(db.update(documents).set({ state: 'pending' }).where(eq(documents.id, result.id))).rejects.toThrow();
    await expect(downloadDocument(db, 'two', result.id, storage)).rejects.toMatchObject({ status: 404 });
    expect(Buffer.from((await downloadDocument(db, 'one', result.id, storage)).bytes)).toEqual(bytes);
    writeFileSync(join(dir, 'objects', grant.pathname.split('/')[1]), Buffer.alloc(bytes.length, 0));
    await expect(downloadDocument(db, 'one', result.id, storage)).rejects.toMatchObject({ status: 503 });
  });
  it('accepts a portfolio image but rejects it as a resume', async () => {
    const portfolio = await createDocumentGrant(db, 'one', {
      requestId: randomUUID(), kind: 'portfolio', name: 'case-study.png', mime: 'image/png', size: png.length,
    }, storage);
    await expect(receiveLocalDocument(db, 'one', portfolio.grantId, new Request('http://localhost', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png,
    }), storage)).resolves.toMatchObject({ kind: 'portfolio', state: 'available', safetyCheck: 'passed' });
    await expect(createDocumentGrant(db, 'one', {
      requestId: randomUUID(), kind: 'resume_master', name: 'resume.png', mime: 'image/png', size: png.length,
    }, storage)).rejects.toMatchObject({ status: 400 });
  });
  it('keeps quota and idempotency atomic across independent local clients', async () => {
    const peer = openPrivateDb({ url: pathToFileURL(join(dir, 'private.db')).href });
    try {
      const data = input(10 * 1024 * 1024);
      const duplicates = await Promise.all([createDocumentGrant(db, 'one', data, storage), createDocumentGrant(peer, 'one', data, storage)]);
      expect(duplicates[0]).toEqual(duplicates[1]);
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
        createDocumentGrant(i % 2 ? peer : db, 'one', input(10 * 1024 * 1024), storage)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(9);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 429 } });
      expect(await db.all(sql`select count(*) as n from private_document_upload_grant`)).toEqual([{ n: 10 }]);
    } finally { peer.$client.close(); }
  });
  it('enforces document-count quota independently of byte quota', async () => {
    for (let i = 0; i < 99; i++) await createDocumentGrant(db, 'one', input(1), storage);
    const results = await Promise.allSettled([createDocumentGrant(db, 'one', input(1), storage), createDocumentGrant(db, 'one', input(1), storage)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 429 } });
  });
  it('leaves the upload quota free of the resumes the worker stored per application', async () => {
    // 100 of them at 1 MiB reach both the count and the byte limit.
    await db.insert(documents).values(Array.from({ length: 100 }, (_, i) => {
      const id = randomUUID();
      return {
        id, ownerId: 'one', kind: 'resume_artifact' as const, name: `application-${i}.pdf`, masterId: id, version: 1,
        objectKey: `documents/${id}`, storage: 'local' as const, mime: 'application/pdf', size: 1024 * 1024,
        sha256: 'a'.repeat(64), state: 'available' as const, safetyCheck: 'passed' as const, createdAt: Date.now(),
      };
    }));
    await expect(createDocumentGrant(db, 'one', input(1), storage)).resolves.toMatchObject({ document: { kind: 'resume_master' } });
  });
  it('allocates distinct concurrent versions without modifying the master', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    const parent = await createDocumentGrant(db, 'one', input(bytes.length), storage);
    await receiveLocalDocument(db, 'one', parent.grantId, new Request('http://localhost', {
      method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes,
    }), storage);
    const children = await Promise.all(Array.from({ length: 4 }, () =>
      createDocumentGrant(db, 'one', { ...input(), parentId: parent.document.id }, storage)));
    expect(children.map((c) => c.document.version).sort()).toEqual([2, 3, 4, 5]);
    expect((await getDocument(db, 'one', parent.document.id)).version).toBe(1);
  });
  it('retries nested BUSY only and recovers a lost grant response by request ID', async () => {
    const run = db.transaction.bind(db);
    const data = input();
    const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('wrapped', {
      cause: Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }),
    }));
    await createDocumentGrant(db, 'one', data, storage);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockImplementationOnce(async (callback) => {
      await run(callback);
      throw Object.assign(new Error('response lost after commit'), { code: 'NETWORK_ERROR' });
    });
    const lost = input();
    await expect(createDocumentGrant(db, 'one', lost, storage)).rejects.toThrow('response lost');
    expect(spy).toHaveBeenCalledTimes(3);
    const recovered = await createDocumentGrant(db, 'one', lost, storage);
    expect(recovered.document.state).toBe('pending');
    expect(await db.all(sql`select count(*) as n from private_document`)).toEqual([{ n: 2 }]);
  });
  it('proves the installed SDK leaves a BUSY commit open until rollback', async () => {
    const peer = openPrivateDb({ url: pathToFileURL(join(dir, 'private.db')).href });
    const reader = await peer.$client.transaction('read');
    const writer = await db.$client.transaction('write');
    try {
      await reader.execute('select * from private_user');
      await writer.execute("update private_user set name = 'uncommitted' where id = 'one'");
      await expect(writer.commit()).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
      expect(writer.closed).toBe(false);
      await writer.rollback();
      expect(writer.closed).toBe(true);
      await reader.rollback();
      expect((await db.select().from(user).where(eq(user.id, 'one')))[0].name).toBe('one');
    } finally { writer.close(); reader.close(); peer.$client.close(); }
  });
  it('cleans expired bytes before freeing quota and respects active leases and failed deletion', async () => {
    const item = await createDocumentGrant(db, 'one', input(1), storage);
    await writeDocumentObject(storage, item.pathname, new Uint8Array([1]));
    const now = Date.now() + 60 * 60_000;
    await db.update(documents).set({ leaseUntil: now + 1000, leaseId: 'active' }).where(eq(documents.id, item.document.id));
    await cleanupExpiredGrants(db, 'one', storage, now);
    expect((await getDocument(db, 'one', item.document.id)).state).toBe('pending');
    await cleanupExpiredGrants(db, 'two', storage, now + 2000);
    expect((await getDocument(db, 'one', item.document.id)).state).toBe('pending');
    await cleanupExpiredGrants(db, 'one', storage, now + 2000);
    expect((await getDocument(db, 'one', item.document.id)).state).toBe('expired');
    expect(existsSync(join(dir, 'objects', item.pathname.split('/')[1]))).toBe(false);
    const failed = await createDocumentGrant(db, 'one', input(1), storage);
    symlinkSync(join(dir, 'private.db'), join(dir, 'objects', failed.pathname.split('/')[1]));
    await cleanupExpiredGrants(db, 'one', storage, now);
    expect((await getDocument(db, 'one', failed.document.id))).toMatchObject({ state: 'pending', leaseId: null });
    expect(await db.select().from(documentUploadGrants)).toHaveLength(2);
  });
  it('bounds incoming stream bytes and rejects forged MIME', async () => {
    const grant = await createDocumentGrant(db, 'one', input(1), storage);
    await expect(receiveLocalDocument(db, 'one', grant.grantId, new Request('http://localhost', {
      method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: 'too long',
    }), storage)).rejects.toMatchObject({ status: 413 });
    const other = await createDocumentGrant(db, 'one', input(1), storage);
    await expect(receiveLocalDocument(db, 'one', other.grantId, new Request('http://localhost', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: 'x',
    }), storage)).rejects.toMatchObject({ status: 415 });
  });
  it('keeps unsafe local content unavailable, with no usable download', async () => {
    const grant = await createDocumentGrant(db, 'one', input(3), storage);
    const result = await receiveLocalDocument(db, 'one', grant.grantId, new Request('http://localhost', {
      method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: 'bad',
    }), storage);
    expect(result).toMatchObject({ state: 'rejected', safetyCheck: 'rejected', downloadUrl: null });
    await expect(retryDocumentValidation(db, 'two', result.id, storage)).rejects.toMatchObject({ status: 404 });
    expect(await db.all(sql`select count(*) as n from private_document`)).toEqual([{ n: 1 }]);
  });
});
describe('generated-key private file storage', () => {
  it('denies traversal, symlinks, repo paths and overwrites', async () => {
    expect(() => documentStorageConfig({ WORKIE_DOCUMENT_STORAGE: 'local', WORKIE_DOCUMENT_DIRECTORY: process.cwd() })).toThrow();
    for (const key of ['../outside', '/etc/passwd', 'documents/../../x', 'x.pdf']) {
      await expect(writeDocumentObject(storage, key, new Uint8Array([1]))).rejects.toThrow();
    }
    const key = `documents/${randomUUID()}`;
    await writeDocumentObject(storage, key, new Uint8Array([1]));
    await expect(writeDocumentObject(storage, key, new Uint8Array([2]))).rejects.toThrow();
    const linked = `documents/${randomUUID()}`;
    symlinkSync(join(dir, 'private.db'), join(dir, 'objects', linked.split('/')[1]));
    await expect(readDocumentObject(storage, linked)).rejects.toThrow();
  });
});
