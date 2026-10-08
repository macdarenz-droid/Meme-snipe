// In-process metric registry (B-M27-01 logic 1-2; ARCH 13.1). Counters, gauges and histograms from the catalog.
//
// Hot path: `inc`, `set` and `observe` only update numbers in memory: no clock read, no I/O, never blocking.
// `tick()` (called once a second by the engine's timer, or by `start()`) samples every series into its 1 s history and,
// when a minute has ended, writes that minute's rollups (`count, sum, p50, p95, p99`) to the sink (`metric_rollup_1m`).
//
// Memory bound (2 GB host, owner rule): 24 h of 1 s points for 5,000 series would need about 3.5 GB, so the 1 s history
// is stored in one-hour chunks of 3,600 doubles (28.8 kB) inside a byte budget (`m27.ring_budget_bytes`). Chunks older
// than 24 h are freed; when the budget is full, the oldest chunk of any series is freed first and
// `metrics_ring_evicted_total` counts it, so the 1 s horizon shrinks under pressure while the minute rollups are kept.
// Disk bound: a counter or histogram writes a rollup row only for a minute with activity, and a gauge only for a
// minute in which its value changed; a missing gauge row means "unchanged since the last row".
// A rollup write that fails (for example SQLITE_FULL) never escapes the timer: that minute's rows are dropped, counted
// (`metrics_rollup_failed_total`) and logged at error, so a full disk cannot crash the engine in a loop; a failing log
// report is swallowed too (review n1). A gauge counts as written only after a successful write, so its next changed
// minute is written again.
// Series lifetime (B-M27-01 logic 1: pool and mint labels only for watched pools and open positions): `release` and
// `releaseWhere` free a series and its 1 s history when its pool stops being watched; its activity in the current
// minute is still written when the minute ends, and the freed slot counts again under `m27.series_cap`. A handle of a
// released series throws when used (red team n2) until the series is taken again in the same minute; after that
// minute a new handle is a new series.
import { createHash } from 'node:crypto';
import { canonicalJson, type Clock, type UnixMs } from '@bot/types';
import { METRICS, type CounterName, type GaugeName, type HistogramName, type LabelsOf, type MetricName } from './catalog.ts';
import type { Logger } from './log.ts';

export interface CounterHandle { inc(by?: number): void }
export interface GaugeHandle { set(value: number): void }
export interface HistogramHandle { observe(value: number): void }

/** One row of `metric_rollup_1m` (ARCH 15): the minute that ended, keyed by metric, labels hash and minute start. */
const scopeOf = (labels: Readonly<Record<string, string>>): 'aggregate' | 'pool' => (POOL_LABELS.some((k) => k in labels) ? 'pool' : 'aggregate');

/** Labels that make a series per pool or per token; their rollups keep 7 days, the others 1 year (ruling 7). */
export const POOL_LABELS: readonly string[] = ['pool', 'mint'];

export interface RollupRow {
  metric: string; labelsHash: bigint; minute: UnixMs; scope: 'aggregate' | 'pool'; count: number; sum: number;
  p50: number | null; p95: number | null; p99: number | null;
}
export interface RollupSink { append(rows: readonly RollupRow[]): void }

export interface MetricsOptions {
  clock: Clock;
  /** `m27.series_cap`: series beyond it are dropped (no-op handles) and counted. */
  seriesCap: number;
  /** `m27.ring_budget_bytes`: memory for the 1 s history. */
  ringBudgetBytes: number;
  sink: RollupSink;
  /** Where a failed rollup write is reported (`m27.rollup_write_failed`, error). */
  log?: Pick<Logger, 'event'>;
}

/** One sampled point of the 1 s history: seconds since the epoch and the value (cumulative for counters and histograms). */
export interface Point { sec: number; value: number }

const CHUNK_SECONDS = 3_600;
export const CHUNK_BYTES = CHUNK_SECONDS * 8;
const HORIZON_CHUNKS = 24;
/** The registry's own series: never released. */
const SELF_METRICS: ReadonlySet<string> = new Set(['metrics_series', 'metrics_series_dropped_total', 'metrics_ring_evicted_total', 'metrics_rollup_failed_total']);

class Series {
  /** Held by the registry: false once released and not taken again, so its handles throw instead of writing to it. */
  live = true;
  value = 0;
  sum = 0;
  mCount = 0;
  mSum = 0;
  mMax = Number.NEGATIVE_INFINITY;
  readonly mSamples: number[] = [];
  lastEmitted: number | null = null;
  readonly chunks = new Map<number, Float64Array>();
  readonly bucketCounts: Float64Array;
  readonly mBuckets: Float64Array;
  readonly name: MetricName;
  readonly kind: 'counter' | 'gauge' | 'histogram';
  readonly labels: Readonly<Record<string, string>>;
  readonly labelsHash: bigint;
  readonly bounds: readonly number[];

  constructor(name: MetricName, kind: Series['kind'], labels: Readonly<Record<string, string>>, hash: bigint, bounds: readonly number[]) {
    this.name = name;
    this.kind = kind;
    this.labels = labels;
    this.labelsHash = hash;
    this.bounds = bounds;
    this.bucketCounts = new Float64Array(bounds.length + 1);
    this.mBuckets = new Float64Array(bounds.length + 1);
  }
}

const NOOP = { inc(): void {}, set(): void {}, observe(): void {} };

/** Refuses a handle kept after its series was released: its updates would reach no rollup and no exposition. */
function assertLive(s: Series): void {
  if (!s.live) throw new Error(`metrics: a ${s.name} handle was used after its series was released; ask for a new handle`);
}

/** Adds 1 to a self-metric counter. */
function bump(s: Series): void {
  s.value += 1;
  s.mCount += 1;
  s.mSum += 1;
}

/**
 * The `labels_hash` column: the first 8 bytes of the SHA-256 of the canonical JSON of a label set, read as a signed
 * 64-bit integer (8 bytes on disk instead of 64 hex characters).
 */
export function labelsHash(labels: Readonly<Record<string, string>>): bigint {
  return createHash('sha256').update(canonicalJson(labels)).digest().readBigInt64BE(0);
}

const seriesKey = (name: string, labels: Readonly<Record<string, string>>): string => `${name}${canonicalJson(labels)}`;

/** Nearest-rank quantile of sorted values (q in (0, 1]). */
export function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;
}

/** Nearest-rank quantile from bucket counts: the upper bound of the bucket that holds it, or `max` for the overflow bucket. */
export function bucketQuantile(counts: Float64Array, bounds: readonly number[], total: number, q: number, max: number): number {
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let i = 0; i < bounds.length; i++) {
    seen += counts[i] as number;
    if (seen >= rank) return bounds[i] as number;
  }
  return max;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels: Readonly<Record<string, string>>, extra: string | null = null): string {
  const parts = Object.keys(labels).sort().map((k) => `${k}="${escapeLabel(labels[k] as string)}"`);
  if (extra !== null) parts.push(extra);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

export class MetricsRegistry {
  private readonly series = new Map<string, Series>();
  /** Series released during the current minute: written at its end, then forgotten (revived if asked for again). */
  private readonly retired = new Map<string, Series>();
  private fifo: Array<{ s: Series; chunk: number }> = [];
  private chunkCount = 0;
  private currentMinute: number | null = null;
  private currentChunk: number | null = null;
  private readonly seriesGauge: Series;
  private readonly droppedCounter: Series;
  private readonly evictedCounter: Series;
  private readonly rollupFailedCounter: Series;
  private readonly opts: MetricsOptions;

  constructor(opts: MetricsOptions) {
    this.opts = opts;
    if (!Number.isInteger(opts.seriesCap) || opts.seriesCap < 4) throw new RangeError('metrics: seriesCap must be an integer >= 4');
    if (!Number.isInteger(opts.ringBudgetBytes) || opts.ringBudgetBytes < 0) throw new RangeError('metrics: ringBudgetBytes must be a non-negative integer');
    this.seriesGauge = this.create('metrics_series', {});
    this.droppedCounter = this.create('metrics_series_dropped_total', {});
    this.evictedCounter = this.create('metrics_ring_evicted_total', {});
    this.rollupFailedCounter = this.create('metrics_rollup_failed_total', {});
  }

  counter<N extends CounterName>(name: N, labels: LabelsOf<N>): CounterHandle {
    const s = this.handle(name, 'counter', labels);
    if (s === null) return NOOP;
    return {
      inc(by = 1): void {
        assertLive(s);
        if (!(by >= 0) || !Number.isFinite(by)) throw new TypeError(`metrics: ${name} increment must be finite and >= 0`);
        s.value += by;
        s.mCount += 1;
        s.mSum += by;
      },
    };
  }

  gauge<N extends GaugeName>(name: N, labels: LabelsOf<N>): GaugeHandle {
    const s = this.handle(name, 'gauge', labels);
    if (s === null) return NOOP;
    return {
      set(value: number): void {
        assertLive(s);
        if (!Number.isFinite(value)) throw new TypeError(`metrics: ${name} value must be finite`);
        s.value = value;
      },
    };
  }

  histogram<N extends HistogramName>(name: N, labels: LabelsOf<N>): HistogramHandle {
    const s = this.handle(name, 'histogram', labels);
    if (s === null) return NOOP;
    return {
      observe(value: number): void {
        assertLive(s);
        if (!Number.isFinite(value)) throw new TypeError(`metrics: ${name} observation must be finite`);
        let i = 0;
        while (i < s.bounds.length && value > (s.bounds[i] as number)) i++;
        s.bucketCounts[i] = (s.bucketCounts[i] as number) + 1;
        s.mBuckets[i] = (s.mBuckets[i] as number) + 1;
        s.value += 1;
        s.sum += value;
        s.mCount += 1;
        s.mSum += value;
        if (value > s.mMax) s.mMax = value;
      },
    };
  }

  /** Number of series held (self-metric `metrics_series`). */
  size(): number {
    return this.series.size;
  }

  /** Bytes held by the 1 s history. */
  ringBytes(): number {
    return this.chunkCount * CHUNK_BYTES;
  }

  /**
   * The 1 s history of one series between two epoch seconds (inclusive), oldest first. Only the stored hours are
   * read, so the work is bounded by the 24 h history whatever range is asked for.
   */
  points(name: MetricName, labels: Readonly<Record<string, string>>, fromSec: number, toSec: number): Point[] {
    if (!Number.isSafeInteger(fromSec) || !Number.isSafeInteger(toSec)) throw new RangeError('metrics: points takes whole epoch seconds');
    const s = this.series.get(seriesKey(name, labels));
    const out: Point[] = [];
    if (s === undefined) return out;
    for (const chunk of [...s.chunks.keys()].sort((a, b) => a - b)) {
      const base = chunk * CHUNK_SECONDS;
      const data = s.chunks.get(chunk) as Float64Array;
      const last = Math.min(toSec, base + CHUNK_SECONDS - 1);
      for (let sec = Math.max(fromSec, base); sec <= last; sec++) {
        const v = data[sec - base] as number;
        if (!Number.isNaN(v)) out.push({ sec, value: v });
      }
    }
    return out;
  }

  /**
   * Frees one series and its 1 s history; its activity in the current minute is still written when the minute ends.
   * A handle taken before the release throws when used after it: ask for a new handle if the series comes back.
   * Returns false when the series does not exist. The registry's own series cannot be released.
   */
  release(name: MetricName, labels: Readonly<Record<string, string>>): boolean {
    if (SELF_METRICS.has(name)) throw new TypeError(`metrics: "${name}" belongs to the registry and cannot be released`);
    const key = seriesKey(name, labels);
    const s = this.series.get(key);
    if (s === undefined) return false;
    this.retire([[key, s]]);
    return true;
  }

  /** Frees every series whose labels include all of `match` (for example `{ pool }` when a pool leaves the watchlist); returns how many. */
  releaseWhere(match: Readonly<Record<string, string>>): number {
    const pairs = Object.entries(match);
    if (pairs.length === 0) throw new RangeError('metrics: releaseWhere needs at least one label');
    const found = [...this.series].filter(([, s]) => pairs.every(([k, v]) => s.labels[k] === v));
    this.retire(found);
    return found.length;
  }

  /** Samples every series into its 1 s history; when a minute has ended, writes its rollups to the sink. */
  tick(): void {
    const now = this.opts.clock.nowMs();
    const minute = Math.floor(now / 60_000) * 60_000;
    if (this.currentMinute === null) this.currentMinute = minute;
    if (minute < this.currentMinute) {
      // The clock ran ahead and came back (red team C M3 pattern): the minute being collected is stamped with a time
      // that has not come yet, so its samples are dropped and collection restarts at the current minute, instead of
      // writing no rollup until that time comes (or writing rows that would collide with that minute's later rows).
      this.rollup(this.currentMinute as UnixMs);
      this.currentMinute = minute;
    }
    if (minute > this.currentMinute) {
      const ended = this.currentMinute;
      const { rows, gauges } = this.rollup(ended as UnixMs);
      this.currentMinute = minute;
      if (rows.length > 0 && this.append(ended, rows)) for (const [s, v] of gauges) s.lastEmitted = v;
    }
    const sec = Math.floor(now / 1_000);
    const chunk = Math.floor(sec / CHUNK_SECONDS);
    if (this.currentChunk !== chunk) {
      this.currentChunk = chunk;
      this.expire(chunk - HORIZON_CHUNKS);
    }
    for (const s of this.series.values()) {
      if (s.kind === 'gauge') s.mSamples.push(s.value);
      this.record(s, chunk, sec % CHUNK_SECONDS);
    }
  }

  /** Writes one minute's rows; false (counted and logged) when the sink throws. */
  private append(minute: number, rows: readonly RollupRow[]): boolean {
    try {
      this.opts.sink.append(rows);
      return true;
    } catch (e) {
      bump(this.rollupFailedCounter);
      try {
        this.opts.log?.event('error', 'm27.rollup_write_failed',
          { minute_start_ms: minute, row_count: rows.length, error_message: String(e) });
      } catch {
        // The report failed too (its onError may write to the same full database): the counter above still has it.
      }
      return false;
    }
  }

  /** Calls `tick()` every `intervalMs` on an unreferenced timer; returns the function that stops it. */
  start(intervalMs = 1_000): () => void {
    const timer = setInterval(() => this.tick(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** The text exposition of every series (served on loopback only, `server.ts`). */
  render(): string {
    const lines: string[] = [];
    const byName = new Map<string, Series[]>();
    for (const s of this.series.values()) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    for (const name of [...byName.keys()].sort()) {
      const list = byName.get(name) as Series[];
      const kind = (list[0] as Series).kind;
      lines.push(`# TYPE ${name} ${kind}`);
      for (const s of list) {
        if (kind !== 'histogram') {
          lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
          continue;
        }
        let cumulative = 0;
        s.bounds.forEach((b, i) => {
          cumulative += s.bucketCounts[i] as number;
          lines.push(`${name}_bucket${renderLabels(s.labels, `le="${b}"`)} ${cumulative}`);
        });
        lines.push(`${name}_bucket${renderLabels(s.labels, 'le="+Inf"')} ${s.value}`);
        lines.push(`${name}_sum${renderLabels(s.labels)} ${s.sum}`);
        lines.push(`${name}_count${renderLabels(s.labels)} ${s.value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private handle(name: MetricName, kind: Series['kind'], labels: Readonly<Record<string, string>>): Series | null {
    const def = METRICS[name] as { kind: string; labels: readonly string[] } | undefined;
    if (def === undefined) throw new TypeError(`metrics: "${name}" is not in the catalog`);
    if (def.kind !== kind) throw new TypeError(`metrics: "${name}" is a ${def.kind}, not a ${kind}`);
    const keys = Object.keys(labels).sort();
    const expected = [...def.labels].sort();
    if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i] || typeof labels[k] !== 'string')) {
      throw new TypeError(`metrics: "${name}" takes labels [${expected.join(', ')}]`);
    }
    const key = seriesKey(name, labels);
    const existing = this.series.get(key);
    if (existing !== undefined) return existing;
    if (this.series.size >= this.opts.seriesCap) {
      bump(this.droppedCounter);
      return null;
    }
    const revived = this.retired.get(key);     // released this minute: one series, so one row per minute and key
    if (revived === undefined) return this.create(name, labels);
    this.retired.delete(key);
    revived.live = true;
    this.series.set(key, revived);
    this.seriesGauge.value = this.series.size;
    return revived;
  }

  private retire(found: ReadonlyArray<[string, Series]>): void {
    if (found.length === 0) return;
    const gone = new Set<Series>();
    for (const [key, s] of found) {
      this.series.delete(key);
      this.retired.set(key, s);
      s.live = false;
      this.chunkCount -= s.chunks.size;
      s.chunks.clear();
      gone.add(s);
    }
    this.fifo = this.fifo.filter((e) => !gone.has(e.s));
    this.seriesGauge.value = this.series.size;
  }

  private create(name: MetricName, labels: Readonly<Record<string, string>>): Series {
    const def = METRICS[name] as { kind: Series['kind']; buckets?: readonly number[] };
    const copy = Object.freeze({ ...labels });
    const s = new Series(name, def.kind, copy, labelsHash(copy), def.buckets ?? []);
    this.series.set(seriesKey(name, copy), s);
    if (this.seriesGauge !== undefined) this.seriesGauge.value = this.series.size;
    return s;
  }

  private record(s: Series, chunk: number, index: number): void {
    let data = s.chunks.get(chunk);
    if (data === undefined) {
      while (this.fifo.length > 0 && (this.chunkCount + 1) * CHUNK_BYTES > this.opts.ringBudgetBytes) {
        this.drop(this.fifo.shift() as { s: Series; chunk: number });
        bump(this.evictedCounter);
      }
      if ((this.chunkCount + 1) * CHUNK_BYTES > this.opts.ringBudgetBytes) return;
      data = new Float64Array(CHUNK_SECONDS).fill(Number.NaN);
      s.chunks.set(chunk, data);
      this.fifo.push({ s, chunk });
      this.chunkCount += 1;
    }
    data[index] = s.value;
  }

  private drop(entry: { s: Series; chunk: number }): void {
    if (entry.s.chunks.delete(entry.chunk)) this.chunkCount -= 1;
  }

  private expire(oldestKept: number): void {
    while (this.fifo.length > 0 && (this.fifo[0] as { chunk: number }).chunk < oldestKept) this.drop(this.fifo.shift() as { s: Series; chunk: number });
  }

  /** The ended minute's rows, and the gauge values that count as written once the rows are stored. */
  private rollup(minute: UnixMs): { rows: RollupRow[]; gauges: Array<[Series, number]> } {
    const rows: RollupRow[] = [];
    const gauges: Array<[Series, number]> = [];
    const all = [...this.series.values(), ...this.retired.values()];
    this.retired.clear();
    for (const s of all) {
      if (s.kind === 'gauge') {
        const samples = s.mSamples.splice(0);
        if (samples.length === 0 || samples.every((v) => v === s.lastEmitted)) continue;
        gauges.push([s, samples[samples.length - 1] as number]);
        const sorted = [...samples].sort((a, b) => a - b);
        rows.push({ metric: s.name, labelsHash: s.labelsHash, minute, scope: scopeOf(s.labels), count: samples.length, sum: samples.reduce((a, b) => a + b, 0),
          p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99) });
        continue;
      }
      if (s.mCount === 0) continue;
      const q = (p: number): number | null => (s.kind === 'histogram' ? bucketQuantile(s.mBuckets, s.bounds, s.mCount, p, s.mMax) : null);
      rows.push({ metric: s.name, labelsHash: s.labelsHash, minute, scope: scopeOf(s.labels), count: s.mCount, sum: s.mSum, p50: q(0.5), p95: q(0.95), p99: q(0.99) });
      s.mCount = 0;
      s.mSum = 0;
      s.mMax = Number.NEGATIVE_INFINITY;
      s.mBuckets.fill(0);
    }
    return { rows, gauges };
  }
}
