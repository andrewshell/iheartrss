/**
 * Filename, frontmatter and markdown parsing for the blog (plan §6.4).
 *
 * **No HTML sanitizer, deliberately** (§6.4). `marked`'s output is inserted into
 * the page and into `<description>` raw, because the content is *ours* and arrives
 * over the filesystem — a file in `content/`, put there by us or by the bind mount
 * in §9's compose file — not through a form. If this blog ever takes outside
 * contributions (guest posts, comments, anything a request body can reach), that
 * assumption breaks and a sanitizer becomes mandatory. Do not wire user input to
 * `parsePost` without adding one.
 */

import { marked } from 'marked';

/**
 * `YYYY-MM-DD.md` → `/blog/2026/07/29`, `YYYY-MM-DD-slug.md` →
 * `/blog/2026/07/29/slug`. Both shapes ship from day one (§6.4): bare dates allow
 * exactly one post per day, and the day you want two is the day every existing URL
 * has to change.
 *
 * Returns `null` for anything that is not a post filename, which is how the loader
 * skips a stray `README.md` or a `.swp` file rather than 500ing on it.
 */
const FILENAME = /^(\d{4})-(\d{2})-(\d{2})(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?\.md$/i;

export function parsePostFilename(name) {
  const match = FILENAME.exec(String(name));
  if (match === null) return null;

  const [, year, month, day, slug] = match;

  return {
    date: `${year}-${month}-${day}`,
    slug: slug === undefined ? null : slug.toLowerCase(),
  };
}

/**
 * A `content/` file → the post the rest of the app renders.
 *
 * Returns `null` when the filename is not a dated post, so the loader can skip
 * strays without special-casing them twice.
 */
export function parsePost({ filename, source }) {
  const name = parsePostFilename(filename);
  if (name === null) return null;

  const { title, time, body } = splitFrontmatter(String(source));
  const markdown = body.trim();

  return {
    filename: String(filename),
    date: name.date,
    slug: name.slug,
    title,
    pubDate: pubDateFor(name.date, time),
    markdown,
    html: marked.parse(markdown),
    path:
      name.slug === null
        ? `/blog/${name.date.replaceAll('-', '/')}`
        : `/blog/${name.date.replaceAll('-', '/')}/${name.slug}`,
  };
}

/**
 * Split an optional `---` frontmatter block off the front of the source.
 *
 * Hand-rolled, ~15 lines, and **flat `key: value` only** — no nesting, no lists,
 * no quoting rules, no multi-line values, no type coercion. That is the whole
 * limitation, and it is the point (§2): the alternative is `gray-matter`, which
 * drags in js-yaml to parse one flat block of at most two keys. If a post ever
 * needs a nested or list-valued key, this function is the thing that has to change
 * — deliberately, rather than silently mis-parsing.
 */
function splitFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (match === null) return { title: null, body: source };

  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key !== '') fields.set(key, value);
  }

  const title = fields.get('title');
  const time = fields.get('time');

  return {
    title: title === undefined || title === '' ? null : title,
    time: time === undefined || time === '' ? null : time,
    body: source.slice(match[0].length),
  };
}

/**
 * §6.4: **midday UTC**, not midnight. Midnight UTC puts an evening post written in
 * US Central on the *previous* day for every reader east of it, which is the wrong
 * date in the one place a date matters. `time:` (`HH:MM` or `HH:MM:SS`, UTC) is the
 * escape hatch for a post whose hour is worth stating.
 */
function pubDateFor(date, time) {
  const parsed = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(time ?? ''));

  const [hours, minutes, seconds] =
    parsed === null
      ? [12, 0, 0]
      : [Number(parsed[1]), Number(parsed[2]), Number(parsed[3] ?? 0)];

  const valid = hours <= 23 && minutes <= 59 && seconds <= 59;
  const clock = valid ? [hours, minutes, seconds] : [12, 0, 0];

  return new Date(
    `${date}T${clock.map((n) => String(n).padStart(2, '0')).join(':')}Z`,
  );
}
