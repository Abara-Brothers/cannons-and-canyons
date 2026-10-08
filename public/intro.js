// THE COLD-START INTRO. Six seconds on a genuine launch: sealed bay doors
// power on, a work lamp finds the studio mark, the doors part on the game
// logo, the real Launch Bay rises behind it and the player's own tank drives
// in under the menu as it deals itself in.
//
// THE END IS THE MENU, NOT A PICTURE OF IT. Nothing here knows what the
// dashboard looks like. The scene (wall, backdrop, plinth) is revealed by this
// canvas fading away over it; the chrome (anything on .stage with a z-index)
// is discovered at runtime and dealt in from wherever it actually sits; and
// when it is over every inline style this file wrote is restored byte for
// byte. Change the dashboard and the intro follows it with no edit here.
//
// THE MENU REDRAWS ITSELF UNDER US. bay.js morphs home in place on cc:social,
// cc:squad and cc:account, re-asserting every attribute including style
// (bay.js:2985-3001), so a write here can be wiped at any moment, and on a slow
// socket that lands mid-reveal. A MutationObserver re-applies the intro's
// state in the same microtask, before paint, so a redraw never shows.
//
// LOADED AFTER app.js AND BEFORE bay.js (index.html): after, so the launch
// decision reuses boot's own answers (BOOT_CLAIM, REOPEN) and MOTION_OK rather
// than a second copy of that policy; before, so the doors are up before the
// menu is ever drawn and no frame of the dashboard can flash, and so bay.js
// can read which doors are up (CC_DOORS) before it draws.
//
// THE QUICK DOORS (owner, 2026-10-07). A launch that does not get the full
// intro but did start on the sealed doors (on iOS the launch image IS them)
// must not cut from them to the menu: they stay up until the destination is
// drawn underneath and then part in half a second onto it, or fade under
// reduced motion. That is a reopen within ten minutes of last use (app.js
// REOPEN, onto the screen the player left), a launch boot is taking somewhere
// (BOOT_CLAIM: a held seat's match, a link), reduced motion and a native
// sign-in return. The quick doors write nothing into the menu: they only
// cover it.
//
// Owner decisions and the acceptance criteria are recorded in the governance
// repo, docs/superpowers/specs/2026-10-02-cold-start-intro-design.md.
(function () {
  'use strict';

  const status = { state: 'off', reason: '', t: 0, tp: 0 };
  window.__ccIntro = status;                     // read by test/intro.mjs only

  // ---------------------------------------------------------------------------
  // The native launch hold. iOS keeps a copy of the launch image (the sealed
  // doors) over the web view until this is called, so the app opens straight
  // onto frame 0 instead of doors, flat dark, doors. Every path calls it once:
  // after frame 0 when the intro plays, after the menu's first paint when not.
  let launchReleased = false;
  function releaseLaunch() {
    if (launchReleased) return Promise.resolve();
    launchReleased = true;
    try {
      const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CCLaunch;
      if (p && typeof p.hide === 'function') return Promise.resolve(p.hide()).catch(function () {});
    } catch (e) {}
    return Promise.resolve();
  }
  function afterTwoFrames(fn) {
    try { requestAnimationFrame(function () { requestAnimationFrame(fn); }); } catch (e) { setTimeout(fn, 50); }
  }

  // ---------------------------------------------------------------------------
  // WHETHER TO PLAY, AND WHICH DOORS. Decided once, synchronously, before
  // bay.js has run: 'full' for the intro, 'quick' for the quick doors, '' for
  // neither.
  //   - Only a genuine launch: a sessionStorage marker survives "Back to menu",
  //     "Leave game", a refresh and the sign-in round trip (all page loads in
  //     the same tab) and is empty in a new tab or a freshly launched app. If
  //     storage cannot be used neither plays: a player must never be trapped
  //     in a repeat after every match.
  //   - The quick doors, never the intro, when boot is taking the player
  //     somewhere: a held seat, or a room or squad link boot is acting on.
  //     BOOT_CLAIM is boot's own expression.
  //   - The quick doors when the app was last in use under ten minutes ago
  //     (REOPEN, boot's own answer too): they open onto what the player left.
  //   - The quick doors, faded rather than parted, under reduced motion (the
  //     OS setting or the in-game toggle), as the killcam is not played.
  //   - The quick doors on a native sign-in return: the pending flag lives in
  //     localStorage there (cloud.js:81), and a sign-in finishing is somewhere
  //     to go.
  function decide() {
    if (window.__ccNoIntro) return '';
    let fresh = false;
    try {
      fresh = sessionStorage.getItem('cc_intro') === null;
      sessionStorage.setItem('cc_intro', '1');
    } catch (e) { return ''; }
    if (!fresh) return '';
    // typeof on a binding still in its TDZ throws, which is the case if app.js
    // died before declaring these. No app, no doors.
    let quick = false;
    try { if (typeof BOOT_CLAIM === 'undefined') return ''; if (BOOT_CLAIM) quick = true; } catch (e) { return ''; }
    try { if (typeof MOTION_OK === 'undefined') return ''; if (!MOTION_OK) quick = true; } catch (e) { return ''; }
    try { if (typeof REOPEN !== 'undefined' && REOPEN) quick = true; } catch (e) {}
    try {
      const cap = window.Capacitor;
      if (cap && cap.isNativePlatform && cap.isNativePlatform() && localStorage.getItem('cc_oauth_pending') === '1') quick = true;
    } catch (e) {}
    if (!document.getElementById('bay') || !document.getElementById('app')) return '';
    if (typeof Path2D === 'undefined' || typeof requestAnimationFrame !== 'function') return '';
    return quick ? 'quick' : 'full';
  }

  let mode = '';
  try { mode = decide(); } catch (e) { mode = ''; }
  // For bay.js, which puts a reopened screen back only under the quick doors.
  try { window.CC_DOORS = mode; } catch (e) {}
  if (!mode) {
    // Release the launch image once the menu has painted, not before: bay.js
    // has not run yet, and releasing now would show a frame of flat dark.
    afterTwoFrames(releaseLaunch);
    return;
  }
  const QUICK = mode === 'quick';
  let FADE = false;
  try { FADE = QUICK && !MOTION_OK; } catch (e) {}
  status.mode = mode; status.fade = FADE;

  // ---------------------------------------------------------------------------
  // ONE GUARD ROUND EVERY ENTRY POINT. Anything that throws ends the intro and
  // is reported once. An intro that breaks must cost the player nothing worse
  // than a skipped intro.
  let dead = false, reported = false;
  function report(e) {
    if (reported) return;
    reported = true;
    try {
      if (typeof window.reportError === 'function') window.reportError(e);
      else setTimeout(function () { throw e; });
    } catch (x) {}
  }
  function guard(fn) {
    return function () {
      if (dead) return undefined;
      try { return fn.apply(this, arguments); } catch (e) { report(e); end('error'); return undefined; }
    };
  }

  const W = 932, H = 430;
  const app = document.getElementById('app');
  const bay = document.getElementById('bay');

  // ---------------------------------------------------------------------------
  // THE TIMELINE (ms). t is visible time since the doors started moving; tp is
  // the same clock with any hold for a slow first load taken out, and drives
  // every beat after the reveal.
  const K = {
    dead: 270, rakeEnd: 1250, thunk: 1500, part: 1750,
    logoIn: 1300, doorGone: 3050,
    reveal: 2100,                         // the menu must be ready by here, or the logo holds
    envIn: 2300, envFull: 3000,           // the real bay rises behind the logo
    logoHold: 4200, logoOut: 4600,
    tankIn: 4250, tankArrive: 5300,       // it drives in; the arrival is the beat
    settled: 5650,                        // every motion term is below a tenth of a unit
    imgIn0: 5650, imgIn1: 5800,           // the menu's own tank, and its shadow, fade in over the intro's
    layerOut0: 5800, layerOut1: 5950,     // then the intro's layers fade away underneath it
    chromeIn: 4900, chromeEnd: 5880,      // the menu deals in, top to bottom
    gradeOut0: 5500, gradeOut1: 5950,     // the vignette goes, so the last frame IS the menu
    end: 6000
  };
  const HOLD_CEILING = 10000;             // visible ms the doors may wait for a slow menu

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function seg(t, a, b) { return clamp((t - a) / (b - a), 0, 1); }
  function eOut(x) { return 1 - Math.pow(1 - x, 3); }
  function eIn(x) { return x * x * x; }
  function eInOut(x) { return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function lerp(a, b, x) { return a + (b - a) * x; }
  function trapEase(p, e) {                // constant speed with soft ends, arriving at rest
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    const v = 1 / (1 - e);
    if (p < e) return v * p * p / (2 * e);
    if (p > 1 - e) { const q = (1 - p) / e; return 1 - v * e * q * q / 2; }
    return v * (p - e / 2);
  }
  function lcg(s0) { let s = s0 >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  // The lamp searches out to a little past centre, stops, and walks back onto
  // the mark from rest.
  function lampX(t) {
    if (t < K.dead) return -W * .30;
    const x = lerp(-W * .30, W * .55, trapEase(seg(t, K.dead, K.rakeEnd), .22));
    return lerp(x, W * .5, trapEase(seg(t, K.rakeEnd + 80, 1780), .35));
  }
  function lampPower(t) { return seg(t, 280, 430) * (1 - seg(t, 2050, 2750)); }
  function camScale(t) { return 1 + eOut(seg(t, 1650, 2650)) * .30 - eInOut(seg(t, 2750, 3800)) * .30; }
  function shake(t) {
    let s = 0;
    if (t > K.thunk && t < 1860) s = (1 - seg(t, K.thunk, 1860)) * 7;
    if (t > 2150 && t < 3050) s += 1.1 * (1 - seg(t, 2150, 3050));
    if (s <= 0) return [0, 0];
    return [Math.sin(t * .72) * s, Math.cos(t * .51) * s * .7];
  }

  // ---------------------------------------------------------------------------
  // THE OVERLAY. A canvas over the whole of #app, under #toast (z 90) so a boot
  // message still shows over the full intro; under the quick doors app.js
  // holds its toasts until they have gone (showToast), so none lands on the
  // launch image. Sized from its own client box, which is the logical box even
  // under the portrait rotation shim.
  const cv = document.createElement('canvas');
  cv.id = 'intro';
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'Cannons & Canyons. Tap to skip.');
  cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:89;display:block;touch-action:none';
  const ctx = cv.getContext('2d');
  // The killcam's own hint, in the killcam's own type (styles.css .kc-skip).
  const hint = document.createElement('div');
  hint.textContent = 'Tap to skip';
  hint.setAttribute('aria-hidden', 'true');
  hint.style.cssText = 'position:absolute;right:max(16px, var(--sa-r));bottom:max(14px, var(--sa-b));z-index:89;'
    + 'pointer-events:none;font:700 11px Barlow,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;'
    + 'color:rgba(234,240,255,.55);text-shadow:0 1px 3px rgba(0,0,0,.7);opacity:0;transition:opacity .45s ease';

  let dpr = 1, cw = 0, ch = 0, sizeKey = '';
  function fitBacking() {
    const w = cv.clientWidth, h = cv.clientHeight, d = Math.min(window.devicePixelRatio || 1, 2);
    const key = w + 'x' + h + '@' + d;
    if (key === sizeKey) return;
    sizeKey = key; cw = w; ch = h; dpr = d;
    cv.width = Math.max(1, Math.round(w * d));
    cv.height = Math.max(1, Math.round(h * d));
    doorSprites = null;
  }

  // ---------------------------------------------------------------------------
  // GEOMETRY. Everything is drawn in canvas-local CSS px. Client rects are
  // mapped into that space relative to the canvas's own rect, honouring the
  // rotation shim the way app.js does (--rotated, app.js:386-393).
  let rot = false, sx = 0, sy = 0, u = 1;
  function readRotated() {
    try { return getComputedStyle(document.documentElement).getPropertyValue('--rotated').trim() === '1'; } catch (e) { return false; }
  }
  function localRect(el) {
    const r = el.getBoundingClientRect(), c = cv.getBoundingClientRect();
    return rot ? { x: r.top - c.top, y: c.right - r.right, w: r.height, h: r.width }
               : { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
  }
  // Before bay.js has rendered, a probe .stage is inserted into the empty #bay,
  // measured and removed in the same task: it gets exactly the real stage's
  // CSS, so the doors are placed by the bay's own layout rules, not a copy.
  function probeStage() {
    if (bay.firstChild) return null;
    const p = document.createElement('div');
    p.className = 'stage';
    bay.appendChild(p);
    const r = localRect(p);
    bay.removeChild(p);
    if (mo) mo.takeRecords();
    return r;
  }
  function stageNode() {
    const st = bay.querySelector('.stage');
    return st && st.isConnected ? st : null;
  }
  function measure() {
    fitBacking();
    rot = readRotated();
    const st = stageNode();
    let r = st ? localRect(st) : probeStage();
    if (!r || r.w < 10) {
      const k = Math.min(cw / W, ch / H) || 1;
      r = { x: (cw - W * k) / 2, y: (ch - H * k) / 2, w: W * k, h: H * k };
    }
    sx = r.x; sy = r.y; u = r.w / W;
  }
  function toStage() { ctx.setTransform(dpr * u, 0, 0, dpr * u, dpr * sx, dpr * sy); }
  function toOverlay() { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }

  // ---------------------------------------------------------------------------
  // THE DOORS, in launch-image space. The iOS launch image is this texture
  // rendered on a 2732 square, shown aspect-fill: centred, scaled from the
  // screen's long side. So the texture here is laid out the same way, a square
  // of side S (the long side) centred on the seam and the overlay's middle,
  // and frame 0 is the launch image on every device. Its central 932x430 band
  // reproduces the reviewed doors exactly. The seam is the stage centre, where
  // the logo stands; on iOS that is also the screen centre.
  let doorSprites = null;
  const BLEED = 16;                       // px past every edge, for the door-slam shake
  function doorGeom() {
    const S = Math.max(cw, ch), d = S / W;
    const seam = sx + (W / 2) * u;
    return { S: S, d: d, seam: seam, ox: seam - S / 2, oy: ch / 2 - S / 2 };
  }
  function drawDoorFace(q, x0, wide, side) {   // square units: 0..932 across and down
    const g = q.createLinearGradient(x0, 0, x0 + wide, 0);
    g.addColorStop(0, '#0C1017'); g.addColorStop(.36, '#171D29'); g.addColorStop(.5, '#1F2734');
    g.addColorStop(.72, '#161C27'); g.addColorStop(1, '#0A0E15');
    q.fillStyle = g; q.fillRect(x0, 0, wide, W);
    const band = (W - H) / 2;               // the reviewed frame's top, inside the square
    const step = H * .135;
    function rows(first) { const out = []; let y = first - step * Math.ceil(first / step); for (; y < W; y += step) if (y >= 0) out.push(y); return out; }
    const lines = rows(band + H * .12), rivets = rows(band + H * .06);
    q.strokeStyle = 'rgba(0,0,0,.42)'; q.lineWidth = 1.6;
    lines.forEach(function (y) { q.beginPath(); q.moveTo(x0, y); q.lineTo(x0 + wide, y); q.stroke(); });
    q.strokeStyle = 'rgba(150,175,215,.06)'; q.lineWidth = .8;
    lines.forEach(function (y) { q.beginPath(); q.moveTo(x0, y + 1.6); q.lineTo(x0 + wide, y + 1.6); q.stroke(); });
    q.strokeStyle = 'rgba(0,0,0,.3)'; q.lineWidth = 1.1;
    for (let v = 1; v < 4; v++) { const px = x0 + wide * v / 4; q.beginPath(); q.moveTo(px, 0); q.lineTo(px, W); q.stroke(); }
    q.fillStyle = 'rgba(150,170,205,.13)';
    rivets.forEach(function (ry) {
      for (let rx = 1; rx < 5; rx++) { q.beginPath(); q.arc(x0 + wide * rx / 5, ry, 1.8, 0, 6.283); q.fill(); }
    });
    const hx = side < 0 ? x0 : x0 + wide - 19;
    q.save(); q.beginPath(); q.rect(hx, 0, 19, W); q.clip(); q.globalAlpha = .4; q.fillStyle = '#A8781A';
    for (let s = -W; s < W * 2; s += 26) { q.beginPath(); q.moveTo(hx, s); q.lineTo(hx + 19, s - 19); q.lineTo(hx + 19, s); q.lineTo(hx, s + 19); q.closePath(); q.fill(); }
    q.restore();
    q.fillStyle = 'rgba(140,164,200,.18)'; q.fillRect(side < 0 ? x0 + wide - 1.2 : x0, 0, 1.2, W);
  }
  // Each half is baked once per overlay size, cropped to what the screen can
  // show plus the bleed, and blitted every frame: a large gradient rebuilt
  // every frame rasterises slightly differently from one frame to the next.
  function bakeDoor(side) {
    const g = doorGeom();
    const x0 = side < 0 ? -BLEED : g.seam, x1 = side < 0 ? g.seam : cw + BLEED;
    const y0 = -BLEED, y1 = ch + BLEED;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((x1 - x0) * dpr));
    c.height = Math.max(1, Math.ceil((y1 - y0) * dpr));
    const q = c.getContext('2d');
    q.setTransform(dpr, 0, 0, dpr, -x0 * dpr, -y0 * dpr);
    q.fillStyle = side < 0 ? '#0C1017' : '#0A0E15';   // past the square: the door's own edge colour
    q.fillRect(x0, y0, x1 - x0, y1 - y0);
    q.translate(g.ox, g.oy); q.scale(g.d, g.d);
    drawDoorFace(q, side < 0 ? 0 : W / 2, W / 2, side);
    // Blitted at the bitmap's true size: the ceil above pads a fraction of a
    // pixel (transparent, past the bleed or the seam), and squeezing it back
    // into x1 - x0 would shrink the face by up to a pixel toward its far edge,
    // a drift the iOS launch image (rendered where the sizes are whole) lacks.
    return { cv: c, x: x0, y: y0, w: c.width / dpr, h: c.height / dpr };
  }
  function doorSprite(side) {
    if (!doorSprites) doorSprites = { L: bakeDoor(-1), R: bakeDoor(1) };
    return side < 0 ? doorSprites.L : doorSprites.R;
  }
  // Drawn under the stage + camera transform, so convert its px box to stage units.
  function paintDoorHalf(side) {
    const sp = doorSprite(side);
    ctx.drawImage(sp.cv, (sp.x - sx) / u, (sp.y - sy) / u, sp.w / u, sp.h / u);
  }
  // The doors must clear the screen whatever its shape: at least as far as the
  // reviewed 1.16 x 52% of the frame, and always past the farther edge.
  function doorShift(t) {
    const g = doorGeom();
    const need = Math.max(g.seam, cw - g.seam) / u + 30;
    return Math.min(eInOut(seg(t, K.part, 2900)) * 1.16, 1.16) * Math.max(W * .52, need / 1.16);
  }

  // ---------------------------------------------------------------------------
  // THE INTERIOR AND THE GRADE, in overlay space so the letterbox matches.
  function paintInterior() {
    const g = ctx.createRadialGradient(sx + W / 2 * u, sy + H * .56 * u, 6 * u, sx + W / 2 * u, sy + H * .56 * u, W * .72 * u);
    g.addColorStop(0, '#0C1019'); g.addColorStop(.34, '#080C13'); g.addColorStop(1, '#03050A');
    ctx.fillStyle = g; ctx.fillRect(-BLEED, -BLEED, cw + 2 * BLEED, ch + 2 * BLEED);
  }
  const grain = document.createElement('canvas');
  grain.width = grain.height = 128;
  (function () {
    const g2 = grain.getContext('2d'), im = g2.createImageData(128, 128), gr = lcg(7);
    for (let i = 0; i < im.data.length; i += 4) { const n = Math.floor(gr() * 255); im.data[i] = im.data[i + 1] = im.data[i + 2] = n; im.data[i + 3] = 30; }
    g2.putImageData(im, 0, 0);
  })();
  function paintGrade(t, fade) {
    const S = Math.max(cw, ch), d = S / W;
    const v = ctx.createRadialGradient(cw / 2, ch / 2, H * .3 * d, cw / 2, ch / 2, W * .66 * d);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,' + (.62 * fade) + ')');
    ctx.fillStyle = v; ctx.fillRect(0, 0, cw, ch);
    ctx.save(); ctx.globalAlpha = .035 * fade; ctx.globalCompositeOperation = 'lighter';
    const tile = 128 * d;
    const ox = ((Math.floor(t / 42) * 67) % 128) * d, oy = ((Math.floor(t / 42) * 113) % 128) * d;
    for (let gx = -ox; gx < cw; gx += tile) for (let gy = -oy; gy < ch; gy += tile) ctx.drawImage(grain, gx, gy, tile, tile);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // THE BEACONS: the real product seen from above, baked into three sprites
  // (the throw, the body, the glow in the lens) and stamped. Everything that
  // changes only rotates about the unit's own centre.
  const SPIN = .00440, SPIN_DOWN = 2300, SPIN_STOP = 3050;
  function beaconAngle(t) {
    if (t <= SPIN_DOWN) return SPIN * t;
    const T = SPIN_STOP - SPIN_DOWN, dd = Math.min(t, SPIN_STOP) - SPIN_DOWN;
    return SPIN * (SPIN_DOWN + dd - dd * dd / (2 * T));
  }
  const BR = 22, BEAM_L = 214;
  let BEACON_SPR = null;
  function drawBeaconBeam(q) {
    const LR = BR * .74, L = BEAM_L;
    q.globalCompositeOperation = 'lighter';
    const wg = q.createRadialGradient(0, 0, LR * .7, 0, 0, L);
    wg.addColorStop(0, 'rgba(240,154,50,.036)'); wg.addColorStop(.30, 'rgba(226,132,30,.021)');
    wg.addColorStop(.66, 'rgba(212,116,22,.010)'); wg.addColorStop(1, 'rgba(200,108,16,0)');
    q.fillStyle = wg;
    for (let s2 = 0; s2 < 2; s2++) {
      const base = s2 * Math.PI;
      for (let b = 0; b < 17; b++) {
        const uu = (b / 16) * 2 - 1, sh = uu > 0 ? uu * 1.7 : uu * .82, w = Math.exp(-sh * sh * 2.1);
        if (w < .015) continue;
        q.globalAlpha = w * (s2 ? .58 : 1);
        const a0 = base + uu * .76;
        q.beginPath(); q.moveTo(0, 0); q.arc(0, 0, L * (.64 + .36 * w), a0 - .29, a0 + .29); q.closePath(); q.fill();
      }
    }
    q.globalAlpha = 1;
    const ng = q.createRadialGradient(0, 0, LR * .4, 0, 0, BR * 2.7);
    ng.addColorStop(0, 'rgba(242,156,54,.17)'); ng.addColorStop(.45, 'rgba(230,138,38,.062)'); ng.addColorStop(1, 'rgba(218,126,30,0)');
    q.fillStyle = ng; q.beginPath(); q.arc(0, 0, BR * 2.7, 0, 6.283); q.fill();
  }
  function drawBeaconBody(q) {
    const LR = BR * .74, CR = LR * .80;
    const cs = q.createRadialGradient(0, BR * .2, BR * .55, 0, BR * .2, BR * 1.4);
    cs.addColorStop(0, 'rgba(0,0,0,.44)'); cs.addColorStop(1, 'rgba(0,0,0,0)');
    q.fillStyle = cs; q.beginPath(); q.arc(0, BR * .2, BR * 1.4, 0, 6.283); q.fill();
    const bg = q.createRadialGradient(-BR * .34, -BR * .36, 1, 0, 0, BR);
    bg.addColorStop(0, '#36383E'); bg.addColorStop(.55, '#1A1C21'); bg.addColorStop(.9, '#0B0C0F'); bg.addColorStop(1, '#191B20');
    q.fillStyle = bg; q.beginPath(); q.arc(0, 0, BR, 0, 6.283); q.fill();
    q.strokeStyle = 'rgba(172,184,206,.22)'; q.lineWidth = 1;
    q.beginPath(); q.arc(0, 0, BR - .7, 0, 6.283); q.stroke();
    q.fillStyle = 'rgba(10,11,14,.85)';
    for (let k = 0; k < 4; k++) {
      const qa = k * 1.5708 + .785;
      q.beginPath(); q.arc(Math.cos(qa) * BR * .87, Math.sin(qa) * BR * .87, BR * .075, 0, 6.283); q.fill();
    }
    const lg = q.createRadialGradient(-LR * .3, -LR * .34, 1, 0, 0, LR);
    lg.addColorStop(0, '#EE8C21'); lg.addColorStop(.55, '#D5710D'); lg.addColorStop(1, '#A85304');
    q.fillStyle = lg; q.beginPath(); q.arc(0, 0, LR, 0, 6.283); q.fill();
    q.save(); q.strokeStyle = 'rgba(112,52,4,.6)'; q.lineWidth = 1;
    for (let i2 = 0; i2 < 34; i2++) {
      const a2 = i2 / 34 * 6.283;
      q.beginPath(); q.moveTo(Math.cos(a2) * LR, Math.sin(a2) * LR); q.lineTo(Math.cos(a2) * CR, Math.sin(a2) * CR); q.stroke();
    }
    q.restore();
    const tg = q.createRadialGradient(-CR * .3, -CR * .34, 1, 0, 0, CR);
    tg.addColorStop(0, '#F79B30'); tg.addColorStop(.6, '#E47C11'); tg.addColorStop(1, '#C36009');
    q.fillStyle = tg; q.beginPath(); q.arc(0, 0, CR, 0, 6.283); q.fill();
    q.strokeStyle = 'rgba(108,50,4,.55)'; q.lineWidth = 1;
    q.beginPath(); q.arc(0, 0, CR, 0, 6.283); q.stroke();
    q.save(); q.globalCompositeOperation = 'lighter';
    q.strokeStyle = 'rgba(255,212,150,.20)'; q.lineWidth = 1.6;
    q.beginPath(); q.arc(0, 0, CR - 1, Math.PI * 1.02, Math.PI * 1.72); q.stroke();
    q.fillStyle = 'rgba(255,234,196,.15)';
    q.beginPath(); q.ellipse(-CR * .33, -CR * .36, CR * .30, CR * .15, -.7, 0, 6.283); q.fill();
    q.restore();
  }
  function drawBeaconGlow(q) {
    const LR = BR * .74, CR = LR * .80;
    q.globalCompositeOperation = 'lighter';
    q.lineWidth = (LR - CR) * 1.15;
    for (let f = 0; f < 2; f++) {
      const fa = f * Math.PI;
      q.strokeStyle = 'rgba(255,198,112,' + (f ? .15 : .26) + ')';
      q.beginPath(); q.arc(0, 0, (LR + CR) / 2, fa - .54, fa + .54); q.stroke();
    }
    const sg = q.createRadialGradient(0, 0, 1, 0, 0, LR);
    sg.addColorStop(0, 'rgba(255,200,112,.055)'); sg.addColorStop(1, 'rgba(255,170,56,.17)');
    q.fillStyle = sg;
    for (let s3 = 0; s3 < 2; s3++) {
      for (let r = 0; r < 9; r++) {
        const ru = (r / 8) * 2 - 1;
        q.globalAlpha = Math.exp(-ru * ru * 1.7) * (s3 ? .55 : 1);
        const ra = s3 * Math.PI + ru * .40;
        q.beginPath(); q.moveTo(0, 0); q.arc(0, 0, LR, ra - .31, ra + .31); q.closePath(); q.fill();
      }
    }
    q.globalAlpha = 1;
  }
  function beaconSprites() {
    if (BEACON_SPR) return BEACON_SPR;
    function mk(rad, draw) {
      const c = document.createElement('canvas');
      c.width = c.height = Math.ceil(rad * 2 * 2);
      const q = c.getContext('2d');
      q.setTransform(2, 0, 0, 2, 0, 0); q.translate(rad, rad);
      draw(q);
      return { cv: c, rad: rad, size: c.width / 2 };   // true size: ceil pads, never squeeze
    }
    BEACON_SPR = { beam: mk(BEAM_L + 3, drawBeaconBeam), body: mk(BR * 1.7, drawBeaconBody), glow: mk(BR * .8, drawBeaconGlow) };
    return BEACON_SPR;
  }
  function stampBeacon(sp, x, y, th, comp, alpha) {
    ctx.save();
    if (comp) ctx.globalCompositeOperation = comp;
    ctx.globalAlpha = alpha;
    ctx.translate(x, y); if (th) ctx.rotate(th);
    ctx.drawImage(sp.cv, -sp.rad, -sp.rad, sp.size, sp.size);
    ctx.restore();
  }
  function paintBeacon(x, y, t, phase, alpha) {
    if (alpha <= .002) return;
    const th = beaconAngle(t) + phase, S2 = beaconSprites();
    stampBeacon(S2.beam, x, y, th, 'lighter', alpha);
    stampBeacon(S2.body, x, y, 0, null, alpha);
    stampBeacon(S2.glow, x, y, th, 'lighter', alpha);
  }

  // ---------------------------------------------------------------------------
  // THE LAMP: a pool, stretched while it rakes and rounding up as it lands on
  // the mark. The falloff is baked once and stamped.
  const POOL_R = W * .198;
  function lampPool(t, lx) {
    const off = Math.min(1, Math.abs(lx - W / 2) / (W * .52));
    const settle = trapEase(seg(t, K.rakeEnd + 80, 1780), .35);
    return { x: lx, y: lerp(H * .60, H * .525, settle), rx: POOL_R * (1 + .85 * off), ry: POOL_R * (1 + .12 * off),
      rot: (lx < W / 2 ? 1 : -1) * off * .12 };
  }
  function poolStops(g, a, c0, c1) {
    g.addColorStop(0, 'rgba(' + c0 + ',' + a.toFixed(4) + ')');
    g.addColorStop(.46, 'rgba(' + c0 + ',' + (a * .94).toFixed(4) + ')');
    g.addColorStop(.64, 'rgba(' + c1 + ',' + (a * .74).toFixed(4) + ')');
    g.addColorStop(.79, 'rgba(' + c1 + ',' + (a * .26).toFixed(4) + ')');
    g.addColorStop(.90, 'rgba(' + c1 + ',' + (a * .08).toFixed(4) + ')');
    g.addColorStop(1, 'rgba(' + c1 + ',0)');
  }
  const POOL_SPRITE = {};
  function poolSprite(key, c0, c1) {
    if (POOL_SPRITE[key]) return POOL_SPRITE[key];
    const R = 256, c = document.createElement('canvas');
    c.width = c.height = R * 2;
    const q = c.getContext('2d'), g = q.createRadialGradient(R, R, 0, R, R, R);
    poolStops(g, 1, c0, c1);
    q.fillStyle = g; q.beginPath(); q.arc(R, R, R, 0, 6.283); q.fill();
    POOL_SPRITE[key] = c;
    return c;
  }
  function stampPool(q, p, alpha, sprite) {
    q.save(); q.globalAlpha = alpha; q.translate(p.x, p.y); q.rotate(p.rot);
    q.drawImage(sprite, -p.rx, -p.ry, p.rx * 2, p.ry * 2);
    q.restore();
  }
  function paintPool(t, lx, power, alpha) {
    if (power < .02 || alpha <= .002) return;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    stampPool(ctx, lampPool(t, lx), .40 * power * alpha, poolSprite('lit', '214,230,255', '150,178,220'));
    ctx.restore();
  }
  function paintBeam(t, lx, power) {
    if (power < .02) return;
    const p = lampPool(t, lx), ox = lx * .40 + W * .30, oy = -H * .46, land = p.y + p.ry * .62;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 13; i >= 1; i--) {
      const f = i / 13, wdt = p.rx * .58 * f, a = (.012 * (1 - f) + .0035) * power;
      const g = ctx.createLinearGradient(0, oy, 0, land);
      g.addColorStop(0, 'rgba(162,188,228,' + (a * 1.5) + ')');
      g.addColorStop(.52, 'rgba(142,170,214,' + a + ')');
      g.addColorStop(1, 'rgba(126,156,200,0)');
      ctx.fillStyle = g; ctx.beginPath();
      ctx.moveTo(ox - 7, oy); ctx.lineTo(ox + 7, oy); ctx.lineTo(p.x + wdt, land); ctx.lineTo(p.x - wdt, land);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  const rnd = lcg(90210), MOTES = [], FALL = [];
  for (let i = 0; i < 190; i++) MOTES.push({ x: rnd() * W, y: rnd() * H, z: .35 + rnd() * .9, r: (.5 + rnd() * 1.5) * .55,
    vx: (rnd() - .5) * 6, vy: -2 - rnd() * 6, ph: rnd() * 6.283, sp: .5 + rnd() * 1.6 });
  for (let k = 0; k < 60; k++) FALL.push({ x: rnd() * W, tb: 1520 + rnd() * 170, v: 150 + rnd() * 320, r: .5 + rnd() * 1.1, sway: rnd() * 6.283 });
  function paintMotes(t, lx, power) {
    if (power < .02) return;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const dd = t * .001;
    for (let i = 0; i < MOTES.length; i++) {
      const m = MOTES[i];
      const x = ((m.x + m.vx * dd * 12 + Math.sin(dd * m.sp + m.ph) * 15) % W + W) % W;
      const y = ((m.y + m.vy * dd * 12) % H + H) % H;
      const q = Math.abs(x - lx) / (W * .19), lit = Math.max(0, 1 - q * q) * power * m.z;
      if (lit < .015) continue;
      ctx.fillStyle = 'rgba(198,216,242,' + (lit * .55 * (.65 + .35 * Math.sin(t * .006 * m.sp + m.ph))) + ')';
      ctx.beginPath(); ctx.arc(x, y, m.r * m.z, 0, 6.283); ctx.fill();
    }
    ctx.restore();
  }
  function paintFall(t) {
    for (let i = 0; i < FALL.length; i++) {
      const f = FALL[i], age = t - f.tb;
      if (age < 0 || age > 1200) continue;
      const s = age / 1000, y = H * .05 + f.v * s + 420 * s * s;
      if (y > H) continue;
      ctx.fillStyle = 'rgba(178,194,222,' + (.34 * (1 - age / 1200)) + ')';
      ctx.beginPath(); ctx.arc(f.x + Math.sin(s * 2 + f.sway) * 5, y, f.r, 0, 6.283); ctx.fill();
    }
  }

  // ---------------------------------------------------------------------------
  // THE STUDIO MARK, assembled off screen on one pixel grid: ambient shadow,
  // the cast shadow the pool throws, the unlit metal, then the lit metal through
  // the pool's own mask. Every pass is the same rasterisation, so the letters
  // cannot drift against each other as the light crosses them.
  const pTri = new Path2D('M 0,0 H 145 L 72.5,113 Z');
  const pAbara = new Path2D('M 50,3.6 L 96.4,96.4 L 3.6,96.4 Z M 142.6 3.6H 213A 14.4 14.4 0 0 1 227.4 18V 35.6A 14.4 14.4 0 0 1 213 50H 142.6M 142.6 50H 213A 14.4 14.4 0 0 1 227.4 64.4V 82A 14.4 14.4 0 0 1 213 96.4H 142.6M 142.6 3.6V 96.4 M 320 3.6L 366.4 96.4L 273.6 96.4Z M 412.6 3.6H 491A 14.4 14.4 0 0 1 505.4 18V 33.6A 14.4 14.4 0 0 1 491 48H 412.6M 425 48L 505.4 96.4M 412.6 3.6V 96.4 M 598 3.6L 644.4 96.4L 551.6 96.4Z');
  const pBros = new Path2D('M 3.6,3.6 H 74 A 14.4,14.4 0 0 1 88.4,18 V 35.6 A 14.4,14.4 0 0 1 74,50 H 3.6 M 3.6,50 H 74 A 14.4,14.4 0 0 1 88.4,64.4 V 82 A 14.4,14.4 0 0 1 74,96.4 H 3.6 M 3.6,3.6 V 96.4 M 248.6 3.6H 327A 14.4 14.4 0 0 1 341.4 18V 33.6A 14.4 14.4 0 0 1 327 48H 248.6M 261 48L 341.4 96.4M 248.6 3.6V 96.4 M 533.6 3.6H 562.4A 32 32 0 0 1 594.4 35.6V 64.4A 32 32 0 0 1 562.4 96.4H 533.6A 32 32 0 0 1 501.6 64.4V 35.6A 32 32 0 0 1 533.6 3.6Z M 754.6 3.6H 839.4M 797 3.6V 96.4 M 999.6 3.6V 96.4M 1088.4 3.6V 96.4M 999.6 50H 1088.4 M 1325.4 3.6H 1248.6V 96.4H 1325.4M 1248.6 50H 1311 M 1485.6 3.6H 1564A 14.4 14.4 0 0 1 1578.4 18V 33.6A 14.4 14.4 0 0 1 1564 48H 1485.6M 1498 48L 1578.4 96.4M 1485.6 3.6V 96.4 M 1823.4 20A 16.4 16.4 0 0 0 1807 3.6H 1755A 16.4 16.4 0 0 0 1738.6 20V 33.6A 16.4 16.4 0 0 0 1755 50H 1807A 16.4 16.4 0 0 1 1823.4 66.4V 80A 16.4 16.4 0 0 1 1807 96.4H 1755A 16.4 16.4 0 0 1 1738.6 80');
  const LW = 735, LH = 398;
  const LS = (W * 0.50) / LW, LX = (W - LW * LS) / 2, LY = H * 0.46 - (LH * LS) / 2;
  function drawMarkInk(q, stroke, fill, ox, oy) {
    q.save(); q.translate(ox, oy);
    q.strokeStyle = stroke; q.lineJoin = 'round';
    q.save(); q.translate(3.5, 143); q.lineWidth = 7.2; q.stroke(pAbara); q.restore();
    q.save(); q.translate(.467, 282); q.scale(.358, .358); q.lineWidth = 12; q.stroke(pBros); q.restore();
    q.save(); q.translate(255, 0); q.fillStyle = fill; q.fill(pTri); q.restore();
    q.restore();
  }
  const MARK_SS = 3, MK = [null, null], MKX = [null, null];
  let markW = 0, markH = 0;
  function markCtx(n) {
    if (!MK[n]) {
      markW = Math.ceil(LW * LS * MARK_SS); markH = Math.ceil(LH * LS * MARK_SS);
      MK[n] = document.createElement('canvas'); MK[n].width = markW; MK[n].height = markH;
      MKX[n] = MK[n].getContext('2d');
    }
    return MKX[n];
  }
  function mkClear(q) { q.setTransform(1, 0, 0, 1, 0, 0); q.clearRect(0, 0, markW, markH); q.globalAlpha = 1; q.globalCompositeOperation = 'source-over'; }
  function mkLocal(q) { q.setTransform(MARK_SS * LS, 0, 0, MARK_SS * LS, 0, 0); q.translate(40, 40); }
  function mkStage(q) { q.setTransform(MARK_SS, 0, 0, MARK_SS, 0, 0); q.translate(-LX, -LY); }
  function mkMasked(A, p, alpha, stroke, fill, ox, oy, shrink, comp) {
    const B = markCtx(1);
    mkClear(B); mkLocal(B);
    drawMarkInk(B, stroke, fill, ox, oy);
    mkStage(B);
    B.globalCompositeOperation = 'destination-in';
    const q = shrink === 1 ? p : { x: p.x, y: p.y, rx: p.rx * shrink, ry: p.ry * shrink, rot: p.rot };
    stampPool(B, q, Math.min(1, alpha), poolSprite('mask', '255,255,255', '255,255,255'));
    A.setTransform(1, 0, 0, 1, 0, 0); A.globalAlpha = 1; A.globalCompositeOperation = comp;
    A.drawImage(MK[1], 0, 0);
  }
  function buildMark(t, lx, power) {
    const A = markCtx(0), p = lampPool(t, lx);
    mkClear(A);
    mkLocal(A);
    drawMarkInk(A, 'rgba(0,0,0,.30)', 'rgba(0,0,0,.30)', 0, 2.8);
    if (power > .02) {
      const localL = (lx - LX) / LS - 40, away = clamp((LW / 2 - localL) / (LW * .62), -1, 1);
      mkMasked(A, p, .84 * power, 'rgba(0,0,0,1)', 'rgba(0,0,0,1)', away * 5.6, 4.4, 1, 'source-over');
    }
    mkLocal(A); A.globalCompositeOperation = 'source-over'; A.globalAlpha = 1;
    drawMarkInk(A, 'rgba(104,119,148,.60)', 'rgba(78,20,24,1)', 0, 0);
    if (power > .02) {
      mkMasked(A, p, .40 * power, 'rgb(150,172,208)', 'rgb(96,26,26)', 0, 0, 1, 'lighter');
      mkMasked(A, p, .30 * power, 'rgb(214,230,255)', 'rgb(104,30,28)', 0, 0, .54, 'lighter');
    }
    return MK[0];
  }
  function markPaths(t, lx, power, alpha) {
    if (alpha <= .002) return;
    const m = buildMark(t, lx, power);
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.drawImage(m, LX, LY, markW / MARK_SS, markH / MARK_SS);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // WHERE THE MENU PUTS THINGS, measured from the live DOM every frame, in
  // stage units. The tank's rest box excludes the bay's own idle bob.
  function rectStage(el) {
    const r = localRect(el);
    return { x: (r.x - sx) / u, y: (r.y - sy) / u, w: r.w / u, h: r.h / u };
  }
  function bobOffset(el) {                // the translate a CSS animation has applied
    try {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return rot ? { x: m.f, y: -m.e } : { x: m.e, y: m.f };
    } catch (e) { return { x: 0, y: 0 }; }
  }
  let slot = null, apBox = null;          // refreshed each frame by readMenuGeometry()
  function readMenuGeometry(tw, img) {
    if (!tw || !img) return;
    const r = rectStage(img), b = bobOffset(tw);
    // The slot is the tank's frame, which the image overhangs above and to
    // the right by the pad that holds the gun (TANK_FRAME).
    slot = { x: r.x - b.x / u, y: r.y + r.h * TANK_FRAME.y - b.y / u, w: r.w * TANK_FRAME.w, h: r.h * TANK_FRAME.h };
    slot.cx = slot.x + slot.w / 2; slot.cy = slot.y + slot.h / 2;
    const ap = bay.querySelector('.stage .ap');
    apBox = ap ? rectStage(ap) : null;
  }
  // Until bay.js has drawn home (a few ms on a cached launch, longer on a slow
  // first visit) there is nothing to measure; these are the home layout as
  // measured on 2026-10-02 and are never used once the menu exists.
  function tankSlot() {
    if (slot) return slot;
    return { x: 364, y: 143, w: 204, h: 167, cx: 466, cy: 226.5 };
  }
  function panelLeft() { return apBox && apBox.w > 40 ? apBox.x : 230; }

  // ---------------------------------------------------------------------------
  // THE GAME LOGO, standing in the tank's slot behind the doors.
  let fontsOk = false;
  try {
    if (document.fonts && document.fonts.load) {
      Promise.all(['700 40px Rajdhani', '500 20px Barlow', '600 20px Barlow', '700 20px Barlow', '500 20px "JetBrains Mono"']
        .map(function (f) { return document.fonts.load(f); }))
        .then(function () { fontsOk = true; }, function () { fontsOk = true; });
    } else fontsOk = true;
  } catch (e) { fontsOk = true; }
  function logoFace() {
    try { if (document.fonts && document.fonts.check('700 40px Rajdhani')) return 'Rajdhani, sans-serif'; } catch (e) {}
    return 'Barlow, system-ui, sans-serif';
  }
  function paintGameLogo(t, tp) {
    const a = seg(t, K.logoIn, K.logoIn + 400) * (1 - seg(tp, K.logoHold, K.logoOut));
    if (a <= .01) return;
    const s = tankSlot();
    const e = eOut(seg(t, K.logoIn, K.logoIn + 750));
    const bob = Math.sin((t - K.logoIn) * .0030) * 2.2;
    const leave = eIn(seg(tp, K.logoHold, K.logoOut));
    const cy = s.cy + bob + (1 - e) * 10 + leave * 12;
    const scale = lerp(1.04, 1, e) * (1 - leave * .06);
    const face = logoFace();
    const bgw = apBox && apBox.w > 40 ? apBox.w : 472, bgh = apBox && apBox.h > 40 ? apBox.h : 200;
    ctx.save();
    ctx.font = '700 100px ' + face;
    const widest = Math.max(ctx.measureText('CANNONS').width, ctx.measureText('CANYONS').width) + 100 * .06 * 7;
    const size = clamp(Math.min(100 * (bgw * .84) / widest, (bgh * .80) / 2.25), 20, 96);
    ctx.restore();
    ctx.save(); ctx.globalAlpha = a;
    const shA = .46 * e * (1 - leave);
    if (shA > .01) {
      ctx.save();
      ctx.translate(s.cx, s.cy + s.h * .46); ctx.scale(1, .2);
      const sh = ctx.createRadialGradient(0, 0, 2, 0, 0, s.w * .7);
      sh.addColorStop(0, 'rgba(0,0,0,' + shA + ')'); sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(0, 0, s.w * .7, 0, 6.283); ctx.fill();
      ctx.restore();
    }
    ctx.translate(s.cx, cy); ctx.scale(scale, scale);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tr = size * .06;
    function line(str, yy, col, sz) {
      ctx.font = '700 ' + sz + 'px ' + face;
      let total = 0, i;
      for (i = 0; i < str.length; i++) total += ctx.measureText(str[i]).width + tr;
      let x = -total / 2;
      ctx.fillStyle = col;
      for (i = 0; i < str.length; i++) {
        const cwid = ctx.measureText(str[i]).width + tr;
        ctx.fillText(str[i], x + cwid / 2 - tr / 2, yy); x += cwid;
      }
    }
    line('CANNONS', -size * .62, '#DCE5F5', size);
    line('&', 0, '#E0A468', size * .40);
    line('CANYONS', size * .62, '#DCE5F5', size);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // THE TANK'S APPROACH. It drives in from behind the backdrop's left edge
  // under its own power: a steady cruise, then a constant brake to a stop on
  // the mark. The suspension is stiff enough that the rebound is seen and the
  // hull is fully at rest before the menu's own tank takes over.
  const CRUISE = .58, V0 = 2 / (1 + CRUISE);
  function driveDist(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    if (p <= CRUISE) return V0 * p;
    const q = (p - CRUISE) / (1 - CRUISE);
    return V0 * CRUISE + V0 * (1 - CRUISE) * (q - q * q / 2);
  }
  function driveSpeed(p) { if (p <= 0 || p >= 1) return 0; return p <= CRUISE ? 1 : 1 - (p - CRUISE) / (1 - CRUISE); }
  function brakeQ(tp) { const p = seg(tp, K.tankIn, K.tankArrive); return p <= CRUISE ? -1 : (p - CRUISE) / (1 - CRUISE); }
  // From just behind the backdrop's left edge: the hull's right edge starts on it.
  function driveIn() { const s = tankSlot(); return -(s.x + s.w - panelLeft()); }
  function idleGate(tp) { return 1 - seg(tp, K.tankArrive + 150, K.tankArrive + 300); }
  function tankDriveX(tp) {
    let x = driveIn() * (1 - driveDist(seg(tp, K.tankIn, K.tankArrive)));
    const q = brakeQ(tp);
    if (q > 0 && q < 1) x += Math.sin(tp / 12.5) * 1.15 * Math.min(1, q * 4) * (1 - q);   // brake judder
    const since = tp - K.tankArrive;
    if (since >= 0) x += -4.2 * Math.exp(-since / 75) * Math.sin(since / 55);             // rocks back off the brakes
    return x;
  }
  const DIVE = 2.4;
  function tankPitch(tp) {
    const since = tp - K.tankArrive;
    if (since < 0) { const q = brakeQ(tp); return q <= 0 ? 0 : DIVE * Math.min(1, q * 3.2); }
    return DIVE * Math.exp(-since / 75) * Math.cos(since / 55);
  }
  function tankChatter(tp) {
    const sp = driveSpeed(seg(tp, K.tankIn, K.tankArrive));
    return sp <= 0 ? 0 : (Math.sin(tp / 31) * .8 + Math.sin(tp / 17) * .45) * sp;
  }
  function tankSquat(tp) { return Math.max(0, tankPitch(tp)) / DIVE * 1.1; }
  function tankIdle(tp) { return tp < K.tankIn ? 0 : (Math.sin(tp / 10.5) * .3 + Math.sin(tp / 27) * .16) * idleGate(tp); }
  function tankRoll(tp) {
    const sp = driveSpeed(seg(tp, K.tankIn, K.tankArrive));
    return (sp > 0 ? Math.sin(tp / 23) * .28 * sp : 0) + (tp >= K.tankIn ? Math.sin(tp / 9.3) * .055 * idleGate(tp) : 0);
  }
  const BARREL_MAX = 1.25;
  function barrelRel(tp) {
    if (tp < K.tankIn) return 0;
    let r = -.45 * tankPitch(tp);
    const since = tp - K.tankArrive;
    if (since >= 0) r += .85 * Math.exp(-since / 85) * Math.sin(since / 70);
    const sp = driveSpeed(seg(tp, K.tankIn, K.tankArrive));
    if (sp > 0) r += Math.sin(tp / 26) * .22 * sp;
    return clamp(r, -BARREL_MAX, BARREL_MAX);
  }
  // Dirt off the tracks while it moves; every grain is gone by the stop.
  const DIRT = [];
  let PUFF = null;
  function puffSprite() {
    if (PUFF) return PUFF;
    const R = 32;
    PUFF = document.createElement('canvas'); PUFF.width = PUFF.height = R * 2;
    const q = PUFF.getContext('2d'), g = q.createRadialGradient(R, R, R * .12, R, R, R);
    g.addColorStop(0, 'rgba(140,110,76,1)'); g.addColorStop(.5, 'rgba(128,100,69,.62)'); g.addColorStop(1, 'rgba(118,92,64,0)');
    q.fillStyle = g; q.beginPath(); q.arc(R, R, R, 0, 6.283); q.fill();
    return PUFF;
  }
  (function () {
    const dr = lcg(4471);
    for (let i = 0; i < 64; i++) DIRT.push({ u: i / 63, along: -.50 + dr() * .34, r: 2.6 + dr() * 7,
      vx: -26 - dr() * 58, vy: -70 - dr() * 120, spin: dr() * 6.283, life: 300 + dr() * 300 });
  })();
  function paintDirt(tp) {
    if (tp < K.tankIn || tp > K.tankArrive + 140 || !slot) return;
    const sl = tankSlot(), ground = sl.cy + sl.h * .36, span = K.tankArrive - K.tankIn, edge = panelLeft() + 4;
    const sprite = puffSprite();
    ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < DIRT.length; i++) {
      const d = DIRT[i], tb = K.tankIn + d.u * span, life = Math.min(d.life, K.tankArrive + 110 - tb);
      if (life <= 50) continue;
      const age = tp - tb;
      if (age < 0 || age > life) continue;
      const bx = sl.cx + tankDriveX(tb) + sl.w * d.along;
      if (bx < edge) continue;
      const s = age / 1000, k = age / life;
      const x = bx + d.vx * s + Math.sin(d.spin + age / 90) * 2.2, y = ground + d.vy * s + 560 * s * s;
      if (x < edge || y > ground + 1.5) continue;
      const rr = d.r * (1 + k * 1.3);
      ctx.globalAlpha = .46 * (1 - k) * (1 - k);
      ctx.drawImage(sprite, x - rr, y - rr, rr * 2, rr * 2);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // WRITING INTO THE MENU. Every element the intro touches is registered with
  // its exact original style attribute, so the end can put it back byte for
  // byte. bay.js rewriting an element's style refreshes that snapshot (it is
  // the template's own text) before the intro's values are put back.
  const reg = new Map();                   // el -> { snap: string|null, want: {prop: value} }
  let mo = null;
  function regOf(el) {
    let r = reg.get(el);
    if (!r) { r = { snap: el.getAttribute('style'), want: {}, rest: null }; reg.set(el, r); }
    return r;
  }
  function put(el, prop, value) {
    const r = regOf(el);
    r.want[prop] = value;
    if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
  }
  function reapply(el) {
    const r = reg.get(el);
    if (!r) return;
    // transition first, always: a value put back without it would animate.
    if (r.want.transition) el.style.setProperty('transition', r.want.transition);
    for (const p in r.want) if (p !== 'transition' && el.style.getPropertyValue(p) !== r.want[p]) el.style.setProperty(p, r.want[p]);
  }
  // The rest opacity of a unit: what the menu shows when the intro is not
  // touching it. Read with transitions held off, never during the bay's own
  // entrance animation, and only from computed style.
  function restOpacity(el) {
    const r = regOf(el);
    if (r.rest !== null) return r.rest;
    if (bay.classList.contains('enter')) return 1;
    el.style.setProperty('transition', 'none');
    const held = el.style.getPropertyValue('opacity');
    el.style.removeProperty('opacity');
    let v = parseFloat(getComputedStyle(el).opacity);
    if (!isFinite(v)) v = 1;
    if (held) el.style.setProperty('opacity', held);
    r.rest = v;
    return v;
  }

  // ---------------------------------------------------------------------------
  // DISCOVERING THE CHROME. Chrome is every .stage child with a positive
  // z-index (scene layers are z auto). A chrome element that paints nothing of
  // its own deals in as its children, one level only, so the mode boards come
  // in card by card. Keyed by DOM position, which is what bay.js's positional
  // morph preserves, so a redraw keeps every unit on its schedule.
  function visibleBox(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }
  function paintsNothing(el) {
    const cs = getComputedStyle(el);
    const clear = function (c) { return c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c); };
    if (!clear(cs.backgroundColor) || cs.backgroundImage !== 'none') return false;
    if (['Top', 'Right', 'Bottom', 'Left'].some(function (s) { return cs['border' + s + 'Style'] !== 'none' && parseFloat(cs['border' + s + 'Width']) > 0; })) return false;
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) return false;
    if (cs.boxShadow !== 'none' || cs.filter !== 'none') return false;
    if ((cs.backdropFilter || cs.webkitBackdropFilter || 'none') !== 'none') return false;
    if ((cs.maskImage || cs.webkitMaskImage || 'none') !== 'none') return false;
    for (const pe of ['::before', '::after']) {
      const c = getComputedStyle(el, pe).content;
      if (c && c !== 'none' && c !== 'normal') return false;
    }
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return false;
    return true;
  }
  let units = null, unitsStage = null, frozen = null;   // frozen: key -> schedule
  function discover(st) {
    const out = [];
    const kids = Array.prototype.slice.call(st.children);
    kids.forEach(function (el, ci) {
      const z = getComputedStyle(el).zIndex;
      if (z === 'auto' || !(+z > 0) || !visibleBox(el)) return;
      const inner = Array.prototype.slice.call(el.children).filter(visibleBox);
      if (inner.length >= 2 && paintsNothing(el)) {
        Array.prototype.forEach.call(el.children, function (k, ki) {
          if (inner.indexOf(k) >= 0) out.push({ el: k, key: ci + '.' + ki, cont: ci });
        });
      } else out.push({ el: el, key: String(ci), cont: ci });
    });
    units = out; unitsStage = st;
  }
  // The schedule is fixed the first time the chrome phase is drawn: containers
  // by their top edge then left, children left to right, staggered evenly so
  // any number of units lands inside the window. Direction comes from where a
  // unit sits: the top third drops in, the bottom third rises, the middle
  // slides from its nearer side.
  const UNIT_DUR = 340;
  function freezeSchedule() {
    const rows = units.map(function (un) {
      const r = rectStage(un.el), cr = rectStage(un.el.parentNode === unitsStage ? un.el : un.el.parentNode);
      return { un: un, r: r, ct: cr.y, cl: cr.x };
    });
    rows.sort(function (a, b) { return (a.ct - b.ct) || (a.cl - b.cl) || (a.r.x - b.r.x); });
    const n = rows.length;
    const step = n > 1 ? Math.min(70, (K.chromeEnd - UNIT_DUR - K.chromeIn) / (n - 1)) : 0;
    frozen = {};
    rows.forEach(function (row, i) {
      const cy = row.r.y + row.r.h / 2, cx = row.r.x + row.r.w / 2;
      let dx = 0, dy = 0;
      if (cy < H / 3) dy = -14; else if (cy > H * 2 / 3) dy = 16; else dx = cx < W / 2 ? -24 : 24;
      frozen[row.un.key] = { start: K.chromeIn + i * step, dx: dx, dy: dy };
    });
  }
  function scheduleOf(un) {
    if (frozen[un.key]) return frozen[un.key];
    // A unit the menu added after the schedule was fixed takes its container's
    // last schedule, so it travels with its neighbours instead of popping.
    let best = null;
    for (const k in frozen) if (k.split('.')[0] === String(un.cont)) best = frozen[k];
    return best || { start: -Infinity, dx: 0, dy: 0 };
  }
  function restTranslate(el) {
    el.style.setProperty('transition', 'none');
    const held = el.style.getPropertyValue('translate');
    el.style.removeProperty('translate');
    const v = getComputedStyle(el).translate;
    if (held) el.style.setProperty('translate', held);
    if (!v || v === 'none') return [0, 0];
    const m = v.match(/^(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?$/);
    return m ? [parseFloat(m[1]), parseFloat(m[2] || '0')] : null;
  }
  function driveChrome(tp) {
    for (const un of units) {
      const el = un.el;
      put(el, 'transition', 'none');
      if (tp < K.chromeIn || !frozen) { put(el, 'opacity', '0'); continue; }
      const sc = scheduleOf(un), p = eOut(seg(tp, sc.start, sc.start + UNIT_DUR));
      const rest = restOpacity(el);
      put(el, 'opacity', p >= 1 ? String(rest) : (rest * p).toFixed(4));
      const rt = regOf(el).restT || (regOf(el).restT = restTranslate(el) || 'skip');
      if (rt !== 'skip') {
        const tx = rt[0] + sc.dx * (1 - p) * u, ty = rt[1] + sc.dy * (1 - p) * u;
        put(el, 'translate', p >= 1 && !rt[0] && !rt[1] ? 'none' : tx.toFixed(2) + 'px ' + ty.toFixed(2) + 'px');
      }
      put(el, 'scale', p >= 1 ? 'none' : (.95 + .05 * p).toFixed(4));
    }
  }

  // ---------------------------------------------------------------------------
  // THE TANK, IN THE MENU. The menu's own <img> is hidden, never altered (a
  // changed src would be crossfaded back by bay.js). The drive-in is carried by
  // two canvases of the intro's own, hull and barrel, holding the sprite with
  // its baked ground shadow stripped, inside one wrapper APPENDED to .tankw (the
  // positional morph would otherwise match it against the template's <img>).
  // z-index -1 puts it under the menu's image; .tankw is a stacking context
  // because of its bob. The wrapper also carries the clip at the backdrop's
  // edge. Hand-off: the motion reaches zero, the menu's own image and its
  // reflection fade in OVER the layers (so the hull never dips), the layers
  // then fade out underneath (double-covered edges would otherwise pop), and
  // the wrapper is removed.
  // Measured on the drawTank sprite, which is locked, as bay.js draws it for
  // home: its 204x167 frame, and tankPad(204) = 33 more on the top and the
  // right that hold the gun's muzzle (237x200 in all, its frame 33 down).
  // Fractions and percentages of that image. The gun is drawn at 38 degrees
  // from the mantlet's centre (PIVOT), its muzzle brake 0.23r either side of
  // its line: the barrel layer is that band, 2px wider and from 1px behind
  // the mantlet's centre on out past the image, and the hull's hole is the
  // band 1px narrower on each side, from the centre itself, so the two
  // layers overlap by a pixel and leave no seam. HULL is the point the hull
  // pitches about, (.5, .58) of the frame.
  const TANK_FRAME = { y: 33 / 200, w: 204 / 237, h: 167 / 200 };
  const TANK_HOLE = 'polygon(0% 0%, 93.619% 0%, 52.106% 38.433%, 60.670% 51.422%, 100% 15.010%, 100% 100%, 0% 100%)';
  const TANK_BARREL = 'polygon(51.514% 38.347%, 60.598% 52.124%, 127.429% -9.750%, 118.345% -23.527%)';
  const PIVOT_X = .56388, PIVOT_Y = .44928;
  const HULL_X = .43038, HULL_Y = .64930;
  let wrap = null, hullCv = null, barrelCv = null, layerSrc = '';
  function menuImg(tw) {
    const imgs = tw.querySelectorAll(':scope > img');
    for (let i = imgs.length - 1; i >= 0; i--) if (!imgs[i].classList.contains('xf-out')) return imgs[i];
    return null;
  }
  // The bay lights the tank with four drop-shadows: three rim lights and one
  // heavy black cast that is its ground shadow. The layers keep the rim lights.
  function filterWithoutCast(img) {
    const f = getComputedStyle(img).filter;
    if (!f || f === 'none') return 'none';
    const parts = f.match(/[a-z-]+\((?:[^()]|\([^()]*\))*\)/g) || [];
    const keep = parts.filter(function (fn) {
      if (fn.indexOf('drop-shadow') !== 0) return true;
      const m = fn.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/);
      return !m || (+m[1] + +m[2] + +m[3]) > 90;
    });
    return keep.length ? keep.join(' ') : 'none';
  }
  // The sprite's baked ground shadow is a flat 32% black ellipse (drawTank,
  // app.js), the hull is opaque: everything under half alpha goes. A read that
  // cannot be the sprite (anti-fingerprinting can blank or perturb canvas
  // reads) leaves the shadow in rather than drawing nothing.
  function paintLayer(c, img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    c.width = w; c.height = h;
    const q = c.getContext('2d');
    q.drawImage(img, 0, 0);
    try {
      const g = q.getImageData(0, 0, w, h), a = g.data;
      let solid = 0, cut = 0;
      for (let i = 3; i < a.length; i += 4) {
        if (a[i] >= 250) solid++;
        else if (a[i] > 0 && a[i] < 128) { a[i] = 0; cut++; }
      }
      if (solid >= w * h * .10 && cut >= w * h * .01) q.putImageData(g, 0, 0);
    } catch (e) {}
  }
  function buildLayers(tw, img, extra) {
    if (!img.complete || !img.naturalWidth) return false;
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.setAttribute('data-intro', '');
      hullCv = document.createElement('canvas');
      barrelCv = document.createElement('canvas');
      [hullCv, barrelCv].forEach(function (c) {
        c.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;transform-origin:0 0';
        wrap.appendChild(c);
      });
      hullCv.style.clipPath = TANK_HOLE;
      barrelCv.style.clipPath = TANK_BARREL;
    }
    if (layerSrc !== img.src) {
      paintLayer(hullCv, img); paintLayer(barrelCv, img);
      layerSrc = img.src;
      const f = filterWithoutCast(img);
      hullCv.style.filter = f; barrelCv.style.filter = f;
    }
    const cs = getComputedStyle(img);
    wrap.style.cssText = 'position:absolute;left:' + img.offsetLeft + 'px;top:' + img.offsetTop + 'px;width:' + cs.width
      + ';height:' + cs.height + ';z-index:-1;pointer-events:none;' + extra;
    if (wrap.parentNode !== tw || tw.lastElementChild !== wrap) tw.appendChild(wrap);
    return true;
  }
  function driveTank(tp) {
    const tw = bay.querySelector('.stage .tankw');
    if (!tw) return;
    const img = menuImg(tw);
    if (!img) return;
    readMenuGeometry(tw, img);
    const refl = bay.querySelector('.stage .refl');
    const handIn = seg(tp, K.imgIn0, K.imgIn1);
    put(img, 'transition', 'none');
    put(img, 'opacity', handIn >= 1 ? '1' : handIn.toFixed(4));
    if (refl) {
      put(refl, 'transition', 'none');
      const rr = handIn > 0 ? restOpacity(refl) : 1;
      put(refl, 'opacity', handIn >= 1 ? String(rr) : (rr * handIn).toFixed(4));
    }
    if (tp < K.tankIn || tp >= K.layerOut1) { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); return; }
    const w = parseFloat(getComputedStyle(img).width) || img.offsetWidth, h = parseFloat(getComputedStyle(img).height) || img.offsetHeight;
    // The clip, in the wrapper's own px: everything left of the backdrop's edge
    // is hidden while the tank is arriving, so it comes in from off-scene.
    const s = tankSlot(), L = (panelLeft() - s.x) * u, M = (200 * u).toFixed(1);
    const out = seg(tp, K.layerOut0, K.layerOut1);
    const extra = (tp < K.settled ? 'clip-path:inset(-' + M + 'px -' + M + 'px -' + M + 'px ' + L.toFixed(1) + 'px);' : '')
                + (out > 0 ? 'opacity:' + (1 - out).toFixed(4) + ';' : '');
    if (!buildLayers(tw, img, extra)) return;
    if (tp >= K.settled) { hullCv.style.transform = 'none'; barrelCv.style.transform = 'none'; return; }
    const dx = tankDriveX(tp) * u, ty = (tankChatter(tp) + tankSquat(tp) + tankIdle(tp)) * u;
    const ox = (w * HULL_X).toFixed(1), oy = (h * HULL_Y).toFixed(1), rotd = tankPitch(tp) + tankRoll(tp);
    const hull = 'translate(' + dx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) translate(' + ox + 'px,' + oy + 'px) rotate('
      + rotd.toFixed(3) + 'deg) translate(-' + ox + 'px,-' + oy + 'px)';
    const px = (w * PIVOT_X).toFixed(1), py = (h * PIVOT_Y).toFixed(1);
    hullCv.style.transform = hull;
    barrelCv.style.transform = hull + ' translate(' + px + 'px,' + py + 'px) rotate(' + barrelRel(tp).toFixed(3) + 'deg) translate(-' + px + 'px,-' + py + 'px)';
  }

  // ---------------------------------------------------------------------------
  // THE MENU, PER FRAME AND AFTER EVERY REDRAW.
  function abortNeeded() {
    if (!bay.isConnected) return true;
    const scr = bay.dataset.scr;
    if (scr && scr !== 'home') return true;
    if (scr && !bay.classList.contains('active')) return true;
    if (unitsStage && !unitsStage.isConnected && scr === 'home') return true;
    return false;
  }
  function driveMenu(tp) {
    if (abortNeeded()) { end('abort'); return; }
    if (bay.dataset.scr !== 'home') return;     // not rendered yet
    const st = stageNode();
    if (!st) return;
    if (!units || unitsStage !== st) discover(st);
    if (!frozen && tp >= K.chromeIn && !bay.classList.contains('enter')) freezeSchedule();
    driveTank(tp);
    driveChrome(tp);
    if (mo) mo.takeRecords();                  // our own writes are not news
  }
  function onMutations(recs) {
    if (abortNeeded()) { end('abort'); return; }
    let structural = false;
    for (const rec of recs) {
      if (rec.type === 'childList') {
        // our wrapper being taken out and put back is not a change to the menu
        let ours = true;
        for (const n of rec.addedNodes) if (n !== wrap) ours = false;
        for (const n of rec.removedNodes) if (n !== wrap) ours = false;
        if (!ours) structural = true;
      } else if (rec.attributeName === 'style') {
        const r = reg.get(rec.target);
        if (r) { r.snap = rec.target.getAttribute('style'); reapply(rec.target); }
      } else if (rec.attributeName === 'class') {
        const r = reg.get(rec.target);
        if (r) { r.rest = null; r.restT = null; }
      }
    }
    if (structural) units = null;
    driveMenu(status.tp);
  }

  // ---------------------------------------------------------------------------
  // THE END. Order matters, and every step is guarded on its own:
  //   1. the canvas goes transparent at once, so whatever follows, the player
  //      is looking at the menu;
  //   2. the menu is put back: values to rest while transition:none still
  //      holds, a style flush, then each element's exact original style
  //      attribute (removing transition:none with the values already equal
  //      starts no transition). Both steps write the ATTRIBUTE, never the
  //      style object: in Chrome, an element edited through el.style and then
  //      given removeAttribute('style') is left with an empty style="" that
  //      its template does not have (measured), and the next bay redraw would
  //      find something to change;
  //   3. the canvas stays as a transparent shield only for a skipping pointer,
  //      until that tap's click has been swallowed.
  let rafId = 0, watchdog = 0, hadInert = false, shield = false, shieldT = 0;
  function teardownMenu() {
    if (mo) { mo.disconnect(); mo = null; }
    if (wrap && wrap.parentNode) { try { wrap.parentNode.removeChild(wrap); } catch (e) {} }
    const els = Array.from(reg.keys());
    els.forEach(function (el) {
      try {
        if (!el.isConnected) return;
        const r = reg.get(el);
        el.setAttribute('style', (r.snap ? r.snap.replace(/;?\s*$/, ';') : '') + 'transition:none');
      } catch (e) { report(e); }
    });
    try { if (els.length) void getComputedStyle(els[0]).opacity; document.body.offsetWidth; } catch (e) {}
    els.forEach(function (el) {
      try {
        if (!el.isConnected) return;
        const r = reg.get(el);
        if (r.snap === null) el.removeAttribute('style'); else el.setAttribute('style', r.snap);
      } catch (e) { report(e); }
    });
    reg.clear();
  }
  // A skip before the bay's own entrance has finished leaves that entrance to
  // play after the intro: finish its finite animations instead.
  function finishEntrance() {
    if (!bay.classList.contains('enter') || !bay.getAnimations) return;
    bay.getAnimations({ subtree: true }).forEach(function (a) {
      try {
        const it = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming().iterations;
        if (isFinite(it)) a.finish();
      } catch (e) {}
    });
  }
  function removeOverlay() {
    shield = false; clearTimeout(shieldT);
    try { if (cv.parentNode) cv.parentNode.removeChild(cv); } catch (e) {}
    try { if (hint.parentNode) hint.parentNode.removeChild(hint); } catch (e) {}
    removeListeners();
  }
  function end(reason) {
    if (dead) return;
    dead = true;
    status.state = 'ended'; status.reason = reason;
    try { cancelAnimationFrame(rafId); clearTimeout(watchdog); } catch (e) {}
    try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, cv.width, cv.height); } catch (e) {}
    try { hint.style.transition = 'none'; hint.style.opacity = '0'; } catch (e) {}
    try { teardownMenu(); } catch (e) { report(e); }
    try { finishEntrance(); } catch (e) {}
    try { bay.inert = hadInert; } catch (e) {}
    try {
      if (reason === 'skip-pointer') {
        shield = true; cv.style.pointerEvents = 'auto';
        shieldT = setTimeout(removeOverlay, 1500);
      } else removeOverlay();
    } catch (e) { try { removeOverlay(); } catch (x) {} }
    releaseLaunch();
    // THE DOORS ARE GONE, for what waited not to be drawn over them: bay.js's
    // notice of a match that ended while the player was away (mgRaise), raised
    // when a held seat's resume is refused while the quick doors wait for it,
    // and app.js's toasts held while the quick doors were up (showToast).
    try { window.CC_DOORS_UP = false; document.dispatchEvent(new Event('cc:doorsgone')); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // SKIPPING. Any tap, click or key. Ending the intro and releasing the input
  // shield are separate: at pointerdown the menu is restored at once, but the
  // canvas stays as a transparent shield until that tap's own click reaches it
  // (or 600 ms after the finger lifts, or the touch is cancelled), so the
  // skipping tap can never press anything. No free-floating "next click"
  // latch: only a click aimed at the canvas is swallowed.
  let sawDown = false;
  function swallow(e) { try { e.preventDefault(); } catch (x) {} try { e.stopPropagation(); } catch (x) {} }
  const onDown = function (e) {
    if (shield) { swallow(e); return; }
    if (dead) return;
    sawDown = true;
    swallow(e);
    end('skip-pointer');
  };
  const onUp = function () { if (shield) { clearTimeout(shieldT); shieldT = setTimeout(removeOverlay, 600); } };
  const onCancel = function () { if (shield) removeOverlay(); };
  const onClick = function (e) {
    if (shield) { if (e.target === cv) { swallow(e); removeOverlay(); } return; }
    if (dead) return;
    // a click with no pointer before it is assistive technology activating
    // something: it skips, and it does not reach the menu
    if (!sawDown) { swallow(e); end('skip-click'); }
  };
  const MODS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, CapsLock: 1, Fn: 1, OS: 1, Hyper: 1, Super: 1 };
  const onKey = function (e) {
    if (dead) return;
    if (!(e.ctrlKey || e.metaKey || e.altKey || MODS[e.key])) swallow(e);
    end('skip-key');
  };
  const LISTEN = [['pointerdown', onDown], ['pointerup', onUp], ['pointercancel', onCancel], ['click', onClick], ['keydown', onKey]];
  const wrapped = LISTEN.map(function (p) { return [p[0], function (e) { try { p[1](e); } catch (x) { report(x); try { removeOverlay(); } catch (y) {} } }]; });
  function removeListeners() { wrapped.forEach(function (p) { window.removeEventListener(p[0], p[1], true); }); }

  // ---------------------------------------------------------------------------
  // THE FRAME.
  let t = 0, late = 0, revealed = false, started = false, last = 0;
  function paint(t, tp) {
    const lx = lampX(t), power = lampPower(t), sh = shake(t), sc = camScale(t), shift = doorShift(t);
    const gf = 1 - seg(tp, K.envIn, K.envFull);
    const po = eOut(seg(t, 0, 250));            // the power-on: doors alone at frame 0, as the launch image
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (gf > .002) { toOverlay(); ctx.globalAlpha = gf; paintInterior(); ctx.globalAlpha = 1; }
    toStage();
    ctx.save();
    ctx.translate(W / 2 + sh[0], H * .52 + sh[1]); ctx.scale(sc, sc); ctx.translate(-W / 2, -H * .52);
    paintGameLogo(t, tp);
    const doorA = 1 - seg(t, K.doorGone - 350, K.doorGone);
    if (doorA > .002) {
      const BIG = 4000;
      ctx.save(); ctx.globalAlpha = doorA;
      ctx.save(); ctx.translate(-shift, 0); ctx.beginPath(); ctx.rect(-BIG, -BIG, W / 2 + BIG, H + 2 * BIG); ctx.clip();
      paintDoorHalf(-1); paintPool(t, lx + shift, power, doorA); markPaths(t, lx + shift, power, po * doorA);
      paintBeacon(W * .085, H * .12, t, 0, po * doorA); paintBeacon(W * .085, H * .88, t, Math.PI, po * doorA);
      ctx.restore();
      ctx.save(); ctx.translate(shift, 0); ctx.beginPath(); ctx.rect(W / 2, -BIG, W / 2 + BIG, H + 2 * BIG); ctx.clip();
      ctx.globalAlpha = doorA;
      paintDoorHalf(1); paintPool(t, lx - shift, power, doorA); markPaths(t, lx - shift, power, po * doorA);
      paintBeacon(W * .915, H * .12, t, Math.PI * .5, po * doorA); paintBeacon(W * .915, H * .88, t, Math.PI * 1.5, po * doorA);
      ctx.restore();
      paintFall(t);
      ctx.restore();
    }
    ctx.restore();
    paintBeam(t, lx, power * gf); paintMotes(t, lx, power * gf); paintDirt(tp);
    const grade = po * (tp < K.gradeOut0 ? Math.max(gf, .3) : .3 * (1 - eInOut(seg(tp, K.gradeOut0, K.gradeOut1))));
    if (grade > .001) { toOverlay(); paintGrade(t, grade); }
  }
  function ready() {
    if (bay.dataset.scr !== 'home' || bay.classList.contains('enter') || !fontsOk) return false;
    const tw = bay.querySelector('.stage .tankw'), img = tw && menuImg(tw);
    return !!(img && img.complete && img.naturalWidth);
  }
  const frame = guard(function (now) {
    rafId = requestAnimationFrame(frame);
    if (document.visibilityState === 'hidden' || document.prerendering) { last = now; return; }
    const dt = last ? clamp(now - last, 0, 50) : 0;
    last = now;
    measure();
    if (started) {
      t += dt;
      if (!revealed && t >= K.reveal) {
        if (ready()) revealed = true;
        else late += dt;
        if (!revealed && t - late > K.reveal + 1) late = t - K.reveal;
      }
      if (!revealed && t > HOLD_CEILING) { end('ceiling'); return; }
    }
    const tp = t - late;
    status.t = t; status.tp = tp;
    if (t > 1000 && tp < K.logoHold + 300 && hint.style.opacity !== '1') hint.style.opacity = '1';
    if (tp >= K.logoHold + 300 && hint.style.opacity !== '0') hint.style.opacity = '0';
    driveMenu(tp);
    if (dead) return;
    paint(t, tp);
    if (tp >= K.end) end('done');
  });

  // ---------------------------------------------------------------------------
  // THE QUICK DOORS. Their frame 0 is the intro's own frame 0, the launch
  // image: while they are shut the interior is painted under them as the
  // intro paints it, so even the column a fractional seam shares between the
  // two halves is the same pixel. While the destination is not drawn yet (a
  // held seat's resume in flight, a first font load) they hold, and are not a
  // frozen frame: the studio mark and the beacons power on and the beacons
  // turn, as in the intro's first quarter second. Then they part in Q.open
  // with the gap between them clear onto the destination itself. Under
  // reduced motion nothing on them moves or lights: they hold as the launch
  // image held, and the canvas fades in Q.fade instead of parting.
  // Q.hold is the visible time they may wait: past it they open onto whatever
  // is there, and a resume that lands later takes the player to the match as
  // it always has. Where the doors stand is measured once, at boot, from the
  // probe stage (the launch image's own geometry), and again only if the
  // overlay changes size: under them the bay may give way to the match, a
  // hidden bay measures as nothing, and a seam that moved mid-open would split
  // the doors.
  const Q = { power: 250, open: 500, fade: 400, hold: 3000 };
  let openAt = -1;
  function doorTravel() {                   // how far each half goes: as far as the intro's doorShift
    const g = doorGeom();
    return Math.max(W * .52 * 1.16, Math.max(g.seam, cw - g.seam) / u + 30);
  }
  function gameUp() { const g = document.getElementById('game'); return !!(g && g.classList.contains('active')); }
  // The destination is drawn: a held seat's match once its resume has been
  // answered, either way (restored, or refused and cleared by boot); else the
  // screen the bay has drawn, in its own type and with its pictures in.
  function quickReady() {
    if (gameUp()) return true;
    let held = false;
    try { held = BOOT_CLAIM === 'resume' && typeof loadResume === 'function' && !!loadResume(); } catch (e) {}
    if (held || !fontsOk || !bay.dataset.scr || !bay.classList.contains('active')) return false;
    return Array.prototype.every.call(bay.querySelectorAll('img'), function (i) { return i.complete; });
  }
  function paintQuick(t, p) {
    const shift = FADE ? 0 : eInOut(p) * doorTravel(), po = FADE ? 0 : eOut(seg(t, 0, Q.power));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (shift <= 0) { toOverlay(); paintInterior(); }
    toStage();
    const BIG = 4000;
    ctx.save(); ctx.translate(-shift, 0); ctx.beginPath(); ctx.rect(-BIG, -BIG, W / 2 + BIG, H + 2 * BIG); ctx.clip();
    paintDoorHalf(-1); markPaths(t, W / 2, 0, po);
    paintBeacon(W * .085, H * .12, t, 0, po); paintBeacon(W * .085, H * .88, t, Math.PI, po);
    ctx.restore();
    ctx.save(); ctx.translate(shift, 0); ctx.beginPath(); ctx.rect(W / 2, -BIG, W / 2 + BIG, H + 2 * BIG); ctx.clip();
    paintDoorHalf(1); markPaths(t, W / 2, 0, po);
    paintBeacon(W * .915, H * .12, t, Math.PI * .5, po); paintBeacon(W * .915, H * .88, t, Math.PI * 1.5, po);
    ctx.restore();
    if (FADE) cv.style.opacity = p >= 1 ? '0' : (1 - eInOut(p)).toFixed(4);
    status.shift = shift; status.geo = [sx, sy, u];
  }
  const quickFrame = guard(function (now) {
    rafId = requestAnimationFrame(quickFrame);
    if (document.visibilityState === 'hidden' || document.prerendering) { last = now; return; }
    const dt = last ? clamp(now - last, 0, 50) : 0;
    last = now;
    const key = sizeKey;
    fitBacking();
    if (sizeKey !== key) measure();
    if (started) {
      t += dt;
      if (openAt < 0 && (quickReady() || t >= Q.hold)) {
        openAt = t;
        status.openAt = t; status.dest = gameUp() ? 'game' : bay.dataset.scr || '';
        // A screen drawn under the doors is still dealing itself in: it is
        // finished now, while the doors are shut, so they open onto it at rest.
        finishEntrance();
      }
    }
    const p = openAt < 0 ? 0 : seg(t, openAt, openAt + (FADE ? Q.fade : Q.open));
    status.t = t; status.tp = t; status.open = p;
    paintQuick(t, p);
    if (p >= 1) end('done');
  });

  // ---------------------------------------------------------------------------
  // GO. The overlay and frame 0 are up before bay.js runs, so the first painted
  // frame is the doors. The clock starts once the doors are on screen: on iOS
  // after the native launch hold has been released (with a ceiling, in case the
  // plugin never answers), on the web at the first visible frame.
  const boot = guard(function () {
    status.state = 'running';
    // Published for bay.js, which holds a notice back while the doors are up,
    // and for app.js, which holds its toasts while the quick doors are up
    // (end() puts this back and says so).
    window.CC_DOORS_UP = true;
    hadInert = !!bay.inert;
    bay.inert = true;
    app.appendChild(cv);
    if (!QUICK) app.appendChild(hint);         // the quick doors are gone before it could be read
    wrapped.forEach(function (p) { window.addEventListener(p[0], p[1], true); });
    measure();
    if (QUICK) paintQuick(0, 0); else paint(0, 0);
    // The quick doors write nothing into the menu, so there is nothing to put back after a redraw.
    if (!QUICK) {
      mo = new MutationObserver(guard(onMutations));
      mo.observe(bay, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'data-scr'] });
    }
    watchdog = setTimeout(guard(function () { end('watchdog'); }), 30000);
    rafId = requestAnimationFrame(QUICK ? quickFrame : frame);
    if (window.__ccIntroFrame0) return;        // the launch-image renderer holds frame 0
    afterTwoFrames(guard(function () {
      let go = false;
      const start = guard(function () { if (!go) { go = true; started = true; } });
      releaseLaunch().then(start, start);
      setTimeout(start, 600);
    }));
  });
  boot();
})();
