// RES-4 (docs/research/edge.md): the committed cost table reproduces from the code, and the pre-registration is
// well-formed, uses only as-of features, and copies the policy's exits exactly.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { BRACKETS, breakEvenWinRate, costRow, rows, SETUPS } from '../src/research/edge-costs.ts';
import { replaySwap, observedFeeContext } from '../../core/src/fills/index.ts';
import type { AmmSwapRow } from '../src/dataset/rows.ts';
import { collectCandidates, PLAN_DRIVE, solUsdAsOf } from '../src/research/candidates.ts';
import { PLAN_BARRIERS, scoreCandidates } from '../src/research/outcome.ts';
import type { PracticeWindow } from '../src/research/practice.ts';
import { SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const synth = syntheticRows({ mints: 1, slots: 2.5 * 3600 * 6 });
import { FEATURE_IDS } from '../src/research/tracker.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('cost math', () => {
  const committed = JSON.parse(read('research/edge/costs.json')) as { rows: ReturnType<typeof rows> };
  const now = rows();

  test('the committed table is what the code computes now; only PumpSwap setups are scored', () => {
    expect(SETUPS.map((x) => x.id)).toEqual(['young', 'u1', 'u1-1.15']);
    expect(now.length).toBe(SETUPS.length * 3);
    for (const [i, r] of now.entries()) {
      const c = committed.rows[i]!;
      expect(c.setup).toBe(r.setup);
      expect(c.fixedLamports).toBe(r.fixedLamports);
      expect(c.breakEvenPct).toBeCloseTo(r.breakEvenPct, 9);
    }
  });

  test('fixed costs are the outcome stage\'s: landed legs, failed exits on the ladder at rung 3, RENT-1 rent and failed close', () => {
    const net = FILL_CONFIG.network;
    const s = FILL_CONFIG.scenarios.conservative;
    const steps = TRIAL_POLICY.exits.ladder.steps;
    const base = Number(net.signaturesPerTx * net.baseFeePerSignature);
    const f = 1 - Number(s.landPpm.pumpswap) / 1e6;
    let failures = 0;
    for (let k = 1; k <= TRIAL_POLICY.exits.ladder.maxAttempts; k++) failures += f ** k;
    const failed = base + Number(steps[2]!.priorityFeeLamports);
    const close = Number(s.closeSuccessPpm) / 1e6;
    const dust = Number(s.dustPpm) / 1e6;
    const expected = (base + Number(net.entryPriorityFee) + Number(net.tip)) + (base + Number(steps[0]!.priorityFeeLamports) + Number(net.tip))
      + failures * failed + (1 - close * (1 - dust)) * Number(net.tokenAccountRent) + (1 - close) * (1 - dust) * failed;
    for (const r of now) expect(r.fixedLamports).toBe(Math.round(expected));
  });

  test('parity: on a still pool the outcome stage\'s mean loss equals the cost math, within its sampling error', () => {
    // No swap after 50 min: every entry and exit trades on the same pool, so −r_net × cost is fees, impact and fixed costs only.
    const still = synth.filter((r) => r.kind !== 'amm' || r.blockTime * 1000 < T0 + 50 * 60_000);
    const win: PracticeWindow = { decisionFrom: '2026-09-19', decisionTo: '2026-10-01', holdoutFrom: '2026-09-25', embargoDays: 1, confirmedBy: 'test' };
    const c = collectCandidates(still, { window: win, policy: TRIAL_POLICY, solUsd: solUsdAsOf(SOL_USD, 3 * 3_600_000), ...PLAN_DRIVE }).candidates[0]!;
    const targets = Array.from({ length: 2000 }, (_, i) => ({ id: `${c.id}#${i}`, pool: c.pool, decisionSlot: c.decisionSlot, decisionMs: c.decisionMs, solUsd: c.solUsd }));
    const out = scoreCandidates(still, targets, { window: win, policy: TRIAL_POLICY, fills: FILL_CONFIG, scenario: 'conservative', barriers: PLAN_BARRIERS.slice(1, 2), seed: 'parity', entryMinOutBelowBps: RESEARCH_CONFIG.s0.entryMinOutBelowBps });
    const losses = out.filter((o) => o.labels[0]!.entryFilled && o.labels[0]!.rNet !== null).map((o) => -o.labels[0]!.rNet! * Number(o.entryCost));
    expect(losses.length).toBeGreaterThan(800);
    const sw = still.filter((r): r is AmmSwapRow => r.kind === 'amm' && r.pool === c.pool).at(-1)!;
    const st = replaySwap(sw.pre, sw);
    if (!st.ok) throw new Error('fixture swap does not replay');
    const spend = BigInt(Math.floor((Number(TRIAL_POLICY.capital.minNotional) / 1e6 / c.solUsd) * 1e9));
    const row = costRow('fixture', 2, 120, st.trade.after, observedFeeContext(sw.fees, sw.baseSupply, { mayhemMode: false, transferFee: false, transferHook: false }), spend);
    const mean = losses.reduce((a, b) => a + b, 0) / losses.length;
    const sd = Math.sqrt(losses.reduce((a, b) => a + (b - mean) ** 2, 0) / (losses.length - 1));
    const expected = row.proportional + row.fixedLamports;
    expect(Math.abs(mean - expected)).toBeLessThan(4 * (sd / Math.sqrt(losses.length)));
    // And the same in break-even terms: the mean loss over what was paid is the break-even move.
    expect(Math.abs((100 * mean) / row.paid - row.breakEvenPct)).toBeLessThan((400 * sd) / Math.sqrt(losses.length) / row.paid);
  }, 120_000);

  test('a bigger trade has a lower hurdle on every setup; break-even win rate formula', () => {
    for (const id of ['young', 'u1', 'u1-1.15']) {
      const be = now.filter((r) => r.setup === id).map((r) => r.breakEvenPct);
      expect(be[0]!).toBeGreaterThan(be[1]!);
      expect(be[1]!).toBeGreaterThan(be[2]!);
    }
    for (const [w, l] of BRACKETS) {
      const p = breakEvenWinRate(w, l, 4);
      expect(p * w - (1 - p) * l - 4).toBeCloseTo(0, 12);
    }
  });
});

describe('pre-registration', () => {
  const text = read('research/edge/preregistration.json');
  const pre = JSON.parse(text) as {
    exits: Record<'U1' | 'U2', Record<string, number>>;
    hypotheses: { id: string; rank: number; universe: string; window: { universe: string; toMs: number }; rules: { kind: string; conds?: { f: string; dir: string; t: string }[]; stopBelowBps?: number }; edgePpm: string; medianTargetBps: number }[];
  };

  test('its sha256 is the one recorded in edge.md, so the document names exactly this file', () => {
    const sha = createHash('sha256').update(text).digest('hex');
    expect(read('docs/research/edge.md')).toContain(sha);
  });

  test('definitions fixed before data: holder growth counts owners, not token accounts; U2 flow is non-creator-user flow', () => {
    const d = (JSON.parse(text) as { definitions: Record<string, string> }).definitions;
    expect(d['holderGrowth']).toMatch(/distinct owners/);
    expect(d['holderGrowth']).toMatch(/never token accounts/);
    expect(d['holderGrowth']).toMatch(/same data coverage/);
    expect(d['nonCreatorUserFlow']).toMatch(/creator's exact address/);
    expect(d['nonCreatorUserFlow']).toMatch(/funded still counts/);
  });

  test('ids unique, ranks 1..n, universes U1 or U2 only, windows match their universe', () => {
    const h = pre.hypotheses;
    expect(new Set(h.map((x) => x.id)).size).toBe(h.length);
    expect(h.map((x) => x.rank)).toEqual(h.map((_, i) => i + 1));
    for (const x of h) {
      expect(['U1', 'U2']).toContain(x.universe);
      expect(x.window.universe).toBe(x.universe);
      expect(BigInt(x.edgePpm)).toBe(50_000n);
    }
  });

  test('feature rules use only RES-3 as-of features with finite thresholds, never sample-rate dependent counts', () => {
    for (const x of pre.hypotheses.filter((h) => h.rules.kind === 'features')) {
      expect(x.rules.conds!.length).toBeGreaterThan(0);
      for (const c of x.rules.conds!) {
        expect(FEATURE_IDS as readonly string[]).toContain(c.f);
        expect(['f_grad24', 'f_dep24']).not.toContain(c.f);
        expect(['ge', 'le']).toContain(c.dir);
        expect(Number.isFinite(Number(c.t))).toBe(true);
      }
      expect(x.rules.stopBelowBps!).toBeGreaterThan(0);
      expect(x.rules.stopBelowBps!).toBeLessThan(10_000);
    }
  });

  test('exits are the policy per-universe blocks exactly, inside the phase-1 T_max cap', () => {
    for (const u of ['U1', 'U2'] as const) {
      expect(pre.exits[u]).toEqual(TRIAL_POLICY.exits.universes[u]);
      expect(pre.exits[u]!['tMaxMs']!).toBeLessThanOrEqual(TRIAL_POLICY.exits.tMaxCapMs);
    }
  });
});
