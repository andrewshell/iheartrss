/**
 * Weekly revalidation (plan §8) — the in-process scheduler that makes the
 * directory maintain itself, and the only code that may complete an opt-out.
 *
 * Three structural rules from §8, all of them load-bearing:
 *
 *  * **Revalidation re-fetches `sites.url` and re-runs feed discovery on that page
 *    only. It never re-derives the canonical URL.** Both alternatives break: re-deriving
 *    can oscillate between two pages that name each other's feed (the OPML `htmlUrl`
 *    alternating weekly, `directory_version` churning, and a pass/opt-out flip-flop if
 *    the badge is on only one of them), and it can move `sites.url` onto another row's
 *    value — a UNIQUE violation raised inside this loop. Not re-discovering the feed
 *    is the opposite failure: a member who moves `/feed.xml` → `/feed/` fails on a
 *    stale `feed_url` for three weeks and is dropped with no self-service repair.
 *  * **The outcome table is ordered, not a set of independent predicates.** A
 *    Cloudflare "Just a moment…" interstitial is a 200 that parses, declares no feed
 *    and carries no link-back, so it matches Opt-out *and* Transient at once.
 *    Requiring the pipeline to have reached Step 5 is what disambiguates — see
 *    `classify`.
 *  * **Every per-site write is wrapped in try/catch inside the loop.** `feed_url` is
 *    UNIQUE and revalidation is allowed to change it, so two rows converging on one
 *    feed raises a constraint violation mid-batch — which in Node 24 terminates the
 *    process. On conflict: log and skip.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** §8: `dropped` → 30 days, `removed` → 90 days. Not env knobs; they never vary. */
const DROPPED_INTERVAL_DAYS = 30;
const REMOVED_INTERVAL_DAYS = 90;

/** §4/§8: `dropped` at "3+ consecutive failures" — the grace period is 3 strikes. */
const MAX_FAILURES = 3;

/** §4: "after 90 consecutive days blocked, demote to `dropped`." */
const BLOCKED_MAX_DAYS = 90;

/**
 * §8: "don't hit the same host twice within a few minutes." Three minutes, and a
 * host seen inside that window is *deferred* — left untouched so it keeps its place
 * in the queue — rather than slept on, which would stall the whole batch.
 */
const HOST_SPACING_MS = 3 * 60 * 1000;

/** §4's retention: submissions for 90 days, `dropped` rows for ~1 year. */
const SUBMISSION_RETENTION_DAYS = 90;
const DROPPED_RETENTION_DAYS = 365;

/** The monitoring ping is best-effort; it must never hold the tick open. */
const PING_TIMEOUT_MS = 5000;

/** §8: hourly ticks, and "a run also fires ~30s after boot". */
const TICK_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 30_000;

/** §8: "checks run sequentially with a small delay." */
const SITE_DELAY_MS = 2000;

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    // unref'd: a pending delay must never be the reason the process won't exit.
    setTimeout(resolve, ms).unref?.();
  });

/**
 * @param {object} deps
 * @param {object} deps.queries - from `createDb`.
 * @param {object} deps.config
 * @param {Function} deps.verifySite - `(url, { budget, fixedCanonical, conditional })`.
 * @param {Function} [deps.now] - injected clock; §11's opt-out tests move it by hand.
 */
export function createRevalidator({
  queries,
  config,
  verifySite,
  now = () => new Date(),
  log = () => {},
  sleep = defaultSleep,
  hostSpacingMs = HOST_SPACING_MS,
  siteDelayMs = SITE_DELAY_MS,
  // Injected so §11 can assert the ping without a network, and because the ping is
  // deliberately NOT a `safeFetch` — see `pingHealthcheck`.
  pingFetch = (...args) => globalThis.fetch(...args),
}) {
  let lastRevalidation = null;
  /** host → the ms timestamp we last fetched it, for §8's per-host spacing. */
  const hostSpacing = new Map();
  // §8's `running` guard, at module scope in the plan and at factory scope here for
  // the same reason: **a slow batch must never overlap the next tick**. 20 sites × a
  // 30-second budget is already 10 minutes, and one tarpit host makes it arbitrarily
  // worse; an overlapping run fails every site in the batch twice, so the 3-strike
  // grace period silently becomes a 1.5-strike one.
  let running = false;
  let bootHandle = null;
  let tickHandle = null;
  let clear = () => {};

  async function runOnce() {
    if (running) {
      log('revalidate.skipped', { reason: 'already_running' });
      return { skipped: 'already_running', checked: 0 };
    }
    running = true;

    const startedAt = now();
    let checked = 0;

    // The spacing map only ever answers questions about the last few minutes, so
    // anything older is dead weight — and this map would otherwise grow by one entry
    // per host for the life of the process.
    for (const [host, hitAt] of hostSpacing) {
      if (startedAt.getTime() - hitAt >= hostSpacingMs) hostSpacing.delete(host);
    }

    try {
      for (const row of selectBatch(startedAt)) {
        const at = now();

        // §8's per-host spacing. A batch holding 20 mastodon.social or micro.blog
        // members would otherwise hammer one host 20 times in ~40 seconds and trip
        // its rate limiter, which reads back as a transient failure for all of them
        // — three ticks of that and the whole cohort is `dropped`. The deferred rows
        // are left completely untouched, so they keep their place in the queue
        // rather than being recorded as checked or failed.
        const lastHit = hostSpacing.get(row.host);
        if (lastHit !== undefined && at.getTime() - lastHit < hostSpacingMs) {
          log('revalidate.host_deferred', { site_id: row.id, host: row.host });
          continue;
        }
        hostSpacing.set(row.host, at.getTime());

        // Both the fetch and the write are inside this try. The write, because
        // `feed_url` is UNIQUE and this path may change it, so two rows converging on
        // one feed raises a constraint violation mid-batch — which in Node 24
        // terminates the process (§8). The fetch, because "never throws" is a claim
        // about `verifySite`'s intent, and one site must not be able to cancel the
        // other 19 or the purge.
        try {
          const result = await verifySite(row.url, {
            // §8: the canonical URL is never re-derived, and the validators we stored
            // last time turn most checks into a 304.
            fixedCanonical: true,
            conditional: {
              feedUrl: row.feed_url,
              etag: row.feed_etag,
              lastModified: row.feed_last_modified,
            },
          });

          apply(row, result, at);
          checked += 1;
        } catch (err) {
          log('revalidate.site_failed', { site_id: row.id, error: err.message });
        }

        // §8: sequential, with a small delay. Each check is 2–4 outbound requests,
        // so 20 sites is really 40–80 — worth spreading out even across hosts.
        await sleep(siteDelayMs);
      }
      purge(startedAt);
    } finally {
      running = false;
    }

    lastRevalidation = startedAt.toISOString();
    await pingHealthcheck();
    return { startedAt: lastRevalidation, checked };
  }

  /**
   * §8/§9: ping `HEALTHCHECK_PING_URL` at the end of each batch, so a scheduler that
   * has quietly stopped ticking is noticed by something other than a member emailing
   * to ask why they were never removed.
   *
   * Never through `safeFetch`: that is the hardened path for *members'* servers, and
   * an operator's ping URL is neither untrusted nor subject to the SSRF policy (a
   * self-hosted healthchecks instance on a private address is a legitimate target).
   * A failed ping is logged and nothing more — monitoring must not be able to fail
   * the thing it monitors.
   */
  async function pingHealthcheck() {
    if (!config.healthcheckPingUrl) return;

    try {
      await pingFetch(config.healthcheckPingUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
    } catch (err) {
      log('revalidate.ping_failed', { error: err.message });
    }
  }

  /**
   * §4's retention, on the tick: `submissions` older than 90 days (a keyed IP hash is
   * still personal data, and /about promises 90 days) and `dropped` rows older than
   * ~1 year.
   *
   * Wrapped like the per-site writes: §8 says "same for the year-old `dropped`
   * purge", and a `reports` row pointing at a purged site is exactly the shape that
   * raises a constraint failure here.
   */
  function purge(at) {
    const before = (days) => new Date(at.getTime() - days * DAY_MS).toISOString();

    try {
      const submissions = queries.purgeSubmissions(before(SUBMISSION_RETENTION_DAYS));
      const sites = queries.purgeDroppedSites(before(DROPPED_RETENTION_DAYS));
      if (submissions > 0 || sites > 0) log('revalidate.purged', { submissions, sites });
    } catch (err) {
      log('revalidate.purge_failed', { error: err.message });
    }
  }

  /**
   * §8's quota: "e.g. 16 active/failing + 4 dropped/removed" out of 20.
   *
   * The dormant arm is drawn **first and capped**, and the live arm then fills
   * whatever is left. That ordering is what makes the quota a floor for live rows
   * rather than a hope: with a few hundred accumulated dead domains, an unquoted
   * `ORDER BY last_checked_at` hands them every slot — a `dropped` row at 31 days
   * outranks an `active` row at 7 — and live members stop being revalidated
   * entirely. When there are no dormant rows due, the live arm gets the whole batch.
   */
  function selectBatch(at) {
    const t = at.getTime();
    const cutoff = (ms) => new Date(t - ms).toISOString();
    const batch = config.revalidateBatch;
    const dormantQuota = Math.max(1, Math.floor(batch * 0.2));

    const dormant = queries.dueDormant({
      droppedCutoff: cutoff(DROPPED_INTERVAL_DAYS * DAY_MS),
      removedCutoff: cutoff(REMOVED_INTERVAL_DAYS * DAY_MS),
      limit: dormantQuota,
    });

    const live = queries.dueForRevalidation({
      liveCutoff: cutoff(config.revalidateIntervalDays * DAY_MS),
      optoutCutoff: cutoff(config.optoutFollowupHours * HOUR_MS),
      limit: Math.max(0, batch - dormant.length),
    });

    return [...live, ...dormant];
  }

  function apply(row, result, at) {
    const stamp = at.toISOString();
    const outcome = classify(result);

    if (outcome === 'pass') {
      queries.recordRevalidationPass(row.id, passColumns(row, result), { now: stamp });
      return outcome;
    }

    if (outcome === 'optout') return applyOptout(row, at, stamp);

    if (outcome === 'blocked') {
      return queries.recordBlocked(row.id, {
        now: stamp,
        error: result.reason,
        // §4's exit from `blocked`: 90 consecutive days demotes to `dropped`.
        verifiedBefore: new Date(at.getTime() - BLOCKED_MAX_DAYS * DAY_MS).toISOString(),
      });
    }

    queries.recordTransientFailure(row.id, {
      now: stamp,
      error: result.reason,
      maxFailures: MAX_FAILURES,
    });
    return outcome;
  }

  /**
   * The opt-out sub-decision: first sighting, confirming sighting, or neither.
   *
   * `removed` rows skip it entirely (§8) — only a Pass matters there. Otherwise the
   * 90-day retry restarts the two-sighting dance every time and we poll people who
   * explicitly asked to be left alone ~8 times a year.
   */
  function applyOptout(row, at, stamp) {
    if (row.status === 'removed') {
      queries.touchLastChecked(row.id, { now: stamp, error: 'no_linkback' });
      return 'optout_ignored';
    }

    const seenAt = row.optout_seen_at === null ? null : Date.parse(row.optout_seen_at);

    if (seenAt !== null && !Number.isNaN(seenAt)) {
      const age = at.getTime() - seenAt;

      // ≥24h and ≤14 days: the confirming sighting.
      if (age >= config.optoutFollowupHours * HOUR_MS
          && age <= config.optoutExpiryDays * DAY_MS) {
        queries.recordOptoutConfirmed(row.id, { now: stamp });
        return 'removed';
      }

      // Inside the 24-hour floor: we looked, and that is all. Overwriting the
      // sighting here would reset the clock on every tick and the confirmation
      // would never arrive; removing on it would hand a third party with a
      // /recheck the delisting the floor exists to prevent (§8).
      if (age < config.optoutFollowupHours * HOUR_MS) {
        queries.touchLastChecked(row.id, { now: stamp, error: 'no_linkback' });
        return 'optout_pending';
      }
      // Older than 14 days: "clear and restart" — fall through to a fresh sighting.
    }

    queries.recordOptoutSighting(row.id, { seenAt: stamp, now: stamp });
    return 'optout_seen';
  }

  /**
   * Start ticking. Timer functions are injectable so §11 can assert the cadence and
   * the `unref` without waiting an hour for a tick.
   *
   * Returns whether anything was scheduled — `REVALIDATE_ENABLED=false` must mean no
   * timers at all, not a tick that runs and finds nothing.
   */
  function start(timers = {}) {
    const {
      setInterval: setIntervalFn = globalThis.setInterval,
      clearInterval: clearIntervalFn = globalThis.clearInterval,
      setTimeout: setTimeoutFn = globalThis.setTimeout,
      clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
    } = timers;

    if (!config.revalidateEnabled) {
      log('revalidate.disabled', { reason: 'REVALIDATE_ENABLED' });
      return false;
    }

    clear = () => {
      if (bootHandle !== null) clearTimeoutFn(bootHandle);
      if (tickHandle !== null) clearIntervalFn(tickHandle);
      bootHandle = null;
      tickHandle = null;
    };

    // §8: "a run also fires ~30s after boot so a fresh container doesn't sit idle
    // for an hour."
    bootHandle = setTimeoutFn(tick, BOOT_DELAY_MS);
    tickHandle = setIntervalFn(tick, TICK_MS);

    // unref'd (§8), so neither timer can hold the process open past a SIGTERM —
    // §9 measured `docker stop` at 10.29s without clean shutdown and 0.16s with it.
    bootHandle?.unref?.();
    tickHandle?.unref?.();

    return true;
  }

  /**
   * The timer callback. It **must** swallow its own errors: an unhandled rejection
   * from a timer terminates the process in Node 24, and this one runs unattended
   * every hour for as long as the container lives.
   */
  function tick() {
    return runOnce().catch((err) => {
      log('revalidate.tick_failed', { error: err.message, stack: err.stack });
      return { checked: 0, error: err.message };
    });
  }

  return {
    runOnce,
    start,
    stop: () => clear(),
    lastRevalidation: () => lastRevalidation,
  };
}

/**
 * §8's outcome table, **in order**. The order is the whole point: a Cloudflare
 * "Just a moment…" interstitial is a 200 that parses and carries no link-back, so
 * it matches Opt-out and Transient simultaneously, and an implementer evaluating
 * these as independent predicates removes members under Under Attack mode.
 *
 * What disambiguates is that an opt-out sighting requires **the pipeline to have
 * reached Step 5** — i.e. the page still declares a feed that validates. `verifySite`
 * encodes exactly that: `no_linkback` is returned only after Steps 2–4 succeeded and
 * the feed parsed as RSS 2.0. Every earlier failure has its own reason code and
 * lands in Transient, including the interstitial's `no_feed_link` and a
 * size-capped `page_too_large` — "otherwise any member whose homepage grows past
 * the cap has their badge cut off mid-document, parses 'fine', and is silently
 * delisted for the crime of writing a long page."
 *
 * `canonical_*` reasons cannot arise on this path (canonical resolution does not
 * run), and §8 says that if one somehow does it is Transient — which is where
 * anything unrecognised falls anyway.
 */
export function classify(result) {
  if (result.ok) return 'pass';
  if (result.reason === 'no_linkback') return 'optout';
  if (result.reason === 'blocked_by_site') return 'blocked';
  return 'transient';
}

/**
 * The metadata a Pass writes.
 *
 * Behind a **304** there is no document: `title`, `description` and the features are
 * absent rather than empty, so the row keeps what it already has. Writing the absent
 * title would violate its NOT NULL and turn every conditional hit into a caught
 * constraint failure — a check that silently stops counting.
 */
export function passColumns(row, result) {
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

  return {
    title: result.title,
    description: result.description,
    feed_url: result.feedUrl,
    ...featureColumns(result.features),
    feed_etag: result.feedEtag,
    feed_last_modified: result.feedLastModified,
  };
}

/** `verify/feed.js`'s feature shape → the `sites` columns, as in §5 Step 7. */
function featureColumns(features = {}) {
  const cloud =
    features.cloud === undefined && features.cloud_url === undefined
      ? undefined
      : JSON.stringify({ cloud: features.cloud ?? null, cloud_url: features.cloud_url ?? null });

  return {
    has_source_ns: features.has_source_ns,
    has_rsscloud: features.has_rsscloud,
    rsscloud_style: features.rsscloud_style,
    cloud_json: cloud,
  };
}

export { DROPPED_INTERVAL_DAYS, REMOVED_INTERVAL_DAYS };
