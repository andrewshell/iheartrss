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
 *
 * "Idempotent" is not the same as "runs once", though, which is what the original
 * early-return made it. Everything the seed writes is *derived from the code being
 * deployed* (see `describeOwnFeed`), so a deploy is exactly when the right answer can
 * change — and an existing row whose features no longer match is refreshed rather
 * than skipped. Three outcomes, three log lines' worth of difference:
 * `seed.self_listing` (inserted), `seed.self_listing_refreshed` (healed), silence.
 */
import { renderFeed } from '../blog/feed.js';
import { featureColumns } from '../jobs/revalidate.js';
import { parseFeed } from '../verify/feed.js';

export function seedSelfListing({ queries, config, log = () => {} }) {
  const url = new URL('/', config.siteUrl).href;
  const derived = describeOwnFeed(config);

  const existing = queries.getSiteByUrl(url);
  if (existing !== undefined) return refresh({ queries, log, existing, derived });

  queries.insertSite({
    url,
    submitted_url: url,
    host: new URL(url).hostname,
    path: '/',
    feed_url: new URL('/feed.xml', config.siteUrl).href,
    ...derived,
  });

  log('seed.self_listing', { url });
  return true;
}

/**
 * Heal a row that already exists but no longer describes the feed we ship.
 *
 * The early `return false` this replaces is why production kept serving
 * `has_rsscloud: false` after §6.4 added the cloud elements: the row existed, so the
 * seed never looked at it again. §8's revalidation *would* correct it on a Pass, but
 * on a 6-day cadence — and a deploy is the moment we actually know the answer
 * changed, because the answer is derived from the code being deployed.
 *
 * **Only the feature columns.** Not `status`, `failure_count`, `last_checked_at`,
 * `last_verified_at`, `created_at` or the conditional-GET validators: those belong
 * to §8's state machine, and a deploy that stamped them would read back as a
 * successful check we never made — silently resetting the 3-strike grace period and
 * deferring the next real revalidation by a full interval. `title` and `description`
 * are left alone here too; see `describeOwnFeed`.
 *
 * Idempotent by comparison, not by hope: nothing is written and nothing is logged
 * unless a column actually differs, because `refreshSiteFeatures` bumps
 * `directory_version` and an unconditional write would invalidate every subscriber's
 * cached OPML on every container restart.
 */
function refresh({ queries, log, existing, derived }) {
  const before = normalize(existing);
  const after = normalize(derived);

  if (Object.keys(after).every((key) => after[key] === before[key])) return false;

  queries.refreshSiteFeatures(existing.id, derived);
  log('seed.self_listing_refreshed', { url: existing.url, before, after });
  return true;
}

/**
 * The four feature columns as SQLite will hold them, so a `false`/`0`/`undefined`
 * /`null` spread across the two representations cannot read as a change.
 *
 * `cloud_json` is compared as the serialised string. Both sides come from the same
 * `featureColumns`, so the key order is fixed; if a future change to it did reorder
 * the keys, the cost is one spurious refresh on one deploy, not a loop.
 */
function normalize(source) {
  return {
    has_source_ns: source.has_source_ns ? 1 : 0,
    has_rsscloud: source.has_rsscloud ? 1 : 0,
    rsscloud_style: source.rsscloud_style ?? null,
    cloud_json: source.cloud_json ?? null,
  };
}

/**
 * What member #1's row should say about member #1's feed — **derived, never
 * asserted**.
 *
 * This was six hardcoded literals with comments explaining why each was true "by
 * inspection of `blog/feed.js`". Both the values and the comments went stale the
 * moment §6.4 gave the feed its `<cloud>`/`<source:cloud>` pair: every fresh install
 * then published a row claiming we don't do rssCloud, and nothing short of §8's
 * revalidation job corrected it, on a 6-day cadence. A resubmission cannot — §5
 * Step 7 rejects any canonical host in `LINKBACK_HOSTS` with `self_listing`, by
 * design — so this is the *only* place a fresh install's answer comes from.
 *
 * So: render our own feed and run it through our own validator. Everything is
 * in-process, no network, and the answer cannot drift from the document because it
 * *is* the document. It is also the same pair of modules a real member's row goes
 * through, and `featureColumns` is `jobs/revalidate.js`'s own rather than a second
 * copy — so the seed and a Pass on this row write the same shape by construction.
 *
 * `title`/`description` come from the channel for the same reason, not just for
 * tidiness: §8's `passColumns` writes `result.title`/`result.description` verbatim on
 * any non-304 Pass, so a hardcoded pair here is only ever the value until the first
 * successful revalidation, at which point the listing silently changes under the
 * operator. Deriving them makes the deploy-time and check-time answers identical.
 *
 * They are deliberately **not** part of the existing-row refresh, though. A stale
 * `has_rsscloud` is a factual claim about the feed that we know is wrong; a
 * `description` is prose that a future operator may reasonably want to differ from
 * the channel's, and revalidation converges it anyway. Narrow beats clever here.
 *
 * A feed that somehow doesn't parse falls back rather than writing nulls: `title` is
 * NOT NULL, and features absent beats features false — "we could not tell" is not
 * the same claim as "it isn't there", and the next Pass fills them in.
 */
function describeOwnFeed(config) {
  const parsed = parseFeed(renderFeed({ config, posts: [] }));

  return {
    title: (parsed.ok && parsed.title) || 'I ♥ RSS',
    description:
      (parsed.ok && parsed.description) || 'A directory for people who love RSS.',
    ...featureColumns(parsed.ok ? parsed.features : undefined),
  };
}
