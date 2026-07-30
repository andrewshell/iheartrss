/**
 * Data-directory bootstrap (plan §9, "three failures that will happen on first
 * deploy", #1).
 *
 * Run before the server listens. Two jobs:
 *
 *  1. Create the directory holding the database. `DatabaseSync` will not create
 *     a missing parent, so a fresh clone with the default `./data/iheartrss.db`
 *     fails exactly the way the production bind mount does.
 *  2. Probe that the directory is *writable by this uid*, and fail with an
 *     actionable message if it is not. Docker creates a missing `./data` as
 *     `root:root` while the container runs as uid 1000; SQLite's WAL mode then
 *     needs to create `-wal` and `-shm` siblings, so it is the directory — not
 *     the `.db` file — that has to be writable. Left to SQLite this surfaces as
 *     `ERR_SQLITE_ERROR: unable to open database file`, which names neither the
 *     directory nor the fix.
 *
 * Phase 3 opens the database here. Phase 2 only has to make the permission
 * failure happen now, on a deploy with nothing to lose.
 */

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function ensureDataDirectory({ databasePath }) {
  const dir = resolve(dirname(databasePath));

  try {
    mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw new Error(explain(dir, `could not be created (${cause.code})`), {
      cause,
    });
  }

  const probe = probeDataDirectory({ databasePath });
  if (!probe.ok) throw new Error(probe.reason);

  return dir;
}

/**
 * The same write probe, as a health signal rather than a boot assertion: never
 * throws, and answers `{ ok, reason }` so `/healthz` can turn it into a 503.
 *
 * The directory is re-probed on every call deliberately. A permission that was
 * right at boot can be wrong later — a restore run as root, a remounted volume —
 * and a cached "ok" from startup would keep the healthcheck green through it.
 */
export function probeDataDirectory({ databasePath }) {
  const dir = resolve(dirname(databasePath));

  // An access() check would be a TOCTOU answer to the wrong question: what
  // matters is whether this uid can create a *new file* in there, which is what
  // the WAL sidecars are.
  const probe = join(dir, `.write-probe-${process.pid}`);
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (cause) {
    return { ok: false, reason: explain(dir, `is not writable (${cause.code})`) };
  }

  return { ok: true };
}

function explain(dir, what) {
  return [
    `The database directory ${dir} ${what}.`,
    '',
    'The container runs as uid 1000 (USER node) and Docker creates a missing',
    'bind-mount source as root:root. SQLite in WAL mode creates -wal and -shm',
    'files beside the database, so the directory itself must be writable —',
    'chowning the .db file is not enough. On the host, in the stack directory:',
    '',
    '  mkdir -p data && sudo chown 1000:1000 data',
  ].join('\n');
}
