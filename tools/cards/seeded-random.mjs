// Preloaded into the capture tool's OWN server (node --import), never into the
// real one: Math.random becomes a seeded generator, so the map, the biome, the
// room code and the bots' choices of a capture run are the same every time it
// runs. tools/cards/capture.mjs passes the seed in CARD_SEED.
//
// mulberry32, the generator game-core.js already uses for its seeded maps.
let a = (Number(process.env.CARD_SEED) >>> 0) || 1;
Math.random = function seededRandom() {
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
