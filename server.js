// server/server.js
// Socket.IO signaling server with Redis-backed queue + pairs.
// When one user clicks "Next" (leave), the partner is re-queued automatically.

require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");

const app = express();
const server = http.createServer(app);

// ====== CORS (add your frontend origins) ======
const ALLOWED_ORIGINS = [
  "http://localhost:3000",                  // Next.js dev
  "https://<your-vercel-project>.vercel.app", // Vercel preview/prod
  // "https://yourdomain.com",               // add when you have a custom domain
];

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
  transports: ["websocket"], // keep WS-only for DO LB
});

// ====== Redis adapter (required for multi-instance) ======
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("❌ Missing REDIS_URL. Set redis://default:PASSWORD@HOST:PORT");
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
    console.warn("⚠️  Falling back to in-memory adapter (NO cross-instance matchmaking).");
  }
})();

// ====== Static (optional if you serve /public here) ======
app.use(express.static(path.join(__dirname, "public")));

// ====== Health ======
app.get("/healthz", (_req, res) =>
  res.json({ server: "ok", redis: pubClient?.isOpen ? "ok" : "disconnected" })
);

// ====== Redis keys ======
const QUEUE_KEY = "rvchat:queue"; // LIST of waiting socketIds
const PAIRS_KEY = "rvchat:pairs"; // HASH socketId -> partnerId

// ---- Queue helpers ----
async function enqueue(id) {
  if (!id) return;
  try {
    // De-dup (best-effort): remove previous occurrences then push
    await pubClient.lRem(QUEUE_KEY, 0, id);
    await pubClient.lPush(QUEUE_KEY, id);
  } catch {}
}

async function removeFromQueue(id) {
  try {
    await pubClient.lRem(QUEUE_KEY, 0, id);
  } catch {}
}

async function popValidWaiting() {
  // Pop until we find a connected socket (stale IDs can exist)
  while (true) {
    const id = await pubClient.lPop(QUEUE_KEY);
    if (!id) return null;
    const sockets = await io.in(id).fetchSockets();
    if (sockets.length > 0) return id; // valid
    // else loop to skip stale
  }
}

// ---- Pair helpers ----
async function setPaired(a, b) {
  if (!a || !b) return;
  await pubClient.hSet(PAIRS_KEY, { [a]: b, [b]: a });
}
async function getPartner(id) {
  if (!id) return null;
  return pubClient.hGet(PAIRS_KEY, id);
}
async function clearPair(a, b) {
  // Accept one or both; look up the other if missing
  if (!a && !b) return;
  if (a && !b) b = await getPartner(a);
  if (b && !a) a = await getPartner(b);
  const ops = [];
  if (a) ops.push(pubClient.hDel(PAIRS_KEY, a));
  if (b) ops.push(pubClient.hDel(PAIRS_KEY, b));
  await Promise.all(ops);
}

// ====== Socket.IO ======
io.on("connection", (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  // Client asks to join the matchmaking queue
  socket.on("join", async () => {
    try {
      // First, see if we can match immediately
      const partnerId = await popValidWaiting();

      if (partnerId && partnerId !== socket.id) {
        await setPaired(socket.id, partnerId);

        // Initiator is the most recent joiner
        socket.emit("paired", { peerId: partnerId, initiator: true });
        io.to(partnerId).emit("paired", { peerId: socket.id, initiator: false });
      } else {
        // No one waiting: enqueue this socket
        await enqueue(socket.id);
        socket.emit("waiting");
      }
    } catch (e) {
      console.error("join error:", e);
      socket.emit("error", { message: "Failed to join queue" });
    }
  });

  // Client wants to leave current match and find the next
  socket.on("leave", async () => {
    try {
      const partnerId = await getPartner(socket.id);

      if (partnerId) {
        // Break the pair
        await clearPair(socket.id, partnerId);

        // Re-queue the partner immediately so the *very next join* finds them
        await enqueue(partnerId);
        io.to(partnerId).emit("waiting");
      }

      // Make sure this socket is not left in the queue
      await removeFromQueue(socket.id);

      // Client leaves cleanly (they’ll usually `join` right after for "Next")
      socket.emit("left");
    } catch (e) {
      console.error("leave error:", e);
    }
  });

  // WebRTC signaling relay
  socket.on("signal", ({ peerId, signal }) => {
    if (!peerId) return;
    io.to(peerId).emit("signal", { peerId: socket.id, signal });
  });

  // Cleanup on disconnect
  socket.on("disconnect", async () => {
    console.log(`❌ ${socket.id} disconnected`);
    try {
      const partnerId = await getPartner(socket.id);
      if (partnerId) {
        // Break pair and re-queue the partner so they auto-match
        await clearPair(socket.id, partnerId);
        await enqueue(partnerId);
        io.to(partnerId).emit("waiting");
      }
      await removeFromQueue(socket.id);
    } catch (e) {
      console.error("disconnect cleanup error:", e);
    }
  });
});

// ====== Start ======
// Tip: in local dev, you may prefer PORT=3001 so it doesn't clash with Next dev on 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
});

// Optional: log handshake errors
io.engine.on("connection_error", (err) => {
  console.error("Engine connection_error:", {
    code: err.code,
    message: err.message,
    context: err.context,
  });
});
