/**
 * The `User-Agent` every outbound request carries (plan §5 Step 1, §6).
 *
 * A leaf module holding one string, because it has **two** consumers that must never
 * disagree: `verify/fetch.js`, which sends it, and `/about`, which prints it and tells
 * a site owner "our requests are identifiable by their User-Agent, which names this
 * page".
 *
 * They did disagree. `/about` rendered a hand-written approximation —
 * `iheartrss.com/1.0 (+…//about)`, with a version we never sent and a doubled slash
 * from appending `/about` to a `SITE_URL` that already ends in one — while the fetcher
 * sent `iheartrss.com validator (+https://iheartrss.com/about)`. An operator who wrote
 * the allowlist rule that page asked them to write would have matched nothing, and
 * would have gone on blocking us. That is the exact outcome the section exists to
 * prevent, so the page now prints this constant rather than describing it.
 *
 * It is not built from `config.siteUrl`: the URL in it has to be a real page a stranger
 * can open when they find us in their logs, which is the deployed site, not whatever a
 * staging box calls itself.
 */
export const USER_AGENT = 'iheartrss.com validator (+https://iheartrss.com/about)';
