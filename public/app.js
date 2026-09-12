const socket = io();

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const statusEl = document.getElementById('status');
const statusDot = document.getElementById('statusDot');
const startBtn = document.getElementById('startBtn');
const skipBtn = document.getElementById('skipBtn');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const chatForm = document.getElementById('chatForm');
const ageGate = document.getElementById('ageGate');
const ageConfirmBtn = document.getElementById('ageConfirmBtn');
const reportBtn = document.getElementById('reportBtn');
const reportPanel = document.getElementById('reportPanel');
const reasonButtons = document.querySelectorAll('.reason-row');
const reportSubmitBtn = document.getElementById('reportSubmitBtn');
const reportCancelBtn = document.getElementById('reportCancelBtn');
const modeButtons = document.querySelectorAll('.mode-btn');
const videosEl = document.getElementById('videos');
const voiceUi = document.getElementById('voiceUi');
const voiceWaveformBars = document.querySelectorAll('#voiceWaveform span');
const remoteAudioEl = document.getElementById('remoteAudio');
const textModeNote = document.getElementById('textModeNote');

let localStream = null;
let pc = null;
let selectedReason = 'inappropriate_content';
let currentMode = 'video';
let audioContext = null;
let analyser = null;
let waveformRAF = null;

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    modeButtons.forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    currentMode = btn.dataset.mode;
    videosEl.hidden = currentMode !== 'video';
    voiceUi.hidden = currentMode !== 'voice';
    textModeNote.hidden = currentMode !== 'text';
  });
});

// Draws the remote person's real mic input as moving bars — genuine proof
// audio is flowing, not just a decorative animation.
function startWaveform(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 64;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    analyser.getByteFrequencyData(data);
    voiceWaveformBars.forEach((bar, i) => {
      const value = data[i * 4] || 0;
      bar.style.transform = scaleY(${0.3 + (value / 255) * 1.3});
    });
    waveformRAF = requestAnimationFrame(tick);
  }
  tick();
}

function stopWaveform() {
  if (waveformRAF) cancelAnimationFrame(waveformRAF);
  waveformRAF = null;
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  voiceWaveformBars.forEach((bar) => (bar.style.transform = 'scaleY(.3)'));
}

// --- Age gate: self-attestation only, NOT real ID verification ---
if (localStorage.getItem('one4one_age_confirmed') === 'true') {
  ageGate.hidden = true;
}
ageConfirmBtn.addEventListener('click', () => {
  localStorage.setItem('one4one_age_confirmed', 'true');
  ageGate.hidden = true;
});

// Google's public STUN server is the last-resort fallback. The real ICE
// server list is fetched from our own server at /turn-credentials, which
// hands out short-lived Cloudflare TURN credentials — this is what lets
// two people connect across hard networks (corporate wifi, some mobile
// carriers), not just simple home networks. A timeout guards against the
// UI hanging on "Connecting…" forever if that fetch stalls.
function fetchWithTimeout(url, ms) {
  return Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('turn-credentials timeout')), ms)),
  ]);
}

const iceServersPromise = fetchWithTimeout('/turn-credentials', 5000)
  .then((res) => res.json())
  .then((data) => data.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }])
  .catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]);
// Builds the full RTCPeerConnection config. If real TURN servers came back,
// force every call through the relay (iceTransportPolicy: 'relay') so two
// strangers never learn each other's IP address. If only the STUN fallback
// is available, relay-only would break every connection outright, so we
// fall back to 'all' and warn loudly that IP privacy isn't protected yet.
async function getIceConfig() {
  const iceServers = await iceServersPromise;
  const hasTurn = iceServers.some((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some(
      (u) => u.startsWith('turn:') || u.startsWith('turns:')
    )
  );

  if (!hasTurn) {
    console.warn(
      'No TURN server configured — using iceTransportPolicy "all". ' +
      'Chat partners can currently see each other\'s IP addresses. ' +
      'Set CF_TURN_KEY_ID / CF_TURN_KEY_API_TOKEN (see README) to fix this.'
    );
  }

  return {
    iceServers,
    iceTransportPolicy: hasTurn ? 'relay' : 'all',
  };
}

function setStatus(text, state = 'idle') {
  statusEl.textContent = text;
  statusDot.className = 'status-dot' + (state !== 'idle' ?  ${state} : '');
}

function addChatLine(who, text) {
  const bubble = document.createElement('div');
  const kind = who === 'You' ? 'you' : who === 'Stranger' ? 'stranger' : 'system';
  bubble.className = msg ${kind};
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function start() {
  startBtn.disabled = true;
  modeButtons.forEach((b) => (b.disabled = true));

  if (currentMode !== 'text') {
    const constraints = currentMode === 'voice' ? { audio: true } : { audio: true, video: true };
    try {
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      if (currentMode === 'video') {
        localVideo.srcObject = localStream;
      }
    } catch (err) {
      setStatus('Camera/mic permission denied — check browser settings', 'error');
      startBtn.disabled = false;
      modeButtons.forEach((b) => (b.disabled = false));
      return;
    }
  }

  skipBtn.disabled = false;
  reportBtn.disabled = false;
  setStatus('Looking for someone to talk to…', 'waiting');
  socket.emit('find-match', currentMode);
}

let isInitiator = false;
let restartAttempted = false;

async function createPeerConnection() {
  const config = await getIceConfig();
  pc = new RTCPeerConnection(config);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    if (currentMode === 'voice') {
      remoteAudioEl.srcObject = event.streams[0];
      startWaveform(event.streams[0]);
    } else {
      remoteVideo.srcObject = event.streams[0];
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { type: 'ice-candidate', candidate: event.candidate });
    }
  };

  // Only the original offerer drives renegotiation, so both sides don't
  // race to restart the connection at once.
  pc.onnegotiationneeded = async () => {
    if (!isInitiator) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { type: 'offer', sdp: offer });
    } catch (err) {
      console.error('Renegotiation failed', err);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus('Connected', 'connected');
      restartAttempted = false;
    } else if (pc.connectionState === 'disconnected') {
      setStatus('Connection unstable — trying to reconnect…', 'waiting');
    } else if (pc.connectionState === 'failed') {
      if (!restartAttempted) {
        restartAttempted = true;
        setStatus('Reconnecting…', 'waiting');
        pc.restartIce(); // triggers onnegotiationneeded above for the initiator
      } else {
        setStatus('Connection failed — try Skip', 'error');
      }
    }
  };
}

function cleanupPeer() {
  if (pc) {
    pc.close();
    pc = null;
  }
  remoteVideo.srcObject = null;
  remoteAudioEl.srcObject = null;
  stopWaveform();
  }
socket.on('waiting', () => setStatus('Looking for someone to talk to…', 'waiting'));

socket.on('matched', async ({ initiator }) => {
  isInitiator = initiator;
  restartAttempted = false;

  if (currentMode === 'text') {
    setStatus('Matched — say hi!', 'connected');
    return; // no camera/mic involved, chat is already live via the server relay
  }

  setStatus('Matched — connecting…', 'waiting');
  await createPeerConnection();
  // Adding tracks above triggers onnegotiationneeded automatically, which
  // creates and sends the initial offer for the initiator — no need to
  // do it again here (that would send two competing offers).
});

socket.on('signal', async (data) => {
  if (!pc) return;

  if (data.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { type: 'answer', sdp: answer });
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === 'ice-candidate') {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      console.error('Failed to add ICE candidate', err);
    }
  }
});

socket.on('partner-left', () => {
  setStatus('Stranger left — looking for someone new…', 'waiting');
  cleanupPeer();
  socket.emit('find-match', currentMode);
});

socket.on('chat-message', (text) => addChatLine('Stranger', text));

socket.on('message-blocked', () => {
  addChatLine('System', "That message couldn't be sent — it broke community guidelines.");
});

skipBtn.addEventListener('click', () => {
  cleanupPeer();
  setStatus('Skipping…', 'waiting');
  socket.emit('skip');
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', text);
  addChatLine('You', text);
  chatInput.value = '';
});

reasonButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    reasonButtons.forEach((b) => {
      b.classList.remove('selected');
      b.setAttribute('aria-checked', 'false');
    });
    btn.classList.add('selected');
    btn.setAttribute('aria-checked', 'true');
    selectedReason = btn.dataset.value;
  });
});

reportBtn.addEventListener('click', () => {
  reportPanel.hidden = false;
});

reportCancelBtn.addEventListener('click', () => {
  reportPanel.hidden = true;
});

reportSubmitBtn.addEventListener('click', () => {
  socket.emit('report', selectedReason);
  reportPanel.hidden = true;
  cleanupPeer();
  setStatus('Report submitted — looking for someone new…', 'waiting');
});

startBtn.addEventListener('click', start);
