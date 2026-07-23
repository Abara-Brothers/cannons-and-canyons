// server.js — static host + WebSocket relay/authority for Canyons & Cannons.
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import {
  WORLD_W, WORLD_H, MOVE_BUDGET, MOVE_STEP, MAX_HP, LAVA_Y, AIM_MIN, AIM_MAX, clampAim,
  laneBounds,
  generateTerrain, generateTrees, spawnTanks, surfaceAt, simulateShot, terrainDiff,
  weaponMenu, startingAmmo, WEAPON_BY_ID, tickHazards, burnTick, aiShot, mergeScorch,
  LOADOUT_POOL, validLoadout, loadoutAmmo, loadoutSizeFor,
  fireDamage, FIRE_TICK,
  BIOMES, BIOME_IDS, biomeLavaY, generateProps, generateRuins, prepareGolfHole,
} from './game-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
// How long a disconnected player may return before their tank is scuttled.
// Overridable so the test suite can exercise the forfeit path without a 2-min wait.
const RESUME_GRACE_MS = Number(process.env.RESUME_GRACE_MS) || 120000;
// Async games: a private duel holds a disconnected seat for a DAY — take your
// turn whenever, your opponent's push nudge brings them back.
const ASYNC_GRACE_MS = Number(process.env.ASYNC_GRACE_MS) || 24 * 60 * 60 * 1000;

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
const FALLBACK_NAMES = ['Ranger', 'Maverick', 'Bulwark', 'Sentry', 'Nomad', 'Havoc', 'Granite', 'Longshot', 'Bracken', 'Cinder'];
const foldLeet = (s) => String(s).toLowerCase().split('').map(c => LEET[c] || c).join('');
const lettersOf = (s) => foldLeet(s).replace(/[^a-z]/g, '');
function isProfane(raw) {
  const flat = lettersOf(raw);
  if (BAD_SUB.some(w => flat.includes(w))) return true;
  // Short words only count as whole tokens, so "Bass Master" and "Titan" pass.
  return String(raw).toLowerCase().split(/[^a-z0-9@$!+]+/).map(lettersOf).some(t => BAD_WORD.includes(t));
}
function sanitizeName(raw, seat = 0) {
  const name = String(raw ?? '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  if (!name) return `Player ${seat + 1}`;
  if (!isProfane(name)) return name;
  const h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
  return FALLBACK_NAMES[Math.abs(h) % FALLBACK_NAMES.length];
}

// ---- Teams ----------------------------------------------------------------------
// Boss Fight is strictly co-op: the humans are one side, the WARLORD the other,
// and NOTHING a player fires — blast, splash, fire, gas, fallout, nanobots —
// may hurt their own side (their own tank included).
function sameSide(room, a, b) {
  if (room.mode !== 'boss') return false;
  const bs = bossSeatOf(room);
  return (a === bs) === (b === bs);
}

// ---- Static file server ----------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// ---- Web Push (turn nudges) ---------------------------------------------------
// VAPID keys come from env in production; otherwise they're generated once and
// persisted next to the process so subscriptions survive restarts on the same
// disk. If web-push is somehow unavailable, everything degrades to no-op.
let webpush = null, vapidPublicKey = '';
try {
  webpush = (await import('web-push')).default;
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const vf = path.join(process.cwd(), 'data', 'vapid.json');
    try {
      ({ pub, priv } = JSON.parse(fs.readFileSync(vf, 'utf8')));
    } catch {
      const k = webpush.generateVAPIDKeys();
      pub = k.publicKey; priv = k.privateKey;
      try { fs.mkdirSync(path.dirname(vf), { recursive: true }); fs.writeFileSync(vf, JSON.stringify({ pub, priv })); } catch {}
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:jordan@bluepixel.com.au', pub, priv);
  vapidPublicKey = pub;
} catch { webpush = null; }

function pushNudge(room, seat) {
  const pl = room.players[seat];
  if (!webpush || !pl || pl.bot || pl.connected || !pl.pushSub) return;
  const opp = room.players.find((p, i) => p && i !== seat && !p.bot);
  const payload = JSON.stringify({
    title: 'Canyons & Cannons — your move',
    body: opp ? `${opp.name} has taken their shot. Your turn.` : 'Your turn is up.',
    url: `/?room=${room.code}`,
  });
  webpush.sendNotification(pl.pushSub, payload).catch((err) => {
    if (err && (err.statusCode === 404 || err.statusCode === 410)) pl.pushSub = null;   // subscription expired
  });
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/push/key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ key: vapidPublicKey }));
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback so /?room=CODE deep links still load.
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- Game rooms ------------------------------------------------------------
const rooms = new Map();
let waiting = null; // a socket sitting in the quick-match queue
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}
const makeToken = () => crypto.randomBytes(12).toString('hex');

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
//       'zombies' -> 1..2 humans vs waves of rotting hulks
// A loadout arrives as an array of weapon ids; anything malformed becomes null
// and the seat falls back to the default kit at start.
const sanitizeLoadout = (picks, n = 5) => (validLoadout(picks, n) ? picks.slice() : null);
const DEFAULT_LOADOUT = ['cannon', 'mortar', 'cluster', 'napalm', 'airstrike'];
const DEFAULT_LOADOUT7 = ['cannon', 'mortar', 'cluster', 'napalm', 'airstrike', 'buster', 'volley'];
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
const PICK_MS = Number(process.env.PICK_MS || 25000);
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

function createRoom(hostWs, name, skin, opts = {}) {
  const code = makeCode();
  const MODES = ['duel', 'ffa', 'boss', 'golf', 'aliens', 'zombies'];
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
    nanoBots: [], nanoTimer: null,     // Nano Swarm infestations (bots left per seat)
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
      ? [{ id: 'golfball', name: WEAPON_BY_ID.golfball.name, color: WEAPON_BY_ID.golfball.color, ammo: 99, desc: WEAPON_BY_ID.golfball.desc }]
      : weaponMenu(),
    golf: room.golf ? {
      hole: room.golf.hole, holes: 9, par: room.golf.par, cup: room.golf.cup, tee: room.golf.tee,
      tees: room.golf.tees, teeSet: room.golf.teeSet,
      strokes: room.golf.strokes.map(r => r[room.golf.hole - 1] || 0),
      totals: room.golf.strokes.map(r => r.reduce((a, b) => a + b, 0)),
      done: room.golf.done.slice(),
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
    nano: room.nanoBots && room.nanoBots.some(b => b > 0) ? room.nanoBots : undefined,
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
  zombies: { kind: 'zombie', baseHp: 110, waveHp: 20, target: 8,
             names: ['ROTBOX', 'GRAVEDIGGER', 'PUTRID-9'],
             kit: ['z_spit', 'z_grubs', 'z_lob'] },
};
const isHordeMode = (m) => m === 'aliens' || m === 'zombies';
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
    // drop the reinforcement well away from every living human
    let x = 0;
    for (let tries = 0; tries < 16; tries++) {
      x = Math.round(2000 + Math.random() * (WORLD_W - 4000));
      const clear = room.players.every((p, j) => p.horde || room.tanks[j].alive === false || Math.abs(room.tanks[j].x - x) > 2600);
      if (clear) break;
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
  room.ammo = Array.from({ length: n }, () => ({ golfball: 99 }));
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
  room.worldW = Math.max(36000, H.d + 12000);       // the world fits the hole
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
  g.cup.y = prepareGolfHole(room.terrain, g.tee, g.cup.x, Object.values(g.tees));
  room.trees = generateTrees(room.terrain, seed, 2);
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
  const result = simulateShot(
    { terrain: room.terrain, tanks: room.tanks, lavaY: room.lavaY, biome: room.biome },
    { by: seat, weapon: 'golfball', angle: msg.angle, power: msg.power, dir: room.facing[seat] }
  );
  const hi = g.hole - 1;
  g.strokes[seat][hi]++;
  const rest = result.golf && result.golf.rest;
  let note = '';
  if (rest && rest[1] >= room.lavaY - 6) {
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
    type: 'shot', by: seat, weapon: 'golfball',
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
      strokes: g.strokes.map(r => r[hi]),
      totals: g.strokes.map(r => r.reduce((a, b) => a + b, 0)),
      done: g.done.slice(), note, noteSeat: seat,
    },
  });
  clearTimeout(room.clock);
  // The turn does NOT end while the ball is moving: hold the handover for the
  // replay's full flight+roll (path plays ~9ms a point on the clients).
  const ptsMs = ((result.projectiles[0] && result.projectiles[0].path.length) || 0) * 9;
  room.clock = setTimeout(() => { room.clock = null; golfAdvance(room, seat); }, 600 + Math.min(9500, Math.round(ptsMs)));
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
    golf: { totals, parTotal, strokes: room.golf.strokes },
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
  room.terrain = generateTerrain(room.seed, n, room.biome);
  // Order matters: ruins and bunkers RESHAPE the terrain, so they go before the
  // trees are placed and before the tanks are seated on the final surface.
  room.ruins = (BIOMES[room.biome] || {}).ruins ? generateRuins(room.seed, room.terrain, n) : null;
  room.guard = room.ruins ? room.ruins.guard : null;
  room.props = generateProps(room.seed, room.terrain, n, room.biome);
  room.trees = generateTrees(room.terrain, room.seed, n);
  room.tanks = spawnTanks(room.terrain, room.seed, n);   // ordered left -> right
  room.hp = new Array(n).fill(MAX_HP);
  room.hpMax = new Array(n).fill(MAX_HP);
  room.crates = []; room.crateSeq = 1; room.crateDrops = 0;
  room.shield = new Array(n).fill(0);
  room.turnCount = 0; room.bossShots = 0;
  room.nanoBots = new Array(n).fill(0);
  clearInterval(room.nanoTimer); room.nanoTimer = null; clearTimeout(room.nanoSeek);
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
  // EVERY combat mode drafts a loadout now (5 picks; survival modes 7). A seat
  // that pre-supplied picks (or is a bot) is ready instantly; everyone else
  // gets the pick screen and PICK_MS to choose.
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
  room.turn = Math.floor(Math.random() * n);
  room.state = 'playing';
  for (let i = 0; i < n; i++) send(room.players[i].ws, { type: 'start', ...snapshot(room, i) });
  if (room.picking) {
    clearTimeout(room.pickTimer);
    room.pickTimer = setTimeout(() => finishPicking(room), PICK_MS);
  } else {
    beginTurn(room);
  }
}

// No shot-clock: players take as long as they like. Turns only advance on fire.
function beginTurn(room) {
  room.fuel = MOVE_BUDGET;
  room.turnCount = (room.turnCount || 0) + 1;
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
const BOT_FIRE_MS = Number(process.env.BOT_FIRE_MS || 1500);

function maybeDropCrate(room) {
  if (room.mode === 'golf' || room.state !== 'playing') return;
  if (room.turnCount < 3 || (room.turnCount - 3) % 4 !== 0) return;   // turn 3, 7, 11, ...
  if (room.crates.length >= 2) return;
  if ((room.crateDrops || 0) >= 4) return;           // hard cap: 4 drops per match
  for (let tries = 0; tries < 14; tries++) {
    const x = Math.round(1800 + Math.random() * (WORLD_W - 3600));
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
  room.botTimer = setTimeout(() => botAct(room), quick ? 220 + Math.random() * 240 : 850 + Math.random() * 750);
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
  const steps = meP.horde ? 6 + Math.floor(Math.random() * 10) : 8 + Math.floor(Math.random() * 22);
  return { dir, steps };
}

// Drive, then shoot. One walker per room; it hands off to botFire when the
// crate is collected, the step budget is spent, or the tank runs out of fuel.
function botWalk(room, seat, dir, opts = {}) {
  clearInterval(room.botWalker);
  let steps = opts.steps ?? 999;
  room.botWalker = setInterval(() => {
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
    bot.difficulty = room.horde.wave >= 3 ? 'hard' : 'medium';
  }
  if (bot.boss) {
    room.bossShots = (room.bossShots || 0) + 1;
    const me = room.tanks[seat];
    // Target selection: finish the WOUNDED. The gunnery brain aims at the
    // nearest living tank, so every other human is masked off the field.
    const humans = room.players.map((p, i) => i)
      .filter(i => i !== seat && !room.players[i].bot && room.tanks[i].alive !== false && room.hp[i] > 0);
    let mark = -1;
    for (const i of humans) if (mark < 0 || room.hp[i] < room.hp[mark]) mark = i;
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
  room.botTimer = setTimeout(() => {
    if (room.state === 'playing' && room.turn === seat) resolveFire(room, seat, shot.weapon, shot.angle, shot.power);
  }, bot.horde ? Math.min(550, BOT_FIRE_MS) : BOT_FIRE_MS);
}

// Unlimited shots — the match only ends when a tank is destroyed.
function advance(room, by) {
  killDead(room);
  if (matchOver(room)) return endGame(room);
  const n = room.players.length;
  let t = by;
  do { t = (t + 1) % n; } while (room.tanks[t].alive === false);   // terminates: >=2 alive
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
  clearInterval(room.nanoTimer); room.nanoTimer = null; clearTimeout(room.nanoSeek);
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
// payload. Lives in server.js on purpose — game-core stays pure.
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
  clearTimeout(room.clock);
  const before = room.terrain.slice();
  const aliveBefore = aliveFlags(room);   // snapshot for the killcam (who this shot kills)
  const result = simulateShot(
    { terrain: room.terrain, tanks: room.tanks,
      lavaY: room.lavaY, biome: room.biome, guard: room.guard, props: room.props,
      ruins: room.ruins ? room.ruins.ranges : undefined },
    { by: seat, weapon: w.id, angle, power, dir: room.facing[seat] }
  );

  if (w.ammo < 99) room.ammo[seat][w.id] = Math.max(0, (room.ammo[seat][w.id] || 0) - 1);
  // No friendly fire in Boss Fight: a teammate caught in your blast walks away.
  for (let i = 0; i < result.damage.length; i++) {
    if (sameSide(room, seat, i)) result.damage[i] = 0;
  }
  if (result.nano && sameSide(room, seat, result.nano.seat)) result.nano = null;
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
  if (result.nano) startNano(room, result.nano);
  // Give the shot animation a beat, then play out any fire/toxic burn before the
  // next turn (real-time damage-over-time; the turn holds until it finishes).
  clearTimeout(room.clock);
  // Null the handle when it runs: the fire clock uses `room.clock` as a
  // "handover already pending" flag, so a stale fired-Timeout must not read busy.
  room.clock = setTimeout(() => { room.clock = null; startBurn(room, seat); }, 300);
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
  room.dotTimer = setInterval(() => {
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
  room.fireTimer = setInterval(() => fireBite(room), FIRE_TICK);
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

// ---- Nano Swarm: bots gnaw on their host once a second -------------------------
// 10 bots, 3 health each. Runs on its own clock like fire; a re-infection tops
// the count back up to 10 rather than stacking.
// Seekers take a beat to crawl onto their victim (the client animates the
// chase), then the swarm detonates in rapid pulses of three bots at a time.
const NANO_SEEK_MS = Number(process.env.NANO_SEEK_MS || 1600);
function startNano(room, hit) {
  room.nanoBots[hit.seat] = Math.max(room.nanoBots[hit.seat] || 0, hit.bots);
  room.nanoDmg = hit.dmg || 3;
  clearTimeout(room.nanoSeek);
  room.nanoSeek = setTimeout(() => {
    if (room.nanoTimer) return;
    room.nanoTimer = setInterval(() => nanoTick(room), 500);
  }, NANO_SEEK_MS);
}

function nanoTick(room) {
  if (room.state !== 'playing') { clearInterval(room.nanoTimer); room.nanoTimer = null; return; }
  const aliveBefore = aliveFlags(room);
  const dmg = new Array(room.hp.length).fill(0);
  let any = false;
  for (let i = 0; i < room.hp.length; i++) {
    if ((room.nanoBots[i] || 0) <= 0) continue;
    if (room.tanks[i].alive === false) { room.nanoBots[i] = 0; continue; }
    const burst = Math.min(3, room.nanoBots[i]);   // three bots pop per pulse
    room.nanoBots[i] -= burst;
    dmg[i] = burst * (room.nanoDmg || 3);
    room.hp[i] = Math.max(0, Math.round((room.hp[i] - dmg[i]) * 10) / 10);
    if (room.stat) room.stat.received[i] += dmg[i];
    any = true;
  }
  killDead(room);
  hordeAccounting(room, aliveBefore);
  if (any) {
    broadcast(room, {
      type: 'dot', tick: 0, src: 'nano',
      hp: room.hp.map(h => Math.max(0, Math.round(h))),
      alive: aliveFlags(room),
      damage: dmg.map(d => Math.round(d)),
      nano: room.nanoBots.slice(),
    });
  }
  if (!room.nanoBots.some(b => b > 0)) { clearInterval(room.nanoTimer); room.nanoTimer = null; }
  if (matchOver(room)) { clearInterval(room.nanoTimer); room.nanoTimer = null; return endGame(room); }
  const cur = room.tanks[room.turn];
  if (cur && cur.alive === false && !room.clock && !room.dotTimer) advance(room, room.turn);
}

function handleMove(room, seat, dir) {
  if (room.state !== 'playing' || room.turn !== seat || room.picking) return;
  if (room.mode === 'golf') return;    // you walk to your BALL, not wherever you like
  if (room.fuel < MOVE_STEP) return;
  const tank = room.tanks[seat];
  if (tank.alive === false) return;
  // Drive anywhere along the map. Tanks are not obstacles — you may drive clean
  // past an opponent (and even stop on top of one); only the map edges stop you.
  // Shared with the Teleport weapon via laneBounds so the two can never disagree.
  const [lo, hi] = laneBounds(room.tanks, seat);
  if (hi < lo) return;                     // boxed in — nowhere legal to go
  const nx = Math.max(lo, Math.min(hi, tank.x + Math.sign(dir) * MOVE_STEP));
  const moved = Math.abs(nx - tank.x);
  if (moved <= 0) return;
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
  clearInterval(room.nanoTimer); clearTimeout(room.nanoSeek); clearTimeout(room.pickTimer);
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

  player.ws = null;
  player.connected = false;
  broadcast(room, { type: 'oppConn', seat, connected: false });
  clearTimeout(player.dropTimer);
  player.dropTimer = setTimeout(() => {
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
  // If every human is gone, drop the room right away.
  if (!room.players.some(p => p && !p.bot && p.connected)) teardown(room);
}

function handleResume(ws, msg) {
  const room = rooms.get((msg.code || '').toUpperCase().trim());
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
  player.ws = ws; player.connected = true;
  ws.roomCode = room.code; ws.seat = seat;
  if (stale && stale !== ws) { try { stale.terminate(); } catch { /* already gone */ } }
  send(ws, { type: 'restore', ...snapshot(room, seat) });
  broadcast(room, { type: 'oppConn', seat, connected: true });
  scheduleBot(room);   // if it was the CPU's turn, resume its thinking
}

// ---- WebSocket wiring -------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const room = rooms.get(ws.roomCode);

    switch (msg.type) {
      case 'create': {
        const r = createRoom(ws, msg.name, msg.skin, { mode: msg.mode, max: msg.max });
        r.players[0].loadout = sanitizeLoadout(msg.loadout);
        if (r.mode === 'golf') r.tees = sanitizeTees(msg.tees);
        r.asyncOk = r.mode === 'duel';        // invited duels are async-friendly
        send(ws, { type: 'created', code: r.code, mode: r.mode, max: r.max });
        send(ws, lobbyPayload(r, 0));
        break;
      }
      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) return send(ws, { type: 'joinError', reason: 'No game with that code.' });
        if (r.state !== 'waiting') return send(ws, { type: 'joinError', reason: 'That battle has already started.' });
        if (seatCount(r) >= r.max) return send(ws, { type: 'joinError', reason: 'That game is full.' });
        let seat = r.players.indexOf(null);                 // reuse a lobby hole first
        if (seat < 0) { seat = r.players.length; r.players.push(null); }
        r.players[seat] = {
          ws, name: sanitizeName(msg.name, seat), token: makeToken(), loadout: sanitizeLoadout(msg.loadout),
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
          r.players[0].loadout = host._qloadout || null;
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
      case 'pushSub': {
        // Turn-nudge opt-in: hang the browser subscription off the player so a
        // disconnected seat can still be pinged when its turn comes up.
        const pl2 = room && ws.seat != null ? room.players[ws.seat] : null;
        if (pl2 && msg.sub && typeof msg.sub.endpoint === 'string' && msg.sub.endpoint.startsWith('https://')) {
          pl2.pushSub = msg.sub;
          send(ws, { type: 'pushOk' });
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
        const minSeats = (r.mode === 'boss' || r.mode === 'golf' || r.mode === 'aliens' || r.mode === 'zombies') ? 1 : 2;
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
        if (room && room.state === 'over' && room.players.length >= 2
          && room.players.every(p => p && (p.bot || p.connected))) startGame(room);
        break;
      }
      case 'leave': {
        if (room) teardown(room, true);
        break;
      }
    }
  });

  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {});
});

// Drop dead sockets so abandoned rooms get cleaned up.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Canyons & Cannons running at http://localhost:${PORT}`);
});
