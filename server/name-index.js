// server/name-index.js — which callsign keys belong to an account, in memory.
//
// WHY THIS EXISTS (round 2, 2026-10-08). Every player may show a name they
// typed, a guest included, and a typed name is not unique. A CHOSEN callsign
// is unique (profiles.callsign_key), so a typed name must never equal one: a
// guest who types 'Viper' while an account holds 'Viper' would wear that
// player's name in every lobby, and a report would point at the wrong person.
// The check has to be answered in three places: the room engine's door
// (sanitizeName, through server.js's setNameCheck), the guest's check op and
// the squad seat a guest's name is shown on.
//
// WHY AN INDEX AND NOT A LOOKUP PER NAME. The engine's door is synchronous
// (createRoom, join and quick call sanitizeName inline), and the engine is
// the same file the offline page runs, so it can gain no await and no store.
// A store read per typed name would have to hold a socket's game frames behind
// it in server.js, reordering them, and the squad seating path would bypass
// that wait altogether. So the keys are read once, kept here, and asked
// synchronously.
//
// WHAT IT COSTS. A load reads every non-null callsign_key, a page at a time,
// in key order (store.chosenCallsignKeys), and stops at the first EMPTY page:
// stopping at a short page would trust that PostgREST's row cap is the page
// size asked for, and a lower cap would quietly truncate the index, which
// fails OPEN on every key it dropped. One key is a short string, so 10,000
// chosen callsigns are well under a megabyte, and a load is one request per
// thousand of them plus one. It runs at boot and every REFRESH_MS after that,
// and the cap below bounds both.
//
// HOW IT STAYS CURRENT. This process is the only writer of callsign_key: the
// Set and the old builds' roll (server/social.js) call add and remove when
// their write lands, so between loads the index is exact for every change made
// here. The refresh picks up what no hook sees: an account deleted (its key
// freed) and a key written by another instance during a deploy's overlap. A
// write that lands while a load is reading is replayed onto the loaded set, so
// a load can never undo it.
//
// FAIL CLOSED. Until the first load succeeds every key is 'unknown', and
// display-name.js refuses a typed name on 'unknown': the player's default name
// is shown, never a name that might be someone else's. A failed refresh keeps
// the last good set, which is still exact for every write this process made.
// While the store is down the set cannot fall behind, because a callsign is
// only ever taken by a write to that same store, and that write fails too.
// Going 'unknown' on a failed refresh would take every guest's typed name away
// for a blip and close nothing.
// A failed FIRST load retries after RETRY_MS rather than waiting a full
// refresh, so a store that blinked at boot costs guests their typed names for
// seconds, not minutes.
//
// Every timer is unref'd: the index never holds the process open, and
// test/shutdown.mjs still exits on SIGTERM. Nothing here reads a socket, the
// engine or the clock directly; `load` is the one dependency, injected.
export const REFRESH_MS = 10 * 60 * 1000;
export const RETRY_MS = 30 * 1000;
export const PAGE = 1000;
// 2,000 pages of 1,000 keys. A store that keeps answering full pages past this
// (a paging fault, or a table far larger than this game will see) fails the
// load, and the index stays as it was rather than growing without bound.
export const MAX_PAGES = 2000;

export function createNameIndex({ load, refreshMs = REFRESH_MS, retryMs = RETRY_MS, page = PAGE, maxPages = MAX_PAGES, onError = () => {} } = {}) {
  let keys = null;          // the loaded set; null until the first load lands
  let loading = null;       // the load in flight, shared by every caller
  let touched = null;       // key -> 'add' | 'remove', written while a load reads
  let timer = null;
  let stopped = true;

  async function readAll() {
    if (typeof load !== 'function') throw new Error('name index: no loader');
    const out = new Set();
    let after = null;
    for (let n = 0; n < maxPages; n++) {
      const rows = await load(after, page);
      if (!Array.isArray(rows)) throw new Error('name index: a page that is not a list');
      if (!rows.length) return out;
      let last = null;
      for (const k of rows) if (typeof k === 'string' && k) { out.add(k); last = k; }
      // A page that does not move past where it started would be read for ever.
      if (last === null || last === after) throw new Error('name index: a page that did not advance');
      after = last;
    }
    throw new Error('name index: more pages than MAX_PAGES');
  }

  // ONE LOAD AT A TIME. A second caller gets the load already in flight.
  function refresh() {
    if (loading) return loading;
    touched = new Map();
    loading = readAll().then((set) => {
      for (const [k, op] of touched) { if (op === 'add') set.add(k); else set.delete(k); }
      keys = set;
      return true;
    }, (e) => { try { onError(e); } catch {} return false; }).finally(() => { loading = null; touched = null; });
    return loading;
  }

  function arm() {
    if (stopped) return;
    timer = setTimeout(() => { timer = null; refresh().finally(arm); }, keys === null ? retryMs : refreshMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    // 'free', 'taken', or 'unknown' before the first load has landed.
    state: (key) => (keys === null ? 'unknown' : keys.has(String(key)) ? 'taken' : 'free'),
    add(key) { const k = String(key); if (keys) keys.add(k); if (touched) touched.set(k, 'add'); },
    remove(key) { const k = String(key); if (keys) keys.delete(k); if (touched) touched.set(k, 'remove'); },
    refresh,
    start() { if (!stopped) return; stopped = false; refresh().finally(arm); },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
    get ready() { return keys !== null; },
    get size() { return keys ? keys.size : 0; },
  };
}
