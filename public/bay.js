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
  get pendingIntent() { return typeof pendingIntent !== 'undefined' ? pendingIntent : undefined; },
  get soloRoom()      { return typeof soloRoom      !== 'undefined' ? soloRoom      : undefined; },
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
  // No friend joins a duel by code any more (owner, 2026-10-06): it is the
  // computer, or a squad of two.
  { id: 'duel',   name: 'Duel',           players: '2',         tag: 'Head to head',
    blurb: 'One on one, against the computer or a squad mate. First to bring the other down.',
    art: 'alpine-wide',   card: 'alpine-hero',   draft: 5 },
  // FFA SEATS 2-4 (the engine's MODE_SEATS, and the Seats line), so the card
  // says so too (fix wave E4): '3-4' beside a squad of two's "Needs 2 players"
  // read as two different minimums on one card.
  { id: 'ffa',    name: 'Free-for-all',   players: '2-4',       tag: 'Last tank standing',
    blurb: 'Two to four commanders, one ridge line. Everyone for themselves.',
    art: 'desert-wide',   card: 'desert-hero',   draft: 5 },
  { id: 'boss',   name: 'Boss Fight',     players: '1-2 co-op', tag: 'Bring down WARLORD-7',
    blurb: 'A mech that fights back. Beat it and the Midnight paint drops.',
    art: 'volcanic-wide', card: 'volcanic-hero', draft: 7 },
  { id: 'aliens', name: 'Alien Invasion', players: '1-2 co-op', tag: 'Hold the line',
    blurb: 'Escalating waves of xeno saucers. See how long you last.',
    art: 'ruins-wide',    card: 'ruins-mid',     draft: 7 },
  { id: 'golf',   name: 'Artillery Golf', players: '1-4',       tag: 'Nine holes, no damage',
    blurb: 'Driver, Iron, Wedge, Putter. Real rolling physics and a scorecard.',
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
// connection, and what one player can still do on this device. `solo` is what
// it says instead of `need` for a Solo create (app.js soloRoom), the only
// create Match setup sends: that room invites nobody, it waits for the server.
// Duel and Free-for-all have none, because their Solo is an 'ai' frame, which
// never waits in this lobby: it starts on this device when there is no server.
const SOLO_COPY = {
  duel:   { need: 'Duel needs a connection to bring in your friend.', can: 'You can fight a CPU commander on this device.' },
  boss:   { need: 'Boss Fight needs a connection to bring in a second commander.', can: 'You can take on WARLORD-7 alone on this device.',
            solo: 'Your solo run starts as soon as the server can be reached.' },
  aliens: { need: 'Alien Invasion needs a connection to bring in a second commander.', can: 'You can hold the line alone on this device.',
            solo: 'Your solo run starts as soon as the server can be reached.' },
  ffa:    { need: 'Free-for-all needs a connection to invite commanders.', can: 'You can fight CPU commanders on this device.' },
  golf:   { need: 'Artillery Golf needs a connection to invite other players.', can: 'You can play a solo round on this device.',
            solo: 'Your solo round starts as soon as the server can be reached.' },
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
  // THE GOLF BAG, the Bay stations row golf shows in the Armoury's place: a
  // tall bag with a pocket and three club heads standing out of the collar.
  bag:'<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
       '<path fill-rule="evenodd" d="M8.4 10.8h7.2l-.5 10.4c0 .9-.8 1.6-1.7 1.6h-2.8c-.9 0-1.7-.7-1.7-1.6zM10.2 14.4v4.2h3.6v-4.2z"/>' +
       '<rect x="7.6" y="8.4" width="8.8" height="2.2" rx="1"/>' +
       '<path d="M9.4 8.4 8 4.6l1.4-.5 1.5 4.3z"/><ellipse cx="8.2" cy="3.6" rx="2.1" ry="1.5" transform="rotate(-20 8.2 3.6)"/>' +
       '<path d="M11.3 8.4V3.6h1.4v4.8z"/><rect x="10.4" y="2.2" width="4.4" height="1.8" rx=".5"/>' +
       '<path d="M14.4 8.4l1.5-4.3 1.3.5-1.4 3.8z"/><path d="M15.6 2.8l3.2 1-.5 1.7-3.2-1z"/></svg>',
  medal:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.4 2.2h3.1l2.1 5.7-2.9 1.3z" opacity=".65"/>' +
       '<path d="M16.6 2.2h-3.1l-2.1 5.7 2.9 1.3z" opacity=".65"/><circle cx="12" cy="15.6" r="6"/>' +
       '<circle cx="12" cy="15.6" r="2.6" fill="#0a0e18"/></svg>',
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
  // THE SQUAD BOX'S REMOVE AND DECLINE. Two strokes, drawn: the obvious
  // characters for a cross sit in the Dingbats block, which test/house-rules.mjs
  // rejects with the rest of the emoji ranges.
  cross:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  share:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
       '<path d="M12 3.6v11"/><path d="M8.3 7.3L12 3.6l3.7 3.7"/><path d="M5.8 12.6v6.1a1.9 1.9 0 0 0 1.9 1.9h8.6a1.9 1.9 0 0 0 1.9-1.9v-6.1"/></svg>'
};

// The offline badge on every mode board: what this mode does with no server,
// asked of app.js's own predicates so a board can never promise more than the
// launch path delivers. Green is the bay's OFFLINE colour.
const OFF_TXT = { cpu: 'Offline vs CPU', solo: 'Offline solo', online: 'Online only' };
const offKind = (id) => (fn('offlineKind') ? offlineKind(id) : 'online');
const offBadge = (id) => '<span class="bof">' + esc(OFF_TXT[offKind(id)] || OFF_TXT.online) + '</span>';
// SQUAD SEATS ON THE BOARDS (design 5.2, D12). `fits` is computed on the
// SERVER from the engine's own seat table (plan X6), so a board that dims and
// a Start that refuses read one truth: nothing in this file decides whether a
// squad fits a mode. The squad is the box's one read of app.js's slot (sq.snap,
// plan X7). No squad, or a frame with no `fits`, dims nothing -- the board
// every player who never squads up still gets. Nor does a squad the socket
// cannot reach: offline the boards are a player's own, as Launch is
// (sqTwoPlus), and a pill would say "Squad too big" over a game alone.
const noFit = (id) => { const q = sq.snap; return !!(q && wsReady() && q.fits && q.fits[id] === false); };
// WHICH WAY IT DOES NOT FIT, in words. `fits` checks the mode's MINIMUM as well
// as its maximum (X6), so a squad of one fits no duel, and D12's "Squad too
// big" would be false there. The minimum is read off the box's own seat copy
// (SQ_SEATS: '2', '2&ndash;4', '1&ndash;2' ...), the one place this file spells
// the seats, and it only ever picks the words: whether a board dims is `fits`
// alone. ITS OWN CLASS, NEVER .bof: the home boards lost the offline badge on
// 2026-09-18, and test/offline.mjs asserts the home boards carry no .bof at
// all. Fixed words and a number, so there is nothing here to escape.
function noFitPill(id) {
  if (!noFit(id)) return '';
  const n = Array.isArray(sq.snap.members) ? sq.snap.members.length : 0;
  const min = parseInt(SQ_SEATS[id], 10) || 1;
  return '<span class="bnf">' + (n < min ? 'Needs ' + min + ' player' + (min === 1 ? '' : 's') : 'Squad too big') + '</span>';
}

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
    diff: has('cpuDifficulty') ? cpuDifficulty : 'medium',
    count: has('ccMax') ? ccMax : 4,
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
// The lit platform, the reflection, and the tank itself. o = {cx, cy, w} in design px,
// and o.sink: how much lower the tank and its reflection stand on the platform
// than everywhere else draws them (0 when absent).
function stage(skinId, o) {
  const w = o.w, h = Math.round(w * 246 / 300), sink = o.sink || 0;
  const pw = Math.round(w * 1.5), ph = Math.round(pw * 0.193);
  const src = tankURL(skinId, w);
  const img = (extra) => src ? '<img src="' + src + '" alt="Your tank" style="width:' + u(w) + '"' + (extra || '') + '>' : '';
  return '<div class="plat" style="left:' + u(o.cx - pw / 2) + ';top:' + u(o.cy - ph / 2) + ';width:' + u(pw) + ';height:' + u(ph) + '">'
    + '<span class="plate"></span><span class="platc"></span><span class="rim"></span>'
    + '<span class="ringw" style="left:0;top:' + u(Math.round((ph - pw) / 2)) + ';width:' + u(pw) + ';height:' + u(pw) + '"><span class="ring"></span></span></div>'
    + '<div class="refl" style="left:' + u(o.cx - w / 2) + ';top:' + u(o.cy - 7 + sink) + ';width:' + u(w) + ';height:' + u(Math.round(h * 0.34)) + '">' + img(' alt=""') + '</div>'
    + '<div class="tankw" style="left:' + u(o.cx - w / 2) + ';top:' + u(o.cy - 3 - h + sink) + ';width:' + u(w) + '">' + img() + '</div>';
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
// An option with a third entry is drawn DISABLED, and that entry is the one
// line saying why, inside the option itself: shown, so the player can see the
// choice exists and what it needs, but not pressable. Inside, not under the
// row, because Match setup's column has no height to spare for another line.
// An option with none is markup for markup what it always was.
function seg(label, key, opts, cur, hidden) {
  return '<div class="b-opt' + (hidden ? ' hidden' : '') + '"><span class="lbl">' + label + '</span><div class="segs">'
    + opts.map((o) => '<button class="seg' + (String(cur) === String(o[0]) ? ' on' : '') + '" data-set="' + key + '=' + o[0] + '"' + (o[2] ? ' disabled' : '') + '>'
      + o[1] + (o[2] ? '<span class="b-why">' + o[2] + '</span>' : '') + '</button>').join('')
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

/* ---- the golf bag ----------------------------------------------------------------
   GOLF DRAFTS NOTHING (owner, 2026-10-06): every seat swings the same four
   clubs, so wherever the bay shows weapons for golf -- the home readout and
   station, the mode card, Match setup, the Armoury, the lobby -- it shows the
   bag instead, read-only: no picking and no Edit. The ids and their order
   mirror game-core's GOLF_BAG, which builds the golf strip in the match (this
   is a classic script and cannot import it; test/golf_four_ui.mjs holds the
   two together). Names, words and art are HELP_WEAPONS' and ICONS', the ones
   the dock and the field manual draw. */
const GOLF_BAG = ['driver', 'golfball', 'wedge', 'putter'];
const isGolf = (m) => !!m && m.id === 'golf';

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
// THE STANDARD WEAPONS A SHORT RACK IS TOPPED UP WITH, in one order wherever a
// rack is topped up: the standard draft (ARM_DEFAULT), then the rest of the
// pool, each in its own order, never a pick twice. Only the Armoury's pool,
// so no golf, boss or CPU-only weapon can ever be put in a rack.
function topUp(picks, n) {
  const pool = has('ARM_POOL') ? ARM_POOL : [], out = picks.slice();
  for (const id of [...(has('ARM_DEFAULT') ? ARM_DEFAULT : []), ...pool]) {
    if (out.length >= n) break;
    if (pool.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
// START GAME ALWAYS WORKS (owner, 2026-10-06). The player's rack is the picks
// they have stored, the pool's ids only and a repeat counted once. Fewer of
// them than the mode drafts -- none stored at all included, which the screens
// show as the standard draft -- and the empty slots are filled with standard
// weapons (topUp). That rack is SAVED as the player's, because the match's
// draft is submitted straight from storage the moment it opens (applySnapshot)
// and reads the first picks as stored: a short rack there raised the draft
// over the battlefield, and a stored repeat sent a rack the server refuses.
// A rack already full with no repeat is left exactly as stored, longer ones
// included, since a seven-weapon raid rack is a five-weapon duel rack's first
// five.
function fillRack(m) {
  const n = m.draft, pool = has('ARM_POOL') ? ARM_POOL : [];
  let stored = null, have = [];
  try {
    stored = JSON.parse(localStorage.getItem('cc_loadout') || 'null');
    if (Array.isArray(stored)) have = stored.filter((id, i) => pool.includes(id) && stored.indexOf(id) === i);
  } catch {}
  const full = topUp(have, n);
  if (JSON.stringify(full) === JSON.stringify(stored)) return;
  try { localStorage.setItem('cc_loadout', JSON.stringify(full)); } catch {}
  // The Armoury's working copy is what its next toggle saves, so it carries the
  // filled rack too: left behind, one tap would store the short one again.
  rack = full.slice();
}
function togglePick(id) {
  // The Armoury's own draft: the armed mode's.
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

/* ---- the Squad box and the Manage squad window ----------------------------
   THE BOX is the LEFT home panel, 196 x 192u, in the slot the recent-match
   panel held. It shows the squad and nothing else (owner, 2026-10-06): a
   header, "Squad 2/4" and Manage, then a list that scrolls -- the invite this
   player just received, each member with their ready status, and the friends
   who are online, each with Invite. A guest's box says that friends need an
   account, with Sign in. The tabs it had (D10) and its in-box footer are gone:
   Ready is the home ribbon's (U3), and everything else is the window's.

   THE WINDOW is a bay screen, SCREENS.squad, behind Manage, with the standard
   chrome (header, Back), like Friends and Bay controls. Three columns: join a
   squad by code and this squad's own code with Copy and Share; the members
   with their ready status, the leader's Remove, Ready and Leave; and every
   friend, online first, with Invite. Every action in it is the box's old
   action, moved, not copied: one sender (sqOne), one dispatcher (sqAct).

   THE MORPH CONTRACT, and it is the reason for every `.hidden` below.
   morphChildren() is POSITIONAL, not keyed: it walks childNodes by index,
   morphs the overlap, drops the tail and appends the remainder. So a node a
   state has nothing to say in is kept with `.hidden` rather than dropped --
   the count, the request lamp, the error lines. That also protects the code
   field: morphNode returns early for INPUT/TEXTAREA ("the value is the
   player's"), so what was typed survives a repaint, as long as the field keeps
   its place -- which is why it is the first thing in the window's first
   column, under nothing that changes. THE MORPH PATH ONLY -- render() does
   `host.innerHTML = html` whenever next !== current, so leaving the window
   and coming back DOES clear the field. Snapshots, presence pushes and
   account changes all repaint it in place, and all keep it.

   null IS NOT EMPTY. sq.known is false until the server has answered, and the
   box says "Not loaded yet." for exactly that long. Rendering "No squad yet"
   for an answer that never arrived is the bug this project has shipped twice
   (app.js's socialCallsign comment names both). */
const SQ_KEY = 'cc_squad';
const SQ_MAX = 4;
// THE CODE FIELD JOINS SQUADS ONLY (owner, 2026-10-06: friend games are squads,
// and game codes are retired), so an unknown code is "no squad", and a code
// the server knows as a game room is said to be one rather than joined.
// app.js's SQUAD_LINK_ERR carries the same no_such_squad sentence, so a join by
// link reads like a join by the field.
const SQ_NONE = 'No squad with that code.';
const SQ_GAME = 'That is a game code. Only squad codes join here.';
// THE BOX'S OWN READ STATE. `snap` is NOT a copy: it reads app.js's one slot
// (plan X7), so a roster the server pushes when somebody else acts reaches the
// box through the same field as the answer to its own question. It is a
// getter with no setter, so in this strict file `sq.snap = x` THROWS: a copy
// kept here would stop seeing those pushes.
//   known  -- an answer is in hand (it outlives a reconnect, so the box keeps
//             what it knows on screen while it asks again)
//   gone   -- that answer was `gone` and this tab HAD a squad to lose
//   via    -- the socket introduction (app.js's socialIntro) last asked under
//   again  -- the last answer was `gone`, which may be premature: the tab's
//             next return asks once more (see sqBack)
// Which code a resume may present is NOT kept here: it belongs to the tab, not
// to one account's answer (sqHeld, below).
// TASK 9's fields, one account's like the rest (an account switch replaces the
// whole object, sqReset):
//   busy   -- the one squad action in flight: '' | 'join' | 'ready' | 'leave' |
//             'start' | 'kick' | 'invite' | 'friend'. One at a time: the box has
//             one footer.
//   aerr   -- what the last footer action was refused with. NOT `err`, which
//             is the re-ask's refusal and swaps the squad for Retry.
//   ierr   -- what the last Join from the invite row was refused with.
//   ignored -- the ONE squad code whose invite Ignore hid.
//   used   -- the invite a Join from its row answered (the slot's object),
//             so it does not come back when the player later leaves.
//   kick   -- the row the leader's open "Remove ...?" is about (sqKickAsk).
//   ferr, fnote -- what the last friend-row action (Invite, Accept, Decline)
//             came back with, a refusal or the note the inviter is told, said
//             under the row `fat` names, in the box or the window.
//   serr   -- why the squad's last start was refused, pushed to every member
//             (U3): the ready control says it until this player's next action.
//   invited -- friend id -> { snap, until }: Invited until the next roster or 30 s.
// TASK 11's field:
//   cbusy  -- a code is out: the code frame, or the squad join it led to. One
//             code at a time (sqEnter).
const sqFresh = () => ({
  known: false, gone: false, err: '', asking: false, cerr: '', cbusy: false, via: 0, again: false,
  busy: '', aerr: '', ierr: '', serr: '', ignored: '', used: null, kick: null,
  ferr: '', fnote: '', fat: '', invited: new Map(),
  get snap() { return window.CC_SQUAD || null; },
});
let sq = sqFresh();

// sqNote takes SAFE HTML -- entities, never player text. Anything a player
// typed goes through esc() before it gets here.
const sqNote = (html) => '<p class="sqn">' + html + '</p>';
// The error line is always in the tree and empty-and-hidden when there is
// nothing to say, so its absence never shifts the nodes beneath it. .cs does
// the same thing in the settings column, for the same reason.
const sqErr = (s) => '<p class="sqe' + (s ? '' : ' hidden') + '">' + esc(s || '') + '</p>';

// THE COUNT IN THE BOX'S HEADER, "Squad 2/4", or -1 while it is not known.
// D10 says a count, never a dash -- and a count this client has not been told
// is not a count. An unknown one is left out (its node kept, hidden) rather
// than shown as a zero. So is the count of a squad that lives on another
// socket of this account ('elsewhere', 'open'; review T8-R1-6): "0/4" under
// "Your squad is open on another device." would be false.
// A GUEST'S ZERO IS KNOWN (fix wave E9; design 5.1 state 1; owner, 2026-10-06:
// a guest's box reads "Squad 0/4"). A guest asks the server nothing unless
// this tab holds a guest row's resume secret (sqGkOf), so with no squad on
// screen and none to resume there is none.
function sqCount() {
  const guest = acctState() !== 'in';
  return sq.snap ? (sq.snap.members || []).length
    : (sq.known || (guest && !sqGkOf())) && !sq.err && !sqAway() ? 0 : -1;
}
// The friend requests waiting on this player's answer, for the lamp on Manage.
const sqRequests = () => { const sn = snap(); return sn && sn.requests && Array.isArray(sn.requests.in) ? sn.requests.in.length : 0; };
// THE BOX (owner, 2026-10-06): "Squad 2/4" and Manage, then a list that
// scrolls. The header never scrolls, so the count and the way into the window
// are always on screen; everything else is in .sqb, which ends in .sqfade --
// fix wave B1's "more below" fade, sticky at the foot of what is visible, and
// sitting in its own strip after the last row once the list is scrolled to
// its end, so it never covers a row. Nothing is pinned over the list: no row
// can be hidden under a footer.
// THE REQUEST LAMP MOVED TO MANAGE with the Friends tab it lit (D10): a friend
// request is answered in the window. The lamp is aria-hidden, so the button's
// name says it in words. The count's own words, "2 of 4", are for a screen
// reader, which would read the visible "2/4" as a fraction.
function sqPanel() {
  const n = sqCount(), inN = sqRequests();
  const label = 'Manage squad' + (inN > 0 ? ', ' + inN + ' friend request' + (inN === 1 ? '' : 's') + ' waiting' : '');
  // Its top and height are styles.css's (THE SIDE PANELS): they follow the
  // height the home frame has to spare.
  return '<div class="pnl sqx" style="left:' + u(18) + ';width:' + u(196) + '">'
    + '<div class="sqhd"><span class="sqhn">Squad</span>'
    +   '<span class="sqhc' + (n < 0 ? ' hidden' : '') + '"><span aria-hidden="true">' + (n < 0 ? '' : n + '/' + SQ_MAX) + '</span>'
    +     '<span class="sqvh">' + (n < 0 ? '' : ', ' + n + ' of ' + SQ_MAX) + '</span></span>'
    +   '<span class="grow"></span>'
    +   '<button class="sbtn sqmg" data-go="squad" aria-label="' + label + '">Manage<i class="sqd' + (inN > 0 ? '' : ' hidden') + '" aria-hidden="true"></i></button></div>'
    + '<div class="sqb" id="sqBox">' + sqBox() + '<i class="sqfade" aria-hidden="true"></i></div>'
    + '</div>';
}
const SQ_SIGN_IN = 'Sign in to add friends and keep your progress across devices. Your guest progress on this device comes with you when you do.';
// What a guest with no squad is told, in the box and in the window: what they
// can do NOW, before the door to an account (D11's order).
const SQ_GUEST_BOX = 'You can play right now. Got a squad code from a friend? Tap Manage to join, as a guest.';
const SQ_GUEST_WIN = 'You can play right now. Got a squad code from a friend? Enter it and you are in, as a guest.';
// Where the invite row stands while there is none to draw: the same status
// region, empty, so a screen reader hears an invite arrive in it.
const SQ_IW_GAP = '<div class="sqiw" role="status"></div>';
// THE BOX'S LIST, in the order a player reads it: the invite just received
// (time-limited, so it is on home and not only behind Manage), the squad,
// then the friends who are online.
function sqBox() {
  // OFFLINE FIRST, AND FOR EVERYONE. wsReady() -- not S.connected -- because
  // during an offline match S.ws is an in-page stand-in feeding room-engine.js,
  // which has no social code: a squad frame sent there vanishes and the box
  // waits for an answer that cannot come.
  if (!wsReady()) return SQ_IW_GAP + sqNote('Needs a connection.')
    + sqNote('Your squad and your friends come back when the connection does.') + '<div class="sqbf"></div>';
  const guest = acctState() !== 'in';
  // The invite row is drawn where the window draws it: with a squad in hand or
  // a signed-in account. A guest's no-squad states draw none -- a guest is
  // never invited -- and keep the empty region in its place.
  const inv = sq.snap || !guest ? sqInvRow(sq.snap) : SQ_IW_GAP;
  let mine;
  // A SQUAD IN HAND IS SHOWN, to a guest as much as to anyone: a guest who
  // joins by code is "in, as a guest" (D11). A REFUSED RE-ASK IS SAID BENEATH
  // IT, with Retry: after a blip only a resume puts this socket back on its row
  // (task 5), and a squad shown as if nothing were wrong would be swept from
  // under the player a minute later.
  if (sq.snap) mine = sqBoxSquad(sq.snap) + sqErr(sq.err) + (sq.err ? sqRetry() : SQ_GAP);
  else if (guest) mine = sqLead() + sqNote(SQ_GUEST_BOX);
  // NOT KNOWN YET, AND WHY, AND WHAT WILL BE DONE ABOUT IT -- frWait()'s three
  // parts, in a panel a third the size.
  else if (!sq.known || sq.err) mine = sqNote('Not loaded yet.') + sqErr(sq.err) + sqRetry();
  else mine = sqLead() || sqNote('No squad yet. Invite a friend below, or tap Manage to join a squad by code.');
  return inv + mine + '<div class="sqbf">' + sqBoxFriends() + '</div>';
}
// THE SQUAD IN THE BOX: each member's name and ready status (U3's state, drawn
// as the window draws it, sqRow), and the line a squad action was refused
// with. No Remove and no Ready here: those are the window's, and Ready is the
// home ribbon's too. Under a refused re-ask the squad is two read-only lines,
// as in the window.
function sqBoxSquad(sn) {
  const ms = Array.isArray(sn.members) ? sn.members : [];
  if (sq.err) return sqNote(ms.length + ' of ' + SQ_MAX + ': ' + esc(ms.map(nameOf).join(', ')) + '.');
  const ctl = { on: wsReady() && sqLive(sn), lead: false };
  return '<div class="sqml">' + ms.map((p, i) => sqRow(p, i, sn, ctl)).join('') + '</div>' + sqAErr(sq.aerr);
}
// THE FRIENDS WHO ARE ONLINE, each with Invite (owner, 2026-10-06): the rows
// the window draws for them (sqFriendRows), and nobody offline -- the window
// lists everyone. A guest is told friends need an account, with Sign in --
// and with no door to an account there is no "Sign in" to promise.
function sqBoxFriends() {
  if (acctState() !== 'in') return '<p class="sqh">Friends</p>' + (sqDoor() ? sqNote('Sign in to add friends.') + sqSignIn() : sqNote(SQ_NEED_ACCOUNT));
  const sn = snap();
  // null IS NOT EMPTY here either, and NOTHING RE-ASKS BY ITSELF: the read is
  // eight round trips on the server, asked once per connection and per
  // sign-in (app.js socialBoot) and after that only by hand.
  if (!sn) {
    const w = socWait();
    return '<p class="sqh">Friends online</p>' + sqNote('Not loaded yet.') + sqErr(w.err)
      + '<div class="sqf"><button class="sbtn" data-sq="fretry"' + (w.busy ? ' disabled' : '') + '>' + (w.busy ? 'Loading' : 'Retry') + '</button></div>';
  }
  const onN = (sn.friends || []).filter((x) => x && x.online && x.id).length;
  return '<p class="sqh">Friends online &middot; ' + onN + '</p>'
    + (onN ? sqFriendRows(sn, true) : sqNote('No friends online right now.'));
}
// THE DOOR TO AN ACCOUNT. It drives #accountBtn, the one path every account
// action already goes through, and it is offered only when that button is
// really there, because accountChip() drops the header chip on the same
// condition.
const sqDoor = () => { const b = $('accountBtn'); return !!(b && !b.classList.contains('hidden')); };
const sqSignIn = () => (sqDoor() ? '<div class="sqf"><button class="ghost sqg" data-old="accountBtn">Sign in</button></div>' : '');
const SQ_NEED_ACCOUNT = 'Friends need an account.';
// THE WINDOW'S MIDDLE COLUMN: the squad itself, as the box's Squad pane drew
// it, less the code field (the first column's now) and the dashed invite row
// (the friends column is beside it).
function sqPane() {
  if (!wsReady()) return sqNote('Needs a connection.') + sqNote('Your squad comes back when the connection does.');
  // The squad's own nodes come from sqMine; the refusal and Retry follow them
  // in EVERY squad state, Retry's place held by an empty node when there is
  // nothing to retry.
  if (sq.snap) return sqMine(sq.snap) + sqErr(sq.err) + (sq.err ? sqRetry() : SQ_GAP);
  if (acctState() !== 'in') return sqLead() + sqNote(SQ_GUEST_WIN);
  // THE FIRST CHILD IS THE INVITE ROW'S WRAPPER (sqInvRow, task 9), here and
  // in both branches below: an invite is a push, and it can land before the
  // answer does, after a squad ended, or with no squad at all.
  if (!sq.known || sq.err) return sqInvRow(null) + sqNote('Not loaded yet.') + sqErr(sq.err) + sqRetry();
  const lead = sqLead();
  if (lead) return sqInvRow(null) + lead;
  return sqInvRow(null) + sqNote('No squad yet. Invite a friend, or join a squad by its code.') + sqSeats();
}
// WHAT BECAME OF THE LAST SQUAD, said above whatever the box offers next.
// CAUSE-NEUTRAL (C3): a kick, the drop window, a block, a leaderless squad and
// a server restart all end in the same `gone`, and a sentence naming one of
// them would tell a player a block removed which thing happened to them.
// "has ended" is only said to a tab that HAD a squad (sq.gone); a player who
// never had one is told "No squad yet". An `ended` push says a little more,
// and only what the player can see for themselves: a kick -- which is also
// EXACTLY how a block that removes a player reads (D-BLOCK) -- their own
// leave, or another tab or device of theirs acting on the squad.
const SQ_ENDED = 'Your squad has ended. Squad up again.';
// `elsewhere` is sent when another socket of this ACCOUNT took this one's row
// by resuming, or left, created or joined from there (server/social.js,
// endedElsewhere). "changed" is the word true of all of those, and a second
// tab on THIS device is the commonest source, so the line names both. Task 9
// inherits this string.
const SQ_ELSEWHERE = 'Your squad was changed in another tab or on another device.';
// `open` (D-UI-1): the server showed this socket the account's squad with
// `held: false` -- a live socket elsewhere holds the row, so this one only
// looked. The owner's sentence, word for word.
const SQ_OPEN = 'Your squad is open on another device.';
// The account's squad lives on another socket: this tab gave it up, or was
// only shown it. Either way this tab asks again, bare, on a return and on a
// reconnect (sqBack; the end cleared sqHeld), and offers no squad controls
// meanwhile.
const sqAway = () => window.CC_SQUAD_END === 'elsewhere' || window.CC_SQUAD_END === 'open';
// Where Retry stands under a squad whose re-ask was not refused: an empty,
// hidden node of the same tag, so what follows keeps its index (morphChildren).
const SQ_GAP = '<div class="sqf hidden"></div>';
// "YOU LEFT THE SQUAD." IS SAID, AND THEN IT GOES (fix wave E9). It took the
// place of the no-squad copy and its Seats line and never cleared: a player
// who left read it for as long as they stayed on home. It is spent five
// seconds after it is first painted on a visible home, or by the next squad
// action from this box (sqOne, sqEnter), whichever comes first, and the box is
// design 5.1's state 2 again. A new `left` is a new line: the cc:squad
// listener resets both on every end that arrives. A kick, and every other
// end, keeps its line for as long as it stands -- those are news the player
// did not make, and a leave is one they did.
const SQ_LEFT_MS = 5000;
let sqLeftSpent = false, sqLeftT = 0;
function sqLeftSpend() {
  clearTimeout(sqLeftT); sqLeftT = 0;
  if (sqLeftSpent || window.CC_SQUAD_END !== 'left') return;
  sqLeftSpent = true;
  sqPaint();
}
function sqLead() {
  const end = window.CC_SQUAD_END;
  if (end === 'left' && sqLeftSpent) return sq.gone ? sqNote(SQ_ENDED) : '';
  // The five seconds start when the line is first PAINTED where it can be
  // read: home, on stage, in a tab in front of the player.
  if (end === 'left' && !sqLeftT && !document.hidden && $('bay') && $('bay').classList.contains('active')) sqLeftT = setTimeout(sqLeftSpend, SQ_LEFT_MS);
  if (end) return sqNote(end === 'kicked' ? 'You were removed from the squad.'
    : end === 'left' ? 'You left the squad.'
    : end === 'elsewhere' ? SQ_ELSEWHERE
    : end === 'open' ? SQ_OPEN
    : SQ_ENDED);
  return sq.gone ? sqNote(SQ_ENDED) : '';
}
/* ---- THE SQUAD ITSELF: forming and Ready (design 5.1 states 3-5) ----------
   sqMine(sn) draws the squad in the window's middle column as SIX nodes, the
   same six in every squad state, and sqPane follows them with the refusal and
   Retry. morphChildren is positional, so a node with nothing to say is kept
   with .hidden rather than left out, and a repaint moves nothing:
     0 .sqiw  the invite this player just received (empty when there is none)
       .sqh   "Members 2/4", the column's heading
     1 .sqml  the member rows -- or, under a refused re-ask, the squad in two
              read-only lines
     2        the Seats line (the leader) or who decides (a member)
     3 .sqae  what the last squad action was refused with
     4 .sqft  the footer: the mode readout (or the countdown), Ready and
              Leave, or the leader's "Remove <name> from the squad?"
   UNDER A REFUSED RE-ASK (sq.err) this socket may no longer hold its row -- a
   blip drops it and only a resume puts it back (task 5) -- so the squad is
   shown, and nothing in it is offered: Retry is the way back.
   EVERY CONTROL WAITS FOR held === true (D-UI-1). app.js writes only rosters
   this socket holds, but a frame from a server that cannot say so has no
   `held` at all, and it is shown with its controls dead.
   Names go through nameOf(), which is null-safe: a null name keeps its row. */
// THE SEAT COPY, NEVER A DECISION. `fits` is computed on the SERVER from the
// engine's own seat table so this box and the mode boards read one truth (X6);
// this map only spells that truth out in words, and nothing gates on it.
const SQ_SEATS = { duel: '2', ffa: '2&ndash;4', boss: '1&ndash;2', aliens: '1&ndash;2', golf: '1&ndash;4' };
// This socket's own row, found by `you` alone: a guest's row, and a signed-in
// player's row while the server checks their blocks, carry id null.
const sqMe = (sn) => (sn && Array.isArray(sn.members) && Number.isInteger(sn.you) ? sn.members[sn.you] || null : null);
// THE LEADER IS WHOEVER THE FRAME NAMES, and a frame that names nobody crowns
// nobody: a guest's id is null by construction, so a bare `p.id === leader`
// against a leader of null would crown every guest in the squad at once.
const sqIsLead = (sn, p) => !!(sn && p && sn.leader != null && p.id === sn.leader);
// Whether this socket may act on the squad on screen: it holds the row
// (D-UI-1) and no refused re-ask stands under it.
const sqLive = (sn) => !!(sn && sn.held === true && !sq.err);
// THE RACK FOR THE SQUAD'S MODE, NOT THE ARMED ONE. state() caps the picks at
// the ARMED mode's draft, so a device armed on Duel whose squad is playing
// Boss Fight would read five picks of a seven-weapon draft as a full rack.
// The read is state()'s own against the squad's mode, and a repeated id
// counts once: the server's rack check refuses duplicates.
function sqRack(modeId) {
  const m = modeOf(modeId), pool = has('ARM_POOL') ? ARM_POOL : [];
  let picks = [];
  try {
    const p = JSON.parse(localStorage.getItem('cc_loadout') || 'null');
    if (Array.isArray(p)) picks = p.filter((id, i) => pool.includes(id) && p.indexOf(id) === i);
  } catch {}
  if (!picks.length && has('ARM_DEFAULT')) picks = ARM_DEFAULT.slice();
  picks = picks.slice(0, m.draft);
  // GOLF ASKS FOR NO RACK, BUT ITS SEAT STILL CARRIES ONE: the server checks a
  // golf member's Ready (and an old client's Start) against five distinct
  // weapons (MODE_SEATS' `|| 5`), though golf never fires them. The bay shows
  // golf only its bag and never the Armoury's picks, so golf's rack is the
  // stored picks topped up from the standard draft, then the pool: always
  // full, never shown, and the stored preference itself is left untouched.
  if (m.id === 'golf') picks = topUp(picks, m.draft);
  return picks;
}
// What a squad action was refused with. Its own line and its own class: the
// pane's first .sqe is the re-ask's refusal (sqPane), and a second sentence
// with that class above it would stand in for it.
const sqAErr = (s) => '<p class="sqae' + (s ? '' : ' hidden') + '">' + esc(s || '') + '</p>';
// ONE MEMBER. The lamp is IC.dot -- drawn, never typed (house rule 1 rejects
// the whole Geometric Shapes block). DROPPED OUTRANKS READY: a dropped row can
// arrive ready -- readied from another device before the drop -- and Start
// refuses it all the same (task 5), so it is never shown a tick. The menu is on
// every row but your own (report.self and block.self can only fail) and a
// guest's (a guest has no id to report); the leader's Remove is on every row
// but their own, a guest's included, and names the row by its handle, `rid`
// (D-UI-3): a row the server gave no handle is a row no kick can name.
// TWO LINES (D-UI-5): the name has the first line (.sqm1) to itself, and the
// status words (.sqms) and the controls share the second (.sqm2), so no status
// word or button ever takes width from a name. The friend rows are built the
// same way. The box draws these rows too, with `ctl.lead` false: its rows
// carry the status and the menu, and Remove is the window's.
// READY IS A WORD AS WELL AS A TICK (owner, 2026-10-06: "each member's name
// with their ready status", easy to read): "Ready" beside the drawn tick, as
// "Not ready" and "Reconnecting" are words.
const sqRid = (p) => (p && typeof p.rid === 'string' && p.rid ? p.rid : '');
function sqRow(p, i, sn, ctl) {
  const you = i === sn.you, name = nameOf(p), lead = sqIsLead(sn, p);
  const lit = !!p.online && !p.dropped;
  // THE LEADER'S ROW SAYS READY OR NOT, LIKE EVERY ROW (U3; owner,
  // 2026-10-06). Fix wave E9 took it off when the leader had no Ready and
  // Start stood in for one; now the leader readies like everyone else, and
  // the squad starts when every row carries the tick.
  // A SQUAD OF ONE SAYS NEITHER (owner: ready-up appears once a second player
  // joins). "Leader  Not ready" under a player's own name asked for something
  // nothing on screen lets them do, since their Launch is the ordinary one.
  const st = (sn.members || []).length < 2 ? ''
    : p.dropped ? '<span class="sqr dr">Reconnecting</span>'
    : p.ready ? '<span class="sqr on">' + IC.tick + 'Ready</span>'
    : '<span class="sqr">Not ready</span>';
  const kick = ctl.lead && !you && !lead && !!sqRid(p);
  return '<div class="sqm"><div class="sqm1">'
    + '<span class="pdot' + (lit ? ' on' : '') + '" title="' + (p.dropped ? 'Reconnecting' : lit ? 'Online' : 'Offline') + '">' + IC.dot + '</span>'
    + '<span class="sqmn"><span class="sqmt">' + esc(name) + '</span>' + (you ? '<span class="sqmy">(you)</span>' : '') + '</span></div>'
    + '<div class="sqm2"><span class="sqms">' + (lead ? '<span class="sql">Leader</span>' : '') + st + '</span>'
    + (you || p.id == null ? '' : menuBtn(p.id, 'id', name, false, !named(p)))
    // Never "Remove No callsign" to a screen reader (review T9-R1-12): the
    // question in the footer says "this player", and so does the label.
    + (kick ? '<button class="sqic" data-sq="kick:' + esc(sqRid(p)) + '" title="Remove from the squad" aria-label="Remove '
      + (named(p) ? esc(p.callsign) : 'this player') + ' from the squad"' + (ctl.on ? '' : ' disabled') + '>' + IC.cross + '</button>' : '')
    + '</div></div>';
}
// THE SEATS LINE, LIT BY `fits` (D12). The modes the squad does not fit are
// stated, not hidden: a player who cannot see Duel cannot learn that their
// squad is one too many for it.
function sqSeatsLine(sn, hide) {
  const f = sn.fits || {};
  return '<div class="sqs' + (hide ? ' hidden' : '') + '">' + MODES.map((m) =>
    '<span' + (f[m.id] ? ' class="on"' : '') + '>' + esc(SHORT[m.id]) + ' ' + SQ_SEATS[m.id] + '</span>').join('<i> &middot; </i>') + '</div>';
}
// DESIGN 5.1 STATE 4. Where the leader has the Seats line, a member has the
// one thing they need to know: who decides, and what happens to them then.
// The leader picks the mode and no longer starts (U3): the last Ready does.
function sqLeadNote(sn, hide) {
  const L = (sn.members || []).find((p) => sqIsLead(sn, p));
  return '<p class="sqnote' + (hide ? ' hidden' : '') + '">' + (L && named(L) ? esc(L.callsign) : 'The squad leader')
    + ' picks the mode. The match starts when everyone is ready.</p>';
}
// THE WINDOW'S SQUAD FOOTER. The leader's line reads the mode and its seats, or -- in design
// 5.1's order -- why the squad cannot start: seats first, because no Ready can
// fix a squad the mode has no room for, and then how many it is waiting for. A
// member's reads the mode. While the squad counts down, both say so.
// EVERYONE HAS READY AND LEAVE (U3; owner, 2026-10-06): the leader readies like
// every member and nobody starts the match -- the last Ready does, after the
// countdown every member sees. The Ready toggle says its state with a tick and
// aria-pressed, not with a second word, and standing UP is dead while the
// squad could not start (sqUpWhy); standing down never is.
// A SHORT RACK NEEDS NOTHING FIRST: Ready fills it with standard weapons
// (sqReady), the owner's rule for every start, so the Armoury's door that
// stood here in Ready's place ("Pick N more", D-UI-3) has gone.
function sqFoot(sn, ctl, hide) {
  const ms = sn.members || [], me = sqMe(sn), m = modeOf(sn.mode), seats = SQ_SEATS[m.id];
  const open = '<div class="sqft' + (hide ? ' hidden' : '') + '">';
  // THE LEADER'S OPEN QUESTION TAKES THE FOOTER while it is live (sqKickLive),
  // and names the row as it stands NOW: the handle is the row's, and a guest
  // who signed in since the question opened is shown by the name they have.
  if (ctl.lead && sq.kick && sqKickLive(sn)) {
    const k = sqKickRow(sn);
    return open + '<p class="sqfl sqq">Remove ' + (named(k) ? esc(k.callsign) : 'this player') + ' from the squad?</p><div class="sqfb">'
      + '<button class="ghost" data-sq="kcancel"' + (sq.busy ? ' disabled' : '') + '>Cancel</button>'
      + '<button class="go" data-sq="kok"' + (ctl.on && !sq.busy ? '' : ' disabled') + '>' + (sq.busy === 'kick' ? 'Removing' : 'Remove') + '</button></div></div>';
  }
  const fit = !!(sn.fits && sn.fits[sn.mode]);
  const waiting = ms.filter((p, i) => i !== sn.you && (!p.ready || p.dropped)).length;
  const left = sqCountLeft();
  const line = left !== null ? (left > 0 ? 'Starting in ' + left : 'Starting')
    : !ctl.lead ? esc(m.name) + ' &middot; ' + seats
    : !fit ? esc(m.name) + ' &middot; seats ' + seats + ', squad ' + ms.length
    : waiting ? 'Waiting for ' + waiting
    : esc(m.name) + ' &middot; ' + seats;
  const ready = !!(me && me.ready && !me.dropped);
  // NO READY IN A SQUAD OF ONE (owner: ready-up appears once a second player
  // joins): it could never be pressed, and said nothing about why. Kept in the
  // tree, hidden and dead, so Leave keeps its place for morphChildren.
  const alone = ms.length < 2;
  // THE LEADER LEAVES TOO (D-UI-3). The server's leave hands the lead to the
  // earliest signed-in member (squads.js detach), or ends a squad nobody left
  // in it can lead.
  return open + '<p class="sqfl">' + line + '</p><div class="sqfb">'
    + '<button class="go cy' + (ready ? ' on' : '') + (alone ? ' hidden' : '') + '" data-sq="ready" aria-pressed="' + ready + '"'
      + (alone || !ctl.on || sq.busy || (!ready && sqUpWhy(sn)) ? ' disabled' : '') + '>'
      + (sq.busy === 'ready' ? 'Sending' : (ready ? IC.tick : '') + 'Ready') + '</button>'
    + sqLeaveBtn(ctl) + '</div></div>';
}
function sqLeaveBtn(ctl) {
  return '<button class="ghost" data-sq="leave"' + (!ctl.on || sq.busy ? ' disabled' : '') + '>'
    + (sq.busy === 'leave' ? 'Leaving' : 'Leave') + '</button>';
}
// DESIGN 5.1 STATE 5: THE INVITE THIS PLAYER JUST RECEIVED (app.js's
// CC_SQUAD_INVITE). It sits ABOVE whatever the pane shows -- no squad, an ended
// one, or a squad the player is in (design 7: an invite reaches a player already
// in a squad, and Join moves them) -- inside a wrapper that is always there and
// empty when there is nothing to show, so nothing beneath it changes index.
// NOT SHOWN: an invite to the squad the player is standing in; the squad whose
// invite Ignore hid ("for this invite only": that squad's, not every invite);
// and the invite a Join from this row has already answered.
// AND NOT ONE OLDER THAN TEN MINUTES (D-UI-4): app.js stamps it on arrival and
// times it out, and the age is read here as well, because a timer in a
// background tab can fire late. Without app.js's reader, nothing is fresh.
const sqInvFresh = (inv) => !!(fn('socialInviteFresh') && socialInviteFresh(inv));
// The invite the box and the window show, or null: ONE reader, for the row,
// its Join and the reload's carry, so they can never disagree.
function sqInvOf(sn) {
  const inv = window.CC_SQUAD_INVITE;
  if (!inv || typeof inv.code !== 'string' || !inv.code || inv === sq.used || inv.code === sq.ignored
      || (sn && sn.code === inv.code) || !sqInvFresh(inv)) return null;
  return inv;
}
// THE WRAPPER IS A STATUS REGION (D-UI-4): it is always in the tree, empty when
// there is nothing to show, so a screen reader hears an invite arrive in it.
function sqInvRow(sn) {
  const inv = sqInvOf(sn);
  if (!inv) return '<div class="sqiw" role="status"></div>';
  const f = inv.from || {}, joining = sq.busy === 'join';
  return '<div class="sqiw" role="status"><div class="sqi">'
    + '<p class="sqit">' + (named(f) ? esc(f.callsign) : 'A friend') + ' invites you to their squad &middot; '
    +   esc(inv.size) + ' / ' + esc(inv.max) + '</p>'
    + '<div class="sqib"><button class="sbtn on" data-sq="join:' + esc(inv.code) + '"' + (wsReady() && !sq.busy ? '' : ' disabled') + '>'
    +   (joining ? 'Joining' : 'Join') + '</button>'
    + '<button class="sbtn" data-sq="ignore:' + esc(inv.code) + '"' + (joining ? ' disabled' : '') + '>Ignore</button></div>'
    + sqAErr(sq.ierr) + '</div></div>';
}
// JOIN, from the invite row. The code is the SLOT's, never the attribute's
// alone, and the current callsign and paint ride the frame as they do on the
// code field's join (sqEnter): a squad seat's name is whatever this frame
// carried, and Start hands it to the engine (task 4). The server answers a
// join with the roster itself (`op:'state'`), which app.js has already put in
// the slot by the time this answer runs.
function sqJoin(code) {
  const inv = window.CC_SQUAD_INVITE;
  if (!inv || inv.code !== code || inv === sq.used || inv.code === sq.ignored) return;
  // PAST ITS TEN MINUTES IT JOINS NOTHING (D-UI-4), however its button is
  // pressed: the row goes instead.
  if (!sqInvFresh(inv)) { sqPaint(); return; }
  sqOne({ type: 'squad', op: 'join', code: inv.code, name: has('myName') ? myName() : '', skin: has('mySkin') ? mySkin() : '' },
    { op: null, kind: 'squad.join', busy: 'join', sink: 'ierr', done: (m, mine) => {
      // fits() proves the type; the op is this callback's to prove.
      if (m.op !== 'state') { mine.ierr = socErr('squad.join', 'unavailable'); return; }
      mine.known = true; mine.gone = false; mine.err = ''; mine.used = inv;
    } });
}
// ONE SENDER FOR EVERY SQUAD ACTION, AND THE ORDER OF ITS FIRST LINES IS THE
// GUARD. socialTx answers SYNCHRONOUSLY when the socket is down -- `cb({ error:
// 'offline' }, ...)` before it returns -- so a caller that set `busy` AFTER the
// call would set it on top of the callback that had already cleared it, and
// the footer would be dead for the rest of the session with nothing on screen
// to say why. It is set BEFORE.
// A REPLY THAT IS MERELY SLOW IS NOT A FAILURE: social frames queue per socket
// behind store calls, so while one is out the box keeps its LAST SNAPSHOT --
// every row, every name -- and only the control that was tapped changes its
// word. It invents no timer: socialSend's own waiter answers 'unavailable' on
// a live socket and 'offline' on a dead one, and that becomes the sentence.
// Every write goes to `mine`, the state that asked: an account switch replaces
// `sq`, and an answer to the old account's action must not settle the new
// account's box (sqAsk's rule).
//   o.op    the reply op fits() must see (null: the type alone -- a join, a
//           create or a kick is answered with the roster, `op:'state'`)
//   o.kind  the SOC_ERR group; o.busy the word for sq.busy
//   o.say   (m, sentence) -> the sentence to show, when a refusal says more
//   o.sink  where a refusal is said: 'aerr' (the squad's action line, the
//           default), 'ierr' (inside the invite row) or 'ferr' (under a friend
//           row);
//           o.fail (m, sentence, mine) says it somewhere else instead
//   o.done  (m, mine) on success; o.end (mine) after either answer
function sqOne(frame, o) {
  const mine = sq;
  if (mine.busy) return false;              // one action at a time, in the box and the window alike
  sqLeftSpend();                            // a new action: "You left the squad." has been read
  mine.aerr = ''; mine.ierr = ''; mine.ferr = ''; mine.fnote = ''; mine.serr = '';
  mine.busy = o.busy;
  socialTx(frame, o.type || 'squad', o.op, o.kind, (m, err) => {
    mine.busy = '';
    if (err) { const s = o.say ? o.say(m, err) : err; if (o.fail) o.fail(m, s, mine); else mine[o.sink || 'aerr'] = s; }
    else if (o.done) o.done(m, mine);
    if (o.end) o.end(mine);
    sqPaint();
  });
  sqPaint();
  return true;
}
// A START REFUSED FOR ONE MEMBER NAMES THEM, when the server points at one (`at`
// rides on member_offline, member_busy and duplicate_member -- the second row of
// the account that is on two) and the roster has a name for
// that row. The refusal arrives ahead of the roster that follows it (R6's
// order, and the countdown's), so `at` is read against the rows on screen,
// the roster the refusal counted. A row with no name is never called "No
// callsign": the sentence falls back to "a player".
// member_offline is ALSO what a live row gets while the server reads the blocks
// of a player who has just signed in (task 6), so it never says anyone left.
function sqStartSay(m, err) {
  const ms = (sq.snap && sq.snap.members) || [];
  const p = Number.isInteger(m.at) ? ms[m.at] : null, who = named(p) ? p.callsign : '';
  if (m.error === 'member_offline') return who ? who + " isn't ready to start yet." : err;
  if (m.error === 'member_busy') return who ? who + ' is still in a game or a lobby.' : err;
  if (m.error === 'duplicate_member') return who ? who + ' is in the squad twice. Remove one and try again.' : err;
  return err;
}
// READY, EVERYONE'S TOGGLE (U3; owner, 2026-10-06: the leader readies too):
// the Manage squad window's, the home ribbon's and Match setup's, one
// function. THE CLIENT CHECKS FIRST AND THE SERVER RE-CHECKS (design 4.3):
// standing down is always allowed and carries no rack; standing up needs a
// squad that could start (sqUpWhy) and a full rack for the SQUAD's mode -- the
// stored picks with any
// empty slot filled with standard weapons and saved, exactly as Start Game
// fills one (fillRack), so a short rack never refuses a Ready. -> true when a
// frame went out.
function sqReady() {
  const sn = sq.snap, me = sqMe(sn);
  if (!sqLive(sn) || !me) return false;
  const o = { op: 'ready', kind: 'squad.ready', busy: 'ready' };
  if (me.ready && !me.dropped) return sqOne({ type: 'squad', op: 'ready', ready: false }, o);
  if (sqUpWhy(sn)) return false;
  const m = modeOf(sn.mode);
  if (!isGolf(m)) fillRack(m);
  const picks = topUp(sqRack(m.id), m.draft);
  if (picks.length < m.draft) return false;
  return sqOne({ type: 'squad', op: 'ready', ready: true, loadout: picks }, o);
}
// THE LEADER'S REMOVE ASKS FIRST (C11): "Remove <name> from the squad?", with
// Cancel and Remove, in the footer. WHAT IT ASKS ABOUT IS PINNED when it opens,
// to the row's HANDLE, `rid` (D-UI-3): the server mints one per row, keeps it
// while that row stands and never gives it to another, and a kick names a row
// by it and by nothing else (server/social.js squadTarget). So the question
// follows its row wherever the roster moves it -- an earlier row leaving
// shifts it up one, a guest signing in names it -- and is withdrawn for good
// the moment that row is gone, even when another row, a guest who looks the
// same on the wire, has since taken its place. A Remove that arrives after
// that sends nothing, and says why. And a frame already on the wire when the
// row leaves lands on nobody: the server answers no_such_member.
const sqKickRow = (sn) => {
  const k = sq.kick;
  return k && sn && sn.code === k.code ? (sn.members || []).find((p) => sqRid(p) === k.rid) || null : null;
};
const sqKickLive = (sn) => !!sqKickRow(sn);
function sqKickAsk(rid) {
  const sn = sq.snap, ms = (sn && sn.members) || [];
  const i = rid ? ms.findIndex((p) => sqRid(p) === rid) : -1, p = i < 0 ? null : ms[i];
  if (!sqLive(sn) || !sqIsLead(sn, sqMe(sn)) || sq.busy || !p || i === sn.you || sqIsLead(sn, p)) return;
  sq.kick = { rid, code: sn.code };
  sq.aerr = '';
  sqPaint();
  // THE KEYBOARD GOES TO CANCEL, so a stray Enter removes nobody.
  const c = document.querySelector('#bay [data-sq="kcancel"]');
  if (c) c.focus();
}
function sqKickGo() {
  const sn = sq.snap, k = sq.kick;
  if (!k || sq.busy) return;
  if (!sqLive(sn) || !sqIsLead(sn, sqMe(sn)) || !sqKickLive(sn)) {
    sq.kick = null; sq.aerr = 'The squad changed. Check the list and try again.'; sqPaint(); return;
  }
  // The server answers the leader with the roster itself (`op:'state'`).
  sqOne({ type: 'squad', op: 'kick', rid: k.rid },
    { op: null, kind: 'squad.kick', busy: 'kick',
      done: (m, mine) => { if (m.op !== 'state') mine.aerr = socErr('squad.kick', 'unavailable'); },
      end: (mine) => { mine.kick = null; } });
}
// COPY THE LINK, NOT THE CODE (design 4.4 and 5.7): /?squad=<code> is what the
// invite push opens, so the two ways in are one URL.
function sqCopyLink() {
  const sn = sq.snap;
  if (!sn || typeof sn.code !== 'string' || !sn.code) return;
  const url = location.origin + '/?squad=' + encodeURIComponent(sn.code);
  try { navigator.clipboard.writeText(url).then(() => { if (fn('showToast')) showToast('Squad link copied.'); }, () => prompt('Your squad link:', url)); }
  catch { prompt('Your squad link:', url); }
}
// SHARE IT, where the device has a share sheet (owner, 2026-10-06: the squad
// code with Copy and Share): the same link, with the code in words for a
// friend who types it in by hand. The window offers Share only where
// navigator.share exists, as the Friends screen does; a dismissed sheet is not
// an error.
function sqShareLink() {
  const sn = sq.snap;
  if (!sn || typeof sn.code !== 'string' || !sn.code) return;
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') { sqCopyLink(); return; }
  const url = location.origin + '/?squad=' + encodeURIComponent(sn.code);
  try { const p = navigator.share({ text: 'Join my squad in Cannons and Canyons. Squad code ' + sn.code + '.', url }); if (p && p.catch) p.catch(() => {}); } catch {}
}
// D7: THE LEADER'S BOARDS ARE THE SQUAD'S MODE CONTROL. The window's squad
// footer reads the squad's mode; it never chooses it. A board tap -- and a tee
// set or seat count changed in Match setup, the only place those change -- arms
// it on this device exactly as it always has, and, when this socket holds the
// LEADER's row (sqLive, D-UI-1), puts it to the squad. A member's tap stays
// theirs: the server would answer 'not_leader' every time, so it is not sent.
// COALESCED, AND ONLY WHAT DIFFERS. Every squad op spends from one bucket of
// twenty a minute per socket (server/social.js LIMITS.squad), Ready's included,
// so a leader reading the boards a tap at a time must not spend Ready's
// allowance: the send waits until the taps stop, reads what is armed THEN, and
// goes only when the squad's own roster says something else. The answer to a
// mode is the roster the server pushes to everyone; a refusal is said on the
// squad's action line (the box's and the window's), where the window's footer
// beneath it goes on showing the squad's mode, which is the truth. An answer to a send a later one has overtaken says
// nothing: the later one's answer is the one that matters.
const SQ_MODE_MS = 250;
let sqModeT = 0, sqModeSeq = 0;
function boardMode() {
  clearTimeout(sqModeT);
  sqModeT = setTimeout(sqModeSend, SQ_MODE_MS);
}
function sqModeSend() {
  const sn = sq.snap;
  if (!sqLive(sn) || !sqIsLead(sn, sqMe(sn)) || !wsReady()) return;
  // THE SERVER'S SHAPE: tees for golf alone, and no seat count for any mode
  // (owner, 2026-10-06): the server sizes a squad's room to the squad
  // (seat-squad.js), golf's Players picker is gone, and the free-for-all's
  // count is the CPU count of a game against the computer -- sent to the squad
  // it stood every member down for nothing (U3: every change clears every
  // Ready).
  const s = state(), mode = s.mode.id;
  const tees = mode === 'golf' ? s.tees : null;
  const max = null;
  if (mode === sn.mode && tees === (sn.tees == null ? null : sn.tees) && max === (sn.max == null ? null : sn.max)) return;
  // Written to `mine`, the state that asked, as every squad answer is: an
  // account switch replaces `sq`, and the old account's refusal is not the
  // new account's to show.
  const mine = sq, seq = ++sqModeSeq;
  if (mine.aerr) { mine.aerr = ''; sqPaint(); }
  socialTx({ type: 'squad', op: 'mode', mode, tees, max }, 'squad', 'mode', 'squad.mode', (m, err) => {
    if (seq !== sqModeSeq || !err) return;
    mine.aerr = err;
    sqPaint();
  });
}
// A MEMBER'S BOARDS FOLLOW THE SQUAD'S MODE (fix wave E3). The leader's boards
// are the squad's mode control (D7), so a member's lit board and launch bar
// showed whatever that member had last tapped -- Golf lit in an FFA squad --
// and a leader's went back to Duel on the reload after every match while the
// squad stayed on its mode. So: a member's boards take the squad's mode, tee
// set and seat count whenever the SQUAD says something new (a first roster, a
// new squad, a mode the leader changed), and a leader's take them once after a
// resume -- the reload after a match -- and are otherwise the leader's own
// taps, which a roster landing before their mode frame must not undo. A
// member's tap on another board no longer arms it (U3; it did under E5): the
// leader picks the mode, and the tap is explained (sqLockWhy). Only while a
// screen that draws the armed mode is being drawn (render calls this): home,
// the Mission board, MATCH SETUP AND THE ARMOURY. Setup and the Armoury once
// kept the mode they were opened on until the player went home, and setup's
// Ready readied the member for the squad's mode all the same: Boss Fight's
// seven-weapon rack under a screen that still said Duel (update 8 review). So
// a leader's change repaints them in the squad's mode at once (the cc:squad
// listener and sqPaint), and the Armoury becomes golf's bag when golf is
// chosen. A MEMBER'S MODE THAT IS NOT THE SQUAD'S IS FOLLOWED TOO, whatever
// the key says: offline a member plays alone (sqTwoPlus), any mode, and the
// squad's is theirs again the moment the socket is. Never while the socket is
// down, which would take that offline choice away. The tee set and the
// free-for-all's count are written as setField writes them, but the tee set
// is NOT saved as this player's preference: it is the squad's. A golf squad's
// seat count is not followed: golf has none on this client any more
// (sqModeSend).
let sqFollowKey = '', sqLeadFollow = false;
const SQ_TEES = ['champ', 'mens', 'womens', 'junior'];
const SQ_FOLLOW_ON = ['home', 'modes', 'setup', 'armoury'];
function sqFollow(scr) {
  const sn = sq.snap, me = sqMe(sn);
  if (!wsReady() || !sqLive(sn) || !me || !MODES.some((x) => x.id === sn.mode)) return;
  const k = [sn.code, sn.mode, sn.tees, sn.max].join('|');
  const lead = sqIsLead(sn, me);
  if (lead && !sqLeadFollow) { sqFollowKey = k; return; }
  if (!lead && k === sqFollowKey && state().mode.id === sn.mode) return;
  if (!SQ_FOLLOW_ON.includes(scr)) return;
  sqLeadFollow = false; sqFollowKey = k;
  if (has('ccMode')) ccMode = sn.mode;
  if (sn.mode === 'golf' && SQ_TEES.includes(sn.tees) && has('ccTees')) { ccTees = sn.tees; if ($('teeSel')) $('teeSel').value = sn.tees; }
  if (sn.mode === 'ffa' && (sn.max === 3 || sn.max === 4) && has('ccMax')) { ccMax = sn.max; if ($('countSel')) $('countSel').value = String(sn.max); }
  if (fn('syncCreateRow')) syncCreateRow();
}
function sqMine(sn) {
  const ms = Array.isArray(sn.members) ? sn.members : [];
  const stale = !!sq.err;
  const lead = sqIsLead(sn, sqMe(sn));
  const ctl = { on: wsReady() && sqLive(sn), lead };
  return sqInvRow(sn)
    + '<p class="sqh">Members &middot; ' + ms.length + '/' + SQ_MAX + '</p>'
    + '<div class="sqml">' + (stale
      ? sqNote('Squad ' + esc(sn.code) + ' &middot; ' + ms.length + ' of ' + SQ_MAX + '.') + sqNote(esc(ms.map(nameOf).join(', ')))
      : ms.map((p, i) => sqRow(p, i, sn, ctl)).join(''))
    + '</div>'
    + (lead ? sqSeatsLine(sn, stale) : sqLeadNote(sn, stale))
    + sqAErr(stale ? '' : sq.aerr)
    + sqFoot(sn, ctl, stale);
}
// THE WINDOW'S FRIENDS COLUMN: every friend, online first, and the requests
// waiting on this player, as the box's old Friends tab drew them. A guest is
// offered Sign in where a dead "+ Add friend" stood.
function sqFriends() {
  if (!wsReady()) return sqNote('Needs a connection.') + sqAdd(false);
  if (acctState() !== 'in') return sqDoor() ? sqNote(SQ_SIGN_IN) + sqSignIn() : sqNote(SQ_NEED_ACCOUNT);
  const sn = snap();
  // null IS NOT EMPTY here either. The Friends screen says this in full; the
  // column has room for the short form and a Retry. NOTHING RE-ASKS BY ITSELF:
  // the read is eight round trips on the server, asked once per connection and
  // per sign-in (app.js socialBoot) and after that only by hand -- a home visit
  // is no reason to spend them again on a server that is saying no.
  if (!sn) {
    const w = socWait();
    return sqNote('Not loaded yet.') + sqErr(w.err)
      + '<div class="sqf"><button class="sbtn" data-sq="fretry"' + (w.busy ? ' disabled' : '') + '>'
      + (w.busy ? 'Loading' : 'Retry') + '</button></div>'
      + sqAdd(true);
  }
  const fs = sn.friends || [], onN = fs.filter((x) => x && x.online).length;
  const rin = (sn.requests && sn.requests.in) || [];
  // The request line keeps its node when there is nothing to say, so the
  // footer beneath it never shifts position under morphChildren.
  return sqNote('Your friends &middot; ' + fs.length)
    + sqNote(onN + ' online now.')
    + '<p class="sqn' + (rin.length ? '' : ' hidden') + '">'
    +   (rin.length ? rin.length + ' request' + (rin.length === 1 ? '' : 's') + ' waiting for an answer.' : '')
    + '</p>'
    + sqFriendRows(sn)
    + sqAdd(true);
}
// THE FRIEND ROWS (task 9; C11, design 5.1 "Friends tab states"), ONE node:
// a Requests section with Accept and a drawn Decline, then a Friends section,
// one row per friend -- the lamp, the callsign and either "In your squad" or
// Invite -- each with the player menu (design 5.5: Report and Block wherever a
// player is shown). What an action came back with is said on one line under
// the row it was pressed on.
// ONLINE FIRST (owner, 2026-10-06), the server's order kept within each half:
// the friends a player can squad up with now are the ones at the top.
// `box`: the home box's list, which is the friends who are online and
// nothing else -- no requests (the window answers those) and no section line
// of its own (the box has its heading).
const SQ_INVITED_MS = 30000;
// WHO IS "IN YOUR SQUAD": a roster row carrying this friend's account id. A
// friend whose row is still id-less while the server reads their blocks after
// a sign-in is not matched -- never by callsign -- so their Invite stays, and
// pressing it answers `already`, which is true, and is said as a note (task 6).
const sqHas = (id) => !!(sq.snap && (sq.snap.members || []).some((p) => p && p.id && p.id === id));
// WHETHER AN INVITE MAY GO FROM HERE. With a squad: a roster this socket holds
// (D-UI-1) and a seat free. With none, the Invite creates one first -- and only
// once this socket's question has been answered, since a create leaves whatever
// squad the account is in, and never while that squad is open on another tab or
// device ('elsewhere', 'open'): a create from here would pull the account out
// of it there. The server re-checks all of it.
function sqCanInvite() {
  if (!wsReady() || sq.busy || acctState() !== 'in') return false;
  const sn = sq.snap;
  if (sn) return sqLive(sn) && (sn.members || []).length < SQ_MAX;
  return sq.known && !sq.err && !sqAway();
}
// Where a friend row's Invite stands while it is not drawn (sqFriendRows). Its
// own class, not .sbtn: `.sbtn + .pmb` would space the menu for a button that
// is not there.
const SQ_INV_GAP = '<button class="sqgap hidden" tabindex="-1" aria-hidden="true" disabled></button>';
// Invited, until the next roster reaches the slot or thirty seconds pass.
const sqInvited = (id) => { const v = sq.invited.get(id); return !!(v && v.snap === sq.snap && Date.now() < v.until); };
// The line under the row an action was pressed on: red for a refusal, plain for
// what the owner asked the inviter be told.
const sqLineAt = (key) => (sq.fat !== key ? '' : sq.ferr ? sqAErr(sq.ferr) : sq.fnote ? '<p class="sqnt">' + esc(sq.fnote) + '</p>' : '');
// WHY NO INVITE IS LIVE, said in one line above the rows (review T9-R1-13): a
// title is never shown on a touch screen, and a column of dead buttons with no
// word beside them reads as a broken feature. The lasting states sqCanInvite
// refuses, in its order. Another action being out is not one of them: it is a
// moment, the control that is out says its own word, and it says nothing here.
// (No connection and not signed in never reach this: sqFriends says so in
// place of the rows.)
function sqInviteWhy() {
  const sn = sq.snap;
  if (sq.err) return 'Your squad could not be checked. Tap Retry to check again.';
  if (sn) return sn.held !== true ? SQ_OPEN : (sn.members || []).length >= SQ_MAX ? 'Your squad is full.' : '';
  if (sqAway()) return window.CC_SQUAD_END === 'open' ? SQ_OPEN : SQ_ELSEWHERE;
  return sq.known ? '' : 'Your squad has not loaded yet.';
}
function sqFriendRows(sn, box) {
  const all = (sn.friends || []).filter((p) => p && p.id);
  const fs = all.filter((p) => p.online).concat(box ? [] : all.filter((p) => !p.online));
  const rin = box ? [] : (sn.requests && sn.requests.in) || [];
  const on = wsReady() && !sq.busy, can = sqCanInvite();
  const why = !can && fs.length ? sqInviteWhy() : '';
  const full = !!(sq.snap && (sq.snap.members || []).length >= SQ_MAX);
  const req = rin.filter((p) => p && p.id).map((p) => {
    const name = nameOf(p), key = 'r:' + p.id;
    return '<div class="sqm sqfr" data-row="' + esc(key) + '"><div class="sqm1"><span class="sqmn"><span class="sqmt">' + esc(name) + '</span></span></div>'
      + '<div class="sqm2"><span class="sqms"></span><button class="sbtn" data-sq="accept:' + esc(p.id) + '"' + (on ? '' : ' disabled') + '>Accept</button>'
      + '<button class="sqic" data-sq="decline:' + esc(p.id) + '" title="Decline" aria-label="Decline ' + (named(p) ? esc(p.callsign) : 'this player') + '"' + (on ? '' : ' disabled') + '>' + IC.cross + '</button>'
      + menuBtn(p.id, 'id', name, false, !named(p)) + '</div></div>' + sqLineAt(key);
  }).join('');
  const rows = fs.map((p) => {
    const name = nameOf(p), key = 'f:' + p.id;
    const mine = sqHas(p.id);
    // THE INVITE'S PLACE IS HELD WHEN IT IS NOT DRAWN (fix wave B2), by an
    // empty, hidden button, so the menu beside it keeps its node when the row
    // flips either way (morphChildren is positional). Without it a focused menu
    // lost its node, a focused Invite became the menu, and the flip back made a
    // focused menu an Invite -- each without a word to a keyboard player.
    const act = mine ? SQ_INV_GAP
      : sqInvited(p.id) ? '<button class="sbtn" data-sq="invite:' + esc(p.id) + '" disabled>Invited</button>'
      : '<button class="sbtn" data-sq="invite:' + esc(p.id) + '"' + (full ? ' title="Your squad is full."' : '') + (can ? '' : ' disabled')
        + (why ? ' aria-describedby="sqInvWhy"' : '') + '>'
        + (sq.busy === 'invite' && sq.fat === key ? 'Inviting' : 'Invite') + '</button>';
    return '<div class="sqm sqfr" data-row="' + esc(key) + '"><div class="sqm1"><span class="pdot' + (p.online ? ' on' : '') + '" title="' + (p.online ? 'Online' : 'Offline') + '">' + IC.dot + '</span>'
      + '<span class="sqmn"><span class="sqmt">' + esc(name) + '</span></span></div>'
      + '<div class="sqm2"><span class="sqms">' + (mine ? '<span class="sqy" tabindex="-1">' + IC.tick + 'In your squad</span>' : '') + '</span>' + act
      + menuBtn(p.id, 'id', name, false, !named(p)) + '</div></div>' + sqLineAt(key);
  }).join('');
  // A line whose row has gone -- a request answered, a friend removed -- is
  // still said, at the foot of the rows, rather than lost. Gone from the
  // snapshot, not from this list: the box leaves offline friends and requests
  // out, and a line about one of those belongs under its row in the window.
  const rinAll = (sn.requests && sn.requests.in) || [];
  const orphan = sq.fat && !all.concat(rinAll).some((p) => p && ('f:' + p.id === sq.fat || 'r:' + p.id === sq.fat));
  const code = sn.friendCode ? 'FR-' + sn.friendCode : '';
  return '<div class="sqfw">'
    + (req ? '<p class="sqh">Requests &middot; ' + rin.length + '</p>' + req : '')
    + (box ? '' : '<p class="sqh">Friends &middot; ' + fs.length + '</p>')
    // Always in the tree, empty and hidden when there is nothing to say, so the
    // rows beneath it keep their places (morphChildren is positional).
    + '<p class="sqnt' + (why ? '' : ' hidden') + '" id="sqInvWhy">' + esc(why) + '</p>'
    + (rows || '<p class="sqnote">No friends yet. Share your friend code, or add a friend by theirs or by callsign.</p>'
      + (code ? '<div class="sqfc"><span>' + esc(code) + '</span><button class="sbtn" data-fr="copy">Copy</button></div>' : ''))
    + (orphan ? sqLineAt(sq.fat) : '')
    + '</div>';
}
// THE THREE THINGS THE INVITER IS TOLD (D-BLOCK-2 E, revised by the owner),
// word for word, with the friend's name from the friends list. A friend with
// no name the server can vouch for is never called "No callsign" here.
function sqSentNote(who, delivered) {
  if (delivered === 'push') return (who ? 'Invite sent to ' + who + '.' : 'Invite sent.') + " They'll get a notification.";
  if (delivered === 'none') return (who || 'That friend') + " is offline and can't be notified. Share your squad code instead.";
  return who ? 'Invite sent to ' + who + '.' : 'Invite sent.';
}
// INVITE. With no squad the Invite creates one first, and invites only once
// the squad it is for is in the slot -- the create's own answer is that roster,
// which app.js has put there before this callback runs -- and only for the
// account that asked. A refused create invites nobody.
function sqInviteFriend(id) {
  const s0 = snap(), f = s0 && (s0.friends || []).find((x) => x && x.id === id);
  if (!f || sqHas(id) || sqInvited(id) || !sqCanInvite()) return;
  const who = named(f) ? f.callsign : '', key = 'f:' + id;
  const invite = () => {
    sq.fat = key;
    sqOne({ type: 'squad', op: 'invite', to: id }, { op: 'invite', kind: 'squad.invite', busy: 'invite',
      // `already` is TRUE whenever it comes: a plain note, not a failure.
      fail: (m, s, mine) => { if (m.error === 'already') mine.fnote = s; else mine.ferr = s; },
      done: (m, mine) => {
        mine.fnote = sqSentNote(who, m.delivered);
        mine.invited.set(id, { snap: sq.snap, until: Date.now() + SQ_INVITED_MS });
        setTimeout(sqPaint, SQ_INVITED_MS + 50);
      } });
  };
  if (sq.snap) return invite();
  sq.fat = key;
  // THE CREATE CARRIES THIS DEVICE'S NAME AND PAINT, as a join does (review
  // T9-R1-1): the server builds the leader's row from this frame and nothing
  // refreshes it, so a create without them seats the leader under the one
  // callsign an empty name rolls to, in the default paint.
  sqOne({ type: 'squad', op: 'create', name: has('myName') ? myName() : '', skin: has('mySkin') ? mySkin() : '' },
    { op: null, kind: 'squad.create', busy: 'invite', sink: 'ferr',
    done: (m, mine) => {
      if (m.op !== 'state') { mine.ferr = socErr('squad.create', 'unavailable'); return; }
      mine.known = true; mine.gone = false; mine.err = '';
      if (sq !== mine || !sqLive(sq.snap)) return;
      // A NEW SQUAD STARTS ON THE LEADER'S LIT BOARD (Task 11 decision 1, fix
      // wave B3). The server builds every squad on Duel, so the board this
      // device has lit -- and its tee set and seat count -- go to the squad
      // now, BEFORE the invite, so the friend is invited to the squad as it
      // will be. sqModeSend sends only what the roster does not already say,
      // and the socket keeps order: the mode's roster lands before the
      // invite's answer. (The members' boards follow it, sqFollow.)
      sqModeSend();
      invite();
    } });
}
// ACCEPT and DECLINE, from the window: the same friend frames the Friends
// screen sends, their refusals said under the request. The server pushes the new
// friends snapshot on success, and the rows follow it.
function sqAnswer(op, id) {
  const s0 = snap(), r = s0 && ((s0.requests && s0.requests.in) || []).find((x) => x && x.id === id);
  if (!r) return;
  sq.fat = 'r:' + id;
  sqOne({ type: 'friend', op, from: id }, { type: 'friend', op, kind: 'friend.' + op, busy: 'friend', sink: 'ferr' });
}
// The foot of the window's friends column (design 5.1): it shows the friends and
// the full screen does the finding. data-go is already in the delegated
// listener's list.
const sqAdd = (on) => '<div class="sqf"><button class="sbtn" data-go="friends"' + (on ? '' : ' disabled') + '>+ Add friend</button></div>';
// THE ONE DISPATCHER for every data-sq control. `v` is `op` or `op:arg`, split
// on the FIRST colon, so an arg may carry colons of its own.
function sqAct(v) {
  const i = v.indexOf(':'), op = i < 0 ? v : v.slice(0, i), arg = i < 0 ? '' : v.slice(i + 1);
  // Retry clears the refusal AND the answer, so the box asks again rather
  // than standing on a stale `known`.
  if (op === 'retry') { sq.err = ''; sq.known = false; sqAsk(); render(current); return; }
  if (op === 'code') { sqEnter(); return; }
  // The friends list's Retry: the same read the Friends screen's Retry asks for.
  // socialResync() refuses a second while one is out, and repaints at once.
  if (op === 'fretry') { if (fn('socialResync')) socialResync(); return; }
  // TASK 9: the squad's own controls.
  if (op === 'link') { sqCopyLink(); return; }
  if (op === 'share') { sqShareLink(); return; }
  if (op === 'ready') { sqReady(); return; }
  // The server answers a leave with its own op, `left`.
  if (op === 'leave') { if (sqLive(sq.snap)) sqOne({ type: 'squad', op: 'leave' }, { op: 'left', kind: 'squad.leave', busy: 'leave' }); return; }
  if (op === 'join') { sqJoin(arg); return; }
  // The row's handle, as the render drew it: `kick:<rid>`. sqKickAsk opens a
  // question only for a row of the roster on screen that carries it.
  if (op === 'kick') { sqKickAsk(arg); return; }
  if (op === 'kcancel') { if (!sq.busy) { sq.kick = null; sqPaint(); } return; }
  if (op === 'kok') { sqKickGo(); return; }
  // The friend rows, in the box and in the window.
  if (op === 'invite') { sqInviteFriend(arg); return; }
  if (op === 'accept' || op === 'decline') { if (acctState() === 'in') sqAnswer(op, arg); return; }
  // IGNORE sends nothing: the inviter is not told (design 5.1 state 5).
  if (op === 'ignore') { if (sq.busy !== 'join') { sq.ignored = arg; sq.ierr = ''; sqPaint(); } return; }
}
// Retry is HELD, and says why, while an ask is out AND until the socket's
// hello has marked it: sqAsk refuses to ask before the hello, so a live Retry
// there was a button that did nothing when tapped. The mark asks by itself.
const sqRetry = () => {
  const wait = sq.asking || !sqIntro();
  return '<div class="sqf"><button class="sbtn" data-sq="retry"' + (wait ? ' disabled' : '') + '>'
    + (wait ? 'Loading' : 'Retry') + '</button></div>';
};
const sqSeats = () => sqNote('Duel 2 &middot; FFA 2&ndash;4 &middot; Boss 1&ndash;2 &middot; Aliens 1&ndash;2 &middot; Golf 1&ndash;4');

// THE CODE OF THE SQUAD THIS DEVICE IS IN. It is what makes "your squad has
// ended" honest -- squads are memory on the server and this is memory on the
// device, so after a deploy the device still holds a code the server has
// forgotten -- and it is where a RELOADED tab finds the code its first resume
// presents (sqHeld, below). Written from every roster the slot receives; spent
// when the server says `gone` to it.
const sqStored = () => { try { return (localStorage.getItem(SQ_KEY) || '').toUpperCase().slice(0, 8); } catch { return ''; } };
const sqStore = (c) => { try { if (c) localStorage.setItem(SQ_KEY, c); else localStorage.removeItem(SQ_KEY); } catch {} };
// THE CODE THIS TAB LAST HELD, in this tab's memory, and the only code a
// resume presents (D-UI-2; review T8-R1-1). A resume that names the squad's
// code moves the account's row onto this socket even off a LIVE one (task 5)
// -- which is how a tab takes its row back from a dead socket a proxy is still
// holding open -- and localStorage is shared by every tab on the device, so a
// code read from it may be one ANOTHER tab joined: presented by a tab that
// never held it, a reconnect takes the squad from the tab in use.
//   null  -- this tab has not asked yet. Its FIRST ask reads the stored code:
//            that is a reload, or a reopen, of the tab that stored it.
//   ''    -- this tab holds nothing it knows of, and every ask is bare.
//   code  -- a roster reached the slot, which app.js writes only when this
//            socket holds the row (D-UI-1); a join by code lands that way too.
//            Any end, a `gone`, and leaving the account clear it.
let sqHeld = null;
// A GUEST ROW'S RESUME SECRET (fix wave E1; W1's frame contract). A guest's
// squad row is keyed to the socket it joined on, and every way out of a match
// reloads the page, so a guest fell out of their squad after every squad match.
// The server now sends a guest row's own socket a secret, `gk`, on every state
// frame, and a resume presenting { code, gk } puts that row on the new socket.
// This is the tab's copy: `{ code, gk }` of the guest row this tab holds, or
// null. Replaced by every roster that carries one, spent by a roster this
// socket holds that carries none (the row became an account's at sign-in), by
// any end but `open` (which moves no row), and by `gone`.
// PER TAB, AND NEVER COPIED: sessionStorage is copied into a DUPLICATED tab,
// and a duplicate presenting the secret would take the row from the tab in
// use. So it lives in memory, and is written to sessionStorage only as the page
// goes -- a reload, Back to menu -- or is hidden, and read back and deleted the
// moment the next page boots (sqCarry, below): a tab duplicated while in front
// of the player copies nothing.
const SQ_GK_KEY = 'cc_squad_gk';
const SQ_GK = /^[0-9a-f]{32}$/;
const SQ_CODE = /^[A-Z0-9]{1,8}$/;
let sqGk = null;
// AN INVITE A RELOAD CARRIED (fix wave E2): the one the box would have shown, with the account it was sent to, until this page's account is known
// (the cc:account listener hands it back to app.js, or drops it).
const SQ_INV_KEY = 'cc_squad_invite';
let sqInvCarry = null;
try {
  const g = JSON.parse(sessionStorage.getItem(SQ_GK_KEY) || 'null');
  if (g && typeof g.code === 'string' && SQ_CODE.test(g.code) && typeof g.gk === 'string' && SQ_GK.test(g.gk)) sqGk = { code: g.code, gk: g.gk };
  const c = JSON.parse(sessionStorage.getItem(SQ_INV_KEY) || 'null');
  if (c && typeof c === 'object' && typeof c.acct === 'string' && c.acct) sqInvCarry = c;
} catch {}
try { sessionStorage.removeItem(SQ_GK_KEY); sessionStorage.removeItem(SQ_INV_KEY); } catch {}
const sqGkOf = () => sqGk;
// Written as the page goes or is hidden, deleted as it comes back: in storage
// only while nobody can be looking at this tab.
function sqCarry(going) {
  try {
    if (going && sqGk) sessionStorage.setItem(SQ_GK_KEY, JSON.stringify(sqGk));
    else sessionStorage.removeItem(SQ_GK_KEY);
    const a = window.CC_ACCOUNT, inv = going && acctState() === 'in' && a && a.id ? sqInvOf(sq.snap) : null;
    if (inv) sessionStorage.setItem(SQ_INV_KEY, JSON.stringify({ code: inv.code, from: inv.from, size: inv.size, max: inv.max, at: inv.at, acct: a.id }));
    else sessionStorage.removeItem(SQ_INV_KEY);
  } catch {}
}
window.addEventListener('pagehide', () => sqCarry(true));
window.addEventListener('pageshow', () => sqCarry(false));
document.addEventListener('visibilitychange', () => sqCarry(document.hidden));
// Whether the page's first account event has passed (see the cc:account
// listener at the foot of this file).
let sqAcctSeen = false;
function sqReset() { sq = sqFresh(); }
// Match setup too: its Your squad is live only in a squad of two or more
// (sqTwoPlus), so it follows the squad while the screen is up. And the Manage
// squad window, which draws the same state as the box.
function sqPaint() {
  const host = $('bay');
  if (host && host.classList.contains('active') && (current === 'home' || current === 'setup' || current === 'squad')) render(current);
}
// ASKED ONCE PER INTRODUCTION, THEN LEFT ALONE. sqNeed() is idempotent: it asks
// only if nothing has been asked under this socket's introduction (app.js's
// socialIntro) -- answered, refused or in flight. A refusal is Retry's to
// clear, exactly as frNeed() leaves the friends frame alone: without that,
// every presence push would re-ask a server that is already saying no, which
// is how the old recent-match loader came to pour one error row per player per home visit
// into the live database. A NEW introduction -- a reconnect, or a sign-in's
// hello -- asks again, whatever the screen: a member whose socket blipped
// mid-match is dropped, and removed a minute later unless this socket resumes
// (task 5).
const sqIntro = () => (fn('socialIntro') ? socialIntro() : 0);
function sqNeed() {
  const n = sqIntro();
  if (n && sq.via !== n) sqAsk();
}
function sqAsk(bare, back) {
  // NOTHING IS ASKED BEFORE THE HELLO, by any path: a resume that overtakes it
  // is answered for nobody (see socialIntro). And gated BEFORE socialTx, not
  // after: socialTx calls its callback SYNCHRONOUSLY when the socket is down,
  // and a busy flag set after the call would latch on for ever. A guest's squad
  // is keyed to the socket it joined on, so a guest asks only about a squad
  // this tab is holding. AN ASK OUT UNDER AN OLDER INTRODUCTION HOLDS NOTHING
  // UP (review T8-R1-3): its socket may have died under it -- socialSend keeps
  // the waiter until its twelve-second timeout -- or it went out under the
  // identity a sign-in's hello has since replaced. Only an ask out under THIS
  // introduction does.
  // A GUEST ASKS about a squad on screen, or one this tab holds the resume
  // secret of (sqGk, fix wave E1): the reload after a match left no squad on
  // screen, and the secret is how the row comes back.
  const n = sqIntro();
  if (!n || !wsReady() || (sq.asking && sq.via === n) || (acctState() !== 'in' && !sq.snap && !sqGk)) return;
  if (sqHeld === null) sqHeld = sqStored();    // the tab's first ask: a reload, or a reopen
  // `had`: a squad this answer can take away -- a presented code, a squad on
  // screen, a squad this tab gave up to another tab or device (`elsewhere`: it
  // held one, and its bare question presents no code) or was shown open there
  // (`open`: the player has seen that the account has one), or, for a
  // return's second question, the "has ended" line itself.
  // A GUEST ROW'S SECRET GOES WITH ITS OWN CODE (E1): it is this tab's by
  // construction, so it is presented on every ask that is not bare. The server
  // answers a socket that already holds a row, or an account that has one,
  // its own squad as before, and the secret then moves nothing.
  const gk = bare ? null : sqGk;
  const mine = sq, code = gk ? gk.code : bare ? '' : sqHeld,
    had = !!code || !!sq.snap || sqAway() || (!!back && sq.gone);
  mine.asking = true; mine.again = false; mine.via = n;
  // Every write below goes to `mine`, the state that asked: an account switch
  // replaces `sq` (sqReset), and an answer to the old account's question must
  // not settle the new account's.
  socialTx(gk ? { type: 'squad', op: 'resume', code, gk: gk.gk } : code ? { type: 'squad', op: 'resume', code } : { type: 'squad', op: 'resume' },
    'squad', null, 'squad.resume', (m, msg) => {
      // A LATER ASK ON THIS STATE OWNS IT, and this answer is dropped whole: it
      // is about a socket or an identity that ask replaced. A dead socket's
      // twelve-second timeout ('unavailable') is not this box's to say.
      if (mine.via !== n) return;
      mine.asking = false;
      if (m.error) mine.err = msg;
      // A RESUME'S ROSTER PUTS THE SQUAD'S MODE ON A LEADER'S BOARDS, once
      // (sqFollow, fix wave E3): the reload after a match left them on Duel.
      else if (m.op === 'state') { mine.known = true; mine.gone = false; mine.err = ''; sqLeadFollow = true; }
      else if (m.op === 'gone') {
        // Once per introduction: a return's own `gone` arms no further return.
        // The squad is gone for this tab too. (An answer to an old account's
        // question comes before any to the new one's -- one socket, in order
        // -- so this never clears a code the new account's roster wrote.)
        mine.known = true; mine.err = ''; mine.gone = had; mine.again = !back;
        if (code) sqStore('');
        sqHeld = '';
        // A secret answered `gone` is spent: wrong, expired, or its row swept.
        if (gk && sqGk === gk) sqGk = null;
      }
      // fits() proves the TYPE; the op is ours to prove, and an op from a
      // newer server is not an empty squad.
      else mine.err = socErr('squad.resume', 'unavailable');
      sqPaint();
      // A BELT, NOT A PATH: a hello that lands while this ask is out now asks
      // for itself (the gate above). This asks only about an introduction
      // whose own ask was refused and that nothing has asked about since.
      sqNeed();
    });
}
// THE ONE CODE FIELD (D8), in the window now, and FOR SQUADS ONLY (owner,
// 2026-10-06: friend games are squads, and game codes are retired). It still
// asks the server which namespace the code is in -- squad codes and room codes
// share one alphabet -- and joins only a squad: a room's code is said to be a
// game's, and joins nothing. The code frame is answered from memory even when
// the social layer is off, so the field can say which kind a code is during a
// database outage; only the squad join needs the social layer.
//
// ONE CODE AT A TIME (review T8-R1-10). Two presses before the server has
// answered -- a double tap, the button and then the Go key -- would each send a
// code frame and, for a squad code, a join. So `cbusy` is set BEFORE the first
// socialTx (which answers synchronously when the socket is down: set after, it
// would latch on for good), a press while it is set does nothing, the Join
// button is held meanwhile, and EVERY settle frees it: the code frame's
// refusal, a game's code, kind 'none' and the squad join's answer either way.
// Task 8's Enter key already ignores autorepeat; this covers distinct presses.
function sqEnter() {
  const mine = sq;                             // as in sqAsk: answers settle the state that asked
  if (mine.cbusy) return;
  sqLeftSpend();                               // a new action: "You left the squad." has been read
  const el = $('sqCode');
  const code = ((el && el.value) || '').trim().toUpperCase();
  mine.cerr = '';
  if (code.length !== 4) { mine.cerr = 'Enter the 4-letter code.'; sqPaint(); return; }
  mine.cbusy = true;
  sqPaint();
  socialTx({ type: 'code', code }, 'code', null, 'code', (m, msg) => {
    if (m.error) { mine.cbusy = false; mine.cerr = msg; sqPaint(); return; }
    if (m.kind === 'squad') {
      // The CURRENT callsign rides the join: a squad seat's name is whatever
      // this frame carried, and Start hands it to the engine (task 4).
      socialTx({ type: 'squad', op: 'join', code, name: has('myName') ? myName() : '', skin: has('mySkin') ? mySkin() : '' },
        'squad', null, 'squad.join', (r, rmsg) => {
          mine.cbusy = false;
          if (r.error) mine.cerr = rmsg;
          // The roster itself has already reached the slot (app.js answers
          // the roster first), and so has this tab's record of its code
          // (sqHeld), so its reconnects carry the code; this settles the
          // box's own state.
          else if (r.op === 'state') { mine.known = true; mine.gone = false; mine.err = ''; }
          sqPaint();
        });
      return;
    }
    mine.cbusy = false;
    mine.cerr = m.kind === 'room' ? SQ_GAME : SQ_NONE;
    sqPaint();
  });
}
// The one code field (D8). It is a bare INPUT with no `value` attribute on
// purpose: morphNode syncs attributes and then returns for INPUT, so `disabled`
// tracks the state while the typed value stays the player's.
function sqCodeRow(on) {
  return '<div class="sqcr">'
    + '<input id="sqCode" class="sqin" maxlength="4" placeholder="CODE" autocomplete="off"'
    +   ' autocapitalize="characters" spellcheck="false" enterkeyhint="go"'
    +   ' aria-label="Squad code"' + (on ? '' : ' disabled') + '>'
    + '<button class="sbtn" data-sq="code"' + (on && !sq.cbusy ? '' : ' disabled') + '>Join</button></div>'
    + sqErr(on ? sq.cerr : '');
}
// THE WINDOW'S FIRST COLUMN: join a squad by its code -- which a guest can do
// (D11) -- and this squad's own code, with Copy (the link, design 4.4) and,
// where the device has a share sheet, Share. The field is the column's SECOND
// node, under a heading that never changes, in every state: what the player
// has typed survives every repaint (morphChildren is positional).
function sqCodeCol() {
  const on = wsReady(), sn = sq.snap;
  const code = sn && typeof sn.code === 'string' && SQ_CODE.test(sn.code) ? sn.code : '';
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const live = on && !!code;
  return '<p class="sqh">Join a squad</p>'
    + sqCodeRow(on)
    + sqNote(on ? 'Enter the 4-letter code a friend gives you.' : 'The code field comes back when the connection does.')
    + '<div class="fsec"></div>'
    + '<p class="sqh">Your squad code</p>'
    + '<div class="frcode sqcd">' + (code ? esc(code) : '&mdash;') + '</div>'
    + '<div class="frow"><button class="ghost" data-sq="link"' + (live ? '' : ' disabled') + '>' + IC.copy + 'Copy</button>'
    +   (canShare ? '<button class="ghost" data-sq="share"' + (live ? '' : ' disabled') + '>' + IC.share + 'Share</button>' : '') + '</div>'
    // With no squad, what gives one a code: a signed-in player's Invite
    // creates the squad; a guest invites nobody, and joins one instead.
    + sqNote(code ? 'Copy gives a link that opens the game and joins your squad.'
      : acctState() === 'in' ? 'Your squad gets its code when you invite a friend.' : 'A squad you join shows its code here.');
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
    // ONE CONSENT, TWO PURPOSES (fix wave E6): the same subscription carries a
    // friend's squad invite to a player who is away, so the row says both.
    ['notify',   'Nudges',         notifyHidden ? 'Not available on this build yet' : 'Your turn, and squad invites from friends', notifyOn, notifyHidden],
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
    // TWICE THE RULE, BECAUSE THE TWO COUNT DIFFERENT THINGS. server/callsign.js
    // measures a name in CODE POINTS ([...name].length, 3 to 16); HTML maxlength
    // counts UTF-16 code UNITS. They agree for every BMP script, including the
    // combining marks BINDING resolution 21 admits, and disagree by half for a
    // non-BMP letter -- a CJK Extension B ideograph, Gothic, Deseret -- where the
    // field stopped at 8 characters under a rules line promising 16, with no
    // error and nothing to act on. Doubling is exact: 16 code points can never
    // exceed 32 units. It stays a cap against a paste bomb; the server is still
    // the only validator, and it answers 'length' for anything longer.
    const max = (has('CALLSIGN_MAX') ? CALLSIGN_MAX : 16) * 2;
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
// ONE ERROR SINK PER COLUMN, because the screen has three and a red sentence
// must appear next to the card that was tapped. `ferr` and `cerr` belong to the
// two boxes in column 1 (Find a friend, Add by friend code); `perr` to the
// friends and requests column; `berr` to the blocked column. They were a single
// `ferr` until this pass, so a failed Accept in column 2 and a failed Unblock in
// column 3 both wrote into the search box two columns away — and as a GUEST,
// who is never shown column 1, a failed Unblock rendered nowhere at all and the
// button was simply dead.
let fr = { q: '', code: '', res: null, ferr: '', cerr: '', perr: '', berr: '' };
// A GUEST'S OWN BLOCKED LIST. They are refused the friends frame, so this is
// the one read they get. null = not known yet, exactly like CC_SOCIAL.
let gb = { list: null, err: '', asking: false };
// AND THE ONE NUMBER OUT OF IT THAT LEAVES THIS FILE. app.js's exportMyData()
// builds blocked_count from CC_SOCIAL, which a guest never receives, so a guest
// looking straight at their own blocked list exported a null and a sentence
// telling them the device had not loaded it. Parked on window in the same style
// as CC_SOCIAL_ASKING, declared by app.js, written only here, read only there.
// Called wherever gb.list moves, so null always means NOT LOADED.
const gbPublish = () => { window.CC_SOCIAL_BLOCKED = gb.list ? gb.list.length : null; };
// WHOSE list, sheet and error sentences the state above belongs to. The ACCOUNT
// ID, because the account this screen's guest half serves is anonymous and
// app.js's accountKey() — built from an email and a provider list — is '' for
// every guest alike. The kind is folded in as well, so a guest who LINKS their
// account counts as a change and the screen re-reads as a linked one.
let bayAccount = '';
const bayAccountKey = () => {
  const a = window.CC_ACCOUNT;
  return a && a.id ? (a.anonymous === false ? 'in:' : 'guest:') + a.id : '';
};
let pm = null;      // the open player menu:  { key, kind:'id'|'handle', name, anon, err, busy }
let pa = null;      // the confirm sheet:     { act:'report'|'block', key, kind, name, anon, err, busy }
let pmEl = null;    // the overlay node
let pmFrom = null;  // the control that opened it, to hand the keyboard back to
let pmLayer = '';   // which layer is on screen, so focus moves once per change

const snap = () => (has('CC_SOCIAL') ? G.CC_SOCIAL : null) || null;
const acctState = () => (($('accountBtn') && $('accountBtn').dataset.state) || 'out');
// Nothing is sent while the socket is the in-page offline stand-in: room-engine
// carries no social code (it is the module the offline page imports), so the
// frame would vanish and the screen would wait for an answer that cannot come.
const wsReady = () => !!(G.S && S.connected && !S.local && S.ws && S.ws.readyState === 1);
// WHY THE SNAPSHOT IS STILL MISSING, which `snap() === null` cannot say on its
// own. app.js owns both fields and dispatches `cc:social` on every write; read
// straight off window, the way CC_ACCOUNT is read above, because a name app.js
// only ever assigns to window has no declaration for G's typeof getters to see.
const socWait = () => ({
  busy: !!window.CC_SOCIAL_ASKING,
  err: window.CC_SOCIAL_ERR ? socErr('friends', window.CC_SOCIAL_ERR) : '',
});

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
  // THE READ MODEL ITSELF. `{type:'friends', error:…}` is the refusal EVERY
  // linked player meets on every visit until the phase 6 migration is applied,
  // because the live server answers 'unavailable' today — so this group is not
  // an edge case, it is the shipped state. Task 7's wording discipline holds:
  // an error sentence must not blame the player's connection for a fault on the
  // server, which is why 'unavailable' falls to `friends._` and not to the
  // 'offline' line.
  'friends.slow_down':           'Too many tries. Wait a moment.',
  'friends.sign_in':             'Sign in to see your friends.',
  'friends.offline':             'Not connected. Try again in a moment.',
  'friends._':                   'Friends are not available right now. Try again later.',
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
  'friend.withdraw.no_such_request': 'That request is already gone.',
  'friend.withdraw.offline':     'Not connected. Try again in a moment.',
  'friend.withdraw._':           'Friends are not available right now. Try again later.',
  'friend.remove.no_such_user':  'They are not on your friends list.',
  'friend.remove.offline':       'Not connected. Try again in a moment.',
  'friend.remove._':             'Friends are not available right now. Try again later.',
  'block.self':                  'You cannot block yourself.',
  'block.no_such_user':          'That player is no longer here.',
  'block.sign_in':               'Sign in to report or block a player.',
  'block.offline':               'Not connected. Try again in a moment.',
  'block._':                     'Blocking is not available right now. Try again later.',
  // UNBLOCK IS ITS OWN ACT, AND IT HAD NO GROUP. `block` was passed as the kind
  // for op:'remove', so every failure fell through to 'block._' and a player who
  // had just tapped Unblock was told "Blocking is not available right now" --
  // the game appearing to refuse to UNDO a block, in the exact window (no phase
  // 6 migration, the table 404s) where it is what every player sees. And
  // 'block.no_such_user' told them the player was "no longer here" about a row
  // sitting on their own blocked list.
  'block.remove.no_such_user':   'They are not on your blocked list.',
  'block.remove.sign_in':        'Sign in to see who you have blocked.',
  'block.remove.offline':        'Not connected. Try again in a moment.',
  'block.remove._':              'Unblocking is not available right now. Try again later.',
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
  // SQUADS. A group per OP, because `block` and `block.remove` sharing one
  // group produced a real bug (Unblock said "Blocking is not available right
  // now"). 'offline' means THIS client's socket is down and nothing else; a
  // timeout with a live socket comes back as 'unavailable', which is the
  // server's fault and must not be blamed on the player's connection.
  'squad.resume.slow_down':      'Too many tries. Wait a moment.',
  'squad.resume.offline':        'Not connected. Try again in a moment.',
  'squad.resume._':              'Squads are not available right now. Try again later.',
  // A refused join reads EXACTLY as an unknown code does (D-BLOCK-2 A): the
  // server refuses a join a block forbids as `no_such_squad`, and no key here
  // may name a block. `already_in` is always true: another device of this
  // account stands in that squad.
  'squad.join.no_such_squad':    SQ_NONE,
  'squad.join.full':             'That squad is full.',
  'squad.join.already_in':       'You are already in that squad on another device.',
  'squad.join.slow_down':        'Too many tries. Wait a moment.',
  'squad.join.offline':          'Not connected. Try again in a moment.',
  'squad.join._':                'That squad could not be joined right now. Try again later.',
  'code.offline':                'Not connected. Try again in a moment.',
  'code._':                      'That code could not be checked right now. Try again later.',
  // THE SQUAD'S OWN ACTIONS (task 9), keyed on the codes server/social.js
  // really sends (squadReady, squadLeave, squadStart), each op with its own
  // `_`: "not available" is a different next move for a Ready than for a
  // Start. No sentence blames the player's connection for a server-side cause,
  // and none names a block (D-BLOCK-2 A). sqStartSay names the member behind a
  // member_offline or member_busy when the server points at one.
  'squad.ready.no_squad':        'Your squad has ended.',
  'squad.ready.no_rack':         'Your rack does not suit this mode. Check your weapons and try again.',
  // The server holds this player's row as DROPPED (squads.js setReady): the
  // socket that asks is not yet the one on the row, and its resume will be.
  'squad.ready.dropped':         'You are reconnecting to the squad. Try again in a moment.',
  'squad.ready.slow_down':       'Too many tries. Wait a moment.',
  'squad.ready.offline':         'Not connected. Try again in a moment.',
  'squad.ready._':               'Squads are not available right now. Try again later.',
  'squad.leave.slow_down':       'Too many tries. Wait a moment.',
  'squad.leave.offline':         'Not connected. Try again in a moment.',
  'squad.leave._':               'Squads are not available right now. Try again later.',
  'squad.start.no_squad':        'Your squad has ended.',
  'squad.start.not_leader':      'Only the squad leader can start.',
  // Also what a leader's reloaded tab met before its resume moved the row
  // (task 4, then task 5), so it does not say "use your other device" alone.
  'squad.start.wrong_device':    'Start from the device you joined the squad on, or rejoin the squad on this one.',
  'squad.start.no_rack':         'Your rack does not suit this mode. Check your weapons and try again.',
  'squad.start.wont_fit':        "Your squad does not fit this mode's seats.",
  // ONE ACCOUNT ON TWO ROWS (squadStart's guard). sqStartSay names the row the
  // server points at; without a name it says what the leader can see and do.
  'squad.start.duplicate_member': 'One player is in the squad twice. Remove one and try again.',
  'squad.start.not_ready':       'Not everyone in the squad is ready yet.',
  'squad.start.member_offline':  "A player isn't ready to start yet.",
  'squad.start.member_busy':     'Someone in the squad is still in a game or a lobby.',
  'squad.start.capacity':        'The server is at capacity. Try again shortly.',
  'squad.start.slow_down':       'Too many tries. Wait a moment.',
  'squad.start.offline':         'Not connected. Try again in a moment.',
  'squad.start._':               'That match could not be started. Try again.',
  // The leader's Remove (squadKick). sign_in comes from the per-op sign-in
  // gate, which answers {type:'social'}: a guest can never lead.
  'squad.kick.not_leader':       'Only the squad leader can remove a player.',
  'squad.kick.no_such_member':   'That player is no longer in your squad.',
  'squad.kick.sign_in':          'Sign in to manage your squad.',
  'squad.kick.slow_down':        'Too many tries. Wait a moment.',
  'squad.kick.offline':          'Not connected. Try again in a moment.',
  'squad.kick._':                'Squads are not available right now. Try again later.',
  // Invite (squadInvite) and the create an Invite makes when there is no squad
  // (squadCreate). not_friend is also every miss the server will not tell
  // apart -- blocked either way, a guest, no such account -- and says only what
  // the inviter can see. `already` is TRUE whenever it comes and is shown as a
  // note, not a failure (task 6).
  'squad.invite.not_friend':     'You can only invite friends.',
  'squad.invite.full':           'Your squad is full.',
  'squad.invite.already':        'They are already in your squad.',
  'squad.invite.no_squad':       'Your squad has ended.',
  'squad.invite.slow_down':      'Too many tries. Wait a moment.',
  'squad.invite.sign_in':        'Sign in to invite friends.',
  'squad.invite.offline':        'Not connected. Try again in a moment.',
  'squad.invite._':              'That invite could not be sent. Try again later.',
  'squad.create.sign_in':        'Sign in to invite friends.',
  'squad.create.slow_down':      'Too many tries. Wait a moment.',
  'squad.create.offline':        'Not connected. Try again in a moment.',
  'squad.create._':              'A squad could not be started right now. Try again later.',
  // A LEADER'S BOARD TAP (D7). bad_max is a seat count the server will not
  // take -- a client bug far more than anything the player did -- so its
  // sentence blames nobody.
  'squad.mode.not_leader':       'Only the squad leader can pick the mode.',
  'squad.mode.no_squad':         'Your squad has ended.',
  'squad.mode.bad_max':          'That seat count could not be set for the squad. Try again.',
  'squad.mode.slow_down':        'Too many tries. Wait a moment.',
  'squad.mode.offline':          'Not connected. Try again in a moment.',
  'squad.mode._':                'The squad could not change modes right now. Try again.',
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
const named = (p) => !!(p && typeof p.callsign === 'string' && p.callsign);
const nameOf = (p) => (named(p) ? p.callsign : 'No callsign');
// THE MENU BUTTON. `key` is either an account uuid the SERVER handed this
// client (a friends list, a search result, a blocked list) or a per-room seat
// HANDLE (a lobby payload, an in-match snapshot). They are different fields on
// the wire and are never interchangeable — BINDING resolution 24, and
// task 6b section 2. Nothing here logs or stores either one.
// `anon` marks a card whose name is the PLACEHOLDER, not a name — nameOf()'s
// 'No callsign' fallback, which server/social.js really does produce (its
// displayName returns null for an unprovable name and for one blocklisted after
// it was stored, which is exactly the case a report exists for). The confirm
// sheet needs to know, because "Report the callsign No callsign" is nonsense.
// It is a separate attribute rather than a test on the text, because a player
// may legitimately CHOOSE the callsign "No callsign".
const menuBtn = (key, kind, name, dis, anon) =>
  '<button class="pmb" data-pmenu="' + esc(key) + '" data-pmkind="' + kind + '" data-pmname="' + esc(name)
  + '"' + (anon ? ' data-pmanon="1"' : '') + ' aria-label="More for ' + esc(name) + '"' + (dis ? ' disabled' : '') + '>' + IC.more + '</button>';
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
    + (opt.menu === false ? '' : menuBtn(p.id, 'id', name, false, !named(p)))
    + '</div>';
}

/* ---- the player menu and the two confirm sheets -------------------------- */
// AN #app-LEVEL LAYER, not part of any screen's markup. The menu has to open in
// four places and only two of them are Bay screens: the friends list and a
// search result are, a LOBBY SEAT is, and an IN-MATCH CARD is not — #bay is not
// even on stage during a battle. One layer serves all four, so there is one
// implementation of Report, Block and their confirmations.
//
// IT HANGS OFF #app, NOT <body>, and the reason is the toast. #app is
// position:fixed, which makes it a stacking context, so #toast (z 90, inside
// #app) and this sheet (z 80) can only be compared if they share one parent
// context; on <body> this sheet won the paint at ANY z-index the toast was
// given, and a confirmation would have been hidden behind the sheet that asked
// for it. Measured in Chrome, not assumed. #app is fixed inset:0, the same box
// as the viewport, so position:fixed inset:0 here renders identically.
function pmHost() {
  if (!pmEl) {
    pmEl = document.createElement('div');
    pmEl.id = 'pmenu';
    pmEl.hidden = true;
    ($('app') || document.body).appendChild(pmEl);
    pmEl.addEventListener('click', pmClick);
  }
  return pmEl;
}
function pmOpen(key, kind, name, anon) {
  if (has('Audio')) Audio.ensure();
  // WHERE THE KEYBOARD CAME FROM, so it can be sent back. A sheet that takes
  // focus and drops it on the floor leaves a keyboard player at the top of the
  // document, hunting for the card they were on.
  pmFrom = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;
  pm = { key, kind: kind === 'handle' ? 'handle' : 'id', name: name || '', anon: !!anon, err: '', busy: '' };
  pa = null;
  pmPaint();
}
function pmClose() {
  if (!pm && !pa) return;
  pm = null; pa = null; pmPaint();
  const back = pmFrom; pmFrom = null;
  // Only if it is still on the page: the list underneath is re-rendered wholesale
  // on every repaint, so the card that opened this may no longer exist.
  if (back && back.isConnected && typeof back.focus === 'function') back.focus();
}
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
// TWO CHANGES OF COPY IN THIS PASS, both narrowing a claim to what is true:
//   * "Every report is read." was a MODERATION COMMITMENT the owner has never
//     signed off, on a path whose only destination today is a log line and a
//     table row. The sheet now says where a report goes and nothing about what
//     happens next; the response interval belongs to the privacy policy, where
//     Task 9 states it, and no number is invented here.
//   * "Report the callsign No callsign to Abara Brothers." — nameOf()'s
//     placeholder read as the name itself. With no name to quote, the sentence
//     names the act instead. Same for Block, which had the same sentence.
function pmAsk() {
  const rep = pa.act === 'report';
  const who = pa.anon ? 'this player' : 'the callsign ' + esc(pa.name);
  return '<div class="pmw" data-pmstop><div class="pmh">' + (rep ? 'Report this name' : 'Block this player') + '</div>'
    + '<p class="pmn">' + (rep
      ? 'Report ' + who + '. Reports go to Abara Brothers.'
      : 'Block ' + (pa.anon ? 'this player' : esc(pa.name)) + '. They will not be able to find you or contact you, and any friendship or request between you is removed. You may still be matched into a battle together. You can undo this in Friends.')
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
  // innerHTML DESTROYS THE FOCUSED NODE, so a repaint for a busy state, an error
  // or a presence push would drop a keyboard player back to the top of the
  // document mid-action. Remember whether the keyboard was in here first.
  const had = !!(document.activeElement && el.contains(document.activeElement));
  const layer = pa ? 'ask:' + pa.act : pm ? 'menu' : '';
  if (!html) { pmLayer = ''; el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = html;
  el.hidden = false;
  // Focus moves in when the LAYER changes — the menu opening, the confirm sheet
  // replacing it — and is restored when a repaint has just taken it away. Never
  // on an ordinary repaint, or a friend coming online would pull the keyboard
  // off whatever the player was on. The first button is Report name on the menu
  // and CANCEL on either confirm sheet, so a stray Enter cannot send anything.
  if (layer !== pmLayer || had) {
    const f = el.querySelector('.pmw button:not([disabled])');
    if (f) f.focus();
  }
  pmLayer = layer;
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
    pa = { act: a, key: pm.key, kind: pm.kind, name: pm.name, anon: pm.anon, err: '', busy: '' };
    pmPaint(); return;
  }
  if (a === 'ok') {
    if (!pa || pa.busy) return;
    const rep = pa.act === 'report', kind = rep ? 'report' : 'block';
    const frame = rep ? { type: 'report', ...pmAim(pa) } : { type: 'block', op: 'add', ...pmAim(pa) };
    pa.busy = kind;
    // THE SHEET THIS WAS SENT FROM, BY IDENTITY. `if (!pa)` only asked whether
    // SOME sheet is open: cancel a slow Report, open a Block on another card,
    // and the report's answer closed that sheet and raised "Reported. Thank
    // you." over an action the player had abandoned -- or wrote the report's red
    // sentence into it. pa is replaced wholesale by the branch above and by
    // pmOpen, so the object is the only thing that identifies the request.
    // submitCallsign already keeps this discipline with csSeq.
    const mine = pa;
    socialTx(frame, rep ? 'report' : 'block', rep ? '' : 'add', kind, (m, err) => {
      if (pa !== mine) return;
      pa.busy = '';
      if (err) { pa.err = err; pmPaint(); return; }
      // pmClose(), not a hand-cleared pm/pa: a sent report is a CLOSE like any
      // other, and the keyboard goes back to the card it was sent from. Remove
      // friend below already did this; this path did not.
      pmClose();
      if (fn('showToast')) showToast(rep ? 'Reported. Thank you.' : 'Blocked.');
      if (!rep) gbRefresh();
    });
    pmPaint(); return;
  }
  if (a === 'unfriend') {
    if (!pm || pm.kind !== 'id' || pm.busy) return;
    const who = pm.key;
    pm.busy = 'unfriend'; pm.err = '';
    // The same identity check: a backdrop tap and a second menu leave `pm`
    // truthy and pointing at a different player.
    const mine = pm;
    socialTx({ type: 'friend', op: 'remove', id: who }, 'friend', 'remove', 'friend.remove', (m, err) => {
      if (pm !== mine) return;
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
// A red line for one column's own failure, or nothing at all. Rendered only
// when there IS one: `.ferr` reserves 13u of height, and reserving it in every
// section would cost four lines of air the 430u frame does not have.
const errLine = (s) => (s ? '<p class="ferr">' + esc(s) + '</p>' : '');
// THE THIRD STATE, SAID IN FULL: what is not known, WHY it is not known, and
// what will be done about it. "Not loaded yet." on its own was all five states
// at once — in flight, refused, refused again, rate-limited, and timed out —
// and a Retry button that never changed by a pixel on any tap. `w` is the pair
// app.js records (socWait), or the guest's own { busy, err } for their blocked
// list, which is a different read with a different answer.
function frWait(on, w) {
  const busy = !!(w && w.busy), err = (w && w.err) || '';
  return '<p class="fnote">Not loaded yet.</p>' + errLine(err)
    + '<div class="frow"><button class="sbtn" data-fr="retry"' + (on && !busy ? '' : ' disabled') + '>'
    + (busy ? 'Loading' : 'Retry') + '</button></div>';
}
function frPeople(sn, on) {
  // No count, no "no friends yet" — this client has no evidence either way, and
  // saying so is the only honest thing left.
  if (!sn) return '<span class="lbl">Your friends</span>' + frWait(on, socWait()) + errLine(fr.perr);
  const rin = (sn.requests && sn.requests.in) || [], rout = (sn.requests && sn.requests.out) || [];
  const friends = sn.friends || [];
  const reqRows = rin.map((p) => pcard(p, { dot: false, dis: !on,
    act: '<button class="sbtn" data-fr="acc:' + esc(p.id) + '"' + (on ? '' : ' disabled') + '>Accept</button>'
       + '<button class="sbtn" data-fr="dec:' + esc(p.id) + '"' + (on ? '' : ' disabled') + '>Ignore</button>' })).join('');
  // A REQUEST THE PLAYER SENT CAN BE CANCELLED (op 'withdraw'), one row each
  // under the line that counts them. It is the hand twin of a block that
  // takes the blocker's own request (D-BLOCK-5 J): without it, a request
  // vanishing from the other player's panel could only mean a block. The row
  // leaves when the server pushes the panel without it, as an answered
  // request does, so the tap needs no success word of its own.
  const outRows = rout.map((p) => pcard(p, { dot: false, dis: !on,
    act: '<button class="sbtn" data-fr="wd:' + esc(p.id) + '" aria-label="Cancel request to ' + (named(p) ? esc(p.callsign) : 'this player') + '"'
       + (on ? '' : ' disabled') + '>Cancel</button>' })).join('');
  const rows = friends.map((p) => pcard(p, { dis: !on })).join('');
  // The requests a player must ANSWER and the ones they are waiting on belong
  // together, above the list. Left at the foot of the column the outgoing line
  // floated two hundred units under the last friend card, orphaned from the
  // thing it is about, because the list below it takes the spare height.
  // Accept, Ignore and Cancel are the controls in this column, so THIS is
  // where their refusal is said — beside the requests, not in the search box
  // two columns away.
  return (rin.length || rout.length
      ? '<span class="lbl">Requests' + (rin.length ? ' &middot; ' + rin.length : '') + '</span>'
        + (rin.length ? '<div class="frl">' + reqRows + '</div>' : '')
        + errLine(fr.perr)
        + (rout.length ? '<p class="fnote">' + rout.length + ' request' + (rout.length === 1 ? '' : 's') + ' waiting for an answer.</p>'
          + '<div class="frl frlo">' + outRows + '</div>' : '')
        + '<div class="fsec"></div>'
      : errLine(fr.perr))
    + '<span class="lbl">Your friends &middot; ' + friends.length + '</span>'
    + '<div class="frl frl2">' + (rows || '<p class="fnote">No friends yet. Share your friend code, or add a friend by theirs or by callsign.</p>') + '</div>';
}
// The blocked list, in the one shape both kinds of account render: a linked
// account reads it out of the friends snapshot, a guest out of block op:'list'.
// `w` is whichever read owns this list, so the guest — for whom this section is
// the WHOLE screen — gets the same sentence a linked account gets, and Unblock's
// own failure (`fr.berr`) is said here rather than in a column a guest is never
// shown.
function blockedSec(list, on, known, w) {
  if (!known) return '<span class="lbl">Blocked</span>' + frWait(on, w) + errLine(fr.berr);
  const rows = (list || []).map((p) => pcard(p, { dot: false, menu: false, dis: !on,
    act: '<button class="sbtn" data-fr="unblock:' + esc(p.id) + '"' + (on ? '' : ' disabled') + '>Unblock</button>' })).join('');
  return '<span class="lbl">Blocked &middot; ' + (list || []).length + '</span>' + errLine(fr.berr)
    + '<div class="frl frl2">' + (rows || '<p class="fnote">Nobody is blocked.</p>') + '</div>';
}
function frCode(sn, on) {
  const code = sn && sn.friendCode ? 'FR-' + sn.friendCode : '';
  const canShare = !!(typeof navigator !== 'undefined' && navigator.share);
  const w = socWait();
  return '<span class="lbl">Your friend code</span>'
    + '<div class="frcode">' + esc(code || 'FR-------') + '</div>'
    + '<div class="frow"><button class="ghost" data-fr="copy"' + (code ? '' : ' disabled') + '>' + IC.copy + 'Copy</button>'
    +   (canShare ? '<button class="ghost" data-fr="share"' + (code ? '' : ' disabled') + '>' + IC.share + 'Share</button>' : '') + '</div>'
    // NOT A PROMISE ABOUT A CODE NOBODY HAS BEEN SHOWN. With no snapshot the row
    // above is FR------- with Copy and Share dead, and "anyone who enters this
    // code is added straight away" read as an instruction about it. The third
    // state says what is actually true; the refusal beneath the Blocked heading
    // a few lines down says why, once, for the whole column.
    + (sn ? '<p class="fnote">Anyone who enters this code is added as a friend straight away.</p>'
          : '<p class="fnote">Not loaded yet.</p>')
    + '<div class="fsec"></div>' + blockedSec(sn ? sn.blocked : null, on, !!sn, w);
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
  // PAINTED BEFORE THE SEND, which is what makes the tap visible: the button
  // reads Loading and goes disabled while the read is out. Without it the screen
  // kept rendering an ENABLED Retry over a request already in flight, and
  // gbNeed's own `gb.asking` guard returned immediately on every further tap --
  // so a guest, for whom this list is the whole screen, could tap it four times
  // on a slow connection and see nothing change by a pixel. socialResync does
  // exactly this on the linked path, for exactly this reason.
  frPaint();
  socialTx({ type: 'block', op: 'list' }, 'block', 'list', 'block.list', (m, err) => {
    gb.asking = false;
    if (err) gb.err = err;
    else { gb.list = Array.isArray(m.blocked) ? m.blocked : []; gb.err = ''; }
    gbPublish();
    frPaint();
  });
}
// A guest's list has no server push behind it, so a block or an unblock it made
// has to re-read. A linked account is pushed a fresh snapshot by the server.
function gbRefresh() {
  if (acctState() !== 'guest') return;
  gb.list = null; gb.err = '';
  gbPublish();
  gbNeed();
}
function frNeed() {
  const who = acctState();
  if (who === 'in') { if (fn('socialNeed')) socialNeed(); return; }
  if (who === 'guest') gbNeed();
}
function frRetry() {
  const who = acctState();
  // Retry means "load this section again", so the last ACTION error in the two
  // list columns goes with it — a sentence about an Unblock that failed before
  // the list was re-read is about a card that may not even be there now.
  fr.perr = ''; fr.berr = '';
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
// `sink` NAMES THE COLUMN THE TAP CAME FROM: 'ferr' for the search box, 'perr'
// for friends and requests, 'berr' for the blocked list. Without it every one of
// these wrote into `fr.ferr`, which only column 1 renders — so a failed Accept
// reported itself two columns away from the card, and a failed Unblock as a
// GUEST, who has no column 1, reported itself nowhere and left a dead button.
function frOne(frame, type, op, kind, sink, done) {
  socialTx(frame, type, op, kind, (m, err) => {
    if (err) { fr[sink] = err; return frPaint(); }
    fr[sink] = '';
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
  // Add friend acts on the SEARCH RESULT, which is in column 1 under the search
  // box — so its refusal belongs to `ferr`, where the card is. Accept, Ignore
  // and Cancel are column 2, Unblock is column 3.
  if (op === 'req') return frOne({ type: 'friend', op: 'request', to: arg }, 'friend', 'request', 'friend.request', 'ferr', (m) => {
    fr.res = null;
    if (fn('showToast')) showToast(m.state === 'friends' ? 'You are now friends.' : 'Request sent.');
  });
  if (op === 'acc') return frOne({ type: 'friend', op: 'accept', from: arg }, 'friend', 'accept', 'friend.accept', 'perr', () => {});
  if (op === 'dec') return frOne({ type: 'friend', op: 'decline', from: arg }, 'friend', 'decline', 'friend.decline', 'perr', () => {});
  if (op === 'wd') return frOne({ type: 'friend', op: 'withdraw', to: arg }, 'friend', 'withdraw', 'friend.withdraw', 'perr', () => {});
  if (op === 'unblock') return frOne({ type: 'block', op: 'remove', id: arg }, 'block', 'remove', 'block.remove', 'berr', () => {
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
      // ONE SHAPE FOR BOTH ACCOUNTS. The guest's refusal used to replace the
      // section wholesale, which dropped the third-state line and left Unblock's
      // own error (fr.berr) with nowhere to render; blockedSec now carries both.
      + '<div class="fcol" style="flex:1;min-width:0">'
      + blockedSec(gb.list, on, gb.list !== null, { busy: gb.asking, err: gb.err }) + '</div></div>'
    : '<div class="cols" style="height:' + u(336) + '"><div class="fcol" style="width:' + u(430) + ';margin:0 auto">' + frNoAccount('out') + '</div></div>';
  return chrome('Friends', sub, on ? esc(s.name) : 'Needs a connection', body, '');
};

// 10 — YOUR SQUAD, the Manage squad window (owner, 2026-10-06), behind the
// box's Manage. Three columns: join a squad by code and this squad's own code
// (sqCodeCol), the squad itself with Ready, Leave and the leader's Remove
// (sqPane), and every friend, online first, with Invite (sqFriends). The
// chrome is the Friends screen's: a header with Back, and columns that each
// scroll on their own, so the page never grows past the design frame however
// long a list is. Every control in it is a data-sq control, the box's own.
SCREENS.squad = function () {
  const s = state(), on = wsReady(), sn = sq.snap, n = sqCount();
  const sub = !on ? 'Needs a connection'
    : sn ? 'Squad ' + n + '/' + SQ_MAX + ' &middot; ' + esc(modeOf(sn.mode).name)
    : sqAway() ? 'Open on another tab or device'
    : n === 0 ? 'No squad yet' : 'Not loaded yet';
  const body = '<div class="cols sqw" style="height:' + u(336) + '">'
    + '<div class="fcol sqwc" id="sqWin-code" style="width:' + u(232) + '">' + sqCodeCol() + '</div>'
    + '<div class="fcol sqwp sqwq" id="sqWin-squad" style="width:' + u(330) + '">' + sqPane() + '</div>'
    + '<div class="fcol sqwp" id="sqWin-friends" style="flex:1;min-width:0">' + sqFriends() + '</div></div>';
  return chrome('Your squad', sub, on ? esc(s.name) : 'Needs a connection', body, '');
};

// 4 — ARMOURY. Load the rack: n weapons go into the field. NOT A STEP ANY MORE
// (owner, 2026-10-06): it is reached only by Edit on Match setup's weapon rack
// and by the Bay stations row on home, and its button is Done, which goes back
// to whichever of the two opened it (the stack's own back). It never launches:
// only Match setup starts a match, and a rack left short there is filled then.
SCREENS.armoury = function () {
  const s = state(), m = s.mode, n = m.draft, picks = rackPicks().slice(0, n), full = picks.length >= n;
  if (isGolf(m)) return golfBagScreen(s, m);
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
    +     '<div style="font-family:Rajdhani,system-ui,sans-serif;font-weight:700;font-size:' + u(19) + ';text-transform:uppercase;letter-spacing:.03em;margin-top:' + u(4) + ';color:#eef3ff">' + esc(m.name) + '</div></div>'
    +   stage(s.skinId, { cx: 131, cy: 224, w: 164 })
    +   '<div style="position:absolute;left:0;right:0;bottom:' + u(10) + ';padding:0 ' + u(12) + ';z-index:2">'
    +     '<div style="display:flex;align-items:flex-end;justify-content:space-between"><span class="lbl" style="padding-bottom:' + u(3) + '">Loaded</span>'
    +       '<span class="b-cnt" style="color:' + (full ? '#3ce88f' : '#ffb46b') + '">' + picks.length + '<span style="font-size:' + u(16) + ';color:#7f8fb5"> / ' + n + '</span></span></div>'
    +     '<div class="slots">' + slots(picks, n) + '</div></div>'
    + '</div>'
    + '<div class="rack">' + cells + info + '</div>'
    + '</div>';
  // Done is never held back by a short rack: Start Game and a squad's Ready
  // fill one (fillRack), and the hint says so while it is short. THE SQUAD'S
  // OWN ARMOURY HAS GONE (U3): it was the box's "Pick N more" door, for a rack
  // too short to ready with, and a Ready now fills a short rack itself.
  const foot = '<span class="hint">' + (full ? 'Everyone carries the Cannon &middot; the Railgun only drops in crates' : 'Empty slots are filled with standard weapons') + '</span><span class="grow"></span>'
    + '<button class="go" data-back>Done</button>';
  return chrome('Armoury', 'Load the rack &mdash; ' + n + ' weapons go into the field', 'Your rack', body, foot);
};

// 4, FOR GOLF — THE GOLF BAG. The Armoury's door (the Bay stations row)
// opens this instead when golf is the mode: the four clubs and what each one
// does, read-only. Nothing is picked here and nothing has to be, so Done is
// always live; like the Armoury's, it goes back where it came from.
function golfBagScreen(s, m) {
  const card = (id) => {
    const w = weaponInfo(id);
    return '<div class="gclub"><span class="gct">' + wicon(id) + '<span class="gcn">' + esc(w.name) + '</span></span>'
      + '<span class="gcd">' + esc(w.desc) + '</span></div>';
  };
  const body = '<div class="cols">'
    + '<div class="card" style="width:' + u(262) + ';position:relative;overflow:hidden">'
    +   '<div style="position:absolute;left:' + u(12) + ';right:' + u(12) + ';top:' + u(11) + ';z-index:2"><span class="lbl">Golf bag</span>'
    +     '<div style="font-family:Rajdhani,system-ui,sans-serif;font-weight:700;font-size:' + u(19) + ';text-transform:uppercase;letter-spacing:.03em;margin-top:' + u(4) + ';color:#eef3ff">' + esc(m.name) + '</div></div>'
    +   stage(s.skinId, { cx: 131, cy: 224, w: 164 })
    +   '<div style="position:absolute;left:0;right:0;bottom:' + u(10) + ';padding:0 ' + u(12) + ';z-index:2">'
    +     '<div style="display:flex;align-items:flex-end;justify-content:space-between"><span class="lbl" style="padding-bottom:' + u(3) + '">Clubs</span>'
    +       '<span class="b-cnt" style="color:#3ce88f">' + GOLF_BAG.length + '</span></div>'
    +     '<div class="slots">' + slots(GOLF_BAG, GOLF_BAG.length) + '</div></div>'
    + '</div>'
    + '<div class="gbag">' + GOLF_BAG.map(card).join('') + '</div>'
    + '</div>';
  const foot = '<span class="hint">No draft in golf &middot; every player carries these four clubs</span><span class="grow"></span>'
    + '<button class="go" data-back>Done</button>';
  return chrome('Golf bag', 'Four clubs &mdash; the same bag for every player', 'No draft', body, foot);
}

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
  const isHost = m ? m.you === m.host : true;
  const filled = m ? m.players.filter(Boolean).length : 1;
  // While pending, the QUEUED create is the truth about the mode and the seat
  // count — not the board the bay happens to have lit, which any caller of
  // intent() may differ from. A real room's payload wins once it exists.
  const qi = pending && G.pendingIntent && G.pendingIntent.type === 'create' ? G.pendingIntent : null;
  const max = m ? m.max : (qi && qi.max) || 2;
  const mode = m ? modeOf(m.mode) : qi ? modeOf(qi.mode) : s.mode;
  // A ROOM FOR ONE, online: a one-seat golf room, which the server starts the
  // moment it is created, and any room this page asked for as a Solo create
  // (app.js soloRoom), which it starts itself the moment the room exists. Both
  // are drawn as what they are, a run for one, from the 'created' frame on --
  // never as a lobby with an open seat, even for the frame it is painted on.
  // ONLY ITS HOST'S: a room somebody else hosts is never ours to call solo.
  const soloAsk = G.soloRoom === true;
  const oneSeat = !pending && !solo && !searching && isHost && (soloAsk || (mode.id === 'golf' && max === 1));
  const cp = SOLO_COPY[mode.id] || SOLO_COPY.boss;
  // A queued Solo create waits for nobody, so its pending copy says what it
  // does wait for -- the server -- and never that it needs a second player.
  const need = soloAsk && cp.solo ? cp.solo : cp.need;
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
      else if (!solo && !oneSeat) out += '<div class="seat wait"><span class="b-dot" style="background:#6f7fa6;margin-left:' + u(16) + '"></span><span class="sn">' + (mode.id === 'duel' ? 'Waiting for a commander' : 'Open slot') + '</span><span class="spin"></span></div>';
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
        : st === 'unreachable' ? esc(need) + ' We keep trying in the background. ' + esc(cp.can)
        : esc(need) + ' ' + esc(cp.can))
    : solo
    ? '<span class="lbl">Solo run</span>' + big('OFFLINE', true)
      + note('Nobody can join this room. Closing the app ends the run.')
    : searching
    ? '<span class="lbl">Quick match</span><div class="b-code" style="font-size:' + u(44) + ';letter-spacing:.05em">SEARCHING</div>'
      + '<div style="margin-top:' + u(14) + ';font-size:' + u(11.5) + ';color:#8798bd;line-height:1.45;max-width:' + u(270) + ';font-weight:500">We&rsquo;ll drop you into a battle the moment someone else is looking too.</div>'
    : oneSeat
    ? (isGolf(mode) ? '<span class="lbl">Solo round</span>' + big('TEEING OFF', true) + note('A round for one. It starts in a moment.')
      : '<span class="lbl">Solo run</span>' + big('DEPLOYING', true) + note('A run for one. It starts in a moment.'))
    // A ROOM WITH SEATS TO FILL. This page no longer makes one (friend games are
    // squads only, owner 2026-10-06), and the waiting room that shared its code
    // -- "Bay doors sealed", Share this code, Copy link, Copy code -- is gone
    // with it: nothing here offers a game code. What can still arrive is a
    // room somebody else made: a ?room= link from a friend on an older build,
    // joined from the address bar, which survives a reload. Its seats and its
    // host's Start are drawn as they always were.
    : '<span class="lbl">' + (isHost ? 'Your room' : 'Joined') + '</span>' + big('STAND BY', false)
      + note(isHost ? (hostStarts ? (mode.id === 'golf' ? 'Tee off whenever you are ready.' : 'Start whenever you are ready.') : 'Nobody else can join this room.')
        : hostStarts ? (mode.id === 'golf' ? 'Waiting for the host to tee off&hellip;' : 'Waiting for the host to start the battle&hellip;')
        : 'The battle starts in a moment.');
  const summary = '<div style="display:flex;gap:' + u(26) + ';margin-top:' + u(16) + ';padding-top:' + u(13) + ';border-top:1px solid rgba(140,168,214,.2)">'
    + '<span class="ro"><span class="rk">Mode</span><span class="rv">' + esc(mode.name) + '</span></span>'
    + '<span class="ro"><span class="rk">Players</span><span class="rv">' + (solo || oneSeat ? filled : filled + ' / ' + max) + '</span></span>'
    + '<span class="ro"><span class="rk">Paint</span><span class="rv">' + esc(s.skin.name) + '</span></span></div>';
  const right = '<span class="lbl">' + (solo ? 'Deploying' : 'Roster') + '</span>' + roster
    + '<button class="ghost' + (nudgeHidden || solo || searching || pending || oneSeat ? ' hidden' : '') + '" style="width:100%;margin-top:' + u(10) + ';height:' + u(34) + ';font-size:' + u(13) + ';justify-content:center" data-old="notifyBtn">Nudge me when they join</button>'
    // No Change on the rack: the Armoury is reached from Match setup's Edit and
    // the Bay stations row only (owner, 2026-10-06), and its Done goes back.
    + '<div style="margin-top:' + u(12) + '">' + (isGolf(mode) ? loadout(GOLF_BAG, GOLF_BAG.length, 'Golf bag', '')
      : loadout(rackPicks().slice(0, mode.draft), mode.draft, 'Rack loaded', '')) + '</div>';
  const title = pending ? (st === 'offline' ? 'No connection' : st === 'connecting' ? 'Reaching the server' : 'Cannot reach the server')
    : solo ? 'Solo run' : searching ? 'Searching' : oneSeat ? (isGolf(mode) ? 'Teeing off' : 'Deploying') : filled >= max ? 'Bay doors opening' : 'Standing by';
  const count = solo ? '' : ' (' + filled + ')';
  const startLabel = filled < minSeats ? 'Start (need ' + minSeats + ')' : mode.id === 'boss' ? 'Engage the WARLORD' + count : mode.id === 'golf' ? 'Tee off' + count : 'Start battle' + count;
  // While the server is being reached there is nothing to offer yet; once it
  // is offline or has not answered, Play solo. Cancel is always there — and
  // the header's Back arrow is routed through it (see the click handler).
  const foot = '<button class="ghost" data-old="cancelBtn">Cancel</button><span class="grow"></span>'
    + (pending
      ? (st === 'connecting' ? '' : '<button class="go" data-solo>' + (mode.id === 'duel' || mode.id === 'ffa' ? 'Play vs Computer' : 'Play solo') + IC.play + '</button>')
      : '<button class="go' + (canStart && !oneSeat ? '' : ' hidden') + '" ' + (filled < minSeats ? 'disabled' : 'data-old="startMatchBtn"') + '>' + startLabel + IC.play + '</button>');
  const loaded = isGolf(mode) ? GOLF_BAG.length + ' clubs in the bag' : rackPicks().slice(0, mode.draft).length + ' weapons loaded';
  // The chip names the state, never a room: nothing exists yet while the
  // server is being reached, and the waiting room is gone (owner, 2026-10-06).
  return chrome(title, esc(mode.name) + ' &middot; ' + loaded, pending ? (st === 'offline' ? 'Offline' : st === 'connecting' ? 'Connecting' : 'Retrying') : solo ? 'Solo drop' : searching ? 'Quick match' : oneSeat ? (isGolf(mode) ? 'Solo round' : 'Solo run') : 'Friend room',
    '<div class="doors"><span class="door" style="left:0"></span><span class="door" style="right:0"></span></div>'
    + '<div class="cols" style="align-items:center;padding:0 ' + u(34) + '"><div style="width:' + u(420) + '">' + left + summary + '</div><div style="flex:1">' + right + '</div></div>', foot);
};

// 2 — MISSION BOARD. Five ways to bring down a mountain; a card both selects
// the mode and steps into its setup.
SCREENS.modes = function () {
  const s = state();
  const cards = MODES.map((x) => {
    const on = x.id === s.mode.id;
    return '<button class="mb' + (on ? ' on' : '') + (noFit(x.id) ? ' nofit' : '') + '" data-set="mode=' + x.id + '" data-go="setup">'
      + '<span class="mbi"><img src="' + art(x.card) + '" alt=""><span class="g"></span><span class="lip"></span>' + offBadge(x.id) + noFitPill(x.id)
      +   '<span class="mbicn">' + MODE_IC[x.id] + '</span><span class="mbn">' + esc(x.name) + '</span></span>'
      + '<span class="mbc"><span class="mbt' + (on ? '' : ' mbt2') + '">' + (on ? 'Armed &middot; ' : '') + esc(x.tag) + '</span>'
      +   '<span class="mbb">' + esc(x.blurb) + '</span>'
      +   '<span class="mbf"><span class="tagm">' + esc(x.players) + ' players</span><span class="tagm">' + (isGolf(x) ? GOLF_BAG.length + ' clubs' : x.draft + ' weapons') + '</span></span></span></button>';
  }).join('');
  return chrome('Mission board', 'Five ways to bring down a mountain', 'Step 1 of 2', '<div class="mrow">' + cards + '</div>', '');
};

// 3 — MATCH SETUP. Who you play with, the per-mode option, who you are rolling
// out as, and the rack -- and START GAME, which starts the match from here
// (owner, 2026-10-06): the Armoury is no longer a step, only Edit's side trip.
// Drives the same variables the old create row did.
//
// WHO YOU PLAY WITH, chosen again on every visit (owner, 2026-10-06). Friend
// games are squads only, so there are two answers: Computer (Duel,
// Free-for-all) or Solo (Boss Fight, Alien Invasion, golf), and Your squad.
// setupWith is null until the player taps one, and null means the DEFAULT:
// Your squad in a squad of two or more, otherwise Computer or Solo -- read
// live, so a squad that fills or empties under the screen moves an untouched
// choice with it. It is reset to null whenever setup is entered from anywhere
// but the three screens it sends the player to and back from (SETUP_TRIPS:
// Edit's Armoury, Repaint's Paint shop, Change mode's Mission board), so a
// choice survives those round trips and never a visit. Nothing remembers it
// between visits, in this page or in storage.
let setupWith = null;
const SETUP_TRIPS = ['armoury', 'paint', 'modes'];
// A squad Your squad can mean: this socket holds the row (sqLive, D-UI-1) and
// two or more are in it. A squad of one is not one (owner: setup defaults to
// Computer, and ready-up appears once a second player joins).
// NOR IS A SQUAD THE SOCKET CANNOT REACH. app.js keeps the last roster in the
// slot through a drop, so this read true offline: home's Launch became a dead
// "Needs a connection" Ready and setup opened on a dead Your squad, and an
// offline game was two detours away. Offline, home and setup play as if there
// were no squad -- the ordinary Launch, Computer or Solo, offline play -- and
// the squad is back the moment the socket is (cc:social repaints both).
const sqTwoPlus = () => { const sn = sq.snap; return wsReady() && sqLive(sn) && Array.isArray(sn.members) && sn.members.length >= 2; };
const setupSquad = () => sqTwoPlus() && setupWith !== 'cpu';
const SQ_WITH_WHY = 'Needs a squad of 2 or more';
// ---- THE SQUAD'S READY CONTROL (U3; owner, 2026-10-06) --------------------
// "All players must ready up and then the game starts ... easy for new players
// to pick up on straight away." In a squad of two or more the big orange
// Launch on home, and Start Game in Match setup while Your squad is the
// choice, BECOME the squad's Ready, and always say how many of the squad are
// ready: "Ready up 0/2"; tapped, "Ready 1/2" and who it is waiting for; tapped
// again, it stands down. The last Ready starts the server's countdown,
// "Starting in 3, 2, 1", which every member sees, and anyone standing down
// stops it. A squad of one is no squad: Launch and Start Game are the
// ordinary ones.
// What the control says while the squad could not start, as a reason in
// words. The seats are the server's seat table, as SQ_SEATS spells them.
const SQ_NEED = { duel: '2', ffa: '2 to 4', boss: '1 to 2', aliens: '1 to 2', golf: '1 to 4' };
// A member as the waiting line names them: the callsign the server proved, and
// never "No callsign" in a sentence.
const sqWho = (p) => (named(p) ? p.callsign : p && p.guest ? 'a guest' : 'a player');
// WHY THIS SQUAD CANNOT READY UP NOW, or '' when it can: no squad of two, a
// mode the squad does not fit, or a member who is not there. The server would
// count none of those in, so standing up is refused here with the reason on
// screen, and standing down never is.
function sqUpWhy(sn) {
  const ms = (sn && sn.members) || [], me = sqMe(sn), m = modeOf(sn.mode);
  if (ms.length < 2) return SQ_WITH_WHY;
  if (!(sn.fits && sn.fits[sn.mode])) return m.name + ' needs ' + SQ_NEED[m.id] + ' players';
  const away = ms.find((p) => p !== me && (p.dropped || p.online === false));
  return away ? sqWho(away) + (away.dropped ? ' is reconnecting' : ' is offline') : '';
}
// THE COUNTDOWN, in whole seconds left (3, 2, 1, then 0 while the room is
// built), or null when none runs. Counted from app.js's CC_SQUAD_STARTS, the
// moment the roster arrived plus the time the server said was left, so a
// device whose clock is wrong counts the same three seconds.
function sqCountLeft() {
  const at = window.CC_SQUAD_STARTS;
  if (!sq.snap || !(typeof at === 'number' && at > 0)) return null;
  return Math.max(0, Math.ceil((at - performance.now()) / 1000));
}
// THE CONTROL'S STATE, or null outside a squad of two or more (the ordinary
// Launch and Start Game).
//   label  the words on the button: "Ready up 1/2", "Ready 1/2", "Starting in 2"
//   say    the line beneath them: who it is waiting for (you first, at most
//          two names, then "+k"), why it cannot start, the last start's
//          refusal, or that everyone is ready
//   mine   this player is ready; dis: a tap would do nothing
function sqReadyCtl() {
  if (!sqTwoPlus()) return null;
  const sn = sq.snap, ms = sn.members, me = sqMe(sn);
  if (!me) return null;
  const on = (p) => !!(p && p.ready && !p.dropped);
  const n = ms.filter(on).length, mine = on(me), left = sqCountLeft();
  const why = wsReady() ? sqUpWhy(sn) : 'Needs a connection';
  const names = ms.filter((p) => !on(p)).map((p) => (p === me ? 'you' : sqWho(p)));
  const waiting = names.length > 2 ? names.slice(0, 2).join(', ') + ' +' + (names.length - 2) : names.join(', ');
  return {
    mine, left, n, of: ms.length,
    label: left !== null ? (left > 0 ? 'Starting in ' + left : 'Starting') : (mine ? 'Ready ' : 'Ready up ') + n + '/' + ms.length,
    say: left !== null ? 'Everyone is ready' : why || sq.serr || (names.length ? 'Waiting for ' + waiting : 'Everyone is ready'),
    dis: !wsReady() || !!sq.busy || (!mine && !!why),
  };
}
// THE CONTROL AS A BUTTON, for the ribbon's .launch and Match setup's .go.
// GREY UNTIL EVERYONE IS READY (owner, 2026-10-06: "the launch button greyed
// out with 0/2 or 1/2 players ready"): "Ready up 0/2" and "Ready 1/2" are a
// live grey, with a border and the count, because they are still the button
// to tap (`up`, and `on` with a tick once this player is ready). It turns the
// live orange only when the squad counts down (`cd`), and a control that
// cannot ready at all is the dead grey of every disabled control, with its
// reason. aria-pressed says the toggle's state; the words say the rest.
function sqReadyBtn(base, attr, c) {
  const st = c.left !== null ? 'cd' : c.mine ? 'on' : 'up';
  return '<button class="' + base + ' rdy ' + st + '" ' + attr + ' aria-pressed="' + c.mine + '"' + (c.dis ? ' disabled' : '') + '>'
    + '<span class="rdyt">' + (c.mine && c.left === null ? IC.tick : '') + esc(c.label) + '</span>'
    + '<span class="rdys">' + esc(c.say) + '</span></button>';
}
// THE HOOK MATCH SETUP'S START GAME AND THE RIBBON CALL. -> true when the
// squad's control took the tap (it may still send nothing, when the squad
// cannot ready), false when there is no squad of two to ready in.
// NEVER READY FOR A MODE THE SCREEN IS NOT SHOWING. The ribbon and Match setup
// draw the ARMED mode, and Ready readies for the SQUAD's (sqReady): a member
// whose setup had kept the mode it was opened on was readied with a seven-
// weapon Boss rack under a screen that said Duel, and seated in a Boss Fight
// they never saw chosen. sqFollow keeps the two together now; this is the
// last word if they ever part. Standing UP while they differ sends nothing:
// a member's screen is put on the squad's mode (render follows), and a
// leader's mode, still on its way, is put to the squad (boardMode sends only
// what the roster does not already say). The tap after that readies for the
// mode on screen. Standing down is never held.
function squadReadyToggle() {
  const c = sqReadyCtl();
  if (!c) return false;
  if (c.dis) return true;
  const sn = sq.snap;
  if (!c.mine && state().mode.id !== sn.mode) {
    if (sqIsLead(sn, sqMe(sn))) boardMode(); else render(current);
    return true;
  }
  sqReady();
  return true;
}
// START GAME, from this one place: the squad's Ready while Your squad is the
// choice (`withSquad`), the ordinary Start Game otherwise.
function startGameBtn(withSquad) {
  const c = withSquad ? sqReadyCtl() : null;
  return c ? sqReadyBtn('go', 'data-launch', c) : '<button class="go" data-launch>Start Game' + IC.play + '</button>';
}
// THE TAP. Read when it lands, never when the button was drawn: a squad that
// shrank under the screen is Computer or Solo again by now (setupSquad). A rack
// short of the mode's draft is filled and saved first (fillRack), so Start
// Game always works; golf drafts nothing. Then the exact old create path: the
// legacy button's own handler, which sends the 'ai' frame or the Solo create.
// PLAYING ALONE FROM A SQUAD STANDS THIS PLAYER DOWN FIRST (U3): a Ready left
// standing would let the squad count this player into its match while they
// are in their own, and the seating would then be refused for all of them.
// IN A SQUAD OF ONE TOO: a Ready left over from a squad that shrank around
// this player is drawn nowhere (a squad of one shows no ready-up state), and
// the server keeps it, so the first player to join and ready would count
// them in.
function startGame() {
  if (setupSquad()) { squadReadyToggle(); return; }
  const sn = sq.snap, me = wsReady() && sqLive(sn) ? sqMe(sn) : null;
  if (me && me.ready && !me.dropped) sqOne({ type: 'squad', op: 'ready', ready: false }, { op: 'ready', kind: 'squad.ready', busy: 'ready' });
  const m = state().mode;
  if (!isGolf(m)) fillRack(m);
  const b = $('createBtn'); if (b) b.onclick();
}
SCREENS.setup = function () {
  const s = state(), m = s.mode;
  const cpuMode = m.id === 'duel' || m.id === 'ffa';
  const squadOk = sqTwoPlus(), withSq = setupSquad();
  const vsCpu = cpuMode && !withSq;
  // Every group is always in the tree, hidden when it does not apply, so a
  // change never reshapes the siblings and the in-place patch lands cleanly.
  // Your squad is always shown, and disabled with one line saying why while
  // there is no squad of two or more to play with (seg). A squad is sized by the
  // server, so the free-for-all's count is the CPU count, shown with
  // Computer only; golf has no seat count at all (alone is a round for one,
  // a squad is the whole squad), and keeps its tee set either way.
  // Offline the reason is the connection, which is true of every player then,
  // a squad of two included (sqTwoPlus).
  const withWhy = squadOk ? '' : wsReady() ? SQ_WITH_WHY : 'Needs a connection';
  const withSeg = seg('Play with', 'with', [['cpu', cpuMode ? 'Computer' : 'Solo'], ['squad', 'Your squad', withWhy]], withSq ? 'squad' : 'cpu', false);
  // A MEMBER PLAYING WITH THE SQUAD IS SHOWN THE SQUAD'S TEE SET, live, and a
  // tap on another one is explained (sqLockWhy): the leader picks it (U3).
  const sn = sq.snap, teesOn = withSq && !sqIsLead(sn, sqMe(sn)) && SQ_TEES.includes(sn.tees) ? sn.tees : s.tees;
  const extra = seg('CPU commanders', 'count', [[3, '2'], [4, '3']], s.count, !(m.id === 'ffa' && vsCpu))
    + seg('Tee set', 'tees', [['champ', 'Champ'], ['mens', 'Men&rsquo;s'], ['womens', 'Women&rsquo;s'], ['junior', 'Junior']], teesOn, m.id !== 'golf')
    + seg('Difficulty', 'diff', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], s.diff, !vsCpu);
  const withText = withSq ? 'Your squad' : vsCpu ? 'Computer &middot; ' + esc(cap(s.diff)) : 'Solo';
  const tall = m.id === 'ffa' && vsCpu;       // three visible option groups
  const short = !isGolf(m) && s.picks.length < m.draft;

  const body = '<div class="cols">'
    // The column is a fixed 274u tall (.cols). One or two option groups leave
    // the crew card room to stretch, exactly as before. Free-for-all + Computer
    // shows THREE, which cannot fit at any viewport: only then does the column
    // scroll and the card keep its own height (grow, never shrink) instead of
    // spilling over the footer.
    + '<div style="width:' + u(430) + ';display:flex;flex-direction:column;gap:' + u(12) + (tall ? ';min-height:0;overflow-y:auto;overflow-x:hidden' : '') + '">' + withSeg + extra
    +   '<div class="card" style="flex:' + (tall ? '1 0 auto' : '1') + ';min-height:0;padding:0 ' + u(13) + ';display:flex;flex-direction:column;justify-content:space-evenly">'
    +     '<div class="crew" style="border:0;background:none;padding:0">' + tankImg(s.skinId, 56, 'Your tank')
    +       '<span class="ct"><span class="lbl">Rolling out as</span>'
    +       '<span style="display:block;font-family:Rajdhani,system-ui,sans-serif;font-weight:700;font-size:' + u(19) + ';text-transform:uppercase;letter-spacing:.03em;margin-top:' + u(4) + ';color:#eef3ff">' + esc(s.name) + '</span>'
    +       '<span style="display:block;font-family:\'JetBrains Mono\',monospace;font-size:' + u(8.5) + ';font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:#ffb46b;margin-top:' + u(4) + '">' + esc(s.skin.name) + ' paint</span></span>'
    +       '<button class="ghost" style="height:' + u(32) + ';font-size:' + u(13) + '" data-go="paint">Repaint</button></div>'
    +     '<div style="height:1px;background:rgba(140,168,214,.18)"></div>'
    +     (isGolf(m)
      // Golf's row is its bag, read-only: no count of picks, and no Edit.
      ?     '<div><div style="display:flex;align-items:center;gap:' + u(8) + '"><span class="lbl">Golf bag &middot; ' + GOLF_BAG.length + ' clubs</span></div>'
      +       '<div class="slots" style="justify-content:flex-start;margin-top:' + u(9) + '">' + slots(GOLF_BAG, GOLF_BAG.length) + '</div></div>'
      // Edit is the Armoury's one door from here; its Done comes back.
      :     '<div><div style="display:flex;align-items:center;gap:' + u(8) + '"><span class="lbl">Weapon rack &middot; ' + s.picks.length + ' of ' + m.draft + ' drafted</span><span class="grow"></span>'
      +       '<button class="ghost" style="height:' + u(28) + ';font-size:' + u(12) + ';padding:0 ' + u(11) + '" data-go="armoury">Edit</button></div>'
      +       '<div class="slots" style="justify-content:flex-start;margin-top:' + u(9) + '">' + slots(s.picks, m.draft) + '</div></div>')
    +   '</div>'
    + '</div>'
    + '<div class="brief" style="flex:1"><div class="bi"><img src="' + art(m.card) + '" alt=""><span class="g"></span><span>' + esc(m.name) + '</span></div>'
    +   '<div class="bb">' + esc(m.blurb) + '</div>'
    +   '<div class="brow"><span class="lbl">Players</span><b>' + esc(m.players) + '</b></div>'
    +   (isGolf(m) ? '<div class="brow"><span class="lbl">Clubs in the bag</span><b class="cy">' + GOLF_BAG.length + '</b></div>'
      : '<div class="brow"><span class="lbl">Weapons to draft</span><b class="cy">' + m.draft + '</b></div>')
    +   '<div class="brow"><span class="lbl">Play with</span><b>' + withText + '</b></div></div>'
    + '</div>';
  // START GAME IS THE MATCH (data-launch, the Armoury's old word for the real
  // create): it never waits on the rack, so the hint says what happens to a
  // short one rather than that the doors stay shut.
  const foot = '<button class="ghost" data-go="modes">Change mode</button>'
    + '<span class="hint">' + (isGolf(m) ? 'No draft in golf &middot; every player carries the same four clubs'
      : short ? 'Empty slots are filled with standard weapons' : 'Everyone carries the Cannon &middot; the Railgun only drops in crates') + '</span><span class="grow"></span>'
    + startGameBtn(withSq);
  // Two steps now: a mode (a home board or the Mission board), then this.
  return chrome(esc(m.name), 'Match setup', 'Step 2 of 2', body, foot);
};

SCREENS.home = function () {
  const s = state(), m = s.mode, ready = sqReadyCtl();
  // LAUNCH MUST NEVER BE A SURPRISE: the Players readout says what it will do.
  // Launch opens Match setup, and setup opens on its default whenever it is
  // entered from here (setupWith), so this is the default and never a choice
  // made on an earlier visit: the squad, in a squad of two or more; otherwise
  // the computer, or a run alone.
  const players = sqTwoPlus() ? 'Squad of ' + sq.snap.members.length
    : m.id === 'duel' ? 'You vs CPU'
    : m.id === 'ffa' ? 'You + ' + (s.count - 1) + ' CPU'
    : 'Solo';
  const arc = [[-6, 14], [-3, 5], [0, 0], [3, 5], [6, 14]];
  const boards = MODES.map((x, i) =>
    '<button class="board' + (x.id === m.id ? ' on' : '') + (noFit(x.id) ? ' nofit' : '') + '" style="transform:rotate(' + arc[i][0] + 'deg) translateY(' + u(arc[i][1]) + ')" '
    + 'data-set="mode=' + x.id + '" title="' + esc(x.name) + '">'
    + '<span class="bcard"><img src="' + art(x.card) + '" alt=""><span class="bsc"></span><span class="barm"></span>'
    // No offline badge on the home boards (owner, 2026-09-18); the Mission
    // board keeps its badge, and offline play itself is unchanged. The squad
    // pill (noFitPill) takes the badge's slot and none of its class.
    + '<span class="bic">' + MODE_IC[x.id] + '</span><span class="bpl">' + esc(x.players) + '</span>' + noFitPill(x.id)
    + '<span class="blab"><span class="bnm">' + esc(x.name) + '</span><span class="btg">' + esc(x.tag) + '</span></span></span></button>').join('');


  const stations = [
    ['paint',   IC.roller, 'Paint shop',     esc(s.skin.name) + ' fitted'],
    // Golf's station is its bag, and it opens the golf bag screen (the
    // Armoury's door, drawn for golf): the clubs and what each one does.
    isGolf(m) ? ['armoury', IC.bag, 'Golf bag', GOLF_BAG.length + ' clubs']
      : ['armoury', IC.shell,  'Armoury',        s.picks.length + ' of ' + m.draft + ' drafted'],
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
    // THE TANK STANDS ON ITS PLATFORM (owner, 2026-10-06: "sits lower, closer
    // to the blue ring, no longer cut off by the mode cards"). Drawn 20u lower
    // than the paint shop draws it, its tracks are inside the ring rather than
    // on its far rim, and the top of the sprite -- the barrel's end -- stays
    // clear of the boards' lowest edge at the top of its bob. Position only:
    // the sprite, its size and drawTank are untouched (the design is locked).
    + stage(s.skinId, { cx: 466, cy: 320, w: 204, sink: 20 })
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
    + sqPanel()
    + '<div class="pnl stn" style="right:' + u(18) + ';width:' + u(196) + '"><div class="ph">Bay stations<s></s></div>' + stations + '</div>'
    + '<div class="lbar">'
    +   '<span class="lic">' + MODE_IC[m.id] + '</span>'
    +   '<span style="display:block"><span class="lnm">' + esc(m.name) + '</span><span class="ltg">' + esc(m.tag) + '</span></span>'
    +   '<span class="lsep"></span>'
    // Launch AND the readouts open Match setup (owner, 2026-09-18): the one-tap
    // create is gone from home, so every launch passes the mode brief and the
    // rack. data-launch is Match setup's Start Game now (owner, 2026-10-06),
    // the only control that starts a match.
    +   '<button class="ros" data-go="setup" title="Match setup">'
    +   '<span class="ro"><span class="rk">Players</span><span class="rv">' + esc(players) + '</span></span>'
    +   (isGolf(m) ? '<span class="ro"><span class="rk">Golf bag</span><span class="rv"><em>' + GOLF_BAG.length + '</em> clubs</span></span>'
      : '<span class="ro"><span class="rk">Weapon draft</span><span class="rv"><em>' + m.draft + '</em> picks</span></span>')
    +   '<span class="ro"><span class="rk">Paint</span><span class="rv">' + esc(s.skin.name) + '</span></span>'
    +   '</button>'
    +   '<span class="grow"></span>'
    // IN A SQUAD OF TWO OR MORE, LAUNCH IS THE SQUAD'S READY (U3): the count,
    // and who it waits for, on the button itself. Match setup is still the
    // readouts' door, and Play with there is where a player picks the
    // computer, or a run alone, over the squad.
    +   (ready ? sqReadyBtn('launch', 'data-rdy', ready) : '<button class="launch" data-go="setup">' + IC.play + 'Launch</button>')
    + '</div>'
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

// THE KEYBOARD STAYS WHERE THE PLAYER PUT IT (fix wave B2). morphChildren is
// positional, so a repaint can hand a focused node to a DIFFERENT control --
// the next friend's button when the list reorders -- or hide or drop it. A
// control is known by its signature (what it acts on); when the focused node
// no longer carries it, the keyboard goes to the control that does, in the same
// row, and failing that to what took its place there: "In your squad" (which
// is what a friend's Invite becomes), their Invite, their menu -- never to a
// neighbour row, never to the page's top.
const focusSig = (e) => e.getAttribute('data-sq') || e.getAttribute('data-pmenu') || e.id || '';
function focusOf(host) {
  const e = document.activeElement;
  if (!e || e === document.body || !host.contains(e)) return null;
  const r = e.closest('[data-row]');
  return { el: e, sig: focusSig(e), row: r ? r.getAttribute('data-row') : '' };
}
function keepFocus(host, had) {
  const e = had.el, seen = (x) => !!x && !x.closest('.hidden') && x.getClientRects().length > 0;
  if (e.isConnected && seen(e) && focusSig(e) === had.sig) return;
  const r = had.row ? [...host.querySelectorAll('[data-row]')].find((x) => x.getAttribute('data-row') === had.row) : null;
  if (!r) return;
  const same = had.sig ? [...r.querySelectorAll('button, [tabindex]')].find((x) => focusSig(x) === had.sig && seen(x)) : null;
  const t = same || [r.querySelector('.sqy'), r.querySelector('[data-sq^="invite:"]'), r.querySelector('.pmb')].find(seen);
  if (t) t.focus();
}

let current = 'home';
const stack = [];
function render(name) {
  const host = $('bay'); if (!host) return;
  const next = name in SCREENS ? name : 'home';
  // Home, the Mission board, Match setup and the Armoury draw the armed mode:
  // for a squad's member it is the squad's (sqFollow), set before the markup
  // is built.
  if (SQ_FOLLOW_ON.includes(next)) sqFollow(next);
  // Match setup opens on its default unless the player is coming back from a
  // screen it sent them to (setupWith, SETUP_TRIPS); set before the markup.
  if (next === 'setup' && current !== 'setup' && !SETUP_TRIPS.includes(current)) setupWith = null;
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
  const entering = !host.firstChild || next !== current;
  // CLEARED BEFORE THE MARKUP IS BUILT. This reset used to sit below, AFTER the
  // html had already been generated from the old state, so a stale red sentence
  // was painted once more on the way in and only went on the next repaint —
  // which, with a snapshot already in hand, never came. Found by the re-entry
  // check in test/social_ui.mjs while adding the two new sinks. frNeed() stays
  // where it was, below, because it is a request and not a render input.
  const enterFriends = entering && next === 'friends';
  if (enterFriends) { fr.res = null; fr.ferr = ''; fr.cerr = ''; fr.perr = ''; fr.berr = ''; }
  const html = SCREENS[next]();
  current = next;
  // Which screen is up, for CSS that must apply to one screen only (the home
  // geometry and type sizes, the service record sizes). Set before the markup
  // lands so the first paint is right.
  host.dataset.scr = next;
  if (entering) {
    host.innerHTML = html;
    host.classList.add('enter');
    clearTimeout(render.t); render.t = setTimeout(() => host.classList.remove('enter'), 900);
  } else {
    const tpl = document.createElement('div'); tpl.innerHTML = html;
    const had = focusOf(host);
    morphChildren(host, tpl);
    if (had) keepFocus(host, had);
  }
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
  // The four error sinks are cleared with fr.res at the top of this function,
  // where the markup can still see it.
  if (enterFriends) frNeed();
  // THE BELT UNDER THE OTHER ASKS, ON ENTRY ONLY -- a repaint of home must not
  // re-ask. Every introduction, account change and return already asks, from
  // any screen; entering home, or the Manage squad window, asks about an
  // introduction none of them announced. sqNeed() is idempotent and waits for
  // the socket's hello.
  if (entering && (current === 'home' || current === 'squad')) sqNeed();
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
  // Match setup's Play with is the bay's own, and lives only for this visit.
  else if (k === 'with') { setupWith = v === 'squad' ? 'squad' : 'cpu'; }
  else if (k === 'diff' && has('cpuDifficulty')) { cpuDifficulty = v; try { localStorage.setItem('pt_diff', v); } catch {} if ($('diffSel')) $('diffSel').value = v; }
  else if (k === 'count' && has('ccMax')) { ccMax = +v; if ($('countSel')) $('countSel').value = String(v); }
  else if (k === 'tees' && has('ccTees')) { ccTees = v; try { localStorage.setItem('cc_tees', v); } catch {} if ($('teeSel')) $('teeSel').value = v; }
  if (fn('syncCreateRow')) syncCreateRow();
}

// A MEMBER CANNOT CHANGE THE SQUAD'S MODE OR ITS SETTINGS (U3; owner,
// 2026-10-06: the leader picks the mode and the settings, and everyone
// follows). A member's boards show the squad's mode (sqFollow), and a tap on
// another one is explained rather than armed: it once armed this device's own
// board, which then disagreed with the squad's. -> the sentence, or '' when
// the tap is this player's to make: a leader's, any tap outside a squad of
// two, the squad's own mode (which opens its setup) and every setting of a
// match the member plays alone (Computer or Solo in Match setup, allowed as
// before).
function sqLockWhy(k, v) {
  const sn = sq.snap;
  if (!sqTwoPlus() || sqIsLead(sn, sqMe(sn))) return '';
  if (k === 'mode' && v !== sn.mode) return 'The squad leader picks the mode.';
  if (k === 'tees' && setupSquad() && v !== sn.tees) return 'The squad leader picks the tee set.';
  return '';
}
document.addEventListener('click', (e) => {
  const host = $('bay'); if (!host || !host.classList.contains('active')) return;
  const t = e.target.closest('[data-go],[data-back],[data-set],[data-roll],[data-toggle],[data-launch],[data-rdy],[data-pick],[data-old],[data-skin],[data-solo],[data-cs],[data-fr],[data-sq]');
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
    // A MEMBER'S TAP ON THE SQUAD'S MODE OR SETTINGS IS EXPLAINED, NOT TAKEN.
    const lock = sqLockWhy(k, v);
    if (lock) { if (fn('showToast')) showToast(lock); return; }
    // A second tap on the mode that is already armed opens its setup -- and,
    // for a squad's leader, still puts that board to the squad: a squad starts
    // on Duel whatever was lit, and this is the only tap the lit board has.
    // boardMode() sends only what the squad's roster does not already say.
    if (k === 'mode' && current === 'home' && t.classList.contains('on')) { boardMode(); go('setup'); return; }
    setField(k, v);
    // The mode is the squad's when this player leads it (D7), and so is golf's
    // tee set, changed in Match setup -- while Play with there is Your squad
    // (U3). Every change stands the whole squad down now, so the settings of a
    // match the leader plays alone, vs the computer or solo, stay theirs, and
    // the free-for-all's CPU count is never the squad's: a squad's room is
    // sized to the squad (sqModeSend).
    if (k === 'mode' || (k === 'tees' && setupSquad())) boardMode();
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
  // Every Squad box control, on one attribute, exactly like data-fr: the value
  // is the op, and an op that acts on somebody carries their id after a colon.
  if (t.dataset.sq) { sqAct(t.dataset.sq); return; }
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
  if ('launch' in t.dataset) { startGame(); return; }   // Match setup's Start Game: one tap, the exact old path
  if ('rdy' in t.dataset) { squadReadyToggle(); return; }   // home's Launch, in a squad of two or more (U3)
  if (t.dataset.go) go(t.dataset.go);
});

// A JOIN BY LINK THAT LANDED (app.js joinSquadByCode: a ?squad= link, or the
// notification tap an invite sends). The player asked to be in that squad, so
// they are shown it, on home: the box draws it and the ribbon is its Ready
// (U4; owner, 2026-10-06). A player already looking at it -- home, or the
// Manage squad window -- stays where they are, and so does one in a room's
// lobby, whose Back is Cancel: leaving it any other way strands the room.
// Only while the bay is on stage: a match is never repainted over.
function landSquad() {
  const host = $('bay');
  if (!host || !host.classList.contains('active') || current === 'home' || current === 'squad' || current === 'lobby') return;
  stack.length = 0;
  render('home');
}

window.Bay = { show: render, go, back, state, tankURL, MODES, haptic, rankFor, applyMotion, landSquad };

// refreshAccountChip() fires this the moment a session changes; the two screens
// that show the account (home chip, Bay controls row) redraw in place. Only
// while the bay is the screen on stage: a match must never be repainted over.
// The social snapshot lands from app.js — a reply, or a push the server made
// when someone else changed something. The screen that reads it redraws in
// place, and only while the bay is on stage: a match must never be repainted
// over. (Task 8 widens this to its Friends screen.)
document.addEventListener('cc:social', () => {
  const host = $('bay');
  // 'home' JOINS THE LIST because the Squad box lives there and its friends
  // online come straight out of CC_SOCIAL, and so does the Manage squad
  // window's friends column. app.js dispatches this on ws.onopen too, so a
  // socket that comes back repaints a box that greyed itself out -- the same
  // bug test/social_ui.mjs's I9 found on the Friends screen, where leaving and
  // returning was the only thing that worked.
  // MATCH SETUP AND THE MISSION BOARD JOIN IT for the same push on ws.onopen
  // and on a drop: offline they play as if there were no squad (sqTwoPlus,
  // noFit), and the squad comes back when the socket does.
  if (host && host.classList.contains('active') && (current === 'home' || current === 'squad' || current === 'settings' || current === 'friends'
    || current === 'setup' || current === 'modes')) render(current);
  // The open menu reads the snapshot too — Remove friend appears on a card the
  // moment the friendship lands, and goes when it is torn down.
  pmPaint();
});
// THE SQUAD SLOT MOVED (app.js writes window.CC_SQUAD and fires this), or the
// socket it is read on has just been introduced. Keep the device's code in step
// with the squad it is in, forget it when the squad is over for the account,
// repaint, and ask if this introduction has not been asked.
// AN END IS ACTED ON ONCE, when it arrives: storage is shared by every tab on
// the device, and this event fires again on every introduction, so acting on
// an end still standing would delete a code another tab has stored since.
let sqEndSeen = '';
document.addEventListener('cc:squad', () => {
  const sn = sq.snap, end = window.CC_SQUAD_END;
  // A ROSTER IN THE SLOT IS ON THIS SOCKET (app.js writes none with `held:
  // false`), so this tab holds its row: it records the code, and its
  // reconnects present it, which is how a socket takes its row back from a
  // dead one a proxy is still holding open (task 5). A join by code lands
  // here too: its roster reaches the slot before its answer.
  // AND A `gone` BEFORE IT WAS NOT THE LAST WORD (fix wave E9): `again` arms
  // one more question on the next return to the tab, and a squad this socket
  // now holds -- created or joined since -- has answered it. Left armed, that
  // return asked anyway, and its roster, a new object, turned an Invite the
  // create had just sent back into a live Invite (sqInvited).
  if (sn && typeof sn.code === 'string' && sn.code) { sqStore(sn.code); sqHeld = sn.code; sq.again = false; }
  // THE GUEST ROW'S SECRET (E1) follows every roster this socket holds: the
  // one it carries, or none -- a roster without one is an account's row now.
  if (sn && typeof sn.code === 'string' && SQ_CODE.test(sn.code)) sqGk = typeof sn.gk === 'string' && SQ_GK.test(sn.gk) ? { code: sn.code, gk: sn.gk } : null;
  if (end !== sqEndSeen) {
    sqEndSeen = end;
    // A NEW END IS A NEW LINE (see sqLeftSpend): its own five seconds.
    clearTimeout(sqLeftT); sqLeftT = 0; sqLeftSpent = false;
    // EVERY END TAKES THE SQUAD OFF THIS TAB, which asks bare from now on.
    // ELSEWHERE: another tab or device of this account took the row or acted
    // on the squad. OPEN: this tab was shown the squad while another socket
    // holds its row. Neither is over for the ACCOUNT, so the device's code
    // stays (see sqBack). Every other end is final, and the code goes too.
    if (end) { sqHeld = ''; if (end !== 'elsewhere' && end !== 'open') sqStore(''); }
    // Every end but `open` spends a guest row's secret (E1): `open` is a look
    // at a squad from a socket that holds no row, and moves none.
    if (end && end !== 'open') sqGk = null;
  }
  sqPaint();
  // THE MISSION BOARD WEARS THE SAME PILLS (design 5.2), so a roster that lands
  // while it is up repaints it too -- in place, and only while the bay is on
  // stage, the guard every repaint here keeps. AND THE ARMOURY, which drafts
  // for the armed mode: a leader's change of mode reaches a member there at
  // once (sqFollow), a raid's seven slots or golf's bag.
  const host = $('bay');
  if (host && host.classList.contains('active') && (current === 'modes' || current === 'armoury')) render(current);
  sqNeed();
  sqTick();
});
// THE COUNTDOWN TICKS ON SCREEN (U3): one repaint as each whole second of it
// passes, and none while no countdown runs. Each roster re-arms it from the
// time the server says is left, so it never drifts from the squad's.
let sqTickT = 0;
function sqTick() {
  clearTimeout(sqTickT); sqTickT = 0;
  const at = window.CC_SQUAD_STARTS;
  if (!(typeof at === 'number' && at > 0)) return;
  const left = at - performance.now();
  if (left < -1000) return;                         // at nought: "Starting" until the room's own frames
  sqTickT = setTimeout(() => { sqTickT = 0; sqPaint(); sqTick(); }, Math.max(20, (left % 1000 + 1000) % 1000 + 10));
}
// A SQUAD START REFUSED, PUSHED TO EVERY MEMBER (U3): a countdown that ended
// in a refusal, or an old leader's Start the seating refused (R6). The squad
// is shown stood down by the roster behind it; this says why, on the action
// line of the box and of the Manage squad window and on the ready control,
// and as a toast anywhere neither is on screen. sqStartSay names the member
// at fault when the server points at one.
document.addEventListener('cc:squadrefused', (e) => {
  const m = e.detail || {};
  const say = sqStartSay(m, socErr('squad.start', typeof m.error === 'string' ? m.error : 'unavailable'));
  sq.aerr = say; sq.serr = say;
  sqPaint();
  const host = $('bay');
  if (!(host && host.classList.contains('active') && (current === 'home' || current === 'squad')) && fn('showToast')) showToast(say);
});
// BACK TO THIS TAB. An `ended: elsewhere`, a roster this tab was only shown
// (`open`, D-UI-1), or any `gone`, may not be the last word: another tab of
// this account may have closed, or the server may still
// be checking this account's blocks at sign-in (it answers the account's other
// devices `gone` until it has). So a return to the tab asks once more -- BARE,
// which the server answers by showing the squad and moving the row here only
// when no live socket holds it, so a glance at a background tab never pulls
// the squad off the device in use. A kick or a leave is final, and a refusal
// is Retry's to clear.
function sqBack() {
  if (document.hidden || sq.err) return;
  if (sqAway() || sq.again) sqAsk(true, true);
}
window.addEventListener('focus', sqBack);
window.addEventListener('visibilitychange', sqBack);
// THE PLAYER MENU'S FOUR DOORS: a friends-list card, a search result, a LOBBY
// SEAT and an IN-MATCH CARD. The first three are inside #bay; the fourth is the
// HUD, which is why this listener is not gated on the bay being on stage the
// way the one above it is.
document.addEventListener('click', (e) => {
  const t = e.target.closest ? e.target.closest('[data-pmenu]') : null;
  if (!t) return;
  pmOpen(t.dataset.pmenu, t.dataset.pmkind, t.dataset.pmname || '', t.dataset.pmanon === '1');
});
// ESCAPE, and it dismisses ONE LAYER the way Cancel does: the confirm sheet
// hands the player back to the menu, the menu closes and the keyboard goes back
// to the card that opened it. Nobody was trapped before this — there is a Close
// button and a backdrop tap — but the only Escape in this file served the
// callsign editor, and a sheet over the battlefield is the last place to make a
// player hunt for the way out.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || (!pm && !pa)) return;
  e.preventDefault();
  if (pa) { pa = null; pmPaint(); return; }
  pmClose();
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
// Enter commits, the way it does in the callsign editor and the code field.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // The squad code field, in the Manage squad window. The join panel this
  // field replaced never had an Enter key -- this one does, because a 4-letter
  // code on a phone keyboard ends with the Go key and nothing else.
  // A HELD KEY IS ONE PRESS: autorepeat would send a code frame (and a join)
  // per repeat, enough to trip the socket's message limiter, which closes it.
  if (e.target && e.target.id === 'sqCode') { e.preventDefault(); if (!e.repeat) sqEnter(); return; }
  if (current !== 'friends') return;
  const id = e.target && e.target.id;
  if (id === 'frQ') { e.preventDefault(); frSearch(); }
  else if (id === 'frCode') { e.preventDefault(); frAddCode(); }
});
document.addEventListener('cc:account', () => {
  const host = $('bay');
  // KEYED, because refreshAccountChip() fires this event on boot, on every
  // resume and on every token refresh — app.js keys its own handler for exactly
  // this reason. Unkeyed, each event nulled gb.list AND gb.asking mid-flight and
  // the frNeed() below fired a SECOND `block op:'list'`, which spends the
  // `friend` bucket: a resume loop could rate-limit a guest out of their own
  // blocked list. app.js's accountKey() collapses every guest to '' (it keys on
  // the linked identity, which a guest has none of), so it cannot be borrowed
  // here — this list belongs to an ANONYMOUS account, and the account id is what
  // tells one guest from the next.
  const key = bayAccountKey();
  const flipped = key !== bayAccount;
  // WHO WE ARE LEAVING, captured before the assignment: the first cc:account
  // of a boot flips from '' and is not a switch away from anybody.
  const leaving = flipped ? bayAccount : '';
  bayAccount = key;
  // THE PAGE'S FIRST ACCOUNT EVENT is the boot's refreshAccountChip, and it is
  // the only one that can come AFTER the hello that introduced this identity:
  // the boot's hello reads the session's token by itself. Every later one is a
  // sign-in, link or sign-out made in the page, and app.js sends its hello
  // after this event (review T8-R1-2).
  const booting = !sqAcctSeen;
  sqAcctSeen = true;
  if (flipped) {
    // AND THE SQUAD, WHICH BELONGS TO THE ACCOUNT THAT JOINED IT (app.js drops
    // the slot itself). The stored code, and this tab's record of it, go only
    // when we are leaving a KNOWN account -- never on the boot's first
    // cc:account, which would delete the very code a reload's resume and "your
    // squad has ended" are told from.
    if (leaving) { sqStore(''); sqHeld = ''; }
    sqReset();
    // A SWITCH MADE IN THE PAGE ASKS AFTER ITS OWN HELLO, never on this event:
    // the server answers a frame for whoever the socket is when it arrives, so
    // a resume sent now is answered for the account being left. Counting this
    // introduction as asked leaves the next -- the new hello's -- to ask.
    if (!booting) sq.via = sqIntro();
    // A GUEST'S BLOCKED LIST BELONGS TO THAT GUEST. app.js drops CC_SOCIAL when
    // the account changes, for the same reason; this is the other half of it,
    // and without it a signed-out session would keep drawing the last account's
    // list.
    gb = { list: null, err: '', asking: false };
    gbPublish();
    fr.perr = ''; fr.berr = ''; fr.ferr = ''; fr.cerr = '';
    // AND THE SHEET GOES WITH IT. pmPaint() renders pmAsk() whenever `pa` is
    // set and never consults pmItems(), so a sign-out with "Report this name"
    // open left it up, over an account that no longer exists, with a Report
    // button the server would refuse. The comment here used to claim "every
    // item goes when the account does"; this is what makes that true.
    pmClose();
  }
  // AN INVITE THE RELOAD CARRIED GOES BACK TO THE ACCOUNT IT WAS SENT TO (fix
  // wave E2), and to no other: decided at the first account event that names a
  // signed-in account -- after app.js's own listener has emptied the slot for
  // this account, which runs first -- and never again. An event that names no
  // linked account (the boot's own, before the session is read) decides
  // nothing: the carry can only ever go back to its own account.
  if (sqInvCarry && acctState() === 'in') {
    const c = sqInvCarry, a = window.CC_ACCOUNT;
    sqInvCarry = null;
    if (a && a.id === c.acct && fn('socialInviteRestore')) socialInviteRestore(c);
  }
  // The open menu's items depend on who is asking — Remove friend is a linked
  // account's.
  pmPaint();
  if (host && host.classList.contains('active') && (current === 'home' || current === 'squad' || current === 'settings' || current === 'friends')) render(current);
  // A sign-in that lands WHILE Bay controls is open never re-enters the screen,
  // so render()'s entry hook would never fire and the row would go on saying
  // "sign in to choose a callsign" to somebody who just did.
  if (current === 'settings' && fn('socialNeed')) socialNeed();
  // Same for the Friends screen: a sign-in that lands while it is open never
  // re-enters it, so render()'s entry hook would never fire and the screen
  // would go on offering the sign-in card to somebody who just did.
  if (current === 'friends') frNeed();
  // And the Squad box asks for the account it now belongs to, from any screen:
  // at boot, if the hello has already marked the socket. After a switch in the
  // page this asks nothing (sq.via names this introduction already), and the
  // new hello's mark asks.
  sqNeed();
});
applyMotion();

// LOBBY FEED. renderLobby/showLobby are the game's own; wrap them so the bay
// sees every message, then let them run unchanged (they also call showScreen,
// which routes 'lobby' to the bay under the flag).
if (fn('renderLobby')) { const orig = renderLobby; renderLobby = function (m) { lobby.m = m; lobby.mode = 'host'; return orig.apply(this, arguments); }; }
// EVERY showLobby DROPS THE LAST PAYLOAD, 'host' included: app.js calls it with
// 'host' only for 'created', a NEW room whose own lobby frame has not landed
// yet, and the payload still held is the previous room's -- its mode, its
// seats and who hosted it -- which drew a Solo create's room for that frame as
// whatever room came before.
if (fn('showLobby'))   { const orig = showLobby;   showLobby   = function (mode) { lobby.mode = mode; lobby.m = null; return orig.apply(this, arguments); }; }

// BOOT. The bay is the menu: take the route in, once.
if (has('showScreen')) showScreen('home');
})();
