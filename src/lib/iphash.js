/**
 * The `submissions.ip_hash` / `reports.ip_hash` construction (plan §4).
 *
 * HMAC-SHA256(key, truncate(ip) + 'YYYY-MM-DD'). Never the raw address. Three
 * deliberate choices, all of them from §4:
 *
 *  1. **HMAC under a key from a mounted file**, not sha256 with an env-var salt.
 *     The whole IPv4 space is 2^32, so a plain salted digest is a GPU-minutes
 *     rainbow table and the scheme rests entirely on the secret — and an env var
 *     sits in `docker inspect`, in dockge's UI, and in any `.env` backed up
 *     beside `./data`.
 *  2. **Truncate first** — /24 for IPv4, /64 for IPv6. That is all abuse triage
 *     needs, and /64 is already the rate-limit bucket.
 *  3. **A daily-rotating date component**, so hashes older than the abuse window
 *     can't be linked to today's. Truncation makes the input space small, so
 *     cross-day correlation is the residual risk this closes.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
 * Read the HMAC key, or in non-production create one.
 *
 * Production must fail: a generated-on-boot key silently changes every redeploy,
 * which quietly breaks the rate limiter's daily bucket and makes the abuse trail
 * unjoinable — a failure that looks like nothing at all.
 */
export function loadIpHmacKey({ path, production }) {
  if (existsSync(path)) {
    const raw = readFileSync(path);

    // Text decoding is tried FIRST. A 64-char hex key written with a trailing
    // newline is 65 raw bytes, which passes a raw length check — so a
    // raw-bytes-first order silently keys off the ASCII of the hex digits and
    // makes the operator's key and ours disagree about what the secret is.
    const decoded = decodeText(raw) ?? (raw.length >= MIN_KEY_BYTES ? raw : null);

    if (decoded === null || decoded.length < MIN_KEY_BYTES) {
      throw new Error(
        `IP_HMAC_KEY_FILE "${path}" must hold at least ${MIN_KEY_BYTES} random bytes`,
      );
    }
    return decoded;
  }

  if (production) {
    throw new Error(
      `IP_HMAC_KEY_FILE "${path}" does not exist. Create it with: ` +
        `head -c 32 /dev/urandom > ${path}`,
    );
  }

  const key = randomBytes(MIN_KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

// An operator will reasonably write the key as hex or base64 text rather than raw
// bytes; 32 raw bytes and a 64-char hex string are both acceptable.
function decodeText(buffer) {
  const text = buffer.toString('utf8').trim();
  if (/^[0-9a-f]{64,}$/i.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/=]{44,}$/.test(text)) return Buffer.from(text, 'base64');
  return null;
}
