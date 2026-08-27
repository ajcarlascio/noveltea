# syntax=docker/dockerfile:1
#
# The browser client: a static bundle behind nginx, which also proxies the API.
#
#   docker build -t noveltea-web .
#
# Needs the vendor/noveltea-server submodule checked out — the SQLite schema and the
# compile package are npm workspaces pointing into it, and without them nothing resolves.
# `git clone --recurse-submodules`, or `git submodule update --init` in an existing clone.

# Pinned to the BUILD platform, not the target. The output of this stage is a static
# bundle — the same bytes whatever the image will run on — so building it once natively
# is not an optimisation, it is the difference between working and not: multi-arch
# publishes emulate the arm64 leg with QEMU, and Node's JIT under qemu-aarch64 dies
# intermittently with "uncaught target signal 4 (Illegal instruction)". That took out a
# push to main whose code was fine.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src

# devDependencies are needed here, unlike the worker: the build runs tsc, and the
# thesaurus index is generated from wordnet-db at build time rather than committed.
COPY package.json package-lock.json ./
COPY vendor/noveltea-server/packages vendor/noveltea-server/packages
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------

FROM nginx:alpine AS runtime

COPY --from=build /src/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ > /dev/null || exit 1
