// A-M13-01 Phase 0 measurement study, the parts that run (card Z09; SPEC-A "Parked parts", card Z-H-OF round 2;
// MR-01 parked, C-76). Built: step 1 (the window), step 4 (the hurdle per size, at $5, $20, $100, $1,000 and $10,000,
// as INFORMATION ONLY: no move rule reads it, so it decides nothing), step 6 (A-48: compressed bytes per stream per
// day and the 30-day disk projection), step 7 (caveats) and step 8 (the study days stay outside `W_B`). Not built:
// steps 2, 3 and 5 (A-24, A-24b and their rules; parked) and step 9 (the kill-only check; MR-01 is parked, so it has
// nothing to stop). PM-01 has no Phase 0 check (round 3 item 26). The report says all of this in `parked` and in the
// caveats.
//
// Profit and cost are in SOL (lamports); dollar sizes are converted at the recorded SOL/USD of D1 (`hurdle.solUsd`).
// The report is a pure function of its inputs and its renderings hold no clock, so the same inputs give the same
// bytes (acceptance: reproducible byte-for-byte).
//
// Builder readings (DECISIONS Z09-R1, Z09-R2):
// - the strict and conservative rows shown for a size are those of the lean-median pool (the pool step 4 names);
// - the strict row needs the strategy's slippage bounds: PM-01's pre-registered 150 / 300 bps
//   (research/pm01/PREREG.md line 69 @ 3bde178), the stage's strategy now that MR-01 is parked.
import { fixedCostBpsPerTrade, isUnpriced, sensitivityBps, SWEEP_USD, usdToLamports, type CostRows, type PoolPricing, type SweepRowParts, fixedLamportsOf, DEPTH_CAP_BPS } from '../m10/costs.ts';
import type { SimParamSet } from '../m10/params.ts';
import type { UniverseManifestFile } from '../m05/manifest.ts';
import { costRows } from '../m10/costs.ts';
import { cmp } from '../m05/manifest.ts';

const cmpBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

const DAY = 86_400_000;
const BPS = 10_000n;
/** ARCH M07, A-27: the disk minimum the projection is compared with (decimal GB). */
export const DISK_MINIMUM_BYTES = 50_000_000_000;
export const FEATURE_WARMUP_MS = 6 * 3_600_000;
export const POOL_AGE_MS = 24 * 3_600_000;
export const WINDOW_GOOD_DAYS = 7;
export const WINDOW_MAX_DAYS = 14;
export const FIXED_MONTHLY_USD = [10, 12, 59] as const;
export const TRADES_PER_DAY = [1, 2, 5, 10, 20] as const;
/** PM-01 PREREG (research/pm01/PREREG.md:69 @ 3bde178): entry 150 bps, exit 300 bps. */
export const PM01_SLIPPAGE = { entryBps: 150, exitBps: 300, source: 'research/pm01/PREREG.md:69 @ 3bde178' } as const;

export interface Phase0Day { dayUtc: string; lowCoverage: boolean; manifest: UniverseManifestFile | null }
export interface StreamDayBytes { dayUtc: string; stream: string; codec: 'zstd' | 'gzip'; compressedBytes: number; decodedBytes: number | null }
/**
 * One eligible snapshot state of a pool on a good day: its min(real, effective) quote and its pricing at that state.
 * `weight` is the number of polls that returned it (the recorder keeps changed snapshots only, so a state stands for
 * every poll until the next change; default 1).
 */
export interface PoolState { poolId: string; dayUtc: string; minDepthLamports: bigint; pricing: PoolPricing; weight?: number }

export interface Phase0Input {
  /** R0: the recorder's first snapshot. */
  r0Ms: number;
  days: readonly Phase0Day[];
  streams: readonly StreamDayBytes[];
  poolStates: readonly PoolState[];
  /** The recorded SOL/USD of D1 (null: not recorded, the hurdle is not computed); required, never a default (Z09-5). */
  solUsdD1: number | null;
  /** Where `solUsdD1` came from (printed in the report, Z09-5). */
  solUsdSource: string;
  simParams: SimParamSet;
  slippage?: { entryBps: number; exitBps: number; source: string };
}

export interface HurdleRow {
  sizeUsd: number; sizeLamports: string; poolsInSet: number; subset: boolean; medianPool: string | null;
  gStarBpsLean: number | null; gStarBpsStrict: number | null; gStarBpsConservative: number | null;
  lean: SweepRowParts | null; strict: SweepRowParts | null; conservative: SweepRowParts | null;
  sensitivityBps: number;
  fixedTermBps: Record<'usd10' | 'usd12' | 'usd59', Record<'1' | '2' | '5' | '10' | '20', number>>;
}
export interface Phase0Report {
  window: { r0Ms: number; d1: string; days: string[]; goodDays: string[]; lowCoverageDays: string[]; status: 'ok' | 'insufficient_days' };
  parked: { a24: 'parked'; a24b: 'parked'; moveRule: 'parked'; killCheck: 'not_run_mr01_parked'; pm01: 'no_phase0_check' };
  hurdle: { solUsd: number | null; solUsdSource: string; slippage: { entryBps: number; exitBps: number; source: string }; decides: false; bySize: HurdleRow[] };
  a48: Array<{ stream: string; bytesPerDayCompressed: number; codec: 'zstd' | 'gzip'; ratio: number | null }>;
  diskProjection30dBytes: number; diskMinimumBytes: number; diskWithinMinimum: boolean;
  wB: { excludedDays: string[] };
  caveats: string[];
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Step 1: D1 is the first full UTC day starting at or after R0 + 30 h; the window grows from D1-D7 to 7 good days, up to D14. */
export function studyWindow(r0Ms: number, days: readonly Phase0Day[]): Phase0Report['window'] {
  const start = r0Ms + FEATURE_WARMUP_MS + POOL_AGE_MS;
  const d1Ms = Math.ceil(start / DAY) * DAY;
  const byDay = new Map(days.map((d) => [d.dayUtc, d]));
  const inWindow: string[] = [], good: string[] = [], low: string[] = [];
  for (let k = 0; k < WINDOW_MAX_DAYS; k++) {
    const day = iso(d1Ms + k * DAY);
    const d = byDay.get(day);
    inWindow.push(day);
    if (d !== undefined && !d.lowCoverage && d.manifest !== null) good.push(day); else low.push(day);
    if (k + 1 >= WINDOW_GOOD_DAYS && good.length >= WINDOW_GOOD_DAYS) break;
  }
  return { r0Ms, d1: iso(d1Ms), days: inWindow, goodDays: good, lowCoverageDays: low, status: good.length >= WINDOW_GOOD_DAYS ? 'ok' : 'insufficient_days' };
}

/** `M_lamports = ceil(M_usd ÷ solUsd × 10^9)` (ruling Z0D round 4), with the price taken to 6 decimals. */
export function usdMonthlyToLamports(usd: number, solUsd: number): bigint {
  const s = BigInt(Math.round(solUsd * 1_000_000));
  if (s <= 0n) throw { code: 'E_INVALID_ARG' };
  const num = BigInt(Math.round(usd * 1_000_000)) * 1_000_000_000n;
  return (num + s - 1n) / s;
}

const lowerMiddle = <T>(xs: readonly T[]): T => xs[Math.floor((xs.length - 1) / 2)] as T;
/** The lower-middle element when each state counts `weight` times (a positive integer; anything else counts once). */
function weightedLowerMiddle(xs: readonly PoolState[]): PoolState {
  const w = (s: PoolState): number => (Number.isSafeInteger(s.weight) && (s.weight as number) > 0 ? (s.weight as number) : 1);
  const total = xs.reduce((a, s) => a + w(s), 0);
  const k = Math.floor((total - 1) / 2);
  let seen = 0;
  for (const s of xs) {
    seen += w(s);
    if (seen > k) return s;
  }
  return xs[xs.length - 1] as PoolState;                                             // not reached: seen ends at total > k
}

function partsOf(rows: CostRows, size: bigint): { lean: SweepRowParts; strict: SweepRowParts; conservative: SweepRowParts } {
  const bps = (l: bigint): number => Number((l * BPS + size - 1n) / size);
  const p = (b: CostRows['lean']): SweepRowParts => ({ venueFeesBps: bps(b.venueFeesLamports), impactBps: bps(b.impactLamports), fixedBps: bps(fixedLamportsOf(b)),
    otherBps: bps(b.sandwichLamports + b.stuckLamports), gStarBps: b.gStarBps } as SweepRowParts);
  return { lean: p(rows.lean), strict: p(rows.strict), conservative: p(rows.conservative) };
}

/** Step 4 at one size: the pool set that passes the depth cap at its median-depth state, and its lean-median pool. */
function hurdleAt(sizeUsd: number, solUsd: number, medianStates: ReadonlyArray<{ poolId: string; state: PoolState }>, set: SimParamSet, slip: { entryBps: number; exitBps: number }): HurdleRow {
  const size = usdToLamports(sizeUsd, solUsd);
  const priced: Array<{ poolId: string; rows: CostRows }> = [];
  for (const { poolId, state } of medianStates) {
    if (size * BPS > state.minDepthLamports * DEPTH_CAP_BPS) continue;              // depth cap: 0.5% of min(real, effective)
    const r = costRows(state.pricing, size, set, { slippage: slip });
    if (!r.ok || isUnpriced(r.value)) continue;
    priced.push({ poolId, rows: r.value });
  }
  priced.sort((a, b) => a.rows.lean.gStarBps - b.rows.lean.gStarBps || cmp(a.poolId, b.poolId));
  const med = priced.length === 0 ? null : lowerMiddle(priced);
  const term = (usd: number): Record<'1' | '2' | '5' | '10' | '20', number> => {
    const m = usdMonthlyToLamports(usd, solUsd);
    return Object.fromEntries(TRADES_PER_DAY.map((t) => [String(t), fixedCostBpsPerTrade(m, t, size)])) as Record<'1' | '2' | '5' | '10' | '20', number>;
  };
  const parts = med === null ? null : partsOf(med.rows, size);
  return {
    sizeUsd, sizeLamports: size.toString(), poolsInSet: priced.length, subset: priced.length < 10, medianPool: med?.poolId ?? null,
    gStarBpsLean: med?.rows.lean.gStarBps ?? null, gStarBpsStrict: med?.rows.strict.gStarBps ?? null, gStarBpsConservative: med?.rows.conservative.gStarBps ?? null,
    lean: parts?.lean ?? null, strict: parts?.strict ?? null, conservative: parts?.conservative ?? null,
    sensitivityBps: sensitivityBps(size), fixedTermBps: { usd10: term(10), usd12: term(12), usd59: term(59) },
  };
}

export function phase0Report(i: Phase0Input): Phase0Report {
  const window = studyWindow(i.r0Ms, i.days);
  const good = new Set(window.goodDays);
  const slip = i.slippage ?? PM01_SLIPPAGE;
  // Each pool's median-depth state over its eligible snapshots on the good days (lower middle for an even count).
  const byPool = new Map<string, PoolState[]>();
  for (const s of i.poolStates) {
    if (!good.has(s.dayUtc)) continue;
    const l = byPool.get(s.poolId);
    if (l === undefined) byPool.set(s.poolId, [s]); else l.push(s);
  }
  const medianStates = [...byPool].sort((a, b) => cmp(a[0], b[0])).map(([poolId, l]) => {
    const sorted = [...l].sort((a, b) => cmpBig(a.minDepthLamports, b.minDepthLamports) || cmp(a.dayUtc, b.dayUtc));
    return { poolId, state: weightedLowerMiddle(sorted) };
  });
  const bySize = i.solUsdD1 === null ? [] : SWEEP_USD.map((usd) => hurdleAt(usd, i.solUsdD1 as number, medianStates, i.simParams, slip));
  // Step 6: per stream, the mean compressed bytes per window day that holds data, and the ratio where decoded is known.
  const inWindow = new Set(window.days);
  const streams = new Map<string, { codec: 'zstd' | 'gzip'; bytes: number; decoded: number; decodedKnown: boolean; days: Set<string> }>();
  for (const s of i.streams) {
    if (!inWindow.has(s.dayUtc)) continue;
    const x = streams.get(s.stream) ?? { codec: s.codec, bytes: 0, decoded: 0, decodedKnown: true, days: new Set<string>() };
    x.bytes += s.compressedBytes;
    if (s.decodedBytes === null) x.decodedKnown = false; else x.decoded += s.decodedBytes;
    x.days.add(s.dayUtc);
    if (s.codec === 'zstd') x.codec = 'zstd';
    streams.set(s.stream, x);
  }
  const a48 = [...streams].sort((a, b) => cmp(a[0], b[0])).map(([stream, x]) => ({
    stream, codec: x.codec, bytesPerDayCompressed: Math.ceil(x.bytes / Math.max(1, x.days.size)),
    ratio: x.decodedKnown && x.bytes > 0 ? Math.round((x.decoded / x.bytes) * 100) / 100 : null,
  }));
  const projection = 30 * a48.reduce((s, x) => s + x.bytesPerDayCompressed, 0);
  const caveats = [
    'A-24, A-24b and their rules are parked (card Z-H-OF round 2): no universe count decision and no move rule is computed.',
    'The kill-only check (step 9) is not run: MR-01 is parked (C-76, owner 2026-10-08), so there is nothing for it to stop.',
    'PM-01 has no Phase 0 check; its first evidence is gate B on W_B.',
    'The hurdle by size is information only and decides nothing; the lean row is a lower bound on costs, the conservative row binds B-2 and R-2 (ARCH 2.3).',
    'Eligibility is prefilter-only (phase0_unscreened): every eligible count is an upper bound before screening.',
    'Enumeration coverage is migrations_since_start: pools that migrated before the recorder started are not in the universe (D30 parked).',
    `Strict and conservative rows use PM-01's pre-registered slippage bounds (${slip.entryBps} / ${slip.exitBps} bps; ${slip.source}).`,
    'A size whose result rests on fewer than 10 distinct pools is labelled (subset).',
  ];
  if (window.status === 'insufficient_days') caveats.push('Fewer than 7 good days by D14: insufficient_days, no decision.');
  if (i.solUsdD1 === null) caveats.push('No recorded SOL/USD for D1: the hurdle by size is not computed.');
  return {
    window,
    parked: { a24: 'parked', a24b: 'parked', moveRule: 'parked', killCheck: 'not_run_mr01_parked', pm01: 'no_phase0_check' },
    hurdle: { solUsd: i.solUsdD1, solUsdSource: i.solUsdSource, slippage: { ...slip }, decides: false, bySize },
    a48, diskProjection30dBytes: projection, diskMinimumBytes: DISK_MINIMUM_BYTES, diskWithinMinimum: projection <= DISK_MINIMUM_BYTES,
    wB: { excludedDays: [...window.days] },
    caveats,
  };
}

const n = (v: number | null): string => (v === null ? '-' : String(v));
/** Lamports as SOL with 9 decimals, trailing zeros cut (exact, no floating point). */
const sol = (l: bigint): string => {
  const s = l.toString().padStart(10, '0');
  const frac = s.slice(-9).replace(/0+$/, '');
  return `${s.slice(0, -9)}${frac === '' ? '' : `.${frac}`}`;
};
const thousands = (v: number): string => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `docs/phase0/report-<date>.md`: the report as a person reads it (no clock, so reproducible). */
export function renderPhase0Markdown(r: Phase0Report): string {
  const L: string[] = [];
  L.push(`# Phase 0 report ${r.window.d1}`, '');
  L.push('## Window', '', `- R0: ${new Date(r.window.r0Ms).toISOString()}`, `- D1: ${r.window.d1}; status: ${r.window.status}`,
    `- Days: ${r.window.days.join(', ')}`, `- Good days: ${r.window.goodDays.length}`, `- Low coverage or missing: ${r.window.lowCoverageDays.join(', ') || 'none'}`, '');
  L.push('## Not run', '', '- A-24 and A-24b: parked', '- Move rule: parked', '- Kill-only check: not run (MR-01 parked, C-76)', '- PM-01: no Phase 0 check', '');
  L.push('## Hurdle by size', '', `SOL/USD of D1: ${n(r.hurdle.solUsd)} (${r.hurdle.solUsdSource}). Information only: decides nothing. Sizes in SOL, the dollar amount as a label; costs in bps of the trade.`, '',
    '| Size | Pools | Median pool | Lean g* | Strict g* | Conservative g* | Lean fees | Lean impact | Lean fixed | 414,009 line | $10 at 10/day |',
    '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const h of r.hurdle.bySize) {
    L.push(`| ${sol(BigInt(h.sizeLamports))} SOL ($${thousands(h.sizeUsd)})${h.subset ? ' (subset)' : ''} | ${h.poolsInSet} | ${h.medianPool ?? '-'} | ${n(h.gStarBpsLean)} | ${n(h.gStarBpsStrict)} | ${n(h.gStarBpsConservative)} | ${n(h.lean?.venueFeesBps ?? null)} | ${n(h.lean?.impactBps ?? null)} | ${n(h.lean?.fixedBps ?? null)} | ${h.sensitivityBps} | ${h.fixedTermBps.usd10['10']} |`);
  }
  L.push('', '## Disk (A-48)', '', '| Stream | Codec | Bytes a day | Ratio |', '|---|---|---|---|');
  for (const a of r.a48) L.push(`| ${a.stream} | ${a.codec} | ${a.bytesPerDayCompressed} | ${n(a.ratio)} |`);
  L.push('', `30-day projection: ${r.diskProjection30dBytes} bytes against the ${r.diskMinimumBytes}-byte minimum (${r.diskWithinMinimum ? 'within' : 'above'}).`, '');
  L.push('## W_B', '', `The study days stay outside W_B: ${r.wB.excludedDays.join(', ')}.`, '');
  L.push('## Caveats', '', ...r.caveats.map((c) => `- ${c}`), '');
  return L.join('\n');
}

/** The CSVs beside the report: one row per size and row, and one per stream. */
export function renderPhase0Csv(r: Phase0Report): { hurdle: string; a48: string } {
  const h = ['size_usd,size_lamports,pools_in_set,subset,median_pool,row,venue_fees_bps,impact_bps,fixed_bps,other_bps,g_star_bps,sensitivity_bps'];
  for (const x of r.hurdle.bySize) {
    for (const row of ['lean', 'strict', 'conservative'] as const) {
      const p = x[row];
      h.push([x.sizeUsd, x.sizeLamports, x.poolsInSet, x.subset, x.medianPool ?? '', row, n(p?.venueFeesBps ?? null), n(p?.impactBps ?? null), n(p?.fixedBps ?? null), n(p?.otherBps ?? null), n(p?.gStarBps ?? null), x.sensitivityBps].join(','));
    }
  }
  const a = ['stream,codec,bytes_per_day_compressed,ratio', ...r.a48.map((x) => [x.stream, x.codec, x.bytesPerDayCompressed, n(x.ratio)].join(','))];
  return { hurdle: `${h.join('\n')}\n`, a48: `${a.join('\n')}\n` };
}
