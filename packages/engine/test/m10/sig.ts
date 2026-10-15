// Test helper: a deterministic transaction signature (64 bytes, base58) for evidence records (ruling Z06-15). Bytes
// 1-4 hold `i` and byte 5 the tag's first character, so every (tag, i) gives a different signature.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function sig(tag: string, i: number): string {
  const bytes = Array.from({ length: 64 }, (_, k) => (k * 37 + 11) & 0xff);
  bytes[0] = 0x80;
  for (let k = 0; k < 4; k++) bytes[1 + k] = (i >>> (8 * (3 - k))) & 0xff;
  bytes[5] = tag.charCodeAt(0) & 0xff;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = (ALPHABET[Number(n % 58n)] as string) + out; n /= 58n; }
  return out;
}
