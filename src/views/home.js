import { html } from 'hono/html';

import { layout } from './layout.js';

/**
 * The homepage is deliberately short (plan §10).
 *
 * `memberCount` is §6's "single member **count**" — the number, and deliberately
 * **no member list**, because §10's feed reader will own that space. The list
 * itself lives on /sites.
 *
 * Two things that used to be here have moved, both for the same reason: the reader
 * is the point of this page, and anything above it pushes it below the fold.
 *
 *   * **The "how to join" steps moved to /submit**, where the form they end in
 *     already lived. Explaining three steps on one page and then asking for the URL
 *     on another was the odd arrangement; the explanation and the field belong
 *     together.
 *   * **The latest post moved out entirely.** It was here to give the homepage
 *     something to say before the reader landed. Once the reader is here, it is the
 *     thing with something to say, and a full post above it is just distance.
 *
 * The heading does NOT repeat the wordmark. The masthead immediately above it already
 * reads "I ♥ RSS", so an `<h1>` saying the same words was the same thing twice —
 * it says what the site *is* instead.
 */
export function homePage({ config, memberCount = 0 }) {
  // Built from `config.siteUrl`, never hardcoded: FeedLand is handed this URL and
  // fetches it itself, so it has to be whatever origin is actually serving the
  // OPML. (A consequence worth knowing: FeedLand fetches it **server-side**, so
  // pointing SITE_URL at localhost cannot work — the reader is empty in
  // development and only populates on the deployed origin.)
  const opmlUrl = new URL('/subscriptions.opml', config.siteUrl).href;

  const body = html`
<section class="hero">
  <h1>A directory of people who love RSS</h1>
  <p class="lede">
    Put the badge on your homepage and submit your URL. Once we&rsquo;ve checked the
    link back and found your feed, you&rsquo;re on the list &mdash; and in an OPML
    subscription list any reader can subscribe to in one action.
  </p>
  <p class="hero__count">
    ${memberCount === 1 ? html`1 member` : html`${memberCount} members`} so far &mdash;
    <a href="/sites">see them all</a>, or
    <a href="/subscriptions.opml">subscribe to the whole list</a>.
  </p>
  <p class="hero__cta">
    <a class="button" href="/submit">Add your site</a>
  </p>
</section>

<!-- §10: the feed reader. Everything above it is deliberately short so that it
     starts at or near the fold rather than three screens down. -->
<section class="blogroll">
  <h2>What members are writing</h2>
  <!-- Deliberately OUTSIDE the reader element, and it stays on the page forever.
       The component clears its own innerHTML before rendering — including when
       FeedLand errors and it has nothing to render — so anything inside the
       element is gone the moment the script runs. Without a line out here, a
       FeedLand outage leaves a heading above an empty box and no way onward. -->
  <p class="blogroll__note">
    Newest first, from the <a href="/subscriptions.opml">members&rsquo; OPML list</a>.
    Open a name to see its recent items, or <a href="/sites">browse every member</a>.
  </p>
  <blog-roll opmlurl="${opmlUrl}">
    <!-- Inside the element, so it is replaced the moment the reader renders. This
         is what a visitor without JavaScript — or before the fetch returns — gets:
         not a spinner, but the two links that do the same job by hand. -->
    <p>
      <a href="/sites">See every member site</a>, or subscribe to
      <a href="/subscriptions.opml">the whole list as OPML</a> in your own reader.
    </p>
  </blog-roll>
  <noscript>
    <p>
      The reader needs JavaScript. Without it, <a href="/sites">the member list</a>
      and <a href="/subscriptions.opml">the OPML file</a> have the same feeds.
    </p>
  </noscript>
</section>
`;

  return layout({
    title: null,
    description:
      'A directory for people who love RSS. Add the badge, submit your site, get listed in a public OPML subscription list.',
    body,
    config,
    // Only this page. See `layout`'s note: the shell renders every page, and the
    // reader has an element to attach to on exactly one of them.
    scripts: ['/blog-roll.js'],
  });
}
