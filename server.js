// server.js — static host + WebSocket relay/authority for Canyons & Cannons.
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import {
  WORLD_W, WORLD_H, MOVE_BUDGET, MOVE_STEP, MAX_HP, HALF,
  generateTerrain, generateTrees, spawnTanks, surfaceAt, simulateShot, terrainDiff,
  weaponMenu, startingAmmo, WEAPON_BY_ID, tickHazards, burnTick, aiShot,
} from './game-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const RESUME_GRACE_MS = 120000;   // how long a disconnected player may return

// Cosmetic tank paints (client renders them; validate ids here).
const SKINS = ['olive', 'desert', 'jungle', 'midnight', 'arctic', 'gold'];
const sanitizeSkin = (s, seat) => (SKINS.includes(s) ? s : (seat === 0 ? 'olive' : 'desert'));

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

function createRoom(hostWs, name, skin) {
  const code = makeCode();
  const room = {
    code,
    players: [
      { ws: hostWs, name: name || 'Player 1', token: makeToken(), connected: true, dropTimer: null, skin: sanitizeSkin(skin, 0) },
      null,
    ],
    state: 'waiting',
    terrain: null, tanks: null,
    hp: [MAX_HP, MAX_HP],
    ammo: [startingAmmo(), startingAmmo()],
    turn: 0, fuel: MOVE_BUDGET, seed: 0,
    clock: null,                       // only used to pace the post-shot handover
    aim: { angle: 45, power: 60 },
    hazards: [], hazardSeq: 1,         // lingering fire / gas areas
    trees: [],
  };
  rooms.set(code, room);
  hostWs.roomCode = code; hostWs.seat = 0;
  return room;
}

// Current-state snapshot — used both for match start and for resume.
function snapshot(room, seat) {
  return {
    world: { w: WORLD_W, h: WORLD_H },
    terrain: room.terrain.map(v => Math.round(v * 10) / 10),
    trees: room.trees,
    tanks: room.tanks.map(t => ({ x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10 })),
    weapons: weaponMenu(),
    names: [room.players[0].name, room.players[1].name],
    skins: [room.players[0].skin, room.players[1].skin],
    hp: room.hp.map(h => Math.max(0, Math.round(h))), maxHp: MAX_HP,
    hazards: room.hazards,
    moveBudget: MOVE_BUDGET,
    turn: room.turn, fuel: room.fuel,
    you: seat,
    ammo: room.ammo[seat],
    token: room.players[seat].token,
    code: room.code,
  };
}

function startGame(room) {
  room.seed = (Math.floor(Math.random() * 1e9)) >>> 0;
  room.terrain = generateTerrain(room.seed);
  room.trees = generateTrees(room.terrain, room.seed);
  room.tanks = spawnTanks(room.terrain, room.seed);
  room.hp = [MAX_HP, MAX_HP];
  room.ammo = [startingAmmo(), startingAmmo()];
  room.hazards = []; room.hazardSeq = 1;
  room.turn = Math.random() < 0.5 ? 0 : 1;
  room.state = 'playing';
  for (let i = 0; i < 2; i++) send(room.players[i].ws, { type: 'start', ...snapshot(room, i) });
  beginTurn(room);
}

// No shot-clock: players take as long as they like. Turns only advance on fire.
function beginTurn(room) {
  room.fuel = MOVE_BUDGET;
  broadcast(room, { type: 'turn', turn: room.turn, fuel: room.fuel });
  scheduleBot(room);
}

// ---- AI opponent -------------------------------------------------------------
// When it's the CPU's turn, "think" briefly then fire. Only runs while the human
// opponent is connected, so a mid-turn disconnect pauses the bot until resume.
function scheduleBot(room) {
  const cur = room.players[room.turn];
  if (!room.vsBot || room.state !== 'playing' || !cur || !cur.bot) return;
  const human = room.players[1 - room.turn];
  if (!human || !human.connected) return;
  clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => botFire(room), 850 + Math.random() * 750);
}

function botFire(room) {
  if (room.state !== 'playing') return;
  const seat = room.turn;
  const bot = room.players[seat];
  if (!bot || !bot.bot) return;
  const shot = aiShot(room.terrain, room.tanks, seat, bot.difficulty);
  // Show the barrel swing to its firing solution, then fire.
  const human = room.players[1 - seat];
  if (human && human.ws) send(human.ws, { type: 'aim', seat, angle: shot.angle, power: shot.power, weapon: shot.weapon });
  room.botTimer = setTimeout(() => {
    if (room.state === 'playing' && room.turn === seat) resolveFire(room, seat, shot.weapon, shot.angle, shot.power);
  }, 550);
}

// Unlimited shots — the match only ends when a tank is destroyed.
function advance(room, by) {
  if (room.hp[0] <= 0 || room.hp[1] <= 0) return endGame(room);
  room.turn = 1 - by;
  beginTurn(room);
}

function endGame(room) {
  room.state = 'over';
  clearTimeout(room.clock);
  let winner = -1;
  const dead0 = room.hp[0] <= 0, dead1 = room.hp[1] <= 0;
  if (dead0 && dead1) winner = room.hp[0] > room.hp[1] ? 0 : room.hp[1] > room.hp[0] ? 1 : -1;
  else if (dead1) winner = 0;
  else if (dead0) winner = 1;
  broadcast(room, { type: 'gameover', hp: room.hp.map(h => Math.max(0, Math.round(h))), winner });
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
    { by: seat, weapon: w.id, angle, power }
  );

  if (w.ammo < 99) room.ammo[seat][w.id] = Math.max(0, (room.ammo[seat][w.id] || 0) - 1);
  // Blast damage hits health directly (self-damage counts too).
  room.hp[0] -= result.damage[0];
  room.hp[1] -= result.damage[1];
  const diff = terrainDiff(before, room.terrain);

  // Age out expired hazard areas, then add the ones this shot just created.
  // (Fire/gas damage is NOT applied here — it's the real-time burn below.)
  const tick = tickHazards(room.hazards, room.tanks);
  room.hazards = tick.alive;
  for (const hz of (result.newHazards || [])) {
    room.hazards.push({ id: room.hazardSeq++, owner: seat, ...hz });
  }
  if (room.hazards.length > 12) room.hazards.splice(0, room.hazards.length - 12);
  room.hp[0] = Math.max(0, Math.round(room.hp[0] * 10) / 10);
  room.hp[1] = Math.max(0, Math.round(room.hp[1] * 10) / 10);

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
    hazardDamage: [0, 0],
    ammo: room.ammo[seat],
    ammoSeat: seat,
  });
  // Give the shot animation a beat, then play out any fire/toxic burn before the
  // next turn (real-time damage-over-time; the turn holds until it finishes).
  clearTimeout(room.clock);
  room.clock = setTimeout(() => startBurn(room, seat), 300);
}

// Real-time 5-second damage-over-time: any tank sitting in a fire/gas area loses
// its per-second dps once a second for 5 ticks, then the turn advances.
function startBurn(room, seat) {
  clearInterval(room.dotTimer); room.dotTimer = null;
  if (room.state !== 'playing') return;
  if (room.hp[0] <= 0 || room.hp[1] <= 0) return advance(room, seat); // blast already decided it
  const first = burnTick(room.hazards, room.tanks);
  if (first[0] <= 0 && first[1] <= 0) return advance(room, seat);      // nobody's standing in it
  let ticks = 0;
  room.dotTimer = setInterval(() => {
    if (room.state !== 'playing') { clearInterval(room.dotTimer); room.dotTimer = null; return; }
    ticks++;
    const dmg = burnTick(room.hazards, room.tanks);
    for (let ti = 0; ti < 2; ti++) {
      dmg[ti] = Math.min(dmg[ti], 14);   // cap per second so overlapping clouds don't nuke
      room.hp[ti] = Math.max(0, Math.round((room.hp[ti] - dmg[ti]) * 10) / 10);
    }
    broadcast(room, { type: 'dot', tick: ticks, hp: room.hp.map(h => Math.max(0, Math.round(h))), damage: dmg.map(d => Math.round(d)) });
    const dead = room.hp[0] <= 0 || room.hp[1] <= 0;
    if (ticks >= 5 || dead) {
      clearInterval(room.dotTimer); room.dotTimer = null;
      if (dead) endGame(room); else advance(room, seat);
    }
  }, 1000);
}

function handleMove(room, seat, dir) {
  if (room.state !== 'playing' || room.turn !== seat) return;
  if (room.fuel < MOVE_STEP) return;
  const [lo, hi] = HALF[seat];
  const tank = room.tanks[seat];
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
function teardown(room, notifySeat) {
  clearTimeout(room.clock);
  clearTimeout(room.botTimer);
  clearInterval(room.dotTimer);
  for (const p of room.players) if (p) clearTimeout(p.dropTimer);
  if (notifySeat !== undefined) {
    const opp = room.players[notifySeat];
    if (opp && opp.ws) send(opp.ws, { type: 'opponentLeft' });
  }
  rooms.delete(room.code);
}

function handleClose(ws) {
  if (waiting === ws) waiting = null;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const seat = ws.seat;
  const player = room.players[seat];
  if (!player || player.ws !== ws) return;

  if (room.state !== 'playing') {         // lobby or finished — no seat to hold
    teardown(room, 1 - seat);
    return;
  }
  player.ws = null;
  player.connected = false;
  const opp = room.players[1 - seat];
  if (opp && opp.ws) send(opp.ws, { type: 'oppConn', connected: false });
  clearTimeout(player.dropTimer);
  player.dropTimer = setTimeout(() => {
    if (!player.connected) teardown(room, 1 - seat);
  }, RESUME_GRACE_MS);
  // If both players are gone, drop the room right away.
  if (!room.players[0].connected && !(room.players[1] && room.players[1].connected)) teardown(room);
}

function handleResume(ws, msg) {
  const room = rooms.get((msg.code || '').toUpperCase().trim());
  if (!room || room.state !== 'playing') return send(ws, { type: 'resumeError' });
  const seat = room.players.findIndex(p => p && p.token === msg.token);
  if (seat < 0 || room.players[seat].connected) return send(ws, { type: 'resumeError' });
  const player = room.players[seat];
  clearTimeout(player.dropTimer);
  player.ws = ws; player.connected = true;
  ws.roomCode = room.code; ws.seat = seat;
  send(ws, { type: 'restore', ...snapshot(room, seat) });
  const opp = room.players[1 - seat];
  if (opp && opp.ws) send(opp.ws, { type: 'oppConn', connected: true });
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
        const r = createRoom(ws, msg.name, msg.skin);
        send(ws, { type: 'created', code: r.code });
        break;
      }
      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) return send(ws, { type: 'joinError', reason: 'No game with that code.' });
        if (r.players[1] || r.state !== 'waiting') return send(ws, { type: 'joinError', reason: 'That game is full.' });
        r.players[1] = { ws, name: msg.name || 'Player 2', token: makeToken(), connected: true, dropTimer: null, skin: sanitizeSkin(msg.skin, 1) };
        ws.roomCode = code; ws.seat = 1;
        startGame(r);
        break;
      }
      case 'quick': {
        if (waiting && waiting !== ws && waiting.readyState === 1) {
          const host = waiting; waiting = null;
          const r = createRoom(host, host._qname, host._qskin);
          r.players[1] = { ws, name: msg.name || 'Player 2', token: makeToken(), connected: true, dropTimer: null, skin: sanitizeSkin(msg.skin, 1) };
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
        const r = createRoom(ws, msg.name, msg.skin);
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
        const opp = room.players[1 - ws.seat];
        if (opp && opp.ws) send(opp.ws, { type: 'aim', seat: ws.seat, angle: msg.angle, power: msg.power, weapon: msg.weapon });
        break;
      }
      case 'move': if (room) handleMove(room, ws.seat, msg.dir); break;
      case 'fire': if (room) handleFire(room, ws.seat, msg); break;
      case 'rematch': {
        if (room && room.state === 'over' && room.players[0] && room.players[1]
          && room.players[0].connected && room.players[1].connected) startGame(room);
        break;
      }
      case 'leave': {
        if (room) teardown(room, 1 - ws.seat);
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
