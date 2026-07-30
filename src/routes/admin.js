/**
 * The bare-minimum moderation routes (plan §12, phase 5).
 *
 * A token compare and two SQL statements. **No session machinery** — that waits for
 * 8b. It cannot wait any longer than this, though: submissions go public in this
 * phase and the OPML in phase 6, and §1's publishing model is "auto-publish + admin
 * removal". Without these the only lever is `sqlite3` on the production box, which
 * `node:24-alpine` doesn't ship.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export function registerAdmin(app, { config, queries, log }) {
  // §6: "No admin UI is served at all if ADMIN_TOKEN is unset." Not registering the
  // routes means an unconfigured deploy 404s rather than 401s, which also stops it
  // being a probe for whether admin exists.
  if (!config.adminToken) return;

  app.post('/admin/sites/:id/hide', async (c) => {
    if (!authorized(c)) return unauthorized(c);
    if (queries === null) return c.json({ ok: false, reason: 'no_database' }, 503);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ ok: false, reason: 'bad_id' }, 400);
    }

    const site = queries.getSiteById(id);
    if (site === undefined) return c.json({ ok: false, reason: 'not_found' }, 404);

    const reason = await formField(c, 'reason');
    queries.hideSite(id, reason);
    log('admin.hide', { site_id: id, url: site.url, reason: reason ?? null });

    return c.json({ ok: true, id, status: 'hidden' });
  });

  app.post('/admin/sites/:id/unhide', async (c) => {
    if (!authorized(c)) return unauthorized(c);
    if (queries === null) return c.json({ ok: false, reason: 'no_database' }, 503);

    const id = Number(c.req.param('id'));
    const site = queries.getSiteById(id);
    if (site === undefined) return c.json({ ok: false, reason: 'not_found' }, 404);

    // §5 Step 7: this is the ONLY thing that clears `hidden`. Re-verification on
    // unhide lands with the scheduler in phase 8a.
    const reason = await formField(c, 'reason');
    queries.unhideSite(id, reason);
    log('admin.unhide', { site_id: id, url: site.url, reason: reason ?? null });

    return c.json({ ok: true, id, status: 'active' });
  });

  app.post('/admin/ban', async (c) => {
    if (!authorized(c)) return unauthorized(c);
    if (queries === null) return c.json({ ok: false, reason: 'no_database' }, 503);

    const host = (await formField(c, 'host')) ?? '';
    const hostSuffix = (await formField(c, 'host_suffix')) ?? '';
    const pathPrefix = (await formField(c, 'path_prefix')) ?? '';
    const reason = await formField(c, 'reason');

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

    return c.json({ ok: true, host, host_suffix: hostSuffix, path_prefix: pathPrefix });
  });

  /**
   * §6: compare as `timingSafeEqual(sha256(supplied), sha256(expected))`.
   *
   * **Raw `crypto.timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on
   * unequal lengths** (verified), so a wrong-length guess 500s instead of 401-ing —
   * a crash per attempt and a length oracle in the bargain. Hashing first makes both
   * sides 32 bytes always.
   */
  function authorized(c) {
    const supplied = bearer(c) ?? '';
    if (supplied === '') return false;

    return timingSafeEqual(sha256(supplied), sha256(config.adminToken));
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

function bearer(c) {
  const header = c.req.header('authorization');
  if (header !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  return c.req.header('x-admin-token')?.trim();
}

async function formField(c, name) {
  let form;
  try {
    form = await c.req.parseBody();
  } catch {
    return undefined;
  }
  const value = String(form?.[name] ?? '').trim();
  return value === '' ? undefined : value;
}
