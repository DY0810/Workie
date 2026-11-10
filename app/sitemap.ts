import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

// One entry on purpose: every other public view is a query string robots.txt forbids, and
// listing postings here would invite the crawl load that view exists to refuse.
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_URL}/`, changeFrequency: 'hourly' }];
}
