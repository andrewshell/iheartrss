/**
 * Which FeedLand this site talks to. **One place, and this is it.**
 *
 * The homepage's feed reader runs in the visitor's browser and calls a FeedLand
 * server for the member feed list and their recent items. Dave Winer asked us onto
 * `claude.feedland.org` rather than `feedland.com` because he can support us better
 * there, so that is the host — see the blogroll trial in `views/home.js`.
 *
 * ── Why this module exists ────────────────────────────────────────────────────
 *
 * The host was written out longhand in four places that did not know about each
 * other: the CSP in `lib/headers.js`, the privacy note on /about, the trial's
 * starter script, and the fallback reader's own default. Changing one and missing
 * another does not fail loudly — it fails as a reader that renders nothing, with a
 * CSP violation in a console nobody has open, because `connect-src` still named the
 * old host. Everything server-side now reads these two exports instead.
 *
 * ── The two browser files ─────────────────────────────────────────────────────
 *
 * `public/feedland-blogroll.js` and `public/blog-roll.js` cannot import this: they
 * are static files served to a browser, not modules in this build. They each still
 * carry the literal, and `test/blogroll.test.js` asserts that every one of those
 * copies equals `FEEDLAND_SERVER`. That is the enforcement — a host changed here and
 * not there fails the test suite rather than the page.
 *
 * ── Both schemes, deliberately ────────────────────────────────────────────────
 *
 * `FEEDLAND_SOCKET` is not decoration. A CSP source expression matches on scheme as
 * well as host, and `https://claude.feedland.org` does NOT cover
 * `wss://claude.feedland.org` — verified by removing it and watching Chrome refuse
 * the connection:
 *
 *     blockedURI: "wss://claude.feedland.org/", effectiveDirective: "connect-src"
 *
 * So the reader's two API calls and its live-update socket need one entry each.
 */

export const FEEDLAND_SERVER = 'https://claude.feedland.org';

/** The same origin as a websocket: `https://…` → `wss://…`, `http://…` → `ws://…`. */
export const FEEDLAND_SOCKET = toSocketOrigin(FEEDLAND_SERVER);

function toSocketOrigin(server) {
  const url = new URL(server);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  // `origin` rather than `href`, which would add the trailing slash a CSP source
  // expression must not have — a path in a source expression changes the match.
  return url.origin;
}
