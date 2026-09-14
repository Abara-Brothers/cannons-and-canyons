// bay.js — LAUNCH BAY, the front end (concept 10). Classic script, no imports,
// loaded AFTER app.js: it reads the game's own top-level state by name (ccMode,
// mySkin, PROF, armPicks…) and drives the same intents the old #home wired, so
// nothing about how a match starts has changed — only the room it starts from.
//
// The design was drawn on a fixed 932x430 frame. Every dimension here is in
// design units via u(n) = calc(n * var(--u)); see styles.css for why.
//
// THE TANK IS RENDERED LIVE, never a PNG. drawTank() is the locked single
// source of the tank art and is bound to the real game canvas, which still
// paints while #game is display:none — so the hero is drawn there inside one
// synchronous call and copied out. One renderer, one tank, every paint real.
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const u = (n) => 'calc(' + n + ' * var(--u))';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const G = {
  get ccMode()        { return typeof ccMode        !== 'undefined' ? ccMode        : undefined; },
  get S()             { return typeof S             !== 'undefined' ? S             : undefined; },
  get SKINS()         { return typeof SKINS         !== 'undefined' ? SKINS         : undefined; },
  get ARM_POOL()      { return typeof ARM_POOL      !== 'undefined' ? ARM_POOL      : undefined; },
  get ARM_DEFAULT()   { return typeof ARM_DEFAULT   !== 'undefined' ? ARM_DEFAULT   : undefined; },
  get UI_IC()         { return typeof UI_IC         !== 'undefined' ? UI_IC         : undefined; },
  get Audio()         { return typeof Audio         !== 'undefined' ? Audio         : undefined; },
  get cam()           { return typeof cam           !== 'undefined' ? cam           : undefined; },
  get view()          { return typeof view          !== 'undefined' ? view          : undefined; },
  get canvas()        { return typeof canvas        !== 'undefined' ? canvas        : undefined; },
  get ctx()           { return typeof ctx           !== 'undefined' ? ctx           : undefined; },
};
const fn = (name) => (typeof window[name] === 'function' ? window[name] : null);   // function declarations live on window
const has = (name) => G[name] !== undefined || !!fn(name);

/* ---- data: the five modes, as the concept wrote them --------------------- */
const MODES = [
  { id: 'duel',   name: 'Duel',           players: '2',         tag: 'Head to head',
    blurb: 'Starts the moment your friend joins. First to bring the other down.',
    art: 'alpine-wide',   card: 'alpine-hero',   draft: 5 },
  { id: 'ffa',    name: 'Free-for-all',   players: '3-4',       tag: 'Last tank standing',
    blurb: 'Three or four commanders, one ridge line. Everyone for themselves.',
    art: 'desert-wide',   card: 'desert-hero',   draft: 5 },
  { id: 'boss',   name: 'Boss Fight',     players: '1-2 co-op', tag: 'Bring down WARLORD-7',
    blurb: 'A mech that fights back. Beat it and the Midnight paint drops.',
    art: 'volcanic-wide', card: 'volcanic-hero', draft: 7 },
  { id: 'aliens', name: 'Alien Invasion', players: '1-2 co-op', tag: 'Hold the line',
    blurb: 'Escalating waves of xeno saucers. See how long you last.',
    art: 'ruins-wide',    card: 'ruins-mid',     draft: 7 },
  { id: 'golf',   name: 'Artillery Golf', players: '1-2',       tag: 'Nine holes, no damage',
    blurb: 'Driver, Iron, Putter. Real rolling physics and a scorecard.',
    art: 'ice-wide',      card: 'ice-mid',       draft: 5 },
];
const modeOf = (id) => MODES.find((m) => m.id === id) || MODES[0];
const art = (k) => 'bay/' + k + '.jpg';

/* ---- hand-drawn icons (house rule: no emoji, ever) ----------------------- */
const MODE_IC = {
  duel: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.4 3.2l13.9 13.9-1.8 1.8L2.6 5z"/><path d="M19.6 3.2L5.7 17.1l1.8 1.8L21.4 5z"/><rect x="2.2" y="19.6" width="8.2" height="2.3" rx="1.1"/><rect x="13.6" y="19.6" width="8.2" height="2.3" rx="1.1"/></svg>',
  ffa: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.4l1.9 6.4 6.4-4-4 6.4 6.3 1.8-6.3 1.8 4 6.4-6.4-4-1.9 6.4-1.8-6.4-6.4 4 4-6.4L1.4 12l6.3-1.8-4-6.4 6.4 4z"/></svg>',
  boss: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 7.6L12 3l7 4.6v8L12 20l-7-4.4z"/><rect x="7.2" y="10.2" width="9.6" height="2.8" fill="#0b1020"/><path d="M9 3.8L7.6 1.4M15 3.8l1.4-2.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  golf: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="10.9" y="2.6" width="1.9" height="15.4"/><path d="M12.8 3l7.2 2.7-7.2 2.7z"/><path d="M3.6 21.4c3.2-2.6 13.6-2.6 16.8 0z"/></svg>',
  aliens: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.8 13.4l10.2-3.6 10.2 3.6-10.2 3.6z"/><path d="M8.4 10.6C8.9 7.9 10.3 6 12 6s3.1 1.9 3.6 4.6L12 11.9z"/><rect x="3.8" y="18.8" width="2" height="2.6"/><rect x="11" y="19.8" width="2" height="2.6"/><rect x="18.2" y="18.8" width="2" height="2.6"/></svg>',
};
const SWORD = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.8 2.6l1.6 1.6-9.4 11.2-2-2-1.4-.6z"/><path d="M7.6 14.2l2.2 2.2-2 2-1.3 3-3-1.3 2-2-1.1-2.7 2.5-2.5z"/></svg>';
const CROWN = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18l-1.2-9-4.6 3.4L12 5.6 8.8 12.4 4.2 9z"/><rect x="4.4" y="19.2" width="15.2" height="2" rx="1"/></svg>';
const IC = {
  back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
       'stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>',
  play:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.4 3.5a1 1 0 0 1 1.5-.9l12 8.5a1 1 0 0 1 0 1.8' +
       'l-12 8.5a1 1 0 0 1-1.5-.9z"/></svg>',
  again:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" ' +
       'stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.2 4.4v5.2H15"/></svg>',
  roller:'<svg viewBox="0 0 24 24" fill="currentColor"><rect x="2.6" y="3.4" width="12.4" height="5.8" rx="1.5"/>' +
       '<path d="M15 5h4.2a2 2 0 0 1 2 2v3.6a2 2 0 0 1-2 2h-6.6v2.2h-2.2v-4.4h8.6V7.2H15z"/>' +
       '<rect x="10" y="14.6" width="3" height="6.4" rx="1.4"/></svg>',
  shell:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.1c2.3 2.5 3.4 4.8 3.4 7.1v1.6H8.6V9.2c0-2.3 1.1-4.6 3.4-7.1z"/>' +
       '<rect x="8.2" y="11.6" width="7.6" height="6.6" rx="1.1"/><rect x="7.2" y="19" width="9.6" height="2.6" rx="1.3"/></svg>',
  medal:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.4 2.2h3.1l2.1 5.7-2.9 1.3z" opacity=".65"/>' +
       '<path d="M16.6 2.2h-3.1l-2.1 5.7 2.9 1.3z" opacity=".65"/><circle cx="12" cy="15.6" r="6"/>' +
       '<circle cx="12" cy="15.6" r="2.6" fill="#0a0e18"/></svg>',
  keypad:'<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3.4" width="18" height="17.2" rx="2.4" opacity=".35"/>' +
       '<rect x="6" y="6.4" width="3.2" height="3.2" rx="1"/><rect x="10.4" y="6.4" width="3.2" height="3.2" rx="1"/>' +
       '<rect x="14.8" y="6.4" width="3.2" height="3.2" rx="1"/><rect x="6" y="10.8" width="3.2" height="3.2" rx="1"/>' +
       '<rect x="10.4" y="10.8" width="3.2" height="3.2" rx="1"/><rect x="14.8" y="10.8" width="3.2" height="3.2" rx="1"/>' +
       '<rect x="6" y="15.2" width="12" height="3.2" rx="1.3"/></svg>',
  gear:'<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3.1"/>' +
       '<path d="M12 2.4l1.5 2.8 3.1-.6.5 3.1 2.8 1.4-1.6 2.7 1.6 2.7-2.8 1.4-.5 3.1-3.1-.6L12 21.6l-1.5-2.8-3.1.6-.5-3.1' +
       '-2.8-1.4L5.7 12 4.1 9.3l2.8-1.4.5-3.1 3.1.6z" opacity=".5"/></svg>',
  tick:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.2 16.6l-4.2-4.2 1.5-1.5 2.7 2.7L17.5 5.3 19 6.8z"/></svg>',
  copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">' +
       '<rect x="8.2" y="3.4" width="12" height="12" rx="2"/><path d="M15.8 18.2v.4a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2V8.6a2 2 0 0 1 2-2h.4"/></svg>'
};

const MOTES = [
  [118,318,9.2,0.0,2],[206,262,11.4,1.4,1.6],[332,344,8.6,2.6,2.2],[418,296,12.2,0.7,1.6],
  [498,362,10.4,3.2,2],[578,276,9.6,1.9,1.6],[658,330,11.8,4.1,2.2],[298,208,13.0,2.2,1.6],
  [462,186,10.8,5.0,2],[622,214,12.4,3.6,1.6],[178,382,9.0,4.6,2.2],[726,384,10.2,2.0,1.6],
  [262,158,14.0,6.0,2],[544,150,12.0,1.1,1.6],[382,398,9.8,5.4,2.2],[700,168,11.2,4.9,1.6]
];

/* ---- what the game currently is --------------------------------------------- */
function state() {
  const mode = has('ccMode') ? ccMode : 'duel';
  const m = modeOf(mode);
  const skinId = has('mySkin') ? mySkin() : 'olive';
  const skin = (has('SKINS') && SKINS[skinId]) || { name: 'Olive' };
  let picks = [];
  try {
    const p = JSON.parse(localStorage.getItem('cc_loadout') || 'null');
    const pool = has('ARM_POOL') ? ARM_POOL : [];
    if (Array.isArray(p)) picks = p.filter((id) => pool.includes(id)).slice(0, m.draft);
  } catch {}
  if (!picks.length && has('ARM_DEFAULT')) picks = ARM_DEFAULT.slice(0, m.draft);
  return {
    mode: m, skinId, skin, picks,
    name: has('myName') ? myName() : 'Commander',
    wins: has('totalWins') ? totalWins() : 0,
    muted: has('Audio') ? !!Audio.muted : false,
  };
}

/* ---- the live tank ---------------------------------------------------------- */
// Draws seat 9 (a seat no match uses) onto the REAL canvas with a flat floor
// and no terrain, then copies it out. Every global drawTank reads is set and
// restored inside this one call; the render loop cannot interleave, and the
// next draw() re-sizes the canvas back anyway because dispW no longer matches.
const TANK_CACHE = new Map();
function tankURL(skinId, cssW) {
  const key = skinId + '@' + cssW;
  if (TANK_CACHE.has(key)) return TANK_CACHE.get(key);
  if (!has('drawTank') || !has('canvas') || !has('S')) return '';
  const H = Math.round(cssW * 246 / 300);
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const keep = {
    cw: canvas.width, ch: canvas.height, view: { ...view }, cam: { ...cam },
    tanks: S.tanks.length, skins: S.skins.length, aim: S.aim.length, hp: S.hp.length,
    recoil: S.recoil.length, lean: S.lean ? S.lean.length : -1,
  };
  let url = '';
  try {
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, H);
    view.cssW = cssW; view.cssH = H;
    const r = cssW * 0.33;                       // tank spans ~2.7r — leaves a margin
    cam.zoom = r / 240; cam.cx = 0;
    // No terrain: surfaceAt() answers a flat floor at world.h * .72, so place
    // the camera so that floor lands at 80% of the frame height.
    const floorY = S.world.h * 0.72;
    cam.cy = floorY - (0.80 * H - H / 2) / cam.zoom;
    S.tanks[9] = { x: 0, y: floorY }; S.skins[9] = skinId;
    S.aim[9] = { angle: 38, power: 60 }; S.hp[9] = 150; S.recoil[9] = 0;
    if (S.lean) S.lean[9] = 0;
    drawTank(9);
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    out.getContext('2d').drawImage(canvas, 0, 0);
    url = out.toDataURL('image/png');
  } catch (e) {
    try { if (has('reportClientError')) reportClientError('bay tank', e); } catch {}
  } finally {
    S.tanks.length = keep.tanks; S.skins.length = keep.skins; S.aim.length = keep.aim;
    S.hp.length = keep.hp; S.recoil.length = keep.recoil;
    if (S.lean && keep.lean >= 0) S.lean.length = keep.lean;
    Object.assign(cam, keep.cam); Object.assign(view, keep.view);
    canvas.width = keep.cw; canvas.height = keep.ch;
    if (has('resize')) { try { resize(); } catch {} }
  }
  TANK_CACHE.set(key, url);
  return url;
}

/* ---- scenery ---------------------------------------------------------------- */
const deco = () => '<div class="deco"><div class="wall"></div><div class="hgrid"></div></div>';
const beams = () => '<div class="deco"><span class="beam b1"></span><span class="beam b2"></span><span class="beam b3"></span></div>';
function dust() {
  let m = '';
  for (const d of MOTES) {
    m += '<span class="mote" style="left:' + u(d[0]) + ';top:' + u(d[1]) + ';width:' + u(d[4]) + ';height:' + u(d[4])
      + ';animation-duration:' + d[2] + 's;animation-delay:-' + d[3] + 's"></span>';
  }
  return '<div class="deco">' + m + '</div>';
}
// The lit platform, the reflection, and the tank itself. o = {cx, cy, w} in design px.
function stage(skinId, o) {
  const w = o.w, h = Math.round(w * 246 / 300);
  const pw = Math.round(w * 1.5), ph = Math.round(pw * 0.193);
  const src = tankURL(skinId, w);
  const img = (extra) => src ? '<img src="' + src + '" alt="Your tank" style="width:' + u(w) + '"' + (extra || '') + '>' : '';
  return '<div class="plat" style="left:' + u(o.cx - pw / 2) + ';top:' + u(o.cy - ph / 2) + ';width:' + u(pw) + ';height:' + u(ph) + '">'
    + '<span class="plate"></span><span class="platc"></span><span class="rim"></span>'
    + '<span class="ringw" style="left:0;top:' + u(Math.round((ph - pw) / 2)) + ';width:' + u(pw) + ';height:' + u(pw) + '"><span class="ring"></span></span></div>'
    + '<div class="refl" style="left:' + u(o.cx - w / 2) + ';top:' + u(o.cy - 7) + ';width:' + u(w) + ';height:' + u(Math.round(h * 0.34)) + '">' + img(' alt=""') + '</div>'
    + '<div class="tankw" style="left:' + u(o.cx - w / 2) + ';top:' + u(o.cy - 3 - h) + ';width:' + u(w) + '">' + img() + '</div>';
}

/* ---- screens ---------------------------------------------------------------- */
const SCREENS = {};

SCREENS.home = function () {
  const s = state(), m = s.mode;
  const arc = [[-6, 14], [-3, 5], [0, 0], [3, 5], [6, 14]];
  const boards = MODES.map((x, i) =>
    '<button class="board' + (x.id === m.id ? ' on' : '') + '" style="transform:rotate(' + arc[i][0] + 'deg) translateY(' + u(arc[i][1]) + ')" '
    + 'data-set="mode=' + x.id + '" title="' + esc(x.name) + '">'
    + '<span class="bcard"><img src="' + art(x.card) + '" alt=""><span class="bsc"></span><span class="barm"></span>'
    + '<span class="bic">' + MODE_IC[x.id] + '</span><span class="bpl">' + esc(x.players) + '</span>'
    + '<span class="blab"><span class="bnm">' + esc(x.name) + '</span><span class="btg">' + esc(x.tag) + '</span></span></span></button>').join('');

  // Recent sorties: online-only, from the ledger, and HIDDEN when empty (owner
  // decision 2026-09-14). No read path exists yet, so today it is always empty.
  const sorties = '';

  const stations = [
    ['paint',   IC.roller, 'Paint shop',     esc(s.skin.name) + ' fitted'],
    ['armoury', IC.shell,  'Armoury',        s.picks.length + ' of ' + m.draft + ' drafted'],
    ['career',  IC.medal,  'Service record', s.wins + ' wins'],
  ].map((t) => '<button class="st" data-go="' + t[0] + '"><span class="sti">' + t[1] + '</span>'
    + '<span class="stt"><span class="stn">' + t[2] + '</span><span class="std">' + t[3] + '</span></span></button>').join('');

  return '<div class="bay">' + deco() + beams() + dust() + '<div class="vig"></div>'
    + '<div class="stage">'
    + '<div class="ap"><img src="' + art(m.art) + '" alt="Cannons and Canyons battlefield">'
    +   '<span class="apsc"></span><span class="aplip"></span>'
    +   '<span class="aprib" style="left:' + u(120) + '"></span><span class="aprib" style="right:' + u(120) + '"></span>'
    +   '<span class="apstr" style="left:0"></span><span class="apstr" style="right:0"></span></div>'
    + '<div class="spill"></div><div class="glow"></div>'
    + stage(s.skinId, { cx: 466, cy: 320, w: 204 })
    + '<div class="top">'
    +   '<div class="mark">Cannons <i>&amp;</i> Canyons<span>Abara Brothers &middot; Launch Bay</span></div>'
    +   '<div class="grow"></div>'
    +   '<button class="chip" data-roll title="Roll a new callsign">' + SWORD + '<b>' + esc(s.name) + '</b></button>'
    +   '<button class="chip" data-go="career">' + CROWN + '<b>' + s.wins + '</b> W</button>'
    +   '<button class="chip sq" data-toggle="sound" title="Sound">' + (has('UI_IC') ? (s.muted ? UI_IC.speakerOff : UI_IC.speakerOn) : '') + '</button>'
    +   '<button class="chip sq" data-go="settings" title="Settings">' + IC.gear + '</button>'
    + '</div>'
    + '<div class="boards">' + boards + '</div>'
    + (sorties ? '<div class="pnl" style="left:' + u(18) + ';top:' + u(162) + ';width:' + u(196) + ';height:' + u(192) + '"><div class="ph">Recent sorties<s></s></div>' + sorties + '</div>' : '')
    + '<div class="pnl" style="right:' + u(18) + ';top:' + u(162) + ';width:' + u(196) + ';height:' + u(192) + '"><div class="ph">Bay stations<s></s></div>' + stations + '</div>'
    + '<div class="lbar">'
    +   '<span class="lic">' + MODE_IC[m.id] + '</span>'
    +   '<span style="display:block"><span class="lnm">' + esc(m.name) + '</span><span class="ltg">' + esc(m.tag) + '</span></span>'
    +   '<span class="lsep"></span>'
    +   '<span class="ro"><span class="rk">Players</span><span class="rv">' + esc(m.players) + '</span></span>'
    +   '<span class="ro"><span class="rk">Weapon draft</span><span class="rv"><em>' + m.draft + '</em> picks</span></span>'
    +   '<span class="ro"><span class="rk">Paint</span><span class="rv">' + esc(s.skin.name) + '</span></span>'
    +   '<span class="grow"></span>'
    +   '<button class="ghost" data-go="join">' + IC.keypad + 'Join code</button>'
    +   '<button class="launch" data-launch>' + IC.play + 'Launch</button>'
    + '</div>'
    + '</div></div>';
};

// A code to join: the one thing the old home had that the bay needs a home for.
SCREENS.join = function () {
  const err = has('$') && $('homeError') ? $('homeError').textContent : '';
  return SCREENS.home() +
    '<div class="jn"><div class="pnl jcard"><div class="ph">Join a code<s></s></div>'
    + '<input id="bayCode" class="b-code-in" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="4-letter game code">'
    + '<p class="jerr">' + esc(err) + '</p>'
    + '<div class="jrow"><button class="ghost" data-go="home">Cancel</button><span class="grow"></span><button class="go" data-join>' + IC.play + 'Join</button></div>'
    + '</div></div>';
};

/* ---- the module ---------------------------------------------------------------- */
let current = 'home';
function render(name) {
  const host = $('bay'); if (!host) return;
  current = name in SCREENS ? name : 'home';
  host.innerHTML = SCREENS[current]();
  host.classList.add('enter');
  setTimeout(() => host.classList.remove('enter'), 900);
  if (current === 'join') { const i = $('bayCode'); if (i) setTimeout(() => i.focus(), 50); }
}

function go(name) {
  // Screens not yet built in the bay fall back to the existing surface for now,
  // so nothing is a dead end while the rest of the concept lands.
  if (name === 'career' && has('$') && $('careerBtn')) { $('careerBtn').onclick(); return; }
  if (name === 'settings' && $('accountBtn')) { $('accountBtn').onclick(); return; }   // delete + export live here
  if (name === 'armoury' && has('openDraft')) { openDraft(state().mode.draft); return; }
  if (name === 'paint' || name === 'modes' || name === 'setup' || name === 'lobby') { if (has('showToast')) showToast('Next up in the bay — for now use the home controls'); return; }
  render(name);
}

document.addEventListener('click', (e) => {
  const host = $('bay'); if (!host || !host.classList.contains('active')) return;
  const t = e.target.closest('[data-go],[data-set],[data-roll],[data-toggle],[data-launch],[data-join]');
  if (!t || !host.contains(t)) return;
  if (has('Audio')) Audio.ensure();
  if (t.dataset.set) {
    const [k, v] = t.dataset.set.split('=');
    if (k === 'mode' && has('ccMode')) { ccMode = v; if (has('syncCreateRow')) syncCreateRow(); }
    render(current); return;
  }
  if ('roll' in t.dataset) {
    if (has('setCallsign') && has('rollCallsign')) setCallsign(rollCallsign(state().name));
    render(current); return;
  }
  if (t.dataset.toggle === 'sound') { const b = $('muteBtn'); if (b) b.click(); render(current); return; }
  if ('launch' in t.dataset) { const b = $('createBtn'); if (b) b.onclick(); return; }   // one tap: the exact old path
  if ('join' in t.dataset) {
    const code = ($('bayCode') && $('bayCode').value || '').trim().toUpperCase();
    if ($('codeInput')) $('codeInput').value = code;
    if ($('joinBtn')) $('joinBtn').onclick();
    setTimeout(() => { if (current === 'join') render('join'); }, 350);   // surface homeError
    return;
  }
  if (t.dataset.go) go(t.dataset.go);
});

window.Bay = { show: render, go, state, tankURL, MODES };

// BOOT. showScreen() routes 'home' to the bay, but it only runs on a TRANSITION
// to home — on first load #home is simply already `active` in the markup and
// nothing calls it. So take the one route in, once, if the flag says to.
if (window.CC_LAUNCH_BAY && has('showScreen')) {
  const home = $('home');
  if (home && home.classList.contains('active')) showScreen('home');
}
})();
