import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { INDEXABLE, SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from '@/lib/site';

/** Postie's face, at the four weights its stylesheet uses. */
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  applicationName: 'Workie',
  ...(INDEXABLE ? {} : { robots: { index: false, follow: false } }),
};

/** In the head, not the page: the board streams, and a crawler that runs no script reads the head first. */
const SITE_LD = JSON.stringify({
  '@context': 'https://schema.org', '@type': 'WebSite', name: 'Workie', url: `${SITE_URL}/`, description: SITE_DESCRIPTION,
});

/** Applies a collapsed sidebar before first paint, so it doesn't flash. */
const SIDE_BOOT = `try{if(localStorage.getItem('workie-side')==='rail')document.documentElement.dataset.side='rail'}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SIDE_BOOT }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: SITE_LD }} />
      </head>
      <body className="bg-canvas text-fg">
        <a className="skip-link" href="#main-content">Skip to main content</a>
        {children}
      </body>
    </html>
  );
}
