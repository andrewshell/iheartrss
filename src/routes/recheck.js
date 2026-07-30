/**
 * `POST /recheck/:id` — "re-run verification now" (plan §6).
 *
 * **It may only improve state or record a first opt-out sighting.** The original
 * justification for a laxer rule — "the only way to make it *remove* a site is to
 * have already removed the link-back, which only that site's owner can do" — reasoned
 * about the opt-out branch and ignored the transient one: a recheck also runs §8's
 * 3-strike path, so with a 1-hour cooldown anyone could force a healthy member from
 * `active` to `dropped` in three hours instead of the 18 days the grace period exists
 * to give, timed against any window where the target is briefly down, mid-deploy,
 * rate-limiting us or serving a CDN error.
 *
 * So, in order:
 *
 *  * `hidden` rows are **excluded outright** — nothing written, no fetch spent, and
 *    the same neutral "already submitted" answer `/submit` gives. Otherwise "may only
 *    improve state" reads `hidden → active` as an improvement and a moderated member
 *    who knows their id un-hides themselves with one request.
 *  * A **pass** applies normally.
 *  * A **transient failure** and a **blocked** outcome are **no-ops** — logged and
 *    shown to the caller, never written.
 *  * An **opt-out** may record a *first* `optout_seen_at` but **never** the confirming
 *    one; only §8's scheduler applies the second sighting. Two rechecks 24h apart must
 *    not let a third party delist someone in 24h instead of ~6 days.
 */

import { html } from 'hono/html';

import { contextIp } from '../lib/clientip.js';
import { isSameOrigin } from '../lib/sameorigin.js';
import { classify } from '../jobs/revalidate.js';
import { createBudget } from '../verify/index.js';
import { rejectionMessage } from '../views/messages.js';
import { statusPage } from '../views/status.js';
import { submitPage } from '../views/submit.js';

export function registerRecheck(app, deps) {
  const { config, queries, verifySite, semaphore, limiter, log, now } = deps;

  app.post('/recheck/:id', async (c) => {
    c.header('X-Robots-Tag', 'noindex');

    // Gate order, cheapest first (§6). Same-origin is free and closes the
    // cross-origin auto-submitting-form amplifier that switching `/check` to POST did
    // not.
    if (!isSameOrigin(c, config)) {
      return c.html(
        submitPage({ config, result: { outcome: 'rejected', reason: 'cross_origin' } }),
        403,
      );
    }

    const gate = limiter.take(clientAddress(c));
    if (!gate.ok) {
      return c.html(
        statusPage({
          config,
          notice: {
            kind: 'error',
            heading: 'Too many checks',
            body: html`<p>
              Every check costs somebody else&rsquo;s server a request. Try again in about
              ${Math.ceil(gate.retryAfterSeconds / 60)} minutes.
            </p>`,
          },
        }),
        429,
        { 'Retry-After': String(gate.retryAfterSeconds) },
      );
    }

    const id = Number(c.req.param('id'));
    const row =
      Number.isSafeInteger(id) && id > 0 && queries !== null
        ? queries.getSiteById(id)
        : undefined;

    if (row === undefined) return c.notFound();

    // The neutral answer, identical to `/submit`'s for a hidden row: true, and not an
    // oracle. Before the cooldown check, so even the 429 can't be used to probe.
    if (row.status === 'hidden') {
      return c.html(
        submitPage({ config, result: { outcome: 'already_submitted', url: row.url } }),
      );
    }

    const cooldownMs = config.recheckCooldownMin * 60 * 1000;
    const since =
      row.last_recheck_at === null
        ? Infinity
        : now().getTime() - Date.parse(row.last_recheck_at);

    if (since < cooldownMs) {
      const wait = Math.ceil((cooldownMs - since) / 1000);
      return c.html(
        statusPage({
          config,
          query: row.url,
          url: row.url,
          site: row,
          notice: {
            kind: 'error',
            heading: 'Just checked',
            body: html`<p>
              We re-checked this site recently. Try again in about ${Math.ceil(wait / 60)}
              minutes &mdash; or leave it to us; we come round on our own every few days.
            </p>`,
          },
        }),
        429,
        { 'Retry-After': String(wait) },
      );
    }

    const stamp = now().toISOString();
    let result;
    try {
      // Inside the public semaphore, unlike the scheduler: this is a public route
      // spending an outbound request, and §6's "global semaphore (≈4) on concurrent
      // outbound verifications" is what stops any combination of endpoints fanning
      // out against a third party. §8 gives the *scheduler* the reserved slot outside
      // it for the opposite reason — so four tarpitted rechecks can't stall the
      // removal clock.
      result = await semaphore.run(() =>
        // §8: revalidation mode. `sites.url` is re-fetched and feed discovery re-runs
        // on that page; the canonical URL is never re-derived, so a recheck cannot
        // move a row onto another row's URL.
        verifySite(row.url, {
          budget: createBudget(config),
          fixedCanonical: true,
          conditional: {
            feedUrl: row.feed_url,
            etag: row.feed_etag,
            lastModified: row.feed_last_modified,
          },
        }),
      );
    } catch (err) {
      log('recheck.error', { site_id: row.id, error: err.message });
      result = { ok: false, reason: 'error' };
    }

    const outcome = classify(result);
    const notice = applyOutcome(row, result, outcome, stamp);

    return c.html(
      statusPage({
        config,
        query: row.url,
        url: row.url,
        site: queries.getSiteById(row.id),
        notice,
      }),
    );
  });

  /**
   * Write what this outcome is allowed to write — nothing, for two of the four — and
   * return the panel the caller sees.
   */
  function applyOutcome(row, result, outcome, stamp) {
    try {
      if (outcome === 'pass') {
        queries.recordRecheckPass(row.id, passColumns(row, result), { now: stamp });
        log('recheck.pass', { site_id: row.id });

        return {
          kind: 'ok',
          heading: 'All good',
          body: html`<p>
            We fetched your page and your feed, and found the link back to us. You are
            listed.
          </p>`,
        };
      }

      if (outcome === 'optout') {
        const recorded = queries.recordRecheckOptoutSighting(row.id, { now: stamp });
        log('recheck.optout_sighting', { site_id: row.id, recorded });

        // Deliberately the same words either way: whether this was the first sighting
        // or a repeat, the caller learns nothing about how close the row is to being
        // removed, and no recheck can ever be the confirming one.
        return {
          kind: 'error',
          heading: "We couldn't find the link back to us",
          body: html`<p>
            Your page and feed both loaded, but there is no link to
            <code>iheartrss.com</code> on <a href="${row.url}">${row.url}</a>. If you
            meant to leave, nothing more is needed &mdash; we confirm it on a later check
            and then remove you. If you didn&rsquo;t, put the link back and
            <a href="/badge">check the badge snippets</a>.
          </p>`,
        };
      }

      // Transient and blocked: no-ops. Logged, shown, never written (§6).
      queries.recordRecheckedAt(row.id, { now: stamp });
      log('recheck.noop', { site_id: row.id, outcome, reason: result.reason });

      const message = rejectionMessage({ result: { ...result, url: row.url }, config });
      return {
        kind: 'error',
        heading: message.heading,
        body: html`${message.body}
          <p class="panel__foot">
            Nothing was changed by this check &mdash; a failed check from here never
            counts against you.
          </p>`,
      };
    } catch (err) {
      // `feed_url` is UNIQUE and a recheck may change it, exactly as in §8's loop.
      log('recheck.write_failed', { site_id: row.id, error: err.message });
      return {
        kind: 'error',
        heading: "We couldn't record that",
        body: html`<p>
          Something about this listing needs a person to look at it. Nothing was changed.
        </p>`,
      };
    }
  }

  function clientAddress(c) {
    return contextIp(c, config, ({ peer }) => log('clientip.untrusted_peer', { peer }));
  }
}

/**
 * A pass behind a **304** has no document to read metadata from, so the row keeps
 * what it already has — writing the absent `title` would violate its NOT NULL.
 */
function passColumns(row, result) {
  if (result.feedUnchanged) {
    return {
      title: row.title,
      description: row.description,
      feed_url: row.feed_url,
      has_source_ns: row.has_source_ns,
      has_rsscloud: row.has_rsscloud,
      rsscloud_style: row.rsscloud_style,
      cloud_json: row.cloud_json,
      feed_etag: result.feedEtag ?? row.feed_etag,
      feed_last_modified: result.feedLastModified ?? row.feed_last_modified,
    };
  }

  const features = result.features ?? {};
  const cloud =
    features.cloud === undefined && features.cloud_url === undefined
      ? undefined
      : JSON.stringify({
          cloud: features.cloud ?? null,
          cloud_url: features.cloud_url ?? null,
        });

  return {
    title: result.title,
    description: result.description,
    feed_url: result.feedUrl,
    has_source_ns: features.has_source_ns,
    has_rsscloud: features.has_rsscloud,
    rsscloud_style: features.rsscloud_style,
    cloud_json: cloud,
    feed_etag: result.feedEtag,
    feed_last_modified: result.feedLastModified,
  };
}
