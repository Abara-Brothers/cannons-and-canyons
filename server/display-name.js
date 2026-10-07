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
// reads them from disk once, at boot), and nothing here touches the database, a
// socket or the clock. test/display_name.mjs drives it in process against the
// REAL server/blocklist.txt — a suite with its own term list would not notice
// the shipped list and the rule drifting apart.
import { validateCallsign, normaliseCallsign } from './callsign.js';
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

// `terms` is the shipped blocklist, injected rather than read here: presentable()
// below is the only part of this module that needs it, and injecting it keeps
// every function in the file pure. Its one caller, server/social.js, passes the
// list server.js loads once, at boot — one file, one rule, one term list.
export function createNameProofs({ terms }) {
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
  const provenName = (row) => {
    const key = row && typeof row.callsign_key === 'string' ? row.callsign_key : '';
    if (!key) return null;
    // validateCallsign stored key = normaliseCallsign(name).toLowerCase(), so
    // the SHARED normaliser is by construction the one that wrote it. A second
    // copy could only drift open.
    const shown = normaliseCallsign(row.callsign);
    return shown.toLowerCase() === key ? shown : null;
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
  const presentable = (raw) => { const v = validateCallsign(raw, terms); return v.ok ? v.name : null; };

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
  // It answers WHY as well as whether, so the one function serves both callers:
  // social.js's check op hands the code to the player ('length', 'chars',
  // 'not_allowed'), and playerName below is the yes-or-no the room engine needs.
  //
  // It stands BESIDE the two proofs, never among them. A name it passes is a
  // string the server finds acceptable, not one tied to an account — it is not
  // unique, and two players may type the same one. displayName and seenName
  // above are untouched: a panel still names a row only by its key or by a
  // curated pair, so a typed name can never be worn in a friends list, and a
  // chosen callsign stays the only name a search can find.
  const checkPlayerName = (raw) => {
    const v = validateCallsign(raw, terms);
    if (!v.ok) return { ok: false, error: v.error };
    if (isProfane(v.name)) return { ok: false, error: 'not_allowed' };
    return { ok: true, name: v.name };
  };
  // What the room engine is given (server.js, setNameCheck): the normalised
  // name when the guidelines pass it, null when they do not. The engine shows
  // THIS string, never the client's copy, so a near-miss that normalises equal
  // cannot carry a different sequence of characters to another player.
  const playerName = (raw) => {
    const v = checkPlayerName(raw);
    return v.ok ? v.name : null;
  };

  // presentable is NOT returned. It is the blocklist pass INSIDE displayName,
  // and a caller able to reach it on its own could show a name with no proof
  // behind it at all — which is the bug this module exists to remove.
  // checkPlayerName and playerName are not that: they return a name only when
  // the rules pass the string itself, and no caller uses them to name a row.
  return { provenName, rolledName, displayName, seenName, checkPlayerName, playerName };
}
