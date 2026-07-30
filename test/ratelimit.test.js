import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter, createSemaphore } from '../src/lib/ratelimit.js';

/** A controllable clock, so no test sleeps. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('the 6th attempt in 10 minutes is refused', () => {
  const c = clock();
  const limit = createRateLimiter({ now: c.now });

  // Plan §6: 5 submissions per 10 minutes.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limit.take('1.2.3.4').ok, true, `attempt ${i + 1} should pass`);
  }

  const refused = limit.take('1.2.3.4');
  assert.equal(refused.ok, false);
  assert.equal(refused.scope, 'burst');
  assert.ok(refused.retryAfterSeconds > 0);
});

test('the burst budget refills over the window', () => {
  const c = clock();
  const limit = createRateLimiter({ now: c.now });

  for (let i = 0; i < 5; i += 1) limit.take('1.2.3.4');
  assert.equal(limit.take('1.2.3.4').ok, false);

  c.advance(10 * 60 * 1000);
  assert.equal(limit.take('1.2.3.4').ok, true);
});

test('the daily budget still bites once the burst window has refilled', () => {
  // Fixed at 00:16 UTC so the ten 11-minute rounds below stay inside one day.
  const c = clock(Date.parse('2026-07-29T00:16:40Z'));
  const limit = createRateLimiter({ now: c.now });

  // §6: 30 per day. Refilling the burst bucket 6 times over must not yield 30+.
  let allowed = 0;
  for (let round = 0; round < 10; round += 1) {
    for (let i = 0; i < 5; i += 1) {
      if (limit.take('1.2.3.4').ok) allowed += 1;
    }
    c.advance(11 * 60 * 1000);
  }

  assert.equal(allowed, 30);
  assert.equal(limit.take('1.2.3.4').scope, 'daily');

  // The daily budget is a calendar-day counter, on the same UTC-date boundary the
  // §4 `ip_hash` rotates on — so "30 per day" means what it says.
  c.advance(24 * 60 * 60 * 1000);
  assert.equal(limit.take('1.2.3.4').ok, true);
});

test('the budget is shared across submit, check and recheck', () => {
  const c = clock();
  const limit = createRateLimiter({ now: c.now });

  // §6: "shared across /submit, /check and /recheck" — a per-route bucket would
  // hand out 15 outbound verifications per 10 minutes instead of 5.
  limit.take('1.2.3.4');
  limit.take('1.2.3.4');
  limit.take('1.2.3.4');
  limit.take('1.2.3.4');
  limit.take('1.2.3.4');

  assert.equal(limit.take('1.2.3.4').ok, false);
});

test('one address exhausting its budget does not affect another', () => {
  const c = clock();
  const limit = createRateLimiter({ now: c.now });

  for (let i = 0; i < 6; i += 1) limit.take('1.2.3.4');
  assert.equal(limit.take('5.6.7.8').ok, true);
});

test('IPv6 addresses in the same /64 share one budget', () => {
  const c = clock();
  const limit = createRateLimiter({ now: c.now });

  for (let i = 0; i < 5; i += 1) limit.take(`2001:db8:1:2::${i + 1}`);

  assert.equal(limit.take('2001:db8:1:2:dead:beef::9').ok, false);
});

test('the bucket map is swept, so it is not itself an exhaustion target', () => {
  const c = clock();
  const limit = createRateLimiter({ now: c.now, maxKeys: 50 });

  for (let i = 0; i < 500; i += 1) limit.take(`10.0.${Math.floor(i / 256)}.${i % 256}`);

  // §6: "Bound the map (LRU or periodic sweep) — unbounded, it's itself a
  // memory-exhaustion target."
  assert.ok(limit.size() <= 50, `map grew to ${limit.size()}`);
});

test('a swept-out address is not thereby granted a fresh daily budget it did not earn', () => {
  const c = clock();
  const limit = createRateLimiter({ now: c.now, maxKeys: 4 });

  for (let i = 0; i < 30; i += 1) limit.take('1.2.3.4');
  assert.equal(limit.take('1.2.3.4').ok, false);

  // Eviction happens on idle entries, and an entry with a spent daily budget is
  // not idle until that budget would have refilled anyway.
  for (let i = 0; i < 20; i += 1) limit.take(`10.0.0.${i}`);
  assert.equal(limit.take('1.2.3.4').ok, false);
});

test('the semaphore caps concurrent outbound verifications', async () => {
  const semaphore = createSemaphore(2);
  let running = 0;
  let peak = 0;

  const job = async () => {
    const release = await semaphore.acquire();
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    release();
  };

  await Promise.all([job(), job(), job(), job(), job(), job()]);

  // §6: "a global semaphore (≈4) on concurrent outbound verifications, so no
  // combination of endpoints can fan out against a third party."
  assert.equal(peak, 2);
});

test('a job that throws still releases its semaphore slot', async () => {
  const semaphore = createSemaphore(1);

  const release = await semaphore.acquire();
  release();

  await assert.rejects(
    semaphore.run(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );

  // If the slot leaked, this would never resolve.
  assert.equal(await semaphore.run(async () => 'free'), 'free');
});
