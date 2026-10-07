// RED TEAM A, RT-A2 (A-FACTS-FIXES): H5's curve half must judge the same curve tape in the backtest as live.
// Live runs with `tradeStreams: false` (worker/src/main.ts), so its store holds the curve trades of the transactions it
// reads: the create transaction (creates watch, or the create fetched at shortlist) and the completing buy
// (COMPLETION-READ / FACTS-REREAD). The backtest released every tailed curve trade (sim/facts.ts `#curve`), so a
// non-zero tail early on the curve refused the coin in the backtest and passed it live: a live-only pass.
// Fixed by giving the backtest exactly live's curve tape: the create transaction's trades and the completing buy.
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { AsOfStore, SimClock, type AsOfEntry, type FeedEvent, type MarketEvent, type Moment } from '../../core/src/engine/index.ts';
import { checkCurveTails, curveTradeKeys, type TailCheck } from '../../core/src/gates/index.ts';
import type { CurveTradeRow } from '../src/dataset/rows.ts';
import { seriesReleases } from '../src/dataset/offchain.ts';
import { FactProjector, tradeTailValue } from '../src/sim/facts.ts';
import { Market } from '../src/sim/market.ts';
import { SOL_USD } from './synthetic.ts';
import { SLOT_MS, studyWorld, W0, type MintPlan } from './study-world.ts';

const MIN = 60_000 / SLOT_MS;
const U2 = { universe: 'U2', fromMs: 60 * 60_000, toMs: 70 * 60_000, everyMs: 5 * 60_000, minQuoteLamports: 0n };
const solUsd = { ...SOL_USD, bars: SOL_USD.bars.map((b, k) => ({ ...b, start: W0 - 6 * 3_600_000 + k * 3_600_000 })) };
const HEX = '0100000000000000';

const replay = (plan: MintPlan) => {
  const { rows, mints, ownerPrograms } = studyWorld({ mints: [plan], slots: 10 + 20 * MIN + 2 * MIN });
  const facts = new FactProjector({ holders: { ownerPrograms }, sampleRate: 1, rugs: RUG_CONFIG, windows: [U2], solUsd: seriesReleases(solUsd), solUsdPoints: 30, candlesHead: 10, candlesTail: 360, tieSalt: 'test-salt' });
  const market = new Market({ heartbeatBlocks: 1_000_000, discoveryLag: () => 1, active: () => false, observe: null, volumeWindowSlots: 150, hook: () => {}, hasRows: () => true, schedule: () => {}, facts });
  const events: FeedEvent[] = [];
  for (const r of rows) events.push(...market.release(r));
  const mint = mints[0]!.mint;
  const curve = rows.filter((r): r is CurveTradeRow => r.kind === 'curve' && r.mint === mint);
  const create = rows.flatMap((r) => (r.kind === 'event' && r.event === 'CreateEvent' ? [r.signature] : []))[0]!;
  return { mint, curve, create, released: events.filter((e): e is MarketEvent => e.kind === 'market' && curveTradeKeys(mint).includes(e.key)) };
};

/** H5's curve half over a store holding `values` (each at its own chain position). */
const verdict = (mint: string, values: readonly { readonly row: CurveTradeRow; readonly value: unknown }[]): TailCheck => {
  const origin: Moment = { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 };
  const clock = new SimClock(origin);
  const store = new AsOfStore(clock);
  [...values].sort((a, b) => (a.row.slot < b.row.slot ? -1 : 1)).forEach(({ row, value }, i) => {
    const m: Moment = { slot: row.slot, txIndex: row.txIdx, ixIndex: row.evIdx, receivedAt: 1_000 + i };
    clock.advanceTo(m);
    store.record(curveTradeKeys(mint)[0]!, value, m, `ev:${row.signature}:${row.evIdx}`);
  });
  clock.advanceTo({ slot: 10n ** 12n, txIndex: 0, ixIndex: 0, receivedAt: 10 ** 12 });
  return checkCurveTails({ now: clock.now(), history: (k, f, t) => store.history(k, f, t) as readonly AsOfEntry[] }, mint);
};

/** What live's store holds of the curve: the create transaction's trades and the completing buy (the live event's tail). */
const liveTape = (r: ReturnType<typeof replay>) => r.curve.filter((c) => c.signature === r.create || c.realTokenReserves === 0n)
  .map((row) => ({ row, value: { event: { program: 'pump', name: 'TradeEvent', data: { mint: row.mint, isBuy: row.isBuy }, trailing: row.extraHex.length / 2, extra: row.extraHex }, txSlot: row.slot, signature: row.signature } }));
const backtestTape = (r: ReturnType<typeof replay>) => r.released.map((e) => ({ row: r.curve.find((c) => e.id === `te:${c.signature}:${c.evIdx}`)!, value: e.value }));
const code = (t: TailCheck) => (t.ok ? 'pass' : t.code);

describe('RT-A2: H5\'s curve half judges the same tape in the backtest as live', () => {
  it('a non-zero tail on an early curve buy (one live never reads) is not released: both pass', () => {
    const r = replay({ label: 'early', createSlot: 10, graduateAfter: 20 * MIN, devBuyBps: 100, curveTail: { buys: [5], hex: HEX } });
    expect(r.curve.filter((c) => c.extraHex !== '')).toHaveLength(1);
    expect(r.released).toEqual([]);
    expect(code(verdict(r.mint, backtestTape(r)))).toBe(code(verdict(r.mint, liveTape(r))));
    expect(code(verdict(r.mint, backtestTape(r)))).toBe('pass');
  });

  it('a non-zero tail on the dev buy in the create transaction (live reads it): both refuse event-tail', () => {
    const r = replay({ label: 'dev', createSlot: 10, graduateAfter: 20 * MIN, devBuyBps: 100, curveTail: { dev: true, hex: HEX } });
    expect(r.released.map((e) => e.id)).toEqual([`te:${r.create}:1`]);
    expect(code(verdict(r.mint, backtestTape(r)))).toBe('event-tail');
    expect(code(verdict(r.mint, liveTape(r)))).toBe('event-tail');
  });

  it('a non-zero tail on the completing buy (live reads it): both refuse event-tail', () => {
    const r = replay({ label: 'last', createSlot: 10, graduateAfter: 20 * MIN, curveTail: { buys: [99], hex: HEX } });
    const completing = r.curve.find((c) => c.realTokenReserves === 0n)!;
    expect(completing.extraHex).toBe(HEX);
    expect(r.released.map((e) => e.id)).toEqual([`te:${completing.signature}:${completing.evIdx}`]);
    expect(r.released[0]!.value).toEqual(tradeTailValue(completing));
    expect(code(verdict(r.mint, backtestTape(r)))).toBe('event-tail');
    expect(code(verdict(r.mint, liveTape(r)))).toBe('event-tail');
  });
});
