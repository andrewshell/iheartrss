/**
 * In-memory rate limiting and the outbound-fetch semaphore (plan §6).
 *
 * Two independent token buckets per client — 5 per 10 minutes and 30 per day —
 * **shared across `/submit`, `/check` and `/recheck`**, because each of those
 * spends up to 6 outbound requests against a third party and a per-route bucket
 * would simply multiply the budget by the number of routes.
 *
 * Known and accepted (§6): NAT means a conference shares one budget, and being
 * in-process means a redeploy resets everything. Right call at this scale.
 */

import { rateLimitKey } from './clientip.js';

const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 10 * 60 * 1000;
const DAILY_LIMIT = 30;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function createRateLimiter({
  now = Date.now,
  burstLimit = BURST_LIMIT,
  burstWindowMs = BURST_WINDOW_MS,
  dailyLimit = DAILY_LIMIT,
  dailyWindowMs = DAILY_WINDOW_MS,
  maxKeys = 10_000,
} = {}) {
  /** key → { burst, updatedAt, day, dailyUsed }. */
  const buckets = new Map();

  const dayOf = (t) => Math.floor(t / dailyWindowMs);

  function bucketFor(key) {
    const t = now();
    let entry = buckets.get(key);

    if (entry === undefined) {
      entry = { burst: burstLimit, updatedAt: t, day: dayOf(t), dailyUsed: 0 };
      buckets.set(key, entry);
      return entry;
    }

    // The burst bucket refills continuously rather than in a fixed window: a fixed
    // 10-minute window lets a client spend the whole budget at 09:59:59 and the
    // whole budget again at 10:00:01, which is 10 verifications in two seconds.
    const elapsed = Math.max(0, t - entry.updatedAt);
    entry.burst = Math.min(
      burstLimit,
      entry.burst + (elapsed * burstLimit) / burstWindowMs,
    );
    entry.updatedAt = t;

    // The daily cap is a calendar-day counter, on the same UTC-date boundary the
    // §4 `ip_hash` rotates on. Continuously refilling it instead would mean 5 per
    // 10 minutes quietly adds up to ~32 per day rather than the stated 30.
    const day = dayOf(t);
    if (day !== entry.day) {
      entry.day = day;
      entry.dailyUsed = 0;
    }

    return entry;
  }

  return {
    /**
     * Spend one token. `{ ok: true }`, or `{ ok: false, scope, retryAfterSeconds }`.
     * Nothing is spent when the answer is no, so a refused client isn't pushed
     * further back by retrying.
     */
    take(ip) {
      const key = rateLimitKey(ip);
      const entry = bucketFor(key);
      const t = now();

      let result;
      if (entry.dailyUsed >= dailyLimit) {
        result = {
          ok: false,
          scope: 'daily',
          retryAfterSeconds: Math.ceil(((entry.day + 1) * dailyWindowMs - t) / 1000),
        };
      } else if (entry.burst < 1) {
        result = {
          ok: false,
          scope: 'burst',
          retryAfterSeconds: Math.ceil(
            ((1 - entry.burst) * burstWindowMs) / burstLimit / 1000,
          ),
        };
      } else {
        entry.burst -= 1;
        entry.dailyUsed += 1;
        result = { ok: true };
      }

      sweep();
      return result;
    },

    size: () => buckets.size,
  };

  /**
   * §6: "Bound the map (LRU or periodic sweep) — unbounded, it's itself a
   * memory-exhaustion target."
   *
   * **Eviction order is by budget remaining, never by age.** Dropping the oldest
   * entry is the obvious LRU and it is wrong here: the oldest entries are the ones
   * that have been rate-limited longest, so an attacker who fills the map hands
   * every throttled client — including itself — a fresh 30-per-day. Entries with
   * the most budget left go first, because evicting one grants back at most the
   * token it had already spent.
   */
  function sweep() {
    if (buckets.size <= maxKeys) return;

    const t = now();
    const today = dayOf(t);
    const survivors = [];

    for (const [key, entry] of buckets) {
      const elapsed = t - entry.updatedAt;
      const refilled =
        entry.burst + (elapsed * burstLimit) / burstWindowMs >= burstLimit &&
        (entry.day !== today || entry.dailyUsed === 0);

      if (refilled) buckets.delete(key);
      else survivors.push([key, entry]);
    }

    if (buckets.size <= maxKeys) return;

    survivors.sort((a, b) => remaining(a[1], today) - remaining(b[1], today));
    while (buckets.size > maxKeys && survivors.length > 0) {
      buckets.delete(survivors.pop()[0]);
    }
  }

  function remaining(entry, today) {
    const daily = entry.day === today ? dailyLimit - entry.dailyUsed : dailyLimit;
    return Math.min(daily, entry.burst);
  }
}

/**
 * §6: "a global semaphore (≈4) on concurrent outbound verifications, so no
 * combination of endpoints can fan out against a third party." The rate limiter
 * bounds one client; this bounds the whole process.
 */
export function createSemaphore(limit) {
  let inFlight = 0;
  const waiting = [];

  function release() {
    const next = waiting.shift();
    if (next !== undefined) return next();
    inFlight -= 1;
  }

  async function acquire() {
    if (inFlight < limit) {
      inFlight += 1;
      return once(release);
    }
    return new Promise((resolve) => {
      waiting.push(() => resolve(once(release)));
    });
  }

  return {
    acquire,
    /** Run `fn` in a slot, releasing it even if `fn` throws. */
    async run(fn) {
      const done = await acquire();
      try {
        return await fn();
      } finally {
        done();
      }
    },
    waiting: () => waiting.length,
  };
}

// A double release would over-grant slots, which is worse than a leaked one.
function once(fn) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
