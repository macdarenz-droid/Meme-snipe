// RESTART-KEEP: a restart costs no candidate. The candidates in their window are saved with the state and come back
// at the restore, with the transactions their gate facts came from read again at confirmed; a create this process
// never saw is looked up from its mint's oldest transaction (capped, budget-charged); the downtime's migrations are
// read from the migration authority after the saved slot.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import type { StrategyContext } from '../../core/src/engine/index.ts';
import { emptyBook } from '../../core/src/lifecycle/index.ts';
import { LiveStrategy, RESTORE_KEY } from '../src/engine/strategy.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { migrationKey, rugCheckKey, simKey } from '../../core/src/gates/index.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { chainTx } from '../../core/test/facts/helpers.ts';
import { transactionEvents } from '../../core/src/chain/index.ts';
import { loadState, saveState } from '../src/persist/index.ts';
import { runSeed } from '../src/run/seed-start.ts';
import { CREATE_WALK_PAGES, PERSIST_FILE, type SeedRequest } from '../src/run/worker.ts';
import { PUMP_MIGRATION_AUTHORITY } from '../src/run/sources.ts';
import { DEV, MIGRATED_AT, MINT, Market, dueTimers, passingMarket, POOL_ADDRESS, SLOT, T, makeWorker, slotAt, tempState, virtualTimers } from './worker-harness.ts';

const emptyRpc = { getSignaturesForAddress: async () => [{ signature: 'before-the-range', slot: 0n, err: null, blockTime: 0 }], getTransaction: async () => null };
const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const MIG_SIG = 'migration-sig';
const CREATES_VIA = ((passingFacts().get('coverage:creates:start')!.value as { value: { via: string } }).value).via;
const WINDOW_FROM = MIGRATED_AT + RESEARCH_CONFIG.s0.u2WindowFromMs;
type H = ReturnType<typeof makeWorker>;
const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
const decisions = (h: H) => journal(h.stateDir).filter((l) => l['boot'] === h.worker.boot && l['kind'] === 'decision').map((l) => (l['reasons'] as string[]) ?? []);

let port = 18_700;

const NOW = MIGRATED_AT + 30 * 60_000;
const GOOD = { mint: MINT, pool: POOL_ADDRESS, migratedAtMs: MIGRATED_AT, migrationSlot: SLOT - 15_000n, tries: 2, lastEvalMs: NOW - 60_000, lastReason: 'H11 missing', bars: [{ startMs: NOW - 300_000, high: 2n, low: 1n, close: 2n }], signatures: { create: null, complete: null, migration: null } };
/** The strategy alone, given a restore fact at NOW with these saved candidates. */
const restoreInto = (candidates: unknown[], tails?: unknown, maxTails?: number, at = NOW) => {
  const session = startSession(TRIAL_POLICY);
  const config = strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG);
  const strategy = new LiveStrategy({ session, rugs: RUG_CONFIG, config: maxTails === undefined ? config : { ...config, maxTails } });
  const moment = { slot: SLOT, txIndex: 0, ixIndex: 0, receivedAt: at };
  const ctxAt = (ms: number) => ({ now: { ...moment, receivedAt: ms }, book: emptyBook({ maxOpenPositions: session.policy.positions.maxOpen }), rng: { next: () => 0 }, lookup: () => ({ ok: false, reason: 'missing' }), history: () => [] } as unknown as StrategyContext);
  let seq = 0;
  /** A later event into the same strategy. */
  const feed = (key: string, value: unknown, ms = at + 60_000) => strategy.onMarket({ kind: 'market', id: `e${seq++}`, moment: { ...moment, receivedAt: ms }, key, value }, ctxAt(ms));
  const ctx = { now: moment, book: emptyBook({ maxOpenPositions: session.policy.positions.maxOpen }), rng: { next: () => 0 }, lookup: () => ({ ok: false, reason: 'missing' }), history: () => [] } as unknown as StrategyContext;
  const out = strategy.onMarket({ kind: 'market', id: 'restore', moment, key: RESTORE_KEY, value: { exits: {}, candidates, ...(tails === undefined ? {} : { tails }) } }, ctx);
  return { strategy, out, feed };
};
const MIN = 60_000;
/** A PumpSwap buy on the candidate's pool at `ms`, before-trade reserves base/quote (FEED-1's log event shape). */
const buy = (ms: number, base: bigint, quote: bigint, sig: string) => [`logs:pump_amm:BuyEvent:${POOL_ADDRESS}`, {
  event: { program: 'pump_amm', name: 'BuyEvent', data: { pool: POOL_ADDRESS, user: 'u', timestamp: BigInt(Math.floor(ms / 1000)), poolBaseTokenReserves: base, poolQuoteTokenReserves: quote, baseAmountOut: base / 100n, quoteAmountInWithLpFee: quote / 99n, quoteAmountIn: quote / 99n, virtualQuoteReserves: 0n } },
  signature: sig,
}] as const;
const close = (kind: 'resume' | 'gap', toSlot: bigint | null = null) => [`coverage:trades:${POOL_ADDRESS}:${kind}`, { value: { fromSlot: SLOT - 15_000n, ...(kind === 'gap' ? { toSlot, reason: 'catch-up' } : {}), via: `logs:${POOL_ADDRESS}` }, source: 'worker' }] as const;
const SAVED_BAR = { startMs: NOW - 5 * MIN, high: 2n, low: 1n, close: 2n };
/** Restored 20 minutes after the save: four 5-minute periods of downtime after the saved bar's. */
const downtime = () => restoreInto([{ ...GOOD, bars: [SAVED_BAR] }], undefined, undefined, NOW + 20 * MIN);
const boot = async (h: H, via = VIA) => {
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via });
  expect(await started).toEqual({ ok: true });
  await m.run(3_000, 400, () => m.slot());
  return m;
};

/** A worker past the migration, before the window: the coin is shortlisted from its migration (fact and log), then stopped. */
const shortlistedAndStopped = async (o: { create?: boolean } = {}) => {
  const stateDir = tempState();
  const timers = virtualTimers(MIGRATED_AT + 20 * 60_000);
  const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
  const h = makeWorker({ stateDir, timers, seed, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` } });
  const m = await boot(h);
  if (o.create !== false) m.create();
  m.fact(`logs:pump:CompletePumpAmmMigrationEvent:${MINT}`, { event: { program: 'pump', name: 'CompletePumpAmmMigrationEvent', data: { mint: MINT, pool: POOL_ADDRESS, timestamp: BigInt(Math.floor(MIGRATED_AT / 1000)) } }, signature: MIG_SIG, txSlot: SLOT - 15_000n });
  m.fact(migrationKey(MINT), passingFacts().get(migrationKey(MINT))!.value);
  await m.run(2_000, 400, () => m.slot());
  expect(h.worker.strategy.candidates().has(MINT)).toBe(true);
  await h.worker.stop();
  return { h, timers, seed };
};

const restart = async (h: H, timers: ReturnType<typeof virtualTimers>, seed: (r: SeedRequest) => Promise<unknown>, extra: Partial<Parameters<typeof makeWorker>[0]> = {}) => {
  const fetchedWhy: [string, string][] = [];
  const h2 = makeWorker({ stateDir: h.stateDir, timers, seed: seed as never, fetchedWhy, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` }, ...extra });
  const m2 = await boot(h2);
  return { h2, m2, fetchedWhy };
};

describe('RESTART-KEEP: a restart keeps the candidates in their window', () => {
  it('saves the candidate with its transactions; the restart restores it, reads them again and evaluates it at its moment', async () => {
    const { h, timers, seed } = await shortlistedAndStopped();
    const saved = loadState(join(h.stateDir, PERSIST_FILE), RUG_CONFIG);
    expect(saved.ok && saved.candidates).toEqual([{ mint: MINT, pool: POOL_ADDRESS, migratedAtMs: MIGRATED_AT, migrationSlot: SLOT - 15_000n, tries: 0, lastEvalMs: null, lastReason: null, bars: [], signatures: { create: 'create-1', complete: null, migration: MIG_SIG } }]);
    timers.set(timers.now() + 10 * 60_000);
    const { h2, m2, fetchedWhy } = await restart(h, timers, seed);
    expect(decisions(h2).filter((r) => r[0] === 'candidate restored').map((r) => r[2])).toEqual([MINT]);
    expect(h2.worker.strategy.candidates().get(MINT)?.migratedAtMs).toBe(MIGRATED_AT);
    // The restored pool is watched with its catch-up from the migration slot (S0-ZERO), not from the restart.
    expect(h2.worker.strategy.watchedPools().get(POOL_ADDRESS)?.fromSlot).toBe(SLOT - 15_000n);
    // Read again at confirmed once the sources are up: the migration and the create.
    expect(fetchedWhy).toEqual(expect.arrayContaining([[MIG_SIG, 'restore'], ['create-1', 'create']]));
    // Before the window: not evaluated. Inside it: evaluated (its facts are not all there, so a reject), never forgotten.
    expect(decisions(h2).some((r) => r[0] === 'reject' && r[2] === MINT)).toBe(false);
    timers.set(WINDOW_FROM + 1_000);
    m2.offchain('feed:status:helius', { state: 'up' });
    await m2.run(4_000, 400, () => m2.slot());
    expect(decisions(h2).some((r) => r[0] === 'reject' && r[2] === MINT)).toBe(true);
    await h2.worker.stop();
  }, 60_000);

  it.each([
    ['migrated after the restore', { migratedAtMs: NOW + 1 }, 'a saved candidate is dated after the restore'],
    ['evaluated after the restore', { lastEvalMs: NOW + 1 }, 'a saved candidate is dated after the restore'],
    ['malformed (tries not a whole number)', { tries: 1.5 }, 'malformed saved candidates'],
    ['malformed (no mint)', { mint: '' }, 'malformed saved candidates'],
    ['with a bar started after the restore', { bars: [{ startMs: NOW + 1, high: 2n, low: 1n, close: 2n }] }, 'a saved candidate is dated after the restore'],
    ['malformed (a bar price not a bigint)', { bars: [{ startMs: NOW - 1, high: 2, low: 1n, close: 2n }] }, 'malformed saved candidates'],
  ])('a saved candidate %s refuses the saved candidates whole (strategy, at its restore moment)', (_, change, why) => {
    const s = restoreInto([GOOD, { ...GOOD, mint: 'other-mint', ...change }]);
    expect(s.out).toContainEqual({ action: null, reasons: ['candidates refused', why] });
    expect(s.strategy.candidates().size).toBe(0);
  });

  it('a well-formed saved list comes back as of the restore, its pool noted and each candidate named', () => {
    const s = restoreInto([GOOD]);
    expect(s.out).toContainEqual({ action: null, reasons: ['candidate restored', 'U2', MINT, `migrated at ${GOOD.migratedAtMs}`, 'tries 2'] });
    expect(s.strategy.candidates().get(MINT)).toEqual(expect.objectContaining({ migratedAtMs: GOOD.migratedAtMs, lastEvalMs: GOOD.lastEvalMs }));
    // S0-ZERO's catch-up starts the pool's trade coverage at the saved migration slot.
    expect(s.strategy.watchedPools().get(POOL_ADDRESS)).toEqual({ mint: MINT, held: false, fromSlot: GOOD.migrationSlot });
  });

  it('rebuilds the downtime\'s bars from the pool\'s filled trades once the catch-up closes complete (a quiet period flat at the last price)', () => {
    const w = downtime();
    const t1 = buy(NOW + 1 * MIN, 1_000_000n, 2_000_000n, 'f1');
    const t2 = buy(NOW + 11 * MIN, 1_000_000n, 3_000_000n, 'f2');
    w.feed(t1[0], t1[1]);
    w.feed(t2[0], t2[1]);
    // A trade dated before the saved bar's period and one after the restore are not the downtime's.
    const early = buy(NOW - 10 * MIN, 1_000_000n, 9_000_000n, 'f0');
    w.feed(early[0], early[1]);
    // The catch-up's opening gap is not its close; nothing merges yet.
    w.feed(...close('gap'));
    expect(w.strategy.barsOf(MINT).map((b) => b.startMs)).toEqual([SAVED_BAR.startMs]);
    w.feed(...close('resume'));
    const bars = w.strategy.barsOf(MINT);
    const BAR = strategyConfig(startSession(TRIAL_POLICY).policy, FILL_CONFIG, RESEARCH_CONFIG).barMs;
    // Every period from the saved bar's to the restore's: contiguous, as the ATR needs.
    expect(bars.map((b) => b.startMs)).toEqual(Array.from({ length: (25 * MIN) / BAR }, (_, i) => SAVED_BAR.startMs + i * BAR));
    const at = (ms: number) => bars.find((x) => x.startMs === Math.floor(ms / BAR) * BAR)!;
    // A trade's period holds its prices before and after; a quiet period is flat at the last close before it.
    const p1 = at(NOW + 1 * MIN);
    expect(p1.high > p1.low).toBe(true);
    expect(at(NOW - 1 * MIN)).toEqual({ startMs: Math.floor((NOW - MIN) / BAR) * BAR, high: SAVED_BAR.close, low: SAVED_BAR.close, close: SAVED_BAR.close });
    const quiet = at(NOW + 6 * MIN);
    expect([quiet.high, quiet.low, quiet.close]).toEqual([p1.close, p1.close, p1.close]);
    expect(at(NOW + 19 * MIN).close).toBe(at(NOW + 11 * MIN).close);
    expect(at(NOW + 11 * MIN).close > p1.close).toBe(true);
    expect(bars[0]).toEqual(SAVED_BAR);
  });

  it.each([
    ['a lossy close (a bounded gap)', (w: ReturnType<typeof downtime>) => w.feed(...close('gap', SLOT))],
    ['trades out of order', (w: ReturnType<typeof downtime>) => {
      const late = buy(NOW + 2 * MIN, 1_000_000n, 2_500_000n, 'f3');
      w.feed(late[0], late[1]);
      w.feed(...close('resume'));
    }],
  ])('after %s the downtime\'s bars stay unknown: only the saved bar, never a guess', (_, end) => {
    const w = downtime();
    const t = buy(NOW + 11 * MIN, 1_000_000n, 3_000_000n, 'f2');
    w.feed(t[0], t[1]);
    end(w);
    w.feed(...close('resume'));
    expect(w.strategy.barsOf(MINT)).toEqual([SAVED_BAR]);
  });

  it('restores REC-1\'s tail watches: a live one keeps its pool watched, an ended one is dropped, past the cap logged', () => {
    const live = { mint: 'tail-a', pool: 'pool-a', untilMs: NOW + 60_000 };
    const ended = { mint: 'tail-b', pool: 'pool-b', untilMs: NOW - 1 };
    const s = restoreInto([], [live, ended]);
    expect([...s.strategy.watchedPools().keys()]).toEqual(['pool-a']);
    expect(s.strategy.tail.get('tail-a')).toEqual({ pool: 'pool-a', untilMs: NOW + 60_000 });
    const capped = restoreInto([], [live, { ...live, mint: 'tail-c', pool: 'pool-c' }], 1);
    expect([...capped.strategy.watchedPools().keys()]).toEqual(['pool-a']);
    expect(capped.out).toContainEqual({ action: null, reasons: ['no tail', 'U2', 'tail-c', 'tail cap 1'] });
    // An ended one takes no place under the cap.
    const afterEnded = restoreInto([], [ended, live], 1);
    expect([...afterEnded.strategy.watchedPools().keys()]).toEqual(['pool-a']);
    expect(afterEnded.out.some((d) => d.reasons[0] === 'no tail')).toBe(false);
    const bad = restoreInto([], [{ mint: 'tail-a', pool: '', untilMs: NOW }]);
    expect(bad.out).toContainEqual({ action: null, reasons: ['tails refused', 'malformed saved tails'] });
    expect(bad.strategy.watchedPools().size).toBe(0);
  });

  it('saves the tail watches with the state and a restart brings them back', async () => {
    const { h, timers, seed } = await shortlistedAndStopped();
    const path = join(h.stateDir, PERSIST_FILE);
    const st = loadState(path, RUG_CONFIG);
    if (!st.ok) throw new Error(st.reason);
    expect(st.tails).toEqual([]);
    const tail = { mint: 'tail-a', pool: 'pool-a', untilMs: timers.now() + 3_600_000 };
    saveState(path, { asOf: st.asOf, index: st.index.snapshot(st.asOf), labeller: st.labeller.snapshot(), coverage: st.coverage.filter((e) => !e.id.startsWith('persist:restart:')), ...(st.graduates === null ? {} : { graduates: st.graduates }), candidates: st.candidates, tails: [tail] });
    timers.set(timers.now() + 60_000);
    const { h2 } = await restart(h, timers, seed);
    expect(h2.worker.strategy.watchedPools().get('pool-a')).toEqual({ mint: 'tail-a', held: false });
    await h2.worker.stop();
    const again = loadState(path, RUG_CONFIG);
    expect(again.ok && again.tails).toEqual([tail]);
  }, 60_000);

  it('keeps the saved tries: the next entry intent id is past them, so a restart never repeats an intent id', async () => {
    // A fresh host 16 days before T, the coin passing every gate at T but H15 (no simulation): rejected, not entered.
    const stateDir = tempState();
    const timers = virtualTimers(T - 16 * 86_400_000);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const h = makeWorker({ stateDir, timers, seed, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` } });
    // The live creates watch on the via the passing facts' coverage names, so one watch carries it across the restart.
    await boot(h, CREATES_VIA);
    const m = await passingMarket(h, { omit: [simKey(MINT)] });
    m.offchain('feed:status:helius', { state: 'up' });
    await m.run(3_000, 400, () => m.pool());
    expect(Object.values(h.worker.book.intents)).toEqual([]);
    expect(decisions(h).some((r) => r[0] === 'reject' && r[2] === MINT)).toBe(true);
    await h.worker.stop();
    // The saved tries rewritten to 5, through the state file's own writer (the checksum must hold).
    const path = join(stateDir, PERSIST_FILE);
    const st = loadState(path, RUG_CONFIG);
    if (!st.ok) throw new Error(st.reason);
    expect(st.candidates.map((c) => [c.mint, c.tries])).toEqual([[MINT, 0]]);
    saveState(path, { asOf: st.asOf, index: st.index.snapshot(st.asOf), labeller: st.labeller.snapshot(), coverage: st.coverage.filter((e) => !e.id.startsWith('persist:restart:')), ...(st.graduates === null ? {} : { graduates: st.graduates }), candidates: st.candidates.map((c) => ({ ...c, tries: 5 })) });
    // The restart on timers that fire only when the clock reaches them, so the worker's own waits never jump it.
    const t2 = dueTimers(timers.now() + 30_000);
    const h2 = makeWorker({ stateDir, timers: t2, seed: (r) => runSeed(r, { rpc: emptyRpc, timers: t2 }), config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` } });
    void h2.worker.start();
    const tick = async (): Promise<void> => {
      t2.set(t2.now() + 100);
      for (let k = 0; k < 4; k++) await new Promise<void>((r) => setImmediate(r));
    };
    for (let k = 0; k < 600 && !h2.order.includes('start helius-ws'); k++) await tick();
    const m2 = new Market(h2);
    m2.slot();
    m2.offchain('coverage:creates:start', { fromSlot: slotAt(m2.now), via: CREATES_VIA });
    m2.offchain('feed:status:helius', { state: 'up' });
    expect(decisions(h2).find((r) => r[0] === 'candidate restored')).toEqual(['candidate restored', 'U2', MINT, `migrated at ${MIGRATED_AT}`, 'tries 5']);
    // Every fact again, the simulation too: the entry's intent id is past the saved tries (the book holds none for it).
    const entries = () => Object.values(h2.worker.book.intents).filter((i) => i.intent.purpose === 'entry');
    for (let k = 0; k < 300 && entries().length === 0; k++) {
      m2.slot();
      if (k % 10 === 0) for (const [key, { value }] of passingFacts()) if (!key.startsWith('coverage:')) m2.fact(key, value);
      // RUG-1c's on-demand deployer check: what stands in live for the rug labeller's coverage after a restart.
      m2.fact(rugCheckKey(DEV), { obs: { provider: 'helius', slot: h2.worker.feed.openSlot - 1n, receivedAt: m2.now, quality: [], commitment: 'confirmed' }, creator: DEV, version: RUG_CONFIG.version, fromMs: 0, asOfMs: m2.now, mints: [], credits: 0 });
      m2.pool();
      await tick();
    }
    expect(entries().map((i) => String(i.intent.id))).toEqual([`en:${MINT}:6`]);
    await h2.worker.stop();
  }, 60_000);

  it('a create this process never saw is looked up from the mint\'s oldest transaction, at most 10 pages, charged to the budget', async () => {
    const { h, timers, seed } = await shortlistedAndStopped({ create: false });
    timers.set(timers.now() + 60_000);
    const pages: (string | undefined)[] = [];
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ signature: `s${from + i}`, slot: 1n, err: null, blockTime: 0 }));
    const spent: number[] = [];
    let left = 1_000;
    const budget = { remaining: () => left, spend: (c: number) => { left -= c; spent.push(c); }, refund: (c: number) => { left += c; spent.push(-c); } };
    const rpc = {
      getSignaturesForAddress: async (address: string, o: { before?: string }) => {
        if (address !== MINT) return [];
        pages.push(o.before);
        // 2,400 transactions: two full pages, then the last 400 ending at the create.
        return pages.length < 3 ? page(1_000, (pages.length - 1) * 1_000) : page(400, 2_000);
      },
      getTransaction: async () => null,
    };
    const { h2, fetchedWhy } = await restart(h, timers, seed, { restartReads: { rpc, budget } });
    for (let k = 0; k < 100 && !(fetchedWhy.some(([s]) => s === 's2399') && h2.logs.some((l) => l.startsWith('Downtime migrations'))); k++) await new Promise<void>((r) => setImmediate(r));
    expect(pages).toEqual([undefined, 's999', 's1999']);
    expect(fetchedWhy).toContainEqual(['s2399', 'create']);
    // Reserved for the cap, the unread pages given back: 3 credits used (the downtime read reserves and refunds its own).
    expect(spent.slice(0, 2)).toEqual([CREATE_WALK_PAGES, -(CREATE_WALK_PAGES - 3)]);
    expect(h2.logs.some((l) => l === `Create of ${MINT} looked up: s2399 (3 credits).`)).toBe(true);
    await h2.worker.stop();
  }, 60_000);

  it('a create beyond the page cap is not found: logged, nothing fetched, and the gates that need it reject', async () => {
    const { h, timers, seed } = await shortlistedAndStopped({ create: false });
    timers.set(timers.now() + 60_000);
    let calls = 0;
    const rpc = { getSignaturesForAddress: async (address: string) => (address !== MINT ? [] : (calls++, Array.from({ length: 1_000 }, (_, i) => ({ signature: `x${calls}-${i}`, slot: 1n, err: null, blockTime: 0 })))), getTransaction: async () => null };
    const budget = { remaining: () => 1_000, spend: () => undefined, refund: () => undefined };
    const { h2, fetchedWhy } = await restart(h, timers, seed, { restartReads: { rpc, budget } });
    for (let k = 0; k < 50 && !h2.logs.some((l) => l.startsWith(`Create of ${MINT} not found`)); k++) await new Promise<void>((r) => setImmediate(r));
    expect(calls).toBe(CREATE_WALK_PAGES);
    expect(h2.logs).toContain(`Create of ${MINT} not found (history longer than ${CREATE_WALK_PAGES} signature pages); H9 and H12-H14 reject it.`);
    expect(fetchedWhy.filter(([, why]) => why === 'create')).toEqual([]);
    await h2.worker.stop();
  }, 60_000);

  it('reads the downtime\'s migrations from the migration authority after the saved slot, charged to the budget', async () => {
    const { h, timers, seed } = await shortlistedAndStopped();
    const saved = loadState(join(h.stateDir, PERSIST_FILE), RUG_CONFIG);
    const from = saved.ok ? saved.asOf.slot : -1n;
    timers.set(timers.now() + 10 * 60_000);
    const asked: { address: string; before?: string; minContextSlot?: bigint }[] = [];
    const rpc = {
      getSignaturesForAddress: async (address: string, o: { before?: string; minContextSlot?: bigint }) => {
        asked.push({ address, ...o });
        return [{ signature: 'before-the-range', slot: from, err: null, blockTime: 0 }];
      },
      getTransaction: async () => null,
    };
    let left = 5_000;
    const budget = { remaining: () => left, spend: (c: number) => { left -= c; }, refund: (c: number) => { left += c; } };
    const { h2 } = await restart(h, timers, seed, { restartReads: { rpc, budget } });
    for (let k = 0; k < 100 && !h2.logs.some((l) => l.startsWith('Downtime migrations')); k++) await new Promise<void>((r) => setImmediate(r));
    expect(asked[0]).toEqual(expect.objectContaining({ address: PUMP_MIGRATION_AUTHORITY }));
    expect(h2.logs.find((l) => l.startsWith('Downtime migrations'))).toMatch(new RegExp(`^Downtime migrations: 0 from slot ${from + 1n} to \\d+, 1 credits, done\\.$`));
    expect(left).toBe(4_999);
    await h2.worker.stop();
  }, 60_000);

  it('a coin that migrated during the downtime becomes a candidate: its migration and curve completion are read and put on the feed', async () => {
    // Slots before the recorded mainnet migration (fixture slot 452941614), then a restart after it.
    const migrate = chainTx('migration CreatePoolEvent');
    const complete = chainTx('pump CompleteEvent (curve filled)');
    const mig = transactionEvents(migrate).find((e) => e.name === 'CompletePumpAmmMigrationEvent')!.data as { mint: string; bondingCurve: string };
    expect(transactionEvents(migrate).some((e) => e.name === 'CompleteEvent')).toBe(false);
    const stateDir = tempState();
    const timers = virtualTimers(T - 110 * 60_000);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const h = makeWorker({ stateDir, timers, seed, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` } });
    await boot(h);
    await h.worker.stop();
    const saved = loadState(join(stateDir, PERSIST_FILE), RUG_CONFIG);
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.asOf.slot < migrate.slot).toBe(true);
    timers.set(T - 100 * 60_000);
    const asked: string[] = [];
    const rpc = {
      getSignaturesForAddress: async (address: string, o: { before?: string }) => {
        asked.push(o.before === undefined ? address : `${address} before ${o.before}`);
        if (address === PUMP_MIGRATION_AUTHORITY) return [{ signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, { signature: 'older', slot: saved.asOf.slot, err: null, blockTime: 0 }];
        if (address === mig.bondingCurve) return [{ signature: complete.signature, slot: complete.slot, err: null, blockTime: complete.blockTime }];
        return [];
      },
      getTransaction: async (sig: string) => (sig === migrate.signature ? migrate : sig === complete.signature ? complete : null),
    };
    let left = 5_000;
    const budget = { remaining: () => left, spend: (c: number) => { left -= c; }, refund: (c: number) => { left += c; } };
    const { h2, m2 } = await restart(h, timers, seed, { restartReads: { rpc, budget } });
    for (let k = 0; k < 100 && !h2.logs.some((l) => l.startsWith('Downtime migrations')); k++) await new Promise<void>((r) => setImmediate(r));
    await m2.run(2_000, 400, () => m2.slot());
    expect(asked).toEqual([PUMP_MIGRATION_AUTHORITY, `${mig.bondingCurve} before ${migrate.signature}`, ...asked.slice(2)]);
    expect(h2.logs.find((l) => l.startsWith('Downtime migrations'))).toMatch(/^Downtime migrations: 1 from slot \d+ to \d+, 4 credits, done\.$/);
    // Released to the strategy, as the live migration watch's fetch would have: the coin is shortlisted, and its create
    // (created before this start) is looked up: one more credit from the same budget.
    expect(decisions(h2).some((r) => r[0] === 'shortlist' && r[2] === mig.mint)).toBe(true);
    expect(asked).toContain(mig.mint);
    expect(left).toBe(5_000 - 5);
    await h2.worker.stop();
  }, 60_000);

  it.each([
    ['dated after the saved moment', (c: Record<string, unknown>, at: number) => ({ ...c, migratedAtMs: at + 1 }), /candidate .* is dated after the saved moment/],
    ['named twice', (c: Record<string, unknown>) => c, /appears twice/],
    ['malformed', (c: Record<string, unknown>) => ({ ...c, signatures: { create: 1 } }), /a saved candidate is malformed/],
  ])('a saved candidate %s discards the whole file (state)', async (name, change, why) => {
    const { h } = await shortlistedAndStopped();
    const path = join(h.stateDir, PERSIST_FILE);
    const outer = JSON.parse(readFileSync(path, 'utf8')) as { version: number; sha256: string; payload: string };
    const inner = JSON.parse(outer.payload) as { asOf: { receivedAt: number }; candidates: Record<string, unknown>[] };
    const c0 = inner.candidates[0]!;
    inner.candidates = name === 'named twice' ? [c0, c0] : [change(c0, inner.asOf.receivedAt)];
    const payload = JSON.stringify(inner);
    const { createHash } = await import('node:crypto');
    writeFileSync(path, JSON.stringify({ version: outer.version, sha256: createHash('sha256').update(payload).digest('hex'), payload }));
    const r = loadState(path, RUG_CONFIG);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(why);
  }, 60_000);

  it('a file without candidates (written before RESTART-KEEP) still loads, with none', async () => {
    const { h } = await shortlistedAndStopped();
    const path = join(h.stateDir, PERSIST_FILE);
    const outer = JSON.parse(readFileSync(path, 'utf8')) as { version: number; sha256: string; payload: string };
    const payload = JSON.stringify({ ...JSON.parse(outer.payload), candidates: undefined });
    const { createHash } = await import('node:crypto');
    writeFileSync(path, JSON.stringify({ version: outer.version, sha256: createHash('sha256').update(payload).digest('hex'), payload }));
    const r = loadState(path, RUG_CONFIG);
    expect(r.ok && r.candidates).toEqual([]);
    expect(T).toBeGreaterThan(MIGRATED_AT);
  }, 60_000);
});
