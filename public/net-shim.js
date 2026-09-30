// window.claude 互換の通信レイヤー（オンライン対戦用）
// ゲーム本体は window.claude.use('db' | 'user' | 'room') を呼ぶので、同じ形のAPIを
// 自前サーバー（server.js の /ws）へのWebSocket通信で提供する。
(function () {
  'use strict';

  // ---- 本人を識別する秘密トークン（この端末のブラウザに保存）----
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function randomToken() {
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }
  let secret = lsGet('nd-secret');
  if (!secret) { secret = randomToken(); lsSet('nd-secret', secret); }

  function netError(code, message) { const e = new Error(message || code); e.code = code; return e; }

  // ---- 接続管理（自動再接続・再購読）----
  let ws = null;
  let ready = false;
  let uid = null;
  let reqSeq = 0;
  let retryMs = 500;
  let readyWaiters = [];
  const pending = new Map();   // id -> { resolve, reject }
  const subscriptions = new Map(); // subId -> { path, onNext }
  const joinedRooms = new Map();   // roomName -> RoomHandle

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function connect() {
    ready = false;
    try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => {
      retryMs = 500;
      rawRequest('hello', { secret, name: lsGet('nd-name') || '' }).then(res => {
        uid = res.uid;
        ready = true;
        // 再接続時：購読と在室を張り直す
        subscriptions.forEach((s, subId) => rawRequest('sub', { path: s.path, subId }).catch(() => {}));
        joinedRooms.forEach(r => r._rejoin());
        const ws_ = readyWaiters; readyWaiters = [];
        ws_.forEach(f => f.resolve());
      }).catch(e => { console.warn('[net] hello failed', e); });
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'res') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(netError(m.error.code, m.error.message));
        else p.resolve(m.ok || {});
      } else if (m.t === 'snap') {
        const s = subscriptions.get(m.subId);
        if (s) s.onNext({ exists: !!m.exists, data: () => (m.data == null ? undefined : JSON.parse(JSON.stringify(m.data))) });
      } else if (m.t === 'peers') {
        const r = joinedRooms.get(m.room);
        if (r) r._onPeers(m);
      }
    };
    ws.onclose = () => {
      ready = false;
      pending.forEach(p => p.reject(netError('unavailable', 'connection lost')));
      pending.clear();
      joinedRooms.forEach(r => r._onDisconnect());
      scheduleReconnect();
    };
    ws.onerror = () => { /* onclose で処理 */ };
  }
  function scheduleReconnect() {
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 8000);
  }

  function rawRequest(op, body) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return reject(netError('unavailable', 'not connected'));
      const id = ++reqSeq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(Object.assign({ op, id }, body)));
    });
  }
  function whenReady(timeoutMs) {
    if (ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { resolve };
      readyWaiters.push(w);
      if (timeoutMs) setTimeout(() => {
        const i = readyWaiters.indexOf(w);
        if (i >= 0) { readyWaiters.splice(i, 1); reject(netError('unavailable', 'connect timeout')); }
      }, timeoutMs);
    });
  }
  async function request(op, body) {
    await whenReady(15000);
    return rawRequest(op, body);
  }

  // ---- db ----
  let subSeq = 0;
  function docRef(path) {
    return {
      path,
      async get() {
        const r = await request('get', { path });
        return { exists: !!r.exists, data: () => (r.data == null ? undefined : r.data) };
      },
      async set(data) { await request('set', { path, data }); },
      async update(data) { await request('update', { path, data }); },
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

  // ---- user ----
  const user = {
    async id() { await whenReady(15000); return uid; },
    async can() { return true; },
    async profiles(ids) {
      const r = await request('profiles', { ids });
      return r.profiles || {};
    }
  };

  // ---- room（在室確認と合図）----
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
    joinedRooms.delete(this.name);
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

  // 表示名（相手の画面に出る名前）
  window.NumberDuelNet = {
    getName() { return lsGet('nd-name') || ''; },
    setName(name) {
      name = String(name || '').trim().slice(0, 16);
      lsSet('nd-name', name);
      if (ready && name) rawRequest('setName', { name }).catch(() => {});
    }
  };

  connect();
})();
