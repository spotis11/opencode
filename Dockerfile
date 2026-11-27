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
# redirected to /data via XDG env vars. On running.sh the instance is
# standard-4, so /data is the container's writable layer, and persistence
# across deploys is handled by snapshotting /data before a deploy and
# restoring it after (see scripts/persist-snapshot.sh).

FROM oven/bun:1.3 AS build
WORKDIR /src
# The bun image has no curl/wget — ADD fetches the tarball itself.
ADD https://github.com/anomalyco/opencode/archive/refs/tags/v2.4.2.tar.gz /tmp/src.tgz
RUN tar -xzf /tmp/src.tgz --strip-components=1
# The renderer is the pristine v2.4.2 source — no local overlays.
RUN bun install --frozen-lockfile
RUN cd packages/app && bun run build

FROM node:22-slim
WORKDIR /app
# Full Linux sandbox for coding projects — python 3 + the standard toolchain,
# so sessions behave like a real PC: interpreters, compilers, venv, git and
# the usual shell utilities. The opencode engine shells out inside
# OPENCODE_PROJECT_DIR, and everything installed here is available to it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget binutils xz-utils zstd unzip zip file \
      git openssh-client \
      python3 python3-pip python3-venv \
      build-essential pkg-config \
      ripgrep jq sqlite3 \
      net-tools procps less man-db nano \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.name "opencode-sandbox" \
 && git config --system user.email "opencode@localhost" \
 && git config --system init.defaultBranch main
# Engine: `opencode serve` (v2 API + web server), from the official desktop .deb.
# dpkg archives store members as ./opt/..., so extract everything and locate the binary.
RUN curl -fsSL -o /tmp/opencode.deb https://opencode.ai/files/bin/2.4.2/opencode-desktop-linux-amd64.deb \
 && cd /tmp \
 && ar x opencode.deb \
 && mkdir -p /app/engine /tmp/oc \
 && for f in /tmp/data.tar.*; do tar -xf "$f" -C /tmp/oc; done \
 && install -m 0755 "$(find /tmp/oc -type f -name opencode-cli | head -1)" /app/engine/opencode \
 && rm -rf /tmp/oc /tmp/opencode.deb /tmp/data.tar.* /tmp/control.tar.* /tmp/debian-binary
# Local models: Ollama runs inside this container (CPU-only — the GPU backend
# libraries are stripped to keep the image small). The image stays lean by
# NOT baking the weights in: entrypoint.sh pulls them on first boot into
# /var/lib/ollama/models. That is the container's main disk (~18 GB free) —
# /data, by contrast, is only a 1 GB persistent volume (engine state), which
# models would blow through instantly. No provider meters any usage.
RUN curl -fsSL -o /tmp/ollama.tar.zst https://github.com/ollama/ollama/releases/download/v0.40.18/ollama-linux-amd64.tar.zst \
 && mkdir -p /tmp/ol \
 && tar -x --zstd -f /tmp/ollama.tar.zst -C /tmp/ol \
 && install -m 0755 /tmp/ol/bin/ollama /usr/local/bin/ollama \
 && mkdir -p /usr/local/lib \
 && cp -a /tmp/ol/lib/ollama /usr/local/lib/ollama \
 && rm -rf /usr/local/lib/ollama/cuda* /tmp/ol /tmp/ollama.tar.zst
ENV OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_MODELS=/var/lib/ollama/models \
    OLLAMA_MAX_LOADED_MODELS=1 \
    OLLAMA_NUM_PARALLEL=1 \
    OLLAMA_CONTEXT_LENGTH=16384 \
    OLLAMA_KEEP_ALIVE=10m
COPY --from=build /src/packages/app/dist /app/web
COPY server.js /app/server.js
COPY entrypoint.sh /app/entrypoint.sh
ENV HOST=0.0.0.0 \
    PORT=8080 \
    OPENCODE_PROJECT_DIR=/workspace \
    XDG_DATA_HOME=/data/xdg/data \
    XDG_CONFIG_HOME=/data/xdg/config \
    XDG_CACHE_HOME=/tmp/xdg/cache
RUN mkdir -p /workspace /data/xdg/data /data/xdg/config /var/lib/ollama/models /tmp/xdg/cache \
 && printf '# Welcome to your OpenCode sandbox\n\nA real Linux box for coding: python3, git, gcc/g++, make and the usual shell tools are installed. Try `python3 -V` in shell mode.\n' > /workspace/README.md
EXPOSE 8080
CMD ["/bin/sh", "/app/entrypoint.sh"]
