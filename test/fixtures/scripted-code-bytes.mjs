// TEST ONLY. Serves ONE-BYTE getRandomValues requests from a script, so a
// test can decide which room and squad codes get minted. Never imported by
// anything under public/ or server/, never loaded by a deploy, and not served:
// the static route serves public/ and nothing else.
//
// WHY IT EXISTS. Plan R4 says a squad code and a room code can never be the
// same string, and that is proved in two directions against the REAL
// server.js by test/code_frame.mjs. Codes are random, and nothing in the real
// server lets a test choose one, so a test that "tries a few times" proves
// nothing. Both minters draw the same way — public/room-engine.js makeCode and
// server/squads.js mintCode each call
// `globalThis.crypto.getRandomValues(new Uint8Array(1))` ONCE PER CHARACTER,
// rejection-sampled under 248 — so byte b gives 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]
// and the byte sequence 0,1,2,3 mints "ABCD". Scripting one-byte requests
// therefore steers both minters with one hook.
//
// ONLY ONE-BYTE REQUESTS ARE SCRIPTED. Every other length passes straight to
// the real CSPRNG — makeToken asks for 12 bytes and makeHandle for 4 — so
// resume tokens and seat handles stay random and cannot eat the script. When
// the script runs out, one-byte requests fall back to the real CSPRNG too.
// Every one-byte request is COUNTED and, when a logger is given, reported with
// where its byte came from, so a test can prove nothing else consumed the
// script before relying on it.
//
// Two ways in, in two files, so that one can never be the other:
//   * `import { scriptCodeBytes }` from THIS file installs it in the
//     importing process for the length of one test, and `restore()` takes it
//     out again. Importing this file never arms anything by itself, whatever
//     the environment says — test/squad.mjs imports it in process.
//   * `node --import test/fixtures/scripted-code-bytes-preload.mjs server.js`
//     with CC_TEST_CODE_BYTES="0,1,2,3" installs it at load and reports each
//     one-byte request on stderr as `[code-bytes] <n> <script|real> <byte>`.

export function scriptCodeBytes(bytes, { log = null } = {}) {
  const queue = [...bytes];
  for (const b of queue) {
    if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error('scripted-code-bytes: not a byte: ' + JSON.stringify(b));
  }
  const c = globalThis.crypto;
  // THE PROTOTYPE'S METHOD, looked up BEFORE the instance is shadowed, and
  // always called with the Crypto instance as `this` — Node brand-checks it.
  const real = c.getRandomValues;
  const st = { oneByte: 0, scripted: 0, real: 0 };
  // An OWN PROPERTY ON THE INSTANCE, which shadows Crypto.prototype's method
  // for every caller that reaches it as globalThis.crypto.getRandomValues —
  // which is how both minters reach it. Whether that takes effect in the Node
  // running the test is exactly what the first assertion in every world that
  // uses this proves, before anything else relies on it.
  Object.defineProperty(c, 'getRandomValues', {
    configurable: true,
    writable: true,
    value: function getRandomValues(arr) {
      if (!(arr instanceof Uint8Array) || arr.length !== 1) return real.call(c, arr);
      st.oneByte++;
      if (queue.length) {
        arr[0] = queue.shift();
        st.scripted++;
        if (log) log(`[code-bytes] ${st.oneByte} script ${arr[0]}`);
        return arr;
      }
      real.call(c, arr);
      st.real++;
      if (log) log(`[code-bytes] ${st.oneByte} real ${arr[0]}`);
      return arr;
    },
  });
  st.left = () => queue.length;
  // Deleting the own property uncovers the prototype's method again.
  st.restore = () => { delete c.getRandomValues; };
  return st;
}

