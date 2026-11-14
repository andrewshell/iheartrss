/**
 * The §6 security headers, on **every** response (plan §6, "Security headers").
 *
 * One middleware rather than a line per route, because per-route headers drift —
 * the route that gets missed is always the one added last, and the miss is
 * invisible until somebody looks. `test/headers.test.js` walks one response of
 * every kind the app produces.
 */

import { FEEDLAND_SERVER, FEEDLAND_SOCKET } from './feedland.js';

/**
 * The policy for every page but `/` and `/river`, which embed River's elements and
 * get the two wider policies below.
 *
 * There is no inline JS and no inline `style=` in anything we write: every page is
 * server-rendered HTML linking a single same-origin stylesheet, and the scripts we
 * serve are separate same-origin files. So the policy stays close to the strict one
 * §6 asks for rather than the `'unsafe-inline'` compromise most apps settle for.
 *
 *  * `default-src 'none'` then allow-listing is the direction that fails safe: a
 *    fetch type nobody thought about is refused rather than inherited.
 *  * `script-src 'self'` and `style-src 'self'`: our files, our origin, and
 *    deliberately not `'unsafe-inline'`, so an injected tag or attribute is refused.
 *  * `img-src 'self'`: the only images are our own badge SVGs and the favicons.
 *  * `manifest-src 'self'`: every page links `/site.webmanifest`, and without this
 *    line it would inherit `default-src 'none'`.
 *  * `connect-src 'self'`: no page under this policy talks to anyone else.
 *  * `form-action 'self'`: /submit, /check, /report and /admin post to us. CSP is a
 *    second line here: §6's `Sec-Fetch-Site` check is what actually stops a
 *    cross-origin form driving our fetcher.
 *  * `frame-ancestors 'none'`: nothing here wants to be framed.
 *  * `base-uri 'none'`: an injected `<base>` would silently repoint every relative
 *    URL on the page, including the form actions above.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * The homepage's policy, for River's `<river-blogroll>` element.
 *
 * It differs from `CSP` in two lines, both naming River's host from
 * `lib/feedland.js` rather than spelling it out:
 *
 *  * `script-src` and `style-src` add River for the element's modules and
 *    `river.css`. Still no `'unsafe-inline'` on either: River's elements write no
 *    inline styles or scripts.
 *  * `connect-src` adds River twice: `FEEDLAND_SERVER` for the API calls and
 *    `FEEDLAND_SOCKET` for the socket that keeps the "when" times live. An `https:`
 *    source does NOT admit a `wss:` URL to the same host.
 *
 * `img-src` stays `'self'`: the blogroll shows no pictures.
 */
const CSP_BLOGROLL = [
  "default-src 'none'",
  `script-src 'self' ${FEEDLAND_SERVER}`,
  `style-src 'self' ${FEEDLAND_SERVER}`,
  "img-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  `connect-src 'self' ${FEEDLAND_SERVER} ${FEEDLAND_SOCKET}`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * `/river`'s policy, for River's `<river-river>` element.
 *
 * A third policy rather than a reuse of `CSP_BLOGROLL`, because the differences run
 * in both directions:
 *
 *  * `connect-src` names River **once**. The river loads once and opens no socket,
 *    so `FEEDLAND_SOCKET` would be an allowance with nothing using it.
 *  * `img-src` is `'self' https:`, by far the widest line in this file. Every
 *    section shows the feed's favicon from `icons.duckduckgo.com`, and the items
 *    carry the authors' own pictures from wherever each member keeps them. There is
 *    no list to write: the set of hosts changes without us. What it costs: a
 *    member's server, or anyone their feed embeds from, learns the IP address of
 *    everyone reading the river, and a tracking pixel would work. It buys an
 *    attacker nothing executable. /about says this in the visitor's words.
 *  * `media-src https: http:` plays audio and video enclosures. Chrome upgrades an
 *    `http:` picture on an `https:` page, but blocks an `http:` medium that
 *    `media-src` does not allow, and podcast enclosures are often plain `http:`.
 */
const CSP_RIVER = [
  "default-src 'none'",
  `script-src 'self' ${FEEDLAND_SERVER}`,
  `style-src 'self' ${FEEDLAND_SERVER}`,
  "img-src 'self' https:",
  'media-src https: http:',
  "font-src 'self'",
  "manifest-src 'self'",
  `connect-src 'self' ${FEEDLAND_SERVER}`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * The policies a route may ask for by name, via `c.set('cspProfile', …)`.
 *
 * A name rather than the policy itself, so the strings stay in this file: a route
 * that could hand `securityHeaders` an arbitrary CSP is a route that can weaken the
 * site's headers, and reviewing "which pages are not strict?" would mean reading
 * every route instead of this one map. An unknown name falls back to the strict
 * policy — the fail-safe direction.
 */
const CSP_PROFILES = {
  blogroll: CSP_BLOGROLL,
  river: CSP_RIVER,
};

/**
 * `Cache-Control: no-cache` on HTML, and nothing else.
 *
 * The companion to `lib/assets.js`, and useless without it in either direction. The
 * versioned `/style.css?v=…` in a page's `<head>` can only reach a browser that
 * fetched *that page* — so an HTML response allowed to sit in a cache holds the old
 * asset URLs with it, and the deploy still does not land. Today those responses carry
 * no `Cache-Control`, no `ETag` and no `Last-Modified` at all, which leaves the
 * decision to each browser's heuristics; this replaces "probably refetched" with a
 * rule.
 *
 * `no-cache` is **not** "do not store" — the copy is kept and revalidated before
 * reuse. These pages are small, server-rendered and database-backed, so a
 * revalidation that turns into a refetch is exactly the request we already serve.
 *
 * HTML only, and only when the route has not already spoken: `routes/static.js` sets
 * its own (a week, or a year for a versioned URL), and `/subscriptions.opml` answers
 * conditional GETs with its own validators.
 */
export function cacheHeaders() {
  return async (c, next) => {
    await next();

    const headers = c.res.headers;
    if (headers.has('Cache-Control')) return;
    if (!(headers.get('Content-Type') ?? '').startsWith('text/html')) return;

    headers.set('Cache-Control', 'no-cache');
  };
}

export function securityHeaders() {
  return async (c, next) => {
    await next();

    const headers = c.res.headers;

    // Read after `next()`, because the route sets it while handling the request.
    headers.set('Content-Security-Policy', CSP_PROFILES[c.get('cspProfile')] ?? CSP);
    // §6: nosniff everywhere. Several routes already set it themselves; this makes
    // it true of the ones that don't, including 404s and redirects.
    headers.set('X-Content-Type-Options', 'nosniff');
    // §6: strict-origin-when-cross-origin. Matters most on /status?url=… and the
    // outbound links on /sites — a member should not learn from their own logs
    // which of our pages a visitor came from, path and query included.
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Default-deny, so §6's `Cross-Origin-Resource-Policy: cross-origin` on the
    // three badge SVGs is a deliberate exemption rather than the ambient state.
    // Set only if the route has not already spoken — `routes/static.js` opts the
    // hotlinkable files out, and this must not overwrite that.
    if (!headers.has('Cross-Origin-Resource-Policy')) {
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    }
  };
}
