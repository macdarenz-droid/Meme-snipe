// REPLAY-1000: REPORT.md's result tables from the runs' result.json files (analyze.ts) and their stress columns.
//   node research/replay-1000/report.ts <label>=<run-dir>[@<commit>] ... > tables.md
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Result {
  coins: number; entered: number; refused: number; notEvaluated: number;
  refusalsByGate: Record<string, number>; coinsFailingEachGate?: Record<string, number>;
  trades: number; closedTrades: number; wins: number; winRate: number | null; meanNetSol: number | null; ci95: [number, number] | null; totalNetSol: number; shortOf300: number;
  tradeRows: { mint: string; entryAt: string; exitAt: string | null; solIn: string; solOut: string; fees: string; net: string; entryPrice: number; exitPrice: number | null; exitReasons: string[]; closed: boolean }[];
  stressed?: { trade: string; net: string; solOut: string; note: string | null }[];
}

const sol = (lamports: string | number): string => (Number(lamports) / 1e9).toFixed(6);
const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

const main = () => {
  const runs = process.argv.slice(2).map((a) => {
    const [label, rest] = a.split('=') as [string, string];
    const [dir, commit] = rest.split('@') as [string, string | undefined];
    return { label, dir, commit: commit ?? '', r: JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Result };
  });
  const out: string[] = [];
  out.push('| Run | Commit | Coins | Entered | Refused | Not evaluated | Trades (closed) | Win rate | Mean net per trade (SOL) | 95% CI | Total net (SOL) | Short of 300 |');
  out.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |');
  for (const { label, commit, r } of runs) {
    out.push(`| ${label} | ${commit} | ${r.coins} | ${r.entered} | ${r.refused} | ${r.notEvaluated} | ${r.trades} (${r.closedTrades}) | ${pct(r.winRate)} | ${r.meanNetSol === null ? 'n/a' : r.meanNetSol.toFixed(6)} | ${r.ci95 === null ? 'n/a' : `${r.ci95[0].toFixed(6)} to ${r.ci95[1].toFixed(6)}`} | ${r.totalNetSol.toFixed(6)} | ${r.shortOf300} |`);
  }
  for (const { label, r } of runs) {
    out.push('', `### ${label}: refusals`, '', 'First gate of each refused coin\'s last rejection, and how many coins failed each gate in it (a coin fails several):', '', '| Gate:code | First | Failed |', '| --- | ---: | ---: |');
    const keys = [...new Set([...Object.keys(r.refusalsByGate), ...Object.keys(r.coinsFailingEachGate ?? {})])];
    for (const k of keys.sort((a, b) => (r.coinsFailingEachGate?.[b] ?? 0) - (r.coinsFailingEachGate?.[a] ?? 0))) out.push(`| ${k} | ${r.refusalsByGate[k] ?? 0} | ${r.coinsFailingEachGate?.[k] ?? 0} |`);
    if (r.tradeRows.length > 0) {
      out.push('', `### ${label}: trades`, '', '| Mint | Entry (UTC) | Exit (UTC) | SOL in | SOL out | Fees | Net (SOL) | Stressed net (SOL) | Exit reason |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
      for (const t of r.tradeRows) {
        const s = r.stressed?.find((x) => x.trade === (t as unknown as { trade: string }).trade);
        out.push(`| ${t.mint} | ${t.entryAt} | ${t.exitAt ?? 'open'} | ${sol(t.solIn)} | ${sol(t.solOut)} | ${sol(t.fees)} | ${sol(t.net)} | ${s === undefined ? 'n/a' : sol(s.net)} | ${(t.exitReasons[1] ?? t.exitReasons[0] ?? '').replace(/\|/g, '/').slice(0, 80)} |`);
      }
    }
  }
  console.log(out.join('\n'));
  void existsSync;
};

if (process.argv[1] === new URL(import.meta.url).pathname) main();
