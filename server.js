// server.js — Back de la pizarra colaborativa.
// - Sirve ./public por HTTP
// - WS en /ws: retransmite operaciones y guarda el historial.
// - Cada op lleva clientId + seq (id de cliente y número de secuencia).
// - Un cliente que se reconecta pide las que le faltan (lastServerSeq).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const PORT = Number(process.env.PORT || 8080);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Historial persistido ----
let history = []; // ops con serverSeq asignado, orden de llegada
let serverSeq = 0;
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (Array.isArray(raw)) {
      history = raw;
      serverSeq = history.reduce((m, o) => Math.max(m, o.serverSeq || 0), 0);
    }
  }
} catch (e) {
  console.error("No se pudo leer historial, se empieza vacío:", e.message);
}
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(HISTORY_FILE, JSON.stringify(history), (e) => {
      if (e) console.error("Error guardando historial:", e.message);
    });
  }, 500);
}

const seenOpIds = new Set(history.map((o) => o.opId));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ops: history.length, serverSeq }));
    return;
  }
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });
// clientId -> { name, color, ws }
const peers = new Map();

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, except = null) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN && c !== except) c.send(s);
  }
}

function presenceList() {
  return [...peers.entries()].map(([clientId, p]) => ({
    clientId, name: p.name, color: p.color,
  }));
}

function broadcastPresence() {
  broadcast({ t: "presence", peers: presenceList() });
}

wss.on("connection", (ws) => {
  let clientId = null;

  ws.on("message", (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }

    // --- hello / sync: el cliente indica hasta qué serverSeq ya vio ---
    if (m.t === "hello" || m.t === "sync") {
      clientId = String(m.clientId || clientId || `c-${Math.random().toString(36).slice(2, 10)}`);
      const last = Number(m.lastServerSeq || 0);
      if (m.name || m.color) {
        peers.set(clientId, {
          name: String(m.name || "Anónimo").slice(0, 24),
          color: String(m.color || "#4f8cff"),
          ws,
        });
        broadcastPresence();
      }
      const missing = history.filter((o) => (o.serverSeq || 0) > last);
      send(ws, { t: "welcome", clientId, serverSeq, ops: missing, peers: presenceList() });
      return;
    }

    // --- operación de dibujo / retract / restore / clear ---
    if (m.t === "op") {
      const cid = String(m.clientId || clientId || "unknown");
      const seq = Number(m.seq);
      if (!Number.isFinite(seq)) return;
      const opId = `${cid}:${seq}`;
      if (seenOpIds.has(opId)) {
        // Reenvío duplicado (reintento tras reconexión): responder ack sin duplicar.
        const existing = history.find((o) => o.opId === opId);
        if (existing) send(ws, { t: "ack", opId, serverSeq: existing.serverSeq });
        return;
      }
      const kind = String(m.kind || "");
      if (!["stroke", "rect", "arrow", "text", "retract", "restore", "clear"].includes(kind)) return;

      if (kind === "clear") {
        // Clear: se vacía el historial (no es deshacerable). Se avisa a todos.
        history = [];
        seenOpIds.clear();
        serverSeq += 1;
        const clearOp = { opId, clientId: cid, seq, kind: "clear", ts: Date.now(), serverSeq };
        // No guardamos ops anteriores; solo el marcador para que quien reconecte se entere.
        history.push(clearOp);
        seenOpIds.add(opId);
        saveSoon();
        broadcast({ t: "op", op: clearOp });
        send(ws, { t: "ack", opId, serverSeq });
        return;
      }

      serverSeq += 1;
      const op = { ...m, opId, clientId: cid, seq, serverSeq, ts: m.ts || Date.now() };
      delete op.t;
      history.push(op);
      seenOpIds.add(opId);
      saveSoon();
      broadcast({ t: "op", op }, null); // incluye al emisor (confirma orden global)
      return;
    }

    // --- cursor efímero: no se guarda, solo se retransmite ---
    if (m.t === "cursor") {
      const out = JSON.stringify({
        t: "cursor",
        clientId: String(m.clientId || ""),
        name: String(m.name || "").slice(0, 24),
        color: String(m.color || "#888"),
        x: Number(m.x) || 0,
        y: Number(m.y) || 0,
      });
      for (const c of wss.clients) {
        if (c.readyState === WebSocket.OPEN && c !== ws) c.send(out);
      }
      return;
    }
  });

  ws.on("close", () => {
    if (clientId && peers.get(clientId)?.ws === ws) {
      peers.delete(clientId);
      broadcast({ t: "left", clientId });
      broadcastPresence();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Pizarra en http://localhost:${PORT}  (WS /ws, ops=${history.length}, serverSeq=${serverSeq})`);
});
