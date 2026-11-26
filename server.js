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
      const up = await pollReady(`${engineBase()}/`, 30000)
      engine.ready = up
      if (up) log(`engine ready at ${engineBase()} (password ${sawPassword ? "captured" : "not required"})`)
      else log(`engine did not become ready in time; check ${LOG_DIR}/engine.log`)
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
  if (req.url.startsWith("/__status")) return serveStatus(res)
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
