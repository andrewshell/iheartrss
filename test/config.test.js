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

// --- Phase 5: the submit flow's variables -----------------------------------

test('ADMIN_TOKEN must be at least 32 bytes of hex or base64', () => {
  // §6: an operator will otherwise pick a passphrase, and nothing else here is a
  // shorter path to full control.
  for (const raw of ['hunter2', 'correct horse battery staple', 'abcd', 'ab'.repeat(15)]) {
    assert.throws(() => loadConfig({ ADMIN_TOKEN: raw }), /ADMIN_TOKEN/, raw);
  }

  const hex = loadConfig({ ADMIN_TOKEN: 'ab'.repeat(32) });
  assert.equal(hex.adminToken, 'ab'.repeat(32));
});

test('an unset ADMIN_TOKEN disables the admin routes rather than failing the boot', () => {
  // §6: "No admin UI is served at all if ADMIN_TOKEN is unset."
  assert.equal(loadConfig({}).adminToken, null);
});

test('TRUSTED_PROXY_HOPS defaults to 0, for one nginx', () => {
  const config = loadConfig({});

  assert.equal(config.trustProxy, false);
  assert.equal(config.trustedProxyHops, 0);

  const proxied = loadConfig({ TRUST_PROXY: 'true', TRUSTED_PROXY_HOPS: '1' });
  assert.equal(proxied.trustProxy, true);
  assert.equal(proxied.trustedProxyHops, 1);

  assert.throws(() => loadConfig({ TRUSTED_PROXY_HOPS: '-1' }), /TRUSTED_PROXY_HOPS/);
});

test('the listing caps have the §9 defaults and must be positive', () => {
  const config = loadConfig({});

  assert.equal(config.maxListingsPerDomain, 5);
  assert.ok(config.maxNewListingsPerDay > 0);

  assert.throws(
    () => loadConfig({ MAX_LISTINGS_PER_DOMAIN: '0' }),
    /MAX_LISTINGS_PER_DOMAIN/,
  );
});

test('IP_HMAC_KEY_FILE defaults to the mounted secret path', () => {
  // §9: a FILE, not an env var — an env var sits in `docker inspect`, in dockge's
  // UI, and in any .env backed up beside ./data. The mounted path is the PRODUCTION
  // default only; see the dev-default test below for why that distinction matters.
  assert.equal(
    loadConfig({ NODE_ENV: 'production' }).ipHmacKeyFile,
    '/run/secrets/ip_hmac_key',
  );
  assert.equal(loadConfig({ IP_HMAC_KEY_FILE: './data/key' }).ipHmacKeyFile, './data/key');
  assert.throws(() => loadConfig({ IP_HMAC_KEY_FILE: '  ' }), /IP_HMAC_KEY_FILE/);
});

test('production is derived from NODE_ENV, because the key file rules differ', () => {
  assert.equal(loadConfig({}).production, false);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).production, true);
});

test('IP_HMAC_KEY_FILE defaults inside the project outside production (§9)', () => {
  // Regression: the default was the production path /run/secrets/ip_hmac_key in every
  // environment, so `pnpm dev` died at boot trying to mkdir a root-owned system directory.
  // Tests never caught it because they inject the key directly.
  const dev = loadConfig({ SITE_URL: 'https://iheartrss.com' });
  assert.equal(dev.production, false);
  assert.ok(
    !dev.ipHmacKeyFile.startsWith('/run/'),
    `dev default must stay inside the project, got ${dev.ipHmacKeyFile}`,
  );

  const prod = loadConfig({ SITE_URL: 'https://iheartrss.com', NODE_ENV: 'production' });
  assert.equal(prod.ipHmacKeyFile, '/run/secrets/ip_hmac_key');
});

// Phase 7, §6.4: the blog's content directory and its poll interval.

test('the blog content knobs default to ./content and a 30s poll', () => {
  const config = loadConfig({});

  assert.equal(config.contentDir, './content');
  assert.equal(config.contentPollMs, 30000);
});

test('the blog content knobs are taken from the environment', () => {
  const config = loadConfig({ CONTENT_DIR: '/app/content', CONTENT_POLL_MS: '5000' });

  assert.equal(config.contentDir, '/app/content');
  assert.equal(config.contentPollMs, 5000);
});

test('a non-numeric CONTENT_POLL_MS stops the boot rather than polling never', () => {
  assert.throws(() => loadConfig({ CONTENT_POLL_MS: 'often' }), /CONTENT_POLL_MS/);
});

// Phase 8a, §9: the revalidation knobs. The interval is 6 days and not 7 on
// purpose (§8, "Honouring 'removed within a week'") — at 7 the worst case is 7
// days plus however long until the site's turn comes round, which makes /about's
// promise false by a few hours.

test('the revalidation knobs default to §9 values', () => {
  const config = loadConfig({});

  assert.equal(config.revalidateEnabled, true);
  assert.equal(config.revalidateBatch, 20);
  assert.equal(config.revalidateIntervalDays, 6);
  assert.equal(config.optoutFollowupHours, 24);
  assert.equal(config.optoutExpiryDays, 14);
  assert.equal(config.recheckCooldownMin, 60);
  assert.equal(config.healthcheckPingUrl, null);
});

test('the revalidation knobs are taken from the environment and validated', () => {
  const config = loadConfig({
    REVALIDATE_ENABLED: 'false',
    REVALIDATE_BATCH: '5',
    REVALIDATE_INTERVAL_DAYS: '3',
    OPTOUT_FOLLOWUP_HOURS: '12',
    OPTOUT_EXPIRY_DAYS: '7',
    RECHECK_COOLDOWN_MIN: '30',
    HEALTHCHECK_PING_URL: 'https://hc-ping.com/abc',
  });

  assert.equal(config.revalidateEnabled, false);
  assert.equal(config.revalidateBatch, 5);
  assert.equal(config.revalidateIntervalDays, 3);
  assert.equal(config.optoutFollowupHours, 12);
  assert.equal(config.optoutExpiryDays, 7);
  assert.equal(config.recheckCooldownMin, 30);
  assert.equal(config.healthcheckPingUrl, 'https://hc-ping.com/abc');

  assert.throws(() => loadConfig({ REVALIDATE_BATCH: '0' }), /REVALIDATE_BATCH/);
  assert.throws(() => loadConfig({ OPTOUT_EXPIRY_DAYS: 'two weeks' }), /OPTOUT_EXPIRY_DAYS/);
});

// §9: "Off in dev/tests." Nothing in the test suite boots `server.js`, but the
// scheduler reaching out to the real network from a test run would be a bug worth
// making impossible rather than merely unlikely.
test('REVALIDATE_ENABLED is off under NODE_ENV=test', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).revalidateEnabled, false);
});
