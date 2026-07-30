/**
 * HTML parsing: feed autodiscovery (plan §5 Step 2) and link-back detection
 * (§5 Step 5).
 */

import { parse as parseHtml } from 'node-html-parser';

import { isLinkBack } from './url.js';

/**
 * @param {string} html
 * @param {string} documentUrl - the **final** post-redirect URL of the fetch.
 */
export function parsePage(html, documentUrl) {
  const root = parseHtml(String(html ?? ''));
  const baseUrl = resolveBase(root, documentUrl);

  const scored = collectCandidates(root, baseUrl, RSS_TYPES)
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate) }))
    .sort(compareCandidates);

  return {
    baseUrl,
    rssCandidates: scored,
    // Deliberately collected even though Step 3 will refuse them: it turns the
    // most common rejection on the site from "this site is broken" into the
    // moment we make our actual argument (§5 Step 2).
    otherFormatCandidates: collectCandidates(root, baseUrl, OTHER_FEED_TYPES),
    feedUrl: scored.length > 0 ? scored[0].url : null,
  };
}

/**
 * §5 Step 5: collect every `<a href>`, resolve each against the page's base URL
 * (honouring `<base href>`), and return the first that resolves to a host in
 * `LINKBACK_HOSTS` — or `null`.
 *
 * Parsing rather than substring-searching the raw HTML is the whole point: a
 * substring search matches the URL sitting in a `<code>` block or an HTML
 * comment, which would let people list without actually linking. Scheme, path and
 * trailing slash are all ignored by `isLinkBack`, so a text link and an image link
 * need no separate handling.
 */
export function findLinkBack(html, documentUrl, linkbackHosts) {
  const root = parseHtml(String(html ?? ''), { comment: false });
  const baseUrl = resolveBase(root, documentUrl);

  for (const anchor of root.querySelectorAll('a')) {
    const href = anchor.getAttribute('href');
    if (href === undefined || href === null) continue;
    if (!isLinkBack(href, baseUrl, linkbackHosts)) continue;

    const resolved = resolve(href, baseUrl);
    if (resolved !== null) return resolved;
  }

  return null;
}

const RSS_TYPES = new Set(['application/rss+xml']);

const OTHER_FEED_TYPES = new Set(['application/atom+xml', 'application/feed+json']);

function collectCandidates(root, baseUrl, types) {
  const candidates = [];

  for (const link of root.querySelectorAll('link')) {
    const type = normalizeType(link.getAttribute('type'));
    if (!types.has(type)) continue;
    if (!hasAlternateRel(link.getAttribute('rel'))) continue;

    const url = resolve(link.getAttribute('href'), baseUrl);
    if (url === null) continue;

    candidates.push({ url, type, title: link.getAttribute('title') ?? '' });
  }

  return candidates;
}

/**
 * The ordered scoring function from §5 Step 2 — deliberately a score, not a
 * chain of filters: "first hit wins" over three rules is ambiguous about whether
 * a rule that matches nothing eliminates everything.
 */
function scoreCandidate({ url, title }) {
  let score = 0;

  // Trailing-slash normalisation is load-bearing: WordPress's canonical feed URL
  // is `/feed/` **with** the slash, so a naive `endsWith('/feed')` misses the
  // single most common platform on the web.
  const path = pathOf(url).replace(/\/+$/, '');
  if (/\/(feed|rss|index|atom)(\.xml)?$/i.test(path)) score += 3;

  if (/comment/i.test(title)) score -= 5;
  if (/categor|tag|author/i.test(title)) score -= 2;

  return score;
}

function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return pathOf(a.url).length - pathOf(b.url).length;
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** §5 Step 2: resolve against `<base href>` if present, not just the document URL. */
function resolveBase(root, documentUrl) {
  const href = root.querySelector('base')?.getAttribute('href');
  return resolve(href, documentUrl) ?? documentUrl;
}

function resolve(href, baseUrl) {
  const raw = String(href ?? '').trim();
  if (raw === '') return null;

  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * §5 Step 2: `rel` must *contain* `alternate` or be absent. The autodiscovery
 * spec requires `rel="alternate"` exactly; accepting a missing `rel` is a
 * deliberate leniency, recorded there as such.
 */
function hasAlternateRel(rel) {
  if (rel === undefined || rel === null || String(rel).trim() === '') return true;
  return String(rel).toLowerCase().split(/\s+/).includes('alternate');
}

/** Case-insensitive, and tolerating a `; charset=` suffix on the type. */
function normalizeType(type) {
  return String(type ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}
