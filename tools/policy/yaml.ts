// A small YAML reader for the policy's workflow checks (GitHub Actions files) and for pnpm's YAML files. It reads the
// block subset workflows use: mappings, sequences (also "- key: value" items), plain, single- and double-quoted
// scalars, block scalars (|, |-, > and >-), one-line flow sequences ([a, 'b']) and comments. Scalars stay strings, as
// GitHub reads them in a workflow; an empty value is null. pnpm-lock.yaml also writes one-line flow mappings of
// scalars ({integrity: sha512-…}, {node: '>=18'}, {}): they are read only when the caller passes `flowMappings`, so a
// workflow with one still fails. Anything else (anchors, aliases, tags, nested flow collections, document markers,
// complex keys, tabs, keep chomping, multi-line plain or quoted scalars, duplicate keys) throws YamlError: the check
// fails closed instead of guessing what GitHub or pnpm would read.

export type YamlValue = string | null | YamlValue[] | YamlMap;
export interface YamlMap { [key: string]: YamlValue }

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

interface Line { indent: number; text: string; no: number }

/** A mapping key: plain (a ":" inside it only when no space follows, as YAML allows: `name@file:dep`), or quoted;
 * followed by ":" and a space or the end of the line. */
const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([A-Za-z0-9_$.](?:[^:'"#]|:(?![\s]|$))*?))\s*:(?:\s+(.*))?$/;
const DOUBLE_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', '0': '\0' };

function unquoteDouble(body: string, no: number): string {
  return body.replace(/\\(.)/g, (_, c: string) => {
    const v = DOUBLE_ESCAPES[c];
    if (v === undefined) throw new YamlError(`unsupported escape \\${c}`, no);
    return v;
  });
}

/** Splits `text` at the end of a leading quoted scalar: [quoted including quotes, rest], or null if unterminated. */
function leadingQuoted(text: string): [string, string] | null {
  const m = text[0] === '"' ? /^"(?:[^"\\]|\\.)*"/.exec(text) : /^'(?:[^']|'')*'/.exec(text);
  return m ? [m[0], text.slice(m[0].length)] : null;
}

/** A value with its trailing comment removed; a quoted or flow value keeps "#" inside its quotes. */
function stripComment(value: string, no: number): string {
  const v = value.trim();
  if (v.startsWith('#')) return '';
  let head = '';
  let rest = v;
  if (v[0] === '"' || v[0] === "'") {
    const q = leadingQuoted(v);
    if (q === null) throw new YamlError('unterminated quoted scalar', no);
    [head, rest] = q;
  } else if (v[0] === '[' || v[0] === '{') {
    const close = v[0] === '[' ? ']' : '}';
    let i = 1;
    while (i < v.length && v[i] !== close) {
      if (v[i] === '"' || v[i] === "'") {
        const q = leadingQuoted(v.slice(i));
        if (q === null) throw new YamlError('unterminated quoted scalar', no);
        i += q[0].length;
      } else {
        i++;
      }
    }
    head = v.slice(0, i + 1);
    rest = v.slice(i + 1);
  }
  const hash = rest.search(/(^|\s)#/);
  return `${head}${hash < 0 ? rest : rest.slice(0, hash)}`.trim();
}

function scalar(text: string, no: number): string {
  if (text[0] === '"') return unquoteDouble(text.slice(1, -1), no);
  if (text[0] === "'") return text.slice(1, -1).replace(/''/g, "'");
  if (/^[&*!%@`{|>?]/.test(text) || text === '---' || text === '...') throw new YamlError(`unsupported YAML construct "${text[0] as string}"`, no);
  if (/:(\s|$)/.test(text)) throw new YamlError('a plain scalar may not contain ": "', no);
  return text;
}

export interface YamlOptions { flowMappings?: boolean }

/** Splits the body of a one-line flow mapping at its top-level commas; a comma inside quotes stays in its item. */
function flowItems(body: string, no: number): string[] {
  const items: string[] = [];
  let item = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (quote === null && c === ',') {
      items.push(item);
      item = '';
      continue;
    }
    if (quote === null && (c === '"' || c === "'")) quote = c;
    else if (quote === '"' && c === '\\') { item += c + (body[i + 1] ?? ''); i++; continue; }
    else if (c === quote) {
      if (quote === "'" && body[i + 1] === "'") { item += "''"; i++; continue; }
      quote = null;
    }
    item += c;
  }
  if (quote !== null) throw new YamlError('unterminated quoted scalar', no);
  items.push(item);
  const trimmed = items.map((x) => x.trim());
  if (trimmed.length === 1 && trimmed[0] === '') return [];
  if (trimmed.some((x) => x === '')) throw new YamlError('empty flow collection item', no);
  return trimmed;
}

class Parser {
  private pos = 0;
  private readonly lines: Line[];
  private readonly raw: string[];
  private readonly flowMappings: boolean;

  constructor(text: string, options: YamlOptions = {}) {
    this.flowMappings = options.flowMappings === true;
    this.raw = text.split('\n').map((l) => l.replace(/\r$/, ''));
    this.lines = this.raw.map((l, i) => {
      const indent = l.length - l.trimStart().length;
      if (/\t/.test(l.slice(0, indent))) throw new YamlError('tab in indentation', i + 1);
      return { indent, text: l.slice(indent), no: i + 1 };
    });
  }

  /** The next line with content, skipping blank and comment-only lines; null at the end. */
  private peek(): Line | null {
    while (this.pos < this.lines.length) {
      const l = this.lines[this.pos] as Line;
      if (l.text !== '' && !l.text.startsWith('#')) return l;
      this.pos++;
    }
    return null;
  }

  parseDocument(): YamlValue {
    const first = this.peek();
    if (first === null) return null;
    const value = this.node(first.indent);
    const extra = this.peek();
    if (extra !== null) throw new YamlError('unexpected content (bad indentation?)', extra.no);
    return value;
  }

  /** The block node starting at the next line, whose indent is `indent`. */
  private node(indent: number): YamlValue {
    const l = this.peek() as Line;
    return l.text === '-' || l.text.startsWith('- ') ? this.sequence(indent) : this.mapping(indent);
  }

  /** The value of a key or item with nothing after it on its line: a nested block, or null. */
  private nested(parentIndent: number, allowSequenceAtSameIndent: boolean): YamlValue {
    const l = this.peek();
    if (l === null) return null;
    if (l.indent > parentIndent) return this.node(l.indent);
    if (allowSequenceAtSameIndent && l.indent === parentIndent && (l.text === '-' || l.text.startsWith('- '))) return this.sequence(l.indent);
    return null;
  }

  private sequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (let l = this.peek(); l !== null && l.indent === indent && (l.text === '-' || l.text.startsWith('- ')); l = this.peek()) {
      const rest = l.text.slice(1).trimStart();
      if (rest === '' || rest.startsWith('#')) {
        this.pos++;
        items.push(this.nested(indent, false));
      } else if (KEY.test(rest)) {
        const itemIndent = indent + (l.text.length - rest.length);
        this.lines[this.pos] = { indent: itemIndent, text: rest, no: l.no };   // "- key: v" opens a mapping at that column
        items.push(this.mapping(itemIndent));
      } else {
        this.pos++;
        items.push(this.value(stripComment(rest, l.no), indent, l.no));
      }
    }
    return items;
  }

  private mapping(indent: number): YamlMap {
    const map: YamlMap = Object.create(null) as YamlMap;
    for (let l = this.peek(); l !== null && l.indent === indent && !(l.text === '-' || l.text.startsWith('- ')); l = this.peek()) {
      const m = KEY.exec(l.text);
      if (!m) throw new YamlError('expected "key: value"', l.no);
      const key = m[1] !== undefined ? unquoteDouble(m[1], l.no) : m[2] !== undefined ? m[2].replace(/''/g, "'") : (m[3] as string).trimEnd();
      if (Object.hasOwn(map, key)) throw new YamlError(`duplicate key "${key}"`, l.no);
      this.pos++;
      const rest = stripComment(m[4] ?? '', l.no);
      map[key] = rest === '' ? this.nested(indent, true) : this.value(rest, indent, l.no);
    }
    return map;
  }

  /** An inline value (comment already removed): block scalar, flow sequence, quoted or plain scalar. */
  private value(text: string, parentIndent: number, no: number): YamlValue {
    const block = /^([|>])(-?)$/.exec(text);
    if (block) return this.blockScalar(block[1] as string, block[2] as string, parentIndent);
    if (text.startsWith('{') && this.flowMappings) return this.flowMapping(text, no);
    if (text.startsWith('[')) {
      if (!text.endsWith(']')) throw new YamlError('a flow sequence must end on its line', no);
      const body = text.slice(1, -1).trim();
      if (body === '') return [];
      const items: string[] = [];
      let rest = body;
      while (rest !== '') {
        const q = rest[0] === '"' || rest[0] === "'" ? leadingQuoted(rest) : null;
        const end = q ? q[0].length : rest.search(/,|$/);
        const item = rest.slice(0, end).trim();
        if (item === '' || item.startsWith('[')) throw new YamlError('unsupported flow sequence item', no);
        items.push(scalar(item, no));
        rest = rest.slice(end).trim();
        if (rest.startsWith(',')) rest = rest.slice(1).trim();
        else if (rest !== '') throw new YamlError('expected "," in a flow sequence', no);
      }
      return items;
    }
    if ((text[0] === '"' || text[0] === "'") && leadingQuoted(text)?.[1] !== '') throw new YamlError('unterminated or multi-line quoted scalar', no);
    return scalar(text, no);
  }

  /** A one-line flow mapping of scalars: {a: b, 'c': "d"}; {} is an empty mapping. */
  private flowMapping(text: string, no: number): YamlMap {
    if (!text.endsWith('}')) throw new YamlError('a flow mapping must end on its line', no);
    const map: YamlMap = Object.create(null) as YamlMap;
    for (const item of flowItems(text.slice(1, -1), no)) {
      const m = KEY.exec(item);
      if (!m || m[4] === undefined) throw new YamlError('expected "key: value" in a flow mapping', no);
      const key = m[1] !== undefined ? unquoteDouble(m[1], no) : m[2] !== undefined ? m[2].replace(/''/g, "'") : (m[3] as string).trimEnd();
      if (Object.hasOwn(map, key)) throw new YamlError(`duplicate key "${key}"`, no);
      const value = m[4].trim();
      if (/^[[{]/.test(value)) throw new YamlError('nested flow collections are not supported', no);
      if ((value[0] === '"' || value[0] === "'") && leadingQuoted(value)?.[1] !== '') throw new YamlError('unterminated quoted scalar', no);
      map[key] = scalar(value, no);
    }
    return map;
  }

  /** Lines indented more than the parent (blank lines included), up to the first line that is not. */
  private blockScalar(style: string, chomp: string, parentIndent: number): string {
    const body: string[] = [];
    let indent = -1;
    while (this.pos < this.raw.length) {
      const raw = this.raw[this.pos] as string;
      const l = this.lines[this.pos] as Line;
      if (l.text !== '') {
        if (l.indent <= parentIndent || (indent >= 0 && l.indent < indent)) break;
        if (indent < 0) indent = l.indent;
      }
      body.push(raw.slice(Math.max(indent, 0)));
      this.pos++;
    }
    while (body.length > 0 && (body[body.length - 1] as string).trim() === '') body.pop();
    if (body.length === 0) return '';
    const text = style === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    return chomp === '-' ? text : `${text}\n`;
  }
}

export function parseYaml(text: string, options: YamlOptions = {}): YamlValue {
  return new Parser(text, options).parseDocument();
}
