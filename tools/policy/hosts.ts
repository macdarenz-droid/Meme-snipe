// No request to a pump.fun-operated host (owner rule A02, research addendum, adopted in docs/MIGRATION.md "Research
// addendum": "A CI check fails on any pump.fun-operated host in bot or research code (pinned IDLs on GitHub and SDK
// test oracles from npm are not pump.fun hosts)"). The pump.fun Terms §21(h) question is open with the owner; the rule
// is no new pump.fun request from any module, script or test.
//
// What counts as a pump.fun-operated host: the domain pump.fun and every subdomain of it (the API and image hosts,
// written here as frontend-api.pump[.]fun and images.pump[.]fun so this file does not match itself). No verified
// list of other domains pump.fun operates was available, so none is listed; a new one is added here in review.
// Third parties that serve pump.fun data (PumpPortal, RPC providers, GitHub, npm) are not pump.fun-operated hosts.
//
// Where (supervisor ruling 3.2, round 2 review R2-3 and red team RT2-02): every text file, whatever its name or
// extension (.go, .rs, .rb, .service, .timer, .conf, .ini, .sql, .html, any *.env, extension-less scripts, …). Skipped
// only: binaries and images, that is a binary extension AND binary content (a NUL byte in the first 8,000 bytes or the
// format's magic number; ruling 7.1). A binary-named file that holds text, and a NUL byte in any other file, is
// E_BINARY_SOURCE and the file is still read as text (rulings 5.1, 6.1, 7.1). A binary file is still searched, as
// latin1 bytes, for the domain written literally (ruling 7.1b). A new compressed archive is refused unless
// ARCHIVE_FILES names it with its reason (E_ARCHIVE, ruling 7.1c).
// Markdown anywhere, files under docs/ that are not code (code there is read: a code extension, or a `#!` first line),
// and the evidence files of EVIDENCE_FILES,
// each named with its reason. A file that is old Zeroed code is read only on the lines it gained since
// merge-base(base, HEAD) (ruling 3.1, scope.ts safetyLinesOf), so an edit to one is checked and its old lines stay
// quiet. The policy fixtures are data.
//
// What: a pump.fun host written as a request target:
// - after `//` (a URL, any scheme, or a protocol-relative URL): https: // frontend-api.pump[.]fun/coins without the gaps;
// - any subdomain of pump.fun anywhere (frontend-api.pump[.]fun in a host or header field), with or without a trailing
//   dot;
// - the bare domain where a host is written, in any letter case: after a quote or backtick, after `=`, after `: ` or at
//   the start of a line, and ending there (a quote, `/`, `:`, `?`, `#`, a comma or the end of the line);
// - the bare domain after whitespace when a `/` follows (a path on it: pump[.]fun/api/coins), and as an argument of
//   curl or wget (red team RT2-02: `curl -s pump[.]fun/api/coins` and `wget pump[.]fun` passed before);
// - ruling 5.4 (red team RT3-04): with any whitespace around `=` and `:`, followed by `;`, `)`, whitespace or `:port`
//   too, and as any argument in files whose lines run as shell commands (`nc`, `openssl s_client -connect`, `H=…;`).
//   These wider forms are read with comments taken off the line, and whitespace after the domain counts there only
//   when the value ends (ruling 6.5), so prose that starts with the venue's name is not a host. Every form is also read
//   on the line as decodeEscapes reads it: escapes, HTML references, NFKC and the CJK full stops (rulings 5.4, 6.2).
// - ruling 7.3 (red team RT5-03): `:` starts a value only after a key (at the start of a line, after a list dash, `{`
//   or `,`), not inside a string (a log message "venue: pump[.]fun"); a shell argument inside a quoted string that
//   holds other words is prose (echo "checking pump[.]fun now").
// - ruling 7.2 (red team RT5-02): a line ending in `\` is read joined with the next, and the lines of a YAML folded
//   (`>`) block are read joined, so a host split over two lines is read whole; each line is read on its own too.
//
// Threat model (ruling 7.0): this check is a tripwire for literal pump.fun-operated hosts, and their common encodings,
// in committed files. It is not a sandbox: a host built on purpose at run time (joined strings, computed or downloaded
// text, a compressed payload) is outside any static check, and review and the red team cover it.
// A Markdown-style link label ([Pump[.]fun](url)) in a string is prose, so a bracket is not one of these positions. The
// venue's name in prose or comments ("the pump.fun bonding curve", the on-chain program) is not a target, because
// words follow it on the line; a quoted label (Pump[.]fun on its own inside quotes) in a scanned file is, so a
// user-facing label is written another way there. A host assembled at run time from pieces (`'pump' + '.fun'`) is not
// found: review catches that. Red team RT-04 closed earlier forms: a trailing dot, upper case in the bare domain, and
// the bare domain as a YAML or .env value.
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DATA_DIRS } from './config.ts';
import { finding, type Finding } from './finding.ts';
import { safetyLinesOf, type SafetyLines } from './scope.ts';

/**
 * Binary formats. A file is binary only when its extension is one of these AND its content is binary (binaryContent): a
 * NUL byte in any other file, or text under one of these names, is E_BINARY_SOURCE and the file is read as text (red
 * team RT3-01, RT4-01, RT5-01; rulings 5.1, 6.1, 7.1). SVG is XML text, so it is not here and is read.
 */
export const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif', '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.tar', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.webm', '.wasm', '.node', '.so', '.dylib', '.dll',
  '.exe', '.bin', '.db', '.db-shm', '.db-wal', '.sqlite', '.sqlite3', '.parquet', '.jar', '.class', '.pyc', '.keystore', '.jks',
  '.zst', '.zstd', '.lz4', '.br', '.whl', '.war', '.ear', '.egg', '.rar', '.apk', '.aar', '.nupkg',
];
/** Compressed archives: a new one is refused unless ARCHIVE_FILES names it with its reason (ruling 7.1c). */
export const ARCHIVE_EXTENSIONS = ['.zip', '.jar', '.war', '.ear', '.whl', '.egg', '.apk', '.aar', '.nupkg', '.gz', '.tgz', '.bz2', '.xz',
  '.7z', '.tar', '.rar', '.zst', '.zstd', '.lz4', '.br'];
/**
 * Archives a pull request may add, one by one, each with its reason (ruling 7.1c). An archive's content is not read, so
 * each one is a reviewed exception; adding a file here is a change to a guarded file, so it needs the review label. The
 * archives the tree holds today are all old Zeroed files.
 */
export const ARCHIVE_FILES: Readonly<Record<string, string>> = {};

const ZIP = ['PK\x03\x04', 'PK\x05\x06', 'PK\x07\x08'];
const MACH_O = ['\xfe\xed\xfa\xce', '\xfe\xed\xfa\xcf', '\xce\xfa\xed\xfe', '\xcf\xfa\xed\xfe', '\xca\xfe\xba\xbe'];
/**
 * Magic numbers by extension, as latin1 strings: [offset, bytes]. An extension without one (.bin, .db-shm, .br) is
 * binary only with a NUL byte in its first 8,000 bytes.
 */
const MAGIC: Readonly<Record<string, ReadonlyArray<readonly [number, string]>>> = {
  '.png': [[0, '\x89PNG\r\n\x1a\n']], '.jpg': [[0, '\xff\xd8\xff']], '.jpeg': [[0, '\xff\xd8\xff']], '.gif': [[0, 'GIF87a'], [0, 'GIF89a']],
  '.webp': [[8, 'WEBP']], '.bmp': [[0, 'BM']], '.avif': [[4, 'ftyp']], '.pdf': [[0, '%PDF-']], '.gz': [[0, '\x1f\x8b']], '.tgz': [[0, '\x1f\x8b']],
  '.bz2': [[0, 'BZh']], '.xz': [[0, '\xfd7zXZ\x00']], '.7z': [[0, '7z\xbc\xaf\x27\x1c']], '.tar': [[257, 'ustar']], '.rar': [[0, 'Rar!\x1a\x07']],
  '.woff': [[0, 'wOFF']], '.woff2': [[0, 'wOF2']], '.ttf': [[0, '\x00\x01\x00\x00'], [0, 'true']], '.otf': [[0, 'OTTO']],
  '.mp3': [[0, 'ID3'], [0, '\xff\xfb'], [0, '\xff\xf3'], [0, '\xff\xf2']], '.mp4': [[4, 'ftyp']], '.mov': [[4, 'ftyp']], '.webm': [[0, '\x1a\x45\xdf\xa3']],
  '.wasm': [[0, '\x00asm']], '.node': [[0, '\x7fELF'], ...MACH_O.map((m) => [0, m] as const), [0, 'MZ']], '.so': [[0, '\x7fELF']],
  '.dylib': MACH_O.map((m) => [0, m] as const), '.dll': [[0, 'MZ']], '.exe': [[0, 'MZ']],
  '.db': [[0, 'SQLite format 3\x00']], '.sqlite': [[0, 'SQLite format 3\x00']], '.sqlite3': [[0, 'SQLite format 3\x00']],
  '.db-wal': [[0, '\x37\x7f\x06\x82'], [0, '\x37\x7f\x06\x83']], '.parquet': [[0, 'PAR1']], '.class': [[0, '\xca\xfe\xba\xbe']],
  '.pyc': [[2, '\r\n']], '.keystore': [[0, '\xfe\xed\xfe\xed'], [0, '\x30\x82']], '.jks': [[0, '\xfe\xed\xfe\xed']],
  '.zst': [[0, '\x28\xb5\x2f\xfd']], '.zstd': [[0, '\x28\xb5\x2f\xfd']], '.lz4': [[0, '\x04\x22\x4d\x18']],
  ...Object.fromEntries(['.zip', '.jar', '.war', '.ear', '.whl', '.egg', '.apk', '.aar', '.nupkg'].map((e) => [e, ZIP.map((m) => [0, m] as const)])),
};

/** git's own binary test reads this many bytes for a NUL (xdiff's buffer_is_binary). */
export const BINARY_PROBE = 8000;

/** True when `bytes`, the content of a file with extension `ext`, are binary: a NUL early, or the format's magic number. */
export function binaryContent(ext: string, bytes: Buffer): boolean {
  if (bytes.subarray(0, BINARY_PROBE).includes(0)) return true;
  return (MAGIC[ext] ?? []).some(([at, magic]) => bytes.subarray(at, at + magic.length).toString('latin1') === magic);
}
/** Prose, skipped anywhere. */
export const PROSE_EXTENSIONS = ['.md'];
/** Documentation and evidence: only code is read under it. */
export const DOCS_DIR = 'docs/';
/** Code extensions; under docs/ only these (and files with a `#!` first line) are read. */
export const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh', '.go', '.rs', '.rb', '.pl', '.php', '.sql', '.ps1',
];
/** Configuration extensions (with CODE_EXTENSIONS, `*.env` names and `#!` files: what isSourceLike calls source). */
export const CONFIG_EXTENSIONS = ['.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.service', '.timer', '.socket',
  '.html', '.htm', '.xml', '.properties'];
/** Files whose lines run as shell commands: the domain as any argument there is a request target (ruling 5.4). */
export const SHELL_EXTENSIONS = ['.sh', '.bash', '.zsh', '.yml', '.yaml', '.service', '.timer'];
const SHELL_NAMES = ['dockerfile', 'makefile'];
/**
 * Evidence files the scan does not read, one by one, each with its reason (ruling 3.2). Only recorded data that quotes
 * what a third party returned belongs here; code never does. Adding a file is a change to a guarded file, so it needs
 * the review label.
 */
export const EVIDENCE_FILES: Readonly<Record<string, string>> = {
  'research/empirical/backfill/meta.json': 'recorded coin metadata as an outside API returned it (image URLs on a pump.fun image host); data kept from before 2026-10-07, never fetched from (ruling 5.5)',
};

const lower = (file: string): { ext: string; name: string } => {
  const name = (file.split('/').pop() ?? file).toLowerCase();
  return { ext: extname(name), name };
};

/** True when `file` holding `text` is code or configuration: a code or config extension, an `*.env` name or a `#!` line. */
export function isSourceLike(file: string, text: string): boolean {
  const { ext, name } = lower(file);
  return CODE_EXTENSIONS.includes(ext) || CONFIG_EXTENSIONS.includes(ext) || name === '.env' || name.startsWith('.env.') || name.endsWith('.env')
    || text.startsWith('#!');
}

/** True when the lines of `file` run as shell commands (a shell script, a workflow, a systemd unit, a Dockerfile). */
export function isShellLike(file: string, text: string): boolean {
  const { ext, name } = lower(file);
  return SHELL_EXTENSIONS.includes(ext) || SHELL_NAMES.includes(name) || /^#!\S*(?:\/|\s)(?:ba|z|da|k)?sh\b/.test(text);
}

/**
 * True when the host check reads `file` (a repository path) holding `content` as text; see the header for what is
 * skipped. A binary name with text content is read (ruling 7.1); a binary file is searched by scanBinary instead.
 */
export function hostScanned(file: string, content: string | Buffer): boolean {
  const { ext } = lower(file);
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (BINARY_EXTENSIONS.includes(ext) && (bytes.length === 0 || binaryContent(ext, bytes))) return false;
  if (PROSE_EXTENSIONS.includes(ext) || file in EVIDENCE_FILES) return false;
  if (file.startsWith(DOCS_DIR)) return CODE_EXTENSIONS.includes(ext) || bytes.subarray(0, 2).toString('latin1') === '#!';
  return true;
}

/**
 * A pump.fun host in a request-target position (see the header): a URL host or any subdomain, in any case, with or
 * without the trailing dot of a fully qualified name (red team RT-04: frontend-api.pump[.]fun. passed before).
 */
export const PUMP_FUN_HOST = /(?:\/\/(?:[A-Za-z0-9-]+\.)*pump\.fun\.?(?![A-Za-z0-9-])|(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)+pump\.fun\.?(?![A-Za-z0-9.-]))/i;
/**
 * The bare domain where a host is written, in any letter case and with an optional trailing dot (red team RT-04): at
 * the start of a string (after a quote or backtick), after `=` (a .env or query value), after a key and `: ` (a YAML or
 * JSON value, and a `host:` header field; the key starts the line, follows a list dash, `{` or `,`, so a string that
 * holds "venue: " is not one, ruling 7.3), or at the start of a line. It ends there: a quote, `/`, `:`, `?`, `#`, a comma or
 * the end of the line follow. Read on the whole line, comments included.
 */
export const PUMP_FUN_STRING = /(?:^|["'`]|=|,|(?:^|[{,])\s*(?:-\s+)?(?:"[^"\n]*"|'[^'\n]*'|[\w$@.-]+)\s*:[ \t])pump\.fun\.?(?=["'`/:?#,]|[ \t]*$)/i;
/**
 * The same with the wider forms of ruling 5.4 (red team RT3-04): any whitespace around `=` and `:`, and `;`, `)` or
 * `:port` after the domain too. Whitespace after the domain counts only when what follows ends the value (end of line,
 * `;`, `)`, `}`, `]`, `,`, `:port` or a quote; `}` and `]` close a flow mapping or list, ruling 7.3; ruling 6.5, review R5-1): prose that starts with the venue's name (pump[.]fun
 * bonding curve in a string, a test title, a log template) is not a host. Plain whitespace after the domain stays a
 * host only in shell files (PUMP_FUN_ARGUMENT). Read with comments taken off the line.
 */
export const PUMP_FUN_VALUE = /(?:^|["'`]|=\s*|,|(?:^|[{,])\s*(?:-\s+)?(?:"[^"\n]*"|'[^'\n]*'|[\w$@.-]+)\s*:\s*)pump\.fun\.?(?=["'`/?#,;)}\]]|:\d|\s*(?:$|[;),}\]"'`]|:\d))/i;
/** The bare domain after whitespace with a path on it (red team RT2-02). */
export const PUMP_FUN_PATH = /(?<=\s)pump\.fun\.?(?=\/)/i;
/**
 * The domain, or a subdomain of it, as an argument of curl or wget run as a command: at the start of a line or after
 * `;`, `&`, `|`, `(`, a backtick or `$(` (red team RT2-02). Prose that names curl in a comment is not a command.
 */
export const PUMP_FUN_FETCH = /(?:^|[;&|(`]|\$\()\s*(?:sudo\s+|command\s+|exec\s+)?(?:curl|wget)\b[^\n]*?\s["']?(?:[A-Za-z0-9-]+\.)*pump\.fun\.?(?![A-Za-z0-9-])/i;
/**
 * The domain as any shell argument (`nc pump.fun 443`, `openssl s_client -connect pump.fun:443`, `H=pump.fun;`), in files
 * whose lines run as shell commands (isShellLike), comments taken off (ruling 5.4).
 */
export const PUMP_FUN_ARGUMENT = /(?:^|[\s=;&|(`'"])pump\.fun\.?(?=[\s;)&|'"`/]|:\d|$)/i;

/** Unicode names Python's `\N{…}` may spell in a host: letters, digits and the punctuation a host or URL uses. */
const UNICODE_NAMES: Readonly<Record<string, string>> = {
  'FULL STOP': '.', 'FULLWIDTH FULL STOP': '．', 'IDEOGRAPHIC FULL STOP': '。', 'HALFWIDTH IDEOGRAPHIC FULL STOP': '｡',
  SOLIDUS: '/', COLON: ':', 'HYPHEN-MINUS': '-', 'COMMERCIAL AT': '@', 'QUESTION MARK': '?', 'NUMBER SIGN': '#',
};
const DIGIT_NAMES = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
/** HTML named entities that can spell part of a host or URL. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  period: '.', sol: '/', colon: ':', amp: '&', quot: '"', apos: "'", lpar: '(', rpar: ')', semi: ';', comma: ',', num: '#', quest: '?',
  commat: '@', lowbar: '_', dash: '-', hyphen: '-', lt: '<', gt: '>',
};

/** The character a Python `\N{name}` names, when it is one a host could use; the escape unchanged otherwise. */
function unicodeName(name: string): string | null {
  const n = name.trim().toUpperCase();
  const letter = /^LATIN (SMALL|CAPITAL) LETTER ([A-Z])$/.exec(n);
  if (letter) return letter[1] === 'SMALL' ? (letter[2] as string).toLowerCase() : (letter[2] as string);
  const digit = /^DIGIT ([A-Z]+)$/.exec(n);
  if (digit && DIGIT_NAMES.includes(digit[1] as string)) return String(DIGIT_NAMES.indexOf(digit[1] as string));
  return UNICODE_NAMES[n] ?? null;
}

/**
 * The line as a host would be read from it (red team RT3-04 and RT4-02; rulings 5.4 and 6.2): `\uXXXX`, `\u{…}`,
 * `\xXX`, `%XX`, octal `\NNN` and Python `\N{…}` escapes and HTML character references (`&#NN;`, `&#xNN;`, `&period;`
 * and the like) decoded, then folded with NFKC (fullwidth and other compatibility forms become ASCII), and the
 * ideographic, fullwidth and halfwidth full stops (U+3002, U+FF0E, U+FF61) read as `.`.
 */
export function decodeEscapes(line: string): string {
  const cp = (c: number, m: string): string => (c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m);
  return line
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (m, a?: string, b?: string) => cp(parseInt(a ?? b ?? '', 16), m))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-3][0-7]{2})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\N\{([^}]{1,80})\}/g, (m, name: string) => unicodeName(name) ?? m)
    .replace(/&#[xX]([0-9a-fA-F]{1,6});|&#([0-9]{1,7});/g, (m, h?: string, d?: string) => cp(h !== undefined ? parseInt(h, 16) : Number(d), m))
    .replace(/&([A-Za-z]{2,8});/g, (m, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? m)
    .normalize('NFKC')
    .replace(/[。．｡]/g, '.');
}

/** The line without its comment: a whole-line comment, or `#` / `//` after whitespace (a URL's `://` stays). */
export function stripComment(line: string): string {
  if (/^\s*(?:\/\/|\/\*|\*|#|--|;|<!--)/.test(line)) return '';
  return line.replace(/(^|\s)(?:#|\/\/).*$/, '$1');
}

/**
 * True when `at` (an index in `line`) lies inside a quoted string that holds other words: a shell argument there is
 * prose (`echo "checking pump[.]fun now"`), while a quoted host on its own (`wget "pump[.]fun"`) is not (ruling 7.3).
 * An unclosed quote runs to the end of the line.
 */
export function inQuotedProse(line: string, at: number): boolean {
  let open = -1;
  let quote = '';
  for (let i = 0; i <= line.length; i++) {
    const c = line[i] ?? '';
    if (open < 0 && (c === '"' || c === "'") && line[i - 1] !== '\\') {
      open = i;
      quote = c;
    } else if (open >= 0 && (c === quote || c === '') && (c === '' || quote === "'" || line[i - 1] !== '\\')) {
      if (at > open && at < i) return /\S\s+\S/.test(line.slice(open + 1, i).trim());
      open = -1;
    }
  }
  return false;
}

/** The first shell-argument match in `code` that is not inside quoted prose (ruling 7.3). */
function shellArgument(code: string): RegExpExecArray | null {
  const all = new RegExp(PUMP_FUN_ARGUMENT.source, 'gi');
  for (let m = all.exec(code); m !== null; m = all.exec(code)) {
    if (!inQuotedProse(code, m.index + m[0].search(/pump/i))) return m;
  }
  return null;
}

/** The match that makes `raw` (one line, or lines read joined) a request target, or null. */
function hitOf(raw: string, shell: boolean): RegExpExecArray | null {
  let hit: RegExpExecArray | null = null;
  for (const line of new Set([raw, decodeEscapes(raw)])) {
    const code = stripComment(line);
    hit ??= PUMP_FUN_HOST.exec(line) ?? PUMP_FUN_STRING.exec(line) ?? PUMP_FUN_PATH.exec(line) ?? PUMP_FUN_FETCH.exec(line)
      ?? PUMP_FUN_VALUE.exec(code) ?? (shell ? shellArgument(code) : null);
  }
  return hit;
}

/** Lines read joined (ruling 7.2): 1-based first and last line, and each way the joined text is read. */
export interface JoinedLines { first: number; last: number; texts: string[] }

/**
 * The runs of lines that are read joined as well as one by one (red team RT5-02, ruling 7.2): a line ending in `\` with
 * the lines it continues (the `\` taken off, the next line's indentation kept and also dropped: a shell keeps it, a YAML
 * or JS string escape does not), and the lines of a YAML folded block (`key: >`, in a .yml or .yaml file) joined with a
 * space, as YAML reads them, and with nothing, so a host split anywhere is read whole.
 */
export function joinedLines(text: string, file: string): JoinedLines[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const out: JoinedLines[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\\$/.test(lines[i] as string)) continue;
    let j = i;
    while (j + 1 < lines.length && /\\$/.test(lines[j] as string)) j++;
    const parts = lines.slice(i, j + 1).map((l, k) => (k < j - i ? l.slice(0, -1) : l));
    out.push({ first: i + 1, last: j + 1, texts: [parts.join(''), parts.map((p, k) => (k === 0 ? p : p.trimStart())).join('')] });
    i = j;
  }
  if (!/\.ya?ml$/i.test(file)) return out;
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i] as string;
    if (!/(?:^|:|-)\s*>[+-]?\d*\s*(?:#.*)?$/.test(head)) continue;
    const indent = head.length - head.trimStart().length;
    let j = i;
    while (j + 1 < lines.length && ((lines[j + 1] as string).trim() === '' || (lines[j + 1] as string).length - (lines[j + 1] as string).trimStart().length > indent)) j++;
    const body = lines.slice(i + 1, j + 1).map((l) => l.trim()).filter((l) => l !== '');
    if (body.length > 1) {
      const key = head.replace(/>[+-]?\d*\s*(?:#.*)?$/, '');
      out.push({ first: i + 1, last: j + 1, texts: [`${key}${body.join(' ')}`, `${key}${body.join('')}`] });
    }
    i = j;
  }
  return out;
}

/** A host found on line `line` (1-based); `last` is the last line it spans when lines were read joined. */
interface Hit { line: number; last: number; hit: string }

function hostHits(text: string, file: string, shell: boolean): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((raw, i) => {
    const hit = hitOf(raw, shell);
    if (hit !== null) hits.push({ line: i + 1, last: i + 1, hit: hit[0] });
  });
  for (const run of joinedLines(text, file)) {
    if (hits.some((h) => h.line >= run.first && h.line <= run.last)) continue;
    const hit = run.texts.map((t) => hitOf(t, shell)).find((h) => h !== null) ?? null;
    if (hit !== null) hits.push({ line: run.first, last: run.last, hit: hit[0] });
  }
  return hits.sort((a, b) => a.line - b.line);
}

const hostFinding = (where: string, hit: string): Finding =>
  finding('E_PUMP_FUN_HOST', where, `"${hit.trim()}" is a pump.fun-operated host; bot and research code makes no request to pump.fun (owner rule A02)`);

/** One finding per line (or run of joined lines, at its first line) that writes a pump.fun host as a request target. */
export function scanHosts(text: string, file: string, shell = isShellLike(file, text)): Finding[] {
  return hostHits(text, file, shell).map((h) => hostFinding(`${file}:${h.line}`, h.hit));
}

/** The domain, or a subdomain of it, written literally: what a binary file is searched for (ruling 7.1b). */
export const PUMP_FUN_LITERAL = /(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)*pump\.fun(?![A-Za-z0-9-])/i;

/** A binary file's bytes read as latin1 for the literal domain (ruling 7.1b): one finding, at the byte offset. */
export function scanBinary(bytes: Buffer, file: string): Finding[] {
  const m = PUMP_FUN_LITERAL.exec(bytes.toString('latin1'));
  return m === null ? [] : [finding('E_PUMP_FUN_HOST', file, `"${m[0]}" at byte ${m.index} of a binary file is a pump.fun-operated host; bot and research code makes no request to pump.fun (owner rule A02)`)];
}

/**
 * Checks `files` (paths relative to `root`, regular files only) on the lines `lines` names (every line, or the added
 * lines of old Zeroed code; a run of joined lines counts when any of its lines is named):
 * - a new compressed archive not on ARCHIVE_FILES is E_ARCHIVE (ruling 7.1c);
 * - a binary file (a binary extension and binary content) is searched as latin1 bytes (ruling 7.1b);
 * - a binary name holding text, or a NUL byte in any other file, is E_BINARY_SOURCE, and the file is read as text
 *   (rulings 5.1, 6.1, 7.1a);
 * - every other file hostScanned admits is read as text.
 */
export function checkHosts(root: string, files: readonly string[], lines: SafetyLines = safetyLinesOf(false, new Map())): Finding[] {
  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    if (DATA_DIRS.some((d) => file.startsWith(d))) continue;
    const read = lines(file);
    if (read !== 'all' && read.size === 0) continue;
    const bytes = readFileSync(join(root, file));
    const { ext } = lower(file);
    if (ARCHIVE_EXTENSIONS.includes(ext) && !(file in ARCHIVE_FILES)) {
      findings.push(finding('E_ARCHIVE', file, 'a compressed archive: its content is not read, so a new one is refused unless tools/policy/hosts.ts ARCHIVE_FILES names it with its reason (ruling 7.1c)'));
    }
    if (BINARY_EXTENSIONS.includes(ext)) {
      if (bytes.length === 0) continue;
      if (binaryContent(ext, bytes)) {
        findings.push(...scanBinary(bytes, file));
        continue;
      }
      findings.push(finding('E_BINARY_SOURCE', file, `a binary name (${ext}) on text content: it is read as text, and a binary file needs binary content (a NUL byte in its first ${BINARY_PROBE} bytes or its format's magic number; red team RT5-01, ruling 7.1)`));
    } else if (bytes.includes(0) && hostScanned(file, bytes)) {
      findings.push(finding('E_BINARY_SOURCE', file, 'a NUL byte in a file whose extension is not a binary one: git and other tools may read it as binary and skip it, so it is not '
        + 'allowed; a binary file needs an extension on BINARY_EXTENSIONS (red team RT3-01, RT4-01)'));
    }
    if (!hostScanned(file, bytes)) continue;
    const text = bytes.toString('utf8');
    for (const h of hostHits(text, file, isShellLike(file, text))) {
      if (read === 'all' || Array.from({ length: h.last - h.line + 1 }, (_, k) => h.line + k).some((n) => read.has(n))) findings.push(hostFinding(`${file}:${h.line}`, h.hit));
    }
  }
  return findings;
}
