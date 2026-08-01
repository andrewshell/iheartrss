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

test('the homepage fetches nothing from Google', async () => {
  // Dave's page links three Google fonts; only Rancho was the blogroll's, and only
  // for the title inside the box, which we turn off. Dropping it took a whole third
  // party off the page — and `lib/headers.js` and /about both now say so. If a font
  // link comes back, those two statements quietly become false.
  const app = createApp({ config });
  const home = await (await app.request('/')).text();
  const csp = (await app.request('/')).headers.get('content-security-policy');

  assert.doesNotMatch(home, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.doesNotMatch(csp, /googleapis|gstatic/);
});

test('the container is the only markup the blogroll needs', async () => {
  // blogroll.js builds the menu, the sort headers, the table and the footer itself.
  // The div is empty on purpose: anything we put inside it would sit above content
  // appended after it, not be replaced by it. (Our own component worked the other
  // way round — see the fallback test below for where that content lives now.)
  const app = createApp({ config });
  const home = await (await app.request('/')).text();

  const container = home.match(
    /<div\b[^>]*id="idBlogrollContainer"[^>]*>([\s\S]*?)<\/div>/,
  );
  assert.ok(container, 'the homepage has no blogroll container');
  assert.equal(container[1].trim(), '');
  // Not decoration: blogroll.js binds arrow keys and Return on `body` and acts only
  // while this element has focus, so without it the keyboard interface is dead.
  assert.match(container[0], /tabindex="0"/);
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
    .replace(/<div\b[^>]*id="idBlogrollContainer"[\s\S]*?<\/div>/, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/, '');
  assert.doesNotMatch(outside, /idBlogrollContainer/);
  assert.match(outside, /<h2>/);
  assert.match(outside, /href="\/sites"/);
  assert.match(outside, /href="\/subscriptions\.opml"/);

  assert.match(section, /<noscript>/);
});

// ── The starter's one piece of logic ────────────────────────────────────────────
//
// `public/feedland-blogroll.js` is browser code with no exports, loaded into a `vm`
// realm the same way the component below is. `startBlogroll` runs at the bottom of
// the file, so `document.getElementById` has to answer — returning null makes it
// take its own early exit, which is the behaviour we want here anyway.

async function loadStarter(items) {
  const source = await readFile(
    new URL('../public/feedland-blogroll.js', import.meta.url),
    'utf8',
  );
  const removed = [];
  const realm = createContext({
    document: {
      getElementById: () => null,
      querySelectorAll: () =>
        items.map((text) => ({
          textContent: text,
          remove() {
            removed.push(text);
          },
        })),
    },
    window: {},
    console: { error: () => {} },
  });
  runInContext(source, realm);
  return { realm, removed };
}

test('the ⋮ menu loses the item that can only show an error', async () => {
  // "View list in FeedLand..." reads an option with no default and pops
  // "…the URL hasn't been specified in the software." at whoever clicks it. It
  // cannot be configured away: FeedLand addresses a list as a category belonging to
  // an account, and ours is an OPML file on our own server.
  const { realm, removed } = await loadStarter([
    'Blogroll home..',
    'How to use..',
    '',
    'View this list in OPML..',
    'View list in FeedLand...',
    '',
    'Developer info..',
  ]);

  realm.dropUnconfiguredMenuItem();

  // Exactly one item, and not the one directly above it that opens OUR OPML file.
  assert.deepEqual(removed, ['View list in FeedLand...']);
});

test('a reworded menu removes nothing rather than the wrong thing', async () => {
  // The items carry no id, class or data attribute, so the match is on text. If Dave
  // rewords the label this stops firing and the error dialog comes back — which is
  // the direction to fail: a menu item we did not mean to remove is worse than one
  // we failed to remove.
  const { realm, removed } = await loadStarter([
    'Blogroll home..',
    'Open the list in FeedLand..',
    'Developer info..',
  ]);

  realm.dropUnconfiguredMenuItem();

  assert.deepEqual(removed, []);
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
    document: fakeDocument(),
    // Browser globals the component reaches for. A `vm` realm starts with none of
    // them, so each one here is a thing the browser would have supplied: `URL` to
    // derive the socket address, `AbortSignal` for the request timeout, `CSS.escape`
    // for the selector a socket update finds its row with, and the timer pair the
    // reconnect backoff runs on.
    URL,
    AbortSignal,
    CSS: { escape: (value) => value },
    WebSocket: class {},
    setTimeout,
    clearTimeout,
  });
  runInContext(source, realm);
  return realm;
}

/**
 * Just enough DOM for `listItemElement`, which is where the item date is read.
 *
 * `innerHTML` strips tags into `textContent` because `stripAndTruncate` uses a
 * throwaway div as its HTML-to-text converter — with an inert setter every item
 * title would come back empty and the assertions would pass for the wrong reason.
 */
function fakeDocument() {
  const element = (tag) => ({
    tag,
    attrs: {},
    children: [],
    textContent: '',
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    set innerHTML(value) {
      this.textContent = String(value).replace(/<[^>]*>/g, '');
    },
  });

  return {
    createElement: element,
    createTextNode: (text) => ({ tag: '#text', textContent: text }),
  };
}

/** The `<time>` inside a rendered `<li>`. */
function timeOf(li) {
  return li.children.find((child) => child.tag === 'time');
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
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
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
  assert.match(calls[0].url, /getfeedlistfromopml\?url=https%3A%2F%2Fiheartrss\.com/);
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

test('a feed FeedLand has never crawled at all is left out, not dated "undefined"', async () => {
  // A DIFFERENT state from `ctItems: 0` above, and the one the count check waves
  // through: FeedLand has never crawled the feed, so it comes back with `ctItems`,
  // `whenUpdated` and `whenCreated` all ABSENT. This shape is taken from a real feed
  // on our own list, and it used to render a row whose time was the string
  // "undefined" — `timeAgo(undefined)` returns nothing, and `textContent = undefined`
  // prints the word.
  const { fetchStub } = feedland([
    feed({ title: 'Crawled' }),
    {
      feedUrl: 'https://johnjohnston.info/blog/feed/',
      title: "John's World Wide Wall Display",
      htmlUrl: 'https://johnjohnston.info/blog/',
    },
  ]);

  const list = await (await loadComponent(fetchStub)).getFeedListFromOpml('https://x/o');

  assert.deepEqual(
    list.map((f) => f.title),
    ['Crawled'],
  );
});

test('a feed whose update time is unparseable or a sentinel is left out too', async () => {
  // The filter is on whether the date is USABLE, not on whether the key is present.
  // The last two are the ones a NaN-only check misses: `new Date(null)` is the epoch,
  // and FeedLand uses `1970-01-01T00:00:00.000Z` as a "never happened" value outright
  // — both are finite, and both would have rendered as "56 years ago".
  const { fetchStub } = feedland([
    feed({ title: 'Fine' }),
    feed({ title: 'Empty', whenUpdated: '' }),
    feed({ title: 'Not a date', whenUpdated: 'never' }),
    feed({ title: 'Null', whenUpdated: null }),
    feed({ title: 'Epoch', whenUpdated: '1970-01-01T00:00:00.000Z' }),
  ]);

  const list = await (await loadComponent(fetchStub)).getFeedListFromOpml('https://x/o');

  assert.deepEqual(
    list.map((f) => f.title),
    ['Fine'],
  );
});

// ── Item dates ─────────────────────────────────────────────────────────────────

/** One item shaped like FeedLand's `getfeeditems` answer, RFC-822 dates included. */
function item(overrides = {}) {
  return {
    title: 'A post',
    link: 'https://alice.example/a-post',
    description: 'Some words.',
    // Both fields, because the real answer carries both — and picking the wrong one
    // is the bug these tests exist for.
    pubDate: 'Sun, 26 Jul 2026 02:00:00 GMT',
    whenUpdated: 'Fri, 31 Jul 2026 18:55:39 GMT',
    ...overrides,
  };
}

function feedlandItems(items) {
  return async () => ({ ok: true, json: async () => items });
}

test('items are dated by when they were published, not when FeedLand crawled', async () => {
  // The heart of it. `whenUpdated` on an ITEM is when FeedLand last touched the feed
  // record it came from, so it is very nearly a per-feed constant: five real items
  // from brennan.day spanning six days came back with five distinct `pubDate`s and
  // two distinct `whenUpdated`s. Reading it per item stamped four posts with the same
  // time and none of them with their own.
  const realm = await loadComponent(feedlandItems([]));

  const rendered = realm.listItemElement(
    item({
      pubDate: 'Sun, 26 Jul 2026 02:00:00 GMT',
      whenUpdated: 'Fri, 31 Jul 2026 18:55:39 GMT',
    }),
  );

  // The two dates are five days apart, so the rendered time tells us which was read
  // without pinning the exact wording of a relative time.
  const shown = timeOf(rendered).textContent;
  assert.equal(shown, realm.timeAgo('Sun, 26 Jul 2026 02:00:00 GMT'));
  assert.notEqual(shown, realm.timeAgo('Fri, 31 Jul 2026 18:55:39 GMT'));

  // `datetime` has to be a valid HTML datetime, which the RFC-822 string FeedLand
  // sends is not — so it is converted rather than passed through.
  assert.equal(timeOf(rendered).attrs.datetime, '2026-07-26T02:00:00.000Z');
});

test('items sort newest-published first', async () => {
  // Sorting on `whenUpdated` was very nearly a no-op — the values are mostly equal,
  // so the order simply survived as whatever FeedLand sent. This pins the intent.
  const realm = await loadComponent(
    feedlandItems([
      item({ title: 'Older', pubDate: 'Sun, 26 Jul 2026 02:00:00 GMT' }),
      item({ title: 'Newest', pubDate: 'Fri, 31 Jul 2026 22:55:52 GMT' }),
      item({ title: 'Middle', pubDate: 'Wed, 29 Jul 2026 02:00:00 GMT' }),
    ]),
  );

  const items = await realm.getFeedItems('https://alice.example/rss.xml', 5);

  assert.deepEqual(
    items.map((i) => i.title),
    ['Newest', 'Middle', 'Older'],
  );
});

// ── Which server, and how long we wait for it ──────────────────────────────────

test('the FeedLand server is a parameter, defaulting to the one the site uses', async () => {
  // It was `https://feedland.com` written into two fetch lines. The site talks to
  // Dave's server now, so a restored reader would have quietly been asking a
  // different FeedLand than the rest of the page.
  const { calls, fetchStub } = feedland([feed()]);
  const realm = await loadComponent(fetchStub);

  await realm.getFeedListFromOpml('https://iheartrss.com/subscriptions.opml');
  assert.match(calls[0].url, /^https:\/\/claude\.feedland\.org\/getfeedlistfromopml\?/);

  await realm.getFeedListFromOpml('https://x/o', 'https://feedland.example');
  assert.match(calls[1].url, /^https:\/\/feedland\.example\/getfeedlistfromopml\?/);

  await realm.getFeedItems(
    'https://alice.example/rss.xml',
    5,
    'https://feedland.example',
  );
  assert.match(calls[2].url, /^https:\/\/feedland\.example\/getfeeditems\?/);
});

test('both calls give up rather than hanging forever', async () => {
  // `fetch` has no timeout of its own: a FeedLand that accepts the connection and
  // then says nothing left the promise pending for the life of the page, with the
  // reader neither rendering nor failing.
  const { calls, fetchStub } = feedland([feed()]);
  const realm = await loadComponent(fetchStub);

  await realm.getFeedListFromOpml('https://x/o');
  await realm.getFeedItems('https://alice.example/rss.xml', 5);

  for (const call of calls) {
    assert.ok(call.options?.signal, `${call.url} was sent with no abort signal`);
  }
});

// ── Item links ─────────────────────────────────────────────────────────────────

test('an item with no link falls back to its enclosure', async () => {
  // A podcast item routinely has no `<link>` — the episode audio is the enclosure.
  const realm = await loadComponent(feedlandItems([]));

  const rendered = realm.listItemElement(
    item({ link: undefined, enclosure: { url: 'https://alice.example/ep1.mp3' } }),
  );

  const anchor = rendered.children[0];
  assert.equal(anchor.tag, 'a');
  assert.equal(anchor.attrs.href, 'https://alice.example/ep1.mp3');
});

test('an item with no link and no enclosure is text, not a link to nowhere', async () => {
  // This used to render `href="undefined"` — a relative URL that resolves against
  // our own origin and 404s on iheartrss.com.
  const realm = await loadComponent(feedlandItems([]));

  const rendered = realm.listItemElement(item({ link: undefined }));

  assert.equal(rendered.children[0].tag, 'span');
  assert.equal(rendered.children[0].attrs.href, undefined);
  // Still says what the item is.
  assert.equal(rendered.children[0].textContent, 'A post');
});

// ── The socket ─────────────────────────────────────────────────────────────────

test("FeedLand's socket frames are a command, a CR, then JSON", async () => {
  const realm = await loadComponent(feedlandItems([]));

  const message = realm.parseSocketMessage(
    'updatedFeed\r{"feedUrl":"https://alice.example/rss.xml","whenUpdated":"2026-08-01T09:00:00.000Z"}',
  );

  assert.equal(message.command, 'updatedFeed');
  assert.equal(message.payload.feedUrl, 'https://alice.example/rss.xml');
});

test('a frame that does not parse is ignored, not thrown', async () => {
  // The socket is a live connection to someone else's server and the list is
  // already on the page without it, so nothing arriving on it may take the page
  // down: a keepalive, a truncated frame and a future command all have to be inert.
  const realm = await loadComponent(feedlandItems([]));

  for (const frame of ['', 'ping', 'updatedFeed\rnot json', 'updatedFeed', undefined]) {
    assert.equal(realm.parseSocketMessage(frame), undefined, String(frame));
  }
});

test('the socket URL is the server, upgraded to a websocket scheme', async () => {
  const realm = await loadComponent(feedlandItems([]));

  assert.equal(
    realm.socketUrl('https://claude.feedland.org'),
    'wss://claude.feedland.org/',
  );
  // http only ever means a local FeedLand, but it must not become `wss:` there.
  assert.equal(realm.socketUrl('http://localhost:1408'), 'ws://localhost:1408/');
});

test('an item with no usable date renders a blank time, never the word "undefined"', async () => {
  const realm = await loadComponent(feedlandItems([]));

  for (const pubDate of [undefined, '', 'not a date']) {
    const rendered = realm.listItemElement(item({ pubDate }));

    assert.equal(timeOf(rendered).textContent, '', String(pubDate));
    // No `datetime` at all beats an invalid one.
    assert.equal(timeOf(rendered).attrs.datetime, undefined, String(pubDate));
  }
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
