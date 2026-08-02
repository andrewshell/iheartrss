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
  for (const raw of [
    'hunter2',
    'correct horse battery staple',
    'abcd',
    'ab'.repeat(15),
  ]) {
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

// The same 32 bytes (0x00…0x1f) written the two ways an operator plausibly would.
// Both literals are fixed here rather than derived from one another, so a decoding
// bug cannot make the test quietly agree with itself.
const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY_BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

test('IP_HMAC_KEY is decoded from hex or base64 to the same 32 bytes', () => {
  // One configuration path: the key arrives in the .env dockge already manages,
  // so there is no file to create over ssh before the first deploy.
  const fromHex = loadConfig({ IP_HMAC_KEY: KEY_HEX }).ipHmacKey;
  const fromBase64 = loadConfig({ IP_HMAC_KEY: KEY_BASE64 }).ipHmacKey;

  assert.equal(fromHex.length, 32);
  assert.equal(fromHex[0], 0x00);
  assert.equal(fromHex[31], 0x1f);
  assert.deepEqual(fromBase64, fromHex);
});

test('a short IP_HMAC_KEY stops the boot and says how to make a real one', () => {
  // 16 bytes written as 32 hex characters — the exact mistake the byte-count rule
  // exists to catch, since it *looks* the right sort of length.
  assert.throws(() => loadConfig({ IP_HMAC_KEY: '0123456789abcdef0123456789abcdef' }), {
    message: /IP_HMAC_KEY must be at least 32 bytes.*openssl rand -hex 32/s,
  });

  // A passphrase is neither hex nor base64 and must not be used as raw bytes.
  assert.throws(
    () => loadConfig({ IP_HMAC_KEY: 'correct horse battery staple' }),
    /IP_HMAC_KEY/,
  );
});

test('production is derived from NODE_ENV, because the missing-key rule differs', () => {
  assert.equal(loadConfig({}).production, false);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).production, true);
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
  assert.throws(
    () => loadConfig({ OPTOUT_EXPIRY_DAYS: 'two weeks' }),
    /OPTOUT_EXPIRY_DAYS/,
  );
});

// §9: "Off in dev/tests." Nothing in the test suite boots `server.js`, but the
// scheduler reaching out to the real network from a test run would be a bug worth
// making impossible rather than merely unlikely.
test('REVALIDATE_ENABLED is off under NODE_ENV=test', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).revalidateEnabled, false);
});

// §9's backup timer, phase 9. Same shape as the revalidation switch: on by
// default, off under NODE_ENV=test so a test run cannot litter `data/backups/`.
test('the backup knobs default to §9 values and are validated', () => {
  const config = loadConfig({});

  assert.equal(config.backupEnabled, true);
  assert.equal(config.backupRetentionDays, 14);

  const custom = loadConfig({ BACKUP_ENABLED: 'false', BACKUP_RETENTION_DAYS: '30' });
  assert.equal(custom.backupEnabled, false);
  assert.equal(custom.backupRetentionDays, 30);

  // Zero-day retention would delete tonight's copy on the tick that wrote it.
  assert.throws(
    () => loadConfig({ BACKUP_RETENTION_DAYS: '0' }),
    /BACKUP_RETENTION_DAYS/,
  );
});

test('BACKUP_ENABLED is off under NODE_ENV=test', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).backupEnabled, false);
});

// §6.4's rssCloud support: the `<cloud>` attributes the feed advertises, plus the
// restart ping. Defaults are rpc.rsscloud.io's own documented values.
test('the rssCloud knobs default to rpc.rsscloud.io and are validated', () => {
  const config = loadConfig({});

  assert.equal(config.rsscloudEnabled, true);
  assert.equal(config.rsscloudPingUrl, 'https://rpc.rsscloud.io/ping');
  assert.equal(config.rsscloudDomain, 'rpc.rsscloud.io');
  assert.equal(config.rsscloudPort, 80);
  assert.equal(config.rsscloudPath, '/pleaseNotify');
  assert.equal(config.rsscloudProtocol, 'http-post');

  const custom = loadConfig({
    RSSCLOUD_ENABLED: 'false',
    RSSCLOUD_PING_URL: 'http://localhost:5337/ping',
    RSSCLOUD_DOMAIN: 'cloud.example',
    RSSCLOUD_PORT: '5337',
    RSSCLOUD_PATH: '/notify',
    RSSCLOUD_PROTOCOL: 'https-post',
  });
  assert.equal(custom.rsscloudEnabled, false);
  assert.equal(custom.rsscloudPingUrl, 'http://localhost:5337/ping');
  assert.equal(custom.rsscloudDomain, 'cloud.example');
  assert.equal(custom.rsscloudPort, 5337);
  assert.equal(custom.rsscloudPath, '/notify');
  assert.equal(custom.rsscloudProtocol, 'https-post');

  // A ping URL that isn't a URL means every restart logs a failure nobody reads.
  assert.throws(() => loadConfig({ RSSCLOUD_PING_URL: 'rpc.rsscloud.io' }), /PING_URL/);
  assert.throws(() => loadConfig({ RSSCLOUD_PORT: '0' }), /RSSCLOUD_PORT/);
});

test('RSSCLOUD_ENABLED is off under NODE_ENV=test', () => {
  // Same rule as REVALIDATE_ENABLED/BACKUP_ENABLED: a test run must not be able to
  // ask a stranger's server to fetch anything.
  assert.equal(loadConfig({ NODE_ENV: 'test' }).rsscloudEnabled, false);
});

// §5 Step 5's rendering fallback. The failure this section guards is a renderer that
// is switched ON but cannot possibly succeed: every JS-rendered member then goes
// permanently `transient`, which produces no error message anywhere.

test('rendering is off unless RENDER_ENABLED is exactly "true"', () => {
  assert.equal(loadConfig({}).renderEnabled, false);
  assert.equal(loadConfig({ RENDER_ENABLED: 'false' }).renderEnabled, false);
  assert.equal(loadConfig({ RENDER_ENABLED: '1' }).renderEnabled, false);
});

test('rendering is forced off under NODE_ENV=test', () => {
  // Same rule as REVALIDATE_ENABLED and RSSCLOUD_ENABLED: no test run may spend an
  // operator's rendering quota, or hand a fixture URL to a third party.
  const config = loadConfig({
    NODE_ENV: 'test',
    RENDER_ENABLED: 'true',
    RENDER_ACCOUNT_ID: 'acct',
    RENDER_API_TOKEN: 'tok',
  });

  assert.equal(config.renderEnabled, false);
});

test('RENDER_ACCOUNT_ID builds the Cloudflare endpoint', () => {
  const config = loadConfig({
    RENDER_ENABLED: 'true',
    RENDER_ACCOUNT_ID: 'abc123',
    RENDER_API_TOKEN: 'tok',
  });

  assert.equal(
    config.renderApiUrl,
    'https://api.cloudflare.com/client/v4/accounts/abc123/browser-rendering/content',
  );
});

test('an explicit RENDER_API_URL wins, so the provider is not welded into the source', () => {
  const config = loadConfig({
    RENDER_ENABLED: 'true',
    RENDER_ACCOUNT_ID: 'abc123',
    RENDER_API_TOKEN: 'tok',
    RENDER_API_URL: 'https://chrome.example/content',
  });

  assert.equal(config.renderApiUrl, 'https://chrome.example/content');
});

test('rendering enabled without credentials stops the boot', () => {
  assert.throws(
    () => loadConfig({ RENDER_ENABLED: 'true', RENDER_ACCOUNT_ID: 'abc123' }),
    /RENDER_API_TOKEN/,
  );
  assert.throws(
    () => loadConfig({ RENDER_ENABLED: 'true', RENDER_API_TOKEN: 'tok' }),
    /RENDER_ACCOUNT_ID/,
  );
});

test('blank render credentials are only an error once rendering is switched on', () => {
  // An operator who leaves `RENDER_ACCOUNT_ID=` in the .env with the feature off has
  // not made a mistake, and a config validator that fails a boot over a disabled
  // feature is worse than the feature.
  assert.doesNotThrow(() => loadConfig({ RENDER_ACCOUNT_ID: '', RENDER_API_TOKEN: '' }));
});
