import test from 'node:test';
import assert from 'node:assert/strict';

import { createVerifier } from '../src/verify/index.js';
import { CONFIG, FEED_TYPE, html, rss, withSites } from './helpers/sites.js';

// Plan §5 Steps 0–6 end to end, against a local fixture HTTP server (§11's
// `verify.test.js`). Persistence is Step 7 and belongs to phase 5, so nothing here
// touches the database.

test('verifies a site whose feed, canonical page and link-back all agree', async () => {
  await withSites(
    (url) => ({
      'example.com': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'A blog', channelLink: url('example.com', '/') }),
        },
      },
    }),
    async ({ url, safeFetch, hits }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('example.com', '/'));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.url, url('example.com', '/'));
      assert.equal(result.feedUrl, url('example.com', '/feed.xml'));
      assert.equal(result.title, 'A blog');

      // §5 Step 4.3: 2 fetches in the common case where canonical == submitted —
      // the already-fetched HTML is reused rather than requested again.
      assert.deepEqual(hits, ['example.com/', 'example.com/feed.xml']);
    },
  );
});

test('an Atom-only page returns `feed_not_rss2` naming the Atom URL, not `no_feed_link`', async () => {
  // §5 Step 2: this is the difference between a closed door and an invitation. Without
  // the Atom bucket, a Jekyll site gets "we couldn't find an RSS feed link" while staring
  // at its own `<link rel="alternate" type="application/atom+xml">` and concludes we're
  // broken.
  await withSites(
    () => ({
      'jekyll.example': {
        '/': {
          body:
            '<html><head><link rel="alternate" type="application/atom+xml" ' +
            'href="/atom.xml"></head><body></body></html>',
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('jekyll.example', '/'));

      assert.equal(result.reason, 'feed_not_rss2');
      assert.equal(result.otherFormatUrl, url('jekyll.example', '/atom.xml'));
    },
  );
});

test('a page with no feed link at all returns `no_feed_link`', async () => {
  await withSites(
    () => ({
      'plain.example': { '/': { body: '<html><head></head><body>hi</body></html>' } },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('plain.example', '/'));

      assert.equal(result.reason, 'no_feed_link');
    },
  );
});

test('a submitted FEED url short-circuits discovery and resolves its own canonical page', async () => {
  // §5 Step 2: on a site about RSS, a large share of people will paste
  // `example.com/feed.xml` into the box. Otherwise they get "we couldn't find an RSS feed
  // on your page" about a page that *is* an RSS feed.
  await withSites(
    (url) => ({
      'example.com': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'A blog', channelLink: url('example.com', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('example.com', '/feed.xml'));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.url, url('example.com', '/'));
      assert.equal(result.feedUrl, url('example.com', '/feed.xml'));
    },
  );
});

test('a submitted feed with no `<channel><link>` returns `no_channel_link`', async () => {
  // §5 Step 4.1's carve-out: a resource that parsed as a feed must never become the
  // canonical *page*, or `htmlUrl` sends subscribers to raw XML.
  await withSites(
    () => ({
      'example.com': {
        '/feed.xml': { type: FEED_TYPE, body: rss({ channelLink: null }) },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('example.com', '/feed.xml'));

      assert.equal(result.reason, 'no_channel_link');
    },
  );
});

test('a submitted Atom feed URL is refused as `feed_not_rss2`, not `no_feed_link`', async () => {
  await withSites(
    () => ({
      'jekyll.example': {
        '/atom.xml': {
          type: 'application/atom+xml',
          body:
            '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
            '<title>A blog</title></feed>',
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('jekyll.example', '/atom.xml'));

      assert.equal(result.reason, 'feed_not_rss2');
    },
  );
});

test('a persistent 403 returns `blocked_by_site`, distinct from a fetch failure', async () => {
  // §5 Step 4: bot-protection 403s are outside the member's control (verified against
  // medium.com/@dhh, Vercel, AWS WAF and Substack custom domains), so the message has to
  // say plainly that we couldn't reach their site and offer the human path. That needs
  // its own reason code — and it creates no row.
  await withSites(
    () => ({
      'cloudflared.example': {
        '/': { status: 403, body: '<html><body>Just a moment…</body></html>' },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('cloudflared.example', '/'));

      assert.equal(result.reason, 'blocked_by_site');
      assert.equal(result.status, 403);
    },
  );
});

test('a 403 on the CANONICAL page is also `blocked_by_site`', async () => {
  await withSites(
    (url) => ({
      'blog.example': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ channelLink: url('www.blog.example', '/') }),
        },
      },
      'www.blog.example': { '/': { status: 403, body: 'blocked' } },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('blog.example', '/'));

      assert.equal(result.reason, 'blocked_by_site');
    },
  );
});

test('a canonical page that 404s returns `canonical_fetch_failed` naming that URL', async () => {
  // §5 Step 4: a broken `<channel><link>` is a real and fixable feed bug, so the message
  // names the exact URL we tried.
  await withSites(
    (url) => ({
      'blog.example': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ channelLink: url('blog.example', '/typo/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('blog.example', '/'));

      assert.equal(result.reason, 'canonical_fetch_failed');
      assert.equal(result.status, 404);
      assert.equal(result.url, url('blog.example', '/typo/'));
    },
  );
});

test('the final post-redirect URL of the canonical page becomes the listed URL', async () => {
  // §5 Step 4.4: following redirects here means `http://example.com` declared in the feed
  // and `https://example.com/` in the browser end up as ONE row, not two.
  await withSites(
    (url) => ({
      'blog.example': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Moved blog', channelLink: url('old.example', '/') }),
        },
      },
      'old.example': {
        '/': { status: 301, location: '/new/', body: '' },
        '/new/': { body: html({ feedHref: '/rss.xml' }) },
        '/rss.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Moved blog', channelLink: url('old.example', '/new/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('blog.example', '/'));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.url, url('old.example', '/new/'));
      assert.equal(result.feedUrl, url('old.example', '/rss.xml'));
    },
  );
});

test('a canonical page declaring a DIFFERENT feed: the canonical page\'s feed wins', async () => {
  // §5 Step 4: "the feed we publish must come from the page we publish". The feed recorded
  // against `example.com/` is the one `example.com/` itself declares — never one asserted
  // by a third party's page.
  await withSites(
    (url) => ({
      'blog.example': {
        '/authors/alice/': { body: html({ feedHref: '/authors/alice/feed.xml' }) },
        '/authors/alice/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'Alice', channelLink: url('blog.example', '/') }),
        },
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'The main blog', channelLink: url('blog.example', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('blog.example', '/authors/alice/'));

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.url, url('blog.example', '/'));
      assert.equal(result.feedUrl, url('blog.example', '/feed.xml'));
      assert.equal(result.title, 'The main blog');
    },
  );
});

test('a canonical page declaring no RSS feed is `feed_not_declared_on_canonical`', async () => {
  // Row 5 of §5 Step 4's table. The cost, stated plainly there: a site whose homepage
  // lacks autodiscovery while its blog index has it now gets rejected, and the message
  // tells them exactly which tag to add to which page.
  await withSites(
    (url) => ({
      'blog.example': {
        '/posts/': { body: html({ feedHref: '/posts/feed.xml' }) },
        '/posts/feed.xml': {
          type: FEED_TYPE,
          body: rss({ channelLink: url('blog.example', '/') }),
        },
        '/': { body: html({ badge: true }) },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('blog.example', '/posts/'));

      assert.equal(result.reason, 'feed_not_declared_on_canonical');
      assert.equal(result.url, url('blog.example', '/'));
    },
  );
});

test('a canonical feed that will not fetch is `canonical_feed_unavailable`, never substituted', async () => {
  // Row 4 of §5 Step 4's table — **transient**, retry later. Never substitute a different
  // feed, even the perfectly good one we just validated.
  await withSites(
    (url) => ({
      'blog.example': {
        '/posts/': { body: html({ feedHref: '/posts/feed.xml' }) },
        '/posts/feed.xml': {
          type: FEED_TYPE,
          body: rss({ channelLink: url('blog.example', '/') }),
        },
        '/': { body: html({ feedHref: '/broken.xml' }) },
        '/broken.xml': { status: 500, type: FEED_TYPE, body: 'oops' },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('blog.example', '/posts/'));

      assert.equal(result.reason, 'canonical_feed_unavailable');
      assert.equal(result.feedUrl, url('blog.example', '/broken.xml'));
    },
  );
});

test('a canonical feed that fails Step 3 is ALSO `canonical_feed_unavailable`', async () => {
  await withSites(
    (url) => ({
      'blog.example': {
        '/posts/': { body: html({ feedHref: '/posts/feed.xml' }) },
        '/posts/feed.xml': {
          type: FEED_TYPE,
          body: rss({ channelLink: url('blog.example', '/') }),
        },
        '/': { body: html({ feedHref: '/truncated.xml' }) },
        '/truncated.xml': {
          type: FEED_TYPE,
          body: '<rss version="2.0"><channel><title>cut off</title>',
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('blog.example', '/posts/'));

      assert.equal(result.reason, 'canonical_feed_unavailable');
      assert.equal(result.feedReason, 'feed_invalid');
    },
  );
});

test('no link-back on the canonical page names both pages in the result', async () => {
  // §5 Step 5: "add a link to your homepage" is unhelpful when the page we checked isn't
  // the one they submitted, so the result carries both URLs.
  await withSites(
    (url) => ({
      'blog.example': {
        '/blog/': { body: html({ feedHref: '/blog/feed.xml' }) },
        '/blog/feed.xml': {
          type: FEED_TYPE,
          body: rss({ channelLink: url('blog.example', '/') }),
        },
        '/': { body: html({ feedHref: '/blog/feed.xml', badge: false }) },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('blog.example', '/blog/'));

      assert.equal(result.reason, 'no_linkback');
      assert.equal(result.url, url('blog.example', '/'));
      assert.equal(result.submittedUrl, url('blog.example', '/blog/'));
    },
  );
});

test('one budget is shared across every fetch, so a slow chain returns `timeout`', async () => {
  // §5's fetch budget: without a total budget, 4 requests each with their own timeout and
  // up to 5 redirect hops can block a synchronous POST far past 30s — past many default
  // reverse-proxy timeouts, while the user watches a spinning tab and resubmits.
  await withSites(
    (url) => ({
      'slow.example': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': (req, res) => {
          res.writeHead(200, { 'content-type': FEED_TYPE });
          res.write(rss({ channelLink: url('slow.example', '/') }).slice(0, 40));
          // Never finishes: the budget, not the per-request timeout, has to end this.
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({
        safeFetch,
        config: { ...CONFIG, submitBudgetMs: 300 },
      });

      const started = Date.now();
      const result = await verifySite(url('slow.example', '/'));
      const elapsed = Date.now() - started;

      assert.equal(result.reason, 'timeout');
      assert.equal(elapsed < CONFIG.fetchTimeoutMs, true, `took ${elapsed}ms`);
    },
  );
});

test('rejects an unsupported scheme and an unparseable URL before any fetch', async () => {
  await withSites(
    () => ({}),
    async ({ safeFetch, hits }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });

      assert.equal((await verifySite('file:///etc/passwd')).reason, 'unsupported_scheme');
      assert.equal((await verifySite('   ')).reason, 'invalid_url');
      assert.deepEqual(hits, []);
    },
  );
});

// ── Revalidation mode (§8) ────────────────────────────────────────────────────────
// "Revalidation re-fetches `sites.url` and re-runs feed discovery on THAT PAGE ONLY.
// It never re-derives the canonical URL."

test('revalidation never re-derives the canonical URL from the feed', async () => {
  await withSites(
    (url) => ({
      'example.com': {
        '/blog/': { body: html({ feedHref: '/feed.xml' }) },
        // The oscillation §8 describes: /blog/ declares a feed whose channel link is
        // /, and / declares a feed whose channel link is /blog/. Re-deriving would
        // flip `sites.url` on every run — the OPML htmlUrl alternating weekly,
        // `directory_version` churning, and a pass/opt-out flip-flop if the badge is
        // on only one of the two pages.
        '/feed.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'A blog', channelLink: url('example.com', '/') }),
        },
        '/': { body: html({ feedHref: '/other.xml', badge: false }) },
        '/other.xml': {
          type: FEED_TYPE,
          body: rss({ title: 'A blog', channelLink: url('example.com', '/blog/') }),
        },
      },
    }),
    async ({ url, safeFetch, hits }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('example.com', '/blog/'), {
        fixedCanonical: true,
      });

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.url, url('example.com', '/blog/'), 'the row stays put');
      assert.equal(result.feedUrl, url('example.com', '/feed.xml'));
      // And `/` — the URL the feed names — is never fetched at all.
      assert.deepEqual(hits, ['example.com/blog/', 'example.com/feed.xml']);
    },
  );
});

test('revalidation re-runs feed discovery, so a moved feed is picked up', async () => {
  await withSites(
    (url) => ({
      'example.com': {
        // The member moved /feed.xml to /feed/ and only the page knows.
        '/': { body: html({ feedHref: '/feed/' }) },
        '/feed/': {
          type: FEED_TYPE,
          body: rss({ title: 'A blog', channelLink: url('example.com', '/') }),
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('example.com', '/'), { fixedCanonical: true });

      // §8: "not re-running feed discovery means a member who moves /feed.xml → /feed/
      // fails on a stale feed_url for three weeks and gets dropped with no
      // self-service repair."
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.feedUrl, url('example.com', '/feed/'));
    },
  );
});

test('a 304 on the feed is a pass that keeps the stored metadata', async () => {
  const seen = [];

  await withSites(
    (url) => ({
      'example.com': {
        '/': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': (req, res) => {
          seen.push({
            ifNoneMatch: req.headers['if-none-match'],
            ifModifiedSince: req.headers['if-modified-since'],
          });
          res.writeHead(304, { etag: '"v1"' });
          res.end();
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('example.com', '/'), {
        fixedCanonical: true,
        conditional: {
          feedUrl: url('example.com', '/feed.xml'),
          etag: '"v1"',
          lastModified: 'Wed, 01 Jul 2026 10:00:00 GMT',
        },
      });

      // §8: "a 304 is the cheapest possible way to honour the 'good citizen' claim."
      assert.deepEqual(seen, [{
        ifNoneMatch: '"v1"',
        ifModifiedSince: 'Wed, 01 Jul 2026 10:00:00 GMT',
      }]);
      // Byte-identical to the document we already validated, so the feed still
      // validates — but there is no body to take a title from, and overwriting
      // `title` with nothing would violate its NOT NULL.
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.feedUnchanged, true);
      assert.equal(result.title, undefined);
      assert.equal(result.feedUrl, url('example.com', '/feed.xml'));
    },
  );
});

test('the conditional headers are only sent for the feed we already validated', async () => {
  const seen = [];

  await withSites(
    (url) => ({
      'example.com': {
        '/': { body: html({ feedHref: '/feed/' }) },
        '/feed/': (req, res) => {
          seen.push(req.headers['if-none-match']);
          res.writeHead(200, { 'content-type': FEED_TYPE, etag: '"new"' });
          res.end(rss({ title: 'A blog', channelLink: url('example.com', '/') }));
        },
      },
    }),
    async ({ url, safeFetch }) => {
      const verifySite = createVerifier({ safeFetch, config: CONFIG });
      const result = await verifySite(url('example.com', '/'), {
        fixedCanonical: true,
        conditional: { feedUrl: url('example.com', '/feed.xml'), etag: '"v1"' },
      });

      // A validator belongs to one URL. Sent for a different feed it would produce a
      // 304 for a document we have never seen, and we would "revalidate" a feed that
      // might not exist.
      assert.deepEqual(seen, [undefined]);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.feedUnchanged, undefined);
      assert.equal(result.feedEtag, '"new"');
    },
  );
});
