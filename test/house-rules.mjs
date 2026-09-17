// House rules, enforced instead of remembered.
//
// These are standing project rules that have each been broken at least once and
// caught only by an ad-hoc grep. Encoding them means they cannot regress
// silently. Headless — no server required, so CI runs it first and cheaply.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const UI_FILES = ['public/index.html', 'public/app.js', 'public/bay.js', 'public/styles.css', 'server.js',
  'public/game-core.js', 'public/room-engine.js', 'public/cloud.js', 'public/errors.js'];

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
  // TANK_HW/TANK_TOP are derived (1.35r / 1.36r), so pin the multipliers too —
  // changing either silently resizes the hitbox that must match the drawn art.
  const pinned = [
    [/export const TANK_R\s*=\s*(\d+)/, 'TANK_R', '240'],
    [/TANK_HW\s*=\s*Math\.round\(([0-9.]+)\s*\*\s*TANK_R\)/, 'TANK_HW multiplier', '1.35'],
    [/TANK_TOP\s*=\s*Math\.round\(([0-9.]+)\s*\*\s*TANK_R\)/, 'TANK_TOP multiplier', '1.36'],
    [/const BARREL_LEN\s*=\s*(\d+)/, 'BARREL_LEN', '410'],
    [/const BARREL_PIVOT_X\s*=\s*(\d+)/, 'BARREL_PIVOT_X', '113'],
    [/const TANK_CY\s*=\s*(\d+)/, 'TANK_CY', '274'],
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
  const pairs = [
    ['DMG_REACH', grab(core, /DMG_REACH\s*=\s*([0-9.]+)/, 'core'), grab(app, /selW\.radius\s*\*\s*([0-9.]+)/, 'client')],
    ['gravity', grab(core, /const GRAVITY\s*=\s*(\d+)/, 'core'), grab(app, /const G\s*=\s*(\d+)\s*\*/, 'client')],
    ['SPEED_PER_POWER', grab(core, /const SPEED_PER_POWER\s*=\s*(\d+)/, 'core'), grab(app, /aim\.power\s*\*\s*(\d+)\s*\*/, 'client')],
  ];
  let bad = 0;
  for (const [name, a, b] of pairs) {
    if (a !== b) { bad++; fail(`mirrored constant ${name} disagrees: game-core has ${a}, public/app.js has ${b}`); }
  }
  if (!bad) ok(`mirrored ballistics constants agree (${pairs.map(p => p[0]).join(', ')})`);
}

// ---- 5. CALLSIGN WORD LISTS MUST AGREE (ISSUE-015) ---------------------------
// Names are not free text. The client rolls from CALL_ADJ/CALL_NOUN and the
// server accepts ONLY pairs from its own copy of those lists. The client is a
// classic script and cannot import game-core.js, so the lists are duplicated —
// and if they drift, the server starts silently renaming players who did
// nothing wrong. Adding a word to one side without the other is the whole
// failure mode this guards.
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
  for (const file of ['public/app.js', 'public/cloud.js', 'public/errors.js', 'public/config.js', 'public/sw.js']) {
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

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
