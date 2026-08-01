/**
 * §10's feed reader, landing on the homepage.
 *
 * The seams are the ones a browser actually sees: the response headers that decide
 * whether the component may run at all, and the served HTML of the pages. Nothing
 * here touches FeedLand — the network call is the browser's, not ours, and a test
 * that made it would be a test of somebody else's uptime.
 *
 * **The homepage is currently running Dave Winer's blogroll.js instead of our own
 * `<blog-roll>`**, on trial. So the page-level tests below describe his setup, while
 * the component tests at the bottom still describe `public/blog-roll.js` — which is
 * still served, still ours, and is what we go back to if the trial comes off. That
 * split is deliberate: if the component's own tests had been deleted along with the
 * tag on the homepage, going back would mean rewriting them from memory.
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

test('the homepage CSP admits blogroll.js and its hosts, and nothing wider', async () => {
  const app = createApp({ config });
  const csp = (await app.request('/')).headers.get('content-security-policy');

  // The hosts blogroll.js actually comes from. Both are named because
  // code.scripting.com 302s to the S3 bucket and CSP checks the redirect target.
  assert.match(
    csp,
    /(?:^|;\s*)script-src 'self' https:\/\/s3\.amazonaws\.com https:\/\/code\.scripting\.com(?:;|$)/,
  );
  // Dave's server, not feedland.com — and the socket, which is what keeps the
  // "when" times live.
  assert.match(
    csp,
    /(?:^|;\s*)connect-src 'self' https:\/\/claude\.feedland\.org wss:\/\/claude\.feedland\.org(?:;|$)/,
  );

  // Still fails safe, and script is still ours-plus-two-named-hosts: no wildcard,
  // no 'unsafe-inline', no 'unsafe-eval'. `feedland-blogroll.js` is a file rather
  // than the inline tag Dave's page uses precisely so this stays true.
  assert.match(csp, /(?:^|;\s*)default-src 'none'(?:;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*(?:\*|unsafe-inline|unsafe-eval)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /\*/);

  // The one concession, and it is scoped to style: the FeedLand includes emit
  // `style=` attributes. If this line ever disappears the blogroll renders
  // unstyled, which is worth failing loudly rather than discovering by eye.
  assert.match(csp, /style-src [^;]*'unsafe-inline'/);
});

test('the widened CSP is the homepage only', async () => {
  const app = createApp({ config });

  for (const path of ['/about', '/sites', '/submit', '/badge', '/guide', '/blog']) {
    const csp = (await app.request(path)).headers.get('content-security-policy');
    assert.match(csp, /(?:^|;\s*)script-src 'self'(?:;|$)/, path);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|amazonaws|scripting\.com/, path);
  }
});

test('/blog-roll.js is still served as JavaScript', async () => {
  // Our own reader is not on the homepage while the trial runs, but the file has
  // not moved: swapping back should be one line in `views/home.js`, not a restore.
  const app = createApp({ config });
  const res = await app.request('/blog-roll.js');

  assert.equal(res.status, 200);
  // Every response carries `X-Content-Type-Options: nosniff`, so a fallback of
  // application/octet-stream is not a cosmetic wrong answer — the browser refuses
  // to execute the file and the reader silently never appears.
  assert.match(res.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.match(await res.text(), /customElements\.define\('blog-roll'/);
});

test("the blogroll points at this deployment's own OPML", async () => {
  // A deliberately non-default origin: the OPML URL has to be built from
  // `config.siteUrl`, and a hardcoded https://iheartrss.com/subscriptions.opml
  // would pass happily against the default config while being wrong everywhere
  // else — staging, a renamed domain, the operator's own box. Dave's code.js does
  // hardcode it; `data-opmlurl` is why ours does not have to.
  const app = createApp({
    config: { ...config, siteUrl: 'https://ring.example.test/' },
  });
  const html = await (await app.request('/')).text();

  assert.match(
    html,
    /<div[^>]*id="idBlogrollContainer"[\s\S]*?data-opmlurl="https:\/\/ring\.example\.test\/subscriptions\.opml"/,
  );
});

test('the homepage loads blogroll.js and its includes, and no other page does', async () => {
  const app = createApp({ config });
  const home = await (await app.request('/')).text();

  // Order is load-bearing: these are classic scripts reading each other's globals
  // at load time. jQuery first, blogroll.js after the FeedLand includes, and our
  // starter — deferred, so it runs after all of them — last.
  const order = [
    'jquery-1.9.1.min.js',
    'feedland/home/api.js',
    'code.scripting.com/blogroll/blogroll.js',
  ].map((needle) => home.indexOf(needle));
  assert.ok(
    order.every((at) => at > -1),
    'the homepage is missing one of blogroll.js’s includes',
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'includes are out of order',
  );

  // `defer` plus `?v=<digest>`: it has to run after the parser-blocking includes
  // above, and stale starter logic against a live third-party API fails in ways
  // stale colours do not.
  assert.match(
    home,
    /<script\b[^>]*\bsrc="\/feedland-blogroll\.js\?v=[0-9a-f]+"[^>]*\bdefer\b[^>]*><\/script>/,
  );

  // The shared layout renders every page, so all of this has to be opted into
  // rather than inherited — otherwise /about pulls jQuery and bootstrap down for
  // an element it does not have.
  //
  // Matched on the tags rather than the words: /about talks about the blogroll in
  // prose, and a bare /blogroll/i would call that a regression.
  for (const path of ['/about', '/sites', '/submit', '/badge', '/guide', '/blog']) {
    const html = await (await app.request(path)).text();
    assert.doesNotMatch(html, /<(?:script|link)[^>]*(?:amazonaws|scripting\.com)/i, path);
    assert.doesNotMatch(html, /feedland-blogroll\.js/, path);
  }
});

test('the section survives both no-JS and a FeedLand outage', async () => {
  const app = createApp({ config });
  const html = await (await app.request('/')).text();

  const section = html.match(/<section class="blogroll">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(section, 'the homepage has no blogroll section');

  // blogroll.js appends into the container and says nothing at all when FeedLand is
  // unreachable — so unlike our own component, which replaced its own fallback,
  // everything a visitor needs on a bad day has to live OUTSIDE the container and
  // stay on the page forever. Scoped to this section deliberately, since the hero
  // above also links both of these.
  const outside = section
    .replace(/<div class="divBlogrollContainerContainer">[\s\S]*?<\/div>\s*<\/div>/, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/, '');
  assert.doesNotMatch(outside, /idBlogrollContainer/);
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

test('/about names the third parties and what they get to see', async () => {
  const app = createApp({ config });
  const html = await (await app.request('/about')).text();

  // The old wording — "no third-party scripts and no tracking of any kind" — was
  // still *literally* true when the reader was ours and self-hosted. It stopped
  // being true the day the homepage started pulling jQuery, bootstrap and
  // blogroll.js off somebody else's bucket, and it must not survive unqualified.
  assert.doesNotMatch(html, /no third-party scripts and no tracking of any kind/);

  const paragraph = html
    .match(/<p>[\s\S]*?<\/p>/g)
    ?.find((p) => /IP address/i.test(p) && /blogroll/i.test(p));
  assert.ok(paragraph, '/about does not say the homepage loads third-party code');
  // Naming FeedLand alone would now be an understatement: the scripts come from a
  // different party than the API calls do, and both see the visitor.
  assert.match(paragraph, /claude\.feedland\.org/);
  assert.match(paragraph, /scripting\.com|Amazon S3/);

  // The parts that are still true have to still be said, or the correction reads
  // as a retreat from a promise that was never broken.
  assert.match(html, /no analytics/i);
  assert.match(html, /no cookies/i);
});
