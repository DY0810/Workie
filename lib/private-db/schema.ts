import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Adapted from Better Auth v1.7.5's generated SQLite snapshot (core fields only). Better Auth is gone:
// household PIN auth uses only user and rateLimit; session/account/verification stay until a migration drops them.
// Runtime date defaults avoid a server SQLite-version dependency.
// Logical field names stay intact; only physical table/column names are private.
export const user = sqliteTable('private_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [check('private_user_email_verified_check', sql`${table.emailVerified} in (0, 1)`)]);

export const session = sqliteTable('private_session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$onUpdate(() => new Date()),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, (table) => [index('private_session_user_id_idx').on(table.userId)]);

export const account = sqliteTable('private_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$onUpdate(() => new Date()),
}, (table) => [index('private_account_user_id_idx').on(table.userId)]);

export const verification = sqliteTable('private_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [index('private_verification_identifier_idx').on(table.identifier)]);

export const rateLimit = sqliteTable('private_rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  check('private_rate_limit_count_check', sql`typeof(${table.count}) = 'integer' and ${table.count} >= 0`),
  check('private_rate_limit_last_request_check', sql`typeof(${table.lastRequest}) = 'integer' and ${table.lastRequest} >= 0`),
]);

export const profileVersions = sqliteTable('private_profile_version', {
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull(),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  profile: text('profile', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.revision] }),
  uniqueIndex('private_profile_request_unique').on(t.ownerId, t.requestId),
  check('private_profile_revision_check', sql`typeof(${t.revision}) = 'integer' and ${t.revision} > 0`),
  check('private_profile_json_check', sql`json_valid(${t.profile}) and length(cast(${t.profile} as blob)) <= 131072`),
]);
export const profileHeads = sqliteTable('private_profile_head', {
  ownerId: text('owner_id').primaryKey().references(() => user.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull(),
}, (t) => [
  foreignKey({ columns: [t.ownerId, t.revision], foreignColumns: [profileVersions.ownerId, profileVersions.revision] }),
]);
export const policyVersions = sqliteTable('private_policy_version', {
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  version: integer('version').notNull(),
  hash: text('hash').notNull(),
  policy: text('policy', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.version] }),
  check('private_policy_version_check', sql`typeof(${t.version}) = 'integer' and ${t.version} > 0`),
  check('private_policy_json_check', sql`json_valid(${t.policy}) and length(cast(${t.policy} as blob)) <= 131072`),
]);
export const policyHeads = sqliteTable('private_policy_head', {
  ownerId: text('owner_id').primaryKey().references(() => user.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull(),
  policyVersion: integer('policy_version').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  acceptedPolicyVersion: integer('accepted_policy_version'),
  acceptedPolicyHash: text('accepted_policy_hash'),
  acceptedAt: integer('accepted_at'),
}, (t) => [
  foreignKey({ columns: [t.ownerId, t.policyVersion], foreignColumns: [policyVersions.ownerId, policyVersions.version] }),
  foreignKey({ columns: [t.ownerId, t.acceptedPolicyVersion], foreignColumns: [policyVersions.ownerId, policyVersions.version] }),
  check('private_policy_head_revision_check', sql`typeof(${t.revision}) = 'integer' and ${t.revision} > 0`),
  check('private_policy_enabled_check', sql`${t.enabled} in (0, 1)`),
  check('private_policy_acceptance_check', sql`(${t.enabled} = 0 and ${t.acceptedPolicyVersion} is null and ${t.acceptedPolicyHash} is null and ${t.acceptedAt} is null) or (${t.enabled} = 1 and ${t.acceptedPolicyVersion} = ${t.policyVersion} and ${t.acceptedPolicyHash} is not null and ${t.acceptedAt} is not null)`),
]);
export const policyCommands = sqliteTable('private_policy_command', {
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  revision: integer('revision').notNull(),
  acknowledgement: text('acknowledgement', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.requestId] }),
  uniqueIndex('private_policy_command_revision_unique').on(t.ownerId, t.revision),
  check('private_policy_command_revision_check', sql`typeof(${t.revision}) = 'integer' and ${t.revision} > 0`),
  check('private_policy_ack_json_check', sql`json_valid(${t.acknowledgement})`),
]);

export { documents, documentUploadGrants } from './document-schema.ts';
export { applicationArtifacts } from './artifact-schema.ts';
export { workerPairings, workers, applicationRuns, applications, applicationEvents, applicationLive, workerCommands } from './worker-schema.ts';
export { applicationSubmissions, applicationReceipts } from './submission-schema.ts';
export { discoveryManifests, discoveryTargets, legacyImportPreviews, manualApplicationMarks } from './discovery-schema.ts';
export { questions, questionAnswers, questionReviews, questionInterventions, inboxReads } from './question-schema.ts';
export { outreach, outreachSettings } from './outreach-schema.ts';
