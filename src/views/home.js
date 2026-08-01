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
  <!-- Deliberately OUTSIDE the container, and it stays on the page forever.
       blogroll.js appends into the container and says nothing when FeedLand is
       unreachable, so without a line out here an outage leaves a heading above an
       empty box and no way onward. -->
  <p class="blogroll__note">
    From the <a href="/subscriptions.opml">members&rsquo; OPML list</a>. Open a name
    to see its recent items, or <a href="/sites">browse every member</a>.
  </p>
  <!-- THE ONLY MARKUP blogroll.js needs, and this is all of it: one div carrying
       the class its stylesheet targets and the id idWhereToAppend names.
       Everything visible — the menu, the sort headers, the table, the footer — is
       built into it at runtime. Dave's page wraps this in a second div to centre a
       fixed-width box on an otherwise empty page; ours is a section of a page that
       already has a column, so the wrapper is gone and the box is simply as wide as
       everything else here.

       The tabindex IS load-bearing: blogroll.js binds arrow keys and Return on
       the document body and acts only when this element has focus, so without it the
       keyboard interface is dead. data-opmlurl is ours; see
       public/feedland-blogroll.js. -->
  <div
    class="divBlogrollContainer"
    id="idBlogrollContainer"
    tabindex="0"
    data-opmlurl="${opmlUrl}"
  ></div>
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
    head: blogrollIncludes(),
    // Only this page. See `layout`'s note: the shell renders every page, and the
    // blogroll has an element to attach to on exactly one of them.
    //
    // `/blog-roll.js` — our own reader — is deliberately NOT loaded while the trial
    // runs. The file is still served and still tested; nothing but this line has to
    // change to put it back.
    scripts: ['/feedland-blogroll.js'],
  });
}

/**
 * The `<head>` includes blogroll.js needs, copied from Dave's index.html.
 *
 * Order is load-bearing and these are parser-blocking on purpose: they are classic
 * scripts that read each other's globals at load time, and jQuery has to be defined
 * before bootstrap, the FeedLand includes before blogroll.js, and all of them before
 * `/feedland-blogroll.js` — which the layout adds `defer`red, so it runs after every
 * one of these regardless.
 *
 * The cost is real and worth naming: this is the page we most wanted to be fast, and
 * it now blocks on jQuery, bootstrap, four FeedLand includes and blogroll.js from
 * hosts that are not ours. That is the trade the trial is asking about.
 *
 * `code.scripting.com/blogroll/*` 302s to the same S3 bucket as everything else, and
 * CSP checks the redirect target as well as the request — which is why `script-src`
 * and `style-src` name both hosts in `lib/headers.js`.
 *
 * Dave's page also links Ubuntu, Oswald and Rancho from Google Fonts. **None of them
 * are here.** Ubuntu and Oswald styled his page, not the blogroll, and Rancho was
 * only ever the script font of the title inside the box — which we turn off. Dropping
 * the last one takes Google off this page entirely.
 *
 * What each of the rest is actually for, since none of it is obvious and all of it is
 * somebody else's:
 *
 *   * **jQuery** — blogroll.js is jQuery throughout, and grabs it as `const $` on
 *     entry.
 *   * **bootstrap** (css + js) — the ⋮ menu is a Bootstrap dropdown and the feed
 *     tooltips are Bootstrap popovers. Both are dead without the JS.
 *   * **Font Awesome** — the wedge carets (`fa-caret-right`) and the ⋮ glyph
 *     (`fa-ellipsis-v`) are icon-font characters, not images. Without it the rows
 *     lose the one affordance that says they open.
 *   * **basic/code.js + the four `feedland/home/` files** — `servercall`, the string
 *     helpers and the date formatting blogroll.js calls without defining.
 */
function blogrollIncludes() {
  return html`<script src="https://s3.amazonaws.com/scripting.com/code/includes/jquery-1.9.1.min.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/includes/bootstrap.css" rel="stylesheet">
<script src="https://s3.amazonaws.com/scripting.com/code/includes/bootstrap.min.js"></script>
<link rel="stylesheet" href="https://s3.amazonaws.com/scripting.com/code/fontawesome/css/all.css">
<script src="https://s3.amazonaws.com/scripting.com/code/includes/basic/code.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/includes/basic/styles.css" rel="stylesheet" type="text/css">
<!-- The feed-list machinery: blogroll.js calls into these. -->
<script src="https://s3.amazonaws.com/scripting.com/code/feedland/home/api.js"></script>
<script src="https://s3.amazonaws.com/scripting.com/code/feedland/home/misc.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/feedland/home/misc.css" rel="stylesheet" type="text/css">
<script src="https://s3.amazonaws.com/scripting.com/code/feedland/home/subscriptionlog.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/feedland/home/mobile.css" rel="stylesheet" type="text/css">
<script src="https://s3.amazonaws.com/scripting.com/code/feedland/home/viewfeedlist.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/feedland/home/viewfeedlist.css" rel="stylesheet" type="text/css">
<link href="https://code.scripting.com/blogroll/blogroll.css" rel="stylesheet">
<script src="https://code.scripting.com/blogroll/blogroll.js"></script>`;
}
