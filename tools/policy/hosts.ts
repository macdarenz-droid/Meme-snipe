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
// Where (supervisor ruling, 2026-10-08): code and configuration only, because A02 is about request targets in bot and
// research code. Code: .ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs, .py and .sh files anywhere outside docs/.
// Configuration: .json, .yaml, .yml, .toml and .env files (`.env` and `.env.*`) outside docs/. Nothing under docs/ and
// no Markdown is read: evidence and prose keep their verbatim wording (docs/blueprint/FACTS.json quotes the Jupiter
// route label as it was observed). The Zeroed manifest's own files (config.ts ZEROED_FILES_MANIFEST) are skipped
// unless the run includes them; the policy fixtures are data. What: a pump.fun host written as a request target:
// - after `//` (a URL, any scheme, or a protocol-relative URL): https: // frontend-api.pump[.]fun/coins without the gaps;
// - any subdomain of pump.fun anywhere (frontend-api.pump[.]fun in a host or header field), with or without a trailing
//   dot;
// - the bare domain where a host is written, in any letter case: after a quote or backtick, after `=`, after `: ` or at
//   the start of a line, and ending there (a quote, `/`, `:`, `?`, `#`, a comma or the end of the line). A
//   Markdown-style link label ([Pump[.]fun](url)) in a JSON or TypeScript string is prose, so a bracket is not one of
//   these positions.
// The venue's name in prose or comments ("the pump.fun bonding curve") is not a target, because words follow it on the
// line; a quoted label (Pump[.]fun on its own inside quotes) in code or configuration is, so a user-facing label is
// written another way there. A host assembled at run time from pieces (`'pump' + '.fun'`) is not found: review catches that.
// Red team RT-04 closed the forms this missed: a trailing dot, upper case in the bare domain, and the bare domain as a
// YAML or .env value.
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DATA_DIRS } from './config.ts';
import { finding, type Finding } from './finding.ts';
import { scopeOf, type Scope } from './scope.ts';

/** Code the host check reads, wherever it sits outside docs/. */
export const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh'];
/** Configuration the host check reads outside docs/; `.env` files are matched by name (hostScanned). */
export const CONFIG_EXTENSIONS = ['.json', '.yaml', '.yml', '.toml'];
/** Never read: documentation and evidence, whatever the file type. */
export const HOST_SKIPPED_DIRS = ['docs/'];

/** True when the host check reads `file` (a repository path): code or configuration outside docs/. */
export function hostScanned(file: string): boolean {
  if (HOST_SKIPPED_DIRS.some((d) => file.startsWith(d))) return false;
  const name = basename(file).toLowerCase();
  if (name === '.env' || name.startsWith('.env.')) return true;
  const ext = extname(name);
  return CODE_EXTENSIONS.includes(ext) || CONFIG_EXTENSIONS.includes(ext);
}

/**
 * A pump.fun host in a request-target position (see the header): a URL host or any subdomain, in any case, with or
 * without the trailing dot of a fully qualified name (red team RT-04: frontend-api.pump[.]fun. passed before).
 */
export const PUMP_FUN_HOST = /(?:\/\/(?:[A-Za-z0-9-]+\.)*pump\.fun\.?(?![A-Za-z0-9-])|(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)+pump\.fun\.?(?![A-Za-z0-9.-]))/i;
/**
 * The bare domain where a host is written, in any letter case and with an optional trailing dot (red team RT-04): at
 * the start of a string (after a quote or backtick), after `=` (a .env or query value), after `: ` (a YAML or JSON
 * value, and a `host:` header field), or at the start of a line. It ends there: a quote, `/`, `:`, `?`, `#`,
 * whitespace, a comma or the end of the line follow. A display label in prose keeps the venue's name, but a label in
 * one of these positions now counts as a host: write it some other way, or put it in Markdown, which is not read.
 * Prose keeps passing because a bare domain followed by more words on the same line is not a host.
 */
export const PUMP_FUN_STRING = /(?:^|["'`]|=|,|:[ \t])pump\.fun\.?(?=["'`/:?#,]|[ \t]*$)/i;

/** One finding per line that writes a pump.fun host as a request target. */
export function scanHosts(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    const hit = PUMP_FUN_HOST.exec(line) ?? PUMP_FUN_STRING.exec(line);
    if (hit !== null) {
      findings.push(finding('E_PUMP_FUN_HOST', `${file}:${i + 1}`, `"${hit[0]}" is a pump.fun-operated host; bot and research code makes no request to pump.fun (owner rule A02)`));
    }
  });
  return findings;
}

/** Checks every code and configuration file of `files` (paths relative to `root`, regular files only) that `scope` admits. */
export function checkHosts(root: string, files: readonly string[], scope: Scope = scopeOf(false)): Finding[] {
  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    if (!scope(file) || DATA_DIRS.some((d) => file.startsWith(d)) || !hostScanned(file)) continue;
    findings.push(...scanHosts(readFileSync(join(root, file)).toString('utf8'), file));
  }
  return findings;
}
