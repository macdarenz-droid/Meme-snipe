// CFG-2 (DECISIONS "Third-opinion rulings (2026-10-04)", "Exits per universe"): strategy exits per universe, with
// CFG-1's guarantees (validation, tighten-only, session lock, hash) holding for each universe's block.
import { describe, expect, test } from 'vitest';
import {
  EXIT_UNIVERSES, HOUR_MS, MINUTE_MS, POLICY_SCHEMA_VERSION, PolicyError, TRIAL_POLICY, applyOverride, exitsFor, loadPolicy, policyHash,
  RUG_CONFIG, policyIssues, savePolicy, startSession, type Policy,
} from '../../src/config/index.ts';

const edit = (fn: (p: any) => void): Policy => {
  const p = structuredClone(TRIAL_POLICY) as any;
  fn(p);
  return p as Policy;
};

describe('CFG-2: per-universe exit parameters', () => {
  test('schema version 3 with one block for each universe in use', () => {
    expect(POLICY_SCHEMA_VERSION).toBe(3);
    expect(EXIT_UNIVERSES).toEqual(['U1', 'U2']);
    expect(Object.keys(TRIAL_POLICY.exits.universes).sort()).toEqual(['U1', 'U2']);
  });

  test("U2 keeps the values the single block had; U1 starts from risk.md S2 and U2's values where S2 is silent", () => {
    expect(TRIAL_POLICY.exits.universes.U2).toEqual({
      stopAtrTenths: 30, negativeFlowMinutes: 5, tFlatMs: 15 * MINUTE_MS, flatMinRBps: 5000, tMaxMs: 120 * MINUTE_MS,
      partialMinShareBps: 5000, partialAtRBps: 15_000, partialAtGainBps: 10_000, atrPeriod: 14, atrBarMs: MINUTE_MS, trailAtrTenths: 30,
    });
    expect(TRIAL_POLICY.exits.universes.U1).toEqual({
      stopAtrTenths: 30, negativeFlowMinutes: 5, tFlatMs: 30 * MINUTE_MS, flatMinRBps: 5000, tMaxMs: 4 * HOUR_MS,
      partialMinShareBps: 5000, partialAtRBps: 20_000, partialAtGainBps: 10_000, atrPeriod: 14, atrBarMs: 5 * MINUTE_MS, trailAtrTenths: 30,
    });
  });

  test("the deployer-sale exit stays global and equal to the rug label's creator-dump share", () => {
    expect(TRIAL_POLICY.exits.deployerSellSupplyBps).toBe(RUG_CONFIG.creatorDump.supplyBps);
    for (const u of EXIT_UNIVERSES) expect(Object.hasOwn(TRIAL_POLICY.exits.universes[u], 'deployerSellSupplyBps')).toBe(false);
  });

  test('exitsFor selects the named universe and never falls back to another', () => {
    expect(exitsFor(TRIAL_POLICY.exits, 'U1').tMaxMs).toBe(4 * HOUR_MS);
    expect(exitsFor(TRIAL_POLICY.exits, 'U2').tMaxMs).toBe(120 * MINUTE_MS);
    for (const u of ['S0', 'U3', '', 'toString', '__proto__']) expect(() => exitsFor(TRIAL_POLICY.exits, u)).toThrow(/no exit parameters/);
  });

  test('validation refuses a missing universe block, an unknown universe and a missing field in one block', () => {
    expect(policyIssues(edit((p) => { delete p.exits.universes.U1; }))).toContain('policy.exits.universes.U1: missing');
    expect(policyIssues(edit((p) => { delete p.exits.universes; }))).toContain('policy.exits.universes: missing');
    expect(policyIssues(edit((p) => { p.exits.universes.U3 = structuredClone(p.exits.universes.U2); }))).toContain('policy.exits.universes.U3: unknown field');
    expect(policyIssues(edit((p) => { delete p.exits.universes.U2.tMaxMs; }))).toContain('policy.exits.universes.U2.tMaxMs: missing');
    // The old single-block fields are gone.
    expect(policyIssues(edit((p) => { p.exits.tMaxMs = 1; }))).toContain('policy.exits.tMaxMs: unknown field');
    expect(() => loadPolicy(savePolicy(TRIAL_POLICY).replace('"U1":', '"U9":'))).toThrow(PolicyError);
  });

  test('cross-field checks run on each block', () => {
    expect(policyIssues(edit((p) => { p.exits.universes.U1.tFlatMs = p.exits.universes.U1.tMaxMs + 1; })))
      .toContain('exits.universes.U1.tFlatMs must be above zero and no later than exits.universes.U1.tMaxMs');
    expect(policyIssues(edit((p) => { p.exits.universes.U2.partialMinShareBps = 10_001; })))
      .toContain('exits.universes.U2.partialMinShareBps: basis points cannot exceed 10,000');
    expect(policyIssues(edit((p) => { p.exits.universes.U1.negativeFlowMinutes = 0; })))
      .toContain('exits.universes.U1.negativeFlowMinutes: must be at least 1');
    expect(policyIssues(edit((p) => { p.exits.universes.U1.atrBarMs = 0; }))).toContain('exits.universes.U1.atrPeriod and exits.universes.U1.atrBarMs: must be above zero');
  });

  test("tighten-only is measured against the same universe's baseline block", () => {
    // U1 T_max 3 h is above U2's 2 h but below U1's own 4 h: a tightening.
    const u1 = applyOverride(TRIAL_POLICY, { exits: { universes: { U1: { tMaxMs: 3 * HOUR_MS } } } });
    expect(u1.ok).toBe(true);
    if (u1.ok) expect(u1.changes).toEqual([{ path: 'policy.exits.universes.U1.tMaxMs', from: 4 * HOUR_MS, to: 3 * HOUR_MS }]);
    // U2 T_max 3 h is below U1's 4 h but above U2's own 2 h: a loosening.
    const u2 = applyOverride(TRIAL_POLICY, { exits: { universes: { U2: { tMaxMs: 3 * HOUR_MS } } } });
    expect(u2).toMatchObject({ ok: false, refusals: [{ kind: 'loosens', path: 'policy.exits.universes.U2.tMaxMs' }] });
    expect(applyOverride(TRIAL_POLICY, { exits: { universes: { U1: { atrBarMs: MINUTE_MS } } } }))
      .toMatchObject({ ok: false, refusals: [{ kind: 'locked', path: 'policy.exits.universes.U1.atrBarMs' }] });
    expect(applyOverride(TRIAL_POLICY, { exits: { universes: { S0: { tMaxMs: 1 } } } } as any))
      .toMatchObject({ ok: false, refusals: [{ kind: 'unknown-field', path: 'policy.exits.universes.S0' }] });
  });

  test('a per-universe loosening is refused when a session starts and while it runs', () => {
    for (const mutate of [
      (p: any) => { p.exits.universes.U1.tMaxMs += 1; },
      (p: any) => { p.exits.universes.U1.tFlatMs += 1; },
      (p: any) => { p.exits.universes.U2.trailAtrTenths += 1; },
      (p: any) => { p.exits.universes.U1.flatMinRBps -= 1; },
      (p: any) => { p.exits.universes.U2.tMaxMs = p.exits.universes.U1.tMaxMs; },
    ]) expect(() => startSession(edit(mutate))).toThrow(PolicyError);
    const session = startSession(edit((p) => { p.exits.universes.U1.tMaxMs = 3 * HOUR_MS; }));
    expect(session.changesFromBaseline.map((c) => c.path)).toEqual(['policy.exits.universes.U1.tMaxMs']);
    const looser = edit((p) => { p.exits.universes.U1.tMaxMs = 5 * HOUR_MS; });
    expect(session.requestChange(looser)).toMatchObject({ ok: false, reason: expect.stringMatching(/locked while this session runs/) });
    expect(session.policy.exits.universes.U1.tMaxMs).toBe(3 * HOUR_MS);
    expect(() => { (session.policy.exits.universes.U1 as any).tMaxMs = 5 * HOUR_MS; }).toThrow(TypeError);
  });

  test("the hash changes when one universe's block changes, and covers every block", () => {
    const base = policyHash(TRIAL_POLICY);
    const hashes = new Set([base]);
    for (const u of EXIT_UNIVERSES) {
      for (const k of Object.keys(TRIAL_POLICY.exits.universes[u])) hashes.add(policyHash(edit((p) => { p.exits.universes[u][k] += 1; })));
    }
    // Every field of every block moves the hash, and no two edits collide.
    expect(hashes.size).toBe(1 + EXIT_UNIVERSES.length * Object.keys(TRIAL_POLICY.exits.universes.U2).length);
    // Swapping two blocks is a different policy.
    expect(policyHash(edit((p) => { [p.exits.universes.U1, p.exits.universes.U2] = [p.exits.universes.U2, p.exits.universes.U1]; }))).not.toBe(base);
  });
});
