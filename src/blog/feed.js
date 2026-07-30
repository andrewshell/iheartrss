/**
 * Our own RSS 2.0 feed (plan §6.4).
 *
 * Phase 1 shipped a valid, zero-item channel so the domain was self-verifying from
 * the first deploy: `/feed.xml` exists, is RSS 2.0, and is advertised from every
 * page's `<head>`. A valid channel with no items is fine per §5 Step 3, and it still
 * is — `posts` defaults to empty, so a site with no `content/` directory keeps a
 * valid feed. Phase 7 adds the items.
 *
 * `<source:blogroll>` joins it in phase 6, once /subscriptions.opml exists: it is
 * the same element we detect on other people's feeds (§5 Step 6), pointed at our
 * member list. It was withheld in phase 1 because this feed is read by exactly the
 * crawlers that would have followed it to a 404.
 */

import { escapeXml, xmlSafeContent, xmlSafeText } from '../lib/xml.js';

const SOURCE_NS = 'https://source.scripting.com/';

// §6.4: one escaper, shared, rather than a second implementation here. Re-exported
// because this was its original home.
export { escapeXml };

export function renderFeed({ config, posts = [] }) {
  const siteLink = new URL('/', config.siteUrl).href;
  const selfLink = new URL('/feed.xml', config.siteUrl).href;
  const blogrollLink = new URL('/subscriptions.opml', config.siteUrl).href;

  const itemsXml = posts.map((post) => renderItem({ post, config })).join('');

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
    <source:blogroll>${escapeXml(blogrollLink)}</source:blogroll>${itemsXml}
  </channel>
</rss>
`;
}

/**
 * One `<item>` (§6.4).
 *
 * **An untitled post emits no `<title>` at all** — not an empty one, not the date.
 * RSS 2.0 requires only that at least one of `title` and `description` is present,
 * so `<description>` alone is a valid item and exactly the linkblog style the
 * Winer-adjacent world writes in. `<guid isPermaLink="true">` is always there, so
 * every post is addressable either way.
 *
 * `<description>` (rendered HTML) and `<source:markdown>` (the source text) are both
 * **entity-encoded through the one shared escaper**: marked's output and raw markdown
 * both routinely contain `<`, `>` and `&`, and one unescaped angle bracket makes the
 * document not well-formed for every subscriber. `xmlSafeText` runs first for the same
 * reason it does in the OPML — a lone surrogate is not a legal XML character at all.
 */
function renderItem({ post, config }) {
  const link = new URL(post.path, config.siteUrl).href;

  const lines = [];
  if (post.title !== null && post.title !== '') {
    lines.push(`      <title>${escapeXml(xmlSafeText(post.title))}</title>`);
  }
  lines.push(`      <link>${escapeXml(link)}</link>`);
  lines.push(`      <guid isPermaLink="true">${escapeXml(link)}</guid>`);
  lines.push(`      <pubDate>${rfc822(post.pubDate)}</pubDate>`);
  // `xmlSafeContent`, not `xmlSafeText`: both of these are element content, where a
  // newline is meaningful. The attribute-value filter normalises newlines to spaces
  // — right for the title above, and fatal here, where it would flatten a fenced code
  // block into one unparseable line.
  lines.push(`      <description>${escapeXml(xmlSafeContent(post.html))}</description>`);
  lines.push(
    `      <source:markdown>${escapeXml(xmlSafeContent(post.markdown))}</source:markdown>`,
  );

  return `\n    <item>\n${lines.join('\n')}\n    </item>`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * RSS 2.0 dates are RFC 822. Spelled out from the UTC parts rather than left to
 * `Date.prototype.toUTCString()`, whose exact output format is not what this feed
 * should depend on — the day and month abbreviations here are the ones the spec
 * names, in English, regardless of the host.
 */
function rfc822(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');

  return (
    `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ` +
    `${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())} GMT`
  );
}
