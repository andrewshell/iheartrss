import { html } from 'hono/html';

import { FEEDLAND_SERVER } from '../lib/feedland.js';
import { layout } from './layout.js';

/**
 * `/river` — every member's newest items in one stream.
 *
 * The complement to the blogroll on `/`, and deliberately a second page rather than
 * a second section there. The blogroll is a list of *feeds* you open one at a time;
 * this is the *items* themselves, newest first, with their text inline. They answer
 * different questions ("who is here?" vs "what is new?"), and the homepage is
 * already fighting to keep its one reader near the fold.
 *
 * The display is FeedLand's `riverviewer.js` — the same one wp.feedland.org runs —
 * pointed at our own OPML file. See `public/feedland-river.js` for how it is started
 * and why the FeedLand news-product machinery around it is not loaded.
 */
export function riverPage({ config }) {
  // Built from `config.siteUrl`, never hardcoded: FeedLand is handed this URL and
  // fetches it **server-side**, so it has to be whatever origin actually serves the
  // OPML. (Which also means the river is empty in development — see
  // `public/feedland-river.js`.)
  const opmlUrl = new URL('/subscriptions.opml', config.siteUrl).href;

  const body = html`
<section class="river">
  <h1>River of news</h1>

  <!-- OUTSIDE the container, and it starts in the HTML rather than being written by
       the script. FeedLand builds this river across ~150 feeds on demand, so the
       wait is real and it lands before our script has anything to show. On success
       feedland-river.js removes this line; on failure it rewrites it IN PLACE, links
       and all — riverviewer.js's own error is a dismissable dialog, and once that is
       gone an empty box with no explanation reads as our bug rather than as an
       outage.

       This line is now the only thing outside the container, so it is also the only
       place an outage can point onward from. There used to be a standing paragraph
       here doing that job; when it went, the links moved into the error text rather
       than off the page. -->
  <p class="river__status" id="idRiverStatus">Loading the river&hellip;</p>

  <!-- THE ONLY MARKUP riverviewer.js needs. It appends a div.divRiverDisplay in here
       and builds the sections, items and footers inside that.

       Both data- attributes are ours, and both exist so the starter script does not
       carry its own copy of something the server already knows: the OPML url comes
       from config.siteUrl, and the FeedLand host from lib/feedland.js — the same
       constant the CSP's connect-src is built from, so the host the script calls and
       the host the browser will ALLOW it to call cannot drift apart.

       No tabindex here, unlike the blogroll container: blogroll.js binds arrow keys
       on the body and gates them on that element having focus, and the river has no
       keyboard interface to gate. -->
  <div
    class="divRiverContainer"
    id="idRiverContainer"
    data-opmlurl="${opmlUrl}"
    data-feedland="${FEEDLAND_SERVER}"
  ></div>

  <noscript>
    <p>
      The river needs JavaScript. Without it, <a href="/sites">the member list</a>
      and <a href="/subscriptions.opml">the OPML file</a> have the same feeds, and
      any reader can follow them.
    </p>
  </noscript>
</section>
`;

  return layout({
    title: 'River of news',
    description:
      'Everything the members of I ♥ RSS are publishing, newest first — one river of news built from the members’ OPML subscription list.',
    body,
    config,
    head: riverIncludes(),
    // Only this page. The shell renders every page and the river has an element to
    // attach to on exactly one of them; without this being a parameter, /about would
    // download jQuery and bootstrap for nothing.
    scripts: ['/feedland-river.js'],
  });
}

/**
 * The `<head>` includes `riverviewer.js` needs.
 *
 * Order is load-bearing and these are parser-blocking on purpose: they are classic
 * scripts that read each other's globals at load time. `/feedland-river.js` is added
 * `defer`red by the layout, so it runs after every one of these regardless.
 *
 * **This list is shorter than the one wp.feedland.org loads, and the omissions are
 * the point.** That page loads Concord, the outliner, the outline dialog, the river6
 * browsers and templates, `riverclient/code.js` and `opmlpackage/client/opml.js` —
 * all of it in service of the FeedLand *news product* shell (tabs, an editable
 * outline behind the page, a custom-CSS summit) rather than of the river display. We
 * render one river into one div, so what is left is exactly what
 * `displayTraditionalRiver` and the functions it calls need:
 *
 *   * **jQuery** — riverviewer.js is jQuery throughout.
 *   * **bootstrap** (css + js) — the "when" stamps are tooltips and the likes list is
 *     a popover. Both are inert without the JS.
 *   * **Font Awesome** — the footer controls are icon-font glyphs, not images.
 *   * **basic/code.js + styles.css** — `getFacebookTimeString` (every relative time
 *     on the page), `runEveryMinute`, `getDomainFromUrl`, `maxStringLength`,
 *     `stripMarkup`, `alertDialog` and the rest of the small-string layer everything
 *     else calls without defining.
 *   * **markdownConverter.js** — NOT optional, though it looks it. `misc.js`'s
 *     `markdownProcess` does `new Markdown.Converter()`, and it runs for any item
 *     FeedLand hands back with a `markdowntext` field. That was 52 of 174 items on
 *     our own list the day this was written — scripting.com and every other Drummer
 *     blog — so leaving it out blanks a third of the river with a ReferenceError.
 *   * **feedland/home/api.js** — `servercall` and `getRiver`, which is the branch
 *     that turns our `.opml` url into `getriverfromopml`.
 *   * **feedland/home/misc.js + misc.css** — the time strings, tooltips, markdown and
 *     the signed-in checks that hide the account-only controls.
 *   * **feedland/home/getfeedinfo.js** — each section's title, link and pubDate are
 *     fetched per feed after the river arrives; this is that call and its cache.
 *   * **feedland/home/oldschoolrender.js + css** — items that carry an `outline`
 *     instead of a description (Drummer posts) are rendered by
 *     `oldSchoolStyleOutlineRender`. Same class of omission as markdownConverter:
 *     29 items of 174.
 *   * **feedland/home/riverviewer.js + css** — the display itself.
 *
 * Everything comes from `s3.amazonaws.com`, which is why `CSP_RIVER` names one script
 * host rather than the blogroll's two — nothing here is served through
 * `code.scripting.com` and its redirect.
 *
 * Dave's page also links Ubuntu, Oswald and Rancho from Google Fonts. **None of them
 * are here.** They style his page's title and tagline, not the river; the river
 * inherits whatever the page sets, which for us is the system stack every other page
 * uses. Google is not on this page at all.
 */
function riverIncludes() {
  return html`<script src="https://s3.amazonaws.com/scripting.com/code/includes/jquery-1.9.1.min.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/includes/bootstrap.css" rel="stylesheet">
<script src="https://s3.amazonaws.com/scripting.com/code/includes/bootstrap.min.js"></script>
<link rel="stylesheet" href="https://s3.amazonaws.com/scripting.com/code/fontawesome/css/all.css">
<script src="https://s3.amazonaws.com/scripting.com/code/includes/basic/code.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/includes/basic/styles.css" rel="stylesheet" type="text/css">
<script src="https://s3.amazonaws.com/fargo.io/code/markdownConverter.js"></script>
<!-- The river machinery: riverviewer.js calls into all of these. -->
<script src="https://s3.amazonaws.com/scripting.com/code/feedland/home/api.js"></script>
<script src="https://s3.amazonaws.com/scripting.com/code/feedland/home/misc.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/feedland/home/misc.css" rel="stylesheet" type="text/css">
<script src="https://s3.amazonaws.com/scripting.com/code/feedland/home/getfeedinfo.js"></script>
<script src="https://s3.amazonaws.com/scripting.com/code/feedland/home/oldschoolrender.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/feedland/home/oldschoolrender.css" rel="stylesheet" type="text/css">
<script src="https://s3.amazonaws.com/scripting.com/code/feedland/home/riverviewer.js"></script>
<link href="https://s3.amazonaws.com/scripting.com/code/feedland/home/riverviewer.css" rel="stylesheet" type="text/css">`;
}
