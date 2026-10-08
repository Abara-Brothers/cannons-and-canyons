// server/display-name.js — ONE proof of a name, for every screen that shows one.
//
// WHAT THIS MODULE IS: the rule that decides whether the server can vouch for a
// name before another player is shown it. It was written once, inside
// server/social.js, while the friends panels were the only screens that painted
// somebody else's callsign. They are not any more.
//
// IT HAS TWO CALLERS, AND IT IS STILL ITS OWN MODULE:
//   server/social.js — the friends panel, add-by-code, search results, the
//   blocked list, the squad roster and its invites, the name a report
//   records, and the check that tells a player whether a name they typed may
//   be kept (checkPlayerName, below).
//   server.js — the room engine's name check (playerName, below), so the name
//   a client presents in a lobby meets the same rule as the one the check
//   op passed.
//
// It had a second. The Bay's recent-match panel and the route that fed it were
// removed on 2026-09-30, when the Squad box took that slot, and with them went
// the last name path in this codebase older than chosen names (BINDING.md
// resolution 27). THE FILE DOES NOT GO BACK INTO social.js. It is a security
// rule — the thing that decides whether the server can vouch for a name before
// another player is shown it — and it has its own suite, test/display_name.mjs,
// driven against the SHIPPED server/blocklist.txt. Folding it back would bury
// the rule and its proof inside a socket layer and lose the one property that
// makes it checkable on its own. It is also where the NEXT caller goes: any new
// screen that paints somebody else's name imports this and never copies it,
// because a rule kept in two files drifts and drift here fails OPEN — the stale
// copy goes on painting a name the other would have refused, on a screen whose
// entire claim is that the server vouched for it.
//
// Pure and synchronous, all of it: the blocklist terms are injected (server.js
// reads them from disk once, at boot), and so is `keyState`, the in-memory
// answer to "does an account hold this callsign key?" (server/name-index.js).
// Nothing here touches the database, a socket or the clock. test/display_name.mjs
// drives it in process against the REAL server/blocklist.txt — a suite with its
// own term list would not notice the shipped list and the rule drifting apart.
import { validateCallsign, normaliseCallsign, foldForBlocklist, mixedScript, lookalikeSkeleton, shownSpelling } from './callsign.js';
// THE TWO PURE CALLSIGN TESTS, from the module that owns the curated lists.
// Imported, never copied: isGeneratedCallsign is the standard the engine already
// applies to every name any client presents (room-engine.js's sanitizeName), and
// a second copy of it — or of the profanity lists beside it — would drift, which
// here fails OPEN on a name another player has to look at. game-core.js is pure
// logic with no Node builtins and no DOM; the offline page already loads it
// through room-engine.js, so nothing about this import reaches the browser. It
// is NOT the room engine: server/ still pulls in no rooms, no sockets, no
// simulation, and test/social.mjs still never loads room-engine.js.
import { isGeneratedCallsign, isProfane } from '../public/game-core.js';

// ---- the game's own names (round 2, 2026-10-08) ----------------------------
// A NAME A PLAYER CHOOSES MAY NOT PASS FOR ONE THE GAME SHOWS. The room engine
// names its computer seats 'CPU 1' to 'CPU 3' in a free-for-all and 'CPU · Easy'
// (Medium, Hard) in a duel (room-engine.js cpuSeat), the boss 'WARLORD-7' and the
// alien seats 'XENO-SCOUT', 'XENO-REAVER' and 'XENO-HARROW' (HORDE). Where a seat
// has no name, the client writes 'Opponent', 'A player', 'Player 2', 'You',
// 'Host', 'Guest' or 'No callsign' (app.js and bay.js), and Match setup calls
// the computer opponent 'Computer' (bay.js). A player named 'CPU 2' or
// 'Warlord 7' could pass for a computer seat in a lobby and on a result card,
// which impersonates the game rather than another player. The callsign shape
// refuses the hyphen and the middle dot, so 'WARLORD-7' and 'CPU · Hard' cannot
// be typed as spelled. 'WARLORD 7' and 'CPU Hard' can, and this rule catches them.
//
// TWO READINGS OF THE NAME, AND EITHER ONE REFUSES IT. The plain reading keeps
// letters and digits and drops the spaces, so 'C P U 2' reads 'cpu2' and
// 'Player 3' reads 'player3'. The blocklist's own fold (foldForBlocklist) reads
// look-alikes as the letters they imitate, so 'W4RL0RD', 'Xen0 Scout' and
// 'C0MPUTER' are caught as well. A computer seat's name is caught by its START
// ('cpu', 'xeno') or, for the boss, ANYWHERE in the name, because 'Iron
// Warlord' imitates it as much as 'Warlord' does. A word the game writes in
// place of a name must be the WHOLE name: 'Host' is the game's word, and
// 'Hostile Mesa' is not. None of the 1,454 rolled pairs is caught
// (test/display_name.mjs sweeps them all).
//
// It applies to every name a player CHOOSES, through checkPlayerName below: the
// signed-in Set, the guest's check, and the room engine's door. It does not
// apply to a name chosen before this rule existed, which still proves itself by
// its key (provenName). Renaming a player who did nothing wrong is not this
// rule's job.
const SYSTEM_WORD = /^(?:you|opponent|aplayer|player\d*|host|guest|nocallsign|noname|computer)$/;
const BOT_NAME = (s) => s.startsWith('cpu') || s.startsWith('xeno') || s.includes('warlord');
const GAME_NAME = (s) => SYSTEM_WORD.test(s) || BOT_NAME(s);
export function systemName(raw) {
  const name = normaliseCallsign(raw);
  const plain = name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return GAME_NAME(plain) || GAME_NAME(foldForBlocklist(name));
}

// `terms` is the shipped blocklist, injected rather than read here: presentable()
// below is the only part of this module that needs it, and injecting it keeps
// every function in the file pure. Its one caller, server/social.js, passes the
// list server.js loads once, at boot — one file, one rule, one term list.
//
// `keyState(key)` answers 'free', 'taken' or 'unknown' for a callsign key: is
// it some account's CHOSEN callsign? server.js and server/social.js pass the
// in-memory index (server/name-index.js), and nothing else may answer it,
// because a store read per name would put an await inside the room engine's
// synchronous join. THE DEFAULT IS 'unknown', and 'unknown' refuses: a caller
// that forgets to pass it shows no typed name at all. It never shows one that
// might be another player's.
export function createNameProofs({ terms, keyState = () => 'unknown' }) {
  // ---- names that came out of the database -----------------------------------
  // WHO CAN WRITE THIS COLUMN? profiles.callsign is PATCHed by the account
  // itself on every cloud save (profiles_update_own; public/cloud.js save()).
  // profiles.callsign_key beside it is NOT — the phase 6 migration revokes
  // update on it from the authenticated role, so the key is the only part of
  // that row the server is entitled to believe. Task 4 closed this exact hole in
  // the auth sink; the friends frame and the search reply are two more doors to
  // it, and they are shut the same way.
  // NOT WIDENED TO ADMIT A ROLLED PAIR, deliberately, and this is the one place
  // the distinction still matters: friendsSnapshot uses this function for the
  // account's OWN `callsign` field, which BINDING resolution 13 fixes as the
  // account's CHOSEN name and null when it holds only a rolled one — that null
  // is what tells the client to offer "Set callsign" and stops a player being
  // asked to choose a name they already hold. Widening it here would answer a
  // rolled pair there and break both. The second proof lives in rolledName
  // below, and displayName — what ANOTHER player is shown — takes either.
  //
  // AND THE CAPITALS MUST READ AS THE KEY (round 2 fix, 2026-10-08). Lower-
  // casing onto the key admits every mixture of capitals, and a Greek key in
  // capitals can read as another account's Latin name. shownSpelling
  // (server/callsign.js) believes the column only when it reads as one of
  // the key's own readings, which the Set checked against every other
  // account; any other casing of the key is shown as the key itself.
  const provenName = (row) => {
    const key = row && typeof row.callsign_key === 'string' ? row.callsign_key : '';
    if (!key) return null;
    // validateCallsign stored key = normaliseCallsign(name).toLowerCase(), so
    // the SHARED normaliser is by construction the one that wrote it, and
    // shownSpelling uses it. A second copy could only drift open.
    return shownSpelling(row.callsign, key);
  };

  // A second pass over a name one of the two proofs has already passed. The
  // blocklist is read at START-UP and a term can be added to it after a name was
  // set, so a name that was clean when it was stored is checked again at the
  // moment it is shown. Measured against the shipping list: none of the 1,454
  // rollable pairs is refused by it, so this costs no rolled player their name.
  // This is belt and braces on top of the proofs, NOT a substitute for one: the
  // character class here is letters, digits and spaces, so plenty of unwanted
  // text passes it, and a name it passes is still only a string the account
  // itself wrote unless a key stands behind it.
  //
  // AND THE ENGINE'S OWN LISTS, isProfane (round 2 fix, 2026-10-08). The Set
  // in builds 6 and 7 stored a chosen callsign after validateCallsign alone,
  // so a name the shipped blocklist passes and isProfane refuses can sit in a
  // profile row with its key. The Set refuses such a name now
  // (checkPlayerName), and the lobby's sanitizeName already hides it, so a
  // friends list, a search result, a squad row and an invite card must not
  // show it either: one standard for every screen that names another player.
  // It falls back to null, exactly as any other refused name does. The game's
  // own names (systemName) are deliberately NOT applied here, for the reason
  // given at the top of this file: an old 'CPU Hard' did nothing wrong, while
  // an old name isProfane refuses is the kind of name moderation exists for.
  const presentable = (raw) => { const v = validateCallsign(raw, terms); return v.ok && !isProfane(v.name) ? v.name : null; };

  // THE SECOND PROOF: A ROLLED PAIR IS SERVER-VERIFIABLE TOO. A player does not
  // type a name, they roll one from two curated lists (ISSUE-015), so
  // isGeneratedCallsign proves a string is "<Adj> <Noun>" out of those lists —
  // a SELECTION FROM A FIXED VOCABULARY, not attacker-chosen text. It is exactly
  // the standard room-engine.js's sanitizeName already applies to every name any
  // client presents in a lobby, and the profanity filter that guards it there
  // guards it here, from the same module.
  //
  // NORMALISED FIRST, then tested, and what is returned is the normalised pair.
  // isGeneratedCallsign is deliberately strict — no trim, no case fold — and a
  // decomposed or double-spaced copy of a legitimate rolled name must not cost
  // that player their name in the panel. Nothing free rides in: whatever the
  // column held, what leaves here is one of 1,454 pairs spelled the one way.
  const rolledName = (raw) => {
    const name = normaliseCallsign(raw);
    return isGeneratedCallsign(name) && !isProfane(name) ? name : null;
  };

  // WHAT ANOTHER PLAYER IS SHOWN FOR A ROW: a name the server can vouch for, by
  // ONE OF TWO PROOFS, and nothing else.
  //
  //   1. it matches callsign_key      -> a CHOSEN name: unique, filtered and
  //                                      stored by the server, key not writable
  //                                      by any client;
  //   2. it is a rolled pair          -> one of the curated pairs above, which
  //      (and not profane)               no client authored.
  //
  // Anything else is null: a display column holding free text, or holding a
  // CHOSEN name this account does not hold the key for. That second case is the
  // one that must stay impossible — uniqueness lives on the key, and without it
  // an account could wear another player's chosen callsign in every panel while
  // a name report pointed at the wrong account.
  //
  // IMPERSONATION, THE HONEST ANSWER (checked, not assumed): proof 2 does let an
  // account write a rolled pair somebody else also rolled. That is not a new
  // weakness — rolled names were never unique, two players have always been able
  // to hold the same one, and sanitizeName shows exactly that collision in every
  // lobby. It extends to a CHOSEN name only when that chosen name is itself a
  // curated pair, which is a name anybody can hold by rolling and which the
  // lobby already renders for anybody who does. A chosen name that is NOT a
  // rollable pair — every name outside those 1,454 — cannot be worn without the
  // key, and (a4) is the test that says so.
  //
  // null keeps the ROW — and Task 8's Report and Block buttons on it — in place,
  // which dropping the entry would not. Task 8 renders the fallback copy, which
  // is now a genuine edge case again rather than most of the panel.
  const displayName = (row) => {
    const shown = provenName(row) ?? rolledName(row && row.callsign);
    return shown === null ? null : presentable(shown);
  };

  // WHAT A REPORT RECORDS — the same two proofs, and NOT the blocklist pass on
  // the end of them. displayName is what another player is SHOWN, and its last
  // step re-tests the name against a blocklist that can move after the name was
  // stored. For a panel that is right: a term added today must take the name off
  // every screen today. For a REPORT it inverts the feature. The single case
  // moderation exists for is a name that got through and was blocklisted
  // afterwards, and running the moved list again over it made the row and the log
  // line say "(no name)" about a player whose name was still on screen — the
  // evidence destroyed at exactly the moment it was needed, while the lobby went
  // on rendering the name, because a lobby name is PROVED, not re-filtered.
  //
  // So the row records what the PROOF vouches for and nothing else: the name that
  // matches callsign_key (a column no client may write), or a curated rolled
  // pair. That is the same standard the lobby applies, so a name on screen is the
  // name in the row. null — a player who genuinely has no name, or a display
  // column with no proof behind it — still becomes the store's sentinel, so the
  // row lands and the reported uuid still identifies the account.
  //
  // THE LOG LINE IS STILL SAFE BY CONSTRUCTION, and it is the proof rather than
  // the blocklist that makes it so. provenName returns normaliseCallsign(...) —
  // NFC, trimmed, runs of whitespace collapsed to one space — and only when it
  // case-folds onto a key the server itself derived from a validateCallsign SHAPE
  // match, whose class is letters, digits, marks and single spaces. rolledName is
  // one of 1,454 curated pairs. Neither can carry a newline or a quote, so
  // nothing here can forge a line of its own.
  const seenName = (row) => provenName(row) ?? rolledName(row && row.callsign);

  // ---- names a player TYPED, at the moment they are presented ----------------
  // THE GUIDELINES, NOT A PROOF (owner, 2026-10-07: "the player is given a
  // default name and then they can change it to whatever they like, as long as
  // it stays within the guidelines"). Every player may now present a name they
  // chose, a guest included, and a guest's is kept on their own device and
  // nowhere else: there is no key to prove it by and no row to read. What the
  // server CAN do is hold the string itself to the rules, every time it is
  // presented — the callsign rules and the shipped blocklist (validateCallsign),
  // and then the engine's own profanity lists (isProfane), because the lobby
  // applies isProfane to every name it shows, and a name this check passed must
  // not then be quietly renamed at the door.
  //
  // It answers WHY as well as whether, so the one function serves every caller:
  // social.js's check op and its Set hand the code to the player ('length',
  // 'chars', 'not_allowed'), and playerName below is the yes-or-no the room
  // engine needs. `key` rides on a pass, the one callsign_key spelling
  // validateCallsign derives, so a caller never derives a second one.
  //
  // THE SIGNED-IN SET IS HELD TO IT TOO (round 2, 2026-10-08). The Set used
  // to run validateCallsign alone, so a name the engine's isProfane refuses
  // ('Pedo Tank' passes the shipped list) was stored for a signed-in account
  // and shown in friends lists, squad seats and invites, while a guest typing
  // the same name was refused. One function now serves both, so the two
  // paths cannot drift apart again. The game's own names (systemName, above)
  // are refused by it as well, with the same 'not_allowed'.
  //
  // It stands BESIDE the two proofs, never among them. A name it passes is a
  // string the server finds acceptable, not one tied to an account. displayName
  // and seenName above are untouched: a panel still names a row only by its key
  // or by a curated pair, so a typed name can never be worn in a friends list,
  // and a chosen callsign stays the only name a search can find.
  //
  // ONE WRITING SYSTEM PER NAME (round 2 fix, 2026-10-08): a name that mixes
  // scripts the way no real name does (server/callsign.js mixedScript) is
  // refused 'chars', the character rule's own word, because that mixture is
  // how one swapped letter makes a different key look like somebody else's
  // name. It applies to every name chosen from now on, typed or set; a name
  // stored before it keeps proving itself by its key, as the system names do.
  const checkPlayerName = (raw) => {
    const v = validateCallsign(raw, terms);
    if (!v.ok) return { ok: false, error: v.error };
    if (mixedScript(v.name)) return { ok: false, error: 'chars' };
    if (isProfane(v.name) || systemName(v.name)) return { ok: false, error: 'not_allowed' };
    return { ok: true, name: v.name, key: v.key };
  };

  // A NAME SHOWN WITH NO KEY BEHIND IT MAY NOT BE SOMEBODY'S CHOSEN CALLSIGN
  // (round 2, 2026-10-08). A typed name is not unique, and two guests may type
  // the same one. But a chosen callsign IS unique (callsign_key), and a guest who
  // types 'Viper' when an account holds 'Viper' would wear that player's name in
  // every lobby they joined, with a report against them pointing at the wrong
  // person. So a typed name that normalises onto an account's key is refused
  // 'taken', the word the Set already uses for the same collision.
  //
  // keyState is the in-memory index, asked with the key checkPlayerName derived
  // (the callsign_key normalisation, exactly). 'unknown' means the index has not
  // loaded or has no store behind it, and it REFUSES with 'unavailable': a store
  // fault shows the player's default name, never one that might be another
  // player's. A keyState that throws counts as 'unknown'.
  //
  // THE SET DOES NOT ASK THIS. Its uniqueness is the unique index's, at the write
  // (social.js callsign), and a read before that write would only race it. Its
  // look-alike check is its own (social.js), because it must tell another
  // account's key from the account's own.
  //
  // NOR A LOOK-ALIKE OF ONE (round 2 fix, 2026-10-08). The key is exact, so
  // a whole-script name that reads as an account's callsign ('Coco' spelt
  // in Cyrillic letters) or a fullwidth copy is a different key and the same pixels. So
  // the index is asked a second time with the name's look-alike skeleton
  // (server/callsign.js lookalikeSkeleton), and the in-memory index answers
  // 'taken' for a string that is a key or that a key reads as
  // (server/name-index.js). Asked only when the skeleton differs from the key,
  // so a plain name costs one question, as before. Mixed scripts never get
  // this far: checkPlayerName refuses them. Either answer that is not 'free'
  // refuses, 'unknown' as 'unavailable', so the rule still fails closed.
  const typedName = (raw) => {
    const v = checkPlayerName(raw);
    if (!v.ok) return v;
    const ask = (k) => { try { return keyState(k); } catch { return 'unknown'; } };
    let s = ask(v.key);
    const look = lookalikeSkeleton(v.name);
    if (s === 'free' && look !== v.key) s = ask(look);
    if (s === 'free') return v;
    return { ok: false, error: s === 'taken' ? 'taken' : 'unavailable' };
  };
  // What the room engine is given (server.js, setNameCheck): the normalised
  // name when the guidelines pass it and no account holds it, null otherwise.
  // The engine shows THIS string, never the client's copy, so a near-miss that
  // normalises equal cannot carry a different sequence of characters to
  // another player.
  const playerName = (raw) => {
    const v = typedName(raw);
    return v.ok ? v.name : null;
  };

  // WHAT A SQUAD SEAT SHOWS FOR A GUEST (round 2, 2026-10-08). A guest has no
  // account a name could be proved by, so their seat read 'No callsign',
  // although the same guest's name appears in every lobby. The seat now shows
  // what the lobby door would show for the name the guest's frame carried: a
  // rolled pair (the engine's second door), or a typed name that passes
  // playerName (its third). Anything else is null, the client's 'No callsign'.
  // A rolled pair takes presentable's pass, as displayName gives it.
  const guestName = (raw) => {
    const r = rolledName(raw);
    return r !== null ? presentable(r) : playerName(raw);
  };

  // THE NAME A LOBBY SEAT SHOWED, FOR A REPORT AGAINST THAT SEAT (round 2,
  // 2026-10-08). seenName proves only a chosen key or a rolled pair, so a report
  // against a guest's typed name recorded the '(no name)' sentinel, although
  // privacy.html promises "the callsign exactly as you saw it". The proof for a
  // typed name is the room engine itself: every seat name passed sanitizeName
  // at the moment it was presented, and the seat still holds it. social.js reads
  // it through the seat handle, in the reporter's own room.
  //
  // So this is a SHAPE test and nothing more: the callsign rules with an empty
  // term list (validateCallsign(raw, [])), which keeps the log line safe by
  // construction (letters, digits, marks and single spaces; no newline and no
  // quote). It does not run the blocklist, for seenName's reason: a name
  // blocklisted after it was shown is the case a report exists for.
  const seatName = (raw) => {
    if (typeof raw !== 'string') return null;
    const v = validateCallsign(raw, []);
    return v.ok ? v.name : null;
  };

  // presentable is NOT returned. It is the blocklist pass INSIDE displayName,
  // and a caller able to reach it on its own could show a name with no proof
  // behind it at all — which is the bug this module exists to remove.
  // checkPlayerName, typedName, playerName and guestName are not that: they
  // return a name only when the rules pass the string itself, and none of them
  // names a profile row.
  return { provenName, rolledName, displayName, seenName, checkPlayerName, typedName, playerName, guestName, seatName };
}
