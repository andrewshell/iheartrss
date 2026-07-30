/**
 * Nightly database backups (plan §9, "Backup, rollback, monitoring").
 *
 * `node:sqlite`'s exported `backup()` — **not** a file copy and **not**
 * `sqlite3 .backup`. Two reasons, both load-bearing:
 *
 *  * The database is open and in WAL mode while this runs. Copying
 *    `iheartrss.db` on its own captures the main file without the `-wal`
 *    sibling, so the copy is whatever the last checkpoint left behind — silently
 *    missing every write since. `backup()` uses SQLite's online backup API,
 *    which reads a consistent snapshot of a live database.
 *  * `node:24-alpine` ships no `sqlite3` binary, so the plan's original
 *    `sqlite3 .backup` advice cannot run in the container at all.
 */

import { backup } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/** §9: nightly. One tick a day, and the filename is the date, so a missed tick
 *  costs a day rather than a duplicate. */
const TICK_MS = DAY_MS;

/** A minute after boot, so it does not compete with migrations and the seed. */
const BOOT_DELAY_MS = 60_000;

/** Only files this job could have written are candidates for pruning. */
const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2})\.db$/;

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db - the live connection.
 * @param {object} deps.config - `databasePath`, `backupEnabled`, `backupRetentionDays`.
 * @param {Function} [deps.now] - injected clock; the retention tests move it by hand.
 */
export function createBackupJob({ db, config, now = () => new Date(), log = () => {} }) {
  const dir = backupDir(config.databasePath);
  let handle = null;
  let bootHandle = null;
  let clear = () => {};

  /**
   * Back up now, overwriting today's file if there is one. This is the tick, and it
   * is also the operator's "take one before you touch anything" — see RUNBOOK.md.
   */
  async function runOnce() {
    const at = now();
    const path = join(dir, `${stamp(at)}.db`);

    mkdirSync(dir, { recursive: true });
    // Removed rather than written over: `backup()` *opens* the destination as a
    // database, so a truncated file left by a crashed or disk-full run makes every
    // later attempt at that date fail with "file is not a database" — one bad night
    // poisoning that filename until somebody deletes it by hand.
    rmSync(path, { force: true });
    const pages = await backup(db, path);
    log('backup.written', { path, pages });

    const pruned = prune(at);
    if (pruned.length > 0) log('backup.pruned', { files: pruned });

    return { path, pages, pruned };
  }

  /**
   * §9's 14-day retention, decided on the **filename** rather than the mtime.
   * An off-box copy pulled back with `scp`/`rclone` arrives with a fresh mtime,
   * which would make a restored set of old backups look brand new — and a
   * `cp -p` that preserves it makes today's copy look ancient. The name is the
   * only date that survives both.
   */
  function prune(at) {
    const cutoff = stamp(new Date(at.getTime() - config.backupRetentionDays * DAY_MS));
    const removed = [];

    for (const name of readdirSync(dir)) {
      const match = BACKUP_NAME.exec(name);
      if (match === null || match[1] >= cutoff) continue;

      try {
        rmSync(join(dir, name));
        removed.push(name);
      } catch (err) {
        // A backup we cannot delete is a disk-space problem for later, never a
        // reason to lose tonight's copy.
        log('backup.prune_failed', { file: name, error: err.message });
      }
    }

    return removed;
  }

  /**
   * The boot run: back up unless today's copy already exists.
   *
   * Both halves are load-bearing. **Running at boot at all**, because a 24-hour
   * interval on its own means a container that is restarted daily — a dockge
   * redeploy, an unhealthy-container restart, a host reboot — never reaches its own
   * tick and never backs up. **Skipping when today's file exists**, because a
   * crash-looping container would otherwise rewrite today's copy every few seconds,
   * and the loop whose cause is the database itself would overwrite the last good
   * backup with the broken state.
   */
  async function runIfMissing() {
    const path = join(dir, `${stamp(now())}.db`);
    if (existsSync(path)) {
      log('backup.skipped', { path, reason: 'already_taken_today' });
      return { path, skipped: 'already_taken_today' };
    }
    return runOnce();
  }

  /**
   * Start the nightly timer. Timer functions are injectable so a test can assert
   * the cadence and the `unref` without waiting a day for one.
   *
   * Returns whether anything was scheduled: `BACKUP_ENABLED=false` has to mean no
   * timer at all, not a tick that runs and writes a file the test suite then has
   * to clean up.
   */
  function start(timers = {}) {
    const {
      setInterval: setIntervalFn = globalThis.setInterval,
      clearInterval: clearIntervalFn = globalThis.clearInterval,
      setTimeout: setTimeoutFn = globalThis.setTimeout,
      clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
    } = timers;

    if (!config.backupEnabled) {
      log('backup.disabled', { reason: 'BACKUP_ENABLED' });
      return false;
    }

    // Not immediately: boot is already doing migrations, the self-listing seed and
    // the revalidator's own +30s run. A minute in, the process is idle.
    bootHandle = setTimeoutFn(() => guarded(runIfMissing), BOOT_DELAY_MS);
    handle = setIntervalFn(() => guarded(runOnce), TICK_MS);

    // unref'd for the same reason as §8's timers: neither may hold the process open
    // past a SIGTERM, or every redeploy waits out Docker's 10-second grace period.
    bootHandle?.unref?.();
    handle?.unref?.();

    clear = () => {
      if (bootHandle !== null) clearTimeoutFn(bootHandle);
      if (handle !== null) clearIntervalFn(handle);
      bootHandle = null;
      handle = null;
    };

    return true;
  }

  /**
   * The timer callback. It **must** swallow its own errors: an unhandled
   * rejection from a timer terminates the process in Node 24, and a full disk
   * must not be able to take the site down by way of its own backup job.
   */
  function guarded(fn) {
    return fn().catch((err) => {
      log('backup.failed', { error: err.message });
      return { error: err.message };
    });
  }

  return { runOnce, runIfMissing, start, stop: () => clear() };
}

/** `./data/iheartrss.db` → `./data/backups`, per §9. */
export function backupDir(databasePath) {
  return join(dirname(databasePath), 'backups');
}

/** `YYYY-MM-DD`, in UTC — the container's clock is UTC and the name must sort. */
function stamp(at) {
  return at.toISOString().slice(0, 10);
}
