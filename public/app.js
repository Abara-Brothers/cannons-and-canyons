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
  world: { w: 48000, h: 13500 },
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
  kinds: [], horde: null,              // per-seat renderer + wave progress
  golf: null,                          // Artillery Golf scorecard state
  props: [], crates: [], shield: [],   // barrels/bunkers, supply drops, crate shields
  chainQueue: [],                      // staggered prop chain explosions
  tanks: [{ x: 900, y: 9720 }, { x: 47100, y: 9720 }],
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
  particles: [], floaters: [], rings: [], quakes: [], flash: 0, shake: 0,
  bossCharge: null,                    // WARLORD wind-up between its aim and its shot
  muzzle: [],                          // directional HD muzzle blasts (own render pass)
  plane: null,                         // Air Strike delivery aircraft (cosmetic, own render pass)
  charging: false, pullPointer: null, pullAnchor: null,
  userZoom: 1, panY: 0, panX: 0,
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
// Tank paints (cosmetics). Every locked paint is EARNED IN THE GAME — nothing
// here is for sale and there is no shop. Midnight drops from the WARLORD; the
// other two ride on achievements (see ACHS), so `how` doubles as the tooltip
// and the toast: a player should never see a lock without being told the job.
// ---------------------------------------------------------------------------
const SKINS = {
  olive:    { name: 'Olive',    lite: '#8a9a6d', mid: '#5d7050', dark: '#38452f' },
  desert:   { name: 'Desert',   lite: '#c2ad85', mid: '#94805d', dark: '#5c4f39' },
  jungle:   { name: 'Jungle',   lite: '#7fae62', mid: '#4e7a40', dark: '#2f4d28' },
  midnight: { name: 'Midnight', lite: '#7d8bb0', mid: '#4a5a86', dark: '#2c3a5e', locked: true,
              how: 'Defeat the WARLORD in a Boss Fight' },
  arctic:   { name: 'Arctic',   lite: '#dfe8ee', mid: '#a9bcc9', dark: '#7c93a3', locked: true,
              ach: 'untouchable', how: 'Win a battle without taking any damage' },
  gold:     { name: 'Gold',     lite: '#e8cf7a', mid: '#c0a23f', dark: '#8a7020', locked: true,
              ach: 'underpar', how: 'Finish the 9 golf holes under par' },
};
// Reverse index: which paint (if any) an achievement hands over. The Career
// screen reads this so the reward is visible BEFORE you earn it.
const SKIN_FOR_ACH = Object.fromEntries(
  Object.entries(SKINS).filter(([, sk]) => sk.ach).map(([id, sk]) => [sk.ach, sk.name]));
function skinUnlocked(id) {
  const sk = SKINS[id];
  if (!sk) return false;
  if (!sk.locked) return true;
  try {
    if (id === 'midnight') return localStorage.getItem('cc_loot_midnight') === '1';
    if (sk.ach) return !!PROF.ach[sk.ach];
  } catch {}
  return false;
}
function mySkin() {
  const s = localStorage.getItem('cc_skin');
  return skinUnlocked(s) ? s : 'olive';
}
function buildSkinRow() {
  const row = $('skinRow'); if (!row) return;
  row.innerHTML = '';
  for (const [id, sk] of Object.entries(SKINS)) {
    const b = document.createElement('button');
    b.className = 'swatch' + (mySkin() === id ? ' sel' : '');
    b.style.background = `linear-gradient(180deg, ${sk.lite}, ${sk.dark})`;
    const open = skinUnlocked(id);
    b.title = sk.name + (open ? '' : ` — ${sk.how} to unlock`);
    if (!open) b.innerHTML = `<span class="lock">${UI_IC.lock}</span>`;
    b.onclick = () => {
      if (!open) { showToast(`LOCKED — ${sk.how} to unlock this paint.`); return; }
      localStorage.setItem('cc_skin', id);
      buildSkinRow();
    };
    row.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Custom weapon icons + trajectory badges (inline SVG, one per weapon)
// ---------------------------------------------------------------------------
// Small hand-drawn UI glyphs. Emojis are banned from this game's UI outright —
// anything pictorial is our own SVG.
const UI_IC = {
  speakerOn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 4.4V4.6L8 9z"/><path d="M15.8 8.6a4.8 4.8 0 0 1 0 6.8M18.3 6.1a8.2 8.2 0 0 1 0 11.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  speakerOff: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 4.4V4.6L8 9z"/><path d="M16 9.4l5.2 5.2M21.2 9.4L16 14.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5.4" y="10.6" width="13.2" height="9.8" rx="2.4"/><path d="M8.2 10.6V8.2a3.8 3.8 0 0 1 7.6 0v2.4" fill="none" stroke="currentColor" stroke-width="2.3"/></svg>',
  crown: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18l-1.2-9-4.6 3.4L12 5.6 8.8 12.4 4.2 9z"/><rect x="4.4" y="19.2" width="15.2" height="2" rx="1"/></svg>',
  sword: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.8 2.6l1.6 1.6-9.4 11.2-2-2-1.4-.6z"/><path d="M7.6 14.2l2.2 2.2-2 2-1.3 3-3-1.3 2-2-1.1-2.7 2.5-2.5z"/></svg>',
  shieldIc: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4l8 3v6.2c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V5.4z"/></svg>',
  coin: '<svg viewBox="0 0 24 24" fill="currentColor"><ellipse cx="10" cy="16.6" rx="7.6" ry="3.6"/><ellipse cx="10" cy="12.8" rx="7.6" ry="3.6"/><ellipse cx="14" cy="8" rx="7.6" ry="3.6"/><ellipse cx="14" cy="7" rx="7.6" ry="3.4" fill="#ffd97a"/></svg>',
};

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
  minigun: `<svg viewBox="0 0 24 24"><g fill="#aeb9c9"><rect x="6" y="8.2" width="13" height="1.9" rx=".9"/><rect x="6" y="11" width="15" height="1.9" rx=".9"/><rect x="6" y="13.8" width="13" height="1.9" rx=".9"/></g><rect x="3.4" y="7.4" width="4.4" height="9.2" rx="1.6" fill="#5b6572"/><rect x="1.6" y="10.4" width="2.4" height="3.2" rx=".8" fill="#39424e"/><g fill="#ffd9a0"><rect x="20" y="8.4" width="2.4" height="1.4" rx=".7"/><rect x="21.4" y="11.2" width="2.4" height="1.4" rx=".7"/><rect x="20" y="14" width="2.4" height="1.4" rx=".7"/></g></svg>`,
  // The three clubs read as the REAL club heads (Jordan, 8.22): iron = angled
  // grooved blade on a hosel, driver = big round-crowned wood, putter = flat
  // mallet with an alignment stripe. Shared anatomy: dark grip cap top-right,
  // steel shaft running down-left into the head.
  golfball: `<svg viewBox="0 0 24 24"><path d="M20.2 1.6 18.4 4" stroke="#7c8698" stroke-width="2.8" stroke-linecap="round"/><path d="M18.7 3.6 10.2 14.8" stroke="#c9cfd8" stroke-width="1.6" stroke-linecap="round"/><path d="M10.6 14.2c-.7 0-1.3.4-1.7 1l-2.6 3.9c2.2 1.6 5.6 1.9 8.2.7 1.5-.7 2.4-1.9 2.3-3.1-.1-1.3-1.3-2.2-3-2.4z" fill="#c9cfd8" stroke="#7c8698" stroke-width=".9"/><path d="M8.6 17.4l6.2.7M7.8 18.7l6.4.7" stroke="#7c8698" stroke-width=".8" stroke-linecap="round"/></svg>`,
  driver: `<svg viewBox="0 0 24 24"><path d="M20.2 1.6 18.4 4" stroke="#7c8698" stroke-width="2.8" stroke-linecap="round"/><path d="M18.7 3.6 10.9 13.6" stroke="#c9cfd8" stroke-width="1.6" stroke-linecap="round"/><path d="M4.4 17.1c0-2.6 2.5-4.6 5.7-4.6 3.6 0 6.3 2.1 6.3 4.7 0 2.6-2.7 4.2-6 4.2-3.4 0-6-1.7-6-4.3z" fill="#3d4550" stroke="#20262e" stroke-width=".9"/><path d="M5.3 15.5c.8-1.2 2.6-2 4.8-2" stroke="#e8ecf2" stroke-width=".9" fill="none" stroke-linecap="round"/><path d="M4.5 16.4c-.3.5-.4 1.1-.3 1.7" stroke="#e8ecf2" stroke-width="1.1" fill="none" stroke-linecap="round"/></svg>`,
  putter: `<svg viewBox="0 0 24 24"><path d="M18.6 1.6 17 4.1" stroke="#7c8698" stroke-width="2.8" stroke-linecap="round"/><path d="M17.4 3.7 12.4 15.6" stroke="#c9cfd8" stroke-width="1.6" stroke-linecap="round"/><rect x="5.4" y="15.8" width="12.4" height="4.2" rx="1.5" fill="#8affde" stroke="#3f9a7c" stroke-width=".9"/><path d="M5.6 16.6c-.2.3-.2 2.4 0 2.7" stroke="#e8fffa" stroke-width="1" stroke-linecap="round"/><path d="M11.6 15.9v1.8" stroke="#0a1020" stroke-width="1.3" stroke-linecap="round"/></svg>`,
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
  minigun: `<svg viewBox="0 0 24 14"><g stroke="#ffd9a0" stroke-width="1.3" fill="none"><path d="M2 11 Q9 4 16 7.5"/><path d="M2 12.5 Q10 6.5 17.5 9.5"/><path d="M3 13.5 Q11 9 19 11.5"/></g></svg>`,
  golfball: `<svg viewBox="0 0 24 14"><path d="M2 12 Q7 3 11 8 Q13 10.5 15 9.5 Q18 8 21 11.5" stroke="#aeb9d6" stroke-width="1.5" fill="none"/><circle cx="21.2" cy="11.6" r="1.6" fill="#f4f6f2"/></svg>`,
  driver: `<svg viewBox="0 0 24 14"><path d="M2 12 Q8 1 14 6 Q18 9.4 22 11.6" stroke="#aeb9d6" stroke-width="1.5" fill="none"/><circle cx="22" cy="11.6" r="1.6" fill="#f4f6f2"/></svg>`,
  putter: `<svg viewBox="0 0 24 14"><path d="M2 11.6h17" stroke="#aeb9d6" stroke-width="1.5" stroke-dasharray="3 2.4" fill="none"/><circle cx="21" cy="11.6" r="1.6" fill="#f4f6f2"/></svg>`,
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
    // 'suspended' (Chrome autoplay policy) and 'interrupted' (iOS call /
    // backgrounding) both need a resume; it only sticks when this runs inside
    // a user gesture — the global pointerdown unlock guarantees one.
    if (this.ctx.state !== 'running') { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); }
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
// Autoplay unlock: EVERY pointer/key gesture (re)arms the context. This covers
// entry paths that never click a home button — deep-link ?room= auto-join and
// resume-on-reload — and re-resumes after iOS 'interrupted'. Kept attached for
// life: once running, ensure() is two cheap property checks per tap.
window.addEventListener('pointerdown', () => { Audio.ensure(); }, { capture: true, passive: true });
window.addEventListener('keydown', () => { Audio.ensure(); }, { capture: true });

$('muteBtn').onclick = () => {
  Audio.muted = !Audio.muted; localStorage.setItem('pt_mute', Audio.muted ? '1' : '0');
  $('muteBtn').innerHTML = Audio.muted ? UI_IC.speakerOff : UI_IC.speakerOn;
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
// A fresh match opens WIDER than the fit-all baseline (userZoom 1) — you read
// the whole battlefield first and pinch in when you want the detail.
const START_ZOOM = 0.62;
const finite = (v, fb) => (Number.isFinite(v) ? v : fb);

// Aim zoom baseline. COMBAT: fit every tank still fighting (plus margin) — on
// the 48k map neither the whole-map view (tanks become specks) nor the old
// own-tank band (enemy off-screen) works; 'see all player tanks' is the rule.
// GOLF keeps its terrain-band framing: the course is far wider than any screen
// and the cup is flagged, so framing 'all tanks' would mean nothing there.
function aimZoom() {
  const fzW = fullZoom();
  const band = WH() - S.minY;
  if (S.mode === 'golf') {
    if (band * fzW >= view.cssH * 0.42) return fzW;
    return Math.min(0.14, Math.max(fzW, view.cssH / (band + 1400)));
  }
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < S.n; i++) {
    if (S.alive[i] === false || !S.tanks[i]) continue;
    xmin = Math.min(xmin, S.tanks[i].x); xmax = Math.max(xmax, S.tanks[i].x);
    ymin = Math.min(ymin, S.tanks[i].y); ymax = Math.max(ymax, S.tanks[i].y);
  }
  if (!Number.isFinite(xmin)) return Math.max(minMapZoom(), Math.min(0.14, fzW));
  const spanX = Math.max(9000, (xmax - xmin) + 7000);   // breathing room both sides
  const spanY = Math.max(6500, (ymax - ymin) + 5200);   // arc headroom + ground
  const zFit = Math.min(view.cssW / spanX, view.cssH / spanY);
  return Math.max(minMapZoom(), Math.min(0.14, zFit));
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
  // Survey framing: at the default (fit-all) zoom the camera centres on the
  // WHOLE battle — bounds midpoint of everyone still fighting, both axes — and
  // eases back onto your own tank as you pinch in. Blend runs off the fit
  // baseline (not min-map zoom), so 'default view = every tank on screen'
  // holds on the 48k map. Golf skips the survey: it stays on your ball.
  const base = aimZoom();
  const surveyMix = S.mode === 'golf' ? 0
    : Math.max(0, Math.min(1, (base * 1.6 - tz) / (base * 0.6)));
  let xmin = Infinity, xmax = -Infinity, ysum = 0, ycnt = 0;
  for (let i = 0; i < S.n; i++) {
    if (S.alive[i] === false || !S.tanks[i]) continue;
    xmin = Math.min(xmin, S.tanks[i].x); xmax = Math.max(xmax, S.tanks[i].x);
    ysum += S.tanks[i].y; ycnt++;
  }
  const surveyX = Number.isFinite(xmin) ? (xmin + xmax) / 2 : focus.x;
  let tx = focus.x + (surveyX - focus.x) * surveyMix + (S.panX || 0);
  // BOSS FIGHT sits everything much lower in the frame: the WARLORD trades in
  // huge lobbed arcs, and Jordan's read was 'too much ground/lava, can't see
  // the sky to judge the trajectory'. The world clamp below caps the bias at
  // the world's top edge, so a big value is safe. Golf ignores both knobs
  // (surveyMix 0 + its own aimZoom branch); the killcam blends over them.
  const framedY = focus.y - vh * (S.mode === 'boss' ? 0.30 : 0.18);
  // On landscape, sit the tanks lower in the frame by default so you see more sky
  // (and less of the terrain wall). Then apply the user's vertical pan (S.panY).
  const skyBias = S.mode === 'boss' ? vh * 0.26 : (view.cssW > view.cssH ? vh * 0.13 : 0);
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
// Horizontal pan — scouting long golf holes (and any wide map) left/right.
function holdPanX(btn, dir) {
  let iv = null;
  const step = () => {
    const amt = (view.cssW / Math.max(cam.zoom, 1e-4)) * 0.06 * dir;
    S.panX = Math.max(-WW(), Math.min(WW(), (S.panX || 0) + amt));
  };
  const start = (e) => { e.preventDefault(); step(); iv = setInterval(step, 55); };
  const stop = () => { clearInterval(iv); iv = null; };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('pointercancel', stop);
}
holdPanX($('panLeft'), -1);
holdPanX($('panRight'), 1);

// ---- Stage chrome: two collapsed groups instead of a 7-button rail ----------
// The camera button fans out the six zoom/pan controls; the "..." button opens
// sound / help / leave (golf's scorecard is its own button since 8.22). Both
// start collapsed EVERY match (nothing
// is persisted) and both shut on an outside tap or Escape. Pinch-zoom and
// two-finger pan are untouched — these buttons are only the fallback.
function setStageMenu(which, open) {
  const stage = $('stage');
  stage.classList.toggle('cam-open', which === 'cam' ? open : false);
  stage.classList.toggle('meta-open', which === 'meta' ? open : false);
  const camOn = stage.classList.contains('cam-open');
  const metaOn = stage.classList.contains('meta-open');
  $('camBtn').classList.toggle('on', camOn);
  $('camBtn').setAttribute('aria-expanded', String(camOn));
  $('metaBtn').classList.toggle('on', metaOn);
  $('metaBtn').setAttribute('aria-expanded', String(metaOn));
}
const closeStageMenus = () => setStageMenu(null, false);
$('camBtn').onclick = (e) => {
  e.stopPropagation();
  setStageMenu('cam', !$('stage').classList.contains('cam-open'));
};
$('metaBtn').onclick = (e) => {
  e.stopPropagation();
  setStageMenu('meta', !$('stage').classList.contains('meta-open'));
};
// Outside tap closes. Capture phase so it still fires when the target stops
// propagation, and the canvas (aiming) counts as outside.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('.zoomctl, .metamenu, #camBtn, #metaBtn')) return;
  closeStageMenus();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStageMenus(); });

// ---- Dock collapse ---------------------------------------------------------
// Shut, the dock is a 28px sliver holding only FIRE and a live aim readout.
// The SLIDE animates on transform (cheap); the moment it lands the same offset
// moves to a negative margin so the layout genuinely gives the space back and
// the battlefield grows into it (the draw loop notices the canvas box and
// re-sizes itself). Both states leave the dock in the same place on screen, so
// the hand-off is invisible.
const DOCK_SLIVER = 28;
let dockFullH = 0, dockTimer = null, dockSeq = 0;
function dockSlidePx() {
  const d = $('dock');
  // Measure only while open — collapsed, the negative margin would lie.
  if (!d.classList.contains('collapsed')) {
    const h = d.getBoundingClientRect().height;
    if (h > DOCK_SLIVER) dockFullH = h;
  }
  return Math.max(0, Math.round(dockFullH - DOCK_SLIVER));
}
// The REQUESTED dock state. The 'collapsed' class only lands at the end of an
// animated slide, so anything that wants to toggle (the tab) must read the
// request, not the DOM — or a tap during the first-shot tuck-away would try to
// 're-collapse' the already-collapsing dock and get swallowed.
let dockShutReq = false;
function setDockCollapsed(on, animate) {
  const d = $('dock');
  if (dockShutReq === !!on && d.classList.contains('collapsed') === !!on) { paintDockTab(); return; }
  dockShutReq = !!on;
  const slide = dockSlidePx();
  d.style.setProperty('--dock-slide', slide + 'px');
  clearTimeout(dockTimer);
  // A token so a timeout left over from an earlier toggle can never land the
  // wrong state on top of a newer one.
  const seq = ++dockSeq;
  const land = () => {
    if (seq !== dockSeq) return;
    d.classList.remove('dock-anim');
    d.style.transform = '';                     // margin alone holds the position
    d.classList.toggle('collapsed', !!on);
    // Collapsing lifts FIRE out of the flow, so the dock's own height is not
    // quite what it was when the slide was measured. Re-measure and correct, or
    // the visible band drifts off the sliver by that difference.
    if (on) {
      const h = d.getBoundingClientRect().height;
      if (h > DOCK_SLIVER) d.style.setProperty('--dock-slide', Math.round(h - DOCK_SLIVER) + 'px');
    }
    paintDockTab();
  };
  if (!animate || !slide) { d.classList.remove('dock-anim'); d.style.transform = ''; land(); return; }
  // NO rAF here: a late callback could re-apply the transform after landing and
  // double the offset. Force the start value, then set the target synchronously.
  if (on) {
    d.classList.add('dock-anim');
    void d.offsetHeight;                        // commit transform:none as the start
    d.style.transform = `translateY(${slide}px)`;
  } else {
    // Give the margin back first, then hold the dock where it looks with a
    // transform and let it slide up from there.
    d.classList.remove('collapsed');
    d.style.transform = `translateY(${slide}px)`;
    void d.offsetHeight;
    d.classList.add('dock-anim');
    d.style.transform = '';
  }
  d.addEventListener('transitionend', function once(e) {
    if (e.propertyName !== 'transform') return;
    d.removeEventListener('transitionend', once);
    land();
  });
  dockTimer = setTimeout(land, 260);            // fallback: never stick mid-slide
}
function paintDockTab() {
  const shut = $('dock').classList.contains('collapsed');
  const tab = $('dockTab');
  tab.setAttribute('aria-expanded', String(!shut));
  tab.setAttribute('aria-label', shut ? 'Show controls' : 'Collapse controls');
  $('dockMini').setAttribute('aria-hidden', String(!shut));
  updateDockMini();          // populate the sliver the moment it appears
}
// Every NEW battle opens with the controls SHOWN, then the dock tucks itself
// away after the player's first shot of that match (Jordan: 'at the very start
// of every game (not every round), toggle the controls... then toggle them
// down once the player has shot'). dockIntro arms on a 'start' snapshot only —
// holes, turns and resyncs never re-run the intro.
let dockIntro = false;
$('dockTab').onclick = () => {
  dockIntro = false;      // they've found the toggle themselves — stop stage-managing
  setDockCollapsed(!dockShutReq, true);
};
// Cold-resume fallback (see applySnapshot): a mid-battle reload comes back
// with the dock tucked away — the sliver keeps FIRE + the live aim readout,
// and the labelled tab invites the rest up. New battles instead open RAISED
// until the first shot (see dockIntro). The slide is measured off the OPEN
// dock, so wait for a laid-out one before shutting it.
function startDockCollapsed() {
  if (!dockSlidePx()) { requestAnimationFrame(startDockCollapsed); return; }
  setDockCollapsed(true, false);
}
// A re-measure while open keeps the slide honest after any layout change.
window.addEventListener('resize', () => {
  const d = $('dock');
  if (d.classList.contains('collapsed')) return;
  dockSlidePx();
});
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
// Career profile + achievements (local, per device). Every hook feeds PROF and
// runs the achievement checks; the Career screen renders it.
// ---------------------------------------------------------------------------
const ACHS = [
  ['first_blood', 'First Blood', 'Win your first match'],
  ['thread', 'By a Thread', 'Win a battle with 5 Health or less remaining'],
  ['untouchable', 'Untouchable', 'Win a battle without taking any damage'],
  ['horizon', 'Over the Horizon', 'Damage an enemy from 20,000+ range'],
  ['tunnel', 'Tunnel Rat', 'Take a kill with the Railgun — straight through the mountain'],
  ['nuclear', 'Nuclear Option', 'Finish an enemy with the Tactical Nuke'],
  ['melt', 'Into the Melt', 'See an enemy die in the lava on a volcanic map'],
  ['robber', 'Crate Robber', 'Shoot a supply crate open from range'],
  ['warlord', 'Warlord Slayer', 'Win a Boss Fight'],
  ['exterminator', 'Exterminator', 'Repel the Alien Invasion'],
  ['ace', 'Hole in One', 'Sink the ball in a single stroke'],
  ['underpar', 'Under Par', 'Finish the 9 holes under par'],
];
const PROF = (() => {
  try {
    const p = JSON.parse(localStorage.getItem('cc_career') || 'null');
    if (p && p.v === 1) return p;
  } catch {}
  return { v: 1, modes: {}, weapons: {}, shots: 0, hits: 0, maxDmg: 0, longest: 0,
           kills: 0, aces: 0, golfBest: null, hordeBest: { aliens: 0 }, ach: {} };
})();
function saveProf() { try { localStorage.setItem('cc_career', JSON.stringify(PROF)); } catch {} }
function modeStat(mode) { return PROF.modes[mode] || (PROF.modes[mode] = { w: 0, l: 0 }); }
function award(id) {
  if (PROF.ach[id]) return;
  PROF.ach[id] = Date.now();
  saveProf();
  const a = ACHS.find(x => x[0] === id);
  if (a) showToast(`ACHIEVEMENT — ${a[1]}`);
}
// One shot of mine just resolved: log usage, damage, range, and eliminations.
function trackMyShot(m) {
  if (m.by !== S.you) return;
  PROF.shots++;
  PROF.weapons[m.weapon] = (PROF.weapons[m.weapon] || 0) + 1;
  let dealt = 0;
  for (let i = 0; i < (m.damage || []).length; i++) if (i !== S.you) dealt += m.damage[i] || 0;
  if (dealt > 0) {
    PROF.hits++;
    if (dealt > PROF.maxDmg) PROF.maxDmg = Math.round(dealt);
    // range = my tank to the farthest detonation of this shot
    const myX = S.tanks[S.you] ? S.tanks[S.you].x : 0;
    for (const pr of (m.projectiles || [])) {
      if (!pr.det) continue;
      const dist = Math.abs(pr.det.x - myX);
      if (dist > PROF.longest) PROF.longest = Math.round(dist);
      if (dist >= 20000) award('horizon');
    }
  }
  saveProf();
}
// An enemy went down during MY replay — credit the kill to my current weapon.
function trackMyKill(seat) {
  PROF.kills++;
  const w = S.anim && S.anim.m ? S.anim.m.weapon : null;
  if (w === 'railgun') award('tunnel');
  if (w === 'nuke') award('nuclear');
  const t = S.tanks[seat];
  if (S.biome === 'volcanic' && t && S.lavaY && t.y >= S.lavaY - 320) award('melt');
  saveProf();
}
function trackGameOver(m) {
  const mode = S.mode || 'duel';
  const ms = modeStat(mode);
  let won = false;
  if (m.golf) {
    const mine = m.golf.totals[S.you] ?? m.golf.totals[0];
    won = m.golf.totals.length < 2 || m.winner === S.you;
    if (PROF.golfBest == null || mine < PROF.golfBest) PROF.golfBest = mine;
    if (won && mine < m.golf.parTotal) award('underpar');
  } else if (m.team) {
    won = m.team === 'players';
    if (won && mode === 'boss') award('warlord');
    if (won && mode === 'aliens') award('exterminator');
    if (S.horde) PROF.hordeBest[mode] = Math.max(PROF.hordeBest[mode] || 0, S.horde.kills || 0);
  } else {
    won = m.winner === S.you;
  }
  ms[won ? 'w' : 'l']++;
  refreshCareerChip();
  if (won) {
    award('first_blood');
    if (!m.golf) {
      const hp = S.hp[S.you] ?? 0, cap = (S.hpMax && S.hpMax[S.you]) || 150;
      if (hp > 0 && hp <= 5) award('thread');
      if (hp >= cap) award('untouchable');
    }
  }
  saveProf();
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
function connect() {
  // Never stack sockets: boot, the retry loop and resyncOnReturn can all land
  // here — if a live or connecting socket exists, it wins.
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
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
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } S.msgCount = (S.msgCount || 0) + 1; handle(m); };
}
function sendMsg(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }

// Coming back from the background (app switch, phone lock, tab switch) is the
// classic dead-buttons moment: the socket may have died silently, a replay may
// be frozen mid-flight holding the deferHp gate shut, or we may simply have
// missed broadcasts. One rule un-sticks everything: on return, reconnect if the
// socket is gone, otherwise ask the server for a fresh restore snapshot —
// applySnapshot rebuilds turn/hp/ammo state and clears any stuck animation.
let syncWatchdog = null;
function resyncOnReturn() {
  if (!S.playing) return;
  const st = S.ws ? S.ws.readyState : 3;
  if (st === 1) {
    sendMsg({ type: 'sync' });
    // A mobile suspend can leave a ZOMBIE socket: readyState still says OPEN,
    // but the connection under it is gone — the sync sails into the void and
    // connect() refuses to act while the socket 'looks' alive. If nothing at
    // all arrives shortly after the sync, stop believing the socket: close it
    // and reconnect — the resume token then takes the seat over server-side.
    clearTimeout(syncWatchdog);
    const seen = S.msgCount || 0;
    syncWatchdog = setTimeout(() => {
      if (!S.playing || (S.msgCount || 0) !== seen) return;
      try { S.ws.close(); } catch { /* already dying */ }
      connect();                         // close() puts readyState past the guard
    }, 3000);
  } else if (st !== 0) {
    connect();                           // 0 = already reconnecting, leave it be
  }
}
window.addEventListener('visibilitychange', () => { if (!document.hidden) resyncOnReturn(); });
window.addEventListener('pageshow', () => resyncOnReturn());
window.addEventListener('focus', () => resyncOnReturn());

// ---- Turn nudges (Web Push) -----------------------------------------------------
// Async duels: take your turn whenever — the opponent gets a system notification
// when it's theirs. Requires the service worker; on iOS the game must be added
// to the Home Screen first (that's an Apple rule, not ours).
try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js'); } catch {}
function urlB64ToU8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function enableTurnPings() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      showToast('Notifications need the installed app on this device'); return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { showToast('Notifications blocked'); return; }
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch('/push/key');
    const { key } = await res.json();
    if (!key) { showToast('Nudges are not enabled on this server'); return; }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(key) });
    sendMsg({ type: 'pushSub', sub: sub.toJSON() });
  } catch {
    showToast('Could not enable nudges here');
  }
}
$('notifyBtn').onclick = () => { Audio.ensure(); enableTurnPings(); };

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
      // The between-holes banner carries the finished hole's card AND the
      // next hole's number/par — it replaces the old next-hole toast.
      if (m.golf) showHoleScore(m.golf);
      break;
    case 'restore':
      applySnapshot(m); saveResume(m.code, m.token);
      showToast('Reconnected — battle on!');
      break;
    case 'resumeError':
      clearResume();
      // The room is gone (ended, or reclaimed after a very long absence).
      // Leaving the player staring at a frozen battlefield with dead buttons
      // was the worst outcome of all — say so and go home cleanly.
      if (S.playing) {
        showToast('That battle has ended.');
        setTimeout(() => location.reload(), 1600);
      }
      break;
    case 'oppConn': {
      const who = S.names[m.seat] || 'Opponent';
      showToast(m.connected ? `${who} reconnected` : `${who} lost connection — holding their seat…`);
      break;
    }
    case 'turn': onTurn(m); break;
    case 'face': if (m.seat !== S.you) S.facing[m.seat] = m.dir; break;
    case 'crate':
      S.crates.push({ ...m.crate, dropT: 0 });   // parachute in from the sky
      showToast('SUPPLY DROP INBOUND');
      break;
    case 'pickDone':
      S.picking = false;
      S.loadout = (m.loadouts && m.loadouts[S.you]) || S.loadout;
      if (m.ammoSeat === S.you && m.ammo) S.ammo = m.ammo;
      $('armouryModal').classList.add('hidden');
      S.selected = firstAvailableWeapon();
      buildWeaponStrip(); updateDock();
      showToast('LOADOUTS LOCKED — BATTLE ON');
      break;
    case 'pushOk': showToast('Nudges on — play whenever, we will fetch you'); break;
    case 'crateTaken': deferHp(() => applyCrateTaken(m)); break;
    case 'crates':      // post-shot re-settle: survivors follow the new ground
      deferHp(() => {
        for (const cu of m.crates) {
          const c = S.crates.find(k => k.id === cu.id);
          if (c) { c.x = cu.x; c.y = cu.y; }
        }
      });
      break;
    case 'respawn':
      deferHp(() => {
        if (S.tanks[m.seat]) { S.tanks[m.seat].x = m.x; S.tanks[m.seat].y = m.y; }
        if (m.hp) S.hp = m.hp.slice();
        if (m.hpMax) S.hpMax = m.hpMax.slice();
        if (m.alive) S.alive = m.alive.slice();
        S.horde = { kills: m.kills, target: m.target, wave: m.wave };
        S.floaters.push({ x: m.x, y: m.y - 500, text: `WAVE ${m.wave} INBOUND`, age: 0, life: 1.9, color: '#b6ff5a' });
        updateHud();
      });
      break;
    case 'wave':
      deferHp(() => {
        S.horde = { kills: m.kills, target: m.target, wave: m.wave };
        showToast(`${m.kills}/${m.target} DOWN`);
        updateDock();
      });
      break;
    case 'forfeit':
      deferHp(() => {
        if (m.hp) S.hp = m.hp.map((h, i) => Math.min(S.hp[i] ?? h, h));
        if (m.alive) S.alive = m.alive.slice();
        updateHud();
      });
      showToast(`${S.names[m.seat] || 'A player'} left — tank scuttled`);
      break;
    case 'aim':
      if (m.seat !== S.you) { S.aim[m.seat] = { angle: clampAimC(m.angle), power: Number(m.power) || 60 }; }
      // The WARLORD telegraphs: from its aim to its shot it visibly charges.
      if (m.seat === S.boss && m.weapon) S.bossCharge = { weapon: m.weapon, t0: performance.now() };
      break;
    case 'move': {
      // Your own drive echoes back instantly; anyone ELSE's movement holds
      // behind the replay gate — an NPC must never scoot around the field
      // while your shell is still in the air on this screen.
      if (m.seat === S.you) applyMove(m); else deferHp(() => applyMove(m));
      break;
    }
    case 'shot': if (m.by === S.boss) S.bossCharge = null; enqueueShot(m); break;
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

// ---- Armoury -----------------------------------------------------------------
// Duel and free-for-all run on a 5-weapon loadout: pick five from the pool,
// two rounds each; the nuke is issued regardless and the railgun stays
// supply-drop-only. The pick lives in localStorage and rides along on every
// create / join / quick / vs-CPU intent — so it applies even to instant
// matches that never sit in a lobby.
// The weapon draft happens AT MATCH START, not on the dashboard: when the
// snapshot arrives with `pick`, this screen opens over the battlefield and the
// first turn only begins once everyone has locked five (or seven) in.
const ARM_POOL = ['mortar', 'volley', 'cluster', 'napalm', 'gas', 'airstrike', 'buster', 'wall', 'teleport', 'minigun'];
const ARM_DEFAULT = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
let armNeed = 5;
let armPicks = [];
function armPrefill() {
  try {
    const p = JSON.parse(localStorage.getItem('cc_loadout') || 'null');
    if (Array.isArray(p)) return p.filter(id => ARM_POOL.includes(id)).slice(0, armNeed);
  } catch {}
  return ARM_DEFAULT.slice(0, armNeed);
}
function openDraft(n) {
  armNeed = n;
  armPicks = armPrefill();
  document.querySelector('#armouryModal .arm-sub').innerHTML =
    `Pick <b>${armNeed}</b> weapons for this battle — each carries <b>2 rounds</b>. ` +
    'The <b>Cannon</b> (unlimited) and the <b>Tactical Nuke</b> are standard issue; the <b>Railgun</b> only drops in supply crates.';
  buildArmoury();
  $('armouryModal').classList.remove('hidden');
}
function buildArmoury() {
  const grid = $('armouryGrid'); grid.innerHTML = '';
  for (const id of ARM_POOL) {
    const w = HELP_WEAPONS.find(h => h.id === id) || { name: id, desc: '' };
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.dataset.wid = id;
    cell.innerHTML = `${ICONS[id] || ''}<span>${w.name}<i>${w.desc}</i></span>`;
    cell.onclick = () => {
      const at = armPicks.indexOf(id);
      if (at >= 0) armPicks.splice(at, 1);
      else if (armPicks.length < armNeed) armPicks.push(id);
      paintArmoury();
    };
    grid.appendChild(cell);
  }
  paintArmoury();
}
function paintArmoury() {
  const full = armPicks.length === armNeed;
  for (const cell of $('armouryGrid').children) {
    const picked = armPicks.includes(cell.dataset.wid);
    cell.className = 'arm-cell' + (picked ? ' picked' : full ? ' dim' : '');
  }
  // The slot row IS the instruction (Jordan, 8.22): one box per pick, filling
  // left to right — an empty numbered box reads as 'this still needs a weapon'.
  const slots = $('armSlots'); slots.innerHTML = '';
  for (let i = 0; i < armNeed; i++) {
    const id = armPicks[i];
    const s = document.createElement('span');
    s.className = 'arm-slot' + (id ? ' filled' : '');
    s.innerHTML = id ? (ICONS[id] || '') : `<i>${i + 1}</i>`;
    slots.appendChild(s);
  }
  const st = $('armouryStatus');
  st.textContent = full ? `${armNeed} of ${armNeed} picked — locked and loaded` : `${armPicks.length} of ${armNeed} picked`;
  st.classList.toggle('ready', full);
  const btn = $('armouryCloseBtn');
  btn.disabled = !full;
  const left = armNeed - armPicks.length;
  btn.textContent = full ? 'Save loadout' : `Pick ${left} more weapon${left === 1 ? '' : 's'}`;
}
$('armouryCloseBtn').onclick = () => {
  try { localStorage.setItem('cc_loadout', JSON.stringify(armPicks)); } catch {}
  sendMsg({ type: 'loadout', picks: armPicks.slice() });
  $('armouryModal').classList.add('hidden');
  showToast('Locked in — waiting for the others…');
};

let ccMode = 'duel', ccMax = 4;
let ccOpp = 'friend';        // duel opponent: 'friend' (code/link) or 'cpu'
(function initMode() {
  const mr = $('modeRow');
  mr.addEventListener('click', (e) => {
    const b = e.target.closest('.mode'); if (!b) return;
    ccMode = b.dataset.mode;
    for (const el of mr.querySelectorAll('.mode')) el.classList.toggle('active', el === b);
    // Only the options that matter for the chosen mode are visible.
    syncCreateRow();
  });
  syncCreateRow();
})();
$('countSel').onchange = () => { ccMax = +$('countSel').value; };
let ccTees = localStorage.getItem('cc_tees') || 'mens';
$('teeSel').value = ccTees;
$('teeSel').onchange = () => { ccTees = $('teeSel').value; try { localStorage.setItem('cc_tees', ccTees); } catch {} };
$('createBtn').onclick = () => {
  Audio.ensure(); $('homeError').textContent = '';
  if (ccMode === 'duel' && ccOpp === 'cpu') {
    intent({ type: 'ai', difficulty: cpuDifficulty, name: myName(), skin: mySkin() });
    return;
  }
  intent({ type: 'create', name: myName(), skin: mySkin(), mode: ccMode, max: ccMode === 'ffa' ? ccMax : 2, tees: ccTees });
};

// Single-player vs CPU, with a difficulty selector.
let cpuDifficulty = localStorage.getItem('pt_diff') || 'medium';
$('diffSel').value = cpuDifficulty;
$('diffSel').onchange = () => { cpuDifficulty = $('diffSel').value; localStorage.setItem('pt_diff', cpuDifficulty); };
// Duel's opponent choice: a friend via code/link, or the CPU right here.
function syncCreateRow() {
  const duel = ccMode === 'duel';
  $('oppBtns').classList.toggle('hidden', !duel);
  $('diffWrap').classList.toggle('hidden', !(duel && ccOpp === 'cpu'));
  $('countWrap').classList.toggle('hidden', ccMode !== 'ffa');
  $('teeWrap').classList.toggle('hidden', ccMode !== 'golf');
  $('createBtn').textContent = duel && ccOpp === 'cpu' ? 'START VS COMPUTER' : 'CREATE GAME';
}
// Opponent is two buttons now (Friend/online vs the Computer), not a dropdown.
$('oppBtns').addEventListener('click', (e) => {
  const b = e.target.closest('.opp'); if (!b) return;
  ccOpp = b.dataset.opp;
  for (const el of $('oppBtns').querySelectorAll('.opp')) el.classList.toggle('active', el === b);
  syncCreateRow();
});

// Custom in-game dropdowns: a game-styled menu driving each hidden native
// <select>, so every existing `.value` read and `.onchange` handler is untouched.
function closeAllGsel() { for (const g of document.querySelectorAll('.gsel.open')) g.classList.remove('open'); document.body.classList.remove('dd-open'); }
function buildGameSelect(sel) {
  const wrap = document.createElement('div');
  wrap.className = 'gsel';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'gsel-btn'; btn.setAttribute('aria-haspopup', 'listbox');
  btn.innerHTML = '<span class="gsel-cur"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const cur = btn.querySelector('.gsel-cur');
  const list = document.createElement('div'); list.className = 'gsel-list'; list.setAttribute('role', 'listbox');
  const paint = () => {
    const o = sel.options[sel.selectedIndex];
    cur.textContent = o ? o.textContent : '';
    for (const el of list.children) el.classList.toggle('sel', el.dataset.val === sel.value);
  };
  for (const o of sel.options) {
    const item = document.createElement('button');
    item.type = 'button'; item.className = 'gsel-opt'; item.dataset.val = o.value;
    item.textContent = o.textContent; item.setAttribute('role', 'option');
    item.onclick = () => {
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      paint(); closeAllGsel();
    };
    list.appendChild(item);
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = !wrap.classList.contains('open');
    closeAllGsel();
    wrap.classList.toggle('open', willOpen);
    document.body.classList.toggle('dd-open', willOpen);
  };
  sel.addEventListener('change', paint);
  sel.classList.add('gsel-native');
  wrap.appendChild(btn); wrap.appendChild(list);
  sel.parentNode.insertBefore(wrap, sel.nextSibling);
  paint();
}
function initGameSelects() {
  for (const sel of document.querySelectorAll('select.hs-select')) buildGameSelect(sel);
  document.addEventListener('click', (e) => { if (!e.target.closest('.gsel')) closeAllGsel(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllGsel(); });
}
initGameSelects();

// Landscape is the ONLY supported orientation. There is no preference and no
// opt-out: body never gets .portrait-ok, so the CSS rotate prompt covers the
// game screen whenever a phone is held upright.
// Landscape is ABSOLUTE: in portrait the whole app renders rotated 90° (CSS
// shim in styles.css), so there is no rotate prompt any more — the game simply
// cannot be viewed in portrait.
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
    m.mode === 'boss' ? `Boss Fight — ${filled}/${m.max} vs WARLORD-7` :
    m.mode === 'golf' ? `Artillery Golf — ${filled}/${m.max} on the tee` :
    m.mode === 'aliens' ? `Alien Invasion — ${filled}/${m.max} defenders` :
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
  const hostStarts = m.mode !== 'duel';
  const minSeats = (m.mode === 'ffa') ? 2 : 1;
  btn.classList.toggle('hidden', !(isHost && hostStarts));
  btn.disabled = filled < minSeats;
  btn.textContent = filled < minSeats ? `Start (need ${minSeats})`
    : m.mode === 'boss' ? `Engage the WARLORD (${filled})`
    : m.mode === 'golf' ? `Tee off (${filled})`
    : `Start battle (${filled})`;
  showScreen('lobby');
}
$('startMatchBtn').onclick = () => { Audio.ensure(); sendMsg({ type: 'startMatch' }); };

// ---------------------------------------------------------------------------
// Game setup (also used to restore a resumed match)
// ---------------------------------------------------------------------------
function applySnapshot(m) {
  // WARM restore = this same session was already in this battle and is just
  // resyncing after a background/return. 'Resumes exactly as you left it'
  // means exactly that: your dialled aim, chosen weapon, camera zoom/pan and
  // dock state all survive the resync. A COLD path (fresh boot, new match,
  // next golf hole) still resets everything.
  const warm = S.playing && m.type === 'restore';
  const keep = warm ? {
    aim: S.aim && S.aim[S.you] ? { ...S.aim[S.you] } : null,
    selected: S.selected,
    zoom: S.userZoom, panX: S.panX, panY: S.panY,
    dockShut: $('dock').classList.contains('collapsed'),
  } : null;
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
  S.kinds = (m.kinds || []).slice();
  S.loadout = (m.loadouts && m.loadouts[m.you]) || null;
  S.picking = !!m.pick;
  if (m.pick && !S.loadout) setTimeout(() => openDraft(m.pick.n), 60);
  else $('armouryModal').classList.add('hidden');
  if (S.loadout && !S.loadout.includes(S.selected) && S.selected !== 'railgun') S.selected = null;
  S.horde = m.horde || null;
  S.golf = m.golf || null;
  document.body.classList.toggle('golf', S.mode === 'golf');
  if (S.mode === 'golf' && !(S.weapons || []).some((w) => w.id === S.selected)) S.selected = 'golfball';
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
  // Golf pins the default to the Iron: the strip is bag-ordered with the
  // Driver first (8.22), and a driver default off every tee is exactly the
  // overshoot problem Jordan reported. Warm-restore keep{} still wins below.
  S.selected = S.mode === 'golf' ? 'golfball' : firstAvailableWeapon();
  S.playing = true; S.quick = false; S.anim = null; S.queue = []; S.pendingOver = null; S.warp = null;
  clearKillcam();
  S.deferred = [];                     // start/restore hp+alive win outright — discard held work
  S.particles = []; S.floaters = []; S.rings = []; S.quakes = []; S.muzzle = []; S.flash = 0; S.shake = 0;
  S.bossCharge = null;
  S.plane = null;
  S.mush = null;                       // a nuke cloud must never survive into the next match
  S.chainQueue = [];
  S.recoil = [0, 0];
  S.charging = false; S.pullPointer = null; S.pullAnchor = null; S.userZoom = START_ZOOM; S.panY = 0; S.panX = 0;
  if (keep) {
    // Same-session resync: put back what the player had in hand. The weapon
    // only returns if the restored ammo still allows it (99 = unlimited).
    if (keep.aim) S.aim[S.you] = keep.aim;
    if (keep.selected && (S.ammo[keep.selected] ?? 0) > 0 &&
        (S.weapons || []).some(w => w.id === keep.selected)) S.selected = keep.selected;
    S.userZoom = clampUserZoom(keep.zoom); S.panX = keep.panX; S.panY = keep.panY;
  }
  computeMinY();
  $('overlay').classList.add('hidden');
  showScreen('game');
  resize();
  snapCamera();
  buildWeaponStrip();
  buildScoreboard();
  updateHud(); updateAimUI(); updateFuel(); updateDock();
  closeStageMenus();      // camera + meta always start collapsed
  $('holeScore').classList.remove('show');   // a stale hole card never survives a snapshot
  if (keep) setDockCollapsed(keep.dockShut, false);   // resync: dock stays as you left it
  else if (m.type === 'start') {
    // A new battle: show the player their controls first; the fire handler
    // tucks the dock away after their first shot (see dockIntro above).
    dockIntro = true;
    setDockCollapsed(false, false);
  } else if (m.type === 'hole') {
    // Next golf hole: not a new game — leave the dock as the player has it.
  } else startDockCollapsed();   // cold resume mid-battle: hidden — the tab brings it up
}

// The server hands the turn over on ITS clock — usually while this client is
// still replaying the shot (or watching the golf ball roll out). The entire
// visible handover (banner, dock, FIRE button) waits behind the same gate as
// HP, so a turn never ends on screen before the shell lands / the ball rests.
function onTurn(m) { deferHp(() => applyTurn(m)); }

function applyTurn(m) {
  S.turn = m.turn; S.fuel = m.fuel;
  if (m.ammoSeat === S.you && m.ammo) {
    // The emergency shell: if we were completely dry and the server just slid
    // one cannon round across the table, say so — otherwise it reads as a bug.
    const wasDry = S.loadout && Object.values(S.ammo || {}).every(v => !v);
    S.ammo = m.ammo;
    if (wasDry && m.turn === S.you && (m.ammo.cannon || 0) > 0) showToast('RESERVE SHELL LOADED');
  }
  // 'turn' arrives ~300ms after the server resolved the shot, long before the
  // client finishes replaying the flight. In FFA these flags carry the kill —
  // applied here they grey the scoreboard card AND delete the tank from the
  // canvas (the draw loop skips S.alive[i] === false) while the shell is still
  // in the air. Elimination belongs to the blast; hold it behind the same gate.
  if (m.alive) deferHp(() => { S.alive = m.alive.slice(); updateHud(); });
  if (m.turn === S.you && (!S.selected || (S.ammo[S.selected] ?? 99) <= 0)) S.selected = firstAvailableWeapon();
  // GOLF: reaching the green hands you the putter (Jordan, 8.22). 2200 is the
  // flat table around the cup — the same span the lawn stripes paint.
  if (S.mode === 'golf' && m.turn === S.you && S.golf && S.golf.cup && !golfHoledMe()
      && S.tanks[S.you] && Math.abs(S.tanks[S.you].x - S.golf.cup.x) <= 2200) {
    S.selected = 'putter';
  }
  updateFuel(); updateDock(); buildWeaponStrip();
}

function applyMove(m) {
  const prev = S.tanks[m.seat] ? S.tanks[m.seat].x : m.x;
  S.tanks[m.seat] = { x: m.x, y: m.y };
  // Lean into the direction of travel; stopping springs it back with a rock.
  const d = Math.sign(m.x - prev);
  if (d) { S.leanTarget[m.seat] = d * 0.11; S.moveAt[m.seat] = performance.now(); }
  if (m.seat === S.you) { S.fuel = m.fuel; updateFuel(); }
}

function firstAvailableWeapon() {
  for (const w of S.weapons) {
    // mirror the dock: anything you hold ammo for is selectable
    if (S.loadout && w.id !== 'cannon' && w.id !== 'nuke' && w.id !== 'railgun' &&
        !S.loadout.includes(w.id) && (S.ammo[w.id] ?? 0) <= 0) continue;
    if ((S.ammo[w.id] ?? w.ammo) > 0) return w.id;
  }
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
      (S.names[i] || `Player ${i + 1}`) + (i === S.you ? ' (you)' : '');
    if (i === S.boss) el.classList.add('bossrow');
    row.appendChild(el);
  }
}

// A raid boss deserves a raid-boss bar: full-width, segmented, under the cards.
function updateBossBar() {
  let bar = $('bossbar');
  if (S.boss < 0 || !S.playing && !bar) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'bossbar';
    bar.innerHTML = '<span class="bb-name"></span><div class="bb-track"><i></i></div><span class="bb-num"></span>';
    $('hud-top').appendChild(bar);
  }
  const hp = Math.max(0, Math.round(S.hp[S.boss] ?? 0));
  const cap = (S.hpMax && S.hpMax[S.boss]) || 400;
  const nameEl = bar.querySelector('.bb-name');
  nameEl.innerHTML = UI_IC.crown + ' ';
  nameEl.append(S.names[S.boss] || 'BOSS');
  bar.querySelector('.bb-num').textContent = `${hp} / ${cap}`;
  bar.querySelector('.bb-track i').style.width = `${Math.max(0, Math.min(100, (hp / cap) * 100))}%`;
  bar.classList.toggle('dead', S.alive[S.boss] === false);
}

function updateHud() {
  updateBossBar();
  for (let i = 0; i < S.n; i++) {
    const el = $('p' + i); if (!el) continue;
    const hp = Math.max(0, Math.round(S.hp[i] ?? 0));
    const dead = S.alive[i] === false || hp <= 0;
    el.classList.toggle('dead', dead);
    el.classList.toggle('acting', !!S.playing && S.turn === i && !dead);
    if (S.golf) {                          // golf cards show STROKES, not health
      const done = S.golf.done && S.golf.done[i];
      el.querySelector('.score').textContent = `${(S.golf.strokes && S.golf.strokes[i]) || 0}`;
      el.querySelector('.shots').textContent = done ? 'IN' : `STR · tot ${(S.golf.totals && S.golf.totals[i]) || 0}`;
      el.querySelector('.hpbar').style.display = 'none';
      el.classList.toggle('acting', !!S.playing && S.turn === i);
      el.classList.remove('dead');
      continue;
    }
    el.querySelector('.hpbar').style.display = '';
    el.querySelector('.score').textContent = dead ? '\u2620' : hp;
    el.querySelector('.shots').textContent = 'HEALTH';
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
// Holed out this hole? Your round is over until the next tee — no aiming, no
// arc, no FIRE. (The server refuses the swing anyway; this kills the illusion
// that one is available.) Resets itself: the next 'hole' snapshot arrives with
// done[] refilled false.
function golfHoledMe() { return !!(S.golf && S.golf.done && S.golf.done[S.you]); }
function myTurn() { return S.turn === S.you && S.playing && !S.anim && !golfHoledMe(); }
// You may line up your NEXT shot (aim + weapon) at any time — even while the
// opponent is shooting. Only moving and firing wait for your turn.
function canAim() { return S.playing && !golfHoledMe(); }

function updateDock() {
  const active = myTurn();
  const pin = S.golf && S.golf.cup && S.tanks[S.you]
    ? ` · ${Math.max(0, Math.round(Math.abs(S.golf.cup.x - S.tanks[S.you].x))).toLocaleString()} to the pin`
    : '';
  $('turnLabel').textContent = S.golf
    ? `Hole ${S.golf.hole}/9 · Par ${S.golf.par}${pin}` + (active ? ' — your shot' : (S.playing ? ` — ${S.names[S.turn]}` : ''))
    : S.horde
    ? `${S.horde.kills}/${S.horde.target} down · Wave ${S.horde.wave}` + (active ? ' — YOUR TURN' : (S.playing ? ` — ${S.names[S.turn]}` : ''))
    : active ? 'YOUR TURN' : (S.playing ? `${S.names[S.turn]}'s turn — line up your shot` : '');
  $('fireBtn').disabled = !active || !!S.picking;
  $('moveLeft').disabled = !active || S.fuel < MOVE_MIN;
  $('moveRight').disabled = !active || S.fuel < MOVE_MIN;
  updateDockMini();
  updateWatching();
}

// The collapsed sliver still has to answer "what am I firing, and how?".
function updateDockMini() {
  if (!$('dock').classList.contains('collapsed')) return;
  const aim = myAim() || { angle: 45, power: 60 };
  const w = (S.weapons || []).find(x => x.id === S.selected);
  // Icon + name + ammo pinned bottom-left: the tucked dock must never hide
  // what's loaded (Jordan, 8.22).
  $('dmIcon').innerHTML = (w && ICONS[w.id]) || '';
  $('dmWeapon').textContent = w ? w.name : '';
  const left = w ? (S.ammo[w.id] ?? 99) : 99;
  $('dmAmmo').textContent = left === 99 ? '' : `×${left}`;
  $('dmAngle').textContent = Math.round(aim.angle);
  $('dmPower').textContent = Math.round(aim.power);
}

// ---- Watching: dim the HUD while the shell flies or it is someone else's
// turn. Visual ONLY — every control keeps its pointer-events so you can still
// zoom and pan to follow the shot, and any touch or hover wakes it instantly.
const HUD_OVERLAYS = ['armouryModal', 'overlay', 'helpModal', 'golfCard', 'confirmLeave'];
let hudWakeUntil = 0;
function updateWatching() {
  const g = $('game');
  const overlayOpen = HUD_OVERLAYS.some(id => {
    const el = $(id); return el && !el.classList.contains('hidden');
  });
  // The killcam has its own, stronger rule — never fight it.
  const watching = S.playing && !overlayOpen && !S.killcam && (!!S.anim || S.turn !== S.you);
  g.classList.toggle('watching', !!watching);
  g.classList.toggle('hud-wake', performance.now() < hudWakeUntil);
}
function wakeHud() { hudWakeUntil = performance.now() + 2200; updateWatching(); }
for (const ev of ['pointerdown', 'pointermove', 'focusin']) {
  for (const id of ['hud-top', 'dock']) {
    const el = $(id);
    if (el) el.addEventListener(ev, wakeHud, { passive: true });
  }
}
$('stage').addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('#camBtn, #metaBtn, .zoomctl, .metamenu')) wakeHud();
}, { passive: true, capture: true });

function buildWeaponStrip() {
  const strip = $('weaponStrip'); strip.innerHTML = '';
  for (const w of S.weapons) {
    // Loadout matches: your five picks, the everyone-nuke and the supply-drop
    // railgun always get chips — and so does ANY weapon you actually hold ammo
    // for (a crate prize, the emergency reserve shell). Only never-owned
    // off-loadout weapons stay out of the dock.
    if (S.loadout && w.id !== 'cannon' && w.id !== 'nuke' && w.id !== 'railgun' &&
        !S.loadout.includes(w.id) && (S.ammo[w.id] ?? 0) <= 0) continue;
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
// The ANGLE / POWER readouts are DRUM SLIDERS: the current value sits in the
// middle with three neighbours ghosted either side; drag left/right to roll
// through values (tap a neighbour to jump), and the ‹ › buttons still step.
function drumRange(kind) {
  return kind === 'angle'
    ? [S.aimMin ?? -60, S.aimMax ?? 240]
    : [1, 100];
}
function renderDrum(kind) {
  const el = kind === 'angle' ? $('angleDrum') : $('powerDrum');
  if (!el) return;
  const a = myAim();
  const val = Math.round(kind === 'angle' ? a.angle : a.power);
  const [lo, hi] = drumRange(kind);
  const suffix = kind === 'angle' ? '°' : '';
  let html = '';
  for (let off = -3; off <= 3; off++) {
    const v = val + off;
    const ok = v >= lo && v <= hi;
    html += `<span class="dc${off === 0 ? ' cur' : ''}" data-v="${ok ? v : ''}" style="opacity:${off === 0 ? 1 : (0.62 - Math.abs(off) * 0.14).toFixed(2)}">${ok ? v + (off === 0 ? suffix : '') : ''}</span>`;
  }
  el.innerHTML = html;
}
function updateAimUI() {
  renderDrum('angle');
  renderDrum('power');
  updateDockMini();          // the collapsed sliver mirrors the same numbers
}
// drag-to-roll + tap-to-jump
for (const kind of ['angle', 'power']) {
  const el = kind === 'angle' ? $('angleDrum') : $('powerDrum');
  if (!el) continue;
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (!canAim()) return;
    e.preventDefault();
    const a = myAim();
    drag = { x0: e.clientX, y0: e.clientY, v0: Math.round(kind === 'angle' ? a.angle : a.power), moved: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // Under the portrait rotation shim, "left/right" for the player runs along
    // the device's vertical axis — read the drag on the effective axis.
    const dx = matchMedia('(orientation: portrait)').matches ? (e.clientY - drag.y0) : (e.clientX - drag.x0);
    if (Math.abs(dx) > 4) drag.moved = true;
    const [lo, hi] = drumRange(kind);
    const v = Math.max(lo, Math.min(hi, drag.v0 - Math.round(dx / 13)));   // reel: strip follows the finger
    const a = myAim();
    if (kind === 'angle') setAim(v, a.power); else setAim(a.angle, v);
  });
  const done = (e) => {
    if (drag && !drag.moved && e.target.classList && e.target.classList.contains('dc') && e.target.dataset.v !== '') {
      const v = +e.target.dataset.v;                    // tap a neighbour: jump to it
      const a = myAim();
      if (canAim()) { if (kind === 'angle') setAim(v, a.power); else setAim(a.angle, v); }
    }
    drag = null;
  };
  el.addEventListener('pointerup', done);
  el.addEventListener('pointercancel', () => { drag = null; });
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
// The drag is RELATIVE: wherever the finger lands is the anchor, and the pull
// away from it sets angle + power — your hand never has to cover your own tank
// (Jordan: 'when aiming my finger is in the way... power/angle anywhere on the
// screen'). maxPull was 0.55 of the short side; 0.85 asks ~55% more finger
// travel for the same power ('the power on the finger control is too
// sensitive'), and the anchor-anywhere gesture is what makes the longer pull
// practical — you pick a corner with room.
function maxPull() { return Math.min(view.cssW, view.cssH) * 0.85; }
const AIM_DEADZONE = 6;              // px of travel before a touch counts as a drag
function aimFromVector(dx, dy) {
  // SLINGSHOT (2026-07-30, Jordan): the shot flies OPPOSITE the pull — drag
  // back and down to lob up and forward, like drawing a catapult. Power is
  // still pull distance. (The old scheme fired along the pull direction.)
  const dir = facingOf(S.you);
  const raw = Math.atan2(dy, -dx * dir) * 180 / Math.PI;
  const power = (Math.hypot(dx, dy) / maxPull()) * 100;
  setAim(raw, power);
}
// Pointer offset → draw-space coords. Draw space is CSS pixels (view.cssW ==
// display width), so this is an identity, kept for clarity/robustness.
const evX = (e) => e.offsetX * view.cssW / (view.dispW || 1);
const evY = (e) => e.offsetY * view.cssH / (view.dispH || 1);
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: evX(e), y: evY(e) });
  guideHoldOff = performance.now() + 2600;   // the aim guide yields to a real finger
  // Capture is a nicety (keeps the drag alive off-canvas), never a dependency —
  // if it throws (synthetic pointers, exotic browsers) aiming must still work.
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  if (pointers.size === 2) {
    S.charging = false; S.pullPointer = null; S.pullAnchor = null;
    const [a, b] = [...pointers.values()];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: S.userZoom, cy: (a.y + b.y) / 2, panY: S.panY || 0, cx: (a.x + b.x) / 2, panX: S.panX || 0 };
    return;
  }
  if (!canAim()) return;
  // Anchor only — the aim does not move until the finger does, so a plain tap
  // can never wipe a dialled-in angle/power.
  S.charging = true;
  S.pullAnchor = { x: evX(e), y: evY(e) };
  S.pullPointer = { sx: evX(e), sy: evY(e) };
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
    const dcx = ((a.x + b.x) / 2) - pinchStart.cx;
    if (cam.zoom > 0) S.panX = Math.max(-WW(), Math.min(WW(), pinchStart.panX - dcx / cam.zoom));
    return;
  }
  if (S.charging && S.pullAnchor && canAim()) {
    const x = evX(e), y = evY(e);
    S.pullPointer = { sx: x, sy: y };
    const dx = x - S.pullAnchor.x, dy = y - S.pullAnchor.y;
    const pull = Math.hypot(dx, dy);
    if (pull > AIM_DEADZONE) aimFromVector(dx, dy);
    if (pull > 48) markAimGuideDone();       // a real pull — the gesture is learned
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) { S.charging = false; S.pullPointer = null; S.pullAnchor = null; }
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// ---------------------------------------------------------------------------
// First-play aim guide — a translucent hand demonstrates the drag-anywhere
// gesture on a player's first turns: press an empty spot, pull BACK like a
// slingshot (the shot flies the other way), longer pull = more power. Pure
// overlay — it never writes
// S.aim and never sends a message (relayAim broadcasts REAL aim live, so a
// demo that drove setAim would spray phantom aim at the opponent). It hides
// the instant any finger is down and comes back after a short idle, until the
// player performs one real pull (or fires) — then never again on this device
// (cc_aim_guide, the same one-shot pattern as the other cc_ flags).
// ---------------------------------------------------------------------------
let aimGuideDone = false;
try {
  aimGuideDone = localStorage.getItem('cc_aim_guide') === '1'
    || PROF.shots > 0;   // veterans are grandfathered out — this is for battle one
} catch {}
let guideHoldOff = 0;    // quiet spell after any touch before the demo returns
let guideT0 = 0;         // wall-clock start of the current demo loop
let guideWasOn = false;
let guideForced = false; // replayed on demand from Help > Basics — ignores the done flag
function markAimGuideDone() {
  guideForced = false;   // a real pull or a shot always ends a forced replay
  if (aimGuideDone) return;
  aimGuideDone = true;
  try { localStorage.setItem('cc_aim_guide', '1'); } catch {}
}
function aimGuideOn() {
  if ((aimGuideDone && !guideForced) || !myTurn()) return false;   // my go, live, no replay, not holed
  // S.picking: locked in early, waiting for the others — FIRE is disabled then
  // (see updateDock) and a pull now would consume the one-shot demo pre-battle.
  if (S.killcam || S.charging || S.picking || pointers.size > 0) return false;
  if (performance.now() < guideHoldOff) return false;
  return !HUD_OVERLAYS.some(id => { const el = $(id); return el && !el.classList.contains('hidden'); });
}
// Which way the demo pulls: toward the nearest living ENEMY (the cup in golf),
// so the gesture always demonstrates a shot that makes sense on THIS field.
// Enemy, not neighbour: in co-op Boss Fight the only target is the boss seat,
// and in Alien Invasion only the horde seats — the nearest tank is usually a
// TEAMMATE there, and a first-timer will copy the demo literally.
function guideDir() {
  const me = S.tanks[S.you]; if (!me) return 1;
  if (S.golf && S.golf.cup) return S.golf.cup.x >= me.x ? 1 : -1;
  const kindOf = (i) => (S.kinds && S.kinds[i]) || (i === S.boss ? 'mech' : 'tank');
  const horde = Array.from({ length: S.n }, (_, i) => kindOf(i)).some(k => k !== 'tank' && k !== 'mech');
  let dx = 1, bd = Infinity;
  for (let i = 0; i < S.n; i++) {
    if (i === S.you || S.alive[i] === false || !S.tanks[i]) continue;
    if (S.boss >= 0 && i !== S.boss) continue;            // Boss Fight: humans are allies
    if (horde && kindOf(i) === 'tank') continue;          // Alien Invasion: tanks are allies
    const d = Math.abs(S.tanks[i].x - me.x);
    if (d < bd) { bd = d; dx = S.tanks[i].x - me.x; }
  }
  return dx < 0 ? -1 : 1;
}
// The demo itself. Screen-space, drawn above the world (outside the shake
// transform), under the flash/killcam chrome. Everything it shows is the SAME
// visual the real gesture produces — the anchor cross, the dashed tether, the
// power colour ramp — so what the player copies is exactly what they'll see,
// and the % readout is computed through the real maxPull() so it never lies.
function drawAimGuide() {
  if (!aimGuideOn()) { guideWasOn = false; return; }
  const now = performance.now();
  if (!guideWasOn) { guideWasOn = true; guideT0 = now; }   // always open on the fade-in
  const t = ((now - guideT0) / 1000) % 3.8;
  const IN = 0.45, PRESS = 0.65, DRAG = 2.0, HOLD = 2.6, OUT = 3.0;
  let env = 1;                                             // whole-demo envelope
  if (t < IN) env = t / IN;
  else if (t >= OUT) env = 0;
  else if (t >= HOLD) env = 1 - (t - HOLD) / (OUT - HOLD);
  if (env <= 0.01) return;

  const { cssW, cssH } = view;
  const msz = Math.min(cssW, cssH);
  const dir = guideDir();
  const ANG = 30 * Math.PI / 180;                          // fire angle of the demo lob
  const L = msz * 0.36;
  // SLINGSHOT demo: the hand pulls DOWN AND BACK, the shot flies the other
  // way. Anchor sits toward the target side and high enough that the hand,
  // pulling down from it, still clears a RAISED dock (battles open with the
  // controls shown until the first shot — see dockIntro).
  const ax = cssW * 0.5 + dir * msz * 0.16, ay = cssH * 0.40;
  const fxv = dir * Math.cos(ANG), fyv = -Math.sin(ANG);   // FIRE direction: toward the enemy, up
  const ux = -fxv, uy = -fyv;                              // pull direction: opposite (slingshot)
  const ss = (x) => x * x * (3 - 2 * x);

  let k = 0;                                               // pull progress 0..1
  if (t >= DRAG) k = 1;
  else if (t >= PRESS) k = ss((t - PRESS) / (DRAG - PRESS));
  let fx = ax + ux * L * k, fy = ay + uy * L * k;
  if (t < IN) {                                            // drift in from below
    const q = ss(t / IN);
    fx = ax - ux * msz * 0.05 * (1 - q);
    fy = ay + msz * 0.12 * (1 - q);
  } else if (t >= DRAG && t < HOLD) {
    fy += Math.sin((t - DRAG) * 9) * 1.5;                  // held finger breathes
  }
  const pressed = t >= IN && t < HOLD;
  const pct = Math.min(100, (L * k / maxPull()) * 100);    // honest readout

  ctx.save();
  try {
    ctx.globalAlpha = env;

    // Touch ripples on press and on lift-off.
    const ripple = (q, x, y) => {
      ctx.globalAlpha = env * (1 - q) * 0.8;
      ctx.strokeStyle = 'rgba(159,216,255,.9)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6 + 26 * q, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = env;
    };
    if (t >= IN && t < IN + 0.4) ripple((t - IN) / 0.4, ax, ay);
    if (t >= HOLD) ripple((t - HOLD) / (OUT - HOLD), fx, fy);

    // Anchor cross + dashed tether — the real gesture's style (the S.charging
    // block at the end of drawAim), printed a touch bolder here because the
    // pull line IS the lesson and must not be missable over a bright sky.
    if (pressed && k > 0.02) {
      ctx.strokeStyle = 'rgba(159,216,255,.62)'; ctx.lineWidth = 2;
      ctx.setLineDash([5, 6]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(fx, fy); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (pressed) {
      ctx.strokeStyle = 'rgba(159,216,255,.75)'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ax - 7, ay); ctx.lineTo(ax + 7, ay);
      ctx.moveTo(ax, ay - 7); ctx.lineTo(ax, ay + 7);
      ctx.stroke();
    }

    // Direction chevrons on the far side of the ANCHOR, along the FIRE
    // direction — the pull draws back, the shot releases THAT way. Arc-dot
    // colours: dark under, hot yellow over.
    if (k > 0.55) {
      const ca = Math.min(1, (k - 0.55) / 0.35) * env;
      const px2 = -fyv, py2 = fxv;                         // perpendicular
      for (let j = 0; j < 3; j++) {
        const d0 = 26 + j * 17;
        const cx2 = ax + fxv * d0, cy2 = ay + fyv * d0;
        const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(now / 160 - j * 1.1));
        ctx.globalAlpha = ca * pulse;
        for (const [w2, st] of [[5, 'rgba(10,12,16,.6)'], [2.5, 'rgba(255,214,70,.95)']]) {
          ctx.strokeStyle = st; ctx.lineWidth = w2; ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx2 - fxv * 7 + px2 * 7, cy2 - fyv * 7 + py2 * 7);
          ctx.lineTo(cx2 + fxv * 4, cy2 + fyv * 4);
          ctx.lineTo(cx2 - fxv * 7 - px2 * 7, cy2 - fyv * 7 - py2 * 7);
          ctx.stroke();
        }
        ctx.lineCap = 'butt';
      }
      ctx.globalAlpha = env;
    }

    // Live % beside the anchor cross (offset off the chevron lane), on the
    // real gesture's colour ramp.
    if (pressed && k > 0.05) {
      const pr = pct / 100;
      const col = pr < 0.5 ? lerpColor([76, 232, 143], [255, 210, 63], pr / 0.5)
        : lerpColor([255, 210, 63], [255, 90, 82], (pr - 0.5) / 0.5);
      ctx.font = '900 15px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(10,14,18,.7)';
      ctx.fillText(`${Math.round(pct)}%`, ax - dir * 30 + 1, ay - 23);
      ctx.fillStyle = col;
      ctx.fillText(`${Math.round(pct)}%`, ax - dir * 30, ay - 24);
    }

    // The hand — leaning INTO the pull, so the lean is negated vs the old
    // forward-drag demo.
    const hs = Math.max(52, Math.min(96, msz * 0.17));
    const squash = pressed ? 0.94 : t >= HOLD ? 1.05 : 1.0;
    drawGuideHand(fx, fy, hs * squash, -(0.10 + 0.12 * k), dir, pressed);

    // Caption — plain-text house voice, dark under-print for legibility.
    const line = t < DRAG ? 'PULL BACK LIKE A SLINGSHOT' : 'LONGER PULL = MORE POWER';
    const cy3 = Math.max(cssH * 0.16, ay - msz * 0.42);   // proportional floor clears the scoreboard
    ctx.font = '900 14px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.globalAlpha = env * 0.92;
    ctx.fillStyle = 'rgba(10,14,18,.7)'; ctx.fillText(line, cssW / 2 + 1, cy3 + 1);
    ctx.fillStyle = '#eaf4ff'; ctx.fillText(line, cssW / 2, cy3);
  } catch {} finally {
    ctx.restore();
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }
}
// A translucent pointing hand, drawn from scratch (custom canvas art — house
// rule, no emoji). Fingertip at (x, y), fist and wrist trailing below; dir
// mirrors the whole hand so the wrist always trails away from the pull. lean
// tilts it into the motion; the mirror flips the rotation sense on its own.
function drawGuideHand(x, y, H, lean, dir, pressed) {
  const w = H * 0.16;                                      // index-finger width
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir < 0 ? -1 : 1, 1);
  ctx.rotate(lean);
  if (pressed) {                                           // contact glow at the tip
    ctx.fillStyle = 'rgba(159,216,255,.30)';
    ctx.beginPath(); ctx.arc(0, 0, w * 0.85, 0, Math.PI * 2); ctx.fill();
  }
  ctx.beginPath();
  // Index finger: rounded tip at the origin, edges running down to the fist.
  ctx.moveTo(-w * 0.5, w * 0.7);
  ctx.quadraticCurveTo(-w * 0.56, -w * 0.1, 0, -w * 0.12);
  ctx.quadraticCurveTo(w * 0.56, -w * 0.1, w * 0.5, w * 0.7);
  ctx.lineTo(w * 0.52, H * 0.34);
  // Three curled knuckles marching to the outside of the fist.
  ctx.quadraticCurveTo(w * 0.95, H * 0.27, w * 1.28, H * 0.33);
  ctx.quadraticCurveTo(w * 1.65, H * 0.30, w * 1.94, H * 0.40);
  ctx.quadraticCurveTo(w * 2.32, H * 0.38, w * 2.52, H * 0.52);
  // Outside of the palm down to the wrist, then across the base.
  ctx.quadraticCurveTo(w * 2.72, H * 0.68, w * 2.5, H * 0.86);
  ctx.quadraticCurveTo(w * 2.2, H * 1.02, w * 1.5, H * 1.02);
  ctx.lineTo(w * 0.1, H * 1.04);
  // Heel of the hand and the thumb bulge back up to the index.
  ctx.quadraticCurveTo(-w * 0.72, H * 1.02, -w * 0.86, H * 0.76);
  ctx.quadraticCurveTo(-w * 1.12, H * 0.56, -w * 0.72, H * 0.46);
  ctx.quadraticCurveTo(-w * 0.6, H * 0.42, -w * 0.52, H * 0.36);
  ctx.closePath();
  ctx.fillStyle = 'rgba(238,244,250,.42)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(15,22,30,.60)';
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.stroke();
  // The thumb's crease, so the silhouette reads as a hand and not a mitten.
  ctx.strokeStyle = 'rgba(15,22,30,.35)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-w * 0.62, H * 0.52);
  ctx.quadraticCurveTo(-w * 0.2, H * 0.60, w * 0.05, H * 0.56);
  ctx.stroke();
  ctx.restore();
}

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
// pull TOWARD the enemy (slingshot: the shot flies opposite the pull), or step
// the ANGLE readout past 90°.

$('fireBtn').onclick = () => {
  Audio.ensure();
  if (!myTurn()) return;
  const left = S.ammo[S.selected] ?? 99;
  if (left <= 0) { showToast('Out of ammo — pick another weapon'); return; }
  const a = myAim();
  sendMsg({ type: 'fire', weapon: S.selected, angle: a.angle, power: a.power });
  if (navigator.vibrate) navigator.vibrate(30);
  markAimGuideDone();                        // they can shoot — no more demo, ever
  if (dockIntro) { dockIntro = false; setDockCollapsed(true, true); }   // intro over: tuck away
  S.charging = false; S.pullPointer = null; S.pullAnchor = null;
  updateDock();
};
// The cap's drop-and-settle has to outlive the pointer, so it cannot ride
// :active. Driven from pointerdown so it bites the instant you touch, and
// cleared on animationend so a rapid second tap restarts it.
{
  const fireBtn = $('fireBtn');
  const firePress = () => {
    fireBtn.classList.remove('is-pressed');
    void fireBtn.offsetWidth;                   // reflow, or a re-tap won't restart
    fireBtn.classList.add('is-pressed');
  };
  fireBtn.addEventListener('pointerdown', () => { if (!fireBtn.disabled) firePress(); });
  fireBtn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !fireBtn.disabled) firePress();
  });
  fireBtn.addEventListener('animationend', (e) => {
    if (e.animationName === 'fbDrop') fireBtn.classList.remove('is-pressed');
  });
}

// ---------------------------------------------------------------------------
// Terrain collapse — destroyed ground crumbles instead of popping to its new
// shape. Columns fall with gravity easing, radiating out from the blast;
// raised earthworks pile up with a soft settle instead.
// ---------------------------------------------------------------------------
// The shot's terrain change is QUEUED up front and released in pieces: every
// detonation frees the columns around its own impact, so an airstrike carves
// crater after crater under each falling bomb instead of one big reveal at
// the end. applyResolve releases anything left over as a safety net.
function queueTerrainDiff(diff) {
  finishTerrainAnim();                       // snap any still-running collapse
  if (!diff) return;
  const { from, values } = diff;
  const old = new Array(values.length);
  for (let i = 0; i < values.length; i++) old[i] = S.terrain[from + i];
  S.terrainAnim = { from, old, target: values.slice(), delays: new Array(values.length).fill(Infinity), t: 0, dur: 0.55 };
}
function releaseTerrainCols(x0, x1) {
  const A = S.terrainAnim; if (!A) return;
  const i0 = Math.max(0, Math.floor(x0 - A.from));
  const i1 = Math.min(A.target.length - 1, Math.ceil(x1 - A.from));
  if (i1 < i0) return;
  const mid = (i0 + i1) / 2;
  for (let i = i0; i <= i1; i++) {
    if (A.delays[i] !== Infinity) continue;
    A.delays[i] = A.t + (Math.abs(i - mid) / Math.max(1, (i1 - i0) / 2)) * 0.12 + Math.random() * 0.06;
  }
}
function releaseAllTerrain() {
  const A = S.terrainAnim; if (!A) return;
  for (let i = 0; i < A.delays.length; i++) {
    if (A.delays[i] === Infinity) A.delays[i] = A.t + Math.random() * 0.08;
  }
}
function startTerrainCollapse(diff) { queueTerrainDiff(diff); releaseAllTerrain(); }
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

function enqueueShot(m) {
  if (m.killcam) startClipRecording();          // the fatal shot gets taped
  S.queue.push(m);
  if (!S.anim) startNextShot();
}

// ---------------------------------------------------------------------------
// Sharing: a painted result card (always available) and a recording of the
// killcam replay (where MediaRecorder + canvas.captureStream exist). The card
// is the growth loop: one tap -> a branded image in the group chat.
// ---------------------------------------------------------------------------
let clipRec = null, clipChunks = [], lastClip = null;
function clipMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ['video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return null;
}
function startClipRecording() {
  const mime = clipMime();
  if (!mime || clipRec || typeof canvas.captureStream !== 'function') return;
  try {
    const stream = canvas.captureStream(30);
    clipChunks = []; lastClip = null;
    clipRec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
    clipRec.ondataavailable = (e) => { if (e.data && e.data.size) clipChunks.push(e.data); };
    clipRec.onstop = () => {
      if (clipChunks.length) lastClip = new Blob(clipChunks, { type: mime.split(';')[0] });
      clipRec = null;
      const b = $('shareClipBtn'); if (b && lastClip) b.classList.remove('hidden');
    };
    clipRec.start(250);
    setTimeout(stopClipRecording, 12000);       // hard cap — a clip, not a broadcast
  } catch { clipRec = null; }
}
function stopClipRecording() { try { if (clipRec && clipRec.state !== 'inactive') clipRec.stop(); } catch { clipRec = null; } }

async function shareBlob(blob, filename, fallbackName) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Canyons & Cannons', text: 'Canyons & Cannons — play me: https://canyons-and-cannons.onrender.com' }); return; } catch {}
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = fallbackName || filename;
  document.body.appendChild(a); a.click(); a.remove();
  showToast('Saved — share it anywhere');
}

// Paint the 1200x630 result card: verdict, the standings, and the pitch.
function buildResultCard() {
  const R = S.lastResult || {};
  const c = document.createElement('canvas'); c.width = 1200; c.height = 630;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 630);
  g.addColorStop(0, '#0b1020'); g.addColorStop(0.62, '#182246'); g.addColorStop(1, '#3a2a48');
  x.fillStyle = g; x.fillRect(0, 0, 1200, 630);
  x.fillStyle = '#ffb45a';                                     // low sun
  x.fillRect(920, 340, 150, 8); x.fillRect(940, 358, 110, 6); x.fillRect(958, 372, 74, 5);
  x.fillStyle = '#131c38';                                     // far mesas
  x.beginPath(); x.moveTo(0, 630); x.lineTo(0, 470); x.lineTo(170, 470); x.lineTo(230, 380); x.lineTo(330, 380); x.lineTo(390, 470); x.lineTo(560, 470); x.lineTo(640, 350); x.lineTo(760, 350); x.lineTo(830, 470); x.lineTo(1040, 470); x.lineTo(1100, 410); x.lineTo(1200, 410); x.lineTo(1200, 630); x.closePath(); x.fill();
  x.fillStyle = '#0d1329';                                     // near rim
  x.beginPath(); x.moveTo(0, 630); x.lineTo(0, 560); x.lineTo(300, 560); x.lineTo(360, 510); x.lineTo(520, 510); x.lineTo(580, 560); x.lineTo(1200, 560); x.lineTo(1200, 630); x.closePath(); x.fill();
  x.textAlign = 'left';
  x.fillStyle = '#ff9d3d';
  x.font = '900 34px system-ui, sans-serif';
  x.fillText('CANYONS & CANNONS', 64, 88);
  x.fillStyle = R.win ? '#3ce88f' : '#ff6b6b';
  x.font = '900 92px system-ui, sans-serif';
  x.fillText(R.title || 'BATTLE COMPLETE', 60, 200);
  x.fillStyle = '#aeb9d6';
  x.font = '600 30px system-ui, sans-serif';
  x.fillText(R.subtitle || '', 64, 250);
  // standings
  x.font = '700 34px system-ui, sans-serif';
  let yy = 330;
  for (const line of (R.lines || []).slice(0, 4)) {
    x.fillStyle = line.me ? '#54c8ff' : '#e8ecf5';
    x.fillText(line.text, 64, yy);
    yy += 52;
  }
  x.fillStyle = '#ffd23f';
  x.font = '700 26px system-ui, sans-serif';
  if (R.statLine) x.fillText(R.statLine, 64, 560);
  x.fillStyle = '#8a93a8';
  x.textAlign = 'right';
  x.font = '700 28px system-ui, sans-serif';
  x.fillText('play me — canyons-and-cannons.onrender.com', 1140, 600);
  return c;
}

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
  queueTerrainDiff(m.terrainDiff);   // craters release under each detonation
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
        detonate(pr.det, pr.beacon); pr.exploded = true;
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

function detonate(det, beacon) {
  // The Air Strike's target beacon is a SMOKE SIGNAL, not a warhead: it marks
  // the spot for the plane and does nothing else. It must return BEFORE the
  // terrain release below — the bombs land within ~560 units of it and the
  // release radius is 700, so freeing terrain here collapsed the whole target
  // area the moment the marker landed, long before a single bomb arrived.
  if (beacon) { if (det && Number.isFinite(det.x)) markerSmoke(det); return; }
  // This blast frees its own patch of the queued terrain change — the ground
  // breaks where and WHEN each bomb lands.
  if (det && Number.isFinite(det.x)) {
    const relR = Math.max(700, (det.r || 0) * 1.3 + 200);
    releaseTerrainCols(det.x - relR, det.x + relR);
  }
  // Teleport: no blast at all — the whole event IS the warp. Handled first so a
  // teleport det never falls into the round-particle burst-puff branch below.
  if (det.tp) { startWarp(det.tp); return; }
  // Seismic Slam: no fireball — the EARTH convulses. Ground rings, rock chunks
  // and a set of dust pillars via S.quakes; drawQuakes renders the columns.
  if (S.anim && S.anim.m && S.anim.m.weapon === 'b_quake') {
    S.rings.push({ x: det.x, y: det.y, r: det.r * 0.08, rMax: det.r * 2.6, age: 0, life: 0.75, color: '#c98a4b' });
    S.rings.push({ x: det.x, y: det.y, r: det.r * 0.05, rMax: det.r * 1.5, age: 0, life: 0.5, color: '#ffd9a0' });
    S.quakes.push({ x: det.x, y: det.y, r: det.r, age: 0, life: 0.95 });
    for (let k = 0; k < 30; k++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9, sp = 300 + Math.random() * 900;
      S.particles.push({ x: det.x + (Math.random() - 0.5) * det.r * 0.8, y: det.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5 + Math.random() * 0.5, age: 0,
        r: 2.2 + Math.random() * 3, g: 1.6, shape: 'rect', color: k % 3 ? '#7a5f3c' : '#4d3b22' });
    }
    S.shake = Math.max(S.shake, 26);
    Audio.boom(det.r);
    return;
  }
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

// The Air Strike marker: coloured smoke boiling off the ground where the
// beacon struck, so the target reads for the whole run-in. Deliberately no
// flash, no ring, no debris — nothing here is an impact.
function markerSmoke(det) {
  const gy = surfaceAt(det.x);
  for (let i = 0; i < 16; i++) {
    const t = i / 16;
    S.particles.push({
      x: det.x + (Math.random() - 0.5) * 180, y: gy - Math.random() * 60,
      vx: (Math.random() - 0.5) * 90, vy: -150 - Math.random() * 190,
      life: 1.5 + Math.random() * 1.1, age: 0, r: 12 + Math.random() * 16, g: 0.06,
      color: t < 0.45 ? 'rgba(235,238,245,0.5)' : 'rgba(120,132,150,0.45)',
    });
  }
  // a few bright motes so the marker catches the eye without reading as a blast
  for (let i = 0; i < 7; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.5, sp = 90 + Math.random() * 190;
    S.particles.push({ x: det.x, y: gy - 12, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.5 + Math.random() * 0.4, age: 0, r: 1.9, g: 0.5, shape: 'spark', color: '#9fd8ff' });
  }
  Audio.boom(90);                       // a soft thud, not a detonation
}

function applyResolve(m) {
  trackMyShot(m);
  if (m.terrainDiff) {
    if (!S.terrainAnim) queueTerrainDiff(m.terrainDiff);   // direct path (no replay queued it)
    releaseAllTerrain();                                   // free whatever no blast claimed
  }
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
        if (i !== S.you && S.anim && S.anim.m && S.anim.m.by === S.you) trackMyKill(i);
      }
    }
  }
  S.hazards = m.hazards || [];
  if (m.scorch) S.scorch = m.scorch;
  if (m.props) S.props = m.props;
  if (m.ruins) S.ruins = m.ruins;
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
        det: { x: ev.x, y: ev.y - 60, r: ev.kind === 'barrel' ? 640 : 560, kind: 'crater',
               color: ev.kind === 'barrel' ? '#ff8a3d' : '#aeb9c9', hz: null },
      });
    }
  }
  if (m.ammoSeat === S.you && m.ammo) S.ammo = m.ammo;
  if (m.golf) {
    S.golf = { ...(S.golf || {}), ...m.golf };
    const t = S.tanks[m.golf.noteSeat];
    const NOTES = { holed: 'SUNK IT!', hazard: 'HAZARD +1', oob: 'OUT OF BOUNDS +1', capped: 'PICKED UP', water: 'IN THE WATER — DROP +1' };
    if (m.golf.note && t) S.floaters.push({ x: t.x, y: t.y - 420, text: NOTES[m.golf.note] || '', age: 0, life: 1.8, color: m.golf.note === 'holed' ? '#b6ff5a' : '#ffd23f' });
    // A splash SELLS the ruling: white spray + blue droplets where the replay
    // path ends (integrate parks the final point ON the waterline). Sparks and
    // rects only — round particles are banned from the front layer.
    if (m.golf.note === 'water') {
      const pr = m.projectiles && m.projectiles[0];
      const tip = pr && pr.path && pr.path.length ? pr.path[pr.path.length - 1] : null;
      if (tip) {
        for (let i = 0; i < 14; i++) {
          S.particles.push({
            x: tip[0] + (Math.random() - 0.5) * 260, y: tip[1] - Math.random() * 60,
            vx: (Math.random() - 0.5) * 900, vy: -400 - Math.random() * 900,
            life: 0.5 + Math.random() * 0.4, age: 0, r: 1.6 + Math.random() * 1.6,
            g: 1.15, shape: i % 3 ? 'spark' : 'rect',
            color: i % 2 ? '#bfe4ff' : '#e8f6ff',
          });
        }
      }
    }
    if (m.golf.note === 'holed' && m.golf.noteSeat === S.you && m.golf.strokes && m.golf.strokes[S.you] === 1) { PROF.aces++; award('ace'); saveProf(); }
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
function applyCrateTaken(m) {
  if (m.how === 'shot' && m.seat === S.you) award('robber');
  S.crates = S.crates.filter(c => c.id !== m.id);
  if (m.hp) S.hp = m.hp.slice();             // pickups can RAISE health (repair) — trust the server
  if (m.shield) S.shield = m.shield.slice();
  if (m.ammoSeat === S.you && m.ammo) { S.ammo = m.ammo; buildWeaponStrip(); }
  const t = S.tanks[m.seat];
  if (t) S.floaters.push({ x: t.x, y: t.y - 380, text: (m.how === 'shot' ? 'CRACKED OPEN: ' : 'SUPPLIES: ') + (m.detail || m.kind.toUpperCase()), age: 0, life: 1.6, color: '#ffd23f' });
  updateHud();
}

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
        if (i !== S.you && S.biome === 'volcanic' && S.tanks[i] && S.lavaY && S.tanks[i].y >= S.lavaY - 320) award('melt');
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
  const r = 240 * cam.zoom;                             // world-scale: sprite == hitbox at every zoom
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
const MUSH_DARK = [72, 70, 74];      // charcoal shadow — cooler, less muddy
const MUSH_LIT  = [236, 234, 230];   // near-white sunlit cap
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
    // Barely any drift: the column stays planted on the impact point.
    wind: (Math.random() < 0.5 ? -1 : 1) * (0.02 + Math.random() * 0.03),
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
    sg.addColorStop(0,    `rgba(255,150,54,${A * 0.55})`);    // incandescent base
    sg.addColorStop(0.30, `rgba(160,120,96,${A * 0.78})`);
    sg.addColorStop(0.65, `rgba(120,114,118,${A * 0.82})`);
    sg.addColorStop(1,    `rgba(190,186,184,${A * 0.74})`);   // pale where it meets the cap
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

// Between golf holes: what everyone just carded (Jordan, 8.22 — strokes and
// how many under/over par). The finished hole's strokes ride the fresh 'hole'
// snapshot in g.grid; its 0-based index is g.hole - 2 (g.hole is the NEW one).
let holeScoreTimer = 0;
function showHoleScore(g) {
  const hi = (g.hole || 1) - 2;
  if (hi < 0 || !g.grid || !g.pars) return;
  const par = g.pars[hi];
  const term = (s, d) => s === 1 ? 'ACE' : d <= -3 ? 'ALBATROSS' : d === -2 ? 'EAGLE'
    : d === -1 ? 'BIRDIE' : d === 0 ? 'PAR' : d === 1 ? 'BOGEY' : d === 2 ? 'DOUBLE BOGEY' : null;
  const rel = (d) => d === 0 ? 'LEVEL PAR' : `${Math.abs(d)} ${d < 0 ? 'UNDER' : 'OVER'} PAR`;
  const rows = [];
  for (let i = 0; i < S.n; i++) {
    const s = g.grid[i] && g.grid[i][hi];
    if (!s) continue;                                   // never teed off (joined late)
    const d = s - par, t = term(s, d);
    const cls = d < 0 ? 'hs-under' : d > 0 ? 'hs-over' : '';
    rows.push(`<div class="hs-row"><b>${S.names[i] || ''}</b>` +
      `<span class="${cls}">${s} STROKE${s === 1 ? '' : 'S'} · ${rel(d)}${t ? ` (${t})` : ''}</span></div>`);
  }
  if (!rows.length) return;
  const el = $('holeScore');
  el.innerHTML = `<div class="hs-head">HOLE ${hi + 1} · PAR ${par}</div>${rows.join('')}` +
    `<div class="hs-next">NEXT: HOLE ${g.hole} OF ${g.holes} · PAR ${g.par}</div>`;
  el.classList.add('show');
  clearTimeout(holeScoreTimer);
  holeScoreTimer = setTimeout(() => el.classList.remove('show'), 4600);
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
  try { trackGameOver(m); } catch {}
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
    if (g.pars && g.strokes) {                     // full scorecard summary
      $('finalScores').innerHTML =
        '<div class="gc-scroll" style="width:100%"><table class="gc-table">' +
        golfCardHTML({ grid: g.strokes, pars: g.pars, totals: g.totals, finished: true }) +
        '</table></div>';
    } else {                                       // legacy fallback: totals only
      $('finalScores').innerHTML = g.totals.map((t, i) =>
        `<div class="fs" style="--seat:${seatColor(i)}"><b>${t}</b><span>${(S.names[i] || '')} strokes</span></div>`
      ).join('');
    }
    $('rematchBtn').style.display = '';
    $('overlay').classList.remove('hidden');
    return;
  }
  if (m.team) {                                  // team-mode verdicts (boss / horde)
    if (S.mode === 'aliens' && m.team === 'players') { title = 'INVASION REPELLED!'; cls = 'win'; win = true; }
    else if (S.mode === 'aliens' && m.team === 'horde') { title = 'The invasion overruns you'; cls = 'lose'; }
    else if (m.team === 'players') { title = 'WARLORD-7 DESTROYED!'; cls = 'win'; win = true; }
    else if (m.team === 'boss') { title = 'Your squad was wiped out'; cls = 'lose'; }
    else { title = 'Mutual destruction!'; cls = 'draw'; }
    Audio.chime(win);
    showOverlay(title, m.hp, cls, false);
    // After-action report: what each commander dealt to the boss and took back.
    if (m.stats) {
      const rows = [];
      for (let i = 0; i < S.n; i++) {
        if (i === S.boss) continue;
        rows.push(`<div class="br-row" style="--seat:${seatColor(i)}"><span class="br-name">${S.names[i] || ''}</span>` +
          `<span class="br-stat">${UI_IC.sword} ${m.stats.dealt[i] || 0} dealt</span><span class="br-stat">${UI_IC.shieldIc} ${m.stats.received[i] || 0} taken</span></div>`);
      }
      const rep = document.createElement('div');
      rep.id = 'battleReport';
      rep.innerHTML = `<div class="br-title">AFTER-ACTION REPORT</div>${rows.join('')}`;
      const fsEl = $('finalScores');
      fsEl.parentNode.insertBefore(rep, fsEl.nextSibling);
    }
    // The spoils: felling the WARLORD unlocks the Midnight paint, permanently.
    if (m.loot && win) {
      let lootLine = `${UI_IC.coin} WAR SPOILS: salvage recovered`;
      try {
        if (localStorage.getItem('cc_loot_midnight') !== '1') {
          localStorage.setItem('cc_loot_midnight', '1');
          lootLine = `${UI_IC.coin} WAR SPOILS: <b>Midnight paint unlocked!</b>`;
        }
      } catch {}
      const lt = document.createElement('div');
      lt.id = 'lootLine';
      lt.innerHTML = lootLine;
      $('resultTitle').parentNode.insertBefore(lt, $('resultTitle').nextSibling);
      buildSkinRow();
    }
    return;
  }
  if (m.winner === -1) { title = 'Mutual destruction!'; cls = 'draw'; }
  else if (m.winner === S.you) { title = S.n > 2 ? 'Last tank standing!' : 'Enemy destroyed!'; cls = 'win'; win = true; }
  else if (S.n > 2) { title = `${S.names[m.winner]} takes the canyon`; cls = 'lose'; }
  else { title = 'Your tank was destroyed'; cls = 'lose'; }
  Audio.chime(win);
  showOverlay(title, m.hp, cls, false);
}
function showOverlay(title, hp, cls, hideRematch) {
  stopClipRecording();
  // Freeze what the share card needs the moment the verdict is known.
  S.lastResult = {
    title: (title || '').replace(/[a-z].*$/s, (m0) => m0),      // keep as-is; card truncates visually
    win: cls === 'win',
    subtitle: `${({ duel: 'Duel', ffa: 'Free-for-all', boss: 'Boss Fight', golf: 'Artillery Golf', aliens: 'Alien Invasion' })[S.mode] || 'Battle'} · ${S.biome || ''} canyon`,
    lines: (hp || []).map((h, i) => ({ me: i === S.you, text: `${S.names[i] || 'Player'} — ${Math.max(0, h)} Health` })),
    statLine: PROF.maxDmg ? `Career: ${PROF.kills} kills · biggest hit ${PROF.maxDmg} · longest ${PROF.longest}` : '',
  };
  const rt = $('resultTitle'); rt.textContent = title; rt.className = 'result ' + cls;
  const oldRep = $('battleReport'); if (oldRep) oldRep.remove();
  const oldLoot = $('lootLine'); if (oldLoot) oldLoot.remove();
  const fs = $('finalScores');
  fs.innerHTML = hp ? hp.map((h, i) =>
    `<div class="fs" style="--seat:${seatColor(i)}"><b>${Math.max(0, h)}</b><span>${(S.names[i] || '')} Health</span></div>`
  ).join('') : '';
  $('rematchBtn').style.display = hideRematch ? 'none' : '';
  const clipBtn = $('shareClipBtn');
  if (clipBtn) clipBtn.classList.toggle('hidden', !lastClip);
  $('overlay').classList.remove('hidden');
}
$('shareCardBtn').onclick = () => {
  buildResultCard().toBlob((b) => { if (b) shareBlob(b, 'canyons-result.png'); }, 'image/png');
};
$('shareClipBtn').onclick = () => {
  if (!lastClip) return;
  const ext = lastClip.type.includes('mp4') ? 'mp4' : 'webm';
  shareBlob(lastClip, `canyons-replay.${ext}`);
};
$('rematchBtn').onclick = () => sendMsg({ type: 'rematch' });
$('exitBtn').onclick = () => { clearResume(); sendMsg({ type: 'leave' }); location.href = location.origin; };

// Leave mid-game — always behind an "are you sure?" so a stray tap can't quit.
$('leaveBtn').onclick = () => { closeStageMenus(); $('confirmLeave').classList.remove('hidden'); };
$('stayBtn').onclick = () => $('confirmLeave').classList.add('hidden');
$('confirmLeave').onclick = (e) => { if (e.target.id === 'confirmLeave') $('confirmLeave').classList.add('hidden'); };
$('leaveYesBtn').onclick = () => { clearResume(); sendMsg({ type: 'leave' }); location.href = location.origin; };

// ---------------------------------------------------------------------------
// Help — controls guide + full arsenal, one row per weapon, built from the
// same ICONS/TRAJ art the dock uses so the guide always matches the game.
// ---------------------------------------------------------------------------
const HELP_WEAPONS = [
  { id: 'cannon',   name: 'Cannon',        note: 'unlimited',        desc: 'Standard HE shell. Reliable, always available.' },
  { id: 'mortar',   name: 'Heavy Mortar',  note: '2 rounds',         desc: 'A massive lobbed round that cracks open the landscape.' },
  { id: 'volley',   name: 'Rocket Volley', note: '3 rounds',         desc: 'Six rockets in a fan — saturates a whole slope.' },
  { id: 'cluster',  name: 'Cluster Bomb',  note: '2 rounds',         desc: 'Bursts at the top of its arc into five falling bomblets.' },
  { id: 'napalm',   name: 'Napalm',        note: '2 rounds',         desc: 'Splashes burning fuel over a wide area. The fire keeps biting for several turns.' },
  { id: 'gas',      name: 'Toxic Gas',     note: '2 rounds',         desc: 'No blast — a wide lingering cloud that poisons anyone inside it every couple of seconds.' },
  { id: 'airstrike', name: 'Air Strike',   note: '2 beacons',        desc: 'Fire a beacon; a bomber flattens wherever it lands.' },
  { id: 'buster',   name: 'Bunker Buster', note: '2 rounds',         desc: 'Burrows deep before detonating — digs a brutal pit under whatever it hits.' },
  { id: 'minigun',  name: 'Minigun',       note: '2 belts',          desc: 'Fourteen rounds in one long ripping burst. Death by a thousand cuts.' },
  { id: 'wall',     name: 'Earthworks',    note: '3 charges',        desc: 'Heaps up a huge mound of dirt where it lands. Deals no damage — pure cover.' },
  { id: 'teleport', name: 'Teleport',      note: '2 charges',        desc: 'Warp your tank to wherever the shell lands. No blast — pick your ground.' },
  { id: 'nuke',     name: 'Tactical Nuke', note: '1 warhead',        desc: 'The big one. Leaves a fallout cloud over the crater that keeps hurting.' },
  { id: 'railgun',  name: 'Railgun',       note: 'supply drops only', desc: 'A flat hypervelocity slug that punches straight through hills. Only found in supply crates.' },
  // Bag order — matches the in-game strip (8.22): Driver, Iron, Putter.
  { id: 'driver',   name: 'Driver',        note: 'Golf mode',        desc: 'Maximum carry and it keeps running after it lands. Off the tee, nothing else comes close.' },
  { id: 'golfball', name: 'Iron',          note: 'Golf mode',        desc: 'The all-rounder: honest carry, bites on landing, modest release.' },
  { id: 'putter',   name: 'Putter',        note: 'Golf mode',        desc: 'Never leaves the turf — a pure roll whose pace you set. The closer, the deadlier.' },
];
let helpBuilt = false;
function buildHelp() {
  if (helpBuilt) return; helpBuilt = true;
  // One self-contained row per round: icon, name, ammo note, what it does, and
  // its flight-shape badge. Nothing is hidden behind a tap (the old grid made
  // you press every cell to read a one-line detail below it).
  $('helpWeapons').innerHTML = HELP_WEAPONS.map(w =>
    `<div class="hw-row">${ICONS[w.id] || ''}` +
    `<div class="hw-txt"><div class="hw-top"><b class="hw-nm">${w.name}</b><i class="hw-note">${w.note}</i></div>` +
    `<p class="hw-desc">${w.desc}</p></div>${TRAJ[w.id] || ''}</div>`).join('');
  $('helpTabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    for (const el of $('helpTabs').children) el.classList.toggle('active', el === t);
    for (const pane of document.querySelectorAll('#helpModal .tabpane'))
      pane.classList.toggle('active', pane.dataset.pane === t.dataset.tab);
  });
}
const openHelp = () => {
  buildHelp();
  // The demo replay needs a live battlefield AND a player who still takes
  // turns — the home screen and an eliminated spectator don't qualify.
  const db = $('helpDemoBtn');
  db.classList.toggle('hidden', !S.playing || S.alive[S.you] === false);
  // The label mirrors the demo's REAL visibility predicate (aimGuideOn's flag
  // term), not just the force switch: for a first-timer the natural guide is
  // already running, and 'Hide' must genuinely end it.
  db.textContent = (!aimGuideDone || guideForced) ? 'Hide the aim demo' : 'Replay the aim demo';
  $('helpModal').classList.remove('hidden');
};
// Toggle the ghost-hand demo on demand (Jordan: 'view the visual demonstration
// whenever they want'). Hiding consumes the one-shot (markAimGuideDone — also
// clears the force); showing forces past the done flag. A real pull or a shot
// still ends any replay on its own.
$('helpDemoBtn').onclick = () => {
  if (!S.playing || S.alive[S.you] === false) return;
  if (!aimGuideDone || guideForced) markAimGuideDone();
  else { guideForced = true; guideHoldOff = 0; guideWasOn = false; }
  $('helpModal').classList.add('hidden');
};

// ---- Golf scorecard ------------------------------------------------------------
// Built from the golf wire: per-hole par (g.pars) + the full per-seat stroke
// grid (g.grid, or g.strokes at gameover). Used both for the on-screen button
// during the round and for the end-of-round summary.
function golfToPar(v) { return v === 0 ? 'E' : (v > 0 ? '+' + v : String(v)); }
function golfCardHTML(g) {
  const pars = g.pars || [];
  const grid = g.grid || [];
  const H = pars.length;
  const n = grid.length || (g.totals ? g.totals.length : 0);
  const finished = !!g.finished;
  const cur = g.hole || H;                       // 1-based current hole (H when finished)
  const done = g.done || [];
  const parTot = pars.reduce((a, b) => a + b, 0);
  let head = '<tr><th class="gc-head">Hole</th>';
  for (let h = 0; h < H; h++) head += `<th${h === 0 ? ' class="gc-sep"' : ''}>${h + 1}</th>`;
  head += '<th class="gc-sep">Tot</th><th>+/-</th></tr>';
  let parRow = '<tr class="gc-parrow"><td class="gc-head">Par</td>';
  for (let h = 0; h < H; h++) parRow += `<td${h === 0 ? ' class="gc-sep"' : ''}>${pars[h]}</td>`;
  parRow += `<td class="gc-sep gc-tot">${parTot}</td><td></td></tr>`;
  let rows = '';
  for (let s = 0; s < n; s++) {
    let vs = 0, cells = '';
    for (let h = 0; h < H; h++) {
      const strokes = (grid[s] && grid[s][h]) || 0;
      const holeDone = finished || (h < cur - 1) || (h === cur - 1 && !!done[s]);
      let cls = h === 0 ? 'gc-sep' : '';
      if (strokes > 0 && holeDone) {
        const d = strokes - pars[h]; vs += d;
        if (d < 0) cls += ' gc-under'; else if (d > 0) cls += ' gc-over';
      }
      if (!finished && h === cur - 1 && !done[s]) cls += ' gc-now';
      cells += `<td class="${cls.trim()}">${strokes > 0 ? strokes : ''}</td>`;
    }
    const tot = (g.totals && g.totals[s] != null) ? g.totals[s]
      : (grid[s] ? grid[s].reduce((a, b) => a + b, 0) : 0);
    const vsCls = vs > 0 ? 'up' : vs < 0 ? 'down' : '';
    const nm = (S.names && S.names[s]) || `P${s + 1}`;
    rows += `<tr><td class="gc-name" style="--seat:${seatColor(s)}"><i></i>${nm}</td>${cells}` +
      `<td class="gc-sep gc-tot">${tot}</td><td class="gc-vs ${vsCls}">${golfToPar(vs)}</td></tr>`;
  }
  return `<thead>${head}</thead><tbody>${parRow}${rows}</tbody>`;
}
function openGolfCard() {
  if (!S.golf) return;
  $('golfCardTable').innerHTML = golfCardHTML(S.golf);
  $('golfCard').classList.remove('hidden');
}
$('golfCardBtn').onclick = () => { closeStageMenus(); openGolfCard(); };
$('golfCardClose').onclick = () => $('golfCard').classList.add('hidden');
$('golfCard').addEventListener('click', (e) => { if (e.target.id === 'golfCard') $('golfCard').classList.add('hidden'); });

// ---- Career screen -------------------------------------------------------------
function totalWins() { return Object.values(PROF.modes).reduce((a, s) => a + (s.w || 0), 0); }
function refreshCareerChip() { const el = $('careerWins'); if (el) el.textContent = `${totalWins()} wins`; }
function buildCareer() {
  const fav = Object.entries(PROF.weapons).sort((a, b) => b[1] - a[1])[0];
  const favName = fav ? ((HELP_WEAPONS.find(w => w.id === fav[0]) || {}).name || fav[0]) : null;
  const acc = PROF.shots ? Math.round((PROF.hits / PROF.shots) * 100) : 0;
  const MODES = [['duel', 'Duel'], ['ffa', 'Free-for-all'], ['boss', 'Boss Fight'], ['aliens', 'Aliens'], ['golf', 'Golf']];
  $('careerStats').innerHTML =
    MODES.map(([id, nm]) => {
      const s = PROF.modes[id] || { w: 0, l: 0 };
      return `<div class="cs-row"><span>${nm}</span><b>${s.w} W – ${s.l} L</b></div>`;
    }).join('') +
    `<div class="cs-row cs-sep"><span>Accuracy</span><b>${acc}% (${PROF.hits}/${PROF.shots})</b></div>` +
    `<div class="cs-row"><span>Favourite weapon</span><b>${favName || '—'}</b></div>` +
    `<div class="cs-row"><span>Kills</span><b>${PROF.kills}</b></div>` +
    `<div class="cs-row"><span>Most damage, one shot</span><b>${PROF.maxDmg || 0}</b></div>` +
    `<div class="cs-row"><span>Longest hit</span><b>${PROF.longest ? PROF.longest.toLocaleString() + ' u' : '—'}</b></div>` +
    `<div class="cs-row"><span>Best golf round</span><b>${PROF.golfBest != null ? PROF.golfBest + ' strokes' : '—'}</b></div>` +
    `<div class="cs-row"><span>Holes in one</span><b>${PROF.aces || 0}</b></div>` +
    `<div class="cs-row"><span>Alien invasion kills, best run</span><b>${PROF.hordeBest.aliens || 0}</b></div>`;
  // Every challenge SHOWS what it actually asks for — no hidden tooltips. The
  // two that hand over a tank paint say so up front, so the reward is a reason
  // to go after them rather than a surprise afterwards.
  $('careerAchs').innerHTML = ACHS.map(([id, nm, desc]) => {
    const got = !!PROF.ach[id];
    const paint = SKIN_FOR_ACH[id];
    return `<div class="ach${got ? ' got' : ''}">` +
      `<span class="ach-ic">${got ? UI_IC.crown : UI_IC.lock}</span>` +
      `<span class="ach-txt"><b>${nm}</b><i>${desc}${paint ? ` — unlocks the ${paint} paint` : ''}</i></span></div>`;
  }).join('');
}
$('careerBtn').onclick = () => { buildCareer(); $('careerModal').classList.remove('hidden'); };
$('careerTabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab'); if (!t) return;
  for (const el of $('careerTabs').children) el.classList.toggle('active', el === t);
  for (const pane of document.querySelectorAll('#careerModal .tabpane'))
    pane.classList.toggle('active', pane.dataset.pane === t.dataset.tab);
});
$('careerCloseBtn').onclick = () => $('careerModal').classList.add('hidden');
$('careerModal').onclick = (e) => { if (e.target.id === 'careerModal') $('careerModal').classList.add('hidden'); };
refreshCareerChip();
$('helpBtn').onclick = () => { closeStageMenus(); openHelp(); };
$('helpHomeBtn').onclick = openHelp;
$('helpCloseBtn').onclick = () => $('helpModal').classList.add('hidden');
$('helpModal').onclick = (e) => { if (e.target.id === 'helpModal') $('helpModal').classList.add('hidden'); };

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
  if (S.playing) updateWatching();   // rides the existing loop; no new timer
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
  for (const c of S.crates) if (c.dropT < 1) c.dropT = Math.min(1, c.dropT + dt / 4.6);
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
  for (const q of S.quakes) q.age += dt;
  S.quakes = S.quakes.filter(q => q.age < q.life);
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
    drawGolfBunkers();
    drawGolfWater();
    drawTeeBox();
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
        if (S.golf && S.golf.done && S.golf.done[i]) continue;   // holed out — in the clubhouse
        const kind = (S.kinds && S.kinds[i]) || (i === S.boss ? 'mech' : 'tank');
        if (kind === 'mech') drawMech(i);
        else if (kind === 'alien') drawAlien(i);
        else drawTankWarped(i);
        if (S.shield && S.shield[i] > 0) drawShieldAura(i);
      }
    }
    drawWarp();
    drawEdgeIndicators();
    drawAim();
    drawProjectiles();
    drawMuzzleFlashes();      // over the gun and the shell, under damage numbers
    drawRings();
    drawQuakes();
    drawParticles(false);     // soil chips + sparks — too small to ever hide a tank
    drawFloaters();
  }
  ctx.restore();

  drawAimGuide();                 // first-play gesture demo — screen space, above the shake
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
  for (const r of S.ruins) if (r.alive !== false && wx >= r.a && wx <= r.b) return r;
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
    const golfC = S.golf ? golfTopColor(wxc, TLAYERS[0][1]) : null;
    const golfDeep = golfC && golfSandAt(wxc) ? 'rgb(216,196,150)' : null;   // bunkers get real depth
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
      if (y1 > y0) { ctx.fillStyle = (li === 0 && golfC) ? golfC : (li === 1 && golfDeep) ? golfDeep : TCHAR[li][sc]; ctx.fillRect(sx, y0, 1, y1 - y0); }
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
  const palms = !!S.golf && S.biome === 'desert';   // oasis course: palms, not pines
  for (const t of S.trees) {
    const gy = surfaceAt(t.x);
    if (gy - t.y0 > 60) continue;                 // ground was blasted away — tree destroyed
    const sx = Math.round(wx2s(t.x));
    if (sx < -60 || sx > cssW + 60) continue;
    const sy = Math.round(wy2s(gy));
    const hgt = Math.max(5, 340 * t.s * cam.zoom);   // Max Alpine — larger pines
    if (palms) { drawPalm(sx, sy, hgt * 1.15, t.x); continue; }
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

// A palm for the desert golf holes: a gently curving trunk of stacked,
// narrowing segments with bark rings, a crown of six drooping fronds
// (quadratic blades — leaf shapes, not fire-FX discs) and a pair of
// coconuts. Lean alternates by position so a stand of palms sways both ways.
function drawPalm(sx, sy, hgt, wx) {
  const u = hgt / 6;
  const lean = ((Math.round(wx / 97) % 2) ? 1 : -1) * u * 0.55;
  ctx.fillStyle = '#9a7146';
  let px = sx, py = sy;
  for (let i = 0; i < 5; i++) {
    const w2 = u * (0.62 - i * 0.06);
    px = sx + lean * Math.pow(i / 4, 1.6);
    ctx.fillRect(px - w2 / 2, py - u * 1.35, w2, u * 1.45);
    if (i % 2) {                                   // bark ring
      ctx.fillStyle = '#7c5a36';
      ctx.fillRect(px - w2 / 2, py - u * 0.32, w2, u * 0.18);
      ctx.fillStyle = '#9a7146';
    }
    py -= u * 1.3;
  }
  const cx2 = px, cy2 = py;
  const F = [[-1.9, -0.4], [-1.5, -1.05], [-0.6, -1.5], [0.6, -1.5], [1.5, -1.05], [1.9, -0.4]];
  for (let i = 0; i < F.length; i++) {
    const [dx, dy] = F[i];
    ctx.fillStyle = i % 2 ? '#2f7a3c' : '#3f8f4a';
    const tipX = cx2 + dx * u * 1.55, tipY = cy2 + dy * u * 1.2 + Math.abs(dx) * u * 0.38;   // tips droop
    ctx.beginPath();
    ctx.moveTo(cx2, cy2 + u * 0.15);
    ctx.quadraticCurveTo(cx2 + dx * u * 0.75, cy2 + dy * u * 0.9, tipX, tipY);
    ctx.quadraticCurveTo(cx2 + dx * u * 0.7, cy2 + dy * u * 0.55 + u * 0.3, cx2, cy2 + u * 0.4);
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = '#5c422a';                       // coconuts
  ctx.fillRect(cx2 - u * 0.38, cy2 + u * 0.1, u * 0.3, u * 0.3);
  ctx.fillRect(cx2 + u * 0.08, cy2 + u * 0.18, u * 0.3, u * 0.3);
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
  // Tank is drawn at its TRUE world size (TANK_R 240 world units x zoom, NO
  // clamp): the sprite outline then matches the server's world-space hitbox
  // pixel-for-pixel at every zoom, and the tank stays locked to the world (it
  // never changes size relative to the battlefield). A clamp here would draw
  // the tank off its hitbox at zoom extremes — the old "hitbox is wrong" bug.
  const r = 240 * cam.zoom;
  return { sx: wx2s(t.x), sy: wy2s(surfaceAt(t.x)), r };
}

// Compact military AFV in the player's chosen paint. Damaged tanks blacken
// with scorch (plus smoke and flames from stepEffects).
// "Clean Sweep" tank palette + barrel geometry. Shared by drawTank and the
// muzzle-blast helper so the shot always leaves the very end of the gun.

// ---- Paint jobs -----------------------------------------------------------------
// The menu swatch now paints the ARMOUR — hull, skirts, turret, hatch, mantlet —
// while tracks, wheels and gun steel stay military dark. The locked tank
// geometry is untouched; only fills change. Palettes derive from the three
// swatch tones and are cached per skin.
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgbHex = (c) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const hexMix = (a, b, t) => { const A = hexRgb(a), B = hexRgb(b); return rgbHex([0, 1, 2].map(k => A[k] + (B[k] - A[k]) * t)); };
const PAINT_CACHE = {};
function tankPaint(skinId) {
  if (PAINT_CACHE[skinId]) return PAINT_CACHE[skinId];
  const sk = SKINS[skinId] || SKINS.olive;
  const pal = {
    skirt: hexMix(sk.dark, '#0c0e12', 0.25), skirtDk: hexMix(sk.dark, '#0c0e12', 0.45),
    hull: sk.mid, hullLite: hexMix(sk.mid, sk.lite, 0.55),
    turret: hexMix(sk.mid, '#0c0e12', 0.22), hatch: hexMix(sk.mid, '#0c0e12', 0.08),
    mantlet: hexMix(sk.mid, sk.lite, 0.3),
  };
  PAINT_CACHE[skinId] = pal;
  return pal;
}

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
// The WARLORD-7 mecha-tank. Modelled on its concept art: a hunched armoured
// carcass on QUAD track pods, desert digi-camo plating, a beaked sensor cowl,
// one arm ending in a triple gatling cluster (this is the gun that follows its
// aim) and the other in a raised missile-pod claw, a six-tube rocket rack on
// its back — and a ridge of armour spikes down the spine, because it earned
// them. Deterministic pixel-camo (no per-frame RNG), polygons and rects only.
const MEK = {
  tan: '#b3a175', dk: '#7e7050', pale: '#d7c89c', patch: '#665d42',
  gun: '#3a3e35', dark: '#23262c', glow: '#ff3b30', steel: '#8d9298',
};
function camoPatch(x, y, w, h, seed) {
  // stable two-tone digital camo: cell grid with a hash deciding each cell
  const cols = 6, rows = 3;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const hsh = Math.abs((seed * 73856093) ^ (cx * 19349663) ^ (cy * 83492791)) % 100;
      if (hsh < 26) ctx.fillStyle = MEK.patch;
      else if (hsh < 44) ctx.fillStyle = MEK.pale;
      else continue;
      ctx.fillRect(x + (cx / cols) * w, y + (cy / rows) * h, w / cols * 0.86, h / rows * 0.8);
    }
  }
}
function drawMech(i) {
  if (!S.tanks[i]) return;
  let { sx, sy, r } = tankScreen(i);
  r *= 1.8;
  const dir = facingOf(i);
  ctx.save();

  // ground shadow spanning both pods
  ctx.fillStyle = 'rgba(10,12,16,0.35)';
  ctx.fillRect(sx - r * 1.75, sy - r * 0.04, r * 3.5, r * 0.12);

  // QUAD tracks: two armoured pods, each a full track unit with skirt + wheels
  for (const [px0, px1] of [[-1.7, -0.12], [0.12, 1.7]]) {
    const x0 = sx + px0 * r, x1 = sx + px1 * r, w = x1 - x0;
    ctx.fillStyle = MEK.dark;                                   // track run
    ctx.fillRect(x0, sy - r * 0.42, w, r * 0.42);
    ctx.fillStyle = '#14171c';                                  // road wheels
    for (let k = 0; k < 3; k++) ctx.fillRect(x0 + w * (0.14 + k * 0.3), sy - r * 0.3, w * 0.16, r * 0.24);
    ctx.fillStyle = MEK.tan;                                    // armoured skirt
    ctx.fillRect(x0 - r * 0.06, sy - r * 0.66, w + r * 0.12, r * 0.3);
    camoPatch(x0 - r * 0.06, sy - r * 0.66, w + r * 0.12, r * 0.3, 11 + px0 * 7);
    ctx.fillStyle = MEK.dk;                                     // skirt lip
    ctx.fillRect(x0 - r * 0.06, sy - r * 0.4, w + r * 0.12, r * 0.07);
  }

  // hull deck bridging the pods
  ctx.fillStyle = MEK.dk;
  ctx.fillRect(sx - r * 1.2, sy - r * 0.86, r * 2.4, r * 0.26);
  const hpFrac = S.hpMax && S.hpMax[i] ? Math.max(0, (S.hp[i] || 0) / S.hpMax[i]) : 1;
  const tnow = performance.now();

  // hunched torso: a big beaked carcass leaning over its facing
  const lean = dir * r * 0.16;
  ctx.fillStyle = MEK.tan;
  ctx.beginPath();
  ctx.moveTo(sx - r * 1.0 + lean * 0.2, sy - r * 0.84);              // rear hip
  ctx.lineTo(sx - r * 1.16 + lean, sy - r * 1.9);                    // rear shoulder hump
  ctx.lineTo(sx - r * 0.3 + lean, sy - r * 2.42);                    // spine crest
  ctx.lineTo(sx + r * 0.62 + lean, sy - r * 2.3);                    // brow
  ctx.lineTo(sx + r * 1.12 + lean, sy - r * 1.72);                   // beak tip
  ctx.lineTo(sx + r * 0.78 + lean, sy - r * 1.34);                   // jaw
  ctx.lineTo(sx + r * 0.88 + lean * 0.4, sy - r * 0.84);             // front hip
  ctx.closePath(); ctx.fill();
  camoPatch(sx - r * 1.05 + lean, sy - r * 2.3, r * 1.9, r * 1.3, 29);
  ctx.fillStyle = MEK.dk;                                            // underbelly shade
  ctx.fillRect(sx - r * 0.98 + lean * 0.5, sy - r * 1.06, r * 1.8, r * 0.22);

  // reactor heart: a caged core in the torso, pulsing hotter as the WARLORD
  // takes damage — at low health it beats fast and angry.
  const beat = 0.55 + 0.45 * Math.sin(tnow / (hpFrac < 0.35 ? 130 : 320));
  const rcx = sx - r * 0.18 + lean, rcy = sy - r * 1.5;
  ctx.fillStyle = `rgba(255,${Math.round(120 * hpFrac + 40)},30,${(0.35 + 0.45 * beat).toFixed(2)})`;
  ctx.fillRect(rcx - r * 0.17, rcy - r * 0.17, r * 0.34, r * 0.34);
  ctx.fillStyle = MEK.dark;                                          // cage bars
  ctx.fillRect(rcx - r * 0.2, rcy - r * 0.035, r * 0.4, r * 0.07);
  ctx.fillRect(rcx - r * 0.035, rcy - r * 0.2, r * 0.07, r * 0.4);

  // battle damage: below half health the plating blackens and arcs spit
  if (hpFrac < 0.5) {
    ctx.fillStyle = 'rgba(16,14,12,0.55)';
    ctx.fillRect(sx - r * 0.85 + lean, sy - r * 2.1, r * 0.5, r * 0.34);
    ctx.fillRect(sx + r * 0.15 + lean, sy - r * 1.35, r * 0.42, r * 0.26);
    ctx.fillRect(sx - r * 1.35, sy - r * 0.6, r * 0.4, r * 0.2);
    if (Math.sin(tnow / 90 + i) > 0.86) {                           // sputtering short-circuit
      ctx.strokeStyle = '#8affde'; ctx.lineWidth = Math.max(1, r * 0.05);
      ctx.beginPath();
      ctx.moveTo(sx - r * 0.6 + lean, sy - r * 1.95);
      ctx.lineTo(sx - r * 0.48 + lean, sy - r * 1.78);
      ctx.lineTo(sx - r * 0.58 + lean, sy - r * 1.66);
      ctx.stroke();
    }
  }

  // beak cowl plating + eye visor (glows toward its facing)
  ctx.fillStyle = MEK.dk;
  ctx.beginPath();
  ctx.moveTo(sx + r * 0.3 + lean, sy - r * 2.3);
  ctx.lineTo(sx + r * 1.12 + lean, sy - r * 1.72);
  ctx.lineTo(sx + r * 0.78 + lean, sy - r * 1.34);
  ctx.lineTo(sx + r * 0.34 + lean, sy - r * 1.78);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = MEK.glow;
  ctx.fillRect(sx + r * (0.4 + 0.1 * dir) + lean, sy - r * 2.02, r * 0.42, Math.max(1.5, r * 0.09));
  ctx.fillStyle = 'rgba(255,90,82,0.28)';
  ctx.fillRect(sx + r * (0.32 + 0.1 * dir) + lean, sy - r * 2.1, r * 0.62, r * 0.24);

  // SPIKES along the spine crest — the trophy ridge
  ctx.fillStyle = MEK.dark;
  for (let k = 0; k < 5; k++) {
    const t = k / 4;
    const bx = sx + (-1.06 + t * 1.28) * r + lean;
    const by = sy - r * (1.94 + Math.sin(t * Math.PI) * 0.5);
    const hgt = r * (0.34 + (k % 2) * 0.14);
    ctx.beginPath();
    ctx.moveTo(bx - r * 0.09, by);
    ctx.lineTo(bx + r * 0.02 * (k % 2 ? 1 : -1), by - hgt);
    ctx.lineTo(bx + r * 0.11, by);
    ctx.closePath(); ctx.fill();
  }

  // back rocket rack: 2x3 tube block on the rear shoulder
  const rkx = sx - dir * r * 1.05 + lean * 0.4, rky = sy - r * 2.06;
  ctx.fillStyle = MEK.dk;
  ctx.fillRect(rkx - r * 0.44, rky, r * 0.88, r * 0.6);
  camoPatch(rkx - r * 0.44, rky, r * 0.88, r * 0.6, 47);
  ctx.fillStyle = '#0f1216';
  for (let ry = 0; ry < 2; ry++)
    for (let rx = 0; rx < 3; rx++)
      ctx.fillRect(rkx - r * 0.34 + rx * r * 0.26, rky + r * 0.08 + ry * r * 0.26, r * 0.18, r * 0.18);

  // missile-pod ARM on the off side: raised claw pod, cells forward
  const pax = sx - dir * r * 0.55 + lean * 0.3;
  ctx.strokeStyle = MEK.dk; ctx.lineWidth = Math.max(3, r * 0.2); ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(pax, sy - r * 1.7); ctx.lineTo(pax - dir * r * 0.5, sy - r * 1.15); ctx.stroke();
  ctx.fillStyle = MEK.tan;
  ctx.fillRect(pax - dir * r * 0.94, sy - r * 1.5, r * 0.78, r * 0.62);
  camoPatch(pax - dir * r * 0.94, sy - r * 1.5, r * 0.78, r * 0.62, 61);
  ctx.fillStyle = '#0f1216';
  for (let k = 0; k < 2; k++)
    for (let j = 0; j < 2; j++)
      ctx.fillRect(pax - dir * r * (0.84 - k * 0.3), sy - r * (1.4 - j * 0.28), r * 0.18, r * 0.18);

  // GATLING ARM on the facing side — this is the gun that tracks its aim
  const aim = S.aim[i] || { angle: 45, power: 60 };
  const rad = aim.angle * Math.PI / 180;
  const cosA = Math.cos(rad) * dir, sinA = -Math.sin(rad);
  const gx0 = sx + dir * r * 0.62 + lean, gy0 = sy - r * 1.5;
  const rc = Math.pow(S.recoil[i] || 0, 1.8);
  const bLen = r * (1.35 - 0.4 * rc);
  ctx.strokeStyle = MEK.dk; ctx.lineWidth = Math.max(3, r * 0.22);   // shoulder actuator
  ctx.beginPath(); ctx.moveTo(sx + dir * r * 0.3 + lean, sy - r * 1.8); ctx.lineTo(gx0, gy0); ctx.stroke();
  // triple rotary barrels — while the WARLORD charges a shot they visibly
  // SPIN (the bright barrel cycles through the three positions)
  const perpX = -sinA * dir, perpY = cosA * dir;   // unit-ish perpendicular
  const spinHot = S.bossCharge && i === S.boss ? (Math.floor(tnow / 90) % 3) - 1 : 0;
  for (let k = -1; k <= 1; k++) {
    ctx.strokeStyle = k === spinHot ? MEK.steel : MEK.gun;
    ctx.lineWidth = Math.max(2, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(gx0 + perpX * k * r * 0.09, gy0 + perpY * k * r * 0.09);
    ctx.lineTo(gx0 + cosA * bLen + perpX * k * r * 0.09, gy0 + sinA * bLen + perpY * k * r * 0.09);
    ctx.stroke();
  }
  ctx.fillStyle = MEK.gun;                                           // gatling hub
  ctx.fillRect(gx0 - r * 0.17, gy0 - r * 0.17, r * 0.34, r * 0.34);
  ctx.strokeStyle = MEK.dark; ctx.lineWidth = Math.max(3, r * 0.26); // muzzle shroud
  ctx.beginPath();
  ctx.moveTo(gx0 + cosA * (bLen - r * 0.05), gy0 + sinA * (bLen - r * 0.05));
  ctx.lineTo(gx0 + cosA * (bLen + r * 0.16), gy0 + sinA * (bLen + r * 0.16));
  ctx.stroke();

  // wind-up: between the WARLORD's aim and its shot, energy visibly gathers on
  // the gatling hub — cyan for the Phase Spear, furnace-orange for the rest.
  if (S.bossCharge && i === S.boss) {
    const t = Math.min(1, (performance.now() - S.bossCharge.t0) / 1400);
    const col = S.bossCharge.weapon === 'b_spear' ? '#8affde' : '#ffb84d';
    const mzx = gx0 + cosA * bLen, mzy = gy0 + sinA * bLen;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, r * 0.06);
    for (let k = 0; k < 6; k++) {
      const a2 = (performance.now() / 130 + k * 1.05) % (Math.PI * 2);
      const rr = r * (0.62 - 0.34 * t);
      ctx.globalAlpha = 0.25 + 0.6 * t;
      ctx.beginPath();
      ctx.moveTo(mzx + Math.cos(a2) * rr, mzy + Math.sin(a2) * rr);
      ctx.lineTo(mzx + Math.cos(a2) * rr * 0.35, mzy + Math.sin(a2) * rr * 0.35);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.2 + 0.5 * t;
    ctx.fillStyle = col;
    ctx.fillRect(mzx - r * 0.09, mzy - r * 0.09, r * 0.18, r * 0.18);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

// ---- Horde enemy renderers ---------------------------------------------------
// Alien saucer-tank: a hovering lens hull with a glass dome, blinking rim lights
// and an anti-grav shimmer instead of tracks. Bobs on a slow sine so it never
// sits still. Barrel follows the same aim/recoil conventions as drawTank.
const ALIEN = { hull: '#3a4d5c', rim: '#22303a', dome: 'rgba(122,255,190,0.30)', glow: '#7dff6a', lite: '#5b7386' };
function drawAlien(i) {
  if (!S.tanks[i]) return;
  const { sx, sy, r } = tankScreen(i);
  const dir = facingOf(i);
  const t = performance.now() / 1000;
  const bob = Math.sin(t * 1.9 + i * 2.1) * r * 0.15;
  const cy = sy - r * 1.05 + bob;                      // hull centreline, hovering

  ctx.save();
  // anti-grav shimmer: tapering light slats between hull and ground (lines, not blobs)
  ctx.strokeStyle = 'rgba(125,255,106,0.35)';
  for (let k = -2; k <= 2; k++) {
    const px = sx + k * r * 0.42 + Math.sin(t * 5 + k * 1.9) * r * 0.06;
    const kk = 0.5 + 0.5 * Math.sin(t * 6 + k * 2.4);
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.globalAlpha = 0.25 + 0.35 * kk;
    ctx.beginPath(); ctx.moveTo(px, cy + r * 0.42); ctx.lineTo(px, sy + r * 0.06); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // ground scorch shadow
  ctx.fillStyle = 'rgba(10,14,10,0.30)';
  ctx.fillRect(sx - r * 1.1, sy - r * 0.03, r * 2.2, r * 0.1);

  // saucer lens hull — two mirrored quads with a bright equator seam
  ctx.fillStyle = ALIEN.rim;
  ctx.beginPath();
  ctx.moveTo(sx - r * 1.5, cy);
  ctx.lineTo(sx - r * 0.75, cy + r * 0.46);
  ctx.lineTo(sx + r * 0.75, cy + r * 0.46);
  ctx.lineTo(sx + r * 1.5, cy);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = ALIEN.hull;
  ctx.beginPath();
  ctx.moveTo(sx - r * 1.5, cy);
  ctx.lineTo(sx - r * 0.75, cy - r * 0.42);
  ctx.lineTo(sx + r * 0.75, cy - r * 0.42);
  ctx.lineTo(sx + r * 1.5, cy);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = ALIEN.lite;                          // equator band
  ctx.fillRect(sx - r * 1.5, cy - r * 0.05, r * 3.0, r * 0.1);

  // rim running lights, chasing around the saucer
  for (let k = 0; k < 5; k++) {
    const on = ((Math.floor(t * 3) + k) % 5) === 0;
    ctx.fillStyle = on ? ALIEN.glow : 'rgba(125,255,106,0.25)';
    const lx = sx - r * 1.16 + k * r * 0.58;
    ctx.fillRect(lx - r * 0.07, cy + r * 0.10, r * 0.14, r * 0.14);
  }

  // glass dome + pilot silhouette (big head, two eye dots — kept angular)
  ctx.fillStyle = ALIEN.dome;
  ctx.beginPath();
  ctx.moveTo(sx - r * 0.62, cy - r * 0.40);
  ctx.lineTo(sx - r * 0.40, cy - r * 1.05);
  ctx.lineTo(sx + r * 0.40, cy - r * 1.05);
  ctx.lineTo(sx + r * 0.62, cy - r * 0.40);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(16,28,20,0.85)';               // occupant
  ctx.fillRect(sx - r * 0.16, cy - r * 0.88, r * 0.32, r * 0.42);
  ctx.fillStyle = ALIEN.glow;                          // eyes toward its facing
  ctx.fillRect(sx + dir * r * 0.02 - r * 0.10, cy - r * 0.80, r * 0.09, r * 0.06);
  ctx.fillRect(sx + dir * r * 0.02 + r * 0.02, cy - r * 0.80, r * 0.09, r * 0.06);

  // plasma cannon under the leading rim — same aim/recoil conventions
  const aim = S.aim[i] || { angle: 45, power: 60 };
  const rad = aim.angle * Math.PI / 180;
  const cosA = Math.cos(rad) * dir, sinA = -Math.sin(rad);
  const px = sx + dir * r * 0.62, py = cy - r * 0.10;
  const bLen = r * 1.05 - r * 0.35 * Math.pow(S.recoil[i] || 0, 1.8);
  ctx.strokeStyle = ALIEN.lite; ctx.lineWidth = Math.max(2.5, r * 0.17);
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + cosA * bLen, py + sinA * bLen); ctx.stroke();
  ctx.strokeStyle = ALIEN.glow; ctx.lineWidth = Math.max(1, r * 0.06);   // charge line
  ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 8 + i);
  ctx.beginPath();
  ctx.moveTo(px + cosA * r * 0.2, py + sinA * r * 0.2);
  ctx.lineTo(px + cosA * bLen, py + sinA * bLen);
  ctx.stroke();
  ctx.globalAlpha = 1;
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
// ---- Golf course dressing --------------------------------------------------------
// The top grass band restyles by zone: mowed GREEN around the cup (bright,
// tight stripes), FAIRWAY stripes tee->green, darker rough everywhere else.
// Colours derive from the biome's own grass so a desert hole reads as baked
// links and an ice hole as frost — same course language, same biome.
function golfTopColor(wx, base) {
  const g = S.golf; if (!g || !g.cup) return null;
  // Bunkers own their ground: raked sand with a faint grain, over everything
  // else the column would have been. (The basin shape itself comes dished
  // from the server, so the recolour lands exactly on the bowl.)
  if (golfSandAt(wx)) {
    // Bright silica sand, deliberately PALER and less saturated than any
    // biome's own ground (the desert top is rgb(238,207,138) — the original
    // bunker tan was invisible on it). The rim + rake pass in
    // drawGolfBunkers() carries the read; this is just the fill.
    const grain = Math.floor(wx / 90) % 3;
    return grain === 0 ? 'rgb(246,232,196)' : grain === 1 ? 'rgb(238,222,182)' : 'rgb(250,238,206)';
  }
  const inGreen = Math.abs(wx - g.cup.x) <= 2200;
  const inFringe = !inGreen && Math.abs(wx - g.cup.x) <= 2750;
  const inFair = wx >= g.tee - 700 && wx <= g.cup.x + 700;
  // The green is REAL turf on every biome — mown lawn stripes, whether the
  // course runs through snow, sand or alpine meadow.
  // (These once returned bare [r,g,b] arrays — an INVALID canvas fillStyle
  // that is silently ignored, so the green was painting in whatever colour
  // the previous column left behind. fillStyle wants strings. Found while
  // adding the bunker recolour, 2026-07-29.)
  if (inGreen) return (Math.floor(wx / 300) % 2 === 0) ? 'rgb(88,166,74)' : 'rgb(70,146,60)';
  if (inFringe) return 'rgb(58,118,52)';                       // collar of deeper turf
  if (inFair)  return (Math.floor(wx / 800) % 2 === 0) ? mixToward(base, [110, 190, 96], 0.28) : mixToward(base, [90, 168, 80], 0.18);
  return mixToward(base, [20, 26, 18], 0.22);                  // the rough
}
// Is this column inside a bunker? Shared by the top-band recolour above and
// drawTerrain's second-layer fill — one 55u band of sand is invisible at
// survey zoom, so a bunker paints BOTH top layers (~285u of depth: a pocket).
function golfSandAt(wx) {
  const g = S.golf; if (!g || !g.hazards) return false;
  for (const h of g.hazards) if (h.kind === 'sand' && wx >= h.a && wx <= h.b) return true;
  return false;
}

// The bunker's READ comes from structure, not hue — a flat recolour cannot
// contrast with the desert biome's own sand. A dark carved lip traces the
// bowl (with a little overhang past each end), and raked grooves run through
// the sand. Works on green turf, white ice and desert tan alike.
function drawGolfBunkers() {
  const g = S.golf; if (!g || !g.hazards) return;
  for (const h of g.hazards) {
    if (h.kind !== 'sand') continue;
    const x0 = wx2s(h.a - 100), x1 = wx2s(h.b + 100);
    if (x1 < -40 || x0 > view.cssW + 40) continue;
    // The lip: follows the bowl's surface, drawn just above it.
    ctx.strokeStyle = 'rgba(94,70,38,0.9)';
    ctx.lineWidth = Math.max(1.5, 34 * cam.zoom);
    ctx.beginPath();
    const step = Math.max(2, (h.b - h.a + 200) / 64);
    let started = false;
    for (let wx = h.a - 100; wx <= h.b + 100; wx += step) {
      const sxp = wx2s(wx), syp = wy2s(surfaceAt(wx)) - Math.max(0.5, 12 * cam.zoom);
      if (!started) { ctx.moveTo(sxp, syp); started = true; } else ctx.lineTo(sxp, syp);
    }
    ctx.stroke();
    // Rake grooves: short slanted strokes hugging the sand, world-spaced.
    ctx.strokeStyle = 'rgba(168,138,88,0.7)';
    ctx.lineWidth = Math.max(1, 14 * cam.zoom);
    const gap = Math.max(180, (h.b - h.a) / 8);
    for (let wx = h.a + gap * 0.6; wx < h.b - gap * 0.4; wx += gap) {
      const sy0 = wy2s(surfaceAt(wx) + 55);
      ctx.beginPath();
      ctx.moveTo(wx2s(wx - 55), sy0 + Math.max(1, 40 * cam.zoom));
      ctx.lineTo(wx2s(wx + 55), sy0);
      ctx.stroke();
    }
  }
}

// A water hazard is a filled basin: a still surface at the stored waterline
// with a soft depth gradient down to the dug bed, plus a slow light shimmer
// on the surface. Drawn after the terrain so the banks frame it, before the
// tanks so a ball at the drop point stands on the bank in front of it.
function drawGolfWater() {
  const g = S.golf; if (!g || !g.hazards) return;
  for (const h of g.hazards) {
    if (h.kind !== 'water') continue;
    const x0 = wx2s(h.a), x1 = wx2s(h.b);
    if (x1 < -40 || x0 > view.cssW + 40) continue;
    const yS = wy2s(h.y);
    // Body: follow the bed contour so the fill never leaks past the banks.
    let bot = yS;
    ctx.beginPath();
    ctx.moveTo(x0, yS);
    ctx.lineTo(x1, yS);
    const step = Math.max(2, (h.b - h.a) / 48);
    for (let wx = h.b; wx >= h.a; wx -= step) {
      const by = wy2s(Math.max(h.y, surfaceAt(wx)));
      bot = Math.max(bot, by);
      ctx.lineTo(wx2s(wx), by);
    }
    ctx.closePath();
    const gr = ctx.createLinearGradient(0, yS, 0, Math.max(yS + 1, bot));
    gr.addColorStop(0, 'rgba(64,150,210,0.62)');
    gr.addColorStop(1, 'rgba(14,52,104,0.82)');
    ctx.fillStyle = gr;
    ctx.fill();
    // Surface line + drifting shimmer dashes.
    ctx.strokeStyle = 'rgba(190,228,255,0.65)';
    ctx.lineWidth = Math.max(1, 26 * cam.zoom);
    ctx.beginPath(); ctx.moveTo(x0, yS); ctx.lineTo(x1, yS); ctx.stroke();
    const t = performance.now() / 1000;
    ctx.strokeStyle = 'rgba(230,246,255,0.5)';
    ctx.lineWidth = Math.max(1, 14 * cam.zoom);
    for (let i2 = 0; i2 < 3; i2++) {
      const k = ((t * 0.09 + i2 * 0.33) % 1);
      const cxp = x0 + (x1 - x0) * k;
      const w2 = Math.min(34, (x1 - x0) * 0.14);
      ctx.beginPath(); ctx.moveTo(cxp - w2 / 2, yS + 2); ctx.lineTo(cxp + w2 / 2, yS + 2); ctx.stroke();
    }
  }
}

// Real-course tee colours: championship black at the back, then men's white,
// women's red, junior gold up front. Every box is drawn; the set being PLAYED
// gets the glowing mat.
const TEE_COLS = { champ: '#16181c', mens: '#f2f5f7', womens: '#ff5a52', junior: '#ffd23f' };
function drawTeeBox() {
  const g = S.golf; if (!g || !g.tee) return;
  let sets = g.tees ? Object.entries(g.tees) : [['mens', g.tee]];
  // Boxes that overlap on screen when the camera is far out collapse to only
  // the set being PLAYED, so markers never pile up.
  if (sets.length > 1) {
    const xs = sets.map(([, tx]) => wx2s(tx)).sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < xs.length; i++) minGap = Math.min(minGap, xs[i] - xs[i - 1]);
    if (minGap < 78) sets = sets.filter(([set]) => set === (g.teeSet || 'mens'));
  }
  // WORLD-scaled (2026-07-29, Jordan: golf objects must not change size
  // against the course when zooming — same contract as barrels/crates). The
  // mat spans 1,560 world units with knee-high markers; the floor only stops
  // it going sub-pixel at the widest survey zoom.
  const u = Math.max(2.2, 300 * cam.zoom);
  for (const [set, tx] of sets) {
    const sx = wx2s(tx);
    if (sx < -u * 4 || sx > view.cssW + u * 4) continue;
    const gy = wy2s(surfaceAt(tx));
    const active = set === (g.teeSet || 'mens');
    ctx.fillStyle = active ? 'rgba(60,232,143,0.5)' : 'rgba(20,30,18,0.55)';   // tee mat
    ctx.fillRect(sx - u * 2.6, gy - Math.max(1, u * 0.3), u * 5.2, Math.max(2, u * 0.42));
    ctx.fillStyle = TEE_COLS[set] || '#f2f5f7';                                // set-coloured markers
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx + s * u * 2.3, gy - u * 1.3);
      ctx.lineTo(sx + s * u * 2.3 + u * 0.42, gy);
      ctx.lineTo(sx + s * u * 2.3 - u * 0.42, gy);
      ctx.closePath(); ctx.fill();
      if ((TEE_COLS[set] || '') === '#16181c') {                 // black markers get a rim
        ctx.strokeStyle = '#8a93a8'; ctx.lineWidth = Math.max(1, u * 0.09);
        ctx.stroke();
      }
    }
  }
}

function drawGolfCup() {
  const g = S.golf; if (!g || !g.cup) return;
  const sx = wx2s(g.cup.x);
  // WORLD-scaled (2026-07-29): the pin used to be a constant 13px 'yardstick',
  // but a fixed-px sprite in a world-scaled scene visibly changes size against
  // the course — the exact barrel complaint from batch 8.13. The stick is now
  // ~1,200 world units (about two tank heights); the floor only stops it going
  // sub-pixel when the whole 155k-unit hole is on screen.
  const u = Math.max(2.6, 260 * cam.zoom);
  if (sx < -u * 3 || sx > view.cssW + u * 3) return;
  const gy = wy2s(surfaceAt(g.cup.x));
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
  // hole marker dash — scales with the pin like everything else on it
  ctx.strokeStyle = 'rgba(182,255,90,0.45)'; ctx.lineWidth = Math.max(1, u * 0.11);
  ctx.setLineDash([5, 6]);
  ctx.beginPath(); ctx.moveTo(sx - u * 1.1, gy + u * 0.35); ctx.lineTo(sx + u * 1.1, gy + u * 0.35); ctx.stroke();
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
      // WORLD object: drawn at the exact footprint the physics uses
      // (game-core SOLID_BOXES.barrel — half-width 230, height 580), so it holds
      // its proportion against the terrain and tanks at every zoom AND the
      // sprite you aim at is the box the shell actually hits.
      const u = 230 * cam.zoom;                                  // half-width, screen px
      const hgt = 580 * cam.zoom;
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
      // WORLD object: the deck is CARVED into the terrain across ±p.w, so the
      // whole structure is sized off that same world width. Everything then
      // holds its proportion against the platform it stands on at every zoom.
      const u = 0.25 * p.w * cam.zoom;
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
    const ease = 1 - Math.pow(1 - t, 1.6);                       // decelerating fall
    // The chute rides down from the VERY top of the world (y=300 is above every
    // peak), and a landed crate reads the terrain LIVE — if the ground under it
    // is blasted away or heaped up, the box rides the new surface and can never
    // end up buried.
    const grounded = surfaceAt(c.x);
    const wy = t >= 1 ? grounded : 300 + ease * (grounded - 300);
    const sx = wx2s(c.x), sy = wy2s(wy);
    if (sx < -90 || sx > view.cssW + 90) continue;
    // WORLD object, like the barrels and bunkers: u*2.3 wide x u*2.1 tall works
    // out to the 600x548 footprint game-core collides against.
    const u = 261 * cam.zoom;
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
    // The box: a proper CARE PACKAGE — pale planked pine, dark straps over the
    // top, riveted corner brackets, a big stencilled star, and a kind-coloured
    // tag so you can tell what's inside from across the canyon.
    const bw = u * 2.3, bh = u * 2.1, bx0 = sx - bw / 2, by0 = sy - bh;
    ctx.fillStyle = '#c9a468';                                   // pine face
    ctx.fillRect(bx0, by0, bw, bh);
    ctx.fillStyle = '#b28c50';                                   // shadow side
    ctx.fillRect(bx0 + bw * 0.72, by0, bw * 0.28, bh);
    ctx.fillStyle = '#96743e';                                   // plank seams
    for (let k = 1; k <= 2; k++) ctx.fillRect(bx0, by0 + (bh / 3) * k, bw, Math.max(1, u * 0.07));
    ctx.fillStyle = '#4c3b22';                                   // straps
    ctx.fillRect(bx0 + bw * 0.16, by0, Math.max(2, u * 0.2), bh);
    ctx.fillRect(bx0 + bw * 0.64, by0, Math.max(2, u * 0.2), bh);
    ctx.fillStyle = '#7a828c';                                   // corner brackets
    for (const [cxk, cyk] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      ctx.fillRect(bx0 + cxk * (bw - u * 0.34), by0 + cyk * (bh - u * 0.34), u * 0.34, u * 0.34);
    }
    // Contents stencil — read what's inside from across the canyon: a cross
    // for repairs, a shield chevron, a rail slug, or a fan of shells.
    ctx.fillStyle = 'rgba(240,240,235,0.92)';
    ctx.strokeStyle = 'rgba(240,240,235,0.92)';
    const gx = sx - bw * 0.06, gy2 = by0 + bh * 0.44, gr = u * 0.5;
    if (c.kind === 'repair') {
      ctx.fillRect(gx - gr * 0.3, gy2 - gr, gr * 0.6, gr * 2);
      ctx.fillRect(gx - gr, gy2 - gr * 0.3, gr * 2, gr * 0.6);
    } else if (c.kind === 'shield') {
      ctx.lineWidth = Math.max(1.5, u * 0.16);
      ctx.beginPath();
      ctx.moveTo(gx, gy2 - gr);
      ctx.lineTo(gx + gr * 0.9, gy2 - gr * 0.45);
      ctx.lineTo(gx + gr * 0.9, gy2 + gr * 0.2);
      ctx.lineTo(gx, gy2 + gr);
      ctx.lineTo(gx - gr * 0.9, gy2 + gr * 0.2);
      ctx.lineTo(gx - gr * 0.9, gy2 - gr * 0.45);
      ctx.closePath(); ctx.stroke();
    } else if (c.kind === 'railgun') {
      ctx.fillRect(gx - gr, gy2 - gr * 0.17, gr * 1.5, gr * 0.34);
      ctx.beginPath();
      ctx.moveTo(gx + gr * 0.45, gy2 - gr * 0.38); ctx.lineTo(gx + gr, gy2); ctx.lineTo(gx + gr * 0.45, gy2 + gr * 0.38);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(gx - gr, gy2 - gr * 0.62, gr * 0.85, Math.max(1, u * 0.09));
      ctx.fillRect(gx - gr, gy2 + gr * 0.53, gr * 0.85, Math.max(1, u * 0.09));
    } else {                                                     // ammo
      for (let k = -1; k <= 1; k++) {
        const cx2 = gx + k * gr * 0.6;
        ctx.fillRect(cx2 - gr * 0.15, gy2 - gr * 0.25, gr * 0.3, gr * 1.0);
        ctx.beginPath();
        ctx.moveTo(cx2 - gr * 0.15, gy2 - gr * 0.25); ctx.lineTo(cx2, gy2 - gr * 0.72); ctx.lineTo(cx2 + gr * 0.15, gy2 - gr * 0.25);
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.fillStyle = KIND_COL[c.kind] || '#ffd23f';               // contents tag
    ctx.fillRect(bx0, by0 + bh - Math.max(2, u * 0.34), bw, Math.max(2, u * 0.34));
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
  const PG = tankPaint(S.skins[i] || SEAT_SKIN[i % SEAT_SKIN.length]);
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
  ctx.fillStyle = PG.skirt;
  ctx.fillRect(sx - r * 1.26, sy - r * 0.20, r * 2.52, r * 0.30);
  ctx.fillStyle = PG.skirtDk;
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
  ctx.fillStyle = PG.hull; hullPath(); ctx.fill();
  ctx.fillStyle = PG.hullLite;                     // lighter rear quarter
  ctx.beginPath();
  ctx.moveTo(sx - front * r * 1.35, sy - r * 0.18);
  ctx.lineTo(sx - front * r * 0.99, sy - r * 0.58);
  ctx.lineTo(sx - front * r * 0.16, sy - r * 0.58);
  ctx.lineTo(sx - front * r * 0.29, sy - r * 0.18);
  ctx.closePath(); ctx.fill();

  // Low flat turret
  const tb = sy - r * 0.58;
  ctx.fillStyle = PG.turret;
  ctx.beginPath();
  ctx.moveTo(sx - front * r * 0.76, tb);
  ctx.lineTo(sx - front * r * 0.52, tb - r * 0.36);
  ctx.lineTo(sx + front * r * 0.41, tb - r * 0.36);
  ctx.lineTo(sx + front * r * 0.65, tb);
  ctx.closePath(); ctx.fill();
  // Player paint reads as a turret band so the two tanks stay tellable apart
  ctx.fillStyle = P.mid;
  ctx.fillRect(sx - front * r * 0.50, tb - r * 0.30, r * 0.84, r * 0.10);
  ctx.fillStyle = PG.hatch;                        // commander hatch
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
  ctx.fillStyle = PG.mantlet;                    // mantlet collar
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
  if (golfHoledMe()) return;                       // in the clubhouse — no reticle
  if (S.killcam && S.killcam.mix > 0.02) return;   // no reticle over the killcam
  // Your own tank is mid-warp — the reticle would snap to the new x the moment
  // applyResolve lands. Hide it until the tank has materialised.
  if (S.warp && S.warp.seat === S.you && S.warp.t < S.warp.dur) return;
  const t = S.tanks[S.you]; if (!t) return;
  const aim = myAim(); const dir = facingOf(S.you);
  const rad = aim.angle * Math.PI / 180;
  const sx = wx2s(t.x), sy = wy2s(surfaceAt(t.x) - 24);
  const pct = aim.power / 100;
  // Mirrors game-core's muzzle origin (BARREL_PIVOT_X 113, TANK_CY 274,
  // BARREL_LEN 410 — the drawn barrel tip). If the muzzle is at or under the
  // local surface the shell detonates in your own lap, so warn in red.
  const mox = t.x + dir * 113 + Math.cos(rad) * dir * 410;
  const moy = (t.y - 274) - Math.sin(rad) * 410;
  const danger = moy >= surfaceAt(mox) - 8;

  // THE TRUE ARC: integrate the selected weapon's exact ballistics (same
  // constants and Euler step as the server: G 900, 58 u/s per power point,
  // DT 1/120) from the muzzle tip, and mark precisely where it lands. Pierce
  // rounds (railgun) trace through terrain with no landing mark; apex-burst
  // rounds (cluster/napalm) trace to their burst point.
  const msx = wx2s(mox), msy = wy2s(moy);
  ctx.save();
  // The whole hint is wrapped so NO edge case (short flight, odd weapon data)
  // can ever throw inside the render loop — a mid-frame exception here leaks
  // ctx.save() state and quietly wrecks everything drawn after it.
  try {
    const selW = (S.weapons || []).find(w => w.id === S.selected) || {};
    if (selW.ground) {
      // PUTTER: the ball never lofts, so an arc would be a lie. Show a dotted
      // pace line hugging the turf — its length is the true flat-ground roll
      // (v^2 / 2·rr·g, rr 0.05 mirrors game-core's putter), first 60% shown.
      const v = aim.power * 52 * (selW.speedMul || 1);
      const roll = (v * v) / (2 * 0.05 * 900);
      const pdir = dir * (Math.cos(rad) < 0 ? -1 : 1);   // aim past 90° = putt backwards
      for (let i = 1; i <= 22; i++) {
        const f = (i / 22) * 0.6;
        const pxg = t.x + pdir * (350 + roll * f);
        if (pxg < 0 || pxg > WW()) break;
        const gx = wx2s(pxg), gy = wy2s(surfaceAt(pxg) - 10);
        const k = 3.2 - f * 1.8;
        ctx.globalAlpha = Math.max(0.2, 0.95 - f * 1.1);
        ctx.fillStyle = 'rgba(10,12,16,0.6)';
        ctx.fillRect(gx - k / 2 - 1, gy - k / 2 - 1, k + 2, k + 2);
        ctx.fillStyle = 'rgba(255,214,70,.95)';
        ctx.fillRect(gx - k / 2, gy - k / 2, k, k);
      }
      throw 0;   // skip the ballistic arc below; finally{} resets alpha
    }
    const speed = aim.power * 52 * (selW.speedMul || 1);   // mirrors game-core SPEED_PER_POWER
    const G = 900 * (selW.gravityMul || 1), DTs = 1 / 120;
    let px = mox, py = moy, vx = Math.cos(rad) * dir * speed, vy = -Math.sin(rad) * speed;
    let landed = null, burst = null, prevVy = vy;
    const dots = [];
    for (let i = 0; i < 3120; i++) {                 // 26 s cap, same as the sim
      vy += G * DTs; px += vx * DTs; py += vy * DTs;
      if (selW.apex && prevVy < 0 && vy >= 0) { burst = [px, py]; break; }
      prevVy = vy;
      if (px < 0 || px > WW() || py > WH()) break;
      if (!selW.pierce && py >= surfaceAt(px)) { landed = [px, surfaceAt(px)]; break; }
      if (i % 4 === 3) dots.push([px, py]);          // fine path; thinned out below
    }
    if (!dots.length) dots.push([px, py]);           // a dribbler that lands at once
    // The arc warns in RED when this shot would hurt YOU: muzzle buried, or
    // the landing sits inside your own weapon's blast radius. (No landing
    // marker — reading the fall is part of the craft.)
    const selfBlast = landed && selW.radius
      ? Math.hypot(landed[0] - t.x, landed[1] - (t.y - 150)) <= selW.radius * 1.3
      : false;                                   // 1.3 mirrors game-core DMG_REACH
    const hot = danger || selfBlast;
    // The FIRST ~45% of the flight is drawn — a clear, confident curve that
    // still leaves the fall to the player's judgement. (The full path is
    // integrated regardless, for the red self-damage warning.) NEVER more
    // dots than exist: a steep shot may land within a handful of steps.
    const shown = Math.min(dots.length, Math.max(4, Math.ceil(dots.length * 0.45)));
    // The line is DOTTED, not chained: measure how long the drawn arc really is
    // on screen and thin it to at most 16 squares, never closer than ~18 css px.
    // (A fixed step interval put ~80 squares 5px apart at battle zoom — a solid
    // streak — and a different density again at every other zoom and power.)
    let arcLen = 0;
    for (let i = 1; i < shown; i++) arcLen += Math.hypot(dots[i][0] - dots[i - 1][0], dots[i][1] - dots[i - 1][1]);
    const want = Math.max(2, Math.min(16, Math.round(arcLen * cam.zoom / 18)));
    const stride = Math.max(1, Math.floor((shown - 1) / want) || 1);
    for (let i = 0; i < shown; i += stride) {
      const dsx = wx2s(dots[i][0]), dsy = wy2s(dots[i][1]);
      if (dsx < -20 || dsx > view.cssW + 20 || dsy < -20 || dsy > view.cssH + 20) continue;
      const f = i / shown;
      const k = 3.6 - f * 1.6;                                 // bold near the muzzle
      ctx.globalAlpha = Math.max(0.15, 0.95 - f * 0.8);
      ctx.fillStyle = 'rgba(10,12,16,0.6)';                    // dark under-dot: reads on
      ctx.fillRect(dsx - k / 2 - 1, dsy - k / 2 - 1, k + 2, k + 2);   // sky, snow and sand
      ctx.fillStyle = hot ? 'rgba(255,90,82,.95)' : 'rgba(255,214,70,.95)';
      ctx.fillRect(dsx - k / 2, dsy - k / 2, k, k);
    }
  } catch {} finally {
    ctx.globalAlpha = 1;
  }

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

  if (S.charging) {
    ctx.fillStyle = col; ctx.font = '900 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(aim.power)}%`, sx, sy - 26);
    ctx.textAlign = 'left';
  }
  // The relative drag, made visible: a faint tether from where the finger
  // landed (cross) to where it is now. Reads which way you are pulling and how
  // far while your hand stays clear of the tank and the arc.
  if (S.charging && S.pullAnchor && S.pullPointer) {
    const ax2 = S.pullAnchor.x, ay2 = S.pullAnchor.y;
    ctx.strokeStyle = 'rgba(159,216,255,.38)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 6]);
    ctx.beginPath(); ctx.moveTo(ax2, ay2); ctx.lineTo(S.pullPointer.sx, S.pullPointer.sy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(159,216,255,.75)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax2 - 7, ay2); ctx.lineTo(ax2 + 7, ay2);
    ctx.moveTo(ax2, ay2 - 7); ctx.lineTo(ax2, ay2 + 7);
    ctx.stroke();
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
  // Minigun round: a stubby tracer slug — mostly its own streak.
  minigun(R) {
    ctx.fillStyle = '#ffd9a0';
    ctx.fillRect(-0.7 * R, -0.12 * R, 1.1 * R, 0.24 * R);
    oPoly('#fff3d0', 0.4 * R, -0.12 * R, 0.75 * R, 0, 0.4 * R, 0.12 * R);
  },
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
  // ---- WARLORD ordnance ---------------------------------------------------------
  // Shredder Storm: a fat sawtooth tracer with a heat halo. Reads as a wall of
  // metal even at speed.
  bossslug(R) {
    ctx.globalAlpha = 0.35;
    oPoly('#ffb84d', -2.2 * R, -0.34 * R, 0.9 * R, -0.34 * R, 0.9 * R, 0.34 * R, -2.2 * R, 0.34 * R);
    ctx.globalAlpha = 1;
    oPoly('#8a6a3a', -1.3 * R, -0.3 * R, 0.7 * R, -0.3 * R, 1.25 * R, 0, 0.7 * R, 0.3 * R, -1.3 * R, 0.3 * R);
    oPoly('#ffe9c4', -0.8 * R, -0.12 * R, 0.85 * R, -0.12 * R, 1.1 * R, 0, 0.85 * R, 0.12 * R, -0.8 * R, 0.12 * R);
    oPoly('#ffb84d', -1.55 * R, -0.2 * R, -1.3 * R, 0, -1.55 * R, 0.2 * R);
  },
  // Hellstorm: a finned rocket riding its own exhaust; the flame flickers with
  // the playback position so a rack of eight never strobes in unison.
  bossmissile(R, pos) {
    const fl = 0.7 + 0.3 * Math.sin((pos || 0) * 1.7);
    oPoly('#ff9d3d', -2.1 * R * fl, -0.16 * R, -1.15 * R, -0.3 * R, -1.15 * R, 0.3 * R, -2.1 * R * fl, 0.16 * R);
    oPoly('#ffe2b0', -1.7 * R * fl, -0.08 * R, -1.15 * R, -0.16 * R, -1.15 * R, 0.16 * R, -1.7 * R * fl, 0.08 * R);
    oPoly('#5d4a35', -1.2 * R, -0.62 * R, -0.7 * R, -0.24 * R, -1.2 * R, -0.24 * R);
    oPoly('#5d4a35', -1.2 * R, 0.62 * R, -0.7 * R, 0.24 * R, -1.2 * R, 0.24 * R);
    oOgive(-1.2 * R, 0.5 * R, 1.3 * R, 0.26 * R, '#b8a888');
    ctx.fillStyle = '#7d3b1e'; ctx.fillRect(-0.2 * R, -0.26 * R, 0.4 * R, 0.52 * R);
  },
  // Magma Spew: the shell is a cracked slag boulder, the gobs are molten teeth.
  magmashell(R) {
    oPoly('#3a2c26', -1.1 * R, -0.3 * R, -0.45 * R, -0.85 * R, 0.5 * R, -0.7 * R, 1.1 * R, 0, 0.55 * R, 0.8 * R, -0.6 * R, 0.65 * R);
    ctx.strokeStyle = '#ff6a3d'; ctx.lineWidth = Math.max(1, R * 0.14);
    ctx.beginPath();
    ctx.moveTo(-0.7 * R, -0.2 * R); ctx.lineTo(0.1 * R, 0.05 * R); ctx.lineTo(0.7 * R, -0.3 * R);
    ctx.moveTo(-0.2 * R, 0.6 * R); ctx.lineTo(0.05 * R, 0.02 * R);
    ctx.stroke();
  },
  magmagob(R) {
    oPoly('#ff6a3d', -0.95 * R, 0, -0.4 * R, -0.7 * R, 0.5 * R, -0.55 * R, 0.95 * R, 0.1 * R, 0.3 * R, 0.75 * R, -0.5 * R, 0.55 * R);
    oPoly('#ffd9a0', -0.4 * R, -0.2 * R, 0.25 * R, -0.25 * R, 0.4 * R, 0.2 * R, -0.2 * R, 0.3 * R);
  },
  // Phase Spear: a long coherent energy dart with after-images phasing behind it.
  phasespear(R) {
    const k = 0.6 + 0.4 * Math.sin(performance.now() / 70);
    ctx.globalAlpha = 0.22;
    oPoly('#8affde', -3.4 * R, -0.14 * R, -1.2 * R, -0.14 * R, -1.2 * R, 0.14 * R, -3.4 * R, 0.14 * R);
    ctx.globalAlpha = 0.45;
    oPoly('#8affde', -2.4 * R, -0.2 * R, -0.6 * R, -0.2 * R, -0.6 * R, 0.2 * R, -2.4 * R, 0.2 * R);
    ctx.globalAlpha = 1;
    oPoly('#37e0b0', -1.6 * R, -0.24 * R, 1.7 * R, 0, -1.6 * R, 0.24 * R);
    oPoly(`rgba(235,255,250,${k})`, -0.8 * R, -0.1 * R, 1.5 * R, 0, -0.8 * R, 0.1 * R);
  },
  // Seismic Slam: a blunt piledriver — all mass, no grace.
  quakehammer(R) {
    oTail(-1.5 * R, -0.8 * R, 0.6 * R, '#5d4a35');
    ctx.fillStyle = '#8a7458'; ctx.fillRect(-0.9 * R, -0.5 * R, 1.5 * R, R);
    ctx.fillStyle = '#c9b391'; ctx.fillRect(-0.9 * R, -0.5 * R, 1.5 * R, 0.3 * R);
    ctx.fillStyle = '#3b3227'; ctx.fillRect(0.6 * R, -0.66 * R, 0.55 * R, 1.32 * R);
    ctx.fillStyle = '#c98a4b'; ctx.fillRect(0.28 * R, -0.5 * R, 0.18 * R, R);
  },

  // ---- Horde ordnance ---------------------------------------------------------
  // Plasma Bolt: a green energy shard — nested diamonds with a pulsing core.
  plasma(R) {
    const k = 0.75 + 0.25 * Math.sin(performance.now() / 90);
    oPoly('rgba(125,255,106,0.35)', -1.5 * R, 0, 0, -0.85 * R, 1.5 * R, 0, 0, 0.85 * R);
    oPoly('#7dff6a', -1.05 * R, 0, 0, -0.55 * R, 1.05 * R, 0, 0, 0.55 * R);
    oPoly(`rgba(235,255,220,${k})`, -0.5 * R, 0, 0, -0.26 * R, 0.5 * R, 0, 0, 0.26 * R);
  },
  // Spore pod shell: a veined purple husk, and the spores it bursts into.
  podshell(R) {
    oPoly('#5c3a80', -1.2 * R, 0, -0.3 * R, -0.8 * R, 0.9 * R, -0.5 * R, 1.2 * R, 0, 0.9 * R, 0.5 * R, -0.3 * R, 0.8 * R);
    ctx.strokeStyle = '#b06bff'; ctx.lineWidth = Math.max(1, R * 0.12);
    ctx.beginPath();
    ctx.moveTo(-0.9 * R, 0); ctx.lineTo(0.9 * R, 0);
    ctx.moveTo(-0.3 * R, -0.7 * R); ctx.lineTo(-0.1 * R, 0.7 * R);
    ctx.stroke();
  },
  spore(R) {
    oPoly('#7a4fae', -0.9 * R, 0, 0, -0.7 * R, 0.9 * R, 0, 0, 0.7 * R);
    oPoly('#d9b8ff', -0.35 * R, 0, 0, -0.28 * R, 0.35 * R, 0, 0, 0.28 * R);
  },
  // Phase Lance: a long magenta needle with a phase-shift echo behind it.
  lance(R) {
    ctx.globalAlpha = 0.35;
    oPoly('#ff6bf0', -2.6 * R, -0.16 * R, -0.6 * R, -0.16 * R, -0.6 * R, 0.16 * R, -2.6 * R, 0.16 * R);
    ctx.globalAlpha = 1;
    oPoly('#ff6bf0', -1.8 * R, -0.2 * R, 1.6 * R, 0, -1.8 * R, 0.2 * R);
    oPoly('#ffe2fb', -0.9 * R, -0.09 * R, 1.35 * R, 0, -0.9 * R, 0.09 * R);
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
  // The WARLORD's arsenal is all its own — nothing borrowed from the players.
  if (w === 'b_gatling')   return 'bossslug';
  if (w === 'b_hellstorm') return 'bossmissile';
  if (w === 'b_magma')     return pr.delay > 0 ? 'magmagob' : 'magmashell';
  if (w === 'b_spear')     return 'phasespear';
  if (w === 'b_quake')     return 'quakehammer';
  // Horde kit gets its own silhouettes so alien fire reads on-theme.
  if (w === 'a_plasma')  return 'plasma';
  if (w === 'a_pods')    return pr.delay > 0 ? 'spore' : 'podshell';
  if (w === 'a_lance')   return 'lance';
  if (w === 'driver' || w === 'putter') return 'golfball';   // every club strikes the same ball
  return ORD[w] ? w : 'cannon';          // cannon is the sensible default round
}
// R0 above took the full 50% cut for every fat payload round (mortar, nuke,
// buster, the airstrike stick...). The entries below re-inflate ONLY what must
// stay readable at the smaller base: fragments that would go sub-pixel
// (bomblet/spore/firebomb/magmagob), thin streaks whose identity is their
// length (railgun/minigun/lance/plasma/bossslug), the strike beacon you have
// to be able to track, and the golf ball — which nets out UNCHANGED (x2 on the
// halved base) because in golf the ball IS the game.
const ORD_SCALE = { nuke: 1.30, mortar: 1.12, buster: 1.10, bomb: 0.92, firebomb: 1.2, bomblet: 1.0,
                    spore: 1.0, podshell: 1.05,
                    golfball: 2.0, minigun: 1.6, railgun: 1.4, beacon: 1.3, plasma: 1.2, lance: 1.3,
                    bossslug: 1.2, bossmissile: 1.15, magmashell: 1.05, magmagob: 1.1, phasespear: 1.25, quakehammer: 1.35 };
const ORD_SPIN  = { bomblet: 0.16, firebomb: 0.10, wall: 0.07,
                    spore: 0.12,
                    magmagob: 0.15 };   // radians per path point
const ORD_TRAIL = {
  golfball: 'rgba(244,246,242,.5)', driver: 'rgba(244,246,242,.5)', putter: 'rgba(244,246,242,.5)',
  minigun: 'rgba(255,217,160,.55)',
  cannon: 'rgba(255,220,150,.5)', mortar: 'rgba(255,190,110,.5)', volley: 'rgba(180,170,255,.55)',
  railgun: 'rgba(60,232,143,.75)', cluster: 'rgba(255,210,63,.45)', napalm: 'rgba(255,120,70,.55)',
  gas: 'rgba(157,222,75,.45)', airstrike: 'rgba(84,200,255,.5)', buster: 'rgba(201,138,75,.5)',
  wall: 'rgba(160,120,70,.45)', teleport: 'rgba(200,107,255,.55)', nuke: 'rgba(182,255,90,.5)',
  a_plasma: 'rgba(125,255,106,.65)', a_pods: 'rgba(176,107,255,.5)', a_lance: 'rgba(255,107,240,.7)',
  b_gatling: 'rgba(255,184,77,.75)', b_hellstorm: 'rgba(255,157,61,.6)', b_magma: 'rgba(255,106,61,.6)',
  b_spear: 'rgba(138,255,222,.85)', b_quake: 'rgba(201,138,75,.55)',
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
  // HALVED 2026-07-29 (Jordan: 'payloads are too big... at least 50% smaller'):
  // at the fit-all battle frame the tank draws ~14px wide, and a 9px-R mortar
  // read nearly tank-sized in flight.
  const R0 = 4.5;                                                // shells: one size at every zoom
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
  const u = 3.8;                                                 // bombs: one size at every zoom
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

// Seismic Slam aftermath: columns of dust and shattered rock heaving out of
// the ground, then sagging back. Rectangles and polygons only — house rule.
function drawQuakes() {
  for (const q of S.quakes) {
    const k = q.age / q.life;                       // 0 → 1 over the effect
    const up = Math.sin(Math.min(1, k * 1.6) * Math.PI);  // rise fast, settle slow
    for (let c = -3; c <= 3; c++) {
      const wx = q.x + c * q.r * 0.28;
      const sx = wx2s(wx);
      const gy = wy2s(surfaceAt(wx));   // each column roots in ITS OWN ground
      const jag = 0.7 + ((Math.abs(c * 2654435761) % 97) / 97) * 0.6;   // stable per column
      const h = Math.max(0, up * q.r * 0.5 * jag * (1 - Math.abs(c) * 0.18)) * cam.zoom;
      const w = Math.max(2, q.r * 0.11 * cam.zoom);
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.fillStyle = c % 2 ? '#6b543a' : '#87683f';
      ctx.fillRect(sx - w / 2, gy - h, w, h);
      ctx.fillStyle = '#c9b391';
      ctx.fillRect(sx - w / 2, gy - h, w, Math.max(1.5, h * 0.12));
    }
    ctx.globalAlpha = 1;
  }
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
  $('muteBtn').innerHTML = Audio.muted ? UI_IC.speakerOff : UI_IC.speakerOn;
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
