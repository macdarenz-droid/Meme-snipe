/**
 * QR encoder for the bot wallet address: byte mode, error correction level M,
 * versions 1 to 6 (up to 106 bytes; a Solana address is at most 44). Written
 * here so the app carries no QR dependency; test/qr.test.ts checks the
 * Reed-Solomon codewords and format bits, and the PR notes an independent
 * decode check. Layout and mask rules follow ISO/IEC 18004.
 */

/** Per version at level M: [blocks, data codewords per block, error codewords per block]. */
const BLOCKS: Record<number, [number, number, number]> = {
  1: [1, 16, 10],
  2: [1, 28, 16],
  3: [1, 44, 26],
  4: [2, 32, 18],
  5: [2, 43, 24],
  6: [4, 27, 16],
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
const MAX_VERSION = 6;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0;
}
const mul = (a: number, b: number) => (a && b ? (EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0) : 0);

/** Generator polynomial of the given degree, highest term first (leading 1 included). */
export function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    poly.forEach((c, j) => {
      next[j] = (next[j] ?? 0) ^ c;
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(c, EXP[i] ?? 0);
    });
    poly = next;
  }
  return poly;
}

/** The error correction codewords for a block of data codewords. */
export function reedSolomon(data: number[], degree: number): number[] {
  const gen = generator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (rem.shift() ?? 0);
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] = (rem[i] ?? 0) ^ mul(gen[i + 1] ?? 0, factor);
  }
  return rem;
}

/** Data and error codewords, interleaved across blocks, for a version's byte-mode payload. */
export function codewords(bytes: number[], version: number): number[] {
  const [blocks, perBlock, ecPer] = BLOCKS[version]!;
  const capacity = blocks * perBlock;
  const bits: number[] = [];
  const push = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const dataBlocks = Array.from({ length: blocks }, (_, i) => data.slice(i * perBlock, (i + 1) * perBlock));
  const ecBlocks = dataBlocks.map((b) => reedSolomon(b, ecPer));
  const out: number[] = [];
  for (let i = 0; i < perBlock; i++) for (const b of dataBlocks) out.push(b[i] ?? 0);
  for (let i = 0; i < ecPer; i++) for (const b of ecBlocks) out.push(b[i] ?? 0);
  return out;
}

/** The 15 format bits for level M and a mask (BCH(15,5), xor 0x5412). Level M is 00. */
export function formatBits(mask: number): number {
  const data = mask; // (level M = 0b00) << 3 | mask
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

export type QrMatrix = boolean[][];

function build(version: number, words: number[], mask: number): QrMatrix {
  const size = 17 + 4 * version;
  const m: QrMatrix = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    const row = m[y];
    const frow = fn[y];
    if (!row || !frow || x < 0 || x >= size) return;
    row[x] = dark;
    frow[x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }
  const pos = ALIGN[version] ?? [];
  pos.forEach((px, i) =>
    pos.forEach((py, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );

  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);

  // Data bits in the zigzag order, masked as they are placed.
  let k = 0;
  const total = words.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (fn[y]?.[x] || k >= total) continue;
        const dark = (((words[k >>> 3] ?? 0) >>> (7 - (k & 7))) & 1) === 1;
        m[y]![x] = dark !== MASKS[mask]!(x, y);
        k++;
      }
    }
  }
  return m;
}

/** Penalty score of the four rules in ISO/IEC 18004 §7.8.3; the lowest score picks the mask. */
export function penalty(m: QrMatrix): number {
  const n = m.length;
  let score = 0;
  const lines = [...m, ...Array.from({ length: n }, (_, x) => m.map((row) => row[x] ?? false))];
  const finder = [true, false, true, true, true, false, true, false, false, false, false];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= n; i++) {
      const w = line.slice(i, i + 11);
      if (w.every((v, j) => v === finder[j]) || w.every((v, j) => v === finder[10 - j])) score += 40;
    }
  }
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const v = m[y]![x];
      if (v === m[y]![x + 1] && v === m[y + 1]![x] && v === m[y + 1]![x + 1]) score += 3;
    }
  }
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
  return score;
}

/** Smallest version at level M that holds the text, or an error if it is too long. */
function versionFor(length: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const [blocks, perBlock] = BLOCKS[v]!;
    if (length <= blocks * perBlock - 2) return v; // 4 + 8 header bits, rounded up, leaves capacity − 2 bytes
  }
  throw new Error(`QR text too long: ${length} bytes, the most is ${(BLOCKS[MAX_VERSION]![0] * BLOCKS[MAX_VERSION]![1]) - 2}`);
}

/** The module grid for the text (true is dark), without the quiet zone. */
export function encodeQr(text: string): QrMatrix {
  const bytes = [...new TextEncoder().encode(text)];
  const version = versionFor(bytes.length);
  const words = codewords(bytes, version);
  let best: QrMatrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(version, words, mask);
    const s = penalty(m);
    if (s < bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best!;
}
