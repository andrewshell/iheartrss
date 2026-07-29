/**
 * `safeFetch` — the single hardened fetcher every outbound request goes through
 * (plan §5 Step 1).
 */

import { isIP } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';

import { isAllowedAddress } from './url.js';

const MAX_REDIRECTS = 5;

const USER_AGENT = 'iheartrss.com validator (+https://iheartrss.com/about)';

const DEFAULT_HEADERS = Object.freeze({
  'user-agent': USER_AGENT,
  // A bare UA with no Accept headers is the easiest bot signature to fingerprint,
  // and being blocked is a top-3 real-world failure mode (§8).
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en;q=0.9,*;q=0.5',
});

/**
 * @param {object} deps
 * @param {Function} deps.lookup - REQUIRED, and injected rather than imported so
 *   §11's DNS-rebinding test is a five-line stub instead of a TTL-0 nameserver.
 * @param {object} deps.config - `fetchTimeoutMs`, `maxResponseBytes`.
 * @param {Function} [deps.isAddressAllowed] - the classifier. Injected only so the
 *   test fixture server on 127.0.0.1 is reachable without weakening production.
 */
export function createFetcher({
  lookup,
  config,
  isAddressAllowed = isAllowedAddress,
}) {
  if (typeof lookup !== 'function') {
    throw new TypeError('createFetcher requires a `lookup` function');
  }

  // Half 1 of the SSRF guard: one resolution, used for both the decision and the
  // socket. Node's `fetch` resolves independently of any pre-check, so
  // resolve-then-check-then-fetch loses the race against a TTL-0 record.
  const agent = new Agent({
    connect: { lookup: createGuardedLookup({ lookup, isAddressAllowed }) },
  });

  // Half 2: the lookup hook is never called for an IP literal, so every dispatch
  // (and every redirect hop) is checked explicitly. Measured: `http://127.0.0.1/`
  // returns 200 with 0 lookup calls, so half 1 alone is wide open.
  function assertHostAllowed(target) {
    // `net.isIP('[::1]')` is 0 — an unstripped check silently no-ops on exactly
    // the IPv6 literals it exists to catch.
    const hostname = target.hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (isIP(hostname) === 0) return true; // a name: half 1 covers it
    return isAddressAllowed(hostname);
  }

  /** The scheme + host gate. Runs before every dispatch, including every hop. */
  function guard(target) {
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return 'invalid_url';
    }

    // A `Location: file:///etc/passwd` is a hard reject, not a scheme to try.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'unsupported_scheme';
    }

    return assertHostAllowed(parsed) ? null : 'ssrf_blocked';
  }

  async function attempt(url, { budget, kind }) {
    const blocked = guard(url);
    if (blocked !== null) return { result: { ok: false, reason: blocked } };

    // ONE signal per safeFetch call, shared by every hop: created per hop, "8s
    // total" quietly becomes 40s across five redirects.
    const remaining = budgetRemaining(budget);
    if (remaining <= 0 || budget?.signal?.aborted) {
      return { result: { ok: false, reason: 'timeout' } };
    }

    const timeouts = [AbortSignal.timeout(Math.min(config.fetchTimeoutMs, remaining))];
    if (budget?.signal) timeouts.push(budget.signal);
    const signal = AbortSignal.any(timeouts);

    let current = url;
    // Whether the server ever answered. A scheme fallback is only right when the
    // connection itself failed — a 4xx/5xx is an answer.
    let receivedResponse = false;

    // Manual redirects so every hop is re-guarded. `redirect: 'follow'` would hand
    // the whole chain to undici, and a redirect to an IP literal is the easiest way
    // to miss half 2.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response;
      try {
        response = await undiciFetch(current, {
          dispatcher: agent,
          headers: { ...DEFAULT_HEADERS },
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        return { result: { ok: false, reason: classifyFetchError(error) }, receivedResponse };
      }

      receivedResponse = true;

      const location = response.headers.get('location');
      if (!isRedirect(response.status) || location === null) {
        let bytes;
        try {
          bytes = await readCapped(response, config.maxResponseBytes);
        } catch (error) {
          return { result: { ok: false, reason: classifyFetchError(error) }, receivedResponse };
        }

        // The cap is an error, never a truncation: a truncated page parses fine
        // and merely lacks the link-back, which §8 would read as an opt-out and
        // permanently delist a member whose homepage just got big.
        if (bytes === TOO_LARGE) {
          return { result: { ok: false, reason: `${kind}_too_large` }, receivedResponse };
        }

        const contentType = response.headers.get('content-type');
        const charset = detectCharset(bytes, contentType, kind);

        return {
          result: {
            ok: true,
            status: response.status,
            url: current,
            body: decode(bytes, charset),
            contentType,
            charset,
          },
          receivedResponse,
        };
      }

      await response.body?.cancel().catch(() => {});

      try {
        current = new URL(location, current).href;
      } catch {
        return { result: { ok: false, reason: 'invalid_url' }, receivedResponse };
      }

      const hopBlocked = guard(current);
      if (hopBlocked !== null) {
        return { result: { ok: false, reason: hopBlocked }, receivedResponse };
      }
    }

    return { result: { ok: false, reason: 'too_many_redirects' }, receivedResponse };
  }

  /**
   * @param {string} url
   * @param {object} [options]
   * @param {object} [options.budget] - `{ signal, deadline }` for the whole
   *   submission (§5's fetch budget), shared by every fetch in one submission.
   * @param {'page'|'feed'} [options.kind] - names the size-cap reason code.
   *
   * Resolves to `{ ok: true, status, url, body, contentType, charset }` for any
   * completed exchange — `url` is the **final** URL after redirects, which is what
   * Step 2 parses and Step 4 compares origins against — or
   * `{ ok: false, reason }` with one of `ssrf_blocked`, `unsupported_scheme`,
   * `invalid_url`, `timeout`, `too_many_redirects`, `page_too_large` /
   * `feed_too_large`, `fetch_failed`. A 403 or 500 is a completed exchange, not a
   * failure: §8 needs to tell those apart, so the status is handed back and the
   * caller decides.
   */
  return async function safeFetch(url, { budget, kind = 'page' } = {}) {
    const first = await attempt(url, { budget, kind });

    if (!shouldRetryOverHttp(url, first)) return first.result;

    // §5's scheme fallback: Step 0 defaults a scheme-less submission to https, and
    // https://scripting.com/ really does fail while http://scripting.com/ returns
    // 200. Only ever on a connection or TLS failure, never on a status.
    const downgraded = new URL(url);
    downgraded.protocol = 'http:';

    const second = await attempt(downgraded.href, { budget, kind });
    return second.result;
  };
}

function shouldRetryOverHttp(url, { result, receivedResponse }) {
  if (result.ok || receivedResponse) return false;
  // `ssrf_blocked` and `timeout` must not get a second roll of the dice.
  if (result.reason !== 'fetch_failed') return false;
  return new URL(url).protocol === 'https:';
}

/**
 * Wraps an injected `lookup` so a resolution that is not global unicast never
 * reaches a socket.
 *
 * Exported because two parts of its contract are easy to get wrong and invisible
 * from the outside: `options.all` must be honoured (undici's autoSelectFamily path
 * calls this as `{ hints: 1024, all: true }`, and the single-address callback shape
 * then throws `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` for *every*
 * hostname fetch), and a rejection must call back with a tagged `Error` — `cb(null,
 * [])` produces an opaque `TypeError: Cannot destructure property 'address'`
 * instead of a reason code.
 */
export function createGuardedLookup({ lookup, isAddressAllowed = isAllowedAddress }) {
  return function guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options ?? {});

    lookup(hostname, { ...opts, all: true }, (err, answers) => {
      if (err) return cb(err);

      const addresses = (Array.isArray(answers) ? answers : [answers])
        .map((answer) =>
          typeof answer === 'string' ? { address: answer, family: 4 } : answer,
        )
        .filter((answer) => answer && isAddressAllowed(answer.address));

      if (addresses.length === 0) return cb(ssrfBlocked(hostname));

      if (opts.all) return cb(null, addresses);
      return cb(null, addresses[0].address, addresses[0].family);
    });
  };
}

/**
 * undici wraps everything a connection can do wrong in `TypeError: fetch failed`
 * and hides the real cause one or more links down `error.cause` (or inside an
 * `AggregateError`), so the guard's reason code has to be dug back out.
 */
function classifyFetchError(error) {
  for (const link of causeChain(error)) {
    if (link?.code === 'SSRF_BLOCKED') return 'ssrf_blocked';
  }
  for (const link of causeChain(error)) {
    // `AbortSignal.timeout` aborts with a `TimeoutError`; a caller-aborted budget
    // signal surfaces as `AbortError`. Both mean "we ran out of time".
    if (link?.name === 'TimeoutError' || link?.name === 'AbortError') return 'timeout';
  }
  return 'fetch_failed';
}

/** `Infinity` when no budget was supplied — `FETCH_TIMEOUT_MS` is then the only cap. */
function budgetRemaining(budget) {
  if (budget?.deadline === undefined) return Infinity;
  return budget.deadline - Date.now();
}

function* causeChain(error, depth = 0) {
  if (!error || depth > 8) return;
  yield error;

  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) yield* causeChain(nested, depth + 1);
  }
  yield* causeChain(error.cause, depth + 1);
}

/**
 * `Content-Type` first, then the document's own declaration, then UTF-8.
 *
 * The declaration matters: older WordPress and hand-rolled feeds really are
 * Latin-1 and say so only in the XML declaration, and decoding those as UTF-8
 * mangles every title we publish. (`node:24-alpine` ships full ICU, so
 * `windows-1252`, `gbk` and `shift_jis` all decode without the `full-icu` package.)
 */
function detectCharset(bytes, contentType, kind) {
  const fromHeader = /charset\s*=\s*"?([^";,\s]+)/i.exec(contentType ?? '');
  if (fromHeader) return fromHeader[1].toLowerCase();

  // Sniff the head of the document as ASCII: enough for a declaration, and
  // wrong-charset bytes further down cannot confuse it.
  const head = bytes.subarray(0, 2048).toString('latin1');

  if (kind === 'feed') {
    const declaration = /<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i.exec(head);
    if (declaration) return declaration[1].toLowerCase();
  } else {
    const meta =
      /<meta[^>]+charset\s*=\s*["']?([^"'>;\s]+)/i.exec(head) ??
      /<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i.exec(head);
    if (meta) return meta[1].toLowerCase();
  }

  return 'utf-8';
}

function decode(bytes, charset) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // An unknown or misspelled label is common in the wild; UTF-8 is the better
    // guess than failing the whole submission over it.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const TOO_LARGE = Symbol('too_large');

/**
 * Streaming byte counter. undici decompresses transparently, so this measures
 * *decompressed* bytes and gzip-bomb protection comes free.
 */
async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return TOO_LARGE;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function ssrfBlocked(hostname) {
  const error = new Error(`Refusing to connect to ${hostname}: not a public address`);
  error.code = 'SSRF_BLOCKED';
  return error;
}
