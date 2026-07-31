/**
 * Cache-busting URLs for the files in `public/` (plan §6).
 *
 * `/style.css` is served with `Cache-Control: public, max-age=604800`, so a visitor
 * who loaded any page keeps that stylesheet for a week — and a deploy that changes it
 * reaches them a week later, or whenever they force-reload. That is the bug this
 * module exists for: people were still on the old styles after an update. The same
 * applies to `/blog-roll.js`, where it is worse, because stale *logic* against a live
 * third-party API fails in ways stale colours do not.
 *
 * **The version is a digest of the file's own bytes**, not the release number and not
 * the boot time. Both alternatives are wrong in one direction each: a release number
 * changes when the CSS did not (throwing away every visitor's cache for a docs-only
 * release), and a boot time changes on every restart (same, several times a deploy).
 * A content digest changes exactly when the file changes, which is the whole property
 * being bought — and it is what lets `routes/static.js` answer a versioned request
 * with `immutable`, since a given digest names one exact set of bytes forever.
 *
 * **Re-checked against `mtime`+`size` rather than computed once**, so `pnpm dev`
 * behaves: `node --watch` does not restart for a file it never imported, so a
 * digest cached for the process lifetime would keep serving `?v=<yesterday>` while
 * the author edited the stylesheet and wondered why nothing changed. The re-check is
 * one `statSync` per asset per render — the bytes are re-read and re-hashed only when
 * that stat actually moves, which in production is never.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The same directory `routes/static.js` serves, resolved the same way: from this
// module's location, so neither cares what directory the process started in.
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

/** `pathname` → `{ stamp, url }`, where `stamp` is the stat the digest was taken at. */
const memo = new Map();

/**
 * `/style.css` → `/style.css?v=1f4c0a7b`.
 *
 * **Never throws, and falls back to the bare path.** A missing or unreadable file
 * here means a broken deploy, and the response to that is an unversioned stylesheet
 * link — not a 500 on every page in the site. The tag still points where it always
 * did; only the cache-busting is lost.
 */
export function assetUrl(pathname) {
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  // The same containment check as the static route. Nothing calls this with user
  // input today, and that is exactly the assumption worth not encoding.
  if (!filePath.startsWith(PUBLIC_DIR)) return pathname;

  let stamp;
  try {
    const info = statSync(filePath);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    return pathname;
  }

  const cached = memo.get(pathname);
  if (cached !== undefined && cached.stamp === stamp) return cached.url;

  let digest;
  try {
    digest = createHash('sha256')
      .update(readFileSync(filePath))
      .digest('hex')
      .slice(0, 8);
  } catch {
    return pathname;
  }

  // 8 hex characters — 32 bits. This is a cache key, not a security boundary: the
  // only thing a collision could do is let one visitor keep a stale stylesheet, which
  // is the pre-existing behaviour it is replacing.
  const url = `${pathname}?v=${digest}`;
  memo.set(pathname, { stamp, url });
  return url;
}
