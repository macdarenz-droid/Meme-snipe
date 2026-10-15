// A-M10-01 logic 2-4 and edge cases: the prior parameter set, its file, validation (E_SIM_PARAMS) and model versions.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { canonicalJson, type Config } from '@bot/types';
import { CALIBRATION_MIN_SAMPLES, GAP_MIN_SAMPLES, loadSimParamSet, MIN_LATENCY_MS, modelVersions, parseSimParamSet, PRIOR_2026_10, simParamSetJson, type SimParamSet } from '../../src/m10/params.ts';
import { createLatencyModel, lognormalParams } from '../../src/m10/latency.ts';
import { createRng } from '../../src/m10/rng.ts';
import { M10_LOG_CODES } from '../../src/m10/log.ts';
import { loadActiveSimParams, m10Settings } from '../../src/m10/settings.ts';
import { CONFIG_FIELDS } from '../../src/m25/registry.ts';

const DIR = new URL('../../sim-params/', import.meta.url);
const read = (f: string): string => readFileSync(new URL(f, DIR), 'utf8');
// Evidence files in memory (Z06-8): NDJSON, hashed for real; `mem` serves them and falls back to sim-params/.
const files = new Map<string, string>();
const mem = (f: string): string => files.get(f) ?? read(f);
const sha256 = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
let fileNo = 0;
/** An evidence file of `lines` records of which `distinct` differ (the rest are copies), declared with n. */
function evFile(n: number, o: { distinct?: number; lines?: number; record?: (i: number) => object } = {}): { source: string; n: number; sourceSha256: string } {
  const distinct = o.distinct ?? n, lines = o.lines ?? Math.max(n, distinct), rec = o.record ?? ((i: number) => ({ sig: `L${i}`, slot: 1_000 + i, latencyMs: 900 + i }));
  const text = Array.from({ length: lines }, (_, i) => JSON.stringify(rec(i % distinct))).join('\n') + '\n';
  const source = `evidence/f${fileNo++}.ndjson`;
  files.set(source, text);
  return { source, n, sourceSha256: sha256(text) };
}
const lat = (n: number, o: Parameters<typeof evFile>[1] = {}) => ({ kind: 'empirical', ...evFile(n, o) });
/** Z06-11 record schemas; `bad` of the records fail, are sandwiched, or carry the given value. */
const REC = {
  failure: (bad = 0) => (i: number) => ({ sig: `F${i}`, slot: i, ok: i >= bad }),
  sandwich: (bad = 0) => (i: number) => ({ sig: `S${i}`, slot: i, sandwiched: i < bad }),
  gap: (step = 8) => (i: number) => ({ sig: `G${i}`, slot: i, gapBps: i * step }),
  cost: (tip = '900') => (i: number) => ({ sig: `C${i}`, slot: i, senderTipLamports: tip }),
};
const ev = (kind: keyof typeof REC, n: number, arg?: number | string) => evFile(n, { record: (REC[kind] as (a?: number | string) => (i: number) => object)(arg) });
const json = (): Record<string, unknown> => JSON.parse(simParamSetJson(PRIOR_2026_10)) as Record<string, unknown>;
const problem = (v: unknown): string => { const r = parseSimParamSet(v, mem); assert.equal(r.ok, false); return r.ok ? '' : `${r.error.code} ${r.error.problem}`; };

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
    // Within 1e-9 the sum check passes; the mix then fails only because failure records cannot measure it (Z06-11).
    assert.match(problem({ ...json(), failureClassMix: { unknown: 0.5, slippage: 0.5 + 5e-10 }, evidence: { failure: ev('failure', 100) } }), /failureClassMix cannot be measured/);
  });

  it("refuses SPEC-A's slotMsAssumed (A10: slot time comes only from the slot-to-time function) and any unknown field", () => {
    assert.match(problem({ ...json(), slotMsAssumed: 400 }), /unknown field "slotMsAssumed"/);
    const { gapSamples: _g, ...missing } = json();
    assert.match(problem(missing), /missing field gapSamples/);
  });

  it('validates the latency block and the cost block', () => {
    assert.match(problem({ ...json(), latency: { kind: 'lognormal_prior', medianMs: 5_000, p95Ms: 1_500 } }), /medianMs < p95Ms/);
    assert.match(problem({ ...json(), latency: { ...lat(100), samplesMs: [900] } }), /unknown field "samplesMs"/);
    assert.match(problem({ ...json(), latency: lat(99) }), /n >= 100/);
    assert.match(problem({ ...json(), latency: { kind: 'fixed' } }), /kind/);
    const r = parseSimParamSet({ ...json(), latency: lat(100) }, mem);
    assert.ok(r.ok && r.value.latency.kind === 'empirical');
    if (r.ok && r.value.latency.kind === 'empirical') assert.deepEqual(r.value.latency.samplesMs, Array.from({ length: 100 }, (_, i) => 900 + i));
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

describe('ruling Z06-3: nothing more optimistic than prior-2026-10 without evidence', () => {
  it('POLICY minimums come from SPEC-A: 100 (A-M10-05 sim.calibration.min_samples), 50 for the gap (A-M10-04 sim.gap.min_samples)', () => {
    assert.equal(CALIBRATION_MIN_SAMPLES, 100);
    assert.equal(GAP_MIN_SAMPLES, 50);
  });

  it('refuses a fully optimistic hand-edited set: fFail 0, pSw 0, gap 0, costs "0", median 1 ms, samples [0]', () => {
    const cost = Object.fromEntries(Object.entries(json().cost as Record<string, unknown>).map(([k]) => [k, k === 'cuLimit' ? 1 : '0']));
    const optimistic = { ...json(), fFailEntry: 0, fFailExit: 0, fExp: 0, pSwEntry: 0, pSwExit: 0, gapThroughStopP99Bps: 0, cost };
    assert.match(problem({ ...optimistic, latency: { kind: 'lognormal_prior', medianMs: 1, p95Ms: 2 } }), /faster than prior-2026-10/);
    assert.match(problem({ ...optimistic, latency: { ...lat(100), samplesMs: [0] } }), /unknown field "samplesMs"/);
    assert.match(problem({ ...optimistic, latency: lat(100, { record: (i) => ({ sig: `L${i}`, slot: i, latencyMs: 0 }) }) }), /latencyMs finite and >= 100/);
    assert.match(problem(optimistic), /fFailEntry is more optimistic than prior-2026-10 without failure evidence/);
  });

  it('each optimistic field names its missing evidence group', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ fFailExit: 0.1 }, /fFailExit .* failure evidence/], [{ fExp: 0.01 }, /fExp .* failure evidence/],
      [{ failureClassMix: { slippage: 1 } }, /failureClassMix .* failure evidence/],
      [{ pSwEntry: 0 }, /pSwEntry .* sandwich evidence/], [{ pSwExit: 0.05 }, /pSwExit .* sandwich evidence/],
      [{ gapThroughStopP99Bps: 0 }, /gapThroughStopP99Bps .* gap evidence/],
      [{ cost: { ...(json().cost as object), jitoTipLamports: '0' } }, /cost.jitoTipLamports .* cost evidence/],
      [{ cost: { ...(json().cost as object), cuLimit: 1 } }, /cost.cuLimit .* cost evidence/],
      [{ latency: { kind: 'lognormal_prior', medianMs: 1_499, p95Ms: 5_000 } }, /faster than prior-2026-10/],
      [{ latency: { kind: 'lognormal_prior', medianMs: 1_500, p95Ms: 4_999 } }, /faster than prior-2026-10/],
    ];
    for (const [over, re] of cases) assert.match(problem({ ...json(), ...over }), re);
  });

  it('accepts optimistic values that carry valid evidence, and more pessimistic values without any', () => {
    assert.equal(parseSimParamSet({ ...json(), fFailEntry: 0.1, fFailExit: 0.1, evidence: { failure: ev('failure', 100, 5) } }, mem).ok, true);   // 5% measured
    assert.equal(parseSimParamSet({ ...json(), pSwEntry: 0.02, evidence: { sandwich: ev('sandwich', 100, 1) } }, mem).ok, true);           // 1% measured
    assert.equal(parseSimParamSet({ ...json(), gapThroughStopP99Bps: 900, gapSamples: 50, evidence: { gap: ev('gap', 50) } }, mem).ok, true); // p99 392
    assert.equal(parseSimParamSet({ ...json(), cost: { ...(json().cost as object), senderTipLamports: '1000' }, evidence: { cost: ev('cost', 100) } }, mem).ok, true);
    assert.equal(parseSimParamSet({ ...json(), fFailEntry: 0.5, pSwExit: 0.3, gapThroughStopP99Bps: 4_000, latency: { kind: 'lognormal_prior', medianMs: 3_000, p95Ms: 9_000 } }, mem).ok, true);
  });

  it('refuses evidence below the POLICY minimum, without a hash or with an unknown key; a measured gap needs 50 gap samples', () => {
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: ev('failure', 99) } }), /evidence.failure: n must be an integer >= 100/);
    assert.match(problem({ ...json(), gapThroughStopP99Bps: 900, gapSamples: 50, evidence: { gap: ev('gap', 49) } }), /evidence.gap: n must be an integer >= 50/);
    assert.match(problem({ ...json(), gapThroughStopP99Bps: 900, gapSamples: 49, evidence: { gap: ev('gap', 50) } }), /gapSamples must be at least 50/);
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: { ...ev('failure', 100), sourceSha256: 'xyz' } } }), /sha256/);
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: { ...ev('failure', 100), source: '' } } }), /source is required/);
    assert.match(problem({ ...json(), evidence: { luck: ev('failure', 100) } }), /unknown key "luck"/);
    assert.match(problem({ ...json(), latency: lat(99) }), /n >= 100/);
    assert.match(problem({ ...json(), latency: { ...lat(100), sourceSha256: 'no' } }), /sourceSha256/);
  });
});

describe('ruling Z06-8: evidence is read from its source file, never taken on trust', () => {
  it('an all-zero (fake) hash is refused for group evidence and for empirical latency', () => {
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: { ...evFile(100), sourceSha256: '0'.repeat(64) } } }), /sha256 of the source file does not match/);
    assert.match(problem({ ...json(), latency: { ...lat(100), sourceSha256: '0'.repeat(64) } }), /sha256 of the source file does not match/);
  });

  it('a file padded with copies does not count: 100 lines of 10 distinct records is 10, not 100', () => {
    assert.match(problem({ ...json(), pSwEntry: 0, evidence: { sandwich: evFile(100, { distinct: 10, lines: 100, record: REC.sandwich() }) } }), /10 distinct records, fewer than n = 100/);
    assert.match(problem({ ...json(), latency: lat(100, { distinct: 10, lines: 100 }) }), /10 distinct records, fewer than n = 100/);
    // Records that differ only in key order or spacing are the same record.
    const text = Array.from({ length: 100 }, (_, i) => (i % 2 ? `{"sandwiched":false, "slot":${i >> 1},"sig":"S${i >> 1}"}` : `{"sig":"S${i >> 1}","slot":${i >> 1},"sandwiched":false}`)).join('\n');
    files.set('evidence/reordered.ndjson', text);
    assert.match(problem({ ...json(), pSwEntry: 0, evidence: { sandwich: { source: 'evidence/reordered.ndjson', n: 100, sourceSha256: sha256(text) } } }), /50 distinct records/);
  });

  it('refuses a missing file, a path outside sim-params/ and a file that is not NDJSON objects', () => {
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: { source: 'evidence/none.ndjson', n: 100, sourceSha256: '0'.repeat(64) } } }), /source file missing/);
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: { source: '../prior-2026-10.json', n: 100, sourceSha256: '0'.repeat(64) } } }), /file path under sim-params/);
    files.set('evidence/bad.ndjson', '1\n2\n');
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: { source: 'evidence/bad.ndjson', n: 100, sourceSha256: sha256('1\n2\n') } } }), /JSON object/);
  });

  it('evidence named but not needed is still verified', () => {
    assert.match(problem({ ...json(), evidence: { cost: { ...evFile(100), sourceSha256: 'f'.repeat(64) } } }), /does not match/);
  });

  it('the file form of an empirical set carries no samples; the version pins them through sourceSha256', () => {
    const r = parseSimParamSet({ ...json(), latency: lat(100) }, mem);
    assert.ok(r.ok);
    if (r.ok) {
      assert.doesNotMatch(simParamSetJson(r.value), /samplesMs/);
      const other = parseSimParamSet({ ...json(), latency: lat(100, { record: (i) => ({ sig: `L${i}`, slot: 1_000 + i, latencyMs: 901 + i }) }) }, mem);
      assert.ok(other.ok);
      if (other.ok) assert.notEqual(modelVersions(r.value).fillModelVersion, modelVersions(other.value).fillModelVersion);
    }
  });
});

describe('ruling Z06-11: evidence records follow their schema and every stated value is checked against them', () => {
  const xs = (n: number) => evFile(n, { record: (i) => ({ x: i }) });
  it('100 distinct {"x":i} lines with a correct hash are refused, for every group and for latency', () => {
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: xs(100) } }), /every record needs a sig/);
    assert.match(problem({ ...json(), pSwEntry: 0, evidence: { sandwich: xs(100) } }), /every record needs a sig/);
    assert.match(problem({ ...json(), gapThroughStopP99Bps: 0, gapSamples: 50, evidence: { gap: xs(100) } }), /every record needs a sig/);
    assert.match(problem({ ...json(), evidence: { cost: xs(100) } }), /every record needs a sig/);
    assert.match(problem({ ...json(), latency: { kind: 'empirical', ...xs(100) } }), /every record needs a sig/);
    // With sig and slot but the wrong fields, each schema still refuses.
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: evFile(100, { record: (i) => ({ sig: `F${i}`, slot: i, x: i }) }) } }), /\{sig, slot, ok\}/);
    assert.match(problem({ ...json(), evidence: { cost: evFile(100, { record: (i) => ({ sig: `C${i}`, slot: i, tip: '1' }) }) } }), /cost fields/);
    assert.match(problem({ ...json(), evidence: { cost: evFile(100, { record: (i) => ({ sig: `C${i}`, slot: i, jitoTipLamports: 5 }) }) } }), /u64 decimal string/);
  });

  it('a stated value more optimistic than the records\' point estimate is refused', () => {
    assert.match(problem({ ...json(), fFailEntry: 0.1, evidence: { failure: ev('failure', 100, 20) } }), /fFailEntry 0.1 is more optimistic than its evidence \(0.2\)/);
    assert.match(problem({ ...json(), fFailExit: 0.19, evidence: { failure: ev('failure', 100, 20) } }), /fFailExit 0.19 is more optimistic/);
    assert.match(problem({ ...json(), pSwEntry: 0.02, evidence: { sandwich: ev('sandwich', 100, 5) } }), /pSwEntry 0.02 is more optimistic than its evidence \(0.05\)/);
    assert.match(problem({ ...json(), gapThroughStopP99Bps: 900, gapSamples: 50, evidence: { gap: ev('gap', 50, 20) } }), /gapThroughStopP99Bps 900 is more optimistic than its evidence \(980\)/);
    assert.match(problem({ ...json(), gapThroughStopP99Bps: 900, gapSamples: 51, evidence: { gap: ev('gap', 50) } }), /gapSamples 51 exceeds the 50 gap records/);
    assert.match(problem({ ...json(), cost: { ...(json().cost as object), senderTipLamports: '1000' }, evidence: { cost: ev('cost', 100, '1500') } }), /cost.senderTipLamports 1000 is more optimistic than its evidence \(1500\)/);
    // Evidence that contradicts even the prior's values is refused: 30% measured failures against the prior's 20%.
    assert.match(problem({ ...json(), evidence: { failure: ev('failure', 100, 30) } }), /fFailEntry 0.2 is more optimistic than its evidence \(0.3\)/);
    // A cost field below the prior that the records do not measure.
    assert.match(problem({ ...json(), cost: { ...(json().cost as object), jitoTipLamports: '1' }, evidence: { cost: ev('cost', 100) } }), /only 0 cost records measure it/);
  });

  it('failure records carry no expiry or class, so fExp and the class mix stay at the prior', () => {
    assert.match(problem({ ...json(), fExp: 0.01, evidence: { failure: ev('failure', 100) } }), /fExp cannot be measured from failure records/);
    assert.match(problem({ ...json(), failureClassMix: { slippage: 0.5, unknown: 0.5 }, evidence: { failure: ev('failure', 100) } }), /failureClassMix cannot be measured/);
  });
});

describe('ruling Z06-12: one record per sig and slot; no latency below the physical floor', () => {
  it('the same record repeated counts once; two different records for one sig and slot are refused', () => {
    assert.match(problem({ ...json(), pSwEntry: 0, evidence: { sandwich: evFile(100, { record: () => ({ sig: 'S', slot: 1, sandwiched: false }) }) } }), /1 distinct records, fewer than n = 100/);
    assert.match(problem({ ...json(), pSwEntry: 0, evidence: { sandwich: evFile(100, { record: (i) => ({ sig: 'S', slot: 1, sandwiched: i % 2 === 0 }) }) } }), /two different records for sig "S" at slot 1/);
  });

  it(`latencyMs below MIN_LATENCY_MS (${MIN_LATENCY_MS} ms, SLOT_MS_MIN) is refused`, () => {
    assert.equal(MIN_LATENCY_MS, 100);
    assert.match(problem({ ...json(), latency: lat(100, { record: (i) => ({ sig: `L${i}`, slot: i, latencyMs: i === 50 ? 99 : 900 }) }) }), /latencyMs finite and >= 100/);
    assert.equal(parseSimParamSet({ ...json(), latency: lat(100, { record: (i) => ({ sig: `L${i}`, slot: i, latencyMs: 100 }) }) }, mem).ok, true);
  });
});

describe('ruling Z06-13: a verified empirical spec and its samples are frozen', () => {
  it('a write after loading throws and does not change the model', () => {
    const r = parseSimParamSet({ ...json(), latency: lat(100) }, mem);
    assert.ok(r.ok && r.value.latency.kind === 'empirical');
    if (!r.ok || r.value.latency.kind !== 'empirical') return;
    const spec = r.value.latency;
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.samplesMs));
    const draw = (): number[] => { const m = createLatencyModel(spec), g = createRng(4); return Array.from({ length: 20 }, () => m.sampleMs(g, 1)); };
    const before = draw();
    assert.throws(() => { spec.samplesMs[0] = 1; }, TypeError);
    assert.throws(() => { spec.samplesMs.length = 10; }, TypeError);
    assert.throws(() => { (spec as { n: number }).n = 1; }, TypeError);
    assert.deepEqual(draw(), before);
  });
});
