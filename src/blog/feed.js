/**
 * Our own RSS 2.0 feed (plan §6.4).
 *
 * Phase 1 ships a valid, zero-item channel so the domain is self-verifying from
 * the first deploy: `/feed.xml` exists, is RSS 2.0, and is advertised from every
 * page's `<head>`. Real items arrive with the blog in phase 7. A valid channel
 * with no items is fine per §5 Step 3.
 *
 * `<source:blogroll>` joins it in phase 6, once /subscriptions.opml exists: it is
 * the same element we detect on other people's feeds (§5 Step 6), pointed at our
 * member list. It was withheld in phase 1 because this feed is read by exactly the
 * crawlers that would have followed it to a 404.
 */

import { escapeXml } from '../lib/xml.js';

const SOURCE_NS = 'https://source.scripting.com/';

// §6.4: one escaper, shared, rather than a second implementation here. Re-exported
// because this was its original home.
export { escapeXml };

export function renderFeed({ config }) {
  const siteLink = new URL('/', config.siteUrl).href;
  const selfLink = new URL('/feed.xml', config.siteUrl).href;
  const blogrollLink = new URL('/subscriptions.opml', config.siteUrl).href;

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
    <source:blogroll>${escapeXml(blogrollLink)}</source:blogroll>
  </channel>
</rss>
`;
}
