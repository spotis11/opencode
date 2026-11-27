#!/usr/bin/env node
/**
 * OpenCode Web — a Node.js web version of the OpenCode desktop app.
 *
 * Architecture (reverse-engineered from the OpenCode desktop app, v2.4.2):
 *
 *   Desktop app = Electron shell (main process)  +  SolidJS renderer (the UI)
 *   Web  version = Node.js shell  (this file)    +  the same SolidJS renderer,
 *                  built from source (`packages/app`, web entry).
 *
 * The renderer is platform-adaptive: without the Electron preload bridge it
 * runs as the "web" platform and talks to the OpenCode API engine over
 * same-origin HTTP (`location.origin`, all endpoints under `/api/...`, SSE
 * events at `/api/event`, PTY over WebSocket at `/api/pty/:id/connect`).
 *
 * This server plays the role the Electron main process plays on desktop:
 *   1. spawns the engine (`opencode serve`, extracted from the Linux deb)
 *      as a sidecar child process and reads the server password it prints;
 *   2. serves the built web UI statically at `/`;
 *   3. reverse-proxies `/api/*` to the engine — REST, SSE streaming and
 *      WebSocket upgrades — injecting the engine's Basic auth server-side
 *      so the browser never sees a credential;
 *   4. reports readiness at `/__status`.
 *
 * Zero runtime dependencies: plain Node.js (>= 18).
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Configuration (environment overrides)
// ---------------------------------------------------------------------------

const HOST = process.env.HOST || "0.0.0.0"
const PORT = Number(process.env.PORT || 8080)
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, "web")
const ENGINE_BIN =
  process.env.ENGINE_BIN ||
  (fs.existsSync(path.join(__dirname, "engine", "opencode"))
    ? path.join(__dirname, "engine", "opencode")
    : "opencode") // fall back to a system-installed opencode
const ENGINE_PORT = process.env.ENGINE_PORT ? Number(process.env.ENGINE_PORT) : undefined
// Working directory the engine operates on (the project the agent edits).
const PROJECT_DIR = process.env.OPENCODE_PROJECT_DIR || process.cwd()
const LOG_DIR = path.join(__dirname, "logs")
// XDG root for engine state; on running.sh this is /data (container writable
// layer — a deploy resets it, use the /__persist endpoints around deploys).
const DATA_DIR = process.env.PERSIST_DIR || path.dirname(path.dirname(process.env.XDG_DATA_HOME || "/data/xdg/data"))

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".weba": "audio/webm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(...args) {
  process.stdout.write(`[opencode-web] ${args.map(String).join(" ")}\n`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function pollReady(url, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(url, { timeout: 1500 }, (res) => {
        res.resume()
        resolve(res.statusCode ? true : false)
      })
      req.on("error", () => retry())
      req.on("timeout", () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(attempt, intervalMs)
    }
    attempt()
  })
}

// ---------------------------------------------------------------------------
// Engine sidecar ("opencode serve"), the agent backend
// ---------------------------------------------------------------------------

const engine = {
  child: null,
  port: null,
  password: null,
  url: null,
  ready: false,
  version: null,
  lastError: "",
}

function engineBase() {
  return `http://127.0.0.1:${engine.port}`
}

function startEngine() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const logFile = fs.openSync(path.join(LOG_DIR, "engine.log"), "a")

  return freePort().then((port) => {
    engine.port = ENGINE_PORT || port
    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(engine.port)]
    log(`starting engine: ${ENGINE_BIN} ${args.join(" ")} (project dir: ${PROJECT_DIR})`)
    const child = spawn(ENGINE_BIN, args, {
      cwd: PROJECT_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    engine.child = child

    let sawListening = false
    let sawPassword = false
    const onLine = (line) => {
      // Example engine output:
      //   server listening on http://127.0.0.1:4399
      //   server password uhgAkr3-...
      const listening = line.match(/server listening on (https?:\/\/\S+)/)
      if (listening) {
        sawListening = true
        engine.url = listening[1]
      }
      const password = line.match(/server password\s+(\S+)/)
      if (password) {
        sawPassword = true
        engine.password = password[1]
      }
    }
    let stdoutBuf = ""
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString()
      let idx
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        onLine(stdoutBuf.slice(0, idx))
        stdoutBuf = stdoutBuf.slice(idx + 1)
      }
      fs.writeSync(logFile, chunk)
    })
    child.stderr.on("data", (chunk) => {
      engine.lastError = chunk.toString().slice(0, 4000)
      fs.writeSync(logFile, chunk)
    })

    const markReady = async () => {
      // Poll in cycles; a stuck or slow boot self-heals: after ~45s without
      // readiness the engine is restarted once, and polling continues for up
      // to 10 minutes so a late boot never leaves a stale not-ready flag.
      const deadline = Date.now() + 10 * 60_000
      let restarts = 0
      let cycles = 0
      while (Date.now() < deadline && engine.child === child) {
        cycles++
        const up = await pollReady(`${engineBase()}/`, 15000, 500)
        if (up) {
          if (!sawPassword && restarts < 2) {
            // A boot that never printed a server password would 401 every API
            // call — useless. Restart the engine once and expect the line.
            restarts++
            log("engine ready but no server password was printed — restarting it once")
            stopEngine()
            await new Promise((ok) => {
              const w = () =>
                !engine.child || engine.child.exitCode !== null ? ok() : setTimeout(w, 200)
              w()
            })
            if (engine.child === child) startEngine()
            return // the new child runs its own markReady loop
          }
          engine.ready = true
          log(`engine ready at ${engineBase()} (password ${sawPassword ? "captured" : "not required"})`)
          return
        }
        if (engine.child !== child) return
        if (cycles >= 3 && restarts < 1) {
          restarts++
          log("engine not ready after 45s — restarting it once")
          stopEngine()
          await new Promise((ok) => {
            const w = () =>
              !engine.child || engine.child.exitCode !== null ? ok() : setTimeout(w, 200)
            w()
          })
          if (engine.child === child) startEngine()
          return // the new child runs its own markReady loop
        }
        log(`engine still starting (cycle ${cycles})…`)
      }
      if (engine.child === child) {
        engine.ready = false
        log(`engine did not become ready in time; check ${LOG_DIR}/engine.log`)
      }
    }
    markReady()

    child.on("exit", (code, signal) => {
      log(`engine exited (code=${code} signal=${signal})`)
      engine.ready = false
      // Do not flap forever; a supervisor (or a restart of this server) starts it again.
    })
    return child
  })
}

function stopEngine() {
  if (engine.child && engine.child.exitCode === null) {
    log("stopping engine")
    engine.child.kill("SIGTERM")
  }
}

// ---------------------------------------------------------------------------
// Engine-state persistence (deploy-time snapshot / restore)
//
// The engine keeps sessions, auth and config as SQLite + JSON under its XDG
// dirs (DATA_DIR/xdg on the container filesystem). Container filesystems do
// not survive a deploy, so before deploying, `scripts/persist-snapshot.sh`
// saves this state over GET /__persist/dump and restores it after the deploy
// over POST /__persist/restore (which restarts the engine so it reloads the
// database). Both endpoints require the PERSIST_TOKEN secret header.
// ---------------------------------------------------------------------------

const PERSIST_TOKEN = process.env.PERSIST_TOKEN || ""
const PERSIST_DIR = DATA_DIR

function persistAllowed(req) {
  return Boolean(PERSIST_TOKEN) && req.headers["x-persist-token"] === PERSIST_TOKEN
}

function restartEngine() {
  stopEngine()
  return new Promise((resolve) => {
    const wait = () => {
      if (!engine.child || engine.child.exitCode !== null) {
        startEngine()
        resolve()
      } else {
        setTimeout(wait, 250)
      }
    }
    wait()
  })
}

async function persistDump(res) {
  try {
    const hadState = fs.existsSync(path.join(PERSIST_DIR, "xdg"))
    const wasRunning = Boolean(engine.child && engine.child.exitCode === null)
    if (!hadState) {
      res.writeHead(200, { "content-type": "application/gzip" })
      return res.end(Buffer.alloc(0))
    }
    if (wasRunning) {
      log("dump: stopping engine for a consistent snapshot")
      stopEngine()
      await new Promise((ok) => {
        const w = () =>
          !engine.child || engine.child.exitCode !== null ? ok() : setTimeout(w, 200)
        w()
      })
    }
    try {
      const tmp = path.join(os.tmpdir(), "persist-dump.tgz")
      await new Promise((ok, err) => {
        const tar = spawn("tar", ["czf", tmp, "-C", PERSIST_DIR, "xdg"], {
          stdio: ["ignore", "ignore", "pipe"],
        })
        let msg = ""
        tar.stderr.on("data", (c) => (msg += c))
        tar.on("exit", (code) => (code === 0 ? ok() : err(new Error(`tar exit ${code}: ${msg.slice(0, 200)}`))))
        tar.on("error", err)
      })
      if (wasRunning) startEngine()
      const stream = fs.createReadStream(tmp)
      res.writeHead(200, { "content-type": "application/gzip" })
      stream.pipe(res)
      stream.on("close", () => fs.unlink(tmp, () => {}))
    } catch (err) {
      if (wasRunning) startEngine()
      throw err
    }
  } catch (err) {
    log(`dump failed: ${err.message}`)
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" })
    }
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function persistRestore(req, res) {
  try {
    const tmp = path.join(os.tmpdir(), "persist-restore.tgz")
    const ws = fs.createWriteStream(tmp)
    await new Promise((ok, err) => {
      req.pipe(ws)
      ws.on("finish", ok)
      ws.on("error", err)
    })
    const size = fs.statSync(tmp).size
    if (size > 0) {
      fs.mkdirSync(PERSIST_DIR, { recursive: true })
      await new Promise((ok, err) => {
        const tar = spawn("tar", ["xzf", tmp, "-C", PERSIST_DIR], {
          stdio: ["ignore", "ignore", "pipe"],
        })
        let msg = ""
        tar.stderr.on("data", (c) => (msg += c))
        tar.on("exit", (code) => (code === 0 ? ok() : err(new Error(`tar exit ${code}: ${msg.slice(0, 200)}`))))
        tar.on("error", err)
      })
    } else {
      log("restore: empty payload, nothing to extract")
    }
    fs.unlink(tmp, () => {})
    log(`restored engine state (${size} bytes) — restarting engine`)
    await restartEngine()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ restored: size, engineRestarted: true }))
  } catch (err) {
    log(`restore failed: ${err.message}`)
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: err.message }))
  }
}

// ---------------------------------------------------------------------------
// Usage reset (olliecode's reset pill, web version)
//
// Zeroes the engine's local usage accounting — the cost/token aggregate
// columns on every session_v2 row and the usage-related event rows — while
// keeping every conversation (sessions, messages and parts are untouched).
// The engine keeps running: SQLite in WAL mode takes the short write with a
// busy timeout, and the UI reloads after the reset to re-read the zeroed
// counters. A timestamped .backup of the database is taken first, so a reset
// is always reversible. Local-only by design: nothing outside this
// deployment's own database is touched.
// ---------------------------------------------------------------------------

const ENGINE_DB = path.join(DATA_DIR, "xdg", "data", "opencode", "opencode.db")

function sqlite(db, script) {
  return new Promise((ok, err) => {
    const proc = spawn("sqlite3", ["-cmd", "PRAGMA busy_timeout=10000", db], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let msg = ""
    proc.stdout.on("data", (c) => (out += c))
    proc.stderr.on("data", (c) => (msg += c))
    proc.on("error", err)
    proc.on("exit", (code) => (code === 0 ? ok(out) : err(new Error(`sqlite3 exit ${code}: ${msg.slice(0, 300)}`))))
    proc.stdin.end(script)
  })
}

async function resetUsage(res) {
  try {
    if (!fs.existsSync(ENGINE_DB)) throw new Error(`engine database not found at ${ENGINE_DB}`)
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backupDir = path.join(path.dirname(ENGINE_DB), "usage-backups")
    fs.mkdirSync(backupDir, { recursive: true })
    const backup = path.join(backupDir, `usage-reset-${stamp}.db`)
    await sqlite(ENGINE_DB, `.backup '${backup}'`)
    const out = await sqlite(
      ENGINE_DB,
      `UPDATE session_v2
          SET cost = 0,
              tokens_input = 0,
              tokens_output = 0,
              tokens_reasoning = 0,
              tokens_cache_read = 0,
              tokens_cache_write = 0;
       SELECT 'sessions=' || changes();
       DELETE FROM event
         WHERE type LIKE 'session.usage.recorded@%'
            OR type LIKE 'session.step.ended@%'
            OR type LIKE 'session.step.failed@%';
       SELECT 'events=' || changes();`,
    )
    const sessions = Number((out.match(/sessions=(\d+)/) || [])[1] || 0)
    const events = Number((out.match(/events=(\d+)/) || [])[1] || 0)
    log(`usage reset: ${sessions} sessions zeroed, ${events} usage events purged (backup ${path.basename(backup)})`)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, sessions, events, backup: path.basename(backup) }))
  } catch (err) {
    log(`usage reset failed: ${err.message}`)
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: false, error: err.message }))
  }
}

// ---------------------------------------------------------------------------
// /api/* proxy — REST + SSE (streaming) with server-side Basic auth
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function proxyApi(req, res) {
  const target = new URL(req.url, engineBase())
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  headers.host = `127.0.0.1:${engine.port}`
  if (engine.password) {
    headers.authorization =
      "Basic " + Buffer.from(`opencode:${engine.password}`).toString("base64")
  }

  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: engine.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (upRes) => {
      const resHeaders = {}
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue
        resHeaders[name] = value
      }
      res.writeHead(upRes.statusCode || 502, resHeaders)
      upRes.pipe(res) // streams SSE/chunked bodies through untouched
    },
  )

  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" })
    }
    res.end(JSON.stringify({ error: "engine-unreachable", detail: String(err) }))
  })

  req.pipe(upstream)
  req.on("aborted", () => upstream.destroy())
}

// ---------------------------------------------------------------------------
// /api/* WebSocket upgrade proxy (PTY terminals, MCP connects)
// ---------------------------------------------------------------------------

function proxyUpgrade(req, socket, head) {
  const target = new URL(req.url, engineBase())
  const headers = { ...req.headers }
  headers.host = `127.0.0.1:${engine.port}`
  if (engine.password) {
    headers.authorization =
      "Basic " + Buffer.from(`opencode:${engine.password}`).toString("base64")
  }
  delete headers.connection
  // Reconstruct the request line verbatim; ws handshake requires raw forwarding.
  const lines = [
    `${req.method} ${target.pathname}${target.search} HTTP/1.1`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "\r\n",
  ]
  const upstream = net.connect(engine.port, "127.0.0.1", () => {
    upstream.write(lines.join("\r\n"))
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on("error", () => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
  })
  socket.on("error", () => upstream.destroy())
  socket.on("close", () => upstream.destroy())
}

// ---------------------------------------------------------------------------
// Static web UI (the renderer built from source)
// ---------------------------------------------------------------------------

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname)
  let filePath = path.normalize(path.join(WEB_DIR, urlPath))
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403)
    return res.end("Forbidden")
  }
  const tryFile = (candidate) => {
    fs.stat(candidate, (err, stat) => {
      if (!err && stat.isFile()) {
        const type = MIME[path.extname(candidate).toLowerCase()] || "application/octet-stream"
        res.writeHead(200, { "content-type": type, "content-length": stat.size })
        fs.createReadStream(candidate).pipe(res)
        return
      }
      if (candidate === path.join(WEB_DIR, "index.html")) {
        res.writeHead(404, { "content-type": "text/plain" })
        return res.end("Not found")
      }
      // SPA fallback: any GET without an extension resolves to the app shell.
      if (!path.extname(urlPath)) return tryFile(path.join(WEB_DIR, "index.html"))
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("Not found")
    })
  }
  tryFile(filePath)
}

// ---------------------------------------------------------------------------
// Status endpoint
// ---------------------------------------------------------------------------

function serveStatus(res) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
  res.end(
    JSON.stringify(
      {
        app: "opencode-web",
        version: "2.4.2",
        engine: {
          ready: engine.ready,
          url: engine.url,
          port: engine.port,
          pid: engine.child?.pid,
          version: engine.version,
          hasPassword: Boolean(engine.password),
          lastError: engine.lastError || undefined,
        },
        webDir: path.basename(WEB_DIR),
        projectDir: PROJECT_DIR,
        persist: Boolean(PERSIST_TOKEN),
        host: os.hostname(),
      },
      null,
      2,
    ),
  )
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

// When no built renderer is present (e.g. a slim container image), the UI is
// served by the engine itself — it embeds the official web build — through the
// same authenticated proxy.
const STATIC_FROM_ENGINE = !fs.existsSync(path.join(WEB_DIR, "index.html"))

function serveSplash(res) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "retry-after": "2" })
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2">` +
      `<title>OpenCode Web — starting</title></head>` +
      `<body style="font-family:system-ui;background:#fafafa;color:#333;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center"><h1>OpenCode Web</h1><p>The engine is starting…</p></div></body></html>`,
  )
}

const server = http.createServer((req, res) => {
  if (req.url === "/__persist/dump" && req.method === "GET") {
    if (!persistAllowed(req)) {
      res.writeHead(403, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: "forbidden" }))
    }
    return persistDump(res)
  }
  if (req.url === "/__persist/restore" && req.method === "POST") {
    if (!persistAllowed(req)) {
      res.writeHead(403, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: "forbidden" }))
    }
    return persistRestore(req, res)
  }
  if (req.url.startsWith("/__status")) return serveStatus(res)
  if (req.url === "/__reset-usage" && req.method === "POST") return resetUsage(res)
  if (req.url === "/api" || req.url.startsWith("/api/")) {
    if (!engine.ready) {
      res.writeHead(503, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: "engine-starting", detail: engine.lastError || undefined }))
    }
    return proxyApi(req, res)
  }
  if (!engine.ready) return serveSplash(res)
  if (STATIC_FROM_ENGINE) return proxyApi(req, res)
  return serveStatic(req, res)
})

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/api/")) return proxyUpgrade(req, socket, head)
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
})

async function main() {
  if (!STATIC_FROM_ENGINE && !fs.existsSync(path.join(WEB_DIR, "index.html"))) {
    log(`FATAL: web UI directory not found: ${WEB_DIR}`)
    process.exit(1)
  }
  await startEngine()
  server.listen(PORT, HOST, () => {
    log(`OpenCode Web listening on http://${HOST}:${PORT} (web UI: ${WEB_DIR})`)
    log(`status: http://localhost:${PORT}/__status`)
  })
}

process.on("SIGINT", () => {
  stopEngine()
  process.exit(0)
})
process.on("SIGTERM", () => {
  stopEngine()
  process.exit(0)
})

main().catch((err) => {
  log("fatal:", err)
  process.exit(1)
})
