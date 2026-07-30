/**
 * The OPML subscription list (plan §7).
 *
 * `renderOpml` is a pure function of an outline set plus one timestamp, which is
 * what makes §11's hostile-fixture tests writable without a database.
 */

import { createHash } from 'node:crypto';

import { DESCRIPTION_MAX, normalizeMetaText, TITLE_MAX, xmlAttr } from './xml.js';

/**
 * §7: "`dateCreated` is the site's fixed launch date, not `now()` — the spec
 * defines it as when the *document* was created, and emitting the same value as
 * `dateModified` makes it meaningless."
 */
export const DATE_CREATED = 'Wed, 29 Jul 2026 14:00:00 GMT';

const TITLE = 'I ♥ RSS';

/**
 * Render one outline element. Exported because **this string is what gets hashed**:
 * §7's ETag covers the outline set and nothing else, so hashing the rendered
 * outlines — rather than a separate projection of the columns — makes it
 * structurally impossible for the hash and the body to disagree.
 */
export function renderOutline(row) {
  const title = normalizeMetaText(row.title, TITLE_MAX);
  const description = normalizeMetaText(row.description, DESCRIPTION_MAX);

  const attributes = [
    ['type', 'rss'],
    // §7: the OPML 2.0 spec enumerates RSS1 / RSS (0.91, 0.92 or 2.0) /
    // scriptingNews. `RSS2` is what the W3C validator also tolerates, not what the
    // spec names.
    ['version', 'RSS'],
    // Both: OPML 2.0 requires `text`, and older readers look for `title`.
    ['text', title],
    ['title', title],
    // §7: omitted rather than emitted empty when there is no description.
    ...(description ? [['description', description]] : []),
    ['xmlUrl', row.feed_url],
    // §7's invariant: `htmlUrl` is `sites.url`, the canonical URL we verified the
    // link-back on.
    ['htmlUrl', row.url],
  ];

  return `    <outline ${attributes
    .map(([name, value]) => `${name}="${xmlAttr(value)}"`)
    .join(' ')}/>`;
}

export function renderOutlines(outlines) {
  return outlines.map(renderOutline).join('\n');
}

/**
 * @param {object} args
 * @param {object} args.config - needs `siteUrl` for `ownerId`.
 * @param {object[]} args.outlines - rows in render order (§7: ordered by title).
 * @param {Date|string} args.dateModified - `directory_version.updated_at`.
 */
export function renderOpml({ config, outlines, dateModified }) {
  const owner = new URL('/', config.siteUrl);

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${xmlAttr(TITLE)}</title>
    <dateCreated>${DATE_CREATED}</dateCreated>
    <dateModified>${httpDate(dateModified)}</dateModified>
    <ownerName>${xmlAttr(owner.hostname)}</ownerName>
    <ownerId>${xmlAttr(owner.href)}</ownerId>
    <docs>http://opml.org/spec2.opml</docs>
  </head>
  <body>
${renderOutlines(outlines)}
  </body>
</opml>
`;
}

export function httpDate(value) {
  return (value instanceof Date ? value : new Date(value)).toUTCString();
}

/**
 * The hash that is the ETag: **the outline set only, never the `<head>`
 * timestamps** (§7).
 *
 * It hashes the *rendered* outline elements, so the validator and the body cannot
 * drift apart — anything that changes what a subscriber sees changes the hash, and
 * nothing else does. Hashing the whole document instead would be a 100% cache miss:
 * §8 writes `last_checked_at` ~480×/day, the §4 blanket rule bumps `version`, and
 * `<dateModified>` sits in the body, so the ETag would churn hourly in a week when
 * nothing about the directory changed, and readers would report "blogroll updated"
 * every hour forever.
 */
export function hashOutlines(outlines) {
  return createHash('sha256')
    .update(typeof outlines === 'string' ? outlines : renderOutlines(outlines))
    .digest('hex');
}

/**
 * The render path, with §7's lazy recompute.
 *
 * Two distinct steps, and conflating them is the trap:
 *
 *  1. Every write helper in `db/queries.js` bumps `directory_version.version`. That
 *     is a *trigger*, nothing more.
 *  2. Here, when `version` has moved since the last render, the outline set is
 *     re-selected and re-hashed — and `updated_at` advances **only if the hash
 *     actually differs**.
 *
 * The in-process memo is keyed on `version`, so it invalidates on any write. On a
 * cold start it is empty and the first request recomputes; if the hash matches what
 * is stored, `updated_at` does not move, so a restart is invisible to caches.
 */
export function createOpmlDocument({ queries, config, now = () => new Date() }) {
  let memo = null;

  return {
    render() {
      const {
        version,
        outline_hash: storedHash,
        updated_at: storedAt,
      } = queries.getDirectoryVersion();

      if (memo !== null && memo.version === version) return memo.rendered;

      const outlines = queries.listOutlines();
      const serialisedOutlines = renderOutlines(outlines);
      const outlineHash = hashOutlines(serialisedOutlines);

      // The whole point of the outline-set hash: an unchanged outline set leaves the
      // timestamp exactly where it was, however many writes moved `version`.
      let updatedAt = storedAt;
      if (outlineHash !== storedHash) {
        updatedAt = now().toISOString();
        queries.saveOutlineHash({ outlineHash, updatedAt });
      }

      const rendered = {
        body: renderOpml({ config, outlines, dateModified: updatedAt }),
        // A strong validator: the body is generated deterministically from the
        // hashed outline set, so it is byte-identical for a given hash.
        etag: `"${outlineHash}"`,
        lastModified: httpDate(updatedAt),
      };

      memo = { version, rendered };
      return rendered;
    },
  };
}
