// House rules, enforced instead of remembered.
//
// These are standing project rules that have each been broken at least once and
// caught only by an ad-hoc grep. Encoding them means they cannot regress
// silently. Headless — no server required, so CI runs it first and cheaply.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// public/privacy.html and public/delete-account.html are here because they are
// player-visible pages, they are in the service-worker shell, and they carry the
// Guideline 1.2 copy — every reason the no-emoji rule exists applies to them,
// and they were simply never added (audit 2026-09-21, M14b). public/sw.js for
// the same reason: its fallback title and body are what a notification shows
// when a push carries none, on the player's lock screen (Task 7 review).
// public/config.js and every server module for the same reason as server.js
// (the whole-branch fix wave): server/social.js builds every squad and friend
// frame the client renders, and a string any of them sends can reach a
// player's screen. The server modules are WALKED, as rule 14 walks them, so a
// new one is covered the day it is added.
const UI_FILES = ['public/index.html', 'public/app.js', 'public/bay.js', 'public/styles.css', 'server.js',
  'public/game-core.js', 'public/room-engine.js', 'public/cloud.js', 'public/errors.js',
  'public/privacy.html', 'public/delete-account.html', 'public/sw.js', 'public/config.js', 'public/intro.js',
  ...readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js')).sort().map((f) => `server/${f}`)];

// ---- 1. NO EMOJI ANYWHERE IN THE UI -----------------------------------------
// Every glyph is hand-drawn inline SVG or canvas art. Both forms must be
// caught: a literal glyph AND a \u{1F3C6}-style escape, because an escaped
// trophy sat in the win titles for weeks while a literal-only audit passed.
{
  const glyph = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2460}-\u{24FF}\u{25A0}-\u{25FF}]/gu;
  const escaped = /\\u\{(?:1F[0-9A-Fa-f]{3}|2[67][0-9A-Fa-f]{2})\}|\\uD83[C-Fc-f]/g;
  let hits = 0;
  for (const rel of UI_FILES) {
    const src = read(rel);
    src.split('\n').forEach((line, i) => {
      // The 19 → arrows in code comments are grandfathered; they are prose in
      // comments, never rendered. Nothing else gets a pass.
      for (const m of line.matchAll(glyph)) {
        if (m[0] === '→') continue;
        hits++; fail(`emoji glyph ${JSON.stringify(m[0])} at ${rel}:${i + 1}`);
      }
      for (const m of line.matchAll(escaped)) {
        hits++; fail(`emoji ESCAPE ${m[0]} at ${rel}:${i + 1} — escapes render exactly like a literal glyph`);
      }
    });
  }
  if (!hits) ok(`no emoji (glyph or escape) across ${UI_FILES.length} UI files`);
}

// ---- 2. LANDSCAPE IS ABSOLUTE ------------------------------------------------
// Raw vh/vw units break under the portrait rotation shim, which is why every
// viewport unit flows through --vhu/--dvhu/--vwu/--dvwu instead.
{
  const css = read('public/styles.css');
  const bad = [];
  let shimDepth = 0;                                 // inside the portrait rotation shim
  css.split('\n').forEach((line, i) => {
    const code = line.split('/*')[0];
    const net = (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
    if (shimDepth > 0) {
      shimDepth = Math.max(0, shimDepth + net);
      return;                                        // the shim IS the mechanism — raw units are correct there
    }
    // Brace DEPTH, not depth+1: starting at 2 meant it never returned to zero
    // and every line after the shim was silently exempted. The self-test at the
    // bottom of this file exists because that bug passed review once already.
    //
    // This pattern is effectively ANCHORED: `@media` then optional whitespace
    // then `(orientation: portrait)`, so it matches only a query whose FIRST
    // condition is the orientation. That is load-bearing since ISSUE-039 — the
    // 16 size tiers each carry `(orientation: portrait)` in their SECOND arm and
    // must stay fully covered by this rule, while the four shim blocks lead with
    // it and must stay exempt. Rule 2b below pins that invariant.
    if (/@media\s*\(\s*orientation:\s*portrait\s*\)/.test(code)) {
      shimDepth = Math.max(0, net);
      return;
    }
    if (/@media/.test(code)) return;                 // media-query conditions are exempt
    if (/--(?:d?vhu|d?vwu)\s*:/.test(code)) return;  // the effective-unit definitions themselves
    if (/(?:^|[\s:(,])\d*\.?\d+(?:vh|vw|dvh|dvw)\b/.test(code)) bad.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  if (bad.length) {
    fail(`raw viewport units in styles.css — they lie under the portrait shim, use var(--vhu)/var(--vwu):\n      ${bad.join('\n      ')}`);
  } else ok('no raw vh/vw/dvh/dvw outside the shim and the unit definitions');
}

// ---- 3. THE TANK DESIGN IS LOCKED --------------------------------------------
// drawTank is settled art and must not drift. This does not freeze the code
// (paint palettes and the seat accent legitimately live inside it) — it pins
// the GEOMETRY constants the silhouette is built from, which is what "locked"
// actually means in practice.
{
  const core = read('public/game-core.js');
  // The SHAPE is the multipliers: TANK_HW/TANK_TOP are derived (1.35r /
  // 1.36r), and so is the muzzle (1.71r tube and brake, 0.47r pivot forward,
  // 1.14r pivot height), so pin them — changing one silently resizes the part
  // of the hitbox or the shot origin that must match the drawn art. The SIZE
  // is TANK_R alone: 276, the owner's 15% bigger battle tank (2026-10-07, the
  // 240 design x 1.15). A uniform size change moves TANK_R and nothing here.
  const pinned = [
    [/export const TANK_R\s*=\s*(\d+)/, 'TANK_R', '276'],
    [/TANK_HW\s*=\s*Math\.round\(([0-9.]+)\s*\*\s*TANK_R\)/, 'TANK_HW multiplier', '1.35'],
    [/TANK_TOP\s*=\s*Math\.round\(([0-9.]+)\s*\*\s*TANK_R\)/, 'TANK_TOP multiplier', '1.36'],
    [/const BARREL_LEN\s*=\s*Math\.round\(([0-9.]+)\s*\*\s*TANK_R\)/, 'BARREL_LEN multiplier', '1.71'],
    [/const BARREL_PIVOT_X\s*=\s*Math\.round\(([0-9.]+)\s*\*\s*TANK_R\)/, 'BARREL_PIVOT_X multiplier', '0.47'],
    [/const TANK_CY\s*=\s*Math\.round\(([0-9.]+)\s*\*\s*TANK_R\)/, 'TANK_CY multiplier', '1.14'],
  ];
  const wrong = [];
  for (const [re, name, want] of pinned) {
    const m = core.match(re);
    if (!m) wrong.push(`${name} not found`);
    else if (m[1] !== want) wrong.push(`${name} is ${m[1]}, locked at ${want}`);
  }
  if (wrong.length) fail(`tank geometry changed (design is LOCKED): ${wrong.join('; ')}`);
  else ok('tank geometry constants unchanged (design locked)');
}

// ---- 4. CLIENT/SERVER MIRRORED CONSTANTS MUST AGREE --------------------------
// The client predicts the shot arc locally, so it re-implements the server's
// ballistics. When one side moves and the other does not, the preview silently
// lies about where the shell will land.
{
  const core = read('public/game-core.js'), app = read('public/app.js');
  const grab = (src, re, label) => { const m = src.match(re); return m ? m[1] : `<${label} not found>`; };
  // The tank's size and where the shot leaves it: the client draws its tank
  // at TANK_R x zoom and starts the aim line (and the putter's pace line)
  // from its own copies of game-core's muzzle and putt tee, so a TANK_R or a
  // multiplier moved on one side only draws a tank off its own hitbox and an
  // aim line that starts away from the shell.
  const mult = (name) => new RegExp(`const ${name}\\s*=\\s*Math\\.round\\(([0-9.]+)\\s*\\*\\s*TANK_R\\)`);
  const pairs = [
    ['DMG_REACH', grab(core, /DMG_REACH\s*=\s*([0-9.]+)/, 'core'), grab(app, /selW\.radius\s*\*\s*([0-9.]+)/, 'client')],
    ['gravity', grab(core, /const GRAVITY\s*=\s*(\d+)/, 'core'), grab(app, /const G\s*=\s*(\d+)\s*\*/, 'client')],
    ['SPEED_PER_POWER', grab(core, /const SPEED_PER_POWER\s*=\s*(\d+)/, 'core'), grab(app, /aim\.power\s*\*\s*(\d+)\s*\*/, 'client')],
    ['TANK_R', grab(core, /export const TANK_R\s*=\s*(\d+)/, 'core'), grab(app, /\nconst TANK_R\s*=\s*(\d+)/, 'client')],
    ...['BARREL_LEN', 'BARREL_PIVOT_X', 'TANK_CY', 'PUTT_AHEAD'].map((n) => [n + ' multiplier', grab(core, mult(n), 'core'), grab(app, mult(n), 'client')]),
  ];
  let bad = 0;
  for (const [name, a, b] of pairs) {
    if (a !== b) { bad++; fail(`mirrored constant ${name} disagrees: game-core has ${a}, public/app.js has ${b}`); }
  }
  if (!bad) ok(`mirrored ballistics constants agree (${pairs.map(p => p[0]).join(', ')})`);
}

// ---- 4b. EVERY BATTLE TANK IS DRAWN AT TANK_R --------------------------------
// The battle tank's size was a bare 240 in three places on the client (the
// tank, the warp's light columns and the menu picture's camera), and update 8
// moved it to 276 through TANK_R. A 240 left behind draws that one thing at
// the old size: a warp column or a tank 15% off its hitbox, or a menu picture
// 15% too big for its frame. So the size is spelled TANK_R wherever it is used.
{
  const app = read('public/app.js'), bay = read('public/bay.js');
  const stale = [];
  app.split('\n').forEach((l, i) => { if (/\b240\s*\*\s*cam\.zoom\b|cam\.zoom\s*\*\s*240\b/.test(l.split('//')[0])) stale.push(`public/app.js:${i + 1}: ${l.trim()}`); });
  bay.split('\n').forEach((l, i) => { if (/cam\.zoom\s*=\s*[^;]*\/\s*240\b/.test(l.split('//')[0])) stale.push(`public/bay.js:${i + 1}: ${l.trim()}`); });
  const uses = (app.match(/const r = TANK_R \* cam\.zoom;/g) || []).length;
  if (stale.length) fail(`a battle tank size written as 240 instead of TANK_R:\n      ${stale.join('\n      ')}`);
  else if (uses < 2) fail(`tankScreen and drawWarp must both take r from TANK_R * cam.zoom (found ${uses})`);
  else if (!/cam\.zoom = r \/ G\.TANK_R;/.test(bay)) fail('bay.js tankURL must set its camera from TANK_R (cam.zoom = r / G.TANK_R), or the menu picture changes size with the battle tank');
  else ok('every battle tank size on the client is TANK_R (tank, warp, menu picture camera)');
}

// ---- 5. CALLSIGN WORD LISTS MUST AGREE (ISSUE-015) ---------------------------
// A ROLLED name is not free text. The client rolls from CALL_ADJ/CALL_NOUN and
// the server accepts a rolled name ONLY as a pair from its own copy of those
// lists. (Since 2026-09-18 a player with a linked account may also CHOOSE a
// callsign, which the server validates and stores itself — a different path,
// bounded by CALLSIGN_MAX in server/callsign.js, and not what this rule is
// about.) The client is a classic script and cannot import game-core.js, so the
// lists are duplicated — and if they drift, the server starts silently renaming
// players who did nothing wrong. Adding a word to one side without the other is
// the whole failure mode this guards.
{
  const core = read('public/game-core.js'), app = read('public/app.js');
  const list = (src, name) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    if (!m) return null;
    return m[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? [];
  };
  let bad = 0;
  for (const name of ['CALL_ADJ', 'CALL_NOUN']) {
    const a = list(core, name), b = list(app, name);
    if (!a || !b) { bad++; fail(`${name} not found in ${!a ? 'game-core.js' : 'public/app.js'}`); continue; }
    const missing = a.filter(w => !b.includes(w)), extra = b.filter(w => !a.includes(w));
    if (missing.length || extra.length) {
      bad++;
      fail(`${name} drifted — server would rename players using client-only words.` +
           (missing.length ? `\n      only in game-core.js: ${missing.join(', ')}` : '') +
           (extra.length ? `\n      only in public/app.js: ${extra.join(', ')}` : ''));
    }
  }
  // Every pair must fit the input, or a rolled name is truncated and then
  // rejected by the server as not-a-callsign.
  const adj = list(core, 'CALL_ADJ') || [], noun = list(core, 'CALL_NOUN') || [];
  const max = Number((core.match(/NAME_MAX\s*=\s*(\d+)/) || [])[1] || 0);
  const overlong = [];
  for (const a of adj) for (const n of noun) if (a.length + 1 + n.length > max) overlong.push(`${a} ${n}`);
  if (overlong.length > adj.length * noun.length * 0.5) {
    bad++; fail(`over half of all callsign pairs exceed NAME_MAX=${max} — the roll would loop`);
  }
  if (!bad) ok(`callsign lists agree (${adj.length}x${noun.length}, ${adj.length * noun.length - overlong.length} pairs fit NAME_MAX=${max})`);
}

// ---- 6. THE OFFLINE MODULES MUST STAY BROWSER-SAFE (ADR-001 / BQ-007) --------
// Offline play means these exact files run in the browser, not ports of them.
// One `import fs` or `process.env` and offline breaks — but the SERVER keeps
// working perfectly, so nothing else in the suite would notice. That silence is
// the reason this check exists.
//
// room-engine.js joined the list when the room/turn engine came out of
// server.js: it is the file most likely to regress, because the obvious way to
// add a server-side feature to it is to reach for a Node builtin.
for (const file of ['public/game-core.js', 'public/room-engine.js']) {
  const src = read(file);
  const bad = [];
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;                 // skip comments
    const n = i + 1;
    if (/\brequire\s*\(/.test(line)) bad.push(`${n}: require()`);
    if (/\bprocess\s*\./.test(line)) bad.push(`${n}: process.*`);
    if (/\b__dirname\b|\b__filename\b/.test(line)) bad.push(`${n}: __dirname/__filename`);
    if (/\bBuffer\s*\./.test(line)) bad.push(`${n}: Buffer`);
    const imp = line.match(/^\s*import\s.*?from\s+['"]([^'"]+)['"]/);
    if (imp && !imp[1].startsWith('.') && !imp[1].startsWith('/')) bad.push(`${n}: bare import '${imp[1]}'`);
    if (/from\s+['"]node:/.test(line)) bad.push(`${n}: node: builtin`);
  });
  if (bad.length) fail(`${file} is no longer browser-safe — offline play would break silently:\n      ${bad.join('\n      ')}`);
  else ok(`${file.replace('public/', '')} is browser-safe (no Node builtins, no bare imports)`);
}

// ---- 7. EVERY PRECACHED SHELL ASSET MUST EXIST (BQ-007) ----------------------
// sw.js caches each entry individually and swallows failures, precisely so one
// missing icon cannot cost the whole offline shell. The cost of that safety is
// that a renamed or deleted asset degrades offline support with nothing louder
// than a console warning nobody reads. This is the loud version.
{
  const sw = read('public/sw.js');
  const block = sw.match(/const SHELL = \[([\s\S]*?)\]/);
  if (!block) fail('sw.js has no SHELL precache list — offline support may have been removed');
  else {
    const list = (block[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
    // Entries carry a ?v= cache-busting stamp (see 7b); the file on disk does not.
    const bare = (p) => p.split('?')[0];
    const missing = list.filter(p => p !== './' && !existsSync(path.join(ROOT, 'public', bare(p))));
    if (!list.length) fail('sw.js SHELL list is empty');
    else if (missing.length) fail(`sw.js precaches files that do not exist — offline shell is incomplete:\n      ${missing.join('\n      ')}`);
    else {
      // These two are what offline PLAY depends on, as opposed to offline
      // LOADING. Name them explicitly so nobody drops one as "just an asset":
      // without either, the app opens with no network and then cannot start a
      // match, which is a worse failure than not opening at all.
      const core = ['game-core.js', 'room-engine.js'].filter(f => !list.map(bare).includes(f));
      if (core.length) fail(`sw.js does not precache ${core.join(' and ')} — the app would load offline but could not play`);
      else ok(`sw.js precaches ${list.length} shell entries, all present (game-core + room-engine included)`);
    }
  }
}

// ---- 2b. ONLY THE ROTATION SHIM MAY LEAD WITH (orientation: portrait) -------
// Rule 2 exempts raw vh/vw inside a query whose FIRST condition is
// `(orientation: portrait)`, because that is the rotation shim and raw units are
// its actual mechanism. The exemption is by leading position, so any OTHER block
// that happens to lead with the same condition silently stops being checked for
// raw viewport units — a hole that opens with no error and no output.
//
// Since ISSUE-039 this is one reordered arm away at all times: the 16 size tiers
// each carry `(orientation: portrait)` in their second arm, and moving one to
// the front would exempt that whole block. So pin the set.
{
  const css = read('public/styles.css');
  const leading = css.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /^@media\s*\(\s*orientation:\s*portrait\s*\)/.test(l.split('/*')[0]));
  // The shim is four blocks: the axis swap, the rotation itself, the #game/#dock
  // safe-area swap, and the bay's --sa-* swap. Each is gated to the shim's own
  // width range, and that gate is what keeps an upright iPad out of them.
  const ungated = leading.filter(([, l]) => !/\(\s*max-width:\s*500px\s*\)/.test(l));
  if (leading.length !== 4) {
    fail(`expected exactly 4 @media blocks leading with (orientation: portrait) — the rotation shim — found ${leading.length}:\n      ${leading.map(([n, l]) => `${n}: ${l.trim().slice(0, 96)}`).join('\n      ')}`);
  } else if (ungated.length) {
    fail(`a shim block is not width-gated, so it would rotate an upright iPad:\n      ${ungated.map(([n, l]) => `${n}: ${l.trim().slice(0, 96)}`).join('\n      ')}`);
  } else {
    ok('only the 4 rotation-shim blocks lead with (orientation: portrait), all width-gated');
  }
}

// ---- 7b. index.html AND sw.js MUST REQUEST THE SAME ASSET URLS --------------
// Static assets are served stale-while-revalidate, so a returning player's
// already-installed worker answers app.js and styles.css from ITS cache before
// the new worker can install. The Launch Bay cutover shipped the new
// index.html against that old cached app.js, which reached for markup the
// cutover had deleted and threw on null.classList — a blank screen on the
// first load after deploy, for every returning player.
//
// The fix is a ?v= stamp: a URL the old cache has never seen cannot be served
// stale. That only works while the two files agree. If index.html asks for
// 'app.js?v=3' and SHELL still precaches 'app.js?v=2', the stamp still busts
// the stale cache but the offline shell now misses on every load — the app
// stops working offline, silently, and nothing else would catch it.
{
  const html = read('public/index.html');
  const sw = read('public/sw.js');
  const block = sw.match(/const SHELL = \[([\s\S]*?)\]/);
  const shell = block ? (block[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)) : [];

  // Only same-origin css/js the PAGE pulls in: those are the ones a stale copy
  // can break. Fonts and images are content-addressed by name and harmless.
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)]
    .map(m => m[1])
    .filter(u => !/^(https?:)?\/\//.test(u) && !u.startsWith('/'));

  const unstamped = refs.filter(u => !u.includes('?v='));
  const adrift = refs.filter(u => u.includes('?v=') && !shell.includes(u));

  if (!refs.length) fail('index.html references no local css/js — the asset-stamp check has gone blind');
  else if (unstamped.length) fail(`index.html loads css/js with no ?v= stamp, so a stale cached copy can be served over it:\n      ${unstamped.join('\n      ')}`);
  else if (adrift.length) fail(`index.html and sw.js SHELL disagree — these are requested but never precached, so offline play breaks:\n      ${adrift.join('\n      ')}`);
  else ok(`index.html's ${refs.length} local css/js are all stamped and all precached under the same URL`);
}

// ---- 7c. THE WORKER VERSION MUST MOVE WITH THE ASSET STAMP -------------------
// 7b keeps index.html's ?v= stamps and sw.js's SHELL list in step, but it never
// read sw.js's VERSION — so index.html ?v=4 + SHELL ?v=4 + a forgotten 'cc-v3'
// passed ALL GOOD, and a returning player kept the old cache under a new page
// (ISSUE-038's exact shape). The number in VERSION must be the stamp number.
{
  const sw = read('public/sw.js');
  const html = read('public/index.html');
  const ver = (sw.match(/const VERSION = 'cc-v(\d+)'/) || [])[1];
  const stamp = (html.match(/\.(?:js|css)\?v=(\d+)/) || [])[1];
  if (!ver) fail("sw.js has no `const VERSION = 'cc-vN'` — the worker cannot retire old caches");
  else if (!stamp) fail('index.html has no ?v=N stamp to compare against');
  else if (ver !== stamp) fail(`sw.js VERSION is cc-v${ver} but index.html stamps ?v=${stamp} — bump them together or a stale worker serves the old shell`);
  else ok(`sw.js VERSION cc-v${ver} matches the ?v=${stamp} asset stamp`);
}

// ---- 7d. OFFLINE PLAY HAS TWO PREDICATES, NEVER ONE -------------------------
// `offlineCapable` was one predicate consulted at two sites with two meanings:
// "the device knows it is offline, start now" and "the server merely cannot be
// raised, silently go local after 4 s". Widening it for the first widened it for
// the second, and that second conversion is the one the owner forbade for every
// invite room (Boss, Aliens, Golf, Free-for-all). The replacement is
// soloByConstruction (an 'ai' frame: nothing to convert) and soloOfferable (an
// invite room: show the lobby, OFFER Play solo). Nobody may fold them back into
// one, and the prose that enumerated modes — and drifted — may not return.
{
  const app = read('public/app.js');
  const bad = [];
  if (/\bofflineCapable\b/.test(app)) bad.push('app.js reintroduces `offlineCapable` — one predicate with two meanings');
  if (app.includes('Vs. Computer and solo Golf')) bad.push('app.js reintroduces the mode-enumerating offline prose that drifted');
  for (const id of ['soloByConstruction', 'soloOfferable', 'soloFrameFor', 'playSolo']) {
    if (!new RegExp('\\b' + id + '\\b').test(app)) bad.push(`app.js has no ${id}`);
  }
  if (!app.includes("const soloByConstruction = (m) => m.type === 'ai';")) {
    bad.push("soloByConstruction must be exactly `m.type === 'ai'` — any mode, and nothing else (a create is never solo by construction)");
  }
  if (bad.length) fail(`the offline predicates have drifted:\n      ${bad.join('\n      ')}`);
  else ok('offline play keeps soloByConstruction and soloOfferable apart, and Play solo is the only door into a solo invite room');
}

// ---- 7e. THE MODE CARDS ARE PRECACHED UNDER THE URL BAY.JS ASKS FOR --------
// The mode cards are stills from the game (owner, 2026-10-07; made by
// tools/cards/capture.mjs), one per mode for each place a card is shown:
// 'board' (home), 'tall' (Mission board), 'wide' (Match setup). bay.js asks for
// each with its own ?v= stamp, read from its script tag (ASSET_V), and a cache
// answers only the exact URL it holds -- so sw.js must list every one under the
// stamp index.html loads bay.js with. A card listed bare, or still under the
// last release's stamp, would be missing offline with nothing louder than a
// broken picture. Also held here: every card is on disk, really is a WebP, and
// keeps to the 120 KB budget, and no screen has gone back to the old art().
{
  const bay = read('public/bay.js'), sw = read('public/sw.js'), html = read('public/index.html');
  const stamp = (html.match(/bay\.js\?v=(\d+)/) || [])[1];
  const block = sw.match(/const SHELL = \[([\s\S]*?)\]/);
  const shell = block ? (block[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)) : [];
  const at = bay.indexOf('const MODES = [');
  const modes = at < 0 ? '' : bay.slice(at, bay.indexOf('\n];', at));
  const cards = [...modes.matchAll(/\bcard: '([a-z0-9-]+)'/g)].map(m => m[1]);
  const bad = [];
  if (!stamp) bad.push('index.html loads bay.js with no ?v= stamp');
  if (cards.length !== 5) bad.push(`bay.js MODES names ${cards.length} cards, expected one for each of the 5 modes`);
  if (!/const cardArt = \(mode, shape\) => 'bay\/' \+ mode\.card \+ '-' \+ shape \+ '\.webp' \+ ASSET_V;/.test(bay)) {
    bad.push("bay.js cardArt no longer builds 'bay/<card>-<shape>.webp' plus ASSET_V");
  }
  if (!/const ASSET_V = [\s\S]{0,120}document\.currentScript\.src/.test(bay)) bad.push("bay.js ASSET_V no longer reads the stamp from bay.js's own script tag");
  if (/\bart\((?:x|m|mode)\.card\)/.test(bay)) bad.push('bay.js draws a mode card with art(), the old .jpg path');
  for (const c of cards) for (const shape of ['board', 'tall', 'wide']) {
    const f = `bay/${c}-${shape}.webp`;
    const p = path.join(ROOT, 'public', f);
    if (!existsSync(p)) { bad.push(`${f} is missing`); continue; }
    const b = readFileSync(p);
    if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') bad.push(`${f} is not a WebP`);
    if (b.length > 120000) bad.push(`${f} is ${b.length} bytes, over the 120 KB budget`);
    if (stamp && !shell.includes(`${f}?v=${stamp}`)) bad.push(`sw.js SHELL does not precache ${f}?v=${stamp}`);
  }
  const stale = shell.filter(u => u.startsWith('bay/card-') && !u.endsWith(`?v=${stamp}`));
  if (stale.length) bad.push(`sw.js SHELL lists mode cards under another stamp: ${stale.join(', ')}`);
  if (bad.length) fail(`the mode cards and the offline shell disagree:\n      ${bad.join('\n      ')}`);
  else ok(`the ${cards.length * 3} mode-card stills are WebP, within 120 KB, and precached under bay.js's ?v=${stamp}`);
}

// ---- 8. VERSION MUST AGREE ACROSS ALL THREE PROJECTS (ISSUE-016) ------------
// package.json is the source; `npm run version:sync` pushes it into the native
// projects. Nothing forces anyone to run it, and the failure is invisible
// locally — the app builds and runs perfectly with a stale version. It surfaces
// at store upload, as a rejection whose message does not name the file to edit.
// They were ALREADY out of step the day the native projects were generated
// (package.json 0.2.0 vs both native at 1.0), which is why this is a test.
{
  const pkg = JSON.parse(read('package.json'));
  const grab = (src, re) => { const m = src.match(re); return m ? m[1].trim() : null; };
  const gradle = read('android/app/build.gradle');
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj');

  const want = { version: String(pkg.version || ''), build: String(pkg.build ?? '') };
  const got = {
    'android versionName': grab(gradle, /versionName\s+"([^"]*)"/),
    'android versionCode': grab(gradle, /versionCode\s+(\d+)/),
    'ios MARKETING_VERSION': grab(pbx, /MARKETING_VERSION = ([^;]+);/),
    'ios CURRENT_PROJECT_VERSION': grab(pbx, /CURRENT_PROJECT_VERSION = ([^;]+);/),
  };

  const bad = [];
  if (!/^\d+\.\d+\.\d+$/.test(want.version)) bad.push(`package.json version must be x.y.z, got '${want.version}'`);
  if (!/^\d+$/.test(want.build)) bad.push(`package.json build must be a positive integer, got '${want.build}'`);
  for (const [k, v] of Object.entries(got)) {
    const expect = k.includes('Name') || k.includes('MARKETING') ? want.version : want.build;
    if (v === null) bad.push(`${k} not found`);
    else if (v !== expect) bad.push(`${k} is '${v}', package.json says '${expect}'`);
  }
  // Both iOS build configurations carry their own copy; a sync that updated
  // only one would still pass a first-match check.
  const mv = [...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(m => m[1].trim());
  if (mv.length && new Set(mv).size !== 1) bad.push(`iOS build configurations disagree: MARKETING_VERSION = ${[...new Set(mv)].join(' vs ')}`);
  const cv = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map(m => m[1].trim());
  if (cv.length && new Set(cv).size !== 1) bad.push(`iOS build configurations disagree: CURRENT_PROJECT_VERSION = ${[...new Set(cv)].join(' vs ')}`);
  // The web client's copy (8.52): crash reports carry it, so a stale stamp
  // silently mislabels every report from the drifted build.
  const cc = grab(read('public/config.js'), /window\.CC_VERSION = '([^']*)';/);
  if (cc === null) bad.push('public/config.js CC_VERSION not found');
  else if (cc !== `${want.version}+${want.build}`) bad.push(`config.js CC_VERSION is '${cc}', package.json says '${want.version}+${want.build}'`);

  if (bad.length) fail(`version drift — run \`npm run version:sync\`:\n      ${bad.join('\n      ')}`);
  else ok(`version agrees everywhere (${want.version} build ${want.build})`);
}

// ---- 8b. THE OAuth RETURN DOMAIN MUST BE CLAIMED BY THE APP ------------------
// The native OAuth reply comes back to https://<CC_NATIVE_HOST>/auth/callback,
// and iOS only hands that to the app if the SAME host appears as an `applinks:`
// entry in App.entitlements. Point CC_NATIVE_HOST at a different host — staging,
// a rename, a typo — and nothing errors anywhere: the provider redirects, Safari
// loads a page, the app is never opened, and the player is left holding a token
// nothing will read. Every layer reports success.
//
// The server side is the same story: the association file names
// APPLE_TEAM_ID + '.' + NATIVE_APP_ID, so the bundle id must agree too.
{
  const grab = (src, re) => { const m = src.match(re); return m ? m[1].trim() : null; };
  const ent = read('ios/App/App/App.entitlements');
  const cfg = read('public/config.js');
  const host = grab(cfg, /window\.CC_NATIVE_HOST = '([^']*)';/);
  const links = [...ent.matchAll(/<string>applinks:([^<]+)<\/string>/g)].map((m) => m[1].trim());
  const bad = [];
  if (!host) bad.push('public/config.js has no CC_NATIVE_HOST');
  else if (!links.includes(host)) {
    bad.push(`config.js CC_NATIVE_HOST is '${host}' but App.entitlements claims ${links.length ? links.map((l) => `'${l}'`).join(', ') : 'nothing'}`);
  }
  const appId = grab(read('server.js'), /const NATIVE_APP_ID = '([^']*)';/);
  const pbxIds = [...read('ios/App/App.xcodeproj/project.pbxproj')
    .matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1].trim());
  if (!appId) bad.push('server.js has no NATIVE_APP_ID');
  else if (pbxIds.length && !pbxIds.every((v) => v === appId)) {
    bad.push(`server.js NATIVE_APP_ID is '${appId}' but the iOS project says ${[...new Set(pbxIds)].join(' / ')}`);
  }
  if (bad.length) fail(`the OAuth return would never reach the app:\n      ${bad.join('\n      ')}`);
  else ok(`OAuth return host is claimed by the app (applinks:${host}) and the bundle id agrees`);
}

// ---- 8c. A PLATFORM MAY NOT OFFER SIGN-IN IT CANNOT FINISH -------------------
// Sign-in was hidden on ALL native platforms until 2026-09-14 because the OAuth
// reply had no route back into a packaged app. Fixing that for iOS lifted the
// blanket check — and re-created the identical dead end on Android, where the
// manifest still has no App Links intent-filter: a visible button that leaves
// for a browser the player never returns from. It reached `main` before anyone
// noticed, because on web and iOS everything looks right.
//
// So the rule is the invariant, not the incident: app.js may only list a
// platform in SIGNIN_PLATFORMS once that platform can actually receive the
// reply. For Android that means an intent-filter, marked autoVerify, carrying
// the callback path.
{
  const app = read('public/app.js');
  const m = app.match(/const SIGNIN_PLATFORMS = \[([^\]]*)\];/);
  if (!m) {
    fail('public/app.js has no SIGNIN_PLATFORMS list — the sign-in gate has been removed or renamed');
  } else {
    const listed = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    // autoVerify AND the callback path: an intent-filter without verification
    // just opens Chrome on Android 12+, which is the same dead end.
    const androidReady = /android:autoVerify="true"/.test(manifest)
      && /android:path="\/auth\/callback"/.test(manifest);
    if (listed.includes('android') && !androidReady) {
      fail('app.js offers sign-in on ANDROID, but AndroidManifest has no verified App Links\n'
        + '      intent-filter for /auth/callback — the player would leave for a browser and\n'
        + '      never come back. Land the manifest (and ANDROID_CERT_SHA256) first.');
    } else if (!listed.includes('web')) {
      fail('SIGNIN_PLATFORMS does not include web — browser sign-in would be hidden');
    } else {
      ok(`sign-in is offered only where the reply can arrive (${listed.join(', ')})`);
    }
  }
}

// ---- 8d. THE IN-APP SIGN-IN CALLBACK MUST BE THE APP'S OWN, AND WIRED --------
// On iOS the provider leg runs in ASWebAuthenticationSession (CCWebAuthPlugin,
// ios/App/App/SceneDelegate.swift) and the reply comes back to CC_IOS_CALLBACK,
// a scheme URL. That is safe ONLY because the session intercepts it inside the
// app — so the scheme must never ALSO be registered with the OS, or any app
// could hand this one a token. And the value has to agree in places that never
// see each other: config.js (the string Supabase's allow-list holds), cloud.js
// (the plugin name it gates on must be the jsName Swift exports), app.js (the
// method it calls must be one Swift declares), and the scene delegate (which
// must install the subclass that registers the plugin — the storyboard alone
// does nothing). A drift in any of them is invisible in every test that does
// not run the sheet: the old Safari leg silently comes back, or the sheet opens
// and its reply is refused.
{
  const grab = (src, re) => { const m = src.match(re); return m ? m[1].trim() : null; };
  // Every native sign-in plugin the shell must export and register and the
  // client must call. The first is also what cloud.js gates the return URL on.
  const PLUGINS = [['CCWebAuth', 'start'], ['AppleSignIn', 'start']];
  const JS_NAME = PLUGINS[0][0];
  const cfg = read('public/config.js');
  const cloud = read('public/cloud.js');
  const app = read('public/app.js');
  const swift = read('ios/App/App/SceneDelegate.swift');
  const plist = read('ios/App/App/Info.plist');
  const cb = grab(cfg, /window\.CC_IOS_CALLBACK = '([^']*)';/);
  const path = grab(cloud, /const RETURN_PATH = '([^']*)';/);
  const pbxIds = [...new Set([...read('ios/App/App.xcodeproj/project.pbxproj')
    .matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1].trim()))];
  const bad = [];
  if (!cb) bad.push('public/config.js has no CC_IOS_CALLBACK');
  else if (!path) bad.push('public/cloud.js has no RETURN_PATH');
  else {
    const scheme = cb.split('://')[0];
    if (pbxIds.length !== 1 || scheme !== pbxIds[0]) {
      bad.push(`CC_IOS_CALLBACK scheme '${scheme}' is not the iOS bundle id (${pbxIds.join(' / ') || 'none found'})`);
    }
    if (cb !== scheme + '://' + path.replace(/^\//, '')) {
      bad.push(`CC_IOS_CALLBACK is '${cb}' but the callback path cloud.js uses is '${path}'`);
    }
    if (new RegExp('<string>' + scheme.replace(/\./g, '\\.') + '</string>').test(plist)) {
      bad.push(`Info.plist registers '${scheme}' as a URL scheme — the OS would route it to any app that claims it, the hole the sheet exists to close`);
    }
  }
  for (const [name, method] of PLUGINS) {
    // The method must be declared INSIDE that plugin's class, not anywhere in
    // the file: slice from its jsName to the next @objc( class, or the end.
    const at = swift.indexOf(`public let jsName = "${name}"`);
    if (at === -1) { bad.push(`SceneDelegate.swift exports no plugin named ${name}`); continue; }
    const next = swift.indexOf('@objc(', at);
    const cls = swift.slice(at, next === -1 ? undefined : next);
    if (!cls.includes(`CAPPluginMethod(name: "${method}", returnType: CAPPluginReturnPromise)`)) {
      bad.push(`${name} declares no promise-returning '${method}' method`);
    }
    if (!swift.includes(`registerPluginInstance(${name}Plugin())`)) {
      bad.push(`SceneDelegate.swift never registers ${name}Plugin — JS would see no plugin and fall back to the web flow`);
    }
    if (!app.includes(`Plugins.${name}.${method}(`)) bad.push(`app.js never calls Capacitor.Plugins.${name}.${method}()`);
  }
  if ((swift.match(/class CCBridgeViewController/g) || []).length !== 1) {
    bad.push('there must be exactly ONE CCBridgeViewController — every plugin registers in its capacitorDidLoad()');
  }
  if (!/window\?\.rootViewController = CCBridgeViewController\(\)/.test(swift)) {
    bad.push('SceneDelegate does not install CCBridgeViewController as rootViewController — the registering subclass is never used');
  }
  if (!cloud.includes(`Plugins.${JS_NAME}`)) bad.push(`cloud.js does not gate on Capacitor.Plugins.${JS_NAME}`);
  if (bad.length) fail(`the in-app sign-in sheet is mis-wired:\n      ${bad.join('\n      ')}`);
  else ok(`in-app sign-in callback is the app's own (${cb}), unregistered with the OS; ${PLUGINS.map((p) => p[0]).join(' + ')} exported, registered and called`);
}

// ---- 9. THE .hidden UTILITY MUST EXIST (8.55) --------------------------------
// `classList.add('hidden')` is the codebase's universal way to hide something,
// used on ~30 elements. Until 8.55 the stylesheet had NO generic rule for it —
// only per-element ones — so on any element without its own rule the call was a
// silent no-op. That shipped four times before anyone noticed, including the
// ISSUE-020 fix that was supposed to hide the nudge button in native builds and
// never did. The failure mode is invisible in JS (the class IS on the element,
// so classList.contains('hidden') returns true) and only shows up in computed
// style — which is exactly why it needs a static guard.
{
  const css = read('public/styles.css');
  // Match a standalone `.hidden { … display: none … }` rule, not `.foo.hidden`.
  const rule = css.match(/(^|\n)\s*\.hidden\s*\{([^}]*)\}/);
  if (!rule) {
    fail('public/styles.css has no generic `.hidden` rule — every classList.add(\'hidden\') on an element without its own rule is a silent no-op');
  } else if (!/display\s*:\s*none/.test(rule[2])) {
    fail(`the .hidden rule does not set display:none — it says {${rule[2].trim()}}`);
  } else {
    // Elements toggled via the class that ALSO carry .btn display rules need the
    // !important, or the more specific button rule wins.
    if (!/!important/.test(rule[2])) fail('.hidden sets display:none but without !important — .btn rules out-specify it');
    else ok('.hidden is a real hide utility (display:none !important)');
  }
}

// ---- 10. THE CLIENT MUST NOT IMPORT npm PACKAGES (DEBT-001 / ADR-007) --------
// public/ is served verbatim: no bundler, and Capacitor copies webDir without
// node_modules. A bare specifier — `import('@capacitor/push-notifications')` —
// therefore resolves NOWHERE, in the browser or the shell. It is seductive
// because the package really is installed for the native build, and it fails
// only at runtime, inside a try/catch, as a toast nobody attributes. Native
// plugins are reached through the Capacitor bridge instead.
{
  const bad = [];
  for (const file of ['public/app.js', 'public/cloud.js', 'public/errors.js', 'public/config.js', 'public/sw.js', 'public/intro.js']) {
    read(file).split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;                    // skip comments
      // static `from '…'` and dynamic `import('…')`, bare specifier only
      const m = line.match(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/)
             || line.match(/^\s*import\s.*?from\s+['"]([^'"]+)['"]/);
      if (m && !m[1].startsWith('.') && !m[1].startsWith('/')) {
        bad.push(`${file}:${i + 1}: bare import '${m[1]}'`);
      }
    });
  }
  if (bad.length) fail(`the client imports an npm package — nothing resolves it at runtime:\n      ${bad.join('\n      ')}`);
  else ok('client scripts import nothing from node_modules');
}

// ---- 11. THE BLOCKLIST NEVER REACHES THE WEB (server/blocklist.txt) --------
// server/blocklist.txt holds real slurs, verbatim, so foldForBlocklist() can
// match one as a substring of a folded callsign. Static files are served ONLY
// from public/, with a containment check in server.js
// (`if (!filePath.startsWith(PUBLIC))`), so nothing under server/ is
// web-reachable today — but that guarantee is only as good as three things
// that could each quietly break it: the file moving under public/, the
// containment check itself getting loosened, or something under public/
// naming the file (a stray `<script src="/server/blocklist.txt">` or a
// `fetch('/blocklist.txt')` would be a live pointer at a file the server would
// then happily serve — the containment check only blocks a path that escapes
// PUBLIC upward; it has no opinion on what PUBLIC itself chooses to link to).
{
  const BLOCKLIST_REL = 'server/blocklist.txt';
  const blocklistPath = path.join(ROOT, BLOCKLIST_REL);
  if (existsSync(blocklistPath)) ok(`${BLOCKLIST_REL} exists`);
  else fail(`${BLOCKLIST_REL} is missing`);

  const publicDir = path.join(ROOT, 'public');
  if (blocklistPath === publicDir || blocklistPath.startsWith(publicDir + path.sep)) {
    fail(`${BLOCKLIST_REL} resolves inside public/ — it would be served verbatim to any browser`);
  } else {
    ok(`${BLOCKLIST_REL} resolves outside public/, where nothing is servable`);
  }

  // The one line standing between server/ and the wire. If it is ever loosened
  // (say, to allow a new sibling of public/), this must fail loudly rather than
  // let server/ quietly ride along.
  const serverSrc = read('server.js');
  const GUARD = "if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }";
  if (serverSrc.includes(GUARD)) ok('server.js still refuses any static path that resolves outside PUBLIC');
  else fail('server.js no longer contains the PUBLIC containment check — server/ could become web-reachable');

  // Nothing under public/ may BE it or NAME it: not a same-named copy sitting
  // in public/ (every file gets walked, including binaries, and checked by
  // NAME), and no POINTER AT THE FILE inside a text file public/ actually ships
  // (binary assets — fonts, icons, photos — are not usefully readable as utf8
  // and are skipped for the content check only).
  //
  // The content match is the file, not the word. It was /blocklist/i, which also
  // fires on any client variable happening to be called `blocklist` — the Bay's
  // own Blocked list feature has every reason to declare one — and would have
  // failed the build with a message about a leaked slur file that has nothing to
  // do with what changed. A pointer at the file always spells the file:
  // `fetch('/blocklist.txt')`, `<script src="/server/blocklist.txt">`. The
  // FILENAME match below stays deliberately broad, because a copy under public/
  // is the severe case and may be named anything containing the word.
  const TEXT_EXT = new Set(['.js', '.html', '.css', '.webmanifest', '.svg', '.json', '.txt']);
  const walk = (dir) => {
    let files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files = files.concat(walk(full));
      else files.push(full);
    }
    return files;
  };
  const hits = [];
  for (const file of walk(publicDir)) {
    const rel = path.relative(ROOT, file);
    if (/blocklist/i.test(path.basename(file))) hits.push(`${rel} (filename)`);
    if (TEXT_EXT.has(path.extname(file))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/blocklist\.txt|server[\/]blocklist/i.test(line)) hits.push(`${rel}:${i + 1}`);
      });
    }
  }
  if (hits.length) {
    fail(`public/ has a copy of, or a reference to, the blocklist — either would be served verbatim:\n      ${hits.join('\n      ')}`);
  } else {
    ok('nothing under public/ is named after the blocklist or points at the file, by filename or by path');
  }
}

// ---- NO BARE TIMERS IN THE ENGINE -------------------------------------------
// A timer callback runs detached, so a throw inside one is caught by nothing and
// reaches process 'uncaughtException' — whose handler in server.js shuts the
// process down and destroys EVERY live match, not just the room that faulted.
// room-engine.js schedules almost everything that runs unattended (the bot
// chain, fire and gas ticks, drop and empty-room reclaim), so this is the
// difference between one broken match and a server-wide outage.
//
// safeTimeout/safeInterval wrap the callback and route the fault to the host.
// The two helpers are the ONLY places a bare timer is allowed.
{
  const src = read('public/room-engine.js').split('\n');
  const bare = [];
  src.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;                       // skip comments
    if (!/\b(setTimeout|setInterval)\s*\(/.test(line)) return;
    // The two helpers are the only legitimate bare timers, marked explicitly.
    // This used to match their exact source text with a regex, which broke the
    // moment safeInterval grew a body (to clear a faulting handle) — the rule
    // then failed on the very function it exists to enforce. A marker cannot
    // drift with the code's shape.
    if (/BARE-TIMER-OK/.test(line)) return;
    bare.push(`public/room-engine.js:${i + 1}: ${line.trim().slice(0, 76)}`);
  });
  if (bare.length) {
    fail(`bare timer in the engine — a throw there kills every live match; use safeTimeout/safeInterval:\n      ${bare.join('\n      ')}`);
  } else {
    ok('engine schedules only through safeTimeout/safeInterval');
  }
}

// ---- 12. THE PHASE 6 SOCIAL TABLES ARE SERVICE-KEY ONLY ----------------------
// friendships, friend_requests, blocks and name_reports hold the social graph:
// who knows whom, who refused whom, and who reported whom. A missing
// `enable row level security` on any of them publishes that graph to every
// signed-in player through PostgREST; a `create policy` does the same on
// purpose. NEITHER shows up in any test that talks to the game server, because
// the server holds the secret key and cannot tell the difference — it reads the
// table happily either way. So the rule is enforced on the migration TEXT,
// which is the only artefact a headless suite can reach at all.
//
// The cascades matter for the same reason account deletion does: a row that
// outlives its auth.users row is a permanent record of a deleted account, and
// the deletion path promises there is none.
//
// The column grants are here for a different reason, and it is the sharpest one
// in this file. profiles is an EXISTING CLIENT-WRITABLE table: profiles_update_own
// lets a signed-in player PATCH their own row straight from the browser, and
// public/cloud.js save() does exactly that on every cloud save. An RLS policy
// decides WHICH ROWS, never which COLUMNS. So if callsign_key or callsign_set_at
// is still writable by `authenticated`, a modified client sets its own uniqueness
// key and resets its own daily limit WITHOUT EVER SENDING A SOCKET FRAME, and
// every rule the server enforces above them is decoration. Nothing else in this
// repo can see that: the server-side tests all go through the socket path, which
// is the path being bypassed.
{
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const hits = readdirSync(dir).filter((f) => /_phase6_callsigns_and_friends\.sql$/.test(f));
  if (hits.length !== 1) {
    fail(`expected exactly 1 supabase/migrations/*_phase6_callsigns_and_friends.sql, found ${hits.length}`);
  } else {
    const sql = readFileSync(path.join(dir, hits[0]), 'utf8');
    const bad = [];
    for (const t of ['friendships', 'friend_requests', 'blocks', 'name_reports']) {
      if (!new RegExp(`create table public\\.${t} \\(`).test(sql)) bad.push(`${t}: no "create table public.${t} ("`);
      if (!new RegExp(`alter table public\\.${t} enable row level security`).test(sql)) {
        bad.push(`${t}: no "enable row level security" — every signed-in player could read the table`);
      }
    }
    if (/create\s+policy/i.test(sql)) {
      bad.push('a "create policy" — these four tables are service-key only, no client may reach a row of them');
    }
    // Every user column is `references auth.users (id) on delete cascade`. Match
    // the reference and then look for the cascade on the SAME clause, so a
    // cascade elsewhere in the file cannot vouch for one that is missing here.
    const refs = sql.match(/references auth\.users ?\([^)]*\)[^,\n]*/g) || [];
    if (refs.length !== 8) bad.push(`expected 8 auth.users references (2 per table), found ${refs.length}`);
    const loose = refs.filter((r) => !/on delete cascade/.test(r));
    if (loose.length) bad.push(`auth.users reference without "on delete cascade": ${loose.join(' | ')}`);
    // ALL THREE new columns, not just the first one. If callsign_key or
    // callsign_set_at were dropped from the ALTER, every grant check below would
    // still pass — VACUOUSLY, because a column that does not exist cannot be
    // named in a grant, and "neither grant names the three new columns" is then
    // true for the emptiest possible reason. This is the assertion that stops
    // that, so it has to come first.
    //
    // friend_code and callsign_key must both be UNIQUE. BINDING.md resolution 5
    // says nullable AND unique and only the nullable half was pinned before:
    // ensureFriendCode's retry loop exists to catch the unique violation, and
    // callsign_key IS the uniqueness key — without the constraint two players
    // hold the same chosen name and the server's "is it taken?" check is a race
    // it cannot win.
    //
    // friend_code stays NULLABLE on purpose: a NOT NULL column with no default
    // makes a data-only pg_dump taken before it existed unrestorable, and
    // tools/backup/restore-drill.sh loads exactly such a dump. The server fills
    // it on first use instead (ensureFriendCode).
    const newCols = {};
    for (const c of ['friend_code', 'callsign_key', 'callsign_set_at']) {
      const m = sql.match(new RegExp(`add column ${c}\\b[^,;]*`));
      if (!m) {
        bad.push(`no "add column ${c}" on public.profiles — the column never exists, and with it absent`
          + ' the grant checks below pass vacuously');
      } else newCols[c] = m[0];
    }
    for (const c of ['friend_code', 'callsign_key']) {
      if (newCols[c] && !/\bunique\b/i.test(newCols[c])) {
        bad.push(`public.profiles.${c} is not UNIQUE — two rows can hold the same value, which is the`
          + ' one thing this column exists to prevent');
      }
    }
    if (newCols.friend_code && /not null/i.test(newCols.friend_code)) {
      bad.push('friend_code is NOT NULL — every backup taken before this column existed stops restoring');
    }
    // Comments are stripped before anything reads a STATEMENT's shape; the note
    // in the grants block below says why that is not cosmetic.
    const stmts = sql.replace(/--[^\n]*/g, '');
    // The whole file is one transaction, so the ACCESS EXCLUSIVE lock the first
    // ALTER takes on profiles is held to COMMIT — and a WAITING exclusive request
    // queues every cloud save and sign-in that arrives behind it. Five seconds of
    // lock_timeout turns a possible outage into a clean rollback, but only if it
    // runs BEFORE the ALTER it is protecting.
    const lockAt = stmts.search(/set local lock_timeout\s*=\s*'5s'/i);
    const firstAlterAt = stmts.search(/alter table public\.profiles/i);
    if (lockAt < 0) {
      bad.push('no "set local lock_timeout = \'5s\'" — if anything is mid-query on profiles when this'
        + ' runs, the first ALTER waits instead of failing, and every cloud save and sign-in queues'
        + ' behind it for as long as that takes');
    } else if (firstAlterAt >= 0 && firstAlterAt < lockAt) {
      bad.push('"set local lock_timeout" comes AFTER the first ALTER on public.profiles — the lock it'
        + ' is meant to bound has already been taken by then');
    }
    // The 14 -> 16 cap swap. Nothing else in this repo can see it: the cap lives
    // only in the database. Delete the do $$ block that drops the old unnamed
    // 14-character CHECK, or the named 16 that replaces it, and every CHOSEN
    // callsign of 15 or 16 characters is rejected on production — the player sees
    // "unavailable" and nobody can explain it — while this suite stays green.
    if (!/alter table public\.profiles drop constraint/i.test(sql)) {
      bad.push('the old unnamed 14-character CHECK on public.profiles.callsign is never dropped —'
        + ' every chosen callsign of 15 or 16 characters would be rejected on production');
    }
    if (!/add constraint profiles_callsign_len[\s\S]{0,200}?char_length\(callsign\) <= 16/i.test(sql)) {
      bad.push('no named "profiles_callsign_len" CHECK capping public.profiles.callsign at 16 — the'
        + ' display-name cap never moves from 14 to 16, or moves to some other number');
    }
    // friendships stores one row per PAIR in uuid order, and this CHECK is the
    // only thing that makes that invariant real. Without it the same pair goes in
    // both ways round and the unfriend path leaves the mirror row behind: two
    // people who cannot see each other in their lists and cannot remove what is
    // left. The migration's own comment describes this bug; nothing pinned it.
    if (!/check \(user_a < user_b\)/i.test(sql)) {
      bad.push('friendships has no "check (user_a < user_b)" — the same pair can then be stored both'
        + ' ways round, and unfriending leaves the mirror row behind');
    }
    // The six indexes, by name. Each covers the half of a lookup that the table's
    // primary key or unique constraint does NOT: my friendships where I am
    // user_b, requests I RECEIVED, the 30-day expiry sweep, who has blocked ME,
    // and the two report reads. Dropping one is invisible until the table is big
    // enough for the sequential scan to hurt, which is the worst moment to learn.
    const wantIdx = [
      ['friendships_user_b_idx', 'public.friendships (user_b)'],
      ['friend_requests_to_user_idx', 'public.friend_requests (to_user)'],
      ['friend_requests_created_at_idx', 'public.friend_requests (created_at)'],
      ['blocks_blocked_idx', 'public.blocks (blocked)'],
      ['name_reports_reported_idx', 'public.name_reports (reported, created_at desc)'],
      ['name_reports_reporter_idx', 'public.name_reports (reporter, reported, created_at desc)'],
    ];
    const missingIdx = wantIdx.filter(([n]) => !new RegExp(`create index ${n} on public\\.`).test(sql));
    if (missingIdx.length) {
      bad.push(`missing index, ${missingIdx.length} of the 6 this migration promises:`
        + ` ${missingIdx.map(([n, d]) => `${n} on ${d}`).join(' | ')}`);
    }
    // The three new profiles columns must be OUT of what `authenticated` may
    // write, and the only mechanism that can say so is a column privilege.
    // Four separate things have to hold, because getting any one of them wrong
    // produces a migration that SUCCEEDS and changes nothing, or that breaks
    // every cloud save in the game:
    //   1. the table-wide grant is revoked for BOTH verbs. Naming only UPDATE
    //      leaves the table-wide INSERT alive, and a column grant cannot narrow
    //      what a table grant already allows — so a modified client CREATES its
    //      profile row with callsign_key already set, taking a name and skipping
    //      the blocklist on the first save, the single write that matters most;
    //   2. the revoke comes BEFORE the column grants — Postgres only WARNS when
    //      a column-level revoke runs under a live table-level grant, so the
    //      wrong order is a no-op with a warning nobody reads;
    //   3. neither grant names the three new columns;
    //   4. BOTH grants name all four columns public/cloud.js save() writes. That
    //      is checked per grant, not across the pair: the upsert is an INSERT
    //      with an ON CONFLICT DO UPDATE, so a column missing from EITHER list
    //      fails the save, and a check that accepts "named in one of them" reads
    //      green while cloud saves die.
    //
    // Comments were stripped into `stmts` above. This migration argues about
    // grants at length in prose, and `[^;]*` runs happily through comment lines,
    // which have no semicolons — so without that strip a paragraph that says
    // "grant" can reach a real GRANT statement several lines later and swallow
    // everything between. Not hypothetical: it reported friend_code as granted,
    // from a sentence explaining that friend_code is only ever READ by the client.
    const revoke = stmts.match(/revoke\b([^;]*?)\bon public\.profiles from authenticated/i);
    const revokeAt = revoke ? revoke.index : -1;
    const grantAt = stmts.search(/grant\s+(?:insert|update)\b[^;]*on public\.profiles to authenticated/i);
    if (!revoke) {
      bad.push('no "revoke insert, update on public.profiles from authenticated" — a modified client could'
        + ' write its own callsign_key and callsign_set_at straight from the browser, taking a name'
        + ' and resetting its own daily limit without ever sending a socket frame');
    } else {
      const kept = ['insert', 'update'].filter((v) => !new RegExp(`\\b${v}\\b`, 'i').test(revoke[1]));
      if (kept.length) {
        bad.push(`the table-wide REVOKE on public.profiles does not name ${kept.join(' or ').toUpperCase()}`
          + ' — that table-wide grant survives, and a column grant cannot narrow what a table grant already'
          + ' allows. For INSERT that means a modified client creates its own profile row with callsign_key'
          + ' already set, on the first save, without ever sending a socket frame');
      }
      if (grantAt >= 0 && grantAt < revokeAt) {
        bad.push('the column GRANT on public.profiles comes BEFORE the table-wide REVOKE — Postgres only'
          + ' warns on a column revoke under a table grant, so nothing is actually revoked');
      }
    }
    for (const verb of ['insert', 'update']) {
      const g = stmts.match(new RegExp(`grant\\s+${verb}\\b([^;]*)on public\\.profiles to authenticated`, 'i'));
      if (!g) {
        bad.push(`nothing is granted back: no "grant ${verb} (...) on public.profiles to authenticated"`
          + ' — public/cloud.js save() is an upsert, so it needs both INSERT and UPDATE on its columns'
          + ' and cloud saves would stop working for every player');
        continue;
      }
      const cols = g[1];
      const leaked = ['friend_code', 'callsign_key', 'callsign_set_at']
        .filter((c) => new RegExp(`\\b${c}\\b`).test(cols));
      if (leaked.length) {
        bad.push(`granted ${verb.toUpperCase()} to authenticated on public.profiles: ${leaked.join(', ')}`
          + ' — the client must never write these; the server with the secret key is the only writer');
      }
      for (const c of ['id', 'callsign', 'progression', 'progression_version']) {
        if (!new RegExp(`\\b${c}\\b`).test(cols)) {
          bad.push(`public.profiles.${c} is missing from the ${verb.toUpperCase()} grant —`
            + ' public/cloud.js save() writes it on every cloud save and would start failing');
        }
      }
    }
    if (bad.length) fail(`${hits[0]}:\n      ${bad.join('\n      ')}`);
    else {
      ok(`${hits[0]}: lock_timeout before the first ALTER, 4 social tables, RLS on each, no policies,`
        + ' 8 cascading auth.users refs (2 per table), the 6 named indexes, friendships ordered by'
        + ' check (user_a < user_b), callsign capped at 16, and the 3 new profiles columns'
        + ' (friend_code and callsign_key unique, friend_code nullable) with INSERT and UPDATE'
        + ' revoked table-wide from authenticated and granted back by column');
    }
  }
}

// ---- 13. THE SOCIAL LAYER'S SERVER-SIDE WIRING -------------------------------
// Three lines in server.js that no other test in this repo can see, because
// every one of them is only observable against a real Supabase.
//
// (a) A GUEST HAS AN ACCOUNT ID. public/cloud.js mints an ANONYMOUS Supabase
//     account for every player who saves anything, so `!ws.userId` is not
//     "guest" (BINDING.md resolution 1). The gate in server/social.js reads
//     ws.isGuest and test/social.mjs pins that half — but NOTHING pins the half
//     that SETS it. If the auth sink stops reading is_anonymous, or stops
//     recording it, every gate downstream still runs, still looks right, and
//     lets every guest choose a callsign. Both halves were confirmed by hand
//     against a fake GoTrue: with either line broken an anonymous account wrote
//     `callsign_key` to the database. These assertions are what keeps that
//     from coming back silently.
//
// (b) The kind must FAIL CLOSED. `u.is_anonymous !== false` treats a missing or
//     malformed field as anonymous, so a GoTrue that stops sending it costs a
//     linked player the friends panel rather than handing a guest a name that
//     reaches other people's screens.
//
// (c) sbAdmin had NO fetch timeout while its only callers were push and crash
//     reporting, which fire rarely and from the server's own timers. Every
//     social frame from every signed-in socket is now a path to that fetch, and
//     an unbounded wait there is the measured RISK-014 OOM: 8 sockets against a
//     hanging upstream took RSS from 64 MB to 191 MB in ten seconds with no
//     recovery (BINDING.md resolution 4). The sibling sbUserFromToken carries
//     the signal already; this asserts sbAdmin does too.
{
  const src = read('server.js');
  const bad = [];

  // The sbAdmin body, from its declaration to the next top-level close, so a
  // signal on a DIFFERENT fetch elsewhere in the file cannot vouch for this one.
  const start = src.indexOf('async function sbAdmin(');
  if (start < 0) {
    bad.push('no "async function sbAdmin(" in server.js — the social store is built over it');
  } else {
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end < 0 ? src.length : end);
    if (!/signal:\s*AbortSignal\.timeout\(\s*\d+\s*\)/.test(body)) {
      bad.push('sbAdmin\'s fetch carries no "signal: AbortSignal.timeout(...)" — a degraded PostgREST'
        + ' leaves one pending fetch per social frame, each holding its request, response and closure'
        + ' alive, and every signed-in socket can open them (RISK-014)');
    }
  }

  if (!/async function sbAccountFromToken\(/.test(src)) {
    bad.push('no "async function sbAccountFromToken(" — the auth sink has no way to learn the ACCOUNT'
      + ' KIND, and a guest is indistinguishable from a linked player');
  }
  if (!/anonymous:\s*u\.is_anonymous !== false/.test(src)) {
    bad.push('sbAccountFromToken does not read is_anonymous as "!== false" — either it ignores the'
      + ' field (every guest reads as linked) or it fails OPEN when GoTrue omits it');
  }

  // SCOPED TO THE SINK'S OWN BODY, and with its comments stripped, the way the
  // sbAdmin check above scopes itself. Matched against the whole file these
  // regexes were satisfied by a COMMENTED-OUT or otherwise dead copy of the
  // line anywhere in server.js, and said nothing about whether the line was on
  // the auth-sink path at all.
  //
  // THE TRADE, stated plainly: this is still source text. Stripping `//`
  // comments kills the commented-out copy, and the slice kills the
  // somewhere-else copy, but a live `if (false)` branch INSIDE the sink would
  // still satisfy it, and the regexes still pin exact wording (a semantically
  // identical rewording fails). What actually EXECUTES these lines is
  // test/auth_sink.mjs, which drives the real sink in a real server against a
  // mock GoTrue and PostgREST. This section is the cheap tripwire for the two
  // lines that suite cannot distinguish; it is not the proof.
  //
  // THE SINK IS A NAMED FUNCTION, helloSink, handed to setAuthSink, because the
  // push-subscription sink introduces a hello-less socket through it too (the
  // whole-branch fix wave). Both halves are pinned: the body is found by its
  // declaration, and it must really be the function the engine's hello calls.
  const sinkStart = src.indexOf('function helloSink(ws, token) {');
  let sink = '';
  if (sinkStart < 0 || !/^setAuthSink\(helloSink\);$/m.test(src)) {
    bad.push('no "function helloSink(ws, token) {" handed to "setAuthSink(helloSink);" in server.js —'
      + ' there is no auth sink to check, and every assertion below would pass vacuously against the'
      + ' rest of the file');
  } else {
    const sinkEnd = src.indexOf('\n}\n', sinkStart);
    sink = src.slice(sinkStart, sinkEnd < 0 ? src.length : sinkEnd)
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  }
  const inSink = (re) => sink && re.test(sink);

  if (sink && !inSink(/ws\.isGuest = acct\.anonymous;/)) {
    bad.push('the auth sink does not set ws.isGuest from the verified account — every social gate'
      + ' downstream then reads undefined and waves guests through');
  }
  // The sink must use the ACCOUNT helper, not the id-only one. Reverting this
  // one call reinstates the whole hole with nothing else looking different.
  if (sink && !inSink(/ws\.authPending = sbAccountFromToken\(token\)/)) {
    bad.push('the auth sink does not call sbAccountFromToken — sbUserFromToken returns an id and no'
      + ' kind, so ws.isGuest would never be set from a real verification');
  }
  // Cleared with the id on sign-out: a stale `false` left behind is a guest
  // holding the previous account's privileges.
  if (sink && !inSink(/ws\.userId = null; ws\.isGuest = false;/)) {
    bad.push('the sign-out branch does not clear ws.isGuest beside ws.userId — a socket that signs'
      + ' out of a linked account and back in as a guest keeps the linked account\'s privileges');
  }
  // (d) THE FLAG MUST BE READ, not merely written. Every assertion above is
  // satisfied by a sink that sets ws.isGuest perfectly and a layer downstream
  // that never looks at it — which is the same product as having no guest split
  // at all, and reads exactly as green. The reader is server/social.js's
  // requireLinked.
  const socialSrc = read('server/social.js')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  if (!/function requireLinked\([^)]*\)\s*\{[^}]*ws\.isGuest/.test(socialSrc)) {
    bad.push('server/social.js requireLinked does not read ws.isGuest — the auth sink can set the'
      + ' flag perfectly and nothing acts on it, which is the same product as no guest split');
  }
  // (e) THE CHOSEN NAME MUST PROVE ITSELF. `callsign_key` is server-only, but
  // `callsign` is a column the account may PATCH (the migration grants
  // update(id, callsign, ...) so public/cloud.js can write rolled names), so a
  // key-only test hands an unvalidated string to sanitizeName. The key is the
  // server's own normalised lowercase of what it stored, so it is the proof —
  // and it must be computed with server/callsign.js's own normaliser, because
  // a second hand-rolled copy drifts and drift here fails OPEN.
  // test/auth_sink.mjs proves the behaviour; this pins the shared normaliser.
  if (!/import \{[^}]*\bnormaliseCallsign\b[^}]*\} from '\.\/server\/callsign\.js'/.test(src)) {
    bad.push('server.js does not import normaliseCallsign from server/callsign.js — the auth sink'
      + ' cannot check a stored callsign against its own callsign_key with the SAME normalisation'
      + ' that wrote the key, and a second hand-rolled copy drifts open (see test/auth_sink.mjs)');
  }
  if (sink && !inSink(/normaliseCallsign\(/)) {
    bad.push('the auth sink sets ws.chosenName without normaliseCallsign — if it trusts callsign'
      + ' whenever callsign_key is non-null, any 16 characters the account PATCHes into its own'
      + ' row reach every opponent\'s screen with no socket frame sent (see test/auth_sink.mjs)');
  }

  if (bad.length) fail(`server.js social wiring:\n      ${bad.join('\n      ')}`);
  else {
    ok('server.js social wiring: sbAdmin\'s fetch is bounded by AbortSignal.timeout, and INSIDE the'
      + ' auth sink\'s own body (comments stripped) it verifies through sbAccountFromToken, reads'
      + ' is_anonymous fail-closed, records it as ws.isGuest, clears it on sign-out, and proves a'
      + ' stored callsign against its key with the shared normaliser — with server/social.js'
      + ' requireLinked actually reading the flag');
  }
}

// ---- 14. A SELECT THAT ASKS FOR `callsign` MUST ASK FOR `callsign_key` -------
// THIS RULE EXISTS BECAUSE THIS EXACT SELECT SHIPPED AND WAS FOUND EIGHT TASKS
// LATER. server.js's GET /history read `/profiles?...&select=id,callsign`, and
// public/bay.js painted the result as the opponent of a recent match on another
// player's home screen. `profiles.callsign` is writable by the account that owns
// it — the migration keeps `grant update (id, callsign, ...)` on purpose, so a
// cloud save can sync a rolled name — while `callsign_key` beside it is revoked
// from the authenticated role and is the only half the server may believe. A row
// fetched WITHOUT the key therefore cannot be proven at all: server/display-name.js
// has nothing to compare against and either refuses every chosen name or, as the
// shipped code did, shows whatever 16 characters the account wrote. Escaped, so
// never injection; impersonation and an unfiltered name (BINDING.md resolution 27).
//
// Written to catch a NEW call site, not the one that was fixed: every `select=`
// in server.js and server/*.js is parsed, `${CONST}` lists are expanded from the
// same file's string constants, and a list that cannot be resolved at all FAILS
// rather than being waved through — an unreadable select is exactly where the
// next one would hide. Selects that name `callsign_key` or `callsign_set_at`
// without the bare column (the /health probes) are not affected: the test is on
// the exact token `callsign`.
{
  const files = ['server.js', ...readdirSync(path.join(ROOT, 'server'))
    .filter((f) => f.endsWith('.js')).sort().map((f) => `server/${f}`)];
  const bad = [];
  let checked = 0, withCallsign = 0;
  for (const rel of files) {
    const src = read(rel);
    // String constants in the same file, so `select=${PROFILE_COLS}` resolves to
    // the columns it actually names instead of being unreadable.
    const consts = new Map();
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\n]*)\2/g)) consts.set(m[1], m[3]);
    src.split('\n').forEach((lineText, i) => {
      // A select list runs to the next '&' or to the end of the string literal
      // it sits in. Backticks, quotes and whitespace all end it.
      for (const m of lineText.matchAll(/select=([^&`'"\s]*)/g)) {
        checked++;
        let list = m[1];
        for (let pass = 0; pass < 3 && list.includes('${'); pass++) {
          list = list.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, name) => (consts.has(name) ? consts.get(name) : whole));
        }
        if (list.includes('${')) {
          bad.push(`${rel}:${i + 1} — a select list this rule cannot read: ${JSON.stringify(m[1])}.`
            + ' Spell the columns, or build them from a string const in the same file, so the'
            + ' callsign/callsign_key pairing can be checked');
          return;
        }
        const cols = list.split(',').map((c) => c.trim()).filter(Boolean);
        if (!cols.includes('callsign')) return;
        withCallsign++;
        if (!cols.includes('callsign_key')) {
          bad.push(`${rel}:${i + 1} — select asks for \`callsign\` without \`callsign_key\`: ${JSON.stringify(list)}.`
            + ' The account writes that column itself, so a row without the key cannot be proven and'
            + ' server/display-name.js has nothing to check the name against (BINDING.md resolution 27)');
        }
      }
    });
  }
  if (bad.length) fail(`unprovable callsign reads:\n      ${bad.join('\n      ')}`);
  else ok(`all ${checked} PostgREST select lists in server.js and server/*.js are readable, and each of the ${withCallsign}`
    + ' that asks for `callsign` also asks for `callsign_key` — no name can be fetched that the server cannot prove');
}

// ---- 15. NO SHIPPED DOCUMENT MAY CLAIM PLAYERS CANNOT TYPE ------------------
// ISSUE-015 (2026-08-04) removed the free-text callsign field and four documents
// were written around that fact. This feature REVERSES it (2026-09-18): a player
// types a name again, filtered, reportable and blockable. Every one of those
// sentences is now either a misdeclaration on a store form or a false statement
// in a privacy policy — the Australian Consumer Law exposure docs/LEGAL_POSITION.md
// exists to keep an eye on.
//
// THIS RULE USED TO BE A LIST OF EXACT PHRASES, AND IT FAILED ITS FIRST REAL
// TEST. store/STORE_LISTING.md:85 survived task 9 AND this rule because it said
// "no user-AUTHORED text" where the list said "no user-GENERATED text", "the
// input is readonly" where the list said "The callsign field is read-only", and
// "callsigns ARE GENERATED FROM the game's own word lists" where the list said
// "callsigns COME FROM" and "callsigns ARE PICKED FROM". Three near misses, zero
// hits, a green tick, and a false age-rating declaration one paste away from
// Apple and Google. A list of remembered phrasings is not a guard; it is a
// record of the mistakes somebody already found.
//
// So the rule tests the SHAPE of the claim instead, in three parts:
//
//   15a  a NEGATION standing next to the idea of a player AUTHORING TEXT
//        ("no user-authored text", "nobody can type a name", "never come from
//        the keyboard"). Proximity, not sentence-wide co-occurrence: a true
//        sentence may hold a negation AND the word "type" far apart, and does.
//   15b  a READ-ONLY claim about the name field, in any wording. This needs its
//        own rule because it carries no negation word at all.
//   15c  a claim about where callsigns COME FROM that does not, in the same
//        sentence, admit that a player may type one. This is the "require the
//        opposite claim to be present" half, and it is the only part that
//        catches a false sentence written with no negation anywhere, e.g.
//        "Every callsign is drawn automatically from the game word lists."
//
// Scanning is BY BLOCK, not by line: both file types hard-wrap their prose, so
// a claim written across a line break would walk past a line-by-line scan --
// which is the same class of hole as the phrase list, reached from the other
// direction. Two of the specimens below exist because a fault injection found
// exactly that, after this rule was first written.
//
// AND IT PROVES ITSELF ON EVERY RUN. The specimens below are the acceptance
// test: nine false claims, written nine different ways, that must all be
// caught, and eight true sentences from these same documents that must all
// pass. Weaken a pattern to let a new false sentence through and the self-test
// goes red; widen one until honest prose fails and it goes red too. That is the
// property the phrase list never had.
//
// SCOPE IS DELIBERATE: documents only (.md under store/, .html under public/).
// public/game-core.js MUST still discuss free-text names — recording why the
// decision flipped is that comment's whole job, and the file now also carries
// the shared profanity list — so it is not scanned here. HTML comments are
// blanked first (M14): a claim nobody renders is not a declaration, and a
// commented-out sentence must not be able to satisfy 15c either.
{
  const walk = (rel, ext, acc = []) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = rel + '/' + e.name;
      if (e.isDirectory()) walk(child, ext, acc);
      else if (e.name.endsWith(ext)) acc.push(child);
    }
    return acc;
  };
  const DOCS = [...walk('store', '.md'), ...walk('public', '.html')];

  // Vocabularies, not phrasings. Each is the set of words English gives you for
  // one idea, so rewording inside the idea does not escape.
  const NEG = '\\b(?:no|not|never|none|nothing|nobody|no-one|neither|nor|cannot|can\'t|without|unable|impossible|prevents?|prevented|disallow(?:s|ed)?|forbid(?:s|den)?)\\b';
  // "a person putting words in" — the compound forms first, then the bare verbs.
  const AUTHORING = /(?:(?:users?|players?|people|anyone|someone|human)[-\s](?:generated|authored|written|supplied|entered|created|provided|submitted|typed|chosen|picked)|free[-\s]?(?:text|form)|\btyp(?:e|es|ed|ing)\b|\bwrit(?:e|es|ing|ten)\b|\benter(?:s|ed|ing)?\b|\binputs?\b|\bauthors?(?:ed|ing)?\b|\beditable\b|\bedits?\b|\bkeyboard\b|\bsuppl(?:y|ies|ied|ying)\b|\bsubmit(?:s|ted|ting)?\b|\bcompose(?:s|d|ing)?\b|\bcontribute(?:s|d|ing)?\b|\bprovide(?:s|d)?\b)/i;
  // The thing authored. Deliberately NOT "field", "box" or "message": a true
  // sentence says "no message field" right beside "a typed callsign", and that
  // pairing is honest prose, not the claim this rule is about.
  const TEXTNOUN = /\b(?:text|content|names?|callsigns?|words?|strings?|characters?|letters?)\b/i;
  const READONLY = /read[-\s]?only|readonly|non-?editable|uneditable|not editable|cannot be (?:edited|typed|changed|written)/i;
  const NEARNAME = /\b(?:callsigns?|names?|inputs?|fields?|box|textbox)\b/i;
  const ORIGIN = /\bword[-\s]lists?\b/i;
  // What an origin claim must also say for it to be true today.
  const ADMITS_TYPING = /\btyp(?:e|es|ed|ing)\b|\bchoose\b|\bchoos(?:es|ing)\b|\bchose\b|\bchosen\b|\bset (?:one|their own|your own|a callsign|his own|her own)\b|\bown callsign\b/i;

  // A negation 30 characters before / 60 after the words for authoring text.
  // The window IS the rule: adjacency is what makes it a claim about typing
  // rather than two unrelated clauses that happen to share a sentence.
  // A negation governs its own CLAUSE, so ", and", ", so", ", but" end the
  // window too. Without that, "there is no message field in any mode, and a
  // typed callsign is checked on our server" reads as the claim and it is not
  // one — it is a sentence this project actually wants to be able to write.
  const CLAUSE = /,\s+(?:and|but|so|or|yet|while|whereas|though|although)\s+/i;
  const claims = (text) => {
    const hits = [];
    for (const s of text.split(/(?<=[.!?;:])\s+/).flatMap((x) => x.split(CLAUSE))) {
      const neg = new RegExp(NEG, 'gi');
      let m;
      while ((m = neg.exec(s))) {
        const win = s.slice(Math.max(0, m.index - 30), m.index + m[0].length + 60);
        if (AUTHORING.test(win) && TEXTNOUN.test(win)) { hits.push(['15a', win.trim()]); break; }
      }
    }
    const ro = new RegExp(READONLY.source, 'gi');
    let r;
    while ((r = ro.exec(text))) {
      const win = text.slice(Math.max(0, r.index - 60), r.index + r[0].length + 60);
      if (NEARNAME.test(win)) { hits.push(['15b', win.replace(/\s+/g, ' ').trim()]); break; }
    }
    for (const s of text.split(/(?<=[.!?])\s+/)) {
      if (ORIGIN.test(s) && !ADMITS_TYPING.test(s)) hits.push(['15c', s.replace(/\s+/g, ' ').trim()]);
    }
    return hits;
  };

  // --- the rule proves itself before it is trusted on the documents ---------
  const MUST_CATCH = [
    'There is no player-written text anywhere in the game; every callsign is issued by the game itself.',
    'Nobody can type a name of their own — the callsign box cannot be edited, so no words a person writes are ever shown to anyone else.',
    'Callsigns are assembled from our built-in word lists and never come from the keyboard, so the game carries no free-form content.',
    'Every callsign is drawn automatically from the game word lists.',
    // The sentence that actually got through, verbatim as it stood at 87bca14.
    "No gambling, no user chat, **no user-authored text of any kind** — callsigns are generated from the game's own word lists and the input is readonly (ISSUE-015), so nothing a player types can reach another player.",
    // The four phrasings the old list DID hold, so nothing it caught is lost.
    'The product contains no user-generated text.',
    'The callsign field is read-only.',
    'Names are rolled, not typed.',
    // Found by fault injection AFTER the vocabularies were first written: the
    // bare verbs stopped at type/write/enter, and this walked straight past.
    'Players never supply any text of their own.',
  ];
  const MUST_PASS = [
    'There is no chat and no message field of any kind; the only thing a player can type is their own callsign, which the server filters before anyone sees it.',
    "A callsign is either rolled from the game's word lists or typed by the player.",
    'A player who has not signed in keeps a rolled name and cannot set one of their own.',
    'Reporting and blocking do not need a signed-in account.',
    'You do not need to sign in to report or block.',
    'Roll takes a new name from the word lists; Set is how a signed-in player types one instead.',
    'There is no message field in any mode, and a typed callsign is checked on our server before it is stored.',
    // Pins the 30/60 window: a negation and a typing word in ONE clause, far
    // apart and unrelated. Sentence-wide co-occurrence reads this as the claim.
    'There is no review test account, because the only thing a signed-in player can type is a callsign and we can supply one on request.',
  ];
  const selfFail = [];
  MUST_CATCH.forEach((s, i) => { if (!claims(s).length) selfFail.push(`specimen ${i + 1} was NOT caught: ${JSON.stringify(s)}`); });
  MUST_PASS.forEach((s, i) => {
    const h = claims(s);
    if (h.length) selfFail.push(`true sentence ${i + 1} was wrongly caught by ${h[0][0]}: ${JSON.stringify(s)}`);
  });
  if (selfFail.length) {
    fail('the no-user-generated-text rule can no longer tell the claim from honest prose:\n      ' + selfFail.join('\n      '));
  }

  // BY BLOCK, NOT BY LINE. Both file types hard-wrap their prose, so a claim
  // written across a line break would walk past a line-by-line scan — the same
  // class of hole as the phrase list, arrived at from the other direction. A
  // block is a run of non-blank lines; it is reported by its first line number.
  // Markup is replaced by a space first, so `.</p>` cannot glue two sentences
  // into one and `**bold**` cannot split a word.
  const blocks = (rel) => {
    const src = read(rel).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    const lines = (rel.endsWith('.html') ? src.replace(/<[^>]*>/g, ' ') : src.replace(/\*\*|__|`/g, '')).split('\n');
    const out = [];
    let start = -1, buf = [];
    const flush = () => { if (buf.length) out.push([start + 1, buf.join(' ').replace(/\s+/g, ' ').trim()]); start = -1; buf = []; };
    lines.forEach((line, i) => {
      if (!line.trim()) { flush(); return; }
      if (start < 0) start = i;
      buf.push(line);
    });
    flush();
    return out;
  };
  const hits = [];
  for (const rel of DOCS) {
    for (const [line, text] of blocks(rel)) {
      for (const [which, what] of claims(text)) hits.push(`${rel}:${line} (${which}) ${JSON.stringify(what)}`);
    }
  }
  if (hits.length) {
    fail('a shipped document still says players cannot type their own callsign — ISSUE-015 was reversed 2026-09-18:\n      '
      + hits.join('\n      '));
  } else if (!selfFail.length) {
    ok(`no store or public document denies user-generated text (${DOCS.length} documents scanned by shape, not by phrase;`
      + ` ${MUST_CATCH.length} false specimens caught and ${MUST_PASS.length} true sentences passed on this run)`);
  }
}

// ---- 16. THE PRIVACY PAGE MUST DESCRIBE REPORT AND BLOCK --------------------
// Guideline 1.2 is satisfied by tools that exist AND are findable. The tools are
// in the app; the page a reviewer, a parent and a regulator actually read is
// this one, and it is the page both store listings point at. If a rewrite ever
// drops the section, the product quietly becomes user-generated content with no
// published mechanism — precisely the state ISSUE-015 deleted the field to avoid,
// except now the field is back.
//
// COMMENTS ARE BLANKED FIRST. `<!-- Report a callsign -->` renders nothing, so a
// rewrite that comments the section out rather than deleting it left this rule
// green while the page a reviewer reads had lost the mechanism (audit M14a).
{
  const src = read('public/privacy.html').replace(/<!--[\s\S]*?-->/g, ' ');
  const MUST = [
    ['Report a callsign', 'the reporting tool'],
    ['Block a player', 'the blocking tool'],
    ['support@abarabrothers.com', 'the published contact'],
    ['Name reports', 'name reports as a stored data category'],
    ['Friend code', 'the friend code as a stored data category'],
  ];
  const missing = MUST.filter(([n]) => !src.includes(n));
  if (missing.length) {
    fail('privacy.html no longer describes the Guideline 1.2 tools:\n      '
      + missing.map(([n, why]) => `${why} — "${n}" is not on the page`).join('\n      '));
  } else {
    ok('privacy.html names report, block, the contact, and the friends data categories');
  }
}

// ---- 17. THE PHASE 6 MIGRATION MUST STAY ONE TRANSACTION --------------------
// Added 2026-09-21, after measuring what the file did WITHOUT the wrapper it now
// has. Sent one statement at a time -- which is what the dashboard SQL editor
// may do, and the dashboard is one of the two routes the owner's own numbered
// steps offer him -- a failure part-way through COMMITTED the three new profiles
// columns and left all four tables absent. There is no `if not exists` anywhere
// in the file, so the next run cannot repair that: it is a half-applied schema a
// human has to unpick by hand, against a live production database.
//
// It survived every earlier review because task 2 verified the file with
// `psql --single-transaction`, which SUPPLIES THE VERY WRAPPER THE FILE LACKED.
// The test proved a property of the harness, not of the file. That is the same
// shape as the two suites this project already caught doing it, and it is why
// this rule reads the file itself rather than trusting how anyone ran it.
//
// COMMENTS ARE STRIPPED FIRST, on purpose. Section 12's positive assertions read
// the raw text, so a commented-out line satisfies them -- a hole the audit found
// and this rule must not copy.
{
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const hits = readdirSync(dir).filter((f) => /_phase6_callsigns_and_friends\.sql$/.test(f));
  if (hits.length !== 1) {
    fail(`section 17: expected exactly 1 phase 6 migration, found ${hits.length}`);
  } else {
    // Strip `--` line comments and blank lines, so only EXECUTABLE SQL is tested.
    const lines = readFileSync(path.join(dir, hits[0]), 'utf8')
      .split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean);
    const begins = lines.filter((l) => /^begin\s*;$/i.test(l)).length;
    const commits = lines.filter((l) => /^commit\s*;$/i.test(l)).length;
    const problems = [];
    if (begins !== 1) problems.push(`expected exactly 1 executable "begin;", found ${begins}`);
    if (commits !== 1) problems.push(`expected exactly 1 executable "commit;", found ${commits}`);
    if (begins === 1 && commits === 1) {
      // The wrapper only wraps if nothing executable escapes either end.
      if (!/^begin\s*;$/i.test(lines[0])) problems.push(`"begin;" is not the first executable statement (that is "${lines[0].slice(0, 60)}")`);
      if (!/^commit\s*;$/i.test(lines[lines.length - 1])) problems.push(`"commit;" is not the last executable statement (that is "${lines[lines.length - 1].slice(0, 60)}")`);
    }
    // No `if not exists` anywhere is WHY the wrapper is load-bearing: without it
    // a half-applied schema cannot be repaired by running the file again. If a
    // later edit adds one, this rule's reasoning changes and should be revisited
    // rather than silently left in place.
    if (problems.length) fail(`section 17: the phase 6 migration is not one transaction — ${problems.join('; ')}`);
    else ok('the phase 6 migration is wrapped in exactly one transaction, begin; first and commit; last');
  }
}

// ---- 18. NOTHING MAY NAME THE PANEL THAT WAS DELETED -------------------------
// The Bay's recent-match panel, the route that fed it and its suite went on
// 2026-09-30, after the Squad box took the home dashboard's left slot. What
// survives a deleted surface is PROSE, and this project has already shipped that
// fault: 63d4781 exists because test/security.mjs justified itself by citing a
// privacy.html sentence task 9 had deleted, and only a whole-project audit found
// it, because no suite reads a comment. Removing this panel left FIVE kinds of
// stale text behind -- a player-visible sentence in privacy.html, two store
// declarations read by app reviewers, the comments claiming
// server/display-name.js has two callers, a runner registration, and a CSS run
// with no producer. A grep found them once; this keeps them found.
//
// THE TOKENS ARE THE ONES THAT CANNOT BE ANYTHING ELSE. `/history` is a route
// that no longer exists. `history.mjs` is a file that no longer exists.
// `sortie` is that panel's word and appears in no live copy. `.sor` and
// `#bay .res` are its two CSS classes, and nothing else produced either.
// `data-rematch`/`dataset.rematch` is its chip. THE IN-MATCH REMATCH IS A
// DIFFERENT, LIVE FEATURE -- #rematchBtn, app.js's rematchBtn.onclick, the
// engine's `case 'rematch'` and test/rematch.mjs -- and none of those spellings
// is matched here.
//
// test/house-rules.mjs is deliberately NOT in the list. Rule 14's comment
// explains, in the past tense, that a select without callsign_key really did
// ship on that route; history is not a claim about the present, and that rule
// still guards every remaining and future select.
{
  const FILES = ['public/bay.js', 'public/app.js', 'public/styles.css', 'public/privacy.html',
    'server.js', 'server/social.js', 'server/display-name.js',
    'store/STORE_LISTING.md', 'store/REVIEW_NOTES.md',
    'test/run-all.sh', 'test/display_name.mjs', 'test/health.mjs', 'test/offline.mjs'];
  const GONE = [
    [/\/history\b/, 'the deleted route'],
    [/\bhistory\.mjs\b/, 'the deleted suite'],
    [/sortie/i, "the deleted panel's name"],
    [/\.sor\b/, "the deleted panel's row class"],
    [/#bay \.res\b/, "the deleted panel's result badge"],
    [/data-rematch|dataset\.rematch/, "the deleted panel's rematch chip"],
  ];
  const hits = [];
  for (const rel of FILES) {
    read(rel).split('\n').forEach((line, i) => {
      for (const [re, what] of GONE) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} names ${what} — ${line.trim().slice(0, 100)}`);
      }
    });
  }
  if (hits.length) {
    fail(`the recent-match panel is gone; ${hits.length} place(s) still name it or the route it fed:\n      `
      + hits.join('\n      '));
  } else {
    ok(`none of the ${FILES.length} shipped and test files names the deleted panel, its route, its suite,`
      + ' its two CSS classes or its rematch chip');
  }
}

// ---- 19. WHAT A NUDGE IS FOR IS SAID WHERE IT IS ASKED FOR (fix wave E6, B4) --
// Since squads, a friend's squad invite reaches an offline player through the
// same push subscription as a turn nudge (server.js pushSquadInvite), and the
// player's one consent covers both (no separate toggle, E6). So every place
// that asks for that consent or describes it must name both purposes: the
// policy's table row, its legal basis and its section, the Bay controls row
// that turns it on, the toast that confirms it, the legacy button and the
// store declaration. And the policy names every web push operator a
// subscription can go to: Edge's goes to Microsoft (Windows Push Notification
// Services), which the page left out (B4). Comments are blanked first, as in
// rule 16: a commented-out sentence tells a reader nothing. Every run of white
// space is read as one space, so a sentence the page wraps still matches.
{
  const flat = (rel) => read(rel).replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ');
  const privacy = flat('public/privacy.html'), store = flat('store/STORE_LISTING.md');
  const MUST = [
    ['public/privacy.html', privacy, /<tr><td>Push subscription[^<]*<\/td><td>[^<]*squad invites from friends/, 'its data table says a push subscription also delivers squad invites from friends'],
    ['public/privacy.html', privacy, /Notifications \(your turn, and squad invites from friends\): your consent/, 'its legal bases name both purposes under consent'],
    ['public/privacy.html', privacy, /<h2>Notifications<\/h2>/, 'its section is "Notifications", not "Turn notifications"'],
    ['public/privacy.html', privacy, /Microsoft[^<]*Windows Push Notification Services[^<]*Edge/, 'it names Microsoft (Windows Push Notification Services, for Edge) among the push operators'],
    ['public/bay.js', flat('public/bay.js'), /\['notify', 'Nudges', notifyHidden \? '[^']*' : 'Your turn, and squad invites from friends'/, 'the Bay controls row that turns nudges on names both purposes'],
    ['public/app.js', flat('public/app.js'), /case 'pushOk': showToast\('Nudges on: your turn, and squad invites from friends\.'\)/, 'the toast that confirms the opt-in names both purposes'],
    ['public/index.html', flat('public/index.html'), /Nudge me for my turn and squad invites/, 'the legacy opt-in button names both purposes'],
    ['store/STORE_LISTING.md', store, /opt-in nudges for your turn and for squad invites from friends/, 'the store declaration names squad invites from friends'],
    ['store/STORE_LISTING.md', store, /Apple\/Google\/Microsoft\/Mozilla push services/, 'the store processors list names Microsoft'],
  ];
  const missing = MUST.filter(([, src, re]) => !re.test(src));
  // And no sentence still gives the subscription ONE purpose.
  const STALE = [
    ['public/privacy.html', privacy, /Delivering "your turn" notifications/],
    ['public/privacy.html', privacy, /Turn notifications: your consent/],
    ['public/privacy.html', privacy, /operated by Apple, Google or Mozilla\)/],
    ['store/STORE_LISTING.md', store, /opt-in turn nudges\./],
  ].filter(([, src, re]) => re.test(src));
  if (missing.length || STALE.length) {
    fail('a nudge is described as turns only, or a push operator is missing:\n      '
      + missing.map(([rel, , , why]) => `${rel}: ${why}`).concat(STALE.map(([rel, , re]) => `${rel} still says ${re}`)).join('\n      '));
  } else {
    ok(`every place that asks for or describes the nudge consent names turns AND squad invites from friends (${MUST.length} checks), and the policy names Microsoft for Edge`);
  }
}

// ---- 20. public/ NEVER TALKS TO THE SOCIAL TABLES DIRECTLY -------------------
// Cross-cutting rule 1 of the design: no client ever reads or writes the social
// tables. Every social action is a socket frame the server executes with its
// secret key. Section 12 proves those tables are service-key only IN THE
// MIGRATION; this proves the client never even tries -- the half that would
// silently start working the day anyone adds a policy, and the half the squad
// feature is most likely to break, because the Squad box is the first panel that
// renders the friend graph and public/cloud.js already holds a working PostgREST
// caller with the player's own token in it.
//
// MATCH THE REST SHAPE, NEVER THE BARE TABLE NAME. Section 11 records what the
// bare word costs: /blocklist/i would fire on a legitimate client variable and
// fail the build with a message about a leaked slur file. The words `blocks`,
// `friends` and `name reports` are all over public/ for honest reasons --
// privacy.html and delete-account.html list what an account holds in exactly
// those words, and bay.js renders the Blocked list. A pointer at a TABLE always
// spells a REST path: either the literal `/rest/v1/blocks`, or cloud.js's
// helper shape `rest('/blocks?...')`, which builds `BASE + '/rest/v1' + path`
// and so never contains the join.
//
// THE RAW TEXT IS READ ON PURPOSE, AND A COMMENTED-OUT CALL STILL FAILS. This
// rule is NEGATIVE -- it fails on FINDING something -- so stripping comments
// would be the hole here, not the fix. Section 17 strips them because its
// assertions are POSITIVE and a commented-out `begin;` satisfied a positive
// read; the two are opposite shapes and want opposite treatment. A commented-out
// fetch('/rest/v1/blocks') is a working call one keystroke away, sitting in a
// file that ships to every browser, and it is caught here.
{
  const TABLES = ['friendships', 'friend_requests', 'blocks', 'name_reports'];
  const TEXT_EXT = new Set(['.js', '.html', '.css', '.webmanifest', '.svg', '.json', '.txt']);
  const publicDir = path.join(ROOT, 'public');
  const walk = (dir) => {
    let files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files = files.concat(walk(full));
      else files.push(full);
    }
    return files;
  };
  const literal = new RegExp(`/rest/v1/(?:${TABLES.join('|')})\\b`);
  const helper = new RegExp(`\\brest\\s*\\(\\s*['"\`]/(?:${TABLES.join('|')})\\b`);
  const hits = [];
  for (const file of walk(publicDir)) {
    if (!TEXT_EXT.has(path.extname(file))) continue;
    const rel = path.relative(ROOT, file);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (literal.test(line)) hits.push(`${rel}:${i + 1} (PostgREST path)`);
      else if (helper.test(line)) hits.push(`${rel}:${i + 1} (cloud.js rest() helper)`);
    });
  }
  if (hits.length) {
    fail('public/ reaches a social table directly — every social action is a socket frame the server'
      + ' executes with its secret key, and a COMMENTED-OUT call counts because it ships to the browser'
      + ` either way:\n      ${hits.join('\n      ')}`);
  } else {
    ok(`nothing under public/ builds a PostgREST call to ${TABLES.join(', ')}, by literal path or through cloud.js's rest() helper`);
  }
}

// ---- 21. SQUADS MUST NOT TOUCH offlineKind ----------------------------------
// offlineKind(modeId) paints the cpu / solo / online badge on every board in the
// Launch Bay, and it is DERIVED: it asks the two offline predicates section 7d
// protects and adds nothing of its own. Squads give a board a SECOND reason to
// look unavailable -- `.nofit`, dimmed from the server's `fits` map when the
// squad does not fit the mode's seats (design 5.2) -- and both reasons land on
// the same card. The temptation is to fold them into one answer here. That
// would make the offline badge lie in the one direction that matters: a board
// a squad does not fit is not a board that needs a connection, and a player
// with no squad and no signal would be told the opposite of the truth by the
// one function whose whole job is to say it plainly. Two reasons, two answers,
// and this is the rule that keeps them apart.
//
// COMMENTS ARE STRIPPED FIRST, and unlike section 20 that is the right way round
// here: these assertions are POSITIVE -- they require text to be PRESENT -- and
// section 17 records exactly what a positive read over raw text is worth.
// Comment the real function out, leave a copy of it in the comment above, and
// an unstripped version of this rule prints ALL GOOD over a file that no longer
// contains the function at all.
{
  const raw = read('public/app.js');
  // Block comments, then line comments, then blank lines: only EXECUTABLE
  // JavaScript is tested. A `//` inside a string literal is stripped too; that
  // costs nothing here, because every line this rule looks for is code and none
  // of them contains one.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '').trimEnd()).filter((l) => l.trim()).join('\n');
  const bad = [];
  const WANT = [
    'function offlineKind(modeId) {',
    "  if ((modeId === 'duel' || modeId === 'ffa') && soloByConstruction({ type: 'ai', mode: modeId })) return 'cpu';",
    "  if (soloOfferable({ type: 'create', mode: modeId })) return 'solo';",
    "  return 'online';",
    '}',
  ].join('\n');
  const body = src.match(/function offlineKind\(modeId\) \{[\s\S]*?\n\}/);
  if (!body) {
    bad.push('offlineKind(modeId) is not in app.js as EXECUTABLE code (comments stripped) — if it looks'
      + ' present in the file, it has been commented out');
  } else {
    if (!src.includes(WANT)) {
      bad.push(`offlineKind is no longer the four executable lines it shipped as: ${JSON.stringify(body[0])}`);
    }
    if (/squad|fits|nofit/i.test(body[0])) {
      bad.push(`offlineKind consults the squad fit: ${JSON.stringify(body[0])}`);
    }
  }
  if (bad.length) fail(`the offline badge and the squad fit have been folded together:\n      ${bad.join('\n      ')}`);
  else ok('offlineKind still derives cpu/solo/online from the two offline predicates alone — the squad fit is a separate answer on the same card');
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
