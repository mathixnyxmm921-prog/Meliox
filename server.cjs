"use strict";
// Servidor de Meliox: sin dependencias, solo Node.js.
// Uso:  node server.cjs   →  http://localhost:3001

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, "data.json");
const PHONE_RE = /^3\d{9}$/;

// ---------- Base de datos (archivo JSON) ----------
let db = { users: {}, requests: [], messages: [], sessions: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
} catch {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => {}), 200);
}

// ---------- Utilidades ----------
const clients = new Map(); // teléfono -> Set de respuestas SSE

function push(phone, event, data = {}) {
  for (const res of clients.get(phone) || []) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

const pub = (u) => ({ phone: u.phone, name: u.name, photo: u.photo });
const hashPass = (pass, salt) => crypto.scryptSync(pass, salt, 32).toString("hex");

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(Object.assign(new Error("Archivo demasiado grande"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error("Datos inválidos"), { status: 400 })); }
    });
  });
}

function authUser(req, url) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  const phone = token && db.sessions[token];
  return phone ? db.users[phone] || null : null;
}

function newSession(phone) {
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions[token] = phone;
  save();
  return token;
}

const between = (m, a, b) => (m.from === a && m.to === b) || (m.from === b && m.to === a);

function summary(user) {
  const friends = user.friends.flatMap((p) => {
    const f = db.users[p];
    if (!f) return [];
    const msgs = db.messages.filter((m) => between(m, user.phone, p));
    return [{
      ...pub(f),
      last: msgs[msgs.length - 1] || null,
      unread: msgs.filter((m) => m.from === p && !m.read).length,
    }];
  });
  const incoming = db.requests
    .filter((r) => r.to === user.phone)
    .flatMap((r) => (db.users[r.from] ? [pub(db.users[r.from])] : []));
  const outgoing = db.requests.filter((r) => r.from === user.phone).map((r) => r.to);
  return { friends, incoming, outgoing };
}

// ---------- API ----------
async function api(req, res, url, p) {
  const m = req.method;

  if (m === "POST" && p === "/api/register") {
    const { name, phone, password, photo } = await readBody(req);
    const n = String(name || "").trim();
    if (n.length < 2 || n.length > 30) fail(400, "El nombre debe tener entre 2 y 30 letras.");
    if (!PHONE_RE.test(String(phone || ""))) fail(400, "El número debe empezar con 3 y tener exactamente 10 dígitos.");
    if (String(password || "").length < 6) fail(400, "La contraseña debe tener mínimo 6 caracteres.");
    if (typeof photo !== "string" || !photo.startsWith("data:image/") || photo.length > 600_000) {
      fail(400, "Foto no válida.");
    }
    if (db.users[phone]) fail(409, "Ese número ya está registrado.");
    const salt = crypto.randomBytes(16).toString("hex");
    db.users[phone] = { phone, name: n, photo, salt, hash: hashPass(password, salt), friends: [] };
    const token = newSession(phone);
    save();
    return json(res, 200, { token, me: pub(db.users[phone]) });
  }

  if (m === "POST" && p === "/api/login") {
    const { phone, password } = await readBody(req);
    const user = db.users[String(phone || "")];
    if (!user) fail(400, "Número o contraseña incorrectos.");
    const a = Buffer.from(hashPass(String(password || ""), user.salt), "hex");
    const b = Buffer.from(user.hash, "hex");
    if (!crypto.timingSafeEqual(a, b)) fail(400, "Número o contraseña incorrectos.");
    return json(res, 200, { token: newSession(phone), me: pub(user) });
  }

  const user = authUser(req, url);
  if (!user) fail(401, "Sesión no válida.");

  if (m === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\nevent: ready\ndata: {}\n\n");
    if (!clients.has(user.phone)) clients.set(user.phone, new Set());
    clients.get(user.phone).add(res);
    req.on("close", () => clients.get(user.phone)?.delete(res));
    return;
  }

  if (m === "GET" && p === "/api/me") {
    return json(res, 200, { me: pub(user), ...summary(user) });
  }

  if (m === "POST" && p === "/api/profile") {
    const { name, photo } = await readBody(req);
    let newName = user.name;
    let newPhoto = user.photo;
    if (name !== undefined) {
      newName = String(name).trim();
      if (newName.length < 2 || newName.length > 30) fail(400, "El nombre debe tener entre 2 y 30 letras.");
    }
    if (photo !== undefined) {
      if (typeof photo !== "string" || !photo.startsWith("data:image/") || photo.length > 600_000) {
        fail(400, "Foto no válida.");
      }
      newPhoto = photo;
    }
    user.name = newName;
    user.photo = newPhoto;
    save();
    // Avisa a amigos, a quienes tienen una solicitud mía y a mis otras pestañas
    const notify = new Set([
      ...user.friends,
      ...db.requests.filter((r) => r.from === user.phone).map((r) => r.to),
      user.phone,
    ]);
    for (const phone of notify) push(phone, "friends");
    return json(res, 200, { me: pub(user) });
  }

  if (m === "POST" && p === "/api/friends/request") {
    const { phone } = await readBody(req);
    if (!PHONE_RE.test(String(phone || ""))) fail(400, "Número no válido: empieza con 3 y tiene 10 dígitos.");
    if (phone === user.phone) fail(400, "Ese es tu propio número.");
    const target = db.users[phone];
    if (!target) fail(404, "Ese número todavía no está en Meliox.");
    if (user.friends.includes(phone)) fail(409, "Ya son amigos.");
    if (db.requests.some((r) => r.from === user.phone && r.to === phone)) fail(409, "Ya enviaste una solicitud a esta persona.");

    // Si la otra persona ya te había enviado solicitud, se aceptan directo
    const reverse = db.requests.findIndex((r) => r.from === phone && r.to === user.phone);
    if (reverse >= 0) {
      db.requests.splice(reverse, 1);
      user.friends.push(phone);
      target.friends.push(user.phone);
      save();
      push(phone, "friends");
      return json(res, 200, { status: "accepted", name: target.name });
    }
    db.requests.push({ from: user.phone, to: phone });
    save();
    push(phone, "friends");
    return json(res, 200, { status: "sent", name: target.name });
  }

  if (m === "POST" && p === "/api/friends/respond") {
    const { phone, accept } = await readBody(req);
    const i = db.requests.findIndex((r) => r.from === phone && r.to === user.phone);
    if (i < 0) fail(404, "Solicitud no encontrada.");
    db.requests.splice(i, 1);
    if (accept && db.users[phone]) {
      if (!user.friends.includes(phone)) user.friends.push(phone);
      if (!db.users[phone].friends.includes(user.phone)) db.users[phone].friends.push(user.phone);
    }
    save();
    push(phone, "friends");
    return json(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/friends/remove") {
    const { phone } = await readBody(req);
    if (!user.friends.includes(phone)) fail(404, "Esa persona no está en tus amigos.");
    user.friends = user.friends.filter((x) => x !== phone);
    const other = db.users[phone];
    if (other) other.friends = other.friends.filter((x) => x !== user.phone);
    db.requests = db.requests.filter(
      (r) => !((r.from === user.phone && r.to === phone) || (r.from === phone && r.to === user.phone))
    );
    save();
    push(phone, "friends");
    push(user.phone, "friends");
    return json(res, 200, { ok: true });
  }

  if (m === "GET" && p === "/api/messages") {
    const other = url.searchParams.get("with");
    if (!user.friends.includes(other)) fail(403, "No son amigos todavía.");
    let changed = false;
    const list = [];
    for (const msg of db.messages) {
      if (!between(msg, user.phone, other)) continue;
      if (msg.to === user.phone && !msg.read) { msg.read = true; changed = true; }
      list.push(msg);
    }
    if (changed) { save(); push(other, "read", { by: user.phone }); }
    return json(res, 200, list.slice(-300));
  }

  if (m === "POST" && p === "/api/messages") {
    const { to, text } = await readBody(req);
    if (!user.friends.includes(to)) fail(403, "No son amigos todavía.");
    const t = String(text || "").trim();
    if (!t || t.length > 2000) fail(400, "Mensaje vacío o demasiado largo.");
    const msg = { id: crypto.randomUUID(), from: user.phone, to, text: t, ts: Date.now(), read: false };
    db.messages.push(msg);
    save();
    push(to, "newmsg", { from: user.phone });
    push(user.phone, "friends"); // sincroniza otras pestañas mías
    return json(res, 200, msg);
  }

  fail(404, "No encontrado.");
}

// ---------- Archivos estáticos ----------
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p.startsWith("/api/")) {
    try { await api(req, res, url, p); }
    catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "Error del servidor." });
      if (!e.status) console.error(e);
    }
    return;
  }

  const file = FILES[p];
  if (!file) { res.writeHead(404); return res.end("No encontrado"); }
  fs.readFile(path.join(__dirname, file[0]), (err, data) => {
    if (err) { res.writeHead(404); return res.end("No encontrado"); }
    res.writeHead(200, { "Content-Type": file[1] });
    res.end(data);
  });
});

// Mantiene vivas las conexiones en tiempo real
setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(": ping\n\n");
}, 25000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nMeliox listo en http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) console.log(`Desde otro celular en tu Wi-Fi: http://${i.address}:${PORT}`);
    }
  }
  console.log("");
});