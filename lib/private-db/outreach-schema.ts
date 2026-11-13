import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './schema.ts';
import { OUTREACH_STATES } from '../applications/outreach-protocol.ts';

export type OutreachRole = { applicationId: string; role: string; submittedAt: number };
export type OutreachPerson = { name: string; title: string | null; url: string };

/** The applicant's own message template. It holds personal facts, so it lives here and never in the (public) source. */
export const outreachSettings = sqliteTable('private_outreach_settings', {
  ownerId: text('owner_id').primaryKey().references(() => user.id, { onDelete: 'restrict' }),
  template: text('template').notNull(),
  // Only applications submitted from here on get a message; earlier ones are never queued.
  enabledAt: integer('enabled_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [check('private_outreach_settings_template', sql`length(${t.template}) between 1 and 8000`)]);

/** One recruiter message per employer, naming every role applied to there. */
export const outreach = sqliteTable('private_outreach', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  companyKey: text('company_key').notNull(), company: text('company').notNull(),
  roles: text('roles', { mode: 'json' }).$type<OutreachRole[]>().notNull(),
  recruiter: text('recruiter', { mode: 'json' }).$type<OutreachPerson>(),
  overlap: text('overlap'), subject: text('subject'), body: text('body'),
  state: text('state', { enum: OUTREACH_STATES }).notNull().default('draft'), reason: text('reason'),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
  sentAt: integer('sent_at'), threadUrl: text('thread_url'),
}, (t) => [
  uniqueIndex('private_outreach_owner_company').on(t.ownerId, t.companyKey),
  index('private_outreach_owner_state').on(t.ownerId, t.state),
  check('private_outreach_json', sql`json_valid(${t.roles}) and length(cast(${t.roles} as blob)) <= 16384`),
  check('private_outreach_state', sql`${t.state} in ('draft','approved','sending','sent','skipped','failed') and (${t.state} not in ('approved','sending','sent') or (${t.recruiter} is not null and ${t.body} is not null))`),
]);
