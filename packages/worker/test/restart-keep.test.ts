// RESTART-KEEP: a restart costs no candidate. The candidates in their window are saved with the state and come back
// at the restore, with the transactions their gate facts came from read again at confirmed; a create this process
// never saw is looked up from its mint's oldest transaction (capped, budget-charged); the downtime's migrations are
// read from the migration authority after the saved slot.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY, exitsFor, startSession } from '../../core/src/config/index.ts';
import type { StrategyContext } from '../../core/src/engine/index.ts';
import { emptyBook } from '../../core/src/lifecycle/index.ts';
import { LiveStrategy, RESTORE_KEY } from '../src/engine/strategy.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { migrationKey, poolKey, rugCheckKey, simKey } from '../../core/src/gates/index.ts';
import { STREAMS } from '../../core/src/facts/index.ts';
import { atr, newTracker } from '../../core/src/exits/index.ts';
import type { PoolState } from '../../core/src/amm/index.ts';
import { swapLog } from '../../core/test/facts/swaps.ts';
import { encode } from '../../core/test/chain/encode.ts';
import { BuyEventLayout, SellEventLayout, toBase64 } from '../../core/src/chain/index.ts';
import { feesKey } from '../src/engine/strategy.ts';
import { FEE_CONTEXT, passingFacts } from '../../core/test/gates/world.ts';
import { chainTx } from '../../core/test/facts/helpers.ts';
import { transactionEvents } from '../../core/src/chain/index.ts';
import { loadState, saveState, type SavedCandidateState } from '../src/persist/index.ts';
import { runSeed } from '../src/run/seed-start.ts';
import { DOWNTIME_CREDIT_CAP, PERSIST_FILE, type SeedRequest } from '../src/run/worker.ts';
import { PUMP_MIGRATION_AUTHORITY } from '../src/run/sources.ts';
import { DEV, MIGRATED_AT, MINT, Market, SUPPLY, dueTimers, passingMarket, POOL_ADDRESS, SLOT, T, makeWorker, slotAt, tempState, virtualTimers } from './worker-harness.ts';

const emptyRpc = { getSignaturesForAddress: async () => [{ signature: 'before-the-range', slot: 0n, err: null, blockTime: 0 }], getTransaction: async () => null };
const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const MIG_SIG = 'migration-sig';
const CREATES_VIA = ((passingFacts().get('coverage:creates:start')!.value as { value: { via: string } }).value).via;
const WINDOW_FROM = MIGRATED_AT + RESEARCH_CONFIG.s0.u2WindowFromMs;
type H = ReturnType<typeof makeWorker>;
const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
const decisions = (h: H) => journal(h.stateDir).filter((l) => l['boot'] === h.worker.boot && l['kind'] === 'decision').map((l) => (l['reasons'] as string[]) ?? []);

let port = 18_700;

/** Rewrites the payload line of a saved state file (format v2: header, payload, mint rows, trailer), its hash kept true. */
const editPayload = (path: string, f: (p: Record<string, unknown>) => Record<string, unknown>) => {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
  const body = [JSON.stringify(f(JSON.parse(lines[1]!) as Record<string, unknown>)), ...lines.slice(2, -1)].map((l) => `${l}\n`);
  const sha = createHash('sha256').update(body.join('')).digest('hex');
  writeFileSync(path, `${lines[0]}\n${body.join('')}${JSON.stringify({ sha256: sha, lines: body.length })}\n`);
};

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
    expect(saved.ok && saved.candidates).toEqual([{ mint: MINT, pool: POOL_ADDRESS, migratedAtMs: MIGRATED_AT, migrationSlot: SLOT - 15_000n, tries: 0, lastEvalMs: null, lastReason: null, bars: [], fees: null, signatures: { create: 'create-1', complete: null, migration: MIG_SIG } }]);
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

  it('STEP-B: a candidate whose window ended during the downtime is not restored: it ends as the first event would end it', () => {
    const c = strategyConfig(startSession(TRIAL_POLICY).policy, FILL_CONFIG, RESEARCH_CONFIG);
    const ENDED_AT = NOW - c.windowToMs - 1;
    const ended = { ...GOOD, mint: 'ended-mint', pool: 'ended-pool', migratedAtMs: ENDED_AT, lastEvalMs: ENDED_AT + 60_000, bars: [{ startMs: ENDED_AT + 60_000, high: 2n, low: 1n, close: 2n }] };
    const unseen = { ...ended, mint: 'unseen-mint', pool: 'unseen-pool', lastEvalMs: null, lastReason: null, bars: [] };
    const s = restoreInto([GOOD, ended, unseen]);
    // Only the candidate still in its window is restored (and so read again by the worker); the others are not listed.
    expect(s.out.filter((d) => d.reasons[0] === 'candidate restored').map((d) => d.reasons[2])).toEqual([MINT]);
    expect([...s.strategy.candidates().keys()]).toEqual([MINT]);
    expect(s.strategy.barsOf('ended-mint')).toEqual([]);
    // The record a live run makes at the window end: the rejected one keeps its tail, the never-evaluated one has none.
    expect(s.out).toContainEqual({ action: null, reasons: ['no entry', 'U2', 'ended-mint', 'window ended; last reason: H11 missing'] });
    expect(s.out).toContainEqual({ action: null, reasons: ['no entry', 'U2', 'unseen-mint', 'window ended'] });
    expect(s.strategy.tail.get('ended-mint')).toEqual({ pool: 'ended-pool', untilMs: ENDED_AT + c.windowToMs + exitsFor(startSession(TRIAL_POLICY).policy.exits, c.universe).tMaxMs });
    expect(s.strategy.tail.has('unseen-mint')).toBe(false);
    expect(s.strategy.watchedPools().has('unseen-pool')).toBe(false);
    // The candidate in its window comes back exactly as it did alone (decisions for in-window candidates unchanged).
    const alone = restoreInto([GOOD]);
    expect(s.out.filter((d) => d.reasons[2] === MINT)).toEqual(alone.out.filter((d) => d.reasons[2] === MINT));
    expect(s.strategy.candidates().get(MINT)).toEqual(alone.strategy.candidates().get(MINT));
    expect(s.strategy.watchedPools().get(POOL_ADDRESS)).toEqual(alone.strategy.watchedPools().get(POOL_ADDRESS));
    // One ms inside its window it is still restored.
    const edge = restoreInto([{ ...unseen, migratedAtMs: NOW - c.windowToMs + 1 }]);
    expect(edge.out.filter((d) => d.reasons[0] === 'candidate restored' || d.reasons[0] === 'no entry').map((d) => d.reasons[0])).toEqual(['candidate restored']);
    // At its window's end exactly it has ended, as `#windowEnds` reads it (now >= end).
    const atEnd = restoreInto([{ ...unseen, migratedAtMs: NOW - c.windowToMs }]);
    expect(atEnd.out.filter((d) => d.reasons[0] === 'candidate restored' || d.reasons[0] === 'no entry').map((d) => d.reasons[0])).toEqual(['no entry']);
  });

  it('STEP-B: a restart after the window ended reads none of the candidate\'s transactions again', async () => {
    const { h, timers, seed } = await shortlistedAndStopped();
    const c = strategyConfig(startSession(TRIAL_POLICY).policy, FILL_CONFIG, RESEARCH_CONFIG);
    timers.set(MIGRATED_AT + c.windowToMs + 60_000);
    const { h2, fetchedWhy } = await restart(h, timers, seed);
    expect(decisions(h2).some((r) => r[0] === 'candidate restored')).toBe(false);
    expect(decisions(h2)).toContainEqual(['no entry', 'U2', MINT, 'window ended']);
    expect(fetchedWhy.filter(([, why]) => why === 'restore' || why === 'create')).toEqual([]);
    expect(h2.worker.strategy.candidates().has(MINT)).toBe(false);
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

  describe('the downtime\'s bars, rebuilt from the catch-up, equal a never-restarted worker\'s (parity)', () => {
    const START = MIGRATED_AT + 20 * MIN;
    /** Real PumpSwap swaps on the candidate's pool, at fixed moments: minutes 0..4 before the save, then the downtime. */
    const at = (m: number, sec: number) => START + m * MIN + sec * 1_000;
    const BEFORE = [0, 1, 2, 3, 4].map((m) => at(m + 1, 5));
    const SAVE = at(5, 25);
    // One in the saved last bar's minute after the save, two in one minute, a quiet minute (no trade, so no bar live),
    // and one in the restart's own minute before the restart.
    // A trade at block time 11:59.8 is received at 12:00.3: live, restart and replay must all put it in minute 11.
    const EDGE = { block: at(11, 59.8), recv: at(12, 0.3) };
    const DOWN = [at(5, 45), at(7, 5), at(7, 35), at(8, 5), at(10, 5), EDGE.block, at(13, 10)];
    /** When each trade reaches the live worker: at its block time, but the edge trade half a second into the next minute. */
    const recvAt = (block: number) => (block === EDGE.block ? EDGE.recv : block);
    const RESTART = at(13, 30);
    const READ = at(13, 40);
    const tick = async (t: ReturnType<typeof dueTimers>) => {
      t.set(t.now() + 100);
      for (let k = 0; k < 4; k++) await new Promise<void>((r) => setImmediate(r));
    };
    const until = async (t: ReturnType<typeof dueTimers>, m: Market, ms: number) => {
      while (t.now() < ms) {
        m.slot();
        await tick(t);
      }
    };
    const start = async (stateDir?: string) => {
      const t = dueTimers(START);
      const h = makeWorker({ ...(stateDir === undefined ? {} : { stateDir }), timers: t, seed: (r) => runSeed(r, { rpc: emptyRpc, timers: t }), config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` } });
      void h.worker.start();
      for (let k = 0; k < 600 && !h.order.includes('start helius-ws'); k++) await tick(t);
      const m = new Market(h);
      m.slot();
      m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
      for (let k = 0; k < 30; k++) await tick(t);
      return { h, t, m };
    };
    type Trade = { readonly sig: string; readonly logs: string[]; readonly at: number; readonly data: Record<string, unknown>; readonly side: 'buy' | 'sell' };
    /** The scripted trades, each continuing the pool's reserves from the account read. */
    const script = (pre0: PoolState): Trade[] => {
      let pre = pre0;
      return [...BEFORE, ...DOWN].map((at, i) => {
        const side = i % 3 === 2 ? 'sell' : 'buy';
        const { logs, after, data } = swapLog({ pool: POOL_ADDRESS, coinCreator: DEV, supply: SUPPLY, pre, side, base: pre.baseReserve / 500n, atMs: at });
        pre = after;
        // Signatures that sort against chain order: at one moment the feed releases a fill's trades in id order.
        return { sig: `pt${1000 - i}`, logs, at, data, side };
      });
    };
    /** A trade's log on the feed: confirmed (the pool watch), or with `processed` the other commitment's copy (a new frame). */
    const live = (h: H, x: Trade, slot: bigint, o: { backfilled?: boolean; processed?: boolean } = {}) =>
      h.worker.feed.ingest('helius', { type: 'logs', signature: x.sig, slot, err: null, via: `logs:${POOL_ADDRESS}`, logs: x.logs, ...(o.processed === true ? {} : { commitment: 'confirmed' as const }) }, { receivedAt: h.timers.now(), ...(o.backfilled === true ? { backfilled: true, lookup: true, after: true } : {}) });
    /** Shortlisted from its migration, the pool's trade stream started and one account read, then the trades before the save. */
    const before = async () => {
      const w = await start();
      w.m.fact(`logs:pump:CompletePumpAmmMigrationEvent:${MINT}`, { event: { program: 'pump', name: 'CompletePumpAmmMigrationEvent', data: { mint: MINT, pool: POOL_ADDRESS, timestamp: BigInt(Math.floor(MIGRATED_AT / 1000)) } }, signature: MIG_SIG, txSlot: SLOT - 15_000n });
      w.m.fact(migrationKey(MINT), passingFacts().get(migrationKey(MINT))!.value);
      w.m.fact(feesKey(MINT), FEE_CONTEXT);
      w.m.tradesStart(w.h.worker.feed.releasedThrough - 100n);
      await until(w.t, w.m, START + 20_000);
      w.m.accountsRead(w.h.worker.feed.releasedThrough);
      const trades = script(w.m.chainState);
      for (const x of trades.slice(0, BEFORE.length)) {
        await until(w.t, w.m, recvAt(x.at));
        live(w.h, x, w.h.worker.feed.openSlot);
      }
      await until(w.t, w.m, SAVE);
      return { ...w, trades };
    };

    const parity = async (catchUp: (h: H, m: Market, down: readonly Trade[]) => void) => {
      // A: never restarted, every trade live.
      const a = await before();
      for (const x of a.trades.slice(BEFORE.length)) {
        await until(a.t, a.m, recvAt(x.at));
        live(a.h, x, a.h.worker.feed.openSlot);
      }
      // An account read in the restart's minute: a live sample after the downtime's last trade, in both.
      await until(a.t, a.m, READ);
      a.m.accountsRead(a.h.worker.feed.releasedThrough);
      await until(a.t, a.m, RESTART + 50_000);
      // B: saved and stopped after the trades before the save; restarted after the downtime; its catch-up releases them.
      const b = await before();
      await b.h.worker.stop();
      const t2 = dueTimers(RESTART);
      const h2 = makeWorker({ stateDir: b.h.stateDir, timers: t2, seed: (r) => runSeed(r, { rpc: emptyRpc, timers: t2 }), config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` } });
      void h2.worker.start();
      for (let k = 0; k < 600 && !h2.order.includes('start helius-ws'); k++) await tick(t2);
      const m2 = new Market(h2);
      m2.slot();
      m2.offchain('coverage:creates:start', { fromSlot: slotAt(m2.now), via: VIA });
      // The read comes first here (the catch-up is slower): the rebuilt bar of that minute keeps the read's close.
      m2.fact(feesKey(MINT), FEE_CONTEXT);
      await until(t2, m2, READ);
      m2.accountsRead(h2.worker.feed.releasedThrough);
      await until(t2, m2, READ + 2_000);
      // The catch-up opens its gap on the pool's trade stream, releases the downtime's trades, then closes.
      m2.offchain(`coverage:${STREAMS.trades(POOL_ADDRESS)}:gap`, { fromSlot: SLOT - 15_000n, toSlot: null, reason: 'catch-up', via: `logs:${POOL_ADDRESS}` });
      // The catch-up reads the pool from its migration: every trade, those before the save too.
      catchUp(h2, m2, b.trades);
      await until(t2, m2, RESTART + 50_000);
      const out = { a: a.h.worker.strategy.barsOf(MINT), b: h2.worker.strategy.barsOf(MINT) };
      await a.h.worker.stop();
      await h2.worker.stop();
      return out;
    };
    const K = BEFORE.length;
    /** A trade's log with one amount off by a lamport: it no longer replays (`swapEventState`), as a corrupt read would. */
    const corrupt = (x: Trade): Trade => {
      const l = x.side === 'buy' ? BuyEventLayout : SellEventLayout;
      const data = { ...x.data, ...(x.side === 'buy' ? { quoteAmountIn: (x.data['quoteAmountIn'] as bigint) + 1n } : { quoteAmountOut: (x.data['quoteAmountOut'] as bigint) + 1n }) };
      const bytes = Uint8Array.from([...l.discriminator, ...encode([...l.base, ...l.added] as unknown as readonly (readonly [string, { idl: unknown }])[], data)]);
      return { ...x, logs: [x.logs[0]!, `Program data: ${toBase64(bytes)}`, x.logs[2]!] };
    };
    const resume = (m: Market) => m.offchain(`coverage:${STREAMS.trades(POOL_ADDRESS)}:resume`, { fromSlot: SLOT - 15_000n, via: `logs:${POOL_ADDRESS}` });

    it('a complete catch-up gives the same bars, bar for bar, quiet minutes and all (so the same ATR)', async () => {
      const { a, b } = await parity((h, m, down) => {
        for (const x of down) live(h, x, h.worker.feed.openSlot, { backfilled: true });
        resume(m);
      });
      expect(a.length).toBeGreaterThan(BEFORE.length);
      // The quiet minute has no bar in either.
      expect(a.some((x) => x.startMs === at(9, 0))).toBe(false);
      // The late-received edge trade is in its block time's minute live, and so in the rebuild: no bar at 12.
      expect(a.some((x) => x.startMs === at(11, 0))).toBe(true);
      expect(a.some((x) => x.startMs === at(12, 0))).toBe(false);
      expect(b).toEqual(a);
      const ux = exitsFor(TRIAL_POLICY.exits, 'U2');
      expect(atr(b, ux.atrPeriod, ux.atrBarMs, RESTART + 30_000)).toBe(atr(a, ux.atrPeriod, ux.atrBarMs, RESTART + 30_000));
    }, 120_000);

    it('trades arriving in any order (one moment, ordered by id) are put back in chain order: the same bars', async () => {
      const { a, b } = await parity((h, m, down) => {
        for (const x of [...down].reverse()) live(h, x, h.worker.feed.openSlot, { backfilled: true });
        resume(m);
      });
      expect(b).toEqual(a);
    }, 120_000);

    it('the same trade from a confirmed and a processed log, after a newer trade in its minute, counts once (the close stays)', async () => {
      const { a, b } = await parity((h, m, down) => {
        for (const x of down) live(h, x, h.worker.feed.openSlot, { backfilled: true });
        // DOWN[1] again, after DOWN[2] in the same minute, as the other commitment's copy: a new frame, the same trade.
        live(h, down[K + 1]!, h.worker.feed.openSlot, { backfilled: true, processed: true });
        resume(m);
      });
      expect(b).toEqual(a);
    }, 120_000);

    it.each([
      ['a lossy close', (h: H, m: Market, down: readonly Trade[]) => {
        for (const x of down) live(h, x, h.worker.feed.openSlot, { backfilled: true });
        m.offchain(`coverage:${STREAMS.trades(POOL_ADDRESS)}:gap`, { fromSlot: SLOT - 15_000n, toSlot: SLOT, reason: 'catch-up', via: `logs:${POOL_ADDRESS}` });
        resume(m);
      }],
      // The last one: without it the rest still chain, so only the refusal keeps the downtime unknown.
      ['a trade that does not replay', (h: H, m: Market, down: readonly Trade[]) => {
        for (const [i, x] of down.entries()) live(h, i === down.length - 1 ? corrupt(x) : x, h.worker.feed.openSlot, { backfilled: true });
        resume(m);
      }],
      ['a fill missing one trade (the reserves no longer chain)', (h: H, m: Market, down: readonly Trade[]) => {
        for (const x of down.filter((_, i) => i !== K + 2)) live(h, x, h.worker.feed.openSlot, { backfilled: true });
        resume(m);
      }],
    ])('after %s the downtime has no bars: only the bars saved before it, never a guess', async (_, catchUp) => {
      const { a, b } = await parity(catchUp);
      // The saved bars, and the live read's own bar after the restart; nothing in the downtime between them.
      const saved = a.filter((x) => x.startMs < Math.floor(SAVE / MIN) * MIN);
      expect(b.slice(0, saved.length)).toEqual(saved);
      expect(b.filter((x) => x.startMs > Math.floor(SAVE / MIN) * MIN && x.startMs < Math.floor(RESTART / MIN) * MIN)).toEqual([]);
      expect(b.length).toBeLessThan(a.length);
    }, 120_000);
  });

  describe('#track dates a pool update on block time (anchor from released swaps)', () => {
    const m0 = Math.floor(NOW / MIN) * MIN + 40_000; // block time of the anchor swap: 40 s into a minute
    const S = SLOT;
    /** A strategy holding the candidate, with the facts its market reads, and a feed of events at receipt times. */
    const world = () => {
      const session = startSession(TRIAL_POLICY);
      const strategy = new LiveStrategy({ session, rugs: RUG_CONFIG, config: strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG) });
      const facts = new Map<string, unknown>([[feesKey(MINT), FEE_CONTEXT]]);
      let seq = 0;
      const ev = (key: string, value: unknown, recv: number, slot = S) => {
        const moment = { slot, txIndex: 0, ixIndex: 0, receivedAt: recv };
        const ctx = {
          now: moment, book: emptyBook({ maxOpenPositions: session.policy.positions.maxOpen }), rng: { next: () => 0 }, history: () => [],
          lookup: (k: string) => (facts.has(k) ? { ok: true, moment, value: facts.get(k), source: 'test' } : { ok: false, reason: 'missing' }),
        } as unknown as StrategyContext;
        return strategy.onMarket({ kind: 'market', id: `k${seq++}`, moment, key, value }, ctx);
      };
      ev(RESTORE_KEY, { exits: {}, candidates: [{ ...GOOD, lastEvalMs: null, bars: [] }] }, m0 - 120_000);
      const base = passingFacts().get(poolKey(MINT))!.value as { obs: Record<string, unknown>; quoteVault: bigint };
      /** A pool update read at `slot` (an account read: no swap of its own), quote scaled by `ppm`, received at `recv`. */
      const read = (slot: bigint, recv: number, ppm = 1_000_000n) => {
        const v = { ...base, obs: { ...base.obs, slot, receivedAt: recv }, quoteVault: (base.quoteVault * ppm) / 1_000_000n };
        facts.set(poolKey(MINT), v);
        ev(poolKey(MINT), v, recv, slot);
      };
      /** A swap on another pool: only the block-time anchor moves (its txSlot, at the open slot like a fill's). */
      const anchor = (txSlot: bigint, blockMs: number, recv: number, momentSlot = txSlot) =>
        ev(`logs:pump_amm:BuyEvent:other-pool`, { event: { program: 'pump_amm', name: 'BuyEvent', data: { pool: 'other-pool', timestamp: BigInt(Math.floor(blockMs / 1000)) } }, signature: `a${seq}`, txSlot }, recv, momentSlot);
      /** A swap on the candidate's own pool at `txSlot`, then its pool update (FACTS-1's chain) at the same slot. */
      const own = (txSlot: bigint, blockMs: number, recv: number) => {
        ev(`logs:pump_amm:BuyEvent:${POOL_ADDRESS}`, { event: { program: 'pump_amm', name: 'BuyEvent', data: { pool: POOL_ADDRESS, user: 'u', timestamp: BigInt(Math.floor(blockMs / 1000)) } }, signature: `o${seq}`, txSlot }, recv);
        read(txSlot, recv);
      };
      return { strategy, read, anchor, own, bars: () => strategy.barsOf(MINT) };
    };
    const minute = (ms: number) => Math.floor(ms / MIN) * MIN;

    it('a fresh anchor dates a read by its slot; an estimate past now lands in now\'s bar (K1)', () => {
      const w = world();
      w.anchor(S, m0, m0 + 500);
      // 50 slots on: about 20 s after the anchor, the same minute's next bar (m0 is 40 s in).
      w.read(S + 50n, m0 + 25_000);
      expect(w.bars().map((b) => b.startMs)).toEqual([minute(m0 + 20_000)]);
      // 100 slots on (40 s after the anchor) but received only 5 s after it: never dated past the engine clock.
      const x = world();
      x.anchor(S, m0, m0 + 500);
      x.read(S + 100n, m0 + 5_000);
      expect(x.bars().map((b) => b.startMs)).toEqual([minute(m0 + 5_000)]);
    });

    it('a stale anchor (over 150 slots) does not date a read: receipt time, so a slow-slot drift never crosses a minute (ruling)', () => {
      const w = world();
      w.anchor(S, m0, m0 + 500);
      // 1,500 slots at 420 ms: received 630 s after the anchor; the 400 ms guess (600 s) would be the minute before.
      w.read(S + 1_500n, m0 + 630_000);
      expect(minute(m0 + 600_000)).not.toBe(minute(m0 + 630_000));
      expect(w.bars().map((b) => b.startMs)).toEqual([minute(m0 + 630_000)]);
    });

    it('the anchor is the swap\'s own txSlot, not the open slot its event sits at (K6)', () => {
      const w = world();
      // A fill's swap at slot S, released at an open slot 500 later.
      w.anchor(S, m0, m0 + 300_000, S + 500n);
      w.read(S + 50n, m0 + 300_000);
      expect(w.bars().map((b) => b.startMs)).toEqual([minute(m0 + 20_000)]);
    });

    it('a swap\'s pool update takes its own swap\'s block time, even after another pool\'s swap at a higher slot moved the anchor (run/CI B1)', () => {
      const w = world();
      const twelve = minute(m0) + 2 * MIN; // a whole minute
      // Pool B's swap at S + 10 (12:00:03) is released before pool A's swap at S (12:00:00, a fill behind live).
      w.anchor(S + 10n, twelve + 3_000, twelve + 5_000);
      w.own(S, twelve, twelve + 6_000);
      // From the anchor it would be 11:59:59; its own swap says 12:00:00, as the rebuild and the backtest date it.
      expect(w.bars().map((b) => b.startMs)).toEqual([twelve]);
    });

    it('an older swap of the pool released after a newer one (a fill) still dates its own pool update', () => {
      const w = world();
      const t = minute(m0) + 2 * MIN;
      w.own(S + 200n, t + 30_000, t + 31_000); // live, minute t
      w.own(S, t - 50_000, t + 32_000); // a fill behind live: its block time is the minute before
      expect(w.bars().map((b) => b.startMs)).toEqual([minute(t - 50_000), minute(t + 30_000)]);
    });

    it('the estimate is 400 ms a slot: 45 slots from an anchor 40 s into a minute stay in that minute (450 ms would not)', () => {
      const w = world();
      w.anchor(S, m0, m0 + 500);
      w.read(S + 45n, m0 + 30_000);
      expect(w.bars().map((b) => b.startMs)).toEqual([minute(m0)]);
    });

    it('the anchor only moves forward by slot: an older swap released later does not replace a newer one', () => {
      const w = world();
      const t = minute(m0) + 10_000;
      // The newer swap's slots ran slow (500 ms): S + 100 at t + 50 s. An older one, S at t, arrives after it (a fill).
      w.anchor(S + 100n, t + 50_000, t + 51_000);
      w.anchor(S, t, t + 52_000);
      // S + 110 from the newer anchor: t + 54 s, the next minute; from the older one it would be t + 44 s, this minute.
      w.read(S + 110n, t + 70_000);
      expect(w.bars().map((b) => b.startMs)).toEqual([minute(t + 54_000)]);
      expect(minute(t + 54_000)).not.toBe(minute(t + 44_000));
    });

    it('the 150-slot bound: at 150 slots the anchor still estimates, at 151 the receipt time is taken', () => {
      const t = minute(m0) + 10_000;
      const at = world();
      at.anchor(S, t, t + 500);
      at.read(S + 150n, t + 130_000); // estimate t + 60 s (the next minute); received t + 130 s, two minutes on
      expect(at.bars().map((b) => b.startMs)).toEqual([minute(t + 60_000)]);
      expect(minute(t + 60_000)).not.toBe(minute(t + 130_000));
      const past = world();
      past.anchor(S, t, t + 500);
      // 151 slots: would estimate t + 60.4 s (the next minute); received t + 130 s, two minutes on.
      past.read(S + 151n, t + 130_000);
      expect(past.bars().map((b) => b.startMs)).toEqual([minute(t + 130_000)]);
      expect(minute(t + 60_400)).not.toBe(minute(t + 130_000));
    });

    it('the 150-slot bound holds both ways: a read more than 150 slots before the anchor takes its receipt time too', () => {
      const w = world();
      const t = minute(m0) + 10_000;
      // The anchor is 1,000 slots ahead of the read (a fill's swap released before an older account read).
      w.anchor(S + 1_000n, t + 400_000, t + 401_000);
      w.read(S, t + 470_000);
      // From the anchor it would be t (400 s back); the receipt time is minutes later.
      expect(minute(t)).not.toBe(minute(t + 470_000));
      expect(w.bars().map((b) => b.startMs)).toEqual([minute(t + 470_000)]);
    });

    it('a swap block time ahead of the local clock dates its pool update at now, never in a later bar', () => {
      const w = world();
      const now = minute(m0) + 2 * MIN + 10_000;
      w.own(S, now + 90_000, now);
      expect(w.bars().map((b) => b.startMs)).toEqual([minute(now)]);
    });

    it('a late sample in an earlier bar widens it, keeps the order, and never moves its close back (K4, K5)', () => {
      const w = world();
      w.anchor(S, m0, m0 + 500);
      w.read(S, m0 + 1_000, 1_000_000n); // minute of m0, price p
      w.read(S + 75n, m0 + 31_000, 1_010_000n); // 30 s on: the next minute
      const [b0, b1] = w.bars();
      expect([b0!.startMs, b1!.startMs]).toEqual([minute(m0), minute(m0 + 30_000)]);
      // A read for slot S + 10 (4 s after the anchor) arriving after the next minute's: it widens the first bar only.
      w.read(S + 10n, m0 + 32_000, 1_050_000n);
      const after = w.bars();
      expect(after.map((b) => b.startMs)).toEqual([minute(m0), minute(m0 + 30_000)]);
      expect(after[0]!.high > b0!.high).toBe(true);
      expect(after[0]!.close).toBe(b0!.close);
      expect(after[1]).toEqual(b1);
    });
  });

  it('a mint forgotten when its position closes starts empty when watched again: flow, deployer, sales, own swap time', () => {
    const session = startSession(TRIAL_POLICY);
    const strategy = new LiveStrategy({ session, rugs: RUG_CONFIG, config: strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG) });
    const M2 = 'Mint2222222222222222222222222222222222222222';
    const facts = new Map<string, unknown>([[feesKey(M2), FEE_CONTEXT]]);
    let seq = 0;
    const t0 = Math.floor(NOW / MIN) * MIN + 10_000;
    const ev = (key: string, value: unknown, recv: number, positions: Record<string, unknown> = {}, slot = SLOT) => {
      const moment = { slot, txIndex: 0, ixIndex: 0, receivedAt: recv };
      const ctx = {
        now: moment, book: { ...emptyBook({ maxOpenPositions: session.policy.positions.maxOpen }), positions }, rng: { next: () => 0 }, history: () => [],
        lookup: (k: string) => (facts.has(k) ? { ok: true, moment, value: facts.get(k), source: 'test' } : { ok: false, reason: 'missing' }),
      } as unknown as StrategyContext;
      return strategy.onMarket({ kind: 'market', id: `f${seq++}`, moment, key, value }, ctx);
    };
    const plan = { openedAtMs: t0 - 60_000, universe: 'U2', notional: 2_000_000n, riskUnit: 1_000n, stopPrice: 1n, entryReserve: 1n };
    const exit = (o: Record<string, unknown>) => ({ plan, tracker: newTracker(), bars: [], pool: POOL_ADDRESS, ...o });
    // Held first: its exit inputs as saved, and a swap on its pool at slot S dated t0.
    ev(RESTORE_KEY, { exits: { [`p:${M2}:1`]: exit({ deployer: { sellers: ['dev-a'], supply: 1_000n }, deployerSales: { ids: ['s1'], list: [{ atMs: t0 - 30_000, amount: 5n }] }, flow: { minutes: [[t0 - 60_000, -7n]], ids: [['f1', t0 - 60_000]] } }) } }, t0);
    ev(`logs:pump_amm:BuyEvent:${POOL_ADDRESS}`, { event: { program: 'pump_amm', name: 'BuyEvent', data: { pool: POOL_ADDRESS, user: 'u', timestamp: BigInt(Math.floor(t0 / 1000)) } }, signature: 'own1', txSlot: SLOT }, t0 + 1_000);
    // Another pool's swap 100 slots later, its slots slow: from it, slot S would be dated a minute after t0.
    ev('logs:pump_amm:BuyEvent:other-pool', { event: { program: 'pump_amm', name: 'BuyEvent', data: { pool: 'other-pool', timestamp: BigInt(Math.floor((t0 + 100_000) / 1000)) } }, signature: 'b1', txSlot: SLOT + 100n }, t0 + 2_000);
    // The position closes: its exit and the mint's pool state are forgotten.
    ev('test:tick', null, t0 + 3_000, { [`p:${M2}:1`]: { id: `p:${M2}:1`, mint: M2, status: 'closed' } });
    expect(strategy.saved()[`p:${M2}:1`]).toBeUndefined();
    // Held again (a new position on the same mint): nothing of the first one carries over. The book holds the new position,
    // as the worker's rebuilt book does at a restore (a restored exit without a booked position is dropped, EXIT-1h
    // follow-up); `opening` keeps it out of exit management, which this test does not exercise.
    ev(RESTORE_KEY, { exits: { [`p:${M2}:2`]: exit({ deployer: { sellers: ['dev-b'], supply: 1_000n }, deployerSales: { ids: [], list: [] }, flow: { minutes: [], ids: [] } }) } }, t0 + 4_000,
      { [`p:${M2}:2`]: { id: `p:${M2}:2`, mint: M2, status: 'opening' } });
    const again = strategy.saved()[`p:${M2}:2`]!;
    expect(again.flow).toEqual({ minutes: [], ids: [] });
    expect(again.deployerSales).toEqual({ ids: [], list: [] });
    expect(again.deployer).toEqual({ sellers: ['dev-b'], supply: 1_000n });
    // A pool update at slot S: dated from the anchor (t0 + 60 s), not by the forgotten swap's t0.
    const base = passingFacts().get(poolKey(MINT))!.value as { obs: Record<string, unknown> };
    const v = { ...base, obs: { ...base.obs, slot: SLOT, receivedAt: t0 + 130_000 } };
    facts.set(poolKey(M2), v);
    ev(poolKey(M2), v, t0 + 130_000);
    expect(strategy.barsOf(M2).map((b) => b.startMs)).toEqual([Math.floor((t0 + 60_000) / MIN) * MIN]);
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

  it('a restored candidate whose create was never seen is looked up once the seed is placed (SEED-2\'s lookup)', async () => {
    const { h, timers, seed } = await shortlistedAndStopped({ create: false });
    timers.set(timers.now() + 60_000);
    const asked: string[] = [];
    const findCreate = async (mint: string) => (asked.push(mint), { mint, found: false, signature: null, slot: null, pages: 1, credits: 1, stopped_by: 'not-found' as const, latency_ms: 0 });
    const { h2 } = await restart(h, timers, seed, { findCreate });
    for (let k = 0; k < 50 && asked.length === 0; k++) await new Promise<void>((r) => setImmediate(r));
    expect(asked).toEqual([MINT]);
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
    // The downtime read is the one call on the migration authority (FACTS-REREAD may also read a restored candidate's
    // curve on the same RPC, under its own budget: never this budget, which the downtime read alone spends).
    expect(asked.filter((a) => a.address === PUMP_MIGRATION_AUTHORITY)).toEqual([expect.objectContaining({ address: PUMP_MIGRATION_AUTHORITY })]);
    expect(h2.logs.find((l) => l.startsWith('Downtime migrations'))).toMatch(new RegExp(`^Downtime migrations: 0 from slot ${from + 1n} to \\d+, 1 credits, done\\.$`));
    expect(left).toBe(4_999);
    await h2.worker.stop();
  }, 60_000);

  it('RT-A9: the downtime read refunds its unused reserve to the moment it was booked at, even when the read crosses a UTC midnight', async () => {
    const { h, timers, seed } = await shortlistedAndStopped();
    const saved = loadState(join(h.stateDir, PERSIST_FILE), RUG_CONFIG);
    const from = saved.ok ? saved.asOf.slot : -1n;
    timers.set(timers.now() + 10 * 60_000);
    const rpc = {
      getSignaturesForAddress: async (address: string) => {
        // The read takes a while: the clock moves on (past a midnight, for all the budget can tell).
        if (address === PUMP_MIGRATION_AUTHORITY) timers.set(timers.now() + 86_400_000);
        return [{ signature: 'before-the-range', slot: from, err: null, blockTime: 0 }];
      },
      getTransaction: async () => null,
    };
    const calls: [string, number, number][] = [];
    const budget = { remaining: () => 5_000, spend: (c: number, ms: number) => { calls.push(['spend', c, ms]); }, refund: (c: number, ms: number) => { calls.push(['refund', c, ms]); } };
    const { h2 } = await restart(h, timers, seed, { restartReads: { rpc, budget } });
    for (let k = 0; k < 100 && !h2.logs.some((l) => l.startsWith('Downtime migrations')); k++) await new Promise<void>((r) => setImmediate(r));
    for (let k = 0; k < 20; k++) await new Promise<void>((r) => setImmediate(r));
    const spend = calls.find((c) => c[0] === 'spend' && c[1] === DOWNTIME_CREDIT_CAP);
    expect(spend).toBeDefined();
    expect(calls.find((c) => c[0] === 'refund' && c[1] === DOWNTIME_CREDIT_CAP - 1)).toEqual(['refund', DOWNTIME_CREDIT_CAP - 1, spend![2]]);
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
    // The authority's page and the migration (2); the completion's page and transaction (2) are charged by COMPLETION-READ
    // when the migration is released, as live: the budget still pays 4 in all.
    expect(h2.logs.find((l) => l.startsWith('Downtime migrations'))).toMatch(/^Downtime migrations: 1 from slot \d+ to \d+, 2 credits, done\.$/);
    // Released to the strategy, as the live migration watch's fetch would have: the coin is shortlisted.
    expect(decisions(h2).some((r) => r[0] === 'shortlist' && r[2] === mig.mint)).toBe(true);
    expect(left).toBe(5_000 - 4);
    await h2.worker.stop();
  }, 60_000);

  it.each([
    ['dated after the saved moment', (c: Record<string, unknown>, at: number) => ({ ...c, migratedAtMs: at + 1 }), /candidate .* is dated after the saved moment/],
    ['named twice', (c: Record<string, unknown>) => c, /appears twice/],
    ['malformed', (c: Record<string, unknown>) => ({ ...c, signatures: { create: 1 } }), /a saved candidate is malformed/],
  ])('a saved candidate %s discards the whole file (state)', async (name, change, why) => {
    const { h } = await shortlistedAndStopped();
    const path = join(h.stateDir, PERSIST_FILE);
    editPayload(path, (inner) => {
      const c0 = (inner['candidates'] as Record<string, unknown>[])[0]!;
      const at = (inner['asOf'] as { receivedAt: number }).receivedAt;
      return { ...inner, candidates: name === 'named twice' ? [c0, c0] : [change(c0, at)] };
    });
    const r = loadState(path, RUG_CONFIG);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(why);
  }, 60_000);

  it.each([
    ['migrated after the snapshot moment', (c: SavedCandidateState, at: number) => [{ ...c, migratedAtMs: at + 1 }], /candidate .* is dated after the snapshot moment/],
    ['evaluated after the snapshot moment', (c: SavedCandidateState, at: number) => [{ ...c, lastEvalMs: at + 1 }], /candidate .* is dated after the snapshot moment/],
    ['with a bar started after the snapshot moment', (c: SavedCandidateState, at: number) => [{ ...c, bars: [{ startMs: at + 1, high: 2n, low: 1n, close: 2n }] }], /candidate .* is dated after the snapshot moment/],
    ['named twice', (c: SavedCandidateState) => [c, c], /appears twice/],
  ])('saveState refuses a candidate %s, and the old file stays whole (a bad save would discard the index next load)', async (_, change, why) => {
    const { h } = await shortlistedAndStopped();
    const path = join(h.stateDir, PERSIST_FILE);
    const before = readFileSync(path);
    const st = loadState(path, RUG_CONFIG);
    if (!st.ok) throw new Error(st.reason);
    const base = { asOf: st.asOf, index: st.index.snapshot(st.asOf), labeller: st.labeller.snapshot(), coverage: st.coverage.filter((e) => !e.id.startsWith('persist:restart:')), ...(st.graduates === null ? {} : { graduates: st.graduates }) };
    expect(() => saveState(path, { ...base, candidates: change(st.candidates[0]!, st.asOf.receivedAt) })).toThrow(why);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(loadState(path, RUG_CONFIG).ok).toBe(true);
  }, 60_000);

  it.each([
    ['malformed', [{ mint: 'tail-a', pool: '', untilMs: 1 }], /a saved tail is malformed/],
    ['named twice', [{ mint: 'tail-a', pool: 'p', untilMs: 1 }, { mint: 'tail-a', pool: 'p', untilMs: 2 }], /tail tail-a appears twice/],
  ])('a saved tail list %s discards the whole file (state, load)', async (_, tails, why) => {
    const { h } = await shortlistedAndStopped();
    const path = join(h.stateDir, PERSIST_FILE);
    editPayload(path, (inner) => ({ ...inner, tails }));
    const r = loadState(path, RUG_CONFIG);
    expect(r.ok ? '' : r.reason).toMatch(why);
  }, 60_000);

  it('a v1 file (written before G4b) is checked the same way: a candidate dated after its saved moment discards it', async () => {
    const { h } = await shortlistedAndStopped();
    const path = join(h.stateDir, PERSIST_FILE);
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
    const inner = JSON.parse(lines[1]!) as Record<string, unknown> & { index: { mints: unknown[] }; asOf: { receivedAt: number }; candidates: Record<string, unknown>[] };
    inner.index.mints = lines.slice(2, -1).map((l) => JSON.parse(l) as unknown);
    const write = (candidates: unknown[]) => {
      const payload = JSON.stringify({ ...inner, candidates });
      writeFileSync(path, JSON.stringify({ version: 1, sha256: createHash('sha256').update(payload).digest('hex'), payload }));
    };
    write(inner.candidates);
    const ok = loadState(path, RUG_CONFIG);
    expect(ok.ok && ok.version).toBe(1);
    expect(ok.ok && ok.candidates.map((c) => c.mint)).toEqual([MINT]);
    write([{ ...inner.candidates[0], migratedAtMs: inner.asOf.receivedAt + 1 }]);
    const r = loadState(path, RUG_CONFIG);
    expect(r.ok ? '' : r.reason).toMatch(/candidate .* is dated after the saved moment/);
  }, 60_000);

  it('a file without candidates (written before RESTART-KEEP) still loads, with none', async () => {
    const { h } = await shortlistedAndStopped();
    const path = join(h.stateDir, PERSIST_FILE);
    editPayload(path, (inner) => ({ ...inner, candidates: undefined }));
    const r = loadState(path, RUG_CONFIG);
    expect(r.ok && r.candidates).toEqual([]);
    expect(T).toBeGreaterThan(MIGRATED_AT);
  }, 60_000);
});

describe('A-FACTS-FIXES: a restart does not silence the refusal that asks for a stage-1 re-read', () => {
  it('a candidate refused before the restart is refused on the record again after it, so its missing facts are asked for', async () => {
    const { h, timers, seed } = await shortlistedAndStopped();
    // A first process in the window: refused (its facts are not all there), and saved with that last reason.
    const h1 = await restart(h, timers, seed);
    timers.set(WINDOW_FROM + 1_000);
    h1.m2.offchain('feed:status:helius', { state: 'up' });
    await h1.m2.run(4_000, 400, () => h1.m2.slot());
    const first = decisions(h1.h2).filter((r) => r[0] === 'reject' && r[2] === MINT);
    expect(first).toHaveLength(1);
    await h1.h2.worker.stop();
    timers.set(timers.now() + 60_000);
    const h2 = await restart(h1.h2, timers, seed);
    h2.m2.offchain('feed:status:helius', { state: 'up' });
    await h2.m2.run(4_000, 400, () => h2.m2.slot());
    const second = decisions(h2.h2).filter((r) => r[0] === 'reject' && r[2] === MINT);
    // The same reason as before the restart, written again once (with its typed reasons, the re-read trigger's input).
    const shape = (x: string | undefined) => x?.replace(/\d+/g, '#');
    expect(second.map((r) => shape(r[3]))).toEqual([shape(first[0]![3])]);
    // The journal keeps the typed reasons (the re-read trigger's input, `stage1Missing`) beside the line.
    const typed = journal(h2.h2.stateDir).filter((l) => l['boot'] === h2.h2.worker.boot && l['kind'] === 'decision' && (l['reasons'] as string[])[0] === 'reject');
    expect(typed.map((l) => Array.isArray(l['gate_reasons']))).toEqual([true]);
    // Later evaluations of the same reason in this process are not written again.
    await h2.m2.run(60_000, 400, () => h2.m2.slot());
    expect(decisions(h2.h2).filter((r) => r[0] === 'reject' && r[2] === MINT)).toHaveLength(1);
    await h2.h2.worker.stop();
  }, 60_000);
});
