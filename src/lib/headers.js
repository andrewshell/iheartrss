/**
 * The §6 security headers, on **every** response (plan §6, "Security headers").
 *
 * One middleware rather than a line per route, because per-route headers drift —
 * the route that gets missed is always the one added last, and the miss is
 * invisible until somebody looks. `test/headers.test.js` walks one response of
 * every kind the app produces.
 */

/**
 * There is still no inline JS and no inline `style=` anywhere in the app — every
 * page is server-rendered HTML linking a single same-origin stylesheet, and the one
 * script we serve is a separate same-origin file — so the policy stays close to the
 * strict one §6 asks for rather than the `'unsafe-inline'` compromise most apps
 * settle for.
 *
 *  * `default-src 'none'` then allow-listing is the direction that fails safe: a
 *    fetch type nobody thought about is refused rather than inherited.
 *  * `script-src 'self'`: §10's feed reader (`/blog-roll.js`) is the app's only
 *    script, and it is our file on our origin. Deliberately **not**
 *    `'unsafe-inline'` — no page carries an inline `<script>` or an event-handler
 *    attribute, so an injected one is still refused, which is the property worth
 *    keeping. No third-party script host is allow-listed either: the reader is
 *    self-hosted precisely so this line does not have to name anyone else.
 *  * `style-src 'self'`: one stylesheet, ours. No inline `style=` anywhere.
 *  * `img-src 'self'`: the only images are our own badge SVGs and the favicons.
 *  * `manifest-src 'self'`: every page links `/site.webmanifest`. Without this
 *    line the manifest inherits `default-src 'none'` and the browser refuses to
 *    load it — the exact fail-safe described above, doing its job on a fetch type
 *    we did in fact think about, just not when the list was written.
 *  * `connect-src 'self' https://feedland.com`: the feed reader runs in the
 *    visitor's browser and calls FeedLand's `getfeedlistfromopml` and
 *    `getfeeditems` from there. One host, https only, and no wildcard — a
 *    compromised script cannot exfiltrate to anywhere else. The privacy cost of
 *    that request (FeedLand sees the visitor's IP) is stated on /about.
 *  * `form-action 'self'`: /submit, /check, /report and /admin post to us. Note
 *    that CSP is a second line here, not the first — §6's `Sec-Fetch-Site`
 *    check is what actually stops a cross-origin form driving our fetcher.
 *  * `frame-ancestors 'none'`: nothing here wants to be framed, and it is the
 *    modern replacement for `X-Frame-Options: DENY`.
 *  * `base-uri 'none'`: an injected `<base>` would silently repoint every
 *    relative URL on the page, including the form actions above.
 *
 * Still forbidden, and worth naming: inline and `eval`'d script, script from any
 * other origin, objects/plugins, framing us, `<base>` rewriting, and every fetch
 * type `default-src 'none'` catches by omission.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self' https://feedland.com",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

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

    headers.set('Content-Security-Policy', CSP);
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
