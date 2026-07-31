/**
 * `lib/assets.js` — the cache-busting version on `/style.css` and `/blog-roll.js`.
 *
 * The end-to-end contract (every page links the same versioned URL, a versioned
 * request is immutable, HTML is revalidated) lives in `headers.test.js`. What is
 * tested here is the part that has no HTTP in it: what the version is derived from,
 * when it moves, and what happens when the file is not there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { assetUrl } from '../src/lib/assets.js';

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 8);

test('the version is a digest of the file’s own bytes', () => {
  const bytes = readFileSync(
    fileURLToPath(new URL('../public/style.css', import.meta.url)),
  );

  assert.equal(assetUrl('/style.css'), `/style.css?v=${digestOf(bytes)}`);
});

test('a file that changes gets a new version without a restart', async (t) => {
  // `pnpm dev` runs `node --watch`, which does not restart for a file it never
  // imported — so a digest computed once per process would serve `?v=<yesterday>`
  // while the author edited the stylesheet and wondered why nothing changed.
  const name = '.assets-test-fixture.css';
  const path = fileURLToPath(new URL(`../public/${name}`, import.meta.url));
  t.after(() => rm(path, { force: true }));

  await writeFile(path, 'a{color:red}');
  const first = assetUrl(`/${name}`);
  assert.equal(first, `/${name}?v=${digestOf('a{color:red}')}`);

  // A different length as well as different bytes: the memo key is mtime+size, and a
  // filesystem with coarse timestamps must not be what this test depends on.
  await writeFile(path, 'a{color:rebeccapurple;font-weight:bold}');
  assert.notEqual(assetUrl(`/${name}`), first);
});

test('a missing file degrades to the bare path rather than throwing', () => {
  // This runs inside every page render. A broken deploy must cost the cache-busting,
  // never a 500 on every page in the site.
  assert.equal(assetUrl('/nope.css'), '/nope.css');
});

test('a path that escapes public/ is never read', () => {
  // Nothing calls this with user input today, and that is exactly the assumption
  // worth not encoding into the file-reading helper.
  for (const escape of ['/../package.json', '/../../etc/passwd']) {
    assert.equal(assetUrl(escape), escape);
  }
});
