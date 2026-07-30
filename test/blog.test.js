import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { createApp } from '../src/app.js';
import { renderFeed } from '../src/blog/feed.js';
import { createBlog } from '../src/blog/index.js';
import { parseFeed } from '../src/verify/feed.js';

import { parsePost, parsePostFilename } from '../src/blog/parse.js';

test('a bare YYYY-MM-DD.md filename parses to a date with no slug', () => {
  assert.deepEqual(parsePostFilename('2026-07-29.md'), {
    date: '2026-07-29',
    slug: null,
  });
});

test('a -slug suffix parses to a date plus that slug', () => {
  assert.deepEqual(parsePostFilename('2026-07-29-a-second-one.md'), {
    date: '2026-07-29',
    slug: 'a-second-one',
  });
});

test('a filename that is not a dated post is not a post', () => {
  assert.equal(parsePostFilename('README.md'), null);
  assert.equal(parsePostFilename('2026-07-29.md.swp'), null);
  assert.equal(parsePostFilename('2026-7-9.md'), null);
});

test('a post with no frontmatter keeps its whole body as markdown and has no title', () => {
  const post = parsePost({
    filename: '2026-07-29.md',
    source: 'Just a [link](https://example.com/) & a note.\n',
  });

  assert.equal(post.title, null);
  assert.equal(post.markdown, 'Just a [link](https://example.com/) & a note.');
  assert.match(post.html, /<a href="https:\/\/example\.com\/">link<\/a>/);
  assert.equal(post.path, '/blog/2026/07/29');
});

test('a frontmatter title is read and kept out of the body', () => {
  const post = parsePost({
    filename: '2026-07-30-why-rss.md',
    source: '---\ntitle: Why RSS still wins\n---\nBody text.\n',
  });

  assert.equal(post.title, 'Why RSS still wins');
  assert.equal(post.markdown, 'Body text.');
  assert.doesNotMatch(post.html, /title:/);
  assert.equal(post.path, '/blog/2026/07/30/why-rss');
});

test('pubDate defaults to midday UTC, not midnight', () => {
  // §6.4: midnight UTC puts an evening US-Central post on the *previous* day for
  // readers. Midday is the timestamp that reads as the right date on both sides
  // of the Atlantic.
  const post = parsePost({ filename: '2026-07-29.md', source: 'Hi.\n' });

  assert.equal(post.pubDate.toISOString(), '2026-07-29T12:00:00.000Z');
});

test('a time: frontmatter key sets the time of day, and a title is still optional', () => {
  const post = parsePost({
    filename: '2026-07-29.md',
    source: '---\ntime: 21:45\n---\nEvening note.\n',
  });

  assert.equal(post.pubDate.toISOString(), '2026-07-29T21:45:00.000Z');
  // Frontmatter present, title absent: untitled is a shape, not a parse failure.
  assert.equal(post.title, null);
  assert.equal(post.markdown, 'Evening note.');
});

/** A throwaway `content/` directory holding the given `{filename: source}` files. */
async function contentDir(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'iheartrss-blog-'));
  for (const [name, source] of Object.entries(files)) {
    await writeFile(path.join(dir, name), source);
  }
  return dir;
}

test('the loader lists posts newest first and skips non-post files', async () => {
  const dir = await contentDir({
    '2026-07-28.md': 'Older.\n',
    '2026-07-30.md': '---\ntitle: Newest\n---\nNewest.\n',
    '2026-07-29.md': 'Middle.\n',
    'README.md': 'Not a post.\n',
  });

  const blog = createBlog({ dir });

  assert.deepEqual(
    blog.posts().map((p) => p.date),
    ['2026-07-30', '2026-07-29', '2026-07-28'],
  );
});

test('the poll notices an EDIT to an existing file, not just an added one', async () => {
  // §6.4's measured failure: adding or deleting a file bumps the DIRECTORY mtime,
  // but editing one does not. A directory-mtime poll therefore publishes new posts
  // fine and silently refuses to show a typo fix until the container restarts.
  const dir = await contentDir({ '2026-07-29.md': 'Teh original.\n' });
  const blog = createBlog({ dir, pollMs: 0 });

  assert.match(blog.posts()[0].html, /Teh original/);

  const before = statSync(dir).mtimeMs;
  await writeFile(path.join(dir, '2026-07-29.md'), 'The correction.\n');
  // Guard against the environment making this test pass for the wrong reason: if
  // the edit did bump the directory mtime, the assertion below proves nothing.
  assert.equal(statSync(dir).mtimeMs, before);

  assert.match(blog.posts()[0].html, /The correction/);
});

test('two posts on one date get distinct URLs and a defined order', async () => {
  const dir = await contentDir({
    '2026-07-29.md': '---\ntime: 08:00\n---\nMorning.\n',
    '2026-07-29-afternoon.md': '---\ntime: 16:00\n---\nAfternoon.\n',
  });

  const posts = createBlog({ dir }).posts();

  assert.deepEqual(
    posts.map((p) => p.path),
    ['/blog/2026/07/29/afternoon', '/blog/2026/07/29'],
  );
  assert.ok(posts[0].pubDate > posts[1].pubDate);
});

test('same-date, same-time posts are ordered by filename rather than by readdir', async () => {
  const dir = await contentDir({
    '2026-07-29-alpha.md': 'Alpha.\n',
    '2026-07-29-beta.md': 'Beta.\n',
  });

  const first = createBlog({ dir }).posts().map((p) => p.slug);
  assert.deepEqual(first, ['beta', 'alpha']);
});

const config = {
  siteUrl: 'https://iheartrss.com/',
  linkbackHosts: ['iheartrss.com', 'www.iheartrss.com'],
};

/** The `<item>` blocks of a feed document, in order. */
function items(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
}

test('an untitled post is a feed item with a description and NO title', () => {
  // §6.4: RSS 2.0 requires only that one of title/description is present, so an
  // untitled post is a *correct* item, not a fallback. Emitting an empty or
  // invented <title> instead is what this asserts we do not do.
  const post = parsePost({ filename: '2026-07-29.md', source: 'A linkblog note.\n' });
  const xml = renderFeed({ config, posts: [post] });

  const [item] = items(xml);
  assert.doesNotMatch(item, /<title>/);
  assert.match(item, /<description>[\s\S]*A linkblog note/);
  assert.match(
    item,
    /<guid isPermaLink="true">https:\/\/iheartrss\.com\/blog\/2026\/07\/29<\/guid>/,
  );
});

test('a titled post keeps its title, and HTML in the body is entity-encoded', () => {
  const post = parsePost({
    filename: '2026-07-30-why-rss.md',
    source: '---\ntitle: RSS & you\n---\nA <em>note</em> about 5 > 3.\n',
  });
  const xml = renderFeed({ config, posts: [post] });
  const [item] = items(xml);

  assert.match(item, /<title>RSS &amp; you<\/title>/);
  // §6.4: marked output and raw markdown both routinely contain <, > and &, so
  // both elements are entity-encoded. One raw angle bracket here makes the whole
  // document non-well-formed for every subscriber.
  assert.match(item, /<description>[\s\S]*&lt;em&gt;note&lt;\/em&gt;/);
  assert.match(item, /<source:markdown>[\s\S]*&lt;em&gt;note&lt;\/em&gt;/);
  assert.doesNotMatch(item.replace(/<\/?(title|link|guid|pubDate|description|source:markdown)[^>]*>/g, ''), /<em>/);
});

test('the feed lists posts newest first with RFC 822 pubDates', async () => {
  const dir = await contentDir({
    '2026-07-28.md': 'Older.\n',
    '2026-07-30.md': 'Newer.\n',
  });
  const xml = renderFeed({ config, posts: createBlog({ dir }).posts() });

  assert.deepEqual(
    items(xml).map((item) => /<pubDate>([^<]+)<\/pubDate>/.exec(item)[1]),
    ['Thu, 30 Jul 2026 12:00:00 GMT', 'Tue, 28 Jul 2026 12:00:00 GMT'],
  );
});

test('/feed.xml with real posts passes OUR OWN validator, source namespace and all', async () => {
  // §11: if we ever break our own feed, this test fails. We reject other people's
  // feeds for a living, so ours goes through the very same gate.
  const dir = await contentDir({
    '2026-07-29.md': 'A note with an & and a <tag> in it.\n',
    '2026-07-30-why-rss.md': '---\ntitle: Why RSS\n---\n# Heading\n\nBody.\n',
  });
  const app = createApp({ config, blog: createBlog({ dir }) });

  const res = await app.request('/feed.xml');
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get('content-type') ?? '',
    /application\/rss\+xml; charset=utf-8/,
  );

  const xml = await res.text();
  assert.equal(items(xml).length, 2, 'both posts should reach the feed');

  const parsed = parseFeed(xml);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.features.has_source_ns, true);
  assert.equal(parsed.features.source_ns_prefix, 'source');
});

test('GET /blog lists every post, newest first, linking each permalink', async () => {
  const dir = await contentDir({
    '2026-07-28.md': 'An untitled note.\n',
    '2026-07-30-why-rss.md': '---\ntitle: Why RSS\n---\nBody.\n',
  });
  const app = createApp({ config, blog: createBlog({ dir }) });

  const res = await app.request('/blog');
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(
    html.indexOf('/blog/2026/07/30/why-rss') < html.indexOf('/blog/2026/07/28'),
    'newest post should come first',
  );
  assert.match(html, /Why RSS/);
  // An untitled post is headed by its formatted date (§6.4), so the index has to
  // give it something to click.
  assert.match(html, /28 July 2026|July 28, 2026/);
});

test('a permalink resolves with and without a slug', async () => {
  // §6: `:slug?` is the Hono spelling. Express-5's `{/:slug}?` registers fine and
  // then throws `undefined is not iterable` at request time, so both shapes have to
  // be exercised over HTTP, not just in the parser.
  const dir = await contentDir({
    '2026-07-29.md': 'An untitled note about feeds.\n',
    '2026-07-29-a-second-one.md': '---\ntitle: A second one\n---\nTwo in a day.\n',
  });
  const app = createApp({ config, blog: createBlog({ dir }) });

  const bare = await app.request('/blog/2026/07/29');
  assert.equal(bare.status, 200);
  assert.match(await bare.text(), /An untitled note about feeds/);

  const slugged = await app.request('/blog/2026/07/29/a-second-one');
  assert.equal(slugged.status, 200);
  assert.match(await slugged.text(), /Two in a day/);
});

test('a post that does not exist is the templated 404, not a crash', async () => {
  const app = createApp({ config, blog: createBlog({ dir: await contentDir({}) }) });

  const res = await app.request('/blog/2026/07/99');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
});

test('a traversal attempt in the slug is a 404, never a file read', async () => {
  // §6: route params arrive percent-DECODED, so `%2e%2e%2f` is `../` by the time a
  // handler sees it. Resolution is an index lookup precisely so there is no joined
  // path for it to escape from.
  const dir = await contentDir({ '2026-07-29.md': 'Safe.\n' });
  const app = createApp({ config, blog: createBlog({ dir }) });

  for (const attempt of [
    '/blog/2026/07/29/..%2f..%2f..%2fdata%2fiheartrss.db',
    '/blog/2026/07/29/%2e%2e%2f%2e%2e%2fpackage.json',
    '/blog/2026/07/29/../../../etc/passwd',
  ]) {
    const res = await app.request(attempt);
    assert.equal(res.status, 404, attempt);
    const body = await res.text();
    assert.doesNotMatch(body, /SQLite format|"packageManager"|root:/);
  }
});

test('/sitemap.xml is well-formed and lists the static pages and every post', async () => {
  const dir = await contentDir({
    '2026-07-29.md': 'A note.\n',
    '2026-07-30-why-rss.md': '---\ntitle: Why RSS\n---\nBody.\n',
  });
  const app = createApp({ config, blog: createBlog({ dir }) });

  const res = await app.request('/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /(application|text)\/xml/);

  const xml = await res.text();
  assert.equal(XMLValidator.validate(xml), true);

  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const expected of [
    'https://iheartrss.com/',
    'https://iheartrss.com/blog',
    'https://iheartrss.com/sites',
    'https://iheartrss.com/blog/2026/07/29',
    'https://iheartrss.com/blog/2026/07/30/why-rss',
  ]) {
    assert.ok(locs.includes(expected), `sitemap should list ${expected}`);
  }

  // §6's robots.txt disallows these; advertising them in the sitemap would be
  // telling crawlers to fetch exactly what we just told them not to.
  for (const forbidden of locs) {
    assert.doesNotMatch(forbidden, /\/(admin|check|recheck|status)\b/);
  }
});

test('robots.txt points at the sitemap now that one exists', async () => {
  const app = createApp({ config });
  const res = await app.request('/robots.txt');

  assert.match(await res.text(), /^Sitemap: https:\/\/iheartrss\.com\/sitemap\.xml$/m);
});

test('/rss.xml is a 301 to /feed.xml, because people will guess it', async () => {
  const res = await createApp({ config }).request('/rss.xml');

  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/feed.xml');
});

test('the homepage carries the latest post inline and only the latest', async () => {
  // §6: the homepage shows "the latest blog post inline" — it gives the page
  // something to say before §10's reader lands.
  const dir = await contentDir({
    '2026-07-28.md': 'An older note nobody should see on the homepage.\n',
    '2026-07-30-why-rss.md': '---\ntitle: Why RSS\n---\nThe newest thing we wrote.\n',
  });
  const app = createApp({ config, blog: createBlog({ dir }) });

  const html = await (await app.request('/')).text();

  assert.match(html, /The newest thing we wrote/);
  assert.match(html, /\/blog\/2026\/07\/30\/why-rss/);
  assert.doesNotMatch(html, /An older note nobody should see/);
});

test('a homepage with no posts at all says nothing about the blog', async () => {
  const html = await (await createApp({ config }).request('/')).text();

  assert.doesNotMatch(html, /Latest post/i);
});

test('<source:markdown> round-trips the source text, newlines and all', async () => {
  // The point of source:markdown is that a reader can render the SOURCE. Passing it
  // through the attribute-value filter — which normalises every newline to a space,
  // correctly, for attributes — silently turns a fenced code block and a bulleted
  // list into one unparseable line.
  const source = ['# Heading', '', '- one', '- two', '', '```', 'code & <tags>', '```', ''].join('\n');
  const post = parsePost({ filename: '2026-07-29.md', source });

  const xml = renderFeed({ config, posts: [post] });
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    htmlEntities: true,
  }).parse(xml);

  assert.equal(parsed.rss.channel.item['source:markdown'], post.markdown);
});

test('a lone surrogate or a control character in a post still yields a well-formed feed', () => {
  // The newline-preserving filter must not have lost the other half of the job: a
  // lone surrogate is not a legal XML 1.0 character at all, and one in our own feed
  // breaks it for every subscriber.
  const post = parsePost({
    filename: '2026-07-29.md',
    source: `---\ntitle: Broken \uD800 title\n---\nBody \uD800 with a half pair \u0007 too.\n`,
  });

  const xml = renderFeed({ config, posts: [post] });

  assert.equal(XMLValidator.validate(xml), true);
  assert.doesNotMatch(xml, /[\uD800-\uDFFF]/);
  assert.doesNotMatch(xml, /\u0007/);
  // The legal characters around them survive.
  assert.match(xml, /Body\s+with a half pair\s+too/);
});
