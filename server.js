// server.js
// Monolith: serves /public and runs Socket.IO with Redis adapter + Redis-backed queue
require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");

const app = express();
const server = http.createServer(app);

// ===== Socket.IO (same-origin; add CORS origins if hosting UI elsewhere) =====
const io = new Server(server);

// ===== Redis adapter (required for multi-instance) =====
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("❌ Missing REDIS_URL. Set redis://default:PASSWORD@HOST:PORT in env.");
  process.exit(1);
}
const isTLS = redisUrl.startsWith("rediss://");
console.log(`🔧 Redis URL scheme: ${isTLS ? "TLS (rediss)" : "plain (redis)"}`);

const pubClient = createClient({
  url: redisUrl,
  socket: isTLS ? { tls: true, rejectUnauthorized: false } : undefined,
});
const subClient = pubClient.duplicate();

(async () => {
  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log("🗄️  Redis adapter connected");
  } catch (err) {
    console.error("❌ Redis connect failed:", err);
    console.warn("⚠️  Falling back to in-memory adapter (multi-instance will NOT cross-talk).");
  }
})();

// ===== Static files =====
app.use(express.static(path.join(__dirname, "public")));

// ===== Cluster-safe pairing via Redis LIST =====
const QUEUE_KEY = "rvchat:queue"; // Redis LIST of waiting socket IDs

async function popValidPartner() {
  while (true) {
    const partnerId = await pubClient.lPop(QUEUE_KEY);
    if (!partnerId) return null;
    const sockets = await io.in(partnerId).fetchSockets();
    if (sockets.length > 0) return partnerId;
  }
}
async function removeFromQueue(socketId) {
  try { await pubClient.lRem(QUEUE_KEY, 0, socketId); } catch {}
}

const pairs = {};

io.on("connection", (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on("join", async () => {
    try {
      const partnerId = await popValidPartner();
      if (partnerId && partnerId !== socket.id) {
        pairs[socket.id] = partnerId;
        pairs[partnerId] = socket.id;
        socket.emit("paired", { peerId: partnerId, initiator: true });
        io.to(partnerId).emit("paired", { peerId: socket.id, initiator: false });
      } else {
        await removeFromQueue(socket.id);
        await pubClient.lPush(QUEUE_KEY, socket.id);
        socket.emit("waiting");
      }
    } catch (err) {
      console.error("join error:", err);
      socket.emit("error", { message: "Failed to join queue" });
    }
  });

  socket.on("leave", async () => {
    try {
      const partnerId = pairs[socket.id];
      if (partnerId) {
        io.to(partnerId).emit("partner-disconnected", { from: socket.id });
        delete pairs[socket.id];
        delete pairs[partnerId];
      }
      await removeFromQueue(socket.id);
      socket.emit("left");
    } catch (err) {
      console.error("leave error:", err);
    }
  });

  socket.on("signal", ({ peerId, signal }) => {
    if (!peerId) return;
    io.to(peerId).emit("signal", { peerId: socket.id, signal });
  });

  socket.on("disconnect", async () => {
    console.log(`❌ ${socket.id} disconnected`);
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit("partner-disconnected", { from: socket.id });
      delete pairs[socket.id];
      delete pairs[partnerId];
    }
    await removeFromQueue(socket.id);
  });
});

// ===== ICE config endpoint (serves STUN + TURN from env) =====
function buildIceServersFromEnv() {
  // Always include a public STUN
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  // Static TURN (self-hosted coturn or managed provider with long-term creds)
  // Required envs if you use static TURN:
  //   TURN_HOST  (e.g. turn.example.com)
  //   TURN_PORT  (e.g. 3478 for UDP/TCP, and/or 5349 for TLS)
  //   TURN_USER
  //   TURN_PASS
  //   TURN_TLS=true|false  (if true, will add turns: on 5349)
  if (process.env.TURN_HOST && process.env.TURN_USER && process.env.TURN_PASS) {
    const host = process.env.TURN_HOST;
    const port = process.env.TURN_PORT || "3478";
    const useTLS = String(process.env.TURN_TLS || "false").toLowerCase() === "true";

    const urls = [];
    // UDP/TCP on 3478
    urls.push(`turn:${host}:${port}`);
    urls.push(`turn:${host}:${port}?transport=tcp`);

    // TLS on 5349 if enabled
    if (useTLS) {
      urls.push(`turns:${host}:5349?transport=tcp`);
    }

    iceServers.push({
      urls,
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }

  return { iceServers };
}

app.get("/ice", (_req, res) => {
  res.json(buildIceServersFromEnv());
});

// ===== Health & debug =====
app.get("/healthz", (_req, res) => {
  res.json({ server: "ok", redis: pubClient?.isOpen ? "ok" : "disconnected" });
});

app.get("/whoami", (_req, res) => {
  res.json({
    instance: process.env.HOSTNAME || `pid:${process.pid}`,
    redis: pubClient?.isOpen ? "ok" : "disconnected",
  });
});

// ===== Start =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
});
