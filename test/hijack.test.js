import test from 'node:test';
import assert from 'node:assert/strict';

import { createVerifier } from '../src/verify/index.js';
import { BADGE, CONFIG, FEED_TYPE, html, rss, withSites } from './helpers/sites.js';

// The two attacks §5 Step 4 is built around, as executable fixtures (§11's
// `hijack.test.js`). Every assertion here is the same one: **no attacker-controlled URL
// survives verification.** A wrong implementation passes most other tests in the suite.

/**
 * On a **successful** verification, neither the URL we would list nor the feed we would
 * publish may name an attacker host — those two values are the OPML's `htmlUrl` and
 * `xmlUrl`. A *rejected* submission may of course echo the submitted URL back in its
 * message; what matters there is that it produces no listing at all, which is
 * `ok === false`.
 */
function assertPublishedUrlsClean({ url, feedUrl }, attackerHost) {
  for (const value of [url, feedUrl]) {
    assert.equal(
      String(value).includes(attackerHost),
      false,
      `attacker host would reach the OPML: ${value}`,
    );
  }
}

test('(a) an attacker feed whose `<channel><link>` targets its own steal page is refused', async () => {
  // §5 Step 4, "provenance has to be mutual": this attack needs no victim-origin write
  // at all, only attacker-controlled hosting.
  //
  //   attacker.example/a.html      badge + <link rel=alternate href="/a.xml">
  //   attacker.example/a.xml       valid RSS, <channel><link>…/steal.html</link>
  //   attacker.example/steal.html  badge + <link rel=alternate href="victim.com/feed.xml">
  //
  // Canonical resolves to /steal.html; re-discovery there yields the VICTIM'S REAL FEED,
  // which fetches and validates, and the badge is present because the attacker put it
  // there. Without the mutual check the row becomes
  // xmlUrl=victim.com/feed.xml htmlUrl=attacker.example/steal.html in every subscriber's
  // reader, and the victim is silently delisted by one unauthenticated request.
  await withSites(
    (url) => ({
      'attacker.example': {
        '/a.html': { body: html({ feedHref: '/a.xml' }) },
        '/a.xml': {
          type: FEED_TYPE,
          body: rss({
            title: 'Attacker',
            channelLink: url('attacker.example', '/steal.html'),
          }),
        },
        '/steal.html': {
          body: html({ feedHref: url('victim.com', '/feed.xml') }),
        },
      },
      'victim.com': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Victim blog', channelLink: url('victim.com', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('attacker.example', '/a.html'));

      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.reason, 'feed_not_owned_by_canonical');
      // The victim's feed must not come back paired with the attacker's page.
      assert.notEqual(result.url, url('victim.com', '/feed.xml'));
    },
  );
});

test('(b) an attacker page declaring the VICTIM\'S channel-link-less feed is refused', async () => {
  // §5 Step 4: "the channel-link-less case is the hole in this rule, so it gets its own
  // row". The victim's feed legitimately omits `<channel><link>`; the attacker publishes
  // a page with the badge and a `<link rel="alternate">` naming the victim's feed. No
  // channel link → canonical falls back to the submitted URL → canonical == submitted →
  // no re-discovery → no mutual check → badge present. The row would be the attacker's
  // htmlUrl paired with the victim's xmlUrl, and the victim later refused their own feed.
  await withSites(
    (url) => ({
      'attacker.example': {
        '/a.html': { body: html({ feedHref: url('victim.com', '/feed.xml') }) },
      },
      'victim.com': {
        '/feed.xml': {
          type: FEED_TYPE,
          // Legitimately omits `<channel><link>`; Step 3 accepts `link` OR items.
          body: rss({ title: 'Victim blog', channelLink: null }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('attacker.example', '/a.html'));

      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.reason, 'feed_not_owned_by_canonical');
      // The pairing the attack was after — attacker page + victim feed — is exactly
      // what the rejection names, and it is rejected rather than published.
      assert.equal(result.url, url('attacker.example', '/a.html'));
      assert.equal(result.feedUrl, url('victim.com', '/feed.xml'));
    },
  );
});

test('(c) a channel-link-less canonical feed hosted off the canonical host is refused', async () => {
  // §11's extra hijack row: same hole, reached through a canonical hop rather than the
  // fallback, so an implementation that only guards one path still fails here.
  await withSites(
    (url) => ({
      'attacker.example': {
        '/a.html': { body: html({ feedHref: '/a.xml' }) },
        '/a.xml': {
          type: FEED_TYPE,
          body: rss({
            title: 'Attacker',
            channelLink: url('attacker.example', '/steal.html'),
          }),
        },
        '/steal.html': { body: html({ feedHref: url('victim.com', '/feed.xml') }) },
      },
      'victim.com': {
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Victim blog', channelLink: null }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('attacker.example', '/a.html'));

      assert.equal(result.reason, 'feed_not_owned_by_canonical');
    },
  );
});

test('an attacker naming a victim as canonical only re-verifies the victim', async () => {
  // §5 Step 4's "why this replaced a domain-comparison guard": walk the same attack —
  // submit attacker.example with a feed whose `<channel><link>` is the victim. We fetch
  // the victim, discover ITS feed, and record that. The row is the victim's real site
  // paired with the victim's real feed — no hijack, just a redundant re-verification of
  // a site that already consented. Nothing an attacker controls reaches the OPML.
  await withSites(
    (url) => ({
      'attacker.example': {
        '/': { body: html({ feedHref: '/a.xml' }) },
        '/a.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Attacker', channelLink: url('victim.com', '/') }),
        },
      },
      'victim.com': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Victim blog', channelLink: url('victim.com', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('attacker.example', '/'));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.url, url('victim.com', '/'));
      assert.equal(result.feedUrl, url('victim.com', '/feed.xml'));
      assert.equal(result.title, 'Victim blog');
      assertPublishedUrlsClean(result, 'attacker.example');
    },
  );
});

test('an attacker page on the victim\'s own origin cannot repoint the feed', async () => {
  // §5 Step 4's "why there is no fallback": the attacker uploads one valid RSS file to a
  // writable path on the victim's origin, whose `<channel><link>` is the victim's
  // homepage, and submits it directly. Canonical origin == submitted origin, feed origin
  // == canonical origin, badge present on the victim's real homepage — every
  // origin-based condition satisfied. The absolute rule stops it: the victim's homepage
  // declares its OWN feed, so that is the feed recorded, and the attacker's file is
  // never published.
  await withSites(
    (url) => ({
      'victim.com': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Victim blog', channelLink: url('victim.com', '/') }),
        },
        '/uploads/evil.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Attacker content', channelLink: url('victim.com', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('victim.com', '/uploads/evil.xml'));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.url, url('victim.com', '/'));
      assert.equal(
        result.feedUrl,
        url('victim.com', '/feed.xml'),
        'the canonical page must publish the feed IT declares, not the uploaded one',
      );
      assert.equal(result.title, 'Victim blog');
    },
  );
});

test('the badge sitting only in a `<code>` block on the canonical page is no consent', async () => {
  await withSites(
    (url) => ({
      'example.com': {
        '/': {
          body:
            '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml">' +
            '</head><body><p>Copy this: <code>' +
            BADGE.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
            '</code></p></body></html>',
        },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'No badge yet', channelLink: url('example.com', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('example.com', '/'));

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'no_linkback');
    },
  );
});
