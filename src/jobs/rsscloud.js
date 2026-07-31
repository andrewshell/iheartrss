/**
 * Tell our rssCloud server that one of our documents may have changed (plan §6.4).
 *
 * One `POST https://rpc.rsscloud.io/ping` with `url=<ours>`, for two documents on two
 * different triggers:
 *
 *  * **`/feed.xml`, once per boot.** The cloud server re-fetches the URL itself and
 *    only fans out notifications to subscribers if the content actually changed — so a
 *    restart that did not change the blog costs exactly one request and notifies
 *    nobody. And blog posts ship *inside the image* (`content/`), so "deploy a new
 *    image" is precisely when the feed changes. Restart is therefore the cheapest
 *    trigger that never misses a publish.
 *  * **`/subscriptions.opml`, when a feed joins the directory.** The OPML is the
 *    opposite kind of document: it lives in the database, so it changes at moments a
 *    restart knows nothing about and never changes at boot. Its trigger has to be the
 *    membership change itself — see `notifyOpmlChanged`.
 *
 * Neither is an interval, and that is the point: both are ticks off a real event.
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
 * The trailing-edge window `notifyOpmlChanged` coalesces adds into.
 *
 * Two members joining seconds apart are one change to the document, and the cloud
 * server re-fetches the whole OPML per ping — so pinging twice buys a subscriber
 * nothing and costs a stranger's server a second fetch of the same bytes. It is
 * deliberately short: the ping's only value over the cloud server's own polling is
 * promptness.
 */
const OPML_COALESCE_MS = 5_000;

/**
 * @param {object} deps
 * @param {object} deps.config - `rsscloudEnabled`, `rsscloudPingUrl`, `siteUrl`, `production`.
 * @param {Function} [deps.fetchFn] - injected so tests never touch the network.
 * @param {object} [deps.timers] - `setTimeout`/`clearTimeout` stand-ins for tests.
 */
export function createRsscloudPing({
  config,
  log = () => {},
  fetchFn = (...args) => globalThis.fetch(...args),
  timers = {},
}) {
  const {
    setTimeout: setTimeoutFn = globalThis.setTimeout,
    clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
  } = timers;

  const feedUrl = new URL('/feed.xml', config.siteUrl).href;
  const opmlUrl = new URL('/subscriptions.opml', config.siteUrl).href;

  let handle = null;
  let opmlHandle = null;

  /**
   * Ping now, for one of our URLs. Resolves either way — it reports the outcome in its
   * return value and in the log, and **never** throws or rejects.
   */
  async function ping(target) {
    if (!config.production) {
      log('rsscloud.skipped', { reason: 'not_production', target });
      return { skipped: 'not_production' };
    }

    const unreachable = notPubliclyReachable(config.siteUrl);
    if (unreachable !== null) {
      log('rsscloud.skipped', { reason: unreachable, target });
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
        body: new URLSearchParams({ url: target }).toString(),
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
        target,
        error: err.message,
      });
      return { pinged: false, error: err.message };
    }

    if (!response.ok) {
      // Logged as a failure rather than shrugged off: a cloud server answering 500
      // means our subscribers are not being notified, and the only place that can
      // ever be noticed is this line.
      log('rsscloud.ping_failed', {
        reason: 'http_status',
        target,
        status: response.status,
      });
      return { pinged: false, status: response.status };
    }

    log('rsscloud.pinged', { url: config.rsscloudPingUrl, target });
    return { pinged: true, status: response.status };
  }

  /** The boot ping: `/feed.xml`. Kept as the no-argument entry point the CLI calls. */
  const runOnce = () => ping(feedUrl);

  /** The membership ping: `/subscriptions.opml`, sent now rather than scheduled. */
  const pingOpml = () => ping(opmlUrl);

  /**
   * A feed just joined (or rejoined) the OPML — tell the cloud server, once, shortly.
   *
   * **Scheduled rather than awaited, and that is the whole design.** The caller is a
   * request handler finishing a submission: a member must not wait on rpc.rsscloud.io
   * to see their "you're listed" page, and that server being down or slow must not
   * turn a successful listing into a 500. The delay also gives the coalescing window
   * (see `OPML_COALESCE_MS`) something to coalesce *into* — a second add inside the
   * window rides the ping already scheduled.
   *
   * Returns whether this call scheduled one, which is what makes it testable without
   * a clock.
   */
  function notifyOpmlChanged() {
    if (!config.rsscloudEnabled) return false;
    // Already scheduled: one ping re-fetches the whole document, so it covers this
    // add too.
    if (opmlHandle !== null) return false;

    opmlHandle = setTimeoutFn(() => {
      opmlHandle = null;
      pingOpml();
    }, OPML_COALESCE_MS);
    opmlHandle?.unref?.();

    return true;
  }

  function start() {
    if (!config.rsscloudEnabled) {
      log('rsscloud.disabled', { reason: 'RSSCLOUD_ENABLED' });
      return false;
    }

    handle = setTimeoutFn(() => runOnce(), BOOT_DELAY_MS);
    // unref'd like every other timer here: a pending ping must not hold the process
    // open past a SIGTERM and turn a redeploy into a SIGKILL.
    handle?.unref?.();

    return true;
  }

  function stop() {
    if (handle !== null) clearTimeoutFn(handle);
    if (opmlHandle !== null) clearTimeoutFn(opmlHandle);
    handle = null;
    opmlHandle = null;
  }

  return { runOnce, pingOpml, notifyOpmlChanged, start, stop };
}

/**
 * THE RULE, second half: `SITE_URL`'s host must be a name a stranger's server could
 * actually resolve and fetch. (The first half is `config.production`, in `ping` —
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
