// window.claude 互換の通信レイヤー（オンライン対戦用・サーバー不要版）
//
// ゲーム本体は window.claude.use('db' | 'user' | 'room') を呼ぶので、同じ形のAPIを
// ブラウザ同士の直接通信（WebRTC / PeerJS）で提供する。
//  - 部屋を作った人（ホスト）のブラウザが共有データ（matches/…）と在室情報を持ち、相手からの読み書きに応える
//  - 手札などの非公開データ（data/users/<自分のID>/…）は自分のブラウザ内（localStorage）にだけ保存し、送信しない
//  - PeerJSの公開サーバーは「部屋コード → ホストの接続先」を見つけるためだけに使う
(function () {
  'use strict';

  const PEER_PREFIX = 'numberduel-v1-';
  const HOST_STORE_PREFIX = 'nd-host:';
  const PRIV_PREFIX = 'nd-priv:';
  const STORE_TTL_MS = 24 * 3600 * 1000;
  const MAX_DOC_BYTES = 64 * 1024;
  const PING_MS = 3000;        // 生存確認の間隔
  const DEAD_MS = 10000;       // これだけ応答がなければ切断とみなす
  const CONNECT_TIMEOUT_MS = 8000;

  // ---------------- 小物 ----------------
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function lsKeys() { try { return Object.keys(localStorage); } catch (e) { return []; } }
  function randomToken(n) {
    const a = new Uint8Array(n || 12);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }
  function netError(code, message) { const e = new Error(message || code); e.code = code; return e; }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function later(fn) { setTimeout(fn, 0); }

  // この端末のプレイヤーID（ブラウザに保存）
  let uid = lsGet('nd-uid');
  if (!uid) { uid = 'u' + randomToken(12); lsSet('nd-uid', uid); }

  // 古いホストデータ・非公開データの掃除
  (function cleanup() {
    const now = Date.now();
    lsKeys().filter(k => k.startsWith(HOST_STORE_PREFIX) || k.startsWith(PRIV_PREFIX)).forEach(k => {
      try { const d = JSON.parse(lsGet(k)); if (!d || now - (d.savedAt || 0) > STORE_TTL_MS) lsDel(k); } catch (e) { lsDel(k); }
    });
  })();

  // PeerJS の接続先（?peer=https://example.com:9000/path で自前のPeerServerも使える）
  function peerOptions() {
    const opts = { debug: 0 };
    let custom = null;
    try { custom = new URLSearchParams(location.search).get('peer'); } catch (e) {}
    if (custom) {
      try {
        const u = new URL(custom);
        opts.host = u.hostname;
        opts.secure = u.protocol === 'https:';
        opts.port = Number(u.port) || (opts.secure ? 443 : 80);
        opts.path = u.pathname || '/';
      } catch (e) { console.warn('[net] bad ?peer=', custom); }
    }
    return opts;
  }

  // ---------------- ホスト側：共有データと在室情報の管理 ----------------
  // （以前の server.js と同じ処理をホストのブラウザ内で行う）
  const PATH_RE = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64}){0,7}$/;
  function HostCore(code) {
    this.code = code;
    this.key = HOST_STORE_PREFIX + code;
    let saved = null;
    try { saved = JSON.parse(lsGet(this.key)); } catch (e) {}
    this.docs = new Map(Object.entries((saved && saved.docs) || {}));
    this.names = new Map(Object.entries((saved && saved.names) || {}));
    this.subs = new Map();   // path -> Set<{client, subId}>
    this.room = new Map();   // client -> presence（在室中の人）
    this.saveTimer = null;
  }
  HostCore.hasSaved = function (code) { return !!lsGet(HOST_STORE_PREFIX + code); };
  HostCore.prototype.save = function () {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      lsSet(this.key, JSON.stringify({ savedAt: Date.now(), docs: Object.fromEntries(this.docs), names: Object.fromEntries(this.names) }));
    }, 300);
  };
  HostCore.prototype.checkPath = function (p) {
    if (typeof p !== 'string' || !PATH_RE.test(p)) throw netError('invalid_argument', 'bad path');
    const seg = p.split('/');
    // この部屋の共有データだけを扱う（非公開データは各自のブラウザ内）
    if (seg[0] !== 'matches' || seg[1] !== this.code) throw netError('permission_denied');
  };
  HostCore.prototype.checkData = function (data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw netError('invalid_argument', 'data must be an object');
    if (JSON.stringify(data).length > MAX_DOC_BYTES) throw netError('quota_exceeded');
  };
  HostCore.prototype.snapMsg = function (subId, p) {
    const d = this.docs.get(p);
    return { t: 'snap', subId, exists: !!d, data: d ? clone(d) : null };
  };
  HostCore.prototype.write = function (p, data) {
    this.docs.set(p, clone(data));
    this.save();
    const set = this.subs.get(p);
    if (set) set.forEach(s => s.client.send(this.snapMsg(s.subId, p)));
  };
  HostCore.prototype.broadcastPeers = function (change) {
    const peers = [...this.room.entries()].map(([c, presence]) => ({ uid: c.uid, connId: c.connId, presence }));
    this.room.forEach((_, c) => c.send({ t: 'peers', room: c.roomName, peers, joined: change.joined || [], updated: change.updated || [], left: change.left || [] }));
  };
  HostCore.prototype.handle = function (client, m) {
    switch (m.op) {
      case 'hello':
        if (typeof m.uid !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(m.uid)) throw netError('invalid_argument', 'bad uid');
        client.uid = m.uid;
        this.setName(client.uid, m.name);
        return { uid: client.uid };
      case 'get': {
        this.checkPath(m.path);
        const d = this.docs.get(m.path);
        return { exists: !!d, data: d ? clone(d) : null };
      }
      case 'set':
        this.checkPath(m.path); this.checkData(m.data);
        this.write(m.path, m.data);
        return {};
      case 'update': {
        this.checkPath(m.path); this.checkData(m.data);
        const merged = Object.assign({}, this.docs.get(m.path) || {}, m.data);
        this.checkData(merged);
        this.write(m.path, merged);
        return {};
      }
      case 'sub': {
        this.checkPath(m.path);
        const subId = String(m.subId);
        if (!this.subs.has(m.path)) this.subs.set(m.path, new Set());
        const entry = { client, subId };
        this.subs.get(m.path).add(entry);
        client.subs.set(subId, { path: m.path, entry });
        client.send(this.snapMsg(subId, m.path));
        return {};
      }
      case 'unsub':
        this.dropSub(client, String(m.subId));
        return {};
      case 'profiles': {
        const out = {};
        (Array.isArray(m.ids) ? m.ids.slice(0, 20) : []).forEach(id => {
          if (typeof id === 'string') out[id] = { id, name: this.names.get(id) || '' };
        });
        return { profiles: out };
      }
      case 'setName':
        this.setName(client.uid, m.name);
        return {};
      case 'join':
        client.roomName = String(m.room || '');
        this.room.set(client, m.presence || null);
        later(() => this.broadcastPeers({ joined: [client.connId] })); // 応答(connId)の後に届くように
        return { connId: client.connId };
      case 'presence':
        if (!this.room.has(client)) throw netError('not_found', 'not in room');
        if (JSON.stringify(m.presence || null).length > 4096) throw netError('quota_exceeded');
        this.room.set(client, m.presence);
        this.broadcastPeers({ updated: [client.connId] });
        return {};
      case 'leave':
        this.leaveRoom(client);
        return {};
      case 'ping':
        return {};
      default:
        throw netError('invalid_argument', 'unknown op');
    }
  };
  HostCore.prototype.setName = function (id, name) {
    const n = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16);
    if (id && n) { this.names.set(id, n); this.save(); }
  };
  HostCore.prototype.dropSub = function (client, subId) {
    const s = client.subs.get(subId);
    if (!s) return;
    const set = this.subs.get(s.path);
    if (set) { set.delete(s.entry); if (!set.size) this.subs.delete(s.path); }
    client.subs.delete(subId);
  };
  HostCore.prototype.leaveRoom = function (client) {
    if (!this.room.has(client)) return;
    this.room.delete(client);
    this.broadcastPeers({ left: [client.connId] });
  };
  HostCore.prototype.disconnect = function (client) {
    [...client.subs.keys()].forEach(id => this.dropSub(client, id));
    this.leaveRoom(client);
  };
  HostCore.prototype.dispatch = function (client, m) {
    let reply;
    if (m.op !== 'hello' && !client.uid) reply = { error: { code: 'unauthenticated' } };
    else {
      try { reply = { ok: this.handle(client, m) }; }
      catch (e) { reply = { error: { code: e.code || 'internal', message: e.message } }; }
    }
    client.send(Object.assign({ t: 'res', id: m.id }, reply));
  };

  // ---------------- 通信セッション（ホスト or ゲスト）----------------
  let session = null;   // { code, role, peer, core?, conn?, closed }
  let ready = false;
  let readyWaiters = [];
  let reqSeq = 0;
  let connSeq = 0;
  const pending = new Map();        // id -> { resolve, reject }
  const subscriptions = new Map();  // subId -> { path, onNext }
  const joinedRooms = new Map();    // roomName -> RoomHandle
  let sendToSession = null;         // (msg) => void

  // セッションから届いたメッセージ（応答・更新通知・在室情報）
  function onSessionMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'res') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(netError(m.error.code, m.error.message));
      else p.resolve(m.ok || {});
    } else if (m.t === 'snap') {
      const s = subscriptions.get(m.subId);
      if (s) s.onNext({ exists: !!m.exists, data: () => (m.data == null ? undefined : clone(m.data)) });
    } else if (m.t === 'peers') {
      const r = joinedRooms.get(m.room);
      if (r) r._onPeers(m);
    }
  }

  function rawRequest(op, body) {
    return new Promise((resolve, reject) => {
      if (!sendToSession) return reject(netError('unavailable', 'not connected'));
      const id = ++reqSeq;
      pending.set(id, { resolve, reject });
      try { sendToSession(Object.assign({ op, id }, body)); }
      catch (e) { pending.delete(id); reject(netError('unavailable', 'send failed')); }
    });
  }
  function whenReady(timeoutMs) {
    if (ready) return Promise.resolve();
    if (!session) return Promise.reject(netError('unavailable', 'no room'));
    return new Promise((resolve, reject) => {
      const w = { resolve };
      readyWaiters.push(w);
      setTimeout(() => {
        const i = readyWaiters.indexOf(w);
        if (i >= 0) { readyWaiters.splice(i, 1); reject(netError('unavailable', 'connect timeout')); }
      }, timeoutMs || 15000);
    });
  }
  // 通信が切れていても、つながり直すまで待って送る。
  // 書き込み(set/update)は同じ内容を送り直しても結果が変わらないので、つながるまで粘る（最大10分）
  async function request(op, body) {
    const durable = op === 'set' || op === 'update';
    const deadline = Date.now() + (durable ? 600000 : 15000);
    for (;;) {
      try {
        await whenReady(Math.max(1000, deadline - Date.now()));
        return await rawRequest(op, body);
      } catch (e) {
        if (!e || e.code !== 'unavailable' || !session || Date.now() >= deadline) throw e;
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  // 接続（または再接続）できた時：名乗って、購読と在室を張り直す
  async function onTransportUp() {
    const res = await rawRequest('hello', { uid, name: lsGet('nd-name') || '' });
    if (res.uid !== uid) throw netError('internal', 'uid mismatch');
    ready = true;
    subscriptions.forEach((s, subId) => rawRequest('sub', { path: s.path, subId }).catch(() => {}));
    joinedRooms.forEach(r => r._rejoin());
    const ws = readyWaiters; readyWaiters = [];
    ws.forEach(w => w.resolve());
  }
  function onTransportDown() {
    ready = false;
    sendToSession = null;
    pending.forEach(p => p.reject(netError('unavailable', 'connection lost')));
    pending.clear();
    joinedRooms.forEach(r => r._onDisconnect());
  }

  function closeSession() {
    const s = session;
    session = null;
    if (!s) return;
    s.closed = true;
    clearTimeout(s.retryTimer);
    onTransportDown();
    if (s.core && s.core.saveTimer) { clearTimeout(s.core.saveTimer); s.core.saveTimer = null; s.core.save(); }
    try { s.peer && s.peer.destroy(); } catch (e) {}
  }

  function newPeer(id) {
    if (typeof window.Peer !== 'function') throw netError('unavailable', 'PeerJS not loaded');
    return id ? new window.Peer(id, peerOptions()) : new window.Peer(peerOptions());
  }

  // ホストとして部屋を開く（部屋コード＝接続先ID）。IDが使用中なら 'taken'
  function startHost(code) {
    return new Promise((resolve, reject) => {
      closeSession();
      const s = { code, role: 'host', closed: false, core: new HostCore(code) };
      session = s;
      let peer;
      try { peer = newPeer(PEER_PREFIX + code); } catch (e) { session = null; return reject(e); }
      s.peer = peer;
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        closeSession();
        reject(netError('unavailable', 'signaling timeout'));
      }, 15000);

      // ホスト自身もクライアントの1人として HostCore に話しかける
      const self = { uid: null, connId: 'c' + (++connSeq), subs: new Map(), send: (msg) => later(() => onSessionMessage(msg)) };

      peer.on('open', () => {
        if (opened || s.closed) return;
        opened = true;
        clearTimeout(timer);
        sendToSession = (msg) => later(() => s.core.dispatch(self, clone(msg)));
        onTransportUp().then(() => resolve(), reject);
      });
      peer.on('connection', (conn) => {
        const client = { uid: null, connId: 'c' + (++connSeq), subs: new Map(), send: (msg) => { if (conn.open) conn.send(msg); } };
        let lastSeen = Date.now();
        let gone = false;
        const bye = () => {
          if (gone) return;
          gone = true;
          clearInterval(watch);
          if (!s.closed) s.core.disconnect(client);
          try { conn.close(); } catch (e) {}
        };
        // 相手のページが閉じられても通知が来ないことがあるので、ping が途絶えたら切断扱いにする
        const watch = setInterval(() => { if (s.closed || Date.now() - lastSeen > DEAD_MS) bye(); }, 2000);
        conn.on('data', (m) => {
          lastSeen = Date.now();
          if (!s.closed && !gone && m && typeof m === 'object') s.core.dispatch(client, m);
        });
        conn.on('close', bye);
        conn.on('error', bye);
      });
      peer.on('disconnected', () => {
        // 公開サーバーとの接続だけが切れた（相手との直接通信は続く）→ 新しい相手を受け付けられるよう再接続
        if (!s.closed) setTimeout(() => { if (!s.closed && peer.disconnected && !peer.destroyed) peer.reconnect(); }, 1500);
      });
      peer.on('error', (err) => {
        if (opened) { console.warn('[net] host peer error', err && err.type); return; }
        clearTimeout(timer);
        closeSession();
        if (err && err.type === 'unavailable-id') reject(netError('taken', 'room code in use'));
        else reject(netError('unavailable', (err && err.type) || 'peer error'));
      });
    });
  }

  // ゲストとして部屋に接続する。見つからなければ 'not_found'
  function startGuest(code) {
    return new Promise((resolve, reject) => {
      closeSession();
      const s = { code, role: 'guest', closed: false, everConnected: false, retryMs: 1000 };
      session = s;
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (err) { closeSession(); reject(err); } else resolve();
      };
      let peer;
      try { peer = newPeer(null); } catch (e) { session = null; return reject(e); }
      s.peer = peer;
      const timer = setTimeout(() => settle(netError('not_found', 'connect timeout')), 20000);

      function scheduleRetry() {
        if (s.closed) return;
        clearTimeout(s.retryTimer);
        s.retryTimer = setTimeout(connectToHost, s.retryMs);
        s.retryMs = Math.min(s.retryMs * 2, 8000);
      }
      function connectToHost() {
        if (s.closed) return;
        if (peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch (e) {} }
        if (!peer.open) { scheduleRetry(); return; }
        const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        s.conn = conn;
        let lastSeen = Date.now();
        let beat = null;
        const down = () => {
          if (s.conn !== conn) return;
          s.conn = null;
          clearInterval(beat);
          clearTimeout(openTimer);
          try { conn.close(); } catch (e) {}
          onTransportDown();
          scheduleRetry();
        };
        // ホストが再読み込みした直後などは古い接続先に向かって開かないことがある → 打ち切ってやり直す
        const openTimer = setTimeout(() => { if (!conn.open) down(); }, CONNECT_TIMEOUT_MS);
        conn.on('open', () => {
          if (s.closed || s.conn !== conn) return;
          clearTimeout(openTimer);
          s.retryMs = 1000;
          s.everConnected = true;
          lastSeen = Date.now();
          sendToSession = (msg) => { if (!conn.open) throw new Error('closed'); conn.send(msg); };
          // 生存確認：ホストのページが閉じられても通知が来ないことがあるため
          beat = setInterval(() => {
            if (Date.now() - lastSeen > DEAD_MS) return down();
            if (conn.open) conn.send({ op: 'ping', id: 0 });
          }, PING_MS);
          onTransportUp().then(() => { clearTimeout(timer); settle(null); }, (e) => settle(e));
        });
        conn.on('data', (m) => { lastSeen = Date.now(); if (s.conn === conn) onSessionMessage(m); });
        conn.on('close', down);
        conn.on('error', down);
      }
      peer.on('open', () => { if (!s.conn || !s.conn.open) connectToHost(); });
      peer.on('disconnected', () => {
        if (!s.closed) setTimeout(() => { if (!s.closed && peer.disconnected && !peer.destroyed) peer.reconnect(); }, 1500);
      });
      peer.on('error', (err) => {
        const type = err && err.type;
        if (type === 'peer-unavailable') {
          if (!s.everConnected) { clearTimeout(timer); settle(netError('not_found', 'room not found')); }
          else { s.conn = null; onTransportDown(); scheduleRetry(); } // ホストが一時的にいない → 待ってつなぎ直す
        } else if (!s.everConnected && (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'browser-incompatible')) {
          clearTimeout(timer);
          settle(netError('unavailable', type));
        } else {
          console.warn('[net] guest peer error', type);
        }
      });
    });
  }

  // ---------------- db ----------------
  function isPrivate(path) { return /^data\/users\//.test(path); }
  function privKey(path) { return PRIV_PREFIX + path; }
  function checkPrivate(path) {
    if (path.split('/')[2] !== uid) throw netError('permission_denied');
  }
  function readPrivate(path) {
    try { const w = JSON.parse(lsGet(privKey(path))); return w ? w.data : null; } catch (e) { return null; }
  }
  function writePrivate(path, data) {
    lsSet(privKey(path), JSON.stringify({ savedAt: Date.now(), data: clone(data) }));
  }
  let subSeq = 0;
  function docRef(path) {
    return {
      path,
      async get() {
        if (isPrivate(path)) {
          checkPrivate(path);
          const d = readPrivate(path);
          return { exists: d != null, data: () => (d == null ? undefined : clone(d)) };
        }
        const r = await request('get', { path });
        return { exists: !!r.exists, data: () => (r.data == null ? undefined : r.data) };
      },
      async set(data) {
        if (isPrivate(path)) { checkPrivate(path); writePrivate(path, data); return; }
        await request('set', { path, data });
      },
      async update(data) {
        if (isPrivate(path)) {
          checkPrivate(path);
          writePrivate(path, Object.assign({}, readPrivate(path) || {}, data));
          return;
        }
        await request('update', { path, data });
      },
      onSnapshot(onNext, onError) {
        const subId = 's' + (++subSeq);
        subscriptions.set(subId, { path, onNext });
        if (ready) rawRequest('sub', { path, subId }).catch(e => { if (onError) onError(e); });
        return () => {
          subscriptions.delete(subId);
          if (ready) rawRequest('unsub', { subId }).catch(() => {});
        };
      }
    };
  }
  const db = { doc: docRef };

  // ---------------- user ----------------
  const user = {
    async id() { return uid; },
    async can() { return true; },
    async profiles(ids) {
      const r = await request('profiles', { ids });
      return r.profiles || {};
    }
  };

  // ---------------- room（在室確認と合図）----------------
  function RoomHandle(name) {
    this.name = name;
    this.connId = null;
    this.presenceValue = null;
    this.listeners = new Set();
    this.left = false;
  }
  RoomHandle.prototype._toPeer = function (p) {
    return { isMe: p.connId === this.connId, by: p.uid, presence: p.presence };
  };
  RoomHandle.prototype._onPeers = function (m) {
    const peers = m.peers.map(p => this._toPeer(p));
    const byConn = new Map(m.peers.map(p => [p.connId, p]));
    const pick = (ids) => ids.map(id => byConn.get(id)).filter(Boolean).map(p => this._toPeer(p));
    const ch = { peers, joined: pick(m.joined || []), updated: pick(m.updated || []), left: (m.left || []).map(id => ({ isMe: false, connId: id })) };
    this.listeners.forEach(l => { try { l.onNext(ch); } catch (e) { console.warn(e); } });
  };
  RoomHandle.prototype._onDisconnect = function () {
    this.connId = null;
    this.listeners.forEach(l => { if (l.onError) try { l.onError(netError('unavailable')); } catch (e) {} });
  };
  RoomHandle.prototype._rejoin = function () {
    if (this.left) return;
    rawRequest('join', { room: this.name, presence: this.presenceValue }).then(r => { this.connId = r.connId; }).catch(() => {});
  };
  RoomHandle.prototype.presence = async function (value) {
    this.presenceValue = value;
    await request('presence', { room: this.name, presence: value });
  };
  RoomHandle.prototype.onPeers = function (onNext, onError) {
    const l = { onNext, onError };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  RoomHandle.prototype.leave = async function () {
    this.left = true;
    this.listeners.clear();
    if (joinedRooms.get(this.name) === this) joinedRooms.delete(this.name);
    if (ready) await rawRequest('leave', { room: this.name }).catch(() => {});
  };
  const room = {
    async join(name) {
      const existing = joinedRooms.get(name);
      if (existing) await existing.leave();
      const h = new RoomHandle(name);
      joinedRooms.set(name, h);
      const r = await request('join', { room: name, presence: null });
      h.connId = r.connId;
      return h;
    }
  };

  const caps = { db, user, room };
  window.claude = {
    use(name) {
      if (!caps[name]) return Promise.reject(netError('not_found', 'unknown capability'));
      return Promise.resolve(caps[name]);
    }
  };

  // ---------------- ゲーム本体から使う部屋の操作 ----------------
  window.NumberDuelNet = {
    isAvailable() { return typeof window.Peer === 'function' && typeof RTCPeerConnection === 'function'; },
    // 新しい部屋のホストになる（コード使用中なら code:'taken' で失敗）
    hostRoom(code) {
      lsDel(HOST_STORE_PREFIX + code); // 以前の同じコードの記録は使わない
      return startHost(code);
    },
    // 部屋に入る：自分がホストだった部屋ならホストとして開き直し、それ以外は相手（ホスト）に接続
    async openRoom(code) {
      if (session && session.code === code && ready) return session.role;
      if (HostCore.hasSaved(code)) {
        // 再読み込み直後は古い接続先IDがしばらく残ることがあるので少し待って再挑戦
        for (let i = 0; ; i++) {
          try { await startHost(code); return 'host'; }
          catch (e) { if (e.code !== 'taken' || i >= 10) throw e; await new Promise(r => setTimeout(r, 3000)); }
        }
      }
      await startGuest(code);
      return 'guest';
    },
    close() { closeSession(); },
    getName() { return lsGet('nd-name') || ''; },
    setName(name) {
      name = String(name || '').trim().slice(0, 16);
      lsSet('nd-name', name);
      if (ready && name) rawRequest('setName', { name }).catch(() => {});
    }
  };
})();
