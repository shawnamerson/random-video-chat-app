// server.js
// CommonJS – Redis Cloud auth/TLS via REDIS_URL in .env

require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");

const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- 1) Redis connection (auth + TLS) ----------
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error(
    "❌ Missing REDIS_URL. Set e.g. rediss://default:PASSWORD@HOST:PORT in your .env"
  );
  process.exit(1);
}

const isTLS = redisUrl.startsWith("rediss://");
const redisOpts = {
  url: redisUrl,
  socket: isTLS ? { tls: true, rejectUnauthorized: false } : undefined,
};

const pubClient = createClient(redisOpts);
const subClient = pubClient.duplicate();

(async () => {
  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log("🗄️  Redis adapter connected");
  } catch (err) {
    console.error("❌ Redis connect failed:", err);
    console.warn("⚠️  Falling back to in-memory adapter.");
    // Default in-memory broadcast if Redis is unavailable
  }
})();

// ---------- 2) Static files ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- 3) Simple pairing state ----------
let waitingSocket = null;
const pairs = {};

// ---------- 4) Socket.io events ----------
io.on("connection", (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on("join", () => {
    if (waitingSocket && waitingSocket.id !== socket.id) {
      const peer = waitingSocket;
      waitingSocket = null;

      // pair
      pairs[socket.id] = peer.id;
      pairs[peer.id] = socket.id;

      // initiator flags
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
    if (waitingSocket?.id === socket.id) {
      waitingSocket = null;
    }
    socket.emit("left");
  });

  // relay WebRTC signaling
  socket.on("signal", ({ peerId, signal }) => {
    if (!peerId) return;
    io.to(peerId).emit("signal", { peerId: socket.id, signal });
  });

  socket.on("disconnect", () => {
    console.log(`❌ ${socket.id} disconnected`);
    // don't emit to a disconnected socket
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit("partner-disconnected", { from: socket.id });
      delete pairs[socket.id];
      delete pairs[partnerId];
    }
    if (waitingSocket?.id === socket.id) {
      waitingSocket = null;
    }
  });
});

// ---------- 5) Start server ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Server listening on http://localhost:${PORT}`)
);
