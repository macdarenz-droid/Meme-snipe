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
// only: binaries and images (by extension, or a NUL byte in the file), Markdown anywhere, files under docs/ that are
// not code (code there is read: a code extension, or a `#!` first line), and the evidence files of EVIDENCE_FILES,
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
//   curl or wget (red team RT2-02: `curl -s pump[.]fun/api/coins` and `wget pump[.]fun` passed before).
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

/** Binaries and images: never text a request is written in. Any other file holding a NUL byte is skipped too. */
export const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg', '.avif', '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.tar', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.webm', '.wasm', '.node', '.so', '.dylib', '.dll',
  '.exe', '.bin', '.db', '.sqlite', '.parquet', '.jar', '.class', '.pyc', '.keystore', '.jks',
];
/** Prose, skipped anywhere. */
export const PROSE_EXTENSIONS = ['.md'];
/** Documentation and evidence: only code is read under it. */
export const DOCS_DIR = 'docs/';
/** Code extensions; under docs/ only these (and files with a `#!` first line) are read. */
export const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh', '.go', '.rs', '.rb', '.pl', '.php', '.sql', '.ps1',
];
/**
 * Evidence files the scan does not read, one by one, each with its reason (ruling 3.2). Only recorded data that quotes
 * what a third party returned belongs here; code never does. Adding a file is a change to a guarded file, so it needs
 * the review label.
 */
export const EVIDENCE_FILES: Readonly<Record<string, string>> = {};

/** True when the host check reads `file` (a repository path) holding `text`; see the header for what is skipped. */
export function hostScanned(file: string, text: string): boolean {
  const ext = extname(file).toLowerCase();
  if (BINARY_EXTENSIONS.includes(ext) || PROSE_EXTENSIONS.includes(ext) || file in EVIDENCE_FILES || text.includes('\0')) return false;
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
 * the end of the line follow. Prose keeps passing because a bare domain followed by more words is not a host.
 */
export const PUMP_FUN_STRING = /(?:^|["'`]|=|,|:[ \t])pump\.fun\.?(?=["'`/:?#,]|[ \t]*$)/i;
/** The bare domain after whitespace with a path on it (red team RT2-02). */
export const PUMP_FUN_PATH = /(?<=\s)pump\.fun\.?(?=\/)/i;
/**
 * The domain, or a subdomain of it, as an argument of curl or wget run as a command: at the start of a line or after
 * `;`, `&`, `|`, `(`, a backtick or `$(` (red team RT2-02). Prose that names curl in a comment is not a command.
 */
export const PUMP_FUN_FETCH = /(?:^|[;&|(`]|\$\()\s*(?:sudo\s+|command\s+|exec\s+)?(?:curl|wget)\b[^\n]*?\s["']?(?:[A-Za-z0-9-]+\.)*pump\.fun\.?(?![A-Za-z0-9-])/i;

/** One finding per line that writes a pump.fun host as a request target. */
export function scanHosts(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    const hit = PUMP_FUN_HOST.exec(line) ?? PUMP_FUN_STRING.exec(line) ?? PUMP_FUN_PATH.exec(line) ?? PUMP_FUN_FETCH.exec(line);
    if (hit !== null) {
      findings.push(finding('E_PUMP_FUN_HOST', `${file}:${i + 1}`, `"${hit[0]}" is a pump.fun-operated host; bot and research code makes no request to pump.fun (owner rule A02)`));
    }
  });
  return findings;
}

/**
 * Checks `files` (paths relative to `root`, regular files only): each one hostScanned admits, on the lines `lines`
 * names (every line, or the added lines of old Zeroed code).
 */
export function checkHosts(root: string, files: readonly string[], lines: SafetyLines = safetyLinesOf(false, new Map())): Finding[] {
  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    if (DATA_DIRS.some((d) => file.startsWith(d))) continue;
    const read = lines(file);
    if (read !== 'all' && read.size === 0) continue;
    const text = readFileSync(join(root, file)).toString('utf8');
    if (!hostScanned(file, text)) continue;
    const found = scanHosts(text, file);
    findings.push(...(read === 'all' ? found : found.filter((f) => read.has(Number(f.file.slice(f.file.lastIndexOf(':') + 1))))));
  }
  return findings;
}
