import { lookup } from 'node:dns';

import { Hono } from 'hono';

import { renderFeed } from './blog/feed.js';
import { createIpHasher } from './lib/iphash.js';
import { createOpmlDocument } from './lib/opml.js';
import { createRateLimiter, createSemaphore } from './lib/ratelimit.js';
import { renderSitemap } from './lib/sitemap.js';
import { registerAdmin } from './routes/admin.js';
import { registerBlog } from './routes/blog.js';
import { registerStatic } from './routes/static.js';
import { registerSubmit } from './routes/submit.js';
import { createFetcher } from './verify/fetch.js';
import { createVerifier } from './verify/index.js';
import { createPersister } from './verify/persist.js';
import { aboutPage } from './views/about.js';
import { badgePage } from './views/badge.js';
import { notFoundPage } from './views/error.js';
import { guidePage } from './views/guide.js';
import { homePage } from './views/home.js';
import { sitesPage } from './views/sites.js';

/**
 * `db` and `queries` come from `createDb(path)` and are injected rather than
 * imported (plan §11) — that is what lets a test hand the app an in-memory
 * database.
 *
 * The verifier, persister, rate limiter and IP hasher are injectable for the same
 * reason: `routes.test.js` tests the routes with a stub verifier, so it neither
 * needs a fixture HTTP server nor risks reaching the real network.
 */
export function createApp({
  config,
  db = null,
  queries = null,
  blog = emptyBlog(),
  checkHealth = () => ({ ok: true }),
  verifySite = null,
  persist = null,
  ipHmacKey = null,
  hashIp = null,
  limiter = null,
  semaphore = null,
  log = defaultLog,
}) {
  const app = new Hono();
  void db;

  const deps = {
    config,
    queries,
    log,
    // §6: 5 per 10 minutes and 30 per day, shared across every route that spends an
    // outbound request, plus a global semaphore of 4 on concurrent verifications so
    // no combination of endpoints can fan out against a third party.
    limiter: limiter ?? createRateLimiter(),
    semaphore: semaphore ?? createSemaphore(4),
    hashIp:
      hashIp ??
      (ipHmacKey === null
        ? // Nothing may reach `insertSubmission` with a raw address, so the fallback
          // is a refusal to hash rather than a plaintext IP.
          () => {
            throw new Error('no IP HMAC key: cannot hash a client address');
          }
        : createIpHasher({ key: ipHmacKey })),
    verifySite:
      verifySite ??
      createVerifier({
        safeFetch: createFetcher({ lookup, config }),
        config,
        isBanned:
          queries === null
            ? undefined
            : ({ host, path }) => queries.findBan({ host, path }) !== undefined,
      }),
    persist: null,
  };

  deps.persist =
    persist ??
    (queries === null
      ? async () => ({ outcome: 'rejected', reason: 'error' })
      : createPersister({
          queries,
          config,
          safeFetch: createFetcher({ lookup, config }),
          log,
        }));

  // Plan §9: the container healthcheck only inspects the HTTP status, so an
  // unhealthy answer has to *be* a 503. `{ok: false}` with a 200 is a container
  // that never restarts. Phases 3+ fold the database into `checkHealth`.
  app.get('/healthz', (c) => {
    let result;
    try {
      result = checkHealth();
    } catch (err) {
      result = { ok: false, reason: err.message };
    }

    if (!result?.ok) {
      return c.json({ ok: false, reason: result?.reason ?? 'unhealthy' }, 503);
    }

    // §6: `{ ok, sites, lastRevalidation }`. `lastRevalidation` is reported as null
    // until phase 8a owns the scheduler — the key is present because Docker's
    // healthcheck and §9's monitoring read this shape, and an absent key reads as a
    // scheduler that has never run rather than one that does not exist.
    return c.json({
      ok: true,
      sites: queries === null ? 0 : queries.countSites(),
      lastRevalidation: null,
    });
  });

  app.get('/', (c) =>
    c.html(
      homePage({
        config,
        memberCount: queries === null ? 0 : queries.countSites(),
        latestPost: blog.latest(),
      }),
    ),
  );
  app.get('/about', (c) => c.html(aboutPage({ config })));
  app.get('/badge', (c) => c.html(badgePage({ config })));

  // §6.2/§12: /guide ships WITH the rejection messages that link to it, not after
  // them, or the first wave of Jekyll users hits a dead end at exactly the moment
  // we're asking them to change something.
  app.get('/guide', (c) => c.html(guidePage({ config })));

  registerSubmit(app, deps);
  registerAdmin(app, deps);
  registerBlog(app, { config, blog });

  // ── The OPML subscription list (§7) ──────────────────────────────────────────
  const opml = createOpmlDocument({ queries: queries ?? emptyDirectory(), config });

  app.get('/subscriptions.opml', (c) => {
    const { body, etag, lastModified } = opml.render();

    const headers = {
      // §7: text/xml, because that is what FeedLand — the consumer that has to read
      // us — serves its own OPML as. `text/x-opml` lives in the `<link type=…>`
      // hint in §6.4; the two do not have to agree.
      'Content-Type': 'text/xml; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
      'Last-Modified': lastModified,
    };

    return isFresh(c.req, { etag, lastModified })
      ? c.body(null, 304, headers)
      : c.body(body, 200, headers);
  });

  // §6.3: the human view of the same set — all members, newest first, no pagination.
  app.get('/sites', (c) =>
    c.html(sitesPage({ config, members: queries === null ? [] : queries.listMembers() })),
  );

  // §6: people will guess /opml, and /.well-known/recommendations.opml is the
  // emerging convention for blogroll discovery.
  app.get('/opml', (c) => c.redirect('/subscriptions.opml', 301));
  app.get('/.well-known/recommendations.opml', (c) =>
    c.redirect('/subscriptions.opml', 301),
  );

  // §6: an alias, because /rss.xml is what half the world types. Registered before
  // registerStatic so it wins over any same-named file in public/.
  app.get('/rss.xml', (c) => c.redirect('/feed.xml', 301));

  app.get('/feed.xml', (c) =>
    c.body(renderFeed({ config, posts: blog.posts() }), 200, {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    }),
  );

  // §6: "Search is the growth channel" — static pages plus every post.
  app.get('/sitemap.xml', (c) =>
    c.body(renderSitemap({ config, posts: blog.posts() }), 200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    }),
  );

  app.get('/robots.txt', (c) =>
    c.text(robotsTxt(config), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
    }),
  );

  // Registered last so a real route always wins over a file of the same name.
  registerStatic(app);

  app.notFound((c) => c.html(notFoundPage({ config }), 404));

  return app;
}

function defaultLog(msg, fields) {
  console.log(JSON.stringify({ msg, ...fields }));
}

/**
 * A database-less app (the phase-1 tests, `createApp({ config })`) still answers
 * every route rather than 404ing on some of them. An empty directory is the honest
 * answer, and it keeps the route table one thing instead of two.
 */
function emptyDirectory() {
  return {
    getDirectoryVersion: () => ({
      version: 0,
      outline_hash: '',
      updated_at: new Date(0).toISOString(),
    }),
    listOutlines: () => [],
    saveOutlineHash: () => {},
  };
}

/**
 * A blog with no `content/` directory behind it. Same reasoning as
 * `emptyDirectory()`: every route answers, and the feed stays valid with zero items
 * (§5 Step 3), so a test that does not care about posts does not have to build a
 * temporary directory to get one.
 */
function emptyBlog() {
  return { posts: () => [], latest: () => null, refresh: () => {} };
}

/**
 * Is the client's cached copy still good? (§7: "Answer conditional GETs with 304.")
 *
 * `If-None-Match` wins over `If-Modified-Since` when both are present, per RFC 9110
 * — the ETag is the precise validator, and `Last-Modified` has only one-second
 * resolution, so two changes inside a second are invisible to it.
 */
function isFresh(req, { etag, lastModified }) {
  const ifNoneMatch = req.header('if-none-match');

  if (ifNoneMatch !== undefined) {
    return ifNoneMatch
      .split(',')
      .map((candidate) => candidate.trim())
      .some(
        (candidate) =>
          candidate === '*' ||
          // A weak comparison, which is what If-None-Match requires: `W/"x"` and
          // `"x"` are the same entity for this purpose.
          candidate.replace(/^W\//, '') === etag,
      );
  }

  const ifModifiedSince = req.header('if-modified-since');
  if (ifModifiedSince === undefined) return false;

  const since = Date.parse(ifModifiedSince);
  // Both sides are HTTP-dates at one-second resolution, so `<=` is the comparison.
  return !Number.isNaN(since) && Date.parse(lastModified) <= since;
}

// Plan §6: allow the public pages, disallow the routes that either cost us an
// outbound fetch (/check, /recheck), leak state (/status) or are private (/admin).
// The `Sitemap:` line arrives here in phase 7, with the /sitemap.xml it names —
// pointing crawlers at a 404 for six phases would have been worse than omitting it.
function robotsTxt(config) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /check',
    'Disallow: /recheck',
    'Disallow: /status',
    '',
    `Sitemap: ${new URL('/sitemap.xml', config.siteUrl).href}`,
    '',
  ].join('\n');
}
