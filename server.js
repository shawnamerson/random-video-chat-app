// server.js
// Monolith: serves /public and runs Socket.IO with Redis adapter
require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");

const app = express();
const server = http.createServer(app);

// ===== Socket.IO (set CORS for your domains) =====
const FRONTEND_ORIGINS = [
  // If the page is served by this same service, you can keep this array empty.
  // Otherwise, list every origin that will load your site:
  "https://<your-do-app>.ondigitalocean.app",
  // "https://your-custom-domain.com",
];

const io = new Server(server, {
  cors: FRONTEND_ORIGINS.length
    ? { origin: FRONTEND_ORIGINS, credentials: true }
    : undefined, // same-origin deployment needs no extra CORS
});

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

// ===== Simple pairing (works cross-instance thanks to Redis adapter) =====
let waitingSocket = null;
const pairs = {};

io.on("connection", (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on("join", () => {
    if (waitingSocket && waitingSocket.id !== socket.id) {
      const peer = waitingSocket;
      waitingSocket = null;

      pairs[socket.id] = peer.id;
      pairs[peer.id] = socket.id;

      socket.emit("paired", { peerId: peer.id, initiator: true });
      peer.emit("paired", { peerId: socket.id, initiator: false });
    } else {
      waitingSocket = socket;
      socket.emit("waiting");
    }
  });

  socket.on("leave", () => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit("partner-disconnected", { from: socket.id });
      delete pairs[socket.id];
      delete pairs[partnerId];
    }
    if (waitingSocket?.id === socket.id) waitingSocket = null;
    socket.emit("left");
  });

  socket.on("signal", ({ peerId, signal }) => {
    if (!peerId) return;
    io.to(peerId).emit("signal", { peerId: socket.id, signal });
  });

  socket.on("disconnect", () => {
    console.log(`❌ ${socket.id} disconnected`);
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit("partner-disconnected", { from: socket.id });
      delete pairs[socket.id];
      delete pairs[partnerId];
    }
    if (waitingSocket?.id === socket.id) waitingSocket = null;
  });
});

// ===== Health check =====
app.get("/healthz", (_req, res) => {
  res.json({ server: "ok", redis: pubClient?.isOpen ? "ok" : "disconnected" });
});

// ===== Start =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
});
