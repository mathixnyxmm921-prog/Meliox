// ===================== Meliox =====================
const $ = (s) => document.querySelector(s);

// Si abres con Vite (puerto 3000) habla con el servidor en el 3001.
// Si abres directo desde el servidor (3001), usa la misma dirección.
const API = location.port === "3001" ? "" : `http://${location.hostname}:3001`;

// ---------- Número colombiano: empieza con 3 y EXACTAMENTE 10 dígitos ----------
const PHONE_REGEX = /^3\d{9}$/;

function phoneError(value) {
  if (!value) return "Escribe tu número de celular.";
  if (value[0] !== "3") return "El número debe empezar con 3.";
  if (value.length < 10) return "Faltan dígitos: el número debe tener exactamente 10.";
  if (value.length > 10) return "Sobran dígitos: el número debe tener exactamente 10.";
  if (!PHONE_REGEX.test(value)) return "Número no válido.";
  return "";
}
const cleanPhoneInput = (input) => (input.value = input.value.replace(/\D/g, "").slice(0, 10));

// ---------- Utilidades ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const kid of kids) el.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return el;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function dayLabel(ts) {
  const now = Date.now();
  if (sameDay(ts, now)) return "Hoy";
  if (sameDay(ts, now - 86400000)) return "Ayer";
  return new Date(ts).toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" });
}

function listTime(ts) {
  const now = Date.now();
  if (sameDay(ts, now)) return fmtTime(ts);
  if (sameDay(ts, now - 86400000)) return "Ayer";
  return new Date(ts).toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit" });
}

// ---------- Estado ----------
let token = localStorage.getItem("meliox_token");
let me = null;
let friends = [];
let incoming = [];
let current = null; // teléfono del chat abierto
let msgs = [];
let es = null;
let longPressed = false; // para "mantener presionado" en el celular
let longTimer = null;

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error("No se pudo conectar con el servidor. ¿Está corriendo node server.cjs?");
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && token) logout();
    throw new Error(data.error || "Error de conexión.");
  }
  return data;
}

// ---------- Vistas ----------
const views = { login: $("#view-login"), register: $("#view-register"), home: $("#view-home") };
function show(name) {
  Object.values(views).forEach((v) => v.classList.add("hidden"));
  views[name].classList.remove("hidden");
}
$("#go-register").addEventListener("click", (e) => { e.preventDefault(); show("register"); });
$("#go-login").addEventListener("click", (e) => { e.preventDefault(); show("login"); });

// ---------- Editor de foto (mover + zoom), reutilizable ----------
const SIZE = 280;

function createCropper({ canvas, zoomInput, zoomWrap, empty }) {
  const c = canvas.getContext("2d");
  let img = null, minScale = 1, zoom = 1, ox = 0, oy = 0, dirty = false;
  const scale = () => minScale * zoom;

  function clamp() {
    if (!img) return;
    const maxX = Math.max(0, (img.width * scale() - SIZE) / 2);
    const maxY = Math.max(0, (img.height * scale() - SIZE) / 2);
    ox = Math.min(maxX, Math.max(-maxX, ox));
    oy = Math.min(maxY, Math.max(-maxY, oy));
  }

  function drawTo(ctx2, size) {
    const f = size / SIZE;
    const w = img.width * scale() * f;
    const hh = img.height * scale() * f;
    ctx2.drawImage(img, size / 2 + ox * f - w / 2, size / 2 + oy * f - hh / 2, w, hh);
  }

  function render() {
    c.clearRect(0, 0, SIZE, SIZE);
    if (!img) return;
    drawTo(c, SIZE);
    c.save();
    c.fillStyle = "rgba(0,0,0,0.55)";
    c.beginPath();
    c.rect(0, 0, SIZE, SIZE);
    c.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 6, 0, Math.PI * 2, true);
    c.fill("evenodd");
    c.strokeStyle = "#1fd8a4";
    c.lineWidth = 2;
    c.beginPath();
    c.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 6, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  function setImage(im, markDirty) {
    img = im;
    minScale = SIZE / Math.min(im.width, im.height);
    zoom = 1; ox = 0; oy = 0;
    dirty = markDirty;
    zoomInput.value = 1;
    if (zoomWrap) zoomWrap.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");
    render();
  }

  zoomInput.addEventListener("input", () => {
    zoom = parseFloat(zoomInput.value);
    dirty = true;
    clamp(); render();
  });

  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    if (!img) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const k = SIZE / canvas.getBoundingClientRect().width;
    ox += (e.clientX - lastX) * k;
    oy += (e.clientY - lastY) * k;
    lastX = e.clientX; lastY = e.clientY;
    dirty = true;
    clamp(); render();
  });
  const stop = () => { dragging = false; canvas.classList.remove("dragging"); };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("wheel", (e) => {
    if (!img) return;
    e.preventDefault();
    zoom = Math.min(4, Math.max(1, zoom + (e.deltaY < 0 ? 0.08 : -0.08)));
    zoomInput.value = zoom;
    dirty = true;
    clamp(); render();
  }, { passive: false });

  return {
    // Carga una foto elegida por el usuario. Devuelve una promesa con true/false.
    loadFile(file) {
      return new Promise((resolve) => {
        if (!file || !file.type.startsWith("image/")) return resolve(false);
        const reader = new FileReader();
        reader.onload = () => {
          const im = new Image();
          im.onload = () => { setImage(im, true); resolve(true); };
          im.onerror = () => resolve(false);
          im.src = reader.result;
        };
        reader.onerror = () => resolve(false);
        reader.readAsDataURL(file);
      });
    },
    // Carga una foto ya guardada (no cuenta como cambio hasta que el usuario la mueva)
    loadSrc(src) {
      const im = new Image();
      im.onload = () => setImage(im, false);
      im.src = src;
    },
    hasImage: () => !!img,
    changed: () => dirty,
    exportPhoto() {
      const out = document.createElement("canvas");
      out.width = out.height = 256;
      drawTo(out.getContext("2d"), 256);
      return out.toDataURL("image/jpeg", 0.85);
    },
  };
}

const regCropper = createCropper({
  canvas: $("#crop"),
  zoomInput: $("#zoom"),
  zoomWrap: $("#zoom-wrap"),
  empty: $("#crop-empty"),
});

$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ok = await regCropper.loadFile(file);
  $("#reg-error").textContent = ok ? "" : "Elige un archivo de imagen válido.";
});

// ---------- Registro y login ----------
const regPhone = $("#reg-phone");
const counter = $("#phone-counter");
regPhone.addEventListener("input", () => {
  cleanPhoneInput(regPhone);
  const v = regPhone.value;
  const err = v ? phoneError(v) : "";
  if (!v) { counter.className = "hint"; counter.textContent = "0/10 dígitos · debe empezar con 3"; }
  else if (!err) { counter.className = "hint ok"; counter.textContent = "10/10 dígitos ✓"; }
  else { counter.className = "hint bad"; counter.textContent = `${v.length}/10 dígitos · ${err}`; }
});
$("#login-phone").addEventListener("input", (e) => cleanPhoneInput(e.target));
$("#add-phone").addEventListener("input", (e) => cleanPhoneInput(e.target));

$("#form-register").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#reg-error");
  const name = $("#reg-name").value.trim();
  const phone = regPhone.value;
  const password = $("#reg-pass").value;

  if (!regCropper.hasImage()) return (err.textContent = "Sube una foto de perfil.");
  if (name.length < 2) return (err.textContent = "Escribe tu nombre (mínimo 2 letras).");
  const pe = phoneError(phone);
  if (pe) return (err.textContent = pe);
  if (password.length < 6) return (err.textContent = "La contraseña debe tener mínimo 6 caracteres.");

  try {
    const data = await api("/api/register", { method: "POST", body: { name, phone, password, photo: regCropper.exportPhoto() } });
    err.textContent = "";
    token = data.token;
    localStorage.setItem("meliox_token", token);
    startApp();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  const phone = $("#login-phone").value;
  const password = $("#login-pass").value;
  const pe = phoneError(phone);
  if (pe) return (err.textContent = pe);
  if (!password) return (err.textContent = "Escribe tu contraseña.");

  try {
    const data = await api("/api/login", { method: "POST", body: { phone, password } });
    err.textContent = "";
    token = data.token;
    localStorage.setItem("meliox_token", token);
    startApp();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

// ---------- App ----------
async function refreshMe() {
  const data = await api("/api/me");
  me = data.me;
  friends = data.friends;
  incoming = data.incoming;
  // Si el amigo del chat abierto ya no está en mi lista, cierro ese chat
  if (current && !friends.some((f) => f.phone === current)) {
    const name = $("#peer-name").textContent;
    closeChat();
    toast(`${name} ya no está en tus amigos.`);
  }
  renderSidebar();
  updatePeerHeader();
}

// Si un amigo cambia nombre o foto con su chat abierto, se actualiza el encabezado
function updatePeerHeader() {
  if (!current) return;
  const f = friends.find((x) => x.phone === current);
  if (!f) return;
  $("#peer-photo").src = f.photo;
  $("#peer-name").textContent = f.name;
  $("#peer-phone").textContent = "+57 " + f.phone;
}

function renderSidebar() {
  $("#me-photo").src = me.photo;
  $("#me-name").textContent = me.name;
  $("#me-phone").textContent = "+57 " + me.phone;

  // Solicitudes recibidas
  const rq = $("#requests");
  rq.innerHTML = "";
  if (incoming.length) {
    rq.classList.remove("hidden");
    rq.append(h("div", { class: "req-title" }, `Solicitudes de amistad (${incoming.length})`));
    incoming.forEach((u) =>
      rq.append(
        h("div", { class: "req" },
          h("img", { class: "avatar", src: u.photo, alt: "" }),
          h("div", { class: "req-info" }, h("strong", {}, u.name), h("small", {}, "+57 " + u.phone)),
          h("button", { class: "mini ok", title: "Aceptar", onclick: () => respond(u.phone, true) }, "✓"),
          h("button", { class: "mini no", title: "Rechazar", onclick: () => respond(u.phone, false) }, "✕")
        )
      )
    );
  } else {
    rq.classList.add("hidden");
  }

  // Lista de amigos
  const q = $("#search").value.trim().toLowerCase();
  const list = friends
    .filter((f) => !q || f.name.toLowerCase().includes(q) || f.phone.includes(q))
    .sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));

  const ul = $("#chat-list");
  ul.innerHTML = "";
  if (!list.length) {
    ul.append(
      h("li", { class: "list-empty" },
        friends.length ? "Nadie coincide con tu búsqueda." : "Aún no tienes amigos.\nToca el ícono de persona con + para agregar a alguien por su número.")
    );
    ul.firstChild.style.whiteSpace = "pre-line";
    return;
  }
  list.forEach((f) => {
    const preview = f.last ? (f.last.from === me.phone ? "Tú: " : "") + f.last.text : "Toca para chatear";
    const cancelPress = () => clearTimeout(longTimer);
    ul.append(
      h("li", {
        class: "chat-item" + (current === f.phone ? " active" : ""),
        onclick: (e) => {
          if (longPressed) { e.stopPropagation(); longPressed = false; return; }
          openChat(f.phone);
        },
        // Clic derecho (computador)
        oncontextmenu: (e) => { e.preventDefault(); openCtx(e.clientX, e.clientY, f); },
        // Mantener presionado (celular)
        ontouchstart: (e) => {
          longPressed = false;
          const t = e.touches[0];
          longTimer = setTimeout(() => { longPressed = true; openCtx(t.clientX, t.clientY, f); }, 600);
        },
        ontouchend: cancelPress,
        ontouchmove: cancelPress,
        ontouchcancel: cancelPress,
      },
        h("img", { class: "avatar", src: f.photo, alt: "" }),
        h("div", { class: "ci-main" },
          h("div", { class: "ci-top" }, h("strong", {}, f.name), f.last ? h("time", { class: f.unread ? "new" : "" }, listTime(f.last.ts)) : ""),
          h("div", { class: "ci-bottom" }, h("span", { class: "ci-preview" }, preview), f.unread ? h("span", { class: "badge" }, String(f.unread)) : "")
        )
      )
    );
  });
}
$("#search").addEventListener("input", () => me && renderSidebar());

async function respond(phone, accept) {
  try {
    await api("/api/friends/respond", { method: "POST", body: { phone, accept } });
    await refreshMe();
    if (accept) toast("¡Ahora son amigos!");
  } catch (ex) { toast(ex.message); }
}

// ---------- Chat ----------
async function openChat(phone) {
  current = phone;
  const f = friends.find((x) => x.phone === phone);
  if (!f) return;
  updatePeerHeader();
  $("#chat-empty").classList.add("hidden");
  $("#chat").classList.remove("hidden");
  $("#view-home").classList.add("chat-open");
  msgs = [];
  $("#messages").innerHTML = "";
  await loadMessages(true);
  $("#msg-input").focus();
}

async function loadMessages(forceScroll) {
  const phone = current;
  if (!phone) return;
  try {
    const list = await api("/api/messages?with=" + phone);
    if (phone !== current) return;
    msgs = list;
    renderMessages(forceScroll);
    refreshMe();
  } catch (ex) { toast(ex.message); }
}

function renderMessages(forceScroll) {
  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  box.innerHTML = "";
  let lastTs = null;
  msgs.forEach((m) => {
    if (lastTs === null || !sameDay(m.ts, lastTs)) box.append(h("div", { class: "day" }, dayLabel(m.ts)));
    lastTs = m.ts;
    const mine = m.from === me.phone;
    box.append(
      h("div", { class: "bubble " + (mine ? "mine" : "theirs") },
        h("span", { class: "text" }, m.text),
        h("span", { class: "meta" }, fmtTime(m.ts), mine ? h("span", { class: "tick" + (m.read ? " read" : "") }, m.read ? "✓✓" : "✓") : "")
      )
    );
  });
  if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
}

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#msg-input");
  const text = input.value.trim();
  if (!text || !current) return;
  input.value = "";
  try {
    const m = await api("/api/messages", { method: "POST", body: { to: current, text } });
    msgs.push(m);
    renderMessages(true);
    refreshMe();
  } catch (ex) {
    input.value = text;
    toast(ex.message);
  }
});

function closeChat() {
  current = null;
  msgs = [];
  $("#view-home").classList.remove("chat-open");
  $("#chat").classList.add("hidden");
  $("#chat-empty").classList.remove("hidden");
  if (me) renderSidebar();
}
$("#back").addEventListener("click", closeChat);

// ---------- Eliminar amigo (clic derecho o mantener presionado) ----------
const ctxMenu = $("#ctx-menu");
const confirmModal = $("#confirm-modal");
let ctxTarget = null;
let removeTarget = null;

function openCtx(x, y, f) {
  ctxTarget = f;
  ctxMenu.classList.remove("hidden");
  const w = ctxMenu.offsetWidth, hgt = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + "px";
  ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - hgt - 4)) + "px";
}
function closeCtx() { ctxMenu.classList.add("hidden"); }
function closeConfirm() { confirmModal.classList.add("hidden"); }

document.addEventListener("click", closeCtx);
document.addEventListener("scroll", closeCtx, true);
window.addEventListener("resize", closeCtx);
document.addEventListener("contextmenu", (e) => { if (!e.target.closest(".chat-item")) closeCtx(); });

$("#ctx-remove").addEventListener("click", () => {
  if (!ctxTarget) return;
  removeTarget = ctxTarget;
  closeCtx();
  $("#confirm-text").textContent = `¿Eliminar a ${removeTarget.name} de tus amigos? Ya no podrán chatear hasta que se agreguen de nuevo.`;
  $("#confirm-msg").textContent = "";
  confirmModal.classList.remove("hidden");
});
$("#confirm-cancel").addEventListener("click", closeConfirm);
confirmModal.addEventListener("click", (e) => { if (e.target === confirmModal) closeConfirm(); });

$("#confirm-ok").addEventListener("click", async () => {
  if (!removeTarget) return;
  const { phone, name } = removeTarget;
  try {
    await api("/api/friends/remove", { method: "POST", body: { phone } });
    closeConfirm();
    if (current === phone) closeChat();
    await refreshMe();
    toast(`${name} ya no es tu amigo.`);
  } catch (ex) {
    $("#confirm-msg").textContent = ex.message;
  }
});

// ---------- Agregar amigo ----------
const modal = $("#modal");
const addMsg = $("#add-msg");
function openModal() {
  addMsg.textContent = "";
  addMsg.className = "form-msg";
  $("#add-phone").value = "";
  modal.classList.remove("hidden");
  $("#add-phone").focus();
}
const closeModal = () => modal.classList.add("hidden");
$("#btn-add").addEventListener("click", openModal);
$("#add-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

$("#form-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = $("#add-phone").value;
  const pe = phoneError(phone);
  addMsg.className = "form-msg";
  if (pe) return (addMsg.textContent = pe);
  try {
    const r = await api("/api/friends/request", { method: "POST", body: { phone } });
    addMsg.className = "form-msg ok";
    addMsg.textContent = r.status === "accepted"
      ? `¡Ahora eres amigo de ${r.name}!`
      : `Solicitud enviada a ${r.name}. Falta que la acepte.`;
    $("#add-phone").value = "";
    refreshMe();
  } catch (ex) {
    addMsg.textContent = ex.message;
  }
});

// ---------- Editar mi perfil (nombre y foto) ----------
const profileModal = $("#profile-modal");
const profileMsg = $("#profile-msg");
const profileCropper = createCropper({
  canvas: $("#crop-profile"),
  zoomInput: $("#profile-zoom"),
});

function openProfile() {
  if (!me) return;
  profileMsg.textContent = "";
  profileMsg.className = "form-msg";
  $("#profile-name").value = me.name;
  $("#profile-photo-input").value = "";
  profileCropper.loadSrc(me.photo);
  profileModal.classList.remove("hidden");
  $("#profile-name").focus();
}
const closeProfile = () => profileModal.classList.add("hidden");

$("#btn-profile").addEventListener("click", openProfile);
$("#me-photo").addEventListener("click", openProfile);
$("#me-info").addEventListener("click", openProfile);
$("#profile-cancel").addEventListener("click", closeProfile);
profileModal.addEventListener("click", (e) => { if (e.target === profileModal) closeProfile(); });

$("#profile-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ok = await profileCropper.loadFile(file);
  profileMsg.className = "form-msg";
  profileMsg.textContent = ok ? "" : "Elige un archivo de imagen válido.";
});

$("#form-profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  profileMsg.className = "form-msg";
  const name = $("#profile-name").value.trim();
  if (name.length < 2) return (profileMsg.textContent = "Escribe tu nombre (mínimo 2 letras).");

  const body = {};
  if (name !== me.name) body.name = name;
  if (profileCropper.changed()) body.photo = profileCropper.exportPhoto();
  if (!Object.keys(body).length) return closeProfile(); // nada que guardar

  try {
    await api("/api/profile", { method: "POST", body });
    closeProfile();
    await refreshMe();
    toast("Perfil actualizado");
  } catch (ex) {
    profileMsg.textContent = ex.message;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); closeProfile(); closeCtx(); closeConfirm(); }
});

// ---------- Tiempo real ----------
function connect() {
  if (es) es.close();
  es = new EventSource(`${API}/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener("newmsg", (e) => {
    const { from } = JSON.parse(e.data);
    if (current === from) loadMessages(false);
    else refreshMe();
  });
  es.addEventListener("read", (e) => {
    const { by } = JSON.parse(e.data);
    if (current === by) loadMessages(false);
  });
  es.addEventListener("friends", () => refreshMe());
  es.addEventListener("ready", () => { refreshMe(); if (current) loadMessages(false); });
}

// ---------- Inicio / salida ----------
async function startApp() {
  try {
    await refreshMe();
    show("home");
    connect();
  } catch (ex) {
    if (token) toast(ex.message);
    show("login");
  }
}

function logout() {
  if (es) es.close();
  es = null;
  token = null; me = null; friends = []; incoming = []; current = null; msgs = [];
  localStorage.removeItem("meliox_token");
  $("#login-pass").value = "";
  $("#chat").classList.add("hidden");
  $("#chat-empty").classList.remove("hidden");
  $("#view-home").classList.remove("chat-open");
  closeProfile();
  show("login");
}
$("#logout").addEventListener("click", logout);

if (token) startApp();