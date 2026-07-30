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
import { CONFIG as FIXTURE_CONFIG, FEED_TYPE, html, rss, withSites } from './helpers/sites.js';

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
  db.prepare("UPDATE sites SET failure_count = 3 WHERE id = ?").run(siteId);

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

  const status = (id) => db.prepare('SELECT status FROM sites WHERE id = ?').get(id).status;
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

function adminApp({ adminToken = TOKEN } = {}) {
  const { db, queries } = createDb(':memory:');
  const app = createApp({
    config: {
      siteUrl: 'https://iheartrss.com/',
      linkbackHosts: ['iheartrss.com'],
      maxListingsPerDomain: 5,
      maxNewListingsPerDay: 50,
      submitBudgetMs: 5000,
      trustProxy: false,
      trustedProxyHops: 0,
      adminToken,
    },
    db,
    queries,
    verifySite: async () => ({ ok: false, reason: 'no_linkback' }),
    ipHmacKey: Buffer.alloc(32, 3),
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

  return { app, db, queries, id };
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
  assert.equal(db.prepare('SELECT status FROM sites WHERE id = ?').get(id).status, 'hidden');
  assert.equal(db.prepare('SELECT action FROM moderation_log').get().action, 'hide');
});

test('a wrong-LENGTH admin token is a 401, not a 500', async () => {
  const { app, db, id } = adminApp();

  // §6: raw crypto.timingSafeEqual throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on
  // unequal lengths (verified), so a wrong-length guess 500s instead of 401-ing — a
  // crash per attempt AND a length oracle. Hashing both sides makes them 32 bytes.
  for (const token of ['x', 'short', 'a'.repeat(63), 'a'.repeat(65), 'b'.repeat(64), '']) {
    const res = await adminPost(app, `/admin/sites/${id}/hide`, {}, token);
    assert.equal(res.status, 401, `token ${JSON.stringify(token)} must be a 401`);
  }

  const missing = await adminPost(app, `/admin/sites/${id}/hide`, {}, null);
  assert.equal(missing.status, 401);

  assert.equal(db.prepare('SELECT status FROM sites WHERE id = ?').get(id).status, 'active');
});

test('no admin routes exist at all when ADMIN_TOKEN is unset', async () => {
  const { app, id } = adminApp({ adminToken: null });

  // §6: "No admin UI is served at all if ADMIN_TOKEN is unset." A 404 rather than a
  // 401 also means it isn't a probe for whether admin exists.
  assert.equal((await adminPost(app, `/admin/sites/${id}/hide`)).status, 404);
  assert.equal((await adminPost(app, '/admin/ban', { host: 'x.example' })).status, 404);
});

test('POST /admin/ban bans a host and hides its sites in one request', async () => {
  const { app, db, queries, id } = adminApp();

  const res = await adminPost(app, '/admin/ban', {
    host: 'Spammer.Example',
    reason: 'bulk spam',
  });

  assert.equal(res.status, 200);
  assert.ok(queries.findBan({ host: 'spammer.example', path: '/' }));
  assert.equal(db.prepare('SELECT status FROM sites WHERE id = ?').get(id).status, 'hidden');
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
