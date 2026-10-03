// Derives the one-time age identity for the Deploy handoff from the deploy code (6 words), read on stdin;
// with --backup, the owner's backup identity from the backup code instead.
// Prints AGE-SECRET-KEY-1... on stdout. The workflow encrypts to its public half (age-keygen -y); the host
// decrypts with it. Same idea as age's passphrase mode (scrypt, age's own work factor logN 18, r 8, p 1),
// which age 1.1.1 can only read from a terminal. The code is normalised (lowercase, single spaces), so
// stray spaces or capitals in the GitHub secret do not matter.
import { scryptSync } from 'node:crypto';

let input = '';
for await (const c of process.stdin) input += c;
const code = input.trim().toLowerCase().split(/\s+/).join(' ');
if (!/^[a-z-]+( [a-z-]+){5}$/.test(code)) {
  console.error('Deploy code must be 6 words.');
  process.exit(2);
}
// Domain separation by purpose: the deploy code (default) and the owner's backup code never share a key.
const SALTS = { deploy: 'zeroed-deploy-handoff-v1', backup: 'zeroed-backup-v1' };
const purpose = process.argv[2] === '--backup' ? 'backup' : 'deploy';
const key = scryptSync(code, SALTS[purpose], 32, { N: 2 ** 18, r: 8, p: 1, maxmem: 320 * 1024 * 1024 });
// RFC 7748 clamp, so the stored scalar is exactly the one X25519 uses (X25519 clamps on use anyway, so this
// changes the encoded identity, never the key pair it stands for).
key[0] &= 248;
key[31] &= 127;
key[31] |= 64;

// Bech32 (BIP 173), as age uses for identities.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (values) => {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk;
};
const hrp = 'age-secret-key-';
const words = [];
let acc = 0;
let bits = 0;
for (const b of key) {
  acc = (acc << 8) | b;
  bits += 8;
  while (bits >= 5) {
    bits -= 5;
    words.push((acc >>> bits) & 31);
  }
}
if (bits > 0) words.push((acc << (5 - bits)) & 31);
const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
const mod = polymod(hrpExpand.concat(words, [0, 0, 0, 0, 0, 0])) ^ 1;
const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
process.stdout.write((hrp + '1' + words.concat(checksum).map((d) => CHARSET[d]).join('')).toUpperCase() + '\n');
