import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loadDay, loadManifest, regimeBoundariesOf, tableOf, verifySums } from '../src/dataset/dataset.ts';
import { readSeries, usableFrom } from '../src/dataset/offchain.ts';
import { writeDataset } from './dataset-writer.ts';
import { SOL_USD, syntheticRows } from './synthetic.ts';

vi.setConfig({ testTimeout: 300_000 });
const dir = mkdtempSync(join(tmpdir(), 'ds-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const rows = syntheticRows({ mints: 2, slots: 2.5 * 3600 * 5 });
writeDataset(dir, rows);

describe('DATA-1 reader', () => {
  test('reads back every row in chain order with the replay inputs intact', () => {
    const m = loadManifest(dir);
    const back = m.days.flatMap((d) => loadDay(dir, d));
    expect(back.length).toBe(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]!;
      const b = back[i]!;
      expect(b.kind).toBe(a.kind);
      expect(b.slot).toBe(a.slot);
      if (a.kind === 'amm' && b.kind === 'amm') {
        expect([b.amount, b.mode, b.side, b.pre, b.fees, b.baseSupply]).toEqual([a.amount, a.mode, a.side, a.pre, a.fees, a.baseSupply]);
      }
      if (a.kind === 'event' && b.kind === 'event') expect(b.fields).toEqual(a.fields);
    }
  });

  test('an altered file is refused', () => {
    const m = loadManifest(dir);
    const d = m.days[0]!;
    const f = d.files[0]!;
    const path = join(dir, f.path);
    const raw = readFileSync(path);
    writeFileSync(path, Buffer.concat([raw, Buffer.of(0)]));
    try {
      expect(() => loadDay(dir, d)).toThrow(/bytes|sha256/);
    } finally {
      writeFileSync(path, raw);
    }
  });

  test('table names of day files', () => {
    expect(tableOf('days/2026-09-01/amm_trades-003.csv.zst')).toBe('amm_trades');
    expect(tableOf('events.jsonl.zst')).toBe('events');
  });
});

describe('off-chain series', () => {
  test('a fixed bar is usable one bar after its close; a revisable one only after it was fetched', () => {
    const bar = SOL_USD.bars[10]!;
    expect(usableFrom(SOL_USD, bar)).toBe(bar.start + 2 * 3_600_000);
    expect(usableFrom({ ...SOL_USD, tag: 'revisable', fetchedAt: bar.start + 10 * 3_600_000 }, bar)).toBe(bar.start + 10 * 3_600_000);
  });

  test('file format round trip', () => {
    const p = join(dir, 'sol.csv');
    writeFileSync(p, ['# name: SOL/USD', '# source: test', '# tag: fixed', '# bar_ms: 3600000', '# fetched_at: 2026-10-03T00:00:00Z', 'start,close',
      ...SOL_USD.bars.map((b) => `${new Date(b.start).toISOString()},${b.close}`)].join('\n'));
    const s = readSeries(p);
    expect(s.bars).toEqual(SOL_USD.bars);
    expect(s.tag).toBe('fixed');
  });
});

describe('command line on an on-disk dataset', () => {
  test('run: report, evidence, identical replays and a passing leak test', () => {
    const sol = join(dir, 'sol.csv');
    const out = join(dir, 'report.json');
    const ev = join(dir, 'evidence.json');
    const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const stdout = execFileSync('node', [cli, 'run', '--dataset', dir, '--sol-usd', sol, '--scenario', 'base', '--replays', '3', '--out', out, '--evidence', ev],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const summary = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(summary['identical']).toBe(true);
    expect(summary['leak']).toBe(true);
    expect(summary['crashes']).toBe(0);
    expect(summary['illegalStates']).toBe(0);
    expect(summary['unreconciledIntents']).toBe(0);
    const report = JSON.parse(readFileSync(out, 'utf8')) as { schemaVersion: number; gates: { gate: string; state: string }[]; trades: unknown[] };
    expect(report.schemaVersion).toBe(1);
    expect(report.gates.find((g) => g.gate === 'G0')?.state).toBe('pass');
    // One candidate whose single entry attempt may fail: the run is checked, not its luck.
    const evidence = JSON.parse(readFileSync(ev, 'utf8')) as { candidates: number; attempts: Record<string, number>; hashes: string[] };
    expect(evidence.candidates).toBeGreaterThan(0);
    expect(Object.values(evidence.attempts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(new Set(evidence.hashes).size).toBe(1);
    expect(report.trades.length).toBe(summary['trades']);
  });

  test('holdout prints only the sealed hash and counts', () => {
    const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const stdout = execFileSync('node', [cli, 'holdout', '--dataset', dir, '--sol-usd', join(dir, 'sol.csv'), '--scenario', 'conservative', '--ledger', join(dir, 'h.sqlite')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const out = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['counts', 'ledgerHash']);
  });
});

describe('release-asset layout', () => {
  test('flat <day>__<file> names load, SHA256SUMS is enforced, and the program-upgrade key becomes a regime boundary', () => {
    const flat = mkdtempSync(join(tmpdir(), 'flat-'));
    try {
      const m = loadManifest(dir);
      const names: string[] = ['manifest.json'];
      writeFileSync(join(flat, 'manifest.json'), readFileSync(join(dir, 'manifest.json')));
      for (const d of m.days) for (const f of d.files) {
        const name = `${d.day}__${f.path.slice(f.path.lastIndexOf('/') + 1)}`;
        writeFileSync(join(flat, name), readFileSync(join(dir, f.path)));
        names.push(name);
      }
      const sums = names.map((n) => `${createHash('sha256').update(readFileSync(join(flat, n))).digest('hex')}  ${n}`).join('\n');
      writeFileSync(join(flat, 'SHA256SUMS'), `${sums}\n`);
      expect(verifySums(flat)).toBe(names.length);
      expect(m.days.flatMap((d) => loadDay(flat, d)).length).toBe(rows.length);
      const victim = join(flat, names[1]!);
      const raw = readFileSync(victim);
      writeFileSync(victim, Buffer.concat([raw, Buffer.of(1)]));
      expect(() => verifySums(flat)).toThrow(/does not match/);
      writeFileSync(victim, raw);
      const withUpgrade = { ...m, program_upgrade_2026_10_02: { note: 'x', first_extra_hex_curve: { slot: 452654900 }, first_extra_hex_amm: { slot: 452654883 }, first_unknown_event: null } };
      expect(regimeBoundariesOf(withUpgrade)).toEqual([{ slot: 452654883n, label: 'program_upgrade_2026_10_02' }]);
      expect(regimeBoundariesOf(m)).toEqual([]);
      expect(regimeBoundariesOf({ ...withUpgrade, program_upgrade_2026_10_02: { ...withUpgrade.program_upgrade_2026_10_02, slot: 452654000 } })).toEqual([{ slot: 452654000n, label: 'program_upgrade_2026_10_02' }]);
      // Names that leave the directory are refused before anything is read.
      for (const bad of ['../outside.csv', '/etc/passwd', 'a/../../x', '..']) {
        writeFileSync(join(flat, 'SHA256SUMS'), `${'0'.repeat(64)}  ${bad}\n`);
        expect(() => verifySums(flat), bad).toThrow(/outside the dataset directory/);
      }
    } finally {
      rmSync(flat, { recursive: true, force: true });
    }
  });
});
