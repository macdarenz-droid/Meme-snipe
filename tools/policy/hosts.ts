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
// Where: every text file in scope (config.ts ZEROED_PATHS are skipped unless the run includes them) except Markdown,
// whose prose names the venue; the policy fixtures are data. What: a pump.fun host written as a request target:
// - after `//` (a URL, any scheme, or a protocol-relative URL): https: // frontend-api.pump[.]fun/coins without the gaps;
// - any subdomain of pump.fun anywhere (frontend-api.pump[.]fun in a host or header field);
// - the bare domain, in lower case as a host is written, as the start of a string: right after a quote or backtick and
//   followed by a quote, `/`, `:`, `?` or `#` (a display label such as "Pump.fun" is not a host).
// The venue's name in prose or comments ("pump.fun bonding curve", "Pump.fun") is not a target. A host assembled at
// run time from pieces (`'pump' + '.fun'`) is not found: review catches that.
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DATA_DIRS } from './config.ts';
import { finding, type Finding } from './finding.ts';
import { scopeOf, type Scope } from './scope.ts';

/** File types that are prose, not code or configuration. */
export const PROSE_EXTENSIONS = ['.md'];

/** A pump.fun host in a request-target position (see the header): a URL host or any subdomain, in any case. */
export const PUMP_FUN_HOST = /(?:\/\/(?:[A-Za-z0-9-]+\.)*pump\.fun(?![A-Za-z0-9-])|(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)+pump\.fun(?![A-Za-z0-9.-]))/i;
/** The bare domain, lower case, starting a string. */
export const PUMP_FUN_STRING = /["'`]pump\.fun(?=["'`/:?#])/;

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

/** Checks every non-prose file of `files` (paths relative to `root`, regular files only) that `scope` admits. */
export function checkHosts(root: string, files: readonly string[], scope: Scope = scopeOf(false)): Finding[] {
  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    if (!scope(file) || DATA_DIRS.some((d) => file.startsWith(d)) || PROSE_EXTENSIONS.includes(extname(file).toLowerCase())) continue;
    findings.push(...scanHosts(readFileSync(join(root, file)).toString('utf8'), file));
  }
  return findings;
}
