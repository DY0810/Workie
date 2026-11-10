/** What search and answer engines are told about the site. Static: nothing here reads the database. */

/** The household origin, the same one `next.config.ts` moves every other host to. */
export const SITE_URL = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:3000').origin;

/** Only production is worth indexing: staging and previews serve the same pages on other hosts. */
export const INDEXABLE = process.env.VERCEL_ENV === 'production';

export const SITE_TITLE = 'Workie: entry-level design and engineering jobs and internships';

export const SITE_DESCRIPTION =
  'Design and engineering jobs and internships, entry to mid level, collected from company career boards and job feeds. Refreshed about every 30 minutes, newest first.';
