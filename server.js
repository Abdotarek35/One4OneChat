const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Hands the client a fresh set of STUN/TURN servers.
// The Cloudflare TURN secret NEVER leaves this server.
app.get('/turn-credentials', async (req, res) => {
  const keyId = process.env.CF_TURN_KEY_ID;
  const apiToken = process.env.CF_TURN_KEY_API_TOKEN;
  const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  if (!keyId || !apiToken) {
    // Cloudflare not configured yet — fall back to STUN-only so the app
    // still works, just without a relay for hard networks.
    return res.json(fallback);
  }

  try {
    const cfRes = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }), // credential valid for 24h
      }
    );

    if (!cfRes.ok) throw new Error(`Cloudflare returned ${cfRes.status}`);
    const data = await cfRes.json();
    res.json(data);
  } catch (err) {
    console.error('TURN credential fetch failed, falling back to STUN only:', err.message);
    res.json(fallback);
  }
});

// --- In-memory state (PoC only — replace with Redis before real scale) ---
const MODES = ['text', 'video', 'voice'];
const waitingQueues = { text: [], video: [], voice: [] };  // one queue per mode
const activeRooms = new Map();                              // socketId -> { roomId, partnerId, mode }
const socketModes = new Map();                               // socketId -> last requested mode

function tryMatch(socket, mode) {
  const validMode = MODES.includes(mode) ? mode : 'video';
  socketModes.set(socket.id, validMode);

  // Make sure this socket isn't already queued in any mode
  MODES.forEach((m) => {
    waitingQueues[m] = waitingQueues[m].filter((id) => id !== socket.id);
  });

  const queue = waitingQueues[validMode];

  if (queue.length > 0) {
    const partnerId = queue.shift();
    const partnerSocket = io.sockets.sockets.get(partnerId);

    if (!partnerSocket || !partnerSocket.connected) {
      // Partner disconnected while waiting — try the next one
      return tryMatch(socket, validMode);
    }

    const roomId = randomUUID();
    socket.join(roomId);
    partnerSocket.join(roomId);

    activeRooms.set(socket.id, { roomId, partnerId: partnerSocket.id, mode: validMode });
    activeRooms.set(partnerSocket.id, { roomId, partnerId: socket.id, mode: validMode });

    // One side has to be the WebRTC "offerer" — arbitrarily pick the one
    // who was already waiting.
    socket.emit('matched', { roomId, initiator: true, mode: validMode });
    partnerSocket.emit('matched', { roomId, initiator: false, mode: validMode });
  } else {
    queue.push(socket.id);
    socket.emit('waiting');
  }
}

function leaveRoom(socket, notifyPartner = true) {
  const info = activeRooms.get(socket.id);
  if (info) {
    activeRooms.delete(socket.id);
    activeRooms.delete(info.partnerId);
    socket.leave(info.roomId);
    if (notifyPartner) {
      io.to(info.partnerId).emit('partner-left');
    }
  }
  MODES.forEach((m) => {
    waitingQueues[m] = waitingQueues[m].filter((id) => id !== socket.id);
  });
}

const reports = []; // PoC only — becomes a real `reports` table once the DB is wired in

// Checks text against OpenAI's free Moderation endpoint. If no API key is
// set, messages are allowed through unmoderated so the PoC still runs —
// but that means it is NOT safe to point real strangers at yet.
async function moderateText(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { flagged: false };

  try {
    const res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
    });
    if (!res.ok) throw new Error(`Moderation API returned ${res.status}`);
    const data = await res.json();
    const result = data.results && data.results[0];
    return { flagged: !!(result && result.flagged) };
  } catch (err) {
    console.error('Moderation check failed, allowing message through:', err.message);
    return { flagged: false };
  }
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('find-match', (mode) => tryMatch(socket, mode));

  socket.on('skip', () => {
    const lastMode = socketModes.get(socket.id) || 'video';
    leaveRoom(socket);
    tryMatch(socket, lastMode);
  });

  // Relay WebRTC offer/answer/ICE candidates to the partner only.
  // The server never looks at this payload's content.
  socket.on('signal', (data) => {
    const info = activeRooms.get(socket.id);
    if (info) {
      io.to(info.partnerId).emit('signal', data);
    }
  });

  // Text chat is relayed through the server on purpose (not P2P),
  // so it can be moderated — this is where that actually happens now.
  socket.on('chat-message', async (text) => {
    const info = activeRooms.get(socket.id);
    if (!info || typeof text !== 'string' || !text.trim()) return;

    const clean = text.slice(0, 500);
    const { flagged } = await moderateText(clean);

    if (flagged) {
      socket.emit('message-blocked');
      return; // never relay flagged content
    }

    io.to(info.partnerId).emit('chat-message', clean);
  });

  socket.on('report', (reason) => {
    const lastMode = socketModes.get(socket.id) || 'video';
    const info = activeRooms.get(socket.id);
    if (info) {
      reports.push({
        reportedSocketId: info.partnerId,
        reporterSocketId: socket.id,
        reason: typeof reason === 'string' ? reason.slice(0, 100) : 'unspecified',
        at: new Date().toISOString(),
      });
      console.log('REPORT:', reports[reports.length - 1]);
    }
    leaveRoom(socket);
    tryMatch(socket, lastMode);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
    socketModes.delete(socket.id);
    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`One4One PoC running on http://localhost:${PORT}`);
});
