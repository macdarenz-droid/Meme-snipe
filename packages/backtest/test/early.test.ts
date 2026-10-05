// BT-2e's early look: each U2 configuration on its own run through the same engine and gates, S0 beside them, and the
// engine checks, the funnel and plain trade figures (no interval, no test), labelled "early look, not proof".
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeDataset } from '../src/dataset/writer.ts';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { STUDY_CONFIG, configId, type UniverseConfig } from '../src/strategy/config.ts';
import { EARLY_LABEL, earlyDay, tradeStats } from '../src/study/early.ts';
import type { ScoredTrade } from '../src/study/score.ts';
import { type MintPlan, POOL_ACCOUNTS, studyWorld, W0 } from './study-world.ts';
import { SOL_USD } from '../src/dataset/synthetic.ts';

vi.setConfig({ testTimeout: 600_000 });

const MIN = 150;
const reclaim = (since: number) => (since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55);
const SETUP: MintPlan = { label: 'a', createSlot: 10, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: reclaim, swapEvery: 10, buySize: 3e9, sellDivisor: 8 };
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };

describe('early look', () => {
  it('gives plain trade figures: win rate, mean and median net, profit factor, worst trade, longest losing streak; no interval', () => {
    const t = (rNet: number, closedAt: number) => ({ rNet, closedAt, mint: `m${closedAt}` }) as ScoredTrade;
    const s = tradeStats([t(0.2, 1), t(-0.1, 2), t(-0.3, 3), t(0.4, 4), t(-0.05, 5)], 1);
    expect(s).toMatchObject({ trades: 5, tradesPerDay: 5, winRate: 0.4, worstNet: -0.3, longestLosingStreak: 2 });
    expect(s.meanNet).toBeCloseTo(0.03, 12);
    expect(s.medianNet).toBeCloseTo(-0.05, 12);
    expect(s.profitFactor).toBeCloseTo(0.6 / 0.45, 12);
    expect(Object.keys(s).sort()).toEqual(['longestLosingStreak', 'meanNet', 'medianNet', 'profitFactor', 'tradesPerDay', 'trades', 'winRate', 'worstNet'].sort());
    expect(tradeStats([], 2)).toMatchObject({ trades: 0, winRate: null, meanNet: null, longestLosingStreak: 0 });
    expect(tradeStats([t(0.1, 1)], 1)).toMatchObject({ profitFactor: null });
  });

  it('runs each U2 configuration on its own through the same engine and gates, with S0 beside them, labelled not proof', () => {
    const { rows, ownerPrograms } = studyWorld({ leadInDays: 15, slots: 10 + 20 * MIN + 260 * MIN, mints: [SETUP] });
    const u2 = STUDY_CONFIG.universes.find((u) => u.universe === 'U2')!;
    const configs: UniverseConfig[] = [u2, { ...u2, id: 'H4-U2-reclaim' }];
    const day = earlyDay('2026-09-20', configs, STUDY_CONFIG, {
      rows: () => rows[Symbol.iterator](), series: [sol], seed: 'e2', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
      windowEnd: W0 + 12 * 3_600_000, entriesFrom: W0, entriesTo: W0 + 10 * 3_600_000, sampleRate: 1,
      insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }), poolAccounts: POOL_ACCOUNTS, delegatesComplete: true, regime: 'assume-on', holders: { ownerPrograms },
    }, (c) => configId({ ...STUDY_CONFIG, universes: [c] }, c.id ?? c.universe), 2, FILL_CONFIG);
    expect(day.label).toBe(EARLY_LABEL);
    expect(day.variants.map((v) => v.tag)).toEqual(['U2', 'H4-U2-reclaim']);
    for (const v of day.variants) {
      expect(v).toMatchObject({ crashes: 0, illegalStates: 0 });
      expect(v.funnel!.checks).toBeGreaterThan(0);
      expect(v.stats.trades).toBe(1);
    }
    expect(day.variants[1]!.configId).toMatch(/^H4-U2-reclaim-/);
    expect(day.s0.seeds).toBe(2);
    expect(day.notes[0]).toMatch(/^Early look, not proof/);
    expect(() => earlyDay('2026-09-20', [STUDY_CONFIG.universes.find((u) => u.universe === 'U1')!], STUDY_CONFIG, {} as never, () => '', 1, FILL_CONFIG)).toThrow(/U2 configurations only/);
  });
});

describe('early look on the command line', () => {
  it('runs on an on-disk dataset the moment its day files exist, writes the report and refuses a holdout day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'early-'));
    try {
      const { rows } = studyWorld({ leadInDays: 1, blockEvery: 50, slots: 10 + 20 * MIN + 260 * MIN, mints: [SETUP] });
      // The writer keeps DATA-1's tables (raw records are RPC bytes, not rebuilt here, so holder facts are not covered).
      writeDataset(join(dir, 'ds'), rows.filter((r) => r.kind !== 'raw'), { manifest: { sampling: { launch_rate: 1 } } });
      writeFileSync(join(dir, 'sol.csv'), ['# name: SOL/USD', '# source: test', '# tag: fixed', '# bar_ms: 3600000', '# fetched_at: 2026-10-03T00:00:00Z', 'start,close',
        ...sol.bars.map((b) => `${new Date(b.start).toISOString()},${b.close}`)].join('\n'));
      const cli = join(import.meta.dirname, '..', 'src', 'study', 'cli.ts');
      const run = (days: string) => execFileSync('node', ['--no-warnings', cli, 'early', '--dataset', join(dir, 'ds'), '--sol-usd', join(dir, 'sol.csv'), '--days', days, '--seeds', '1', '--out', join(dir, 'out'), '--regime-assumed-on'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = run('2026-09-20');
      const summary = JSON.parse(stdout) as { runId: string; label: string; days: { day: string; trades: Record<string, number> }[] };
      expect(summary.label).toBe(EARLY_LABEL);
      expect(summary.days.map((d) => d.day)).toEqual(['2026-09-20']);
      expect(Object.keys(summary.days[0]!.trades)).toEqual(['U2']);
      const report = JSON.parse(readFileSync(join(dir, 'out', `${summary.runId}.json`), 'utf8')) as { kind: string; days: { variants: { funnel: { checks: number } | null }[]; notes: string[] }[] };
      expect(report.kind).toBe(`BT-2e ${EARLY_LABEL}`);
      expect(report.days[0]!.variants[0]!.funnel!.checks).toBeGreaterThan(0);
      expect(report.days[0]!.notes[0]).toMatch(/not proof/);
      // Engine validity, the funnel and descriptive figures only: no G1 or SPA verdict, no test, no interval, and no
      // wording that implies one (supervisor ruling; 01FHfb: no G1 or SPA under 10 days).
      const text = readFileSync(join(dir, 'out', `${summary.runId}.json`), 'utf8');
      const verdict = /\bG[12]\b|\bSPA\b|p-?value|significan|verdict|interval|confidence|lower|upper|\bpass(es|ed)?\b|\bbeats?\b|\bedge\b|winRate95|meanNet95/i;
      expect(text).not.toMatch(verdict);
      // The summary printed to stdout too.
      expect(stdout).not.toMatch(verdict);
      expect(JSON.parse(text).days[0].variants[0]).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
      expect(() => run('2026-09-22')).toThrow(/holdout day: the early look never reads one/);
      // A day outside the practice window, and a practice day the dataset does not hold complete, are refused too.
      expect(() => run('2026-07-01')).toThrow(/2026-07-01 is not a practice day/);
      expect(() => run('2026-09-10')).toThrow(/2026-09-10 is not a complete day in the dataset/);
      expect(() => run('2026-09-20,2026-09-10')).toThrow(/2026-09-10 is not a complete day in the dataset/);
      // `study` reads RES-4's family only from the file the study configuration pins: a given file is refused, not ignored.
      expect(() => execFileSync('node', ['--no-warnings', cli, 'study', '--dataset', join(dir, 'ds'), '--sol-usd', join(dir, 'sol.csv'), '--out', join(dir, 'out'), '--preregistration', join(dir, 'x.json'), '--regime-assumed-on'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow(/--preregistration is for the early look only/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
