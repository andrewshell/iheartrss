import { html, raw } from 'hono/html';

import { layout } from './layout.js';

/**
 * The blog index and a single post (plan §6.4, §6.3).
 *
 * **`raw(post.html)` is deliberate and there is no sanitizer** (§6.4). The markdown
 * is ours, arriving from a file in `content/` — never from a request. If this blog
 * ever takes outside contributions, that assumption breaks and a sanitizer becomes
 * mandatory before anything reaches these two functions.
 *
 * An **untitled post is headed by its formatted date**, not by an invented title
 * (§6.4): untitled is a correct shape here, the linkblog one, and the feed treats it
 * the same way by emitting `<description>` with no `<title>`.
 */
export function blogIndexPage({ config, posts }) {
  const body = html`
<section class="prose">
  <h1>Blog</h1>
  <p class="lede">
    Notes about RSS, feeds and this directory. Also available
    <a href="/feed.xml">as a feed</a>, which would be the least we could do.
  </p>
</section>

${
  posts.length === 0
    ? html`<p class="blog-index__empty">No posts yet.</p>`
    : html`<ol class="blog-index">
${posts.map(
  (post) => html`  <li class="blog-index__item">
    <h2 class="blog-index__title"><a href="${post.path}">${heading(post)}</a></h2>
    ${
      post.title === null
        ? ''
        : html`<p class="blog-index__date"><time datetime="${post.date}">${formatPostDate(post)}</time></p>`
    }
  </li>
`,
)}</ol>`
}
`;

  return layout({
    title: 'Blog',
    description: 'Notes about RSS, feeds and the iheartrss.com directory.',
    body,
    config,
  });
}

export function blogPostPage({ config, post }) {
  const body = html`
<article class="prose post">
  <header class="post__header">
    <h1 class="post__title">${heading(post)}</h1>
    ${
      post.title === null
        ? ''
        : html`<p class="post__date"><time datetime="${post.date}">${formatPostDate(post)}</time></p>`
    }
  </header>
  <div class="post__body">
${raw(post.html)}
  </div>
  <footer class="post__footer">
    <p><a href="/blog">&larr; All posts</a> &middot; <a href="/feed.xml">Subscribe</a></p>
  </footer>
</article>
`;

  return layout({
    title: post.title ?? formatPostDate(post),
    description: excerpt(post),
    body,
    config,
  });
}

/**
 * The heading for a post: its title, or — for an untitled one — its date, marked up
 * as a real `<time>` so the date it is headed by is still machine-readable. An
 * untitled post is not a post with a missing title (§6.4); the date IS the heading.
 */
export function heading(post) {
  return post.title === null
    ? html`<time datetime="${post.date}">${formatPostDate(post)}</time>`
    : html`${post.title}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-07-29` → `29 July 2026`. Read off the date string, so it never drifts by a timezone. */
export function formatPostDate(post) {
  const [year, month, day] = post.date.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/**
 * A plain-text lead for `<meta name="description">`.
 *
 * Derived from the **markdown**, not from the rendered HTML: stripping tags out of
 * the HTML leaves the entities behind, and `&amp;` handed back to the template
 * escapes a second time into `&amp;amp;`.
 */
function excerpt(post) {
  const text = post.markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
