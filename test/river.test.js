/**
 * `/river` — FeedLand's `riverviewer.js`, pointed at our own OPML file.
 *
 * The seams are the same ones `blogroll.test.js` describes, for the same reason: the
 * response headers that decide whether the display may run at all, and the served
 * HTML of the pages. Nothing here touches FeedLand — the network call is the
 * browser's, not ours, and a test that made it would be a test of somebody else's
 * uptime.
 *
 * What makes this page worth its own file rather than more cases in the blogroll's:
 * it has its own CSP profile, its own include list, and the two are wrong in
 * different ways. The include list is long, third-party, and order-dependent, and
 * three of its entries look optional and are not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

import { createApp } from '../src/app.js';
import { FEEDLAND_SERVER, FEEDLAND_SOCKET } from '../src/lib/feedland.js';

const config = {
  port: 3000,
  siteUrl: 'https://iheartrss.com',
  linkbackHosts: ['iheartrss.com', 'www.iheartrss.com'],
};

test('/river answers, and it is the river page', async () => {
  const app = createApp({ config });
  const res = await app.request('/river');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(await res.text(), /<div[^>]*id="idRiverContainer"/);
});

test("the river's CSP admits riverviewer.js and its hosts, and nothing wider", async () => {
  const app = createApp({ config });
  const csp = (await app.request('/river')).headers.get('content-security-policy');

  // ONE script host, not the blogroll's two. Every river include is an S3 bucket URL
  // to begin with; `code.scripting.com` is only on the homepage because its
  // `/blogroll/*` paths 302 to that bucket and CSP checks the redirect target.
  assert.match(csp, /(?:^|;\s*)script-src 'self' https:\/\/s3\.amazonaws\.com(?:;|$)/);

  // Still fails safe, and script is still ours-plus-one-named-host: no wildcard, no
  // 'unsafe-inline', no 'unsafe-eval'. `feedland-river.js` is a file rather than the
  // inline `startup()` call Dave's page ends with precisely so this stays true.
  assert.match(csp, /(?:^|;\s*)default-src 'none'(?:;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*(?:\*|unsafe-inline|unsafe-eval)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /\*/);

  // The one concession, scoped to style: riverviewer.js positions with `style=`
  // attributes. If this line disappears the river renders unstyled, which is worth
  // failing loudly rather than discovering by eye.
  assert.match(csp, /style-src [^;]*'unsafe-inline'/);
});

test('the river talks to FeedLand over https and does NOT open a socket', async () => {
  // The difference from the blogroll, and the reason these are two profiles rather
  // than one widened one. blogroll.js opens a websocket to keep its "when" column
  // live; the river's socket plumbing lives in FeedLand's own app shell, which
  // `views/river.js` deliberately does not load. Naming `wss:` here would be a
  // standing allowance with nothing using it.
  const app = createApp({ config });
  const csp = (await app.request('/river')).headers.get('content-security-policy');

  assert.match(
    csp,
    new RegExp(`(?:^|;\\s*)connect-src 'self' ${FEEDLAND_SERVER}(?:;|$)`),
  );
  assert.ok(!csp.includes(FEEDLAND_SOCKET), 'the river names a socket it never opens');
});

test('the river admits images from anywhere over TLS, and only images', async () => {
  // The one deliberately wide line in the file, and the reason it is wide: an item is
  // the author's own HTML, so its pictures come from wherever that member keeps them
  // — their domain, their CDN, their bucket. There is no list to write. Refusing them
  // was tried and it renders the browser's broken-image glyph, which reads as our bug
  // (3 of 174 items, verified in Chrome: `blockedURI` on `img-src`).
  const app = createApp({ config });
  const csp = (await app.request('/river')).headers.get('content-security-policy');

  assert.match(csp, /(?:^|;\s*)img-src 'self' https:(?:;|$)/);

  // `https:` and not `*`: plain-http images stay refused, so the page cannot be the
  // thing that downgrades a visitor's connection.
  assert.doesNotMatch(csp, /img-src[^;]*\*/);
  assert.doesNotMatch(csp, /img-src[^;]*\bhttp:/);

  // And the width is confined to images. This is the assertion that matters if
  // someone ever copies the line: `script-src` is untouched and still names one host.
  assert.match(csp, /(?:^|;\s*)script-src 'self' https:\/\/s3\.amazonaws\.com(?:;|$)/);
  for (const directive of ['script-src', 'connect-src', 'font-src', 'style-src']) {
    const value = csp.match(new RegExp(`${directive} ([^;]*)`))[1];
    assert.ok(
      !/\shttps:(\s|$)/.test(` ${value} `),
      `${directive} was widened to all of https: along with img-src`,
    );
  }
});

test('the widened CSPs are the homepage and the river, and nowhere else', async () => {
  const app = createApp({ config });

  for (const path of ['/about', '/sites', '/submit', '/badge', '/guide', '/blog']) {
    const csp = (await app.request(path)).headers.get('content-security-policy');
    assert.match(csp, /(?:^|;\s*)script-src 'self'(?:;|$)/, path);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|amazonaws|duckduckgo/, path);
  }
});

test('every copy of the FeedLand host agrees with lib/feedland.js', async () => {
  // The starter is a static file served to a browser, not a module in this build, so
  // it cannot import the constant — it keeps a literal, and this is the only thing
  // that can notice when the two drift. The failure is quiet: `connect-src` would
  // name the new host while the script called the old one, and the page would render
  // nothing with the evidence in a console nobody has open.
  const source = await readFile(
    new URL('../public/feedland-river.js', import.meta.url),
    'utf8',
  );
  const literals = [...source.matchAll(/'(https?:\/\/[^']*feedland[^']*)'/g)].map(
    (match) => match[1],
  );

  assert.ok(literals.length > 0, 'feedland-river.js names no FeedLand host at all');
  for (const literal of literals) {
    assert.equal(literal, FEEDLAND_SERVER, 'feedland-river.js is out of step');
  }
});

test('the river hands the browser the same host the CSP admits', async () => {
  // The two have to agree per response, not just per repo: the attribute says who to
  // call and the header says who may be called.
  const app = createApp({ config });
  const res = await app.request('/river');

  assert.match(await res.text(), new RegExp(`data-feedland="${FEEDLAND_SERVER}"`));
  assert.ok(res.headers.get('content-security-policy').includes(FEEDLAND_SERVER));
});

test("the river points at this deployment's own OPML", async () => {
  // A deliberately non-default origin. FeedLand fetches this URL SERVER-SIDE to build
  // the river, so it has to be whatever origin actually serves the OPML — a hardcoded
  // https://iheartrss.com/subscriptions.opml would pass against the default config
  // while being wrong on staging, a renamed domain, or the operator's own box.
  const app = createApp({
    config: { ...config, siteUrl: 'https://ring.example.test/' },
  });
  const html = await (await app.request('/river')).text();

  assert.match(
    html,
    /<div[^>]*id="idRiverContainer"[\s\S]*?data-opmlurl="https:\/\/ring\.example\.test\/subscriptions\.opml"/,
  );
});

test('the container is the only markup the river needs', async () => {
  // riverviewer.js appends a `.divRiverDisplay` into our div and builds everything
  // inside that. Anything we put in the div would sit ABOVE the river rather than be
  // replaced by it — which is exactly why the status line lives outside it.
  const app = createApp({ config });
  const html = await (await app.request('/river')).text();

  const container = html.match(/<div\b[^>]*id="idRiverContainer"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(container, '/river has no river container');
  assert.equal(container[1].trim(), '');
});

test('/river loads riverviewer.js and its includes, in order, and no other page does', async () => {
  const app = createApp({ config });
  const html = await (await app.request('/river')).text();

  // Order is load-bearing: these are classic scripts reading each other's globals at
  // load time. jQuery first, then the small-string layer, then the FeedLand API, then
  // the display that calls into all of it.
  const order = [
    'jquery-1.9.1.min.js',
    'includes/basic/code.js',
    'feedland/home/api.js',
    'feedland/home/riverviewer.js',
  ].map((needle) => html.indexOf(needle));
  assert.ok(
    order.every((at) => at > -1),
    'the river is missing one of riverviewer.js’s includes',
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'includes are out of order',
  );

  // `defer` plus `?v=<digest>`: it has to run after the parser-blocking includes
  // above, and stale starter logic against a live third-party API fails in ways stale
  // colours do not.
  assert.match(
    html,
    /<script\b[^>]*\bsrc="\/feedland-river\.js\?v=[0-9a-f]+"[^>]*\bdefer\b[^>]*><\/script>/,
  );

  // The shared layout renders every page, so all of this has to be opted into rather
  // than inherited. Matched on the tags rather than the words: /about talks about the
  // river in prose, and a bare /river/i would call that a regression.
  for (const path of ['/about', '/sites', '/submit', '/badge', '/guide', '/blog']) {
    const other = await (await app.request(path)).text();
    assert.doesNotMatch(
      other,
      /<(?:script|link)[^>]*(?:amazonaws|scripting\.com)/i,
      path,
    );
    assert.doesNotMatch(other, /feedland-river\.js/, path);
  }
});

test('the three includes that look optional and are not', async () => {
  // Each of these renders a slice of the river and nothing else, so leaving one out
  // does not break the page — it blanks part of it with a ReferenceError, which is
  // exactly the kind of thing a tidy-up removes. Counts are from our own list on the
  // day this was written, out of 174 items:
  //
  //   * markdownConverter.js  — `misc.js`'s `markdownProcess` does
  //                             `new Markdown.Converter()`, for any item with a
  //                             `markdowntext` field. 52 items.
  //   * oldschoolrender.js    — `oldSchoolStyleOutlineRender`, for any item that
  //                             arrives as an outline instead of text. 29 items.
  //   * getfeedinfo.js        — every section's title, link and pubDate. All of them.
  const app = createApp({ config });
  const html = await (await app.request('/river')).text();

  for (const include of [
    'markdownConverter.js',
    'feedland/home/oldschoolrender.js',
    'feedland/home/getfeedinfo.js',
  ]) {
    assert.ok(html.includes(include), `/river no longer loads ${include}`);
  }
});

test('the river page fetches nothing from Google', async () => {
  // Dave's page links Ubuntu, Oswald and Rancho; all three style HIS page's title and
  // tagline rather than the river, which inherits whatever the page sets. Dropping
  // them keeps Google off this page entirely, and `lib/headers.js` and /about both
  // now say so — if a font link comes back, those statements quietly become false.
  const app = createApp({ config });
  const html = await (await app.request('/river')).text();
  const csp = (await app.request('/river')).headers.get('content-security-policy');

  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.doesNotMatch(csp, /googleapis|gstatic/);
});

test('the page survives both no-JS and a FeedLand outage', async () => {
  const app = createApp({ config });
  const html = await (await app.request('/river')).text();

  const section = html.match(/<section class="river">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(section, '/river has no river section');

  // riverviewer.js appends into the container and, on a server error, puts up a
  // dismissable dialog — so anything a visitor needs on a bad day has to live OUTSIDE
  // the container, which is now this one paragraph and nothing else. It starts in the
  // HTML rather than being written by the script, because the slow case is exactly
  // the case where the script has not run yet.
  const outside = section
    .replace(/<div\b[^>]*id="idRiverContainer"[\s\S]*?<\/div>/, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/, '');
  assert.doesNotMatch(outside, /idRiverContainer/);
  assert.match(outside, /id="idRiverStatus"/);

  // The onward links are NOT asserted here any more, and that is the change rather
  // than an omission: the standing paragraph that used to carry them is gone, so on
  // an outage they are written into this line by `riverFinished` — see the starter
  // test at the bottom, which is now the only thing covering them.
  assert.match(section, /<noscript>/);
});

test('the river is in the nav and the sitemap', async () => {
  // A page nothing links to is a page nobody visits. Both are one line each and both
  // were forgotten in the first draft of this.
  const app = createApp({ config });

  assert.match(await (await app.request('/about')).text(), /<a href="\/river">/);
  assert.match(await (await app.request('/sitemap.xml')).text(), /<loc>[^<]*\/river<\//);
});

test('/about names the river and the third parties it adds', async () => {
  const app = createApp({ config });
  const html = await (await app.request('/about')).text();

  // The old wording said the homepage was "the only page it happens on". The river
  // makes that false, and the correction has to name the one host that is on neither
  // Dave's stack nor ours.
  assert.doesNotMatch(html, /That is the only page it happens on/);
  assert.match(html, /icons\.duckduckgo\.com/);
  assert.match(html, new RegExp(new URL(FEEDLAND_SERVER).host.replace(/\./g, '\\.')));

  // The parts that are still true have to still be said, or the correction reads as a
  // retreat from a promise that was never broken.
  assert.match(html, /no analytics/i);
  assert.match(html, /no cookies/i);
});

// ── The starter's own logic ────────────────────────────────────────────────────
//
// `public/feedland-river.js` is browser code with no exports, loaded into a `vm`
// realm the same way the blogroll's starter is. `startRiver` runs at the bottom of
// the file, so `document.getElementById` has to answer — returning null makes it take
// its own early exit, which is the behaviour we want while setting up.

async function loadStarter(overrides = {}) {
  const source = await readFile(
    new URL('../public/feedland-river.js', import.meta.url),
    'utf8',
  );
  const realm = createContext({
    document: { getElementById: () => null },
    window: {},
    console: { error: () => {} },
    ...overrides,
  });
  runInContext(source, realm);
  return realm;
}

test('the FeedLand host reaches api.js with the trailing slash it concatenates', async () => {
  // `servercall` builds its URL as `urlServer + path + "?" + params`, a bare
  // concatenation with no separator. Without the slash the request goes to
  // `https://claude.feedland.orggetriverfromopml`, which fails DNS and surfaces as an
  // error about a hostname rather than anything about a URL. The host cannot carry
  // the slash itself — `lib/feedland.js` holds it as an ORIGIN, because a CSP source
  // expression must not have a path.
  const realm = await loadStarter();

  assert.equal(realm.appConsts.urlFeedlandServer, `${FEEDLAND_SERVER}/`);
  assert.equal(realm.withTrailingSlash('https://x.example/'), 'https://x.example/');
  assert.equal(realm.withTrailingSlash('https://x.example'), 'https://x.example/');
});

test('the account-only controls are told there is no account', async () => {
  // `misc.js`'s `userIsSignedIn` branches on this flag. FALSE routes it to the email
  // branch, which finds no `globals.emailMemory` and answers no — which is what makes
  // the like button hide itself and the bookmark button never get built. There is no
  // sign-in on this site and no way to make either of those work.
  const realm = await loadStarter();

  assert.equal(realm.appConsts.flUseTwitterIdentity, false);
  // `globals` has to EXIST, not merely be falsy: `getBookmarkButton` reads
  // `globals.myBookmarksMenu` outside a try, so an undefined global would throw
  // rather than answer "nothing here". Asserted on its shape rather than with
  // `deepEqual` against a literal — this object is built inside the vm realm, so its
  // prototype is not the host realm's `Object.prototype`.
  assert.equal(typeof realm.globals, 'object');
  assert.notEqual(realm.globals, null);
  assert.deepEqual(Object.keys(realm.globals), []);
});

test('a favicon the icon service does not have is hidden, not left broken', async () => {
  // `getUrlIconImage` emits its `<img>` with no `alt`, so a domain DuckDuckGo has no
  // icon for shows the browser's broken-image glyph next to a working row — which
  // reads as our bug. One section of 145 on the day this was written.
  const realm = await loadStarter();

  const listeners = [];
  const container = {
    addEventListener: (type, handler, capture) =>
      listeners.push({ type, handler, capture }),
  };
  realm.watchImages(container);

  // CAPTURE on both, and this is the load-bearing part: neither `load` nor `error`
  // bubbles, so a listener registered the usual way never sees them. riverviewer.js
  // also creates the images long after this runs, so per-image handlers are not
  // available either.
  assert.deepEqual(
    listeners.map((l) => [l.type, l.capture]),
    [
      ['error', true],
      ['load', true],
    ],
  );
  const onError = listeners[0].handler;

  const classesOf = (name) => {
    const classes = new Set(name ? [name] : []);
    return {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      has: (c) => classes.has(c),
    };
  };

  const favicon = { classList: classesOf('imgFavIcon') };
  onError({ target: favicon });
  assert.ok(favicon.classList.has('river-favicon--missing'));

  // An item's own picture failing is the author's business, not ours to hide.
  const postImage = { classList: classesOf(null) };
  onError({ target: postImage });
  assert.ok(!postImage.classList.has('river-favicon--missing'));

  // And a target with no classList at all — a failed <script> or <link> caught on the
  // way down — must not throw inside a listener nothing is catching.
  onError({ target: {} });
});

// ── The height cap ─────────────────────────────────────────────────────────────

/** An item body that reports whatever overflow the test wants. */
function fakeBody({ scrollHeight, clientHeight, classes = [] } = {}) {
  const held = new Set(classes);
  const attrs = {};
  return {
    scrollHeight,
    clientHeight,
    attrs,
    style: {},
    has: (c) => held.has(c),
    setAttribute(name, value) {
      attrs[name] = value;
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    classList: {
      contains: (c) => held.has(c),
      add: (c) => held.add(c),
      toggle(name, on) {
        const next = on === undefined ? !held.has(name) : on;
        if (next) held.add(name);
        else held.delete(name);
        return next;
      },
    },
  };
}

test('only the items that actually overflow are marked as clipped', async () => {
  // The fade is painted from this class, and CSS cannot ask "did this overflow?" —
  // so without the measurement a gradient would sit over every item, promising more
  // text on two-line posts that are already showing in full.
  const realm = await loadStarter();

  const clipped = fakeBody({ scrollHeight: 600, clientHeight: 224 });
  const short = fakeBody({ scrollHeight: 90, clientHeight: 224 });
  // Sub-pixel line heights report a one-pixel overflow on items that are plainly not
  // clipped, which is what the tolerance in `markOneItem` is for.
  const hairline = fakeBody({ scrollHeight: 225, clientHeight: 224 });

  realm.markClippedItems({ querySelectorAll: () => [clipped, short, hairline] });

  assert.equal(clipped.has('river-item--clipped'), true);
  assert.equal(short.has('river-item--clipped'), false);
  assert.equal(hairline.has('river-item--clipped'), false);
});

test('an item re-measures when its own picture finishes loading', async () => {
  // A picture changes the height of the body it sits in and lands AFTER the river has
  // been measured, so an item that only overflows because of its image would never
  // get its fade. The listener re-measures that one body — not all 174.
  const realm = await loadStarter();

  const listeners = [];
  realm.watchImages({
    addEventListener: (type, handler, capture) =>
      listeners.push({ type, handler, capture }),
  });
  const onLoad = listeners.find((l) => l.type === 'load').handler;

  const body = fakeBody({ scrollHeight: 600, clientHeight: 224 });
  onLoad({ target: { closest: (sel) => (sel === '.divRiverItemBody' ? body : null) } });
  assert.equal(body.has('river-item--clipped'), true);

  // An image outside any item body — the section favicons are the real case — must
  // not throw on the way past.
  onLoad({ target: { closest: () => null } });
  onLoad({ target: {} });
});

test('a clipped item is announced and reachable, a short one is not', async () => {
  const realm = await loadStarter();

  const clipped = fakeBody({ scrollHeight: 600, clientHeight: 224 });
  const short = fakeBody({ scrollHeight: 90, clientHeight: 224 });
  realm.markClippedItems({ querySelectorAll: () => [clipped, short] });

  // `tabindex` rather than `role="button"`: the body contains links, and a button
  // may not contain interactive content.
  assert.equal(clipped.attrs.tabindex, '0');
  assert.equal(clipped.attrs['aria-expanded'], 'false');

  // Nothing to open, so nothing in the tab order and nothing announced.
  assert.equal(short.attrs.tabindex, undefined);
  assert.equal(short.attrs['aria-expanded'], undefined);
});

test('an opened item is never re-measured back into "not clipped"', async () => {
  // The trap: with the cap lifted, scrollHeight and clientHeight are equal — so a
  // re-measure would strip `--clipped` off an item the reader had just opened, and
  // with it the ability to close it again. An image finishing its load is enough to
  // trigger that.
  const realm = await loadStarter();

  const open = fakeBody({
    scrollHeight: 600,
    clientHeight: 600,
    classes: ['river-item--clipped', 'river-item--expanded'],
  });
  realm.markClippedItems({ querySelectorAll: () => [open] });

  assert.equal(open.has('river-item--clipped'), true);
});

// ── Expand and collapse ────────────────────────────────────────────────────────

/** The container listeners, plus a body to aim events at. */
async function expander(bodyClasses) {
  const realm = await loadStarter();
  const listeners = [];
  realm.watchExpandClicks({
    addEventListener: (type, handler) => listeners.push({ type, handler }),
  });

  const body = fakeBody({ scrollHeight: 600, clientHeight: 224, classes: bodyClasses });
  const target = (overrides = {}) => ({
    closest: (sel) => (sel === '.divRiverItemBody' ? body : null),
    ...overrides,
  });

  return {
    body,
    target,
    click: (t) => listeners.find((l) => l.type === 'click').handler({ target: t }),
    keydown: (event) => listeners.find((l) => l.type === 'keydown').handler(event),
  };
}

test('clicking a cut-off item opens it, and clicking again closes it', async () => {
  // The bug this replaces: riverviewer.js's own handler expands with a NUMBER (jQuery
  // appends px, it works) and collapses with the STRING "200" (jQuery passes it
  // through, `max-height: 200` is invalid, the browser keeps the expanded value). So
  // its items opened once and stayed open forever.
  const { body, target, click } = await expander(['river-item--clipped']);

  click(target());
  assert.equal(body.has('river-item--expanded'), true);
  assert.equal(body.attrs['aria-expanded'], 'true');

  click(target());
  assert.equal(body.has('river-item--expanded'), false);
  assert.equal(body.attrs['aria-expanded'], 'false');
});

test('the inline max-height riverviewer.js leaves behind is cleared, not fought', async () => {
  // Its handler runs first — bound on the body itself, while ours is on the container
  // in the bubble phase — so by the time we are called it has already written an
  // inline height that its own collapse branch can never remove. Clearing it hands
  // the height back to the stylesheet, which is the only place that knows both states.
  const { body, target, click } = await expander(['river-item--clipped']);
  body.style.maxHeight = '230px';

  click(target());

  assert.equal(body.style.maxHeight, '');
});

test('a click on a link inside an item follows the link rather than toggling', async () => {
  const { body, target, click } = await expander(['river-item--clipped']);

  click(target({ closest: (sel) => (sel === 'a' ? { tag: 'a' } : body) }));

  assert.equal(body.has('river-item--expanded'), false);
});

test('selecting text does not collapse the item under the selection', async () => {
  const realm = await loadStarter({
    window: { getSelection: () => 'a sentence the reader is highlighting' },
  });
  const listeners = [];
  realm.watchExpandClicks({
    addEventListener: (type, handler) => listeners.push({ type, handler }),
  });
  const body = fakeBody({
    scrollHeight: 600,
    clientHeight: 224,
    classes: ['river-item--clipped'],
  });

  listeners[0].handler({
    target: { closest: (sel) => (sel === '.divRiverItemBody' ? body : null) },
  });

  assert.equal(body.has('river-item--expanded'), false);
});

test('an item that does not overflow is inert', async () => {
  // No class, nothing to open — and a click must not add one, or a fully-visible
  // two-line post would collapse itself to 14rem.
  const { body, target, click } = await expander([]);

  click(target());

  assert.equal(body.has('river-item--expanded'), false);
});

test('Enter and Space toggle, but only on the body itself', async () => {
  const { body, target, keydown } = await expander(['river-item--clipped']);
  const prevented = [];
  const key = (k, self) => ({
    key: k,
    target: self ? body : target(),
    preventDefault: () => prevented.push(k),
  });
  // `body` has to answer `closest` too when it IS the target.
  body.closest = (sel) => (sel === '.divRiverItemBody' ? body : null);

  keydown(key('Enter', true));
  assert.equal(body.has('river-item--expanded'), true);
  keydown(key(' ', true));
  assert.equal(body.has('river-item--expanded'), false);
  // Space must not also scroll the page when it was used as the toggle.
  assert.deepEqual(prevented, ['Enter', ' ']);

  // Enter on a LINK inside the body must follow the link, not toggle — the target is
  // the link, not the body.
  keydown(key('Enter', false));
  assert.equal(body.has('river-item--expanded'), false);

  // And an unrelated key changes nothing.
  keydown(key('a', true));
  assert.equal(body.has('river-item--expanded'), false);
});

test('a page without the container is a no-op, not a thrown error', async () => {
  // The shared layout renders every page and only this one has the div. The script is
  // opted into per page, but a missing element must be inert if that ever slips.
  await loadStarter({ document: { getElementById: () => null } });
});

/**
 * Just enough DOM for `riverFinished`, which now builds nodes rather than setting a
 * string. `textOf` walks the children the way a reader would see them, so the
 * assertions below can still be about the sentence rather than about the tree.
 */
function fakeNote() {
  const node = {
    children: [],
    removed: false,
    added: null,
    classList: {
      add(name) {
        node.added = name;
      },
    },
    remove() {
      node.removed = true;
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    // Setting it to '' is how `riverFinished` clears the line first.
    set textContent(value) {
      node.children = value === '' ? [] : [{ tag: '#text', textContent: value }];
    },
    get textContent() {
      return node.children.map((child) => child.textContent).join('');
    },
  };
  node.textContent = 'Loading the river…';
  return node;
}

function fakeDocument(note) {
  return {
    getElementById: () => note,
    createElement: (tag) => ({
      tag,
      attrs: {},
      textContent: '',
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
    }),
    createTextNode: (text) => ({ tag: '#text', textContent: text }),
  };
}

test('the status line is removed on success and rewritten on failure', async () => {
  // riverviewer.js's own error is a Bootstrap dialog someone dismisses — once it is
  // gone the page would be an empty box with no explanation, which reads as our bug
  // rather than as an outage. So the standing line has to say so instead.
  const realm = await loadStarter();

  // The success path also measures the items for the height cap, so the stub has to
  // answer `querySelectorAll` — an empty river is the simplest thing that is true.
  const container = { querySelectorAll: () => [] };

  const ok = fakeNote();
  realm.document = fakeDocument(ok);
  realm.riverFinished(container, undefined);
  assert.equal(ok.removed, true);

  const failed = fakeNote();
  realm.document = fakeDocument(failed);
  realm.riverFinished(container, { message: 'Not found.' });

  assert.equal(failed.removed, false);
  assert.match(failed.textContent, /could not be loaded/);
  assert.equal(failed.added, 'river__status--error');

  // THE POINT OF THIS ASSERTION: real anchors, not the words "member list" sitting in
  // a sentence. This paragraph is the only thing outside the river container now, so
  // if these stop being links a visitor arriving during an outage has nowhere to go —
  // and the page-level test above no longer covers it, deliberately.
  const anchors = failed.children.filter((child) => child.tag === 'a');
  assert.deepEqual(
    anchors.map((a) => a.attrs.href),
    ['/sites', '/subscriptions.opml'],
  );
  for (const anchor of anchors) {
    assert.ok(anchor.textContent.length > 0, `${anchor.attrs.href} has no link text`);
  }
});
