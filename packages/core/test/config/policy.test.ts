import { describe, expect, test } from 'vitest';
import {
  PolicyError, TRIAL_POLICY, assertValidPolicy, canonicalPolicy, loadPolicy, policyHash, policyIssues, savePolicy, sol, startSession, usd,
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
    expect([p.gates.hardHolderBps, p.gates.singleHolderBps, p.gates.top10Bps, p.gates.insiderBps]).toEqual([4000, 1000, 3500, 1500]);
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
    expect(issues.length).toBeGreaterThanOrEqual(2);
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

  test('a session will not start on an inconsistent policy', () => {
    expect(() => startSession(edit((p) => { p.capital.minNotional = 6_000_000n; }) as Policy)).toThrow(PolicyError);
  });

  test('still refuses after the session ends; a new policy needs a new session', () => {
    const session = startSession(TRIAL_POLICY);
    session.end();
    expect(session.running).toBe(false);
    expect(session.requestChange(TRIAL_POLICY).reason).toContain('start a new session');
    const next = startSession(edit((p) => { p.capital.maxNotional = 10_000_000n; }) as Policy);
    expect(next.policy.capital.maxNotional).toBe(10_000_000n);
  });
});

const PINNED_TRIAL_HASH = '77fd9398521b87aadcded5758644e34162a0b45208d2de943e3153e6eb81fa7d';
