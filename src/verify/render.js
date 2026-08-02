/**
 * The JS-rendering fallback for §5 Step 5.
 *
 * A growing number of otherwise perfectly good RSS sites are client-rendered shells:
 * the HTML `safeFetch` returns carries the feed link in `<head>` (so Steps 2–4 pass)
 * but the *body* — and with it the link-back — is assembled by JavaScript after load.
 * rss.chat is the case that forced this: its markup is a 13 KB jQuery shell and the
 * link to us lives in content fetched at runtime. Step 5 read that as "no link-back",
 * which is the one rejection that also means "opt-out" to §8.
 *
 * We do NOT run a browser. `createRenderer` posts the URL to a hosted rendering API
 * (Cloudflare Browser Rendering by default) and gets HTML back. That choice is
 * deliberate and the alternatives are worse *here specifically*:
 *
 *   * Chromium in the app image would run an unsandboxed JS engine — `cap_drop: [ALL]`
 *     and `no-new-privileges` block Chromium's own sandbox, so it would need
 *     `--no-sandbox` — in the container that holds `/data/iheartrss.db`, on a
 *     `mem_limit: 512m` that a browser does not fit inside.
 *   * A browser also does its own DNS and its own subresource fetches, which means
 *     **none** of `fetch.js`'s SSRF work applies to it. Off-loading that to a third
 *     party's network does not make the requests safe, but it does mean they are not
 *     being made from inside our network.
 *
 * Two rules this module exists to enforce:
 *
 *   * **The rendering API is an operator dependency, not a member's server.** Like
 *     `HEALTHCHECK_PING_URL` in `jobs/revalidate.js` it is reached with a plain
 *     `fetch`, not `safeFetch` — the SSRF policy is about untrusted targets, and this
 *     endpoint is neither untrusted nor member-controlled.
 *   * **The URL in the request body IS member-controlled**, so it is re-checked here
 *     before it is handed over. By this point it has already survived Step 0 and been
 *     fetched once, but "already fetched once" is not the same claim as "safe to ask a
 *     third party to fetch now", and the gap between the two is a DNS TTL.
 */

import { isIP } from 'node:net';

import { fetch as undiciFetch } from 'undici';

import { USER_AGENT } from '../lib/useragent.js';
import { isAllowedAddress } from './url.js';

/**
 * Blocked wholesale rather than trimmed: none of them can contain an `<a href>`, and
 * a render that skips them is both faster and cheaper. Stylesheets are deliberately
 * NOT in this list — scripts that measure layout before writing content are rare but
 * real, and a stylesheet is the one non-executable resource that can change what the
 * DOM ends up containing.
 */
const REJECTED_RESOURCE_TYPES = Object.freeze(['image', 'media', 'font']);

/**
 * `networkidle0` — no in-flight connections — which is what Cloudflare's own docs
 * call for: "the default page load behavior may return empty or incomplete results"
 * on JavaScript-heavy pages.
 *
 * `networkidle2` was here first and was a mistake. Tolerating two in-flight
 * connections means the render can resolve *before* the XHR that actually delivers
 * the content, and the failure that produces is the bad kind: not a timeout, but a
 * successfully-rendered empty shell that Step 5 reads as a missing link-back and §8
 * reads as an opt-out. A render that waits too long costs a retry; a render that
 * returns early costs a member their listing.
 *
 * The cost of being strict is bounded by `renderTimeoutMs`, and a page that never
 * goes quiet fails as `render_unavailable` — transient, which is the safe direction.
 */
const WAIT_UNTIL = 'networkidle0';

/**
 * @param {object} deps
 * @param {object} deps.config - `renderEnabled`, `renderApiUrl`, `renderApiToken`,
 *   `renderTimeoutMs`, `maxResponseBytes`.
 * @param {Function} [deps.log]
 * @param {Function} [deps.fetchImpl] - injected so `render.test.js` can answer the API
 *   without a network or a Cloudflare account.
 * @returns {Function|null} `renderPage(url, { budget })`, or **`null`** when rendering
 *   is not configured. Null rather than a no-op stub on purpose: `verifySite` branches
 *   on it, so an unconfigured deploy behaves exactly as it did before this file
 *   existed — no extra call, no new failure mode, no new reason code.
 */
export function createRenderer({ config, log = () => {}, fetchImpl = undiciFetch }) {
  if (!config.renderEnabled) return null;

  /**
   * @returns {Promise<object>} `{ ok: true, html }` or `{ ok: false, reason }`.
   *   Never throws: a rendering outage must be a *transient* verification result, not
   *   an exception that takes down a revalidation batch.
   */
  return async function renderPage(url, { budget } = {}) {
    if (!isRenderableTarget(url)) return { ok: false, reason: 'render_target_blocked' };

    // The render shares the submission's clock (§5, "Fetch budget"). Without this a
    // 20s render on top of Steps 1–4 walks a synchronous POST past the reverse
    // proxy's timeout — the budget exists precisely so no single step can do that.
    const remaining = budgetRemaining(budget);
    if (remaining <= 0 || budget?.signal?.aborted) {
      return { ok: false, reason: 'render_timeout' };
    }

    const timeoutMs = Math.min(config.renderTimeoutMs, remaining);
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (budget?.signal) signals.push(budget.signal);

    let response;
    try {
      response = await fetchImpl(config.renderApiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.renderApiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url,
          // The rendering API fetches on our behalf, so it has to identify itself the
          // way we do. A site owner who allowlisted the UA that /about names should
          // not start seeing an unfamiliar headless Chrome hitting them instead.
          userAgent: USER_AGENT,
          rejectResourceTypes: REJECTED_RESOURCE_TYPES,
          gotoOptions: { waitUntil: WAIT_UNTIL, timeout: timeoutMs },
        }),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      log('render.failed', { url, error: error.message });
      return { ok: false, reason: 'render_request_failed' };
    }

    if (!response.ok) {
      // The body is read for the log and then discarded. A 401 here is an operator
      // error (bad token) and a 429 is a quota wall; both look identical to a member
      // as `render_unavailable`, and only the log can tell them apart at 2am.
      log('render.rejected', {
        url,
        status: response.status,
        detail: await readCapped(response, 512),
      });
      return { ok: false, reason: 'render_http_error', status: response.status };
    }

    const body = await readCapped(response, config.maxResponseBytes);
    if (body === null) {
      log('render.too_large', { url });
      return { ok: false, reason: 'render_too_large' };
    }

    const html = extractHtml(body);
    if (html === null) {
      log('render.unreadable', { url, head: body.slice(0, 200) });
      return { ok: false, reason: 'render_unreadable' };
    }

    return { ok: true, html };
  };
}

/**
 * Cloudflare's v4 API wraps results as `{ success, result, errors }`, but this is the
 * one part of the contract their `/content` docs do not actually write down — and the
 * value of `renderApiUrl` is an operator knob, so it may not be Cloudflare at all.
 * Both shapes are therefore accepted: a JSON envelope carrying an HTML string, or a
 * response that is simply the HTML. Anything else is `null` and becomes a transient
 * failure rather than being fed to the anchor parser as if it were a page.
 */
function extractHtml(body) {
  const text = body.trim();

  if (text.startsWith('{')) {
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      return null;
    }

    if (envelope.success === false) return null;
    return typeof envelope.result === 'string' ? envelope.result : null;
  }

  return text === '' ? null : body;
}

/**
 * The same question `fetch.js`'s `assertHostAllowed` asks, for the same reason, at the
 * one moment `safeFetch` cannot ask it: we are about to hand a URL to something else
 * to fetch. A literal address is checked against the SSRF classifier; a *name* is not
 * resolved here, because resolving it would only tell us what it pointed at a moment
 * ago and the rendering API will resolve it again anyway.
 */
function isRenderableTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(hostname) === 0) return true;
  return isAllowedAddress(hostname);
}

/** `null` when the response exceeds `limit`, mirroring `fetch.js`'s size rule. */
async function readCapped(response, limit) {
  const buffer = await response.arrayBuffer().catch(() => null);
  if (buffer === null) return null;
  if (buffer.byteLength > limit) return null;
  return Buffer.from(buffer).toString('utf8');
}

function budgetRemaining(budget) {
  if (budget?.deadline === undefined) return Number.POSITIVE_INFINITY;
  return budget.deadline - Date.now();
}
