/**
 * `/` and `/river` embed River's `<river-blogroll>` and `<river-river>` elements
 * (geekitycom/river, docs/EMBED.md), pointed at our own OPML file.
 *
 * The seams are the response headers that decide whether the elements may run at
 * all, and the served HTML. Nothing here calls River: that request is the browser's,
 * and a test that made it would test River's uptime, not this site.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { FEEDLAND_SERVER, FEEDLAND_SOCKET } from '../src/lib/feedland.js';

const config = {
  port: 3000,
  siteUrl: 'https://iheartrss.com',
  linkbackHosts: ['iheartrss.com', 'www.iheartrss.com'],
};

const PAGES = [
  { path: '/', element: 'river-blogroll', module: 'river-blogroll.js' },
  { path: '/river', element: 'river-river', module: 'river-river.js' },
];

function directive(csp, name) {
  return csp.match(new RegExp(`(?:^|;\\s*)${name} ([^;]*)`))?.[1];
}

async function get(path) {
  const app = createApp({ config });
  const res = await app.request(path);
  return { csp: res.headers.get('content-security-policy'), html: await res.text() };
}

test('each page loads River’s stylesheet and its own element module from River', async () => {
  for (const { path, module } of PAGES) {
    const { html } = await get(path);
    assert.ok(
      html.includes(
        `<link rel="stylesheet" href="${FEEDLAND_SERVER}/static/client/river.css">`,
      ),
      `${path} does not load river.css`,
    );
    assert.ok(
      html.includes(
        `<script type="module" src="${FEEDLAND_SERVER}/static/client/${module}"></script>`,
      ),
      `${path} does not load ${module}`,
    );
    // Before ours, so a reader of the head sees ours as the last word, though the
    // `river` cascade layer is what actually makes ours win.
    assert.ok(html.indexOf('river.css') < html.indexOf('/style.css'), path);
  }
});

test('the element points at this deployment’s OPML and the host the CSP admits', async () => {
  for (const { path, element } of PAGES) {
    const { html } = await get(path);
    const tag = html.match(new RegExp(`<${element}\\s[^>]*>`))?.[0];
    assert.ok(tag, `${path} has no <${element}>`);
    assert.match(tag, /opml="https:\/\/iheartrss\.com\/subscriptions\.opml"/, path);
    assert.ok(tag.includes(`server="${FEEDLAND_SERVER}"`), path);
  }
});

test('no other page loads River’s modules or the old FeedLand includes', async () => {
  for (const path of ['/about', '/sites', '/submit', '/badge', '/guide', '/blog']) {
    const { html } = await get(path);
    assert.doesNotMatch(html, /static\/client\/|<river-/, path);
  }
  for (const { path } of PAGES) {
    const { html } = await get(path);
    assert.doesNotMatch(html, /amazonaws|scripting\.com|googleapis|jquery/i, path);
  }
});

test('both pages keep a way onward outside the element, and without JS', async () => {
  for (const { path, element } of PAGES) {
    const { html } = await get(path);
    const outside = html.replace(new RegExp(`<${element}\\s[\\s\\S]*?</${element}>`), '');
    const noscript = html.match(/<noscript>[\s\S]*?<\/noscript>/)?.[0] ?? '';
    for (const href of ['/sites', '/subscriptions.opml']) {
      assert.ok(outside.replace(noscript, '').includes(`href="${href}"`), path);
      assert.ok(noscript.includes(`href="${href}"`), path);
    }
  }
});

test('the homepage CSP admits River’s code, API and socket, and nothing wider', async () => {
  const { csp } = await get('/');

  assert.equal(directive(csp, 'script-src'), `'self' ${FEEDLAND_SERVER}`);
  assert.equal(directive(csp, 'style-src'), `'self' ${FEEDLAND_SERVER}`);
  assert.equal(
    directive(csp, 'connect-src'),
    `'self' ${FEEDLAND_SERVER} ${FEEDLAND_SOCKET}`,
  );
  // The blogroll shows no pictures.
  assert.equal(directive(csp, 'img-src'), "'self'");
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|media-src/);
});

test('the river CSP opens no socket, and widens only images and media', async () => {
  const { csp } = await get('/river');

  assert.equal(directive(csp, 'script-src'), `'self' ${FEEDLAND_SERVER}`);
  assert.equal(directive(csp, 'style-src'), `'self' ${FEEDLAND_SERVER}`);
  assert.equal(directive(csp, 'connect-src'), `'self' ${FEEDLAND_SERVER}`);
  // Favicons and authors' own pictures come from anywhere, but only over TLS.
  assert.equal(directive(csp, 'img-src'), "'self' https:");
  // Podcast enclosures are often plain http, which Chrome will not upgrade.
  assert.equal(directive(csp, 'media-src'), 'https: http:');
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});

test('every other page keeps the strict policy', async () => {
  for (const path of ['/about', '/sites', '/submit', '/badge', '/guide', '/blog']) {
    const { csp } = await get(path);
    assert.equal(directive(csp, 'script-src'), "'self'", path);
    assert.equal(directive(csp, 'connect-src'), "'self'", path);
    assert.equal(directive(csp, 'img-src'), "'self'", path);
  }
});

test('the river is in the nav and the sitemap', async () => {
  assert.match((await get('/about')).html, /<a href="\/river">/);
  assert.match((await get('/sitemap.xml')).html, /<loc>[^<]*\/river<\//);
});

test('/about names who the two pages contact', async () => {
  const { html } = await get('/about');

  assert.match(html, new RegExp(new URL(FEEDLAND_SERVER).host.replace(/\./g, '\\.')));
  assert.match(html, /icons\.duckduckgo\.com/);
  assert.doesNotMatch(html, /Amazon S3|jQuery|Bootstrap/);
  assert.match(html, /no analytics/i);
  assert.match(html, /no cookies/i);
});
