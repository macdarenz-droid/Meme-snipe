// .gitattributes (red team RT3-02; supervisor ruling 5.2). An attribute can make git print "Binary files differ" for a
// file, or hand its diff to another driver, so the added-lines scan of old Zeroed files (scope.ts safetyLinesOf) would
// see no hunk. The diff runs with --text and a changed file without hunks is read whole, and on top of that no checked
// .gitattributes may set -diff, binary, diff=<driver> or -text (config.ts GITATTRIBUTES_REFUSED). The file is guarded at
// any depth (config.ts GITATTRIBUTES_PATTERN), so adding one needs the review label too.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIRS, GITATTRIBUTES_PATTERN, GITATTRIBUTES_REFUSED } from './config.ts';
import { finding, type Finding } from './finding.ts';

/** Findings for the refused attributes of one .gitattributes text: pattern, then attributes, per line (gitattributes(5)). */
export function scanGitattributes(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const [pattern = '', ...attributes] = line.split(/\s+/);
    for (const a of attributes) {
      if (GITATTRIBUTES_REFUSED.some((re) => re.test(a))) {
        findings.push(finding('E_GITATTRIBUTES', `${file}:${i + 1}`, `"${a}" on "${pattern}" changes how git diffs those files, so an edit could hide from the added-lines scan; not allowed`));
      }
    }
  });
  return findings;
}

/** Every .gitattributes among `files` (paths relative to `root`), the policy fixtures aside. */
export function checkGitattributes(root: string, files: readonly string[]): Finding[] {
  return [...files].sort().filter((f) => GITATTRIBUTES_PATTERN.test(f) && !DATA_DIRS.some((d) => f.startsWith(d)))
    .flatMap((f) => scanGitattributes(readFileSync(join(root, f), 'utf8'), f));
}
