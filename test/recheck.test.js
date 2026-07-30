/**
 * `POST /recheck/:id` (plan §6, "Why /recheck/:id must be pass-only").
 *
 * Every test here is about what the route must REFUSE to write. The original
 * justification — "the only way to make it remove a site is to have already removed
 * the link-back, which only that site's owner can do" — reasoned about the opt-out
 * branch and ignored the transient one: rechecking also runs §8's 3-strike path, so
 * with a 1-hour cooldown anyone could force a healthy member from `active` to
 * `dropped` in three hours instead of the 18 days the grace period is for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db/index.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const iso = (t) => new Date(t).toISOString();

const CONFIG = Object.freeze({
  port: 3000,
  siteUrl: 'https://iheartrss.com/',
  linkbackHosts: ['iheartrss.com'],
  maxListingsPerDomain: 5,
  maxNewListingsPerDay: 50,
  submitBudgetMs: 5000,
  revalidateIntervalDays: 6,
  optoutFollowupHours: 24,
  optoutExpiryDays: 14,
  recheckCooldownMin: 60,
  trustProxy: false,
  trustedProxyHops: 0,
  adminToken: null,
});

function setup({ verify, config = {}, at = NOW } = {}) {
  const { db, queries } = createDb(':memory:');
  const clock = { t: at };
  const app = createApp({
    config: { ...CONFIG, ...config },
    db,
    queries,
    verifySite: verify ?? (async () => ({ ok: true })),
    ipHmacKey: Buffer.alloc(32, 7),
    now: () => new Date(clock.t),
  });
  return { app, db, queries, clock };
}

function seedSite(db, { host = 'member.example', status = 'active', failureCount = 0, optoutSeenAt = null, checkedDaysAgo = 3 } = {}) {
  const url = `https://${host}/`;
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO sites (url, submitted_url, host, path, feed_url, title, status,
         failure_count, optout_seen_at, created_at, last_verified_at, last_checked_at)
       VALUES (?, ?, ?, '/', ?, 'A blog', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      url,
      url,
      host,
      `https://${host}/feed.xml`,
      status,
      failureCount,
      optoutSeenAt,
      iso(NOW - 100 * DAY),
      iso(NOW - checkedDaysAgo * DAY),
      iso(NOW - checkedDaysAgo * DAY),
    );
  return Number(lastInsertRowid);
}

const rowOf = (db, id) => db.prepare('SELECT * FROM sites WHERE id = ?').get(id);

function post(app, path, headers = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', ...headers },
  });
}

const pass = (row) => ({
  ok: true,
  url: row?.url ?? 'https://member.example/',
  feedUrl: 'https://member.example/feed.xml',
  title: 'A blog',
  features: { has_source_ns: true, has_rsscloud: false, rsscloud_style: null },
});

test('a pass applies normally: failing goes back to active', async () => {
  const { app, db } = setup({ verify: async () => pass() });
  const id = seedSite(db, { status: 'failing', failureCount: 2 });

  const res = await post(app, `/recheck/${id}`);

  assert.equal(res.status, 200);
  const row = rowOf(db, id);
  // §6: "a pass applies normally (reset failure_count, status = 'active', clear
  // optout_seen_at)."
  assert.equal(row.status, 'active');
  assert.equal(row.failure_count, 0);
  assert.equal(row.has_source_ns, 1);
});

test('a transient failure is a no-op: /recheck can never advance failure_count', async () => {
  const { app, db, clock } = setup({ verify: async () => ({ ok: false, reason: 'timeout' }) });
  const id = seedSite(db, { failureCount: 0 });
  const before = rowOf(db, id);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await post(app, `/recheck/${id}`);
    assert.equal(res.status, 200);
    clock.t += 2 * HOUR; // past the cooldown, so the attempt really runs
  }

  // §6: "with a 1-hour cooldown ANYONE can force a healthy member from active to
  // dropped in three hours instead of the 18 days the grace period was designed to
  // give, timed against any window where the target is briefly down, mid-deploy,
  // rate-limiting us, or serving a CDN error. Three of four reviewers found this
  // independently."
  const row = rowOf(db, id);
  assert.equal(row.failure_count, 0);
  assert.equal(row.status, 'active');
  assert.equal(row.last_error, before.last_error);
  // And it must not touch the scheduler's clock either.
  assert.equal(row.last_checked_at, before.last_checked_at);
});

test('a blocked outcome is a no-op, logged and shown but never written', async () => {
  const { app, db } = setup({
    verify: async () => ({ ok: false, reason: 'blocked_by_site', status: 403 }),
  });
  const id = seedSite(db);

  const res = await post(app, `/recheck/${id}`);

  assert.equal(res.status, 200);
  assert.equal(rowOf(db, id).status, 'active', 'only the scheduler may set blocked');
});

test('/recheck may record a FIRST opt-out sighting but never the confirming one', async () => {
  const { app, db, clock } = setup({ verify: async () => ({ ok: false, reason: 'no_linkback' }) });
  const id = seedSite(db);

  await post(app, `/recheck/${id}`);

  const first = rowOf(db, id);
  assert.equal(first.optout_seen_at, iso(NOW));
  assert.equal(first.status, 'active');

  // 25 hours later — past the 24h floor — a second recheck must still not remove.
  clock.t = NOW + 25 * HOUR;
  await post(app, `/recheck/${id}`);

  const second = rowOf(db, id);
  // §8: "only the scheduler applies the second opt-out confirmation. Otherwise two
  // rechecks 24h apart let a third party delist someone in 24h instead of ~6 days —
  // and a member intermittently serving a Cloudflare JS interstitial (200, no badge,
  // an innocent cause this plan itself lists) is exactly who'd get caught."
  assert.equal(second.status, 'active');
  assert.equal(second.optout_seen_at, iso(NOW), 'the first sighting is not even refreshed');
});

test('a hidden row is excluded outright and answered neutrally', async () => {
  const verifications = [];
  const { app, db } = setup({
    verify: async (url) => {
      verifications.push(url);
      return pass();
    },
  });
  const id = seedSite(db, { status: 'hidden' });

  const res = await post(app, `/recheck/${id}`);
  const body = await res.text();

  // §6: without this, "may only improve state" reads hidden → active as an
  // improvement, and a moderated member who knows their id (from /status, or the
  // /sites#site-<id> link they were given when they joined) un-hides themselves with
  // one request — reopening, on a different route, exactly the hole §5 Step 7 closed
  // for /submit.
  assert.equal(res.status, 200);
  assert.equal(rowOf(db, id).status, 'hidden');
  assert.deepEqual(verifications, [], 'no outbound request is spent either');
  // The same neutral answer /submit gives, so it is not a moderation oracle.
  assert.match(body, /Already submitted/i);
  assert.doesNotMatch(body, /hidden|moderat/i);
});

test('/recheck has its own cooldown clock and cannot reset the scheduler’s', async () => {
  const verifications = [];
  const { app, db, clock } = setup({
    verify: async (url) => {
      verifications.push(url);
      return pass();
    },
  });
  const id = seedSite(db, { checkedDaysAgo: 3 });
  const before = rowOf(db, id);

  await post(app, `/recheck/${id}`);
  const afterFirst = rowOf(db, id);
  assert.equal(afterFirst.last_recheck_at, iso(NOW));

  // Inside RECHECK_COOLDOWN_MIN: refused without spending a fetch.
  const again = await post(app, `/recheck/${id}`);
  assert.equal(again.status, 429);
  assert.equal(verifications.length, 1);

  clock.t = NOW + 61 * 60 * 1000;
  await post(app, `/recheck/${id}`);
  assert.equal(verifications.length, 2);
  assert.equal(rowOf(db, id).last_recheck_at, iso(NOW + 61 * 60 * 1000));

  // §6: "with its own last_recheck_at cooldown clock so it can't reset the
  // scheduler's." A pass legitimately moves last_checked_at; what matters is that
  // the two clocks are separate columns.
  assert.notEqual(before.last_recheck_at, afterFirst.last_recheck_at);
  assert.equal(before.last_recheck_at, null);
});

test('/recheck is same-origin-only and rate-limited', async () => {
  const verifications = [];
  const { app, db } = setup({
    verify: async () => {
      verifications.push(1);
      return pass();
    },
  });
  const id = seedSite(db);

  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: 'https://attacker.example', 'sec-fetch-site': '' },
    { 'sec-fetch-site': '' },
  ]) {
    const res = await post(app, `/recheck/${id}`, headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
  }

  // §6: "a cross-origin auto-submitting form needs no preflight and no JS consent,
  // so any attacker page still drives our server at a victim URL."
  assert.equal(verifications.length, 0);
});

test('/recheck spends the shared submit rate limit', async () => {
  const { app, db } = setup({ verify: async () => pass() });
  // Distinct ids so the per-site cooldown is never what refuses us.
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(seedSite(db, { host: `m${i}.example` }));

  const statuses = [];
  for (const id of ids) statuses.push((await post(app, `/recheck/${id}`)).status);

  // §6: "in-memory token bucket — 5 submissions per 10 minutes … shared across
  // /submit, /check and /recheck."
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
});

test('an unknown id is a 404, not a 500', async () => {
  const { app } = setup();

  assert.equal((await post(app, '/recheck/999')).status, 404);
  assert.equal((await post(app, '/recheck/not-a-number')).status, 404);
});

test('/status offers the recheck as a form, since the route is POST-only', async () => {
  const { app, db } = setup();
  const id = seedSite(db);

  const res = await app.request('/status?url=https://member.example/');
  const body = await res.text();

  // The route is POST and same-origin-checked, so a form on our own page is the only
  // way a member can reach it at all. Without this it ships unreachable.
  assert.match(body, new RegExp(`action="/recheck/${id}"`));
  assert.match(body, /method="post"/i);
});

test('/status offers no recheck for a site it will not admit to having', async () => {
  const { app, db } = setup();
  seedSite(db, { status: 'hidden' });

  const res = await app.request('/status?url=https://member.example/');
  const body = await res.text();

  // §6: /status reports `hidden` as a neutral "not listed". A recheck button carrying
  // the row's id would hand back the id — and the existence — that neutrality hides.
  assert.doesNotMatch(body, /\/recheck\//);
});
