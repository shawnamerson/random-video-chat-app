// --- elements ---
const statusEl   = document.getElementById('status');
const actionBtn  = document.getElementById('actionBtn'); // Start -> Next
const stopBtn    = document.getElementById('stopBtn');
const localVid   = document.getElementById('localVideo');
const remoteVid  = document.getElementById('remoteVideo');

// --- socket.io: force WebSocket only (DO load balancer safe) ---
const SIGNAL_URL = undefined; // same-origin; set to "https://<your-app>.ondigitalocean.app" if different origin
const socket = io(SIGNAL_URL, {
  transports: ["websocket"],
  upgrade: false,
  withCredentials: true,
});

// --- webrtc config (TURN/STUN pulled from /ice) ---
let pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let pc, localStream, peerId, isInitiator;

// --- matching state machine ---
let matchingActive = false;  // true when user wants continuous matching
let currentlyPaired = false; // true when we have a partner

// --- video autoplay helpers ---
localVid.muted = true;
localVid.playsInline = true;
remoteVid.playsInline = true;

// -----------------------------
// UI state helpers
// -----------------------------
function setStatus(msg) { statusEl.textContent = msg; }

function setStoppedUI() {
  actionBtn.textContent = 'Start';
  actionBtn.disabled = false;
  stopBtn.disabled = true;
}

function setSearchingUI() {
  actionBtn.textContent = 'Next';
  actionBtn.disabled = false;
  stopBtn.disabled = false;
}

function setConnectedUI() {
  actionBtn.textContent = 'Next';
  actionBtn.disabled = false;
  stopBtn.disabled = false;
}

// -----------------------------
// ICE config from server
// -----------------------------
async function loadIce() {
  try {
    const r = await fetch('/ice', { cache: 'no-store' });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg && Array.isArray(cfg.iceServers)) {
        pcConfig = cfg;
        console.log('ICE servers:', pcConfig);
      }
    }
  } catch (e) {
    console.warn('ICE load failed; using default STUN only:', e);
  }
}

// -----------------------------
// Media init on page load
// -----------------------------
async function initMedia() {
  try {
    await loadIce();
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVid.srcObject = localStream;
    await localVid.play().catch(()=>{});
    setStatus('Ready. Click Start to connect with a stranger.');
    setStoppedUI(); // Start enabled, Stop disabled
  } catch (err) {
    setStatus('❌ Camera/Mic error: ' + err.message);
    actionBtn.disabled = true;
    stopBtn.disabled = true;
  }
}

// -----------------------------
// Matching controls
// -----------------------------
function startMatching() {
  matchingActive = true;
  // Immediately go searching; "Start" turns into "Next"
  setSearchingUI();
  setStatus('⏳ Looking for a partner…');
  socket.emit('join');
}

function nextStranger() {
  // Skip current (if any) and requeue
  teardownPeer();
  remoteVid.srcObject = null;
  socket.emit('leave');
  setStatus('⏳ Finding the next partner…');
  socket.emit('join');
  setSearchingUI();
}

function stopMatching() {
  matchingActive = false;
  // Leave queue and tear down any connection
  teardownPeer();
  remoteVid.srcObject = null;
  socket.emit('leave');
  setStatus('Stopped. Click Start when you’re ready.');
  setStoppedUI();
}

function teardownPeer() {
  currentlyPaired = false;
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    try { pc.close(); } catch {}
    pc = null;
  }
}

// -----------------------------
// Button wiring
// -----------------------------
actionBtn.addEventListener('click', () => {
  if (!matchingActive) {
    // Start -> engage continuous matching
    startMatching();
  } else {
    // Already matching: this button means Next
    nextStranger();
  }
});

stopBtn.addEventListener('click', () => {
  if (matchingActive) stopMatching();
});

// -----------------------------
// Socket.io events
// -----------------------------
socket.on('connect', () => {
  console.log('✅ socket connected', socket.id);
});

socket.on('connect_error', (err) => {
  console.error('socket connect_error', err);
  setStatus('⚠️ Connection issue. Retrying…');
});

socket.on('waiting', () => {
  // We only care if the user is in matching mode
  if (!matchingActive) return;
  setStatus('⏳ Waiting for a partner…');
  setSearchingUI();
});

socket.on('paired', async ({ peerId: id, initiator }) => {
  if (!matchingActive) {
    // If user pressed Stop right before pairing came in, exit early
    socket.emit('leave');
    return;
  }

  peerId = id;
  isInitiator = initiator;
  currentlyPaired = true;

  setStatus('✅ Paired! ' + (initiator ? 'Sending offer…' : 'Awaiting offer…'));
  setConnectedUI();

  // create RTCPeerConnection
  pc = new RTCPeerConnection(pcConfig);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { peerId, signal: { candidate } });
  };
  pc.ontrack = ({ streams: [stream] }) => {
    remoteVid.srcObject = stream;
    remoteVid.play?.().catch(()=>{});
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { peerId, signal: { sdp: pc.localDescription } });
  }
});

socket.on('signal', async ({ peerId: from, signal }) => {
  if (!pc) {
    // Late signal; build PC if we are still matching
    if (!matchingActive) return;
    peerId = from;

    pc = new RTCPeerConnection(pcConfig);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('signal', { peerId, signal: { candidate } });
    };
    pc.ontrack = ({ streams: [stream] }) => {
      remoteVid.srcObject = stream;
      remoteVid.play?.().catch(()=>{});
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
  currentlyPaired = false;
  setStatus('⚠️ Stranger left.');
  teardownPeer();
  remoteVid.srcObject = null;

  // Auto-queue NEXT if the user is still in matching mode
  if (matchingActive) {
    setStatus('⚠️ Stranger left. ⏳ Finding the next partner…');
    socket.emit('join');
    setSearchingUI();
  } else {
    setStoppedUI();
  }
});

// -----------------------------
// Boot
// -----------------------------
initMedia();
