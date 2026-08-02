/**
 * Environment parsing and defaults, validated at boot (plan §9).
 *
 * Fail fast and loudly: a bad value here should stop the process at startup,
 * not surface as a strange 500 three phases later.
 *
 * Only the variables the app actually uses are parsed. The rest of §9's table
 * (ADMIN_TOKEN, IP_HMAC_KEY, TRUST_PROXY, the revalidation knobs, …) lands
 * with the phase that first reads it — an unused-but-validated variable is just
 * a way to fail a boot for a feature that does not exist yet.
 *
 * DATABASE_PATH arrives in phase 2 rather than phase 3, deliberately: §12.2 wants
 * the data directory created and probed on the first real deploy, so the
 * root-owned bind mount fails on a deploy that has nothing to lose.
 */

import { basename } from 'node:path';

// §4. Kept here rather than imported from lib/iphash.js so that config stays a leaf
// module; `createIpHasher` re-checks the same floor on the key it is handed.
const MIN_IP_HMAC_KEY_BYTES = 32;

export function loadConfig(env = process.env) {
  const errors = [];

  const port = parsePort(env.PORT, errors);
  const siteUrl = parseSiteUrl(env.SITE_URL, errors);
  const linkbackHosts = parseLinkbackHosts(env.LINKBACK_HOSTS, errors);
  const databasePath = parseDatabasePath(env.DATABASE_PATH, errors);

  // §5's fetcher: `SUBMIT_BUDGET_MS` is the only real ceiling and
  // `FETCH_TIMEOUT_MS` is a per-request sanity cap — the effective per-request
  // timeout is `min(FETCH_TIMEOUT_MS, budgetRemaining)`.
  const fetchTimeoutMs = parsePositiveInt(
    env.FETCH_TIMEOUT_MS,
    8000,
    'FETCH_TIMEOUT_MS',
    errors,
  );
  const maxResponseBytes = parsePositiveInt(
    env.MAX_RESPONSE_BYTES,
    5242880,
    'MAX_RESPONSE_BYTES',
    errors,
  );
  const submitBudgetMs = parsePositiveInt(
    env.SUBMIT_BUDGET_MS,
    30000,
    'SUBMIT_BUDGET_MS',
    errors,
  );

  // §5 Step 5's JS-rendering fallback (`verify/render.js`).
  //
  // OFF by default, and off under NODE_ENV=test for the same reason as
  // REVALIDATE_ENABLED and RSSCLOUD_ENABLED: a test run must never spend an
  // operator's rendering quota, and must never hand a fixture URL to a third party.
  //
  // Unlike the other switches this one cannot default to on even in production —
  // it needs credentials, and a feature that silently does nothing is worse than one
  // an operator had to choose. `renderPage` is `null` when this is false, and
  // `verifySite` then runs exactly as it did before rendering existed.
  const renderEnabled = env.RENDER_ENABLED === 'true' && env.NODE_ENV !== 'test';
  // Read with `parseCredential`, not `parseNonEmpty`: an operator who leaves
  // `RENDER_ACCOUNT_ID=` in the .env while the feature is off has not made a mistake,
  // and stopping the boot over it would be a config validator failing a feature that
  // is switched off. Emptiness only becomes an error below, and only when enabled.
  const renderAccountId = parseCredential(env.RENDER_ACCOUNT_ID);
  const renderApiToken = parseCredential(env.RENDER_API_TOKEN);
  // Overridable so the choice of provider is not welded into the source. The default
  // is Cloudflare's `/content` endpoint, which needs the account id in its path; any
  // endpoint that accepts `{url}` and answers with HTML (or a `{result}` envelope)
  // works without touching this file.
  const renderApiUrl =
    parseOptionalUrl(env.RENDER_API_URL, 'RENDER_API_URL', errors) ??
    (renderAccountId === ''
      ? null
      : `https://api.cloudflare.com/client/v4/accounts/${renderAccountId}/browser-rendering/content`);
  const renderTimeoutMs = parsePositiveInt(
    env.RENDER_TIMEOUT_MS,
    20000,
    'RENDER_TIMEOUT_MS',
    errors,
  );

  // Validated only when switched on: these are the two ways to enable a renderer that
  // can never succeed, and both would surface as every JS-rendered member going
  // permanently `transient` — a failure mode with no error message anywhere.
  if (renderEnabled) {
    if (renderApiToken === '') {
      errors.push('RENDER_API_TOKEN is required when RENDER_ENABLED=true');
    }
    if (renderApiUrl === null) {
      errors.push(
        'RENDER_ACCOUNT_ID (or an explicit RENDER_API_URL) is required when RENDER_ENABLED=true',
      );
    }
  }

  // §6/§9, phase 5. `adminToken` is nullable by design: "no admin UI is served at
  // all if ADMIN_TOKEN is unset" — an absent token disables the routes, a *weak*
  // one stops the boot.
  const adminToken = parseAdminToken(env.ADMIN_TOKEN, errors);
  const production = env.NODE_ENV === 'production';
  const ipHmacKey = parseIpHmacKey(env.IP_HMAC_KEY, errors);
  const trustProxy = env.TRUST_PROXY === 'true';
  const trustedProxyHops = parseNonNegativeInt(
    env.TRUSTED_PROXY_HOPS,
    0,
    'TRUSTED_PROXY_HOPS',
    errors,
  );
  const maxListingsPerDomain = parsePositiveInt(
    env.MAX_LISTINGS_PER_DOMAIN,
    5,
    'MAX_LISTINGS_PER_DOMAIN',
    errors,
  );
  // Not in §9's table; §5 Step 7 requires "a global daily new-listing cap" as the
  // second of its two anti-flood backstops, and a cap needs a number.
  const maxNewListingsPerDay = parsePositiveInt(
    env.MAX_NEW_LISTINGS_PER_DAY,
    50,
    'MAX_NEW_LISTINGS_PER_DAY',
    errors,
  );

  // §8/§9, phase 8a — the revalidation scheduler.
  //
  // `REVALIDATE_INTERVAL_DAYS` is **6, not 7**, on purpose (§8, "Honouring
  // 'removed within a week'"): at 7 the worst case is 7 days plus however long
  // until the site's turn comes round, which makes /about's promise false by a few
  // hours. 6 gives a full day of margin and costs nothing.
  const revalidateEnabled = env.REVALIDATE_ENABLED !== 'false' && env.NODE_ENV !== 'test';
  const revalidateBatch = parsePositiveInt(
    env.REVALIDATE_BATCH,
    20,
    'REVALIDATE_BATCH',
    errors,
  );
  const revalidateIntervalDays = parsePositiveInt(
    env.REVALIDATE_INTERVAL_DAYS,
    6,
    'REVALIDATE_INTERVAL_DAYS',
    errors,
  );
  // The follow-up cadence once `optout_seen_at` is set. Without this arm the
  // removal promise is arithmetically false: the first sighting lands by day 6 and
  // the confirming one, at the ordinary cadence, by day 12 (§8).
  const optoutFollowupHours = parsePositiveInt(
    env.OPTOUT_FOLLOWUP_HOURS,
    24,
    'OPTOUT_FOLLOWUP_HOURS',
    errors,
  );
  // §6: a first sighting that never expires collapses the 24h floor to "one bad
  // moment, ever" — an attacker rechecks a victim during any innocent
  // 200-without-badge window and the next bad scheduler tick removes them.
  const optoutExpiryDays = parsePositiveInt(
    env.OPTOUT_EXPIRY_DAYS,
    14,
    'OPTOUT_EXPIRY_DAYS',
    errors,
  );
  // /recheck/:id's own clock, so a third party cannot reset the scheduler's (§6).
  const recheckCooldownMin = parsePositiveInt(
    env.RECHECK_COOLDOWN_MIN,
    60,
    'RECHECK_COOLDOWN_MIN',
    errors,
  );
  const healthcheckPingUrl = parseOptionalUrl(
    env.HEALTHCHECK_PING_URL,
    'HEALTHCHECK_PING_URL',
    errors,
  );

  // §9, phase 9: the nightly `backup()` timer. On by default — "backups run
  // themselves" is the point, and an operator who has to remember to switch them on
  // is the operator who finds out on restore day that they never did. Off under
  // NODE_ENV=test for the same reason as REVALIDATE_ENABLED: a test run must not
  // write files into `data/backups/`.
  const backupEnabled = env.BACKUP_ENABLED !== 'false' && env.NODE_ENV !== 'test';
  const backupRetentionDays = parsePositiveInt(
    env.BACKUP_RETENTION_DAYS,
    14,
    'BACKUP_RETENTION_DAYS',
    errors,
  );

  // §6.4: rssCloud. Two independent halves, and only the second one is a switch.
  //
  // The `<cloud>`/`<source:cloud>` values below describe *which* cloud server our
  // subscribers may register with; the feed advertises them whatever
  // `RSSCLOUD_ENABLED` says, because that server polls the feed on its own schedule
  // regardless of us. `RSSCLOUD_ENABLED` gates the ping we send on boot — off under
  // NODE_ENV=test for the same reason as REVALIDATE_ENABLED and BACKUP_ENABLED: a
  // test run must never be able to ask a stranger's server to fetch a URL.
  const rsscloudEnabled = env.RSSCLOUD_ENABLED !== 'false' && env.NODE_ENV !== 'test';
  const rsscloudPingUrl = parseUrl(
    env.RSSCLOUD_PING_URL,
    'https://rpc.rsscloud.io/ping',
    'RSSCLOUD_PING_URL',
    errors,
  );
  const rsscloudDomain = parseNonEmpty(
    env.RSSCLOUD_DOMAIN,
    'rpc.rsscloud.io',
    'RSSCLOUD_DOMAIN',
    errors,
  );
  // The port of the **http-post** endpoint, which is 80 on rpc.rsscloud.io even
  // though `<source:cloud>` names the same server over https. It is one of the five
  // attributes RSS 2.0 requires of `<cloud>`, so it has to be a real number.
  const rsscloudPort = parsePositiveInt(env.RSSCLOUD_PORT, 80, 'RSSCLOUD_PORT', errors);
  const rsscloudPath = parseNonEmpty(
    env.RSSCLOUD_PATH,
    '/pleaseNotify',
    'RSSCLOUD_PATH',
    errors,
  );
  const rsscloudProtocol = parseNonEmpty(
    env.RSSCLOUD_PROTOCOL,
    'http-post',
    'RSSCLOUD_PROTOCOL',
    errors,
  );

  // §6.4, phase 7: the blog's markdown lives in a directory that is a read-only bind
  // mount in production (§9), and the cache is invalidated by polling max(mtime)
  // across it — a poll interval, never a directory watch.
  const contentDir = parseNonEmpty(env.CONTENT_DIR, './content', 'CONTENT_DIR', errors);
  const contentPollMs = parsePositiveInt(
    env.CONTENT_POLL_MS,
    30000,
    'CONTENT_POLL_MS',
    errors,
  );

  if (errors.length > 0) {
    throw new Error(
      `Invalid configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  return Object.freeze({
    port,
    siteUrl,
    linkbackHosts,
    databasePath,
    fetchTimeoutMs,
    maxResponseBytes,
    submitBudgetMs,
    adminToken,
    ipHmacKey,
    trustProxy,
    trustedProxyHops,
    maxListingsPerDomain,
    maxNewListingsPerDay,
    revalidateEnabled,
    revalidateBatch,
    revalidateIntervalDays,
    optoutFollowupHours,
    optoutExpiryDays,
    recheckCooldownMin,
    healthcheckPingUrl,
    backupEnabled,
    backupRetentionDays,
    rsscloudEnabled,
    rsscloudPingUrl,
    rsscloudDomain,
    rsscloudPort,
    rsscloudPath,
    rsscloudProtocol,
    contentDir,
    contentPollMs,
    renderEnabled,
    renderApiUrl,
    renderApiToken,
    renderTimeoutMs,
    // The IP-HMAC key's require-or-generate rule branches on this, and it has to
    // branch on something the deploy actually sets.
    production,
  });
}

/** An optional secret or identifier: absent, blank and whitespace all mean "unset". */
function parseCredential(raw) {
  return raw === undefined ? '' : String(raw).trim();
}

function parseNonEmpty(raw, fallback, name, errors) {
  if (raw === undefined) return fallback;

  const value = String(raw).trim();
  if (value === '') {
    errors.push(`${name} must not be empty`);
    return fallback;
  }
  return value;
}

/**
 * An optional absolute http(s) URL — §9's `HEALTHCHECK_PING_URL`. Unset is the
 * normal case, so it returns `null` rather than failing; a *malformed* one stops
 * the boot, because a monitoring ping that silently never fires is worse than no
 * monitoring at all.
 */
function parseOptionalUrl(raw, name, errors) {
  if (raw === undefined || String(raw).trim() === '') return null;

  const value = String(raw).trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${name} must be an absolute URL, got "${value}"`);
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push(`${name} must be http or https, got "${value}"`);
    return null;
  }
  return value;
}

/**
 * An absolute http(s) URL with a default — the always-set counterpart of
 * `parseOptionalUrl`. A malformed one stops the boot rather than being silently
 * replaced by the default: a ping that goes nowhere is indistinguishable from a
 * feature that was never switched on.
 */
function parseUrl(raw, fallback, name, errors) {
  if (raw === undefined || String(raw).trim() === '') return fallback;

  const value = String(raw).trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${name} must be an absolute URL, got "${value}"`);
    return fallback;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push(`${name} must be http or https, got "${value}"`);
    return fallback;
  }
  return value;
}

function parseNonNegativeInt(raw, fallback, name, errors) {
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${name} must be a non-negative integer, got "${raw}"`);
    return fallback;
  }
  return value;
}

/**
 * §6: "validated at boot to be ≥32 bytes of hex/base64". The length is measured in
 * *decoded bytes*, not characters — a 32-character hex string is 16 bytes, which is
 * exactly the mistake the rule exists to catch.
 */
function parseAdminToken(raw, errors) {
  if (raw === undefined || raw === '') return null;

  const token = raw.trim();
  const bytes = /^[0-9a-f]+$/i.test(token)
    ? Math.floor(token.length / 2)
    : /^[A-Za-z0-9+/_-]+={0,2}$/.test(token)
      ? Math.floor((token.replace(/=+$/, '').length * 3) / 4)
      : 0;

  if (bytes < 32) {
    errors.push(
      'ADMIN_TOKEN must be at least 32 bytes of hex or base64 ' +
        '(generate one with: openssl rand -hex 32), not a passphrase',
    );
  }
  return token;
}

/**
 * The IP HMAC key itself, hex or base64 (§4). Unset returns `null`; whether that is
 * fatal is `loadIpHmacKey`'s call, because only production has to refuse it.
 *
 * A value that is *present but too short* always stops the boot, in every
 * environment — an operator who set the variable meant it to be the key, and
 * silently generating a different one instead is the failure that looks like
 * nothing at all.
 */
function parseIpHmacKey(raw, errors) {
  if (raw === undefined || String(raw).trim() === '') return null;

  const key = decodeKey(String(raw).trim());
  if (key === null || key.length < MIN_IP_HMAC_KEY_BYTES) {
    errors.push(
      `IP_HMAC_KEY must be at least ${MIN_IP_HMAC_KEY_BYTES} bytes of hex or base64 ` +
        '(generate one with: openssl rand -hex 32), not a passphrase',
    );
    return null;
  }
  return key;
}

/**
 * Hex is tried FIRST and the order is load-bearing: every 64-character hex string
 * is also valid base64, so a base64-first decoder would read an operator's hex key
 * as 48 unrelated bytes and neither side would notice.
 */
function decodeKey(text) {
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return Buffer.from(text, 'base64');
  return null;
}

function parsePort(raw, errors) {
  if (raw === undefined || raw === '') return 3000;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`PORT must be an integer between 1 and 65535, got "${raw}"`);
    return 3000;
  }
  return port;
}

function parsePositiveInt(raw, fallback, name, errors) {
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    errors.push(`${name} must be a positive integer, got "${raw}"`);
    return fallback;
  }
  return value;
}

function parseSiteUrl(raw, errors) {
  const value = raw === undefined || raw === '' ? 'https://iheartrss.com' : raw;

  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`SITE_URL must be an absolute URL, got "${value}"`);
    return value;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push(`SITE_URL must be http or https, got "${value}"`);
    return value;
  }

  // Normalised to an origin + trailing slash so every `new URL(path, siteUrl)`
  // in the app behaves the same whether or not the operator typed the slash.
  return `${url.origin}/`;
}

function parseDatabasePath(raw, errors) {
  const value = raw === undefined || raw === '' ? './data/iheartrss.db' : raw;

  // The path has to name a *file*. `DatabaseSync` pointed at a directory fails
  // at the first query with EISDIR, which reads as a database bug rather than as
  // the typo it is — and a trailing separator is the common way to write it.
  const file = basename(value);
  const namesADirectory =
    value !== value.trim() ||
    value.trim() === '' ||
    /[/\\]$/.test(value) ||
    file === '' ||
    file === '.' ||
    file === '..';

  if (namesADirectory) {
    errors.push(
      `DATABASE_PATH must name a database file, not a directory, got "${value}"`,
    );
  }

  return value;
}

function parseLinkbackHosts(raw, errors) {
  const value = raw === undefined || raw === '' ? 'iheartrss.com,www.iheartrss.com' : raw;

  const hosts = value
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (hosts.length === 0) {
    errors.push('LINKBACK_HOSTS must list at least one host');
    return [];
  }

  return Object.freeze(hosts);
}
