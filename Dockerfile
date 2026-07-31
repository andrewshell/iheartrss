# iheartrss.com — plan §9.
#
# Multi-stage, but there is no build step: no TypeScript, no bundler, and no
# native modules. `node:sqlite` is compiled into the Node binary, so this image
# needs no python/make/g++ layer. The split exists only to keep pnpm's store and
# lockfile machinery out of the runtime layer.
#
# The base tag is PINNED. `node:24-alpine` floats, and a rebuild months from now
# would silently pull a different Node — a real reproducibility risk when
# `node:sqlite` is still actively developed and the whole app rests on it.
# Expect ~245 MB: the base alone is ~230 MB, and src/ does not move that.

FROM node:24.18-alpine AS deps

WORKDIR /app

RUN corepack enable

# Only the manifests, so this layer is cached until dependencies actually change.
COPY package.json pnpm-lock.yaml ./

# --prod: no devDependencies in the runtime image. --frozen-lockfile: fail the
# build rather than silently resolving something the lockfile does not pin.
#
# --ignore-scripts is load-bearing, not tidiness. `--prod` skips devDependencies
# but STILL runs this package's own `prepare` script, and `prepare` is `husky`,
# which is a devDependency — so the install died with `sh: husky: not found`. That
# is the documented husky-in-Docker trap.
#
# Skipping scripts is safe here because every dependency is pure JavaScript with
# nothing to compile: the choice of `node:sqlite` over `better-sqlite3` (see
# PLAN §2) is exactly what makes that true. It is also a small supply-chain win,
# since no dependency's postinstall runs during the image build.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts


FROM node:24.18-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# pnpm's node_modules is a symlink farm into .pnpm; it survives this copy intact.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# The operator CLIs. `bin/backup.js` is what RUNBOOK.md uses to take a backup on
# demand and to verify one — `node:24-alpine` ships no `sqlite3`, so without this
# there is no way to answer "is that file actually a database" from the box.
COPY bin ./bin
# Blog posts ship IN the image. Deploying via dockge means pulling a published
# image with no repo on the box, so there is nothing to bind-mount from — with
# content/ left out, the blog renders empty and /feed.xml carries zero items.
# Publishing a post is therefore: commit it, publish an image, redeploy.
COPY content ./content

# Runs unprivileged. The image ships uid/gid 1000 as `node`, which is the uid the
# bind-mounted ./data on the host must be owned by — see README, "Deploying".
USER node

EXPOSE 3000

# Only the HTTP status is inspected, which is why /healthz answers 503 (not a
# 200 carrying {ok:false}) when a dependency is down. start_period covers boot
# so the first checks do not burn the retry budget.
#
# The port comes from `process.env.PORT`, matching what `config.js` reads, because a
# hardcoded 3000 here is a healthcheck that tests a port nothing is listening on the
# moment an operator sets PORT — and it fails as "unhealthy", i.e. as if the app were
# broken, which is the most expensive way for this to be wrong. Read inside node
# rather than as a `$PORT` shell expansion: the exec-form CMD has no shell, and in
# compose a literal `$PORT` would be substituted by compose itself at parse time
# (from the host environment, usually to an empty string) long before the container
# ever sees it.
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
