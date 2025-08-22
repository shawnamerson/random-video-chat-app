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

// ===== Socket.IO (CORS: keep same-origin by default) =====
// If your frontend is hosted elsewhere, set the allowed origins here:
// const io = new Server(server, {
//   cors: { origin: ["https://your-frontend.example"], credentials: true },
// });
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

// Pop the next valid partner from the shared queue (skips stale IDs)
async function popValidPartner() {
  while (true) {
    const partnerId = await pubClient.lPop(QUEUE_KEY);
    if (!partnerId) return null;
    const sockets = await io.in(partnerId).fetchSockets(); // cluster-wide presence check
    if (sockets.length > 0) return partnerId;
    // else stale: loop to try the next one
  }
}

// Remove a socket from the queue if present
async function removeFromQueue(socketId) {
  try {
    await pubClient.lRem(QUEUE_KEY, 0, socketId);
  } catch {
    // ignore
  }
}

// Local map for partner lookups (per-instance is fine)
const pairs = {};

io.on("connection", (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on("join", async () => {
    try {
      const partnerId = await popValidPartner();

      if (partnerId && partnerId !== socket.id) {
        // Record pair locally for this instance's sockets
        pairs[socket.id] = partnerId;
        pairs[partnerId] = socket.id;

        // initiator flags
        socket.emit("paired", { peerId: partnerId, initiator: true });
        io.to(partnerId).emit("paired", { peerId: socket.id, initiator: false });
      } else {
        // No partner available — enqueue this socket globally
        await removeFromQueue(socket.id); // idempotent cleanup
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

  // Relay WebRTC signaling (adapter broadcasts cross-instance)
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
