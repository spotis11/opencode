# OpenCode Web — web version of the OpenCode desktop app.
#
# Build stage: compiles the official web renderer (packages/app) from this
# repository's source with Bun + Vite (this is the same code the desktop app
# uses; the web entry in packages/app/src/entry.tsx).
#
# Runtime stage: Node.js + the opencode engine (extracted from the official
# desktop Linux package) managed by server.js, which hosts the UI and proxies
# /api/* to the engine with server-side authentication.

FROM oven/bun:1.3 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
RUN cd packages/app && bun run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl binutils xz-utils \
 && rm -rf /var/lib/apt/lists/*
# Engine: `opencode serve` (v2 API + web server), from the official desktop .deb.
RUN curl -fsSL -o /tmp/opencode.deb https://opencode.ai/files/bin/2.4.2/opencode-desktop-linux-amd64.deb \
 && cd /tmp \
 && ar x opencode.deb \
 && tar -xJf data.tar.xz -C /tmp opt/OpenCode/resources/opencode-cli \
 && install -m 0755 /tmp/opt/OpenCode/resources/opencode-cli /app/engine/opencode \
 && rm -rf /tmp/* /tmp/opt
COPY --from=build /src/packages/app/dist /app/web
COPY server.js /app/server.js
ENV HOST=0.0.0.0 \
    PORT=8080 \
    OPENCODE_PROJECT_DIR=/workspace
RUN mkdir -p /workspace
EXPOSE 8080
CMD ["node", "/app/server.js"]
