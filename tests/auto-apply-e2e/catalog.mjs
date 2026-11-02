// Seeds fixture roles into the e2e catalog. stack.mjs seeds the first at start-up; the spec adds the second
// mid-run (`node tests/auto-apply-e2e/catalog.mjs <catalog.db> 4000002`), which the running run finds at its next rescan.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both titled "Software Engineering Intern": the fixture page's <title> names that role, and the worker
// refuses a page whose title is another role (ATS_IDENTITY_MISMATCH, worker/ats/greenhouse.ts).
export const ROLES = {
  4000001: { location: 'Remote', locationKey: 'remote', isRemote: true, workMode: 'remote' },
  4000002: { location: 'New York, NY', locationKey: 'new york|ny|us', isRemote: false, workMode: 'onsite' },
};

/** Inserts one fixture role (same shape as scripts/staging-seed.ts); `migrate` creates the schema first. */
export async function seedRole(catalog, requisition, { migrate = false } = {}) {
  const role = ROLES[requisition];
  if (!role) throw new Error(`unknown fixture role ${requisition}`);
  process.env.WORKIE_DB = catalog;
  const { openDb } = await import('../../lib/db/index.ts');
  const { postings } = await import('../../lib/db/schema.ts');
  const { STAGING_FIXTURE_TENANT } = await import('../../lib/applications/worker-protocol.ts');
  const db = openDb(catalog, { migrate });
  try {
    const now = new Date();
    db.insert(postings).values({
      dedupeKey: `e2e-fixture-${STAGING_FIXTURE_TENANT}-${requisition}`,
      canonicalUrl: `https://job-boards.greenhouse.io/${STAGING_FIXTURE_TENANT}/jobs/${requisition}`,
      postedAt: now, firstSeenRun: now.toISOString(), company: 'Fixture Co', title: 'Software Engineering Intern',
      description: 'Fixture Co is hiring a Software Engineering Intern to build TypeScript APIs, write CI tests and improve reliability. ' +
        'This is the Workie e2e fixture role; its form is served by the worker and never reaches an employer.',
      companyNorm: 'fixture co', titleNorm: 'software engineering intern', locationKey: role.locationKey,
      country: 'US', isRemote: role.isRemote, location: role.location, workMode: role.workMode,
      track: 'engineering', seniority: 'entry', employmentType: 'internship', paid: true,
    }).run();
  } finally {
    db.$client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [catalog, requisition] = process.argv.slice(2);
  await seedRole(catalog, requisition);
}
