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
  get CC_SOCIAL()     { return typeof CC_SOCIAL     !== 'undefined' ? CC_SOCIAL     : undefined; },
  get CALLSIGN_MAX()  { return typeof CALLSIGN_MAX  !== 'undefined' ? CALLSIGN_MAX  : undefined; },
  get ccOpp()         { return typeof ccOpp         !== 'undefined' ? ccOpp         : undefined; },
  get ccFfaOpp()      { return typeof ccFfaOpp      !== 'undefined' ? ccFfaOpp      : undefined; },
  get pendingIntent() { return typeof pendingIntent !== 'undefined' ? pendingIntent : undefined; },
  get ccMax()         { return typeof ccMax         !== 'undefined' ? ccMax         : undefined; },
  get ccGolfMax()     { return typeof ccGolfMax     !== 'undefined' ? ccGolfMax     : undefined; },
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
  { id: 'golf',   name: 'Artillery Golf', players: '1-4',       tag: 'Nine holes, no damage',
    blurb: 'Driver, Iron, Putter. Real rolling physics and a scorecard.',
    art: 'ice-wide',      card: 'ice-mid',       draft: 5 },
];
const modeOf = (id) => MODES.find((m) => m.id === id) || MODES[0];

/* ---- Set callsign (design 5.6) ------------------------------------------- */
// CS_ERR is a CLOSED map from server error code to sentence: the server's own
// words are NEVER rendered, only looked up, so a malformed or hostile error code
// cannot put markup on the screen — and a code from a newer server still gets a
// sentence rather than "undefined". &ndash; and &mdash; keep this file free of
// the glyph ranges test/house-rules.mjs section 1 audits.
//
// KEYED BY CODE ALONE, AND CALLSIGN-ONLY. That is safe here because nothing but
// a callsign reply is ever looked up in it. Task 8 must NOT reuse this shape for
// a shared map: `already`, `no_such_user` and `self` all mean different things on
// a friend frame and on a report frame — Task 6's report, F6, has the example
// where a repeat report renders "You are already friends". Key by type AND code.
//
// Where the copy comes from:
//   design 5.6      — the rule, the hint, taken, not_allowed, too_soon
//   BINDING res. 16 — slow_down and sign_in, verbatim
//   the owner       — unavailable, replacing resolution 16's wording on his
//                     decision: it must not blame the connection for a
//                     server-side fault (it is what EVERY player sees until the
//                     migration is applied, and it was sending them to check
//                     their wifi), it must not read like the genuinely-offline
//                     sentence, and it must say plainly that names are off right
//                     now and to come back later
//   this task       — offline, checking, the catch-all `_` and CS_WAIT
//
// THE FULL STOPS ARE SETTLED. Design 5.6's fragments carried none and resolution
// 16's sentences did, so the one error line changed style depending on which
// code came back. Every sentence in CS_ERR now ends in a full stop. The ROW
// descriptions still carry none, because no other settings row's does.
const CS_RULE = '3&ndash;16 letters, digits or spaces. Unique. Once a day.';
const CS_HINT = 'Friends find you by code until you choose a callsign';
// THE THIRD STATE. `CC_SOCIAL === null` means the snapshot has NOT ARRIVED, not
// that the account holds no name -- and rendering it as CS_HINT told every
// returning player who holds a callsign that they hold none, on first paint and,
// while the migration is unapplied and every social frame answers unavailable,
// for their whole visit. This sentence claims nothing about the name; it says
// what is actually true (nothing has loaded) and how to try again, which is to
// re-enter this screen, because that is what socialNeed() hangs off.
const CS_WAIT = 'Not loaded yet &mdash; reopen this screen to retry';
const CS_OUT  = 'Sign in to choose a callsign.';
const CS_ERR = {
  taken:       'Someone has that callsign.',
  not_allowed: 'That callsign is not allowed.',
  length:      CS_RULE,
  chars:       CS_RULE,
  too_soon:    'You can change it again tomorrow.',
  slow_down:   'Too many tries. Wait a moment.',
  unavailable: 'Callsigns are not available right now. Try again later.',
  sign_in:     CS_OUT,
  checking:    'Still checking your sign-in. Try again shortly.',
  offline:     'Not connected. Try again in a moment.',
  _:           'That callsign could not be set.',
};
const KBD_PAD = 6;                                  // px of air under the field when the frame is lifted
const callsign = { open: false, busy: false, err: '' };
let csSeq = 0;                                      // which try an answer belongs to
let kbdOn = null;                                   // the viewport listener, only while the editor is open
// WHICH BOX THE LIFT IS MEASURED AGAINST. The callsign editor is no longer the
// only field in the Bay: the Friends screen has two, and the lower one sits
// under a landscape keyboard. One selector, set by whoever opens the watch, so
// there is still exactly one measurement and one lift.
let kbdSel = '#bay .csx';
let csFocus = 0;                                    // the deferred focus/watch, cancelled if the editor closes first
// What the pending lobby says for an invite-room mode: why it needs a
// connection, and what one player can still do on this device.
const SOLO_COPY = {
  duel:   { need: 'Duel needs a connection to bring in your friend.', can: 'You can fight a CPU commander on this device.' },
  boss:   { need: 'Boss Fight needs a connection to bring in a second commander.', can: 'You can take on WARLORD-7 alone on this device.' },
  aliens: { need: 'Alien Invasion needs a connection to bring in a second commander.', can: 'You can hold the line alone on this device.' },
  ffa:    { need: 'Free-for-all needs a connection to invite commanders.', can: 'You can fight CPU commanders on this device.' },
  golf:   { need: 'Artillery Golf needs a connection to invite other players.', can: 'You can play a solo round on this device.' },
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
  // The sign-in provider marks, single colour like every other icon here. The
  // Apple shape is the one index.html's provider button carries.
  apple:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>',
  google:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
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
       '<rect x="8.2" y="3.4" width="12" height="12" rx="2"/><path d="M15.8 18.2v.4a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2V8.6a2 2 0 0 1 2-2h.4"/></svg>',
  // FRIENDS. Drawn, not typed. The obvious character for a presence lamp is a
  // filled circle and the obvious one for a menu handle is a horizontal
  // ellipsis; test/house-rules.mjs rejects the whole Geometric Shapes block
  // (25A0-25FF) and the arrows block with it, so both are built here instead.
  dot:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.4" stroke="currentColor" stroke-width="2.2" opacity=".42"/>' +
       '<circle cx="12" cy="12" r="4.4" fill="currentColor"/></svg>',
  more:'<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.2" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.8" cy="12" r="1.9"/></svg>',
  share:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
       '<path d="M12 3.6v11"/><path d="M8.3 7.3L12 3.6l3.7 3.7"/><path d="M5.8 12.6v6.1a1.9 1.9 0 0 0 1.9 1.9h8.6a1.9 1.9 0 0 0 1.9-1.9v-6.1"/></svg>'
};

// The offline badge on every mode board: what this mode does with no server,
// asked of app.js's own predicates so a board can never promise more than the
// launch path delivers. Green is the bay's OFFLINE colour.
const OFF_TXT = { cpu: 'Offline vs CPU', solo: 'Offline solo', online: 'Online only' };
const offKind = (id) => (fn('offlineKind') ? offlineKind(id) : 'online');
const offBadge = (id) => '<span class="bof">' + esc(OFF_TXT[offKind(id)] || OFF_TXT.online) + '</span>';

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
    gcount: has('ccGolfMax') ? ccGolfMax : 2,     // golf seats, 1..4
    tees: has('ccTees') ? ccTees : 'mens',
    name: has('myName') ? myName() : 'Commander',
    social: has('CC_SOCIAL') ? CC_SOCIAL : null,      // the last social snapshot, or null before the first
    linked: fn('socialSignedIn') ? socialSignedIn() : false,   // a LINKED account, not a guest
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
// The account chip: who this device is signed in as, at a glance. It reads the
// state the old #accountBtn carries (in / guest / out) plus CC_ACCOUNT from
// refreshAccountChip(), and taps straight into that button, so every account
// path (sign in, keep my progress, manage, sign out) stays the one that exists.
// Absent exactly when that button is hidden: no session and no way to start one.
function accountChip() {
  const btn = $('accountBtn');
  if (!btn || btn.classList.contains('hidden')) return '';
  const st = btn.dataset.state || 'out';
  if (st === 'in') {
    const marks = ((window.CC_ACCOUNT && window.CC_ACCOUNT.accounts) || []).map((a) => IC[a.provider] || '').join('');
    return '<button class="chip acc" data-old="accountBtn" title="Your account">' + marks + '<b>Signed in</b></button>';
  }
  return '<button class="chip acc dim" data-old="accountBtn" title="' + (st === 'guest' ? 'Keep my progress' : 'Sign in') + '">'
    + (st === 'guest' ? 'Guest' : 'Sign in') + '</button>';
}
const PROVIDER_NAME = { apple: 'Apple', google: 'Google' };

function sortiesPanel() {
  const rows = sorties.rows.map((r) =>
    '<button class="sor" data-rematch="' + esc(r.mode) + '" data-vs="' + (r.opponent === 'Computer' ? 'cpu' : 'friend') + '" title="Play ' + esc(modeOf(r.mode).name) + ' again">'
    + '<span class="stx"><span class="snm">' + esc(r.opponent || 'Commander') + '</span>'
    + '<span class="smt">' + esc(SHORT[r.mode] || r.mode) + ' &middot; ' + esc(ago(r.when)) + '</span></span>'
    + '<span class="res ' + (r.result === 'W' ? 'w' : r.result === 'L' ? 'l' : '') + '">' + esc(r.result || '&ndash;') + '</span>'
    + IC.again.replace('<svg', '<svg class="rag"') + '</button>').join('');
  return '<div class="pnl' + (rows ? '' : ' hidden') + '" style="left:' + u(18) + ';top:' + u(174) + ';width:' + u(196) + ';height:' + u(192) + '"><div class="ph">Recent sorties<s></s></div>' + rows + '</div>';
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
  // 340u, not 288: the stats column (five rows, five bars, the Paint shop
  // button) needs ~334u, and at 288u it overflowed its box from the day it was
  // written, the button hanging below the column into the page body. The body
  // runs to 416u here (no footer), so 340u from 68u ends at 408u with room.
  const body = '<div class="cols" style="height:' + u(340) + '">'
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
  // Two buttons in one row (design 5.6: Callsign carries Roll AND Set). Same
  // markup as row() to the character, with one more button — so the row keeps
  // its 52u height and every existing #bay .row rule still applies to it.
  const row2 = (n, d, b1, a1, b2, a2) => '<div class="row"><span class="rt"><span class="rn2">' + n + '</span><span class="rd">' + d + '</span></span>'
    + '<button class="sbtn" ' + a1 + '>' + b1 + '</button><button class="sbtn" ' + a2 + '>' + b2 + '</button></div>';
  // Signed in: one line per linked provider, mark + name + address, so Apple and
  // Google both show when both are linked. esc() on the address: provider input.
  const linked = (accState === 'in' && window.CC_ACCOUNT && window.CC_ACCOUNT.accounts) || [];
  const accDesc = accState === 'in'
    ? (linked.length
      ? linked.map((a) => '<span class="acl">' + (IC[a.provider] || '') + (PROVIDER_NAME[a.provider] || esc(a.provider)) + ' &middot; ' + esc(a.email || 'connected') + '</span>').join('')
      : 'Signed in &mdash; progress syncs across devices')
    : accState === 'guest' ? 'Guest &mdash; sign in to keep progress across devices' : 'Sign in to keep progress across devices';
  // CALLSIGN (design 5.6). Roll and Set in one row; Set opens the field beneath
  // it with the rules under that. The DESCRIPTION is the fact that matters: a
  // chosen name is the name, a rolled one is private, so the row says how
  // friends actually find you instead of repeating a name the home screen
  // already prints in 38u type. Putting the sentence in the existing .rd rather
  // than in a new paragraph is deliberate — the closed row keeps its 52u height,
  // so the settings screen is geometrically identical to the baseline
  // test/layout.mjs holds, which this task is not allowed to rewrite.
  //
  // A GUEST IS NOT OFFERED SET. BINDING resolution 2 reserves chosen names for a
  // linked account, so a Set button on a guest's row is a control that can only
  // ever fail — and a refusal a player cannot act on reads as a broken feature,
  // not as a rule. They are told the rule instead, and Roll still works, because
  // rolling is local and always has been.
  const csRow = (st) => {
    // THREE STATES FOR A LINKED ACCOUNT, not two: holds a name, holds none, and
    // NOT KNOWN YET. The third is not cosmetic -- Set is withheld while it lasts,
    // because a save made against a snapshot this client has never seen is a
    // guess, and the row must not say "you have no callsign" on the strength of
    // a frame that never came back.
    const known = !!st.social;
    const held = st.linked && known && typeof st.social.callsign === 'string' ? st.social.callsign : '';
    const max = has('CALLSIGN_MAX') ? CALLSIGN_MAX : 16;
    const desc = !st.linked ? CS_OUT : !known ? CS_WAIT : held ? esc(held) : CS_HINT;
    if (!st.linked) return '<div class="cs">' + row('Callsign', desc, 'Roll', 'data-roll') + '</div>';
    const body = callsign.open
      ? '<div class="csx"><input id="bayCall" class="cs-in" maxlength="' + max + '" placeholder="Your callsign"'
        +   ' autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done" aria-label="Choose a callsign">'
        + '<div class="csb"><button class="sbtn" data-cs="cancel">Cancel</button>'
        +   '<button class="sbtn on" data-cs="save"' + (callsign.busy ? ' disabled' : '') + '>' + (callsign.busy ? 'Saving' : 'Save') + '</button></div>'
        + '<p class="csr' + (callsign.err ? ' bad' : '') + '">' + (callsign.err || CS_RULE) + '</p></div>'
      : '';
    // ROLL IS WITHHELD WHILE A SET IS IN FLIGHT. A mis-tap there hands back the
    // very key being paid for with the day's one change, and the answer that
    // would have confirmed it arrives to a name the client has just rolled off.
    return '<div class="cs">' + row2('Callsign', desc,
      'Roll', 'data-roll' + (callsign.busy ? ' disabled' : ''),
      'Set', 'data-cs="open"' + (known ? '' : ' disabled')) + body + '</div>';
  };
  const right = row('Account', accDesc, accState === 'out' ? 'Sign in' : 'Manage', 'data-old="accountBtn"')
    + csRow(s)
    // Design 9: "the Friends screen is reachable from Bay controls until the
    // box exists" (project 3). It sits with Account and Callsign because that
    // is what it belongs with, and PRIVACY POLICY moved to the other column to
    // make room: this column's content already ends 350u down a 348u page body,
    // so a sixth row here would have pushed the Built by card off the screen.
    + row('Friends', friendsDesc(), 'Open', 'data-go="friends"')
    + row('Tank paint', esc(s.skin.name) + ' is fitted', 'Open', 'data-go="paint"')
    + row('How to play', 'The six-chapter field manual', 'Open', 'data-old="helpHomeBtn"')
    // The credit card stands down while the field is open: the editor is about
    // 70u tall and the right column already reaches the bottom of .pbody, so
    // something has to give and this is the part nobody is reading mid-edit.
    + (callsign.open ? '' : '<div class="card" style="margin-top:' + u(10) + ';padding:' + u(10) + ' ' + u(13) + '"><span class="lbl">Built by</span>'
    + '<div style="font-family:Rajdhani,system-ui,sans-serif;font-weight:700;font-size:' + u(19) + ';text-transform:uppercase;letter-spacing:.05em;margin-top:' + u(4) + ';color:#eef3ff">Abara Brothers</div>'
    + '<div style="font-size:' + u(10.5) + ';color:#7f8fb5;margin-top:' + u(4) + ';font-weight:500">Cannons &amp; Canyons &mdash; landscape only, best with a friend.</div></div>');
  const withWhom = linked.length ? ' with ' + linked.map((a) => PROVIDER_NAME[a.provider] || esc(a.provider)).join(' and ') : '';
  return chrome('Bay controls', accState === 'in' ? 'Signed in' + withWhom + ' &mdash; progress syncs across devices' : 'Guest &mdash; progress is stored on this device', 'Abara Brothers',
    // Privacy policy rides at the foot of the TOGGLES column: it is a link out,
    // it reads like a footer, and this column had 88u spare where the other had
    // none. See the Friends row above for why the room had to come from here.
    '<div class="set" style="height:' + u(300) + '"><div style="flex:1">' + T
    +   row('Privacy policy', 'Opens in your browser', '&rarr;', 'data-old="privacyLink"')
    + '</div><div style="flex:1">' + right + '</div></div>', '');
};

/* ---- Set callsign: opening, submitting, and the on-screen keyboard -------- */
// THE KEYBOARD. The game is landscape-only and an iPhone's landscape keyboard
// eats roughly two thirds of the viewport, so a field halfway down the design
// frame is typed into blind. There is nothing to scroll — .stage is a fixed
// 932x430 frame positioned absolutely — so the frame itself moves. visualViewport
// reports the band still visible; lift by exactly the overlap, and never so far
// that the field leaves the top of that band. The lift lives on #bay, the HOST
// element, as a custom property: morphChildren() never touches the host, whereas
// an inline style on .stage would be stripped on the next re-render (morphNode
// removes every attribute the template does not carry).
function kbdFit() {
  const host = $('bay'), box = document.querySelector(kbdSel);
  if (!host || !box) return;
  host.classList.remove('kbd');                       // measure where the frame really sits
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const bottom = top + (vv ? vv.height : window.innerHeight);
  const r = box.getBoundingClientRect();
  // Math.max(0, …) on the OUTER clamp: with no keyboard the overlap is a
  // negative number, and a negative --kbd would push the frame DOWN the screen
  // the moment anything set the class. Math.min against (r.top - top) is the
  // other end: lifting further than that carries the field off the top of the
  // band, which is the same blind typing by a different route.
  const lift = Math.max(0, Math.min(Math.round(r.bottom + KBD_PAD - bottom), Math.round(r.top - top)));
  host.style.setProperty('--kbd', lift + 'px');
  host.classList.toggle('kbd', lift > 0);
}
function kbdWatch(on, sel) {
  const vv = window.visualViewport;
  if (on) {
    kbdSel = sel || '#bay .csx';
    if (!kbdOn) {
      kbdOn = () => kbdFit();
      if (vv) { vv.addEventListener('resize', kbdOn); vv.addEventListener('scroll', kbdOn); }
      window.addEventListener('resize', kbdOn);
    }
    kbdFit();
    return;
  }
  if (kbdOn) {
    if (vv) { vv.removeEventListener('resize', kbdOn); vv.removeEventListener('scroll', kbdOn); }
    window.removeEventListener('resize', kbdOn);
    kbdOn = null;
  }
  // The 60 ms focus timer is part of the watch: left to run after the editor has
  // closed it re-subscribes the listener this call just removed and lifts a
  // frame with no field in it.
  clearTimeout(csFocus); csFocus = 0;
  const host = $('bay');
  if (host) { host.classList.remove('kbd'); host.style.removeProperty('--kbd'); }
}
// A RE-MEASURE after the markup has changed. An error sentence can wrap to two
// lines on a narrow phone, which pushes the bottom of the editor down past the
// lift computed for the one-line rule -- so the line telling the player what went
// wrong is the part that ends up under the keyboard. Only while the watch is
// running: with no keyboard there is nothing to fit.
const kbdRefit = () => { if (kbdOn) kbdFit(); };
function openCallsign() {
  const st = state();
  callsign.open = true; callsign.busy = false; callsign.err = ''; csSeq++;
  render(current);
  const i = $('bayCall');
  if (!i) return;
  // PRE-FILLED WITH THE NAME THEY HOLD, and selected. Changing a callsign is the
  // common second visit, and retyping sixteen characters on a landscape phone
  // keyboard to alter one of them is worse than any accident a blank field
  // prevents: the selection means the first keystroke replaces the lot, so Save
  // is still a decision, and an empty field is still refused before it is sent.
  // Only a CHOSEN name is offered -- pre-filling the rolled pair would invite
  // spending the day's one change to freeze a name nobody picked.
  const pre = st.social && typeof st.social.callsign === 'string' ? st.social.callsign : '';
  i.value = pre;
  // The focus is deferred one tick so the field exists and the entrance is over;
  // the viewport watch starts with it, because the keyboard follows the focus.
  csFocus = setTimeout(() => { try { i.focus(); if (pre) i.select(); } catch {} kbdWatch(true); }, 60);
}
function closeCallsign() {
  callsign.open = false; callsign.busy = false; callsign.err = ''; csSeq++;
  kbdWatch(false);
  render(current);
}
function submitCallsign() {
  const i = $('bayCall');
  if (!i || callsign.busy) return;
  callsign.err = '';
  const wire = fn('sendCallsign');
  if (!wire) { callsign.err = CS_ERR.offline; render(current); return; }
  // An EMPTY field is the one thing this side decides, and it cannot drift: no
  // minimum length is ever below one character, so a blank Save is refused by
  // every rule the server could ever hold. It is refused here because the set
  // allowance is three a minute and a blank tap is not worth one of them.
  const typed = (i.value || '').trim();
  if (!typed) { callsign.err = CS_RULE; render(current); kbdRefit(); const f = $('bayCall'); if (f) f.focus(); return; }
  const seq = ++csSeq;
  callsign.busy = true; render(current);
  wire(typed, (res) => {
    // A DIFFERENT TRY, OR NONE. The player may have cancelled, reopened or saved
    // again while this was in flight; its answer belongs to a field that is gone
    // and must not mark the one on screen. The name itself still landed —
    // sendCallsign() writes it before this runs.
    if (seq !== csSeq) return;
    callsign.busy = false;
    if (res && res.ok) {
      callsign.open = false; callsign.err = ''; csSeq++;
      kbdWatch(false); render(current);
      if (fn('showToast')) showToast('Callsign set');
      return;
    }
    // A LOOKUP, never an echo: an error code this build has never heard of still
    // gets a sentence, and nothing the server sent reaches innerHTML.
    callsign.err = CS_ERR[res && res.error] || CS_ERR._;
    render(current);
    kbdRefit();
    const f = $('bayCall'); if (f) f.focus();
  });
}
// Enter commits and Escape closes. On a phone the keyboard's Done key is the
// only comfortable way to finish, and it arrives as Enter.
document.addEventListener('keydown', (e) => {
  if (!callsign.open || !e.target || e.target.id !== 'bayCall') return;
  if (e.key === 'Enter') { e.preventDefault(); submitCallsign(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeCallsign(); }
});

/* ---- FRIENDS, BLOCKS AND REPORTS (design 5.5 and 4.2) ---------------------
   THE READ MODEL IS window.CC_SOCIAL and app.js is the only writer (Task 7's
   contract: bay.js reads, never writes). `null` MEANS NOT KNOWN YET, never
   "empty" — Task 7 shipped that bug once on the Callsign row, where an
   unarrived snapshot rendered as "you have no callsign", and the same mistake
   here would tell a player with fifty friends that they have none. Every list
   below therefore has THREE states, and the unknown one says so.

   EVERY FRAME GOES OUT THROUGH app.js's socialSend(frame, cb). It mints the
   correlation id, keys its waiter on a number nobody else can choose (Task 7's
   F5 — a target uuid is not unique per request), and answers the callback
   exactly once, including when the socket is down. The callbacks here still
   check the reply's `type` and `op` before they act, because BINDING
   resolution 3 puts a TARGET uuid in `id` on block, report and friend remove,
   so an echo is not proof of which request it answers.

   WHO MAY DO WHAT (BINDING resolution 18, and the server's two gates):
     friends, friend  -> a LINKED account
     callsign         -> a LINKED account
     report, block    -> ANY account, including an anonymous guest
   So a guest gets Report and Block everywhere a name is shown, and their own
   blocked list through `block op:'list'` — an action nobody can undo is worse
   than one they were never offered. */
const FR_MAX = 16;
let fr = { q: '', code: '', res: null, ferr: '', cerr: '' };
// A GUEST'S OWN BLOCKED LIST. They are refused the friends frame, so this is
// the one read they get. null = not known yet, exactly like CC_SOCIAL.
let gb = { list: null, err: '', asking: false };
let pm = null;      // the open player menu:  { key, kind:'id'|'handle', name, err, busy }
let pa = null;      // the confirm sheet:     { act:'report'|'block', key, kind, name, err, busy }
let pmEl = null;    // the overlay node

const snap = () => (has('CC_SOCIAL') ? G.CC_SOCIAL : null) || null;
const acctState = () => (($('accountBtn') && $('accountBtn').dataset.state) || 'out');
// Nothing is sent while the socket is the in-page offline stand-in: room-engine
// carries no social code (it is the module the offline page imports), so the
// frame would vanish and the screen would wait for an answer that cannot come.
const wsReady = () => !!(G.S && S.connected && !S.local && S.ws && S.ws.readyState === 1);

// THE ERROR MAP IS KEYED BY TYPE AND OP AS WELL AS CODE, and it is closed.
// Task 7's CS_ERR gets away with a code-only map because only a callsign reply
// is ever looked up in it; here `already` means "you are already friends" on a
// friend add and "you have already reported this player" on a report, and
// `no_such_user` on a LOBBY card means "that player is no longer here" — the
// honest reading of an expired seat handle (task 6b, section 10.3). Closed,
// because the server's own words are never rendered: a malformed or hostile
// code cannot put markup on screen, and a code from a newer server still gets
// a sentence.
const SOC_ERR = {
  'friend.search.slow_down':     'Too many tries. Wait a moment.',
  'friend.search.sign_in':       'Sign in to add friends.',
  'friend.search.offline':       'Not connected. Try again in a moment.',
  'friend.search._':             'Friends are not available right now. Try again later.',
  'friend.add.no_such_code':     'No player has that friend code.',
  'friend.add.self':             'That is your own friend code.',
  'friend.add.blocked':          'That player cannot be added.',
  'friend.add.already':          'You are already friends.',
  'friend.add.slow_down':        'Too many tries. Wait a moment.',
  'friend.add.sign_in':          'Sign in to add friends.',
  'friend.add.offline':          'Not connected. Try again in a moment.',
  'friend.add._':                'Friends are not available right now. Try again later.',
  'friend.request.self':         'That is you.',
  'friend.request.blocked':      'That player cannot be added.',
  'friend.request.already':      'You have already asked, or you are already friends.',
  'friend.request.no_such_user': 'That player is no longer here.',
  'friend.request.slow_down':    'Too many tries. Wait a moment.',
  'friend.request.sign_in':      'Sign in to add friends.',
  'friend.request.offline':      'Not connected. Try again in a moment.',
  'friend.request._':            'Friends are not available right now. Try again later.',
  'friend.accept.no_such_request': 'That request is already gone.',
  'friend.accept.blocked':       'That player cannot be added.',
  'friend.accept.offline':       'Not connected. Try again in a moment.',
  'friend.accept._':             'Friends are not available right now. Try again later.',
  'friend.decline.no_such_request': 'That request is already gone.',
  'friend.decline.offline':      'Not connected. Try again in a moment.',
  'friend.decline._':            'Friends are not available right now. Try again later.',
  'friend.remove.no_such_user':  'They are not on your friends list.',
  'friend.remove.offline':       'Not connected. Try again in a moment.',
  'friend.remove._':             'Friends are not available right now. Try again later.',
  'block.self':                  'You cannot block yourself.',
  'block.no_such_user':          'That player is no longer here.',
  'block.sign_in':               'Sign in to report or block a player.',
  'block.offline':               'Not connected. Try again in a moment.',
  'block._':                     'Blocking is not available right now. Try again later.',
  'block.list.slow_down':        'Too many tries. Wait a moment.',
  'block.list.sign_in':          'Sign in to see who you have blocked.',
  'block.list.offline':          'Not connected. Try again in a moment.',
  'block.list._':                'Your blocked list is not available right now. Try again later.',
  'report.self':                 'You cannot report yourself.',
  'report.no_such_user':         'That player is no longer here.',
  'report.already':              'You have already reported this player in the past day.',
  'report.slow_down':            'Too many reports. Wait a moment.',
  'report.sign_in':              'Sign in to report or block a player.',
  'report.offline':              'Not connected. Try again in a moment.',
  'report._':                    'Reporting is not available right now. Try again later.',
  _:                             'That did not work. Try again.',
};
function socErr(kind, code) {
  const c = typeof code === 'string' && code ? code : 'unavailable';
  return SOC_ERR[kind + '.' + c] || SOC_ERR[kind + '._'] || SOC_ERR._;
}
// THE REPLY THIS FRAME WAS WAITING FOR, and nothing else. A target uuid is not
// unique per request, so the echo alone is not proof — check the shape too, and
// treat anything that does not fit as a failure rather than acting on it.
function fits(m, type, op) {
  if (!m || typeof m !== 'object') return { error: 'offline' };
  if (m.error) return m;
  if (m.type !== type || (op && m.op !== op)) return { error: 'unavailable' };
  return m;
}
// One way out. A dead socket answers here rather than leaving a dead button.
function socialTx(frame, type, op, kind, cb) {
  if (!wsReady() || !fn('socialSend')) { cb({ error: 'offline' }, socErr(kind, 'offline')); return false; }
  socialSend(frame, (m) => { const r = fits(m, type, op); cb(r, r.error ? socErr(kind, r.error) : ''); });
  return true;
}
// Repaint whatever is showing this state. render() is a no-op during a match,
// so the body-level menu repaints itself separately — it is the one part of
// this feature that has to work over the battlefield.
function frPaint() {
  const host = $('bay');
  if (host && host.classList.contains('active') && (current === 'friends' || current === 'lobby' || current === 'settings')) render(current);
  pmPaint();
}

/* ---- one player, wherever a player is shown ------------------------------ */
// Task 5's D3: `callsign` is null when the server cannot vouch for the name, so
// every list renders a fallback rather than an empty card.
const nameOf = (p) => (p && typeof p.callsign === 'string' && p.callsign ? p.callsign : 'No callsign');
// THE MENU BUTTON. `key` is either an account uuid the SERVER handed this
// client (a friends list, a search result, a blocked list) or a per-room seat
// HANDLE (a lobby payload, an in-match snapshot). They are different fields on
// the wire and are never interchangeable — BINDING resolution 24, and
// task 6b section 2. Nothing here logs or stores either one.
const menuBtn = (key, kind, name, dis) =>
  '<button class="pmb" data-pmenu="' + esc(key) + '" data-pmkind="' + kind + '" data-pmname="' + esc(name)
  + '" aria-label="More for ' + esc(name) + '"' + (dis ? ' disabled' : '') + '>' + IC.more + '</button>';
// BINDING resolution 23: a search result carries NO tank, because the paint is
// not stored on the profile — the card shows the callsign alone. No card here
// draws one, so there is no half-built path for a later project to trip over.
function pcard(p, o) {
  const opt = o || {}, name = nameOf(p);
  return '<div class="pcd">'
    + (opt.dot === false ? '' : '<span class="pdot' + (p.online ? ' on' : '') + '" title="' + (p.online ? 'Online' : 'Offline') + '">' + IC.dot + '</span>')
    + '<span class="sn">' + esc(name) + '</span><span class="grow"></span>'
    + (opt.act || '')
    // THE MENU IS NEVER DISABLED, only the actions are. A greyed handle offline
    // teaches nothing; the menu itself says reporting and blocking go through
    // the server, which is the sentence the player actually needs.
    + (opt.menu === false ? '' : menuBtn(p.id, 'id', name, false))
    + '</div>';
}

/* ---- the player menu and the two confirm sheets -------------------------- */
// A BODY-LEVEL LAYER, not part of any screen's markup. The menu has to open in
// four places and only two of them are Bay screens: the friends list and a
// search result are, a LOBBY SEAT is, and an IN-MATCH CARD is not — #bay is not
// even on stage during a battle. One layer serves all four, so there is one
// implementation of Report, Block and their confirmations.
function pmHost() {
  if (!pmEl) {
    pmEl = document.createElement('div');
    pmEl.id = 'pmenu';
    pmEl.hidden = true;
    document.body.appendChild(pmEl);
    pmEl.addEventListener('click', pmClick);
  }
  return pmEl;
}
function pmOpen(key, kind, name) {
  if (has('Audio')) Audio.ensure();
  pm = { key, kind: kind === 'handle' ? 'handle' : 'id', name: name || '', err: '', busy: '' };
  pa = null;
  pmPaint();
}
function pmClose() { if (!pm && !pa) return; pm = null; pa = null; pmPaint(); }
function pmItems() {
  const who = acctState();
  // A player with no account at all is refused every social frame, so a Report
  // button here could only ever fail. Say the rule instead of failing it.
  if (who === 'out') return '<p class="pmn">Sign in to report or block a player.</p>'
    + '<button class="pmg" data-pm="signin">Sign in</button>';
  if (!wsReady()) return '<p class="pmn">Reporting and blocking go through the server. Reconnect and try again.</p>';
  // Remove friend needs the account uuid AND the friends list to know they are
  // one, so it belongs to the friends-panel route only. A seat handle is
  // meaningless outside its room and says nothing about a friendship.
  const sn = who === 'in' ? snap() : null;
  const isFriend = pm.kind === 'id' && !!(sn && (sn.friends || []).some((x) => x && x.id === pm.key));
  return '<button class="pmi" data-pm="report">Report name</button>'
    + '<button class="pmi" data-pm="block">Block</button>'
    + (isFriend ? '<button class="pmi" data-pm="unfriend"' + (pm.busy ? ' disabled' : '') + '>Remove friend</button>' : '');
}
// Design 5.5: "Report confirms… Block confirms." Remove friend does not — the
// design names only those two, and an accidental unfriend is undone by asking
// again. BINDING resolution 25 fixes what the block sentence may claim: a block
// stops them finding or contacting you and clears what is between you. It does
// NOT promise the two are never matched together again, and this copy says so
// rather than leaving a player to find out.
function pmAsk() {
  const rep = pa.act === 'report';
  return '<div class="pmw" data-pmstop><div class="pmh">' + (rep ? 'Report this name' : 'Block this player') + '</div>'
    + '<p class="pmn">' + (rep
      ? 'Report the callsign ' + esc(pa.name) + ' to Abara Brothers. Every report is read.'
      : 'Block ' + esc(pa.name) + '. They will not be able to find you or contact you, and any friendship or request between you is removed. You may still be matched into a battle together. You can undo this in Friends.')
    + '</p>'
    + (pa.err ? '<p class="pme">' + esc(pa.err) + '</p>' : '')
    + '<div class="pmr"><button class="pmg" data-pm="cancel">Cancel</button><span class="grow"></span>'
    + '<button class="pmg on" data-pm="ok"' + (pa.busy ? ' disabled' : '') + '>'
    + (pa.busy ? (rep ? 'Reporting' : 'Blocking') : (rep ? 'Report' : 'Block')) + '</button></div></div>';
}
function pmPaint() {
  const el = pmHost();
  const html = pa ? pmAsk()
    : pm ? '<div class="pmw" data-pmstop><div class="pmh">' + esc(pm.name || 'This player') + '</div>'
        + pmItems()
        + (pm.err ? '<p class="pme">' + esc(pm.err) + '</p>' : '')
        + '<div class="pmr"><span class="grow"></span><button class="pmg" data-pm="close">Close</button></div></div>'
    : '';
  if (!html) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = html;
  el.hidden = false;
}
// The target, in the field the server reads it from. ONE FORM, NEVER EITHER:
// a handle goes in `handle` and a uuid in `id`, and a uuid is refused in
// `handle` by design — that refusal is what stops a modified client addressing
// a player it was never given (task 6b, section 2).
const pmAim = (t) => (t.kind === 'handle' ? { handle: t.key } : { id: t.key });
function pmClick(e) {
  const t = e.target.closest ? e.target.closest('[data-pm]') : null;
  if (!t) { if (!(e.target.closest && e.target.closest('[data-pmstop]'))) pmClose(); return; }
  const a = t.dataset.pm;
  if (a === 'close') return pmClose();
  if (a === 'signin') { pmClose(); const b = $('accountBtn'); if (b && b.onclick) b.onclick(); return; }
  if (a === 'cancel') { pa = null; pmPaint(); return; }
  if (a === 'report' || a === 'block') {
    if (!pm) return;
    pa = { act: a, key: pm.key, kind: pm.kind, name: pm.name, err: '', busy: '' };
    pmPaint(); return;
  }
  if (a === 'ok') {
    if (!pa || pa.busy) return;
    const rep = pa.act === 'report', kind = rep ? 'report' : 'block';
    const frame = rep ? { type: 'report', ...pmAim(pa) } : { type: 'block', op: 'add', ...pmAim(pa) };
    pa.busy = kind;
    socialTx(frame, rep ? 'report' : 'block', rep ? '' : 'add', kind, (m, err) => {
      if (!pa) return;
      pa.busy = '';
      if (err) { pa.err = err; pmPaint(); return; }
      pm = null; pa = null; pmPaint();
      if (fn('showToast')) showToast(rep ? 'Reported. Thank you.' : 'Blocked.');
      if (!rep) gbRefresh();
    });
    pmPaint(); return;
  }
  if (a === 'unfriend') {
    if (!pm || pm.kind !== 'id' || pm.busy) return;
    const who = pm.key;
    pm.busy = 'unfriend'; pm.err = '';
    socialTx({ type: 'friend', op: 'remove', id: who }, 'friend', 'remove', 'friend.remove', (m, err) => {
      if (!pm) return;
      pm.busy = '';
      if (err) { pm.err = err; pmPaint(); return; }
      pmClose();
      if (fn('showToast')) showToast('Friend removed.');
    });
    pmPaint();
  }
}

/* ---- the three columns --------------------------------------------------- */
function frFind(on) {
  const res = fr.res;
  const card = res === null
    ? '<p class="fnote">Exact callsign only. A rolled name cannot be searched.</p>'
    : res.length === 0
    ? '<p class="fnote">No player with that callsign.</p>'
    : pcard(res[0], { dot: false, dis: !on,
        act: '<button class="sbtn" data-fr="req:' + esc(res[0].id) + '"' + (on ? '' : ' disabled') + '>Add friend</button>' });
  return '<div id="frbQ"><span class="lbl">Find a friend</span>'
    + '<div class="frow"><input id="frQ" class="b-in" maxlength="' + FR_MAX + '" placeholder="Callsign" autocomplete="off" spellcheck="false" enterkeyhint="search" aria-label="Callsign to find" value="' + esc(fr.q) + '">'
    +   '<button class="sbtn" data-fr="search"' + (on ? '' : ' disabled') + '>Search</button></div>'
    + '<p class="ferr">' + esc(fr.ferr) + '</p></div>' + card
    + '<div class="fsec"></div>'
    + '<div id="frbCode"><span class="lbl">Add by friend code</span>'
    + '<div class="frow"><input id="frCode" class="b-in" maxlength="9" placeholder="FR-XXXXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" aria-label="Friend code to add" value="' + esc(fr.code) + '">'
    +   '<button class="sbtn" data-fr="add"' + (on ? '' : ' disabled') + '>Add</button></div>'
    + '<p class="ferr">' + esc(fr.cerr) + '</p></div>'
    + '<p class="fnote">A friend code adds you both straight away &mdash; there is no request to accept.</p>';
}
function frPeople(sn, on) {
  // THE THIRD STATE, spelled out. No count, no "no friends yet" — this client
  // has no evidence either way, and saying so is the only honest thing left.
  if (!sn) return '<span class="lbl">Your friends</span><p class="fnote">Not loaded yet.</p>'
    + '<div class="frow"><button class="sbtn" data-fr="retry"' + (on ? '' : ' disabled') + '>Retry</button></div>';
  const rin = (sn.requests && sn.requests.in) || [], rout = (sn.requests && sn.requests.out) || [];
  const friends = sn.friends || [];
  const reqRows = rin.map((p) => pcard(p, { dot: false, dis: !on,
    act: '<button class="sbtn" data-fr="acc:' + esc(p.id) + '"' + (on ? '' : ' disabled') + '>Accept</button>'
       + '<button class="sbtn" data-fr="dec:' + esc(p.id) + '"' + (on ? '' : ' disabled') + '>Ignore</button>' })).join('');
  const rows = friends.map((p) => pcard(p, { dis: !on })).join('');
  // The requests a player must ANSWER and the ones they are waiting on belong
  // together, above the list. Left at the foot of the column the outgoing line
  // floated two hundred units under the last friend card, orphaned from the
  // thing it is about, because the list below it takes the spare height.
  return (rin.length || rout.length
      ? '<span class="lbl">Requests' + (rin.length ? ' &middot; ' + rin.length : '') + '</span>'
        + (rin.length ? '<div class="frl">' + reqRows + '</div>' : '')
        + (rout.length ? '<p class="fnote">' + rout.length + ' request' + (rout.length === 1 ? '' : 's') + ' waiting for an answer.</p>' : '')
        + '<div class="fsec"></div>'
      : '')
    + '<span class="lbl">Your friends &middot; ' + friends.length + '</span>'
    + '<div class="frl frl2">' + (rows || '<p class="fnote">No friends yet. Share your friend code, or add a friend by theirs or by callsign.</p>') + '</div>';
}
// The blocked list, in the one shape both kinds of account render: a linked
// account reads it out of the friends snapshot, a guest out of block op:'list'.
function blockedSec(list, on, known) {
  if (!known) return '<span class="lbl">Blocked</span><p class="fnote">Not loaded yet.</p>'
    + '<div class="frow"><button class="sbtn" data-fr="retry"' + (on ? '' : ' disabled') + '>Retry</button></div>';
  const rows = (list || []).map((p) => pcard(p, { dot: false, menu: false, dis: !on,
    act: '<button class="sbtn" data-fr="unblock:' + esc(p.id) + '"' + (on ? '' : ' disabled') + '>Unblock</button>' })).join('');
  return '<span class="lbl">Blocked &middot; ' + (list || []).length + '</span>'
    + '<div class="frl frl2">' + (rows || '<p class="fnote">Nobody is blocked.</p>') + '</div>';
}
function frCode(sn, on) {
  const code = sn && sn.friendCode ? 'FR-' + sn.friendCode : '';
  const canShare = !!(typeof navigator !== 'undefined' && navigator.share);
  return '<span class="lbl">Your friend code</span>'
    + '<div class="frcode">' + esc(code || 'FR-------') + '</div>'
    + '<div class="frow"><button class="ghost" data-fr="copy"' + (code ? '' : ' disabled') + '>' + IC.copy + 'Copy</button>'
    +   (canShare ? '<button class="ghost" data-fr="share"' + (code ? '' : ' disabled') + '>' + IC.share + 'Share</button>' : '') + '</div>'
    + '<p class="fnote">Anyone who enters this code is added as a friend straight away.</p>'
    + '<div class="fsec"></div>' + blockedSec(sn ? sn.blocked : null, on, !!sn);
}
// What a player without a linked account is told, and it is honest about WHICH
// half is shut: friends need an account, reporting and blocking do not.
function frNoAccount(who) {
  return '<div class="card" style="padding:' + u(18) + ' ' + u(20) + ' ' + u(20) + '">'
    + '<span class="lbl">Friends</span>'
    + '<div class="b-pname" style="font-size:' + u(26) + ';margin-top:' + u(6) + '">Sign in to add friends</div>'
    + '<p class="fnote">' + (who === 'guest'
      ? 'Friends need an account that follows you between devices. Blocking and reporting work without one, and anyone you block is listed here.'
      : 'Friends, blocking and reporting need an account. Your progress on this device comes with you when you sign in.') + '</p>'
    + '<button class="go" style="margin-top:' + u(16) + '" data-old="accountBtn">Sign in</button></div>';
}

/* ---- Copy and Share (design 5.5) ----------------------------------------- */
function frShareCode(useShare) {
  const sn = snap(); if (!sn || !sn.friendCode) return;
  const code = 'FR-' + sn.friendCode;
  const text = 'Add me on Cannons and Canyons. My friend code is ' + code;
  if (useShare && typeof navigator !== 'undefined' && navigator.share) {
    try { const p = navigator.share({ text }); if (p && p.catch) p.catch(() => {}); } catch {}
    return;
  }
  try { navigator.clipboard.writeText(code).then(() => { if (fn('showToast')) showToast('Friend code copied.'); }, () => prompt('Your friend code:', code)); }
  catch { prompt('Your friend code:', code); }
}

/* ---- asking for what this screen shows ----------------------------------- */
// A LINKED account asks through Task 7's socialNeed(), which is guarded against
// duplicates and against guests and is the one place the read model is fetched.
// A GUEST asks for their blocked list, and for nothing else.
function gbNeed() {
  if (acctState() !== 'guest' || gb.list || gb.asking || !wsReady()) return;
  gb.asking = true; gb.err = '';
  socialTx({ type: 'block', op: 'list' }, 'block', 'list', 'block.list', (m, err) => {
    gb.asking = false;
    if (err) gb.err = err;
    else { gb.list = Array.isArray(m.blocked) ? m.blocked : []; gb.err = ''; }
    frPaint();
  });
}
// A guest's list has no server push behind it, so a block or an unblock it made
// has to re-read. A linked account is pushed a fresh snapshot by the server.
function gbRefresh() {
  if (acctState() !== 'guest') return;
  gb.list = null; gb.err = '';
  gbNeed();
}
function frNeed() {
  const who = acctState();
  if (who === 'in') { if (fn('socialNeed')) socialNeed(); return; }
  if (who === 'guest') gbNeed();
}
function frRetry() {
  const who = acctState();
  if (who === 'guest') { gb.list = null; gb.err = ''; gbNeed(); return; }
  if (fn('socialResync')) socialResync();
}

/* ---- the controls -------------------------------------------------------- */
function frSearch() {
  fr.q = (($('frQ') && $('frQ').value) || '').trim();
  fr.res = null; fr.ferr = '';
  if (!fr.q) { fr.ferr = 'Type a callsign first.'; return frPaint(); }
  socialTx({ type: 'friend', op: 'search', q: fr.q }, 'friend', 'search', 'friend.search', (m, err) => {
    if (err) { fr.ferr = err; fr.res = null; }
    else { fr.ferr = ''; fr.res = Array.isArray(m.results) ? m.results : []; }
    frPaint();
  });
  frPaint();
}
function frAddCode() {
  fr.code = (($('frCode') && $('frCode').value) || '').trim().toUpperCase();
  fr.cerr = '';
  if (!fr.code) { fr.cerr = 'Type a friend code first.'; return frPaint(); }
  socialTx({ type: 'friend', op: 'add', code: fr.code }, 'friend', 'add', 'friend.add', (m, err) => {
    if (err) { fr.cerr = err; return frPaint(); }
    fr.cerr = ''; fr.code = '';
    const f = $('frCode'); if (f) f.value = '';
    if (fn('showToast')) showToast('Added ' + nameOf(m.friend || {}) + ' as a friend.');
    frPaint();
  });
  frPaint();
}
function frOne(frame, type, op, kind, done) {
  socialTx(frame, type, op, kind, (m, err) => {
    if (err) { fr.ferr = err; return frPaint(); }
    fr.ferr = '';
    done(m);
    frPaint();
  });
}
// Every control on the screen, on ONE delegated attribute so the click
// handler's selector grows by one entry rather than by fifteen.
function frAct(v) {
  const i = v.indexOf(':');
  const op = i < 0 ? v : v.slice(0, i), arg = i < 0 ? '' : v.slice(i + 1);
  if (op === 'search') return frSearch();
  if (op === 'add') return frAddCode();
  if (op === 'copy') return frShareCode(false);
  if (op === 'share') return frShareCode(true);
  if (op === 'retry') return frRetry();
  if (op === 'req') return frOne({ type: 'friend', op: 'request', to: arg }, 'friend', 'request', 'friend.request', (m) => {
    fr.res = null;
    if (fn('showToast')) showToast(m.state === 'friends' ? 'You are now friends.' : 'Request sent.');
  });
  if (op === 'acc') return frOne({ type: 'friend', op: 'accept', from: arg }, 'friend', 'accept', 'friend.accept', () => {});
  if (op === 'dec') return frOne({ type: 'friend', op: 'decline', from: arg }, 'friend', 'decline', 'friend.decline', () => {});
  if (op === 'unblock') return frOne({ type: 'block', op: 'remove', id: arg }, 'block', 'remove', 'block', () => {
    if (fn('showToast')) showToast('Unblocked.');
    gbRefresh();
  });
}

// The Bay controls row that reaches this screen (design 9, until project 3
// builds the Squad box). It carries the same three states the screen does.
function friendsDesc() {
  const who = acctState();
  if (who === 'out') return 'Sign in to add friends';
  if (who === 'guest') return 'Blocking and reporting work &mdash; friends need an account';
  const sn = snap();
  if (!sn) return 'Not loaded yet';
  const n = (sn.friends || []).length, k = (sn.friends || []).filter((x) => x && x.online).length;
  return n ? n + (n === 1 ? ' friend' : ' friends') + ' &middot; ' + k + ' online' : 'No friends yet &mdash; share your friend code';
}

// 9 — FRIENDS. Find a player by exact callsign or by friend code, your own code
// with Copy and Share, your friends and the requests waiting on you, and the
// blocked list with Unblock. Design 5.5 is the copy authority.
SCREENS.friends = function () {
  const s = state(), who = acctState(), on = wsReady();
  const sn = who === 'in' ? snap() : null;
  const friends = sn ? (sn.friends || []) : [];
  const nOn = friends.filter((x) => x && x.online).length;
  const sub = who === 'out' ? 'Sign in to add friends'
    : who === 'guest' ? 'Blocking and reporting work without an account'
    : !sn ? 'Friends list not loaded'
    : !friends.length ? 'No friends yet'
    : friends.length + (friends.length === 1 ? ' friend' : ' friends') + ' &middot; ' + nOn + ' online';
  const body = who === 'in'
    ? '<div class="cols" style="height:' + u(336) + '">'
      + '<div class="fcol" style="width:' + u(292) + '">' + frFind(on) + '</div>'
      + '<div class="fcol" style="width:' + u(292) + '">' + frPeople(sn, on) + '</div>'
      + '<div class="fcol" style="flex:1;min-width:0">' + frCode(sn, on) + '</div></div>'
    : who === 'guest'
    ? '<div class="cols" style="height:' + u(336) + '">'
      + '<div class="fcol" style="width:' + u(430) + '">' + frNoAccount('guest') + '</div>'
      + '<div class="fcol" style="flex:1;min-width:0">' + (gb.err
        ? '<span class="lbl">Blocked</span><p class="ferr">' + esc(gb.err) + '</p>'
          + '<div class="frow"><button class="sbtn" data-fr="retry"' + (on ? '' : ' disabled') + '>Retry</button></div>'
        : blockedSec(gb.list, on, gb.list !== null)) + '</div></div>'
    : '<div class="cols" style="height:' + u(336) + '"><div class="fcol" style="width:' + u(430) + ';margin:0 auto">' + frNoAccount('out') + '</div></div>';
  return chrome('Friends', sub, on ? esc(s.name) : 'Needs a connection', body, '');
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
  // A one-seat online golf room is a round for one: the server starts it the
  // moment it is created, so the share-a-code lobby would be a lie even for
  // the single frame it is painted on.
  const oneSeat = !pending && !solo && !searching && mode.id === 'golf' && max === 1;
  const cp = SOLO_COPY[mode.id] || SOLO_COPY.boss;
  const roster = (() => {
    if (pending) return '';                       // nothing has been created yet
    if (searching) return '<div class="seat wait"><span class="b-dot" style="background:#6f7fa6;margin-left:' + u(16) + '"></span><span class="sn">Searching for an opponent</span><span class="spin"></span></div>';
    let out = '';
    for (let i = 0; i < max; i++) {
      const p = m && m.players[i], you = m && i === m.you, host = m && i === m.host;
      const col = fn('seatColor') ? seatColor(i) : '#54c8ff';
      if (p) out += '<div class="seat">' + (you ? tankImg(s.skinId, 44) : '') + '<span class="b-dot" style="background:' + col + (you ? '' : ';margin-left:' + u(16)) + '"></span>'
        + '<span class="sn">' + esc(p.name) + '</span><span class="lbl" style="margin-left:auto">' + (host ? 'Host' : '') + (you ? (host ? ' &middot; you' : 'You') : '') + '</span>'
        // REPORT AND BLOCK WHERE THE NAME IS ACTUALLY READ. The seat carries an
        // opaque per-room HANDLE and never an account id (BINDING resolution
        // 24), and the key is absent on a seat with no account — a bot, or a
        // player who has never saved anything, for whom there is no row to file.
        // So: a menu where there is a handle, and nowhere else.
        + (!you && p.handle ? menuBtn(p.handle, 'handle', p.name, false) : '')
        + '</div>';
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
    : oneSeat
    ? '<span class="lbl">Solo round</span>' + big('TEEING OFF', true)
      + note('A round for one. It starts in a moment.')
    : '<span class="lbl">Share this code</span><div class="b-code">' + esc(code) + '</div>'
      + '<div style="display:flex;gap:' + u(8) + ';margin-top:' + u(16) + '"><button class="go cy" style="height:' + u(36) + ';font-size:' + u(15) + ';padding:0 ' + u(16) + '" data-old="copyLinkBtn">' + IC.copy + 'Copy link</button>'
      + '<button class="ghost" style="height:' + u(36) + ';font-size:' + u(13) + '" data-old="copyCodeBtn">Copy code</button></div>'
      + '<div style="margin-top:' + u(14) + ';font-size:' + u(11.5) + ';color:#8798bd;line-height:1.45;max-width:' + u(270) + ';font-weight:500">'
      // Golf with 3 or 4 seats is host-started like a free-for-all: the room
      // auto-starts only when the LAST seat fills, so the old "starts the
      // moment they join" line was false for those counts.
      + (mode.id === 'ffa' && isHost ? 'Send the link. Start whenever you have enough players &mdash; you don&rsquo;t have to wait for a full lobby.'
        : mode.id === 'golf' && isHost && max > 2 ? 'Send the link. Tee off whenever you have enough players &mdash; the round also starts when the last seat fills.'
        : hostStarts && !isHost ? (mode.id === 'golf' ? 'Waiting for the host to tee off&hellip;' : 'Waiting for the host to start the battle&hellip;')
        : mode.id === 'golf' ? 'The round starts the moment they join &mdash; no lobby countdown.'
        : 'The battle starts the moment they join &mdash; no lobby countdown.') + '</div>';
  const summary = '<div style="display:flex;gap:' + u(26) + ';margin-top:' + u(16) + ';padding-top:' + u(13) + ';border-top:1px solid rgba(140,168,214,.2)">'
    + '<span class="ro"><span class="rk">Mode</span><span class="rv">' + esc(mode.name) + '</span></span>'
    + '<span class="ro"><span class="rk">Players</span><span class="rv">' + (solo ? filled : filled + ' / ' + max) + '</span></span>'
    + '<span class="ro"><span class="rk">Paint</span><span class="rv">' + esc(s.skin.name) + '</span></span></div>';
  const right = '<span class="lbl">' + (solo ? 'Deploying' : 'Roster') + '</span>' + roster
    + '<button class="ghost' + (nudgeHidden || solo || searching || pending || oneSeat ? ' hidden' : '') + '" style="width:100%;margin-top:' + u(10) + ';height:' + u(34) + ';font-size:' + u(13) + ';justify-content:center" data-old="notifyBtn">Nudge me when they join</button>'
    + '<div style="margin-top:' + u(12) + '">' + loadout(rackPicks().slice(0, mode.draft), mode.draft, 'Rack loaded', pending || solo ? '' : '<button class="ghost" style="height:' + u(28) + ';font-size:' + u(12) + ';padding:0 ' + u(11) + '" data-go="armoury">Change</button>') + '</div>';
  const title = pending ? (st === 'offline' ? 'No connection' : st === 'connecting' ? 'Reaching the server' : 'Cannot reach the server')
    : solo ? 'Solo run' : searching ? 'Searching' : oneSeat ? 'Teeing off' : filled >= max ? 'Bay doors opening' : 'Bay doors sealed';
  const count = solo ? '' : ' (' + filled + ')';
  const startLabel = filled < minSeats ? 'Start (need ' + minSeats + ')' : mode.id === 'boss' ? 'Engage the WARLORD' + count : mode.id === 'golf' ? 'Tee off' + count : 'Start battle' + count;
  // While the server is being reached there is nothing to offer yet; once it
  // is offline or has not answered, Play solo. Cancel is always there — and
  // the header's Back arrow is routed through it (see the click handler).
  const foot = '<button class="ghost" data-old="cancelBtn">Cancel</button><span class="grow"></span>'
    + (pending
      ? (st === 'connecting' ? '' : '<button class="go" data-solo>' + (mode.id === 'duel' || mode.id === 'ffa' ? 'Play vs Computer' : 'Play solo') + IC.play + '</button>')
      : '<button class="go' + (canStart && !oneSeat ? '' : ' hidden') + '" ' + (filled < minSeats ? 'disabled' : 'data-old="startMatchBtn"') + '>' + startLabel + IC.play + '</button>');
  return chrome(title, esc(mode.name) + ' &middot; ' + rackPicks().slice(0, mode.draft).length + ' weapons loaded', pending ? (st === 'offline' ? 'Offline' : st === 'connecting' ? 'Waiting room' : 'Retrying') : solo ? 'Solo drop' : searching ? 'Quick match' : oneSeat ? 'Solo round' : 'Waiting room',
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
      + '<span class="mbi"><img src="' + art(x.card) + '" alt=""><span class="g"></span><span class="lip"></span>' + offBadge(x.id)
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
  // What "a friend by code" means depends on how many seats the mode opens:
  // golf with one seat invites nobody at all, and golf for 3-4 invites several.
  const byCode = m.id === 'golf' ? (s.gcount === 1 ? 'Solo round' : s.gcount > 2 ? 'Friends by code' : 'Friend by code') : m.id === 'ffa' ? 'Friends by code' : 'Friend by code';
  const oppSeg = seg('Opponent', oppKey, [['friend', byCode], ['cpu', 'Computer']], oppVal, !cpuMode);
  const extra = seg(vsCpu ? 'CPU commanders' : 'Commanders on the ridge', 'count', vsCpu ? [[3, '2'], [4, '3']] : [[3, '3'], [4, '4']], s.count, m.id !== 'ffa')
    // Golf seats 1..4 (owner, 2026-09-18): the host opens that many; one is a
    // solo round, exactly the old Play solo path.
    + seg('Players', 'gcount', [[1, '1'], [2, '2'], [3, '3'], [4, '4']], s.gcount, m.id !== 'golf')
    + seg('Tee set', 'tees', [['champ', 'Champ'], ['mens', 'Men&rsquo;s'], ['womens', 'Women&rsquo;s'], ['junior', 'Junior']], s.tees, m.id !== 'golf')
    + seg('Difficulty', 'diff', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], s.diff, !vsCpu);
  const oppText = vsCpu ? 'Computer &middot; ' + esc(cap(s.diff)) : byCode;
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
  const players = vsCpu ? (m.id === 'ffa' ? 'You + ' + (s.count - 1) + ' CPU' : 'You vs CPU')
    : m.id === 'golf' ? String(s.gcount)             // the seats the host chose, 1..4
    : m.players;
  const arc = [[-6, 14], [-3, 5], [0, 0], [3, 5], [6, 14]];
  const boards = MODES.map((x, i) =>
    '<button class="board' + (x.id === m.id ? ' on' : '') + '" style="transform:rotate(' + arc[i][0] + 'deg) translateY(' + u(arc[i][1]) + ')" '
    + 'data-set="mode=' + x.id + '" title="' + esc(x.name) + '">'
    + '<span class="bcard"><img src="' + art(x.card) + '" alt=""><span class="bsc"></span><span class="barm"></span>'
    // No offline badge on the home boards (owner, 2026-09-18); the Mission
    // board keeps its badge, and offline play itself is unchanged.
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
    +   accountChip()
    +   '<button class="chip" data-roll title="Roll a new callsign">' + SWORD + '<b>' + esc(s.name) + '</b></button>'
    +   '<button class="chip" data-go="career">' + CROWN + '<b>' + s.wins + '</b> W</button>'
    +   '<button class="chip sq" data-toggle="sound" title="Sound">' + (has('UI_IC') ? (s.muted ? UI_IC.speakerOff : UI_IC.speakerOn) : '') + '</button>'
    +   '<button class="chip sq" data-go="settings" title="Settings">' + IC.gear + '</button>'
    + '</div>'
    + '<div class="boards">' + boards + '</div>'
    + sortiesPanel()
    + '<div class="pnl" style="right:' + u(18) + ';top:' + u(174) + ';width:' + u(196) + ';height:' + u(192) + '"><div class="ph">Bay stations<s></s></div>' + stations + '</div>'
    + '<div class="lbar">'
    +   '<span class="lic">' + MODE_IC[m.id] + '</span>'
    +   '<span style="display:block"><span class="lnm">' + esc(m.name) + '</span><span class="ltg">' + esc(m.tag) + '</span></span>'
    +   '<span class="lsep"></span>'
    // Launch AND the readouts open Match setup (owner, 2026-09-18): the one-tap
    // create is gone from home, and the bay doors open from the armoury, so
    // every launch passes the mode brief and the rack. data-launch stays the
    // armoury's word for the real create.
    +   '<button class="ros" data-go="setup" title="Match setup">'
    +   '<span class="ro"><span class="rk">Players</span><span class="rv">' + esc(players) + '</span></span>'
    +   '<span class="ro"><span class="rk">Weapon draft</span><span class="rv"><em>' + m.draft + '</em> picks</span></span>'
    +   '<span class="ro"><span class="rk">Paint</span><span class="rv">' + esc(s.skin.name) + '</span></span>'
    +   '</button>'
    +   '<span class="grow"></span>'
    +   '<button class="ghost" data-go="join">' + IC.keypad + 'Join code</button>'
    +   '<button class="launch" data-go="setup">' + IC.play + 'Launch</button>'
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
  // Leaving Bay controls closes the field: it belongs to that screen only, the
  // keyboard lift with it, and .stage is rebuilt outright on a screen change.
  // Leaving Bay controls closes the field -- and so does LOSING THE ACCOUNT while
  // it is open. csRow() returns the guest row early, before the editor markup is
  // ever built, so the field vanished while `callsign.open` stayed true and #bay
  // stayed in .kbd: the frame sat shoved up with no keyboard under it and no way
  // down but leaving the screen. Closing here, at the top of the render that is
  // about to drop the field, puts the class removal ahead of that early return.
  if (callsign.open && (next !== 'settings' || !state().linked)) { callsign.open = false; callsign.busy = false; callsign.err = ''; csSeq++; kbdWatch(false); }
  // The Friends screen has two fields of its own, so it owns the same duty: the
  // lift must not survive the screen it was measured on.
  if (kbdOn && current === 'friends' && next !== 'friends') kbdWatch(false);
  const entering = !host.firstChild || base(next) !== base(current);
  const html = SCREENS[next]();
  current = next;
  // Which screen is up, for CSS that must apply to one screen only (the home
  // geometry and type sizes, the service record sizes). Set before the markup
  // lands so the first paint is right. The BASE screen: the join panel renders
  // the whole home under its overlay, so it must not drop home's rules.
  host.dataset.scr = base(next);   // join is home under an overlay: it keeps home's geometry and sizes
  if (entering) {
    host.innerHTML = html;
    host.classList.add('enter');
    clearTimeout(render.t); render.t = setTimeout(() => host.classList.remove('enter'), 900);
  } else {
    const tpl = document.createElement('div'); tpl.innerHTML = html;
    morphChildren(host, tpl);
  }
  if (current === 'join') { const i = $('bayCode'); if (i) setTimeout(() => i.focus(), 50); }
  // The Callsign row can only be honest about a name chosen on ANOTHER device if
  // the server is asked (BINDING resolution 13 puts it on the friends frame).
  // Asked on ENTRY, not on every re-render: a tap on a toggle re-renders this
  // screen and the read model is eight round trips. socialNeed() is idempotent
  // and does nothing for a guest, so this costs a signed-out player nothing.
  if (entering && current === 'settings' && fn('socialNeed')) socialNeed();
  // The Friends screen shows the same read model, and a GUEST's blocked list
  // comes from its own frame. Asked on ENTRY, exactly like Bay controls, and
  // idempotent — a refusal leaves the snapshot null on purpose, so coming back
  // asks again, which is what Retry does by hand.
  if (entering && current === 'friends') { fr.res = null; fr.ferr = ''; fr.cerr = ''; frNeed(); }
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
  else if (k === 'gcount' && has('ccGolfMax')) { ccGolfMax = Math.max(1, Math.min(4, +v || 2)); }
  else if (k === 'tees' && has('ccTees')) { ccTees = v; try { localStorage.setItem('cc_tees', v); } catch {} if ($('teeSel')) $('teeSel').value = v; }
  if (fn('syncCreateRow')) syncCreateRow();
}

document.addEventListener('click', (e) => {
  const host = $('bay'); if (!host || !host.classList.contains('active')) return;
  const t = e.target.closest('[data-go],[data-back],[data-set],[data-roll],[data-toggle],[data-launch],[data-join],[data-pick],[data-old],[data-skin],[data-rematch],[data-solo],[data-cs],[data-fr]');
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
    // setCallsign() also gives the server's uniqueness key back when the name
    // being rolled over was a CHOSEN one — see public/app.js.
    if (has('setCallsign') && has('rollCallsign')) setCallsign(rollCallsign(state().name));
    render(current); return;
  }
  if (t.dataset.cs) {
    if (t.dataset.cs === 'open') { openCallsign(); return; }
    if (t.dataset.cs === 'cancel') { closeCallsign(); return; }
    if (t.dataset.cs === 'save') { submitCallsign(); return; }
    return;
  }
  // Every Friends-screen control, on one attribute. The value is the op, and an
  // op that acts on somebody carries their id after a colon — a uuid holds no
  // colon, so the split is unambiguous.
  if (t.dataset.fr) { frAct(t.dataset.fr); return; }
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

// refreshAccountChip() fires this the moment a session changes; the two screens
// that show the account (home chip, Bay controls row) redraw in place. Only
// while the bay is the screen on stage: a match must never be repainted over.
// The social snapshot lands from app.js — a reply, or a push the server made
// when someone else changed something. The screen that reads it redraws in
// place, and only while the bay is on stage: a match must never be repainted
// over. (Task 8 widens this to its Friends screen.)
document.addEventListener('cc:social', () => {
  const host = $('bay');
  if (host && host.classList.contains('active') && (current === 'settings' || current === 'friends')) render(current);
  // The open menu reads the snapshot too — Remove friend appears on a card the
  // moment the friendship lands, and goes when it is torn down.
  pmPaint();
});
// THE PLAYER MENU'S FOUR DOORS: a friends-list card, a search result, a LOBBY
// SEAT and an IN-MATCH CARD. The first three are inside #bay; the fourth is the
// HUD, which is why this listener is not gated on the bay being on stage the
// way the one above it is.
document.addEventListener('click', (e) => {
  const t = e.target.closest ? e.target.closest('[data-pmenu]') : null;
  if (!t) return;
  pmOpen(t.dataset.pmenu, t.dataset.pmkind, t.dataset.pmname || '');
});
// A MENU MUST NOT OUTLIVE WHAT IT POINTS AT. showScreen is the game's own
// router, so leaving a lobby, finishing a match and going back to the bay all
// pass through here — and a seat handle is dead the moment its room is.
if (fn('showScreen')) { const orig = showScreen; showScreen = function () { pmClose(); return orig.apply(this, arguments); }; }
// The landscape keyboard, for the Friends screen's two fields. The lift is
// measured against the box the field sits in, so the error line under it stays
// visible; leaving the field, or the screen, puts the frame back down.
document.addEventListener('focusin', (e) => {
  const id = e.target && e.target.id;
  if (current !== 'friends') return;
  if (id === 'frQ') kbdWatch(true, '#frbQ');
  else if (id === 'frCode') kbdWatch(true, '#frbCode');
});
document.addEventListener('focusout', (e) => {
  const id = e.target && e.target.id;
  if (id !== 'frQ' && id !== 'frCode') return;
  setTimeout(() => {
    const a = document.activeElement;
    if (!a || (a.id !== 'frQ' && a.id !== 'frCode')) kbdWatch(false);
  }, 0);
});
// Enter commits, the way it does in the callsign editor and the join panel.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || current !== 'friends') return;
  const id = e.target && e.target.id;
  if (id === 'frQ') { e.preventDefault(); frSearch(); }
  else if (id === 'frCode') { e.preventDefault(); frAddCode(); }
});
document.addEventListener('cc:account', () => {
  const host = $('bay');
  // A GUEST'S BLOCKED LIST BELONGS TO THAT GUEST. app.js drops CC_SOCIAL when
  // the account changes, for the same reason; this is the other half of it, and
  // without it a signed-out session would keep drawing the last account's list.
  gb = { list: null, err: '', asking: false };
  // The open menu's items depend on who is asking — Remove friend is a linked
  // account's, and every item goes when the account does.
  pmPaint();
  if (host && host.classList.contains('active') && (current === 'home' || current === 'settings' || current === 'friends')) render(current);
  // A sign-in that lands WHILE Bay controls is open never re-enters the screen,
  // so render()'s entry hook would never fire and the row would go on saying
  // "sign in to choose a callsign" to somebody who just did.
  if (current === 'settings' && fn('socialNeed')) socialNeed();
  // Same for the Friends screen: a sign-in that lands while it is open never
  // re-enters it, so render()'s entry hook would never fire and the screen
  // would go on offering the sign-in card to somebody who just did.
  if (current === 'friends') frNeed();
});
applyMotion();

// LOBBY FEED. renderLobby/showLobby are the game's own; wrap them so the bay
// sees every message, then let them run unchanged (they also call showScreen,
// which routes 'lobby' to the bay under the flag).
if (fn('renderLobby')) { const orig = renderLobby; renderLobby = function (m) { lobby.m = m; lobby.mode = 'host'; return orig.apply(this, arguments); }; }
if (fn('showLobby'))   { const orig = showLobby;   showLobby   = function (mode) { lobby.mode = mode; if (mode !== 'host') lobby.m = null; return orig.apply(this, arguments); }; }

// BOOT. The bay is the menu: take the route in, once.
if (has('showScreen')) showScreen('home');
})();
