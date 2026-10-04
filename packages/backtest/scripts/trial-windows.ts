// Runs the trial on every assembled data window that holds practice days only (DATA-1 releases `data-<from>-<to>`),
// one window at a time (download, verify, run, delete), and leaves one trial part per window in <out>.
//   GH_TOKEN=... node packages/backtest/scripts/trial-windows.ts <sol-usd file> <out dir> [owner/repo]
// A window that reaches a day of the sealed window is skipped, never downloaded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STUDY_CONFIG } from '../src/strategy/config.ts';
import { holdoutDaysOf, windowDays } from '../src/study/plan.ts';

const [sol, out, repoArg] = process.argv.slice(2);
if (!sol || !out) throw new Error('usage: trial-windows.ts <sol-usd file> <out dir> [owner/repo]');
const repo = repoArg ?? process.env['GITHUB_REPOSITORY'] ?? 'macdarenz-droid/Meme-snipe';
const sealed = new Set(holdoutDaysOf(STUDY_CONFIG));
const practice = new Set(windowDays(STUDY_CONFIG).filter((d) => !sealed.has(d)));
const tags = execFileSync('gh', ['release', 'list', '--repo', repo, '--limit', '500', '--json', 'tagName', '--jq', '.[].tagName'], { encoding: 'utf8' })
  .split('\n').filter((t) => /^data-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}$/.test(t)).sort();
const daysOf = (from: string, to: string) => {
  const ds: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) ds.push(new Date(t).toISOString().slice(0, 10));
  return ds;
};
mkdirSync(out, { recursive: true });
let ran = 0;
for (const tag of tags) {
  const from = tag.slice(5, 15);
  const to = tag.slice(16, 26);
  const days = daysOf(from, to);
  if (!days.every((d) => practice.has(d))) {
    console.log(`${tag}: skipped (not practice days only)`);
    continue;
  }
  const dir = join(out, 'dataset');
  rmSync(dir, { recursive: true, force: true });
  execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--dir', dir], { stdio: 'inherit' });
  execFileSync('node', ['--no-warnings', join(import.meta.dirname, '../src/study/cli.ts'), 'trial', '--dataset', dir, '--sol-usd', sol, '--out', out], { stdio: 'inherit' });
  rmSync(dir, { recursive: true, force: true });
  ran++;
}
console.log(`${ran} windows tested`);
