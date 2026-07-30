import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clientIp, rateLimitKey } from '../src/lib/clientip.js';

/** The shape `clientIp` reads: a header lookup plus the immediate peer. */
function request({ xff, peer = '172.18.0.5' } = {}) {
  return {
    header: (name) => (name.toLowerCase() === 'x-forwarded-for' ? xff : undefined),
    peer,
  };
}

test('with one nginx in front, hops=0 yields the RIGHTMOST entry', () => {
  // Plan §6, the worked example, asserted verbatim: nginx appends the immediate
  // peer, so the app sees `<client-supplied garbage>, <real peer>` and the real
  // client is the LAST entry. Peeling one more returns a value the client chose.
  const ip = clientIp(request({ xff: '1.2.3.4, 9.9.9.9' }), {
    trustProxy: true,
    trustedProxyHops: 0,
  });

  assert.equal(ip, '9.9.9.9');
});

test('hops=1 skips past the rightmost entry, for two proxies', () => {
  const ip = clientIp(request({ xff: '1.2.3.4, 203.0.113.9, 10.0.0.7' }), {
    trustProxy: true,
    trustedProxyHops: 1,
  });

  assert.equal(ip, '203.0.113.9');
});

test('X-Forwarded-For is ignored entirely when the proxy is not trusted', () => {
  const ip = clientIp(request({ xff: '1.2.3.4', peer: '198.51.100.22' }), {
    trustProxy: false,
    trustedProxyHops: 0,
  });

  assert.equal(ip, '198.51.100.22');
});

test('a trusted-proxy setup refuses a peer that is not a private address', () => {
  // §6: the process cannot see how Docker published its port, so instead of
  // asserting something unobservable we check the immediate peer is private and
  // reject-and-log if it isn't — that catches a direct public connection for real.
  const result = clientIp(request({ xff: '1.2.3.4, 9.9.9.9', peer: '198.51.100.22' }), {
    trustProxy: true,
    trustedProxyHops: 0,
  });

  // The forged header must not be honoured; fall back to the actual peer.
  assert.equal(result, '198.51.100.22');
});

test('peeling past the end of the header falls back to the peer, not undefined', () => {
  const ip = clientIp(request({ xff: '9.9.9.9' }), {
    trustProxy: true,
    trustedProxyHops: 3,
  });

  assert.equal(ip, '172.18.0.5');
});

test('a bracketed IPv6 XFF entry is unwrapped', () => {
  const ip = clientIp(request({ xff: '1.2.3.4, [2001:db8::1]:41234' }), {
    trustProxy: true,
    trustedProxyHops: 0,
  });

  assert.equal(ip, '2001:db8::1');
});

test('the rate-limit key groups an IPv6 customer by /64, not by address', () => {
  // §6: a residential IPv6 customer has ~18 quintillion addresses, so per-address
  // limits are decorative.
  assert.equal(rateLimitKey('2001:db8:1:2::1'), rateLimitKey('2001:db8:1:2:ffff::9'));
  assert.notEqual(rateLimitKey('2001:db8:1:2::1'), rateLimitKey('2001:db8:1:3::1'));
});
