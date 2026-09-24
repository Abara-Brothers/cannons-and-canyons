// TEST ONLY: the --import entry for test/fixtures/scripted-code-bytes.mjs.
// Loaded into a spawned server.js by test/code_frame.mjs world 3 as
//   node --import test/fixtures/scripted-code-bytes-preload.mjs server.js
// with CC_TEST_CODE_BYTES="0,1,2,3,...", and never by anything else. It is a
// FILE OF ITS OWN so that importing the helper never arms the hook: the
// helper is also imported in process by test/squad.mjs, where a stray
// CC_TEST_CODE_BYTES in the caller's shell must not script its codes.
import { scriptCodeBytes } from './scripted-code-bytes.mjs';

const env = process.env.CC_TEST_CODE_BYTES;
if (env !== undefined) {
  // A malformed script THROWS at load rather than degrading to random bytes:
  // a world that believed it had scripted "ABCD" and was minting at random
  // would pass or fail for a reason nobody chose.
  const bytes = env.split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number);
  scriptCodeBytes(bytes, { log: (line) => process.stderr.write(line + '\n') });
  process.stderr.write(`[code-bytes] armed ${bytes.length}\n`);
}
