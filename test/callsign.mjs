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
// SAFE_WORDS exempts specific innocent words from the substring test without
// weakening it for anyone else: the bare term, and every evasion of it, is
// still caught. (Names below are kept short to stay inside CALLSIGN_MAX.)
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
  // The gap this does NOT close, asserted so it stays a known one: a Cyrillic or
  // Greek letter that merely LOOKS Latin is a different letter, not a
  // compatibility form, and NFKD leaves it alone. Closing it needs a confusables
  // table or a mixed-script rule — an owner decision, not a quiet one.
  const CYR = { a: 'а', e: 'е', o: 'о', c: 'с', p: 'р', x: 'х' };
  const homoglyph = [...term].map((c) => CYR[c] || c).join('');
  if (homoglyph === term) fail('(10) the homoglyph fixture came out identical to the term, so it documents nothing');
  else if (err(homoglyph) === 'ok') ok('(10) KNOWN GAP, deliberate: a cross-script homoglyph spelling still passes — NFKD cannot see it, and a confusables table or a mixed-script rule is an owner decision');
  else ok('(10) a cross-script homoglyph spelling is now rejected — the known gap has been closed and this assertion can go');
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
  const COMPOSED = 'Zoé';        // precomposed LATIN SMALL LETTER E WITH ACUTE
  const DECOMPOSED = 'Zoé';     // e + COMBINING ACUTE ACCENT: the same name
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
  const STACK = 'a' + '́'.repeat(20);
  if (err(STACK) === 'length') ok('(12) a stack of combining marks is still bounded by the 16-code-point cap');
  else fail(`(12) a 21-code-point stack of combining marks -> ${err(STACK)}, want length`);
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
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall callsign checks passed');
process.exit(out.errors.length ? 1 : 0);
