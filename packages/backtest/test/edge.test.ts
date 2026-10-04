// RES-4 (docs/research/edge.md): the committed cost table reproduces from the code, and the pre-registration is
// well-formed, uses only as-of features, and copies the policy's exits exactly.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { BRACKETS, breakEvenWinRate, costRow, rows, SETUPS, terms } from '../src/research/edge-costs.ts';
import { replaySwap, observedFeeContext, withSlippage } from '../../core/src/fills/index.ts';
import { poolBuyExactQuoteIn, poolSell } from '../../core/src/amm/index.ts';
import { pumpSwapRoundTrip } from '../../core/src/costs/index.ts';
import type { AmmSwapRow, DatasetRow } from '../src/dataset/rows.ts';
import { collectCandidates, PLAN_DRIVE, solUsdAsOf } from '../src/research/candidates.ts';
import { PLAN_BARRIERS, scoreCandidates } from '../src/research/outcome.ts';
import type { PracticeWindow } from '../src/research/practice.ts';
import { SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const synth = syntheticRows({ mints: 1, slots: 2.5 * 3600 * 6 });
import { FEATURE_IDS } from '../src/research/tracker.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('cost math', () => {
  const committed = JSON.parse(read('research/edge/costs.json')) as { rows: ReturnType<typeof rows> };
  const now = rows();

  test('the committed table is what the code computes now; only PumpSwap setups are scored', () => {
    expect(SETUPS.map((x) => x.id)).toEqual(['young', 'u1', 'u1-1.15']);
    expect(now.length).toBe(SETUPS.length * 3);
    for (const [i, r] of now.entries()) {
      const c = committed.rows[i]!;
      expect(c.setup).toBe(r.setup);
      expect(c.fixedLamports).toBe(r.fixedLamports);
      expect(c.breakEvenPct).toBeCloseTo(r.breakEvenPct, 9);
    }
  });

  test('fixed costs are the outcome stage\'s: landed legs, failed exits on the ladder at rung 3, RENT-1 rent and failed close', () => {
    const net = FILL_CONFIG.network;
    const s = FILL_CONFIG.scenarios.conservative;
    const steps = TRIAL_POLICY.exits.ladder.steps;
    const base = Number(net.signaturesPerTx * net.baseFeePerSignature);
    const f = 1 - Number(s.landPpm.pumpswap) / 1e6;
    let failures = 0;
    for (let k = 1; k <= TRIAL_POLICY.exits.ladder.maxAttempts; k++) failures += f ** k;
    const failed = base + Number(steps[2]!.priorityFeeLamports);
    const close = Number(s.closeSuccessPpm) / 1e6;
    const dust = Number(s.dustPpm) / 1e6;
    const expected = (base + Number(net.entryPriorityFee) + Number(net.tip)) + (base + Number(steps[0]!.priorityFeeLamports) + Number(net.tip))
      + failures * failed + (1 - close * (1 - dust)) * Number(net.tokenAccountRent) + (1 - close) * (1 - dust) * failed;
    for (const r of now) expect(r.fixedLamports).toBe(Math.round(expected));
  });

  // No swap after 50 min: every entry and exit trades on the same pool, so −r_net × cost is fees, impact and fixed costs only.
  // Built on first use, inside a test's time limit.
  let fx: ReturnType<typeof fixture> | undefined;
  const fixture = () => {
    const still = synth.filter((r) => r.kind !== 'amm' || r.blockTime * 1000 < T0 + 50 * 60_000);
    const win: PracticeWindow = { decisionFrom: '2026-09-19', decisionTo: '2026-10-01', holdoutFrom: '2026-09-25', embargoDays: 1, confirmedBy: 'test' };
    const c = collectCandidates(still, { window: win, policy: TRIAL_POLICY, solUsd: solUsdAsOf(SOL_USD, 3 * 3_600_000), ...PLAN_DRIVE }).candidates[0]!;
    const sw = still.filter((r): r is AmmSwapRow => r.kind === 'amm' && r.pool === c.pool).at(-1)!;
    const st = replaySwap(sw.pre, sw);
    if (!st.ok) throw new Error('fixture swap does not replay');
    const spend = BigInt(Math.floor((Number(TRIAL_POLICY.capital.minNotional) / 1e6 / c.solUsd) * 1e9));
    const row = costRow('fixture', 2, 120, st.trade.after, observedFeeContext(sw.fees, sw.baseSupply, { mayhemMode: false, transferFee: false, transferHook: false }), spend);
    // The table's exit sells at the pre-entry price (pumpSwapRoundTrip: our entry impact never comes back); on a still
    // pool the outcome stage sells into the pool our buy left, which hands part of that impact back. Exact, in lamports,
    // and computed apart from costRow, so costRow's fee and impact terms are checked too (review C1c).
    const ctx = observedFeeContext(sw.fees, sw.baseSupply, { mayhemMode: false, transferFee: false, transferHook: false });
    const rt = pumpSwapRoundTrip(st.trade.after, ctx)(spend);
    if (!rt.ok) throw new Error('fixture round trip does not quote');
    const tableImpact = rt.trade.entryImpact + rt.trade.exitImpact;
    const buy = poolBuyExactQuoteIn(st.trade.after, spend, ctx);
    if (!buy.ok) throw new Error('fixture buy does not quote');
    const sell = poolSell(buy.trade.after, buy.trade.base, ctx);
    if (!sell.ok) throw new Error('fixture sell does not quote');
    const givenBack = (rt.trade.paid - rt.trade.proceeds) - (buy.trade.userQuote - sell.trade.userQuote);
    const fees = rt.trade.entryFees + rt.trade.exitFees;
    return { still, win, c, row, givenBack, fees, tableImpact, sw, st, spend, ctx, buy: buy.trade };
  };
  /** Each filled, scored candidate's loss in lamports (−r_net × entry cost), from the outcome stage under `fills`. */
  const lossesUnder = (n: number, fills: typeof FILL_CONFIG): number[] => {
    const { still, win, c } = (fx ??= fixture());
    const targets = Array.from({ length: n }, (_, i) => ({ id: `${c.id}#${i}`, pool: c.pool, decisionSlot: c.decisionSlot, decisionMs: c.decisionMs, solUsd: c.solUsd }));
    const out = scoreCandidates(still, targets, { window: win, policy: TRIAL_POLICY, fills, scenario: 'conservative', barriers: PLAN_BARRIERS.slice(1, 2), seed: 'parity', entryMinOutBelowBps: RESEARCH_CONFIG.s0.entryMinOutBelowBps });
    return out.filter((o) => o.labels[0]!.entryFilled && o.labels[0]!.rNet !== null).map((o) => -o.labels[0]!.rNet! * Number(o.entryCost));
  };

  test('parity: on a still pool the outcome stage\'s mean loss equals the cost math, within its sampling error', () => {
    const losses = lossesUnder(2000, FILL_CONFIG);
    const { row } = fx!;
    expect(losses.length).toBeGreaterThan(800);
    const mean = losses.reduce((a, b) => a + b, 0) / losses.length;
    const sd = Math.sqrt(losses.reduce((a, b) => a + (b - mean) ** 2, 0) / (losses.length - 1));
    const expected = row.proportional + row.fixedLamports;
    expect(Math.abs(mean - expected)).toBeLessThan(4 * (sd / Math.sqrt(losses.length)));
    // And the same in break-even terms: the mean loss over what was paid is the break-even move.
    expect(Math.abs((100 * mean) / row.paid - row.breakEvenPct)).toBeLessThan((400 * sd) / Math.sqrt(losses.length) / row.paid);
  }, 120_000);

  // Exact parity (review C1b): with the scenario's draws forced, every trade pays the same, so the outcome stage's loss must
  // equal the cost math to the lamport. Each case isolates terms the sampled test above cannot see: the exit tip, the
  // failed-close fee, the rent and the dust rule. A change to either side alone fails here.
  const cons = FILL_CONFIG.scenarios.conservative;
  const forced = (closeSuccessPpm: bigint, dustPpm: bigint): typeof FILL_CONFIG => ({
    ...FILL_CONFIG,
    scenarios: { ...FILL_CONFIG.scenarios, conservative: { ...cons, landPpm: { ...cons.landPpm, pumpswap: 1_000_000n }, closeSuccessPpm, dustPpm } },
  });
  const landed = terms.entryLanded + terms.exitFixed;
  test.each([
    { name: 'every attempt lands, the close lands, no dust: rent back', close: 1_000_000n, dust: 0n, fixed: landed },
    { name: 'the close always fails without dust: rent kept plus one failed exit', close: 0n, dust: 0n, fixed: landed + terms.rent + terms.failedExit },
    { name: 'every account gets dust: rent kept, no failed-close fee', close: 1_000_000n, dust: 1_000_000n, fixed: landed + terms.rent },
  ])('exact parity, zero variance: $name', ({ close, dust, fixed }) => {
    const losses = lossesUnder(20, forced(close, dust));
    expect(losses.length).toBe(20);
    const { row, givenBack, fees, tableImpact } = fx!;
    // The table's proportional cost is both legs' fees and impact exactly; the still pool hands back part of the impact,
    // never more than all of it, and over 90% of it on this fixture.
    expect(BigInt(row.proportional)).toBe(fees + tableImpact);
    expect(givenBack).toBeGreaterThanOrEqual(0n);
    expect(givenBack).toBeLessThanOrEqual(tableImpact);
    expect((tableImpact - givenBack) * 10n).toBeLessThan(tableImpact);
    const expected = BigInt(row.proportional) - givenBack + fixed;
    for (const l of losses) expect(BigInt(Math.round(l))).toBe(expected);
  }, 60_000);

  // Review C1d: the two outcome-stage terms the cases above cannot see, each forced to a known value.
  const scoreUnder = (rowsIn: readonly DatasetRow[], n: number, fills: typeof FILL_CONFIG) => {
    const { win, c } = (fx ??= fixture());
    const targets = Array.from({ length: n }, (_, i) => ({ id: `${c.id}#${i}`, pool: c.pool, decisionSlot: c.decisionSlot, decisionMs: c.decisionMs, solUsd: c.solUsd }));
    return scoreCandidates(rowsIn, targets, { window: win, policy: TRIAL_POLICY, fills, scenario: 'conservative', barriers: PLAN_BARRIERS.slice(1, 2), seed: 'parity', entryMinOutBelowBps: RESEARCH_CONFIG.s0.entryMinOutBelowBps });
  };
  const withScenario = (o: Partial<typeof cons>): typeof FILL_CONFIG => ({ ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, conservative: { ...cons, ...o } } });

  test.each([
    { name: 'every entry fails on chain: it pays base and entry priority, no tip', dropPpm: 0n, fee: terms.entryLanded - FILL_CONFIG.network.tip },
    { name: 'every entry is dropped: it never reaches a block and costs nothing', dropPpm: 1_000_000n, fee: 0n },
  ])('failed entries, forced: $name', ({ dropPpm, fee }) => {
    const out = scoreUnder((fx ??= fixture()).still, 20, withScenario({ landPpm: { ...cons.landPpm, pumpswap: 0n }, dropPpm }));
    const { spend } = fx!;
    expect(out.length).toBe(20);
    for (const o of out) {
      const l = o.labels[0]!;
      expect(o.entryCost).toBe(0n);
      expect(l.entryFilled).toBe(false);
      // The labeller's r_net of an unfilled entry: −failed cost ÷ the notional it was measured against.
      expect(l.rNet).toBe(-Number(fee) / Number(spend));
    }
  }, 60_000);

  test('exit slippage, forced landing on a moving pool: r_net falls by the shortfall between touch and fill, scaled by slippagePpm − 1e6', () => {
    const { still, sw, st, ctx, buy, c } = (fx ??= fixture());
    // Entry lands decisionSlot + landing slots later on the still pool (no shortfall at entry), and the time barrier
    // touches at the first block at or past entry + its horizon; the exit fills `landing` slots after that.
    const landing = BigInt(Math.max(...cons.landingSlots));
    const blocks = still.filter((r) => r.kind === 'block');
    const entryBlock = blocks.find((r) => r.slot >= c.decisionSlot + landing)!;
    const touch = blocks.find((r) => r.blockTime * 1000 >= entryBlock.blockTime * 1000 + PLAN_BARRIERS[1]!.horizonMs)!.slot;
    // One real sell between the touch and the fill drops the value the exit gets.
    const dump: AmmSwapRow = { ...sw, slot: touch + 3n, blockTime: blocks.find((r) => r.slot === touch + 3n)!.blockTime, signature: `${sw.signature}-dump`, side: 'sell', mode: 'exact-base', ixName: 'sell', amount: 20_000_000_000_000n, pre: st.trade.after };
    if (!replaySwap(dump.pre, dump).ok) throw new Error('dump does not replay');
    const at = still.findIndex((r) => r.kind === 'block' && r.slot === dump.slot);
    const moving = [...still.slice(0, at), dump, ...still.slice(at)];
    // The values at the touch and at the fill, from the core quotes: our tokens sold into the pool our buy left, then into
    // the same pool after the dump replayed on top of our buy (the shifted pool); minus the landed exit, plus the rent back.
    const shifted = replaySwap(buy.after, dump);
    if (!shifted.ok) throw new Error('dump does not replay on the shifted pool');
    const valueOn = (pool: typeof buy.after) => {
      const q = poolSell(pool, buy.base, ctx);
      if (!q.ok) throw new Error('no exit quote');
      return q.trade.userQuote - terms.exitFixed + terms.rent;
    };
    const atTouch = valueOn(buy.after);
    const atFill = valueOn(shifted.trade.after);
    expect(atFill).toBeLessThan(atTouch);
    const cost = buy.userQuote + terms.entryLanded + terms.rent;
    const forcedLanding = { landPpm: { ...cons.landPpm, pumpswap: 1_000_000n }, closeSuccessPpm: 1_000_000n, dustPpm: 0n };
    for (const ppm of [1_000_000n, cons.slippagePpm, 2_000_000n]) {
      const out = scoreUnder(moving, 5, withScenario({ ...forcedLanding, slippagePpm: ppm }));
      const lost = atFill - withSlippage(atFill, atTouch, ppm);
      // withSlippage: the shortfall × (ppm − 1e6) / 1e6, rounded up.
      expect(lost).toBe(((atTouch - atFill) * (ppm - 1_000_000n) + 999_999n) / 1_000_000n);
      for (const o of out) {
        const l = o.labels[0]!;
        expect(o.entryCost).toBe(cost);
        expect(l.yTb).toBe(0);
        expect(l.touchSlot).toBe(Number(touch));
        expect(l.exitSlot).toBe(Number(touch + landing));
        const base = Number(atFill - cost) / Number(cost);
        expect(l.rNet).toBe(lost === 0n ? base : base - Number(lost) / Number(cost));
      }
    }
    // Conservative ×1.5: half the shortfall comes off on top of the fill.
    expect(atFill - withSlippage(atFill, atTouch, cons.slippagePpm)).toBe((atTouch - atFill + 1n) / 2n);
  }, 60_000);

  test('a bigger trade has a lower hurdle on every setup; break-even win rate formula', () => {
    for (const id of ['young', 'u1', 'u1-1.15']) {
      const be = now.filter((r) => r.setup === id).map((r) => r.breakEvenPct);
      expect(be[0]!).toBeGreaterThan(be[1]!);
      expect(be[1]!).toBeGreaterThan(be[2]!);
    }
    for (const [w, l] of BRACKETS) {
      const p = breakEvenWinRate(w, l, 4);
      expect(p * w - (1 - p) * l - 4).toBeCloseTo(0, 12);
    }
  });
});

describe('pre-registration', () => {
  const text = read('research/edge/preregistration.json');
  const pre = JSON.parse(text) as {
    exits: Record<'U1' | 'U2', Record<string, number>>;
    hypotheses: { id: string; rank: number; universe: string; window: { universe: string; toMs: number }; rules: { kind: string; conds?: { f: string; dir: string; t: string }[]; stopBelowBps?: number }; edgePpm: string; medianTargetBps: number }[];
  };

  test('its sha256 is the one recorded in edge.md, so the document names exactly this file', () => {
    const sha = createHash('sha256').update(text).digest('hex');
    expect(read('docs/research/edge.md')).toContain(sha);
  });

  test('definitions fixed before data: holder growth counts owners, not token accounts; U2 flow is non-creator-user flow', () => {
    const d = (JSON.parse(text) as { definitions: Record<string, string> }).definitions;
    expect(d['holderGrowth']).toMatch(/distinct owners/);
    expect(d['holderGrowth']).toMatch(/never token accounts/);
    expect(d['holderGrowth']).toMatch(/same data coverage/);
    expect(d['nonCreatorUserFlow']).toMatch(/creator's exact address/);
    expect(d['nonCreatorUserFlow']).toMatch(/funded still counts/);
  });

  test('ids unique, ranks 1..n, universes U1 or U2 only, windows match their universe', () => {
    const h = pre.hypotheses;
    expect(new Set(h.map((x) => x.id)).size).toBe(h.length);
    expect(h.map((x) => x.rank)).toEqual(h.map((_, i) => i + 1));
    for (const x of h) {
      expect(['U1', 'U2']).toContain(x.universe);
      expect(x.window.universe).toBe(x.universe);
      expect(BigInt(x.edgePpm)).toBe(50_000n);
    }
  });

  test('feature rules use only RES-3 as-of features with finite thresholds, never sample-rate dependent counts', () => {
    for (const x of pre.hypotheses.filter((h) => h.rules.kind === 'features')) {
      expect(x.rules.conds!.length).toBeGreaterThan(0);
      for (const c of x.rules.conds!) {
        expect(FEATURE_IDS as readonly string[]).toContain(c.f);
        expect(['f_grad24', 'f_dep24']).not.toContain(c.f);
        expect(['ge', 'le']).toContain(c.dir);
        expect(Number.isFinite(Number(c.t))).toBe(true);
      }
      expect(x.rules.stopBelowBps!).toBeGreaterThan(0);
      expect(x.rules.stopBelowBps!).toBeLessThan(10_000);
    }
  });

  test('exits are the policy per-universe blocks exactly, inside the phase-1 T_max cap', () => {
    for (const u of ['U1', 'U2'] as const) {
      expect(pre.exits[u]).toEqual(TRIAL_POLICY.exits.universes[u]);
      expect(pre.exits[u]!['tMaxMs']!).toBeLessThanOrEqual(TRIAL_POLICY.exits.tMaxCapMs);
    }
  });
});
