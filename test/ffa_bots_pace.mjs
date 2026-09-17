// FFA CPU pacing (item A, owner decision): plain CPUs in a free-for-all use the
// survival cadence — a fire hold of at most 550 ms — while the duel CPU keeps
// its full 1500 ms hold. Headless, in-process, and deliberately a SEPARATE
// file from ffa_bots.mjs: that suite runs with BOT_FIRE_MS=40, at which both
// holds collapse to 40 ms and the difference is invisible. Here the knob is left
// at its production default, so the 'aim' -> 'shot' gap is the hold itself and
// the two cadences are a second apart.
process.env.PICK_MS = '200';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { rooms, handleClientMessage } = await import('../public/room-engine.js');
const mkws = () => ({ readyState: 1, _rx: [], send(s) { this._rx.push({ t: Date.now(), ...JSON.parse(s) }); } });
const LOADOUT = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
async function until(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); } return pred(); }

// The gap between a CPU seat's 'aim' and the 'shot' that follows it.
async function holdFor(frame) {
  const ws = mkws();
  handleClientMessage(ws, frame);
  handleClientMessage(ws, { type: 'fire', weapon: 'mortar', angle: 45, power: 60 });
  await until(() => ws._rx.some((m) => m.type === 'shot' && m.by !== 0), 30000);
  const shot = ws._rx.find((m) => m.type === 'shot' && m.by !== 0);
  const aim = shot && [...ws._rx].reverse().find((m) => m.type === 'aim' && m.seat === shot.by && m.t <= shot.t);
  handleClientMessage(ws, { type: 'leave' });
  return shot && aim ? { seat: shot.by, ms: shot.t - aim.t } : null;
}

const ffa = await holdFor({ type: 'ai', mode: 'ffa', max: 4, difficulty: 'medium', name: 'S', skin: 'olive', loadout: LOADOUT });
const duel = await holdFor({ type: 'ai', difficulty: 'medium', name: 'D', skin: 'olive', loadout: LOADOUT });

if (ffa && ffa.ms >= 450 && ffa.ms < 1000) ok(`ffa CPU ${ffa.seat}: aim -> shot in ${ffa.ms} ms (quick hold, 550 ms)`);
else fail(`ffa CPU hold was ${ffa ? ffa.ms + ' ms' : 'not observed'} — expected ~550 ms (survival cadence)`);
if (duel && duel.ms >= 1400 && duel.ms < 2200) ok(`duel CPU: aim -> shot in ${duel.ms} ms (full 1500 ms hold, unchanged)`);
else fail(`duel CPU hold was ${duel ? duel.ms + ' ms' : 'not observed'} — expected ~1500 ms`);
if (ffa && duel && duel.ms - ffa.ms >= 700) ok('the two cadences are clearly apart');
else fail('the ffa and duel holds are not clearly apart');
if (rooms.size === 0) ok('rooms torn down'); else fail(`${rooms.size} room(s) left`);

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
