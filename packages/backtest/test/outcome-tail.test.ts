// BT-TAIL: the outcome stage waits for the exit ladder in slots, not wall-clock seconds, so a trade is never censored
// only because slots ran slower than one a second.
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { DatasetRow } from '../src/dataset/rows.ts';
import { collectCandidates, PLAN_DRIVE, solUsdAsOf } from '../src/research/candidates.ts';
import { PLAN_BARRIERS, scoreCandidates } from '../src/research/outcome.ts';
import type { PracticeWindow } from '../src/research/practice.ts';
import { SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const W: PracticeWindow = { decisionFrom: '2026-09-19', decisionTo: '2026-10-01', holdoutFrom: '2026-09-25', embargoDays: 1, confirmedBy: 'test' };
const rows = syntheticRows({ mints: 1, slots: 2.5 * 3600 * 6 });

/** The same market with every slot `ms` long: slots and order unchanged, block times stretched. */
const stretch = (ms: number): DatasetRow[] => {
  const s0 = rows[0]!.slot;
  // Cut at 30 h: before the test window's wall at any stretch used here.
  return rows.map((r) => ({ ...r, blockTime: Math.floor(T0 / 1000) + Math.floor((Number(r.slot - s0) * ms) / 1000) })).filter((r) => r.blockTime * 1000 < T0 + 30 * 3_600_000);
};

describe('exit-ladder tail', () => {
  for (const ms of [400, 10_000]) {
    test(`every filled trade is labelled when a slot lasts ${ms} ms`, () => {
      const data = stretch(ms);
      const end = data[data.length - 1]!.blockTime * 1000;
      const cands = collectCandidates(data, { window: W, policy: TRIAL_POLICY, solUsd: solUsdAsOf(SOL_USD, 1e9), ...PLAN_DRIVE }).candidates;
      const targets = cands.map(({ id, pool, decisionSlot, decisionMs, solUsd }) => ({ id, pool, decisionSlot, decisionMs, solUsd }));
      // Only decisions whose 120 min horizon plus a generous ladder margin lies inside the data.
      const inside = targets.filter((t) => t.decisionMs + 140 * 60_000 < end);
      expect(inside.length).toBeGreaterThan(0);
      const out = scoreCandidates(data, inside, { window: W, policy: TRIAL_POLICY, fills: FILL_CONFIG, scenario: 'conservative', barriers: PLAN_BARRIERS.slice(1, 2), seed: 'tail', entryMinOutBelowBps: RESEARCH_CONFIG.s0.entryMinOutBelowBps });
      const filled = out.filter((o) => o.labels[0]!.entryFilled);
      expect(filled.length).toBeGreaterThan(0);
      for (const o of filled) expect(o.labels[0]!.censored, o.id).toBe(false);
    });
  }
});
