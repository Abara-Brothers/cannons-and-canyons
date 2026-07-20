// game-core.js — authoritative game logic for Canyons & Cannons.
// Runs on the server only. Deterministic given the same inputs so both
// clients, which merely replay the server's resolved shot, stay in sync.

export const WORLD_W = 24000; // battlefield sized so a zoom-out frames BOTH tanks well
export const WORLD_H = 13500; // tall world → room for huge peaks and deep canyons (no ceiling clipping)

const GRAVITY = 900;          // world units / s^2  (no wind, per spec)
const SPEED_PER_POWER = 64;   // power 0..100 -> speed 0..6400 u/s. Max 45° range = 6400^2/900 ≈ 45,511 —
                              // ~1.9× the 24,000-wide map, so full map ≈ power 72 (good aiming granularity),
                              // and steep high-angle lobs still clear the tallest peaks.
const BARREL_LEN = 42;        // shell spawn distance from the turret pivot
const DT = 1 / 120;           // physics step
const SAMPLE_EVERY = 4;       // record a trajectory point every N steps (~30fps)
const MAX_T = 26;             // safety cap on flight time (s)
const ARM_DIST = 100;         // projectile ignores tank collisions until it has flown this far
const TERRAIN_TOP = 140;      // highest a peak/mound may rise (min y) — headroom for tall peaks
const TERRAIN_FLOOR = WORLD_H - 60;
const CRATER_MUL = 2.2;       // craters (and blast visuals) are much larger than the damage radius

// ---- Tank hitbox (world units) ---------------------------------------------
// The hitbox is the tank's OUTLINE: a hull/track box topped by a narrower
// turret box, anchored at the tank's ground point (tank.x, tank.y).
const TANK_HW = 27;           // hull half-width (tanks shrunk ~0.6× for the vast map)
const TANK_HULL_H = 24;       // hull top, above the ground point
const TANK_TUR_HW = 13;       // turret half-width
const TANK_TOP = 40;          // turret top, above the ground point
const TANK_CY = 24;           // turret pivot height (barrel origin)

export function pointHitsTank(x, y, tank) {
  const dx = x - tank.x;
  const up = tank.y - y;                       // height above the ground point
  if (Math.abs(dx) <= TANK_HW && up >= -6 && up <= TANK_HULL_H) return true;   // hull + tracks
  if (Math.abs(dx) <= TANK_TUR_HW && up > TANK_HULL_H && up <= TANK_TOP) return true; // turret
  return false;
}

// Distance from a point to the nearest point of the tank outline.
function distToTank(cx, cy, tank) {
  const rx = Math.max(tank.x - TANK_HW, Math.min(cx, tank.x + TANK_HW));
  const ry = Math.max(tank.y - TANK_TOP, Math.min(cy, tank.y));
  return Math.hypot(cx - rx, cy - ry);
}

export const MOVE_BUDGET = 4500;  // driving distance allowed per turn — generous fuel to reposition
export const MOVE_STEP = 60;      // distance per move tick (fast drive)
export const MAX_HP = 100;        // tanks have health — destroy the enemy to win (no shot limit)

// ---- Weapons ---------------------------------------------------------------
// A modern military arsenal. Each entry is data-driven:
//   shots/spread   — multi-projectile fan
//   split          — bursts at the apex into bomblets
//   airstrike      — the shell is a target beacon; bombers rain a stick of
//                    bombs across where it lands
//   hazard         — every damaging detonation leaves a lingering area effect
//                    (fire / toxic gas) that deals damage over the next turns
//   dig            — detonates deep below the surface (bunker buster)
//   wall           — raises a tall earthwork rampart instead of exploding
// `radius` is the DAMAGE radius; craters and blast visuals scale by CRATER_MUL.
export const WEAPONS = [
  { id: 'cannon',   name: 'Cannon',        color: '#ff5a52', ammo: 99,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 25, radius: 250, terrain: 'crater',
    desc: 'Standard HE shell. Reliable, unlimited.' },
  { id: 'mortar',   name: 'Heavy Mortar',  color: '#ffb02e', ammo: 2,
    shots: 1, spread: 0,  speedMul: 0.9, damage: 46, radius: 430, terrain: 'crater',
    desc: 'Massive HE round. Cracks open the landscape.' },
  { id: 'volley',   name: 'Rocket Volley', color: '#7c6cff', ammo: 3,
    shots: 6, spread: 22, speedMul: 1.05, damage: 9, radius: 150, terrain: 'crater',
    desc: 'Six rockets in a fan. Saturates a whole slope.' },
  { id: 'railgun',  name: 'Railgun',       color: '#3ce88f', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.7, damage: 62, radius: 120, terrain: 'crater',
    pierce: true,   // punches straight through terrain until it strikes the ENEMY tank
    desc: 'Hypervelocity slug — punches through hills to the enemy.' },
  { id: 'cluster',  name: 'Cluster Bomb',  color: '#ffd23f', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    split: { count: 5, spreadSpeed: 700, radius: 190, damage: 14, terrain: 'crater' },
    desc: 'Bursts at the apex into five bomblets.' },
  { id: 'napalm',   name: 'Napalm',        color: '#ff6a3d', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    split: { count: 8, spreadSpeed: 1150, radius: 210, damage: 7, terrain: 'crater',
             hazard: { type: 'fire', turns: 2, dpt: 5, dps: 5, r: 430 } },
    desc: 'Splashes burning fuel over a wide area — the ground keeps burning.' },
  { id: 'gas',      name: 'Toxic Gas',     color: '#9dde4b', ammo: 2,
    shots: 1, spread: 0,  speedMul: 0.95, damage: 5, radius: 220, terrain: 'none',
    hazard: { type: 'gas', turns: 2, dpt: 7, dps: 4, r: 500 },
    desc: 'No blast — a lingering cloud that poisons over time.' },
  { id: 'airstrike', name: 'Air Strike',   color: '#54c8ff', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.1, damage: 0, radius: 0, terrain: 'none',
    airstrike: { bombs: 5, spacing: 280, damage: 15, radius: 210 },
    desc: 'Fire a beacon — bombers flatten wherever it lands.' },
  { id: 'buster',   name: 'Bunker Buster', color: '#c98a4b', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.1, damage: 30, radius: 340, terrain: 'crater',
    dig: 0.85,
    desc: 'Burrows before detonating — digs a brutal pit.' },
  { id: 'wall',     name: 'Earthworks',    color: '#8a5a2b', ammo: 3,
    shots: 1, spread: 0,  speedMul: 0.9, damage: 0,  radius: 0, terrain: 'wall',
    wall: { h: 2000, w: 340 },
    desc: 'Heaps up a huge mound of dirt. Deals no damage.' },
  { id: 'nuke',     name: 'Tactical Nuke', color: '#b6ff5a', ammo: 1,
    shots: 1, spread: 0,  speedMul: 0.9, damage: 75, radius: 650, terrain: 'crater',
    hazard: { type: 'gas', turns: 2, dpt: 6, dps: 5, r: 800 },
    desc: 'One warhead. Leaves fallout that keeps hurting.' },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));

// Public weapon info for the client UI (no physics numbers needed there).
export function weaponMenu() {
  return WEAPONS.map(w => ({ id: w.id, name: w.name, color: w.color, ammo: w.ammo, desc: w.desc }));
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
// Colossal alpine maps: rolling octaves + a craggy ridged octave, towering
// Gaussian peaks (some sharp, some broad), and 2..5 true CLIFFS (sigmoid
// elevation steps). Flattened pockets under each tank. Peak height is capped
// so a high-power lob always clears them (verified against SPEED_PER_POWER).
export function generateTerrain(seed) {
  const rng = mulberry32(seed);
  const base = WORLD_H * 0.72;   // surface baseline; peaks rise into the sky above, valleys drop below
  const terrain = new Array(WORLD_W + 1);
  const rough = 0.6 + rng() * 0.85;  // per-map ruggedness → varied terrain (capped so big rolls don't clip peaks)

  // BIG rolling relief — broad, deep valleys and rises (retuned for the 24k map).
  const layers = [
    { a: (400 + rng() * 460) * rough, f: 0.00020 + rng() * 0.00016, p: rng() * 6.2832 }, // huge broad valleys
    { a: (240 + rng() * 300) * rough, f: 0.00060 + rng() * 0.00045, p: rng() * 6.2832 }, // medium valleys
    { a: (110 + rng() * 150) * rough, f: 0.00160 + rng() * 0.00120, p: rng() * 6.2832 }, // hills
    { a: (50  + rng() * 78)  * rough, f: 0.00440 + rng() * 0.00320, p: rng() * 6.2832 }, // detail
  ];
  // Craggy ridged octave — sharp crests / canyon edges, like real eroded rock.
  const ridge = { a: (170 + rng() * 220) * rough, f: 0.0011 + rng() * 0.0009, p: rng() * 6.2832 };

  const peakCount = 4 + Math.floor(rng() * 4);     // 4..7 BIG distinct massifs (space between = valleys/canyons)
  const peaks = [];
  for (let i = 0; i < peakCount; i++) {
    peaks.push({
      cx: WORLD_W * (0.20 + rng() * 0.60),         // central band, well clear of both tanks
      h: 3800 + rng() * 2100,                      // 3800..5900 tall — big peaks
      w: WORLD_W * (0.050 + rng() * 0.100),        // BROAD alpine massifs (1200..3600 wide)
      sharp: rng() < 0.4,                          // some peaks are jagged spires
    });
  }

  const cliffCount = 3 + Math.floor(rng() * 4);    // 3..6 canyon walls (deep elevation steps)
  const cliffs = [];
  for (let i = 0; i < cliffCount; i++) {
    cliffs.push({
      cx: WORLD_W * (0.16 + rng() * 0.68),
      drop: (1100 + rng() * 1700) * (rng() < 0.5 ? 1 : -1),  // 1100..2800 deep canyon steps
      w: 70 + rng() * 130,                         // steepness of the step (steeper = more canyon-like)
    });
  }

  for (let x = 0; x <= WORLD_W; x++) {
    let y = base;
    for (const L of layers) y += Math.sin(x * L.f + L.p) * L.a;
    y -= Math.pow(1 - Math.abs(Math.sin(x * ridge.f + ridge.p)), 3) * ridge.a;
    // Peaks take the TALLEST nearby peak (max), not the sum — otherwise
    // overlapping wide peaks stack and slam into the ceiling as flat mesas.
    let lift = 0;
    for (const pk of peaks) {
      const d = Math.abs(x - pk.cx) / pk.w;
      lift = Math.max(lift, pk.h * (pk.sharp ? Math.exp(-Math.pow(d, 1.35)) : Math.exp(-d * d)));
    }
    y -= lift;
    for (const cl of cliffs) {
      y += cl.drop / (1 + Math.exp(-(x - cl.cx) / cl.w)) - cl.drop / 2;
    }
    terrain[x] = clampY(y);
  }

  flattenZone(terrain, 900, 700);
  flattenZone(terrain, WORLD_W - 900, 700);
  smooth(terrain, 1);
  return terrain;
}

// Scatter trees across the slopes — well spaced (min gap), not near the
// tanks, not on sheer walls. Sent to clients once; a tree whose ground gets
// blasted away dies.
export function generateTrees(terrain, seed) {
  const rng = mulberry32((seed ^ 0x5eed) >>> 0);
  const trees = [];
  const tries = 11000;
  const MIN_GAP = 85;                                             // world units between trees
  for (let i = 0; i < tries && trees.length < 240; i++) {
    const x = Math.round(600 + rng() * (WORLD_W - 1200));
    if (Math.abs(x - 900) < 1400 || Math.abs(x - (WORLD_W - 900)) < 1400) continue; // keep tank pockets clear
    const slope = Math.abs(surfaceAt(terrain, x + 25) - surfaceAt(terrain, x - 25));
    if (slope > 85) continue;                                     // too steep for trees
    if (trees.some(t => Math.abs(t.x - x) < MIN_GAP)) continue;   // keep them spaced out
    trees.push({ x, y0: Math.round(surfaceAt(terrain, x)), s: 0.7 + rng() * 0.5 });
  }
  trees.sort((a, b) => a.x - b.x);
  return trees;
}

function clampY(y) { return Math.max(TERRAIN_TOP, Math.min(TERRAIN_FLOOR, y)); }

function flattenZone(terrain, cx, half) {
  const x0 = Math.max(0, Math.round(cx - half)), x1 = Math.min(WORLD_W, Math.round(cx + half));
  let sum = 0, cnt = 0;
  for (let x = Math.round(cx) - 40; x <= Math.round(cx) + 40; x++) {
    if (x >= 0 && x <= WORLD_W) { sum += terrain[x]; cnt++; }
  }
  const level = sum / cnt;
  for (let x = x0; x <= x1; x++) {
    const w = Math.max(0, 1 - Math.abs(x - cx) / half); // 1 at center → 0 at edge
    terrain[x] = terrain[x] * (1 - w) + level * w;
  }
}

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
  0: [200, WORLD_W * 0.5 - 800],
  1: [WORLD_W * 0.5 + 800, WORLD_W - 200],
};

export function spawnTanks(terrain) {
  const x0 = 900, x1 = WORLD_W - 900;
  return [
    { x: x0, y: surfaceAt(terrain, x0) },
    { x: x1, y: surfaceAt(terrain, x1) },
  ];
}

function settle(terrain, tanks) {
  for (const t of tanks) t.y = surfaceAt(terrain, t.x);
}

// Deform terrain. 'crater' removes ground, 'dirt' mounds it, 'wall' raises a
// tall Gaussian rampart (Earthworks).
function deform(terrain, cx, cy, r, mode, wall) {
  if (mode === 'wall' && wall) {
    const span = Math.ceil(wall.w * 3);
    const x0 = Math.max(0, Math.floor(cx - span)), x1 = Math.min(WORLD_W, Math.ceil(cx + span));
    for (let x = x0; x <= x1; x++) {
      const d = (x - cx) / wall.w;
      const target = cy - wall.h * Math.exp(-d * d);
      terrain[x] = clampY(Math.min(terrain[x], target));
    }
    return;
  }
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

// ---- Lingering hazards (fire / toxic gas) -----------------------------------
// Ticked once after every shot: any tank inside a hazard takes its per-turn
// damage; the hazard's owner scores those points when the victim is the enemy.
export function tickHazards(hazards, tanks) {
  const dmgTaken = [0, 0];
  const points = [0, 0];
  for (const h of hazards) {
    for (let ti = 0; ti < 2; ti++) {
      if (distToTank(h.x, h.y, tanks[ti]) <= h.r) {
        dmgTaken[ti] += h.dpt;
        if (h.owner !== ti) points[h.owner] += h.dpt;
      }
    }
    h.turnsLeft--;
  }
  return { dmgTaken, points, alive: hazards.filter(h => h.turnsLeft > 0) };
}

// Real-time damage-over-time: one tick of the 5-second burn. Every fire/gas
// hazard damages any tank standing inside it by its per-second `dps`.
export function burnTick(hazards, tanks) {
  const dmg = [0, 0];
  for (const h of hazards) {
    if (!h.dps) continue;
    for (let ti = 0; ti < 2; ti++) {
      if (distToTank(h.x, h.y, tanks[ti]) <= h.r) dmg[ti] += h.dps;
    }
  }
  return dmg;
}

// ---- Shot simulation -------------------------------------------------------
// state: { terrain, tanks }. shot: { by, weapon, angle (0..180), power (0..100) }
// Returns a fully resolved shot the clients replay verbatim, plus any new
// lingering hazards this shot created. Each projectile carries an optional
// `delay` (playback points to wait) so bomblets/bombs animate in sequence.
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
  const newHazards = [];

  // rDmg = damage radius. Craters + blast visuals use rDmg * CRATER_MUL.
  const boom = (x, y, rDmg, kind, dmg, opts = {}) => {
    if (kind === 'wall') deform(state.terrain, x, y, 0, 'wall', opts.wall);
    else if (kind !== 'none') {
      const cy = y + (opts.dig ? rDmg * CRATER_MUL * opts.dig : 0);   // bunker buster digs deep
      deform(state.terrain, x, cy, rDmg * CRATER_MUL, kind);
    }
    if (dmg > 0) for (let ti = 0; ti < 2; ti++) damageDealt[ti] += blastDamage(x, y, rDmg, dmg, state.tanks[ti]);
    if (opts.hazard) {
      newHazards.push({ type: opts.hazard.type, x: round1(x), y: round1(y), r: opts.hazard.r, turnsLeft: opts.hazard.turns, dpt: opts.hazard.dpt, dps: opts.hazard.dps || 0 });
    }
  };
  const det = (x, y, rDmg, kind, hazardType) => ({
    x: round1(x), y: round1(y),
    r: (kind === 'none' || kind === 'wall') ? Math.max(20, rDmg) : Math.round(rDmg * CRATER_MUL),
    kind, color: w.color, hz: hazardType || null,
  });

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
        projectiles.push({ path: fp.path, det: det(fp.x, fp.y, 20, 'none'), delay: 0 }); // burst puff
        const parentLen = fp.path.length;
        const s = w.split;
        for (let k = 0; k < s.count; k++) {
          const frac = s.count === 1 ? 0.5 : k / (s.count - 1);
          const cvx = fp.vx * 0.45 + (frac * 2 - 1) * s.spreadSpeed;
          const cf = integrate(state.terrain, state.tanks, fp.x, fp.y, cvx, -40, {});
          let cdet = null;
          if (cf.hit) {
            cdet = det(cf.x, cf.y, s.radius, s.terrain, s.hazard ? s.hazard.type : null);
            boom(cf.x, cf.y, s.radius, s.terrain, s.damage, { hazard: s.hazard });
          }
          projectiles.push({ path: cf.path, det: cdet, delay: parentLen });
        }
      } else {
        let d = null;
        if (fp.hit) {
          d = det(fp.x, fp.y, w.split.radius, w.split.terrain, w.split.hazard ? w.split.hazard.type : null);
          boom(fp.x, fp.y, w.split.radius, w.split.terrain, w.split.damage, { hazard: w.split.hazard });
        }
        projectiles.push({ path: fp.path, det: d, delay: 0 });
      }
    } else if (w.airstrike) {
      // The shell is a target beacon. Where it lands, a stick of bombs sweeps in.
      const fp = integrate(state.terrain, state.tanks, ox, oy, vx, vy, {});
      const beaconDet = fp.hit ? det(fp.x, fp.y, 24, 'none') : null;
      projectiles.push({ path: fp.path, det: beaconDet, delay: 0, beacon: true });
      if (fp.hit) {
        const a = w.airstrike;
        const parentLen = fp.path.length;
        for (let k = 0; k < a.bombs; k++) {
          const bx = fp.x + (k - (a.bombs - 1) / 2) * a.spacing;
          let sx = bx - dir * 2400;
          sx = Math.max(50, Math.min(WORLD_W - 50, sx));
          const bf = integrate(state.terrain, state.tanks, sx, -400, dir * 650, 120, {});
          let bdet = null;
          if (bf.hit) { bdet = det(bf.x, bf.y, a.radius, 'crater'); boom(bf.x, bf.y, a.radius, 'crater', a.damage); }
          projectiles.push({ path: bf.path, det: bdet, delay: parentLen + 14 + k * 10 });
        }
      }
    } else {
      const fp = integrate(state.terrain, state.tanks, ox, oy, vx, vy, w.pierce ? { pierce: true, pierceBy: by } : {});
      let d = null;
      if (fp.hit) {
        d = det(fp.x, fp.y, w.wall ? 0 : w.radius, w.terrain, w.hazard ? w.hazard.type : null);
        boom(fp.x, fp.y, w.radius, w.terrain, w.damage, { hazard: w.hazard, dig: w.dig, wall: w.wall });
      }
      projectiles.push({ path: fp.path, det: d, delay: 0 });
    }
  }

  settle(state.terrain, state.tanks);
  const opp = 1 - by;
  return {
    projectiles,
    newHazards,
    tanks: state.tanks.map(t => ({ x: round1(t.x), y: round1(t.y) })),
    scoreDelta: Math.round(damageDealt[opp]),
    damage: damageDealt.map(d => Math.round(d)),
    weapon: w.id, by,
  };
}

// ── AI opponent ────────────────────────────────────────────────────────────
// Server-side bot brain. Given the terrain + both tanks, it searches cannon
// firing solutions with a READ-ONLY trajectory integrator (no terrain cloning,
// so it's cheap enough to run inline on a turn) and returns { weapon, angle,
// power }. `difficulty` scales the random aim error added to the best solution:
// easy = wild, medium = loose, hard = crisp.
export function aiShot(terrain, tanks, by, difficulty) {
  const dir = by === 0 ? 1 : -1;
  const me = tanks[by];
  const enemy = tanks[1 - by];
  const speedMul = WEAPON_BY_ID.cannon.speedMul;   // cannon = 1.0, unlimited ammo

  // Fly one cannon shell read-only; return |landing.x − enemy.x| (0 = direct hit).
  function miss(angle, power) {
    const rad = (angle * Math.PI) / 180;
    const speed = Math.max(1, Math.min(100, power)) * SPEED_PER_POWER * speedMul;
    const ox = me.x + Math.cos(rad) * dir * BARREL_LEN;
    const oy = (me.y - TANK_CY) - Math.sin(rad) * BARREL_LEN;
    let x = ox, y = oy, vx = Math.cos(rad) * speed * dir, vy = -Math.sin(rad) * speed, t = 0;
    while (t < MAX_T) {
      vy += GRAVITY * DT; x += vx * DT; y += vy * DT; t += DT;
      if (x < 0 || x > WORLD_W) return Math.abs(x - enemy.x) + 1e5;          // flew off the map
      const armed = Math.hypot(x - ox, y - oy) > ARM_DIST;
      if (armed && pointHitsTank(x, y, enemy)) return 0;                     // direct hit
      if (armed && pointHitsTank(x, y, me)) return Math.abs(x - me.x) + 1e5; // would clip itself
      if (y >= surfaceAt(terrain, x)) return Math.abs(x - enemy.x);         // hit ground
    }
    return Math.abs(x - enemy.x) + 1e5;
  }

  // Coarse sweep for the best neighbourhood, then refine around it.
  let best = { angle: 45, power: 60, m: Infinity };
  for (let a = 18; a <= 86; a += 3) {
    for (let p = 28; p <= 100; p += 3) {
      const m = miss(a, p);
      if (m < best.m) best = { angle: a, power: p, m };
    }
  }
  for (let a = best.angle - 3; a <= best.angle + 3; a += 0.75) {
    for (let p = best.power - 3; p <= best.power + 3; p += 0.75) {
      if (a < 6 || a > 88 || p < 10 || p > 100) continue;
      const m = miss(a, p);
      if (m < best.m) best = { angle: a, power: p, m };
    }
  }

  // Difficulty → aim jitter. Bell-ish noise from two uniforms in [-1,1].
  const errByDiff = { easy: 11, medium: 4.5, hard: 1.2 };
  const e = errByDiff[difficulty] || errByDiff.medium;
  const noise = () => Math.random() + Math.random() - 1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const angle = clamp(best.angle + noise() * e, 8, 88);
  const power = clamp(best.power + noise() * e * 1.4, 12, 100);
  return { weapon: 'cannon', angle: round1(angle), power: round1(power) };
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

    if (x < 0 || x > WORLD_W || y > WORLD_H) { path.push([round1(x), round1(y)]); return { path, hit: false, x, y, vx, vy }; }
    const armed = Math.hypot(x - ox, y - oy) > ARM_DIST;
    if (opts.pierce) {
      // Railgun: ignore terrain and the firer entirely — punch straight through
      // everything until the slug strikes the ENEMY tank. Sub-sample the step so
      // the hypervelocity slug can't tunnel through the thin hitbox between steps.
      const enemy = tanks[1 - opts.pierceBy];
      if (armed && enemy) {
        const px = x - vx * DT, py = y - vy * DT;
        const n = Math.max(2, Math.ceil(Math.hypot(x - px, y - py) / 8));
        for (let s = 1; s <= n; s++) {
          const f = s / n, ix = px + (x - px) * f, iy = py + (y - py) * f;
          if (pointHitsTank(ix, iy, enemy)) {
            path.push([round1(ix), round1(iy)]); return { path, hit: true, x: ix, y: iy, vx, vy };
          }
        }
      }
    } else {
      const gy = surfaceAt(terrain, x);
      if (y >= gy) { path.push([round1(x), round1(gy)]); return { path, hit: true, x, y: gy, vx, vy }; }
      // Direct tank hit — tested against the tank OUTLINE (hull + turret boxes),
      // after the shell has armed away from the muzzle.
      if (armed) {
        for (const tk of tanks) {
          if (pointHitsTank(x, y, tk)) {
            path.push([round1(x), round1(y)]); return { path, hit: true, x, y, vx, vy };
          }
        }
      }
    }
    if (++step % SAMPLE_EVERY === 0) path.push([round1(x), round1(y)]);
  }
  path.push([round1(x), round1(y)]);
  return { path, hit: false, x, y, vx, vy };
}

// Splash damage falls off with distance from the blast center to the NEAREST
// POINT of the tank outline (not its center), so the hitbox matches the hull.
function blastDamage(cx, cy, r, dmg, tank) {
  const d = distToTank(cx, cy, tank);
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
