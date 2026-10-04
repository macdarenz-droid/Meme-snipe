// Outcome stage of the survival study (RES-5, docs/research/survival.md §1): the label of each decision, read on a
// second pass over the same practice rows. It sees only a decision's id, pool and label time, never its features,
// and the feature stage never imports it. Rows at or after the holdout wall stop the pass (practice.ts).
import { replaySwap } from '../../../core/src/fills/index.ts';
import type { PoolState } from '../../../core/src/amm/index.ts';
import type { AmmSwapRow, DatasetRow } from '../dataset/rows.ts';
import { guardRows, type PracticeWindow } from './practice.ts';
import { type SurvivalLabel, survivalLabel } from './survival-label.ts';

export interface LabelTarget {
  readonly id: string;
  readonly pool: string;
  readonly labelAtMs: number;
}

export interface LabelResult {
  readonly id: string;
  /** null: censored (T after the last row read, or an input unknown at T). */
  readonly label: SurvivalLabel | null;
}

interface PoolSeen {
  migrationPrice: number | null;
  lastMs: number | null;
  price: number | null;
  quote: bigint | null;
}

const spot = (s: PoolState): number | null => (s.baseReserve > 0n ? Number(s.quoteVault + s.virtualQuoteReserves) / Number(s.baseReserve) : null);

export const labelDecisions = (rows: Iterable<DatasetRow>, targets: readonly LabelTarget[], window: PracticeWindow): LabelResult[] => {
  const byPool = new Map<string, LabelTarget[]>();
  for (const x of targets) {
    const list = byPool.get(x.pool) ?? [];
    list.push(x);
    byPool.set(x.pool, list);
  }
  for (const list of byPool.values()) list.sort((a, b) => a.labelAtMs - b.labelAtMs);
  const pending = [...targets].sort((a, b) => a.labelAtMs - b.labelAtMs);
  const seen = new Map<string, PoolSeen>();
  const out = new Map<string, SurvivalLabel | null>();

  const resolve = (x: LabelTarget, nowMs: number): void => {
    if (out.has(x.id)) return;
    const s = seen.get(x.pool);
    out.set(x.id, survivalLabel({
      labelAtMs: x.labelAtMs, nowMs, migrationPrice: s?.migrationPrice ?? null, priceAtT: s?.price ?? null, quoteVaultAtT: s?.quote ?? null, lastSwapMs: s?.lastMs ?? null,
    }));
  };

  let next = 0;
  for (const row of guardRows(window, rows)) {
    const ms = row.blockTime * 1000;
    if (row.kind === 'amm') {
      const list = byPool.get(row.pool);
      if (list === undefined) continue;
      // Labels due before this swap read the pool as it stood before it.
      for (const x of list) if (x.labelAtMs < ms) resolve(x, ms);
      const r = replaySwap(row.pre, row as AmmSwapRow);
      if (!r.ok) continue;
      const s = seen.get(row.pool) ?? { migrationPrice: null, lastMs: null, price: null, quote: null };
      if (s.migrationPrice === null) s.migrationPrice = spot(row.pre);
      s.lastMs = ms;
      s.price = spot(r.trade.after);
      s.quote = r.trade.after.quoteVault;
      seen.set(row.pool, s);
      continue;
    }
    if (row.kind !== 'block') continue;
    while (next < pending.length && pending[next]!.labelAtMs <= ms) resolve(pending[next++]!, ms);
  }
  return targets.map((x) => ({ id: x.id, label: out.get(x.id) ?? null }));
};
