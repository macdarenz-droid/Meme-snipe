// Publishes a backtest report as the `latest-report.json` asset of the `backtest` release (UI-2 loads it from there).
// Run by the supervisor, by hand or from a manual workflow; never on a pull request.
//   GITHUB_TOKEN=... node packages/backtest/scripts/publish-report.ts <report.json> [owner/repo]
import { readFileSync } from 'node:fs';
import { type Api, LATEST, publishReport } from '../src/publish.ts';

const event = process.env['GITHUB_EVENT_NAME'] ?? '';
if (event.startsWith('pull_request') || process.env['GITHUB_HEAD_REF']) throw new Error('refusing to publish from a pull request run');
const [file, repoArg] = process.argv.slice(2);
if (!file) throw new Error('usage: publish-report.ts <report.json> [owner/repo]');
const repo = repoArg ?? process.env['GITHUB_REPOSITORY'] ?? 'macdarenz-droid/Meme-snipe';
const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required');

const body = readFileSync(file, 'utf8');
const report = JSON.parse(body) as Record<string, unknown>;
// The same top-level promises UI-2 checks: version 1, backtest only, no holdout anywhere.
if (report['schemaVersion'] !== 1 || report['mode'] !== 'backtest') throw new Error('not a version-1 backtest report');
if (/holdout/i.test(body)) throw new Error('the report mentions a holdout; holdout numbers never leave the sealed ledger');
if (!/^[0-9a-f]{40}$/.test(String(report['codeCommit']))) throw new Error('codeCommit must be a full commit hash');

const api: Api = async (path, init = {}) =>
  fetch(path.startsWith('http') ? path : `https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.headers ?? {}) },
  });

// Uploads under another name first, then swaps it in: a failed publish never loses the published report.
await publishReport(api, body);
console.log(`published ${file} as https://github.com/${repo}/releases/download/backtest/${LATEST}`);
