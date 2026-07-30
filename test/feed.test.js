import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseFeed } from '../src/verify/feed.js';

// Plan §5 Step 3 (parse + validate), Step 6 (feature detection) and §7's ingest
// caps, per §11's `feed.test.js`.

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('accepts scripting.com/rss.xml, the reference RSS 2.0 feed', () => {
  const result = parseFeed(fixture('scripting-rss.xml'));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.title, 'Scripting News');
  assert.equal(result.channelLink, 'http://scripting.com/');
});

test('an Atom feed is refused with `feed_not_rss2`, not `feed_invalid`', () => {
  // §5 Step 3: the message is the site's pitch, not a validator complaint, so the
  // reason code has to distinguish "valid XML, wrong format" from "broken XML".
  const result = parseFeed(fixture('atom-feed.xml'));

  assert.deepEqual(result, { ok: false, reason: 'feed_not_rss2' });
});

test('rejects `<rss version="0.91">` but accepts `2.00` and a missing version', () => {
  // §5 Step 3: requiring exactly `2.0` is stricter than the wild — `2.00` and a
  // missing attribute both occur, and neither is Atom or 0.9x.
  const channel =
    '<channel><title>A blog</title><link>https://a.example/</link></channel>';

  assert.deepEqual(parseFeed(`<rss version="0.91">${channel}</rss>`), {
    ok: false,
    reason: 'feed_not_rss2',
  });
  assert.deepEqual(parseFeed(`<rss version="1.0">${channel}</rss>`), {
    ok: false,
    reason: 'feed_not_rss2',
  });
  assert.equal(parseFeed(`<rss version="2.00">${channel}</rss>`).ok, true);
  assert.equal(parseFeed(`<rss>${channel}</rss>`).ok, true);
});

test('malformed and truncated XML hit `feed_invalid`, because parse() does not throw', () => {
  // §5 Step 3, verified: a truncated feed returns a *clean-looking* object, a
  // mismatched close tag parses happily, and 'not xml at all' returns `{}`. Without
  // XMLValidator running first, `feed_invalid` would never fire and we would list
  // sites off half-read documents.
  const truncated = '<rss version="2.0"><channel><title>a</title>';
  const mismatched = '<rss version="2.0"><channel><title>a</titel></channel></rss>';

  assert.deepEqual(parseFeed(truncated), { ok: false, reason: 'feed_invalid' });
  assert.deepEqual(parseFeed(mismatched), { ok: false, reason: 'feed_invalid' });
  assert.deepEqual(parseFeed('not xml at all'), { ok: false, reason: 'feed_invalid' });
});

test('tolerates a UTF-8 BOM and a blank line before the XML declaration', () => {
  // §5 Step 3: a blank line before `<?xml` is a classic WordPress
  // output-buffering artifact and fails validation with "XML declaration allowed
  // only at the start of the document".
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0"><channel><title>Buffered</title>' +
    '<link>https://b.example/</link></channel></rss>';

  assert.equal(parseFeed(`\uFEFF${body}`).ok, true, 'BOM');
  assert.equal(parseFeed(`\n\n  ${body}`).ok, true, 'leading whitespace');
  assert.equal(parseFeed(`\uFEFF\n${body}`).ok, true, 'BOM then blank line');
});

test('rejects a DOCTYPE placed AFTER the root element, where a prolog scan is blind', () => {
  // §5 Step 3, verified: `XMLValidator.validate()` returns **true** on this and the
  // parsed title is "PWNED". A prolog-only scan is bypassed by placement, so §11
  // requires the post-root form — a prolog fixture passes for the wrong reason.
  const postRoot =
    '<rss version="2.0"><!DOCTYPE rss [<!ENTITY a "PWNED">]>' +
    '<channel><title>&a;</title><link>https://a.example/</link></channel></rss>';

  assert.deepEqual(parseFeed(postRoot), { ok: false, reason: 'feed_invalid' });

  // Case-insensitively, and in the prolog too.
  const prolog =
    '<!doctype rss [<!entity a "PWNED">]>' +
    '<rss version="2.0"><channel><title>&a;</title></channel></rss>';
  assert.deepEqual(parseFeed(prolog), { ok: false, reason: 'feed_invalid' });
});

test('an entity-amplification bomb is rejected without OOM', () => {
  // §5 Step 3's real vector is *single-level* amplification: one 100KB entity times
  // 20,000 references is a 160KB document that blows V8's string limit in ~4ms.
  // `XMLValidator.validate()` returns true on it, so the DOCTYPE scan is the defence.
  const payload = 'A'.repeat(100 * 1024);
  const bomb =
    `<!DOCTYPE rss [<!ENTITY a "${payload}">]>` +
    '<rss version="2.0"><channel><title>' +
    '&a;'.repeat(20000) +
    '</title></channel></rss>';

  assert.deepEqual(parseFeed(bomb), { ok: false, reason: 'feed_invalid' });
});

test('a post about DOCTYPE inside CDATA is not mistaken for a DOCTYPE', () => {
  // §5 Step 3: exclude CDATA so a post *about* HTML doesn't false-positive.
  const feed =
    '<rss version="2.0"><channel><title>HTML notes</title>' +
    '<link>https://a.example/</link>' +
    '<item><title>Doctypes</title>' +
    '<description><![CDATA[Start every page with <!DOCTYPE html> and never ' +
    'declare an <!ENTITY>.]]></description></item></channel></rss>';

  assert.equal(parseFeed(feed).ok, true, JSON.stringify(parseFeed(feed)));
});

test('`<title>2026</title>` stays a string and is not type-coerced to a number', () => {
  // §5 Step 3: with the default `parseTagValue`, a blog legitimately called "2024"
  // becomes the number 2024 and crashes `title.trim()` with "not a function", while
  // `<title>true</title>` becomes a boolean bound for a `TEXT NOT NULL` column.
  const numeric = parseFeed(
    '<rss version="2.0"><channel><title>2026</title>' +
      '<link>https://y.example/</link></channel></rss>',
  );
  assert.equal(numeric.ok, true);
  assert.equal(numeric.title, '2026');
  assert.equal(typeof numeric.title, 'string');

  const boolean = parseFeed(
    '<rss version="2.0"><channel><title>true</title>' +
      '<link>https://y.example/</link></channel></rss>',
  );
  assert.equal(boolean.title, 'true');
  assert.equal(typeof boolean.title, 'string');
});

test('decodes both named and numeric entities in a title', () => {
  // §5 Step 3's measured table: only `processEntities` AND `htmlEntities` together
  // produce "Rock & Roll ’n Café" — either alone leaves `&#233;` in every subscriber's
  // OPML, and `processEntities: false` stores `&amp;` which §7 re-escapes to `&amp;amp;`.
  const result = parseFeed(
    '<rss version="2.0"><channel>' +
      '<title>Rock &amp; Roll &#8217;n Caf&#233;</title>' +
      '<link>https://z.example/</link></channel></rss>',
  );

  assert.equal(result.title, 'Rock & Roll ’n Café');
});

test('a channel with exactly one `<item>` and no `<link>` is accepted, not crashed on', () => {
  // §5 Step 3: singular nodes come back as objects, so `item.length` is `undefined`
  // without `asArray()`. A `link` OR at least one `item` satisfies the gate.
  const result = parseFeed(
    '<rss version="2.0"><channel><title>Brand new</title>' +
      '<item><title>Hello world</title></item></channel></rss>',
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.channelLink, null);
});

test('a channel with neither `<link>` nor any `<item>` is `feed_invalid`', () => {
  const result = parseFeed(
    '<rss version="2.0"><channel><title>Empty</title></channel></rss>',
  );

  assert.deepEqual(result, { ok: false, reason: 'feed_invalid' });
});

test('two `<channel>` elements are `feed_invalid`', () => {
  const result = parseFeed(
    '<rss version="2.0">' +
      '<channel><title>One</title><link>https://a.example/</link></channel>' +
      '<channel><title>Two</title><link>https://b.example/</link></channel>' +
      '</rss>',
  );

  assert.deepEqual(result, { ok: false, reason: 'feed_invalid' });
});

test('detects the source namespace on scripting.com, declared as `xmlns:source`', () => {
  // Verified live: scripting.com/rss.xml declares
  // `xmlns:source="https://source.scripting.com/"` on the root `<rss>`.
  const result = parseFeed(fixture('scripting-rss.xml'));

  assert.equal(result.features.has_source_ns, true);
});

test('a plain WordPress feed does not score `has_source_ns`', () => {
  const result = parseFeed(fixture('wordpress-feed.xml'));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.features.has_source_ns, false);
});

test('`xmlns:src=` bound to the source namespace still scores `has_source_ns`', () => {
  // §5 Step 6: with `removeNSPrefix: false` the parser does no namespace resolution,
  // so prefixes are literal strings. A publisher who declares `xmlns:src=` and writes
  // `<src:cloud>` is spec-identical and must not score false — scan ALL `@_xmlns:*`
  // attributes, then look for the prefix that is actually bound.
  const feed =
    '<rss version="2.0" xmlns:src="http://source.scripting.com">' +
    '<channel><title>Prefix agnostic</title><link>https://p.example/</link>' +
    '<src:localTime>2026-07-29</src:localTime></channel></rss>';

  const result = parseFeed(feed);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.features.has_source_ns, true);
  assert.equal(result.features.source_ns_prefix, 'src');
});

test('a namespace on a look-alike host does not score `has_source_ns`', () => {
  const feed =
    '<rss version="2.0" xmlns:source="https://source.scripting.com.evil.example/">' +
    '<channel><title>Look-alike</title><link>https://q.example/</link></channel></rss>';

  assert.equal(parseFeed(feed).features.has_source_ns, false);
});

test('detects the `<cloud>` element on scripting.com and keeps all five attributes', () => {
  // §5 Step 6: the spec defines five required attributes; store all five so a future
  // rssCloud registrar doesn't have to re-crawl every feed. Real values from the feed:
  // <cloud domain="rpc.rsscloud.io" port="5337" path="/pleaseNotify"
  //        registerProcedure="" protocol="http-post" />
  const { features } = parseFeed(fixture('scripting-rss.xml'));

  assert.equal(features.has_rsscloud, true);
  assert.equal(features.rsscloud_style, 'element');
  assert.deepEqual(features.cloud, {
    domain: 'rpc.rsscloud.io',
    port: '5337',
    path: '/pleaseNotify',
    registerProcedure: '',
    protocol: 'http-post',
  });
});

test('detects `<source:cloud>`, whose value is the URL and which has no attributes', () => {
  // §5 Step 6, quoting the spec: "The `<source:cloud>` element has no attributes and
  // its value is the URL of the cloud server." Hand-written, as §5 Step 6 records:
  // scripting.com carries `<cloud>` and zero `source:cloud` elements today.
  const feed =
    '<rss version="2.0" xmlns:source="https://source.scripting.com/">' +
    '<channel><title>Source style</title><link>https://s.example/</link>' +
    '<source:cloud>https://rpc.rsscloud.io/pleaseNotify</source:cloud>' +
    '</channel></rss>';

  const { features } = parseFeed(feed);

  assert.equal(features.has_rsscloud, true);
  assert.equal(features.rsscloud_style, 'source');
  assert.equal(features.cloud_url, 'https://rpc.rsscloud.io/pleaseNotify');
});

test('both cloud forms together record `both`', () => {
  const feed =
    '<rss version="2.0" xmlns:source="https://source.scripting.com/">' +
    '<channel><title>Transitional</title><link>https://s.example/</link>' +
    '<cloud domain="rpc.rsscloud.io" port="5337" path="/pleaseNotify" ' +
    'registerProcedure="" protocol="http-post"/>' +
    '<source:cloud>https://rpc.rsscloud.io/pleaseNotify</source:cloud>' +
    '</channel></rss>';

  const { features } = parseFeed(feed);

  assert.equal(features.rsscloud_style, 'both');
});

test('a feed with no cloud at all records no style', () => {
  const { features } = parseFeed(fixture('wordpress-feed.xml'));

  assert.equal(features.has_rsscloud, false);
  assert.equal(features.rsscloud_style, null);
});

test('caps title at 200 and description at 500 characters at ingest', () => {
  // §7: nothing else bounds these — they come verbatim from a 5 MB feed into
  // unbounded TEXT columns, so a 1 MB title bloats the OPML for every reader and
  // wrecks the /sites layout for everyone.
  const feed =
    '<rss version="2.0"><channel>' +
    `<title>${'t'.repeat(5000)}</title>` +
    `<description>${'d'.repeat(5000)}</description>` +
    '<link>https://long.example/</link></channel></rss>';

  const result = parseFeed(feed);

  assert.equal(result.title.length, 200);
  assert.equal(result.description.length, 500);
});

test('strips lone surrogates, C0/C1 controls and bidi overrides from the title', () => {
  // §7: a lone surrogate (U+D800–DFFF) or U+FFFE/U+FFFF is not a legal XML 1.0
  // character, so one such member makes /subscriptions.opml NOT WELL-FORMED for every
  // subscriber until an admin notices — a whole-directory denial of service from a
  // single submission.
  const hostile = `Evil${'\u{D800}'}${'\u{202E}'}Blog${'\u{FFFE}'}${'\u{0007}'}${'\u{0085}'}`;
  const feed =
    '<rss version="2.0"><channel>' +
    `<title>${hostile}</title>` +
    '<link>https://hostile.example/</link></channel></rss>';

  assert.equal(parseFeed(feed).title, 'EvilBlog');

  // Tab and newline are legal XML 1.0 characters and legitimate in wrapped titles,
  // and an astral-plane emoji is a well-formed surrogate *pair* that must survive.
  const kept = parseFeed(
    '<rss version="2.0"><channel><title>Two\tWords\nHere \u{1F600}</title>' +
      '<link>https://w.example/</link></channel></rss>',
  );
  assert.equal(kept.title, 'Two\tWords\nHere \u{1F600}');
});

test('an honest 50-item feed with 2000+ entity references still parses', () => {
  // Real regression, found by running `pnpm verify http://scripting.com/` against the
  // live site: fast-xml-parser 4.5.7's DEFAULT `maxTotalExpansions` is 1000, and the real
  // scripting.com feed contains 2193 entity references (700 `&lt;`, 700 `&gt;`, 554
  // `&quot;`, 234 `&#10;`, 5 `&amp;`) across its 50 items. `parse()` threw
  // "Entity expansion limit exceeded: 1020 > 1000", the try/catch mapped it to
  // `feed_invalid`, and the single most likely high-profile member of an RSS webring
  // could not join. Every full-content WordPress feed hits this too.
  const result = parseFeed(fixture('scripting-rss-full.xml'));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.title, 'Scripting News');
  assert.equal(result.features.has_source_ns, true);
  assert.equal(result.features.rsscloud_style, 'element');
});
