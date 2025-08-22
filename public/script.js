// public/script.js

const statusEl  = document.getElementById('status');
const nextBtn   = document.getElementById('nextBtn');
const localVid  = document.getElementById('localVideo');
const remoteVid = document.getElementById('remoteVideo');

// If same-origin, keep undefined. If your UI is on another origin, set the full URL.
// const SIGNAL_URL = "https://your-app.ondigitalocean.app";
const SIGNAL_URL = undefined;

const socket = io(SIGNAL_URL, {
  transports: ["websocket"],
  upgrade: false,
  withCredentials: true,
});

let pc, localStream, peerId, isInitiator;
let pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // default

localVid.muted = true;
localVid.playsInline = true;
remoteVid.playsInline = true;

async function loadIce() {
  try {
    const r = await fetch("/ice", { cache: "no-store" });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg && Array.isArray(cfg.iceServers)) {
        pcConfig = cfg;
        console.log("ICE servers:", pcConfig);
      }
    }
  } catch (e) {
    console.warn("ICE load failed, using default STUN only:", e);
  }
}

async function init() {
  try {
    await loadIce();

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVid.srcObject = localStream;
    await localVid.play().catch(() => {});
    socket.emit('join');
  } catch (err) {
    statusEl.textContent = '❌ Camera/Mic error: ' + err.message;
  }
}

nextBtn.addEventListener('click', () => {
  if (pc) { pc.close(); pc = null; }
  remoteVid.srcObject = null;

  socket.emit('leave');
  statusEl.textContent = '⏳ Looking for a new partner…';
  socket.emit('join');
  nextBtn.disabled = true;
});

socket.on('connect', () => console.log('✅ socket connected', socket.id));
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

  nextBtn.disabled = false;

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
      console.warn('ICE add error (race ok):', e.message);
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
