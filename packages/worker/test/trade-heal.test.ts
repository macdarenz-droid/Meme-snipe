// TRADE-GAP-HEAL (worker side): a cut or undecodable log on a pool watch has its transaction fetched at `cut-trade`
// (P3 in main.ts), under a daily cap, with the same bounded retries as a cut creates log; after the fetch settles the
// worker puts its outcome on the feed (`hole-fetch:<via>`, after the transaction's own events), and the producer heals
// the hole only on found (core test/facts/trade-heal.test.ts). Fail closed: not found, capped or unwatched says so.
import { describe, expect, it } from 'vitest';
import { HOLE_FETCH_PREFIX } from '../../core/src/facts/index.ts';
import { CUT_CREATE_RETRY_MS, CUT_TRADE_FETCHES_PER_DAY, CUT_TRADE_HOLES_PER_POOL } from '../src/run/worker.ts';
import { type Harness, Market, POOL_ADDRESS, makeWorker, passingMarket, slotAt } from './worker-harness.ts';

const VIA = `logs:${POOL_ADDRESS}`;
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sig = (k: number) => `${B58[k % 58]}${B58[Math.floor(k / 58) % 58]}${B58[Math.floor(k / 3364) % 58]}${'7'.repeat(85)}`;

/** Every hole outcome the worker puts on its feed. */
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

const cut = (h: Harness, signature: string, via = VIA, extra: readonly string[] = []) =>
  h.worker.feed.ingest('helius', { type: 'logs', signature, slot: slotAt(h.timers.now()), err: null, via, logs: [`Program ${AMM} invoke [1]`, ...extra, 'Log truncated'], commitment: 'confirmed' }, { receivedAt: h.timers.now() });

const tries = (w: [string, string][], s: string) => w.filter(([x, why]) => x === s && why === 'cut-trade').length;

/** Turns of the event loop: each retry's wait fires on a turn (virtual timers move the clock by it). */
const settle = async (h: Harness, turns = 60) => {
  for (let i = 0; i < turns; i++) {
    h.worker.step();
    await new Promise<void>((r) => setImmediate(r));
  }
};

/** A watched candidate pool (passingMarket) whose trade stream started on its pool watch. */
const watched = async (found: boolean | ((s: string, why: string) => boolean), fetchedWhy: [string, string][]) => {
  const h = makeWorker({ found, fetchedWhy });
  await h.worker.reconcile();
  const m = await passingMarket(h);
  m.tradesStart(slotAt(h.timers.now()) - 100n);
  await m.run(1_000, 200, () => m.slot());
  expect(h.worker.strategy.watchedPools().has(POOL_ADDRESS)).toBe(true);
  return { h, m, out: outcomes(h) };
};

describe('TRADE-GAP-HEAL: a cut log on a pool watch', () => {
  it('is fetched once as cut-trade, and the found outcome follows on the feed', async () => {
    const fetchedWhy: [string, string][] = [];
    const { h, m, out } = await watched(true, fetchedWhy);
    cut(h, sig(1));
    // The same cut log seen again (a cut log names its signature on each of its events): asked once.
    cut(h, sig(1));
    await m.run(2_000, 200, () => m.slot());
    expect(fetchedWhy).toEqual([[sig(1), 'cut-trade']]);
    expect(out).toEqual([{ signature: sig(1), found: true, via: VIA }]);
    await h.worker.stop();
  });

  it('a failed fetch is asked again after its wait while the pool is watched; found then says so once', async () => {
    const fetchedWhy: [string, string][] = [];
    let n = 0;
    const { h, m, out } = await watched(() => ++n >= 3, fetchedWhy);
    const t0 = h.timers.now();
    cut(h, sig(2));
    await m.run(2_000, 200, () => m.slot());
    await settle(h);
    expect(tries(fetchedWhy, sig(2))).toBe(3);
    expect(h.timers.now() - t0).toBeGreaterThanOrEqual(CUT_CREATE_RETRY_MS[0]! + CUT_CREATE_RETRY_MS[1]!);
    expect(out).toEqual([{ signature: sig(2), found: true, via: VIA }]);
    await h.worker.stop();
  });

  it('fails closed: after the last try the outcome is not found, once, and no more tries are made', async () => {
    const fetchedWhy: [string, string][] = [];
    const { h, m, out } = await watched(false, fetchedWhy);
    cut(h, sig(3));
    await m.run(2_000, 200, () => m.slot());
    await settle(h);
    await settle(h);
    expect(tries(fetchedWhy, sig(3))).toBe(CUT_CREATE_RETRY_MS.length + 1);
    expect(out).toEqual([{ signature: sig(3), found: false, via: VIA }]);
    await h.worker.stop();
  });

  it('a pool that is not a candidate\'s (not watched, or a tail, or held) fetches nothing: not found at once', async () => {
    const fetchedWhy: [string, string][] = [];
    const h = makeWorker({ found: false, fetchedWhy });
    await h.worker.reconcile();
    const m = new Market(h);
    m.slot();
    m.tradesStart(slotAt(h.timers.now()) - 100n);
    await m.run(1_000, 200, () => m.slot());
    const out = outcomes(h);
    expect(h.worker.strategy.watchedPools().has(POOL_ADDRESS)).toBe(false);
    cut(h, sig(4));
    await m.run(2_000, 200, () => m.slot());
    await settle(h);
    expect(tries(fetchedWhy, sig(4))).toBe(0);
    expect(out).toEqual([{ signature: sig(4), found: false, via: VIA }]);
    await h.worker.stop();
  });

  it('a pool past its holes limit fetches nothing more: each later hole is told not found at once', async () => {
    const fetchedWhy: [string, string][] = [];
    const { h, m, out } = await watched(true, fetchedWhy);
    for (let k = 1; k <= CUT_TRADE_HOLES_PER_POOL + 2; k++) cut(h, sig(20_000 + k));
    await m.run(2_000, 200, () => m.slot());
    expect(fetchedWhy.filter(([, why]) => why === 'cut-trade')).toHaveLength(CUT_TRADE_HOLES_PER_POOL);
    expect(out.filter((o) => !o.found).map((o) => o.signature)).toEqual([sig(20_000 + CUT_TRADE_HOLES_PER_POOL + 1), sig(20_000 + CUT_TRADE_HOLES_PER_POOL + 2)]);
    await h.worker.stop();
  });

  it('the day\'s cap: no fetch past it (the hole is told not found), and the next UTC day starts a new count', async () => {
    const fetchedWhy: [string, string][] = [];
    const { h, m, out } = await watched(true, fetchedWhy);
    // Holes on many pool watches (each under its own limit), so only the day's cap binds.
    const vias = Array.from({ length: Math.ceil((CUT_TRADE_FETCHES_PER_DAY + 1) / CUT_TRADE_HOLES_PER_POOL) }, (_, i) => `logs:${sig(40_000 + i)}`);
    for (const v of vias) m.offchain(`coverage:trades:${v.slice(5)}:start`, { fromSlot: slotAt(h.timers.now()) - 100n, via: v });
    // Each of them a candidate's pool (stands in for that many migrations).
    const own = h.worker.strategy.watchedPools.bind(h.worker.strategy);
    h.worker.strategy.watchedPools = () => new Map([...own(), ...vias.map((v): [string, { mint: string; held: boolean; fromSlot: bigint }] => [v.slice(5), { mint: v, held: false, fromSlot: 1n }])]);
    await m.run(1_000, 200, () => m.slot());
    for (let k = 1; k <= CUT_TRADE_FETCHES_PER_DAY + 1; k++) cut(h, sig(100 + k), vias[Math.floor((k - 1) / CUT_TRADE_HOLES_PER_POOL)]!);
    await m.run(3_000, 200, () => m.slot());
    expect(fetchedWhy.filter(([, why]) => why === 'cut-trade')).toHaveLength(CUT_TRADE_FETCHES_PER_DAY);
    expect(out.filter((o) => !o.found).map((o) => o.signature)).toEqual([sig(100 + CUT_TRADE_FETCHES_PER_DAY + 1)]);
    const day = Math.floor(h.timers.now() / 86_400_000);
    h.timers.set((day + 1) * 86_400_000 + 1_000);
    m.slot();
    cut(h, sig(9_000));
    await m.run(1_000, 200, () => m.slot());
    expect(fetchedWhy.at(-1)).toEqual([sig(9_000), 'cut-trade']);
    await h.worker.stop();
  });

  it('a cut log on a watch that is not a pool\'s trade stream is not a cut-trade fetch', async () => {
    const fetchedWhy: [string, string][] = [];
    const { h, m, out } = await watched(true, fetchedWhy);
    cut(h, sig(5), `logs:${AMM}`);
    await m.run(2_000, 200, () => m.slot());
    expect(tries(fetchedWhy, sig(5))).toBe(0);
    expect(out).toEqual([]);
    await h.worker.stop();
  });
});
