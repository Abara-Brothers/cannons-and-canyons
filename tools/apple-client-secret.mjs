#!/usr/bin/env node
// Generate the "Secret Key (for OAuth)" that Supabase's Apple provider needs.
//
// WHY THIS IS A TOOL AND NOT A NOTE: Apple does not issue a client secret. You
// sign one yourself as an ES256 JWT, and Apple REFUSES any whose lifetime
// exceeds six months. So this is not a one-time paste — it expires, and when it
// does, Sign in with Apple stops working for everyone at once with no warning
// and no error anywhere in this codebase. Having the command on hand is the
// difference between a two-minute fix and an outage nobody can explain.
//
// The .p8 NEVER passes through a chat, a commit, or a command line argument's
// value being echoed anywhere: it is read from a file path you give, used, and
// dropped. Keep the file outside this repository.
//
// Usage:
//   node tools/apple-client-secret.mjs \
//     --key ~/Documents/Apple\ Keys/AuthKey_XXXXXXXXXX.p8 \
//     --key-id XXXXXXXXXX \
//     --team-id XXXXXXXXXX \
//     --services-id com.abarabrothers.cannonsandcanyons.signin
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[String(process.argv[i]).replace(/^--/, '')] = process.argv[i + 1];
}
const need = ['key', 'key-id', 'team-id', 'services-id'];
const missing = need.filter((k) => !args[k]);
if (missing.length) {
  console.error('Missing: ' + missing.map((m) => '--' + m).join(', '));
  console.error('\nExample:\n  node tools/apple-client-secret.mjs \\\n'
    + '    --key ~/Documents/Apple\\ Keys/AuthKey_ABC1234567.p8 \\\n'
    + '    --key-id ABC1234567 --team-id 96SNDBADH7 \\\n'
    + '    --services-id com.abarabrothers.cannonsandcanyons.signin');
  process.exit(2);
}

let pem;
try {
  pem = fs.readFileSync(args.key.replace(/^~/, process.env.HOME || '~'), 'utf8');
} catch (e) {
  console.error(`Could not read the key at ${args.key}\n  ${e.message}`);
  process.exit(1);
}
if (!/BEGIN PRIVATE KEY/.test(pem)) {
  console.error('That file is not an Apple .p8 private key (no "BEGIN PRIVATE KEY" header).');
  process.exit(1);
}

const b64url = (b) => Buffer.from(b).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const SIX_MONTHS = 15777000;              // Apple's hard ceiling; longer is rejected outright
const exp = now + SIX_MONTHS;

const header = b64url(JSON.stringify({ alg: 'ES256', kid: args['key-id'] }));
const claim = b64url(JSON.stringify({
  iss: args['team-id'],
  iat: now,
  exp,
  aud: 'https://appleid.apple.com',
  sub: args['services-id'],
}));
// ieee-p1363, exactly as in the APNs sender: node:crypto emits DER-wrapped
// ASN.1 for an EC key by default, and JWS ES256 requires the bare r||s pair.
// A DER signature fails only at Apple, as an opaque invalid_client.
const sig = crypto.sign('sha256', Buffer.from(`${header}.${claim}`),
  { key: pem, dsaEncoding: 'ieee-p1363' }).toString('base64url');

const jwt = `${header}.${claim}.${sig}`;
const when = new Date(exp * 1000).toISOString().slice(0, 10);

console.log('\nPaste this into Supabase → Authentication → Sign In / Providers → Apple');
console.log('→ "Secret Key (for OAuth)":\n');
console.log(jwt);
console.log(`\nEXPIRES ${when}. Sign in with Apple stops working that day, for everyone,`);
console.log('with no error raised anywhere in this project. Re-run this command and');
console.log('paste the new value before then.\n');
