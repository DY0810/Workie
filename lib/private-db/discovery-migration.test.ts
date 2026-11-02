import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratePrivateDb, openPrivateDb, type PrivateDb } from './index.ts';

vi.mock('server-only', () => ({}));
let db: PrivateDb, dir: string;
afterEach(() => { db?.$client.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it('migrates private storage twice while retaining prior assignment and terminal guards', async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase4-migration-'));
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await migratePrivateDb(db);
  await migratePrivateDb(db);
  const triggers = await db.all<{ name: string }>(sql`select name from sqlite_master where type = 'trigger'`);
  for (const name of [
    'private_application_identity_immutable', 'private_application_run_assignment_immutable',
    'private_application_no_unsafe_requeue', 'private_application_event_no_update',
    'private_application_event_no_delete', 'private_worker_command_no_update',
    'private_submission_identity_immutable', 'private_submission_no_delete',
    'private_receipt_no_update', 'private_receipt_no_delete', 'private_document_immutable_metadata',
    'private_application_artifact_no_update', 'private_application_artifact_no_delete',
  ]) expect(triggers.map((row) => row.name)).toContain(name);
  expect(await db.all(sql`pragma foreign_key_check`)).toEqual([]);
  expect(await db.all(sql`select * from __drizzle_migrations`)).toHaveLength(17);
  await db.run(sql`insert into private_user (id,name,email,email_verified,created_at,updated_at)
    values ('alice','Synthetic','alice@example.test',1,1,1)`);
  await db.run(sql`insert into private_policy_version (owner_id,version,hash,policy,created_at)
    values ('alice',1,${'a'.repeat(64)},'{}',1)`);
  await db.run(sql`insert into private_worker_pairing (id,owner_id,grant_hash,credential_binding,label,request_id,expires_at)
    values ('pair','alice','grant',${'b'.repeat(64)},'fixture','request',10000)`);
  await db.run(sql`insert into private_worker (id,owner_id,pairing_id,token_hash,credential_binding,registration_id,registration_hash,
    label,protocol_version,worker_version,capabilities,created_at)
    values ('worker','alice','pair',${'c'.repeat(64)},${'b'.repeat(64)},'reg','hash','fixture',1,'0.1','["control-v1"]',1)`);
  await db.run(sql`insert into private_application_run (id,owner_id,worker_id,policy_revision,policy_version,policy_hash,created_at)
    values ('run','alice','worker',1,1,${'a'.repeat(64)},1)`);
  // A run's policy moves only forward, to a newer revision; its worker never changes.
  await db.run(sql`update private_application_run set policy_revision = 3 where id = 'run'`);
  for (const change of [sql`policy_revision = 2`, sql`policy_hash = ${'f'.repeat(64)}`, sql`worker_id = 'other'`]) {
    await expect(db.run(sql`update private_application_run set ${change} where id = 'run'`)).rejects.toThrow();
  }
  await db.run(sql`insert into private_application (id,owner_id,run_id,worker_id,ats,tenant,requisition,state,available_at,created_at)
    values ('app','alice','run','worker','greenhouse','fixture','123','submission_unknown',1,1)`);
  // An unknown submission leaves only as submitted, or as failed on the applicant's confirmation that it never arrived.
  for (const [state, reason] of [['queued', 'applicant_confirmed_not_submitted'], ['filling', null], ['failed', null], ['failed', 'retry-safe'], ['cancelled', 'cancel']]) {
    await expect(db.run(sql`update private_application set state = ${state}, reason_code = ${reason} where id = 'app'`)).rejects.toThrow();
  }
  await db.run(sql`update private_application set state = 'failed', reason_code = 'applicant_confirmed_not_submitted' where id = 'app'`);
  await expect(db.run(sql`update private_application set state = 'queued' where id = 'app'`)).rejects.toThrow();
});

it('upgrades populated Phase 3 tables without changing identities, events, leases or run state', async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase4-upgrade-'));
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  for (const file of ['0000_private_auth.sql', '0001_profile_policy_documents.sql', '0002_worker_control.sql']) {
    const text = readFileSync(new URL(`../../drizzle-private/${file}`, import.meta.url), 'utf8');
    for (const statement of text.split('--> statement-breakpoint').filter((s) => s.trim())) await db.run(sql.raw(statement));
  }
  await db.run(sql`insert into private_user (id,name,email,email_verified,created_at,updated_at)
    values ('alice','Synthetic','alice@example.test',1,1,1)`);
  await db.run(sql`insert into private_policy_version (owner_id,version,hash,policy,created_at)
    values ('alice',1,${'a'.repeat(64)},'{}',1)`);
  await db.run(sql`insert into private_worker_pairing (id,owner_id,grant_hash,credential_binding,label,request_id,expires_at)
    values ('pair','alice','grant',${'b'.repeat(64)},'fixture','request',10000)`);
  await db.run(sql`insert into private_worker (id,owner_id,pairing_id,token_hash,credential_binding,registration_id,registration_hash,
    label,protocol_version,worker_version,capabilities,created_at)
    values ('worker','alice','pair',${'c'.repeat(64)},${'b'.repeat(64)},'reg','hash','fixture',1,'0.1','["control-v1"]',1)`);
  await db.run(sql`insert into private_application_run (id,owner_id,worker_id,policy_revision,policy_version,policy_hash,created_at)
    values ('run','alice','worker',1,1,${'a'.repeat(64)},1)`);
  await db.run(sql`insert into private_application (id,owner_id,run_id,worker_id,ats,tenant,requisition,state,available_at,created_at)
    values ('app','alice','run','worker','greenhouse','fixture','123','submitted',1,1)`);
  await db.run(sql`insert into private_application_event (owner_id,application_id,event_id,request_hash,acknowledgement,created_at)
    values ('alice','app','event','hash','{}',2)`);
  const oldApp = (await db.all<Record<string, unknown>>(sql`select * from private_application`))[0];
  const migration = readFileSync(new URL('../../drizzle-private/0003_public_taskmaster.sql', import.meta.url), 'utf8');
  // Use the same atomic driver boundary as the real libSQL migrator, including FK enforcement.
  await db.$client.migrate(migration.split('--> statement-breakpoint').filter((s) => s.trim()));
  expect((await db.all(sql`select * from private_application`))[0]).toMatchObject({ ...oldApp, attempt: 1, previous_application_id: null });
  expect(await db.all(sql`select * from private_application_event`)).toHaveLength(1);
  await expect(db.run(sql`update private_application set state = 'queued' where id = 'app'`)).rejects.toThrow();
  await expect(db.run(sql`update private_application set requisition = 'other' where id = 'app'`)).rejects.toThrow();
  await expect(db.run(sql`update private_application_run set policy_revision = 2 where id = 'run'`)).rejects.toThrow();
  await db.run(sql`insert into private_discovery_manifest
    (id,owner_id,run_id,policy_revision,artifact,hash,captured_at,candidate_count)
    values ('manifest','alice','run',1,'{"candidates":[]}',${'d'.repeat(64)},1,0)`);
  await expect(db.run(sql`update private_discovery_manifest set artifact = '{"candidates":[1]}'`)).rejects.toThrow();
  await expect(db.run(sql`delete from private_discovery_manifest`)).rejects.toThrow();
  await db.run(sql`update private_discovery_manifest set state = 'ready'`);
  await expect(db.run(sql`update private_discovery_manifest set state = 'staging'`)).rejects.toThrow();
  await expect(db.run(sql`update private_application set attempt = 2, previous_application_id = 'missing'`)).rejects.toThrow();
  await expect(db.run(sql`insert into private_application
    (id,owner_id,run_id,worker_id,ats,tenant,requisition,attempt,previous_application_id,available_at,created_at)
    values ('forged','alice','run','worker','greenhouse','other','123',2,'app',3,3)`)).rejects.toThrow();
  await expect(db.run(sql`insert into private_application
    (id,owner_id,run_id,worker_id,ats,tenant,requisition,snapshot_manifest_id,snapshot_target_key,snapshot_hash,available_at,created_at)
    values ('forged','alice','run','worker','greenhouse','other','123','manifest','missing',null,3,3)`)).rejects.toThrow();
  await db.run(sql`insert into private_legacy_import_preview
    (id,owner_id,request_id,request_hash,preview,created_at,expires_at)
    values ('preview','alice','request',${'e'.repeat(64)},'{}',1,10)`);
  await expect(db.run(sql`update private_legacy_import_preview set preview = '{"changed":true}'`)).rejects.toThrow();
  await expect(db.run(sql`delete from private_legacy_import_preview`)).rejects.toThrow();
  await db.run(sql`insert into private_manual_application_mark
    (id,owner_id,preview_id,posting_id,evidence,created_at) values ('mark','alice','preview',9,'{}',2)`);
  await expect(db.run(sql`update private_manual_application_mark set posting_id = 10`)).rejects.toThrow();
  await expect(db.run(sql`delete from private_manual_application_mark`)).rejects.toThrow();
  expect(await db.all(sql`pragma foreign_key_check`)).toEqual([]);
});
