/**
 * Which FeedLand this site talks to. **One place, and this is it.**
 *
 * The homepage's feed reader runs in the visitor's browser and calls a FeedLand
 * server for the member feed list and their recent items. That is `feedland.com`,
 * which Automattic runs and keeps current. We were on Dave Winer's
 * `claude.feedland.org` while debugging the blogroll trial with him, until its app
 * went down behind a proxy that still answered: every call got a 500 with
 * `connect ECONNREFUSED` in the body.
 *
 * feedland.com's socket lives at `/_ws/`, not the root, so the two browser files
 * add that path when they build the socket URL. The CSP entry below stays an
 * origin, and an origin admits every path on that host.
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
 * well as host, and `https://feedland.com` does NOT cover `wss://feedland.com`.
 * Verified (against the previous host) by removing it and watching Chrome refuse
 * the connection:
 *
 *     blockedURI: "wss://claude.feedland.org/", effectiveDirective: "connect-src"
 *
 * So the reader's two API calls and its live-update socket need one entry each.
 */

export const FEEDLAND_SERVER = 'https://feedland.com';

/** The same origin as a websocket: `https://…` → `wss://…`, `http://…` → `ws://…`. */
export const FEEDLAND_SOCKET = toSocketOrigin(FEEDLAND_SERVER);

function toSocketOrigin(server) {
  const url = new URL(server);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  // `origin` rather than `href`, which would add the trailing slash a CSP source
  // expression must not have — a path in a source expression changes the match.
  return url.origin;
}
