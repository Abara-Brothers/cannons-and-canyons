// The chosen-callsign rules (design 4.5): normalising, length, characters, the
// folded blocklist, and the loader's own guards. Headless — no server, no
// browser, no database. server/callsign.js is a pure module apart from the one
// readFileSync in loadBlocklist().
//
// WHY THIS EXISTS: this is the ONLY filter standing between a player-typed name
// and every other player's screen, the result card and the App Review reviewer.
// Each of its rules fails silently in a different direction — a length counted
// in UTF-16 units quietly rejects a legitimate name, a blocklist line of digits
// quietly rejects EVERY name, and a missing fold quietly lets the slur through.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CALLSIGN_MIN, CALLSIGN_MAX, normaliseCallsign, foldForBlocklist, loadBlocklist, validateCallsign,
} from '../server/callsign.js';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const LIST = fileURLToPath(new URL('../server/blocklist.txt', import.meta.url));
const terms = loadBlocklist(LIST);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const err = (raw) => { const r = validateCallsign(raw, terms); return r.ok ? 'ok' : r.error; };
// An emoji written as a codepoint, never as a glyph or a \u{1F...} escape: the
// house rules reject both forms and a test file is not worth the exemption.
const EMOJI = String.fromCodePoint(0x1F600);
const ASTRAL = String.fromCodePoint(0x1D400);   // MATHEMATICAL BOLD CAPITAL A, one letter, two UTF-16 units
const NBSP = String.fromCodePoint(0x00A0);      // no-break space: whitespace to trim() and to \s
const ZWSP = String.fromCodePoint(0x200B);      // zero-width space: NOT whitespace to either

// ---- 1. the constants are the contract ------------------------------------
{
  if (CALLSIGN_MIN === 3 && CALLSIGN_MAX === 16) ok(`bounds are ${CALLSIGN_MIN}..${CALLSIGN_MAX}`);
  else fail(`bounds are ${CALLSIGN_MIN}..${CALLSIGN_MAX}, the design says 3..16`);
}

// ---- 2. normalising -------------------------------------------------------
{
  const CASES = [
    ['  Red Baron  ', 'Red Baron', 'leading and trailing spaces go'],
    ['Red    Baron', 'Red Baron', 'a run of spaces collapses to one'],
    ['Red\tBaron', 'Red Baron', 'a tab is whitespace and becomes one space'],
    ['Red' + NBSP + 'Baron', 'Red Baron', 'a no-break space is whitespace and becomes an ordinary space'],
    [NBSP + 'Red Baron' + NBSP, 'Red Baron', 'trim() removes a no-break space at either end'],
    ['Red \t\n Baron', 'Red Baron', 'a mixed whitespace run collapses to one space'],
    ['', '', 'empty in, empty out'],
    [null, '', 'null in, empty out'],
    [undefined, '', 'undefined in, empty out'],
    [42, '42', 'a non-string is stringified'],
  ];
  for (const [raw, want, why] of CASES) {
    const got = normaliseCallsign(raw);
    if (got === want) ok(`(2) ${why}`);
    else fail(`(2) normaliseCallsign(${JSON.stringify(raw)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  // No leading or trailing space is a rule of 4.5, and normalising is WHY it can
  // never fail: by the time validateCallsign looks, trim() has already run. The
  // anchored shape check keeps the rule real for any other caller.
  const r = validateCallsign('   Ace Pilot   ', terms);
  if (r.ok && r.name === 'Ace Pilot') ok('(2) a padded name is accepted as its trimmed form, never rejected for the padding');
  else fail('(2) padded name: ' + JSON.stringify(r));
}

// ---- 3. length, counted in code points ------------------------------------
// The trap: 'X'.length is UTF-16 units, so a name of 15 letters plus one astral
// letter measures 17 and a correct name is rejected with 'length' — a bug that
// only ever shows up for the players least able to report it.
{
  const A = (n) => 'a'.repeat(n);
  const CASES = [
    [A(2), 'length', 'two characters is too short'],
    [A(3), 'ok', 'three characters is the floor and passes'],
    [A(16), 'ok', 'sixteen characters is the ceiling and passes'],
    [A(17), 'length', 'seventeen characters is too long'],
    ['', 'length', 'an empty name is a length error, not a character error'],
    ['   ', 'length', 'spaces only normalise to empty and read as length'],
    [A(15) + ASTRAL, 'ok', 'fifteen letters plus one astral letter is sixteen CODE POINTS and passes'],
    [A(16) + ASTRAL, 'length', 'sixteen letters plus one astral letter is seventeen code points and fails'],
  ];
  for (const [raw, want, why] of CASES) {
    const got = err(raw);
    if (got === want) ok(`(3) ${why}`);
    else fail(`(3) ${JSON.stringify(raw.slice(0, 20))} -> ${got}, want ${want}`);
  }
  if ((A(15) + ASTRAL).length === 17) ok('(3) the astral case really is 17 UTF-16 units — a .length check would have failed it');
  else fail('(3) the astral fixture is not astral');
}

// ---- 4. characters --------------------------------------------------------
// Letters means Unicode letters. A Cyrillic or Japanese callsign is a legitimate
// name, not a character error, and rejecting one is the quiet kind of wrong.
{
  const CASES = [
    ['Ace Pilot', 'ok', 'Latin letters and a space'],
    ['Ace 7', 'ok', 'digits are allowed'],
    ['777', 'ok', 'all digits is a name'],
    ['Комета', 'ok', 'Cyrillic letters pass'],
    ['サクラ', 'ok', 'Japanese letters pass'],
    ['ΑΘΗΝΑ', 'ok', 'Greek letters pass'],
    ['Zoë Wren', 'ok', 'a letter with a diacritic passes'],
    ['Ace-Pilot', 'chars', 'a hyphen is not a letter, a digit or a space'],
    ['Ace_Pilot', 'chars', 'an underscore is rejected'],
    ["Ace's", 'chars', 'an apostrophe is rejected'],
    ['<b>Ace</b>', 'chars', 'markup is rejected'],
    ['Ace' + EMOJI, 'chars', 'an emoji is rejected'],
    ['Ace' + ZWSP + 'Pilot', 'chars', 'a zero-width space is not whitespace to \\s and is rejected as a character'],
  ];
  for (const [raw, want, why] of CASES) {
    const got = err(raw);
    if (got === want) ok(`(4) ${why}`);
    else fail(`(4) ${JSON.stringify(raw)} -> ${got}, want ${want}`);
  }
}

// ---- 5. the fold ----------------------------------------------------------
{
  const MAP = [['0', 'o'], ['1', 'i'], ['3', 'e'], ['4', 'a'], ['5', 's'], ['7', 't'], ['@', 'a'], ['$', 's'], ['|', 'i']];
  let bad = 0;
  for (const [from, to] of MAP) {
    const got = foldForBlocklist('x' + from + 'x');
    if (got === 'x' + to + 'x') continue;
    bad++; fail(`(5) look-alike ${from} folded to ${JSON.stringify(got)}, want ${JSON.stringify('x' + to + 'x')}`);
  }
  if (!bad) ok(`(5) every one of the ${MAP.length} look-alikes folds (${MAP.map(([a, b]) => a + '->' + b).join(' ')})`);
  const CASES = [
    ['Zoë', 'zoe', 'a diacritic is stripped'],
    ['Ñuñez', 'nunez', 'tildes are stripped'],
    ['ÅÄÖ', 'aao', 'Nordic diacritics are stripped'],
    ['Red Baron', 'redbaron', 'spaces are removed'],
    ['Ace-Pilot 7', 'acepilott', 'punctuation goes, the digit folds'],
    ['サクラ', '', 'a script with no a-z folds to nothing'],
    ['', '', 'empty folds to empty'],
    [null, '', 'null folds to empty'],
  ];
  for (const [raw, want, why] of CASES) {
    const got = foldForBlocklist(raw);
    if (got === want) ok(`(5) ${why}`);
    else fail(`(5) foldForBlocklist(${JSON.stringify(raw)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ---- 6. the blocklist, against the file that actually ships ----------------
{
  const first = terms[0];
  if (terms.length >= 5) ok(`(6) the shipped blocklist loads ${terms.length} terms`);
  else fail(`(6) the shipped blocklist has only ${terms.length} terms`);
  const dirty = terms.filter((t) => !/^[a-z]+$/.test(t));
  if (!dirty.length) ok('(6) every loaded term is a-z only, so it can match a folded name');
  else fail('(6) terms that are not a-z: ' + dirty.join(', '));
  // whole name, substring, and the fold reaching the blocklist
  const CASES = [
    [first, 'not_allowed', 'a name that IS a term is rejected'],
    [first.toUpperCase(), 'not_allowed', 'case does not hide a term'],
    ['xx' + first + 'xx', 'not_allowed', 'a term as a substring is rejected'],
    [[...first].join(' '), 'not_allowed', 'spacing a term out does not hide it — the fold removes spaces'],
    ['Ace Pilot', 'ok', 'an ordinary two-word callsign passes'],
    ['Red Baron', 'ok', 'an ordinary callsign passes'],
    ['Alpine Fox', 'ok', 'an ordinary callsign passes'],
    ['Steel Titan', 'ok', 'Titan is not a term'],
    ['Bass Master', 'ok', 'Bass is not a term'],
    ['Grasshopper', 'ok', 'a long innocent word passes'],
  ];
  for (const [raw, want, why] of CASES) {
    const got = err(raw);
    if (got === want) ok(`(6) ${why}`);
    else fail(`(6) ${JSON.stringify(raw)} -> ${got}, want ${want}`);
  }
  // leet + diacritic together, through validateCallsign, on a real term
  const leet = 'N1gg3r', acc = 'Nïggér';
  for (const raw of [leet, acc]) {
    if (err(raw) === 'not_allowed') ok(`(6) ${raw} is folded back onto a term and rejected`);
    else fail(`(6) ${raw} -> ${err(raw)}, want not_allowed`);
  }
  // order: a too-long blocked name reads as 'length', because length is checked first
  if (err(first.repeat(9)) === 'length') ok('(6) length is checked before the blocklist');
  else fail('(6) an over-long blocked name reported ' + err(first.repeat(9)));
}

// ---- 7. the shape of a pass -----------------------------------------------
{
  const r = validateCallsign('  Red   Baron  ', terms);
  if (r.ok === true && r.name === 'Red Baron' && r.key === 'red baron' && eq(Object.keys(r).sort(), ['key', 'name', 'ok'])) {
    ok('(7) a pass is { ok:true, name:"Red Baron", key:"red baron" } and nothing else');
  } else fail('(7) pass shape: ' + JSON.stringify(r));
  const b = validateCallsign('Ace-Pilot', terms);
  if (b.ok === false && b.error === 'chars' && eq(Object.keys(b).sort(), ['error', 'ok'])) ok('(7) a refusal is { ok:false, error } and nothing else');
  else fail('(7) refusal shape: ' + JSON.stringify(b));
  const k = validateCallsign('КОМЕТА', terms);
  if (k.ok && k.key === 'комета') ok('(7) the key is the display form lowercased, in any script');
  else fail('(7) non-Latin key: ' + JSON.stringify(k));
}

// ---- 8. loadBlocklist's own guards ----------------------------------------
// The file is owner-editable, so every way an owner can break it must be loud at
// boot rather than silent at runtime. The worst of them is a line with no
// letters: it folds to '' and ''.includes() is true for EVERY string, which
// would reject every callsign on the service with 'not_allowed'.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-blocklist-'));
  const write = (name, body) => { const p = path.join(dir, name); writeFileSync(p, body); return p; };
  const threw = (p) => { try { loadBlocklist(p); return null; } catch (e) { return e.message; } };
  const CASES = [
    [write('empty.txt', ''), 'blocklist empty', 'an empty file'],
    [write('ws.txt', '\n\n  \n'), 'blocklist empty', 'a file of nothing but whitespace'],
    [write('blank.txt', 'nigger\n\nfaggot\n'), 'blocklist blank line', 'a blank line between terms'],
    [write('lead.txt', '\nnigger\n'), 'blocklist blank line', 'a leading blank line'],
    [write('spaces.txt', 'nigger\n   \nfaggot\n'), 'blocklist blank line', 'a whitespace-only line'],
    [write('sep.txt', 'nigger\n-----\n'), 'blocklist blank line', 'a separator line of dashes — no letters at all, the line that would block every name'],
    [path.join(dir, 'gone.txt'), 'blocklist missing', 'a file that is not there'],
  ];
  for (const [p, want, why] of CASES) {
    const got = threw(p);
    if (got === want) ok(`(8) ${why} throws Error('${want}')`);
    else fail(`(8) ${why}: threw ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  const good = write('good.txt', 'Nigger\nFAGGOT\n');
  if (eq(loadBlocklist(good), ['nigger', 'faggot'])) ok('(8) terms are folded on load, so an owner who types a capital still gets a working term');
  else fail('(8) folded load: ' + JSON.stringify(loadBlocklist(good)));
  const noEol = write('noeol.txt', 'nigger\nfaggot');
  if (eq(loadBlocklist(noEol), ['nigger', 'faggot'])) ok('(8) a file with no trailing newline loads the same');
  else fail('(8) no-eol load: ' + JSON.stringify(loadBlocklist(noEol)));
  const crlf = write('crlf.txt', 'nigger\r\nfaggot\r\n');
  if (eq(loadBlocklist(crlf), ['nigger', 'faggot'])) ok('(8) CRLF line endings do not become part of a term');
  else fail('(8) crlf load: ' + JSON.stringify(loadBlocklist(crlf)));
  rmSync(dir, { recursive: true, force: true });
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall callsign checks passed');
process.exit(out.errors.length ? 1 : 0);
