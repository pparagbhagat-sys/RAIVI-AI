// RAIVI - Reporting AI with Voice Integration
// Local server: serves the web app, keeps the API key on the server,
// and stores complaints in a local SQLite database (data/raivi.db).
//
// Run:   set GNANI_API_KEY and STAFF_PASSWORD, then node server.js
// Open:  http://localhost:3000        (citizens)
//        http://localhost:3000/staff  (department staff login)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

// Load local secrets from an ignored .env file for development. Real process
// environment variables take precedence; deployed hosts should set these there.
function loadLocalEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnv(path.join(__dirname, ".env"));

const PORT = process.env.PORT || 3000;
const API_KEY = String(process.env.GNANI_API_KEY || "").trim();
const STAFF_PASSWORD = String(process.env.STAFF_PASSWORD || "");

const STT_URL = "https://api.vachana.ai/stt/v3";
const TTS_URL = "https://api.vachana.ai/api/v1/tts/inference";

const CITY = "Nagpur";
const STATUSES = ["Received", "Routed", "In Progress", "Resolved"];
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const STAFF_SESSION_COOKIE = "raivi_staff_session";
const STAFF_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const staffSessions = new Map();
const loginAttempts = new Map();

if (!API_KEY) {
  console.error("Set GNANI_API_KEY in the environment before starting RAIVI. Do not put API keys in source files.");
  process.exit(1);
}
if (STAFF_PASSWORD.length < 12) {
  console.error("Set STAFF_PASSWORD to a unique password of at least 12 characters before starting RAIVI.");
  process.exit(1);
}

// ---------- Sample department directory (Nagpur) ----------
// These are SAMPLE routings. Each must be checked against the official
// source before RAIVI is used for real complaints.
const DIRECTORY = {
  Road: "Public Works / Nagpur Municipal Corporation (road ownership to be confirmed)",
  Water: "Nagpur Municipal Corporation - Water Supply",
  Garbage: "Nagpur Municipal Corporation - Solid Waste Management",
  Streetlight: "Nagpur Municipal Corporation - Street Lighting",
  Electricity: "MSEDCL - Electricity Distribution",
  General: "Manual review (no department matched)",
};

const CATEGORY_RULES = [
  { name: "Water", words: ["water", "paani", "pani", "पानी", "नल"] },
  { name: "Garbage", words: ["garbage", "kachra", "safai", "dustbin", "कचरा", "सफाई"] },
  { name: "Electricity", words: ["electricity", "bijli", "power cut", "बिजली"] },
  { name: "Streetlight", words: ["streetlight", "street light", "street lamp", "bulb", "बत्ती"] },
  { name: "Road", words: ["road", "pothole", "gaddha", "gadda", "सड़क", "गड्ढा", "गड्ढे"] },
];

function classify(text) {
  const lower = text.toLowerCase();
  const rule = CATEGORY_RULES.find((r) => r.words.some((w) => lower.includes(w.toLowerCase())));
  return rule ? rule.name : "General";
}

// ---------- Database ----------
const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(dataDir, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "raivi.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    city TEXT NOT NULL,
    transcript TEXT NOT NULL,
    complainant_name TEXT,
    category TEXT NOT NULL,
    department TEXT NOT NULL,
    location_lat REAL,
    location_lng REAL,
    location_text TEXT,
    photo_file TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    at TEXT NOT NULL
  );
`);

// Existing local databases may predate manual text locations.
const reportColumns = db.prepare("PRAGMA table_info(reports)").all().map((column) => column.name);
if (!reportColumns.includes("location_text")) db.exec("ALTER TABLE reports ADD COLUMN location_text TEXT");
if (!reportColumns.includes("complainant_name")) db.exec("ALTER TABLE reports ADD COLUMN complainant_name TEXT");

function getRow(id) {
  return db.prepare("SELECT * FROM reports WHERE id = ?").get(id);
}

function logStatus(id, status, note, at) {
  db.prepare("INSERT INTO status_log (report_id, status, note, at) VALUES (?, ?, ?, ?)")
    .run(id, status, note || null, at);
}

function reportToJson(row, withHistory, includeStaffDetails = false) {
  const report = {
    id: row.id,
    city: row.city,
    created_at: row.created_at,
    updated_at: row.updated_at,
    transcript: row.transcript,
    category: row.category,
    department: row.department,
    status: row.status,
    photo_url: row.photo_file ? `/uploads/${row.photo_file}` : null,
  };
  if (includeStaffDetails) {
    report.complainant_name = row.complainant_name || null;
    report.location = row.location_lat == null ? null : { lat: row.location_lat, lng: row.location_lng };
    report.location_text = row.location_text || null;
  }
  if (withHistory) {
    report.history = db
      .prepare("SELECT status, note, at FROM status_log WHERE report_id = ? ORDER BY id")
      .all(row.id);
  }
  return report;
}

function newReportId() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `RV-${day}-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
}

function savePhoto(id, dataUrl) {
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_PHOTO_BYTES) return null;
  const file = `${id}.${match[1] === "png" ? "png" : "jpg"}`;
  fs.writeFileSync(path.join(uploadDir, file), bytes);
  return file;
}

// ---------- HTTP helpers ----------
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) return reject(httpError(413, "The upload is too large."));
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit = MAX_JSON_BYTES) {
  const raw = (await readBody(req, limit)).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function sendStatic(res, file, type) {
  if (type.startsWith("text/html")) {
    const nonce = crypto.randomBytes(18).toString("base64");
    const html = fs.readFileSync(path.join(__dirname, file), "utf8")
      .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.end(html);
    return;
  }
  res.writeHead(200, { "Content-Type": type });
  res.end(fs.readFileSync(path.join(__dirname, file)));
}

function sendUpload(res, name) {
  const safe = path.basename(name);
  if (![".jpg", ".jpeg", ".png"].includes(path.extname(safe).toLowerCase())) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const file = path.join(uploadDir, safe);
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": safe.endsWith(".png") ? "image/png" : "image/jpeg" });
  res.end(fs.readFileSync(file));
}

function isStaff(req) {
  const cookies = String(req.headers.cookie || "").split(";");
  const entry = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${STAFF_SESSION_COOKIE}=`));
  if (!entry) return false;
  const token = entry.slice(STAFF_SESSION_COOKIE.length + 1);
  const expiry = staffSessions.get(token);
  if (!expiry || expiry <= Date.now()) {
    staffSessions.delete(token);
    return false;
  }
  return true;
}

function safeEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function cookieOptions(req, maxAge) {
  const secure = process.env.NODE_ENV === "production" || Boolean(req.socket.encrypted);
  return `${STAFF_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

async function staffLogin(req, res) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let attempts = loginAttempts.get(ip);
  if (attempts?.lockedUntil > now) return sendJson(res, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
  if (!attempts || now - attempts.startedAt > LOGIN_WINDOW_MS) {
    attempts = { count: 0, startedAt: now, lockedUntil: 0 };
    loginAttempts.set(ip, attempts);
  }

  const body = await readJson(req, 8 * 1024);
  if (!safeEqual(body.password || "", STAFF_PASSWORD)) {
    attempts.count += 1;
    if (attempts.count >= MAX_LOGIN_ATTEMPTS) attempts.lockedUntil = now + LOGIN_WINDOW_MS;
    return sendJson(res, attempts.lockedUntil ? 429 : 401, {
      error: attempts.lockedUntil ? "Too many sign-in attempts. Try again in 15 minutes." : "Incorrect staff password.",
    });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("base64url");
  staffSessions.set(token, now + STAFF_SESSION_TTL_MS);
  const secure = process.env.NODE_ENV === "production" || Boolean(req.socket.encrypted);
  res.setHeader("Set-Cookie", `${STAFF_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(STAFF_SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`);
  return sendJson(res, 200, { success: true });
}

function staffLogout(req, res) {
  const cookies = String(req.headers.cookie || "").split(";");
  const entry = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${STAFF_SESSION_COOKIE}=`));
  if (entry) staffSessions.delete(entry.slice(STAFF_SESSION_COOKIE.length + 1));
  res.setHeader("Set-Cookie", cookieOptions(req, 0));
  return sendJson(res, 200, { success: true });
}

// ---------- Voice (Gnani) ----------
async function transcribe(req, res) {
  const audio = await readBody(req, MAX_AUDIO_BYTES);
  if (!audio.length) return sendJson(res, 400, { success: false, error: "No audio received." });

  const form = new FormData();
  form.append("audio_file", new Blob([audio], { type: "audio/wav" }), "recording.wav");
  form.append("model", "prisma-v3.0");
  form.append("language_code", "hi-IN");

  const upstream = await fetch(STT_URL, {
    method: "POST",
    headers: { "X-API-Key-ID": API_KEY },
    body: form,
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) console.log(`STT call: HTTP ${upstream.status}`, JSON.stringify(data));
  return sendJson(res, upstream.status, data);
}

async function speak(req, res) {
  const body = await readJson(req, 64 * 1024);
  const text = String(body.text || "").trim().slice(0, 1200);
  if (!text) return sendJson(res, 400, { success: false, error: "No text provided." });

  const upstream = await fetch(TTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key-ID": API_KEY },
    body: JSON.stringify({
      text,
      voice: "Nalini",
      model: "timbre-v2.5",
      language: "hi-IN",
      speed: 1.0,
      audio_config: {
        sample_rate: 24000,
        num_channels: 1,
        sample_width: 2,
        encoding: "linear_pcm",
        container: "wav",
      },
    }),
  });

  if (!upstream.ok) {
    console.log(`TTS call: HTTP ${upstream.status} ${await upstream.text()}`);
    return sendJson(res, upstream.status, { success: false, error: "Speech synthesis failed." });
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { "Content-Type": "audio/wav" });
  res.end(audio);
}

// ---------- Complaints ----------
async function classifyRoute(req, res) {
  const body = await readJson(req);
  const transcript = String(body.transcript || "").trim();
  if (!transcript) throw httpError(400, "A transcript is required.");
  const category = classify(transcript);
  return sendJson(res, 200, { category, department: DIRECTORY[category], directory: DIRECTORY });
}

async function createReport(req, res) {
  const body = await readJson(req);
  const transcript = String(body.transcript || "").trim();
  if (!transcript) throw httpError(400, "A transcript is required.");
  const complainantName = String(body.complainant_name || "").trim().slice(0, 120) || null;

  const category = Object.prototype.hasOwnProperty.call(DIRECTORY, body.category)
    ? body.category
    : classify(transcript);
  const lat = typeof body.lat === "number" ? body.lat : null;
  const lng = typeof body.lng === "number" ? body.lng : null;
  if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180))) {
    throw httpError(400, "GPS location coordinates are invalid.");
  }
  const locationText = String(body.location_text || "").trim().slice(0, 300) || null;

  const id = newReportId();
  const now = new Date().toISOString();

  let photoFile = null;
  if (body.photo) {
    photoFile = savePhoto(id, body.photo);
    if (!photoFile) throw httpError(400, "Photo must be a JPG or PNG under 4 MB.");
  }
  db.prepare(`
    INSERT INTO reports (id, created_at, updated_at, city, transcript, complainant_name, category, department,
                         location_lat, location_lng, location_text, photo_file, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, now, now, CITY, transcript, complainantName, category, DIRECTORY[category], lat, lng, locationText, photoFile, "Routed");

  logStatus(id, "Received", "Voice complaint received", now);
  logStatus(id, "Routed", `Routed to ${DIRECTORY[category]} (sample directory)`, now);

  return sendJson(res, 201, reportToJson(getRow(id), true));
}

function getReport(res, id) {
  const row = getRow(id);
  if (!row) return sendJson(res, 404, { error: "No complaint was found with this ID." });
  return sendJson(res, 200, reportToJson(row, true));
}

function listReports(res) {
  const rows = db.prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT 200").all();
  return sendJson(res, 200, { reports: rows.map((r) => reportToJson(r, true, true)) });
}

async function updateStatus(req, res, id) {
  const body = await readJson(req);
  if (!STATUSES.includes(body.status)) throw httpError(400, "Choose a valid status.");
  if (!getRow(id)) return sendJson(res, 404, { error: "No complaint was found with this ID." });

  const now = new Date().toISOString();
  db.prepare("UPDATE reports SET status = ?, updated_at = ? WHERE id = ?").run(body.status, now, id);
  const note = String(body.note || "").trim() || `Status changed to ${body.status}`;
  logStatus(id, body.status, note, now);

  return sendJson(res, 200, reportToJson(getRow(id), true, true));
}

// ---------- Routing ----------
async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = req.method;

  // Pages and assets
  if (m === "GET" && p === "/") return sendStatic(res, "index.html", "text/html; charset=utf-8");
  if (m === "GET" && p === "/staff") return sendStatic(res, "staff.html", "text/html; charset=utf-8");
  if (m === "GET" && p === "/styles.css") return sendStatic(res, "styles.css", "text/css; charset=utf-8");
  if (m === "GET" && p === "/common.js") return sendStatic(res, "common.js", "application/javascript; charset=utf-8");
  if (m === "GET" && p.startsWith("/uploads/")) return sendUpload(res, p.slice("/uploads/".length));

  // Voice
  if (m === "POST" && p === "/api/transcribe") return transcribe(req, res);
  if (m === "POST" && p === "/api/speak") return speak(req, res);

  // Staff session
  if (m === "POST" && p === "/api/staff/login") return staffLogin(req, res);
  if (m === "POST" && p === "/api/staff/logout") return staffLogout(req, res);

  // Complaints
  if (m === "GET" && p === "/api/directory") return sendJson(res, 200, { directory: DIRECTORY });
  if (m === "POST" && p === "/api/classify") return classifyRoute(req, res);
  if (m === "POST" && p === "/api/reports") return createReport(req, res);

  if (m === "GET" && p === "/api/reports") {
    if (!isStaff(req)) return sendJson(res, 401, { error: "Staff login required." });
    return listReports(res);
  }

  let match = p.match(/^\/api\/reports\/([A-Za-z0-9-]+)$/);
  if (m === "GET" && match) return getReport(res, match[1]);

  match = p.match(/^\/api\/reports\/([A-Za-z0-9-]+)\/status$/);
  if (m === "PATCH" && match) {
    if (!isStaff(req)) return sendJson(res, 401, { error: "Staff login required." });
    return updateStatus(req, res, match[1]);
  }

  sendJson(res, 404, { error: "Not found." });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "microphone=(self), geolocation=(self), camera=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error("Server error:", err);
    if (!res.headersSent) {
      sendJson(res, status, {
        error: err.status ? err.message : "Something went wrong on the server.",
      });
    }
  }
});

server.listen(PORT, () => {
  console.log(`RAIVI is running at http://localhost:${PORT}`);
  console.log(`Staff console: http://localhost:${PORT}/staff`);
});
