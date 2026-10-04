// A worker on virtual time with a scripted market, for the WORKER-1 tests. No network: the sources are scripted, the
// simulation is a stub that records each leg, and time moves only when a wait asks for it.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, startSession, TRIAL_POLICY, type PolicySession } from '../../core/src/config/index.ts';
import type { DryRunRecord } from '../src/dryrun/index.ts';
import type { HttpClient } from '../src/providers/index.ts';
import type { Timers } from '../src/scheduler/timers.ts';
import { parseConfig, type WorkerConfig } from '../src/run/config.ts';
import type { SimLeg } from '../src/run/paper-world.ts';
import { PAPER_SCENARIO, strategyConfig } from '../src/run/settings.ts';
import { type FeedSource, type SeedRequest, type SeedResult, type SourcesContext, Worker, type WorkerDeps } from '../src/run/worker.ts';
import type { FactSource } from '../src/run/facts.ts';
import type { SeedRpc } from '../src/seed/rpc.ts';
import { ALCHEMY_FREE, HELIUS_FREE, JUPITER_FREE, RUGCHECK_FREE, Scheduler } from '../src/scheduler/index.ts';
import {
  CREATED_AT, DEV, FEE_CONTEXT, MIGRATED_AT, MINT, POOL, POOL_ADDRESS, SLOT, SOL_PRICE, SUPPLY, T, passingFacts, roundTrip,
} from '../../core/test/gates/world.ts';
import { EXEC_HEALTH_KEY, TX_CREATE_PREFIX, holdersKey, lpKey, migrationKey, poolKey, simKey, softKey, streamKey, xcheckKey, type FactObs } from '../../core/src/gates/index.ts';
import { SOL_PRICE_KEY, feesKey } from '../src/engine/strategy.ts';
import { type MicroUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import type { PoolState } from '../../core/src/amm/index.ts';
import { RAW, STREAMS } from '../../core/src/facts/index.ts';
import { account } from '../../core/test/gates/world.ts';
import { swapLog } from '../../core/test/facts/swaps.ts';

/** Virtual time: a wait moves the clock by its length and resolves on the next turn of the event loop. */
/** The timers a test drives: it moves the clock. */
export type TestTimers = Timers & { set(ms: number): void };

export const virtualTimers = (start: number): TestTimers => {
  let now = start;
  let next = 1;
  const cancelled = new Set<number>();
  return {
    now: () => now,
    set: (ms) => {
      if (ms > now) now = ms;
    },
    setTimeout: (fn, ms) => {
      const id = next++;
      setImmediate(() => {
        if (cancelled.delete(id)) return;
        now += Math.max(0, ms);
        fn();
      });
      return { id };
    },
    clearTimeout: (h) => void cancelled.add(h.id),
  };
};

/**
 * Timers that fire only once the virtual clock reaches them (the test moves it with `set`): for a wait, such as the
 * seed's cap, that must not elapse at its first turn as `virtualTimers` lets it.
 */
export const dueTimers = (start: number): TestTimers => {
  let now = start;
  let next = 1;
  const due = new Map<number, { readonly at: number; readonly fn: () => void }>();
  const poll = (): void => {
    for (const [id, t] of [...due].sort((x, y) => x[1].at - y[1].at || x[0] - y[0])) {
      if (t.at > now || !due.delete(id)) continue;
      t.fn();
    }
  };
  return {
    now: () => now,
    set: (ms) => {
      if (ms > now) now = ms;
      setImmediate(poll);
    },
    setTimeout: (fn, ms) => {
      const id = next++;
      due.set(id, { at: now + Math.max(0, ms), fn });
      setImmediate(poll);
      return { id };
    },
    clearTimeout: (h) => void due.delete(h.id),
  };
};

export const tempState = (): string => mkdtempSync(join(tmpdir(), 'zeroed-worker-'));

/**
 * Default health and API ports, distinct per test worker process and per worker made in it: test files run in
 * parallel processes, and a fixed default (the health port 18790, the API's live 8788) let two of them bind the same
 * address, failing one start. 21000 and up, clear of the fixed 18xxx ports some tests name.
 */
let made = 0;
const defaultPorts = (): { readonly health: number; readonly api: number } => {
  const pool = Number(process.env['VITEST_POOL_ID'] ?? '1') % 40;
  const k = made++ % 100;
  const health = 21_000 + pool * 200 + k * 2;
  return { health, api: health + 1 };
};

export const testConfig = (stateDir: string, over: Record<string, string> = {}): WorkerConfig => {
  const ports = defaultPorts();
  const p = parseConfig({
    ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on',
    ZEROED_HEALTH_ADDR: `127.0.0.1:${ports.health}`, ZEROED_API_ADDR: `127.0.0.1:${ports.api}`, ZEROED_GIT_SHA: 'testsha', ...over,
  }, () => null);
  if (!p.ok) throw new Error(p.message);
  return p.config;
};

/** A simulation stub: every leg simulates and matches its quote exactly. */
export const okSimulation = (legs: SimLeg[]) => async (leg: SimLeg): Promise<DryRunRecord> => {
  legs.push(leg);
  return {
    id: `${leg.trade}|${leg.leg}`, side: leg.side, finalExit: leg.side === 'sell' && leg.closes, venue: 'pool', mint: leg.mint as DryRunRecord['mint'], outcome: 'simulated', success: true, error: null,
    standIn: null, policy: null, quotedOut: leg.quotedOut, simulatedOut: leg.quotedOut, amountErrorE4: 0, readSlot: leg.minContextSlot, quoteAgeSlots: 0n,
    rentDeclared: 0n, rentPaid: 0n, balancesFrom: 'simulation', simulatedSlot: leg.minContextSlot, unitsConsumed: 100_000n, logsTail: [],
  };
};

export const noHttp: HttpClient = async () => {
  throw new Error('no network in tests');
};

/** A scripted source: counts starts and stops (drills). */
export const scriptedSource = (name: string, critical: boolean, sources: readonly string[]): FeedSource & { starts: number; stops: number } => {
  const s = { name, critical, sources, starts: 0, stops: 0, start: () => void s.starts++, stop: () => void s.stops++ };
  return s;
};

export interface Harness {
  readonly worker: Worker;
  /** The scripted sources, once start() built them; and the start order (seed hook, sources built, each start). */
  readonly sources: ReturnType<typeof scriptedSource>[];
  readonly order: string[];
  readonly timers: TestTimers;
  readonly legs: SimLeg[];
  readonly logs: string[];
  readonly stateDir: string;
  readonly session: PolicySession;
}

/**
 * The conservative paper scenario, with every attempt landing, in its regular landing window, unless a test asks
 * otherwise (RUN-1d). The draws are the same in every process anyway: the boot is pinned (`boot-<n>`).
 */
export const LANDS = { ...FILL_CONFIG.scenarios[PAPER_SCENARIO], landPpm: { pumpswap: 1_000_000n, 'pump-curve': 1_000_000n }, landingTail: { ...FILL_CONFIG.scenarios[PAPER_SCENARIO].landingTail, ppm: 0n } };

/** Boots made per state folder: a test's n-th worker is `boot-<n>` whatever the process, its pid or the other tests. */
const boots = new Map<string, number>();

export const makeWorker = (o: { reconcileTimeoutMs?: number; scenario?: typeof LANDS; stateDir?: string; timers?: TestTimers; edgePpm?: bigint; http?: HttpClient; key?: string | null; config?: Record<string, string>; fetched?: string[]; found?: boolean; facts?: FactSource[]; seed?: (r: SeedRequest) => Promise<SeedResult>; seedWaitMs?: number; entry?: { timing: 'gates' | 'random'; salt: string }; sources?: (ctx: SourcesContext) => FeedSource[]; exposureRpc?: SeedRpc; ops?: WorkerDeps['ops']; universe?: 'U1' | 'U2'; seedMaxMs?: number; simulate?: (leg: SimLeg) => Promise<DryRunRecord>; markedHistory?: WorkerDeps['markedHistory'] } = {}): Harness => {
  const stateDir = o.stateDir ?? tempState();
  const timers = o.timers ?? virtualTimers(T - 16 * 86_400_000);
  const session = startSession(TRIAL_POLICY);
  const legs: SimLeg[] = [];
  const logs: string[] = [];
  const sources: ReturnType<typeof scriptedSource>[] = [];
  const order: string[] = [];
  const n = boots.get(stateDir) ?? 0;
  boots.set(stateDir, n + 1);
  const worker = new Worker({
    boot: `boot-${n}`,
    config: testConfig(stateDir, { WATCHDOG_URL: 'https://watchdog.example.workers.dev', ...o.config }),
    session, rugs: RUG_CONFIG,
    strategy: { ...strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG, o.edgePpm ?? 400_000n, o.entry), ...(o.universe === undefined ? {} : { universe: o.universe }) },
    scenario: o.scenario ?? LANDS, network: FILL_CONFIG.network, timers,
    sources: o.sources ?? (() => {
      order.push('sources');
      const made = [scriptedSource('helius-ws', true, ['helius']), scriptedSource('pumpportal', false, ['pumpportal'])];
      for (const m of made) {
        const start = m.start;
        m.start = () => {
          order.push(`start ${m.name}`);
          start();
        };
      }
      sources.push(...made);
      return made;
    }),
    simulate: o.simulate ?? okSimulation(legs),
    fetchTx: async (sig) => {
      o.fetched?.push(sig);
      return o.found ?? false;
    },
    seed: async (r) => {
      order.push('seed');
      return o.seed === undefined ? { mode: 'none', creates: [], coverage: [], report: 'test: not seeded' } : o.seed(r);
    },
    seedWaitMs: o.seedWaitMs ?? 1_000,
    ...(o.seedMaxMs === undefined ? {} : { seedMaxMs: o.seedMaxMs }),
    ...(o.exposureRpc === undefined ? {} : { exposureRpc: o.exposureRpc }),
    ...(o.ops === undefined ? {} : { ops: o.ops }),
    ...(o.markedHistory === undefined ? {} : { markedHistory: o.markedHistory }),
    heartbeat: { http: o.http ?? noHttp, key: o.key === undefined ? null : o.key, ownerChatId: '42' },
    ...(o.facts === undefined ? {} : { facts: o.facts, schedulers: { helius: new Scheduler(HELIUS_FREE, { timers }), alchemy: new Scheduler(ALCHEMY_FREE, { timers }), jupiter: new Scheduler(JUPITER_FREE, { timers }), rugcheck: new Scheduler(RUGCHECK_FREE, { timers }) } }),
    reconcileTimeoutMs: o.reconcileTimeoutMs ?? 120_000, loopMs: 100, staleFeedMs: 10_000, log: (l) => void logs.push(l),
  });
  return { worker, timers, legs, logs, stateDir, session, sources, order };
};

/** GATE-1's passing facts, built once (the fixture derives holder addresses on the curve, which is slow); read only. */
let cachedFacts: ReturnType<typeof passingFacts> | null = null;
const facts0 = (): ReturnType<typeof passingFacts> => (cachedFacts ??= passingFacts());

/** Slot at a moment of the scripted market: one slot every 400 ms, SLOT at T. */
export const slotAt = (ms: number): bigint => SLOT - BigInt(Math.floor((T - ms) / 400));

/** The scripted market: slot notices and facts put on the worker's live Feed at the virtual time. */
export class Market {
  readonly #h: Harness;
  #slot: bigint | null = null;
  #swaps = 0;
  /** Publish the fee-context fact with each pool read (off: the strategy takes the terms of the latest swap). */
  withFees = true;
  /**
   * Test-only switch: keep publishing the pool fact with `pool()` while a position on the mint is held. Off by
   * default, as live (POS-1): after entry nothing re-reads the pool, and its state moves only with `chainSwap`.
   */
  heldPoolFacts = false;
  /** The pool's reserves as the last `accountsRead` or `chainSwap` left them. */
  #chain: PoolState | null = null;

  constructor(h: Harness, o: { readonly heldPoolFacts?: boolean } = {}) {
    this.#h = h;
    this.heldPoolFacts = o.heldPoolFacts ?? false;
  }

  get now(): number {
    return this.#h.timers.now();
  }

  /** A slot notice: by default the slot of the moment, never one the feed already released (that would be late). */
  slot(at?: bigint): void {
    const released = this.#h.worker.feed.releasedThrough + 1n;
    const s = at ?? (slotAt(this.now) > released ? slotAt(this.now) : released);
    if (this.#slot !== null && s <= this.#slot) return;
    this.#slot = s;
    this.#h.worker.feed.ingest('helius', { type: 'slot', slot: s, parent: s - 1n, root: null }, { receivedAt: this.now });
  }

  fact(key: string, value: unknown): void {
    this.#h.worker.feed.ingest('worker', { type: 'fact', key, value }, { receivedAt: this.now });
  }

  offchain(key: string, value: unknown): void {
    this.#h.worker.feed.ingest('worker', { type: 'offchain', key, value }, { receivedAt: this.now });
  }

  /**
   * The pool at a price multiple (quote vault scaled) and every state fact read again now, one slot behind the feed's
   * open slot: what FACTS-1's producers keep current live.
   */
  pool(quoteScalePpm: bigint = 1_000_000n): void {
    const slot = this.#h.worker.feed.openSlot - 1n;
    const facts = facts0();
    const now = (k: string, over: Partial<FactObs> = {}) => {
      const v = facts.get(k)!.value as { obs: FactObs };
      return { ...v, obs: { ...v.obs, slot: v.obs.slot === null ? null : slot, receivedAt: this.now - 50, ...over } };
    };
    const base = now(poolKey(MINT)) as unknown as Record<string, unknown>;
    if (this.heldPoolFacts || !this.held()) this.fact(poolKey(MINT), { ...base, quoteVault: ((base['quoteVault'] as bigint) * quoteScalePpm) / 1_000_000n });
    if (this.withFees) this.fact(feesKey(MINT), FEE_CONTEXT);
    this.fact(SOL_PRICE_KEY, { value: SOL_PRICE, atMs: this.now - 50 });
    for (const k of [lpKey(MINT), holdersKey(MINT), softKey(MINT), xcheckKey(MINT), EXEC_HEALTH_KEY]) this.fact(k, now(k));
    // The simulation of the spend the worker will judge: q_min at the SOL price, rounded up to whole lamports.
    const spend = microUsdToLamports(TRIAL_POLICY.capital.minNotional, SOL_PRICE as MicroUsd, 'ceil');
    const q = roundTrip(spend);
    if (!q.ok) throw new Error('the passing pool must quote');
    this.fact(simKey(MINT), { ...now(simKey(MINT)), spend, paid: q.trade.paid, proceeds: q.trade.proceeds });
    const stream = facts.get(streamKey('chain'))!.value as { obs: FactObs; gapFreeSince: bigint };
    this.fact(streamKey('chain'), { ...stream, obs: { ...stream.obs, slot, receivedAt: this.now - 50 } });
  }

  /** A fresh live SOL/USD price (what the price stream keeps current). */
  solPrice(): void {
    this.fact(SOL_PRICE_KEY, { value: SOL_PRICE, atMs: this.now - 50 });
  }

  /** A position on the passing mint is open or closing. */
  held(): boolean {
    return Object.values(this.#h.worker.book.positions).some((p) => String(p.mint) === MINT && p.status !== 'closed');
  }

  /** The pool's trade stream starts (the confirmed logs watch on the pool, FACTS-1 STREAMS.trades), from `fromSlot`. */
  tradesStart(fromSlot: bigint): void {
    this.offchain(`coverage:${STREAMS.trades(POOL_ADDRESS)}:start`, { fromSlot, via: `logs:${POOL_ADDRESS}` });
  }

  /** A coverage gap on the pool's trade stream (`toSlot` null: still open). */
  tradesGap(fromSlot: bigint, toSlot: bigint | null): void {
    this.offchain(`coverage:${STREAMS.trades(POOL_ADDRESS)}:gap`, { fromSlot, toSlot, reason: 'disconnect', via: `logs:${POOL_ADDRESS}` });
  }

  /**
   * A confirmed account read of the real passing pool and its vaults answered for `slot`: the producer's base. The mint
   * account is left out, so the passing mint fact (re-published with each slot) is not replaced by one that ages.
   */
  accountsRead(slot: bigint): void {
    const accounts = [POOL_ADDRESS, POOL.poolBaseTokenAccount, POOL.poolQuoteTokenAccount].map((a) => {
      const x = account(a);
      return { address: a, owner: x.owner, data: x.dataBase64 };
    });
    this.offchain(RAW.accounts(MINT), { mint: MINT, slot, commitment: 'confirmed', accounts });
    const f = facts0().get(poolKey(MINT))!.value as { baseVault: bigint; quoteVault: bigint; pool: { virtualQuoteReserves?: bigint } };
    this.#chain = { baseReserve: f.baseVault, quoteVault: f.quoteVault, virtualQuoteReserves: f.pool.virtualQuoteReserves ?? 0n };
  }

  /** The pool's reserves as the chain now holds them (after the last `chainSwap`). */
  get chainState(): PoolState {
    if (this.#chain === null) throw new Error('no accounts read yet');
    return this.#chain;
  }

  /**
   * A real swap on the passing pool continuing its reserves: a confirmed logs notification whose `Program data:` line is
   * the Borsh BuyEvent/SellEvent the program logs (amounts from the exact PumpSwap math), in slot `slot`.
   */
  chainSwap(side: 'buy' | 'sell', base: bigint, slot: bigint): void {
    const n = ++this.#swaps;
    const { logs, after } = swapLog({ pool: POOL_ADDRESS, coinCreator: DEV, supply: SUPPLY, pre: this.chainState, side, base, atMs: this.now });
    this.#h.worker.feed.ingest('helius', { type: 'logs', signature: `chainswap${n}`, slot, err: null, via: `logs:${POOL_ADDRESS}`, logs, commitment: 'confirmed' }, { receivedAt: this.now });
    this.#chain = after;
  }

  /** A PumpSwap swap on the passing pool, as decoded from its log line, at the passing fee terms. */
  swap(name: 'BuyEvent' | 'SellEvent', user: string, baseAmount: bigint): void {
    const n = ++this.#swaps;
    const data = {
      pool: POOL_ADDRESS, user, ...(name === 'SellEvent' ? { baseAmountIn: baseAmount } : { baseAmountOut: baseAmount }), timestamp: BigInt(Math.floor(this.now / 1000)),
      lpFeeBasisPoints: 2n, protocolFeeBasisPoints: 93n, coinCreatorFeeBasisPoints: 30n, buybackFeeBasisPoints: 5_000n, ixName: name === 'SellEvent' ? 'sell' : 'buy_exact_quote_in_v2', baseSupply: SUPPLY,
    };
    this.fact(`logs:pump_amm:${name}:${POOL_ADDRESS}:${n}`, { event: { program: 'pump_amm', name, data }, signature: `swap-${n}` });
  }

  /** The mint's create as released from its transaction: the deployer (DEV) and the total supply. */
  create(): void {
    const data = { mint: MINT, creator: DEV, user: DEV, timestamp: BigInt(Math.floor(CREATED_AT / 1000)), tokenTotalSupply: SUPPLY };
    this.fact(`${TX_CREATE_PREFIX}${MINT}`, { event: { program: 'pump', name: 'CreateEvent', data }, signature: 'create-1' });
  }

  /** Runs worker steps while moving the clock, `ms` at a time. */
  async run(ms: number, every = 100, each?: () => void): Promise<void> {
    const end = this.now + ms;
    while (this.now < end) {
      each?.();
      this.#h.worker.step();
      this.#h.timers.set(this.now + every);
      await new Promise<void>((r) => setImmediate(r));
    }
    this.#h.worker.step();
  }
}

/**
 * Runs market time in slices until `ready` holds, up to `maxMs`; returns whether it held. Paper effects land through
 * timers, so a busy machine moves when one lands inside the virtual timeline, never whether it lands: an assertion on
 * an effect waits for it instead of assuming a fixed window.
 */
export const until = async (m: Market, maxMs: number, ready: () => boolean, each?: () => void): Promise<boolean> => {
  const end = m.now + maxMs;
  while (!ready() && m.now < end) await m.run(400, 400, each);
  return ready();
};

/** Sets up 15 days of coverage, a migrated candidate and minute pool bars, then every passing fact at T. */
export const passingMarket = async (h: Harness, o: { readonly fees?: boolean; readonly heldPoolFacts?: boolean } = {}): Promise<Market> => {
  const m = new Market(h, { heldPoolFacts: o.heldPoolFacts ?? false });
  m.withFees = o.fees ?? true;
  const facts = facts0();
  // 15 days before T: the creates stream and a full trade stream start; the deployer index sees its first event.
  m.slot();
  for (const k of ['coverage:creates:start', 'coverage:rugs:start']) {
    const v = facts.get(k)!.value as { value: unknown };
    m.offchain(k, v.value);
  }
  await m.run(3_000);
  // 20 minutes before T: the migration (90 min before T) and a pool fact every minute, for the ATR bars.
  h.timers.set(T - 20 * 60_000);
  m.slot();
  m.fact(migrationKey(MINT), facts.get(migrationKey(MINT))!.value);
  for (let k = 0; k < 20; k++) {
    h.timers.set(T - (20 - k) * 60_000);
    m.slot();
    m.pool(1_000_000n + BigInt((k % 3) * 2_000));
    await m.run(2_500);
  }
  // At T: every passing fact (the pool fact last, observed now).
  h.timers.set(T - 200);
  m.slot(SLOT);
  for (const [k, { value }] of facts) {
    if (k.startsWith('coverage:') || k === poolKey(MINT) || k === migrationKey(MINT)) continue;
    m.fact(k, value);
  }
  m.pool();
  return m;
};

export { CREATED_AT, DEV, MIGRATED_AT, MINT, POOL, POOL_ADDRESS, SLOT, SOL_PRICE, SUPPLY, T };
