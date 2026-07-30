/**
 * The one XML escaper (plan §6.4, §7).
 *
 * §6.4 asks for `escapeXml` to be promoted out of `blog/feed.js` and shared rather
 * than reimplemented, and §7 asks for "one shared, tested `xmlAttr()`". Both live
 * here, and `blog/feed.js` re-exports `escapeXml` from this module so there is
 * exactly one implementation.
 *
 * §7 is explicit that this is an **admin-escalation surface, not a cosmetic one**:
 * `/subscriptions.opml` is served as `text/xml`, which browsers render, so an
 * escaping slip that admits `<script xmlns="http://www.w3.org/1999/xhtml">` is
 * same-origin script execution on iheartrss.com — and `SameSite=Strict` does not
 * protect `/admin` from a same-origin request.
 */

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * An attribute value: codepoint-filtered first, then escaped.
 *
 * The filter is the half that escaping cannot do. Escaping `&<>"'` is about
 * *structure*; a lone surrogate or U+FFFE is not a legal XML 1.0 character at all,
 * and one of them in one member's title makes the whole document non-well-formed
 * for every subscriber (§7) — a whole-directory denial of service from a single
 * submission.
 */
export function xmlAttr(value) {
  return escapeXml(xmlSafeText(value));
}

/**
 * Strip everything XML 1.0 cannot carry, plus the display attacks.
 *
 * Iterating with `for…of` is load-bearing: it walks **codepoints**, so a legal
 * astral pair arrives as one character and survives, while an unpaired surrogate
 * arrives on its own and is dropped. A regex character class over code units
 * cannot tell those two apart.
 *
 * XML 1.0's `Char` production is
 * `#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`.
 */
export function xmlSafeText(value) {
  let out = '';

  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);

    // Legal in XML, but a tab or newline inside an attribute value is normalised
    // to a space by every parser anyway, and neither belongs in a title.
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      out += ' ';
      continue;
    }
    if (cp < 0x20) continue; // C0 controls
    if (cp >= 0x7f && cp <= 0x9f) continue; // DEL + C1 controls
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogate
    if (cp === 0xfffe || cp === 0xffff) continue; // not Char
    if (cp >= 0x202a && cp <= 0x202e) continue; // bidi embeddings + overrides
    if (cp >= 0x2066 && cp <= 0x2069) continue; // bidi isolates

    out += ch;
  }

  return out;
}

/**
 * Cap a string at `max` **codepoints**, never code units: slicing a string by
 * `.slice()` can cut an astral pair in half and manufacture exactly the lone
 * surrogate `xmlSafeText` exists to remove.
 */
export function truncateCodepoints(value, max) {
  const chars = Array.from(String(value));
  return chars.length <= max ? String(value) : chars.slice(0, max).join('');
}

/**
 * Normalise a title or description for storage and for rendering (§7: "Cap lengths
 * at ingest … as well as at render"). Both ends call this, so a row written before
 * the cap existed still renders bounded.
 */
export function normalizeMetaText(value, max) {
  if (value === null || value === undefined) return value;

  const cleaned = xmlSafeText(value).replace(/ {2,}/g, ' ').trim();
  return truncateCodepoints(cleaned, max);
}

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 500;
