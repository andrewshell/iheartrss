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
RUN pnpm install --frozen-lockfile --prod


FROM node:24.18-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# pnpm's node_modules is a symlink farm into .pnpm; it survives this copy intact.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Runs unprivileged. The image ships uid/gid 1000 as `node`, which is the uid the
# bind-mounted ./data on the host must be owned by — see README, "Deploying".
USER node

EXPOSE 3000

# Only the HTTP status is inspected, which is why /healthz answers 503 (not a
# 200 carrying {ok:false}) when a dependency is down. start_period covers boot
# so the first checks do not burn the retry budget.
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
