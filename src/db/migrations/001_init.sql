-- Plan §4. Transcribed from the schema block, comments and all: every one of them
-- records a verified finding, and the next person to edit this file needs them.

-- Every submission attempt, for rate limiting, abuse triage, and "why did mine fail?"
CREATE TABLE submissions (
  id            INTEGER PRIMARY KEY,
  submitted_url TEXT NOT NULL,
  normalized_url TEXT,
  -- HMAC-SHA256(key, truncate(ip) + YYYY-MM-DD). Never the raw IP. Three deliberate choices:
  --   * HMAC with a key from a mounted FILE, not sha256 with an env-var salt. The whole
  --     IPv4 space is 2^32 — a plain salted digest is a GPU-minutes rainbow table, so the
  --     scheme rests entirely on the secret, and an env var sits in `docker inspect`, in
  --     dockge's UI, and in any .env backed up beside ./data.
  --   * Truncate first: /24 for IPv4, /64 for IPv6. That is all the precision abuse triage
  --     needs (and /64 is already the rate-limit bucket), and it makes the input space
  --     small enough that correlation across days is the only real risk — hence:
  --   * A daily-rotating date component, so hashes older than the abuse window can't be
  --     linked to today's.
  ip_hash       TEXT NOT NULL,
  result        TEXT NOT NULL,   -- 'added' | 'updated' | 'rejected' | 'error'
  reason        TEXT,            -- machine code, e.g. 'no_linkback'
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_submissions_created ON submissions(created_at);

-- Hosts you never want to see again. path_prefix scopes the ban on multi-tenant hosts:
-- ('mastodon.social', '/@spammer') bans one account, ('spam.example', NULL) bans a site.
-- path_prefix is NOT NULL DEFAULT '' on purpose: NULLs are distinct in a SQLite unique
-- index, so a nullable column lets ('spam.example', NULL) be inserted twice and makes
-- ON CONFLICT / INSERT OR REPLACE silently not fire. '' means site-wide.
-- host_suffix ('.attacker.example') bans a whole wildcard-DNS domain in one row; without it,
-- cleaning up a bulk flood is one INSERT per subdomain, forever.
CREATE TABLE banned_hosts (
  host        TEXT NOT NULL,   -- exact host, or '' when host_suffix is used
  host_suffix TEXT NOT NULL DEFAULT '',
  path_prefix TEXT NOT NULL DEFAULT '',
  reason      TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (host, host_suffix, path_prefix)
);
-- Ban matches when — NOTE THE OUTER PARENTHESES, they are load-bearing:
--   (    (host <> '' AND host = sites.host)
--     OR (host_suffix <> '' AND substr(sites.host, -length(host_suffix)) = host_suffix) )
--   AND (path_prefix = '' OR substr(sites.path, 1, length(path_prefix)) = path_prefix)
-- SQL binds AND tighter than OR, so without the outer parens this evaluates as
-- A OR (B AND C) — the exact-host arm ignores path_prefix entirely and a ban on
-- mastodon.social/@spammer silently takes out the whole instance. Verified.
-- Use substr(), NOT LIKE: '_' and '%' are LIKE wildcards, so a ban on
-- 'mastodon.social/@some_user' would also match '/@someXuser'.

CREATE TABLE sites (
  id                 INTEGER PRIMARY KEY,
  url                TEXT    NOT NULL UNIQUE,   -- CANONICAL url: the feed's <channel><link>,
                                                -- post-redirect. This is the OPML htmlUrl and
                                                -- the page that must carry the link-back.
  submitted_url      TEXT    NOT NULL,          -- what was originally typed in, for provenance
  host               TEXT    NOT NULL,          -- lowercased hostname of url, for bans
  path               TEXT    NOT NULL,          -- url.pathname, for path-scoped bans (§7 backstop
                                                -- joins in SQL and can't parse a URL)
  feed_url           TEXT    NOT NULL UNIQUE,   -- absolute URL of the validated feed.
                                                -- UNIQUE: identity is the feed — see §5 Step 7
  title              TEXT    NOT NULL,          -- feed <channel><title> (Step 3 hard-rejects a
                                                -- feed without one, so there is no fallback)
  description        TEXT,                      -- feed <channel><description>
  has_source_ns      INTEGER NOT NULL DEFAULT 0,-- boolean: source.scripting.com namespace
  has_rsscloud       INTEGER NOT NULL DEFAULT 0,-- boolean: <cloud> OR <source:cloud>
  rsscloud_style     TEXT,                      -- 'element' | 'source' | 'both' | NULL
  cloud_json         TEXT,                      -- full <cloud> attribute set + source:cloud URL,
                                                -- so a future registrar (§10) needn't re-crawl
  status             TEXT    NOT NULL DEFAULT 'active',
                                                -- 'active' | 'failing' | 'blocked'
                                                -- | 'dropped' | 'removed' | 'hidden'
  failure_count      INTEGER NOT NULL DEFAULT 0,
  optout_seen_at     TEXT,                      -- first of the 2 confirmations before 'removed'
  last_error         TEXT,
  feed_etag          TEXT,                      -- conditional GET on revalidation
  feed_last_modified TEXT,
  created_at         TEXT    NOT NULL,          -- ISO 8601 UTC
  last_verified_at   TEXT    NOT NULL,          -- last time it fully PASSED
  last_checked_at    TEXT    NOT NULL,          -- last scheduler check, pass or fail
  last_recheck_at    TEXT                       -- last /recheck/:id, separate cooldown clock
);

CREATE INDEX idx_sites_status_checked ON sites(status, last_checked_at);
CREATE INDEX idx_sites_host           ON sites(host);
CREATE INDEX idx_sites_submitted      ON sites(submitted_url);  -- /status lookups

-- Abuse reports from the public. The OPML is consumed by other people's readers, so
-- there has to be a route for "this member is now serving malware".
CREATE TABLE reports (
  id         INTEGER PRIMARY KEY,
  -- ON DELETE SET NULL, not the default: with foreign_keys = ON, deleting a site that was
  -- ever reported raises FOREIGN KEY constraint failed — inside the revalidation tick that
  -- runs the year-old-dropped-row purge, aborting the rest of the batch. url is kept
  -- independently so the audit trail survives the site row.
  site_id    INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  url        TEXT NOT NULL,
  reason     TEXT NOT NULL,
  contact    TEXT,
  ip_hash    TEXT NOT NULL,   -- same construction as submissions.ip_hash
  handled_at TEXT,
  created_at TEXT NOT NULL
);

-- Every admin action, so there's a record of what was done and why.
CREATE TABLE moderation_log (
  id         INTEGER PRIMARY KEY,
  site_id    INTEGER,
  action     TEXT NOT NULL,   -- 'hide' | 'unhide' | 'ban' | 'delete'
  reason     TEXT,
  created_at TEXT NOT NULL
);

-- Bumped on EVERY write to a row whose status is (or was) in the OPML set, plus every
-- banned_hosts insert. Stated as a blanket rule on purpose: an enumerated list of
-- "OPML-relevant mutations" WILL miss title/description changes on re-verification, and
-- title is the ORDER BY key — so the body reorders while Last-Modified doesn't move, and
-- an If-Modified-Since-only client caches stale content forever.
-- See §7 — without this, removals are invisible to caches.
-- updated_at is required: <dateModified> and Last-Modified are timestamps, and you
-- cannot render either from a monotonic integer.
CREATE TABLE directory_version (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  version      INTEGER NOT NULL,   -- bumped by every write; the trigger to recompute
  outline_hash TEXT    NOT NULL,   -- hash of the OUTLINE SET only; the actual ETag
  updated_at   TEXT    NOT NULL    -- advanced only when outline_hash changes
);
-- Seed row 1 in the SAME migration. Without it, the bump
-- `UPDATE directory_version SET version = version + 1 WHERE id = 1`
-- matches nothing and returns changes: 0 — a silent no-op, so nothing is ever invalidated.
INSERT INTO directory_version (id, version, outline_hash, updated_at)
VALUES (1, 0, '', '1970-01-01T00:00:00.000Z');

-- Per-domain listing cap overrides. tldts with allowPrivateDomains:true separates
-- alice.github.io / alice.blogspot.com / alice.bearblog.dev, but NOT substack.com,
-- wordpress.com, tumblr.com, micro.blog or neocities.org — and path-based hosts
-- (mastodon.social, medium.com, tilde.club) are one domain by construction. Without
-- overrides, MAX_LISTINGS_PER_DOMAIN=5 refuses the 6th Substack / Micro.blog / Mastodon
-- member ever, globally and permanently. Micro.blog is the cohort §1 notes already ships
-- xmlns:source — the last people to turn away.
CREATE TABLE domain_limits (
  domain       TEXT PRIMARY KEY,
  max_listings INTEGER NOT NULL,   -- -1 = unlimited
  note         TEXT
);
-- Seeded with the known multi-tenant hosts at -1. Cap query:
--   COALESCE((SELECT max_listings FROM domain_limits WHERE domain = ?), :default)
-- Editable from /admin; the "admin-overridable" the cap promises lives here, not in env.
INSERT INTO domain_limits (domain, max_listings, note) VALUES
  ('substack.com',    -1, 'multi-tenant: PSL private section does not separate users'),
  ('wordpress.com',   -1, 'multi-tenant: PSL private section does not separate users'),
  ('tumblr.com',      -1, 'multi-tenant: PSL private section does not separate users'),
  ('micro.blog',      -1, 'multi-tenant: PSL private section does not separate users'),
  ('neocities.org',   -1, 'multi-tenant: PSL private section does not separate users'),
  ('medium.com',      -1, 'path-based: one domain by construction'),
  ('mastodon.social', -1, 'path-based: one domain by construction'),
  ('tilde.club',      -1, 'path-based: one domain by construction');

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
