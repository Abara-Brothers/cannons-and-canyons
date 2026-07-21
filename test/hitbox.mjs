// Headless hitbox regression: fire EVERY weapon at an enemy tank on a flat,
// deterministic battlefield and assert real damage lands. Guards the three ways
// this has broken: hitbox too small to hit, shell detonating on its own tank,
// and fast shells tunnelling through the box.
import { WEAPONS, simulateShot, pointHitsTank, aiShot, generateTerrain, spawnTanks, laneBounds } from '../game-core.js';

const FLAT_Y = 9000, ME = 4000, ENEMY = 16000;
const flat = () => new Array(24001).fill(FLAT_Y);
const fresh = () => ({ terrain: flat(), tanks: [{ x: ME, y: FLAT_Y }, { x: ENEMY, y: FLAT_Y }] });
const fire = (weapon, angle, power) => simulateShot(fresh(), { by: 0, weapon, angle, power });

// Minimum damage each weapon must be able to put on the enemy. Set below the
// measured post-fix maxima so tuning drift does not make this flaky, but far
// above the pre-fix values it is guarding against.
const FLOOR = {
  cannon: 20, mortar: 40, volley: 30, railgun: 55, cluster: 40, napalm: 25,
  gas: 4, airstrike: 45, buster: 25, nuke: 65,
  wall: 0,       // Earthworks deals no damage by design
  teleport: 0,   // Teleport deals no damage by design — it repositions the firer
};

let failures = 0;
const fail = (m) => { console.error('FAIL ' + m); failures++; };

// 1 — the hitbox exists where the tank is DRAWN. Every one of these points is
//     inside the sprite the client renders, so every one must register.
for (const [dx, up, what] of [[0, 0, 'ground point'], [0, 120, 'hull'], [0, 300, 'turret'],
                              [300, 120, 'hull edge'], [-300, 20, 'track edge'], [0, -20, 'tracks below grade']]) {
  if (!pointHitsTank(ENEMY + dx, FLAT_Y - up, { x: ENEMY, y: FLAT_Y })) {
    fail(`pointHitsTank miss at ${what} (dx=${dx}, up=${up})`);
  }
}
if (pointHitsTank(ENEMY + 900, FLAT_Y, { x: ENEMY, y: FLAT_Y })) fail('pointHitsTank false positive 900 units away');

// 2 — every weapon must be able to actually hurt the enemy somewhere in the
//     angle/power space, and must never hurt the FIRER on a normal outbound shot.
const report = [];
for (const w of WEAPONS) {
  let bestEnemy = 0, worstSelf = 0, bestAt = null;
  for (let a = 10; a <= 80; a += 2.5) {
    for (let p = 20; p <= 100; p += 2.5) {
      let r;
      try { r = fire(w.id, a, p); } catch (e) { fail(`${w.id} threw at ${a}/${p}: ${e.message}`); continue; }
      const [self, enemy] = r.damage;
      if (enemy > bestEnemy) { bestEnemy = enemy; bestAt = `${a}/${p}`; }
      if (self > worstSelf) worstSelf = self;
    }
  }
  report.push({ weapon: w.id, maxEnemy: bestEnemy, at: bestAt, maxSelf: worstSelf });
  const floor = FLOOR[w.id];
  if (floor === undefined) fail(`no FLOOR defined for new weapon '${w.id}'`);
  else if (bestEnemy < floor) fail(`${w.id} peaks at ${bestEnemy} damage, expected >= ${floor}`);
}

// 3 — a plain outbound shot must never detonate on the firer (the latch).
for (const [a, p, what] of [[8, 60, 'shallow'], [45, 60, 'normal'], [88, 60, 'steep'], [45, 100, 'max power']]) {
  const r = fire('cannon', a, p);
  if (r.damage[0] !== 0) fail(`cannon ${what} (${a}/${p}) self-damaged for ${r.damage[0]} — latch broken`);
}

// 4 — ballistics unchanged: the latch must not shorten a normal shot.
const land = fire('cannon', 45, 60);
const endX = land.projectiles[0].path[land.projectiles[0].path.length - 1][0];
if (endX < 20000) fail(`cannon 45/60 landed at x=${endX}, expected ~22400 (latch ordering bug)`);

// 5 — Teleport moves the FIRER onto the landing point, MAY cross the enemy,
//     never deforms terrain, and never moves the other tank.
{
  const st = fresh();
  const r = simulateShot(st, { by: 0, weapon: 'teleport', angle: 45, power: 40 });
  const tp = r.projectiles[0].det && r.projectiles[0].det.tp;
  if (!tp) fail('teleport produced no tp payload on a landing shot');
  else {
    if (Math.abs(r.tanks[0].x - ME) < 1) fail('teleport did not move the firer');
    if (r.tanks[1].x !== ENEMY) fail('teleport moved the ENEMY tank');
    if (r.damage[0] !== 0 || r.damage[1] !== 0) fail(`teleport dealt damage ${JSON.stringify(r.damage)}`);
    if (st.terrain.some(v => v !== FLAT_Y)) fail('teleport deformed the terrain');
  }
  // Crossing is now LEGAL: a long warp must land PAST the enemy, not clamp short
  // of them — but it must still never leave the map.
  {
    const s2 = fresh();
    const r2 = simulateShot(s2, { by: 0, weapon: 'teleport', angle: 45, power: 60 });
    if (!(r2.tanks[0].x > ENEMY + 1000)) fail(`teleport 45/60 landed at x=${r2.tanks[0].x}, expected past the enemy at ${ENEMY}`);
    if (r2.tanks[1].x !== ENEMY) fail('a crossing teleport moved the ENEMY tank');
    for (let p = 20; p <= 100; p += 2.5) {
      const s3 = fresh();
      const r3 = simulateShot(s3, { by: 0, weapon: 'teleport', angle: 45, power: p });
      if (r3.tanks[0].x < 200 || r3.tanks[0].x > 23800) fail(`teleport at power ${p} left the map: x=${r3.tanks[0].x}`);
    }
  }
}

// 6 — tanks are NOT obstacles: laneBounds must ignore every other tank and return
//     the map edges, whatever the layout. This is what lets you drive/warp past an
//     opponent, and handleMove clamps to exactly this.
{
  const layouts = [
    [{ x: 4000, alive: true }, { x: 16000, alive: true }],
    [{ x: 16000, alive: true }, { x: 4000, alive: true }],                       // already crossed
    [{ x: 9000, alive: true }, { x: 9000, alive: true }],                        // perfectly overlapped
    [{ x: 2000, alive: true }, { x: 8000, alive: false }, { x: 9000, alive: true }, { x: 20000, alive: true }],
  ];
  for (const tanks of layouts) {
    for (let i = 0; i < tanks.length; i++) {
      const [lo, hi] = laneBounds(tanks, i);
      if (lo !== 200 || hi !== 23800) {
        fail(`laneBounds fenced seat ${i} to [${lo}, ${hi}] — tanks must not block each other`);
      }
    }
  }
}

// 7 — the bot must still find real solutions, not fall back to 45/60.
const terrain = generateTerrain(2024);
const tanks = spawnTanks(terrain, 2024);
const shot = aiShot(terrain, tanks, 1, 'hard');
if (shot.angle === 45 && shot.power === 60) fail('aiShot returned the fallback 45/60 — self-clip latch missing');

console.table(report);
console.log(`cannon 45/60 lands at x=${endX}`);
console.log(`aiShot(hard) -> angle ${shot.angle.toFixed(1)} power ${shot.power.toFixed(1)}`);
console.log(failures === 0 ? '\nALL HITBOX CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
