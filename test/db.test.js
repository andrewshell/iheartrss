import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb } from '../src/db/index.js';

// A real file on disk, for the cases that need the schema to survive a reopen.
function scratchDbPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'iheartrss-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'iheartrss.db');
}

// Plan §11: `createDb(path) → { db, queries }` exists precisely so a test can
// hand it `:memory:`. Prepared statements bound at module-evaluation time would
// open whatever DATABASE_PATH says the moment this file is imported.

test('createDb applies the numbered migrations and records them', (t) => {
  const { db } = createDb(':memory:');
  t.after(() => db.close());

  const applied = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all();

  assert.deepEqual(
    applied.map((row) => row.version),
    [1],
  );
});

test('re-opening an already-migrated database applies nothing twice', (t) => {
  const path = scratchDbPath(t);

  const first = createDb(path);
  first.db.close();

  // Boot calls createDb unconditionally, so every restart re-runs this. A
  // migration replayed here is `CREATE TABLE` on a table that already exists.
  const second = createDb(path);
  t.after(() => second.db.close());

  const applied = second.db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all();
  assert.deepEqual(
    applied.map((row) => row.version),
    [1],
  );
});

test('directory_version is seeded with row 1 by the migration', (t) => {
  const { db, queries } = createDb(':memory:');
  t.after(() => db.close());

  // Plan §4: without this row the bump `UPDATE ... WHERE id = 1` matches nothing
  // and returns changes: 0 — a silent no-op, so nothing is ever cache-invalidated
  // and phase 6 serves removed members out of a cache forever.
  const row = queries.getDirectoryVersion();

  assert.equal(row.version, 0);
  assert.equal(row.outline_hash, '');
  assert.equal(row.updated_at, '1970-01-01T00:00:00.000Z');
});

// The shape §5 Step 6 hands to the database when a feed has a `<channel>` with a
// title and nothing else: booleans, and `undefined` for every optional element.
function minimalVerifiedSite(overrides = {}) {
  return {
    url: 'https://example.com/',
    submitted_url: 'example.com',
    host: 'example.com',
    path: '/',
    feed_url: 'https://example.com/feed.xml',
    title: 'Example',
    description: undefined,
    has_source_ns: true,
    has_rsscloud: false,
    rsscloud_style: undefined,
    cloud_json: undefined,
    ...overrides,
  };
}

test('a site whose feed omits every optional element still inserts', (t) => {
  const { db, queries } = createDb(':memory:');
  t.after(() => db.close());

  // Plan §4, verified: node:sqlite throws
  // `TypeError: Provided value cannot be bound to SQLite parameter` for BOTH
  // booleans and `undefined`, so the natural `stmt.run({…})` blows up at exactly
  // the moment a submission *succeeds*. The coercion belongs here, once.
  const id = queries.insertSite(minimalVerifiedSite());

  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  assert.equal(row.has_source_ns, 1);
  assert.equal(row.has_rsscloud, 0);
  assert.equal(row.description, null);
  assert.equal(row.rsscloud_style, null);
  assert.equal(row.status, 'active');
});

test('inserting a site bumps the directory version', (t) => {
  const { db, queries } = createDb(':memory:');
  t.after(() => db.close());

  const before = queries.getDirectoryVersion().version;
  queries.insertSite(minimalVerifiedSite());

  // Plan §7: the bump lives in the write helper, not at the call site. Call
  // sites are spread across phases 5, 6 and 8, and one that forgets is invisible
  // until a cache serves a member we already took down.
  assert.equal(queries.getDirectoryVersion().version, before + 1);
});

test('a path-scoped ban catches one account, not the whole instance', (t) => {
  const { db, queries } = createDb(':memory:');
  t.after(() => db.close());

  queries.insertBan({ host: 'mastodon.social', path_prefix: '/@spammer' });

  assert.ok(queries.findBan({ host: 'mastodon.social', path: '/@spammer' }));
  assert.ok(queries.findBan({ host: 'mastodon.social', path: '/@spammer/rss' }));

  // Plan §4: SQL binds AND tighter than OR, so a predicate written without the
  // outer parentheses evaluates as `A OR (B AND C)` — the exact-host arm ignores
  // path_prefix and this ban silently takes out every account on the instance.
  assert.equal(
    queries.findBan({ host: 'mastodon.social', path: '/@victim' }),
    undefined,
  );
});

test('a host_suffix ban catches wildcard subdomains in one row', (t) => {
  const { db, queries } = createDb(':memory:');
  t.after(() => db.close());

  // §5 Step 7: with wildcard DNS, a1…a500.attacker.example each have a distinct
  // url AND feed_url, so both UNIQUE constraints are satisfied and all 500 reach
  // every subscriber. Without this form, cleanup is one INSERT per subdomain.
  queries.insertBan({ host: '', host_suffix: '.attacker.example' });

  assert.ok(queries.findBan({ host: 'a1.attacker.example', path: '/' }));
  assert.ok(queries.findBan({ host: 'a500.attacker.example', path: '/blog' }));
  assert.equal(
    queries.findBan({ host: 'notattacker.example', path: '/' }),
    undefined,
  );
});

test('domain_limits exempts the multi-tenant hosts and falls back otherwise', (t) => {
  const { db, queries } = createDb(':memory:');
  t.after(() => db.close());

  // Plan §4/§5 Step 7: tldts with allowPrivateDomains:true separates
  // alice.github.io and alice.bearblog.dev, but NOT substack.com, wordpress.com,
  // tumblr.com, micro.blog or neocities.org — and path-based hosts are one domain
  // by construction. Unseeded, MAX_LISTINGS_PER_DOMAIN=5 refuses the 6th Substack
  // or Micro.blog member ever, globally and permanently. -1 is unlimited.
  for (const domain of [
    'substack.com',
    'wordpress.com',
    'tumblr.com',
    'micro.blog',
    'neocities.org',
    'medium.com',
    'mastodon.social',
    'tilde.club',
  ]) {
    assert.equal(queries.maxListingsForDomain(domain, 5), -1, domain);
  }

  assert.equal(queries.maxListingsForDomain('example.com', 5), 5);
});

test('hard-deleting a reported site leaves the report as an audit trail', (t) => {
  const { db, queries } = createDb(':memory:');
  t.after(() => db.close());

  const siteId = queries.insertSite(minimalVerifiedSite());
  queries.insertReport({
    site_id: siteId,
    url: 'https://example.com/',
    reason: 'malware',
    contact: undefined,
    ip_hash: 'deadbeef',
  });

  // §8's retention sweep hard-deletes `dropped` rows after ~1 year. With
  // foreign_keys = ON and the *default* FK action, this raises FOREIGN KEY
  // constraint failed and aborts the rest of the revalidation batch (§4).
  db.prepare('DELETE FROM sites WHERE id = ?').run(siteId);

  const report = db.prepare('SELECT site_id, url, contact FROM reports').get();
  assert.equal(report.site_id, null);
  // url is kept independently so the report survives the site row.
  assert.equal(report.url, 'https://example.com/');
  assert.equal(report.contact, null);
});

test('a rejected submission is recorded with its machine reason', (t) => {
  const { db, queries } = createDb(':memory:');
  t.after(() => db.close());

  // §4: every attempt is logged for rate limiting, abuse triage and "why did
  // mine fail?". A rejection before normalization has no normalized_url, and an
  // 'error' result has no reason — both arrive as undefined.
  queries.insertSubmission({
    submitted_url: 'not a url',
    normalized_url: undefined,
    ip_hash: 'deadbeef',
    result: 'rejected',
    reason: 'no_linkback',
  });

  const row = db.prepare('SELECT * FROM submissions').get();
  assert.equal(row.normalized_url, null);
  assert.equal(row.result, 'rejected');
  assert.equal(row.reason, 'no_linkback');
  // Timestamps are written from JS, never SQL's datetime('now') (§4).
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test('the migrated schema is every table and index plan §4 specifies', (t) => {
  const { db } = createDb(':memory:');
  t.after(() => db.close());

  // §11 on the domain_limits seed: "the sort of thing that gets dropped from
  // 001_init.sql and is only noticed when the 6th Micro.blog user is turned
  // away". The same is true of a whole table. This list is §4's, transcribed.
  const names = (type) =>
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = ? AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all(type)
      .map((row) => row.name);

  assert.deepEqual(names('table'), [
    'banned_hosts',
    'directory_version',
    'domain_limits',
    'moderation_log',
    'reports',
    'schema_migrations',
    'sites',
    'submissions',
  ]);

  assert.deepEqual(names('index'), [
    'idx_sites_host',
    'idx_sites_status_checked',
    'idx_sites_submitted',
    'idx_submissions_created',
  ]);
});

test('closing the database checkpoints the WAL into the main file', (t) => {
  const path = scratchDbPath(t);

  const first = createDb(path);
  first.queries.insertSite(minimalVerifiedSite());

  // §9, failure 2: SIGTERM handling exists so a dockge redeploy isn't a SIGKILL
  // that leaves the WAL uncheckpointed. The nightly backup (§9) copies the main
  // database file, so what has to survive here is the row being *in* it.
  closeDb(first.db);

  assert.equal(existsSync(`${path}-wal`), false);

  const reopened = createDb(path);
  t.after(() => closeDb(reopened.db));
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM sites').get().n, 1);
});
