'use strict';
// Pocket Tanks Online — client. Renders the shared board, handles input, and
// replays the server's authoritative shots so both screens stay identical.

const WORLD_W = 1280, WORLD_H = 720;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  ws: null, connected: false,
  you: 0, names: ['Player 1', 'Player 2'],
  weapons: [], weaponById: {},
  terrain: null, tanks: [{ x: 130, y: 400 }, { x: 1150, y: 400 }],
  scores: [0, 0], shotsLeft: [10, 10], ammo: {},
  turn: 0, fuel: 140, moveBudget: 140, shotClock: 45, shotsPerPlayer: 10,
  clockEndsAt: 0,
  selected: 'cannon',
  aim: [{ angle: 45, power: 60 }, { angle: 45, power: 60 }],
  code: null, quick: false,
  playing: false,
  anim: null, queue: [],
  particles: [], floaters: [], rings: [], shake: 0, flash: 0,
};

// ---------------------------------------------------------------------------
// Audio (synthesized, no assets — works offline)
// ---------------------------------------------------------------------------
const Audio = {
  ctx: null, muted: localStorage.getItem('pt_mute') === '1',
  ensure() {
    if (this.muted) return null;
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  fire() {
    const c = this.ensure(); if (!c) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(680, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.18);
    g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.22);
  },
  boom(r) {
    const c = this.ensure(); if (!c) return;
    const t = c.currentTime, dur = 0.35 + r / 200;
    // noise burst through a lowpass = the body of the blast
    const n = c.createBufferSource(), buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    n.buffer = buf; const lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(120, t + dur);
    const ng = c.createGain(); ng.gain.setValueAtTime(Math.min(0.5, 0.25 + r / 300), t); ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(lp).connect(ng).connect(c.destination); n.start(t); n.stop(t + dur);
    // low sine thump
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + dur);
    g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur);
  },
  chime(win) {
    const c = this.ensure(); if (!c) return;
    const notes = win ? [523, 659, 784, 1046] : [392, 330, 262];
    notes.forEach((f, i) => {
      const t = c.currentTime + i * 0.12, o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.32);
    });
  },
};
$('muteBtn').onclick = () => {
  Audio.muted = !Audio.muted; localStorage.setItem('pt_mute', Audio.muted ? '1' : '0');
  $('muteBtn').textContent = Audio.muted ? '🔇' : '🔊';
  if (!Audio.muted) Audio.ensure();
};

// ---------------------------------------------------------------------------
// Canvas + view transform
// ---------------------------------------------------------------------------
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let view = { scale: 1, ox: 0, oy: 0, cssW: 0, cssH: 0, dpr: 1 };

function resize() {
  const stage = $('stage');
  const cssW = stage.clientWidth, cssH = stage.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let scale = cssW / WORLD_W;
  if (WORLD_H * scale > cssH) scale = cssH / WORLD_H;
  const wpx = WORLD_W * scale, hpx = WORLD_H * scale;
  view = { scale, ox: (cssW - wpx) / 2, oy: cssH - hpx, cssW, cssH, dpr };
}
window.addEventListener('resize', resize);

const wx2s = (x) => view.ox + x * view.scale;
const wy2s = (y) => view.oy + y * view.scale;
const s2wx = (sx) => (sx - view.ox) / view.scale;

function surfaceAt(x) {
  const t = S.terrain; if (!t) return WORLD_H * 0.64;
  if (x <= 0) return t[0];
  if (x >= WORLD_W) return t[WORLD_W];
  const i = Math.floor(x), f = x - i;
  return t[i] * (1 - f) + t[i + 1] * f;
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => { S.connected = true; $('connErr').classList.add('hidden'); flushIntent(); };
  ws.onclose = () => { S.connected = false; if (S.playing) $('connErr').classList.remove('hidden'); setTimeout(connect, 1500); };
  ws.onerror = () => {};
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
}
function sendMsg(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }

let pendingIntent = null;
function flushIntent() { if (pendingIntent) { sendMsg(pendingIntent); pendingIntent = null; } }
function intent(m) { if (S.connected) sendMsg(m); else pendingIntent = m; }

function handle(m) {
  switch (m.type) {
    case 'created': S.code = m.code; $('lobbyCode').textContent = m.code; showLobby('host'); break;
    case 'queued': showLobby('search'); break;
    case 'joinError': $('homeError').textContent = m.reason; break;
    case 'start': onStart(m); break;
    case 'turn': onTurn(m); break;
    case 'aim':
      if (m.seat !== S.you) { S.aim[m.seat] = { angle: m.angle, power: m.power }; }
      break;
    case 'move':
      S.tanks[m.seat] = { x: m.x, y: m.y };
      if (m.seat === S.you) { S.fuel = m.fuel; updateFuel(); }
      break;
    case 'shot': enqueueShot(m); break;
    case 'passed':
      S.shotsLeft = m.shotsLeft; updateHud();
      showToast(`${S.names[m.by]} ran out of time — turn skipped`);
      break;
    case 'gameover': onGameOver(m); break;
    case 'opponentLeft':
      S.playing = false; showOverlay('Opponent left', '', 'draw', true); break;
  }
}

// ---------------------------------------------------------------------------
// Home / lobby
// ---------------------------------------------------------------------------
function savedName() { return localStorage.getItem('pt_name') || ''; }
function myName() {
  const n = ($('nameInput').value || '').trim() || savedName() || 'Commander';
  localStorage.setItem('pt_name', n);
  return n;
}

$('createBtn').onclick = () => { Audio.ensure(); $('homeError').textContent = ''; intent({ type: 'create', name: myName() }); };
$('quickBtn').onclick = () => { Audio.ensure(); S.quick = true; $('homeError').textContent = ''; intent({ type: 'quick', name: myName() }); };
$('joinBtn').onclick = () => {
  Audio.ensure();
  const code = ($('codeInput').value || '').toUpperCase().trim();
  if (code.length < 3) { $('homeError').textContent = 'Enter the 4-letter code.'; return; }
  $('homeError').textContent = '';
  intent({ type: 'join', code, name: myName() });
};
$('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
$('cancelBtn').onclick = () => { sendMsg({ type: 'leave' }); sendMsg({ type: 'cancelQuick' }); S.code = null; S.quick = false; showScreen('home'); };

$('copyLinkBtn').onclick = async () => {
  const link = `${location.origin}/?room=${S.code}`;
  try { await navigator.clipboard.writeText(link); flashBtn($('copyLinkBtn'), 'Link copied!'); }
  catch { prompt('Copy this invite link:', link); }
};
$('copyCodeBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(S.code); flashBtn($('copyCodeBtn'), 'Code copied!'); }
  catch { prompt('Game code:', S.code); }
};
function flashBtn(btn, txt) { const o = btn.textContent; btn.textContent = txt; setTimeout(() => (btn.textContent = o), 1300); }

function showScreen(name) {
  for (const s of ['home', 'lobby', 'game']) $(s).classList.toggle('active', s === name);
}
function showLobby(mode) {
  const searching = mode === 'search';
  $('lobbyHeading').textContent = searching ? 'Searching for an opponent…' : 'Waiting for your opponent…';
  $('lobbyHint').textContent = searching ? "We'll drop you into a battle the moment someone else is looking too." : 'Send this link or code. The battle starts the moment they join.';
  $('lobbyCode').style.display = searching ? 'none' : '';
  $('copyLinkBtn').style.display = searching ? 'none' : '';
  $('copyCodeBtn').style.display = searching ? 'none' : '';
  showScreen('lobby');
}

// ---------------------------------------------------------------------------
// Game setup
// ---------------------------------------------------------------------------
function onStart(m) {
  S.you = m.you; S.names = m.names; S.weapons = m.weapons;
  S.weaponById = Object.fromEntries(m.weapons.map(w => [w.id, w]));
  S.terrain = m.terrain.slice();
  S.tanks = m.tanks.map(t => ({ x: t.x, y: t.y }));
  S.scores = m.scores.slice(); S.shotsLeft = m.shotsLeft.slice();
  S.ammo = m.ammo; S.moveBudget = m.moveBudget; S.shotClock = m.shotClock;
  S.shotsPerPlayer = m.shotsPerPlayer; S.turn = m.turn;
  S.aim = [{ angle: 45, power: 60 }, { angle: 45, power: 60 }];
  S.selected = firstAvailableWeapon();
  S.playing = true; S.quick = false; S.anim = null; S.queue = []; S.particles = []; S.floaters = []; S.rings = [];
  $('overlay').classList.add('hidden');
  showScreen('game');
  resize();
  buildWeaponStrip();
  $('p0').querySelector('.pname').textContent = m.names[0] + (S.you === 0 ? ' (you)' : '');
  $('p1').querySelector('.pname').textContent = m.names[1] + (S.you === 1 ? ' (you)' : '');
  updateHud(); updateAimUI(); updateDock();
}

function onTurn(m) {
  S.turn = m.turn; S.fuel = m.fuel; S.clockEndsAt = m.endsAt;
  S.aim[m.turn] = { angle: 45, power: 60 };
  if (m.turn === S.you) S.selected = firstAvailableWeapon();
  updateFuel(); updateAimUI(); updateDock(); buildWeaponStrip();
}

function firstAvailableWeapon() {
  for (const w of S.weapons) if ((S.ammo[w.id] ?? w.ammo) > 0) return w.id;
  return 'cannon';
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function updateHud() {
  $('p0').querySelector('.score').textContent = S.scores[0];
  $('p1').querySelector('.score').textContent = S.scores[1];
  $('p0').querySelector('.shots').textContent = `${S.shotsLeft[0]} left`;
  $('p1').querySelector('.shots').textContent = `${S.shotsLeft[1]} left`;
}
function updateFuel() {
  const pct = Math.max(0, Math.min(100, (S.fuel / S.moveBudget) * 100));
  $('fuelBar').style.width = pct + '%';
}
function myTurn() { return S.turn === S.you && S.playing && !S.anim; }

function updateDock() {
  const active = myTurn();
  $('dockLock').classList.toggle('hidden', active);
  $('watching').classList.toggle('hidden', active || !S.playing);
  if (!active && S.playing) {
    $('watching').textContent = S.anim ? 'Shot in the air… 💥' : `${S.names[S.turn]}'s turn — watch it land 👀`;
  }
  $('turnLabel').textContent = active ? 'YOUR TURN' : (S.playing ? `${S.names[S.turn]}'s turn` : '');
  $('fireBtn').disabled = !active;
  $('moveLeft').disabled = !active || S.fuel < 6;
  $('moveRight').disabled = !active || S.fuel < 6;
}

function buildWeaponStrip() {
  const strip = $('weaponStrip'); strip.innerHTML = '';
  for (const w of S.weapons) {
    const left = S.ammo[w.id] ?? w.ammo;
    const chip = document.createElement('button');
    chip.className = 'wchip' + (w.id === S.selected ? ' sel' : '') + (left <= 0 ? ' empty' : '');
    const ammoTxt = w.ammo >= 99 ? '∞' : `×${left}`;
    chip.innerHTML = `<span class="wi">${w.icon}</span><span class="wn">${w.name}</span><span class="wa">${ammoTxt}</span>`;
    chip.title = w.desc;
    chip.onclick = () => { if (left > 0 && myTurn()) { S.selected = w.id; buildWeaponStrip(); } };
    strip.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Aim controls
// ---------------------------------------------------------------------------
function myAim() { return S.aim[S.you]; }
function updateAimUI() {
  const a = myAim();
  $('angleVal').textContent = Math.round(a.angle) + '°';
  $('powerVal').textContent = Math.round(a.power);
}
let lastAimSent = 0;
function relayAim() {
  const now = performance.now();
  if (now - lastAimSent < 55) return;
  lastAimSent = now;
  const a = myAim();
  sendMsg({ type: 'aim', angle: a.angle, power: a.power, weapon: S.selected });
}
function setAim(angle, power) {
  const a = myAim();
  a.angle = Math.max(1, Math.min(179, angle));
  a.power = Math.max(5, Math.min(100, power));
  updateAimUI(); relayAim();
}

document.querySelectorAll('.mini').forEach(btn => {
  let iv = null;
  const step = () => {
    if (!myTurn()) return;
    const a = myAim(); const dir = +btn.dataset.dir;
    if (btn.dataset.adj === 'angle') setAim(a.angle + dir, a.power);
    else setAim(a.angle, a.power + dir);
  };
  const start = (e) => { e.preventDefault(); step(); iv = setInterval(step, 110); };
  const stop = () => { clearInterval(iv); iv = null; };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('pointercancel', stop);
});

let dragging = false;
function aimFromPointer(sx, sy) {
  const tank = S.tanks[S.you];
  const tsx = wx2s(tank.x), tsy = wy2s(tank.y - 12);
  const dx = sx - tsx, dy = sy - tsy;
  const dir = S.you === 0 ? 1 : -1;
  const raw = Math.atan2(-dy, dx * dir) * 180 / Math.PI;
  const dist = Math.hypot(dx, dy);
  const power = (dist / (view.cssH * 0.42)) * 100;
  setAim(raw, power);
}
canvas.addEventListener('pointerdown', (e) => {
  if (!myTurn()) return;
  dragging = true; canvas.setPointerCapture(e.pointerId);
  aimFromPointer(e.offsetX, e.offsetY);
});
canvas.addEventListener('pointermove', (e) => { if (dragging && myTurn()) aimFromPointer(e.offsetX, e.offsetY); });
const endDrag = () => { dragging = false; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function holdMove(btn, dir) {
  let iv = null;
  const tick = () => { if (myTurn() && S.fuel >= 6) sendMsg({ type: 'move', dir }); };
  const start = (e) => { e.preventDefault(); tick(); iv = setInterval(tick, 55); };
  const stop = () => { clearInterval(iv); iv = null; };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('pointercancel', stop);
}
holdMove($('moveLeft'), -1);
holdMove($('moveRight'), 1);

$('fireBtn').onclick = () => {
  if (!myTurn()) return;
  const left = S.ammo[S.selected] ?? 99;
  if (left <= 0) { showToast('Out of ammo — pick another weapon'); return; }
  const a = myAim();
  sendMsg({ type: 'fire', weapon: S.selected, angle: a.angle, power: a.power });
  if (navigator.vibrate) navigator.vibrate(30);
  updateDock();
};

// ---------------------------------------------------------------------------
// Shot animation queue
// ---------------------------------------------------------------------------
function enqueueShot(m) { S.queue.push(m); if (!S.anim) startNextShot(); }
function startNextShot() {
  const m = S.queue.shift();
  if (!m) { updateDock(); return; }
  S.anim = {
    m, elapsed: 0,
    projectiles: m.projectiles.map(p => ({ path: p.path, det: p.det, delay: p.delay || 0, pos: 0, done: false, exploded: false, trail: [] })),
    settleTimer: 0, resolved: false,
  };
  Audio.fire();
  updateDock();
}

const PLAYBACK = 60; // path points per second
function advanceAnim(dt) {
  const A = S.anim; if (!A) return;
  A.elapsed += PLAYBACK * dt;
  let allDone = true;
  for (const pr of A.projectiles) {
    if (pr.done) continue;
    const local = A.elapsed - pr.delay;
    if (local < 0) { allDone = false; continue; }
    if (local >= pr.path.length - 1) {
      pr.pos = pr.path.length - 1; pr.done = true;
      if (pr.det && !pr.exploded) { detonate(pr.det); pr.exploded = true; }
    } else { pr.pos = local; allDone = false; }
  }
  if (allDone) {
    A.settleTimer += dt;
    if (!A.resolved && A.settleTimer > 0.22) { applyResolve(A.m); A.resolved = true; }
    if (A.settleTimer > 0.5) { S.anim = null; startNextShot(); }
  }
}

function detonate(det) {
  if (det.kind === 'none' && det.r < 16) { // small burst puff for cluster opening
    for (let i = 0; i < 8; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 80;
      S.particles.push({ x: det.x, y: det.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0.35, age: 0, r: 2, color: det.color });
    }
    return;
  }
  S.shake = Math.min(18, S.shake + (det.r / 58) * 14);
  S.flash = Math.min(0.5, S.flash + (det.r / 58) * 0.35);
  S.rings.push({ x: det.x, y: det.y, r: det.r * 0.3, rMax: det.r * 2.3, age: 0, life: 0.45, color: det.color });
  Audio.boom(det.r);
  if (navigator.vibrate) navigator.vibrate(Math.min(60, det.r));
  const base = det.kind === 'dirt' ? '#8a5a2b' : det.color;
  const n = Math.round(10 + det.r / 2);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = (0.4 + Math.random()) * det.r * 4;
    S.particles.push({ x: det.x, y: det.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - det.r * 1.2, life: 0.5 + Math.random() * 0.5, age: 0, r: 2 + Math.random() * 3, color: base });
  }
  for (let i = 0; i < 5; i++) { // rising smoke
    S.particles.push({ x: det.x + (Math.random() - 0.5) * det.r, y: det.y, vx: (Math.random() - 0.5) * 40, vy: -50 - Math.random() * 60, life: 0.9 + Math.random() * 0.6, age: 0, r: 3 + Math.random() * 4, color: 'rgba(60,60,70,0.6)' });
  }
}

function applyResolve(m) {
  if (m.terrainDiff) {
    const { from, values } = m.terrainDiff;
    for (let i = 0; i < values.length; i++) S.terrain[from + i] = values[i];
  }
  S.tanks = m.tanks.map(t => ({ x: t.x, y: t.y }));
  S.scores = m.scores.slice();
  S.shotsLeft = m.shotsLeft.slice();
  if (m.ammoSeat === S.you && m.ammo) S.ammo = m.ammo;
  updateHud(); buildWeaponStrip();
  if (m.scoreDelta > 0) {
    const foe = S.tanks[1 - m.by];
    S.floaters.push({ x: foe.x, y: foe.y - 30, text: `+${m.scoreDelta}`, age: 0, life: 1.2, color: '#ffd23f' });
    const who = m.by === S.you ? 'You' : S.names[m.by];
    showToast(`${who} scored +${m.scoreDelta}!`);
  } else if (S.weaponById[m.weapon] && S.weaponById[m.weapon].id !== 'dirt' && m.by === S.you) {
    showToast('Missed! No damage.');
  }
}

function showToast(text) {
  const t = document.createElement('div');
  t.className = 'toast-item'; t.textContent = text;
  $('toast').appendChild(t);
  setTimeout(() => t.remove(), 1900);
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------
function onGameOver(m) {
  S.playing = false; S.scores = m.scores.slice(); updateHud();
  let title, cls, win = false;
  if (m.winner === -1) { title = "It's a draw!"; cls = 'draw'; }
  else if (m.winner === S.you) { title = 'Victory! 🏆'; cls = 'win'; win = true; }
  else { title = 'Defeated'; cls = 'lose'; }
  Audio.chime(win);
  showOverlay(title, m.scores, cls, false);
}
function showOverlay(title, scores, cls, hideRematch) {
  const rt = $('resultTitle'); rt.textContent = title; rt.className = 'result ' + cls;
  const fs = $('finalScores');
  if (scores && scores.length) {
    fs.innerHTML =
      `<div class="fs a"><b>${scores[0]}</b><span>${S.names[0]}</span></div>` +
      `<div class="fs b"><b>${scores[1]}</b><span>${S.names[1]}</span></div>`;
  } else fs.innerHTML = '';
  $('rematchBtn').style.display = hideRematch ? 'none' : '';
  $('overlay').classList.remove('hidden');
}
$('rematchBtn').onclick = () => sendMsg({ type: 'rematch' });
$('exitBtn').onclick = () => { sendMsg({ type: 'leave' }); location.href = location.origin; };

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  if (S.terrain) { advanceAnim(dt); stepEffects(dt); }
  draw();
  updateClock();
  requestAnimationFrame(frame);
}

function stepEffects(dt) {
  S.shake = Math.max(0, S.shake - dt * 40);
  S.flash = Math.max(0, S.flash - dt * 1.6);
  for (const p of S.particles) { p.age += dt; p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
  S.particles = S.particles.filter(p => p.age < p.life);
  for (const f of S.floaters) { f.age += dt; f.y -= 26 * dt; }
  S.floaters = S.floaters.filter(f => f.age < f.life);
  for (const r of S.rings) r.age += dt;
  S.rings = S.rings.filter(r => r.age < r.life);
}

function draw() {
  if (view.cssW !== $('stage').clientWidth || view.cssH !== $('stage').clientHeight) resize();
  const { cssW, cssH } = view;
  ctx.save();
  if (S.shake > 0.2) ctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);

  drawSky(cssW, cssH);
  if (S.terrain) {
    drawTerrain(cssW, cssH);
    drawTank(0); drawTank(1);
    drawAim();
    drawProjectiles();
    drawRings();
    drawParticles();
    drawFloaters();
  }
  ctx.restore();

  if (S.flash > 0.01) { ctx.fillStyle = `rgba(255,240,210,${S.flash})`; ctx.fillRect(0, 0, cssW, cssH); }
}

function drawSky(w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0a0f24'); g.addColorStop(0.55, '#182a52'); g.addColorStop(1, '#2a3f6b');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const mg = ctx.createRadialGradient(w * 0.82, h * 0.2, 4, w * 0.82, h * 0.2, 90);
  mg.addColorStop(0, 'rgba(255,250,235,.85)'); mg.addColorStop(1, 'rgba(255,250,235,0)');
  ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(w * 0.82, h * 0.2, 90, 0, Math.PI * 2); ctx.fill();
}

function drawTerrain(w, h) {
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let sx = 0; sx <= w; sx += 3) ctx.lineTo(sx, wy2s(surfaceAt(Math.max(0, Math.min(WORLD_W, s2wx(sx))))));
  ctx.lineTo(w, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, wy2s(WORLD_H * 0.3), 0, h);
  g.addColorStop(0, '#5a4326'); g.addColorStop(0.5, '#4a3720'); g.addColorStop(1, '#2f2415');
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath();
  for (let sx = 0; sx <= w; sx += 3) {
    const sy = wy2s(surfaceAt(Math.max(0, Math.min(WORLD_W, s2wx(sx)))));
    sx === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
  }
  ctx.lineWidth = Math.max(2, 3.6 * view.scale); ctx.strokeStyle = '#6f9a3a'; ctx.stroke();
}

function tankScreen(i) {
  const t = S.tanks[i];
  return { sx: wx2s(t.x), sy: wy2s(t.y), r: Math.max(9, 15 * view.scale) };
}
function drawTank(i) {
  const { sx, sy, r } = tankScreen(i);
  const color = i === 0 ? '#54c8ff' : '#ff6b6b';
  if (S.playing && S.turn === i && !S.anim) {
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    const by = sy - r * 2.4 - 6 + Math.sin(performance.now() / 260) * 3;
    ctx.beginPath(); ctx.moveTo(sx, by + 8); ctx.lineTo(sx - 6, by); ctx.lineTo(sx + 6, by); ctx.closePath(); ctx.fill();
  }
  const aim = S.aim[i]; const dir = i === 0 ? 1 : -1;
  const rad = aim.angle * Math.PI / 180;
  const bx = sx + Math.cos(rad) * dir * r * 2, by2 = (sy - r * 0.7) - Math.sin(rad) * r * 2;
  ctx.strokeStyle = '#d7e2ff'; ctx.lineWidth = Math.max(3, r * 0.42); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(sx, sy - r * 0.7); ctx.lineTo(bx, by2); ctx.stroke();
  ctx.fillStyle = color;
  roundedRect(sx - r, sy - r * 0.75, r * 2, r * 1.1, r * 0.35); ctx.fill();
  ctx.beginPath(); ctx.arc(sx, sy - r * 0.7, r * 0.6, Math.PI, 0); ctx.fill();
  ctx.fillStyle = '#1a2138';
  roundedRect(sx - r * 1.05, sy + r * 0.28, r * 2.1, r * 0.5, r * 0.25); ctx.fill();
}
function roundedRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawAim() {
  if (!myTurn()) return;
  const t = S.tanks[S.you]; const aim = myAim(); const dir = S.you === 0 ? 1 : -1;
  const rad = aim.angle * Math.PI / 180;
  const sx = wx2s(t.x), sy = wy2s(t.y - 12);
  const len = 26 + aim.power * 0.9;
  const ex = sx + Math.cos(rad) * dir * len, ey = sy - Math.sin(rad) * len;
  ctx.save();
  ctx.setLineDash([5, 6]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,210,63,.9)';
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,210,63,.95)';
  ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawProjectiles() {
  const A = S.anim; if (!A) return;
  for (const pr of A.projectiles) {
    if (A.elapsed < pr.delay) continue;
    if (pr.done && pr.exploded) continue;
    const p = projPos(pr); if (!p) continue;
    pr.trail.push([p.x, p.y]); if (pr.trail.length > 10) pr.trail.shift();
    ctx.strokeStyle = 'rgba(255,220,150,.5)'; ctx.lineWidth = 2;
    ctx.beginPath();
    pr.trail.forEach((pt, idx) => { const x = wx2s(pt[0]), y = wy2s(pt[1]); idx ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    const sx = wx2s(p.x), sy = wy2s(p.y);
    ctx.fillStyle = '#fff2c0'; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,180,60,.5)'; ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.fill();
  }
}
function projPos(pr) {
  const path = pr.path; if (!path.length) return null;
  const i = Math.floor(pr.pos), f = pr.pos - i;
  if (i >= path.length - 1) return { x: path[path.length - 1][0], y: path[path.length - 1][1] };
  return { x: path[i][0] * (1 - f) + path[i + 1][0] * f, y: path[i][1] * (1 - f) + path[i + 1][1] * f };
}

function drawRings() {
  for (const rg of S.rings) {
    const a = 1 - rg.age / rg.life;
    const r = rg.r + (rg.rMax - rg.r) * (rg.age / rg.life);
    ctx.globalAlpha = Math.max(0, a * 0.7);
    ctx.strokeStyle = rg.color; ctx.lineWidth = Math.max(2, 4 * view.scale);
    ctx.beginPath(); ctx.arc(wx2s(rg.x), wy2s(rg.y), r * view.scale, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function drawParticles() {
  for (const p of S.particles) {
    const a = 1 - p.age / p.life;
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(wx2s(p.x), wy2s(p.y), Math.max(1, p.r * view.scale * (0.6 + a)), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function drawFloaters() {
  for (const f of S.floaters) {
    const a = 1 - f.age / f.life;
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = f.color; ctx.font = `900 ${Math.max(16, 22 * view.scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(f.text, wx2s(f.x), wy2s(f.y));
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'left';
}

function updateClock() {
  if (!S.playing || !S.clockEndsAt) { $('clock').textContent = '—'; $('clock').classList.remove('low'); return; }
  const rem = Math.max(0, Math.ceil((S.clockEndsAt - Date.now()) / 1000));
  $('clock').textContent = rem;
  $('clock').classList.toggle('low', rem <= 6);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  $('nameInput').value = savedName();
  $('muteBtn').textContent = Audio.muted ? '🔇' : '🔊';
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) $('codeInput').value = room.toUpperCase();
  resize();
  connect();
  requestAnimationFrame(frame);
  if (room && savedName()) setTimeout(() => intent({ type: 'join', code: room.toUpperCase(), name: savedName() }), 300);
}
boot();
