/**
 * Prepared statements, built by `createDb` against a live connection — never at
 * module scope (plan §11).
 *
 * Two rules live at this boundary and nowhere else:
 *
 *  1. **Coercion.** `node:sqlite` throws
 *     `TypeError: Provided value cannot be bound to SQLite parameter` for both
 *     booleans and `undefined` (§4, verified). The pipeline produces booleans
 *     (`has_source_ns`, `has_rsscloud`) and `undefined` (`description`,
 *     `rsscloud_style`, `last_error`) as a matter of course, so the natural
 *     `stmt.run({…})` throws at exactly the moment a submission *succeeds*.
 *     `bool()`/`opt()` below are the one place that is fixed.
 *  2. **Timestamps come from JS.** Every time column is TEXT compared with `<`,
 *     and SQL's `datetime('now')` yields `2026-07-29 14:00:00` while
 *     `toISOString()` yields `2026-07-29T14:00:00.000Z`. Mixing them makes
 *     `'2026-07-29 …' < '2026-07-29T…'` always true and silently breaks the §8
 *     revalidation selection query. No statement in this file calls
 *     `datetime('now')`.
 */

// node:sqlite binds only null, number, bigint, string and Uint8Array.
const bool = (value) => (value ? 1 : 0);
const opt = (value) => value ?? null;

export function createQueries(db) {
  const statements = {
    getDirectoryVersion: db.prepare(
      'SELECT version, outline_hash, updated_at FROM directory_version WHERE id = 1',
    ),

    // §7: the write helpers bump `version` ONLY. `outline_hash` and `updated_at`
    // are recomputed lazily at render time in phase 6, because hashing anything
    // that moves on every `last_checked_at` write would be a 100% cache miss.
    bumpDirectoryVersion: db.prepare(
      'UPDATE directory_version SET version = version + 1 WHERE id = 1',
    ),

    // §4's cap query verbatim. The default is passed in rather than read from
    // config here so this module stays a pure statement holder.
    maxListingsForDomain: db.prepare(`
      SELECT COALESCE(
        (SELECT max_listings FROM domain_limits WHERE domain = :domain),
        :fallback
      ) AS max_listings
    `),

    insertBan: db.prepare(`
      INSERT INTO banned_hosts (host, host_suffix, path_prefix, reason, created_at)
      VALUES (:host, :host_suffix, :path_prefix, :reason, :created_at)
    `),

    // §4's predicate, outer parentheses and all. They are load-bearing: SQL binds
    // AND tighter than OR, so `A OR B AND C` would let the exact-host arm ignore
    // path_prefix and turn a ban on one Mastodon account into a ban on the whole
    // instance. substr() rather than LIKE, because '_' and '%' are LIKE
    // wildcards and '/@some_user' would then also match '/@someXuser'.
    findBan: db.prepare(`
      SELECT host, host_suffix, path_prefix, reason, created_at
        FROM banned_hosts
       WHERE (    (host <> '' AND host = :host)
               OR (host_suffix <> ''
                   AND substr(:host, -length(host_suffix)) = host_suffix) )
         AND (path_prefix = ''
              OR substr(:path, 1, length(path_prefix)) = path_prefix)
       LIMIT 1
    `),

    insertSubmission: db.prepare(`
      INSERT INTO submissions (
        submitted_url, normalized_url, ip_hash, result, reason, created_at
      ) VALUES (
        :submitted_url, :normalized_url, :ip_hash, :result, :reason, :created_at
      )
    `),

    insertReport: db.prepare(`
      INSERT INTO reports (site_id, url, reason, contact, ip_hash, created_at)
      VALUES (:site_id, :url, :reason, :contact, :ip_hash, :created_at)
    `),

    getSiteByUrl: db.prepare('SELECT * FROM sites WHERE url = :url'),
    getSiteByFeedUrl: db.prepare('SELECT * FROM sites WHERE feed_url = :feed_url'),
    getSiteById: db.prepare('SELECT * FROM sites WHERE id = :id'),

    // §6's /status rule: match the canonical `url` OR the `submitted_url`. A member
    // types what they submitted, which is often a different page from the canonical
    // one we stored. `idx_sites_submitted` (§4) exists for this query.
    getSiteBySubmittedUrl: db.prepare(
      'SELECT * FROM sites WHERE url = :url OR submitted_url = :url ORDER BY id LIMIT 1',
    ),

    /**
     * §5 Step 7's refresh. Deliberately does NOT touch `status`: `hidden` is
     * terminal, and an `UPDATE … SET status = 'active'` here was the one-request,
     * no-auth undo of the only lightweight moderation lever there is. The caller
     * decides whether a status change is allowed; this statement can't grant one.
     */
    updateSite: db.prepare(`
      UPDATE sites
         SET submitted_url    = :submitted_url,
             host             = :host,
             path             = :path,
             feed_url         = :feed_url,
             title            = :title,
             description      = :description,
             has_source_ns    = :has_source_ns,
             has_rsscloud     = :has_rsscloud,
             rsscloud_style   = :rsscloud_style,
             cloud_json       = :cloud_json,
             url              = :url,
             failure_count    = 0,
             optout_seen_at   = NULL,
             last_error       = NULL,
             last_verified_at = :now,
             last_checked_at  = :now
       WHERE id = :id
    `),

    reviveSite: db.prepare(
      "UPDATE sites SET status = 'active' WHERE id = :id AND status <> 'hidden'",
    ),

    setSiteStatus: db.prepare('UPDATE sites SET status = :status WHERE id = :id'),

    /**
     * §5 Step 7's per-domain cap. `host = :domain OR substr(host, -length(…))`, not
     * `LIKE`: `_` and `%` are LIKE wildcards, so a cap keyed on `a_b.com` would
     * also count `axb.com`. The leading dot on the suffix is what keeps
     * `notexample.com` out of `example.com`'s count.
     *
     * Only the statuses that are (or can return to) the OPML count. A `removed` row
     * holding a slot forever would make the cap a permanent outage.
     */
    countListingsForDomain: db.prepare(`
      SELECT count(*) AS n
        FROM sites
       WHERE (host = :domain OR substr(host, -length(:dotted)) = :dotted)
         AND status IN ('active', 'failing', 'blocked', 'hidden')
    `),

    countSitesCreatedSince: db.prepare(
      'SELECT count(*) AS n FROM sites WHERE created_at >= :since',
    ),

    countSites: db.prepare(
      "SELECT count(*) AS n FROM sites WHERE status IN ('active', 'failing', 'blocked')",
    ),

    insertModerationLog: db.prepare(`
      INSERT INTO moderation_log (site_id, action, reason, created_at)
      VALUES (:site_id, :action, :reason, :created_at)
    `),

    // §4: hide every site the ban covers, using the same full predicate as findBan —
    // otherwise a ban leaves the banned rows in the OPML until the §7 backstop join
    // happens to be consulted.
    hideSitesMatchingBan: db.prepare(`
      UPDATE sites
         SET status = 'hidden'
       WHERE (    (:host <> '' AND host = :host)
               OR (:host_suffix <> ''
                   AND substr(host, -length(:host_suffix)) = :host_suffix) )
         AND (:path_prefix = ''
              OR substr(path, 1, length(:path_prefix)) = :path_prefix)
    `),

    insertSite: db.prepare(`
      INSERT INTO sites (
        url, submitted_url, host, path, feed_url, title, description,
        has_source_ns, has_rsscloud, rsscloud_style, cloud_json,
        created_at, last_verified_at, last_checked_at
      ) VALUES (
        :url, :submitted_url, :host, :path, :feed_url, :title, :description,
        :has_source_ns, :has_rsscloud, :rsscloud_style, :cloud_json,
        :now, :now, :now
      )
    `),
  };

  return {
    getDirectoryVersion: () => statements.getDirectoryVersion.get(),

    getSiteByUrl: (url) => statements.getSiteByUrl.get({ url }),
    getSiteByFeedUrl: (feedUrl) => statements.getSiteByFeedUrl.get({ feed_url: feedUrl }),
    getSiteById: (id) => statements.getSiteById.get({ id }),
    getSiteBySubmittedUrl: (url) => statements.getSiteBySubmittedUrl.get({ url }),

    countSites: () => statements.countSites.get().n,

    /**
     * How many listings does this registrable domain already hold? `domain` comes
     * from `tldts` with `allowPrivateDomains: true` (§5 Step 7 — the flag is not
     * optional), and subdomains are counted via the dotted suffix.
     */
    countListingsForDomain: (domain) =>
      statements.countListingsForDomain.get({ domain, dotted: `.${domain}` }).n,

    countSitesCreatedSince: (since) => statements.countSitesCreatedSince.get({ since }).n,

    /**
     * Refresh an existing row from a fresh verification. Returns nothing; the
     * caller already knows the id.
     *
     * `status` is untouched here — see the statement. `revive` asks separately for
     * the `failing`/`blocked` → `active` transition, and it cannot reach `hidden`.
     */
    updateSite(id, site, { revive = true } = {}) {
      const now = new Date().toISOString();

      statements.updateSite.run({
        id,
        url: site.url,
        submitted_url: site.submitted_url,
        host: site.host,
        path: site.path,
        feed_url: site.feed_url,
        title: site.title,
        description: opt(site.description),
        has_source_ns: bool(site.has_source_ns),
        has_rsscloud: bool(site.has_rsscloud),
        rsscloud_style: opt(site.rsscloud_style),
        cloud_json: opt(site.cloud_json),
        now,
      });

      if (revive) statements.reviveSite.run({ id });

      statements.bumpDirectoryVersion.run();
    },

    /** §12 phase 5's moderation lever. `hidden` is terminal for the upsert. */
    hideSite(id, reason) {
      statements.setSiteStatus.run({ id, status: 'hidden' });
      statements.insertModerationLog.run({
        site_id: id,
        action: 'hide',
        reason: opt(reason),
        created_at: new Date().toISOString(),
      });
      statements.bumpDirectoryVersion.run();
    },

    /** The only thing that clears `hidden` (§5 Step 7). Re-verification is phase 8. */
    unhideSite(id, reason) {
      statements.setSiteStatus.run({ id, status: 'active' });
      statements.insertModerationLog.run({
        site_id: id,
        action: 'unhide',
        reason: opt(reason),
        created_at: new Date().toISOString(),
      });
      statements.bumpDirectoryVersion.run();
    },

    logModeration(entry) {
      statements.insertModerationLog.run({
        site_id: opt(entry.site_id),
        action: entry.action,
        reason: opt(entry.reason),
        created_at: new Date().toISOString(),
      });
    },

    /**
     * The listing cap for a registrable domain: the `domain_limits` override if
     * there is one, otherwise `fallback` (config's MAX_LISTINGS_PER_DOMAIN).
     * `-1` means unlimited.
     */
    maxListingsForDomain: (domain, fallback) =>
      statements.maxListingsForDomain.get({ domain, fallback }).max_listings,

    /**
     * Is this (host, path) banned? Returns the matching row, or `undefined`.
     */
    findBan: ({ host, path }) => statements.findBan.get({ host, path }),

    /**
     * Add a ban. `host_suffix` and `path_prefix` default to '' rather than NULL:
     * NULLs are distinct in a SQLite unique index, so a nullable column would let
     * the same ban be inserted twice and make ON CONFLICT silently not fire (§4).
     */
    insertBan(ban) {
      const host = ban.host ?? '';
      const host_suffix = ban.host_suffix ?? '';
      const path_prefix = ban.path_prefix ?? '';

      statements.insertBan.run({
        host,
        host_suffix,
        path_prefix,
        reason: opt(ban.reason),
        created_at: new Date().toISOString(),
      });

      // §6: "Add host to banned_hosts AND hide all its sites." The §7 backstop join
      // makes the OPML correct either way, but /sites and /status read `status`, so
      // without this a banned member still looks listed to everyone but a reader.
      statements.hideSitesMatchingBan.run({ host, host_suffix, path_prefix });
      statements.insertModerationLog.run({
        site_id: null,
        action: 'ban',
        reason: opt(ban.reason),
        created_at: new Date().toISOString(),
      });

      // §4: every banned_hosts insert invalidates the OPML too — the §7 backstop
      // join means a ban can remove members without touching a `sites` row.
      statements.bumpDirectoryVersion.run();
    },

    /**
     * Log a submission attempt, whatever its outcome. No version bump: the
     * attempt log is not part of the directory.
     */
    insertSubmission(submission) {
      statements.insertSubmission.run({
        submitted_url: submission.submitted_url,
        normalized_url: opt(submission.normalized_url),
        ip_hash: submission.ip_hash,
        result: submission.result,
        reason: opt(submission.reason),
        created_at: new Date().toISOString(),
      });
    },

    /**
     * File an abuse report. No version bump: a report changes no outline.
     */
    insertReport(report) {
      statements.insertReport.run({
        site_id: opt(report.site_id),
        url: report.url,
        reason: report.reason,
        contact: opt(report.contact),
        ip_hash: report.ip_hash,
        created_at: new Date().toISOString(),
      });
    },

    /**
     * Insert a freshly verified site. Returns the new row id.
     *
     * The directory-version bump is INSIDE this helper on purpose (§7): the call
     * sites are spread across phases 5, 6 and 8, and one that forgets is
     * invisible until a cache serves a member we already removed.
     */
    insertSite(site) {
      const now = new Date().toISOString();

      const { lastInsertRowid } = statements.insertSite.run({
        url: site.url,
        submitted_url: site.submitted_url,
        host: site.host,
        path: site.path,
        feed_url: site.feed_url,
        title: site.title,
        description: opt(site.description),
        has_source_ns: bool(site.has_source_ns),
        has_rsscloud: bool(site.has_rsscloud),
        rsscloud_style: opt(site.rsscloud_style),
        cloud_json: opt(site.cloud_json),
        now,
      });

      statements.bumpDirectoryVersion.run();

      return Number(lastInsertRowid);
    },
  };
}
