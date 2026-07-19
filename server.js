// server.js — static host + WebSocket relay/authority for Pocket Tanks Online.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import {
  WORLD_W, WORLD_H, MOVE_BUDGET, MOVE_STEP, SHOT_CLOCK, SHOTS_PER_PLAYER, HALF,
  generateTerrain, spawnTanks, surfaceAt, simulateShot, terrainDiff,
  weaponMenu, startingAmmo, WEAPON_BY_ID,
} from './game-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

// ---- Static file server ----------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
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

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  for (const p of room.players) if (p) send(p.ws, msg);
}

function createRoom(hostWs, name) {
  const code = makeCode();
  const room = {
    code,
    players: [{ ws: hostWs, name: name || 'Player 1' }, null],
    state: 'waiting',
    terrain: null, tanks: null,
    scores: [0, 0], shotsLeft: [SHOTS_PER_PLAYER, SHOTS_PER_PLAYER],
    ammo: [startingAmmo(), startingAmmo()],
    turn: 0, fuel: MOVE_BUDGET, seed: 0,
    clock: null, clockEndsAt: 0,
    aim: { angle: 45, power: 60 },
  };
  rooms.set(code, room);
  hostWs.roomCode = code; hostWs.seat = 0;
  return room;
}

function startGame(room) {
  room.seed = (Math.floor(Math.random() * 1e9)) >>> 0;
  room.terrain = generateTerrain(room.seed);
  room.tanks = spawnTanks(room.terrain);
  room.scores = [0, 0];
  room.shotsLeft = [SHOTS_PER_PLAYER, SHOTS_PER_PLAYER];
  room.ammo = [startingAmmo(), startingAmmo()];
  room.turn = Math.random() < 0.5 ? 0 : 1;
  room.state = 'playing';

  const base = {
    type: 'start',
    world: { w: WORLD_W, h: WORLD_H },
    terrain: room.terrain.map(v => Math.round(v * 10) / 10),
    tanks: room.tanks.map(t => ({ x: t.x, y: t.y })),
    weapons: weaponMenu(),
    names: [room.players[0].name, room.players[1].name],
    scores: room.scores, shotsLeft: room.shotsLeft,
    moveBudget: MOVE_BUDGET, shotClock: SHOT_CLOCK, shotsPerPlayer: SHOTS_PER_PLAYER,
    turn: room.turn,
  };
  for (let i = 0; i < 2; i++) send(room.players[i].ws, { ...base, you: i, ammo: room.ammo[i] });
  beginTurn(room);
}

function beginTurn(room) {
  room.fuel = MOVE_BUDGET;
  room.aim = { angle: 45, power: 60 };
  clearTimeout(room.clock);
  room.clockEndsAt = Date.now() + SHOT_CLOCK * 1000;
  broadcast(room, { type: 'turn', turn: room.turn, fuel: room.fuel, endsAt: room.clockEndsAt });
  room.clock = setTimeout(() => timeoutTurn(room), SHOT_CLOCK * 1000);
}

function timeoutTurn(room) {
  if (room.state !== 'playing') return;
  // Skip the shot but still consume it, so the match can't stall.
  const by = room.turn;
  room.shotsLeft[by] = Math.max(0, room.shotsLeft[by] - 1);
  broadcast(room, { type: 'passed', by, shotsLeft: room.shotsLeft });
  advance(room, by);
}

function advance(room, by) {
  if (room.shotsLeft[0] <= 0 && room.shotsLeft[1] <= 0) return endGame(room);
  // Hand over to the other player if they still have shots, else keep firing.
  const other = 1 - by;
  room.turn = room.shotsLeft[other] > 0 ? other : by;
  beginTurn(room);
}

function endGame(room) {
  room.state = 'over';
  clearTimeout(room.clock);
  let winner = -1;
  if (room.scores[0] > room.scores[1]) winner = 0;
  else if (room.scores[1] > room.scores[0]) winner = 1;
  broadcast(room, { type: 'gameover', scores: room.scores, winner });
}

function handleFire(room, seat, msg) {
  if (room.state !== 'playing' || room.turn !== seat) return;
  if (room.shotsLeft[seat] <= 0) return;
  const w = WEAPON_BY_ID[msg.weapon];
  if (!w) return;
  if ((room.ammo[seat][w.id] || 0) <= 0) return;

  clearTimeout(room.clock);
  const before = room.terrain.slice();
  const result = simulateShot(
    { terrain: room.terrain, tanks: room.tanks },
    { by: seat, weapon: w.id, angle: msg.angle, power: msg.power }
  );

  if (w.ammo < 99) room.ammo[seat][w.id] = Math.max(0, (room.ammo[seat][w.id] || 0) - 1);
  room.scores[seat] += result.scoreDelta;
  room.shotsLeft[seat] = Math.max(0, room.shotsLeft[seat] - 1);
  const diff = terrainDiff(before, room.terrain);

  broadcast(room, {
    type: 'shot',
    by: seat,
    weapon: w.id,
    projectiles: result.projectiles,
    terrainDiff: diff,
    tanks: result.tanks,
    scores: room.scores,
    damage: result.damage,
    scoreDelta: result.scoreDelta,
    shotsLeft: room.shotsLeft,
    ammo: room.ammo[seat],
    ammoSeat: seat,
  });
  // Give the shot animation a beat to play out before the next turn begins.
  clearTimeout(room.clock);
  room.clock = setTimeout(() => advance(room, seat), 300);
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

function leaveRoom(ws) {
  if (waiting === ws) waiting = null;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  clearTimeout(room.clock);
  const opp = room.players[1 - ws.seat];
  if (opp) send(opp.ws, { type: 'opponentLeft' });
  rooms.delete(room.code);
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
        const r = createRoom(ws, msg.name);
        send(ws, { type: 'created', code: r.code });
        break;
      }
      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) return send(ws, { type: 'joinError', reason: 'No game with that code.' });
        if (r.players[1] || r.state !== 'waiting') return send(ws, { type: 'joinError', reason: 'That game is full.' });
        r.players[1] = { ws, name: msg.name || 'Player 2' };
        ws.roomCode = code; ws.seat = 1;
        startGame(r);
        break;
      }
      case 'quick': {
        if (waiting && waiting !== ws && waiting.readyState === 1) {
          const host = waiting; waiting = null;
          const r = createRoom(host, host._qname);
          r.players[1] = { ws, name: msg.name || 'Player 2' };
          ws.roomCode = r.code; ws.seat = 1;
          startGame(r);
        } else {
          waiting = ws; ws._qname = msg.name || 'Player 1';
          send(ws, { type: 'queued' });
        }
        break;
      }
      case 'cancelQuick': if (waiting === ws) waiting = null; break;
      case 'aim': {
        if (!room || room.turn !== ws.seat || room.state !== 'playing') return;
        room.aim = { angle: msg.angle, power: msg.power };
        const opp = room.players[1 - ws.seat];
        if (opp) send(opp.ws, { type: 'aim', seat: ws.seat, angle: msg.angle, power: msg.power, weapon: msg.weapon });
        break;
      }
      case 'move': if (room) handleMove(room, ws.seat, msg.dir); break;
      case 'fire': if (room) handleFire(room, ws.seat, msg); break;
      case 'rematch': {
        if (room && room.state === 'over' && room.players[0] && room.players[1]) startGame(room);
        break;
      }
      case 'leave': leaveRoom(ws); break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
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
  console.log(`Pocket Tanks Online running at http://localhost:${PORT}`);
});
