// public/script.js (full replacement)

const statusEl  = document.getElementById('status');
const nextBtn   = document.getElementById('nextBtn');
const localVid  = document.getElementById('localVideo');
const remoteVid = document.getElementById('remoteVideo');

// IMPORTANT: force pure WebSocket so DO's LB doesn't break polling sessions.
// If this page is served by the same app, leave SIGNAL_URL undefined (same-origin).
// If your frontend is on another domain, set it explicitly:
// const SIGNAL_URL = "https://your-do-app.ondigitalocean.app";
const SIGNAL_URL = undefined;

const socket = io(SIGNAL_URL, {
  transports: ["websocket"], // <— key: skip polling entirely
  upgrade: false,
  withCredentials: true
});

// WebRTC config
const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let pc, localStream, peerId, isInitiator;

// Small autoplay helpers
localVid.muted = true;
localVid.playsInline = true;
remoteVid.playsInline = true;

async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVid.srcObject = localStream;
    await localVid.play().catch(() => {}); // ignore autoplay errors
    socket.emit('join');
  } catch (err) {
    statusEl.textContent = '❌ Camera/Mic error: ' + err.message;
  }
}

nextBtn.addEventListener('click', () => {
  // 1) tear down current connection
  if (pc) {
    pc.close();
    pc = null;
  }
  remoteVid.srcObject = null;

  // 2) tell server and re-queue
  socket.emit('leave');
  statusEl.textContent = '⏳ Looking for a new partner…';
  socket.emit('join');

  // disable until paired again
  nextBtn.disabled = true;
});

socket.on('connect', () => {
  console.log('✅ socket connected', socket.id);
});

socket.on('connect_error', (err) => {
  console.error('socket connect_error', err);
  statusEl.textContent = '⚠️ Connection issue. Retrying…';
});

socket.on('waiting', () => {
  statusEl.textContent = '⏳ Waiting for a partner…';
  nextBtn.disabled = true;
});

socket.on('paired', async ({ peerId: id, initiator }) => {
  peerId = id;
  isInitiator = initiator;
  statusEl.textContent = '✅ Paired! ' + (initiator ? 'Sending offer…' : 'Awaiting offer…');

  // once paired, allow “Next”
  nextBtn.disabled = false;

  // build new RTCPeerConnection
  pc = new RTCPeerConnection(pcConfig);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { peerId, signal: { candidate } });
  };

  pc.ontrack = ({ streams: [stream] }) => {
    remoteVid.srcObject = stream;
    remoteVid.play?.().catch(() => {});
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { peerId, signal: { sdp: pc.localDescription } });
  }
});

socket.on('signal', async ({ peerId: from, signal }) => {
  if (!pc) {
    // late joiner: build PC now
    peerId = from;
    statusEl.textContent = '🔧 Setting up connection…';

    pc = new RTCPeerConnection(pcConfig);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('signal', { peerId, signal: { candidate } });
    };
    pc.ontrack = ({ streams: [stream] }) => {
      remoteVid.srcObject = stream;
      remoteVid.play?.().catch(() => {});
    };
  }

  if (signal.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    if (signal.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { peerId, signal: { sdp: pc.localDescription } });
    }
  } else if (signal.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (e) {
      console.warn('ICE add error (ignored if race):', e.message);
    }
  }
});

socket.on('partner-disconnected', () => {
  statusEl.textContent = '⚠️ Stranger left. Click “Next Stranger” to find someone else.';
  if (pc) pc.close();
  pc = null;
  remoteVid.srcObject = null;
  nextBtn.disabled = false;
});

init();
