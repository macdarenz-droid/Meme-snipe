// FUNNEL-TRUTH: the app's funnel names each refusal by the check that refused it and counts only the stages a
// candidate really passed. A boot that starts without a SOL price, then lacks the pool's fee terms, never shows the
// candidate past the hard rejects or under "Costs"; a real R14 refusal is a risk-stage refusal.
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { CHECK_LABEL, RISK_CODE_LABEL } from '../../../apps/web/src/dashboard/labels.ts';
import { SOL_PRICE_KEY, feesKey } from '../src/engine/strategy.ts';
import { classify, route } from '../src/run/api.ts';
import { MINT, makeWorker, passingMarket } from './worker-harness.ts';

type Funnel = { stages: { stage: string; count: number }[]; rejects: { check: string; count: number }[] };

describe('FUNNEL-TRUTH: each refusal at the stage it truly reached', () => {
  it('names every reason the strategy refuses with, in the order it judges', () => {
    expect(classify('regime off: no graduates as of slot 1')).toEqual({ check: 'regime', stage: 0 });
    expect(classify('live SOL price unknown')).toEqual({ check: 'data', stage: 0 });
    expect(classify('pool state unknown')).toEqual({ check: 'data', stage: 0 });
    expect(classify('pool state malformed')).toEqual({ check: 'data', stage: 0 });
    expect(classify('pool state flagged gap (swap stream)')).toEqual({ check: 'data', stage: 0 });
    expect(classify('fee context unknown')).toEqual({ check: 'data', stage: 0 });
    expect(classify('hard reject H7: H7 stuck-curve x')).toEqual({ check: 'H7', stage: 0 });
    expect(classify('hard rejects incomplete')).toEqual({ check: 'other', stage: 0 });
    expect(classify('account snapshot unknown')).toEqual({ check: 'data', stage: 1 });
    expect(classify('stop: too-wide 2400')).toEqual({ check: 'size', stage: 1 });
    expect(classify('no round trip: no-liquidity')).toEqual({ check: 'size', stage: 1 });
    expect(classify('risk R14 cost_gate: round trip 59822 ppm is above 500 bps')).toEqual({ check: 'risk', stage: 2 });
    // A real R14 refusal: the risk stage, its reason labelled "Costs" in the decisions view.
    expect(RISK_CODE_LABEL['cost_gate']).toBe('Costs');
    expect(CHECK_LABEL.risk).toBe('Risk limits');
    expect(classify('risk fault: x')).toEqual({ check: 'risk', stage: 2 });
    // Never "Costs" by default, never a stage it did not reach.
    expect(classify('something new')).toEqual({ check: 'other', stage: 0 });
    // A reason that only mentions a SOL price is not a risk refusal.
    expect(classify('pool state flagged: SOL price moved')).toEqual({ check: 'data', stage: 0 });
  });

  it('a boot without a SOL price, then without the fee terms: the candidate stays at "seen", under "Missing data", and the app\'s schema takes it', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { fees: false, omit: [SOL_PRICE_KEY] });
    await m.run(3_000, 400, () => { m.slot(); m.pool(); });
    m.omit = new Set([feesKey(MINT)]);
    await m.run(3_000, 400, () => { m.slot(); m.pool(); m.solPrice(); });
    const r = route(PATHS.funnel('paper'), () => h.worker.apiInputs());
    const f = checkEnvelope(JSON.parse(JSON.stringify(r.body)), 'paper', schemaFor('funnel', 'paper')).data as Funnel;
    const count = (stage: string) => f.stages.find((s) => s.stage === stage)!.count;
    expect(count('seen')).toBeGreaterThanOrEqual(1);
    expect([count('hard-rejects'), count('costs'), count('risk'), count('entered')]).toEqual([0, 0, 0, 0]);
    expect(f.rejects).toEqual([{ mode: 'paper', check: 'data', count: 1 }]);
    expect(CHECK_LABEL.data).toBe('Missing data');
    await h.worker.stop();
  });
});
