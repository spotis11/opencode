# OpenCode Web — web version of the OpenCode desktop app.
#
# Build stage: compiles the official web renderer (packages/app) with Bun + Vite.
# The renderer source is pinned to the same release as the engine binary
# (v2.4.2): a newer dev-branch renderer calls /api routes the engine doesn't
# have yet — those 404 and the web client then thrashes its request queue.
#
# Runtime stage: Node.js + the opencode engine (extracted from the official
# desktop Linux package) managed by server.js, which hosts the UI and proxies
# /api/* to the engine with server-side authentication.
#
# Engine state (sessions, auth, config — SQLite + JSON under opencode/) is
# redirected to /data via XDG env vars. On running.sh the lite instance
# (256 MiB) cannot carry a volume — volumes force the full-size instance —
# so /data is the container's writable layer, and persistence across deploys
# is handled by snapshotting /data before a deploy and restoring it after
# (see scripts/persist-snapshot.sh).

FROM oven/bun:1.3 AS build
WORKDIR /src
# The bun image has no curl/wget — ADD fetches the tarball itself.
ADD https://github.com/anomalyco/opencode/archive/refs/tags/v2.4.2.tar.gz /tmp/src.tgz
RUN tar -xzf /tmp/src.tgz --strip-components=1
RUN bun install --frozen-lockfile
RUN cd packages/app && bun run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl binutils xz-utils \
 && rm -rf /var/lib/apt/lists/*
# Engine: `opencode serve` (v2 API + web server), from the official desktop .deb.
# dpkg archives store members as ./opt/..., so extract everything and locate the binary.
RUN curl -fsSL -o /tmp/opencode.deb https://opencode.ai/files/bin/2.4.2/opencode-desktop-linux-amd64.deb \
 && cd /tmp \
 && ar x opencode.deb \
 && mkdir -p /app/engine /tmp/oc \
 && for f in /tmp/data.tar.*; do tar -xf "$f" -C /tmp/oc; done \
 && install -m 0755 "$(find /tmp/oc -type f -name opencode-cli | head -1)" /app/engine/opencode \
 && rm -rf /tmp/oc /tmp/opencode.deb /tmp/data.tar.* /tmp/control.tar.* /tmp/debian-binary
COPY --from=build /src/packages/app/dist /app/web
COPY server.js /app/server.js
ENV HOST=0.0.0.0 \
    PORT=8080 \
    OPENCODE_PROJECT_DIR=/workspace \
    XDG_DATA_HOME=/data/xdg/data \
    XDG_CONFIG_HOME=/data/xdg/config \
    XDG_CACHE_HOME=/tmp/xdg/cache \
    NODE_OPTIONS=--max-old-space-size=64 \
    BUN_JSC_forceRAMSize=134217728
RUN mkdir -p /workspace /data/xdg/data /data/xdg/config /tmp/xdg/cache
EXPOSE 8080
CMD ["node", "/app/server.js"]
