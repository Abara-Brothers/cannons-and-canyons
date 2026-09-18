// The callsign rules, server side and the single source (design 4.5).
//
// Rolled callsigns are untouched by this file: they are pairs from the two
// curated lists and are checked by sanitizeName() in the engine. THIS is the
// other half — a name the player TYPED. It never runs in the browser, so the
// client may hint at the rules but can never be the boundary; a modified client
// sends whatever it likes and arrives here.
import { readFileSync } from 'node:fs';

export const CALLSIGN_MIN = 3;
export const CALLSIGN_MAX = 16;

// Unicode letters, digits, a BOUNDED run of combining marks, and single interior
// spaces. The anchors also enforce "no leading or trailing space" and "no run of
// spaces" — both of which normaliseCallsign() has already made impossible. The
// rule is still written out, because validateCallsign() is a boundary and a
// boundary that trusts its own caller is not one.
//
// Marks are in the class because whole writing systems are unusable without
// them: हिन्दी, สุดา and Hebrew with niqqud are letters PLUS combining marks, and a
// class of letters-and-digits alone answers 'chars' to every one of them — a
// large share of the world told its own name is a character error, while this
// same file's tests advertise that a Cyrillic or Japanese callsign is
// legitimate. It widens who can play without widening what gets through:
// foldForBlocklist() strips marks before the terms are tested.
//
// \p{Mn} and \p{Mc}, NOT \p{M}. \p{M} also admits \p{Me}, the ENCLOSING marks,
// which draw a ring or a box around the character in front of them (U+20DD,
// U+20DE, U+0489) — and one of them, U+20E3 COMBINING ENCLOSING KEYCAP, turns a
// preceding digit into a KEYCAP EMOJI on every other player's screen, in a
// product whose house rule is that every glyph is hand-drawn. The variation
// selectors have to be excluded BY NAME because they are genuinely \p{Mn}:
// U+FE00-U+FE0F (U+FE0F is the emoji presentation selector, a code point this
// project's own emoji audit lists in its banned ranges) and the U+E0100-U+E01EF
// supplement. None of them is a diacritic and no script spells a name with one.
// U+20E3 is named in the exclusion list as well as being \p{Me}, so that a
// future widening of the category cannot re-admit the keycap in silence.
//
// At most TWO marks per base character. The 16-code-point cap alone does not
// bound a stack usefully: one base plus fourteen combining acutes fits inside it
// and renders as a zalgo smear over the names either side of it. Two is what the
// scripts above actually use — a Thai vowel with a tone mark, an Arabic letter
// with a shadda and a fatha, a Hebrew letter with a vowel point and a dagesh.
//
// Every TOKEN must still start with a letter or a digit, and marks may only
// follow one. A combining mark is by definition something that attaches to a
// base character, so a token that opens with one has no base to attach to: it
// renders as stacked garbage, or as nothing at all, on every other player's
// screen — which is the kind of name this file exists to keep off the board.
// Admitting marks without this would have allowed a callsign made of nothing
// but marks. No script pays for the rule: in Devanagari, Thai and Hebrew the
// mark follows its base in LOGICAL order even where it RENDERS to the left of
// it, so every one of those names still begins with a letter.
// Composed from parts rather than written as one literal: the token pattern
// appears twice in the anchored rule (first token, then every later one), and
// two hand-copied versions of a nested quantifier are two chances to edit one
// and not the other.
const MARK = '(?:(?![\\uFE00-\\uFE0F\\u{20E3}\\u{E0100}-\\u{E01EF}])[\\p{Mn}\\p{Mc}])';
const TOKEN = `(?:[\\p{L}\\p{N}]${MARK}{0,2})+`;
const SHAPE = new RegExp(`^${TOKEN}(?: ${TOKEN})*$`, 'u');

// Look-alikes, exactly the nine in the design. '8'->'b' and '!'->'i' are in the
// engine's older LEET map but NOT here: the design fixes this map, and the two
// halves are allowed to differ because they guard different things.
// '@', '$' and '|' are unreachable THROUGH validateCallsign — SHAPE rejects a
// name containing any of them before the fold is ever reached — so the map is
// deliberately broader than that one path needs. foldForBlocklist() is exported
// and folds the blocklist file itself, and the extra keys cost nothing.
const LOOKALIKE = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '|': 'i' };

// The LETTER look-alikes, written as code points. NFKD folds a COMPATIBILITY
// form onto its ASCII base; it does nothing at all for a letter that is simply a
// DIFFERENT letter of the same shape, and the a-z strip at the end of the fold
// then DELETES that letter — which breaks the term around it while the name goes
// on rendering as the slur to everyone else. That is not a cross-script problem:
// U+0131 (the Turkish dotless i), U+00F8 and U+0274 are ordinary Latin letters
// and every one of them did it.
//
// Code points, not glyphs, for the same reason the test is: written as literals
// this table reads as an identity map on the page, which is precisely what makes
// a homoglyph work.
//
// Two rules keep it honest. Only letters whose shape IS the Latin one at UI
// size. And the LOWERCASE key, because foldForBlocklist() lowercases before it
// looks here — which is what folds the identical-looking Cyrillic capitals
// (А В Е К М Н О Р С Т Х У) as well, for free. Where a letter's two cases look
// like two different Latin letters, the lowercase reading wins.
//
// The table can only ADD rejections, so its cost is paid in real names, and the
// cost is negative: ı, ø, ŧ, ł, đ and ĸ make Turkish, Danish, Norwegian, Polish,
// Vietnamese and Greenlandic spellings fold the way their own speakers
// transliterate them, instead of the letter silently vanishing.
export const LETTER_LOOKALIKE = Object.fromEntries([
  // Latin letters NFKD leaves alone: the strokes and bars...
  [0x0131, 'i'],   // ı  LATIN SMALL LETTER DOTLESS I
  [0x0142, 'l'],   // ł  LATIN SMALL LETTER L WITH STROKE
  [0x0111, 'd'],   // đ  LATIN SMALL LETTER D WITH STROKE
  [0x0127, 'h'],   // ħ  LATIN SMALL LETTER H WITH STROKE
  [0x0167, 't'],   // ŧ  LATIN SMALL LETTER T WITH STROKE
  [0x0180, 'b'],   // ƀ  LATIN SMALL LETTER B WITH STROKE
  [0x00F8, 'o'],   // ø  LATIN SMALL LETTER O WITH STROKE
  [0x0138, 'k'],   // ĸ  LATIN SMALL LETTER KRA
  // ...and the small capitals and the phonetic letters, which are the ones an
  // evader actually reaches for, because they are the closest shapes there are.
  [0x0261, 'g'],   // ɡ  LATIN SMALL LETTER SCRIPT G
  [0x0274, 'n'],   // ɴ  LATIN LETTER SMALL CAPITAL N
  [0x0280, 'r'],   // ʀ  LATIN LETTER SMALL CAPITAL R
  [0x0262, 'g'],   // ɢ  LATIN LETTER SMALL CAPITAL G
  [0x026A, 'i'],   // ɪ  LATIN LETTER SMALL CAPITAL I
  [0x029F, 'l'],   // ʟ  LATIN LETTER SMALL CAPITAL L
  [0x1D00, 'a'],   // ᴀ  LATIN LETTER SMALL CAPITAL A
  [0x1D04, 'c'],   // ᴄ  LATIN LETTER SMALL CAPITAL C
  [0x1D05, 'd'],   // ᴅ  LATIN LETTER SMALL CAPITAL D
  [0x1D07, 'e'],   // ᴇ  LATIN LETTER SMALL CAPITAL E
  [0x1D0B, 'k'],   // ᴋ  LATIN LETTER SMALL CAPITAL K
  [0x1D0F, 'o'],   // ᴏ  LATIN LETTER SMALL CAPITAL O
  [0x1D18, 'p'],   // ᴘ  LATIN LETTER SMALL CAPITAL P
  [0x1D1B, 't'],   // ᴛ  LATIN LETTER SMALL CAPITAL T
  [0x1D1C, 'u'],   // ᴜ  LATIN LETTER SMALL CAPITAL U
  [0x1D20, 'v'],   // ᴠ  LATIN LETTER SMALL CAPITAL V
  [0x1D21, 'w'],   // ᴡ  LATIN LETTER SMALL CAPITAL W
  [0x1D22, 'z'],   // ᴢ  LATIN LETTER SMALL CAPITAL Z
  // Cyrillic. The lowercase key also covers the capital, which is where the
  // resemblance is exact: А В Е К М Н О Р С Т Х У read as Latin at any size.
  [0x0430, 'a'],   // а  CYRILLIC SMALL LETTER A
  [0x0432, 'b'],   // в  CYRILLIC SMALL LETTER VE (В reads as B)
  [0x0435, 'e'],   // е  CYRILLIC SMALL LETTER IE
  [0x043A, 'k'],   // к  CYRILLIC SMALL LETTER KA
  [0x043C, 'm'],   // м  CYRILLIC SMALL LETTER EM (М reads as M)
  [0x043D, 'h'],   // н  CYRILLIC SMALL LETTER EN (Н reads as H)
  [0x043E, 'o'],   // о  CYRILLIC SMALL LETTER O
  [0x0440, 'p'],   // р  CYRILLIC SMALL LETTER ER
  [0x0441, 'c'],   // с  CYRILLIC SMALL LETTER ES
  [0x0442, 't'],   // т  CYRILLIC SMALL LETTER TE (Т reads as T)
  [0x0443, 'y'],   // у  CYRILLIC SMALL LETTER U
  [0x0445, 'x'],   // х  CYRILLIC SMALL LETTER HA
  [0x0455, 's'],   // ѕ  CYRILLIC SMALL LETTER DZE
  [0x0456, 'i'],   // і  CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  [0x0458, 'j'],   // ј  CYRILLIC SMALL LETTER JE
  [0x04CF, 'l'],   // ӏ  CYRILLIC SMALL LETTER PALOCHKA
  [0x0501, 'd'],   // ԁ  CYRILLIC SMALL LETTER KOMI DE
  [0x051B, 'q'],   // ԛ  CYRILLIC SMALL LETTER QA
  [0x051D, 'w'],   // ԝ  CYRILLIC SMALL LETTER WE
  // Greek. Same rule, and the same free cover for Α Β Ε Ι Κ Μ Ο Ρ Τ Χ.
  [0x03B1, 'a'],   // α  GREEK SMALL LETTER ALPHA
  [0x03B2, 'b'],   // β  GREEK SMALL LETTER BETA
  [0x03B5, 'e'],   // ε  GREEK SMALL LETTER EPSILON
  [0x03B7, 'n'],   // η  GREEK SMALL LETTER ETA
  [0x03B9, 'i'],   // ι  GREEK SMALL LETTER IOTA
  [0x03BA, 'k'],   // κ  GREEK SMALL LETTER KAPPA
  [0x03BC, 'm'],   // μ  GREEK SMALL LETTER MU (Μ reads as M)
  [0x03BD, 'v'],   // ν  GREEK SMALL LETTER NU
  [0x03BF, 'o'],   // ο  GREEK SMALL LETTER OMICRON
  [0x03C1, 'p'],   // ρ  GREEK SMALL LETTER RHO
  [0x03C4, 't'],   // τ  GREEK SMALL LETTER TAU
  [0x03C5, 'u'],   // υ  GREEK SMALL LETTER UPSILON
  [0x03C7, 'x'],   // χ  GREEK SMALL LETTER CHI
].map(([cp, to]) => [String.fromCodePoint(cp), to]));

// The Scunthorpe problem: BAD terms are matched as substrings of a folded form
// with its spaces removed, which is what catches "n i g g e r" and "n.1.g.g.3.r".
// The cost is that an innocent word can contain a term -- Scunthorpe contains one
// outright, and removing the spaces MANUFACTURES more at the word junctions:
// "Epic Untold", "Arctic Untamed" and "Sonic Until" all fold a c up against unt,
// and "Frag Head", "Drag Head" and "Crag Head" all fold rag up against head.
// Every one of those is a plausible name in an artillery game.
// These words are removed from the folded form before the terms are tested, so
// the innocent word passes and the bare term, and every spaced evasion of it,
// still does not.
//
// This comment used to say that removing a safe word "can only JOIN the text on
// either side of it", so no entry here could ever unblock a real term. That is
// true only while the safe word and the term are DISJOINT. Where they OVERLAP,
// the strip eats the term with the safe word: 'frag' shares 'rag' with the term
// on line 8 of the blocklist, so a name whose tokens folded together into 'f' +
// that term had 'frag' removed and shipped the rest, plainly legible, to
// everyone on the board; 'untold' shares 'unt' with the term on line 11 the same
// way. Neither word CONTAINS the other — containment is the direction the
// original safety check tested — and sharing three letters at an edge was
// enough. An entry here is now exempt only where it is a WHOLE TOKEN of the
// name, so it can never consume letters that belong to anything else.
//
// test/callsign.mjs generates the invariant from these two lists at run time:
// every (term, safe word) pair that shares an edge is welded back into the name
// that overlap produces and asserted refused. A future entry here that overlaps
// a term fails the suite on the run that adds it, rather than quietly turning
// that term off. Add a word here only when it is a real place or thing a player
// might legitimately be called.
export const SAFE_WORDS = ['scunthorpe', 'untold', 'untamed', 'until', 'frag', 'drag', 'crag'];

// trim() and \s both treat U+00A0 (no-break space) as whitespace, so a name
// pasted with hard spaces normalises to ordinary ones rather than failing the
// character check later with an error the player cannot see the cause of.
export function normaliseCallsign(raw) {
  // NFC before the shape check ever sees the result: "Zoé" typed on one keyboard
  // is e + a combining acute and on another is the single precomposed é. They
  // are the same name and they must be the same callsign — without this the
  // decomposed spelling was answered 'chars' while the identical-looking
  // precomposed one was accepted, and the two would otherwise take two different
  // key values and read as two different players.
  return String(raw ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function foldForBlocklist(s) {
  // NFKD, not NFD. NFD splits e-acute into e + a combining mark (and the mark is
  // not a-z, so the strip below removes it) — but it leaves a COMPATIBILITY
  // character exactly as it is, and the strip then deletes the character
  // itself. One fullwidth or mathematical-bold letter dropped into an otherwise
  // plain spelling therefore erased itself and let the rest of the name through,
  // while still rendering as the slur on every other player's screen. NFKD folds
  // fullwidth forms, the mathematical alphanumerics, modifier letters and
  // ligatures onto their ASCII bases in the same step.
  //
  // LETTER_LOOKALIKE is applied after NFKD, in the same pass as the leet map,
  // because NFKD is no help against a letter that is not a compatibility form.
  //
  // KNOWN GAP, deliberate, and stated as what it actually is rather than as the
  // narrower thing this comment used to claim: ANY letter NFKD does not reduce
  // to a-z DELETES ITSELF at the strip below, and a deleted letter breaks the
  // term around it while the name still renders as the slur. It was described
  // here as cross-script homoglyphs, which is only part of it — U+0131, the
  // Turkish dotless i, is an ordinary Latin letter. LETTER_LOOKALIKE closes the
  // realistic surface, Latin, Cyrillic and Greek alike, but it is a table, so it
  // is necessarily incomplete and every letter it does not name still deletes
  // itself. Closing the remainder needs the full confusables data or a
  // mixed-script rule, and either one starts refusing real names written in
  // those scripts; which names, and on whose say-so, is an owner decision and
  // not one to make quietly here. test/callsign.mjs pins the residual with a
  // Latin fixture AND a Cyrillic one, so closing half of it can never read as
  // the gap being gone.
  //
  // toLowerCase AFTER the normalise, not before: the astral mathematical letters
  // have no case mapping of their own, so lowercasing first is a no-op on them
  // and NFKD then yields ASCII CAPITALS, which the a-z strip would delete — a
  // mathematical-bold capital spelling would have walked straight through.
  const folded = String(s ?? '').normalize('NFKD').toLowerCase();
  // [...] iterates by code point. .split('') cuts an astral character into two
  // lone surrogates, neither of which can match a look-alike key, in a module
  // that counts code points everywhere else.
  return [...folded].map((c) => LOOKALIKE[c] || LETTER_LOOKALIKE[c] || c).join('').replace(/[^a-z]/g, '');
}

export function loadBlocklist(filePath) {
  let src;
  // "missing" must mean missing. EACCES, or a directory sitting where the file
  // should be, is a different boot problem, and reporting it as missing sends
  // whoever is debugging the boot off looking for a file that is right there.
  try {
    src = readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error('blocklist missing');
    throw new Error(`blocklist unreadable (${(e && e.code) || 'unknown'}): ${filePath}`);
  }
  if (!src.trim()) throw new Error('blocklist empty');
  const terms = [];
  for (const line of src.replace(/\r/g, '').replace(/\n$/, '').split('\n')) {
    const term = foldForBlocklist(line);
    // A blank line is the house rule. A line with no letters at all is worse than
    // blank: it folds to '', ''.includes() is true for every string, and one
    // stray separator line would reject every callsign on the service.
    if (!term) throw new Error('blocklist blank line');
    terms.push(term);
  }
  return terms;
}

export function validateCallsign(raw, terms) {
  // Fail CLOSED. This used to substitute [] for anything that was not an Array,
  // which meant a Set of the same terms, a forgotten second argument, or an
  // await that resolved to undefined turned the only moderation control in the
  // product off and returned { ok: true } for every name — silently, with
  // nothing to see until a slur reached another player's screen. A throw at the
  // boundary makes that a loud failure at wire-up time instead.
  if (!Array.isArray(terms)) throw new TypeError('validateCallsign: terms must be an array of blocklist terms');
  const name = normaliseCallsign(raw);
  const n = [...name].length;              // code points: one astral letter is one character
  if (n < CALLSIGN_MIN || n > CALLSIGN_MAX) return { ok: false, error: 'length' };
  if (!SHAPE.test(name)) return { ok: false, error: 'chars' };
  // foldForBlocklist() is exported and test/callsign.mjs asserts its exact
  // output (section 5), so the Scunthorpe fix cannot live inside it without
  // breaking that contract for every other caller. Instead, a second, private
  // copy of the fold -- used only for the term test below -- has every
  // SAFE_WORDS occurrence removed first, so an innocent word is exempt from
  // the substring test while the bare term inside it, folded the exact same
  // way, is still caught by the term loop.
  //
  // A WHOLE TOKEN, and that is the whole of the fix. A token that folds to
  // exactly a safe word is dropped; a token that merely CONTAINS one is kept
  // whole and tested like any other. Removing the safe word wherever it appeared
  // was what let it eat a term: 'F ' in front of the term on line 8 folds up
  // against 'frag', the strip took 'frag' away, and what was left matched
  // nothing — and the same weld inside ONE token did the same thing, which is
  // the first shape anyone testing this filter tries.
  //
  // THE TRADE, and it is deliberate: a one-word weld is refused even when it is
  // innocent. 'Craghead' — a village in County Durham — and the gaming spelling
  // of 'frag head' as one word are both refused now. That is accepted: whoever
  // is from the village can type 'Crag Head', which passes, and a clear error a
  // player can work around beats a slur welded into one word reaching every
  // other screen. Do not "fix" this by stripping inside a token again; the test
  // suite generates both shapes of weld and will fail if you do.
  const folded = name.split(' ').map((token) => {
    const t = foldForBlocklist(token);
    return SAFE_WORDS.includes(t) ? '' : t;
  }).join('');
  for (const term of terms) {
    if (term && folded.includes(term)) return { ok: false, error: 'not_allowed' };
  }
  return { ok: true, name, key: name.toLowerCase() };
}
