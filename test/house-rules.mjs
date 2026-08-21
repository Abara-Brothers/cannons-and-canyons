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

const UI_FILES = ['public/index.html', 'public/app.js', 'public/styles.css', 'server.js',
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
    const missing = list.filter(p => p !== './' && !existsSync(path.join(ROOT, 'public', p)));
    if (!list.length) fail('sw.js SHELL list is empty');
    else if (missing.length) fail(`sw.js precaches files that do not exist — offline shell is incomplete:\n      ${missing.join('\n      ')}`);
    else {
      // These two are what offline PLAY depends on, as opposed to offline
      // LOADING. Name them explicitly so nobody drops one as "just an asset":
      // without either, the app opens with no network and then cannot start a
      // match, which is a worse failure than not opening at all.
      const core = ['game-core.js', 'room-engine.js'].filter(f => !list.includes(f));
      if (core.length) fail(`sw.js does not precache ${core.join(' and ')} — the app would load offline but could not play`);
      else ok(`sw.js precaches ${list.length} shell entries, all present (game-core + room-engine included)`);
    }
  }
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
