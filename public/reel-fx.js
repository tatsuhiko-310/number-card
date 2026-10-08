/* =====================================================================
   REEL FX — モーションリール風の演出
   ・HUD（四隅のファインダー・タイムコード・シーン番号）
   ・背景のドットグリッド（波紋が広がるリズム演出）
   ・画面切り替えの横帯ワイプ／対戦開始の 3・2・1／勝敗スタンプ／紙吹雪／リザルトの集計演出
   ゲーム本体からは window.ReelFX 経由で呼ぶ（無くてもゲームは動く）
   ===================================================================== */
(function () {
  'use strict';
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const PALETTE = { orange: '#ff4b2b', lime: '#c9ff2f', violet: '#6b4dff', cyan: '#3fe2f2', paper: '#efebe3', ink: '#0c0c11' };
  const CONFETTI_COLORS = [PALETTE.orange, PALETTE.lime, PALETTE.violet, PALETTE.cyan, '#ff4fb0', PALETTE.paper];
  const SCENES = { start: 1, online: 2, prep: 2, game: 3, result: 4 };
  const t0 = performance.now();
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  // ---------- HUD ----------
  const hud = el('div', 'reel-hud');
  hud.setAttribute('aria-hidden', 'true');
  hud.innerHTML =
    '<i class="rh-c tl"></i><i class="rh-c tr"></i><i class="rh-c bl"></i><i class="rh-c br"></i>' +
    '<span class="rh-t tl">NUMBER WAR — MATCH REEL \'26</span>' +
    '<span class="rh-t tr" id="reelHudTr">1–8 · 15 CHIPS · 2P</span>' +
    '<span class="rh-t bl"><span class="rh-rec"></span><span id="reelHudTc">TC 00:00:00:00</span></span>' +
    '<span class="rh-t br"><span id="reelHudScene">SCENE 01 / 04</span><span class="rh-sq" id="reelHudSq"><i></i><i></i><i></i><i></i></span></span>';
  const hudTr = () => document.getElementById('reelHudTr');
  let scene = 'start';
  let hudInfo = null;

  function setScene(name) {
    scene = name;
    const n = SCENES[name] || 1;
    const sc = document.getElementById('reelHudScene');
    if (sc) sc.textContent = `SCENE ${pad(n)} / 04`;
    const sq = document.getElementById('reelHudSq');
    if (sq) [...sq.children].forEach((i, k) => i.classList.toggle('on', k === n - 1));
    hud.classList.toggle('on-paper', name === 'result');
    updateHudTr();
  }
  function updateHudTr() {
    const tr = hudTr();
    if (!tr) return;
    if ((scene === 'game' || scene === 'result') && hudInfo) tr.textContent = `ROUND ${pad(hudInfo.round)} · POT ${pad(hudInfo.pod)}`;
    else if (scene === 'prep') tr.textContent = 'DECK BUILD · 8 CARDS · 5 COLORS';
    else tr.textContent = '1–8 · 15 CHIPS · 2P';
  }
  function tickTimecode(now) {
    const tc = document.getElementById('reelHudTc');
    if (tc) {
      const ms = now - t0;
      const f = Math.floor((ms % 1000) / (1000 / 60));
      const s = Math.floor(ms / 1000);
      tc.textContent = `TC ${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
    }
  }

  // ---------- 背景：ドットグリッドの波紋 ----------
  const SP = 26;          // ドットの間隔
  const waves = [];       // { x, y, t, c, speed, life }
  let canvas = null, ctx = null, W = 0, H = 0, dpr = 1, dirty = true, paperMode = false;
  let ambientAt = 0, ambientIdx = 0;
  const AMBIENT = [PALETTE.orange, PALETTE.lime, PALETTE.violet, PALETTE.cyan];
  const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

  function resize() {
    if (!canvas) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }
  function pulse(color, x, y, opts) {
    if (reduceMotion || !canvas) return;
    waves.push({ x: x != null ? x : W / 2, y: y != null ? y : H / 2, t: performance.now(), c: hexRgb(color || PALETTE.orange),
      speed: (opts && opts.speed) || 0.55, life: (opts && opts.life) || 2600, amp: (opts && opts.amp) || 1 });
    if (waves.length > 6) waves.shift();
  }
  function drawDots(now) {
    const pm = document.body.classList.contains('reel-paper');
    if (pm !== paperMode) { paperMode = pm; dirty = true; }
    for (let i = waves.length - 1; i >= 0; i--) if (now - waves[i].t > waves[i].life) waves.splice(i, 1);
    if (!dirty && !waves.length) return;
    dirty = !!waves.length;
    ctx.clearRect(0, 0, W, H);
    const base = paperMode ? [20, 19, 26] : [239, 235, 227];
    const baseA = paperMode ? 0.13 : 0.1;
    const ox = (W % SP) / 2, oy = (H % SP) / 2;
    for (let gy = 0, y = oy; y <= H; gy++, y += SP) {
      for (let gx = 0, x = ox; x <= W; gx++, x += SP) {
        let I = 0, col = null;
        for (const w of waves) {
          const age = now - w.t;
          const r = age * w.speed;
          const d = Math.hypot(x - w.x, y - w.y);
          const k = Math.exp(-Math.pow((d - r) / 46, 2)) * (1 - age / w.life) * w.amp;
          if (k > I) { I = k; col = w.c; }
        }
        if (I < 0.04) {
          ctx.fillStyle = `rgba(${base[0]},${base[1]},${base[2]},${baseA})`;
          ctx.fillRect(x - 1, y - 1, 2, 2);
          continue;
        }
        const s = 2 + I * 9;
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${Math.min(1, 0.15 + I * 0.85)})`;
        if ((gx + gy) % 2) {
          ctx.save(); ctx.translate(x, y); ctx.rotate(I * 0.6); ctx.fillRect(-s / 2, -s / 2, s, s); ctx.restore();
        } else {
          ctx.beginPath(); ctx.arc(x, y, s / 2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  // ---------- メインループ ----------
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    if (now - lastFrame < 33) return; // 30fps
    lastFrame = now;
    tickTimecode(now);
    if (!canvas) return;
    if (!reduceMotion && now > ambientAt) {
      ambientAt = now + 5200 + Math.random() * 2200;
      pulse(AMBIENT[ambientIdx++ % AMBIENT.length], Math.random() * W, Math.random() * H, { amp: 0.55, speed: 0.32, life: 3600 });
    }
    drawDots(now);
  }

  // ---------- 画面切り替え：横帯のワイプ ----------
  function wipe() {
    if (reduceMotion) return;
    const w = el('div', 'reel-wipe');
    const n = 12;
    for (let i = 0; i < n; i++) { const b = el('i'); b.style.setProperty('--i', String(i)); w.appendChild(b); }
    document.body.appendChild(w);
    setTimeout(() => w.remove(), 720 + n * 32 + 80);
  }
  const SCREEN_IDS = { start: 'startScreen', online: 'onlineScreen', prep: 'prepScreen', game: 'gameScreen' };
  let lastScreen = null;
  function screen(name) {
    if (lastScreen && lastScreen !== name) {
      wipe();
      window.scrollTo(0, 0); // 前の画面のスクロール位置を持ち越さない
      const target = document.getElementById(SCREEN_IDS[name]);
      if (target && !reduceMotion) {
        target.classList.remove('reel-enter'); void target.offsetWidth; target.classList.add('reel-enter');
        setTimeout(() => target.classList.remove('reel-enter'), 800);
      }
      if (name === 'start') replayTitle();
    }
    lastScreen = name;
    document.body.classList.remove('reel-paper');
    setScene(name);
  }

  // ---------- タイトル ----------
  function typeInto(node, text, speed, delay) {
    if (!node) return;
    if (reduceMotion) { node.textContent = text; return; }
    node.textContent = '';
    let i = 0;
    const step = () => { node.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(step, speed); };
    setTimeout(step, delay || 0);
  }
  function setupTitle() {
    document.querySelectorAll('.rt-word > span').forEach((s, i) => s.style.setProperty('--i', String(i)));
    const k = document.querySelector('.rt-kicker');
    if (k) typeInto(k, k.textContent, 34, 120);
  }
  function replayTitle() {
    const word = document.querySelector('.rt-word');
    if (!word || reduceMotion) return;
    [word, document.querySelector('.rt-sub')].forEach(n => {
      if (!n) return;
      n.querySelectorAll('span').forEach(s => { s.style.animation = 'none'; void s.offsetWidth; s.style.animation = ''; });
      n.style.animation = 'none'; void n.offsetWidth; n.style.animation = '';
    });
    const k = document.querySelector('.rt-kicker');
    if (k) typeInto(k, k.textContent, 34, 200);
  }

  // ---------- 紙吹雪 ----------
  function confetti(x, y, opts) {
    if (reduceMotion) return;
    opts = opts || {};
    const cv = el('canvas', 'reel-confetti');
    document.body.appendChild(cv);
    const c = cv.getContext('2d');
    const r = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    cv.width = w * r; cv.height = h * r; c.setTransform(r, 0, 0, r, 0, 0);
    const N = opts.count || 90;
    const ps = [];
    for (let i = 0; i < N; i++) {
      const a = (opts.spread != null ? -Math.PI / 2 + (Math.random() - 0.5) * opts.spread : Math.random() * Math.PI * 2);
      const v = (opts.power || 9) * (0.45 + Math.random() * 0.75);
      ps.push({
        x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (opts.lift || 2),
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, s: 5 + Math.random() * 7,
        shape: i % 3, col: CONFETTI_COLORS[i % CONFETTI_COLORS.length]
      });
    }
    const start = performance.now();
    const LIFE = opts.life || 2200;
    const frame = (now) => {
      const t = now - start;
      c.clearRect(0, 0, w, h);
      for (const p of ps) {
        p.vy += 0.28; p.vx *= 0.985; p.vy *= 0.985;
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        c.save();
        c.globalAlpha = Math.max(0, 1 - Math.max(0, t - LIFE * 0.6) / (LIFE * 0.4));
        c.translate(p.x, p.y); c.rotate(p.rot); c.fillStyle = p.col;
        if (p.shape === 0) { c.fillRect(-p.s / 2, -p.s / 2, p.s, p.s); }
        else if (p.shape === 1) { c.beginPath(); c.arc(0, 0, p.s / 2, 0, Math.PI * 2); c.fill(); }
        else { c.beginPath(); c.moveTo(0, -p.s / 2); c.lineTo(p.s / 2, p.s / 2); c.lineTo(-p.s / 2, p.s / 2); c.closePath(); c.fill(); }
        c.restore();
      }
      if (t < LIFE) requestAnimationFrame(frame); else cv.remove();
    };
    requestAnimationFrame(frame);
    setTimeout(() => cv.remove(), LIFE + 1500); // 保険
  }

  // 放射状の光線（JACKPOT）
  function rays(host, colors) {
    if (reduceMotion || !host) return;
    const r = el('div', 'reel-rays');
    const n = 28;
    for (let i = 0; i < n; i++) {
      const b = el('i');
      b.style.setProperty('--a', (i * 360 / n + Math.random() * 6) + 'deg');
      b.style.setProperty('--len', (50 + Math.random() * 70) + 'px');
      b.style.setProperty('--r0', (40 + Math.random() * 20) + 'px');
      b.style.setProperty('--d', (Math.random() * 0.12) + 's');
      b.style.setProperty('--c', colors[i % colors.length]);
      r.appendChild(b);
    }
    host.appendChild(r);
    setTimeout(() => r.remove(), 1100);
  }

  // ---------- 対戦開始：3・2・1 ----------
  let cdNode = null, cdTimers = [];
  function countdown(tick) {
    clearCountdown();
    if (reduceMotion) return;
    const ov = el('div', 'reel-cd');
    ov.setAttribute('aria-hidden', 'true');
    ov.innerHTML = '<div class="cd-grid"></div><div class="cd-stage"><div class="cd-floor"></div><div class="cd-shadow"></div><div class="cd-ball"></div><div class="cd-cap"></div></div>';
    document.body.appendChild(ov);
    cdNode = ov;
    const stage = ov.querySelector('.cd-stage');
    const ball = ov.querySelector('.cd-ball');
    const shadow = ov.querySelector('.cd-shadow');
    // ボールの着地（アニメの46%地点）が数字の切り替わりに重なるようにずらす
    [ball, shadow].forEach(n => { n.style.animationDuration = '0.7s'; n.style.animationDelay = '-0.322s'; });
    const cap = ov.querySelector('.cd-cap');
    typeInto(cap, 'FIG.01 — SQUASH & STRETCH', 28, 60);
    const later = (ms, fn) => cdTimers.push(setTimeout(fn, ms));
    const showNum = (n, fill, step) => {
      const old = stage.querySelector('.reel-cd-num');
      if (old) old.remove();
      const num = el('div', 'reel-cd-num' + (fill ? ' fill' : ''), String(n));
      stage.insertBefore(num, stage.firstChild);
      if (tick) { try { tick(step); } catch (e) { /* 音が鳴らなくても続ける */ } }
    };
    showNum(3, true, 0);
    later(700, () => showNum(2, false, 2));
    later(1400, () => { showNum(1, false, 4); typeInto(cap, 'ROUND 01 — GET READY', 26, 0); });
    later(2100, () => {
      stage.remove();
      ov.classList.add('go');
      ov.appendChild(el('div', 'cd-flash'));
      const go = el('div', 'cd-go');
      go.innerHTML = 'FIGHT!'.split('').map((ch, i) => `<span style="--i:${i}">${ch}</span>`).join('') + '<small>ROUND 01 · NUMBER WAR</small>';
      ov.appendChild(go);
      if (tick) { try { tick(7); } catch (e) { /* noop */ } }
      confetti(window.innerWidth / 2, window.innerHeight / 2, { count: 70, power: 11 });
    });
    later(2850, () => {
      ov.classList.add('out');
      pulse(PALETTE.lime, window.innerWidth / 2, window.innerHeight / 2, { speed: 0.8, life: 2200 });
    });
    later(3400, clearCountdown);
    // タップで飛ばせる
    ov.addEventListener('pointerdown', () => { ov.classList.add('out'); cdTimers.forEach(clearTimeout); cdTimers = [setTimeout(clearCountdown, 450)]; });
  }
  function clearCountdown() {
    cdTimers.forEach(clearTimeout); cdTimers = [];
    if (cdNode) { cdNode.remove(); cdNode = null; }
  }

  // ---------- ラウンドの勝敗スタンプ ----------
  const STAMP = {
    win:          { word: 'WIN',     color: PALETTE.orange, cap: (i) => `ROUND TAKEN · Δ ${i.diff}` },
    lose:         { word: 'LOSE',    color: PALETTE.violet, cap: (i) => `WEIGHT → POT ${pad(i.pod)}` },
    jackpot:      { word: 'JACKPOT', color: PALETTE.lime,   cap: () => 'Δ = 1 · ALL IN · POT → YOU' },
    'jackpot-op': { word: 'JACKPOT', color: PALETTE.violet, cap: () => 'Δ = 1 · POT → RIVAL' },
    draw:         { word: 'DRAW',    color: PALETTE.cyan,   cap: (i) => `OVERLAP() · POT ${pad(i.pod)}` }
  };
  function stamp(kind, info) {
    const def = STAMP[kind];
    const board = document.getElementById('board');
    if (!def || !board || !board.offsetParent) return;
    info = info || {};
    const r = board.getBoundingClientRect();
    const mid = board.querySelector('.zone-mid');
    const m = mid ? mid.getBoundingClientRect() : r;
    const cy = m.top + m.height * 0.47;
    pulse(def.color, r.left + r.width / 2, cy, { speed: 0.7, life: 2000, amp: kind.startsWith('jackpot') ? 1 : 0.8 });
    if (reduceMotion) return;
    document.querySelectorAll('.reel-stamp').forEach(n => n.remove());
    const s = el('div', 'reel-stamp ' + kind);
    Object.assign(s.style, { left: (r.left - 10) + 'px', width: (r.width + 20) + 'px', top: (cy - 60) + 'px', height: '120px' });
    s.innerHTML = `<div class="rs-band"></div><div class="reel-stamp-word">${def.word}</div><div class="reel-stamp-cap">${(info.hack ? 'HACKED · ' : '') + def.cap(info)}</div>`;
    document.body.appendChild(s);
    if (kind === 'jackpot') {
      rays(s, [PALETTE.lime, PALETTE.orange, PALETTE.violet, PALETTE.cyan]);
      confetti(r.left + r.width / 2, cy, { count: 80, power: 10 });
    }
    setTimeout(() => s.remove(), 1050);
  }

  // ---------- リザルト ----------
  let resultTimers = [];
  function countUp(node, to, delay, dur) {
    if (!node) return;
    if (reduceMotion) { node.textContent = to; return; }
    node.textContent = '0';
    node.classList.add('counting');
    resultTimers.push(setTimeout(() => {
      const s = performance.now();
      const f = (now) => {
        const k = Math.min(1, (now - s) / dur);
        const e = 1 - Math.pow(1 - k, 4);
        node.textContent = String(Math.round(to * e));
        if (k < 0.85) node.classList.add('counting'); else node.classList.remove('counting');
        if (k < 1) requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    }, delay));
  }
  function result(o) {
    const ov = document.getElementById('overlay');
    if (!ov) return;
    resultTimers.forEach(clearTimeout); resultTimers = [];
    wipe();
    document.body.classList.add('reel-paper');
    setScene('result');
    ov.classList.remove('play');
    void ov.offsetWidth;
    ov.classList.add('play');
    ov.classList.toggle('lose-theme', o.outcome === 'op');
    // 勝敗の文字を1文字ずつ
    const out = document.getElementById('rsOutcome');
    if (out) out.innerHTML = out.textContent.split('').map((ch, i) => `<span class="ch" style="--i:${i}">${ch}</span>`).join('');
    const kicker = document.getElementById('rsKicker');
    typeInto(kicker, `MATCH RESULT / ${pad(o.rounds)} ROUNDS`, 30, 400);
    const st = document.getElementById('rsStampText');
    if (st) st.textContent = (o.outcome === 'my' ? 'WINNER' : o.outcome === 'op' ? 'GAME OVER' : 'DRAW GAME') + ' · NUMBER WAR · 2026 ·';
    countUp(document.getElementById('rsMyChips'), o.my, 1000, 1200);
    countUp(document.getElementById('rsOpChips'), o.op, 1000, 1200);
    // 持ちチップの割合（リング）
    const total = (o.my || 0) + (o.op || 0);
    const pct = total ? Math.round(o.my * 100 / total) : 0;
    const ringMe = document.getElementById('rsRingMe');
    const ringIn = document.querySelector('.rr-inner');
    if (ringMe) { ringMe.style.strokeDasharray = '0 100'; }
    if (ringIn) { ringIn.style.strokeDasharray = '0 100'; }
    countUp(document.getElementById('rsRingPct'), pct, 1100, 1300);
    resultTimers.push(setTimeout(() => {
      if (ringMe) ringMe.style.strokeDasharray = `${pct} 100`;
      if (ringIn) ringIn.style.strokeDasharray = `${Math.max(0, pct - 6)} 100`;
    }, 1100));
    if (o.outcome === 'my') {
      resultTimers.push(setTimeout(() => confetti(window.innerWidth / 2, window.innerHeight * 0.3, { count: 130, power: 13, life: 2800 }), 700));
    }
    resultTimers.push(setTimeout(() => pulse(o.outcome === 'op' ? PALETTE.violet : PALETTE.orange, window.innerWidth / 2, window.innerHeight * 0.25, { speed: 0.6, life: 3000 }), 500));
  }

  // ---------- 後片付け（タイトルへ戻る時） ----------
  function clear() {
    clearCountdown();
    resultTimers.forEach(clearTimeout); resultTimers = [];
    document.querySelectorAll('.reel-stamp, .reel-confetti').forEach(n => n.remove());
    const ov = document.getElementById('overlay');
    if (ov) ov.classList.remove('play', 'lose-theme');
    document.body.classList.remove('reel-paper');
  }

  function hudSet(info) {
    hudInfo = info;
    updateHudTr();
  }

  // ---------- 手札が配られる動き（バトル場→手札選択に切り替わった時） ----------
  function watchBoard() {
    const board = document.getElementById('board');
    if (!board || reduceMotion) return;
    let prev = board.dataset.mode;
    new MutationObserver(() => {
      const mode = board.dataset.mode;
      if (mode === prev) return;
      prev = mode;
      if (mode !== 'select') return;
      const sp = board.querySelector('.select-panel');
      if (!sp) return;
      sp.classList.remove('reel-deal'); void sp.offsetWidth; sp.classList.add('reel-deal');
      setTimeout(() => sp.classList.remove('reel-deal'), 700);
    }).observe(board, { attributes: true, attributeFilter: ['data-mode'] });
  }

  function init() {
    document.body.appendChild(hud);
    canvas = document.getElementById('reelDots');
    if (canvas) {
      ctx = canvas.getContext('2d');
      resize();
      window.addEventListener('resize', resize);
      ambientAt = performance.now() + 1200;
    }
    setupTitle();
    watchBoard();
    setScene(scene);
    requestAnimationFrame(loop);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.ReelFX = { screen, countdown, stamp, result, clear, hud: hudSet, pulse, confetti };
})();
