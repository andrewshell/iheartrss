/**
 * `/blog` and `/blog/:yyyy/:mm/:dd/:slug?` (plan §6, §6.4).
 *
 * **`:slug?` is the Hono spelling.** The Express-5 form `{/:slug}?` is accepted at
 * registration and then throws `undefined is not iterable` at request time — an
 * unhelpful 500 on a route that looks correct (§6, measured).
 *
 * **Resolution is an index lookup, never a `path.join` on route params** (§6). Route
 * params arrive percent-decoded, so a `%2e%2e%2f` in `:slug` is `../` by the time a
 * handler sees it; joined onto a content directory that reaches the database file.
 * Here the params are only ever used to *look up* an already-loaded post, so a
 * traversal attempt is simply a 404 — there is no path to escape from.
 */

import { notFoundPage } from '../views/error.js';
import { blogIndexPage, blogPostPage } from '../views/blog.js';

export function registerBlog(app, { config, blog }) {
  app.get('/blog', (c) => c.html(blogIndexPage({ config, posts: blog.posts() })));

  app.get('/blog/:yyyy/:mm/:dd/:slug?', (c) => {
    const { yyyy, mm, dd, slug } = c.req.param();

    const post = blog
      .posts()
      .find(
        (candidate) =>
          candidate.date === `${yyyy}-${mm}-${dd}` &&
          candidate.slug === (slug === undefined || slug === '' ? null : slug),
      );

    if (post === undefined) return c.html(notFoundPage({ config }), 404);

    return c.html(blogPostPage({ config, post }));
  });
}
