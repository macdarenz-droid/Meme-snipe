// DEPLOYER-COMPACT: the deployer index's mints by creator, held compact. A Map of Maps cost about 316 B a create
// (measured: the mint and creator strings, a per-creator Map of about 140 B for the usual single mint, a boxed time):
// about 171 MB over the 15-day window at the live 25 creates a minute, 512 MB at three times that. Here a mint is its
// address text packed six bits a character into a 34-byte slot (its length, then each character's base58 index), its
// time a float, its next link and its creator an int, in typed arrays; each creator's mints are a linked list in
// insertion order; each creator is a slot too. Creators and mints are found through open-addressing tables of ints
// (O(1) per add, persist review); a prune compacts in place by index. Packed text, not address bytes (persist review):
// a save turns every row back into text, and base58 arithmetic at a full window cost seconds; a packed slot reads back
// with a table lookup per character. Text that is not base58 or longer than 44 characters (tests, malformed input) is
// kept as a string, so everything reads back exactly as added.
import { flatCopy } from '../engine/asof.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CODES = Array.from(ALPHABET, (c) => c.charCodeAt(0));
const INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET.charCodeAt(i)] = i;
/** The longest base58 address (32 bytes). */
const MAX_CHARS = 44;
/** A slot: one length byte, then 44 six-bit indices (264 bits). */
const ADDRESS_BYTES = 1 + (MAX_CHARS * 6) / 8;
const NONE = -1;

/** A saved table that repeats a creator row or a mint inside one (refused whole). */
export class RepeatedRowError extends RangeError {}
const MIN_TABLE = 256;
const GROWTH = 1.25;

/** A 30-bit tag of a text kept as a string (its table position). */
const textTag = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h & ((1 << 30) - 1);
};

/** Reused for the creator and the mint being looked up (single-threaded); copied into storage only when kept. */
const CREATOR_SCRATCH = new Uint8Array(ADDRESS_BYTES);
const MINT_SCRATCH = new Uint8Array(ADDRESS_BYTES);

/** The text tag of the text last given to `toSlot` (computed in the same pass). */
let lastTag = 0;

/** The text packed into `SCRATCH`, or null when it is empty, longer than 44 characters or not base58; sets `lastTag`. */
const toSlot = (s: string, SCRATCH: Uint8Array): Uint8Array | null => {
  if (s.length === 0 || s.length > MAX_CHARS) {
    lastTag = textTag(s);
    return null;
  }
  SCRATCH.fill(0);
  SCRATCH[0] = s.length;
  let h = 0;
  let ok = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = (Math.imul(h, 31) + c) | 0;
    const d = c < 128 ? INDEX[c]! : -1;
    if (d < 0) {
      ok = false;
      continue;
    }
    // Bit position 6i in the 264 bits after the length byte.
    const bit = 6 * i;
    const at = 1 + (bit >> 3);
    const sh = bit & 7;
    SCRATCH[at] = SCRATCH[at]! | ((d << sh) & 255);
    if (sh > 2) SCRATCH[at + 1] = SCRATCH[at + 1]! | (d >> (8 - sh));
  }
  lastTag = h & ((1 << 30) - 1);
  return ok ? SCRATCH : null;
};

const CHARS = Buffer.alloc(MAX_CHARS);

/** The text a slot holds. */
const fromSlot = (b: Uint8Array, o: number): string => {
  const n = b[o]!;
  for (let i = 0; i < n; i++) {
    const bit = 6 * i;
    const at = o + 1 + (bit >> 3);
    const sh = bit & 7;
    const d = ((b[at]! >> sh) | (sh > 2 ? b[at + 1]! << (8 - sh) : 0)) & 63;
    CHARS[i] = CODES[d]!;
  }
  return CHARS.toString('latin1', 0, n);
};

const grown = (length: number, need: number): number => Math.max(MIN_TABLE, Math.ceil(length * GROWTH), need);

const sameBytes = (a: Uint8Array, ao: number, b: Uint8Array, bo: number): boolean => {
  for (let k = 0; k < ADDRESS_BYTES; k++) if (a[ao + k] !== b[bo + k]) return false;
  return true;
};

/** An open-addressing table of ids (stored id + 1, 0 empty) at most half full; each id's tag kept by its owner. */
class IdTable {
  slots: Int32Array;
  constructor(count = 0) {
    let n = MIN_TABLE;
    while (2 * count > n) n *= 2;
    this.slots = new Int32Array(n);
  }
  /** Puts `id` (the `count`-th) from `tags[id]`; doubles and refills from `tags` when it would pass half full. */
  put(id: number, count: number, tags: Int32Array): void {
    if (2 * count > this.slots.length) {
      let n = this.slots.length;
      while (2 * count > n) n *= 2;
      this.slots = new Int32Array(n);
      for (let k = 0; k < count - 1; k++) this.#slot(k, tags[k]!);
    }
    this.#slot(id, tags[id]!);
  }
  #slot(id: number, tag: number): void {
    const mask = this.slots.length - 1;
    let h = tag & mask;
    while (this.slots[h] !== 0) h = (h + 1) & mask;
    this.slots[h] = id + 1;
  }
}

export class MintIndex {
  // Creators: a list each (first and last entry), as 32 bytes or text, found through `#creatorTable`.
  #creatorBytes = new Uint8Array(0);
  #creatorText = new Map<number, string>();
  #head = new Int32Array(0);
  #tail = new Int32Array(0);
  #lists = 0;
  #creatorTags = new Int32Array(0);
  #creatorTable = new IdTable();
  // Entries: a mint as 32 bytes or text, its time, its next link and its creator's list, found through `#entryTable`.
  #bytes = new Uint8Array(0);
  #text = new Map<number, string>();
  #at = new Float64Array(0);
  #next = new Int32Array(0);
  #owner = new Int32Array(0);
  #count = 0;
  #entryTags = new Int32Array(0);
  #entryTable = new IdTable();

  /** Entries held. */
  get size(): number {
    return this.#count;
  }

  /** The bytes of its typed arrays and the text it keeps as strings (two bytes a character): its footprint, give or take a few objects. */
  heldBytes(): number {
    let text = 0;
    for (const t of this.#text.values()) text += 2 * t.length;
    for (const t of this.#creatorText.values()) text += 2 * t.length;
    return [this.#bytes, this.#at, this.#next, this.#owner, this.#entryTags, this.#creatorBytes, this.#head, this.#tail, this.#creatorTags, this.#entryTable.slots, this.#creatorTable.slots]
      .reduce((n, a) => n + a.byteLength, text);
  }

  /** MEM-PROBE: how many creators hold at least one entry (counted on the typed arrays, no text decoded). */
  get creatorCount(): number {
    let n = 0;
    for (let c = 0; c < this.#lists; c++) if (this.#head[c] !== NONE) n++;
    return n;
  }

  /** Creators with at least one entry, in no set order. */
  *creators(): Generator<string> {
    for (let c = 0; c < this.#lists; c++) if (this.#head[c] !== NONE) yield this.#creatorAt(c);
  }

  has(creator: string): boolean {
    const c = this.#findCreator(creator, toSlot(creator, CREATOR_SCRATCH));
    return c !== NONE && this.#head[c] !== NONE;
  }

  /** A creator's mints and their times, in the order they were first added. */
  *entries(creator: string): Generator<readonly [string, number]> {
    const c = this.#findCreator(creator, toSlot(creator, CREATOR_SCRATCH));
    for (let i = c === NONE ? NONE : this.#head[c]!; i !== NONE; i = this.#next[i]!) yield [this.#mintAt(i), this.#at[i]!] as const;
  }

  /** Room for `entries` more entries and `lists` more creators at once (a restore of a known size): no regrowth. */
  reserve(entries: number, lists: number): void {
    if (this.#count + entries > this.#at.length) this.#growEntries(this.#count + entries);
    if (this.#lists + lists > this.#head.length) this.#growLists(this.#lists + lists);
    const e = new IdTable(this.#count + entries);
    if (e.slots.length > this.#entryTable.slots.length) {
      this.#entryTable = e;
      for (let i = 0; i < this.#count; i++) e.put(i, i + 1, this.#entryTags);
    }
    const c = new IdTable(this.#lists + lists);
    if (c.slots.length > this.#creatorTable.slots.length) {
      this.#creatorTable = c;
      for (let k = 0; k < this.#lists; k++) c.put(k, k + 1, this.#creatorTags);
    }
  }

  /** Live: the same mint added again for its creator keeps its earliest time and its place (O(1)). */
  add(creator: string, mint: string, atMs: number): void {
    this.#add(creator, mint, atMs, false);
  }

  /**
   * A restored row, in order. A creator already held or a mint repeated in the row is refused (fail closed: a saved
   * index never holds either), so the caller discards the file.
   */
  setRow(creator: string, rows: Iterable<readonly [string, number]>): void {
    const cb = toSlot(creator, CREATOR_SCRATCH);
    if (this.#findCreator(creator, cb) !== NONE) throw new RepeatedRowError('a creator row is repeated');
    for (const [mint, at] of rows) this.#add(creator, mint, at, true);
  }

  /** Keeps only entries dated at or after `fromMs`, compacted in place by index, every list in its order. */
  prune(fromMs: number): void {
    let keptEntries = 0;
    let keptLists = 0;
    for (let c = 0; c < this.#lists; c++) {
      let any = false;
      for (let i = this.#head[c]!; i !== NONE; i = this.#next[i]!) if (this.#at[i]! >= fromMs) { keptEntries++; any = true; }
      if (any) keptLists++;
    }
    const bytes = new Uint8Array(keptEntries * ADDRESS_BYTES);
    const at = new Float64Array(keptEntries);
    const next = new Int32Array(keptEntries);
    const owner = new Int32Array(keptEntries);
    const entryTags = new Int32Array(keptEntries);
    const text = new Map<number, string>();
    const creatorBytes = new Uint8Array(keptLists * ADDRESS_BYTES);
    const creatorText = new Map<number, string>();
    const head = new Int32Array(keptLists);
    const tail = new Int32Array(keptLists);
    const creatorTags = new Int32Array(keptLists);
    let n = 0;
    let l = 0;
    for (let c = 0; c < this.#lists; c++) {
      let first = NONE;
      let last = NONE;
      for (let i = this.#head[c]!; i !== NONE; i = this.#next[i]!) {
        if (this.#at[i]! < fromMs) continue;
        const t = this.#text.get(i);
        if (t !== undefined) text.set(n, t);
        else bytes.set(this.#bytes.subarray(i * ADDRESS_BYTES, (i + 1) * ADDRESS_BYTES), n * ADDRESS_BYTES);
        at[n] = this.#at[i]!;
        next[n] = NONE;
        owner[n] = l;
        entryTags[n] = this.#entryTags[i]!;
        if (last === NONE) first = n;
        else next[last] = n;
        last = n;
        n++;
      }
      if (first === NONE) continue;
      const ct = this.#creatorText.get(c);
      if (ct !== undefined) creatorText.set(l, ct);
      else creatorBytes.set(this.#creatorBytes.subarray(c * ADDRESS_BYTES, (c + 1) * ADDRESS_BYTES), l * ADDRESS_BYTES);
      head[l] = first;
      tail[l] = last;
      creatorTags[l] = this.#creatorTags[c]!;
      l++;
    }
    this.#bytes = bytes;
    this.#at = at;
    this.#next = next;
    this.#owner = owner;
    this.#entryTags = entryTags;
    this.#text = text;
    this.#count = n;
    this.#creatorBytes = creatorBytes;
    this.#creatorText = creatorText;
    this.#head = head;
    this.#tail = tail;
    this.#creatorTags = creatorTags;
    this.#lists = l;
    // Both tables refilled from the kept tags, sized once.
    this.#creatorTable = new IdTable(l);
    for (let c = 0; c < l; c++) this.#creatorTable.put(c, c + 1, creatorTags);
    this.#entryTable = new IdTable(n);
    for (let i = 0; i < n; i++) this.#entryTable.put(i, i + 1, entryTags);
  }

  #add(creator: string, mint: string, atMs: number, refuseRepeat: boolean): void {
    const cb = toSlot(creator, CREATOR_SCRATCH);
    const ctag = lastTag;
    let c = this.#findCreator(creator, cb, ctag);
    const mb = toSlot(mint, MINT_SCRATCH);
    const mtag = lastTag;
    if (c !== NONE) {
      const e = this.#findEntry(c, mint, mb, mtag);
      if (e !== NONE) {
        if (refuseRepeat) throw new RepeatedRowError('a mint is repeated in its creator row');
        if (atMs < this.#at[e]!) this.#at[e] = atMs;
        return;
      }
    } else c = this.#newList(creator, cb, ctag);
    const i = this.#push(mint, mb, atMs, c, mtag);
    if (this.#head[c] === NONE) this.#head[c] = i;
    else this.#next[this.#tail[c]!] = i;
    this.#tail[c] = i;
  }

  #findCreator(creator: string, cb: Uint8Array | null, tag = textTag(creator)): number {
    const slots = this.#creatorTable.slots;
    const mask = slots.length - 1;
    const texts = this.#creatorText.size > 0;
    for (let h = tag & mask; ; h = (h + 1) & mask) {
      const v = slots[h]!;
      if (v === 0) return NONE;
      const c = v - 1;
      const t = texts ? this.#creatorText.get(c) : undefined;
      if (t !== undefined || cb === null) {
        if (t === creator) return c;
      } else if (sameBytes(this.#creatorBytes, c * ADDRESS_BYTES, cb, 0)) return c;
    }
  }

  #findEntry(c: number, mint: string, mb: Uint8Array | null, tag: number): number {
    const slots = this.#entryTable.slots;
    const mask = slots.length - 1;
    const texts = this.#text.size > 0;
    for (let h = tag & mask; ; h = (h + 1) & mask) {
      const v = slots[h]!;
      if (v === 0) return NONE;
      const i = v - 1;
      if (this.#owner[i] !== c) continue;
      const t = texts ? this.#text.get(i) : undefined;
      if (t !== undefined || mb === null) {
        if (t === mint) return i;
      } else if (sameBytes(this.#bytes, i * ADDRESS_BYTES, mb, 0)) return i;
    }
  }

  #newList(creator: string, cb: Uint8Array | null, tag: number): number {
    const c = this.#lists++;
    if (c >= this.#head.length) this.#growLists(grown(this.#head.length, c + 1));
    if (cb === null) this.#creatorText.set(c, flatCopy(creator));
    else this.#creatorBytes.set(cb, c * ADDRESS_BYTES);
    this.#head[c] = NONE;
    this.#tail[c] = NONE;
    this.#creatorTags[c] = tag;
    this.#creatorTable.put(c, this.#lists, this.#creatorTags);
    return c;
  }

  #growLists(n: number): void {
    {
      const b = new Uint8Array(n * ADDRESS_BYTES);
      b.set(this.#creatorBytes);
      const h = new Int32Array(n);
      h.set(this.#head);
      const t = new Int32Array(n);
      t.set(this.#tail);
      const g = new Int32Array(n);
      g.set(this.#creatorTags);
      this.#creatorBytes = b;
      this.#head = h;
      this.#tail = t;
      this.#creatorTags = g;
    }
  }

  #push(mint: string, mb: Uint8Array | null, atMs: number, c: number, tag: number): number {
    const i = this.#count++;
    if (i >= this.#at.length) this.#growEntries(grown(this.#at.length, i + 1));
    if (mb === null) this.#text.set(i, flatCopy(mint));
    else this.#bytes.set(mb, i * ADDRESS_BYTES);
    this.#at[i] = atMs;
    this.#next[i] = NONE;
    this.#owner[i] = c;
    this.#entryTags[i] = tag;
    this.#entryTable.put(i, this.#count, this.#entryTags);
    return i;
  }

  #growEntries(n: number): void {
    {
      const b = new Uint8Array(n * ADDRESS_BYTES);
      b.set(this.#bytes);
      const a = new Float64Array(n);
      a.set(this.#at);
      const x = new Int32Array(n);
      x.set(this.#next);
      const o = new Int32Array(n);
      o.set(this.#owner);
      const g = new Int32Array(n);
      g.set(this.#entryTags);
      this.#bytes = b;
      this.#at = a;
      this.#next = x;
      this.#owner = o;
      this.#entryTags = g;
    }
  }

  #creatorAt(c: number): string {
    return this.#creatorText.get(c) ?? fromSlot(this.#creatorBytes, c * ADDRESS_BYTES);
  }

  #mintAt(i: number): string {
    return this.#text.get(i) ?? fromSlot(this.#bytes, i * ADDRESS_BYTES);
  }
}
