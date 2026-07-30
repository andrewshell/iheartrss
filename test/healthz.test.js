import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db/index.js';
import { probeDataDirectory } from '../src/storage.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();

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

test(
  'the data-directory probe is what the deployed healthcheck reports on',
  {
    skip: process.getuid?.() === 0 ? 'root ignores mode bits' : false,
  },
  (t) => {
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
  },
);

// Plan §8's capacity ceiling: "20 sites/hour × 24 = 480 checks/day; at a 6-day
// interval the steady state is ~2,880 members. Past that, `last_checked_at` slides
// permanently past the interval and the /about promise quietly becomes false with NO
// SIGNAL ANYWHERE — /healthz reports whether a batch ran, not how far behind it is."

test('/healthz reports the last revalidation and how far behind the batch is', async () => {
  const { db, queries } = createDb(':memory:');

  const seed = (host, daysAgo, status = 'active') =>
    db
      .prepare(
        `INSERT INTO sites (url, submitted_url, host, path, feed_url, title, status,
           created_at, last_verified_at, last_checked_at)
         VALUES (?, ?, ?, '/', ?, 'A blog', ?, ?, ?, ?)`,
      )
      .run(
        `https://${host}/`,
        `https://${host}/`,
        host,
        `https://${host}/feed.xml`,
        status,
        NOW_ISO,
        NOW_ISO,
        new Date(NOW - daysAgo * 86400000).toISOString(),
      );

  seed('overdue.example', 10);
  seed('fresh.example', 1);
  // `hidden` is never revalidated, so it can never be overdue (§4).
  seed('hidden.example', 500, 'hidden');

  const app = createApp({
    config: { ...config, revalidateIntervalDays: 6 },
    db,
    queries,
    revalidation: { lastRevalidation: () => '2026-07-29T11:00:00.000Z' },
    now: () => new Date(NOW),
  });

  const body = await (await app.request('/healthz')).json();

  assert.equal(body.ok, true);
  assert.equal(body.sites, 2);
  assert.equal(body.lastRevalidation, '2026-07-29T11:00:00.000Z');
  assert.equal(body.overdue_count, 1);
  assert.equal(body.oldest_last_checked_at, new Date(NOW - 10 * 86400000).toISOString());
});

test('/healthz still answers before the scheduler has ever run', async () => {
  const app = createApp({ config });
  const body = await (await app.request('/healthz')).json();

  // §6 ships the key from phase 1 precisely so monitoring can read one shape: "an
  // absent key reads as a scheduler that has never run rather than one that does not
  // exist."
  assert.equal(body.lastRevalidation, null);
  assert.equal(body.overdue_count, 0);
  assert.equal(body.oldest_last_checked_at, null);
});
