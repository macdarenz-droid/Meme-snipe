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
import { CREATE_KEEP_MS, SOL_PRICE_KEY, feesKey } from '../src/engine/strategy.ts';
import { createKey } from '../../core/src/gates/index.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { checksOf, classify, route } from '../src/run/api.ts';
import { markedHistory } from '../src/engine/marks.ts';
import { FunnelView } from '../src/run/funnel.ts';
import { MIGRATED_AT, MINT, makeWorker, passingMarket } from './worker-harness.ts';

type Funnel = { stages: { stage: string; count: number }[]; rejects: { check: string; count: number }[] };

/**
 * Every reason strategy.ts `#evaluate` can refuse with (its `#fail` calls, `#market`'s misses and `#stopAt`'s texts),
 * an instance of each, and the check and stage it must read as.
 */
const REASONS: readonly (readonly [string, string, string | null, number])[] = [
  // Refused before any installed hard check runs: no invented H code or passed stage.
  ['#evaluate expired create (facts or let-go mark)', 'create expired', null, 0],
  ['#evaluate regime', 'regime off: no graduates as of slot 1', 'regime', 0],
  ['#evaluate SOL price', 'live SOL price unknown', 'H16', 0],
  ['#market no pool', 'pool state unknown', 'H16', 0],
  ['#market malformed', 'pool state malformed', 'H16', 0],
  ['#market flagged', 'pool state flagged partial (swap gap)', 'H16', 0],
  ['#market fee terms', 'fee context unknown', 'H16', 0],
  ['#evaluate hard incomplete', 'hard rejects incomplete', 'H16', 0],
  ['#evaluate hard reject', 'hard reject H7: H7 stuck-curve x', 'H7', 0],
  // COMPLETION-READ: a step held up by a missing input is the missing input (H16), not the step.
  ['#evaluate hard reject, missing input', 'hard reject H7,H9,H10: H16 missing no curve as of slot 1', 'H16', 0],
  ['#evaluate hard reject, unusable input', 'hard reject H11: H16 stale curve as of slot 1; H11 x', 'H16', 0],
  ['#evaluate hard reject, a failed step first', 'hard reject H7,H9: H7 stuck-curve x; H16 missing y', 'H7', 0],
  ['#evaluate account', 'account snapshot unknown', 'H16', 1],
  ['#stopAt no round trip', 'no round trip: no-liquidity', 'size', 1],
  ['#stopAt no ATR', 'stop: not enough price bars for the ATR', 'size', 1],
  ['#stopAt stop distance', 'stop: too-wide 2400', 'size', 1],
  ['#evaluate risk mark', 'risk mark failed: x', 'risk', 1],
  ['#evaluate risk fault', 'risk fault: x', 'risk', 1],
  ['#evaluate risk refusal', 'risk R14 cost_gate: round trip 59822 ppm is above 500 bps', 'risk', 1],
  ['#evaluate size mismatch', 'risk sized 2 lamports, gates judged 1', 'size', 2],
];

describe('FUNNEL-TRUTH: each refusal at the check and stage it truly reached', () => {
  it('names every reason the strategy refuses with, with a check the installed app knows', () => {
    const known = Object.keys(CHECK_LABEL);
    for (const [where, reason, check, stage] of REASONS) {
      expect(classify(reason), where).toEqual({ check, stage });
      if (check !== null) expect(known, where).toContain(check);
    }
    // A real R14 refusal never claims the cost gate passed; its reason is labelled "Costs" in the decisions view.
    expect(RISK_CODE_LABEL['cost_gate']).toBe('Costs');
    expect(CHECK_LABEL['H16']).toBe('Stale or unknown data');
    // A reason not listed names no check and stays at "seen": never "Costs", never a stage it did not reach.
    expect(classify('something new')).toEqual({ check: null, stage: 0 });
  });

  it('COMPLETION-READ: a hard step held up by a missing input is filed under H16 in the funnel and the decisions view alike', () => {
    const at = Date.parse('2026-10-06T02:00:00Z');
    const view = new FunnelView(at);
    const why = 'hard reject H7,H9,H10: H16 missing no curve as of slot 1';
    view.apply({ seq: 1, ts: new Date(at).toISOString(), kind: 'decision', event: 'ev-1', reasons: ['shortlist', 'x', MINT] });
    view.apply({ seq: 2, ts: new Date(at + 1_000).toISOString(), kind: 'decision', event: 'ev-2', reasons: ['reject', 'x', MINT, why] });
    expect(classify(why)).toEqual({ check: 'H16', stage: 0 });
    expect(view.funnel.stage.get(MINT)).toEqual(expect.objectContaining({ check: 'H16', stage: 0 }));
    expect(view.rows.map((r) => r.check)).toEqual(['H16']);
  });

  it('an expired create is failed, while worker input gaps still read as missing', () => {
    const expired = { gate: 'worker', code: 'create-expired' };
    expect(checksOf([expired])).toBe('failed');
    expect(checksOf([{ gate: 'H16', code: 'missing' }, expired])).toBe('failed');
    expect(checksOf([{ gate: 'worker', code: 'no-sol-price' }])).toBe('missing');
    expect(checksOf([{ gate: 'worker', code: 'no-fee-context' }])).toBe('missing');
    expect(checksOf([{ gate: 'H16', code: 'create-expired' }])).toBe('missing');
    expect(checksOf([{ gate: 'regime', code: 'create-expired' }])).toBe('missing');
  });

  it('a real expired create serves failed token checks through the installed strict schema, without passing funnel stages', async () => {
    const h = makeWorker();
    try {
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      const m = await passingMarket(h, { heldPoolFacts: true, omit: [createKey(MINT)] });
      m.omit = new Set([...m.omit].filter((key) => key !== createKey(MINT)));
      const create = passingFacts().get(createKey(MINT))!.value as Record<string, unknown>;
      m.fact(createKey(MINT), { ...create, createdAtMs: MIGRATED_AT - CREATE_KEEP_MS - 1_000 });
      await m.run(4_000, 100, () => m.pool());
      await m.run(10_000, 400, () => { m.slot(); m.pool(); });
      expect(h.worker.apiInputs().discovered.find((token) => token.mint === MINT)!.gates).toEqual([
        expect.objectContaining({ gate: 'worker', code: 'create-expired' }),
      ]);
      const get = (endpoint: 'discovered' | 'funnel' | 'decisions') => checkEnvelope(
        JSON.parse(JSON.stringify(route(PATHS[endpoint]('paper'), () => h.worker.apiInputs()).body)),
        'paper', schemaFor(endpoint, 'paper'),
      ).data;
      const discovered = get('discovered') as { tokens: { mint: string; checks: string }[] };
      expect(discovered.tokens.find((token) => token.mint === MINT)!.checks).toBe('failed');
      const funnel = get('funnel') as Funnel;
      expect(funnel.stages.map((stage) => stage.count)).toEqual([1, 0, 0, 0, 0]);
      // There is no installed check for this market rule. It cannot be reported as a missing input or a cost refusal.
      const decisions = get('decisions') as { reasons: string[]; checks: { check: string }[] }[];
      const expired = decisions.filter((decision) => decision.reasons.includes('create expired'));
      expect(expired.length).toBeGreaterThan(0);
      for (const decision of expired) expect(decision.checks).toEqual([]);
    } finally {
      await h.worker.stop();
    }
  });

  it.each(['H18', 'H0', 'H01', 'H100', 'H1suffix', 'H17suffix'])('unknown hard gate %s stays unclassified for the installed app', (gate) => {
    expect(classify(`hard reject ${gate}: new gate`)).toEqual({ check: null, stage: 0 });
  });

  it.each(['fault', 'cost'] as const)('a worker %s refusal never counts a cost gate pass', async (kind) => {
    let broken = false;
    const mark: typeof markedHistory = (...args) => {
      const r = markedHistory(...args);
      return broken ? { ...r, closedTrades: null as never } : r;
    };
    const h = makeWorker(kind === 'fault' ? { markedHistory: mark } : { strategy: { medianTargetBps: 1 } });
    try {
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      const m = await passingMarket(h);
      const read = h.worker.feed.releasedThrough;
      m.tradesStart(read - 100n);
      m.accountsRead(read);
      broken = kind === 'fault';
      await m.run(8_000, 400, () => { m.slot(); m.pool(); });
      const rows = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string; reasons?: string[] });
      const reasons = rows.filter((row) => row.kind === 'decision').flatMap((row) => row.reasons ?? []);
      expect(reasons.some((reason) => kind === 'fault' ? reason.startsWith('risk fault:') : reason.includes('R14 cost_gate:'))).toBe(true);
      const body = route(PATHS.funnel('paper'), () => h.worker.apiInputs()).body;
      const f = checkEnvelope(JSON.parse(JSON.stringify(body)), 'paper', schemaFor('funnel', 'paper')).data as Funnel;
      const count = (stage: string) => f.stages.find((row) => row.stage === stage)!.count;
      expect(count('hard-rejects')).toBe(1);
      expect([count('costs'), count('risk'), count('entered')]).toEqual([0, 0, 0]);
    } finally {
      await h.worker.stop();
    }
  });

  it('the list above is every reject site in strategy.ts: a new one fails here until it is classified', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/engine/strategy.ts'), 'utf8');
    // #evaluate's `#fail` calls (the market miss, the stop text and the regime pass their own text through).
    expect(src.match(/return this\.#fail\(/g)).toHaveLength(13);
    // #236 added both paths to the same pre-gate refusal, covered above by reason and exact worker code.
    expect(src.match(/return this\.#fail\('create expired', \[\{ gate: 'worker', code: 'create-expired',/g)).toHaveLength(2);
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
