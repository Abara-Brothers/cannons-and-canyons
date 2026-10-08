// server/display-name.js — the one proof of a name, in process.
//
// WHY THIS EXISTS: this is the rule that decides whether the server can vouch
// for another player's name before it is shown — the social layer's panels,
// search results, the blocked list, the squad roster and its invites, and the
// name a report records — and `profiles.callsign` is a column the account
// itself PATCHes on every cloud save. It was pulled out of server/social.js when
// a second call site needed the same rule; that call site was removed on
// 2026-09-30, and the module stayed, because a security rule with its own suite
// is worth more than an import count. It has a second caller again since
// 2026-10-07: server.js installs its playerName as the room engine's name check
// (section 7). A rule copied into two files drifts, and a
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
import { CALL_ADJ, CALL_NOUN, NAME_MAX, isGeneratedCallsign, isProfane } from '../public/game-core.js';
import { createNameProofs, systemName } from '../server/display-name.js';
import { createNameIndex } from '../server/name-index.js';

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

// keyState 'free' for every key: sections 1 to 7 are about the rules a name
// meets on its own. Section 9 drives the uniqueness half, with every answer
// the index can give.
const proofs = createNameProofs({ terms, keyState: () => 'free' });

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

// ---- 7. THE GUIDELINES: a name a player typed (owner, 2026-10-07) ----------
// "The player is given a default name and then they can change it to whatever
// they like, as long as it stays within the guidelines." checkPlayerName is the
// guidelines — the callsign rules, the SHIPPED blocklist and the engine's own
// isProfane — answered with the reason, for the check op that tells a player;
// playerName is the same test as a yes-or-no, for the room engine's door. One
// function behind both, driven here against the real list, because a name the
// check passes and the lobby then renames would be the same broken promise the
// two-list drift above is about.
{
  const { checkPlayerName, playerName } = proofs;
  if (typeof checkPlayerName === 'function' && typeof playerName === 'function')
    ok('(7) createNameProofs also returns checkPlayerName and playerName');
  else fail('(7) checkPlayerName / playerName are missing from createNameProofs');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (typeof checkPlayerName === 'function' && typeof playerName === 'function') {
    // A good name, normalised the one way validateCallsign does it.
    // CHANGED (round 2, 2026-10-08): a pass also carries `key`, validateCallsign's
    // own callsign_key spelling, which the Set stores and the index is asked by.
    if (same(checkPlayerName('  Tank   Ace' + NBSP), { ok: true, name: 'Tank Ace', key: 'tank ace' }) && playerName('  Tank   Ace' + NBSP) === 'Tank Ace')
      ok('(7) a good name passes, trimmed and collapsed to the one normalised form with its key, and that form is what playerName returns');
    else fail(`(7) good name: ${JSON.stringify(checkPlayerName('  Tank   Ace' + NBSP))} / ${JSON.stringify(playerName('  Tank   Ace' + NBSP))}`);
    // Every refusal says why, and playerName says null for every one.
    const CASES = [['ab', 'length'], ['x'.repeat(17), 'length'], ['Tank<b>', 'chars'], ['', 'length'], [null, 'length']];
    // A SHIPPED blocklist term in the shape a player types. Named by its line.
    const term = terms.find((t) => t.length >= 3 && t.length <= 10);
    if (term) CASES.push([`${term[0].toUpperCase()}${term.slice(1)} Ridge`, 'not_allowed', `the blocklist term on line ${line(term)}`]);
    else fail('(7) no blocklist term short enough for the "<term> Ridge" shape');
    // An engine-only term: refused by isProfane, PASSED by the shipped list.
    // Derived from public/game-core.js, never spelled here.
    const core = readFileSync(fileURLToPath(new URL('../public/game-core.js', import.meta.url)), 'utf8');
    const listOf = (n) => [...(((core.match(new RegExp(`const ${n} = \\[([\\s\\S]*?)\\];`)) || [])[1]) || '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const gap = [...listOf('BAD_SUB'), ...listOf('BAD_WORD')]
      .map((t) => `${t[0].toUpperCase()}${t.slice(1)} Ridge`)
      .filter((n) => [...n].length <= 16 && validateCallsign(n, terms).ok === true);
    if (gap.length) CASES.push([gap[0], 'not_allowed', 'an engine-only profanity term the shipped list lets through']);
    else fail('(7) no engine term sits in the gap between the two lists — the isProfane half of the check is untested');
    let bad = 0;
    for (const [raw, error, label] of CASES) {
      const v = checkPlayerName(raw);
      // The answer is reported by its code alone: an ok answer carries the
      // name, and for a term fixture that name IS the term.
      if (!(same(v, { ok: false, error }) && playerName(raw) === null)) { bad++; fail(`(7) ${label || JSON.stringify(raw)} gave ${v && v.ok ? 'ok' : JSON.stringify(v && v.error)}, playerName ${playerName(raw) === null ? 'null' : 'a name'}`); }
    }
    if (!bad) ok(`(7) ${CASES.length} refusals carry their code and playerName answers null for each: length, chars, a shipped blocklist term, and ${gap.length} engine-only term(s) in the gap, the first of them checked`);
    // EVERY engine-only term in the gap is refused, not a sample: the door
    // must never show a name the lobby's isProfane would then rename.
    const leaked = gap.filter((n) => playerName(n) !== null);
    if (!leaked.length) ok(`(7) all ${gap.length} engine-only term(s) the shipped list lets through are refused by playerName`);
    else fail(`(7) ${leaked.length} engine-only term(s) passed playerName`);
    // NO ROLLED PLAYER IS REFUSED: every one of the 1,454 pairs passes, so the
    // third door never contradicts the second.
    let pairs = 0, refused = 0;
    for (const a of CALL_ADJ) for (const n of CALL_NOUN) {
      const pair = `${a} ${n}`;
      if ([...pair].length > NAME_MAX) continue;
      pairs++;
      if (playerName(pair) !== pair) refused++;
    }
    if (pairs > 1000 && refused === 0) ok(`(7) all ${pairs} rollable pairs pass the guidelines unchanged`);
    else fail(`(7) ${refused} of ${pairs} rollable pairs are refused or altered by playerName`);
    // NOT A PROOF: a typed name the guidelines pass still names no ROW. A panel
    // shows a row only by its key or a curated pair, so a typed name cannot be
    // worn in a friends list on the strength of this check.
    if (playerName('Tank Ace') === 'Tank Ace' && proofs.displayName({ callsign: 'Tank Ace', callsign_key: null }) === null
        && proofs.seenName({ callsign: 'Tank Ace', callsign_key: null }) === null)
      ok('(7) a typed name that passes the guidelines still proves no profile row: displayName and seenName answer null without a key');
    else fail('(7) a typed name was accepted as a row name');
  }
}

// ---- 8. THE GAME'S OWN NAMES (round 2, 2026-10-08) -------------------------
// A name a player chooses may not pass for one the game shows: the computer
// seats, the boss, the alien seats, and the words the client writes where a
// seat has no name. The bot names are READ OUT OF public/room-engine.js, so a
// renamed boss or a new alien seat is checked the day it ships; each is typed
// the way a player could type it (the callsign shape refuses '-' and the
// middle dot), and again with look-alikes.
{
  const { checkPlayerName, playerName } = proofs;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const eng = readFileSync(fileURLToPath(new URL('../public/room-engine.js', import.meta.url)), 'utf8');
  const boss = (eng.match(/boss: true, difficulty: 'boss', name: '([^']+)'/) || [])[1];
  const horde = [...(((eng.match(/names: \[([^\]]*)\]/) || [])[1]) || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const cpuTemplates = eng.includes("mode === 'ffa' ? `CPU ${seat}` : `CPU · ${label}`");
  if (boss && horde.length === 3 && cpuTemplates) ok(`(8) the engine's computer names were read from public/room-engine.js: the boss, ${horde.length} alien seats and the two CPU templates`);
  else fail('(8) could not read the computer names out of public/room-engine.js: ' + JSON.stringify({ boss, horde, cpuTemplates }));
  const typeable = (n) => n.replace(/[-·]/g, ' ').replace(/\s+/g, ' ').trim();
  const BOT = [boss, ...horde].filter(Boolean).map(typeable)
    .concat(['CPU 1', 'CPU 2', 'CPU 3', 'CPU Easy', 'CPU Medium', 'CPU Hard', 'CPU'])
    .concat(['W4RL0RD 7', 'Iron Warlord', 'C P U 2', 'cpu hard', 'Xen0 Scout', 'XENO']);
  const SYSTEM = ['You', 'Opponent', 'A player', 'Player', 'Player 2', 'Player 1', 'Host', 'Guest', 'No callsign', 'No name', 'Computer', 'C0MPUTER'];
  const bad = [...BOT, ...SYSTEM].filter((n) => !(same(checkPlayerName(n), { ok: false, error: 'not_allowed' }) && playerName(n) === null));
  if (!bad.length) ok(`(8) ${BOT.length} computer names and ${SYSTEM.length} of the client's stand-in words are refused not_allowed, typed plainly or in look-alikes`);
  else fail('(8) names that pass for the game\'s own were allowed: ' + JSON.stringify(bad.map((n) => [n, checkPlayerName(n)])));
  // ONLY THE GAME'S NAMES: a word that merely starts like one is a name.
  const FINE = ['Hostile Mesa', 'Guest One', 'Player One', 'Youngblood', 'Cupcake', 'Tank Ace', 'Warden Six', 'Computer Ace'];
  const lost = FINE.filter((n) => playerName(n) !== n);
  if (!lost.length) ok(`(8) ${FINE.length} names that only resemble them still pass: ${FINE.join(', ')}`);
  else fail('(8) ordinary names refused as the game\'s own: ' + JSON.stringify(lost));
  if (typeof systemName === 'function' && systemName('Warlord 7') === true && systemName('Tank Ace') === false)
    ok('(8) systemName is exported from server/display-name.js for its callers and this suite');
  else fail('(8) systemName is not exported, or answers wrongly');
}

// ---- 9. NOBODY'S CHOSEN CALLSIGN (round 2, 2026-10-08) -----------------------
// A typed name shown with no key behind it may not equal an account's chosen
// callsign after the callsign_key normalisation. keyState is the in-memory
// index's answer; 'unknown' (not loaded, no store) refuses, and so does a
// keyState that throws, and so does the DEFAULT, which a caller that forgets to
// pass one gets. The rules come first: a name they refuse never asks the index.
{
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const asked = [];
  const TAKEN = new Set(['viper', 'zoé kite']);
  const P = createNameProofs({ terms, keyState: (k) => { asked.push(k); return TAKEN.has(k) ? 'taken' : 'free'; } });
  const r1 = P.typedName('  VIPER ');
  const r2 = P.typedName('Zo' + 'e' + ACUTE + ' Kite');           // decomposed: the key is the NFC one
  const r3 = P.typedName('Tank Ace');
  const keys = asked.slice();
  asked.length = 0;
  const r4 = P.typedName('ab');
  const r5 = P.typedName('Warlord 7');
  const ruleFirst = asked.length === 0 && same(r4, { ok: false, error: 'length' }) && same(r5, { ok: false, error: 'not_allowed' });
  if (same(r1, { ok: false, error: 'taken' }) && same(r2, { ok: false, error: 'taken' }) && P.playerName('Viper') === null
      && same(r3, { ok: true, name: 'Tank Ace', key: 'tank ace' }) && P.playerName('Tank Ace') === 'Tank Ace'
      && same(keys, ['viper', 'zoé kite', 'tank ace']) && ruleFirst)
    ok("(9) a typed name that normalises onto an account's key is refused 'taken' and playerName answers null; the index is asked by the callsign_key spelling (case, spaces and NFC folded) and never for a name the rules refuse");
  else fail('(9) uniqueness: ' + JSON.stringify({ r1, r2, r3, keys, r4, r5, asked }));
  const U = createNameProofs({ terms, keyState: () => 'unknown' });
  const T = createNameProofs({ terms, keyState: () => { throw new Error('index down'); } });
  const D = createNameProofs({ terms });
  const W = createNameProofs({ terms, keyState: () => 'maybe' });
  const closed = [U, T, D, W].map((x) => [x.typedName('Tank Ace'), x.playerName('Tank Ace')]);
  if (closed.every(([v, n]) => same(v, { ok: false, error: 'unavailable' }) && n === null))
    ok("(9) an index that has not loaded, one that throws, one that answers nonsense and no index at all all refuse 'unavailable': the default name is shown, never one that might be someone else's");
  else fail('(9) fail closed: ' + JSON.stringify(closed));
  // THE SET'S RULES DO NOT ASK THE INDEX: its uniqueness is the unique index's,
  // at the write. checkPlayerName answers the same with every keyState.
  asked.length = 0;
  const c1 = P.checkPlayerName('Viper'), c2 = U.checkPlayerName('Viper');
  if (same(c1, { ok: true, name: 'Viper', key: 'viper' }) && same(c2, c1) && asked.length === 0)
    ok('(9) checkPlayerName (the Set\'s rules) never asks the index: a held name passes the rules and the write decides');
  else fail('(9) checkPlayerName asked the index: ' + JSON.stringify({ c1, c2, asked }));
}

// ---- 10. THE GUEST'S SEAT AND THE REPORTED SEAT (round 2, 2026-10-08) --------
// guestName is what a squad seat shows for a guest row: what the engine's
// door would show in a lobby. seatName is the shape-only proof a report puts
// on the name a lobby seat showed: no blocklist pass (the evidence must
// survive a term added later), and nothing that could forge a log line.
{
  const P = createNameProofs({ terms, keyState: (k) => (k === 'viper' ? 'taken' : 'free') });
  const U = createNameProofs({ terms, keyState: () => 'unknown' });
  const term = terms.find((t) => t.length >= 3 && t.length <= 10);
  const termName = term ? `${term[0].toUpperCase()}${term.slice(1)} Ridge` : null;
  const g = {
    rolled: P.guestName('Iron Ridge'), rolledSpaced: P.guestName('  Iron   Ridge '), rolledUnknown: U.guestName('Iron Ridge'),
    typed: P.guestName('  Tank   Ace '), taken: P.guestName('Viper'), unknown: U.guestName('Tank Ace'),
    system: P.guestName('CPU 2'), short: P.guestName('G'), none: P.guestName(undefined), term: termName ? P.guestName(termName) : null,
  };
  if (g.rolled === 'Iron Ridge' && g.rolledSpaced === 'Iron Ridge' && g.rolledUnknown === 'Iron Ridge' && g.typed === 'Tank Ace'
      && g.taken === null && g.unknown === null && g.system === null && g.short === null && g.none === null && g.term === null && termName)
    ok("(10) guestName shows a rolled pair (as the door's second door does, index or no index) and a typed name the guidelines pass and no account holds, normalised; a held, unknown, system, short, missing or blocklisted name is null");
  else fail('(10) guestName: ' + JSON.stringify({ ...g, term: g.term === null ? null : 'a name' }));
  const s = {
    typed: P.seatName('Tank Ace'), held: P.seatName('Viper'), bossSeat: P.seatName('WARLORD-7'),
    nl: P.seatName('Tank\nAce'), quote: P.seatName('Tank "Ace"'), num: P.seatName(42), nul: P.seatName(null),
    term: termName ? P.seatName(termName) : null,
  };
  if (s.typed === 'Tank Ace' && s.held === 'Viper' && s.bossSeat === null && s.nl === 'Tank Ace' && s.quote === null && s.num === null && s.nul === null && s.term === termName)
    ok('(10) seatName keeps any name of the callsign shape, a held or blocklisted one included (the evidence stays); a newline can only come out as a space, and a quote, a hyphen and anything not a string are refused');
  else fail('(10) seatName: ' + JSON.stringify({ ...s, term: s.term === termName ? 'kept' : 'lost' }));
}

// ---- 11. THE NAME INDEX (server/name-index.js) ------------------------------
// The in-memory answer keyState gives. Driven with a fake loader: pages in key
// order, the read stopping at an EMPTY page (never a short one, which a row
// cap below the page size would make), 'unknown' until the first read lands,
// the last good set kept when a refresh fails, and a write that lands while a
// read is out replayed onto what the read returns.
{
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const pager = (keys, cap = Infinity) => {
    const calls = [];
    const fn = async (after, limit) => {
      calls.push([after, limit]);
      const from = after === null ? 0 : keys.indexOf(after) + 1;
      return keys.slice(from, from + Math.min(limit, cap));
    };
    return { fn, calls };
  };
  const a = pager(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  const I = createNameIndex({ load: a.fn, page: 2 });
  const before = [I.state('alpha'), I.ready];
  const r = await I.refresh();
  const after = ['alpha', 'echo', 'foxtrot'].map((k) => I.state(k));
  if (same(before, ['unknown', false]) && r === true && I.ready && same(after, ['taken', 'taken', 'free']) && I.size === 5
      && same(a.calls, [[null, 2], ['bravo', 2], ['delta', 2], ['echo', 2]]))
    ok('(11) unknown until the first read lands; then every key read in pages from the last key of the page before, to an EMPTY page');
  else fail('(11) load: ' + JSON.stringify({ before, r, after, size: I.size, calls: a.calls }));
  // A ROW CAP BELOW THE PAGE SIZE: every page comes back short, and the read
  // must go on to the empty page rather than stop at the first short one.
  const c = pager(['alpha', 'bravo', 'charlie', 'delta', 'echo'], 2);
  const C = createNameIndex({ load: c.fn, page: 1000 });
  await C.refresh();
  if (C.size === 5 && C.state('echo') === 'taken') ok('(11) a store that caps a page below the size asked for still gives every key: a short page is not the last one');
  else fail('(11) capped pages: ' + JSON.stringify({ size: C.size, calls: c.calls }));
  // A FAILED FIRST READ stays unknown and is reported, whether the read throws
  // or answers something that is not a list.
  const errs = [];
  let mode = 'throw';
  const F = createNameIndex({ load: async () => { if (mode === 'throw') throw new Error('store down'); return 'nope'; }, onError: (e) => errs.push(e.message) });
  const f1 = await F.refresh();
  mode = 'junk';
  const f2 = await F.refresh();
  if (f1 === false && f2 === false && F.state('viper') === 'unknown' && !F.ready && errs.length === 2 && errs[0] === 'store down' && /not a list/.test(errs[1]))
    ok('(11) a read that throws or answers something that is not a list is reported and changes nothing: unknown before the first good read');
  else fail('(11) failures: ' + JSON.stringify({ f1, f2, state: F.state('viper'), errs }));
  // The last good set survives a failed refresh.
  const G = createNameIndex({ load: pager(['viper']).fn });
  await G.refresh();
  const gGood = G.state('viper');
  const G2load = { n: 0 };
  const H = createNameIndex({ load: async (after) => { G2load.n++; if (G2load.n > 2) throw new Error('later'); return after === null ? ['viper'] : []; } });
  await H.refresh();
  const h1 = H.state('viper');
  const h2ok = await H.refresh();
  const h2 = H.state('viper');
  if (gGood === 'taken' && h1 === 'taken' && h2ok === false && h2 === 'taken' && H.ready)
    ok('(11) a refresh that fails keeps the last good set: still exact for every write this process made');
  else fail('(11) last good set: ' + JSON.stringify({ gGood, h1, h2ok, h2, ready: H.ready }));
  // A PAGE THAT DOES NOT ADVANCE is an error, never a loop; and the page cap.
  const why = [];
  let stuckCalls = 0;
  const stuck = createNameIndex({ load: async () => { stuckCalls++; return ['same']; }, onError: (e) => why.push(e.message) });
  const big = createNameIndex({ load: async (after) => [String((Number(after) || 0) + 1)], maxPages: 5, onError: (e) => why.push(e.message) });
  const stuckOk = await stuck.refresh(), bigOk = await big.refresh();
  if (stuckOk === false && !stuck.ready && stuckCalls === 2 && bigOk === false && !big.ready
      && /did not advance/.test(why[0] || '') && /MAX_PAGES/.test(why[1] || ''))
    ok('(11) a page that does not move past the last key fails on the second page, and a read longer than MAX_PAGES fails too: neither loops or grows');
  else fail('(11) bounds: ' + JSON.stringify({ stuckOk, stuckCalls, bigOk, why }));
  // A WRITE THAT LANDS WHILE A READ IS OUT is replayed onto the read: the read
  // saw 'alpha' and not 'xray', but alpha was given up and xray taken meanwhile.
  let release;
  const gate = new Promise((res) => { release = res; });
  const R = createNameIndex({ load: async (after) => { if (after === null) { await gate; return ['alpha', 'bravo']; } return []; } });
  const p1 = R.refresh(), p2 = R.refresh();
  R.add('xray'); R.remove('alpha');
  const mid = R.state('xray');
  release(); await p1;
  if (p1 === p2 && mid === 'unknown' && R.state('xray') === 'taken' && R.state('alpha') === 'free' && R.state('bravo') === 'taken')
    ok('(11) one read at a time, and a key taken or freed while it was out is replayed onto it: the read cannot undo a write');
  else fail('(11) replay: ' + JSON.stringify({ same: p1 === p2, mid, x: R.state('xray'), a: R.state('alpha'), b: R.state('bravo') }));
  // After the read, add and remove act at once.
  R.add('yankee'); R.remove('bravo');
  if (R.state('yankee') === 'taken' && R.state('bravo') === 'free') ok('(11) after a read, add and remove take effect at once');
  else fail('(11) add/remove: ' + JSON.stringify([R.state('yankee'), R.state('bravo')]));
  // start() reads at once; stop() leaves no timer behind (unref'd or not).
  let starts = 0;
  const S = createNameIndex({ load: async () => { starts++; return []; }, refreshMs: 60000, retryMs: 60000 });
  S.start(); S.start();
  await new Promise((res) => setTimeout(res, 20));
  S.stop();
  if (starts === 1 && S.ready) ok('(11) start() reads once at once (a second start is a no-op), and stop() ends it');
  else fail('(11) start: ' + JSON.stringify({ starts, ready: S.ready }));
}

// ---- 12. A STORED CHOSEN CALLSIGN MEETS THE ENGINE'S LISTS TOO (round 2 fix) -
// The build 6 and 7 Set stored a name after validateCallsign alone, so a name
// the shipped blocklist passes and the engine's isProfane refuses may sit in a
// profile row with its key. checkPlayerName refuses it now, and the lobby's
// sanitizeName hides it, so displayName must not show it in a friends list, a
// search result, a squad row or an invite card either. It falls back to null,
// exactly as any refused name does. The PROOF is untouched: provenName still
// proves it and seenName still records it, because a report about such a name
// is the case moderation exists for. No term is printed: the fixture is built
// from public/game-core.js's own list and named by its shape.
{
  const coreSrc = readFileSync(new URL('../public/game-core.js', import.meta.url), 'utf8');
  const sub = [...((coreSrc.match(/const BAD_SUB = \[([\s\S]*?)\];/) || [])[1] || '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const OLD = sub.map((t) => `${t[0].toUpperCase()}${t.slice(1)} Tank`)
    .find((n) => [...n].length <= 16 && validateCallsign(n, terms).ok && isProfane(n));
  if (!OLD) fail('(12) no BAD_SUB term passes the shipped blocklist as "<Term> Tank": the case below proves nothing');
  else {
    const row = { callsign: OLD, callsign_key: OLD.toLowerCase() };
    const shown = proofs.displayName(row), proved = proofs.provenName(row), seen = proofs.seenName(row);
    if (shown === null && proved === OLD && seen === OLD && proofs.checkPlayerName(OLD).ok === false)
      ok("(12) a chosen callsign stored before the Set ran isProfane is not shown (null, the fallback), though its key still proves it and a report still records it");
    else fail('(12) old profane name: ' + JSON.stringify({ shown: shown === null ? null : 'the name', proved: proved === OLD, seen: seen === OLD }));
  }
  const fine = proofs.displayName({ callsign: 'Wren Delacroix', callsign_key: 'wren delacroix' });
  if (fine === 'Wren Delacroix') ok('(12) a clean chosen callsign is still shown');
  else fail('(12) a clean chosen callsign was lost: ' + JSON.stringify(fine));
}

// ---- 13. NOBODY'S CALLSIGN TO THE EYE (round 2 fix, 2026-10-08) -------------
// The uniqueness check in (9) compares keys, which are exact, so one swapped
// letter used to make a different key with the same pixels. Two rules close
// it. A name that mixes writing systems is refused 'chars' (checkPlayerName,
// so the Set, the guest's check and the engine's door alike). And a typed
// name whose look-alike skeleton reads as a held key is refused 'taken', asked
// of the REAL index here, which keeps every key's readings. Code points are
// written as escapes, because written as glyphs these fixtures read as
// identical names on the page, which is the bug.
{
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cp = (...c) => String.fromCodePoint(...c);
  const VIRER = 'Vi' + cp(0x0440) + 'er';                        // Cyrillic er for p
  const VIPER_IE = 'Vip' + cp(0x0435) + 'r';                      // Cyrillic ie for e
  const FULL = cp(0xFF36, 0xFF49, 0xFF50, 0xFF45, 0xFF52);        // fullwidth V i p e r
  const SMALLCAPS = cp(0x1D20, 0x026A, 0x1D18, 0x1D07, 0x0280);   // small capitals v i p e r
  const DOTLESS = 'V' + cp(0x0131) + 'per';                       // Latin dotless i
  const COCO = cp(0x0421, 0x043E, 0x0441, 0x043E);                // Cyrillic Es o es o: reads Coco
  const TAXI = cp(0x03A4, 0x0391, 0x03A7, 0x0399);                // Greek capitals: reads TAXI
  const HIT_GREEK_KEY = cp(0x03B7, 0x03B9, 0x03C4);               // the key a Greek-capital 'HIT' is stored under
  const I = createNameIndex({ load: async (after) => (after === null ? ['coco', HIT_GREEK_KEY, 'viper'] : []) });
  await I.refresh();
  const P = createNameProofs({ terms, keyState: (k) => I.state(k) });
  // 1. MIXED SCRIPTS: refused 'chars' by the rules, with no index at all.
  const mixed = [VIRER, VIPER_IE, 'Ivan ' + cp(0x0418, 0x0432, 0x0430, 0x043D), 'Tank ' + cp(0x0391) + 'ce'];
  const F = createNameProofs({ terms, keyState: () => 'free' });
  const mixBad = mixed.filter((n) => !(same(F.checkPlayerName(n), { ok: false, error: 'chars' }) && same(F.typedName(n), { ok: false, error: 'chars' })
    && F.playerName(n) === null && F.guestName(n) === null));
  if (!mixBad.length) ok(`(13) ${mixed.length} mixed-script names ('Viper' with a Cyrillic er, with a Cyrillic ie, Latin beside Cyrillic, Latin with a Greek capital) are refused 'chars' by checkPlayerName, typedName, playerName and guestName`);
  else fail('(13) mixed scripts allowed: ' + JSON.stringify(mixBad.map((n) => [...n].map((c) => c.codePointAt(0).toString(16)))));
  // 2. LEGITIMATE NAMES IN ONE SCRIPT, and the mixtures real names use, still pass.
  const legit = [
    cp(0x0418, 0x0432, 0x0430, 0x043D) + ' ' + cp(0x041F, 0x0435, 0x0442, 0x0440, 0x043E, 0x0432),   // Cyrillic
    cp(0x0393, 0x03B9, 0x03CE, 0x03C1, 0x03B3, 0x03BF, 0x03C2),                                       // Greek
    cp(0x3055, 0x304F, 0x3089),                                                                       // Hiragana
    cp(0xAE40, 0xBBFC, 0xC900),                                                                       // Hangul
    cp(0x0645, 0x062D, 0x0645, 0x062F),                                                               // Arabic
    cp(0x092E, 0x0939, 0x0947, 0x0936),                                                               // Devanagari, with a vowel sign
    cp(0x0E2A, 0x0E38, 0x0E14, 0x0E32),                                                               // Thai, with a vowel mark
    cp(0x5C71, 0x7530) + ' ' + cp(0x30B1, 0x30F3),                                                    // Han with Katakana
    'Ken' + cp(0x3058),                                                                               // Latin with Hiragana
    'Li ' + cp(0x674E),                                                                               // Latin with Han
    'Zo' + cp(0x00E9) + ' Kite', 'Tank Ace', 'V1per', TAXI,
  ];
  const lost = legit.filter((n) => P.playerName(n) !== normaliseCallsign(n));
  if (!lost.length) ok(`(13) ${legit.length} legitimate names still pass the door: single-script Cyrillic, Greek, Hiragana, Hangul, Arabic, Devanagari and Thai; Han with Katakana, Latin with Hiragana or Han; an accented Latin name; a digit swap; and a Greek name no account looks like`);
  else fail('(13) legitimate names refused: ' + JSON.stringify(lost.map((n) => [n, P.typedName(n)])));
  // 3. LOOK-ALIKES OF A HELD KEY in one script are refused 'taken'.
  const alike = [['fullwidth', FULL], ['small capitals', SMALLCAPS], ['dotless i', DOTLESS], ['exact', '  VIPER '],
    ['whole-Cyrillic Coco', COCO], ['Latin Hit against a Greek-capital key', 'Hit']];
  const through = alike.filter(([, n]) => !(same(P.typedName(n), { ok: false, error: 'taken' }) && P.playerName(n) === null && P.guestName(n) === null));
  if (!through.length) ok(`(13) ${alike.map(([w]) => w).join(', ')}: each reads as a held key and is refused 'taken' at the check, the door and a guest's seat`);
  else fail('(13) look-alikes allowed: ' + JSON.stringify(through.map(([w, n]) => [w, P.typedName(n)])));
  // 4. FAILS CLOSED: a skeleton the index cannot answer refuses, and a plain
  // name still asks once.
  const asked = [];
  const Q = createNameProofs({ terms, keyState: (k) => { asked.push(k); return k === 'tank ace' || k === FULL.toLowerCase() ? 'free' : 'unknown'; } });
  const q1 = Q.typedName(FULL);
  const once = asked.length;
  asked.length = 0;
  Q.typedName('Tank Ace');
  if (same(q1, { ok: false, error: 'unavailable' }) && once === 2 && same(asked, ['tank ace']))
    ok("(13) a skeleton the index cannot answer refuses 'unavailable'; a name whose skeleton is its key asks the index once");
  else fail('(13) skeleton fail closed: ' + JSON.stringify({ q1, once, asked }));
  // 5. THE INDEX KEEPS THE READINGS IN STEP: lookalikes names the keys behind
  // a reading, add and remove move them, and it is null before the first load.
  const J = createNameIndex({ load: async (after) => (after === null ? ['viper'] : []) });
  const pre = J.lookalikes('viper');
  await J.refresh();
  const a1 = J.lookalikes('viper');
  J.add(DOTLESS.toLowerCase());
  const a2 = J.lookalikes('viper').sort();
  J.remove('viper');
  const a3 = [J.lookalikes('viper'), J.state('viper')];
  J.remove(DOTLESS.toLowerCase());
  const a4 = [J.lookalikes('viper'), J.state('viper')];
  if (pre === null && same(a1, ['viper']) && same(a2, ['viper', DOTLESS.toLowerCase()].sort()) && same(a3, [[DOTLESS.toLowerCase()], 'taken']) && same(a4, [[], 'free']))
    ok('(13) the index answers lookalikes for a reading (null before it loads), and add and remove keep the readings exact');
  else fail('(13) index readings: ' + JSON.stringify({ pre, a1, a2, a3, a4 }));
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall display-name checks passed');
process.exit(out.errors.length ? 1 : 0);
