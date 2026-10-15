// A-M10-01 logic 2-4 and edge cases: the prior parameter set, its file, validation (E_SIM_PARAMS) and model versions.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { canonicalJson, type Config } from '@bot/types';
import { loadSimParamSet, modelVersions, parseSimParamSet, PRIOR_2026_10, simParamSetJson, type SimParamSet } from '../../src/m10/params.ts';
import { lognormalParams } from '../../src/m10/latency.ts';
import { M10_LOG_CODES } from '../../src/m10/log.ts';
import { loadActiveSimParams, m10Settings } from '../../src/m10/settings.ts';
import { CONFIG_FIELDS } from '../../src/m25/registry.ts';

const DIR = new URL('../../sim-params/', import.meta.url);
const read = (f: string): string => readFileSync(new URL(f, DIR), 'utf8');
const json = (): Record<string, unknown> => JSON.parse(simParamSetJson(PRIOR_2026_10)) as Record<string, unknown>;
const problem = (v: unknown): string => { const r = parseSimParamSet(v); assert.equal(r.ok, false); return r.ok ? '' : `${r.error.code} ${r.error.problem}`; };

describe('A-M10-01 parameter sets', () => {
  it('sim-params/prior-2026-10.json is the canonical JSON of the ARCH priors and loads back unchanged', () => {
    assert.equal(read('prior-2026-10.json'), `${simParamSetJson(PRIOR_2026_10)}\n`);
    const r = loadSimParamSet('prior-2026-10', read);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(simParamSetJson(r.value), simParamSetJson(PRIOR_2026_10));
  });

  it('the prior holds the ARCH values (logic 2)', () => {
    const p = PRIOR_2026_10;
    assert.deepEqual(p.latency, { kind: 'lognormal_prior', medianMs: 1_500, p95Ms: 5_000 });
    assert.deepEqual([p.fFailEntry, p.fFailExit, p.fExp, p.pSwEntry, p.pSwExit], [0.2, 0.2, 0.05, 0.1, 0.1]);
    assert.deepEqual(p.failureClassMix, { unknown: 1 });
    assert.deepEqual([p.gapThroughStopP99Bps, p.gapSamples], [2_000, 0]);
    assert.deepEqual(p.cost, { cuLimit: 200_000, leanCuPriceMicroLamports: 25_000n, senderTipLamports: 5_000n, jitoTipLamports: 1_000n,
      premiumTipLamports: 1_000_000n, premiumCuPriceMicroLamports: 1_000_000n, janitorPriorityLamports: 5_000n });
    const { mu, sigma } = lognormalParams(1_500, 5_000);
    assert.equal(mu, Math.log(1_500));
    assert.ok(Math.abs(sigma - 0.732) < 0.0005, String(sigma));      // DERIVED ≈ 0.732
  });

  it('given two parameter files differing in one value, their fillModelVersions differ (and the cost versions)', () => {
    const a = modelVersions(PRIOR_2026_10), b = modelVersions({ ...PRIOR_2026_10, fExp: 0.06 } as SimParamSet);
    assert.notEqual(a.fillModelVersion, b.fillModelVersion);
    assert.notEqual(a.costModelVersion, b.costModelVersion);
    assert.match(a.fillModelVersion, /^fill-1\.0\.0-[0-9a-f]{12}$/);
    assert.match(a.costModelVersion, /^cost-1\.0\.0-[0-9a-f]{12}$/);
    assert.deepEqual(modelVersions(PRIOR_2026_10), a);                  // deterministic
    const cost = modelVersions({ ...PRIOR_2026_10, cost: { ...PRIOR_2026_10.cost, jitoTipLamports: 1_001n } } as SimParamSet);
    assert.notEqual(cost.fillModelVersion, a.fillModelVersion);
  });

  it('refuses a missing, unreadable or misnamed file (E_SIM_PARAMS)', () => {
    assert.deepEqual(loadSimParamSet('none-such', read), { ok: false, error: { code: 'E_SIM_PARAMS', problem: 'file missing or not JSON' } });
    assert.deepEqual(loadSimParamSet('../x', read), { ok: false, error: { code: 'E_SIM_PARAMS', problem: 'invalid set name' } });
    assert.deepEqual(loadSimParamSet('other', () => simParamSetJson(PRIOR_2026_10)), { ok: false, error: { code: 'E_SIM_PARAMS', problem: 'file name and set name differ' } });
    assert.deepEqual(loadSimParamSet('x', () => '{'), { ok: false, error: { code: 'E_SIM_PARAMS', problem: 'file missing or not JSON' } });
  });

  it('refuses probabilities outside [0, 1) and a class mix not summing to 1 ± 1e-9', () => {
    assert.match(problem({ ...json(), fFailEntry: 1 }), /fFailEntry/);
    assert.match(problem({ ...json(), pSwExit: -0.1 }), /pSwExit/);
    assert.match(problem({ ...json(), fExp: '0.1' }), /fExp/);
    assert.match(problem({ ...json(), failureClassMix: { unknown: 0.5, slippage: 0.4999 } }), /sum to 1/);
    assert.match(problem({ ...json(), failureClassMix: { nope: 1 } }), /unknown class/);
    assert.equal(parseSimParamSet({ ...json(), failureClassMix: { unknown: 0.5, slippage: 0.5 + 5e-10 } }).ok, true);
  });

  it("refuses SPEC-A's slotMsAssumed (A10: slot time comes only from the slot-to-time function) and any unknown field", () => {
    assert.match(problem({ ...json(), slotMsAssumed: 400 }), /unknown field "slotMsAssumed"/);
    const { gapSamples: _g, ...missing } = json();
    assert.match(problem(missing), /missing field gapSamples/);
  });

  it('validates the latency block and the cost block', () => {
    assert.match(problem({ ...json(), latency: { kind: 'lognormal_prior', medianMs: 5_000, p95Ms: 1_500 } }), /medianMs < p95Ms/);
    assert.match(problem({ ...json(), latency: { kind: 'empirical', samplesMs: [1, 2], source: 'x', n: 3 } }), /n must equal/);
    assert.match(problem({ ...json(), latency: { kind: 'empirical', samplesMs: [], source: 'x', n: 0 } }), /samplesMs/);
    assert.match(problem({ ...json(), latency: { kind: 'fixed' } }), /kind/);
    assert.equal(parseSimParamSet({ ...json(), latency: { kind: 'empirical', samplesMs: [900, 1_200], source: 'M18 landing log', n: 2 } }).ok, true);
    assert.match(problem({ ...json(), cost: { ...(json().cost as object), cuLimit: 1_400_001 } }), /cuLimit/);
    assert.match(problem({ ...json(), cost: { ...(json().cost as object), jitoTipLamports: 1000 } }), /jitoTipLamports/);
    assert.match(problem({ ...json(), name: 'Prior' }), /name/);
  });

  it('canonical JSON writes the cost bigints as decimal strings', () => {
    assert.match(simParamSetJson(PRIOR_2026_10), /"leanCuPriceMicroLamports":"25000"/);
    assert.equal(canonicalJson(json()), simParamSetJson(PRIOR_2026_10));
  });

  it('config: sim.param_set (affects returns) and sim.latency_multiplier 1.0-10.0 are registered', () => {
    const ps = CONFIG_FIELDS.find((f) => f.key === 'sim.param_set'), lm = CONFIG_FIELDS.find((f) => f.key === 'sim.latency_multiplier');
    assert.equal(ps?.default, 'prior-2026-10');
    assert.equal(ps?.affectsReturns, true);
    assert.deepEqual([lm?.type, lm?.min, lm?.max, lm?.default, lm?.affectsReturns], ['decimal', '1.0', '10.0', '1.0', true]);
  });
});

describe('A-M10-01 observability and settings', () => {
  it('loading the active set logs m10.param_set_loaded with its name and versions; a bad set logs nothing', () => {
    const events: Array<{ code: string; fields: Readonly<Record<string, unknown>> | undefined }> = [];
    const log = { event: (_l: string, code: string, fields?: Readonly<Record<string, unknown>>) => { events.push({ code, fields }); } };
    const r = loadActiveSimParams({ paramSet: 'prior-2026-10', latencyMultiplier: 1 }, read, log);
    assert.equal(r.ok, true);
    const v = modelVersions(PRIOR_2026_10);
    assert.deepEqual(events, [{ code: 'm10.param_set_loaded', fields: { name: 'prior-2026-10', fill_model_version: v.fillModelVersion, cost_model_version: v.costModelVersion } }]);
    assert.equal(loadActiveSimParams({ paramSet: 'none-such', latencyMultiplier: 1 }, read, log).ok, false);
    assert.equal(events.length, 1);
    assert.ok(Object.hasOwn(M10_LOG_CODES, 'm10.param_set_loaded'));
  });

  it('m10Settings reads sim.param_set and sim.latency_multiplier', () => {
    const config = { version: 'v', 'sim.param_set': 'prior-2026-10', 'sim.latency_multiplier': '2.0' } as unknown as Config;
    assert.deepEqual(m10Settings(config), { paramSet: 'prior-2026-10', latencyMultiplier: 2 });
  });
});
