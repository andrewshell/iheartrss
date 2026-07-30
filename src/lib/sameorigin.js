/**
 * Same-origin enforcement for the public POSTs (plan §6).
 *
 * `/submit`, `/check`, `/recheck/:id` and `/report` all spend outbound requests
 * against a third party, so each one is an amplifier if anyone can drive it.
 *
 * **Switching `/check` from GET to POST did not close that.** A cross-origin
 * auto-submitting form with `enctype="application/x-www-form-urlencoded"` needs no
 * preflight and no JS consent, so any attacker page still drives our server at a
 * victim URL, with every visitor funding a fresh rate budget. That the response is
 * opaque to the attacker is irrelevant for an amplifier — the *request* is the
 * attack. `SameSite=Strict` protects the admin cookie, not an unauthenticated route.
 */
export function isSameOrigin(c, config) {
  // Every browser that matters sends this, and it's unforgeable by page content.
  const fetchSite = c.req.header('sec-fetch-site');
  if (fetchSite !== undefined && fetchSite !== '') {
    return fetchSite === 'same-origin';
  }

  // Fallback for the older clients (and curl) that don't: an Origin matching
  // SITE_URL. Compared as origins, so a `https://iheartrss.com.evil.test` header
  // can't pass a prefix test.
  const origin = c.req.header('origin');
  if (origin === undefined) return false;

  try {
    return new URL(origin).origin === new URL(config.siteUrl).origin;
  } catch {
    return false;
  }
}
