/**
 * §5 Step 7 — persist a verified submission.
 *
 * Kept out of `verify/index.js` on purpose: that module has no database
 * dependency and is testable against a fixture HTTP server. This one is the
 * opposite — all database, one narrow outbound fetch (the incumbent re-check).
 */

import { getDomain } from 'tldts';

import { DESCRIPTION_MAX, normalizeMetaText, TITLE_MAX } from '../lib/xml.js';
import { parsePage } from './page.js';

export function createPersister({
  queries,
  config,
  safeFetch,
  now = () => new Date(),
  log = () => {},
}) {
  /**
   * @param {object} verification - a successful `verifySite` result.
   * @param {object} [options]
   * @param {object} [options.budget] - the submission's SHARED fetch budget (§5).
   *   The incumbent re-check is requests 5 and 6 of the worst case, so it spends the
   *   same clock; without this a collision doubles the wall time of a POST.
   * @returns {Promise<{outcome: string, siteId?: number, reason?: string}>}
   */
  return async function persistVerified(verification, { budget } = {}) {
    const url = new URL(verification.url);
    const host = url.hostname.toLowerCase();

    // §5 Step 7: reject canonical URLs whose host is in LINKBACK_HOSTS. We satisfy
    // our own validator on every page by design — the header links to `/` and
    // autodiscovery is in every `<head>` — and `/status?url=…` yields unbounded
    // distinct URLs, which Step 0.4 deliberately does not strip. Together with
    // UNIQUE(feed_url) that closes self-listing without stripping query strings.
    // Member #1 is a direct INSERT in phase 6, not a form submission.
    if (config.linkbackHosts.includes(host)) {
      return { outcome: 'rejected', reason: 'self_listing' };
    }

    // Step 0.6 screened the SUBMITTED url. The canonical URL comes from the feed's
    // attacker-controlled `<channel><link>` and can be an entirely different host,
    // so the ban is checked again here or it is sidestepped by submitting a page
    // that canonicalises onto the banned one.
    const ban = queries.findBan({ host, path: url.pathname });
    if (ban !== undefined) {
      return { outcome: 'rejected', reason: 'banned' };
    }
    const columns = {
      url: verification.url,
      submitted_url: verification.submittedUrl ?? verification.url,
      host: url.hostname,
      path: url.pathname,
      feed_url: verification.feedUrl,
      // §7: "Cap lengths at ingest (title ~200 chars, description ~500) as well as
      // at render, and strip bidi overrides (U+202E) and C0/C1 controls so the DB is
      // clean." Nothing else bounds these — they arrive verbatim from a feed of up to
      // MAX_RESPONSE_BYTES into unbounded TEXT columns, so a 1 MB title would be
      // re-read and re-truncated on every OPML render and every /sites request for
      // as long as the row exists. `normalizeMetaText` is the same function the
      // renderers use, so the two ends cannot disagree.
      title: normalizeMetaText(verification.title, TITLE_MAX),
      description: normalizeMetaText(verification.description, DESCRIPTION_MAX),
      ...featureColumns(verification.features),
    };

    const byUrl = queries.getSiteByUrl(verification.url);
    const byFeed = queries.getSiteByFeedUrl(verification.feedUrl);

    // `url` matches one row and `feed_url` a DIFFERENT one: "either a genuine mess
    // or an attack, and it needs eyes" (§5 Step 7).
    if (byUrl !== undefined && byFeed !== undefined && byUrl.id !== byFeed.id) {
      return ambiguous(verification, { urlRow: byUrl.id, feedRow: byFeed.id });
    }

    if (byUrl !== undefined) return refresh(byUrl, columns);

    // ── Identity is `feed_url` (§5 Step 7) ───────────────────────────────────
    // A collision where the canonical URL differs means the row may follow the
    // feed — but ONLY after re-verifying the incumbent.
    if (byFeed !== undefined) {
      const moved = await mayMove(byFeed, verification, budget);
      if (!moved.ok) return ambiguous(verification, moved.detail);
      return refresh(byFeed, columns);
    }

    // ── Two cheap backstops against bulk flooding (§5 Step 7) ────────────────
    // Neither UNIQUE constraint stops it: with wildcard DNS, a1…a500 each have a
    // genuinely distinct url AND feed_url, so all 500 would reach every subscriber.
    // Checked only for NEW rows — a refresh adds nothing to flood with, and
    // refusing one would break the "idempotent re-check me now" promise above.
    const capped = checkCaps(url.hostname);
    if (capped !== null) return capped;

    return { outcome: 'added', siteId: queries.insertSite(columns) };
  };

  /**
   * May the row holding this `feed_url` move to a new canonical URL?
   *
   * **Only a conclusive 2xx fetch of the incumbent that no longer declares the feed
   * permits it.** Any other outcome — timeout, 4xx, 5xx, a bot-protection 403,
   * budget exhausted — refuses.
   *
   * This gate has to fail closed, and the reason is worth restating: "unreachable"
   * is a COMMON state here, not an edge case. The whole `blocked` status exists
   * because bot protection 403s us routinely. An implementer who writes this as
   * `!declaresFeed(incumbent)` hands the row over whenever the victim's host is
   * momentarily 403-ing, rate-limiting or mid-deploy — a window an attacker can wait
   * for, and on some hosts induce by burning the victim's rate limit.
   *
   * It is also the last gate behind the shared-host variant, where an attacker page
   * on the victim's own origin passes every origin-level check by construction.
   */
  async function mayMove(incumbent, verification, budget) {
    if (incumbent.url === verification.url) return { ok: true };

    const response = await safeFetch(incumbent.url, {
      budget: budget ?? freshBudget(),
      kind: 'page',
    });

    if (!response.ok) {
      return { ok: false, detail: { incumbent: incumbent.url, why: response.reason } };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        detail: { incumbent: incumbent.url, why: `status_${response.status}` },
      };
    }

    // A conclusive 2xx. Does it still declare the feed?
    const page = parsePage(response.body, response.url);
    const declares = [
      page.feedUrl,
      ...page.rssCandidates.map((c) => c.url),
      ...page.otherFormatCandidates.map((c) => c.url),
    ].includes(verification.feedUrl);

    return declares
      ? { ok: false, detail: { incumbent: incumbent.url, why: 'still_declares_feed' } }
      : { ok: true };
  }

  function ambiguous(verification, detail) {
    // §5 Step 7: "rejects with ambiguous_identity, logs, and surfaces on /admin".
    // The `submissions` row the route writes is what surfaces it; this is the log.
    log('persist.ambiguous_identity', {
      url: verification.url,
      feed_url: verification.feedUrl,
      ...detail,
    });
    return { outcome: 'rejected', reason: 'ambiguous_identity', detail };
  }

  // Only for a caller that didn't pass one (the CLI, a test). The route shares the
  // verifier's budget so §5's 6-request worst case really is one clock.
  function freshBudget() {
    const ms = config.submitBudgetMs ?? 30000;
    return { deadline: Date.now() + ms, signal: AbortSignal.timeout(ms) };
  }

  function checkCaps(host) {
    // `allowPrivateDomains: true` is MANDATORY (§5 Step 7): at the default,
    // getDomain('anyuser.github.io') is 'github.io', and a cap of 5 would limit all
    // of GitHub Pages, netlify.app, pages.dev and blogspot.com to five listings
    // each, globally. PSL matching is the wrong tool for relatedness and the right
    // tool for counting.
    const domain = getDomain(host, { allowPrivateDomains: true }) ?? host;

    // `domain_limits` is consulted FIRST, because the flag is necessary but not
    // sufficient: substack.com, wordpress.com, micro.blog, tumblr.com and
    // neocities.org are not separated by the PSL private section, and path-based
    // hosts (mastodon.social, medium.com, tilde.club) can't be separated by any
    // domain function. `-1` means unlimited.
    const limit = queries.maxListingsForDomain(domain, config.maxListingsPerDomain);

    if (limit >= 0 && queries.countListingsForDomain(domain) >= limit) {
      return { outcome: 'rejected', reason: 'domain_cap', domain, limit };
    }

    const since = new Date(now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    if (queries.countSitesCreatedSince(since) >= config.maxNewListingsPerDay) {
      return { outcome: 'rejected', reason: 'daily_cap' };
    }

    return null;
  }

  /**
   * Refresh an existing row. **`hidden` is terminal** (§5 Step 7): the row still
   * takes the new metadata — we keep observing it — but its status doesn't move,
   * and the caller is told `already_submitted` rather than `updated`.
   *
   * The neutral answer is the point. "You are hidden" is an oracle telling a
   * moderated party they were moderated, which is exactly what `/submit` and
   * `/recheck` contort themselves to avoid; and `already_submitted` is *true*.
   */
  function refresh(row, columns) {
    const hidden = row.status === 'hidden';

    queries.updateSite(row.id, columns, { revive: !hidden });

    return hidden
      ? { outcome: 'already_submitted' }
      : { outcome: 'updated', siteId: row.id };
  }
}

/**
 * `features` is the shape `verify/feed.js` produces; `sites` wants a JSON blob for
 * the cloud attributes so a future registrar (§10) needn't re-crawl.
 */
function featureColumns(features = {}) {
  const cloud =
    features.cloud === undefined && features.cloud_url === undefined
      ? undefined
      : JSON.stringify({
          cloud: features.cloud ?? null,
          cloud_url: features.cloud_url ?? null,
        });

  return {
    has_source_ns: features.has_source_ns,
    has_rsscloud: features.has_rsscloud,
    rsscloud_style: features.rsscloud_style,
    cloud_json: cloud,
  };
}
