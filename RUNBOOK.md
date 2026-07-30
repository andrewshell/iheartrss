# RUNBOOK

It's 2am, something is broken, and you are the only operator. Start here.

Everything below assumes you are in the stack directory on the host:

```sh
cd /opt/stacks/iheartrss
```

Two things to know before you touch anything:

- **`docker compose logs --tail 100 iheartrss` first.** Every failure in this document
  announces itself in a one-line JSON log record. The config validator in particular
  names the variable it rejected, so "it won't boot" is usually already answered.
- **`data/` is the only irreplaceable thing on the box.** `secrets/ip_hmac_key` is the
  second, and it must **not** live in the same backup — see
  [Losing `secrets/ip_hmac_key`](#losing-secretsip_hmac_key).

---

## Triage: what is actually wrong?

| Symptom                                              | Go to                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Container is restarting, or exits at boot            | [Container won't boot](#container-wont-boot)                              |
| Site is up but the data is wrong / gone              | [Restore from backup](#restore-from-backup)                               |
| Site is broken and the last thing you did was deploy | [Roll back to a previous image](#roll-back-to-a-previous-image)           |
| healthchecks.io alerted, container looks fine        | [Scheduler wedged or falling behind](#scheduler-wedged-or-falling-behind) |
| A listed site is serving malware or spam             | [Taking a member down](#taking-a-member-down)                             |
| Disk is full                                         | [Disk filling up](#disk-filling-up)                                       |

```sh
docker compose ps                                            # up? restarting?
curl -s http://127.0.0.1:3000/healthz | node -e 'process.stdin.on("data",d=>console.log(d.toString()))'
docker inspect --format '{{.State.Health.Status}}' iheartrss  # healthy | unhealthy
```

---

## Backups: what exists, without you doing anything

A timer inside the app calls `node:sqlite`'s `backup()` — SQLite's online backup API —
once a day and about a minute after every boot, writing:

```
data/backups/YYYY-MM-DD.db
```

Files older than `BACKUP_RETENTION_DAYS` (default 14) are pruned, decided on the
**filename**, not the mtime, so a set of backups pulled back from off-box storage is
not mistaken for brand new. The boot run skips if today's file already exists, so a
crash-looping container cannot overwrite a good backup with a copy of a broken state.

Two things this is **not**:

- **Not a file copy.** The database is open in WAL mode, so copying `iheartrss.db`
  alone captures whatever the last checkpoint left behind and silently loses every
  write since.
- **Not `sqlite3 .backup`.** `node:24-alpine` ships no `sqlite3` binary. Use
  `bin/backup.js` (below) for anything you'd have reached for `sqlite3` to do.

### Take a backup right now

Do this **before** any of the destructive procedures in this document.

```sh
docker compose exec iheartrss node bin/backup.js
```

```
{"msg":"backup.written","path":"/data/backups/2026-07-30.db","pages":20}
/data/backups/2026-07-30.db
  integrity_check: ok
  listed members:  1
  schema version:  1
wrote /data/backups/2026-07-30.db (20 pages, pruned 0)
```

It overwrites today's file — that is the point of running it by hand. It reports the
integrity check itself, because "the file appeared" is not the same claim as "the file
is a database".

### Check whether a file is a usable database

```sh
docker compose exec iheartrss node bin/backup.js --verify /data/backups/2026-07-28.db
```

Exit code 0 and `integrity_check: ok` means yes. Anything else prints `NOT USABLE:`
and exits 1. Safe to point at the live database too — it opens read-only.

### Off-box copies

**On-box backups do not survive a dead VPS.** Nothing in the app does this half; set it
up once, from a machine that is not the VPS:

```sh
# On your laptop or a backup host, in cron/systemd-timer, daily:
rsync -az --delete \
  vps:/opt/stacks/iheartrss/data/backups/ ~/backups/iheartrss/
```

Or `rclone sync` to object storage, if you'd rather not depend on a machine you own.
Either way: **do not include `secrets/`**, and put a calendar reminder to run the
restore drill below against a pulled copy once a quarter.

---

## Restore from backup

**This procedure was executed end to end and verified** on 2026-07-30, against a
scratch stack: a live database was destroyed, restored from the previous nightly
backup, and the container came back healthy serving the restored member list. The
transcript is what is written below.

Restoring loses everything written after the backup you restore — typically the day's
submissions and revalidation results. That is the trade; the members whose listings
predate it are all still there.

### 1. Stop the container

Nothing may hold the database open while you swap the file.

```sh
docker compose stop
```

### 2. Pick a backup, and verify it before you rely on it

```sh
ls -la data/backups/
docker compose run --rm iheartrss node bin/backup.js --verify /data/backups/2026-07-29.db
```

Look at `listed members:` — if the number is wrong, you have the wrong file, or the
problem started earlier than you thought. Walk backwards through the dates.

If nothing on the box is usable, pull one from off-box storage into `data/backups/`
first and verify that.

### 3. Move the current files aside — do not delete them

```sh
mv data/iheartrss.db     data/iheartrss.db.broken
mv data/iheartrss.db-wal data/iheartrss.db-wal.broken 2>/dev/null
mv data/iheartrss.db-shm data/iheartrss.db-shm.broken 2>/dev/null
```

The `-wal` and `-shm` siblings **must** go. Left in place beside a restored database
they belong to a different file, and SQLite will either refuse to open it or replay
them into it.

Keep the `.broken` files until the site has been healthy for a day. They may hold rows
the backup doesn't, and there is nothing else to recover them from.

### 4. Copy the backup into place — a copy, never a move

```sh
cp data/backups/2026-07-29.db data/iheartrss.db
sudo chown 1000:1000 data/iheartrss.db
```

`cp`, so the backup stays a backup. And `chown`: the container runs as uid 1000, and
a file you created as root is a file it cannot write. (WAL also needs to create
siblings, so `data/` itself must be uid 1000 — see
[Container won't boot](#container-wont-boot).)

### 5. Verify in place, before starting anything

```sh
docker compose run --rm iheartrss node bin/backup.js --verify /data/iheartrss.db
```

```
/data/iheartrss.db
  integrity_check: ok
  listed members:  1
  schema version:  1
```

### 6. Start, and confirm

```sh
docker compose up -d
docker compose logs -f iheartrss     # expect db.ready, then listening
curl -s http://127.0.0.1:3000/healthz
curl -s http://127.0.0.1:3000/subscriptions.opml | head -20
```

`{"ok":true,"sites":N,...}` with the `N` you saw in step 5, and an OPML file with
outlines in it. Then check `/sites` in a browser.

Migrations run on every boot and are idempotent, so restoring an older backup and
booting a newer image applies whatever it is missing. Restoring a **newer** backup
under an **older** image does not work in reverse — roll the image back first
(next section), then restore.

---

## Roll back to a previous image

Only reach for this if the last deploy caused the problem. If the data is wrong,
restoring won't be fixed by an image change.

Images are published by hand with `pnpm docker:build-push` from a workstation, which
pushes `ghcr.io/andrewshell/iheartrss:1.2.3` plus `:1.2`, `:1` and `:latest` for both
linux/amd64 and linux/arm64. Nothing in CI publishes, so **the set of available tags
is whatever was actually pushed** — check the repo's Packages page on GitHub rather
than assuming a tag exists because a release was cut.

**Deploy by exact version, never `latest`** — "the previous latest" is not something
you can name at 2am.

### If the stack is on `image:`

```sh
# List what is available (or read the Packages page on GitHub):
docker image ls ghcr.io/andrewshell/iheartrss

# Point .env at the previous tag and redeploy:
sed -i 's/^IHEARTRSS_TAG=.*/IHEARTRSS_TAG=1.2.2/' .env
docker compose up -d
docker compose logs --tail 20 iheartrss
```

### If the tag you want was never published

There is nothing to roll back to, because the stack only ever pulls published
images and no repo exists on the box to build from. Publish it from a workstation:

```sh
git checkout <the good tag or sha>
pnpm docker:build-push
```

Then set `IHEARTRSS_TAG` to that version and redeploy as above. This is why §9 wants
images published at each release rather than only when you need one.

`data/` is untouched by any of this. Roll the image back before restoring a database
if you're doing both.

---

## Container won't boot

`docker compose logs --tail 50 iheartrss`. It is nearly always one of three things.

### `./data` is not writable by uid 1000

```
Error: database directory /data is not writable
```

or, once a database exists, `ERR_SQLITE_ERROR: unable to open database file`.

Docker creates a missing bind-mount source as `root:root`, and the container runs as
`USER node` — uid 1000.

```sh
sudo chown -R 1000:1000 data
docker compose up -d
```

**Chowning the `.db` file alone is not enough.** WAL mode creates `-wal` and `-shm`
siblings, so the **directory** has to be writable. Nightly backups write into
`data/backups/` for the same reason.

### `secrets/ip_hmac_key` is missing

```
Error: IP_HMAC_KEY_FILE /run/secrets/ip_hmac_key does not exist
```

Every submission writes a keyed IP hash, so a missing key is deliberately a container
that never comes up rather than one that 500s on the first submission.

```sh
ls -la secrets/ip_hmac_key            # a FILE, 32+ bytes. A directory means Docker
                                      # created the mount point for you — see below.
```

If it is missing **and you have the original backed up** (password manager), restore
that exact file — see the next section for what a _different_ key costs.

```sh
mkdir -p secrets
head -c 32 /dev/urandom | base64 > secrets/ip_hmac_key
chmod 600 secrets/ip_hmac_key
docker compose up -d
```

If `secrets/ip_hmac_key` is a **directory**, that is Docker having created the missing
bind-mount source for you. `sudo rmdir secrets/ip_hmac_key`, generate the file, and
`docker compose up -d` again.

### A bad environment variable

Config is validated at boot and fails fast, naming every problem:

```
Error: Invalid configuration:
  - REVALIDATE_BATCH must be a positive integer, got "twenty"
  - SITE_URL must be http or https, got "iheartrss.com"
```

Fix the value in the compose `environment:` block or in the `.env` beside it, then
`docker compose up -d`. If the message mentions `ADMIN_TOKEN`, it wants ≥32 bytes of
hex or base64, not a passphrase: `head -c 32 /dev/urandom | base64`.

Every variable, its default, and why it is what it is: `.env.example`.

---

## Scheduler wedged or falling behind

The revalidation scheduler is what makes `/about`'s promise — "remove the link and
you'll be removed within a week" — true. If it stops, nothing visibly breaks for days.

```sh
curl -s http://127.0.0.1:3000/healthz
```

```json
{
  "ok": true,
  "sites": 412,
  "lastRevalidation": "2026-07-30T01:00:04.113Z",
  "oldest_last_checked_at": "2026-07-24T09:12:44.900Z",
  "overdue_count": 0
}
```

| Field                    | What it means                                                       | Bad looks like                                                                            |
| ------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `lastRevalidation`       | When a batch last **finished**. Ticks hourly, plus ~30s after boot. | `null` long after boot, or hours stale.                                                   |
| `oldest_last_checked_at` | The least recently checked listing.                                 | Older than `REVALIDATE_INTERVAL_DAYS` (6) — the promise is already false for that member. |
| `overdue_count`          | How many listings are past the interval.                            | Anything **growing** across checks.                                                       |

A single non-zero `overdue_count` is not an emergency; the same number rising over
successive hours is.

### `lastRevalidation` is null or badly stale

```sh
docker compose logs iheartrss | grep -E 'revalidate\.(disabled|skipped|tick_failed)'
```

- `revalidate.disabled` → `REVALIDATE_ENABLED=false` is set. Remove it.
- `revalidate.skipped {"reason":"already_running"}` repeatedly → a batch is stuck on a
  tarpit host. The `running` guard is doing its job, but nothing else is progressing.
  `docker compose restart iheartrss` clears it; the batch resumes from the queue.
- `revalidate.tick_failed` → read the error. A constraint failure names the site.

### `overdue_count` is growing: the capacity ceiling

This is arithmetic, not a bug:

```
REVALIDATE_BATCH (20) × 24 hours = 480 checks/day
480 × REVALIDATE_INTERVAL_DAYS (6) = ~2,880 members in steady state
```

Past ~2,880 listings, `last_checked_at` slides permanently past the interval and
`/about`'s promise quietly becomes false. **The knob is `REVALIDATE_BATCH`**, passed
through by the compose file so you can set it in `.env`:

```sh
echo 'REVALIDATE_BATCH=40' >> .env      # ~5,760 members
docker compose up -d
```

Each check is 2–4 outbound requests, so 40 sites/hour is 80–160 requests/hour. The
scheduler is sequential with a 2s gap and per-host spacing of 3 minutes, so raising
this raises wall-clock batch time roughly linearly — keep it comfortably under the
hour between ticks. Past a few hundred per batch, the answer is a shorter tick
interval or a second worker, not a bigger batch.

### Silence, not a symptom

Set `HEALTHCHECK_PING_URL` (healthchecks.io or self-hosted) in `.env`. It is pinged at
the end of every batch, which covers "container dead" and "scheduler wedged" at once.
Without it, `restart: unless-stopped` turns a crash loop into something you find out
about from a member's email.

---

## Taking a member down

A listed site is serving malware, spam, or has been hijacked. Two levers, both in
`/admin` (which needs `ADMIN_TOKEN` set — if it is unset, no admin UI is served at
all).

```
https://iheartrss.com/admin
```

### Hide one listing — the usual answer

`/admin` → find the listing → **Hide**. Or `POST /admin/sites/:id/hide` with the
session cookie and CSRF token from the page.

Hiding sets `status = 'hidden'`, which:

- drops it from `/subscriptions.opml` and `/sites` immediately, and
- **bumps `directory_version`, so the OPML ETag moves on the very next render.**
  Subscribers revalidate, get a 200 with the new document instead of a 304, and stop
  receiving the outline. There is no cache to wait out.
- makes `/status?url=…` report a neutral "not listed" — never "moderated", so it is
  not a moderation oracle.
- takes it out of the revalidation queue, and `POST /recheck/:id` refuses `hidden`
  rows outright, so the member cannot un-hide themselves.

Reversible: **Unhide** puts it back to `active` and re-verifies.

### Ban a host or a path prefix — for repeat or wildcard abuse

`/admin` → **Ban** (`POST /admin/ban`), with a host and optionally a path prefix. This
adds a `banned_hosts` row **and hides every existing listing that matches**, and the
OPML render carries a `banned_hosts` join as a backstop, so a banned host cannot
reappear even if a row is somehow left `active`. Future submissions from it are
rejected at Step 0.

Use a ban for a whole domain or a shared host's abusive path prefix
(`badhost.example` + `/spammer/`); use hide for one listing.

Both actions are written to `moderation_log` with a reason. Fill the reason in — it is
the only record of why, and future-you will want it.

---

## Losing `secrets/ip_hmac_key`

**What breaks: nothing user-visible.** Historical `ip_hash` values in `submissions`
become unlinkable — you can no longer tell that two old submissions came from the same
network. That is a nuisance for abuse triage and harmless for everything else. Rate
limiting is in-memory and unaffected; no member notices.

Generate a new one and carry on:

```sh
head -c 32 /dev/urandom | base64 > secrets/ip_hmac_key
chmod 600 secrets/ip_hmac_key
docker compose up -d
```

Old hashes stay in the table until the 90-day purge ages them out. Nothing needs
migrating.

### Back it up SEPARATELY from `./data`

The key exists so that stored IP hashes are not reversible. Back it up in the same
tarball as the database it protects and you have defeated the entire scheme in one
step — whoever gets the tarball gets both halves.

- The key goes in a **password manager**, or any store that is not where `data/` goes.
- `./secrets` is deliberately **not** under `./data`, and the off-box `rsync` above
  copies `data/backups/` only. Keep it that way.
- Do not "simplify" the backup to `tar czf backup.tgz data secrets`. That one command
  is the whole mistake.

---

## Disk filling up

```sh
df -h /
du -sh /opt/stacks/iheartrss/data /var/lib/docker
docker system df
```

What is already bounded, so you can stop looking at it:

- **Container logs.** `docker-compose.yml` sets `json-file` with
  `max-size: 10m, max-file: 3` — 30 MB per container, ceiling. Unbounded is the
  default, and left alone it fills the disk and takes SQLite down with it, so if you
  ever edit the compose file, keep that block.
- **Backups.** 14 files in `data/backups/`, each about the size of the database.
- **`submissions`** are purged at 90 days and **`dropped` sites** at ~1 year, both on
  the revalidation tick. They need no cron and no attention. If `submissions` is huge,
  check the scheduler is actually ticking (previous section) — the purge rides on it.

What is _not_ bounded, and is usually the real answer:

```sh
docker image prune -a          # old image tags accumulate once you deploy by tag
docker builder prune           # build cache, if you build on the box
```

Also check for `.broken` files left behind by an old restore, and stray
`iheartrss.db-wal` files: a WAL that has grown very large means checkpoints are not
happening, which a clean restart fixes (shutdown runs
`PRAGMA wal_checkpoint(TRUNCATE)`).

If the disk is full **right now** and SQLite is erroring, free space first, then
restart the container. Do not restore from backup to fix a full disk — you will write
another copy of the database onto a disk that has no room.
