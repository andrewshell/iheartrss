/**
 * Member #1 (plan §6.4, §12 phase 6).
 *
 * A **direct INSERT**, not a form submission, and not because it is convenient:
 * §5 Step 7 rejects any canonical URL whose host is in `LINKBACK_HOSTS` with
 * `self_listing`, on purpose — we satisfy our own validator on every page (the
 * header links to `/`, autodiscovery is in every `<head>`) and `/status?url=…`
 * yields unbounded distinct URLs. So the seed is *not* an end-to-end test of the
 * pipeline; the real exercise is `pnpm verify https://iheartrss.com` from phase 4,
 * which hits every step against the live domain without writing a row.
 *
 * It exists at all because §7 notes an empty `<body>` is technically invalid OPML,
 * and phase 6's deliverable is "FeedLand can subscribe to a non-empty list".
 *
 * Called on every boot, so it has to be idempotent — and a no-op has to stay a
 * no-op all the way down: `insertSite` bumps `directory_version.version`, so a seed
 * that re-inserted (or re-updated) on every restart would invalidate every
 * subscriber's cached copy each time the container restarted, for no change.
 */
export function seedSelfListing({ queries, config, log = () => {} }) {
  const url = new URL('/', config.siteUrl).href;

  if (queries.getSiteByUrl(url) !== undefined) return false;

  queries.insertSite({
    url,
    submitted_url: url,
    host: new URL(url).hostname,
    path: '/',
    feed_url: new URL('/feed.xml', config.siteUrl).href,
    title: 'I ♥ RSS',
    description: 'A directory for people who love RSS.',
    // True by inspection of `blog/feed.js`, which declares and uses the namespace we
    // look for (§6.4: "our feed should pass the checks we run and then some").
    has_source_ns: true,
    // No `<cloud>` or `<source:cloud>` in v1 — we don't run an rsscloud server, and
    // §6.4 wants both forms to appear together if that ever changes.
    has_rsscloud: false,
    rsscloud_style: undefined,
    cloud_json: undefined,
  });

  log('seed.self_listing', { url });
  return true;
}
