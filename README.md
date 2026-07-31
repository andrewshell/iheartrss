# iheartrss.com

A webring-style directory for people who love RSS. You put the badge on your
site, submit your URL, and the site verifies that the badge is really there and
that you really publish a feed. Everything that passes lands in a public OPML
file other readers can subscribe to.

Node 24, [Hono](https://hono.dev), and `node:sqlite` — no build step, no
bundler, no native modules.

## Local development

```sh
pnpm install
cp .env.example .env      # optional; every value has a working default
pnpm dev                  # http://localhost:3000
```

| Command                  | What it does                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`               | Watch-mode server.                                                                                                                                                                                                      |
| `pnpm start`             | Runs the server the way the container does.                                                                                                                                                                             |
| `pnpm test`              | `node --test` over `test/`.                                                                                                                                                                                             |
| `pnpm lint`              | ESLint. `pnpm lint:fix` applies what it can.                                                                                                                                                                            |
| `pnpm format`            | Prettier over the repo. `pnpm format:check` only reports.                                                                                                                                                               |
| `pnpm verify <url>`      | Run the verification pipeline against a real site.                                                                                                                                                                      |
| `node bin/backup.js`     | Back up the database now, and verify the copy. In production: `docker compose exec iheartrss node bin/backup.js`.                                                                                                       |
| `pnpm rsscloud:ping`     | Ping our rssCloud server for `/feed.xml` and `/subscriptions.opml` by hand. Add `feed` or `opml` for just one. The app does the feed on boot and the OPML whenever a member joins; this is for when that didn't happen. |
| `pnpm docker:dry-run`    | Rehearse the manual image build: runs the quality checks and prints the tags it would push, without pushing.                                                                                                            |
| `pnpm docker:build-push` | Build and push a multi-platform image to ghcr.io by hand. The out-of-band path; releases normally do this.                                                                                                              |

`./data/` is created on first boot and is gitignored. Configuration is
documented in `.env.example` and validated at startup: a bad value stops the
process with a message naming the variable, rather than surfacing three requests
later.

**When something is broken in production, read [`RUNBOOK.md`](RUNBOOK.md)**, not
this file. It covers restoring from backup, rolling back, the three ways the
container fails to boot, a wedged scheduler, taking a member down, and a full
disk.

## Development

Formatting is Prettier's job and correctness is ESLint's; they do not overlap, so
`eslint.config.js` carries no formatting rules. Run `pnpm format` before pushing or
CI will fail on `format:check`.

Two git hooks are installed by `pnpm install` (via husky's `prepare` script):

- **pre-commit** — `pnpm lint`, `pnpm format:check`, `pnpm test`. The suite is ~11s,
  which is cheap enough to keep a broken commit off a branch entirely.
- **commit-msg** — commitlint.

### Commits must follow Conventional Commits

Versions are **derived from commit messages**, so the message is not cosmetic:

```
feat: add per-member OPML export       -> minor bump
fix: stop trusting XFF from the proxy  -> patch bump
feat!: drop the v1 submit endpoint     -> major bump
docs: ...  chore: ...  refactor: ...   -> no release on its own
```

`release-please` reads these and keeps a release PR open on `main` with the version
bump and the generated `CHANGELOG.md`. Merging that PR tags `v<x.y.z>`, which is what
builds and publishes the image. Nothing publishes on an ordinary push to `main` —
`.github/workflows/ci.yml` is the gate there.

Commits made before this was set up are not conventional, and that is fine:
`release-please` simply has nothing to release until the next conventional commit
lands.

## Writing a blog post

Posts are markdown files in `content/`, named by date:

```
content/2026-07-29.md                   → /blog/2026/07/29
content/2026-07-29-a-second-one.md      → /blog/2026/07/29/a-second-one
```

Frontmatter is optional, and so is everything in it — `title:` and `time:` (UTC,
`HH:MM`) are the only keys read, and the parser is a flat `key: value` one: no
nesting, no lists. A post with no title is **not** a mistake; it goes out as an
RSS item with a `<description>` and no `<title>`, and is headed on the page by its
date.

`pubDate` defaults to **midday UTC**, not midnight, so an evening post in US
Central doesn't show up on the previous day for readers elsewhere. Two posts on
one date are ordered by their `time:`, then by filename.

In production `content/` is a read-only bind mount (see `docker-compose.yml`), so
publishing is a file copy — no rebuild, no restart. The loader re-reads it when
`max(mtime)` across the `.md` files changes, checked at most every
`CONTENT_POLL_MS` (default 30s), which means an **edit** to an existing post is
picked up too, not only a new file.

## Deploying

The stack runs under [dockge](https://github.com/louislam/dockge) behind an
existing reverse proxy.

**There is no clone of this repo on the box.** Dockge is a web UI over compose: you
create a stack in the UI, paste in a compose file and a `.env`, and dockge writes
them to `/opt/stacks/iheartrss/`. It then _pulls_ the published image. Three things
follow from that, and they are the whole shape of this deployment:

- **The image is pulled, never built on the server.** Publish it from a workstation
  with `pnpm docker:build-push` (see below).
- **Blog posts ship inside the image.** There is no `content/` to bind-mount, so
  publishing a post is: commit it, publish an image, redeploy. There is no
  `./content` volume — mounting one would mask the posts with an empty directory.
- **`./data` is relative to the stack directory** that dockge created, so the one
  prerequisite below is run there.

### 1. Create the stack in dockge

In dockge, **+ Compose** → name it `iheartrss` → paste the contents of
[`docker-compose.yml`](docker-compose.yml) into the compose editor and the values
from step 3 into the `.env` editor. **Do not deploy yet** — step 2 has to happen
first.

### 2. Create the data directory and chown it to uid 1000

**Do this before the first deploy, not after it fails.** Use dockge's built-in
terminal, or ssh, in `/opt/stacks/iheartrss`:

```sh
mkdir -p data
sudo chown 1000:1000 data
```

The container runs as `USER node`, which is uid 1000, and Docker creates a
missing bind-mount source as `root:root`. Without the chown the process exits at
boot with the write-probe error, and once there is a database, SQLite fails with
`ERR_SQLITE_ERROR: unable to open database file`.

Chowning the `.db` file alone is **not** enough: WAL mode creates `-wal` and
`-shm` files beside the database, so the **directory** has to be writable by uid 1000.

### 3. Set the stack environment

Create `.env` beside `docker-compose.yml`. Compose reads it for substitution
(`IHEARTRSS_TAG`) and hands the rest to the app via `env_file:` — only the values
that are a property of running in _this_ container are hardcoded in the compose
`environment:` block.

```sh
ADMIN_TOKEN=$(head -c 32 /dev/urandom | base64)

# Required in production: the key the truncated client IP is HMAC'd under
# before it is stored (plan §4). Generate with `openssl rand -hex 32`. The
# container refuses to start without it.
IP_HMAC_KEY=

# Optional but strongly recommended: pinged at the end of every revalidation
# batch, so a dead container or a wedged scheduler alerts you instead of being
# discovered from a member's email. healthchecks.io or self-hosted.
HEALTHCHECK_PING_URL=

# The published version to run. Pin an exact version rather than leaving it at
# `latest` — "the previous latest" is not something you can name at 2am, and
# being able to name it is the entire point of publishing images.
IHEARTRSS_TAG=0.2.0

# The public URL. Everything absolute (OPML htmlUrl, badge snippets, the feed's
# own links, the rssCloud ping) is built from this.
SITE_URL=https://iheartrss.com

# Optional overrides; see .env.example for the full list with defaults.
# REVALIDATE_BATCH=20
# BACKUP_RETENTION_DAYS=14
```

No admin UI is served at all while `ADMIN_TOKEN` is unset, and hide/ban are the
only way to take a listing down — set it.

Both secrets live in this one file, so **back the `.env` up separately from
`./data`** — a password manager is fine. The IP HMAC key exists so that stored IP
hashes are not reversible, and keeping it in the same tarball as the database it
protects defeats the point. Losing it makes historical `ip_hash` values
unlinkable: a nuisance for abuse triage, harmless for everything else.
`.gitignore` already covers `.env` and `data/`.

### 4. Deploy

In dockge, hit **Deploy** on the stack. It pulls the image named by
`IHEARTRSS_TAG` and starts it; the log pane is right there. Equivalently, from
`/opt/stacks/iheartrss`:

```sh
docker compose up -d
docker compose logs -f
```

Note there is no `--build`: nothing is built on this box.

Expect `{"msg":"listening","port":3000,...}` and a healthy container within
about 15 seconds. Check it directly:

```sh
curl -i http://127.0.0.1:3000/healthz     # 200 {"ok":true}
docker inspect --format '{{.State.Health.Status}}' iheartrss
```

`/healthz` answers **503**, not a 200 carrying `{"ok":false}`, when a dependency
is down — the container healthcheck only inspects the HTTP status, so a 200
would keep a broken container alive forever.

### 5. Point the reverse proxy at it

The port is published on **`127.0.0.1:3000`, never `0.0.0.0:3000`**. Docker
inserts its own nat rules ahead of `ufw`/`firewalld`, so publishing on all
interfaces puts the app on the public internet _beside_ the proxy rather than
behind it — and with `TRUST_PROXY=true` anyone reaching it directly could set
`X-Forwarded-For` to anything, defeating every rate limit and poisoning every
logged IP hash. Do not "fix" a connection problem by widening this binding.

TLS is terminated at the proxy. It must:

- forward to `http://127.0.0.1:3000`,
- append the real peer to `X-Forwarded-For` (nginx: `$proxy_add_x_forwarded_for`),
- set `X-Forwarded-Proto`,
- and allow a request timeout above the submission budget (30s) — verification
  fetches other people's servers, and a 10s proxy timeout will cut off valid
  submissions.

One proxy in front means `TRUSTED_PROXY_HOPS=0`, not 1. See `.env.example` for
the worked example of why.

### 6. Publishing an image (do this before you need to deploy)

The stack pulls `ghcr.io/andrewshell/iheartrss:$IHEARTRSS_TAG`, so a version has to
exist before it can be deployed — and pinning a version is what makes rollback a
one-line edit rather than a rebuild on the production box with the site down.

Publishing is a **manual, deliberate act**, run from a workstation:

```sh
pnpm docker:build-push          # builds linux/amd64 + linux/arm64, pushes to ghcr.io
pnpm docker:dry-run             # shows the tags it would push, builds nothing
```

It is not automated in CI on purpose: GitHub's runners are amd64-only, so a CI
publish could only ever ship half of what production may need. The script builds
both architectures via buildx, and gates on `lint`, `format:check` and `test`
before it pushes anything.

Version comes from `package.json`, which `release-please` bumps when you merge the
release PR it keeps open on `main`. So the usual order is: merge the release PR,
`git pull`, then `pnpm docker:build-push`. That publishes:

```
ghcr.io/andrewshell/iheartrss:1.2.3    <- deploy and roll back by this
ghcr.io/andrewshell/iheartrss:1.2
ghcr.io/andrewshell/iheartrss:1
ghcr.io/andrewshell/iheartrss:latest
```

To deploy one: set `IHEARTRSS_TAG=1.2.3` in the stack's `.env` and redeploy. Pin the
exact version rather than `latest` — "the previous latest" is not something you can
name at 2am, and being able to name it is the point.

You can also publish without cutting a release — `pnpm docker:build-push beta` adds
a custom tag alongside the version and `latest`.

Rollback is then editing that one line and redeploying. See `RUNBOOK.md`,
"Roll back to a previous image".

### 7. Set up an off-box backup copy

The app backs itself up nightly to `data/backups/YYYY-MM-DD.db` (14 days,
`node:sqlite`'s online `backup()` — safe against the live database). That covers a
bad migration and a fat-fingered delete. It does **not** cover a dead VPS, so pull
the directory somewhere else, from a machine that is not the VPS:

```sh
rsync -az --delete vps:/opt/stacks/iheartrss/data/backups/ ~/backups/iheartrss/
```

**Do not include the stack's `.env` in that copy.** It holds `IP_HMAC_KEY`, which
exists so stored IP hashes are not reversible; shipping it in the same tarball as
the database defeats the whole scheme. Back the `.env` up on its own — a password
manager is the right place for it.

Then run the restore procedure in `RUNBOOK.md` once, against a scratch copy, so you
have done it before the night you need it.

### Redeploying

Bump `IHEARTRSS_TAG` in the stack's `.env` and hit **Deploy** (or
`docker compose up -d`). Nothing is built on the box, so there is no `--build` and
no `git pull`.

**Publishing a blog post is a redeploy.** Posts live in `content/` and ship inside
the image, so the sequence is: commit the post, `pnpm docker:build-push`, bump the
tag, deploy. The app pings rpc.rsscloud.io on start, so subscribers are notified as
soon as the new container is up.

The app handles `SIGTERM`, so stops take a fraction of a second rather than the full
10-second kill timeout — which matters with a WAL to checkpoint.

### Troubleshooting

`RUNBOOK.md` is the long form. The short version:

| Symptom                                               | Cause                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Exits at boot: "database directory … is not writable" | Step 2 was skipped. `sudo chown 1000:1000 data`.                                              |
| Exits at boot naming an environment variable          | Config validates at boot and fails fast. Fix the value it names.                              |
| Exits at boot: "`IP_HMAC_KEY` is not set"             | It is missing from the stack's `.env` (step 3). `openssl rand -hex 32`.                       |
| Container healthy, site unreachable                   | Proxy is not pointed at `127.0.0.1:3000`.                                                     |
| `docker stop` takes 10 seconds                        | The SIGTERM handler is not running — check you are on the current image.                      |
| `/blog` empty, `/feed.xml` has no items               | Running an image built before posts were baked in, or a stray `./content` mount masking them. |
| Compose warns about `ADMIN_TOKEN`                     | No `.env` beside the compose file (step 3).                                                   |
| `/healthz` `overdue_count` growing                    | Past the ~2,880-member ceiling. Raise `REVALIDATE_BATCH`.                                     |
| `data/backups/` is empty on a fresh deploy            | The first backup lands about a minute after boot; check for `backup.started` in the logs.     |
