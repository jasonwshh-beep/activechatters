import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const PORT = Number(process.env.PORT || 3000);
const KICK_CHANNEL = String(process.env.KICK_CHANNEL || '').replace(/^https?:\/\/kick\.com\//i, '').replace('@', '').replace(/\/$/, '').trim();
const MANUAL_CHATROOM_ID = String(process.env.KICK_CHATROOM_ID || '').trim();
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
const CHANNEL_AVATAR_URL = String(process.env.CHANNEL_AVATAR_URL || '').trim();
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const avatarCache = new Map();
const state = {
  channel: KICK_CHANNEL, chatroomId: MANUAL_CHATROOM_ID || null, connected: false,
  chatters: new Map(), lastWinner: null, lastWinnerAvatar: null,
  channelAvatar: CHANNEL_AVATAR_URL || null, rolling: false, lastError: null,
  winnerMessages: []
};

app.use(express.json());
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/overlay', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));

function activeDetails(now = Date.now()) {
  return [...state.chatters.values()]
    .filter(x => now - x.lastActiveAt < ACTIVE_WINDOW_MS)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map(x => ({ username: x.username, avatar: x.avatar || null, lastActiveAt: x.lastActiveAt }));
}
function publicState() {
  const now = Date.now();
  const details = activeDetails(now);
  const nextExpiryAt = details.length ? Math.min(...details.map(x => x.lastActiveAt + ACTIVE_WINDOW_MS)) : null;
  return {
    channel: state.channel, chatroomId: state.chatroomId, connected: state.connected,
    count: details.length, participants: details.map(x => x.username), participantDetails: details,
    activeWindowMs: ACTIVE_WINDOW_MS, serverNow: now, nextExpiryAt,
    lastWinner: state.lastWinner, lastWinnerAvatar: state.lastWinnerAvatar,
    channelAvatar: state.channelAvatar, rolling: state.rolling,
    lastError: state.lastError, winnerMessages: state.winnerMessages.slice(0, 20)
  };
}
function broadcast() { io.emit('state', publicState()); }
function pruneInactive() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let changed = false;
  for (const [key, chatter] of state.chatters) {
    if (chatter.lastActiveAt <= cutoff) { state.chatters.delete(key); changed = true; }
  }
  if (changed) broadcast();
}
setInterval(pruneInactive, 1000).unref();

function requirePin(req, res, next) {
  if (String(req.headers['x-admin-pin'] || req.body?.pin || '') !== ADMIN_PIN) return res.status(403).json({ ok: false, error: 'Incorrect admin PIN' });
  next();
}
function normalize(value) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; }
function payloadData(event) { try { return typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return null; } }
function usernameOf(p) { return p?.sender?.username || p?.sender?.name || p?.user?.username || p?.username || p?.sender_username || p?.message?.sender?.username || null; }
function avatarOf(p) { return p?.sender?.profile_pic || p?.sender?.profile_picture || p?.sender?.avatar || p?.user?.profile_pic || p?.user?.profile_picture || p?.user?.avatar || p?.message?.sender?.profile_pic || p?.message?.sender?.avatar || null; }
function messageOf(p) { return p?.content || p?.message?.content || (typeof p?.message === 'string' ? p.message : '') || p?.text || p?.body || ''; }
function avatarFromChannel(data) { return data?.user?.profile_pic || data?.user?.profile_picture || data?.user?.avatar || data?.profile_pic || data?.profile_picture || data?.avatar || null; }

async function lookupAvatar(username) {
  const key = String(username).toLowerCase();
  if (avatarCache.has(key)) return avatarCache.get(key);
  for (const version of ['v2', 'v1']) {
    try {
      const response = await fetch(`https://kick.com/api/${version}/channels/${encodeURIComponent(username)}`, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: `https://kick.com/${username}` } });
      if (!response.ok) continue;
      const avatar = avatarFromChannel(await response.json());
      if (avatar) { avatarCache.set(key, avatar); return avatar; }
    } catch {}
  }
  avatarCache.set(key, null);
  return null;
}
async function fillAvatar(username) {
  const key = String(username).toLowerCase();
  const chatter = state.chatters.get(key);
  if (!chatter || chatter.avatar) return;
  const avatar = await lookupAvatar(username);
  if (!avatar || !state.chatters.has(key)) return;
  state.chatters.get(key).avatar = avatar;
  if (state.lastWinner?.toLowerCase() === key) state.lastWinnerAvatar = avatar;
  broadcast();
}
function markActive(username, avatar = null, at = Date.now()) {
  const display = normalize(String(username || ''));
  if (!display) return;
  const key = display.toLowerCase();
  const existing = state.chatters.get(key);
  if (existing) {
    existing.username = display; existing.lastActiveAt = at;
    if (avatar) existing.avatar = avatar;
  } else state.chatters.set(key, { username: display, avatar: avatar || null, lastActiveAt: at });
  if (!(avatar || existing?.avatar)) fillAvatar(display).catch(() => {});
  io.emit('chatter-active', { username: display, state: publicState() });
  broadcast();
}
function handleChat(payload) {
  const username = usernameOf(payload);
  const avatar = avatarOf(payload);
  const message = normalize(messageOf(payload));
  if (!username || !message) return;
  if (!CHANNEL_AVATAR_URL && username.toLowerCase() === KICK_CHANNEL.toLowerCase() && avatar) state.channelAvatar = avatar;
  markActive(username, avatar);
  if (state.lastWinner && !state.rolling && username.toLowerCase() === state.lastWinner.toLowerCase()) {
    const item = { username, message, at: new Date().toISOString() };
    state.winnerMessages.unshift(item); state.winnerMessages.length = Math.min(state.winnerMessages.length, 20);
    io.emit('winner-message', { message: item, state: publicState() });
  }
}

async function resolveChatroomId() {
  if (MANUAL_CHATROOM_ID) return MANUAL_CHATROOM_ID;
  if (!KICK_CHANNEL) throw new Error('Missing KICK_CHANNEL Railway variable.');
  for (const version of ['v2', 'v1']) {
    try {
      const response = await fetch(`https://kick.com/api/${version}/channels/${encodeURIComponent(KICK_CHANNEL)}`, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: `https://kick.com/${KICK_CHANNEL}` } });
      if (!response.ok) continue;
      const data = await response.json();
      const id = data?.chatroom?.id || data?.livestream?.chatroom?.id || data?.chatroom_id;
      if (id) return String(id);
    } catch {}
  }
  throw new Error('Could not resolve Kick chatroom. Add KICK_CHATROOM_ID in Railway variables.');
}

let ws, reconnectTimer, reconnectAttempt = 0;
function reconnect() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connectKick, Math.min(30000, 1000 * 2 ** reconnectAttempt++)); }
async function connectKick() {
  clearTimeout(reconnectTimer);
  try { state.chatroomId = await resolveChatroomId(); state.lastError = null; }
  catch (error) { state.connected = false; state.lastError = error.message; broadcast(); reconnect(); return; }
  ws = new WebSocket(PUSHER_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  ws.on('open', () => { state.connected = true; state.lastError = null; reconnectAttempt = 0; broadcast(); });
  ws.on('message', buffer => {
    let event; try { event = JSON.parse(buffer.toString()); } catch { return; }
    if (event.event === 'pusher:connection_established') {
      for (const channel of [`chatrooms.${state.chatroomId}.v2`, `chatroom.${state.chatroomId}`]) ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel } }));
    } else if (event.event === 'pusher:ping') ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
    else if (event.event === 'App\\Events\\ChatMessageEvent' || event.event === 'App\\Events\\MessageSentEvent') handleChat(payloadData(event));
  });
  ws.on('close', () => { state.connected = false; broadcast(); reconnect(); });
  ws.on('error', error => { state.connected = false; state.lastError = error.message; broadcast(); });
}

io.on('connection', socket => socket.emit('state', publicState()));
app.get('/api/state', (_req, res) => res.json(publicState()));
app.post('/api/reset', requirePin, (_req, res) => {
  state.chatters.clear(); state.lastWinner = null; state.lastWinnerAvatar = null; state.winnerMessages = []; state.rolling = false;
  io.emit('reset-wheel', publicState()); broadcast(); res.json({ ok: true, state: publicState() });
});
app.post('/api/manual-entry', requirePin, (req, res) => { markActive(req.body?.username, req.body?.avatar || null); res.json({ ok: true, state: publicState() }); });
app.post('/api/roll', requirePin, async (_req, res) => {
  pruneInactive();
  let details = activeDetails();
  if (!details.length) return res.status(400).json({ ok: false, error: 'No chatters have spoken in the last 5 minutes.' });
  await Promise.all(details.slice(0, 100).map(async d => { if (!d.avatar) d.avatar = await lookupAvatar(d.username).catch(() => null); }));
  const winnerDetail = details[Math.floor(Math.random() * details.length)];
  state.lastWinner = winnerDetail.username; state.lastWinnerAvatar = winnerDetail.avatar || null; state.winnerMessages = []; state.rolling = true;
  const names = details.map(x => x.username); while (names.length < 24) names.push(details[Math.floor(Math.random() * details.length)].username);
  const event = { durationMs: 5000, winner: winnerDetail.username, winnerAvatar: winnerDetail.avatar, names, participants: details.map(x => x.username), participantDetails: details, count: details.length, activeWindowMs: ACTIVE_WINDOW_MS };
  io.emit('roll-start', event); broadcast();
  setTimeout(() => { state.rolling = false; io.emit('roll-finish', event); broadcast(); }, 5000);
  res.json({ ok: true, winner: winnerDetail.username, eligibleCount: details.length });
});

server.listen(PORT, '0.0.0.0', () => { console.log(`Kick Active Chatter Giveaway running on port ${PORT}`); connectKick(); });
