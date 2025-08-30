// server/server.js
// Socket.IO signaling server with Redis-backed queue + pairs (FIFO).
// Handles join/leave/next/signal, emits waiting/paired/partner-disconnected.

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
  "http://localhost:3000",                    // Next.js dev
  "https://<your-vercel-project>.vercel.app", // Vercel preview/prod
  // "https://yourdomain.com",
];

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
  transports: ["websocket"], // WS-only works well behind DO load balancers
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

// ====== Static (optional) ======
app.use(express.static(path.join(__dirname, "public")));

// ====== Health ======
app.get("/healthz", (_req, res) =>
  res.json({ server: "ok", redis: pubClient?.isOpen ? "ok" : "disconnected" })
);

// ====== Redis keys ======
const QUEUE_KEY = "rvchat:queue"; // LIST of waiting socketIds (FIFO)
const PAIRS_KEY = "rvchat:pairs"; // HASH socketId -> partnerId

// ---- Queue helpers (FIFO) ----
// Use rPush + lPop for FIFO. (lPush + lPop was LIFO.)
async function enqueue(id) {
  if (!id) return;
  try {
    await pubClient.lRem(QUEUE_KEY, 0, id); // de-dup best effort
    await pubClient.rPush(QUEUE_KEY, id);   // enqueue to tail
    io.to(id).emit("waiting");
  } catch {}
}

async function removeFromQueue(id) {
  try {
    await pubClient.lRem(QUEUE_KEY, 0, id);
  } catch {}
}

async function popValidWaiting(excludeId) {
  // Keep popping until we find a connected socket that's not the caller
  while (true) {
    const id = await pubClient.lPop(QUEUE_KEY);
    if (!id) return null;
    if (excludeId && id === excludeId) continue;
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
  if (!a && !b) return;
  if (a && !b) b = await getPartner(a);
  if (b && !a) a = await getPartner(b);
  const ops = [];
  if (a) ops.push(pubClient.hDel(PAIRS_KEY, a));
  if (b) ops.push(pubClient.hDel(PAIRS_KEY, b));
  await Promise.all(ops);
  return { a, b };
}

function notifyPartnerDisconnected(id) {
  if (!id) return;
  io.to(id).emit("partner-disconnected");
}

// Try to match a specific caller immediately.
// If no one is available, we enqueue caller and emit "waiting".
async function tryMatchNow(callerId, initiatorIsCaller = true) {
  // Make sure caller isn't still in queue (from a previous wait)
  await removeFromQueue(callerId);

  const candidate = await popValidWaiting(callerId);
  if (candidate) {
    await setPaired(callerId, candidate);

    // Newer action becomes initiator for snappier offers
    io.to(callerId).emit("paired", { peerId: candidate, initiator: initiatorIsCaller });
    io.to(candidate).emit("paired", { peerId: callerId, initiator: !initiatorIsCaller });
    return true;
  }

  // Nobody available yet
  await enqueue(callerId);
  return false;
}

// ====== Socket.IO ======
io.on("connection", (socket) => {
  const id = socket.id;
  console.log(`🔌 ${id} connected`);

  // --- JOIN (Start) ---
  socket.on("join", async () => {
    try {
      // If already paired, ignore join
      const current = await getPartner(id);
      if (current) return;

      // Try to match immediately; fallback to enqueue
      await tryMatchNow(id, /* initiatorIsCaller */ true);
    } catch (e) {
      console.error("join error:", e);
      socket.emit("error", { message: "Failed to join queue" });
    }
  });

  // --- NEXT ---
  // Works whether paired or just waiting:
  // - If paired: break pair, notify partner, requeue partner, then try to match caller immediately.
  // - If waiting: move caller to back and try again, so first Next isn't a no-op.
  socket.on("next", async () => {
    try {
      const partnerId = await getPartner(id);

      if (partnerId) {
        // Break the pair & notify both sides
        const { a, b } = await clearPair(id, partnerId);
        if (a && b) {
          notifyPartnerDisconnected(a);
          notifyPartnerDisconnected(b);
        }

        // Requeue the partner first so they don't get stuck
        const partnerSocket = await io.in(partnerId).fetchSockets();
        if (partnerSocket.length) await enqueue(partnerId);

        // Now try to match the caller instantly
        await tryMatchNow(id, /* initiatorIsCaller */ true);
      } else {
        // Not paired yet → shake the queue so Next actually does something
        await removeFromQueue(id);
        // Try to match right now; if none available, enqueue to the tail
        await tryMatchNow(id, /* initiatorIsCaller */ true);
      }
    } catch (e) {
      console.error("next error:", e);
      socket.emit("error", { message: "Failed to go next" });
    }
  });

  // --- LEAVE ---
  socket.on("leave", async () => {
    try {
      const partnerId = await getPartner(id);

      if (partnerId) {
        const { a, b } = await clearPair(id, partnerId);
        if (a && b) {
          // Tell both clients to teardown
          notifyPartnerDisconnected(a);
          notifyPartnerDisconnected(b);
        }
        // Requeue the partner so they can be matched again
        const partnerSocket = await io.in(partnerId).fetchSockets();
        if (partnerSocket.length) await enqueue(partnerId);
      }

      await removeFromQueue(id); // ensure not left in queue
      socket.emit("left");
    } catch (e) {
      console.error("leave error:", e);
    }
  });

  // --- SIGNAL RELAY (SDP/ICE) ---
  socket.on("signal", async ({ peerId, signal }) => {
    if (!peerId) return;

    // Optional safety: only relay if they are currently paired
    try {
      const partner = await getPartner(id);
      if (partner !== peerId) return; // drop stale/spoofed signals
    } catch {}

    io.to(peerId).emit("signal", { peerId: id, signal });
  });

  // --- DISCONNECT ---
  socket.on("disconnect", async () => {
    console.log(`❌ ${id} disconnected`);
    try {
      const partnerId = await getPartner(id);
      if (partnerId) {
        const { a, b } = await clearPair(id, partnerId);
        if (a && b) notifyPartnerDisconnected(b); // tell the remaining partner

        // Requeue surviving partner so they auto-match
        const partnerSocket = await io.in(partnerId).fetchSockets();
        if (partnerSocket.length) {
          await enqueue(partnerId);
          // Optional: try an immediate match for them
          await tryMatchNow(partnerId, /* initiatorIsCaller */ false);
        }
      }
      await removeFromQueue(id);
    } catch (e) {
      console.error("disconnect cleanup error:", e);
    }
  });
});

// ====== Start ======
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
