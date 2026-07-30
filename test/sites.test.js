/**
 * `/sites` — plan §6's "human-readable view of what's in the OPML. A verification
 * and transparency page, not a discovery surface", under §6.3's layout rules.
 *
 * The seam is the rendered page via `app.request`, because every rule §6.3 states is
 * about the markup that reaches a phone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db/index.js';

const config = { siteUrl: 'https://iheartrss.com/' };

function member(overrides = {}) {
  const n = overrides.n ?? 1;
  return {
    url: `https://member${n}.example/`,
    submitted_url: `https://member${n}.example/`,
    host: `member${n}.example`,
    path: '/',
    feed_url: `https://member${n}.example/rss.xml`,
    title: `Member ${n}`,
    description: undefined,
    has_source_ns: false,
    has_rsscloud: false,
    rsscloud_style: undefined,
    cloud_json: undefined,
    ...overrides,
  };
}

function withApp() {
  const { db, queries } = createDb(':memory:');

  return {
    db,
    queries,
    app: createApp({ config, db, queries }),
    /** Phase 8 owns `status`; here it is test set-up. */
    setStatus: (id, status) =>
      db.prepare('UPDATE sites SET status = ? WHERE id = ?').run(status, id),
    /** `insertSite` stamps `now`, so ordering needs the clock set explicitly. */
    setCreatedAt: (id, at) =>
      db.prepare('UPDATE sites SET created_at = ? WHERE id = ?').run(at, id),
  };
}

test('GET /sites lists every member newest first, on one page', async () => {
  const { app, queries, setCreatedAt } = withApp();

  const oldest = queries.insertSite(member({ n: 1, title: 'Oldest' }));
  const middle = queries.insertSite(member({ n: 2, title: 'Middle' }));
  const newest = queries.insertSite(member({ n: 3, title: 'Newest' }));
  setCreatedAt(oldest, '2026-01-01T00:00:00.000Z');
  setCreatedAt(middle, '2026-04-01T00:00:00.000Z');
  setCreatedAt(newest, '2026-07-01T00:00:00.000Z');

  const res = await app.request('/sites');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);

  const html = await res.text();

  // §6.3: "All members on one page, newest first." Not the OPML's title order.
  const order = ['Newest', 'Middle', 'Oldest'].map((title) => html.indexOf(title));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'members must appear in created_at DESC order',
  );

  // §6.3: "Why /sites has no pagination" — no pagination UI to make responsive.
  assert.doesNotMatch(html, /rel="next"/);
  assert.doesNotMatch(html, /\?page=/);
});

test('/sites is a reflowing list, never a <table>', async () => {
  const { app, queries } = withApp();
  queries.insertSite(member({ n: 1 }));

  const html = await (await app.request('/sites')).text();

  // §6.3: "Tables are the single most common mobile failure, and this one carries a
  // title, host, two-to-four badges and a date."
  assert.doesNotMatch(html, /<table/i);
  assert.doesNotMatch(html, /<t[dhr]\b/i);
  assert.match(html, /<ul class="site-list"/);
  assert.match(html, /<li class="site"/);
});

test('each member carries the #site-<id> anchor the submit panel deep-links to', async () => {
  const { app, queries } = withApp();
  const id = queries.insertSite(member({ n: 1 }));

  const html = await (await app.request('/sites')).text();

  // §6.3: "the /sites#site-<id> deep link from the submit success panel always
  // resolves (with pagination it could point at a row on page 4)".
  assert.match(html, new RegExp(`id="site-${id}"`));
});

test('/sites badges the four states §6 names, and explains them in a legend', async () => {
  const { app, queries, setStatus } = withApp();

  queries.insertSite(member({ n: 1, title: 'Plain' }));
  queries.insertSite(member({ n: 2, title: 'Source NS', has_source_ns: true }));
  queries.insertSite(
    member({ n: 3, title: 'Cloudy', has_rsscloud: true, rsscloud_style: 'element' }),
  );
  const failing = queries.insertSite(member({ n: 4, title: 'Wobbly' }));
  const blocked = queries.insertSite(member({ n: 5, title: 'Walled' }));
  setStatus(failing, 'failing');
  setStatus(blocked, 'blocked');

  const html = await (await app.request('/sites')).text();

  // §6: "Badges for source-ns, rsscloud, `failing` and `blocked`."
  assert.match(html, /class="badge badge--source-ns"/);
  assert.match(html, /class="badge badge--rsscloud"/);
  assert.match(html, /class="badge badge--failing"/);
  assert.match(html, /class="badge badge--blocked"/);

  // §6.3: "a legend explaining what the source-ns and rssCloud badges mean — nobody
  // arrives knowing that."
  assert.match(html, /<(dl|section)[^>]*class="[^"]*legend/);
  assert.match(html, /source\.scripting\.com/);
  assert.match(html, /rssCloud/i);
  // §7/§8: bot-blocked members stay listed on purpose, and the page has to say why.
  assert.match(html, /bot protection|blocked us|403/i);

  // A plain member gets no state badge at all.
  const plainRow = html.slice(html.indexOf('Plain'), html.indexOf('Plain') + 400);
  assert.doesNotMatch(plainRow, /badge--failing/);
});

test('/sites omits dropped, removed and hidden members', async () => {
  const { app, queries, setStatus } = withApp();

  queries.insertSite(member({ n: 1, title: 'Listed' }));
  setStatus(queries.insertSite(member({ n: 2, title: 'Dropped' })), 'dropped');
  setStatus(queries.insertSite(member({ n: 3, title: 'Removed' })), 'removed');
  setStatus(queries.insertSite(member({ n: 4, title: 'Hidden' })), 'hidden');

  const html = await (await app.request('/sites')).text();

  assert.match(html, /Listed/);
  for (const gone of ['Dropped', 'Removed', 'Hidden']) {
    assert.doesNotMatch(html, new RegExp(gone), `${gone} must not be listed`);
  }
  // §6: "/sites deliberately omits dropped/removed/hidden, so the page they'd check
  // shows nothing" — hence the link to /status, the only way to ask why.
  assert.match(html, /href="\/status/);
});

test('a banned host is excluded from /sites by the same backstop as the OPML', async () => {
  const { app, queries, db } = withApp();

  queries.insertSite(member({ n: 1, title: 'Innocent' }));
  queries.insertSite(
    member({
      n: 2,
      title: 'Spammer',
      url: 'https://spam.example/',
      submitted_url: 'https://spam.example/',
      host: 'spam.example',
      feed_url: 'https://spam.example/rss.xml',
    }),
  );
  db.prepare(
    'INSERT INTO banned_hosts (host, host_suffix, path_prefix, reason, created_at)' +
      " VALUES ('spam.example', '', '', 'spam', '2026-07-29T00:00:00.000Z')",
  ).run();

  const html = await (await app.request('/sites')).text();

  assert.match(html, /Innocent/);
  assert.doesNotMatch(html, /Spammer/);
});

test('a hostile title is escaped and truncated at render', async () => {
  const { app, queries } = withApp();

  queries.insertSite(
    member({
      n: 1,
      title: '<img src=x onerror=alert(1)>' + 'A'.repeat(1024 * 1024),
      description: '"><script>alert(2)</script>',
    }),
  );

  const html = await (await app.request('/sites')).text();

  // §7: "Truncate/normalise hostile titles at render as well as ingest" — the same
  // 1 MB title that bloats the OPML "wrecks /sites layout for everyone".
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.equal(html.includes('A'.repeat(300)), false);
});

test('the OPML is offered from /sites, since that is what the page describes', async () => {
  const { app } = withApp();
  const html = await (await app.request('/sites')).text();

  assert.match(html, /href="\/subscriptions\.opml"/);
});

// ── The member count (§12 phase 6: "wire the real sites count") ─────────────────

test('/healthz reports the real member count', async () => {
  const { app, queries, setStatus } = withApp();

  queries.insertSite(member({ n: 1 }));
  setStatus(queries.insertSite(member({ n: 2 })), 'blocked');
  setStatus(queries.insertSite(member({ n: 3 })), 'hidden');

  const body = await (await app.request('/healthz')).json();

  // §6: `{ ok, sites, lastRevalidation }`. `blocked` counts (it is listed);
  // `hidden` does not.
  assert.equal(body.ok, true);
  assert.equal(body.sites, 2);
  // Phase 8a owns the scheduler, so there is nothing to report yet — but the key
  // exists, because Docker's healthcheck and §9's monitoring read this shape.
  assert.equal('lastRevalidation' in body, true);
});

test('the homepage shows the real member count', async () => {
  const { app, queries } = withApp();
  queries.insertSite(member({ n: 1 }));
  queries.insertSite(member({ n: 2 }));
  queries.insertSite(member({ n: 3 }));

  const html = await (await app.request('/')).text();

  // §6: the homepage carries "a single member count" and no member list.
  assert.match(html, /3 members/);
  assert.match(html, /href="\/sites"/);
});
