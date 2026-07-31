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
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

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
  // `?v=<digest>`: stale reader logic against a live third-party API fails in ways
  // stale colours do not, so the script is versioned like the stylesheet.
  assert.match(
    home,
    /<script\b[^>]*\bsrc="\/blog-roll\.js\?v=[0-9a-f]+"[^>]*><\/script>/,
  );
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

// ── The component's own logic ───────────────────────────────────────────────────
//
// `public/blog-roll.js` is browser code with no exports, so it is loaded into a `vm`
// realm with the three globals it touches at load time stubbed out. Its top-level
// `function` declarations land on that realm's global object, which is what makes
// `getFeedListFromOpml` reachable — and FeedLand is a stub, so this still never
// leaves the process.

async function loadComponent(fetchStub) {
  const source = await readFile(
    new URL('../public/blog-roll.js', import.meta.url),
    'utf8',
  );
  const realm = createContext({
    HTMLElement: class {},
    customElements: { define: () => {} },
    fetch: fetchStub,
    console: { error: () => {} },
  });
  runInContext(source, realm);
  return realm;
}

/** One entry shaped like FeedLand's, which is where the field names come from. */
function feed(overrides = {}) {
  return {
    feedUrl: 'https://alice.example/rss.xml',
    title: 'Alice',
    htmlUrl: 'https://alice.example/',
    ctItems: 23,
    whenUpdated: '2026-07-30T17:20:59.000Z',
    whenChecked: '2026-07-31T17:27:15.000Z',
    ...overrides,
  };
}

function feedland(feedlist) {
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ head: {}, feedlist }) };
  };
  return { calls, fetchStub };
}

test('a feed FeedLand has not crawled yet is left out of the reader', async () => {
  // The real shape of the problem: a member who joins before FeedLand knows their
  // feed comes back with `ctItems: 0` AND `whenUpdated` stamped at registration
  // time — so the one row with nothing behind it sorts to the *top* of a
  // newest-first list, reads "just now", and opens to an empty list.
  const { calls, fetchStub } = feedland([
    feed({ title: 'Crawled', whenUpdated: '2026-07-20T00:00:00.000Z' }),
    feed({
      title: 'Just joined',
      ctItems: 0,
      whenUpdated: '2026-07-31T18:29:58.000Z',
      whenChecked: '2026-07-31T18:29:58.000Z',
    }),
    feed({ title: 'Also crawled', whenUpdated: '2026-07-31T00:00:00.000Z' }),
  ]);

  const list = await (
    await loadComponent(fetchStub)
  ).getFeedListFromOpml('https://iheartrss.com/subscriptions.opml');

  // Both halves in one assertion: the uncrawled feed is gone, and the newest-first
  // order the filter runs alongside is undisturbed.
  assert.deepEqual(
    list.map((f) => f.title),
    ['Also crawled', 'Crawled'],
  );
  assert.match(calls[0], /getfeedlistfromopml\?url=https%3A%2F%2Fiheartrss\.com/);
});

test('an unknown item count shows the feed rather than hiding it', async () => {
  // The failure direction is the whole point: treating "FeedLand didn't say" as
  // empty would blank the entire reader the day that field is renamed.
  const { fetchStub } = feedland([
    feed({ title: 'No count at all', ctItems: undefined }),
    feed({ title: 'Nonsense count', ctItems: 'lots' }),
    feed({ title: 'Zero', ctItems: 0 }),
  ]);

  const list = await (await loadComponent(fetchStub)).getFeedListFromOpml('https://x/o');

  assert.deepEqual(list.map((f) => f.title).sort(), [
    'No count at all',
    'Nonsense count',
  ]);
});

test('a FeedLand answer with no feed list at all is empty, not an exception', async () => {
  const { fetchStub } = feedland(undefined);

  const list = await (await loadComponent(fetchStub)).getFeedListFromOpml('https://x/o');

  // `assert.equal` on the length rather than `deepEqual` against `[]`: this array is
  // built inside the vm realm, so it is not reference-equal to a host-realm literal.
  assert.equal(list.length, 0);
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
