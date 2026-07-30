import { html, raw } from 'hono/html';

import { formatPostDate, heading } from './blog.js';
import { layout } from './layout.js';
import { submitForm } from './submit.js';

/**
 * `memberCount` is §6's "single member **count**" — the homepage carries the number
 * and deliberately **no member list**, because §10's feed reader will own that space.
 * The list itself lives on /sites.
 *
 * `latestPost` is §6's "**latest blog post** inline" — one post, rendered in full,
 * which is what gives the homepage something to say before §10's reader lands. With
 * no posts the section is absent entirely rather than empty: a "Latest post" heading
 * over nothing is worse than no heading.
 *
 * `raw()` on the post body, and no sanitizer — see the note in views/blog.js.
 */
export function homePage({ config, memberCount = 0, latestPost = null }) {
  const badgeImg = new URL('/iheartrss.svg', config.siteUrl).href;

  const body = html`
<section class="hero">
  <h1>I &hearts; RSS</h1>
  <p class="lede">
    A directory of people who love RSS. Put the badge on your homepage, submit your
    URL, and — once we&rsquo;ve checked the link back and found your feed — you&rsquo;re
    on the list, and in an OPML subscription list any reader can subscribe to.
  </p>
  <p class="hero__count">
    ${memberCount === 1 ? html`1 member` : html`${memberCount} members`} so far &mdash;
    <a href="/sites">see them all</a>, or
    <a href="/subscriptions.opml">subscribe to the whole list</a>.
  </p>
</section>

<section class="how">
  <h2>How to join</h2>
  <ol class="steps">
    <li>
      <h3>Put the badge on your homepage</h3>
      <p>
        Link to <code>https://iheartrss.com/</code>. An image badge or a plain text
        link both count &mdash; we look at the link, not the picture.
      </p>
      <p>
        <a href="/"><img src="${badgeImg}" alt="I love RSS" width="88" height="31"></a>
      </p>
      <p><a href="/badge">Get the badge and copy-paste snippets &rarr;</a></p>
    </li>
    <li>
      <h3>Make sure your feed is discoverable</h3>
      <p>
        We look for an RSS 2.0 feed advertised in your page&rsquo;s
        <code>&lt;head&gt;</code>.
      </p>
      <p><a href="/guide">How to publish an RSS 2.0 feed &rarr;</a></p>
    </li>
    <li>
      <h3>Submit your URL</h3>
      ${submitForm()}
    </li>
  </ol>
</section>

${
  latestPost === null
    ? ''
    : html`<section class="latest prose" aria-labelledby="latest-post">
  <h2 id="latest-post">Latest post</h2>
  <article class="post">
    <h3 class="post__title">
      <a href="${latestPost.path}">${heading(latestPost)}</a>
    </h3>
    ${
      latestPost.title === null
        ? ''
        : html`<p class="post__date"><time datetime="${latestPost.date}">${formatPostDate(latestPost)}</time></p>`
    }
    <div class="post__body">
${raw(latestPost.html)}
    </div>
  </article>
  <p><a href="/blog">All posts &rarr;</a> &middot; <a href="/feed.xml">Subscribe</a></p>
</section>`
}
`;

  return layout({
    title: null,
    description:
      'A directory for people who love RSS. Add the badge, submit your site, get listed in a public OPML subscription list.',
    body,
    config,
  });
}
