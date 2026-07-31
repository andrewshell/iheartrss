/**
 * The one stylesheet, where a rule can only be wrong in a way no other test sees.
 *
 * Nothing here re-tests CSS itself. It guards a specific drift that already shipped
 * twice: `.submit-form`'s field styling is written as an explicit list of input
 * types, in *two* places — the base rule and the `min-width: 40rem` cap — and a type
 * missing from either list renders unlike every field stacked beside it. It is
 * invisible in review (the lists are 400 lines apart) and invisible on a phone (the
 * second one is behind a media query).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

/** Every `input[type='…']` named in the rule whose body declares `prop`. */
function inputTypesInRuleDeclaring(prop) {
  const blocks = [];

  for (const match of css.matchAll(/([^{}]*\binput\[type=[^{}]*)\{([^}]*)\}/g)) {
    if (new RegExp(`(^|[;\\s])${prop}\\s*:`).test(match[2])) {
      blocks.push([...match[1].matchAll(/input\[type='([a-z]+)'\]/g)].map((m) => m[1]));
    }
  }

  return blocks;
}

test('the two .submit-form field rules name the same input types', () => {
  // `width` is the base rule; `max-width: var(--measure)` is the ≥40rem cap.
  const [base] = inputTypesInRuleDeclaring('width');
  const capped = inputTypesInRuleDeclaring('max-width')
    .filter((types) => types.length > 1)
    .at(-1);

  assert.ok(base?.length, 'no .submit-form field rule found — has it been renamed?');
  assert.deepEqual(
    [...capped].sort(),
    [...base].sort(),
    'a field type styled at one breakpoint but not the other stretches past its siblings',
  );
});

test('every input type the forms actually use is styled', async () => {
  // The list that matters is not "the types someone remembered" but "the types the
  // views render". `password` (admin login) and `number` (the per-domain cap) were
  // both missing, and both rendered as bare browser chrome inside a styled form.
  const views = ['admin.js', 'submit.js', 'status.js'];
  const used = new Set();

  for (const name of views) {
    const source = await readFile(
      new URL(`../src/views/${name}`, import.meta.url),
      'utf8',
    );
    for (const [, type] of source.matchAll(/<input[^>]*\btype="([a-z]+)"/g)) {
      // `hidden` has nothing to render and `submit` is a button, not a field.
      if (type !== 'hidden' && type !== 'submit') used.add(type);
    }
  }

  const [styled] = inputTypesInRuleDeclaring('width');

  for (const type of used) {
    assert.ok(styled.includes(type), `input[type='${type}'] is rendered but not styled`);
  }
});
