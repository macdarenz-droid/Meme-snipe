// RED TEAM 2 / H14 parity: the on-demand rug check (RUG-1c) counts a rug that happened BEFORE the 14-day look-back.
//
// Scenario. A deployer's prior mint "Edge" launched 14 d 1 h before the decision (inside the check's reach, because
// `rugCheckFromMs` reaches one rug window, 1 day, behind the look-back) and was dumped 30 min after launch, i.e.
// 14 d 30 min before the decision: outside the fixed 14-day look-back (ARCHITECTURE §7.1 H14: "a prior rug within the
// fixed 14-day lookback ... the same window live and in the backtest").
// - Stream path (the backtest: `backtest/src/sim/facts.ts` emits coverage:rugs:start and the labeller's `rug:` labels):
//   hard.ts:551 keeps a label only when `knownAtMs >= now - lookback`, so H14 passes the deployer.
// - Check path (live: main.ts runs tradeStreams false, so no coverage:rugs:* exists and every H14 goes through the
//   check): `deployerCheckCovers` (core/src/gates/deployer-check.ts:145) returns every `status: 'rug'` mint, and
//   hard.ts:543/551 adds them with no time filter, so H14 rejects `prior-rug`.
// Realism: DECISIONS measured 86% of prior mints labelled, 31 of 32 within 1 h of launch, so a deployer with a mint
// launched in that last day before the look-back is common; every such candidate is decided differently live and in
// the backtest (live rejects a coin the backtest would trade). Expected (correct): both paths give the same verdict.
import { describe, expect, it } from 'vitest';
import { OFF_CHAIN, type MarketEvent, type Moment } from '../../../core/src/engine/index.ts';
import {
  AsOfStore, SimClock,
} from '../../../core/src/engine/index.ts';
import {
  DAY_MS, HOUR_MS, MINUTE_MS, DeployerIndex, deployerKey, evaluateHardRejects, rugCheckKey, type GateContext, type GateReason, type RugCheckFact,
} from '../../../core/src/gates/index.ts';
import { DEV, NOW, SLOT, T, deps, drop, passingFacts, request, type Facts } from '../../../core/test/gates/world.ts';

type Row = readonly [string, unknown, Moment];
const at = (receivedAt: number, slot: bigint): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt });
const wrap = (value: unknown) => ({ value, source: 'worker', backfilled: false, seq: 1 });
const ctxWith = (rows: readonly Row[], base: Facts, idx: DeployerIndex): GateContext => {
  const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
  const store = new AsOfStore(clock);
  const all: Row[] = [...[...base].map(([k, { value, moment }]) => [k, value, moment] as Row), ...rows];
  all.sort((a, b) => (a[2].slot < b[2].slot ? -1 : a[2].slot > b[2].slot ? 1 : a[2].receivedAt - b[2].receivedAt));
  for (const [k, v, m] of all) {
    clock.advanceTo(m);
    store.record(k, v, m, `${k}@${m.slot}`);
  }
  clock.advanceTo(NOW);
  return { now: NOW, observedTip: NOW.slot, lookup: (k, a) => store.lookup(k, a), history: (k, f, t) => store.history(k, f, t), deployers: idx };
};
const market = (key: string, value: unknown, moment: Moment): MarketEvent => ({ kind: 'market', id: key, moment, key, value });
const create = (mint: string, ms: number, slot: bigint) => ({
  event: { name: 'CreateEvent', program: 'pump', data: { mint, creator: DEV, timestamp: BigInt(ms / 1_000), name: 'x', symbol: 'x', uri: '' } },
  signature: `sig-${mint}`, txSlot: slot, truncated: false, via: 'logs:creates', source: 'helius', backfilled: false, seq: 1,
});

const LAUNCH = T - 14 * DAY_MS - HOUR_MS;
const DUMP = LAUNCH + 30 * MINUTE_MS; // 14 d 30 min before the decision: before the look-back start (T - 14 d)
const slotAt = (ms: number) => SLOT - BigInt(Math.ceil((T - ms) / 400));

const index = (withLabel: boolean): DeployerIndex => {
  const idx = new DeployerIndex();
  idx.observe(market('coverage:creates:start', wrap({ fromSlot: SLOT - 7_000_000n, via: 'logs:creates' }), at(T - 30 * DAY_MS, SLOT - 7_000_000n)));
  idx.observe(market('logs:pump:CreateEvent:Edge', create('Edge', LAUNCH, slotAt(LAUNCH)), at(LAUNCH, slotAt(LAUNCH))));
  // The stream labeller's label, dated (as RUG-1 dates it) at the dump's moment.
  if (withLabel) idx.observe(market('rug:Edge', { mint: 'Edge', creator: DEV, rule: 'creator-dump', evidence: 'observed' }, at(DUMP, slotAt(DUMP))));
  return idx;
};
const h14 = (r: { reasons: readonly GateReason[] }) => r.reasons.filter((x) => x.gate === 'H14' || x.neededBy === 'H14');

describe('RT2-H14a: rug-check vs rug-stream window parity', () => {
  it('a rug dated before the 14-day look-back gives the same H14 verdict from the check (live) as from the stream (backtest)', () => {
    // Backtest-like: rug stream covered (passingFacts has coverage:rugs:start 30 days ago), label from the labeller.
    const stream = evaluateHardRejects(ctxWith([], drop(passingFacts(), deployerKey(DEV)), index(true)), deps('live'), request(), { stopAtFirst: false });
    // Live-like: no rug stream; a fresh, complete on-demand check that found Edge's dump.
    const label = { mint: 'Edge', creator: DEV, rule: 'creator-dump', evidence: 'observed', atMs: DUMP, slot: slotAt(DUMP), version: 'rugs-2', detail: '', venue: 'curve', amounts: { sold: 1n, supply: 1n } };
    const fact: RugCheckFact = {
      obs: { provider: 'rug-check', slot: SLOT - 10n, receivedAt: T - 1_000, quality: [], commitment: 'confirmed' },
      creator: DEV, version: 'rug-check-1', fromMs: T - 15 * DAY_MS, asOfMs: T - 5_000, credits: 3,
      mints: [{ mint: 'Edge', createdAtMs: LAUNCH, status: 'rug', detail: 'creator-dump', label: label as never }],
    };
    const noStream = drop(drop(passingFacts(), deployerKey(DEV)), 'coverage:rugs:start');
    const check = evaluateHardRejects(ctxWith([[rugCheckKey(DEV), wrap(fact), at(T - 1_000, SLOT - 10n)]], noStream, index(false)), deps('live'), request(), { stopAtFirst: false });

    // Control: the stream path does not count a rug from before the look-back.
    expect(h14(stream)).toEqual([]);
    // The check path must agree (fails on 959d801: H14 prior-rug "rugged Edge (creator-dump) within 14 days").
    expect(h14(check)).toEqual([]);
  });
});
