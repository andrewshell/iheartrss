/**
 * Entry point: validate config, bootstrap the data directory, build the app,
 * listen, and shut down cleanly.
 *
 * The app itself is built by `createApp({ config })` and never at module scope
 * (plan §11) — that is what keeps it testable as phases 3+ add a database and a
 * fetcher to inject.
 */

import { lookup } from 'node:dns';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createBlog } from './blog/index.js';
import { loadConfig } from './config.js';
import { closeDb, createDb } from './db/index.js';
import { seedSelfListing } from './db/seed.js';
import { backupDir, createBackupJob } from './jobs/backup.js';
import { createRevalidator } from './jobs/revalidate.js';
import { createRsscloudPing } from './jobs/rsscloud.js';
import { loadIpHmacKey } from './lib/iphash.js';
import { ensureDataDirectory, probeDataDirectory } from './storage.js';
import { createFetcher } from './verify/fetch.js';
import { createVerifier } from './verify/index.js';

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

// §12 phase 6: member #1 is iheartrss.com itself, seeded by direct INSERT because
// §5 Step 7 rejects any canonical host in LINKBACK_HOSTS. Idempotent, so it runs on
// every boot and a restart neither duplicates the row nor bumps the directory
// version. Kept out of `001_init.sql` because the row depends on SITE_URL, which a
// migration cannot see.
seedSelfListing({ queries, config, log });

// Before listening, for the same reason as everything else here: every submission
// writes an `ip_hash`, so a missing key must be a container that never comes up
// rather than one that 500s the first time somebody submits. In production a missing
// IP_HMAC_KEY is fatal; in development an ephemeral one is generated (§4, §9).
const ipHmacKey = loadIpHmacKey({
  key: config.ipHmacKey,
  production: config.production,
  log,
});
log('iphash.ready', { source: config.ipHmacKey ? 'IP_HMAC_KEY' : 'ephemeral' });

if (config.adminToken === null) {
  // §6: "No admin UI is served at all if ADMIN_TOKEN is unset." Said out loud,
  // because phase 5's whole point is that a listing can be taken down.
  log('admin.disabled', { reason: 'ADMIN_TOKEN is not set' });
}

// §12 phase 7: the blog is loaded at boot, so a broken post is visible immediately
// rather than on the first request. Its cache is invalidated by polling max(mtime)
// across content/ (§6.4) — no timer to stop on shutdown, because the poll happens on
// read rather than on an interval.
const blog = createBlog({
  dir: config.contentDir,
  pollMs: config.contentPollMs,
  log,
});
log('blog.ready', { dir: config.contentDir, posts: blog.posts().length });

// §12 phase 8a: the revalidation scheduler.
//
// It is built with **its own fetcher and verifier, and it never touches the app's
// semaphore** — §8's "reserved outbound slot outside the public semaphore". Sharing
// the public one would let 4 concurrent /recheck calls aimed at a tarpit host hold
// every slot for the full budget, stalling revalidation and with it the "removed
// within a week" clock. Being sequential, the scheduler is its own limit of one.
const revalidation = createRevalidator({
  queries,
  config,
  verifySite: createVerifier({
    safeFetch: createFetcher({ lookup, config }),
    config,
    isBanned: ({ host, path }) => queries.findBan({ host, path }) !== undefined,
  }),
  log,
});

// §12 phase 9: nightly `backup()` to ./data/backups/YYYY-MM-DD.db, 14-day retention.
//
// It shares the app's connection deliberately. SQLite's online backup API is built
// for exactly this — a consistent snapshot of a database that is being written to —
// whereas a second connection would only add a writer to contend with, and copying
// the file would capture the main database without its `-wal` sibling.
const backups = createBackupJob({ db, config, log });

// §6.4: tell our rssCloud server when one of our documents may have changed. Built
// before the app because the app holds one of its two triggers — `/submit` and the
// admin unhide ping `/subscriptions.opml` when a feed joins the directory. The other
// is the boot ping for `/feed.xml`, started from inside `serve()`'s callback below.
const rsscloud = createRsscloudPing({ config, log });

const app = createApp({
  config,
  db,
  queries,
  blog,
  ipHmacKey,
  revalidation,
  rsscloud,
  checkHealth: () => probeDataDirectory({ databasePath: config.databasePath }),
});

// After the app is built, before we listen: the first run fires ~30s later, so a
// fresh container doesn't sit idle for an hour (§8).
if (revalidation.start()) {
  log('revalidate.started', {
    batch: config.revalidateBatch,
    intervalDays: config.revalidateIntervalDays,
  });
}

if (backups.start()) {
  log('backup.started', {
    dir: backupDir(config.databasePath),
    retentionDays: config.backupRetentionDays,
  });
}

// The feed half of §6.4's ping. **Started from inside the listening callback,
// deliberately** — nothing about a third-party host may delay or fail our own startup,
// and the ping itself is a timer a couple of seconds later. Blog posts ship inside the
// image, so a restart is exactly when the feed changes; the cloud server re-fetches and
// only notifies anyone if it really did.
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log('listening', { port: info.port, siteUrl: config.siteUrl });

  if (rsscloud.start()) {
    log('rsscloud.scheduled', { ping: config.rsscloudPingUrl });
  }
});

/**
 * Plan §9, failure 2: Node is PID 1 in the container, and PID 1 has no default
 * signal dispositions — an unhandled SIGTERM is simply discarded. Measured:
 * `docker stop` takes 10.29s with no handler and 0.16s with one, so without this
 * every dockge redeploy is a SIGKILL that drops in-flight requests.
 *
 * The database is checkpointed and closed on the way out (§9), so the file left on
 * disk is self-contained rather than dependent on whatever the last unclean exit left
 * in the WAL — which is what makes the RUNBOOK's "stop the stack, copy `data/`" step
 * honest. (The nightly job uses SQLite's online backup API and needs no such help.)
 * The timers are stopped first — they are `unref`'d, so they cannot hold the process
 * open, but a tick that starts writing while we are closing the database can.
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
  revalidation.stop();
  // Same reason as the revalidation interval: the timer is unref'd so it cannot hold
  // the process open, but a backup that starts copying pages while we are closing the
  // database can.
  backups.stop();
  // A pending ping is unref'd and harmless, but a container that is stopped two
  // seconds after it started should not still reach out on its way down. Cancels the
  // coalescing OPML timer too, for the same reason.
  rsscloud.stop();

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
