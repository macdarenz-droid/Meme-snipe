// DEDUP-PER-WATCH: the worker watches each candidate pool with its own logs watch, and the live feed kept one copy of a
// log per signature and commitment, whichever watch it came from. A transaction touching two watched pools reached the
// engine through the first pool's watch only: a cut log made a hole in that pool's trade stream alone, so the second
// pool's candles missed its swaps after the cut with no gap (H11 passed: fail-open), and a pool event other than a swap
// staled the first watch's pool, not the pool it touched.
import { describe, expect, it } from 'vitest';
import { type PoolState } from '../../core/src/amm/index.ts';
import { InitBoostEventLayout, PUMP_AMM_PROGRAM, encodeBase58, toBase64 } from '../../core/src/chain/index.ts';
import { OFF_CHAIN, compareEvents, type MarketEvent } from '../../core/src/engine/index.ts';
import { HOLE_FETCH_PREFIX, RAW, STREAMS } from '../../core/src/facts/index.ts';
import { DeployerIndex, candlesKey, parsePool, parseStream, poolKey, streamKey } from '../../core/src/gates/index.ts';
import { FIX, FactWorld, MINT, POOL } from '../../core/test/facts/helpers.ts';
import { encode } from '../../core/test/chain/encode.ts';
import { swapLog } from '../../core/test/facts/swaps.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, frameEvents, replayRecorded, type Frame, type FrameBody, type Release } from '../src/providers/index.ts';
import { parseTyped, typedText } from '../src/run/json.ts';
import { CUT_CREATE_RETRY_MS } from '../src/run/worker.ts';
import { type Harness, POOL_ADDRESS, makeWorker, passingMarket, slotAt } from './worker-harness.ts';
import { blockNetwork } from './helpers.ts';

blockNetwork();

/** A valid 32-byte address, distinct per `n`. */
const addr = (n: number): string => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7 + i)));
const A = { mint: addr(1), pool: addr(2) };
const B = { mint: addr(3), pool: addr(4) };
const VIA = (p: { pool: string }) => `logs:${p.pool}`;
const CREATOR = addr(5);
const SUPPLY = 1_000_000_000_000_000n;
const PRE: PoolState = { baseReserve: 200_000_000_000_000n, quoteVault: 85_000_000_000n, virtualQuoteReserves: 0n };
const S0 = 1_000n;
const T0 = 1_791_100_000_000;
const at = (slot: bigint): number => T0 + Number(slot - S0) * 400;
const SIG = '5QYKumkywidnDav6oDdP4teAY247nwxDg3gWsZ1nAmnsejadN6r2YmxJiuLXy4bxw9eDvpCgr7fHLSBfpRehCMBM';

let k = 0;
const life = (program: 'pump' | 'pump_amm', name: string, data: Record<string, unknown>, mint: string, slot: bigint): MarketEvent => ({
  kind: 'market', id: `ev:life${k}:00000:00000`, moment: { slot, txIndex: 2 ** 32 + k, ixIndex: 1, receivedAt: at(slot) },
  key: `${program}:${name}:${mint}`,
  value: { event: { program, name, data, signature: `life${k++}`, slot, txIndex: 0, outerIx: 0, innerIx: 0 }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false, seq: k },
});
const fact = (key: string, value: unknown, slot: bigint): MarketEvent =>
  ({ kind: 'market', id: `${key}#${k++}`, moment: { slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: at(slot) }, key, value: { value, source: 'helius', backfilled: false, seq: k } });

/** Both coins migrated to their pools, each pool on its own watch from S0. */
const opened = (): FactWorld => {
  const all: MarketEvent[] = [];
  for (const p of [A, B]) {
    const stamp = BigInt(Math.floor(at(S0) / 1000));
    all.push(
      fact(`coverage:${STREAMS.trades(p.pool)}:start`, { fromSlot: S0, via: VIA(p) }, S0 - 2n),
      life('pump', 'CompleteEvent', { mint: p.mint, timestamp: stamp }, p.mint, S0 - 1n),
      life('pump_amm', 'CreatePoolEvent', { timestamp: stamp, baseMint: p.mint, pool: p.pool, poolQuoteAmount: PRE.quoteVault, poolBaseAmount: PRE.baseReserve }, p.mint, S0),
      life('pump', 'CompletePumpAmmMigrationEvent', { mint: p.mint, pool: p.pool, timestamp: stamp }, p.mint, S0),
    );
  }
  return new FactWorld().push(...all.sort(compareEvents));
};

const swapOf = (p: { pool: string }, slot: bigint) => swapLog({ pool: p.pool, coinCreator: CREATOR, supply: SUPPLY, pre: PRE, side: 'buy', base: 1_000_000_000n, atMs: at(slot) });

/** One transaction's log, seen by each watch in `vias` (and twice on the first, from a second provider), through the live feed. */
const through = (w: FactWorld, logs: readonly string[], slot: bigint, vias: readonly string[], t = at(slot)): MarketEvent[] => {
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
  for (const [i, via] of vias.entries()) {
    const body: FrameBody = { type: 'logs', signature: SIG, slot, err: null, via, logs: [...logs], commitment: 'confirmed' };
    feed.ingest('helius', body, { receivedAt: t + i });
    if (i === 0) feed.ingest('alchemy', body, { receivedAt: t + i });
  }
  feed.ingest('helius', { type: 'slot', slot: slot + 1n, parent: slot, root: null }, { receivedAt: t + 10 });
  feed.advance(t + 11);
  const out: MarketEvent[] = [];
  for (let e = feed.next(); e !== null; e = feed.next()) if (e.kind === 'market') out.push(e);
  w.push(...out);
  return out;
};

const gapFree = (w: FactWorld, p: { pool: string }): bigint => parseStream(w.last(streamKey(STREAMS.trades(p.pool))))!.gapFreeSince;
const candleWrites = (w: FactWorld, p: { mint: string }): number => w.facts(candlesKey(p.mint)).length;

describe('DEDUP-PER-WATCH: a transaction touching two watched pools', () => {
  const S = S0 + 5n;

  it('gives both pools its swaps', () => {
    const w = opened();
    const before = [candleWrites(w, A), candleWrites(w, B)];
    through(w, [...swapOf(A, S).logs, ...swapOf(B, S).logs], S, [VIA(A), VIA(B)]);
    expect(candleWrites(w, A)).toBeGreaterThan(before[0]!);
    expect(candleWrites(w, B)).toBeGreaterThan(before[1]!);
  });

  it('a cut log gives both pools a hole', () => {
    const w = opened();
    // Cut after pool A's swap: pool B's swap (and anything after it) is lost from the log.
    through(w, [...swapOf(A, S).logs, 'Log truncated'], S, [VIA(A), VIA(B)]);
    expect(gapFree(w, A)).toBe(S + 1n);
    expect(gapFree(w, B)).toBe(S + 1n);
  });

  it('an echo after its slot was released still gives its pool a hole, placed after everything (never refused as late)', () => {
    const w = opened();
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
    const t = at(S);
    const body = (via: string): FrameBody => ({ type: 'logs', signature: SIG, slot: S, err: null, via, logs: [...swapOf(A, S).logs, 'Log truncated'], commitment: 'confirmed' });
    const out: MarketEvent[] = [];
    const drain = (ms: number): void => {
      feed.advance(ms);
      for (let e = feed.next(); e !== null; e = feed.next()) if (e.kind === 'market') out.push(e);
    };
    feed.ingest('helius', body(VIA(A)), { receivedAt: t });
    feed.ingest('helius', { type: 'slot', slot: S + 1n, parent: S, root: null }, { receivedAt: t + 10 });
    drain(t + 11);
    const late = feed.ingest('helius', body(VIA(B)), { receivedAt: t + 20 });
    expect(late.echo).toBe(true);
    expect(late.place.at).toBe('offchain');
    feed.ingest('helius', { type: 'slot', slot: S + 2n, parent: S + 1n, root: null }, { receivedAt: t + 30 });
    drain(t + 31);
    expect(feed.status().late).toBe(0);
    w.push(...out);
    expect(gapFree(w, B)).toBeGreaterThan(S);
  });

  it('a cut log with no event left gives both pools a hole', () => {
    const w = opened();
    through(w, ['Log truncated'], S, [VIA(A), VIA(B)]);
    expect(gapFree(w, A)).toBe(S + 1n);
    expect(gapFree(w, B)).toBe(S + 1n);
  });
});

describe('DEDUP-PER-WATCH: a PumpSwap event other than a swap stales the pool it touched', () => {
  // Pool B is the fixture's pool, with a swap chain from its real read; pool A is another watched pool with no chain.
  const R = BigInt(FIX.accountsRead.slot);
  const atR = (slot: bigint): number => T0 + Number(slot - R) * 400;
  const PB = { mint: MINT, pool: POOL };
  const opened = (): FactWorld => {
    const stamp = BigInt(Math.floor(atR(R - 5n) / 1000));
    const read: MarketEvent = { ...fact(RAW.accounts(MINT), { ...FIX.accountsRead, slot: R }, R), moment: { slot: R, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: atR(R) } };
    const p = parsePool(new FactWorld().push(read).last(poolKey(MINT)))!;
    const ev = (m: MarketEvent, slot: bigint): MarketEvent => ({ ...m, moment: { ...m.moment, slot, receivedAt: atR(slot) } });
    const all = [
      ev(fact(`coverage:${STREAMS.trades(A.pool)}:start`, { fromSlot: R - 6n, via: VIA(A) }, R - 7n), R - 7n),
      ev(fact(`coverage:${STREAMS.trades(POOL)}:start`, { fromSlot: R - 6n, via: VIA(PB) }, R - 7n), R - 7n),
      ev(life('pump', 'CompleteEvent', { mint: MINT, timestamp: stamp }, MINT, R - 6n), R - 6n),
      ev(life('pump_amm', 'CreatePoolEvent', { timestamp: stamp, baseMint: MINT, pool: POOL, poolQuoteAmount: p.quoteVault, poolBaseAmount: p.baseVault }, MINT, R - 5n), R - 5n),
      ev(life('pump', 'CompletePumpAmmMigrationEvent', { mint: MINT, pool: POOL, timestamp: stamp }, MINT, R - 5n), R - 5n),
      read,
    ];
    return new FactWorld().push(...all.sort(compareEvents));
  };
  const staleOf = (w: FactWorld): unknown => (w.last(poolKey(MINT)) as { stale?: unknown } | undefined)?.stale;
  const invoke = (data: number[]): string[] => [`Program ${PUMP_AMM_PROGRAM} invoke [1]`, `Program data: ${toBase64(Uint8Array.from(data))}`, `Program ${PUMP_AMM_PROGRAM} success`];
  /** A PumpSwap event DEC-1 cannot name (a deposit or a withdrawal): it names no pool. */
  const unnamed = invoke([9, 9, 9, 9, 9, 9, 9, 9, 1, 2, 3]);
  /** A named one that says its pool. */
  const boost = (pool: string): string[] => invoke([...InitBoostEventLayout.discriminator, ...encode([...InitBoostEventLayout.base, ...InitBoostEventLayout.added] as unknown as readonly (readonly [string, { idl: unknown }])[], {
    timestamp: BigInt(Math.floor(atR(R + 3n) / 1000)), mint: MINT, bondingCurve: A.mint, pool, virtualQuoteReserves: 0n, realQuoteReservesAfter: 1n,
  })]);
  const S = R + 3n;

  it('the fixture is a real test: the chain is clean before', () => {
    const w = opened();
    expect(w.last(poolKey(MINT))).toBeDefined();
    expect(staleOf(w)).toBeUndefined();
  });

  it('an unnamed event seen first on another watch stales this pool too', () => {
    const w = opened();
    through(w, unnamed, S, [VIA(A), VIA(PB)], atR(S));
    expect(staleOf(w)).toMatch(/other than a swap/);
  });

  it('a named event stales the pool it names, whichever watch carried it', () => {
    const w = opened();
    // Seen on pool A's watch only: before, it staled pool A (the watch's pool) and left pool B's chain clean.
    through(w, boost(POOL), S, [VIA(A)], atR(S));
    expect(staleOf(w)).toMatch(/other than a swap \(InitBoostEvent\)/);
  });

  it('a named event for another pool, on this pool\'s watch, leaves this pool clean', () => {
    const w = opened();
    through(w, boost(A.pool), S, [VIA(PB)], atR(S));
    expect(staleOf(w)).toBeUndefined();
  });
});

describe('DEDUP-PER-WATCH parity', () => {
  // Each pool has had one swap (the heal's anchor); then one transaction swaps on both, and its log is cut after pool
  // A's swap. Live: both pools get a hole, the transaction is fetched, and each pool's outcome heals it. The backtest
  // holds the full transaction: no hole. Both must end with the same candles and the same coverage.
  const S1 = S0 + 3n;
  const S2 = S0 + 6n;
  const SIG2 = '4QYKumkywidnDav6oDdP4teAY247nwxDg3gWsZ1nAmnsejadN6r2YmxJiuLXy4bxw9eDvpCgr7fHLSBfpRehCMBM';
  const SIG1 = (p: { pool: string }) => (p === A ? '3QYKumkywidnDav6oDdP4teAY247nwxDg3gWsZ1nAmnsejadN6r2YmxJiuLXy4bxw9eDvpCgr7fHLSBfpRehCMBM' : '2QYKumkywidnDav6oDdP4teAY247nwxDg3gWsZ1nAmnsejadN6r2YmxJiuLXy4bxw9eDvpCgr7fHLSBfpRehCMBM');
  const first = (p: { pool: string }) => swapLog({ pool: p.pool, coinCreator: CREATOR, supply: SUPPLY, pre: PRE, side: 'buy', base: 1_000_000_000n, atMs: at(S1) });
  const second = (p: { pool: string }) => swapLog({ pool: p.pool, coinCreator: CREATOR, supply: SUPPLY, pre: first(p).after, side: 'sell', base: 400_000_000n, atMs: at(S2) });
  /** A fetched (or backtest) transaction's swap events, as DEC-1 gives them from its instructions. */
  const ev = (sig: string, slot: bigint, moment: MarketEvent['moment'], swaps: readonly { pool: string; name: string; data: Record<string, unknown> }[]): MarketEvent[] =>
    swaps.map((x, i) => ({
      kind: 'market', id: `ev:${sig}:00000:${String(i).padStart(5, '0')}`, moment: { ...moment, ixIndex: moment.ixIndex + i }, key: `pump_amm:${x.name}:${x.pool}`,
      value: { event: { program: 'pump_amm', name: x.name, data: x.data, signature: sig, slot, txIndex: 0, outerIx: i, innerIx: 0 }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false, seq: k++ },
    }));
  const swapsOf = (pick: 'first' | 'second') => [A, B].map((p) => ({ pool: p.pool, name: pick === 'first' ? 'BuyEvent' : 'SellEvent', data: (pick === 'first' ? first(p) : second(p)).data }));

  /** The live run: the frames and releases recorded, and the events the engine got. */
  const live = () => {
    const frames: Frame[] = [];
    const releases: Release[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => frames.push(f), onRelease: (_e, r) => releases.push(r) });
    const out: MarketEvent[] = [];
    const drain = (t: number): void => {
      feed.advance(t);
      for (let e = feed.next(); e !== null; e = feed.next()) if (e.kind === 'market') out.push(e);
    };
    for (const p of [A, B]) feed.ingest('helius', { type: 'logs', signature: SIG1(p), slot: S1, err: null, via: VIA(p), logs: first(p).logs, commitment: 'confirmed' }, { receivedAt: at(S1) });
    feed.ingest('helius', { type: 'slot', slot: S1 + 1n, parent: S1, root: null }, { receivedAt: at(S1) + 10 });
    drain(at(S1) + 11);
    const cut: FrameBody[] = [VIA(A), VIA(B)].map((via) => ({ type: 'logs', signature: SIG2, slot: S2, err: null, via, logs: [...second(A).logs, 'Log truncated'], commitment: 'confirmed' }));
    feed.ingest('helius', cut[0]!, { receivedAt: at(S2) });
    feed.ingest('alchemy', cut[0]!, { receivedAt: at(S2) });
    feed.ingest('helius', cut[1]!, { receivedAt: at(S2) + 1 });
    feed.ingest('alchemy', cut[1]!, { receivedAt: at(S2) + 1 });
    feed.ingest('helius', { type: 'slot', slot: S2 + 1n, parent: S2, root: null }, { receivedAt: at(S2) + 10 });
    drain(at(S2) + 11);
    return { feed, frames, releases, out, drain };
  };

  const healed = (): { world: FactWorld; frames: Frame[]; releases: Release[]; events: MarketEvent[] } => {
    const l = live();
    const w = opened().push(...l.out);
    // Fail closed until the fetch: both pools have a hole.
    expect(gapFree(w, A)).toBe(S2 + 1n);
    expect(gapFree(w, B)).toBe(S2 + 1n);
    // The worker's fetch: the transaction's events, then each pool's outcome (off-chain, after the open slot).
    const t = at(S2) + 500;
    const fetched = ev(SIG2, S2, { slot: S2 + 2n, txIndex: OFF_CHAIN, ixIndex: 1, receivedAt: t }, swapsOf('second'));
    const outcomes: MarketEvent[] = [A, B].map((p, i) => ({
      kind: 'market', id: `${HOLE_FETCH_PREFIX}${VIA(p)}#${k++}`, moment: { slot: S2 + 2n, txIndex: OFF_CHAIN, ixIndex: 100 + i, receivedAt: t + 1 },
      key: `${HOLE_FETCH_PREFIX}${VIA(p)}`, value: { value: { signature: SIG2, found: true }, source: 'worker', backfilled: false, seq: k++ },
    }));
    w.push(...fetched, ...outcomes, { kind: 'market', id: `slot:${S2 + 3n}`, moment: { slot: S2 + 3n, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: t + 2 }, key: 'chain:slot', value: { slot: S2 + 3n, parent: S2 + 2n, root: null, source: 'helius', backfilled: false, seq: k++ } });
    return { world: w, frames: l.frames, releases: l.releases, events: l.out };
  };

  const backtest = (): FactWorld => {
    const w = opened();
    w.push(...ev('bt1', S1, { slot: S1, txIndex: 0, ixIndex: 1, receivedAt: at(S1) }, swapsOf('first')));
    w.push(...ev(SIG2, S2, { slot: S2, txIndex: 0, ixIndex: 1, receivedAt: at(S2) }, swapsOf('second')));
    w.push({ kind: 'market', id: `slot:${S2 + 3n}`, moment: { slot: S2 + 3n, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: at(S2) + 502 }, key: 'chain:slot', value: { slot: S2 + 3n, parent: S2 + 2n, root: null, source: 'helius', backfilled: false, seq: k++ } });
    return w;
  };

  const candles = (w: FactWorld, p: { mint: string }) => (w.last(candlesKey(p.mint)) as { candles: unknown; obs: { quality: unknown } }).candles;

  it('live, healed after the fetch, matches the backtest of the full transaction on both pools', () => {
    const l = healed().world;
    const bt = backtest();
    for (const p of [A, B]) {
      expect((candles(l, p) as unknown[]).length).toBeGreaterThan(0);
      expect(candles(l, p)).toEqual(candles(bt, p));
      expect(gapFree(l, p)).toBe(gapFree(bt, p));
      expect(gapFree(l, p)).toBe(S0);
    }
  });

  it('the recording replays to the same events and facts (each watch\'s echo kept, the second provider\'s copy not)', () => {
    const h = healed();
    const frames = h.frames.map((f) => parseTyped(typedText(f)) as Frame);
    expect(frames.filter((f) => f.echo === true).map((f) => (f.body as { via: string }).via)).toEqual([VIA(B)]);
    expect(frames.filter((f) => f.duplicate).length).toBe(2);
    const r = replayRecorded(frames, h.releases.map((x) => parseTyped(typedText(x)) as Release));
    const replayed: MarketEvent[] = [];
    for (let e = r.feed.next(); e !== null; e = r.feed.next()) if (e.kind === 'market') replayed.push(e);
    expect(replayed.map((e) => e.id)).toEqual(h.events.map((e) => e.id));
    expect(typedText(replayed)).toBe(typedText(h.events));
    const again = opened().push(...replayed);
    const once = opened().push(...h.events);
    expect(typedText(again.released.filter((e) => e.id.includes('~')).map((e) => [e.key, e.value]))).toBe(typedText(once.released.filter((e) => e.id.includes('~')).map((e) => [e.key, e.value])));
  });

  it('ten runs give the same frames, releases, events and facts, and each replays to them', () => {
    const texts = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const h = healed();
      const r = replayRecorded(h.frames.map((f) => parseTyped(typedText(f)) as Frame), h.releases);
      const replayed: MarketEvent[] = [];
      for (let e = r.feed.next(); e !== null; e = r.feed.next()) if (e.kind === 'market') replayed.push(e);
      expect(typedText(replayed)).toBe(typedText(h.events));
      const facts = h.world.released.filter((e) => e.id.includes('~')).map((e) => [e.key, e.value]);
      texts.add(typedText({ frames: h.frames, releases: h.releases, events: h.events, facts }));
    }
    expect(texts.size).toBe(1);
  });

  it('a recording with echoes is refused under the pre-echo rules (an echo read as a whole copy), and by frameEvents', () => {
    const h = healed();
    // The pre-echo reader knows no `echo`: it makes the copy's whole events, under the first copy's ids, from a frame
    // the release record does not name for them.
    const old = h.frames.map((f) => (f.echo === true ? { ...f, echo: undefined } : f)) as Frame[];
    expect(() => replayRecorded(old, h.releases)).toThrow(/is not in frame/);
    expect(() => frameEvents(h.frames)).toThrow(/replayRecorded/);
  });

  it('a recording made before echoes (the other watch\'s copy a duplicate) replays as it did', () => {
    const h = healed();
    const old = h.frames.map((f) => (f.echo === true ? { ...f, echo: undefined, duplicate: true } : f)) as Frame[];
    const kept = new Set(old.filter((f) => !f.duplicate).map((f) => f.seq));
    const r = replayRecorded(old, h.releases.filter((x) => kept.has(x.frameSeq)).map((x, i) => ({ ...x, index: i })));
    const ids: string[] = [];
    for (let e = r.feed.next(); e !== null; e = r.feed.next()) ids.push(e.id);
    expect(ids).toEqual(h.events.filter((e) => !e.id.includes('@')).map((e) => e.id));
  });
});

describe('DEDUP-PER-WATCH: the worker fetches a cut log once for every pool watch it is a hole on', () => {
  const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const VIA1 = `logs:${POOL_ADDRESS}`;
  const OTHER = addr(9);
  const VIA2 = `logs:${OTHER}`;
  const CUT_SIG = SIG;

  const outcomes = (h: Harness): { signature: string; found: boolean; via: string }[] => {
    const out: { signature: string; found: boolean; via: string }[] = [];
    const feed = h.worker.feed;
    const ingest = feed.ingest.bind(feed);
    feed.ingest = (source, body, o) => {
      if (body.type === 'offchain' && body.key.startsWith(HOLE_FETCH_PREFIX)) out.push({ ...(body.value as { signature: string; found: boolean }), via: body.key.slice(HOLE_FETCH_PREFIX.length) });
      return ingest(source, body, o);
    };
    return out;
  };
  const cut = (h: Harness, via: string) =>
    h.worker.feed.ingest('helius', { type: 'logs', signature: CUT_SIG, slot: slotAt(h.timers.now()), err: null, via, logs: [`Program ${AMM} invoke [1]`, 'Log truncated'], commitment: 'confirmed' }, { receivedAt: h.timers.now() });
  const settle = async (h: Harness, turns = 60) => {
    for (let i = 0; i < turns; i++) {
      h.worker.step();
      await new Promise<void>((r) => setImmediate(r));
    }
  };
  /** Two watched candidate pools: the harness's, and OTHER (stands in for a second migration). */
  const twoPools = async (found: boolean | ((s: string, why: string) => boolean), fetchedWhy: [string, string][]) => {
    const h = makeWorker({ found, fetchedWhy });
    await h.worker.reconcile();
    const m = await passingMarket(h);
    m.tradesStart(slotAt(h.timers.now()) - 100n);
    m.offchain(`coverage:trades:${OTHER}:start`, { fromSlot: slotAt(h.timers.now()) - 100n, via: VIA2 });
    const own = h.worker.strategy.watchedPools.bind(h.worker.strategy);
    h.worker.strategy.watchedPools = () => new Map([...own(), [OTHER, { mint: OTHER, held: false, fromSlot: 1n }]]);
    await m.run(1_000, 200, () => m.slot());
    expect(h.worker.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
    return { h, m, out: outcomes(h) };
  };
  const tries = (w: [string, string][]) => w.filter(([x, why]) => x === CUT_SIG && why === 'cut-trade').length;

  it('one fetch; once found, both pools are told found', async () => {
    const fetchedWhy: [string, string][] = [];
    const { h, m, out } = await twoPools(true, fetchedWhy);
    cut(h, VIA1);
    cut(h, VIA2);
    await m.run(2_000, 200, () => m.slot());
    expect(tries(fetchedWhy)).toBe(1);
    expect(out.map((o) => [o.via, o.found])).toEqual([[VIA1, true], [VIA2, true]]);
    await h.worker.stop();
  });

  it('fails closed: not found after the last try tells both pools, and nothing more is fetched', async () => {
    const fetchedWhy: [string, string][] = [];
    const { h, m, out } = await twoPools(false, fetchedWhy);
    cut(h, VIA1);
    cut(h, VIA2);
    await m.run(2_000, 200, () => m.slot());
    await settle(h);
    await settle(h);
    expect(tries(fetchedWhy)).toBe(CUT_CREATE_RETRY_MS.length + 1);
    expect(out.map((o) => [o.via, o.found])).toEqual([[VIA1, false], [VIA2, false]]);
    await h.worker.stop();
  });

  it('a pool heard of after the fetch settled is told not found at once (its swaps may be applied ahead of it)', async () => {
    const fetchedWhy: [string, string][] = [];
    const { h, m, out } = await twoPools(true, fetchedWhy);
    cut(h, VIA1);
    await m.run(2_000, 200, () => m.slot());
    cut(h, VIA2);
    await m.run(2_000, 200, () => m.slot());
    expect(tries(fetchedWhy)).toBe(1);
    expect(out.map((o) => [o.via, o.found])).toEqual([[VIA1, true], [VIA2, false]]);
    await h.worker.stop();
  });
});

describe('DEDUP-PER-WATCH: a cut creates log seen first on another watch', () => {
  it('is still a hole on the creates watch, so a boot asks for it', () => {
    const CREATES = `logs:${addr(11)}`;
    const RUGS = `logs:${addr(12)}`;
    const idx = new DeployerIndex();
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
    const t = at(S0);
    feed.ingest('worker', { type: 'offchain', key: 'coverage:creates:start', value: { fromSlot: S0 - 1n, via: CREATES } }, { receivedAt: t });
    // Processed watches (no commitment): the rugs watch's copy first, then the creates watch's.
    for (const via of [RUGS, CREATES]) feed.ingest('helius', { type: 'logs', signature: SIG, slot: S0, err: null, via, logs: ['Log truncated'] }, { receivedAt: t + 1 });
    feed.ingest('helius', { type: 'slot', slot: S0 + 1n, parent: S0, root: null }, { receivedAt: t + 10 });
    feed.advance(t + 11);
    for (let e = feed.next(); e !== null; e = feed.next()) if (e.kind === 'market') idx.observe(e);
    expect(idx.lostCreates(0, t + 20)).toEqual([SIG]);
  });
});

describe('DEDUP-PER-WATCH: shedding the first copy keeps the other watch\'s swaps (review B1)', () => {
  // One transaction swaps on pool A and pool B; A's watch heard it first. Behind, the worker sheds A (a candidate) and
  // keeps B (held). A's copy is dropped: B must still get its swap (or a hole), live and in the recording's replay.
  const S = S0 + 5n;
  const logs = () => [...swapOf(A, S).logs, ...swapOf(B, S).logs];
  const run = (o: { readonly lateB?: boolean } = {}) => {
    const frames: Frame[] = [];
    const releases: Release[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => frames.push(f), onRelease: (_e, r) => releases.push(r) });
    const t = at(S);
    const body = (via: string): FrameBody => ({ type: 'logs', signature: SIG, slot: S, err: null, via, logs: logs(), commitment: 'confirmed' });
    feed.ingest('helius', body(VIA(A)), { receivedAt: t });
    if (o.lateB !== true) feed.ingest('helius', body(VIA(B)), { receivedAt: t + 1 });
    const shed = feed.shed((via) => via === VIA(A));
    expect([...shed.keys()]).toEqual([VIA(A)]);
    if (o.lateB === true) feed.ingest('helius', body(VIA(B)), { receivedAt: t + 1 });
    feed.ingest('helius', { type: 'slot', slot: S + 1n, parent: S, root: null }, { receivedAt: t + 10 });
    feed.advance(t + 11);
    const out: MarketEvent[] = [];
    for (let e = feed.next(); e !== null; e = feed.next()) if (e.kind === 'market') out.push(e);
    return { frames, releases, out };
  };

  for (const lateB of [false, true]) {
    it(`pool B gets its swap (B's copy ${lateB ? 'after' : 'before'} the shed), and the replay equals live`, () => {
      const r = run({ lateB });
      const w = opened();
      const before = candleWrites(w, B);
      w.push(...r.out);
      expect(candleWrites(w, B)).toBeGreaterThan(before);
      expect(r.out.some((e) => e.key === `logs:pump_amm:BuyEvent:${B.pool}`)).toBe(true);
      const frames = r.frames.map((f) => parseTyped(typedText(f)) as Frame);
      const rp = replayRecorded(frames, r.releases.map((x) => parseTyped(typedText(x)) as Release));
      const replayed: MarketEvent[] = [];
      for (let e = rp.feed.next(); e !== null; e = rp.feed.next()) if (e.kind === 'market') replayed.push(e);
      expect(typedText(replayed)).toBe(typedText(r.out));
    });
  }
});

describe('DEDUP-PER-WATCH: a copy that comes after a shed and after its slot was released (review N1)', () => {
  // Tx X swaps on A and B at S; A's copy came first, and A is shed with no B copy held. S is released; B's own tx Y at
  // S + 2 (a sell on the state after X's buy) is released; then B's copy of X arrives. Released whole off-chain it
  // would put X's buy behind Y's sell: B's price would be wrong and read as clean. It must fail closed instead.
  const S = S0 + 5n;
  const SIG_Y = '6QYKumkywidnDav6oDdP4teAY247nwxDg3gWsZ1nAmnsejadN6r2YmxJiuLXy4bxw9eDvpCgr7fHLSBfpRehCMBM';
  const buyB = swapOf(B, S);
  const sellB = swapLog({ pool: B.pool, coinCreator: CREATOR, supply: SUPPLY, pre: buyB.after, side: 'sell', base: 400_000_000n, atMs: at(S + 2n) });
  const x = (via: string): FrameBody => ({ type: 'logs', signature: SIG, slot: S, err: null, via, logs: [...swapOf(A, S).logs, ...buyB.logs], commitment: 'confirmed' });

  const live = () => {
    const frames: Frame[] = [];
    const releases: Release[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, onFrame: (f) => frames.push(f), onRelease: (_e, r) => releases.push(r) });
    const out: MarketEvent[] = [];
    const tick = (slot: bigint): void => {
      feed.ingest('helius', { type: 'slot', slot, parent: slot - 1n, root: null }, { receivedAt: at(slot) });
      feed.advance(at(slot) + 1);
      for (let e = feed.next(); e !== null; e = feed.next()) if (e.kind === 'market') out.push(e);
    };
    feed.ingest('helius', x(VIA(A)), { receivedAt: at(S) });
    feed.shed((via) => via === VIA(A));
    tick(S + 1n);
    feed.ingest('helius', { type: 'logs', signature: SIG_Y, slot: S + 2n, err: null, via: VIA(B), logs: sellB.logs, commitment: 'confirmed' }, { receivedAt: at(S + 2n) });
    tick(S + 3n);
    feed.ingest('helius', x(VIA(B)), { receivedAt: at(S + 3n) + 5 });
    tick(S + 5n);
    return { frames, releases, out };
  };
  const closes = (w: FactWorld) => (w.last(candlesKey(B.mint)) as { candles: unknown }).candles;

  it('B gets a hole covering S (or candles equal to the in-order ones), and the replay equals live', () => {
    const r = live();
    const w = opened().push(...r.out);
    // In order: X's buy, then Y's sell, both on B's watch.
    const ref = opened();
    through(ref, buyB.logs, S, [VIA(B)]);
    through(ref, sellB.logs, S + 2n, [VIA(B)]);
    const ok = gapFree(w, B) > S || typedText(closes(w)) === typedText(closes(ref));
    expect(ok).toBe(true);
    expect(gapFree(w, B)).toBeGreaterThan(S);
    const rp = replayRecorded(r.frames.map((f) => parseTyped(typedText(f)) as Frame), r.releases);
    const replayed: MarketEvent[] = [];
    for (let e = rp.feed.next(); e !== null; e = rp.feed.next()) if (e.kind === 'market') replayed.push(e);
    expect(typedText(replayed)).toBe(typedText(r.out));
  });

  it('the shed keys are forgotten with the dedupe keys (bounded memory)', () => {
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0, keepSlots: 2 });
    feed.ingest('helius', x(VIA(A)), { receivedAt: at(S) });
    feed.shed((via) => via === VIA(A));
    expect(feed.sizes()['shed_keys']).toBe(1);
    for (let k = 1n; k <= 5n; k++) {
      feed.ingest('helius', { type: 'slot', slot: S + k, parent: S + k - 1n, root: null }, { receivedAt: at(S + k) });
      feed.advance(at(S + k) + 1);
      while (feed.next() !== null);
    }
    expect(feed.sizes()['shed_keys']).toBe(0);
  });
});
