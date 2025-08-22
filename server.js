// server.js
// CommonJS – Cluster-safe pairing via Redis queue + Socket.IO Redis adapter

require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");

const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // If your web UI runs on a different origin, set CORS:
  // cors: { origin: ["http://localhost:5173", "https://*.githubpreview.dev"], credentials: true }
});

// ---------- 1) Redis connection (auth + TLS by scheme) ----------
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("❌ Missing REDIS_URL (e.g., redis://default:PASSWORD@HOST:PORT)");
  process.exit(1);
}
const isTLS = redisUrl.startsWith("rediss://");
const redisOpts = {
  url: redisUrl,
  socket: isTLS ? { tls: true, rejectUnauthorized: false } : undefined,
};
console.log(`🔧 Redis URL scheme: ${isTLS ? "TLS (rediss)" : "plain (redis)"}`);

const pubClient = createClient(redisOpts);
const subClient = pubClient.duplicate();

(async () => {
  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log("🗄️  Redis adapter connected");
  } catch (err) {
    console.error("❌ Redis connect failed:", err);
    console.warn("⚠️  Falling back to in-memory adapter (multi-instance pairing will NOT work).");
  }
})();

// ---------- 2) Static files ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- 3) Cluster-safe pairing via Redis ----------
const QUEUE_KEY = "rvchat:queue"; // Redis LIST of waiting socket IDs

// Try to pop a valid partner ID from the shared queue.
// Skips stale IDs (users who disconnected on another instance).
async function popValidPartner() {
  while (true) {
    const partnerId = await pubClient.lPop(QUEUE_KEY);
    if (!partnerId) return null;
    // Check cluster-wide if this socket still exists
    const sockets = await io.in(partnerId).fetchSockets();
    if (sockets.length > 0) return partnerId;
    // else: stale id, continue loop to try next
  }
}

// Remove this socket from the queue if it’s there (cleanup)
async function removeFromQueue(socketId) {
  try {
    await pubClient.lRem(QUEUE_KEY, 0, socketId);
  } catch (e) {
    // ignore
  }
}

// ---------- 4) Socket.io events ----------
const pairs = {}; // local map is fine; partner lookups are per-connection

io.on("connection", (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on("join", async () => {
    try {
      // Try to find a partner waiting anywhere in the cluster
      const partnerId = await popValidPartner();
      if (partnerId && partnerId !== socket.id) {
        // Pair both
        pairs[socket.id] = partnerId;
        pairs[partnerId] = socket.id;

        // initiator flags
        socket.emit("paired", { peerId: partnerId, initiator: true });
        io.to(partnerId).emit("paired", { peerId: socket.id, initiator: false });
      } else {
        // No partner available — enqueue this socket for others to find
        await removeFromQueue(socket.id); // idempotent
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

  // relay WebRTC signaling
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

// ---------- 5) Health ----------
app.get("/healthz", async (_req, res) => {
  res.json({ server: "ok", redis: pubClient?.isOpen ? "ok" : "disconnected" });
});

// ---------- 6) Start ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Server listening on http://localhost:${PORT}`)
);
