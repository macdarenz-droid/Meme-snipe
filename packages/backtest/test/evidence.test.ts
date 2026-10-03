// BT-3: the pre-funding evidence run (gate items 1 and 2) on a synthetic schema-3 window.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { type EvidenceInput, runEvidence } from '../src/evidence.ts';
import { writeDataset } from './dataset-writer.ts';
import { SOL_USD, syntheticRows } from './synthetic.ts';

vi.setConfig({ testTimeout: 300_000 });
const top = mkdtempSync(join(tmpdir(), 'bt3-'));
afterAll(() => rmSync(top, { recursive: true, force: true }));
const rows = syntheticRows({ mints: 3, slots: 2.5 * 3600 * 5 });
const make = (name: string, extra: Parameters<typeof writeDataset>[2]) => {
  const d = join(top, name);
  writeDataset(d, rows, extra);
  return d;
};
const gateDir = make('gate', { leadInDays: 14, sums: true });
const input = (over: Partial<EvidenceInput> = {}): EvidenceInput => {
  const workDir = mkdtempSync(join(top, 'work-'));
  return {
    windows: [{ dir: gateDir, release: 'data-test' }], mode: 'gate', replays: 10, scenario: 'conservative', seed: 'bt3', solUsd: SOL_USD,
    policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, commit: 'test-commit', ledgerReplay: replayLedgerFile, workDir, ...over,
  };
};

describe('pre-funding evidence (BT-3)', () => {
  test('10 replays give one decision-log hash, with no crash, illegal state or unreconciled intent, and the ledger replays', () => {
    const e = runEvidence(input());
    expect(e).toMatchObject({ gate: true, pass: true, commit: 'test-commit', replays: 10 });
    const w = e.windows[0]!;
    expect(w.hashes.length).toBe(10);
    expect(new Set(w.hashes).size).toBe(1);
    expect(w).toMatchObject({ identicalReplays: true, crashes: 0, illegalStates: 0, unreconciledIntents: 0, mirrorMatches: true, leadInDays: 14, release: 'data-test' });
    expect(w.ledgerReplay.ok).toBe(true);
    expect(w.filesChecked).toBeGreaterThan(1);
    expect(w.sha256sumsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.counts['rows']).toBe(rows.length);
    expect(w.window).toEqual({ from: '2026-09-20', toExclusive: '2026-09-21' });
  });

  test('gate mode refuses a window without SHA256SUMS or without its 14 lead-in days; the labelled mode is never gate evidence', () => {
    expect(() => runEvidence(input({ windows: [{ dir: make('nosums', { leadInDays: 14 }) }] }))).toThrow(/SHA256SUMS/);
    const short = make('short', { leadInDays: 0, sums: true });
    expect(() => runEvidence(input({ windows: [{ dir: short }] }))).toThrow(/14/);
    const labelled = runEvidence(input({ windows: [{ dir: short }], mode: 'no-lead-in', replays: 2 }));
    expect(labelled).toMatchObject({ mode: 'no-lead-in', gate: false, pass: true });
  });

  test('a failing ledger replay fails the evidence', () => {
    const bad = runEvidence(input({ replays: 2, ledgerReplay: () => ({ ok: false, failure: 'diverged' }) }));
    expect(bad.pass).toBe(false);
    expect(bad.windows[0]!.ledgerReplay).toMatchObject({ ok: false, failure: 'diverged' });
  });
});
