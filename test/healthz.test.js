import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { probeDataDirectory } from '../src/storage.js';

const config = {
  port: 3000,
  siteUrl: 'https://iheartrss.com',
  linkbackHosts: ['iheartrss.com'],
  databasePath: './data/iheartrss.db',
};

// Plan §9: "/healthz must return 503 when unhealthy. The healthcheck as written
// only inspects HTTP status, so `{ok: false}` with a 200 passes and the
// container is never restarted."

test('an unhealthy dependency makes /healthz 503, not a 200 saying so', async () => {
  const app = createApp({
    config,
    checkHealth: () => ({ ok: false, reason: 'data directory is not writable' }),
  });

  const res = await app.request('/healthz');

  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.reason, /not writable/);
});

test('a health check that throws is unhealthy, not a 500', async () => {
  const app = createApp({
    config,
    checkHealth: () => {
      throw new Error('EACCES probing /data');
    },
  });

  const res = await app.request('/healthz');

  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
});

test('/healthz is 200 when every dependency answers', async () => {
  const app = createApp({ config, checkHealth: () => ({ ok: true }) });
  const res = await app.request('/healthz');

  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('the data-directory probe is what the deployed healthcheck reports on', {
  skip: process.getuid?.() === 0 ? 'root ignores mode bits' : false,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'iheartrss-healthz-'));
  t.after(() => {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  const databasePath = join(root, 'iheartrss.db');
  assert.deepEqual(probeDataDirectory({ databasePath }), { ok: true });

  // A `chown -R root:root data` during a botched restore is exactly the state
  // that should restart the container rather than serve 200s.
  chmodSync(root, 0o555);
  const unhealthy = probeDataDirectory({ databasePath });

  assert.equal(unhealthy.ok, false);
  assert.match(unhealthy.reason, /not writable/i);
});
