import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAllowedAddress,
  parseIpBytes,
  isLinkBack,
  normalizeUrl,
  sameOrigin,
} from '../src/verify/url.js';

const LINKBACK_HOSTS = ['iheartrss.com', 'www.iheartrss.com'];

test('normalizeUrl defaults a scheme-less submission to https (§5 Step 0.1)', () => {
  assert.deepEqual(normalizeUrl('example.com/blog'), {
    ok: true,
    url: 'https://example.com/blog',
  });
});

test('normalizeUrl lowercases the host and drops default ports and fragments (§5 Step 0.3)', () => {
  const cases = [
    ['https://EXAMPLE.com/Blog', 'https://example.com/Blog'],
    ['https://example.com:443/blog', 'https://example.com/blog'],
    ['http://example.com:80/blog', 'http://example.com/blog'],
    // A non-default port is part of the address and must survive.
    ['http://example.com:8080/blog', 'http://example.com:8080/blog'],
    ['https://example.com/blog#anchor', 'https://example.com/blog'],
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(normalizeUrl(input), { ok: true, url: expected }, input);
  }
});

test('normalizeUrl strips only the named tracking params (§5 Step 0.4)', () => {
  const cases = [
    // `?p=123` is a real page on a query-string-permalink WordPress install:
    // dropping the whole query string verifies (and lists) the wrong page.
    ['https://example.com/?p=123', 'https://example.com/?p=123'],
    ['https://example.com/?utm_source=x', 'https://example.com/'],
    ['https://example.com/?p=123&utm_source=x', 'https://example.com/?p=123'],
    ['https://example.com/?fbclid=abc&p=7', 'https://example.com/?p=7'],
    ['https://example.com/?ref=hn&p=7', 'https://example.com/?p=7'],
    ['https://example.com/?utm_medium=a&utm_campaign=b', 'https://example.com/'],
    // Not a tracking param, despite the prefix collision.
    ['https://example.com/?reference=9', 'https://example.com/?reference=9'],
    ['https://example.com/?UTM_SOURCE=x&p=1', 'https://example.com/?p=1'],
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(normalizeUrl(input), { ok: true, url: expected }, input);
  }
});

test('normalizeUrl gives a bare host the root path and leaves other paths alone (§5 Step 0.5)', () => {
  const cases = [
    ['example.com', 'https://example.com/'],
    ['https://example.com', 'https://example.com/'],
    // People submit subpages; a normalizer that trimmed to the origin would
    // verify a different page than the one submitted.
    ['https://example.com/blog/posts/', 'https://example.com/blog/posts/'],
    ['https://example.com/blog/posts', 'https://example.com/blog/posts'],
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(normalizeUrl(input), { ok: true, url: expected }, input);
  }
});

test('normalizeUrl rejects empty and unparseable input', () => {
  for (const input of ['', '   ', null, undefined, 'http://', 'https://']) {
    assert.deepEqual(
      normalizeUrl(input),
      { ok: false, reason: 'invalid_url' },
      String(input),
    );
  }
});

test('normalizeUrl rejects schemes other than http/https (§5 Step 0.2)', () => {
  for (const input of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.com/x',
    'data:text/html,hi',
  ]) {
    assert.deepEqual(
      normalizeUrl(input),
      { ok: false, reason: 'unsupported_scheme' },
      input,
    );
  }
});

test('isLinkBack matches on host alone, ignoring scheme, path and trailing slash (§5 Step 5)', () => {
  const base = 'https://member.example/blog/';

  for (const href of [
    'https://iheartrss.com',
    'https://iheartrss.com/',
    'http://iheartrss.com/',
    'https://www.iheartrss.com/badge',
    'https://iheartrss.com/sites?from=member',
    '//iheartrss.com/',
  ]) {
    assert.equal(isLinkBack(href, base, LINKBACK_HOSTS), true, href);
  }
});

test('isLinkBack rejects other hosts, including look-alikes and subdomains', () => {
  const base = 'https://member.example/blog/';

  for (const href of [
    'https://example.com/',
    'https://iheartrss.com.evil.example/',
    'https://notiheartrss.com/',
    'https://blog.iheartrss.com/',
    '/local/page',
    '#top',
    'mailto:hi@iheartrss.com',
    'javascript:location="https://iheartrss.com"',
    '',
  ]) {
    assert.equal(isLinkBack(href, base, LINKBACK_HOSTS), false, href);
  }
});

test('sameOrigin compares scheme, host and port (§5 Step 4)', () => {
  const cases = [
    ['https://example.com/a', 'https://example.com/b/c', true],
    ['https://example.com/', 'https://example.com:443/x', true],
    // Different scheme, host or port are all different origins.
    ['https://example.com/', 'http://example.com/', false],
    ['https://example.com/', 'https://www.example.com/', false],
    ['https://example.com/', 'https://example.com:8443/', false],
    ['https://EXAMPLE.com/', 'https://example.com/', true],
    ['not a url', 'https://example.com/', false],
  ];

  for (const [a, b, expected] of cases) {
    assert.equal(sameOrigin(a, b), expected, `${a} vs ${b}`);
  }
});

// The shared SSRF classifier (§5 Step 1). An ALLOWLIST of global unicast, not a
// deny list: a deny list will always trail IANA. Both `guardedLookup` (DNS
// answers) and `assertHostAllowed` (IP literals in the URL) run this one function.

test('isAllowedAddress rejects IPv4 loopback and accepts a public IPv4 address', () => {
  assert.equal(isAllowedAddress('127.0.0.1'), false);
  assert.equal(isAllowedAddress('127.255.255.254'), false);
  assert.equal(isAllowedAddress('93.184.216.34'), true);
});

test('isAllowedAddress rejects every non-global-unicast IPv4 range in the §5 table', () => {
  for (const address of [
    '10.0.0.1', // private
    '10.255.255.255',
    '172.16.0.1', // private
    '172.31.255.254',
    '192.168.1.1', // private
    '169.254.169.254', // the cloud metadata endpoint
    '169.254.0.1', // link-local
    '100.64.0.1', // CGNAT
    '100.127.255.255',
    '198.18.0.1', // benchmark
    '198.19.255.255',
    '0.0.0.0', // unspecified
    '0.0.0.1', // routes to localhost on Linux
    '255.255.255.255', // broadcast
    '224.0.0.1', // multicast
    '239.255.255.255',
    '240.0.0.1', // reserved
    '192.0.0.1', // 192.0.0.0/24 IETF protocol assignments
  ]) {
    assert.equal(isAllowedAddress(address), false, address);
  }
});

test('isAllowedAddress accepts public IPv4 addresses adjacent to the blocked ranges', () => {
  for (const address of [
    '1.1.1.1',
    '8.8.8.8',
    '11.0.0.1', // just past 10/8
    '172.15.255.255', // just below 172.16/12
    '172.32.0.1', // just past 172.16/12
    '192.167.255.255', // just below 192.168/16
    '192.169.0.1', // just past 192.168/16
    '100.63.255.255', // just below 100.64/10
    '100.128.0.1', // just past 100.64/10
    '169.253.255.255', // just below 169.254/16
    '198.17.255.255', // just below 198.18/15
    '198.20.0.1', // just past 198.18/15
    '223.255.255.255', // just below 224/4
    '192.0.1.1', // just past 192.0.0.0/24
  ]) {
    assert.equal(isAllowedAddress(address), true, address);
  }
});

test('isAllowedAddress accepts public IPv6 and rejects the §5 IPv6 rows', () => {
  // Known-good public addresses: Cloudflare and Google public DNS over v6.
  for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isAllowedAddress(address), true, address);
  }

  for (const address of [
    '::1', // loopback
    '::', // unspecified
    'fc00::1', // fc00::/7 unique-local
    'fdff::1',
    'fe80::1', // fe80::/10 link-local
    'febf::1',
    '64:ff9b::7f00:1', // NAT64 — embeds 127.0.0.1
    '2002:7f00:1::', // 6to4 — embeds 127.0.0.1
    '2001::1', // Teredo
    '::7f00:1', // ::/96 IPv4-compatible, the range a deny list forgets
    '0100::1', // 0100::/64 discard-only
    'ff02::1', // multicast
    '100::1', // discard prefix, compressed spelling
  ]) {
    assert.equal(isAllowedAddress(address), false, address);
  }
});

test('parseIpBytes un-maps IPv4-mapped IPv6 by bytes, in both spellings (§5 Step 1)', () => {
  // `dns.lookup` answers with the dotted form; WHATWG `URL` re-serialises the very
  // same address to compressed hex. A `startsWith('::ffff:')` un-mapper only ever
  // sees the first one, and the second is what actually reaches us.
  assert.deepEqual(
    [...parseIpBytes('::ffff:127.0.0.1')],
    [127, 0, 0, 1],
    'dotted DNS-answer spelling',
  );
  assert.deepEqual(
    [...parseIpBytes('::ffff:7f00:1')],
    [127, 0, 0, 1],
    'compressed spelling from new URL("http://[::ffff:127.0.0.1]/").hostname',
  );

  assert.equal(parseIpBytes('example.com'), null);
  assert.equal(parseIpBytes(''), null);
  assert.equal(parseIpBytes(null), null);
  // Brackets are the URL's punctuation, not part of the address.
  assert.equal(parseIpBytes('[::1]'), null);
});

test('isAllowedAddress rejects loopback wearing an IPv4-mapped IPv6 costume', () => {
  for (const address of [
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
  ]) {
    assert.equal(isAllowedAddress(address), false, address);
  }

  // …while a mapped *public* address stays reachable, so the un-mapping is a
  // classification and not a blanket ban.
  assert.equal(isAllowedAddress('::ffff:93.184.216.34'), true);
});
