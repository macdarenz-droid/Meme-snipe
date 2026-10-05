// CREATE-COMPACT: the live store keeps a create event and a curve trade event with only the fields their readers read.
// A create that never migrates stays 13 hours with its create and its first curve trade: as released they cost about
// 4.3 KB together (about 250 MB at three times the live 25 creates a minute).
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { AsOfStore, type AsOfEntry, type Moment } from '../../core/src/engine/index.ts';
import { checkCurveTails, compactCreate, compactCurveTrade, createOf } from '../../core/src/gates/index.ts';
import { eventsOfFrame, type Frame } from '../src/providers/canonical.ts';
import { compactSeed, liveCollapse, liveRetention, liveShape } from '../src/run/store-rules.ts';
import { blockNetwork, recordOf, tx } from './helpers.ts';
import { MINT, makeWorker, passingMarket } from './worker-harness.ts';

blockNetwork();

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const SLOT = 452_941_200n;
const at = (ms: number): Moment => ({ slot: SLOT + 1n, txIndex: 0, ixIndex: 0, receivedAt: ms });
/** The market events of a fetched transaction, decoded afresh each call as the live feed decodes each frame. */
const events = (label: string, seq: number) => {
  const f: Frame = { seq, receivedAt: 1_000, source: 'helius', backfilled: false, place: { at: 'offchain', slot: SLOT }, duplicate: false, body: { type: 'tx', record: recordOf(tx(label)) } };
  return eventsOfFrame(f, new Map()).filter((e) => e.kind === 'market');
};
const createOfTx = (seq: number) => events('pump CreateEvent', seq).find((e) => e.kind === 'market' && e.key.startsWith('pump:CreateEvent:'))!;
const tradeOfTx = (seq: number) => events('pump TradeEvent', seq).find((e) => e.kind === 'market' && e.key.startsWith('pump:TradeEvent:'))!;

/** Heap bytes a create and its curve trade cost in a store with these rules, per create. */
const perCreate = (shape: typeof liveShape | null, n: number): number => {
  const clock = { now: () => at(2_000) };
  const store = new AsOfStore(clock, liveRetention, liveCollapse, shape);
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) {
    for (const e of [createOfTx(i), tradeOfTx(i)]) {
      if (e.kind !== 'market') continue;
      store.record(`${e.key}${i}`, e.value, e.moment, e.id);
    }
  }
  gc();
  const bytes = (process.memoryUsage().heapUsed - before) / n;
  expect(store.lookup(`${createOfTx(0).kind === 'market' ? createOfTx(0).key : ''}0`).ok).toBe(true);
  return bytes;
};

describe('CREATE-COMPACT: creates and curve trades in the live store', () => {
  it('a create and its curve trade cost under 2 KB together in the store (as released, over 4 KB)', () => {
    const full = perCreate(null, 3_000);
    const compact = perCreate(liveShape, 3_000);
    process.stderr.write(`CREATE-COMPACT per create: ${full.toFixed(0)} B released, ${compact.toFixed(0)} B compact\n`);
    expect(full).toBeGreaterThan(4_000);
    expect(compact).toBeLessThan(2_048);
  });

  it('the create alias and the deployer read the same from the compact value', () => {
    const e = createOfTx(1);
    if (e.kind !== 'market') throw new Error('no create');
    const v = e.value as { event: { data: Record<string, unknown> }; txSlot: unknown; source: unknown; backfilled: unknown };
    const c = compactCreate(v) as typeof v;
    expect(createOf(c)).toEqual(createOf(v));
    expect(createOf(c)).not.toBeNull();
    for (const k of ['creator', 'user', 'tokenTotalSupply', 'mint', 'timestamp']) expect(c.event.data[k]).toEqual(v.event.data[k]);
    expect([c.txSlot, c.source, c.backfilled]).toEqual([v.txSlot, v.source, v.backfilled]);
    expect(liveShape(e.key)).toBe(compactCreate);
    expect(liveShape(`logs:pump:CreateEvent:x`)).toBe(compactCreate);
    expect(liveShape(`logs:pump:TradeEvent:x`)).toBe(compactCurveTrade);
    expect(liveShape(`pump_amm:BuyEvent:x`)).toBeNull();
  });

  it('a compact curve trade costs under 240 B (its tail hex is copied, never a slice of the event\'s text)', () => {
    const keep: unknown[] = [];
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2_000; i++) {
      const e = tradeOfTx(i);
      if (e.kind === 'market') keep.push(compactCurveTrade(e.value));
    }
    gc();
    expect((process.memoryUsage().heapUsed - before) / keep.length).toBeLessThan(240);
  });

  it('the store keeps keys and ids as flat copies: never the larger text they were built from', () => {
    const store = new AsOfStore({ now: () => at(2_000) });
    const big = (i: number) => JSON.parse(JSON.stringify('x'.repeat(2_000) + i)) as string;
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2_000; i++) {
      const b = big(i);
      store.record(`k:${b.slice(1_900)}`, 1, at(1_000), `ev:${b.slice(1_900)}:00000`);
    }
    gc();
    expect((process.memoryUsage().heapUsed - before) / 2_000).toBeLessThan(600);
  });

  it('a create signed by another wallet than its creator keeps both', () => {
    const e = createOfTx(3);
    if (e.kind !== 'market') throw new Error('no create');
    const v = e.value as { event: { data: Record<string, unknown> } };
    const signer = { ...v, event: { ...v.event, data: { ...v.event.data, user: 'Signer1111111111111111111111111111111111111' } } };
    const c = compactCreate(signer) as typeof v;
    expect([c.event.data['creator'], c.event.data['user']]).toEqual([v.event.data['creator'], 'Signer1111111111111111111111111111111111111']);
  });

  it('the curve tail check answers the same from compact values: a passing tail, and a failing one with its detail', () => {
    const e = tradeOfTx(2);
    if (e.kind !== 'market') throw new Error('no trade');
    const v = e.value as { event: Record<string, unknown> };
    const bad = { ...v, event: { ...v.event, trailing: 8, extra: '0100000000000000' } };
    for (const value of [v, bad]) {
      const answer = (shape: typeof liveShape | null) => {
        const store = new AsOfStore({ now: () => at(2_000) }, null, null, shape);
        store.record(e.key, value, e.moment, e.id);
        const mint = e.key.slice('pump:TradeEvent:'.length);
        return checkCurveTails({ now: at(2_000), history: (k, f, t) => store.history(k, f, t) as readonly AsOfEntry[] }, mint);
      };
      expect(answer(liveShape)).toEqual(answer(null));
    }
  });

  it('the worker\'s engine stores a released create compact', async () => {
    const stores = new Set<AsOfStore>();
    const own = AsOfStore.prototype.record;
    const spy = vi.spyOn(AsOfStore.prototype, 'record').mockImplementation(function (this: AsOfStore, ...a: Parameters<AsOfStore['record']>) {
      stores.add(this);
      return own.apply(this, a);
    });
    try {
      const h = makeWorker({});
      await h.worker.reconcile();
      const m = await passingMarket(h, { heldPoolFacts: true });
      m.create();
      await m.run(1_000, 100, () => m.slot());
      const key = `pump:CreateEvent:${MINT}`;
      const found = [...stores].map((st) => st.lookup(key)).find((r) => r.ok) as { ok: true; value: Record<string, unknown> } | undefined;
      expect(found).toBeDefined();
      // Released with its signature; stored without it, the deployer's fields kept.
      expect('signature' in found!.value).toBe(false);
      expect((found!.value['event'] as { data: { creator: unknown } }).data.creator).toBeTypeOf('string');
      await h.worker.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it('G4a: the boot\'s seed fact is stored as its moment and counts, never its creates', () => {
    const asOf = at(1);
    const seed = { state: { ref: 'x' }, asOf, creates: [1, 2, 3], coverage: [1], fill: [], rugs: [1, 2], history: [1] };
    expect(liveShape('worker:seed')).toBe(compactSeed);
    const store = new AsOfStore({ now: () => at(2_000) }, liveRetention, liveCollapse, liveShape);
    store.record('worker:seed', seed, at(1_000), 'seed');
    const r = store.lookup('worker:seed') as { ok: true; value: unknown };
    expect(r.value).toEqual({ asOf, counts: { creates: 3, coverage: 1, fill: 0, rugs: 2, history: 1 } });
  });
});
