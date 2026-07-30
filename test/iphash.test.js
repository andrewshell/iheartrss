import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
  const tomorrow = createIpHasher({
    key: KEY,
    now: () => new Date('2026-07-30T00:00:01Z'),
  });

  assert.notEqual(today('203.0.113.7'), tomorrow('203.0.113.7'));

  // Same calendar day, different times, must still bucket together — otherwise
  // the daily rate-limit counters keyed on this hash reset every request.
  const earlier = createIpHasher({
    key: KEY,
    now: () => new Date('2026-07-29T00:00:01Z'),
  });
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

test('the digest is unchanged for a given key, address and day', () => {
  // Pinned so that a change to how the key is *delivered* can never quietly change
  // what is *stored*: a redefinition of the message would orphan every ip_hash
  // already in the database. The expected values come from openssl, not from this
  // module:
  //   printf 'v4:203.0.113.0/24|2026-07-29' |
  //     openssl dgst -sha256 -mac HMAC -macopt hexkey:aaaa…aa
  const hashIp = createIpHasher({ key: KEY, now: DAY });

  assert.equal(
    hashIp('203.0.113.7'),
    '35a435b761bf1eea13fd2fdfd7483441643e5e091c3edf394fe5620238a8be65',
  );
  assert.equal(
    hashIp('2001:db8:1:2::1'),
    'b871b6c679a4772444daf75070a3bde654c6d66e7f88c0a214ea75a4d2406073',
  );
});

test('the configured key is used as-is, in production and out of it', () => {
  assert.deepEqual(loadIpHmacKey({ key: KEY, production: true }), KEY);
  assert.deepEqual(loadIpHmacKey({ key: KEY, production: false }), KEY);
});

test('a missing key is fatal in production', () => {
  // §4/§9: required in production, validated at boot. A key generated on every
  // boot would silently reset the rate limiter's daily bucket and unjoin the
  // abuse trail on each redeploy — a failure that looks like nothing at all.
  assert.throws(() => loadIpHmacKey({ key: null, production: true }), {
    message: /IP_HMAC_KEY.*openssl rand -hex 32/s,
  });
});

test('a missing key outside production yields an ephemeral key, written nowhere', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'iheartrss-key-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const before = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(before));

  const logged = [];
  const first = loadIpHmacKey({
    key: null,
    production: false,
    log: (event) => logged.push(event),
  });

  // Usable: 32+ bytes, and `createIpHasher` accepts it.
  assert.ok(first.length >= 32);
  assert.match(createIpHasher({ key: first, now: DAY })('203.0.113.7'), /^[0-9a-f]{64}$/);

  // Ephemeral, and *said* to be: a dev whose hashes changed under them should be
  // able to find out why from the boot log.
  assert.ok(logged.some((event) => /ephemeral/i.test(event)));

  // Nothing on disk — creating a key file over ssh before the first deploy is the
  // friction this change removes, so the dev path must not reintroduce it.
  assert.deepEqual(readdirSync(cwd), []);

  // And a fresh one each call, since there is nowhere to remember it.
  assert.notDeepEqual(loadIpHmacKey({ key: null, production: false }), first);
});
