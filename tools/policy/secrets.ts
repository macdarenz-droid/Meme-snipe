// Secrets scan (B-M30-01 logic 5; ARCH 12.4; SPEC-B conventions 6 and 7): repository files, fixtures and test logs.
// A finding names the file, line and rule, never the matched text.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finding, formatFindings, type Finding, type Io } from './finding.ts';

export interface SecretRule { id: string; pattern: RegExp; description: string }

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
/**
 * Space between array items: whitespace and comments (`// …` and `# …` to the end of the line, `/* … *\/`) that hold
 * no `[`. Each alternative starts with a different character and runs to a fixed end, so the pattern cannot backtrack
 * heavily. No `[` in a comment keeps the scan linear (C01 red-team round 5, A5): an attempt that starts at a `[` can
 * read no further than the next `[`, so the attempts read disjoint stretches of the text. With `[` allowed, each `[`
 * inside a comment started an attempt that read every later comment again (`# [` lines: 1.8 s for 60 KB), and an
 * unterminated comment after each `[` was read to the end of the text once per `[` (`[/*` repeated: 10.8 s for
 * 120 KB). A keypair array with a `[` in a comment between its items is not found by this rule.
 */
const GAP = String.raw`(?:\s|//[^\n\[]*\n|#[^\n\[]*\n|/\*(?:[^*\[]|\*(?!/))*\*/)*`;
/** One byte written in decimal (0-255 range not enforced) or hex (0x00). */
const BYTE = '(?:0[xX][0-9a-fA-F]{1,2}|\\d{1,3})';

export const SECRET_RULES: readonly SecretRule[] = [
  { id: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/, description: 'PEM or PGP private key' },
  // GAP spans newlines and comments: the text is scanned whole, so a pretty-printed or Prettier-formatted keypair (one
  // byte per line, trailing comma, a comment per line) matches as well as the one-line file `solana-keygen` writes,
  // and so does a hex `Uint8Array([0x..])` (C01 review finding R5). The optional trailing comma carries its own gap
  // (`(?:,GAP)?`), so two gaps never meet and the space after the last item is matched one way only (C01 red-team
  // round 3, finding A2); with no `[` in a comment, the whole rule runs in linear time (round 5, A5).
  {
    id: 'keypair-bytes',
    pattern: new RegExp(`\\[${GAP}(?:${BYTE}${GAP},${GAP}){63}${BYTE}${GAP}(?:,${GAP})?\\]`),
    description: '64-byte array (Solana keypair file format), decimal or hex',
  },
  {
    id: 'base58-secret',
    pattern: new RegExp(`(secret|private|keypair|seed)[^\\n]{0,40}?["'\`:= ]${BASE58}{64,88}(?!${BASE58})`, 'i'),
    description: 'base58 string of a 64-byte secret key next to a secret-like word',
  },
  { id: 'url-credential', pattern: /[?&](api[-_]?key|apikey|access[-_]?token|token|auth)=[^&\s"'`]{8,}/i, description: 'credential in a URL query string' },
  { id: 'github-token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/, description: 'GitHub token' },
  { id: 'aws-access-key', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, description: 'AWS access key ID' },
  { id: 'telegram-bot-token', pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/, description: 'Telegram bot token' },
];

/** A reviewed false positive: the rule, file and sha256 fingerprint of the matched text, and why it is not a secret. */
export interface AllowedMatch { file: string; rule: string; fingerprint: string; reason: string }

/** sha256 of the rule id and the matched text: identifies a match without revealing it. */
export function fingerprint(rule: string, match: string): string {
  return createHash('sha256').update(`${rule}\0${match}`).digest('hex');
}

/**
 * One finding per rule and line (the line where a match starts) with at least one match that is not a reviewed false
 * positive. The whole text is scanned at once, so a rule whose pattern spans lines (the keypair array) finds matches
 * that cross line breaks. Text with NUL characters is also scanned with them removed: that is how UTF-16 text (LE or
 * BE, with or without a byte-order mark) of an ASCII secret reads once its bytes are decoded as UTF-8 (C01 review
 * finding R5). Removing NULs keeps every line break, so line numbers stay the same.
 */
export function scanText(text: string, file: string, allowed: readonly AllowedMatch[] = []): Finding[] {
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const hits = new Map<string, { line: number; rule: SecretRule; fingerprint: string }>();
  const scan = (t: string, lineAt: (index: number) => number): void => {
    for (const rule of SECRET_RULES) {
      for (const m of t.matchAll(new RegExp(rule.pattern.source, `${rule.pattern.flags}g`))) {
        const fp = fingerprint(rule.id, m[0]);
        if (allowed.some((a) => a.file === file && a.rule === rule.id && a.fingerprint === fp)) continue;
        const line = lineAt(m.index);
        const key = `${line}\0${rule.id}`;
        if (!hits.has(key)) hits.set(key, { line, rule, fingerprint: fp });
      }
    }
  };
  scan(text, lineOf);
  if (text.includes('\0')) {
    const stripped = text.replaceAll('\0', '');
    const starts = [0];
    for (let i = stripped.indexOf('\n'); i >= 0; i = stripped.indexOf('\n', i + 1)) starts.push(i + 1);
    scan(stripped, (index) => starts.findLastIndex((s) => s <= index) + 1);
  }
  return [...hits.values()].sort((a, b) => a.line - b.line || SECRET_RULES.indexOf(a.rule) - SECRET_RULES.indexOf(b.rule))
    .map((h) => finding('E_SECRET', `${file}:${h.line}`, `possible ${h.rule.description} (rule ${h.rule.id}, fingerprint ${h.fingerprint})`));
}

/** True when `file` (relative to `root`, or absolute) exists and is a regular file, following symbolic links. */
export function isRegularFile(root: string, file: string): boolean {
  try {
    return statSync(resolve(root, file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Scans each file (relative to `root`, or absolute). No file is skipped as binary: bytes are decoded as UTF-8, so the
 * ASCII text segments of a file with NUL or other binary bytes are scanned like any text, and UTF-16 text is scanned
 * with its NUL bytes removed (scanText). Text in other encodings (UTF-32, compressed or encrypted data) is not read.
 * A path that is not a regular file (a directory, such as a submodule, or a FIFO, which would never end) is skipped
 * (C01 red-team round 5, A7): runChecks refuses submodules first, and scanMain refuses such an argument.
 */
export function scanFiles(root: string, files: readonly string[], allowed: readonly AllowedMatch[] = []): Finding[] {
  const findings: Finding[] = [];
  for (const file of files.filter((f) => isRegularFile(root, f))) findings.push(...scanText(readFileSync(resolve(root, file)).toString('utf8'), file, allowed));
  return findings;
}

/** Reviewed false positives: tools/policy/secret-allowlist.json (absent = none). Every entry needs a reason. */
export const ALLOWLIST_FILE = 'tools/policy/secret-allowlist.json';

export function readAllowlist(root: string): AllowedMatch[] {
  if (!existsSync(join(root, ALLOWLIST_FILE))) return [];
  const entries = JSON.parse(readFileSync(join(root, ALLOWLIST_FILE), 'utf8')) as AllowedMatch[];
  for (const e of entries) {
    if (![e.file, e.rule, e.fingerprint, e.reason].every((v) => typeof v === 'string' && v !== '')) {
      throw new Error(`${ALLOWLIST_FILE}: every entry needs file, rule, fingerprint and reason`);
    }
  }
  return entries;
}

/** Usage: secrets.ts <file>... (paths relative to `root`). Exit 0 clean, 1 findings, 2 usage or a path that is not a regular file. */
export function scanMain(argv: readonly string[], root: string, io: Io): number {
  if (argv.length === 0) {
    io.err('usage: node tools/policy/bin/secrets.ts <file>...');
    return 2;
  }
  const unread = argv.filter((f) => !isRegularFile(root, f));
  if (unread.length > 0) {
    io.err(`policy: not a regular file, so not scanned: ${unread.join(', ')}`);
    return 2;
  }
  const findings = scanFiles(root, argv, readAllowlist(root));
  if (findings.length > 0) {
    io.err(formatFindings(findings));
    return 1;
  }
  io.out(`policy: no secrets found in ${argv.length} file(s)`);
  return 0;
}
