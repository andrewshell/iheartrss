#!/usr/bin/env node
/**
 * `node bin/backup.js` — take a backup right now, or verify one (plan §9).
 *
 * This exists because `node:24-alpine` ships no `sqlite3` CLI, so there is otherwise
 * no way to say "back up before I touch anything" or "is that file actually a
 * database" from inside the running container. RUNBOOK.md leans on both.
 *
 *   docker compose exec iheartrss node bin/backup.js
 *   docker compose exec iheartrss node bin/backup.js --verify /data/backups/2026-07-29.db
 *
 * The `--verify` form opens its argument read-only, so it is safe to point at a live
 * database as well as at a backup.
 */

import { DatabaseSync } from 'node:sqlite';

import { loadConfig } from '../src/config.js';
import { createBackupJob } from '../src/jobs/backup.js';

const [, , flag, target] = process.argv;
const config = loadConfig(process.env);

if (flag === '--verify') {
  verify(target ?? config.databasePath);
} else if (flag === undefined) {
  await take();
} else {
  process.stderr.write('usage: node bin/backup.js [--verify <path>]\n');
  process.exit(2);
}

async function take() {
  // A second connection to the same file, deliberately: the running app holds its
  // own, and SQLite's online backup API is built for a database with live writers.
  // Read-only, because nothing about taking a copy should be able to write.
  const db = new DatabaseSync(config.databasePath, { readOnly: true });

  // `BACKUP_ENABLED` gates the *timer*, not an explicit request — an operator
  // running this by hand has already decided.
  const job = createBackupJob({
    db,
    config: { ...config, backupEnabled: true },
    log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
  });

  const { path, pages, pruned } = await job.runOnce();
  db.close();

  // Verified rather than merely written: "the file appeared" is not the same claim
  // as "the file is a database", and this is the moment to find out.
  verify(path);
  process.stdout.write(`wrote ${path} (${pages} pages, pruned ${pruned.length})\n`);
}

function verify(path) {
  let integrity;
  let members;
  let schema;

  // The whole read is inside the try, not just the open: `DatabaseSync` opens the
  // file lazily, so a garbage file constructs happily and throws at the first
  // statement. Without this, the answer to "is my backup good" is a raw Node stack
  // trace — which is not what anybody wants to read at 2am.
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    members = db
      .prepare(
        "SELECT count(*) AS n FROM sites WHERE status IN ('active','failing','blocked')",
      )
      .get().n;
    schema = db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v;
    db.close();
  } catch (err) {
    process.stderr.write(`NOT USABLE: ${path}\n  ${err.message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `${path}\n  integrity_check: ${integrity}\n  listed members:  ${members}\n` +
      `  schema version:  ${schema}\n`,
  );

  if (integrity !== 'ok') process.exit(1);
}
