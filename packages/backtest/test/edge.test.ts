// RES-4 (docs/research/edge.md): the committed cost table reproduces from the code, and the pre-registration is
// well-formed, uses only as-of features, and copies the policy's exits exactly.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { BRACKETS, breakEvenWinRate, rows, SETUPS } from '../src/research/edge-costs.ts';
import { FEATURE_IDS } from '../src/research/tracker.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('cost math', () => {
  const committed = JSON.parse(read('research/edge/costs.json')) as { rows: ReturnType<typeof rows> };
  const now = rows();

  test('the committed table is what the code computes now', () => {
    expect(now.length).toBe(SETUPS.length * 3);
    for (const [i, r] of now.entries()) {
      const c = committed.rows[i]!;
      expect(c.setup).toBe(r.setup);
      expect(c.fixedLamports).toBe(r.fixedLamports);
      expect(c.breakEvenPct).toBeCloseTo(r.breakEvenPct, 9);
    }
  });

  test('fixed costs: both legs landed, paid failed attempts, and rent lost when the close fails', () => {
    const net = FILL_CONFIG.network;
    const s = FILL_CONFIG.scenarios.conservative;
    const base = Number(net.signaturesPerTx * net.baseFeePerSignature);
    const leg = base + Number(net.entryPriorityFee) + Number(net.tip);
    const miss = 1 - Number(s.landPpm.pumpswap) / 1e6;
    const fails = ((1 - Number(s.dropPpm) / 1e6) * miss) / (1 - miss);
    const rentLost = (1 - (Number(s.closeSuccessPpm) / 1e6) * (1 - Number(s.dustPpm) / 1e6)) * Number(net.tokenAccountRent);
    const expected = 2 * leg + 2 * fails * (base + Number(net.entryPriorityFee)) + rentLost;
    expect(TRIAL_POLICY.exits.ladder.steps[0]!.priorityFeeLamports).toBe(net.entryPriorityFee);
    for (const r of now.filter((x) => x.setup !== 'curve')) expect(r.fixedLamports).toBe(Math.round(expected));
  });

  test('a bigger trade has a lower hurdle on every PumpSwap setup; break-even win rate formula', () => {
    for (const id of ['young', 'u1', 'u1-1.15']) {
      const be = now.filter((r) => r.setup === id).map((r) => r.breakEvenPct);
      expect(be[0]!).toBeGreaterThan(be[1]!);
      expect(be[1]!).toBeGreaterThan(be[2]!);
    }
    // Win +W with probability p, lose −L otherwise, cost c: p·W − (1 − p)·L − c = 0.
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
