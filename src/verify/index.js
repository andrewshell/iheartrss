/**
 * `verifySite` — the §5 pipeline, Steps 0 through 6.
 *
 * It never throws for an expected failure: every outcome is a structured result with
 * a machine-readable `reason` so the UI can show a specific, actionable message.
 *
 * It deliberately does **not** persist. Step 7 (upsert, the `UNIQUE(feed_url)`
 * collision rules, the incumbent re-check) is phase 5; keeping it out means this
 * module has no database dependency and the whole pipeline is testable against a
 * fixture HTTP server.
 */

import { checkFeedProvenance, resolveCanonicalUrl } from './canonical.js';
import { parseFeed } from './feed.js';
import { findLinkBack, parsePage } from './page.js';
import { normalizeUrl } from './url.js';

/**
 * @param {object} deps
 * @param {Function} deps.safeFetch - from `createFetcher`; the only way out to the network.
 * @param {object} deps.config - `submitBudgetMs`, `linkbackHosts`.
 * @param {Function} [deps.isBanned] - `({host, path}) => boolean`, injected so Step 0.6
 *   can consult `banned_hosts` (§4) without this module taking a database dependency.
 * @param {Function|null} [deps.renderPage] - from `createRenderer`; the JS-rendering
 *   fallback for Step 5, or `null` when rendering is not configured. Null is the
 *   default so a deploy without credentials runs the pipeline exactly as it did
 *   before `render.js` existed.
 */
export function createVerifier({
  safeFetch,
  config,
  isBanned = () => false,
  renderPage = null,
}) {
  /**
   * @param {string} submittedUrl - raw user input.
   * @param {object} [options]
   * @param {object} [options.budget] - a caller-supplied shared budget, so Step 7's
   *   incumbent re-check spends the same clock as Steps 1–6 (§5, "Fetch budget").
   * @returns {Promise<object>} `{ ok: true, url, feedUrl, title, description, features,
   *   … }` or `{ ok: false, reason, … }`.
   * @param {boolean} [options.fixedCanonical] - §8's revalidation mode: the URL
   *   passed in **is** the canonical page. Step 4 does not run, so `sites.url` cannot
   *   move and cannot oscillate between two pages that name each other's feed;
   *   discovery still re-runs on that page, so a moved feed is picked up. The
   *   feed-shortcut in `startFromSubmitted` is skipped too: `sites.url` is a page by
   *   construction (a channel-link-less feed is `no_channel_link` at submission), and
   *   running an HTML link-back parser over an RSS document is how a member gets read
   *   as an opt-out for serving XML.
   * @param {object} [options.conditional] - `{ feedUrl, etag, lastModified }` from the
   *   row. Sent as `If-None-Match`/`If-Modified-Since` **only** when discovery lands
   *   on the same `feedUrl`: a validator belongs to one URL, and sent for another it
   *   would produce a 304 for a document we have never seen.
   */
  return async function verifySite(
    submittedUrl,
    { budget: sharedBudget, fixedCanonical = false, conditional = null } = {},
  ) {
    // ── Step 0 — normalize and pre-screen ────────────────────────────────────────
    const normalized = normalizeUrl(submittedUrl);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };

    // Step 0.6, using §4's FULL predicate — host or host-suffix AND path-prefix, so a
    // ban on `mastodon.social/@spammer` doesn't take out the whole instance. Checked
    // before any fetch: the point of a ban is to stop spending requests on them.
    const banHost = new URL(normalized.url);
    if (isBanned({ host: banHost.hostname, path: banHost.pathname })) {
      return { ok: false, reason: 'banned', url: normalized.url };
    }

    // §5's fetch budget: ONE budget shared by every fetch in this submission. Per-request
    // timeouts alone let 6 fetches × 5 redirect hops block a synchronous POST far past
    // any reverse-proxy timeout while the user resubmits and trips the rate limiter.
    const budget = sharedBudget ?? createBudget(config);

    // ── Step 1 — fetch the submitted page ────────────────────────────────────────
    const submitted = await fetchOk(safeFetch, normalized.url, {
      budget,
      kind: 'page',
      failure: 'page_fetch_failed',
    });
    if (!submitted.ok) return { ...submitted, url: normalized.url };

    // ── Step 2 — find the feed ───────────────────────────────────────────────────
    const start = await startFromSubmitted(submitted, {
      budget,
      fixedCanonical,
      conditional,
    });
    if (!start.ok) return start;

    const { submittedResourceWasFeed, feed } = start;
    let feedUrl = start.feedUrl;

    // ── Step 4 — resolve the canonical URL from `<channel><link>` ────────────────
    // §8: skipped entirely on revalidation. The page we fetched is the page we
    // publish, full stop.
    const canonical = fixedCanonical
      ? { ok: true, canonicalUrl: submitted.url, hasChannelLink: true }
      : resolveCanonicalUrl({
          submittedUrl: submitted.url,
          channelLink: feed.channelLink,
          submittedResourceWasFeed,
        });
    if (!canonical.ok) {
      return { ok: false, reason: canonical.reason, url: submitted.url, feedUrl };
    }

    let canonicalUrl = canonical.canonicalUrl;
    let canonicalHtml = submitted.body;
    let winningFeed = feed;

    if (canonicalUrl !== submitted.url) {
      // §5 Step 4: the feed we publish must come from the page we publish, so
      // discovery re-runs on the canonical page and *its* feed wins. The feed recorded
      // against `example.com/` is the one `example.com/` itself declares — never one
      // asserted by a third party's page. Canonical resolution runs **once**: we do not
      // re-derive a canonical from the second feed, so there is no loop.
      const page = await fetchOk(safeFetch, canonicalUrl, {
        budget,
        kind: 'page',
        failure: 'canonical_fetch_failed',
      });
      if (!page.ok) return { ...page, url: canonicalUrl, submittedUrl: submitted.url };

      canonicalUrl = page.url; // the final post-redirect URL becomes `sites.url`
      canonicalHtml = page.body;

      const rediscovered = await rediscoverOnCanonical(page, {
        budget,
        alreadyValidated: { feedUrl, feed },
      });
      if (!rediscovered.ok) {
        return { ...rediscovered, url: canonicalUrl, submittedUrl: submitted.url };
      }

      feedUrl = rediscovered.feedUrl;
      winningFeed = rediscovered.feed;
    }

    // The mutual half of the provenance rule, run in every case — including the one
    // where canonical fell back to the submitted URL, which is where the
    // channel-link-less hijack lives (§5 Step 4).
    //
    // Except behind a 304, where there is no document to read a `<channel><link>`
    // from: the bytes are the ones that already passed this check, at the same feed
    // URL (a validator is only ever sent for the feed we stored it against). Running
    // it on an empty body would fail every member whose feed is hosted off their own
    // host — a FeedBurner or Substack feed — for answering a conditional GET
    // correctly.
    const provenance = start.feedUnchanged
      ? { ok: true }
      : checkFeedProvenance({
          canonicalUrl,
          feedUrl,
          feedChannelLink: winningFeed.channelLink,
        });
    if (!provenance.ok) {
      return {
        ok: false,
        reason: provenance.reason,
        url: canonicalUrl,
        feedUrl,
        channelLink: winningFeed.channelLink,
      };
    }

    // ── Step 5 — find the link-back, on the CANONICAL page ───────────────────────
    // Not "either page": accepting it on the submitted page would break the consent
    // property, since being listed under a URL would no longer require that page's
    // owner to have opted in.
    let linkBack = findLinkBack(canonicalHtml, canonicalUrl, config.linkbackHosts);
    let linkBackRendered = false;

    // The JS-rendering fallback (`render.js`). Only ever reached when the served HTML
    // carries no link-back, which keeps the cost proportional to the failures rather
    // than the members: a site that passes on its own markup never touches it.
    //
    // The rendered document is resolved against `canonicalUrl`, not against whatever
    // the renderer ended up on. `canonicalUrl` is already post-redirect — `safeFetch`
    // followed and re-guarded every hop to get it — and it is the URL we publish, so
    // it is the only correct base for deciding whether *that page* links to us.
    if (linkBack === null && renderPage !== null) {
      const rendered = await renderPage(canonicalUrl, { budget });

      // §8's outcome table is ORDERED, and this is the ordering that matters most in
      // this file: a render that did not happen must never fall through to
      // `no_linkback`. `no_linkback` means "we read the page and the badge is gone",
      // which starts a member's removal clock; a Cloudflare outage is not evidence
      // about anybody's page. `classify` sends every other reason to `transient`, so
      // returning a distinct code here is the whole mechanism.
      if (!rendered.ok) {
        return {
          ok: false,
          reason: 'render_unavailable',
          renderReason: rendered.reason,
          url: canonicalUrl,
          submittedUrl: submitted.url,
          feedUrl,
        };
      }

      linkBack = findLinkBack(rendered.html, canonicalUrl, config.linkbackHosts);
      linkBackRendered = linkBack !== null;
    }

    if (linkBack === null) {
      return {
        ok: false,
        reason: 'no_linkback',
        url: canonicalUrl,
        submittedUrl: submitted.url,
        feedUrl,
        // Distinguishes "the page has no badge" from "the page has no badge and we
        // rendered it to be sure". Without it the logs cannot answer whether the
        // fallback is earning its keep.
        rendered: renderPage !== null,
      };
    }

    // ── Step 6 — optional feature detection (booleans, never fail the submission) ─
    return {
      ok: true,
      url: canonicalUrl,
      submittedUrl: submitted.url,
      feedUrl,
      title: winningFeed.title,
      description: winningFeed.description,
      linkBack,
      // True when the link was only visible after rendering. Carried so a member who
      // depends on the fallback is *visible* — in the logs, and to anyone asking why
      // the render quota is being spent.
      linkBackRendered,
      features: winningFeed.features,
      // §8's conditional GETs. `feedUnchanged` means the feed answered 304: it is
      // byte-identical to the document we already validated, so it still validates —
      // but there is no body, and `title`/`description`/`features` are therefore
      // absent rather than empty. A caller must keep what it already stored.
      feedUnchanged: start.feedUnchanged,
      feedEtag: start.feedEtag,
      feedLastModified: start.feedLastModified,
    };
  };

  /**
   * §5 Step 2's short-circuit. On a site about RSS a large share of people paste
   * `example.com/feed.xml` into the box; without this they get "we couldn't find an RSS
   * feed on your page" about a page that *is* an RSS feed.
   */
  async function startFromSubmitted(submitted, { budget, fixedCanonical, conditional }) {
    if (!fixedCanonical && looksLikeFeed(submitted)) {
      const parsed = parseFeed(submitted.body);
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason, feedUrl: submitted.url };
      }
      return {
        ok: true,
        submittedResourceWasFeed: true,
        feedUrl: submitted.url,
        feed: parsed,
      };
    }

    const discovered = discoverFeed(submitted);
    if (!discovered.ok) return { ...discovered, url: submitted.url };

    const fetched = await fetchAndParseFeed(discovered.feedUrl, {
      budget,
      failure: 'feed_fetch_failed',
      // Only for the feed we already have a validator for (see `conditional` above).
      conditional:
        conditional !== null && conditional?.feedUrl === discovered.feedUrl
          ? conditional
          : null,
    });
    if (!fetched.ok) return { ...fetched, url: submitted.url };

    return {
      ok: true,
      submittedResourceWasFeed: false,
      feedUrl: discovered.feedUrl,
      feed: fetched.feed,
      feedUnchanged: fetched.feedUnchanged,
      feedEtag: fetched.etag,
      feedLastModified: fetched.lastModified,
    };
  }

  /**
   * Rows 4 and 5 of §5 Step 4's decision table: a canonical page that declares no RSS
   * feed is `feed_not_declared_on_canonical`, and one whose feed won't fetch or fails
   * Step 3 is `canonical_feed_unavailable` — **transient**, retry later. Never
   * substitute a different feed.
   */
  async function rediscoverOnCanonical(page, { budget, alreadyValidated }) {
    const discovered = discoverFeed(page, {
      noneReason: 'feed_not_declared_on_canonical',
      otherFormatReason: 'feed_not_declared_on_canonical',
    });
    if (!discovered.ok) return discovered;

    // No extra fetch if it's the URL we already validated.
    if (discovered.feedUrl === alreadyValidated.feedUrl) {
      return { ok: true, feedUrl: discovered.feedUrl, feed: alreadyValidated.feed };
    }

    const fetched = await fetchAndParseFeed(discovered.feedUrl, {
      budget,
      failure: 'canonical_feed_unavailable',
      parseFailure: 'canonical_feed_unavailable',
    });
    if (!fetched.ok) return { ...fetched, feedUrl: discovered.feedUrl };

    return { ok: true, feedUrl: discovered.feedUrl, feed: fetched.feed };
  }

  async function fetchAndParseFeed(
    feedUrl,
    { budget, failure, parseFailure, conditional = null },
  ) {
    const response = await fetchOk(safeFetch, feedUrl, {
      budget,
      kind: 'feed',
      failure,
      headers: conditionalHeaders(conditional),
    });
    if (!response.ok) return { ...response, feedUrl };

    // A 304 is the cheapest possible way to honour the "good citizen" claim (§8):
    // the bytes are the ones we validated, so Step 3 has already been run on them.
    // `feed` carries no metadata, which is what `feedUnchanged` warns the caller of.
    if (response.status === 304) {
      return {
        ok: true,
        feed: { channelLink: undefined, features: {} },
        feedUnchanged: true,
        etag: response.etag ?? conditional?.etag,
        lastModified: response.lastModified ?? conditional?.lastModified,
      };
    }

    const parsed = parseFeed(response.body);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: parseFailure ?? parsed.reason,
        feedUrl,
        feedReason: parsed.reason,
      };
    }

    return {
      ok: true,
      feed: parsed,
      etag: response.etag,
      lastModified: response.lastModified,
    };
  }
}

/** §8's conditional GET headers, or nothing at all. */
function conditionalHeaders(conditional) {
  if (conditional === null || conditional === undefined) return undefined;

  const headers = {};
  if (conditional.etag) headers['if-none-match'] = conditional.etag;
  if (conditional.lastModified) headers['if-modified-since'] = conditional.lastModified;
  return Object.keys(headers).length === 0 ? undefined : headers;
}

/**
 * The one shared clock for a submission (§5, "Fetch budget"). Created by the route so
 * Steps 1–6 and Step 7's incumbent re-check together stay inside `SUBMIT_BUDGET_MS` —
 * two separate budgets would let one POST run for twice it.
 */
export function createBudget(config) {
  return {
    deadline: Date.now() + config.submitBudgetMs,
    signal: AbortSignal.timeout(config.submitBudgetMs),
  };
}

/**
 * §5 Step 2's two buckets. Atom and JSON-feed candidates are collected deliberately:
 * without them an Atom-only site gets `no_feed_link` — "we couldn't find an RSS feed
 * link" — while the author stares at a perfectly good
 * `<link rel="alternate" type="application/atom+xml">` and concludes we're broken.
 */
function discoverFeed(
  response,
  { noneReason = 'no_feed_link', otherFormatReason = 'feed_not_rss2' } = {},
) {
  const page = parsePage(response.body, response.url);

  if (page.feedUrl !== null) {
    return { ok: true, feedUrl: page.feedUrl, candidates: page.rssCandidates };
  }

  if (page.otherFormatCandidates.length > 0) {
    return {
      ok: false,
      reason: otherFormatReason,
      // Naming the exact feed we found is what turns the most common rejection on the
      // site from "this site is broken" into an invitation (§5 Step 2).
      otherFormatUrl: page.otherFormatCandidates[0].url,
      otherFormatType: page.otherFormatCandidates[0].type,
    };
  }

  return { ok: false, reason: noneReason };
}

/**
 * Is the fetched resource itself a feed rather than an HTML page? Content type first,
 * then the document's own root element — plenty of real feeds are served as
 * `text/plain` or `text/html`, and a submitted Atom feed has to reach Step 3's
 * carefully-worded refusal rather than "we couldn't find a feed on your page".
 */
function looksLikeFeed({ body, contentType }) {
  const type = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') return false;
  if (/(^|\/|\+)(rss|atom|rdf)(\+xml)?$/.test(type) || type === 'application/feed+json') {
    return true;
  }

  const head = String(body ?? '')
    .slice(0, 2048)
    .replace(/^\uFEFF/, '')
    .trimStart();
  const withoutProlog = head
    .replace(/^<\?xml[^>]*\?>\s*/i, '')
    .replace(/^<!--[\s\S]*?-->\s*/, '');
  return /^<(rss|feed|rdf:RDF)\b/i.test(withoutProlog);
}

/**
 * `safeFetch` plus the status rules §5 needs: a completed exchange is not a success.
 *
 * A persistent 403 is `blocked_by_site`, not a failure of the member's making —
 * verified against `medium.com/@dhh`, Vercel, AWS WAF and Substack custom domains. The
 * message has to say plainly that bot protection is the usual cause and offer the human
 * path, so it needs its own reason code (§5 Step 4).
 */
async function fetchOk(safeFetch, url, { budget, kind, failure, headers }) {
  const response = await safeFetch(url, { budget, kind, headers });

  if (!response.ok) {
    return { ok: false, reason: response.reason, fetchedUrl: url };
  }

  if (response.status === 403) {
    return { ok: false, reason: 'blocked_by_site', status: 403, fetchedUrl: url };
  }

  // A 304 answers a conditional GET we sent on purpose (§8): "unchanged", not a
  // failure. Only the caller that supplied the validators can see one.
  if (response.status !== 304 && (response.status < 200 || response.status >= 300)) {
    return { ok: false, reason: failure, status: response.status, fetchedUrl: url };
  }

  return response;
}
