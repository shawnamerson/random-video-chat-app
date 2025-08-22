// server.js
// Monolith: serves /public and runs Socket.IO with Redis adapter + Redis-backed queue + Redis-backed pairs
require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");

const app = express();
const server = http.createServer(app);
const io = new Server(server); // same-origin; add CORS if frontend is elsewhere

// ---------- Redis adapter ----------
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("❌ Missing REDIS_URL. Set redis://default:PASSWORD@HOST:PORT in env.");
  process.exit(1);
}
const isTLS = redisUrl.startsWith("rediss://");
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
    console.warn("⚠️  Falling back to in-memory adapter (multi-instance pairing will NOT work).");
  }
})();

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Redis keys ----------
const QUEUE_KEY = "rvchat:queue"; // LIST of waiting socket IDs
const PAIRS_KEY = "rvchat:pairs"; // HASH mapping socketId -> partnerId

// Helpers
async function removeFromQueue(socketId) {
  try { await pubClient.lRem(QUEUE_KEY, 0, socketId); } catch {}
}

async function setPaired(a, b) {
  // set both directions atomically
  await pubClient.hSet(PAIRS_KEY, { [a]: b, [b]: a });
}
async function getPartner(id) {
  return pubClient.hGet(PAIRS_KEY, id);
}
async function clearPair(a, b) {
  if (!a && !b) return;
  if (a && !b) b = await getPartner(a);
  if (b && !a) a = await getPartner(b);
  if (a) await pubClient.hDel(PAIRS_KEY, a);
  if (b) await pubClient.hDel(PAIRS_KEY, b);
}

async function popValidWaiting() {
  while (true) {
    const id = await pubClient.lPop(QUEUE_KEY);
    if (!id) return null;
    // verify socket is still connected (cluster-wide)
    const sockets = await io.in(id).fetchSockets();
    if (sockets.length > 0) return id;
    // stale ID: loop
  }
}

// ---------- Socket.io ----------
io.on("connection", (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on("join", async () => {
    try {
      // Try to find someone waiting
      const partnerId = await popValidWaiting();

      if (partnerId && partnerId !== socket.id) {
        // Record pair globally so any instance can look it up
        await setPaired(socket.id, partnerId);

        // Tell both peers
        socket.emit("paired", { peerId: partnerId, initiator: true });
        io.to(partnerId).emit("paired", { peerId: socket.id, initiator: false });
      } else {
        // Enqueue this socket to wait
        await removeFromQueue(socket.id);  // idempotent cleanup
        await pubClient.lPush(QUEUE_KEY, socket.id);
        socket.emit("waiting");
      }
    } catch (e) {
      console.error("join error:", e);
      socket.emit("error", { message: "Failed to join queue" });
    }
  });

  socket.on("leave", async () => {
    try {
      // Look up the partner from Redis (works across instances)
      const partnerId = await getPartner(socket.id);

      if (partnerId) {
        // notify partner and clear mapping
        io.to(partnerId).emit("partner-disconnected", { from: socket.id });
        await clearPair(socket.id, partnerId);
      }

      await removeFromQueue(socket.id);
      socket.emit("left");
    } catch (e) {
      console.error("leave error:", e);
    }
  });

  // Relay WebRTC signaling (adapter stitches instances)
  socket.on("signal", ({ peerId, signal }) => {
    if (!peerId) return;
    io.to(peerId).emit("signal", { peerId: socket.id, signal });
  });

  socket.on("disconnect", async () => {
    console.log(`❌ ${socket.id} disconnected`);
    try {
      const partnerId = await getPartner(socket.id);
      if (partnerId) {
        io.to(partnerId).emit("partner-disconnected", { from: socket.id });
        await clearPair(socket.id, partnerId);
      }
      await removeFromQueue(socket.id);
    } catch (e) {
      console.error("disconnect cleanup error:", e);
    }
  });
});

// ---------- Health/debug ----------
app.get("/healthz", (_req, res) => {
  res.json({ server: "ok", redis: pubClient?.isOpen ? "ok" : "disconnected" });
});
app.get("/whoami", (_req, res) => {
  res.json({ instance: process.env.HOSTNAME || `pid:${process.pid}`, redis: pubClient?.isOpen ? "ok" : "disconnected" });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
});
