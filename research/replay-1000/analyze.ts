// REPLAY-1000: one run's results from the bot's own journal: each full coin's decision (entered, or refused with the
// gate and reason it was last refused for), and each trade's entry and exit with SOL in and out, fees and net SOL.
//   node research/replay-1000/analyze.ts <run-dir> <coins.json> [label]
// Writes <run-dir>/result.json and prints the summary.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunCoin } from './run.ts';

type Line = Record<string, unknown> & { kind: string; ts: string };
const LAMPORTS = 1_000_000_000;

export interface Trade {
  readonly mint: string;
  readonly trade: string;
  readonly entryAt: string;
  readonly exitAt: string | null;
  /** Lamports paid on entry (fills' `sol`) and received on exit, and their fees, from the entry and exit lines. */
  readonly solIn: bigint;
  readonly solOut: bigint;
  readonly fees: bigint;
  readonly tokens: bigint;
  /** Entry and exit prices, lamports per raw token unit × 1e9 (solIn / tokens). */
  readonly entryPrice: number;
  readonly exitPrice: number | null;
  readonly exitReasons: readonly string[];
  /** Net lamports: out − in − fees (rent is in the account's closed trade when the account reports it). */
  readonly net: bigint;
  readonly closed: boolean;
}

export interface CoinResult {
  readonly mint: string;
  readonly decision: 'entered' | 'refused' | 'not-evaluated';
  readonly gate: string | null;
  readonly code: string | null;
  readonly reason: string | null;
  /** Every gate and code of its first and last rejections (a coin usually fails several). */
  readonly all?: readonly string[];
}

const big = (v: unknown): bigint => (typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v) : typeof v === 'number' ? BigInt(v) : 0n);

export const analyze = (runDir: string, coins: readonly RunCoin[]) => {
  const lines = readFileSync(join(runDir, 'state', 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Line);
  const full = new Set(coins.map((c) => c.mint));
  const last = new Map<string, Line>();
  const first = new Map<string, Line>();
  const entries: Line[] = [];
  const exits: Line[] = [];
  for (const l of lines) {
    if (l.kind === 'entry') entries.push(l);
    if (l.kind === 'exit') exits.push(l);
    if (l.kind !== 'decision') continue;
    const r = l['reasons'] as string[] | undefined;
    const mint = r?.[2];
    if (mint === undefined || !full.has(mint)) continue;
    // The last typed rejection (a window's end line repeats its reason without the typed list).
    if (l['action'] === 'reject') {
      last.set(mint, l);
      if (!first.has(mint)) first.set(mint, l);
    }
    else if (r?.[0] === 'no entry' && !last.has(mint)) last.set(mint, l);
  }
  const trades: Trade[] = entries.filter((e) => full.has(String(e['mint']))).map((e) => {
    const trade = String(e['trade']);
    const xs = exits.filter((x) => x['trade'] === trade);
    const solIn = big(e['sol']);
    const tokens = big(e['tokens']);
    const solOut = xs.reduce((s, x) => s + big(x['sol']), 0n);
    const fees = big(e['fees']) + xs.reduce((s, x) => s + big(x['fees']), 0n);
    const xTokens = xs.reduce((s, x) => s + big(x['tokens']), 0n);
    const closed = xs.some((x) => x['position'] === 'closed');
    return {
      mint: String(e['mint']), trade, entryAt: e.ts, exitAt: xs.at(-1)?.ts ?? null, solIn, solOut, fees, tokens,
      entryPrice: tokens === 0n ? 0 : Number(solIn) / Number(tokens), exitPrice: xTokens === 0n ? null : Number(solOut) / Number(xTokens),
      exitReasons: (xs.at(-1)?.['reasons'] as string[] | undefined) ?? [], net: solOut - solIn - fees, closed,
    };
  });
  const entered = new Set(trades.map((t) => t.mint));
  const results: CoinResult[] = coins.map((c) => {
    if (entered.has(c.mint)) return { mint: c.mint, decision: 'entered', gate: null, code: null, reason: null };
    const l = last.get(c.mint);
    if (l === undefined) return { mint: c.mint, decision: 'not-evaluated', gate: null, code: null, reason: null };
    const gs = (l['gate_reasons'] as { gate?: string; code?: string; input?: string; neededBy?: string }[] | undefined) ?? [];
    const g = gs[0];
    const r = l['reasons'] as string[];
    return {
      mint: c.mint, decision: 'refused', gate: g === undefined ? null : `${g.gate ?? '?'}${g.neededBy !== undefined ? `/${g.neededBy}` : ''}`, code: g?.code ?? null, reason: r[3] ?? r[0] ?? null,
      all: [...new Set([...((first.get(c.mint)?.['gate_reasons'] as typeof gs | undefined) ?? []), ...gs].map((x) => `${x.gate ?? '?'}:${x.code ?? '?'}`))],
    };
  });
  const closed = trades.filter((t) => t.closed);
  const nets = closed.map((t) => Number(t.net) / LAMPORTS);
  const mean = nets.length === 0 ? null : nets.reduce((a, b) => a + b, 0) / nets.length;
  const sd = nets.length < 2 || mean === null ? null : Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / (nets.length - 1));
  const half = sd === null ? null : 1.96 * sd / Math.sqrt(nets.length);
  const byGate: Record<string, number> = {};
  const firstGate: Record<string, number> = {};
  const anyGate: Record<string, number> = {};
  for (const r of results) {
    if (r.decision !== 'refused') continue;
    byGate[`${r.gate}:${r.code}`] = (byGate[`${r.gate}:${r.code}`] ?? 0) + 1;
    for (const k of r.all ?? []) anyGate[k] = (anyGate[k] ?? 0) + 1;
    // The coin's first rejection: a late re-check (hours after the migration) can fail for facts no longer held.
    const g = ((first.get(r.mint)?.['gate_reasons'] as { gate?: string; code?: string }[] | undefined) ?? [])[0];
    const k = g === undefined ? 'untyped' : `${g.gate ?? '?'}:${g.code ?? '?'}`;
    firstGate[k] = (firstGate[k] ?? 0) + 1;
  }
  return {
    coins: coins.length, entered: entered.size, refused: results.filter((r) => r.decision === 'refused').length, notEvaluated: results.filter((r) => r.decision === 'not-evaluated').length,
    refusalsByGate: Object.fromEntries(Object.entries(byGate).sort((a, b) => b[1] - a[1])),
    firstRefusalsByGate: Object.fromEntries(Object.entries(firstGate).sort((a, b) => b[1] - a[1])),
    coinsFailingEachGate: Object.fromEntries(Object.entries(anyGate).sort((a, b) => b[1] - a[1])),
    trades: trades.length, closedTrades: closed.length, wins: closed.filter((t) => t.net > 0n).length,
    winRate: closed.length === 0 ? null : closed.filter((t) => t.net > 0n).length / closed.length,
    meanNetSol: mean, ci95: half === null || mean === null ? null : [mean - half, mean + half], totalNetSol: nets.reduce((a, b) => a + b, 0),
    shortOf300: Math.max(0, 300 - closed.length),
    results, tradeRows: trades,
  };
};

const main = () => {
  const [runDir, coinsFile] = process.argv.slice(2);
  const coins = JSON.parse(readFileSync(coinsFile!, 'utf8')) as RunCoin[];
  const r = analyze(runDir!, coins);
  writeFileSync(join(runDir!, 'result.json'), JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  const { results: _r, tradeRows, ...summary } = r;
  console.log(JSON.stringify(summary, null, 1));
  for (const t of tradeRows) console.log(`${t.mint.slice(0, 8)} ${t.entryAt} -> ${t.exitAt} in ${t.solIn} out ${t.solOut} fees ${t.fees} net ${t.net} ${t.exitReasons.slice(0, 3).join(' | ')}`);
};

if (process.argv[1] === new URL(import.meta.url).pathname) main();
