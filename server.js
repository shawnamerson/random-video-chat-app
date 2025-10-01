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
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : [
      "http://localhost:3000", // Next.js dev
      "https://random-video-chat-rose.vercel.app", // Vercel production
      // Add more Vercel preview deployments if needed
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

let redisConnected = false;

(async () => {
  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    redisConnected = true;
    console.log("🗄️  Redis adapter connected");
  } catch (err) {
    console.error("❌ Redis connect failed:", err);

    // In production with multiple instances, Redis is REQUIRED
    if (process.env.NODE_ENV === "production") {
      console.error("❌ Cannot run in production without Redis. Exiting...");
      process.exit(1);
    }

    console.warn("⚠️  Falling back to in-memory adapter (development only).");
  }
})();

// Health check for Redis
pubClient.on("error", (err) => {
  console.error("❌ Redis client error:", err);
  redisConnected = false;
});

pubClient.on("reconnecting", () => {
  console.log("🔄 Redis reconnecting...");
});

pubClient.on("ready", () => {
  console.log("✅ Redis ready");
  redisConnected = true;
});

// ====== Ban List Management ======
const bannedIPs = new Set();

// Load banned IPs from Redis on startup
async function loadBannedIPs() {
  try {
    const ips = await pubClient.sMembers("rvchat:banned_ips");
    ips.forEach(ip => bannedIPs.add(ip));
    console.log(`📋 Loaded ${ips.length} banned IPs`);
  } catch (err) {
    console.error("❌ Failed to load banned IPs:", err);
  }
}

async function banIP(ip, reason = "policy violation") {
  if (!ip) return;
  bannedIPs.add(ip);
  await pubClient.sAdd("rvchat:banned_ips", ip);
  await pubClient.hSet(`rvchat:ban_details:${ip}`, {
    reason,
    timestamp: Date.now().toString(),
  });
  console.log(`🚫 Banned IP: ${ip} (${reason})`);

  // Disconnect all sockets from this IP
  const sockets = await io.fetchSockets();
  sockets.forEach(socket => {
    if (socket.ip === ip) {
      socket.emit("banned", { reason });
      socket.disconnect(true);
    }
  });
}

async function unbanIP(ip) {
  if (!ip) return;
  bannedIPs.delete(ip);
  await pubClient.sRem("rvchat:banned_ips", ip);
  await pubClient.del(`rvchat:ban_details:${ip}`);
  console.log(`✅ Unbanned IP: ${ip}`);
}

// Load bans after Redis connection
(async () => {
  if (redisConnected) {
    await loadBannedIPs();
  }
})();

// ====== Express Middleware ======
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json()); // Parse JSON bodies for admin endpoints

// ====== Admin Middleware ======
function verifyAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;

  if (!process.env.ADMIN_KEY) {
    return res.status(503).json({ error: "Admin API not configured" });
  }

  if (key !== process.env.ADMIN_KEY) {
    console.warn(`⚠️  Unauthorized admin access attempt from ${req.ip}`);
    return res.status(403).json({ error: "Unauthorized" });
  }

  next();
}

// ====== Health ======
app.get("/healthz", (_req, res) =>
  res.json({
    server: "ok",
    redis: redisConnected && pubClient?.isOpen ? "ok" : "disconnected"
  })
);

// ====== ICE Configuration ======
// Returns STUN/TURN server configuration for WebRTC
// You can configure TURN servers via environment variables for better NAT traversal
app.get("/ice", (_req, res) => {
  const iceServers = [];

  // Google STUN servers (free, always available)
  iceServers.push({ urls: "stun:stun.l.google.com:19302" });
  iceServers.push({ urls: "stun:stun1.l.google.com:19302" });

  // Optional TURN server configuration (recommended for production)
  // Set these environment variables if you have a TURN server:
  // TURN_URL, TURN_USERNAME, TURN_CREDENTIAL
  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  if (turnUrl && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential
    });
  }

  res.json({ iceServers });
});

// ====== Admin Endpoints ======

// Get all reports
app.get("/admin/reports", verifyAdmin, async (req, res) => {
  try {
    const keys = await pubClient.keys("rvchat:reports:*");
    const reports = {};

    for (const key of keys) {
      const ip = key.replace("rvchat:reports:", "");
      const reportList = await pubClient.lRange(key, 0, -1);
      reports[ip] = reportList.map(r => JSON.parse(r));
    }

    res.json({ reports, totalIPs: Object.keys(reports).length });
  } catch (err) {
    console.error("❌ Error fetching reports:", err);
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

// Get all banned IPs
app.get("/admin/bans", verifyAdmin, async (req, res) => {
  try {
    const ips = await pubClient.sMembers("rvchat:banned_ips");
    const bans = [];

    for (const ip of ips) {
      const details = await pubClient.hGetAll(`rvchat:ban_details:${ip}`);
      bans.push({
        ip,
        reason: details.reason || "unknown",
        timestamp: details.timestamp ? parseInt(details.timestamp) : null,
        date: details.timestamp ? new Date(parseInt(details.timestamp)).toISOString() : null
      });
    }

    res.json({ bans, total: bans.length });
  } catch (err) {
    console.error("❌ Error fetching bans:", err);
    res.status(500).json({ error: "Failed to fetch bans" });
  }
});

// Ban an IP
app.post("/admin/ban", verifyAdmin, async (req, res) => {
  try {
    const { ip, reason } = req.body;

    if (!ip || typeof ip !== "string") {
      return res.status(400).json({ error: "Invalid IP address" });
    }

    await banIP(ip, reason || "manual ban");
    res.json({ success: true, ip, reason: reason || "manual ban" });
  } catch (err) {
    console.error("❌ Error banning IP:", err);
    res.status(500).json({ error: "Failed to ban IP" });
  }
});

// Unban an IP
app.post("/admin/unban", verifyAdmin, async (req, res) => {
  try {
    const { ip } = req.body;

    if (!ip || typeof ip !== "string") {
      return res.status(400).json({ error: "Invalid IP address" });
    }

    await unbanIP(ip);
    res.json({ success: true, ip });
  } catch (err) {
    console.error("❌ Error unbanning IP:", err);
    res.status(500).json({ error: "Failed to unban IP" });
  }
});

// Get server stats
app.get("/admin/stats", verifyAdmin, async (req, res) => {
  try {
    const sockets = await io.fetchSockets();
    const queueLength = await pubClient.lLen(QUEUE_KEY);
    const pairCount = await pubClient.hLen(PAIRS_KEY);
    const bannedCount = await pubClient.sCard("rvchat:banned_ips");
    const reportKeys = await pubClient.keys("rvchat:reports:*");

    res.json({
      connectedUsers: sockets.length,
      waitingInQueue: queueLength,
      activePairs: Math.floor(pairCount / 2),
      bannedIPs: bannedCount,
      reportedIPs: reportKeys.length,
      redisConnected: redisConnected && pubClient?.isOpen
    });
  } catch (err) {
    console.error("❌ Error fetching stats:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Clear reports for an IP
app.post("/admin/clear-reports", verifyAdmin, async (req, res) => {
  try {
    const { ip } = req.body;

    if (!ip || typeof ip !== "string") {
      return res.status(400).json({ error: "Invalid IP address" });
    }

    const reportKey = `rvchat:reports:${ip}`;
    await pubClient.del(reportKey);

    res.json({ success: true, ip });
  } catch (err) {
    console.error("❌ Error clearing reports:", err);
    res.status(500).json({ error: "Failed to clear reports" });
  }
});

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
  } catch (err) {
    console.error(`❌ enqueue error for ${id}:`, err.message);
  }
}

async function removeFromQueue(id) {
  try {
    await pubClient.lRem(QUEUE_KEY, 0, id);
  } catch (err) {
    console.error(`❌ removeFromQueue error for ${id}:`, err.message);
  }
}

async function popValidWaiting(excludeId) {
  // Keep popping until we find a connected socket that's not the caller
  const MAX_ATTEMPTS = 50; // Prevent infinite loops if queue gets corrupted
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    const id = await pubClient.lPop(QUEUE_KEY);
    if (!id) return null;
    if (excludeId && id === excludeId) continue;
    const sockets = await io.in(id).fetchSockets();
    if (sockets.length > 0) return id; // valid
    // else loop to skip stale
  }

  console.warn(`⚠️  popValidWaiting hit max attempts (${MAX_ATTEMPTS}), queue may be corrupted`);
  return null;
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
// Connection middleware: Check for banned IPs
io.use((socket, next) => {
  const ip = socket.handshake.address || socket.handshake.headers['x-forwarded-for'] || socket.conn.remoteAddress;

  if (bannedIPs.has(ip)) {
    console.log(`🚫 Blocked banned IP: ${ip}`);
    return next(new Error("banned"));
  }

  socket.ip = ip; // Store IP on socket for later use
  next();
});

// Rate limiting: Track last "next" timestamp per socket
const nextRateLimits = new Map();
const NEXT_COOLDOWN_MS = 1000; // 1 second between next clicks

io.on("connection", (socket) => {
  const id = socket.id;
  console.log(`🔌 ${id} connected (IP: ${socket.ip})`);

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
      // Rate limiting check
      const now = Date.now();
      const lastNext = nextRateLimits.get(id) || 0;
      if (now - lastNext < NEXT_COOLDOWN_MS) {
        socket.emit("error", { message: "Please wait before clicking next again" });
        return;
      }
      nextRateLimits.set(id, now);

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
  socket.on("signal", async (data) => {
    // Input validation
    if (!data || typeof data !== "object") {
      console.warn(`⚠️  Invalid signal data from ${id}`);
      return;
    }

    const { peerId, signal } = data;

    if (!peerId || typeof peerId !== "string") {
      console.warn(`⚠️  Invalid peerId from ${id}`);
      return;
    }

    if (!signal || typeof signal !== "object") {
      console.warn(`⚠️  Invalid signal object from ${id}`);
      return;
    }

    // Optional: size limit to prevent abuse (WebRTC signals are typically small)
    const signalStr = JSON.stringify(signal);
    if (signalStr.length > 50000) { // 50KB limit
      console.warn(`⚠️  Signal too large from ${id}: ${signalStr.length} bytes`);
      return;
    }

    // Safety: only relay if they are currently paired
    try {
      const partner = await getPartner(id);
      if (partner !== peerId) return; // drop stale/spoofed signals
    } catch (err) {
      console.error(`❌ signal validation error for ${id}:`, err.message);
      return;
    }

    io.to(peerId).emit("signal", { peerId: id, signal });
  });

  // --- REPORT ---
  socket.on("report", async ({ peerId, reason }) => {
    try {
      // Validation
      if (!peerId || typeof peerId !== "string") {
        socket.emit("error", { message: "Invalid report" });
        return;
      }

      if (!reason || typeof reason !== "string" || reason.length > 500) {
        socket.emit("error", { message: "Invalid report reason" });
        return;
      }

      // Can only report current partner
      const partner = await getPartner(id);
      if (partner !== peerId) {
        socket.emit("error", { message: "Can only report current partner" });
        return;
      }

      // Get reported user's IP
      const peerSockets = await io.in(peerId).fetchSockets();
      if (!peerSockets.length) return;

      const peerIP = peerSockets[0].ip;
      const reportKey = `rvchat:reports:${peerIP}`;

      // Store report in Redis
      const reportData = JSON.stringify({
        reportedSocketId: peerId,
        reportedIP: peerIP,
        reportedBy: id,
        reporterIP: socket.ip,
        reason,
        timestamp: Date.now(),
      });

      await pubClient.rPush(reportKey, reportData);
      await pubClient.expire(reportKey, 86400); // 24 hour window

      console.log(`📢 Report: ${id} (${socket.ip}) reported ${peerId} (${peerIP}) for: ${reason}`);

      // Check report threshold
      const reportCount = await pubClient.lLen(reportKey);
      const AUTO_BAN_THRESHOLD = 5;

      if (reportCount >= AUTO_BAN_THRESHOLD) {
        console.log(`⚠️  Auto-ban triggered for IP ${peerIP} (${reportCount} reports)`);
        await banIP(peerIP, `auto-ban: ${reportCount} reports in 24h`);
      }

      socket.emit("report-submitted", { success: true });
    } catch (e) {
      console.error("report error:", e);
      socket.emit("error", { message: "Failed to submit report" });
    }
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

      // Cleanup rate limit tracking
      nextRateLimits.delete(id);
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

// ====== Graceful Shutdown ======
async function gracefulShutdown(signal) {
  console.log(`\n⚠️  ${signal} received, starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    console.log("✅ HTTP server closed");
  });

  // Close all socket connections
  io.close(() => {
    console.log("✅ Socket.IO server closed");
  });

  // Close Redis connections
  try {
    await Promise.all([
      pubClient.quit(),
      subClient.quit()
    ]);
    console.log("✅ Redis connections closed");
  } catch (err) {
    console.error("❌ Error closing Redis:", err);
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
