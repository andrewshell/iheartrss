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

// Phase 4a adds the three fetch knobs from §9's table, because §5's fetcher is the
// first thing to read them.

test('the fetch budget knobs default to §9 values', () => {
  const config = loadConfig({});

  assert.equal(config.fetchTimeoutMs, 8000);
  assert.equal(config.maxResponseBytes, 5242880);
  assert.equal(config.submitBudgetMs, 30000);
});

test('the fetch budget knobs are taken from the environment and validated', () => {
  const config = loadConfig({
    FETCH_TIMEOUT_MS: '4000',
    MAX_RESPONSE_BYTES: '1048576',
    SUBMIT_BUDGET_MS: '15000',
  });

  assert.equal(config.fetchTimeoutMs, 4000);
  assert.equal(config.maxResponseBytes, 1048576);
  assert.equal(config.submitBudgetMs, 15000);

  // A zero or negative budget would abort every request before it started, and a
  // non-numeric one silently becomes NaN — both must stop the boot.
  for (const [name, raw] of [
    ['FETCH_TIMEOUT_MS', '0'],
    ['FETCH_TIMEOUT_MS', 'soon'],
    ['MAX_RESPONSE_BYTES', '-1'],
    ['MAX_RESPONSE_BYTES', '1.5'],
    ['SUBMIT_BUDGET_MS', 'none'],
  ]) {
    assert.throws(
      () => loadConfig({ [name]: raw }),
      new RegExp(name),
      `${name}=${raw} should be rejected`,
    );
  }
});
