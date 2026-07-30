/**
 * The §6 security headers, on **every** response (plan §6, "Security headers").
 *
 * One middleware rather than a line per route, because per-route headers drift —
 * the route that gets missed is always the one added last, and the miss is
 * invisible until somebody looks. `test/headers.test.js` walks one response of
 * every kind the app produces.
 */

/**
 * There is no inline JS and no inline `style=` anywhere in the app — every page is
 * server-rendered HTML linking a single same-origin stylesheet — so the policy can
 * be the strict one §6 asks for rather than the `'unsafe-inline'` compromise most
 * apps settle for.
 *
 *  * `default-src 'none'` then allow-listing is the direction that fails safe: a
 *    fetch type nobody thought about is refused rather than inherited.
 *  * `img-src 'self'`: the only images are our own badge SVGs and the favicons.
 *  * `form-action 'self'`: /submit, /check, /report and /admin post to us. Note
 *    that CSP is a second line here, not the first — §6's `Sec-Fetch-Site`
 *    check is what actually stops a cross-origin form driving our fetcher.
 *  * `frame-ancestors 'none'`: nothing here wants to be framed, and it is the
 *    modern replacement for `X-Frame-Options: DENY`.
 *  * `base-uri 'none'`: an injected `<base>` would silently repoint every
 *    relative URL on the page, including the form actions above.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

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
