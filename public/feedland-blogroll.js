/*
 * Dave Winer's blogroll.js, started on our homepage — the `code.js` from
 * https://news.rss.chat/blogroll/, adapted to this site.
 *
 * This is a TRIAL, running instead of `/blog-roll.js` (which is still here,
 * unchanged, and is what we go back to if this comes off). Dave reported trouble
 * with our own reader, so the thing being tested is his display against the same
 * OPML file, talking to his FeedLand rather than ours.
 *
 * Three deliberate differences from the file Dave published:
 *
 *   * **The OPML url is read from the container, not hardcoded.** His copy names
 *     `https://iheartrss.com/subscriptions.opml` outright; ours takes
 *     `data-opmlurl`, which the server builds from `config.siteUrl`. A hardcoded
 *     url would be right in production and quietly wrong on staging or a rename —
 *     the same reason our own reader took the url as an attribute.
 *   * **No inline `<script>`.** His page ends with `$(document).ready(startup)`.
 *     Ours is a `defer`red external file instead, so the CSP still refuses inline
 *     script (`script-src` gained two hosts for this trial; it did NOT gain
 *     `'unsafe-inline'`). Deferred scripts run after every parser-blocking script
 *     in `<head>` and before `DOMContentLoaded`, so jQuery and blogroll.js are
 *     both defined by the time this runs, and no ready handler is needed.
 *   * **No `blogrollDisplayedCallback`.** His styles.css hides the whole page
 *     until the blogroll paints; ours is one section on a page that has plenty
 *     else to say, so hiding it would be a blank screen for no reason.
 *
 * `appConsts` is a global on purpose: the FeedLand `home/` includes look for it by
 * that name to find the server. A top-level `const` in a classic script is
 * reachable from other scripts, so this is the same binding Dave's code.js makes.
 */

const appConsts = {
  //the includes look here for the server
  urlFeedlandServer: 'https://claude.feedland.org/',
  urlSocketServer: 'wss://claude.feedland.org/',
};

function startBlogroll() {
  const container = document.getElementById('idBlogrollContainer');
  // Every page shares one layout; only the homepage has the container. The script
  // is opted into per page, but a missing element must be a no-op rather than a
  // thrown error if that ever slips.
  if (container === null) return;

  // eslint-disable-next-line no-undef -- `blogroll` comes from code.scripting.com
  window.theBlogroll = new blogroll({
    urlBlogrollOpml: container.dataset.opmlurl, //our OPML file IS the blogroll
    urlFeedlandServer: appConsts.urlFeedlandServer,
    urlSocketServer: appConsts.urlSocketServer, //realtime — the times update as feeds change
    idWhereToAppend: 'idBlogrollContainer',

    // NO title inside the box. Dave's copy paints "I ♥ RSS" in Rancho at the top,
    // which is right on his page — there the blogroll IS the page and needs to say
    // whose it is. Here the masthead says "I ♥ RSS" and the `<h2>` immediately above
    // the box says "What members are writing", so a third label would be the same
    // words a third time. Turning it off also drops the only Google Fonts request
    // the page made, which is why `font-src` no longer names one.
    flDisplayTitle: false,
    title: 'I ♥ RSS', //unused while flDisplayTitle is false; kept so turning it back on says the right thing

    flQuietMode: false, //so the Title and When headers show — they are also the sort controls

    // 25 (his default) suits a 240px box. Ours is as wide as the page column, so
    // the titles that were being cut mid-word now fit; CSS wraps whatever is longer
    // than this rather than truncating it.
    maxTitleLength: 60,

    flViewOptions: false, //his default dumps the whole options object to the console on every page load
  });
}

startBlogroll();
