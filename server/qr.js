// server/qr.js — a QR code for one short link, drawn as an SVG on this server.
//
// WHY IT EXISTS. A squad link opened on a computer shows the invite as a QR
// code, so the player can scan it with their phone (owner, 2026-10-10: "the
// same download page with a QR code to scan with a phone"). The page is drawn
// here, with no script at all, so the QR is too: nothing is fetched from
// another host, no CDN is trusted, and the project gains no dependency for one
// picture.
//
// WHAT IT ENCODES, AND NOTHING MORE. Byte mode, error correction level M (about
// 15% of the symbol may be lost and it still reads), versions 1 to 10: up to 213
// bytes, and a squad link is 42. It follows ISO/IEC 18004 step by step: the data
// bits, Reed-Solomon over GF(256) with the polynomial 0x11D, the blocks
// interleaved, the function patterns, the zigzag placement, and the mask with
// the lowest penalty score. Any of the eight masks reads, because a reader takes
// the mask from the format bits; the score only picks the cleanest one.
//
// HOW IT IS KNOWN TO BE RIGHT. test/http_contract.mjs pins the module matrix
// of a squad link this game shares, and the pictures of that link under each
// of the eight masks and of texts at versions 1, 4, 7 and 10 (the pad bytes,
// two and four blocks, the version bits, the 16-bit count). Apple's own reader
// (CoreImage CIDetector, on macOS) decoded every one of them back to its exact
// text when they were pinned. It also checks that the SVG draws exactly the
// matrix. A change here that changes any of those pictures fails there.

// Error correction codewords per block, and the number of blocks, at level M.
// Index = version; index 0 is unused. From the standard's table 9.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

// The modules left for data and error correction once the function patterns
// are drawn (the remainder bits included), for a version.
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

// GF(256) multiplication modulo x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
// The generator polynomial of a degree, highest term dropped: (x - a^0)...(x - a^(d-1)).
function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}
// The error correction codewords of one block: the remainder of its data
// divided by the generator.
function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  }
  return out;
}

// The alignment pattern centres on each axis, for a version.
function alignPositions(ver, size) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// The eight data masks, (x, y) = (column, row).
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// The standard's four penalty rules: runs of five or more in a line, 2x2
// blocks of one colour, the finder-like 1:1:3:1:1 run beside four light
// modules, and a dark share away from half.
function penalty(m, size) {
  const at = (x, y) => m[y][x];
  let p = 0;
  for (let a = 0; a < size; a++) {
    for (const across of [true, false]) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        const same = b < size && (across ? at(b, a) === at(b - 1, a) : at(a, b) === at(a, b - 1));
        if (same) { run++; continue; }
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
      }
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) p += 3;
    }
  }
  const FINDER = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 11 <= size; b++) {
      for (const across of [true, false]) {
        for (const pat of FINDER) {
          let hit = true;
          for (let k = 0; k < 11 && hit; k++) hit = (across ? at(b + k, a) : at(a, b + k)) === (pat[k] === 1);
          if (hit) p += 40;
        }
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (at(x, y)) dark++;
  const total = size * size;
  p += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

// -> { version, size, mask, modules }, modules[y][x] true for a dark module.
// Throws a RangeError for text longer than version 10 holds at level M.
// `mask` (0 to 7) names the mask instead of scoring all eight. Only the test
// that pins every mask's picture names one; the page never does.
export function qrMatrix(text, mask) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) throw new RangeError('qr: text too long for version ' + MAX_VERSION);

  // THE DATA: the byte-mode indicator, the count, the bytes, a terminator of up
  // to four zero bits, zero bits to the byte, then the two pad bytes in turn.
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0xec; data.length < dataCodewords(ver); pad ^= 0xec ^ 0x11) data.push(pad);

  // THE BLOCKS, each with its error correction, interleaved codeword by
  // codeword. Short blocks come first and carry one data codeword less.
  const nb = BLOCKS[ver], ecc = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecc);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = shortLen - ecc + (i < nShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const rem = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);                 // a gap, skipped when interleaving
    blocks.push(dat.concat(rem));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - ecc || j >= nShort) codewords.push(b[i]); });
  }

  // THE FUNCTION PATTERNS: timing, the three finders with their separators,
  // the alignment patterns, the format bits (reserved now, written per mask)
  // and, from version 7, the version bits.
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; isFn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = alignPositions(ver, size), na = al.length;
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // Level M's two indicator bits are 00, so the five format data bits are the mask.
  const drawFormat = (mask) => {
    let rem = mask;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((mask << 10) | rem) ^ 0x5412;
    const bit = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);                      // the dark module
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // THE ZIGZAG: two columns at a time from the right, up then down, skipping
  // the vertical timing column. Remainder bits stay light.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!isFn[y][x] && i < codewords.length * 8) {
          mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  // THE MASK with the lowest penalty; the first such on a tie.
  const applyMask = (k) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[k](x, y)) mod[y][x] = !mod[y][x];
  };
  let best = 0, bestScore = Infinity;
  if (Number.isInteger(mask) && mask >= 0 && mask < 8) { best = mask; bestScore = -1; }
  for (let k = 0; k < 8 && bestScore !== -1; k++) {
    applyMask(k);
    drawFormat(k);
    const s = penalty(mod, size);
    if (s < bestScore) { best = k; bestScore = s; }
    applyMask(k);                                // a mask is its own inverse
  }
  applyMask(best);
  drawFormat(best);
  return { version: ver, size, mask: best, modules: mod };
}

// -> the QR as an SVG, black on white with the standard's four-module quiet
// zone, one path of horizontal runs. Decorative to a screen reader: the page
// says in words what it is for.
export function qrSvg(text) {
  const { size, modules } = qrMatrix(text);
  const q = 4, n = size + 2 * q;
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size;) {
      if (!modules[y][x]) { x++; continue; }
      let run = 1;
      while (x + run < size && modules[y][x + run]) run++;
      d += 'M' + (x + q) + ' ' + (y + q) + 'h' + run + 'v1h-' + run + 'z';
      x += run;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" aria-hidden="true" focusable="false">'
    + '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
}
