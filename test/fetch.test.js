import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createFetcher, createGuardedLookup } from '../src/verify/fetch.js';
import { isAllowedAddress } from '../src/verify/url.js';

// Plan §5 Step 1 and §11's `fetch.test.js`.
//
// The fixture server binds 127.0.0.1, which the production classifier refuses —
// correctly, since that is the SSRF case. Rather than weaken the classifier, the
// reachable-fixture tests inject one that additionally allows 127.0.0.1, and every
// test that is *about* the guard uses the production classifier untouched.

const CONFIG = {
  fetchTimeoutMs: 2000,
  maxResponseBytes: 5 * 1024 * 1024,
  submitBudgetMs: 5000,
};

/** Every hostname resolves to the fixture server, in the `all: true` shape. */
function loopbackLookup(hostname, options, cb) {
  if (options?.all) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
  return cb(null, '127.0.0.1', 4);
}

function reachableFetcher(overrides = {}) {
  return createFetcher({
    lookup: loopbackLookup,
    config: { ...CONFIG, ...overrides },
    // Test-only: 127.0.0.1 is where the fixture server lives.
    isAddressAllowed: (address) => address === '127.0.0.1' || isAllowedAddress(address),
  });
}

async function withFixture(handler, run) {
  const state = { hits: [] };
  const server = createServer((req, res) => {
    state.hits.push(req.url);
    handler(req, res, state);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  state.origin = `http://fixture.test:${state.port}`;

  try {
    return await run(state);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('safeFetch returns the decoded body of a 200 response', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>hello</body></html>');
    },
    async ({ origin }) => {
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`${origin}/blog`);

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.status, 200);
      assert.equal(result.url, `${origin}/blog`);
      assert.equal(result.body, '<html><body>hello</body></html>');
      assert.equal(result.contentType, 'text/html; charset=utf-8');
    },
  );
});

test('guardedLookup answers in the shape the caller asked for (§5 Step 1)', async () => {
  const guardedLookup = createGuardedLookup({
    lookup: (hostname, options, cb) =>
      cb(null, [{ address: '93.184.216.34', family: 4 }]),
  });

  // undici's autoSelectFamily path calls the hook as `{ hints: 1024, all: true }`.
  // Answering in the single-address shape there throws
  // `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` for every hostname.
  const all = await new Promise((resolve, reject) =>
    guardedLookup('example.com', { hints: 1024, all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    ),
  );
  assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);

  const single = await new Promise((resolve, reject) =>
    guardedLookup('example.com', {}, (err, address, family) =>
      err ? reject(err) : resolve([address, family]),
    ),
  );
  assert.deepEqual(single, ['93.184.216.34', 4]);
});

test('guardedLookup rejects a private answer with a tagged Error, not an empty array', async () => {
  const guardedLookup = createGuardedLookup({
    lookup: (hostname, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
  });

  for (const options of [{ hints: 1024, all: true }, {}]) {
    const err = await new Promise((resolve) =>
      guardedLookup('rebind.test', options, (e) => resolve(e)),
    );

    // `cb(null, [])` under `all: true` surfaces as an opaque destructuring
    // TypeError instead of a reason code, so the rejection must be an Error.
    assert.ok(err instanceof Error, `expected an Error for all=${!!options.all}`);
    assert.equal(err.code, 'SSRF_BLOCKED');
  }
});

test('guardedLookup keeps only the public answers from a mixed answer set', async () => {
  const guardedLookup = createGuardedLookup({
    lookup: (hostname, options, cb) =>
      cb(null, [
        { address: '169.254.169.254', family: 4 },
        { address: '93.184.216.34', family: 4 },
        { address: '::1', family: 6 },
      ]),
  });

  const addresses = await new Promise((resolve, reject) =>
    guardedLookup('mixed.test', { all: true }, (err, answer) =>
      err ? reject(err) : resolve(answer),
    ),
  );

  assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
});

test('safeFetch refuses a hostname that resolves to a private address', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('SECRET');
    },
    async ({ origin, hits }) => {
      // Production classifier: the fixture server is exactly the target we must
      // not reach, and it is listening, so a pass would be visible as a hit.
      const safeFetch = createFetcher({ lookup: loopbackLookup, config: CONFIG });
      const result = await safeFetch(`${origin}/`);

      assert.deepEqual(result, { ok: false, reason: 'ssrf_blocked' });
      assert.deepEqual(hits, []);
    },
  );
});

test('safeFetch refuses IP literals in every spelling, which the lookup hook never sees', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('SECRET');
    },
    async ({ port, hits }) => {
      let lookupCalls = 0;
      const safeFetch = createFetcher({
        lookup: (hostname, options, cb) => {
          lookupCalls += 1;
          loopbackLookup(hostname, options, cb);
        },
        config: CONFIG,
      });

      // `net.connect` skips the lookup hook entirely for an IP literal — measured
      // at 200 with 0 lookup calls — so half 1 cannot see any of these.
      const targets = [
        `http://127.0.0.1:${port}/`,
        `http://[::1]:${port}/`,
        `http://[::ffff:7f00:1]:${port}/`, // what URL gives for [::ffff:127.0.0.1]
        `http://2130706433:${port}/`, // decimal 127.0.0.1
        `http://0x7f.0.0.1:${port}/`, // hex
        `http://127.1:${port}/`, // short form
        `http://0:${port}/`,
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/',
        'http://192.168.1.1/',
      ];

      for (const target of targets) {
        assert.deepEqual(
          await safeFetch(target),
          { ok: false, reason: 'ssrf_blocked' },
          target,
        );
      }

      assert.deepEqual(hits, [], 'the fixture server must never be reached');
      assert.equal(lookupCalls, 0, 'IP literals resolve nothing to guard');
    },
  );
});

test('safeFetch is not fooled by DNS rebinding: the validated address is the connected address', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('SECRET');
    },
    async ({ port, hits }) => {
      const answers = [
        // Call 1 — a public answer, so any pre-check passes. TEST-NET-1 is
        // classified as global unicast but is guaranteed never routed, so the
        // connection attempt leaves no real host on the receiving end.
        '192.0.2.1',
        // Call 2 onwards — the attacker's real target, listening right here.
        '127.0.0.1',
        '127.0.0.1',
        '127.0.0.1',
      ];
      let lookupCalls = 0;

      const safeFetch = createFetcher({
        lookup: (hostname, options, cb) => {
          const address = answers[Math.min(lookupCalls, answers.length - 1)];
          lookupCalls += 1;
          if (options?.all) return cb(null, [{ address, family: 4 }]);
          return cb(null, address, 4);
        },
        config: { ...CONFIG, fetchTimeoutMs: 400 },
      });

      const result = await safeFetch(`http://rebind.test:${port}/`);

      // A resolve-then-check-then-fetch implementation validates answer 1 and
      // connects on answer 2 — and this fixture would have served SECRET.
      assert.deepEqual(hits, [], 'the rebound target must never be reached');
      assert.equal(result.ok, false);
      assert.equal(
        lookupCalls,
        1,
        'one resolution, used for both the decision and the socket',
      );
    },
  );
});

test('safeFetch times out at the per-request cap', async () => {
  await withFixture(
    () => {
      /* never responds */
    },
    async ({ origin }) => {
      const safeFetch = reachableFetcher({ fetchTimeoutMs: 200 });
      const started = Date.now();
      const result = await safeFetch(`${origin}/slow`);

      assert.deepEqual(result, { ok: false, reason: 'timeout' });
      assert.ok(Date.now() - started < 2000, 'should not wait out the whole test');
    },
  );
});

test('safeFetch stops at the remaining submission budget even when the per-request cap is generous', async () => {
  await withFixture(
    () => {
      /* never responds */
    },
    async ({ origin }) => {
      // §5's budget: SUBMIT_BUDGET_MS is the only real ceiling, and the effective
      // per-request timeout is min(FETCH_TIMEOUT_MS, budget remaining).
      const safeFetch = reachableFetcher({ fetchTimeoutMs: 60_000 });
      const started = Date.now();
      const result = await safeFetch(`${origin}/slow`, {
        budget: { deadline: Date.now() + 200 },
      });

      assert.deepEqual(result, { ok: false, reason: 'timeout' });
      assert.ok(Date.now() - started < 2000, 'the budget, not the cap, must win');
    },
  );
});

test('safeFetch reports an already-exhausted budget without dispatching', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('ok');
    },
    async ({ origin, hits }) => {
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`${origin}/`, {
        budget: { deadline: Date.now() - 1 },
      });

      assert.deepEqual(result, { ok: false, reason: 'timeout' });
      assert.deepEqual(hits, []);
    },
  );
});

test('safeFetch follows redirects manually and reports the final URL', async () => {
  await withFixture(
    (req, res) => {
      if (req.url === '/a') {
        res.writeHead(302, { location: '/b' }); // relative Location
        return res.end();
      }
      if (req.url === '/b') {
        res.writeHead(301, { location: `http://fixture.test:${res.socket.localPort}/c` });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>final</html>');
    },
    async ({ origin, hits }) => {
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`${origin}/a`);

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.status, 200);
      // Step 2 parses the *final* URL and Step 4 compares origins against it.
      assert.equal(result.url, `${origin}/c`);
      // ...but the canonical spelling froze at the temporary hop: `/a` was answered
      // with a 302, so `/a` is still the URL to keep, whatever came after it.
      assert.equal(result.permanentUrl, `${origin}/a`);
      assert.equal(result.body, '<html>final</html>');
      assert.deepEqual(hits, ['/a', '/b', '/c']);
    },
  );
});

test('permanentUrl advances through 301 and 308 hops', async () => {
  await withFixture(
    (req, res) => {
      if (req.url === '/feed') {
        res.writeHead(301, { location: '/feed/' });
        return res.end();
      }
      if (req.url === '/feed/') {
        res.writeHead(308, { location: '/feed/index.xml' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end('<rss/>');
    },
    async ({ origin, hits }) => {
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`${origin}/feed`, { kind: 'feed' });

      assert.equal(result.ok, true, JSON.stringify(result));
      // Every hop said "use that one forever", so the last one is the canonical URL.
      assert.equal(result.permanentUrl, `${origin}/feed/index.xml`);
      assert.equal(result.url, result.permanentUrl);
      assert.deepEqual(hits, ['/feed', '/feed/', '/feed/index.xml']);
    },
  );
});

test('permanentUrl stops at the first temporary hop, even if a 301 follows', async () => {
  await withFixture(
    (req, res) => {
      if (req.url === '/feed') {
        res.writeHead(307, { location: '/mirror' });
        return res.end();
      }
      if (req.url === '/mirror') {
        res.writeHead(301, { location: '/mirror/' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end('<rss/>');
    },
    async ({ origin }) => {
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`${origin}/feed`, { kind: 'feed' });

      assert.equal(result.ok, true, JSON.stringify(result));
      // The 301 is `/mirror`'s statement about `/mirror`, not about `/feed` — and
      // `/feed` was told it is still the right URL. Following the chain past a
      // temporary hop would move a member's stored feed URL onto a mirror.
      assert.equal(result.permanentUrl, `${origin}/feed`);
      assert.equal(result.url, `${origin}/mirror/`);
    },
  );
});

test('permanentUrl equals the URL asked for when nothing redirects', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>hi</html>');
    },
    async ({ origin }) => {
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`${origin}/blog`);

      assert.equal(result.permanentUrl, `${origin}/blog`);
    },
  );
});

test('safeFetch refuses a redirect into a private address', async () => {
  await withFixture(
    (req, res) => {
      if (req.url === '/redirect') {
        // The classic: a public page bounces us at the cloud metadata endpoint.
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('SECRET');
    },
    async ({ origin, hits }) => {
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`${origin}/redirect`);

      assert.deepEqual(result, { ok: false, reason: 'ssrf_blocked' });
      assert.deepEqual(hits, ['/redirect']);
    },
  );
});

test('safeFetch refuses a redirect to a non-http scheme', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    },
    async ({ origin }) => {
      const safeFetch = reachableFetcher();

      assert.deepEqual(await safeFetch(`${origin}/x`), {
        ok: false,
        reason: 'unsupported_scheme',
      });
    },
  );
});

test('safeFetch gives up after 5 redirect hops', async () => {
  await withFixture(
    (req, res) => {
      const n = Number(req.url.slice(1)) + 1;
      res.writeHead(302, { location: `/${n}` });
      res.end();
    },
    async ({ origin, hits }) => {
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`${origin}/0`);

      assert.deepEqual(result, { ok: false, reason: 'too_many_redirects' });
      assert.deepEqual(hits, ['/0', '/1', '/2', '/3', '/4', '/5']);
    },
  );
});

test('safeFetch shares one deadline across redirect hops', async () => {
  await withFixture(
    (req, res) => {
      // Each hop is slow. Per-hop timeouts would let all six through.
      setTimeout(() => {
        const n = Number(req.url.slice(1)) + 1;
        res.writeHead(302, { location: `/${n}` });
        res.end();
      }, 120);
    },
    async ({ origin, hits }) => {
      const safeFetch = reachableFetcher({ fetchTimeoutMs: 250 });
      const result = await safeFetch(`${origin}/0`);

      assert.deepEqual(result, { ok: false, reason: 'timeout' });
      assert.ok(
        hits.length <= 3,
        `expected the chain to be cut short, got ${hits.length}`,
      );
    },
  );
});

test('safeFetch turns an unparseable Location into a reason, not an exception', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(302, { location: 'http://[not-an-address' });
      res.end();
    },
    async ({ origin }) => {
      const safeFetch = reachableFetcher();

      assert.deepEqual(await safeFetch(`${origin}/x`), {
        ok: false,
        reason: 'invalid_url',
      });
    },
  );
});

test('safeFetch treats the size cap as an error, never a truncation', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      // A page with a real link-back, only bigger than the cap.
      res.end(
        `<html>${'x'.repeat(20_000)}<a href="https://iheartrss.com/">us</a></html>`,
      );
    },
    async ({ origin }) => {
      const safeFetch = reachableFetcher({ maxResponseBytes: 1024 });

      // A truncated body parses fine and merely lacks the link-back, which §8
      // reads as a deliberate opt-out — so the reason has to be distinct, and
      // there must be no body for a later step to misread.
      const page = await safeFetch(`${origin}/`);
      assert.deepEqual(page, { ok: false, reason: 'page_too_large' });

      const feed = await safeFetch(`${origin}/feed.xml`, { kind: 'feed' });
      assert.deepEqual(feed, { ok: false, reason: 'feed_too_large' });
    },
  );
});

test('safeFetch accepts a body exactly at the cap', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('y'.repeat(1024));
    },
    async ({ origin }) => {
      const safeFetch = reachableFetcher({ maxResponseBytes: 1024 });
      const result = await safeFetch(`${origin}/`);

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.body.length, 1024);
    },
  );
});

test('safeFetch decodes using the Content-Type charset', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      // 0xE9 is é in Latin-1 and an invalid byte in UTF-8.
      res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]));
    },
    async ({ origin }) => {
      const result = await reachableFetcher()(`${origin}/`);

      assert.equal(result.body, '<p>é</p>');
    },
  );
});

test('safeFetch falls back to a <meta charset> sniff for HTML', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }); // no charset param
      res.end(
        Buffer.concat([
          Buffer.from('<html><head><meta charset="windows-1252"></head><body>'),
          Buffer.from([0x93]), // a left double quote in cp1252, invalid in UTF-8
          Buffer.from('</body></html>'),
        ]),
      );
    },
    async ({ origin }) => {
      const result = await reachableFetcher()(`${origin}/`);

      assert.ok(result.body.includes('“'), JSON.stringify(result.body));
    },
  );
});

test('safeFetch falls back to the XML declaration encoding for feeds', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' }); // no charset param
      res.end(
        Buffer.concat([
          Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><title>'),
          Buffer.from([0xe9]),
          Buffer.from('</title></rss>'),
        ]),
      );
    },
    async ({ origin }) => {
      // Older WordPress and hand-rolled feeds really are Latin-1 and say so only
      // here; decoding as UTF-8 mangles every title we publish.
      const result = await reachableFetcher()(`${origin}/feed.xml`, { kind: 'feed' });

      assert.equal(
        result.body,
        '<?xml version="1.0" encoding="ISO-8859-1"?><rss><title>é</title></rss>',
      );
    },
  );
});

test('safeFetch decodes as UTF-8 when nothing declares a charset', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.from('<p>héllo — ok</p>', 'utf8'));
    },
    async ({ origin }) => {
      const result = await reachableFetcher()(`${origin}/`);

      assert.equal(result.body, '<p>héllo — ok</p>');
    },
  );
});

test('safeFetch retries over http when the https connection fails', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>plain http only</html>');
    },
    async ({ port, hits }) => {
      // Real case: https://scripting.com/ fails with a connection reset while
      // http://scripting.com/ returns 200. Without the fallback the single most
      // likely high-profile member of an RSS webring cannot join.
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`https://fixture.test:${port}/`);

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.url, `http://fixture.test:${port}/`);
      assert.equal(result.body, '<html>plain http only</html>');
      assert.equal(hits.length, 1, 'only the http attempt reaches the server');
    },
  );
});

test('safeFetch does not retry over http on an HTTP error status', async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('boom');
    },
    async ({ origin, hits }) => {
      const safeFetch = reachableFetcher();
      const result = await safeFetch(`${origin}/`);

      assert.equal(result.status, 500);
      assert.equal(hits.length, 1, 'a 5xx is an answer, not a connection failure');
    },
  );
});

test('safeFetch does not retry over http when the guard blocked the request', async () => {
  let lookupCalls = 0;
  const safeFetch = createFetcher({
    lookup: (hostname, options, cb) => {
      lookupCalls += 1;
      loopbackLookup(hostname, options, cb);
    },
    config: CONFIG,
  });

  const result = await safeFetch('https://private.test/');

  // Retrying a blocked host over http would burn budget and, worse, give a second
  // roll of the dice to a rebinding attacker.
  assert.deepEqual(result, { ok: false, reason: 'ssrf_blocked' });
  assert.equal(lookupCalls, 1);
});

test('safeFetch identifies itself with the §5 headers', async () => {
  let seen;
  await withFixture(
    (req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('ok');
    },
    async ({ origin }) => {
      await reachableFetcher()(`${origin}/`);
    },
  );

  // A bare UA with no Accept headers is the easiest bot signature to fingerprint,
  // and the UA has to name a page that exists so sysadmins can look us up.
  assert.equal(
    seen['user-agent'],
    'iheartrss.com validator (+https://iheartrss.com/about)',
  );
  assert.ok(seen.accept.includes('text/html'));
  assert.ok(seen['accept-language']);
});

test('createFetcher refuses to build without an injected lookup', () => {
  // §11: the injectable lookup is what makes the DNS-rebinding test writable at
  // all, so it is a hard requirement rather than an optional override.
  assert.throws(() => createFetcher({ config: CONFIG }), /lookup/);
});
