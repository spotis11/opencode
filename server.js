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
 *      space ids, they are a capability);
 *   5. watches /proc/net/tcp for dev servers the agent starts in the sandbox
 *      ("start the dev server" → `npm run dev`), exposes each under
 *      /preview/<port>/ (HTTP + WebSocket/HMR proxy with a Referer fallback
 *      for the previewed app's absolute paths), reports them at /__preview,
 *      and a tiny dashboard script injected into the UI opens a z.ai-style
 *      preview panel automatically.
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
// Dev-server preview (z.ai-style dashboard)
//
// When the agent starts a dev server in the sandbox ("make me a website" →
// `npm run dev`), this shell detects the listening port by watching
// /proc/net/tcp, exposes the app under /preview/<port>/ (HTTP + WebSocket for
// HMR, with a Referer fallback so the previewed app's absolute-path assets
// and API calls keep working behind the prefix), reports the list at
// /__preview, and the injected dashboard script opens the preview panel.
// ---------------------------------------------------------------------------

const PREVIEW_RE = /^\/preview\/(\d{2,5})(\/.*)?$/
const previewServers = new Map() // port -> { port, since, title, http, tries }

function listeningPorts() {
  const ports = new Set()
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 4 || cols[3] !== "0A") continue // 0A = LISTEN
      const local = cols[1]
      const port = parseInt(local.slice(local.lastIndexOf(":") + 1), 16)
      if (Number.isFinite(port) && port >= 1024 && port <= 65535) ports.add(port)
    }
  }
  return ports
}

// Single-shot listener check for a direct preview hit — covers the ≤2s window
// before the periodic scanner registers a freshly started dev server.
function listeningPortOnce(port) {
  return listeningPorts().has(port)
}

// Never proxy our own port (loop) or an engine port (auth boundary) as a
// preview — those are reserved even if something listens on them.
function reservedPreviewPorts() {
  const reserved = new Set([PORT])
  for (const s of SPACES.values()) if (s.port) reserved.add(s.port)
  return reserved
}

// Probe a listening port once: does it speak HTTP (dashboard candidate), and
// what <title> does its index page carry (best-effort)?
async function probeHttp(port) {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 1200)
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal })
    clearTimeout(timer)
    let title = null
    const ctype = r.headers.get("content-type") || ""
    if (ctype.includes("text/html")) {
      try {
        const head = (await r.text()).slice(0, 4000)
        const m = head.match(/<title[^>]*>([^<]{1,80})<\/title>/i)
        if (m) title = m[1].trim()
      } catch {
        // body unreadable — the HTTP response itself is still proof enough
      }
    }
    return { http: true, title }
  } catch {
    return { http: false, title: null }
  }
}

setInterval(() => {
  const reserved = reservedPreviewPorts()
  const seen = new Set()
  for (const port of listeningPorts()) {
    if (reserved.has(port)) continue
    seen.add(port)
    const entry = previewServers.get(port)
    if (!entry) {
      previewServers.set(port, { port, since: Date.now(), title: null, http: false, tries: 0 })
      log(`preview: server detected on :${port}`)
    } else if (!entry.http && entry.tries < 30) {
      // Not confirmed as HTTP yet (still compiling, or a non-HTTP service) —
      // keep probing quietly for up to ~1 minute, then stop trying.
    } else {
      continue
    }
    const e = previewServers.get(port)
    e.tries++
    probeHttp(port).then((r) => {
      const s = previewServers.get(port)
      if (!s) return
      s.http = s.http || r.http
      s.title = r.title || s.title
      if (r.http && !s.announced) {
        s.announced = true
        log(`preview: dashboard live at /preview/${port}/${s.title ? ` (${s.title})` : ""}`)
      }
    })
  }
  for (const port of [...previewServers.keys()]) {
    if (!seen.has(port)) {
      previewServers.delete(port)
      log(`preview: server on :${port} stopped`)
    }
  }
}, 2000).unref()

// A request belongs to a preview when it is under /preview/<port>/ directly,
// or when its Referer points there — absolute-path assets, fetches and HMR
// websockets of the previewed app land on our origin and must be forwarded
// to the dev server they came from.
function previewTarget(req, urlPath) {
  const direct = urlPath.match(PREVIEW_RE)
  if (direct) return { port: Number(direct[1]), sub: direct[2] || "/" }
  const ref = String(req.headers.referer || req.headers.referrer || "")
  const rm = ref.match(/\/preview\/(\d{2,5})(\/|$)/)
  if (rm) {
    const u = new URL(req.url, "http://x")
    return { port: Number(rm[1]), sub: u.pathname + u.search }
  }
  return null
}

function proxyPreview(req, res, port, sub) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  headers.host = `127.0.0.1:${port}`
  const upstream = http.request(
    { hostname: "127.0.0.1", port, path: sub, method: req.method, headers },
    (upRes) => {
      const resHeaders = {}
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue
        resHeaders[name] = value
      }
      res.writeHead(upRes.statusCode || 502, resHeaders)
      upRes.pipe(res)
    },
  )
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
    res.end(`preview :${port} not responding (${String((err && err.message) || err)})`)
  })
  req.pipe(upstream)
  req.on("aborted", () => upstream.destroy())
}

// WebSocket upgrades for the preview (Vite/Next HMR and friends).
function proxyPreviewUpgrade(req, socket, head, port, sub) {
  const headers = { ...req.headers }
  headers.host = `127.0.0.1:${port}`
  delete headers.connection
  const lines = [
    `${req.method} ${sub} HTTP/1.1`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "\r\n",
  ]
  const upstream = net.connect(port, "127.0.0.1", () => {
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
// Dashboard panel — a tiny script injected into the app's index.html
//
// Polls /__preview; when the agent's dev server shows up it pops a z.ai-style
// panel on the right: dark toolbar (URL, copy, refresh, device width toggle,
// open-in-new-tab, close) with the live app in an iframe below. Stays out of
// the way until a server is detected.
// ---------------------------------------------------------------------------

const PREVIEW_PANEL_CSS = `
#ocp-pill{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:10px 15px;border-radius:999px;background:#171717;color:#e7e7e7;font:500 13px/1 system-ui,-apple-system,sans-serif;border:1px solid #2e2e2e;box-shadow:0 6px 24px rgba(0,0,0,.45);cursor:pointer;user-select:none}
#ocp-pill:hover{background:#202020}
.ocp-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:ocp-pulse 1.6s infinite}
@keyframes ocp-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.ocp-off{display:none!important}
#ocp-drawer{position:fixed;top:0;right:0;height:100vh;width:min(560px,62vw);background:#111;border-left:1px solid #2a2a2a;z-index:2147483001;transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column}
#ocp-drawer.ocp-on{transform:none}
.ocp-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1a1a1a;border-bottom:1px solid #2a2a2a;flex-wrap:wrap}
.ocp-chips{display:flex;gap:6px;max-width:40%}
.ocp-chip{padding:4px 10px;border-radius:8px;background:#262626;color:#d4d4d4;font:500 12px system-ui;cursor:pointer;border:1px solid transparent;white-space:nowrap;overflow:hidden;max-width:140px;text-overflow:ellipsis}
.ocp-chip.ocp-act{background:#0f0f0f;color:#fff;border-color:#3f3f3f}
.ocp-url{flex:1;min-width:120px;color:#a3a3a3;font:12px ui-monospace,SFMono-Regular,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.ocp-actions{display:flex;gap:2px}
.ocp-btn{width:30px;height:30px;border-radius:8px;border:0;background:transparent;color:#d4d4d4;font-size:15px;cursor:pointer;display:grid;place-items:center;padding:0}
.ocp-btn:hover{background:#2a2a2a;color:#fff}
.ocp-frame{flex:1;display:flex;justify-content:center;background:#0c0c0c;overflow:hidden}
.ocp-frame iframe{width:100%;height:100%;border:0;background:#fff}
.ocp-frame.ocp-narrow iframe{max-width:420px;box-shadow:0 0 0 1px #2a2a2a}
.ocp-msg{display:none;flex:1;align-items:center;justify-content:center;color:#8a8a8a;font:14px system-ui;padding:24px;text-align:center}
@media(max-width:640px){#ocp-drawer{width:100vw}}
`

const PREVIEW_PANEL_JS = `(function () {
  "use strict"
  var st = { servers: [], active: null, open: false, wide: true, lastCount: 0, dismissed: 0 }
  var pill, drawer, chips, urlText, frameHost, iframe, msg
  function h(tag, cls, txt) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (txt != null) e.textContent = txt
    return e
  }
  function btn(glyph, title, fn) {
    var b = h("button", "ocp-btn", glyph)
    b.title = title
    b.setAttribute("aria-label", title)
    b.addEventListener("click", fn)
    return b
  }
  function activeServer() {
    for (var i = 0; i < st.servers.length; i++) if (st.servers[i].port === st.active) return st.servers[i]
    var best = null
    for (var j = 0; j < st.servers.length; j++) {
      if (!best || (st.servers[j].since || 0) > (best.since || 0)) best = st.servers[j]
    }
    return best
  }
  function activeUrl() {
    var s = activeServer()
    return s ? location.origin + "/preview/" + s.port + "/" : null
  }
  function build() {
    var style = h("style")
    style.id = "ocp-style"
    style.textContent = ${JSON.stringify(PREVIEW_PANEL_CSS)}
    document.head.appendChild(style)
    pill = h("div")
    pill.id = "ocp-pill"
    pill.className = "ocp-off"
    pill.appendChild(h("span", "ocp-dot"))
    pill.appendChild(h("span", "", "Dashboard"))
    pill.addEventListener("click", function () { show(true) })
    drawer = h("div")
    drawer.id = "ocp-drawer"
    var bar = h("div", "ocp-bar")
    chips = h("div", "ocp-chips")
    urlText = h("span", "ocp-url", "")
    urlText.title = "Open in new tab"
    urlText.addEventListener("click", function () { var u = activeUrl(); if (u) window.open(u, "_blank") })
    var actions = h("div", "ocp-actions")
    actions.appendChild(btn("\\u29c9", "Copy preview URL", function () {
      var u = activeUrl()
      if (u && navigator.clipboard) navigator.clipboard.writeText(u).catch(function () {})
    }))
    actions.appendChild(btn("\\u27f3", "Refresh preview", function () {
      try { iframe.contentWindow.location.reload() } catch (e) { if (iframe) iframe.src = iframe.src }
    }))
    actions.appendChild(btn("\\u25ad", "Toggle device width", function () {
      st.wide = !st.wide
      frameHost.classList.toggle("ocp-narrow", !st.wide)
    }))
    actions.appendChild(btn("\\u2197", "Open in new tab", function () {
      var u = activeUrl(); if (u) window.open(u, "_blank")
    }))
    actions.appendChild(btn("\\u2715", "Close dashboard", function () {
      show(false); st.dismissed = Date.now()
    }))
    bar.appendChild(chips); bar.appendChild(urlText); bar.appendChild(actions)
    frameHost = h("div", "ocp-frame")
    msg = h("div", "ocp-msg", "Dev server stopped \\u2014 ask the agent to start it again.")
    drawer.appendChild(bar); drawer.appendChild(frameHost); drawer.appendChild(msg)
    document.body.appendChild(pill)
    document.body.appendChild(drawer)
  }
  function show(v) {
    st.open = v
    drawer.classList.toggle("ocp-on", v)
    pill.classList.toggle("ocp-off", v)
    if (v) ensureFrame()
  }
  function ensureFrame() {
    var s = activeServer()
    if (!s) return
    if (!iframe) {
      iframe = h("iframe")
      iframe.setAttribute("allow", "forms; clipboard-write; fullscreen")
      frameHost.appendChild(iframe)
      iframe.dataset.port = ""
    }
    if (iframe.dataset.port !== String(s.port)) {
      iframe.dataset.port = String(s.port)
      iframe.src = location.origin + "/preview/" + s.port + "/"
    }
  }
  function render() {
    if (!drawer) build()
    var s = activeServer()
    var url = s ? location.origin + "/preview/" + s.port + "/" : null
    while (chips.firstChild) chips.removeChild(chips.firstChild)
    for (var i = 0; i < st.servers.length; i++) {
      (function (srv) {
        var c = h("button", "ocp-chip" + (s && srv.port === s.port ? " ocp-act" : ""), ":" + srv.port)
        if (srv.title) c.title = srv.title
        c.addEventListener("click", function () { st.active = srv.port; ensureFrame(); render() })
        chips.appendChild(c)
      })(st.servers[i])
    }
    urlText.textContent = url || "no dev server"
    if (!s) {
      frameHost.classList.add("ocp-off")
      msg.classList.remove("ocp-off")
      msg.style.display = "flex"
      iframe = null
      frameHost.innerHTML = ""
    } else {
      msg.style.display = "none"
      frameHost.classList.remove("ocp-off")
      msg.classList.add("ocp-off")
      if (st.open) ensureFrame()
    }
    pill.classList.toggle("ocp-off", st.open || !st.servers.length)
    if (st.servers.length && !st.open && st.lastCount === 0 && Date.now() - st.dismissed > 1500) show(true)
    st.lastCount = st.servers.length
  }
  function poll() {
    fetch("/__preview", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { servers: [] } })
      .then(function (d) { st.servers = (d && d.servers) || []; render() })
      .catch(function () {})
  }
  if (document.getElementById("ocp-style")) return
  poll()
  setInterval(poll, 2500)
})()`

// ---------------------------------------------------------------------------
// Static web UI (the renderer built from source)
// ---------------------------------------------------------------------------

// The app shell gets the dashboard panel script injected (dev-server preview).
let injectedIndexCache = null
function injectedIndex() {
  if (injectedIndexCache) return injectedIndexCache
  try {
    const raw = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8")
    const out = raw.includes("__preview_panel.js")
      ? raw
      : raw.replace(/<\/body>/i, `<script src="/__preview_panel.js" defer></script></body>`)
    injectedIndexCache = Buffer.from(out)
    return injectedIndexCache
  } catch {
    return null
  }
}

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
        if (candidate === path.join(WEB_DIR, "index.html")) {
          const injected = injectedIndex()
          if (injected) {
            res.writeHead(
              200,
              withCookie(req, { "content-type": MIME[".html"], "content-length": injected.length, "cache-control": "no-cache" }),
            )
            return res.end(injected)
          }
        }
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
        preview: [...previewServers.values()]
          .filter((s) => s.http)
          .sort((a, b) => a.port - b.port)
          .map((s) => ({ port: s.port, url: `/preview/${s.port}/`, title: s.title || undefined })),
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
  if (req.url === "/__preview") {
    const servers = [...previewServers.values()]
      .filter((s) => s.http)
      .sort((a, b) => a.port - b.port)
      .map((s) => ({ port: s.port, url: `/preview/${s.port}/`, title: s.title || undefined, since: s.since }))
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
    return res.end(JSON.stringify({ servers }))
  }
  if (req.url === "/__preview_panel.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
    return res.end(PREVIEW_PANEL_JS)
  }
  // Dev-server preview: direct /preview/<port>/... or any request whose
  // Referer points at one (the previewed app's absolute-path assets, XHRs and
  // HMR sockets). Reserved ports (ourselves, engines) are never proxied.
  const pTarget = previewTarget(req, req.url)
  if (pTarget) {
    if (reservedPreviewPorts().has(pTarget.port)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
      return res.end("Forbidden preview port")
    }
    if (previewServers.has(pTarget.port) || listeningPortOnce(pTarget.port)) {
      return proxyPreview(req, res, pTarget.port, pTarget.sub)
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
    return res.end(`No dev server on :${pTarget.port} — ask the agent to start one.`)
  }
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
  // Preview websockets first (HMR), same direct/Referer rules as HTTP.
  const pTarget = previewTarget(req, req.url)
  if (pTarget && !reservedPreviewPorts().has(pTarget.port)) {
    return proxyPreviewUpgrade(req, socket, head, pTarget.port, pTarget.sub)
  }
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
