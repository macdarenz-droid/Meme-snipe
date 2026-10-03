// Outcome stage of signal research (RES-3, docs/research/signals.md §4). It runs after the feature stage, on a second
// pass over the same practice rows, and the feature stage never imports it (a test checks this). It sees only a
// candidate's id, pool, decision moment and SOL/USD, never its features.
//
// Per candidate: the entry is quoted on the pool at the decision slot and lands `landing` slots later on the pool as
// it stands then (one attempt, the scenario's land probability and extra slippage); after it, every real swap of the
// pool is replayed through ShiftedPool (our trade moves the pool), giving the executable value of selling the whole
// position. STATS-1's execution-aware triple barrier labels that path.
import { createHash } from 'node:crypto';
import type { CoinFlags } from '../../../core/src/amm/index.ts';
import { poolBuyExactQuoteIn, poolSell } from '../../../core/src/amm/index.ts';
import type { FillConfig, Policy } from '../../../core/src/config/index.ts';
import { createRng as engineRng } from '../../../core/src/engine/index.ts';
import { type ObservedFees, type ScenarioName, ShiftedPool, drawAttempt, executeBuy, observedFeeContext, withSlippage } from '../../../core/src/fills/index.ts';
import { createRng, labelTripleBarrier, type TripleBarrierLabel, type ValuePoint } from '../../../core/src/stats/index.ts';
import { BPS_DENOMINATOR, mulDiv } from '../../../core/src/units/index.ts';
import type { AmmSwapRow, DatasetRow } from '../dataset/rows.ts';
import { guardRows, type PracticeWindow } from './practice.ts';

const NORMAL: CoinFlags = { mayhemMode: false, transferFee: false, transferHook: false };
const MIN = 60_000;

export interface Barrier {
  readonly cfgId: string;
  readonly takeProfitBps: number;
  readonly stopLossBps: number;
  readonly horizonMs: number;
  /** Universes the barrier applies to (all when absent). */
  readonly universes?: readonly ('U1' | 'U2')[];
}

/** The plan's barriers (signals.md §4). B2 has no take-profit in reach and a stop at −100%. */
export const PLAN_BARRIERS: readonly Barrier[] = [
  { cfgId: 'B1_tp50_sl20_h120m', takeProfitBps: 5000, stopLossBps: 2000, horizonMs: 120 * MIN },
  { cfgId: 'B2_time_h120m', takeProfitBps: 1_000_000_000, stopLossBps: 10_000, horizonMs: 120 * MIN },
  { cfgId: 'B3_tp30_sl15_h60m', takeProfitBps: 3000, stopLossBps: 1500, horizonMs: 60 * MIN },
  // Added before any data (signals.md §8, supervisor 2026-10-04): U1's own exit, risk.md S2's T_max of 4 h (CFG-2).
  { cfgId: 'B4_u1_time_h240m', takeProfitBps: 1_000_000_000, stopLossBps: 10_000, horizonMs: 240 * MIN, universes: ['U1'] },
];

/** Whether a barrier applies to a universe. */
export const appliesTo = (b: Barrier, u: 'U1' | 'U2'): boolean => b.universes === undefined || b.universes.includes(u);

export interface ScoreTarget {
  readonly id: string;
  readonly pool: string;
  readonly decisionSlot: bigint;
  readonly decisionMs: number;
  readonly solUsd: number;
}

export interface OutcomeOptions {
  readonly window: PracticeWindow;
  readonly policy: Policy;
  readonly fills: FillConfig;
  readonly scenario: ScenarioName;
  readonly barriers: readonly Barrier[];
  readonly seed: string;
  /** Least accepted entry output below the decision quote (research config `s0.entryMinOutBelowBps`). */
  readonly entryMinOutBelowBps: number;
}

export interface Outcome {
  readonly id: string;
  readonly scenario: ScenarioName;
  /** Lamports committed on entry with every buy-side cost (0 when the entry did not fill). */
  readonly entryCost: bigint;
  /** No quote at the decision: the bot would not sign, so the decision is not a trade (left out of every mean). */
  readonly noQuote: boolean;
  readonly labels: readonly TripleBarrierLabel[];
}

interface Pending {
  readonly t: ScoreTarget;
  phase: 'quote' | 'enter' | 'hold' | 'done';
  quotedOut: bigint;
  entrySlot: bigint;
  entryMs: number;
  shifted: ShiftedPool | null;
  tokens: bigint;
  cost: bigint;
  failedEntry: bigint;
  filled: boolean;
  noQuote: boolean;
  path: ValuePoint[];
  /** Slot at which block time first reached entry + each barrier's horizon. */
  vertical: (bigint | null)[];
  fees: ObservedFees | null;
  baseSupply: bigint;
}

const seedOf = (s: string): number => Number.parseInt(createHash('sha256').update(s).digest('hex').slice(0, 12), 16);

export const scoreCandidates = (rows: Iterable<DatasetRow>, targets: readonly ScoreTarget[], o: OutcomeOptions): Outcome[] => {
  const scen = o.fills.scenarios[o.scenario];
  const net = o.fills.network;
  const ladder = o.policy.exits.ladder;
  const landing = BigInt(Math.max(...scen.landingSlots));
  const latency = Math.max(...scen.landingSlots);
  const base = net.signaturesPerTx * net.baseFeePerSignature;
  const exitFixed = base + ladder.steps[0]!.priorityFeeLamports + net.tip;
  // One cost for every failed exit attempt: the third rung's priority fee, above the first two (conservative bound).
  const failedExit = base + ladder.steps[Math.min(2, ladder.steps.length - 1)]!.priorityFeeLamports;
  const failProbability = 1 - Number(scen.landPpm.pumpswap) / 1e6;
  const rent = net.tokenAccountRent;
  const maxHorizon = Math.max(...o.barriers.map((b) => b.horizonMs));
  // Time after the horizon for the exit ladder, at 1 s per slot: conservative, since slots run ~0.27–0.4 s (more slots fit).
  const tail = (ladder.maxAttempts + 1) * latency * 1000;

  const byPool = new Map<string, Pending[]>();
  const all: Pending[] = [];
  /** Candidates whose decision slot has passed and that are not done; the rest wait in `all` by decision slot. */
  let active: Pending[] = [];
  let next = 0;
  for (const t of targets) {
    const p: Pending = {
      t, phase: 'quote', quotedOut: 0n, entrySlot: t.decisionSlot + landing, entryMs: 0, shifted: null, tokens: 0n, cost: 0n, failedEntry: 0n,
      filled: false, noQuote: false, path: [], vertical: o.barriers.map(() => null), fees: null, baseSupply: 0n,
    };
    all.push(p);
    const list = byPool.get(t.pool) ?? [];
    list.push(p);
    byPool.set(t.pool, list);
  }
  all.sort((a, b) => (a.t.decisionSlot < b.t.decisionSlot ? -1 : a.t.decisionSlot > b.t.decisionSlot ? 1 : 0));
  const lastSwap = new Map<string, AmmSwapRow>();
  const realState = new Map<string, ShiftedPool>();
  const out = new Map<string, Outcome>();

  const value = (p: Pending): bigint | null => {
    const s = p.shifted!.state;
    if (s === null || p.fees === null) return null;
    const q = poolSell(s, p.tokens, observedFeeContext(p.fees, p.baseSupply, NORMAL));
    if (!q.ok) return null;
    const v = q.trade.userQuote - exitFixed + (scen.rentRecovery ? rent : 0n);
    return v > 0n ? v : 0n;
  };
  const point = (p: Pending, slot: bigint): void => {
    const v = value(p);
    const s = Number(slot);
    const last = p.path[p.path.length - 1];
    // Several swaps in one slot: the slot's close counts.
    if (last !== undefined && last.slot === s) p.path[p.path.length - 1] = { slot: s, value: v };
    else p.path.push({ slot: s, value: v });
  };

  const finish = (p: Pending, observedThrough: bigint): void => {
    p.phase = 'done';
    const entrySlot = Number(p.entrySlot);
    const labels = o.barriers.map((b, i) => {
      // The same exit-attempt draws for every barrier (common random numbers), so barriers differ only by their rule.
      const rng = createRng(seedOf(`${o.seed}:${p.t.id}:exit`));
      const cost = p.filled ? p.cost : 1n;
      const vert = p.vertical[i];
      // Without a slot at the horizon the window was not fully seen: a horizon past the data, censored by the labeller.
      const horizonSlots = vert === null || vert === undefined ? Math.max(1, Number(observedThrough) - entrySlot + 1) : Math.max(1, Number(vert) - entrySlot);
      const path = p.path.filter((x) => x.slot > entrySlot && x.slot <= Number(observedThrough));
      const label = labelTripleBarrier({
        entry: { filled: p.filled, slot: entrySlot, cost: p.filled ? cost : spendOf(p), failedCost: p.failedEntry },
        path, observedThroughSlot: Math.max(entrySlot, Number(observedThrough)), barrier: { cfgId: b.cfgId, takeProfitBps: b.takeProfitBps, stopLossBps: b.stopLossBps, horizonSlots },
        exit: { latencySlots: latency, retrySlots: latency, maxAttempts: ladder.maxAttempts, failProbability, failedAttemptCost: failedExit },
        rng,
      });
      return p.filled ? exitSlippage(label, path, cost, scen.slippagePpm) : label;
    });
    out.set(p.t.id, { id: p.t.id, scenario: o.scenario, entryCost: p.filled ? p.cost : 0n, noQuote: p.noQuote, labels });
  };
  // The notional a failed entry is measured against.
  const spendOf = (p: Pending): bigint => {
    const s = BigInt(Math.floor((Number(o.policy.capital.minNotional) / 1e6 / p.t.solUsd) * 1e9));
    return s > 1n ? s : 2n;
  };

  let lastSlot = -1n;
  for (const row of guardRows(o.window, rows)) {
    lastSlot = row.slot;
    if (row.kind === 'amm') {
      const list = byPool.get(row.pool);
      if (list === undefined) continue;
      let real = realState.get(row.pool);
      if (real === undefined) {
        real = new ShiftedPool();
        realState.set(row.pool, real);
      }
      real.applyReal(row);
      lastSwap.set(row.pool, row);
      for (const p of list) {
        if (p.phase !== 'hold') continue;
        p.shifted!.applyReal(row);
        p.fees = row.fees;
        p.baseSupply = row.baseSupply;
        point(p, row.slot);
      }
      continue;
    }
    if (row.kind !== 'block') continue;
    const ms = row.blockTime * 1000;
    while (next < all.length && all[next]!.t.decisionSlot <= row.slot) active.push(all[next++]!);
    for (const p of active) {
      if (p.phase === 'done') continue;
      if (p.phase === 'quote' && row.slot >= p.t.decisionSlot) {
        const sw = lastSwap.get(p.t.pool);
        const s = realState.get(p.t.pool)?.state ?? null;
        const spend = spendOf(p);
        const q = sw === undefined || s === null ? null : poolBuyExactQuoteIn(s, spend, observedFeeContext(sw.fees, sw.baseSupply, NORMAL));
        if (q === null || !q.ok) {
          // No quote at the decision: the bot would not sign; nothing is spent and the decision has no trade.
          p.noQuote = true;
          finish(p, row.slot);
          continue;
        }
        p.quotedOut = q.trade.base;
        p.phase = 'enter';
      }
      if (p.phase === 'enter' && row.slot >= p.entrySlot) {
        const sw = lastSwap.get(p.t.pool)!;
        const spend = spendOf(p);
        const fate = drawAttempt(engineRng(`${o.seed}:${p.t.id}:entry`), scen, 'pumpswap').fate;
        const shifted = new ShiftedPool();
        shifted.applyReal(sw);
        const s = realState.get(p.t.pool)!.state;
        const failFee = base + net.entryPriorityFee;
        const minOut = mulDiv(p.quotedOut, BPS_DENOMINATOR - BigInt(o.entryMinOutBelowBps), BPS_DENOMINATOR, 'floor');
        const ex = s === null || fate !== 'lands' ? null
          : executeBuy({ pool: s, fees: sw.fees, baseSupply: sw.baseSupply, coin: NORMAL, quotedOut: p.quotedOut, minOut, slippagePpm: scen.slippagePpm }, spend);
        p.entrySlot = row.slot;
        p.entryMs = ms;
        if (ex === null || !ex.ok) {
          p.filled = false;
          p.failedEntry = fate === 'dropped' ? 0n : failFee;
          finish(p, row.slot);
          continue;
        }
        // Shift the copy to the real state as of now, then put our trade in.
        if (shifted.state !== null) shifted.applyOurs(ex.after);
        p.shifted = shifted;
        p.fees = sw.fees;
        p.baseSupply = sw.baseSupply;
        p.tokens = ex.out;
        p.cost = ex.paid + failFee + net.tip + rent;
        p.filled = true;
        p.phase = 'hold';
        point(p, row.slot + 1n);
        continue;
      }
      if (p.phase === 'hold') {
        o.barriers.forEach((b, i) => {
          if (p.vertical[i] === null && ms >= p.entryMs + b.horizonMs) p.vertical[i] = row.slot;
        });
        if (ms >= p.entryMs + maxHorizon + tail) finish(p, row.slot);
      }
    }
    if (active.some((p) => p.phase === 'done')) active = active.filter((p) => p.phase !== 'done');
  }
  for (const p of all) if (p.phase !== 'done') finish(p, lastSlot);
  return targets.map((t) => out.get(t.id)!);
};

/** Conservative extra slippage on the exit: the shortfall between the value at the touch and at the fill, scaled. */
const exitSlippage = (l: TripleBarrierLabel, path: readonly ValuePoint[], cost: bigint, ppm: bigint): TripleBarrierLabel => {
  if (l.rNet === null || l.touchSlot === null || l.exitSlot === null || ppm === 1_000_000n) return l;
  const at = (slot: number): bigint => {
    let v: bigint | null = null;
    for (const x of path) {
      if (x.slot > slot) break;
      v = x.value;
    }
    return v ?? 0n;
  };
  const filled = at(l.exitSlot);
  const lost = filled - withSlippage(filled, at(l.touchSlot), ppm);
  if (lost <= 0n) return l;
  const rNet = l.rNet - Number(lost) / Number(cost);
  return { ...l, rNet, yMeta: rNet > 0 ? 1 : 0, ySevere: rNet <= -0.5 || l.blocked ? 1 : 0 };
};
