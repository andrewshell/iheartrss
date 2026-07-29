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
import { ensureDataDirectory, probeDataDirectory } from './storage.js';

const config = loadConfig();

// Before listening, not lazily on first use: a container that answers /healthz
// while its data directory is unwritable is a container that stays up broken.
// Plan §12.2 wants this failure to happen on the phase-2 deploy.
ensureDataDirectory({ databasePath: config.databasePath });

const app = createApp({
  config,
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
 * Phase 3 adds `PRAGMA wal_checkpoint(TRUNCATE)` and `db.close()` here; phase 8a
 * adds stopping the revalidation interval.
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
    process.exit(1);
  }, 8000);
  deadline.unref();

  server.close((err) => {
    clearTimeout(deadline);
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

function log(msg, fields) {
  console.log(JSON.stringify({ msg, ...fields }));
}
