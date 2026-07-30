import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createIpHasher, loadIpHmacKey } from '../src/lib/iphash.js';

const KEY = Buffer.from('a'.repeat(64), 'hex');
const OTHER_KEY = Buffer.from('b'.repeat(64), 'hex');
const DAY = () => new Date('2026-07-29T12:00:00.000Z');

test('two addresses in the same IPv4 /24 hash to the same value', () => {
  const hashIp = createIpHasher({ key: KEY, now: DAY });

  // Plan §4: truncate to /24 before hashing — that is all abuse triage needs.
  assert.equal(hashIp('203.0.113.7'), hashIp('203.0.113.200'));
  assert.notEqual(hashIp('203.0.113.7'), hashIp('203.0.114.7'));
});

test('two addresses in the same IPv6 /64 hash to the same value', () => {
  const hashIp = createIpHasher({ key: KEY, now: DAY });

  // /64, not /128: a residential customer has ~18 quintillion addresses (§6).
  assert.equal(
    hashIp('2001:db8:1:2:aaaa::1'),
    hashIp('2001:db8:1:2:ffff:ffff:ffff:ffff'),
  );
  assert.notEqual(hashIp('2001:db8:1:2::1'), hashIp('2001:db8:1:3::1'));
});

test('the hash rotates daily so yesterday cannot be linked to today', () => {
  const today = createIpHasher({ key: KEY, now: () => new Date('2026-07-29T23:59:59Z') });
  const tomorrow = createIpHasher({ key: KEY, now: () => new Date('2026-07-30T00:00:01Z') });

  assert.notEqual(today('203.0.113.7'), tomorrow('203.0.113.7'));

  // Same calendar day, different times, must still bucket together — otherwise
  // the daily rate-limit counters keyed on this hash reset every request.
  const earlier = createIpHasher({ key: KEY, now: () => new Date('2026-07-29T00:00:01Z') });
  assert.equal(today('203.0.113.7'), earlier('203.0.113.7'));
});

test('the hash rests on the key, not on the algorithm', () => {
  const mine = createIpHasher({ key: KEY, now: DAY });
  const theirs = createIpHasher({ key: OTHER_KEY, now: DAY });

  // §4: the whole IPv4 space is 2^32, so an unkeyed digest is a rainbow table.
  assert.notEqual(mine('203.0.113.7'), theirs('203.0.113.7'));
});

test('the stored value never contains the address it came from', () => {
  const hashIp = createIpHasher({ key: KEY, now: DAY });

  const v4 = hashIp('203.0.113.7');
  assert.doesNotMatch(v4, /203|113/);
  assert.match(v4, /^[0-9a-f]{64}$/);

  const v6 = hashIp('2001:db8:1:2::1');
  assert.doesNotMatch(v6, /2001|db8/);
  assert.match(v6, /^[0-9a-f]{64}$/);
});

test('an unparseable address still yields a hash rather than throwing', () => {
  const hashIp = createIpHasher({ key: KEY, now: DAY });

  // Rate limiting and `submissions.ip_hash NOT NULL` both run off this value, so
  // a socket with no remote address must not 500 the request.
  assert.match(hashIp(undefined), /^[0-9a-f]{64}$/);
  assert.notEqual(hashIp(undefined), hashIp('203.0.113.7'));
});

test('a missing key file is fatal in production and generated in development', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iheartrss-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'ip_hmac_key');

  // §4/§9: required in production, validated at boot. A key generated on every
  // boot would silently reset the rate limiter's daily bucket and unjoin the
  // abuse trail on each redeploy — a failure that looks like nothing at all.
  assert.throws(() => loadIpHmacKey({ path, production: true }), /IP_HMAC_KEY_FILE/);

  const generated = loadIpHmacKey({ path, production: false });
  assert.ok(generated.length >= 32);
  assert.deepEqual(loadIpHmacKey({ path, production: true }), generated);
});

test('a too-short key file is refused rather than quietly used', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iheartrss-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ip_hmac_key');
  writeFileSync(path, 'hunter2');

  assert.throws(() => loadIpHmacKey({ path, production: false }), /at least 32/);
});

test('a hex-encoded key file is accepted, since an operator will write text', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'iheartrss-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ip_hmac_key');
  writeFileSync(path, `${'ab'.repeat(32)}\n`);

  assert.deepEqual(loadIpHmacKey({ path, production: true }), Buffer.from('ab'.repeat(32), 'hex'));
});
