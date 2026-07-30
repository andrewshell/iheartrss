import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCanonicalUrl, checkFeedProvenance } from '../src/verify/canonical.js';

// Plan §5 Step 4 — the canonical URL and the ABSOLUTE mutual-provenance rule, per
// §11's `canonical.test.js`.

test("the feed's `<channel><link>` becomes the canonical URL, normalized", () => {
  // §5 Step 4: this is the URL the OPML's `htmlUrl` will point at, so it's the URL
  // that must carry the link-back. Someone can submit `example.com/blog/` while their
  // feed's channel link is `example.com/` — the OPML sends readers to the root.
  const result = resolveCanonicalUrl({
    submittedUrl: 'https://example.com/blog/',
    channelLink: 'https://EXAMPLE.com?utm_source=feed#top',
    submittedResourceWasFeed: false,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.canonicalUrl, 'https://example.com/');
});

test('a missing channel link falls back to the submitted URL', () => {
  // §5 Step 4.1: a feed with no channel link is unusual but not disqualifying.
  const result = resolveCanonicalUrl({
    submittedUrl: 'https://example.com/blog/',
    channelLink: null,
    submittedResourceWasFeed: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.canonicalUrl, 'https://example.com/blog/');
  assert.equal(result.hasChannelLink, false);
});

test('a submitted FEED with no channel link is `no_channel_link`, never canonical', () => {
  // §5 Step 4.1's carve-out: a resource that parsed as a feed must never become the
  // canonical *page*, or `htmlUrl` sends subscribers to raw XML and Step 5 runs an
  // HTML anchor parser over an RSS document.
  const result = resolveCanonicalUrl({
    submittedUrl: 'https://example.com/feed.xml',
    channelLink: null,
    submittedResourceWasFeed: true,
  });

  assert.deepEqual(result, { ok: false, reason: 'no_channel_link' });
});

test('an unparseable channel link is treated as missing, not as a URL', () => {
  const result = resolveCanonicalUrl({
    submittedUrl: 'https://example.com/blog/',
    channelLink: 'javascript:alert(1)',
    submittedResourceWasFeed: false,
  });

  assert.equal(result.canonicalUrl, 'https://example.com/blog/');
  assert.equal(result.hasChannelLink, false);
});

test('provenance holds when the canonical feed claims the canonical host back', () => {
  // Row 1 of §5 Step 4's table. Both directions: the canonical page declares the feed,
  // and the feed's `<channel><link>` resolves to the canonical host.
  const result = checkFeedProvenance({
    canonicalUrl: 'https://example.com/',
    feedUrl: 'https://example.com/feed.xml',
    feedChannelLink: 'https://example.com/',
  });

  assert.deepEqual(result, { ok: true });
});

test('provenance holds for an off-origin feed whose channel link is still the blog', () => {
  // §5 Step 4: honest cases pass — Substack custom domains, multi-author WordPress and
  // even FeedBurner/Feedpress-hosted feeds, because the *channel link* is the blog even
  // when the feed is served off-origin.
  assert.deepEqual(
    checkFeedProvenance({
      canonicalUrl: 'https://www.astralcodexten.com/',
      feedUrl: 'https://astralcodexten.substack.com/feed',
      feedChannelLink: 'https://www.astralcodexten.com',
    }),
    { ok: true },
  );
});

test('a canonical feed whose channel link names a DIFFERENT host is refused', () => {
  // Row 2. This is the second direction of the mutual check: a `<link rel="alternate">`
  // can name ANY URL on any host, so "the canonical page declares this feed" is only
  // half the property.
  const result = checkFeedProvenance({
    canonicalUrl: 'https://attacker.example/steal.html',
    feedUrl: 'https://victim.com/feed.xml',
    feedChannelLink: 'https://victim.com/',
  });

  assert.deepEqual(result, { ok: false, reason: 'feed_not_owned_by_canonical' });
});

test('a channel-link-less canonical feed is accepted only when self-hosted', () => {
  // Row 3 — the hole the rule would otherwise have: a feed with no `<channel><link>`
  // has nothing for the second direction to check, making it vacuous. Honest
  // hand-rolled feeds are same-host by construction.
  assert.deepEqual(
    checkFeedProvenance({
      canonicalUrl: 'https://example.com/',
      feedUrl: 'https://example.com/rss',
      feedChannelLink: null,
    }),
    { ok: true },
  );

  assert.deepEqual(
    checkFeedProvenance({
      canonicalUrl: 'https://attacker.example/a.html',
      feedUrl: 'https://victim.com/feed.xml',
      feedChannelLink: null,
    }),
    { ok: false, reason: 'feed_not_owned_by_canonical' },
  );
});

test('the multi-tenant shapes the old PSL guard failed on are strangers here', () => {
  // §5 Step 4's "why this replaced a domain-comparison guard": with tldts defaults,
  // `getDomain()` returns `github.io` for BOTH `evil.github.io` and `victim.github.io`,
  // so the old guard called them related. Host equality does not.
  for (const [attacker, victim] of [
    ['https://evil.github.io/', 'https://victim.github.io/'],
    ['https://evil.substack.com/', 'https://victim.substack.com/'],
    ['https://evil.pages.dev/', 'https://victim.pages.dev/'],
  ]) {
    assert.deepEqual(
      checkFeedProvenance({
        canonicalUrl: attacker,
        feedUrl: `${victim}feed.xml`,
        feedChannelLink: victim,
      }),
      { ok: false, reason: 'feed_not_owned_by_canonical' },
      attacker,
    );
  }
});
