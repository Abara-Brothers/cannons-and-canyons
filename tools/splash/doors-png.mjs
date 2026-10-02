// The launch image's pixels, in and out: shared by tools/splash/render-doors.mjs
// (which writes the PNG) and test/intro.mjs (which checks it still matches the
// intro's frame 0), so the two can never read pixels differently.
//
// WHY NOT canvas.toDataURL. Chrome's encoder is tuned for speed: RGBA and a
// fast deflate. Frame 0 is dark gradients carrying Chrome's ordered dither
// (more than half of all neighbouring pixels differ by a level or two), which
// that encoder stores at 6.8 MB. RGB, a per-row adaptive filter and deflate at
// level 9 store the SAME pixels, losslessly, in under 1 MB of app bundle.
import zlib from 'node:zlib';

// A browser-side expression: `n` rows of the #intro canvas from row `y0`, as
// base64 RGB, plus whether every pixel in them is fully opaque.
export const readRows = (y0, n) => `(() => {
  const cv = document.getElementById('intro');
  const d = cv.getContext('2d').getImageData(0, ${y0}, cv.width, ${n}).data;
  let opaque = true, s = '';
  const out = new Uint8Array(d.length / 4 * 3);
  for (let i = 0, o = 0; i < d.length; i += 4, o += 3) {
    if (d[i + 3] !== 255) opaque = false;
    out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2];
  }
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return { opaque, b64: btoa(s) };
})()`;

// The whole canvas as one RGB buffer, read in bands so no single CDP message
// carries tens of megabytes. `ev` evaluates an expression in the page.
export async function readCanvasRGB(ev, w, h) {
  const rgb = Buffer.alloc(w * h * 3), BAND = 128;
  let opaque = true;
  for (let y = 0; y < h; y += BAND) {
    const n = Math.min(BAND, h - y), r = await ev(readRows(y, n));
    if (!r.opaque) opaque = false;
    Buffer.from(r.b64, 'base64').copy(rgb, y * w * 3);
  }
  return { rgb, opaque };
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
const predict = (f, a, u, ul) => f === 1 ? a : f === 2 ? u : f === 3 ? (a + u) >> 1 : f === 4 ? paeth(a, u, ul) : 0;

// 8-bit RGB, each row filtered with whichever of the five PNG filters leaves
// the smallest residuals (the standard minimum-sum heuristic).
export function encodeRGB(rgb, w, h) {
  const stride = w * 3, raw = Buffer.alloc((stride + 1) * h);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < h; y++) {
    const row = y * stride, up = row - stride;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f]; let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? rgb[row + i - 3] : 0, u = y ? rgb[up + i] : 0, ul = y && i >= 3 ? rgb[up + i - 3] : 0;
        const v = (rgb[row + i] - predict(f, a, u, ul)) & 255;
        c[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best; cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour, no interlace
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Reads back exactly what encodeRGB writes (8-bit RGB, not interlaced) and
// throws on anything else: a PNG re-saved by another tool is a drifted image.
export function decodeRGB(png) {
  if (!png.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let w = 0, h = 0; const idat = [];
  for (let p = 8; p < png.length;) {
    const len = png.readUInt32BE(p), type = png.toString('latin1', p + 4, p + 8), data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error(`not 8-bit RGB without interlace (depth ${data[8]}, colour type ${data[9]}, interlace ${data[12]}) -- re-run tools/splash/render-doors.mjs`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 3, rgb = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    if (f > 4) throw new Error(`bad filter ${f} on row ${y}`);
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? rgb[row + i - 3] : 0, u = y ? rgb[up + i] : 0, ul = y && i >= 3 ? rgb[up + i - 3] : 0;
      rgb[row + i] = (raw[src + i] + predict(f, a, u, ul)) & 255;
    }
  }
  return { w, h, rgb };
}
