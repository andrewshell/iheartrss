# iheartrss.com — Implementation Plan

A webring-style directory for people who love RSS. You put an "I ♥ RSS" link on your
homepage pointing at iheartrss.com; you submit your URL; we verify the link-back and a
discoverable RSS feed; you get added to a public list and an OPML subscription list that
FeedLand (and any other OPML-aware reader) can subscribe to.

---

## 1. Scope

### In scope (v1)

- Public homepage explaining the idea, with the badge/link snippets to copy.
- Submission form → synchronous validation → immediate pass/fail feedback.
- SQLite storage of verified sites and their feed metadata.
- `/sites` page so people can confirm they're listed and see what's in the OPML — all
  members on one page, newest first. Deliberately **not** on the homepage — see §10.
- **Responsive, mobile-first layout on every page** (§6.3). A requirement, not a polish pass.
- OPML subscription list at a stable URL for FeedLand, discoverable from `<head>`.
- A markdown-file blog with its own RSS feed, because a site about RSS needs one.
- Weekly automatic revalidation with a 3-strike grace period.
- Token-protected admin page to hide/ban sites and domains.
- Docker image + compose file for deployment via dockge.

### Out of scope (v1, noted where it would hook in)

- The feed reader / river on the homepage — out of scope for v1, and the reason the
  homepage carries no member list. **Shipped after launch** by embedding FeedLand, which
  left v1's architecture untouched; see §10.
- User accounts, editing your own listing, email notifications.
- Atom feed support (decision below).
- rssCloud *subscription* — we detect and record other sites' cloud support, we don't
  register with theirs. (Our **own** feed does advertise a cloud server and ping it on
  restart, as of §6.4 — that is publishing, not subscribing.)

### What RSS-2.0-only costs, and what we owe in return

The decision is settled (see the table below this one). This section exists so the cost is
carried with open eyes rather than discovered in the rejection logs. Checked live against
real platforms:

| Platform | `<head>` advertises | Passes? |
|---|---|---|
| **Jekyll + `jekyll-feed`** — the GitHub Pages default, incl. `jekyllrb.com` | Atom only | **No** |
| Eleventy official starter, Zola default | Atom | **No** |
| `daringfireball.net`, `simonwillison.net` | Atom only | **No** |
| YouTube channel feeds | Atom | **No** |
| Hugo, Astro `@astrojs/rss` | RSS 2.0 | Yes |
| WordPress, Ghost, Buttondown, Tumblr, Squarespace | RSS 2.0 | Yes |
| Blogger, Bear Blog | both | Yes |
| Micro.blog | RSS 2.0 — and already ships `xmlns:source` | Yes |
| Substack, Mastodon profile feeds | RSS 2.0 | Yes |

The rejected set skews hard toward the **hand-rolled static-site developer blog** — which is
disproportionately the "I love RSS" demographic. jekyll-feed emits Atom deliberately, so
every default GitHub Pages blog is excluded.

**So the guide is not optional.** A principled exclusion with no path in is just a closed
door; the same exclusion with a five-minute fix beside it is an invitation, and arguably does
more for RSS than quietly accepting Atom ever would. Every affected platform can emit RSS 2.0
with a small template or a plugin swap — none of these people have to change tools, only add
a file. §6.2 specifies the guide, and it ships in the same phase as the rejection messages
that link to it, not later.

The corollary for tone: `feed_not_rss2` and `feed_not_declared_on_canonical` are the most
common rejections we'll issue, and they're the site's actual pitch. They should read like an
invitation with a link, never like a validator complaining.

### Decisions taken

| Decision | Choice | Note |
|---|---|---|
| Feed formats | **RSS 2.0 only — settled, on principle** | Root must be `<rss version="2.0">` with a `<channel>`. The site is called I ♥ RSS, not I ♥ Feeds; accepting Atom to widen the funnel would make the name a lie. This is **not** a v1 shortcut to be relaxed later, and the cost below is accepted knowingly — which is exactly why we owe people the guide in §6.2. |
| Publishing | **Auto-publish + admin removal** | Passing validation lists you immediately; `/admin` can hide a site or ban a domain after the fact. |
| Feeds per site | **One** | First valid feed found in `<head>`, with a preference heuristic. |
| Revalidation failures | **3-strike grace** | Marked `failing` but kept in OPML; dropped from OPML after 3 consecutive failures; row retained so recovery auto-restores it. |

---

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 24 LTS | `node:sqlite` is available unflagged (verified on 24.18.0). |
| Package manager | pnpm 10 (via corepack) | As requested. |
| Server | Hono + `@hono/node-server` | As requested. |
| HTML rendering | `hono/html` tagged templates | Plain HTML strings, no JSX, no React. Auto-escapes interpolations. |
| Database | `node:sqlite` (`DatabaseSync`) | **Zero dependencies, no native compile.** Keeps the Docker image small and the build fast — no `better-sqlite3` build toolchain needed. Synchronous API is fine for our traffic. |
| XML parsing | `fast-xml-parser` | Pure JS, preserves attributes and namespace prefixes (needed for `xmlns:source` and `source:cloud`). |
| HTML parsing | `node-html-parser` | Pure JS, fast, enough for `<head><link>` and `<a href>` scanning. Cheerio is heavier than we need. |
| Domain counting | `tldts` | Registrable-domain extraction for §5 Step 7's per-domain listing cap **only**, always `{ allowPrivateDomains: true }`. Never for relatedness — see §5 Step 4. |
| HTTP client | `undici` | **Required for the SSRF guard, not optional.** Node's built-in `fetch` re-resolves DNS at connect time, so a resolve-then-fetch guard is defeated by DNS rebinding (§5 Step 1). `undici.Agent({ connect: { lookup } })` is the only clean way to validate and connect on the *same* resolution. `undici` is not reachable as a builtin — verified `ERR_MODULE_NOT_FOUND` / `ERR_UNKNOWN_BUILTIN_MODULE` — so it must be a dependency. |
| Markdown | `marked` | Blog posts (§6.4). Small, pure JS, no plugin system to configure. Content is ours, so no HTML sanitizer is needed — see §6.4. |
| Frontmatter | hand-rolled, ~15 lines | Only `title:` is needed, and optional at that. `gray-matter` drags in `js-yaml` to parse one flat key/value block. Documented limit: flat `key: value` only, no nesting or lists. Swap in `gray-matter` if post metadata ever grows. |
| CSS | One hand-written `public/style.css` | No build step, no framework. **Mobile-first** — see §6.3. |
| Tests | `node:test` + `node:assert` | Built in, zero dependencies. |
| Lint/format | ~~Biome (optional)~~ → **ESLint + Prettier** | ~~Single binary, replaces eslint+prettier.~~ **SUPERSEDED:** adopted ESLint (flat config) + Prettier instead, to match the rsscloud project's conventions so both repos are maintained the same way. Prettier owns formatting, ESLint owns correctness (no overlapping rules). |

**Total production dependencies: 7** (`hono`, `@hono/node-server`, `fast-xml-parser`,
`node-html-parser`, `marked`, `undici`, `tldts`). No build step for the server — plain ESM,
run the source directly.

**`tldts` is used for exactly one thing: counting listings per registrable domain (§5 Step 7's
anti-flood cap), always with `allowPrivateDomains: true`.** It is deliberately *not* used for
deciding whether two URLs are related — §5 Step 4 explains why PSL matching was both
unnecessary and actively dangerous for that question. Keeping the distinction sharp matters:
the same function, at its default flag, silently collapses every `*.github.io` into one
domain, which is fine for nothing here and catastrophic for a cap.

---

## 3. Repo layout

```
iheartrss/
├─ package.json
├─ pnpm-lock.yaml
├─ Dockerfile
├─ docker-compose.yml           # for dockge
├─ .dockerignore
├─ .gitignore                   # .env, data/, secrets/, *.local.* — the repo is a live
│                               #   clone on the server, so this one matters. IP_HMAC_KEY
│                               #   lives in .env, which is NOT in the backup set (§9)
├─ .env.example
├─ RUNBOOK.md                   # restore, rollback, "it's 2am and X is broken"
├─ PLAN.md
├─ README.md
├─ src/
│  ├─ server.js                 # entry: config, db init, scheduler start, listen
│  ├─ app.js                    # Hono app + route wiring (exported for tests)
│  ├─ config.js                 # env parsing + defaults, validated at boot
│  ├─ db/
│  │  ├─ index.js               # DatabaseSync open, pragmas, migration runner
│  │  ├─ migrations/
│  │  │  └─ 001_init.sql
│  │  └─ queries.js             # prepared statements, built by createDb(path) — NOT at
│  │                            #   module scope; see §11 for why this shape is load-bearing
│  ├─ verify/
│  │  ├─ index.js               # verifySite(): orchestrates the whole pipeline
│  │  ├─ fetch.js               # createFetcher({lookup, config}) → safeFetch.
│  │                            #   Injectable lookup so §11 can test DNS rebinding with a
│  │                            #   5-line stub instead of a real TTL-0 nameserver.
│  │  ├─ url.js                 # normalizeUrl, isLinkBack, sameOrigin, ipClassifier
│  │  ├─ canonical.js           # resolve <channel><link> → canonical URL + feed provenance
│  │  ├─ page.js                # parse HTML: find link-back + feed <link>s
│  │  └─ feed.js                # parse+validate RSS, detect source ns + rsscloud
│  ├─ blog/
│  │  ├─ index.js               # load + cache content/, mtime poll
│  │  ├─ parse.js               # filename → date/slug, frontmatter, markdown → html
│  │  └─ feed.js                # our own RSS 2.0, with the source: namespace
│  ├─ routes/
│  │  ├─ pages.js               # /, /sites, /badge, /about
│  │  ├─ blog.js                # /blog, /blog/:y/:m/:d/:slug?, /feed.xml
│  │  ├─ submit.js              # GET/POST /submit
│  │  ├─ opml.js                # /subscriptions.opml
│  │  └─ admin.js               # /admin/* (token auth)
│  ├─ views/
│  │  ├─ layout.js              # shared shell
│  │  └─ *.js                   # one function per page
│  ├─ jobs/
│  │  ├─ revalidate.js          # scheduler + revalidateBatch()
│  │  └─ backup.js              # nightly node:sqlite backup() + retention
│  └─ lib/
│     ├─ opml.js                # OPML builder + the shared xmlAttr() escaper
│     ├─ ratelimit.js           # token bucket; client-IP derivation from XFF
│     ├─ clientip.js            # rightmost-after-N-hops, IPv6 /64 bucketing
│     └─ log.js                 # structured JSON logging to stdout
├─ content/                     # blog posts, bind-mounted in Docker so you can
│  ├─ 2026-07-29.md             #   publish without rebuilding the image
│  └─ 2026-07-29-a-second-one.md
├─ public/
│  ├─ rss-2.0-template.xml      # copy-paste starter feed, linked from /guide
│  ├─ iheartrss.svg             # wordmark for LIGHT backgrounds (existing file, move here)
│  ├─ iheartrss-dark.svg        # wordmark for DARK backgrounds (created, see §6.1)
│  ├─ iheartrss-icon.svg        # heart-only square crop, for favicons (created, see §6.1)
│  ├─ style.css
│  ├─ favicon.ico               # 16+32 raster fallback, generated once from the icon
│  └─ apple-touch-icon.png      # 180×180, opaque white bg, generated once
└─ test/
   ├─ fixtures/                 # saved real-world HTML + RSS samples
   ├─ url.test.js               ├─ canonical.test.js   ├─ revalidate.test.js
   ├─ page.test.js              ├─ fetch.test.js       ├─ moderation.test.js
   ├─ feed.test.js              ├─ opml.test.js        ├─ blog.test.js
   ├─ verify.test.js            └─ routes.test.js
```

---

## 4. Database schema

`src/db/migrations/001_init.sql`. Migrations are numbered `.sql` files applied in order,
tracked in a `schema_migrations` table — enough structure to evolve without a migration
library.

```sql
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

-- Every submission attempt, for rate limiting, abuse triage, and "why did mine fail?"
CREATE TABLE submissions (
  id            INTEGER PRIMARY KEY,
  submitted_url TEXT NOT NULL,
  normalized_url TEXT,
  -- HMAC-SHA256(key, truncate(ip) + YYYY-MM-DD). Never the raw IP. Three deliberate choices:
  --   * HMAC under a secret key, not sha256 with a published salt. The whole IPv4 space
  --     is 2^32 — a plain salted digest is a GPU-minutes rainbow table, so the scheme
  --     rests entirely on the secret. REVISED: the key is one env var, `IP_HMAC_KEY`,
  --     not a mounted file. The file argument was that an env var sits in
  --     `docker inspect` and in dockge's UI — still TRUE, and the honest cost of the
  --     change. It bought less than it looked like: the .env holding it already sat in
  --     the stack directory beside ./data, so "file, not env var" moved the secret a few
  --     inches, while requiring an ssh session to create a file before the very first
  --     dockge deploy. One configuration path, at a small named cost. What actually
  --     protects the hashes is unchanged: the key is not in git, the IP is truncated
  --     BEFORE hashing, the date component rotates daily, and rows are purged at 90 days.
  --     Anyone who can run `docker inspect` on the box can already read ./data anyway.
  --   * Truncate first: /24 for IPv4, /64 for IPv6. That is all the precision abuse triage
  --     needs (and /64 is already the rate-limit bucket), and it makes the input space
  --     small enough that correlation across days is the only real risk — hence:
  --   * A daily-rotating date component, so hashes older than the abuse window can't be
  --     linked to today's.
  ip_hash       TEXT NOT NULL,
  result        TEXT NOT NULL,   -- 'added' | 'updated' | 'rejected' | 'error' | 'checked'
                                 -- 'checked' is a POST /check dry run. Folding those into the
                                 -- other values would make the abuse trail lie about what happened.
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

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

**Timestamps: one writer, one format.** Every time column is `TEXT` compared with `<`, which
is only correct if every writer uses an identical format. SQLite's `datetime('now')` yields
`2026-07-29 14:00:00` (space, no `Z`); JS `toISOString()` yields
`2026-07-29T14:00:00.000Z`. Mixing them makes `'2026-07-29 …' < '2026-07-29T…'` always true
and **silently breaks the revalidation selection query**. Rule: timestamps are always
written from JS via `toISOString()`, never from SQL.

**Binding values: `node:sqlite` rejects booleans and `undefined`.** Verified — both throw
`TypeError: Provided value cannot be bound to SQLite parameter`. §5 Step 6 produces
`has_source_ns`/`has_rsscloud` as booleans, and `description`/`rsscloud_style`/`last_error`
are `undefined` whenever a feed omits them, so the natural `stmt.run({…})` throws at exactly
the moment a submission *succeeds*. Coerce at the `db/queries.js` boundary
(`b => b ? 1 : 0`, `v => v ?? null`) and test an insert from a feed with no `<description>`
and no cloud element. (Benign related quirk: rows come back as `[Object: null prototype]`, so
`row.hasOwnProperty` is `undefined` — don't reach for it in views.)

**Retention.** `submissions` grows forever as written. A salted IP hash is still personal
data; purge rows older than 90 days on the revalidation tick, and say so in the privacy note
on `/about`. Hard-delete `dropped` rows after ~1 year so dead domains don't accumulate
indefinitely (see §8 — they also distort scheduling).

**Status semantics**

- `active` — passing, appears in the directory and the OPML.
- `failing` — last check failed, `failure_count` 1–2. **Still in the OPML** (grace period).
  Shown on `/sites` with a visible warning badge, not silently — a member needs to be able
  to discover they're in trouble before they're dropped.
- `blocked` — we are being refused (persistent `403`, bot-protection interstitial) **by a
  site that has already passed at least once**. Only reachable from `active`/`failing`,
  never at submission (§5 Step 4). **Kept in the OPML indefinitely** and surfaced on
  `/admin`. This is a distinct state because it
  is not the member's failure and often not something they can fix: Cloudflare Bot Fight
  Mode, AWS WAF and Vercel's bot filter all 403 a datacenter IP. Verified live —
  `medium.com/@dhh` returns 403 to a full Chrome UA from this network, never mind ours.
  Without this state, enabling bot protection silently costs a member their listing in 18
  days for doing nothing wrong.
- `dropped` — 3+ consecutive failures. Out of the OPML and `/sites`; row kept, still
  revalidated (at a slower cadence) so recovery flips it back to `active`.
- `removed` — **opted out**: the page loaded fine but the link-back is gone, confirmed
  **twice, at least 24h apart** (`optout_seen_at` records the first sighting). Out of
  everything. Retried at the slow 90-day cadence rather than never: a single 200-without-badge
  has too many innocent causes (theme change, platform migration, a Cloudflare JS
  interstitial, a parked-domain page during a billing lapse) to make permanent, and with no
  accounts and no email there is nothing to notify the member with. Four fetches a year is
  not harassment, and it's the only way recovery happens without the member noticing
  unprompted. Re-adding the link and resubmitting also reactivates immediately.
- `hidden` — removed by us via admin. Never revalidated, never listed, and **not clearable
  by resubmission** (§5 Step 7).

`blocked` needs an exit: after **90 consecutive days** blocked, demote to `dropped`.
Otherwise parked and expired domains sitting behind a Cloudflare 403 accumulate in every
subscriber's OPML permanently, since `/recheck` treats `blocked` as a no-op and only an
admin can clear it.

**Pragmas on open:** `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`,
`busy_timeout = 5000`.

---

## 5. Verification pipeline

`verifySite(submittedUrl)` returns a structured result — never throws for expected
failures. Every step has a machine-readable `reason` code so the UI can show a specific,
actionable message.

### Step 0 — Normalize and pre-screen

`normalizeUrl(input)`:
1. Default to `https://` if no scheme given.
2. Reject any scheme other than `http`/`https`.
3. Lowercase host, strip default ports, strip fragment.
4. Strip the named tracking params (`utm_*`, `fbclid`, `ref`) and **nothing else** — never
   drop a whole query string, because `?p=123` is a real page on query-string-permalink
   WordPress. **The canonical URL from Step 4 goes through these same rules *before* it is
   fetched**, so the page we verify is the page we store. Normalising at persistence time
   instead would leave `sites.url` (and the OPML `htmlUrl`) naming a page we never fetched,
   breaking §7's invariant and pointing §8's revalidation at the wrong URL.
5. Empty path → `/`. Otherwise leave the path alone (people may submit a subpage).
6. Reject if the URL matches `banned_hosts` **using §4's full predicate** — host or
   host-suffix **AND** path-prefix. Not a host-only lookup: §4 establishes the path scoping
   specifically so a ban on `mastodon.social/@spammer` doesn't take out the whole instance.

### Step 1 — Fetch the page (`safeFetch`)

Shared hardened fetcher used for **every** outbound request.

**SSRF guard — validate at connect time, not before it.** The obvious design (resolve with
`dns.promises.lookup`, check the addresses, then call `fetch`) is **broken**, and it is the
single most important thing to get right in this codebase. Node's `fetch` performs its own
independent DNS resolution; instrumenting `dns.lookup` shows it firing again *after* the
pre-check, once per connection attempt. An attacker with a TTL-0 record answers public for
our check and `127.0.0.1` for the connection. On `node:24-alpine` (musl, no nscd) there is
no OS-level cache to blunt the race, so it is close to 100% reliable. A naive
implementation passes a test named "rejects a DNS name that resolves to a private IP" while
remaining fully vulnerable.

The fix has **two halves, and the second is not optional**:

```js
// Half 1 — hostnames: one resolution, used for both the decision and the socket.
const agent = new undici.Agent({ connect: { lookup: guardedLookup } })

// Half 2 — IP literals: the lookup hook is NEVER CALLED for these.
assertHostAllowed(url)   // before every dispatch, and on every redirect hop
```

**Why half 2 exists.** `net.connect` skips the `lookup` hook entirely when the host is
already an IP literal, and undici passes `url.hostname` straight through. Measured:

```
hostname fetch:      200   lookup calls: 1
http://127.0.0.1/    200   lookup calls: 0     ← guard never ran
http://[::1]/        200   lookup calls: 0     ← guard never ran
```

So an agent-only design leaves `http://127.0.0.1:3000/`, `http://[::1]/`,
`http://169.254.169.254/latest/meta-data/` and `http://[::ffff:127.0.0.1]/` **completely
unguarded** — every row of the table below bypassed. This is strictly worse than the naive
resolve-then-fetch design for that input class, and it fails a case §11 explicitly lists.

`assertHostAllowed` runs `net.isIP()` on `url.hostname` and, if non-zero, applies the same
classifier directly. **Strip brackets first** — `net.isIP('[::1]')` returns `0` (verified),
so an unstripped check silently no-ops on exactly the IPv6 literals it exists to catch.
`guardedLookup` and `assertHostAllowed` must share one classifier function; two copies will
drift.

**`guardedLookup` must honour `options.all`.** Node's autoSelectFamily path calls it as
`lookup(hostname, { hints: 1024, all: true }, cb)`. Calling back in the single-address shape
under `all: true` throws `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` — i.e.
*every* fetch to a hostname fails, which reads as "undici is broken" for an hour. Return
`cb(null, [{ address, family }])` when `options.all` is true and `cb(null, address, family)`
when it isn't. Test both.

**On rejection, call back with a tagged `Error`** — not an empty array. `cb(null, [])` under
`all: true` produces `TypeError: Cannot destructure property 'address' of 'addresses[0]'`
(verified), an opaque crash instead of an `ssrf_blocked` reason code.

**Allow-list global unicast rather than deny-listing ranges**, and additionally deny our own
public addresses. The box runs dockge and a reverse proxy that very likely fronts other
vhosts, so `https://<our public IP>/` reaches every one of them. Resolving `SITE_URL` once at
boot isn't enough — a dual-stack box, a second public IP or a DNS change leaves the proxy
reachable — so re-resolve periodically and add the self-IPs as an extra explicit deny.

**Implement it as an allowlist.** The table below is the *rationale*, not the algorithm: a
deny-list will always trail IANA (it already misses `::/96` IPv4-compatible IPv6 and
`0100::/64`). Accept only global unicast and reject everything else. (Verified: `::7f00:1`
doesn't actually route to loopback, so those specific gaps are hygiene rather than a live
hole — which is exactly why a deny-list feels finished when it isn't.)

**The classifier parses addresses to bytes. It must never string-match.** IPv4-mapped IPv6
must be un-mapped before classification — but the two sources spell the *same address*
differently, and the obvious string test only handles the one that can't occur:

```
new URL('http://[::ffff:127.0.0.1]/').hostname   →  '[::ffff:7f00:1]'   ← what we actually see
dns.lookup(...)                                   →  '::ffff:127.0.0.1'  ← dotted, from DNS
```

WHATWG `URL` re-serializes to compressed hex, so a `startsWith('::ffff:') && includes('.')`
un-mapper returns `null` for every real URL input. `::ffff:7f00:1` then matches none of the
IPv6 rows below and is **allowed** — verified live: `http://[::ffff:7f00:1]:PORT/` returns
200 from loopback with **0 lookup calls**. That is a working SSRF that passes a test suite
containing the string `::ffff:127.0.0.1`.

Un-map by bytes: first 10 bytes zero, bytes 10–11 `0xff 0xff` → treat the last 4 as IPv4.
One shared **normalizer** feeding one shared classifier, used by both halves and by both
input sources. §11 tests the compressed form as the URL fixture and the dotted form as the
DNS-answer fixture.

The classifier rejects:

| | |
|---|---|
| loopback | `127.0.0.0/8`, `::1` |
| private | `10/8`, `172.16/12`, `192.168/16`, `fc00::/7` |
| link-local | `169.254/16` (incl. `169.254.169.254`), `fe80::/10` |
| CGNAT / benchmark | `100.64/10`, `198.18.0.0/15` |
| unspecified / broadcast | `0.0.0.0/8` (`0.0.0.1` routes to localhost on Linux), `::`, `255.255.255.255` |
| multicast / reserved | `224.0.0.0/4`, `240.0.0.0/4`, `192.0.0.0/24` |
| v4-embedding v6 | `64:ff9b::/96` (NAT64), `2002::/16` (6to4), `2001::/32` (Teredo) |

Decimal, octal and hex IP literals (`http://2130706433/`, `http://0x7f.0.0.1/`, `http://127.1/`,
`http://0/`) are normalised to dotted-quad by WHATWG `URL` — verified — so they need no
special *parsing*, **provided every check reads `url.hostname` and never the raw input
string.** They are still IP literals, so they are caught by half 2, not by the lookup hook.

Other `safeFetch` properties:

- Manual redirect following, max 5 hops. Each hop re-runs **`assertHostAllowed` and the
  scheme check** (only `http`/`https` — a `Location: file:///etc/passwd` is a hard reject)
  and goes through the same guarded agent. A redirect to an IP literal is the easiest way to
  miss half 2.
- Each hop re-checks `banned_hosts` (§4) using the **host + path-prefix** rule, so a ban
  can't be dodged by redirecting into it and a path-scoped ban doesn't take out a whole
  multi-tenant host.
- **One `AbortSignal.timeout` per `safeFetch` call, created once and shared across hops** —
  create it per hop and "10s total" silently becomes 50s.
- **Size cap is an error, never a truncation.** Streaming byte counter; on exceeding
  `MAX_RESPONSE_BYTES` we `cancel()` the reader and return a distinct
  `page_too_large` / `feed_too_large` reason. This matters more than it looks: a truncated
  HTML body parses *fine* and simply lacks the link-back, which §8 would read as a
  deliberate opt-out and permanently delist a member whose homepage merely got big. A
  truncated feed likewise parses into a plausible object (see Step 3). Cap raised to
  **5 MB** since full-content WordPress and podcast archive feeds legitimately exceed 2 MB.
  Verified: undici decompresses transparently, so the counter measures *decompressed* bytes
  — gzip-bomb protection comes free.
- `User-Agent: iheartrss.com validator (+https://iheartrss.com/about)`, plus `Accept` and
  `Accept-Language` headers. Bare-UA requests with no `Accept` are the easiest bot
  signature to fingerprint, and being blocked is a top-3 real-world failure mode (§8).
- Charset: `Content-Type` first; for **HTML** fall back to a `<meta charset>` sniff then
  UTF-8; for **XML** fall back to the declaration's `encoding` attribute
  (`<?xml version="1.0" encoding="ISO-8859-1"?>`) then UTF-8. Older WordPress and
  hand-rolled feeds really are Latin-1 and say so only in the XML declaration — decoding
  those as UTF-8 mangles every title we publish. Verified: `node:24-alpine` ships full ICU
  (ICU 78.3), so `windows-1252`, `iso-8859-1`, `gbk`, `shift_jis` all decode without the
  `full-icu` package.

**Scheme fallback.** Step 0 defaults a scheme-less submission to `https://`. On a
connection or TLS failure — *not* on a 4xx/5xx — retry once over `http://` and store
whichever worked. This is not hypothetical: `https://scripting.com/` currently fails with
`Connection reset by peer` while `http://scripting.com/` returns 200. Without the fallback,
the single most likely high-profile member of an RSS webring cannot join by typing his own
domain name.

The **final URL after redirects** is what Step 2 parses and what Step 4 compares origins
against. It is *not* `sites.url` — that comes from the feed's `<channel><link>` in Step 4.

### Step 2 — Find the feed → `reason: 'no_feed_link'`

Scan `<head>` for `<link>` elements, resolving `href` against `<base href>` if present
(not just the document URL). Collect **two** buckets, case-insensitively and tolerating a
`; charset=` suffix on the type:

- **RSS candidates** — `type="application/rss+xml"`.
- **Other-format candidates** — `type="application/atom+xml"` or `application/feed+json`.

`rel` must contain `alternate` or be absent. (The autodiscovery spec at
[rssboard.org](https://www.rssboard.org/rss-autodiscovery) requires `rel="alternate"`
exactly; accepting a missing `rel` is a deliberate leniency, recorded here as such.)

**Why collect Atom candidates we're going to refuse:** without this, an Atom-only site
produces zero candidates and gets `no_feed_link` — "we couldn't find an RSS feed link" —
while the author stares at a perfectly good `<link rel="alternate"
type="application/atom+xml">` in their own source and concludes we're broken. With it, we
return `feed_not_rss2` naming the exact feed we found, explaining why we can't take it, and
linking to `/guide`. The carefully-worded Atom rejection in Step 3 is otherwise
near-unreachable, since it only fires on a feed *mislabelled* as `rss+xml`.

Two lines of code, and it turns the most common rejection on the site from "this site is
broken" into the moment we make our actual argument. Given RSS-2.0-only is a settled
principle (§1), this path carries real weight — it's the difference between a closed door and
an invitation.

**A submitted feed URL short-circuits this step.** On a site about RSS, a large share of
people will paste `example.com/feed.xml` into the box. If the fetched resource parses as a
feed rather than HTML, skip discovery and treat it as `feed_url` directly. Otherwise they
get "we couldn't find an RSS feed on your page" about a page that *is* an RSS feed.

If several RSS candidates match, score them (an ordered scoring function, **not** sequential
filters — "first hit wins" over three rules is ambiguous about whether a rule that matches
nothing eliminates everything):

| Signal | Score |
|---|---|
| Path matches `/(feed|rss|index|atom)(\.xml)?/?$` **after normalising the trailing slash** | +3 |
| `title` looks like a comment feed (`/comment/i`) | −5 |
| `title` looks like a category/tag/author feed | −2 |
| Shorter path | tiebreak |

The trailing-slash normalisation is load-bearing: WordPress's canonical feed URL is
`/feed/` **with** the slash, so a naive `endsWith('/feed')` misses the single most common
platform on the web and only lands correctly via the shortest-path tiebreak, by luck.

Discovered feeds and the winning score are logged so the heuristic can be revisited against
real data. **The chosen `xmlUrl` and `htmlUrl` are always shown in the success panel** with
a "wrong feed?" link — sites like `manton.org` (`/feed.xml` + `/podcast.xml`) and
`buttondown.com/blog` (four `rss+xml` links) will sometimes be scored wrong, and without a
correction path the member's OPML entry is permanently wrong with no account to fix it
from. The submit form takes an optional explicit feed URL for that case.

### Step 3 — Fetch and validate the feed → `reason: 'feed_fetch_failed' | 'feed_invalid' | 'feed_not_rss2'`

- `safeFetch` again (same guards).

**Validate before parsing.** `XMLParser.parse()` is deliberately lenient and **does not
throw on malformed XML** — verified: a truncated `<rss><channel><title>a</title>` returns a
clean-looking object, a mismatched close tag parses happily, and `'not xml at all'` returns
`{}`. So the `feed_invalid` reason code would never fire, and we would list sites off
half-read documents. Run `XMLValidator.validate(text)` first and map a truthy `.err` to
`feed_invalid`. (It is *not* a defence against entity attacks — it returns `true` for those;
see below.)

**Strip the BOM and leading whitespace before validating.** A blank line before `<?xml` — a
classic WordPress output-buffering artifact — fails validation with *"XML declaration allowed
only at the start of the document"*, so an otherwise-fine feed is rejected as `feed_invalid`.
Verified; a UTF-8 BOM alone is tolerated, leading whitespace is not.

**Parser config** — every one of these is load-bearing:

```js
{ ignoreAttributes: false, attributeNamePrefix: '@_',
  removeNSPrefix: false,      // need `source:` prefixes and @_xmlns:source intact
  parseTagValue: false,       // see below
  processEntities: true,      // see below — and htmlEntities with it
  htmlEntities: true }
```

- **`parseTagValue: false`.** By default fast-xml-parser type-coerces text nodes:
  `<title>2026</title>` becomes the **number** `2026`, `<title>true</title>` becomes a
  boolean. A blog legitimately called "2024" then crashes `ch.title.trim()` with
  `TypeError: not a function`, and a boolean flows into a `TEXT NOT NULL` column. Everything
  we read from a feed is a string; say so.
- **`processEntities: true, htmlEntities: true`, with the DOCTYPE scan as the real defence.**
  An earlier draft set `processEntities: false` to stop billion-laughs. That was wrong twice
  over, measured against fast-xml-parser 4.5.3 and 5.10.1:

  ```
  processEntities:true                 'Rock &amp; Roll &#8217;n Caf&#233;' → "Rock & Roll &#8217;n Caf&#233;"
  processEntities:false                                                    → "Rock &amp; Roll &#8217;n Caf&#233;"
  processEntities:true + htmlEntities:true                                 → "Rock & Roll ’n Café"
  ```

  With `false`, every title containing `&` stores as literal `&amp;` and §7's `xmlAttr()`
  re-escapes it to `&amp;amp;`, so subscribers read `Rock &amp; Roll`. And *neither* setting
  alone decodes numeric character references — without `htmlEntities: true`, smart quotes
  and accents render as `Caf&#233;` in the OPML for everyone. Ampersands, curly apostrophes
  and accented characters are ubiquitous in feed titles, so this would have quietly mangled
  a large share of the directory.

  The security rationale was also wrong for this parser: fast-xml-parser does **not**
  recursively expand DTD entities — a classic billion-laughs leaves `&d;` untouched at both
  settings. The real vector is *single-level* amplification: `<!ENTITY a "100KB">` × 20,000
  references is a **160 KB** document that blows V8's string limit in ~4 ms with
  `RangeError: Invalid string length`. Note `XMLValidator.validate()` returns **`true`** on
  it, so validate-first does not catch this.

  Therefore the defence is **two things together**, and neither alone is sufficient:

  1. **Pin `fast-xml-parser >= 4.5.4`** in the lockfile. The entity size cap (10,000 chars)
     and expansion-count limit (1,000) land in 4.5.4. Measured on **4.5.3** — which satisfies
     a `>= 4.5` pin — a 112 KB body produced a **500,000,000-character string** with no
     throw; under §9's `mem_limit: 512m` that is a remote, unauthenticated OOM-kill via
     `/submit`. 4.5.4 through 4.5.7 all reject it safely. Re-verify before moving to 5.x.

     **But 4.5.4's default `maxTotalExpansions: 1000` rejects honest feeds** — found during
     implementation, not review. scripting.com's real feed contains **2,193 entity
     references** (700 `&lt;`, 700 `&gt;`, 554 `&quot;`, 234 `&#10;`, 5 `&amp;`) across 50
     items, so `parse()` threw `Entity expansion limit exceeded: 1020 > 1000` and the
     reference feed for this entire project came back `feed_invalid`. Every full-content
     WordPress feed hits the same wall. Use the object form:
     `processEntities: { maxTotalExpansions: 2_000_000, maxEntitySize: 10000,
     maxEntityCount: 1000, maxExpandedLength: 100000 }` — raising only the total, keeping the
     three per-entity bounds at their 4.5.4 defaults. Both halves of the defence survive:
     those three bound *DTD-declared* entities, and the DOCTYPE scan below rejects any
     document that declares one before `parse()` ever runs, so what remains is 1:1 character
     references whose count is linear in body size and already capped by
     `MAX_RESPONSE_BYTES`. Verified defence-in-depth: with the DOCTYPE scan deliberately
     bypassed, a 20,000 × 100 KB bomb still throws on `maxEntitySize` with a 3.3 MB heap
     delta.
  2. **Reject `<!DOCTYPE` / `<!ENTITY` anywhere outside CDATA — not just the prolog.**
     A prolog-only scan is bypassed by placement: a DOCTYPE *after* the root element still
     declares and expands entities, and `XMLValidator.validate()` returns `true` on it —

     ```
     '<rss version="2.0"><!DOCTYPE rss [<!ENTITY a "PWNED">]><channel><title>&a;</title></channel></rss>'
       → validate = true,  parsed title = "PWNED"
     ```

     Match case-insensitively, and exclude CDATA so a post *about* HTML doesn't false-positive.
     §11's test must use the **post-root** form; a prolog-only fixture passes for the wrong
     reason and never exercises this.

  Wrap `parse()` in try/catch for the `RangeError` regardless.
- Read the parsed tree with `Object.hasOwn` rather than dotted access — `__proto__` and
  `constructor` are legal XML element names.

**Singular nodes are objects, not arrays.** Verified: a one-item feed gives
`item` as an object; scripting.com's 50-item feed gives an array. "Exactly one `channel`"
and "at least one `item`" both need an `asArray()` helper, or a one-item feed produces
`.length of undefined` in production.

**Format check (`validateFeedFormat`)** — the one RSS-2.0-only gate:
  - Root element must be `rss`. A root of `feed` returns `feed_not_rss2`. The message is the
    site's pitch, not a validator complaint — *"That's an Atom feed. This is I ♥ RSS, so we
    only take RSS 2.0 — here's how to add one to your site, it takes about five minutes"* —
    linking to `/guide` (§6.2) and naming the exact feed URL we found.
  - **Root `@_version`: reject `0.9*` and `1.0`; accept `2.0*` or missing.** The spec makes
    `version` mandatory and requires `2.0`, and without any check an `<rss version="0.91">`
    feed sails through and is recorded as an RSS 2.0 member — incoherent next to rejecting
    Atom by name. But *requiring* exactly `2.0` is stricter than the wild: `version="2.00"`
    and a missing attribute both occur, and neither is Atom or 0.9x, which is what this gate
    exists to exclude. Log anything unrecognised rather than rejecting it.
  - Must contain exactly one `channel`.
  - `channel` must have a non-empty `title`.
  - `channel` must have a `link` **or** at least one `item`. (Not requiring items — a brand
    new blog with an empty feed is still a real RSS lover.)
  - *Recorded leniency:* the spec's required channel elements are **title, link and
    description**. We don't require `description`. Deliberate, so a minimal hand-rolled
    feed isn't turned away.

### Step 4 — Resolve the canonical URL from `<channel><link>`

**This is the URL the OPML's `htmlUrl` will point at, so it's the URL that must carry the
link-back.** Someone can submit `example.com/blog/` while their feed's `<channel><link>` is
`example.com/` — the OPML sends readers to the root, so the root is where the badge needs
to be.

1. Read `<channel><link>`. If it's missing or unparseable, fall back to the submitted URL
   as canonical (a feed with no channel link is unusual but not disqualifying) — **unless
   the submitted URL was itself a feed** (the Step 2 short-circuit), in which case reject
   with `no_channel_link`: *"we can't tell which page this feed belongs to — submit your
   homepage instead."* Without that carve-out, `sites.url` and the OPML `htmlUrl` become the
   feed URL, sending subscribers to raw XML, and Step 5 runs an HTML anchor parser over an
   RSS document where a CDATA-wrapped link in a post body would pass and an entity-escaped
   one wouldn't. A resource that parsed as a feed must never become the canonical *page*.
2. Normalize it with the same `normalizeUrl` rules as §Step 0.
3. `safeFetch` it — unless it normalizes equal to the submitted URL, in which case **reuse
   the already-fetched HTML** rather than making a second request.
4. The **final post-redirect URL** becomes `sites.url`. Following redirects here means
   `http://example.com` declared in the feed and `https://example.com/` in the browser end
   up as one row, not two.

→ `reason: 'canonical_fetch_failed'` if it won't load (404, timeout, TLS failure). The
message names the exact URL we tried, since a broken `<channel><link>` is a real and
fixable feed bug.

**A persistent 403 at submission returns `blocked_by_site` — it does not create a row.**
Bot-protection 403s are outside the member's control (verified: `medium.com/@dhh` 403s a
full Chrome UA from this network; Vercel, AWS WAF and Substack custom domains behave
similarly), so the *message* matters: tell them plainly that we couldn't reach their site,
that it's usually bot protection, give the exact User-Agent and source IP to allowlist, and
offer the email address on `/about` as the human path.

**Why not a `pending_review` row.** An earlier draft created the row as `blocked` pending
admin approval. That's wrong on two counts. It contradicts §7, which keeps `blocked` sites
*in* the OPML — so read literally it would let anyone inject an arbitrary URL into every
subscriber's reader with no link-back and no consent, destroying §7's invariant. And it
can't be stored anyway: with no reachable page there is no feed, no title and no
verification, against `NOT NULL` columns. Making three columns nullable and building an
approval queue is real machinery for a rare case that an email handles. `blocked` stays what
§4 and §8 define it as: **a state a site can only reach after passing at least once.**

**The feed we publish must come from the page we publish.**

If the canonical URL differs from the submitted URL, **re-run feed discovery (Step 2) on the
canonical page and use *its* feed**, validating it as in Step 3. The feed recorded against
`example.com/` is the one `example.com/` itself declares — never one asserted by a third
party's page.

**The rule is absolute, with no fallback:**

| Canonical page… | Action |
|---|---|
| declares an RSS 2.0 feed that validates **and whose own `<channel><link>` resolves to the canonical page's host** | that is `feed_url` (no extra fetch if it's the URL we already validated) |
| declares a feed that validates but whose `<channel><link>` points at a **different host** | `feed_not_owned_by_canonical` — see below |
| declares a feed that validates but has **no `<channel><link>` at all** | accept **only if the feed URL's host equals the canonical host** (self-hosted); otherwise `feed_not_owned_by_canonical` |
| declares an RSS feed we can't fetch or that fails Step 3 | `canonical_feed_unavailable` — **transient**, retry later. Never substitute a different feed |
| declares no RSS feed (none at all, or Atom-only) | `feed_not_declared_on_canonical`, with an actionable message: add `<link rel="alternate" type="application/rss+xml">` to the page your feed's `<channel><link>` points at, or fix `<channel><link>` |

**Why there is no fallback.** Two earlier drafts had one — "if the canonical page declares no
usable feed, use the submitted page's feed provided the origins match" — and it was broken
both times, because *every* origin-based condition is satisfied by the same single
capability: write one file to the victim's origin. Concretely: victim runs Jekyll, homepage
advertises Atom only, badge present. Attacker uploads one valid RSS file to any writable
path on the victim's origin — a user-content upload, an S3 bucket mapped under a path, a
wiki page, a CMS media library, `tilde.club/~user/` — whose `<channel><link>` is the
victim's homepage, and submits it directly. Canonical origin == submitted origin ✓, feed
origin == canonical origin ✓, badge present on the victim's real homepage ✓. Since §5 Step 7
lets `feed_url` update freely, the victim's existing listing is repointed at attacker
content while `htmlUrl` still shows the victim's homepage. One request.

Tightening the origin conditions can't fix that, because the conditions and the attack use
the same primitive. The only rule that holds is the simple one: **the page we publish must
itself advertise the feed we publish.** A canonical page that declares no RSS feed is making
a statement about its own feeds, and accepting a third party's contradiction of it is
exactly the hijack.

#### Provenance has to be mutual, not one-directional

"The canonical page declares this feed" is only half the property. A `<link rel="alternate">`
can name **any** URL on any host, so the other half — "this feed belongs to that page" —
must be checked too, or the rule inverts into a cleaner attack than the one it replaced.
It needs no victim-origin write at all, only attacker-controlled hosting:

```
attacker.example/a.html      badge + <link rel=alternate href="/a.xml">
attacker.example/a.xml       valid RSS, <channel><link>https://attacker.example/steal.html</link>
attacker.example/steal.html  badge + <link rel=alternate href="https://victim.com/feed.xml">
```

Submit `/a.html`. Canonical resolves to `/steal.html`; re-discovery there yields the
**victim's real feed**, which fetches and validates; the badge is present because the
attacker put it there. `UNIQUE(feed_url)` then collides with the victim's row and
row-follows-feed moves it, producing
`xmlUrl="https://victim.com/feed.xml" htmlUrl="https://attacker.example/steal.html"` in every
subscriber's reader — and at the next revalidation the attacker swaps the declared feed for
their own and owns the row outright. The victim is silently delisted by one unauthenticated
request.

**The channel-link-less case is the hole in this rule, so it gets its own row above.** Step 3
accepts a feed with `link` *or* items, and Step 4.1 treats a missing channel link as "unusual
but not disqualifying" — so a feed with no `<channel><link>` has nothing for the mutual check
to check, making the second direction vacuous. Concretely: victim's feed legitimately omits
`<channel><link>`; attacker publishes `attacker.example/a.html` with the badge and a
`<link rel="alternate">` naming **the victim's feed**, and submits it. No channel link →
canonical falls back to the submitted URL → canonical == submitted → no re-discovery → no
mutual check → badge present. Row: attacker's `htmlUrl` paired with the victim's `xmlUrl` in
every subscriber's reader, and the victim is later refused their own feed with
`ambiguous_identity`. Requiring the feed to be *self-hosted* on the canonical host when it
makes no claim of its own closes it; honest hand-rolled feeds are same-host by construction.

**The check:** the feed discovered on canonical page `C` must have a `<channel><link>` that
resolves to `C`'s host. It's a *check*, not a re-derivation, so "canonical resolution runs
once, no loop" still holds, and in the common case where the canonical feed is the feed we
already validated it is satisfied by construction. Honest cases pass — Substack custom
domains, multi-author WordPress, and even FeedBurner/Feedpress-hosted feeds, because the
*channel link* is the blog even when the feed is served off-origin. The attack fails: the
victim's feed says `victim.com`, and `C` is `attacker.example`.

This also removes a self-inflicted wound. A fallback-admitted row has, by construction, a
`feed_url` that `sites.url` doesn't declare — so §8's revalidation (which re-runs discovery
against `sites.url`) would find no RSS feed, classify it Transient, and **drop the member at
18 days having changed nothing**, silently and unrepairably. With provenance absolute, the
feed is always discoverable from `sites.url`, revalidation is consistent by construction, and
no `feed_source_url` column is needed.

**Cost, stated plainly:** a site whose homepage lacks autodiscovery while its blog index has
it now gets rejected. That's a real if uncommon shape, and the message tells them exactly
which tag to add to which page. Under RSS-2.0-only it also catches the Jekyll shape
(Atom-only homepage) — which is an argument for §13 item 8, not for reintroducing a fallback.

All three rejection reasons here — `canonical_feed_unavailable`,
`feed_not_declared_on_canonical`, `feed_not_owned_by_canonical` — name both URLs and avoid
accusatory language. The overwhelmingly common cause is a misconfigured `<channel><link>` or
a missing autodiscovery tag, not an attack, and the message should say which tag to add to
which page.

Worst case **in this step** is 4 outbound fetches (submitted page, its feed, canonical page,
its feed); 2 in the common case where canonical == submitted. Step 7's incumbent re-check can
add 2 more — see the fetch budget below. Canonical resolution runs **once** — we
do not re-derive a canonical from the second feed, so there's no loop.

#### Why this replaced a domain-comparison guard

The previous design compared the canonical URL's *registrable domain* against the submitted
and feed URLs using `tldts`. Review found three independent holes, and the third is fatal to
the whole approach:

1. **The feed URL is not a trust anchor.** It's read out of the attacker's own HTML. Point
   it at any writable path on the victim's domain — a user-content upload, an S3 bucket on
   their domain, an open redirect — and the domains match honestly.
2. **Multi-tenant hosts aren't on the PSL.** `substack.com`, `medium.com`, `wordpress.com`,
   `tumblr.com`, `micro.blog`, `neocities.org` all reduce to one registrable domain, so
   `evil.substack.com` and `victim.substack.com` were "related". On `mastodon.social` every
   account shares a host and differs only by path.
3. **`tldts` defaults defeated the one example the section was built on.** With
   `allowPrivateDomains: false` (the default), `getDomain()` returns `github.io` for **both**
   `evil.github.io` and `victim.github.io` — verified. The hijack the paragraph claimed to
   prevent succeeded on github.io, pages.dev, netlify.app and blogspot.com, i.e. a large
   share of exactly this site's audience. A test asserting the two are strangers would have
   failed on day one.

The feed-provenance rule closes all three without any domain comparison. (`tldts` still
appears in §2, but *only* for counting listings per domain in Step 7 — never for deciding
whether two URLs are related. Don't drop the dependency on the strength of this paragraph.)
Walk the same attack: I submit `attacker.com` with a feed whose `<channel><link>`
is `popular-blog.com`. We fetch `popular-blog.com`, discover **its** feed, and record that.
The row is the victim's real site paired with the victim's real feed — no hijack, just a
redundant re-verification of a site that already consented. Nothing an attacker controls
reaches the OPML.

It also fixes two things the old rule got wrong in the *legitimate* direction:

- **Substack and custom domains now work.** `astralcodexten.substack.com`'s feed declares
  `<link>https://www.astralcodexten.com</link>` — a different registrable domain from both
  the submitted URL and the feed URL, so the old guard rejected it outright. Now we fetch
  the custom domain and take the feed it declares. Same for Blogger on a custom domain,
  Ghost(Pro), Buttondown, and any site mid-domain-move.
- **Multi-author sites stop clobbering each other.** Alice submits her author feed on a
  shared WordPress; canonical is the site root; the root declares the *main* feed, so that's
  what's recorded. Bob doing the same produces the identical row instead of silently
  replacing Alice's `feed_url`.

### Step 5 — Find the link-back, on the canonical page → `reason: 'no_linkback'`

Against the canonical page's HTML (from step 4): collect every `<a href>`, resolve each
against the page's base URL (honouring `<base href>`), and accept if any resolves to a host
in `LINKBACK_HOSTS` (§9; `iheartrss.com,www.iheartrss.com` by default — configurable so
local dev can point elsewhere). Scheme, path, and trailing slash are all ignored —
a text link and an image link are structurally identical here, so both forms work
automatically.

The rejection message must name the specific page, because "add a link to your homepage"
is unhelpful when the page we checked isn't the one they submitted:

> We found your feed, but no link back to iheartrss.com on **https://example.com/** — the
> page your feed's `<channel><link>` points to. That's the URL we'd list you under, so
> that's where the link needs to live. (You submitted https://example.com/blog/.)

*Rejected alternative:* substring-searching the raw HTML for "iheartrss.com". That matches
the URL sitting in a `<code>` block or a comment, which lets people list without actually
linking.

*Rejected alternative:* accepting a link-back on either the submitted page or the canonical
page. It sounds friendlier, but it breaks the consent property — being listed under a URL
would no longer require that page's owner to have opted in.

### Step 6 — Optional feature detection (booleans, never fail the submission)

**`has_source_ns`** — true if either:
- the root `<rss>` carries **any** `xmlns:*` attribute whose value's host is
  `source.scripting.com` (accept `http`/`https`, with or without trailing slash) — scan all
  `@_xmlns:*` attributes, not just `@_xmlns:source`. With `removeNSPrefix: false` the parser
  does no namespace resolution, so prefixes are literal strings; a publisher who declares
  `xmlns:src="…"` and writes `<src:cloud>` is spec-identical and must not score false. Use
  whichever prefix is actually bound.
- **or** any element uses that bound prefix.

The element scan must be **bounded**: an explicit-stack iterative walk with a node budget
(~50k) rather than recursion. A 5 MB body affords ~200k nesting levels, and a recursive walk
over `<a><a><a>…` blows the stack and kills the process. Cheaper still: regex the raw text
for the bound prefix before parsing, and only walk if it's present.

Verified live against `scripting.com/rss.xml`, which declares
`xmlns:source="https://source.scripting.com/"` on the root `<rss>` element.

**`has_rsscloud`** — true if either form is present, with `rsscloud_style` recording which:
- `element` — `<channel><cloud domain=… port=… path=… registerProcedure=… protocol=…/>`.
  The spec defines **five required attributes**; store all five rather than the two a
  boolean needs, so a future rssCloud registrar (§10) doesn't have to re-crawl every feed.
  Real example from scripting.com:
  `<cloud domain="rpc.rsscloud.io" port="5337" path="/pleaseNotify" registerProcedure="" protocol="http-post"/>`
- `source` — `<channel><source:cloud>https://host/pleaseNotify</source:cloud>`, no
  attributes, value is the full URL. Per the spec: *"The `<source:cloud>` element has no
  attributes and its value is the URL of the cloud server."*
- `both` — both present. The spec recommends publishers emit both during the transition,
  but don't build UI copy around `both` being typical: scripting.com itself carries `<cloud>`
  and **zero** `source:cloud` elements today (its full `source:` set is `account`,
  `blogroll`, `localTime`, `markdown`, `outline`, `self`). `element` will dominate; `both` is
  a rarity worth celebrating, which is different UI treatment. The `source`/`both` test
  fixtures have to be hand-written, which is a stated exception to §11's real-world-fixtures
  rule.

### Step 7 — Persist

Upsert on `url` (the canonical URL). New row → `added`; existing row → refresh metadata,
reset `failure_count` to 0, bump `last_verified_at`, return `updated`. Re-submitting is
therefore a safe, idempotent "re-check me now" action.

**`hidden` is terminal.** The upsert must never transition `hidden → active`; only
`POST /admin/sites/:id/unhide` clears it. As originally written — "existing row → … set
`status = 'active'`", unconditionally — the admin's only lightweight moderation lever was
undone by the moderated party pressing submit again, one request, no auth, no rate-limit
obstacle. A hidden row still refreshes its metadata (so we keep observing it) but stays
hidden, and the submitter gets a neutral "already submitted" response rather than an oracle
telling them they've been moderated.

`ban` is not an adequate substitute for a working `hide`, because `banned_hosts` is a host
match and multi-tenant hosts are common: banning one bad `mastodon.social/@user` would ban
every Mastodon account on that instance, and the same goes for `*.wordpress.com`,
`*.tumblr.com`, `medium.com/@x`. See §4 for the host+path-prefix ban form.

**`feed_url` updates freely; there is no `feed_conflict` guard.** An earlier draft blocked
any change to an existing row's `feed_url` as a hijack backstop. Drop it: the Step 4
provenance rule already means the feed comes from the canonical page, so two honest
submitters converge on the same value and an attacker can't supply one at all. The guard
bought nothing and cost real users everything — a member migrating WordPress → Hugo changes
their feed URL, resubmits to fix it, and is refused forever with no admin repair route and
nobody to email, while the OPML keeps publishing a dead `xmlUrl` to every subscriber. It
also directly contradicted this step's own "safe, idempotent re-check me now" promise and
Step 2's "wrong feed?" correction path.

Changes to `feed_url` on an existing row are logged and bump `directory_version`.

**Identity is `feed_url`, not just `url`.** `UNIQUE(feed_url)` alongside `UNIQUE(url)`, and a
collision on either returns "already listed" idempotently rather than erroring.

Keying on the canonical URL alone does **not** give free deduplication, as an earlier draft
claimed — because the canonical URL comes from the *submitter's* feed and is therefore
attacker-chosen. Two ways that bites:

- **Victim flooding.** Any WordPress/Ghost/Hugo site has a site-wide footer badge and
  site-wide `<head>` autodiscovery. Submit N feeds whose `<channel><link>` values are
  `victim.com/post/1`, `/post/2`, … Every canonical page is real HTML, declares the victim's
  own feed, and carries the badge — so all N pass, and the OPML gains N outlines with the
  same `xmlUrl`. Every subscriber gets N copies of the victim.
- **Self-listing.** iheartrss.com satisfies its own validator on *every* page by design
  (header links to `/`, autodiscovery in every `<head>`), and `/status?url=…` yields
  unbounded distinct URLs. `normalizeUrl` strips only `utm_*`/`fbclid`/`ref`, so query
  strings survive into `sites.url`.

`UNIQUE(feed_url)` collapses both, and cleanly subsumes the multi-author-WordPress
convergence this step already wants. Additionally, reject canonical URLs whose host is in
`LINKBACK_HOSTS` — member #1 is inserted directly by the phase-6 seed, not through the form.
Between those two rules the self-listing vector is closed without needing to strip query
strings, which Step 0.4 deliberately does not do.

The tradeoff, stated plainly: **one feed = one listing.** Two genuinely different pages
sharing a single feed can't both be listed. That's the right call for a directory whose
output is a subscription list — the OPML's unit *is* the feed.

**On a `feed_url` collision where the canonical URL differs, the row follows the feed — but
only after re-verifying the incumbent.** Re-check the existing `sites.url` first. **Only a
conclusive `2xx` fetch of the incumbent that no longer declares the feed permits the move.**
Any other outcome — timeout, 4xx, 5xx, a bot-protection 403, budget exhausted — rejects with
`ambiguous_identity`, logs, and surfaces on `/admin`.

Spelling out the failure semantics matters because "unreachable" is a *common* state here,
not an edge case: the whole `blocked` status exists because bot protection 403s us routinely.
An implementer who writes the move condition as `!declaresFeed(incumbent)` hands the row over
whenever the victim's host is momentarily 403-ing, rate-limiting or mid-deploy — a window an
attacker can wait for, and on some hosts induce by burning the victim's rate limit. This
re-check is the last gate behind the shared-host variant (an attacker page on the victim's
*own* origin passes the host-level mutual check by construction), so it has to fail closed.

The re-check is what stops a row-takeover: without it, "last party to declare a feed owns
its row" is the whole game, and the mutual-declaration rule in Step 4 is the only thing
standing between an attacker and a victim's listing. With it, both must be true — the
attacker's page must own the feed *and* the victim's page must have stopped declaring it.
The legitimate case the rule exists for still works, because a member who moved
`<channel><link>` from `/` to `/blog/` genuinely has an old page that no longer points at the
feed. If identity is the feed, that member must not be stranded with an `htmlUrl` pointing at
a 404 forever — the mirror image of the `feed_conflict` mistake above.

If `url` matches one row and `feed_url` matches a *different* row, reject with
`ambiguous_identity` too. That's either a genuine mess or an attack, and it needs eyes.

**Neither constraint stops bulk flooding, so two cheap backstops:** a cap on active listings
per registrable domain (5, admin-overridable) and a global daily new-listing cap.

The per-domain cap needs PSL data, so it uses **`tldts` with `allowPrivateDomains: true`, and
that flag is not optional** — at the default, `getDomain('anyuser.github.io')` is `github.io`
and a cap of 5 would limit *all of GitHub Pages, netlify.app, pages.dev and blogspot.com* to
five listings each, globally. PSL matching was the wrong tool for *relatedness* (§5 Step 4);
it is the right tool for *counting*.

**But the flag is not sufficient, so the cap reads `domain_limits` (§4) first.** Measured:
with `allowPrivateDomains: true`, `alice.github.io`, `alice.blogspot.com` and
`alice.bearblog.dev` separate correctly — while `alice.substack.com` → `substack.com`,
`alice.wordpress.com` → `wordpress.com`, `alice.micro.blog` → `micro.blog`,
`alice.tumblr.com` → `tumblr.com`, `alice.neocities.org` → `neocities.org` do **not**. The
PSL private section simply doesn't cover them. Path-based hosts (`mastodon.social`,
`medium.com`, `tilde.club`) can't be separated by any domain function. Seed `domain_limits`
with those hosts at unlimited or the cap becomes exactly the "you're the 6th, go away"
outage it was meant to prevent.

The cap query has no supporting index: either store a `domain` column on `sites` or accept a
`host = ? OR substr(host, -length(?)) = ?` scan, which is fine at this scale. (Not `LIKE` —
§4 rules it out for host matching because `_` and `%` are wildcards.)

With
wildcard DNS, `a1.attacker.example` … `a500.attacker.example` each have a genuinely distinct
`url` *and* `feed_url`, so both UNIQUE constraints are satisfied and all 500 reach every
subscriber's reader; the only brake is a per-IP bucket that a handful of addresses defeats.
Cleanup needs a **`host_suffix` ban form** (`.attacker.example`, matched with
`substr(host, -length(suffix))`) alongside the exact-host form — otherwise removing a
wildcard domain is 500 inserts and counting.

### Fetch budget

Worst case is **6** outbound requests per submission — submitted page, its feed, canonical
page, its feed, and (only on a `feed_url` collision) the incumbent page and its feed —
dropping to 2 when the canonical page *is* the submitted page and there's no collision. The
`https:`→`http:` scheme fallback can add retries on top. Each is subject to the same
`safeFetch` guards, and the SSRF check runs against the canonical URL too: a feed's
`<channel><link>` is attacker-controlled input like everything else here.

**A total budget, not just per-request timeouts.** Without one, 4 requests each with their
own timeout and up to 5 redirect hops can block a synchronous POST far past 30s — past many
default reverse-proxy timeouts, while the user watches a spinning tab, resubmits, and trips
the rate limiter. One `AbortSignal` for `SUBMIT_BUDGET_MS` (30s) shared across every fetch,
plus a `timeout` reason and a loading state on the form.

**The per-request timeout is derived from the remaining budget, not fixed.** A static
`FETCH_TIMEOUT_MS` can't be reconciled with the budget once you count everything that
consumes it: up to 6 fetches, an `https:`→`http:` scheme-fallback retry (so up to 12), and up
to 5 redirect hops each. Any fixed value either overruns the budget or fires spuriously on
slow-but-honest sites. Use `min(FETCH_TIMEOUT_MS, budgetRemaining)` per request, composing
signals with `AbortSignal.any([...])`; `SUBMIT_BUDGET_MS` is the only real ceiling and
`FETCH_TIMEOUT_MS` is just a per-request sanity cap.

---

## 6. Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Pitch, a single member **count**, and a link to `/submit`. **No member list, no how-to-join steps, no blog post** — see §10. |
| GET | `/blog` | All posts, newest first. |
| GET | `/blog/:yyyy/:mm/:dd/:slug?` | A single post. (`{/:slug}?` is Express-5 syntax and throws at request time in Hono with an unhelpful `undefined is not iterable` — verified.) Resolution is an **index lookup, never a `path.join`** on route params. |
| GET | `/feed.xml` | **Our own** RSS 2.0 feed (§6.4). Alias: `/rss.xml` → 301. |
| GET | `/.well-known/recommendations.opml` | 301 → `/subscriptions.opml`. Emerging convention for blogroll discovery. |
| GET | `/sites` | Human-readable view of what's in the OPML. A verification and transparency page, not a discovery surface. **All members on one page, newest first, no pagination.** Badges for source-ns, rsscloud, `failing` and `blocked`. See §6.3. |
| GET | `/submit` | The form on its own page (the homepage embeds it too). |
| POST | `/submit` | Rate-limited. Runs `verifySite` synchronously, re-renders with a detailed result panel. **A rejected submission writes nothing** — no `optout_seen_at`, no `last_checked_at`, no `failure_count` — or an attacker gets around `/recheck`'s pass-only rule by using `/submit` instead. |
| POST | `/check` | "Test my page without listing it" — same pipeline, discards the result. **Must be POST and share `/submit`'s rate limit.** As a `GET` with a `?url=` parameter it was an unauthenticated request amplifier: `<img src="…/check?url=victim">` turns every visitor to any page into an attack packet from our IP, and prefetchers and crawlers fire it too. `noindex`. |
| POST | `/recheck/:id` | Re-run verification now. **May only improve state or confirm an opt-out — it can never advance `failure_count`.** See below. Rate-limited, with its own `last_recheck_at` cooldown clock so it can't reset the scheduler's. |
| GET | `/status?url=…` | Public state lookup: status, `last_error`, `last_checked_at`, `failure_count`, and the exact `xmlUrl`/`htmlUrl` we'd publish. **Matches on normalized `url` OR `submitted_url`** — `sites.url` is the canonical URL, but a member will type what they submitted, which is often a different page. Needs an index on `submitted_url` (§4). **Reports `hidden` as a neutral "not listed"**, never as "moderated" — otherwise it hands back exactly the oracle that `/submit` and `/recheck` contort themselves to avoid. With no accounts and no email, this is the **only** way a member can find out why they vanished — and `/sites` deliberately omits `dropped`/`removed`/`hidden`, so the page they'd check shows nothing. Linked from `/about`, `/sites` and every rejection message. |
| POST | `/report` | Report a listed site (URL, reason, optional contact). Rate-limited, writes to `reports`, surfaced on `/admin`. |
| GET | `/robots.txt` | Allow `/`, `/sites`, `/blog`, `/badge`, `/about`; disallow `/admin`, `/check`, `/recheck`, `/status`. |
| GET | `/sitemap.xml` | Static pages + `/blog` posts. Search is the growth channel. |
| — | 404 / 500 | Real templated pages. `/blog/2026/07/99` and typo'd URLs are guaranteed traffic, and Hono's default is a bare text response. |
| GET | `/subscriptions.opml` | The OPML subscription list. `Content-Type: text/xml; charset=utf-8` — see §7. |
| GET | `/opml` | 301 → `/subscriptions.opml` (people will guess this). |
| GET | `/badge` | Badge assets and copy-paste snippets. See §6.1. |
| GET | `/guide` | How to add an RSS 2.0 feed, per platform. See §6.2. Static. Linked from every `feed_not_rss2` and `feed_not_declared_on_canonical` rejection — the counterpart to the RSS-2.0-only decision. |
| GET | `/about` | What we do, what we fetch, how to be removed, and the privacy statement (below). The URL in our `User-Agent`, so it has to answer the questions a site owner asks when they see us in their logs. |
| GET | `/iheartrss.svg` | Light-background wordmark. Long cache, permissive CORS — hotlinking is the point. |
| GET | `/iheartrss-dark.svg` | Dark-background wordmark. Same headers. |
| GET | `/iheartrss-icon.svg` | Heart-only square icon. Same headers. |
| GET | `/healthz` | `{ ok, sites, lastRevalidation }` for Docker's healthcheck. |
| GET | `/admin` | Token-gated dashboard: recent submissions, failing sites, ban list. |
| POST | `/admin/sites/:id/hide` | Set `status = 'hidden'`. |
| POST | `/admin/sites/:id/unhide` | Back to `active` and re-verify. |
| POST | `/admin/ban` | Add host to `banned_hosts` and hide all its sites. |

#### What `/about` has to say

It's the URL in our `User-Agent`, so it's where a stranger lands after finding us in their
server logs. Written for that reader, in plain language:

- **What we are** and why we fetched them — usually because someone submitted their site.
- **What we fetch and how often**: their page and their feed, at most a handful of requests
  every six days, with the exact `User-Agent` string and our source IP quoted so it can be
  allowlisted in Cloudflare or a WAF (§8's `blocked` state exists because this is common).
- **How to get removed**: remove the link, gone within a week (§8); or email for immediate
  removal, since the two-confirmation rule deliberately isn't instant.
- **Privacy statement.** Short and true: we store the URLs people submit, and for each
  submission a **truncated, keyed, daily-rotating hash of the IP** — `/24` for IPv4, `/64`
  for IPv6, HMAC-SHA256 under a key we hold, mixed with the date. We never store raw IP
  addresses. Submission records are **deleted after 90 days** (§4, purged on the revalidation
  tick). No analytics, no third-party scripts, no cookies except the admin session. Say what
  the hash is *for* — rate limiting and abuse triage — because "we hash your IP" without a
  purpose reads worse than the truth.
- **Reporting a listed site**, pointing at `/report`, plus the takedown policy.

#### Why `/recheck/:id` must be pass-only

The original justification — "the only way to make it *remove* a site is to have already
removed the link-back, which only that site's owner can do" — reasoned about the opt-out
branch and ignored the transient one. Rechecking also runs §8's 3-strike path, so with a
1-hour cooldown **anyone can force a healthy member from `active` to `dropped` in three
hours** instead of the 18 days the grace period was designed to give, timed against any
window where the target is briefly down, mid-deploy, rate-limiting us, or serving a CDN
error. Three of four reviewers found this independently.

**`hidden` rows are excluded outright** — `/recheck/:id` writes nothing and returns the same
neutral "already submitted" response `/submit` gives, so it's not a moderation oracle either.
Without this, "may only improve state" reads `hidden → active` as an improvement, and a
moderated member who knows their id (from `/status`, or the `/sites#site-<id>` link they were
given when they joined) un-hides themselves with one request — reopening, on a different
route, exactly the hole §5 Step 7 closed for `/submit`.

Rules: a **pass** applies normally (reset `failure_count`, `status = 'active'`, clear
`optout_seen_at`). A **transient failure** and a **blocked** outcome are **no-ops** — logged
and shown to the caller, never written. An **opt-out** may record a *first* `optout_seen_at`
but **never the confirming one**; only the §8 scheduler applies the second sighting.

**`optout_seen_at` must expire (14 days).** Without an upper bound, an attacker rechecks a
victim during any innocent 200-without-badge moment — a Cloudflare JS interstitial, a
mid-deploy window, a stale CDN page — and that sighting sits there indefinitely, because a
Transient outcome doesn't clear it. Months later the *first* bad scheduler tick becomes the
confirming sighting and the victim is removed. The 24h floor was meant to be a ~6-day floor
in practice; without expiry it collapses to "one bad moment, ever."

**Admin auth.**
- `ADMIN_TOKEN` validated at boot to be ≥32 bytes of hex/base64 — an operator will otherwise
  pick a passphrase, and nothing else here is a shorter path to full control.
- Compare as `timingSafeEqual(sha256(supplied), sha256(expected))`. **Raw
  `crypto.timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on unequal
  lengths** (verified), so a wrong-length guess 500s instead of 401-ing — a crash per
  attempt and a length oracle. Hashing makes both sides 32 bytes always.
- Sessions live in an **in-memory `Map` with a TTL**, deliberately not a table: there is one
  operator, and being logged out by a redeploy is the correct trade for not persisting
  session material next to the data. Stated so it isn't mistaken for a missing schema.
- The cookie holds a **random 32-byte session id with a TTL**, not the token itself. Storing
  the long-lived, un-rotatable env secret in a browser with no expiry and no revocation
  short of a redeploy is a bad trade for a few saved lines. CSRF token derived from the
  session id, so it rotates. Add a logout.
- Rate-limit and exponentially back off the login route, by IP *and* globally. Log failures.
- `HttpOnly; Secure; SameSite=Strict` and a CSRF token is the right combination — that part
  was already correct.
- No admin UI is served at all if `ADMIN_TOKEN` is unset.

**Same-origin enforcement on every public POST.** `/submit`, `/check`, `/recheck/:id` and
`/report` require `Sec-Fetch-Site: same-origin` (or an `Origin` matching `SITE_URL`).
Switching `/check` from GET to POST closed the `<img src>` amplifier but **not** the
amplifier: a cross-origin auto-submitting form with
`enctype="application/x-www-form-urlencoded"` needs no preflight and no JS consent, so any
attacker page still drives our server at a victim URL, each visitor funding a fresh rate
budget. The response being opaque to the attacker is irrelevant for an amplifier.
`SameSite=Strict` protects the admin cookie, not an unauthenticated route.

**Rate limiting:** in-memory token bucket — 5 submissions per 10 minutes, 30 per day,
shared across `/submit`, `/check` and `/recheck`. Plus a **global semaphore (≈4) on
concurrent outbound verifications**, so no combination of endpoints can fan out against a
third party.

Client-IP derivation is where these usually fail:
- `X-Forwarded-For` is trusted only when `TRUST_PROXY=true`. The leftmost entry is 100%
  client-supplied — your proxy *appends* the real peer — so `xff.split(',')[0]` is a
  one-header bypass of every limit here and lets anyone poison `submissions.ip_hash` to
  frame a specific IP.
- **`TRUSTED_PROXY_HOPS` is the number of proxies to skip *past* the rightmost entry, so a
  single nginx in front means `0`, not `1`.** nginx's `$proxy_add_x_forwarded_for` (and the
  Caddy/Traefik equivalents) appends the immediate peer, so with one proxy the app sees
  `<client garbage>, <real peer>` and the real client is the **last** entry. Peeling 1 would
  return the attacker's forged value — the exact bypass this bullet exists to prevent, off
  by one. `.env.example` carries the worked example, and `clientip.test.js` asserts that
  `XFF: 1.2.3.4, 9.9.9.9` with hops=0 yields `9.9.9.9`.
- The process **cannot** see how Docker published its port — `-p 0.0.0.0:3000:3000` and
  `-p 127.0.0.1:3000:3000` are indistinguishable from inside the container. So instead:
  when `TRUST_PROXY=true`, check the **immediate peer address** (before any XFF peeling) is
  in a private range, and reject-and-log if it isn't. That catches a direct public
  connection for real, rather than asserting something unobservable.
- Key IPv6 on the **/64**, not the /128: a residential customer has ~18 quintillion
  addresses, so per-address limits are decorative.
- Bound the map (LRU or periodic sweep) — unbounded, it's itself a memory-exhaustion target.
- Known and accepted: NAT means a conference or university shares one budget. Being
  in-process also means a redeploy resets everything. Right call at this scale (§10).

**Security headers** on every response: `X-Content-Type-Options: nosniff`, a restrictive
`Content-Security-Policy` (there's essentially no inline JS), `Referrer-Policy:
strict-origin-when-cross-origin`, and `Cross-Origin-Resource-Policy: cross-origin` on the
three SVGs, where hotlinking is the point.

---

### 6.1 Badge assets and snippets

**Two files, both already created and visually verified in-browser at final size:**

| File | Wordmark colour | Use on |
|---|---|---|
| `iheartrss.svg` | near-black (path default fill) | light backgrounds |
| `iheartrss-dark.svg` | `#fff` | dark backgrounds |

The orange heart (`#ea7819`) and the white RSS waves inside it are identical in both — they
read well on either background, so the dark variant is a **single added `fill="#fff"`** on
the wordmark path. Brand colour stays constant across variants.

**88×31 is exact, not approximate.** The artwork's viewBox is 1760×620, which is precisely
20× an 88×31 button (1760/88 = 20, 620/31 = 20). Locking the example link to 88×31 gives
zero distortion, and any multiple works the same way: 176×62, 264×93, 352×124.

**Retina needs nothing extra.** SVG rasterizes at the device pixel ratio, so a 88×31 badge
is already sharp at 2× and 3× — no `@2x` files, no resolution `srcset`. The `width`/`height`
attributes are there to reserve layout space and prevent layout shift while the image
loads, not to constrain quality.

#### Snippets offered on `/badge` (absolute URLs built from `SITE_URL`)

```html
<!-- Button, light background -->
<a href="https://iheartrss.com/">
  <img src="https://iheartrss.com/iheartrss.svg" alt="I love RSS" width="88" height="31">
</a>

<!-- Button, dark background -->
<a href="https://iheartrss.com/">
  <img src="https://iheartrss.com/iheartrss-dark.svg" alt="I love RSS" width="88" height="31">
</a>

<!-- Auto-switching, for sites that follow the visitor's OS theme -->
<a href="https://iheartrss.com/">
  <picture>
    <source srcset="https://iheartrss.com/iheartrss-dark.svg" media="(prefers-color-scheme: dark)">
    <img src="https://iheartrss.com/iheartrss.svg" alt="I love RSS" width="88" height="31">
  </picture>
</a>

<!-- Text only -->
<a href="https://iheartrss.com/">I &hearts; RSS</a>
```

`alt="I love RSS"` rather than `alt="I ♥ RSS"` — screen readers announce the bare glyph as
"black heart suit", which is worse than the word.

**All four snippets validate identically.** The link-back check parses `<a href>` elements
(§5 Step 5), so image and text badges are structurally the same to us. `/badge` should say
so explicitly, since people will assume the image is mandatory.

#### Two decisions worth recording

**Rejected: one file with `prefers-color-scheme` CSS inside the SVG.** It's tempting —
media queries do work inside an SVG referenced by `<img>` — but they follow the *visitor's
OS setting*, not the *host page's* theme. A permanently dark-themed blog visited by someone
in light mode would get the dark-text badge on a dark background: invisible. Explicit
variants let the site owner pick what actually matches their design. The `<picture>` snippet
covers people whose sites do track the OS theme.

**The dark variant uses `id="iheartrss-dark-clip"` for its `clipPath`, not `id="a"`.** Both
files carry a clip path for the RSS waves. Inlined in the same document — which is exactly
what `/badge` and the site header will do — two elements with `id="a"` collide, and one
heart's clipping silently breaks. Renaming the id in the new file avoids it; the original
file needs no change.

#### Icon — `iheartrss-icon.svg` (heart only)

A square crop of just the heart, for the favicon and anywhere the full wordmark is too wide
to read. Same artwork and same transform as the wordmark files — only the viewBox is
different, so it can never drift out of sync with the brand.

The heart's exact bounding box in the artwork's user space is **580.30 × 560.53, centred at
(500.01, 310.04)**, computed from the Bézier control points rather than eyeballed. The file
uses `viewBox="190 0 620 620"` — a 620-unit square on that centre, giving 3.2% padding left
and right and 4.8% top and bottom. Tight on purpose: favicons are never masked, so the mark
should use the pixels.

**One file covers light and dark.** The mark is an orange heart with white waves fully
enclosed inside it, so it holds up against both light and dark browser chrome — verified at
16/24/32/48/64/128 px. No dark icon variant is needed, unlike the wordmark.

`<head>` markup, SVG first with a raster fallback for Safari and older browsers:

```html
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/iheartrss-icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

The raster set is generated **once, by hand, and committed** — not built at deploy time.
Rasterising would mean adding a headless-browser or librsvg dependency to the Docker image
to produce files that change roughly never.

**Shipped** (generated with favicon.io, committed to `public/`): `favicon.ico`,
`favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png` (180×180),
`android-chrome-192x192.png`, `android-chrome-512x512.png`, `site.webmanifest`.

**The apple-touch icon is the one asset with no alpha channel**, and it had to be fixed
after generation. favicon.io emits it transparent — verified alpha 0 in all four corners —
and iOS composites a transparent home-screen icon onto **black**, so it would have shipped
as an orange heart on a black tile. It is flattened onto opaque white and re-encoded as
RGB with no alpha channel at all, so there is nothing left to composite. Every other PNG
keeps its transparency, which is correct for browser tabs and for non-maskable Android icons.

A `site.webmanifest` now exists, which makes the deferred maskable-icon item in §13.1 live
rather than hypothetical: the manifest declares no `purpose: "maskable"` icon, so Android
adaptive icons will letterbox the transparent PNGs rather than crop the heart's shoulders
flat. Acceptable; the numbers for a proper maskable variant are in §6.1 above when wanted.

**Known limit: the tight crop is not maskable-safe.** Verified by rendering it under a
circular mask — the heart's left and right shoulders get sliced flat. That's fine for
favicons and for the rounded-square apple-touch treatment (both checked, both good), but
Android adaptive icons and PWA `purpose="maskable"` icons require all content inside a
centred circle of 80% of the canvas width. The heart's circumradius is 403.4 units, so a
maskable variant needs a canvas of **≥1009 units** — use `viewBox="-12 -202 1024 1024"`
plus an opaque background. Not built, because v1 ships no web app manifest; the numbers are
here for when it does.

#### Site header

Same assets serve as the iheartrss.com header at 128×45, swapped by
`prefers-color-scheme` in our own stylesheet. On our own site the media query is correct,
because we control the page theme and can guarantee it follows the OS setting.

---

### 6.2 `/guide` — how to add an RSS 2.0 feed

The counterpart to the RSS-2.0-only decision, and the page that keeps it from being a closed
door. Linked from every `feed_not_rss2` and `feed_not_declared_on_canonical` rejection, from
`/badge`, and from `/about`.

Static content, no server logic. Per-platform, copy-paste, shortest-path-to-working — the
goal is that someone rejected at 9pm is listed by 9:10, without switching tools:

| Platform | What they have | The fix |
|---|---|---|
| **Jekyll / GitHub Pages** | `jekyll-feed` → Atom at `/feed.xml` | Drop in an `rss.xml` Liquid template emitting RSS 2.0, keep jekyll-feed for Atom, add the `<link rel="alternate" type="application/rss+xml">`. Full template on the page. |
| **Eleventy** | Atom via the starter | `@11ty/eleventy-plugin-rss` ships an RSS 2.0 sample; swap the template. |
| **Zola** | Atom by default | `feed_filename = "rss.xml"` in `config.toml` plus the built-in RSS template. |
| **Astro** | `@astrojs/rss` already RSS 2.0 | Usually just the missing `<head>` link. |
| **Hand-rolled / anything else** | — | A minimal, complete, valid RSS 2.0 document to copy and fill in. |

Two things the guide must cover beyond format, because they're our other two common
rejections:

- **The autodiscovery tag**, with the exact line and a note that it belongs on **the page
  your feed's `<channel><link>` points at** — that's §5 Step 4's requirement, and it's the
  non-obvious one.
- **`<channel><link>`**, with a note that it should name the site the feed belongs to. A
  wrong value here is the single most confusing rejection we produce.

Worth adding a "check my page" link straight to `/check` so the loop is: read → fix →
verify → submit, without leaving the site.

**This is also our best blog post**, and the reason to care about it beyond conversion:
"here's how to publish RSS 2.0 on the eight most common static site generators" is a genuinely
useful artifact for the ecosystem, and it's on-thesis for a site called I ♥ RSS.

---

### 6.3 Layout, responsiveness and accessibility

**Every page works on a phone. This is a requirement, not a polish pass** — a directory of
personal blogs will be read and shared on phones more than on desktops, and the submit form
is the one thing that absolutely must work one-handed on a train.

- **Mobile-first CSS**, single hand-written `public/style.css`, no framework and no build
  step. Base styles target small screens; `min-width` media queries add the wider layouts.
  Writing it desktop-first and patching downward is how the awkward middle widths happen.
- `<meta name="viewport" content="width=device-width, initial-scale=1">` on every page.
- **Fluid by default**: `max-width` on a centred column, relative units, `max-width: 100%`
  on images. No fixed pixel widths on containers.
- **`/sites` is a list of rows that reflow, not a `<table>`.** Tables are the single most
  common mobile failure, and this one carries a title, host, two-to-four badges and a date.
  Each entry is a block that stacks vertically on narrow screens and spreads horizontally on
  wide ones — flexbox or grid, no horizontal scroll, ever.
- **Touch targets ≥44px** on links and buttons; the badge snippets on `/badge` and the code
  blocks on `/guide` get `overflow-x: auto` on their own container so a long line scrolls
  inside itself rather than making the page scroll sideways.
- **Forms**: `inputmode="url"`, `autocomplete="url"`, `autocapitalize="off"`,
  `spellcheck="false"` on the URL field. Font-size ≥16px, or iOS Safari zooms on focus.
- Accessibility, all cheap and awkward to retrofit: a skip link, visible `:focus-visible`
  styles, real `<label>`s, semantic landmarks, and a **legend explaining what the source-ns
  and rssCloud badges mean** — nobody arrives knowing that. Check contrast on `#ea7819`,
  which is the one brand colour at risk against white.
- The dark/light header swap (§6.1) is the only theme-dependent asset; everything else should
  work in both without special-casing.

#### Why `/sites` has no pagination

All members on one page, newest first. At launch scale it's a handful of rows, and the OPML
already serialises every member on every request — so the query shape is nothing new.
Dropping pagination buys three things beyond simplicity: **Ctrl-F works**, the
`/sites#site-<id>` deep link from the submit success panel always resolves (with pagination
it could point at a row on page 4), and there's no pagination UI to make responsive.

Revisit when the rendered page gets genuinely heavy — somewhere north of ~1,000 members, well
past the ~2,880 revalidation ceiling in §8, so §8 will demand attention first. If it ever
matters, a client-side filter box beats pagination for a page whose job is "find myself".

---

### 6.4 The blog

We're a site about loving RSS. Not publishing a feed would be a bad look. It also gives the
homepage something to say before the reader lands (§10).

#### Content format

Plain markdown files in `content/`, named by date:

```
content/2026-07-29.md                 → /blog/2026/07/29
content/2026-07-29-a-second-one.md    → /blog/2026/07/29/a-second-one
```

The optional `-slug` suffix is supported **from day one** rather than added later. Bare
`YYYY-MM-DD.md` allows exactly one post per day, and the day you want two is the day every
existing URL has to change. Two extra lines of regex now avoids that.

Frontmatter is optional, and so is everything in it:

```markdown
---
title: A title, if you feel like it
---
Body markdown here.
```

**Untitled posts are correct, not a fallback.** RSS 2.0 says all item elements are
optional, provided at least one of `title` or `description` is present. So an untitled post
emits `<description>` with no `<title>` — a valid item, and exactly the linkblog style the
Winer-adjacent world writes in. On the HTML page, an untitled post is headed by its
formatted date. `<guid isPermaLink="true">` is always present, so every post is addressable
either way.

#### Loading

Parsed and rendered at boot into an in-memory array, sorted newest first. Cache invalidated
by polling every 30s (`CONTENT_POLL_MS`) on `max(mtime)` across a `readdir` + `stat` of each
`.md` — **not** the directory mtime. Verified: adding or deleting a file bumps the directory
mtime, but **editing one does not**, so a directory-mtime poll would publish new posts fine
and silently refuse to show a typo fix until the container restarted. (`fs.watch` is
unreliable across a Docker bind mount; polling is the right shape, just the wrong stat
target.)

Post dates: `pubDate` at midnight UTC puts an evening post in US Central on the *previous*
day for readers, and two posts on one date get identical timestamps with undefined ordering.
Support an optional `time:` frontmatter key, default to midday UTC, and tiebreak on filename.

**No HTML sanitizer**, deliberately. `marked` output is inserted raw because the content is
ours and arrives via the filesystem, not via a form. If the blog ever takes outside
contributions — guest posts, comments — that assumption breaks and a sanitizer becomes
mandatory. Worth a comment in the code so nobody wires up user input to it later.

#### Our own feed should be exemplary

We validate other people's feeds, so ours should pass the checks we run and then some.
`/feed.xml` declares the namespace we look for and uses it:

```xml
<rss version="2.0" xmlns:source="https://source.scripting.com/">
  <channel>
    <title>I ♥ RSS</title>
    <link>https://iheartrss.com/</link>
    <description>…</description>
    <source:self>https://iheartrss.com/feed.xml</source:self>
    <source:blogroll>https://iheartrss.com/subscriptions.opml</source:blogroll>
    <item>
      <link>https://iheartrss.com/blog/2026/07/29</link>
      <guid isPermaLink="true">https://iheartrss.com/blog/2026/07/29</guid>
      <pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
      <description>Rendered HTML…</description>
      <source:markdown>The raw markdown…</source:markdown>
    </item>
  </channel>
</rss>
```

Served as `Content-Type: application/rss+xml; charset=utf-8` — the type the autodiscovery
`<link>` advertises. `<description>` and `<source:markdown>` must be entity-encoded or
CDATA-wrapped: `marked` output and raw markdown both routinely contain `<`, `>` and `&`, and
Dave's own feed escapes them. Reuse the same tested escaper as §7.

`<source:markdown>` is free — we already hold the source text — and `<source:blogroll>` is
the same element we detect on other people's feeds (§5 Step 6), pointed at our member OPML.
(Semantic caveat worth a second look: the spec defines `source:blogroll` as *the blogroll
for the site associated with the feed* — i.e. sites **we** follow. Our member list is a
third-party roster, so `source:subscriptionList` may be the better fit. Same question applies
to `rel="following"`, which will make HyperTexting render our members as our "Following" tab.)
**rssCloud: both forms, and a ping on every restart.** An earlier draft said "no `<cloud>` or
`<source:cloud>` in v1, since we don't run an rsscloud server; if that ever changes, both
forms go in together." **SUPERSEDED:** running one was never the requirement — Dave Winer's
public `rpc.rsscloud.io` is, and we point at it. As promised, both forms went in together:

```xml
<cloud domain="rpc.rsscloud.io" port="80" path="/pleaseNotify" registerProcedure="" protocol="http-post"/>
<source:cloud>https://rpc.rsscloud.io/pleaseNotify</source:cloud>
```

`registerProcedure` is present but **empty**: RSS 2.0 requires all five attributes and
http-post ignores this one. `port="80"` beside an `https` `<source:cloud>` is not a typo — it
is the port of the http-post endpoint, which is what `<cloud>` describes. Both are rendered
from config (`RSSCLOUD_DOMAIN`/`PORT`/`PATH`/`PROTOCOL`), and the URL form is built from
domain + path so the two can never drift onto different servers.

Advertising is unconditional; the **ping** is what `RSSCLOUD_ENABLED` gates —
`POST https://rpc.rsscloud.io/ping` with a form-encoded `url=<our feed>` and
`Accept: application/json`, fired once per boot from **inside** `serve()`'s listening
callback (`src/jobs/rsscloud.js`). Never on the boot path, never able to throw, 10s
`AbortSignal.timeout`, outcome logged either way. Once per restart is the entire schedule
and it is not abuse: the cloud server re-fetches the URL and fans out notifications **only
if the content changed**, so a restart that published nothing costs one request and wakes
nobody — and since posts ship inside the image, "new image" and "the feed changed" are the
same event. Skipped unless `NODE_ENV=production` and `SITE_URL`'s host is publicly routable,
so `pnpm dev`'s watch-restarts and any `SITE_URL=http://localhost:3000` operator can never
ask a stranger's server to fetch a private address. `pnpm rsscloud:ping` does it by hand.

Out of scope, deliberately: WebSub/Atom. No `<atom:link rel="hub">`, no hub subscription —
this is the RSS-native mechanism and adding a second one buys nothing here.

**iheartrss.com should be able to pass its own validator.** The header wordmark links to
`/`, and `/feed.xml` is discoverable from `<head>` — so the site satisfies both checks.
`/feed.xml` and the `<head>` links ship in **phase 1** (empty channel, real items arrive with
the blog in phase 7) so the domain is self-verifying from the phase-2 deploy onward. The
member-#1 row is seeded in phase 6 by **direct INSERT**, not through `/submit` — §5 Step 7
rejects canonical hosts in `LINKBACK_HOSTS`. So the seed is *not* the end-to-end pipeline
test an earlier draft claimed; the real exercise is `pnpm verify https://iheartrss.com` from
phase 4, which hits every step against the live domain without writing a row.

#### Discovery links in `<head>` (every page)

```html
<link rel="alternate" type="application/rss+xml" title="I ♥ RSS" href="https://iheartrss.com/feed.xml">
<link rel="following" type="text/x-opml" title="I ♥ RSS members" href="https://iheartrss.com/subscriptions.opml">
<link rel="blogroll"  type="text/xml"    title="I ♥ RSS members" href="https://iheartrss.com/subscriptions.opml">
```

**Why two elements for the same OPML.** They serve two different consumers, and each wants a
different spelling.

[HyperTexting's profiles guide](https://hypertexting.com/guide/profiles/#add-following-links-to-your-website)
documents `rel="following"` as the **recommended** form, and its app auto-discovers it to
populate a profile's "Following" tab. It matches any of four selectors:

```
link[rel~='following' i]      ← recommended
link[rel~='subscriptions' i]
link[rel~='blogroll' i]
link[type='text/x-opml' i]
```

Note the `~=` — HyperTexting correctly treats `rel` as a space-separated token list, so one
element could satisfy all three of its `rel` selectors. `type="text/x-opml"` on our
`following` element means it matches on two independent paths. The guide also notes
compatibility with Ghost Recommendations and Micro.blog Recommendations.

The second element exists because the Winer-adjacent ecosystem spells it `blogroll` with
`type="text/xml"` — scripting.com currently serves exactly that:

```html
<link rel="blogroll" type="text/xml" href="https://feedland.social/opml?screenname=davewiner&catname=blogroll">
```

Kept as **separate elements** rather than one `rel="following blogroll"`: HyperTexting
handles token lists properly, but there's no guarantee the older `blogroll` readers do, and
a string-comparing parser would miss a combined value. Two lines is cheap insurance.
`subscriptions` is skipped — HyperTexting is the consumer that recognises it, and
`following` already covers us there.

---

## 7. OPML output

Generated on demand from `status IN ('active','failing','blocked')`, ordered by title, with a
`NOT EXISTS` join against `banned_hosts` as a backstop. At our scale this is a single fast
query; add a 5-minute in-memory cache only if it ever shows up in profiling.

**`blocked` must be in that list.** §4 and §8 keep bot-blocked members listed deliberately —
being 403'd by Cloudflare from a datacenter IP isn't the member's failure and usually isn't
theirs to fix. Omitting `blocked` here silently reverts that whole decision to a no-op.
`/sites` shows them with a third badge and an explanatory tooltip.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>I ♥ RSS</title>
    <dateCreated>Wed, 29 Jul 2026 14:00:00 GMT</dateCreated>
    <dateModified>Wed, 29 Jul 2026 14:00:00 GMT</dateModified>
    <ownerName>iheartrss.com</ownerName>
    <ownerId>https://iheartrss.com/</ownerId>
    <docs>http://opml.org/spec2.opml</docs>
  </head>
  <body>
    <outline type="rss" version="RSS"
             text="Scripting News"
             title="Scripting News"
             description="Dave Winer, OG blogger…"
             xmlUrl="http://scripting.com/rss.xml"
             htmlUrl="http://scripting.com/"/>
  </body>
</opml>
```

Notes:
- **Served as `Content-Type: text/xml; charset=utf-8`.** OPML has no registered MIME type,
  so this is a compatibility call rather than a spec one: FeedLand — our primary consumer —
  serves its own OPML as `text/xml`, checked directly against
  `feedland.social/opml?screenname=davewiner&catname=blogroll`. Matching the thing that has
  to read us beats inventing something more descriptive. (`text/x-opml` still appears in the
  `<link type=…>` attribute in §6.4, where HyperTexting matches on it — that's the element's
  type hint, not the HTTP header, and the two don't have to agree.)
- `htmlUrl` is `sites.url` — the canonical URL derived from the feed's `<channel><link>`
  in §5 Step 4, which is by construction the page we verified the link-back on. The
  invariant to preserve: **every `htmlUrl` we publish points at a page that carried an
  "I ♥ RSS" link at last verification.**
- Both `text` and `title` are set — OPML 2.0 requires `text`, and older readers (including
  parts of the Winer toolchain) look for `title`. Cheap insurance.
- `version="RSS"`, or omit the attribute. The OPML 2.0 spec enumerates `RSS1` (RSS 1.0),
  **`RSS` (0.91, 0.92 or 2.0)** and `scriptingNews`; the W3C Feed Validator additionally
  recognises `RSS2`, so `RSS2` isn't invalid so much as non-canonical — an earlier draft
  called it "simply wrong", which overstated it. What *was* wrong is the claim that FeedLand
  expects `RSS2`: FeedLand's own subscription list emits **no `version` attribute at all**
  (and no `title`), just `type`, `text`, `xmlUrl`, `htmlUrl`, `category`. Either way the
  stakes are nil — processors must ignore attributes they don't understand.
- **The hash covers the outline set only, never the `<head>` timestamps.** Compute
  `hash(outlines)`; if it differs from the stored hash, *then* advance
  `directory_version.updated_at`. Hashing the whole rendered document instead would be 100%
  cache-miss: §8 writes `last_checked_at` on every check (~480/day), the blanket bump rule in
  §4 moves `updated_at`, `<dateModified>` sits inside the body, so the body hash — and the
  ETag — would change roughly hourly even in a week where nothing about the directory
  changed. `If-None-Match` would never match and readers would report "blogroll updated"
  every hour forever. Keep the blanket bump as the *trigger to recompute*, not as the thing
  that stamps the timestamp.
- **`ETag` is that outline-set hash**, and `dateModified` / `Last-Modified`
  come from `directory_version.updated_at` (§4). **Two distinct steps, and conflating them is
  the trap:** the write helpers in `db/queries.js` bump **`version` only** — put that inside
  the helpers from phase 3, not at the call sites, which are spread across phases 5, 6 and 8
  and where one that forgets is invisible until a cache serves a removed member.
  `outline_hash` and `updated_at` are then recomputed lazily when `/subscriptions.opml` is
  rendered *and* `version` has moved since the last render. `updated_at` advances only if the
  recomputed `outline_hash` actually differs. `opml.test.js` asserts the
  ETag changes when a site is hidden.
  Deriving them from `max(last_verified_at)` — the original design — is **broken in the
  direction that matters**: `last_verified_at` only advances when a site *passes*, so every
  removal (opt-out, drop, admin hide, ban) changes the body without moving the validator.
  FeedLand's conditional GET gets a `304` and keeps a member we just took down, until some
  unrelated site happens to re-verify. That silently falsifies both the "removed within a
  week" promise and the invariant below, and it breaks worst in the one scenario where speed
  matters: a member's site starts serving malware and the takedown doesn't reach subscribers.
  (It can also move *backwards* if the most-recently-verified row is the one removed, which
  is illegal for `Last-Modified`.)
- `dateCreated` is the site's fixed launch date, not `now()` — the spec defines it as when
  the *document* was created, and emitting the same value as `dateModified` makes it
  meaningless. Omitting it is also fine; all `<head>` children are optional.
- All attribute values XML-escaped through **one shared, tested `xmlAttr()`** (`& < > " '`),
  including the `&` in query strings.
- **Filter by codepoint validity, not just control-character class.** A lone surrogate
  (U+D800–DFFF) or U+FFFE/U+FFFF in a hostile `<channel><title>` is not a legal XML 1.0
  character, and one such member makes `/subscriptions.opml` **not well-formed for every
  subscriber** until an admin notices — a whole-directory denial of service from a single
  submission.
- **Cap lengths at ingest** (title ~200 chars, description ~500) as well as at render, and
  strip bidi overrides (U+202E) and C0/C1 controls so the DB is clean. Nothing currently
  bounds these: they come verbatim from a 5 MB feed into unbounded `TEXT` columns, so a 1 MB
  title bloats the OPML for every reader and wrecks `/sites` layout for everyone.
- This escaper is an **admin-escalation surface, not a cosmetic one**: the OPML is served as
  `text/xml`, which browsers render, so an escaping slip that admits
  `<script xmlns="http://www.w3.org/1999/xhtml">` is same-origin script execution on
  iheartrss.com — and `SameSite=Strict` does not protect `/admin` from a same-origin
  request. Serve it with `nosniff`, and feed §11's well-formedness test hostile fixtures
  (lone surrogate, `"><script`, 1 MB title, `]]>`, RTL override) rather than clean ones.
- An **empty `<body>` is technically invalid** ("one or more `<outline>` elements") and will
  occur between phase 5 and the first member. FeedLand emits an empty body itself, so real
  consumers tolerate it — noted rather than solved, and §12 now seeds member #1 earlier.

---

## 8. Weekly revalidation

In-process scheduler in `src/jobs/revalidate.js`, started by `server.js`.

- Ticks hourly (`setInterval`, `unref`'d), with a module-level `running` guard so a slow
  batch can never overlap the next tick and double-increment `failure_count`.
- Each tick selects up to `REVALIDATE_BATCH` (default 20) sites where
  `last_checked_at < now - interval`:
  - `active` / `failing` / `blocked` → **6 days** (`REVALIDATE_INTERVAL_DAYS`)
  - **any row with `optout_seen_at` set → 24 hours**, regardless of status. This is why the
    second sighting must **clear** `optout_seen_at` when it sets `removed`: otherwise every
    opted-out row stays on the 24-hour arm forever instead of the 90-day retry, and we poll
    people who explicitly asked to be left alone **365 times a year** — from a site whose
    entire pitch is being a good citizen. It would also quietly eat the `dropped`/`removed`
    batch quota that exists to stop dead rows starving live ones. Without this arm
    the removal promise is arithmetically false: a first sighting lands by day 6, and if the
    confirming one waits for the ordinary 6-day cadence it lands by day 12. A 24h follow-up
    puts the worst case at ~7 days, which is what `/about` says.
  - `dropped` → 30 days, `removed` → 90 days (slow retry, so recovery is automatic)
  - `hidden` → never
- **Ordered by `(status_priority, last_checked_at)`, not by `last_checked_at` alone.** A
  `dropped` row last checked 31 days ago otherwise sorts ahead of an `active` row last
  checked 7 days ago, so once a few hundred dead domains accumulate they monopolise every
  batch and live members stop being revalidated — the "within a week" promise fails first
  for exactly the sites that matter most. Quota the batch (e.g. 16 active/failing + 4
  dropped/removed).
- **Every per-site write is wrapped in try/catch inside the loop.** `feed_url` is `UNIQUE`
  and revalidation is allowed to change it, so two rows converging on one feed raises a
  constraint violation mid-batch — which in Node 24 terminates the process on an unhandled
  rejection. On conflict: log and skip. Same for the year-old `dropped` purge.
- **The scheduler holds a reserved outbound slot outside the public semaphore.** Otherwise 4
  concurrent `/recheck` calls aimed at a tarpit host hold every slot for the full budget,
  stalling revalidation — and with it the "removed within a week" clock.
- Checks run sequentially with a small delay, **plus per-host spacing** — don't hit the same
  host twice within a few minutes. A batch containing 20 members on `mastodon.social` or
  `micro.blog` would otherwise hammer one host 20 times in ~40 seconds and trip its rate
  limiter, which then reads back as a transient failure for all of them.
- Send `If-None-Match` / `If-Modified-Since` from `feed_etag` / `feed_last_modified`. A
  `304` is the cheapest possible way to honour the "good citizen" claim, and it needs the
  two columns added in §4.

**Capacity ceiling — write the number down.** 20 sites/hour × 24 = 480 checks/day; at a
6-day interval the steady state is **~2,880 members**. Past that, `last_checked_at` slides
permanently past the interval and the `/about` promise quietly becomes false with **no
signal anywhere** — `/healthz` reports whether a batch ran, not how far behind it is. Also
note each check is 2–4 outbound requests, so 20 sites/hour is really 40–80 requests/hour;
the earlier "scales to thousands without any concurrency machinery" assumed one fetch each.
Fixes: make the batch adaptive from `SELECT COUNT(*)`, and expose `oldest_last_checked_at`
and `overdue_count` on `/healthz` and `/admin` so the ceiling is observable before it bites.
**Revalidation re-fetches `sites.url` and re-runs feed discovery on that page only. It never
re-derives the canonical URL.** `sites.url` is therefore immutable *during revalidation* —
the one path that may change it is the deliberate, incumbent-re-checked row-follows-feed
rule in §5 Step 7, on submission.

This has to be stated, because both alternatives break something. Re-deriving canonical from
the feed can **oscillate**: `/blog/` declares feed F1 whose channel link is `/`, and `/`
declares feed F2 whose channel link is `/blog/`. Step 4's "resolution runs once" prevents a
loop *within* a run but guarantees a flip on every subsequent run — the OPML `htmlUrl`
alternates weekly, `directory_version` churns, and if the badge is on only one of the two
pages the site alternates pass/opt-out. It can also move `sites.url` onto another row's
value, which is a `UNIQUE` violation raised inside the scheduler loop. Conversely, *not*
re-running feed discovery means a member who moves `/feed.xml` → `/feed/` fails on a stale
`feed_url` for three weeks and gets dropped with no self-service repair.

Re-discovering the feed on a fixed `sites.url` gets feed moves for free and keeps the row
stable. `canonical_*` reasons therefore cannot arise during revalidation; if one somehow
does, treat it as Transient.

- Full pipeline per site, and the outcome is split **two ways, not one**:

  | Outcome | Meaning | Action |
  |---|---|---|
  | Pass | Link-back and valid feed both present | `failure_count = 0`, `status = 'active'`, clear `optout_seen_at` |
  | **Opt-out** *(skipped entirely for rows already `removed` — only a Pass matters there, or the 90-day retry restarts the two-sighting dance and polls opted-out people ~8×/year)* | Canonical page returned **2xx**, parsed, complete (not size-capped), **and the pipeline reached Step 5** — so the feed still validates — but **no link-back** | 1st sighting → record `optout_seen_at`, stay listed. 2nd sighting **≥24h and ≤14 days later** → `status = 'removed'` **and clear `optout_seen_at` in the same statement**. Older than 14 days, or any Pass in between → clear and restart |
  | **Blocked** | Persistent `403` or a bot-protection interstitial | `status = 'blocked'`, **stays in the OPML**, flagged on `/admin`. Not the member's fault and usually not theirs to fix |
  | Transient | Timeout, DNS/TLS error, 5xx, size cap exceeded, feed broken or unparseable | `failure_count += 1`, `status = 'failing'`, → `dropped` at 3 |

**Why the split.** The 3-strike grace exists so a server outage doesn't cost someone their
listing. But *deliberately removing the link* isn't a failure to be forgiven — it's an
explicit "take me off," and sitting on it for three weeks would be ignoring a clear opt-out.
The distinction is cleanly observable: we fetched the page fine, and the link isn't there.

A missing or broken **feed** is deliberately *not* an opt-out — that's usually a site
migration or a generator bug, and it gets the full grace period.

**The table is ordered, not a set of independent predicates.** An **Opt-out sighting requires
the pipeline to have reached Step 5** — i.e. the canonical page still declares a feed that
validates. Any earlier failure is Transient. Without stating this, the Cloudflare "Just a
moment…" interstitial matches Opt-out (2xx, parsed, no link-back) *and* Transient (declares
no feed) simultaneously, and an implementer evaluating the rows in the wrong order removes
members under `Under Attack` mode — the precise scenario the `blocked` state exists to
prevent for 403s, leaking through the 200 path. The required order is the natural pipeline
order anyway; it just has to be written down.

**Why the second confirmation.** A single 200-without-a-badge has too many innocent causes
to act on irreversibly: a redesign that temporarily drops the footer, a platform migration
where the badge isn't ported yet, a Cloudflare "Just a moment…" JS challenge (which returns
200 with an interstitial body), a CDN serving a stale page, a parked "account suspended"
page during a billing lapse. With no accounts and no email there is nothing to notify the
member with, and `/sites` hides `removed` rows, so the failure is silent *and* — under the
original design — terminal. Requiring two sightings ≥24h apart still honours "within a
week", and the 90-day retry in §4 means recovery eventually happens on its own.

**A size-capped response is never an opt-out.** It's classified transient. Otherwise any
member whose homepage grows past the cap has their badge cut off mid-document, parses
"fine", and is silently delisted for the crime of writing a long page.

### Honouring "removed within a week"

`/about` will say: **"Remove the link and you'll be removed within a week."** Two mechanics
back that up:

- The revalidation interval is **6 days, not 7**. At 7 the worst case is 7 days plus however
  long until the site's turn comes round — which would make the promise false by a few
  hours. 6 gives a full day of margin, and costs nothing.
- **Only the scheduler applies the second opt-out confirmation.** `/recheck/:id` may record
  a *first* sighting but never the confirming one. Otherwise two rechecks 24h apart let a
  third party delist someone in 24h instead of ~6 days — and a member intermittently serving
  a Cloudflare JS interstitial (200, no badge, an innocent cause this plan itself lists) is
  exactly who'd get caught.
- The promise is therefore **"within a week", not "immediately"** — the earlier claim that
  `/recheck` makes removal instant is incompatible with the two-confirmation rule that
  protects members from false positives. For anyone who genuinely needs it gone now,
  `/about` gives an email address; that's a person's judgement, which is the right tool for
  an irreversible action at this scale.
- A run also fires ~30s after boot so a fresh container doesn't sit idle for an hour.

**Why in-process rather than host cron:** a single container, nothing to configure in
dockge, no second entry point that can drift from the app, and the batching makes it
naturally restart-safe — an interrupted run just resumes from `last_checked_at` on the next
tick. `pnpm revalidate:once` exists as a CLI for manual runs and debugging.

---

## 9. Deployment (Docker + dockge)

**Dockerfile** — multi-stage, `node:24-alpine`:

1. `deps` stage: corepack-enabled pnpm, `pnpm install --frozen-lockfile --prod`.
2. `runtime` stage: copy `node_modules`, `src/`, `public/`, `package.json`.
3. `USER node`, `EXPOSE 3000`, `CMD ["node", "src/server.js"]`.
4. `HEALTHCHECK` hitting `/healthz`, with a `start_period` so boot doesn't burn retries.

No build/compile step and no native modules — `node:sqlite` is compiled into the Node
binary, so there's no `python`/`make`/`g++` layer. Build verified end-to-end: corepack 0.35
is present in `node:24-alpine`, and pnpm's symlink farm survives the cross-stage
`COPY --from=deps` intact.

**Pin the base image** to `node:24.18-alpine` or a digest. `node:24-alpine` is a floating
tag, and a rebuild months later silently pulls a different Node — a real reproducibility
risk given how much rests on `node:sqlite`, which is still actively developed.

**Expect ~245 MB, not ~150 MB.** Measured: the `node:24-alpine` base alone is 230 MB, and
the built image is 245 MB on arm64. Nothing about `src/` moves that. Build time ~10s warm.

#### Three failures that will happen on first deploy

**1. `USER node` cannot write the bind-mounted volume.** Verified:

```
$ docker run --rm --user node -v vol:/data node:24-alpine sh -c 'touch /data/probe'
touch: /data/probe: Permission denied
```

Docker creates a missing `./data` as `root:root`, and the container runs as uid 1000, so it
dies at boot with `ERR_SQLITE_ERROR: unable to open database file`. **Chowning the `.db`
file is not enough** — WAL needs to create `-wal` and `-shm` siblings, so the *directory*
must be writable by uid 1000. Document `mkdir -p data && sudo chown 1000:1000 data` as a
prerequisite in the README and the dockge notes. Also `mkdirSync(dirname(path), {recursive:
true})` at boot, because `DatabaseSync` won't create a missing directory and the local
default `./data/iheartrss.db` fails the same way on a fresh clone.

**2. Node is PID 1, so SIGTERM is ignored and every stop is a 10-second hard kill.**
Verified: `docker stop` takes 10.29s with no handler and 0.16s with one. PID 1 has no
default signal dispositions. Consequences: every dockge redeploy SIGKILLs the process,
losing in-flight submissions mid-pipeline and leaving the WAL uncheckpointed. Add a
`SIGTERM`/`SIGINT` handler — stop the scheduler interval, `server.close()`,
`PRAGMA wal_checkpoint(TRUNCATE)`, `db.close()`, exit — and `init: true` in the compose
service for zombie reaping.

**3. `./content:/app/content:ro` masks the posts baked into the image**, and the plan never
said how a post reaches the server. Decide: either `git pull` on the box (and never edit
there), or drop the bind mount and rebuild to publish.

**docker-compose.yml** (the dockge stack):

```yaml
services:
  iheartrss:
    build: .            # or image: ghcr.io/andrewshell/iheartrss:<version>
    container_name: iheartrss
    restart: unless-stopped
    init: true
    mem_limit: 512m
    pids_limit: 256
    security_opt: [ "no-new-privileges:true" ]
    cap_drop: [ ALL ]
    logging:                      # json-file is unbounded by default; this fills the disk
      driver: json-file           # and takes SQLite down with it
      options: { max-size: "10m", max-file: "3" }
    ports:
      - "127.0.0.1:3000:3000"     # NOT 0.0.0.0 — see below
    environment:
      - NODE_ENV=production
      - PORT=3000
      - SITE_URL=https://iheartrss.com
      - DATABASE_PATH=/data/iheartrss.db
      - TRUST_PROXY=true
      - ADMIN_TOKEN=${ADMIN_TOKEN}
      - IP_HMAC_KEY=${IP_HMAC_KEY}     # from the .env; no secret file to create first
    volumes:
      - ./data:/data
      - ./content:/app/content:ro   # drop a .md file in to publish; no rebuild needed
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 60s
      timeout: 5s
      retries: 3
```

Dockge builds from the stack directory, so `git clone` the repo into
`/opt/stacks/iheartrss` and dockge's compose editor picks it up. Secrets go in a `.env`
beside the compose file. TLS termination is handled by your existing reverse proxy.

**`127.0.0.1:3000:3000`, never `3000:3000`.** Docker inserts its own nat rules ahead of
`ufw`/`firewalld`, so publishing on `0.0.0.0` puts the app on the public internet *beside*
the proxy rather than behind it — and combined with `TRUST_PROXY=true`, anyone connecting
directly can set `X-Forwarded-For` to anything, defeating every rate limit and poisoning
every logged IP hash. It also exposes `/admin` over plaintext. Assert the unsafe combination
at boot.

**Keep the stack's `.env` out of the backup set.** REVISED: the IP HMAC key is
`IP_HMAC_KEY` in that `.env`, not `./secrets/ip_hmac_key` — see §4 for the trade and its
cost. The rule it was protecting is unchanged and now attaches to the `.env`: the key
living beside the database it protects would defeat the point, so one backup tarball and
both halves travel together. Generate it once with `openssl rand -hex 32`, back the `.env`
up separately (a password manager is fine — it holds `ADMIN_TOKEN` too), and note in
`RUNBOOK.md` that losing it makes historical `ip_hash` values unlinkable, which is a
nuisance for abuse triage and harmless for everything else. `.gitignore` covers `.env`.

What this does **not** buy back: an env var is readable from `docker inspect` and from
dockge's own UI, which a mounted file was not. That is accepted. Anyone with either can
already read `./data`, and the hashes are additionally protected by truncating to /24 and
/64 before hashing, by the daily-rotating date component, and by the 90-day purge.

#### Backup, rollback, monitoring

The original plan had one line of backup *advice* and no mechanism, no restore path, no
rollback, and no alerting. For a solo operator that's the difference between a 20-minute
recovery and a rebuild from nothing.

- **Backups run themselves.** A timer calling `node:sqlite`'s `backup()` (exported — no
  `sqlite3` CLI needed, and `node:24-alpine` doesn't ship one) writes
  `./data/backups/YYYY-MM-DD.db` nightly, 14-day retention, plus **one documented off-box
  copy** (rclone/scp). Without off-box, a dead VPS means every member resubmits.
- **Restore is written down and tested once**, in `RUNBOOK.md`. An untested backup isn't one.
- **Rollback needs tagged images.** `build: .` with no registry means there is no previous
  version — a bad commit is recovered by `git checkout` and rebuilding on the production box
  at 2am with the site down. Publish tagged images to ghcr and deploy by tag.

  **Published by hand, not by CI** (`pnpm docker:build-push`). An earlier draft had a
  GitHub Actions workflow publish on every release-please tag; it was deleted. Two reasons:
  GitHub's hosted runners are **amd64-only**, so an automated publish could only ever ship
  half of what production might need, and having both a workflow and a local script meant
  two publishing paths that had already drifted (the workflow built amd64, the script built
  amd64 + arm64 — same version number, different artifact depending on which ran). The
  script builds both architectures through buildx and gates on lint, format and tests before
  pushing. Merging a release PR should not be able to ship an image as a side effect.

  CI therefore does **no Docker work at all** — not even a build-only job. That job did earn
  its keep once (it caught a `pnpm install --prod` failure the test suite could not see), but
  an amd64 build on a runner is a weak proxy for the multi-arch build that actually ships,
  and the script runs the same quality gates before building. The cost is accepted knowingly:
  a Dockerfile break now surfaces at publish time rather than at merge time.
- **Alerting: ping healthchecks.io at the end of each revalidation batch.** One line, and it
  covers both "container dead" and "scheduler wedged" — `restart: unless-stopped` plus
  fail-fast config validation otherwise gives you a silent crash loop you learn about from
  a user email.
- **`/healthz` must return 503 when unhealthy.** The healthcheck as written only inspects
  HTTP status, so `{ok: false}` with a 200 passes and the container is never restarted.
- `.gitignore` covering `.env`, `data/`, `secrets/`, `*.local.*` — the repo is a live clone on the
  server, and §3 listed no `.gitignore` at all.

**Environment variables** (`.env.example`, validated at boot, fail fast if wrong):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `SITE_URL` | `https://iheartrss.com` | Used for absolute URLs in OPML + snippets. |
| `DATABASE_PATH` | `./data/iheartrss.db` | |
| `LINKBACK_HOSTS` | `iheartrss.com,www.iheartrss.com` | Configurable so local dev can point elsewhere. |
| `ADMIN_TOKEN` | — | Admin disabled if unset. |
| `IP_HMAC_KEY` | *(none)* | ≥32 random bytes as hex or base64 (`openssl rand -hex 32`). Required in production and validated at boot; outside production an ephemeral in-memory key is generated per boot and logged as such. Replaces `IP_HMAC_KEY_FILE`, and before that `IP_SALT` — see §4 for why the file went and what it cost. |
| `TRUST_PROXY` | `false` | |
| `TRUSTED_PROXY_HOPS` | `0` | Entries to skip *past* the rightmost. One nginx → `0`. See §6. |
| `SUBMIT_BUDGET_MS` | `30000` | Total budget across all fetches in one submission. |
| `HEALTHCHECK_PING_URL` | — | healthchecks.io ping after each revalidation batch. |
| `REVALIDATE_ENABLED` | `true` | Off in dev/tests. |
| `REVALIDATE_BATCH` | `20` | |
| `REVALIDATE_INTERVAL_DAYS` | `6` | Deliberately under 7 — see §8. |
| `OPTOUT_FOLLOWUP_HOURS` | `24` | Cadence once `optout_seen_at` is set. |
| `OPTOUT_EXPIRY_DAYS` | `14` | A stale first sighting is discarded. |
| `RECHECK_COOLDOWN_MIN` | `60` | Per-site, on its own `last_recheck_at` clock. |
| `MAX_LISTINGS_PER_DOMAIN` | `5` | Anti-flood cap; per-domain overrides live in `domain_limits` (§4). |
| `MAX_NEW_LISTINGS_PER_DAY` | `50` | The global daily new-listing cap §5 Step 7 requires. |
| `CONTENT_DIR` | `./content` | Blog posts. |
| `CONTENT_POLL_MS` | `30000` | Mtime poll for hot-publishing. |
| `FETCH_TIMEOUT_MS` | `8000` | Per-request sanity cap. Effective timeout is `min(this, budgetRemaining)` — see §5. |
| `MAX_RESPONSE_BYTES` | `5242880` | 5 MB. Exceeding it is an error, never a truncation. |

---

## 10. The feed reader, and what the homepage is for

**The homepage does not list members.** The feed reader is the discovery surface — a list
of names is a worse version of the same thing, and shipping one means building something
to delete. So the homepage is: what this is, how to join, a member count, a link to
`/submit`, and the reader.

**The reader has now landed** (`feat/blogroll`). Everything below that reads as a plan is
kept because it is the reasoning; what actually shipped is recorded under "What the
reader is" at the end.

**Trimmed further during implementation, once it could be looked at.** An earlier draft
also put the three "how to join" steps and the latest blog post on `/`. Rendered, that
was three screens before the reader would begin — the reader would have launched below
the fold on a laptop, which defeats the point of giving it this page.

- **The how-to-join steps moved to `/submit`.** They end in the submit form, and the form
  was already on `/submit`, so the arrangement had the explanation on one page and the
  field on another. They are one thing and now live in one place.
- **The latest post is gone from `/` entirely.** It was there to give the homepage
  something to say *before* the reader landed. Once the reader is there, it is the thing
  with something to say.
- **The `<h1>` no longer reads "I ♥ RSS".** The masthead directly above it is the wordmark
  saying exactly that, so the page opened with the same words twice. It states what the
  site *is* instead — which is also the more useful thing for a search result to carry.

`/sites` still exists, for a different job: letting someone confirm they actually got
listed, and showing publicly what's in the OPML. That need did not go away when the reader
arrived — arguably it matters more, since the OPML is otherwise machine-readable only.
Newest-first ordering is deliberate: right after you submit, you're at the top.

**Two paths were on the table, and they cost very differently:**

- *Embedding FeedLand* — it renders the river from our OPML. Nearly free; drop it into the
  reserved slot and v1's architecture is untouched.
- *Building our own reader* — polling every member feed on a schedule and storing items.
  That is a genuinely different workload from anything in v1, and it's the thing that would
  push us off single-instance in-memory rate limiting and in-process scheduling (§6, §8).

Nothing in v1 forecloses either. A future `items` table keyed on `sites.id` slots in
alongside the current schema without migrating anything, and the revalidation scheduler in
§8 is already the right shape to grow into a polling loop — same batching, same politeness
delay, same `last_checked_at` cursor. Worth keeping that in mind, without building for it
now.

### What the reader is

**We took the first path: embedding FeedLand.** The consequence is the one the choice
promised — **v1's architecture is untouched.** No per-member polling, no `items` table, no
new scheduler, no new state of any kind. The server-side diff is a static file, a homepage
section and two CSP directives.

- `public/blog-roll.js` defines a `<blog-roll opmlurl="…">` custom element. It asks
  FeedLand for `getfeedlistfromopml` on our own `/subscriptions.opml`, renders one
  `<details>` per feed newest-first, and fetches `getfeeditems` for that feed only when the
  row is opened. It is **our file on our origin** — nothing is `<script src>`'d from a
  third party.
- The OPML URL is built from `config.siteUrl`, never hardcoded. **FeedLand fetches that URL
  server-side**, which means a `SITE_URL` pointing at localhost cannot work: the reader is
  empty in development and populates only on the deployed origin. Expected, not a bug.
- **CSP widened by exactly two directives** (§6): `script-src` from `'none'` to `'self'`,
  and `connect-src` to `'self' https://feedland.com`. Still no `'unsafe-inline'` — there is
  still no inline JS anywhere in the app, and an injected inline script still cannot run.
- **Progressive enhancement is deliberate**, because `render()` clears the element's
  innerHTML before appending and appends nothing when FeedLand errors. So the section
  carries fallback links *inside* the element (replaced on render — this is the no-JS
  view), a static line *outside* it that survives a FeedLand outage, and a `<noscript>`.

**The privacy consequence, stated plainly.** The reader runs in the visitor's browser, so
**FeedLand sees the IP address of anyone who loads our homepage**, and that it was our
homepage. The old `/about` sentence — "no analytics, no third-party scripts and no
tracking of any kind" — stayed *literally* true (the script is ours, self-hosted) and
stopped being honest, so it was rewritten to name FeedLand and say what it sees. Every
other page on the site still makes no third-party request at all, and there are still no
analytics, no tracking and no cookies for visitors. Same rule as the admin disclosure and
§4's note on `IP_HMAC_KEY`: say the awkward thing rather than hide behind a technicality.

Should the homepage's centre of gravity shift further to the river, the submit form is
already out on `/submit`, so that is a template change, not a rewrite.

---

## 11. Testing

**Structure first: the app and the fetcher must take their dependencies as arguments.**
`createFetcher({ lookup })` is what makes §11's most important test writable at all — the
DNS-rebinding case needs a `lookup` that returns a public address on call 1 and `127.0.0.1`
on call 2. With the agent built at module scope, testing it means running a real
authoritative nameserver with TTL 0 in CI, and the test quietly never gets written. `db/queries.js` holding
"all prepared statements, one place" binds them to a connection at *module-evaluation* time,
so importing `app.js` in a test transitively opens whatever `DATABASE_PATH` says before the
test can inject anything — making §11's "in-memory DB" work only via fragile
`process.env` juggling before the first import. Use `createDb(path) → { db, queries }` and
`createApp({ db, queries, config })`, with `server.js` doing the wiring. This is a cheap
decision now and an expensive one in phase 7.

`node:test`, no framework. Fixtures are **saved real-world files**, not hand-written ideals
— `scripting.com/rss.xml` (source ns + `<cloud>`), a plain WordPress feed, an Atom feed, a
feed with `<source:cloud>`, and HTML pages with text link-backs, image link-backs, no
link-back, and a mention-without-link.

- `url.test.js` — normalization, link-back matching (scheme/www/trailing-slash variants,
  and the negative case of a bare mention).
- `feed.test.js` — RSS 2.0 acceptance, Atom rejection, both cloud styles, namespace
  detection in both `http` and `https` spellings.
- `page.test.js` — feed discovery incl. multi-feed pick order and `<base href>` resolution.
- `canonical.test.js` — the §5 Step 4 logic: channel link equal to the submitted URL (and
  the HTML reuse that implies), channel link at the domain root while the submitted URL is
  a subpath, missing channel link falling back to the submitted URL, channel link that
  redirects, the canonical page declaring a *different* feed than the submitted page (its
  feed must win), and the **hijack case** — a feed whose channel link points at an unrelated
  domain that *does* have a valid link-back. Assert the recorded `feed_url` is the
  **canonical page's own** feed and that no existing row's `feed_url` was overwritten.
  Include the multi-tenant shapes the old PSL guard failed on: `evil.github.io` /
  `victim.github.io`, and `evil.substack.com` / `victim.substack.com`.
- `verify.test.js` — full pipeline against a local fixture HTTP server, plus **SSRF cases**:
  direct `127.0.0.1`, a public host that redirects to a private IP, a DNS name that resolves
  to a private IP, a feed whose `<channel><link>` points at a private IP, an
  IPv4-mapped-IPv6 (`::ffff:127.0.0.1`) answer, a `Location: file:///etc/passwd` redirect,
  and — the one that matters — a **DNS-rebinding** host whose first resolution is public and
  whose second is private. A resolve-then-fetch implementation passes every other case in
  this list while remaining fully vulnerable, so this test is the whole point.
- `fetch.test.js` — size cap returns `page_too_large`/`feed_too_large` rather than a
  truncated body; `SUBMIT_BUDGET_MS` aborts across hops; Latin-1 feed declared only in the
  XML declaration decodes correctly; `https://` failure falls back to `http://`.
- `feed.test.js` additions — billion-laughs feed is rejected without OOM; `<!DOCTYPE`
  rejected; malformed/truncated XML hits `feed_invalid` via `XMLValidator`;
  `<title>2026</title>` stays a string; a one-item feed doesn't crash on `.length`;
  `<rss version="0.91">` is rejected; `xmlns:src=` bound to the source namespace still
  scores `has_source_ns`.
- `opml.test.js` — hostile fixtures (lone surrogate, `"><script`, 1 MB title, `]]>`, RTL
  override) still produce a well-formed document that re-parses; ETag changes when a site is
  hidden (the regression that would otherwise let removals sit in caches).
- `blog.test.js` — filename parsing with and without a slug, absent frontmatter, absent
  title, and the resulting feed item carrying `<description>` with **no** `<title>`. Plus:
  the generated `/feed.xml` is re-parsed with our own `verify/feed.js` and asserted to pass
  our own validator, including `has_source_ns === true`. If we ever break our own feed, that
  test fails.
- `revalidate.test.js` — the §8 outcome split, where the removal promise actually lives: a
  2xx page with the link-back gone records `optout_seen_at` but stays listed, and only a
  second sighting ≥24h later sets `removed`; a timeout, a 500 and a broken feed each take
  the 3-strike path; a size-capped response is transient, **not** an opt-out; a persistent
  403 goes to `blocked` and stays in the OPML; `hidden` is never picked up; a re-added link
  plus resubmit reactivates. Plus scheduling: `dropped` rows don't starve `active` ones, and
  a slow batch doesn't overlap the next tick.
- `moderation.test.js` — **written in phase 5, not 8b**, because phase 5 ships
  `POST /admin/ban` and these are silent failures: resubmitting a `hidden` site does not
  reactivate it; **`/recheck/:id` on a `hidden` site does not reactivate it either** (same
  hole, different route); `/recheck/:id` never advances `failure_count`; a ban with a
  `path_prefix` scopes to one account on a shared host rather than the whole instance (the
  SQL-precedence bug in §4); a `host_suffix` ban catches wildcard subdomains.
- `hijack.test.js` — the two attacks §5 Step 4 is built around, as executable fixtures:
  (a) attacker page whose `<channel><link>` targets a victim, and (b) attacker page
  declaring the *victim's* feed. Assert no existing row is moved and no attacker-controlled
  `htmlUrl` or `xmlUrl` reaches the OPML. Plus **(c)** a canonical feed with **no
  `<channel><link>`** hosted off the canonical host → `feed_not_owned_by_canonical`; and the
  incumbent re-check failing **closed** — `ambiguous_identity` on incumbent-still-verifies
  *and* on a 403, a timeout and budget exhaustion. The fail-closed cases are the entire point
  of that gate, and a wrong implementation passes every other test in this file.
- `caps.test.js` — `MAX_LISTINGS_PER_DOMAIN` refuses the 6th listing on one registrable
  domain, and a `domain_limits` row for `substack.com` lets the 6th through. Without this,
  the multi-tenant seed data is the sort of thing that gets dropped from `001_init.sql` and
  is only noticed when the 6th Micro.blog user is turned away.
- `routes.test.js` — `app.request()` against an in-memory DB: submit success/failure,
  OPML well-formedness (re-parsed and asserted), admin auth rejection.

---

## 12. Build order

Each phase leaves the app runnable, so you can see it working as it grows.

1. **Skeleton** — pnpm init, `createApp()` wiring, `/healthz`, static `public/` (all three
   SVGs moved in), layout + stylesheet with the light/dark header swap, favicon `<link>`s
   plus the one-off `favicon.ico` / `apple-touch-icon.png` generation, homepage copy, **the
   mobile-first stylesheet and viewport meta from §6.3** (established here so nothing later
   is built desktop-first and patched down), **and
   `/about`, `robots.txt`, the 404 page, a zero-item `/feed.xml` and its
   `rel="alternate"` `<head>` link**. (The two OPML discovery links stay in phase 6 — they'd
   otherwise advertise a 404 `/subscriptions.opml` publicly for four phases, to exactly the
   HyperTexting and Micro.blog crawlers that auto-discover them.) `/about` is baked into the outbound `User-Agent` from phase 4 onward —
   without it we spend five phases fetching strangers' servers advertising a URL that 404s.
   The empty feed and `<head>` links ship here (not phase 6) so the phase-2 deploy makes the
   domain **self-verifying**: otherwise `pnpm verify https://iheartrss.com` in phase 4 dies
   at Step 2 with `no_feed_link` and never exercises Steps 3–5. A valid channel with no items
   is fine per §5 Step 3.
   *Deliverable: `pnpm dev` serves a real-looking homepage in both themes.*
2. **Deploy the skeleton to the real domain.** An hour of work that de-risks the most
   annoying class of bug by seven phases: `TRUST_PROXY`/`X-Forwarded-For` wiring, TLS, DNS,
   reverse-proxy timeouts vs the submit budget, and SIGTERM handling are all discovered here
   instead of at the end. It also puts a live badge on iheartrss.com, which phase 4's
   verification core needs to test against. **Open the database in this phase** — even just
   creating an empty file — or the root-owned `./data` permission failure won't surface
   until phase 3 and this phase won't have de-risked it.
   *Deliverable: `/healthz` green on the real domain, behind the real proxy.*
3. **Database** — `node:sqlite` wiring, migration runner, `001_init.sql`, queries module
   with the boolean/`undefined` coercion boundary.
   *Deliverable: DB created on boot, migrations idempotent, seeded row queryable.*
4. **Verification core** — `safeFetch` with the undici guarded-lookup agent, url/page/feed/
   canonical modules, the full test suite with fixtures **including the DNS-rebinding
   case**. Built and tested before any UI touches it — the most security-sensitive code
   here and the easiest to get subtly wrong.
   *Deliverable: `pnpm verify <url>` CLI prints a full verification report.*
5. **Submit flow** — `POST /submit`, rate limiting, same-origin enforcement, result UI with
   per-reason messages and the chosen `xmlUrl`/`htmlUrl` shown, `POST /check`, `/status`,
   `/badge` page with snippets, **and `/guide` (§6.2)** — it ships with the rejection
   messages that link to it, not after them, or the first wave of Jekyll users hits a dead
   end at exactly the moment we're asking them to change something. **Plus a bare-minimum `POST /admin/sites/:id/hide` and
   `POST /admin/ban`** — a token compare and two SQL statements, no session machinery (that
   waits for 8b). Without them, submissions are public from phase 5 and the OPML from phase
   6, while the only moderation lever is `sqlite3` on the production box — which
   `node:24-alpine` doesn't ship. §1's whole publishing model is "auto-publish + admin
   removal"; the removal half cannot land four phases after the publishing half.
   *Deliverable: end-to-end listing works, and anything listed can be taken down.*
6. **OPML + `/sites`** — the OPML builder, **outline-set-hash** ETag, `directory_version`
   recompute-on-render, the `banned_hosts` backstop join, the `rel="following"` and
   `rel="blogroll"` `<head>` links, `/sites` as a single responsive list with feature badges. Then **seed iheartrss.com as member #1** by direct INSERT (`/feed.xml` and the
   `<head>` links already exist from phase 1).
   *Deliverable: FeedLand can subscribe to a non-empty list.*
7. **Blog** — `content/` loader with per-file mtime polling, frontmatter + markdown parsing,
   `/blog` index and post pages, real items flowing into the existing `/feed.xml`, latest
   post on the homepage, `sitemap.xml`.
   *Deliverable: the site publishes posts.*
8a. **Revalidation** — scheduler with the `running` guard, status quotas, per-host spacing,
   conditional GETs, the four-way outcome split, opt-out confirmation and expiry,
   `POST /recheck/:id` (pass-only). *Deliverable: the directory maintains itself.*
8b. **Moderation + admin** — session management with TTL and logout, per-IP and global
   login backoff, CSRF derivation, hide/unhide, path-scoped bans, `/report` queue,
   moderation log. *Deliverable: feature-complete.*

   (Split because as one phase this was comfortably the largest in the plan while reading
   like the smallest — a whole state machine plus a whole auth system.)
9. **Operational hardening** — backup timer + off-box copy, multi-arch image publishing,
   healthchecks.io ping, log rotation, `RUNBOOK.md`, and a **tested restore**.
   *Deliverable: survivable.*

---

## 13. Open questions

Not blocking — sensible defaults are assumed in the plan and each is cheap to change.

1. ~~Badge variants.~~ **Resolved:** `iheartrss.svg` (light backgrounds) +
   `iheartrss-dark.svg` (dark backgrounds) + `iheartrss-icon.svg` (heart-only square, for
   favicons). Example links locked to 88×31; wordmark reused as the site header. All three
   created and verified in-browser at final sizes. See §6.1. *Deferred:* a maskable/PWA
   icon variant — numbers computed in §6.1, needed only once there's a web app manifest.
2. ~~Directory ordering on the homepage.~~ **Resolved:** there is no directory on the
   homepage — the feed reader serves that purpose, and now does. `/sites` remains as a
   verification page, newest first. See §10.
3. ~~Do we require the link-back on the exact submitted URL?~~ **Resolved:** the link-back
   is required on the feed's `<channel><link>` target, because that's the URL the OPML
   lists. See §5 Steps 4–5.
4. ~~Removal requests.~~ **Resolved:** `/about` says **"Remove the link and you'll be
   removed within a week."** Backed by the opt-out split, the 6-day interval, and the 24h
   follow-up cadence once a first sighting is recorded (§8). Note removal is deliberately
   *not* instant — the two-confirmation rule protects members from false positives, so
   `/about` also gives an email address for anyone who needs it gone immediately.
   *Still open, minor:* whether the
   admin page needs a hard-delete for people who want the row gone entirely rather than
   just marked `removed` — the stored data is only a public URL and feed URL, but someone
   may ask.
5. **`source:blogroll`.** Dave's feed exposes one, and now so will ours (§6.4). Detecting
   and storing *members'* blogrolls would make an interesting discovery feature later; not
   in v1.
6. ~~`rel="following"` provenance.~~ **Resolved:** documented and recommended by
   [HyperTexting](https://hypertexting.com/guide/profiles/#add-following-links-to-your-website),
   whose app consumes it. Shipped as the primary form, with `rel="blogroll"` alongside for
   the Winer-side readers. See §6.4.
7. **Blog niceties not planned.** No tags, no drafts, no pagination on `/blog`, no
   per-post `<meta>` descriptions or OG tags. All easy to add; none needed to launch.
8. ~~Atom support.~~ **Resolved and closed: RSS 2.0 only, on principle, not as a v1
   shortcut.** The site is called I ♥ RSS; taking Atom to widen the funnel would make the
   name a lie. Raised by three reviewers on audience-size grounds and settled deliberately
   against them. The obligation that comes with it — `/guide` (§6.2), shipping in the same
   phase as the rejections that link to it — is what makes it an invitation rather than a
   closed door. Not to be reopened by a future reviewer counting addressable blogs.
9. ~~Accessibility and mobile are unplanned.~~ **Resolved:** responsive, mobile-first is a
   hard requirement across every page, `/sites` is a reflowing list rather than a table, and
   pagination is gone. See §6.3, which also carries the accessibility checklist (skip link,
   focus-visible, badge legend, `#ea7819` contrast).
10. **`/sites` ordering vs re-submission.** Ordering is newest `created_at` first so you're
    at the top right after joining — but a *re-submission* doesn't change `created_at`, so
    the affordance silently fails for the `updated` case. Link the success panel straight to
    `/sites#site-<id>`.
11. ~~Privacy statement.~~ **Resolved:** specified in §6's "What `/about` has to say" — what
    we store, the 90-day purge, no analytics or third-party scripts, and what the IP hash is
    *for*. Ships in phase 1 with `/about`.
12. ~~`IP_SALT` handling.~~ **Resolved:** replaced by `IP_HMAC_KEY` — HMAC-SHA256 under a
    secret key, over a **truncated** IP (/24, /64) mixed with a **daily-rotating** date
    component. The key was briefly `IP_HMAC_KEY_FILE`, a mounted file; it is now a single
    env var, because dockge deploys are "paste a compose file and a `.env`" and a key file
    meant an ssh session before the first deploy. §4 carries the construction, the
    reasoning, and the cost of that revision; §9 covers key generation and keeping the
    `.env` out of the backup set.
