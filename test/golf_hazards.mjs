// Golf hazards, headless (no server): placement rules, sand physics, the
// water ruling, and the roll/maxT budget. Guards batch 8.17's contract:
//   - every hole seats 1-3 sand bunkers and 0-1 water pond, deterministically,
//     clear of the tee platform, the green and each other;
//   - sand kills the roll (a plugged lie), water ends the shot with a drop
//     point at the approach bank; and
//   - a full-send Driver still comes to REST inside the golf maxT after the
//     roll retune (a truncated roll reads as a phantom OOB).
import { prepareGolfHole, simulateShot, generateTerrain } from '../game-core.js';

let failures = 0;
const fail = (m) => { console.error('FAIL ' + m); failures++; };
const ok = (m) => console.log('  ok — ' + m);

// ---- 1. Placement: deterministic, counted, and in-bounds --------------------
{
  const allTees = [2800, 3400, 4000, 4600], cupX = 100000;
  const keepLo = Math.max(...allTees) + 500 + 380 + 320;
  const keepHi = cupX - 2200 - 620 - 320;
  let waters = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const t1 = new Array(120001).fill(9000);
    const r1 = prepareGolfHole(t1, 4000, cupX, allTees, seed);
    const t2 = new Array(120001).fill(9000);
    const r2 = prepareGolfHole(t2, 4000, cupX, allTees, seed);
    if (JSON.stringify(r1.hazards) !== JSON.stringify(r2.hazards)) fail(`seed ${seed}: placement not deterministic`);
    const sand = r1.hazards.filter(h => h.kind === 'sand');
    const water = r1.hazards.filter(h => h.kind === 'water');
    if (sand.length < 1 || sand.length > 3) fail(`seed ${seed}: ${sand.length} bunkers (want 1-3)`);
    if (water.length > 1) fail(`seed ${seed}: ${water.length} ponds (want 0-1)`);
    waters += water.length;
    for (const h of r1.hazards) {
      if (h.a <= keepLo || h.b >= keepHi) fail(`seed ${seed}: ${h.kind} [${h.a},${h.b}] leaks into tee/green keep-out`);
      if (h.b <= h.a) fail(`seed ${seed}: ${h.kind} inverted range`);
    }
    for (let i = 0; i < r1.hazards.length; i++) {
      for (let j = i + 1; j < r1.hazards.length; j++) {
        const A = r1.hazards[i], B = r1.hazards[j];
        if (A.a <= B.b && B.a <= A.b) fail(`seed ${seed}: ${A.kind} overlaps ${B.kind}`);
      }
    }
    for (const w of water) {
      // The basin must actually hold the waterline: bed below it, rims above.
      const mid = Math.round((w.a + w.b) / 2);
      if (!(t1[mid] > w.y)) fail(`seed ${seed}: pond bed (${t1[mid]}) not below waterline ${w.y}`);
      if (!(t1[w.a - 2] < w.y && t1[w.b + 2] < w.y)) fail(`seed ${seed}: waterline above a bank rim`);
    }
    // The dig must never poison a column: (PI*n)/n can round past PI, sin goes
    // negative, pow(neg, 1.2) is NaN — one NaN column breaks every roll over it.
    for (let x = 0; x < t1.length; x++) {
      if (Number.isNaN(t1[x])) { fail(`seed ${seed}: NaN terrain column at ${x}`); break; }
    }
  }
  if (waters === 0) fail('40 seeds produced zero ponds — water probability broken');
  if (waters === 40) fail('40 seeds produced 40 ponds — the 0-per-hole case never happens');
  if (!failures) ok(`placement: 40 seeds deterministic, 1-3 sand + ${waters}/40 ponds, all in-bounds`);
}

// ---- 1b. Real terrain: every hazard is a DIP in level ground, not a slope ---
// (Jordan, 2026-07-29: 'the bunker should be a dip in the terrain and not on
// the side of a slope'; the pond likewise sits in a hollow with banks.)
{
  const D = 15180, worldW = 36000;
  let checked = 0;
  for (let seed = 101; seed <= 112; seed++) {
    const terrain = generateTerrain(seed, 2, 'alpine', worldW);
    const cupX = 2200 + D;
    const allTees = [cupX - D, Math.round(cupX - D * 0.92), Math.round(cupX - D * 0.84), Math.round(cupX - D * 0.72)];
    const r = prepareGolfHole(terrain, allTees[1], cupX, allTees, seed);
    for (const h of r.hazards) {
      checked++;
      const bankL = terrain[h.a - 40], bankR = terrain[h.b + 40];
      const mid = terrain[Math.round((h.a + h.b) / 2)];
      if (Math.abs(bankL - bankR) > 40) fail(`seed ${seed}: ${h.kind} banks tilt ${Math.round(Math.abs(bankL - bankR))}u — sitting on a slope`);
      if (!(mid > bankL + 50 && mid > bankR + 50)) fail(`seed ${seed}: ${h.kind} does not dip below its banks (mid ${Math.round(mid)} vs ${Math.round(bankL)}/${Math.round(bankR)})`);
      if (h.kind === 'water') {
        if (!(h.y > bankL && h.y > bankR)) fail(`seed ${seed}: waterline ${h.y} sits above a bank (${Math.round(bankL)}/${Math.round(bankR)})`);
        if (!(mid - h.y <= 220)) fail(`seed ${seed}: pond is ${Math.round(mid - h.y)}u deep — should be shallow (<=220)`);
      }
    }
  }
  if (!failures) ok(`real terrain: ${checked} hazards across 12 seeded holes all dip into level banks`);
}

// ---- 2. Sand physics: the ball plugs instead of releasing -------------------
{
  const flat = () => new Array(60001).fill(9000);
  const shot = { by: 0, weapon: 'golfball', angle: 20, power: 70 };
  const ctrl = simulateShot({ terrain: flat(), tanks: [{ x: 5000, y: 9000 }] }, shot);
  const sandy = simulateShot({ terrain: flat(), tanks: [{ x: 5000, y: 9000 }],
    golfHazards: [{ kind: 'sand', a: 13000, b: 20000 }] }, shot);
  const rc = ctrl.golf && ctrl.golf.rest, rs = sandy.golf && sandy.golf.rest;
  if (!rc || !rs) fail('sand test: a ball failed to rest');
  else {
    if (!(rs[0] >= 13000 && rs[0] <= 20400)) fail(`sand: ball did not stay in the bunker (rest ${Math.round(rs[0])})`);
    if (!(rc[0] - rs[0] > 1500)) fail(`sand barely bit: control ${Math.round(rc[0])} vs bunker ${Math.round(rs[0])}`);
    else ok(`sand: control rolls to ${Math.round(rc[0])}, bunker plugs it at ${Math.round(rs[0])}`);
  }
}

// ---- 3. Water: splash ends the shot, drop point on the approach bank --------
{
  const terrain = new Array(60001).fill(9000);
  for (let x = 12000; x <= 14000; x++) terrain[x] = 9400;      // dug basin
  const water = { kind: 'water', a: 12000, b: 14000, y: 9055 };
  const r = simulateShot({ terrain, tanks: [{ x: 5000, y: 9000 }],
    golfHazards: [water] }, { by: 0, weapon: 'golfball', angle: 30, power: 52 });
  const w = r.golf && r.golf.water;
  if (!w) fail('water: ball crossed the pond without a splash ruling');
  else {
    if (w.x !== 11740) fail(`water: drop should be the approach bank at 11740, got ${w.x}`);
    if (r.golf.rest) fail('water: a splashed ball must not also report a rest');
    const path = r.projectiles[0].path, tip = path[path.length - 1];
    if (Math.abs(tip[1] - water.y) > 2) fail(`water: replay ends at y ${tip[1]}, not on the waterline ${water.y}`);
    if (!failures) ok(`water: splash at the pond, ball dropped at ${w.x}, replay ends on the waterline`);
  }
}

// ---- 4. Roll budget: a full-send Driver still RESTS (maxT headroom) ---------
{
  const r = simulateShot({ terrain: new Array(260001).fill(9000), tanks: [{ x: 8000, y: 9000 }] },
    { by: 0, weapon: 'driver', angle: 40, power: 100 });
  const rest = r.golf && r.golf.rest;
  const secs = r.projectiles[0].path.length / 30;              // 30 path points per sim second
  if (!rest) fail(`driver full-send never rested (${secs.toFixed(1)}s of sim) — maxT truncation reads as phantom OOB`);
  else if (secs > 97) fail(`driver full-send rests but at ${secs.toFixed(1)}s — no headroom under the 100s maxT`);
  else ok(`driver full-send rests at ${Math.round(rest[0] - 8000)}u total in ${secs.toFixed(1)}s sim`);
}

// ---- 5. Boundary: a wall bounce-back RESTS at the course edge ----------------
// (Live failure: a cliff in front of the tee returned the ball past the tee
// and off the world's left edge — 'oob' with the ball unmoved, every swing.)
{
  const terrain = new Array(36001).fill(9000);
  for (let x = 3000; x < 36001; x++) terrain[x] = Math.max(2600, 9000 - (x - 3000) * 3);   // sheer wall ahead
  const r = simulateShot({ terrain, tanks: [{ x: 1500, y: 9000 }] },
    { by: 0, weapon: 'golfball', angle: 49, power: 58.8 });
  const rest = r.golf && r.golf.rest;
  if (!rest) fail('wall return: ball left the world instead of resting at the boundary');
  else if (rest[0] < 200) fail(`wall return: rest at ${rest[0]} is outside the course`);
  else ok(`wall return: ball rests on-course at ${Math.round(rest[0])} (never exits the left edge)`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL GOOD');
process.exit(failures ? 1 : 0);
