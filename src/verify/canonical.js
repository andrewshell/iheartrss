/**
 * Plan §5 Step 4 — the canonical URL, and the mutual-provenance rule.
 *
 * The rule is one sentence: **the page we publish must itself advertise the feed we
 * publish, and that feed must claim that page back.** There is no fallback. Two
 * earlier drafts had one ("if the canonical page declares no usable feed, use the
 * submitted page's feed provided the origins match") and both were broken, because
 * every origin-based condition is satisfied by the same single capability — write one
 * file to the victim's origin. Tightening the conditions cannot fix that, since the
 * conditions and the attack use the same primitive.
 *
 * Note what this file does NOT do: compare registrable domains. The previous design
 * used `tldts` for that and had three holes, the fatal one being that `getDomain()`
 * returns `github.io` for both `evil.github.io` and `victim.github.io` at the default
 * settings. Host equality plus mutual declaration replaces all of it.
 */

import { normalizeUrl } from './url.js';

/**
 * §5 Step 4.1–4.2: read `<channel><link>`, normalize it with the same rules as Step 0.
 *
 * A feed with no channel link falls back to the submitted URL — unless the submitted
 * resource was **itself a feed**, in which case there is nothing to fall back to that
 * is a *page*. Without that carve-out `sites.url` and the OPML `htmlUrl` become the
 * feed URL, sending subscribers to raw XML, and Step 5 runs an HTML anchor parser over
 * an RSS document where a CDATA-wrapped link in a post body would pass and an
 * entity-escaped one wouldn't.
 */
export function resolveCanonicalUrl({
  submittedUrl,
  channelLink,
  submittedResourceWasFeed,
}) {
  const declared =
    channelLink === null || channelLink === undefined || String(channelLink).trim() === ''
      ? null
      : normalizeUrl(channelLink);

  if (declared !== null && declared.ok) {
    return { ok: true, canonicalUrl: declared.url, hasChannelLink: true };
  }

  if (submittedResourceWasFeed) {
    return { ok: false, reason: 'no_channel_link' };
  }

  return { ok: true, canonicalUrl: submittedUrl, hasChannelLink: false };
}

/**
 * §5 Step 4's mutual-provenance check, rows 1–3 of the decision table.
 *
 * It is a *check*, not a re-derivation, so "canonical resolution runs once, no loop"
 * still holds; in the common case where the canonical feed is the feed we already
 * validated it is satisfied by construction.
 *
 * Rows 4 and 5 (`canonical_feed_unavailable`, `feed_not_declared_on_canonical`) are
 * decided by whether a fetch and a Step 3 parse succeeded at all, so they belong to
 * the orchestrator in `index.js`.
 */
export function checkFeedProvenance({ canonicalUrl, feedUrl, feedChannelLink }) {
  const canonicalHost = hostOf(canonicalUrl);
  if (canonicalHost === null) return { ok: false, reason: 'feed_not_owned_by_canonical' };

  // Row 3: a feed making no claim of its own is accepted only when it is self-hosted
  // on the canonical host. Without this the second direction is vacuous — an attacker
  // page declaring the victim's channel-link-less feed passes every other test.
  if (
    feedChannelLink === null ||
    feedChannelLink === undefined ||
    String(feedChannelLink).trim() === ''
  ) {
    return hostOf(feedUrl) === canonicalHost
      ? { ok: true }
      : { ok: false, reason: 'feed_not_owned_by_canonical' };
  }

  // Rows 1 and 2. Host equality, never a registrable-domain comparison: `tldts` at its
  // defaults calls `evil.github.io` and `victim.github.io` the same domain.
  return hostOf(feedChannelLink) === canonicalHost
    ? { ok: true }
    : { ok: false, reason: 'feed_not_owned_by_canonical' };
}

function hostOf(url) {
  const normalized = normalizeUrl(url);
  if (!normalized.ok) return null;
  return new URL(normalized.url).hostname.toLowerCase();
}
