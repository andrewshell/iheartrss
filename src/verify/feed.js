/**
 * Feed parsing, the RSS-2.0-only format gate, and optional feature detection
 * (plan §5 Steps 3 and 6).
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Every one of these settings is load-bearing — see §5 Step 3:
 * - `ignoreAttributes: false` / `attributeNamePrefix: '@_'` — we read `version`,
 *   `xmlns:*` and the five `<cloud>` attributes.
 * - `removeNSPrefix: false` — `source:` prefixes and `@_xmlns:source` must stay intact.
 * - `parseTagValue: false` — otherwise `<title>2026</title>` becomes the *number*
 *   2026 and a blog legitimately called "2024" crashes `title.trim()`.
 * - `processEntities: true` + `htmlEntities: true` — together they are the only
 *   combination that decodes both `&amp;` and numeric references, so titles are
 *   stored as "Rock & Roll ’n Café" rather than "Rock &amp; Roll &#8217;n Caf&#233;".
 *   The DOCTYPE scan below, not `processEntities: false`, is the entity defence.
 */
const PARSER_OPTIONS = Object.freeze({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  parseTagValue: false,
  htmlEntities: true,

  // `processEntities` in object form, which is `true` PLUS an explicit
  // `maxTotalExpansions`. The boolean shorthand defaults that ceiling to **1000**, and
  // that number is a count of *every* entity reference in the document, including the
  // five predefined XML ones. Found by running `pnpm verify http://scripting.com/`
  // against the live site: the real feed has 2193 references (700 `&lt;`, 700 `&gt;`,
  // 554 `&quot;`, 234 `&#10;`, 5 `&amp;`) across 50 items, so `parse()` threw
  // "Entity expansion limit exceeded: 1020 > 1000", the try/catch below mapped it to
  // `feed_invalid`, and the site's flagship prospective member could not join. Every
  // full-content WordPress feed hits the same wall.
  //
  // Raising it does **not** weaken §5 Step 3's defence, and both halves are still here:
  //   - `maxEntitySize` (10 KB) and `maxEntityCount` (1000) stay at their 4.5.4 defaults.
  //     Those two, plus `maxExpandedLength`, are the ones that bound *DTD-declared*
  //     entities — the actual amplification vector.
  //   - `declaresDoctypeOrEntity` below rejects any document containing `<!DOCTYPE` or
  //     `<!ENTITY` outside CDATA *before* `parse()` runs, so by this point no custom
  //     entity can exist at all.
  // What remains is character references, each expanding to exactly one character. They
  // cannot amplify, so their count is linear in the body size and already bounded by
  // `MAX_RESPONSE_BYTES` (5 MB ÷ 4 bytes minimum per reference).
  processEntities: {
    enabled: true,
    maxTotalExpansions: 2_000_000,
    maxEntitySize: 10000,
    maxEntityCount: 1000,
    maxExpandedLength: 100000,
  },
});

/**
 * @param {string} text - the decoded feed body.
 * @returns {{ok: true, ...}|{ok: false, reason: string}} `reason` is one of
 *   `feed_invalid`, `feed_not_rss2`.
 */
export function parseFeed(text) {
  const source = stripLeadingNoise(text);

  if (declaresDoctypeOrEntity(source)) return { ok: false, reason: 'feed_invalid' };

  const validation = XMLValidator.validate(source);
  if (validation !== true) return { ok: false, reason: 'feed_invalid' };

  let tree;
  try {
    tree = new XMLParser(PARSER_OPTIONS).parse(source);
  } catch {
    return { ok: false, reason: 'feed_invalid' };
  }

  const format = validateFeedFormat(tree);
  if (!format.ok) return format;

  const { channel } = format;

  return {
    ok: true,
    title: sanitizeText(readText(channel, 'title'), TITLE_MAX),
    description: sanitizeText(readText(channel, 'description'), DESCRIPTION_MAX),
    channelLink: readText(channel, 'link'),
    features: detectFeatures({ rss: format.rss, channel, source }),
  };
}

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 500;

/**
 * §7: cap lengths **at ingest** as well as at render, and strip everything that is
 * not a legal XML 1.0 character.
 *
 * The codepoint filter is the important half. A lone surrogate (U+D800–DFFF) or
 * U+FFFE/U+FFFF in a hostile `<channel><title>` makes `/subscriptions.opml` not
 * well-formed **for every subscriber** until an admin notices — a whole-directory
 * denial of service from one submission. Filtering by control-character *class*
 * alone misses it, so this filters by codepoint validity: C0 minus tab/LF/CR, C1,
 * bidi overrides, unpaired surrogates and the non-characters.
 */
export function sanitizeText(text, maxLength) {
  if (text === null || text === undefined) return null;

  const cleaned = String(text)
    // Lone surrogates only: a well-formed pair (any astral-plane emoji) survives.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // C0 minus tab/LF/CR, then DEL and the C1 block.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[\u007F-\u009F]/g, '')
    // Bidi marks, embeddings, overrides and isolates — U+202E is the one §7 names.
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    // The non-characters §7 names alongside the lone surrogates.
    .replace(/[\uFFFE\uFFFF]/g, '')
    .trim();

  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

const SOURCE_NS_HOST = 'source.scripting.com';

/** §5 Step 6: booleans, never a reason to fail the submission. */
function detectFeatures({ rss, channel, source }) {
  const sourceNs = detectSourceNs({ rss, channel, source });
  const cloud = detectCloud({ channel, prefix: sourceNs.prefix });

  return {
    has_source_ns: sourceNs.present,
    source_ns_prefix: sourceNs.prefix,
    has_rsscloud: cloud.style !== null,
    rsscloud_style: cloud.style,
    cloud: cloud.attributes,
    cloud_url: cloud.url,
  };
}

/** The five attributes the rssCloud spec requires of `<cloud>`. */
const CLOUD_ATTRIBUTES = Object.freeze([
  'domain',
  'port',
  'path',
  'registerProcedure',
  'protocol',
]);

/**
 * §5 Step 6: `element` (`<channel><cloud …/>`), `source`
 * (`<channel><source:cloud>URL</source:cloud>`) or `both`. `element` will dominate;
 * `both` is a rarity worth celebrating, which is different UI treatment.
 */
function detectCloud({ channel, prefix }) {
  const element = read(channel, 'cloud');
  const hasElement = element !== undefined;

  // Whichever prefix is actually bound to the source namespace, not a literal `source:`.
  const sourceCloud = prefix === null ? undefined : read(channel, `${prefix}:cloud`);
  const hasSource = sourceCloud !== undefined;

  const style = hasElement && hasSource ? 'both' : hasElement ? 'element' : hasSource ? 'source' : null;

  const attributes = hasElement
    ? Object.fromEntries(
        CLOUD_ATTRIBUTES.map((name) => [
          name,
          readAttribute(asArray(element)[0], name) ?? '',
        ]),
      )
    : null;

  return {
    style,
    attributes,
    url: hasSource ? readText(channel, `${prefix}:cloud`) : null,
  };
}

/**
 * True if the root `<rss>` binds **any** prefix to the source namespace (`http` or
 * `https`, with or without a trailing slash) — or if any element uses that bound
 * prefix.
 */
function detectSourceNs({ rss, channel, source }) {
  const prefix = findSourceNsPrefix(rss);
  if (prefix === null) {
    return { present: false, prefix: null };
  }

  // The declaration alone is enough (scripting.com declares `source:` and uses it),
  // but record whether it is actually used so §6's UI can distinguish the two.
  return {
    present: true,
    prefix,
    used: usesPrefix({ channel, prefix, source }),
  };
}

function findSourceNsPrefix(rss) {
  if (typeof rss !== 'object' || rss === null) return null;

  for (const key of Object.keys(rss)) {
    if (!key.startsWith('@_xmlns:')) continue;

    let host;
    try {
      host = new URL(String(rss[key]).trim()).hostname.toLowerCase();
    } catch {
      continue;
    }

    // Host equality, not `includes` — `source.scripting.com.evil.example` must not match.
    if (host === SOURCE_NS_HOST) return key.slice('@_xmlns:'.length);
  }

  return null;
}

/**
 * §5 Step 6: the element scan must be **bounded**. A 5 MB body affords ~200k nesting
 * levels, and a recursive walk over `<a><a><a>…` blows the stack and kills the
 * process. Cheaper still, as suggested there: regex the raw text for the bound prefix
 * first and only walk if it is present.
 */
function usesPrefix({ channel, prefix, source }) {
  const marker = new RegExp(`<${escapeRegExp(prefix)}:`);
  if (!marker.test(source)) return false;

  const stack = [channel];
  let budget = 50000;

  while (stack.length > 0 && budget > 0) {
    const node = stack.pop();
    budget -= 1;

    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (typeof node !== 'object' || node === null) continue;

    for (const key of Object.keys(node)) {
      if (key.startsWith(`${prefix}:`)) return true;
      stack.push(node[key]);
    }
  }

  return false;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * §5 Step 3: strip the BOM **and** leading whitespace before validating. A blank
 * line before `<?xml` — a classic WordPress output-buffering artifact — otherwise
 * fails validation with "XML declaration allowed only at the start of the
 * document", rejecting an otherwise-fine feed as `feed_invalid`.
 */
function stripLeadingNoise(text) {
  return String(text ?? '').replace(/^﻿/, '').replace(/^\s+/, '');
}

/**
 * §5 Step 3: reject `<!DOCTYPE` / `<!ENTITY` found **anywhere** outside CDATA,
 * case-insensitively — not just in the prolog.
 *
 * A prolog-only scan is bypassed by placement: a DOCTYPE *after* the root element
 * still declares and expands entities, and `XMLValidator.validate()` returns `true`
 * on it (verified: the parsed title of a post-root `<!ENTITY a "PWNED">` feed is
 * "PWNED"). This scan, together with the `fast-xml-parser >= 4.5.4` pin, is the
 * entity defence — `processEntities: false` was measured to be both insufficient
 * here and destructive to every title containing an ampersand.
 *
 * CDATA is excluded so a post *about* HTML doesn't false-positive.
 */
function declaresDoctypeOrEntity(source) {
  const outsideCdata = source.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  return /<!\s*(doctype|entity)\b/i.test(outsideCdata);
}

/** The one RSS-2.0-only gate (§5 Step 3). */
function validateFeedFormat(tree) {
  const rss = read(tree, 'rss');
  if (rss === undefined) return { ok: false, reason: 'feed_not_rss2' };

  // Reject `0.9*` and `1.0`; accept `2.0*` or missing. The spec requires `2.0`, but
  // this gate exists to exclude Atom and 0.9x — not to police `version="2.00"`, which
  // occurs in the wild. Anything unrecognised is logged, not rejected (§5 Step 3).
  const version = readAttribute(rss, 'version');
  if (version !== null && /^(0\.9|1\.0)/.test(version)) {
    return { ok: false, reason: 'feed_not_rss2' };
  }

  const channels = asArray(read(rss, 'channel'));
  if (channels.length !== 1) return { ok: false, reason: 'feed_invalid' };

  const channel = channels[0];
  if (typeof channel !== 'object' || channel === null) {
    return { ok: false, reason: 'feed_invalid' };
  }

  const title = readText(channel, 'title');
  if (title === null || title === '') return { ok: false, reason: 'feed_invalid' };

  // `link` OR at least one `item` — not requiring items, because a brand new blog
  // with an empty feed is still a real RSS lover. Recorded leniency: the spec also
  // requires `description`; we don't, so a minimal hand-rolled feed isn't turned away.
  const items = asArray(read(channel, 'item'));
  if (readText(channel, 'link') === null && items.length === 0) {
    return { ok: false, reason: 'feed_invalid' };
  }

  return { ok: true, rss, channel };
}

/**
 * §5 Step 3: singular nodes come back as **objects**, not arrays — a one-item feed
 * gives `item` as an object while scripting.com's 50-item feed gives an array, so
 * without this every "at least one" test is `.length of undefined` in production.
 */
export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * `Object.hasOwn` rather than dotted access: `__proto__` and `constructor` are
 * legal XML element names (§5 Step 3).
 */
function read(node, name) {
  if (typeof node !== 'object' || node === null) return undefined;
  return Object.hasOwn(node, name) ? node[name] : undefined;
}

function readAttribute(node, name) {
  const value = read(node, `@_${name}`);
  return value === undefined || value === null ? null : String(value).trim();
}

/** A text child as a trimmed string, or `null` when it is absent or not text. */
function readText(node, name) {
  const value = read(node, name);
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    // `<link/>` self-closed, or an element with attributes: `#text` holds the value.
    const inner = read(value, '#text');
    return inner === undefined ? null : String(inner).trim();
  }
  return String(value).trim();
}
