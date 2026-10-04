// CREATE-AFTER-RESTART (S0-ZERO finding 3): a coin created before this process started reaches H9 (and H12-H14) with
// its real create. Before, the create transaction was fetched on shortlist only when this process had seen the create
// log, so after any restart such a candidate rejected on H9 with "missing create" for hours. Now a create the saved
// store holds is read by its signature, one the downtime fill brings is read once the seed is placed, and any other is
// looked up from the mint's oldest signature under the fills' daily budget, journaled; a failed lookup stays missing.
import { describe, expect, it } from 'vitest';
import { transactionEvents } from '../../core/src/chain/index.ts';
import type { MarketEvent } from '../../core/src/engine/index.ts';
import { LOG_CREATE_PREFIX, TX_CREATE_PREFIX, createKey, migrationKey } from '../../core/src/gates/index.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { MINT as FIX_MINT, RECORDS } from '../../core/test/facts/helpers.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import { DeployerStore } from '../src/run/deployer-store.ts';
import { CREATE_LOOKUP_CREDITS, CreditBook, type CreateLookup, LiveProviders, findCreate } from '../src/run/sources.ts';
import { FakeSocketHub, rpcHandler, scriptedHttp } from '../src/providers/index.ts';
import type { DailyBudget } from '../src/persist/index.ts';
import { ManualTimers } from '../src/scheduler/index.ts';
import { blockNetwork, testSecrets } from './helpers.ts';
import { MINT, T, Market, dueTimers, makeWorker, passingMarket, slotAt, tempState } from './worker-harness.ts';
import type { SeedResult } from '../src/run/worker.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

blockNetwork();

const SIG = (c: string): string => c.repeat(88);
const CREATE_TX = RECORDS.find((r) => transactionEvents(r.rec).some((e) => e.name === 'CreateEvent' && e.data.mint === FIX_MINT))!.rec;
const OTHER_TX = RECORDS.find((r) => !transactionEvents(r.rec).some((e) => e.name === 'CreateEvent'))!.rec;

/** A daily budget in memory: what is left, and every spend and refund. */
const budget = (left: number) => {
  const b = { left, spent: 0, calls: [] as string[] };
  return {
    b,
    remaining: () => b.left,
    spend: (c: number) => {
      b.left -= c;
      b.spent += c;
      b.calls.push(`spend ${c}`);
    },
    refund: (c: number) => {
      b.left += c;
      b.spent -= c;
      b.calls.push(`refund ${c}`);
    },
  };
};

/** The mint's signatures, newest first, `total` of them; the oldest successful one is `create`, older ones failed. */
const history = (total: number, create: string, failedBefore = 0) => {
  const all = [...Array.from({ length: total - 1 - failedBefore }, (_, k) => ({ signature: `n${k}`, err: null })), { signature: create, err: null }, ...Array.from({ length: failedBefore }, (_, k) => ({ signature: `f${k}`, err: { InstructionError: [0, 'x'] } }))];
  const calls: (string | undefined)[] = [];
  return {
    calls,
    getSignaturesForAddress: async (_a: string, o: { readonly before?: string; readonly limit: number }) => {
      calls.push(o.before);
      const from = o.before === undefined ? 0 : all.findIndex((x) => x.signature === o.before) + 1;
      return all.slice(from, from + o.limit);
    },
  };
};

describe('findCreate: the create from the mint\'s oldest signature, under the fills\' budget', () => {
  const timers = new ManualTimers(T);

  it('pages back to the start, reads the oldest successful transaction, and accepts it only as this mint\'s create', async () => {
    const rpc = history(2_400, CREATE_TX.signature, 3);
    const fetched: string[] = [];
    const bud = budget(1_000);
    const r = await findCreate(FIX_MINT, { rpc, fetch: async (s) => (fetched.push(s), CREATE_TX), timers, budget: bud });
    expect(r).toMatchObject({ mint: FIX_MINT, found: true, signature: CREATE_TX.signature, slot: String(CREATE_TX.slot), pages: 3, credits: 4, stopped_by: 'found' });
    expect(rpc.calls).toEqual([undefined, 'n999', 'n1999']);
    // The failed transactions older than the create are passed over.
    expect(fetched).toEqual([CREATE_TX.signature]);
    // The whole cap is counted first, the unused part given back: the budget is charged exactly what was used.
    expect(bud.b.calls).toEqual([`spend ${CREATE_LOOKUP_CREDITS}`, `refund ${CREATE_LOOKUP_CREDITS - 4}`]);
    expect(bud.b.spent).toBe(4);
  });

  it('a transaction that is not this mint\'s create, or that cannot be read, leaves it missing', async () => {
    const other = await findCreate(FIX_MINT, { rpc: history(5, OTHER_TX.signature), fetch: async () => OTHER_TX, timers, budget: budget(100) });
    expect(other).toMatchObject({ found: false, signature: null, stopped_by: 'not-create', credits: 2 });
    // The fixture's create, for another mint, is not this mint's create.
    const wrongMint = await findCreate(MINT, { rpc: history(5, CREATE_TX.signature), fetch: async () => CREATE_TX, timers, budget: budget(100) });
    expect(wrongMint).toMatchObject({ found: false, stopped_by: 'not-create' });
    const gone = await findCreate(FIX_MINT, { rpc: history(5, CREATE_TX.signature), fetch: async () => null, timers, budget: budget(100) });
    expect(gone).toMatchObject({ found: false, stopped_by: 'not-found', credits: 2 });
    const none = await findCreate(FIX_MINT, { rpc: { getSignaturesForAddress: async () => [{ signature: 'f', err: 'x' }] }, fetch: async () => CREATE_TX, timers, budget: budget(100) });
    expect(none).toMatchObject({ found: false, stopped_by: 'no-signature', credits: 1 });
  });

  it('a history longer than the cap stops at the cap, never past it, and reads no transaction', async () => {
    const fetched: string[] = [];
    const bud = budget(1_000);
    const r = await findCreate(FIX_MINT, { rpc: history(100_000, CREATE_TX.signature), fetch: async (s) => (fetched.push(s), CREATE_TX), timers, budget: bud });
    expect(r).toMatchObject({ found: false, stopped_by: 'credit-cap', pages: CREATE_LOOKUP_CREDITS - 1, credits: CREATE_LOOKUP_CREDITS - 1 });
    expect(fetched).toEqual([]);
    expect(bud.b.spent).toBe(CREATE_LOOKUP_CREDITS - 1);
  });

  it('the budget caps it: too little left (or none given) makes no call; what is left bounds the pages', async () => {
    const rpc = history(5, CREATE_TX.signature);
    const low = budget(1);
    expect(await findCreate(FIX_MINT, { rpc, fetch: async () => CREATE_TX, timers, budget: low })).toMatchObject({ found: false, stopped_by: 'skipped-no-budget', credits: 0, pages: 0 });
    expect(await findCreate(FIX_MINT, { rpc, fetch: async () => CREATE_TX, timers, budget: undefined })).toMatchObject({ stopped_by: 'skipped-no-budget' });
    expect(rpc.calls).toEqual([]);
    expect(low.b.calls).toEqual([]);
    // Three credits left: two pages at most, so a three-page history stops there.
    const three = budget(3);
    expect(await findCreate(FIX_MINT, { rpc: history(2_400, CREATE_TX.signature), fetch: async () => CREATE_TX, timers, budget: three })).toMatchObject({ stopped_by: 'credit-cap', credits: 2 });
    expect(three.b.left).toBe(1);
  });

  it('lookups running together never spend more than the budget has left', async () => {
    const bud = budget(CREATE_LOOKUP_CREDITS + 3);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = { getSignaturesForAddress: async (a: string, o: { readonly before?: string; readonly limit: number }) => (await gate, history(100_000, 'x').getSignaturesForAddress(a, o)) };
    const runs = [findCreate(FIX_MINT, { rpc: slow, fetch: async () => null, timers, budget: bud }), findCreate(FIX_MINT, { rpc: slow, fetch: async () => null, timers, budget: bud })];
    // The first holds its whole cap; the second gets the three left.
    expect(bud.b.left).toBe(0);
    release();
    const [a, b] = await Promise.all(runs);
    expect(a!.credits + b!.credits).toBeLessThanOrEqual(CREATE_LOOKUP_CREDITS + 3);
    expect(b).toMatchObject({ stopped_by: 'credit-cap', credits: 2 });
  });

  it('an RPC error stops it; only the calls made are charged', async () => {
    const bud = budget(100);
    const r = await findCreate(FIX_MINT, { rpc: { getSignaturesForAddress: async () => { throw new Error('429'); } }, fetch: async () => CREATE_TX, timers, budget: bud });
    expect(r).toMatchObject({ found: false, stopped_by: 'error', credits: 1 });
    expect(bud.b.spent).toBe(1);
  });
});

describe('LiveProviders.findCreate: Helius RPC, charged to the fills\' budget', () => {
  const providers = (budget?: { spent: number }) => {
    const timers = new ManualTimers(T);
    const http = scriptedHttp(rpcHandler((m) => (m === 'getSignaturesForAddress' ? [{ signature: CREATE_TX.signature, slot: Number(CREATE_TX.slot), err: null, blockTime: 1 }] : undefined)));
    const p = new LiveProviders({
      tradeStreams: false, secrets: testSecrets, http, factory: new FakeSocketHub().factory, credits: new CreditBook(tempState(), timers),
      ...(budget === undefined ? {} : { fillBudget: { remaining: () => 1_000 - budget.spent, spend: (c: number) => { budget.spent += c; }, refund: (c: number) => { budget.spent -= c; } } as unknown as DailyBudget }),
    });
    return { p, http, timers };
  };

  it('pages the mint\'s signatures on Helius and charges the budget what it used (no fetcher yet: the create cannot be read)', async () => {
    const budget = { spent: 0 };
    const { p, http, timers } = providers(budget);
    const r = await p.findCreate(FIX_MINT, timers);
    expect(r).toMatchObject({ found: false, stopped_by: 'not-found', pages: 1, credits: 2 });
    expect(http.calls.map((c) => JSON.parse(String(c.body)).method)).toEqual(['getSignaturesForAddress']);
    expect(String(http.calls[0]!.url)).toContain('helius');
    expect(budget.spent).toBe(2);
  });

  it('without the fills\' budget it makes no call', async () => {
    const { p, http, timers } = providers();
    expect(await p.findCreate(FIX_MINT, timers)).toMatchObject({ stopped_by: 'skipped-no-budget', credits: 0 });
    expect(http.calls).toEqual([]);
  });
});

// ---------- The worker: a candidate created before the start ----------

const CREATE_FACT = passingFacts().get(createKey(MINT))!.value;
const STORED_SIG = SIG('S');

/** The create reaches the feed the way the fetched transaction's create fact does (the harness puts facts directly). */
const landCreate = (m: Market): void => {
  m.omit = new Set([...m.omit].filter((k) => k !== createKey(MINT)));
  m.fact(createKey(MINT), CREATE_FACT);
};

/** A worker over a state dir whose deployer store holds `creates`, with the passing market minus the create fact. */
const restarted = async (o: { creates?: readonly MarketEvent[]; findCreate?: (mint: string) => Promise<CreateLookup>; seed?: readonly MarketEvent[] } = {}) => {
  const stateDir = tempState();
  const store = new DeployerStore(stateDir);
  for (const e of o.creates ?? []) store.keep(e);
  const fetched: string[] = [];
  const h = makeWorker({
    stateDir, fetched, found: true,
    ...(o.findCreate === undefined ? {} : { findCreate: o.findCreate }),
    ...(o.seed === undefined ? {} : { seed: async () => ({ mode: 'fill' as const, creates: o.seed!, coverage: [], report: 'test fill' }) }),
  });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  return { h, fetched, stateDir };
};

const decisions = (stateDir: string): string[][] =>
  readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['kind'] === 'decision').map((l) => (l['reasons'] as string[]) ?? []);
const missingCreate = (stateDir: string): boolean => decisions(stateDir).some((r) => r[0] === 'reject' && r.some((x) => /create/.test(x) && /H9/.test(x)));
const entered = (stateDir: string): boolean => decisions(stateDir).some((r) => r[0] === 'enter');

const tick = (m: Market) => (): void => {
  m.slot();
  m.pool();
};

describe('a candidate created before the start reaches H9 with its real create', () => {
  const stored = (id: string): MarketEvent => ({ kind: 'market', id, moment: { slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T - 16 * 86_400_000 - 60_000 }, key: `${LOG_CREATE_PREFIX}${MINT}`, value: { event: { program: 'pump', name: 'CreateEvent', data: { mint: MINT, creator: 'dev', timestamp: 1n } }, signature: STORED_SIG } });

  it('a create the saved store holds (an earlier process saw it) is read by its signature on shortlist; the candidate then passes H9', async () => {
    // The store keeps creates compacted, without the signature field: the id carries it.
    const { h, fetched, stateDir } = await restarted({ creates: [stored(`log:${STORED_SIG}:0003`)] });
    const m = await passingMarket(h, { omit: [createKey(MINT)] });
    await m.run(4_000, 400, tick(m));
    expect(fetched).toEqual([STORED_SIG]);
    expect(missingCreate(stateDir)).toBe(true);
    // The read transaction's create lands: H9 now has the real create, and the passing candidate is entered.
    landCreate(m);
    await m.run(10_000, 400, tick(m));
    expect(entered(stateDir)).toBe(true);
    await h.worker.stop();
  });

  it('a fetched create\'s id (`ev:<signature>:…`) is read the same way', async () => {
    const { h, fetched } = await restarted({ creates: [{ ...stored(`ev:${STORED_SIG}:00:00`), key: `${TX_CREATE_PREFIX}${MINT}` }] });
    const m = await passingMarket(h, { omit: [createKey(MINT)] });
    await m.run(2_000, 400, tick(m));
    expect(fetched).toEqual([STORED_SIG]);
    await h.worker.stop();
  });

  it('a create in neither the store nor this process is looked up once from the mint\'s oldest signature and journaled; found, it passes H9', async () => {
    const asked: string[] = [];
    let market: Market | null = null;
    const find = async (mint: string): Promise<CreateLookup> => {
      asked.push(mint);
      // As the real lookup does: the transaction lands on the feed after the call returns, not inside the step (the
      // shortlist comes while the market is still being set up, so wait for it).
      do await new Promise<void>((r) => setImmediate(r));
      while (market === null);
      landCreate(market);
      return { mint, found: true, signature: SIG('C'), slot: '123', pages: 2, credits: 3, stopped_by: 'found', latency_ms: 40 };
    };
    const { h, fetched, stateDir } = await restarted({ findCreate: find });
    market = await passingMarket(h, { omit: [createKey(MINT)] });
    await market.run(12_000, 400, tick(market));
    expect(asked).toEqual([MINT]);
    expect(fetched).toEqual([]);
    expect(entered(stateDir)).toBe(true);
    await h.worker.stop();
    const text = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8');
    const line = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['kind'] === 'create_lookup');
    expect(line).toMatchObject({ mint: MINT, found: true, credits: 3, stopped_by: 'found', pages: 2 });
    expect(checkJournal(text).create_lookup).toEqual({ lines: 1, found: 1, skipped_no_budget: 0, credits: 3 });
  });

  it('a lookup that finds nothing leaves the create missing: H9 keeps refusing, nothing is guessed, and it is not repeated', async () => {
    const asked: string[] = [];
    const find = async (mint: string): Promise<CreateLookup> => (asked.push(mint), { mint, found: false, signature: null, slot: null, pages: 0, credits: 0, stopped_by: 'skipped-no-budget', latency_ms: 0 });
    const { h, stateDir } = await restarted({ findCreate: find });
    const m = await passingMarket(h, { omit: [createKey(MINT)] });
    await m.run(12_000, 400, tick(m));
    expect(asked).toEqual([MINT]);
    expect(missingCreate(stateDir)).toBe(true);
    expect(entered(stateDir)).toBe(false);
    await h.worker.stop();
    expect(checkJournal(readFileSync(join(stateDir, 'journal.jsonl'), 'utf8')).create_lookup).toEqual({ lines: 1, found: 0, skipped_no_budget: 1, credits: 0 });
  });

  it('a mint shortlisted again (its window ended, then its migration was seen again) is not looked up again', async () => {
    const asked: string[] = [];
    const find = async (mint: string): Promise<CreateLookup> => (asked.push(mint), { mint, found: false, signature: null, slot: null, pages: 1, credits: 1, stopped_by: 'not-found', latency_ms: 0 });
    const { h, stateDir } = await restarted({ findCreate: find });
    const m = await passingMarket(h, { omit: [createKey(MINT)] });
    await m.run(4_000, 400, tick(m));
    // Past the candidate's entry window: it is dropped. A later sighting of the migration shortlists it again.
    h.timers.set(T + 6 * 3_600_000);
    m.slot();
    await m.run(2_000, 400, () => m.slot());
    m.fact(migrationKey(MINT), passingFacts().get(migrationKey(MINT))!.value);
    await m.run(2_000, 400, () => m.slot());
    await h.worker.stop();
    expect(decisions(stateDir).filter((r) => r[0] === 'shortlist')).toHaveLength(2);
    expect(asked).toEqual([MINT]);
  });
});

describe('a shortlist while the seed is built waits for it: the downtime fill may bring the create', () => {
  const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
  const seeded: MarketEvent = { kind: 'market', id: `ev:${STORED_SIG}:00:00`, moment: { slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T - 3_600_000 }, key: `${TX_CREATE_PREFIX}${MINT}`, value: { event: { program: 'pump', name: 'CreateEvent', data: { mint: MINT, creator: 'dev', timestamp: 1n } }, txSlot: 1n, blockTime: 1, source: 'seed', backfilled: true, seq: 0 } };

  /** Starts a worker whose seed answers only when released, shortlists the mint while it waits, then releases it. */
  const seeding = async (creates: readonly MarketEvent[]) => {
    const asked: string[] = [];
    const fetched: string[] = [];
    const timers = dueTimers(T);
    let release: (r: SeedResult) => void = () => undefined;
    const h = makeWorker({
      stateDir: tempState(), timers, fetched, found: true, seedMaxMs: 3_600_000, seedWaitMs: 1_000,
      seed: () => new Promise((r) => (release = r)),
      findCreate: async (mint) => (asked.push(mint), { mint, found: false, signature: null, slot: null, pages: 1, credits: 1, stopped_by: 'not-found', latency_ms: 0 }),
    });
    const m = new Market(h);
    const started = h.worker.start();
    for (let k = 0; k < 200 && !h.order.includes('start helius-ws'); k++) {
      timers.set(timers.now() + 100);
      await new Promise<void>((r) => setImmediate(r));
    }
    m.slot();
    m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
    m.fact(migrationKey(MINT), passingFacts().get(migrationKey(MINT))!.value);
    await m.run(4_000, 400, () => m.slot());
    const shortlisted = h.logs.length > 0 && readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').includes('"shortlist"');
    const whileSeeding = { asked: [...asked], fetched: [...fetched], shortlisted };
    release({ mode: 'fill', creates, coverage: [], report: 'test fill' });
    expect(await started).toEqual({ ok: true });
    await m.run(2_000, 400, () => m.slot());
    await h.worker.stop();
    return { whileSeeding, asked, fetched };
  };

  it('a create the seed brings is read by its signature once it is placed, with no lookup', async () => {
    const r = await seeding([seeded]);
    expect(r.whileSeeding).toEqual({ asked: [], fetched: [], shortlisted: true });
    expect(r.fetched).toEqual([STORED_SIG]);
    expect(r.asked).toEqual([]);
  });

  it('a seed that does not bring it hands the mint to the lookup, once', async () => {
    const r = await seeding([]);
    expect(r.whileSeeding).toEqual({ asked: [], fetched: [], shortlisted: true });
    expect(r.asked).toEqual([MINT]);
    expect(r.fetched).toEqual([]);
  });
});
