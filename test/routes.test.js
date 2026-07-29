import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';

const config = {
  port: 3000,
  siteUrl: 'https://iheartrss.com',
  linkbackHosts: ['iheartrss.com', 'www.iheartrss.com'],
};

test('GET /healthz reports ok', async () => {
  const app = createApp({ config });
  const res = await app.request('/healthz');

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('GET / renders HTML carrying the badge wordmark', async () => {
  const app = createApp({ config });
  const res = await app.request('/');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);

  const html = await res.text();
  assert.match(html, /\/iheartrss\.svg/);
});

test('GET /about states the privacy position on IP addresses', async () => {
  const app = createApp({ config });
  const res = await app.request('/about');

  assert.equal(res.status, 200);
  const html = await res.text();

  // Plan §6, "What /about has to say": never raw IPs, and submission records
  // are deleted after 90 days.
  assert.match(html, /never store raw IP addresses/i);
  assert.match(html, /90 days/);
});

test('GET /about explains what we fetch and how to be removed', async () => {
  const app = createApp({ config });
  const res = await app.request('/about');
  const html = await res.text();

  // Plan §6: the page a stranger lands on after finding us in their logs has to
  // answer "what did you fetch", "how often", and "how do I make it stop".
  assert.match(html, /User-Agent/i);
  assert.match(html, /six days/i);
  assert.match(html, /How to be removed/i);
  assert.match(html, /within a week/i);
});

test('GET /feed.xml is an RSS 2.0 document declaring the source namespace', async () => {
  const app = createApp({ config });
  const res = await app.request('/feed.xml');

  assert.equal(res.status, 200);
  assert.match(
    res.headers.get('content-type') ?? '',
    /application\/rss\+xml;\s*charset=utf-8/,
  );

  const xml = await res.text();
  assert.match(xml, /<rss[^>]*\sversion="2\.0"/);
  assert.match(xml, /xmlns:source="https:\/\/source\.scripting\.com\/"/);
  assert.match(xml, /<channel>/);
  assert.match(xml, /<source:self>https:\/\/iheartrss\.com\/feed\.xml<\/source:self>/);
});

test('GET /robots.txt disallows the private routes', async () => {
  const app = createApp({ config });
  const res = await app.request('/robots.txt');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);

  const txt = await res.text();
  // Plan §6: disallow /admin, /check, /recheck, /status.
  assert.match(txt, /^Disallow: \/admin$/m);
  assert.match(txt, /^Disallow: \/check$/m);
  assert.match(txt, /^Disallow: \/recheck$/m);
  assert.match(txt, /^Disallow: \/status$/m);
});

test('an unknown path renders a templated 404 page, not bare text', async () => {
  const app = createApp({ config });
  const res = await app.request('/no/such/page');

  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);

  const html = await res.text();
  // Plan §6: "Real templated pages" — Hono's default is a bare text body, so the
  // page has to carry the shared shell, not just the words.
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /<title>[^<]*404[^<]*<\/title>/i);
});

test('GET /badge offers the snippets with absolute URLs from SITE_URL', async () => {
  const app = createApp({
    config: { ...config, siteUrl: 'https://staging.example.org' },
  });
  const res = await app.request('/badge');

  assert.equal(res.status, 200);
  const html = await res.text();

  // Plan §6.1: snippets are built from SITE_URL, sized 88x31 exactly, and use
  // alt="I love RSS" rather than the bare heart glyph.
  assert.match(html, /https:\/\/staging\.example\.org\/iheartrss\.svg/);
  assert.match(html, /https:\/\/staging\.example\.org\/iheartrss-dark\.svg/);
  assert.match(html, /width="88" height="31"/);
  assert.match(html, /alt="I love RSS"/);
  assert.doesNotMatch(html, /https:\/\/iheartrss\.com\/iheartrss\.svg/);
});

test('the badge SVGs are served and are hotlinkable', async () => {
  const app = createApp({ config });

  for (const path of [
    '/iheartrss.svg',
    '/iheartrss-dark.svg',
    '/iheartrss-icon.svg',
  ]) {
    const res = await app.request(path);

    assert.equal(res.status, 200, `${path} should be served`);
    assert.match(res.headers.get('content-type') ?? '', /image\/svg\+xml/, path);

    // Plan §6: "Long cache, permissive CORS — hotlinking is the point", plus
    // Cross-Origin-Resource-Policy: cross-origin on these three files.
    assert.equal(res.headers.get('access-control-allow-origin'), '*', path);
    assert.equal(
      res.headers.get('cross-origin-resource-policy'),
      'cross-origin',
      path,
    );

    const svg = await res.text();
    assert.match(svg, /<svg/, path);
  }
});

test('the stylesheet is served', async () => {
  const app = createApp({ config });
  const res = await app.request('/style.css');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/css/);
});

test('the static handler cannot be walked out of public/', async () => {
  const app = createApp({ config });

  // package.json is a real file one level above public/ — if any of these
  // resolve, the handler is serving the repo rather than the asset directory.
  for (const path of [
    '/..%2Fpackage.json',
    '/%2e%2e%2fpackage.json',
    '/..%2f..%2fetc%2fpasswd',
    '/package.json',
  ]) {
    const res = await app.request(path);
    assert.equal(res.status, 404, `${path} must not be served`);
  }
});
