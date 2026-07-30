/**
 * A local multi-host fixture HTTP server for the §5 pipeline tests.
 *
 * One server on 127.0.0.1 answers for as many virtual hosts as a test needs, routed
 * on the `Host` header, so the two §5 Step 4 hijack shapes — which are *about* the
 * relationship between an attacker host and a victim host — can be expressed as
 * fixtures rather than as mocks of our own code.
 */

import { createServer } from 'node:http';

import { createFetcher } from '../../src/verify/fetch.js';
import { isAllowedAddress } from '../../src/verify/url.js';

export const CONFIG = Object.freeze({
  fetchTimeoutMs: 2000,
  maxResponseBytes: 5 * 1024 * 1024,
  submitBudgetMs: 5000,
  linkbackHosts: Object.freeze(['iheartrss.com', 'www.iheartrss.com']),
});

export const BADGE = '<p><a href="https://iheartrss.com/">I ♥ RSS</a></p>';

/** Every hostname resolves to the fixture server, in the `all: true` shape. */
function loopbackLookup(hostname, options, cb) {
  if (options?.all) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
  return cb(null, '127.0.0.1', 4);
}

/**
 * `buildRoutes` is `(url) => ({ host: { path: handlerOrResponse } })` — a function
 * rather than a literal because fixtures have to name the server's ephemeral port in
 * the URLs they declare, and that isn't known until `listen` returns. A response is
 * `{ status?, type?, body?, location? }`; a function gets `(req, res, state)`.
 */
export async function withSites(buildRoutes, run) {
  const state = { hits: [] };
  let routes = {};

  const server = createServer((req, res) => {
    const host = String(req.headers.host ?? '')
      .split(':')[0]
      .toLowerCase();
    const path = req.url;
    state.hits.push(`${host}${path}`);

    const route = routes[host]?.[path];
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<html><body>not found</body></html>');
    }
    if (typeof route === 'function') return route(req, res, state);

    const headers = { 'content-type': route.type ?? 'text/html; charset=utf-8' };
    if (route.location !== undefined) headers.location = route.location;
    res.writeHead(route.status ?? 200, headers);
    res.end(route.body ?? '');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  /** Build an absolute URL for a virtual host on the fixture server. */
  state.url = (host, path = '/') => `http://${host}:${state.port}${path}`;
  routes = buildRoutes(state.url);

  // Test-only: 127.0.0.1 is where the fixture server lives. The production
  // classifier refuses it — correctly, since that is the SSRF case — so every test
  // that is *about* the guard must keep using the production classifier untouched.
  state.safeFetch = createFetcher({
    lookup: loopbackLookup,
    config: CONFIG,
    isAddressAllowed: (address) => address === '127.0.0.1' || isAllowedAddress(address),
  });

  try {
    return await run(state);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A minimal RSS 2.0 feed. `channelLink: null` omits `<channel><link>` entirely. */
export function rss({ title = 'A blog', channelLink, extra = '' } = {}) {
  const link =
    channelLink === null || channelLink === undefined
      ? ''
      : `<link>${channelLink}</link>`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0">' +
    `<channel><title>${title}</title>${link}` +
    '<item><title>First post</title></item>' +
    `${extra}</channel></rss>`
  );
}

/** An HTML page declaring `feedHref`, optionally carrying the link-back badge. */
export function html({ feedHref, badge = true, body = '' } = {}) {
  const link =
    feedHref === undefined
      ? ''
      : `<link rel="alternate" type="application/rss+xml" href="${feedHref}">`;
  return (
    `<html><head><title>A blog</title>${link}</head>` +
    `<body>${badge ? BADGE : ''}${body}</body></html>`
  );
}

export const FEED_TYPE = 'application/rss+xml; charset=utf-8';
