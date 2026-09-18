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

// Unicode letters, digits, combining marks, and single interior spaces. The
// anchors also enforce "no leading or trailing space" and "no run of spaces" —
// both of which normaliseCallsign() has already made impossible. The rule is
// still written out, because validateCallsign() is a boundary and a boundary
// that trusts its own caller is not one.
//
// \p{M} is in the class because whole writing systems are unusable without it:
// हिन्दी, สุดา and Hebrew with niqqud are letters PLUS combining marks, and a class
// of letters-and-digits alone answers 'chars' to every one of them — a large
// share of the world told its own name is a character error, while this same
// file's tests advertise that a Cyrillic or Japanese callsign is legitimate.
// It widens who can play without widening what gets through: foldForBlocklist()
// strips marks before the terms are tested, and the 16-code-point cap already
// bounds any stack of them.
//
// Every TOKEN must still start with a letter or a digit, and marks may only
// follow one. A combining mark is by definition something that attaches to a
// base character, so a token that opens with one has no base to attach to: it
// renders as stacked garbage, or as nothing at all, on every other player's
// screen — which is the kind of name this file exists to keep off the board.
// Admitting \p{M} without this would have allowed a callsign made of nothing
// but marks. No script pays for the rule: in Devanagari, Thai and Hebrew the
// mark follows its base in LOGICAL order even where it RENDERS to the left of
// it, so every one of those names still begins with a letter.
const SHAPE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?: [\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*$/u;

// Look-alikes, exactly the nine in the design. '8'->'b' and '!'->'i' are in the
// engine's older LEET map but NOT here: the design fixes this map, and the two
// halves are allowed to differ because they guard different things.
// '@', '$' and '|' are unreachable THROUGH validateCallsign — SHAPE rejects a
// name containing any of them before the fold is ever reached — so the map is
// deliberately broader than that one path needs. foldForBlocklist() is exported
// and folds the blocklist file itself, and the extra keys cost nothing.
const LOOKALIKE = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '|': 'i' };

// The Scunthorpe problem: BAD terms are matched as substrings of a folded form
// with its spaces removed, which is what catches "n i g g e r" and "n.1.g.g.3.r".
// The cost is that an innocent word can contain a term -- Scunthorpe contains one
// outright, and removing the spaces MANUFACTURES more at the word junctions:
// "Epic Untold", "Arctic Untamed" and "Sonic Until" all fold a c up against unt,
// and "Frag Head", "Drag Head" and "Crag Head" all fold rag up against head.
// Every one of those is a plausible name in an artillery game.
// These words are removed from the folded form before the terms are tested, so
// the innocent word passes and the bare term, and every spaced evasion of it,
// still does not. Removing a safe word can only JOIN the text on either side of
// it, which manufactures matches rather than destroying them, so no entry here
// can unblock a real term — and test/callsign.mjs proves that rather than
// asserting it, by checking every term in the shipped file is still refused.
// Add a word here only when it is a real place or thing a player might
// legitimately be called.
const SAFE_WORDS = ['scunthorpe', 'untold', 'untamed', 'until', 'frag', 'drag', 'crag'];

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
  // KNOWN GAP, deliberate: cross-script homoglyphs — a Cyrillic 'а' or a Greek
  // 'ο' that LOOKS Latin — survive NFKD untouched, because they are genuinely
  // different letters and not compatibility forms of Latin ones. Closing that
  // needs a confusables table or a mixed-script rule, and either one starts
  // refusing real names written in those scripts; which names, and on whose
  // say-so, is an owner decision and not one to make quietly here.
  //
  // toLowerCase AFTER the normalise, not before: the astral mathematical letters
  // have no case mapping of their own, so lowercasing first is a no-op on them
  // and NFKD then yields ASCII CAPITALS, which the a-z strip would delete — a
  // mathematical-bold capital spelling would have walked straight through.
  const folded = String(s ?? '').normalize('NFKD').toLowerCase();
  // [...] iterates by code point. .split('') cuts an astral character into two
  // lone surrogates, neither of which can match a look-alike key, in a module
  // that counts code points everywhere else.
  return [...folded].map((c) => LOOKALIKE[c] || c).join('').replace(/[^a-z]/g, '');
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
  let folded = foldForBlocklist(name);
  for (const safe of SAFE_WORDS) folded = folded.split(safe).join('');
  for (const term of terms) {
    if (term && folded.includes(term)) return { ok: false, error: 'not_allowed' };
  }
  return { ok: true, name, key: name.toLowerCase() };
}
