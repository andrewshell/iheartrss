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

/**
 * §7's backstop join, as a correlated `NOT EXISTS` over `banned_hosts`.
 *
 * §4's predicate verbatim — **note the outer parentheses**, which are load-bearing:
 * SQL binds AND tighter than OR, so `A OR B AND C` lets the exact-host arm ignore
 * `path_prefix` and turns a ban on one Mastodon account into a ban on the whole
 * instance. Written once and shared by every listing query below, because two
 * copies of this predicate is two chances to drop a bracket.
 *
 * It is a *backstop*: `insertBan` already hides the matching rows. The join is what
 * makes the OPML correct when a ban lands without touching a `sites` row at all.
 */
const NOT_BANNED = `
  NOT EXISTS (
    SELECT 1 FROM banned_hosts b
     WHERE (    (b.host <> '' AND b.host = s.host)
             OR (b.host_suffix <> ''
                 AND substr(s.host, -length(b.host_suffix)) = b.host_suffix) )
       AND (b.path_prefix = ''
            OR substr(s.path, 1, length(b.path_prefix)) = b.path_prefix)
  )`;

// §7: "Generated on demand from `status IN ('active','failing','blocked')`."
// `blocked` is in the list deliberately (§4, §8): being 403'd by Cloudflare from a
// datacentre IP is not the member's failure, and dropping `blocked` from this one
// line silently reverts that whole decision to a no-op.
const LISTED_STATUSES = "s.status IN ('active', 'failing', 'blocked')";

export function createQueries(db) {
  const statements = {
    // §7: ordered by title. `s.id` breaks ties so the outline set — and therefore
    // the ETag hashed from it — is stable across renders when two members share a
    // title.
    listOutlines: db.prepare(`
      SELECT s.id, s.title, s.description, s.feed_url, s.url
        FROM sites s
       WHERE ${LISTED_STATUSES}
         AND ${NOT_BANNED}
       ORDER BY s.title, s.id
    `),

    // §6.3: "All members on one page, newest first" — no pagination, no LIMIT. The
    // same listed-status set and the same ban backstop as the OPML, because /sites is
    // "a human-readable view of what's in the OPML" and the two disagreeing is the
    // bug the page exists to catch.
    listMembers: db.prepare(`
      SELECT s.id, s.title, s.description, s.url, s.host, s.feed_url,
             s.has_source_ns, s.has_rsscloud, s.status, s.created_at
        FROM sites s
       WHERE ${LISTED_STATUSES}
         AND ${NOT_BANNED}
       ORDER BY s.created_at DESC, s.id DESC
    `),

    getDirectoryVersion: db.prepare(
      'SELECT version, outline_hash, updated_at FROM directory_version WHERE id = 1',
    ),

    // §7: the write helpers bump `version` ONLY. `outline_hash` and `updated_at`
    // are recomputed lazily at render time in phase 6, because hashing anything
    // that moves on every `last_checked_at` write would be a 100% cache miss.
    bumpDirectoryVersion: db.prepare(
      'UPDATE directory_version SET version = version + 1 WHERE id = 1',
    ),

    // The other half of §7's two steps, and the ONLY statement that writes
    // `outline_hash`/`updated_at`. Called from the render path (`lib/opml.js`), not
    // from a write helper — see `bumpDirectoryVersion` above.
    saveOutlineHash: db.prepare(`
      UPDATE directory_version
         SET outline_hash = :outline_hash, updated_at = :updated_at
       WHERE id = 1
    `),

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

    /**
     * §8's batch selection, live arm: everything that is (or is on its way back
     * to) the OPML, plus **any row carrying an `optout_seen_at`** — those move to
     * the 24-hour follow-up cadence regardless of status, because without that arm
     * the removal promise is arithmetically false (a first sighting lands by day 6
     * and the confirming one by day 12, against an /about promise of a week).
     *
     * `ORDER BY` is **(status_priority, last_checked_at)**, never
     * `last_checked_at` alone (§8): a `dropped` row last checked 31 days ago
     * otherwise sorts ahead of an `active` row at 7 days, so a few hundred
     * accumulated dead domains monopolise every batch and live members stop being
     * revalidated — the "within a week" promise failing first for exactly the
     * sites that matter most. The dormant statuses are a separate statement with
     * its own quota for the same reason.
     *
     * `status <> 'hidden'` guards the opt-out arm too: §4 says `hidden` is never
     * revalidated, and a hidden row that happens to hold a stale sighting must not
     * sneak in through the follow-up cadence.
     */
    dueForRevalidation: db.prepare(`
      SELECT * FROM sites
       WHERE status <> 'hidden'
         AND (    (optout_seen_at IS NOT NULL AND last_checked_at < :optout_cutoff)
               OR (status IN ('active', 'failing', 'blocked')
                   AND last_checked_at < :live_cutoff) )
       ORDER BY CASE WHEN optout_seen_at IS NOT NULL THEN 0
                     WHEN status = 'active'  THEN 1
                     WHEN status = 'failing' THEN 2
                     ELSE 3 END,
                last_checked_at
       LIMIT :limit
    `),

    /**
     * The dormant arm: `dropped` at 30 days and `removed` at 90 (§8). Rows holding
     * an `optout_seen_at` belong to the live arm's 24-hour cadence and are excluded
     * here so one row cannot be selected twice in a batch.
     */
    dueDormant: db.prepare(`
      SELECT * FROM sites
       WHERE optout_seen_at IS NULL
         AND (    (status = 'dropped' AND last_checked_at < :dropped_cutoff)
               OR (status = 'removed' AND last_checked_at < :removed_cutoff) )
       ORDER BY CASE WHEN status = 'dropped' THEN 0 ELSE 1 END, last_checked_at
       LIMIT :limit
    `),

    /**
     * §8's Pass row: `failure_count = 0`, `status = 'active'`, clear
     * `optout_seen_at`. Metadata and the conditional-GET validators come along,
     * because a re-verification is also the moment a renamed feed or a retitled
     * blog is noticed (§4: the version bump is a blanket rule precisely because
     * `title` is the OPML's ORDER BY key).
     *
     * `url` is deliberately absent from the SET list: §8 is explicit that
     * revalidation never re-derives the canonical URL, so `sites.url` is immutable
     * on this path. The `status <> 'hidden'` guard is defence in depth — a hidden
     * row is never selected in the first place.
     */
    markRevalidationPass: db.prepare(`
      UPDATE sites
         SET title              = :title,
             description        = :description,
             feed_url           = :feed_url,
             has_source_ns      = :has_source_ns,
             has_rsscloud       = :has_rsscloud,
             rsscloud_style     = :rsscloud_style,
             cloud_json         = :cloud_json,
             feed_etag          = :feed_etag,
             feed_last_modified = :feed_last_modified,
             status             = 'active',
             failure_count      = 0,
             optout_seen_at     = NULL,
             last_error         = NULL,
             last_verified_at   = :now,
             last_checked_at    = :now
       WHERE id = :id AND status <> 'hidden'
    `),

    /**
     * §8's first opt-out sighting: record it and **stay listed**. `status` is
     * untouched — a single 200-without-a-badge has too many innocent causes (a
     * redesign that drops the footer, a platform migration, a Cloudflare JS
     * challenge, a stale CDN page, a parked billing-lapse page) to act on
     * irreversibly.
     */
    markOptoutSighting: db.prepare(`
      UPDATE sites
         SET optout_seen_at  = :seen_at,
             last_error      = 'no_linkback',
             last_checked_at = :now
       WHERE id = :id AND status <> 'hidden'
    `),

    /**
     * §8's confirming sighting. `status = 'removed'` **and `optout_seen_at = NULL`
     * in the same statement** — the two halves cannot be allowed to drift apart,
     * because a `removed` row still holding a sighting stays on the 24-hour arm
     * forever instead of the 90-day retry.
     */
    markOptoutConfirmed: db.prepare(`
      UPDATE sites
         SET status          = 'removed',
             optout_seen_at  = NULL,
             last_error      = 'no_linkback',
             last_checked_at = :now
       WHERE id = :id AND status <> 'hidden'
    `),

    /**
     * "We looked, and nothing about the row's state changes." Used by the branches
     * that must not write anything else — a sighting inside the 24-hour floor, and a
     * `removed` row whose 90-day retry still finds no link-back — so that the row
     * leaves the batch instead of being re-selected on the next tick forever.
     */
    touchLastChecked: db.prepare(`
      UPDATE sites
         SET last_checked_at = :now, last_error = :last_error
       WHERE id = :id AND status <> 'hidden'
    `),

    /**
     * §8's Transient row: `failure_count += 1`, `status = 'failing'`, → `dropped`
     * at 3. A timeout, a DNS/TLS error, a 5xx, a size cap and a broken feed all land
     * here, and all of them get the full grace period: "a missing or broken feed is
     * deliberately *not* an opt-out — that's usually a site migration or a generator
     * bug."
     *
     * `removed` is pinned: for an opted-out row "only a Pass matters" (§8), and
     * `failing` would put someone who opted out back in the OPML on the strength of a
     * DNS blip. `hidden` is excluded outright.
     */
    markTransientFailure: db.prepare(`
      UPDATE sites
         SET failure_count   = failure_count + 1,
             status          = CASE
                                 WHEN status = 'removed' THEN 'removed'
                                 WHEN failure_count + 1 >= :max_failures THEN 'dropped'
                                 ELSE 'failing'
                               END,
             last_error      = :last_error,
             last_checked_at = :now
       WHERE id = :id AND status <> 'hidden'
    `),

    /**
     * §8's Blocked row: `status = 'blocked'`, **stays in the OPML**, flagged for
     * admin. Reachable only from `active`/`failing`/`blocked` (§4: "by a site that
     * has already passed at least once … never at submission") — a 403 must not
     * promote a `dropped` or `removed` row back into the list.
     *
     * `failure_count` is untouched: being 403'd from a datacentre IP is not a strike
     * against the member.
     */
    markBlocked: db.prepare(`
      UPDATE sites
         SET status          = 'blocked',
             last_error      = :last_error,
             last_checked_at = :now
       WHERE id = :id AND status IN ('active', 'failing', 'blocked')
    `),

    /**
     * §4's exit from `blocked`: 90 consecutive days demotes to `dropped`.
     *
     * The clock is `last_verified_at` — the last time the row actually *passed* —
     * rather than a `blocked_since` column: a row can only enter `blocked` from
     * `active`/`failing`, and `failing` is capped at three strikes, so "blocked and
     * not verified for 90 days" is the same population as "90 consecutive days
     * blocked", give or take the couple of weeks of grace that preceded it.
     */
    demoteStaleBlocked: db.prepare(`
      UPDATE sites
         SET status          = 'dropped',
             last_error      = :last_error,
             last_checked_at = :now
       WHERE id = :id AND status = 'blocked' AND last_verified_at < :verified_before
    `),

    /**
     * §4's retention rules, both run on the revalidation tick.
     *
     * `submissions` grows forever as written, and "a salted IP hash is still personal
     * data" — /about's privacy note promises 90 days, so this statement is what makes
     * that promise true.
     */
    purgeSubmissions: db.prepare('DELETE FROM submissions WHERE created_at < :before'),

    /**
     * "Hard-delete `dropped` rows after ~1 year so dead domains don't accumulate
     * indefinitely (§4) — they also distort scheduling (§8)."
     *
     * Keyed on `last_verified_at`, the last time the row actually worked: a `dropped`
     * row is still revalidated every 30 days, so `last_checked_at` never ages past a
     * month and would never match.
     */
    purgeDroppedSites: db.prepare(`
      DELETE FROM sites
       WHERE status = 'dropped' AND last_verified_at < :before
    `),

    /**
     * §8's capacity ceiling, made observable. 20 sites/hour × 24 hours at a 6-day
     * interval is a steady state of ~2,880 members; past that `last_checked_at`
     * slides permanently past the interval and the /about promise quietly becomes
     * false **with no signal anywhere**, because "/healthz reports whether a batch
     * ran, not how far behind it is."
     *
     * `SUM` over a CASE rather than a second query, and `hidden` excluded: it is
     * never revalidated, so it can never be overdue.
     */
    revalidationBacklog: db.prepare(`
      SELECT MIN(last_checked_at) AS oldest_last_checked_at,
             SUM(CASE WHEN last_checked_at < :cutoff THEN 1 ELSE 0 END) AS overdue_count
        FROM sites
       WHERE status IN ('active', 'failing', 'blocked')
    `),

    // ── `POST /recheck/:id` (§6, "Why /recheck/:id must be pass-only") ────────
    //
    // These three statements are deliberately separate from the scheduler's. Two
    // rules are encoded in the SQL itself, where a caller cannot forget them:
    //
    //  * **Neither of them writes `last_checked_at`.** /recheck has its own
    //    `last_recheck_at` clock precisely "so it can't reset the scheduler's" — and
    //    the scheduler's cadence is what the "removed within a week" promise is made
    //    of.
    //  * **The sighting is `INSERT`-once.** `optout_seen_at IS NULL` in the WHERE
    //    clause is what makes "may record a first sighting but never the confirming
    //    one" true no matter how the route evolves: two rechecks 24h apart must not
    //    delist anybody.

    markRecheckPass: db.prepare(`
      UPDATE sites
         SET title              = :title,
             description        = :description,
             feed_url           = :feed_url,
             has_source_ns      = :has_source_ns,
             has_rsscloud       = :has_rsscloud,
             rsscloud_style     = :rsscloud_style,
             cloud_json         = :cloud_json,
             feed_etag          = :feed_etag,
             feed_last_modified = :feed_last_modified,
             status             = 'active',
             failure_count      = 0,
             optout_seen_at     = NULL,
             last_error         = NULL,
             last_verified_at   = :now,
             last_recheck_at    = :now
       WHERE id = :id AND status <> 'hidden'
    `),

    markRecheckOptoutSighting: db.prepare(`
      UPDATE sites
         SET optout_seen_at  = :now,
             last_recheck_at = :now
       WHERE id = :id AND status NOT IN ('hidden', 'removed') AND optout_seen_at IS NULL
    `),

    /** The cooldown clock, written even when the outcome itself is a no-op. */
    markRecheckedAt: db.prepare(
      "UPDATE sites SET last_recheck_at = :now WHERE id = :id AND status <> 'hidden'",
    ),

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

    /** §7's outline set: what `/subscriptions.opml` serialises, in render order. */
    listOutlines: () => statements.listOutlines.all(),

    /** §6.3's `/sites`: the same members, newest first, all of them. */
    listMembers: () => statements.listMembers.all(),

    /**
     * Record a freshly computed outline hash and the timestamp that goes with it.
     *
     * Deliberately NOT folded into `bumpDirectoryVersion`: §7 is explicit that the
     * bump is "the *trigger to recompute*, not the thing that stamps the timestamp".
     */
    saveOutlineHash: ({ outlineHash, updatedAt }) =>
      statements.saveOutlineHash.run({
        outline_hash: outlineHash,
        updated_at: updatedAt,
      }),

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
    /**
     * §8's batch, live arm. Cutoffs are ISO strings computed by the caller from the
     * injected clock — never `datetime('now')`, which would compare a
     * space-separated SQL timestamp against a `T`-separated JS one and silently
     * select every row (§4).
     */
    dueForRevalidation: ({ liveCutoff, optoutCutoff, limit }) =>
      statements.dueForRevalidation.all({
        live_cutoff: liveCutoff,
        optout_cutoff: optoutCutoff,
        limit,
      }),

    /** §8's batch, dormant arm: `dropped` at 30 days, `removed` at 90. */
    dueDormant: ({ droppedCutoff, removedCutoff, limit }) =>
      statements.dueDormant.all({
        dropped_cutoff: droppedCutoff,
        removed_cutoff: removedCutoff,
        limit,
      }),

    /**
     * §8's Pass. `now` is passed in rather than read here so the scheduler's
     * injected clock is the only clock in the run.
     */
    recordRevalidationPass(id, site, { now }) {
      statements.markRevalidationPass.run({
        id,
        title: site.title,
        description: opt(site.description),
        feed_url: site.feed_url,
        has_source_ns: bool(site.has_source_ns),
        has_rsscloud: bool(site.has_rsscloud),
        rsscloud_style: opt(site.rsscloud_style),
        cloud_json: opt(site.cloud_json),
        feed_etag: opt(site.feed_etag),
        feed_last_modified: opt(site.feed_last_modified),
        now,
      });

      statements.bumpDirectoryVersion.run();
    },

    /**
     * §8: record a first (or restarted) opt-out sighting. The row stays listed;
     * only `recordOptoutConfirmed` may remove it, and only the scheduler may call
     * that (§6, "Why /recheck/:id must be pass-only").
     */
    recordOptoutSighting(id, { seenAt, now }) {
      statements.markOptoutSighting.run({ id, seen_at: seenAt, now });
      statements.bumpDirectoryVersion.run();
    },

    /**
     * §8's second confirmation — the only statement that turns an opt-out into
     * `removed`, and only the scheduler ever calls it.
     */
    recordOptoutConfirmed(id, { now }) {
      statements.markOptoutConfirmed.run({ id, now });
      statements.bumpDirectoryVersion.run();
    },

    /**
     * §8's Blocked outcome, with §4's 90-day exit applied first: if this row has
     * been blocked past the limit it is demoted to `dropped` instead, so parked
     * domains behind a 403 don't sit in every subscriber's OPML forever. Returns
     * the status it settled on.
     */
    recordBlocked(id, { now, error, verifiedBefore }) {
      const demoted = statements.demoteStaleBlocked.run({
        id,
        now,
        last_error: opt(error),
        verified_before: verifiedBefore,
      });

      if (demoted.changes > 0) {
        statements.bumpDirectoryVersion.run();
        return 'dropped';
      }

      const marked = statements.markBlocked.run({ id, now, last_error: opt(error) });

      // A `dropped` or `removed` row is not eligible for `blocked` — but we did look,
      // and a row whose `last_checked_at` never moves is re-selected on every tick
      // for the rest of time.
      if (marked.changes === 0) {
        statements.touchLastChecked.run({ id, now, last_error: opt(error) });
      }

      statements.bumpDirectoryVersion.run();
      return marked.changes > 0 ? 'blocked' : 'unchanged';
    },

    /** §8's Transient outcome. `maxFailures` is 3 — the 3-strike grace. */
    recordTransientFailure(id, { now, error, maxFailures }) {
      statements.markTransientFailure.run({
        id,
        now,
        last_error: opt(error),
        max_failures: maxFailures,
      });
      statements.bumpDirectoryVersion.run();
    },

    /**
     * §8's capacity ceiling for `/healthz`. `SUM` is NULL on an empty table, so the
     * count is coerced — a JSON `null` where monitoring expects a number is a
     * dashboard that silently shows nothing.
     */
    revalidationBacklog(cutoff) {
      const row = statements.revalidationBacklog.get({ cutoff });
      return {
        oldest_last_checked_at: row?.oldest_last_checked_at ?? null,
        overdue_count: row?.overdue_count ?? 0,
      };
    },

    /** §4's 90-day submission retention. Returns the number of rows deleted. */
    purgeSubmissions: (before) => statements.purgeSubmissions.run({ before }).changes,

    /**
     * §4's ~1-year `dropped` purge. Bumps the directory version: the rows are not in
     * the OPML, but they *were*, and §4 states the bump as a blanket rule rather than
     * an enumerated list on purpose.
     */
    purgeDroppedSites(before) {
      const { changes } = statements.purgeDroppedSites.run({ before });
      if (changes > 0) statements.bumpDirectoryVersion.run();
      return changes;
    },

    /**
     * §6's `/recheck/:id` pass: "reset failure_count, status = 'active', clear
     * optout_seen_at". Never `last_checked_at` — see the statements.
     */
    recordRecheckPass(id, site, { now }) {
      statements.markRecheckPass.run({
        id,
        title: site.title,
        description: opt(site.description),
        feed_url: site.feed_url,
        has_source_ns: bool(site.has_source_ns),
        has_rsscloud: bool(site.has_rsscloud),
        rsscloud_style: opt(site.rsscloud_style),
        cloud_json: opt(site.cloud_json),
        feed_etag: opt(site.feed_etag),
        feed_last_modified: opt(site.feed_last_modified),
        now,
      });

      statements.bumpDirectoryVersion.run();
    },

    /**
     * §6: a /recheck "may record a *first* `optout_seen_at` but **never** the
     * confirming one". Returns whether a sighting was recorded.
     */
    recordRecheckOptoutSighting(id, { now }) {
      const { changes } = statements.markRecheckOptoutSighting.run({ id, now });
      if (changes > 0) statements.bumpDirectoryVersion.run();
      return changes > 0;
    },

    /** The /recheck cooldown clock, written even for a no-op outcome. */
    recordRecheckedAt(id, { now }) {
      statements.markRecheckedAt.run({ id, now });
    },

    /** Record that we looked, and nothing else. */
    touchLastChecked(id, { now, error }) {
      statements.touchLastChecked.run({ id, now, last_error: opt(error) });
      statements.bumpDirectoryVersion.run();
    },

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
