/**
 * `/sitemap.xml` — the static pages plus every blog post (plan §6, phase 7).
 *
 * "Search is the growth channel", so this is not decoration. What it deliberately
 * does **not** list is anything `robots.txt` disallows — `/admin`, `/check`,
 * `/recheck`, `/status`: a sitemap entry is an invitation to fetch, and inviting a
 * crawler to the routes we just told it to avoid is the sort of contradiction that
 * ends with Googlebot spending our outbound fetch budget.
 */

import { escapeXml } from './xml.js';

/** The pages worth indexing, in rough order of importance. */
const STATIC_PATHS = Object.freeze([
  '/',
  '/blog',
  '/sites',
  '/submit',
  '/badge',
  '/guide',
  '/about',
]);

export function renderSitemap({ config, posts = [] }) {
  const entries = [
    ...STATIC_PATHS.map((path) => ({ path, lastmod: null })),
    ...posts.map((post) => ({ path: post.path, lastmod: post.date })),
  ];

  const urls = entries
    .map(({ path, lastmod }) => {
      const loc = escapeXml(new URL(path, config.siteUrl).href);
      const modified =
        lastmod === null ? '' : `\n    <lastmod>${escapeXml(lastmod)}</lastmod>`;
      return `  <url>\n    <loc>${loc}</loc>${modified}\n  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
