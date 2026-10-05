// FUNNEL-TRUTH: the app's funnel names each refusal by the check that refused it, with the checks the installed app
// already knows (its strict schema is pinned at the base), and counts only the stages a candidate really passed. A boot
// that starts without a SOL price, then lacks the pool's fee terms, never shows the candidate past "seen" or under
// "Costs"; a real R14 refusal is a risk-stage refusal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { CHECK_LABEL, RISK_CODE_LABEL } from '../../../apps/web/src/dashboard/labels.ts';
import { SOL_PRICE_KEY, feesKey } from '../src/engine/strategy.ts';
import { classify, route } from '../src/run/api.ts';
import { MINT, makeWorker, passingMarket } from './worker-harness.ts';

type Funnel = { stages: { stage: string; count: number }[]; rejects: { check: string; count: number }[] };

/**
 * Every reason strategy.ts `#evaluate` can refuse with (its `#fail` calls, `#market`'s misses and `#stopAt`'s texts),
 * an instance of each, and the check and stage it must read as.
 */
const REASONS: readonly (readonly [string, string, string, number])[] = [
  ['#evaluate regime', 'regime off: no graduates as of slot 1', 'regime', 0],
  ['#evaluate SOL price', 'live SOL price unknown', 'H16', 0],
  ['#market no pool', 'pool state unknown', 'H16', 0],
  ['#market malformed', 'pool state malformed', 'H16', 0],
  ['#market flagged', 'pool state flagged partial (swap gap)', 'H16', 0],
  ['#market fee terms', 'fee context unknown', 'H16', 0],
  ['#evaluate hard incomplete', 'hard rejects incomplete', 'H16', 0],
  ['#evaluate hard reject', 'hard reject H7: H7 stuck-curve x', 'H7', 0],
  ['#evaluate account', 'account snapshot unknown', 'H16', 1],
  ['#stopAt no round trip', 'no round trip: no-liquidity', 'size', 1],
  ['#stopAt no ATR', 'stop: not enough price bars for the ATR', 'size', 1],
  ['#stopAt stop distance', 'stop: too-wide 2400', 'size', 1],
  ['#evaluate risk mark', 'risk mark failed: x', 'risk', 2],
  ['#evaluate risk fault', 'risk fault: x', 'risk', 2],
  ['#evaluate risk refusal', 'risk R14 cost_gate: round trip 59822 ppm is above 500 bps', 'risk', 2],
  ['#evaluate size mismatch', 'risk sized 2 lamports, gates judged 1', 'size', 2],
];

describe('FUNNEL-TRUTH: each refusal at the check and stage it truly reached', () => {
  it('names every reason the strategy refuses with, with a check the installed app knows', () => {
    const known = Object.keys(CHECK_LABEL);
    for (const [where, reason, check, stage] of REASONS) {
      expect(classify(reason), where).toEqual({ check, stage });
      expect(known, where).toContain(check);
    }
    // A real R14 refusal: the risk stage, its reason labelled "Costs" in the decisions view.
    expect(RISK_CODE_LABEL['cost_gate']).toBe('Costs');
    expect(CHECK_LABEL['H16']).toBe('Stale or unknown data');
    // A reason not listed names no check and stays at "seen": never "Costs", never a stage it did not reach.
    expect(classify('something new')).toEqual({ check: null, stage: 0 });
  });

  it('the list above is every reject site in strategy.ts: a new one fails here until it is classified', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/engine/strategy.ts'), 'utf8');
    // #evaluate's `#fail` calls (the market miss, the stop text and the regime pass their own text through).
    expect(src.match(/return this\.#fail\(/g)).toHaveLength(11);
    // #market's misses and #stopAt's texts.
    expect(src.match(/^const (NO_POOL_STATE|POOL_MALFORMED|POOL_FLAGGED|NO_FEE_CONTEXT) = /gm)).toHaveLength(4);
    expect(src.match(/return \{ ok: false, text: /g)).toHaveLength(3);
  });

  it('a boot without a SOL price, then without the fee terms: the candidate stays at "seen", under H16, and the current app\'s strict schema takes every response', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { fees: false, omit: [SOL_PRICE_KEY] });
    await m.run(3_000, 400, () => { m.slot(); m.pool(); });
    m.omit = new Set([feesKey(MINT)]);
    await m.run(3_000, 400, () => { m.slot(); m.pool(); m.solPrice(); });
    const get = (e: 'funnel' | 'decisions') => checkEnvelope(JSON.parse(JSON.stringify(route(PATHS[e]('paper'), () => h.worker.apiInputs()).body)), 'paper', schemaFor(e, 'paper')).data;
    const f = get('funnel') as Funnel;
    const count = (stage: string) => f.stages.find((s) => s.stage === stage)!.count;
    expect(count('seen')).toBeGreaterThanOrEqual(1);
    expect([count('hard-rejects'), count('costs'), count('risk'), count('entered')]).toEqual([0, 0, 0, 0]);
    expect(f.rejects).toEqual([{ mode: 'paper', check: 'H16', count: 1 }]);
    const d = get('decisions') as { checks: { check: string }[] }[];
    expect(d.length).toBeGreaterThanOrEqual(2);
    // The boot's first evaluations may meet the regime's inputs still arriving; every other refusal is missing data.
    for (const row of d) expect(['regime', 'H16']).toContain(row.checks[0]!.check);
    expect(d.filter((row) => row.checks[0]!.check === 'H16').length).toBeGreaterThanOrEqual(2);
    await h.worker.stop();
  });
});
