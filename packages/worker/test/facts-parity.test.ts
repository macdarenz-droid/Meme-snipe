// FACTS-1 parity: the same recorded inputs give the same facts and the same decision log through the live path
// (LiveFeed), the recorded replay (replayRecorded, the §16.1 parity replay), the backtest re-sort (frameEvents and
// createReplay) and DATA-1's raw-record path (recordFromRaw). Real mainnet transactions and reads
// (core/test/facts/fixtures/facts.json); the producers are core's, unchanged in every path.
import { describe, expect, it } from 'vitest';
import { toBase64, transactionEvents, type TransactionRecord } from '../../core/src/chain/index.ts';
import { createReplay, Engine, runToEnd, type Clock, type Feed, type FeedEvent, type MarketEvent, type Strategy } from '../../core/src/engine/index.ts';
import { FactFeed, FactProducer, RAW, STREAMS } from '../../core/src/facts/index.ts';
import {
  candlesKey, carryKey, createKey, holdersKey, insidersKey, lpKey, migrationKey, mintKey, poolKey, streamKey, xcheckKey, SOL_USD_KEY, GRADUATES_KEY,
} from '../../core/src/gates/index.ts';
import { CONFIG } from '../../core/test/fixtures.ts';
import { FIX, FactWorld, MINT, OPTIONS, POOL, RECORDS, chainTx, offchain } from '../../core/test/facts/helpers.ts';
import { recordFromRaw, type RawLine } from '../../backtest/src/dataset/parity.ts';
import { DEFAULT_LIVE_FEED, frameEvents, LiveFeed, replayRecorded, type Frame, type FrameBody, type Release, type Source } from '../src/providers/index.ts';
import { blockNetwork } from './helpers.ts';
import { parsePool } from '../../core/src/gates/index.ts';
import { swapLog } from '../../core/test/facts/swaps.ts';
import { ShiftedPool } from '../../core/src/fills/index.ts';
import { readAmm, type AmmSwapRow, type DatasetRow } from '../../backtest/src/dataset/rows.ts';

blockNetwork();

const KEYS = [
  createKey(MINT), migrationKey(MINT), candlesKey(MINT), mintKey(MINT), poolKey(MINT), lpKey(MINT), holdersKey(MINT), insidersKey(MINT), xcheckKey(MINT),
  streamKey(STREAMS.trades(POOL)), streamKey(STREAMS.mintTxs(MINT)), SOL_USD_KEY, GRADUATES_KEY,
];

/** Reads every gate fact of the coin on each event: the decision log records which fact event it saw. */
const reader = (): Strategy => ({
  onMarket: (e: MarketEvent, ctx) => [{ action: null, reasons: [e.key, ...KEYS.map((k) => { const l = ctx.lookup(k); return l.ok ? l.source : 'missing'; })] }],
});

const engineOn = (clock: Clock, feed: Feed) => new Engine({ clock, feed, strategy: reader(), runner: { run: () => undefined }, seed: 'facts-parity', book: CONFIG });

interface Arrival { readonly at: number; readonly source: Source; readonly body: FrameBody; readonly lookup?: boolean; readonly backfilled?: boolean }

/** COMPLETION-READ: the worker's read of the curve's completing buy lands this long after the migration's fetch. */
const COMPLETION_READ_MS = 300;

/**
 * The recorded coin as the live worker would receive it: fetched transactions, coverage, slot notices and reads. The
 * migration transaction carries no CompleteEvent (mainnet today); the completing buy is never fetched on its own live
 * (no pump-program trade stream): it arrives only through the worker's completion read (worker.ts #readCompletion),
 * after the migration, as that read puts it on the feed (a backfilled lookup).
 */
const script = (records: readonly TransactionRecord[]): Arrival[] => {
  const out: Arrival[] = [];
  const complete = chainTx('pump CompleteEvent (curve filled)');
  const migrate = chainTx('migration CreatePoolEvent');
  const all = [...records, migrate].filter((r, i, a) => r.signature !== complete.signature && a.findIndex((x) => x.signature === r.signature) === i).sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  const first = all[0]!;
  const t0 = (first.blockTime ?? 0) * 1000;
  out.push({ at: t0 - 2000, source: 'worker', body: { type: 'offchain', key: `coverage:${STREAMS.mintTxs(MINT)}:start`, value: { fromSlot: first.slot, via: `sigs:${MINT}` } } });
  out.push({ at: t0 - 1000, source: 'worker', body: { type: 'offchain', key: `coverage:${STREAMS.trades(POOL)}:start`, value: { fromSlot: migrate.slot, via: `logs:${POOL}` } } });
  let lastSlot = -1n;
  let floor = 0;
  for (const r of all) {
    const at = Math.max((r.blockTime ?? 0) * 1000 + 500, floor);
    if (r.slot !== lastSlot) {
      out.push({ at, source: 'helius', body: { type: 'slot', slot: r.slot, parent: r.slot - 1n, root: r.slot - 32n } });
      lastSlot = r.slot;
    }
    out.push({ at: at + 50, source: 'helius', body: { type: 'tx', record: r }, lookup: true });
    if (r.signature === migrate.signature) {
      floor = at + 50 + COMPLETION_READ_MS;
      out.push({ at: floor, source: 'helius', body: { type: 'tx', record: complete }, lookup: true, backfilled: true });
    }
  }
  const end = (all.at(-1)!.blockTime ?? 0) * 1000 + 2000;
  for (const f of FIX.funders) out.push({ at: end, source: 'helius', body: { type: 'offchain', key: RAW.funder(f.wallet), value: { ...f, slot: f.slot === null ? null : BigInt(f.slot) } } });
  const read = { ...FIX.accountsRead, slot: lastSlot };
  out.push({ at: end + 10, source: 'helius', body: { type: 'offchain', key: RAW.accounts(MINT), value: read } });
  out.push({ at: end + 20, source: 'rugcheck', body: { type: 'offchain', key: RAW.rugcheck(MINT), value: { mint: MINT, mintAuthority: FIX.thirdParty.rugcheck.mintAuthority, freezeAuthority: FIX.thirdParty.rugcheck.freezeAuthority } } });
  out.push({ at: end + 400, source: 'helius', body: { type: 'slot', slot: lastSlot + 1n, parent: lastSlot, root: lastSlot - 31n } });
  out.push({ at: end + 800, source: 'helius', body: { type: 'slot', slot: lastSlot + 2n, parent: lastSlot + 1n, root: lastSlot - 30n } });
  return out;
};

const live = (arrivals: readonly Arrival[]) => {
  const frames: Frame[] = [];
  const releases: Release[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 2, onFrame: (f) => frames.push(f), onRelease: (_e, r) => releases.push(r) });
  const facts = new FactFeed(feed, new FactProducer(OPTIONS));
  const seen: FeedEvent[] = [];
  const tap: Feed = { next: () => { const e = facts.next(); if (e) seen.push(e); return e; } };
  const engine = engineOn(feed.clock, tap);
  let last = 0;
  for (const a of arrivals) {
    feed.ingest(a.source, a.body, { receivedAt: a.at, lookup: a.lookup ?? false, backfilled: a.backfilled ?? false });
    feed.advance(a.at);
    engine.drain();
    last = a.at;
  }
  feed.advance(last + 60_000);
  engine.drain();
  return { engine, frames, releases, seen };
};

const through = (clock: Clock, inner: Feed) => {
  const facts = new FactFeed(inner, new FactProducer(OPTIONS));
  const seen: FeedEvent[] = [];
  const tap: Feed = { next: () => { const e = facts.next(); if (e) seen.push(e); return e; } };
  return { engine: engineOn(clock, tap), seen };
};

const factEvents = (events: readonly FeedEvent[]) => events.filter((e) => e.id.includes('~'));

describe('fact parity', () => {
  const records = RECORDS.map((r) => r.rec);
  const run = live(script(records));

  it('COMPLETION-READ: the migration carries no CompleteEvent; the completion arrives only through the read, after it', () => {
    const complete = chainTx('pump CompleteEvent (curve filled)');
    const migrate = chainTx('migration CreatePoolEvent');
    expect(transactionEvents(migrate).some((e) => e.name === 'CompleteEvent')).toBe(false);
    const txFrames = run.frames.filter((f) => f.body.type === 'tx').map((f) => ({ seq: f.seq, sig: (f.body as { record: TransactionRecord }).record.signature, backfilled: f.backfilled }));
    const mig = txFrames.filter((f) => f.sig === migrate.signature);
    const read = txFrames.filter((f) => f.sig === complete.signature);
    expect(mig).toHaveLength(1);
    expect(read).toEqual([{ seq: expect.any(Number), sig: complete.signature, backfilled: true }]);
    expect(read[0]!.seq).toBeGreaterThan(mig[0]!.seq);
    // The migration fact forms from it, after the read.
    expect(factEvents(run.seen).some((e) => (e as MarketEvent).key === migrationKey(MINT))).toBe(true);
  });

  it('the live path produces the coin\'s facts from real data', () => {
    const keys = new Set(factEvents(run.seen).map((e) => (e as MarketEvent).key));
    for (const k of [createKey(MINT), migrationKey(MINT), candlesKey(MINT), mintKey(MINT), poolKey(MINT), lpKey(MINT), insidersKey(MINT), xcheckKey(MINT), streamKey(STREAMS.trades(POOL))]) {
      expect(keys).toContain(k);
    }
    expect(run.engine.records.filter((r) => r.type === 'fault')).toEqual([]);
  });

  it('the recorded replay gives the same facts and the same decision log', () => {
    const r = replayRecorded(run.frames, run.releases);
    const b = through(r.clock, r.feed);
    b.engine.drain();
    expect(factEvents(b.seen)).toEqual(factEvents(run.seen));
    expect(b.engine.logHash()).toBe(run.engine.logHash());
  });

  it('the backtest re-sort of the same frames gives the same facts and log', () => {
    const r = createReplay(frameEvents(run.frames));
    const b = through(r.clock, r.feed);
    runToEnd(r, b.engine);
    expect(factEvents(b.seen)).toEqual(factEvents(run.seen));
    expect(b.engine.logHash()).toBe(run.engine.logHash());
  });

  it('DATA-1 raw records of the same transactions decode to the same facts', () => {
    // A raw-NNN.jsonl line carries inner instruction data as base64 (historical-data.md); parity.ts converts it.
    const toRaw = (rec: TransactionRecord): RawLine => ({
      slot: Number(rec.slot), blockTime: rec.blockTime, txIndex: rec.txIndex ?? 0, signature: rec.signature, transaction: toBase64(rec.transaction),
      err: rec.err === null ? null : { hex: '00' },
      meta: {
        fee: 5000, loadedAddresses: { writable: [...rec.loadedAddresses.writable], readonly: [...rec.loadedAddresses.readonly] },
        innerInstructions: rec.innerInstructions === null ? null : rec.innerInstructions.map((g) => ({ index: g.index, instructions: g.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: [...ix.accounts], data: toBase64(ix.data), stackHeight: ix.stackHeight })) })),
        logMessages: rec.logMessages === null ? null : [...rec.logMessages],
      },
    });
    const fromRaw = records.map((r) => ({ ...recordFromRaw(toRaw(r)), txIndex: r.txIndex }));
    const rawRun = live(script(fromRaw));
    expect(factEvents(rawRun.seen)).toEqual(factEvents(run.seen));
    expect(rawRun.engine.logHash()).toBe(run.engine.logHash());
  });
});

describe('pool state from the swap stream, live and replayed (POS-1)', () => {
  // The recorded coin, then confirmed swap log lines on its pool continuing the read's reserves: a clean run, a gap
  // in the stream, a re-base after it, and a swap that does not chain (one in between was never seen).
  const arrivals = (() => {
    const out = script(RECORDS.map((r) => r.rec));
    const read = out.find((a) => a.body.type === 'offchain' && a.body.key === RAW.accounts(MINT))!;
    const readSlot = (read.body as { value: { slot: bigint } }).value.slot;
    const end = out.at(-1)!.at;
    // The read's reserves, as the producer decodes them.
    const p = parsePool(new FactWorld().push(offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: readSlot }, readSlot, end)).last(poolKey(MINT)))!;
    let pre = { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n };
    let slot = readSlot + 2n;
    let at = end;
    let n = 0;
    const swapAt = (side: 'buy' | 'sell', base: bigint, skip = false): void => {
      slot++;
      at += 400;
      out.push({ at, source: 'helius', body: { type: 'slot', slot, parent: slot - 1n, root: slot - 32n } });
      const s = swapLog({ pool: POOL, coinCreator: FIX.meta.creator, supply: 1_000_000_000_000_000n, pre, side, base, atMs: at });
      if (!skip) out.push({ at: at + 50, source: 'helius', body: { type: 'logs', signature: `pos1swap${n++}`, slot, err: null, via: `logs:${POOL}`, logs: s.logs, commitment: 'confirmed' } });
      pre = s.after;
    };
    swapAt('buy', pre.baseReserve / 1_000n);
    swapAt('sell', pre.baseReserve / 2_000n);
    out.push({ at: at + 100, source: 'worker', body: { type: 'offchain', key: `coverage:${STREAMS.trades(POOL)}:gap`, value: { fromSlot: slot + 1n, toSlot: slot + 2n, reason: 'disconnect', via: `logs:${POOL}` } } });
    slot += 2n;
    swapAt('buy', pre.baseReserve / 500n);
    swapAt('sell', pre.baseReserve / 700n);
    swapAt('buy', pre.baseReserve / 300n, true);
    swapAt('sell', pre.baseReserve / 900n);
    out.push({ at: at + 400, source: 'helius', body: { type: 'slot', slot: slot + 1n, parent: slot, root: slot - 31n } });
    out.push({ at: at + 800, source: 'helius', body: { type: 'slot', slot: slot + 2n, parent: slot + 1n, root: slot - 30n } });
    return out;
  })();
  const run = live(arrivals);
  const pools = (events: readonly FeedEvent[]) => factEvents(events).filter((e) => (e as MarketEvent).key === poolKey(MINT)) as MarketEvent[];

  it('the live path releases the pool after each swap, stale across the gap and after the swap that does not chain', () => {
    const facts = pools(run.seen).map((e) => parsePool(e.value)!);
    const fromSwaps = facts.filter((f) => f.obs.provider === 'helius' && f.obs.slot !== null);
    // read, 2 clean swaps, the gap (flagged), the re-base swap and the next (clean), then the mismatch (flagged).
    expect(facts.map((f) => f.obs.quality.join(','))).toEqual(['', '', '', 'partial', '', '', 'partial']);
    expect(fromSwaps.length).toBeGreaterThanOrEqual(5);
    expect((pools(run.seen).at(-1)!.value as { stale: string }).stale).toMatch(/^reserves mismatch/);
    expect(run.engine.records.filter((r) => r.type === 'fault')).toEqual([]);
  });

  it('the recorded replay and the backtest re-sort give the same pool facts, event by event, and the same log', () => {
    const r = replayRecorded(run.frames, run.releases);
    const b = through(r.clock, r.feed);
    b.engine.drain();
    expect(pools(b.seen)).toEqual(pools(run.seen));
    expect(factEvents(b.seen)).toEqual(factEvents(run.seen));
    expect(b.engine.logHash()).toBe(run.engine.logHash());
    // WATCH-1c: the carries (the unchanged state through each covered slot) are derived, so every path re-releases
    // them alike, the same events in the same places.
    const carries = (events: readonly FeedEvent[]) => factEvents(events).filter((e) => (e as MarketEvent).key === carryKey(MINT));
    expect(carries(run.seen).length).toBeGreaterThan(0);
    expect(carries(b.seen)).toEqual(carries(run.seen));
    const s = createReplay(frameEvents(run.frames));
    const c = through(s.clock, s.feed);
    runToEnd(s, c.engine);
    expect(pools(c.seen)).toEqual(pools(run.seen));
    expect(carries(c.seen)).toEqual(carries(run.seen));
    expect(c.engine.logHash()).toBe(run.engine.logHash());
  });
});

describe('swaps released before the pool\'s first read, live and backtest (POOL-FIRST-READ)', () => {
  // REPLAY-1000 (pool ECVuPnoq, 6 Oct): the first account read, answered for an older slot, lands after swaps of newer
  // slots. The tape: the recorded coin, then confirmed swaps continuing the read's real reserves; once with the read in
  // order (as the backtest's as-of read sees it), once with it landing late, after three of them.
  const SUPPLY = 1_000_000_000_000_000n;
  const tape = (late: boolean) => {
    const out = script(RECORDS.map((r) => r.rec));
    const i = out.findIndex((a) => a.body.type === 'offchain' && a.body.key === RAW.accounts(MINT));
    const read = out.splice(i, 1)[0]!;
    const readSlot = (read.body as { value: { slot: bigint } }).value.slot;
    const tail = out.splice(out.findIndex((a, k) => k >= i && a.body.type === 'slot'));
    const p = parsePool(new FactWorld().push(offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: readSlot }, readSlot, read.at)).last(poolKey(MINT)))!;
    let pre = { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n };
    let at = read.at;
    if (!late) out.push(read);
    const swaps: { slot: bigint; data: Record<string, unknown>; side: 'buy' | 'sell' }[] = [];
    const swapAt = (slot: bigint, side: 'buy' | 'sell', base: bigint, n: number): void => {
      at += 200;
      const s = swapLog({ pool: POOL, coinCreator: FIX.meta.creator, supply: SUPPLY, pre, side, base, atMs: at });
      out.push({ at, source: 'helius', body: { type: 'logs', signature: `pfr${n}`, slot, err: null, via: `logs:${POOL}`, logs: s.logs, commitment: 'confirmed' } });
      swaps.push({ slot, data: s.data, side });
      pre = s.after;
    };
    out.push(...tail.slice(0, 1).map((a) => ({ ...a, at: at + 100 })));
    swapAt(readSlot + 1n, 'buy', pre.baseReserve / 1_000n, 0);
    swapAt(readSlot + 1n, 'sell', pre.baseReserve / 2_000n, 1);
    out.push(...tail.slice(1, 2).map((a) => ({ ...a, at: at + 100 })));
    at += 100;
    swapAt(readSlot + 2n, 'buy', pre.baseReserve / 700n, 2);
    if (late) out.push({ ...read, at: at + 50 });
    at += 400;
    out.push({ at, source: 'helius', body: { type: 'slot', slot: readSlot + 3n, parent: readSlot + 2n, root: readSlot - 29n } });
    swapAt(readSlot + 3n, 'sell', pre.baseReserve / 900n, 3);
    out.push({ at: at + 400, source: 'helius', body: { type: 'slot', slot: readSlot + 4n, parent: readSlot + 3n, root: readSlot - 28n } });
    out.push({ at: at + 800, source: 'helius', body: { type: 'slot', slot: readSlot + 5n, parent: readSlot + 4n, root: readSlot - 27n } });
    return { arrivals: out, swaps, end: pre };
  };
  const pools = (events: readonly FeedEvent[]) => factEvents(events).filter((e) => (e as MarketEvent).key === poolKey(MINT)).map((e) => (e as MarketEvent).value as Record<string, unknown>);
  const carries = (events: readonly FeedEvent[]) => factEvents(events).filter((e) => (e as MarketEvent).key === carryKey(MINT)).map((e) => (e as MarketEvent).value as { slot: bigint; state: unknown });

  it('the late read gives the same pool state as the read in order, clean, and the same as the backtest\'s replay of the swaps', () => {
    const inOrder = tape(false);
    const late = tape(true);
    const a = live(inOrder.arrivals);
    const b = live(late.arrivals);
    const last = (r: ReturnType<typeof live>) => parsePool(pools(r.seen).at(-1))!;
    for (const r of [a, b]) {
      expect(pools(r.seen).every((v) => v['stale'] === undefined)).toBe(true);
      expect(last(r)).toMatchObject({ baseVault: late.end.baseReserve, quoteVault: late.end.quoteVault, obs: { quality: [] } });
      expect(r.engine.records.filter((x) => x.type === 'fault')).toEqual([]);
    }
    expect(last(b)).toEqual(last(a));
    expect(carries(b.seen).at(-1)).toEqual(carries(a.seen).at(-1));
    expect(carries(b.seen).at(-1)!.state).toEqual(late.end);
    // The backtest's pool state: DATA-1's amm rows of the same swaps through `readAmm` and `ShiftedPool.applyReal`.
    const shifted = new ShiftedPool();
    let real: unknown = null;
    for (const s of late.swaps) {
      const d = s.data as Record<string, bigint | string | boolean>;
      const buy = s.side === 'buy';
      const cols: Record<string, string> = {
        slot: String(s.slot), block_time: '1790968137', tx_idx: '0', ev_idx: '0', signature: 'x', pool: POOL, base_mint: MINT, quote_mint: 'So11111111111111111111111111111111111111112', side: s.side,
        base_amount: String(buy ? d['baseAmountOut'] : d['baseAmountIn']), quote_amount: String(buy ? d['quoteAmountIn'] : d['quoteAmountOut']),
        user_quote_amount: String(buy ? d['userQuoteAmountIn'] : d['userQuoteAmountOut']), pool_base_token_reserves: String(d['poolBaseTokenReserves']),
        pool_quote_token_reserves: String(d['poolQuoteTokenReserves']), virtual_quote_reserves: String(d['virtualQuoteReserves']), lp_fee_basis_points: String(d['lpFeeBasisPoints']),
        protocol_fee_basis_points: String(d['protocolFeeBasisPoints']), coin_creator_fee_basis_points: String(d['coinCreatorFeeBasisPoints']), buyback_fee_basis_points: String(d['buybackFeeBasisPoints']),
        base_supply: String(d['baseSupply']), ix_name: buy ? 'buy' : '', user: 'u', user_token_account: '', user_token_owner: '',
      };
      const names = Object.keys(cols);
      const rows: DatasetRow[] = [];
      readAmm(`${names.join(',')}\n${names.map((n) => cols[n]).join(',')}\n`, rows);
      const r = shifted.applyReal(rows[0] as AmmSwapRow);
      expect(r).not.toBeNull();
      real = r!.real;
    }
    expect(real).toEqual(late.end);
  });

  it('the recorded replay and the backtest re-sort of the late run give the same facts and log', () => {
    const run = live(tape(true).arrivals);
    const r = replayRecorded(run.frames, run.releases);
    const b = through(r.clock, r.feed);
    b.engine.drain();
    expect(factEvents(b.seen)).toEqual(factEvents(run.seen));
    expect(b.engine.logHash()).toBe(run.engine.logHash());
    const s = createReplay(frameEvents(run.frames));
    const c = through(s.clock, s.feed);
    runToEnd(s, c.engine);
    expect(factEvents(c.seen)).toEqual(factEvents(run.seen));
    expect(c.engine.logHash()).toBe(run.engine.logHash());
  });
});

describe('candles after a late migration, live and replayed (POOL-FIRST-READ part 3)', () => {
  // #263's finding: the pool's candle book opens at the migration's CreatePoolEvent; swaps released before a late
  // migration (a re-read) were dropped, leaving the candles [] and complete. The recorded coin, its pool read and
  // swaps continuing the read; once with the migration transaction in order, once fetched late, after the swaps.
  const SUPPLY = 1_000_000_000_000_000n;
  const tape = (late: boolean) => {
    const out = script(RECORDS.map((r) => r.rec));
    const migrate = chainTx('migration CreatePoolEvent');
    const complete = chainTx('pump CompleteEvent (curve filled)');
    const isMigration = (a: Arrival) => a.body.type === 'tx' && [migrate.signature, complete.signature].includes((a.body as { record: TransactionRecord }).record.signature);
    const moved = late ? out.filter(isMigration) : [];
    const kept = late ? out.filter((a) => !isMigration(a)) : out;
    const read = kept.find((a) => a.body.type === 'offchain' && a.body.key === RAW.accounts(MINT))!;
    const readSlot = (read.body as { value: { slot: bigint } }).value.slot;
    const p = parsePool(new FactWorld().push(offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: readSlot }, readSlot, read.at)).last(poolKey(MINT)))!;
    let pre = { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n };
    let at = kept.at(-1)!.at;
    let slot = readSlot + 2n;
    for (let i = 0; i < 5; i++) {
      slot++;
      at += 30_000;
      kept.push({ at, source: 'helius', body: { type: 'slot', slot, parent: slot - 1n, root: slot - 32n } });
      const s = swapLog({ pool: POOL, coinCreator: FIX.meta.creator, supply: SUPPLY, pre, side: i % 2 === 0 ? 'buy' : 'sell', base: pre.baseReserve / BigInt(500 + 100 * i), atMs: at });
      kept.push({ at: at + 50, source: 'helius', body: { type: 'logs', signature: `lm${i}`, slot, err: null, via: `logs:${POOL}`, logs: s.logs, commitment: 'confirmed' } });
      pre = s.after;
    }
    // Late: the migration transaction (and the completion read) fetched now, as a re-read puts them on the feed.
    at += 1_000;
    for (const a of moved) kept.push({ ...a, at: at++, lookup: true });
    kept.push({ at: at + 400, source: 'helius', body: { type: 'slot', slot: slot + 1n, parent: slot, root: slot - 31n } });
    kept.push({ at: at + 800, source: 'helius', body: { type: 'slot', slot: slot + 2n, parent: slot + 1n, root: slot - 30n } });
    return kept;
  };
  const lastOf = (events: readonly FeedEvent[], key: string) => (factEvents(events).filter((e) => (e as MarketEvent).key === key).at(-1) as MarketEvent | undefined)?.value as Record<string, unknown> | undefined;
  const noReceipt = (v: Record<string, unknown> | undefined) => {
    const { receivedAt: _r, ...obs } = (v?.['obs'] ?? {}) as Record<string, unknown>;
    return { ...v, obs };
  };

  it('the late migration gives the in-order candles (not [] complete) and pool, with no fault', () => {
    const a = live(tape(false));
    const b = live(tape(true));
    const ca = lastOf(a.seen, candlesKey(MINT))!;
    const cb = lastOf(b.seen, candlesKey(MINT))!;
    expect((ca['candles'] as unknown[]).length).toBeGreaterThan(0);
    expect(noReceipt(cb)).toEqual(noReceipt(ca));
    expect(noReceipt(lastOf(b.seen, poolKey(MINT)))).toEqual(noReceipt(lastOf(a.seen, poolKey(MINT))));
    for (const r of [a, b]) expect(r.engine.records.filter((x) => x.type === 'fault')).toEqual([]);
  });

  it('the recording of the late run replays identically 10 times, and the backtest re-sort gives the same facts and log', () => {
    const run = live(tape(true));
    for (let i = 0; i < 10; i++) {
      const r = replayRecorded(run.frames, run.releases);
      const b = through(r.clock, r.feed);
      b.engine.drain();
      expect(factEvents(b.seen)).toEqual(factEvents(run.seen));
      expect(b.engine.logHash()).toBe(run.engine.logHash());
    }
    const s = createReplay(frameEvents(run.frames));
    const c = through(s.clock, s.feed);
    runToEnd(s, c.engine);
    expect(factEvents(c.seen)).toEqual(factEvents(run.seen));
    expect(c.engine.logHash()).toBe(run.engine.logHash());
  });
});
