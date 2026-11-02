import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { policyVersions, user } from './schema.ts';
import { APPLICATION_STATES } from '../applications/state.ts';
import type { Checkpoint, ReviewedField } from '../applications/worker-protocol.ts';

export const workerPairings = sqliteTable('private_worker_pairing', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  grantHash: text('grant_hash').notNull().unique(),
  credentialBinding: text('credential_binding').notNull(),
  label: text('label').notNull(),
  requestId: text('request_id').notNull(),
  revision: integer('revision').notNull().default(1),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
  revokedAt: integer('revoked_at'),
}, (t) => [
  uniqueIndex('private_pairing_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_pairing_request').on(t.ownerId, t.requestId),
  check('private_pairing_revision', sql`${t.revision} > 0`),
]);
export const workers = sqliteTable('private_worker', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  pairingId: text('pairing_id').notNull().unique(),
  tokenHash: text('token_hash').notNull().unique(),
  credentialBinding: text('credential_binding').notNull(),
  registrationId: text('registration_id').notNull(),
  registrationHash: text('registration_hash').notNull(),
  label: text('label').notNull(),
  protocolVersion: integer('protocol_version').notNull(),
  workerVersion: text('worker_version').notNull(),
  capabilities: text('capabilities', { mode: 'json' }).$type<['control-v1']>().notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  revokedAt: integer('revoked_at'),
  // Daily auto-apply start: minutes after local midnight in `timeZone` (IANA). Both null when unscheduled.
  dailyStartMinute: integer('daily_start_minute'),
  timeZone: text('time_zone'),
  // When the schedule was last saved or cleared: a start that passed before then does not fire.
  dailyStartUpdatedAt: integer('daily_start_updated_at'),
}, (t) => [
  uniqueIndex('private_worker_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_worker_registration').on(t.ownerId, t.registrationId),
  foreignKey({ columns: [t.ownerId, t.pairingId], foreignColumns: [workerPairings.ownerId, workerPairings.id] }),
  check('private_worker_protocol', sql`${t.protocolVersion} = 1 and json_valid(${t.capabilities}) and ${t.capabilities} = '["control-v1"]'`),
  check('private_worker_revision', sql`${t.revision} > 0`),
  check('private_worker_hashes', sql`length(${t.tokenHash}) = 64 and length(${t.credentialBinding}) = 64`),
]);
export const applicationRuns = sqliteTable('private_application_run', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  workerId: text('worker_id').notNull(),
  revision: integer('revision').notNull().default(1),
  state: text('state', { enum: ['running', 'paused', 'stopped'] }).notNull().default('running'),
  policyRevision: integer('policy_revision').notNull(),
  policyVersion: integer('policy_version').notNull(),
  policyHash: text('policy_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  discoveryState: text('discovery_state', { enum: ['idle', 'capturing', 'staging', 'ready', 'failed', 'abandoned'] }).notNull().default('idle'),
  captureToken: text('capture_token'),
  captureUntil: integer('capture_until'),
  currentManifestId: text('current_manifest_id'),
  lastAttemptAt: integer('last_attempt_at'),
  lastScanAt: integer('last_scan_at'),
  discoveryError: text('discovery_error'),
}, (t) => [
  uniqueIndex('private_run_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_run_assignment').on(t.ownerId, t.id, t.workerId),
  foreignKey({ columns: [t.ownerId, t.workerId], foreignColumns: [workers.ownerId, workers.id] }),
  foreignKey({ columns: [t.ownerId, t.policyVersion], foreignColumns: [policyVersions.ownerId, policyVersions.version] }),
  check('private_run_state', sql`${t.state} in ('running','paused','stopped') and ${t.revision} > 0 and ${t.policyRevision} > 0`),
  check('private_run_discovery_state', sql`${t.discoveryState} in ('idle','capturing','staging','ready','failed','abandoned')`),
]);
export const applications = sqliteTable('private_application', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  runId: text('run_id').notNull(),
  workerId: text('worker_id').notNull(),
  ats: text('ats').notNull(),
  tenant: text('tenant').notNull(),
  requisition: text('requisition').notNull(),
  attempt: integer('attempt').notNull().default(1),
  previousApplicationId: text('previous_application_id'),
  snapshotManifestId: text('snapshot_manifest_id'),
  snapshotTargetKey: text('snapshot_target_key'),
  snapshotHash: text('snapshot_hash'),
  employerKey: text('employer_key'),
  startedAt: integer('started_at'),
  state: text('state', { enum: APPLICATION_STATES }).notNull().default('queued'),
  revision: integer('revision').notNull().default(1),
  fence: integer('fence').notNull().default(0),
  leaseUntil: integer('lease_until'),
  leaseCheckedAt: integer('lease_checked_at'),
  checkpoint: text('checkpoint', { mode: 'json' }).$type<Checkpoint>(),
  reasonCode: text('reason_code'),
  retries: integer('retries').notNull().default(0),
  availableAt: integer('available_at').notNull(),
  createdAt: integer('created_at').notNull(),
  // Rows are append-only (no-delete trigger), so "delete" in Applications only hides one.
  hiddenAt: integer('hidden_at'),
}, (t) => [
  uniqueIndex('private_application_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_application_identity').on(t.ownerId, t.ats, t.tenant, t.requisition, t.attempt),
  uniqueIndex('private_application_one_successor').on(t.ownerId, t.previousApplicationId),
  uniqueIndex('private_application_active_tenant').on(t.ownerId, t.ats, t.tenant).where(sql`${t.leaseUntil} is not null`),
  index('private_application_queue').on(t.ownerId, t.workerId, t.availableAt),
  foreignKey({ columns: [t.ownerId, t.runId, t.workerId], foreignColumns: [applicationRuns.ownerId, applicationRuns.id, applicationRuns.workerId] }),
  check('private_application_state', sql.raw(`state in (${APPLICATION_STATES.map((s) => `'${s}'`).join(',')})`)),
  check('private_application_counters', sql`${t.revision} > 0 and ${t.fence} >= 0 and ${t.retries} between 0 and 3`),
  check('private_application_lease', sql`(${t.leaseUntil} is null and ${t.leaseCheckedAt} is null) or (${t.leaseUntil} is not null and ${t.leaseCheckedAt} is not null and ${t.fence} > 0 and ${t.leaseUntil} > ${t.leaseCheckedAt} and ${t.state} in ('screening','tailoring','filling','ready','submitting','submission_unknown'))`),
  check('private_application_checkpoint', sql`${t.checkpoint} is null or (json_valid(${t.checkpoint}) and length(${t.checkpoint}) <= 1024)`),
  check('private_application_attempt', sql`typeof(${t.attempt}) = 'integer' and ${t.attempt} > 0 and ((${t.attempt} = 1 and ${t.previousApplicationId} is null) or (${t.attempt} > 1 and ${t.previousApplicationId} is not null))`),
  check('private_application_snapshot', sql`(${t.snapshotManifestId} is null and ${t.snapshotTargetKey} is null and ${t.snapshotHash} is null) or (${t.snapshotManifestId} is not null and ${t.snapshotTargetKey} is not null and ${t.snapshotHash} is not null and length(${t.snapshotHash}) = 64)`),
]);
export const applicationEvents = sqliteTable('private_application_event', {
  ownerId: text('owner_id').notNull(),
  applicationId: text('application_id').notNull(),
  eventId: text('event_id').notNull(),
  requestHash: text('request_hash').notNull(),
  acknowledgement: text('acknowledgement', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.applicationId, t.eventId] }),
  foreignKey({ columns: [t.ownerId, t.applicationId], foreignColumns: [applications.ownerId, applications.id] }),
  check('private_application_event_json', sql`json_valid(${t.acknowledgement})`),
]);
export const workerCommands = sqliteTable('private_worker_command', {
  ownerId: text('owner_id').notNull().references(() => user.id),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  acknowledgement: text('acknowledgement', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.requestId] }),
  check('private_worker_command_json', sql`json_valid(${t.acknowledgement})`),
]);

/** What the worker's browser shows right now for one application, and what it filled: one row, overwritten. Not history. */
export const applicationLive = sqliteTable('private_application_live', {
  ownerId: text('owner_id').notNull(),
  applicationId: text('application_id').notNull(),
  step: text('step').notNull(),
  // A JPEG screenshot, base64; dropped when the worker leaves the application.
  image: text('image'),
  fields: text('fields', { mode: 'json' }).$type<ReviewedField[]>(),
  // An emailed security code the applicant entered on Workie; the worker takes it once and types it into the form.
  verificationCode: text('verification_code'),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.applicationId] }),
  check('private_application_live_fields_json', sql`${t.fields} is null or json_valid(${t.fields})`),
]);
