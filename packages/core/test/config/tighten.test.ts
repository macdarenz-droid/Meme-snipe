import { describe, expect, test } from 'vitest';
import { POLICY_RULES, TRIAL_POLICY, applyOverride, policyHash, ruleLeafPaths, type Rule } from '../../src/config/index.ts';
import { withLeaf } from './helpers.ts';

const ruleAt = (path: string): Rule => path.split('.').slice(1).reduce<any>((r, k) => r[k], POLICY_RULES);
const paths = ruleLeafPaths();
const byRule = (rule: Rule): string[] => paths.filter((p) => ruleAt(p) === rule);

describe('CFG-1 item 4: tighten-only overrides', () => {
  test('every policy field has a rule (completeness)', () => {
    const leaves: string[] = [];
    const visit = (v: unknown, path: string): void => {
      if (Array.isArray(v)) { visit(v[0], path); return; }
      if (typeof v === 'object' && v !== null) { for (const [k, x] of Object.entries(v)) visit(x, `${path}.${k}`); return; }
      leaves.push(path);
    };
    visit(TRIAL_POLICY, 'policy');
    expect([...paths].sort()).toEqual([...leaves].sort());
  });

  test('an empty override changes nothing and keeps the hash', () => {
    const r = applyOverride(TRIAL_POLICY, {});
    expect(r.ok && r.versionHash).toBe(policyHash(TRIAL_POLICY));
    expect(r.ok && r.changes).toEqual([]);
  });

  test.each(byRule('max'))('cap %s: raising is refused', (path) => {
    for (const looser of withLeaf(path, 1)) {
      const r = applyOverride(TRIAL_POLICY, looser);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.refusals.map((x) => x.kind)).toEqual(['loosens']);
      expect(!r.ok && r.refusals[0]?.reason).toContain('raises a cap');
    }
  });

  test.each(byRule('max'))('cap %s: lowering is never refused as a loosening', (path) => {
    for (const tighter of withLeaf(path, -1)) {
      const r = applyOverride(TRIAL_POLICY, tighter);
      if (!r.ok) expect(r.refusals.every((x) => x.kind === 'invalid')).toBe(true);
      else expect(r.changes).toHaveLength(1);
    }
  });

  test.each(byRule('min'))('floor %s: lowering is refused', (path) => {
    for (const looser of withLeaf(path, -1)) {
      const r = applyOverride(TRIAL_POLICY, looser);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.refusals.map((x) => x.kind)).toEqual(['loosens']);
      expect(!r.ok && r.refusals[0]?.reason).toContain('lowers a floor');
    }
  });

  test.each(byRule('min'))('floor %s: raising is never refused as a loosening', (path) => {
    for (const tighter of withLeaf(path, 1)) {
      const r = applyOverride(TRIAL_POLICY, tighter);
      if (!r.ok) expect(r.refusals.every((x) => x.kind === 'invalid')).toBe(true);
      else expect(r.changes).toHaveLength(1);
    }
  });

  test.each(byRule('locked'))('locked %s: any change is refused', (path) => {
    for (const delta of [1, -1]) {
      for (const changed of withLeaf(path, delta)) {
        const r = applyOverride(TRIAL_POLICY, changed);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.refusals.map((x) => x.kind)).toEqual(['locked']);
      }
    }
  });

  test('the label is free to change', () => {
    const r = applyOverride(TRIAL_POLICY, { name: 'tighter' });
    expect(r.ok && r.policy.name).toBe('tighter');
    expect(r.ok && r.versionHash).not.toBe(policyHash(TRIAL_POLICY));
  });

  test('a mixed override is refused as a whole when one field loosens', () => {
    const r = applyOverride(TRIAL_POLICY, { capital: { maxNotional: 4_000_000n as never, bankroll: 21_000_000n as never } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusals.map((x) => x.path)).toEqual(['policy.capital.bankroll']);
  });

  test('a tightening override returns a new policy with a new hash and lists each change', () => {
    const r = applyOverride(TRIAL_POLICY, { capital: { maxNotional: 4_000_000n as never }, loss: { dailyBps: 500 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.capital.maxNotional).toBe(4_000_000n);
    expect(r.policy.capital.minNotional).toBe(2_000_000n);
    expect(r.versionHash).toBe(policyHash(r.policy));
    expect(r.versionHash).not.toBe(policyHash(TRIAL_POLICY));
    expect(r.changes).toEqual([
      { path: 'policy.capital.maxNotional', from: 5_000_000n, to: 4_000_000n },
      { path: 'policy.loss.dailyBps', from: 750, to: 500 },
    ]);
  });

  test('the input policy is never mutated', () => {
    const before = policyHash(TRIAL_POLICY);
    applyOverride(TRIAL_POLICY, { loss: { dailyBps: 500 } });
    applyOverride(TRIAL_POLICY, { loss: { dailyBps: 900 } });
    expect(policyHash(TRIAL_POLICY)).toBe(before);
  });

  test('unknown fields, wrong types and a changed list length are refused', () => {
    const unknown = applyOverride(TRIAL_POLICY, { loss: { nope: 1 } } as never);
    expect(!unknown.ok && unknown.refusals.map((x) => x.kind)).toEqual(['unknown-field']);
    const wrong = applyOverride(TRIAL_POLICY, { capital: { maxNotional: 4 } } as never);
    expect(!wrong.ok && wrong.refusals.map((x) => x.kind)).toEqual(['wrong-type']);
    const shorter = applyOverride(TRIAL_POLICY, { exits: { ladder: { steps: TRIAL_POLICY.exits.ladder.steps.slice(0, 2) } } });
    expect(!shorter.ok && shorter.refusals.map((x) => x.kind)).toEqual(['locked']);
  });

  test('a tightening that leaves the policy inconsistent is refused as invalid', () => {
    const r = applyOverride(TRIAL_POLICY, { capital: { maxNotional: 1_000_000n as never } });
    expect(!r.ok && r.refusals[0]?.kind).toBe('invalid');
  });

  test('cannot raise the bankroll, the trade sizes or the loss limits (the headline limits)', () => {
    for (const override of [
      { capital: { bankroll: 40_000_000n } },
      { capital: { minNotional: 3_000_000n } },
      { capital: { maxNotional: 6_000_000n } },
      { positions: { maxOpen: 2 } },
      { loss: { dailyBps: 1000 } },
      { loss: { weeklyBps: 2500 } },
      { loss: { killSwitchFloorBps: 6000 } },
    ]) {
      expect(applyOverride(TRIAL_POLICY, override as never).ok).toBe(false);
    }
  });
});
