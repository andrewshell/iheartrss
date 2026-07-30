/**
 * Database open + migration runner (plan §4, §11).
 *
 * `createDb(path) → { db, queries }` is the required shape, and it is load-bearing
 * rather than stylistic: a `queries.js` that prepares its statements at module
 * scope binds them to a connection at *module-evaluation* time, so importing
 * `app.js` in a test opens whatever `DATABASE_PATH` says before the test can
 * inject anything (§11). Nothing here runs on import.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createQueries } from './queries.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function createDb(path) {
  const db = new DatabaseSync(path);

  applyPragmas(db);
  migrate(db);

  return { db, queries: createQueries(db) };
}

/**
 * Shut the database down cleanly (plan §9, failure 2).
 *
 * `PRAGMA wal_checkpoint(TRUNCATE)` first: every dockge redeploy is a stop, and
 * folding the WAL back in on the way out keeps the file self-contained rather than
 * trusting whatever the last unclean exit left behind. That is what lets the RUNBOOK
 * say "stop the stack, then copy `data/`" — the nightly job goes through SQLite's
 * online backup API and does not depend on it.
 */
export function closeDb(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // A checkpoint failure must not stop us closing — shutdown has a deadline.
  }
  db.close();
}

// Plan §4, "Pragmas on open". WAL so a read during the revalidation tick doesn't
// block; NORMAL because with WAL that only risks the last transaction on an OS
// crash, not corruption; foreign_keys because SQLite itself defaults it OFF per
// connection and `reports.site_id ON DELETE SET NULL` is inert without it
// (node:sqlite happens to enable it for us — stated anyway, so the invariant
// doesn't rest on a default we don't control); busy_timeout so a concurrent
// writer waits instead of throwing SQLITE_BUSY.
function applyPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

/**
 * Numbered `.sql` files applied in order and tracked in `schema_migrations` —
 * "enough structure to evolve without a migration library" (§4).
 *
 * Re-running is a no-op: already-recorded versions are skipped, so boot can call
 * this unconditionally.
 */
export function migrate(db) {
  const applied = appliedVersions(db);

  for (const migration of loadMigrations()) {
    if (applied.has(migration.version)) continue;

    // DDL is transactional in SQLite, so a migration that throws half-way leaves
    // no partially-created schema *and* no row claiming it was applied.
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(migration.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.name} failed: ${err.message}`, {
        cause: err,
      });
    }
  }
}

// `schema_migrations` is itself created by 001 (§4 lists it in the schema block),
// so on a virgin database the tracking table does not exist yet.
function appliedVersions(db) {
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (!exists) return new Set();

  return new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version),
  );
}

function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .map((name) => ({
      name,
      version: Number.parseInt(name, 10),
      sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
    }))
    // Numeric, not lexicographic: `10_` must sort after `9_`.
    .sort((a, b) => a.version - b.version);
}
