import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

// Every filter, page and job drawer on the board is a query string on /, and each new
// combination renders fresh against the database. Only the bare board is worth fetching.
// `/?` is the plain-prefix form; `/*?` is the wildcard form Google and Bing read.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: ['/?', '/*?'] }, sitemap: `${SITE_URL}/sitemap.xml` };
}
