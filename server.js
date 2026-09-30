// ナンバーデュエル サーバー
//  - public/ 以下の静的ファイル配信
//  - WebSocket (/ws) でオンライン対戦用の共有データ(db)・在室確認(room)・ユーザー情報(user)を提供
//    クライアント側は public/net-shim.js が window.claude 互換のAPIとして包む
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');
const MAX_DOC_BYTES = 64 * 1024;
const MATCH_TTL_MS = 24 * 3600 * 1000; // 最終更新から24時間たった試合データは掃除する

// ---------------- 永続化（JSONファイル） ----------------
let docs = new Map();   // path -> { data, updatedAt }
const names = new Map(); // uid -> 表示名
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  docs = new Map(Object.entries(raw.docs || {}));
  Object.entries(raw.names || {}).forEach(([k, v]) => names.set(k, v));
} catch (e) { /* 初回起動 */ }

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const body = JSON.stringify({ docs: Object.fromEntries(docs), names: Object.fromEntries(names) });
    fs.mkdir(path.dirname(DATA_FILE), { recursive: true }, () => {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFile(tmp, body, (err) => { if (!err) fs.rename(tmp, DATA_FILE, () => {}); });
    });
  }, 500);
}

function cleanup() {
  const now = Date.now();
  let removed = false;
  for (const [p, d] of docs) {
    if (now - (d.updatedAt || 0) > MATCH_TTL_MS) { docs.delete(p); removed = true; }
  }
  if (removed) scheduleSave();
}
cleanup();
setInterval(cleanup, 3600 * 1000).unref();

// ---------------- 静的ファイル ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json'
};

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    if (type.startsWith('image/') || type.startsWith('audio/')) headers['Cache-Control'] = 'public, max-age=86400';
    // 音声のシーク(Range)に対応
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 }));
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  serveStatic(req, res);
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

const subs = new Map();  // docPath -> Set<{ client, subId }>
const rooms = new Map(); // roomName -> Map<client, presence>

const PATH_RE = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64}){0,7}$/;
class ReqError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

// data/users/<uid>/... は本人しか読み書きできない（手札など非公開データ）
function checkAccess(client, p) {
  if (typeof p !== 'string' || !PATH_RE.test(p)) throw new ReqError('invalid_argument', 'bad path');
  const seg = p.split('/');
  if (seg[0] === 'data' && seg[1] === 'users' && seg[2] !== client.uid) throw new ReqError('permission_denied');
}
function checkData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ReqError('invalid_argument', 'data must be an object');
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_DOC_BYTES) throw new ReqError('quota_exceeded');
}

function send(client, msg) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
}
function snapMsg(subId, p) {
  const d = docs.get(p);
  return { t: 'snap', subId, exists: !!d, data: d ? d.data : null };
}
function notifyDoc(p) {
  const set = subs.get(p);
  if (!set) return;
  for (const s of set) send(s.client, snapMsg(s.subId, p));
}
function writeDoc(p, data) {
  docs.set(p, { data, updatedAt: Date.now() });
  scheduleSave();
  notifyDoc(p);
}

function peerList(room) {
  return [...room.entries()].map(([c, presence]) => ({ uid: c.uid, connId: c.connId, presence }));
}
function broadcastPeers(name, change) {
  const room = rooms.get(name);
  if (!room) return;
  const peers = peerList(room);
  for (const c of room.keys()) send(c, { t: 'peers', room: name, peers, joined: change.joined || [], updated: change.updated || [], left: change.left || [] });
}
function leaveRoom(client, name) {
  const room = rooms.get(name);
  if (!room || !room.has(client)) return;
  room.delete(client);
  client.rooms.delete(name);
  if (room.size === 0) rooms.delete(name);
  else broadcastPeers(name, { left: [client.connId] });
}

let connSeq = 0;
const handlers = {
  hello(client, m) {
    const secret = String(m.secret || '');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(secret)) throw new ReqError('invalid_argument', 'bad secret');
    // 公開されるID は秘密トークンのハッシュ（IDを知られても本人になりすませない）
    client.uid = 'u' + crypto.createHash('sha256').update(secret).digest('hex').slice(0, 24);
    if (typeof m.name === 'string') setName(client.uid, m.name);
    return { uid: client.uid, name: names.get(client.uid) || '' };
  },
  get(client, m) {
    checkAccess(client, m.path);
    const d = docs.get(m.path);
    return { exists: !!d, data: d ? d.data : null };
  },
  set(client, m) {
    checkAccess(client, m.path); checkData(m.data);
    writeDoc(m.path, m.data);
    return {};
  },
  update(client, m) {
    checkAccess(client, m.path); checkData(m.data);
    const cur = docs.get(m.path);
    const merged = Object.assign({}, cur ? cur.data : {}, m.data);
    checkData(merged);
    writeDoc(m.path, merged);
    return {};
  },
  sub(client, m) {
    checkAccess(client, m.path);
    const subId = String(m.subId);
    if (!subs.has(m.path)) subs.set(m.path, new Set());
    const entry = { client, subId };
    subs.get(m.path).add(entry);
    client.subs.set(subId, { path: m.path, entry });
    send(client, snapMsg(subId, m.path));
    return {};
  },
  unsub(client, m) {
    const s = client.subs.get(String(m.subId));
    if (s) {
      const set = subs.get(s.path);
      if (set) { set.delete(s.entry); if (!set.size) subs.delete(s.path); }
      client.subs.delete(String(m.subId));
    }
    return {};
  },
  profiles(client, m) {
    const out = {};
    (Array.isArray(m.ids) ? m.ids.slice(0, 20) : []).forEach(id => {
      if (typeof id === 'string') out[id] = { id, name: names.get(id) || '' };
    });
    return { profiles: out };
  },
  setName(client, m) { setName(client.uid, m.name); return {}; },
  join(client, m) {
    const name = String(m.room || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new ReqError('invalid_argument', 'bad room');
    if (!rooms.has(name)) rooms.set(name, new Map());
    rooms.get(name).set(client, m.presence || null);
    client.rooms.add(name);
    setImmediate(() => broadcastPeers(name, { joined: [client.connId] })); // 応答(connId)の後に届くように
    return { connId: client.connId };
  },
  presence(client, m) {
    const name = String(m.room || '');
    const room = rooms.get(name);
    if (!room || !room.has(client)) throw new ReqError('not_found', 'not in room');
    const pres = m.presence;
    if (Buffer.byteLength(JSON.stringify(pres || null)) > 4096) throw new ReqError('quota_exceeded');
    room.set(client, pres);
    broadcastPeers(name, { updated: [client.connId] });
    return {};
  },
  leave(client, m) { leaveRoom(client, String(m.room || '')); return {}; }
};

function setName(uid, name) {
  const n = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16);
  if (n) { names.set(uid, n); scheduleSave(); }
}

wss.on('connection', (ws) => {
  const client = { ws, uid: null, connId: 'c' + (++connSeq), subs: new Map(), rooms: new Set() };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const reply = (body) => send(client, Object.assign({ t: 'res', id: m.id }, body));
    const h = handlers[m.op];
    if (!h) return reply({ error: { code: 'invalid_argument', message: 'unknown op' } });
    if (m.op !== 'hello' && !client.uid) return reply({ error: { code: 'unauthenticated' } });
    try { reply({ ok: h(client, m) }); }
    catch (e) { reply({ error: { code: e.code || 'internal', message: e.message } }); }
  });
  ws.on('close', () => {
    for (const { path: p, entry } of client.subs.values()) {
      const set = subs.get(p);
      if (set) { set.delete(entry); if (!set.size) subs.delete(p); }
    }
    for (const name of [...client.rooms]) leaveRoom(client, name);
  });
});

// 切断検出（ping/pong）
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000).unref();

server.listen(PORT, () => console.log(`ナンバーデュエル: http://localhost:${PORT}`));
