"use strict";
/* Pizarra colaborativa — front.
 * Protocolo:
 *  - Cada op lleva clientId + seq (número de secuencia por cliente). opId = `${clientId}:${seq}`.
 *  - El servidor asigna serverSeq global y retransmite. El cliente guarda lastServerSeq.
 *  - Al reconectar se envía hello con lastServerSeq y el servidor devuelve las ops que faltan.
 *  - Cursores: mensajes efímeros {t:'cursor'} con nombre y color.
 *  - Undo/redo local: solo recorre las ops propias; se implementa con retract/restore
 *    que ocultan/restauran tu propia op para todos, sin tocar las de otros.
 */

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const cursorsEl = document.getElementById("cursors");
const peersEl = document.getElementById("peers");
const connEl = document.getElementById("conn");
const zoomLbl = document.getElementById("zoomLbl");
const textInput = document.getElementById("textInput");
const textArea = document.getElementById("textArea");

// ---- Identidad + estado persistido ----
const store = {
  get(k, d) { try { const v = localStorage.getItem("pizarra." + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pizarra." + k, v); } catch {} },
};
let clientId = store.get("clientId", null);
if (!clientId) {
  clientId = (crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  store.set("clientId", clientId);
}
let seq = Number(store.get("seq", 0) || 0);
let lastServerSeq = Number(store.get("lastServerSeq", 0) || 0);
const nameInput = document.getElementById("name");
const colorInput = document.getElementById("color");
nameInput.value = store.get("name", `User-${clientId.slice(0, 4)}`);
colorInput.value = store.get("color", "#4f8cff");
nameInput.addEventListener("change", () => store.set("name", nameInput.value));
colorInput.addEventListener("change", () => store.set("color", colorInput.value));

// ---- Modelo: ops por opId ----
const ops = new Map();       // opId -> op (dibujo o retract/restore/clear aplicadas por cálculo)
const pending = new Map();   // opId -> op optimista aún sin ver del servidor
const undoStack = [];        // mis acciones: {k:'draw',id} | {k:'erase',ids}
const redoStack = [];        // acciones deshechas, pendientes de redo
const retracted = new Set(); // opIds con retract activo
let clearedAt = 0;           // serverSeq del último clear: se oculta todo lo anterior

function nextSeq() {
  seq += 1;
  store.set("seq", String(seq));
  return seq;
}

// ---- Vista: zoom y paneo ----
let scale = 1, camX = 0, camY = 0;
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  draw();
}
window.addEventListener("resize", resize);

const toWorld = (sx, sy) => ({ x: (sx - camX) / scale, y: (sy - camY) / scale });
const toScreen = (wx, wy) => ({ x: wx * scale + camX, y: wy * scale + camY });
function setZoom(next, cx, cy) {
  next = Math.min(4, Math.max(0.1, next));
  cx = cx ?? canvas.clientWidth / 2;
  cy = cy ?? canvas.clientHeight / 2;
  const w = toWorld(cx, cy);
  scale = next;
  camX = cx - w.x * scale;
  camY = cy - w.y * scale;
  zoomLbl.textContent = Math.round(scale * 100) + "%";
  draw();
}

// ---- Herramientas ----
let tool = "pen";
function defaultCursor() {
  return tool === "pan" ? "grab" : tool === "text" ? "text" : tool === "eraser" ? "none" : "crosshair";
}
document.querySelectorAll(".tool").forEach((b) => {
  b.onclick = () => {
    tool = b.dataset.tool;
    document.querySelectorAll(".tool").forEach((x) => x.classList.toggle("active", x === b));
    canvas.style.cursor = defaultCursor();
  };
});
document.getElementById("zoomIn").onclick = () => setZoom(scale * 1.2);
document.getElementById("zoomOut").onclick = () => setZoom(scale / 1.2);
document.getElementById("zoomReset").onclick = () => setZoom(1);
document.getElementById("width").value = store.get("width", "3");
document.getElementById("width").onchange = (e) => store.set("width", e.target.value);

// ---- Dibujo ----
function visibleOps() {
  const list = [...ops.values()].filter((o) =>
    ["stroke", "rect", "arrow", "text"].includes(o.kind) &&
    !retracted.has(o.opId) &&
    (o.serverSeq || Infinity) > clearedAt
  );
  list.sort((a, b) => (a.serverSeq || Infinity) - (b.serverSeq || Infinity));
  // Optimistas pendientes (sin serverSeq) van al final
  for (const o of pending.values()) {
    if (!ops.has(o.opId) && !retracted.has(o.opId)) list.push(o);
  }
  return list;
}

function draw() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  // Fondo + retícula (en pantalla para que no se deforme raro, alineada al mundo)
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#161c27";
  ctx.lineWidth = 1;
  const grid = 40 * scale;
  if (grid > 12) {
    ctx.beginPath();
    const ox = camX % grid, oy = camY % grid;
    for (let x = ox; x < W; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = oy; y < H; y += grid) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * camX, dpr * camY);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const o of visibleOps()) drawOp(o);
  if (draft) drawOp(draft);
  // Vista previa del borrador: círculo en coordenadas de pantalla
  if (tool === "eraser" && mouseS) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(mouseS.x, mouseS.y, ERASER_R, 0, 7);
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawOp(o) {
  ctx.strokeStyle = o.color || "#fff";
  ctx.fillStyle = o.color || "#fff";
  ctx.lineWidth = (o.width || 3) / scale ** 0.15; // grosor casi constante en mundo
  ctx.globalAlpha = o._draft ? 0.7 : 1;
  if (o.kind === "stroke") {
    const p = o.points;
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0], p[0][1], (o.width || 3) / 2, 0, 7);
      ctx.fill();
    } else if (p.length > 1) {
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.stroke();
    }
  } else if (o.kind === "rect") {
    ctx.strokeRect(o.x, o.y, o.w, o.h);
  } else if (o.kind === "arrow") {
    const { x1, y1, x2, y2 } = o;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const s = 12 / Math.sqrt(scale) + (o.width || 3) * 2;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(ang - 0.42), y2 - s * Math.sin(ang - 0.42));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(ang + 0.42), y2 - s * Math.sin(ang + 0.42));
    ctx.stroke();
  } else if (o.kind === "text") {
    ctx.font = `${o.size || 22}px system-ui, sans-serif`;
    ctx.fillText(o.text || "", o.x, o.y);
  }
  ctx.globalAlpha = 1;
}

// ---- Borrador (por trazo: borra líneas del lápiz al tocarlas) ----
const ERASER_R = 14; // radio en píxeles de pantalla
let erasing = false;
let eraseSession = []; // opIds borrados en el arrastre actual (= un paso de undo)
let mouseS = null;     // última posición del puntero en pantalla (preview del borrador)

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeHit(op, wx, wy, tol) {
  const p = op.points || [];
  const t = tol + (op.width || 3) / 2;
  if (p.length === 0) return false;
  if (p.length === 1) return Math.hypot(p[0][0] - wx, p[0][1] - wy) <= t;
  // Rechazo rápido por caja envolvente
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of p) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (wx < minX - t || wx > maxX + t || wy < minY - t || wy > maxY + t) return false;
  for (let i = 1; i < p.length; i++) {
    if (distToSeg(wx, wy, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= t) return true;
  }
  return false;
}

function eraseAt(s) {
  mouseS = s;
  const w = toWorld(s.x, s.y);
  const tol = ERASER_R / scale;
  for (const o of visibleOps()) {
    if (o.kind !== "stroke") continue; // el borrador solo borra líneas del lápiz
    if (!strokeHit(o, w.x, w.y, tol)) continue;
    eraseSession.push(o.opId);
    sendOp({ kind: "retract", targetId: o.opId });
    applyRetract(o.opId);
  }
  draw();
}

// ---- Entrada: dibujar / paneo / texto ----
let draft = null;      // op en curso (preview local)
let drawing = false;
let panning = false;
let spaceDown = false;
let startS = null;     // punto inicial en pantalla
let lastCursorSend = 0;

function evPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const s = evPos(e);
  if (tool === "pan" || spaceDown || e.button === 1) {
    panning = true;
    startS = { ...s, camX, camY };
    canvas.style.cursor = "grabbing";
    return;
  }
  const w = toWorld(s.x, s.y);
  if (tool === "text") {
    openTextBox(s, w);
    return;
  }
  if (tool === "eraser") {
    erasing = true;
    eraseSession = [];
    eraseAt(s);
    return;
  }
  drawing = true;
  const base = {
    _draft: true,
    clientId, color: colorInput.value, width: Number(document.getElementById("width").value),
  };
  if (tool === "pen") draft = { ...base, kind: "stroke", points: [[w.x, w.y]] };
  if (tool === "rect") draft = { ...base, kind: "rect", x: w.x, y: w.y, w: 0, h: 0, _x0: w.x, _y0: w.y };
  if (tool === "arrow") draft = { ...base, kind: "arrow", x1: w.x, y1: w.y, x2: w.x, y2: w.y };
  startS = s;
});

canvas.addEventListener("pointermove", (e) => {
  const s = evPos(e);
  sendCursorThrottled(s);
  if (panning && startS) {
    camX = startS.camX + (s.x - startS.x);
    camY = startS.camY + (s.y - startS.y);
    draw();
    positionCursors();
    return;
  }
  if (erasing) { eraseAt(s); return; }
  if (tool === "eraser") { mouseS = s; draw(); return; } // solo mueve el preview
  if (!drawing || !draft) return;
  const w = toWorld(s.x, s.y);
  if (draft.kind === "stroke") {
    const last = draft.points[draft.points.length - 1];
    if (Math.hypot(last[0] - w.x, last[1] - w.y) > 1.5 / scale) draft.points.push([w.x, w.y]);
  } else if (draft.kind === "rect") {
    draft.x = Math.min(draft._x0, w.x);
    draft.y = Math.min(draft._y0, w.y);
    draft.w = Math.abs(w.x - draft._x0);
    draft.h = Math.abs(w.y - draft._y0);
  } else if (draft.kind === "arrow") {
    draft.x2 = w.x; draft.y2 = w.y;
  }
  draw();
});

window.addEventListener("pointerup", () => {
  if (panning) { panning = false; canvas.style.cursor = defaultCursor(); return; }
  if (erasing) {
    erasing = false;
    // Todo lo borrado en este arrastre = un solo paso de undo
    if (eraseSession.length) { undoStack.push({ k: "erase", ids: eraseSession }); redoStack.length = 0; }
    eraseSession = [];
    return;
  }
  if (!drawing || !draft) return;
  drawing = false;
  const op = { ...draft };
  delete op._draft; delete op._x0; delete op._y0;
  if (op.kind === "rect" && (op.w < 2 / scale || op.h < 2 / scale)) { draft = null; draw(); return; }
  if (op.kind === "stroke" && op.points.length === 0) { draft = null; draw(); return; }
  draft = null;
  publishDrawOp(op);
});

function openTextBox(s, w) {
  textInput.classList.remove("hidden");
  textInput.style.left = s.x + "px";
  textInput.style.top = s.y + "px";
  textArea.value = "";
  textArea.dataset.x = w.x;
  textArea.dataset.y = w.y;
  setTimeout(() => textArea.focus(), 0);
}
textArea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const text = textArea.value.trim();
    textInput.classList.add("hidden");
    if (text) {
      publishDrawOp({
        kind: "text",
        x: Number(textArea.dataset.x), y: Number(textArea.dataset.y),
        text: text.slice(0, 500), size: 22,
        clientId, color: colorInput.value, width: Number(document.getElementById("width").value),
      });
    }
    canvas.focus();
  } else if (e.key === "Escape") {
    textInput.classList.add("hidden");
  }
});

// Zoom con Ctrl+rueda (en el cursor), rueda sola = paneo
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const s = evPos(e);
  if (e.ctrlKey || e.metaKey) {
    setZoom(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), s.x, s.y);
  } else {
    camX -= e.deltaX;
    camY -= e.deltaY;
    draw(); positionCursors();
  }
}, { passive: false });

canvas.addEventListener("pointerleave", () => {
  mouseS = null;
  if (tool === "eraser" && !erasing) draw();
});

canvas.addEventListener("dblclick", (e) => {
  const s = evPos(e);
  setZoom(scale, s.x, s.y);
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement !== textArea && document.activeElement !== nameInput) {
    spaceDown = true;
    if (!drawing) canvas.style.cursor = "grab";
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && document.activeElement !== textArea) {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault(); redo();
  } else if (e.key === "p" || e.key === "P") setTool("pen");
  else if (e.key === "r" || e.key === "R") setTool("rect");
  else if (e.key === "a" || e.key === "A") setTool("arrow");
  else if (e.key === "t" || e.key === "T") setTool("text");
  else if (e.key === "e" || e.key === "E") setTool("eraser");
  else if (e.key === "h" || e.key === "H") setTool("pan");
  else if (e.key === "0" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setZoom(1); }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") { spaceDown = false; canvas.style.cursor = defaultCursor(); }
});
function setTool(t) {
  document.querySelector(`[data-tool="${t}"]`)?.click();
}
document.getElementById("undo").onclick = undo;
document.getElementById("redo").onclick = redo;
document.getElementById("clear").onclick = () => {
  if (confirm("Limpiar la pizarra para todos?")) sendOp({ kind: "clear" });
};

// ---- Undo/redo LOCAL (solo mis acciones: mis trazos y mis borrados) ----
// Entradas de la pila: { k:'draw', id } (dibujé algo) o { k:'erase', ids:[...] }
// (borré esos trazos con el borrador en un arrastre). Las ops ajenas nunca
// entran aquí: Ctrl+Z no deshace lo que dibujaron otros.
function undo() {
  while (undoStack.length) {
    const e = undoStack.pop();
    if (e.k === "draw") {
      if (retracted.has(e.id)) continue; // ya retirada
      if (!ops.get(e.id) && !pending.get(e.id)) continue;
      redoStack.push(e);
      sendOp({ kind: "retract", targetId: e.id });
      applyRetract(e.id);
      return;
    }
    if (e.k === "erase") {
      const ids = e.ids.filter((id) => retracted.has(id));
      if (!ids.length) continue; // otro ya lo restauró
      redoStack.push(e);
      ids.forEach((id) => sendOp({ kind: "restore", targetId: id }));
      ids.forEach((id) => retracted.delete(id));
      draw();
      return;
    }
  }
}
function redo() {
  while (redoStack.length) {
    const e = redoStack.pop();
    if (e.k === "draw") {
      if (!retracted.has(e.id)) continue; // ya restaurado por otra vía
      if (!ops.get(e.id) && !pending.get(e.id)) continue;
      undoStack.push(e);
      sendOp({ kind: "restore", targetId: e.id });
      retracted.delete(e.id);
      draw();
      return;
    }
    if (e.k === "erase") {
      const ids = e.ids.filter((id) => !retracted.has(id) && (ops.get(id) || pending.get(id)));
      if (!ids.length) continue;
      undoStack.push(e);
      ids.forEach((id) => sendOp({ kind: "retract", targetId: id }));
      ids.forEach((id) => retracted.add(id));
      draw();
      return;
    }
  }
}
function applyRetract(id) { retracted.add(id); draw(); }
function applyRestore(id) { retracted.delete(id); draw(); }

// ---- Red: publicar y aplicar ops ----
function publishDrawOp(fields) {
  const s = nextSeq();
  const opId = `${clientId}:${s}`;
  const op = { opId, clientId, seq: s, ts: Date.now(), ...fields };
  pending.set(opId, op);
  ops.set(opId, op); // visible al instante (optimista)
  undoStack.push({ k: "draw", id: opId });
  redoStack.length = 0;
  draw();
  sendOpRaw(op);
}

function sendOp(fields) {
  const s = nextSeq();
  const op = { opId: `${clientId}:${s}`, clientId, seq: s, ts: Date.now(), ...fields };
  if (["retract", "restore", "clear"].includes(op.kind)) {
    // Estas también viajan como ops con clientId+seq y serverSeq del servidor.
  } else {
    pending.set(op.opId, op);
    ops.set(op.opId, op);
  }
  if (op.kind === "retract") { /* aplicado por undo() */ }
  if (op.kind === "restore") { /* aplicado por redo() */ }
  sendOpRaw(op);
}

function sendOpRaw(op) {
  const msg = { t: "op", ...op };
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else outbox.push(msg); // se envía al reconectar
}

function applyRemoteOp(op) {
  if (!op || !op.opId) return;
  if (op.kind === "clear") {
    clearedAt = op.serverSeq || Date.now();
    // Conservamos undo local pero ocultamos todo lo anterior al clear.
    draw();
    return;
  }
  if (op.kind === "retract") {
    if (op.targetId) applyRetract(op.targetId);
    trackServerSeq(op.serverSeq);
    return;
  }
  if (op.kind === "restore") {
    if (op.targetId) applyRestore(op.targetId);
    trackServerSeq(op.serverSeq);
    return;
  }
  // Dibujo:
  const isMine = op.clientId === clientId;
  if (isMine) {
    pending.delete(op.opId); // el servidor la devolvió: ya no es optimista
    // Si la teníamos optimista, conservamos el puesto en undoStack (ya estaba).
  }
  ops.set(op.opId, op);
  // Si es de otro y es nueva, no toca mis pilas de undo (clave del requisito).
  trackServerSeq(op.serverSeq);
  draw();
}

function trackServerSeq(s) {
  s = Number(s || 0);
  if (s > lastServerSeq) {
    // Si hay hueco, pedimos lo que falta (reconexión con pérdida).
    if (s > lastServerSeq + 1 && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "sync", clientId, lastServerSeq }));
    }
    lastServerSeq = s;
    store.set("lastServerSeq", String(s));
  }
}

// ---- Cursores remotos ----
const remoteCursors = new Map(); // clientId -> {el, tag, x, y, at}
function sendCursorThrottled(s) {
  const now = performance.now();
  if (now - lastCursorSend < 40) return;
  lastCursorSend = now;
  if (!ws || ws.readyState !== 1) return;
  const w = toWorld(s.x, s.y);
  ws.send(JSON.stringify({
    t: "cursor", clientId, name: nameInput.value || "Anónimo",
    color: colorInput.value, x: Math.round(w.x), y: Math.round(w.y),
  }));
}
function onRemoteCursor(m) {
  if (!m.clientId || m.clientId === clientId) return;
  let c = remoteCursors.get(m.clientId);
  if (!c) {
    const el = document.createElement("div");
    el.className = "cursor";
    el.innerHTML = `<span class="arrow">➤</span><span class="tag"></span>`;
    cursorsEl.appendChild(el);
    c = { el, tag: el.querySelector(".tag") };
    remoteCursors.set(m.clientId, c);
  }
  c.tag.textContent = m.name || "Anónimo";
  c.tag.style.background = m.color || "#888";
  c.el.querySelector(".arrow").style.color = m.color || "#888";
  c.x = m.x; c.y = m.y; c.at = Date.now();
  positionCursors();
}
function positionCursors() {
  const now = Date.now();
  for (const [id, c] of remoteCursors) {
    if (now - c.at > 4000) { c.el.remove(); remoteCursors.delete(id); continue; }
    const s = toScreen(c.x, c.y);
    c.el.style.left = s.x + "px";
    c.el.style.top = s.y + "px";
  }
}
setInterval(positionCursors, 1000);

function renderPeers(peers) {
  peersEl.innerHTML = "";
  (peers || []).forEach((p) => {
    if (p.clientId === clientId) return;
    const d = document.createElement("span");
    d.className = "peer";
    d.style.background = p.color;
    d.textContent = p.name || "Anónimo";
    peersEl.appendChild(d);
  });
}

// ---- WebSocket con reconexión + catch-up ----
let ws = null;
let retryMs = 500;
const outbox = [];
function wsURL() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}
function connect() {
  connEl.textContent = "conectando…";
  connEl.className = "pill sync";
  const sock = new WebSocket(wsURL());
  ws = sock;
  sock.onopen = () => {
    retryMs = 500;
    connEl.textContent = "en vivo";
    connEl.className = "pill";
    sock.send(JSON.stringify({
      t: "hello", clientId, name: nameInput.value, color: colorInput.value, lastServerSeq,
    }));
    // Reenviar lo que quedó en outbox (ops creadas sin conexión)
    while (outbox.length && sock.readyState === 1) sock.send(JSON.stringify(outbox.shift()));
    // Re-anunciar pendientes optimistas por si el servidor no las vio
    for (const op of pending.values()) sock.send(JSON.stringify({ t: "op", ...op }));
  };
  sock.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "welcome") {
      renderPeers(m.peers);
      // Catch-up: el servidor manda solo las que nos faltan (lastServerSeq).
      for (const op of (m.ops || [])) applyRemoteOp(op);
      if (m.serverSeq) { lastServerSeq = Math.max(lastServerSeq, m.serverSeq); store.set("lastServerSeq", String(lastServerSeq)); }
      draw();
    } else if (m.t === "op") {
      applyRemoteOp(m.op);
    } else if (m.t === "ack") {
      if (m.serverSeq) trackServerSeq(m.serverSeq);
    } else if (m.t === "cursor") {
      onRemoteCursor(m);
    } else if (m.t === "presence") {
      renderPeers(m.peers);
    } else if (m.t === "left") {
      const c = remoteCursors.get(m.clientId);
      if (c) { c.el.remove(); remoteCursors.delete(m.clientId); }
    }
  };
  sock.onclose = () => {
    connEl.textContent = "reconectando…";
    connEl.className = "pill off";
    setTimeout(connect, retryMs);
    retryMs = Math.min(10000, retryMs * 1.8);
  };
  sock.onerror = () => { try { sock.close(); } catch {} };
}
nameInput.addEventListener("change", () => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "hello", clientId, name: nameInput.value, color: colorInput.value, lastServerSeq }));
  }
});

resize();
setZoom(1);
connect();
