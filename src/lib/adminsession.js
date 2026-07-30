/**
 * Admin sessions and the CSRF token derived from them (plan §6, "Admin auth").
 *
 * **Sessions live in an in-memory `Map` with a TTL. This is deliberate, and it is
 * not a missing table.** There is one operator. Persisting session material in
 * SQLite would put a bearer credential in the same file as the directory, in every
 * nightly backup and in every off-box copy of it, in exchange for one operator not
 * having to log in again after a redeploy. Being logged out by a redeploy is the
 * correct price. Please don't "fix" this into a `sessions` table.
 *
 * Two more §6 rules are encoded here rather than left to the routes:
 *
 *  * **The cookie holds a random 32-byte session id, never the token.** `ADMIN_TOKEN`
 *    is long-lived, un-rotatable without a redeploy, and has no expiry — putting it
 *    in a browser store is a bad trade for a few saved lines.
 *  * **The CSRF token is *derived* from the session id, so it rotates with it** and
 *    is never stored. It is `sha256(id + ':csrf')`: knowing the CSRF token doesn't
 *    give you the session id (so leaking it in a form body is not a session leak),
 *    and a new login mints a new one for free.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createSessionStore({ now = Date.now, ttlMs = SESSION_TTL_MS } = {}) {
  /** id → expiresAt (ms). */
  const sessions = new Map();

  function sweep() {
    const t = now();
    for (const [id, expiresAt] of sessions) {
      if (expiresAt <= t) sessions.delete(id);
    }
  }

  return {
    ttlMs,

    create() {
      sweep();
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, now() + ttlMs);
      return { id, csrf: csrfFor(id), expiresAt: now() + ttlMs };
    },

    /** Is this session id live? Expiry is checked on read, not by a timer. */
    valid(id) {
      if (typeof id !== 'string' || id === '') return false;
      const expiresAt = sessions.get(id);
      if (expiresAt === undefined) return false;
      if (expiresAt <= now()) {
        sessions.delete(id);
        return false;
      }
      return true;
    },

    destroy(id) {
      return sessions.delete(id);
    },

    csrfFor,

    /** Constant-time compare of a submitted CSRF token against the derived one. */
    csrfMatches(id, supplied) {
      if (typeof supplied !== 'string' || supplied === '') return false;
      // Both sides are hashed, so an unequal length can't throw
      // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH — the same trap as the token compare.
      return timingSafeEqual(sha256(supplied), sha256(csrfFor(id)));
    },

    size: () => sessions.size,
  };
}

/**
 * §6: "Rate-limit and exponentially back off the login route, by IP *and* globally.
 * Log failures. Nothing else here is a shorter path to full control."
 *
 * Separate from `lib/ratelimit.js` on purpose: that limiter's budget is denominated
 * in *outbound fetches we spend on somebody else's server*, and `/admin/login`
 * spends none. Sharing it would either hand a login guesser the submit budget or
 * let a burst of submissions lock the operator out.
 *
 * The two arms are tuned differently, and the asymmetry is the interesting part:
 *
 *  * **Per IP** the curve is aggressive (1s doubling to 15 minutes from the first
 *    failure), because a single source guessing a 32-byte token has nothing
 *    legitimate to lose.
 *  * **Globally** it is deliberately forgiving — nothing until 20 failures, then a
 *    curve capped at a minute. An attacker who can rotate IPs must not be able to
 *    lock the operator out of moderation entirely by spraying failures at the login
 *    form; the global arm exists to bound the aggregate guess *rate*, not to be the
 *    primary defence. That is the token's 256 bits of entropy.
 */
export function createLoginBackoff({
  now = Date.now,
  baseMs = 1000,
  maxMs = 15 * 60 * 1000,
  globalFreeFailures = 20,
  globalMaxMs = 60 * 1000,
  maxKeys = 1000,
} = {}) {
  /** key → { failures, lockedUntil }. */
  const perIp = new Map();
  const global = { failures: 0, lockedUntil: 0 };

  const delay = (failures, cap) => Math.min(cap, baseMs * 2 ** Math.max(0, failures - 1));

  return {
    /**
     * May this client attempt a login? `{ ok: false, scope, retryAfterSeconds }`
     * refuses **whatever token was supplied** — letting a correct one through during
     * a backoff window would turn the 429 into a "that guess was wrong" oracle.
     */
    check(key) {
      const t = now();
      const entry = perIp.get(key);

      if (entry !== undefined && entry.lockedUntil > t) {
        return {
          ok: false,
          scope: 'ip',
          retryAfterSeconds: seconds(entry.lockedUntil - t),
        };
      }
      if (global.lockedUntil > t) {
        return {
          ok: false,
          scope: 'global',
          retryAfterSeconds: seconds(global.lockedUntil - t),
        };
      }
      return { ok: true };
    },

    fail(key) {
      const t = now();
      const entry = perIp.get(key) ?? { failures: 0, lockedUntil: 0 };
      entry.failures += 1;
      entry.lockedUntil = t + delay(entry.failures, maxMs);
      perIp.set(key, entry);

      global.failures += 1;
      if (global.failures > globalFreeFailures) {
        global.lockedUntil = t + delay(global.failures - globalFreeFailures, globalMaxMs);
      }

      sweep(t);
      return { failures: entry.failures, globalFailures: global.failures };
    },

    /** A successful login clears both arms: the operator is not the attacker. */
    succeed(key) {
      perIp.delete(key);
      global.failures = 0;
      global.lockedUntil = 0;
    },

    size: () => perIp.size,
  };

  // Unbounded, the map is itself a memory-exhaustion target (§6). Expired entries
  // go first; if that is not enough, the ones closest to expiry do — never the
  // longest-locked, which is the entry an attacker most wants evicted.
  function sweep(t) {
    if (perIp.size <= maxKeys) return;

    for (const [key, entry] of perIp) {
      if (entry.lockedUntil <= t) perIp.delete(key);
    }
    if (perIp.size <= maxKeys) return;

    const survivors = [...perIp.entries()].sort(
      (a, b) => a[1].lockedUntil - b[1].lockedUntil,
    );
    for (const [key] of survivors) {
      if (perIp.size <= maxKeys) break;
      perIp.delete(key);
    }
  }
}

const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));

function csrfFor(id) {
  return sha256(`${id}:csrf`).toString('base64url');
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest();
}
