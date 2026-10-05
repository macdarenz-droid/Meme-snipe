// DEPLOYER-COMPACT: the deployer index's mints by creator, held compact. A Map of Maps cost about 316 B a create
// (measured: the mint and creator strings, a per-creator Map of about 140 B for the usual single mint, a boxed time):
// about 171 MB over the 15-day window at the live 25 creates a minute, 512 MB at three times that. Here a mint is its
// 32 address bytes, its time a float and its next link an int in growable typed arrays, each creator's mints a linked
// list in insertion order; only the creator stays a string (a Map key). A mint that is not a canonical 32-byte address
// (tests, malformed input) is kept as its string, so every mint reads back exactly as it was added.
import { decodeBase58, encodeBase58 } from '../chain/base58.ts';
import { flatCopy } from '../engine/asof.ts';

const ADDRESS_BYTES = 32;
const NONE = -1;

/** The mint's 32 address bytes when its text is exactly their base58 form, else null. */
const addressBytes = (mint: string): Uint8Array | null => {
  try {
    const b = decodeBase58(mint);
    return b.length === ADDRESS_BYTES && encodeBase58(b) === mint ? b : null;
  } catch {
    return null;
  }
};

/** Growable typed columns. */
const grow = <T extends Uint8Array | Int32Array | Float64Array>(a: T, need: number, make: (n: number) => T, per = 1): T => {
  if (need * per <= a.length) return a;
  const b = make(Math.max(256 * per, Math.ceil(a.length * 1.25 / per) * per, need * per));
  b.set(a);
  return b;
};

/** A 30-bit tag of a creator's text (its table position); creators sharing one are told apart by their bytes. */
const tagOf = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h & ((1 << 30) - 1);
};

export class MintIndex {
  // Creators: a list each (its first and last entry), found through an open-addressing table by tag, then by its
  // 32 bytes (or its text). A Map entry per creator measured about 40 B; a table slot is 4.
  #table = new Int32Array(0);
  #tags = new Int32Array(0);
  #creatorBytes = new Uint8Array(0);
  #creatorText = new Map<number, string>();
  #head = new Int32Array(0);
  #tail = new Int32Array(0);
  #lists = 0;
  // Entries.
  #bytes = new Uint8Array(0);
  #at = new Float64Array(0);
  #next = new Int32Array(0);
  /** Mints kept as text (not canonical addresses), by entry. */
  #text = new Map<number, string>();
  #count = 0;

  /** Entries held. */
  get size(): number {
    return this.#count;
  }

  /** Creators with at least one entry, in no set order. */
  *creators(): Generator<string> {
    for (let c = 0; c < this.#lists; c++) if (this.#head[c] !== NONE) yield this.#creatorAt(c);
  }

  has(creator: string): boolean {
    const c = this.#find(creator, addressBytes(creator));
    return c !== NONE && this.#head[c] !== NONE;
  }

  /** A creator's mints and their times, in the order they were first added. */
  *entries(creator: string): Generator<readonly [string, number]> {
    const c = this.#find(creator, addressBytes(creator));
    for (let i = c === NONE ? NONE : this.#head[c]!; i !== NONE; i = this.#next[i]!) yield [this.#mintAt(i), this.#at[i]!] as const;
  }

  /** The same mint added again keeps its earliest time and its place. */
  add(creator: string, mint: string, atMs: number): void {
    const cb = addressBytes(creator);
    let c = this.#find(creator, cb);
    const bytes = addressBytes(mint);
    if (c !== NONE) {
      for (let i = this.#head[c]!; i !== NONE; i = this.#next[i]!) {
        if (!this.#is(i, mint, bytes)) continue;
        if (atMs < this.#at[i]!) this.#at[i] = atMs;
        return;
      }
    } else c = this.#newList(creator, cb);
    const i = this.#push(mint, bytes, atMs);
    if (this.#head[c] === NONE) this.#head[c] = i;
    else this.#next[this.#tail[c]!] = i;
    this.#tail[c] = i;
  }

  /** Replaces a creator's list with these entries, in order (a restored row). */
  setRow(creator: string, rows: Iterable<readonly [string, number]>): void {
    const c = this.#find(creator, addressBytes(creator));
    if (c !== NONE) this.#head[c] = NONE;
    for (const [mint, at] of rows) this.add(creator, mint, at);
  }

  /** Keeps only entries dated at or after `fromMs`, rebuilt compact, every list in its order. */
  prune(fromMs: number): void {
    const rows: [string, [string, number][]][] = [];
    for (let c = 0; c < this.#lists; c++) {
      const kept: [string, number][] = [];
      for (let i = this.#head[c]!; i !== NONE; i = this.#next[i]!) if (this.#at[i]! >= fromMs) kept.push([this.#mintAt(i), this.#at[i]!]);
      if (kept.length > 0) rows.push([this.#creatorAt(c), kept]);
    }
    // Sized exactly for what is kept, so a pruned index carries no growth slack.
    const entries = rows.reduce((n, [, kept]) => n + kept.length, 0);
    this.#table = new Int32Array(0);
    this.#tags = new Int32Array(rows.length);
    this.#creatorBytes = new Uint8Array(rows.length * ADDRESS_BYTES);
    this.#creatorText = new Map();
    this.#head = new Int32Array(rows.length);
    this.#tail = new Int32Array(rows.length);
    this.#lists = 0;
    this.#bytes = new Uint8Array(entries * ADDRESS_BYTES);
    this.#at = new Float64Array(entries);
    this.#next = new Int32Array(entries);
    this.#text = new Map();
    this.#count = 0;
    for (const [creator, kept] of rows) for (const [mint, at] of kept) this.add(creator, mint, at);
  }

  #find(creator: string, cb: Uint8Array | null): number {
    const mask = this.#table.length - 1;
    if (mask < 0) return NONE;
    for (let h = tagOf(creator) & mask; ; h = (h + 1) & mask) {
      const v = this.#table[h]!;
      if (v === 0) return NONE;
      const c = v - 1;
      const t = this.#creatorText.get(c);
      if (t !== undefined || cb === null) {
        if (t === creator) return c;
        continue;
      }
      const o = c * ADDRESS_BYTES;
      let same = true;
      for (let k = 0; k < ADDRESS_BYTES && same; k++) same = this.#creatorBytes[o + k] === cb[k];
      if (same) return c;
    }
  }

  /** Puts list `c` in the table (kept at most half full; doubled and refilled from the kept tags when it would not be). */
  #place(c: number): void {
    if (2 * (c + 1) > this.#table.length) {
      this.#table = new Int32Array(Math.max(256, this.#table.length * 2));
      for (let k = 0; k < c; k++) this.#slot(k);
    }
    this.#slot(c);
  }

  #slot(c: number): void {
    const mask = this.#table.length - 1;
    let h = this.#tags[c]! & mask;
    while (this.#table[h] !== 0) h = (h + 1) & mask;
    this.#table[h] = c + 1;
  }

  #newList(creator: string, cb: Uint8Array | null): number {
    const c = this.#lists++;
    this.#creatorBytes = grow(this.#creatorBytes, c + 1, (n) => new Uint8Array(n), ADDRESS_BYTES);
    this.#head = grow(this.#head, c + 1, (n) => new Int32Array(n));
    this.#tail = grow(this.#tail, c + 1, (n) => new Int32Array(n));
    this.#tags = grow(this.#tags, c + 1, (n) => new Int32Array(n));
    if (cb === null) this.#creatorText.set(c, flatCopy(creator));
    else this.#creatorBytes.set(cb, c * ADDRESS_BYTES);
    this.#tags[c] = tagOf(creator);
    this.#place(c);
    this.#head[c] = NONE;
    this.#tail[c] = NONE;
    return c;
  }

  #creatorAt(c: number): string {
    return this.#creatorText.get(c) ?? encodeBase58(this.#creatorBytes.slice(c * ADDRESS_BYTES, (c + 1) * ADDRESS_BYTES));
  }

  #is(i: number, mint: string, bytes: Uint8Array | null): boolean {
    const t = this.#text.get(i);
    if (t !== undefined || bytes === null) return t === mint;
    const o = i * ADDRESS_BYTES;
    for (let k = 0; k < ADDRESS_BYTES; k++) if (this.#bytes[o + k] !== bytes[k]) return false;
    return true;
  }

  #mintAt(i: number): string {
    return this.#text.get(i) ?? encodeBase58(this.#bytes.slice(i * ADDRESS_BYTES, (i + 1) * ADDRESS_BYTES));
  }

  #push(mint: string, bytes: Uint8Array | null, atMs: number): number {
    const i = this.#count++;
    this.#bytes = grow(this.#bytes, i + 1, (n) => new Uint8Array(n), ADDRESS_BYTES);
    this.#at = grow(this.#at, i + 1, (n) => new Float64Array(n));
    this.#next = grow(this.#next, i + 1, (n) => new Int32Array(n));
    if (bytes === null) this.#text.set(i, flatCopy(mint));
    else this.#bytes.set(bytes, i * ADDRESS_BYTES);
    this.#at[i] = atMs;
    this.#next[i] = NONE;
    return i;
  }
}
