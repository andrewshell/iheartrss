/**
 * The `content/` loader (plan §6.4).
 *
 * Posts are parsed and rendered into an in-memory array, sorted newest first, and
 * the cache is invalidated by polling.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { parsePost } from './parse.js';

export function createBlog({ dir, pollMs = 30000, now = () => Date.now(), log }) {
  let cache = [];
  let signature = null;
  let checkedAt = -Infinity;

  function refresh() {
    const current = contentSignature(dir, log);
    checkedAt = now();

    if (current === signature) return;
    signature = current;
    cache = loadPosts(dir, log);
  }

  function fresh() {
    if (now() - checkedAt >= pollMs) refresh();
    return cache;
  }

  refresh();

  return {
    posts: fresh,
    latest: () => fresh()[0] ?? null,
    refresh,
  };
}

/**
 * `max(mtime)` across a `readdir` + `stat` of every `.md` file — **not** the
 * directory's own mtime (§6.4, measured). Adding or deleting a file bumps the
 * directory mtime, but **editing one does not**, so a directory-mtime poll
 * publishes new posts happily and then silently refuses to show a typo fix until
 * the container is restarted. The file count is in the signature too, so replacing
 * one file with another of the same mtime still invalidates.
 *
 * (`fs.watch` is unreliable across a Docker bind mount, so polling is the right
 * shape — this is just the right stat target.)
 */
function contentSignature(dir, log) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    // A missing content/ directory is an empty blog, not a dead site: the bind
    // mount in §9's compose file is created by hand on the host.
    log?.('blog.readdir_failed', { dir, error: err.message });
    return 'missing';
  }

  const files = names.filter((name) => name.toLowerCase().endsWith('.md')).sort();

  let newest = 0;
  for (const name of files) {
    try {
      newest = Math.max(newest, statSync(path.join(dir, name)).mtimeMs);
    } catch {
      // Deleted between readdir and stat. The next poll settles it.
    }
  }

  return `${files.length}:${newest}`;
}

function loadPosts(dir, log) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const posts = [];
  for (const filename of names.sort()) {
    let source;
    try {
      source = readFileSync(path.join(dir, filename), 'utf8');
    } catch {
      continue;
    }

    let post;
    try {
      post = parsePost({ filename, source });
    } catch (err) {
      // One malformed post must not take the whole blog — and with it the
      // homepage and the feed — down.
      log?.('blog.parse_failed', { filename, error: err.message });
      continue;
    }

    if (post !== null) posts.push(post);
  }

  // Newest first, tie-broken on filename (§6.4) so two posts on one date have a
  // defined order rather than whatever readdir happened to return.
  return posts.sort(
    (a, b) =>
      b.pubDate - a.pubDate ||
      (a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0),
  );
}
