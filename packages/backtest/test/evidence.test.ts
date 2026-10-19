// BT-3: the pre-funding evidence run (gate items 1 and 2) on a synthetic schema-3 window.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { type EvidenceInput, runEvidence } from '../src/evidence.ts';
import type { HoldoutStore } from '../src/holdout.ts';
import { asRelease, RELEASE } from './release-fixture.ts';
import { type RunOptions, type RunResult, runBacktest } from '../src/run.ts';
import { loadManifest } from '../src/dataset/dataset.ts';
import { writeDataset } from '../src/dataset/writer.ts';
import { SOL_USD, syntheticRows } from '../src/dataset/synthetic.ts';

vi.setConfig({ testTimeout: 300_000 });
const top = mkdtempSync(join(tmpdir(), 'bt3-'));
afterAll(() => rmSync(top, { recursive: true, force: true }));
const rows = syntheticRows({ mints: 3, slots: 2.5 * 3600 * 5 });
const make = (name: string, extra: Parameters<typeof writeDataset>[2]) => {
  const d = join(top, name);
  writeDataset(d, rows, extra);
  return d;
};
/** A window shaped like an assembled release (no synthetic flag; test-only, see release-fixture.ts). */
const released = (name: string, extra: Parameters<typeof writeDataset>[2]) => asRelease(make(name, extra));
const gateDir = released('gate', { leadInDays: 14, sums: true });
const input = (over: Partial<EvidenceInput> = {}): EvidenceInput => {
  const workDir = mkdtempSync(join(top, 'work-'));
  return {
    windows: [{ dir: gateDir, release: RELEASE }], mode: 'gate', replays: 10, scenario: 'conservative', seed: 'bt3', solUsd: SOL_USD,
    policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, commit: 'test-commit', ledgerReplay: replayLedgerFile, workDir, holdouts: null, ...over,
  };
};

describe('pre-funding evidence (BT-3)', () => {
  test('10 replays give one decision-log hash, with no crash, illegal state or unreconciled intent, and the ledger replays', () => {
    const e = runEvidence(input());
    expect(e).toMatchObject({ gate: true, pass: true, commit: 'test-commit', replays: 10 });
    const w = e.windows[0]!;
    expect(w.hashes.length).toBe(10);
    expect(new Set(w.hashes).size).toBe(1);
    expect(w).toMatchObject({ identicalReplays: true, crashes: 0, illegalStates: 0, unreconciledIntents: 0, mirrorMatches: true, leadInDays: 14, release: RELEASE });
    expect(w.ledgerReplay.ok).toBe(true);
    expect(w.filesChecked).toBeGreaterThan(1);
    expect(w.sha256sumsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.counts['rows']).toBe(rows.length);
    expect(w.window).toEqual({ from: '2026-09-20', toExclusive: '2026-09-21' });
  });

  test('gate mode refuses a window without SHA256SUMS or without its 14 lead-in days; the labelled mode is never gate evidence', () => {
    expect(() => runEvidence(input({ windows: [{ dir: released('nosums', { leadInDays: 14 }), release: RELEASE }] }))).toThrow(/SHA256SUMS/);
    const short = released('short', { leadInDays: 0, sums: true });
    expect(() => runEvidence(input({ windows: [{ dir: short, release: RELEASE }] }))).toThrow(/14/);
    const labelled = runEvidence(input({ windows: [{ dir: short }], mode: 'no-lead-in', replays: 2 }));
    expect(labelled).toMatchObject({ mode: 'no-lead-in', gate: false, pass: true });
  });

  test('synthetic evidence can never claim gate status (BT-3 re-run)', () => {
    const synth = make('synthetic', { leadInDays: 14, sums: true });
    // Gate and no-lead-in modes refuse a synthetic window, even under a release's name.
    expect(() => runEvidence(input({ windows: [{ dir: synth, release: RELEASE }] }))).toThrow(/synthetic window is never gate evidence/);
    expect(() => runEvidence(input({ windows: [{ dir: synth }], mode: 'no-lead-in', replays: 2 }))).toThrow(/synthetic window/);
    // The synthetic mode runs it with the gate's checks and labels it: never gate evidence.
    const e = runEvidence(input({ windows: [{ dir: synth, release: 'synthetic' }], mode: 'synthetic', replays: 2 }));
    expect(e).toMatchObject({ mode: 'synthetic', gate: false, pass: true });
    expect(e.windows[0]!.filesChecked).toBeGreaterThan(1);
    // ...and runs synthetic windows only, with the gate's checks.
    expect(() => runEvidence(input({ mode: 'synthetic', replays: 2 }))).toThrow(/synthetic windows only/);
    expect(() => runEvidence(input({ windows: [{ dir: make('synthetic-short', { leadInDays: 0, sums: true }) }], mode: 'synthetic', replays: 2 }))).toThrow(/14/);
  });

  test('synthetic rows can never reach gate: true (review W1): the writer always marks them, and gate mode needs a release', () => {
    // Exactly the bypass: synthetic rows written without asking for a mark, run as a local folder in gate mode.
    const plain = make('unasked', { leadInDays: 14, sums: true });
    expect(JSON.parse(readFileSync(join(plain, 'manifest.json'), 'utf8'))['synthetic']).toBe(true);
    expect(() => runEvidence(input({ windows: [{ dir: plain }] }))).toThrow(/assembled window release/);
    expect(() => runEvidence(input({ windows: [{ dir: plain, release: RELEASE }] }))).toThrow(/synthetic window is never gate evidence/);
    // Stripped of its mark (only a test can), a folder is still not gate evidence without a release tag.
    const stripped = released('unasked-stripped', { leadInDays: 14, sums: true });
    for (const release of [undefined, 'synthetic', 'data-test', 'data-2026-09-06']) {
      expect(() => runEvidence(input({ windows: [{ dir: stripped, ...(release === undefined ? {} : { release }) }] }))).toThrow(/assembled window release/);
    }
  });

  test('extra manifest fields cannot unset the synthetic mark (review W1c): the window stays synthetic and gate mode refuses it', () => {
    const opted = make('opt-out', { leadInDays: 14, sums: true, manifest: { synthetic: false } });
    expect(loadManifest(opted).synthetic).toBe(true);
    expect(() => runEvidence(input({ windows: [{ dir: opted, release: RELEASE }] }))).toThrow(/synthetic window is never gate evidence/);
  });

  test('every mode refuses a window with a holdout day, before anything runs (BT-WALL a)', () => {
    const from = RESEARCH_CONFIG.holdout.fromDay;
    const start = Date.parse(`${from}T00:00:00Z`) / 1000;
    // The same synthetic market moved to start on the reserved holdout start (blocks and swaps, all at or after it).
    const shift = start - rows[0]!.blockTime;
    const late = make('holdout-day', { leadInDays: 14, sums: true });
    writeDataset(late, rows.map((r) => ({ ...r, blockTime: r.blockTime + shift })), { leadInDays: 14, sums: true });
    asRelease(late);
    let ran = 0;
    const run = (o: RunOptions) => {
      ran++;
      return runBacktest(o);
    };
    for (const mode of ['gate', 'no-lead-in'] as const) {
      expect(() => runEvidence(input({ windows: [{ dir: late, release: RELEASE }], mode, run }))).toThrow(new RegExp(`${from} is at or after the reserved holdout start`));
    }
    // A day inside a registered holdout window is refused too (the registry's windows, not only the reserved start).
    const registered = { version: 2, plan: null, registry: { entries: [{ holdoutId: 'h-test', fromDay: '2026-09-20', tailEnd: '2026-09-21' }] }, attempts: [], g1: [], runs: [] } as unknown as HoldoutStore;
    expect(() => runEvidence(input({ holdouts: registered, run }))).toThrow(/inside holdout h-test/);
    // A synthetic window is held to the same wall.
    const lateSynth = make('holdout-day-synthetic', { leadInDays: 14, sums: true });
    writeDataset(lateSynth, rows.map((r) => ({ ...r, blockTime: r.blockTime + shift })), { leadInDays: 14, sums: true });
    expect(() => runEvidence(input({ windows: [{ dir: lateSynth }], mode: 'synthetic', run }))).toThrow(/reserved holdout start/);
    expect(ran).toBe(0);
  });

  test('a failing ledger replay fails the evidence', () => {
    const bad = runEvidence(input({ replays: 2, ledgerReplay: () => ({ ok: false, failure: 'diverged' }) }));
    expect(bad.pass).toBe(false);
    expect(bad.windows[0]!.ledgerReplay).toMatchObject({ ok: false, failure: 'diverged' });
  });

  describe('every pass term is required (stubbed runs)', () => {
    let cached: RunResult | undefined;
    // Without the ledger: the stubbed runs never write one (the ledger replay is stubbed too).
    const real = ({ ledgerPath: _ledger, ...o }: RunOptions): RunResult => (cached ??= runBacktest(o));
    const ok = () => ({ ok: true });
    const stubbed = (change: (r: RunResult, call: number) => RunResult) => {
      let call = 0;
      return runEvidence(input({ replays: 3, ledgerReplay: ok, run: (o) => change(real(o), call++) }));
    };
    test('the unchanged stub passes, so each failure below is its term alone', () => {
      expect(stubbed((r) => r)).toMatchObject({ pass: true, windows: [{ pass: true }] });
    });
    const terms: [string, (r: RunResult, call: number) => RunResult][] = [
      ['a crash', (r) => ({ ...r, stats: { ...r.stats, crashes: 1 } })],
      ['an illegal state', (r) => ({ ...r, stats: { ...r.stats, illegalStates: 1 } })],
      ['an unreconciled intent', (r) => ({ ...r, stats: { ...r.stats, unreconciledIntents: 1 } })],
      ['a mirror book that differs', (r) => ({ ...r, stats: { ...r.stats, mirrorMatches: false } })],
      ['a replay whose hash differs', (r, call) => (call === 2 ? { ...r, logHash: 'f'.repeat(64) } : r)],
    ];
    for (const [name, change] of terms) {
      test(`${name} fails the window and the evidence`, () => {
        const e = stubbed(change);
        expect(e.pass).toBe(false);
        expect(e.windows[0]!.pass).toBe(false);
      });
    }
  });

  test('gate mode refuses a day file SHA256SUMS does not list', () => {
    const d = released('unlisted', { leadInDays: 14, sums: true });
    const sums = join(d, 'SHA256SUMS');
    const kept = readFileSync(sums, 'utf8').split('\n').filter((l) => !/amm_trades/.test(l)).join('\n');
    writeFileSync(sums, kept);
    expect(() => runEvidence(input({ windows: [{ dir: d, release: RELEASE }] }))).toThrow(/SHA256SUMS does not list .*amm_trades/);
    expect(runEvidence(input({ windows: [{ dir: d }], mode: 'no-lead-in', replays: 2 }))).toMatchObject({ gate: false, pass: true });
  });
});
