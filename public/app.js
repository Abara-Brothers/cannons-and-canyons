'use strict';
// Canyons & Cannons — client. Renders the shared board, handles input, and
// replays the server's authoritative shots so both screens stay identical.
// HD pixel-art presentation: full-resolution canvas with chunky block terrain,
// posterized sky. The camera NEVER moves or zooms during a shot — it stays on
// your tank; you control zoom with buttons / wheel / pinch (out to the whole
// map). Accidental disconnects can resume the same match.

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  ws: null, connected: false,
  world: { w: 24000, h: 13500 },
  you: 0, names: ['Player 1', 'Player 2'],
  skins: ['olive', 'desert'],
  weapons: [], weaponById: {},
  terrain: null, minY: 0,
  trees: [],
  hazards: [],
  tanks: [{ x: 900, y: 9720 }, { x: 23100, y: 9720 }],
  hp: [100, 100], maxHp: 100,
  ammo: {},
  turn: 0, fuel: 4500, moveBudget: 4500,
  selected: 'cannon',
  aim: [{ angle: 45, power: 60 }, { angle: 45, power: 60 }],   // persists between turns
  code: null, quick: false,
  playing: false,
  anim: null, queue: [], pendingOver: null, terrainAnim: null,
  particles: [], floaters: [], rings: [], flash: 0, shake: 0,
  charging: false, pullPointer: null,
  userZoom: 1,
};
const WW = () => S.world.w, WH = () => S.world.h;
const MOVE_MIN = 60;

// ---------------------------------------------------------------------------
// Tank paints (cosmetics). Locked ones are part of the Supporter Pack.
// ---------------------------------------------------------------------------
const SKINS = {
  olive:    { name: 'Olive',    lite: '#8a9a6d', mid: '#5d7050', dark: '#38452f' },
  desert:   { name: 'Desert',   lite: '#c2ad85', mid: '#94805d', dark: '#5c4f39' },
  jungle:   { name: 'Jungle',   lite: '#7fae62', mid: '#4e7a40', dark: '#2f4d28' },
  midnight: { name: 'Midnight', lite: '#7d8bb0', mid: '#4a5a86', dark: '#2c3a5e', locked: true },
  arctic:   { name: 'Arctic',   lite: '#dfe8ee', mid: '#a9bcc9', dark: '#7c93a3', locked: true },
  gold:     { name: 'Gold',     lite: '#e8cf7a', mid: '#c0a23f', dark: '#8a7020', locked: true },
};
function mySkin() {
  const s = localStorage.getItem('cc_skin');
  return SKINS[s] && !SKINS[s].locked ? s : 'olive';
}
function buildSkinRow() {
  const row = $('skinRow'); if (!row) return;
  row.innerHTML = '';
  for (const [id, sk] of Object.entries(SKINS)) {
    const b = document.createElement('button');
    b.className = 'swatch' + (mySkin() === id ? ' sel' : '');
    b.style.background = `linear-gradient(180deg, ${sk.lite}, ${sk.dark})`;
    b.title = sk.name + (sk.locked ? ' — Supporter Pack' : '');
    if (sk.locked) b.innerHTML = '<span class="lock">🔒</span>';
    b.onclick = () => {
      if (sk.locked) { showToast('Supporter Pack paint — see the shop soon!'); return; }
      localStorage.setItem('cc_skin', id);
      buildSkinRow();
    };
    row.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Custom weapon icons + trajectory badges (inline SVG, one per weapon)
// ---------------------------------------------------------------------------
const ICONS = {
  cannon: `<svg viewBox="0 0 24 24"><circle cx="15" cy="12" r="5.5" fill="#ff5a52"/><path d="M2 12h7M4 8l4 1.5M4 16l4-1.5" stroke="#ffcf9e" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>`,
  mortar: `<svg viewBox="0 0 24 24"><path d="M12 21c-3.3 0-6-2.7-6-6 0-4 3-6 6-11 3 5 6 7 6 11 0 3.3-2.7 6-6 6z" fill="#ffb02e"/><circle cx="12" cy="15" r="2.2" fill="#7a4d00"/></svg>`,
  volley: `<svg viewBox="0 0 24 24"><path d="M6 20L9 8M12 20V6M18 20L15 8" stroke="#7c6cff" stroke-width="2.6" stroke-linecap="round" fill="none"/><g fill="#ffd23f"><circle cx="9" cy="6.5" r="1.7"/><circle cx="12" cy="4.5" r="1.7"/><circle cx="15" cy="6.5" r="1.7"/></g></svg>`,
  railgun: `<svg viewBox="0 0 24 24"><path d="M2 12h12" stroke="#3ce88f" stroke-width="2.4" stroke-linecap="round"/><path d="M13 6.8l8 5.2-8 5.2 2.6-5.2z" fill="#3ce88f"/></svg>`,
  cluster: `<svg viewBox="0 0 24 24"><circle cx="12" cy="7.5" r="4" fill="#ffd23f"/><path d="M10 11l-4 4.5M12 12v5.5M14 11l4 4" stroke="#ffd23f" stroke-width="1.2" opacity=".65" fill="none"/><g fill="#ff9d3d"><circle cx="5.5" cy="17.5" r="2.1"/><circle cx="12" cy="19.5" r="2.1"/><circle cx="18.5" cy="17" r="2.1"/></g></svg>`,
  napalm: `<svg viewBox="0 0 24 24"><path d="M12 22c-4 0-7-2.6-7-6.5C5 10 9 8.5 9 4c2.5 1.5 3.6 4 3.2 6.2C14 9 15 7.5 15 5.5c3 2.3 4 5.5 4 8 0 5-3 8.5-7 8.5z" fill="#ff6a3d"/><path d="M12 22c-2 0-3.5-1.6-3.5-3.7 0-2.4 2-3.5 3.2-5.8 1.6 1.8 3.8 3.2 3.8 5.7S14 22 12 22z" fill="#ffd23f"/></svg>`,
  gas: `<svg viewBox="0 0 24 24"><g fill="#9dde4b"><circle cx="8" cy="10" r="4"/><circle cx="14" cy="8" r="4.6"/><circle cx="17" cy="12" r="3.4"/><circle cx="11" cy="12.5" r="4"/></g><g fill="#6fae2b"><circle cx="8" cy="18" r="1.2"/><circle cx="13" cy="19.5" r="1.4"/><circle cx="17" cy="17.5" r="1.1"/></g></svg>`,
  airstrike: `<svg viewBox="0 0 24 24" fill="#54c8ff"><path d="M2 13.5l9-.8 4.5-7.2 2.2.9-2.4 6 6.2-.5.5 2-7.5 1.6-3.4 5.9-2.2-.9 1.9-4.7-8.3.7z"/></svg>`,
  buster: `<svg viewBox="0 0 24 24"><path d="M12 2v9" stroke="#c98a4b" stroke-width="3" stroke-linecap="round"/><path d="M7 10l5 7.5L17 10z" fill="#c98a4b"/><path d="M3 21h18M6 18h12" stroke="#7a5a30" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  wall: `<svg viewBox="0 0 24 24" fill="#8a5a2b"><rect x="3" y="5.5" width="8.6" height="4.2" rx="1"/><rect x="12.6" y="5.5" width="8.4" height="4.2" rx="1"/><rect x="3" y="14.5" width="8.6" height="4.2" rx="1"/><rect x="12.6" y="14.5" width="8.4" height="4.2" rx="1"/><rect x="7.8" y="10" width="8.6" height="4.2" rx="1" fill="#a06b35"/></svg>`,
  nuke: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#26350f"/><g fill="#b6ff5a"><path d="M12 12L8.2 4.6a9 9 0 017.6 0z"/><path d="M12 12L8.2 4.6a9 9 0 017.6 0z" transform="rotate(120 12 12)"/><path d="M12 12L8.2 4.6a9 9 0 017.6 0z" transform="rotate(240 12 12)"/><circle cx="12" cy="12" r="2.1"/></g></svg>`,
};
const TRAJ = {
  cannon: `<svg viewBox="0 0 24 14"><path d="M2 12 Q12 1 22 12" stroke="#aeb9d6" stroke-width="1.6" fill="none"/><circle cx="22" cy="12" r="1.9" fill="#ff5a52"/></svg>`,
  mortar: `<svg viewBox="0 0 24 14"><path d="M5 13 Q12 -6 19 13" stroke="#aeb9d6" stroke-width="1.6" fill="none"/><circle cx="19" cy="13" r="2.2" fill="#ffb02e"/></svg>`,
  volley: `<svg viewBox="0 0 24 14"><g stroke="#aeb9d6" stroke-width="1.2" fill="none"><path d="M2 13 Q8 4 14 13"/><path d="M2 13 Q10 1 18 13"/><path d="M2 13 Q12 0 21 12"/></g></svg>`,
  railgun: `<svg viewBox="0 0 24 14"><path d="M2 8h16" stroke="#3ce88f" stroke-width="1.8"/><path d="M17 4.6l6 3.4-6 3.4z" fill="#3ce88f"/></svg>`,
  cluster: `<svg viewBox="0 0 24 14"><path d="M2 12 Q8 1 13 4" stroke="#aeb9d6" stroke-width="1.6" fill="none"/><g stroke="#ffd23f" stroke-width="1.3" fill="none"><path d="M13 4L9 12"/><path d="M13 4L14 12"/><path d="M13 4L19 12"/></g></svg>`,
  napalm: `<svg viewBox="0 0 24 14"><path d="M2 11 Q8 0 13 3" stroke="#aeb9d6" stroke-width="1.6" fill="none"/><g stroke="#ff6a3d" stroke-width="1.2" fill="none"><path d="M13 3L9 10"/><path d="M13 3L14 10"/><path d="M13 3L19 10"/></g><g fill="#ff6a3d"><circle cx="9" cy="12" r="1.4"/><circle cx="14" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></g></svg>`,
  gas: `<svg viewBox="0 0 24 14"><path d="M2 12 Q9 1 15 8" stroke="#aeb9d6" stroke-width="1.6" fill="none"/><g fill="#9dde4b" opacity=".9"><circle cx="17" cy="9" r="2.7"/><circle cx="20.5" cy="8" r="2"/><circle cx="15.5" cy="11" r="2"/></g></svg>`,
  airstrike: `<svg viewBox="0 0 24 14"><path d="M2 11 Q6 3 10 5" stroke="#aeb9d6" stroke-width="1.3" fill="none"/><g stroke="#54c8ff" stroke-width="1.3" fill="none"><path d="M14 1v6"/><path d="M18 0v6"/><path d="M22 1v6"/></g><g fill="#54c8ff"><path d="M14 11l-2-3.4h4z"/><path d="M18 10l-2-3.4h4z"/><path d="M22 11l-2-3.4h4z"/></g></svg>`,
  buster: `<svg viewBox="0 0 24 14"><path d="M2 9 Q9 0 16 6" stroke="#aeb9d6" stroke-width="1.6" fill="none"/><path d="M14 9h8" stroke="#7a5a30" stroke-width="1.3"/><path d="M18 6v4" stroke="#c98a4b" stroke-width="1.8"/><path d="M18 14l-2.4-3.4h4.8z" fill="#c98a4b"/></svg>`,
  wall: `<svg viewBox="0 0 24 14"><path d="M2 12 Q9 2 15 8" stroke="#aeb9d6" stroke-width="1.6" fill="none"/><rect x="16.5" y="3.5" width="5" height="9.5" rx="1" fill="#8a5a2b"/></svg>`,
  nuke: `<svg viewBox="0 0 24 14"><path d="M2 12 Q10 0 17 8" stroke="#aeb9d6" stroke-width="1.6" fill="none"/><circle cx="18" cy="9" r="4" fill="#b6ff5a" opacity=".4"/><circle cx="18" cy="9" r="1.8" fill="#b6ff5a"/></svg>`,
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
    const t = c.currentTime, dur = Math.min(1.1, 0.35 + r / 900);
    const n = c.createBufferSource(), buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    n.buffer = buf; const lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(120, t + dur);
    const ng = c.createGain(); ng.gain.setValueAtTime(Math.min(0.5, 0.25 + r / 1400), t); ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(lp).connect(ng).connect(c.destination); n.start(t); n.stop(t + dur);
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
// Canvas + camera (full-resolution crisp rendering; STATIC during shots)
// ---------------------------------------------------------------------------
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
// Crisp, HD rendering: the battlefield draws at FULL device resolution (backing
// store = CSS size × devicePixelRatio) with smoothing on, so edges are sharp on
// retina screens. All draw code works in CSS pixels (view.cssW/cssH).
let view = { cssW: 0, cssH: 0, dispW: 0, dispH: 0, pix: 1 };
const cam = { zoom: 0.05, cx: 9000, cy: 6000 };

function resize() {
  const stage = $('stage');
  const dw = stage.clientWidth, dh = stage.clientHeight;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  view.cssW = Math.max(2, dw);
  view.cssH = Math.max(2, dh);
  view.dispW = dw; view.dispH = dh;
  canvas.width = Math.round(dw * dpr);
  canvas.height = Math.round(dh * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
}
window.addEventListener('resize', resize);

const wx2s = (x) => (x - cam.cx) * cam.zoom + view.cssW / 2;
const wy2s = (y) => (y - cam.cy) * cam.zoom + view.cssH / 2;
const s2wx = (sx) => (sx - view.cssW / 2) / cam.zoom + cam.cx;

function fullZoom() { return view.cssW / WW(); }
// Most zoomed-out = fill the screen WIDTH exactly, so the map's side edges (and the
// void beyond them) never come into view. Sky fills any vertical overflow, so there's
// no top/bottom edge either. Both tanks (near x=900 / WW-900) stay on screen.
function minMapZoom() { return view.cssW / WW(); }
const clampUserZoom = (z) => Math.max(0.25, Math.min(6, Number.isFinite(z) ? z : 1));
const finite = (v, fb) => (Number.isFinite(v) ? v : fb);

// Aim zoom baseline. Wide screens: whole battlefield. Portrait: fill the tall
// screen with the terrain band around your tank.
function aimZoom() {
  const fzW = fullZoom();
  const band = WH() - S.minY;
  if (band * fzW >= view.cssH * 0.42) return fzW;
  return Math.min(0.14, Math.max(fzW, view.cssH / (band + 1400)));
}

// The camera NEVER follows shots. It frames YOUR tank; you control the zoom.
// Every output is finite-guarded — a zero-sized stage (hidden screen) or any
// transient NaN can never poison the camera.
function cameraTarget() {
  if (!view.cssW || !view.cssH) {
    return { tz: finite(cam.zoom, 0.05), tx: finite(cam.cx, WW() / 2), ty: finite(cam.cy, WH() * 0.72) };
  }
  let tz = aimZoom() * S.userZoom;
  tz = Math.min(0.32, Math.max(minMapZoom(), tz));
  const focus = S.tanks[S.you] || S.tanks[0];
  const vw = view.cssW / tz, vh = view.cssH / tz;
  let tx = focus.x;
  // Vertical: frame the acting tank (with arc headroom) while aiming; near full
  // zoom-out, drift to the midpoint of both tanks so both stay on screen. Blend on
  // the zoom level alone: 1 at min zoom → 0 once zoomed to 1.6× min (aiming).
  const mz = minMapZoom();
  const surveyMix = Math.max(0, Math.min(1, (mz * 1.6 - tz) / (mz * 0.6)));
  const other = S.tanks[1 - S.you] || focus;
  const framedY = focus.y - vh * 0.18;
  const surveyY = (focus.y + other.y) / 2;
  let ty = framedY + (surveyY - framedY) * surveyMix;
  tx = vw >= WW() ? WW() / 2 : Math.min(WW() - vw / 2, Math.max(vw / 2, tx));
  ty = vh >= WH() ? WH() - vh / 2 : Math.min(WH() - vh / 2, Math.max(vh / 2, ty));
  return { tz: finite(tz, 0.05), tx: finite(tx, WW() / 2), ty: finite(ty, WH() * 0.72) };
}

function updateCamera(dt) {
  const { tz, tx, ty } = cameraTarget();
  if (!Number.isFinite(cam.zoom) || !Number.isFinite(cam.cx) || !Number.isFinite(cam.cy)) {
    cam.zoom = tz; cam.cx = tx; cam.cy = ty;      // self-heal from any bad state
    return;
  }
  const k = 1 - Math.exp(-dt * 4);
  cam.zoom += (tz - cam.zoom) * k;
  cam.cx += (tx - cam.cx) * k;
  cam.cy += (ty - cam.cy) * k;
}
function snapCamera() {
  const { tz, tx, ty } = cameraTarget();
  cam.zoom = tz; cam.cx = tx; cam.cy = ty;
}

function surfaceAt(x) {
  const t = S.terrain; if (!t) return WH() * 0.72;
  if (x <= 0) return t[0];
  if (x >= WW()) return t[WW()];
  const i = Math.floor(x), f = x - i;
  return t[i] * (1 - f) + t[i + 1] * f;
}

function computeMinY() {
  let m = Infinity;
  for (let i = 0; i < S.terrain.length; i++) if (S.terrain[i] < m) m = S.terrain[i];
  S.minY = m;
}

// ---------------------------------------------------------------------------
// User zoom: buttons, mouse wheel, pinch
// ---------------------------------------------------------------------------
$('zoomIn').onclick = () => { S.userZoom = clampUserZoom(S.userZoom * 1.35); };
$('zoomOut').onclick = () => { S.userZoom = clampUserZoom(S.userZoom / 1.35); };
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  S.userZoom = clampUserZoom(S.userZoom * (e.deltaY > 0 ? 0.9 : 1.111));
}, { passive: false });

const pointers = new Map();
let pinchStart = null;

// ---------------------------------------------------------------------------
// Resume support — an accidental disconnect keeps your seat for 2 minutes.
// ---------------------------------------------------------------------------
function saveResume(code, token) {
  try { localStorage.setItem('cc_resume', JSON.stringify({ code, token })); } catch {}
}
function loadResume() {
  try { return JSON.parse(localStorage.getItem('cc_resume') || 'null'); } catch { return null; }
}
function clearResume() { try { localStorage.removeItem('cc_resume'); } catch {} }

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
function connect() {
  const remote = window.CC_SERVER;                   // set in config.js for packaged app builds
  const host = remote || location.host;
  const proto = remote ? 'wss' : (location.protocol === 'https:' ? 'wss' : 'ws');
  const ws = new WebSocket(`${proto}://${host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true; $('connErr').classList.add('hidden');
    const r = loadResume();
    if (r && (S.playing || !S.code)) sendMsg({ type: 'resume', code: r.code, token: r.token });
    flushIntent();
  };
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
    case 'start': applySnapshot(m); saveResume(m.code, m.token); break;
    case 'restore':
      applySnapshot(m); saveResume(m.code, m.token);
      showToast('Reconnected — battle on!');
      break;
    case 'resumeError': clearResume(); break;
    case 'oppConn':
      showToast(m.connected ? 'Opponent reconnected' : 'Opponent lost connection — holding their seat…');
      break;
    case 'turn': onTurn(m); break;
    case 'aim': if (m.seat !== S.you) { S.aim[m.seat] = { angle: m.angle, power: m.power }; } break;
    case 'move':
      S.tanks[m.seat] = { x: m.x, y: m.y };
      if (m.seat === S.you) { S.fuel = m.fuel; updateFuel(); }
      break;
    case 'shot': enqueueShot(m); break;
    case 'dot': applyDot(m); break;
    case 'gameover':
      clearResume();
      if (S.anim || S.queue.length) S.pendingOver = m;
      else onGameOver(m);
      break;
    case 'opponentLeft':
      clearResume();
      S.playing = false; showOverlay('Opponent left', null, 'draw', true); break;
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

$('createBtn').onclick = () => { Audio.ensure(); $('homeError').textContent = ''; intent({ type: 'create', name: myName(), skin: mySkin() }); };
$('quickBtn').onclick = () => { Audio.ensure(); S.quick = true; $('homeError').textContent = ''; intent({ type: 'quick', name: myName(), skin: mySkin() }); };

// Single-player vs CPU, with a difficulty selector.
let cpuDifficulty = localStorage.getItem('pt_diff') || 'medium';
(function initDiff() {
  const row = $('diffRow');
  const sync = () => { for (const el of row.querySelectorAll('.diff')) el.classList.toggle('active', el.dataset.diff === cpuDifficulty); };
  row.addEventListener('click', (e) => {
    const b = e.target.closest('.diff'); if (!b) return;
    cpuDifficulty = b.dataset.diff; localStorage.setItem('pt_diff', cpuDifficulty); sync();
  });
  sync();
})();
$('cpuBtn').onclick = () => { Audio.ensure(); $('homeError').textContent = ''; intent({ type: 'ai', difficulty: cpuDifficulty, name: myName(), skin: mySkin() }); };
$('joinBtn').onclick = () => {
  Audio.ensure();
  const code = ($('codeInput').value || '').toUpperCase().trim();
  if (code.length < 3) { $('homeError').textContent = 'Enter the 4-letter code.'; return; }
  $('homeError').textContent = '';
  intent({ type: 'join', code, name: myName(), skin: mySkin() });
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

function showScreen(name) { for (const s of ['home', 'lobby', 'game']) $(s).classList.toggle('active', s === name); }
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
// Game setup (also used to restore a resumed match)
// ---------------------------------------------------------------------------
function applySnapshot(m) {
  S.world = m.world || S.world;
  S.you = m.you; S.names = m.names; S.weapons = m.weapons;
  S.skins = m.skins || S.skins;
  S.weaponById = Object.fromEntries(m.weapons.map(w => [w.id, w]));
  S.terrain = m.terrain.slice();
  S.trees = (m.trees || []).map(t => ({ ...t }));
  S.hazards = m.hazards || [];
  S.tanks = m.tanks.map(t => ({ x: t.x, y: t.y }));
  S.hp = (m.hp || [100, 100]).slice(); S.maxHp = m.maxHp || 100;
  S.ammo = m.ammo; S.moveBudget = m.moveBudget;
  S.turn = m.turn; S.fuel = m.fuel ?? m.moveBudget;
  S.code = m.code || S.code;
  S.aim = [{ angle: 45, power: 60 }, { angle: 45, power: 60 }];
  S.selected = firstAvailableWeapon();
  S.playing = true; S.quick = false; S.anim = null; S.queue = []; S.pendingOver = null;
  S.particles = []; S.floaters = []; S.rings = []; S.flash = 0; S.shake = 0;
  S.charging = false; S.pullPointer = null; S.userZoom = 1;
  computeMinY();
  $('overlay').classList.add('hidden');
  showScreen('game');
  resize();
  snapCamera();
  buildWeaponStrip();
  $('p0').querySelector('.pname').textContent = m.names[0] + (S.you === 0 ? ' (you)' : '');
  $('p1').querySelector('.pname').textContent = m.names[1] + (S.you === 1 ? ' (you)' : '');
  updateHud(); updateAimUI(); updateFuel(); updateDock();
}

function onTurn(m) {
  S.turn = m.turn; S.fuel = m.fuel;
  if (m.turn === S.you && (S.ammo[S.selected] ?? 99) <= 0) S.selected = firstAvailableWeapon();
  updateFuel(); updateDock(); buildWeaponStrip();
}

function firstAvailableWeapon() {
  for (const w of S.weapons) if ((S.ammo[w.id] ?? w.ammo) > 0) return w.id;
  return 'cannon';
}

// ---------------------------------------------------------------------------
// HUD (health bars — destroy the enemy tank to win)
// ---------------------------------------------------------------------------
function hpColor(pct) { return pct > 0.6 ? '#3ce88f' : pct > 0.3 ? '#ffd23f' : '#ff5a52'; }
function updateHud() {
  for (let i = 0; i < 2; i++) {
    const el = $(i === 0 ? 'p0' : 'p1');
    const hp = Math.max(0, Math.round(S.hp[i]));
    el.querySelector('.score').textContent = hp;
    el.querySelector('.shots').textContent = 'HP';
    const bar = el.querySelector('.hpbar i');
    const pct = Math.max(0, Math.min(1, hp / S.maxHp));
    bar.style.width = (pct * 100) + '%';
    bar.style.background = hpColor(pct);
  }
}
function updateFuel() {
  const pct = Math.max(0, Math.min(100, (S.fuel / S.moveBudget) * 100));
  $('fuelBar').style.width = pct + '%';
}
function myTurn() { return S.turn === S.you && S.playing && !S.anim; }
// You may line up your NEXT shot (aim + weapon) at any time — even while the
// opponent is shooting. Only moving and firing wait for your turn.
function canAim() { return S.playing; }

function updateDock() {
  const active = myTurn();
  $('turnLabel').textContent = active ? 'YOUR TURN' : (S.playing ? `${S.names[S.turn]}'s turn — line up your shot` : '');
  $('fireBtn').disabled = !active;
  $('moveLeft').disabled = !active || S.fuel < MOVE_MIN;
  $('moveRight').disabled = !active || S.fuel < MOVE_MIN;
}

function buildWeaponStrip() {
  const strip = $('weaponStrip'); strip.innerHTML = '';
  for (const w of S.weapons) {
    const left = S.ammo[w.id] ?? w.ammo;
    const chip = document.createElement('button');
    chip.className = 'wchip' + (w.id === S.selected ? ' sel' : '') + (left <= 0 ? ' empty' : '');
    const ammoTxt = w.ammo >= 99 ? '∞' : `×${left}`;
    chip.innerHTML = `<span class="wrow"><span class="wi">${ICONS[w.id] || ''}</span><span class="wt">${TRAJ[w.id] || ''}</span></span><span class="wn">${w.name}</span><span class="wa">${ammoTxt}</span>`;
    chip.title = w.desc;
    chip.onclick = () => { if (left > 0 && canAim()) { S.selected = w.id; buildWeaponStrip(); } };
    strip.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Aim controls (available even while waiting for your turn)
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
    if (!canAim()) return;
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

// Drag-to-charge aiming (single pointer). Two pointers = pinch zoom.
function maxPull() { return Math.min(view.cssW, view.cssH) * 0.55; }
function aimFromPointer(sx, sy) {
  const tank = S.tanks[S.you];
  const ax = wx2s(tank.x), ay = wy2s(surfaceAt(tank.x) - 24);
  const dx = sx - ax, dy = sy - ay;
  const dir = S.you === 0 ? 1 : -1;
  const raw = Math.atan2(-dy, dx * dir) * 180 / Math.PI;
  const power = (Math.hypot(dx, dy) / maxPull()) * 100;
  S.pullPointer = { sx, sy };
  setAim(raw, power);
}
// Pointer offset → draw-space coords. Draw space is CSS pixels (view.cssW ==
// display width), so this is an identity, kept for clarity/robustness.
const evX = (e) => e.offsetX * view.cssW / (view.dispW || 1);
const evY = (e) => e.offsetY * view.cssH / (view.dispH || 1);
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: evX(e), y: evY(e) });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    S.charging = false; S.pullPointer = null;
    const [a, b] = [...pointers.values()];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: S.userZoom };
    return;
  }
  if (!canAim()) return;
  S.charging = true;
  aimFromPointer(evX(e), evY(e));
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: evX(e), y: evY(e) });
  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchStart.d > 0) S.userZoom = clampUserZoom(pinchStart.zoom * (d / pinchStart.d));
    return;
  }
  if (S.charging && canAim()) aimFromPointer(evX(e), evY(e));
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) { S.charging = false; S.pullPointer = null; }
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function holdMove(btn, dir) {
  let iv = null;
  const tick = () => { if (myTurn() && S.fuel >= MOVE_MIN) sendMsg({ type: 'move', dir }); };
  const start = (e) => { e.preventDefault(); tick(); iv = setInterval(tick, 45); };
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
  S.charging = false; S.pullPointer = null;
  updateDock();
};

// ---------------------------------------------------------------------------
// Terrain collapse — destroyed ground crumbles instead of popping to its new
// shape. Columns fall with gravity easing, radiating out from the blast;
// raised earthworks pile up with a soft settle instead.
// ---------------------------------------------------------------------------
function startTerrainCollapse(diff) {
  finishTerrainAnim();                       // snap any still-running collapse
  const { from, values } = diff;
  const old = new Array(values.length);
  for (let i = 0; i < values.length; i++) old[i] = S.terrain[from + i];
  const mid = (values.length - 1) / 2;
  const delays = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    delays[i] = (Math.abs(i - mid) / Math.max(1, mid)) * 0.14 + Math.random() * 0.08;
  }
  S.terrainAnim = { from, old, target: values.slice(), delays, t: 0, dur: 0.55 };
}
function finishTerrainAnim() {
  const A = S.terrainAnim; if (!A) return;
  for (let i = 0; i < A.target.length; i++) S.terrain[A.from + i] = A.target[i];
  S.terrainAnim = null;
  computeMinY();
}
function stepTerrainAnim(dt) {
  const A = S.terrainAnim; if (!A) return;
  A.t += dt;
  let allDone = true;
  for (let i = 0; i < A.target.length; i++) {
    const lt = (A.t - A.delays[i]) / A.dur;
    if (lt <= 0) { allDone = false; continue; }
    if (lt >= 1) { S.terrain[A.from + i] = A.target[i]; continue; }
    allDone = false;
    const o = A.old[i], tg = A.target[i];
    // dropping ground accelerates like a fall; rising earth eases into place
    const e = tg > o ? lt * lt : 1 - Math.pow(1 - lt, 3);
    S.terrain[A.from + i] = o + (tg - o) * e;
  }
  if (allDone) { S.terrainAnim = null; computeMinY(); }
}

// ---------------------------------------------------------------------------
// Shot animation queue (the camera does NOT follow — it stays on your tank)
// ---------------------------------------------------------------------------
function enqueueShot(m) { S.queue.push(m); if (!S.anim) startNextShot(); }
function startNextShot() {
  const m = S.queue.shift();
  if (!m) {
    updateDock();
    if (S.pendingOver) { const o = S.pendingOver; S.pendingOver = null; onGameOver(o); }
    return;
  }
  S.anim = {
    m, elapsed: 0,
    projectiles: m.projectiles.map(p => ({ path: p.path, det: p.det, delay: p.delay || 0, beacon: !!p.beacon, pos: 0, done: false, exploded: false, trail: [] })),
    settleTimer: 0, resolved: false,
  };
  Audio.fire();
  updateDock();
}

const PLAYBACK = 115; // path points per second
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
    if (A.settleTimer > 0.6) { S.anim = null; startNextShot(); }
  }
}

function detonate(det) {
  if (det.kind === 'none' && det.r < 30 && !det.hz) { // burst puff / beacon flare
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 200;
      S.particles.push({ x: det.x, y: det.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0.4, age: 0, r: 14, color: det.color });
    }
    S.rings.push({ x: det.x, y: det.y, r: 20, rMax: 160, age: 0, life: 0.4, color: det.color });
    return;
  }
  S.flash = Math.min(0.5, S.flash + (det.r / 500) * 0.35);
  S.shake = Math.min(8, S.shake + det.r / 130);   // just a little kick on impact
  S.rings.push({ x: det.x, y: det.y, r: det.r * 0.3, rMax: det.r * 2.2, age: 0, life: 0.5, color: det.color });
  S.rings.push({ x: det.x, y: det.y, r: det.r * 0.15, rMax: det.r * 1.4, age: 0, life: 0.32, color: '#fff2c0' });
  Audio.boom(det.r);
  if (navigator.vibrate) navigator.vibrate(Math.min(80, det.r / 6));
  // fireball flash particles (weapon-coloured)
  const base = det.hz === 'gas' ? '#9dde4b' : det.kind === 'dirt' || det.kind === 'wall' ? '#8a5a2b' : det.color;
  const n = Math.round(8 + det.r / 60);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = (0.4 + Math.random()) * det.r * 3.0;
    S.particles.push({ x: det.x, y: det.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - det.r * 1.1, life: 0.5 + Math.random() * 0.5, age: 0, r: 9 + Math.random() * (det.r / 16), color: base });
  }
  // Terrain debris — the soil itself blows out. TOPSOIL is loose: lots of
  // small green/grass clods that launch fast and scatter far. DEEP SOIL is
  // dense: fewer, bigger, darker chunks that barely clear the rim and slam
  // back down under heavier gravity.
  if (det.kind === 'crater' || det.kind === 'dirt' || det.kind === 'wall') {
    const gy = surfaceAt(det.x);
    const topsoil = ['#a6d878', '#6fb04a', '#5da23a'];
    const deep = ['#6b5a34', '#4a3a24', '#2e2213'];
    const nTop = Math.min(46, Math.round(12 + det.r / 22));
    for (let i = 0; i < nTop; i++) {
      const ang = -Math.PI * (0.16 + Math.random() * 0.68);          // upward fan
      const sp = (0.9 + Math.random() * 1.1) * det.r * 3.4;          // loose — flies far
      S.particles.push({
        x: det.x + (Math.random() - 0.5) * det.r * 0.9, y: gy - 4,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        life: 0.8 + Math.random() * 0.7, age: 0,
        r: 5 + Math.random() * 5, g: 0.85, shape: 'rect',
        color: topsoil[(Math.random() * topsoil.length) | 0],
      });
    }
    const nDeep = Math.min(26, Math.round(6 + det.r / 45));
    for (let i = 0; i < nDeep; i++) {
      const ang = -Math.PI * (0.28 + Math.random() * 0.44);          // steeper, shorter throw
      const sp = (0.5 + Math.random() * 0.6) * det.r * 2.1;          // dense — doesn't travel
      S.particles.push({
        x: det.x + (Math.random() - 0.5) * det.r * 0.6, y: gy + det.r * 0.25,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        life: 0.6 + Math.random() * 0.45, age: 0,
        r: 13 + Math.random() * 12, g: 1.35, shape: 'rect',
        color: deep[(Math.random() * deep.length) | 0],
      });
    }
    for (let i = 0; i < 5; i++) { // hanging dust
      S.particles.push({
        x: det.x + (Math.random() - 0.5) * det.r, y: gy - det.r * 0.15,
        vx: (Math.random() - 0.5) * 90, vy: -60 - Math.random() * 80,
        life: 1.3 + Math.random() * 0.8, age: 0, r: 20 + Math.random() * (det.r / 10),
        g: 0.12, color: 'rgba(150,125,88,0.35)',
      });
    }
  }
  for (let i = 0; i < 6; i++) { // rising smoke
    S.particles.push({ x: det.x + (Math.random() - 0.5) * det.r, y: det.y, vx: (Math.random() - 0.5) * 120, vy: -160 - Math.random() * 200, life: 1.0 + Math.random() * 0.7, age: 0, r: 16 + Math.random() * (det.r / 9), g: 0.1, color: 'rgba(60,60,70,0.6)' });
  }
}

function applyResolve(m) {
  if (m.terrainDiff) startTerrainCollapse(m.terrainDiff);
  S.tanks = m.tanks.map(t => ({ x: t.x, y: t.y }));
  // HP only ever falls within a match — take the min so a burn 'dot' that
  // already arrived can't be undone by this (higher) pre-burn snapshot.
  S.hp = (m.hp || S.hp).map((h, i) => Math.min(S.hp[i] ?? h, h));
  S.hazards = m.hazards || [];
  if (m.ammoSeat === S.you && m.ammo) S.ammo = m.ammo;
  updateHud(); buildWeaponStrip();
  for (let i = 0; i < 2; i++) {
    const blast = (m.damage && m.damage[i]) || 0;
    const dot = (m.hazardDamage && m.hazardDamage[i]) || 0;
    if (blast > 0) S.floaters.push({ x: S.tanks[i].x, y: S.tanks[i].y - 160, text: `-${blast}`, age: 0, life: 1.3, color: '#ff6b6b' });
    if (dot > 0) S.floaters.push({ x: S.tanks[i].x, y: S.tanks[i].y - 320, text: `-${dot}`, age: 0, life: 1.3, color: '#ff8a3d' });
  }
}

// A tick of the real-time fire/toxic burn (server 'dot' message).
function applyDot(m) {
  if (m.hp) S.hp = m.hp.map((h, i) => Math.min(S.hp[i], h));
  updateHud();
  for (let i = 0; i < 2; i++) {
    const d = (m.damage && m.damage[i]) || 0;
    if (d <= 0) continue;
    S.floaters.push({ x: S.tanks[i].x, y: S.tanks[i].y - 200, text: `-${d}`, age: 0, life: 1.1, color: '#ff8a3d' });
    for (let k = 0; k < 5; k++) {
      S.particles.push({
        x: S.tanks[i].x + (Math.random() - 0.5) * 70, y: S.tanks[i].y - 10,
        vx: (Math.random() - 0.5) * 50, vy: -120 - Math.random() * 120,
        life: 0.5 + Math.random() * 0.4, age: 0, r: 8 + Math.random() * 9, g: 0.05,
        color: Math.random() < 0.6 ? 'rgba(255,140,40,0.9)' : 'rgba(255,80,30,0.85)',
      });
    }
  }
}

function showToast(text) {
  const t = document.createElement('div');
  t.className = 'toast-item'; t.textContent = text;
  $('toast').appendChild(t);
  setTimeout(() => t.remove(), 1900);
}

// ---------------------------------------------------------------------------
// Game over — a tank was destroyed
// ---------------------------------------------------------------------------
function onGameOver(m) {
  S.playing = false;
  if (m.hp) { S.hp = m.hp.slice(); updateHud(); }
  let title, cls, win = false;
  if (m.winner === -1) { title = 'Mutual destruction!'; cls = 'draw'; }
  else if (m.winner === S.you) { title = 'Enemy destroyed! 🏆'; cls = 'win'; win = true; }
  else { title = 'Your tank was destroyed'; cls = 'lose'; }
  Audio.chime(win);
  showOverlay(title, m.hp, cls, false);
}
function showOverlay(title, hp, cls, hideRematch) {
  const rt = $('resultTitle'); rt.textContent = title; rt.className = 'result ' + cls;
  const fs = $('finalScores');
  if (hp) {
    fs.innerHTML =
      `<div class="fs a"><b>${Math.max(0, hp[0])}</b><span>${S.names[0]} HP</span></div>` +
      `<div class="fs b"><b>${Math.max(0, hp[1])}</b><span>${S.names[1]} HP</span></div>`;
  } else fs.innerHTML = '';
  $('rematchBtn').style.display = hideRematch ? 'none' : '';
  $('overlay').classList.remove('hidden');
}
$('rematchBtn').onclick = () => sendMsg({ type: 'rematch' });
$('exitBtn').onclick = () => { clearResume(); sendMsg({ type: 'leave' }); location.href = location.origin; };

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  if (S.terrain) { advanceAnim(dt); stepTerrainAnim(dt); stepEffects(dt); updateCamera(dt); }
  draw();
  requestAnimationFrame(frame);
}

// Keep playback advancing while the tab is hidden (rAF pauses there).
let bgLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(2, (now - bgLast) / 1000);
  bgLast = now;
  if (document.hidden && S.terrain) { advanceAnim(dt); stepTerrainAnim(dt); stepEffects(dt); }
}, 400);

function stepEffects(dt) {
  S.flash = Math.max(0, S.flash - dt * 1.6);
  S.shake = Math.max(0, S.shake - dt * 30);
  for (const p of S.particles) { p.age += dt; p.vy += 900 * (p.g ?? 1) * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
  S.particles = S.particles.filter(p => p.age < p.life);
  for (const f of S.floaters) { f.age += dt; f.y -= 90 * dt; }
  S.floaters = S.floaters.filter(f => f.age < f.life);
  for (const r of S.rings) r.age += dt;
  S.rings = S.rings.filter(r => r.age < r.life);
  if (S.particles.length < 220) {
    for (const h of S.hazards) {
      if (h.type === 'fire' && Math.random() < dt * 6) {
        S.particles.push({ x: h.x + (Math.random() - 0.5) * h.r * 1.4, y: surfaceAt(h.x) - 10, vx: (Math.random() - 0.5) * 60, vy: -220 - Math.random() * 160, life: 0.8, age: 0, r: 12, color: '#ff9d3d' });
      }
    }
    if (S.playing) {
      for (let i = 0; i < 2; i++) {
        const hp = S.hp[i];
        if (hp > 65 || hp <= 0) continue;
        const heavy = hp <= 30;
        if (Math.random() < dt * (heavy ? 13 : 5)) {
          const t = S.tanks[i];
          S.particles.push({
            x: t.x + (Math.random() - 0.5) * 50, y: t.y - 60,
            vx: (Math.random() - 0.5) * 40 + 15, vy: -140 - Math.random() * 130,
            life: 1.1 + Math.random() * 0.7, age: 0,
            r: heavy ? 26 : 15,
            color: heavy ? 'rgba(35,35,42,0.8)' : 'rgba(105,105,115,0.55)',
          });
          if (heavy && Math.random() < 0.4) {
            S.particles.push({ x: t.x + (Math.random() - 0.5) * 40, y: t.y - 45, vx: (Math.random() - 0.5) * 60, vy: -110, life: 0.45, age: 0, r: 13, color: '#ff8a3d' });
          }
        }
      }
    }
  }
}

function draw() {
  if (view.dispW !== $('stage').clientWidth || view.dispH !== $('stage').clientHeight) resize();
  const { cssW, cssH } = view;
  ctx.save();
  if (S.shake > 0.15) ctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);

  drawSky(cssW, cssH);
  if (S.terrain) {
    drawTerrain(cssW, cssH);
    drawTrees();
    drawHazards();
    drawTank(0); drawTank(1);
    drawEdgeIndicators();
    drawAim();
    drawProjectiles();
    drawRings();
    drawParticles();
    drawFloaters();
  }
  ctx.restore();

  if (S.flash > 0.01) { ctx.fillStyle = `rgba(255,240,210,${S.flash})`; ctx.fillRect(0, 0, cssW, cssH); }
}

// Posterized bright daytime sky (Level-6 look) — flat blue bands, a chunky
// pixel sun and a couple of blocky clouds. Drawn in screen space (a skybox).
const SKY_BANDS = ['#3fb0ff', '#54bcff', '#74caff', '#93d6ff', '#b0e2ff'];
const B = 1;                                    // draw at native backing res; the low-res canvas does the pixelation
function pxRect(x, y, w2, h2) { const q = v => Math.round(v / B) * B; ctx.fillRect(q(x), q(y), q(w2), q(h2)); }
function pxDisc(cx, cy, r, col) { ctx.fillStyle = col; for (let y = -r; y <= r; y += B) for (let x = -r; x <= r; x += B) if (x * x + y * y <= r * r + r * B * 0.5) ctx.fillRect(Math.round((cx + x) / B) * B, Math.round((cy + y) / B) * B, B, B); }
function cloud(cx, cy, s) {
  ctx.fillStyle = '#ffffff';
  pxRect(cx - 26 * s, cy, 52 * s, 10 * s);
  pxRect(cx - 16 * s, cy - 8 * s, 34 * s, 10 * s);
  ctx.fillStyle = '#dceeff';
  pxRect(cx - 26 * s, cy + 8 * s, 52 * s, 4 * s);
}
function drawSky(w, h) {
  const bh = h / SKY_BANDS.length;
  for (let i = 0; i < SKY_BANDS.length; i++) {
    ctx.fillStyle = SKY_BANDS[i];
    ctx.fillRect(0, Math.floor(i * bh), w, Math.ceil(bh) + 1);
  }
  // pixel sun with a soft halo
  const sx = Math.round(w * 0.84), sy = Math.round(h * 0.17);
  pxDisc(sx, sy, 56, 'rgba(255,244,190,.22)');
  pxDisc(sx, sy, 34, '#fff2a8');
  pxDisc(sx, sy, 26, '#ffe873');
  cloud(w * 0.16, h * 0.16, 1.15);
  cloud(w * 0.5, h * 0.1, 0.85);
}

// Terrain colours: exactly FOUR shades, each a fixed DEPTH BELOW THE SURFACE.
// Because every seam is "surface + constant depth", the colour lines follow the
// terrain's angle (parallel to the slope) instead of running flat — no more
// horizontal banding. Two greens on top, two browns below.
const TLAYERS = [
  [55,        '#83cf4f'],   // bright grass cap (0..55 world units below surface)
  [230,       '#4e9235'],   // deeper green slope
  [820,       '#6b4d28'],   // brown soil
  [Infinity,  '#3a2a14'],   // deep dirt to the base
];
function drawTerrain(w, h) {
  const z = cam.zoom;                            // low-res px per world unit
  for (let sx = 0; sx < w; sx++) {
    const wxc = s2wx(sx + 0.5);
    if (wxc < 0 || wxc > WW()) continue;         // letterbox when zoomed out past the map
    const surf = wy2s(surfaceAt(wxc));
    if (surf >= h) continue;
    let top = surf;
    for (let li = 0; li < TLAYERS.length; li++) {
      const bottom = TLAYERS[li][0] === Infinity ? h : surf + TLAYERS[li][0] * z;
      const y0 = Math.max(0, Math.round(top)), y1 = Math.min(h, Math.round(bottom));
      if (y1 > y0) { ctx.fillStyle = TLAYERS[li][1]; ctx.fillRect(sx, y0, 1, y1 - y0); }
      top = bottom;
      if (top >= h) break;
    }
  }
}

// Blocky pixel pines — spaced out, a bit taller.
function drawTrees() {
  const { cssW } = view;
  for (const t of S.trees) {
    const gy = surfaceAt(t.x);
    if (gy - t.y0 > 60) continue;                 // ground was blasted away — tree destroyed
    const sx = Math.round(wx2s(t.x));
    if (sx < -60 || sx > cssW + 60) continue;
    const sy = Math.round(wy2s(gy));
    const hgt = Math.max(5, 340 * t.s * cam.zoom);   // Max Alpine — larger pines
    const u = hgt / 6;
    ctx.fillStyle = '#4a3320';
    ctx.fillRect(sx - u * 0.35, sy - u * 1.5, u * 0.7, u * 1.6);
    const rows = [[5, '#2f5a2b'], [4, '#3a6f34'], [2.9, '#2f5a2b'], [1.7, '#3a6f34']];
    let y = sy - u * 1.4;
    for (const [wMul, col] of rows) {
      const rw = u * wMul;
      ctx.fillStyle = col;
      ctx.fillRect(sx - rw / 2, y - u * 1.15, rw, u * 1.2);
      y -= u * 1.1;
    }
  }
}

// Lingering battlefield hazards: burning ground and toxic gas clouds.
function drawHazards() {
  const t = performance.now() / 1000;
  for (const h of S.hazards) {
    const scx = wx2s(h.x);
    if (scx < -view.cssW || scx > view.cssW * 2) continue;
    if (h.type === 'fire') {
      const n = 7;
      for (let k = 0; k < n; k++) {
        const fx = h.x + ((k / (n - 1)) * 2 - 1) * h.r * 0.8;
        const fy = surfaceAt(fx);
        const sx = wx2s(fx), sy = wy2s(fy);
        const flick = 0.75 + 0.25 * Math.sin(t * 11 + k * 1.7 + h.id);
        const fh = Math.max(6, h.r * 0.55 * cam.zoom) * flick;
        const fw = fh * 0.44;
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#ff6a3d';
        ctx.beginPath(); ctx.moveTo(sx, sy - fh); ctx.quadraticCurveTo(sx + fw, sy - fh * 0.4, sx, sy); ctx.quadraticCurveTo(sx - fw, sy - fh * 0.4, sx, sy - fh); ctx.fill();
        ctx.fillStyle = '#ffd23f';
        ctx.beginPath(); ctx.moveTo(sx, sy - fh * 0.55); ctx.quadraticCurveTo(sx + fw * 0.45, sy - fh * 0.2, sx, sy); ctx.quadraticCurveTo(sx - fw * 0.45, sy - fh * 0.2, sx, sy - fh * 0.55); ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else { // gas
      const sy = wy2s(h.y);
      const pulse = 1 + 0.06 * Math.sin(t * 2 + h.id);
      ctx.globalAlpha = 0.20;
      ctx.fillStyle = '#9dde4b';
      for (let k = 0; k < 4; k++) {
        const ox = ((k % 2) * 2 - 1) * h.r * 0.35 * (k < 2 ? 1 : 0.5);
        const oy = -h.r * (0.12 + 0.14 * k);
        ctx.beginPath();
        ctx.ellipse(wx2s(h.x + ox), sy + oy * cam.zoom * 8, h.r * 0.62 * cam.zoom * pulse, h.r * 0.4 * cam.zoom * pulse, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
}

// When a tank is off-screen, point to it from the screen edge.
function drawEdgeIndicators() {
  for (let i = 0; i < 2; i++) {
    const t = S.tanks[i];
    const sx = wx2s(t.x);
    if (sx >= -10 && sx <= view.cssW + 10) continue;
    const left = sx < 0;
    const ex = left ? 14 : view.cssW - 14;
    const ey = Math.min(view.cssH - 60, Math.max(70, wy2s(t.y - 300)));
    const c = i === 0 ? '#54c8ff' : '#ff6b6b';
    ctx.fillStyle = c;
    ctx.beginPath();
    if (left) { ctx.moveTo(ex - 8, ey); ctx.lineTo(ex + 8, ey - 8); ctx.lineTo(ex + 8, ey + 8); }
    else { ctx.moveTo(ex + 8, ey); ctx.lineTo(ex - 8, ey - 8); ctx.lineTo(ex - 8, ey + 8); }
    ctx.closePath(); ctx.fill();
    if (i !== S.you) {
      const dist = Math.abs(t.x - S.tanks[S.you].x);
      ctx.font = '800 14px system-ui, sans-serif';
      ctx.textAlign = left ? 'left' : 'right';
      ctx.fillText(`${(dist / 1000).toFixed(1)}k`, left ? ex + 14 : ex - 14, ey + 5);
      ctx.textAlign = 'left';
    }
  }
}

function tankScreen(i) {
  const t = S.tanks[i];
  // Render on the LOCAL surface so tanks visibly ride collapsing ground down
  // (matches the server's final y once the crumble settles).
  // Tank scales with the world zoom, clamped: never a speck when zoomed in,
  // and a slightly bigger floor so it stays readable when zoomed all the way out.
  const r = Math.max(8, Math.min(18, 240 * cam.zoom));
  return { sx: wx2s(t.x), sy: wy2s(surfaceAt(t.x)), r };
}

// Compact military AFV in the player's chosen paint. Damaged tanks blacken
// with scorch (plus smoke and flames from stepEffects).
function drawTank(i) {
  const { sx, sy, r } = tankScreen(i);
  const front = i === 0 ? 1 : -1;
  const sk = SKINS[S.skins[i]] || (i === 0 ? SKINS.olive : SKINS.desert);
  const P = { lite: sk.lite, mid: sk.mid, dark: sk.dark, accent: i === 0 ? '#54c8ff' : '#ff6b6b' };
  const steel = '#9aa1ad', steelDk = '#565d68';
  const hp = S.hp[i];

  if (S.playing && S.turn === i && !S.anim) {
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    const by = sy - r * 3.6 - 6 + Math.sin(performance.now() / 260) * 3;
    ctx.beginPath(); ctx.moveTo(sx, by + 9); ctx.lineTo(sx - 7, by); ctx.lineTo(sx + 7, by); ctx.closePath(); ctx.fill();
  }

  ctx.fillStyle = 'rgba(0,0,0,.32)';
  ctx.beginPath(); ctx.ellipse(sx, sy + r * 0.45, r * 1.5, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = '#15181f';
  roundedRect(sx - r * 1.35, sy - r * 0.1, r * 2.7, r * 0.62, r * 0.28); ctx.fill();
  ctx.fillStyle = '#05070c';
  for (let k = 0; k < 7; k++) {
    const wx = sx - r * 1.08 + (k / 6) * r * 2.16;
    ctx.beginPath(); ctx.arc(wx, sy + r * 0.28, r * 0.13, 0, Math.PI * 2); ctx.fill();
  }

  ctx.fillStyle = P.dark;
  ctx.beginPath();
  ctx.moveTo(sx - r * 1.32, sy - r * 0.08);
  ctx.lineTo(sx + r * 1.32, sy - r * 0.08);
  ctx.lineTo(sx + r * 1.22, sy + r * 0.16);
  ctx.lineTo(sx - r * 1.22, sy + r * 0.16);
  ctx.closePath(); ctx.fill();

  const hullPath = () => {
    ctx.beginPath();
    ctx.moveTo(sx - front * r * 1.35, sy - r * 0.08);
    ctx.lineTo(sx - front * r * 1.18, sy - r * 0.52);
    ctx.lineTo(sx + front * r * 0.95, sy - r * 0.52);
    ctx.lineTo(sx + front * r * 1.35, sy - r * 0.08);
    ctx.closePath();
  };
  const hg = ctx.createLinearGradient(0, sy - r * 0.78, 0, sy);
  hg.addColorStop(0, P.lite); hg.addColorStop(0.5, P.mid); hg.addColorStop(1, P.dark);
  ctx.fillStyle = hg; hullPath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = Math.max(1, r * 0.06);
  ctx.beginPath(); ctx.moveTo(sx - front * r * 1.18, sy - r * 0.52); ctx.lineTo(sx + front * r * 0.95, sy - r * 0.52); ctx.stroke();

  const tb = sy - r * 0.52;
  const tg = ctx.createLinearGradient(0, tb - r * 0.55, 0, tb);
  tg.addColorStop(0, P.lite); tg.addColorStop(1, P.dark);
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.moveTo(sx - front * r * 0.85, tb);
  ctx.lineTo(sx - front * r * 0.7, tb - r * 0.42);
  ctx.lineTo(sx + front * r * 0.28, tb - r * 0.42);
  ctx.lineTo(sx + front * r * 0.62, tb);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = P.dark;
  roundedRect(sx - front * r * 0.5 - r * 0.14, tb - r * 0.52, r * 0.28, r * 0.12, r * 0.05); ctx.fill();

  if (hp < 70) {
    ctx.fillStyle = `rgba(16,13,10,${Math.min(0.55, (70 - hp) / 110)})`;
    hullPath(); ctx.fill();
  }

  const antX = sx - front * r * 0.78, antTop = tb - r * 1.15;
  ctx.strokeStyle = 'rgba(220,228,240,.6)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(antX, tb - r * 0.4); ctx.lineTo(antX, antTop); ctx.stroke();
  ctx.fillStyle = P.accent;
  ctx.beginPath();
  ctx.moveTo(antX, antTop);
  ctx.lineTo(antX + front * r * 0.34, antTop + r * 0.11);
  ctx.lineTo(antX, antTop + r * 0.22);
  ctx.closePath(); ctx.fill();

  const aim = S.aim[i]; const dir = i === 0 ? 1 : -1;
  const rad = aim.angle * Math.PI / 180;
  const px = sx + front * r * 0.45, py = tb - r * 0.2;
  const cosA = Math.cos(rad) * dir, sinA = -Math.sin(rad);
  const bLen = r * 1.55;
  ctx.lineCap = 'round';
  ctx.strokeStyle = steelDk; ctx.lineWidth = Math.max(2.5, r * 0.24);
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + cosA * bLen, py + sinA * bLen); ctx.stroke();
  ctx.strokeStyle = steel; ctx.lineWidth = Math.max(1.5, r * 0.12);
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + cosA * bLen * 0.94, py + sinA * bLen * 0.94); ctx.stroke();
  ctx.strokeStyle = steelDk; ctx.lineWidth = Math.max(3, r * 0.3);
  ctx.beginPath();
  ctx.moveTo(px + cosA * bLen * 0.88, py + sinA * bLen * 0.88);
  ctx.lineTo(px + cosA * bLen, py + sinA * bLen);
  ctx.stroke();
}
function roundedRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Aim + charge visualisation — shown whenever you're in a match, so you can
// line up your next shot while the opponent takes theirs.
function drawAim() {
  if (!S.playing) return;
  const t = S.tanks[S.you]; const aim = myAim(); const dir = S.you === 0 ? 1 : -1;
  const rad = aim.angle * Math.PI / 180;
  const sx = wx2s(t.x), sy = wy2s(surfaceAt(t.x) - 24);
  const pct = aim.power / 100;

  const len = 30 + pct * 130;
  const ex = sx + Math.cos(rad) * dir * len, ey = sy - Math.sin(rad) * len;
  ctx.save();
  ctx.setLineDash([5, 6]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,210,63,.9)';
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,210,63,.95)';
  const ah = 7, aa = Math.atan2(-(ey - sy), (ex - sx));
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - Math.cos(aa - 0.4) * ah, ey + Math.sin(aa - 0.4) * ah);
  ctx.lineTo(ex - Math.cos(aa + 0.4) * ah, ey + Math.sin(aa + 0.4) * ah);
  ctx.closePath(); ctx.fill();

  const col = pct < 0.5 ? lerpColor([76, 232, 143], [255, 210, 63], pct / 0.5)
    : lerpColor([255, 210, 63], [255, 90, 82], (pct - 0.5) / 0.5);
  const ringR = 12;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,.14)';
  ctx.beginPath(); ctx.arc(sx, sy + 6, ringR, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = col; ctx.lineCap = 'round';
  const start = -Math.PI / 2;
  ctx.beginPath(); ctx.arc(sx, sy + 6, ringR, start, start + pct * Math.PI * 2); ctx.stroke();
  ctx.lineCap = 'butt';

  if (S.charging && S.pullPointer) {
    ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(S.pullPointer.sx, S.pullPointer.sy); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (S.charging) {
    ctx.fillStyle = col; ctx.font = '900 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(aim.power)}%`, sx, sy - 26);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}
function lerpColor(a, b, t) {
  t = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
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
    ctx.fillStyle = pr.beacon ? '#ff5a52' : '#fff2c0';
    ctx.beginPath(); ctx.arc(sx, sy, pr.beacon ? 5 : 4, 0, Math.PI * 2); ctx.fill();
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
    ctx.strokeStyle = rg.color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(wx2s(rg.x), wy2s(rg.y), Math.max(2, r * cam.zoom), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function drawParticles() {
  for (const p of S.particles) {
    const a = 1 - p.age / p.life;
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = p.color;
    if (p.shape === 'rect') {
      // square soil chunks — crisp pixel-art debris
      const s = Math.max(2, p.r * cam.zoom * 6 * (0.55 + a * 0.45));
      ctx.fillRect(Math.round(wx2s(p.x) - s / 2), Math.round(wy2s(p.y) - s / 2), Math.round(s), Math.round(s));
    } else {
      ctx.beginPath(); ctx.arc(wx2s(p.x), wy2s(p.y), Math.max(1, p.r * cam.zoom * (0.6 + a) * 6), 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
function drawFloaters() {
  for (const f of S.floaters) {
    const a = 1 - f.age / f.life;
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = f.color; ctx.font = '900 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(f.text, wx2s(f.x), wy2s(f.y));
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'left';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  $('nameInput').value = savedName();
  $('muteBtn').textContent = Audio.muted ? '🔇' : '🔊';
  buildSkinRow();
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) $('codeInput').value = room.toUpperCase();
  resize();
  snapCamera();
  connect();
  requestAnimationFrame(frame);
  // Deep-link join only if there's no match to resume.
  if (room && savedName() && !loadResume()) {
    setTimeout(() => intent({ type: 'join', code: room.toUpperCase(), name: savedName(), skin: mySkin() }), 300);
  }
}
boot();
