import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db/index.js';
import { createPersister } from '../src/verify/persist.js';

const CONFIG = Object.freeze({
  linkbackHosts: ['iheartrss.com'],
  maxListingsPerDomain: 5,
  maxNewListingsPerDay: 50,
  fetchTimeoutMs: 2000,
  submitBudgetMs: 5000,
});

/** A verification result in the shape `verifySite` returns on success. */
function verified(overrides = {}) {
  return {
    ok: true,
    url: 'https://alice.example/',
    submittedUrl: 'https://alice.example/',
    feedUrl: 'https://alice.example/rss.xml',
    title: 'Alice writes things',
    description: 'A blog',
    // The shape `verify/feed.js` actually produces, `undefined`s and all — those
    // are exactly what the §4 coercion boundary exists for.
    features: {
      has_source_ns: false,
      source_ns_prefix: null,
      has_rsscloud: false,
      rsscloud_style: null,
      cloud: undefined,
      cloud_url: undefined,
    },
    ...overrides,
  };
}

function setup({ config = {}, safeFetch } = {}) {
  const { db, queries } = createDb(':memory:');
  const persist = createPersister({
    queries,
    config: { ...CONFIG, ...config },
    safeFetch: safeFetch ?? (async () => ({ ok: false, reason: 'unexpected_fetch' })),
  });
  return { db, queries, persist };
}

test('a new verification is inserted and reported as added', async () => {
  const { db, queries, persist } = setup();
  const before = queries.getDirectoryVersion().version;

  const outcome = await persist(verified());

  assert.equal(outcome.outcome, 'added');
  assert.ok(outcome.siteId > 0);

  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(outcome.siteId);
  assert.equal(row.url, 'https://alice.example/');
  assert.equal(row.feed_url, 'https://alice.example/rss.xml');
  assert.equal(row.host, 'alice.example');
  assert.equal(row.path, '/');
  assert.equal(row.status, 'active');

  // §7: the OPML is cached on this counter, so an insert that doesn't bump it is
  // a member nobody's reader ever sees.
  assert.ok(queries.getDirectoryVersion().version > before);
});

test('re-submitting the same URL refreshes it and reports updated', async () => {
  const { db, queries, persist } = setup();
  const first = await persist(verified());

  db.prepare(
    "UPDATE sites SET failure_count = 2, status = 'failing', last_error = 'timeout', " +
      "optout_seen_at = '2026-01-01T00:00:00.000Z', last_verified_at = '2020-01-01T00:00:00.000Z' " +
      'WHERE id = ?',
  ).run(first.siteId);
  const versionAfterInsert = queries.getDirectoryVersion().version;

  const outcome = await persist(
    verified({ title: 'Alice writes better things', description: 'Now with more RSS' }),
  );

  // §5 Step 7: "Re-submitting is therefore a safe, idempotent 're-check me now'."
  assert.equal(outcome.outcome, 'updated');
  assert.equal(outcome.siteId, first.siteId);

  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(first.siteId);
  assert.equal(row.title, 'Alice writes better things');
  assert.equal(row.description, 'Now with more RSS');
  assert.equal(row.failure_count, 0);
  assert.equal(row.status, 'active');
  assert.equal(row.last_error, null);
  assert.equal(row.optout_seen_at, null);
  assert.ok(row.last_verified_at > '2020-01-01T00:00:00.000Z');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sites').get().n, 1);

  // §4: title is the OPML ORDER BY key, so a title change that doesn't bump the
  // version reorders the body while Last-Modified stays put.
  assert.ok(queries.getDirectoryVersion().version > versionAfterInsert);
});

test('a member who migrates their feed URL is updated, not refused', async () => {
  const { db, persist } = setup();
  const first = await persist(verified());

  // §5 Step 7: there is deliberately no `feed_conflict` guard — a member moving
  // WordPress → Hugo changes their feed URL, resubmits, and must be able to fix it.
  const outcome = await persist(verified({ feedUrl: 'https://alice.example/index.xml' }));

  assert.equal(outcome.outcome, 'updated');
  assert.equal(outcome.siteId, first.siteId);
  assert.equal(
    db.prepare('SELECT feed_url FROM sites WHERE id = ?').get(first.siteId).feed_url,
    'https://alice.example/index.xml',
  );
});

test('a canonical URL on one of our own linkback hosts is refused', async () => {
  const { db, persist } = setup();

  // §5 Step 7: iheartrss.com satisfies its own validator on EVERY page by design —
  // the header links to `/` and autodiscovery is in every `<head>` — and
  // `/status?url=…` yields unbounded distinct URLs that `normalizeUrl` deliberately
  // does not strip. Member #1 is a direct INSERT in phase 6, not through the form.
  for (const url of [
    'https://iheartrss.com/',
    'https://iheartrss.com/status?url=x',
    'https://IHEARTRSS.com/badge',
  ]) {
    const outcome = await persist(
      verified({ url, submittedUrl: url, feedUrl: 'https://iheartrss.com/feed.xml' }),
    );
    assert.equal(outcome.outcome, 'rejected', url);
    assert.equal(outcome.reason, 'self_listing', url);
  }

  assert.equal(db.prepare('SELECT count(*) AS n FROM sites').get().n, 0);
});

test('a hostile title and description are capped and cleaned at ingest', async () => {
  const { queries, persist } = setup();

  const { siteId } = await persist(
    verified({
      title: '\u202EEvil Blog' + ' '.repeat(20) + 'B'.repeat(1024 * 1024),
      description: '\uD800lone \u0007surrogate' + 'C'.repeat(5000),
    }),
  );

  const row = queries.getSiteById(siteId);

  // §7: "Cap lengths at ingest (title ~200 chars, description ~500) as well as at
  // render, and strip bidi overrides (U+202E) and C0/C1 controls so the DB is clean.
  // Nothing currently bounds these: they come verbatim from a 5 MB feed into
  // unbounded TEXT columns."
  assert.equal(Array.from(row.title).length, 200);
  assert.equal(Array.from(row.description).length, 500);
  assert.equal(row.title.includes('\u202E'), false, 'bidi override must be stripped');
  assert.equal(row.description.includes('\u0007'), false, 'C0 controls must be stripped');
  assert.doesNotMatch(row.description, /[\uD800-\uDFFF]/u);
  // Whitespace runs are collapsed, so a title padded with spaces can't fake a gap.
  assert.doesNotMatch(row.title, / {2,}/);
});

test('an absent description stays NULL rather than becoming an empty string', async () => {
  const { queries, persist } = setup();

  const { siteId } = await persist(verified({ description: undefined }));

  // The `opt()` coercion boundary in queries.js depends on this staying nullish, and
  // §7 omits `description` from the OPML when it is null rather than emitting `""`.
  assert.equal(queries.getSiteById(siteId).description, null);
});
