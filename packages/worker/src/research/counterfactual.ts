// G3's counterfactual trades (ARCHITECTURE.md §14 G3, §16.3, TEST-3 card): a candidate the dry run vetoed only by a
// live-only check is scored after the run, offline, as if it had been entered. The run's recorded frames are fed, in
// arrival order and at their receipt times, to a fresh paper Worker in a temporary directory. It runs the run's own
// strategy, the paper world's fill model (BT-1's) and the exit engine, with two differences only:
// - the live-only checks are not applied (`gateMode: 'backtest'`, as BT-2 runs);
// - it takes no candidate but this one (`only`), from an empty book and a fresh paper account.
// So the trade holds no position slot, reservation or entry count of the run, and reads nothing from any provider.
// The run's own decisions, fills and account (world frames, the account and halt facts) are left out. Nothing is
// written to the run's state directory: the scorer reads its recording only.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicySession, RugConfig } from '../../../core/src/config/index.ts';
import type { FillNetwork, FillScenario } from '../../../core/src/fills/index.ts';
import { ACCOUNT_KEY, HALT_KEY, RESTORE_KEY, type StrategyConfig } from '../engine/strategy.ts';
import type { Frame } from '../providers/index.ts';
import { parseConfig } from '../run/config.ts';
import type { Timers, TimerHandle } from '../scheduler/timers.ts';
import { Worker } from '../run/worker.ts';

export interface CounterfactualInput {
  readonly mint: string;
  /** The run's frames, every boot, in arrival order. */
  readonly frames: readonly Frame[];
  readonly session: PolicySession;
  readonly rugs: RugConfig;
  /** The run's own strategy configuration (from its `start` line: entry rule, salt, edge). */
  readonly strategy: StrategyConfig;
  readonly scenario: FillScenario;
  readonly network: FillNetwork;
  /** The paper world's seed: a fixed function of the run and the mint, so a rescore gives the same trade. */
  readonly seed: string;
}

export interface CounterfactualTrade {
  readonly mint: string;
  /** Entered as if the live-only checks did not exist; false: the strategy would not have entered anyway. */
  readonly entered: boolean;
  readonly enteredAtMs: number | null;
  readonly closedAtMs: number | null;
  /** Lamports paid for the entry, fees included. */
  readonly cost: bigint | null;
  /** Net lamports of the whole trade (exit proceeds less every fee and the entry). */
  readonly net: bigint | null;
  /** net / cost: the same net return the kept trades are measured by. */
  readonly r: number | null;
  /** Entered but not closed when the recording ends: its outcome is not known. */
  readonly censored: boolean;
  /** Why it is censored (null when it is not): never imputed, G3 reports it as "not proven: extend the run". */
  readonly censoredReason: string | null;
  readonly exitReasons: readonly string[];
  /** Validity checks the report refuses on: events the scoring book or ledger refused, positions in other mints, and
   *  the paper seed the scoring worker ran (its `start` line). */
  readonly check: { readonly refused: number; readonly otherPositions: number; readonly paperSeed: string | null };
}

/** Keys of the run's own state on its feed: the scoring worker makes its own. */
const OWN_KEYS: ReadonlySet<string> = new Set([ACCOUNT_KEY, HALT_KEY, RESTORE_KEY]);

/** Timers that fire only when the driver moves the clock past them. */
const dueTimers = (start: number): Timers & { set(ms: number): void } => {
  let now = start;
  let next = 1;
  const due = new Map<number, { readonly at: number; readonly fn: () => void }>();
  return {
    now: () => now,
    set: (ms) => {
      if (ms > now) now = ms;
      for (const [id, t] of [...due].sort((x, y) => x[1].at - y[1].at || x[0] - y[0])) {
        if (t.at > now || !due.delete(id)) continue;
        t.fn();
      }
    },
    setTimeout: (fn, ms): TimerHandle => {
      const id = next++;
      due.set(id, { at: now + Math.max(0, ms), fn });
      return { id };
    },
    clearTimeout: (h) => void due.delete(h.id),
  };
};

/** Scores one vetoed candidate. Never touches the run's state directory. */
export const scoreCounterfactual = async (o: CounterfactualInput): Promise<CounterfactualTrade> => {
  const dir = mkdtempSync(join(tmpdir(), 'zeroed-g3-'));
  try {
    const parsed = parseConfig({ ZEROED_STATE_DIR: dir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'off', ZEROED_SIMULATE: 'off', ZEROED_GIT_SHA: 'counterfactual' }, () => null);
    if (!parsed.ok) throw new Error(parsed.message);
    const first = o.frames[0]?.receivedAt ?? 0;
    const timers = dueTimers(first);
    const worker = new Worker({
      config: parsed.config, session: o.session, rugs: o.rugs,
      strategy: { ...o.strategy, gateMode: 'backtest', only: o.mint },
      scenario: o.scenario, network: o.network, timers,
      sources: () => [],
      simulate: () => Promise.reject(new Error('simulation is off in the counterfactual')),
      fetchTx: async () => false,
      seed: async () => ({ mode: 'none', creates: [], coverage: [], report: 'counterfactual: the run\'s recorded seed is replayed' }),
      seedWaitMs: 0,
      heartbeat: { http: async () => { throw new Error('no network in the counterfactual'); }, key: null, ownerChatId: null },
      reconcileTimeoutMs: 60_000, loopMs: 100, staleFeedMs: 10_000, log: () => undefined,
      paperSeed: o.seed,
    });
    // The start reconcile waits on the worker's timers: move the clock while it runs.
    let settled: Awaited<ReturnType<Worker['reconcile']>> | null = null;
    const reconciling = worker.reconcile().then((x) => void (settled = x));
    for (let k = 0; settled === null && k < 10_000; k++) {
      timers.set(timers.now() + 100);
      await new Promise<void>((done) => setImmediate(done));
    }
    await reconciling;
    const r = settled as unknown as Awaited<ReturnType<Worker['reconcile']>>;
    if (!r.ok) throw new Error(`counterfactual worker did not reconcile: ${r.message}`);
    let stepped = first;
    for (const f of o.frames) {
      const b = f.body;
      if (b.type === 'world') continue;
      if ((b.type === 'fact' || b.type === 'offchain') && OWN_KEYS.has(b.key)) continue;
      timers.set(f.receivedAt);
      worker.feed.ingest(f.source, b, { receivedAt: f.receivedAt, ...(f.backfilled ? { backfilled: true } : {}) });
      if (f.receivedAt - stepped >= 100) {
        worker.step();
        stepped = f.receivedAt;
      }
    }
    // Everything recorded is released: the feed's stale release lets the last frames through.
    for (let k = 0; k < 50; k++) {
      timers.set(timers.now() + 100);
      worker.step();
    }
    const book = worker.book;
    const position = Object.values(book.positions).find((p) => p.mint === o.mint);
    const trade = worker.apiInputs().trades.find((t) => t.mint === o.mint);
    const check = {
      refused: worker.desk.illegal + worker.desk.ledgerRefusals,
      otherPositions: Object.values(book.positions).filter((p) => p.mint !== o.mint).length,
      paperSeed: (() => {
        const first = readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n')[0];
        const v = first === undefined || first === '' ? null : (JSON.parse(first) as Record<string, unknown>)['seed'];
        return typeof v === 'string' ? v : null;
      })(),
    };
    await worker.stop();
    const none = { mint: o.mint, entered: false, enteredAtMs: null, closedAtMs: null, cost: null, net: null, r: null, censored: false, censoredReason: null, exitReasons: [], check };
    if (position === undefined) return none;
    const entry = book.intents[position.entryIntentId];
    const cost = entry === undefined ? null : entry.fills.reduce((t, f) => t + f.sol + f.fees, 0n);
    if (entry === undefined || cost === null || cost === 0n) return none;
    const closed = position.status === 'closed' && trade !== undefined && trade.closedAtMs !== null && trade.netLamports !== null;
    return {
      mint: o.mint, entered: true, enteredAtMs: trade?.openedAtMs ?? null, closedAtMs: closed ? trade!.closedAtMs : null, cost,
      net: closed ? trade!.netLamports : null, r: closed ? Number(trade!.netLamports) / Number(cost) : null, censored: !closed,
      censoredReason: closed ? null : `position ${position.status} when the recording ends (last frame ${o.frames.at(-1)?.receivedAt ?? 'none'}): the pool's state after it was not recorded`, exitReasons: closed ? [...(trade!.exitReasons ?? [])] : [], check,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
