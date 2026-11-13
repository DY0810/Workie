import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '../private-db/index.ts';
import { applications, applicationSubmissions, policyHeads, policyVersions, user } from '../private-db/schema.ts';
import { renderOutreach, unfilledSlots } from '../outreach-message.ts';
import { stubHousehold } from '../test-household.ts';
import { commandOutreach, listOutreach, saveOutreachSettings } from './outreach.ts';
import { LinkedinProfileSchema } from './outreach-protocol.ts';
import { createPairing, pairWorker } from './pairing.ts';
import { createEmptyPolicy } from './policy.ts';
import { createRun } from './runs.ts';
import { hashValue } from './stores.ts';
import { enqueueApplication } from './test-enqueue.ts';

vi.mock('server-only', () => ({}));
let db: PrivateDb, dir: string, now: number, runId: string, workerId: string;
const options = { now: () => now };
const recruiter = (handle: string) => ({ name: 'Sam Fixture', title: 'University Recruiter', url: `https://www.linkedin.com/in/${handle}` });

/** An application of alice's that reached `submitted` at the current time. */
async function submitted(company: string, role: string, state: 'submitted' | 'submission_unknown' = 'submitted') {
  const app = await enqueueApplication(db, 'alice', runId, { ats: 'fixture', tenant: 'fixture', requisition: randomUUID() }, options);
  await db.update(applications).set({ state }).where(eq(applications.id, app.id));
  await db.insert(applicationSubmissions).values({ intentId: randomUUID(), ownerId: 'alice', applicationId: app.id, workerId,
    ats: 'fixture', tenant: 'fixture', requisition: app.requisition, company, role, manifestHash: 'a'.repeat(64), artifactHashes: [],
    requestHash: 'b'.repeat(64), state: state === 'submitted' ? 'submitted' : 'unknown', createdAt: now, submittedAt: state === 'submitted' ? now : null });
  return app.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'outreach-'));
  now = 1_800_000_000_000;
  stubHousehold();
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await migratePrivateDb(db);
  await db.insert(user).values({ id: 'alice', name: 'Synthetic', email: 'alice@example.test', emailVerified: true });
  const policy = createEmptyPolicy(), hash = hashValue(policy);
  await db.insert(policyVersions).values({ ownerId: 'alice', version: 1, hash, policy, createdAt: now });
  await db.insert(policyHeads).values({ ownerId: 'alice', revision: 1, policyVersion: 1, enabled: true,
    acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
  const grant = await createPairing(db, 'alice', { expectedRevision: 0, requestId: randomUUID(), label: 'Synthetic worker' }, options);
  workerId = randomUUID();
  await pairWorker(db, { protocolVersion: 1, workerId, requestId: randomUUID(), grant: grant.grant,
    workerToken: randomBytes(32).toString('base64url'), workerVersion: '0.1.0', capabilities: ['control-v1'] }, options);
  runId = (await createRun(db, 'alice', { expectedRevision: 0, requestId: randomUUID(), workerId }, options)).id;
});
afterEach(() => { db?.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe('outreach queue', () => {
  it('queues nothing until a template is saved, and nothing submitted before it', async () => {
    await submitted('Old Co', 'Software Engineer Intern');
    const unconfirmed = await submitted('Unconfirmed Co', 'Data Intern', 'submission_unknown');
    expect((await listOutreach(db, 'alice', options)).items).toEqual([]);
    now += 1000;
    const list = await saveOutreachSettings(db, 'alice', { template: 'Hi {Name}' }, options);
    expect(list).toMatchObject({ template: 'Hi {Name}', enabledAt: now, items: [] });
    // A later template edit must not move the cutoff forward and drop what is already eligible.
    now += 1000;
    await submitted('New Co', 'Software Engineer Intern');
    now += 1000;
    const edited = await saveOutreachSettings(db, 'alice', { template: 'Hello {Name}' }, options);
    expect(edited.items.map((row) => row.company)).toEqual(['New Co']);
    // "It went through" on an older application keeps the day it was sent, so it stays out as well.
    await db.update(applications).set({ state: 'submitted' }).where(eq(applications.id, unconfirmed));
    expect((await listOutreach(db, 'alice', options)).items.map((row) => row.company)).toEqual(['New Co']);
  });

  it('keeps one draft per company, naming each role, and never queues an unconfirmed submission', async () => {
    await saveOutreachSettings(db, 'alice', { template: 'Hi {Name}' }, options);
    now += 1000;
    const first = await submitted('Fixture Co', 'Software Engineer Intern');
    const unknown = await submitted('Unknown Co', 'Data Intern', 'submission_unknown');
    now += 1000;
    expect((await listOutreach(db, 'alice', options)).items).toMatchObject([{ company: 'Fixture Co', state: 'draft',
      roles: [{ applicationId: first, role: 'Software Engineer Intern' }] }]);
    const second = await submitted('fixture  co', 'Frontend Intern');
    const { items } = await listOutreach(db, 'alice', options);
    expect(items).toHaveLength(1);
    expect(items[0].roles.map((role) => role.applicationId)).toEqual([first, second]);
    // Reading again changes nothing.
    expect((await listOutreach(db, 'alice', options)).items).toEqual(items);
    // Once the applicant confirms the employer received it, it gets its draft.
    await db.update(applications).set({ state: 'submitted' }).where(eq(applications.id, unknown));
    expect((await listOutreach(db, 'alice', options)).items.map((row) => row.company).sort()).toEqual(['Fixture Co', 'Unknown Co']);
  });

  it('approves only a filled message, once per recruiter, and adds no role after approval', async () => {
    await saveOutreachSettings(db, 'alice', { template: 'Hi {Name}' }, options);
    now += 1000;
    await submitted('Fixture Co', 'Software Engineer Intern');
    await submitted('Other Co', 'Software Engineer Intern');
    const [other, fixture] = (await listOutreach(db, 'alice', options)).items;
    // A draft keeps the applicant's edits, and may have no recruiter yet.
    expect(await commandOutreach(db, 'alice', other.id, { action: 'save', recruiter: null, overlap: 'We both ship fixtures.', subject: null, body: 'Hi {Name}, edited.' }, options))
      .toMatchObject({ state: 'draft', recruiter: null, overlap: 'We both ship fixtures.', body: 'Hi {Name}, edited.' });
    const approve = (id: string, body: string, handle = 'sam') =>
      commandOutreach(db, 'alice', id, { action: 'approve', recruiter: recruiter(handle), subject: '', body }, options);
    await expect(approve(fixture.id, 'Hi Sam, I can relocate to {City}.')).rejects.toMatchObject({ status: 400, code: 'UNFILLED' });
    expect(await approve(fixture.id, 'Hi Sam.')).toMatchObject({ state: 'approved', body: 'Hi Sam.', recruiter: { url: 'https://www.linkedin.com/in/sam' } });
    await expect(approve(fixture.id, 'Hi again.')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    await expect(approve(other.id, 'Hi Sam.')).rejects.toMatchObject({ status: 409, code: 'ALREADY_MESSAGED' });
    now += 1000;
    await submitted('Fixture Co', 'Frontend Intern');
    expect((await listOutreach(db, 'alice', options)).items.find((row) => row.id === fixture.id)?.roles).toHaveLength(1);
    // A message the applicant sent by hand is recorded as theirs, and its recruiter is never messaged again either.
    expect(await commandOutreach(db, 'alice', other.id, { action: 'mark-sent', recruiter: recruiter('pat'), subject: '', body: 'Hi Pat.' }, options))
      .toMatchObject({ state: 'sent', reason: 'sent_by_applicant', sentAt: now });
    await expect(commandOutreach(db, 'alice', other.id, { action: 'reopen' }, options)).rejects.toMatchObject({ status: 409 });
    expect(await commandOutreach(db, 'alice', fixture.id, { action: 'reopen' }, options)).toMatchObject({ state: 'draft' });
    await expect(commandOutreach(db, 'bob', fixture.id, { action: 'skip' }, options)).rejects.toMatchObject({ status: 404 });
  });
});

describe('outreach message', () => {
  const at = Date.parse('2026-11-12T20:00:00Z');
  const slots = { recruiter: 'Sam Fixture', company: 'Fixture Co', overlap: 'We both ship fixtures.', now: at, timeZone: 'America/Los_Angeles',
    roles: [{ role: 'Software Engineer Intern', submittedAt: at - 3_600_000 }] };
  it('fills the slots it knows and leaves the rest for the applicant', () => {
    const text = renderOutreach('Hi {Name}, I applied to {Roles} at {Company} {When}. {Overlap} I can relocate to {City}.', slots);
    expect(text).toBe('Hi Sam, I applied to the Software Engineer Intern role at Fixture Co today. We both ship fixtures. I can relocate to {City}.');
    expect(unfilledSlots(text)).toEqual(['{City}']);
    // A long instruction left in braces, or a stray brace, blocks the send as well.
    expect(unfilledSlots(`Hi. {One line on where my work overlaps with theirs, e.g. "we both\nbuild fixtures."} Bye }`))
      .toEqual(['{One line on where my work overlaps wit...}', '}']);
  });
  it('says "today" only on the day of the application and names every role', () => {
    const roles = [...slots.roles, { role: 'Frontend Intern', submittedAt: at - 30 * 3_600_000 }];
    expect(renderOutreach('{Roles} {When}, {Role}', { ...slots, roles }))
      .toBe('the Software Engineer Intern and Frontend Intern roles on November 12, Software Engineer Intern and Frontend Intern');
    expect(renderOutreach('{Name} {Overlap}', { ...slots, recruiter: null, overlap: ' ' })).toBe('{Name} {Overlap}');
  });
  it('keeps one URL per LinkedIn profile', () => {
    expect(LinkedinProfileSchema.parse('https://linkedin.com/in/Sam-Fixture-123/?miniProfileUrn=x')).toBe('https://www.linkedin.com/in/sam-fixture-123');
    expect(LinkedinProfileSchema.safeParse('https://www.linkedin.com/company/fixture').success).toBe(false);
    expect(LinkedinProfileSchema.safeParse('https://evil.example/in/sam').success).toBe(false);
  });
});
