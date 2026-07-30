import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parsePage, findLinkBack } from '../src/verify/page.js';

const LINKBACK_HOSTS = ['iheartrss.com', 'www.iheartrss.com'];

// Plan §5 Step 2 (feed discovery, ordered scoring) and Step 5 (link-back), per
// §11's `page.test.js`.

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('picks the WordPress `/feed/` candidate over the comments and podcast feeds', () => {
  // Real wordpress.org/news `<head>`: `/news/feed/` (canonical, trailing slash),
  // `/news/comments/feed/` (comments) and `/news/feed/podcast`.
  const page = parsePage(fixture('wordpress-news.html'), 'https://wordpress.org/news/');

  assert.equal(page.feedUrl, 'https://wordpress.org/news/feed/');
});

test('collects Atom and JSON-feed candidates separately so the refusal can name them', () => {
  // §5 Step 2: without this bucket an Atom-only site gets `no_feed_link` — "we
  // couldn't find an RSS feed link" — while staring at its own `<link
  // rel="alternate" type="application/atom+xml">`.
  const html = `<html><head>
    <link rel="alternate" type="application/atom+xml" href="/atom.xml">
    <link rel="alternate" type="application/feed+json" href="/feed.json">
  </head><body></body></html>`;

  const page = parsePage(html, 'https://jekyll.example/');

  assert.deepEqual(page.rssCandidates, []);
  assert.deepEqual(
    page.otherFormatCandidates.map((c) => c.url),
    ['https://jekyll.example/atom.xml', 'https://jekyll.example/feed.json'],
  );
});

test('resolves a relative href against `<base href>`, not the document URL', () => {
  const html = `<html><head>
    <base href="https://cdn.example/blog/">
    <link rel="alternate" type="application/rss+xml" href="feed.xml">
  </head><body></body></html>`;

  const page = parsePage(html, 'https://origin.example/some/page.html');

  assert.equal(page.baseUrl, 'https://cdn.example/blog/');
  assert.equal(page.feedUrl, 'https://cdn.example/blog/feed.xml');
});

test('accepts `rel` containing alternate or absent, and refuses any other rel', () => {
  // §5 Step 2: rssboard.org requires `rel="alternate"` exactly; accepting a
  // missing `rel` is a deliberate, recorded leniency.
  const accepted = `<html><head>
    <link rel="ALTERNATE HOME" type="application/rss+xml" href="/a.xml">
    <link type="application/rss+xml" href="/b.xml">
  </head></html>`;
  assert.deepEqual(
    parsePage(accepted, 'https://x.example/').rssCandidates.map((c) => c.url),
    ['https://x.example/a.xml', 'https://x.example/b.xml'],
  );

  const refused = `<html><head>
    <link rel="stylesheet" type="application/rss+xml" href="/c.xml">
  </head></html>`;
  assert.deepEqual(parsePage(refused, 'https://x.example/').rssCandidates, []);
});

test('finds a link-back from an `<a href>`, text or image, relative or absolute', () => {
  const html = `<html><body>
    <p>Proud member of <a href="//www.iheartrss.com/">the ring</a>.</p>
  </body></html>`;

  assert.equal(
    findLinkBack(html, 'https://example.com/blog/', LINKBACK_HOSTS),
    'https://www.iheartrss.com/',
  );
});

test('a mention inside a `<code>` block or an HTML comment is not a link-back', () => {
  // §5 Step 5's rejected alternative: substring-searching the raw HTML matches the
  // URL sitting in a `<code>` block or a comment, which lets people list without
  // actually linking.
  const html = `<html><body>
    <p>Paste this: <code>&lt;a href="https://iheartrss.com/"&gt;I &hearts; RSS&lt;/a&gt;</code></p>
    <pre><code>&lt;a href="https://iheartrss.com/"&gt;badge&lt;/a&gt;</code></pre>
    <!-- <a href="https://iheartrss.com/">I love RSS</a> -->
    <p>I read about iheartrss.com somewhere.</p>
    <a href="https://example.net/">an unrelated link</a>
  </body></html>`;

  assert.equal(findLinkBack(html, 'https://example.com/', LINKBACK_HOSTS), null);
});

test('scores penalise category/tag/author feeds and tiebreak on the shorter path', () => {
  // §5 Step 2's table. Two candidates both matching the path pattern (+3) fall through to
  // the shortest-path tiebreak, which is the manton.org shape (`/feed.xml` + a second
  // feed); the author feed loses on its title alone even though its path also scores.
  // The titles are WordPress's own generated forms: "%1$s » %2$s Category Feed" and
  // "%1$s » %2$s Tag Feed".
  const html = `<html><head>
    <link rel="alternate" type="application/rss+xml" title="A blog &raquo; Rust Tag Feed" href="/tag/rust/feed/">
    <link rel="alternate" type="application/rss+xml" title="A blog &raquo; News Category Feed" href="/category/news/feed/">
    <link rel="alternate" type="application/rss+xml" title="A blog &raquo; Feed" href="/blog/feed/">
    <link rel="alternate" type="application/rss+xml" title="A blog &raquo; Feed" href="/feed/">
  </head></html>`;

  const { rssCandidates } = parsePage(html, 'https://scored.example/');

  assert.deepEqual(
    rssCandidates.map((c) => [c.url, c.score]),
    [
      // +3 each; the shorter path wins the tiebreak — this is the manton.org shape.
      ['https://scored.example/feed/', 3],
      ['https://scored.example/blog/feed/', 3],
      // +3 −2 each, and again the shorter path breaks the tie.
      ['https://scored.example/tag/rust/feed/', 1],
      ['https://scored.example/category/news/feed/', 1],
    ],
  );
});
