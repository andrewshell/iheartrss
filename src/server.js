/**
 * Entry point: validate config, bootstrap the data directory, build the app,
 * listen, and shut down cleanly.
 *
 * The app itself is built by `createApp({ config })` and never at module scope
 * (plan §11) — that is what keeps it testable as phases 3+ add a database and a
 * fetcher to inject.
 */

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDb, createDb } from './db/index.js';
import { loadIpHmacKey } from './lib/iphash.js';
import { ensureDataDirectory, probeDataDirectory } from './storage.js';

const config = loadConfig();

// Before listening, not lazily on first use: a container that answers /healthz
// while its data directory is unwritable is a container that stays up broken.
// Plan §12.2 wants this failure to happen on the phase-2 deploy.
ensureDataDirectory({ databasePath: config.databasePath });

// Opened and migrated before we listen, for the same reason: a schema that fails
// to apply must be a container that never comes up, not one that 500s per
// request. Migrations are idempotent, so every restart runs this.
const { db, queries } = createDb(config.databasePath);
log('db.ready', { path: config.databasePath });

// Before listening, for the same reason as everything else here: every submission
// writes an `ip_hash`, so a missing key must be a container that never comes up
// rather than one that 500s the first time somebody submits. In production a missing
// file is fatal; in development one is generated (§4, §9).
const ipHmacKey = loadIpHmacKey({
  path: config.ipHmacKeyFile,
  production: config.production,
});
log('iphash.ready', { path: config.ipHmacKeyFile });

if (config.adminToken === null) {
  // §6: "No admin UI is served at all if ADMIN_TOKEN is unset." Said out loud,
  // because phase 5's whole point is that a listing can be taken down.
  log('admin.disabled', { reason: 'ADMIN_TOKEN is not set' });
}

const app = createApp({
  config,
  db,
  queries,
  ipHmacKey,
  checkHealth: () => probeDataDirectory({ databasePath: config.databasePath }),
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log('listening', { port: info.port, siteUrl: config.siteUrl });
});

/**
 * Plan §9, failure 2: Node is PID 1 in the container, and PID 1 has no default
 * signal dispositions — an unhandled SIGTERM is simply discarded. Measured:
 * `docker stop` takes 10.29s with no handler and 0.16s with one, so without this
 * every dockge redeploy is a SIGKILL that drops in-flight requests.
 *
 * The database is checkpointed and closed on the way out (§9): the nightly backup
 * copies the main database file, so the WAL is folded back into it rather than
 * left for whatever the next unclean exit does. Phase 8a adds stopping the
 * revalidation interval.
 */
let shuttingDown = false;

function shutdown(signal) {
  // Impatient operators send a second Ctrl-C; honour it rather than hanging.
  if (shuttingDown) {
    log('shutdown.forced', { signal });
    process.exit(1);
  }
  shuttingDown = true;
  log('shutdown.start', { signal });

  // Docker's grace period is 10s. Give in-flight requests most of it, then stop
  // waiting — a keep-alive connection that never closes must not turn a clean
  // shutdown back into a hard kill.
  const deadline = setTimeout(() => {
    log('shutdown.timeout', { signal });
    // Still worth a checkpoint: a hung keep-alive connection is no reason to
    // leave the WAL for the next boot to replay.
    closeQuietly();
    process.exit(1);
  }, 8000);
  deadline.unref();

  server.close((err) => {
    clearTimeout(deadline);
    closeQuietly();
    if (err) {
      log('shutdown.error', { signal, error: err.message });
      process.exit(1);
    }
    log('shutdown.complete', { signal });
    process.exit(0);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

// Both shutdown paths can reach this, and closing twice throws.
let closed = false;

function closeQuietly() {
  if (closed) return;
  closed = true;
  try {
    closeDb(db);
  } catch (err) {
    log('shutdown.db_error', { error: err.message });
  }
}

function log(msg, fields) {
  console.log(JSON.stringify({ msg, ...fields }));
}
