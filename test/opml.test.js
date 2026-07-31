/**
 * Plan §11 `opml.test.js`. Three seams: the OPML document, the ETag/304 contract,
 * and (in `sites.test.js`) the human page.
 *
 * Well-formedness is asserted by **re-parsing** with fast-xml-parser, never by
 * eyeballing the string — §7 makes the escaper an admin-escalation surface (the
 * document is served as `text/xml`, which browsers render), and a hostile title
 * that makes the document non-well-formed breaks it for *every* subscriber.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { createApp } from '../src/app.js';
import { renderFeed } from '../src/blog/feed.js';
import { createDb } from '../src/db/index.js';
import { seedSelfListing } from '../src/db/seed.js';
import { createOpmlDocument, renderOpml } from '../src/lib/opml.js';
import { parseFeed } from '../src/verify/feed.js';

// The rssCloud settings are `config.js`'s defaults. They matter here because the
// self-listing seed now derives its feature flags by rendering `/feed.xml` and
// parsing it — see the "Member #1" tests below.
const config = {
  siteUrl: 'https://iheartrss.com/',
  rsscloudDomain: 'rpc.rsscloud.io',
  rsscloudPort: 80,
  rsscloudPath: '/pleaseNotify',
  rsscloudProtocol: 'http-post',
};

function outline(overrides = {}) {
  return {
    title: 'Scripting News',
    description: 'Dave Winer, OG blogger',
    feed_url: 'http://scripting.com/rss.xml',
    url: 'http://scripting.com/',
    ...overrides,
  };
}

/** Re-parse and fail loudly with the offending document if it is not well-formed. */
function parse(xml) {
  const valid = XMLValidator.validate(xml);
  assert.equal(valid, true, `not well-formed: ${JSON.stringify(valid)}`);

  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseAttributeValue: false,
  }).parse(xml);
}

test('renderOpml emits §7’s OPML 2.0 structure', () => {
  const xml = renderOpml({
    config,
    outlines: [outline()],
    dateModified: new Date('2026-07-29T14:00:00Z'),
  });

  const doc = parse(xml);

  assert.equal(doc.opml['@version'], '2.0');
  assert.equal(doc.opml.head.title, 'I ♥ RSS');
  assert.equal(doc.opml.head.ownerName, 'iheartrss.com');
  assert.equal(doc.opml.head.ownerId, 'https://iheartrss.com/');
  assert.equal(doc.opml.head.docs, 'http://opml.org/spec2.opml');
  assert.equal(doc.opml.head.dateModified, 'Wed, 29 Jul 2026 14:00:00 GMT');

  const only = doc.opml.body.outline;
  assert.equal(only['@type'], 'rss');
  // §7: the spec enumerates RSS1 / RSS / scriptingNews. `RSS2` is non-canonical.
  assert.equal(only['@version'], 'RSS');
  // Both, always: OPML 2.0 requires `text`, older readers look for `title`.
  assert.equal(only['@text'], 'Scripting News');
  assert.equal(only['@title'], 'Scripting News');
  assert.equal(only['@description'], 'Dave Winer, OG blogger');
  assert.equal(only['@xmlUrl'], 'http://scripting.com/rss.xml');
  assert.equal(only['@htmlUrl'], 'http://scripting.com/');
});

test('the head carries `source:cloud`, in a declared `source:` namespace', () => {
  const doc = parse(
    renderOpml({ config, outlines: [outline()], dateModified: new Date(0) }),
  );

  // The prefix is worthless undeclared — a consumer matching on the namespace URI,
  // which is the correct way to read either of our documents, would see nothing.
  assert.equal(doc.opml['@xmlns:source'], 'https://source.scripting.com/');
  assert.equal(doc.opml.head['source:cloud'], 'https://rpc.rsscloud.io/pleaseNotify');

  // OPML 2.0 enumerates what `<head>` may contain and `cloud` is not in it, so the
  // `source:` form is the whole of what this document can say. No bare `<cloud>`.
  assert.equal(doc.opml.head.cloud, undefined);
});

test('the OPML and the feed can never advertise different cloud servers', () => {
  // Both build the URL from RSSCLOUD_DOMAIN + RSSCLOUD_PATH rather than carrying
  // their own copy, which is what makes drift impossible rather than merely unlikely.
  const elsewhere = {
    ...config,
    rsscloudDomain: 'cloud.example',
    rsscloudPath: '/notify',
  };

  const opml = parse(
    renderOpml({ config: elsewhere, outlines: [], dateModified: new Date(0) }),
  );
  const feed = parse(renderFeed({ config: elsewhere }));

  assert.equal(opml.opml.head['source:cloud'], 'https://cloud.example/notify');
  assert.equal(feed.rss.channel['source:cloud'], 'https://cloud.example/notify');
});

/**
 * §7/§11's five hostile fixtures. Every one of them is a whole-directory outage if
 * the document stops re-parsing, so they are asserted together against one document
 * — that is the shape a single bad submission actually takes.
 */
const HOSTILE = [
  ['a lone high surrogate', '\uD800 unpaired'],
  ['a lone low surrogate', 'trailing \uDFFF'],
  ['the non-characters U+FFFE / U+FFFF', 'noncharacters \uFFFE\uFFFF here'],
  [
    'an attribute break-out',
    '"><script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script>',
  ],
  ['a CDATA terminator', 'end of section ]]> and on'],
  ['an RTL override', 'gnp.exe\u202Egpj.txt'],
  ['C0 and C1 controls', '\u0007bell and \u0085next-line'],
  ['a 1 MB title', 'A'.repeat(1024 * 1024)],
];

test('every hostile fixture still produces a document that re-parses', () => {
  const outlines = HOSTILE.map(([label, hostile], i) =>
    outline({
      title: hostile,
      description: hostile,
      feed_url: `https://hostile.example/${i}/rss.xml?a=1&b=2`,
      url: `https://hostile.example/${i}/?q=<${label}>`,
    }),
  );

  const xml = renderOpml({ config, outlines, dateModified: new Date(0) });

  // The assertion that matters: it re-parses. `parse` validates first.
  const doc = parse(xml);
  assert.equal(doc.opml.body.outline.length, HOSTILE.length);

  // Not a raw `<script` anywhere in the serialised document — §7's escalation path
  // is a browser rendering this as text/xml.
  assert.doesNotMatch(xml, /<script/);
  assert.doesNotMatch(xml, /\]\]>/);

  // The lone surrogates are gone rather than passed through: a well-formedness
  // check on a string that still holds one would be the escaper's blind spot.
  assert.doesNotMatch(xml, /[\uD800-\uDFFF]/u);
  assert.doesNotMatch(xml, /\u202E/u);

  // `XMLValidator` accepts a bare `&` in an attribute value, so well-formedness
  // alone does not prove the escaper ran on it. Assert on the serialisation: every
  // `&` in the document must open an entity. \u00A77 calls out "including the `&` in
  // query strings" for exactly this reason.
  assert.doesNotMatch(xml, /&(?!(amp|lt|gt|quot|apos);)/);

  // Escaping is lossless, not stripping: the break-out attempt comes back through
  // the parser byte-for-byte as *data*. An implementation that deleted the quotes
  // and angle brackets would also re-parse, and would be silently corrupting
  // ordinary titles.
  const [, breakout] = HOSTILE[3];
  const attacked = doc.opml.body.outline[3];
  assert.equal(attacked['@title'], breakout);
  assert.equal(attacked['@text'], breakout);
  assert.equal(
    doc.opml.body.outline[0]['@xmlUrl'],
    'https://hostile.example/0/rss.xml?a=1&b=2',
  );
});

test('a 1 MB title is capped at render, not just at ingest', () => {
  const xml = renderOpml({
    config,
    outlines: [outline({ title: 'A'.repeat(1024 * 1024), description: null })],
    dateModified: new Date(0),
  });

  const { '@title': title } = parse(xml).opml.body.outline;
  // §7 caps titles at ~200 characters. A 1 MB title "bloats the OPML for every
  // reader"; the render-side cap is what protects rows written before the cap.
  assert.equal(title.length, 200);
});

test('a null description is omitted, never emitted as description=""', () => {
  const xml = renderOpml({
    config,
    outlines: [outline({ description: null })],
    dateModified: new Date(0),
  });

  assert.doesNotMatch(xml, /description=/);
  assert.equal(parse(xml).opml.body.outline['@description'], undefined);
});

test('dateCreated is the fixed launch date, not the render time', () => {
  const first = parse(
    renderOpml({ config, outlines: [outline()], dateModified: new Date(0) }),
  );
  const later = parse(
    renderOpml({
      config,
      outlines: [outline()],
      dateModified: new Date('2030-01-01T00:00:00Z'),
    }),
  );

  // §7: "the spec defines it as when the *document* was created, and emitting the
  // same value as dateModified makes it meaningless."
  assert.equal(first.opml.head.dateCreated, later.opml.head.dateCreated);
  assert.notEqual(first.opml.head.dateModified, later.opml.head.dateModified);
});

// ── The outline set (plan §7's query) ───────────────────────────────────────────

function member(overrides = {}) {
  const n = overrides.n ?? 1;
  return {
    url: `https://member${n}.example/`,
    submitted_url: `https://member${n}.example/`,
    host: `member${n}.example`,
    path: '/',
    feed_url: `https://member${n}.example/rss.xml`,
    title: `Member ${n}`,
    description: undefined,
    has_source_ns: false,
    has_rsscloud: false,
    rsscloud_style: undefined,
    cloud_json: undefined,
    ...overrides,
  };
}

function withDb() {
  const { db, queries } = createDb(':memory:');
  const setStatus = (id, status) =>
    db.prepare('UPDATE sites SET status = ? WHERE id = ?').run(status, id);
  return { db, queries, setStatus };
}

test('bot-blocked members stay in the outline set', () => {
  const { queries, setStatus } = withDb();

  const listed = queries.insertSite(member({ n: 1, title: 'Active' }));
  const failing = queries.insertSite(member({ n: 2, title: 'Failing' }));
  const blocked = queries.insertSite(member({ n: 3, title: 'Blocked' }));
  const dropped = queries.insertSite(member({ n: 4, title: 'Dropped' }));
  const hidden = queries.insertSite(member({ n: 5, title: 'Hidden' }));
  const removed = queries.insertSite(member({ n: 6, title: 'Removed' }));
  void listed;

  setStatus(failing, 'failing');
  setStatus(blocked, 'blocked');
  setStatus(dropped, 'dropped');
  setStatus(hidden, 'hidden');
  setStatus(removed, 'removed');

  const titles = queries.listOutlines().map((row) => row.title);

  // §7: "`blocked` must be in that list… Omitting `blocked` here silently reverts
  // that whole decision to a no-op." Ordered by title.
  assert.deepEqual(titles, ['Active', 'Blocked', 'Failing']);
});

test('a banned host is excluded by the backstop join even while its status is active', () => {
  const { queries, db } = withDb();

  queries.insertSite(member({ n: 1, title: 'Innocent' }));
  const spammer = queries.insertSite(
    member({
      n: 2,
      title: 'Spammer',
      url: 'https://mastodon.social/@spammer',
      submitted_url: 'https://mastodon.social/@spammer',
      host: 'mastodon.social',
      path: '/@spammer',
      feed_url: 'https://mastodon.social/@spammer.rss',
    }),
  );
  const neighbour = queries.insertSite(
    member({
      n: 3,
      title: 'Neighbour',
      url: 'https://mastodon.social/@innocent',
      submitted_url: 'https://mastodon.social/@innocent',
      host: 'mastodon.social',
      path: '/@innocent',
      feed_url: 'https://mastodon.social/@innocent.rss',
    }),
  );

  // Insert the ban directly, so the join is what excludes the row rather than
  // `insertBan`'s hide-the-matching-sites step. That is the backstop's whole job:
  // a ban can remove members without touching a `sites` row.
  db.prepare(
    'INSERT INTO banned_hosts (host, host_suffix, path_prefix, reason, created_at)' +
      " VALUES ('mastodon.social', '', '/@spammer', 'spam', '2026-07-29T00:00:00.000Z')",
  ).run();

  const titles = queries.listOutlines().map((row) => row.title);

  // §4's outer parentheses: without them the exact-host arm ignores `path_prefix`
  // and the path-scoped ban takes out the whole instance.
  assert.deepEqual(titles, ['Innocent', 'Neighbour']);
  assert.equal(queries.getSiteById(spammer).status, 'active');
  assert.equal(queries.getSiteById(neighbour).status, 'active');
});

test('a host_suffix ban excludes every subdomain from the outline set', () => {
  const { queries, db } = withDb();

  queries.insertSite(member({ n: 1, title: 'Innocent' }));
  queries.insertSite(
    member({
      n: 2,
      title: 'Flood A',
      url: 'https://a.attacker.example/',
      submitted_url: 'https://a.attacker.example/',
      host: 'a.attacker.example',
      feed_url: 'https://a.attacker.example/rss.xml',
    }),
  );
  // The negative case the leading dot exists for: a host that merely *ends with*
  // the banned string without being a subdomain of it.
  queries.insertSite(
    member({
      n: 3,
      title: 'Notattacker',
      url: 'https://notattacker.example/',
      submitted_url: 'https://notattacker.example/',
      host: 'notattacker.example',
      feed_url: 'https://notattacker.example/rss.xml',
    }),
  );

  db.prepare(
    'INSERT INTO banned_hosts (host, host_suffix, path_prefix, reason, created_at)' +
      " VALUES ('', '.attacker.example', '', 'flood', '2026-07-29T00:00:00.000Z')",
  ).run();

  assert.deepEqual(
    queries.listOutlines().map((row) => row.title),
    ['Innocent', 'Notattacker'],
  );
});

// ── §7's caching contract ───────────────────────────────────────────────────────
//
// "Two distinct steps, and conflating them is the trap": the write helpers bump
// `version` only; `outline_hash` and `updated_at` are recomputed lazily at render
// time, and `updated_at` advances only if the hash actually changed.

/**
 * `now` is injected and advances a minute per call: `Last-Modified` is an HTTP-date
 * with **one-second** resolution, so two renders inside the same second are
 * indistinguishable by timestamp on a real clock. That is a genuine property of the
 * protocol (and why the ETag, not the date, is the validator that has to move) — not
 * something to assert away with `>=`.
 */
function opmlService() {
  const ctx = withDb();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 6, 29, 14, 0, 0) + tick++ * 60_000);
  return { ...ctx, now, opml: createOpmlDocument({ queries: ctx.queries, config, now }) };
}

test('a write bumps version only — the hash and timestamp move at render time', () => {
  const { queries, opml } = opmlService();

  queries.insertSite(member({ n: 1 }));

  const beforeRender = queries.getDirectoryVersion();
  assert.equal(beforeRender.version > 0, true, 'insertSite must bump version');
  // Untouched by the write helper: still the seeded values from 001_init.sql.
  assert.equal(beforeRender.outline_hash, '');
  assert.equal(beforeRender.updated_at, '1970-01-01T00:00:00.000Z');

  opml.render();

  const afterRender = queries.getDirectoryVersion();
  assert.notEqual(afterRender.outline_hash, '');
  assert.notEqual(afterRender.updated_at, '1970-01-01T00:00:00.000Z');
});

test('the ETag changes when a site is hidden', () => {
  const { queries, opml } = opmlService();

  queries.insertSite(member({ n: 1 }));
  const doomed = queries.insertSite(member({ n: 2 }));
  const before = opml.render();
  assert.match(before.body, /Member 2/);

  queries.hideSite(doomed, 'takedown');
  const after = opml.render();

  // §11's named regression: without this the removal sits in FeedLand's cache and
  // both the "removed within a week" promise and §7's htmlUrl invariant are false.
  assert.notEqual(after.etag, before.etag);
  assert.doesNotMatch(after.body, /Member 2/);
  // A removal must move Last-Modified too — deriving it from max(last_verified_at)
  // is broken in exactly this direction.
  assert.equal(new Date(after.lastModified) > new Date(before.lastModified), true);
});

test('version churn from a last_checked_at-style write does not change the ETag', () => {
  const { queries, opml } = opmlService();

  const id = queries.insertSite(member({ n: 1 }));
  const before = opml.render();
  const versionBefore = queries.getDirectoryVersion().version;

  // §8 writes `last_checked_at` on every check (~480/day) and the blanket bump rule
  // moves `version`. `updateSite` is that write: same outline fields, new clock.
  queries.updateSite(id, member({ n: 1 }));
  assert.equal(
    queries.getDirectoryVersion().version > versionBefore,
    true,
    'the write must still bump version — it is the trigger to recompute',
  );

  const after = opml.render();

  // §7: hashing the whole rendered document would make this 100% cache-miss and
  // readers would report "blogroll updated" every hour forever.
  assert.equal(after.etag, before.etag);
  assert.equal(after.lastModified, before.lastModified);
  assert.equal(after.body, before.body);
});

test('a title change does move the ETag, since title is the ORDER BY key', () => {
  const { queries, opml } = opmlService();

  const id = queries.insertSite(member({ n: 1, title: 'Aardvark' }));
  queries.insertSite(member({ n: 2, title: 'Zebra' }));
  const before = opml.render();

  queries.updateSite(id, member({ n: 1, title: 'Zzz Renamed' }));
  const after = opml.render();

  // §4: "an enumerated list of OPML-relevant mutations WILL miss title/description
  // changes on re-verification, and title is the ORDER BY key."
  assert.notEqual(after.etag, before.etag);
  assert.match(after.body, /Zzz Renamed/);
});

test('the ETag is a quoted validator and the hash covers no head timestamp', () => {
  const { queries, opml } = opmlService();

  queries.insertSite(member({ n: 1 }));
  const { etag, body, lastModified } = opml.render();

  assert.match(etag, /^"[0-9a-f]{16,}"$/);
  // The document carries the timestamp; the validator must not be derived from it.
  assert.match(body, new RegExp(`<dateModified>${lastModified}</dateModified>`));
  assert.equal(etag.includes(String(new Date(lastModified).getTime())), false);
});

// ── The route (§6's table, §7's headers) ────────────────────────────────────────

function withApp() {
  const ctx = withDb();
  return { ...ctx, app: createApp({ config, db: ctx.db, queries: ctx.queries }) };
}

test('GET /subscriptions.opml serves a well-formed document as text/xml', async () => {
  const { app, queries } = withApp();
  queries.insertSite(member({ n: 1, title: 'Member One', description: 'A blog' }));

  const res = await app.request('/subscriptions.opml');

  assert.equal(res.status, 200);
  // §7: OPML has no registered MIME type; FeedLand — the primary consumer — serves
  // its own as text/xml, and matching the thing that has to read us wins.
  assert.equal(res.headers.get('content-type'), 'text/xml; charset=utf-8');
  // §7: served with nosniff, because the escaper's failure mode is a browser
  // executing script same-origin.
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('etag') ?? '', /^"[0-9a-f]+"$/);
  assert.equal(
    res.headers.get('last-modified'),
    new Date(res.headers.get('last-modified')).toUTCString(),
    'Last-Modified must be an HTTP-date',
  );

  const doc = parse(await res.text());
  assert.equal(doc.opml.body.outline['@title'], 'Member One');
});

test('a matching If-None-Match is answered with 304 and no body', async () => {
  const { app, queries } = withApp();
  queries.insertSite(member({ n: 1 }));

  const first = await app.request('/subscriptions.opml');
  const etag = first.headers.get('etag');

  const second = await app.request('/subscriptions.opml', {
    headers: { 'If-None-Match': etag },
  });

  assert.equal(second.status, 304);
  assert.equal(second.headers.get('etag'), etag);
  assert.equal(await second.text(), '');
});

test('a stale If-None-Match is answered with the new document', async () => {
  const { app, queries } = withApp();
  const doomed = queries.insertSite(member({ n: 1 }));

  const first = await app.request('/subscriptions.opml');
  queries.hideSite(doomed, 'takedown');

  const second = await app.request('/subscriptions.opml', {
    headers: { 'If-None-Match': first.headers.get('etag') },
  });

  // The regression §11 names, seen from the wire: a removal must not 304.
  assert.equal(second.status, 200);
  assert.notEqual(second.headers.get('etag'), first.headers.get('etag'));
});

test('If-None-Match is matched inside a list and through a weak prefix', async () => {
  const { app, queries } = withApp();
  queries.insertSite(member({ n: 1 }));

  const etag = (await app.request('/subscriptions.opml')).headers.get('etag');

  for (const header of [`"nope", ${etag}`, `W/${etag}`, '*']) {
    const res = await app.request('/subscriptions.opml', {
      headers: { 'If-None-Match': header },
    });
    assert.equal(res.status, 304, `If-None-Match: ${header}`);
  }
});

test('a fresh If-Modified-Since is answered with 304, for date-only clients', async () => {
  const { app, queries } = withApp();
  queries.insertSite(member({ n: 1 }));

  const first = await app.request('/subscriptions.opml');
  const lastModified = first.headers.get('last-modified');

  const fresh = await app.request('/subscriptions.opml', {
    headers: { 'If-Modified-Since': lastModified },
  });
  assert.equal(fresh.status, 304);

  const stale = await app.request('/subscriptions.opml', {
    headers: { 'If-Modified-Since': new Date(0).toUTCString() },
  });
  assert.equal(stale.status, 200);
});

test('/opml and /.well-known/recommendations.opml are 301s to the real path', async () => {
  const { app } = withApp();

  for (const path of ['/opml', '/.well-known/recommendations.opml']) {
    const res = await app.request(path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get('location'), '/subscriptions.opml', path);
  }
});

test('an empty directory still serves a parseable document', async () => {
  // §7: "An empty `<body>` is technically invalid … FeedLand emits an empty body
  // itself, so real consumers tolerate it — noted rather than solved."
  const { app } = withApp();
  const res = await app.request('/subscriptions.opml');

  assert.equal(res.status, 200);
  parse(await res.text());
});

// ── Discovery (§6.4) ────────────────────────────────────────────────────────────

test('every page advertises the OPML twice, as two separate <link> elements', async () => {
  const { app } = withApp();

  for (const path of ['/', '/sites', '/about', '/submit']) {
    const html = await (await app.request(path)).text();

    // §6.4: `rel="following"` is HyperTexting's recommended form, and
    // `type="text/x-opml"` makes it match on two independent selectors.
    assert.match(
      html,
      /<link rel="following" type="text\/x-opml" title="[^"]+" href="https:\/\/iheartrss\.com\/subscriptions\.opml">/,
      `${path} must advertise rel="following"`,
    );
    // The Winer-adjacent spelling, as scripting.com serves it.
    assert.match(
      html,
      /<link rel="blogroll" type="text\/xml" title="[^"]+" href="https:\/\/iheartrss\.com\/subscriptions\.opml">/,
      `${path} must advertise rel="blogroll"`,
    );

    // §6.4: kept as SEPARATE elements rather than one `rel="following blogroll"`.
    // HyperTexting treats rel as a token list; there is no guarantee the older
    // blogroll readers do, and a string-comparing parser would miss a combined value.
    assert.doesNotMatch(html, /rel="following blogroll"/);
    assert.doesNotMatch(html, /rel="blogroll following"/);
  }
});

test('the discovery links are absolute against SITE_URL, not hardcoded', async () => {
  const { db, queries } = withDb();
  const app = createApp({
    config: { siteUrl: 'https://staging.example.org/' },
    db,
    queries,
  });

  const html = await (await app.request('/sites')).text();
  assert.match(html, /href="https:\/\/staging\.example\.org\/subscriptions\.opml"/);
  assert.doesNotMatch(html, /iheartrss\.com\/subscriptions\.opml/);
});

test('our own feed points at the member OPML with <source:blogroll>', async () => {
  const { app } = withApp();
  const xml = await (await app.request('/feed.xml')).text();

  // §6.4: "the same element we detect on other people's feeds (§5 Step 6), pointed
  // at our member OPML." Deliberately withheld in phase 1 while the URL 404'd.
  assert.match(
    xml,
    /<source:blogroll>https:\/\/iheartrss\.com\/subscriptions\.opml<\/source:blogroll>/,
  );
  parse(xml);
});

// ── Member #1 (§12 phase 6) ─────────────────────────────────────────────────────

test('the self-listing seed is a direct INSERT, since /submit refuses it', async () => {
  const { db, queries } = withDb();
  const app = createApp({ config, db, queries });

  const inserted = seedSelfListing({ queries, config });
  assert.equal(inserted, true);

  const doc = parse(await (await app.request('/subscriptions.opml')).text());
  const only = doc.opml.body.outline;

  // §6.4/§12: seeded by direct INSERT because §5 Step 7 rejects any canonical host
  // in LINKBACK_HOSTS with `self_listing` — by design.
  assert.equal(only['@htmlUrl'], 'https://iheartrss.com/');
  assert.equal(only['@xmlUrl'], 'https://iheartrss.com/feed.xml');
  assert.equal(only['@title'], 'I ♥ RSS');
});

/**
 * Both sides of this are *derived*, never restated: the left from the seed, the
 * right from running our own renderer through our own validator. That is the point
 * — the seed used to assert `has_rsscloud: false` in a literal, which silently went
 * stale the moment the feed grew a `<cloud>`. Written this way, a feed that gains or
 * loses a feature moves this test and the seed together.
 */
test('the seeded row carries the features our own feed actually declares', () => {
  const { queries } = withDb();
  seedSelfListing({ queries, config });

  const parsed = parseFeed(renderFeed({ config, posts: [] }));
  assert.equal(parsed.ok, true, 'our own feed must satisfy our own validator');

  const row = queries.getSiteByUrl('https://iheartrss.com/');
  assert.equal(Boolean(row.has_source_ns), parsed.features.has_source_ns);
  assert.equal(Boolean(row.has_rsscloud), parsed.features.has_rsscloud);
  assert.equal(row.rsscloud_style, parsed.features.rsscloud_style ?? null);

  // An anchor from outside the code: production's /feed.xml carries both `<cloud>`
  // and `<source:cloud>`, so today those derived values are these.
  assert.equal(row.has_source_ns, 1);
  assert.equal(row.has_rsscloud, 1);
  assert.equal(row.rsscloud_style, 'both');
});

/**
 * The same class of bug as the feature flags, one field over. §8's `passColumns`
 * writes `title`/`description` straight from the parsed feed on any non-304 Pass, so
 * a hardcoded pair here is not "the value" — it is a value that survives exactly
 * until the first successful revalidation and then changes under the operator. Both
 * sides derived, for the same reason as above.
 */
test('the seeded row takes its title and description from our own channel', () => {
  const { queries } = withDb();
  seedSelfListing({ queries, config });

  const parsed = parseFeed(renderFeed({ config, posts: [] }));
  const row = queries.getSiteByUrl('https://iheartrss.com/');

  assert.equal(row.title, parsed.title);
  assert.equal(row.description, parsed.description);
});

/** The row the pre-rssCloud seed wrote, and what production is still serving. */
function staleSelfListing() {
  return {
    url: 'https://iheartrss.com/',
    submitted_url: 'https://iheartrss.com/',
    host: 'iheartrss.com',
    path: '/',
    feed_url: 'https://iheartrss.com/feed.xml',
    title: 'I ♥ RSS',
    description: 'A directory for people who love RSS.',
    has_source_ns: true,
    has_rsscloud: false,
    rsscloud_style: undefined,
    cloud_json: undefined,
  };
}

test('an existing self-listing whose features went stale is refreshed on boot', () => {
  const { db, queries } = withDb();
  const id = queries.insertSite(staleSelfListing());

  // The revalidation state machine owns these. A deploy must not look like a check.
  db.prepare(
    `UPDATE sites SET status = 'failing', failure_count = 2,
       last_checked_at = '2020-01-01T00:00:00.000Z',
       last_verified_at = '2020-01-02T00:00:00.000Z',
       created_at = '2019-01-01T00:00:00.000Z',
       feed_etag = 'W/"seeded"', feed_last_modified = 'Wed, 01 Jan 2020 00:00:00 GMT'
     WHERE id = ?`,
  ).run(id);

  const events = [];
  const refreshed = seedSelfListing({
    queries,
    config,
    log: (event) => events.push(event),
  });

  assert.equal(refreshed, true, 'a stale row is a write, not a no-op');
  assert.deepEqual(events, ['seed.self_listing_refreshed']);

  const row = queries.getSiteById(id);
  // Healed to what our feed actually declares — without waiting up to six days for
  // the §8 revalidation cadence to notice.
  assert.equal(row.has_rsscloud, 1);
  assert.equal(row.rsscloud_style, 'both');
  assert.equal(JSON.parse(row.cloud_json).cloud.domain, 'rpc.rsscloud.io');

  // Scope: features only. Everything below belongs to the revalidation state machine.
  assert.equal(row.status, 'failing');
  assert.equal(row.failure_count, 2);
  assert.equal(row.created_at, '2019-01-01T00:00:00.000Z');
  assert.equal(row.last_checked_at, '2020-01-01T00:00:00.000Z');
  assert.equal(row.last_verified_at, '2020-01-02T00:00:00.000Z');
  assert.equal(row.feed_etag, 'W/"seeded"');
  assert.equal(row.feed_last_modified, 'Wed, 01 Jan 2020 00:00:00 GMT');
});

test('seeding is idempotent, so every boot can run it', () => {
  const { queries } = withDb();

  assert.equal(seedSelfListing({ queries, config }), true);
  const afterFirst = queries.getDirectoryVersion().version;

  const events = [];
  const log = (event) => events.push(event);
  assert.equal(seedSelfListing({ queries, config, log }), false);
  assert.equal(seedSelfListing({ queries, config, log }), false);

  assert.equal(queries.countSites(), 1);
  // A no-op seed must not bump `version` either — otherwise every restart
  // invalidates every subscriber's cached copy for nothing.
  assert.equal(queries.getDirectoryVersion().version, afterFirst);
  // …and it must not log either: a refresh line on every restart is noise that
  // trains the operator to ignore the line that matters.
  assert.deepEqual(events, []);
});

test('the seed follows SITE_URL rather than hardcoding the domain', () => {
  const { queries } = withDb();
  seedSelfListing({ queries, config: { siteUrl: 'https://staging.example.org/' } });

  const row = queries.getSiteByUrl('https://staging.example.org/');
  assert.notEqual(row, undefined);
  assert.equal(row.host, 'staging.example.org');
  assert.equal(row.feed_url, 'https://staging.example.org/feed.xml');
  // Our own feed declares the namespace we look for (§6.4), so the row should say so.
  assert.equal(row.has_source_ns, 1);
});

test('a restart is invisible to caches: same outline set, same validator', () => {
  const { queries } = withDb();
  queries.insertSite(member({ n: 1 }));

  const first = createOpmlDocument({ queries, config }).render();
  // A second service over the same database is what a process restart looks like:
  // the in-process memo is empty, so `version` has "moved" and everything is
  // recomputed. §7 only lets `updated_at` advance when the hash differs, so a
  // restart must not tell every subscriber the blogroll changed.
  const afterRestart = createOpmlDocument({ queries, config }).render();

  assert.equal(afterRestart.etag, first.etag);
  assert.equal(afterRestart.lastModified, first.lastModified);
  assert.equal(afterRestart.body, first.body);
});
