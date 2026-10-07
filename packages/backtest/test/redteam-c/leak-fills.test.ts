// RED TEAM C round 2: planted-future-marker probe for the backtest's World (sim/world.ts fill model) and the pool,
// candle and holder facts the backtest builds from DATA-1 rows. Round 1 found proofs.ts's leakTest never watches the
// effect runner (core's does), and cli.ts plants on keys no gate reads. Here the plant is a swap row on the pool the
// engine actually traded, dated the slot right after a fill landed (or right after a decision moment): it moves the
// reserves the fill model and every pool/candle/holder gate read. Fails if, before the plant's moment:
//   - any engine log record (decisions, world records of the landing and status reports) differs from the clean run,
//     or any read carries the marker (proofs.ts leakTest);
//   - any attempt that landed before the plant has a different outcome, fill or cost (the fill model priced it with
//     future reserves).
import { describe, expect, test, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { compareMoments, type Moment } from '../../../core/src/engine/index.ts';
import { compareRows, type AmmSwapRow, type DatasetRow } from '../../src/dataset/rows.ts';
import { leakTest } from '../../src/proofs.ts';
import { runBacktest, type RunOptions } from '../../src/run.ts';
import { SOL_USD, syntheticRows, T0 } from '../synthetic.ts';

vi.setConfig({ testTimeout: 300_000 });

const rows = syntheticRows({ mints: 4, slots: 2.5 * 3600 * 6 });
const RESEARCH = { ...RESEARCH_CONFIG, holdout: { ...RESEARCH_CONFIG.holdout, fromDay: '2026-09-20', entryCutoffDay: '2026-09-21', tailEndDay: '2026-09-21' } };
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  rows: () => rows[Symbol.iterator](), series: [SOL_USD], seed: 'test-seed', scenario: 'base', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH,
  windowEnd: T0 + 6 * 3_600_000, ...over,
});

const TOKEN = 'FUTURE-ONLY-MARKER-REDTEAM-C';
const text = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x));

/** A swap on `pool` at `slot` that moves its reserves hard (a copy of a real later row with a halved quote side). */
const plantOn = (pool: string, slot: bigint, n: number): AmmSwapRow => {
  const later = rows.find((r): r is AmmSwapRow => r.kind === 'amm' && r.pool === pool && r.slot > slot)!;
  const block = rows.find((r) => r.kind === 'block' && r.slot === slot);
  return {
    ...later, slot, blockTime: block?.blockTime ?? later.blockTime, txIdx: 9_000 + n, evIdx: 0, signature: `plant-${TOKEN}-${n}`, user: TOKEN,
    pre: { ...later.pre, quoteVault: later.pre.quoteVault / 2n },
  } as AmmSwapRow;
};

describe('RED TEAM C: the backtest World and row-built facts never price or decide with a later row', () => {
  const clean = runBacktest(opts());
  const filled = clean.attempts.filter((a) => a.outcome === 'filled' && a.landedSlot !== null);

  test('the run has entries and exits to probe', () => {
    expect(filled.some((a) => a.purpose === 'entry')).toBe(true);
    expect(filled.some((a) => a.purpose === 'exit')).toBe(true);
  });

  for (const purpose of ['entry', 'exit'] as const) {
    test(`a swap planted the slot after a ${purpose} fill landed changes no record or fill before it`, () => {
      const a = filled.find((x) => x.purpose === purpose)!;
      const pool = clean.discoveries.get(a.mint)!.pool;
      const slot = a.landedSlot! + 1n;
      const plant = plantOn(pool, slot, 0);
      const at: Moment = { slot, txIndex: plant.txIdx, ixIndex: 0, receivedAt: plant.blockTime * 1000 };
      expect(compareMoments(at, { slot: a.landedSlot!, txIndex: Number.MAX_SAFE_INTEGER, ixIndex: 0, receivedAt: a.landedAt! })).toBeGreaterThan(0);
      const report = leakTest(opts(), { token: TOKEN, at, rows: [plant], events: [] }, { labels: [{ mint: a.mint, note: TOKEN }] });
      expect(report.violations).toEqual([]);
      // The fill model: every attempt that landed before the plant is the same, outcome, fill and costs.
      const planted = runBacktest({ ...opts(), rows: () => merge(rows, [plant])[Symbol.iterator]() });
      const before = (r: typeof clean) => [...r.attempts].filter((x) => x.landedSlot !== null && x.landedSlot < slot).map((x) => text({ s: x.signature, o: x.outcome, f: x.fill, c: x.costs, fee: x.fee }));
      expect(before(planted)).toEqual(before(clean));
      // The plant is real: something after it differs (the pool moved).
      expect(planted.logHash).not.toBe(clean.logHash);
    });
  }

  test('control: the same swap planted in the landing slot itself (before the landing) does change the fill', () => {
    const a = filled.find((x) => x.purpose === 'entry')!;
    const pool = clean.discoveries.get(a.mint)!.pool;
    const plant = plantOn(pool, a.landedSlot!, 0);
    const planted = runBacktest({ ...opts(), rows: () => merge(rows, [plant])[Symbol.iterator]() });
    const fillOf = (r: typeof clean) => text(r.attempts.find((x) => x.signature === a.signature)?.fill ?? null);
    expect(planted.attempts.find((x) => x.signature === a.signature)?.outcome).toBe('filled');
    expect(fillOf(planted)).not.toBe(fillOf(clean));
  });

  test('swaps planted on every discovered pool right after the middle of the run change no decision before it', () => {
    const mid = rows[Math.floor(rows.length / 2)]!;
    const slot = mid.slot + 1n;
    const plants = [...clean.discoveries.values()].map((d, n) => plantOn(d.pool, slot, n));
    expect(plants.length).toBeGreaterThan(1);
    const at: Moment = { slot, txIndex: 9_000, ixIndex: 0, receivedAt: plants[0]!.blockTime * 1000 };
    const report = leakTest(opts(), { token: TOKEN, at, rows: plants, events: [] }, { labels: [{ note: TOKEN }] });
    expect(report.violations).toEqual([]);
  });
});

const merge = (a: readonly DatasetRow[], b: readonly DatasetRow[]): DatasetRow[] => [...a, ...b].sort(compareRows);
