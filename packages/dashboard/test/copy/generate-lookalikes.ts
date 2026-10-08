// Generates lookalikes.ts, the copy guard's look-alike letter tables (Z05 rounds 3 to 5, rulings 14, 17, 20 and 21), from
// two Unicode 18.0.0 files kept next to it in unicode/:
//   confusables.txt (UTS #39 18.0.0, https://www.unicode.org/Public/18.0.0/security/confusables.txt)
//   UnicodeData.txt (UCD 18.0.0, https://www.unicode.org/Public/18.0.0/ucd/UnicodeData.txt)
// Both are checked against the sha256 below before anything is generated, so the tables can only come from those files.
//   node test/copy/generate-lookalikes.ts   rewrites test/copy/lookalikes.ts
// test/copy/lookalikes.test.ts checks that the committed table equals this generator's output.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNICODE_DIR = fileURLToPath(new URL('./unicode/', import.meta.url));
export const LOOKALIKES_FILE = fileURLToPath(new URL('./lookalikes.ts', import.meta.url));

/** The sha256 of each input file, as downloaded from unicode.org on 2026-10-08. */
export const INPUT_SHA256: Readonly<Record<'confusables.txt' | 'UnicodeData.txt', string>> = {
  'confusables.txt': '6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92',
  'UnicodeData.txt': '0736451de439ae7baf1425136617da495e09ee5afbe6e394374db7009ea08950',
};

const isLetter = (cp: number): boolean => (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
const isCherokeeCapital = (cp: number): boolean => cp >= 0x13a0 && cp <= 0x13f5;

/** Every non-ASCII single code point whose confusable skeleton is one Latin letter. */
function singleLetterSkeletons(confusables: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of confusables.replace(/^\uFEFF/, '').split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const [src, tgt] = line.split(';', 3).map((f) => f.trim().split(/\s+/).map((x) => parseInt(x, 16)));
    if (src?.length !== 1 || tgt?.length !== 1) continue;
    const [s] = src as [number];
    const [t] = tgt as [number];
    if (s > 0x7f && isLetter(t)) out.set(s, String.fromCodePoint(t));
  }
  return out;
}

/** Every code point whose confusable skeleton is the apostrophe U+0027 (Z05 round 5, ruling 21). */
function apostropheSkeletons(confusables: string): number[] {
  const out: number[] = [];
  for (const line of confusables.replace(/^\uFEFF/, '').split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const [src, tgt] = line.split(';', 3).map((f) => f.trim().split(/\s+/).map((x) => parseInt(x, 16)));
    if (src?.length === 1 && tgt?.length === 1 && tgt[0] === 0x27) out.push(src[0] as number);
  }
  return out.sort((a, b) => a - b);
}

/** UnicodeData.txt fields by code point: the name (field 1) and the simple lowercase mapping (field 13). */
function unicodeData(text: string): Map<number, { name: string; lower: number | null }> {
  const out = new Map<number, { name: string; lower: number | null }>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const f = line.split(';');
    const lower = f[13] ?? '';
    out.set(parseInt(f[0] ?? '', 16), { name: f[1] ?? '', lower: lower === '' ? null : parseInt(lower, 16) });
  }
  return out;
}

function entries(map: ReadonlyMap<number, string>): string[] {
  return [...map].sort((a, b) => a[0] - b[0]).map(([cp, t]) => `'\\u{${cp.toString(16).toUpperCase()}}': '${t}',`);
}

/** Entries joined into lines of at most 118 characters, two spaces in. */
function wrap(items: readonly string[]): string {
  const lines: string[] = [];
  let line = ' ';
  for (const item of items) {
    if (line.length + 1 + item.length > 118) { lines.push(line); line = ' '; }
    line += ` ${item}`;
  }
  lines.push(line);
  return lines.join('\n');
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Reads both inputs from `dir`, refusing any whose sha256 differs from INPUT_SHA256. */
export function readInputs(dir: string = UNICODE_DIR): { confusables: string; unicodeData: string } {
  const read = (name: keyof typeof INPUT_SHA256): string => {
    const bytes = readFileSync(resolve(dir, name));
    const got = sha256(bytes);
    if (got !== INPUT_SHA256[name]) throw new Error(`${name}: sha256 ${got}, expected ${INPUT_SHA256[name]}`);
    return bytes.toString('utf8');
  };
  return { confusables: read('confusables.txt'), unicodeData: read('UnicodeData.txt') };
}

/** The text of lookalikes.ts generated from the two input files. */
export function generateLookalikes(confusables: string, unicodeDataText: string): string {
  const generated = singleLetterSkeletons(confusables);
  const ucd = unicodeData(unicodeDataText);
  // The small letter of each Cherokee capital above that confusables.txt lists without a skeleton of its own.
  const cherokee = new Map<number, string>();
  for (const [cp, t] of generated) {
    const lower = isCherokeeCapital(cp) ? ucd.get(cp)?.lower ?? null : null;
    if (lower !== null && !generated.has(lower)) cherokee.set(lower, t.toLowerCase());
  }
  // Latin small capitals named by one letter that confusables.txt gives no single-letter skeleton.
  const small = new Map<number, string>();
  for (const [cp, { name }] of ucd) {
    const m = /^LATIN (?:CAPITAL )?LETTER SMALL CAPITAL ([A-Z])$/.exec(name);
    if (m !== null && !generated.has(cp)) small.set(cp, (m[1] as string).toLowerCase());
  }
  const apostrophes = apostropheSkeletons(confusables).map((cp) => `'\\u{${cp.toString(16).toUpperCase()}}',`);
  const lOrI = [...generated].filter(([, t]) => t === 'l').map(([cp]) => cp).sort((a, b) => a - b)
    .map((cp) => `'\\u{${cp.toString(16).toUpperCase()}}',`);
  return `// Look-alike letters for the copy guard (Z05 rounds 3 to 5, rulings 14, 17, 20 and 21). Generated by
// generate-lookalikes.ts from Unicode's confusables.txt (UTS #39, version 18.0.0, dated 2026-08-06, sha256
// ${INPUT_SHA256['confusables.txt']}) and UnicodeData.txt (UCD 18.0.0, sha256
// ${INPUT_SHA256['UnicodeData.txt']}). Escapes only, so the file shows which code point each entry is.
// Do not edit by hand: run \`node test/copy/generate-lookalikes.ts\`.

/** Every non-ASCII code point whose confusable skeleton in confusables.txt is one Latin letter (${generated.size} entries). */
export const GENERATED_LOOKALIKE: Readonly<Record<string, string>> = {
${wrap(entries(generated))}
};

/**
 * The Cherokee small letter (UnicodeData.txt's lowercase mapping) of each Cherokee capital above that confusables.txt
 * lists without its small form (Z05 round 3, ruling 14): each reads as the capital's letter in lowercase.
 */
export const CHEROKEE_SMALL: Readonly<Record<string, string>> = {
${wrap(entries(cherokee))}
};

/**
 * Latin small capitals named by one letter in UnicodeData.txt ("LATIN LETTER SMALL CAPITAL F", "LATIN CAPITAL LETTER
 * SMALL CAPITAL I") that confusables.txt gives no single-letter skeleton (Z05 round 3, ruling 14): each reads as its
 * lowercase letter.
 */
export const SMALL_CAPITALS: Readonly<Record<string, string>> = {
${wrap(entries(small))}
};

/**
 * The code points in GENERATED_LOOKALIKE whose skeleton is \`l\`. UTS #39 gives capital I and small l the same skeleton, so
 * each of these is read both as \`l\` and as \`I\` (\`ꓮꓲ\` must read as AI).
 */
export const L_OR_I: ReadonlySet<string> = new Set([
${wrap(lOrI)}
]);

/** Every code point whose confusable skeleton is the apostrophe (Z05 round 5, ruling 21): each reads as \`'\`. */
export const APOSTROPHE: ReadonlySet<string> = new Set([
${wrap(apostrophes)}
]);
`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { confusables, unicodeData: ucd } = readInputs();
  writeFileSync(LOOKALIKES_FILE, generateLookalikes(confusables, ucd));
}
