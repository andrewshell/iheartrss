import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDataDirectory } from '../src/storage.js';

// Plan §9, failure 1: docker creates a missing `./data` as root:root, the
// container runs as uid 1000, and the process dies at its first query with
// `ERR_SQLITE_ERROR: unable to open database file`. WAL makes it worse — the
// `-wal` and `-shm` siblings mean the *directory* must be writable, so chowning
// the .db file alone does not fix it. Boot has to say so in those words.

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'iheartrss-storage-'));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('the database directory is created when it does not exist', (t) => {
  const root = scratch(t);
  const databasePath = join(root, 'nested', 'data', 'iheartrss.db');
  assert.equal(existsSync(join(root, 'nested')), false);

  ensureDataDirectory({ databasePath });

  assert.equal(statSync(join(root, 'nested', 'data')).isDirectory(), true);
});

test('an existing database directory is accepted on a second boot', (t) => {
  const root = scratch(t);
  const databasePath = join(root, 'iheartrss.db');

  ensureDataDirectory({ databasePath });
  ensureDataDirectory({ databasePath });

  assert.equal(statSync(root).isDirectory(), true);
});

test('a directory the process cannot write fails fast, naming the fix', {
  skip: process.getuid?.() === 0 ? 'root ignores mode bits' : false,
}, (t) => {
  const root = scratch(t);

  // Stand in for the root-owned bind mount: present, but not writable by us.
  chmodSync(root, 0o555);

  assert.throws(
    () => ensureDataDirectory({ databasePath: join(root, 'iheartrss.db') }),
    (err) => {
      assert.match(err.message, /not writable/i);
      // The operator needs the command, not a bare EACCES.
      assert.match(err.message, /chown 1000:1000/);
      assert.ok(err.message.includes(root), 'names the offending directory');
      return true;
    },
  );
});

test('the write probe leaves nothing behind', (t) => {
  const root = scratch(t);

  ensureDataDirectory({ databasePath: join(root, 'iheartrss.db') });

  // A probe file left in the bind mount would end up in every backup tarball.
  assert.deepEqual(readdirSync(root), []);
});
