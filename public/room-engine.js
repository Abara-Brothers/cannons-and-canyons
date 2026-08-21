// public/room-engine.js — rooms, turns, bots, and the rules of every mode.
//
// This is the authority for a match, carved out of server.js so that ONE
// implementation drives both transports: online it is fed by a real WebSocket,
// offline it is fed by a local stand-in. A second, client-side copy of the turn
// engine would drift from this one within a batch or two — that is DEBT-002 at
// ten times the size — so there is deliberately only one.
//
// Two consequences, and neither is optional:
//
//   * This file must stay BROWSER-SAFE. No Node builtins, no bare imports, no
//     `process.`, no Buffer, no fs. test/house-rules.mjs §6 enforces it, because
//     the failure mode is silent — the server keeps working perfectly while
//     offline play breaks, and nothing else in the suite would notice.
//   * Anything the HOST owns — web push, the HTTP server, VAPID keys — stays in
//     server.js and is injected. See setPushNudge below.
//
// The transport contract is deliberately tiny. A "socket" here needs only:
//
//     ws.readyState === 1     and     ws.send(<string>)
//
// plus the few properties the engine hangs off it (`roomCode`, `seat`, and the
// quick-match `_q*` fields). Nothing else is touched, which is precisely what
// lets a plain object literal stand in for a WebSocket when there is no network.
import {
  WORLD_W, WORLD_H, MOVE_BUDGET, MOVE_STEP, MAX_HP, LAVA_Y, AIM_MIN, AIM_MAX, clampAim,
  laneBounds,
  generateTerrain, generateTrees, spawnTanks, surfaceAt, simulateShot, terrainDiff,
  weaponMenu, menuEntry, startingAmmo, WEAPON_BY_ID, tickHazards, burnTick, aiShot, mergeScorch,
  LOADOUT_POOL, validLoadout, loadoutAmmo, loadoutSizeFor,
  fireDamage, FIRE_TICK,
  BIOMES, BIOME_IDS, biomeLavaY, generateProps, generateRuins, prepareGolfHole,
  isGeneratedCallsign, callsignFromSeed,
} from './game-core.js';

// Every tunable below is read through here. `process` exists in Node and nowhere
// else, so it is reached as a PROPERTY of globalThis rather than as a bare
// identifier — a bare `process` would throw a ReferenceError in a browser before
// the guard could run. In the browser copy this is simply an empty object and
// every tunable takes its default.
const env = (globalThis['process'] || {}).env || {};

// Web push belongs to the host: it needs VAPID keys, a Node library, and a
// player on the other end of a subscription. server.js injects the real one
// during startup; the browser copy keeps this no-op, because in a solo offline
// match there is nobody to nudge but yourself.
let pushNudge = () => {};
export function setPushNudge(fn) { pushNudge = typeof fn === 'function' ? fn : () => {}; }

// Identity is a host concern too (ISSUE-003): verifying a Supabase access
// token and persisting a push subscription both need server-side keys this
// browser-safe module must never carry. The engine only ANNOUNCES — "this
// socket claims a token", "this player registered a subscription" — and the
// host decides what that means. Both default to no-ops offline.
let authSink = () => {};
export function setAuthSink(fn) { authSink = typeof fn === 'function' ? fn : () => {}; }
let pushSubSink = () => {};
export function setPushSubSink(fn) { pushSubSink = typeof fn === 'function' ? fn : () => {}; }

// Timer callbacks run DETACHED: when one fires there is nothing on the stack to
// catch a throw, so it reaches process 'uncaughtException' — and server.js's
// handler for that shuts the process down, taking EVERY live match with it, not
// just the room that faulted. server.js already hardens the two inbound entry
// points it owns and explains why; timers were the third and were bare. Most of
// what runs unattended in this file is on a timer (the bot chain, fire and gas
// ticks, drop and empty-room reclaim), so a single unexpected null in bot logic
// during one CPU match could drop every player on the server.
//
// Containment must not become concealment. Swallowing quietly would trade a
// visible crash for an invisible stall — one room silently stops advancing and
// nothing anywhere says so, which is the harder failure to diagnose and exactly
// the blind spot ISSUE-035 was. So every fault is logged AND announced to the
// host, which routes it to the same error_reports table as any server fault.
let faultSink = () => {};
export function setFaultSink(fn) { faultSink = typeof fn === 'function' ? fn : () => {}; }

// Hitting MAX_ROOMS refuses every new match with a player-visible message and,
// until 2026-08-18, recorded NOTHING server-side — the stated residual of
// RISK-014. `rooms` on /health was the only external signal, and it over-counts
// live play (empty rooms are held 30 minutes, async duels 24 hours), so the one
// number available was also the wrong one. Announce it instead; the host routes
// it to the same error_reports table as any other server fault.
let capacitySink = () => {};
export function setCapacitySink(fn) { capacitySink = typeof fn === 'function' ? fn : () => {}; }
function onTimerFault(err) {
  try { console.error('[timer] callback threw:', err && err.stack ? err.stack : err); } catch {}
  try { faultSink(err); } catch { /* the reporter must never be the second fault */ }
}
// The returned handle is the real one, so clearTimeout/clearInterval still work.
function safeTimeout(fn, ms) {
  return setTimeout(() => { try { fn(); } catch (e) { onTimerFault(e); } }, ms);
}
function safeInterval(fn, ms) {
  return setInterval(() => { try { fn(); } catch (e) { onTimerFault(e); } }, ms);
}


// How long a disconnected player may return before their tank is scuttled.
// Overridable so the test suite can exercise the forfeit path without a 2-min wait.
const RESUME_GRACE_MS = Number(env.RESUME_GRACE_MS) || 120000;
// Async games: a private duel holds a disconnected seat for a DAY — take your
// turn whenever, your opponent's push nudge brings them back.
const ASYNC_GRACE_MS = Number(env.ASYNC_GRACE_MS) || 24 * 60 * 60 * 1000;
// How long a room with NO connected human survives before it is reclaimed.
// This is what lets a solo player (vs CPU, boss, aliens, golf) swap apps or
// let the phone sleep and come back to the exact same battle — these rooms
// used to be torn down the INSTANT the socket closed, so the resume grace
// never applied to them at all. Room state is a few KB of memory; holding it
// half an hour costs nothing and nobody else is waiting on it.
const EMPTY_ROOM_GRACE_MS = Number(env.EMPTY_ROOM_GRACE_MS) || 30 * 60 * 1000;

// Cosmetic tank paints (client renders them; validate ids here).
const SKINS = ['olive', 'desert', 'jungle', 'midnight', 'arctic', 'gold'];
const SEAT_SKIN = ['olive', 'desert', 'jungle', 'midnight'];   // fallback paint per seat
const sanitizeSkin = (s, seat) => (SKINS.includes(s) ? s : SEAT_SKIN[seat % SEAT_SKIN.length]);

// ---- Callsign hygiene ----------------------------------------------------------
// Names are the one player-authored string everyone else must look at, so they
// get scrubbed here at the door: printable ASCII only, and a profanity check
// with leetspeak folded out. A dirty name is swapped for a clean callsign
// (picked by name-hash so the same input always maps to the same fallback).
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '+': 't' };
const BAD_SUB = ['fuck', 'shit', 'cunt', 'bitch', 'bastard', 'asshole', 'arsehole', 'dick', 'cock', 'pussy',
  'wank', 'twat', 'slut', 'whore', 'nigg', 'negro', 'fagg', 'dyke', 'kike', 'spic', 'chink', 'gook', 'coon',
  'paki', 'retard', 'rape', 'rapist', 'pedo', 'paedo', 'nazi', 'hitler', 'porn', 'penis', 'vagin', 'anus',
  'semen', 'jizz', 'dildo', 'blowjob', 'handjob', 'boner', 'nutsack'];
const BAD_WORD = ['ass', 'arse', 'tit', 'tits', 'cum', 'hoe', 'fag', 'anal', 'kkk', 'fap', 'smd', 'stfu', 'wtf', 'sex'];
const foldLeet = (s) => String(s).toLowerCase().split('').map(c => LEET[c] || c).join('');
const lettersOf = (s) => foldLeet(s).replace(/[^a-z]/g, '');
function isProfane(raw) {
  const flat = lettersOf(raw);
  if (BAD_SUB.some(w => flat.includes(w))) return true;
  // Short words only count as whole tokens, so "Bass Master" and "Titan" pass.
  return String(raw).toLowerCase().split(/[^a-z0-9@$!+]+/).map(lettersOf).some(t => BAD_WORD.includes(t));
}
// Names are NOT free text (ISSUE-015). A client may only send a callsign it
// rolled from the two curated lists in game-core.js; anything else is replaced,
// so no player-authored string ever reaches another player's screen or the
// shared result card. The readonly input in index.html is a convenience — THIS
// is the boundary, because a modified client can send whatever it wants.
//
// Replacement is deterministic on the rejected input: random would let a
// griefer reroll until they got something they liked, and would change a
// reconnecting player's identity mid-match.
function sanitizeName(raw, seat = 0) {
  const name = String(raw ?? '');
  if (isGeneratedCallsign(name) && !isProfane(name)) return name;
  const h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) + seat * 2654435761;
  return callsignFromSeed(h);
}

// ---- Teams ----------------------------------------------------------------------
// Boss Fight is strictly co-op: the humans are one side, the WARLORD the other,
// and NOTHING a player fires — blast, splash, fire, gas, fallout —
// may hurt their own side (their own tank included).
function sameSide(room, a, b) {
  if (room.mode !== 'boss') return false;
  const bs = bossSeatOf(room);
  return (a === bs) === (b === bs);
}

// ---- Game rooms ------------------------------------------------------------
const rooms = new Map();
let waiting = null; // a socket sitting in the quick-match queue
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// A room code off the wire is whatever the sender felt like sending. `(code ||
// '').toUpperCase()` reads fine and throws on `{"code": 123}` — a number has no
// toUpperCase — which used to reach uncaughtException and stop the process.
// The host now catches that too (batch 8.61), but the engine must not depend on
// being hosted: the SAME file runs in the browser for offline play, where there
// is no such net. Coerce, then bound the length so a megabyte string cannot be
// used to make the Map do work.
const roomCode = (v) => (typeof v === 'string' ? v : '').toUpperCase().trim().slice(0, 8);

// getRandomValues, not Math.random — the same CSPRNG `makeToken` uses a few
// lines below, which makes the old call an inconsistency rather than a decision.
// A room code is a capability: anyone holding it can take a seat in that lobby,
// and until 2026-08-18 nothing stopped one socket taking SEVERAL. Math.random is
// seeded predictably enough that guessing live codes from a 31^4 space is not
// the barrier it looks like. Rejection sampling keeps the alphabet uniform —
// `% len` would quietly bias toward the first few characters.
function makeCode() {
  let code;
  const pick = () => {
    const b = new Uint8Array(1);
    const limit = 256 - (256 % CODE_CHARS.length);   // discard the biased tail
    do { globalThis.crypto.getRandomValues(b); } while (b[0] >= limit);
    return CODE_CHARS[b[0] % CODE_CHARS.length];
  };
  do {
    code = Array.from({ length: 4 }, pick).join('');
  } while (rooms.has(code));
  return code;
}
// 12 random bytes as hex. getRandomValues rather than node:crypto randomBytes:
// it is the ONE CSPRNG that exists in both a browser and Node 19+ (CI runs 20
// and 22). Same 96 bits of entropy, same hex shape, so a resume token minted
// before this change still validates after it.
const makeToken = () => {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  for (const p of room.players) if (p && p.ws) send(p.ws, msg);
}

// How many seats are filled (lobby holes are null until the match starts).
const seatCount = (room) => room.players.filter(Boolean).length;
// Seats whose tank is still fighting.
const aliveSeats = (room) =>
  room.tanks ? room.tanks.map((t, i) => (t.alive !== false && room.hp[i] > 0 ? i : -1)).filter(i => i >= 0) : [];
const aliveFlags = (room) => (room.tanks ? room.tanks.map(t => t.alive !== false) : []);
const bossSeatOf = (room) => room.players.findIndex(p => p && p.boss);
// The one question every damage path asks. Duel/FFA: last tank standing.
// Boss raid: the humans win TOGETHER the moment the boss falls, and lose only
// when every human is gone — two live humans is not "match still on" the way
// two live enemies would be.
function matchOver(room) {
  if (!room.tanks) return false;
  // Golf has no damage path to end on. A duo match still ends if a player is
  // scuttled (disconnect forfeit); a solo round can only end via the scorecard.
  if (room.mode === 'golf') return room.players.length > 1 && aliveSeats(room).length <= 1;
  if (room.mode === 'boss') {
    const b = bossSeatOf(room);
    const bossDead = b >= 0 && room.tanks[b] && room.tanks[b].alive === false;
    const humanAlive = room.tanks.some((t, i) => i !== b && t.alive !== false && room.hp[i] > 0);
    return bossDead || !humanAlive;
  }
  if (room.horde) {
    const humanAlive = room.players.some((p, i) => p && !p.bot && room.tanks[i].alive !== false && room.hp[i] > 0);
    return room.horde.kills >= room.horde.target || !humanAlive;
  }
  return aliveSeats(room).length <= 1;
}
function lobbyPayload(room, seat) {
  return {
    type: 'lobby', code: room.code, mode: room.mode, max: room.max,
    you: seat, host: room.hostSeat,
    players: room.players.map(p => (p ? { name: p.name, skin: p.skin } : null)),
  };
}
function broadcastLobby(room) {
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p && p.ws) send(p.ws, lobbyPayload(room, i));
  }
}
// Close the lobby holes left by players who backed out, then reindex the sockets.
// ONLY safe while state === 'waiting': after startGame the seat index is baked into
// hp / ammo / tanks / facing / tokens.
function compactRoster(room) {
  if (room.state !== 'waiting') return;
  const host = room.players[room.hostSeat];
  room.players = room.players.filter(Boolean);
  room.hostSeat = Math.max(0, room.players.indexOf(host));
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.ws) p.ws.seat = i;
  }
}
// Flip any tank at 0 HP to destroyed. Single choke point — call it wherever HP drops.
function killDead(room) {
  if (!room.tanks) return;
  for (let i = 0; i < room.hp.length; i++) {
    if (room.hp[i] <= 0 && room.tanks[i].alive !== false) room.tanks[i].alive = false;
  }
}

// mode: 'duel'    -> exactly 2, auto-starts the moment the 2nd player joins
//       'ffa'     -> 2..4, the HOST starts it (or it auto-starts when it fills)
//       'boss'    -> 1..2 humans vs the WARLORD (host may start solo)
//       'golf'    -> 1..2 humans, 9 holes, no damage
//       'aliens'  -> 1..2 humans vs waves of xeno saucers
// A loadout arrives as an array of weapon ids; anything malformed becomes null
// and the seat falls back to the default kit at start.
// n defaults to the duel/FFA five. ALWAYS pass the room's real count for a
// mode that drafts more (Boss Fight and the survival waves take 7) — validating
// a 7-pick payload against 5 silently discards it and strands the player in the
// draft window for the full PICK_MS.
const sanitizeLoadout = (picks, n = 5) => (validLoadout(picks, n) ? picks.slice() : null);
const sanitizeLoadoutFor = (mode, picks) => sanitizeLoadout(picks, loadoutSizeFor(mode) || 5);
const DEFAULT_LOADOUT = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
const DEFAULT_LOADOUT7 = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley', 'buster', 'gas'];
const defaultLoadoutFor = (n) => (n >= 7 ? DEFAULT_LOADOUT7.slice() : DEFAULT_LOADOUT.slice());
function randomLoadout(n = 5) {
  const pool = LOADOUT_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
// The weapon draft happens AT THE START OF THE MATCH: anyone who arrives
// without picks gets this long to choose before the defaults are issued.
const PICK_MS = Number(env.PICK_MS || 25000);
function finishPicking(room) {
  if (!room.picking) return;
  clearTimeout(room.pickTimer);
  room.picking = false;
  const n = room.pickN;
  for (let i = 0; i < room.players.length; i++) {
    if (!room.loadouts[i]) {
      room.loadouts[i] = defaultLoadoutFor(n);
      room.ammo[i] = loadoutAmmo(room.loadouts[i]);
    }
  }
  for (let i = 0; i < room.players.length; i++) {
    send(room.players[i].ws, { type: 'pickDone', loadouts: room.loadouts, ammo: room.ammo[i], ammoSeat: i });
  }
  beginTurn(room);
}

// A socket may only own ONE room. Before this, `create` could be sent
// repeatedly: each call did rooms.set() and overwrote ws.roomCode, while
// handleClose only ever resolves the LATEST code — so every earlier room was
// orphaned, unreachable by cleanup, and never swept. Repeated creates
// exhausted the instance and OOM-killed the process, destroying every live
// match. Releasing the previous room here closes that leak at its source.
// Only a room still WAITING is torn down: a room already 'playing' belongs to
// the resume system and its own empty-room timer, and may hold an opponent.
function releasePriorRoom(ws) {
  const prev = ws && ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!prev) return;
  const seat = ws.seat;
  const mine = prev.players[seat] && prev.players[seat].ws === ws;
  if (!mine) return;
  if (prev.state !== 'waiting') return;
  // Route through handleClose instead of tearing the room down. This used to
  // call teardown() unconditionally, which destroys the HOST'S lobby when the
  // socket moving on is only a GUEST — the same bug `case 'leave'` was fixed
  // for, and harmless here only while `create` was the sole caller (a host
  // creating a new room really should end its old one). `join` now calls this
  // too, so a guest reaches it, and the unconditional teardown would have
  // become a way to destroy someone else's lobby by joining a second game.
  handleClose(ws);
  ws.roomCode = null;
  ws.seat = null;
}

// Backstop against room-count exhaustion from any source. Refusing is always
// better than an OOM that kills every match in progress — but that only holds
// if the cap is reachable BEFORE the memory runs out, and until 2026-08-15 it
// was not.
//
// `test/load.mjs` measured **~1.2–1.4 MiB per live room** (300 rooms held, then
// 150 with every bot firing; latency stayed flat at 0.8–2.2 ms throughout, so
// memory is the binding constraint, not CPU). At the old default of 500 that is
// 600–700 MiB of room state alone. A 512 MB Render Starter instance would be
// OOM-killed somewhere around 320–375 rooms — destroying every live match —
// while this guard sat at 500, never firing. The polite path was unreachable.
//
// 250 restores it: 250 × 1.4 MiB ≈ 350 MiB, plus a ~62 MiB baseline, leaves
// roughly 100 MiB of headroom for GC and request handling. It is deliberately
// conservative and safe by default — raise it with the env var once the
// instance's real RAM is confirmed (RISK-014), and nothing is lost by having
// been cautious in the meantime. For scale: production has never exceeded a
// handful of concurrent rooms.
const MAX_ROOMS = Number(env.MAX_ROOMS) || 250;

function createRoom(hostWs, name, skin, opts = {}) {
  releasePriorRoom(hostWs);
  if (rooms.size >= MAX_ROOMS) {
    // Rate-limited by the host, not here: at the cap this fires on EVERY
    // attempt, and a refusal storm must not become its own outage.
    try { capacitySink(rooms.size, MAX_ROOMS); } catch { /* never the second fault */ }
    return null;
  }
  const code = makeCode();
  const MODES = ['duel', 'ffa', 'boss', 'golf', 'aliens'];
  const mode = MODES.includes(opts.mode) ? opts.mode : 'duel';
  const max = mode === 'ffa' ? Math.max(2, Math.min(4, (opts.max | 0) || 4)) : 2;
  const room = {
    code, mode, max, hostSeat: 0,
    players: [
      { ws: hostWs, name: sanitizeName(name, 0), token: makeToken(), connected: true, dropTimer: null, skin: sanitizeSkin(skin, 0) },
    ],
    state: 'waiting',
    terrain: null, tanks: null,
    hp: [], ammo: [], facing: [],
    turn: 0, fuel: MOVE_BUDGET, seed: 0,
    clock: null,                       // only used to pace the post-shot handover
    hazards: [], hazardSeq: 1,         // lingering fire / gas areas
    fireTimer: null,                   // fire burns on its OWN clock, across turns
    biome: 'alpine', lavaY: LAVA_Y,    // per-match terrain flavour
    ruins: null, guard: null,          // indestructible concrete (ruins biome)
    props: [],                         // barrels / bunkers
    crates: [], crateSeq: 1,           // supply drops waiting on the field
    shield: [], hpMax: [],             // crate shield charges; per-seat HP ceiling
    stat: null,                        // damage dealt/received tallies for the report
    turnCount: 0,
    scorch: [],                        // permanent burn scars: merged world-x ranges [{a,b}]
    trees: [],
  };
  rooms.set(code, room);
  hostWs.roomCode = code; hostWs.seat = 0;
  return room;
}

// Current-state snapshot — used both for match start and for resume.
function snapshot(room, seat) {
  return {
    world: { w: room.worldW || WORLD_W, h: WORLD_H }, lavaY: room.lavaY || LAVA_Y,
    terrain: room.terrain.map(v => Math.round(v * 10) / 10),
    trees: room.trees,
    tanks: room.tanks.map(t => ({ x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10 })),
    weapons: room.mode === 'golf'
      // Bag order: Driver, Iron, Putter (Jordan, 8.22). The client still
      // defaults the selection to the Iron — order is presentation only.
      ? ['driver', 'golfball', 'putter'].map((id) => ({ ...menuEntry(WEAPON_BY_ID[id]), ammo: 99 }))
      : weaponMenu(),
    golf: room.golf ? {
      hole: room.golf.hole, holes: GOLF_HOLES.length, par: room.golf.par, cup: room.golf.cup, tee: room.golf.tee,
      tees: room.golf.tees, teeSet: room.golf.teeSet,
      pars: GOLF_HOLES.map(h => h.par),                       // per-hole par for the scorecard
      grid: room.golf.strokes.map(r => r.slice()),            // full per-seat x per-hole matrix
      strokes: room.golf.strokes.map(r => r[room.golf.hole - 1] || 0),
      totals: room.golf.strokes.map(r => r.reduce((a, b) => a + b, 0)),
      done: room.golf.done.slice(),
      hazards: room.golf.hazards || [],
    } : undefined,
    n: room.players.length, mode: room.mode,
    names: room.players.map(p => p.name),
    skins: room.players.map(p => p.skin),
    facing: room.facing.slice(),
    alive: aliveFlags(room),
    hp: room.hp.map(h => Math.max(0, Math.round(h))), maxHp: MAX_HP,
    hpMax: room.hpMax && room.hpMax.length ? room.hpMax : undefined,
    biome: room.biome, ruins: room.ruins ? room.ruins.ranges : undefined,
    boss: bossSeatOf(room) >= 0 ? bossSeatOf(room) : undefined,
    kinds: room.players.map(p => (p.boss ? 'mech' : p.horde ? (room.horde ? room.horde.kind : 'tank') : 'tank')),
    loadouts: room.loadouts || undefined,
    pick: room.picking ? { n: room.pickN } : undefined,
    horde: room.horde ? { kills: room.horde.kills, target: room.horde.target, wave: room.horde.wave } : undefined,
    scales: room.tanks.map(t => t.scale || 1),
    props: room.props, crates: room.crates, shield: room.shield,
    hazards: room.hazards,
    scorch: room.scorch || [],
    moveBudget: MOVE_BUDGET,
    aimRange: [AIM_MIN, AIM_MAX],
    turn: room.turn, fuel: room.fuel,
    you: seat,
    ammo: room.ammo[seat],
    token: room.players[seat].token,
    code: room.code,
  };
}

const BOSS_HP = 400;
const BOSS_SCALE = 1.8;

// ---- Horde survival ------------------------------------------------------------
// One engine, two skins: waves of AI tanks with themed kits. Three enemy seats
// cycle — a destroyed one respawns at the start of a later turn (stronger each
// wave) until the squad has put down `target` of them. All humans down = loss.
const HORDE = {
  aliens:  { kind: 'alien',  baseHp: 90,  waveHp: 18, target: 8,
             names: ['XENO-SCOUT', 'XENO-REAVER', 'XENO-HARROW'],
             kit: ['a_plasma', 'a_pods', 'a_lance'] },
};
const isHordeMode = (m) => m === 'aliens';
const hordeSeats = (room) => room.players.map((p, i) => (p && p.horde ? i : -1)).filter(i => i >= 0);

function hordeAccounting(room, aliveBefore) {
  if (!room.horde) return;
  let newKills = 0;
  for (const i of hordeSeats(room)) {
    if (aliveBefore[i] && room.tanks[i].alive === false) newKills++;
  }
  if (!newKills) return;
  room.horde.kills += newKills;
  broadcast(room, { type: 'wave', kills: room.horde.kills, target: room.horde.target, wave: room.horde.wave });
}

function hordeRespawn(room) {
  if (!room.horde || room.state !== 'playing' || matchOver(room)) return;
  const H = room.horde, cfg = HORDE[H.theme];
  const seats = hordeSeats(room);
  let aliveE = seats.filter(i => room.tanks[i].alive !== false).length;
  for (const i of seats) {
    if (room.tanks[i].alive !== false) continue;
    // never field more than remain-to-kill, and never more than the seat pool
    if (aliveE >= Math.min(seats.length, H.target - H.kills)) break;
    H.wave++;
    const hp = cfg.baseHp + H.wave * cfg.waveHp;
    // Drop the reinforcement clear of every human but INSIDE the fight: on the
    // 48k map an unconstrained roll stranded enemies beyond max weapon range
    // (~30k) where neither side could touch the other. 2.6k..20k from the
    // nearest living human keeps waves dangerous AND hittable.
    let x = 0;
    const humans = room.players.map((p, j) => (!p.horde && room.tanks[j].alive !== false ? room.tanks[j].x : null)).filter((v) => v != null);
    for (let tries = 0; tries < 24; tries++) {
      x = Math.round(2000 + Math.random() * (WORLD_W - 4000));
      const dNear = humans.length ? Math.min(...humans.map((hx) => Math.abs(hx - x))) : 10000;
      if (dNear > 2600 && dNear < 20000) break;
    }
    room.tanks[i].alive = true;
    room.tanks[i].x = x;
    room.tanks[i].y = surfaceAt(room.terrain, x);
    room.hp[i] = hp; room.hpMax[i] = hp;
    aliveE++;
    broadcast(room, {
      type: 'respawn', seat: i,
      x: Math.round(x * 10) / 10, y: Math.round(room.tanks[i].y * 10) / 10,
      hp: room.hp.map(h => Math.max(0, Math.round(h))), hpMax: room.hpMax.slice(),
      alive: aliveFlags(room), wave: H.wave, kills: H.kills, target: H.target,
    });
  }
}

// ---- Artillery Golf -----------------------------------------------------------
// 9 holes, one club, real bounces. Both players tee off from the same box; your
// TANK walks to wherever your ball rests, and the hole is done when everyone has
// sunk it (or picked up at par+4). Lowest total after 9 wins.
// Course width scales with PAR: par 3 = 150% of the battle map, par 4 = 200%,
// par 5 = 250%. Hole distances are set per par so every hole is honest: a par 3
// is one good carry, a par 4 one big + one short, a par 5 two full strokes in.
// Real course lengths: a par 4 now runs 4-5x the old yardage and a par 5
// further still, with the world sized to the hole (min 36k). The four tee sets
// slide the TEE BOX forward — the cup never moves, exactly like a real course.
const GOLF_HOLES = [
  { d: 16500,  par: 3, biome: 'alpine' }, { d: 20200,  par: 3, biome: 'desert' }, { d: 106200, par: 4, biome: 'ice' },
  { d: 17800,  par: 3, biome: 'alpine' }, { d: 132000, par: 5, biome: 'desert' }, { d: 86400,  par: 4, biome: 'ice' },
  { d: 155000, par: 5, biome: 'alpine' }, { d: 19500,  par: 3, biome: 'desert' }, { d: 124200, par: 4, biome: 'ice' },
];
const TEE_SETS = { champ: 1.0, mens: 0.92, womens: 0.84, junior: 0.72 };
const sanitizeTees = (t) => (Object.prototype.hasOwnProperty.call(TEE_SETS, t) ? t : 'mens');

function startGolf(room) {
  const n = room.players.length;
  room.seed = (Math.floor(Math.random() * 1e9)) >>> 0;
  room.golf = {
    hole: 0, par: 0, cup: null, tee: 0,
    strokes: Array.from({ length: n }, () => new Array(GOLF_HOLES.length).fill(0)),
    done: new Array(n).fill(false),
  };
  room.hp = new Array(n).fill(MAX_HP);
  room.hpMax = new Array(n).fill(MAX_HP);
  room.ammo = Array.from({ length: n }, () => ({ golfball: 99, driver: 99, putter: 99 }));
  room.shield = new Array(n).fill(0);
  room.crates = []; room.props = []; room.ruins = null; room.guard = null;
  room.facing = new Array(n).fill(1);            // every course plays left -> right
  room.hazards = []; room.scorch = []; room.turnCount = 0;
  room.state = 'playing';
  nextHole(room, true);
}

function nextHole(room, first) {
  const g = room.golf;
  g.hole++;
  const H = GOLF_HOLES[g.hole - 1];
  g.par = H.par;
  // The world fits the hole PLUS ~19.8k of runoff beyond the green — players
  // overshoot the flag, and the right edge must not lurk behind it (an
  // overshot ball should land on turf and roll, not sail out of the world).
  room.worldW = Math.max(36000, H.d + 22000);
  room.biome = H.biome;
  room.lavaY = WORLD_H + 4000;        // NO lava on any golf course — dry land only
  const seed = (room.seed + g.hole * 7919) >>> 0;
  room.terrain = generateTerrain(seed, 2, H.biome, room.worldW);
  // The cup sits at full championship distance; friendlier tee sets move the
  // TEE forward along the fairway.
  // r is the CATCH radius: the ball must come to rest inside the carved cup
  // itself (the notch spans ±200) — near misses stay out.
  g.cup = { x: Math.min(room.worldW - 2000, 2200 + H.d), r: 190 };
  // Every tee box exists on the course — championship at the back, junior at
  // the front — and each player spawns on the set the host chose.
  g.tees = {};
  for (const [set, tf2] of Object.entries(TEE_SETS)) {
    g.tees[set] = Math.max(1400, Math.round(g.cup.x - H.d * tf2));
  }
  g.teeSet = room.tees || 'mens';
  g.tee = g.tees[g.teeSet];
  // Shapes the course AND seats the hazards (1-3 sand, 0-1 water) off the same
  // per-hole seed, so every client and every resume rebuilds the identical hole.
  const prepared = prepareGolfHole(room.terrain, g.tee, g.cup.x, Object.values(g.tees), seed);
  g.cup.y = prepared.cupY;
  g.hazards = prepared.hazards;
  room.trees = generateTrees(room.terrain, seed, 2);
  // A desert hole is an OASIS course: a few palms (the client draws palms for
  // golf+desert), not a pine forest — keep roughly every fifth tree. (Every
  // third still read as a treeline at the tee.)
  if (H.biome === 'desert') room.trees = room.trees.filter((_, ti) => ti % 5 === 0);
  room.tanks = room.players.map(() => ({ x: g.tee, y: surfaceAt(room.terrain, g.tee), alive: true }));
  g.done.fill(false);
  room.hazards = []; room.scorch = [];
  room.turn = first ? Math.floor(Math.random() * room.players.length) : (g.hole - 1) % room.players.length;
  for (let i = 0; i < room.players.length; i++) {
    send(room.players[i].ws, { type: first ? 'start' : 'hole', ...snapshot(room, i) });
  }
  beginTurn(room);
}

function golfShot(room, seat, msg) {
  const g = room.golf;
  if (g.done[seat]) return;
  room.shotPending = true;          // one swing per turn (see handleFire)
  // Three clubs, one ball: any golfOnly weapon id is a legal swing; anything
  // else (or nothing) falls back to the iron.
  const clubW = WEAPON_BY_ID[msg.weapon];
  const club = clubW && clubW.golfOnly ? clubW.id : 'golfball';
  const result = simulateShot(
    { terrain: room.terrain, tanks: room.tanks, lavaY: room.lavaY, biome: room.biome,
      cup: { x: g.cup.x, r: g.cup.r, capV: 2200 },     // capV = drop-in speed; faster balls lip out
      golfHazards: g.hazards || null },                // sand plugs, water splashes (see integrate)
    { by: seat, weapon: club, angle: msg.angle, power: msg.power, dir: room.facing[seat] }
  );
  const hi = g.hole - 1;
  g.strokes[seat][hi]++;
  const rest = result.golf && result.golf.rest;
  let note = '';
  if (result.golf && result.golf.water) {
    // WATER: stroke + penalty, and — unlike OOB — the ball is DROPPED at the
    // bank the shot came in over, exactly like a real lateral hazard.
    g.strokes[seat][hi]++;
    note = 'water';
    room.tanks[seat].x = result.golf.water.x;
    room.tanks[seat].y = surfaceAt(room.terrain, result.golf.water.x);
  } else if (rest && rest[1] >= room.lavaY - 6) {
    g.strokes[seat][hi]++;               // splash! stroke + penalty, play again from here
    note = 'hazard';
  } else if (!rest) {
    g.strokes[seat][hi]++;               // sailed off the world: stroke + penalty
    note = 'oob';
  } else {
    room.tanks[seat].x = rest[0];
    room.tanks[seat].y = surfaceAt(room.terrain, rest[0]);
    if (Math.abs(rest[0] - g.cup.x) <= g.cup.r) { g.done[seat] = true; note = 'holed'; }
  }
  if (!g.done[seat] && g.strokes[seat][hi] >= g.par + 4) { g.done[seat] = true; note = note || 'capped'; }
  broadcast(room, {
    type: 'shot', by: seat, weapon: club,
    projectiles: result.projectiles,
    terrainDiff: null,
    tanks: room.tanks.map(t => ({ x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10 })),
    hp: room.hp.map(h => Math.max(0, Math.round(h))),
    damage: result.damage,
    hazards: [], alive: aliveFlags(room),
    ammo: room.ammo[seat], ammoSeat: seat,
    golf: {
      hole: g.hole, holes: GOLF_HOLES.length, par: g.par, cup: g.cup,
      tees: g.tees, teeSet: g.teeSet,
      pars: GOLF_HOLES.map(h => h.par),                       // per-hole par for the scorecard
      grid: g.strokes.map(r => r.slice()),                    // full per-seat x per-hole matrix
      strokes: g.strokes.map(r => r[hi]),
      totals: g.strokes.map(r => r.reduce((a, b) => a + b, 0)),
      done: g.done.slice(), note, noteSeat: seat,
      hazards: g.hazards || [],
    },
  });
  clearTimeout(room.clock);
  // The turn does NOT end while the ball is moving: hold the handover for the
  // replay's full flight+roll (path plays ~9ms a point on the clients).
  // Real rolling can run well past the old cap — the hold must cover the whole
  // replay (maxT 60s of sim = 1800 points ≈ 16.2s of playback, plus settle).
  const ptsMs = ((result.projectiles[0] && result.projectiles[0].path.length) || 0) * 9;
  // Cap raised with the roll retune + maxT 100: the longest legal replay is
  // ~3000 points ≈ 26s of playback — the hold must outlast it.
  room.clock = safeTimeout(() => { room.clock = null; golfAdvance(room, seat); }, 1100 + Math.min(30000, Math.round(ptsMs)));
}

function golfAdvance(room, by) {
  if (room.state !== 'playing') return;
  const g = room.golf;
  if (g.done.every(Boolean)) {
    if (g.hole >= GOLF_HOLES.length) return finishGolf(room);
    return nextHole(room, false);
  }
  const n = room.players.length;
  let t = by;
  do { t = (t + 1) % n; } while (g.done[t]);
  room.turn = t;
  beginTurn(room);
}

function finishGolf(room) {
  room.state = 'over';
  clearTimeout(room.clock); clearTimeout(room.botTimer);
  const totals = room.golf.strokes.map(r => r.reduce((a, b) => a + b, 0));
  const parTotal = GOLF_HOLES.reduce((a, h) => a + h.par, 0);
  let winner = 0;
  if (totals.length > 1) {
    const best = Math.min(...totals);
    winner = totals.filter(t => t === best).length === 1 ? totals.indexOf(best) : -1;
  }
  broadcast(room, {
    type: 'gameover', winner, team: null,
    hp: room.hp.map(h => Math.max(0, Math.round(h))), alive: aliveFlags(room),
    golf: { totals, parTotal, pars: GOLF_HOLES.map(h => h.par), strokes: room.golf.strokes, done: room.golf.done.slice() },
  });
}

function startGame(room) {
  if (room.mode === 'golf') return startGolf(room);
  // Boss raid: the WARLORD occupies the LAST seat, appended once (a rematch
  // reuses it). It's a bot player, so every existing bot path just works.
  if (room.mode === 'boss' && !room.players.some(p => p && p.boss)) {
    room.players.push({
      ws: null, bot: true, boss: true, difficulty: 'boss', name: 'WARLORD-7',
      token: makeToken(), connected: true, dropTimer: null, skin: 'midnight',
    });
    room.vsBot = true;
  }
  // Horde survival: three themed enemy seats join once.
  if (isHordeMode(room.mode) && !room.players.some(p => p && p.horde)) {
    const cfg = HORDE[room.mode];
    for (const nm of cfg.names) {
      room.players.push({
        ws: null, bot: true, horde: true, difficulty: 'medium', name: nm,
        token: makeToken(), connected: true, dropTimer: null, skin: 'jungle',
      });
    }
    room.vsBot = true;
  }
  const n = room.players.length;
  room.seed = (Math.floor(Math.random() * 1e9)) >>> 0;
  // Biome roulette — every match a different battlefield flavour.
  room.biome = BIOME_IDS[Math.floor(Math.random() * BIOME_IDS.length)];
  room.lavaY = biomeLavaY(room.biome);
  // featMul 2: twice the massifs/canyons for the doubled 48k battlefield.
  // last arg: every combat map gets 1-2 canyons. Golf (startGolf) does not.
  room.terrain = generateTerrain(room.seed, n, room.biome, undefined, 2, true);
  // Order matters: ruins and bunkers RESHAPE the terrain, so they go before the
  // trees are placed and before the tanks are seated on the final surface.
  room.ruins = (BIOMES[room.biome] || {}).ruins ? generateRuins(room.seed, room.terrain, n) : null;
  room.guard = room.ruins ? room.ruins.guard : null;
  room.props = generateProps(room.seed, room.terrain, n, room.biome);
  room.trees = generateTrees(room.terrain, room.seed, n, 420, 24000);   // tree budget scaled to 48k
  room.tanks = spawnTanks(room.terrain, room.seed, n);   // ordered left -> right
  // Horde: the pack must START in reach too. Reseat every enemy 6k..19k from
  // the nearest human lane (alternating sides where the map allows) — the 48k
  // spawn spread otherwise opens 96% of matches with somebody beyond max range.
  if (room.mode === 'aliens') {
    const humanXs = room.players.map((p, j) => (!p.horde ? room.tanks[j].x : null)).filter((v) => v != null);
    room.players.forEach((p, j) => {
      if (!p.horde) return;
      const hx = humanXs[j % Math.max(1, humanXs.length)] ?? WORLD_W / 2;
      for (let tries = 0; tries < 30; tries++) {
        const side = (j + tries) % 2 === 0 ? 1 : -1;
        const cand = Math.round(hx + side * (6000 + Math.random() * 13000));
        if (cand < 2000 || cand > WORLD_W - 2000) continue;
        if (room.tanks.some((t, k) => k !== j && Math.abs(t.x - cand) < 2600)) continue;
        room.tanks[j].x = cand;
        break;
      }
      room.tanks[j].y = surfaceAt(room.terrain, room.tanks[j].x);
    });
  }
  room.hp = new Array(n).fill(MAX_HP);
  room.hpMax = new Array(n).fill(MAX_HP);
  room.crates = []; room.crateSeq = 1; room.crateDrops = 0;
  room.shield = new Array(n).fill(0);
  room.turnCount = 0; room.bossShots = 0;
  room.stat = { dealt: new Array(n).fill(0), received: new Array(n).fill(0) };
  const bSeat = bossSeatOf(room);
  if (bSeat >= 0) {                       // the mecha is a bigger, tougher target
    room.tanks[bSeat].scale = BOSS_SCALE;
    room.hp[bSeat] = BOSS_HP;
    room.hpMax[bSeat] = BOSS_HP;
  }
  if (isHordeMode(room.mode)) {
    const cfg = HORDE[room.mode];
    room.horde = { theme: room.mode, kind: cfg.kind, kills: 0, target: cfg.target, wave: 1 };
    for (const i of hordeSeats(room)) {
      const hp = cfg.baseHp + cfg.waveHp;
      room.hp[i] = hp; room.hpMax[i] = hp;
    }
  } else room.horde = null;
  // EVERY combat mode drafts a loadout now (5 picks; Boss Fight and the
  // survival modes 7). A seat that pre-supplied picks (or is a bot) is ready
  // instantly; everyone else gets the pick screen and PICK_MS to choose.
  room.pickN = loadoutSizeFor(room.mode);
  room.loadouts = room.players.map((pl) => {
    if (pl.bot) return pl.boss || pl.horde ? null : randomLoadout(room.pickN);
    return sanitizeLoadout(pl.loadout, room.pickN);
  });
  room.ammo = Array.from({ length: n }, (_, i) => (room.loadouts[i] ? loadoutAmmo(room.loadouts[i]) : startingAmmo()));
  room.picking = room.players.some((pl, i) => !pl.bot && !room.loadouts[i]);
  // Everyone starts turned toward the middle of the map. (n=2 -> [1, -1], as before.)
  room.facing = room.tanks.map((_, i) => (i < n / 2 ? 1 : -1));
  room.hazards = []; room.hazardSeq = 1; room.scorch = [];
  // A HUMAN always opens against bots. Losing the coin toss to a CPU means
  // watching a shell land before you have touched anything — in vs-CPU that is
  // the player's first ever impression of the game, and half the time it was
  // "the computer went first". Random is still right human-vs-human, where a
  // coin toss is fair rather than deflating.
  const firstHuman = room.players.findIndex(pl => pl && !pl.bot);
  const hasBot = room.players.some(pl => pl && pl.bot);
  room.turn = (hasBot && firstHuman >= 0) ? firstHuman : Math.floor(Math.random() * n);
  room.state = 'playing';
  for (let i = 0; i < n; i++) send(room.players[i].ws, { type: 'start', ...snapshot(room, i) });
  if (room.picking) {
    clearTimeout(room.pickTimer);
    room.pickTimer = safeTimeout(() => finishPicking(room), PICK_MS);
  } else {
    beginTurn(room);
  }
}

// No shot-clock: players take as long as they like. Turns only advance on fire.
function beginTurn(room) {
  room.fuel = MOVE_BUDGET;
  room.shotPending = false;         // a fresh turn re-arms the one allowed shot
  room.turnCount = (room.turnCount || 0) + 1;
  // Every path that hands out a turn lands here — including the match opener,
  // which never passes through advance(). The survival rotation needs to know
  // which human went last so co-op partners keep alternating.
  if (room.players[room.turn] && !room.players[room.turn].bot) room.lastHumanTurn = room.turn;
  hordeRespawn(room);
  maybeDropCrate(room);
  // A drafted player who is completely dry gets one emergency cannon shell —
  // the match must always be able to end.
  if (room.loadouts && room.loadouts[room.turn] && room.ammo[room.turn]) {
    const a = room.ammo[room.turn];
    if (Object.values(a).every(v => !v)) a.cannon = 1;
  }
  broadcast(room, {
    type: 'turn', turn: room.turn, fuel: room.fuel, alive: aliveFlags(room),
    ammo: room.ammo[room.turn], ammoSeat: room.turn,
  });
  pushNudge(room, room.turn);
  scheduleBot(room);
}

// ---- Supply crates -----------------------------------------------------------
// The reward for spending fuel. A crate parachutes onto open ground every few
// turns; DRIVE within reach of it to crack it open. Contents: the crate-only
// Railgun (1 shot per crate), +1 of a random limited weapon, a one-blast shield,
// or a field repair. Positions are broadcast, so both clients render the drop.
const CRATE_KINDS = ['railgun', 'ammo', 'shield', 'repair'];
const CRATE_AMMO_POOL = ['mortar', 'volley', 'cluster', 'napalm', 'airstrike', 'buster', 'teleport'];
const CRATE_REACH = 380;
// Every NPC holds its aim for a beat before firing — a human-readable tell.
// Tests shrink it via the env knob so suites stay fast.
const BOT_FIRE_MS = Number(env.BOT_FIRE_MS || 1500);

function maybeDropCrate(room) {
  if (room.mode === 'golf' || room.state !== 'playing') return;
  if (room.turnCount < 3 || (room.turnCount - 3) % 4 !== 0) return;   // turn 3, 7, 11, ...
  if (room.crates.length >= 2) return;
  if ((room.crateDrops || 0) >= 4) return;           // hard cap: 4 drops per match
  // Sample inside the battle envelope (tank spread + 3k each side) — a random
  // point on the whole 48k map put 73% of drops beyond a turn's drive.
  const live = room.tanks.filter((t, i) => t.alive !== false && room.players[i]);
  const lo = Math.max(1800, Math.min(...live.map((t) => t.x)) - 3000);
  const hi = Math.min(WORLD_W - 1800, Math.max(...live.map((t) => t.x)) + 3000);
  for (let tries = 0; tries < 14; tries++) {
    const x = Math.round(lo + Math.random() * Math.max(1, hi - lo));
    const clearTanks = room.tanks.every((t, i) => t.alive === false || Math.abs(t.x - x) > 2000);
    const clearCrates = room.crates.every(c => Math.abs(c.x - x) > 800);
    if (!clearTanks || !clearCrates) continue;
    const kind = CRATE_KINDS[Math.floor(Math.random() * CRATE_KINDS.length)];
    const crate = { id: room.crateSeq++, x, y: Math.round(surfaceAt(room.terrain, x) * 10) / 10, kind };
    room.crates.push(crate);
    room.crateDrops = (room.crateDrops || 0) + 1;
    broadcast(room, { type: 'crate', crate });
    return;
  }
}

// Award a crate's contents to a seat, however it was opened (driven over, or
// SHOT open — a blast near a crate cracks it and the SHOOTER collects).
function applyCrate(room, seat, c, how) {
  let detail = '';
  if (c.kind === 'railgun') {
    room.ammo[seat].railgun = (room.ammo[seat].railgun || 0) + 1;
    detail = 'RAILGUN ×1';
  } else if (c.kind === 'ammo') {
    const wid = CRATE_AMMO_POOL[Math.floor(Math.random() * CRATE_AMMO_POOL.length)];
    room.ammo[seat][wid] = (room.ammo[seat][wid] || 0) + 1;
    detail = `+1 ${(WEAPON_BY_ID[wid] || {}).name || wid}`;
  } else if (c.kind === 'shield') {
    room.shield[seat] = 1;
    detail = 'SHIELD UP';
  } else {          // repair
    const cap = (room.hpMax && room.hpMax[seat]) || MAX_HP;
    room.hp[seat] = Math.min(cap, Math.round(room.hp[seat] + 35));
    detail = '+35 Health';
  }
  broadcast(room, {
    type: 'crateTaken', id: c.id, seat, kind: c.kind, detail, how: how || 'drive',
    hp: room.hp.map(h => Math.max(0, Math.round(h))),
    shield: room.shield.slice(),
    ammo: room.ammo[seat], ammoSeat: seat,
  });
}

function pickupCrates(room, seat) {
  const tank = room.tanks[seat];
  for (let i = room.crates.length - 1; i >= 0; i--) {
    const c = room.crates[i];
    if (Math.abs(c.x - tank.x) > CRATE_REACH) continue;
    room.crates.splice(i, 1);
    applyCrate(room, seat, c, 'drive');
  }
}

// Blasts crack crates open for the SHOOTER; crates also re-settle onto whatever
// is left of the ground after the terrain has been reshaped.
function cratesAfterShot(room, seat, result) {
  const dets = (result.projectiles || []).map(p => p.det).filter(Boolean);
  for (let i = room.crates.length - 1; i >= 0; i--) {
    const c = room.crates[i];
    const hit = dets.some(d => Math.abs(d.x - c.x) <= Math.max(260, (d.r || 0) * 0.9) && Math.abs(d.y - c.y) < 2600);
    if (hit) {
      room.crates.splice(i, 1);
      applyCrate(room, seat, c, 'shot');
      continue;
    }
    c.y = Math.round(surfaceAt(room.terrain, c.x) * 10) / 10;   // fall with the ground
  }
}

// ---- AI opponent -------------------------------------------------------------
// When it's the CPU's turn, "think" briefly then fire. Only runs while the human
// opponent is connected, so a mid-turn disconnect pauses the bot until resume.
function scheduleBot(room) {
  const cur = room.players[room.turn];
  if (!room.vsBot || room.state !== 'playing' || !cur || !cur.bot) return;
  if (!room.players.some(p => p && !p.bot && p.connected)) return;   // nobody watching
  clearTimeout(room.botTimer); clearInterval(room.botWalker);
  // Survival enemies keep the pressure up: three of them share the clock, so
  // each thinks, walks and fires on a much tighter cycle than a duel CPU.
  const quick = cur.horde;
  // Stay frozen until every client has finished WATCHING the previous shot —
  // an NPC that starts driving mid-replay reads as moving on the human's turn.
  // Scaled by the test knob (BOT_FIRE_MS) so fast suites stay fast.
  const watch = Math.max(0, (room.replayUntil || 0) - Date.now()) * Math.min(1, BOT_FIRE_MS / 1500);
  room.botTimer = safeTimeout(() => botAct(room), watch + (quick ? 220 + Math.random() * 240 : 850 + Math.random() * 750));
}

// Bots want the supply drops too. If a crate is inside this turn's fuel budget,
// the bot spends its move driving for it (picking it up on arrival via the same
// pickupCrates path a human uses), THEN takes its shot. Humans see the drive as
// ordinary move broadcasts, so it reads as intent, not teleporting.
function botAct(room) {
  if (room.state !== 'playing') return;
  const seat = room.turn;
  const bot = room.players[seat];
  if (!bot || !bot.bot) return;
  const me = room.tanks[seat];
  // 1) A reachable crate outranks tactics — supplies win fights.
  let target = null, best = Infinity;
  for (const c of room.crates) {
    const d = Math.abs(c.x - me.x);
    if (d < best && d <= MOVE_BUDGET - 200) { best = d; target = c; }
  }
  if (target && best > CRATE_REACH - 40) {
    return botWalk(room, seat, target.x > me.x ? 1 : -1, { crateId: target.id, crateX: target.x });
  }
  // 2) Otherwise reposition. Every bot — the WARLORD included — moves most
  //    turns: range-keeping with a coin flip on top so it can't be pattern-read.
  const plan = botPlan(room, seat);
  if (!plan) return botFire(room);
  botWalk(room, seat, plan.dir, { steps: plan.steps });
}

// Distance-keeping with deliberate noise. Close-range bots usually break away,
// long-range bots usually close in, mid-range bots drift — and one turn in ten
// the whole plan is inverted as a feint, so humans can't lead their shots on a
// predicted heading.
function botPlan(room, seat) {
  const me = room.tanks[seat];
  const meP = room.players[seat];
  let foe = null, d = Infinity;
  for (let i = 0; i < room.tanks.length; i++) {
    if (i === seat || room.tanks[i].alive === false) continue;
    if (sameSide(room, seat, i)) continue;
    if (meP.horde && room.players[i] && room.players[i].horde) continue;   // the pack ignores the pack
    const dd = Math.abs(room.tanks[i].x - me.x);
    if (dd < d) { d = dd; foe = room.tanks[i]; }
  }
  if (!foe) return null;
  const toward = foe.x > me.x ? 1 : -1;
  const r = Math.random();
  let dir = 0;
  if (meP.boss) {
    // The WARLORD moves with intent: healthy, it stalks its mark into
    // mid-range where the gatling and magma do their work; wounded, it opens
    // the gap and leans on the spear and the slam.
    const hurt = room.hp[seat] / (room.hpMax[seat] || 400) < 0.35;
    if (hurt)            dir = d < 12000 ? -toward : 0;
    else if (d > 7000)   dir = toward;
    else if (d < 3800)   dir = -toward;
    else                 dir = r < 0.4 ? toward : 0;
  } else {
    if (d < 3400)       dir = r < 0.62 ? -toward : (r < 0.82 ? toward : 0);
    else if (d > 13000) dir = r < 0.62 ? toward : (r < 0.82 ? -toward : 0);
    else                dir = r < 0.34 ? toward : (r < 0.62 ? -toward : 0);
    if (r > 0.9) dir = -dir;                                               // the feint
  }
  if (me.x < 2200) dir = 1; else if (me.x > (room.worldW || WORLD_W) - 2200) dir = -1;
  if (!dir) return null;
  const steps = meP.horde ? 20 + Math.floor(Math.random() * 18) : 8 + Math.floor(Math.random() * 22);
  return { dir, steps };
}

// Drive, then shoot. One walker per room; it hands off to botFire when the
// crate is collected, the step budget is spent, or the tank runs out of fuel.
function botWalk(room, seat, dir, opts = {}) {
  clearInterval(room.botWalker);
  let steps = opts.steps ?? 999;
  room.botWalker = safeInterval(() => {
    if (room.state !== 'playing' || room.turn !== seat) { clearInterval(room.botWalker); return; }
    const crateGone = opts.crateId != null && !room.crates.some(c => c.id === opts.crateId);
    const arrived = opts.crateX != null && Math.abs(opts.crateX - room.tanks[seat].x) <= CRATE_REACH - 40;
    if (crateGone || arrived || --steps < 0 || room.fuel < MOVE_STEP) {
      clearInterval(room.botWalker);
      botFire(room);
      return;
    }
    handleMove(room, seat, dir);
  }, 45);
}

function botFire(room) {
  if (room.state !== 'playing') return;
  const seat = room.turn;
  const bot = room.players[seat];
  if (!bot || !bot.bot) return;
  // The WARLORD reads the range to its nearest living target and picks from its
  // kit: rail lance / missile rack at distance, autocannon and flame up close,
  // and every 4th shot a seismic slam whatever the range.
  let wid = 'cannon';
  // Duel / free-for-all bots fight with their LOADOUT, not an endless cannon:
  // most turns they pick a random armed weapon from their kit (that's what
  // makes them read as unpredictable), holding the nuke until there's safe
  // distance and leaving Earthworks/Teleport alone (the gunnery brain can't
  // reason about either). Cannon stays the fallback sidearm.
  if (!bot.boss && !bot.horde && (room.mode === 'duel' || room.mode === 'ffa')) {
    const a = room.ammo[seat] || {};
    const me = room.tanks[seat];
    let dNear = Infinity;
    for (let i = 0; i < room.tanks.length; i++) {
      if (i === seat || room.tanks[i].alive === false) continue;
      dNear = Math.min(dNear, Math.abs(room.tanks[i].x - me.x));
    }
    const usable = Object.keys(a).filter(id =>
      (a[id] || 0) > 0 && id !== 'wall' && id !== 'teleport' && !(id === 'nuke' && dNear < 5200));
    if (usable.length && Math.random() < 0.75) wid = usable[Math.floor(Math.random() * usable.length)];
  }
  if (bot.horde && room.horde) {
    const cfg = HORDE[room.horde.theme];
    const idx = hordeSeats(room).indexOf(seat);
    // Each enemy has a signature weapon, with a change-up every third shot.
    wid = cfg.kit[(idx + (room.turnCount % 3 === 0 ? 1 : 0)) % cfg.kit.length];
    // The pack is CHAFF, not snipers: now that every enemy seats in range,
    // closes with real strides and aims with range-compensated jitter, medium+
    // scatter made solo survival mathematically impossible (3 accurate guns vs
    // one 150hp tank). Waves 1-2 spray, wave 3+ tightens up.
    bot.difficulty = room.horde.wave >= 3 ? 'medium' : 'easy';
  }
  if (bot.boss) {
    room.bossShots = (room.bossShots || 0) + 1;
    const me = room.tanks[seat];
    // Target selection: the WARLORD spreads its fire — a fresh RANDOM living
    // human every turn, with a strong lean (75%) toward whoever it did NOT
    // just shell, so a two-player squad sees the heat cycle between them
    // instead of one player being tunnel-visioned to death (the old rule
    // locked onto the lowest-HP human until they dropped). The gunnery brain
    // aims at the nearest living tank, so every other human is masked off the
    // field.
    const humans = room.players.map((p, i) => i)
      .filter(i => i !== seat && !room.players[i].bot && room.tanks[i].alive !== false && room.hp[i] > 0);
    let mark = -1;
    if (humans.length) {
      const fresh = humans.filter(i => i !== room.bossMark);
      const pool = fresh.length && Math.random() < 0.75 ? fresh : humans;
      mark = pool[Math.floor(Math.random() * pool.length)];
    }
    if (mark >= 0) room.bossMark = mark;
    const d = mark >= 0 ? Math.abs(room.tanks[mark].x - me.x) : Infinity;
    // Cluster punish: two humans bunched together eat a Seismic Slam.
    const bunched = humans.length > 1 && humans.some(a2 =>
      humans.some(b2 => a2 !== b2 && Math.abs(room.tanks[a2].x - room.tanks[b2].x) < 2600));
    const hurt = room.hp[seat] / (room.hpMax[seat] || 400) < 0.35;   // enraged
    if (bunched) wid = 'b_quake';
    else if (hurt) wid = room.bossShots % 2 ? 'b_spear' : 'b_quake';  // heavy hitters only
    else if (room.bossShots % 4 === 0) wid = 'b_quake';
    else if (d > 11000) wid = room.bossShots % 2 ? 'b_spear' : 'b_hellstorm';
    else if (d > 4500) wid = ['b_gatling', 'b_hellstorm', 'b_magma'][room.bossShots % 3];
    else wid = room.bossShots % 2 ? 'b_magma' : 'b_gatling';
  }
  // Horde enemies hunt HUMANS (packmates masked); the WARLORD hunts its MARK
  // (everyone else masked), so the weakest survivor takes the heat.
  let field = room.tanks;
  if (bot.horde) {
    field = room.tanks.map((t, j) => (j !== seat && room.players[j] && room.players[j].horde ? { ...t, alive: false } : t));
  } else if (bot.boss && room.bossMark != null && room.tanks[room.bossMark] && room.tanks[room.bossMark].alive !== false) {
    field = room.tanks.map((t, j) => (j !== seat && j !== room.bossMark ? { ...t, alive: false } : t));
  }
  const shot = aiShot(room.terrain, field, seat, bot.difficulty, room.facing[seat], wid);
  // Turn the turret toward its target, then show the barrel swing, then fire.
  if (shot.dir && shot.dir !== room.facing[seat]) {
    room.facing[seat] = shot.dir;
    broadcast(room, { type: 'face', seat, dir: shot.dir });
  }
  broadcast(room, { type: 'aim', seat, angle: shot.angle, power: shot.power, weapon: shot.weapon });
  room.botTimer = safeTimeout(() => {
    if (room.state === 'playing' && room.turn === seat) resolveFire(room, seat, shot.weapon, shot.angle, shot.power);
  }, bot.horde ? Math.min(550, BOT_FIRE_MS) : BOT_FIRE_MS);
}

// Unlimited shots — the match only ends when a tank is destroyed.
function advance(room, by) {
  killDead(room);
  if (matchOver(room)) return endGame(room);
  const n = room.players.length;
  let t = -1;
  // SURVIVAL (Jordan, 8.22): the pack doesn't gang up between your turns —
  // after a human acts, exactly ONE randomly chosen living alien replies,
  // then it is a human's go again. With two defenders they alternate:
  // H1 -> alien -> H2 -> alien. Falls through to the normal ring whenever a
  // side has nobody left standing (endGame handles the human side anyway).
  if (isHordeMode(room.mode)) {
    const living = (pred) => room.players
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => p && room.tanks[i].alive !== false && pred(p));
    const aliens = living(p => p.bot), humans = living(p => !p.bot);
    const wasBot = !!(room.players[by] && room.players[by].bot);
    if (!wasBot && aliens.length) {
      t = aliens[Math.floor(Math.random() * aliens.length)].i;
    } else if (wasBot && humans.length) {
      // Next human in ring order after the LAST human turn, so co-op partners
      // keep alternating even though aliens interleave.
      const after = room.lastHumanTurn ?? by;
      t = humans.map(h => h.i).find(i => i > after) ?? humans[0].i;
    }
  }
  if (t < 0) {
    t = by;
    do { t = (t + 1) % n; } while (room.tanks[t].alive === false);   // terminates: >=2 alive
  }
  room.turn = t;
  beginTurn(room);
}

function endGame(room) {
  room.state = 'over';
  clearTimeout(room.clock);
  clearTimeout(room.botTimer);
  clearInterval(room.botWalker);
  clearInterval(room.dotTimer); room.dotTimer = null;
  clearInterval(room.fireTimer); room.fireTimer = null;
  killDead(room);
  const live = aliveSeats(room);
  let winner = live.length === 1 ? live[0] : -1;   // 0 left = mutual destruction
  let team = null;
  if (room.horde) {
    const humanAlive = room.players.some((p, i) => p && !p.bot && room.tanks[i].alive !== false);
    team = room.horde.kills >= room.horde.target && humanAlive ? 'players' : 'horde';
    winner = -1;
  }
  if (room.mode === 'boss') {
    const b = bossSeatOf(room);
    const bossDead = b >= 0 && room.tanks[b].alive === false;
    const humanAlive = room.tanks.some((t, i) => i !== b && t.alive !== false);
    team = bossDead && humanAlive ? 'players' : bossDead ? 'draw' : 'boss';
    winner = team === 'players' ? room.tanks.findIndex((t, i) => i !== b && t.alive !== false)
           : team === 'boss' ? b : -1;
  }
  broadcast(room, {
    type: 'gameover',
    hp: room.hp.map(h => Math.max(0, Math.round(h))),
    alive: aliveFlags(room),
    winner, team,
    stats: room.stat ? { dealt: room.stat.dealt.map(Math.round), received: room.stat.received.map(Math.round) } : undefined,
    loot: team === 'players',        // slaying the WARLORD pays out
  });
}

function handleFire(room, seat, msg) {
  if (room.state !== 'playing' || room.turn !== seat || room.picking) return;
  // ONE SHOT PER TURN. `room.turn` is NOT reassigned when a shot resolves — the
  // handover waits 300ms, then any fire/gas burn (up to 5s), and in golf the
  // whole ball roll (up to 30s). For that entire window room.turn is still the
  // firing seat, so without this flag every extra `fire` passed the guard above
  // and resolved again — unlimited shots per turn with the unlimited cannon.
  // Cleared in beginTurn(), the single choke point through which every granted
  // turn passes (startGame, advance, golfAdvance, finishPicking).
  if (room.shotPending) return;
  if (room.mode === 'golf') return golfShot(room, seat, msg);   // one club, no ammo
  const w = WEAPON_BY_ID[msg.weapon];
  if (!w) return;
  const pl = room.players[seat];
  if ((w.bossOnly || w.aiOnly) && !(pl && pl.bot)) return;   // AI kits are theirs alone
  if (w.golfOnly && room.mode !== 'golf') return;
  if (!w.bossOnly && (room.ammo[seat][w.id] || 0) <= 0) return;
  resolveFire(room, seat, w.id, msg.angle, msg.power);
}

// KILLCAM — purely presentational. If this shot ends the match, tell both clients
// WHICH detonation is the fatal one so their slow-motion finish is identical.
// Nothing here decides damage: it only names a projectile index already in the
// payload. Lives here on purpose — game-core stays pure.
function buildKillcam(room, result, aliveBefore) {
  if (!matchOver(room)) return null;                        // match carries on
  const now = aliveFlags(room);
  const fell = [];
  for (let i = 0; i < now.length; i++) if (aliveBefore[i] && !now[i]) fell.push(i);
  if (!fell.length) return null;                            // nobody died to THIS blast
  // Mutual destruction: the worst-hit casualty is the star of the shot.
  const seat = fell.reduce((a, b) => ((result.damage[b] || 0) > (result.damage[a] || 0) ? b : a));
  const tk = result.tanks[seat];
  const withDet = result.projectiles
    .map((p, i) => ({ i, p, d: Math.hypot(p.det ? p.det.x - tk.x : 1e9, p.det ? p.det.y - tk.y : 1e9) }))
    .filter(e => e.p.det);
  if (!withDet.length) return null;
  // Prefer a detonation that actually reached the victim; among those, the one
  // that lands LAST in playback order — that's the one the eye reads as the kill.
  const inReach = withDet.filter(e => e.d <= Math.max(900, e.p.det.r * 1.5));
  const pick = (inReach.length ? inReach : [withDet.reduce((a, b) => (b.d < a.d ? b : a))])
    .reduce((a, b) => (((b.p.delay || 0) + b.p.path.length) > ((a.p.delay || 0) + a.p.path.length) ? b : a));
  return { seat, proj: pick.i, x: pick.p.det.x, y: pick.p.det.y };
}

// Shared shot resolution — used by both the human 'fire' message and the bot.
function resolveFire(room, seat, weaponId, angle, power) {
  const w = WEAPON_BY_ID[weaponId] || WEAPON_BY_ID.cannon;
  room.shotPending = true;          // this turn's shot is spent (see handleFire)
  clearTimeout(room.clock);
  const before = room.terrain.slice();
  const aliveBefore = aliveFlags(room);   // snapshot for the killcam (who this shot kills)
  const result = simulateShot(
    { terrain: room.terrain, tanks: room.tanks,
      lavaY: room.lavaY, biome: room.biome, guard: room.guard, props: room.props,
      crates: room.crates,   // shells collide with the crate outline mid-flight
      ruins: room.ruins ? room.ruins.ranges : undefined },
    { by: seat, weapon: w.id, angle, power, dir: room.facing[seat] }
  );

  if (w.ammo < 99) room.ammo[seat][w.id] = Math.max(0, (room.ammo[seat][w.id] || 0) - 1);
  // No friendly fire in Boss Fight: a teammate caught in your blast walks away.
  for (let i = 0; i < result.damage.length; i++) {
    if (sameSide(room, seat, i)) result.damage[i] = 0;
  }
  // A supply-crate shield soaks 65% of the next blast that actually hurts you,
  // then breaks. Applied BEFORE the hp loop so the wire damage, the floaters and
  // the hp all agree; fire bites and lava bypass it deliberately.
  const shieldPop = new Array(room.hp.length).fill(false);
  for (let i = 0; i < room.hp.length; i++) {
    if ((result.damage[i] || 0) > 0 && (room.shield[i] || 0) > 0) {
      room.shield[i] = 0;
      result.damage[i] = Math.round(result.damage[i] * 0.35);
      shieldPop[i] = true;
    }
  }
  // Blast damage hits health directly (self-damage counts too).
  for (let i = 0; i < room.hp.length; i++) room.hp[i] -= (result.damage[i] || 0);
  if (room.stat) for (let i = 0; i < room.hp.length; i++) {
    const d = result.damage[i] || 0;
    if (d <= 0) continue;
    room.stat.received[i] += d;
    if (i !== seat) room.stat.dealt[seat] += d;
  }
  const diff = terrainDiff(before, room.terrain);

  // Age out expired hazard areas, then add the ones this shot just created.
  // (Fire/gas damage is NOT applied here — it's the real-time burn below.)
  const now = Date.now();
  const tick = tickHazards(room.hazards, room.tanks, now);
  room.hazards = tick.alive;
  for (const hz of (result.newHazards || [])) {
    const rec = { id: room.hazardSeq++, owner: seat, ...hz };
    // The ONE place a wall-clock deadline is minted. game-core emits a duration
    // (`ms`); the server owns the clock, so game-core stays pure.
    if (rec.ms) { rec.until = now + rec.ms; delete rec.ms; }
    room.hazards.push(rec);
  }
  if (room.hazards.length > 12) room.hazards.splice(0, room.hazards.length - 12);
  startFire(room);   // fire ticks on its own clock; it does NOT hold the turn
  // Burn scars are permanent for the match — merge this shot's scorch into the list.
  if (result.newScorches && result.newScorches.length) {
    room.scorch = mergeScorch(room.scorch || [], result.newScorches);
  }
  for (let i = 0; i < room.hp.length; i++) room.hp[i] = Math.max(0, Math.round(room.hp[i] * 10) / 10);
  killDead(room);   // mark wrecks BEFORE the payload goes out, so `alive` below is current
  hordeAccounting(room, aliveBefore);

  broadcast(room, {
    type: 'shot',
    by: seat,
    weapon: w.id,
    projectiles: result.projectiles,
    terrainDiff: diff,
    tanks: result.tanks,
    hp: room.hp.map(h => Math.max(0, Math.round(h))),
    damage: result.damage,
    hazards: room.hazards,
    scorch: room.scorch || [],
    hazardDamage: new Array(room.hp.length).fill(0),
    alive: aliveFlags(room),
    props: result.props, propEvents: result.propEvents, ruins: result.ruins,
    shield: room.shield.slice(), shieldPop,
    ammo: room.ammo[seat],
    ammoSeat: seat,
    killcam: buildKillcam(room, result, aliveBefore),   // null on every normal shot
  });
  // Crates: a blast can crack one open for the shooter, and survivors re-settle
  // onto whatever the shot left of the ground beneath them.
  cratesAfterShot(room, seat, result);
  if (room.crates.length) broadcast(room, { type: 'crates', crates: room.crates });
  // How long the clients will spend REPLAYING this salvo (paths play ~9ms a
  // point; the Air Strike's slow-motion bomb run stretches it). A bot's next
  // action is held until this window closes, so an NPC never visibly walks or
  // aims while the previous shot is still flying on someone's screen.
  const lastPt = result.projectiles.reduce((m2, p) => Math.max(m2, (p.delay || 0) + p.path.length), 0);
  room.replayUntil = Date.now() + Math.min(8000, Math.round(lastPt * (w.id === 'airstrike' ? 24 : 9)) + 700);
  // Give the shot animation a beat, then play out any fire/toxic burn before the
  // next turn (real-time damage-over-time; the turn holds until it finishes).
  clearTimeout(room.clock);
  // Null the handle when it runs: the fire clock uses `room.clock` as a
  // "handover already pending" flag, so a stale fired-Timeout must not read busy.
  room.clock = safeTimeout(() => { room.clock = null; startBurn(room, seat); }, 300);
}

// Real-time 5-second damage-over-time: any tank sitting in a fire/gas area loses
// its per-second dps once a second for 5 ticks, then the turn advances.
function startBurn(room, seat) {
  clearInterval(room.dotTimer); room.dotTimer = null;
  if (room.state !== 'playing') return;
  if (matchOver(room)) return advance(room, seat);   // blast already decided it
  const first = burnTick(room.hazards, room.tanks, room.lavaY);
  if (!first.some(d => d > 0)) return advance(room, seat);        // nobody's standing in it
  let ticks = 0;
  room.dotTimer = safeInterval(() => {
    if (room.state !== 'playing') { clearInterval(room.dotTimer); room.dotTimer = null; return; }
    ticks++;
    const dmg = burnTick(room.hazards, room.tanks, room.lavaY);
    for (let ti = 0; ti < room.hp.length; ti++) {
      dmg[ti] = Math.min(dmg[ti], 14);   // cap per second so overlapping clouds don't nuke
      room.hp[ti] = Math.max(0, Math.round((room.hp[ti] - dmg[ti]) * 10) / 10);
    }
    killDead(room);
    const over = matchOver(room);
    broadcast(room, {
      type: 'dot', tick: ticks,
      hp: room.hp.map(h => Math.max(0, Math.round(h))),
      alive: aliveFlags(room),
      damage: dmg.map(d => Math.round(d)),
    });
    if (ticks >= 5 || over) {
      clearInterval(room.dotTimer); room.dotTimer = null;
      if (over) endGame(room); else advance(room, seat);
    }
  }, 1000);
}

// ---- Fire: real-time, turn-INDEPENDENT ---------------------------------------
// Fire lives 6s from the instant it is lit and bites for 8 every 2s. It does NOT
// hold the turn open — the napalm victim burns while the next player is already
// aiming, and the blaze goes out on its own schedule. (Gas and the lava floor are
// unchanged: they still ride burnTick + startBurn's turn hold.)
function stopFire(room) { clearInterval(room.fireTimer); room.fireTimer = null; }

function startFire(room) {
  if (!room.hazards.some(h => h.until != null)) return stopFire(room);
  if (room.fireTimer) return;          // an existing blaze keeps its cadence
  room.fireTimer = safeInterval(() => fireBite(room), FIRE_TICK);
}

function fireBite(room) {
  if (room.state !== 'playing') return stopFire(room);
  const aliveBefore = aliveFlags(room);
  const now = Date.now();
  const dmg = fireDamage(room.hazards, room.tanks,       // spends one bite per blaze
    (owner, ti) => owner != null && sameSide(room, owner, ti));
  const before = room.hazards.length;
  room.hazards = room.hazards.filter(h => h.until == null || h.until > now);
  let hurt = false;
  for (let ti = 0; ti < room.hp.length; ti++) {
    if (dmg[ti] <= 0) continue;
    hurt = true;
    room.hp[ti] = Math.max(0, Math.round((room.hp[ti] - dmg[ti]) * 10) / 10);
    if (room.stat) room.stat.received[ti] += dmg[ti];
  }
  killDead(room);
  hordeAccounting(room, aliveBefore);
  // Always ship `hazards` so a burnt-out blaze disappears on the clients even
  // when nobody was standing in it (the client only renders what we send).
  if (hurt || room.hazards.length !== before) {
    broadcast(room, {
      type: 'dot', tick: 0, src: 'fire',
      hp: room.hp.map(h => Math.max(0, Math.round(h))),
      alive: aliveFlags(room),
      damage: dmg.map(d => Math.round(d)),
      hazards: room.hazards,
    });
  }
  if (!room.hazards.some(h => h.until != null)) stopFire(room);
  if (matchOver(room)) { stopFire(room); return endGame(room); }
  // Burned to death on their own turn: nothing else will move the game on, so do
  // it here — but only if no handover is already in flight (post-shot beat or the
  // gas/lava burn hold), or the turn would advance twice.
  const cur = room.tanks[room.turn];
  if (cur && cur.alive === false && !room.clock && !room.dotTimer) advance(room, room.turn);
}

function handleMove(room, seat, dir) {
  // VALIDATE FIRST. `dir` is raw client input: a non-numeric value made
  // Math.sign() return NaN, which flowed all the way into tank.x — and the
  // `moved <= 0` guard below does NOT stop it, because NaN <= 0 is false. The
  // result was a tank at x=NaN (every distance test in simulateShot resolves
  // false, so it can never be hit) with fuel=NaN (so `fuel < MOVE_STEP` is
  // also false, granting unlimited movement). Reject anything not -1/+1.
  const d = Math.sign(Number(dir));
  if (d !== 1 && d !== -1) return;
  if (room.state !== 'playing' || room.turn !== seat || room.picking) return;
  if (room.mode === 'golf') return;    // you walk to your BALL, not wherever you like
  if (!Number.isFinite(room.fuel) || room.fuel < MOVE_STEP) return;
  const tank = room.tanks[seat];
  if (tank.alive === false) return;
  // Drive anywhere along the map. Tanks are not obstacles — you may drive clean
  // past an opponent (and even stop on top of one); only the map edges stop you.
  // Shared with the Teleport weapon via laneBounds so the two can never disagree.
  const [lo, hi] = laneBounds(room.tanks, seat);
  if (hi < lo) return;                     // boxed in — nowhere legal to go
  const nx = Math.max(lo, Math.min(hi, tank.x + d * MOVE_STEP));
  const moved = Math.abs(nx - tank.x);
  // `> 0` (not `!(moved <= 0)`) so a NaN slipping past any future edit still
  // fails closed rather than writing NaN into the tank.
  if (!(moved > 0)) return;
  tank.x = nx;
  tank.y = surfaceAt(room.terrain, nx);
  room.fuel -= moved;
  broadcast(room, { type: 'move', seat, x: Math.round(tank.x * 10) / 10, y: Math.round(tank.y * 10) / 10, fuel: room.fuel });
  pickupCrates(room, seat);   // driving is how you claim a supply drop
}

// ---- Disconnect / resume -----------------------------------------------------
// Accidental disconnects (tab closed, network blip) keep the seat reserved for
// RESUME_GRACE_MS; the player can resume with their token. Explicit 'leave'
// tears the room down immediately.
function teardown(room, notify) {
  clearTimeout(room.clock);
  clearTimeout(room.botTimer);
  clearInterval(room.botWalker);
  clearInterval(room.dotTimer);
  clearInterval(room.fireTimer);
  clearTimeout(room.pickTimer);
  clearTimeout(room.emptyTimer);
  for (const p of room.players) if (p) clearTimeout(p.dropTimer);
  if (notify) broadcast(room, { type: 'opponentLeft' });
  rooms.delete(room.code);
}

function handleClose(ws) {
  if (waiting === ws) waiting = null;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const seat = ws.seat;
  const player = room.players[seat];
  if (!player || player.ws !== ws) return;

  if (room.state === 'waiting') {
    // Lobby: the host leaving kills the room; anyone else just frees their slot.
    // Leave a NULL HOLE rather than splicing — seats are only compacted at start.
    if (seat === room.hostSeat) return teardown(room, true);
    room.players[seat] = null;
    broadcastLobby(room);
    return;
  }
  if (room.state !== 'playing') return teardown(room);   // 'over' — nothing to hold

  // The socket may carry a host-attached identity (ws.userId, set by the
  // auth sink). The seat is about to lose its socket — exactly the moment
  // push nudges need that identity most — so carry it onto the player. An
  // opaque property only: the engine never reads it, the host does.
  if (ws.userId) player.userId = ws.userId;
  player.ws = null;
  player.connected = false;
  broadcast(room, { type: 'oppConn', seat, connected: false });
  clearTimeout(player.dropTimer);
  // The forfeit scuttle exists to protect a WAITING opponent. In a room with
  // no other human there is nobody to protect — skip it entirely and let the
  // empty-room hold below govern, so a solo player can be away far longer
  // than the multiplayer grace without losing their tank.
  const otherHumans = room.players.some((p, i) => p && !p.bot && i !== seat);
  if (otherHumans) {
    player.dropTimer = safeTimeout(() => {
      if (player.connected || room.state !== 'playing') return;
      // Grace expired. Scuttle only THEIR tank — the free-for-all carries on.
      room.hp[seat] = 0;
      killDead(room);
      broadcast(room, { type: 'forfeit', seat, hp: room.hp.map(h => Math.max(0, Math.round(h))), alive: aliveFlags(room) });
      if (matchOver(room)) return endGame(room);
      if (room.turn === seat) {          // they dropped mid-turn — move the game on
        clearTimeout(room.clock);
        clearInterval(room.dotTimer); room.dotTimer = null;
        advance(room, seat);
      }
    }, room.asyncOk ? ASYNC_GRACE_MS : RESUME_GRACE_MS);
  }
  // Every human gone: HOLD the room instead of dropping it — a window swap or
  // a phone sleep must never cost the match. Any resume cancels the hold. An
  // async duel keeps its full day: both players being offline between turns
  // is that mode's NORMAL state, and the push nudge is what brings them back.
  if (!room.players.some(p => p && !p.bot && p.connected)) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = safeTimeout(() => teardown(room),
      room.asyncOk ? ASYNC_GRACE_MS : EMPTY_ROOM_GRACE_MS);
  }
}

function handleResume(ws, msg) {
  const room = rooms.get(roomCode(msg.code));
  if (!room || room.state !== 'playing') return send(ws, { type: 'resumeError' });
  const seat = room.players.findIndex(p => p && p.token === msg.token);
  if (seat < 0) return send(ws, { type: 'resumeError' });
  const player = room.players[seat];
  // The token is the secret, so whoever presents it IS this player — TAKE OVER the
  // seat even if it still looks connected. Behind a proxy that holds dead upstream
  // sockets open (Render takes ~20s to report a drop, measured) the seat is still
  // 'connected' when its owner is already back; refusing here made a brief blip
  // cost the player the whole match. Reassign player.ws BEFORE killing the ghost:
  // handleClose ignores a socket that is no longer player.ws, so the stale close
  // can't clobber this new connection.
  const stale = player.ws;
  clearTimeout(player.dropTimer);
  clearTimeout(room.emptyTimer);       // somebody's home again — cancel the hold
  player.ws = ws; player.connected = true;
  // A reconnecting socket that already said hello brings its identity along;
  // one that has not yet keeps the identity carried over at disconnect.
  if (ws.userId) player.userId = ws.userId;
  ws.roomCode = room.code; ws.seat = seat;
  if (stale && stale !== ws) { try { stale.terminate(); } catch { /* already gone */ } }
  send(ws, { type: 'restore', ...snapshot(room, seat) });
  broadcast(room, { type: 'oppConn', seat, connected: true });
  scheduleBot(room);   // if it was the CPU's turn, resume its thinking
}

// ---- Inbound message router --------------------------------------------------
// The single entry point for everything a client says. server.js hands it every
// parsed frame from a real socket after rate-limiting; the offline driver will
// hand it frames from a local one.
//
// This router lives HERE rather than in server.js for a concrete reason: the
// quick-match queue (`waiting`, above) is module-level mutable state that these
// cases both read and reassign. Exporting it would export a snapshot of the
// binding, not the binding itself, so the two halves cannot live in separate
// files without an accessor pair — and moving the router down here is both
// smaller and the thing that gives an offline match one door to knock on.
export function handleClientMessage(ws, msg) {

  const room = rooms.get(ws.roomCode);

  switch (msg.type) {
    case 'create': {
      const r = createRoom(ws, msg.name, msg.skin, { mode: msg.mode, max: msg.max });
      if (!r) { send(ws, { type: 'joinError', reason: 'The server is at capacity. Try again shortly.' }); break; }
      r.players[0].loadout = sanitizeLoadoutFor(r.mode, msg.loadout);
      if (r.mode === 'golf') r.tees = sanitizeTees(msg.tees);
      r.asyncOk = r.mode === 'duel';        // invited duels are async-friendly
      send(ws, { type: 'created', code: r.code, mode: r.mode, max: r.max });
      send(ws, lobbyPayload(r, 0));
      break;
    }
    case 'join': {
      const code = roomCode(msg.code);
      const r = rooms.get(code);
      if (!r) return send(ws, { type: 'joinError', reason: 'No game with that code.' });
      if (r.state !== 'waiting') return send(ws, { type: 'joinError', reason: 'That battle has already started.' });
      // ONE SOCKET, ONE SEAT. Without this a second `join` for a room you are
      // already sitting in takes ANOTHER seat, and every route to it is one an
      // ordinary player hits by accident: joinBtn has no debounce, tapping a
      // push notification for your current room re-sends `join`, and so does
      // opening a ?room= link while seated. Take enough seats and the
      // `seatCount(r) >= r.max` line below auto-starts the match — then ONE
      // disconnect frees only ws.seat, because handleClose resolves a single
      // seat. The rest stay `connected: true` behind a dead socket, and with
      // no shot clock (see beginTurn) the turn eventually lands on a ghost and
      // the match never advances again for the real player. Duels escaped it
      // only because they start at 2 seats and `state !== 'waiting'` then
      // blocks the next join; FFA, Boss Fight and Alien Invasion did not.
      if (r.players.some((p) => p && p.ws === ws)) {
        return send(ws, { type: 'joinError', reason: 'You are already in that game.' });
      }
      if (seatCount(r) >= r.max) return send(ws, { type: 'joinError', reason: 'That game is full.' });
      // Joining a lobby leaves whichever one we were in. Skipping this stranded
      // a seat in the OLD room held by a socket that can never speak for it
      // again: handleClose only ever resolves the newest ws.roomCode, and
      // nothing sweeps `rooms`. Safe to call after the guard above — if the
      // prior room IS this one, `mine` is false there and it returns early.
      releasePriorRoom(ws);
      let seat = r.players.indexOf(null);                 // reuse a lobby hole first
      if (seat < 0) { seat = r.players.length; r.players.push(null); }
      r.players[seat] = {
        ws, name: sanitizeName(msg.name, seat), token: makeToken(), loadout: sanitizeLoadoutFor(r.mode, msg.loadout),
        connected: true, dropTimer: null, skin: sanitizeSkin(msg.skin, seat),
      };
      ws.roomCode = code; ws.seat = seat;
      // Duels keep the legacy instant start. FFA waits for the host — unless it fills.
      if (r.mode === 'duel' || seatCount(r) >= r.max) { compactRoster(r); startGame(r); }
      else broadcastLobby(r);
      break;
    }
    case 'quick': {
      if (waiting && waiting !== ws && waiting.readyState === 1) {
        const host = waiting; waiting = null;
        const r = createRoom(host, host._qname, host._qskin, { mode: 'duel' });
        if (!r) {
          send(host, { type: 'joinError', reason: 'The server is at capacity. Try again shortly.' });
          send(ws, { type: 'joinError', reason: 'The server is at capacity. Try again shortly.' });
          break;
        }
        r.players[0].loadout = host._qloadout || null;
        releasePriorRoom(ws);            // the joiner may have been sitting in a lobby
        r.players.push({ ws, name: sanitizeName(msg.name, 1), token: makeToken(), connected: true, dropTimer: null, skin: sanitizeSkin(msg.skin, 1), loadout: sanitizeLoadout(msg.loadout) });
        ws.roomCode = r.code; ws.seat = 1;
        startGame(r);
      } else {
        waiting = ws; ws._qname = sanitizeName(msg.name, 0); ws._qskin = msg.skin; ws._qloadout = sanitizeLoadout(msg.loadout);
        send(ws, { type: 'queued' });
      }
      break;
    }
    case 'cancelQuick': if (waiting === ws) waiting = null; break;
    case 'ai': {
      const diff = ['easy', 'medium', 'hard'].includes(msg.difficulty) ? msg.difficulty : 'medium';
      // CPU games stay strictly 2-player.
      const r = createRoom(ws, msg.name, msg.skin, { mode: 'duel' });
      if (!r) { send(ws, { type: 'joinError', reason: 'The server is at capacity. Try again shortly.' }); break; }
      r.players[0].loadout = sanitizeLoadout(msg.loadout);
      r.vsBot = true;
      r.players[1] = {
        ws: null, bot: true, difficulty: diff,
        name: `CPU · ${diff[0].toUpperCase()}${diff.slice(1)}`,
        token: makeToken(), connected: true, dropTimer: null,
        skin: sanitizeSkin('desert', 1),
      };
      startGame(r);
      break;
    }
    case 'resume': handleResume(ws, msg); break;
    case 'loadout': {
      // The match-start draft: accept picks while the draft window is open.
      if (!room || !room.picking || ws.seat == null) break;
      const pl3 = room.players[ws.seat];
      const picks = sanitizeLoadout(msg.picks, room.pickN);
      if (!pl3 || pl3.bot || !picks || room.loadouts[ws.seat]) break;
      room.loadouts[ws.seat] = picks;
      room.ammo[ws.seat] = loadoutAmmo(picks);
      if (room.players.every((pl, i) => pl.bot || room.loadouts[i])) finishPicking(room);
      break;
    }
    case 'hello': {
      // A socket introducing its account. Nothing in the ENGINE changes —
      // the host's sink verifies the token and remembers who this socket is,
      // which is what lets pushNudge find subscriptions saved in earlier
      // sessions and on other devices.
      authSink(ws, msg.token);
      break;
    }
    case 'pushSub': {
      // Turn-nudge opt-in: hang the browser subscription off the player so a
      // disconnected seat can still be pinged when its turn comes up.
      const pl2 = room && ws.seat != null ? room.players[ws.seat] : null;
      const s = msg.sub;
      // Two shapes now (8.57). WEB: an https endpoint plus keys, which the
      // server can push to directly. NATIVE: a platform and an FCM
      // registration token — opaque here, and NOT hung on the player, because
      // only the host can deliver it and only the persisted row survives the
      // room anyway.
      //
      // BOUNDED, 2026-08-18. The native branch below has always capped its token
      // at 4096; the web branch checked only that `endpoint` was an https string,
      // so `sub` could be any size — and it is both held on the player and
      // PERSISTED. `profiles.progression` two dozen lines away in the same
      // migration carries `check (pg_column_size(progression) <= 65536)` with the
      // comment "64KB cap stops abuse"; `push_subscriptions.sub` is a bare jsonb
      // with no such guard. With maxPayload at 64KB and MSG_RATE at 60/s that is
      // ~3.8 MB/s aimed at a 500MB free-plan database, and because `endpoint` is
      // the unique upsert key, simply varying it turns replacement into growth.
      //
      // Bounded by SIZE rather than by shape: a real subscription is a few
      // hundred bytes, so these ceilings are far above anything legitimate,
      // while policing the shape risks rejecting a browser whose payload differs
      // from the ones we happened to test.
      const PUSH_ENDPOINT_MAX = 2048;
      const PUSH_SUB_MAX = 4096;              // same order as the native cap
      const PUSH_SUBS_PER_SOCKET = 5;         // a real client subscribes once
      let subBytes = 0;
      try { subBytes = JSON.stringify(s || null).length; } catch { subBytes = Infinity; }
      const webSub = s && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://')
        && s.endpoint.length <= PUSH_ENDPOINT_MAX && subBytes <= PUSH_SUB_MAX;
      const nativeSub = s && (s.platform === 'android' || s.platform === 'ios')
        && typeof s.token === 'string' && s.token.length > 0 && s.token.length <= 4096;
      ws.pushSubCount = (ws.pushSubCount || 0) + 1;
      if (ws.pushSubCount > PUSH_SUBS_PER_SOCKET) break;
      if (pl2 && (webSub || nativeSub)) {
        if (webSub) pl2.pushSub = s;
        send(ws, { type: 'pushOk' });
        // The host may also persist it keyed to the account (ISSUE-003) —
        // best-effort and async; the pushOk above is the in-room ack.
        pushSubSink(ws, msg.sub, msg.token);
      }
      break;
    }
    case 'sync': {
      // A client coming back from the background asks for the truth: ship a
      // fresh restore snapshot so a frozen replay or a missed broadcast can
      // never leave its buttons dead.
      if (room && room.state === 'playing' && ws.seat != null) {
        send(ws, { type: 'restore', ...snapshot(room, ws.seat) });
      }
      break;
    }
    case 'aim': {
      if (!room || room.state !== 'playing') return;
      // Relay both players' aims so barrels track live (pre-aiming included).
      const relayPow = Math.max(1, Math.min(100, Number.isFinite(Number(msg.power)) ? Number(msg.power) : 60));
      const relayAng = clampAim(msg.angle);
      for (let i = 0; i < room.players.length; i++) {
        const p = room.players[i];
        if (i === ws.seat || !p || !p.ws) continue;
        send(p.ws, { type: 'aim', seat: ws.seat, angle: relayAng, power: relayPow, weapon: msg.weapon });
      }
      break;
    }
    case 'startMatch': {
      const r = rooms.get(ws.roomCode);
      if (!r || r.state !== 'waiting') break;
      if (ws.seat !== r.hostSeat) break;                  // only the host starts early
      const minSeats = (r.mode === 'boss' || r.mode === 'golf' || r.mode === 'aliens') ? 1 : 2;
      if (seatCount(r) < minSeats) { send(ws, { type: 'joinError', reason: 'Need at least 2 commanders.' }); break; }
      compactRoster(r);
      startGame(r);
      break;
    }
    case 'move': if (room) handleMove(room, ws.seat, msg.dir); break;
    // Legacy inbound: no current client sends this — the flip button is gone.
    // Kept because packaged Capacitor builds bundle their own app.js and older
    // installs still have the button; dropping the case would desync their aim
    // preview from the shot they actually fire.
    case 'face': {
      if (!room || room.state !== 'playing') break;
      room.facing[ws.seat] = msg.dir < 0 ? -1 : 1;
      for (let i = 0; i < room.players.length; i++) {
        const p = room.players[i];
        if (i === ws.seat || !p || !p.ws) continue;
        send(p.ws, { type: 'face', seat: ws.seat, dir: room.facing[ws.seat] });
      }
      break;
    }
    case 'fire': if (room) handleFire(room, ws.seat, msg); break;
    case 'rematch': {
      if (room) for (const pl of room.players) if (pl && !pl.bot) pl.loadout = null;   // fresh draft every game
      // Everyone still in the room must be present. Eliminated players are still
      // "in the room" — elimination is per-match, not per-room.
      // ">= 2" predates the solo modes. A solo golf room is the ONE 1-player
      // room that can reach 'over' (boss and horde append bot seats), and its
      // Rematch was a dead button: the tap passed the client UI, failed here,
      // and nothing came back. startGame routes golf to startGolf, which
      // resets the scorecard and holes, so a solo rematch is a full new round.
      // ISSUE-031: every one of these guards used to fail SILENTLY. The client
      // sent `rematch`, nothing came back, and the button was simply dead — with
      // no way for the player to tell a refusal from a dropped connection. Two
      // reachable cases were found by the 8.44 verifiers: a duo golf round ended
      // by a disconnect forfeit (the survivor fails `every(connected)`), and a
      // partner's socket closing while the room is 'over' (the room is torn down,
      // so there is no room at all). Say which, in words a player can act on.
      const why = !room ? 'That match has already been cleaned up — start a new game.'
        : room.state !== 'over' ? 'That match is still in progress.'
        : !(room.players.length >= 2 || room.mode === 'golf') ? 'There is nobody left to rematch.'
        : !room.players.every(p => p && (p.bot || p.connected))
          ? 'The other player has left — start a new game to play again.'
          : null;
      if (why) { send(ws, { type: 'rematchDenied', reason: why }); break; }
      startGame(room);
      break;
    }
    case 'leave': {
      if (!room) break;
      // Leaving must end the match for the LEAVER, not for everyone else.
      // Tearing the room down unconditionally meant one player quitting a
      // 4-player free-for-all, a Boss Fight or an Alien Invasion ended it for
      // all of them — and in a lobby, any guest tapping Cancel destroyed the
      // host's room. handleClose already models a departure correctly (seat
      // freed while waiting, tank scuttled mid-match, room reclaimed once the
      // last human is gone), so route through it and only tear down when this
      // really is the last human present.
      const others = room.players.some((p, i) => p && !p.bot && p.connected && i !== ws.seat);
      if (others) { handleClose(ws); ws.roomCode = null; ws.seat = null; }
      else teardown(room, true);
      break;
    }
  }
}

// ---- Host surface ------------------------------------------------------------
// Deliberately small. `handleClientMessage` (above) and `handleClose` are the
// whole inbound surface; `rooms` and `send` exist only so the shutdown path can
// count live matches and tell everyone the lights are going out. Resist adding
// more — every extra export is another way for the host to reach past the seam.
export { rooms, send, handleClose };
