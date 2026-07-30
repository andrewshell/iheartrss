/**
 * The `submissions.ip_hash` / `reports.ip_hash` construction (plan §4).
 *
 * HMAC-SHA256(key, truncate(ip) + 'YYYY-MM-DD'). Never the raw address. Three
 * deliberate choices, all of them from §4:
 *
 *  1. **HMAC under a secret key**, not sha256 with a published salt. The whole
 *     IPv4 space is 2^32, so a plain salted digest is a GPU-minutes rainbow table
 *     and the scheme rests entirely on the secret staying secret.
 *
 *     The key arrives as `IP_HMAC_KEY`, one env var. It used to be a mounted
 *     file, on the argument that an env var is readable from `docker inspect` and
 *     from dockge's UI — true, and the honest cost of this change. It bought
 *     little in practice: the `.env` holding it already sat in the same stack
 *     directory as `./data`, and the file meant ssh-ing to the box to create a
 *     secret before the very first deploy. One configuration path, and (2) and
 *     (3) below are what keep the residual exposure small.
 *  2. **Truncate first** — /24 for IPv4, /64 for IPv6. That is all abuse triage
 *     needs, and /64 is already the rate-limit bucket.
 *  3. **A daily-rotating date component**, so hashes older than the abuse window
 *     can't be linked to today's. Truncation makes the input space small, so
 *     cross-day correlation is the residual risk this closes.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { parseIpBytes } from '../verify/url.js';

const MIN_KEY_BYTES = 32;

/**
 * @param {object} deps
 * @param {Buffer} deps.key - ≥32 bytes, from `loadIpHmacKey`.
 * @param {Function} [deps.now] - injected so the daily rotation is testable.
 * @returns {(ip: string) => string} hex digest.
 */
export function createIpHasher({ key, now = () => new Date() }) {
  if (!key || key.length < MIN_KEY_BYTES) {
    throw new Error(`IP HMAC key must be at least ${MIN_KEY_BYTES} bytes`);
  }

  return function hashIp(ip) {
    const day = now().toISOString().slice(0, 10);

    return createHmac('sha256', key)
      .update(`${truncateIp(ip)}|${day}`)
      .digest('hex');
  };
}

/**
 * The rate-limit bucket key, and the input to the hash. Exported because
 * `ratelimit.js` must bucket on exactly the same granularity the hash does —
 * per-/128 limits on IPv6 are decorative (§6).
 */
export function truncateIp(ip) {
  const bytes = parseIpBytes(ip);

  // A socket with no remote address, or an XFF entry that isn't an address at
  // all, must still produce a stable key: `ip_hash` is NOT NULL and the rate
  // limiter needs a bucket. Fall back to the literal text rather than throwing.
  if (bytes === null) return `raw:${String(ip ?? '')}`;

  if (bytes.length === 4) {
    return `v4:${bytes[0]}.${bytes[1]}.${bytes[2]}.0/24`;
  }

  const prefix = [...bytes.subarray(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v6:${prefix}/64`;
}

/**
 * Settle on the HMAC key: the configured one if there is one, otherwise — outside
 * production only — an ephemeral one held in memory for this process.
 *
 * Production must fail rather than generate. A key that changes every redeploy
 * quietly breaks the rate limiter's daily bucket and makes the abuse trail
 * unjoinable — a failure that looks like nothing at all.
 *
 * The dev key is deliberately NOT written to disk. Decoding and validating the
 * operator's value is `loadConfig`'s job (`IP_HMAC_KEY`); by here it is either a
 * usable buffer or absent.
 *
 * @param {object} deps
 * @param {Buffer|null} deps.key - the decoded `IP_HMAC_KEY`, or null if unset.
 * @param {boolean} deps.production
 * @param {Function} [deps.log] - boot logger, so the ephemeral case is announced.
 * @returns {Buffer}
 */
export function loadIpHmacKey({ key, production, log = () => {} }) {
  if (key && key.length >= MIN_KEY_BYTES) return key;

  if (production) {
    throw new Error(
      `IP_HMAC_KEY is not set. It must hold at least ${MIN_KEY_BYTES} random ` +
        'bytes of hex or base64 — generate one with: openssl rand -hex 32',
    );
  }

  // Said out loud, because every stored `ip_hash` changes the next time this
  // process restarts and a dev comparing two runs deserves to know why.
  log('iphash.ephemeral');
  return randomBytes(MIN_KEY_BYTES);
}
