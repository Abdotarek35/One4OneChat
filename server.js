const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');
const { Redis } = require('@upstash/redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- Storage backend ---------------------------------------------------
// If Upstash credentials are set, all queue/session/report state lives in
// Redis, so it survives server restarts and is ready for multiple server
// instances later. If not configured, we fall back to the original
// in-memory arrays/Maps so the app still runs for local testing.
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;
const useRedis = !!redis;

if (!useRedis) {
  console.warn(
    'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — using in-memory ' +
    'state. Queues, sessions, and reports will reset on every restart.'
  );
}

const MODES = ['text', 'video', 'voice'];
const SESSION_TTL_SECONDS = 3600; // safety net so a crashed socket doesn't leak forever

// In-memory fallback storage (only used when Redis isn't configured)
const memQueues = { text: [], video: [], voice: [] };
const memSessions = new Map();
const memModes = new Map();
const memReports = [];

async function queuePush(mode, socketId) {
  if (useRedis) return redis.rpush(`queue:${mode}`, socketId);
  memQueues[mode].push(socketId);
}

async function queuePop(mode) {
  if (useRedis) return redis.lpop(`queue:${mode}`);
  return memQueues[mode].shift() || null;
}

async function queueRemove(mode, socketId) {
  if (useRedis) return redis.lrem(`queue:${mode}`, 0, socketId);
  memQueues[mode] = memQueues[mode].filter((id) => id !== socketId);
}

async function sessionSet(socketId, data) {
  if (useRedis) {
    return redis.set(`session:${socketId}`, JSON.stringify(data), { ex: SESSION_TTL_SECONDS });
  }
  memSessions.set(socketId, data);
}

async function sessionGet(socketId) {
  if (useRedis) {
    const raw = await redis.get(`session:${socketId}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  return memSessions.get(socketId) || null;
}

async function sessionDelete(socketId) {
  if (useRedis) return redis.del(`session:${socketId}`);
  memSessions.delete(socketId);
}

async function modeSet(socketId, mode) {
  if (useRedis) return redis.set(`mode:${socketId}`, mode, { ex: SESSION_TTL_SECONDS });
  memModes.set(socketId, mode);
}

async function modeGet(socketId) {
  if (useRedis) return (await redis.get(`mode:${socketId}`)) || 'video';
  return memModes.get(socketId) || 'video';
}

async function modeDelete(socketId) {
  if (useRedis) return redis.del(`mode:${socketId}`);
  memModes.delete(socketId);
}

async function reportPush(report) {
  if (useRedis) return redis.rpush('reports', JSON.stringify(report));
  memReports.push(report);
}

// --- Hands the client a fresh set of STUN/TURN servers ------------------
// The Cloudflare TURN secret NEVER leaves this server.
app.get('/turn-credentials', async (req, res) => {
  const keyId = process.env.CF_TURN_KEY_ID;
  const apiToken = process.env.CF_TURN_KEY_API_TOKEN;
  const fallback = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  if (!keyId || !apiToken) {
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
        body: JSON.stringify({ ttl: 86400 }),
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

// --- Matching engine ------------------------------------------------------
async function tryMatch(socket, mode) {
  const validMode = MODES.includes(mode) ? mode : 'video';
  await modeSet(socket.id, validMode);

  // Make sure this socket isn't already queued in any mode
  for (const m of MODES) {
    await queueRemove(m, socket.id);
  }

  const partnerId = await queuePop(validMode);

  if (partnerId) {
    const partnerSocket = io.sockets.sockets.get(partnerId);

    if (!partnerSocket || !partnerSocket.connected) {
      // Partner disconnected while waiting (or is on another server
      // instance we can't reach directly) — try the next one
      return tryMatch(socket, validMode);
    }

    const roomId = randomUUID();
    socket.join(roomId);
    partnerSocket.join(roomId);

    await sessionSet(socket.id, { roomId, partnerId: partnerSocket.id, mode: validMode });
    await sessionSet(partnerSocket.id, { roomId, partnerId: socket.id, mode: validMode });

    socket.emit('matched', { roomId, initiator: true, mode: validMode });
    partnerSocket.emit('matched', { roomId, initiator: false, mode: validMode });
  } else {
    await queuePush(validMode, socket.id);
    socket.emit('waiting');
  }
}

async function leaveRoom(socket, notifyPartner = true) {
  const info = await sessionGet(socket.id);
  if (info) {
    await sessionDelete(socket.id);
    await sessionDelete(info.partnerId);
    socket.leave(info.roomId);
    if (notifyPartner) {
      io.to(info.partnerId).emit('partner-left');
    }
  }
  for (const m of MODES) {
    await queueRemove(m, socket.id);
  }
}

// --- Moderation -------------------------------------------------------
// Tries Gemini first (Google AI Studio — free, no credit card required),
// then falls back to OpenAI's Moderation endpoint if that's configured
// instead. If neither key is set, messages are allowed through
// unmoderated so the PoC still runs — but that means it is NOT safe to
// point real strangers at yet.
async function moderateText(text) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (geminiKey) return moderateWithGemini(text, geminiKey);
  if (openaiKey) return moderateWithOpenAI(text, openaiKey);
  return { flagged: false };
}

async function moderateWithGemini(text, apiKey) {
  const prompt =
    'You are a content moderation classifier for a random stranger-chat app. ' +
    'Reply with ONLY raw JSON and nothing else: {"flagged": true} or {"flagged": false}. ' +
    'Flag sexual content involving minors, explicit sexual content, hate speech, ' +
    'harassment, threats of violence, or attempts to solicit contact info from a minor. ' +
    'Do NOT flag mild profanity or ordinary conversation.\n\n' +
    `Message to classify: ${JSON.stringify(text)}`;

  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 20 },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return { flagged: !!parsed.flagged };
  } catch (err) {
    console.error('Gemini moderation check failed, allowing message through:', err.message);
    return { flagged: false };
  }
}

async function moderateWithOpenAI(text, apiKey) {
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

// --- Socket handlers -----------------------------------------------------
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('find-match', (mode) => tryMatch(socket, mode));

  socket.on('skip', async () => {
    const lastMode = await modeGet(socket.id);
    await leaveRoom(socket);
    tryMatch(socket, lastMode);
  });

  // Relay WebRTC offer/answer/ICE candidates to the partner only.
  // The server never looks at this payload's content.
  socket.on('signal', async (data) => {
    const info = await sessionGet(socket.id);
    if (info) {
      io.to(info.partnerId).emit('signal', data);
    }
  });

  // Text chat is relayed through the server on purpose (not P2P),
  // so it can be moderated — this is where that actually happens now.
  socket.on('chat-message', async (text) => {
    const info = await sessionGet(socket.id);
    if (!info || typeof text !== 'string' || !text.trim()) return;

    const clean = text.slice(0, 500);
    const { flagged } = await moderateText(clean);

    if (flagged) {
      socket.emit('message-blocked');
      return; // never relay flagged content
    }

    io.to(info.partnerId).emit('chat-message', clean);
  });

  socket.on('report', async (reason) => {
    const lastMode = await modeGet(socket.id);
    const info = await sessionGet(socket.id);
    if (info) {
      await reportPush({
        reportedSocketId: info.partnerId,
        reporterSocketId: socket.id,
        reason: typeof reason === 'string' ? reason.slice(0, 100) : 'unspecified',
        at: new Date().toISOString(),
      });
      console.log('REPORT logged for', info.partnerId);
    }
    await leaveRoom(socket);
    tryMatch(socket, lastMode);
  });

  socket.on('disconnect', async () => {
    await leaveRoom(socket);
    await modeDelete(socket.id);
    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`One4One PoC running on http://localhost:${PORT}`);
  console.log(`Storage backend: ${useRedis ? 'Upstash Redis' : 'in-memory (not persistent)'}`);
});
