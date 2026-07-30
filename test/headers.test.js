import { test } from 'node:test';
import assert from 'node:assert/strict';

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
