import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createApp } from '../src/app.js';

/**
 * Plan §6: "Security headers on every response: `X-Content-Type-Options:
 * nosniff`, a restrictive `Content-Security-Policy` (there's essentially no
 * inline JS), `Referrer-Policy: strict-origin-when-cross-origin`, and
 * `Cross-Origin-Resource-Policy: cross-origin` on the three SVGs, where
 * hotlinking is the point."
 *
 * "On every response" is the part worth a test: headers added per-route drift, and
 * the route that gets missed is always the one added last.
 */

const config = {
  port: 3000,
  siteUrl: 'https://iheartrss.com',
  linkbackHosts: ['iheartrss.com', 'www.iheartrss.com'],
};

// One of each kind of response the app can produce: HTML, JSON, XML, plain text,
// a 301, a 404, and a streamed file from public/.
const EVERY_KIND = [
  '/',
  '/about',
  '/badge',
  '/guide',
  '/sites',
  '/submit',
  '/blog',
  '/healthz',
  '/subscriptions.opml',
  '/feed.xml',
  '/sitemap.xml',
  '/robots.txt',
  '/opml',
  '/rss.xml',
  '/style.css',
  '/iheartrss.svg',
  '/no-such-page',
];

test('every response carries the four §6 security headers', async () => {
  const app = createApp({ config });

  for (const path of EVERY_KIND) {
    const res = await app.request(path);

    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(
      res.headers.get('referrer-policy'),
      'strict-origin-when-cross-origin',
      path,
    );

    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, `${path} has no Content-Security-Policy`);

    // Restrictive means restrictive: there is no inline JS anywhere in the app,
    // so nothing needs 'unsafe-inline' or 'unsafe-eval', and a policy that
    // allows them is not the one §6 asked for.
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/, path);
    // §10's feed reader moved this from 'none' to 'self': the app now serves one
    // script, `/blog-roll.js`, and it is ours on our origin. The property that
    // matters — an *injected* inline script still cannot run — is unchanged, which
    // is what the 'unsafe-inline' assertion above is guarding.
    assert.match(csp, /(?:^|;\s*)script-src 'self'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /base-uri 'none'/, path);
    // Every page links /site.webmanifest, and manifests do not fall back to
    // img-src or anything else — omit this and `default-src 'none'` blocks the
    // manifest on every page load, which is how the omission was found.
    assert.match(csp, /(?:^|;\s*)manifest-src 'self'/, path);
  }
});

test('the three badge SVGs are cross-origin embeddable, and nothing else is', async () => {
  const app = createApp({ config });

  // §6/§6.1: hotlinking these from other people's sites is the point, so they
  // need CORP: cross-origin. A blanket same-origin default elsewhere is what
  // makes that line meaningful.
  for (const path of ['/iheartrss.svg', '/iheartrss-dark.svg', '/iheartrss-icon.svg']) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin', path);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', path);
  }

  for (const path of ['/', '/style.css', '/subscriptions.opml']) {
    const res = await app.request(path);
    assert.equal(
      res.headers.get('cross-origin-resource-policy'),
      'same-origin',
      `${path} should not be embeddable cross-origin`,
    );
  }
});

// ── The cache-busting contract ──────────────────────────────────────────────────
//
// One bug, two halves, and each is useless alone: the asset URL has to change when
// the file does, and the HTML that carries the new URL has to actually be fetched.

test('every page links a versioned stylesheet, and the digest is the file’s', async () => {
  const app = createApp({ config });

  const home = await (await app.request('/')).text();
  const [, version] = home.match(
    /<link rel="stylesheet" href="\/style\.css\?v=([0-9a-f]+)">/,
  );

  // The same file behind every page, so the same version on every page — a per-render
  // or per-boot token would be a fresh download of the same bytes for every visitor.
  for (const path of ['/about', '/sites', '/submit', '/badge', '/guide', '/blog']) {
    const html = await (await app.request(path)).text();
    assert.match(html, new RegExp(`href="/style\\.css\\?v=${version}"`), path);
  }

  // It is a digest of the bytes, not a release number: a deploy that changes nothing
  // about the stylesheet must not throw away every visitor's cached copy.
  const bytes = await readFile(new URL('../public/style.css', import.meta.url));
  const expected = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  assert.equal(version, expected);
});

test('a versioned asset is immutable for a year; a bare one keeps the week', async () => {
  const app = createApp({ config });

  // The payoff: the URL changes when the file does, which is exactly the promise
  // `immutable` asks a client to rely on.
  const versioned = await app.request('/style.css?v=deadbeef');
  assert.equal(versioned.status, 200);
  assert.equal(
    versioned.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );

  // A bare URL can still be asked for — old HTML, a bookmark, curl — and it has no
  // such promise behind it, so it keeps the conservative answer.
  const bare = await app.request('/style.css');
  assert.equal(bare.headers.get('cache-control'), 'public, max-age=604800');
});

test('HTML is revalidated, so a deploy’s new asset URLs are actually seen', async () => {
  const app = createApp({ config });

  // Without this the whole scheme leaks: a cached HTML page carries the OLD
  // /style.css?v=… inside it, and the visitor keeps both.
  for (const path of ['/', '/about', '/sites', '/blog', '/no-such-page']) {
    const res = await app.request(path);
    assert.equal(res.headers.get('cache-control'), 'no-cache', path);
  }

  // Only HTML, and only where the route has not already spoken. The OPML's own
  // validators (§7) and the static route's max-age must survive untouched.
  const opml = await app.request('/subscriptions.opml');
  assert.equal(opml.headers.get('cache-control'), null);
  assert.ok(opml.headers.get('etag'), 'the OPML still answers with its own validator');
  assert.match(
    (await app.request('/iheartrss.svg')).headers.get('cache-control') ?? '',
    /max-age=31536000/,
  );
});
