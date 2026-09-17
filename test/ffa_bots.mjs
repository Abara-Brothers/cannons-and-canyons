// FFA vs CPUs (item A) — the engine in-process, no server, no Chrome.
//
// WHY THIS EXISTS: room-engine.js is the module that runs LIVE multiplayer, and
// the 'ai' case is the one place this feature touches it. Two things have to be
// true and neither is visible from a duel: (1) an old client's 'ai' frame — no
// mode, no max — still yields the exact duel-vs-CPU seat it always did, key for
// key; (2) a room with several plain CPUs hands the turn from one bot straight
// to another bot, which NO production mode had ever done (duel and boss
// alternate with a human, survival forces one alien then a human). The bot
// chain has no per-seat timer state, but that was established by reading, so
// case (b) proves it by running it.
//
// Knobs are set BEFORE the dynamic import so the engine reads them at module
// evaluation: a 40 ms fire hold and a 200 ms pick window keep the run short.
process.env.BOT_FIRE_MS = '40';
process.env.PICK_MS = '200';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const engine = await import('../public/room-engine.js');
const { rooms, handleClientMessage, setMatchSink } = engine;

const records = [];
setMatchSink((r) => records.push(r));
let escaped = null;
process.on('uncaughtException', (e) => { escaped = e; });

const mkws = () => ({ readyState: 1, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
const LOADOUT = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
const frames = (ws, t) => ws._rx.filter((m) => m.type === t);
const roomOf = (ws) => rooms.get(ws.roomCode);
// Every case tears its room down: a lone human's 'leave' is a teardown, so the
// bots stop and the next case's `records` cannot be polluted by this room's
// later gameover (recordMatch carries no room code).
const leave = (ws) => { try { handleClientMessage(ws, { type: 'leave' }); } catch (e) { fail('leave threw: ' + e.message); } };
const ffa = (ws, extra = {}) => handleClientMessage(ws, {
  type: 'ai', mode: 'ffa', max: 4, difficulty: 'hard', name: 'Solo', skin: 'olive', loadout: LOADOUT, ...extra,
});
const stripToken = (p) => { const { token, ...rest } = p; return rest; };
async function until(pred, ms, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(step); }
  return pred();
}

// ---- (a) SHAPE: one frame seats a human and three CPUs ----------------------
{
  const ws = mkws();
  ffa(ws);
  const room = roomOf(ws);
  if (!room) { fail('(a) no room was created for the ffa ai frame'); }
  else {
    if (room.mode === 'ffa' && room.max === 4 && room.players.length === 4) ok('(a) a 4-seat ffa room');
    else fail(`(a) room is mode=${room.mode} max=${room.max} seats=${room.players.length}`);
    const h = room.players[0], bots = room.players.slice(1);
    if (h && h.ws === ws && !h.bot) ok('(a) the human holds seat 0');
    else fail('(a) seat 0 is not the human');
    if (bots.every((b) => b && b.bot === true && b.ws === null && b.connected === true && b.difficulty === 'hard' && b.quick === true)) {
      ok('(a) seats 1-3 are connected CPUs at the requested difficulty, flagged quick');
    } else fail('(a) a CPU seat is malformed: ' + JSON.stringify(bots.map(stripToken)));
    const names = bots.map((b) => b.name);
    if (JSON.stringify(names) === JSON.stringify(['CPU 1', 'CPU 2', 'CPU 3'])) ok('(a) CPUs are numbered, short enough for the phone HUD');
    else fail(`(a) CPU names are ${JSON.stringify(names)}`);
    if (names.every((n) => n.length <= 14)) ok('(a) every CPU name fits NAME_MAX');
    else fail('(a) a CPU name exceeds 14 characters');
    const skins = bots.map((b) => b.skin);
    if (JSON.stringify(skins) === JSON.stringify(['desert', 'jungle', 'midnight'])) ok('(a) CPU paints follow the per-seat fallback, seat 1 desert as in a duel');
    else fail(`(a) CPU skins are ${JSON.stringify(skins)}`);
    if (room.vsBot === true) ok('(a) room.vsBot is set, so scheduleBot will move them');
    else fail('(a) room.vsBot is not set — the CPUs would never act');
    if (room.turn === 0) ok('(a) the human opens');
    else fail(`(a) turn opened on seat ${room.turn}`);
    if ([1, 2, 3].every((i) => Array.isArray(room.loadouts[i]) && room.loadouts[i].length === 5)) ok('(a) each CPU drew a 5-pick loadout');
    else fail('(a) a CPU has no drafted loadout: ' + JSON.stringify(room.loadouts));
    const st = frames(ws, 'start')[0];
    if (st && st.n === 4 && st.names.length === 4 && st.you === 0 && st.mode === 'ffa' && st.boss === undefined
        && Array.isArray(st.kinds) && st.kinds.every((k) => k === 'tank')) {
      ok('(a) the start snapshot is a plain 4-tank ffa: no boss, no alien kinds');
    } else fail('(a) start snapshot is wrong: ' + JSON.stringify(st && { n: st.n, you: st.you, mode: st.mode, boss: st.boss, kinds: st.kinds }));
    if (frames(ws, 'turn')[0] && frames(ws, 'turn')[0].turn === 0) ok('(a) the first turn frame names the human');
    else fail('(a) no first turn frame for seat 0 (picking should be closed: the human sent a full loadout)');
  }
  leave(ws);
}

// ---- (b) BOT -> BOT HANDOVER, through the plain ring, with real timers -------
{
  const ws = mkws();
  ffa(ws);
  const room = roomOf(ws);
  handleClientMessage(ws, { type: 'fire', weapon: 'mortar', angle: 45, power: 60 });
  const botShots = () => frames(ws, 'shot').filter((s) => [1, 2, 3].includes(s.by));
  const distinct = () => new Set(botShots().map((s) => s.by)).size;
  // 40 s, not 20: per CPU turn = replay watch + think + up to ~1.3 s of walking +
  // hold + clock + up to 5 s of gas burn whenever a random loadout lands gas.
  // Wait for the ring to come BACK to the human (three CPU turns), not merely
  // for two CPUs to have fired, or the return-to-seat-0 check below is judged
  // on a half-finished rotation.
  const backToHuman = () => frames(ws, 'turn').some((t, i) => i > 0 && t.turn === 0);
  await until(() => (distinct() >= 2 && backToHuman()) || frames(ws, 'gameover').length, 40000, 200);
  const over = frames(ws, 'gameover')[0];
  if (distinct() >= 2) ok(`(b) ${distinct()} distinct CPUs fired (${botShots().length} CPU shots) with no human in between`);
  else fail(`(b) only ${distinct()} distinct CPU seat(s) fired within 40 s${over ? ' (game ended first)' : ''} — the ring did not hand a turn bot to bot`);
  // Ordering: between any two consecutive shots exactly one turn frame — a stale
  // fire hold or a double advance is the one thing a bot->bot room can do that
  // a duel cannot.
  const rx = ws._rx;
  const shotIdx = rx.map((m, i) => (m.type === 'shot' ? i : -1)).filter((i) => i >= 0);
  let orderBad = 0;
  for (let k = 1; k < shotIdx.length; k++) {
    const between = rx.slice(shotIdx[k - 1] + 1, shotIdx[k]).filter((m) => m.type === 'turn').length;
    if (between !== 1) orderBad++;
  }
  if (shotIdx.length >= 3 && orderBad === 0) ok(`(b) exactly one turn frame between each of ${shotIdx.length} shots`);
  else if (shotIdx.length < 3) fail(`(b) too few shots (${shotIdx.length}) to check turn ordering`);
  else fail(`(b) ${orderBad} shot pair(s) had a turn count other than one between them`);
  // No turn ever lands on a wreck, no shot comes from a seat the previous turn
  // frame showed dead, and every move names the seat whose turn it is.
  let lastTurn = null, deadShot = 0, wreckTurn = 0, strayMove = 0;
  for (const m of rx) {
    if (m.type === 'turn') { lastTurn = m; if (m.alive && m.alive[m.turn] === false) wreckTurn++; }
    else if (m.type === 'shot' && lastTurn && lastTurn.alive && lastTurn.alive[m.by] === false) deadShot++;
    else if (m.type === 'move' && lastTurn && m.seat !== lastTurn.turn) strayMove++;
  }
  if (!wreckTurn) ok('(b) no turn frame names an eliminated seat'); else fail(`(b) ${wreckTurn} turn frame(s) landed on a wreck`);
  if (!deadShot) ok('(b) no shot came from a seat shown dead by the preceding turn frame'); else fail(`(b) ${deadShot} shot(s) from a dead seat`);
  if (!strayMove) ok('(b) every move frame names the seat whose turn it is'); else fail(`(b) ${strayMove} move frame(s) from a seat out of turn`);
  const turns = frames(ws, 'turn');
  const lastAlive0 = turns.length ? turns[turns.length - 1].alive[0] : true;
  const cameBack = turns.some((t, i) => i > 0 && t.turn === 0);
  if (cameBack) ok('(b) the ring came back to the human');
  else if (!lastAlive0 || over) ok('(b) the human was eliminated before the ring came back (allowed; handover already proven)');
  else fail('(b) the ring never returned to seat 0 while the human was alive');
  leave(ws);
}

// ---- (c) HUMAN WINS: gameover, alive flags and the ledger row ----------------
{
  const ws = mkws();
  ffa(ws);
  const room = roomOf(ws);
  room.hp[1] = 0; room.hp[2] = 0; room.hp[3] = 0;
  records.length = 0;
  handleClientMessage(ws, { type: 'fire', weapon: 'mortar', angle: 45, power: 60 });
  await until(() => frames(ws, 'gameover').length, 12000);
  const g = frames(ws, 'gameover')[0];
  if (g && g.winner === 0 && g.team === null && JSON.stringify(g.alive) === JSON.stringify([true, false, false, false])) ok('(c) the human wins: winner 0, team null, three wrecks');
  else fail('(c) gameover was ' + JSON.stringify(g && { winner: g.winner, team: g.team, alive: g.alive }));
  if (g && g.stats && g.stats.dealt.length === 4) ok('(c) stats cover four seats'); else fail('(c) stats are not four wide');
  const r = records[records.length - 1];
  if (r && r.mode === 'ffa' && r.vsBot === true && r.playerCount === 1 && r.winnerSeat === 0 && r.winnerUser === null && Array.isArray(r.players) && r.players.length === 0) {
    ok('(c) the ledger row: ffa, vsBot, one human, winnerSeat 0, no winnerUser for an anonymous link');
  } else fail('(c) ledger row was ' + JSON.stringify(r));
  leave(ws);
}

// ---- (d) HUMAN LOSES: a CPU wins, and a bot never gets a winnerUser ---------
{
  const ws = mkws();
  ffa(ws);
  const room = roomOf(ws);
  room.hp[0] = 0; room.hp[2] = 0; room.hp[3] = 0;
  records.length = 0;
  handleClientMessage(ws, { type: 'fire', weapon: 'mortar', angle: 45, power: 60 });
  await until(() => frames(ws, 'gameover').length, 12000);
  const g = frames(ws, 'gameover')[0];
  if (g && g.winner === 1) ok('(d) CPU 1 is the winner'); else fail('(d) gameover was ' + JSON.stringify(g && { winner: g.winner, alive: g.alive }));
  const r = records[records.length - 1];
  if (r && r.vsBot === true && r.winnerSeat === 1 && r.winnerUser === null) ok('(d) the ledger row names the CPU seat and no user');
  else fail('(d) ledger row was ' + JSON.stringify(r));
  leave(ws);
}

// ---- (e) DUEL BYTE-IDENTITY: an old client's frame is unchanged -------------
{
  const DUEL_SEAT = { ws: null, bot: true, difficulty: 'easy', name: 'CPU · Easy', connected: true, dropTimer: null, skin: 'desert' };
  for (const extra of [{}, { mode: 'boss' }, { mode: 'golf' }, { mode: 'aliens' }, { mode: 'ffa ' }, { max: 4 }]) {
    const ws = mkws();
    handleClientMessage(ws, { type: 'ai', difficulty: 'easy', name: 'D', skin: 'olive', ...extra });
    const room = roomOf(ws);
    const tag = JSON.stringify(extra);
    if (room && room.mode === 'duel' && room.max === 2 && room.players.length === 2) ok(`(e) ${tag} -> a 2-seat duel`);
    else fail(`(e) ${tag} -> mode=${room && room.mode} max=${room && room.max} seats=${room && room.players.length}`);
    const cpu = room && room.players[1];
    if (cpu && JSON.stringify(stripToken(cpu)) === JSON.stringify(DUEL_SEAT) && !('quick' in cpu)) ok(`(e) ${tag} -> the duel CPU seat is key-for-key the historical literal, no quick flag`);
    else fail(`(e) ${tag} -> duel CPU seat drifted: ${JSON.stringify(cpu && stripToken(cpu))}`);
    if (cpu && /^[0-9a-f]{24}$/.test(cpu.token)) ok(`(e) ${tag} -> a 24-hex token`); else fail(`(e) ${tag} -> token is ${cpu && cpu.token}`);
    leave(ws);
  }
}

// ---- (f) CLAMP: max is bounded by createRoom exactly as for a human ffa ------
{
  for (const [max, want] of [[3, 3], [9, 4], [1, 2], [undefined, 4], ['x', 4]]) {
    const ws = mkws();
    ffa(ws, { max });
    const room = roomOf(ws);
    if (room && room.players.length === want && room.max === want) ok(`(f) max=${JSON.stringify(max)} -> ${want} seats`);
    else fail(`(f) max=${JSON.stringify(max)} -> ${room && room.players.length} seats (max ${room && room.max})`);
    leave(ws);
  }
}

// ---- (g) the fence from the human side: create+join never seats a CPU -------
{
  const host = mkws();
  handleClientMessage(host, { type: 'create', name: 'H', skin: 'olive', mode: 'ffa', max: 4, loadout: LOADOUT });
  const room = roomOf(host);
  if (room && room.players.filter(Boolean).length === 1 && room.players.every((p) => !p || !p.bot) && !room.vsBot) ok('(g) a human ffa create seats nobody but the host and does not flag vsBot');
  else fail('(g) a human ffa create grew a CPU or vsBot');
  leave(host);
}

if (escaped) fail(`a timer callback threw and ESCAPED (${escaped.message}) — this would kill every live match on the server`);
else ok('no timer throw escaped across every case');
if (rooms.size === 0) ok('every room was torn down'); else fail(`${rooms.size} room(s) survived teardown`);

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);   // bot timers would otherwise keep the loop alive
