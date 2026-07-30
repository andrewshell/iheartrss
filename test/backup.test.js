import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb } from '../src/db/index.js';
import { createBackupJob } from '../src/jobs/backup.js';

// Plan §9, "Backup, rollback, monitoring": a timer calling `node:sqlite`'s
// exported `backup()` writes `./data/backups/YYYY-MM-DD.db` nightly with 14-day
// retention. `node:24-alpine` ships no `sqlite3` CLI, so the copy has to come
// from inside the process — and it has to be safe against a *live* database,
// which is the whole reason `backup()` is used rather than a file copy.

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'iheartrss-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A live, migrated database on disk, the way the container has one. */
function liveDb(t, dir) {
  const path = join(dir, 'iheartrss.db');
  const { db, queries } = createDb(path);
  t.after(() => {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  });
  return { db, queries, path };
}

function member(overrides = {}) {
  return {
    url: 'https://example.com/',
    submitted_url: 'https://example.com/',
    host: 'example.com',
    path: '/',
    feed_url: 'https://example.com/feed.xml',
    title: 'Example',
    description: 'A blog',
    has_source_ns: false,
    has_rsscloud: false,
    rsscloud_style: null,
    cloud_json: null,
    ...overrides,
  };
}

test('a backup is a real database file holding the rows the live one holds', async (t) => {
  const dir = scratch(t);
  const { db, queries, path } = liveDb(t, dir);

  queries.insertSite(member({ title: 'Scripting News' }));

  const job = createBackupJob({
    db,
    config: { databasePath: path, backupEnabled: true, backupRetentionDays: 14 },
    now: () => new Date('2026-07-29T03:00:00.000Z'),
  });

  const result = await job.runOnce();

  assert.equal(result.path, join(dir, 'backups', '2026-07-29.db'));

  // Opened as a database, not stat'd: a truncated or half-written file passes a
  // size check and fails here, which is the failure the runbook has to rule out.
  const restored = new DatabaseSync(result.path, { readOnly: true });
  t.after(() => restored.close());

  const titles = restored.prepare('SELECT title FROM sites ORDER BY id').all();
  assert.deepEqual(
    titles.map((row) => row.title),
    ['Scripting News'],
  );
});

test('retention keeps the last N days of backups and prunes what is older', async (t) => {
  const dir = scratch(t);
  const { db, path } = liveDb(t, dir);

  // Hand-placed neighbours, dated relative to the run below (2026-07-29):
  // 14 days back is the retention edge, 15 is over it. `notes.txt` is here
  // because a prune that globs the directory would delete an operator's own
  // files sitting beside the backups.
  const backups = join(dir, 'backups');
  mkdirSync(backups, { recursive: true });
  for (const name of [
    '2026-07-28.db', // yesterday
    '2026-07-15.db', // 14 days back — the edge, kept
    '2026-07-14.db', // 15 days back — pruned
    '2026-06-01.db', // ancient — pruned
    'notes.txt', // not ours
  ]) {
    writeFileSync(join(backups, name), 'placeholder');
  }

  const job = createBackupJob({
    db,
    config: { databasePath: path, backupEnabled: true, backupRetentionDays: 14 },
    now: () => new Date('2026-07-29T03:00:00.000Z'),
  });

  await job.runOnce();

  assert.deepEqual(readdirSync(backups).sort(), [
    '2026-07-15.db',
    '2026-07-28.db',
    '2026-07-29.db',
    'notes.txt',
  ]);
});

test('the live database stays writable through a backup, and both survive', async (t) => {
  const dir = scratch(t);
  const { db, queries, path } = liveDb(t, dir);

  queries.insertSite(member({ title: 'Before' }));

  const job = createBackupJob({
    db,
    config: { databasePath: path, backupEnabled: true, backupRetentionDays: 14 },
    now: () => new Date('2026-07-29T03:00:00.000Z'),
  });

  // Deliberately not awaited before the write: `backup()` is used precisely so
  // this is legal. A file copy here would either throw SQLITE_BUSY or capture a
  // main file whose WAL sibling holds the rows.
  const running = job.runOnce();
  queries.insertSite(
    member({
      url: 'https://during.example/',
      submitted_url: 'https://during.example/',
      host: 'during.example',
      feed_url: 'https://during.example/feed.xml',
      title: 'During',
    }),
  );
  const result = await running;

  // The live database is unharmed: the concurrent write landed and reads back.
  assert.deepEqual(
    queries
      .listMembers()
      .map((row) => row.title)
      .sort(),
    ['Before', 'During'],
  );

  // And is still writable afterwards — a backup that left a stuck lock behind
  // would fail here rather than above.
  queries.insertSite(
    member({
      url: 'https://after.example/',
      submitted_url: 'https://after.example/',
      host: 'after.example',
      feed_url: 'https://after.example/feed.xml',
      title: 'After',
    }),
  );
  assert.equal(queries.countSites(), 3);

  // The copy is a consistent snapshot, not a torn file: it opens, its integrity
  // check passes, and the row that predates it is there.
  const restored = new DatabaseSync(result.path, { readOnly: true });
  t.after(() => restored.close());

  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.ok(
    restored
      .prepare('SELECT title FROM sites')
      .all()
      .some((row) => row.title === 'Before'),
  );
});

test('start schedules an unrefd nightly tick that stop clears, and BACKUP_ENABLED=false schedules nothing', async (t) => {
  const dir = scratch(t);
  const { db, path } = liveDb(t, dir);

  const scheduled = [];
  const cleared = [];

  const job = createBackupJob({
    db,
    config: { databasePath: path, backupEnabled: true, backupRetentionDays: 14 },
    now: () => new Date('2026-07-29T03:00:00.000Z'),
  });

  const started = job.start({
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } };
      scheduled.push(handle);
      return handle;
    },
    clearInterval: (handle) => cleared.push(handle),
    // Stubbed away so the boot run (covered by its own test below) neither fires a
    // real timer nor writes a file this test then has to reason about.
    setTimeout: () => ({ unref: () => {} }),
    clearTimeout: () => {},
  });

  assert.equal(started, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 24 * 60 * 60 * 1000, 'nightly, per §9');
  // Same reason as the revalidation timers: a pending timer must not hold the
  // process open through a SIGTERM, or every redeploy waits out Docker's grace.
  assert.ok(scheduled[0].unrefd);

  // The callback really backs up — a timer wired to nothing is the failure mode
  // an "is it scheduled" assertion alone cannot see.
  await scheduled[0].fn();
  assert.deepEqual(readdirSync(join(dir, 'backups')), ['2026-07-29.db']);

  job.stop();
  assert.equal(cleared.length, 1);

  // BACKUP_ENABLED=false (and NODE_ENV=test) must mean no timer at all.
  const disabled = createBackupJob({
    db,
    config: { databasePath: path, backupEnabled: false, backupRetentionDays: 14 },
  });
  assert.equal(
    disabled.start({ setInterval: () => assert.fail('scheduled while disabled') }),
    false,
  );
});

test('start also runs at boot, but never overwrites a backup already taken today', async (t) => {
  const dir = scratch(t);
  const { db, path } = liveDb(t, dir);
  const backups = join(dir, 'backups');

  const at = new Date('2026-07-29T03:00:00.000Z');
  const config = { databasePath: path, backupEnabled: true, backupRetentionDays: 14 };

  const boot = [];
  const timers = {
    setInterval: (fn, ms) => ({ fn, ms, unref: () => {} }),
    setTimeout: (fn, ms) => {
      boot.push({ fn, ms });
      return { fn, ms, unref: () => {} };
    },
    clearInterval: () => {},
    clearTimeout: () => {},
  };

  // A 24-hour interval alone means a container that is restarted daily — a dockge
  // redeploy, an unhealthy-container restart, a host reboot — never reaches its own
  // tick and so never backs up at all. The boot run is what closes that.
  createBackupJob({ db, config, now: () => at }).start(timers);
  assert.equal(boot.length, 1, 'start schedules a boot run');
  await boot[0].fn();
  assert.deepEqual(readdirSync(backups), ['2026-07-29.db']);

  // …and the boot run has to be idempotent for the day, or a crash-looping
  // container rewrites today's copy every few seconds — including the loop whose
  // cause is the database itself, overwriting the last good backup with the
  // broken state.
  writeFileSync(join(backups, '2026-07-29.db'), 'the copy already taken today');

  boot.length = 0;
  createBackupJob({ db, config, now: () => at }).start(timers);
  await boot[0].fn();

  assert.equal(
    readFileSync(join(backups, '2026-07-29.db'), 'utf8'),
    'the copy already taken today',
  );

  // An explicit `runOnce()` is the operator saying "back up now" and does overwrite
  // — that is the "take one before you touch anything" step in RUNBOOK.md.
  await createBackupJob({ db, config, now: () => at }).runOnce();
  assert.notEqual(
    readFileSync(join(backups, '2026-07-29.db'), 'utf8'),
    'the copy already taken today',
  );
});
