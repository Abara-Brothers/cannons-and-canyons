// server/display-name.js — the one proof of a name, in process.
//
// WHY THIS EXISTS: this is the rule that decides whether the server can vouch
// for another player's name before it is shown — the social layer's panels,
// search results, the blocked list, the squad roster and its invites, and the
// name a report records — and `profiles.callsign` is a column the account
// itself PATCHes on every cloud save. It was pulled out of server/social.js when
// a second call site needed the same rule; that call site was removed on
// 2026-09-30, and the module stayed, because a security rule with its own suite
// is worth more than an import count. A rule copied into two files drifts, and a
// drift here fails OPEN on the one string every other player has to look at
// (BINDING.md resolution 27). So the rule is ONE module with ONE suite, and this
// is it.
//
// It drives the REAL createNameProofs against the REAL server/blocklist.txt.
// A suite with its own term list would pass happily while the shipped list and
// the rule it is tested against drifted apart, which is the exact failure the
// extraction exists to prevent.
//
// Headless: no server, no browser, no Supabase. The module is pure apart from
// the one readFileSync that loads the blocklist.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadBlocklist, normaliseCallsign, validateCallsign } from '../server/callsign.js';
import { CALL_ADJ, CALL_NOUN, NAME_MAX, isGeneratedCallsign } from '../public/game-core.js';
import { createNameProofs } from '../server/display-name.js';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const LIST = fileURLToPath(new URL('../server/blocklist.txt', import.meta.url));
const terms = loadBlocklist(LIST);
// A term is never printed — not in a test name, not in an ok line, not in a
// fail line. It is named by its LINE in server/blocklist.txt, which is the
// thing an owner actually edits and the thing a failure needs to point at.
// (The same rule test/callsign.mjs follows.)
const line = (t) => terms.indexOf(t) + 1;
const NBSP = String.fromCodePoint(0x00A0);          // whitespace to trim() and to \s
const ACUTE = String.fromCodePoint(0x0301);         // COMBINING ACUTE ACCENT

const proofs = createNameProofs({ terms });

// ---- 1. the module's shape is the contract ---------------------------------
// Four functions, all pure and synchronous. `presentable` is deliberately NOT
// exported: it is the blocklist pass INSIDE displayName, and a caller that
// could reach it alone would be able to show a name with no proof behind it.
{
  const want = ['provenName', 'rolledName', 'displayName', 'seenName'];
  const missing = want.filter((k) => typeof proofs[k] !== 'function');
  if (!missing.length) ok('(1) createNameProofs({ terms }) returns provenName, rolledName, displayName and seenName');
  else fail(`(1) createNameProofs is missing ${missing.join(', ')}`);
  if (proofs.presentable === undefined) ok('(1) presentable is not exported — the blocklist pass is reachable only through displayName');
  else fail('(1) presentable escaped the module — a caller can now show a name with no proof behind it');
}

// ---- 2. PROOF ONE: the row's own callsign_key -------------------------------
// `callsign_key` is the only part of a profile row the server is entitled to
// believe: the phase 6 migration revokes update on it from the authenticated
// role, while `callsign` beside it stays writable so a cloud save can sync a
// rolled name. So the proof is that the writable column still case-folds onto
// the unwritable one.
{
  const CHOSEN = 'Wren Delacroix';                  // not a curated pair; a name only a chosen-name account can hold
  const KEY = 'wren delacroix';
  if (!isGeneratedCallsign(CHOSEN)) ok('(2) the fixture chosen name is NOT a rollable pair, so only the key can prove it');
  else fail('(2) the fixture chosen name is a curated pair — proof 2 would carry it and the tamper case would prove nothing');

  if (proofs.provenName({ callsign: CHOSEN, callsign_key: KEY }) === CHOSEN)
    ok('(2) a row whose callsign case-folds onto its own callsign_key returns that name');
  else fail(`(2) a matching row returned ${JSON.stringify(proofs.provenName({ callsign: CHOSEN, callsign_key: KEY }))}`);

  // THE TAMPER. The account PATCHed a different string into the column it owns
  // and left the key it cannot write alone.
  if (proofs.provenName({ callsign: 'Someone Else', callsign_key: KEY }) === null)
    ok('(2) a callsign that does NOT match its key is refused — the column the account writes cannot outvote the one it cannot');
  else fail('(2) a tampered callsign was returned as proven');

  for (const [key, why] of [[null, 'null'], ['', 'empty'], [undefined, 'absent'], [7, 'not a string']]) {
    if (proofs.provenName({ callsign: CHOSEN, callsign_key: key }) === null)
      ok(`(2) a ${why} key proves nothing`);
    else fail(`(2) a ${why} key was treated as a proof`);
  }
  if (proofs.provenName(null) === null && proofs.provenName(undefined) === null)
    ok('(2) a missing row is null, not a throw — one absent profile must not blank a whole panel');
  else fail('(2) a missing row did not read null');

  // The key was written as normaliseCallsign(name).toLowerCase(), so a
  // DECOMPOSED spelling of the same name must still prove itself: NFC runs
  // before the comparison, exactly as it ran before the key was derived.
  // (This is the only place a decomposed spelling can be tested at all — see
  // section 4: all 1,454 curated pairs are pure ASCII, so a decomposed copy of
  // a ROLLED name is byte-identical to its composed form.)
  const DECOMP = 'Zoe' + ACUTE + ' Ranger';
  const COMPOSED = normaliseCallsign(DECOMP);
  if (COMPOSED !== DECOMP) ok('(2) the decomposed fixture really is a different string from its NFC form');
  else fail('(2) the decomposed fixture did not decompose — the next check would be vacuous');
  if (proofs.provenName({ callsign: DECOMP, callsign_key: COMPOSED.toLowerCase() }) === COMPOSED)
    ok('(2) a decomposed spelling of a chosen name still folds onto its key, and the NFC form is what is returned');
  else fail(`(2) decomposed chosen name: ${JSON.stringify(proofs.provenName({ callsign: DECOMP, callsign_key: COMPOSED.toLowerCase() }))}`);
}

// ---- 3. PROOF TWO: a curated rolled pair ------------------------------------
// A player does not type a name, they roll one from two curated lists
// (ISSUE-015), so "<Adj> <Noun>" out of those lists is a SELECTION FROM A FIXED
// VOCABULARY, not attacker-chosen text. Without this proof a null name would be
// the COMMON case, since most players never choose one.
{
  const PAIR = 'Rusty Gulch';
  if (isGeneratedCallsign(PAIR)) ok('(3) the fixture rolled pair is one the engine itself would accept');
  else fail('(3) the fixture rolled pair is not a curated pair');

  if (proofs.displayName({ callsign: PAIR, callsign_key: null }) === PAIR)
    ok('(3) a curated rolled pair with NO key is named — the second proof, or most of every panel would be blank');
  else fail(`(3) rolled pair with no key: ${JSON.stringify(proofs.displayName({ callsign: PAIR, callsign_key: null }))}`);

  // Free text wearing the SHAPE of a pair: 'Zephyr' is in neither list.
  for (const raw of ['Zephyr Twelve', 'Iron Sixty', 'not a pair at all', '', 'Iron', 'Iron Ridge Extra']) {
    if (proofs.displayName({ callsign: raw, callsign_key: null }) === null) ok(`(3) free text with no key is refused: ${JSON.stringify(raw)}`);
    else fail(`(3) free text was named: ${JSON.stringify(raw)} -> ${JSON.stringify(proofs.displayName({ callsign: raw, callsign_key: null }))}`);
  }

  // SLOPPY SPELLINGS OF A REAL PAIR. isGeneratedCallsign is deliberately strict
  // — no trim, no case fold, no collapse — so the normaliser has to run first or
  // a double-spaced copy of a legitimate rolled name costs that player their
  // name. What comes back is the pair, spelled the one way.
  for (const [raw, why] of [
    ['  Rusty   Gulch ', 'padded and double-spaced'],
    ['Rusty' + NBSP + 'Gulch', 'joined by a no-break space'],
    ['Rusty\tGulch', 'joined by a tab'],
  ]) {
    const got = proofs.displayName({ callsign: raw, callsign_key: null });
    if (got === PAIR) ok(`(3) a ${why} copy of a real pair resolves to the pair itself`);
    else fail(`(3) ${why}: ${JSON.stringify(got)}`);
  }

  // EVERY pair, against the SHIPPED blocklist. displayName's last step re-tests
  // the name against a list that moves, and this is the assertion that says the
  // list moving never costs a rolled player their name. It is also the reason
  // the suite must load the real server/blocklist.txt.
  const lost = [];
  let n = 0;
  for (const a of CALL_ADJ) for (const b of CALL_NOUN) {
    const name = `${a} ${b}`;
    if (name.length > NAME_MAX) continue;
    n++;
    if (proofs.displayName({ callsign: name, callsign_key: null }) !== name) lost.push(name);
  }
  if (n === 1454 && !lost.length) ok(`(3) all ${n} rollable pairs survive the shipped blocklist — the re-test costs no rolled player their name`);
  else if (lost.length) fail(`(3) ${lost.length} of ${n} rollable pairs are refused by the shipped list: ${lost.slice(0, 6).join(', ')}`);
  else fail(`(3) ${n} pairs were built, not 1454 — the curated lists moved and this assertion is no longer measuring what it says`);
}

// ---- 4. IMPERSONATION: a chosen name worn without the key -------------------
// THE REASON THIS TASK EXISTS. Uniqueness lives on `callsign_key`, which no
// client may write; the display column beside it is written on every cloud
// save. Without this refusal an account could PATCH somebody else's proven
// callsign into its own row and be painted as that person on a screen that
// carries no seat handle — so the name could not even be reported or blocked
// from where it appeared.
{
  const VICTIM = { id: 'a', callsign: 'Wren Delacroix', callsign_key: 'wren delacroix' };
  const IMPOSTOR = { id: 'b', callsign: 'Wren Delacroix', callsign_key: null };

  if (proofs.displayName(VICTIM) === 'Wren Delacroix') ok('(4) the account that HOLDS the key is still named');
  else fail(`(4) the legitimate holder lost their name: ${JSON.stringify(proofs.displayName(VICTIM))}`);

  if (proofs.displayName(IMPOSTOR) === null)
    ok('(4) an account wearing another player’s chosen callsign without the key is NOT named — the impersonation case');
  else fail(`(4) IMPERSONATION REACHED THE SCREEN: ${JSON.stringify(proofs.displayName(IMPOSTOR))}`);
  if (proofs.seenName(IMPOSTOR) === null)
    ok('(4) and a report about the impostor records no name either, so the log cannot be forged into somebody else’s');
  else fail(`(4) impersonation reached the report row: ${JSON.stringify(proofs.seenName(IMPOSTOR))}`);

  // The honest limit, stated so nobody reads more into proof 2 than it carries:
  // a rolled pair was NEVER unique, and two players have always been able to
  // hold the same one. Wearing a chosen name that happens also to be a curated
  // pair is therefore no new weakness — wearing one that is not stays impossible.
  const PAIR_HOLDER = { id: 'c', callsign: 'Iron Ridge', callsign_key: 'iron ridge' };
  const PAIR_WEARER = { id: 'd', callsign: 'Iron Ridge', callsign_key: null };
  if (proofs.displayName(PAIR_HOLDER) === 'Iron Ridge' && proofs.displayName(PAIR_WEARER) === 'Iron Ridge')
    ok('(4) a CHOSEN name that is also a rollable pair is carried by proof 2 for anyone — a collision rolled names always had');
  else fail('(4) the rolled-pair collision case changed behaviour');
}

// ---- 5. THE ASYMMETRY (BINDING.md resolution 26) ----------------------------
// displayName re-runs the blocklist; seenName does NOT. The blocklist is read at
// start-up and a term can be added AFTER a name was stored, so the panel must
// stop showing that name today. A REPORT must do the opposite: the single case
// moderation exists for is a name that got through and was blocklisted
// afterwards, and re-running the moved list over it recorded "(no name)" about a
// player whose name was still on other people's screens — the evidence destroyed
// at exactly the moment it was needed.
{
  // A name PROVEN by its key whose spelling the shipped list refuses. Built from
  // a real term so the two halves cannot drift; never printed.
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  const term = terms.find((t) => /^[a-z]{3,16}$/.test(t) && validateCallsign(cap(t), terms).error === 'not_allowed');
  if (!term) {
    fail('(5) no shipped term can be spelled as a bare callsign — the asymmetry cannot be tested against the real list');
  } else {
    const name = cap(term);
    const row = { id: 'e', callsign: name, callsign_key: name.toLowerCase() };
    if (proofs.provenName(row) === name) ok(`(5) the fixture name (blocklist line ${line(term)}) is PROVEN by its key, so both functions reach their last step`);
    else fail(`(5) the fixture name (blocklist line ${line(term)}) is not proven by its key — the next two checks would prove nothing`);
    if (proofs.displayName(row) === null) ok(`(5) displayName re-runs the blocklist: a name refused by line ${line(term)} is off the panel today`);
    else fail(`(5) a blocklisted name reached the panel (line ${line(term)})`);
    if (proofs.seenName(row) === name) ok(`(5) seenName does NOT re-run it: the report still records the name the reporter actually saw (line ${line(term)})`);
    else fail(`(5) seenName re-filtered the evidence (line ${line(term)}): ${JSON.stringify(proofs.seenName(row))}`);
  }

  // Both still refuse what neither proof carries.
  if (proofs.seenName({ callsign: 'Zephyr Twelve', callsign_key: null }) === null)
    ok('(5) seenName skips the blocklist, never a proof — unprovable free text is still null');
  else fail('(5) seenName carried free text');
}

// ---- 6. rolledName is the raw-string proof, and it is filtered ---------------
// rolledName takes a STRING, not a row: it is proof 2 on its own, and both
// displayName and seenName call it that way.
{
  if (proofs.rolledName('Rusty Gulch') === 'Rusty Gulch' && proofs.rolledName('  Rusty  Gulch ') === 'Rusty Gulch')
    ok('(6) rolledName takes a raw string and returns the normalised pair');
  else fail('(6) rolledName argument shape changed');
  if (proofs.rolledName('Zephyr Twelve') === null && proofs.rolledName(null) === null && proofs.rolledName(undefined) === null)
    ok('(6) rolledName refuses anything that is not a curated pair, including null and undefined');
  else fail('(6) rolledName accepted a non-pair');

  // THE PROFANITY GUARD, PINNED IN SOURCE AND SAID PLAINLY WHY. Measured against
  // the shipped lists: 0 of the 1,454 rollable pairs is profane, so there is no
  // input that can make `!isProfane(name)` change an answer. It is the guard that
  // keeps a future addition to CALL_ADJ or CALL_NOUN from shipping a pair the
  // engine's own filter would refuse, and a behavioural test for it cannot exist
  // while the lists stay clean. This is a source tripwire, not a proof — what
  // proves the FILTER is test/callsign.mjs and the engine's own suites.
  const src = readFileSync(fileURLToPath(new URL('../server/display-name.js', import.meta.url)), 'utf8');
  const start = src.indexOf('const rolledName =');
  const body = start < 0 ? '' : src.slice(start, src.indexOf('\n', src.indexOf('};', start)));
  if (!body) fail('(6) no "const rolledName =" in server/display-name.js — proof 2 has no body to check');
  else {
    if (/isGeneratedCallsign\(/.test(body)) ok('(6) rolledName tests the name against isGeneratedCallsign');
    else fail('(6) rolledName does not call isGeneratedCallsign — proof 2 no longer proves anything');
    if (/!isProfane\(/.test(body)) ok('(6) rolledName also refuses a profane pair, so a future list addition cannot ship one');
    else fail('(6) rolledName no longer applies isProfane — a profane pair added to the curated lists would be carried by proof 2');
  }
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall display-name checks passed');
process.exit(out.errors.length ? 1 : 0);
