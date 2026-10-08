/* =====================================================================
   WARP FX — 紺の宇宙＋ワープの演出（演出カタログ FX-01〜11）
   ・背景：中心から流れるワープの光線（速さを演出ごとに変える）
   ・画面切り替えの白フラッシュ／タイトル起動／ラウンド開始／カードオープン
   ・勝敗（WIN・LOSE・DRAW・JACKPOT）／ハッキング／SPIKE／試合終了とリザルト
   ゲーム本体からは window.ReelFX 経由で呼ぶ（無くてもゲームは動く）
   ===================================================================== */
(function () {
  'use strict';
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const rnd = (a, b) => a + Math.random() * (b - a);
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const E = 'cubic-bezier(.2,.8,.2,1)';
  const A = (el, kf, dur, delay = 0, easing = E) => el.animate(kf, { duration: dur, delay, easing, fill: 'both' });
  // 画面上の要素（盤面・画面）を動かす時は、終わったら効果を残さない（transform が残ると fixed の子の基準がずれるため）
  const AT = (el, kf, dur, delay = 0, easing = E) => el.animate(kf, { duration: dur, delay, easing, fill: 'backwards' });

  // ---------- 背景：ワープの光線 ----------
  const warp = {
    cv: null, ctx: null, W: 0, H: 0, dpr: 1, v: 0.3, target: 0.3, base: 0.3, tint: '170,190,255', stars: [], t: null,
    spawn(any) { return { a: Math.random() * Math.PI * 2, d: any ? Math.random() * 0.9 + 0.02 : Math.random() * 0.05 + 0.01, w: Math.random() * 0.8 + 0.4 }; },
    init(cv) {
      this.cv = cv; this.ctx = cv.getContext('2d');
      this.stars = Array.from({ length: 170 }, () => this.spawn(true));
      this.resize();
    },
    resize() {
      if (!this.cv) return;
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.W = window.innerWidth; this.H = window.innerHeight;
      this.cv.width = Math.round(this.W * this.dpr); this.cv.height = Math.round(this.H * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    },
    // 一時的に速くする（ms 後に元の速さへ戻る）
    boost(v, ms, back) { this.target = v; clearTimeout(this.t); this.t = setTimeout(() => { this.target = back != null ? back : this.base; }, ms); },
    set(v) { this.v = v; this.target = v; },
    tintFor(rgb, ms) { this.tint = rgb; clearTimeout(this.tt); this.tt = setTimeout(() => { this.tint = '170,190,255'; }, ms); },
    step(dt) {
      const { ctx, W, H } = this;
      if (!ctx) return;
      const cx = W / 2, cy = H * 0.44, R = Math.hypot(W, H) * 0.6;
      this.v += (this.target - this.v) * Math.min(1, dt * 0.004);
      ctx.clearRect(0, 0, W, H);
      const v = reduceMotion ? 0.05 : this.v;
      for (const s of this.stars) {
        if (!reduceMotion) s.d += s.d * v * dt * 0.0022 + 0.00004 * dt;
        if (s.d > 1.2) Object.assign(s, this.spawn(false));
        const len = Math.min(0.5, 0.02 + v * 0.16) * s.d;
        const x1 = cx + Math.cos(s.a) * s.d * R, y1 = cy + Math.sin(s.a) * s.d * R;
        const d0 = Math.max(0, s.d - len);
        const x0 = cx + Math.cos(s.a) * d0 * R, y0 = cy + Math.sin(s.a) * d0 * R;
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, `rgba(${this.tint},0)`); g.addColorStop(1, `rgba(${this.tint},${Math.min(0.9, 0.2 + s.d * 0.8)})`);
        ctx.strokeStyle = g; ctx.lineWidth = s.w; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }
  };
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(50, now - last); last = now;
    warp.step(dt);
  }

  // ---------- 小さな道具 ----------
  const bgFx = () => document.getElementById('bgFx');
  function greyOut(ms) {
    const b = bgFx(); if (!b || reduceMotion) return;
    b.style.setProperty('--gd', ms + 'ms');
    b.classList.remove('grey-out'); void b.offsetWidth; b.classList.add('grey-out');
    setTimeout(() => b.classList.remove('grey-out'), ms + 50);
  }
  // 盤面（なければ画面全体）に重ねる演出用のレイヤー
  function layerOver(target, life, opts) {
    opts = opts || {};
    const L = h('<div class="wfx-layer" aria-hidden="true"></div>');
    const el = target && target.offsetParent ? target : null;
    if (el) {
      const r = el.getBoundingClientRect();
      Object.assign(L.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    } else L.classList.add('full');
    if (opts.block) L.classList.add('block');
    L.appendChild(h('<div class="wfx-flash"></div>'));
    document.body.appendChild(L);
    if (life) setTimeout(() => L.remove(), life);
    return L;
  }
  // 盤面の上を一時的に暗くして文字を読みやすくする
  const dimIn = (L, life, peak = 1) => { const d = h('<div class="wfx-dim"></div>'); L.insertBefore(d, L.firstChild); A(d, [{ opacity: 0 }, { opacity: peak, offset: 0.12 }, { opacity: peak, offset: 0.8 }, { opacity: 0 }], life, 0, 'linear'); return d; };
  const flash = (L, delay, peak = 0.9, dur = 500) => { const f = L.querySelector('.wfx-flash'); if (f) A(f, [{ opacity: 0 }, { opacity: peak, offset: 0.12 }, { opacity: 0 }], dur, delay, 'ease-out'); };
  const shake = (el, delay, dur = 360, amp = 6) => AT(el, Array.from({ length: 8 }, (_, i) => ({ transform: i === 7 ? 'none' : `translate(${rnd(-amp, amp)}px, ${rnd(-amp, amp) * 0.5}px)` })), dur, delay, 'linear');
  // グリッチ文字：白＋ピンク・水色のずれ＋横スライス
  const glitchEl = (html, cls) => h(`<span class="wfx-gl ${cls || 'wfx-big'}"><span class="gs">${html}</span><span class="gx ga" aria-hidden="true">${html}</span><span class="gx gb" aria-hidden="true">${html}</span><span class="gx gs s1" aria-hidden="true">${html}</span><span class="gx gs s2" aria-hidden="true">${html}</span></span>`);
  function glitchIn(g, dur, delay, amp) {
    const n = 9, kA = [], kB = [], k1 = [], k2 = [];
    for (let i = 0; i <= n; i++) {
      const f = (1 - i / n) * amp, end = i === n;
      kA.push({ transform: end ? 'none' : `translate(${-rnd(0.4, 1) * f}px, ${rnd(-0.3, 0.3) * f}px)`, opacity: end ? 0 : 1 });
      kB.push({ transform: end ? 'none' : `translate(${rnd(0.4, 1) * f}px, ${rnd(-0.3, 0.3) * f}px)`, opacity: end ? 0 : 1 });
      const y = rnd(10, 70), hh = rnd(6, 20), y2 = rnd(20, 80);
      k1.push({ clipPath: `inset(${y}% 0 ${Math.max(0, 100 - y - hh)}% 0)`, transform: end ? 'none' : `translateX(${rnd(-2, 2) * f}px)`, opacity: end ? 0 : 1 });
      k2.push({ clipPath: `inset(${y2}% 0 ${Math.max(0, 100 - y2 - 10)}% 0)`, transform: end ? 'none' : `translateX(${rnd(-2, 2) * f}px)`, opacity: end ? 0 : 1 });
    }
    const st = `steps(${n}, end)`;
    A(g.querySelector('.ga'), kA, dur, delay, st);
    A(g.querySelector('.gb'), kB, dur, delay, st);
    A(g.querySelector('.s1'), k1, dur, delay, st);
    A(g.querySelector('.s2'), k2, dur, delay, st);
  }
  function countTo(node, from, to, delay, dur) {
    if (!node) return;
    node.textContent = pad(from);
    setTimeout(() => {
      const s = performance.now();
      const f = (now) => { const k = Math.min(1, (now - s) / dur); node.textContent = pad(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(f); };
      requestAnimationFrame(f);
    }, delay);
  }
  function typeInto(node, text, speed, delay) {
    if (!node) return;
    if (reduceMotion) { node.textContent = text; return; }
    node.textContent = '';
    let i = 0;
    const step = () => { node.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(step, speed); };
    setTimeout(step, delay || 0);
  }
  const board = () => document.getElementById('board');
  const boardMidY = (L) => {
    // 盤面の中央の帯（POTと手札の間）の高さ：レイヤー内のpx
    const b = board(); if (!b) return L.clientHeight * 0.46;
    const m = b.querySelector('.zone-mid');
    const lr = L.getBoundingClientRect();
    if (!m) return lr.height * 0.46;
    const r = m.getBoundingClientRect();
    return r.top - lr.top + r.height * 0.42;
  };

  // ---------- HUD ----------
  const hud = h('<div class="wfx-hud" aria-hidden="true"><span id="wfxHudL"><span class="dot"></span>NUMBER WAR // CARD DUEL</span><span id="wfxHudR">1–8 · 15 CHIPS</span></div>');
  let scene = 'start', hudInfo = null;
  function updateHud() {
    const l = document.getElementById('wfxHudL'), r = document.getElementById('wfxHudR');
    if (!l || !r) return;
    const label = { start: 'CARD DUEL', online: 'LINK', prep: 'DECK BUILD', game: 'BATTLE', result: 'RESULT' }[scene] || 'CARD DUEL';
    l.innerHTML = `<span class="dot"></span>NUMBER WAR // ${label}`;
    if ((scene === 'game' || scene === 'result') && hudInfo) r.textContent = `ROUND ${pad(hudInfo.round)} · POT ${pad(hudInfo.pod)}`;
    else if (scene === 'prep') r.textContent = '8 CARDS · 5 COLORS';
    else r.textContent = '1–8 · 15 CHIPS';
  }
  function hudSet(info) { hudInfo = info; updateHud(); }

  // ---------- FX-01 タイトル起動 ----------
  function bootTitle() {
    const t = document.querySelector('.warp-title');
    if (!t) return;
    const term = t.querySelector('.wt-term');
    if (reduceMotion) return;
    t.classList.remove('boot'); void t.offsetWidth; t.classList.add('boot');
    typeInto(term, '> connecting duel_server', 34, 120);
    setTimeout(() => {
      const L = layerOver(null, 1200);
      flash(L, 0, 0.85, 600);
      greyOut(900);
      warp.boost(2.6, 900);
      const word = t.querySelector('.wt-word');
      if (word) { word.classList.add('wfx-gl-host'); shake(word, 0, 400, 5); }
    }, 1050);
  }

  // ---------- 画面切り替え：白フラッシュ＋ワープ加速 ----------
  const SCREEN_IDS = { start: 'startScreen', online: 'onlineScreen', prep: 'prepScreen', game: 'gameScreen' };
  let lastScreen = null;
  function screen(name) {
    if (lastScreen && lastScreen !== name) {
      window.scrollTo(0, 0);
      if (!reduceMotion) {
        const L = layerOver(null, 600);
        flash(L, 0, 0.55, 420);
        warp.boost(2.2, 500);
        const target = document.getElementById(SCREEN_IDS[name]);
        if (target) AT(target, [{ opacity: 0, transform: 'scale(1.02)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'none' }], 520, 80);
      }
      if (name === 'start') bootTitle();
    }
    lastScreen = name;
    scene = name;
    updateHud();
  }

  // ---------- FX-02 ラウンド開始 ----------
  function roundStart(n, opts) {
    opts = opts || {};
    if (reduceMotion) return;
    const full = !!opts.full;
    const T = full ? 2400 : 2200; // 表示の長さ（読める速さ）
    document.querySelectorAll('.wfx-layer.stamp').forEach(x => x.remove());
    const L = layerOver(full ? null : board(), T + 100, { block: full });
    if (full) { L.style.background = 'rgba(2,4,12,.82)'; L.addEventListener('pointerdown', () => L.remove()); }
    else dimIn(L, T, 0.8);
    const H = L.clientHeight || window.innerHeight;
    const cy = full ? H * 0.44 : boardMidY(L);
    const band = h(`<div class="wfx-band" style="top:${cy - 52}px;height:104px"></div>`);
    const m = h(`<div class="wfx-mid" style="top:${cy - 46}px"></div>`);
    const k = h(`<div class="wfx-cap">${full ? '&gt; match_start' : 'ROUND'}</div>`);
    const g = glitchEl(`ROUND <span class="p">${pad(n)}</span>`, 'wfx-big');
    g.style.display = 'block'; g.style.fontSize = 'clamp(2.4rem, 13vw, 4.2rem)';
    const c = h('<div class="wfx-cap" style="margin-top:8px;font-weight:400">SELECT YOUR CARD</div>');
    m.append(k, g, c);
    L.append(band, m);
    warp.boost(2.2, 600);
    if (full) flash(L, 0, 0.6, 400);
    const out = [{ opacity: 1, offset: 0.82 }, { opacity: 0 }];
    A(band, [{ transform: 'scaleX(0)', opacity: 0.4 }, { transform: 'scaleX(1)', opacity: 1, offset: 0.2 }, ...out], T, 0);
    A(g, [{ opacity: 0, transform: 'translateX(-40px)' }, { opacity: 1, transform: 'none', offset: 0.16 }, { opacity: 1, offset: 0.82 }, { opacity: 0, transform: 'translateX(30px)' }], T, 100);
    glitchIn(g, 600, 100, 16);
    A(k, [{ opacity: 0 }, { opacity: 1, offset: 0.18 }, ...out], T - 100, 200);
    A(c, [{ opacity: 0, letterSpacing: '.8em' }, { opacity: 1, letterSpacing: '.34em', offset: 0.25 }, ...out], T - 200, 300);
    if (opts.tick) { try { opts.tick(0); setTimeout(() => opts.tick(7), 200); } catch (e) { /* 音がなくても続ける */ } }
  }
  // 対戦開始（従来の 3・2・1 の呼び出し口）
  function countdown(tick) { roundStart(1, { full: true, tick }); }

  // ---------- FX-03 カードオープン ----------
  function reveal() {
    if (reduceMotion) return;
    const b = board(); if (!b) return;
    const L = layerOver(b, 500);
    flash(L, 0, 0.3, 300);
    warp.boost(1.6, 500);
    const field = b.querySelector('.battle-panel') || b;
    shake(field, 0, 260, 3);
  }

  // ---------- FX-04〜07 勝敗 ----------
  function stamp(kind, info) {
    const b = board();
    if (!b || !b.offsetParent) return;
    info = info || {};
    if (reduceMotion) return;
    document.querySelectorAll('.wfx-layer.stamp').forEach(n => n.remove());
    if (kind === 'jackpot' || kind === 'jackpot-op') { jackpot(kind === 'jackpot-op', info); return; }
    const T = 2200; // 表示の長さ（読める速さ）
    const L = layerOver(b, T + 100); L.classList.add('stamp');
    dimIn(L, T, 0.85);
    const cy = boardMidY(L);
    const word = { win: 'W<span class="p">I</span>N', lose: 'LOSE', draw: 'DRAW' }[kind] || '';
    const cap = kind === 'win' ? `ROUND TAKEN · Δ ${info.diff != null ? info.diff : ''}`
      : kind === 'lose' ? `CHIP → POT <span class="v">${pad(info.pod || 0)}</span>`
      : `EVEN · POT <span class="v">${pad(info.pod || 0)}</span>`;
    const band = h(`<div class="wfx-band${kind === 'win' ? '' : ' grey'}" style="top:${cy - 56}px;height:112px"></div>`);
    const m = h(`<div class="wfx-mid" style="top:${cy - 50}px"></div>`);
    const sub = h(`<div class="wfx-cap" style="margin-top:6px">${(info.hack ? 'HACKED · ' : '') + cap}</div>`);
    const out = [{ opacity: 1, offset: 0.84 }, { opacity: 0 }];
    if (kind === 'draw') {
      const top = h('<div class="wfx-big" style="clip-path:inset(0 0 50% 0)">DRAW</div>');
      const bot = h('<div class="wfx-big" style="clip-path:inset(50% 0 0 0);position:absolute;left:0;right:0;top:0;color:var(--peri)">DRAW</div>');
      m.append(top, bot, sub); L.append(band, m);
      A(top, [{ transform: 'translateX(-40%)', opacity: 0 }, { transform: 'none', opacity: 1, offset: 0.22 }, ...out], T, 0);
      A(bot, [{ transform: 'translateX(40%)', opacity: 0 }, { transform: 'none', opacity: 1, offset: 0.22 }, ...out], T, 0);
    } else {
      const g = glitchEl(word, 'wfx-big');
      g.style.display = 'block';
      if (kind === 'lose') g.querySelector('.gs').style.color = '#c9cfe0';
      m.append(g, sub); L.append(band, m);
      if (kind === 'win') {
        warp.boost(3, 700);
        A(g, [{ opacity: 0, transform: 'scale(1.3)' }, { opacity: 1, transform: 'none', offset: 0.16 }, ...out], T, 60);
        glitchIn(g, 600, 60, 14);
      } else {
        warp.boost(0.04, 1800);
        shake(b, 80, 380, 6);
        A(g, [{ opacity: 0, transform: 'translateY(-24px)' }, { opacity: 1, transform: 'none', offset: 0.2 }, { opacity: 1, transform: 'translateY(6px)', offset: 0.84 }, { opacity: 0, transform: 'translateY(10px)' }], T, 60, 'ease-out');
        glitchIn(g, 900, 60, 10);
      }
    }
    A(band, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)', offset: 0.2 }, ...out], T, 0);
    A(sub, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, ...out], T - 100, 100);
  }

  // FX-07 JACKPOT：破裂（白フラッシュ・三重の衝撃波・光条・大きな揺れ・行き過ぎて戻る文字）
  function jackpot(rival, info) {
    const b = board();
    const L = layerOver(b, 2300); L.classList.add('stamp');
    dimIn(L, 2250, 0.8);
    const cy = boardMidY(L);
    const hue = rival ? ['rgba(255,193,211,.95)', 'rgba(255,122,162,.85)', 'rgba(127,156,255,.7)'] : ['rgba(255,255,255,.95)', 'rgba(127,216,255,.85)', 'rgba(255,122,162,.8)'];
    flash(L, 0, rival ? 0.55 : 0.85, 380);
    if (!rival) greyOut(1400);
    warp.set(rival ? 3 : 6); warp.boost(rival ? 3 : 6, 900, warp.base);
    if (rival) warp.tintFor('255,170,200', 1200);
    shake(b, 0, 650, rival ? 6 : 12);
    const core = h(`<div class="wfx-core" style="top:${cy - 70}px"></div>`);
    L.append(core);
    A(core, [{ transform: 'scale(.2)', opacity: 1 }, { transform: 'scale(5)', opacity: 0 }], 520, 0, 'cubic-bezier(.1,.9,.2,1)');
    [0, 90, 200].forEach((d, i) => {
      const r = h(`<div class="wfx-ring" style="top:${cy - 55}px;border-width:${[6, 4, 2.5][i]}px;border-color:${hue[i]}"></div>`);
      L.append(r);
      A(r, [{ transform: 'scale(.1)', opacity: 1 }, { transform: `scale(${4.2 - i * 0.6})`, opacity: 0 }], 750 + i * 120, d, 'cubic-bezier(.05,.8,.2,1)');
    });
    for (let i = 0; i < 14; i++) {
      const ang = i * (360 / 14) + rnd(-8, 8);
      const ray = h(`<div class="wfx-ray" style="top:${cy}px;height:${rnd(2, 6).toFixed(1)}px;margin-top:-2px;transform:rotate(${ang}deg)"></div>`);
      L.append(ray);
      A(ray, [{ transform: `rotate(${ang}deg) scaleX(0)`, opacity: 1 }, { transform: `rotate(${ang}deg) scaleX(1)`, opacity: 0.9, offset: 0.35 }, { transform: `rotate(${ang}deg) scaleX(1.3)`, opacity: 0 }], 650, 0, 'cubic-bezier(.1,.9,.2,1)');
    }
    const m = h(`<div class="wfx-mid" style="top:${cy - 54}px"></div>`);
    const g = glitchEl('JACKPOT', 'wfx-big');
    g.style.display = 'block'; g.style.fontSize = 'clamp(2.8rem, 15vw, 5rem)';
    if (rival) g.querySelector('.gs').style.color = '#ffd6e2';
    const sub = h(`<div class="wfx-cap" style="margin-top:8px">${rival ? 'RIVAL TAKES' : 'POT'} <span class="v">00</span>${rival ? '' : ' を総取り'}</div>`);
    m.append(g, sub); L.append(m);
    A(g, [{ opacity: 0, transform: 'scale(.05)' }, { opacity: 1, transform: 'scale(1.45)', offset: 0.15 }, { transform: 'scale(.92)', offset: 0.27 }, { transform: 'scale(1.06)', offset: 0.38 }, { opacity: 1, transform: 'scale(1)', offset: 0.85 }, { opacity: 0, transform: 'scale(1)' }], 2100, 0, 'ease-out');
    glitchIn(g, 1200, 0, rival ? 14 : 26);
    A(sub, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none', offset: 0.3 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], 1300, 900);
    countTo(sub.querySelector('.v'), 0, (info && info.take) || (info && info.pod) || 0, 1000, 600);
  }

  // ---------- FX-08 ハッキング（約1.1秒。終わったら resolve） ----------
  function hack(text) {
    return new Promise(resolve => {
      const b = board();
      if (!b || reduceMotion) { setTimeout(resolve, reduceMotion ? 300 : 0); return; }
      const L = layerOver(b, 1150);
      const H = L.clientHeight;
      dimIn(L, 1150, 0.9);
      for (let i = 0; i < 7; i++) {
        const y = rnd(0, 90), hh = rnd(3, 11);
        const sl = h(`<div style="position:absolute;inset:0;clip-path:inset(${y}% 0 ${100 - y - hh}% 0);background:linear-gradient(90deg,rgba(255,110,165,.4),rgba(110,185,255,.4));mix-blend-mode:screen"></div>`);
        L.append(sl);
        A(sl, [{ transform: `translateX(${rnd(-60, 60)}px)`, opacity: 1 }, { transform: `translateX(${rnd(-60, 60)}px)`, opacity: 1, offset: 0.5 }, { transform: 'none', opacity: 0 }], 650, rnd(0, 300), 'steps(4, end)');
      }
      const m = h(`<div class="wfx-mid" style="top:${H * 0.42 - 40}px"></div>`);
      const g = glitchEl(text || 'HACK!!', 'wfx-big');
      g.style.display = 'block'; g.style.fontSize = 'clamp(3rem, 18vw, 5.4rem)'; g.querySelector('.gs').style.color = '#ffe3ec';
      m.append(g, h('<div class="wfx-cap" style="margin-top:6px;color:var(--pink-hi)">&gt; override result_</div>'));
      L.append(m);
      shake(b, 0, 520, 9);
      warp.boost(2.6, 500); warp.tintFor('255,170,200', 900);
      A(g, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], 1100, 0, 'steps(6, end)');
      glitchIn(g, 1000, 0, 30);
      setTimeout(resolve, 1100);
    });
  }

  // ---------- FX-10 SPIKE（約2.2秒） ----------
  function spike(fromRound, payFrom, payTo) {
    const b = board();
    if (!b || !b.offsetParent) return false;
    if (reduceMotion) return true;
    const L = layerOver(b, 2300);
    dimIn(L, 2250, 0.8);
    const H = L.clientHeight;
    const sv = h(`<svg viewBox="0 0 100 40" preserveAspectRatio="none" style="position:absolute;left:6%;width:88%;top:${H * 0.56}px;height:${H * 0.13}px;overflow:visible"><polyline class="c" fill="none" stroke="#7fd8ff" stroke-width=".7" vector-effect="non-scaling-stroke" points="0,24 8,22 14,25 20,21 26,24 32,22 38,25 44,23 50,24"/><polyline class="p" fill="none" stroke="#ff7aa2" stroke-width="2" vector-effect="non-scaling-stroke" points="50,24 53,-8 56,38 59,4 62,34 66,8 70,32 74,12 78,30 83,10 88,28 94,14 100,24"/></svg>`);
    const fr = h('<div class="wfx-alert"></div>');
    const m = h(`<div class="wfx-mid" style="top:${H * 0.28}px"></div>`);
    const g = glitchEl('SPIKE', 'wfx-big'); g.style.display = 'block';
    const sub = h(`<div class="wfx-cap" style="margin-top:6px;color:#ffd0dd">負けた時の支払い ${payFrom || 2} → <span class="v">${payTo || 4}</span></div>`);
    const lb = h(`<div class="wfx-cap" style="position:absolute;left:0;right:0;top:${H * 0.72}px;font-weight:400;color:var(--dim)">ROUND ${pad(fromRound)} → ${pad(fromRound + 1)} ▲</div>`);
    m.append(g, sub);
    L.append(sv, fr, m, lb);
    const c = sv.querySelector('.c'), p = sv.querySelector('.p');
    [c, p].forEach(n => { const len = n.getTotalLength(); n.style.strokeDasharray = len; n.style.strokeDashoffset = len; });
    A(c, [{ strokeDashoffset: c.getTotalLength() }, { strokeDashoffset: 0 }], 600, 0, 'linear');
    A(p, [{ strokeDashoffset: p.getTotalLength() }, { strokeDashoffset: 0 }], 380, 620, 'linear');
    A(fr, [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 0.3, offset: 0.2 }, { opacity: 1, offset: 0.3 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], 1650, 640, 'linear');
    shake(b, 640, 420, 7);
    warp.tintFor('255,150,180', 1800); warp.boost(2.8, 700, 1); setTimeout(() => { warp.target = warp.base; }, 2200);
    A(g, [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.88 }, { opacity: 0 }], 1600, 700, 'steps(3, end)');
    glitchIn(g, 900, 700, 22);
    A(sub, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], 900, 1350);
    A(lb, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], 1600, 600);
    return true;
  }

  // ---------- FX-11 試合終了 → リザルト ----------
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
        node.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 4))));
        if (k >= 0.85) node.classList.remove('counting');
        if (k < 1) requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    }, delay));
  }
  function lockup(o) {
    if (reduceMotion) return 0;
    const word = o.outcome === 'my' ? 'VICTORY' : o.outcome === 'op' ? 'DEFEAT' : 'DRAW';
    const L = layerOver(null, 2000, { block: true });
    L.style.background = 'rgba(2,4,12,.82)';
    L.addEventListener('pointerdown', () => L.remove());
    const m = h(`<div class="wfx-mid" style="top:34%"></div>`);
    const lock = h(`<div class="wfx-lock"><div class="wt-mark" style="width:64px;margin-bottom:16px"><i class="l"></i><i class="r"></i><b>${o.outcome === 'my' ? '★' : o.outcome === 'op' ? '×' : '='}</b></div></div>`);
    const g = glitchEl(word, 'wt-word'); g.style.display = 'block';
    if (o.outcome === 'op') g.querySelector('.gs').style.color = '#ffd6e2';
    const sub = h(`<div class="wt-sub">${o.outcome === 'my' ? 'PLAYER WINS' : o.outcome === 'op' ? 'RIVAL WINS' : 'NO CONTEST'} · ${pad(o.rounds)} ROUNDS</div>`);
    lock.append(g, sub); m.append(lock); L.append(m);
    flash(L, 0, 1, 700);
    greyOut(700);
    warp.set(o.outcome === 'op' ? 1.4 : 3.2); warp.boost(warp.v, 600, 0.15);
    if (o.outcome === 'op') warp.tintFor('255,170,200', 2000);
    A(lock, [{ opacity: 0, transform: 'scale(1.1)' }, { opacity: 1, transform: 'none', offset: 0.3 }, { opacity: 1, offset: 0.82 }, { opacity: 0, transform: 'scale(.98)' }], 1900, 120);
    glitchIn(g, 800, 120, 20);
    A(sub, [{ opacity: 0 }, { opacity: 1 }], 500, 800);
    setTimeout(() => { warp.target = warp.base = 0.3; }, 2600);
    return 1700;
  }
  function result(o) {
    const ov = document.getElementById('overlay');
    if (!ov) return;
    resultTimers.forEach(clearTimeout); resultTimers = [];
    scene = 'result'; updateHud();
    const wait = lockup(o);
    const start = () => {
      ov.classList.remove('wfx-hold');
      ov.classList.remove('play'); void ov.offsetWidth; ov.classList.add('play');
      ov.classList.toggle('lose-theme', o.outcome === 'op');
      const out = document.getElementById('rsOutcome');
      if (out) out.innerHTML = out.textContent.split('').map((ch, i) => `<span class="ch" style="--i:${i}">${ch}</span>`).join('');
      typeInto(document.getElementById('rsKicker'), `MATCH RESULT / ${pad(o.rounds)} ROUNDS`, 30, 400);
      countUp(document.getElementById('rsMyChips'), o.my, 1000, 1200);
      countUp(document.getElementById('rsOpChips'), o.op, 1000, 1200);
      const total = (o.my || 0) + (o.op || 0);
      const pct = total ? Math.round(o.my * 100 / total) : 0;
      const ringMe = document.getElementById('rsRingMe'), ringIn = document.querySelector('.rr-inner');
      if (ringMe) ringMe.style.strokeDasharray = '0 100';
      if (ringIn) ringIn.style.strokeDasharray = '0 100';
      countUp(document.getElementById('rsRingPct'), pct, 1100, 1300);
      resultTimers.push(setTimeout(() => {
        if (ringMe) ringMe.style.strokeDasharray = `${pct} 100`;
        if (ringIn) ringIn.style.strokeDasharray = `${Math.max(0, pct - 6)} 100`;
      }, 1100));
    };
    // ロックアップの間はリザルトを隠しておき、終わってから集計演出を始める
    if (wait) { ov.classList.remove('play'); ov.classList.add('wfx-hold'); resultTimers.push(setTimeout(start, wait)); } else start();
  }

  // ---------- 後片付け（タイトルへ戻る時） ----------
  function clear() {
    resultTimers.forEach(clearTimeout); resultTimers = [];
    document.querySelectorAll('.wfx-layer').forEach(n => n.remove());
    const ov = document.getElementById('overlay');
    if (ov) ov.classList.remove('play', 'lose-theme', 'wfx-hold');
    warp.base = 0.3; warp.target = 0.3; warp.tint = '170,190,255';
  }
  // 旧API互換：波紋 → ワープの加速、紙吹雪 → なし
  function pulse() { warp.boost(1.8, 500); }
  function confetti() { /* この演出テーマでは使わない */ }

  // ---------- 手札が配られる動き ----------
  function watchBoard() {
    const b = board();
    if (!b || reduceMotion) return;
    let prev = b.dataset.mode;
    new MutationObserver(() => {
      const mode = b.dataset.mode;
      if (mode === prev) return;
      prev = mode;
      if (mode !== 'select') return;
      const sp = b.querySelector('.select-panel');
      if (!sp) return;
      sp.classList.remove('wfx-deal'); void sp.offsetWidth; sp.classList.add('wfx-deal');
      setTimeout(() => sp.classList.remove('wfx-deal'), 700);
    }).observe(b, { attributes: true, attributeFilter: ['data-mode'] });
  }

  function init() {
    document.body.appendChild(hud);
    const cv = document.getElementById('warpBg');
    if (cv) { warp.init(cv); window.addEventListener('resize', () => warp.resize()); }
    watchBoard();
    updateHud();
    bootTitle();
    lastScreen = 'start';
    requestAnimationFrame(loop);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.ReelFX = { screen, countdown, round: roundStart, reveal, stamp, hack, spike, result, lockup, clear, hud: hudSet, pulse, confetti, warp };
})();
