import { html } from 'hono/html';

import { FEEDLAND_SERVER, riverIncludes } from '../lib/feedland.js';
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
 * The display is River's `<river-river>` element, pointed at our own OPML file.
 */
export function riverPage({ config }) {
  // Built from `config.siteUrl`, never hardcoded: River is handed this URL and
  // fetches it **server-side**, so it has to be whatever origin actually serves the
  // OPML. (Which also means the river is empty in development.)
  const opmlUrl = new URL('/subscriptions.opml', config.siteUrl).href;

  const body = html`
<section class="river">
  <h1>River of news</h1>

  <!-- Outside the element on purpose. River's element shows its own loading and
       error messages, but an error there has no way onward, so this line links a
       reader to the same feeds when River is down. -->
  <p class="river__note">
    From the <a href="/subscriptions.opml">members&rsquo; OPML list</a>, or
    <a href="/sites">browse every member</a>. Reload the page to see newer posts.
  </p>

  <!-- River's <river-river> element (geekitycom/river, docs/EMBED.md). It loads the
       river once, keeps its relative times current, clips long posts behind a
       "Show more", and hides pictures that fail to load. The server attribute comes from
       lib/feedland.js, the same constant the CSP's connect-src is built from. -->
  <river-river
    id="idRiverContainer"
    opml="${opmlUrl}"
    server="${FEEDLAND_SERVER}"
  ></river-river>

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
    head: riverIncludes('river-river.js'),
    // Only this page: the shell renders every page, and the river has an element to
    // attach to on exactly one of them.
    scripts: ['/nofollow.js'],
  });
}
