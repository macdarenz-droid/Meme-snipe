// Token-based scan for money amounts written into code. Comments are skipped, strings and numbers are read as tokens, so
// formatting, digit separators, hex, exponents and wrapper calls do not hide a literal.

export interface Token {
  readonly kind: 'num' | 'str' | 'id' | 'punct' | 'regex';
  readonly text: string;
  readonly line: number;
  /** A template literal with `${}` in it: its text is not a constant. */
  readonly dynamic?: true;
}

const NUMBER = /0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?/y;
const IDENT = /[A-Za-z_$][\w$]*/y;

/** Decodes \xNN, \uNNNN and \u{N} escapes, so an escaped digit cannot hide a number inside a string. */
export const decodeEscapes = (raw: string): string =>
  raw
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\n/g, '');

/** A "/" starts a regular expression (not a division) after these. */
const REGEX_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do']);

export const tokenize = (src: string): Token[] => {
  const tokens: Token[] = [];
  let line = 1;
  const scan = (start: number, inExpr: boolean): number => {
    let i = start;
    let depth = 0;
    while (i < src.length) {
      const c = src[i] as string;
      if (c === '\n') { line++; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
        continue;
      }
      if (c === '/') {
        const last = tokens[tokens.length - 1];
        if (!last || (last.kind === 'punct' && REGEX_AFTER_PUNCT.has(last.text)) || (last.kind === 'id' && REGEX_AFTER_WORD.has(last.text))) {
          let j = i + 1;
          let inClass = false;
          while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
            if (src[j] === '\\') j++;
            else if (src[j] === '[') inClass = true;
            else if (src[j] === ']') inClass = false;
            j++;
          }
          j++;
          while (/[a-z]/i.test(src[j] ?? '')) j++;
          tokens.push({ kind: 'regex', text: src.slice(i, j), line });
          i = j;
          continue;
        }
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
        tokens.push({ kind: 'str', text: decodeEscapes(src.slice(i + 1, j)), line });
        i = j + 1;
        continue;
      }
      if (c === '`') {
        let j = i + 1;
        let text = '';
        let dynamic = false;
        const at = tokens.length;
        const startLine = line;
        while (j < src.length && src[j] !== '`') {
          if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; continue; }
          if (src[j] === '$' && src[j + 1] === '{') { dynamic = true; j = scan(j + 2, true); continue; }
          if (src[j] === '\n') line++;
          text += src[j];
          j++;
        }
        tokens.splice(at, 0, { kind: 'str', text: decodeEscapes(text), line: startLine, ...(dynamic ? { dynamic: true as const } : {}) });
        i = j + 1;
        continue;
      }
      if (inExpr) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) return i + 1; depth--; }
      }
      if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(src);
        if (m) { tokens.push({ kind: 'num', text: m[0], line }); i += m[0].length; continue; }
      }
      IDENT.lastIndex = i;
      const id = IDENT.exec(src);
      if (id) { tokens.push({ kind: 'id', text: id[0], line }); i += id[0].length; continue; }
      tokens.push({ kind: 'punct', text: c, line });
      i++;
    }
    return i;
  };
  scan(0, false);
  return tokens;
};

const THRESHOLD = 1000n;
const UNIT_CONSTANTS = new Set(['MICRO_PER_USD', 'LAMPORTS_PER_SOL']);
const MONEY_CTORS = new Set(['usd', 'sol', 'microUsd', 'lamports']);
const NUMBER_READERS = new Set(['BigInt', 'Number', 'parseInt', 'parseFloat']);

/** Value of a numeric literal in any form (decimal, hex, binary, octal, exponent, separators, bigint suffix). */
export const literalValue = (text: string): number | bigint => {
  const t = text.replace(/_/g, '');
  return t.endsWith('n') ? BigInt(t.slice(0, -1)) : Number(t);
};
const atLeast = (v: number | bigint): boolean => (typeof v === 'bigint' ? v >= THRESHOLD : v >= Number(THRESHOLD));

/** Value of a string that reads as a number ("5000000", "5e6", "0x4C4B40", "1,000"), else null. */
export const stringNumber = (text: string): number | null => {
  const t = text.replace(/[_,\s]/g, '');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$|^0[xX][0-9a-fA-F]+$/.test(t)) return null;
  return Number(t);
};

export interface Finding {
  readonly line: number;
  readonly why: string;
  readonly text: string;
  /** Set when the literal is the whole initializer of a named declaration: `const NAME = <literal>`. */
  readonly declares?: { readonly name: string; readonly value: string };
}

const FOLLOWERS = new Set([';', 'as', ',', '}', ')']);

/** Name of the declaration, property or default parameter that the literal alone initializes, if any. */
const declarationOf = (tokens: readonly Token[], at: number): Finding['declares'] => {
  const lead = tokens[at - 1];
  const next = tokens[at + 1];
  if (next && !FOLLOWERS.has(next.text)) return undefined;
  const value = String(literalValue((tokens[at] as Token).text));
  if (lead?.text === ':' && tokens[at - 2]?.kind === 'id') return { name: (tokens[at - 2] as Token).text, value };
  if (lead?.text !== '=') return undefined;
  for (let k = at - 2; k >= Math.max(0, at - 12); k--) {
    const t = tokens[k] as Token;
    if (t.text === ';' || t.text === '{' || t.text === '}') break;
    if (t.kind === 'id' && ['const', 'let', 'var', 'readonly'].includes(tokens[k - 1]?.text ?? '')) return { name: t.text, value };
  }
  return tokens[at - 2]?.kind === 'id' ? { name: (tokens[at - 2] as Token).text, value } : undefined;
};

/** Every money amount written in the source: numbers of 1,000 or more in any form, numeric strings, money constructors. */
export const findMoneyLiterals = (source: string): Finding[] => {
  const tokens = tokenize(source);
  const out: Finding[] = [];
  tokens.forEach((tok, i) => {
    const prev = tokens[i - 1];
    const prev2 = tokens[i - 2];
    if (tok.kind === 'num') {
      if (atLeast(literalValue(tok.text))) {
        const declares = declarationOf(tokens, i);
        out.push({ line: tok.line, why: `number ${tok.text} is 1,000 or more`, text: tok.text, ...(declares ? { declares } : {}) });
      }
    }
    if (tok.kind === 'str' && !tok.dynamic) {
      if (/\$\s?\d|\d\s*(?:SOL|USDC?|lamports)\b/i.test(tok.text)) out.push({ line: tok.line, why: 'money amount in text', text: tok.text });
      if (prev?.text === '(' && prev2?.kind === 'id' && NUMBER_READERS.has(prev2.text)) {
        const v = stringNumber(tok.text);
        if (v !== null && v >= Number(THRESHOLD)) out.push({ line: tok.line, why: `${prev2.text}("${tok.text}") reads a number of 1,000 or more`, text: tok.text });
      }
    }
    if ((tok.kind === 'num' || (tok.kind === 'str' && !tok.dynamic)) && prev?.text === '(' && prev2?.kind === 'id' && MONEY_CTORS.has(prev2.text)) {
      const after = tokens[i + 1]?.text;
      const isZero = tok.kind === 'num' ? literalValue(tok.text) == 0 : stringNumber(tok.text) === 0;
      if ((after === ')' || after === ',') && !isZero) out.push({ line: tok.line, why: `${prev2.text}() built from the literal ${tok.text}`, text: tok.text });
    }
    // `BigInt(` / `Number(` / money constructors wrapping a flagged literal are already caught by the number check;
    // a `**` or `<<` power is not: flag `10 ** 6`-style scale factors written as powers of a literal.
    if (tok.kind === 'punct' && tok.text === '*' && tokens[i + 1]?.text === '*' && prev?.kind === 'num' && tokens[i + 2]?.kind === 'num') {
      const v = Number(literalValue(prev.text)) ** Number(literalValue((tokens[i + 2] as Token).text));
      if (v >= Number(THRESHOLD)) out.push({ line: tok.line, why: `power ${prev.text} ** ${(tokens[i + 2] as Token).text} is 1,000 or more`, text: prev.text });
    }
  });
  return out.concat(smallLiteralsNextToUnits(tokens));
};

const isZero = (t: Token): boolean => literalValue(t.text) == 0;

/**
 * "2n * MICRO_PER_USD" is $2 and "lamports(5 + x)" builds money: any nonzero numeric literal in the same statement as a unit
 * constant, or inside the brackets of a money constructor call, is a money amount written as a small number.
 */
const smallLiteralsNextToUnits = (tokens: readonly Token[]): Finding[] => {
  const out: Finding[] = [];
  const flagged = new Set<number>();
  const flag = (k: number, why: string): void => {
    const t = tokens[k] as Token;
    if (t.kind !== 'num' || isZero(t) || flagged.has(k)) return;
    flagged.add(k);
    out.push({ line: t.line, why: `${why}: literal ${t.text}`, text: t.text });
  };
  let start = 0;
  for (let k = 0; k <= tokens.length; k++) {
    const t = tokens[k];
    if (k < tokens.length && !(t?.kind === 'punct' && (t.text === ';' || t.text === '{' || t.text === '}'))) continue;
    const span = tokens.slice(start, k);
    const declares = (name: string): boolean => span.some((x, n) => x.text === name && ['const', 'let', 'var', 'readonly'].includes(span[n - 1]?.text ?? ''));
    const unit = span.find((x) => x.kind === 'id' && UNIT_CONSTANTS.has(x.text) && !declares(x.text));
    if (unit) for (let n = start; n < k; n++) flag(n, `number written next to ${unit.text}`);
    start = k + 1;
  }
  tokens.forEach((t, k) => {
    if (t.kind !== 'id' || !MONEY_CTORS.has(t.text) || tokens[k + 1]?.text !== '(') return;
    let depth = 0;
    for (let n = k + 1; n < tokens.length; n++) {
      const x = tokens[n] as Token;
      if (x.text === '(') depth++;
      else if (x.text === ')' && --depth === 0) break;
      else flag(n, `${t.text}() with a number inside`);
    }
  });
  return out;
};
