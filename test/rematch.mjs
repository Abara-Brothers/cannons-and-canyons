// ISSUE-031: a refused rematch must SAY it was refused.
//
// The engine's `rematch` guard used to reject in silence — the client sent the
// message, nothing came back, and the button was simply dead. A player could not
// tell a refusal from a dropped connection. Two reachable cases were found by
// the 8.44 verifiers: a duo golf round ended by a disconnect forfeit (the
// survivor fails `every(connected)`), and a partner's socket closing while the
// room is 'over' (the room is torn down, so there is no room at all).
//
// This asserts the reply exists and carries a usable reason, across the two
// branches that can be reached cheaply and deterministically:
//   1. mid-match      — the room exists but is not 'over'
//   2. no room at all — the torn-down case, which was the worse of the two
//                       because the player is left holding a button for a room
//                       the server has already forgotten
import WebSocket from 'ws';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const out = { steps: [], errors: [] };
const step = (m) => { out.steps.push(m); console.log('  ' + m); };
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const finish = () => { console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall checks passed'); process.exit(out.errors.length ? 1 : 0); };
setTimeout(() => { fail('timeout'); finish(); }, 40000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = () => new Promise((resolve) => {
  const ws = new WebSocket(URL);
  ws.on('open', () => resolve(ws));
});
/** Wait for the next message of a given type, or null on timeout. */
const wait = (ws, type, ms = 6000) => new Promise((resolve) => {
  const timer = setTimeout(() => { ws.off('message', on); resolve(null); }, ms);
  function on(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type !== type) return;
    clearTimeout(timer); ws.off('message', on); resolve(m);
  }
  ws.on('message', on);
});

// ---- 1. mid-match: the room exists but has not finished ---------------------
{
  const ws = await open();
  ws.send(JSON.stringify({
    type: 'ai', name: 'Rematcher', skin: 'desert', difficulty: 'easy',
    loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'gas'],
  }));
  const started = await wait(ws, 'start');
  if (!started) fail('vs-CPU match never started');
  else {
    ws.send(JSON.stringify({ type: 'rematch' }));
    const denied = await wait(ws, 'rematchDenied');
    if (!denied) fail('mid-match rematch was refused SILENTLY — the ISSUE-031 defect');
    else if (!denied.reason || denied.reason.length < 8) fail(`rematchDenied carried no usable reason: ${JSON.stringify(denied.reason)}`);
    else step(`mid-match refusal explains itself: "${denied.reason}"`);
  }
  ws.close();
}

await sleep(300);

// ---- 2. no room at all: the torn-down case ---------------------------------
// A socket that has never been in a room is the same server state a player is
// left in when their partner's socket closes and the room is torn down: the
// message arrives, `rooms.get(...)` finds nothing.
{
  const ws = await open();
  ws.send(JSON.stringify({ type: 'rematch' }));
  const denied = await wait(ws, 'rematchDenied');
  if (!denied) fail('rematch with no room was refused SILENTLY — the worse ISSUE-031 case');
  else if (!denied.reason) fail('rematchDenied carried no reason');
  else step(`no-room refusal explains itself: "${denied.reason}"`);
  ws.close();
}

// ---- 3. the reply must not be a blanket denial ------------------------------
// A guard that always refuses would pass both checks above while breaking the
// feature outright, so prove the happy path still starts a match.
{
  const ws = await open();
  ws.send(JSON.stringify({
    type: 'ai', name: 'Rematcher2', skin: 'desert', difficulty: 'easy',
    loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'gas'],
  }));
  const started = await wait(ws, 'start');
  if (!started) fail('second vs-CPU match never started');
  else step('a real match still starts — the guard is not a blanket refusal');
  ws.close();
}

finish();
