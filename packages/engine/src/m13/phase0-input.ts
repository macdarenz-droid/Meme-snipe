// A-M13-01 `phase0-report` input: reads a pulled Phase 0 dataset (M07 layout, A-M07-02) on the research machine and
// builds `Phase0Input` (card Z09). Per day it reads the day's index of segment manifests:
// - `universe_manifest`: the day's manifest (its SHA-256 is checked; a manifest that does not match is not used);
// - `coverage`: the day's CoverageReport (`lowCoverage`); a day without one is not good;
// - every stream's compressed bytes (the manifests) and decoded bytes (gzip segments read here; zstd counted unread);
// - `ref_price`: the first SOL/USD price of the day;
// - `pool_snapshot`, `pool_snapshot_tail` and `pool_snapshot_position`: change-only keyframes and deltas, rebuilt with
//   the recorder's decoder. Each state of a pool the day's manifest lists as eligible is clipped to the pool's eligible
//   INTERVALS (gaps excluded) and weighted by the pool's ACTUAL successful polls from `poll_counts` over that time,
//   prorated by minute (ruling Z09-25: 1 Hz watched, 0.1 Hz in the tail; a state no poll saw has weight 0 and is left
//   out). A state from before the day (a quiet pool's carry-over) is not read: each day is read on its own.
// The pricing of a recorded state comes from the caller (`pricing`), which binds the venue maths (the engine does not
// depend on @bot/venue). Reads files only; never a provider.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import type { CoverageReport } from '@bot/types';
import { dayManifests } from '../m07/daily.ts';
import { scanGzipFrames } from '../m07/frames.ts';
import type { SegmentManifest } from '../m07/manifest.ts';
import { SnapshotDecoder, type EncodedSnapshot } from '../recorder/delta.ts';
import { manifestSha256, type UniverseManifestFile } from '../m05/manifest.ts';
import type { PoolPricing } from '../m10/costs.ts';
import type { Phase0Day, Phase0Input, PoolState, StreamDayBytes } from './phase0.ts';

type ReadFs = Pick<typeof nodeFs, 'existsSync' | 'readFileSync' | 'readdirSync'>;

/** Ruling Z09-31: the input refuses rather than shifting D1 or using R0 = 0. */
export type Phase0InputError = { code: 'E_NO_SNAPSHOTS' } | { code: 'E_R0_DAY_MISSING'; r0Day: string };
const MINUTE_MS = 60_000;
const SNAPSHOT_STREAMS = new Set(['pool_snapshot', 'pool_snapshot_tail', 'pool_snapshot_position']);

export type RecordedPricing = (fields: Readonly<Record<string, unknown>>, pool: { poolId: string; mint: string }) => PoolPricing | null;

interface Line { seq: bigint; recvMs: number; payload: unknown }
function linesOf(dataDir: string, m: SegmentManifest, fs: ReadFs): { lines: Line[]; decodedBytes: number | null } {
  const file = join(dataDir, m.path);
  if (m.codec !== 'gzip' || !fs.existsSync(file)) return { lines: [], decodedBytes: null };
  const lines: Line[] = [];
  let decoded = 0;
  scanGzipFrames(fs.readFileSync(file) as Buffer, (line) => {
    if (line === '') return;
    decoded += Buffer.byteLength(line, 'utf8') + 1;
    const o = JSON.parse(line) as { seq: string; recvMs: number; payload: unknown };
    lines.push({ seq: BigInt(o.seq), recvMs: o.recvMs, payload: o.payload });
  });
  return { lines, decodedBytes: decoded };
}

/**
 * The successful polls that saw a state held over [from, to), inside the eligible intervals (each [a, b] inclusive),
 * from the minute counts, each minute's count taken in proportion to the overlap; rounded to the nearest poll.
 */
export function pollsIn(minutes: ReadonlyMap<number, number> | undefined, intervals: ReadonlyArray<readonly [number, number]>, from: number, to: number): number {
  if (minutes === undefined) return 0;
  let w = 0;
  for (const [a, b] of intervals) {
    const lo = Math.max(a, from), hi = Math.min(b + 1, to);
    for (let m = Math.floor(lo / MINUTE_MS) * MINUTE_MS; m < hi; m += MINUTE_MS) {
      const n = minutes.get(m);
      if (n === undefined) continue;
      w += (n * (Math.min(hi, m + MINUTE_MS) - Math.max(lo, m))) / MINUTE_MS;
    }
  }
  return Math.round(w);
}

const isManifestFile = (v: unknown): v is UniverseManifestFile =>
  typeof v === 'object' && v !== null && (v as { manifestVersion?: unknown }).manifestVersion === 1 && typeof (v as { sha256?: unknown }).sha256 === 'string';

export function readPhase0Dataset(o: { dataDir: string; days: readonly string[]; pricing: RecordedPricing; fs?: ReadFs }): Omit<Phase0Input, 'simParams' | 'slippage'> {
  const fs = o.fs ?? nodeFs;
  const days: Phase0Day[] = [];
  const streams: StreamDayBytes[] = [];
  const poolStates: PoolState[] = [];
  const solUsd = new Map<string, number>();
  // R0 is the recorder's first snapshot in the WHOLE dataset, so a --days list that leaves its day out is refused.
  let r0 = Number.POSITIVE_INFINITY;
  const allDays = fs.existsSync(o.dataDir) ? (fs.readdirSync(o.dataDir) as string[]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  for (const d of allDays) for (const m of dayManifests(o.dataDir, d, fs)) if (SNAPSHOT_STREAMS.has(m.stream) && m.firstRecvMs !== null) r0 = Math.min(r0, m.firstRecvMs);
  if (!Number.isFinite(r0)) throw { code: 'E_NO_SNAPSHOTS' } satisfies Phase0InputError;
  const r0Day = new Date(r0).toISOString().slice(0, 10);
  if (!o.days.includes(r0Day)) throw { code: 'E_R0_DAY_MISSING', r0Day } satisfies Phase0InputError;
  for (const dayUtc of [...o.days].sort()) {
    const manifests = dayManifests(o.dataDir, dayUtc, fs).sort((a, b) => (a.path < b.path ? -1 : 1));
    let manifest: UniverseManifestFile | null = null;
    let low = true;
    const snapLines: Line[] = [];
    const polls = new Map<string, Map<number, number>>();               // pool → minute → successful polls
    const bytes = new Map<string, StreamDayBytes>();
    for (const m of manifests) {
      const read = linesOf(o.dataDir, m, fs);
      const b = bytes.get(m.stream) ?? { dayUtc, stream: m.stream, codec: m.codec, compressedBytes: 0, decodedBytes: 0 };
      b.compressedBytes += m.bytes;
      b.decodedBytes = b.decodedBytes === null || read.decodedBytes === null ? null : b.decodedBytes + read.decodedBytes;
      if (m.codec === 'zstd') b.codec = 'zstd';
      bytes.set(m.stream, b);
      for (const l of read.lines) {
        if (m.stream === 'universe_manifest' && isManifestFile(l.payload)) {
          const { sha256, ...body } = l.payload;
          if (manifestSha256(body) === sha256 && l.payload.dayUtc === dayUtc) manifest = l.payload;
        } else if (m.stream === 'coverage') {
          const c = l.payload as Partial<CoverageReport>;
          if (c.dayUtc === dayUtc && typeof c.lowCoverage === 'boolean') low = c.lowCoverage;
        } else if (m.stream === 'poll_counts') {
          const c = l.payload as { poolId?: unknown; minuteStartMs?: unknown; successfulPolls?: unknown; skippedMinutes?: unknown };
          if (typeof c.poolId === 'string' && Number.isSafeInteger(c.minuteStartMs) && Number.isSafeInteger(c.successfulPolls) && c.skippedMinutes === undefined) {
            const pm = polls.get(c.poolId) ?? new Map<number, number>();
            pm.set(c.minuteStartMs as number, (pm.get(c.minuteStartMs as number) ?? 0) + (c.successfulPolls as number));
            polls.set(c.poolId, pm);
          }
        } else if (m.stream === 'ref_price') {
          const p = l.payload as { kind?: string; usdE6PerSol?: string };
          if (p.kind === 'price' && typeof p.usdE6PerSol === 'string' && /^\d+$/.test(p.usdE6PerSol) && !solUsd.has(dayUtc)) solUsd.set(dayUtc, Number(p.usdE6PerSol) / 1e6);
        }
      }
      // Each segment decodes on its own (a keyframe opens every pool in a segment).
      if (SNAPSHOT_STREAMS.has(m.stream)) snapLines.push(...read.lines.map((l) => ({ ...l, payload: { seg: m.path, e: l.payload } })));
    }
    streams.push(...bytes.values());
    days.push({ dayUtc, lowCoverage: low, manifest });
    if (manifest === null) continue;
    const spans = new Map(manifest.eligible.map((e) => [e.poolId, e]));
    const decoders = new Map<string, SnapshotDecoder>();
    const states: Array<{ poolId: string; mint: string; recvMs: number; fields: Record<string, unknown> }> = [];
    for (const l of snapLines) {
      const { seg, e } = l.payload as { seg: string; e: EncodedSnapshot };
      let d = decoders.get(seg);
      if (d === undefined) { d = new SnapshotDecoder(); decoders.set(seg, d); }
      let s;
      try { s = d.apply(e); } catch { continue; }
      const span = spans.get(s.poolId);
      if (span === undefined || l.recvMs > span.lastEligibleAtMs) continue;
      states.push({ poolId: s.poolId, mint: span.mint, recvMs: l.recvMs, fields: s.fields });
    }
    states.sort((a, b) => (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : a.recvMs - b.recvMs));
    for (let k = 0; k < states.length; k++) {
      const s = states[k] as (typeof states)[number];
      const next = states[k + 1];
      const span = spans.get(s.poolId) as UniverseManifestFile['eligible'][number];
      const until = next !== undefined && next.poolId === s.poolId ? next.recvMs : span.lastEligibleAtMs + 1;
      const weight = pollsIn(polls.get(s.poolId), span.intervals, s.recvMs, until);
      if (weight === 0) continue;
      const real = typeof s.fields.quoteReserveReal === 'string' && /^\d+$/.test(s.fields.quoteReserveReal) ? BigInt(s.fields.quoteReserveReal) : null;
      const eff = typeof s.fields.effectiveQuoteLamports === 'string' && /^-?\d+$/.test(s.fields.effectiveQuoteLamports) ? BigInt(s.fields.effectiveQuoteLamports) : null;
      if (real === null || eff === null) continue;
      const pricing = o.pricing(s.fields, { poolId: s.poolId, mint: s.mint });
      if (pricing === null) continue;
      poolStates.push({ poolId: s.poolId, dayUtc, minDepthLamports: real < eff ? real : eff, pricing, weight });
    }
  }
  const r0Ms = r0;
  // D1's price: the day the window starts (step 1), read from the same rule.
  const d1 = new Date(Math.ceil((r0Ms + 30 * 3_600_000) / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
  const price = solUsd.get(d1) ?? null;
  return { r0Ms, days, streams, poolStates, solUsdD1: price, solUsdSource: price === null ? `none recorded on ${d1}` : `ref_price, first price of ${d1}` };
}

/** The pool state a recorded `pool_snapshot` fields bag describes (the PumpSwap fields of `recordFields`, A-M04-01). */
export interface RecordedPool {
  venue: 'pumpswap'; poolId: string; baseMint: string; quoteMint: string;
  baseReserve: bigint; quoteReserveReal: bigint; quoteReserveVirtual: bigint; baseMintSupply: bigint;
  isCanonical: boolean | null; curveComplete: null; asOfSlot: bigint; commitment: 'confirmed'; observedAtMs: number;
  coinCreatorSet: boolean | null; creatorFeeBps: number; isMayhemMode: boolean; baseDecimals: number | null; realBaseReserve: null; swappedMints: boolean;
}

/**
 * Prices a recorded state at min(real, effective) quote depth (C-77, the size sweep): the same spot price with the
 * quote reserve at the smaller of the two, under one fee schedule of the recorded per-side total (`feeTotalBps`, M04's
 * conservative tier; unknown fees were recorded as 10,000 and price nothing). `quote` is @bot/venue's `quoteExactIn`.
 */
export function recordedPricing<F>(deps: {
  quote(p: RecordedPool, side: 'buy' | 'sell', amountIn: bigint, fees: F): { ok: true; value: { amountOut: bigint; venueFeeLamports: bigint } } | { ok: false; error: { code: string } };
  feesForTotal(totalBps: number): F;
  wsolMint: string;
}): RecordedPricing {
  const big = (v: unknown, signed = false): bigint | null => (typeof v === 'string' && (signed ? /^-?\d+$/ : /^\d+$/).test(v) ? BigInt(v) : null);
  return (f, at) => {
    const [base, real, virt, supply, slot] = [big(f.baseReserve), big(f.quoteReserveReal), big(f.quoteReserveVirtual, true), big(f.baseMintSupply), big(f.asOfSlot)];
    const fee = f.feeTotalBps;
    if (base === null || real === null || virt === null || supply === null || slot === null || typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0 || fee >= 10_000) return null;
    const eff = real + virt;
    if (eff <= 0n || base <= 0n) return null;
    const depth = real < eff ? real : eff;
    const pool: RecordedPool = {
      venue: 'pumpswap', poolId: at.poolId, baseMint: at.mint, quoteMint: deps.wsolMint, baseReserve: (base * depth) / eff, quoteReserveReal: depth, quoteReserveVirtual: 0n,
      baseMintSupply: supply, isCanonical: f.isCanonical === true ? true : f.isCanonical === false ? false : null, curveComplete: null, asOfSlot: slot, commitment: 'confirmed',
      observedAtMs: 0, coinCreatorSet: typeof f.coinCreatorSet === 'boolean' ? f.coinCreatorSet : null, creatorFeeBps: 0, isMayhemMode: f.isMayhemMode === true,
      baseDecimals: typeof f.baseDecimals === 'number' ? f.baseDecimals : null, realBaseReserve: null, swappedMints: f.swappedMints === true,
    };
    const fees = deps.feesForTotal(fee);
    return { effectiveQuoteLamports: depth, realQuoteLamports: depth, quote: (side, amountIn) => deps.quote(pool, side, amountIn, fees) };
  };
}
