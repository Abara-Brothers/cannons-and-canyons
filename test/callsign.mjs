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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CALLSIGN_MIN, CALLSIGN_MAX, normaliseCallsign, foldForBlocklist, loadBlocklist, validateCallsign,
  SAFE_WORDS, LETTER_LOOKALIKE,
} from '../server/callsign.js';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const LIST = fileURLToPath(new URL('../server/blocklist.txt', import.meta.url));
const terms = loadBlocklist(LIST);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const err = (raw) => { const r = validateCallsign(raw, terms); return r.ok ? 'ok' : r.error; };
// A term is never printed — not in a test name, not in an ok line, not in a fail
// line. It is named by its LINE in server/blocklist.txt, which is the thing an
// owner actually edits and the thing a failure needs to point at.
const line = (t) => terms.indexOf(t) + 1;
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
  // EVERY term in the shipped file, not just the first. This is what makes the
  // SAFE_WORDS rule enforceable: a future safe word that happened to contain a
  // term would quietly unblock that term, and with only terms[0] exercised the
  // suite would stay green the whole time. Line numbers only in the message —
  // no term is ever printed.
  const escaped = terms.map((t, i) => i).filter((i) => err(terms[i]) !== 'not_allowed');
  if (!escaped.length) ok(`(6) every one of the ${terms.length} terms in the shipped file is itself rejected as a callsign`);
  else fail(`(6) ${escaped.length} shipped term(s) are NOT rejected — line(s) ${escaped.map((i) => i + 1).join(', ')} of server/blocklist.txt`);
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
  // Not every read failure is a missing file. A directory sitting where the file
  // should be (or EACCES on a locked-down deploy) reported 'blocklist missing',
  // which sends whoever is debugging the boot looking for a file that is right
  // there. The message is the only thing they get to see.
  const asDir = path.join(dir, 'a-directory.txt');
  mkdirSync(asDir);
  const dirMsg = threw(asDir);
  const m = dirMsg && dirMsg.match(/^blocklist unreadable \(([A-Z]+)\)/);
  if (m && dirMsg.includes(asDir)) ok(`(8) a directory in place of the file throws 'blocklist unreadable (${m[1]})' with the path, not the misleading 'blocklist missing'`);
  else fail(`(8) a directory in place of the file threw ${JSON.stringify(dirMsg)}, want a 'blocklist unreadable (CODE)' message naming the path`);
  rmSync(dir, { recursive: true, force: true });
}

// ---- 9. the Scunthorpe problem ---------------------------------------------
// A folded name is tested as a SUBSTRING of a term, which is what catches a
// spaced-out or leet-spelled evasion — but the same substring test means an
// innocent word that happens to contain a term reads as a violation too.
// SAFE_WORDS exempts specific innocent words from the substring test. It was
// claimed here that this costs nobody else anything — that the bare term, and
// every evasion of it, is still caught. That was false for a safe word that
// OVERLAPS a term: stripping the safe word ate the term with it, and the name
// shipped. Section 13 has the fixtures and section 14 generates the invariant
// that would have caught it. What is true, and all that is claimed now, is that
// a safe word can only consume letters from the token it occurs in.
// (Names below are kept short to stay inside CALLSIGN_MAX.)
{
  const term = 'cunt';
  const CASES = [
    ['Scunthorpe', 'ok', 'a real English town whose name contains the bare term is accepted'],
    ['Scunthorpe Utd', 'ok', 'the safe word is still exempt alongside another word in the name'],
    [term, 'not_allowed', 'the bare term on its own is still rejected'],
    [[...term].join(' '), 'not_allowed', 'a spaced-out evasion of the bare term is still rejected'],
    ['xx' + term + 'xx', 'not_allowed', 'the term inside an unrelated, non-exempt word is still rejected'],
  ];
  for (const [raw, want, why] of CASES) {
    const got = err(raw);
    if (got === want) ok(`(9) ${why}`);
    else fail(`(9) ${JSON.stringify(raw)} -> ${got}, want ${want}`);
  }
}

// ---- 10. compatibility forms of a term -------------------------------------
// The fold normalises with NFKD, not NFD. NFD leaves a fullwidth or a
// mathematical-bold letter exactly as it is, and the a-z strip at the end of the
// fold then DELETES it — so one such letter dropped into an otherwise plain
// spelling erased itself, the rest of the name folded to something no term
// matched, and the name still rendered as the slur on every other player's
// screen. Every shape below was probed against the shipped list and passed.
//
// The fixtures are built from terms[0] by code-point arithmetic, so no literal
// appears in this file, and no fixture is ever printed — only its description.
{
  const term = terms[0];
  const FW_UPPER = 0xFF21 - 0x41, FW_LOWER = 0xFF41 - 0x61;   // FULLWIDTH LATIN CAPITAL/SMALL A
  const MB_UPPER = 0x1D400 - 0x41, MB_LOWER = 0x1D41A - 0x61; // MATHEMATICAL BOLD CAPITAL/SMALL A
  const MO_UPPER = 0x1D670 - 0x41, MO_LOWER = 0x1D68A - 0x61; // MATHEMATICAL MONOSPACE CAPITAL/SMALL A
  const shift = (s, up, low) => [...s].map((c) => {
    const cp = c.codePointAt(0);
    if (cp >= 0x41 && cp <= 0x5A) return String.fromCodePoint(cp + up);
    if (cp >= 0x61 && cp <= 0x7A) return String.fromCodePoint(cp + low);
    return c;
  }).join('');
  const one = (s, i, up, low) => [...s].map((c, j) => (j === i ? shift(c, up, low) : c)).join('');
  const SUPER_N = String.fromCodePoint(0x207F);   // MODIFIER LETTER SMALL N: a letter to \p{L}, 'n' to NFKD
  const CASES = [
    [shift(term, FW_UPPER, FW_LOWER), 'a fully fullwidth spelling of the bare term'],
    [one(term, 1, FW_UPPER, FW_LOWER), 'one fullwidth letter inside an otherwise ASCII spelling'],
    [shift(term, MB_UPPER, MB_LOWER), 'a mathematical bold spelling (astral)'],
    [shift(term, MO_UPPER, MO_LOWER), 'a mathematical monospace spelling (astral)'],
    [one(term, 2, MB_UPPER, MB_LOWER), 'one mathematical bold letter inside an ASCII spelling'],
    [SUPER_N + term.slice(1), 'a modifier letter (U+207F) standing in for the first letter'],
    // Not in the reviewer's list, and the one shape a bare NFD->NFKD swap does
    // NOT catch: the astral maths letters have no case mapping of their own, so
    // a lowercase-then-normalise fold leaves ASCII CAPITALS for the a-z strip to
    // delete. It is caught only because the fold lowercases AFTER normalising.
    [shift(term.toUpperCase(), MB_UPPER, MB_LOWER), 'a mathematical bold CAPITAL spelling (astral, no case mapping of its own)'],
  ];
  const ascii = CASES.filter(([raw]) => [...raw].every((c) => c.codePointAt(0) < 0x80));
  if (!ascii.length) ok(`(10) all ${CASES.length} fixtures really are non-ASCII respellings — none of them is just the plain term`);
  else fail(`(10) ${ascii.length} fixture(s) came out as plain ASCII, so this section would prove nothing`);
  for (const [raw, why] of CASES) {
    const got = err(raw);
    if (got === 'not_allowed') ok(`(10) ${why} is rejected`);
    else fail(`(10) ${why} -> ${got}, want not_allowed`);
  }
  // The gap this does NOT close, restated as what it actually is. It was written
  // here as CROSS-SCRIPT homoglyphs. The real rule is broader and simpler: ANY
  // letter NFKD does not reduce to a-z deletes itself at the end of the fold,
  // and the deletion breaks the term around it while the name goes on rendering
  // as the slur. U+0131, the Turkish dotless i, is an ordinary Latin letter and
  // did exactly that — section 15 has that shape and three more.
  //
  // The Cyrillic half is now CLOSED by the look-alike table, and that is
  // asserted rather than assumed. The residual is then pinned with two
  // fixtures — one Latin, one Cyrillic — each a letter the table deliberately
  // does not name, so that closing one script can never be mistaken for closing
  // the gap.
  // Code points, not glyphs: written as literals this map reads as an identity
  // map on the page, which is the whole point of a homoglyph and no way to
  // write a test. Cyrillic a, ie, o, es, er, ha.
  const CYR = { a: 0x430, e: 0x435, o: 0x43E, c: 0x441, p: 0x440, x: 0x445 };
  const homoglyph = [...term].map((c) => (CYR[c] ? String.fromCodePoint(CYR[c]) : c)).join('');
  if (homoglyph === term) fail('(10) the homoglyph fixture came out identical to the term, so it documents nothing');
  else if (err(homoglyph) === 'not_allowed') ok(`(10) a Cyrillic look-alike spelling of the term on line ${line(term)} is refused — the table folds those letters back`);
  else fail(`(10) a Cyrillic look-alike spelling of the term on line ${line(term)} -> ${err(homoglyph)}, want not_allowed`);
  // Both letters below ARE letters to \p{L}, so the shape check passes them, and
  // neither is in the table: each deletes itself and takes the term apart with
  // it. If one is ever refused, the table has grown to cover it — move the pin
  // outward to a letter still outside the table rather than deleting it.
  const RESIDUAL = [
    [0x01E5, 'g', 'U+01E5, LATIN SMALL LETTER G WITH STROKE — ordinary Latin, nothing cross-script about it'],
    [0x0433, 'r', 'U+0433, CYRILLIC SMALL LETTER GHE, which is r-shaped in a sans face'],
  ];
  for (const [code, letter, why] of RESIDUAL) {
    const ch = String.fromCodePoint(code);
    const at = term.indexOf(letter);
    if (at < 0) { fail(`(10) the term on line ${line(term)} has no '${letter}' to substitute — this pin needs rewriting`); continue; }
    if (LETTER_LOOKALIKE[ch]) { fail(`(10) ${why} is now IN the look-alike table — this pin must move to a letter that is still outside it`); continue; }
    const spelling = term.slice(0, at) + ch + term.slice(at + 1);
    if (err(spelling) === 'ok') ok(`(10) KNOWN GAP, pinned: ${why} still deletes itself, and the rest of the term goes through`);
    else ok(`(10) ${why} is now refused — the table has grown, and this pin should move outward rather than go`);
  }
}

// ---- 11. a bad terms argument fails CLOSED ---------------------------------
// This used to substitute [] for anything that was not an Array, so a Set, a
// forgotten second argument, or an await that resolved to undefined returned
// { ok: true } for EVERY name. Later tasks wire this up from the socket and from
// the store, where all three are one keystroke away — and nothing would look
// broken until a slur reached another player's screen.
{
  const caught = (t) => { try { validateCallsign('Ace Pilot', t); return null; } catch (e) { return e; } };
  const BAD = [
    [new Set(terms), 'a Set of the very same terms'],
    [undefined, 'a missing second argument'],
    [null, 'null'],
    [terms.join('\n'), 'a string (the raw file contents, not the parsed list)'],
  ];
  for (const [bad, why] of BAD) {
    const e = caught(bad);
    if (e instanceof TypeError && /terms must be an array/.test(e.message)) ok(`(11) ${why} throws a TypeError instead of passing every name`);
    else fail(`(11) ${why}: ${e ? `${e.constructor.name}: ${e.message}` : 'did not throw — the filter is off and silent'}`);
  }
  if (err('Ace Pilot') === 'ok' && err(terms[0]) === 'not_allowed') ok('(11) a proper array still accepts an ordinary name and still rejects a term');
  else fail('(11) a proper array of terms no longer validates normally');
  // Why the throw matters, stated as an assertion rather than a comment: an
  // empty list really does accept the bare term, so silently substituting one
  // for a bad argument was a kill switch with no indicator.
  if (validateCallsign(terms[0], []).ok === true) ok('(11) an EMPTY list accepts even the bare term — which is exactly what substituting [] used to do');
  else fail('(11) empty-list control assertion no longer holds');
}

// ---- 12. names written with combining marks --------------------------------
// Two separate bugs met here. normaliseCallsign did no Unicode normalisation, so
// the decomposed spelling of a name was answered 'chars' while the
// identical-looking precomposed one was accepted. And the character class
// admitted letters and digits only, which refuses outright every script that
// cannot be written without combining marks — while section 4 above advertises
// that a Cyrillic or Japanese callsign is legitimate.
{
  // ACUTE is written as a code point, never as a glyph: a bare combining mark in
  // source attaches itself to the quote in front of it and is unreadable. Same
  // reason EMOJI and ZWSP are code points at the top of this file.
  const ACUTE = String.fromCodePoint(0x0301);    // COMBINING ACUTE ACCENT
  const COMPOSED = 'Zoé';                        // precomposed LATIN SMALL LETTER E WITH ACUTE
  const DECOMPOSED = 'Zoe' + ACUTE;              // e + the combining mark: the same name
  if (DECOMPOSED !== COMPOSED && DECOMPOSED.normalize('NFC') === COMPOSED) ok('(12) the two fixtures really are different strings that spell one name');
  else fail('(12) the composed/decomposed fixtures are not what this section assumes');
  const a = validateCallsign(COMPOSED, terms), b = validateCallsign(DECOMPOSED, terms);
  if (a.ok && b.ok) ok('(12) the same name is accepted in both its precomposed and its decomposed spelling');
  else fail(`(12) composed -> ${JSON.stringify(a)}, decomposed -> ${JSON.stringify(b)}`);
  if (a.name === b.name && a.key === b.key) ok('(12) both spellings produce one name and one key, so they can never be two different players');
  else fail(`(12) the two spellings take different keys: ${JSON.stringify(a.key)} vs ${JSON.stringify(b.key)}`);

  const NAMES = [
    ['हिन्दी', 'Devanagari, which cannot be written without combining marks'],
    ['สุดา', 'a Thai name, whose vowels are combining marks'],
    ['אָב', 'Hebrew with niqqud'],
  ];
  for (const [n, why] of NAMES) {
    const got = err(n);
    if (got === 'ok') ok(`(12) ${why} is accepted`);
    else fail(`(12) ${why} -> ${got}, want ok`);
  }
  // Marks are characters and the cap counts them, so the length rule — not the
  // character class — is what bounds a stack of them.
  const STACK = 'a' + ACUTE.repeat(20);
  if (err(STACK) === 'length') ok('(12) a stack of combining marks is still bounded by the 16-code-point cap');
  else fail(`(12) a 21-code-point stack of combining marks -> ${err(STACK)}, want length`);

  // Every token must still OPEN with a letter or a digit. A combining mark
  // attaches to a base character, so a token that starts with one has no base:
  // it renders as stacked garbage, or as nothing at all, to every other player.
  // Admitting \p{M} without this rule allowed a callsign made of nothing but
  // marks — a name that is invisible on the board is exactly what this filter
  // exists to keep off it.
  const BASELESS = [
    [ACUTE.repeat(3), 'a name of nothing but combining marks'],
    [ACUTE + 'Ace', 'a name whose only token opens with a combining mark'],
    ['Red ' + ACUTE + 'Baron', 'a later token that opens with a combining mark'],
    ['Red ' + ACUTE.repeat(2), 'a valid token beside a marks-only token'],
  ];
  for (const [raw, why] of BASELESS) {
    const got = err(raw);
    if (got === 'chars') ok(`(12) ${why} is rejected as chars`);
    else fail(`(12) ${why} -> ${got}, want chars`);
  }
  // ...and the rule costs no script anything: in Devanagari, Thai and Hebrew the
  // mark follows its base in LOGICAL order even where it RENDERS to the left,
  // so every name above still opens with a letter. Asserted just above; this
  // records why it is safe rather than lucky.
  if (NAMES.every(([n]) => /^[\p{L}\p{N}]/u.test(n.normalize('NFC')))) ok('(12) every script fixture above still opens with a letter, which is why the base-character rule costs them nothing');
  else fail('(12) a script fixture opens with a combining mark — the base-character rule would refuse a real name');

  // \p{M} was too wide, and what it admitted was not a diacritic. It includes
  // \p{Me}, the ENCLOSING marks, and one of those — U+20E3 COMBINING ENCLOSING
  // KEYCAP — turns the digit in front of it into a KEYCAP EMOJI on every other
  // player's screen, in a product whose house rule is that every glyph is
  // hand-drawn. U+FE0F, the emoji presentation selector, is genuinely \p{Mn} and
  // had to be excluded by name: it is a code point the project's own emoji audit
  // lists in its banned ranges. And a run of marks was bounded only by the
  // 16-code-point cap, which is not a bound at all — fourteen acutes on one base
  // fit well inside it and render as a zalgo smear over the names either side.
  //
  // Every fixture is built from CODE POINTS. None of them is pasted into this
  // file as a character, for the same reason ACUTE is not.
  const VS16 = String.fromCodePoint(0xFE0F);        // VARIATION SELECTOR-16
  const KEYCAP = String.fromCodePoint(0x20E3);      // COMBINING ENCLOSING KEYCAP
  const TOO_WIDE = [
    ['7' + VS16 + KEYCAP + 'ab', 'a digit followed by U+FE0F and U+20E3 — the sequence that RENDERS AS A KEYCAP EMOJI'],
    ['Ace' + VS16, 'a bare U+FE0F after a base character'],
    ['Ace' + String.fromCodePoint(0xE0100), 'a variation selector from the U+E0100-U+E01EF supplement'],
    ['Ace' + KEYCAP, 'U+20E3 on its own after a letter'],
    ['Ace' + String.fromCodePoint(0x20DD), 'U+20DD, which draws a ring around the character in front of it'],
    ['Ace' + String.fromCodePoint(0x20DE), 'U+20DE, which draws a box around it'],
    ['Ace' + String.fromCodePoint(0x0489), 'U+0489, the Cyrillic millions sign — an enclosing mark'],
    ['a' + ACUTE.repeat(14), 'fourteen combining acutes on one base — a zalgo smear that fits inside the cap'],
  ];
  for (const [raw, why] of TOO_WIDE) {
    const got = err(raw);
    if (got === 'chars') ok(`(12) ${why} is rejected as chars`);
    else fail(`(12) ${why} -> ${got}, want chars`);
  }
  // The zalgo fixture has to be INSIDE the cap or it proves nothing: a 21-mark
  // stack is refused by the length rule and says nothing about the mark class.
  if ([...('a' + ACUTE.repeat(14))].length <= CALLSIGN_MAX) ok(`(12) the zalgo fixture is ${[...('a' + ACUTE.repeat(14))].length} code points — inside the ${CALLSIGN_MAX} cap, so it is the mark class refusing it and not the length rule`);
  else fail('(12) the zalgo fixture is over the cap and proves nothing about the mark class');
  // ...and the cap is TWO, not zero. Narrowing the class must not cost a real
  // name the marks it is spelled with.
  const TWO_MARKS = 'a' + ACUTE.repeat(2) + 'bc';
  if (err(TWO_MARKS) === 'ok') ok('(12) two marks on one base character are still accepted — the cap is two, not one and not zero');
  else fail(`(12) two marks on one base character -> ${err(TWO_MARKS)}, want ok`);
  // The scripts the class exists for, re-checked against the narrowed one.
  const NARROWED = [
    ['한국인', 'a Korean name'],
    ['محمد', 'an Arabic name'],
    ['مُحَمَّد', 'the same Arabic name with harakat — a shadda and a fatha stacked on one base'],
    [String.fromCodePoint(0x0E33) + 'บุญ', 'a Thai name opening with sara am, which is a LETTER and not a mark'],
  ];
  for (const [n, why] of NARROWED) {
    const got = err(n);
    if (got === 'ok') ok(`(12) ${why} still passes the narrowed class`);
    else fail(`(12) ${why} -> ${got}, want ok`);
  }
}

// ---- 13. terms manufactured at a word junction -----------------------------
// The fold removes spaces, so a term can appear across a junction that exists in
// neither word: "Epic Untold" folds a c up against unt, "Frag Head" folds rag up
// against head. Both are plausible names in an artillery game and both were
// refused. The terms involved are FOUND below rather than written out.
{
  const hit = (n) => terms.find((t) => foldForBlocklist(n).includes(t));
  const T_UNT = hit('Epic Untold'), T_RAG = hit('Frag Head');
  if (T_UNT && T_RAG && T_UNT !== T_RAG) ok('(13) both junctions really do manufacture a term in the folded form — these fixtures are not vacuous');
  else fail('(13) the junctions no longer produce a term, so this section proves nothing');

  const NAMES = ['Epic Untold', 'Arctic Untamed', 'Magic Untamed', 'Sonic Until', 'Frag Head', 'Drag Head', 'Crag Head'];
  for (const n of NAMES) {
    const got = err(n);
    if (got === 'ok') ok(`(13) "${n}" is accepted`);
    else fail(`(13) "${n}" -> ${got}, want ok`);
  }
  // The bare terms and their evasions are untouched by any of it.
  for (const t of [T_UNT, T_RAG]) {
    const which = t === T_UNT ? 'first' : 'second';
    if (err(t) === 'not_allowed') ok(`(13) the ${which} bare term is still rejected`);
    else fail(`(13) the ${which} bare term -> ${err(t)}, want not_allowed`);
    const spaced = [...t].join(' ');
    if (err(spaced) === 'not_allowed') ok(`(13) a spaced-out evasion of the ${which} bare term is still rejected`);
    else fail(`(13) a spaced-out evasion of the ${which} bare term -> ${err(spaced)}, want not_allowed`);
  }
  // Removing a safe word can only JOIN what is either side of it, so it cannot
  // destroy a match — the same assertion section 9 makes for the original entry,
  // made here for a new one.
  const EMBEDDED = [
    ['frag' + T_UNT, 'a new safe word sitting directly in front of a term'],
    ['Untold ' + T_UNT, 'a new safe word as a whole word in front of a term'],
  ];
  for (const [raw, why] of EMBEDDED) {
    const got = err(raw);
    if (got === 'not_allowed') ok(`(13) ${why} does not neutralise it`);
    else fail(`(13) ${why} -> ${got}, want not_allowed`);
  }

  // THE OVERLAP, which is where "removing a safe word can only JOIN the text"
  // stopped being true. It holds while the safe word and the term are DISJOINT.
  // Where they share an EDGE, stripping the safe word from the whole folded
  // string took the term with it: every name below returned { ok: true } and
  // rendered the slur, plainly legible, to everyone else on the board. The fold
  // is now per TOKEN, so a safe word can only eat letters out of the token it
  // occurs in and can no longer reach across a space.
  const OVERLAP = [
    ['F ' + T_RAG, `a single-letter token in front of the term on line ${line(T_RAG)}, welding into a safe word across the space`],
    ['D ' + T_RAG, `the same weld in front of the term on line ${line(T_RAG)} through a second safe word`],
    ['C ' + T_RAG, `the same weld in front of the term on line ${line(T_RAG)} through a third`],
    [T_UNT + ' Old', `a token behind the term on line ${line(T_UNT)} that welds into a safe word`],
    [T_UNT + ' Il', `a second such token behind the term on line ${line(T_UNT)}`],
    [T_UNT + ' Amed', `a third such token behind the term on line ${line(T_UNT)}`],
    ['Epic ' + T_UNT + ' Il', `the same weld behind the term on line ${line(T_UNT)} with an innocent token in front of it`],
  ];
  for (const [raw, why] of OVERLAP) {
    const got = err(raw);
    if (got === 'not_allowed') ok(`(13) ${why} is refused`);
    else fail(`(13) ${why} -> ${got}, want not_allowed — the safe word ate the term`);
  }
  // And the innocent names the safe words exist for are still accepted, which is
  // the whole point: the per-token fold cannot tell them apart by intent, only
  // by whether the safe word is a token of its own.
  // Named by line number, never written out: "Craghead" and "Scunthorpe" each
  // contain a shipped term outright, so printing the fixture would print the
  // term. The names themselves are in the CASES above and in SAFE_WORDS.
  const PLACES = [
    ['Craghead', `a real English village whose ONE-WORD name contains the term on line ${line(T_RAG)}`],
    ['Scunthorpe Utd', `the safe word containing the term on line ${line(T_UNT)}, beside a second token`],
  ];
  for (const [raw, why] of PLACES) {
    const got = err(raw);
    if (got === 'ok') ok(`(13) ${why} is still accepted`);
    else fail(`(13) ${why} -> ${got}, want ok`);
  }
  // DOCUMENTED RESIDUE, and the price of the list. A single token is still
  // stripped whole, so a term welded to a safe word's tail INSIDE one word
  // survives. It cannot be closed without also refusing the County Durham
  // village above, which is the name this list exists to protect. Either outcome
  // passes; the assertion is here so the trade stays visible rather than being
  // forgotten. The village is not named in the line, because its name contains a
  // shipped term outright.
  const WELDED = T_UNT + 'old';
  if (err(WELDED) === 'ok') ok(`(13) DOCUMENTED RESIDUE: the term on line ${line(T_UNT)} welded to a safe word's tail INSIDE one token is still accepted — the price of accepting the village on the first line of PLACES`);
  else ok(`(13) the one-token weld of the term on line ${line(T_UNT)} is now refused too — check by hand that both names in PLACES survived it`);
}

// ---- 14. the invariant a safe word must satisfy, GENERATED -----------------
// The hole in section 13 was not that one particular safe word was wrong. It was
// that the rule had NO invariant: the list was checked by eye, and in the wrong
// direction — does any term CONTAIN a safe word? An OVERLAP passes that check
// and still destroys the term, which is how three of them shipped.
//
// So this section names no fixture. It walks every (term, safe word) pair, finds
// every way the two share an edge, welds them back into the name that overlap
// produces, and asserts the name is refused. A safe word added later that
// overlaps a term fails here on the run that adds it, instead of turning that
// term off in silence.
//
// The weld is SPACED at the join, because that is the shape of the evasion: the
// safe word is not a token of anything, and only appears at all because the fold
// had already removed the space. A single token is a different case, and section
// 13 records it as a deliberate residue.
{
  const seen = new Set();
  const FIXTURES = [];
  const add = (name, why) => { const n = name.trim(); if (!seen.has(n)) { seen.add(n); FIXTURES.push([n, why]); } };
  for (const t of terms) {
    for (const safe of SAFE_WORDS) {
      for (let k = 1; k <= Math.min(safe.length, t.length); k++) {
        // a TAIL of the safe word is a HEAD of the term: "<safe minus overlap> <term>"
        if (safe.endsWith(t.slice(0, k))) add(safe.slice(0, safe.length - k) + ' ' + t, `"${safe}" ends with the first ${k} letter(s) of the term on line ${line(t)}`);
        // a TAIL of the term is a HEAD of the safe word: "<term> <safe minus overlap>"
        if (t.endsWith(safe.slice(0, k))) add(t + ' ' + safe.slice(k), `the term on line ${line(t)} ends with the first ${k} letter(s) of "${safe}"`);
      }
    }
  }
  if (FIXTURES.length >= 6) ok(`(14) the ${terms.length} terms and the ${SAFE_WORDS.length} safe words overlap at an edge in ${FIXTURES.length} places — every one of them is a way to eat a term, and every one is asserted below`);
  else fail(`(14) only ${FIXTURES.length} overlap(s) generated — the generator has stopped finding them and this section proves nothing`);
  // Not vacuous: each weld really does spell a term once the fold removes the
  // space. Without this, a generator bug would turn the whole section green.
  const vacuous = FIXTURES.filter(([n]) => !terms.some((t) => foldForBlocklist(n).includes(t)));
  if (!vacuous.length) ok(`(14) every one of the ${FIXTURES.length} welds really does spell a term once the space is folded out`);
  else fail(`(14) ${vacuous.length} weld(s) do not contain a term at all — the generator is building the wrong string`);
  let escaped = 0;
  for (const [name, why] of FIXTURES) {
    // Over the cap the length rule answers first, and 'length' is still a
    // refusal — what must never happen is 'ok'.
    const want = [...name].length > CALLSIGN_MAX ? 'length' : 'not_allowed';
    const got = err(name);
    if (got === want) continue;
    escaped++;
    fail(`(14) ${why}: the name their overlap welds together -> ${got}, want ${want} — stripping the safe word ate the term`);
  }
  if (!escaped) ok(`(14) all ${FIXTURES.length} welded names are refused: no safe word on the list can destroy a term it overlaps`);
}

// ---- 15. the letter look-alikes --------------------------------------------
// NFKD folds a COMPATIBILITY form onto its ASCII base (section 10). It does
// nothing for a letter that is simply a DIFFERENT letter of the same shape, and
// the a-z strip at the end of the fold then DELETES that letter — so one of them
// dropped into a term broke the term and the name shipped anyway, rendering as
// the slur on every other screen. Four shapes the reviewer found first, then the
// whole table generated against the whole blocklist.
{
  const cp = (n) => String.fromCodePoint(n);
  const hex = (ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  const pick = (letter) => terms.find((t) => t.includes(letter));
  const swap = (t, letter, code) => { const at = t.indexOf(letter); return t.slice(0, at) + cp(code) + t.slice(at + 1); };
  const REVIEWER = [
    ['i', 0x0131, 'U+0131, the Turkish dotless i — an ordinary Latin letter, nothing cross-script about it'],
    ['n', 0x0274, 'U+0274, LATIN LETTER SMALL CAPITAL N'],
    ['g', 0x0261, 'U+0261, LATIN SMALL LETTER SCRIPT G'],
    ['o', 0x00F8, 'U+00F8, LATIN SMALL LETTER O WITH STROKE'],
  ];
  for (const [letter, code, why] of REVIEWER) {
    const t = pick(letter);
    if (!t) { fail(`(15) no shipped term contains '${letter}', so ${why} cannot be tested against one`); continue; }
    const got = err(swap(t, letter, code));
    if (got === 'not_allowed') ok(`(15) ${why} standing in for '${letter}' in the term on line ${line(t)} is refused`);
    else fail(`(15) ${why} standing in for '${letter}' in the term on line ${line(t)} -> ${got}, want not_allowed`);
  }
  // The table itself, entry by entry: every look-alike must fold to the letter
  // it claims, and the value must be a-z or the fold's own strip would delete it.
  const entries = Object.entries(LETTER_LOOKALIKE);
  // A floor on the table itself. Every assertion below is generated FROM the
  // table, so an empty or gutted table would make all of them vacuously green —
  // the one failure mode a generated test has that a written one does not.
  if (entries.length >= 25) ok(`(15) the table names ${entries.length} look-alikes, which is the Latin, Cyrillic and Greek surface the design asks for`);
  else fail(`(15) the table is down to ${entries.length} entries — too few to be the realistic surface, and too few for the generated assertions below to mean anything`);
  const broken = entries.filter(([ch, to]) => !/^[a-z]$/.test(to) || foldForBlocklist('x' + ch + 'x') !== 'x' + to + 'x');
  if (!broken.length) ok(`(15) all ${entries.length} look-alikes fold to a single a-z letter through the public fold`);
  else fail(`(15) ${broken.length} table entr(ies) do not fold to their letter: ${broken.map(([ch]) => hex(ch)).join(', ')}`);
  // Every entry is doing work NFKD does not already do. A redundant entry is
  // harmless, but it is also a sign the table was written against the wrong
  // problem, and it makes the count above mean less than it looks.
  const redundant = entries.filter(([ch, to]) => ch.normalize('NFKD').toLowerCase() === to);
  if (!redundant.length) ok(`(15) not one of the ${entries.length} entries is something NFKD already handled — the table is the only reason any of them folds`);
  else fail(`(15) ${redundant.length} entr(ies) duplicate NFKD: ${redundant.map(([ch]) => hex(ch)).join(', ')}`);
  // And the generated part: every entry, substituted for its letter in every
  // shipped term that has one. This is what a future entry is measured against.
  let built = 0;
  const missed = [];
  for (const [ch, to] of entries) {
    for (const t of terms) {
      if (!t.includes(to)) continue;
      built++;
      if (err(swap(t, to, ch.codePointAt(0))) !== 'not_allowed') missed.push(`${hex(ch)} for '${to}' in the term on line ${line(t)}`);
    }
  }
  if (built >= entries.length && !missed.length) ok(`(15) ${built} single-substitution respellings of shipped terms — one for every (look-alike, term) pair the table can reach — are all refused`);
  else if (missed.length) fail(`(15) ${missed.length} respelling(s) still accepted: ${missed.slice(0, 8).join('; ')}`);
  else fail(`(15) only ${built} respellings were built from ${entries.length} entries — the generator is not reaching the terms`);
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall callsign checks passed');
process.exit(out.errors.length ? 1 : 0);
