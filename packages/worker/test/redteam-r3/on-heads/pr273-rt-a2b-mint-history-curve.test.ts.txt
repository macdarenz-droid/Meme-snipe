// (helpers copied from #273's backtest/test/curve-tail-parity.test.ts)
// ORIGINAL HEADER: RED TEAM A, RT-A2 (A-FACTS-FIXES): H5's curve half must judge the same curve tape in the backtest as live.
// Live runs with `tradeStreams: false` (worker/src/main.ts), so its store holds the curve trades of the transactions it
// reads: the create transaction (creates watch, or the create fetched at shortlist) and the completing buy
// (COMPLETION-READ / FACTS-REREAD). The backtest released every tailed curve trade (sim/facts.ts `#curve`), so a
// non-zero tail early on the curve refused the coin in the backtest and passed it live: a live-only pass.
// Fixed by giving the backtest exactly live's curve tape: the create transaction's trades and the completing buy.
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { AsOfStore, SimClock, type AsOfEntry, type FeedEvent, type MarketEvent, type Moment } from '../../core/src/engine/index.ts';
import { checkCurveTails, curveTradeKeys, type TailCheck } from '../../core/src/gates/index.ts';
import type { CurveTradeRow, DatasetRow } from '../src/dataset/rows.ts';
import { seriesReleases } from '../src/dataset/offchain.ts';
import { FactProjector, tradeTailValue } from '../src/sim/facts.ts';
import { Market, rowMoment } from '../src/sim/market.ts';
import { SOL_USD } from './synthetic.ts';
import { SLOT_MS, studyWorld, W0, type MintPlan } from './study-world.ts';

const MIN = 60_000 / SLOT_MS;
const U2 = { universe: 'U2', fromMs: 60 * 60_000, toMs: 70 * 60_000, everyMs: 5 * 60_000, minQuoteLamports: 0n };
const solUsd = { ...SOL_USD, bars: SOL_USD.bars.map((b, k) => ({ ...b, start: W0 - 6 * 3_600_000 + k * 3_600_000 })) };
const HEX = '0100000000000000';

const replay = (plan: MintPlan, edit: (rows: DatasetRow[]) => DatasetRow[] = (x) => x) => {
  const world = studyWorld({ mints: [plan], slots: 10 + 20 * MIN + 2 * MIN });
  const { mints, ownerPrograms } = world;
  const rows = edit([...world.rows]);
  const facts = new FactProjector({ holders: { ownerPrograms }, sampleRate: 1, rugs: RUG_CONFIG, windows: [U2], solUsd: seriesReleases(solUsd), solUsdPoints: 30, candlesHead: 10, candlesTail: 360, tieSalt: 'test-salt' });
  const market = new Market({ heartbeatBlocks: 1_000_000, discoveryLag: () => 1, active: () => false, observe: null, volumeWindowSlots: 150, hook: () => {}, hasRows: () => true, schedule: () => {}, facts });
  const events: FeedEvent[] = [];
  for (const r of rows) events.push(...market.release(r));
  const mint = mints[0]!.mint;
  const curve = rows.filter((r): r is CurveTradeRow => r.kind === 'curve' && r.mint === mint);
  const create = rows.flatMap((r) => (r.kind === 'event' && r.event === 'CreateEvent' ? [r.signature] : []))[0]!;
  return { mint, curve, create, events: events.filter((e): e is MarketEvent => e.kind === 'market'), released: events.filter((e): e is MarketEvent => e.kind === 'market' && curveTradeKeys(mint).includes(e.key)) };
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

/**
 * What live's store holds of the curve, modelled by transaction (as live ingests them, whole): every curve trade of the
 * create transaction and of the completing transaction (the one whose trade empties the curve), each with the tail as
 * live decodes it.
 */
const liveTape = (r: ReturnType<typeof replay>) => r.curve.filter((c) => c.signature === r.create || c.signature === r.curve.find((x) => x.realTokenReserves === 0n)!.signature)
  .map((row) => ({ row, value: { event: { program: 'pump', name: 'TradeEvent', data: { mint: row.mint, isBuy: row.isBuy }, trailing: row.extraHex.length / 2, extra: row.extraHex }, txSlot: row.slot, signature: row.signature } }));
const backtestTape = (r: ReturnType<typeof replay>) => r.released.map((e) => ({ row: r.curve.find((c) => e.id === `te:${c.signature}:${c.evIdx}`)!, value: e.value }));
const code = (t: TailCheck) => (t.ok ? 'pass' : t.code);


// RED TEAM A round 3, RT-A2b (on #273 head b5875f9): the RT-A2 fix models live's curve tape as the create transaction and
// the completing transaction only. Live also ingests, for every candidate reaching stage 3 (H13's insider precompute),
// EVERY successful transaction of the mint from its create through max(create slot + insiderSlots (2), the slot of the
// 20th distinct first buyer) (worker/src/facts/readers.ts `readMintHistory`, `feed.ingest({ type: 'tx' }, { lookup:
// true })` for each one). Their curve TradeEvents land under `pump:TradeEvent:<mint>`, so from the next evaluation on
// H5's curve half (stage 2, re-run every evaluateEveryMs) judges them live. The backtest (`#curve` since #273) no longer
// releases those tails: an early non-zero curve tail now refuses live and passes in the backtest (a live-only veto, the
// reverse of RT-A2).
const historyTape = (r: ReturnType<typeof replay>) => {
  const ordered = [...r.curve].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : a.txIdx - b.txIdx));
  const s0 = ordered[0]!.slot;
  const first = new Map<string, bigint>();
  for (const c of ordered) if (c.isBuy && !first.has(c.user)) first.set(c.user, c.slot);
  const twentieth = [...first.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[19] ?? ordered.at(-1)!.slot;
  const through = s0 + 2n > twentieth ? s0 + 2n : twentieth;
  return ordered.filter((c) => c.slot <= through).map((row) => ({ row, value: { event: { program: 'pump', name: 'TradeEvent', data: { mint: row.mint, isBuy: row.isBuy }, trailing: row.extraHex.length / 2, extra: row.extraHex }, txSlot: row.slot, signature: row.signature } }));
};

describe('RT-A2b: live also holds the insider window\'s curve trades (readMintHistory)', () => {
  it('a non-zero tail on early curve buy #5 (inside the first 20 buyers): the backtest and live (after its stage-3 read) give the same H5 verdict', () => {
    const r = replay({ label: 'early', createSlot: 10, graduateAfter: 20 * MIN, devBuyBps: 100, curveTail: { buys: [5], hex: HEX } });
    const tailed = r.curve.find((c) => c.extraHex !== '')!;
    const live = [...liveTape(r), ...historyTape(r).filter((x) => !liveTape(r).some((y) => y.row === x.row))];
    expect(live.some((x) => x.row === tailed)).toBe(true);
    expect(code(verdict(r.mint, live))).toBe('event-tail');
    // Fails on b5875f9: the backtest releases nothing for it and passes.
    expect(code(verdict(r.mint, backtestTape(r)))).toBe(code(verdict(r.mint, live)));
  });
});
