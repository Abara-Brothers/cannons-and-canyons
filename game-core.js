// game-core.js — authoritative game logic for Pocket Tanks Online.
// Runs on the server only. Deterministic given the same inputs so both
// clients, which merely replay the server's resolved shot, stay in sync.

export const WORLD_W = 1280;
export const WORLD_H = 720;

const GRAVITY = 900;          // world units / s^2  (no wind, per spec)
const SPEED_PER_POWER = 12;   // power 0..100 -> speed 0..1200 u/s
const TANK_R = 15;            // tank body radius (for hit tests + damage)
const TANK_CY = 12;           // tank center sits this far above the ground line
const BARREL_LEN = 30;
const DT = 1 / 120;           // physics step
const SAMPLE_EVERY = 4;       // record a trajectory point every N steps (~30fps)
const MAX_T = 14;             // safety cap on flight time (s)
const ARM_DIST = 42;          // projectile ignores tank collisions until it has flown this far
const TERRAIN_TOP = 90;       // highest a mound may rise (min y)
const TERRAIN_FLOOR = WORLD_H - 18;

export const MOVE_BUDGET = 140;   // driving distance allowed per turn
export const MOVE_STEP = 6;
export const SHOT_CLOCK = 45;     // seconds per turn (short, keeps turns snappy)
export const SHOTS_PER_PLAYER = 10;

// ---- Weapons ---------------------------------------------------------------
// Data-driven. A weapon fires `shots` projectiles fanned across `spread` degrees.
// A `split` weapon fires one shell that bursts at the top of its arc into
// `split.count` bomblets. `ammo` limits how often a weapon can be used per match.
export const WEAPONS = [
  { id: 'cannon',  name: 'Cannon',        icon: '🔴', color: '#ff5a52', ammo: 99,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 25, radius: 34, terrain: 'crater',
    desc: 'Reliable single shell. Your bread and butter.' },
  { id: 'bigshot', name: 'Big Shot',      icon: '💥', color: '#ffb02e', ammo: 2,
    shots: 1, spread: 0,  speedMul: 0.95, damage: 46, radius: 58, terrain: 'crater',
    desc: 'One massive blast. Devastating on a direct hit.' },
  { id: 'twin',    name: 'Twin Shot',     icon: '♊', color: '#54c8ff', ammo: 3,
    shots: 2, spread: 7,  speedMul: 1.0, damage: 20, radius: 30, terrain: 'crater',
    desc: 'Two shells in a tight pair. Covers aiming error.' },
  { id: 'triple',  name: 'Triple Threat', icon: '🔱', color: '#7c6cff', ammo: 3,
    shots: 3, spread: 13, speedMul: 1.0, damage: 15, radius: 26, terrain: 'crater',
    desc: 'Three-way fan. Great against a dug-in tank.' },
  { id: 'scatter', name: 'Scatter Bomb',  icon: '✳️', color: '#ff7ac6', ammo: 3,
    shots: 5, spread: 26, speedMul: 1.0, damage: 10, radius: 20, terrain: 'crater',
    desc: 'Five-shell spread. Wide area, hard to fully connect.' },
  { id: 'cluster', name: 'Cluster Bomb',  icon: '🧨', color: '#ffd23f', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    split: { count: 4, spreadSpeed: 190, radius: 24, damage: 16, terrain: 'crater' },
    desc: 'Bursts at the top of its arc into four bomblets.' },
  { id: 'firestorm', name: 'Firestorm',   icon: '🔥', color: '#ff6a3d', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    split: { count: 6, spreadSpeed: 250, radius: 19, damage: 9, terrain: 'crater' },
    desc: 'Rains six blazing splashes across a wide strip.' },
  { id: 'sniper',  name: 'Sniper',        icon: '🎯', color: '#3ce88f', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.5, damage: 58, radius: 15, terrain: 'crater',
    desc: 'Fast + flat. Tiny blast, huge reward for precision.' },
  { id: 'digger',  name: 'Digger',        icon: '⛏️', color: '#c98a4b', ammo: 2,
    shots: 1, spread: 0,  speedMul: 0.9, damage: 9,  radius: 62, terrain: 'crater',
    desc: 'Collapse the ground and drop your foe into a pit.' },
  { id: 'dirt',    name: 'Dirt Mover',    icon: '🟫', color: '#8a5a2b', ammo: 2,
    shots: 1, spread: 0,  speedMul: 0.9, damage: 0,  radius: 50, terrain: 'dirt',
    desc: 'Build a wall or bury the enemy. Deals no damage.' },
  { id: 'nuke',    name: 'Nuke',          icon: '☢️', color: '#b6ff5a', ammo: 1,
    shots: 1, spread: 0,  speedMul: 0.9, damage: 72, radius: 86, terrain: 'crater',
    desc: 'One warhead, enormous blast. You only get one.' },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));

// Public weapon info for the client UI (no physics numbers needed there).
export function weaponMenu() {
  return WEAPONS.map(w => ({ id: w.id, name: w.name, icon: w.icon, color: w.color, ammo: w.ammo, desc: w.desc }));
}

export function startingAmmo() {
  const a = {};
  for (const w of WEAPONS) a[w.id] = w.ammo;
  return a;
}

// ---- Deterministic RNG (for terrain variety) ------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Terrain ---------------------------------------------------------------
// Heightmap: surfaceY[x] for x in 0..WORLD_W. Smaller y = higher ground.
export function generateTerrain(seed) {
  const rng = mulberry32(seed);
  const types = ['flats', 'hill', 'valley', 'cliff'];
  const type = types[Math.floor(rng() * types.length)];
  const base = WORLD_H * 0.64;
  const terrain = new Array(WORLD_W + 1);

  const a1 = 14 + rng() * 22, f1 = 0.004 + rng() * 0.004, p1 = rng() * Math.PI * 2;
  const a2 = 6 + rng() * 12,  f2 = 0.011 + rng() * 0.01,  p2 = rng() * Math.PI * 2;

  const cliffAt = WORLD_W * (0.4 + rng() * 0.2);
  const cliffDrop = 90 + rng() * 70;
  const cliffLeftHigh = rng() < 0.5;

  for (let x = 0; x <= WORLD_W; x++) {
    let y = base;
    y += Math.sin(x * f1 + p1) * a1;
    y += Math.sin(x * f2 + p2) * a2;

    const c = x / WORLD_W;
    const centerBump = Math.cos((c - 0.5) * Math.PI);

    if (type === 'hill') y -= centerBump * (120 + rng() * 30);
    else if (type === 'valley') y += centerBump * (120 + rng() * 30);
    else if (type === 'cliff') {
      const high = cliffLeftHigh ? x < cliffAt : x >= cliffAt;
      y += high ? -cliffDrop * 0.5 : cliffDrop * 0.5;
    }
    terrain[x] = clampY(y);
  }
  smooth(terrain, 3);
  return terrain;
}

function clampY(y) { return Math.max(TERRAIN_TOP, Math.min(TERRAIN_FLOOR, y)); }

function smooth(terrain, passes) {
  for (let p = 0; p < passes; p++) {
    for (let x = 1; x < terrain.length - 1; x++) {
      terrain[x] = (terrain[x - 1] + terrain[x] * 2 + terrain[x + 1]) / 4;
    }
  }
}

export function surfaceAt(terrain, x) {
  if (x <= 0) return terrain[0];
  if (x >= WORLD_W) return terrain[WORLD_W];
  const i = Math.floor(x), f = x - i;
  return terrain[i] * (1 - f) + terrain[i + 1] * f;
}

// Left tank half and right tank half bounds (kept apart so they can't collide).
export const HALF = {
  0: [60, WORLD_W * 0.5 - 90],
  1: [WORLD_W * 0.5 + 90, WORLD_W - 60],
};

export function spawnTanks(terrain) {
  const x0 = 130, x1 = WORLD_W - 130;
  return [
    { x: x0, y: surfaceAt(terrain, x0) },
    { x: x1, y: surfaceAt(terrain, x1) },
  ];
}

function settle(terrain, tanks) {
  for (const t of tanks) t.y = surfaceAt(terrain, t.x);
}

// Carve a crater (remove dirt) or add a dirt mound within a circle.
function deform(terrain, cx, cy, r, mode) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(WORLD_W, Math.ceil(cx + r));
  for (let x = x0; x <= x1; x++) {
    const dx = x - cx;
    if (Math.abs(dx) > r) continue;
    const dy = Math.sqrt(r * r - dx * dx);
    if (mode === 'crater') terrain[x] = clampY(Math.max(terrain[x], cy + dy)); // can only lower ground
    else if (mode === 'dirt') terrain[x] = clampY(Math.min(terrain[x], cy - dy)); // can only raise ground
  }
}

// ---- Shot simulation -------------------------------------------------------
// state: { terrain, tanks }. shot: { by, weapon, angle (0..180), power (0..100) }
// Returns a fully resolved shot the clients replay verbatim. Each projectile
// carries an optional `delay` (playback points to wait before it appears) so
// cluster bomblets animate starting from the parent's burst point.
export function simulateShot(state, shot) {
  const w = WEAPON_BY_ID[shot.weapon] || WEAPON_BY_ID.cannon;
  const by = shot.by;
  const dir = by === 0 ? 1 : -1;
  const power = Math.max(1, Math.min(100, shot.power));
  const angle = Math.max(0, Math.min(180, shot.angle));
  const speed = power * SPEED_PER_POWER * w.speedMul;
  const tank = state.tanks[by];
  const damageDealt = [0, 0];
  const projectiles = [];

  const boom = (x, y, r, kind, dmg) => {
    if (kind !== 'none') deform(state.terrain, x, y, r, kind);
    if (dmg > 0) for (let ti = 0; ti < 2; ti++) damageDealt[ti] += blastDamage(x, y, r, dmg, state.tanks[ti]);
  };
  const det = (x, y, r, kind) => ({ x: round1(x), y: round1(y), r, kind, color: w.color });

  const nSub = w.shots;
  for (let i = 0; i < nSub; i++) {
    const off = nSub === 1 ? 0 : (-w.spread / 2 + (w.spread * i) / (nSub - 1));
    const rad = ((angle + off) * Math.PI) / 180;
    const vx = Math.cos(rad) * speed * dir;
    const vy = -Math.sin(rad) * speed;
    const ox = tank.x + Math.cos(rad) * dir * BARREL_LEN;
    const oy = (tank.y - TANK_CY) - Math.sin(rad) * BARREL_LEN;

    if (w.split) {
      const fp = integrate(state.terrain, state.tanks, ox, oy, vx, vy, { stopAtApex: true });
      if (fp.apex) {
        projectiles.push({ path: fp.path, det: det(fp.x, fp.y, 13, 'none'), delay: 0 }); // burst puff
        const parentLen = fp.path.length;
        const s = w.split;
        for (let k = 0; k < s.count; k++) {
          const frac = s.count === 1 ? 0.5 : k / (s.count - 1);
          const cvx = fp.vx * 0.45 + (frac * 2 - 1) * s.spreadSpeed;
          const cf = integrate(state.terrain, state.tanks, fp.x, fp.y, cvx, -40, {});
          let cdet = null;
          if (cf.hit) { cdet = det(cf.x, cf.y, s.radius, s.terrain); boom(cf.x, cf.y, s.radius, s.terrain, s.damage); }
          projectiles.push({ path: cf.path, det: cdet, delay: parentLen });
        }
      } else {
        // Hit something before apex — behave like a plain shell using split stats.
        let d = null;
        if (fp.hit) { d = det(fp.x, fp.y, w.split.radius, w.split.terrain); boom(fp.x, fp.y, w.split.radius, w.split.terrain, w.split.damage); }
        projectiles.push({ path: fp.path, det: d, delay: 0 });
      }
    } else {
      const fp = integrate(state.terrain, state.tanks, ox, oy, vx, vy, {});
      let d = null;
      if (fp.hit) { d = det(fp.x, fp.y, w.radius, w.terrain); boom(fp.x, fp.y, w.radius, w.terrain, w.damage); }
      projectiles.push({ path: fp.path, det: d, delay: 0 });
    }
  }

  settle(state.terrain, state.tanks);
  const opp = 1 - by;
  return {
    projectiles,
    tanks: state.tanks.map(t => ({ x: round1(t.x), y: round1(t.y) })),
    scoreDelta: Math.round(damageDealt[opp]),
    damage: damageDealt.map(d => Math.round(d)),
    weapon: w.id, by,
  };
}

function integrate(terrain, tanks, ox, oy, vx, vy, opts) {
  const path = [[round1(ox), round1(oy)]];
  let x = ox, y = oy, t = 0, step = 0, prevVy = vy;
  while (t < MAX_T) {
    vy += GRAVITY * DT;
    x += vx * DT;
    y += vy * DT;
    t += DT;

    if (opts.stopAtApex && prevVy < 0 && vy >= 0) {   // top of the arc
      path.push([round1(x), round1(y)]);
      return { path, hit: false, apex: true, x, y, vx, vy };
    }
    prevVy = vy;

    if (x < 0 || x > WORLD_W) { path.push([round1(x), round1(y)]); return { path, hit: false, x, y, vx, vy }; }
    const gy = surfaceAt(terrain, x);
    if (y >= gy) { path.push([round1(x), round1(gy)]); return { path, hit: true, x, y: gy, vx, vy }; }
    if (Math.hypot(x - ox, y - oy) > ARM_DIST) {
      for (const tk of tanks) {
        if (Math.hypot(x - tk.x, y - (tk.y - TANK_CY)) <= TANK_R + 3) {
          path.push([round1(x), round1(y)]); return { path, hit: true, x, y, vx, vy };
        }
      }
    }
    if (++step % SAMPLE_EVERY === 0) path.push([round1(x), round1(y)]);
  }
  path.push([round1(x), round1(y)]);
  return { path, hit: false, x, y, vx, vy };
}

function blastDamage(cx, cy, r, dmg, tank) {
  const d = Math.hypot(tank.x - cx, (tank.y - TANK_CY) - cy);
  if (d > r) return 0;
  return dmg * (1 - d / r);
}

function round1(n) { return Math.round(n * 10) / 10; }

// Compress a full terrain array into a changed-range diff for the wire.
export function terrainDiff(before, after) {
  let from = -1, to = -1;
  for (let x = 0; x < after.length; x++) {
    if (Math.abs(after[x] - before[x]) > 0.05) {
      if (from === -1) from = x;
      to = x;
    }
  }
  if (from === -1) return null;
  const values = [];
  for (let x = from; x <= to; x++) values.push(round1(after[x]));
  return { from, values };
}
