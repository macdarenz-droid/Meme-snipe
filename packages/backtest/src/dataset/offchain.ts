// Off-chain series (SOL/USD and the like). Each series is tagged:
// - fixed: a past value never changes (a closed exchange candle). A bar is usable from its close plus one more bar.
// - revisable: past values can change after the fact (DefiLlama volume). A value counts as unknown unless it was
//   fetched before the decision, so a backtest can only use what a live bot could have fetched then.
import { readFileSync } from 'node:fs';

export interface SeriesBar {
  /** Bar start, ms since epoch. */
  readonly start: number;
  /** Close as an exact decimal string. */
  readonly close: string;
}

export interface OffchainSeries {
  readonly name: string;
  readonly source: string;
  readonly tag: 'fixed' | 'revisable';
  readonly barMs: number;
  /** When the series was fetched (ms). For revisable series, values are usable only at or after this. */
  readonly fetchedAt: number;
  readonly bars: readonly SeriesBar[];
}

/** The moment a bar may first be used by a decision. */
export const usableFrom = (s: OffchainSeries, bar: SeriesBar): number =>
  s.tag === 'fixed' ? bar.start + 2 * s.barMs : Math.max(bar.start + 2 * s.barMs, s.fetchedAt);

/** One event per bar, dated at its usable moment, in time order. */
export const seriesReleases = (s: OffchainSeries): { readonly at: number; readonly bar: SeriesBar }[] =>
  s.bars.map((bar) => ({ at: usableFrom(s, bar), bar })).sort((a, b) => a.at - b.at || a.bar.start - b.bar.start);

/**
 * File format (CSV): a header block of `# key: value` lines (name, source, tag, bar_ms, fetched_at as ISO time),
 * then `start_iso,close` rows.
 */
export const readSeries = (path: string): OffchainSeries => {
  const meta = new Map<string, string>();
  const bars: SeriesBar[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const m = /^#\s*([a-z_]+):\s*(.*)$/.exec(line);
      if (m) meta.set(m[1]!, m[2]!);
      continue;
    }
    if (line.startsWith('start')) continue;
    const [start, close] = line.split(',');
    const t = Date.parse(start ?? '');
    if (!Number.isSafeInteger(t) || !/^\d+(\.\d+)?$/.test(close ?? '')) throw new RangeError(`${path}: bad row "${line}"`);
    bars.push({ start: t, close: close! });
  }
  const tag = meta.get('tag');
  if (tag !== 'fixed' && tag !== 'revisable') throw new RangeError(`${path}: tag must be fixed or revisable`);
  const barMs = Number(meta.get('bar_ms'));
  const fetchedAt = Date.parse(meta.get('fetched_at') ?? '');
  if (!Number.isSafeInteger(barMs) || barMs <= 0 || !Number.isSafeInteger(fetchedAt)) throw new RangeError(`${path}: bar_ms and fetched_at are required`);
  return { name: meta.get('name') ?? path, source: meta.get('source') ?? 'unknown', tag, barMs, fetchedAt, bars: bars.sort((a, b) => a.start - b.start) };
};
