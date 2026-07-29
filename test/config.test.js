import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

// Plan §9's env table. Phase 2 adds DATABASE_PATH, because phase 12.2 wants the
// database directory touched on the first real deploy — that is the phase where
// the root-owned bind-mount permission failure is cheap to discover.

test('DATABASE_PATH defaults to the local ./data/iheartrss.db', () => {
  const config = loadConfig({});

  assert.equal(config.databasePath, './data/iheartrss.db');
});

test('DATABASE_PATH is taken from the environment when set', () => {
  const config = loadConfig({ DATABASE_PATH: '/data/iheartrss.db' });

  assert.equal(config.databasePath, '/data/iheartrss.db');
});

test('a DATABASE_PATH naming no file is rejected at boot', () => {
  // `/data` is the compose bind mount, and `/data/` is the mistake next to it.
  // Left to `DatabaseSync`, this surfaces as EISDIR on the first query rather
  // than as a boot failure the operator can read.
  for (const raw of ['/data/', '.', '..', '/', '   ']) {
    assert.throws(
      () => loadConfig({ DATABASE_PATH: raw }),
      /DATABASE_PATH/,
      `${JSON.stringify(raw)} should be rejected`,
    );
  }
});
