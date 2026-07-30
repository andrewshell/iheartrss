/**
 * The public write routes (plan §6): `/submit`, `/check`, `/status`, `/report`.
 *
 * Every one of the POSTs here is same-origin-checked and rate-limited before it can
 * cost us an outbound request, and the order matters: cheapest gate first.
 */

import { contextIp } from '../lib/clientip.js';
import { isSameOrigin } from '../lib/sameorigin.js';
import { createBudget } from '../verify/index.js';
import { normalizeUrl } from '../verify/url.js';
import { reportPage, statusPage } from '../views/status.js';
import { submitPage } from '../views/submit.js';

export function registerSubmit(app, deps) {
  const { config, queries, verifySite, persist, hashIp, limiter, semaphore, log } = deps;

  app.get('/submit', (c) => c.html(submitPage({ config })));

  app.post('/submit', (c) => handleSubmission(c, { dryRun: false }));

  // §6: "Must be POST and share /submit's rate limit." As a GET with a `?url=`
  // parameter this was an unauthenticated request amplifier — `<img src="…
  // /check?url=victim">` turns every visitor to any page into an attack packet from
  // our IP, and prefetchers and crawlers fire it too.
  app.post('/check', async (c) => {
    c.header('X-Robots-Tag', 'noindex');
    return handleSubmission(c, { dryRun: true });
  });

  /**
   * §6: with no accounts and no email this is the ONLY way a member can find out
   * why they vanished, and `/sites` deliberately omits dropped/removed/hidden.
   */
  app.get('/status', (c) => {
    c.header('X-Robots-Tag', 'noindex');

    const raw = c.req.query('url') ?? '';
    if (raw.trim() === '') return c.html(statusPage({ config, query: '' }));

    const normalized = normalizeUrl(raw);
    if (!normalized.ok) {
      return c.html(statusPage({ config, query: raw, invalid: true }), 400);
    }
    if (queries === null) return c.html(statusPage({ config, query: raw, site: null }));

    // Matches the canonical `url` OR the `submitted_url`: `sites.url` is the
    // canonical URL, but a member types what they submitted, which is often a
    // different page (§6, and `idx_sites_submitted` in §4 exists for this).
    const row = queries.getSiteBySubmittedUrl(normalized.url);

    // §6: report `hidden` as a NEUTRAL "not listed", never as "moderated" —
    // otherwise this hands back exactly the oracle that `/submit` and `/recheck`
    // contort themselves to avoid.
    const visible = row === undefined || row.status === 'hidden' ? null : row;

    return c.html(statusPage({ config, query: raw, url: normalized.url, site: visible }));
  });

  app.get('/report', (c) => {
    const url = c.req.query('url') ?? '';
    return c.html(reportPage({ config, url }));
  });

  app.post('/report', async (c) => {
    if (!isSameOrigin(c, config)) {
      return c.html(reportPage({ config, url: '', error: 'cross_origin' }), 403);
    }

    const ip = clientAddress(c);
    const gate = limiter.take(ip);
    if (!gate.ok) {
      return c.html(
        reportPage({
          config,
          url: '',
          error: 'rate_limited',
          retryAfterSeconds: gate.retryAfterSeconds,
        }),
        429,
        { 'Retry-After': String(gate.retryAfterSeconds) },
      );
    }

    const form = await c.req.parseBody();
    const url = String(form.url ?? '').trim();
    const reason = String(form.reason ?? '').trim();

    if (url === '' || reason === '') {
      return c.html(reportPage({ config, url, error: 'incomplete' }), 400);
    }
    if (queries === null) return c.html(reportPage({ config, url, error: 'error' }), 503);

    const normalized = normalizeUrl(url);
    const match = normalized.ok
      ? queries.getSiteBySubmittedUrl(normalized.url)
      : undefined;

    queries.insertReport({
      site_id: match?.id,
      url: normalized.ok ? normalized.url : url,
      reason: reason.slice(0, 2000),
      contact:
        String(form.contact ?? '')
          .trim()
          .slice(0, 200) || undefined,
      ip_hash: hashIp(ip),
    });
    log('report.filed', {
      url: normalized.ok ? normalized.url : url,
      site_id: match?.id ?? null,
    });

    return c.html(reportPage({ config, url, filed: true }));
  });

  /**
   * `/submit` and `/check` are the same pipeline; `/check` discards the result.
   *
   * Gate order is deliberate: same-origin and the rate limit are free, the
   * semaphore costs a wait, and only then do we touch someone else's server.
   */
  async function handleSubmission(c, { dryRun }) {
    if (!isSameOrigin(c, config)) {
      return c.html(
        submitPage({ config, result: { outcome: 'rejected', reason: 'cross_origin' } }),
        403,
      );
    }

    const ip = clientAddress(c);
    const gate = limiter.take(ip);
    if (!gate.ok) {
      return c.html(
        submitPage({
          config,
          result: {
            outcome: 'rejected',
            reason: 'rate_limited',
            rateLimited: true,
            retryAfterSeconds: gate.retryAfterSeconds,
          },
        }),
        429,
        { 'Retry-After': String(gate.retryAfterSeconds) },
      );
    }

    const form = await c.req.parseBody();
    const submitted = String(form.url ?? '').trim();
    const ipHash = hashIp(ip);

    // ONE budget for the whole submission, shared by Steps 1–6 and Step 7's
    // incumbent re-check (§5, "Fetch budget").
    const budget = createBudget(config);

    let result;
    try {
      result = await semaphore.run(async () => {
        const verification = await verifySite(submitted, { budget });

        // §6: "A rejected submission writes NOTHING" — no `optout_seen_at`, no
        // `last_checked_at`, no `failure_count`. Otherwise an attacker gets around
        // §8's pass-only `/recheck` rule by using `/submit` instead, which reaches
        // the same rows from an unauthenticated route.
        if (!verification.ok) return { ...verification, outcome: 'rejected' };

        if (dryRun) return { ...verification, outcome: 'checked' };

        const persisted = await persist(verification, { budget });
        return { ...verification, ...persisted };
      });
    } catch (err) {
      log('submit.error', { error: err.message, stack: err.stack });
      result = { outcome: 'rejected', reason: 'error' };
    }

    recordAttempt({ submitted, ipHash, result, dryRun });

    const status = result.outcome === 'rejected' ? 422 : 200;
    return c.html(submitPage({ config, result, submitted }), status);
  }

  /**
   * §4: "Every submission attempt, for rate limiting, abuse triage, and 'why did
   * mine fail?'" — including the rejected ones, which are the interesting half.
   */
  function recordAttempt({ submitted, ipHash, result, dryRun }) {
    if (queries === null) return;

    try {
      queries.insertSubmission({
        submitted_url: submitted.slice(0, 2000),
        normalized_url: result.url,
        ip_hash: ipHash,
        // `checked` is not in §4's enumerated list, which predates /check being a
        // POST. A dry run is neither added, updated nor rejected, and folding it
        // into any of those would make the abuse trail lie about what happened.
        result: dryRun && result.outcome === 'checked' ? 'checked' : result.outcome,
        reason: result.reason,
      });
    } catch (err) {
      // The attempt log must never be the reason a good submission 500s.
      log('submission_log.failed', { error: err.message });
    }
  }

  function clientAddress(c) {
    return contextIp(c, config, ({ peer }) =>
      // §6: a public peer with TRUST_PROXY=true is a direct connection that
      // bypassed the proxy, which is worth knowing about.
      log('clientip.untrusted_peer', { peer }),
    );
  }
}
