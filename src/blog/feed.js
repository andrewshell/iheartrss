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
 *
 * `<cloud>` and `<source:cloud>` arrive together, once we point at a real rssCloud
 * server (§6.4). Both forms, never one: `<cloud>` is what every rssCloud client that
 * ever shipped reads, and `<source:cloud>` is the element we award other people a
 * badge for detecting — so our own feed had better carry it. They are advertised
 * unconditionally, including when `RSSCLOUD_ENABLED` is false: the element states
 * which cloud server subscribers may register with, and that server re-fetches the
 * feed on its own schedule whether or not we ping it. `RSSCLOUD_ENABLED` gates the
 * ping, not the advertisement.
 */

import { escapeXml, SOURCE_NS, xmlSafeContent, xmlSafeText } from '../lib/xml.js';

// §6.4: one escaper, shared, rather than a second implementation here. Re-exported
// because this was its original home.
export { escapeXml };

/**
 * The channel title, as a constant because `<image>` has to repeat it.
 *
 * The RSS spec says the image's `<title>` and `<link>` "should have the same value as
 * the channel's `<title>` and `<link>`" — so this is one string with two required
 * spellings, which is exactly the shape that drifts.
 */
const CHANNEL_TITLE = 'I ♥ RSS';

export function renderFeed({ config, posts = [] }) {
  const siteLink = new URL('/', config.siteUrl).href;
  const selfLink = new URL('/feed.xml', config.siteUrl).href;
  const blogrollLink = new URL('/subscriptions.opml', config.siteUrl).href;
  // §6.1's home-screen icon, doing a second job. See `channelImage` below for why
  // this file and not one of the SVGs.
  const imageLink = new URL('/apple-touch-icon.png', config.siteUrl).href;
  // The `<source:cloud>` form names the same server as the `<cloud>` attributes,
  // spelled as one https URL — so the two forms can never drift onto different hosts.
  // `port` belongs to the http-post form only; the URL form uses the scheme's own.
  const cloudLink = `https://${config.rsscloudDomain}${config.rsscloudPath}`;

  const itemsXml = posts.map((post) => renderItem({ post, config })).join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:source="${escapeXml(SOURCE_NS)}">
  <channel>
    <title>${escapeXml(CHANNEL_TITLE)}</title>
    <link>${escapeXml(siteLink)}</link>
    <description>News and notes from iheartrss.com, a directory for people who love RSS.</description>
    <language>en</language>${channelPubDate(posts)}
${channelImage({ imageLink, siteLink })}
    <docs>https://www.rssboard.org/rss-specification</docs>
    <generator>iheartrss.com</generator>
    <cloud domain="${escapeXml(config.rsscloudDomain)}" port="${escapeXml(String(config.rsscloudPort))}" path="${escapeXml(config.rsscloudPath)}" registerProcedure="" protocol="${escapeXml(config.rsscloudProtocol)}"/>
    <source:cloud>${escapeXml(cloudLink)}</source:cloud>
    <source:self>${escapeXml(selfLink)}</source:self>
    <source:blogroll>${escapeXml(blogrollLink)}</source:blogroll>${itemsXml}
  </channel>
</rss>
`;
}

/**
 * The channel's own `<pubDate>` — the newest post's date, and **not** the time the
 * feed was rendered.
 *
 * ── Why it exists at all ──────────────────────────────────────────────────────
 *
 * A channel `<pubDate>` is optional and this feed shipped without one, which was
 * invisible until our own feed appeared in a river. FeedLand stores a feed's
 * channel-level pubDate and hands it back from `getfeed`; `riverviewer.js` renders
 * that as the date beside a section's title, and prints a literal `[ no date ]` when
 * the field is absent. Ours was the section on /river reading "no date" next to every
 * member who had one. Confirmed both ways: scripting.com's channel `<pubDate>` and
 * the `pubDate` FeedLand reports for it are byte-identical, and the record FeedLand
 * holds for us had no `pubDate` key at all.
 *
 * ── Why the newest post and not `new Date()` ──────────────────────────────────
 *
 * `renderFeed` runs per request, so a build-time stamp would make the bytes of
 * `/feed.xml` differ on every single fetch. Nothing downstream could tell a real
 * update from a re-render: conditional requests would always miss, and anything
 * diffing the feed — including the rssCloud subscribers we advertise `<cloud>` to —
 * would see the channel change every time it polled. The newest post's date changes
 * exactly when the content does, which is what the element is specified to mean.
 *
 * Deliberately no `<lastBuildDate>` alongside it. It is the one element that IS
 * honestly the render time, and it would reintroduce exactly the churn above for a
 * value no reader here needs.
 *
 * With no posts there is nothing to date, so the element is omitted rather than
 * invented — a zero-item channel stays valid, which phase 1 relied on.
 *
 * `posts` arrives newest-first from `blog/index.js`, which sorts on `pubDate` with a
 * filename tie-break. Taking `[0]` rather than re-scanning for a maximum keeps this
 * honest to that contract: if the order ever changed, the feed's item order would be
 * wrong first and far more loudly.
 */
function channelPubDate(posts) {
  if (posts.length === 0) return '';
  return `\n    <pubDate>${rfc822(posts[0].pubDate)}</pubDate>`;
}

/**
 * `<image>` — the channel's icon, per the RSS 2.0 spec's
 * [image sub-element](https://cyber.harvard.edu/rss/rss.html#ltimagegtSubelementOfLtchannelgt).
 *
 * Three required children in the order the spec lists them — `<url>`, `<title>`,
 * `<link>` — plus the optional `<description>`, which readers put in the `title`
 * attribute of the link they wrap the image in. `<width>` and `<height>` are the
 * other two optional ones and they are **deliberately absent**; see below.
 *
 * ── Why apple-touch-icon.png ──────────────────────────────────────────────────
 *
 * The spec allows GIF, JPEG or PNG and nothing else, which rules out the three SVG
 * brand files immediately. Of the PNGs we already serve, this is the right one for a
 * reason that is easy to miss: it is the **one asset with no alpha channel** (§6.1
 * flattens it onto opaque white for iOS). A feed reader composites a channel icon
 * onto whatever its own chrome is — often a dark sidebar — and a transparent
 * near-black wordmark would disappear into it. The flattening that was done for
 * iOS home screens is the same thing that makes it safe here.
 *
 * ── Why no `<width>`/`<height>` ───────────────────────────────────────────────
 *
 * The file is 180×180 and the spec's maximum width is 144 (default 88; height max
 * 400, default 31). Those numbers describe the 88×31 banner GIFs of 2002, not a
 * square app icon. All three options are imperfect and omission is the least so:
 * declaring 180 states a width the spec forbids, declaring 144 states a width the
 * file does not have, and omitting says nothing false — readers that care measure
 * the PNG, and the ones that fall back to 88×31 would have been wrong about a
 * square icon either way. scripting.com omits them too.
 *
 * ── The header this depends on ────────────────────────────────────────────────
 *
 * **A channel image is hotlinked by definition**, so `apple-touch-icon.png` is in
 * `HOTLINKABLE` in `routes/static.js`. Without that it is served
 * `Cross-Origin-Resource-Policy: same-origin` — the site-wide default — and every
 * browser-based reader is refused the image by its own browser, with nothing in our
 * logs to show for it. That entry and this element are one change in two files.
 */
function channelImage({ imageLink, siteLink }) {
  return `    <image>
      <url>${escapeXml(imageLink)}</url>
      <title>${escapeXml(CHANNEL_TITLE)}</title>
      <link>${escapeXml(siteLink)}</link>
      <description>A directory for people who love RSS.</description>
    </image>`;
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
