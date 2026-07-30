/**
 * The moderation routes and the admin dashboard (plan §6 "Admin auth", §12 phase 8b).
 *
 * Phase 5 shipped the two levers this file grew out of — a token compare, hide, and
 * ban — because §1's publishing model is "auto-publish + admin removal" and the
 * removal half could not land four phases after the publishing half. 8b adds the
 * sessions, the CSRF derivation, the login backoff and the dashboard.
 *
 * Three rules hold across every route here:
 *
 *  * **Nothing is registered at all when `ADMIN_TOKEN` is unset** (§6), so an
 *    unconfigured deploy 404s rather than 401s — a 401 is a probe answer.
 *  * **Two credentials, one of which needs CSRF.** A session cookie is ambient, so a
 *    cookie-authenticated POST must carry the CSRF token derived from its session id.
 *    An `Authorization: Bearer` request cannot be forged by another origin at all, so
 *    it needs no token and `curl` on the box stays a working moderation path.
 *  * **Every mutating action writes a `moderation_log` row** (§4), inside the query
 *    helpers rather than here — a route that forgets is otherwise invisible.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { createLoginBackoff, createSessionStore } from '../lib/adminsession.js';
import { contextIp } from '../lib/clientip.js';
import { classify, passColumns } from '../jobs/revalidate.js';
import { createBudget } from '../verify/index.js';
import { adminDashboard, adminLoginPage } from '../views/admin.js';

const COOKIE_NAME = 'iheartrss_admin';

export function registerAdmin(
  app,
  { config, queries, log, now = () => new Date(), verifySite = null },
) {
  // §6: "No admin UI is served at all if ADMIN_TOKEN is unset." Not registering the
  // routes means an unconfigured deploy 404s rather than 401s, which also stops it
  // being a probe for whether admin exists.
  if (!config.adminToken) return;

  const sessions = createSessionStore({ now: () => now().getTime() });
  const backoff = createLoginBackoff({ now: () => now().getTime() });

  app.get('/admin/login', (c) => {
    noindex(c);
    if (authorized(c)) return c.body(null, 303, { Location: '/admin' });
    return c.html(adminLoginPage({ config }));
  });

  app.get('/admin', (c) => {
    noindex(c);
    // A browser gets the login form (still a 401, so it is not a redirect loop and
    // not a 200 that looks like success); anything else gets the JSON refusal.
    if (!authorized(c)) {
      log('admin.unauthorized', { path: c.req.path });
      return c.html(adminLoginPage({ config }), 401);
    }

    return c.html(
      adminDashboard({
        config,
        csrf: sessions.csrfFor(sessionId(c)),
        ...dashboardData(),
      }),
    );
  });

  app.post('/admin/logout', async (c) => {
    const form = await parseForm(c);
    const denial = deny(c, form);
    if (denial !== null) return denial;

    const id = sessionId(c);
    sessions.destroy(id);
    log('admin.logout', {});

    // Max-Age=0 rather than only dropping the server-side entry: a cookie left in
    // the browser is a token that looks live to its owner and isn't.
    return c.body(null, 303, {
      'Set-Cookie': `${COOKIE_NAME}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      Location: '/admin/login',
    });
  });

  app.post('/admin/login', async (c) => {
    const ip = clientAddress(c);

    // Before the compare, and refusing the right token as readily as a wrong one:
    // a backoff that lets a correct token through is a "that guess was wrong" oracle.
    const gate = backoff.check(ip);
    if (!gate.ok) {
      log('admin.login_throttled', { scope: gate.scope });
      noindex(c);
      return c.html(
        adminLoginPage({
          config,
          error: 'throttled',
          retryAfterSeconds: gate.retryAfterSeconds,
        }),
        429,
        { 'Retry-After': String(gate.retryAfterSeconds) },
      );
    }

    const supplied = field(await parseForm(c), 'token') ?? '';

    if (!tokenMatches(supplied)) {
      const counts = backoff.fail(ip);
      // §6: "Log failures." This is the line an operator greps after a break-in
      // attempt, so it carries the counters rather than just the fact.
      log('admin.login_failed', { ...counts });
      noindex(c);
      return c.html(adminLoginPage({ config, error: 'unauthorized' }), 401);
    }

    backoff.succeed(ip);
    const session = sessions.create();
    log('admin.login', {});

    // §6: HttpOnly; Secure; SameSite=Strict. `Path=/admin` keeps the cookie off
    // every public request, so nothing but an admin route ever sees it.
    return c.body(null, 303, {
      'Set-Cookie':
        `${COOKIE_NAME}=${session.id}; Path=/admin; HttpOnly; Secure; ` +
        `SameSite=Strict; Max-Age=${Math.floor(sessions.ttlMs / 1000)}`,
      Location: '/admin',
    });
  });

  app.post('/admin/sites/:id/hide', async (c) => {
    const form = await parseForm(c);
    const denial = deny(c, form);
    if (denial !== null) return denial;
    if (queries === null) return c.json({ ok: false, reason: 'no_database' }, 503);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ ok: false, reason: 'bad_id' }, 400);
    }

    const site = queries.getSiteById(id);
    if (site === undefined) return c.json({ ok: false, reason: 'not_found' }, 404);

    const reason = field(form, 'reason');
    queries.hideSite(id, reason);
    log('admin.hide', { site_id: id, url: site.url, reason: reason ?? null });

    return done(c, { id, status: 'hidden' });
  });

  app.post('/admin/sites/:id/unhide', async (c) => {
    const form = await parseForm(c);
    const denial = deny(c, form);
    if (denial !== null) return denial;
    if (queries === null) return c.json({ ok: false, reason: 'no_database' }, 503);

    const id = Number(c.req.param('id'));
    const site = queries.getSiteById(id);
    if (site === undefined) return c.json({ ok: false, reason: 'not_found' }, 404);

    // §5 Step 7: this is the ONLY thing that clears `hidden`. It happens FIRST,
    // because `markRevalidationPass` carries a `status <> 'hidden'` guard — applying
    // the pass to a still-hidden row would be a silent no-op.
    const reason = field(form, 'reason');
    queries.unhideSite(id, reason);
    log('admin.unhide', { site_id: id, url: site.url, reason: reason ?? null });

    // Phase 8a's note: an unhide re-verifies. A row can have been hidden for months,
    // so putting it back in the OPML on the strength of whatever we last saw is how a
    // dead or repurposed domain returns to every subscriber's reader.
    //
    // `fixedCanonical` for the §8 reason: revalidation never re-derives the canonical
    // URL, so an unhide cannot move this row onto another row's URL.
    const verified = await reverify(site);

    if (verified !== null && classify(verified) === 'pass') {
      queries.recordRevalidationPass(id, passColumns(site, verified), {
        now: now().toISOString(),
      });
      log('admin.unhide_verified', { site_id: id });
    } else {
      // A failed re-verification writes NOTHING — not `failure_count`, not
      // `last_error`, not `last_checked_at`. Otherwise the admin's own unhide starts
      // the 3-strike clock and delists the site again a fortnight later; the
      // scheduler will reach it on its own cadence.
      log('admin.unhide_unverified', {
        site_id: id,
        reason: verified?.reason ?? 'error',
      });
    }

    return done(c, { id, status: 'active', verified: verified?.ok === true });
  });

  /**
   * §4/§5: the per-domain listing cap is "admin-overridable", and this is where that
   * override lives — a `domain_limits` row, not an env var, because
   * `MAX_LISTINGS_PER_DOMAIN=5` otherwise refuses the 6th Substack or Micro.blog
   * member ever, globally and permanently, and fixing it needs a redeploy.
   *
   * `max_listings` of `-1` is unlimited (§4); an empty value deletes the override and
   * returns the domain to the configured default.
   */
  app.post('/admin/domain-limits', async (c) => {
    const form = await parseForm(c);
    const denial = deny(c, form);
    if (denial !== null) return denial;
    if (queries === null) return c.json({ ok: false, reason: 'no_database' }, 503);

    const domain = (field(form, 'domain') ?? '').toLowerCase();
    if (domain === '') return c.json({ ok: false, reason: 'domain_required' }, 400);

    const raw = field(form, 'max_listings');
    let maxListings = null;
    if (raw !== undefined) {
      maxListings = Number(raw);
      // -1 is "unlimited" and 0 is "no new listings here"; anything else non-integer
      // would be stored and then compared against a count, silently capping at NaN.
      if (!Number.isInteger(maxListings) || maxListings < -1) {
        return c.json({ ok: false, reason: 'bad_max_listings' }, 400);
      }
    }

    queries.setDomainLimit(domain, maxListings, field(form, 'note'));
    log('admin.domain_limit', { domain, max_listings: maxListings });

    return done(c, { domain, max_listings: maxListings });
  });

  /**
   * §6: `/report` writes to `reports` and the queue is "surfaced on /admin". Without
   * a way to clear one, the queue is append-only and every visit re-reads the same
   * dozen reports until the useful ones are invisible.
   */
  app.post('/admin/reports/:id/handle', async (c) => {
    const form = await parseForm(c);
    const denial = deny(c, form);
    if (denial !== null) return denial;
    if (queries === null) return c.json({ ok: false, reason: 'no_database' }, 503);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ ok: false, reason: 'bad_id' }, 400);
    }
    if (queries.getReportById(id) === undefined) {
      return c.json({ ok: false, reason: 'not_found' }, 404);
    }

    const reason = field(form, 'reason');
    const changed = queries.handleReport(id, reason);
    log('admin.report_handled', { report_id: id, reason: reason ?? null, changed });

    return done(c, { id, handled: true });
  });

  app.post('/admin/ban', async (c) => {
    const form = await parseForm(c);
    const denial = deny(c, form);
    if (denial !== null) return denial;
    if (queries === null) return c.json({ ok: false, reason: 'no_database' }, 503);

    const host = field(form, 'host') ?? '';
    const hostSuffix = field(form, 'host_suffix') ?? '';
    const pathPrefix = field(form, 'path_prefix') ?? '';
    const reason = field(form, 'reason');

    if (host === '' && hostSuffix === '') {
      return c.json({ ok: false, reason: 'host_or_suffix_required' }, 400);
    }

    try {
      queries.insertBan({
        host: host.toLowerCase(),
        host_suffix: hostSuffix.toLowerCase(),
        path_prefix: pathPrefix,
        reason,
      });
    } catch (err) {
      // The PRIMARY KEY makes a repeat ban a constraint error, and re-banning is a
      // reasonable thing for an operator to do twice.
      if (!/UNIQUE|PRIMARY KEY/i.test(err.message)) throw err;
      return c.json({ ok: true, alreadyBanned: true });
    }

    log('admin.ban', {
      host,
      host_suffix: hostSuffix,
      path_prefix: pathPrefix,
      reason: reason ?? null,
    });

    return done(c, { host, host_suffix: hostSuffix, path_prefix: pathPrefix });
  });

  /**
   * The gate on every admin POST: authenticate, then — **if the credential was the
   * cookie** — require the CSRF token derived from that session id.
   *
   * A request authenticated by the `Authorization` header needs no CSRF token, and
   * that is not a loophole: a cross-origin page cannot set that header at all without
   * a CORS preflight the browser will refuse, so there is nothing to ride. The cookie
   * is the *ambient* credential, which is precisely why it needs a second factor the
   * attacker's page cannot read. Keeping the header path CSRF-free is also what lets
   * an operator moderate from `curl` without first scraping a token out of the HTML.
   *
   * Returns a Response to send, or `null` when the request may proceed.
   */
  function deny(c, form) {
    const id = sessionId(c);
    const bySession = sessions.valid(id);

    if (!bySession && !tokenMatches(bearer(c) ?? '')) return unauthorized(c);

    if (bySession && !sessions.csrfMatches(id, field(form, 'csrf') ?? '')) {
      log('admin.csrf_rejected', { path: c.req.path });
      return c.json({ ok: false, reason: 'bad_csrf' }, 403);
    }
    return null;
  }

  /**
   * A browser gets a redirect back to the dashboard (so the next GET shows the
   * result and a reload doesn't re-post); an API caller gets the JSON phase 5
   * defined, because `curl` on the production box is still a supported way to
   * moderate.
   */
  function done(c, json) {
    if (sessions.valid(sessionId(c))) {
      return c.body(null, 303, { Location: '/admin' });
    }
    return c.json({ ok: true, ...json });
  }

  /**
   * §6: compare as `timingSafeEqual(sha256(supplied), sha256(expected))`.
   *
   * **Raw `crypto.timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on
   * unequal lengths** (verified), so a wrong-length guess 500s instead of 401-ing —
   * a crash per attempt and a length oracle in the bargain. Hashing first makes both
   * sides 32 bytes always.
   */
  function authorized(c) {
    return sessions.valid(sessionId(c)) || tokenMatches(bearer(c) ?? '');
  }

  function tokenMatches(supplied) {
    if (supplied === '') return false;
    return timingSafeEqual(sha256(supplied), sha256(config.adminToken));
  }

  /**
   * Everything the dashboard reads, in one place.
   *
   * The `/healthz` backlog fields are computed from the same cutoff `/healthz` uses
   * (§8's capacity ceiling): the interval is what makes /about's "within a week"
   * promise true or false, so the two views must not be able to disagree.
   */
  function dashboardData() {
    if (queries === null) return {};

    const intervalDays = config.revalidateIntervalDays ?? 6;
    const cutoff = new Date(
      now().getTime() - intervalDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    // §4 purges `submissions` at 90 days, so the histogram's window is the whole
    // retained history — a shorter one would just hide data we still hold.
    const since = new Date(now().getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

    return {
      recent: queries.listRecentSites(50),
      attention: queries.listSitesNeedingAttention(),
      submissions: queries.recentSubmissions(25),
      histogram: queries.rejectionHistogram(since),
      reports: queries.listReports(50),
      bans: queries.listBans(),
      domainLimits: queries.listDomainLimits(),
      backlog: queries.revalidationBacklog(cutoff),
      memberCount: queries.countSites(),
    };
  }

  /**
   * Re-run verification for an unhide. Returns the result, or `null` when we could
   * not even ask — a thrown fetcher must not take the unhide down with it.
   */
  async function reverify(site) {
    if (verifySite === null) return null;

    try {
      return await verifySite(site.url, {
        budget: createBudget(config),
        fixedCanonical: true,
        conditional: {
          feedUrl: site.feed_url,
          etag: site.feed_etag,
          lastModified: site.feed_last_modified,
        },
      });
    } catch (err) {
      log('admin.unhide_verify_error', { site_id: site.id, error: err.message });
      return null;
    }
  }

  function clientAddress(c) {
    return contextIp(c, config, ({ peer }) => log('clientip.untrusted_peer', { peer }));
  }

  function unauthorized(c) {
    log('admin.unauthorized', { path: c.req.path });
    return c.json({ ok: false, reason: 'unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer realm="iheartrss admin"',
    });
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest();
}

function sessionId(c) {
  const header = c.req.header('cookie');
  if (header === undefined) return '';

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === COOKIE_NAME) return pair.slice(eq + 1).trim();
  }
  return '';
}

function bearer(c) {
  const header = c.req.header('authorization');
  if (header !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  return c.req.header('x-admin-token')?.trim();
}

/**
 * The body, parsed once per request. Every handler needs at least the CSRF field, so
 * parsing at the top and passing the object around keeps "did we check CSRF?" a
 * property of one visible line rather than of parse-order.
 */
async function parseForm(c) {
  try {
    return await c.req.parseBody();
  } catch {
    return {};
  }
}

function field(form, name) {
  const value = String(form?.[name] ?? '').trim();
  return value === '' ? undefined : value;
}

// `robots.txt` already disallows /admin, but a Disallow is a request and a pasted
// link is a crawl. The header is the part a crawler cannot decline to read.
function noindex(c) {
  c.header('X-Robots-Tag', 'noindex, nofollow');
}
