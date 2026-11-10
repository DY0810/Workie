import type { NextConfig } from "next";
import path from "node:path";

const documentParserTrace = [
  './lib/applications/documents-parse-worker.mjs',
  './node_modules/pdf-lib/**', './node_modules/@pdf-lib/**',
  './node_modules/pako/**', './node_modules/tslib/**',
  './node_modules/yauzl/**', './node_modules/pend/**', './node_modules/sax/**',
];

const nextConfig: NextConfig = {
  // Next 15 dev/build use default webpack until libSQL native-loader tracing is
  // qualified with Turbopack (vercel/next.js#82881); keep both file and HTTP clients.
  // better-sqlite3 is a native addon: it must be required at runtime, not bundled.
  serverExternalPackages: ['better-sqlite3'],
  // Next streams a dynamic page's title, canonical and OG tags into <body> unless the user agent
  // is on its bot list. The CDN serves one cached copy of / to everyone, so a crawler could get
  // the browser's copy, where a canonical outside <head> is ignored. All metadata here is static,
  // so putting it in <head> for every agent delays nothing.
  htmlLimitedBots: /.*/,
  // The parser is a static Node worker, outside webpack's module graph.
  outputFileTracingIncludes: {
    // libsql selects its installed native package with a computed require().
    '/api/**': ['./node_modules/@libsql/*/package.json', './node_modules/@libsql/*/*.node'],
    '/api/documents{,/**}': documentParserTrace,
    '/api/worker/applications/**/artifacts/**/upload': documentParserTrace,
  },
  // A stray lockfile up the directory tree (outside this repo) makes Turbopack guess the
  // wrong workspace root. Pin it explicitly so builds are deterministic regardless.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Saves only work on the household origin (BETTER_AUTH_URL): the same-origin check refuses every other host.
  // So production pages opened on a *.vercel.app alias move there. Left alone: /api (workers call it on the host
  // they paired with) and this deployment's own URL (VERCEL_URL), so a past deployment can still be opened.
  async redirects() {
    const origin = process.env.VERCEL_ENV === 'production' && process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL) : null;
    const stay = [origin?.hostname, process.env.VERCEL_URL].flatMap((host) => host ? [{ type: 'host' as const, value: host.replaceAll('.', '\\.') }] : []);
    return origin ? [{ source: '/:path((?!api(?:/|$)).*)', missing: stay, destination: `${origin.origin}/:path`, permanent: false }] : [];
  },
  // Every view is force-dynamic (filters live in the URL), so without this the CDN never
  // caches and every load — including the ~1s cold start — hits the function. The corpus
  // refreshes every 30 minutes; serving a view up to 5 minutes old, and a stale one while
  // the next renders, costs nothing visible. Vercel-CDN-Cache-Control is the edge-only
  // header: Next keeps setting its own browser Cache-Control (no-store), so back/forward
  // and reloads in the browser stay fresh — only the CDN holds a copy.
  async headers() {
    const edge = { key: 'Vercel-CDN-Cache-Control', value: 'max-age=300, stale-while-revalidate=1500' };
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      { source: '/', headers: [edge] },
      { source: '/api/postings/:id', headers: [edge] },
    ];
  },
};

export default nextConfig;
