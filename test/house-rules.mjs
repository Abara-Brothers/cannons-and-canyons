// House rules, enforced instead of remembered.
//
// These are standing project rules that have each been broken at least once and
// caught only by an ad-hoc grep. Encoding them means they cannot regress
// silently. Headless — no server required, so CI runs it first and cheaply.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const UI_FILES = ['public/index.html', 'public/app.js', 'public/styles.css', 'server.js', 'game-core.js'];

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
  const core = read('game-core.js');
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
  const core = read('game-core.js'), app = read('public/app.js');
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

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
