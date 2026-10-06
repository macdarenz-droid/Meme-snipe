// Bitcoin-alphabet base58, written here on purpose: third-party base58 packages have shipped malware
// (docs/research/security.md). Leading zero bytes map to leading '1's, as Solana expects.
import { DecodeError } from './errors.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET.charCodeAt(i)] = i;
const ALPHABET_CODES = Array.from(ALPHABET, (c) => c.charCodeAt(0));

export const encodeBase58 = (bytes: Uint8Array): string => {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Base-58 digits, least significant first.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  const codes = new Array<number>(zeros + digits.length);
  for (let i = 0; i < zeros; i++) codes[i] = 49; // '1'
  for (let i = 0; i < digits.length; i++) codes[zeros + i] = ALPHABET_CODES[digits[digits.length - 1 - i]!]!;
  return String.fromCharCode(...codes);
};

export const decodeBase58 = (text: string): Uint8Array => {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  // Bytes, least significant first.
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? INDEX[code]! : -1;
    if (value < 0) throw new DecodeError(`invalid base58 character ${JSON.stringify(text[i])} at ${i}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]!;
  return out;
};

/** Decodes a 32-byte public key; any other length is an error. */
export const decodeAddressBytes = (text: string): Uint8Array => {
  const b = decodeBase58(text);
  if (b.length !== 32) throw new DecodeError(`address must decode to 32 bytes, got ${b.length}`);
  return b;
};
