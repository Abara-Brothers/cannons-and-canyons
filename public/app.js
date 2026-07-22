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
  you: 0, n: 2, mode: 'duel',
  names: ['Player 1', 'Player 2'],
  skins: ['olive', 'desert'],
  facing: [1, -1], alive: [true, true],
  weapons: [], weaponById: {},
  terrain: null, minY: 0,
  trees: [],
  hazards: [],
  scorch: [],                          // permanent burn scars from fire: [{a,b}] world-x ranges
  biome: 'alpine', ruins: [],          // battlefield flavour (server-picked)
  boss: -1, scales: [],                // boss seat + per-tank scale (mech is 1.8x)
  golf: null,                          // Artillery Golf scorecard state
  props: [], crates: [], shield: [],   // barrels/bunkers, supply drops, crate shields
  chainQueue: [],                      // staggered prop chain explosions
  tanks: [{ x: 900, y: 9720 }, { x: 23100, y: 9720 }],
  hp: [150, 150], maxHp: 150, hpMax: [150, 150],
  ammo: {},
  turn: 0, fuel: 4500, moveBudget: 4500,
  selected: 'cannon',
  aim: [{ angle: 45, power: 60 }, { angle: 45, power: 60 }],   // persists between turns
  aimMin: -60, aimMax: 240,            // overwritten by the server snapshot (aimRange)
  code: null, quick: false,
  playing: false,
  anim: null, queue: [], pendingOver: null, terrainAnim: null,
  killcam: null,                       // final-blow slow-motion (see stepKillcam)
  deferred: [],                        // HP/elimination work held until the shell in flight lands
  warp: null,                          // active Teleport warp (see startWarp)
  mush: null,                          // active Tactical Nuke mushroom cloud (see startMushroom)
  particles: [], floaters: [], rings: [], flash: 0, shake: 0,
  muzzle: [],                          // directional HD muzzle blasts (own render pass)
  plane: null,                         // Air Strike delivery aircraft (cosmetic, own render pass)
  charging: false, pullPointer: null,
  userZoom: 1, panY: 0,
  recoil: [0, 0],                      // barrel kick when firing (1 → 0)
  lean: [0, 0], leanV: [0, 0], leanTarget: [0, 0], moveAt: [0, 0],  // drive lean + settle rock
};
const WW = () => S.world.w, WH = () => S.world.h;
const MOVE_MIN = 60;
// Seat identity: colour + fallback paint. Must stay in sync with --p0..--p3 in
// styles.css and SEAT_SKIN in server.js.
const SEAT_COLORS = ['#54c8ff', '#ff6b6b', '#ffd23f', '#b6ff5a'];
const seatColor = (i) => SEAT_COLORS[i % SEAT_COLORS.length];
const SEAT_SKIN = ['olive', 'desert', 'jungle', 'midnight'];
const facingOf = (i) => (S.facing && S.facing[i] === -1 ? -1 : 1);

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
  cannon: `<svg viewBox="0 0 24 24"><path d="M3.4 8.6h8.2l4.1 1.9a2.6 2.6 0 010 3l-4.1 1.9H3.4z" fill="#b8c2d2"/><path d="M3.4 8.6h8.2l3.4 1.6H3.4z" fill="#dde4ee"/><rect x="4.6" y="8.1" width="2.1" height="7.8" rx=".5" fill="#c98a4b"/><path d="M15.7 9.6l4.9 1.6a1 1 0 010 1.6l-4.9 1.6a2.6 2.6 0 000-4.8z" fill="#ff5a52"/><path d="M1.6 8.1h1.9v7.8H1.6z" fill="#7c8698"/></svg>`,
  mortar: `<svg viewBox="0 0 24 24"><path d="M12 1.6c2.5 3 3.9 5.6 3.9 8.6v6.3H8.1V10.2c0-3 1.4-5.6 3.9-8.6z" fill="#4d5a44"/><path d="M12 1.6c1.2 1.5 2.1 2.8 2.7 4.1l-1 1.8H8.9C9.7 5.5 10.7 3.7 12 1.6z" fill="#ffb02e"/><rect x="7.8" y="11.4" width="8.4" height="1.9" fill="#2f3a2b"/><path d="M9.2 16.5h5.6l1.9 5.9-2.5-1.7-2.2 1.9-2.2-1.9-2.5 1.7z" fill="#3a4436"/></svg>`,
  volley: `<svg viewBox="0 0 24 24"><path d="M4.6 3.6c1.3 1.3 2 2.7 2 4.3v6.4H2.6V7.9c0-1.6.7-3 2-4.3z" fill="#7c6cff"/><path d="M2.6 14.3h4L4.6 18z" fill="#4a3fb0"/><path d="M12 1.6c1.4 1.5 2.1 3 2.1 4.7v7.6h-4.2V6.3c0-1.7.7-3.2 2.1-4.7z" fill="#a99cff"/><path d="M9.9 13.9h4.2L12 18z" fill="#4a3fb0"/><path d="M19.4 3.6c1.3 1.3 2 2.7 2 4.3v6.4h-4V7.9c0-1.6.7-3 2-4.3z" fill="#7c6cff"/><path d="M17.4 14.3h4L19.4 18z" fill="#4a3fb0"/><g fill="#ffd23f" opacity=".9"><path d="M4.6 22l-1.3-3.2h2.6z"/><path d="M12 22.4l-1.5-3.6h3z"/><path d="M19.4 22l-1.3-3.2h2.6z"/></g></svg>`,
  railgun: `<svg viewBox="0 0 24 24"><rect x="1.4" y="6" width="12" height="2.4" rx="1.2" fill="#2f6b4e"/><rect x="1.4" y="15.6" width="12" height="2.4" rx="1.2" fill="#2f6b4e"/><g stroke="#3ce88f" stroke-width="1.6" stroke-linecap="round" opacity=".95" fill="none"><path d="M4 8.6v6.8"/><path d="M8.4 8.6v6.8"/><path d="M12.4 8.6v6.8"/></g><path d="M3.4 10.4h9.8l9.4 1.4a.2.2 0 010 .4l-9.4 1.4H3.4z" fill="#d6ffe9"/><path d="M3.4 10.4h4.2v3.2H3.4z" fill="#3ce88f"/></svg>`,
  cluster: `<svg viewBox="0 0 24 24"><path d="M12 1.3c1.7 1.7 2.6 3.3 2.6 4.9v.9H9.4v-.9c0-1.6.9-3.2 2.6-4.9z" fill="#e0e6f0"/><path d="M8.7 7.1h6.6v6.1H8.7z" fill="#ffd23f"/><path d="M8.7 7.1h6.6v1.5H8.7z" fill="#fff0a8"/><g fill="#b8890f"><rect x="10.6" y="7.1" width=".9" height="6.1"/><rect x="12.6" y="7.1" width=".9" height="6.1"/></g><path d="M8.7 13.2h6.6l-1 2-1.3-1.2-1.3 1.4-1.3-1.4-1.7 1.2z" fill="#8a6c14"/><g fill="#ff9d3d"><rect x="2.6" y="16.4" width="3.2" height="4.2" rx="1" transform="rotate(-20 4.2 18.5)"/><rect x="10.4" y="17.8" width="3.2" height="4.2" rx="1"/><rect x="18.2" y="16.4" width="3.2" height="4.2" rx="1" transform="rotate(20 19.8 18.5)"/></g><g stroke="#ffd23f" stroke-width="1" fill="none" opacity=".6"><path d="M10 15.4L5.2 16.6"/><path d="M12 15.6v1.9"/><path d="M14 15.4l4.8 1.2"/></g></svg>`,
  napalm: `<svg viewBox="0 0 24 24"><path d="M12 22c-4 0-7-2.6-7-6.5C5 10 9 8.5 9 4c2.5 1.5 3.6 4 3.2 6.2C14 9 15 7.5 15 5.5c3 2.3 4 5.5 4 8 0 5-3 8.5-7 8.5z" fill="#ff6a3d"/><path d="M12 22c-2 0-3.5-1.6-3.5-3.7 0-2.4 2-3.5 3.2-5.8 1.6 1.8 3.8 3.2 3.8 5.7S14 22 12 22z" fill="#ffd23f"/></svg>`,
  gas: `<svg viewBox="0 0 24 24"><g fill="#9dde4b"><circle cx="8" cy="10" r="4"/><circle cx="14" cy="8" r="4.6"/><circle cx="17" cy="12" r="3.4"/><circle cx="11" cy="12.5" r="4"/></g><g fill="#6fae2b"><circle cx="8" cy="18" r="1.2"/><circle cx="13" cy="19.5" r="1.4"/><circle cx="17" cy="17.5" r="1.1"/></g></svg>`,
  airstrike: `<svg viewBox="0 0 24 24"><path d="M1.4 6.9l7.6 1.2 3.1-3.4 1.9.5-1.2 3.4 6.4 1-.4-2.1 1.7.3.9 3.2-19.2 1.1z" fill="#54c8ff"/><g fill="#9fdcff"><path d="M6.6 14.2l-1.2 3.9-1.2-3.9z"/><path d="M12 15.6l-1.3 4.3-1.3-4.3z"/><path d="M17.4 14.2l-1.2 3.9-1.2-3.9z"/></g><path d="M2.6 21.8h18.8" stroke="#54c8ff" stroke-width="1.4" stroke-linecap="round" opacity=".55" fill="none"/></svg>`,
  buster: `<svg viewBox="0 0 24 24"><path d="M10.4 1.6h3.2v3.2h-3.2z" fill="#c98a4b"/><path d="M8.9 1.6h1.5v3.6L8 6.6zM15.1 1.6h-1.5v3.6L16 6.6z" fill="#7a5a30"/><rect x="10.2" y="4.6" width="3.6" height="6.2" fill="#c98a4b"/><rect x="10.2" y="4.6" width="1.3" height="6.2" fill="#e0a668"/><path d="M10.2 10.6h3.6L12 15.4z" fill="#8e969f"/><path d="M2.6 12.4h6.5l2.4 4.6-1.6 4.9H2.6z" fill="#6b5a34"/><path d="M21.4 12.4h-6.5l-2.4 4.6 1.6 4.9h7.3z" fill="#6b5a34"/><path d="M2.6 12.4h6.5l1 1.9H2.6zM21.4 12.4h-6.5l-1 1.9h7.5z" fill="#a6d878"/></svg>`,
  wall: `<svg viewBox="0 0 24 24"><path d="M1.4 20.4c1.9 0 3.1-2.6 4.6-5.6C7.9 10.9 9.6 6.6 12 6.6s4.1 4.3 6 8.2c1.5 3 2.7 5.6 4.6 5.6z" fill="#8a5a2b"/><path d="M1.4 20.4c1.9 0 3.1-2.6 4.6-5.6C7.9 10.9 9.6 6.6 12 6.6v13.8z" fill="#a06b35"/><path d="M12 6.6c-1.2 0-2.2 1.1-3.1 2.6h6.2C14.2 7.7 13.2 6.6 12 6.6z" fill="#6fb04a"/><g stroke="#6b451f" stroke-width=".9" stroke-linecap="round" fill="none" opacity=".65"><path d="M6.9 16.4h3.4"/><path d="M13.7 16.4h3.4"/><path d="M9.6 12.6h4.8"/></g><path d="M1.4 20.4h21.2v1.9H1.4z" fill="#5d3c1c"/></svg>`,
  golfball: `<svg viewBox="0 0 24 24"><circle cx="11" cy="10" r="6.2" fill="#f4f6f2"/><circle cx="11" cy="10" r="6.2" fill="none" stroke="#c9cfd8" stroke-width=".8"/><g fill="#c9cfd8"><circle cx="9" cy="8" r=".7"/><circle cx="12.4" cy="7.4" r=".7"/><circle cx="10.6" cy="11" r=".7"/><circle cx="13.6" cy="10.4" r=".7"/><circle cx="8.4" cy="10.8" r=".7"/></g><path d="M5 21h11" stroke="#3a7d2f" stroke-width="2.4" stroke-linecap="round"/><path d="M17.6 20.9V9.4l3.6 1.5-3.6 1.6" fill="#ff3b30" stroke="#e8ecf2" stroke-width=".9"/></svg>`,
  teleport: `<svg viewBox="0 0 24 24"><path d="M2.6 12l3.3-5.4L9.2 12l-3.3 5.4z" fill="none" stroke="#c86bff" stroke-width="1.7" stroke-linejoin="round" opacity=".8"/><path d="M14.8 12l3.3-5.4L21.4 12l-3.3 5.4z" fill="#c86bff"/><path d="M10.6 8.7L13.9 12l-3.3 3.3" fill="none" stroke="#6be7ff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20.6h16" stroke="#8a93a8" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  nuke: `<svg viewBox="0 0 24 24"><path d="M8.4 18.1L5.2 22.5h3.2zM15.6 18.1l3.2 4.4h-3.2z" fill="#2b323c"/><path d="M8.7 17.4h6.6l1.6 5.1H7.1z" fill="#3d4652"/><path d="M12 1.5c3.4 3.4 5.3 7.1 5.3 10.4 0 2.4-.8 4.4-1.9 5.9H8.6c-1.1-1.5-1.9-3.5-1.9-5.9C6.7 8.6 8.6 4.9 12 1.5z" fill="#aeb9c9"/><path d="M12 1.5C8.6 4.9 6.7 8.6 6.7 11.9c0 1.6.4 3.1 1 4.3V5.4z" fill="#d7e0ec"/><path d="M6.9 8.5h10.2v6.6H6.9z" fill="#26350f"/><g fill="#b6ff5a"><path d="M12 11.8l-1.6-3.1a3.6 3.6 0 013.2 0z"/><path d="M12 11.8l-1.6-3.1a3.6 3.6 0 013.2 0z" transform="rotate(120 12 11.8)"/><path d="M12 11.8l-1.6-3.1a3.6 3.6 0 013.2 0z" transform="rotate(240 12 11.8)"/><circle cx="12" cy="11.8" r=".9"/></g></svg>`,
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
  golfball: `<svg viewBox="0 0 24 14"><path d="M2 12 Q7 3 11 8 Q13 10.5 15 9.5 Q18 8 21 11.5" stroke="#aeb9d6" stroke-width="1.5" fill="none"/><circle cx="21.2" cy="11.6" r="1.6" fill="#f4f6f2"/></svg>`,
  teleport: `<svg viewBox="0 0 24 14"><path d="M3 12 Q11 0 18 9.5" stroke="#aeb9d6" stroke-width="1.6" fill="none"/><path d="M3 12l2.1-3 2.1 3-2.1 3z" fill="none" stroke="#c86bff" stroke-width="1.2" stroke-linejoin="round"/><path d="M18 9.5l2.1-3 2.1 3-2.1 3z" fill="#c86bff"/><path d="M9.4 3.4l2.2 2.2-2.2 2.2" fill="none" stroke="#6be7ff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
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
  warp() {
    const c = this.ensure(); if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(1800, t + 0.30);   // spin-up
    o.frequency.exponentialRampToValueAtTime(95, t + 0.75);     // fall away
    f.type = 'bandpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(2600, t + 0.34);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.28);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o.connect(f).connect(g).connect(c.destination); o.start(t); o.stop(t + 0.82);
    const s = c.createOscillator(), sg = c.createGain();   // hard snap on transit
    s.type = 'square';
    s.frequency.setValueAtTime(880, t + 0.30); s.frequency.exponentialRampToValueAtTime(180, t + 0.44);
    sg.gain.setValueAtTime(0.0001, t + 0.29); sg.gain.linearRampToValueAtTime(0.14, t + 0.31);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.50);
    s.connect(sg).connect(c.destination); s.start(t + 0.29); s.stop(t + 0.52);
  },
  // Air Strike delivery — a turbine drone that swells as the bomber runs in and
  // falls away behind it. `dur` is the aircraft's wall-clock life, in seconds.
  plane(dur) {
    const c = this.ensure(); if (!c) return;
    const t = c.currentTime, d = Math.max(1.2, Math.min(9, dur || 4));
    const n = c.createBufferSource();
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * d)), c.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    n.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(240, t);
    bp.frequency.linearRampToValueAtTime(760, t + d * 0.55);      // closing
    bp.frequency.linearRampToValueAtTime(190, t + d);             // and away
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.085, t + d * 0.35);
    ng.gain.setValueAtTime(0.085, t + d * 0.62);
    ng.gain.exponentialRampToValueAtTime(0.0005, t + d);
    n.connect(bp).connect(ng).connect(c.destination); n.start(t); n.stop(t + d);
    const o = c.createOscillator(), g = c.createGain();          // low turbine beat
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(74, t);
    o.frequency.linearRampToValueAtTime(96, t + d * 0.55);
    o.frequency.linearRampToValueAtTime(62, t + d);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 340;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + d * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0005, t + d);
    o.connect(lp).connect(g).connect(c.destination); o.start(t); o.stop(t + d);
  },
  // One bomb leaving the bay — a short descending whistle. Deliberately quiet:
  // five of these overlap during a stick.
  whistle() {
    const c = this.ensure(); if (!c) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1500, t + 0.05);
    o.frequency.exponentialRampToValueAtTime(420, t + 0.72);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.78);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.8);
  },
  // Time-stretch cue: a long descending filtered sweep + a sub thump, so the
  // slow-motion is audible even with the phone speaker at arm's length.
  killcam() {
    const c = this.ensure(); if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(520, t); o.frequency.exponentialRampToValueAtTime(58, t + 1.15);
    f.type = 'lowpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(2400, t); f.frequency.exponentialRampToValueAtTime(240, t + 1.10);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.13, t + 0.09);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.25);
    o.connect(f).connect(g).connect(c.destination); o.start(t); o.stop(t + 1.3);
    const s = c.createOscillator(), sg = c.createGain();
    s.type = 'sine'; s.frequency.setValueAtTime(150, t); s.frequency.exponentialRampToValueAtTime(42, t + 0.7);
    sg.gain.setValueAtTime(0.22, t); sg.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    s.connect(sg).connect(c.destination); s.start(t); s.stop(t + 0.85);
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
  // Size to the CANVAS's own box, not the stage — the canvas is inset from the
  // notch/speaker on iPhones (CSS safe-area), so this keeps the world un-squished.
  const dw = canvas.clientWidth || $('stage').clientWidth;
  const dh = canvas.clientHeight || $('stage').clientHeight;
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
  const framedY = focus.y - vh * 0.18;
  // On landscape, sit the tanks lower in the frame by default so you see more sky
  // (and less of the terrain wall). Then apply the user's vertical pan (S.panY).
  const skyBias = view.cssW > view.cssH ? vh * 0.13 : 0;
  // Survey framing centres on the mean height of everyone still fighting.
  let ysum = 0, ycnt = 0;
  for (let i = 0; i < S.n; i++) {
    if (S.alive[i] === false || !S.tanks[i]) continue;
    ysum += S.tanks[i].y; ycnt++;
  }
  const surveyY = (ycnt ? ysum / ycnt : focus.y) - skyBias;
  let ty = framedY + (surveyY - framedY) * surveyMix + (S.panY || 0);
  // KILLCAM is the ONE time the camera leaves your tank during a shot: blend the
  // whole target toward a tight frame on the impact point, then unwind on the way
  // out. Ignores S.userZoom on purpose — it must tighten even from a full survey.
  const K = S.killcam;
  if (K && K.mix > 0) {
    const kz = Math.min(0.30, Math.max(minMapZoom(), aimZoom() * KC.zoom));
    tz = tz + (kz - tz) * K.mix;
    tx = tx + (K.x - tx) * K.mix;
    ty = ty + ((K.y - (view.cssH / tz) * 0.08) - ty) * K.mix;
  }
  const cw = view.cssW / tz, ch = view.cssH / tz;
  tx = cw >= WW() ? WW() / 2 : Math.min(WW() - cw / 2, Math.max(cw / 2, tx));
  ty = ch >= WH() ? WH() - ch / 2 : Math.min(WH() - ch / 2, Math.max(ch / 2, ty));
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
// Pan the camera up/down (dir -1 = up/more sky). Hold to keep panning. Also works
// via two-finger vertical drag on the battlefield.
function holdPan(btn, dir) {
  let iv = null;
  const step = () => {
    const amt = (view.cssH / Math.max(cam.zoom, 1e-4)) * 0.05 * dir;
    S.panY = Math.max(-WH() * 0.7, Math.min(WH() * 0.7, (S.panY || 0) + amt));
  };
  const start = (e) => { e.preventDefault(); step(); iv = setInterval(step, 55); };
  const stop = () => { clearInterval(iv); iv = null; };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('pointercancel', stop);
}
holdPan($('panUp'), -1);
holdPan($('panDown'), 1);
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
    case 'lobby': renderLobby(m); break;
    case 'queued': showLobby('search'); break;
    case 'joinError': $('homeError').textContent = m.reason; break;
    case 'start': applySnapshot(m); saveResume(m.code, m.token); break;
    case 'hole':
      applySnapshot(m); saveResume(m.code, m.token);
      showToast(`⛳ Hole ${m.golf ? m.golf.hole : '?'} of 9 — Par ${m.golf ? m.golf.par : '?'}`);
      break;
    case 'restore':
      applySnapshot(m); saveResume(m.code, m.token);
      showToast('Reconnected — battle on!');
      break;
    case 'resumeError': clearResume(); break;
    case 'oppConn': {
      const who = S.names[m.seat] || 'Opponent';
      showToast(m.connected ? `${who} reconnected` : `${who} lost connection — holding their seat…`);
      break;
    }
    case 'turn': onTurn(m); break;
    case 'face': if (m.seat !== S.you) S.facing[m.seat] = m.dir; break;
    case 'crate':
      S.crates.push({ ...m.crate, dropT: 0 });   // parachute in from the sky
      showToast('📦 Supply drop incoming!');
      break;
    case 'crateTaken': {
      S.crates = S.crates.filter(c => c.id !== m.id);
      if (m.hp) S.hp = m.hp.slice();             // pickups can RAISE hp (repair) — trust the server here
      if (m.shield) S.shield = m.shield.slice();
      if (m.ammoSeat === S.you && m.ammo) { S.ammo = m.ammo; buildWeaponStrip(); }
      const t = S.tanks[m.seat];
      if (t) S.floaters.push({ x: t.x, y: t.y - 380, text: m.detail || m.kind.toUpperCase(), age: 0, life: 1.6, color: '#ffd23f' });
      updateHud();
      break;
    }
    case 'forfeit':
      deferHp(() => {
        if (m.hp) S.hp = m.hp.map((h, i) => Math.min(S.hp[i] ?? h, h));
        if (m.alive) S.alive = m.alive.slice();
        updateHud();
      });
      showToast(`${S.names[m.seat] || 'A player'} left — tank scuttled`);
      break;
    case 'aim': if (m.seat !== S.you) { S.aim[m.seat] = { angle: clampAimC(m.angle), power: Number(m.power) || 60 }; } break;
    case 'move': {
      const prev = S.tanks[m.seat] ? S.tanks[m.seat].x : m.x;
      S.tanks[m.seat] = { x: m.x, y: m.y };
      // Lean into the direction of travel; stopping springs it back with a rock.
      const d = Math.sign(m.x - prev);
      if (d) { S.leanTarget[m.seat] = d * 0.11; S.moveAt[m.seat] = performance.now(); }
      if (m.seat === S.you) { S.fuel = m.fuel; updateFuel(); }
      break;
    }
    case 'shot': enqueueShot(m); break;
    case 'dot': applyDot(m); break;
    case 'gameover':
      clearResume();
      if (S.anim || S.queue.length) S.pendingOver = m;
      else onGameOver(m);
      break;
    case 'opponentLeft':
      clearResume(); clearKillcam();
      S.playing = false; showOverlay('Opponent left', null, 'draw', true); break;
  }
}

// ---------------------------------------------------------------------------
// Home / lobby
// ---------------------------------------------------------------------------
// Callsigns. Nobody wants to fill in a form before they can play, so we hand out
// an artillery/canyon-flavoured name and let the player re-roll or type over it.
// The NOUN is drawn first and only adjectives that still fit are eligible, so a
// roll can never exceed the input's maxlength and be silently truncated.
// 37 × 41 words → 1454 valid pairs, all 9–14 chars.
const NAME_MAX = 14;                       // must match #nameInput maxlength
const CALL_ADJ = [
  'Iron', 'Steel', 'Brass', 'Copper', 'Cobalt', 'Rusty', 'Dusty', 'Ashen',
  'Flint', 'Basalt', 'Granite', 'Jagged', 'Hollow', 'Crimson', 'Amber',
  'Ember', 'Molten', 'Cinder', 'Gravel', 'Scorched', 'Reckless', 'Steady',
  'Silent', 'Sudden', 'Rapid', 'Blunt', 'Grim', 'Bold', 'Lucky', 'Rogue',
  'Feral', 'Salty', 'Storm', 'Frost', 'Dry', 'Mad', 'Sly',
];
const CALL_NOUN = [
  'Ridge', 'Mesa', 'Gulch', 'Butte', 'Bluff', 'Canyon', 'Crag', 'Spire',
  'Arroyo', 'Rim', 'Wash', 'Anvil', 'Cannon', 'Mortar', 'Howitzer', 'Gunner',
  'Shell', 'Salvo', 'Volley', 'Barrage', 'Fuse', 'Powder', 'Tracer', 'Turret',
  'Breech', 'Recoil', 'Piston', 'Hammer', 'Ranger', 'Rider', 'Scout',
  'Marshal', 'Coyote', 'Buzzard', 'Falcon', 'Hawk', 'Raven', 'Viper',
  'Bronco', 'Mule', 'Bandit',
];
function rollCallsign(prev) {
  for (let i = 0; i < 24; i++) {
    const n = CALL_NOUN[(Math.random() * CALL_NOUN.length) | 0];
    const fit = CALL_ADJ.filter(a => a.length + 1 + n.length <= NAME_MAX);
    if (!fit.length) continue;
    const name = fit[(Math.random() * fit.length) | 0] + ' ' + n;
    if (name !== prev) return name;        // a re-roll always visibly changes
  }
  return 'Iron Ridge';
}
function setCallsign(name) {
  $('nameInput').value = name;
  try { localStorage.setItem('pt_name', name); } catch {}
}
$('rerollBtn').onclick = () => {
  Audio.ensure();
  setCallsign(rollCallsign(($('nameInput').value || '').trim()));
};

function savedName() { return localStorage.getItem('pt_name') || ''; }
function myName() {
  const n = ($('nameInput').value || '').trim() || savedName() || rollCallsign(null);
  localStorage.setItem('pt_name', n);
  return n;
}

let ccMode = 'duel', ccMax = 4;
(function initMode() {
  const mr = $('modeRow'), cr = $('countRow');
  mr.addEventListener('click', (e) => {
    const b = e.target.closest('.mode'); if (!b) return;
    ccMode = b.dataset.mode;
    for (const el of mr.querySelectorAll('.mode')) el.classList.toggle('active', el === b);
    cr.classList.toggle('hidden', ccMode !== 'ffa');
  });
  cr.addEventListener('click', (e) => {
    const b = e.target.closest('.cnt'); if (!b) return;
    ccMax = +b.dataset.max;
    for (const el of cr.querySelectorAll('.cnt')) el.classList.toggle('active', el === b);
  });
})();
$('createBtn').onclick = () => {
  Audio.ensure(); $('homeError').textContent = '';
  intent({ type: 'create', name: myName(), skin: mySkin(), mode: ccMode, max: ccMode === 'ffa' ? ccMax : 2 });
};
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

// Orientation preference. This does NOT rotate anything — the browser owns that.
// It only records whether the player has accepted portrait; when they haven't,
// body lacks .portrait-ok and the CSS rotate prompt becomes eligible on the game
// screen. Landscape is the default because the whole HUD is tuned for it.
let ccOrient = localStorage.getItem('cc_orient') === 'portrait' ? 'portrait' : 'landscape';
function applyOrientPref() {
  document.body.classList.toggle('portrait-ok', ccOrient === 'portrait');
  for (const el of $('orientRow').querySelectorAll('.orient'))
    el.classList.toggle('active', el.dataset.orient === ccOrient);
}
function setOrient(v) {
  ccOrient = v === 'portrait' ? 'portrait' : 'landscape';
  try { localStorage.setItem('cc_orient', ccOrient); } catch {}
  applyOrientPref();
}
$('orientRow').addEventListener('click', (e) => {
  const b = e.target.closest('.orient'); if (!b) return;
  setOrient(b.dataset.orient);
});
// Landscape is ENFORCED in-match: the prompt has no dismiss. The only way to
// play upright is the Upright chip on the menu screen, so the prompt offers a
// (confirmed) exit back to the menu for anyone whose OS rotation-lock is on.
$('rhLeaveBtn').onclick = () => { $('confirmLeave').classList.remove('hidden'); };
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

function showScreen(name) {
  for (const s of ['home', 'lobby', 'game']) $(s).classList.toggle('active', s === name);
  // body.in-game drives two pure-CSS behaviours: the animated canyon backdrop is
  // display:none'd in-match (so #hud-top / #dock backdrop-filter blurs nothing,
  // exactly as before, and the GPU idles), and the rotate prompt is only ever
  // eligible on the game screen — the menus are fine in portrait.
  document.body.classList.toggle('in-game', name === 'game');
}
function showLobby(mode) {
  const searching = mode === 'search';
  $('lobbyHeading').textContent = searching ? 'Searching for an opponent…' : 'Waiting for your opponent…';
  $('lobbyHint').textContent = searching ? "We'll drop you into a battle the moment someone else is looking too." : 'Send this link or code. The battle starts the moment they join.';
  $('lobbyCode').style.display = searching ? 'none' : '';
  $('copyLinkBtn').style.display = searching ? 'none' : '';
  $('copyCodeBtn').style.display = searching ? 'none' : '';
  if (searching) { $('roster').innerHTML = ''; $('startMatchBtn').classList.add('hidden'); }
  showScreen('lobby');
}

// FFA lobby: live roster + host-only "Start battle". A duel still auto-starts the
// moment the second player joins, so this mostly matters for free-for-all.
function renderLobby(m) {
  S.code = m.code; $('lobbyCode').textContent = m.code;
  const isHost = m.you === m.host;
  const filled = m.players.filter(Boolean).length;
  $('lobbyHeading').textContent =
    m.mode === 'ffa'  ? `Free-for-all — ${filled}/${m.max} commanders` :
    m.mode === 'boss' ? `Boss Raid — ${filled}/${m.max} vs WARLORD-7` :
    m.mode === 'golf' ? `Artillery Golf — ${filled}/${m.max} on the tee` :
    'Waiting for your opponent…';
  $('lobbyHint').textContent = m.mode === 'ffa'
    ? (isHost ? "Send the link. Start whenever you have enough players — you don't have to wait for a full lobby."
              : 'Waiting for the host to start the battle…')
    : 'Send this link or code. The battle starts the moment they join.';
  const r = $('roster'); r.innerHTML = '';
  for (let i = 0; i < m.max; i++) {
    const p = m.players[i];
    const el = document.createElement('div');
    el.className = 'rp' + (p ? '' : ' empty');
    el.style.setProperty('--seat', seatColor(i));
    if (p) {
      const tag = (i === m.host ? 'HOST' : '') + (i === m.you ? (i === m.host ? ' · YOU' : 'YOU') : '');
      el.innerHTML = '<span class="dot"></span><span class="rn"></span><span class="tag"></span>';
      el.querySelector('.rn').textContent = p.name;
      el.querySelector('.tag').textContent = tag;
    } else {
      el.innerHTML = '<span class="dot"></span><span>Open slot</span>';
    }
    r.appendChild(el);
  }
  const btn = $('startMatchBtn');
  const hostStarts = m.mode === 'ffa' || m.mode === 'boss' || m.mode === 'golf';
  const minSeats = (m.mode === 'boss' || m.mode === 'golf') ? 1 : 2;
  btn.classList.toggle('hidden', !(isHost && hostStarts));
  btn.disabled = filled < minSeats;
  btn.textContent = filled < minSeats ? `Start (need ${minSeats})`
    : m.mode === 'boss' ? `Engage the WARLORD (${filled})`
    : m.mode === 'golf' ? `Tee off (${filled})`
    : `Start battle (${filled})`;
  showScreen('lobby');
}
$('startMatchBtn').onclick = () => sendMsg({ type: 'startMatch' });

// ---------------------------------------------------------------------------
// Game setup (also used to restore a resumed match)
// ---------------------------------------------------------------------------
function applySnapshot(m) {
  S.world = m.world || S.world;
  S.lavaY = m.lavaY ?? (S.world.h - 300);
  S.you = m.you; S.names = m.names; S.weapons = m.weapons;
  S.n = m.n || (m.names ? m.names.length : 2);
  S.mode = m.mode || 'duel';
  S.skins = m.skins || S.skins;
  S.facing = (m.facing || []).slice();
  while (S.facing.length < S.n) S.facing.push(S.facing.length < S.n / 2 ? 1 : -1);
  S.alive = (m.alive || new Array(S.n).fill(true)).slice();
  S.weaponById = Object.fromEntries(m.weapons.map(w => [w.id, w]));
  S.terrain = m.terrain.slice();
  S.trees = (m.trees || []).map(t => ({ ...t }));
  S.hazards = m.hazards || [];
  S.scorch = m.scorch || [];
  S.biome = m.biome || 'alpine';
  setBiomeTheme(S.biome);
  S.boss = (m.boss != null) ? m.boss : -1;
  S.scales = (m.scales || []).slice();
  S.golf = m.golf || null;
  document.body.classList.toggle('golf', S.mode === 'golf');
  if (S.mode === 'golf') S.selected = 'golfball';
  S.ruins = m.ruins || [];
  S.props = m.props || [];
  S.crates = (m.crates || []).map(c => ({ ...c, dropT: 1 }));   // already landed on resume
  S.shield = (m.shield || []).slice();
  S.tanks = m.tanks.map(t => ({ x: t.x, y: t.y }));
  S.hp = (m.hp || new Array(S.n).fill(150)).slice(); S.maxHp = m.maxHp || 150;
  S.hpMax = (m.hpMax || new Array(S.n).fill(S.maxHp)).slice();
  S.ammo = m.ammo; S.moveBudget = m.moveBudget;
  if (Array.isArray(m.aimRange) && m.aimRange.length === 2) { S.aimMin = m.aimRange[0]; S.aimMax = m.aimRange[1]; }
  S.turn = m.turn; S.fuel = m.fuel ?? m.moveBudget;
  S.code = m.code || S.code;
  S.aim = Array.from({ length: S.n }, () => ({ angle: 45, power: 60 }));
  S.recoil = new Array(S.n).fill(0);
  S.lean = new Array(S.n).fill(0); S.leanV = new Array(S.n).fill(0);
  S.leanTarget = new Array(S.n).fill(0); S.moveAt = new Array(S.n).fill(0);
  S.selected = firstAvailableWeapon();
  S.playing = true; S.quick = false; S.anim = null; S.queue = []; S.pendingOver = null; S.warp = null;
  clearKillcam();
  S.deferred = [];                     // start/restore hp+alive win outright — discard held work
  S.particles = []; S.floaters = []; S.rings = []; S.muzzle = []; S.flash = 0; S.shake = 0;
  S.plane = null;
  S.mush = null;                       // a nuke cloud must never survive into the next match
  S.chainQueue = [];
  S.recoil = [0, 0];
  S.charging = false; S.pullPointer = null; S.userZoom = 1; S.panY = 0;
  computeMinY();
  $('overlay').classList.add('hidden');
  showScreen('game');
  resize();
  snapCamera();
  buildWeaponStrip();
  buildScoreboard();
  updateHud(); updateAimUI(); updateFuel(); updateDock();
}

function onTurn(m) {
  S.turn = m.turn; S.fuel = m.fuel;
  // 'turn' arrives ~300ms after the server resolved the shot, long before the
  // client finishes replaying the flight. In FFA these flags carry the kill —
  // applied here they grey the scoreboard card AND delete the tank from the
  // canvas (the draw loop skips S.alive[i] === false) while the shell is still
  // in the air. Elimination belongs to the blast; hold it behind the same gate.
  if (m.alive) deferHp(() => { S.alive = m.alive.slice(); updateHud(); });
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
// Build one scoreboard card per seat. Called on every snapshot, since n can change
// between matches (duel -> FFA rematch).
function buildScoreboard() {
  const row = $('scoreRow');
  row.className = 'score-row n' + S.n;
  row.style.setProperty('--n', S.n);
  row.innerHTML = '';
  for (let i = 0; i < S.n; i++) {
    const el = document.createElement('div');
    el.className = 'pscore';
    el.id = 'p' + i;
    el.style.setProperty('--seat', seatColor(i));
    el.innerHTML =
      '<div class="pname"></div>' +
      '<div class="pval"><span class="score">100</span><span class="shots">HP</span></div>' +
      '<div class="hpbar"><i></i></div>';
    el.querySelector('.pname').textContent =
      (i === S.boss ? '👑 ' : '') + (S.names[i] || `Player ${i + 1}`) + (i === S.you ? ' (you)' : '');
    if (i === S.boss) el.classList.add('bossrow');
    row.appendChild(el);
  }
}

function updateHud() {
  for (let i = 0; i < S.n; i++) {
    const el = $('p' + i); if (!el) continue;
    const hp = Math.max(0, Math.round(S.hp[i] ?? 0));
    const dead = S.alive[i] === false || hp <= 0;
    el.classList.toggle('dead', dead);
    el.classList.toggle('acting', !!S.playing && S.turn === i && !dead);
    if (S.golf) {                          // golf cards show STROKES, not health
      const done = S.golf.done && S.golf.done[i];
      el.querySelector('.score').textContent = `${(S.golf.strokes && S.golf.strokes[i]) || 0}`;
      el.querySelector('.shots').textContent = done ? '⛳ IN' : `STR · tot ${(S.golf.totals && S.golf.totals[i]) || 0}`;
      el.querySelector('.hpbar').style.display = 'none';
      el.classList.toggle('acting', !!S.playing && S.turn === i);
      el.classList.remove('dead');
      continue;
    }
    el.querySelector('.hpbar').style.display = '';
    el.querySelector('.score').textContent = dead ? '\u2620' : hp;
    el.querySelector('.shots').textContent = 'HP';
    const bar = el.querySelector('.hpbar i');
    const cap = (S.hpMax && S.hpMax[i]) || S.maxHp;
    const pct = Math.max(0, Math.min(1, hp / cap));
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
  $('turnLabel').textContent = S.golf
    ? `⛳ Hole ${S.golf.hole}/9 · Par ${S.golf.par}` + (active ? ' — your shot' : (S.playing ? ` — ${S.names[S.turn]}` : ''))
    : active ? 'YOUR TURN' : (S.playing ? `${S.names[S.turn]}'s turn — line up your shot` : '');
  $('fireBtn').disabled = !active;
  $('moveLeft').disabled = !active || S.fuel < MOVE_MIN;
  $('moveRight').disabled = !active || S.fuel < MOVE_MIN;
}

function buildWeaponStrip() {
  const strip = $('weaponStrip'); strip.innerHTML = '';
  for (const w of S.weapons) {
    const left = S.ammo[w.id] ?? w.ammo;
    const chip = document.createElement('button');
    chip.dataset.wid = w.id;
    chip.className = 'wchip' + (w.id === S.selected ? ' sel' : '') + (left <= 0 ? ' empty' : '');
    const ammoTxt = w.ammo >= 99 ? '∞' : `×${left}`;
    chip.innerHTML = `<span class="wrow"><span class="wi">${ICONS[w.id] || ''}</span><span class="wt">${TRAJ[w.id] || ''}</span></span><span class="wn">${w.name}</span><span class="wa">${ammoTxt}</span>`;
    chip.title = w.desc;
    chip.onclick = () => {
      if (left > 0 && canAim()) { S.selected = w.id; buildWeaponStrip(); flashWeaponName(w.id); }
    };
    strip.appendChild(chip);
  }
}

// Briefly show the weapon's name above the chip that was just selected.
// buildWeaponStrip() rebuilds every chip, so this MUST run after the rebuild and
// read the fresh node's viewport rect (innerHTML='' also resets the strip's
// scrollLeft, so a stale rect would point at the wrong place). The popup is a
// fixed-position sibling of the dock — the strip would clip it.
let wpopTimer = null;
function flashWeaponName(id) {
  const pop = $('weaponPop');
  const chip = $('weaponStrip').querySelector(`.wchip[data-wid="${id}"]`);
  const w = S.weaponById[id];
  if (!pop || !chip || !w) return;

  pop.textContent = w.name;
  clearTimeout(wpopTimer);
  pop.classList.remove('show');
  void pop.offsetWidth;              // force reflow so the animation replays on re-tap

  const r = chip.getBoundingClientRect();
  const half = pop.offsetWidth / 2;  // measured while visibility:hidden — still laid out
  const pad = 8;
  const cx = Math.max(pad + half, Math.min(window.innerWidth - pad - half, r.left + r.width / 2));
  pop.style.left = Math.round(cx) + 'px';
  pop.style.top = Math.round(r.top - 6) + 'px';   // translate(-50%,-100%) lifts it clear
  pop.classList.add('show');
  wpopTimer = setTimeout(() => pop.classList.remove('show'), 1250);
}

function hideWeaponName() {
  const pop = $('weaponPop');
  if (!pop) return;
  clearTimeout(wpopTimer);
  pop.classList.remove('show');
}
// A stale fixed position after a rotate/resize would float in mid-air — just drop it.
window.addEventListener('resize', hideWeaponName);
window.addEventListener('orientationchange', hideWeaponName);

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
// Mirror of clampAim() in game-core.js. UX only — the server re-clamps every
// shot in simulateShot(), so a drift here can never desync the physics.
function clampAimC(a) {
  a = Number(a);
  if (!Number.isFinite(a)) return 45;
  a = (((a + 180) % 360) + 360) % 360 - 180;
  if (a < S.aimMin) a += 360;
  if (a >= 270) return S.aimMin;
  return Math.max(S.aimMin, Math.min(S.aimMax, a));
}
function setAim(angle, power) {
  const a = myAim();
  a.angle = clampAimC(angle);
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
  // 300° of travel at 1°/110ms would be a 33-second sweep — ramp up while held.
  const start = (e) => {
    e.preventDefault(); step(); let held = 0;
    iv = setInterval(() => { held++; const n = held > 24 ? 5 : held > 10 ? 2 : 1; for (let k = 0; k < n; k++) step(); }, 110);
  };
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
  const dir = facingOf(S.you);
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
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: S.userZoom, cy: (a.y + b.y) / 2, panY: S.panY || 0 };
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
    // Two-finger vertical drag pans the camera up/down (see more sky / terrain).
    const dcy = (a.y + b.y) / 2 - pinchStart.cy;
    if (cam.zoom > 0) S.panY = Math.max(-WH() * 0.7, Math.min(WH() * 0.7, pinchStart.panY - dcy / cam.zoom));
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
// No turret-flip control by design. Your hull facing is fixed for the match
// (server state, room.facing); the 300° aim range covers backwards on its own —
// drag past the far side of your tank, or step the ANGLE readout past 90°.

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
// ---------------------------------------------------------------------------
// HP gate. The server resolves a shot instantly and then sends 'turn' 300ms and
// 'dot' 1300ms later on a wall clock — but the client is still replaying the
// flight (playback runs ~3.8x real time; napalm/airstrike take 1s+). Anything
// that lowers a health bar, prints a damage floater or marks a tank destroyed
// must land ON the blast, so it is held here while a shot is in the air and
// flushed the instant that shot detonates.
// ---------------------------------------------------------------------------
function deferHp(fn) {
  if (S.anim && !S.anim.resolved) { S.deferred.push(fn); return; }
  fn();
}
function flushDeferred() {
  if (!S.deferred.length) return;
  const q = S.deferred; S.deferred = [];
  for (const fn of q) fn();
}

function enqueueShot(m) { S.queue.push(m); if (!S.anim) startNextShot(); }

// ---------------------------------------------------------------------------
// KILLCAM. The server flags the fatal shot (`m.killcam`); the last stretch of
// that projectile's flight plays in slow motion, the camera tightens onto the
// impact, letterbox bars close in, and only when the bars retract does the
// game-over overlay get released. Both players receive the same flag, so both
// watch the same killcam — it is broadcast state, not a local guess.
// The time scale multiplies the BATTLEFIELD dt only; the bars, the camera ease
// and the phase machine all run on real dt so they can never stall.
// ---------------------------------------------------------------------------
const KC = {
  lead: 46,     // path samples of run-in before impact (~1.5s real once ramped)
  min: 0.15,    // slowest time scale
  in: 0.30,     // bars slide in            (real seconds)
  hold: 2.30,   // crawl over the detonation (real seconds) — savour the kill
  out: 0.65,    // bars retract + time ramps back to 1 (real seconds)
  zoom: 2.6,    // camera tightening vs the aim baseline
};

function startKillcam(kc) {
  if (!kc || S.killcam) return;
  S.killcam = { seat: kc.seat, pi: kc.proj, x: kc.x, y: kc.y, phase: 'idle', t: 0, pt: 0, mix: 0 };
}
function clearKillcam() {
  S.killcam = null;
  const g = $('game'); if (g) g.classList.remove('killcam');
}

// Battlefield time scale. 1 everywhere except inside a killcam.
function killcamScale() {
  const K = S.killcam; if (!K) return 1;
  if (K.phase === 'idle' || K.phase === 'done') return 1;
  if (K.phase === 'hold') return KC.min;
  if (K.phase === 'out') return KC.min + (1 - KC.min) * easeOut3(K.pt / KC.out);
  const A = S.anim, pr = A && A.projectiles[K.pi];
  if (!pr) return KC.min;
  const lead = Math.min(KC.lead, Math.max(6, pr.path.length - 1));
  const togo = (pr.path.length - 1) - (A.elapsed - pr.delay);   // samples left to impact
  const f = clamp01(togo / lead);                                // 1 far → 0 at impact
  return KC.min + (1 - KC.min) * f * f;                          // ease 1.00 → 0.15
}

// Real-time phase machine + bar/camera mix. Called with UNSCALED dt.
function stepKillcam(dt) {
  const K = S.killcam; if (!K || K.phase === 'done') return;
  const A = S.anim;
  if (K.phase === 'idle') {
    const pr = A && A.projectiles[K.pi];
    if (!pr) return;
    const lead = Math.min(KC.lead, Math.max(6, pr.path.length - 1));
    if ((pr.path.length - 1) - (A.elapsed - pr.delay) > lead && !pr.done) return;
    K.phase = 'run'; K.t = 0;
    $('game').classList.add('killcam');
    S.flash = Math.min(0.5, S.flash + 0.18);       // a beat of white as time bends
    Audio.killcam();
    if (navigator.vibrate) navigator.vibrate([12, 60, 12]);
  }
  K.t += dt;
  if (K.phase === 'run') {
    K.mix = easeOut3(K.t / KC.in);
    const pr = A && A.projectiles[K.pi];
    if (!A || !pr || pr.exploded || pr.done) { K.phase = 'hold'; K.pt = 0; }
  } else if (K.phase === 'hold') {
    K.mix = 1; K.pt += dt;
    const settled = !S.anim || S.anim.projectiles.every(p => p.done);
    if (K.pt >= KC.hold && (settled || K.pt > KC.hold + 2)) { K.phase = 'out'; K.pt = 0; }
  } else if (K.phase === 'out') {
    K.pt += dt;
    K.mix = 1 - easeOut3(K.pt / KC.out);
    if (K.pt >= KC.out) {
      K.phase = 'done'; K.mix = 0;
      $('game').classList.remove('killcam');
      // No shot animation left to hand off through startNextShot (DoT/edge cases):
      // release the overlay here instead. The shell path releases in startNextShot.
      if (!S.anim && !S.queue.length && S.pendingOver) {
        const o = S.pendingOver; S.pendingOver = null; onGameOver(o);
      }
    }
  }
}

function startNextShot() {
  const m = S.queue.shift();
  if (!m) {
    flushDeferred();          // nothing left in the air — never strand held HP
    updateDock();
    if (S.pendingOver) { const o = S.pendingOver; S.pendingOver = null; onGameOver(o); }
    return;
  }
  S.plane = null;             // any previous delivery run is over
  // `from` is the path index a projectile becomes VISIBLE at. 0 for everything
  // except Air Strike bombs, whose long fall starts far above the frame.
  const projectiles = m.projectiles.map(p => ({ path: p.path, det: p.det, delay: p.delay || 0, from: 0, beacon: !!p.beacon, pos: 0, done: false, exploded: false, trail: [] }));
  // Which impact owns the damage. `hp`, `damage`, `terrainDiff` and `tanks` are
  // ONE aggregate for the whole salvo (game-core sums every sub-blast into
  // damageDealt and settles the terrain once), so there is no per-bomblet split
  // on the wire and the client must never invent one. The payload therefore
  // lands on the LAST projectile that actually detonates — a shell that flew off
  // the map owns nothing.
  let lastDet = -1, lastEnd = -Infinity;
  for (let i = 0; i < projectiles.length; i++) {
    const pr = projectiles[i];
    if (!pr.det) continue;
    const end = pr.delay + Math.max(0, pr.path.length - 1);
    if (end >= lastEnd) { lastEnd = end; lastDet = i; }
  }
  S.anim = { m, elapsed: 0, projectiles, lastDet, settleTimer: 0, resolved: false, strike: null };
  armAirstrike(S.anim, m);    // slow-motion window + the delivery aircraft
  muzzleBlast(m.by);          // barrel recoil + flash out of the cannon
  Audio.fire();
  // Server-flagged final blow. Armed now, but it stays dormant (phase 'idle',
  // scale 1) until the shell is KC.lead samples from impact.
  if (m.killcam && m.projectiles[m.killcam.proj]) startKillcam(m.killcam);
  updateDock();
}

// One path point = 1/30 s of simulated flight (game-core: DT 1/120, SAMPLE_EVERY 4),
// so 115 points/s replays the world at ~3.8x real time.
const PLAYBACK = 115;      // path points per second — normal shots
const STRIKE_RATE = 42;    // ...during an Air Strike bomb run (~1.4x real time)
const STRIKE_RAMP = 16;    // points over which playback eases down into it

// Playback speed for THIS frame. Only the Air Strike bends it: the beacon shell
// arcs at full speed, then the shot tucks into slow motion as the beacon lands so
// the bomber and the falling stick are actually readable. Everything keyed off
// A.elapsed (delays, projectile positions) stays consistent automatically.
function playbackRate(A) {
  const st = A.strike; if (!st) return PLAYBACK;
  const k = clamp01((A.elapsed - (st.slowAt - STRIKE_RAMP)) / STRIKE_RAMP);
  return PLAYBACK + (STRIKE_RATE - PLAYBACK) * (k * k * (3 - 2 * k));   // smoothstep
}

function advanceAnim(dt) {
  const A = S.anim; if (!A) return;
  A.elapsed += playbackRate(A) * dt;
  let allDone = true, resolveNow = false;
  for (let i = 0; i < A.projectiles.length; i++) {
    const pr = A.projectiles[i];
    if (pr.done) continue;
    const local = A.elapsed - pr.delay;
    if (local < pr.from) { allDone = false; continue; }
    if (local >= pr.path.length - 1) {
      pr.pos = pr.path.length - 1; pr.done = true;
      if (pr.det && !pr.exploded) {
        detonate(pr.det); pr.exploded = true;
        if (i === A.lastDet) resolveNow = true;
      }
    } else { pr.pos = local; allDone = false; }
  }
  // Damage lands ON the last blast, not on a timer. Run it after the loop so
  // every detonation in this frame still reads the pre-collapse terrain, then
  // release anything ('dot' / 'turn' / 'forfeit') that arrived mid-flight.
  if (resolveNow && !A.resolved) { applyResolve(A.m); A.resolved = true; flushDeferred(); }
  if (allDone) {
    A.settleTimer += dt;
    // Fallback: a shot where NOTHING detonated (every shell left the map) still
    // has to apply its payload, and held HP must never be stranded. During a
    // killcam, resolve on the impact frame so the kill registers DURING the slow
    // motion — settleTimer runs on scaled dt and would otherwise crawl.
    if (!A.resolved && (S.killcam || A.settleTimer > 0.22)) { applyResolve(A.m); A.resolved = true; flushDeferred(); }
    if (S.killcam && S.killcam.phase !== 'done') return;   // the killcam holds the frame
    if (A.settleTimer > 0.6) { S.anim = null; startNextShot(); }
  }
}

function detonate(det) {
  // Teleport: no blast at all — the whole event IS the warp. Handled first so a
  // teleport det never falls into the round-particle burst-puff branch below.
  if (det.tp) { startWarp(det.tp); return; }
  if (det.kind === 'none' && det.r < 30 && !det.hz) { // burst puff / beacon flare
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 200;
      S.particles.push({ x: det.x, y: det.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0.4, age: 0, r: 2.2, shape: 'spark', color: det.color });
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
  // Tactical Nuke: the blast also raises a mushroom cloud. It runs on its OWN
  // clock in S.mush, so it long outlives this shot's animation without holding
  // up the turn handover (nothing in myTurn()/advanceAnim reads S.mush).
  if (isNukeDet(det)) startMushroom(det);
  // fireball flash particles (weapon-coloured)
  const base = det.hz === 'gas' ? '#9dde4b' : det.kind === 'dirt' || det.kind === 'wall' ? '#8a5a2b' : det.color;
  const n = Math.round(8 + det.r / 60);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = (0.4 + Math.random()) * det.r * 3.0;
    // Fireball: a few soft discs for mass (back layer) plus bright sparks in front.
    const spark = i % 2 === 0;
    S.particles.push({
      x: det.x, y: det.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - det.r * 1.1,
      life: 0.5 + Math.random() * 0.5, age: 0,
      r: spark ? 2 + Math.random() * 2.4 : 9 + Math.random() * (det.r / 22),
      shape: spark ? 'spark' : undefined,
      color: base,
    });
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
  // Apply elimination HERE, in animation order — never from an out-of-band message,
  // or the scoreboard shows a kill while the shell is still in the air.
  if (m.alive) {
    for (let i = 0; i < m.alive.length; i++) {
      if (m.alive[i] === false && S.alive[i] !== false) {
        S.alive[i] = false;
        showToast(`${S.names[i]} destroyed!`);
      }
    }
  }
  S.hazards = m.hazards || [];
  if (m.scorch) S.scorch = m.scorch;
  if (m.props) S.props = m.props;
  if (m.shield) S.shield = m.shield.slice();
  if (m.shieldPop) for (let i = 0; i < m.shieldPop.length; i++) {
    if (m.shieldPop[i] && S.tanks[i]) S.floaters.push({ x: S.tanks[i].x, y: S.tanks[i].y - 430, text: 'SHIELD DOWN', age: 0, life: 1.4, color: '#54c8ff' });
  }
  // Chain-detonating props: play each explosion as its own staggered blast.
  if (m.propEvents && m.propEvents.length) {
    for (let k = 0; k < m.propEvents.length; k++) {
      const ev = m.propEvents[k];
      S.chainQueue.push({
        at: performance.now() + 130 * (k + 1),
        det: { x: ev.x, y: ev.y - 60, r: ev.kind === 'barrel' ? 640 : 520, kind: 'crater', color: ev.kind === 'barrel' ? '#ff8a3d' : '#aeb9c9', hz: null },
      });
    }
  }
  if (m.ammoSeat === S.you && m.ammo) S.ammo = m.ammo;
  if (m.golf) {
    S.golf = { ...(S.golf || {}), ...m.golf };
    const t = S.tanks[m.golf.noteSeat];
    const NOTES = { holed: '⛳ SUNK IT!', hazard: 'HAZARD +1', oob: 'OUT OF BOUNDS +1', capped: 'PICKED UP' };
    if (m.golf.note && t) S.floaters.push({ x: t.x, y: t.y - 420, text: NOTES[m.golf.note] || '', age: 0, life: 1.8, color: m.golf.note === 'holed' ? '#b6ff5a' : '#ffd23f' });
  }
  updateHud(); buildWeaponStrip();
  for (let i = 0; i < S.n; i++) {
    const blast = (m.damage && m.damage[i]) || 0;
    const dot = (m.hazardDamage && m.hazardDamage[i]) || 0;
    if (blast > 0) S.floaters.push({ x: S.tanks[i].x, y: S.tanks[i].y - 160, text: `-${blast}`, age: 0, life: 1.3, color: '#ff6b6b' });
    if (dot > 0) S.floaters.push({ x: S.tanks[i].x, y: S.tanks[i].y - 320, text: `-${dot}`, age: 0, life: 1.3, color: '#ff8a3d' });
  }
}

// A tick of the real-time fire/toxic burn (server 'dot' message). The first tick
// is broadcast 1.3s after the shot resolved — often while the client is still
// replaying it — and its `hp` already includes the BLAST damage, so applying it
// on arrival is what makes the bar drop before impact. Gate it.
function applyDot(m) { deferHp(() => applyDotNow(m)); }
function applyDotNow(m) {
  // Fire ticks carry the live hazard list so a blaze that has burned out (6s)
  // vanishes here instead of lingering until the next shot lands.
  if (m.hazards) S.hazards = m.hazards;
  if (m.hp) S.hp = m.hp.map((h, i) => Math.min(S.hp[i], h));
  if (m.alive) {
    for (let i = 0; i < m.alive.length; i++) {
      if (m.alive[i] === false && S.alive[i] !== false) {
        S.alive[i] = false;
        showToast(`${S.names[i]} destroyed!`);
      }
    }
  }
  updateHud();
  for (let i = 0; i < S.n; i++) {
    const d = (m.damage && m.damage[i]) || 0;
    if (d <= 0) continue;
    S.floaters.push({ x: S.tanks[i].x, y: S.tanks[i].y - 200, text: `-${d}`, age: 0, life: 1.1, color: '#ff8a3d' });
    for (let k = 0; k < 7; k++) {   // sparks, not blobs — the tank stays visible while it cooks
      S.particles.push({
        x: S.tanks[i].x + (Math.random() - 0.5) * 70, y: S.tanks[i].y - 10,
        vx: (Math.random() - 0.5) * 50, vy: -120 - Math.random() * 120,
        life: 0.5 + Math.random() * 0.4, age: 0, r: 1.8 + Math.random() * 2, g: 0.05,
        shape: 'spark',
        color: Math.random() < 0.6 ? 'rgba(255,170,60,0.95)' : 'rgba(255,90,35,0.9)',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Teleport warp. The firing tank shreds into horizontal slices at the old spot,
// streaks across as a tapered beam, and reassembles at the landing spot.
// Deliberately NO round particles anywhere: slices, shards, chevrons, diamonds.
// The tank artwork itself is NEVER touched — drawTank() is called unmodified
// inside clips/transforms.
// ---------------------------------------------------------------------------
const WARP_SLICES = 9;
const WARP_T = { outEnd: 0.36, beam0: 0.22, beam1: 0.60, in0: 0.44, dur: 1.00 };
const WARP_HOT = '#c86bff', WARP_COOL = '#6be7ff';
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut3 = (v) => 1 - Math.pow(1 - clamp01(v), 3);

function startWarp(tp) {
  const [fx, fy] = tp.from, [tx, ty] = tp.to;
  S.warp = { seat: tp.seat, fx, fy, tx, ty, lava: !!tp.lava, fizzle: !!tp.fizzle, t: 0, dur: WARP_T.dur, sOut: false, sIn: false };
  S.shake = Math.min(8, S.shake + 3);
  Audio.warp();
  if (navigator.vibrate) navigator.vibrate([18, 40, 26]);
  if (tp.lava) S.floaters.push({ x: tx, y: ty - 340, text: 'LAVA!', age: 0, life: 1.7, color: '#ff8a3d' });
  if (tp.fizzle) S.floaters.push({ x: fx, y: fy - 300, text: 'BLOCKED', age: 0, life: 1.4, color: '#aeb9d6' });
}

function stepWarp(dt) {
  const W = S.warp; if (!W) return;
  W.t += dt;
  if (!W.sOut && W.t > 0.05) { W.sOut = true; warpShards(W.fx, W.fy, -1); }
  if (!W.sIn && W.t > WARP_T.in0 + 0.06) {
    W.sIn = true; warpShards(W.tx, W.ty, 1); S.shake = Math.min(8, S.shake + 2.5);
  }
  if (W.t >= W.dur) S.warp = null;
}

// Angular chips only — shape:'rect' so drawParticles takes its square branch.
function warpShards(x, y, sign) {
  for (let k = 0; k < 26; k++) {
    const a = -Math.PI * (0.12 + Math.random() * 0.76);
    const sp = 420 + Math.random() * 1500;
    S.particles.push({
      x: x + (Math.random() - 0.5) * 150, y: y - 30 - Math.random() * 240,
      vx: Math.cos(a) * sp * (0.4 + Math.random()) + sign * 260,
      vy: Math.sin(a) * sp,
      life: 0.35 + Math.random() * 0.5, age: 0,
      r: 8 + Math.random() * 14, g: 0.25, shape: 'rect',
      color: k % 3 === 0 ? '#ffffff' : (k % 3 === 1 ? WARP_HOT : WARP_COOL),
    });
  }
}

// Wraps drawTank() for the warping seat. Never modifies it.
function drawTankWarped(i) {
  const W = S.warp;
  if (!W || W.seat !== i || W.t >= W.dur) { drawTank(i); return; }
  const outK = 1 - clamp01(W.t / WARP_T.outEnd);                          // 1 → 0
  const inK = clamp01((W.t - WARP_T.in0) / (W.dur - WARP_T.in0));         // 0 → 1
  if (outK > 0) sliceTank(i, W.fx, 1 - outK, outK, -1);                   // shred apart
  if (inK > 0) sliceTank(i, W.tx, 1 - inK, inK, 1);                       // converge back
}

// Draw the tank clipped into horizontal bands that shear apart. `shred` 0 =
// intact, 1 = fully torn. Temporarily points S.tanks[i] at the end of the warp
// being drawn — tankScreen() derives y from surfaceAt(x), so x alone is enough.
function sliceTank(i, worldX, shred, fade, sign) {
  const real = S.tanks[i];
  S.tanks[i] = { x: worldX, y: surfaceAt(worldX) };
  const { sx, sy, r } = tankScreen(i);
  const top = sy - r * 3.0, bot = sy + r * 0.9;
  const band = (bot - top) / WARP_SLICES;
  for (let k = 0; k < WARP_SLICES; k++) {
    const f = k / (WARP_SLICES - 1);
    const lag = clamp01((shred - f * 0.30) / 0.70);
    const jitter = 0.35 + ((k * 7919) % 100) / 100;     // stable per-slice, no RNG flicker
    ctx.save();
    ctx.beginPath(); ctx.rect(-64, top + k * band, view.cssW + 128, band + 1); ctx.clip();
    ctx.globalAlpha = Math.max(0, fade * (1 - lag * 0.9));
    ctx.translate(sign * lag * lag * r * 11 * jitter, lag * r * 0.5 * (k % 2 ? 1 : -1));
    drawTank(i);
    ctx.restore();
  }
  ctx.globalAlpha = 0.85 * fade;                        // hard scan line on the shred front
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(sx - r * 2.0, top + shred * (bot - top) - Math.max(1, r * 0.10), r * 4.0, Math.max(1.5, r * 0.20));
  ctx.globalAlpha = 1;
  S.tanks[i] = real;
}

function drawWarp() {
  const W = S.warp; if (!W || W.t >= W.dur) return;
  const t = W.t;
  const r = Math.max(8, Math.min(18, 240 * cam.zoom));  // same rule as tankScreen
  const ax = wx2s(W.fx), ayG = wy2s(surfaceAt(W.fx)), ay = ayG - r * 1.1;
  const bx = wx2s(W.tx), byG = wy2s(surfaceAt(W.tx)), by = byG - r * 1.1;

  // 1. Vertical light columns — rect gradients, one opening at each end.
  const column = (cx, gy, k, tint) => {
    if (k <= 0.001) return;
    const h = r * 7.5 * k, w = Math.max(1.5, r * 0.34 * k);
    const g = ctx.createLinearGradient(0, gy - h, 0, gy + r * 0.6);
    g.addColorStop(0, 'rgba(200,107,255,0)');
    g.addColorStop(0.35, tint);
    g.addColorStop(1, 'rgba(255,255,255,0.95)');
    ctx.globalAlpha = 0.85 * k; ctx.fillStyle = g;
    ctx.fillRect(cx - w / 2, gy - h, w, h + r * 0.6);
    ctx.globalAlpha = 1;
  };
  column(ax, ayG, Math.sin(Math.PI * clamp01(t / WARP_T.outEnd)), 'rgba(200,107,255,0.9)');
  column(bx, byG, Math.sin(Math.PI * clamp01((t - WARP_T.in0) / (W.dur - WARP_T.in0))), 'rgba(107,231,255,0.9)');

  // 2. The transit beam — a tapered lozenge, sharp at both ends, plus chevrons.
  const bt = clamp01((t - WARP_T.beam0) / (WARP_T.beam1 - WARP_T.beam0));
  if (bt > 0 && bt < 1 && !W.fizzle) {
    const head = easeOut3(bt), tail = easeOut3(bt - 0.34);
    const hx = ax + (bx - ax) * head, hy = ay + (by - ay) * head;
    const px = ax + (bx - ax) * tail, py = ay + (by - ay) * tail;
    const dx = hx - px, dy = hy - py, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L, ux = dx / L, uy = dy / L;
    const th = r * 0.9 * Math.sin(Math.PI * bt);
    ctx.globalAlpha = 0.9;
    for (const [wid, col] of [[th, WARP_HOT], [th * 0.42, '#ffffff']]) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(px + nx * wid + dx * 0.30, py + ny * wid + dy * 0.30);
      ctx.lineTo(px, py);
      ctx.lineTo(px - nx * wid + dx * 0.30, py - ny * wid + dy * 0.30);
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = WARP_COOL; ctx.lineWidth = Math.max(1.5, r * 0.16); ctx.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const f = head - k * 0.09; if (f <= tail) continue;
      const cx = ax + (bx - ax) * f, cy = ay + (by - ay) * f, s = r * 0.85;
      ctx.globalAlpha = 0.75 - k * 0.15;
      ctx.beginPath();
      ctx.moveTo(cx - ux * s + nx * s, cy - uy * s + ny * s);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - ux * s - nx * s, cy - uy * s - ny * s);
      ctx.stroke();
    }
    ctx.lineCap = 'butt'; ctx.globalAlpha = 1;
  }

  // 3. Diamond shockwaves — the angular stand-in for S.rings' circles.
  const diamond = (cx, cy, k, col) => {
    if (k <= 0 || k >= 1) return;
    const rad = r * (0.6 + k * 5.2), fadeK = 1 - k;
    ctx.globalAlpha = fadeK * 0.8;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, r * 0.18 * fadeK);
    ctx.beginPath();
    ctx.moveTo(cx, cy - rad * 1.25); ctx.lineTo(cx + rad, cy);
    ctx.lineTo(cx, cy + rad * 0.55); ctx.lineTo(cx - rad, cy);
    ctx.closePath(); ctx.stroke();
    ctx.globalAlpha = 1;
  };
  diamond(ax, ay, clamp01(t / 0.42), WARP_HOT);
  if (!W.fizzle) diamond(bx, by, clamp01((t - WARP_T.in0) / 0.45), WARP_COOL);
}

// ---------------------------------------------------------------------------
// Tactical Nuke — mushroom cloud. Its own render pass with its own state slot
// and lifetime (exactly like S.muzzle / S.warp), so it long outlives the shot
// animation and can NEVER delay the turn handover.
//
// House style: every silhouette here is built from quadratic curves and filled
// with a gradient. There is not one ctx.arc / ctx.ellipse in this section — see
// mzPuff() for the same "lumpy mass, no disc" trick, and drawMuzzleFlashes()'
// bloom for "gradient to alpha 0 inside a rect reads as glare, not a circle".
// The whole pass draws BEHIND the tanks (see the call site in draw()), because
// the cloud is enormous and a tank must never get lost inside it.
// ---------------------------------------------------------------------------
const MUSH = {
  life:   6.6,    // total seconds on screen
  rise:   2.7,    // seconds for the cap to reach full height
  hgt:    3.15,   // cap-centre height at full rise, in blast radii
  capR:   1.55,   // cap radius at full billow, in blast radii
  billow: 3.0,    // seconds for the cap to reach full radius
  flash:  0.34,   // seconds of white-hot ground-zero glare
  hot:    1.55,   // seconds the fireball keeps glowing inside the column
  ring0:  0.26,   // condensation shell window (seconds)
  ring1:  2.30,
  skirt:  3.40,   // seconds the ground-hugging base surge lives
  fade:   0.60,   // fraction of `life` before the fade-out starts
};
const MUSH_DARK = [92, 85, 78];      // shadowed ash
const MUSH_LIT  = [206, 197, 182];   // sunlit ash
// k = 0 shadow … 1 sunlit. Returns the "r,g,b" body of an rgba() string.
function ashRGB(k) {
  const t = k < 0 ? 0 : k > 1 ? 1 : k;
  return `${(MUSH_DARK[0] + (MUSH_LIT[0] - MUSH_DARK[0]) * t) | 0},` +
         `${(MUSH_DARK[1] + (MUSH_LIT[1] - MUSH_DARK[1]) * t) | 0},` +
         `${(MUSH_DARK[2] + (MUSH_LIT[2] - MUSH_DARK[2]) * t) | 0}`;
}
function hexRGB(hex, fb) {
  const n = parseInt(String(hex || '').slice(1), 16);
  return Number.isFinite(n) ? `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}` : fb;
}

// The det payload carries no weapon id (game-core stays pure), so identify the
// nuke from the shot that is currently playing — exact — and fall back on its
// unique signature: the only weapon that CRATERS and leaves a GAS hazard.
function isNukeDet(det) {
  const wid = S.anim && S.anim.m && S.anim.m.weapon;
  if (wid) return wid === 'nuke';
  return det.kind === 'crater' && det.hz === 'gas';
}

function startMushroom(det) {
  S.mush = {
    x: det.x,
    gy: surfaceAt(det.x),                       // ground zero, on the local heightmap
    r: Math.max(240, det.r),                    // world units — everything scales off this
    tint: hexRGB(det.color, '182,255,90'),      // weapon colour, used only as a glow tint
    wind: (Math.random() < 0.5 ? -1 : 1) * (0.10 + Math.random() * 0.10),
    seed: Math.random() * 1000,
    t: 0, life: MUSH.life,
  };
}

// dt can be up to 2s when this is driven by the hidden-tab interval, so the cull
// is a plain ">=" on the accumulated clock — a big jump can never step over it.
function stepMushroom(dt) {
  const M = S.mush; if (!M) return;
  M.t += dt;
  if (M.t >= M.life) { S.mush = null; return; }
  if (M.t < 0.9) S.shake = Math.max(S.shake, 5 * (1 - M.t / 0.9));   // the ground keeps rolling
}

// Ellipse-ish lens from four quadratics. Deliberately a touch over-bulged so it
// reads as a cloud shell rather than a drawn circle.
function mushLens(cx, cy, rx, ry) {
  ctx.moveTo(cx - rx, cy);
  ctx.quadraticCurveTo(cx - rx, cy - ry * 1.06, cx, cy - ry);
  ctx.quadraticCurveTo(cx + rx, cy - ry * 1.06, cx + rx, cy);
  ctx.quadraticCurveTo(cx + rx, cy + ry * 1.06, cx, cy + ry);
  ctx.quadraticCurveTo(cx - rx, cy + ry * 1.06, cx - rx, cy);
  ctx.closePath();
}

// Lumpy, non-circular mass — mzPuff's idiom with independent rx/ry and a
// caller-supplied colour ramp, so the same helper does ash, dust and hot gas.
function mushBlob(cx, cy, rx, ry, seed, stops, lift) {
  if (!(rx > 0.6) || !(ry > 0.6)) return;
  const N = 9;
  const fAt = (th) => 0.82 + 0.20 * Math.sin(th * 3 + seed) + 0.11 * Math.sin(th * 5 - seed * 1.7);
  ctx.beginPath();
  for (let k = 0; k <= N; k++) {
    const th = (k / N) * Math.PI * 2, f = fAt(th);
    const x = cx + Math.cos(th) * rx * f, y = cy + Math.sin(th) * ry * f;
    if (k === 0) { ctx.moveTo(x, y); continue; }
    const tm = ((k - 0.5) / N) * Math.PI * 2, fm = fAt(tm) * 1.10;
    ctx.quadraticCurveTo(cx + Math.cos(tm) * rx * fm, cy + Math.sin(tm) * ry * fm, x, y);
  }
  ctx.closePath();
  const g = ctx.createRadialGradient(cx, cy - ry * (lift ?? 0.28), Math.max(0.5, rx * 0.06),
                                     cx, cy, Math.max(rx, ry) * 1.04);
  for (const [p, c] of stops) g.addColorStop(p, c);
  ctx.fillStyle = g; ctx.fill();
}

function drawMushroom() {
  const M = S.mush; if (!M || M.t >= M.life) return;
  const t = M.t, tn = t / M.life;
  const U = Math.max(9, M.r * cam.zoom);            // one blast radius, in screen px
  const gx = wx2s(M.x), gy = wy2s(M.gy);
  if (gx + U * 5.4 < 0 || gx - U * 5.4 > view.cssW || gy - U * 6.6 > view.cssH) return;

  const rise = 1 - Math.pow(1 - clamp01(t / MUSH.rise), 2.4);   // fast then decelerating
  const bil  = Math.pow(clamp01(t / MUSH.billow), 0.62);
  const flat = 1 + 0.30 * clamp01((t - MUSH.rise) / Math.max(0.1, M.life - MUSH.rise));
  const H  = U * MUSH.hgt * rise;                              // cap centre above ground
  const CR = U * (0.30 + (MUSH.capR - 0.30) * bil);            // cap radius
  const drift = U * M.wind * 1.9 * Math.pow(tn, 1.35);         // downwind lean (0 at t=0)
  const cx = gx + drift, cy = gy - H;
  const boil = t * 1.15 + M.seed;

  const fadeK = t < M.life * MUSH.fade ? 1
              : 1 - (t - M.life * MUSH.fade) / (M.life * (1 - MUSH.fade));
  // Zoomed hard in, the cap can be bigger than the screen; thin it out so the
  // battlefield stays readable instead of going flat grey.
  const over = clamp01((CR - view.cssH * 0.55) / Math.max(1, view.cssH * 0.9));
  const A = Math.max(0, fadeK) * (1 - 0.45 * over);
  if (A <= 0.01) return;
  // Deep zoom-in only: the cloud is then far bigger than the screen, so trade a
  // couple of lobes for fillrate. Normal play never crosses this.
  const lod = U > view.cssH * 0.80 ? 1 : 0;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';

  // 1. Condensation shell (Wilson cloud) — a thin lens BAND racing outward past
  //    the cap and thinning away. Two lens subpaths + evenodd, never a stroke.
  const rt = clamp01((t - MUSH.ring0) / (MUSH.ring1 - MUSH.ring0));
  if (rt > 0 && rt < 1) {
    const k = Math.pow(rt, 0.55);
    const rx = CR * (0.90 + 3.10 * k), ry = rx * (0.42 + 0.16 * k);
    const th = Math.max(1.2, CR * 0.20 * (1 - rt));
    ctx.beginPath();
    mushLens(cx, cy + CR * 0.15, rx, ry);
    mushLens(cx, cy + CR * 0.15, Math.max(1, rx - th), Math.max(1, ry - th * 0.6));
    ctx.fillStyle = `rgba(232,244,255,${A * 0.30 * Math.sin(Math.PI * Math.pow(rt, 0.72))})`;
    ctx.fill('evenodd');
  }

  // 2. Stem — one closed hourglass silhouette, sheared downwind at the top so
  //    the column bends the way a real one does.
  if (H > U * 0.10) {
    const wB = U * 0.52, wW = U * 0.30, wT = Math.min(U * 0.66, CR * 0.80);
    const sxAt = (hf) => gx + drift * hf * hf;          // bends more the higher it goes
    ctx.beginPath();
    ctx.moveTo(sxAt(0) - wB, gy);
    ctx.quadraticCurveTo(sxAt(0.24) - wB * 0.92, gy - H * 0.24, sxAt(0.48) - wW, gy - H * 0.48);
    ctx.quadraticCurveTo(sxAt(0.76) - wW * 1.05, gy - H * 0.76, sxAt(1) - wT, gy - H);
    ctx.lineTo(sxAt(1) + wT, gy - H);
    ctx.quadraticCurveTo(sxAt(0.76) + wW * 1.05, gy - H * 0.76, sxAt(0.48) + wW, gy - H * 0.48);
    ctx.quadraticCurveTo(sxAt(0.24) + wB * 0.92, gy - H * 0.24, sxAt(0) + wB, gy);
    ctx.closePath();
    const sg = ctx.createLinearGradient(gx, gy, cx, cy);
    sg.addColorStop(0,    `rgba(120,104,84,${A * 0.86})`);
    sg.addColorStop(0.42, `rgba(138,128,116,${A * 0.80})`);
    sg.addColorStop(1,    `rgba(176,166,152,${A * 0.72})`);
    ctx.fillStyle = sg; ctx.fill();

    const hotK = Math.max(0, 1 - t / MUSH.hot);
    if (hotK > 0.02) {                                  // fireball still lighting the column
      ctx.globalCompositeOperation = 'lighter';
      const hg = ctx.createLinearGradient(gx, gy, cx, cy);
      hg.addColorStop(0,    `rgba(255,170,60,${A * 0.42 * hotK})`);
      hg.addColorStop(0.35, `rgba(230,110,30,${A * 0.24 * hotK})`);
      hg.addColorStop(1,    'rgba(160,60,20,0)');
      ctx.fillStyle = hg; ctx.fill();                   // same path — no beginPath between
      ctx.globalCompositeOperation = 'source-over';
    }

    // Striations scrolling upward — the only cue that the column is MOVING
    // rather than merely growing. Kept inside the waist so no clip is needed.
    for (let k = 0; k < 3 - lod; k++) {
      const ph = (t * 0.5 + k * 0.34 + (M.seed % 1)) % 1;
      const y0 = gy - H * ph, y1 = gy - H * Math.min(1, ph + 0.26);
      const hw = U * (0.07 + 0.035 * k);
      const ox = sxAt(ph) + (k - 1) * U * 0.12;
      ctx.beginPath();
      ctx.moveTo(ox - hw, y0);
      ctx.quadraticCurveTo(ox - hw * 0.5, (y0 + y1) / 2, ox, y1);
      ctx.quadraticCurveTo(ox + hw * 0.5, (y0 + y1) / 2, ox + hw, y0);
      ctx.closePath();
      ctx.fillStyle = `rgba(86,78,70,${A * 0.16 * (1 - ph)})`;
      ctx.fill();
    }
  }

  // 3. Base surge — dust rolling outward along the ground. Sampled against the
  //    real heightmap so it hugs the terrain instead of floating over it.
  const st = clamp01(t / MUSH.skirt);
  if (st < 1) {
    const sa = A * 0.42 * (1 - st) * Math.min(1, t / 0.16);
    const spread = U * (0.55 + 2.35 * Math.pow(st, 0.45));
    const nS = 3 - lod;                                  // lobes run -nS .. nS
    for (let k = -nS; k <= nS; k++) {
      const f = k / nS;
      const sx = gx + f * spread;
      if (sx < -U || sx > view.cssW + U) continue;
      const sy = wy2s(surfaceAt(M.x + (f * spread) / Math.max(cam.zoom, 1e-4)));
      const rr = U * (0.62 - 0.20 * Math.abs(f)) * (0.70 + st * 0.90);
      mushBlob(sx, sy - rr * 0.45, rr * 1.35, rr * 0.72, M.seed + k * 3.1, [
        [0,   `rgba(178,152,112,${sa})`],
        [0.6, `rgba(140,116,84,${sa * 0.7})`],
        [1,   'rgba(110,92,68,0)'],
      ], 0.20);
    }
  }

  // 4. Cap — a rolling, billowing mass that curls under at the rim.
  {
    const cA = A * Math.min(1, t / 0.20);
    // shadowed underside first, so the body and the crown overlap it
    mushBlob(cx, cy + CR * 0.30, CR * 1.28 * flat, CR * 0.52, M.seed + 11, [
      [0,    `rgba(74,68,62,${cA * 0.80})`],
      [0.62, `rgba(58,53,49,${cA * 0.55})`],
      [1,    'rgba(46,42,39,0)'],
    ], 0.05);
    // main mass — flattens and spreads as it tops out
    mushBlob(cx, cy, CR * 1.34 * flat, (CR * 0.80) / flat, M.seed + 3, [
      [0,    `rgba(${ashRGB(0.92)},${cA * 0.92})`],
      [0.52, `rgba(${ashRGB(0.46)},${cA * 0.88})`],
      [1,    `rgba(${ashRGB(0.10)},${cA * 0.30})`],
    ], 0.42);
    // the roll-under: two dense lobes tucking beneath the outer edges
    for (const s of [-1, 1]) {
      mushBlob(cx + s * CR * 1.02 * flat, cy + CR * 0.40, CR * 0.46, CR * 0.36,
               M.seed + 7 + s, [
        [0,    `rgba(104,96,88,${cA * 0.80})`],
        [0.55, `rgba(72,66,61,${cA * 0.62})`],
        [1,    'rgba(54,49,45,0)'],
      ], -0.30);
    }
    // crown billows, boiling on their own slow clock
    const nB = lod ? 4 : 6;
    for (let k = 0; k < nB; k++) {
      const th = -Math.PI * (0.10 + 0.80 * (k / (nB - 1)));
      const pu = 0.86 + 0.16 * Math.sin(boil * 1.7 + k * 2.1);
      const bx = cx + Math.cos(th) * CR * 1.00 * flat;
      const by = cy + Math.sin(th) * CR * 0.62;
      const br = CR * 0.44 * pu;
      const lit = 0.50 - 0.50 * Math.sin(th);            // 1 at the crown, 0.5 at the rim
      mushBlob(bx, by, br * 1.18, br, M.seed + k * 4.3, [
        [0,    `rgba(${ashRGB(lit)},${cA * 0.90})`],
        [0.58, `rgba(${ashRGB(lit * 0.55)},${cA * 0.70})`],
        [1,    `rgba(${ashRGB(0)},0)`],
      ], 0.34);
    }
    // still burning inside — additive, composite restored immediately after.
    const hk = Math.max(0, 1 - t / MUSH.hot);
    if (hk > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      const hy = cy + CR * 0.22, hr = CR * (0.95 + 0.50 * (1 - hk));
      const hg = ctx.createRadialGradient(cx, hy, 0, cx, hy, hr);
      hg.addColorStop(0,    `rgba(255,236,180,${A * 0.55 * hk})`);
      hg.addColorStop(0.38, `rgba(255,152,48,${A * 0.34 * hk})`);
      hg.addColorStop(0.72, `rgba(${M.tint},${A * 0.16 * hk})`);
      hg.addColorStop(1,    'rgba(120,40,10,0)');
      ctx.fillStyle = hg;
      ctx.fillRect(cx - hr, hy - hr, hr * 2, hr * 2);   // dies to alpha 0: glare, no rim
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // 5. Ground zero — the initial flash. Glare is a radial gradient inside a RECT
  //    (no rim, so it reads as light, not a disc) plus mzLanceFill light lances,
  //    the exact shapes the muzzle blast uses.
  const ft = clamp01(t / MUSH.flash);
  if (ft < 1) {
    const fa = Math.pow(1 - ft, 1.5);
    const fy = gy - U * 0.25;
    ctx.globalCompositeOperation = 'lighter';
    const bl = U * (1.10 + 2.40 * Math.pow(ft, 0.40));
    const bg = ctx.createRadialGradient(gx, fy, 0, gx, fy, bl);
    bg.addColorStop(0,    `rgba(255,255,250,${0.92 * fa})`);
    bg.addColorStop(0.30, `rgba(255,238,176,${0.55 * fa})`);
    bg.addColorStop(0.62, `rgba(${M.tint},${0.24 * fa})`);
    bg.addColorStop(1,    'rgba(255,120,30,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(gx - bl, fy - bl, bl * 2, bl * 2);
    const len = U * (1.60 + 3.00 * ft), hw = U * 0.30 * (1 - ft * 0.60);
    for (const [dx, dy, lf] of [[1, 0, 1], [-1, 0, 1], [0, -1, 1.25],
                                [0.71, -0.71, 0.7], [-0.71, -0.71, 0.7]]) {
      mzLanceFill(gx, gy - U * 0.15, dx, dy, len * lf, hw, [
        [0,   `rgba(255,252,232,${0.55 * fa})`],
        [0.4, `rgba(255,196,90,${0.30 * fa})`],
        [1,   'rgba(210,80,20,0)'],
      ]);
    }
  }

  ctx.restore();          // restores composite, fillStyle and globalAlpha
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
  clearKillcam();
  if (m.hp) S.hp = m.hp.slice();
  if (m.alive) S.alive = m.alive.slice();
  updateHud();
  let title, cls, win = false;
  if (m.golf) {                                  // Artillery Golf: the scorecard IS the verdict
    const g = m.golf;
    const mine = g.totals[S.you] ?? g.totals[0];
    const diff = mine - g.parTotal;
    const vsPar = diff === 0 ? 'even par' : diff > 0 ? `+${diff}` : `${diff}`;
    if (g.totals.length < 2) { title = `Round complete — ${mine} strokes (${vsPar})`; cls = 'win'; win = true; }
    else if (m.winner === S.you) { title = `You win the round! ${mine} strokes (${vsPar})`; cls = 'win'; win = true; }
    else if (m.winner === -1) { title = `All square — ${mine} strokes (${vsPar})`; cls = 'draw'; }
    else { title = `${S.names[m.winner]} takes the round`; cls = 'lose'; }
    Audio.chime(win);
    const rt = $('resultTitle'); rt.textContent = title; rt.className = 'result ' + cls;
    $('finalScores').innerHTML = g.totals.map((t, i) =>
      `<div class="fs" style="--seat:${seatColor(i)}"><b>${t}</b><span>${(S.names[i] || '')} strokes</span></div>`
    ).join('');
    $('rematchBtn').style.display = '';
    $('overlay').classList.remove('hidden');
    return;
  }
  if (m.team) {                                  // Boss Raid verdicts are TEAM verdicts
    if (m.team === 'players') { title = 'WARLORD-7 DESTROYED! 🏆'; cls = 'win'; win = true; }
    else if (m.team === 'boss') { title = 'Your squad was wiped out'; cls = 'lose'; }
    else { title = 'Mutual destruction!'; cls = 'draw'; }
    Audio.chime(win);
    showOverlay(title, m.hp, cls, false);
    return;
  }
  if (m.winner === -1) { title = 'Mutual destruction!'; cls = 'draw'; }
  else if (m.winner === S.you) { title = S.n > 2 ? 'Last tank standing! \u{1F3C6}' : 'Enemy destroyed! \u{1F3C6}'; cls = 'win'; win = true; }
  else if (S.n > 2) { title = `${S.names[m.winner]} takes the canyon`; cls = 'lose'; }
  else { title = 'Your tank was destroyed'; cls = 'lose'; }
  Audio.chime(win);
  showOverlay(title, m.hp, cls, false);
}
function showOverlay(title, hp, cls, hideRematch) {
  const rt = $('resultTitle'); rt.textContent = title; rt.className = 'result ' + cls;
  const fs = $('finalScores');
  fs.innerHTML = hp ? hp.map((h, i) =>
    `<div class="fs" style="--seat:${seatColor(i)}"><b>${Math.max(0, h)}</b><span>${(S.names[i] || '')} HP</span></div>`
  ).join('') : '';
  $('rematchBtn').style.display = hideRematch ? 'none' : '';
  $('overlay').classList.remove('hidden');
}
$('rematchBtn').onclick = () => sendMsg({ type: 'rematch' });
$('exitBtn').onclick = () => { clearResume(); sendMsg({ type: 'leave' }); location.href = location.origin; };

// Leave mid-game — always behind an "are you sure?" so a stray tap can't quit.
$('leaveBtn').onclick = () => $('confirmLeave').classList.remove('hidden');
$('stayBtn').onclick = () => $('confirmLeave').classList.add('hidden');
$('confirmLeave').onclick = (e) => { if (e.target.id === 'confirmLeave') $('confirmLeave').classList.add('hidden'); };
$('leaveYesBtn').onclick = () => { clearResume(); sendMsg({ type: 'leave' }); location.href = location.origin; };

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  if (S.terrain) {
    stepKillcam(dt);                     // real time: bars, phases, audio cue
    const sdt = dt * killcamScale();     // battlefield time (=== dt outside a killcam)
    advanceAnim(sdt); stepTerrainAnim(sdt); stepEffects(sdt);
    updateCamera(dt);                    // camera eases in REAL time, so it never crawls
  }
  draw();
  requestAnimationFrame(frame);
}

// Keep playback advancing while the tab is hidden (rAF pauses there).
let bgLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(2, (now - bgLast) / 1000);
  bgLast = now;
  if (document.hidden && S.terrain) {
    stepKillcam(dt);                     // must still run, or pendingOver never releases
    const sdt = dt * killcamScale();
    advanceAnim(sdt); stepTerrainAnim(sdt); stepEffects(sdt);
  }
}, 400);

function stepEffects(dt) {
  stepWarp(dt);
  stepMushroom(dt);
  stepPlane(dt);
  // Supply crates float down on their chutes (~2.4s), purely cosmetic — the
  // server considers a crate collectable the moment it broadcasts it.
  for (const c of S.crates) if (c.dropT < 1) c.dropT = Math.min(1, c.dropT + dt / 2.4);
  // Staggered chain explosions from barrels/bunkers.
  if (S.chainQueue.length) {
    const now = performance.now();
    const due = S.chainQueue.filter(q => q.at <= now);
    if (due.length) {
      S.chainQueue = S.chainQueue.filter(q => q.at > now);
      for (const q of due) detonate(q.det);
    }
  }
  // Barrel runs back out to battery (shaped by recAmt in drawTank).
  for (let i = 0; i < S.n; i++) if (S.recoil[i] > 0) S.recoil[i] = Math.max(0, S.recoil[i] - dt * 3.4);
  // Muzzle blasts age on their own clock — they are NOT particles.
  if (S.muzzle.length) {
    for (const mz of S.muzzle) mz.age += dt;
    S.muzzle = S.muzzle.filter(mz => mz.age < mz.life);
  }
  // Drive lean: the hull leans into the direction of travel, then rocks back and
  // settles when you stop (a damped spring — so movement never looks stale).
  const now = performance.now();
  for (let i = 0; i < S.n; i++) {
    if (now - (S.moveAt[i] || 0) > 130) S.leanTarget[i] = 0;    // stopped driving
    const k = 150, damp = 9.5;
    S.leanV[i] += ((S.leanTarget[i] || 0) - S.lean[i]) * k * dt;
    S.leanV[i] -= S.leanV[i] * damp * dt;
    S.lean[i] += S.leanV[i] * dt;
  }
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
      if (h.type === 'fire') {
        // Embers + rolling smoke pouring off the blaze.
        for (let n = 0; n < 3; n++) {
          if (Math.random() > dt * 16) continue;
          const fx = h.x + (Math.random() - 0.5) * h.r * 1.8;
          // The blaze itself is the flame TONGUES in drawHazards(); these are only
          // sparks and a little back-layer haze, so a tank standing in the fire
          // stays fully readable.
          const ember = Math.random() < 0.82;
          S.particles.push({
            x: fx, y: surfaceAt(fx) - 10,
            vx: (Math.random() - 0.5) * 190, vy: -300 - Math.random() * 320,
            life: ember ? 0.55 + Math.random() * 0.5 : 1.0 + Math.random() * 0.7, age: 0,
            r: ember ? 1.6 + Math.random() * 2.2 : 10 + Math.random() * 12,
            g: ember ? 0.12 : 0.05,
            shape: ember ? 'spark' : undefined,
            color: ember
              ? (Math.random() < 0.5 ? 'rgba(255,208,90,0.95)' : 'rgba(255,130,40,0.9)')
              : 'rgba(70,62,58,0.28)',
          });
        }
      }
    }
    if (S.playing) {
      for (let i = 0; i < S.n; i++) {
        const hp = S.hp[i];
        if (S.alive[i] === false || hp > S.maxHp * 0.45 || hp <= 0) continue;
        const heavy = hp <= S.maxHp * 0.2;
        if (Math.random() < dt * (heavy ? 13 : 5)) {
          const t = S.tanks[i];
          S.particles.push({
            x: t.x + (Math.random() - 0.5) * 50, y: t.y - 60,
            vx: (Math.random() - 0.5) * 40 + 15, vy: -140 - Math.random() * 130,
            life: 1.1 + Math.random() * 0.7, age: 0,
            r: heavy ? 9 : 6,
            color: heavy ? 'rgba(35,35,42,0.5)' : 'rgba(105,105,115,0.38)',
          });
          if (heavy && Math.random() < 0.5) {
            S.particles.push({ x: t.x + (Math.random() - 0.5) * 40, y: t.y - 45, vx: (Math.random() - 0.5) * 60, vy: -110, life: 0.45, age: 0, r: 2.4, shape: 'spark', color: '#ffb45a' });
          }
        }
      }
    }
  }
}

function draw() {
  if (view.dispW !== (canvas.clientWidth || 0) || view.dispH !== (canvas.clientHeight || 0)) resize();
  const { cssW, cssH } = view;
  ctx.save();
  if (S.shake > 0.15) ctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);

  drawSky(cssW, cssH);
  if (S.terrain) {
    drawPlane();              // in the sky, BEFORE the terrain — peaks occlude it
    drawTerrain(cssW, cssH);
    drawLava(cssW, cssH);
    drawTrees();
    drawProps();
    drawCrates();
    drawGolfCup();
    drawHazards();
    drawMushroom();               // nuke column — biggest and furthest back, BEHIND the tanks
    drawParticles(true);          // soft discs (fire glow, smoke, dust) — BEHIND the tanks
    // Tanks may now share an x (crossing is legal), and a hull is 648 world units
    // wide — so draw the tank that matters LAST: the acting seat on top, then
    // yours. Cosmetic only; no state, no geometry change, drawTank untouched.
    {
      const order = [];
      for (let i = 0; i < S.n; i++) if (S.alive[i] !== false) order.push(i);
      order.sort((a, b) => (a === S.turn) - (b === S.turn) || (a === S.you) - (b === S.you));
      for (const i of order) {
        if (i === S.boss) drawMech(i); else drawTankWarped(i);
        if (S.shield && S.shield[i] > 0) drawShieldAura(i);
      }
    }
    drawWarp();
    drawEdgeIndicators();
    drawAim();
    drawProjectiles();
    drawMuzzleFlashes();      // over the gun and the shell, under damage numbers
    drawRings();
    drawParticles(false);     // soil chips + sparks — too small to ever hide a tank
    drawFloaters();
  }
  ctx.restore();

  if (S.flash > 0.01) { ctx.fillStyle = `rgba(255,240,210,${S.flash})`; ctx.fillRect(0, 0, cssW, cssH); }
  drawKillcam(cssW, cssH);        // bars/vignette sit outside the shake transform
}

// Posterized bright daytime sky (Level-6 look) — flat blue bands, a chunky
// pixel sun and a couple of blocky clouds. Drawn in screen space (a skybox).
// ---- Biome themes -----------------------------------------------------------
// One entry per server biome. sky = posterized bands, tl = terrain depth layers
// (same shape as the old TLAYERS), trees = canopy rows, dead = skeletal trees.
const BIOME_THEMES = {
  alpine:   { sky: ['#3fb0ff', '#54bcff', '#74caff', '#93d6ff', '#b0e2ff'],
              tl: [[55, '#83cf4f'], [230, '#4e9235'], [820, '#6b4d28'], [Infinity, '#3a2a14']] },
  desert:   { sky: ['#ffb45a', '#ffc478', '#ffd79a', '#ffe7bd', '#fff3d9'],
              tl: [[55, '#eecf8a'], [230, '#d8b269'], [820, '#a97f42'], [Infinity, '#6b4c24']] },
  ice:      { sky: ['#9fd2ff', '#b6deff', '#cde9ff', '#e1f2ff', '#f2faff'],
              tl: [[55, '#f2f8ff'], [230, '#c3ddf2'], [820, '#7d9fc0'], [Infinity, '#3c526b']] },
  volcanic: { sky: ['#2a1418', '#3c1b1c', '#552420', '#742e20', '#93401f'],
              tl: [[55, '#6b5a52'], [230, '#544741'], [820, '#3a322e'], [Infinity, '#221d1b']], dead: true },
  ruins:    { sky: ['#8fa6b8', '#a3b6c4', '#b8c8d2', '#ccd8e0', '#dfe8ed'],
              tl: [[55, '#7f9c60'], [230, '#5d7a48'], [820, '#5c5347'], [Infinity, '#37312a']] },
};
let THEME = BIOME_THEMES.alpine;
let SKY_BANDS = THEME.sky;
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
let TLAYERS = [
  [55,        '#83cf4f'],   // bright grass cap (0..55 world units below surface)
  [230,       '#4e9235'],   // deeper green slope
  [820,       '#6b4d28'],   // brown soil
  [Infinity,  '#3a2a14'],   // deep dirt to the base
];
// ---- Burn scars -------------------------------------------------------------
// Fire never moves dirt — it blackens it. The server sends merged world-x ranges
// (S.scorch); each terrain column inside one has its TOP layers tinted toward
// charcoal, hardest at the grass cap and fading with depth, plus a thin crust
// line right on the surface. Every tint string is precomputed at load, so the
// per-column loop only ever does a fillStyle swap — no per-frame allocation.
const SCORCH_FEATHER = 300;                    // world units of soft edge each side
const SCORCH_STEPS = 6;                        // quantised tint levels
const SCORCH_TINT = [0.90, 0.62, 0.24, 0.06];  // how hard each TLAYER chars
const SCORCH_CHAR = [24, 19, 16];              // charcoal target colour
function mixToward(hex, rgb, t) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgb(${Math.round(r + (rgb[0] - r) * t)},${Math.round(g + (rgb[1] - g) * t)},${Math.round(b + (rgb[2] - b) * t)})`;
}
// TCHAR[layer][step] — step 0 is byte-identical to the clean colour.
const buildTCHAR = () => TLAYERS.map((L, li) =>
  Array.from({ length: SCORCH_STEPS + 1 }, (_, s) =>
    mixToward(L[1], SCORCH_CHAR, (s / SCORCH_STEPS) * SCORCH_TINT[li])));
let TCHAR = buildTCHAR();

// Swap every biome-coloured table in one place. Called from applySnapshot, so a
// resume or a golf hole change restyles the whole battlefield atomically.
function setBiomeTheme(biome) {
  THEME = BIOME_THEMES[biome] || BIOME_THEMES.alpine;
  SKY_BANDS = THEME.sky;
  TLAYERS = THEME.tl;
  TCHAR = buildTCHAR();
}
const SCORCH_CRUST = Array.from({ length: SCORCH_STEPS + 1 },
  (_, s) => `rgba(12,10,8,${((s / SCORCH_STEPS) * 0.6).toFixed(3)})`);

// Burn intensity 0 (clean) .. 1 (fully charred) at a world x.
function scorchAt(wx) {
  let k = 0;
  for (const s of S.scorch) {
    if (wx < s.a - SCORCH_FEATHER || wx > s.b + SCORCH_FEATHER) continue;
    const d = wx < s.a ? s.a - wx : (wx > s.b ? wx - s.b : 0);
    const v = d <= 0 ? 1 : 1 - d / SCORCH_FEATHER;
    if (v > k) { k = v; if (k >= 1) break; }
  }
  return k;
}

// Concrete deck lookup for the ruins biome. Ranges are few (≤5), so a linear
// scan per column is cheap.
function ruinAt(wx) {
  if (!S.ruins || !S.ruins.length) return null;
  for (const r of S.ruins) if (wx >= r.a && wx <= r.b) return r;
  return null;
}
const RUIN_COLS = [[90, '#cdd6dd'], [430, '#99a3ab'], [Infinity, '#565f66']];

function drawTerrain(w, h) {
  const z = cam.zoom;                            // low-res px per world unit
  const burnt = S.scorch && S.scorch.length > 0;
  const crustPx = Math.max(1, Math.round(26 * z));
  for (let sx = 0; sx < w; sx++) {
    const wxc = s2wx(sx + 0.5);
    if (wxc < 0 || wxc > WW()) continue;         // letterbox when zoomed out past the map
    const surf = wy2s(surfaceAt(wxc));
    if (surf >= h) continue;
    const sc = burnt ? Math.round(scorchAt(wxc) * SCORCH_STEPS) : 0;
    let top = surf;
    // Indestructible concrete reads as concrete, not painted grass — but only
    // while the deck itself is the surface (dirt piled on top covers it).
    const ruin = ruinAt(wxc);
    if (ruin && Math.abs(S.terrain[Math.round(wxc)] - ruin.top) < 60) {
      for (let li = 0; li < RUIN_COLS.length; li++) {
        const bottom = RUIN_COLS[li][0] === Infinity ? h : surf + RUIN_COLS[li][0] * z;
        const y0 = Math.max(0, Math.round(top)), y1 = Math.min(h, Math.round(bottom));
        if (y1 > y0) { ctx.fillStyle = RUIN_COLS[li][1]; ctx.fillRect(sx, y0, 1, y1 - y0); }
        top = bottom;
        if (top >= h) break;
      }
      continue;
    }
    for (let li = 0; li < TLAYERS.length; li++) {
      const bottom = TLAYERS[li][0] === Infinity ? h : surf + TLAYERS[li][0] * z;
      const y0 = Math.max(0, Math.round(top)), y1 = Math.min(h, Math.round(bottom));
      if (y1 > y0) { ctx.fillStyle = TCHAR[li][sc]; ctx.fillRect(sx, y0, 1, y1 - y0); }
      top = bottom;
      if (top >= h) break;
    }
    if (sc > 0) {                                // charred crust right on the surface
      const cy0 = Math.max(0, Math.round(surf));
      const ch = Math.min(h - cy0, crustPx);
      if (ch > 0) { ctx.fillStyle = SCORCH_CRUST[sc]; ctx.fillRect(sx, cy0, 1, ch); }
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
    const burn = (S.scorch && S.scorch.length) ? scorchAt(t.x) : 0;
    const rows = (burn > 0.45 || THEME.dead)
      ? [[5, '#2a241d'], [4, '#332c23'], [2.9, '#2a241d'], [1.7, '#332c23']]   // burnt to a black skeleton
      : [[5, '#2f5a2b'], [4, '#3a6f34'], [2.9, '#2f5a2b'], [1.7, '#3a6f34']];
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
      // Big, hectic blaze: many tongues, each flickering on its own rhythm and
      // wavering side to side so the fire never looks static.
      const n = 13;
      for (let k = 0; k < n; k++) {
        const seed = k * 2.393 + h.id;
        const fx = h.x + ((k / (n - 1)) * 2 - 1) * h.r * 0.92 + Math.sin(t * 3.1 + seed) * h.r * 0.07;
        const fy = surfaceAt(fx);
        const sway = Math.sin(t * 6.3 + seed * 1.7) * 0.28;
        const flick = 0.55 + 0.45 * Math.abs(Math.sin(t * 13 + seed * 2.1)) + 0.18 * Math.sin(t * 27 + seed);
        const sx = wx2s(fx), sy = wy2s(fy);
        const fh = Math.max(10, h.r * 1.05 * cam.zoom) * flick;
        const fw = fh * 0.42;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#e0350c';                       // deep red outer
        ctx.beginPath(); ctx.moveTo(sx + sway * fw * 2, sy - fh); ctx.quadraticCurveTo(sx + fw * 1.25, sy - fh * 0.42, sx, sy); ctx.quadraticCurveTo(sx - fw * 1.25, sy - fh * 0.42, sx + sway * fw * 2, sy - fh); ctx.fill();
        ctx.fillStyle = '#ff7a1e';                       // orange body
        ctx.beginPath(); ctx.moveTo(sx + sway * fw * 1.5, sy - fh * 0.74); ctx.quadraticCurveTo(sx + fw * 0.8, sy - fh * 0.3, sx, sy); ctx.quadraticCurveTo(sx - fw * 0.8, sy - fh * 0.3, sx + sway * fw * 1.5, sy - fh * 0.74); ctx.fill();
        ctx.fillStyle = '#ffe066';                       // white-hot core
        ctx.beginPath(); ctx.moveTo(sx + sway * fw, sy - fh * 0.42); ctx.quadraticCurveTo(sx + fw * 0.4, sy - fh * 0.16, sx, sy); ctx.quadraticCurveTo(sx - fw * 0.4, sy - fh * 0.16, sx + sway * fw, sy - fh * 0.42); ctx.fill();
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
  for (let i = 0; i < S.n; i++) {
    const t = S.tanks[i];
    if (!t || S.alive[i] === false) continue;
    const sx = wx2s(t.x);
    if (sx >= -10 && sx <= view.cssW + 10) continue;
    const left = sx < 0;
    const ex = left ? 14 : view.cssW - 14;
    // Stagger by seat so two off-screen tanks on the same edge don't overlap.
    const ey = Math.min(view.cssH - 60, Math.max(70, wy2s(t.y - 300))) + i * 22;
    const c = seatColor(i);
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
// "Clean Sweep" tank palette + barrel geometry. Shared by drawTank and the
// muzzle-blast helper so the shot always leaves the very end of the gun.
const TANK_G = {
  track: '#121418', wheel: '#252931', skirt: '#2e333b', skirtDk: '#262b32',
  hull: '#3a3f47', hullLite: '#474d57', turret: '#31363d', hatch: '#3e444d',
  mantlet: '#4b525c', barrel: '#5b626c', barrelLite: '#6d747f',
  brake: '#434952', brakeSlot: '#23272e',
};
const BARREL = { ox: 0.47, oy: -0.72, len: 1.45, brake: 0.26 };
// Recoil: how far the gun tube telescopes back INTO the mantlet, in tank radii,
// and the shape of the run-out. Kept here so drawTank and the muzzle pass agree.
const REC_MAX = 0.62;
const recAmt = (i) => Math.pow(S.recoil[i] || 0, 1.8);   // slams back, eases into battery

// Local slope the tank sits on (also used for the muzzle position).
function tankTilt(i, r) {
  if (i === S.boss) return 0;                    // the mech stands level on its struts
  const wx = S.tanks[i].x;
  const wSpan = Math.max(30, (r * 1.15) / Math.max(cam.zoom, 1e-4));
  const t = Math.atan2(surfaceAt(wx + wSpan) - surfaceAt(wx - wSpan), 2 * wSpan);
  return Math.max(-0.6, Math.min(0.6, t)) + (S.lean[i] || 0);
}

// World position of the very end of the barrel — where shots and the muzzle
// blast come from. Mirrors drawTank's tilt/lift transform.
// ---------------------------------------------------------------------------
// WARLORD-7 — the boss mecha-tank. Its OWN renderer (the player tank art is
// locked and untouched): a wide tracked chassis under hydraulic struts, an
// armoured torso with a glowing eye slit, a shoulder missile rack, and a spinal
// rail gun that follows its aim and shares the recoil spring. Drawn ~1.8x the
// player silhouette to match its server hitbox scale.
// ---------------------------------------------------------------------------
const MECH = { dk: '#1d2127', mid: '#2c323b', lite: '#3f4752', trim: '#552e33', glow: '#ff3b30' };
function drawMech(i) {
  if (!S.tanks[i]) return;
  let { sx, sy, r } = tankScreen(i);
  r *= 1.8;
  const front = facingOf(i), dir = front;
  ctx.save();

  // ground shadow
  ctx.fillStyle = 'rgba(10,12,16,0.35)';
  ctx.fillRect(sx - r * 1.5, sy - r * 0.04, r * 3.0, r * 0.12);

  // tracked chassis
  ctx.fillStyle = MECH.dk;
  ctx.fillRect(sx - r * 1.45, sy - r * 0.5, r * 2.9, r * 0.5);
  ctx.fillStyle = MECH.mid;
  ctx.fillRect(sx - r * 1.3, sy - r * 0.62, r * 2.6, r * 0.18);
  ctx.fillStyle = '#14171c';                                   // road wheels as dark sockets
  for (let k = -2; k <= 2; k++) ctx.fillRect(sx + k * r * 0.52 - r * 0.12, sy - r * 0.34, r * 0.24, r * 0.24);

  // hydraulic struts up to the torso
  ctx.strokeStyle = MECH.lite; ctx.lineWidth = Math.max(2, r * 0.14); ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(sx - r * 0.8, sy - r * 0.6); ctx.lineTo(sx - r * 0.45, sy - r * 1.15);
  ctx.moveTo(sx + r * 0.8, sy - r * 0.6); ctx.lineTo(sx + r * 0.45, sy - r * 1.15);
  ctx.stroke();

  // torso — angular armoured block
  ctx.fillStyle = MECH.mid;
  ctx.beginPath();
  ctx.moveTo(sx - r * 1.05, sy - r * 1.1);
  ctx.lineTo(sx + r * 1.05, sy - r * 1.1);
  ctx.lineTo(sx + r * 0.85, sy - r * 1.95);
  ctx.lineTo(sx - r * 0.85, sy - r * 1.95);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = MECH.lite;                                    // glacis highlight
  ctx.fillRect(sx - r * 0.85 * dir - (dir > 0 ? 0 : 0), sy - r * 1.95, r * 0.22 * dir, r * 0.85);
  ctx.fillStyle = MECH.trim;                                    // warning chevrons
  for (let k = 0; k < 3; k++) ctx.fillRect(sx - r * 0.45 + k * r * 0.34, sy - r * 1.32, r * 0.2, r * 0.1);

  // head + eye slit (glows toward its facing)
  ctx.fillStyle = MECH.dk;
  ctx.fillRect(sx - r * 0.5, sy - r * 2.35, r * 1.0, r * 0.42);
  ctx.fillStyle = MECH.glow;
  ctx.fillRect(sx - r * 0.34 + dir * r * 0.1, sy - r * 2.24, r * 0.62, Math.max(1.5, r * 0.09));
  ctx.fillStyle = 'rgba(255,90,82,0.28)';                       // eye bloom
  ctx.fillRect(sx - r * 0.44 + dir * r * 0.1, sy - r * 2.3, r * 0.86, r * 0.22);

  // shoulder missile rack on the back side
  const bx = sx - dir * r * 0.95;
  ctx.fillStyle = MECH.mid;
  ctx.fillRect(bx - r * 0.42, sy - r * 2.5, r * 0.84, r * 0.55);
  ctx.fillStyle = '#0f1216';
  for (let k = 0; k < 3; k++) ctx.fillRect(bx - r * 0.3 + k * r * 0.24, sy - r * 2.42, r * 0.16, r * 0.16);
  ctx.fillStyle = MECH.trim;
  ctx.fillRect(bx - r * 0.42, sy - r * 2.0, r * 0.84, r * 0.06);

  // spinal rail gun — same aim/recoil conventions as drawTank, tilt-free
  const aim = S.aim[i] || { angle: 45, power: 60 };
  const rad = aim.angle * Math.PI / 180;
  const cosA = Math.cos(rad) * dir, sinA = -Math.sin(rad);
  const px = sx + dir * r * 0.47, py = sy - r * 1.86;
  const rc = S.recoil[i] || 0;
  const bLen = r * 1.5 - r * 0.5 * Math.pow(rc, 1.8);
  ctx.strokeStyle = MECH.lite; ctx.lineWidth = Math.max(3, r * 0.22);
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + cosA * bLen, py + sinA * bLen); ctx.stroke();
  ctx.strokeStyle = MECH.glow; ctx.lineWidth = Math.max(1, r * 0.06);       // rail charge line
  ctx.beginPath();
  ctx.moveTo(px + cosA * r * 0.2, py + sinA * r * 0.2);
  ctx.lineTo(px + cosA * bLen * 0.92, py + sinA * bLen * 0.92);
  ctx.stroke();
  ctx.strokeStyle = MECH.dk; ctx.lineWidth = Math.max(4, r * 0.34);         // muzzle housing
  ctx.beginPath();
  ctx.moveTo(px + cosA * (bLen - r * 0.02), py + sinA * (bLen - r * 0.02));
  ctx.lineTo(px + cosA * (bLen + r * 0.22), py + sinA * (bLen + r * 0.22));
  ctx.stroke();

  ctx.restore();
}

function muzzleTipWorld(i) {
  if (!S.tanks[i] || !cam.zoom) return null;
  let { sx, sy, r } = tankScreen(i);
  if (i === S.boss) r *= 1.8;                    // the mech's rail rides higher and further
  const front = facingOf(i), dir = front;
  const tilt = tankTilt(i, r), LIFT = r * 0.42;
  const px = sx + front * r * BARREL.ox, py = sy + r * BARREL.oy;
  const rad = (S.aim[i] ? S.aim[i].angle : 45) * Math.PI / 180;
  const wcos = Math.cos(rad) * dir, wsin = -Math.sin(rad);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const vx0 = px - sx, vy0 = py - sy - LIFT;
  const ox = sx + vx0 * ct - vy0 * st, oy = sy + vx0 * st + vy0 * ct;
  const bLen = r * (BARREL.len + BARREL.brake);   // out to the tip of the muzzle brake
  const tipX = ox + wcos * bLen, tipY = oy + wsin * bLen;
  return {
    x: (tipX - view.cssW / 2) / cam.zoom + cam.cx,
    y: (tipY - view.cssH / 2) / cam.zoom + cam.cy,
    dx: wcos, dy: wsin,
  };
}

// Kick the gun back and blast a directional flash out of the bore. NO particles:
// the flash is its own polygon/gradient pass (drawMuzzleFlashes), so nothing
// round is ever drawn. Anchored at the barrel tip AT REST — the gas leaves
// before the tube has moved.
function muzzleBlast(i) {
  S.recoil[i] = 1;
  const tip = muzzleTipWorld(i);
  if (!tip) return;
  const { r } = tankScreen(i);
  S.muzzle.push({
    seat: i,
    x: tip.x, y: tip.y,                        // world position of the muzzle brake tip
    dx: tip.dx, dy: tip.dy,                    // ABSOLUTE aim vector (not tilt-compensated)
    w: r / Math.max(cam.zoom, 1e-4),           // one tank-radius in WORLD units
    age: 0, life: 0.62,                        // fire ~0.16s, smoke rides out the rest
    seed: Math.random() * 1000,
  });
  S.flash = Math.min(0.5, S.flash + 0.05);     // the blast lights the scene
  S.shake = Math.min(8, S.shake + 2.2);        // ~0.07s of kick
}

// ---------------------------------------------------------------------------
// HD muzzle blast. A flame lance along the bore — hot-white core into yellow
// into orange into smoke — plus star spikes and the slotted brake's side jets.
// Every shape is a polygon or a gradient; there is not one ctx.arc in here.
// Drawn in SCREEN space, so it uses the entry's absolute dx/dy, never cosA/sinA.
// ---------------------------------------------------------------------------
const MZ_FLAME = 0.155;                     // seconds of visible fire
const MZ_SPIKES = [                         // [angle off bore, length x, half-width x]
  [0, 1.34, 0.075], [0.30, 0.70, 0.055], [-0.30, 0.70, 0.055],
  [0.66, 0.44, 0.045], [-0.66, 0.44, 0.045],
];

// Tapered spearhead along (dx,dy): quadratic curves only, so nothing reads round.
function mzLancePath(x, y, dx, dy, len, hw) {
  const nx = -dy, ny = dx;
  const p = (a, n) => [x + dx * a + nx * n, y + dy * a + ny * n];
  ctx.beginPath();
  ctx.moveTo(...p(-len * 0.12, 0));
  ctx.quadraticCurveTo(...p(len * 0.10, hw * 0.95), ...p(len * 0.40, hw));
  ctx.quadraticCurveTo(...p(len * 0.76, hw * 0.50), ...p(len, 0));
  ctx.quadraticCurveTo(...p(len * 0.76, -hw * 0.50), ...p(len * 0.40, -hw));
  ctx.quadraticCurveTo(...p(len * 0.10, -hw * 0.95), ...p(-len * 0.12, 0));
  ctx.closePath();
}
function mzLanceFill(x, y, dx, dy, len, hw, stops) {
  mzLancePath(x, y, dx, dy, len, hw);
  const g = ctx.createLinearGradient(x, y, x + dx * len, y + dy * len);
  for (const [p, c] of stops) g.addColorStop(p, c);
  ctx.fillStyle = g; ctx.fill();
}
function mzSpike(x, y, dx, dy, ang, len, hw, col) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const sx = dx * c - dy * s, sy = dx * s + dy * c;
  const px = -sy, py = sx;
  ctx.beginPath();
  ctx.moveTo(x + px * hw, y + py * hw);
  ctx.lineTo(x + sx * len, y + sy * len);
  ctx.lineTo(x - px * hw, y - py * hw);
  ctx.closePath();
  ctx.fillStyle = col; ctx.fill();
}
// Lumpy smoke puff — an irregular closed curve with a soft gradient fill, so it
// never reads as a disc.
function mzPuff(cx, cy, rad, seed, alpha) {
  if (alpha <= 0.01 || rad <= 0.5) return;
  const N = 8;
  const rAt = (th) => rad * (0.80 + 0.22 * Math.sin(th * 3 + seed) + 0.13 * Math.sin(th * 5 - seed * 1.7));
  ctx.beginPath();
  for (let k = 0; k <= N; k++) {
    const th = (k / N) * Math.PI * 2, r0 = rAt(th);
    const x = cx + Math.cos(th) * r0, y = cy + Math.sin(th) * r0;
    if (k === 0) { ctx.moveTo(x, y); continue; }
    const tm = ((k - 0.5) / N) * Math.PI * 2, rm = rAt(tm) * 1.10;
    ctx.quadraticCurveTo(cx + Math.cos(tm) * rm, cy + Math.sin(tm) * rm, x, y);
  }
  ctx.closePath();
  const g = ctx.createRadialGradient(cx, cy, rad * 0.10, cx, cy, rad * 1.05);
  g.addColorStop(0, `rgba(126,120,116,${0.40 * alpha})`);
  g.addColorStop(0.6, `rgba(96,91,88,${0.26 * alpha})`);
  g.addColorStop(1, 'rgba(70,66,64,0)');
  ctx.fillStyle = g; ctx.fill();
}

function drawMuzzleFlashes() {
  if (!S.muzzle.length) return;
  ctx.save();
  for (const m of S.muzzle) {
    const ox = wx2s(m.x), oy = wy2s(m.y);
    const R = Math.max(6, m.w * cam.zoom);       // one tank-radius, in screen px
    const ax = m.dx, ay = m.dy;                  // along the bore
    const nx = -ay, ny = ax;                     // across the bore
    const at = (a, n) => [ox + ax * a + nx * n, oy + ay * a + ny * n];

    // -- Smoke first: it sits behind the fire and outlives it -----------------
    const st = Math.min(1, m.age / m.life);
    const sa = Math.pow(1 - st, 1.7) * Math.min(1, m.age / 0.045);
    if (sa > 0.01) {
      ctx.globalCompositeOperation = 'source-over';
      for (let k = 0; k < 3; k++) {
        const d = R * (0.9 + k * 1.25) * (0.4 + st * 1.6);
        const [cx, cy] = at(d, (k - 1) * R * 0.38 * (0.5 + st));
        mzPuff(cx, cy - R * st * (0.7 + k * 0.3),
               R * (0.8 + k * 0.3) * (0.5 + st * 1.5),
               m.seed + k * 2.7, sa * (0.9 - k * 0.2));
      }
    }

    // -- Fire -----------------------------------------------------------------
    const ft = m.age / MZ_FLAME;
    if (ft < 1) {
      const g = Math.pow(ft, 0.38);              // punches out fast, then holds
      const a = Math.pow(1 - ft, 1.25);          // and dies quickly
      const len = R * (1.8 + 2.0 * g);
      const hw = R * (0.55 + 0.50 * g);
      ctx.globalCompositeOperation = 'lighter';  // overlaps burn to white

      for (const [sang, lf, wf] of MZ_SPIKES) {
        mzSpike(ox, oy, ax, ay, sang, len * lf, R * wf * (0.6 + 0.4 * a),
                `rgba(255,241,196,${0.42 * a})`);
      }
      // Brake side jets — this gun has a slotted muzzle brake, gas vents sideways
      for (const s of [1, -1]) {
        const sang = s * 1.62, c = Math.cos(sang), si = Math.sin(sang);
        const jx = ax * c - ay * si, jy = ax * si + ay * c;
        mzLanceFill(ox - ax * R * 0.30, oy - ay * R * 0.30, jx, jy, len * 0.42, hw * 0.85, [
          [0, `rgba(255,238,190,${0.55 * a})`],
          [0.5, `rgba(255,164,52,${0.34 * a})`],
          [1, 'rgba(220,80,16,0)'],
        ]);
      }
      // Outer orange body
      mzLanceFill(ox, oy, ax, ay, len, hw, [
        [0, `rgba(255,252,226,${0.90 * a})`],
        [0.22, `rgba(255,206,92,${0.82 * a})`],
        [0.58, `rgba(255,134,28,${0.55 * a})`],
        [1, 'rgba(190,52,10,0)'],
      ]);
      // Inner white-hot core
      mzLanceFill(ox, oy, ax, ay, len * 0.52, hw * 0.44, [
        [0, `rgba(255,255,255,${0.98 * a})`],
        [0.55, `rgba(255,250,222,${0.75 * a})`],
        [1, 'rgba(255,214,120,0)'],
      ]);
      // Soft bloom at the bore. Radial gradient fading to alpha 0 inside a rect —
      // there is no rim, so it reads as glare, not as a circle.
      const bl = R * (1.5 + 0.9 * g);
      const bg = ctx.createRadialGradient(ox, oy, 0, ox, oy, bl);
      bg.addColorStop(0, `rgba(255,255,246,${0.62 * a})`);
      bg.addColorStop(0.45, `rgba(255,196,92,${0.30 * a})`);
      bg.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = bg;
      ctx.fillRect(ox - bl, oy - bl, bl * 2, bl * 2);
    }
  }
  ctx.restore();                                 // restores composite + fillStyle
}

// ---------------------------------------------------------------------------
// Air Strike delivery aircraft.
//
// PURELY COSMETIC and PURELY DERIVED. The server already sends five bombs with
// authoritative paths; the plane is reconstructed from them and decides nothing.
// It works because every bomb shares identical vertical motion (spawn y -400,
// vy 120, same g), so they all cross any altitude at the same flight time — which
// makes the release points exactly collinear in (elapsed, x). A constant-velocity
// aircraft therefore passes through every bomb bay release on the exact frame.
//
// House style, per drawMuzzleFlashes: own state (S.plane), own step (stepPlane),
// own draw pass (drawPlane). Polygons, quadratics and gradients only — there is
// not one ctx.arc in here.
// ---------------------------------------------------------------------------
const PLANE_RUNIN = 60;      // elapsed points of run-in before the first release
const PLANE_RUNIN_K = 2.4;   // run-in covers K x cruise distance, easing onto the run
const PLANE_CLEAR = 1200;    // world units the plane must clear the highest impact by
const PLANE_TRAIL = 26;      // contrail samples kept
const PLANE_BODY = '#2b323c', PLANE_LITE = '#48525f', PLANE_DARK = '#1b2028';
const PLANE_GLASS = '#8fd4ff';

// First fractional path index at which a path descends past world-y `py`.
// null when it never does (an edge-clamped bomb that flies straight off the map).
function crossIndex(path, py) {
  for (let i = 1; i < path.length; i++) {
    const y0 = path[i - 1][1], y1 = path[i][1];
    if (y0 < py && y1 >= py) return (i - 1) + (py - y0) / Math.max(1e-6, y1 - y0);
  }
  return null;
}
function pathXAt(path, idx) {
  const i = Math.floor(idx), f = idx - i;
  if (i >= path.length - 1) return path[path.length - 1][0];
  return path[i][0] * (1 - f) + path[i + 1][0] * f;
}

// Called once per shot from startNextShot(). No-op unless this shot is an Air Strike.
function armAirstrike(A, m) {
  if (m.weapon !== 'airstrike') return;
  const bombs = A.projectiles.filter(p => !p.beacon && p.path && p.path.length > 1);
  if (!bombs.length) return;                      // beacon missed — nothing is coming
  const beacon = A.projectiles.find(p => p.beacon);

  // Slow motion starts as the beacon lands and holds for the whole bomb run.
  A.strike = { slowAt: beacon ? beacon.path.length - 1 : 0 };

  // Altitude: high in the CURRENT frame, but always clear of the highest bomb
  // impact so every bomb is guaranteed to cross it (the crossing IS the release).
  const viewH = view.cssH / Math.max(cam.zoom, 1e-4);
  let top = Infinity;
  for (const b of bombs) top = Math.min(top, b.path[b.path.length - 1][1]);
  let py = cam.cy - viewH * 0.35;                 // ~15% down from the top of the view
  py = Math.min(py, top - PLANE_CLEAR);
  py = Math.max(py, -300);                        // bombs spawn at y -400; stay below it

  // Release events. Skipping each bomb forward to the release index deletes the
  // 100+ points of fall that happen above the top of the screen; the bomb still
  // becomes visible at exactly its original delay, right under the aircraft.
  const rel = [];
  for (const b of bombs) {
    const idx = crossIndex(b.path, py);
    if (idx == null) continue;                    // never reaches altitude — leave it alone
    const at = b.delay;                           // its ORIGINAL delay = its release moment
    b.from = idx;
    b.delay = at - idx;                           // so pos == idx when elapsed == at
    rel.push({ e: at, x: pathXAt(b.path, idx) });
  }
  if (rel.length < 1) return;
  rel.sort((p, q) => p.e - q.e);

  const first = rel[0], last = rel[rel.length - 1];
  const span = last.e - first.e;
  // World units per elapsed point along the drop line — EXACT, so every bomb
  // leaves the bay. Degenerate sticks (map-edge clamped spawns) get a sane default.
  let v = span > 0.5 ? (last.x - first.x) / span : 0;
  if (!Number.isFinite(v) || Math.abs(v) < 1) v = (m.by != null && S.tanks[m.by] && last.x < S.tanks[m.by].x) ? -23 : 23;

  S.plane = {
    y: py, v, dir: v >= 0 ? 1 : -1,
    x0: first.x, e0: first.e, eEnd: last.e,
    born: first.e - PLANE_RUNIN,
    e: 0, life: 0, alpha: 0, x: 0,
    seed: Math.random() * 6.283,
    drops: rel.map(r => ({ e: r.e, done: false })),
    trail: [],
  };
  S.plane.x = planeX(S.plane, S.plane.born);
  Audio.plane(((last.e - first.e) + PLANE_RUNIN * 2.5) / STRIKE_RATE);
}

// Position along the run. Past e0 it is exactly the drop line. Before e0 it eases
// out of a faster approach into that line, so the plane settles onto its bomb run
// instead of materialising at cruise speed.
function planeX(P, e) {
  const d = e - P.e0;
  if (d >= 0) return P.x0 + P.v * d;
  const u = Math.min(1, -d / PLANE_RUNIN);
  return P.x0 - P.v * PLANE_RUNIN * (u + (PLANE_RUNIN_K - 1) * u * u);
}

function stepPlane(dt) {
  const P = S.plane; if (!P) return;
  // Rides the SHOT clock while the shot plays, so releases land on the exact
  // frame each bomb appears; coasts out on its own once the shot is resolved.
  P.e = S.anim ? S.anim.elapsed : P.e + STRIKE_RATE * dt;
  if (P.e < P.born) { P.alpha = 0; P.x = planeX(P, P.born); return; }
  P.life += dt;
  P.x = planeX(P, P.e);

  // Fades up out of the altitude haze, and away once the stick is gone. If the
  // run-in happens to start beyond the view edge the fade is simply invisible.
  const outFor = P.e - (P.eEnd + PLANE_RUNIN * 0.8);
  P.alpha = Math.min(1, P.life / 0.35) *
            (outFor > 0 ? Math.max(0, 1 - outFor / (PLANE_RUNIN * 0.7)) : 1);

  const step = 10 / Math.max(cam.zoom, 1e-4);     // one contrail sample per ~10 css px
  const tail = P.trail[P.trail.length - 1];
  if (!tail || Math.abs(P.x - tail[0]) > step) {
    P.trail.push([P.x, P.y]);
    if (P.trail.length > PLANE_TRAIL) P.trail.shift();
  }

  // Bomb-bay cues, fired on the exact frame each bomb becomes visible. Sparks
  // only — shape:'spark' is the sanctioned front-layer primitive, never a disc.
  for (const d of P.drops) {
    if (d.done || P.e < d.e) continue;
    d.done = true;
    Audio.whistle();
    for (let k = 0; k < 4; k++) {
      S.particles.push({
        x: P.x + (Math.random() - 0.5) * 60, y: P.y + 26,
        vx: (Math.random() - 0.5) * 180 + P.v * 8,
        vy: 40 + Math.random() * 130,
        life: 0.3, age: 0, r: 1.8, g: 0.15, shape: 'spark', color: '#dfe9f5',
      });
    }
  }
  if (P.alpha <= 0 && P.life > 1) S.plane = null;
}

// One "plane unit" in css px. Small: it is high up, and a compact silhouette
// reads as flying far better than a big one at this ground speed.
function planeUnit() { return Math.max(4, Math.min(8, 130 * cam.zoom)); }

function planePoly(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
  ctx.closePath(); ctx.fill();
}

// Twin vapour ribbons built from straight quads — no round caps anywhere.
function drawContrail(P, u) {
  const T = P.trail, n = T.length; if (n < 3) return;
  ctx.fillStyle = 'rgb(238,246,255)';
  for (const off of [-0.42, 0.42]) {
    for (let k = 1; k < n; k++) {
      const f0 = (k - 1) / (n - 1), f1 = k / (n - 1);      // 0 = oldest, 1 = at the plane
      const a = Math.pow(f1, 1.6) * 0.30;
      if (a < 0.012) continue;
      const x0 = wx2s(T[k - 1][0]), x1 = wx2s(T[k][0]);
      const y0 = wy2s(T[k - 1][1]) + off * u * (1.7 - f0);
      const y1 = wy2s(T[k][1]) + off * u * (1.7 - f1);
      const h0 = u * (0.09 + 0.24 * (1 - f0)), h1 = u * (0.09 + 0.24 * (1 - f1));
      ctx.globalAlpha = P.alpha * a;
      ctx.beginPath();
      ctx.moveTo(x0, y0 - h0); ctx.lineTo(x1, y1 - h1);
      ctx.lineTo(x1, y1 + h1); ctx.lineTo(x0, y0 + h0);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.globalAlpha = P.alpha;
}

// Swept-wing attack jet, side on, nose at local +x. Far surfaces first so the
// fuselage overlaps them, then near surfaces on top: reads solid at 38 px long.
function drawPlaneBody(u, P) {
  const U = (a, b) => [a * u, b * u];
  // far wing + far tailplane (behind the body)
  ctx.fillStyle = PLANE_DARK;
  planePoly([U(0.95, -0.12), U(-1.55, -1.50), U(-2.25, -1.44), U(-0.55, -0.02)]);
  planePoly([U(-2.35, -0.05), U(-3.25, -0.60), U(-3.48, -0.55), U(-2.85, -0.02)]);
  // fuselage: one closed curve, nose to tail
  ctx.beginPath();
  ctx.moveTo(...U(3.40, 0));
  ctx.quadraticCurveTo(...U(1.30, -0.62), ...U(-1.60, -0.52));
  ctx.lineTo(...U(-3.00, -0.30));
  ctx.lineTo(...U(-3.00, 0.30));
  ctx.lineTo(...U(-1.60, 0.50));
  ctx.quadraticCurveTo(...U(1.30, 0.64), ...U(3.40, 0));
  ctx.closePath();
  const gf = ctx.createLinearGradient(0, -0.7 * u, 0, 0.7 * u);
  gf.addColorStop(0, PLANE_LITE);
  gf.addColorStop(0.45, PLANE_BODY);
  gf.addColorStop(1, PLANE_DARK);
  ctx.fillStyle = gf; ctx.fill();
  // tail fin
  ctx.fillStyle = PLANE_BODY;
  planePoly([U(-2.05, -0.28), U(-3.05, -1.40), U(-3.40, -1.36), U(-2.72, -0.26)]);
  // near wing + near tailplane
  ctx.fillStyle = PLANE_LITE;
  planePoly([U(1.05, 0.10), U(-1.45, 1.58), U(-2.20, 1.52), U(-0.45, 0.14)]);
  planePoly([U(-2.35, 0.06), U(-3.28, 0.66), U(-3.50, 0.61), U(-2.85, 0.04)]);
  // canopy — a faceted bubble with a glint, never a disc
  ctx.beginPath();
  ctx.moveTo(...U(2.42, -0.30));
  ctx.quadraticCurveTo(...U(1.95, -0.74), ...U(1.20, -0.60));
  ctx.lineTo(...U(1.48, -0.26));
  ctx.closePath();
  const gc = ctx.createLinearGradient(1.2 * u, -0.74 * u, 2.42 * u, -0.20 * u);
  gc.addColorStop(0, 'rgba(255,255,255,0.92)');
  gc.addColorStop(0.55, PLANE_GLASS);
  gc.addColorStop(1, 'rgba(60,110,150,0.9)');
  ctx.fillStyle = gc; ctx.fill();
  // exhaust — the muzzle-blast lance, reused verbatim. Gradient, no rim, no arc.
  const fl = 1.0 + 0.5 * (0.5 + 0.5 * Math.sin(P.e * 1.7 + P.seed * 3.1));
  ctx.globalCompositeOperation = 'lighter';
  mzLanceFill(-3.0 * u, 0.04 * u, -1, 0, u * 2.4 * fl, u * 0.24, [
    [0, 'rgba(255,247,214,0.85)'],
    [0.30, 'rgba(140,205,255,0.55)'],
    [0.70, 'rgba(84,150,255,0.24)'],
    [1, 'rgba(40,80,200,0)'],
  ]);
  ctx.globalCompositeOperation = 'source-over';
}

function drawPlane() {
  const P = S.plane; if (!P || P.alpha <= 0.01) return;
  const u = planeUnit();
  ctx.save();
  ctx.globalAlpha = P.alpha;
  drawContrail(P, u);                     // always: it trails off-screen behind the plane
  const sx = wx2s(P.x), sy = wy2s(P.y);
  if (sx > -24 * u && sx < view.cssW + 24 * u && sy > -24 * u && sy < view.cssH + 24 * u) {
    ctx.translate(sx, sy);
    ctx.scale(P.dir, 1);                                       // nose points along travel
    ctx.rotate(Math.sin(P.e * 0.09 + P.seed) * 0.025);         // lazy bob at altitude
    drawPlaneBody(u, P);
  }
  ctx.restore();
}

// Thin indestructible lava floor at the very bottom of the map. Drawn over the
// terrain fill so it shows through anything blasted down to it.
// ---- Golf cup + flag ------------------------------------------------------------
function drawGolfCup() {
  const g = S.golf; if (!g || !g.cup) return;
  const sx = wx2s(g.cup.x);
  if (sx < -60 || sx > view.cssW + 60) return;
  const gy = wy2s(surfaceAt(g.cup.x));
  const u = Math.max(9, Math.min(20, 260 * cam.zoom));
  // cup shadow (the notch itself is carved into the terrain server-side)
  ctx.fillStyle = 'rgba(10,12,16,0.55)';
  ctx.fillRect(sx - u * 0.5, gy - u * 0.12, u, u * 0.3);
  // pole
  ctx.fillStyle = '#e8ecf2';
  ctx.fillRect(sx - Math.max(1, u * 0.07), gy - u * 4.6, Math.max(2, u * 0.14), u * 4.6);
  // flag (waves gently)
  const wob = Math.sin(performance.now() / 420) * u * 0.14;
  ctx.fillStyle = '#ff3b30';
  ctx.beginPath();
  ctx.moveTo(sx + u * 0.07, gy - u * 4.55);
  ctx.lineTo(sx + u * 1.7 + wob, gy - u * 4.05);
  ctx.lineTo(sx + u * 0.07, gy - u * 3.55);
  ctx.closePath(); ctx.fill();
  // capture ring: the rest radius that counts as holed
  const rr = g.cup.r * cam.zoom;
  ctx.strokeStyle = 'rgba(182,255,90,0.4)'; ctx.lineWidth = Math.max(1, u * 0.1);
  ctx.setLineDash([6, 7]);
  ctx.beginPath(); ctx.moveTo(sx - rr, gy + u * 0.35); ctx.lineTo(sx + rr, gy + u * 0.35); ctx.stroke();
  ctx.setLineDash([]);
}

// ---- Battlefield props --------------------------------------------------------
// Fuel barrels (one blast cooks them off, and they cook each other off) and
// concrete bunkers whose raised deck is the cover. Everything is rects/polygons.
function drawProps() {
  if (!S.props || !S.props.length) return;
  for (const p of S.props) {
    if (p.alive === false) continue;
    const sx = wx2s(p.x);
    if (sx < -80 || sx > view.cssW + 80) continue;
    if (p.kind === 'barrel') {
      const gy = wy2s(surfaceAt(p.x));
      const u = Math.max(7, Math.min(15, 230 * cam.zoom));       // drum half-width px
      const hgt = u * 2.5;
      ctx.fillStyle = '#b8352c';
      ctx.fillRect(sx - u, gy - hgt, u * 2, hgt);
      ctx.fillStyle = '#8f2019';                                  // shadow side
      ctx.fillRect(sx + u * 0.25, gy - hgt, u * 0.75, hgt);
      ctx.fillStyle = '#5c120e';                                  // rims
      ctx.fillRect(sx - u, gy - hgt, u * 2, Math.max(1, u * 0.22));
      ctx.fillRect(sx - u, gy - hgt * 0.55, u * 2, Math.max(1, u * 0.18));
      ctx.fillRect(sx - u, gy - Math.max(1, u * 0.22), u * 2, Math.max(1, u * 0.22));
      ctx.fillStyle = '#ffd23f';                                  // hazard diamond
      const d = u * 0.55, cy2 = gy - hgt * 0.78;
      ctx.beginPath(); ctx.moveTo(sx, cy2 - d); ctx.lineTo(sx + d, cy2); ctx.lineTo(sx, cy2 + d); ctx.lineTo(sx - d, cy2); ctx.closePath(); ctx.fill();
    } else if (p.kind === 'bunker') {
      const deckY = wy2s(p.deck);
      const x0 = wx2s(p.x - p.w), x1 = wx2s(p.x + p.w);
      const u = Math.max(6, Math.min(14, 230 * cam.zoom));
      // Parapet lip along the deck edge + a casemate block with a firing slit.
      ctx.fillStyle = '#9aa4ac';
      ctx.fillRect(x0, deckY - u * 0.5, x1 - x0, u * 0.5);
      ctx.fillStyle = '#7b858d';
      ctx.fillRect(sx - u * 2.4, deckY - u * 2.2, u * 4.8, u * 1.8);
      ctx.fillStyle = '#20262b';
      ctx.fillRect(sx - u * 1.7, deckY - u * 1.7, u * 3.4, Math.max(1, u * 0.5));
      if (p.hp < 40) {                                           // battle damage cracks
        ctx.strokeStyle = '#39424a'; ctx.lineWidth = Math.max(1, u * 0.14);
        ctx.beginPath();
        ctx.moveTo(sx - u, deckY - u * 2.1); ctx.lineTo(sx - u * 0.4, deckY - u * 1.2); ctx.lineTo(sx - u * 0.9, deckY - u * 0.5);
        ctx.moveTo(sx + u * 1.3, deckY - u * 2.0); ctx.lineTo(sx + u * 0.8, deckY - u * 1.0);
        ctx.stroke();
      }
    }
  }
}

// ---- Supply crates --------------------------------------------------------------
function drawCrates() {
  if (!S.crates || !S.crates.length) return;
  const KIND_COL = { railgun: '#3ce88f', ammo: '#ffd23f', shield: '#54c8ff', repair: '#b6ff5a' };
  for (const c of S.crates) {
    const t = c.dropT ?? 1;
    const ease = 1 - Math.pow(1 - t, 2.2);                       // decelerating fall
    const wy = c.y - (1 - ease) * 3600;
    const sx = wx2s(c.x), sy = wy2s(wy);
    if (sx < -90 || sx > view.cssW + 90) continue;
    const u = Math.max(8, Math.min(17, 250 * cam.zoom));         // crate half-size px
    if (t < 1) {                                                 // parachute canopy + lines
      const cw = u * 3.1, ch = u * 2.0, cy2 = sy - u * 2.1 - ch;
      ctx.fillStyle = '#e8e2d2';
      ctx.beginPath();
      ctx.moveTo(sx - cw, cy2 + ch);
      ctx.quadraticCurveTo(sx, cy2 - ch * 0.55, sx + cw, cy2 + ch);
      ctx.lineTo(sx + cw * 0.62, cy2 + ch * 0.72);
      ctx.quadraticCurveTo(sx, cy2 + ch * 0.10, sx - cw * 0.62, cy2 + ch * 0.72);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(230,225,210,0.9)'; ctx.lineWidth = Math.max(1, u * 0.1);
      ctx.beginPath();
      ctx.moveTo(sx - cw, cy2 + ch); ctx.lineTo(sx - u * 0.8, sy - u);
      ctx.moveTo(sx + cw, cy2 + ch); ctx.lineTo(sx + u * 0.8, sy - u);
      ctx.moveTo(sx, cy2 + ch * 0.8); ctx.lineTo(sx, sy - u);
      ctx.stroke();
    }
    // The box: olive drab with a kind-coloured band and star stencil.
    ctx.fillStyle = '#6b6234';
    ctx.fillRect(sx - u, sy - u * 2, u * 2, u * 2);
    ctx.fillStyle = '#524a24';
    ctx.fillRect(sx + u * 0.3, sy - u * 2, u * 0.7, u * 2);
    ctx.fillStyle = KIND_COL[c.kind] || '#ffd23f';
    ctx.fillRect(sx - u, sy - u * 1.25, u * 2, Math.max(2, u * 0.5));
    ctx.fillStyle = '#2c2a18';
    ctx.fillRect(sx - u, sy - u * 2, u * 2, Math.max(1, u * 0.16));
    // Ground marker once landed so a distant crate is spottable.
    if (t >= 1) {
      const gy = wy2s(surfaceAt(c.x));
      ctx.fillStyle = 'rgba(255,210,63,0.5)';
      ctx.beginPath();
      ctx.moveTo(sx, gy - u * 3.4); ctx.lineTo(sx + u * 0.55, gy - u * 2.5); ctx.lineTo(sx - u * 0.55, gy - u * 2.5);
      ctx.closePath(); ctx.fill();
    }
  }
}

// ---- Crate shield -----------------------------------------------------------
// An angular hex cocoon — polygons only, pulsing gently so it reads as active.
function drawShieldAura(i) {
  const t = S.tanks[i]; if (!t) return;
  const { sx, sy, r } = tankScreen(i);
  const R = r * 2.5 + Math.sin(performance.now() / 300) * r * 0.12;
  ctx.save();
  ctx.strokeStyle = 'rgba(84,200,255,0.75)'; ctx.lineWidth = Math.max(1.5, r * 0.14);
  ctx.fillStyle = 'rgba(84,200,255,0.08)';
  ctx.beginPath();
  for (let k = 0; k <= 6; k++) {
    const a = -Math.PI / 2 + (k / 6) * Math.PI * 2;
    const px = sx + Math.cos(a) * R, py = sy - r * 0.6 + Math.sin(a) * R * 0.86;
    k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawLava(w, h) {
  const lavaY = S.lavaY || (WH() - 300);
  const top = wy2s(lavaY);
  if (top > h) return;                     // lava is off the bottom of the view
  const y0 = Math.max(0, top);
  const g = ctx.createLinearGradient(0, y0, 0, h);
  g.addColorStop(0, '#ffd24a');
  g.addColorStop(0.18, '#ff8a1e');
  g.addColorStop(0.6, '#e0350c');
  g.addColorStop(1, '#7d1405');
  ctx.fillStyle = g;
  ctx.fillRect(0, y0, w, h - y0);
  // molten shimmer along the surface
  const t = performance.now() / 620;
  ctx.fillStyle = 'rgba(255,236,150,0.75)';
  for (let sx = 0; sx < w; sx += 12) {
    const bob = Math.sin(t + sx * 0.05) * 2.2 + Math.sin(t * 1.7 + sx * 0.013) * 1.6;
    ctx.fillRect(sx, y0 + bob - 1.5, 12, 3);
  }
  ctx.fillStyle = 'rgba(255,120,30,0.30)';
  ctx.fillRect(0, Math.max(0, y0 - 10), w, 10);   // heat glow above the surface
}

function drawTank(i) {
  if (!S.tanks[i]) return;
  const { sx, sy, r } = tankScreen(i);
  const front = facingOf(i);
  const sk = SKINS[S.skins[i]] || SKINS[SEAT_SKIN[i % SEAT_SKIN.length]];
  // Seat accent (pennant/turret band). SEAT_COLORS[0..1] are the exact old duel
  // colours, so a 2-player match renders identically — this only gives seats 2
  // and 3 their own colour instead of both drawing as seat 1. No geometry change.
  const P = { lite: sk.lite, mid: sk.mid, dark: sk.dark, accent: seatColor(i) };
  const steel = '#9aa1ad', steelDk = '#565d68';
  const hp = S.hp[i];

  if (S.playing && S.turn === i && !S.anim) {
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    const by = sy - r * 3.6 - 6 + Math.sin(performance.now() / 260) * 3;
    ctx.beginPath(); ctx.moveTo(sx, by + 9); ctx.lineTo(sx - 7, by); ctx.lineTo(sx + 7, by); ctx.closePath(); ctx.fill();
  }

  // Tilt the tank to sit flush on the terrain slope, and lift it so the tracks
  // rest ON the surface instead of sinking into the mountain.
  const tilt = tankTilt(i, r);        // terrain slope + drive lean / settle rock
  const LIFT = r * 0.42;

  ctx.fillStyle = 'rgba(0,0,0,.32)';
  ctx.beginPath(); ctx.ellipse(sx, sy, r * 1.5, r * 0.32, tilt, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.translate(sx, sy); ctx.rotate(tilt); ctx.translate(-sx, -sy - LIFT);

  // ── "Clean Sweep": low dark-grey wedge hull, skirted running gear ────────
  // Tracks + road wheels
  ctx.fillStyle = TANK_G.track;
  roundedRect(sx - r * 1.33, sy - r * 0.06, r * 2.66, r * 0.58, r * 0.26); ctx.fill();
  ctx.fillStyle = TANK_G.wheel;
  for (let k = 0; k < 6; k++) {
    const wx = sx - r * 1.04 + (k / 5) * r * 2.08;
    ctx.beginPath(); ctx.arc(wx, sy + r * 0.24, r * 0.155, 0, Math.PI * 2); ctx.fill();
  }
  // Side skirt with panel breaks
  ctx.fillStyle = TANK_G.skirt;
  ctx.fillRect(sx - r * 1.26, sy - r * 0.20, r * 2.52, r * 0.30);
  ctx.fillStyle = TANK_G.skirtDk;
  for (let k = 0; k < 3; k++) ctx.fillRect(sx - r * 0.96 + k * r * 0.66, sy - r * 0.15, r * 0.46, r * 0.17);

  // Low wedge hull
  const hullPath = () => {
    ctx.beginPath();
    ctx.moveTo(sx - r * 1.35, sy - r * 0.18);
    ctx.lineTo(sx - r * 0.99, sy - r * 0.58);
    ctx.lineTo(sx + r * 0.99, sy - r * 0.58);
    ctx.lineTo(sx + r * 1.35, sy - r * 0.18);
    ctx.closePath();
  };
  ctx.fillStyle = TANK_G.hull; hullPath(); ctx.fill();
  ctx.fillStyle = TANK_G.hullLite;                     // lighter rear quarter
  ctx.beginPath();
  ctx.moveTo(sx - front * r * 1.35, sy - r * 0.18);
  ctx.lineTo(sx - front * r * 0.99, sy - r * 0.58);
  ctx.lineTo(sx - front * r * 0.16, sy - r * 0.58);
  ctx.lineTo(sx - front * r * 0.29, sy - r * 0.18);
  ctx.closePath(); ctx.fill();

  // Low flat turret
  const tb = sy - r * 0.58;
  ctx.fillStyle = TANK_G.turret;
  ctx.beginPath();
  ctx.moveTo(sx - front * r * 0.76, tb);
  ctx.lineTo(sx - front * r * 0.52, tb - r * 0.36);
  ctx.lineTo(sx + front * r * 0.41, tb - r * 0.36);
  ctx.lineTo(sx + front * r * 0.65, tb);
  ctx.closePath(); ctx.fill();
  // Player paint reads as a turret band so the two tanks stay tellable apart
  ctx.fillStyle = P.mid;
  ctx.fillRect(sx - front * r * 0.50, tb - r * 0.30, r * 0.84, r * 0.10);
  ctx.fillStyle = TANK_G.hatch;                        // commander hatch
  roundedRect(sx - front * r * 0.34, tb - r * 0.49, r * 0.30, r * 0.13, r * 0.05); ctx.fill();

  if (hp < 70) {
    ctx.fillStyle = `rgba(10,11,14,${Math.min(0.55, (70 - hp) / 110)})`;
    hullPath(); ctx.fill();
  }

  // Whip antenna + player pennant
  const antX = sx - front * r * 0.66, antTop = tb - r * 1.02;
  ctx.strokeStyle = 'rgba(220,228,240,.55)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(antX, tb - r * 0.3); ctx.lineTo(antX, antTop); ctx.stroke();
  ctx.fillStyle = P.accent;
  ctx.beginPath();
  ctx.moveTo(antX, antTop);
  ctx.lineTo(antX + front * r * 0.30, antTop + r * 0.10);
  ctx.lineTo(antX, antTop + r * 0.20);
  ctx.closePath(); ctx.fill();

  const aim = S.aim[i] || { angle: 45, power: 60 }; const dir = front;
  const rad = aim.angle * Math.PI / 180;
  const px = sx + front * r * BARREL.ox, py = sy + r * BARREL.oy;
  // Barrel aims at the ABSOLUTE angle regardless of body tilt — rotate the aim
  // vector by −tilt so the surrounding +tilt context cancels out.
  const wcos = Math.cos(rad) * dir, wsin = -Math.sin(rad);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const cosA = wcos * ct + wsin * st, sinA = -wcos * st + wsin * ct;
  const bLen = r * BARREL.len;
  // Recoil: the gun tube telescopes BACK INTO the mantlet — the base stays put
  // and the DRAWN length shortens, then runs back out to battery. At rest
  // (S.recoil = 0) bLenR === bLen and bx,by === px,py, so the tank renders
  // exactly as before.
  const rc = S.recoil[i] || 0;
  const bLenR = Math.max(r * 0.78, bLen - r * REC_MAX * recAmt(i));
  const bx = px, by = py;                            // mantlet mouth — fixed
  const nx = -sinA, ny = cosA;                       // perpendicular to the barrel

  ctx.lineCap = 'butt';
  ctx.fillStyle = TANK_G.mantlet;                    // mantlet collar
  ctx.beginPath(); ctx.arc(bx, by, r * 0.23, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = TANK_G.barrel; ctx.lineWidth = Math.max(3, r * 0.30);
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + cosA * bLenR, by + sinA * bLenR); ctx.stroke();
  ctx.strokeStyle = TANK_G.barrelLite; ctx.lineWidth = Math.max(1, r * 0.07);
  ctx.beginPath();
  ctx.moveTo(bx + cosA * r * 0.18 + nx * r * 0.08, by + sinA * r * 0.18 + ny * r * 0.08);
  ctx.lineTo(bx + cosA * bLenR * 0.94 + nx * r * 0.08, by + sinA * bLenR * 0.94 + ny * r * 0.08);
  ctx.stroke();
  // Shadowed gap at the mantlet mouth where the tube has run in. Alpha is 0 at
  // rest, so the resting silhouette is untouched.
  if (rc > 0.002) {
    ctx.strokeStyle = `rgba(12,14,18,${0.55 * rc})`;
    ctx.lineWidth = Math.max(2, r * 0.30);
    ctx.beginPath();
    ctx.moveTo(bx + cosA * r * 0.16, by + sinA * r * 0.16);
    ctx.lineTo(bx + cosA * r * 0.34, by + sinA * r * 0.34);
    ctx.stroke();
  }
  // Chunky slotted muzzle brake on the end
  const mb = r * BARREL.brake;
  ctx.strokeStyle = TANK_G.brake; ctx.lineWidth = Math.max(4, r * 0.46);
  ctx.beginPath();
  ctx.moveTo(bx + cosA * (bLenR - r * 0.02), by + sinA * (bLenR - r * 0.02));
  ctx.lineTo(bx + cosA * (bLenR + mb), by + sinA * (bLenR + mb));
  ctx.stroke();
  ctx.strokeStyle = TANK_G.brakeSlot; ctx.lineWidth = Math.max(1, r * 0.05);
  for (const f of [0.30, 0.66]) {
    const d = bLenR + mb * f;
    ctx.beginPath();
    ctx.moveTo(bx + cosA * d + nx * r * 0.22, by + sinA * d + ny * r * 0.22);
    ctx.lineTo(bx + cosA * d - nx * r * 0.22, by + sinA * d - ny * r * 0.22);
    ctx.stroke();
  }
  ctx.restore();
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
  if (S.killcam && S.killcam.mix > 0.02) return;   // no reticle over the killcam
  // Your own tank is mid-warp — the reticle would snap to the new x the moment
  // applyResolve lands. Hide it until the tank has materialised.
  if (S.warp && S.warp.seat === S.you && S.warp.t < S.warp.dur) return;
  const t = S.tanks[S.you]; const aim = myAim(); const dir = facingOf(S.you);
  const rad = aim.angle * Math.PI / 180;
  const sx = wx2s(t.x), sy = wy2s(surfaceAt(t.x) - 24);
  const pct = aim.power / 100;
  // Mirrors game-core's muzzle origin (BARREL_PIVOT_X 113, TANK_CY 274,
  // BARREL_LEN 410 — the drawn barrel tip). If the muzzle is at or under the
  // local surface the shell detonates in your own lap, so warn in red.
  const mox = t.x + dir * 113 + Math.cos(rad) * dir * 410;
  const moy = (t.y - 274) - Math.sin(rad) * 410;
  const danger = moy >= surfaceAt(mox) - 8;

  const len = 30 + pct * 130;
  const ex = sx + Math.cos(rad) * dir * len, ey = sy - Math.sin(rad) * len;
  ctx.save();
  ctx.setLineDash([5, 6]); ctx.lineWidth = 2;
  ctx.strokeStyle = danger ? 'rgba(255,90,82,.95)' : 'rgba(255,210,63,.9)';
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = danger ? 'rgba(255,90,82,.95)' : 'rgba(255,210,63,.95)';
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

// ---------------------------------------------------------------------------
// IN-FLIGHT ORDNANCE
// Every weapon flies its own round. Each sprite is drawn in a LOCAL frame:
// origin at the middle of the round, +x along the velocity vector (so it always
// points where it is going), +y "down" relative to the round. Polygons, rects
// and linear gradients ONLY — there is not one ctx.arc in here, so a round in
// front of a tank can never read as a blob (same house rule as drawParticles
// and drawMuzzleFlashes). R = half-length of the round in screen px.
// ---------------------------------------------------------------------------
function oRect(xa, xb, h, f) { ctx.fillStyle = f; ctx.fillRect(xa, -h, xb - xa, h * 2); }
function oPoly(f, ...p) {
  ctx.beginPath(); ctx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
  ctx.closePath(); ctx.fillStyle = f; ctx.fill();
}
// Cylinder + ogive nose: rear x0, shoulder x1, tip x2, half-height h.
function oOgive(x0, x1, x2, h, f) {
  ctx.beginPath();
  ctx.moveTo(x0, -h); ctx.lineTo(x1, -h);
  ctx.quadraticCurveTo(x1 + (x2 - x1) * 0.62, -h * 0.66, x2, 0);
  ctx.quadraticCurveTo(x1 + (x2 - x1) * 0.62,  h * 0.66, x1,  h);
  ctx.lineTo(x0, h); ctx.closePath();
  ctx.fillStyle = f; ctx.fill();
}
// Flared fin can — the flat side-on silhouette every bomb/mortar round has.
function oTail(x0, x1, h, f) { oPoly(f, x0, -h, x1, -h * 0.42, x1, h * 0.42, x0, h); }
// Tapered lance along +x (pass a negative len for an exhaust plume). Same
// spearhead trick as mzLanceFill, so plumes never read round.
function oLance(x0, len, h, stops) {
  ctx.beginPath();
  ctx.moveTo(x0, 0);
  ctx.quadraticCurveTo(x0 + len * 0.35, -h, x0 + len, 0);
  ctx.quadraticCurveTo(x0 + len * 0.35,  h, x0, 0);
  ctx.closePath();
  const g = ctx.createLinearGradient(x0, 0, x0 + len, 0);
  for (const [s, c] of stops) g.addColorStop(s, c);
  ctx.fillStyle = g; ctx.fill();
}

// One drawer per kind. `ph` is pr.pos (playback points) — a monotonic, RNG-free
// phase for the few sprites that pulse.
const ORD = {
  // A golf ball: white dimpled octagon — the one honest sphere in the arsenal.
  golfball(R) {
    ctx.fillStyle = '#f4f6f2';
    ctx.beginPath();
    for (let k = 0; k <= 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      const px = Math.cos(a) * 0.52 * R, py = Math.sin(a) * 0.52 * R;
      k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#c9cfd8';
    ctx.fillRect(-0.18 * R, -0.16 * R, 0.1 * R, 0.1 * R);
    ctx.fillRect(0.06 * R, 0.02 * R, 0.1 * R, 0.1 * R);
    ctx.fillRect(-0.05 * R, 0.2 * R, 0.1 * R, 0.1 * R);
  },
  // Steel HE shell: ogive nose, copper driving band, red ballistic cap.
  cannon(R) {
    oOgive(-1.05 * R, 0.25 * R, 1.25 * R, 0.40 * R, '#aab4c4');
    ctx.fillStyle = '#d7dfea'; ctx.fillRect(-1.05 * R, -0.40 * R, 1.30 * R, 0.20 * R);
    oRect(-0.88 * R, -0.60 * R, 0.44 * R, '#c98a4b');
    oRect(-1.18 * R, -1.05 * R, 0.34 * R, '#7c8698');
    oPoly('#ff5a52', 0.72 * R, -0.29 * R, 1.25 * R, 0, 0.72 * R, 0.29 * R);
  },
  // Heavy mortar bomb: fat olive body, big fin can, orange fuze.
  mortar(R) {
    oTail(-1.45 * R, -0.75 * R, 0.62 * R, '#3a4436');
    oRect(-1.48 * R, -1.20 * R, 0.86 * R, '#2f3a2b');
    oOgive(-0.80 * R, 0.10 * R, 1.15 * R, 0.54 * R, '#4d5a44');
    ctx.fillStyle = '#66755b'; ctx.fillRect(-0.80 * R, -0.54 * R, 0.90 * R, 0.24 * R);
    oRect(-0.58 * R, -0.34 * R, 0.58 * R, '#2f3a2b');
    oPoly('#ffb02e', 0.70 * R, -0.30 * R, 1.15 * R, 0, 0.70 * R, 0.30 * R);
  },
  // Rocket: slim tube, white nose cone, swept fins, live motor plume.
  volley(R) {
    oLance(-0.95 * R, -1.6 * R, 0.34 * R, [[0, 'rgba(255,236,190,.95)'], [0.45, 'rgba(255,150,60,.5)'], [1, 'rgba(255,90,40,0)']]);
    oPoly('#4a3fb0', -0.95 * R, -0.30 * R, -0.40 * R, -0.78 * R, -0.28 * R, -0.30 * R);
    oPoly('#4a3fb0', -0.95 * R,  0.30 * R, -0.40 * R,  0.78 * R, -0.28 * R,  0.30 * R);
    oRect(-0.95 * R, 0.55 * R, 0.30 * R, '#7c6cff');
    ctx.fillStyle = '#a99cff'; ctx.fillRect(-0.95 * R, -0.30 * R, 1.50 * R, 0.13 * R);
    oPoly('#eceaff', 0.55 * R, -0.30 * R, 1.25 * R, 0, 0.55 * R, 0.30 * R);
  },
  // Hypervelocity sabot dart inside a plasma sheath. Long, thin, no arc.
  railgun(R) {
    oLance(-2.2 * R, 3.7 * R, 0.30 * R, [[0, 'rgba(60,232,143,0)'], [0.5, 'rgba(60,232,143,.5)'], [0.85, 'rgba(214,255,233,.95)'], [1, 'rgba(255,255,255,0)']]);
    oPoly('#0f2a1e', -1.25 * R, -0.12 * R, -0.60 * R, -0.34 * R, -0.60 * R, 0.34 * R, -1.25 * R, 0.12 * R);
    oPoly('#d6ffe9', -1.15 * R, -0.14 * R, 0.95 * R, -0.09 * R, 1.50 * R, 0, 0.95 * R, 0.09 * R, -1.15 * R, 0.14 * R);
  },
  // Cluster dispenser: segmented canister with a steel nose cap and fuze probe.
  cluster(R) {
    oTail(-1.35 * R, -0.85 * R, 0.64 * R, '#8a6c14');
    oRect(-1.38 * R, -1.12 * R, 0.86 * R, '#6d5510');
    oRect(-0.92 * R, 0.62 * R, 0.54 * R, '#ffd23f');
    ctx.fillStyle = '#fff0a8'; ctx.fillRect(-0.92 * R, -0.54 * R, 1.54 * R, 0.20 * R);
    ctx.fillStyle = '#b8890f';
    ctx.fillRect(-0.46 * R, -0.54 * R, 0.11 * R, 1.08 * R);
    ctx.fillRect( 0.02 * R, -0.54 * R, 0.11 * R, 1.08 * R);
    oPoly('#e0e6f0', 0.62 * R, -0.54 * R, 1.08 * R, -0.24 * R, 1.08 * R, 0.24 * R, 0.62 * R, 0.54 * R);
    oRect(1.08 * R, 1.34 * R, 0.13 * R, '#8a93a8');
  },
  // Sub-munition: ribbon-tailed bomblet. Tumbles (see ORD_SPIN).
  bomblet(R) {
    oPoly('rgba(255,210,63,.7)', -0.34 * R, 0, -1.30 * R, -0.46 * R, -1.02 * R, 0, -1.30 * R, 0.46 * R);
    oRect(-0.36 * R, 0.34 * R, 0.38 * R, '#ffd23f');
    ctx.fillStyle = '#b8890f'; ctx.fillRect(-0.36 * R, 0.12 * R, 0.70 * R, 0.26 * R);
    oPoly('#e0e6f0', 0.34 * R, -0.30 * R, 0.70 * R, 0, 0.34 * R, 0.30 * R);
  },
  // Napalm tank: a fat, blunt, deliberately un-aerodynamic drum with strapping.
  napalm(R) {
    oPoly('#3a2018', -1.00 * R, -0.62 * R, -1.36 * R, -0.34 * R, -1.36 * R, 0.34 * R, -1.00 * R, 0.62 * R);
    oRect(-1.00 * R, 0.74 * R, 0.62 * R, '#c4503a');
    ctx.fillStyle = '#ff6a3d'; ctx.fillRect(-1.00 * R, -0.62 * R, 1.74 * R, 0.26 * R);
    ctx.fillStyle = '#7a2a18';
    ctx.fillRect(-0.62 * R, -0.62 * R, 0.13 * R, 1.24 * R);
    ctx.fillRect( 0.18 * R, -0.62 * R, 0.13 * R, 1.24 * R);
    oPoly('#8a93a8', 0.74 * R, -0.62 * R, 1.16 * R, -0.26 * R, 1.16 * R, 0.26 * R, 0.74 * R, 0.62 * R);
  },
  // Burning gobbet thrown out by the napalm burst — a tapered flame, not a disc.
  firebomb(R) {
    oLance(-1.5 * R, 2.7 * R, 0.58 * R, [[0, 'rgba(120,20,0,0)'], [0.35, 'rgba(255,106,61,.72)'], [0.8, 'rgba(255,210,63,.92)'], [1, 'rgba(255,255,235,0)']]);
    oPoly('#fff1c0', -0.32 * R, -0.26 * R, 0.80 * R, 0, -0.32 * R, 0.26 * R);
  },
  // Chemical shell: hazard bands and a weeping vapour trail, no fireball tip.
  gas(R) {
    oLance(-0.95 * R, -2.0 * R, 0.52 * R, [[0, 'rgba(157,222,75,.5)'], [0.55, 'rgba(157,222,75,.2)'], [1, 'rgba(157,222,75,0)']]);
    oOgive(-0.95 * R, 0.35 * R, 1.08 * R, 0.44 * R, '#6c7a55');
    ctx.fillStyle = '#8b9b6e'; ctx.fillRect(-0.95 * R, -0.44 * R, 1.30 * R, 0.20 * R);
    oRect(-0.58 * R, -0.24 * R, 0.48 * R, '#9dde4b');
    oRect( 0.08 * R,  0.34 * R, 0.48 * R, '#9dde4b');
    oRect(-1.08 * R, -0.95 * R, 0.36 * R, '#4d5741');
  },
  // Air-strike marker: a target dart with a strobing red flare.
  beacon(R, ph) {
    const k = 0.55 + 0.45 * Math.sin(ph * 0.9);
    oLance(-0.85 * R, -2.3 * R, 0.44 * R, [[0, `rgba(255,90,82,${0.85 * k})`], [0.5, `rgba(255,150,60,${0.35 * k})`], [1, 'rgba(255,90,82,0)']]);
    oPoly('#54c8ff', -0.85 * R, -0.24 * R, -0.32 * R, -0.78 * R, -0.20 * R, -0.24 * R);
    oPoly('#54c8ff', -0.85 * R,  0.24 * R, -0.32 * R,  0.78 * R, -0.20 * R,  0.24 * R);
    oRect(-0.85 * R, 0.52 * R, 0.24 * R, '#e6edf8');
    oPoly('#ff5a52', 0.52 * R, -0.24 * R, 1.22 * R, 0, 0.52 * R, 0.24 * R);
  },
  // The stick that follows the beacon: classic aerial bomb, boxed tail.
  bomb(R) {
    oTail(-1.42 * R, -0.72 * R, 0.68 * R, '#465165');
    oRect(-1.45 * R, -1.18 * R, 0.84 * R, '#2f394a');
    oOgive(-0.72 * R, 0.15 * R, 1.18 * R, 0.52 * R, '#5d6a7d');
    ctx.fillStyle = '#7d8b9f'; ctx.fillRect(-0.72 * R, -0.52 * R, 0.87 * R, 0.22 * R);
    oRect(-0.32 * R, -0.06 * R, 0.56 * R, '#3c4657');
    oPoly('#54c8ff', 0.80 * R, -0.24 * R, 1.18 * R, 0, 0.80 * R, 0.24 * R);
  },
  // Bunker buster: long slim penetrator with a hardened steel nose.
  buster(R) {
    oTail(-1.50 * R, -0.88 * R, 0.56 * R, '#7a5a30');
    oRect(-1.52 * R, -1.24 * R, 0.74 * R, '#5c421f');
    oRect(-1.08 * R, 0.35 * R, 0.34 * R, '#c98a4b');
    ctx.fillStyle = '#e0a668'; ctx.fillRect(-1.08 * R, -0.34 * R, 1.43 * R, 0.13 * R);
    oPoly('#8e969f', 0.35 * R, -0.34 * R, 1.50 * R, 0, 0.35 * R, 0.34 * R);
    oPoly('#5a6069', 0.35 * R,  0.05 * R, 1.50 * R, 0, 0.35 * R, 0.34 * R);
  },
  // Earthworks charge: a strapped earth drum. No fuze glow — it is not HE.
  wall(R) {
    oPoly('#6b451f', -0.85 * R, -0.64 * R, -1.20 * R, -0.30 * R, -1.20 * R, 0.30 * R, -0.85 * R, 0.64 * R);
    oRect(-0.85 * R, 0.85 * R, 0.64 * R, '#8a5a2b');
    ctx.fillStyle = '#a06b35'; ctx.fillRect(-0.85 * R, -0.64 * R, 1.70 * R, 0.26 * R);
    ctx.fillStyle = '#5d3c1c';
    ctx.fillRect(-0.42 * R, -0.64 * R, 0.15 * R, 1.28 * R);
    ctx.fillRect( 0.22 * R, -0.64 * R, 0.15 * R, 1.28 * R);
    oPoly('#6b451f', 0.85 * R, -0.64 * R, 1.20 * R, -0.30 * R, 1.20 * R, 0.30 * R, 0.85 * R, 0.64 * R);
  },
  // Warp probe: the same violet/cyan lozenge the teleport effect uses.
  teleport(R, ph) {
    const k = 0.6 + 0.4 * Math.sin(ph * 0.9);
    oPoly(`rgba(200,107,255,${0.28 * k})`, -1.95 * R, 0, -0.70 * R, -0.72 * R, 1.65 * R, 0, -0.70 * R, 0.72 * R);
    oPoly('#c86bff', -1.15 * R, 0, -0.15 * R, -0.46 * R, 1.32 * R, 0, -0.15 * R, 0.46 * R);
    oPoly('#6be7ff', -0.55 * R, 0,  0.05 * R, -0.22 * R, 0.98 * R, 0,  0.05 * R, 0.22 * R);
    ctx.fillStyle = `rgba(255,255,255,${0.8 * k})`;
    ctx.fillRect(-0.10 * R, -0.10 * R, 0.58 * R, 0.20 * R);
    ctx.strokeStyle = `rgba(107,231,255,${0.55 * k})`; ctx.lineWidth = Math.max(1, R * 0.12);
    ctx.beginPath();
    ctx.moveTo(-1.38 * R, -0.44 * R); ctx.lineTo(-1.02 * R, 0); ctx.lineTo(-1.38 * R, 0.44 * R);
    ctx.moveTo(-2.05 * R, -0.44 * R); ctx.lineTo(-1.70 * R, 0); ctx.lineTo(-2.05 * R, 0.44 * R);
    ctx.stroke();
  },
  // Tactical nuke: fat casing, boxed tail, trefoil warhead band. Reads as THE one.
  nuke(R) {
    oTail(-1.58 * R, -0.88 * R, 0.88 * R, '#3d4652');
    oRect(-1.60 * R, -1.32 * R, 1.02 * R, '#2b323c');
    oOgive(-0.95 * R, 0.30 * R, 1.38 * R, 0.74 * R, '#aeb9c9');
    ctx.fillStyle = '#d7e0ec'; ctx.fillRect(-0.95 * R, -0.74 * R, 1.25 * R, 0.30 * R);
    oRect(-0.64 * R, -0.26 * R, 0.78 * R, '#b6ff5a');
    ctx.fillStyle = '#26350f';
    ctx.fillRect(-0.52 * R, -0.24 * R, 0.11 * R, 0.48 * R);
    ctx.fillRect(-0.16 * R, -0.24 * R, 0.11 * R, 0.48 * R);
    oPoly('#8a93a8', 0.98 * R, -0.30 * R, 1.38 * R, 0, 0.98 * R, 0.30 * R);
  },
};

// Sub-munitions and the airstrike stick are a DIFFERENT object from the round
// that was fired, so they get their own key. game-core gives every child a
// non-zero `delay` (parent path length), which is the only signal needed.
function ordnanceKind(A, pr) {
  if (pr.beacon) return 'beacon';
  const w = A.m.weapon;
  if (w === 'airstrike') return 'bomb';
  if (w === 'cluster')   return pr.delay > 0 ? 'bomblet'  : 'cluster';
  if (w === 'napalm')    return pr.delay > 0 ? 'firebomb' : 'napalm';
  // The WARLORD's kit borrows the matching player ordnance art.
  if (w === 'b_twin')    return 'cannon';
  if (w === 'b_barrage') return 'volley';
  if (w === 'b_flame')   return pr.delay > 0 ? 'firebomb' : 'napalm';
  if (w === 'b_lance')   return 'railgun';
  if (w === 'b_quake')   return 'buster';
  return ORD[w] ? w : 'cannon';          // cannon is the sensible default round
}
const ORD_SCALE = { nuke: 1.30, mortar: 1.12, buster: 1.10, bomb: 0.92, firebomb: 0.85, bomblet: 0.72 };
const ORD_SPIN  = { bomblet: 0.16, firebomb: 0.10, wall: 0.07 };   // radians per path point
const ORD_TRAIL = {
  golfball: 'rgba(244,246,242,.5)',
  cannon: 'rgba(255,220,150,.5)', mortar: 'rgba(255,190,110,.5)', volley: 'rgba(180,170,255,.55)',
  railgun: 'rgba(60,232,143,.75)', cluster: 'rgba(255,210,63,.45)', napalm: 'rgba(255,120,70,.55)',
  gas: 'rgba(157,222,75,.45)', airstrike: 'rgba(84,200,255,.5)', buster: 'rgba(201,138,75,.5)',
  wall: 'rgba(160,120,70,.45)', teleport: 'rgba(200,107,255,.55)', nuke: 'rgba(182,255,90,.5)',
};

// Heading straight off the server's path — the client never decides anything.
// Screen space is a positive-scale affine map of world space (wx2s/wy2s), so the
// world angle IS the screen angle.
function projAngle(pr) {
  const path = pr.path;
  if (!path || path.length < 2) return 0;
  let i = Math.floor(pr.pos);
  if (i > path.length - 2) i = path.length - 2;
  if (i < 0) i = 0;
  let dx = path[i + 1][0] - path[i][0], dy = path[i + 1][1] - path[i][1];
  if (dx === 0 && dy === 0) {                       // degenerate step — widen the window
    const j = Math.max(0, i - 1);
    dx = path[i + 1][0] - path[j][0]; dy = path[i + 1][1] - path[j][1];
  }
  return (dx === 0 && dy === 0) ? 0 : Math.atan2(dy, dx);
}

function drawProjectiles() {
  const A = S.anim; if (!A) return;
  const wid = A.m.weapon || 'cannon';
  const trail = ORD_TRAIL[wid] || 'rgba(255,220,150,.5)';
  // Fixed screen size (the camera spans a 12x zoom range — a world-scaled round
  // would vanish when zoomed out). Same clamping idea as tankScreen's radius.
  const R0 = Math.max(6, Math.min(11, 150 * cam.zoom));
  for (const pr of A.projectiles) {
    if (A.elapsed - pr.delay < pr.from) continue;
    if (pr.done && pr.exploded) continue;
    const p = projPos(pr); if (!p) continue;
    pr.trail.push([p.x, p.y]); if (pr.trail.length > 10) pr.trail.shift();
    ctx.strokeStyle = trail; ctx.lineWidth = 2;
    ctx.beginPath();
    pr.trail.forEach((pt, idx) => { const x = wx2s(pt[0]), y = wy2s(pt[1]); idx ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    const kind = ordnanceKind(A, pr);
    ctx.save();
    ctx.translate(wx2s(p.x), wy2s(p.y));
    ctx.rotate(projAngle(pr) + (ORD_SPIN[kind] || 0) * pr.pos);
    ORD[kind](R0 * (ORD_SCALE[kind] || 1), pr.pos);
    ctx.restore();
  }
}
// A falling bomb: tapered body + boxed tail fins, canted along its own velocity.
// Polygons and one quadratic — no arcs.
function drawBomb(sx, sy, trail) {
  const u = Math.max(2.2, Math.min(5, 200 * cam.zoom));
  const a = trail.length >= 2
    ? Math.atan2(trail[trail.length - 1][1] - trail[trail.length - 2][1],
                 trail[trail.length - 1][0] - trail[trail.length - 2][0])
    : Math.PI / 2;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(a - Math.PI / 2);                    // local +y = direction of travel
  ctx.fillStyle = '#596374';                      // fins
  ctx.beginPath();
  ctx.moveTo(-u * 0.42, -u * 0.70); ctx.lineTo(-u * 0.92, -u * 1.55);
  ctx.lineTo(u * 0.92, -u * 1.55); ctx.lineTo(u * 0.42, -u * 0.70);
  ctx.closePath(); ctx.fill();
  const g = ctx.createLinearGradient(-u * 0.5, 0, u * 0.5, 0);
  g.addColorStop(0, '#20262e'); g.addColorStop(0.5, '#454e5a'); g.addColorStop(1, '#20262e');
  ctx.fillStyle = g;                              // body
  ctx.beginPath();
  ctx.moveTo(0, u * 1.5);
  ctx.quadraticCurveTo(u * 0.52, u * 0.20, u * 0.42, -u * 0.85);
  ctx.lineTo(-u * 0.42, -u * 0.85);
  ctx.quadraticCurveTo(-u * 0.52, u * 0.20, 0, u * 1.5);
  ctx.closePath(); ctx.fill();
  ctx.restore();
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
// Two passes, so fire can NEVER hide a tank:
//   back  — soft discs (fire glow, smoke, dust) draw behind the tanks.
//   front — 'rect' soil chips and 'spark' embers only; both are capped to a few
//           pixels, so they read as detail on top of the tank, not a blob over it.
// The shape alone decides the layer — no per-particle flag to forget at a spawn site.
function drawParticles(back) {
  const wantDisc = !!back;
  for (const p of S.particles) {
    const isDisc = p.shape !== 'rect' && p.shape !== 'spark';
    if (isDisc !== wantDisc) continue;
    const a = 1 - p.age / p.life;
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = p.color;
    if (p.shape === 'rect') {
      // square soil chunks — crisp pixel-art debris
      const s = Math.max(2, p.r * cam.zoom * 6 * (0.55 + a * 0.45));
      ctx.fillRect(Math.round(wx2s(p.x) - s / 2), Math.round(wy2s(p.y) - s / 2), Math.round(s), Math.round(s));
    } else if (p.shape === 'spark') {
      // Embers: 1..3px motes with a short motion streak. Never a disc.
      const s = Math.max(1, Math.min(3, p.r * cam.zoom * 6));
      const x = Math.round(wx2s(p.x)), y = Math.round(wy2s(p.y));
      const tail = Math.min(8, Math.hypot(p.vx, p.vy) * cam.zoom * 0.045);
      ctx.fillRect(x, y, Math.round(s), Math.round(s + tail));
    } else {
      ctx.beginPath(); ctx.arc(wx2s(p.x), wy2s(p.y), Math.max(1, p.r * cam.zoom * (0.6 + a) * 6), 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
// ---------------------------------------------------------------------------
// KILLCAM presentation. Drawn in SCREEN space after ctx.restore(), so the bars
// and label never wobble with S.shake. Every shape is a rect or a gradient
// inside a rect — the same trick drawMuzzleFlashes uses for its bore bloom —
// so there is not one ctx.arc in here and nothing reads as a round blob.
// ---------------------------------------------------------------------------
// 'saturation' is a non-separable blend mode; unsupported browsers silently fall
// back to 'source-over', which would paint solid grey over the battlefield. Probe
// once and skip the desaturation entirely where it isn't real.
const HAS_SAT_BLEND = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d');
    c.globalCompositeOperation = 'saturation';
    return c.globalCompositeOperation === 'saturation';
  } catch { return false; }
})();

function drawKillcam(w, h) {
  const K = S.killcam; if (!K || K.mix <= 0.001) return;
  const k = K.mix;

  // 1. Drain the colour out of the battlefield.
  if (HAS_SAT_BLEND) {
    ctx.save();
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = 0.55 * k;
    ctx.fillStyle = 'hsl(0,0%,50%)';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // 2. Vignette centred on the impact — gradient inside a rect, so it has no rim.
  const vx = wx2s(K.x), vy = wy2s(K.y);
  const vg = ctx.createRadialGradient(vx, vy, Math.min(w, h) * 0.16, vx, vy, Math.max(w, h) * 0.80);
  vg.addColorStop(0, 'rgba(4,6,14,0)');
  vg.addColorStop(0.55, `rgba(4,6,14,${(0.30 * k).toFixed(3)})`);
  vg.addColorStop(1, `rgba(2,3,9,${(0.72 * k).toFixed(3)})`);
  ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);

  // 3. Letterbox bars, seat-coloured on the inner edge.
  const barH = Math.round(Math.max(20, Math.min(70, h * 0.105)) * k);
  if (barH < 2) return;
  ctx.fillStyle = '#05070f';
  ctx.fillRect(0, 0, w, barH);
  ctx.fillRect(0, h - barH, w, barH);
  const accent = seatColor(K.seat);
  ctx.globalAlpha = 0.85 * k; ctx.fillStyle = accent;
  ctx.fillRect(0, barH - 2, w, 2);
  ctx.fillRect(0, h - barH, w, 2);
  ctx.globalAlpha = 1;
  if (barH < 14) return;                       // too thin to letter — bars alone

  // 4. Label: blinking diamond + KILLCAM left, the casualty right.
  const fs = Math.max(11, Math.min(22, barH * 0.46));
  const cy = barH / 2;
  const blink = 0.55 + 0.45 * Math.sin(performance.now() / 130);
  ctx.save();
  ctx.globalAlpha = Math.min(1, k * 1.4);
  ctx.textBaseline = 'middle';
  const d = fs * 0.34, dx = 16 + d;
  ctx.fillStyle = `rgba(255,64,64,${blink.toFixed(3)})`;
  ctx.beginPath();
  ctx.moveTo(dx, cy - d); ctx.lineTo(dx + d, cy); ctx.lineTo(dx, cy + d); ctx.lineTo(dx - d, cy);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `900 ${Math.round(fs)}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0.22em';                // no-op on browsers without it
  ctx.fillText('KILLCAM', dx + d + 10, cy + 1);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'right';
  ctx.fillStyle = accent;
  ctx.font = `800 ${Math.round(fs * 0.8)}px system-ui, sans-serif`;
  ctx.fillText(`${(S.names[K.seat] || 'TANK').toUpperCase()} ELIMINATED`, w - 16, cy + 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.font = `800 ${Math.round(fs * 0.72)}px system-ui, sans-serif`;
  ctx.fillText(`SLOW MOTION \u00d7${killcamScale().toFixed(2)}`, 16, h - barH / 2 + 1);
  ctx.restore();
  ctx.textAlign = 'left';
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
  // Capture this BEFORE seeding — the deep-link auto-join must still require a
  // name the player actually owns, not one we just handed them a millisecond ago.
  const hadName = !!savedName();
  if (hadName) $('nameInput').value = savedName();
  else setCallsign(rollCallsign(null));
  applyOrientPref();
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
  if (room && hadName && !loadResume()) {
    setTimeout(() => intent({ type: 'join', code: room.toUpperCase(), name: savedName(), skin: mySkin() }), 300);
  }
}
boot();
