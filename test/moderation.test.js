/**
 * Plan §11: written in phase 5, not 8b, because phase 5 ships `POST /admin/ban`
 * and every failure here is silent — the site looks fine and the lever just
 * doesn't work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db/index.js';
import { createVerifier } from '../src/verify/index.js';
import { createPersister } from '../src/verify/persist.js';
import {
  CONFIG as FIXTURE_CONFIG,
  FEED_TYPE,
  html,
  rss,
  withSites,
} from './helpers/sites.js';

const CONFIG = Object.freeze({
  ...FIXTURE_CONFIG,
  maxListingsPerDomain: 5,
  maxNewListingsPerDay: 50,
});

function verified(overrides = {}) {
  return {
    ok: true,
    url: 'https://spammer.example/',
    submittedUrl: 'https://spammer.example/',
    feedUrl: 'https://spammer.example/rss.xml',
    title: 'Spam',
    description: undefined,
    features: { has_source_ns: false, has_rsscloud: false, rsscloud_style: null },
    ...overrides,
  };
}

function setup() {
  const { db, queries } = createDb(':memory:');
  const persist = createPersister({
    queries,
    config: CONFIG,
    safeFetch: async () => ({ ok: false, reason: 'unexpected_fetch' }),
  });
  return { db, queries, persist };
}

test('resubmitting a hidden site does not reactivate it', async () => {
  const { db, queries, persist } = setup();
  const { siteId } = await persist(verified());
  queries.hideSite(siteId, 'spam');

  const outcome = await persist(verified({ title: 'Not spam, honest' }));

  // §5 Step 7: `hidden` is TERMINAL. As originally written — "existing row → set
  // status = 'active'", unconditionally — the admin's only lightweight moderation
  // lever was undone by the moderated party pressing submit again: one request, no
  // auth, no rate-limit obstacle.
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  assert.equal(row.status, 'hidden');

  // It still refreshes metadata, so we keep observing it...
  assert.equal(row.title, 'Not spam, honest');

  // ...and the submitter gets a NEUTRAL answer, not an oracle telling them they
  // have been moderated.
  assert.equal(outcome.outcome, 'already_submitted');
  assert.equal(outcome.siteId, undefined);
});

test('only an admin unhide clears the hidden status', async () => {
  const { db, queries, persist } = setup();
  const { siteId } = await persist(verified());
  queries.hideSite(siteId, 'spam');

  queries.unhideSite(siteId, 'appealed successfully');

  assert.equal(
    db.prepare('SELECT status FROM sites WHERE id = ?').get(siteId).status,
    'active',
  );
  // Every admin action leaves a record of what was done and why (§4).
  const log = db
    .prepare('SELECT action, reason FROM moderation_log ORDER BY id')
    .all()
    .map((row) => `${row.action}:${row.reason}`);
  assert.deepEqual(log, ['hide:spam', 'unhide:appealed successfully']);
});

test('a hidden row that is later revived by a normal resubmit stays hidden', async () => {
  // The same hole via the `failing` → `active` revival path: a row can be both
  // failing and hidden, and reviving it must not be a way out of hidden.
  const { db, queries, persist } = setup();
  const { siteId } = await persist(verified());
  queries.hideSite(siteId, 'spam');
  db.prepare('UPDATE sites SET failure_count = 3 WHERE id = ?').run(siteId);

  await persist(verified());

  assert.equal(
    db.prepare('SELECT status FROM sites WHERE id = ?').get(siteId).status,
    'hidden',
  );
});

test('a path-scoped ban scopes to one account, not the whole shared host', () => {
  const { queries } = setup();

  queries.insertBan({ host: 'mastodon.social', path_prefix: '/@spammer' });

  // §4, the SQL-precedence bug spelled out: AND binds tighter than OR, so without
  // the outer parentheses this reads `A OR (B AND C)`, the exact-host arm ignores
  // path_prefix entirely, and a ban on one account takes out the whole instance.
  assert.ok(queries.findBan({ host: 'mastodon.social', path: '/@spammer' }));
  assert.ok(queries.findBan({ host: 'mastodon.social', path: '/@spammer/109' }));
  assert.equal(queries.findBan({ host: 'mastodon.social', path: '/@alice' }), undefined);
  assert.equal(queries.findBan({ host: 'mastodon.social', path: '/' }), undefined);
});

test('a path-scoped ban does not match a similarly-spelled account', () => {
  const { queries } = setup();

  queries.insertBan({ host: 'mastodon.social', path_prefix: '/@some_user' });

  // §4: substr(), NOT LIKE — '_' and '%' are LIKE wildcards, so a LIKE-based ban on
  // '/@some_user' would also catch '/@someXuser'.
  assert.ok(queries.findBan({ host: 'mastodon.social', path: '/@some_user' }));
  assert.equal(
    queries.findBan({ host: 'mastodon.social', path: '/@someXuser' }),
    undefined,
  );
});

test('a host_suffix ban catches wildcard subdomains in one row', () => {
  const { queries } = setup();

  // §5 Step 7: with wildcard DNS, a1…a500.attacker.example each have a distinct
  // url AND feed_url, so both UNIQUE constraints are satisfied and all 500 reach
  // every subscriber. Without a suffix form, cleanup is 500 inserts and counting.
  queries.insertBan({ host_suffix: '.attacker.example' });

  assert.ok(queries.findBan({ host: 'a1.attacker.example', path: '/' }));
  assert.ok(queries.findBan({ host: 'deep.nested.attacker.example', path: '/' }));
  assert.equal(queries.findBan({ host: 'notattacker.example', path: '/' }), undefined);
  assert.equal(queries.findBan({ host: 'attacker.example.org', path: '/' }), undefined);
});

test('a ban hides the sites it covers, and only those', async () => {
  const { db, queries, persist } = setup();

  const spammer = await persist(
    verified({
      url: 'https://mastodon.social/@spammer',
      submittedUrl: 'https://mastodon.social/@spammer',
      feedUrl: 'https://mastodon.social/@spammer.rss',
    }),
  );
  const innocent = await persist(
    verified({
      url: 'https://mastodon.social/@alice',
      submittedUrl: 'https://mastodon.social/@alice',
      feedUrl: 'https://mastodon.social/@alice.rss',
    }),
  );

  queries.insertBan({ host: 'mastodon.social', path_prefix: '/@spammer' });

  const status = (id) =>
    db.prepare('SELECT status FROM sites WHERE id = ?').get(id).status;
  assert.equal(status(spammer.siteId), 'hidden');
  assert.equal(status(innocent.siteId), 'active');
});

test('a banned canonical host is refused at persistence, not just at Step 0', async () => {
  const { db, queries, persist } = setup();
  queries.insertBan({ host: 'spammer.example', reason: 'spam' });

  const outcome = await persist(verified());

  // §5 Step 0.6 screens the SUBMITTED url; the canonical URL comes from the feed's
  // `<channel><link>` and can be a different host entirely, so the ban has to be
  // checked again against the final canonical host or it is trivially sidestepped
  // by submitting a page that canonicalises onto the banned one.
  assert.equal(outcome.outcome, 'rejected');
  assert.equal(outcome.reason, 'banned');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sites').get().n, 0);
});

test('a path-scoped ban does not refuse a different account on the same host', async () => {
  const { persist, queries } = setup();
  queries.insertBan({ host: 'mastodon.social', path_prefix: '/@spammer' });

  const outcome = await persist(
    verified({
      url: 'https://mastodon.social/@alice',
      submittedUrl: 'https://mastodon.social/@alice',
      feedUrl: 'https://mastodon.social/@alice.rss',
    }),
  );

  assert.equal(outcome.outcome, 'added');
});

test('a banned submitted URL is refused before any outbound fetch', async () => {
  const { queries } = setup();
  queries.insertBan({ host: 'spammer.example', path_prefix: '/@bad' });

  await withSites(
    () => ({
      'spammer.example': {
        '/@bad': { body: html({ feedHref: '/feed.xml' }) },
        '/@good': { body: html({ feedHref: '/feed.xml' }) },
        '/feed.xml': { type: FEED_TYPE, body: rss({ title: 'Whatever' }) },
      },
    }),
    async ({ url, safeFetch, hits }) => {
      const verifySite = createVerifier({
        safeFetch,
        config: CONFIG,
        isBanned: ({ host, path }) => queries.findBan({ host, path }) !== undefined,
      });

      const banned = await verifySite(url('spammer.example', '/@bad'));

      // §5 Step 0.6: refused on the normalized URL, using §4's FULL predicate. Before
      // any fetch, because the point of a ban is that we stop spending requests on them.
      assert.equal(banned.ok, false);
      assert.equal(banned.reason, 'banned');
      assert.deepEqual(hits, []);

      // ...and the path scoping still holds: a different account on the same host
      // gets a real verification attempt.
      await verifySite(url('spammer.example', '/@good'));
      assert.ok(hits.length > 0);
    },
  );
});

// ── The bare-minimum admin routes (§12, phase 5) ─────────────────────────────
// "§1's whole publishing model is 'auto-publish + admin removal'; the removal half
// cannot land four phases after the publishing half."

const TOKEN = 'a'.repeat(64);

function adminApp({
  adminToken = TOKEN,
  now = () => new Date('2026-07-29T12:00:00.000Z'),
  trustProxy = false,
  verifySite = async () => ({ ok: false, reason: 'no_linkback' }),
} = {}) {
  const { db, queries } = createDb(':memory:');
  // §6.4's pinger, counted rather than called — no test may reach rpc.rsscloud.io.
  const pings = [];
  const app = createApp({
    config: {
      siteUrl: 'https://iheartrss.com/',
      linkbackHosts: ['iheartrss.com'],
      maxListingsPerDomain: 5,
      maxNewListingsPerDay: 50,
      submitBudgetMs: 5000,
      revalidateIntervalDays: 6,
      trustProxy,
      trustedProxyHops: 0,
      adminToken,
    },
    db,
    queries,
    now,
    verifySite,
    ipHmacKey: Buffer.alloc(32, 3),
    rsscloud: { notifyOpmlChanged: () => pings.push('opml') },
    log: () => {},
  });

  const id = queries.insertSite({
    url: 'https://spammer.example/',
    submitted_url: 'https://spammer.example/',
    host: 'spammer.example',
    path: '/',
    feed_url: 'https://spammer.example/rss.xml',
    title: 'Spam',
    description: undefined,
    has_source_ns: false,
    has_rsscloud: false,
    rsscloud_style: undefined,
    cloud_json: undefined,
  });

  return { app, db, queries, id, pings };
}

function adminPost(app, path, body = {}, token = TOKEN) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request(path, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
  });
}

test('POST /admin/sites/:id/hide takes a site down', async () => {
  const { app, db, id } = adminApp();

  const res = await adminPost(app, `/admin/sites/${id}/hide`, { reason: 'spam' });

  assert.equal(res.status, 200);
  assert.equal(
    db.prepare('SELECT status FROM sites WHERE id = ?').get(id).status,
    'hidden',
  );
  assert.equal(db.prepare('SELECT action FROM moderation_log').get().action, 'hide');
});

test('a wrong-LENGTH admin token is a 401, not a 500', async () => {
  const { app, db, id } = adminApp();

  // §6: raw crypto.timingSafeEqual throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on
  // unequal lengths (verified), so a wrong-length guess 500s instead of 401-ing — a
  // crash per attempt AND a length oracle. Hashing both sides makes them 32 bytes.
  for (const token of [
    'x',
    'short',
    'a'.repeat(63),
    'a'.repeat(65),
    'b'.repeat(64),
    '',
  ]) {
    const res = await adminPost(app, `/admin/sites/${id}/hide`, {}, token);
    assert.equal(res.status, 401, `token ${JSON.stringify(token)} must be a 401`);
  }

  const missing = await adminPost(app, `/admin/sites/${id}/hide`, {}, null);
  assert.equal(missing.status, 401);

  assert.equal(
    db.prepare('SELECT status FROM sites WHERE id = ?').get(id).status,
    'active',
  );
});

test('no admin routes exist at all when ADMIN_TOKEN is unset', async () => {
  const { app, id } = adminApp({ adminToken: null });

  // §6: "No admin UI is served at all if ADMIN_TOKEN is unset." A 404 rather than a
  // 401 also means it isn't a probe for whether admin exists.
  assert.equal((await adminPost(app, `/admin/sites/${id}/hide`)).status, 404);
  assert.equal((await adminPost(app, '/admin/ban', { host: 'x.example' })).status, 404);

  // Every route added in 8b, GETs included — the login page is the one that would
  // most obviously give the game away.
  for (const path of ['/admin', '/admin/login']) {
    assert.equal((await app.request(path)).status, 404, `GET ${path}`);
  }
  for (const path of [
    '/admin/login',
    '/admin/logout',
    `/admin/sites/${id}/unhide`,
    '/admin/reports/1/handle',
    '/admin/domain-limits',
  ]) {
    assert.equal((await adminPost(app, path)).status, 404, `POST ${path}`);
  }
});

test('POST /admin/ban bans a host and hides its sites in one request', async () => {
  const { app, db, queries, id } = adminApp();

  const res = await adminPost(app, '/admin/ban', {
    host: 'Spammer.Example',
    reason: 'bulk spam',
  });

  assert.equal(res.status, 200);
  assert.ok(queries.findBan({ host: 'spammer.example', path: '/' }));
  assert.equal(
    db.prepare('SELECT status FROM sites WHERE id = ?').get(id).status,
    'hidden',
  );
});

test('POST /admin/ban accepts a host_suffix and a path_prefix', async () => {
  const { app, queries } = adminApp();

  await adminPost(app, '/admin/ban', { host_suffix: '.attacker.example' });
  await adminPost(app, '/admin/ban', {
    host: 'mastodon.social',
    path_prefix: '/@spammer',
  });

  assert.ok(queries.findBan({ host: 'a1.attacker.example', path: '/' }));
  assert.ok(queries.findBan({ host: 'mastodon.social', path: '/@spammer' }));
  assert.equal(queries.findBan({ host: 'mastodon.social', path: '/@alice' }), undefined);
});

test('POST /admin/ban with neither host nor suffix is refused', async () => {
  const { app, db } = adminApp();

  const res = await adminPost(app, '/admin/ban', { reason: 'oops' });

  // A ban row with an empty host AND an empty host_suffix matches nothing, so
  // accepting it would silently do nothing at all.
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM banned_hosts').get().n, 0);
});

test('hiding a site the admin mistyped is a 404, not a silent success', async () => {
  const { app } = adminApp();

  assert.equal((await adminPost(app, '/admin/sites/9999/hide')).status, 404);
});

// ── Sessions, CSRF and the dashboard (§6 "Admin auth", §12 phase 8b) ─────────

test('GET /admin without a session is a 401, never the dashboard', async () => {
  const { app } = adminApp();

  const res = await app.request('/admin');

  assert.equal(res.status, 401);
});

/** POST /admin/login and hand back the `name=value` pair for the Cookie header. */
async function login(app, token = TOKEN, { ip } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (ip !== undefined) headers['x-forwarded-for'] = ip;

  const res = await app.request('/admin/login', {
    method: 'POST',
    headers,
    body: new URLSearchParams({ token }).toString(),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { res, setCookie, cookie: setCookie.split(';')[0] };
}

test('a correct token at POST /admin/login opens a session GET /admin accepts', async () => {
  const { app } = adminApp();

  const { res, setCookie, cookie } = await login(app);

  assert.equal(res.status, 303);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);

  // §6: the cookie holds a random 32-byte session id, NOT the token. Storing the
  // long-lived, un-rotatable env secret in a browser with no expiry and no
  // revocation short of a redeploy is a bad trade for a few saved lines.
  assert.ok(!setCookie.includes(TOKEN), 'the admin token must never reach the cookie');

  const dashboard = await app.request('/admin', { headers: { cookie } });
  assert.equal(dashboard.status, 200);
});

test('POST /admin/login backs off exponentially after a failure', async () => {
  const clock = { t: Date.parse('2026-07-29T12:00:00.000Z') };
  const { app } = adminApp({ now: () => new Date(clock.t) });

  // §6: a wrong-LENGTH guess must 401, never 500 — raw timingSafeEqual throws
  // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH, which is both a crash per attempt and a
  // token-length oracle.
  assert.equal((await login(app, 'short')).res.status, 401);

  // "Rate-limit and exponentially back off the login route" — the second guess in
  // the same instant is refused outright.
  const second = await login(app, 'b'.repeat(64));
  assert.equal(second.res.status, 429);
  assert.ok(Number(second.res.headers.get('retry-after')) >= 1);

  // The lockout applies to the RIGHT token too. Letting the correct one through
  // during a backoff window makes the 429 a "wrong guess" oracle.
  assert.equal((await login(app)).res.status, 429);

  // Once the first window elapses, one more attempt is allowed...
  clock.t += 1_000;
  assert.equal((await login(app, 'c'.repeat(64))).res.status, 401);

  // ...and that second failure buys a LONGER window than the first: 1.5s after it,
  // the first curve would already have expired and the second has not.
  clock.t += 1_500;
  assert.equal((await login(app)).res.status, 429);

  clock.t += 60_000;
  assert.equal((await login(app)).res.status, 303);
});

test('login backoff is global too, so rotating IPs does not buy fresh attempts', async () => {
  const clock = { t: Date.parse('2026-07-29T12:00:00.000Z') };
  const { app } = adminApp({ now: () => new Date(clock.t), trustProxy: true });

  // Every guess from a brand-new address, an hour apart, so the per-IP arm never
  // fires and nothing but the global counter can refuse anything.
  for (let i = 0; i < 21; i += 1) {
    if (i > 0) clock.t += 60 * 60 * 1000;
    const { res } = await login(app, 'd'.repeat(64), { ip: `203.0.113.${i + 1}` });
    assert.equal(res.status, 401, `attempt ${i + 1} from a fresh IP`);
  }

  const { res } = await login(app, 'e'.repeat(64), { ip: '198.51.100.7' });
  assert.equal(res.status, 429);
});

/** Log in and read the CSRF token back out of the dashboard's own forms. */
async function adminSession(app) {
  const { cookie } = await login(app);
  const page = await (await app.request('/admin', { headers: { cookie } })).text();
  const csrf = /name="csrf"\s+value="([^"]+)"/.exec(page)?.[1];
  return { cookie, csrf, page };
}

function sessionPost(app, path, body, cookie) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body).toString(),
  });
}

const statusOf = (db, id) =>
  db.prepare('SELECT status FROM sites WHERE id = ?').get(id).status;

test('a cookie-authenticated admin POST without the CSRF token is rejected', async () => {
  const { app, db, id } = adminApp();
  const { cookie, csrf } = await adminSession(app);

  // §6: "CSRF token derived from the session id (so it rotates), required on every
  // admin POST." The dashboard's own forms have to carry it, or the UI can't work.
  assert.ok(csrf, 'the dashboard must carry a CSRF token for its forms');

  const missing = await sessionPost(
    app,
    `/admin/sites/${id}/hide`,
    { reason: 'spam' },
    cookie,
  );
  assert.equal(missing.status, 403);

  const wrong = await sessionPost(
    app,
    `/admin/sites/${id}/hide`,
    { reason: 'spam', csrf: 'not-the-token' },
    cookie,
  );
  assert.equal(wrong.status, 403);
  assert.equal(statusOf(db, id), 'active', 'a CSRF-less POST must write nothing');

  const ok = await sessionPost(
    app,
    `/admin/sites/${id}/hide`,
    { reason: 'spam', csrf },
    cookie,
  );
  assert.equal(ok.status, 303);
  assert.equal(statusOf(db, id), 'hidden');
});

test('POST /admin/logout ends the session for real, not just in the browser', async () => {
  const { app } = adminApp();
  const { cookie, csrf } = await adminSession(app);

  const res = await sessionPost(app, '/admin/logout', { csrf }, cookie);

  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0/);
  // The server-side entry has to be gone too: a logout that only clears the cookie
  // leaves a live credential in every proxy log it ever appeared in.
  assert.equal((await app.request('/admin', { headers: { cookie } })).status, 401);
});

test('an admin session expires on its TTL', async () => {
  const clock = { t: Date.parse('2026-07-29T12:00:00.000Z') };
  const { app } = adminApp({ now: () => new Date(clock.t) });
  const { cookie } = await login(app);

  clock.t += 11 * 60 * 60 * 1000;
  assert.equal((await app.request('/admin', { headers: { cookie } })).status, 200);

  // §6: "a random 32-byte session id with a TTL". Without expiry, the in-memory Map
  // is a set of credentials that live as long as the process.
  clock.t += 2 * 60 * 60 * 1000;
  assert.equal((await app.request('/admin', { headers: { cookie } })).status, 401);
});

test('every mutating admin action leaves a moderation_log row', async () => {
  const { app, db, queries, id } = adminApp();
  queries.insertReport({
    site_id: id,
    url: 'https://spammer.example/',
    reason: 'spam',
    ip_hash: 'h',
  });
  const reportId = db.prepare('SELECT id FROM reports').get().id;

  await adminPost(app, `/admin/sites/${id}/hide`, { reason: 'r1' });
  await adminPost(app, `/admin/sites/${id}/unhide`, { reason: 'r2' });
  await adminPost(app, '/admin/ban', { host: 'other.example', reason: 'r3' });
  await adminPost(app, `/admin/reports/${reportId}/handle`, { reason: 'r4' });
  await adminPost(app, '/admin/domain-limits', {
    domain: 'tenants.com',
    max_listings: '-1',
  });

  // §4: "Every admin action, so there's a record of what was done and why." The log
  // is the only account of a moderation decision that survives the operator.
  const actions = db
    .prepare('SELECT action FROM moderation_log ORDER BY id')
    .all()
    .map((row) => row.action);
  assert.deepEqual(actions, ['hide', 'unhide', 'ban', 'report_handled', 'domain_limit']);
});

test('a path-scoped ban through the admin route leaves the rest of the host listed', async () => {
  const { app, db, queries } = adminApp();
  const listing = (path, slug) =>
    queries.insertSite({
      url: `https://mastodon.social${path}`,
      submitted_url: `https://mastodon.social${path}`,
      host: 'mastodon.social',
      path,
      feed_url: `https://mastodon.social/${slug}.rss`,
      title: slug,
      description: undefined,
      has_source_ns: false,
      has_rsscloud: false,
      rsscloud_style: undefined,
      cloud_json: undefined,
    });
  const spammer = listing('/@spammer', 'spammer');
  const alice = listing('/@alice', 'alice');

  await adminPost(app, '/admin/ban', {
    host: 'mastodon.social',
    path_prefix: '/@spammer',
    reason: 'spam',
  });

  // §4's outer parentheses, end to end: without them the exact-host arm ignores
  // path_prefix and a ban on one account silently takes out the whole instance.
  assert.equal(statusOf(db, spammer), 'hidden');
  assert.equal(statusOf(db, alice), 'active');
  const opml = await (await app.request('/subscriptions.opml')).text();
  assert.ok(!opml.includes('@spammer'));
  assert.match(opml, /@alice/);

  // ...while a host_suffix ban is the wildcard-DNS form, and catches every depth.
  await adminPost(app, '/admin/ban', { host_suffix: '.attacker.example' });
  assert.ok(queries.findBan({ host: 'deep.nested.attacker.example', path: '/' }));
  assert.equal(queries.findBan({ host: 'notattacker.example', path: '/' }), undefined);
});

test('no public page links to /admin', async () => {
  const { app } = adminApp();

  // §6/§12: the dashboard is disallowed in robots.txt AND never linked. A link in the
  // shared footer would put it in every crawler's queue and in every referrer log.
  for (const path of [
    '/',
    '/about',
    '/sites',
    '/submit',
    '/badge',
    '/guide',
    '/status',
    '/report',
  ]) {
    const body = await (await app.request(path)).text();
    assert.ok(!body.includes('/admin'), `${path} must not link to /admin`);
  }

  const robots = await (await app.request('/robots.txt')).text();
  assert.match(robots, /^Disallow: \/admin$/m);
});

test('the dashboard carries the rejection histogram, both queues and the backlog', async () => {
  const { app, db, queries, id } = adminApp();

  const attempt = (reason, result = 'rejected') =>
    queries.insertSubmission({
      submitted_url: 'https://someone.example/',
      normalized_url: 'https://someone.example/',
      ip_hash: 'h',
      result,
      reason,
    });
  attempt('no_linkback');
  attempt('no_linkback');
  attempt('feed_not_rss2');
  attempt(undefined, 'added');

  db.prepare(
    "UPDATE sites SET status = 'failing', last_error = 'timeout' WHERE id = ?",
  ).run(id);
  queries.insertReport({
    site_id: id,
    url: 'https://spammer.example/',
    reason: 'serving malware',
    ip_hash: 'h',
  });
  queries.insertBan({ host_suffix: '.attacker.example', reason: 'wildcard flood' });

  const { page } = await adminSession(app);

  // §10: the histogram is the fastest way to learn which design decision is costing
  // members — a count per reason, not a pile of rows to eyeball.
  assert.match(page, /data-reason="no_linkback" data-count="2"/);
  assert.match(page, /data-reason="feed_not_rss2" data-count="1"/);
  // An `added` submission is not a rejection and must not appear as one.
  assert.ok(!/data-reason="added"/.test(page));

  // The failing site, the open report and the ban list.
  assert.match(page, /timeout/);
  assert.match(page, /serving malware/);
  assert.match(page, /\.attacker\.example/);

  // §8's backlog, the same two numbers /healthz reports — this is where an operator
  // notices the capacity ceiling before /about's promise quietly goes false.
  assert.match(page, /data-overdue-count="\d+"/);
});

// ── How the dashboard reads (§6.3) ──────────────────────────────────────────────
//
// The dashboard is a working surface, not a data dump. These pin the three things
// that made it hard to scan: raw timestamps, facts run together, and a row whose
// only handle was empty.

test('timestamps render as <time>, never as a raw ISO string in prose', async () => {
  const { app } = adminApp();
  const { page } = await adminSession(app);

  // Minute precision for the eye, full value for a machine and for the tooltip.
  // Seconds and milliseconds are noise in a triage list.
  assert.match(
    page,
    /<time datetime="[^"]+Z" title="[^"]+ \(UTC\)"\s*>\d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/time/,
  );

  // Nothing renders `2026-07-31T19:00:10.031Z` as text. Attribute values are
  // exempt — that is where the exact value is supposed to live.
  const text = page.replace(/<[^>]*>/g, '');
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('a member with no title is listed by host, not as an empty link', async () => {
  const { app, queries } = adminApp();
  queries.insertSite({
    url: 'https://untitled.example/',
    submitted_url: 'https://untitled.example/',
    host: 'untitled.example',
    path: '/',
    feed_url: 'https://untitled.example/rss.xml',
    // A feed with no `<channel><title>` is legal RSS and does reach us.
    title: '',
    description: undefined,
    has_source_ns: false,
    has_rsscloud: false,
    rsscloud_style: undefined,
    cloud_json: undefined,
  });

  const { page } = await adminSession(app);

  // Without the fallback this row rendered `<a href="…"></a>` — a zero-width link,
  // so the one row an operator most needs to look at was the one they could not
  // click. /sites has always had this fallback; /admin did not.
  assert.match(
    page,
    /<a class="admin-row__title" href="https:\/\/untitled\.example\/">untitled\.example<\/a>/,
  );
  assert.doesNotMatch(page, /class="admin-row__title"[^>]*><\/a>/);
});

test('the meta facts are separated, not run together', async () => {
  const { app, db, id } = adminApp();
  db.prepare(
    "UPDATE sites SET status = 'failing', last_error = 'timeout' WHERE id = ?",
  ).run(id);

  const { page } = await adminSession(app);

  // `#2 blocked (blocked_by_site)` gave the eye nothing to lock onto. An id, a
  // status and an error code are three facts, and they are punctuated as three.
  assert.match(
    page,
    /<span class="admin-status" data-status="failing">failing<\/span> <span aria-hidden="true">&middot;<\/span> <code>timeout<\/code>/,
  );

  // `aria-hidden` on the separators: they are punctuation for the eye, and a screen
  // reader announcing "middot" between every field is worse than the run-on line.
  assert.doesNotMatch(page, /<span aria-hidden="false"/);
});

test('POST /admin/domain-limits changes the effective per-domain cap', async () => {
  const { app, db, queries } = adminApp();
  const persist = createPersister({
    queries,
    config: CONFIG,
    safeFetch: async () => ({ ok: false, reason: 'unexpected_fetch' }),
  });
  const member = (n) => ({
    ok: true,
    url: `https://user${n}.tenants.com/`,
    submittedUrl: `https://user${n}.tenants.com/`,
    feedUrl: `https://user${n}.tenants.com/rss.xml`,
    title: `Member ${n}`,
    features: { has_source_ns: false, has_rsscloud: false, rsscloud_style: null },
  });

  for (let n = 1; n <= 5; n += 1) {
    assert.equal((await persist(member(n))).outcome, 'added', `listing ${n}`);
  }
  assert.equal((await persist(member(6))).reason, 'domain_cap');

  const res = await adminPost(app, '/admin/domain-limits', {
    domain: 'Tenants.com',
    max_listings: '-1',
    note: 'multi-tenant',
  });
  assert.equal(res.status, 200);

  // §4/§5: "Editable from /admin; the 'admin-overridable' the cap promises lives
  // here, not in env." An override that doesn't change the answer to the cap query
  // is a row nobody reads.
  assert.equal((await persist(member(6))).outcome, 'added');
  assert.equal(queries.maxListingsForDomain('tenants.com', 5), -1);

  assert.equal(
    db.prepare('SELECT action FROM moderation_log ORDER BY id DESC').get().action,
    'domain_limit',
  );
});

test('POST /admin/domain-limits refuses a limit that is not a number', async () => {
  const { app, db } = adminApp();

  const res = await adminPost(app, '/admin/domain-limits', {
    domain: 'tenants.com',
    max_listings: 'lots',
  });

  assert.equal(res.status, 400);
  assert.equal(
    db
      .prepare('SELECT count(*) AS n FROM domain_limits WHERE domain = ?')
      .get('tenants.com').n,
    0,
  );
});

test('POST /admin/reports/:id/handle clears a report and records who did it', async () => {
  const { app, db, queries, id } = adminApp();
  queries.insertReport({
    site_id: id,
    url: 'https://spammer.example/',
    reason: 'serving malware',
    ip_hash: 'h',
  });
  const reportId = db.prepare('SELECT id FROM reports').get().id;

  const res = await adminPost(app, `/admin/reports/${reportId}/handle`, {
    reason: 'hid the site',
  });

  assert.equal(res.status, 200);
  assert.ok(
    db.prepare('SELECT handled_at FROM reports WHERE id = ?').get(reportId).handled_at,
    'a handled report must carry the timestamp that takes it out of the queue',
  );

  // §4: "Every admin action, so there's a record of what was done and why."
  const entry = db
    .prepare('SELECT site_id, action, reason FROM moderation_log ORDER BY id DESC')
    .get();
  assert.equal(entry.action, 'report_handled');
  assert.equal(entry.site_id, id);
  assert.equal(entry.reason, 'hid the site');

  assert.equal((await adminPost(app, '/admin/reports/9999/handle')).status, 404);
});

test('hiding a site takes it out of the OPML and moves the ETag', async () => {
  const { app, id } = adminApp();

  const before = await app.request('/subscriptions.opml');
  const beforeBody = await before.text();
  assert.match(beforeBody, /spammer\.example/);

  await adminPost(app, `/admin/sites/${id}/hide`, { reason: 'spam' });

  const after = await app.request('/subscriptions.opml');
  assert.ok(!(await after.text()).includes('spammer.example'));
  // §7: without the version bump the removal sits in every cache that holds the old
  // document — the moderation lever works and nobody downstream ever finds out.
  assert.notEqual(after.headers.get('etag'), before.headers.get('etag'));
  assert.ok(after.headers.get('etag'));
});

test('an unhide re-verifies the site and applies the pass', async () => {
  const asked = [];
  const { app, db, queries, id } = adminApp({
    verifySite: async (url, options) => {
      asked.push({ url, options });
      return {
        ok: true,
        url,
        feedUrl: 'https://spammer.example/rss.xml',
        title: 'Reformed',
        description: 'Now behaving',
        features: { has_source_ns: true, has_rsscloud: false, rsscloud_style: null },
      };
    },
  });
  queries.hideSite(id, 'spam');
  db.prepare('UPDATE sites SET failure_count = 2 WHERE id = ?').run(id);

  const res = await adminPost(app, `/admin/sites/${id}/unhide`, { reason: 'appealed' });
  assert.equal(res.status, 200);

  // Phase 8a's note: an unhide re-verifies, and with `fixedCanonical` — the canonical
  // URL is never re-derived, so an unhide cannot move the row onto another row's URL.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, 'https://spammer.example/');
  assert.equal(asked[0].options.fixedCanonical, true);

  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  assert.equal(row.status, 'active');
  assert.equal(row.title, 'Reformed', 'the fresh verification must be applied');
  assert.equal(row.has_source_ns, 1);
  assert.equal(row.failure_count, 0);
});

test('an unhide pings the OPML, a hide does not', async () => {
  const { app, queries, id, pings } = adminApp();

  // A hide is a change to the document too, but the ping asks the cloud server to
  // *fetch* — and a takedown reaches caches through the ETag on their next poll
  // either way. An unhide is indistinguishable from a join on the subscriber's side.
  await adminPost(app, `/admin/sites/${id}/hide`, { reason: 'spam' });
  assert.deepEqual(pings, []);

  queries.hideSite(id, 'still spam');
  await adminPost(app, `/admin/sites/${id}/unhide`, { reason: 'appealed' });
  assert.deepEqual(pings, ['opml']);
});

test('an unhide whose re-verification fails still unhides, and writes no failure', async () => {
  const { app, db, queries, id } = adminApp({
    verifySite: async () => ({ ok: false, reason: 'timeout' }),
  });
  queries.hideSite(id, 'spam');

  const res = await adminPost(app, `/admin/sites/${id}/unhide`, { reason: 'appealed' });

  // The admin's decision is authoritative — an unreachable site does not veto it.
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  assert.equal(row.status, 'active');
  // ...and a failed re-verification writes nothing: starting the 3-strike clock on
  // an unhide would delist the site again in a fortnight for the admin's own action.
  assert.equal(row.failure_count, 0);
  assert.equal(row.last_error, null);
});
