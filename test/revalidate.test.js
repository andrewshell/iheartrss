/**
 * Plan §11: "the §8 outcome split, where the removal promise actually lives."
 *
 * Everything here runs against a real in-memory database and a **fake verifier** —
 * `verifySite` is a function, so the four outcomes are expressed as the structured
 * results §5 really returns (`ok: true`, `no_linkback`, `blocked_by_site`,
 * `timeout`, `page_too_large`, …) rather than as pre-classified outcomes. The
 * ordered table in §8 is the thing under test, so a fake that returned "opt-out"
 * would be testing nothing.
 *
 * The clock is injected too. Nothing here sleeps: a test that waits 24 hours for
 * the second opt-out sighting is a test nobody runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/index.js';
import { createRevalidator } from '../src/jobs/revalidate.js';
import { createSemaphore } from '../src/lib/ratelimit.js';
import { createPersister } from '../src/verify/persist.js';

const CONFIG = Object.freeze({
  revalidateEnabled: true,
  revalidateBatch: 20,
  revalidateIntervalDays: 6,
  optoutFollowupHours: 24,
  optoutExpiryDays: 14,
  submitBudgetMs: 5000,
  linkbackHosts: Object.freeze(['iheartrss.com']),
  healthcheckPingUrl: null,
});

const T0 = Date.parse('2026-07-29T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const iso = (t) => new Date(t).toISOString();

/**
 * A site row in a chosen state. `checkedDaysAgo` is what the selection query reads,
 * so it is the one field every scheduling test has to set.
 */
function seedSite(db, {
  host = 'member.example',
  path = '/',
  status = 'active',
  checkedDaysAgo = 7,
  verifiedDaysAgo = checkedDaysAgo,
  failureCount = 0,
  optoutSeenAt = null,
  feedUrl = null,
  at = T0,
} = {}) {
  const url = `https://${host}${path}`;
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO sites (url, submitted_url, host, path, feed_url, title,
         status, failure_count, optout_seen_at, created_at,
         last_verified_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      url,
      url,
      host,
      path,
      feedUrl ?? `https://${host}${path}feed.xml`,
      `${host}'s blog`,
      status,
      failureCount,
      optoutSeenAt,
      iso(at - 400 * DAY),
      iso(at - verifiedDaysAgo * DAY),
      iso(at - checkedDaysAgo * DAY),
    );

  return Number(lastInsertRowid);
}

const rowOf = (db, id) => db.prepare('SELECT * FROM sites WHERE id = ?').get(id);

/** A successful §5 result for a row, in the shape `verifySite` returns. */
function passResult(row) {
  return {
    ok: true,
    url: row.url,
    submittedUrl: row.submitted_url,
    feedUrl: row.feed_url,
    title: row.title,
    description: undefined,
    features: { has_source_ns: false, has_rsscloud: false, rsscloud_style: null },
  };
}

/**
 * A revalidator wired to `db` with a fake verifier and a clock the test moves by
 * hand. `answer` is `(row) => result`; it records what was asked.
 */
function harness(db, queries, answer, { at = T0, config = {} } = {}) {
  const clock = { t: at };
  const asked = [];
  const logged = [];

  const revalidator = createRevalidator({
    queries,
    config: { ...CONFIG, ...config },
    now: () => new Date(clock.t),
    log: (msg, fields) => logged.push({ msg, ...fields }),
    // No test sleeps: the inter-site delay and the per-host spacing are both
    // driven by the injected clock instead.
    sleep: async () => {},
    verifySite: async (url, options) => {
      asked.push({ url, options });
      const row = db.prepare('SELECT * FROM sites WHERE url = ?').get(url);
      return answer(row ?? { url }, asked.length);
    },
  });

  return { revalidator, clock, asked, logged };
}

test('a due active row is revalidated and a hidden row never is', async () => {
  const { db, queries } = createDb(':memory:');

  const active = seedSite(db, { host: 'active.example', checkedDaysAgo: 7 });
  const hidden = seedSite(db, {
    host: 'hidden.example',
    status: 'hidden',
    checkedDaysAgo: 400,
  });
  const fresh = seedSite(db, { host: 'fresh.example', checkedDaysAgo: 1 });

  const { revalidator, asked } = harness(db, queries, (row) => passResult(row));
  const summary = await revalidator.runOnce();

  // §4: "`hidden` — never revalidated." It is 400 days overdue and last in line by
  // every other measure, which is exactly why it has to be excluded by status and
  // not by cadence.
  assert.deepEqual(
    asked.map((a) => a.url),
    ['https://active.example/'],
  );
  assert.equal(summary.checked, 1);
  assert.equal(rowOf(db, hidden).last_checked_at, iso(T0 - 400 * DAY));
  assert.equal(rowOf(db, fresh).last_checked_at, iso(T0 - 1 * DAY));
  assert.equal(rowOf(db, active).last_checked_at, iso(T0));
});

// ── The opt-out branch (§8's second row) ─────────────────────────────────────────
// "Remove the link and you'll be removed within a week" is the promise; these are
// the mechanics that make it true without a single 200-without-a-badge being
// terminal.

const noLinkback = (row) => ({
  ok: false,
  reason: 'no_linkback',
  url: row.url,
  submittedUrl: row.submitted_url,
  feedUrl: row.feed_url,
});

test('a 2xx page with the link-back gone records the sighting and stays listed', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7 });

  const { revalidator } = harness(db, queries, noLinkback);
  await revalidator.runOnce();

  const row = rowOf(db, id);
  assert.equal(row.optout_seen_at, iso(T0));
  // §8: "1st sighting → record `optout_seen_at`, **stay listed**." A redesign that
  // temporarily drops the footer, a platform migration, a Cloudflare JS challenge
  // and a parked billing-lapse page are all 200-without-a-badge, and with no
  // accounts and no email there is nothing to notify the member with.
  assert.equal(row.status, 'active');
  assert.deepEqual(queries.listOutlines().map((o) => o.id), [id]);
  // Not a failure either: the 3-strike counter is for outages, not for opt-outs.
  assert.equal(row.failure_count, 0);
});

test('only a second sighting at least 24h later sets removed, and clears the field', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7 });

  const { revalidator, clock } = harness(db, queries, noLinkback);
  await revalidator.runOnce();
  assert.equal(rowOf(db, id).status, 'active');

  // §8's follow-up cadence: any row holding an `optout_seen_at` is re-checked at 24
  // hours regardless of status. At the ordinary 6-day cadence the confirming
  // sighting would land on day 12, and /about promises a week.
  clock.t = T0 + 25 * HOUR;
  await revalidator.runOnce();

  const row = rowOf(db, id);
  assert.equal(row.status, 'removed');
  // Cleared **in the same statement** (§8). Left set, the row stays on the 24-hour
  // arm forever instead of the 90-day retry, and we poll someone who explicitly
  // asked to be left alone 365 times a year — from a site whose entire pitch is
  // being a good citizen. It would also eat the dormant batch quota.
  assert.equal(row.optout_seen_at, null);
  assert.deepEqual(queries.listOutlines(), []);
});

test('a sighting less than 24h old is never the confirming one', async () => {
  const { db, queries } = createDb(':memory:');
  // The shape a /recheck-recorded first sighting leaves behind: a fresh
  // `optout_seen_at` on a row whose `last_checked_at` is still the scheduler's, so
  // the row is due on the follow-up arm immediately.
  const id = seedSite(db, { checkedDaysAgo: 7, optoutSeenAt: iso(T0 - HOUR) });

  const { revalidator } = harness(db, queries, noLinkback);
  await revalidator.runOnce();

  const row = rowOf(db, id);
  // §8: "two rechecks 24h apart let a third party delist someone in 24h instead of
  // ~6 days" — the 24h floor is what stops the same trick with one recheck and one
  // ordinary tick.
  assert.equal(row.status, 'active');
  assert.equal(row.optout_seen_at, iso(T0 - HOUR), 'the first sighting stands');
});

test('a sighting older than 14 days is discarded and the clock restarts', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7, optoutSeenAt: iso(T0 - 20 * DAY) });

  const { revalidator } = harness(db, queries, noLinkback);
  await revalidator.runOnce();

  const row = rowOf(db, id);
  // §6: without an upper bound an attacker rechecks a victim during any innocent
  // 200-without-badge moment, that sighting sits there indefinitely — a Transient
  // outcome doesn't clear it — and months later the first bad scheduler tick becomes
  // the confirming one. The 24h floor collapses to "one bad moment, ever".
  assert.equal(row.status, 'active');
  assert.equal(row.optout_seen_at, iso(T0), 'restarted, not confirmed');
});

test('a pass clears a pending sighting', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, {
    status: 'failing',
    failureCount: 2,
    checkedDaysAgo: 7,
    optoutSeenAt: iso(T0 - 2 * DAY),
  });

  const { revalidator } = harness(db, queries, passResult);
  await revalidator.runOnce();

  const row = rowOf(db, id);
  assert.equal(row.status, 'active');
  assert.equal(row.failure_count, 0);
  assert.equal(row.optout_seen_at, null);
  assert.equal(row.last_verified_at, iso(T0));
});

test('an already-removed row is not re-sighted, and a pass reactivates it', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { status: 'removed', checkedDaysAgo: 91 });

  // §8: the opt-out branch is "skipped entirely for rows already `removed`" —
  // otherwise the 90-day retry restarts the two-sighting dance and polls people who
  // asked to be left alone ~8 times a year.
  const stillGone = harness(db, queries, noLinkback);
  await stillGone.revalidator.runOnce();

  let row = rowOf(db, id);
  assert.equal(row.status, 'removed');
  assert.equal(row.optout_seen_at, null);
  assert.equal(row.last_checked_at, iso(T0), 'but we did look, so it leaves the batch');

  // "Retried at the slow 90-day cadence rather than never … it's the only way
  // recovery happens without the member noticing unprompted" (§4).
  const back = harness(db, queries, passResult, { at: T0 + 91 * DAY });
  await back.revalidator.runOnce();

  row = rowOf(db, id);
  assert.equal(row.status, 'active');
  assert.deepEqual(queries.listOutlines().map((o) => o.id), [id]);
});

// ── The transient branch (§8's fourth row) ────────────────────────────────────────
// "The 3-strike grace exists so a server outage doesn't cost someone their listing."

test('a timeout, a 500, a broken feed and a size cap each take the 3-strike path', async () => {
  // Every one of these is a reason code §5 really produces, and every one of them
  // must NOT be read as an opt-out. `page_too_large` is the sharpest case: §8 —
  // "otherwise any member whose homepage grows past the cap has their badge cut off
  // mid-document, parses 'fine', and is silently delisted for the crime of writing a
  // long page." `no_feed_link` is the Cloudflare "Just a moment…" interstitial: a
  // 200 that parses, carries no badge and declares no feed.
  const reasons = [
    { reason: 'timeout' },
    { reason: 'page_fetch_failed', status: 500 },
    { reason: 'feed_invalid' },
    { reason: 'feed_fetch_failed', status: 404 },
    { reason: 'page_too_large' },
    { reason: 'no_feed_link' },
  ];

  for (const failure of reasons) {
    const { db, queries } = createDb(':memory:');
    const id = seedSite(db, { checkedDaysAgo: 7 });
    const { revalidator, clock } = harness(db, queries, (row) => ({
      ok: false,
      url: row.url,
      ...failure,
    }));

    await revalidator.runOnce();
    let row = rowOf(db, id);
    assert.equal(row.status, 'failing', `${failure.reason}: strike 1`);
    assert.equal(row.failure_count, 1, `${failure.reason}: strike 1`);
    assert.equal(row.optout_seen_at, null, `${failure.reason} is not an opt-out`);
    // §4: `failing` is "still in the OPML (grace period)".
    assert.equal(queries.listOutlines().length, 1, `${failure.reason}: strike 1 listed`);

    clock.t = T0 + 7 * DAY;
    await revalidator.runOnce();
    row = rowOf(db, id);
    assert.equal(row.status, 'failing', `${failure.reason}: strike 2`);
    assert.equal(row.failure_count, 2, `${failure.reason}: strike 2`);
    assert.equal(queries.listOutlines().length, 1, `${failure.reason}: strike 2 listed`);

    clock.t = T0 + 14 * DAY;
    await revalidator.runOnce();
    row = rowOf(db, id);
    assert.equal(row.status, 'dropped', `${failure.reason}: strike 3`);
    assert.equal(row.failure_count, 3, `${failure.reason}: strike 3`);
    assert.equal(row.last_error, failure.reason, `${failure.reason} is recorded`);
    assert.deepEqual(queries.listOutlines(), [], `${failure.reason}: dropped is delisted`);
  }
});

test('a transient failure on a removed row does not put it back in the OPML', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { status: 'removed', checkedDaysAgo: 91 });

  const { revalidator } = harness(db, queries, () => ({ ok: false, reason: 'timeout' }));
  await revalidator.runOnce();

  // §8: for a `removed` row "only a Pass matters". A 'failing' status here would
  // re-list someone who opted out, on the strength of a DNS blip.
  const row = rowOf(db, id);
  assert.equal(row.status, 'removed');
  assert.deepEqual(queries.listOutlines(), []);
});

// ── The blocked branch (§8's third row) ───────────────────────────────────────────

const blockedBySite = (row) => ({
  ok: false,
  reason: 'blocked_by_site',
  status: 403,
  url: row.url,
});

test('a persistent 403 goes to blocked and stays in the OPML', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7 });

  const { revalidator, clock } = harness(db, queries, blockedBySite);
  await revalidator.runOnce();
  clock.t = T0 + 7 * DAY;
  await revalidator.runOnce();

  const row = rowOf(db, id);
  // §4: "not the member's failure and often not something they can fix: Cloudflare
  // Bot Fight Mode, AWS WAF and Vercel's bot filter all 403 a datacenter IP.
  // Verified live — medium.com/@dhh returns 403 to a full Chrome UA." Without this
  // state, enabling bot protection silently costs a member their listing in 18 days
  // for doing nothing wrong.
  assert.equal(row.status, 'blocked');
  assert.equal(row.failure_count, 0, 'a 403 is not a strike');
  assert.equal(row.optout_seen_at, null, 'and never an opt-out');
  assert.deepEqual(queries.listOutlines().map((o) => o.id), [id]);
});

test('a 403 never promotes a dropped or removed row into the OPML', async () => {
  const { db, queries } = createDb(':memory:');
  // §4: `blocked` is "only reachable from active/failing, never at submission".
  const dropped = seedSite(db, { host: 'dropped.example', status: 'dropped', checkedDaysAgo: 31 });
  const removed = seedSite(db, { host: 'removed.example', status: 'removed', checkedDaysAgo: 91 });

  const { revalidator } = harness(db, queries, blockedBySite);
  await revalidator.runOnce();

  assert.equal(rowOf(db, dropped).status, 'dropped');
  assert.equal(rowOf(db, removed).status, 'removed');
  assert.deepEqual(queries.listOutlines(), []);

  // …and both still leave the batch. A row whose outcome changes nothing must
  // still have `last_checked_at` moved, or it is re-selected on every tick for the
  // rest of time and quietly eats the dormant quota that exists to stop dead rows
  // starving live ones (§8).
  assert.equal(rowOf(db, dropped).last_checked_at, iso(T0));
  assert.equal(rowOf(db, removed).last_checked_at, iso(T0));
});

test('a row blocked for more than 90 days is demoted to dropped', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { status: 'blocked', checkedDaysAgo: 7, verifiedDaysAgo: 120 });

  const { revalidator } = harness(db, queries, blockedBySite);
  await revalidator.runOnce();

  // §4: "`blocked` needs an exit: after 90 consecutive days blocked, demote to
  // `dropped`. Otherwise parked and expired domains sitting behind a Cloudflare 403
  // accumulate in every subscriber's OPML permanently, since /recheck treats
  // `blocked` as a no-op and only an admin can clear it."
  assert.equal(rowOf(db, id).status, 'dropped');
  assert.deepEqual(queries.listOutlines(), []);
});

// ── Scheduling (§8) ───────────────────────────────────────────────────────────────

test('accumulated dropped rows do not starve the active ones', async () => {
  const { db, queries } = createDb(':memory:');

  // The state §8 warns about: a few hundred dead domains, every one of them more
  // overdue than any live member. Ordered by `last_checked_at` alone they take the
  // whole batch and live members stop being revalidated at all — "the 'within a
  // week' promise fails first for exactly the sites that matter most."
  for (let i = 0; i < 40; i += 1) {
    seedSite(db, { host: `dead${i}.example`, status: 'dropped', checkedDaysAgo: 60 + i });
  }
  const live = [];
  for (let i = 0; i < 8; i += 1) {
    live.push(seedSite(db, { host: `live${i}.example`, checkedDaysAgo: 7 }));
  }

  const { revalidator, asked } = harness(db, queries, passResult, {
    config: { revalidateBatch: 10 },
  });
  await revalidator.runOnce();

  const hosts = asked.map((a) => new URL(a.url).hostname);
  const liveChecked = hosts.filter((h) => h.startsWith('live'));
  const deadChecked = hosts.filter((h) => h.startsWith('dead'));

  assert.equal(hosts.length, 10, 'the batch is REVALIDATE_BATCH');
  assert.equal(liveChecked.length, 8, 'every due live member is checked');
  // §8's quota: "e.g. 16 active/failing + 4 dropped/removed" — a fifth of the batch.
  assert.equal(deadChecked.length, 2);
});

test('the live arm gets the whole batch when nothing dormant is due', async () => {
  const { db, queries } = createDb(':memory:');
  for (let i = 0; i < 6; i += 1) {
    seedSite(db, { host: `live${i}.example`, checkedDaysAgo: 7 });
  }
  seedSite(db, { host: 'recentlydropped.example', status: 'dropped', checkedDaysAgo: 10 });

  const { revalidator, asked } = harness(db, queries, passResult, {
    config: { revalidateBatch: 6 },
  });
  await revalidator.runOnce();

  // `dropped` is 30 days, so the 10-day-old one is not due; the quota is a cap on
  // dormant rows, not a reservation that shrinks the live batch.
  assert.equal(asked.length, 6);
  assert.ok(asked.every((a) => a.url.includes('live')));
});

test('a row on the opt-out follow-up cadence outranks everything else', async () => {
  const { db, queries } = createDb(':memory:');
  const active = seedSite(db, { host: 'active.example', checkedDaysAgo: 300 });
  const pending = seedSite(db, {
    host: 'pending.example',
    checkedDaysAgo: 2,
    optoutSeenAt: iso(T0 - 2 * DAY),
  });

  const { revalidator, asked } = harness(db, queries, noLinkback, {
    config: { revalidateBatch: 1 },
  });
  await revalidator.runOnce();

  // The removal clock is the tightest promise the site makes, and 24 hours is the
  // budget it has (§8). A row 300 days overdue does not get to spend it.
  assert.deepEqual(asked.map((a) => a.url), ['https://pending.example/']);
  assert.equal(rowOf(db, pending).status, 'removed');
  assert.equal(rowOf(db, active).status, 'active');
});

test('a slow batch does not overlap the next tick', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7 });

  let release;
  const hang = new Promise((resolve) => { release = resolve; });

  const { revalidator, logged } = harness(db, queries, async () => {
    await hang;
    return { ok: false, reason: 'timeout' };
  });

  const slow = revalidator.runOnce();
  // §8's `running` guard. Without it a batch that outlives the hour — 20 sites × a
  // 30s budget is 10 minutes, and a tarpit host makes that arbitrarily worse —
  // overlaps the next tick and every site in it is failed twice, so the 3-strike
  // grace period silently becomes a 1.5-strike one.
  // Raced against a timer so a regression fails in half a second instead of
  // deadlocking the suite: without the guard this call blocks on the same hung
  // fetch as the first one.
  const overlapping = await Promise.race([
    revalidator.runOnce(),
    new Promise((resolve) => { setTimeout(() => resolve({ skipped: 'test_timeout' }), 500); }),
  ]);

  assert.equal(overlapping.skipped, 'already_running');
  assert.equal(overlapping.checked, 0);

  release();
  await slow;

  assert.equal(rowOf(db, id).failure_count, 1, 'one tick, one strike');
  assert.ok(logged.some((entry) => entry.msg === 'revalidate.skipped'));
});

test('one host is not hit twice within a few minutes', async () => {
  const { db, queries } = createDb(':memory:');
  // §8: "a batch containing 20 members on mastodon.social or micro.blog would
  // otherwise hammer one host 20 times in ~40 seconds and trip its rate limiter,
  // which then reads back as a transient failure for all of them."
  const a = seedSite(db, { host: 'mastodon.social', path: '/@alice/', checkedDaysAgo: 7 });
  const b = seedSite(db, { host: 'mastodon.social', path: '/@bob/', checkedDaysAgo: 8 });
  const elsewhere = seedSite(db, { host: 'other.example', checkedDaysAgo: 7 });

  const { revalidator, clock, asked } = harness(db, queries, passResult);
  await revalidator.runOnce();

  // The most overdue of the two shares the batch with nobody else on its host; the
  // second is deferred to a later tick, which is why it must NOT be marked checked.
  assert.deepEqual(asked.map((entry) => entry.url).sort(), [
    'https://mastodon.social/@bob/',
    'https://other.example/',
  ]);
  assert.equal(rowOf(db, a).last_checked_at, iso(T0 - 7 * DAY), 'deferred, not failed');
  assert.equal(rowOf(db, a).failure_count, 0);
  assert.equal(rowOf(db, b).last_checked_at, iso(T0));

  // Once the spacing has elapsed the deferred row is checked normally.
  clock.t = T0 + 10 * 60 * 1000;
  await revalidator.runOnce();

  assert.equal(rowOf(db, a).last_checked_at, iso(T0 + 10 * 60 * 1000));
});

test('a UNIQUE feed_url collision mid-batch is logged and skipped, not fatal', async () => {
  const { db, queries } = createDb(':memory:');
  const first = seedSite(db, { host: 'first.example', checkedDaysAgo: 9 });
  const collider = seedSite(db, { host: 'collider.example', checkedDaysAgo: 8 });
  const last = seedSite(db, { host: 'last.example', checkedDaysAgo: 7 });

  // §8: "`feed_url` is UNIQUE and revalidation is allowed to change it, so two rows
  // converging on one feed raises a constraint violation mid-batch — which in Node
  // 24 terminates the process on an unhandled rejection. On conflict: log and skip."
  const { revalidator, logged } = harness(db, queries, (row) =>
    row.id === collider
      ? passResult({ ...row, feed_url: 'https://first.example/feed.xml' })
      : passResult(row),
  );

  const summary = await revalidator.runOnce();

  assert.equal(summary.checked, 2, 'the batch survives the collision');
  assert.equal(rowOf(db, collider).last_checked_at, iso(T0 - 8 * DAY), 'nothing written');
  assert.equal(rowOf(db, last).last_checked_at, iso(T0), 'and the batch continues');
  assert.equal(rowOf(db, first).last_checked_at, iso(T0));
  assert.ok(
    logged.some((entry) => entry.msg === 'revalidate.site_failed' && entry.site_id === collider),
  );
});

// ── Retention (§4, purged on the revalidation tick) ───────────────────────────────

test('the tick purges old submissions and year-old dropped rows', async () => {
  const { db, queries } = createDb(':memory:');

  const submission = (daysAgo) =>
    db
      .prepare(
        `INSERT INTO submissions (submitted_url, ip_hash, result, created_at)
         VALUES ('https://x.example/', 'hash', 'added', ?)`,
      )
      .run(iso(T0 - daysAgo * DAY));

  submission(89);
  submission(91);
  submission(400);

  // Not due for a check, so the purge is the only thing that can touch it.
  const stale = seedSite(db, {
    host: 'gone.example',
    status: 'dropped',
    checkedDaysAgo: 1,
    verifiedDaysAgo: 400,
  });
  const recent = seedSite(db, {
    host: 'recentlydropped.example',
    status: 'dropped',
    checkedDaysAgo: 1,
    verifiedDaysAgo: 100,
  });

  // §4: `reports.site_id` is `ON DELETE SET NULL` "not the default: with
  // foreign_keys = ON, deleting a site that was ever reported raises FOREIGN KEY
  // constraint failed — inside the revalidation tick that runs the year-old-
  // dropped-row purge, aborting the rest of the batch."
  queries.insertReport({ site_id: stale, url: 'https://gone.example/', reason: 'spam', ip_hash: 'h' });

  const { revalidator } = harness(db, queries, passResult);
  await revalidator.runOnce();

  // §4: "A salted IP hash is still personal data; purge rows older than 90 days on
  // the revalidation tick, and say so in the privacy note on /about."
  const kept = db.prepare('SELECT created_at FROM submissions').all();
  assert.deepEqual(kept.map((r) => r.created_at), [iso(T0 - 89 * DAY)]);

  assert.equal(rowOf(db, stale), undefined);
  assert.ok(rowOf(db, recent), 'a recently dropped row is still retried');

  const report = db.prepare('SELECT * FROM reports').get();
  assert.ok(report, 'the audit trail survives the site row');
  assert.equal(report.site_id, null);
  assert.equal(report.url, 'https://gone.example/');
});

// ── The tick's edges: monitoring, isolation, scheduling (§8, §9) ───────────────────

test('each batch pings HEALTHCHECK_PING_URL, and a failed ping is not a failed batch', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7 });

  const pings = [];
  const revalidator = createRevalidator({
    queries,
    config: { ...CONFIG, healthcheckPingUrl: 'https://hc-ping.com/uuid' },
    now: () => new Date(T0),
    sleep: async () => {},
    verifySite: async (url) => passResult(db.prepare('SELECT * FROM sites WHERE url = ?').get(url)),
    pingFetch: async (url) => {
      pings.push(url);
      throw new Error('hc-ping.com is down');
    },
  });

  const summary = await revalidator.runOnce();

  assert.deepEqual(pings, ['https://hc-ping.com/uuid']);
  assert.equal(summary.checked, 1);
  assert.equal(rowOf(db, id).last_checked_at, iso(T0), 'the batch still happened');
});

test('the scheduler is not blocked by a saturated public semaphore', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7 });

  // §8: "the scheduler holds a reserved outbound slot OUTSIDE the public semaphore.
  // Otherwise 4 concurrent /recheck calls aimed at a tarpit host hold every slot for
  // the full budget, stalling revalidation — and with it the 'removed within a week'
  // clock." Four never-finishing public verifications, and the tick still runs.
  const semaphore = createSemaphore(4);
  const tarpit = new Promise(() => {});
  for (let i = 0; i < 4; i += 1) semaphore.run(() => tarpit);

  const { revalidator } = harness(db, queries, passResult);
  const summary = await revalidator.runOnce();

  assert.equal(summary.checked, 1);
  assert.equal(rowOf(db, id).last_checked_at, iso(T0));
});

test("start schedules a boot run and an hourly unref'd tick that stop clears", async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7 });

  const scheduled = [];
  const cleared = [];
  const handle = (kind, fn, ms) => {
    const h = { kind, fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } };
    scheduled.push(h);
    return h;
  };

  const { revalidator } = harness(db, queries, passResult, {
    config: {},
  });
  const started = revalidator.start({
    setInterval: (fn, ms) => handle('interval', fn, ms),
    clearInterval: (h) => cleared.push(h),
    setTimeout: (fn, ms) => handle('timeout', fn, ms),
    clearTimeout: (h) => cleared.push(h),
  });

  const boot = scheduled.find((h) => h.kind === 'timeout');
  const tick = scheduled.find((h) => h.kind === 'interval');

  // §8: "a run also fires ~30s after boot so a fresh container doesn't sit idle for
  // an hour", and the tick is hourly.
  assert.equal(boot.ms, 30_000);
  assert.equal(tick.ms, 60 * 60 * 1000);
  // `unref`'d (§8): a pending timer must not hold the process open through a
  // SIGTERM, or every dockge redeploy waits for Docker's 10s grace period.
  assert.ok(boot.unrefd && tick.unrefd);
  assert.equal(started, true);

  await boot.fn();
  assert.equal(rowOf(db, id).last_checked_at, iso(T0), 'the boot run really runs');

  revalidator.stop();
  assert.equal(cleared.length, 2);
});

test('a disabled scheduler schedules nothing', async () => {
  const { db, queries } = createDb(':memory:');
  const { revalidator } = harness(db, queries, passResult, {
    config: { revalidateEnabled: false },
  });

  // §9: "REVALIDATE_ENABLED — off in dev/tests." Off has to mean no timers at all,
  // not a tick that runs and finds nothing.
  const started = revalidator.start({
    setInterval: () => assert.fail('scheduled an interval while disabled'),
    setTimeout: () => assert.fail('scheduled a boot run while disabled'),
  });

  assert.equal(started, false);
});

// ── Conditional GETs (§8) ─────────────────────────────────────────────────────────

test('the stored validators are sent, and a 304 keeps the metadata it cannot see', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7 });
  db.prepare('UPDATE sites SET feed_etag = ?, feed_last_modified = ? WHERE id = ?')
    .run('"v1"', 'Wed, 01 Jul 2026 10:00:00 GMT', id);

  const before = rowOf(db, id);
  const { revalidator, asked } = harness(db, queries, (row) => ({
    ok: true,
    url: row.url,
    feedUrl: row.feed_url,
    // What `verifySite` returns behind a 304: no body, so no title, no description
    // and no features.
    feedUnchanged: true,
    feedEtag: '"v1"',
    feedLastModified: 'Wed, 01 Jul 2026 10:00:00 GMT',
  }));

  await revalidator.runOnce();

  // §8: "send If-None-Match / If-Modified-Since from feed_etag / feed_last_modified.
  // A 304 is the cheapest possible way to honour the 'good citizen' claim."
  assert.deepEqual(asked[0].options.conditional, {
    feedUrl: before.feed_url,
    etag: '"v1"',
    lastModified: 'Wed, 01 Jul 2026 10:00:00 GMT',
  });
  assert.equal(asked[0].options.fixedCanonical, true);

  const row = rowOf(db, id);
  assert.equal(row.status, 'active');
  assert.equal(row.last_verified_at, iso(T0));
  // `title` is NOT NULL, so writing the absent one is a constraint failure caught by
  // the loop — a 304 would silently stop counting as a successful check.
  assert.equal(row.title, before.title);
  assert.equal(row.feed_url, before.feed_url);
});

test('a fresh validator from a 200 is stored for next time', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { checkedDaysAgo: 7 });

  const { revalidator } = harness(db, queries, (row) => ({
    ...passResult(row),
    title: 'Renamed blog',
    feedEtag: '"v2"',
    feedLastModified: 'Thu, 02 Jul 2026 10:00:00 GMT',
  }));
  await revalidator.runOnce();

  const row = rowOf(db, id);
  assert.equal(row.feed_etag, '"v2"');
  assert.equal(row.feed_last_modified, 'Thu, 02 Jul 2026 10:00:00 GMT');
  // §4: the version bump is a blanket rule because "an enumerated list of
  // OPML-relevant mutations WILL miss title/description changes on re-verification,
  // and title is the ORDER BY key."
  assert.equal(row.title, 'Renamed blog');
});

// ── Recovery (§4) ─────────────────────────────────────────────────────────────────

test('a re-added link plus a resubmit reactivates a removed row immediately', async () => {
  const { db, queries } = createDb(':memory:');
  const id = seedSite(db, { status: 'removed', checkedDaysAgo: 91 });
  const row = rowOf(db, id);

  const persist = createPersister({
    queries,
    config: { ...CONFIG, maxListingsPerDomain: 5, maxNewListingsPerDay: 50 },
    safeFetch: async () => ({ ok: false, reason: 'unexpected_fetch' }),
  });

  const outcome = await persist({
    ok: true,
    url: row.url,
    submittedUrl: row.url,
    feedUrl: row.feed_url,
    title: 'A blog, still',
    features: { has_source_ns: false, has_rsscloud: false, rsscloud_style: null },
  });

  // §4: "Re-adding the link and resubmitting also reactivates immediately" — the 90-day
  // retry is the fallback for a member who never notices, not the only way back.
  assert.equal(outcome.outcome, 'updated');
  assert.equal(rowOf(db, id).status, 'active');
  assert.equal(rowOf(db, id).optout_seen_at, null);
  assert.deepEqual(queries.listOutlines().map((o) => o.id), [id]);
});

test('a verifier that throws does not abort the rest of the batch', async () => {
  const { db, queries } = createDb(':memory:');
  const boom = seedSite(db, { host: 'boom.example', checkedDaysAgo: 9 });
  const after = seedSite(db, { host: 'after.example', checkedDaysAgo: 7 });

  const { revalidator, logged } = harness(db, queries, (row) => {
    if (row.id === boom) throw new TypeError('undici exploded');
    return passResult(row);
  });

  // `verifySite` is documented never to throw for an expected failure, but "never
  // throws" is a claim about intent, and an unhandled rejection inside an hourly
  // timer terminates the process in Node 24.
  const summary = await revalidator.runOnce();

  assert.equal(summary.checked, 1);
  assert.equal(rowOf(db, after).last_checked_at, iso(T0));
  assert.ok(logged.some((entry) => entry.msg === 'revalidate.site_failed' && entry.site_id === boom));
});
