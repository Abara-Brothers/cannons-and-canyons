// The exact offline entry points (items 2 + B), against the engine in-process.
//
// Play solo hands the in-page engine the very frames the online path sends:
// for Boss, Aliens and Golf the queued 'create' followed by 'startMatch' (the
// engine accepts one commander and seats its own NPCs); for a free-for-all
// the 'ai' frame, because a one-seat ffa create is refused at startMatch —
// that refusal is pinned here on purpose, as the guard that keeps the ffa
// solo start on the 'ai' path. Headless: no server, no Chrome, runs in CI.
process.env.PICK_MS = '200';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };

const { rooms, handleClientMessage } = await import('../public/room-engine.js');
const mkws = () => ({ readyState: 1, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
const frames = (ws, t) => ws._rx.filter((m) => m.type === t);
const FIVE = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
const SEVEN = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley', 'cannon', 'gas'];

// ---- Boss: create + startMatch -> a 2-seat match against WARLORD-7 ----------
{
  const ws = mkws();
  handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'boss', max: 2, loadout: SEVEN });
  const cr = frames(ws, 'created')[0], lb = frames(ws, 'lobby')[0];
  if (cr && cr.mode === 'boss' && lb && lb.players.filter(Boolean).length === 1) ok('boss: a one-seat lobby');
  else fail('boss: create did not answer with a one-seat lobby');
  handleClientMessage(ws, { type: 'startMatch' });
  const st = frames(ws, 'start')[0];
  if (st && st.n === 2 && st.names[st.boss] === 'WARLORD-7' && st.you === 0) ok('boss: startMatch with one commander starts, WARLORD-7 seated');
  else fail('boss: start was ' + JSON.stringify(st && { n: st.n, boss: st.boss, names: st.names }));
  if (frames(ws, 'joinError').length === 0) ok('boss: no refusal'); else fail('boss: refused: ' + JSON.stringify(frames(ws, 'joinError')));
  handleClientMessage(ws, { type: 'leave' });
}

// ---- Aliens: the three saucers join a lone defender ------------------------
{
  const ws = mkws();
  handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'aliens', max: 2, loadout: SEVEN });
  handleClientMessage(ws, { type: 'startMatch' });
  const st = frames(ws, 'start')[0];
  if (st && st.n === 4 && st.kinds.some((k) => k !== 'tank') && st.names.filter((n) => /^XENO-/.test(n)).length === 3) ok('aliens: one defender plus three saucers');
  else fail('aliens: start was ' + JSON.stringify(st && { n: st.n, kinds: st.kinds, names: st.names }));
  handleClientMessage(ws, { type: 'leave' });
}

// ---- Golf: a solo round --------------------------------------------------
{
  const ws = mkws();
  handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'golf', max: 2, tees: 'mens', loadout: FIVE });
  handleClientMessage(ws, { type: 'startMatch' });
  const st = frames(ws, 'start')[0];
  if (st && st.mode === 'golf' && st.golf && st.golf.hole === 1 && st.n === 1) ok('golf: a one-player round starts on hole 1');
  else fail('golf: start was ' + JSON.stringify(st && { n: st.n, mode: st.mode, golf: !!st.golf }));
  handleClientMessage(ws, { type: 'leave' });
}

// ---- FFA: a one-seat create is REFUSED at startMatch (the guard) ------------
{
  const ws = mkws();
  handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'ffa', max: 4, loadout: FIVE });
  handleClientMessage(ws, { type: 'startMatch' });
  const je = frames(ws, 'joinError')[0];
  if (je && /at least 2/i.test(je.reason) && frames(ws, 'start').length === 0) ok('ffa: a one-seat create cannot start — Play solo must not send it');
  else fail('ffa: a one-seat create ' + (frames(ws, 'start').length ? 'STARTED' : 'answered ' + JSON.stringify(je)));
  handleClientMessage(ws, { type: 'leave' });
}

// ---- FFA: the frame soloFrameFor builds starts at once, CPUs seated --------
{
  const ws = mkws();
  handleClientMessage(ws, { type: 'ai', mode: 'ffa', max: 3, difficulty: 'medium', name: 'T', skin: 'olive' });
  const st = frames(ws, 'start')[0];
  if (st && st.mode === 'ffa' && st.n === 3 && st.you === 0 && st.names.slice(1).every((n) => /^CPU \d$/.test(n))) ok('ffa: the vs-Computer frame with max 3 starts a 3-seat match, two CPUs');
  else fail('ffa: ai start was ' + JSON.stringify(st && { n: st.n, mode: st.mode, names: st.names }));
  if (frames(ws, 'created').length === 0 && frames(ws, 'lobby').length === 0) ok('ffa: no lobby precedes a vs-Computer start (so there is nothing for auto-start to do)');
  else fail('ffa: the ai frame answered with a lobby');
  handleClientMessage(ws, { type: 'leave' });
}

if (rooms.size === 0) ok('every room torn down'); else fail(`${rooms.size} room(s) survived`);
console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
