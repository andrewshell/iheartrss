/**
 * Client-IP derivation (plan §6, "Client-IP derivation is where these usually fail").
 *
 * Everything downstream — the rate limiter and the stored `ip_hash` — is only as
 * trustworthy as this function, so the two failure modes are handled explicitly:
 *
 *  * **`xff.split(',')[0]` is a one-header bypass.** The leftmost entry is 100%
 *    client-supplied, because a proxy *appends* the peer it saw. It is also how
 *    anyone poisons `submissions.ip_hash` to frame a specific address.
 *  * **`TRUSTED_PROXY_HOPS` counts proxies to skip PAST the rightmost entry**, so
 *    a single nginx means `0`, not `1`. nginx's `$proxy_add_x_forwarded_for` (and
 *    the Caddy/Traefik equivalents) appends the immediate peer, so with one proxy
 *    the app sees `<client garbage>, <real peer>` and the client is the LAST
 *    entry. Peeling 1 would return the attacker's forged value — this bug is the
 *    bypass it was meant to prevent, off by one.
 */

import { isIP } from 'node:net';

import { parseIpBytes, isAllowedAddress } from '../verify/url.js';

/**
 * @param {{header: (name: string) => string|undefined, peer: string|undefined}} req
 * @param {{trustProxy: boolean, trustedProxyHops: number}} config
 * @param {Function} [onReject] - called when a trusted-proxy setup sees a public peer.
 * @returns {string} the client address, or '' if there is genuinely none.
 */
export function clientIp(req, { trustProxy, trustedProxyHops = 0 }, onReject) {
  const peer = normalizeAddress(req.peer) ?? '';

  if (!trustProxy) return peer;

  // §6: the process cannot see whether Docker published the port on 0.0.0.0 or
  // 127.0.0.1 — `-p` is invisible from inside the container. So rather than
  // asserting something unobservable, check the immediate peer is on a private
  // network. A public peer with TRUST_PROXY=true is a direct connection that
  // bypassed the proxy, and its X-Forwarded-For is pure attacker input.
  if (peer !== '' && isAllowedAddress(peer)) {
    onReject?.({ peer });
    return peer;
  }

  const entries = String(req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => normalizeAddress(entry))
    .filter((entry) => entry !== null);

  if (entries.length === 0) return peer;

  const index = entries.length - 1 - trustedProxyHops;
  return index >= 0 ? entries[index] : peer;
}

/** Adapter for a Hono context; `getConnInfo` is the node-server's peer accessor. */
export function contextIp(c, config, onReject) {
  return clientIp(
    {
      header: (name) => c.req.header(name),
      peer: peerAddress(c),
    },
    config,
    onReject,
  );
}

function peerAddress(c) {
  // `app.request()` in tests has no socket at all, so every accessor here is
  // optional — a missing peer is a legitimate state, not an error.
  return (
    c.env?.incoming?.socket?.remoteAddress ??
    c.env?.remoteAddress ??
    c.env?.server?.requestIP?.(c.req.raw)?.address ??
    undefined
  );
}

/**
 * The rate-limit bucket key. IPv6 is keyed on the /64 (not the /128): a
 * residential customer has ~18 quintillion addresses, so per-address limits are
 * decorative (§6).
 */
export function rateLimitKey(ip) {
  const bytes = parseIpBytes(ip);
  if (bytes === null) return `raw:${String(ip ?? '')}`;
  if (bytes.length === 4) return `v4:${bytes.join('.')}`;

  const prefix = [...bytes.subarray(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v6:${prefix}/64`;
}

// `[2001:db8::1]:41234` is what a proxy writes for an IPv6 peer, and node itself
// hands back `::ffff:10.0.0.1` for an IPv4 connection over a dual-stack socket.
function normalizeAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') return null;

  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(text);
  if (bracketed) text = bracketed[1];
  else if (isIP(text) === 0 && /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(':'));
  }

  if (isIP(text) === 0) return null;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  return mapped ? mapped[1] : text;
}
