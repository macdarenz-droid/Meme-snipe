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
// only: binaries and images, by extension alone (a NUL byte in any other file is E_BINARY_SOURCE and the file is still
// read; rulings 5.1 and 6.1),
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
 * Binaries and images: never text a request is written in. These extensions alone decide that a file is binary: a NUL
 * byte in any other file is E_BINARY_SOURCE and the file is still read (red team RT3-01 and RT4-01; rulings 5.1, 6.1).
 */
export const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg', '.avif', '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.tar', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.webm', '.wasm', '.node', '.so', '.dylib', '.dll',
  '.exe', '.bin', '.db', '.db-shm', '.db-wal', '.sqlite', '.sqlite3', '.parquet', '.jar', '.class', '.pyc', '.keystore', '.jks',
  '.zst', '.zstd', '.lz4', '.br',
];
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

/** True when the host check reads `file` (a repository path) holding `text`; see the header for what is skipped. */
export function hostScanned(file: string, text: string): boolean {
  const { ext } = lower(file);
  if (BINARY_EXTENSIONS.includes(ext) || PROSE_EXTENSIONS.includes(ext) || file in EVIDENCE_FILES) return false;
  if (file.startsWith(DOCS_DIR)) return CODE_EXTENSIONS.includes(ext) || text.startsWith('#!');
  return true;
}

/**
 * A pump.fun host in a request-target position (see the header): a URL host or any subdomain, in any case, with or
 * without the trailing dot of a fully qualified name (red team RT-04: frontend-api.pump[.]fun. passed before).
 */
export const PUMP_FUN_HOST = /(?:\/\/(?:[A-Za-z0-9-]+\.)*pump\.fun\.?(?![A-Za-z0-9-])|(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)+pump\.fun\.?(?![A-Za-z0-9.-]))/i;
/**
 * The bare domain where a host is written, in any letter case and with an optional trailing dot (red team RT-04): at
 * the start of a string (after a quote or backtick), after `=` (a .env or query value), after `: ` (a YAML or JSON
 * value, and a `host:` header field), or at the start of a line. It ends there: a quote, `/`, `:`, `?`, `#`, a comma or
 * the end of the line follow. Read on the whole line, comments included.
 */
export const PUMP_FUN_STRING = /(?:^|["'`]|=|,|:[ \t])pump\.fun\.?(?=["'`/:?#,]|[ \t]*$)/i;
/**
 * The same with the wider forms of ruling 5.4 (red team RT3-04): any whitespace around `=` and `:`, and `;`, `)` or
 * `:port` after the domain too. Whitespace after the domain counts only when what follows ends the value (end of line,
 * `;`, `)`, `,`, `:port` or a quote; ruling 6.5, review R5-1): prose that starts with the venue's name (pump[.]fun
 * bonding curve in a string, a test title, a log template) is not a host. Plain whitespace after the domain stays a
 * host only in shell files (PUMP_FUN_ARGUMENT). Read with comments taken off the line.
 */
export const PUMP_FUN_VALUE = /(?:^|["'`]|=\s*|,|:\s*)pump\.fun\.?(?=["'`/?#,;)]|:\d|\s*(?:$|[;),"'`]|:\d))/i;
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

/** One finding per line that writes a pump.fun host as a request target. `shell`: the lines run as shell commands. */
export function scanHosts(text: string, file: string, shell = isShellLike(file, text)): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((raw, i) => {
    let hit: RegExpExecArray | null = null;
    for (const line of new Set([raw, decodeEscapes(raw)])) {
      const code = stripComment(line);
      hit ??= PUMP_FUN_HOST.exec(line) ?? PUMP_FUN_STRING.exec(line) ?? PUMP_FUN_PATH.exec(line) ?? PUMP_FUN_FETCH.exec(line)
        ?? PUMP_FUN_VALUE.exec(code) ?? (shell ? PUMP_FUN_ARGUMENT.exec(code) : null);
    }
    if (hit !== null) {
      findings.push(finding('E_PUMP_FUN_HOST', `${file}:${i + 1}`, `"${hit[0].trim()}" is a pump.fun-operated host; bot and research code makes no request to pump.fun (owner rule A02)`));
    }
  });
  return findings;
}

/**
 * Checks `files` (paths relative to `root`, regular files only): each one hostScanned admits, on the lines `lines`
 * names (every line, or the added lines of old Zeroed code). A file holding a NUL byte whose extension is not on
 * BINARY_EXTENSIONS is a finding of its own (E_BINARY_SOURCE), and is still read.
 */
export function checkHosts(root: string, files: readonly string[], lines: SafetyLines = safetyLinesOf(false, new Map())): Finding[] {
  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    if (DATA_DIRS.some((d) => file.startsWith(d))) continue;
    const read = lines(file);
    if (read !== 'all' && read.size === 0) continue;
    const text = readFileSync(join(root, file)).toString('utf8');
    if (!hostScanned(file, text)) continue;
    if (text.includes('\0')) {
      findings.push(finding('E_BINARY_SOURCE', file, 'a NUL byte in a file whose extension is not a binary one: git and other tools may read it as binary and skip it, so it is not '
        + 'allowed; a binary file needs an extension on BINARY_EXTENSIONS (red team RT3-01, RT4-01)'));
    }
    const found = scanHosts(text, file);
    findings.push(...(read === 'all' ? found : found.filter((f) => read.has(Number(f.file.slice(f.file.lastIndexOf(':') + 1))))));
  }
  return findings;
}
