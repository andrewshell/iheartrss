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

  const first = createBlog({ dir })
    .posts()
    .map((p) => p.slug);
  assert.deepEqual(first, ['beta', 'alpha']);
});

const config = {
  siteUrl: 'https://iheartrss.com/',
  linkbackHosts: ['iheartrss.com', 'www.iheartrss.com'],
  rsscloudDomain: 'rpc.rsscloud.io',
  rsscloudPort: 80,
  rsscloudPath: '/pleaseNotify',
  rsscloudProtocol: 'http-post',
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
  assert.doesNotMatch(
    item.replace(/<\/?(title|link|guid|pubDate|description|source:markdown)[^>]*>/g, ''),
    /<em>/,
  );
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

test('the channel carries its own pubDate, dated by the newest post', async () => {
  // The symptom that found this: our feed's section in the river printed a literal
  // "[ no date ]" beside its title. FeedLand stores a feed's CHANNEL-level pubDate
  // and riverviewer.js renders it there; ours had no such element, so the record
  // FeedLand held for us had no `pubDate` key at all.
  const dir = await contentDir({
    '2026-07-28.md': 'Older.\n',
    '2026-07-30.md': 'Newer.\n',
  });
  const xml = renderFeed({ config, posts: createBlog({ dir }).posts() });

  // Scoped to the channel: `items()` strips the item elements, so this cannot pass
  // by accidentally matching an item's own pubDate.
  const channelOnly = xml.replace(/<item>[\s\S]*<\/item>/, '');
  assert.match(channelOnly, /<pubDate>Thu, 30 Jul 2026 12:00:00 GMT<\/pubDate>/);
});

test('re-rendering an unchanged blog produces byte-identical feeds', async () => {
  // The reason the channel pubDate is the newest POST's date and not the render
  // time. `renderFeed` runs per request, so a build-time stamp would change these
  // bytes on every fetch — no conditional request could ever hit, and every rssCloud
  // subscriber we advertise `<cloud>` to would see the channel change on each poll.
  const dir = await contentDir({ '2026-07-30.md': 'Stable.\n' });
  const blog = createBlog({ dir });

  assert.equal(
    renderFeed({ config, posts: blog.posts() }),
    renderFeed({ config, posts: blog.posts() }),
  );
});

test('a feed with no posts omits the channel pubDate rather than inventing one', () => {
  // A zero-item channel is valid and phase 1 shipped exactly that, so a site with no
  // content/ directory must not start emitting a date for content it does not have.
  const xml = renderFeed({ config, posts: [] });

  assert.doesNotMatch(xml, /<pubDate>/);
  assert.equal(parseFeed(xml).ok, true);
});

test('every real post links absolutely, because a feed reader is not on our origin', () => {
  // THE ONLY TEST HERE THAT READS THE ACTUAL content/ DIRECTORY, and it has to.
  // Every other test in this file builds a fixture and checks the machinery; this one
  // checks the posts themselves, because the mistake it catches is made in prose, not
  // in code.
  //
  // A relative `/subscriptions.opml` is correct on our own pages and broken the
  // moment the post is read anywhere else: RSS does not define a base for the HTML
  // inside `<description>`, so a reader resolves it against its own origin, its own
  // domain, or nothing at all. The generous ones use the item's `<link>`; plenty do
  // not. The link 404s in somebody else's app and we never hear about it.
  //
  // The fix is absolute URLs in the markdown rather than rewriting at render time,
  // so that `<description>` and `<source:markdown>` say the same thing — and because
  // rewriting markdown means parsing around fenced code blocks, one of which is full
  // of paths that must NOT become links.
  const posts = createBlog({ dir: 'content' }).posts();
  assert.ok(posts.length > 0, 'no posts found — is the content directory there?');

  const offenders = [];
  for (const post of posts) {
    for (const [, url] of post.html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      // A scheme, a protocol-relative URL, or a same-page fragment are all fine.
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
      if (url.startsWith('//') || url.startsWith('#')) continue;
      offenders.push(`${post.filename}: ${url}`);
    }
  }

  assert.deepEqual(offenders, [], `relative URLs will break in a feed reader`);
});

test('the channel carries an image, with the three sub-elements the spec requires', () => {
  // RSS 2.0: `<url>`, `<title>` and `<link>` are required; `<width>`/`<height>`/
  // `<description>` are optional. The spec also says the image's title and link
  // "should have the same value as the channel's" — which is why they come from one
  // constant rather than being typed twice.
  const xml = renderFeed({ config, posts: [] });
  const { channel } = new XMLParser({ parseTagValue: false }).parse(xml).rss;

  assert.deepEqual(channel.image, {
    url: 'https://iheartrss.com/apple-touch-icon.png',
    title: 'I ♥ RSS',
    link: 'https://iheartrss.com/',
    description: 'A directory for people who love RSS.',
  });
  assert.equal(channel.image.title, channel.title);
  assert.equal(channel.image.link, channel.link);
});

test('the channel image declares no width or height rather than a wrong one', () => {
  // The file is 180x180 and the spec's maximum width is 144 (default 88). Declaring
  // 180 states a width the spec forbids; declaring 144 states one the file does not
  // have. Saying nothing is the only option that is not false, and it is what
  // scripting.com does.
  const xml = renderFeed({ config, posts: [] });

  assert.doesNotMatch(xml, /<width>/);
  assert.doesNotMatch(xml, /<height>/);
});

test("the channel image's URL is built from this deployment's own origin", () => {
  // Same reasoning as every other absolute URL in the feed: a hardcoded
  // iheartrss.com would be right in production and quietly wrong everywhere else.
  const xml = renderFeed({
    config: { ...config, siteUrl: 'https://ring.example.test/' },
    posts: [],
  });

  assert.match(xml, /<url>https:\/\/ring\.example\.test\/apple-touch-icon\.png<\/url>/);
});

test('the file the channel image names is served so other origins may load it', async () => {
  // THE HALF THAT IS EASY TO FORGET. A channel image is hotlinked by definition, and
  // the site-wide default is `Cross-Origin-Resource-Policy: same-origin` — under
  // which every browser-based reader is refused the image by its own browser, with
  // nothing in our logs to show for it. This asserts the element and the header agree.
  const app = createApp({ config });
  const xml = await (await app.request('/feed.xml')).text();
  const url = /<image>[\s\S]*?<url>([^<]+)<\/url>/.exec(xml)[1];

  const res = await app.request(new URL(url).pathname);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
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
  // §6.4: we now run against an rssCloud server, so our own feed carries both forms
  // — and the detector that awards other people the badge has to award it to us.
  assert.equal(parsed.features.has_rsscloud, true);
  assert.equal(parsed.features.rsscloud_style, 'both');
  assert.deepEqual(parsed.features.cloud, {
    domain: 'rpc.rsscloud.io',
    port: '80',
    path: '/pleaseNotify',
    registerProcedure: '',
    protocol: 'http-post',
  });
  assert.equal(parsed.features.cloud_url, 'https://rpc.rsscloud.io/pleaseNotify');
});

test('the channel advertises the rssCloud server in both forms', () => {
  // §6.4: `<cloud>` for every rssCloud client that ever shipped, and
  // `<source:cloud>` because it is the element we detect on other people's feeds.
  // The five attributes are the ones the RSS spec requires; `registerProcedure` is
  // present but empty, which is what http-post asks for.
  const xml = renderFeed({ config, posts: [] });
  const { channel } = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
  }).parse(xml).rss;

  assert.deepEqual(channel.cloud, {
    '@_domain': 'rpc.rsscloud.io',
    '@_port': '80',
    '@_path': '/pleaseNotify',
    '@_registerProcedure': '',
    '@_protocol': 'http-post',
  });
  assert.equal(channel['source:cloud'], 'https://rpc.rsscloud.io/pleaseNotify');
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

test('the homepage carries NO post body, however many there are', async () => {
  // §10: the homepage used to render the latest post in full. It was there to give
  // the page something to say before the feed reader landed — but the reader is the
  // point of this page, and a whole post above it is just distance. Posts live on
  // /blog now; the homepage does not repeat them.
  const dir = await contentDir({
    '2026-07-28.md': 'An older note.\n',
    '2026-07-30-why-rss.md': '---\ntitle: Why RSS\n---\nThe newest thing we wrote.\n',
  });
  const app = createApp({ config, blog: createBlog({ dir }) });

  const html = await (await app.request('/')).text();

  assert.doesNotMatch(html, /The newest thing we wrote/);
  assert.doesNotMatch(html, /An older note/);
  assert.doesNotMatch(html, /Latest post/i);

  // And the posts are still there, one click away.
  const blog = await (await app.request('/blog')).text();
  assert.match(blog, /Why RSS/);
});

test('<source:markdown> round-trips the source text, newlines and all', async () => {
  // The point of source:markdown is that a reader can render the SOURCE. Passing it
  // through the attribute-value filter — which normalises every newline to a space,
  // correctly, for attributes — silently turns a fenced code block and a bulleted
  // list into one unparseable line.
  const source = [
    '# Heading',
    '',
    '- one',
    '- two',
    '',
    '```',
    'code & <tags>',
    '```',
    '',
  ].join('\n');
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
  // Asserting a control character was stripped requires naming it.
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(xml, /\u0007/);
  // The legal characters around them survive.
  assert.match(xml, /Body\s+with a half pair\s+too/);
});
