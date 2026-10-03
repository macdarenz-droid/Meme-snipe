// FACTS-1 parity: the same recorded inputs give the same facts and the same decision log through the live path
// (LiveFeed), the recorded replay (replayRecorded, the §16.1 parity replay), the backtest re-sort (frameEvents and
// createReplay) and DATA-1's raw-record path (recordFromRaw). Real mainnet transactions and reads
// (core/test/facts/fixtures/facts.json); the producers are core's, unchanged in every path.
import { describe, expect, it } from 'vitest';
import { toBase64, type TransactionRecord } from '../../core/src/chain/index.ts';
import { createReplay, Engine, runToEnd, type Clock, type Feed, type FeedEvent, type MarketEvent, type Strategy } from '../../core/src/engine/index.ts';
import { FactFeed, FactProducer, RAW, STREAMS } from '../../core/src/facts/index.ts';
import {
  candlesKey, createKey, holdersKey, insidersKey, lpKey, migrationKey, mintKey, poolKey, streamKey, xcheckKey, SOL_USD_KEY, GRADUATES_KEY,
} from '../../core/src/gates/index.ts';
import { CONFIG } from '../../core/test/fixtures.ts';
import { FIX, MINT, OPTIONS, POOL, RECORDS, chainTx } from '../../core/test/facts/helpers.ts';
import { recordFromRaw, type RawLine } from '../../backtest/src/dataset/parity.ts';
import { DEFAULT_LIVE_FEED, frameEvents, LiveFeed, replayRecorded, type Frame, type FrameBody, type Release, type Source } from '../src/providers/index.ts';
import { blockNetwork } from './helpers.ts';

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

interface Arrival { readonly at: number; readonly source: Source; readonly body: FrameBody; readonly lookup?: boolean }

/** The recorded coin as the live worker would receive it: fetched transactions, coverage, slot notices and reads. */
const script = (records: readonly TransactionRecord[]): Arrival[] => {
  const out: Arrival[] = [];
  const complete = chainTx('pump CompleteEvent (curve filled)');
  const migrate = chainTx('migration CreatePoolEvent');
  const all = [...records, complete, migrate].filter((r, i, a) => a.findIndex((x) => x.signature === r.signature) === i).sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  const first = all[0]!;
  const t0 = (first.blockTime ?? 0) * 1000;
  out.push({ at: t0 - 2000, source: 'worker', body: { type: 'offchain', key: `coverage:${STREAMS.mintTxs(MINT)}:start`, value: { fromSlot: first.slot, via: `sigs:${MINT}` } } });
  out.push({ at: t0 - 1000, source: 'worker', body: { type: 'offchain', key: `coverage:${STREAMS.trades(POOL)}:start`, value: { fromSlot: migrate.slot, via: `logs:${POOL}` } } });
  let lastSlot = -1n;
  for (const r of all) {
    const at = (r.blockTime ?? 0) * 1000 + 500;
    if (r.slot !== lastSlot) {
      out.push({ at, source: 'helius', body: { type: 'slot', slot: r.slot, parent: r.slot - 1n, root: r.slot - 32n } });
      lastSlot = r.slot;
    }
    out.push({ at: at + 50, source: 'helius', body: { type: 'tx', record: r }, lookup: true });
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
    feed.ingest(a.source, a.body, { receivedAt: a.at, lookup: a.lookup ?? false });
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
