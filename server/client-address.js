// server/client-address.js — which network address a connection comes from,
// for one purpose only: the per-address budget of new name reservations
// (server/reservations.js ADDR_ROWS_PER_HOUR; round 3 fix, 2026-10-10). Nothing
// else in this server keys anything by address, and nothing here is ever
// written down: privacy.html promises no IP address against an account or a
// crash report, and says how this one is used.
//
// WHERE THE ADDRESS COMES FROM. The game runs on Render, and a connection
// reaches this process from Render's proxy, so the socket's own address is
// the proxy's, the same for every player, and a budget keyed by it would be
// one budget for the whole game. The client's address is in a header the edge
// adds. Render's edge is Cloudflare (Render does not document this; it was
// measured on a Render service by a third party; server.js's log says, once,
// whether the connections it is given carry the header), and:
//   * CF-Connecting-IP is, in Cloudflare's own words, "the client IP address
//     connecting to Cloudflare", one address, and the header Cloudflare
//     recommends for exactly this. It is Cloudflare's to set on the way to
//     the origin, not the client's.
//   * X-Forwarded-For is NOT read. Cloudflare and Render both keep whatever
//     the client sent in it and append to it, so its left-most entry is the
//     client's to choose, and how many proxies append after the real address
//     is not a number Render documents. A budget keyed by a value the client
//     picks is no budget.
// A connection with no proxy header at all came to this process directly
// (a local run, a suite), and its socket's address is the client's. A
// connection that came through a proxy that named no client we can trust
// (X-Forwarded-For present, CF-Connecting-IP absent: the edge is not what this
// was written for) gets no address, and so no budget: the per-process bounds
// still hold it. server.js says so in its log, once, so a change at the edge
// is seen rather than silently turning the budget off.
//
// GROUPED, AND NEVER KEPT AS ITSELF. An IPv4 address is one budget. An IPv6
// address is grouped by its first 48 bits: one subscriber or one host is given
// a /64, a /56 or a /48 of its own, and a free tunnel hands anybody a whole
// /48, so a budget per /64 would be 65,536 budgets for one person. A mobile
// carrier puts many phones behind one IPv4 address in the same way, and the
// budget's size is chosen for that (reservations.js). An IPv4 address written
// as IPv6 (::ffff:a.b.c.d) is the IPv4 address. The group is then turned into
// a keyed hash, HMAC-SHA-256 under a key this process makes at boot and never
// writes anywhere, so the memory holds no address and two processes' keys
// for one address differ.
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

const KEY = randomBytes(32);

// The group an address is budgeted as, in a canonical spelling, or null for
// anything that is not an address.
export function addressGroup(raw) {
  let a = typeof raw === 'string' ? raw.trim() : '';
  if (!a || a.length > 64) return null;
  // A zone index (fe80::1%eth0) names the local link, not a client.
  if (a.includes('%')) a = a.slice(0, a.indexOf('%'));
  const kind = isIP(a);
  if (kind === 4) return a.split('.').map((n) => String(Number(n))).join('.');
  if (kind !== 6) return null;
  const low = a.toLowerCase();
  // ::ffff:a.b.c.d and ::ffff:hhhh:hhhh are the IPv4 address a.b.c.d.
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(low);
  if (mapped && isIP(mapped[1]) === 4) return addressGroup(mapped[1]);
  const words = expand(low);
  if (!words) return null;
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  return `${words.slice(0, 3).map((w) => w.toString(16)).join(':')}::/48`;
}

// Eight 16-bit words from an IPv6 address node:net has already accepted, an
// embedded IPv4 tail included; null if it cannot be read.
function expand(a) {
  let s = a;
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h) => (h ? h.split(':') : []);
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const words = [...head, ...Array(fill).fill('0'), ...tail].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

// The budget key for an upgrade request: { key, source }. `source` is 'edge'
// (CF-Connecting-IP), 'socket' (no proxy in the way) or null (none to be
// trusted), and `key` is null exactly when there is no address to budget.
export function clientAddressOf(req) {
  const h = (req && req.headers) || {};
  const one = (v) => (typeof v === 'string' ? v : Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' ? v[0] : '');
  const edge = addressGroup(one(h['cf-connecting-ip']));
  if (edge) return { key: keyOf(edge), source: 'edge' };
  if (h['x-forwarded-for'] === undefined && h['cf-connecting-ip'] === undefined) {
    const own = addressGroup(req && req.socket ? req.socket.remoteAddress : '');
    if (own) return { key: keyOf(own), source: 'socket' };
  }
  return { key: null, source: null };
}

const keyOf = (group) => createHmac('sha256', KEY).update(group).digest('base64url').slice(0, 22);
