/**
 * Tell our rssCloud server that the feed may have changed (plan §6.4).
 *
 * One `POST https://rpc.rsscloud.io/ping` with `url=<our feed>`, sent once per boot.
 *
 * **Why every restart is the right trigger and not abuse.** The cloud server
 * re-fetches the URL itself and only fans out notifications to subscribers if the
 * content actually changed — so a restart that did not change the blog costs exactly
 * one request and notifies nobody. And blog posts ship *inside the image*
 * (`content/`), so "deploy a new image" is precisely when the feed changes. Restart is
 * therefore the cheapest trigger that never misses a publish, which is why there is no
 * interval here: this job ticks once and stops.
 */

import { isAllowedAddress, parseIpBytes } from '../verify/url.js';

/** Long enough for a busy public server, short enough that nothing waits on it. */
const PING_TIMEOUT_MS = 10_000;

/**
 * A moment after `serve()` is listening. The ping is never on the boot path — a
 * third-party host must not be able to delay our own startup by a single millisecond.
 */
const BOOT_DELAY_MS = 2_000;

/**
 * @param {object} deps
 * @param {object} deps.config - `rsscloudEnabled`, `rsscloudPingUrl`, `siteUrl`, `production`.
 * @param {Function} [deps.fetchFn] - injected so tests never touch the network.
 */
export function createRsscloudPing({
  config,
  log = () => {},
  fetchFn = (...args) => globalThis.fetch(...args),
}) {
  const feedUrl = new URL('/feed.xml', config.siteUrl).href;
  let handle = null;
  let clear = () => {};

  /**
   * Ping now. Resolves either way — it reports the outcome in its return value and
   * in the log, and **never** throws or rejects.
   */
  async function runOnce() {
    if (!config.production) {
      log('rsscloud.skipped', { reason: 'not_production', feed: feedUrl });
      return { skipped: 'not_production' };
    }

    const unreachable = notPubliclyReachable(config.siteUrl);
    if (unreachable !== null) {
      log('rsscloud.skipped', { reason: unreachable, feed: feedUrl });
      return { skipped: unreachable };
    }

    let response;
    try {
      response = await fetchFn(config.rsscloudPingUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // Without this the server answers with `<result success="true" …/>` XML.
          accept: 'application/json',
        },
        body: new URLSearchParams({ url: feedUrl }).toString(),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
    } catch (err) {
      // DNS failure, connection refused, or our own 10s timeout firing. All the same
      // answer: say so and carry on. Notifying subscribers faster is a nicety, and a
      // nicety may never be able to fail a boot or kill the process.
      log('rsscloud.ping_failed', {
        reason:
          err.name === 'TimeoutError' || err.name === 'AbortError'
            ? 'timeout'
            : 'fetch_failed',
        error: err.message,
      });
      return { pinged: false, error: err.message };
    }

    if (!response.ok) {
      // Logged as a failure rather than shrugged off: a cloud server answering 500
      // means our subscribers are not being notified, and the only place that can
      // ever be noticed is this line.
      log('rsscloud.ping_failed', { reason: 'http_status', status: response.status });
      return { pinged: false, status: response.status };
    }

    log('rsscloud.pinged', { url: config.rsscloudPingUrl, feed: feedUrl });
    return { pinged: true, status: response.status };
  }

  function start(timers = {}) {
    const {
      setTimeout: setTimeoutFn = globalThis.setTimeout,
      clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
    } = timers;

    if (!config.rsscloudEnabled) {
      log('rsscloud.disabled', { reason: 'RSSCLOUD_ENABLED' });
      return false;
    }

    handle = setTimeoutFn(() => runOnce(), BOOT_DELAY_MS);
    // unref'd like every other timer here: a pending ping must not hold the process
    // open past a SIGTERM and turn a redeploy into a SIGKILL.
    handle?.unref?.();

    clear = () => {
      if (handle !== null) clearTimeoutFn(handle);
      handle = null;
    };

    return true;
  }

  return { runOnce, start, stop: () => clear() };
}

/**
 * THE RULE, second half: `SITE_URL`'s host must be a name a stranger's server could
 * actually resolve and fetch. (The first half is `config.production`, in `runOnce` —
 * `pnpm dev` runs `node --watch`, and a ping per file-save at a live public server is
 * not a thing to ship.) Returns the skip reason, or `null` when it is fine.
 *
 * Refused: `localhost` and anything under `.localhost`, any IP literal that is not
 * global unicast (loopback, RFC 1918, CGNAT, link-local, `::1`), and any bare
 * hostname with no dot in it — `http://myhost:3000` is a LAN name, not a domain.
 *
 * Deliberately **not** `safeFetch`. That is the hardened path for URLs an attacker
 * supplied, and its DNS-pinning and redirect policy exist for a threat this does not
 * have: the host we are calling is a fixed value from our own config. What is being
 * classified here is the *payload* — the URL we are asking somebody else to fetch —
 * and the answer needs no DNS lookup, only the config the operator typed.
 */
function notPubliclyReachable(siteUrl) {
  const { hostname } = new URL(siteUrl);
  // WHATWG URL keeps IPv6 literals in brackets; `isIP` wants them bare.
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) return 'site_url_not_public';

  if (parseIpBytes(host) !== null) {
    return isAllowedAddress(host) ? null : 'site_url_not_public';
  }

  // No dot means no public DNS could answer for it.
  return host.includes('.') ? null : 'site_url_not_public';
}
