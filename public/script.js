const socket    = io();
const statusEl  = document.getElementById('status');
const nextBtn   = document.getElementById('nextBtn');
const localVid  = document.getElementById('localVideo');
const remoteVid = document.getElementById('remoteVideo');

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pc, localStream, peerId, isInitiator;

async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVid.srcObject = localStream;
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
    await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
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
