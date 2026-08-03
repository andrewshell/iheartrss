import test from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/index.js';
import { createVerifier } from '../src/verify/index.js';
import { createPersister } from '../src/verify/persist.js';
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

test("(b) an attacker page declaring the VICTIM'S channel-link-less feed is refused", async () => {
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

test("an attacker page on the victim's own origin cannot repoint the feed", async () => {
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

// ── §5 Step 7: the incumbent re-check, and why it must fail closed ────────────
//
// `UNIQUE(feed_url)` makes identity the feed, which means a `feed_url` collision has
// to decide who owns the row. "Last party to declare a feed owns it" is the whole
// game if the move condition is written as `!declaresFeed(incumbent)`: "unreachable"
// is a COMMON state here — the whole `blocked` status exists because bot protection
// 403s us routinely — so an attacker just waits for, or induces, a window where the
// victim's host is momentarily 403-ing, rate-limiting or mid-deploy.
//
// Only a CONCLUSIVE 2xx fetch showing the incumbent no longer declares the feed
// permits the move. Every other outcome is `ambiguous_identity`.

/** An incumbent row owning `feedUrl` at `incumbentUrl`, plus a persister. */
async function withIncumbent({ incumbentUrl, feedUrl, safeFetch }, run) {
  const { db, queries } = createDb(':memory:');
  const persist = createPersister({
    queries,
    config: { ...CONFIG, maxListingsPerDomain: 5, maxNewListingsPerDay: 50 },
    safeFetch,
  });

  const seeded = await persist({
    ok: true,
    url: incumbentUrl,
    submittedUrl: incumbentUrl,
    feedUrl,
    title: 'Victim blog',
    features: { has_source_ns: false, has_rsscloud: false, rsscloud_style: null },
  });
  assert.equal(seeded.outcome, 'added');

  return run({ db, queries, persist, incumbentId: seeded.siteId });
}

/** A claim on `feedUrl` from a different canonical URL. */
function claim({ url, feedUrl }) {
  return {
    ok: true,
    url,
    submittedUrl: url,
    feedUrl,
    title: 'Mine now',
    features: { has_source_ns: false, has_rsscloud: false, rsscloud_style: null },
  };
}

test('a feed_url collision is ambiguous_identity while the incumbent still declares the feed', async () => {
  await withSites(
    (url) => ({
      'victim.com': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Victim blog', channelLink: url('victim.com', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const feedUrl = url('victim.com', '/feed.xml');

      await withIncumbent(
        { incumbentUrl: url('victim.com', '/'), feedUrl, safeFetch },
        async ({ db, persist, incumbentId }) => {
          const outcome = await persist(
            claim({ url: url('attacker.example', '/steal.html'), feedUrl }),
          );

          assert.equal(outcome.outcome, 'rejected');
          assert.equal(outcome.reason, 'ambiguous_identity');

          const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(incumbentId);
          assert.equal(row.url, url('victim.com', '/'), 'the row must not have moved');
          assert.equal(row.title, 'Victim blog');
          assert.equal(db.prepare('SELECT count(*) AS n FROM sites').get().n, 1);
        },
      );
    },
  );
});

test('an incumbent declaring the PRE-redirect spelling still holds its row', async () => {
  // `feed_url` is stored post-permanent-redirect (§5 Step 2), and a page goes on
  // declaring the spelling it always declared. An exact-URL-only test would read
  // "still mine, spelled the old way" as "no longer declares it" — and this gate
  // failing open is exactly how a row gets handed to someone else. The same-origin
  // arm is what catches it.
  //
  // This is the shared-host variant, and it is the only shape where the collision
  // branch is reachable at all: the feed carries NO `<channel><link>`, so the
  // canonical URL falls back to the attacker's own page instead of resolving onto the
  // victim's. With a channel link, the attacker's submission simply refreshes the
  // victim's row and never gets here.
  await withSites(
    () => ({
      'victim.com': {
        '/': { body: html({ feedHref: '/feed' }) },
        '/feed': { status: 301, location: '/feed/', body: '' },
        '/feed/': {
          type: FEED_TYPE,
          body: rss({ title: 'Victim blog', channelLink: null }),
        },
        // The attacker's page, on the victim's own origin — it passes every
        // host-level check in Step 4 by construction.
        '/~evil/': { body: html({ feedHref: '/feed' }) },
      },
    }),
    async ({ url, safeFetch }) => {
      const feedUrl = url('victim.com', '/feed/');

      await withIncumbent(
        { incumbentUrl: url('victim.com', '/'), feedUrl, safeFetch },
        async ({ db, persist, incumbentId }) => {
          const outcome = await persist(
            claim({ url: url('victim.com', '/~evil/'), feedUrl }),
          );

          assert.equal(outcome.outcome, 'rejected');
          assert.equal(outcome.reason, 'ambiguous_identity');
          assert.equal(outcome.detail.why, 'still_declares_feed');
          assert.equal(
            db.prepare('SELECT url FROM sites WHERE id = ?').get(incumbentId).url,
            url('victim.com', '/'),
          );
        },
      );
    },
  );
});

test('an unreachable incumbent fails CLOSED, on every unreachable shape there is', async () => {
  // A 403 (bot protection — the reason `blocked` exists), a 404, a 500 and a
  // connection that never answers. An implementer who writes the condition as
  // "the incumbent no longer declares the feed" hands the row over on all four.
  const shapes = {
    '/blocked': { status: 403, body: 'denied' },
    '/gone': { status: 404, body: 'not found' },
    '/broken': { status: 500, body: 'oops' },
    '/hangs': (req, res) => {
      // Answers well past CONFIG.fetchTimeoutMs, and never during the test.
      setTimeout(() => res.end('too late'), 60_000).unref();
    },
  };

  for (const [path, route] of Object.entries(shapes)) {
    await withSites(
      () => ({ 'victim.com': { [path]: route } }),
      async ({ url, safeFetch }) => {
        const feedUrl = url('victim.com', '/feed.xml');

        await withIncumbent(
          { incumbentUrl: url('victim.com', path), feedUrl, safeFetch },
          async ({ db, persist, incumbentId }) => {
            const outcome = await persist(
              claim({ url: url('attacker.example', '/steal.html'), feedUrl }),
            );

            assert.equal(outcome.outcome, 'rejected', path);
            assert.equal(outcome.reason, 'ambiguous_identity', path);
            assert.equal(
              db.prepare('SELECT url FROM sites WHERE id = ?').get(incumbentId).url,
              url('victim.com', path),
              `${path}: an unreachable incumbent must keep its row`,
            );
          },
        );
      },
    );
  }
});

test('an exhausted budget is ambiguous_identity, not a free move', async () => {
  await withSites(
    (_url) => ({
      'victim.com': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
      },
    }),
    async ({ url, safeFetch }) => {
      const feedUrl = url('victim.com', '/feed.xml');

      await withIncumbent(
        { incumbentUrl: url('victim.com', '/'), feedUrl, safeFetch },
        async ({ db, persist, incumbentId }) => {
          // The submission's shared budget is already spent by the time Step 7 runs
          // — the realistic case after 4 slow fetches, and an attacker can arrange it.
          const outcome = await persist(
            claim({ url: url('attacker.example', '/steal.html'), feedUrl }),
            { budget: { deadline: Date.now() - 1, signal: AbortSignal.abort() } },
          );

          assert.equal(outcome.outcome, 'rejected');
          assert.equal(outcome.reason, 'ambiguous_identity');
          assert.equal(
            db.prepare('SELECT url FROM sites WHERE id = ?').get(incumbentId).url,
            url('victim.com', '/'),
          );
        },
      );
    },
  );
});

test('a member who moved their channel link is not stranded on a dead htmlUrl', async () => {
  // The legitimate case the rule exists for, and the mirror image of the
  // `feed_conflict` mistake §5 Step 7 rejects: a member who moved
  // `<channel><link>` from `/` to `/blog/` genuinely has an old page that no longer
  // points at the feed. If identity is the feed, that member must not keep an
  // `htmlUrl` pointing at a page that is no longer theirs.
  await withSites(
    () => ({
      'alice.example': {
        // 2xx, and conclusively no longer declaring the feed.
        '/': { body: '<html><head><title>Moved</title></head><body></body></html>' },
      },
    }),
    async ({ url, safeFetch }) => {
      const feedUrl = url('alice.example', '/feed.xml');

      await withIncumbent(
        { incumbentUrl: url('alice.example', '/'), feedUrl, safeFetch },
        async ({ db, persist, incumbentId }) => {
          const outcome = await persist(
            claim({ url: url('alice.example', '/blog/'), feedUrl }),
          );

          assert.equal(outcome.outcome, 'updated');
          assert.equal(outcome.siteId, incumbentId);

          const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(incumbentId);
          assert.equal(row.url, url('alice.example', '/blog/'));
          assert.equal(row.path, '/blog/');
          assert.equal(db.prepare('SELECT count(*) AS n FROM sites').get().n, 1);
        },
      );
    },
  );
});

test('url matching one row while feed_url matches another is ambiguous_identity', async () => {
  // §5 Step 7: "either a genuine mess or an attack, and it needs eyes."
  await withSites(
    () => ({ 'a.example': { '/': { body: html({ feedHref: '/feed.xml' }) } } }),
    async ({ url, safeFetch }) => {
      await withIncumbent(
        {
          incumbentUrl: url('a.example', '/'),
          feedUrl: url('a.example', '/feed.xml'),
          safeFetch,
        },
        async ({ db, persist }) => {
          const second = await persist(
            claim({ url: url('b.example', '/'), feedUrl: url('b.example', '/feed.xml') }),
          );
          assert.equal(second.outcome, 'added');

          // Now claim a.example/ (row 1's url) with b.example's feed (row 2's feed).
          const outcome = await persist(
            claim({ url: url('a.example', '/'), feedUrl: url('b.example', '/feed.xml') }),
          );

          assert.equal(outcome.outcome, 'rejected');
          assert.equal(outcome.reason, 'ambiguous_identity');

          const rows = db.prepare('SELECT url, feed_url FROM sites ORDER BY id').all();
          assert.equal(rows[0].url, url('a.example', '/'));
          assert.equal(rows[0].feed_url, url('a.example', '/feed.xml'));
          assert.equal(rows[1].feed_url, url('b.example', '/feed.xml'));
        },
      );
    },
  );
});
