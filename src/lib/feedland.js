import { html } from 'hono/html';

/**
 * Which FeedLand this site talks to. **One place, and this is it.**
 *
 * The homepage's blogroll and the river run in the visitor's browser and call a
 * server that speaks FeedLand's API for the member feed list, the river, and
 * recent items. That is `river.geekity.com`, our own service (geekitycom/river),
 * which implements only the read-side calls these pages make. Before it we were on
 * `feedland.com`, which capped our account at 250 feeds, and before that on Dave
 * Winer's `claude.feedland.org`, until its app went down behind a proxy that still
 * answered with 500s.
 *
 * The socket lives at `/_ws/`, not the root. River's blogroll element adds that
 * path itself; the CSP entry below stays an origin, and an origin admits every path
 * on that host.
 *
 * The pages embed River's own `<river-blogroll>` and `<river-river>` elements
 * (geekitycom/river, docs/EMBED.md). Their stylesheet and modules come from this
 * host too, which is why `script-src` and `style-src` name it in `lib/headers.js`.
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

export const FEEDLAND_SERVER = 'https://river.geekity.com';

/** The same origin as a websocket: `https://…` → `wss://…`, `http://…` → `ws://…`. */
export const FEEDLAND_SOCKET = toSocketOrigin(FEEDLAND_SERVER);

function toSocketOrigin(server) {
  const url = new URL(server);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  // `origin` rather than `href`, which would add the trailing slash a CSP source
  // expression must not have — a path in a source expression changes the match.
  return url.origin;
}

/**
 * River's stylesheet and one of its element modules, for a view's `<head>`.
 *
 * The stylesheet goes in before ours (the layout puts `/style.css` after `head`),
 * though order matters less than it looks: every rule in River's sheet sits in
 * `@layer river`, and our unlayered rules beat it whatever the specificity.
 */
export function riverIncludes(module) {
  return html`<link rel="stylesheet" href="${FEEDLAND_SERVER}/static/client/river.css">
<script type="module" src="${FEEDLAND_SERVER}/static/client/${module}"></script>`;
}
