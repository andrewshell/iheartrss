/**
 * §10's feed reader, landing on the homepage.
 *
 * The seams are the ones a browser actually sees: the response headers that decide
 * whether the component may run at all, and the served HTML of the pages. Nothing
 * here touches feedland.com — the network call is the browser's, not ours, and a
 * test that made it would be a test of somebody else's uptime.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';

const config = {
  port: 3000,
  siteUrl: 'https://iheartrss.com',
  linkbackHosts: ['iheartrss.com', 'www.iheartrss.com'],
};

test('the CSP admits our own script and FeedLand, and widens nothing else', async () => {
  const app = createApp({ config });
  const csp = (await app.request('/')).headers.get('content-security-policy');

  // The two widenings §10 needs, and exactly those two: the component is a
  // same-origin file, and it talks to one third-party host.
  assert.match(csp, /(?:^|;\s*)script-src 'self'(?:;|$)/);
  assert.match(csp, /(?:^|;\s*)connect-src 'self' https:\/\/feedland\.com(?:;|$)/);

  // Still fails safe, and still refuses inline script — there is no inline JS in
  // the app and 'self' is not a step toward allowing any.
  assert.match(csp, /(?:^|;\s*)default-src 'none'(?:;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(csp, /script-src[^;]*\*/);
});

test('/blog-roll.js is served as JavaScript', async () => {
  const app = createApp({ config });
  const res = await app.request('/blog-roll.js');

  assert.equal(res.status, 200);
  // Every response carries `X-Content-Type-Options: nosniff`, so a fallback of
  // application/octet-stream is not a cosmetic wrong answer — the browser refuses
  // to execute the file and the reader silently never appears.
  assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.match(await res.text(), /customElements\.define\('blog-roll'/);
});

test("the homepage's reader points at this deployment's own OPML", async () => {
  // A deliberately non-default origin: the OPML URL has to be built from
  // `config.siteUrl`, and a hardcoded https://iheartrss.com/subscriptions.opml
  // would pass happily against the default config while being wrong everywhere
  // else — staging, a renamed domain, the operator's own box.
  const app = createApp({
    config: { ...config, siteUrl: 'https://ring.example.test/' },
  });
  const html = await (await app.request('/')).text();

  assert.match(
    html,
    /<blog-roll[^>]*opmlurl="https:\/\/ring\.example\.test\/subscriptions\.opml"/,
  );
});

test('the reader script is loaded by the homepage and by no other page', async () => {
  const app = createApp({ config });

  // `defer`: the element is further down the document than the tag, and a blocking
  // script on the one page whose whole point is to be fast is the wrong trade.
  const home = await (await app.request('/')).text();
  assert.match(home, /<script\b[^>]*\bsrc="\/blog-roll\.js"[^>]*><\/script>/);
  assert.match(home, /<script\b[^>]*\bdefer\b[^>]*><\/script>/);

  // The shared layout renders every page, so the script has to be opted into
  // rather than inherited — otherwise /about downloads and runs a feed reader it
  // has no element for.
  for (const path of ['/about', '/sites', '/submit', '/badge', '/guide', '/blog']) {
    assert.doesNotMatch(await (await app.request(path)).text(), /blog-roll\.js/, path);
  }
});

test('the section survives both no-JS and a FeedLand outage', async () => {
  const app = createApp({ config });
  const html = await (await app.request('/')).text();

  const section = html.match(/<section class="blogroll">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(section, 'the homepage has no blogroll section');

  // Inside the element: what a visitor sees with JavaScript off, or before the
  // fetch returns. The component replaces it, so it costs a rendered reader
  // nothing — and it is the difference between an empty box and two useful links.
  const inside = section.match(/<blog-roll\b[^>]*>([\s\S]*?)<\/blog-roll>/)?.[1];
  assert.ok(inside, 'the blogroll section has no <blog-roll> element');
  assert.match(inside, /href="\/sites"/);
  assert.match(inside, /href="\/subscriptions\.opml"/);

  // Outside it: when FeedLand is down the component clears the element and appends
  // nothing, so everything asserted above is gone at runtime. What is left has to
  // still be a section with a heading and somewhere to go — scoped to this section
  // deliberately, since the hero above also links both of these.
  const outside = section
    .replace(/<blog-roll\b[\s\S]*?<\/blog-roll>/, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/, '');
  assert.match(outside, /<h2>/);
  assert.match(outside, /href="\/sites"/);
  assert.match(outside, /href="\/subscriptions\.opml"/);

  assert.match(section, /<noscript>/);
});

test('/about names FeedLand and what it gets to see', async () => {
  const app = createApp({ config });
  const html = await (await app.request('/about')).text();

  // The old wording — "no third-party scripts and no tracking of any kind" — was
  // still *literally* true (blog-roll.js is ours, self-hosted) and had stopped
  // being honest: the homepage now makes browser-side requests to feedland.com,
  // which hands a stranger the visitor's IP. It must not survive unqualified.
  assert.doesNotMatch(html, /no third-party scripts and no tracking of any kind/);

  const paragraph = html
    .match(/<p>[\s\S]*?<\/p>/g)
    ?.find((p) => /FeedLand/.test(p) && !/href/.test(p.slice(0, 8)));
  assert.ok(paragraph, '/about does not mention FeedLand at all');
  assert.match(paragraph, /IP address/i);

  // The parts that are still true have to still be said, or the correction reads
  // as a retreat from a promise that was never broken.
  assert.match(html, /no analytics/i);
  assert.match(html, /no cookies/i);
});
