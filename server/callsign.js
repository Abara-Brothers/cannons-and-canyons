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

// Unicode letters, digits, and single interior spaces. The anchors also enforce
// "no leading or trailing space" and "no run of spaces" — both of which
// normaliseCallsign() has already made impossible. The rule is still written
// out, because validateCallsign() is a boundary and a boundary that trusts its
// own caller is not one.
const SHAPE = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u;

// Look-alikes, exactly the nine in the design. '8'->'b' and '!'->'i' are in the
// engine's older LEET map but NOT here: the design fixes this map, and the two
// halves are allowed to differ because they guard different things.
const LOOKALIKE = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '|': 'i' };

// The Scunthorpe problem: BAD terms are matched as substrings of a folded form
// with its spaces removed, which is what catches "n i g g e r" and "n.1.g.g.3.r".
// The cost is that an innocent word can contain a term -- Scunthorpe contains one.
// These words are removed from the folded form before the terms are tested, so
// the innocent word passes and the bare term, and every spaced evasion of it,
// still does not. Add a word here only when it is a real place or thing a player
// might legitimately be called.
const SAFE_WORDS = ['scunthorpe'];

// trim() and \s both treat U+00A0 (no-break space) as whitespace, so a name
// pasted with hard spaces normalises to ordinary ones rather than failing the
// character check later with an error the player cannot see the cause of.
export function normaliseCallsign(raw) {
  return String(raw ?? '').trim().replace(/\s+/gu, ' ');
}

export function foldForBlocklist(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')       // e-acute becomes e + a combining mark, and the mark is not a-z
    .split('')
    .map((c) => LOOKALIKE[c] || c)
    .join('')
    .replace(/[^a-z]/g, '');
}

export function loadBlocklist(filePath) {
  let src;
  try { src = readFileSync(filePath, 'utf8'); } catch { throw new Error('blocklist missing'); }
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
  for (const term of (Array.isArray(terms) ? terms : [])) {
    if (term && folded.includes(term)) return { ok: false, error: 'not_allowed' };
  }
  return { ok: true, name, key: name.toLowerCase() };
}
