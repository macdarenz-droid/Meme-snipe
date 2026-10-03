import { describe, expect, test } from 'vitest';
import {
  APPROVED_BASELINES, DEFAULT_BASELINE_HASH, PolicyError, TRIAL_POLICY, assertValidPolicy, canonicalPolicy, loadPolicy, policyHash, policyIssues, savePolicy,
  sol, startSession, startSessionFromText, usd,
  type Policy,
} from '../../src/config/index.ts';
import * as viaSubpath from '@meme-snipe/core/config';

const edit = (fn: (p: any) => void): unknown => {
  const p = structuredClone(TRIAL_POLICY) as any;
  fn(p);
  return p;
};

describe('CFG-1 item 1: typed policy, trial preset, validation', () => {
  test('the trial preset is $20 with $2 to $5 trades and passes validation', () => {
    expect(TRIAL_POLICY.capital).toEqual({ bankroll: 20_000_000n, minNotional: 2_000_000n, maxNotional: 5_000_000n, drawdownResetBps: 1000 });
    expect(policyIssues(TRIAL_POLICY)).toEqual([]);
  });

  test('the preset matches the architecture limits (R1-R16, section 7, section 9)', () => {
    const p = TRIAL_POLICY;
    expect([p.positions.maxOpen, p.positions.maxEntriesPerDay, p.positions.maxEntriesPerMintPerDay]).toEqual([1, 3, 1]);
    expect(p.reserve.opsFloor).toBe(15_000_000n);
    expect([p.loss.plannedRiskBps, p.loss.stopMaxBps, p.loss.dailyBps, p.loss.weeklyBps, p.loss.killSwitchFloorBps]).toEqual([275, 2000, 750, 2000, 7000]);
    expect(p.liquidity.floorUsd).toBe(15_000_000_000n);
    expect(p.costGate.maxRoundTripBps).toBe(500);
    expect([p.gates.hardHolderBps, p.gates.singleHolderBps, p.gates.top10Bps, p.gates.insiderBps]).toEqual([4000, 1000, 3000, 1500]);
    expect([p.gates.devClusterBps, p.gates.serialMaxMints24h, p.gates.deployerRugLookbackDays]).toEqual([500, 2, 14]);
    expect(p.exits.ladder.steps.map((s) => s.priorityFeeLamports)).toEqual([20_000n, 60_000n, 150_000n, 500_000n]);
    expect(p.exits.ladder.maxFeePerAttempt).toBe(500_000n);
  });

  test('amount helpers parse decimals exactly', () => {
    expect(usd('0.5')).toBe(500_000n);
    expect(sol('0.015')).toBe(15_000_000n);
    expect(() => usd('1.0000001')).toThrow(RangeError);
    expect(() => sol('-1')).toThrow(RangeError);
  });

  test.each<[string, (p: any) => void, string]>([
    ['min above max', (p) => { p.capital.minNotional = 6_000_000n; }, 'minNotional is larger than capital.maxNotional'],
    ['max above bankroll', (p) => { p.capital.maxNotional = 21_000_000n; }, 'larger than the bankroll'],
    ['zero bankroll', (p) => { p.capital.bankroll = 0n; }, 'bankroll: must be above zero'],
    ['negative limit', (p) => { p.loss.dailyBps = -1; }, 'loss.dailyBps: must not be negative'],
    ['negative money', (p) => { p.reserve.opsFloor = -1n; }, 'reserve.opsFloor: must not be negative'],
    ['daily loss larger than bankroll', (p) => { p.loss.dailyBps = 10_001; }, 'basis points cannot exceed 10,000'],
    ['daily loss larger than weekly', (p) => { p.loss.dailyBps = 2500; }, 'daily loss) is larger than loss.weeklyBps'],
    ['weekly loss past the kill switch room', (p) => { p.loss.weeklyBps = 3500; }, 'room above the kill-switch floor'],
    ['planned risk above daily loss', (p) => { p.loss.plannedRiskBps = 800; }, 'plannedRiskBps'],
    ['fractional count', (p) => { p.positions.maxOpen = 1.5; }, 'must be a whole number'],
    ['zero open positions', (p) => { p.positions.maxOpen = 0; }, 'maxOpen: must be at least 1'],
    ['per-mint entries above per-day', (p) => { p.positions.maxEntriesPerMintPerDay = 4; }, 'larger than maxEntriesPerDay'],
    ['holder limits out of order', (p) => { p.gates.singleHolderBps = 5000; }, 'singleHolderBps is larger'],
    ['u1 floor below base floor', (p) => { p.liquidity.u1FloorUsd = 1n; }, 'u1FloorUsd is lower'],
    ['flat time after max time', (p) => { p.exits.tFlatMs = p.exits.tMaxMs + 1; }, 'tFlatMs'],
    ['ladder fee above the per-attempt ceiling', (p) => { p.exits.ladder.steps[3].priorityFeeLamports = 600_000n; }, 'above exits.ladder.maxFeePerAttempt'],
    ['zero exit fee', (p) => { p.exits.ladder.steps[0].priorityFeeLamports = 0n; }, 'steps[0].priorityFeeLamports: must be above zero'],
    ['zero exit slippage allowance', (p) => { p.exits.ladder.steps[3].minOutBelowTriggerBps = 0; }, 'steps[3].minOutBelowTriggerBps: must be above zero'],
    ['zero fee ceiling', (p) => { p.exits.ladder.maxFeePerAttempt = 0n; }, 'maxFeePerAttempt: must be above zero'],
    ['dev cluster above insider cap', (p) => { p.gates.devClusterBps = 1600; }, 'devClusterBps is larger than gates.insiderBps'],
    ['no rug look-back', (p) => { p.gates.deployerRugLookbackDays = 0; }, 'deployerRugLookbackDays: must be at least 1'],
    ['ladder gets milder', (p) => { p.exits.ladder.steps[2].minOutBelowTriggerBps = 100; }, 'milder than the step before'],
    ['reserve does not cover attempts', (p) => { p.reserve.exitAttempts = 4; }, 'does not cover'],
    ['unknown field', (p) => { p.extra = 1; }, 'unknown field'],
    ['missing field', (p) => { delete p.capital.bankroll; }, 'capital.bankroll: missing'],
    ['number where money belongs', (p) => { p.capital.bankroll = 20; }, 'must be a bigint'],
  ])('rejects: %s', (_name, mutate, expected) => {
    const issues = policyIssues(edit(mutate));
    expect(issues.join(' | ')).toContain(expected);
    expect(() => assertValidPolicy(edit(mutate))).toThrow(PolicyError);
  });

  test('reports every problem in one pass', () => {
    const issues = policyIssues(edit((p) => { p.capital.minNotional = 6_000_000n; p.positions.maxOpen = 0; }));
    expect(issues).toEqual([
      'capital.minNotional is larger than capital.maxNotional',
      'positions.maxOpen: must be at least 1',
    ]);
  });

  test('a field supplied through the prototype is not a field', () => {
    const p = edit((x) => { delete x.loss.dailyBps; }) as any;
    p.loss = Object.assign(Object.create({ dailyBps: 750 }), p.loss);
    const issues = policyIssues(p);
    expect(issues.join(' | ')).toMatch(/plain object|loss\.dailyBps: missing/);
  });

  test('the exported trial policy cannot be changed at runtime', () => {
    expect(Object.isFrozen(TRIAL_POLICY)).toBe(true);
    expect(() => { (TRIAL_POLICY.capital as any).maxNotional = 10n ** 10n; }).toThrow(TypeError);
    expect(() => { (TRIAL_POLICY.exits.ladder.steps as any).push({}); }).toThrow(TypeError);
    expect(() => { (TRIAL_POLICY.exits.ladder.steps[0] as any).priorityFeeLamports = 0n; }).toThrow(TypeError);
    expect(TRIAL_POLICY.capital.maxNotional).toBe(5_000_000n);
  });

  test('the config subpath export resolves', () => {
    expect(viaSubpath.TRIAL_POLICY).toBe(TRIAL_POLICY);
  });
});

describe('CFG-1 item 2: version hash', () => {
  test('the same policy always has the same hash, whatever the key order', () => {
    const reordered = Object.fromEntries(Object.entries(TRIAL_POLICY).reverse()) as unknown as Policy;
    expect(policyHash(reordered)).toBe(policyHash(TRIAL_POLICY));
    expect(policyHash(structuredClone(TRIAL_POLICY))).toBe(policyHash(TRIAL_POLICY));
    expect(policyHash(TRIAL_POLICY)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('canonical text sorts keys and writes bigint as decimal strings', () => {
    expect(canonicalPolicy({ b: 2n, a: [1, { d: 4n, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":"4"}],"b":"2"}');
    expect(canonicalPolicy(TRIAL_POLICY)).toContain('"bankroll":"20000000"');
  });

  test('any changed value changes the hash', () => {
    const changed = edit((p) => { p.capital.bankroll += 1n; });
    expect(policyHash(changed)).not.toBe(policyHash(TRIAL_POLICY));
    const renamed = edit((p) => { p.name = 'other'; });
    expect(policyHash(renamed)).not.toBe(policyHash(TRIAL_POLICY));
  });

  test('has a pinned value for the trial preset, so an accidental change to the defaults is visible', () => {
    expect(policyHash(TRIAL_POLICY)).toBe(PINNED_TRIAL_HASH);
  });

  test('save then load gives the same policy and hash', () => {
    const text = savePolicy(TRIAL_POLICY);
    const loaded = loadPolicy(text);
    expect(loaded.policy).toEqual(TRIAL_POLICY);
    expect(loaded.versionHash).toBe(policyHash(TRIAL_POLICY));
  });

  test('load rejects bad text, wrong types and inconsistent values', () => {
    expect(() => loadPolicy('not json')).toThrow(PolicyError);
    const asJson = (p: unknown): string => canonicalPolicy(p);
    expect(() => loadPolicy(asJson(edit((p) => { p.capital.minNotional = 6_000_000n; })))).toThrow(/larger than capital.maxNotional/);
    expect(() => loadPolicy(asJson(edit((p) => { p.capital.bankroll = 'twenty'; })))).toThrow(PolicyError);
  });
});

describe('CFG-1 item 3: session lock', () => {
  test('a change during a running session is refused with a reason', () => {
    const session = startSession(TRIAL_POLICY);
    const looser = edit((p) => { p.capital.maxNotional = 10_000_000n; });
    const tighter = edit((p) => { p.capital.maxNotional = 4_000_000n; });
    for (const proposed of [looser, tighter, TRIAL_POLICY]) {
      const result = session.requestChange(proposed);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('locked while this session runs');
    }
    expect(session.policy.capital.maxNotional).toBe(5_000_000n);
    expect(session.running).toBe(true);
  });

  test('the loaded policy cannot be written to', () => {
    const session = startSession(TRIAL_POLICY);
    expect(() => { (session.policy.capital as any).maxNotional = 10_000_000n; }).toThrow(TypeError);
    expect(() => { (session.policy.exits.ladder.steps[0] as any).priorityFeeLamports = 1n; }).toThrow(TypeError);
    expect(() => { (session.policy.exits.ladder.steps as any).push({}); }).toThrow(TypeError);
  });

  test('the session holds its own copy, so editing the source later changes nothing', () => {
    const source = structuredClone(TRIAL_POLICY) as any;
    const session = startSession(source);
    source.capital.maxNotional = 10_000_000n;
    expect(session.policy.capital.maxNotional).toBe(5_000_000n);
    expect(session.versionHash).toBe(policyHash(TRIAL_POLICY));
  });

  test('a policy that changes between the check and the lock cannot get through (getter returns $5, then $20,000)', () => {
    const hostile = structuredClone(TRIAL_POLICY) as any;
    let reads = 0;
    Object.defineProperty(hostile.capital, 'maxNotional', { enumerable: true, get: () => (++reads <= 4 ? 5_000_000n : 20_000_000_000n) });
    let session: ReturnType<typeof startSession> | undefined;
    try { session = startSession(hostile); } catch { /* refusing is fine */ }
    if (session) {
      // If it starts, the locked value must be the one that was validated, and it must be within the baseline.
      expect(session.policy.capital.maxNotional).toBeLessThanOrEqual(5_000_000n);
      expect(policyIssues(session.policy)).toEqual([]);
    }
    expect(reads).toBeLessThanOrEqual(1);
  });

  test('a session will not start on an inconsistent policy', () => {
    expect(() => startSession(edit((p) => { p.capital.minNotional = 6_000_000n; }) as Policy)).toThrow(PolicyError);
  });

  test('a session will not start on a policy with a missing field (it is not filled in from the baseline)', () => {
    expect(() => startSession(edit((p) => { delete p.loss.dailyBps; }) as Policy)).toThrow(/loss\.dailyBps: missing/);
  });

  test('code cannot raise a limit: a looser policy is refused on every kind of field', () => {
    for (const mutate of [
      (p: any) => { p.capital.bankroll = 20_000_000_000n; p.capital.maxNotional = 20_000_000_000n; },
      (p: any) => { p.capital.maxNotional = 5_000_001n; },
      (p: any) => { p.loss.dailyBps = 751; },
      (p: any) => { p.loss.killSwitchFloorBps = 6999; },
      (p: any) => { p.positions.maxOpen = 2; },
      (p: any) => { p.gates.top10Bps = 3001; },
      (p: any) => { p.liquidity.floorUsd = 1n; },
      (p: any) => { p.gates.deployerRugLookbackDays = 13; },
    ]) {
      expect(() => startSession(edit(mutate) as Policy)).toThrow(PolicyError);
    }
  });

  test('a stricter policy starts, and records what differs from the baseline', () => {
    const session = startSession(edit((p) => { p.loss.dailyBps = 500; p.capital.maxNotional = 4_000_000n; }) as Policy);
    expect(session.baselineHash).toBe(DEFAULT_BASELINE_HASH);
    expect(session.changesFromBaseline.map((c) => c.path).sort()).toEqual(['policy.capital.maxNotional', 'policy.loss.dailyBps']);
    expect(session.versionHash).not.toBe(DEFAULT_BASELINE_HASH);
  });

  test('the baseline cannot be chosen freely: unknown hashes are refused and the approved list is frozen', () => {
    expect(() => startSession(TRIAL_POLICY, { baselineHash: 'a'.repeat(64) })).toThrow(/not an approved policy version/);
    expect(Object.isFrozen(APPROVED_BASELINES)).toBe(true);
    expect(() => { (APPROVED_BASELINES as Policy[]).push(edit((p) => { p.capital.bankroll = 99_000_000n; }) as Policy); }).toThrow(TypeError);
    expect(policyHash(APPROVED_BASELINES[0])).toBe(DEFAULT_BASELINE_HASH);
    for (const b of APPROVED_BASELINES) expect(policyIssues(b)).toEqual([]);
  });

  test('a saved policy file goes through the same baseline check', () => {
    expect(startSessionFromText(savePolicy(TRIAL_POLICY)).versionHash).toBe(policyHash(TRIAL_POLICY));
    const looser = canonicalPolicy(edit((p) => { p.loss.dailyBps = 900; }));
    expect(() => startSessionFromText(looser)).toThrow(PolicyError);
  });

  test('still refuses after the session ends', () => {
    const session = startSession(TRIAL_POLICY);
    session.end();
    expect(session.running).toBe(false);
    expect(session.requestChange(TRIAL_POLICY).reason).toContain('start a new session');
  });
});

describe('CFG-1: hidden limits in a saved policy file', () => {
  const text = (mutate: (p: any) => void): string => canonicalPolicy(edit(mutate));

  test('a "__proto__" key cannot hide a limit (the reviewer\'s file)', () => {
    const base = JSON.parse(savePolicy(TRIAL_POLICY));
    delete base.loss.dailyBps;
    const evil = JSON.stringify(base).replace('"loss":{', '"loss":{"__proto__":{"dailyBps":750.5},');
    expect(() => loadPolicy(evil)).toThrow(/__proto__.*not allowed/);
    // And through a merged policy object in code:
    const p = structuredClone(TRIAL_POLICY) as any;
    delete p.loss.dailyBps;
    Object.setPrototypeOf(p.loss, { dailyBps: 750.5 });
    expect(policyIssues(p).length).toBeGreaterThan(0);
    expect(() => startSession(p)).toThrow(PolicyError);
  });

  test.each(['constructor', 'prototype'])('the key "%s" is refused', (key) => {
    const evil = savePolicy(TRIAL_POLICY).replace('"loss":{', `"loss":{"${key}":{},`);
    expect(() => loadPolicy(evil)).toThrow(/not allowed/);
  });

  test('duplicate keys are refused (the last would silently win)', () => {
    const dup = savePolicy(TRIAL_POLICY).replace('"dailyBps":750', '"dailyBps":750,"dailyBps":9000');
    expect(() => loadPolicy(dup)).toThrow(/duplicate key "dailyBps"/);
  });

  test('missing and unknown keys are refused', () => {
    const missing = savePolicy(TRIAL_POLICY).replace('"dailyBps":750,', '');
    expect(() => loadPolicy(missing)).toThrow(/loss\.dailyBps: missing/);
    const extra = savePolicy(TRIAL_POLICY).replace('"loss":{', '"loss":{"hidden":1,');
    expect(() => loadPolicy(extra)).toThrow(/loss\.hidden: unknown field/);
  });

  test('every field is range-checked on load, the same as in code', () => {
    expect(() => loadPolicy(savePolicy(TRIAL_POLICY).replace('"dailyBps":750', '"dailyBps":750.5'))).toThrow(/whole number/);
    expect(() => loadPolicy(savePolicy(TRIAL_POLICY).replace('"dailyBps":750', '"dailyBps":10001'))).toThrow(/cannot exceed 10,000/);
    expect(() => loadPolicy(text((p) => { p.exits.ladder.steps[0].priorityFeeLamports = 0n; }))).toThrow(/above zero/);
    expect(() => loadPolicy(savePolicy(TRIAL_POLICY) + ' x')).toThrow(/unexpected text/);
    expect(() => loadPolicy('{"a":')).toThrow(PolicyError);
  });

  test('what loads is what is hashed: every field of the loaded policy is an own field covered by the hash', () => {
    const { policy, versionHash } = loadPolicy(savePolicy(TRIAL_POLICY));
    expect(policyHash(policy)).toBe(versionHash);
    expect(canonicalPolicy(policy)).toBe(savePolicy(TRIAL_POLICY));
  });
});

const PINNED_TRIAL_HASH = '889d38c2fbfe9dd189dd106b73bded3e1f83397c687b472428b6195447926346';
