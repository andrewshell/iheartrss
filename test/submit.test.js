import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db/index.js';
import { rejectionMessage } from '../src/views/messages.js';

const CONFIG = Object.freeze({
  port: 3000,
  siteUrl: 'https://iheartrss.com/',
  linkbackHosts: ['iheartrss.com', 'www.iheartrss.com'],
  maxListingsPerDomain: 5,
  maxNewListingsPerDay: 50,
  submitBudgetMs: 5000,
  trustProxy: false,
  trustedProxyHops: 0,
  adminToken: null,
});

/** An app on an in-memory database with a stubbed verifier (plan §11). */
function appWith({ verify, config = {} } = {}) {
  const { db, queries } = createDb(':memory:');
  const app = createApp({
    config: { ...CONFIG, ...config },
    db,
    queries,
    verifySite: verify ?? (async () => ({ ok: false, reason: 'no_linkback' })),
    ipHmacKey: Buffer.alloc(32, 7),
  });
  return { app, db, queries };
}

/** A same-origin POST, as a browser on our own page would send it. */
function post(app, path, body, headers = {}) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: new URLSearchParams(body).toString(),
  });
}

test('GET /submit renders a form built for a phone', async () => {
  const { app } = appWith();
  const res = await app.request('/submit');

  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /<form[^>]+method="post"[^>]*>/i);
  assert.match(html, /action="\/submit"/);

  // §6.3, "Forms": all four of these, and a ≥16px font so iOS Safari doesn't zoom
  // on focus. A real <label>, not a placeholder.
  assert.match(html, /inputmode="url"/);
  assert.match(html, /autocomplete="url"/);
  assert.match(html, /autocapitalize="off"/);
  assert.match(html, /spellcheck="false"/);
  assert.match(html, /<label[^>]+for="url"/);
});

test('the homepage points at /submit rather than embedding the form', async () => {
  // §10: the form and the three "how to join" steps that end in it now live
  // together on /submit. The homepage used to embed the form and explain the steps
  // above it, which put the explanation on one page and the field on another — and
  // pushed the feed reader below the fold.
  const { app } = appWith();
  const home = await (await app.request('/')).text();

  assert.doesNotMatch(home, /<form[^>]*action="\/submit"/);
  assert.doesNotMatch(home, /How to join/i);
  assert.match(home, /href="\/submit"/);
});

test('the how-to-join steps and the form are together on /submit', async () => {
  const { app } = appWith();
  const html = await (await app.request('/submit')).text();

  assert.match(html, /<form[^>]*action="\/submit"/);
  assert.match(html, /Put the badge on your homepage/);
  assert.match(html, /Make sure your feed is discoverable/);
  // The badge preview is a same-origin path, not an absolute SITE_URL — otherwise
  // it 404s in dev and makes a pointless external request in production.
  assert.match(html, /<img src="\/iheartrss\.svg"/);
});

const PASS = Object.freeze({
  ok: true,
  url: 'https://alice.example/',
  submittedUrl: 'https://alice.example/blog',
  feedUrl: 'https://alice.example/rss.xml',
  title: 'Alice writes things',
  description: 'A blog',
  features: { has_source_ns: true, has_rsscloud: false, rsscloud_style: null },
});

test('a successful POST /submit lists the site and shows both published URLs', async () => {
  const { app, db } = appWith({ verify: async () => PASS });

  const res = await post(app, '/submit', { url: 'alice.example/blog' });

  assert.equal(res.status, 200);
  const html = await res.text();

  // §6: "re-renders with a detailed result panel" naming the chosen xmlUrl and
  // htmlUrl, plus the "wrong feed?" note — autodiscovery picking the first <link> on
  // a page with several is a real outcome, and the member is the only one who knows.
  assert.match(html, /alice\.example\/rss\.xml/);
  assert.match(html, /alice\.example\//);
  assert.match(html, /xmlUrl/);
  assert.match(html, /htmlUrl/);
  assert.match(html, /wrong feed/i);

  const row = db.prepare('SELECT * FROM sites').get();
  assert.equal(row.url, 'https://alice.example/');
  assert.equal(row.submitted_url, 'https://alice.example/blog');
  assert.equal(row.has_source_ns, 1);
});

test('every attempt is logged with a hashed IP and never a raw one', async () => {
  const { app, db } = appWith({ verify: async () => PASS });

  await post(
    app,
    '/submit',
    { url: 'alice.example/blog' },
    { 'x-forwarded-for': '203.0.113.9' },
  );

  const row = db.prepare('SELECT * FROM submissions').get();
  assert.equal(row.submitted_url, 'alice.example/blog');
  assert.equal(row.normalized_url, 'https://alice.example/');
  assert.equal(row.result, 'added');

  // §4: HMAC-SHA256 over a truncated IP plus a date. Never the raw address, and not
  // a bare digest of one either.
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(row.ip_hash, /203|113/);
});

test('a rejected submission writes NOTHING to the site row', async () => {
  const { app, db, queries } = appWith({
    verify: async () => ({
      ok: false,
      reason: 'no_linkback',
      url: 'https://alice.example/',
    }),
  });

  // A listed, healthy member.
  queries.insertSite({
    url: 'https://alice.example/',
    submitted_url: 'https://alice.example/',
    host: 'alice.example',
    path: '/',
    feed_url: 'https://alice.example/rss.xml',
    title: 'Alice',
    description: undefined,
    has_source_ns: false,
    has_rsscloud: false,
    rsscloud_style: undefined,
    cloud_json: undefined,
  });
  const before = db.prepare('SELECT * FROM sites').get();

  const res = await post(app, '/submit', { url: 'https://alice.example/' });
  assert.equal(res.status, 422);

  // §6: "A rejected submission writes nothing — no optout_seen_at, no
  // last_checked_at, no failure_count — or an attacker gets around /recheck's
  // pass-only rule by using /submit instead." Anyone can POST here.
  const after = db.prepare('SELECT * FROM sites').get();
  assert.deepEqual({ ...after }, { ...before });

  // The attempt itself is still logged — that's the half that has to be recorded.
  const attempt = db.prepare('SELECT result, reason FROM submissions').get();
  assert.equal(attempt.result, 'rejected');
  assert.equal(attempt.reason, 'no_linkback');
});

test('a rejection links to the guide and names both URLs where they differ', async () => {
  const { app } = appWith({
    verify: async () => ({
      ok: false,
      reason: 'feed_not_declared_on_canonical',
      url: 'https://alice.example/',
      submittedUrl: 'https://alice.example/blog',
    }),
  });

  const html = await (await post(app, '/submit', { url: 'alice.example/blog' })).text();

  // §6/§12: /guide ships with the rejections that link to it, not after them.
  assert.match(html, /href="\/guide/);
  assert.match(html, /alice\.example\//);
});

test('the feed_not_rss2 message is a pitch, not a validator complaint', async () => {
  const { app } = appWith({
    verify: async () => ({
      ok: false,
      reason: 'feed_not_rss2',
      url: 'https://alice.example/',
      otherFormatUrl: 'https://alice.example/atom.xml',
      otherFormatType: 'atom',
    }),
  });

  const html = await (await post(app, '/submit', { url: 'alice.example' })).text();

  // §5 Step 2: "Naming the exact feed we found is what turns the most common
  // rejection on the site from 'this site is broken' into an invitation."
  assert.match(html, /alice\.example\/atom\.xml/);
  assert.match(html, /Atom feed/);
  assert.match(html, /href="\/guide/);

  // §1: RSS-2.0-only is our constraint, so the prose owns it rather than blaming the
  // member's perfectly valid feed. Checked on the visible text, since the markup
  // itself carries a `panel--error` class.
  const text = html.replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(text, /\b(invalid|malformed|unsupported|error)\b/i);
  assert.match(text, /we&rsquo;re the narrow ones|we're the narrow ones/);
});

test('a cross-origin POST is refused on all four public write routes', async () => {
  let verifications = 0;
  const { app, db } = appWith({
    verify: async () => {
      verifications += 1;
      return PASS;
    },
  });

  // §6: switching /check from GET to POST closed the <img src> amplifier but NOT the
  // amplifier — a cross-origin auto-submitting form with
  // enctype="application/x-www-form-urlencoded" needs no preflight and no JS consent,
  // so any attacker page still drives our server at a victim URL, each visitor
  // funding a fresh rate budget.
  for (const [path, body] of [
    ['/submit', { url: 'alice.example' }],
    ['/check', { url: 'alice.example' }],
    ['/report', { url: 'https://alice.example/', reason: 'spam' }],
  ]) {
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'https://attacker.example' },
      {},
    ]) {
      const res = await post(app, path, body, { 'sec-fetch-site': '', ...headers });
      assert.equal(res.status, 403, `${path} ${JSON.stringify(headers)}`);
    }
  }

  assert.equal(verifications, 0, 'no outbound verification may be spent');
  assert.equal(db.prepare('SELECT count(*) AS n FROM submissions').get().n, 0);
});

test('an Origin matching SITE_URL is accepted, for clients without Sec-Fetch-Site', async () => {
  const { app } = appWith({ verify: async () => PASS });

  const res = await post(
    app,
    '/submit',
    { url: 'alice.example' },
    { 'sec-fetch-site': '', origin: 'https://iheartrss.com' },
  );

  assert.equal(res.status, 200);
});

test('rate limiting refuses the 6th submission and spends no fetch', async () => {
  let verifications = 0;
  const { app } = appWith({
    verify: async () => {
      verifications += 1;
      return { ok: false, reason: 'no_linkback', url: 'https://alice.example/' };
    },
  });

  for (let i = 0; i < 5; i += 1) {
    await post(app, '/submit', { url: 'alice.example' });
  }

  const res = await post(app, '/submit', { url: 'alice.example' });

  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal(verifications, 5, 'the limiter must gate BEFORE the fetch');
  assert.match(await res.text(), /Give it a minute/);
});

test('the rate limit is shared between /submit and /check', async () => {
  const { app } = appWith({ verify: async () => PASS });

  for (let i = 0; i < 3; i += 1) await post(app, '/submit', { url: 'alice.example' });
  for (let i = 0; i < 2; i += 1) await post(app, '/check', { url: 'alice.example' });

  // §6: "shared across /submit, /check and /recheck". Per-route buckets would hand
  // out three times the outbound budget.
  assert.equal((await post(app, '/check', { url: 'alice.example' })).status, 429);
});

test('POST /check runs the same pipeline and stores no listing', async () => {
  const { app, db } = appWith({ verify: async () => PASS });

  const res = await post(app, '/check', { url: 'alice.example/blog' });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');

  const html = await res.text();
  assert.match(html, /alice\.example\/rss\.xml/);
  assert.match(html, /Nothing was listed/i);

  // "same pipeline, discards the result" (§6).
  assert.equal(db.prepare('SELECT count(*) AS n FROM sites').get().n, 0);

  // The attempt is still logged, because /check is the amplifier route.
  assert.equal(db.prepare('SELECT result FROM submissions').get().result, 'checked');
});

test('/check is not reachable as a GET', async () => {
  const { app } = appWith();

  // §6: "As a GET with a ?url= parameter it was an unauthenticated request
  // amplifier: <img src="…/check?url=victim"> turns every visitor to any page into an
  // attack packet from our IP, and prefetchers and crawlers fire it too."
  const res = await app.request('/check?url=https://victim.example/');
  assert.equal(res.status, 404);
});

test('concurrent verifications are capped by the global semaphore', async () => {
  let running = 0;
  let peak = 0;
  const { app } = appWith({
    verify: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { ok: false, reason: 'no_linkback', url: 'https://alice.example/' };
    },
  });

  // Five requests from five different addresses, so the rate limiter lets them all
  // through and only the semaphore is under test (§6: "so no combination of
  // endpoints can fan out against a third party").
  await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      post(
        app,
        '/submit',
        { url: 'alice.example' },
        { 'x-forwarded-for': `203.0.113.${n}` },
      ),
    ),
  );

  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

// ── GET /status (§6) ─────────────────────────────────────────────────────────
// With no accounts and no email this is the ONLY way a member can find out why they
// vanished, and /sites deliberately omits dropped/removed/hidden.

async function listed(app) {
  await post(app, '/submit', { url: 'alice.example/blog' });
}

test('/status finds a site by the URL its owner actually submitted', async () => {
  const { app } = appWith({ verify: async () => PASS });
  await listed(app);

  // §6: "Matches on normalized `url` OR `submitted_url` — sites.url is the canonical
  // URL, but a member will type what they submitted, which is often a different page."
  const res = await app.request('/status?url=https://alice.example/blog');

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');

  const html = await res.text();
  assert.match(html, /Alice writes things/);
  assert.match(html, /alice\.example\/rss\.xml/);
  assert.match(html, /Listed and healthy/);
});

test('/status finds the same site by its canonical URL', async () => {
  const { app } = appWith({ verify: async () => PASS });
  await listed(app);

  const html = await (await app.request('/status?url=alice.example')).text();
  assert.match(html, /Alice writes things/);
});

test('/status reports a hidden site as a NEUTRAL not-listed', async () => {
  const { app, queries } = appWith({ verify: async () => PASS });
  await listed(app);
  queries.hideSite(queries.getSiteByUrl('https://alice.example/').id, 'spam');

  const html = await (await app.request('/status?url=alice.example')).text();

  // §6: never "moderated" — "otherwise it hands back exactly the oracle that /submit
  // and /recheck contort themselves to avoid."
  assert.match(html, /Not listed/);
  const text = html.replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(text, /hidden|moderat|banned|removed by/i);
  assert.doesNotMatch(html, /Alice writes things/);
});

test('/status on an unknown URL says so without erroring', async () => {
  const { app } = appWith();

  const res = await app.request('/status?url=nobody.example');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Not listed/);
});

test('/status with a junk URL is a 400, not a 500', async () => {
  const { app } = appWith();

  const res = await app.request(
    '/status?url=' + encodeURIComponent('javascript:alert(1)'),
  );
  assert.equal(res.status, 400);
});

test('POST /report files a report against the listing it names', async () => {
  const { app, db } = appWith({ verify: async () => PASS });
  await post(app, '/submit', { url: 'alice.example/blog' });

  const res = await post(app, '/report', {
    url: 'https://alice.example/blog',
    reason: 'This site is now serving malware',
    contact: 'me@example.org',
  });

  assert.equal(res.status, 200);
  assert.match(await res.text(), /Thank you/);

  const row = db.prepare('SELECT * FROM reports').get();
  assert.equal(row.reason, 'This site is now serving malware');
  assert.equal(row.contact, 'me@example.org');
  // §4: linked to the site row so /admin can show it in context, and with the same
  // ip_hash construction as submissions.
  assert.equal(row.site_id, db.prepare('SELECT id FROM sites').get().id);
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
});

test('a report about a site we do not have is still recorded', async () => {
  const { app, db } = appWith();

  await post(app, '/report', { url: 'https://nobody.example/', reason: 'spam' });

  const row = db.prepare('SELECT * FROM reports').get();
  assert.equal(row.site_id, null);
  assert.equal(row.url, 'https://nobody.example/');
});

test('every reason code the pipeline can produce has its own message', async () => {
  // A reason with no entry falls through to "something went wrong on our end",
  // which tells a member with a fixable problem that it isn't theirs to fix. This
  // list is every code `src/verify/` and `src/verify/persist.js` can return.
  const reasons = [
    'invalid_url',
    'unsupported_scheme',
    'banned',
    'self_listing',
    'page_fetch_failed',
    'ssrf_blocked',
    'timeout',
    'too_many_redirects',
    'page_too_large',
    'feed_too_large',
    'blocked_by_site',
    'no_feed_link',
    'feed_not_rss2',
    'feed_fetch_failed',
    'feed_invalid',
    'no_channel_link',
    'canonical_fetch_failed',
    'canonical_feed_unavailable',
    'feed_not_declared_on_canonical',
    'feed_not_owned_by_canonical',
    'no_linkback',
    'ambiguous_identity',
    'domain_cap',
    'daily_cap',
  ];

  const generic = rejectionMessage({
    result: { reason: 'something_we_never_emit' },
    config: CONFIG,
  }).heading;

  const headings = new Set();
  for (const reason of reasons) {
    const { heading } = rejectionMessage({
      result: {
        reason,
        url: 'https://alice.example/',
        feedUrl: 'https://alice.example/rss.xml',
      },
      config: CONFIG,
    });

    assert.notEqual(heading, generic, `${reason} has no message of its own`);
    headings.add(heading);
  }

  // Distinct headings, because §5's whole reason for machine-readable codes is that
  // "the UI can show a specific, actionable message".
  assert.equal(headings.size, reasons.length);
});

test('every themed wordmark offers the dark variant, on every page that shows one', async () => {
  // §6.1: iheartrss.svg is a near-black wordmark and iheartrss-dark.svg a white one.
  // On a dark background the light file is black-on-dark and effectively unreadable,
  // which is the entire reason two files exist.
  //
  // This drifted once already: the header carried the <picture> and /submit's step-1
  // badge preview did not, so it rendered black-on-grey in dark mode. Both now come
  // from one shared helper, and this walks every page that renders a wordmark.
  const { app } = appWith();

  for (const path of ['/', '/submit', '/about', '/blog', '/sites', '/guide']) {
    const html = await (await app.request(path)).text();

    const bareImgs = html.match(/<img[^>]+iheartrss\.svg[^>]*>/g) ?? [];
    const darkSources = html.match(/srcset="\/iheartrss-dark\.svg"/g) ?? [];

    // Every light-wordmark <img> must be paired with a dark <source>. /badge is
    // excluded from this loop on purpose — it shows both files side by side on fixed
    // preview panels, where following the theme would defeat the point.
    assert.equal(
      bareImgs.length,
      darkSources.length,
      `${path}: ${bareImgs.length} light wordmark(s) but ${darkSources.length} dark source(s)`,
    );
  }
});
