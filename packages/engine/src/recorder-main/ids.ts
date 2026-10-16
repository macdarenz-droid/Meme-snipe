// ULIDs for M24 ids (26 characters of Crockford base32: a 48-bit ms time, then 80 random bits), the form the schema's
// CHECK requires (`m24/ddl.ts`). The random part comes from `random` (node:crypto in production; seeded in the soak).
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs: number, random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) throw new RangeError('ulid: time must be 0 to 2^48 - 1 ms');
  let t = nowMs;
  let time = '';
  for (let i = 0; i < 10; i++) { time = ALPHABET[t % 32] + time; t = Math.floor(t / 32); }
  const bytes = random(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let rand = '';
  for (let i = 0; i < 16; i++) { rand = ALPHABET[Number(bits & 31n)] + rand; bits >>= 5n; }
  return time + rand;
}
