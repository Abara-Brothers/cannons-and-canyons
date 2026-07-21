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
function createRoom(hostWs, name, skin, opts = {}) {
  const code = makeCode();
  const mode = opts.mode === 'ffa' ? 'ffa' : 'duel';
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
    world: { w: WORLD_W, h: WORLD_H }, lavaY: LAVA_Y,
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

function startGame(room) {
  const n = room.players.length;
  room.seed = (Math.floor(Math.random() * 1e9)) >>> 0;
  room.terrain = generateTerrain(room.seed, n);
  room.trees = generateTrees(room.terrain, room.seed, n);
  room.tanks = spawnTanks(room.terrain, room.seed, n);   // ordered left -> right
  room.hp = new Array(n).fill(MAX_HP);
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
  broadcast(room, { type: 'turn', turn: room.turn, fuel: room.fuel, alive: aliveFlags(room) });
  scheduleBot(room);
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
  const shot = aiShot(room.terrain, room.tanks, seat, bot.difficulty, room.facing[seat]);
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
  const live = aliveSeats(room);
  if (live.length <= 1) return endGame(room);
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
  const winner = live.length === 1 ? live[0] : -1;   // 0 left = mutual destruction
  broadcast(room, {
    type: 'gameover',
    hp: room.hp.map(h => Math.max(0, Math.round(h))),
    alive: aliveFlags(room),
    winner,
  });
}

function handleFire(room, seat, msg) {
  if (room.state !== 'playing' || room.turn !== seat) return;
  const w = WEAPON_BY_ID[msg.weapon];
  if (!w) return;
  if ((room.ammo[seat][w.id] || 0) <= 0) return;
  resolveFire(room, seat, w.id, msg.angle, msg.power);
}

// Shared shot resolution — used by both the human 'fire' message and the bot.
function resolveFire(room, seat, weaponId, angle, power) {
  const w = WEAPON_BY_ID[weaponId] || WEAPON_BY_ID.cannon;
  clearTimeout(room.clock);
  const before = room.terrain.slice();
  const result = simulateShot(
    { terrain: room.terrain, tanks: room.tanks },
    { by: seat, weapon: w.id, angle, power, dir: room.facing[seat] }
  );

  if (w.ammo < 99) room.ammo[seat][w.id] = Math.max(0, (room.ammo[seat][w.id] || 0) - 1);
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
    ammo: room.ammo[seat],
    ammoSeat: seat,
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
  if (aliveSeats(room).length <= 1) return advance(room, seat);   // blast already decided it
  const first = burnTick(room.hazards, room.tanks);
  if (!first.some(d => d > 0)) return advance(room, seat);        // nobody's standing in it
  let ticks = 0;
  room.dotTimer = setInterval(() => {
    if (room.state !== 'playing') { clearInterval(room.dotTimer); room.dotTimer = null; return; }
    ticks++;
    const dmg = burnTick(room.hazards, room.tanks);
    for (let ti = 0; ti < room.hp.length; ti++) {
      dmg[ti] = Math.min(dmg[ti], 14);   // cap per second so overlapping clouds don't nuke
      room.hp[ti] = Math.max(0, Math.round((room.hp[ti] - dmg[ti]) * 10) / 10);
    }
    killDead(room);
    const over = aliveSeats(room).length <= 1;
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
  if (aliveSeats(room).length <= 1) { stopFire(room); return endGame(room); }
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
    if (aliveSeats(room).length <= 1) return endGame(room);
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
        if (seatCount(r) < 2) { send(ws, { type: 'joinError', reason: 'Need at least 2 commanders.' }); break; }
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
