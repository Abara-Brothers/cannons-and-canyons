// THE CARD STUDIO, evaluated inside the game page by tools/cards/capture.mjs
// (a classic script, so it shares the page's globals: S, cam, view, canvas,
// ctx, draw, handle, surfaceAt and the rest of app.js).
//
// Nothing here draws a pixel of the game itself. The battlefield, the tanks
// (drawTank, locked), the WARLORD, the saucers, the shells, the blasts and the
// golf course are all painted by app.js's own draw(), from a match the real
// server started. What the studio adds is a director's chair:
//   - it holds the game loop and steps it by hand, so a moment can be frozen;
//   - it stands the combatants where the shot needs them (S.tanks, facing,
//     aim), and fires shells whose flight is game-core's own simulateShot, fed
//     to the page through handle() exactly as a server 'shot' frame is;
//   - it renders the frozen moment at any camera and resolution through draw();
//   - it grades the crop (colour, glow, vignette) and encodes it.
// The page is thrown away after a capture, so nothing it changes outlives it.
(() => {
  if (window.__studio) return;

  // HOLDING THE LOOP. While held, the game's own frames (the rAF loop, and
  // the timer that steps a hidden page) reach the step functions and draw()
  // and find them shut: only the studio's own calls (tick, render) open them.
  // So a frozen moment stays frozen however many frames the browser fires,
  // and a shell's trail (pushed once per draw) is grown by tick() alone. The
  // guards are installed on window, which is where frame() looks each name
  // up, so a frame already scheduled is held as surely as the next one.
  let held = false, own = 0;
  for (const name of ['advanceAnim', 'stepTerrainAnim', 'stepEffects', 'stepKillcam', 'updateCamera', 'draw']) {
    const f = window[name];
    window[name] = function heldStep() { if (held && !own) return undefined; return f.apply(this, arguments); };
  }
  const mine = (fn) => { own++; try { return fn(); } finally { own--; } };

  let core = null;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  // A copy of the battlefield in the shape room-engine.js hands simulateShot,
  // so a staged shot flies through the same terrain, props and crates the
  // page shows.
  function simState() {
    return {
      terrain: S.terrain.slice(),
      tanks: S.tanks.map((t, i) => ({ x: t.x, y: t.y, alive: S.alive[i] !== false, scale: (S.scales && S.scales[i]) || 1 })),
      lavaY: S.lavaY, biome: S.biome, guard: null,
      props: clone(S.props || []), crates: clone(S.crates || []),
      ruins: S.ruins && S.ruins.length ? clone(S.ruins) : undefined,
    };
  }

  const api = {
    // From here on the page runs on the studio's clock: Math.random restarts
    // from a fixed seed, and performance.now -- which the saucers' bob, the
    // running lights, the fire and the chain blasts all read -- moves only
    // when tick() moves it. Whatever the wall clock did while the match was
    // being started, the moment comes out the same on every run.
    async init(seed = 7) {
      core = await import('/game-core.js');
      held = true;
      let a = seed >>> 0;
      Math.random = function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      // A fixed hour, past any time this page can have been open, so nothing
      // timed against the real clock earlier sees time run backwards.
      let clock = 1e7;
      performance.now = () => clock;
      api.advanceClock = (ms) => { clock += ms; };
      return true;
    },
    // One frame of the game at a fixed step: the calls frame() makes, minus
    // the camera, which the studio sets itself.
    tick(dt) {
      api.advanceClock(dt * 1000);
      mine(() => {
        stepKillcam(dt);
        const sdt = dt * killcamScale();
        advanceAnim(sdt); stepTerrainAnim(sdt); stepEffects(sdt);
        draw();
      });
    },
    run(seconds, dt = 1 / 60) { for (let t = 0; t < seconds; t += dt) api.tick(dt); return true; },
    // Step until the shot's playback clock (path points) reaches `points`.
    runTo(points, dt = 1 / 60) {
      for (let k = 0; k < 4000 && S.anim && S.anim.elapsed < points; k++) api.tick(dt);
      return S.anim ? S.anim.elapsed : null;
    },

    // Stand a combatant at x, settled on the ground, turned and aimed.
    put(seat, x, o = {}) {
      S.tanks[seat] = { x, y: surfaceAt(x) };
      if (o.face) S.facing[seat] = o.face;
      if (o.angle != null || o.power != null) S.aim[seat] = { angle: o.angle ?? 45, power: o.power ?? 60 };
      S.lean[seat] = 0; S.leanV[seat] = 0; S.leanTarget[seat] = 0; S.recoil[seat] = 0;
      return S.tanks[seat];
    },
    groundAt(x) { return surfaceAt(x); },

    // game-core's flight for a shot from the CURRENT positions, on a copy.
    sim(seat, weapon, angle, power) {
      return core.simulateShot(simState(), { by: seat, weapon, angle, power, dir: S.facing[seat] === -1 ? -1 : 1 });
    },
    // The power (and, given several, the angle) that brings `seat`'s shot
    // down nearest to targetX: where it bursts, or -- with `land`, for a golf
    // ball that rolls on -- where it first meets the ground. `d` says how
    // near: a stage checks it, so a ridge in the way can never quietly turn a
    // shot at the foe into one at the player.
    solve(seat, weapon, angles, targetX, land = false) {
      let best = null;
      for (const angle of [].concat(angles)) {
        for (let p = 20; p <= 100; p += 0.5) {
          const r = api.sim(seat, weapon, angle, p);
          const pr = r.projectiles[0]; if (!pr) continue;
          let k = pr.path.length - 1;
          if (land) for (let j = 8; j < pr.path.length; j++) if (pr.path[j][1] >= surfaceAt(pr.path[j][0]) - 30) { k = j; break; }
          const end = pr.det && !land ? pr.det.x : pr.path[k][0];
          const d = Math.abs(end - targetX);
          if (!best || d < best.d) best = { angle, p, d, end, len: pr.path.length, land: k };
        }
      }
      if (!best || best.d > 700) throw new Error(`no ${weapon} shot from seat ${seat} reaches ${Math.round(targetX)} (best ${best && Math.round(best.d)} off)`);
      return best;
    },
    // A base x near `near` where every offset in `offs` stands on ground of
    // about one height, level enough to read square, with no ridge between
    // the first and the last standing above them: a row of combatants on one
    // shelf, in sight of each other. `rise` lifts the later ones (saucers on
    // the high ground).
    row(offs, near, range = 9000, rise = []) {
      let best = null;
      for (let b = near - range; b <= near + range; b += 60) {
        const xs = offs.map((o) => b + o);
        if (xs.some((x) => x < 1500 || x > WW() - 1500)) continue;
        const ys = xs.map((x, i) => surfaceAt(x) + (rise[i] || 0));
        const slope = xs.reduce((m, x) => Math.max(m, Math.abs(surfaceAt(x + 380) - surfaceAt(x - 380))), 0);
        let ridge = 0;
        for (let k = 0; k + 1 < xs.length; k++) {
          const lineY = Math.min(surfaceAt(xs[k]), surfaceAt(xs[k + 1])) - 250;
          for (let x = xs[k] + 500; x < xs[k + 1] - 500; x += 100) ridge = Math.max(ridge, lineY - surfaceAt(x));
        }
        const cost = (Math.max(...ys) - Math.min(...ys)) + slope * 1.5 + ridge * 3 + Math.abs(b - near) * 0.02;
        if (!best || cost < best.cost) best = { b, cost };
      }
      return best.b;
    },
    // FIRE. Each entry is one combatant's real shot; all of them are flown by
    // simulateShot in order on ONE copy of the field (a later shell meets the
    // craters of an earlier one), merged into a single 'shot' frame with each
    // entry's `delay` (path points, 1/30 s of flight each) added to its
    // projectiles, and handed to handle() -- the page's own door for a server
    // frame. Returns when each projectile flies, on the playback clock.
    fire(shots) {
      const st = simState();
      const before = st.terrain.slice();
      const projectiles = [];
      const spans = [];
      let props = null, propEvents = [], ruins = null, tanks = null;
      const damage = new Array(S.n).fill(0);
      for (const s of shots) {
        S.aim[s.seat] = { angle: s.angle, power: s.power };
        const r = core.simulateShot(st, { by: s.seat, weapon: s.weapon, angle: s.angle, power: s.power, dir: S.facing[s.seat] === -1 ? -1 : 1 });
        for (const pr of r.projectiles) {
          const delay = (pr.delay || 0) + (s.delay || 0);
          projectiles.push({ ...pr, delay });
          spans.push({ seat: s.seat, start: delay, end: delay + pr.path.length - 1, det: !!pr.det });
        }
        r.damage.forEach((d, i) => { damage[i] += d || 0; });
        props = r.props; propEvents = propEvents.concat(r.propEvents || []); ruins = r.ruins; tanks = r.tanks;
      }
      const m = {
        type: 'shot', by: shots[0].seat, weapon: shots[0].weapon, projectiles,
        terrainDiff: core.terrainDiff(before, st.terrain), tanks,
        hp: S.hp.map((h, i) => Math.max(0, Math.round(h - damage[i]))), damage,
        hazards: S.hazards, scorch: S.scorch, hazardDamage: new Array(S.n).fill(0),
        alive: S.alive.slice(), props, propEvents, ruins,
        shield: (S.shield || []).slice(), shieldPop: new Array(S.n).fill(false),
        ammo: null, ammoSeat: -1, killcam: null,
      };
      handle(m);
      // Every other shooter's gun kicks and flashes as it fires, as the first
      // one's does in startNextShot.
      for (const s of shots.slice(1)) if (s.seat !== shots[0].seat && !s.delay) muzzleBlast(s.seat);
      return spans;
    },
    blastOf(seat) { muzzleBlast(seat); },

    // RENDER the frozen moment through the game's own draw(), into a canvas
    // `cssW` x `cssH` game pixels at `ss` device pixels each, with the camera
    // at (cx, cy, zoom). The on-screen helpers that are not the battle (edge
    // markers, the flag marker, the aim demo, the coach card, damage numbers,
    // and -- unless `aim` -- the player's own aim line and power cradle)
    // stand down for this one draw, and the shake is zeroed; every trail and
    // the page's own canvas are put back afterwards.
    render(cx, cy, zoom, cssW, cssH, ss, aim) {
      const keep = { cw: canvas.width, ch: canvas.height, cssW: view.cssW, cssH: view.cssH, dispW: view.dispW, dispH: view.dispH,
        zoom: cam.zoom, cx: cam.cx, cy: cam.cy, shake: S.shake, floaters: S.floaters };
      const trails = S.anim ? S.anim.projectiles.map((p) => p.trail.slice()) : null;
      const quiet = {};
      for (const n of ['drawAim', 'drawEdgeIndicators', 'drawCupIndicator', 'drawAimGuide', 'renderCoach', 'drawKillcam']) {
        if (n === 'drawAim' && aim) continue;
        quiet[n] = window[n]; window[n] = () => {};
      }
      try {
        canvas.width = Math.round(cssW * ss); canvas.height = Math.round(cssH * ss);
        view.cssW = cssW; view.cssH = cssH; view.dispW = canvas.clientWidth; view.dispH = canvas.clientHeight;
        ctx.setTransform(ss, 0, 0, ss, 0, 0); ctx.imageSmoothingEnabled = true;
        cam.zoom = zoom; cam.cx = cx; cam.cy = cy; S.shake = 0; S.floaters = [];
        mine(draw);
        const out = document.createElement('canvas');
        out.width = canvas.width; out.height = canvas.height;
        out.getContext('2d').drawImage(canvas, 0, 0);
        return out;
      } finally {
        for (const n in quiet) window[n] = quiet[n];
        if (trails) S.anim.projectiles.forEach((p, i) => { p.trail = trails[i]; });
        S.shake = keep.shake; S.floaters = keep.floaters;
        cam.zoom = keep.zoom; cam.cx = keep.cx; cam.cy = keep.cy;
        resize();
      }
    },

    // THE LOOK. A crop of the render, scaled to the card's size, then graded:
    //   colour  - a touch more contrast and saturation, so the flat game
    //             palette holds up under the bay's dark card overlays;
    //   glow    - the brightest parts (sun, blasts, tracers, plasma) bloom: a
    //             blurred, thresholded copy screened back over the picture;
    //   tone    - a cool shade at the top and a warm lift low down, faint;
    //   vignette- the corners fall away, so the action in the middle reads.
    // Returns a WebP data URL at `q`.
    finish(src, crop, outW, outH, look, q) {
      const L = Object.assign({ contrast: 1.08, saturate: 1.14, brightness: 1.0, glow: 0.7, glowFrom: 0.6, glowBlur: 0.008, vignette: 0.5, cool: 0.10, warm: 0.08 }, look || {});
      const c = document.createElement('canvas'); c.width = outW; c.height = outH;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.filter = `contrast(${L.contrast}) saturate(${L.saturate}) brightness(${L.brightness})`;
      g.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
      g.filter = 'none';
      if (L.glow > 0) {
        // The bloom is taken only from what is both bright AND coloured --
        // fire, plasma, tracers, the sun -- weighted per pixel, so a pale sky
        // or a snowfield does not haze over the whole picture.
        const bw = Math.max(1, Math.round(outW / 3)), bh = Math.max(1, Math.round(outH / 3));
        const b = document.createElement('canvas'); b.width = bw; b.height = bh;
        const bg = b.getContext('2d'); bg.drawImage(c, 0, 0, bw, bh);
        const img = bg.getImageData(0, 0, bw, bh), d = img.data;
        for (let k = 0; k < d.length; k += 4) {
          const r = d[k] / 255, gg = d[k + 1] / 255, bb = d[k + 2] / 255;
          const mx = Math.max(r, gg, bb), mn = Math.min(r, gg, bb);
          const sat = mx > 0 ? (mx - mn) / mx : 0;
          const t = Math.max(0, Math.min(1, (mx - L.glowFrom) / (1 - L.glowFrom)));
          const w = t * t * (3 - 2 * t) * (0.12 + 0.88 * sat);
          d[k] *= w; d[k + 1] *= w; d[k + 2] *= w; d[k + 3] = 255;
        }
        bg.putImageData(img, 0, 0);
        g.globalCompositeOperation = 'screen';
        for (const [blur, a] of [[outW * L.glowBlur, L.glow], [outW * L.glowBlur * 3, L.glow * 0.6]]) {
          g.filter = `blur(${Math.max(1.5, blur)}px)`; g.globalAlpha = a;
          g.drawImage(b, 0, 0, outW, outH);
        }
        g.filter = 'none'; g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      }
      const tone = g.createLinearGradient(0, 0, 0, outH);
      tone.addColorStop(0, `rgba(40,70,140,${L.cool})`);
      tone.addColorStop(0.55, 'rgba(0,0,0,0)');
      tone.addColorStop(1, `rgba(255,150,70,${L.warm})`);
      g.globalCompositeOperation = 'soft-light'; g.fillStyle = tone; g.fillRect(0, 0, outW, outH);
      g.globalCompositeOperation = 'source-over';
      if (L.vignette > 0) {
        const r = Math.hypot(outW, outH) / 2;
        const v = g.createRadialGradient(outW / 2, outH * 0.48, r * 0.38, outW / 2, outH * 0.48, r);
        v.addColorStop(0, 'rgba(4,6,12,0)');
        v.addColorStop(1, `rgba(4,6,12,${L.vignette})`);
        g.fillStyle = v; g.fillRect(0, 0, outW, outH);
      }
      return c.toDataURL('image/webp', q);
    },
    raw(src, crop, outW, outH) {
      const c = document.createElement('canvas'); c.width = outW; c.height = outH;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
      return c.toDataURL('image/png');
    },

    // WHERE EACH NAMED SUBJECT IS DRAWN IN A CROP (WARLORD-7, a saucer, a
    // tank, a shell, the ball, the flag). The moment is rendered once as it
    // is and once more for each subject with that one subject left out; the
    // subject is every pixel the two renders differ in, so its box is exactly
    // what the game drew for it, its gun and glow included. The renders are
    // compared over the whole screen, not only the crop, so a subject the
    // crop cuts off comes back reaching past the crop's edge instead of as a
    // smaller box that looks whole. Each box is in fractions of the crop (0
    // to 1 across and down, the card picture's own frame), or null when the
    // subject is not drawn at all. test/mode_cards.mjs holds every box clear
    // of the pills, badges, icons and labels the bay lays over the card.
    //   { seat }  a combatant: a tank, WARLORD-7 or a saucer (drawn only
    //             while S.alive[seat] is not false);
    //   { shot }  a projectile in the air, by its index in the shot frame;
    //   { cup }   the golf cup and its flag.
    boxes(cx, cy, zoom, cssW, cssH, ss, aim, crop, subjects) {
      const pixels = (cv) => cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const draw1 = () => pixels(api.render(cx, cy, zoom, cssW, cssH, ss, aim));
      const base = draw1();
      const W = Math.round(cssW * ss);
      return subjects.map((sub) => {
        let undo;
        if (sub.seat != null) { const was = S.alive[sub.seat]; S.alive[sub.seat] = false; undo = () => { S.alive[sub.seat] = was; }; }
        else if (sub.shot != null) {
          const pr = S.anim && S.anim.projectiles[sub.shot];
          if (!pr) throw new Error(`no projectile ${sub.shot} for ${sub.name}`);
          const was = [pr.done, pr.exploded]; pr.done = true; pr.exploded = true;
          undo = () => { pr.done = was[0]; pr.exploded = was[1]; };
        } else if (sub.cup) { const f = window.drawGolfCup; window.drawGolfCup = () => {}; undo = () => { window.drawGolfCup = f; }; }
        else throw new Error(`subject ${sub.name} names nothing to leave out`);
        let d;
        try { d = draw1(); } finally { undo(); }
        // The two renders are identical wherever the subject is not (the page
        // runs on the studio's clock and draw() spends no randomness), so the
        // floor of 12, summed over the four channels, only drops the faintest
        // fringe of a glow.
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < d.length; k += 4) {
          if (Math.abs(d[k] - base[k]) + Math.abs(d[k + 1] - base[k + 1]) + Math.abs(d[k + 2] - base[k + 2]) + Math.abs(d[k + 3] - base[k + 3]) <= 12) continue;
          const p = k >> 2, x = p % W, y = (p - x) / W;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        const r4 = (v) => Math.round(v * 1e4) / 1e4;
        return { name: sub.name, box: x1 < 0 ? null
          : [r4((x0 - crop.x) / crop.w), r4((y0 - crop.y) / crop.h), r4((x1 + 1 - crop.x) / crop.w), r4((y1 + 1 - crop.y) / crop.h)] };
      });
    },
  };
  window.__studio = api;
})();
