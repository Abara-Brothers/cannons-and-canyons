// game-core.js — authoritative game logic for Canyons & Cannons.
// Runs on the server only. Deterministic given the same inputs so both
// clients, which merely replay the server's resolved shot, stay in sync.

export const WORLD_W = 48000; // battlefield DOUBLED (2026-07-23, Jordan: 'gameplay needs to feel much larger') — the camera fits all tanks, not the whole map
export const WORLD_H = 13500; // tall world → room for huge peaks and deep canyons (no ceiling clipping)

const GRAVITY = 900;          // world units / s^2  (no wind, per spec)
const SPEED_PER_POWER = 52;   // power 0..100 -> speed 0..5200 u/s. Max 45° range = 5200^2/900 ≈ 30,044 —
                              // ~0.63× the 48,000-wide map: you can NO LONGER snipe border to
                              // border; pickSpawns caps a duel gap at 26,000 so opponents always
                              // start in reach. Trimmed twice (64 → 58 → 52) because shots flew
                              // too far. GOLF DOES NOT share this: the ball's speedMul compensates.
// Where the shell leaves the tank. These mirror the CLIENT's drawTank barrel
// geometry (BARREL {ox:0.47, oy:-0.72, len:1.45, brake:0.26} in tank radii, plus
// the 0.42r LIFT) at the design scale TANK_R=240 — so the projectile path now
// begins at the DRAWN muzzle tip, not the hull centre. Multiplied by tank.scale
// so an oversized tank's gun reaches proportionally further.
const BARREL_LEN = 410;       // pivot -> muzzle tip (1.71 r)
const BARREL_PIVOT_X = 113;   // pivot sits forward of the hull centre (0.47 r)
const DT = 1 / 120;           // physics step
const SAMPLE_EVERY = 4;       // record a trajectory point every N steps (~30fps)
const MAX_T = 26;             // safety cap on flight time (s)
const ARM_DIST = 100;         // projectile ignores tank collisions until it has flown this far
const TERRAIN_TOP = 140;      // highest a peak/mound may rise (min y) — headroom for tall peaks
// Earthworks-only ceiling. Natural terrain never gets near TERRAIN_TOP (the
// tallest generated peak lands around y≈2900), but a player CAN ladder into it
// by firing Earthworks at their own feet: the rampart is centred on the impact
// point and settle() re-seats the tank on the new crest. Capping wall crests
// here keeps a laddered tank's turret (TANK_TOP above its ground point) inside
// the world, where cameraTarget() can still frame it.
const WALL_TOP = 1200;
// ---- Fire (real-time hazard) ------------------------------------------------
// Fire is NOT turn-based: it lives FIRE_MS from the instant it is lit and bites
// FIRE_BITES times, FIRE_DMG each. game-core stays clock-free — the server
// stamps the wall-clock deadline when it takes ownership of the hazard.
export const FIRE_MS    = 6000;   // 6 seconds of burning
export const FIRE_TICK  = 2000;   // one bite every 2 seconds
export const FIRE_DMG   = 8;      // 8 damage per bite  → 3 bites, 24 total
export const FIRE_BITES = Math.round(FIRE_MS / FIRE_TICK);   // 3
// A thin INDESTRUCTIBLE lava layer floors the map: terrain can never be dug below
// LAVA_Y, and any tank that ends up sitting in it burns.
export const LAVA_Y = WORLD_H - 300;   // top surface of the lava
export const LAVA_DPS = 9;             // damage per second while a tank touches it
const TERRAIN_FLOOR = LAVA_Y;          // craters bottom out ON the lava, never through it
const CRATER_MUL = 0.8;       // crater/blast visual size; the DAMAGE radius now covers the whole explosion
const SCORCH_MUL = 0.8;       // scorch half-width vs damage radius — same footprint the crater used to have
export const SCORCH_MAX = 40; // hard cap on stored scorch ranges (bounds the wire payload)

// ---- Biomes -----------------------------------------------------------------
// One generator, per-biome constants. `gen` scales the alpine formulas (alpine is
// all 1s so its RNG sequence and output are byte-identical to before); `crater`
// reshapes blast holes (desert digs huge soft bowls, ice shears wide shallow
// sheets); `lavaRaise` lifts the lava floor (volcanic); `ruins` scatters
// indestructible concrete decks that blasts cannot dig through.
export const BIOMES = {
  alpine:   { crater: { wMul: 1.0,  sheet: false }, lavaRaise: 0,
              gen: { base: 0.72, roughMul: 1.0, layerMul: 1.0, ridgeMul: 1.0,
                     pc0: 4, pcR: 4, ph0: 2600, phR: 1500, pwMul: 1.0, sharpP: 0.4,
                     cc0: 3, ccR: 4, dropMul: 1.0 } },
  desert:   { crater: { wMul: 1.45, sheet: false }, lavaRaise: 0,
              gen: { base: 0.74, roughMul: 0.8, layerMul: 1.5, ridgeMul: 0.15,
                     pc0: 2, pcR: 2, ph0: 1300, phR: 900,  pwMul: 1.8, sharpP: 0.0,
                     cc0: 0, ccR: 2, dropMul: 0.5 } },
  ice:      { crater: { wMul: 1.55, sheet: true },  lavaRaise: 0,
              gen: { base: 0.70, roughMul: 0.9, layerMul: 1.1, ridgeMul: 0.5,
                     pc0: 3, pcR: 3, ph0: 2200, phR: 1300, pwMul: 1.2, sharpP: 0.25,
                     cc0: 2, ccR: 3, dropMul: 1.4 } },
  volcanic: { crater: { wMul: 1.0,  sheet: false }, lavaRaise: 2300,
              gen: { base: 0.60, roughMul: 1.15, layerMul: 1.0, ridgeMul: 1.3,
                     pc0: 4, pcR: 4, ph0: 2400, phR: 1600, pwMul: 0.9, sharpP: 0.7,
                     cc0: 4, ccR: 4, dropMul: 1.2 } },
  // The guarded concrete slabs ('indestructible pillars') are RETIRED — Jordan
  // 2026-07-23. The biome keeps its overcast palette; it gets normal bunkers now.
  ruins:    { crater: { wMul: 1.0,  sheet: false }, lavaRaise: 0,
              gen: { base: 0.72, roughMul: 0.7, layerMul: 0.9, ridgeMul: 0.4,
                     pc0: 2, pcR: 3, ph0: 1800, phR: 1100, pwMul: 1.1, sharpP: 0.2,
                     cc0: 1, ccR: 3, dropMul: 0.8 } },
};
export const BIOME_IDS = Object.keys(BIOMES);
export const biomeLavaY = (biome) => LAVA_Y - ((BIOMES[biome] || BIOMES.alpine).lavaRaise || 0);

// ---- Tank hitbox (world units) ---------------------------------------------
// The hitbox is the tank's OUTLINE: a hull/track box topped by a narrower
// turret box, anchored at the tank's ground point (tank.x, tank.y).
// SINGLE SOURCE OF TRUTH for how big a tank is in the world. Derived from the
// client's drawTank() geometry so the hitbox IS the tank you see. drawTank works
// in multiples of `r` screen px; at the game's design zoom band (cam.zoom
// 0.033..0.075) r == TANK_R world units. Body extents in multiples of r, after
// drawTank's LIFT of 0.42r:
//   tracks ±1.33 (up -0.10..0.48) | skirt ±1.26 (..0.60) | hull wedge ±1.35
//   at 0.60 tapering to ±0.99 at 1.00 | turret ±0.76 at 1.00 tapering to
//   ±0.52 at 1.36 | commander hatch ±0.34 up to 1.49
// The tank art is LOCKED. If drawTank's proportions ever change, retune these
// multipliers to match it — never the other way round.
export const TANK_R = 240;
export const TANK_HW  = Math.round(1.35 * TANK_R);   // 324 — widest point: the hull's bottom edge
const TANK_HULL_H     = Math.round(1.00 * TANK_R);   // 240 — hull top above the ground point
const TANK_TUR_HW     = Math.round(0.76 * TANK_R);   // 182 — turret half-width at its base
export const TANK_TOP = Math.round(1.36 * TANK_R);   // 326 — turret roof above the ground point
const TANK_BELOW      = Math.round(0.10 * TANK_R);   //  24 — tracks sit this far below the ground point
const TANK_TRACK_TOP  = Math.round(0.48 * TANK_R);   // 115 — top of the track band
const TANK_TRACK_HW   = Math.round(1.33 * TANK_R);   // 319 — track half-width
const TANK_SKIRT_HW   = Math.round(1.26 * TANK_R);   // 302 — side-skirt half-width
const TANK_HULL_BOT   = Math.round(0.60 * TANK_R);   // 144 — hull wedge bottom edge (widest line)
const TANK_HULL_TOP_HW = Math.round(0.99 * TANK_R);  // 238 — hull half-width at the hull top
const TANK_TUR_TOP_HW = Math.round(0.52 * TANK_R);   // 125 — turret half-width at its roof
const TANK_HAT_HW     = Math.round(0.34 * TANK_R);   //  82 — commander hatch half-width
const TANK_HAT_TOP    = Math.round(1.49 * TANK_R);   // 358 — hatch top above the ground point
const TANK_CY = 274;          // turret pivot height above the ground point (0.72 r + 0.42 r LIFT)

// Silhouette half-width at height `up` above the ground point (world units,
// UNSCALED — callers divide by tank.scale first). -1 = outside vertically.
function tankHalfWidthAt(up) {
  if (up < -TANK_BELOW || up > TANK_HAT_TOP) return -1;
  if (up <= TANK_TRACK_TOP) return TANK_TRACK_HW;                       // tracks + wheels
  if (up < TANK_HULL_BOT) return TANK_SKIRT_HW;                         // side skirts
  if (up <= TANK_HULL_H)                                                // hull wedge taper
    return TANK_HW + (TANK_HULL_TOP_HW - TANK_HW) * (up - TANK_HULL_BOT) / (TANK_HULL_H - TANK_HULL_BOT);
  if (up <= TANK_TOP)                                                   // turret taper
    return TANK_TUR_HW + (TANK_TUR_TOP_HW - TANK_TUR_HW) * (up - TANK_HULL_H) / (TANK_TOP - TANK_HULL_H);
  return TANK_HAT_HW;                                                   // commander hatch cap
}

// tank.scale (default 1) grows the whole outline — the boss mecha is 1.8x.
export function pointHitsTank(x, y, tank) {
  const sc = tank.scale || 1;
  const hw = tankHalfWidthAt((tank.y - y) / sc);   // height above the ground point
  return hw >= 0 && Math.abs(x - tank.x) <= hw * sc;
}

// Distance from a point to the nearest point of the tank outline: clamp the
// height into the silhouette band and the x onto the width at that height.
// The flat segment boundaries are probed too so the convex corners (hull
// bottom edge, hull/turret step, turret/hatch step) are measured exactly.
function distToTank(cx, cy, tank) {
  const sc = tank.scale || 1;
  const dx = Math.abs(cx - tank.x) / sc;
  const up = (tank.y - cy) / sc;
  let best = Infinity;
  const probe = (u) => {
    const hw = tankHalfWidthAt(u);
    if (hw >= 0) best = Math.min(best, Math.hypot(Math.max(0, dx - hw), up - u));
  };
  probe(Math.max(-TANK_BELOW, Math.min(up, TANK_HAT_TOP)));
  probe(TANK_TRACK_TOP); probe(TANK_HULL_BOT); probe(TANK_HULL_H); probe(TANK_TOP);
  return best * sc;
}

export const MOVE_BUDGET = 4500;  // driving distance allowed per turn — generous fuel to reposition
export const MOVE_STEP = 60;      // distance per move tick (fast drive)
export const MAX_HP = 150;        // tanks have health — destroy the enemy to win (no shot limit)
// Placement rules shared by driving (handleMove) and teleporting — one source of
// truth so the two can never drift apart. Tanks are NOT obstacles to each other:
// you may drive or warp clean past an opponent, and may even come to rest on top
// of one. The map edges are the entire rule.
export const EDGE_MARGIN = 200;             // closest a tank may ever sit to either map edge

// ---- Aim range -------------------------------------------------------------
// Degrees, RELATIVE to the tank's facing (dir mirrors x only, so the vertical
// meaning is identical for both seats). 0 = level toward the enemy, 90 = straight
// up, 180 = level backwards, 240 = 60° below backwards, -60 = 60° below forwards.
// [-60, 240] is 300° of travel; the excluded (240, 300) ≡ (-120, -60) is a 60°
// dead cone centred on straight down (270 ≡ -90), so the barrel can never point
// straight at the ground under itself.
export const AIM_MIN = -60;
export const AIM_MAX = 240;

// Fold any number onto [AIM_MIN, AIM_MAX]. Idempotent, NaN-safe, and it splits
// the dead cone at straight-down so each half snaps to the nearer limit.
export function clampAim(a) {
  a = Number(a);
  if (!Number.isFinite(a)) return 45;
  a = (((a + 180) % 360) + 360) % 360 - 180;   // → [-180, 180)
  if (a < AIM_MIN) a += 360;                   // → [-60, 300)
  if (a >= 270) return AIM_MIN;                // past straight-down → forward-down limit
  return Math.max(AIM_MIN, Math.min(AIM_MAX, a));
}

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
//   teleport       — no blast; the firing tank is moved onto the landing point
// `radius` is the DAMAGE radius; craters and blast visuals scale by CRATER_MUL.
export const WEAPONS = [
  { id: 'cannon',   name: 'Cannon',        color: '#ff5a52', ammo: 99,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 25, radius: 750, terrain: 'crater',
    desc: 'Standard HE shell. Reliable, unlimited.' },
  { id: 'mortar',   name: 'Heavy Mortar',  color: '#ffb02e', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 46, radius: 1300, terrain: 'crater',
    desc: 'Massive HE round. Cracks open the landscape.' },
  { id: 'volley',   name: 'Rocket Volley', color: '#7c6cff', ammo: 3,
    shots: 6, spread: 22, speedMul: 1.0, damage: 9, radius: 450, terrain: 'crater',
    desc: 'Six rockets in a fan. Saturates a whole slope.' },
  { id: 'railgun',  name: 'Railgun',       color: '#3ce88f', ammo: 0,
    shots: 1, spread: 0,  speedMul: 1.7, gravityMul: 0.35, damage: 62, radius: 390, terrain: 'crater',
    pierce: true, proximity: 120,   // flat & fast; punches through terrain and detonates on the ENEMY tank
    desc: 'Supply-drop exclusive. Flat hypervelocity slug that punches through hills.' },
  { id: 'cluster',  name: 'Cluster Bomb',  color: '#ffd23f', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    split: { count: 5, spreadSpeed: 450, radius: 570, damage: 14, terrain: 'crater' },
    desc: 'Bursts at the apex into five bomblets.' },
  { id: 'napalm',   name: 'Napalm',        color: '#ff6a3d', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    split: { count: 8, spreadSpeed: 760, radius: 630, damage: 7, terrain: 'scorch',
             hazard: { type: 'fire', ms: FIRE_MS, bites: FIRE_BITES, dmg: FIRE_DMG, r: 430 } },
    desc: 'Splashes burning fuel over a wide area — burns the ground black, never moves it.' },
  { id: 'gas',      name: 'Toxic Gas',     color: '#9dde4b', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 5, radius: 660, terrain: 'none',
    hazard: { type: 'gas', ms: 10000, bites: 5, dmg: 6, r: 900 },   // 6 every 2s for 10s, WIDE
    desc: 'No blast — a lingering cloud that poisons over time.' },
  { id: 'airstrike', name: 'Air Strike',   color: '#54c8ff', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    airstrike: { bombs: 5, spacing: 280, damage: 15, radius: 630 },
    desc: 'Fire a beacon — bombers flatten wherever it lands.' },
  { id: 'buster',   name: 'Bunker Buster', color: '#c98a4b', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 30, radius: 1000, terrain: 'crater',
    dig: 0.85,
    desc: 'Burrows before detonating — digs a brutal pit.' },
  { id: 'wall',     name: 'Earthworks',    color: '#8a5a2b', ammo: 3,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0,  radius: 0, terrain: 'wall',
    wall: { h: 2600, w: 560 },
    desc: 'Heaps up a huge mound of dirt. Deals no damage.' },
  { id: 'teleport', name: 'Teleport',      color: '#c86bff', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0,  radius: 0, terrain: 'none',
    teleport: true,   // on impact the FIRING tank warps to the landing point
    desc: 'Warp to wherever the shell lands. No blast — pick your ground.' },
  { id: 'nuke',     name: 'Tactical Nuke', color: '#b6ff5a', ammo: 1,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 75, radius: 1950, terrain: 'crater',
    hazard: { type: 'gas', ms: 8000, bites: 4, dmg: 5, r: 1000 },
    desc: 'One warhead. Leaves fallout that keeps hurting.' },
  { id: 'nano',     name: 'Nano Swarm',    color: '#6be7ff', ammo: 2,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 4, radius: 260, terrain: 'none',
    nano: { bots: 10, dmg: 3, r: 1000 },   // seek radius — bots crawl to their prey
    desc: 'A dart that releases 10 seeker bots — they hunt the nearest enemy, latch on and detonate for 3 damage each.' },
  { id: 'minigun',  name: 'Minigun',       color: '#aeb9c9', ammo: 2,
    shots: 14, spread: 7, speedMul: 1.0, damage: 3, radius: 170, terrain: 'crater', burst: true,
    desc: 'Fourteen rounds in one long ripping burst. Death by a thousand cuts.' },
  // ---- WARLORD-7 kit (bossOnly: never in a player's menu or loadout) ---------
  { id: 'b_gatling',   name: 'Shredder Storm',  color: '#ffb84d', ammo: 99, bossOnly: true,
    shots: 10, spread: 9,  speedMul: 1.15, damage: 4, radius: 240, terrain: 'crater', burst: true,
    desc: 'Both arm cannons spin up and hose the slope with tracer.' },
  { id: 'b_hellstorm', name: 'Hellstorm Rack',  color: '#ff9d3d', ammo: 99, bossOnly: true,
    shots: 8, spread: 26, speedMul: 1.0, damage: 8, radius: 500, terrain: 'crater', burst: true,
    desc: 'The back rack empties — finned rockets rain in a rolling chain.' },
  { id: 'b_magma',     name: 'Magma Spew',      color: '#ff6a3d', ammo: 99, bossOnly: true,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    split: { count: 5, spreadSpeed: 620, radius: 540, damage: 7, terrain: 'scorch',
             hazard: { type: 'fire', ms: FIRE_MS, bites: FIRE_BITES, dmg: FIRE_DMG, r: 430 } },
    desc: 'Hawks up gobs of reactor slag that burn where they splatter.' },
  { id: 'b_spear',     name: 'Phase Spear',     color: '#8affde', ammo: 99, bossOnly: true,
    shots: 1, spread: 0,  speedMul: 1.8, gravityMul: 0.25, damage: 36, radius: 380, terrain: 'crater',
    pierce: true, proximity: 140, drill: true,
    desc: 'A charged spear that burns a channel through everything it crosses.' },
  { id: 'b_quake',     name: 'Seismic Slam',    color: '#c98a4b', ammo: 99, bossOnly: true,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 26, radius: 1400, terrain: 'crater', dig: 0.5,
    desc: 'A piledriver round that cracks the earth open.' },
  // ---- Horde kits (aiOnly: alien saucers / zombie hulks only) ----------------
  { id: 'a_plasma', name: 'Plasma Bolt',    color: '#7dff6a', ammo: 99, aiOnly: true,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 14, radius: 620, terrain: 'crater',
    desc: 'Superheated xeno-plasma. Splashes green.' },
  { id: 'a_pods',   name: 'Spore Pods',     color: '#b06bff', ammo: 99, aiOnly: true,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    split: { count: 4, spreadSpeed: 550, radius: 430, damage: 6, terrain: 'crater' },
    desc: 'A pod that bursts into four falling spores.' },
  { id: 'a_lance',  name: 'Phase Lance',    color: '#ff6bf0', ammo: 99, aiOnly: true,
    shots: 1, spread: 0,  speedMul: 1.6, gravityMul: 0.3, damage: 18, radius: 300, terrain: 'crater',
    pierce: true, proximity: 130, drill: true,
    desc: 'A beam that scours a burning trench through the land.' },
  { id: 'z_spit',   name: 'Bile Spit',      color: '#9dde4b', ammo: 99, aiOnly: true,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 12, radius: 560, terrain: 'none',
    hazard: { type: 'gas', ms: 6000, bites: 3, dmg: 4, r: 520 },
    desc: 'A gob of something best not examined.' },
  { id: 'z_grubs',  name: 'Grave Grubs',    color: '#c4b36a', ammo: 99, aiOnly: true,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 0, radius: 0, terrain: 'none',
    split: { count: 5, spreadSpeed: 500, radius: 380, damage: 5, terrain: 'crater' },
    desc: 'A sack of biting things that scatters on impact.' },
  { id: 'z_lob',    name: 'Corpse Lob',     color: '#7a8a4a', ammo: 99, aiOnly: true,
    shots: 1, spread: 0,  speedMul: 1.0, damage: 18, radius: 820, terrain: 'crater',
    desc: 'They throw... something heavy. Do not ask.' },
  // ---- Artillery Golf (golfOnly: the mode's single weapon) -------------------
  // Golf clubs. Each carries bounce physics: rest = restitution, fric = impact
  // friction, rr = ROLLING-RESISTANCE coefficient (the real-physics roll: the
  // ball keeps rolling, downhill re-accelerates it, and it only rests where
  // friction beats the slope). No caps, no timers — see integrate()'s roll mode.
  { id: 'golfball',  name: 'Iron',            color: '#f4f6f2', ammo: 99, golfOnly: true,
    // speedMul rides the combat power trims in the OPPOSITE direction so golf
    // ballistics never move: 52 × 1.0038 ≈ the original 58 × 0.9 launch speed.
    shots: 1, spread: 0,  speedMul: 1.0038, damage: 0, radius: 0, terrain: 'none',
    bounce: { rest: 0.45, fric: 0.72, rr: 0.25 },    // bites on the pitch mark, rolls a touch longer
    desc: 'The honest mid-game club. Flies true, bites on landing.' },
  { id: 'driver',    name: 'Driver',          color: '#ffd23f', ammo: 99, golfOnly: true,
    shots: 1, spread: 0,  speedMul: 1.25, damage: 0, radius: 0, terrain: 'none',
    bounce: { rest: 0.50, fric: 0.80, rr: 0.135 },   // longest carry AND the longest roll-out
    desc: 'Off the tee: maximum carry, and it runs forever on the fairway.' },
  { id: 'putter',    name: 'Putter',          color: '#8affde', ammo: 99, golfOnly: true,
    shots: 1, spread: 0,  speedMul: 0.20, damage: 0, radius: 0, terrain: 'none',
    ground: true,                                     // struck along the turf — the ball NEVER lofts
    bounce: { rest: 0.2, fric: 0.9, rr: 0.10 },      // true roll: full power ≈ a 6,000u lag putt
    desc: 'No loft, no drama. Rolls exactly as far as you dare.' },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));

// Public weapon info for the client UI (no physics numbers needed there).
// One menu entry — includes the ballistic facts (speed/gravity multipliers,
// pierce, apex-burst) so the client's aim preview can trace the EXACT arc the
// server will integrate.
export function menuEntry(w) {
  return { id: w.id, name: w.name, color: w.color, ammo: w.ammo, desc: w.desc,
           speedMul: w.speedMul, gravityMul: w.gravityMul || 1,
           pierce: !!w.pierce, apex: !!w.split, radius: w.radius || 0,
           ground: !!w.ground };
}
export function weaponMenu() {
  return WEAPONS.filter(w => !w.bossOnly && !w.golfOnly && !w.aiOnly).map(menuEntry);
}

export function startingAmmo() {
  const a = {};
  for (const w of WEAPONS) if (!w.bossOnly && !w.golfOnly && !w.aiOnly) a[w.id] = w.ammo;
  return a;
}

// Combat-mode loadouts: each player drafts LOADOUT_SIZE weapons from this
// pool, 2 rounds each. STANDARD ISSUE regardless of picks: the Cannon
// (unlimited — every mode except golf) and the Tactical Nuke (one). The
// railgun stays supply-drop exclusive.
export const LOADOUT_SIZE = 5;
export const LOADOUT_POOL = WEAPONS
  .filter(w => !w.bossOnly && !w.golfOnly && !w.aiOnly && w.id !== 'nuke' && w.id !== 'railgun' && w.id !== 'cannon')
  .map(w => w.id);
// Duel / free-for-all / Boss Fight run on 5 picks; the survival modes hand out
// 7 (a longer fight against respawning waves needs the deeper bag). Golf gets
// none — the ball is the whole kit.
export function loadoutSizeFor(mode) {
  if (mode === 'golf') return 0;
  return (mode === 'aliens' || mode === 'zombies') ? 7 : 5;
}
export function validLoadout(picks, n = LOADOUT_SIZE) {
  return Array.isArray(picks) && picks.length === n &&
    new Set(picks).size === n && picks.every(id => LOADOUT_POOL.includes(id));
}
export function loadoutAmmo(picks) {
  const a = {};
  for (const w of WEAPONS) if (!w.bossOnly && !w.golfOnly && !w.aiOnly) a[w.id] = 0;
  for (const id of picks) a[id] = 2;
  a.cannon = 99;       // standard issue: the unlimited sidearm, every mode
  a.nuke = 1;          // everyone gets the big one
  a.railgun = 0;       // crate-exclusive, as always
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
export function generateTerrain(seed, n = 2, biome = 'alpine', width = WORLD_W, featMul = 1) {
  // featMul scales FEATURE COUNTS (massifs, canyon steps) with map area — the
  // 48k combat map passes 2 so it reads as more world, not the same world
  // stretched. Golf never passes it, so every hole generates exactly as before.
  const B = (BIOMES[biome] || BIOMES.alpine).gen;
  const floor = biomeLavaY(biome);
  const rng = mulberry32(seed);
  const base = WORLD_H * B.base; // surface baseline; peaks rise into the sky above, valleys drop below
  const terrain = new Array(width + 1);
  const rough = (0.7 + rng() * 0.45) * B.roughMul;  // per-map ruggedness

  // BIG rolling relief — broad, deep valleys and rises (retuned for the 24k map).
  const layers = [
    { a: (230 + rng() * 250) * rough * B.layerMul, f: 0.00020 + rng() * 0.00016, p: rng() * 6.2832 }, // huge broad valleys
    { a: (150 + rng() * 175) * rough * B.layerMul, f: 0.00060 + rng() * 0.00045, p: rng() * 6.2832 }, // medium valleys
    { a: (80  + rng() * 100) * rough, f: 0.00160 + rng() * 0.00120, p: rng() * 6.2832 }, // hills
    { a: (40  + rng() * 55)  * rough, f: 0.00440 + rng() * 0.00320, p: rng() * 6.2832 }, // detail
  ];
  // Craggy ridged octave — sharp crests / canyon edges, like real eroded rock.
  const ridge = { a: (110 + rng() * 140) * rough * B.ridgeMul, f: 0.0011 + rng() * 0.0009, p: rng() * 6.2832 };

  const peakCount = Math.round((B.pc0 + Math.floor(rng() * B.pcR)) * featMul);   // distinct massifs (space between = valleys/canyons)
  const peaks = [];
  for (let i = 0; i < peakCount; i++) {
    peaks.push({
      cx: width * (0.20 + rng() * 0.60),           // central band, well clear of both tanks
      h: B.ph0 + rng() * B.phR,                    // biome-scaled massif height
      w: width * (0.050 + rng() * 0.100) * B.pwMul,
      sharp: rng() < B.sharpP,                     // some peaks are jagged spires
    });
  }

  const cliffCount = Math.round((B.cc0 + Math.floor(rng() * Math.max(1, B.ccR))) * featMul);   // canyon walls (deep elevation steps)
  const cliffs = [];
  for (let i = 0; i < cliffCount; i++) {
    cliffs.push({
      cx: width * (0.16 + rng() * 0.68),
      drop: (400 + rng() * 800) * B.dropMul * (rng() < 0.5 ? 1 : -1),
      w: 70 + rng() * 130,                         // steepness of the step (steeper = more canyon-like)
    });
  }

  for (let x = 0; x <= width; x++) {
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
    terrain[x] = clampY(y, floor);
  }

  // flatten a pocket wherever each tank will spawn
  for (const sx of pickSpawns(seed, n, width)) flattenZone(terrain, sx, 700);
  smooth(terrain, 1);
  return terrain;
}

// Scatter trees across the slopes — well spaced (min gap), not near the
// tanks, not on sheer walls. Sent to clients once; a tree whose ground gets
// blasted away dies.
export function generateTrees(terrain, seed, n = 2, cap = 240, tries = 11000) {
  const rng = mulberry32((seed ^ 0x5eed) >>> 0);
  const spawns = pickSpawns(seed, n);                             // keep the tank pockets clear of trees
  const CLEAR = n >= 3 ? 1100 : 1400;                             // smaller pockets when the map is busier
  const trees = [];
  const MIN_GAP = 85;                                             // world units between trees
  for (let i = 0; i < tries && trees.length < cap; i++) {
    const x = Math.round(600 + rng() * (terrain.length - 1 - 1200));
    if (spawns.some(sx => Math.abs(x - sx) < CLEAR)) continue;      // keep tank pockets clear
    const slope = Math.abs(surfaceAt(terrain, x + 25) - surfaceAt(terrain, x - 25));
    if (slope > 85) continue;                                     // too steep for trees
    if (trees.some(t => Math.abs(t.x - x) < MIN_GAP)) continue;   // keep them spaced out
    trees.push({ x, y0: Math.round(surfaceAt(terrain, x)), s: 0.7 + rng() * 0.5 });
  }
  trees.sort((a, b) => a.x - b.x);
  return trees;
}

function clampY(y, floor = TERRAIN_FLOOR) { return Math.max(TERRAIN_TOP, Math.min(floor, y)); }

function flattenZone(terrain, cx, half) {
  const x0 = Math.max(0, Math.round(cx - half)), x1 = Math.min(terrain.length - 1, Math.round(cx + half));
  let sum = 0, cnt = 0;
  for (let x = Math.round(cx) - 40; x <= Math.round(cx) + 40; x++) {
    if (x >= 0 && x <= terrain.length - 1) { sum += terrain[x]; cnt++; }
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
  const xMax = terrain.length - 1;
  if (x >= xMax) return terrain[xMax];
  const i = Math.floor(x), f = x - i;
  return terrain[i] * (1 - f) + terrain[i + 1] * f;
}

// Random spawn positions, deterministic from the seed. Player 0 always lands in
// the LEFT half and player 1 in the RIGHT half (matching the scoreboard sides),
// and they're always at least a quarter of the map apart. Terrain flattening,
// tree placement and the tanks all call this so they agree on the pockets.
export function pickSpawns(seed, n = 2, width = WORLD_W) {
  const rng = mulberry32((seed ^ 0x5adf00d) >>> 0);
  const margin = 1600;                       // keep clear of the map edges
  const slot = (width - 2 * margin) / n;     // one lane per player
  const jitter = slot * 0.22;                // guarantees a slot*0.56 neighbour gap
  const xs = [];
  for (let i = 0; i < n; i++) {
    xs.push(Math.round(margin + slot * (i + 0.5) + (rng() * 2 - 1) * jitter));
  }
  // Duel guarantee: max 45° range at full power is ~30,044. Cap the gap at
  // 20,000 so the opening exchange has real headroom — a 26k cap left only
  // knife-edge p93-100 solutions that the bots' aim jitter dropped into the
  // doubled massifs (24% of seeds), and pinned every human first shot to the
  // top tenth of the power dial. 12.5k-20k keeps the '2x bigger' feel (old map
  // dealt 5.8k-15k) with the whole arena around it to drive and flank in.
  if (n === 2) {
    const over = (xs[1] - xs[0]) - 20000;
    if (over > 0) { xs[0] += Math.round(over / 2); xs[1] -= Math.round(over / 2); }
  }
  return xs;
}

// Tanks carry `alive` so the shot integrator, blast damage and the burn tick can all
// skip destroyed wrecks without a second parallel array.
export function spawnTanks(terrain, seed, n = 2) {
  return pickSpawns(seed, n).map(x => ({ x, y: surfaceAt(terrain, x), alive: true }));
}

function settle(terrain, tanks) {
  for (const t of tanks) t.y = surfaceAt(terrain, t.x);
}

// ---- Teleport ---------------------------------------------------------------
// Move the FIRING tank onto the point its shell landed on. Authoritative: it
// mutates state.tanks, so simulateShot's `tanks` payload (and therefore both
// clients) carries the new position. Obeys exactly the same placement rules as
// driving (handleMove): clamped to the map edges, and nothing else. A warp may
// land PAST an opponent, or on top of one.
//
// LAVA: deliberately NOT special-cased. Terrain floors out ON the lava
// (TERRAIN_FLOOR === LAVA_Y), so a nuke pit really can bottom out there, and
// burnTick already cooks anything sitting at y >= LAVA_Y - 4. Letting the warp
// land you in it keeps the weapon a genuine risk/reward call and needs no new
// state; blocking it would mean inventing a "teleport refused" outcome both
// clients would have to replay.
// How far seat `by` may legally travel, by driving OR teleporting. Tanks are NOT
// obstacles: you may drive or warp straight past an opponent, so the map edges
// are the whole rule. Seats therefore do NOT stay ordered left→right after spawn
// — pickSpawns lays them out L→R and nothing may assume it still holds. Kept as
// a function with the same signature and the same [lo, hi] shape so teleportTank
// here and handleMove in server.js still share one source of truth and can never
// disagree; `tanks`/`by` are deliberately unused, and are the hook if a future
// placement rule ever needs to consult the other tanks again.
export function laneBounds(tanks, by) {
  return [EDGE_MARGIN, WORLD_W - EDGE_MARGIN];
}

export function teleportTank(state, by, landX) {
  const tank = state.tanks[by];
  const fromX = tank.x, fromY = tank.y;
  const [lo, hi] = laneBounds(state.tanks, by);
  const nx = hi < lo ? fromX : Math.max(lo, Math.min(hi, landX));   // guard: no legal ground
  tank.x = nx;
  tank.y = surfaceAt(state.terrain, nx);      // settle() re-derives this anyway
  return {
    seat: by,
    from: [round1(fromX), round1(fromY)],
    to: [round1(tank.x), round1(tank.y)],
    lava: tank.y >= (state.lavaY ?? LAVA_Y) - 4,   // landed in the lava — the burn will bite
    fizzle: Math.abs(nx - fromX) < 1,         // clamped back onto itself — warp in place
  };
}

// Deform terrain. 'crater' removes ground, 'dirt' mounds it, 'wall' raises a
// tall Gaussian rampart (Earthworks).
// opt: { floor  — this match's lava top (volcanic raises it),
//        guard  — per-column y caps digging may never pass (ruins concrete),
//        wMul   — crater width multiplier (desert bowls, ice sheets),
//        sheet  — flat-bottomed shear instead of a hemisphere (ice) }
function deform(terrain, cx, cy, r, mode, wall, opt = {}) {
  const floor = opt.floor ?? TERRAIN_FLOOR;
  if (mode === 'wall' && wall) {
    const span = Math.ceil(wall.w * 3);
    const x0 = Math.max(0, Math.floor(cx - span)), x1 = Math.min(terrain.length - 1, Math.ceil(cx + span));
    for (let x = x0; x <= x1; x++) {
      const d = (x - cx) / wall.w;
      // Math.max(WALL_TOP, …): a rampart may never crest above WALL_TOP, so the
      // "fire it at your own feet and ride the mound up" ladder tops out with the
      // tank still inside the world. Ground below WALL_TOP is unaffected.
      const target = Math.max(WALL_TOP, cy - wall.h * Math.exp(-d * d));
      terrain[x] = clampY(Math.min(terrain[x], target), floor);
    }
    return;
  }
  const rw = r * (opt.wMul || 1);
  const x0 = Math.max(0, Math.floor(cx - rw));
  const x1 = Math.min(terrain.length - 1, Math.ceil(cx + rw));
  for (let x = x0; x <= x1; x++) {
    const dx = x - cx;
    if (Math.abs(dx) > rw) continue;
    let dy = Math.sqrt(rw * rw - dx * dx) * (r / rw);   // widen without deepening
    if (opt.sheet) dy = Math.min(dy, rw * 0.30);        // ice shears off in a flat sheet
    if (mode === 'crater') {
      let v = Math.max(terrain[x], cy + dy);            // can only lower ground
      // Indestructible concrete: digging can never pass the deck. Piling dirt on
      // top ('dirt'/'wall') is unaffected.
      if (opt.guard && opt.guard[x]) v = Math.min(v, opt.guard[x]);
      terrain[x] = clampY(v, floor);
    } else if (mode === 'dirt') terrain[x] = clampY(Math.min(terrain[x], cy - dy), floor);
  }
}

// ---- Lingering hazards (fire / toxic gas) -----------------------------------
// Ticked once after every shot: any tank inside a hazard takes its per-turn
// damage; the hazard's owner scores those points when the victim is the enemy.
// `now` is passed in (never read from the clock here) so this stays pure: fire
// expires on wall-clock, gas expires on turns, and the two never touch.
export function tickHazards(hazards, tanks, now = 0) {
  const n = tanks.length;
  const dmgTaken = new Array(n).fill(0);
  const points = new Array(n).fill(0);
  for (const h of hazards) {
    if (h.until != null) continue;            // real-time (fire) — turns mean nothing to it
    for (let ti = 0; ti < n; ti++) {
      if (tanks[ti].alive === false) continue;
      if (distToTank(h.x, h.y, tanks[ti]) <= h.r) {
        dmgTaken[ti] += h.dpt;
        if (h.owner !== ti) points[h.owner] += h.dpt;
      }
    }
    h.turnsLeft--;
  }
  return {
    dmgTaken, points,
    alive: hazards.filter(h => (h.until != null ? h.until > now : h.turnsLeft > 0)),
  };
}

// Real-time damage-over-time: one tick of the 5-second burn. Every fire/gas
// hazard damages any tank standing inside it by its per-second `dps`.
// GAS clouds damage any tank standing inside them by their per-second `dps`, and
// the lava floor cooks anything sitting in it. FIRE is NOT here — it runs on its
// own 2-second clock in fireDamage() and does not hold the turn open.
export function burnTick(hazards, tanks, lavaY = LAVA_Y) {
  const n = tanks.length;
  const dmg = new Array(n).fill(0);
  for (const h of hazards) {
    if (h.until != null) continue;   // fire — handled by fireDamage()
    if (!h.dps) continue;
    for (let ti = 0; ti < n; ti++) {
      if (tanks[ti].alive === false) continue;
      if (distToTank(h.x, h.y, tanks[ti]) <= h.r) dmg[ti] += h.dps;
    }
  }
  // The lava floor cooks anything standing in it.
  for (let ti = 0; ti < n; ti++) {
    if (tanks[ti].alive === false) continue;
    if (tanks[ti].y >= lavaY - 4) dmg[ti] += LAVA_DPS;
  }
  return dmg;
}

// One 2-second BITE of fire. Every fire hazard spends one of its FIRE_BITES and
// burns anything standing in it for FIRE_DMG. Overlapping patches deliberately
// do NOT stack (`=`, not `+=`): standing in fire is standing in fire, so an
// 8-bomblet napalm still only does 8 per bite, 24 over its 6-second life.
export function fireDamage(hazards, tanks, exempt) {
  const n = tanks.length;
  const dmg = new Array(n).fill(0);
  for (const h of hazards) {
    if (h.until == null || !(h.bites > 0)) continue;
    h.bites--;
    const bite = h.dmg || FIRE_DMG;
    for (let ti = 0; ti < n; ti++) {
      if (tanks[ti].alive === false) continue;
      if (exempt && exempt(h.owner, ti)) continue;   // e.g. no friendly fire in Boss Fight
      // Overlapping clouds take the WORST bite, they don't stack — standing in
      // fire is standing in fire, gas on top doesn't double-cook you.
      if (distToTank(h.x, h.y, tanks[ti]) <= h.r) dmg[ti] = Math.max(dmg[ti], bite);
    }
  }
  return dmg;
}

// ---- Shot simulation -------------------------------------------------------
// state: { terrain, tanks }. shot: { by, weapon, angle (AIM_MIN..AIM_MAX), power (0..100) }
// Returns a fully resolved shot the clients replay verbatim, plus any new
// lingering hazards this shot created. Each projectile carries an optional
// `delay` (playback points to wait) so bomblets/bombs animate in sequence.
export function simulateShot(state, shot) {
  const w = WEAPON_BY_ID[shot.weapon] || WEAPON_BY_ID.cannon;
  const by = shot.by;
  // Facing is server state (room.facing[seat]), not seat parity — in a free-for-all a
  // tank may be turned either way.
  const dir = shot.dir === -1 ? -1 : 1;
  const power = Math.max(1, Math.min(100, Number.isFinite(Number(shot.power)) ? Number(shot.power) : 60));
  const angle = clampAim(shot.angle);
  const speed = power * SPEED_PER_POWER * w.speedMul;
  const gravMul = w.gravityMul || 1;   // railgun ≈ flat; every other weapon shares one trajectory
  const tank = state.tanks[by];
  const damageDealt = new Array(state.tanks.length).fill(0);
  const projectiles = [];
  SIM_SOLIDS = [
    ...(state.props || []).filter(p => p.kind === 'barrel').map(p => ({ kind: 'barrel', x: p.x, y: p.y, ref: p })),
    ...(state.crates || []).map(c => ({ kind: 'crate', x: c.x, y: c.y })),
  ];
  if (!SIM_SOLIDS.length) SIM_SOLIDS = null;
  const newHazards = [];
  const newScorches = [];
  const propEvents = [];
  // Per-match deform flavour: biome crater shape + lava floor + ruins guard.
  const fx = {
    floor: state.lavaY ?? TERRAIN_FLOOR,
    guard: state.guard || null,
    ...((BIOMES[state.biome] || BIOMES.alpine).crater),
  };

  // NOTHING on the field is immortal. Concrete slabs guard against digging only
  // while they stand: enough battering (170 health) crumbles one — its guard
  // columns clear and the deck collapses into a crater.
  const batterRuins = (x, y, rDmg, dmg) => {
    if (!state.ruins || dmg <= 0) return;
    for (const s of state.ruins) {
      if (s.alive === false) continue;
      const cx2 = (s.a + s.b) / 2, hw = (s.b - s.a) / 2;
      const d = Math.max(0, Math.abs(x - cx2) - hw);
      const reach = rDmg + 200;
      if (d > reach) continue;
      s.hp -= Math.max(0, dmg * (1 - d / reach));
      if (s.hp <= 0) {
        s.alive = false;
        if (state.guard) for (let gx = s.a; gx <= s.b; gx++) state.guard[gx] = 0;
        propEvents.push({ kind: 'slab', x: round1(cx2), y: round1(s.top) });
        deform(state.terrain, cx2, s.top + 80, hw * 1.15, 'crater', null, fx);
      }
    }
  };

  // Chain-reaction props. A damaging blast cooks off any fuel barrel it touches
  // (whose own blast can cook the next one — the queue is the recursion, bounded
  // by the prop count because a barrel dies BEFORE its blast) and batters
  // bunkers, whose raised deck collapses into a crater when they give way.
  const igniteProps = (x, y, rDmg, dmg) => {
    if (!state.props || dmg <= 0) return;
    for (const p of state.props) {
      if (!p.alive) continue;
      const d = Math.hypot(x - p.x, y - (p.y - 120));
      if (p.kind === 'barrel') {
        if (d <= rDmg * 0.9 + 180) {
          p.alive = false;
          propEvents.push({ kind: 'barrel', x: round1(p.x), y: round1(p.y) });
          boom(p.x, p.y - 60, BARREL_R, 'crater', BARREL_DMG, {});
        }
      } else if (p.kind === 'bunker') {
        if (d <= rDmg + p.w) {
          p.hp -= Math.max(0, dmg * (1 - Math.min(1, d / Math.max(1, rDmg + p.w))));
          if (p.hp <= 0) {
            p.alive = false;
            propEvents.push({ kind: 'bunker', x: round1(p.x), y: round1(p.deck) });
            deform(state.terrain, p.x, p.deck + 60, p.w * 1.25, 'crater', null, fx);
          }
        }
      }
    }
  };

  // rDmg = damage radius. Craters + blast visuals use rDmg * CRATER_MUL.
  const boom = (x, y, rDmg, kind, dmg, opts = {}) => {
    if (kind === 'wall') deform(state.terrain, x, surfaceAt(state.terrain, x), 0, 'wall', opts.wall, fx);
    else if (kind === 'scorch') {
      // Fire BURNS the ground — it never moves it. Record a surface scorch range;
      // the terrain heightmap is left completely untouched.
      const sr = Math.max(60, rDmg * SCORCH_MUL);
      newScorches.push({ a: round1(x - sr), b: round1(x + sr) });
    }
    else if (kind !== 'none') {
      const cy = y + (opts.dig ? rDmg * CRATER_MUL * opts.dig : 0);   // bunker buster digs deep
      deform(state.terrain, x, cy, rDmg * CRATER_MUL, kind, null, fx);
    }
    if (dmg > 0) for (let ti = 0; ti < state.tanks.length; ti++) {
      if (state.tanks[ti].alive === false) continue;      // wrecks take no further damage
      damageDealt[ti] += blastDamage(x, y, rDmg, dmg, state.tanks[ti]);
    }
    igniteProps(x, y, rDmg, dmg);
    batterRuins(x, y, rDmg, dmg);
    if (opts.hazard) {
      const hz = opts.hazard;
      const rec = { type: hz.type, x: round1(x), y: round1(y), r: hz.r };
      // REAL-TIME hazard (fire): carries a duration + a bite budget. The server
      // stamps `until` from its own clock when it adopts the hazard, so this
      // function stays pure and clock-free.
      if (hz.ms) { rec.ms = hz.ms; rec.bites = hz.bites; rec.dmg = hz.dmg || FIRE_DMG; }
      // TURN-BASED hazard (gas): unchanged.
      else { rec.turnsLeft = hz.turns; rec.dpt = hz.dpt; rec.dps = hz.dps || 0; }
      newHazards.push(rec);
    }
  };
  const det = (x, y, rDmg, kind, hazardType) => ({
    x: round1(x), y: round1(y),
    r: (kind === 'none' || kind === 'wall') ? Math.max(20, rDmg) : Math.round(rDmg * CRATER_MUL),
    kind, color: w.color, hz: hazardType || null,
  });

  let golfOut, nanoOut;
  const nSub = w.shots;
  for (let i = 0; i < nSub; i++) {
    const off = nSub === 1 ? 0 : (-w.spread / 2 + (w.spread * i) / (nSub - 1));
    const rad = ((angle + off) * Math.PI) / 180;
    const vx = Math.cos(rad) * speed * dir;
    const vy = -Math.sin(rad) * speed;
    const sc = tank.scale || 1;
    const ox = tank.x + dir * BARREL_PIVOT_X * sc + Math.cos(rad) * dir * BARREL_LEN * sc;
    const oy = (tank.y - TANK_CY * sc) - Math.sin(rad) * BARREL_LEN * sc;

    if (w.split) {
      const fp = integrate(state.terrain, state.tanks, ox, oy, vx, vy, { stopAtApex: true, by });
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
        // Burst on contact too — a flat/downhill shot that never reaches apex used
        // to pay out a single bomblet's damage instead of the whole payload.
        projectiles.push({ path: fp.path, det: det(fp.x, fp.y, 20, 'none'), delay: 0 });
        if (fp.hit) {
          const parentLen = fp.path.length, s = w.split;
          for (let k = 0; k < s.count; k++) {
            const frac = s.count === 1 ? 0.5 : k / (s.count - 1);
            const cvx = fp.vx * 0.25 + (frac * 2 - 1) * s.spreadSpeed;
            const cf = integrate(state.terrain, state.tanks, fp.x, fp.y - 30, cvx, -260, {});
            let cdet = null;
            if (cf.hit) {
              cdet = det(cf.x, cf.y, s.radius, s.terrain, s.hazard ? s.hazard.type : null);
              boom(cf.x, cf.y, s.radius, s.terrain, s.damage, { hazard: s.hazard });
            }
            projectiles.push({ path: cf.path, det: cdet, delay: parentLen });
          }
        }
      }
    } else if (w.airstrike) {
      // The shell is a target beacon. Where it lands, a stick of bombs sweeps in.
      const fp = integrate(state.terrain, state.tanks, ox, oy, vx, vy, { by });
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
          // Delays are PRESENTATION ONLY (no physics rides on them). The lead-in
          // gives the client's delivery aircraft a run-in before the first bomb
          // leaves the bay; the spacing sets the drop rhythm — and, because the
          // client derives the plane's ground speed from (spacing / delay spacing),
          // it also sets how fast the plane crosses. See armAirstrike() in app.js.
          projectiles.push({ path: bf.path, det: bdet, delay: parentLen + 72 + k * 12 });
        }
      }
    } else {
      // The putter never lofts: the ball is struck at turf level just ahead of
      // the tank and enters the roll model immediately (angle is irrelevant).
      let iox = ox, ioy = oy, ivx = vx, ivy = vy;
      if (w.ground) {
        // The stroke direction follows the AIM like every club: an angle past
        // 90° flips the launch vx negative and the putt rolls backwards —
        // without this a ball past the cup could never come back.
        const pdir = Math.sign(vx) || dir;
        iox = tank.x + pdir * 350;
        ioy = surfaceAt(state.terrain, iox) - 4;
        ivx = speed * pdir; ivy = 0;
      }
      const fp = integrate(state.terrain, state.tanks, iox, ioy, ivx, ivy,
        w.pierce ? { pierce: true, pierceBy: by, proximity: w.proximity || 0, gravMul, by }
        : w.bounce ? { bounce: w.bounce, gravMul, by, maxT: 60, ground: !!w.ground, cup: state.cup }
        : { gravMul, by });
      let d = null;
      if (w.bounce) {
        // Golf: no detonation — the ball either comes to rest (a soft dust puff)
        // or leaves the world (out of bounds; the server scores the penalty).
        golfOut = { rest: fp.rest ? [fp.rest.x, fp.rest.y] : null };
        if (fp.rest) d = det(fp.rest.x, fp.rest.y, 22, 'none');
      } else if (fp.hit) {
        d = det(fp.x, fp.y, w.wall ? 0 : w.radius, w.terrain, w.hazard ? w.hazard.type : null);
        boom(fp.x, fp.y, w.radius, w.terrain, w.damage, { hazard: w.hazard, dig: w.dig, wall: w.wall });
        // Teleport rides the detonation record so the client can trigger the warp
        // at the exact frame of impact. Must run AFTER boom() (so the tank settles
        // onto any ground this shot reshaped) and BEFORE settle() below.
        if (w.teleport) d.tp = teleportTank(state, by, fp.x);
      }
      // DRILL (NPC lances): the beam does not slip cleanly through the world —
      // it scours a channel through any rock it crosses and grazes every tank
      // along the flight line. Tanks the terminal blast already covers are
      // skipped so nobody is billed twice for the same beam.
      if (w.drill) {
        const grazed = new Set();
        for (let pi = 0; pi < fp.path.length; pi += 2) {
          const dpx = fp.path[pi][0], dpy = fp.path[pi][1];
          if (dpy >= surfaceAt(state.terrain, dpx) - 60) {
            deform(state.terrain, dpx, dpy, w.radius * 0.55, 'crater', null, fx);
          }
          for (let ti = 0; ti < state.tanks.length; ti++) {
            if (ti === by || grazed.has(ti) || state.tanks[ti].alive === false) continue;
            if (fp.hit && Math.hypot(fp.x - state.tanks[ti].x, fp.y - state.tanks[ti].y) <= w.radius * 1.2 + 350) continue;
            if (distToTank(dpx, dpy, state.tanks[ti]) <= Math.max(320, w.radius)) {
              grazed.add(ti);
              damageDealt[ti] += Math.round(w.damage * 0.75);
            }
          }
        }
      }
      // A nano dart that lands releases seekers: they hunt the nearest living
      // ENEMY tank inside the seek radius (never the firer), crawl onto it and
      // detonate — the server runs that clock; the flag here just says who.
      if (w.nano && fp.hit) {
        let ns = -1, nd = Infinity;
        for (let ti = 0; ti < state.tanks.length; ti++) {
          if (ti === by || state.tanks[ti].alive === false) continue;
          const dd = Math.hypot(state.tanks[ti].x - fp.x, state.tanks[ti].y - fp.y);
          if (dd <= w.nano.r && dd < nd) { nd = dd; ns = ti; }
        }
        if (ns >= 0) { nanoOut = { seat: ns, bots: w.nano.bots, dmg: w.nano.dmg, x: fp.x, y: fp.y }; if (d) d.nano = ns; }
      }
      projectiles.push({ path: fp.path, det: d, delay: w.burst ? i * 6 : 0 });
    }
  }

  // A bunker is only as good as the ground under it: if the deck has been dug
  // through across more than a third of its span, the casemate comes down.
  if (state.props) for (const p of state.props) {
    if (p.kind !== 'bunker' || p.alive === false) continue;
    let breached = 0, span = 0;
    for (let tx = Math.max(0, Math.round(p.x - p.w)); tx <= Math.min(state.terrain.length - 1, Math.round(p.x + p.w)); tx++) {
      span++;
      if (state.terrain[tx] > p.deck + 240) breached++;
    }
    if (span > 0 && breached / span > 0.35) {
      p.alive = false;
      propEvents.push({ kind: 'bunker', x: round1(p.x), y: round1(p.deck) });
    }
  }
  settle(state.terrain, state.tanks);
  SIM_SOLIDS = null;
  return {
    projectiles,
    newHazards,
    newScorches,
    propEvents,
    golf: golfOut,
    nano: nanoOut,
    ruins: state.ruins ? state.ruins.map(s => ({ a: s.a, b: s.b, top: s.top, hp: Math.max(0, Math.round(s.hp)), alive: s.alive !== false })) : undefined,
    props: state.props ? state.props.map(p => ({ id: p.id, kind: p.kind, x: round1(p.x), y: round1(p.y), w: p.w || 0, deck: p.deck != null ? round1(p.deck) : undefined, hp: Math.max(0, Math.round(p.hp ?? 0)), alive: p.alive !== false })) : undefined,
    tanks: state.tanks.map(t => ({ x: round1(t.x), y: round1(t.y) })),
    // total damage dealt to everyone who isn't you (self-damage excluded)
    scoreDelta: Math.round(damageDealt.reduce((sum, d, i) => (i === by ? sum : sum + d), 0)),
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
export function aiShot(terrain, tanks, by, difficulty, facing, weaponId = 'cannon') {
  const me = tanks[by];
  // Nearest LIVING opponent. (Duel: identical to the old tanks[1 - by].)
  let enemy = null, bestD = Infinity;
  for (let i = 0; i < tanks.length; i++) {
    if (i === by || tanks[i].alive === false) continue;
    const d = Math.abs(tanks[i].x - me.x);
    if (d < bestD) { bestD = d; enemy = tanks[i]; }
  }
  if (!enemy) return { weapon: 'cannon', angle: 45, power: 60, dir: facing === -1 ? -1 : 1 };
  const dir = enemy.x >= me.x ? 1 : -1;            // turn the turret toward the target
  const aiW = WEAPON_BY_ID[weaponId] || WEAPON_BY_ID.cannon;
  const speedMul = aiW.speedMul;
  const aiGrav = GRAVITY * (aiW.gravityMul || 1);  // the rail lance flies nearly flat

  // Fly one cannon shell read-only; return |landing.x − enemy.x| (0 = direct hit).
  function miss(angle, power) {
    const rad = (angle * Math.PI) / 180;
    const speed = Math.max(1, Math.min(100, power)) * SPEED_PER_POWER * speedMul;
    const sc = me.scale || 1;
    const ox = me.x + dir * BARREL_PIVOT_X * sc + Math.cos(rad) * dir * BARREL_LEN * sc;
    const oy = (me.y - TANK_CY * sc) - Math.sin(rad) * BARREL_LEN * sc;
    let x = ox, y = oy, vx = Math.cos(rad) * speed * dir, vy = -Math.sin(rad) * speed, t = 0, minClear = Infinity;
    // The muzzle now sits inside the firer's own hitbox, so mirror integrate()'s
    // latch — without it every candidate trajectory is rejected as a self-clip and
    // the bot falls back to a fixed 45/60.
    let leftOwn = !pointHitsTank(ox, oy, me);
    while (t < MAX_T) {
      vy += aiGrav * DT; x += vx * DT; y += vy * DT; t += DT;
      if (x < 0 || x > WORLD_W) return Math.abs(x - enemy.x) + 1e5;          // flew off the map
      const armed = Math.hypot(x - ox, y - oy) > ARM_DIST;
      // Direct hit — but one that THREADED A NEEDLE over a peak still pays the
      // clearance penalty, or the search always picks arcs that jitter cannot
      // reproduce (they tip into the mountain face). A clean direct hit is 0.
      if (armed && pointHitsTank(x, y, enemy)) return Math.max(0, 320 - minClear) * 6;
      if (armed && leftOwn && pointHitsTank(x, y, me)) return Math.abs(x - me.x) + 1e5; // would clip itself
      if (!leftOwn && !pointHitsTank(x, y, me)) leftOwn = true;
      const gy2 = surfaceAt(terrain, x);
      if (y >= gy2) {
        // Score = landing miss + a penalty for GRAZING terrain mid-flight. On
        // the doubled-massif map a knife-edge arc that clears a peak by a few
        // units lands perfectly in the search but tips into the mountain face
        // under aim jitter — prefer arcs with real clearance instead.
        // The penalty applies even to perfect landings: a wall-hugging arc
        // that scores 0 in the search flips into the rock under aim jitter.
        return Math.abs(x - enemy.x) + Math.max(0, 320 - minClear) * 6;
      }
      if (armed && x > Math.min(ox, enemy.x) + 900 && x < Math.max(ox, enemy.x) - 900) {
        minClear = Math.min(minClear, gy2 - y);
      }
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
  const errByDiff = { easy: 15, medium: 8, hard: 3.5, boss: 2.2 };   // the WARLORD shoots like it means it
  // RANGE COMPENSATION: landing error grows with distance (dRange/dPower and
  // dRange/dAngle both scale with range), so raw jitter that felt right at the
  // 24k map's ~10k duels scattered shells ~2x as far on the 48k map's ~20k
  // opening exchanges. Shrink the jitter beyond 11k so a bot's LANDING spread
  // — the thing the player experiences — stays constant at every range.
  const rangeK = Math.min(1, 11000 / Math.max(1, bestD));
  const e = (errByDiff[difficulty] || errByDiff.medium) * rangeK;
  const noise = () => Math.random() + Math.random() - 1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const angle = clamp(best.angle + noise() * e, 8, 88);
  const power = clamp(best.power + noise() * e * 1.4, 12, 100);
  return { weapon: weaponId, angle: round1(angle), power: round1(power), dir };
}

// ---- Solid battlefield objects: shells stop on their DRAWN outline ------------
// Supply crates and fuel barrels are rendered at constant SCREEN size; these are
// their world-unit footprints at battle zoom (they read about half a tank wide).
// A shell that visually touches the box detonates ON it — no more flying clean
// through a care package or an explosive barrel.
const SOLID_BOXES = { crate: { hw: 300, h: 560 }, barrel: { hw: 230, h: 580 } };
export function pointHitsSolid(x, y, s) {
  const b = SOLID_BOXES[s.kind] || SOLID_BOXES.crate;
  return Math.abs(x - s.x) <= b.hw && y >= s.y - b.h && y <= s.y + 40;
}
// Set by simulateShot for the duration of one sim so every nested integrate()
// call (splitter children, air-strike bombs, minigun stream) sees the same
// obstacles. A barrel that cooks off mid-salvo stops blocking via its ref.
let SIM_SOLIDS = null;

function integrate(terrain, tanks, ox, oy, vx, vy, opts) {
  const path = [[round1(ox), round1(oy)]];
  const grav = GRAVITY * (opts.gravMul || 1);
  let x = ox, y = oy, t = 0, step = 0, prevVy = vy, bounces = 0;
  // GOLF ROLL MODE: once true, the ball is CONSTRAINED to the surface and obeys
  // rolling physics — gravity along the slope accelerates it, rolling
  // resistance (bounce.rr) bleeds it, and it rests only where friction beats
  // the grade. A putt (opts.ground) starts here and never lofts at all.
  let rolling = !!opts.ground;
  let s = rolling ? Math.hypot(vx, vy) * Math.sign(vx || 1) : 0;   // signed ground speed
  if (rolling) y = surfaceAt(terrain, x);
  const maxT = opts.maxT || MAX_T;
  // The muzzle now sits INSIDE the firer's own (much larger) hitbox, so the shell
  // must be allowed to leave its own tank before it can collide with it.
  let leftOwn = (opts.by == null) || !pointHitsTank(ox, oy, tanks[opts.by]);
  while (t < maxT) {
    if (rolling) {
      const bz = opts.bounce;
      // Cup capture: a ball crossing the hole slowly enough DROPS IN and stays
      // there (no rolling back out). Too fast and it lips out and rolls on —
      // exactly like a real green.
      if (opts.cup && Math.abs(x - opts.cup.x) <= opts.cup.r && Math.abs(s) <= opts.cup.capV) {
        const cx = opts.cup.x, cy = surfaceAt(terrain, cx);
        path.push([round1(cx), round1(cy)]);
        return { path, hit: false, rest: { x: round1(cx), y: round1(cy) }, x: cx, y: cy, vx: 0, vy: 0 };
      }
      const k = (surfaceAt(terrain, x + 24) - surfaceAt(terrain, x - 24)) / 48;   // dy/dx, y-down
      const L = Math.hypot(k, 1);
      s += (GRAVITY * k / L) * DT;                       // slope pulls it downhill
      const dec = (bz.rr * GRAVITY / L) * DT;            // rolling resistance
      s = Math.abs(s) <= dec ? 0 : s - Math.sign(s) * dec;
      x += (s / L) * DT;
      t += DT;
      if (x < 0 || x > terrain.length - 1) {             // rolled clean off the world
        path.push([round1(x), round1(y)]);
        return { path, hit: false, x, y, vx: s, vy: 0 };
      }
      y = surfaceAt(terrain, x);
      // At rest only when stationary AND the grade can't restart the ball.
      if (s === 0 && Math.abs(k) <= bz.rr * 1.05) {
        path.push([round1(x), round1(y)]);
        return { path, hit: false, rest: { x: round1(x), y: round1(y) }, x, y, vx: 0, vy: 0 };
      }
      if (++step % SAMPLE_EVERY === 0) path.push([round1(x), round1(y)]);
      continue;
    }
    vy += grav * DT;
    x += vx * DT;
    y += vy * DT;
    t += DT;

    if (opts.stopAtApex && prevVy < 0 && vy >= 0) {   // top of the arc
      path.push([round1(x), round1(y)]);
      return { path, hit: false, apex: true, x, y, vx, vy };
    }
    prevVy = vy;

    if (x < 0 || x > terrain.length - 1 || y > WORLD_H) { path.push([round1(x), round1(y)]); return { path, hit: false, x, y, vx, vy }; }
    const armed = Math.hypot(x - ox, y - oy) > ARM_DIST;
    if (opts.pierce) {
      // Railgun: ignore terrain and the firer entirely — punch straight through
      // everything until the slug reaches the ENEMY tank. Sub-sample the step so
      // the hypervelocity slug can't tunnel past between steps, and detonate when
      // it passes within `proximity` of the tank (a flat slug rarely lands a
      // pixel-perfect hitbox touch), snapping the blast onto the tank for damage.
      if (armed) {
        const prox = opts.proximity || 0;
        const px = x - vx * DT, py = y - vy * DT;
        const n = Math.max(2, Math.ceil(Math.hypot(x - px, y - py) / 8));
        // Sub-steps OUTSIDE the tank loop: whichever living tank the slug reaches
        // first along this segment is the one it detonates on.
        for (let s = 1; s <= n; s++) {
          const f = s / n, ix = px + (x - px) * f, iy = py + (y - py) * f;
          for (let ti = 0; ti < tanks.length; ti++) {
            if (ti === opts.pierceBy) continue;                   // never your own tank
            const tk = tanks[ti];
            if (tk.alive === false) continue;
            const sc2 = tk.scale || 1;
            const ry = Math.max(tk.y - TANK_HAT_TOP * sc2, Math.min(iy, tk.y + TANK_BELOW * sc2));
            const hw2 = tankHalfWidthAt((tk.y - ry) / sc2) * sc2;                 // closest point on the outline
            const rx = Math.max(tk.x - hw2, Math.min(ix, tk.x + hw2));
            if (distToTank(ix, iy, tk) <= prox) {
              path.push([round1(ix), round1(iy)]); return { path, hit: true, x: rx, y: ry, vx, vy };
            }
          }
        }
      }
    } else {
      const gy = surfaceAt(terrain, x);
      if (y >= gy && opts.bounce) {
        // GOLF: the ball bounces and rolls instead of detonating. Reflect the
        // velocity about the local surface normal (heightmap slope over ±24u),
        // damp the normal component by restitution and the tangential one by
        // friction, and come to rest when it's too slow to matter.
        const bz = opts.bounce;
        bounces = (bounces || 0) + 1;
        const k = (surfaceAt(terrain, x + 24) - surfaceAt(terrain, x - 24)) / 48;   // dy/dx, y-down
        const L = Math.hypot(k, 1);
        const nx2 = k / L, ny2 = -1 / L;                 // outward (up) normal
        const vn = vx * nx2 + vy * ny2;
        const tx2 = vx - vn * nx2, ty2 = vy - vn * ny2;  // tangential part
        vx = tx2 * bz.fric - vn * nx2 * bz.rest;
        vy = ty2 * bz.fric - vn * ny2 * bz.rest;
        y = gy - 0.5;
        path.push([round1(x), round1(gy)]);
        // When the rebound has gone flat (barely leaves the turf any more) the
        // ball is no longer bouncing — it is ROLLING. Hand it to the roll model
        // with its tangential speed; from here on real friction decides where
        // it stops. (The old bz.stop / bounce-count / 6.5s caps are gone.)
        if (Math.abs(vn) * bz.rest < 130) {
          rolling = true;
          s = (vx + vy * k) / L;                          // project onto the tangent
        }
        continue;
      }
      if (y >= gy) { path.push([round1(x), round1(gy)]); return { path, hit: true, x, y: gy, vx, vy }; }
      // Direct tank hit — tested against the tank OUTLINE (hull + turret boxes).
      // SWEPT: one physics step is up to ~91 world units, so sub-sample the
      // segment or a fast shell tunnels clean through the box. Golf balls are
      // NOT ordnance — they sail past tanks and only ever rest on the ground.
      if (armed && !opts.bounce) {
        const px = x - vx * DT, py = y - vy * DT;
        const n = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / 12));
        for (let s = 1; s <= n; s++) {
          const f = s / n, ix = px + (x - px) * f, iy = py + (y - py) * f;
          for (let ti = 0; ti < tanks.length; ti++) {
            if (ti === opts.by && !leftOwn) continue;   // still inside its own hull
            if (tanks[ti].alive === false) continue;    // shells pass through wrecks
            if (pointHitsTank(ix, iy, tanks[ti])) {
              path.push([round1(ix), round1(iy)]); return { path, hit: true, x: ix, y: iy, vx, vy };
            }
          }
          // Crates and barrels stop shells on their outline too. (The railgun's
          // pierce branch never reaches here — a slug punches through them the
          // same way it punches through a mountain.)
          if (SIM_SOLIDS) for (const s of SIM_SOLIDS) {
            if (s.ref && s.ref.alive === false) continue;
            if (pointHitsSolid(ix, iy, s)) {
              path.push([round1(ix), round1(iy)]); return { path, hit: true, x: ix, y: iy, vx, vy };
            }
          }
        }
      }
      // Latch AFTER the sweep — flipping it first lets the same step self-detonate
      // on the box boundary the shell is in the act of leaving.
      if (!leftOwn && !pointHitsTank(x, y, tanks[opts.by])) leftOwn = true;
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
  // Gentler-than-linear falloff so a near miss still hurts properly, tapering
  // to zero at the edge of the blast.
  return dmg * (1 - Math.pow(d / r, 1.5));
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

// ---- Artillery Golf -----------------------------------------------------------
// Dress a generated terrain as a golf hole: a flat tee box, a flat green, and a
// crisp cup notch sunk into it. Returns the cup's surface y.
export function prepareGolfHole(terrain, teeX, cupX, allTees) {
  // A raw battlefield is a wall, not a course: a par-3 dead-ended by a 3000-unit
  // spire just bounces the ball back to the tee (observed). Two wide box-blurs
  // keep the macro elevation — ridges, valleys, doglegs — but knock spires and
  // cliff steps down into fairway rollers a bounced ball can actually take on.
  const nL = terrain.length, R = 340;
  for (let pass = 0; pass < 2; pass++) {
    const pre = new Array(nL + 1); pre[0] = 0;
    for (let x = 0; x < nL; x++) pre[x + 1] = pre[x] + terrain[x];
    for (let x = 0; x < nL; x++) {
      const a = Math.max(0, x - R), b = Math.min(nL - 1, x + R);
      const avg = (pre[b + 1] - pre[a]) / (b - a + 1);
      terrain[x] = terrain[x] * 0.35 + avg * 0.65;
    }
  }
  // The TEEING GROUND: every box — championship back through junior forward —
  // sits on ONE continuous dead-flat platform at a single shared level, fully
  // attached to the terrain (feathered ramps outside its ends only).
  {
    const teeXs = allTees && allTees.length ? allTees : [teeX];
    const lo = Math.max(0, Math.round(Math.min(...teeXs) - 500));
    const hi = Math.min(nL - 1, Math.round(Math.max(...teeXs) + 500));
    let sum = 0;
    for (let px = lo; px <= hi; px++) sum += terrain[px];
    const level = sum / Math.max(1, hi - lo + 1);
    for (let px = lo; px <= hi; px++) terrain[px] = level;
    for (let f = 1; f <= 380; f++) {                     // ramps into the fairway
      const t = 1 - f / 380;
      if (lo - f >= 0) terrain[lo - f] = terrain[lo - f] * (1 - t) + level * t;
      if (hi + f <= nL - 1) terrain[hi + f] = terrain[hi + f] * (1 - t) + level * t;
    }
  }
  // The GREEN: the ENTIRE putting surface is one dead-flat plane — every
  // column inside the green sits at exactly the cup's level. The blend into
  // the fairway happens OUTSIDE the green, in the fringe collar.
  const gHalf = 2200, fringe = 620;
  const gLevel = surfaceAt(terrain, cupX);
  for (let gx = Math.max(0, Math.round(cupX - gHalf - fringe)); gx <= Math.min(nL - 1, Math.round(cupX + gHalf + fringe)); gx++) {
    const dx2 = Math.abs(gx - cupX);
    if (dx2 <= gHalf) terrain[gx] = gLevel;                                    // pure table-top
    else terrain[gx] = terrain[gx] * ((dx2 - gHalf) / fringe) + gLevel * (1 - (dx2 - gHalf) / fringe);
  }
  smooth(terrain, 1);
  // smooth() rounds the fringe shoulders — re-assert the table-top so not one
  // column inside the green deviates from the cup level.
  for (let gx = Math.max(0, Math.round(cupX - gHalf)); gx <= Math.min(nL - 1, Math.round(cupX + gHalf)); gx++) {
    terrain[gx] = gLevel;
  }
  for (let dx = -200; dx <= 200; dx++) {
    const x = Math.round(cupX + dx);
    if (x < 0 || x >= nL) continue;
    terrain[x] = terrain[x] + (1 - Math.pow(Math.abs(dx) / 200, 2)) * 120;
  }
  return round1(surfaceAt(terrain, cupX));
}

// ---- Destructible props -------------------------------------------------------
// Seeded battlefield furniture. Barrels are one-touch bombs; bunkers raise a flat
// concrete deck (cover you can sit behind) that collapses when its HP runs out.
const BARREL_DMG = 26;
const BARREL_R = 800;
export function generateProps(seed, terrain, n = 2, biome = 'alpine') {
  const rng = mulberry32((seed ^ 0x9d2c5680) >>> 0);
  const spawns = pickSpawns(seed, n);
  const props = [];
  const clearOf = (x, gap) => spawns.every(sx => Math.abs(x - sx) > gap) &&
                              props.every(p => Math.abs(x - p.x) > gap);
  let id = 1;
  const barrels = 6 + Math.floor(rng() * 4);         // 6..9 — density kept as the map doubled
  for (let i = 0; i < barrels * 8 && props.filter(p => p.kind === 'barrel').length < barrels; i++) {
    const x = Math.round(2200 + rng() * (WORLD_W - 4400));
    if (!clearOf(x, 1100)) continue;
    props.push({ id: id++, kind: 'barrel', x, y: round1(surfaceAt(terrain, x)), hp: 1, alive: true });
  }
  const bunkers = 2 + Math.floor(rng() * 2);         // 2..3 on the 48k map (ruins gets them too now)
  for (let i = 0; i < bunkers * 8 && props.filter(p => p.kind === 'bunker').length < bunkers; i++) {
    const x = Math.round(3000 + rng() * (WORLD_W - 6000));
    if (!clearOf(x, 1600)) continue;
    const w = 480 + Math.round(rng() * 160);
    // Raise the casemate deck out of the ground so it reads (and works) as cover.
    const deck = round1(Math.min(surfaceAt(terrain, x - w), surfaceAt(terrain, x + w)) - 430);
    for (let tx = Math.max(0, x - w); tx <= Math.min(WORLD_W, x + w); tx++) {
      terrain[tx] = Math.min(terrain[tx], deck + Math.pow(Math.abs(tx - x) / w, 3) * 90);
    }
    props.push({ id: id++, kind: 'bunker', x, y: round1(surfaceAt(terrain, x)), w, deck, hp: 80, alive: true });
  }
  return props;
}

// ---- Ruins (indestructible concrete decks) ------------------------------------
// Raises 3..5 flat slabs and returns both the drawable ranges and a per-column
// guard: digging may never pass guard[x]. Mutates `terrain` like generateProps.
export function generateRuins(seed, terrain, n = 2) {
  const rng = mulberry32((seed ^ 0x51ab3e7) >>> 0);
  const spawns = pickSpawns(seed, n);
  const ranges = [];
  const guard = new Array(WORLD_W + 1).fill(0);
  const clearOf = (x, gap) => spawns.every(sx => Math.abs(x - sx) > gap) &&
                              ranges.every(rr => Math.abs(x - (rr.a + rr.b) / 2) > gap);
  const slabs = 3 + Math.floor(rng() * 3);           // 3..5
  for (let i = 0; i < slabs * 8 && ranges.length < slabs; i++) {
    const x = Math.round(2600 + rng() * (WORLD_W - 5200));
    if (!clearOf(x, 1700)) continue;
    const hw = 300 + Math.round(rng() * 300);
    const top = round1(Math.min(surfaceAt(terrain, x - hw), surfaceAt(terrain, x + hw)) - (380 + rng() * 320));
    const a = Math.max(0, x - hw), b = Math.min(WORLD_W, x + hw);
    for (let tx = a; tx <= b; tx++) {
      terrain[tx] = Math.min(terrain[tx], top);
      guard[tx] = top;                               // nothing digs below the deck
    }
    ranges.push({ a, b, top, hp: 170, alive: true });   // concrete, not immortal
  }
  return { ranges, guard };
}

// ---- Scorch marks (persistent burn scars) -----------------------------------
// Fire leaves 1-D world-x ranges [a,b] on the surface, not height changes.
// Overlapping ranges merge, so a napalm run leaves ONE continuous burnt strip.
// Pure and deterministic; the server owns the list and snapshots it, so both
// clients (and a resumed client) render an identical battlefield.
export function mergeScorch(list, marks) {
  const all = [];
  for (const s of (list || [])) all.push({ a: s.a, b: s.b });
  for (const m of (marks || [])) all.push({ a: Math.max(0, m.a), b: Math.min(WORLD_W, m.b) });
  all.sort((p, q) => p.a - q.a);
  const merged = [];
  for (const s of all) {
    if (!(s.b > s.a)) continue;
    const last = merged[merged.length - 1];
    if (last && s.a <= last.b) last.b = Math.max(last.b, s.b);
    else merged.push({ a: s.a, b: s.b });
  }
  while (merged.length > SCORCH_MAX) {          // shouldn't happen; drop the narrowest scar
    let wi = 0;
    for (let i = 1; i < merged.length; i++) {
      if (merged[i].b - merged[i].a < merged[wi].b - merged[wi].a) wi = i;
    }
    merged.splice(wi, 1);
  }
  return merged.map(s => ({ a: round1(s.a), b: round1(s.b) }));
}
