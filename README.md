# OpenCode Web

A **web version of the OpenCode desktop app** (v2.4.2), built from its source.

The desktop app is an Electron shell around a SolidJS renderer and the
`opencode` engine. This project keeps the exact same pieces and swaps the
Electron shell for a Node.js one:

```
Desktop app  =  Electron main process  +  SolidJS renderer  +  opencode engine
Web version  =  Node.js server.js      +  the same renderer  +  the same engine
```

The renderer is platform-adaptive: when the Electron preload bridge is absent
it runs its built-in "web" platform (`packages/app/src/runtime/platform/web.ts`)
and talks to the engine over same-origin HTTP. So the UI you get here — tabs,
sessions, diffs, review, terminal panel, themes — is the desktop app's own UI.

## What is inside

| Path           | What it is                                                                    |
| -------------- | ----------------------------------------------------------------------------- |
| `server.js`    | The Node.js shell: static hosting, API proxy, engine sidecar (0 dependencies) |
| `web/`         | The renderer, **built from source** with `vite build` (`packages/app`)        |
| `engine/opencode` | The `opencode` CLI, extracted from the official Linux `.deb` (v2.4.2)      |
| `entrypoint.sh`   | Container startup: brings up Ollama (local models) before the web shell    |
| `docs/`        | Screenshots taken while verifying the app in a real browser                   |
| `dev/build-from-source.sh` | Rebuilds `web/` from the upstream monorepo source                  |

## Run it

```bash
node server.js                     # or: npm start / PORT=8080 node server.js
# open http://localhost:8080
```

Requirements: Node.js >= 18, Linux x64 (for the bundled engine; swap in your
own `opencode` binary via `ENGINE_BIN` on any other platform).

First run: the server picks a free port, starts `engine/opencode serve` as a
sidecar, reads the server password it prints, and proxies `/api/*` to it with
that password injected **server-side** — the browser never sees a credential.

Configuration (environment variables):

| Variable               | Default                        | Meaning                                  |
| ---------------------- | ------------------------------ | ---------------------------------------- |
| `PORT` / `HOST`        | `8080` / `0.0.0.0`             | Where the web app listens                |
| `ENGINE_BIN`           | `./engine/opencode`            | Engine binary (falls back to `opencode` on PATH) |
| `ENGINE_PORT`          | random free port               | Fixed engine port                        |
| `OPENCODE_PROJECT_DIR` | current directory              | The project the agent works on           |
| `WEB_DIR`              | `./web`                        | Built renderer directory                 |

Health: `GET /__status` shows whether the engine is up, its port and PID,
and whether the local model server is ready (with its model list).

## Local models (run inside the box)

The Docker image bundles **Ollama** and three models, served on
`127.0.0.1:11434` — real models running on the machine itself, with no API
key and nothing metered anywhere. The weights are pulled on first boot into
the container's main disk (`/var/lib/ollama/models`, ~18 GB free; re-pulled
automatically after deploys), so the image itself stays small and the
persistent `/data` volume (a 1 GB loop device holding only the engine state)
is never crowded:

| Model                | Size    | Good for                  |
| -------------------- | ------- | ------------------------- |
| `qwen2.5-coder:1.5b` | ~1.0 GB | Fast edits and quick chat |
| `llama3.2:3b`        | ~2.0 GB | General chat              |
| `qwen2.5-coder:7b`   | ~4.7 GB | Quality coding (heavier)  |

They appear in the composer's model selector under **Ollama (local)** — pick
one like any cloud model and the engine talks to localhost. Cost shows as 0:
every token comes from the container's own CPU, not from any provider quota.

On the running.sh standard-4 instance (12 GB RAM / 20 GB storage / 4 vCPU)
the 7B model holds comfortably in RAM. Generation is fully CPU-based, so it
is slower than a hosted API (roughly 5–8 tokens/s on 7B, noticeably faster
on 1.5B/3B), the very first boot — and the first boot after every deploy —
downloads the weights (~7.7 GB total, about a minute at datacenter
bandwidth), and the first message after a cold start pays a one-off model
load of tens of seconds, after which the model stays warm for 10 minutes.

`entrypoint.sh` starts Ollama before the web shell and pulls any missing
models in the background (`/__status` reports what is ready), and
`server.js` merges the `ollama` provider into the engine config on every
engine start, so local models survive config restores and fresh `/data`
volumes. Outside Docker, run `ollama serve` yourself and the same selector
works.

## Deploy

### Docker

The `Dockerfile` in this directory builds the UI **from the upstream monorepo
source** (Bun + Vite) and downloads the engine from the official 2.4.2
package. The local models are not baked into the image: `entrypoint.sh`
pulls them on first boot into `OLLAMA_MODELS` (default
`/var/lib/ollama/models` on the container's main disk), so the build stays
small — point `OLLAMA_MODELS` at a volume to keep weights across container
rebuilds:

```bash
docker build -t opencode-web .
docker run -p 8080:8080 -v "$PWD/my-project:/workspace" opencode-web
```

Without a bundled `web/` directory (slim builds), `server.js` automatically
serves the engine's embedded web build instead — the same official UI.

### running.sh

Deployed live at a `*.running.sh` URL as a **standard-4** container (12 GB
RAM, 20 GB storage, 4 vCPU — sized to also run the local models above; this
directory's `Dockerfile` is detected from the GitHub repo and built; port
8080, healthcheck `/__status`, sleeps after 30 min idle and wakes on request,
so compute is only billed while it is awake).

> Sizing note: the free **lite** instance (256 MiB) cannot hold the Node proxy
> plus the Bun-compiled engine — containers serve for ~90 s and are then
> OOM-killed in a loop (SIGKILL 137). Use standard-1 or bigger.

**State across deploys** (`scripts/persist-snapshot.sh save|restore|deploy`):
a deploy resets the container filesystem, so `server.js` exposes
`GET /__persist/dump` (stops engine → consistent tar of `/data/xdg` → restarts)
and `POST /__persist/restore` (extract + engine restart), gated by a
`PERSIST_TOKEN` secret. Verified end to end: sessions created before a deploy
are still there after it.

Deployment was done via the running.sh API (project → service → deployment),
see `scripts/deploy-running.sh` and `scripts/persist-snapshot.sh`.

## Using the app

1. Open `http://localhost:8080` — Home shows your projects and sessions
   (exactly like the desktop app's home).
2. Click **New session**. The composer supports `/` commands, `@` context
   mentions, image attachments, agent selection (Build / Plan / Big Pickle).
3. The engine is the real OpenCode v2 engine: sign in to a provider with
   `./engine/opencode auth login` (or set up `opencode.json` in your project
   directory) for cloud models — or just pick one of the **Ollama (local)**
   models in the composer's model selector, which need no sign-in at all and
   run entirely inside the machine.

The project the agent operates on defaults to the directory you started
`server.js` from (override with `OPENCODE_PROJECT_DIR`). The UI detects its
git branch, sessions run tool calls against it, and the review panel shows
diffs — same engine semantics as the desktop app.

## How it was built

1. Downloaded the official Linux desktop app
   (`opencode-desktop-linux-amd64.deb`, v2.4.2) and unpacked it: the Electron
   `app.asar` contains the renderer bundle and the engine binary.
2. Pulled the matching upstream source (`github.com/anomalyco/opencode`,
   tag `v2.4.2`). The desktop app's UI lives in the `@opencode/app` workspace
   package, which ships an official **web** entry (`src/entry.tsx`) used for
   the web/PWA surface.
3. `bun install` + `vite build` in `packages/app` produced `web/` (2811
   precached files, PWA service worker included).
4. Verified `opencode serve` (the engine, also inside the deb): API under
   `/api/*`, SSE events at `/api/event`, Basic auth
   `opencode:<password>`, PTY over WebSocket at `/api/pty/:id/connect`.
5. Wrote `server.js` to play the Electron-main role: sidecar management,
   static hosting, streaming proxy (REST + SSE + WS upgrades).

## Security notes

- The engine binds to `127.0.0.1` only; the browser reaches it exclusively
  through this server, and the engine password stays in the server process.
- The web UI has no built-in authentication. If you expose `HOST` beyond
  localhost, put it behind your own auth proxy — anyone who can reach the app
  can drive the agent on `OPENCODE_PROJECT_DIR`.
