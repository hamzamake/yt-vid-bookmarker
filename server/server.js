// Bookmark server for the YouTube Timestamp Bookmarker extension.
//
// The extension sends its full list of bookmarks here (when syncing is turned
// on in its Settings), and the website shows them. Everything needs the
// passkey: the website asks for it once and remembers you with a cookie, the
// extension sends it with every request.
//
//   node server.js                    start (makes up a passkey on first run)
//   node server.js --passkey <key>    set your own passkey, then start
//   node server.js --port 8080        use another port (default 3007, or $PORT)
//
// No dependencies, just Node 18+.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CONFIG_FILE = path.join(__dirname, "config.json");
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const COOKIE = "ytb_session";
const SESSION_DAYS = 30;
const MAX_BODY = 5 * 1024 * 1024;
const MAX_FAILURES = 10;              // wrong passkeys allowed per IP...
const FAILURE_WINDOW_MS = 15 * 60_000; // ...in this long

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/icon.png": ["icon.png", "image/png"],
};

// ---- Settings ----

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`Could not read ${path.basename(file)}:`, err.message);
    return fallback;
  }
}

// Write to a temp file first so a crash never leaves a half-written file.
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function hashPasskey(passkey, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(passkey, salt, 32).toString("hex")}`;
}

function checkPasskey(passkey) {
  if (typeof passkey !== "string" || !passkey) return false;
  const [salt, hash] = config.passkeyHash.split(":");
  const given = crypto.scryptSync(passkey, salt, 32);
  return crypto.timingSafeEqual(given, Buffer.from(hash, "hex"));
}

// Easy to read and type: no 0/o, 1/l/i.
function makePasskey() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const group = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join("");
  return [group(), group(), group(), group()].join("-");
}

// A new passkey also gets a new session secret, which logs out every browser.
function setPasskey(passkey) {
  config.passkeyHash = hashPasskey(passkey);
  config.secret = crypto.randomBytes(32).toString("hex");
  writeJson(CONFIG_FILE, config);
}

const config = readJson(CONFIG_FILE, {});
const newPasskey = arg("--passkey");
if (newPasskey !== undefined) {
  if (newPasskey.length < 8) {
    console.error("The passkey must be at least 8 characters.");
    process.exit(1);
  }
  setPasskey(newPasskey);
  console.log("Passkey changed. Update it in the extension's Settings too.");
} else if (!config.passkeyHash) {
  const passkey = makePasskey();
  setPasskey(passkey);
  console.log("\n  Your passkey (shown only once, write it down):\n");
  console.log(`      ${passkey}\n`);
  console.log("  Change it any time with: node server.js --passkey <your passkey>\n");
}

let data = readJson(DATA_FILE, { bookmarks: [], syncedAt: null });
// Changes made on the website that the extension hasn't picked up yet:
// id -> { at, bookmark } (added or time changed) or { at, deleted: true }.
data.edits = Object.fromEntries(Object.entries(data.edits || {})
  .filter(([, e]) => Number.isFinite(e.at) && (e.deleted || e.bookmark)));

// ---- Login ----

const failures = new Map(); // ip -> { count, resetAt }

function lockedOut(ip) {
  const f = failures.get(ip);
  if (f && Date.now() > f.resetAt) failures.delete(ip);
  return (failures.get(ip)?.count || 0) >= MAX_FAILURES;
}

function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, resetAt: Date.now() + FAILURE_WINDOW_MS };
  f.count++;
  failures.set(ip, f);
}

function sign(value) {
  return crypto.createHmac("sha256", config.secret).update(value).digest("base64url");
}

function makeSession() {
  const expires = String(Date.now() + SESSION_DAYS * 86_400_000);
  return `${expires}.${sign(expires)}`;
}

function validSession(token) {
  const [expires, sig] = (token || "").split(".");
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(expires));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => {
    const i = c.indexOf("=");
    return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
}

function isHttps(req) {
  return req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
}

// Behind a Cloudflare tunnel every request arrives from this machine, so one
// stranger guessing passkeys would lock everyone out. Trust Cloudflare's header
// only on local connections, which outsiders can't make.
function clientIp(req) {
  const ip = req.socket.remoteAddress;
  const local = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  return local && req.headers["cf-connecting-ip"] ? req.headers["cf-connecting-ip"] : ip;
}

function sessionCookie(req, value, maxAge) {
  return [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`,
          ...(isHttps(req) ? ["Secure"] : [])].join("; ");
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}

// ---- Bookmarks ----

// Only keep the fields the website needs, in the shape it expects.
function cleanBookmark(b) {
  if (!b || typeof b !== "object" || typeof b.id !== "string" || !/^[\w-]{1,32}$/.test(b.id)) return null;
  const num = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  return {
    id: b.id,
    title: typeof b.title === "string" ? b.title.slice(0, 500) : "YouTube video",
    time: num(b.time),
    duration: num(b.duration),
    updatedAt: num(b.updatedAt),
  };
}

// The video id in a YouTube link (watch, youtu.be, shorts, live, embed, or
// just the id itself).
function videoIdFrom(text) {
  text = String(text || "").trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") id = url.pathname.slice(1);
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = url.searchParams.get("v") || (/^\/(shorts|live|embed|v)\/([^/]+)/.exec(url.pathname) || [])[2];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

// "1h2m3s", "90s", "90" or "1:30" from a link's ?t=.
function linkTime(text) {
  const t = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).searchParams.get("t") || "";
  if (/^\d+s?$/.test(t)) return parseInt(t, 10);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m && t ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

// The video's title from YouTube, or null if YouTube says it doesn't exist.
// Private and age-restricted videos (or YouTube being unreachable) still get
// added, just with a placeholder title until the extension sees the real one.
async function videoTitle(id) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
                            { signal: AbortSignal.timeout(5_000) });
    if (res.status === 400 || res.status === 404) return null;
    const body = res.ok ? await res.json() : {};
    return typeof body.title === "string" ? body.title : "YouTube video";
  } catch {
    return "YouTube video";
  }
}

// The video's length in seconds from its YouTube page, or 0 if that doesn't
// work (e.g. YouTube shows a cookie consent page instead).
async function videoDuration(id) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${id}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" },
      signal: AbortSignal.timeout(10_000),
    });
    const m = /"videoDetails":\{[^}]*?"lengthSeconds":"(\d+)"/.exec(await res.text());
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

// Videos added on the website start without a length. Look them up in the
// background (each one once per run, so a video YouTube won't tell us about
// isn't fetched over and over).
const durationTried = new Set();
async function fillDurations() {
  for (const b of data.bookmarks) {
    if (b.duration || durationTried.has(b.id)) continue;
    durationTried.add(b.id);
    const duration = await videoDuration(b.id);
    const current = data.bookmarks.find((x) => x.id === b.id); // data may have been replaced meanwhile
    if (!duration || !current || current.duration) continue;
    current.duration = duration;
    const edit = data.edits[b.id];
    if (edit?.bookmark && !edit.bookmark.duration) edit.bookmark.duration = duration;
    writeJson(DATA_FILE, data);
  }
}

// Remember a change made on the website so the extension can pick it up.
function recordEdit(id, edit) {
  data.edits[id] = { at: Date.now(), ...edit };
  writeJson(DATA_FILE, data);
}

// Other sites can't send JSON here without the browser asking first (CORS),
// so they can't use your cookie to change bookmarks.
function requireJson(req) {
  if (!/^application\/json\b/.test(req.headers["content-type"] || "")) {
    throw Object.assign(new Error("Expected JSON"), { status: 415 });
  }
}

// ---- HTTP ----

function send(res, status, body, headers = {}) {
  const json = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Too large"), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("Bad JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const ip = clientIp(req);
  const route = `${req.method} ${url.pathname}`;

  // Website files
  if (req.method === "GET" && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), { "Content-Type": type });
  }
  if (!url.pathname.startsWith("/api/")) return send(res, 404, "Not found");

  // Who's asking: the website (cookie) or the extension (passkey header).
  const key = bearer(req);
  let authed = validSession(cookies(req)[COOKIE]);
  if (key !== null) {
    if (lockedOut(ip)) return send(res, 429, { error: "Too many wrong passkeys, try again later" });
    authed = checkPasskey(key);
    if (!authed) {
      recordFailure(ip);
      return send(res, 401, { error: "Wrong passkey" });
    }
  }

  switch (route) {
    case "GET /api/session":
      return send(res, 200, { authed });

    case "POST /api/login": {
      if (lockedOut(ip)) return send(res, 429, { error: "Too many wrong passkeys, try again in 15 minutes" });
      const { passkey } = await readBody(req);
      if (!checkPasskey(passkey)) {
        recordFailure(ip);
        return send(res, 401, { error: "Wrong passkey" });
      }
      failures.delete(ip);
      return send(res, 200, { ok: true }, {
        "Set-Cookie": sessionCookie(req, makeSession(), SESSION_DAYS * 86_400),
      });
    }

    case "POST /api/logout":
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  if (!authed) return send(res, 401, { error: "Passkey needed" });

  switch (route) {
    // The extension's "Test connection" button.
    case "GET /api/ping":
      return send(res, 200, { ok: true, count: data.bookmarks.length });

    case "GET /api/bookmarks":
      return send(res, 200, data);

    // The extension replaces the whole list each time, so the server always
    // matches it exactly (removed bookmarks disappear here too). Only the
    // extension can do this, never the website's cookie.
    case "PUT /api/bookmarks": {
      if (key === null) return send(res, 403, { error: "Only the extension can update bookmarks" });
      const body = await readBody(req);
      if (!Array.isArray(body.bookmarks)) return send(res, 400, { error: "Expected a list of bookmarks" });
      const incoming = new Map(body.bookmarks.map(cleanBookmark).filter(Boolean).map((b) => [b.id, b]));
      // Keep a length looked up here for a video the extension hasn't watched yet.
      for (const old of data.bookmarks) {
        const b = incoming.get(old.id);
        if (b && !b.duration && old.duration) b.duration = old.duration;
      }
      // The extension lists the website changes it has handled. Until it has,
      // they win over its copy, so its uploads can't undo them.
      const applied = body.applied && typeof body.applied === "object" ? body.applied : {};
      const edits = {};
      for (const [id, edit] of Object.entries(data.edits)) {
        if (applied[id] >= edit.at) continue;
        edits[id] = edit;
        if (edit.deleted) incoming.delete(id);
        else incoming.set(id, { ...(incoming.get(id) || edit.bookmark), time: edit.bookmark.time, updatedAt: edit.at });
      }
      data = { bookmarks: [...incoming.values()], edits, syncedAt: Date.now() };
      writeJson(DATA_FILE, data);
      fillDurations();
      return send(res, 200, { ok: true, count: data.bookmarks.length });
    }

    // The website's own changes. Each one is saved here right away and the
    // extension fetches it on its next sync (see "edits" above).

    // Add a video from a link (or set its time if it's already bookmarked).
    case "POST /api/bookmarks": {
      requireJson(req);
      const { url, time } = await readBody(req);
      const id = videoIdFrom(url);
      if (!id) return send(res, 400, { error: "That isn't a YouTube video link" });
      const start = time == null ? linkTime(url) : time;
      if (!Number.isFinite(start) || start < 0) return send(res, 400, { error: "Expected a time in seconds" });
      let b = data.bookmarks.find((x) => x.id === id);
      if (!b) {
        const [title, duration] = await Promise.all([videoTitle(id), videoDuration(id)]);
        if (title === null) return send(res, 404, { error: "YouTube can't find that video" });
        b = { id, title: title.slice(0, 500), time: 0, duration };
        data.bookmarks.push(b);
      }
      b.time = Math.floor(b.duration ? Math.min(start, b.duration) : start);
      b.updatedAt = Date.now();
      recordEdit(id, { at: b.updatedAt, bookmark: { ...b } });
      return send(res, 200, { ok: true, bookmark: b });
    }

    // Change a bookmark's time.
    case "PATCH /api/bookmarks": {
      requireJson(req);
      const { id, time } = await readBody(req);
      const b = data.bookmarks.find((x) => x.id === id);
      if (!b) return send(res, 404, { error: "That bookmark is gone (the video was finished or removed)" });
      if (!Number.isFinite(time) || time < 0) return send(res, 400, { error: "Expected a time in seconds" });
      b.time = Math.floor(b.duration ? Math.min(time, b.duration) : time);
      b.updatedAt = Date.now();
      recordEdit(id, { at: b.updatedAt, bookmark: { ...b } });
      return send(res, 200, { ok: true, bookmark: b });
    }

    case "DELETE /api/bookmarks": {
      requireJson(req);
      const { id } = await readBody(req);
      if (typeof id !== "string" || !/^[\w-]{1,32}$/.test(id)) return send(res, 400, { error: "Expected a bookmark id" });
      data.bookmarks = data.bookmarks.filter((x) => x.id !== id);
      recordEdit(id, { deleted: true });
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; img-src 'self' https://i.ytimg.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    await handle(req, res);
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : "Server error" });
  }
});

const port = Number(arg("--port") || process.env.PORT || 3007);
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`Port ${port} is already being used by another program (or this server is already running).`);
  console.error(`Pick another one, e.g.: node server.js --port ${port + 1}`);
  process.exit(1);
});
server.listen(port, () => {
  fillDurations();
  console.log(`Bookmark server running at http://localhost:${port}`);
  console.log(`Put this link in the extension's Settings (or this computer's IP / your domain instead of localhost).`);
});
