// server.js
const express = require('express');
const http    = require('http');
const path    = require('path');

// 1) socket.io + redis adapter imports
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// 2) CONNECT TO REDIS
//    Use your REDIS_URL env var or default to localhost
const redisUrl = process.env.REDIS_URL || 'redis://default:B4XXyZybEnFw5fC272I7p5BcH5f2TgVp@redis-12699.c11.us-east-1-2.ec2.redns.redis-cloud.com:12699';
const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();

(async () => {
  await pubClient.connect();
  await subClient.connect();

  // 3) HOOK UP THE REDIS ADAPTER
  io.adapter(createAdapter(pubClient, subClient));

  console.log('🗄️  Redis adapter connected');
})();


// 4) YOUR EXISTING PAIRING LOGIC
let waitingSocket = null;
const pairs = {};

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', socket => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on('join', () => {
    if (waitingSocket) {
      const peer = waitingSocket;
      waitingSocket = null;

      socket.emit('paired', { peerId: peer.id, initiator: true });
      peer.emit('paired',   { peerId: socket.id, initiator: false });

      pairs[socket.id] = peer.id;
      pairs[peer.id]   = socket.id;
    } else {
      waitingSocket = socket;
      socket.emit('waiting');
    }
  });

  socket.on('leave', () => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('partner-disconnected', { from: socket.id });
      delete pairs[socket.id];
      delete pairs[partnerId];
    }
    if (waitingSocket?.id === socket.id) {
      waitingSocket = null;
    }
  });

  socket.on('signal', ({ peerId, signal }) => {
    io.to(peerId).emit('signal', { peerId: socket.id, signal });
  });

  socket.on('disconnect', () => {
    console.log(`❌ ${socket.id} disconnected`);
    socket.emit('leave');
    if (waitingSocket?.id === socket.id) {
      waitingSocket = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));
