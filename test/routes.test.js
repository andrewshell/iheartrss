import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { parseFeed } from '../src/verify/feed.js';

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

  for (const path of ['/iheartrss.svg', '/iheartrss-dark.svg', '/iheartrss-icon.svg']) {
    const res = await app.request(path);

    assert.equal(res.status, 200, `${path} should be served`);
    assert.match(res.headers.get('content-type') ?? '', /image\/svg\+xml/, path);

    // Plan §6: "Long cache, permissive CORS — hotlinking is the point", plus
    // Cross-Origin-Resource-Policy: cross-origin on these three files.
    assert.equal(res.headers.get('access-control-allow-origin'), '*', path);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin', path);

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

test('GET /guide covers each platform §6.2 names', async () => {
  const app = createApp({ config });
  const res = await app.request('/guide');

  assert.equal(res.status, 200);
  const html = await res.text();

  // §6.2's table, all five rows.
  for (const platform of ['Jekyll', 'GitHub Pages', 'Eleventy', 'Zola', 'Astro']) {
    assert.match(html, new RegExp(platform), platform);
  }

  // "Two things the guide must cover beyond format, because they're our other two
  // common rejections": the autodiscovery tag, with a note that it belongs on the page
  // the feed's <channel><link> points at; and <channel><link> itself.
  assert.match(html, /id="autodiscovery"/);
  assert.match(html, /id="channel-link"/);
  assert.match(html, /rel="alternate" type="application\/rss\+xml"/);
  assert.match(html, /&lt;channel&gt;&lt;link&gt;/);

  // A minimal, complete, valid RSS 2.0 document to copy and fill in.
  assert.match(html, /id="template"/);
  assert.match(html, /&lt;rss version="2\.0"&gt;/);

  // §6.2: "Worth adding a 'check my page' link straight to /check so the loop is:
  // read → fix → verify → submit, without leaving the site."
  assert.match(html, /href="\/submit"/);
});

test('the downloadable RSS 2.0 template is a feed our own validator accepts', async () => {
  const app = createApp({ config });
  const res = await app.request('/rss-2.0-template.xml');

  assert.equal(res.status, 200);
  const xml = await res.text();

  // If the template we hand out doesn't pass our own Step 3, we are sending people
  // into a loop.
  const parsed = parseFeed(xml);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.ok(parsed.channelLink);
});

test('/guide is linked from the pages §6.2 says link to it', async () => {
  const app = createApp({ config });

  for (const path of ['/', '/badge', '/about']) {
    const html = await (await app.request(path)).text();
    assert.match(html, /href="\/guide/, `${path} must link to /guide`);
  }
});

test('/status is linked from /about, since it is the only way to ask why', async () => {
  const app = createApp({ config });
  const html = await (await app.request('/about')).text();

  // §6: "Linked from /about, /sites and every rejection message."
  assert.match(html, /href="\/status/);
});

test('every page links the full favicon set, and each target actually exists', async () => {
  // §6.1: the SVG covers modern browsers, but Safari and older browsers need the
  // raster fallbacks. Phase 1 shipped without them because no rasterizer was
  // available; this asserts the gap is closed AND that nothing 404s.
  const app = createApp({ config });
  const html = await (await app.request('/')).text();

  for (const href of [
    '/iheartrss-icon.svg',
    '/favicon.ico',
    '/favicon-32x32.png',
    '/favicon-16x16.png',
    '/apple-touch-icon.png',
    '/site.webmanifest',
  ]) {
    assert.ok(html.includes(href), `<head> should reference ${href}`);
    const res = await app.request(href);
    assert.equal(res.status, 200, `${href} should be served, got ${res.status}`);
  }

  assert.match(html, /rel="manifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
});

test('the webmanifest is valid JSON, served as such, and names the app', async () => {
  const app = createApp({ config });
  const res = await app.request('/site.webmanifest');

  assert.match(res.headers.get('content-type') ?? '', /application\/manifest\+json/);

  const manifest = JSON.parse(await res.text());
  assert.ok(manifest.name.length > 0, 'name must not be the generator default of ""');
  assert.equal(manifest.icons.length, 2);
});
