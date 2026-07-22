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
  fireDamage, FIRE_TICK,
  BIOMES, BIOME_IDS, biomeLavaY, generateProps, generateRuins,
} from './game-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
// How long a disconnected player may return before their tank is scuttled.
// Overridable so the test suite can exercise the forfeit path without a 2-min wait.
const RESUME_GRACE_MS = Number(process.env.RESUME_GRACE_MS) || 120000;

// Cosmetic tank paints (client renders them; validate ids here).
const SKINS = ['olive', 'desert', 'jungle', 'midnight', 'arctic', 'gold'];
const SEAT_SKIN = ['olive', 'desert', 'jungle', 'midnight'];   // fallback paint per seat
const sanitizeSkin = (s, seat) => (SKINS.includes(s) ? s : SEAT_SKIN[seat % SEAT_SKIN.length]);

// ---- Static file server ----------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
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
  if (room.mode === 'boss') {
    const b = bossSeatOf(room);
    const bossDead = b >= 0 && room.tanks[b] && room.tanks[b].alive === false;
    const humanAlive = room.tanks.some((t, i) => i !== b && t.alive !== false && room.hp[i] > 0);
    return bossDead || !humanAlive;
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

// mode: 'duel' -> exactly 2, auto-starts the moment the 2nd player joins (legacy flow)
//       'ffa'  -> 2..4, the HOST starts it (or it auto-starts when it fills)
//       'boss' -> 1..2 humans vs the WARLORD (host may start solo)
//       'golf' -> 1..2 humans, 9 holes, no damage
function createRoom(hostWs, name, skin, opts = {}) {
  const code = makeCode();
  const MODES = ['duel', 'ffa', 'boss', 'golf'];
  const mode = MODES.includes(opts.mode) ? opts.mode : 'duel';
  const max = mode === 'ffa' ? Math.max(2, Math.min(4, (opts.max | 0) || 4)) : 2;
  const room = {
    code, mode, max, hostSeat: 0,
    players: [
      { ws: hostWs, name: name || 'Player 1', token: makeToken(), connected: true, dropTimer: null, skin: sanitizeSkin(skin, 0) },
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
    world: { w: WORLD_W, h: WORLD_H }, lavaY: room.lavaY || LAVA_Y,
    terrain: room.terrain.map(v => Math.round(v * 10) / 10),
    trees: room.trees,
    tanks: room.tanks.map(t => ({ x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10 })),
    weapons: weaponMenu(),
    n: room.players.length, mode: room.mode,
    names: room.players.map(p => p.name),
    skins: room.players.map(p => p.skin),
    facing: room.facing.slice(),
    alive: aliveFlags(room),
    hp: room.hp.map(h => Math.max(0, Math.round(h))), maxHp: MAX_HP,
    hpMax: room.hpMax && room.hpMax.length ? room.hpMax : undefined,
    biome: room.biome, ruins: room.ruins ? room.ruins.ranges : undefined,
    boss: bossSeatOf(room) >= 0 ? bossSeatOf(room) : undefined,
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

function startGame(room) {
  // Boss raid: the WARLORD occupies the LAST seat, appended once (a rematch
  // reuses it). It's a bot player, so every existing bot path just works.
  if (room.mode === 'boss' && !room.players.some(p => p && p.boss)) {
    room.players.push({
      ws: null, bot: true, boss: true, difficulty: 'boss', name: 'WARLORD-7',
      token: makeToken(), connected: true, dropTimer: null, skin: 'midnight',
    });
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
  room.crates = []; room.crateSeq = 1;
  room.shield = new Array(n).fill(0);
  room.turnCount = 0; room.bossShots = 0;
  const bSeat = bossSeatOf(room);
  if (bSeat >= 0) {                       // the mecha is a bigger, tougher target
    room.tanks[bSeat].scale = BOSS_SCALE;
    room.hp[bSeat] = BOSS_HP;
    room.hpMax[bSeat] = BOSS_HP;
  }
  room.ammo = Array.from({ length: n }, () => startingAmmo());
  // Everyone starts turned toward the middle of the map. (n=2 -> [1, -1], as before.)
  room.facing = room.tanks.map((_, i) => (i < n / 2 ? 1 : -1));
  room.hazards = []; room.hazardSeq = 1; room.scorch = [];
  room.turn = Math.floor(Math.random() * n);
  room.state = 'playing';
  for (let i = 0; i < n; i++) send(room.players[i].ws, { type: 'start', ...snapshot(room, i) });
  beginTurn(room);
}

// No shot-clock: players take as long as they like. Turns only advance on fire.
function beginTurn(room) {
  room.fuel = MOVE_BUDGET;
  room.turnCount = (room.turnCount || 0) + 1;
  maybeDropCrate(room);
  broadcast(room, { type: 'turn', turn: room.turn, fuel: room.fuel, alive: aliveFlags(room) });
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

function maybeDropCrate(room) {
  if (room.mode === 'golf' || room.state !== 'playing') return;
  if (room.turnCount < 3 || (room.turnCount - 3) % 4 !== 0) return;   // turn 3, 7, 11, ...
  if (room.crates.length >= 2) return;
  for (let tries = 0; tries < 14; tries++) {
    const x = Math.round(1800 + Math.random() * (WORLD_W - 3600));
    const clearTanks = room.tanks.every((t, i) => t.alive === false || Math.abs(t.x - x) > 900);
    const clearCrates = room.crates.every(c => Math.abs(c.x - x) > 800);
    if (!clearTanks || !clearCrates) continue;
    const kind = CRATE_KINDS[Math.floor(Math.random() * CRATE_KINDS.length)];
    const crate = { id: room.crateSeq++, x, y: Math.round(surfaceAt(room.terrain, x) * 10) / 10, kind };
    room.crates.push(crate);
    broadcast(room, { type: 'crate', crate });
    return;
  }
}

function pickupCrates(room, seat) {
  const tank = room.tanks[seat];
  for (let i = room.crates.length - 1; i >= 0; i--) {
    const c = room.crates[i];
    if (Math.abs(c.x - tank.x) > CRATE_REACH) continue;
    room.crates.splice(i, 1);
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
      detail = '+35 HP';
    }
    broadcast(room, {
      type: 'crateTaken', id: c.id, seat, kind: c.kind, detail,
      hp: room.hp.map(h => Math.max(0, Math.round(h))),
      shield: room.shield.slice(),
      ammo: room.ammo[seat], ammoSeat: seat,
    });
  }
}

// ---- AI opponent -------------------------------------------------------------
// When it's the CPU's turn, "think" briefly then fire. Only runs while the human
// opponent is connected, so a mid-turn disconnect pauses the bot until resume.
function scheduleBot(room) {
  const cur = room.players[room.turn];
  if (!room.vsBot || room.state !== 'playing' || !cur || !cur.bot) return;
  if (!room.players.some(p => p && !p.bot && p.connected)) return;   // nobody watching
  clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => botFire(room), 850 + Math.random() * 750);
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
  if (bot.boss) {
    room.bossShots = (room.bossShots || 0) + 1;
    const me = room.tanks[seat];
    let d = Infinity;
    for (let i = 0; i < room.tanks.length; i++) {
      if (i === seat || room.tanks[i].alive === false) continue;
      d = Math.min(d, Math.abs(room.tanks[i].x - me.x));
    }
    if (room.bossShots % 4 === 0) wid = 'b_quake';
    else if (d > 11000) wid = room.bossShots % 2 ? 'b_lance' : 'b_barrage';
    else if (d > 4500) wid = ['b_twin', 'b_barrage', 'b_flame'][room.bossShots % 3];
    else wid = room.bossShots % 2 ? 'b_flame' : 'b_twin';
  }
  const shot = aiShot(room.terrain, room.tanks, seat, bot.difficulty, room.facing[seat], wid);
  // Turn the turret toward its target, then show the barrel swing, then fire.
  if (shot.dir && shot.dir !== room.facing[seat]) {
    room.facing[seat] = shot.dir;
    broadcast(room, { type: 'face', seat, dir: shot.dir });
  }
  broadcast(room, { type: 'aim', seat, angle: shot.angle, power: shot.power, weapon: shot.weapon });
  room.botTimer = setTimeout(() => {
    if (room.state === 'playing' && room.turn === seat) resolveFire(room, seat, shot.weapon, shot.angle, shot.power);
  }, 550);
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
  clearInterval(room.dotTimer); room.dotTimer = null;
  clearInterval(room.fireTimer); room.fireTimer = null;
  killDead(room);
  const live = aliveSeats(room);
  let winner = live.length === 1 ? live[0] : -1;   // 0 left = mutual destruction
  let team = null;
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
  });
}

function handleFire(room, seat, msg) {
  if (room.state !== 'playing' || room.turn !== seat) return;
  const w = WEAPON_BY_ID[msg.weapon];
  if (!w) return;
  const pl = room.players[seat];
  if (w.bossOnly && !(pl && pl.boss)) return;   // the WARLORD's kit is its own
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
      lavaY: room.lavaY, biome: room.biome, guard: room.guard, props: room.props },
    { by: seat, weapon: w.id, angle, power, dir: room.facing[seat] }
  );

  if (w.ammo < 99) room.ammo[seat][w.id] = Math.max(0, (room.ammo[seat][w.id] || 0) - 1);
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
    props: result.props, propEvents: result.propEvents,
    shield: room.shield.slice(), shieldPop,
    ammo: room.ammo[seat],
    ammoSeat: seat,
    killcam: buildKillcam(room, result, aliveBefore),   // null on every normal shot
  });
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
  const now = Date.now();
  const dmg = fireDamage(room.hazards, room.tanks);      // spends one bite per blaze
  const before = room.hazards.length;
  room.hazards = room.hazards.filter(h => h.until == null || h.until > now);
  let hurt = false;
  for (let ti = 0; ti < room.hp.length; ti++) {
    if (dmg[ti] <= 0) continue;
    hurt = true;
    room.hp[ti] = Math.max(0, Math.round((room.hp[ti] - dmg[ti]) * 10) / 10);
  }
  killDead(room);
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
  if (room.state !== 'playing' || room.turn !== seat) return;
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
  clearInterval(room.dotTimer);
  clearInterval(room.fireTimer);
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
  }, RESUME_GRACE_MS);
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
          ws, name: msg.name || `Player ${seat + 1}`, token: makeToken(),
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
          r.players.push({ ws, name: msg.name || 'Player 2', token: makeToken(), connected: true, dropTimer: null, skin: sanitizeSkin(msg.skin, 1) });
          ws.roomCode = r.code; ws.seat = 1;
          startGame(r);
        } else {
          waiting = ws; ws._qname = msg.name || 'Player 1'; ws._qskin = msg.skin;
          send(ws, { type: 'queued' });
        }
        break;
      }
      case 'cancelQuick': if (waiting === ws) waiting = null; break;
      case 'ai': {
        const diff = ['easy', 'medium', 'hard'].includes(msg.difficulty) ? msg.difficulty : 'medium';
        // CPU games stay strictly 2-player.
        const r = createRoom(ws, msg.name, msg.skin, { mode: 'duel' });
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
        const minSeats = (r.mode === 'boss' || r.mode === 'golf') ? 1 : 2;
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
