// bay.js — LAUNCH BAY, the front end (concept 10). Classic script, no imports,
// loaded AFTER app.js: it reads the game's own top-level state by name (ccMode,
// mySkin, PROF, armPicks…) and drives the handlers on the legacy control rack in
// index.html, so nothing about how a match starts has changed — only the room
// it starts from.
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
  get ccOpp()         { return typeof ccOpp         !== 'undefined' ? ccOpp         : undefined; },
  get ccFfaOpp()      { return typeof ccFfaOpp      !== 'undefined' ? ccFfaOpp      : undefined; },
  get pendingIntent() { return typeof pendingIntent !== 'undefined' ? pendingIntent : undefined; },
  get ccMax()         { return typeof ccMax         !== 'undefined' ? ccMax         : undefined; },
  get ccTees()        { return typeof ccTees        !== 'undefined' ? ccTees        : undefined; },
  get cpuDifficulty() { return typeof cpuDifficulty !== 'undefined' ? cpuDifficulty : undefined; },
  get HELP_WEAPONS()  { return typeof HELP_WEAPONS  !== 'undefined' ? HELP_WEAPONS  : undefined; },
  get armPicks()      { return typeof armPicks      !== 'undefined' ? armPicks      : undefined; },
  get armNeed()       { return typeof armNeed       !== 'undefined' ? armNeed       : undefined; },
  get S()             { return typeof S             !== 'undefined' ? S             : undefined; },
  get SKINS()         { return typeof SKINS         !== 'undefined' ? SKINS         : undefined; },
  get ARM_POOL()      { return typeof ARM_POOL      !== 'undefined' ? ARM_POOL      : undefined; },
  get ARM_DEFAULT()   { return typeof ARM_DEFAULT   !== 'undefined' ? ARM_DEFAULT   : undefined; },
  get UI_IC()         { return typeof UI_IC         !== 'undefined' ? UI_IC         : undefined; },
  get ICONS()         { return typeof ICONS         !== 'undefined' ? ICONS         : undefined; },
  get PROF()          { return typeof PROF          !== 'undefined' ? PROF          : undefined; },
  get ACHS()          { return typeof ACHS          !== 'undefined' ? ACHS          : undefined; },
  get SKIN_FOR_ACH()  { return typeof SKIN_FOR_ACH  !== 'undefined' ? SKIN_FOR_ACH  : undefined; },
  get MOTION_OK()     { return typeof MOTION_OK     !== 'undefined' ? MOTION_OK     : undefined; },
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
// What the pending lobby says for an invite-room mode: why it needs a
// connection, and what one player can still do on this device.
const SOLO_COPY = {
  boss:   { need: 'Boss Fight needs a connection to bring in a second commander.', can: 'You can take on WARLORD-7 alone on this device.' },
  aliens: { need: 'Alien Invasion needs a connection to bring in a second commander.', can: 'You can hold the line alone on this device.' },
  ffa:    { need: 'Free-for-all needs a connection to invite commanders.', can: 'You can fight CPU commanders on this device.' },
  golf:   { need: 'Artillery Golf needs a connection to invite a second player.', can: 'You can play a solo round on this device.' },
};
const SHORT = { duel: 'Duel', ffa: 'FFA', boss: 'Boss', aliens: 'Aliens', golf: 'Golf' };
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
    opp: has('ccOpp') ? ccOpp : 'friend',
    ffaOpp: has('ccFfaOpp') ? ccFfaOpp : 'friend',
    diff: has('cpuDifficulty') ? cpuDifficulty : 'medium',
    count: has('ccMax') ? ccMax : 4,
    tees: has('ccTees') ? ccTees : 'mens',
    name: has('myName') ? myName() : 'Commander',
    wins: has('totalWins') ? totalWins() : 0,
    muted: has('Audio') ? !!Audio.muted : false,
  };
}

/* ---- the live tank ---------------------------------------------------------- */
// Draws seat 8 (unused by any match; 8 % 4 = 0 gives the player's own blue pennant) onto the REAL canvas with a flat floor
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
    S.tanks[8] = { x: 0, y: floorY }; S.skins[8] = skinId;
    S.aim[8] = { angle: 38, power: 60 }; S.hp[8] = 150; S.recoil[8] = 0;
    if (S.lean) S.lean[8] = 0;
    drawTank(8);
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

/* ---- inner-page chrome: same room, different station ------------------------ */
function chrome(title, sub, meta, body, foot) {
  const s = state();
  return '<div class="bay"><img class="pgart" src="' + art(s.mode.art) + '" alt="">' + deco() + beams() + dust() + '<div class="vig"></div>'
    + '<div class="stage">'
    + '<div class="phead"><button class="bk" data-back aria-label="Back">' + IC.back + '</button>'
    +   '<span style="display:block"><span class="pt">' + title + '</span><span class="ps">' + sub + '</span></span>'
    +   '<span class="grow"></span><span class="pm">' + meta + '</span></div>'
    + '<div class="pbody"' + (foot ? '' : ' style="bottom:' + u(14) + '"') + '>' + body + '</div>'
    + (foot ? '<div class="pfoot">' + foot + '</div>' : '')
    + '</div></div>';
}
// A small tank image for cards and seats — the same live render, smaller.
const tankImg = (skinId, w, alt) => { const src = tankURL(skinId, w); return src ? '<img src="' + src + '" alt="' + (alt || '') + '" style="width:' + u(w) + '">' : ''; };
const wicon = (id) => (G.ICONS && ICONS[id]) || (G.UI_IC && UI_IC[id]) || '';
const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
function seg(label, key, opts, cur, hidden) {
  return '<div class="b-opt' + (hidden ? ' hidden' : '') + '"><span class="lbl">' + label + '</span><div class="segs">'
    + opts.map((o) => '<button class="seg' + (String(cur) === String(o[0]) ? ' on' : '') + '" data-set="' + key + '=' + o[0] + '">' + o[1] + '</button>').join('')
    + '</div></div>';
}
function slots(picks, n) {
  let out = '';
  for (let i = 0; i < n; i++) { const id = picks[i]; out += '<span class="slot' + (id ? ' f' : '') + '">' + (id ? wicon(id) : '') + '</span>'; }
  return out;
}
function loadout(picks, n, label, extra) {
  return '<div class="ldt"><div style="display:flex;align-items:center;gap:' + u(8) + '"><span class="lbl">' + label + '</span><span class="grow"></span>' + (extra || '') + '</div>'
    + '<div class="slots" style="justify-content:flex-start;margin-top:' + u(9) + '">' + slots(picks, n) + '</div></div>';
}

/* ---- the rack: the player's PREFERRED loadout ----------------------------------
   The real draft happens when the server asks (a `pick` message once the lobby
   fills) and it prefills from cc_loadout. So the bay's Armoury edits that
   preference: every change is persisted at once, and the server-prompted draft
   opens already full. */
const RACK_ORDER = ['cannon', 'mortar', 'volley', 'railgun', 'cluster', 'napalm', 'gas', 'airstrike', 'buster', 'wall', 'teleport', 'nuke', 'minigun'];
function weaponInfo(id) {
  const w = (has('HELP_WEAPONS') && HELP_WEAPONS.find((h) => h.id === id)) || { id, name: id, note: '', desc: '' };
  const n = /unlimited/i.test(w.note || '') ? Infinity : parseInt(w.note, 10);
  return { id, name: w.name, desc: w.desc || '', ammo: Number.isFinite(n) ? n : (id === 'railgun' ? 0 : Infinity) };
}
let rack = null;                 // the working copy, initialised from state().picks
function rackPicks() { if (!rack) rack = state().picks.slice(); return rack; }
function togglePick(id) {
  const n = state().mode.draft, r = rackPicks(), at = r.indexOf(id);
  if (at >= 0) r.splice(at, 1); else if (r.length < n) r.push(id);
  try { localStorage.setItem('cc_loadout', JSON.stringify(r)); } catch {}
  // If the game's own draft is open for this size, keep it in step too.
  if (has('armPicks') && G.armNeed === n) { armPicks.length = 0; for (const x of r) armPicks.push(x); }
}

/* ---- preferences, rank, haptics ----------------------------------------------- */
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const setPref = (k, on) => { try { localStorage.setItem(k, on ? '1' : '0'); } catch {} };
const IS_NATIVE_BAY = !!(window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() !== 'web');
const IS_IOS_BAY = IS_NATIVE_BAY && window.Capacitor.getPlatform() === 'ios';
// Rank is a title over total wins -- local, client-asserted, never cross-player
// (owner decision 2026-09-14, consistent with the entitlement design).
const RANKS = [[0, 'Recruit'], [1, 'Gunner I'], [5, 'Gunner II'], [12, 'Gunner III'], [25, 'Sergeant'], [50, 'Lieutenant'], [100, 'Captain'], [200, 'Major'], [400, 'Colonel']];
const rankFor = (w) => RANKS.reduce((r, [t, n]) => (w >= t ? n : r), RANKS[0][1]);
// Haptics: the Capacitor plugin on a phone, navigator.vibrate on the web (a
// no-op on iOS Safari, which is exactly why the plugin exists). Off by default
// on the web, on by default on a phone; the setting is the player's either way.
const hapticsOn = () => pref('cc_haptics', IS_NATIVE_BAY);
function haptic(r) {
  if (!hapticsOn()) return;
  const style = r > 1200 ? 'HEAVY' : r > 600 ? 'MEDIUM' : 'LIGHT';
  const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
  try {
    if (H && H.impact) { H.impact({ style }).catch(() => {}); return; }
    if (navigator.vibrate) navigator.vibrate(style === 'HEAVY' ? 40 : style === 'MEDIUM' ? 25 : 12);
  } catch {}
}
// Reduced motion: the OS setting is honoured already (MOTION_OK + five CSS
// media blocks). This is the in-app override on top: a body class the stylesheet
// mirrors, and the same JS flag the canvas effects read.
function applyMotion() {
  const on = pref('cc_motion', false);
  document.body.classList.toggle('reduce-motion', on);
  if (G.MOTION_OK !== undefined) { let os = false; try { os = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch {} MOTION_OK = !on && !os; }
}
const km = (u) => (u >= 1000 ? (u / 1000).toFixed(1) + 'k' : String(u));

/* ---- recent sorties ------------------------------------------------------------
   Online matches only, read from the server's ledger through /history (the
   ledger is deny-all to clients; the server resolves opponents to callsigns
   and never hands over a uuid). Hidden when empty by decision, so a mostly
   offline player never sees an empty box. Fetched at most once a minute. */
const API = IS_NATIVE_BAY ? 'https://' + (window.CC_NATIVE_HOST || 'tanks.abarabrothers.com') : '';
let sorties = { rows: [], at: 0, busy: false };
function ago(iso) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 2) return 'just now'; if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24); return d === 1 ? 'yesterday' : d + ' days';
}
async function loadSorties() {
  if (sorties.busy || Date.now() - sorties.at < 60000) return;
  const C = window.Cloud; if (!C || !C.enabled || !C.enabled()) return;
  sorties.busy = true;
  try {
    const tok = await C.token(false);          // never mint an account just to read history
    if (!tok) return;
    const r = await fetch(API + '/history', { headers: { Authorization: 'Bearer ' + tok } });
    if (!r.ok) return;
    const j = await r.json();
    sorties.rows = Array.isArray(j.rows) ? j.rows.slice(0, 4) : [];
    sorties.at = Date.now();
    if (current === 'home') render('home');   // the panel appears once there is something in it
  } catch {} finally { sorties.busy = false; }
}
function sortiesPanel() {
  const rows = sorties.rows.map((r) =>
    '<button class="sor" data-rematch="' + esc(r.mode) + '" data-vs="' + (r.opponent === 'Computer' ? 'cpu' : 'friend') + '" title="Play ' + esc(modeOf(r.mode).name) + ' again">'
    + '<span class="stx"><span class="snm">' + esc(r.opponent || 'Commander') + '</span>'
    + '<span class="smt">' + esc(SHORT[r.mode] || r.mode) + ' &middot; ' + esc(ago(r.when)) + '</span></span>'
    + '<span class="res ' + (r.result === 'W' ? 'w' : r.result === 'L' ? 'l' : '') + '">' + esc(r.result || '&ndash;') + '</span>'
    + IC.again.replace('<svg', '<svg class="rag"') + '</button>').join('');
  return '<div class="pnl' + (rows ? '' : ' hidden') + '" style="left:' + u(18) + ';top:' + u(162) + ';width:' + u(196) + ';height:' + u(192) + '"><div class="ph">Recent sorties<s></s></div>' + rows + '</div>';
}

/* ---- screens ---------------------------------------------------------------- */
const SCREENS = {};

// 6 -- SERVICE RECORD. Every number is the real career; rank and streak are the
// two new fields (streak is written by app.js at game over).
SCREENS.career = function () {
  const s = state(), P = G.PROF || { modes: {}, ach: {} };
  const wins = s.wins, losses = Object.values(P.modes || {}).reduce((a, x) => a + (x.l || 0), 0), played = wins + losses;
  const acc = P.shots ? Math.round((P.hits || 0) / P.shots * 100) : 0;
  const rank = rankFor(wins), streak = P.streak || 0;
  const achs = G.ACHS || [], earned = achs.filter(([id]) => P.ach && P.ach[id]).length;
  const stats = [['Shots fired', P.shots || 0], ['Direct hits', P.hits || 0], ['Accuracy', acc + '%'], ['Longest shot', P.longest ? km(P.longest) : '—'], ['Biggest hit', P.maxDmg || 0]]
    .map((r) => '<div class="srow"><span class="lbl">' + r[0] + '</span><b>' + r[1] + '</b></div>').join('');
  const maxW = Math.max(1, ...MODES.map((m) => ((P.modes || {})[m.id] || {}).w || 0));
  const bars = MODES.map((m) => { const v = ((P.modes || {})[m.id] || {}).w || 0;
    return '<div class="bar"><span class="bn">' + esc(SHORT[m.id]) + '</span><span class="bt"><i style="width:' + Math.max(4, Math.round(v / maxW * 100)) + '%"></i></span><span class="bv">' + v + '</span></div>'; }).join('');
  const rows = achs.map(([id, name, how]) => { const got = !!(P.ach && P.ach[id]); const paint = G.SKIN_FOR_ACH && SKIN_FOR_ACH[id] && G.SKINS && SKINS[SKIN_FOR_ACH[id]];
    return '<div class="b-ach' + (got ? ' got' : '') + '"><span class="ai">' + (got ? IC.tick : (G.UI_IC ? UI_IC.lock : '')) + '</span>'
      + '<span class="at"><span class="an">' + esc(name) + '</span><span class="ad">' + esc(how) + (paint ? ' &middot; ' + esc(paint.name) + ' paint' : '') + '</span></span></div>'; }).join('');
  const body = '<div class="cols" style="height:' + u(288) + '">'
    + '<div class="card cmd" style="width:' + u(186) + '">' + tankImg(s.skinId, 120, 'Your tank') + '<span class="lbl">Rank</span><div class="rank">' + esc(rank) + '</div>'
    +   '<div class="wl"><div class="wlc"><b>' + wins + '</b><span class="lbl">Wins</span></div><div class="wlc"><b>' + played + '</b><span class="lbl">Played</span></div>'
    +   '<div class="wlc"><b style="color:#ffb46b">' + streak + '</b><span class="lbl">Streak</span></div></div></div>'
    + '<div style="width:' + u(224) + ';display:flex;flex-direction:column">' + stats + '<div style="margin-top:' + u(12) + '"><span class="lbl">Wins by mode</span>' + bars + '</div>'
    +   '<div style="flex:1"></div><button class="ghost" style="justify-content:center;height:' + u(34) + ';font-size:' + u(13) + '" data-go="paint">Paint shop</button></div>'
    + '<div style="flex:1;min-width:0"><span class="lbl" style="margin-bottom:' + u(6) + '">Challenges</span><div class="achs">' + rows + '</div></div>'
    + '</div>';
  return chrome('Service record', esc(s.name) + ' &middot; ' + earned + ' of ' + achs.length + ' challenges cleared', esc(rank), body, '');
};

// 7 -- PAINT SHOP. Six paints, three earned in the field. The stage tank IS the
// preview: choosing a paint re-renders drawTank in it.
SCREENS.paint = function () {
  const s = state(), SK = G.SKINS || {}, unlocked = (id) => (fn('skinUnlocked') ? skinUnlocked(id) : !SK[id].locked);
  const cur = SK[s.skinId] || { name: 'Olive' }, lockedN = Object.keys(SK).filter((id) => !unlocked(id)).length;
  const sws = Object.entries(SK).map(([id, sk]) => { const ok = unlocked(id), on = id === s.skinId;
    return '<button class="sw' + (on ? ' on' : '') + (ok ? '' : ' lk') + '" data-skin="' + id + '" style="background:linear-gradient(148deg,' + sk.lite + ',' + sk.mid + ' 52%,' + sk.dark + ')" title="' + esc(ok ? sk.name : sk.name + ' — ' + (sk.how || '')) + '">'
      + (ok ? '' : '<span class="lki">' + (G.UI_IC ? UI_IC.lock : '') + '</span>') + '<span class="swn">' + esc(sk.name) + '</span></button>'; }).join('');
  return '<div class="bay">' + deco() + beams() + dust() + '<div class="vig"></div><div class="stage">'
    + '<div class="glow" style="left:' + u(326) + ';top:' + u(96) + ';width:' + u(520) + ';height:' + u(290) + '"></div>'
    + stage(s.skinId, { cx: 326, cy: 344, w: 286 })
    + '<div class="phead"><button class="bk" data-back aria-label="Back">' + IC.back + '</button><span style="display:block"><span class="pt">Paint shop</span><span class="ps">Six paints &middot; three earned in the field</span></span><span class="grow"></span><span class="pm">' + esc(s.name) + '</span></div>'
    + '<div style="position:absolute;left:' + u(26) + ';bottom:' + u(26) + ';z-index:14;width:' + u(300) + '"><span class="lbl">Now fitted</span><div class="b-pname">' + esc(cur.name) + '</div>'
    +   '<div class="phow">Applied to your hull. Every commander sees this paint in the lobby and on the battlefield.</div></div>'
    + '<div class="card" style="position:absolute;right:' + u(18) + ';top:' + u(70) + ';bottom:' + u(16) + ';width:' + u(288) + ';padding:' + u(12) + ';z-index:14"><div class="ph">Paint locker<s></s></div><div class="swg">' + sws + '</div>'
    +   '<div style="margin-top:' + u(11) + ';padding-top:' + u(10) + ';border-top:1px solid rgba(140,168,214,.18)"><span class="lbl">' + (lockedN ? lockedN + ' still locked' : 'Every paint earned') + '</span>'
    +   '<div style="font-size:' + u(10.5) + ';color:#8798bd;line-height:1.4;margin-top:' + u(5) + ';font-weight:500">Earned in the field, never bought.</div></div>'
    +   '<button class="go" style="position:absolute;left:' + u(12) + ';right:' + u(12) + ';bottom:' + u(12) + ';width:auto" data-back>Back to the bay</button></div>'
    + '</div></div>';
};

// 8 -- BAY CONTROLS. Two things the concept left out are here because the
// stores require them in-app: account deletion and data export (via the
// account panel) and the field manual (How to play).
SCREENS.settings = function () {
  const s = state();
  const accState = ($('accountBtn') && $('accountBtn').dataset.state) || 'out';
  const notifyHidden = !$('notifyBtn') || $('notifyBtn').classList.contains('hidden');
  let notifyOn = false; try { notifyOn = !IS_NATIVE_BAY && 'Notification' in window && Notification.permission === 'granted'; } catch {}
  const T = [
    ['sound',    'Sound',          'Synthesized effects and impacts',        !s.muted, false],
    ['aimGuide', 'Aim guide',      'Show the first-battle coaching again',   pref('cc_aimguide', false), false],
    ['motion',   'Reduced motion', 'Calm the menu and battlefield motion',   pref('cc_motion', false), false],
    ['haptics',  'Haptics',        IS_NATIVE_BAY ? 'Vibrate on impact' : 'Vibrate on impact (phones only)', hapticsOn(), false],
    ['notify',   'Turn alerts',    notifyHidden ? 'Not available on this build yet' : 'Nudge me when a battle needs me', notifyOn, notifyHidden],
  ].map((r) => '<div class="row"><span class="rt"><span class="rn2">' + r[1] + '</span><span class="rd">' + r[2] + '</span></span>'
    + '<button class="rk2' + (r[3] ? ' on' : '') + '" data-toggle="' + r[0] + '" aria-label="' + r[1] + '"' + (r[4] ? ' disabled style="opacity:.4"' : '') + '><i></i><u>' + (r[3] ? 'On' : 'Off') + '</u></button></div>').join('');
  const row = (n, d, btn, act) => '<div class="row"><span class="rt"><span class="rn2">' + n + '</span><span class="rd">' + d + '</span></span>' + (btn ? '<button class="sbtn" ' + act + '>' + btn + '</button>' : '') + '</div>';
  const right = row('Account', accState === 'in' ? 'Signed in &mdash; progress syncs across devices' : accState === 'guest' ? 'Guest &mdash; sign in to keep progress across devices' : 'Sign in to keep progress across devices', accState === 'out' ? 'Sign in' : 'Manage', 'data-old="accountBtn"')
    + row('Callsign', esc(s.name), 'Roll', 'data-roll')
    + row('Tank paint', esc(s.skin.name) + ' is fitted', 'Open', 'data-go="paint"')
    + row('How to play', 'The six-chapter field manual', 'Open', 'data-old="helpHomeBtn"')
    + row('Privacy policy', 'Opens in your browser', '&rarr;', 'data-old="privacyLink"')
    + '<div class="card" style="margin-top:' + u(10) + ';padding:' + u(10) + ' ' + u(13) + '"><span class="lbl">Built by</span>'
    + '<div style="font-family:Rajdhani,system-ui,sans-serif;font-weight:700;font-size:' + u(19) + ';text-transform:uppercase;letter-spacing:.05em;margin-top:' + u(4) + ';color:#eef3ff">Abara Brothers</div>'
    + '<div style="font-size:' + u(10.5) + ';color:#7f8fb5;margin-top:' + u(4) + ';font-weight:500">Cannons &amp; Canyons &mdash; landscape only, best with a friend.</div></div>';
  return chrome('Bay controls', accState === 'in' ? 'Signed in &mdash; progress syncs across devices' : 'Guest &mdash; progress is stored on this device', 'Abara Brothers',
    '<div class="set" style="height:' + u(300) + '"><div style="flex:1">' + T + '</div><div style="flex:1">' + right + '</div></div>', '');
};

// 4 — ARMOURY. Load the rack: n weapons go into the field.
SCREENS.armoury = function () {
  const s = state(), n = s.mode.draft, picks = rackPicks().slice(0, n), full = picks.length >= n;
  const pool = has('ARM_POOL') ? ARM_POOL : [];
  const cells = RACK_ORDER.map((id) => {
    const w = weaponInfo(id), on = picks.includes(id), pickable = pool.includes(id);
    const issued = id === 'cannon' || id === 'nuke';
    return '<button class="wp' + (on || issued ? ' on' : '') + (pickable ? '' : ' fixed') + '"' + (pickable ? ' data-pick="' + id + '"' : ' disabled') + ' title="' + esc(w.desc) + '">'
      + '<span class="b-wa">' + (w.ammo === Infinity ? '&#8734;' : w.ammo) + '</span>' + wicon(id) + '<span class="b-wn">' + esc(w.name) + '</span></button>';
  }).join('');
  const last = weaponInfo(picks[picks.length - 1] || 'cannon');
  const info = '<span class="winfo"><span class="wt">' + wicon(last.id) + '<span class="wtn">' + esc(last.name) + '</span><span class="grow"></span>'
    + '<span class="lbl">' + (last.ammo === Infinity ? 'Unlimited' : last.ammo + ' shots') + '</span></span><span class="wd">' + esc(last.desc) + '</span></span>';
  const body = '<div class="cols">'
    + '<div class="card" style="width:' + u(262) + ';position:relative;overflow:hidden">'
    +   '<div style="position:absolute;left:' + u(12) + ';right:' + u(12) + ';top:' + u(11) + ';z-index:2"><span class="lbl">Rack loadout</span>'
    +     '<div style="font-family:Rajdhani,system-ui,sans-serif;font-weight:700;font-size:' + u(19) + ';text-transform:uppercase;letter-spacing:.03em;margin-top:' + u(4) + ';color:#eef3ff">' + esc(s.mode.name) + '</div></div>'
    +   stage(s.skinId, { cx: 131, cy: 224, w: 164 })
    +   '<div style="position:absolute;left:0;right:0;bottom:' + u(10) + ';padding:0 ' + u(12) + ';z-index:2">'
    +     '<div style="display:flex;align-items:flex-end;justify-content:space-between"><span class="lbl" style="padding-bottom:' + u(3) + '">Loaded</span>'
    +       '<span class="b-cnt" style="color:' + (full ? '#3ce88f' : '#ffb46b') + '">' + picks.length + '<span style="font-size:' + u(16) + ';color:#7f8fb5"> / ' + n + '</span></span></div>'
    +     '<div class="slots">' + slots(picks, n) + '</div></div>'
    + '</div>'
    + '<div class="rack">' + cells + info + '</div>'
    + '</div>';
  const foot = '<span class="hint">Everyone carries the Cannon &middot; the Railgun only drops in crates</span><span class="grow"></span>'
    + '<button class="go" ' + (full ? 'data-launch' : 'disabled') + '>' + (full ? 'Open the bay doors' + IC.play : 'Pick ' + (n - picks.length) + ' more') + '</button>';
  return chrome('Armoury', 'Load the rack &mdash; ' + n + ' weapons go into the field', 'Step 3 of 3', body, foot);
};

// 5 — LOBBY. Fed by the game's own lobby messages (see the wrappers at the
// bottom); every button calls the existing handler so the wire is untouched.
let lobby = { m: null, mode: 'host' };
SCREENS.lobby = function () {
  const s = state(), m = lobby.m, searching = lobby.mode === 'search';
  const solo = !!(G.S && S.local);
  // Three PENDING states precede a room: a queued create is shown here while
  // the device is offline, while the server is being reached, and once it has
  // not answered. Nothing exists yet; the copy says so and offers Play solo.
  const st = lobby.mode;
  const pending = st === 'offline' || st === 'connecting' || st === 'unreachable';
  const code = (m && m.code) || (G.S && S.code) || '';
  const isHost = m ? m.you === m.host : true;
  const filled = m ? m.players.filter(Boolean).length : 1;
  // While pending, the QUEUED create is the truth about the mode and the seat
  // count — not the board the bay happens to have lit, which any caller of
  // intent() may differ from. A real room's payload wins once it exists.
  const qi = pending && G.pendingIntent && G.pendingIntent.type === 'create' ? G.pendingIntent : null;
  const max = m ? m.max : (qi && qi.max) || 2;
  const mode = m ? modeOf(m.mode) : qi ? modeOf(qi.mode) : s.mode;
  const cp = SOLO_COPY[mode.id] || SOLO_COPY.boss;
  const roster = (() => {
    if (pending) return '';                       // nothing has been created yet
    if (searching) return '<div class="seat wait"><span class="b-dot" style="background:#6f7fa6;margin-left:' + u(16) + '"></span><span class="sn">Searching for an opponent</span><span class="spin"></span></div>';
    let out = '';
    for (let i = 0; i < max; i++) {
      const p = m && m.players[i], you = m && i === m.you, host = m && i === m.host;
      const col = fn('seatColor') ? seatColor(i) : '#54c8ff';
      if (p) out += '<div class="seat">' + (you ? tankImg(s.skinId, 44) : '') + '<span class="b-dot" style="background:' + col + (you ? '' : ';margin-left:' + u(16)) + '"></span>'
        + '<span class="sn">' + esc(p.name) + '</span><span class="lbl" style="margin-left:auto">' + (host ? 'Host' : '') + (you ? (host ? ' &middot; you' : 'You') : '') + '</span></div>';
      else if (!solo) out += '<div class="seat wait"><span class="b-dot" style="background:#6f7fa6;margin-left:' + u(16) + '"></span><span class="sn">' + (mode.id === 'duel' ? 'Waiting for a commander' : 'Open slot') + '</span><span class="spin"></span></div>';
    }
    return out;
  })();
  const hostStarts = mode.id !== 'duel';
  const minSeats = mode.id === 'ffa' ? 2 : 1;
  const canStart = isHost && hostStarts && !searching;
  const nudgeHidden = !$('notifyBtn') || $('notifyBtn').classList.contains('hidden');
  const note = (t) => '<div style="margin-top:' + u(14) + ';font-size:' + u(11.5) + ';color:#8798bd;line-height:1.45;max-width:' + u(270) + ';font-weight:500">' + t + '</div>';
  const big = (t, green) => '<div class="b-code" style="font-size:' + u(44) + ';letter-spacing:.05em' + (green ? ';color:#3ce88f;text-shadow:0 0 ' + u(40) + ' rgba(60,232,143,.4)' : '') + '">' + t + '</div>';
  const left = pending
    ? '<span class="lbl">' + (st === 'offline' ? 'No connection' : st === 'connecting' ? 'One moment' : 'Server not responding') + '</span>'
      + big(st === 'offline' ? 'OFFLINE' : st === 'connecting' ? 'LINKING' : 'NO LINK', false)
      + note(st === 'connecting' ? 'Setting up your room. This can take a few seconds after an update.'
        : st === 'unreachable' ? esc(cp.need) + ' We keep trying in the background. ' + esc(cp.can)
        : esc(cp.need) + ' ' + esc(cp.can))
    : solo
    ? '<span class="lbl">Solo run</span>' + big('OFFLINE', true)
      + note('Nobody can join this room. Closing the app ends the run.')
    : searching
    ? '<span class="lbl">Quick match</span><div class="b-code" style="font-size:' + u(44) + ';letter-spacing:.05em">SEARCHING</div>'
      + '<div style="margin-top:' + u(14) + ';font-size:' + u(11.5) + ';color:#8798bd;line-height:1.45;max-width:' + u(270) + ';font-weight:500">We&rsquo;ll drop you into a battle the moment someone else is looking too.</div>'
    : '<span class="lbl">Share this code</span><div class="b-code">' + esc(code) + '</div>'
      + '<div style="display:flex;gap:' + u(8) + ';margin-top:' + u(16) + '"><button class="go cy" style="height:' + u(36) + ';font-size:' + u(15) + ';padding:0 ' + u(16) + '" data-old="copyLinkBtn">' + IC.copy + 'Copy link</button>'
      + '<button class="ghost" style="height:' + u(36) + ';font-size:' + u(13) + '" data-old="copyCodeBtn">Copy code</button></div>'
      + '<div style="margin-top:' + u(14) + ';font-size:' + u(11.5) + ';color:#8798bd;line-height:1.45;max-width:' + u(270) + ';font-weight:500">'
      + (mode.id === 'ffa' && isHost ? 'Send the link. Start whenever you have enough players &mdash; you don&rsquo;t have to wait for a full lobby.' : hostStarts && !isHost ? 'Waiting for the host to start the battle&hellip;' : 'The battle starts the moment they join &mdash; no lobby countdown.') + '</div>';
  const summary = '<div style="display:flex;gap:' + u(26) + ';margin-top:' + u(16) + ';padding-top:' + u(13) + ';border-top:1px solid rgba(140,168,214,.2)">'
    + '<span class="ro"><span class="rk">Mode</span><span class="rv">' + esc(mode.name) + '</span></span>'
    + '<span class="ro"><span class="rk">Players</span><span class="rv">' + (solo ? filled : filled + ' / ' + max) + '</span></span>'
    + '<span class="ro"><span class="rk">Paint</span><span class="rv">' + esc(s.skin.name) + '</span></span></div>';
  const right = '<span class="lbl">' + (solo ? 'Deploying' : 'Roster') + '</span>' + roster
    + '<button class="ghost' + (nudgeHidden || solo || searching || pending ? ' hidden' : '') + '" style="width:100%;margin-top:' + u(10) + ';height:' + u(34) + ';font-size:' + u(13) + ';justify-content:center" data-old="notifyBtn">Nudge me when they join</button>'
    + '<div style="margin-top:' + u(12) + '">' + loadout(rackPicks().slice(0, mode.draft), mode.draft, 'Rack loaded', pending || solo ? '' : '<button class="ghost" style="height:' + u(28) + ';font-size:' + u(12) + ';padding:0 ' + u(11) + '" data-go="armoury">Change</button>') + '</div>';
  const title = pending ? (st === 'offline' ? 'No connection' : st === 'connecting' ? 'Reaching the server' : 'Cannot reach the server')
    : solo ? 'Solo run' : searching ? 'Searching' : filled >= max ? 'Bay doors opening' : 'Bay doors sealed';
  const count = solo ? '' : ' (' + filled + ')';
  const startLabel = filled < minSeats ? 'Start (need ' + minSeats + ')' : mode.id === 'boss' ? 'Engage the WARLORD' + count : mode.id === 'golf' ? 'Tee off' + count : 'Start battle' + count;
  // While the server is being reached there is nothing to offer yet; once it
  // is offline or has not answered, Play solo. Cancel is always there — and
  // the header's Back arrow is routed through it (see the click handler).
  const foot = '<button class="ghost" data-old="cancelBtn">Cancel</button><span class="grow"></span>'
    + (pending
      ? (st === 'connecting' ? '' : '<button class="go" data-solo>Play solo' + IC.play + '</button>')
      : '<button class="go' + (canStart ? '' : ' hidden') + '" ' + (filled < minSeats ? 'disabled' : 'data-old="startMatchBtn"') + '>' + startLabel + IC.play + '</button>');
  return chrome(title, esc(mode.name) + ' &middot; ' + rackPicks().slice(0, mode.draft).length + ' weapons loaded', pending ? (st === 'offline' ? 'Offline' : st === 'connecting' ? 'Waiting room' : 'Retrying') : solo ? 'Solo drop' : searching ? 'Quick match' : 'Waiting room',
    '<div class="doors"><span class="door" style="left:0"></span><span class="door" style="right:0"></span></div>'
    + '<div class="cols" style="align-items:center;padding:0 ' + u(34) + '"><div style="width:' + u(420) + '">' + left + summary + '</div><div style="flex:1">' + right + '</div></div>', foot);
};

// 2 — MISSION BOARD. Five ways to bring down a mountain; a card both selects
// the mode and steps into its setup.
SCREENS.modes = function () {
  const s = state();
  const cards = MODES.map((x) => {
    const on = x.id === s.mode.id;
    return '<button class="mb' + (on ? ' on' : '') + '" data-set="mode=' + x.id + '" data-go="setup">'
      + '<span class="mbi"><img src="' + art(x.card) + '" alt=""><span class="g"></span><span class="lip"></span>'
      +   '<span class="mbicn">' + MODE_IC[x.id] + '</span><span class="mbn">' + esc(x.name) + '</span></span>'
      + '<span class="mbc"><span class="mbt' + (on ? '' : ' mbt2') + '">' + (on ? 'Armed &middot; ' : '') + esc(x.tag) + '</span>'
      +   '<span class="mbb">' + esc(x.blurb) + '</span>'
      +   '<span class="mbf"><span class="tagm">' + esc(x.players) + ' players</span><span class="tagm">' + x.draft + ' weapons</span></span></span></button>';
  }).join('');
  return chrome('Mission board', 'Five ways to bring down a mountain', 'Step 1 of 3', '<div class="mrow">' + cards + '</div>', '');
};

// 3 — MATCH SETUP. Opponent, the per-mode option, who you are rolling out as,
// and the rack. Drives the same variables the old create row did.
SCREENS.setup = function () {
  const s = state(), m = s.mode;
  const cpuMode = m.id === 'duel' || m.id === 'ffa';
  const oppKey = m.id === 'ffa' ? 'ffaOpp' : 'opp';
  const oppVal = m.id === 'ffa' ? s.ffaOpp : s.opp;
  const vsCpu = cpuMode && oppVal === 'cpu';
  // Every group is always in the tree, hidden when it does not apply, so a
  // change never reshapes the siblings and the in-place patch lands cleanly.
  // Duel and Free-for-all offer the computer; each remembers its own choice.
  // With Computer picked, the count control keeps its values (ccMax 3 / 4)
  // and only its labels change to the number of CPUs that implies.
  const oppSeg = seg('Opponent', oppKey, [['friend', m.id === 'ffa' ? 'Friends by code' : 'Friend by code'], ['cpu', 'Computer']], oppVal, !cpuMode);
  const extra = seg(vsCpu ? 'CPU commanders' : 'Commanders on the ridge', 'count', vsCpu ? [[3, '2'], [4, '3']] : [[3, '3'], [4, '4']], s.count, m.id !== 'ffa')
    + seg('Tee set', 'tees', [['champ', 'Champ'], ['mens', 'Men&rsquo;s'], ['womens', 'Women&rsquo;s'], ['junior', 'Junior']], s.tees, m.id !== 'golf')
    + seg('Difficulty', 'diff', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], s.diff, !vsCpu);
  const oppText = vsCpu ? 'Computer &middot; ' + esc(cap(s.diff)) : (m.id === 'ffa' ? 'Friends by code' : 'Friend by code');
  const tall = m.id === 'ffa' && vsCpu;       // three visible option groups

  const body = '<div class="cols">'
    // The column is a fixed 274u tall (.cols). One or two option groups leave
    // the crew card room to stretch, exactly as before. Free-for-all + Computer
    // shows THREE, which cannot fit at any viewport: only then does the column
    // scroll and the card keep its own height (grow, never shrink) instead of
    // spilling over the footer. The two-group markup is byte-identical.
    + '<div style="width:' + u(430) + ';display:flex;flex-direction:column;gap:' + u(12) + (tall ? ';min-height:0;overflow-y:auto;overflow-x:hidden' : '') + '">' + oppSeg + extra
    +   '<div class="card" style="flex:' + (tall ? '1 0 auto' : '1') + ';min-height:0;padding:0 ' + u(13) + ';display:flex;flex-direction:column;justify-content:space-evenly">'
    +     '<div class="crew" style="border:0;background:none;padding:0">' + tankImg(s.skinId, 56, 'Your tank')
    +       '<span class="ct"><span class="lbl">Rolling out as</span>'
    +       '<span style="display:block;font-family:Rajdhani,system-ui,sans-serif;font-weight:700;font-size:' + u(19) + ';text-transform:uppercase;letter-spacing:.03em;margin-top:' + u(4) + ';color:#eef3ff">' + esc(s.name) + '</span>'
    +       '<span style="display:block;font-family:\'JetBrains Mono\',monospace;font-size:' + u(8.5) + ';font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:#ffb46b;margin-top:' + u(4) + '">' + esc(s.skin.name) + ' paint</span></span>'
    +       '<button class="ghost" style="height:' + u(32) + ';font-size:' + u(13) + '" data-go="paint">Repaint</button></div>'
    +     '<div style="height:1px;background:rgba(140,168,214,.18)"></div>'
    +     '<div><div style="display:flex;align-items:center;gap:' + u(8) + '"><span class="lbl">Weapon rack &middot; ' + s.picks.length + ' of ' + m.draft + ' drafted</span><span class="grow"></span>'
    +       '<button class="ghost" style="height:' + u(28) + ';font-size:' + u(12) + ';padding:0 ' + u(11) + '" data-go="armoury">Edit</button></div>'
    +       '<div class="slots" style="justify-content:flex-start;margin-top:' + u(9) + '">' + slots(s.picks, m.draft) + '</div></div>'
    +   '</div>'
    + '</div>'
    + '<div class="brief" style="flex:1"><div class="bi"><img src="' + art(m.card) + '" alt=""><span class="g"></span><span>' + esc(m.name) + '</span></div>'
    +   '<div class="bb">' + esc(m.blurb) + '</div>'
    +   '<div class="brow"><span class="lbl">Players</span><b>' + esc(m.players) + '</b></div>'
    +   '<div class="brow"><span class="lbl">Weapons to draft</span><b class="cy">' + m.draft + '</b></div>'
    +   '<div class="brow"><span class="lbl">Opponent</span><b>' + oppText + '</b></div></div>'
    + '</div>';
  const foot = '<button class="ghost" data-go="modes">Change mode</button>'
    + '<span class="hint">The bay doors stay shut until your loadout is drafted</span><span class="grow"></span>'
    + '<button class="go" data-go="armoury">To the armoury' + IC.play + '</button>';
  return chrome(esc(m.name), 'Match setup', 'Step 2 of 3', body, foot);
};

SCREENS.home = function () {
  const s = state(), m = s.mode;
  // The one-tap Launch must never be a surprise: with Computer picked, the
  // Players readout says so. In the default state (both opponents 'friend',
  // neither persisted) this markup is byte-identical to before.
  const vsCpu = (m.id === 'duel' && s.opp === 'cpu') || (m.id === 'ffa' && s.ffaOpp === 'cpu');
  const players = vsCpu ? (m.id === 'ffa' ? 'You + ' + (s.count - 1) + ' CPU' : 'You vs CPU') : m.players;
  const arc = [[-6, 14], [-3, 5], [0, 0], [3, 5], [6, 14]];
  const boards = MODES.map((x, i) =>
    '<button class="board' + (x.id === m.id ? ' on' : '') + '" style="transform:rotate(' + arc[i][0] + 'deg) translateY(' + u(arc[i][1]) + ')" '
    + 'data-set="mode=' + x.id + '" title="' + esc(x.name) + '">'
    + '<span class="bcard"><img src="' + art(x.card) + '" alt=""><span class="bsc"></span><span class="barm"></span>'
    + '<span class="bic">' + MODE_IC[x.id] + '</span><span class="bpl">' + esc(x.players) + '</span>'
    + '<span class="blab"><span class="bnm">' + esc(x.name) + '</span><span class="btg">' + esc(x.tag) + '</span></span></span></button>').join('');


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
    + sortiesPanel()
    + '<div class="pnl" style="right:' + u(18) + ';top:' + u(162) + ';width:' + u(196) + ';height:' + u(192) + '"><div class="ph">Bay stations<s></s></div>' + stations + '</div>'
    + '<div class="lbar">'
    +   '<span class="lic">' + MODE_IC[m.id] + '</span>'
    +   '<span style="display:block"><span class="lnm">' + esc(m.name) + '</span><span class="ltg">' + esc(m.tag) + '</span></span>'
    +   '<span class="lsep"></span>'
    // One-tap LAUNCH removed the concept's only route into Setup, so the
    // readouts are that route: tap what you want to change.
    +   '<button class="ros" data-go="setup" title="Match setup">'
    +   '<span class="ro"><span class="rk">Players</span><span class="rv">' + esc(players) + '</span></span>'
    +   '<span class="ro"><span class="rk">Weapon draft</span><span class="rv"><em>' + m.draft + '</em> picks</span></span>'
    +   '<span class="ro"><span class="rk">Paint</span><span class="rv">' + esc(s.skin.name) + '</span></span>'
    +   '</button>'
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
/* ---- patch in place ----------------------------------------------------------
   Rebuilding a screen on every tap replaced the whole DOM: the tank and the
   bay-door image re-decoded and the entrance animation replayed -- a flicker
   on every mode, paint and weapon choice. So a same-screen change walks the
   fresh markup against the live tree and changes only what differs: a class
   here (the CSS transition carries the board lift), a text node there. The
   entrance animation plays only when a screen is actually entered. The two
   images that legitimately change -- the door and the tank -- crossfade. */
const XHTML = 'http://www.w3.org/1999/xhtml';
const XF_SCOPE = '.ap,.tankw,.refl';
function crossfade(oldImg, tplImg) {
  const next = tplImg.cloneNode(true);
  next.classList.add('xf-in');
  oldImg.after(next);
  const go = () => {
    requestAnimationFrame(() => { next.classList.remove('xf-in'); oldImg.classList.add('xf-out'); });
    setTimeout(() => { if (oldImg.parentNode) oldImg.remove(); }, 500);
  };
  (typeof next.decode === 'function' ? next.decode().catch(() => {}) : Promise.resolve()).then(go);
}
function morphNode(live, tpl) {
  if (live.nodeType === 3 && tpl.nodeType === 3) { if (live.data !== tpl.data) live.data = tpl.data; return; }
  if (live.nodeType !== 1 || tpl.nodeType !== 1 || live.tagName !== tpl.tagName) { live.replaceWith(tpl.cloneNode(true)); return; }
  if (live.tagName === 'IMG' && live.getAttribute('src') !== tpl.getAttribute('src') && live.closest(XF_SCOPE)) { crossfade(live, tpl); return; }
  for (const a of tpl.attributes) if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
  for (const a of [...live.attributes]) if (!tpl.hasAttribute(a.name)) live.removeAttribute(a.name);
  if (live.tagName === 'INPUT' || live.tagName === 'TEXTAREA') return;       // the value is the player's
  if (live.namespaceURI !== XHTML) { if (live.innerHTML !== tpl.innerHTML) live.replaceWith(tpl.cloneNode(true)); return; }
  morphChildren(live, tpl);
}
function morphChildren(live, tpl) {
  const L = [...live.childNodes].filter((n) => !(n.nodeType === 1 && n.classList && n.classList.contains('xf-out')));
  const T = [...tpl.childNodes];
  const n = Math.min(L.length, T.length);
  for (let i = 0; i < n; i++) morphNode(L[i], T[i]);
  for (let i = L.length - 1; i >= n; i--) L[i].remove();
  for (let i = n; i < T.length; i++) live.appendChild(T[i].cloneNode(true));
}

let current = 'home';
const stack = [];
const base = (n) => (n === 'join' ? 'home' : n);     // the join panel is an overlay on home
function render(name) {
  const host = $('bay'); if (!host) return;
  const next = name in SCREENS ? name : 'home';
  const entering = !host.firstChild || base(next) !== base(current);
  const html = SCREENS[next]();
  current = next;
  if (entering) {
    host.innerHTML = html;
    host.classList.add('enter');
    clearTimeout(render.t); render.t = setTimeout(() => host.classList.remove('enter'), 900);
  } else {
    const tpl = document.createElement('div'); tpl.innerHTML = html;
    morphChildren(host, tpl);
  }
  if (current === 'join') { const i = $('bayCode'); if (i) setTimeout(() => i.focus(), 50); }
  if (current === 'home') loadSorties();
}

function go(name) {
  // Screens not yet built in the bay fall back to the existing surface for now,
  // so nothing is a dead end while the rest of the concept lands.
  if (name !== current) stack.push(current);
  render(name);
}
function back() { render(stack.pop() || 'home'); }
// Each setter mirrors what the old home's control did, INCLUDING keeping the
// hidden native <select>s in step, so every existing `.value` read stays true.
function setField(k, v) {
  if (k === 'mode' && has('ccMode')) { ccMode = v; }
  else if (k === 'opp' && has('ccOpp')) { ccOpp = v; }
  else if (k === 'ffaOpp' && has('ccFfaOpp')) { ccFfaOpp = v; }
  else if (k === 'diff' && has('cpuDifficulty')) { cpuDifficulty = v; try { localStorage.setItem('pt_diff', v); } catch {} if ($('diffSel')) $('diffSel').value = v; }
  else if (k === 'count' && has('ccMax')) { ccMax = +v; if ($('countSel')) $('countSel').value = String(v); }
  else if (k === 'tees' && has('ccTees')) { ccTees = v; try { localStorage.setItem('cc_tees', v); } catch {} if ($('teeSel')) $('teeSel').value = v; }
  if (fn('syncCreateRow')) syncCreateRow();
}

document.addEventListener('click', (e) => {
  const host = $('bay'); if (!host || !host.classList.contains('active')) return;
  const t = e.target.closest('[data-go],[data-back],[data-set],[data-roll],[data-toggle],[data-launch],[data-join],[data-pick],[data-old],[data-skin],[data-rematch],[data-solo]');
  if (!t || !host.contains(t)) return;
  if (has('Audio')) Audio.ensure();
  // The lobby's Back IS Cancel. Leaving any other way strands a queued create
  // (it would flush into a room nobody asked for, and the grace timer would
  // yank the bay back to the lobby) or, in a solo room, leaves the in-page
  // engine installed as the transport so every later tap goes into it.
  if ('back' in t.dataset) {
    if (current === 'lobby') { const b = $('cancelBtn'); if (b) b.onclick(); return; }
    back(); return;
  }
  if (t.dataset.pick) { togglePick(t.dataset.pick); render(current); return; }
  // Rematch cannot reach a named player (there is no way to invite one), so it
  // starts the same mode with a fresh code -- honest about what it can do.
  // The chip also restores WHO it was against ('Computer' is the literal the
  // server emits for a vs-bot row): a 'Computer' FFA row really restarts vs
  // CPUs, and a human FFA row can no longer start a surprise bot match because
  // ccFfaOpp happened to be 'cpu'.
  if (t.dataset.rematch) {
    const md = t.dataset.rematch, vs = t.dataset.vs === 'cpu' ? 'cpu' : 'friend';
    setField('mode', md);
    if (md === 'duel') setField('opp', vs); else if (md === 'ffa') setField('ffaOpp', vs);
    const b = $('createBtn'); if (b) b.onclick(); return;
  }
  if ('solo' in t.dataset) { if (fn('playSolo')) playSolo(); return; }
  if (t.dataset.old) { const b = $(t.dataset.old); if (!b) return; if (typeof b.onclick === 'function') b.onclick(); else b.click(); return; }
  if (t.dataset.skin) {
    const id = t.dataset.skin, ok = fn('skinUnlocked') ? skinUnlocked(id) : false;
    if (!ok) { const sk = G.SKINS && SKINS[id]; if (fn('showToast')) showToast('LOCKED — ' + ((sk && sk.how) || 'earn it in the field') + ' to unlock this paint.'); return; }
    try { localStorage.setItem('cc_skin', id); } catch {}
    if (fn('buildSkinRow')) buildSkinRow();
    render(current); return;
  }
  if (t.dataset.set) {
    const [k, v] = t.dataset.set.split('=');
    // A second tap on the mode that is already armed opens its setup.
    if (k === 'mode' && current === 'home' && t.classList.contains('on')) { go('setup'); return; }
    setField(k, v);
    if (t.dataset.go) go(t.dataset.go); else render(current);
    return;
  }
  if ('roll' in t.dataset) {
    if (has('setCallsign') && has('rollCallsign')) setCallsign(rollCallsign(state().name));
    render(current); return;
  }
  if (t.dataset.toggle) {
    const k = t.dataset.toggle;
    if (k === 'sound') { const b = $('muteBtn'); if (b) b.click(); }
    else if (k === 'aimGuide') setPref('cc_aimguide', !pref('cc_aimguide', false));
    else if (k === 'motion') { setPref('cc_motion', !pref('cc_motion', false)); applyMotion(); }
    else if (k === 'haptics') { setPref('cc_haptics', !hapticsOn()); if (hapticsOn()) haptic(900); }
    else if (k === 'notify') { const b = $('notifyBtn'); if (b && !b.classList.contains('hidden')) b.onclick(); }
    render(current); return;
  }
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

window.Bay = { show: render, go, back, state, tankURL, MODES, haptic, rankFor, applyMotion };
applyMotion();

// LOBBY FEED. renderLobby/showLobby are the game's own; wrap them so the bay
// sees every message, then let them run unchanged (they also call showScreen,
// which routes 'lobby' to the bay under the flag).
if (fn('renderLobby')) { const orig = renderLobby; renderLobby = function (m) { lobby.m = m; lobby.mode = 'host'; return orig.apply(this, arguments); }; }
if (fn('showLobby'))   { const orig = showLobby;   showLobby   = function (mode) { lobby.mode = mode; if (mode !== 'host') lobby.m = null; return orig.apply(this, arguments); }; }

// BOOT. The bay is the menu: take the route in, once.
if (has('showScreen')) showScreen('home');
})();
