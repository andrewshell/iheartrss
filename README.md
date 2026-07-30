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

| Command | What it does |
|---|---|
| `pnpm dev` | Watch-mode server. |
| `pnpm start` | Runs the server the way the container does. |
| `pnpm test` | `node --test` over `test/`. |

`./data/` is created on first boot and is gitignored. Configuration is
documented in `.env.example` and validated at startup: a bad value stops the
process with a message naming the variable, rather than surfacing three requests
later.

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
existing reverse proxy. Dockge builds from the stack directory, so the repo is
cloned to the stack path and `docker-compose.yml` is picked up from the clone.

### 1. Clone into the stack directory

```sh
sudo git clone https://github.com/andrewshell/iheartrss.git /opt/stacks/iheartrss
cd /opt/stacks/iheartrss
```

### 2. Create the data directory and chown it to uid 1000

**Do this before the first `up`, not after it fails.**

```sh
mkdir -p data content
sudo chown 1000:1000 data
```

The container runs as `USER node`, which is uid 1000, and Docker creates a
missing bind-mount source as `root:root`. Without the chown the process exits at
boot with the write-probe error, and once there is a database, SQLite fails with
`ERR_SQLITE_ERROR: unable to open database file`.

Chowning the `.db` file alone is **not** enough: WAL mode creates `-wal` and
`-shm` files beside the database, so the **directory** has to be writable by uid
1000.

### 3. Generate the IP HMAC key

```sh
mkdir -p secrets
head -c 32 /dev/urandom | base64 > secrets/ip_hmac_key
chmod 600 secrets/ip_hmac_key
```

The compose file bind-mounts this as a **file**. If it does not exist when the
stack starts, Docker helpfully creates a *directory* at that path and the mount
is wrong in a confusing way — generate it first.

Keep `secrets/` out of the backup set. The key exists so that stored IP hashes
are not reversible; backing it up in the same tarball as the database it protects
defeats the point. Copy it somewhere separate — a password manager is fine.
Losing it makes historical `ip_hash` values unlinkable, which is a nuisance for
abuse triage and harmless for everything else. `.gitignore` already covers
`secrets/` and `data/`.

### 4. Set the stack environment

Create `.env` beside `docker-compose.yml`. It is read by compose for
substitution, not by the app — the app's own variables are set in the compose
`environment:` block.

```sh
ADMIN_TOKEN=$(head -c 32 /dev/urandom | base64)
```

(Admin routes arrive in a later phase and are disabled while the token is unset;
setting it now costs nothing.)

### 5. Start the stack

In dockge: add the existing stack at `/opt/stacks/iheartrss`, then **Deploy**.
Or from the shell:

```sh
docker compose up -d --build
docker compose logs -f
```

Expect `{"msg":"listening","port":3000,...}` and a healthy container within
about 15 seconds. Check it directly:

```sh
curl -i http://127.0.0.1:3000/healthz     # 200 {"ok":true}
docker inspect --format '{{.State.Health.Status}}' iheartrss
```

`/healthz` answers **503**, not a 200 carrying `{"ok":false}`, when a dependency
is down — the container healthcheck only inspects the HTTP status, so a 200
would keep a broken container alive forever.

### 6. Point the reverse proxy at it

The port is published on **`127.0.0.1:3000`, never `0.0.0.0:3000`**. Docker
inserts its own nat rules ahead of `ufw`/`firewalld`, so publishing on all
interfaces puts the app on the public internet *beside* the proxy rather than
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

### Redeploying

`docker compose up -d --build` after a `git pull`. The app handles `SIGTERM`, so
stops take a fraction of a second rather than the full 10-second kill timeout —
which matters once there is a database with a WAL to check point.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Exits at boot: "database directory … is not writable" | Step 2 was skipped. `sudo chown 1000:1000 data`. |
| Container healthy, site unreachable | Proxy is not pointed at `127.0.0.1:3000`. |
| `docker stop` takes 10 seconds | The SIGTERM handler is not running — check you are on the current image. |
| Compose warns about `ADMIN_TOKEN` | No `.env` beside the compose file (step 4). |
