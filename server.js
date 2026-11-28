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
 *   1. gives every browser its own private space: an `oc_space` cookie maps
 *      to a dedicated engine process (`opencode serve`) with its own session
 *      database under /data/spaces/<id>/ — sessions, messages and auth of one
 *      browser are never visible from another one;
 *   2. serves the built web UI statically at `/`;
 *   3. reverse-proxies `/api/*` to that browser's engine — REST, SSE
 *      streaming and WebSocket upgrades — injecting the engine's Basic auth
 *      server-side so the browser never sees a credential;
 *   4. reports readiness and capacity at `/__status` (aggregate — never
 *      space ids, they are a capability).
 *
 * Idle spaces are reaped after 30 minutes without requests (their data stays
 * on disk and returns on the next visit); at most MAX_RUNNING engines stay
 * up at once so the box never runs out of RAM.
 *
 * Zero runtime dependencies: plain Node.js (>= 18).
 */

import { spawn } from "node:child_process"
import crypto from "node:crypto"
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
// Shared by every space — sessions/messages are what is private, the project
// checkout is the common workspace.
const PROJECT_DIR = process.env.OPENCODE_PROJECT_DIR || process.cwd()
const LOG_DIR = path.join(__dirname, "logs")
// Root for engine state; on running.sh this is /data (a persistent volume).
// Each browser space keeps its state under DATA_DIR/spaces/<id>/.
const DATA_DIR = process.env.PERSIST_DIR || "/data"
const SPACES_ROOT = path.join(DATA_DIR, "spaces")

// Privacy / capacity knobs.
const SPACE_COOKIE = "oc_space"
const SPACE_ID_RE = /^[a-f0-9]{24}$/
const MAX_SPACES = 24 // spaces remembered (their engines may be stopped)
const MAX_RUNNING = 10 // engines kept up at once (RAM guard)
const ENGINE_IDLE_MS = 30 * 60_000 // stop engines idle for this long

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

function parseCookies(header) {
  const out = {}
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  }
  return out
}

// Attach a Set-Cookie header to a response header object without clobbering
// whatever is already there.
function withCookie(req, headers) {
  if (req.__setSpaceCookie) {
    const existing = headers["set-cookie"]
    headers["set-cookie"] = existing
      ? (Array.isArray(existing) ? existing : [existing]).concat(req.__setSpaceCookie)
      : req.__setSpaceCookie
  }
  return headers
}

// Tail of a small log file for /__status (container debugging without a shell).
function logTail(file, bytes = 2000) {
  try {
    const st = fs.statSync(file)
    const fd = fs.openSync(file, "r")
    const start = Math.max(0, st.size - bytes)
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.toString("utf8").slice(-bytes)
  } catch {
    return undefined
  }
}

function dfStatus() {
  return new Promise((ok) => {
    const proc = spawn("df", ["-h", "/data", "/tmp", "/"], { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    proc.stdout.on("data", (c) => (out += c))
    proc.on("error", () => ok(undefined))
    proc.on("exit", (code) => ok(code === 0 ? out.trim() : undefined))
  })
}

function osInfo() {
  try {
    const rel = fs.readFileSync("/etc/os-release", "utf8")
    const pick = (k) => (rel.match(new RegExp(`^${k}="?([^"\\n]*)`)) || [])[1]
    return `${pick("PRETTY_NAME") || pick("NAME") || "Linux"} (${os.release()})`
  } catch {
    return `Linux (${os.release()})`
  }
}

// ---------------------------------------------------------------------------
// Spaces — one private engine (and session database) per browser
// ---------------------------------------------------------------------------

const SPACES = new Map() // id -> space

function newSpace(id) {
  const space = {
    id,
    dir: path.join(SPACES_ROOT, id),
    child: null,
    port: null,
    password: null,
    url: null,
    ready: false,
    starting: false,
    lastError: "",
    lastSeen: Date.now(),
    streams: 0, // open SSE / WebSocket connections — keep the engine while > 0
  }
  SPACES.set(id, space)
  return space
}

// Resolve the space for a request; when the browser has no valid space cookie
// yet, mint one and mark the response so every code path that writes headers
// can hand it out (withCookie).
function getSpace(req, res) {
  let id = parseCookies(req.headers.cookie)[SPACE_COOKIE]
  if (!id || !SPACE_ID_RE.test(id)) {
    id = crypto.randomBytes(12).toString("hex")
    if (res) {
      req.__setSpaceCookie =
        `${SPACE_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
    }
  }
  let space = SPACES.get(id)
  if (!space) {
    while (SPACES.size >= MAX_SPACES) {
      // Evict the least recently seen space (its data stays on disk; a
      // returning browser recreates the object from its cookie).
      let oldest = null
      for (const s of SPACES.values()) {
        if (!oldest || s.lastSeen < oldest.lastSeen) oldest = s
      }
      if (!oldest) break
      stopEngineFor(oldest)
      SPACES.delete(oldest.id)
    }
    space = newSpace(id)
  }
  space.lastSeen = Date.now()
  return space
}

function engineBase(space) {
  return `http://127.0.0.1:${space.port}`
}

async function ensureEngine(space) {
  if (space.child && space.child.exitCode === null) return
  if (space.starting) return
  await startEngineFor(space)
}

async function startEngineFor(space) {
  space.starting = true
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.mkdirSync(path.join(space.dir, "data"), { recursive: true })
    fs.mkdirSync(path.join(space.dir, "config"), { recursive: true })
    fs.mkdirSync(`/tmp/spaces/${space.id}/cache`, { recursive: true })
    const logFile = fs.openSync(path.join(LOG_DIR, `engine-${space.id}.log`), "a")

    const port = await freePort()
    space.port = ENGINE_PORT || port
    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(space.port)]
    log(`[space ${space.id.slice(0, 8)}] starting engine on :${space.port}`)
    const child = spawn(ENGINE_BIN, args, {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(space.dir, "data"),
        XDG_CONFIG_HOME: path.join(space.dir, "config"),
        XDG_CACHE_HOME: `/tmp/spaces/${space.id}/cache`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    space.child = child
    child.on("error", (err) => {
      // Spawn failure (e.g. ENGINE_BIN missing) — record it, never crash the
      // whole server for one space's engine.
      space.lastError = String((err && err.message) || err)
      space.ready = false
      space.starting = false
      space.child = null
      log(`[space ${space.id.slice(0, 8)}] engine spawn error: ${space.lastError}`)
    })

    let sawPassword = false
    const onLine = (line) => {
      // Example engine output:
      //   server listening on http://127.0.0.1:4399
      //   server password uhgAkr3-...
      const listening = line.match(/server listening on (https?:\/\/\S+)/)
      if (listening) space.url = listening[1]
      const password = line.match(/server password\s+(\S+)/)
      if (password) {
        sawPassword = true
        space.password = password[1]
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
      space.lastError = chunk.toString().slice(0, 4000)
      fs.writeSync(logFile, chunk)
    })

    const markReady = async () => {
      // Poll in cycles; a stuck or slow boot self-heals: after ~45s without
      // readiness the engine is restarted once, and polling continues for up
      // to 10 minutes so a late boot never leaves a stale not-ready flag.
      const deadline = Date.now() + 10 * 60_000
      let restarts = 0
      let cycles = 0
      while (Date.now() < deadline && space.child === child) {
        cycles++
        const up = await pollReady(`${engineBase(space)}/`, 15000, 500)
        if (up) {
          if (!sawPassword && restarts < 2) {
            // A boot that never printed a server password would 401 every API
            // call — useless. Restart the engine and expect the line.
            restarts++
            log(`[space ${space.id.slice(0, 8)}] ready but no password printed — restarting`)
            stopEngineFor(space)
            await engineStoppedFor(space)
            if (space.child === child) startEngineFor(space)
            return // the new child runs its own markReady loop
          }
          space.ready = true
          space.starting = false
          log(`[space ${space.id.slice(0, 8)}] engine ready (password ${sawPassword ? "captured" : "not required"})`)
          return
        }
        if (space.child !== child) return
        if (cycles >= 3 && restarts < 1) {
          restarts++
          log(`[space ${space.id.slice(0, 8)}] not ready after 45s — restarting once`)
          stopEngineFor(space)
          await engineStoppedFor(space)
          if (space.child === child) startEngineFor(space)
          return
        }
      }
      if (space.child === child) {
        space.ready = false
        space.starting = false
        log(`[space ${space.id.slice(0, 8)}] engine did not become ready in time`)
      }
    }
    markReady()

    child.on("exit", (code, signal) => {
      log(`[space ${space.id.slice(0, 8)}] engine exited (code=${code} signal=${signal})`)
      space.ready = false
      space.starting = false
      // Self-heal: an unexpected exit (a crash — no signal) is restarted after
      // a short delay, but only while the space is still in active use.
      // Intentional stops (SIGTERM from the reaper / persist / shutdown) are
      // not restarted here — their callers own the lifecycle.
      if (!signal && Date.now() - space.lastSeen < 5 * 60_000) {
        setTimeout(() => {
          if (space.child === child && (!space.child || space.child.exitCode !== null)) {
            log(`[space ${space.id.slice(0, 8)}] restarting engine after unexpected exit`)
            startEngineFor(space)
          }
        }, 3000)
      }
    })
    return child
  } finally {
    // starting stays true while markReady is pending for the first boot; it
    // is cleared when ready/give-up happens. On early failure, clear it.
    if (!space.child) space.starting = false
  }
}

function stopEngineFor(space) {
  if (space.child && space.child.exitCode === null) {
    log(`[space ${space.id.slice(0, 8)}] stopping engine`)
    space.child.kill("SIGTERM")
  }
}

// Wait until the space's engine child is really gone; SIGKILL after 10s so a
// wedged process can never hang a reaper / persist dump / restore forever.
async function engineStoppedFor(space) {
  const deadline = Date.now() + 10_000
  while (space.child && space.child.exitCode === null && Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 200))
  }
  if (space.child && space.child.exitCode === null) {
    log(`[space ${space.id.slice(0, 8)}] engine did not exit in 10s — SIGKILL`)
    space.child.kill("SIGKILL")
    await new Promise((ok) => setTimeout(ok, 500))
  }
}

// Reaper: stop engines that have had no requests (and no open streams) for
// ENGINE_IDLE_MS, and enforce the MAX_RUNNING RAM guard LRU-style.
setInterval(() => {
  const now = Date.now()
  let running = []
  for (const s of SPACES.values()) {
    if (s.child && s.child.exitCode === null) running.push(s)
    if (
      s.child &&
      s.child.exitCode === null &&
      s.streams === 0 &&
      now - s.lastSeen > ENGINE_IDLE_MS
    ) {
      log(`reaping idle engine (space ${s.id.slice(0, 8)})`)
      stopEngineFor(s)
    }
  }
  running = running.filter((s) => s.child && s.child.exitCode === null)
  if (running.length > MAX_RUNNING) {
    running.sort((a, b) => a.lastSeen - b.lastSeen)
    for (const s of running) {
      if (running.length <= MAX_RUNNING) break
      if (s.streams > 0) continue // do not pull the ground from an open tab
      log(`RAM guard: stopping LRU engine (space ${s.id.slice(0, 8)})`)
      stopEngineFor(s)
      running.splice(running.indexOf(s), 1)
    }
  }
}, 60_000).unref()

// ---------------------------------------------------------------------------
// Engine-state persistence (deploy-time snapshot / restore)
//
// Engine state lives under DATA_DIR (the /data volume: legacy xdg/ plus every
// space's directory). Before deploying, `scripts/persist-snapshot.sh` saves
// it over GET /__persist/dump and restores it after the deploy over POST
// /__persist/restore (all engines are stopped for a consistent snapshot and
// restarted afterwards). Both endpoints require the PERSIST_TOKEN secret.
// ---------------------------------------------------------------------------

const PERSIST_TOKEN = process.env.PERSIST_TOKEN || ""
const PERSIST_DIR = DATA_DIR

function persistAllowed(req) {
  return Boolean(PERSIST_TOKEN) && req.headers["x-persist-token"] === PERSIST_TOKEN
}

async function stopAllEngines() {
  const running = []
  for (const s of SPACES.values()) {
    if (s.child && s.child.exitCode === null) {
      stopEngineFor(s)
      running.push(s)
    }
  }
  await Promise.all(running.map((s) => engineStoppedFor(s)))
  return running
}

async function persistDump(res) {
  const candidates = ["xdg", "spaces"]
  const existing = candidates.filter((d) => fs.existsSync(path.join(PERSIST_DIR, d)))
  try {
    if (existing.length === 0) {
      res.writeHead(200, { "content-type": "application/gzip" })
      return res.end(Buffer.alloc(0))
    }
    const wasRunning = await stopAllEngines()
    try {
      const tmp = path.join(os.tmpdir(), "persist-dump.tgz")
      await new Promise((ok, err) => {
        const tar = spawn(
          "tar",
          [
            "czf", tmp,
            // usage-backups are dead weight from the retired reset endpoint —
            // they ballooned the payload past the ingress body limit once.
            "--exclude=xdg/data/opencode/usage-backups",
            "-C", PERSIST_DIR, ...existing,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        )
        let msg = ""
        tar.stderr.on("data", (c) => (msg += c))
        tar.on("exit", (code) => (code === 0 ? ok() : err(new Error(`tar exit ${code}: ${msg.slice(0, 200)}`))))
        tar.on("error", err)
      })
      for (const s of wasRunning) startEngineFor(s)
      const stream = fs.createReadStream(tmp)
      res.writeHead(200, { "content-type": "application/gzip" })
      stream.pipe(res)
      stream.on("close", () => fs.unlink(tmp, () => {}))
    } catch (err) {
      for (const s of wasRunning) startEngineFor(s)
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
    // Stop the engines BEFORE extracting. Running engines hold their SQLite
    // WALs open; extracting the archive under them and only then restarting
    // let the stale WAL checkpoint right back over the restored databases.
    const wasRunning = await stopAllEngines()
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
    log(`restored engine state (${size} bytes) — restarting engines`)
    for (const s of wasRunning) startEngineFor(s)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ restored: size, enginesRestarted: wasRunning.length }))
  } catch (err) {
    log(`restore failed: ${err.message}`)
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: err.message }))
  }
}

// ---------------------------------------------------------------------------
// Legacy cleanup — the retired local-model (Ollama) setup
//
// The models are gone; free their storage and make sure no engine config
// still carries the dead "ollama" provider (it would show unanswerable
// models in the selector).
// ---------------------------------------------------------------------------

function cleanupLegacyOllama() {
  const cfgFiles = [
    path.join(DATA_DIR, "xdg", "config", "opencode", "opencode.json"),
    path.join(DATA_DIR, "xdg", "config", "opencode", "config.json"),
  ]
  for (const cfgFile of cfgFiles) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"))
      if (cfg && cfg.provider && cfg.provider.ollama) {
        delete cfg.provider.ollama
        if (!Object.keys(cfg.provider).length) delete cfg.provider
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
        log(`legacy config: removed ollama provider from ${cfgFile}`)
      }
    } catch {
      // no config / not JSON — nothing to clean
    }
  }
  for (const dir of ["/var/lib/ollama", "/data/ollama"]) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
        log(`legacy cleanup: removed ${dir}`)
      }
    } catch {
      // best effort
    }
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

function proxyApi(req, res, space) {
  const target = new URL(req.url, engineBase(space))
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  headers.host = `127.0.0.1:${space.port}`
  if (space.password) {
    headers.authorization =
      "Basic " + Buffer.from(`opencode:${space.password}`).toString("base64")
  }

  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: space.port,
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
      withCookie(req, resHeaders)
      res.writeHead(upRes.statusCode || 502, resHeaders)
      upRes.pipe(res) // streams SSE/chunked bodies through untouched
      // A live SSE stream (the UI's event feed) keeps this space's engine on.
      const ctype = String(upRes.headers["content-type"] || "")
      if (ctype.includes("text/event-stream")) {
        space.streams++
        res.on("close", () => (space.streams = Math.max(0, space.streams - 1)))
      }
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

function proxyUpgrade(req, socket, head, space) {
  const target = new URL(req.url, engineBase(space))
  const headers = { ...req.headers }
  headers.host = `127.0.0.1:${space.port}`
  if (space.password) {
    headers.authorization =
      "Basic " + Buffer.from(`opencode:${space.password}`).toString("base64")
  }
  delete headers.connection
  // Reconstruct the request line verbatim; ws handshake requires raw forwarding.
  const lines = [
    `${req.method} ${target.pathname}${target.search} HTTP/1.1`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "\r\n",
  ]
  const upstream = net.connect(space.port, "127.0.0.1", () => {
    upstream.write(lines.join("\r\n"))
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  space.streams++
  upstream.on("error", () => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
  })
  socket.on("error", () => upstream.destroy())
  socket.on("close", () => {
    upstream.destroy()
    space.streams = Math.max(0, space.streams - 1)
  })
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
        res.writeHead(200, withCookie(req, { "content-type": type, "content-length": stat.size }))
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
// Status endpoint (aggregate — never leaks space ids)
// ---------------------------------------------------------------------------

async function serveStatus(req, res) {
  const disk = await dfStatus()
  const spaces = [...SPACES.values()]
  res.writeHead(200, withCookie(req, { "content-type": "application/json; charset=utf-8" }))
  res.end(
    JSON.stringify(
      {
        app: "opencode-web",
        version: "2.4.2",
        os: osInfo(),
        spaces: {
          total: spaces.length,
          enginesRunning: spaces.filter((s) => s.child && s.child.exitCode === null).length,
          enginesReady: spaces.filter((s) => s.ready).length,
          detail: spaces.map((s) => ({
            id: s.id.slice(0, 8),
            ready: s.ready,
            streams: s.streams,
            idleForSec: Math.round((Date.now() - s.lastSeen) / 1000),
            lastError: s.lastError || undefined,
          })),
        },
        disk,
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
// served by the engine itself — it embeds the official web build — through
// the same authenticated proxy.
const STATIC_FROM_ENGINE = !fs.existsSync(path.join(WEB_DIR, "index.html"))

function serveSplash(req, res) {
  res.writeHead(200, withCookie(req, { "content-type": "text/html; charset=utf-8", "retry-after": "2" }))
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2">` +
      `<title>OpenCode Web — starting</title></head>` +
      `<body style="font-family:system-ui;background:#fafafa;color:#333;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center"><h1>OpenCode Web</h1><p>Preparing your private workspace…</p></div></body></html>`,
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
  if (req.url.startsWith("/__status")) return serveStatus(req, res)
  // Everything below is space-scoped: the cookie decides which engine — and
  // therefore which set of sessions — a browser talks to.
  const space = getSpace(req, res)
  if (req.url === "/api" || req.url.startsWith("/api/")) {
    ensureEngine(space)
    if (!space.ready) {
      res.writeHead(503, withCookie(req, { "content-type": "application/json" }))
      return res.end(JSON.stringify({ error: "engine-starting", detail: space.lastError || undefined }))
    }
    return proxyApi(req, res, space)
  }
  if (!space.ready) {
    ensureEngine(space)
    return serveSplash(req, res)
  }
  if (STATIC_FROM_ENGINE) return proxyApi(req, res, space)
  return serveStatic(req, res)
})

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/api/")) {
    return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
  }
  // A WebSocket handshake without a space cookie cannot be paired with the
  // engine the page loaded against — bounce it; the page carries the cookie.
  const id = parseCookies(req.headers.cookie)[SPACE_COOKIE]
  if (!id || !SPACE_ID_RE.test(id) || !SPACES.has(id)) {
    return socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
  }
  const space = SPACES.get(id)
  space.lastSeen = Date.now()
  if (!space.ready) {
    ensureEngine(space)
    return socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
  }
  return proxyUpgrade(req, socket, head, space)
})

async function main() {
  if (!STATIC_FROM_ENGINE && !fs.existsSync(path.join(WEB_DIR, "index.html"))) {
    log(`FATAL: web UI directory not found: ${WEB_DIR}`)
    process.exit(1)
  }
  cleanupLegacyOllama()
  server.listen(PORT, HOST, () => {
    log(`OpenCode Web listening on http://${HOST}:${PORT} (web UI: ${WEB_DIR})`)
    log(`status: http://localhost:${PORT}/__status — each browser gets its own private space`)
  })
}

function shutdown() {
  for (const s of SPACES.values()) stopEngineFor(s)
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

main().catch((err) => {
  log("fatal:", err)
  process.exit(1)
})
