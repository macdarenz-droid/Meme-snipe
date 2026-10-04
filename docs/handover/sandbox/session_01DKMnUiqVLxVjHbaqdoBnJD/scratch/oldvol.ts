// Volume-hours cross-check (DATA-1c; research/historical/scanner/volume.go). The scanner writes each day's regime
// volume per hour from its hourly census; this re-derives it from the kept trade rows of the day's units, which hold
// every curve trade and every canonical PumpSwap pool trade (retention curve-all,canonical-all), and requires an exact
// match in every hour:
//   - curve rows quoted in SOL (quote_mint empty, the system program or WSOL): sol_amount;
//   - amm rows with quote_mint WSOL whose pool is the canonical pool of (base_mint, WSOL), derived here with the
//     shared chain code (poolAddress(0, pumpPoolAuthority(base), base, WSOL)): quote_amount;
//   buys plus sells, by the row's block hour. Every other row is excluded, never converted.
// Also checked: 24 rows, consecutive hours of the day, covered 0 or 1, and every hour covered on a complete day.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { poolAddress, pumpPoolAuthority, toAddress } from '../../../core/src/chain/index.ts';
import { csvObjects } from './parity.ts';

export const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const HOUR_S = 3600;

export interface VolumeCheck {
  day: string;
  hours: number;
  hours_covered: number;
  hours_matched: number;
  lamports_total: string;
  mismatches: { hour_start_ms: string; volume_hours: string | null; rederived: string }[];
  problems: string[];
}

const canonicalCache = new Map<string, boolean>();
export const isCanonicalWsolPool = (pool: string, base: string): boolean => {
  const k = `${pool}|${base}`;
  let v = canonicalCache.get(k);
  if (v === undefined) {
    try {
      const b = toAddress(base);
      v = poolAddress(0, pumpPoolAuthority(b), b, toAddress(WSOL)) === pool;
    } catch {
      v = false;
    }
    canonicalCache.set(k, v);
  }
  return v;
};

/** Adds one unit's kept trade rows to `sums` (hour start in seconds -> lamports). */
export const addTradeRows = (sums: Map<number, bigint>, curve: readonly Record<string, string>[], amm: readonly Record<string, string>[]): void => {
  const add = (bt: string | undefined, v: string | undefined) => {
    const t = Number(bt);
    const h = t - (t % HOUR_S);
    sums.set(h, (sums.get(h) ?? 0n) + BigInt(v || '0'));
  };
  for (const r of curve) {
    const q = r.quote_mint ?? '';
    if (q === '' || q === SYSTEM_PROGRAM || q === WSOL) add(r.block_time, r.sol_amount);
  }
  for (const r of amm) {
    if (r.quote_mint === WSOL && r.pool && r.base_mint && isCanonicalWsolPool(r.pool, r.base_mint)) add(r.block_time, r.quote_amount);
  }
};

/** Compares a day's volume_hours rows with the sums re-derived from the units' rows. */
export const compareVolumeHours = (day: string, rows: readonly Record<string, string>[], sums: ReadonlyMap<number, bigint>, dayComplete: boolean): VolumeCheck => {
  const start = Date.parse(`${day}T00:00:00Z`) / 1000;
  const out: VolumeCheck = { day, hours: rows.length, hours_covered: 0, hours_matched: 0, lamports_total: '0', mismatches: [], problems: [] };
  if (rows.length !== 24) out.problems.push(`${rows.length} rows, 24 expected`);
  let total = 0n;
  for (let i = 0; i < 24; i++) {
    const h = start + i * HOUR_S;
    const r = rows[i];
    const want = sums.get(h) ?? 0n;
    total += want;
    if (r === undefined) {
      out.mismatches.push({ hour_start_ms: String(h * 1000), volume_hours: null, rederived: String(want) });
      continue;
    }
    if (r.hour_start_ms !== String(h * 1000)) out.problems.push(`row ${i}: hour_start_ms ${r.hour_start_ms}, ${h * 1000} expected`);
    if (r.covered !== '0' && r.covered !== '1') out.problems.push(`row ${i}: covered ${JSON.stringify(r.covered)}`);
    if (r.covered === '1') out.hours_covered++;
    else if (dayComplete) out.problems.push(`row ${i}: not covered on a complete day`);
    if (r.lamports === String(want)) out.hours_matched++;
    else out.mismatches.push({ hour_start_ms: String(h * 1000), volume_hours: r.lamports ?? null, rederived: String(want) });
  }
  out.lamports_total = String(total);
  return out;
};

const zst = (p: string) => zstdDecompressSync(readFileSync(p)).toString('utf8');

/** Runs the check for `day` of a dataset directory against the units under `unitsDir` (units/<epoch>/<range>/). */
export const runVolumeCheck = (datasetDir: string, unitsDir: string, day: string): VolumeCheck => {
  const dayDir = join(datasetDir, 'days', day);
  const rows = readdirSync(dayDir).filter((f) => f.startsWith('volume_hours-')).sort().flatMap((f) => csvObjects(zst(join(dayDir, f))));
  const man = JSON.parse(readFileSync(join(datasetDir, 'manifest.json'), 'utf8')) as { days?: { day: string; complete: boolean }[] };
  const complete = man.days?.find((d) => d.day === day)?.complete === true;
  const sums = new Map<number, bigint>();
  for (const epoch of readdirSync(unitsDir)) {
    for (const range of readdirSync(join(unitsDir, epoch))) {
      const u = join(unitsDir, epoch, range);
      if (range.endsWith('.tmp') || !existsSync(join(u, 'stats.json'))) continue;
      const read = (f: string) => (existsSync(join(u, f)) ? csvObjects(zst(join(u, f))) : []);
      addTradeRows(sums, read('curve_trades.csv.zst'), read('amm_trades.csv.zst'));
    }
  }
  return compareVolumeHours(day, rows, sums, complete);
};

export const volumeFailed = (c: VolumeCheck): boolean => c.mismatches.length > 0 || c.problems.length > 0;
