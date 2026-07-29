/**
 * URL normalisation, link-back matching, and the shared IP classifier (plan §5).
 */

import { isIP } from 'node:net';

export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return { ok: false, reason: 'invalid_url' };

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }

  // WHATWG `URL` already lowercases the host and drops the default port for
  // http/https, so §5 Step 0.3 only leaves the fragment to strip.
  url.hash = '';

  stripTrackingParams(url);

  // Step 0.5 (empty path → `/`) needs no code: WHATWG `URL` gives every
  // http/https URL at least a `/` pathname, and leaves deeper paths untouched.
  return { ok: true, url: url.href };
}

/**
 * The SSRF classifier (§5 Step 1), shared by `guardedLookup` (DNS answers) and
 * `assertHostAllowed` (IP literals in the URL). Two copies would drift.
 *
 * An **allowlist of global unicast**, not a deny list of the bad ranges: a deny
 * list always trails IANA (it misses `::/96` and `0100::/64` on the first pass and
 * feels finished anyway). Everything that is not provably a routable public
 * address is refused.
 *
 * It works on **bytes** and never string-matches — see `parseIpBytes`.
 */
export function isAllowedAddress(address) {
  const bytes = parseIpBytes(address);
  if (bytes === null) return false;

  return bytes.length === 4 ? isGlobalUnicastV4(bytes) : isGlobalUnicastV6(bytes);
}

/**
 * Parse an IPv4 or IPv6 address to bytes: 4 bytes for v4, 16 for v6, `null` if it
 * is not an address at all. Returns 4 bytes for an IPv4-mapped IPv6 address, so
 * the caller classifies the address rather than its spelling.
 */
export function parseIpBytes(address) {
  const text = String(address ?? '').trim();
  const family = isIP(text);

  if (family === 4) return parseV4Bytes(text);
  if (family !== 6) return null;

  const bytes = parseV6Bytes(text);
  if (bytes === null) return null;

  // Un-map IPv4-mapped IPv6 by byte inspection: 10 zero bytes, then 0xff 0xff.
  // A `startsWith('::ffff:')` test would only catch the *dotted* spelling that
  // `dns.lookup` returns, and miss `[::ffff:7f00:1]` — which is what WHATWG
  // `URL` actually hands us for `http://[::ffff:127.0.0.1]/`.
  const isV4Mapped =
    bytes.subarray(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;

  return isV4Mapped ? bytes.subarray(12, 16) : bytes;
}

function isGlobalUnicastV4([a, b, c]) {
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 protocol assignments
  // 0.0.0.0/8 — unspecified; 0.0.0.1 routes to localhost on Linux.
  if (a === 0) return false;
  if (a === 10) return false; // 10/8 private
  if (a === 127) return false; // 127/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return false; // 169.254/16 link-local (incl. 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12 private
  if (a === 192 && b === 168) return false; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 benchmark
  if (a >= 224) return false; // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  return true;
}

function isGlobalUnicastV6(bytes) {
  // Allowlist: only 2000::/3 is global unicast. That single test disposes of `::1`,
  // `::`, `fc00::/7`, `fe80::/10`, `ff00::/8`, the `::/96` IPv4-compatible range and
  // `0100::/64` without naming any of them — which is the point of an allowlist.
  if ((bytes[0] & 0xe0) !== 0x20) return false;

  // Inside 2000::/3, refuse the ranges that embed or tunnel an IPv4 address: a
  // 6to4 or Teredo address is a way to spell 127.0.0.1 in hex.
  const isTeredo =
    bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0;
  const is6to4 = bytes[0] === 0x20 && bytes[1] === 0x02;

  return !isTeredo && !is6to4;
}

function parseV4Bytes(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseV6Bytes(text) {
  let rest = text;

  // A trailing dotted quad (`::ffff:127.0.0.1`, `64:ff9b::192.0.2.1`) becomes the
  // two hextets it stands for, so the rest of the parse is uniform.
  const lastColon = rest.lastIndexOf(':');
  const tail = rest.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4Bytes(tail);
    if (v4 === null) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    rest = `${rest.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = rest.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tailGroups =
    halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];

  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tailGroups];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    const value = Number.parseInt(groups[i], 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/**
 * Do two URLs share a scheme + host + port? Used by §5 Step 4 to decide whether
 * the canonical page is the page we already fetched.
 */
export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * §5 Step 5: does `href`, resolved against the page it was found on, point at one
 * of our link-back hosts?
 *
 * Host match only — scheme, path and trailing slash are all irrelevant, which is
 * why a text link and an image link need no separate handling. Resolution goes
 * through `URL` rather than a substring search of the raw HTML, so a mention of
 * "iheartrss.com" inside a `<code>` block or comment is not a link-back.
 */
export function isLinkBack(href, baseUrl, linkbackHosts) {
  const hosts = (linkbackHosts ?? []).map((h) => String(h).toLowerCase());
  if (hosts.length === 0) return false;

  let resolved;
  try {
    resolved = new URL(String(href ?? ''), baseUrl);
  } catch {
    return false;
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return false;
  }

  return hosts.includes(resolved.hostname.toLowerCase());
}

/**
 * §5 Step 0.4: remove the *named* tracking params and nothing else. Dropping the
 * whole query string would rewrite `?p=123` — a genuine permalink on a
 * query-string WordPress install — into the site's front page, so the page we
 * verify would not be the page we store.
 */
function stripTrackingParams(url) {
  if (url.search === '') return;

  for (const name of [...url.searchParams.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith('utm_') || lower === 'fbclid' || lower === 'ref') {
      url.searchParams.delete(name);
    }
  }

  // `searchParams.delete` leaves a lone `?` behind once the last param goes.
  if ([...url.searchParams.keys()].length === 0) url.search = '';
}
