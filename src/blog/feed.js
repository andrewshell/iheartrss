/**
 * Our own RSS 2.0 feed (plan §6.4).
 *
 * Phase 1 ships a valid, zero-item channel so the domain is self-verifying from
 * the first deploy: `/feed.xml` exists, is RSS 2.0, and is advertised from every
 * page's `<head>`. Real items arrive with the blog in phase 7. A valid channel
 * with no items is fine per §5 Step 3.
 *
 * `<source:blogroll>` is deliberately NOT emitted yet — it would point at
 * /subscriptions.opml, which does not exist until phase 6, and this feed is read
 * by exactly the crawlers that would follow it.
 */

const SOURCE_NS = 'https://source.scripting.com/';

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderFeed({ config }) {
  const siteLink = new URL('/', config.siteUrl).href;
  const selfLink = new URL('/feed.xml', config.siteUrl).href;

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:source="${escapeXml(SOURCE_NS)}">
  <channel>
    <title>I ♥ RSS</title>
    <link>${escapeXml(siteLink)}</link>
    <description>News and notes from iheartrss.com, a directory for people who love RSS.</description>
    <language>en</language>
    <docs>https://www.rssboard.org/rss-specification</docs>
    <generator>iheartrss.com</generator>
    <source:self>${escapeXml(selfLink)}</source:self>
  </channel>
</rss>
`;
}
