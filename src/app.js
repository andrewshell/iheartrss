import { lookup } from 'node:dns';

import { Hono } from 'hono';

import { renderFeed } from './blog/feed.js';
import { createIpHasher } from './lib/iphash.js';
import { createRateLimiter, createSemaphore } from './lib/ratelimit.js';
import { registerAdmin } from './routes/admin.js';
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

    return result?.ok
      ? c.json({ ok: true })
      : c.json({ ok: false, reason: result?.reason ?? 'unhealthy' }, 503);
  });

  app.get('/', (c) => c.html(homePage({ config })));
  app.get('/about', (c) => c.html(aboutPage({ config })));
  app.get('/badge', (c) => c.html(badgePage({ config })));

  // §6.2/§12: /guide ships WITH the rejection messages that link to it, not after
  // them, or the first wave of Jekyll users hits a dead end at exactly the moment
  // we're asking them to change something.
  app.get('/guide', (c) => c.html(guidePage({ config })));

  registerSubmit(app, deps);
  registerAdmin(app, deps);

  app.get('/feed.xml', (c) =>
    c.body(renderFeed({ config }), 200, {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    }),
  );

  app.get('/robots.txt', (c) =>
    c.text(robotsTxt(), 200, {
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

// Plan §6: allow the public pages, disallow the routes that either cost us an
// outbound fetch (/check, /recheck), leak state (/status) or are private (/admin).
// The `Sitemap:` line lands with /sitemap.xml in phase 7; pointing crawlers at a
// 404 until then is worse than omitting it.
function robotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /check',
    'Disallow: /recheck',
    'Disallow: /status',
    '',
  ].join('\n');
}
