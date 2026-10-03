// RUG-1c validation run (docs/DECISIONS.md "Rug labels"): fetches the first-day history of each launch from public
// RPC, analyses it (src/research/rug-validate.ts) and writes a JSON report with the minimum-peak sweep and the misses.
// The config value for collapse.minPeakLamports is set only from runs on practice days; other runs are development.
//
//   node --no-warnings packages/worker/scripts/rug-validate.ts <mints.txt> <out.json> [cacheDir] [maxTxs]
//
// mints.txt: one mint per line, each launched more than 24 h before the run. SOLANA_RPC overrides the public endpoint.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { TRIAL_POLICY } from '../../core/src/config/policy.ts';
import { analyzeLaunch, collapses, collapsesSustained, misses, sustainedPeak, sweep, type FullRpcTransaction, type LaunchReport } from '../src/research/rug-validate.ts';

const [mintsFile, outFile, cacheDir = '.rug-validate-cache', maxArg = '3000'] = process.argv.slice(2);
if (mintsFile === undefined || outFile === undefined) throw new Error('usage: rug-validate.ts <mints.txt> <out.json> [cacheDir] [maxTxs]');
const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const MAX = Number(maxArg);
mkdirSync(cacheDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  for (let i = 0; ; i++) {
    calls++;
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if ((res.status === 429 || res.status >= 500) && i < 9) {
      await sleep(500 * 2 ** i);
      continue;
    }
    const j = (await res.json()) as { result?: T; error?: { code?: number } };
    if (j.error !== undefined) {
      if ((j.error.code === -32005 || j.error.code === 429) && i < 9) {
        await sleep(500 * 2 ** i);
        continue;
      }
      throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    }
    return j.result as T;
  }
};
const tx = async (sig: string): Promise<FullRpcTransaction | null> => {
  const f = join(cacheDir, `${sig}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as FullRpcTransaction | null;
  const t = await rpc<FullRpcTransaction | null>('getTransaction', [sig, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
  writeFileSync(f, JSON.stringify(t));
  return t;
};

type Sig = { signature: string; err: unknown; blockTime: number | null };
const window = Math.max(RUG_CONFIG.creatorDump.windowMs, RUG_CONFIG.collapse.windowMs);
const reports: LaunchReport[] = [];
const excluded: { mint: string; reason: string }[] = [];
for (const mint of readFileSync(mintsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) {
  try {
    const sigs: Sig[] = [];
    for (let before: string | undefined; ;) {
      const page = await rpc<Sig[]>('getSignaturesForAddress', [mint, { limit: 1000, commitment: 'finalized', ...(before ? { before } : {}) }]);
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page.at(-1)!.signature;
    }
    const ordered = sigs.reverse().filter((s) => s.err === null);
    const t0 = (ordered[0]?.blockTime ?? 0) * 1_000;
    if (Date.now() - t0 <= window) {
      excluded.push({ mint, reason: 'window not closed' });
      continue;
    }
    const inWindow = ordered.filter((s) => (s.blockTime ?? 0) * 1_000 <= t0 + window);
    if (inWindow.length > MAX) {
      excluded.push({ mint, reason: `${inWindow.length} transactions in the window, above ${MAX}` });
      continue;
    }
    const txs: { signature: string; rpc: FullRpcTransaction }[] = [];
    for (const s of inWindow) {
      const t = await tx(s.signature);
      if (t !== null) txs.push({ signature: s.signature, rpc: t });
    }
    const r = analyzeLaunch(txs, RUG_CONFIG);
    if (r === null) excluded.push({ mint, reason: 'no create in its history' });
    else reports.push(r);
    console.log(mint, r === null ? 'no create' : `${r.transactions} txs, dump ${r.creatorDumpAtMs !== null}, loss ${r.executableLoss}`);
  } catch (e) {
    // An RPC refusal or failure excludes the launch with its reason; it is never read as a clean launch.
    excluded.push({ mint, reason: e instanceof Error ? e.message : 'history read failed' });
  }
}

// Contemporaneous USD for each peak: the close of the last Coinbase SOL-USD hourly candle closed before the peak.
const HOUR = 3_600_000;
const closes = new Map<number, number>();
const peakHours = [...new Set(reports.flatMap((r) => (r.peakAtMs === null ? [] : [Math.floor(r.peakAtMs / HOUR) * HOUR - HOUR])))].sort((a, b) => a - b);
for (let i = 0; i < peakHours.length;) {
  const start = peakHours[i]!;
  const end = start + 300 * HOUR;
  const res = await fetch(`https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end - 1).toISOString()}`, { headers: { 'user-agent': 'zeroed-research' } });
  if (res.ok) for (const c of (await res.json()) as [number, number, number, number, number, number][]) closes.set(c[0] * 1_000, c[4]);
  while (i < peakHours.length && peakHours[i]! < end) i++;
}
const usd = (r: LaunchReport): number | null => {
  if (r.peakAtMs === null) return null;
  const close = closes.get(Math.floor(r.peakAtMs / HOUR) * HOUR - HOUR);
  return close === undefined ? null : (Number(r.peak) / 1e9) * close;
};
const q = (xs: number[], p: number): number | null => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]!);
const collapsedOnly = reports.filter((r) => r.creatorDumpAtMs === null && collapses(r, RUG_CONFIG, 0n));
const describe = (rs: LaunchReport[]) => {
  const sol = rs.map((r) => Number(r.peak) / 1e9);
  const cost = rs.flatMap((r) => (r.peakExitCostBps === null ? [] : [Number(r.peakExitCostBps)]));
  return {
    n: rs.length,
    peakSol: { p10: q(sol, 0.1), median: q(sol, 0.5), p90: q(sol, 0.9) },
    peakUsdMedian: q(rs.flatMap((r) => { const u = usd(r); return u === null ? [] : [u]; }), 0.5),
    exitCostBps: { median: q(cost, 0.5), p90: q(cost, 0.9) },
    material: rs.filter((r) => r.peakExitCostBps !== null && Number(r.peakExitCostBps) <= RUG_CONFIG.materiality.maxExitCostBps).length,
    oneTransactionSpikes: rs.filter((r) => r.afterPeakBps !== null && r.afterPeakBps <= 10_000 - RUG_CONFIG.collapse.dropBps).length,
  };
};
const SOL = 1_000_000_000n;
const minPeaks = [0n, SOL / 10n, SOL / 2n, SOL, 5n * SOL, 20n * SOL];
const out = {
  config: RUG_CONFIG.version, rpc: RPC.replace(/api-key=[^&]+/, 'api-key=…'), ranAt: new Date().toISOString(), calls,
  launches: reports.length, excluded,
  sweeps: Object.fromEntries([['loss>=0.1SOL', SOL / 10n], ['loss>=1SOL', SOL]].map(([name, loss]) => [name, sweep(reports, RUG_CONFIG, minPeaks, loss as bigint)])),
  misses: misses(reports, RUG_CONFIG),
  collapses: { collapseOnly: describe(collapsedOnly), all: describe(reports) },
  // Candidate materiality rule: the collapse counts when the sustained reserve before it reached H8's dust line.
  sustainedRule: {
    lineLamports: String(TRIAL_POLICY.gates.dustPoolMinAtMigration),
    collapseLabels: reports.filter((r) => collapses(r, RUG_CONFIG, 0n)).length,
    materialBySustained: reports.filter((r) => collapsesSustained(r, RUG_CONFIG, BigInt(TRIAL_POLICY.gates.dustPoolMinAtMigration))).length,
    materialByExitCost: reports.filter((r) => collapses(r, RUG_CONFIG, 0n) && r.peakExitCostBps !== null && Number(r.peakExitCostBps) <= RUG_CONFIG.materiality.maxExitCostBps).length,
  },
  reports: reports.map((r) => ({ ...r, peakUsd: usd(r), sustainedPeak: String(sustainedPeak(r)) })),
};
writeFileSync(outFile, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${reports.length} launches (${excluded.length} excluded) with ${calls} calls`);
