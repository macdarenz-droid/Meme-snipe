// The engine-facing ledger API cannot read labels, trials or gate results. Outcomes live in a separate
// scoring file that the ledger code never opens, attaches or imports.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as engineApi from '../../src/ledger/index.ts';
import { openLedger, openLedgerReader } from '../../src/ledger/index.ts';
import { connectionOf } from '../../src/ledger/ledger.ts';
import { openScoringReader, openScoringStore } from '../../src/ledger/scoring/index.ts';
import { entryIntent, MINT } from '../fixtures.ts';
import { tempPath } from './helpers.ts';

const CORE_SRC = resolve(dirname(new URL(import.meta.url).pathname), '../../src');
const LEDGER_DIR = join(CORE_SRC, 'ledger');
const PACKAGES = resolve(CORE_SRC, '../..');
const MARKER = 'FUTURE_ONLY_MARKER_7f3a';
const SCORING_TABLES = ['label_tb', 'experiment_trial', 'promotion_gate_result'];

/** Every file reachable by relative imports from the engine-facing entry point. */
const moduleGraph = (entry: string): string[] => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)) visit(resolve(dirname(file), m[1]!));
  };
  visit(entry);
  return [...seen];
};

const setup = () => {
  const ledgerPath = tempPath();
  const scoringPath = join(dirname(ledgerPath), 'scoring.db');
  const ledger = openLedger(ledgerPath, 'backtest');
  ledger.recordIntent(entryIntent(1), { status: 'candidate', ts: 1 });
  const snapshotId = ledger.recordFeatureSnapshot({
    mint: MINT, venue: 'pumpswap', quoteMint: 'So11111111111111111111111111111111111111112', decisionTs: 5, asOfSlot: 9n,
    maxReceiptTs: 5, featuresetVer: 'f1', features: { a: 1 },
  });
  const scoring = openScoringStore(scoringPath, ledgerPath);
  scoring.recordLabel({
    snapshotId, cfgId: MARKER, scenario: 'conservative', execModelVer: 'x1', entryFilled: true, rNet: -0.6,
    netLamports: -9_600_000n, blocked: false, censored: false, labelledAt: 6,
  });
  scoring.recordTrial({ createdTs: 6, split: MARKER, nTrades: 1, perDayReturns: [0.1] });
  scoring.recordGateResult({ gate: 'G1', strategyVer: MARKER, evaluatedTs: 6, passed: false, reasons: [MARKER], metrics: { dsr: 0.1 } });
  return { ledgerPath, scoringPath, ledger, scoring, snapshotId };
};

describe('labels are out of the engine\'s reach', () => {
  it('the scoring stage stores labels exactly, with derived y_meta and y_severe, and checks the snapshot exists', () => {
    const { ledger, scoring, scoringPath, snapshotId } = setup();
    const [label] = scoring.labels(snapshotId);
    expect(label).toMatchObject({ cfgId: MARKER, netLamports: -9_600_000n, yMeta: 0, ySevere: 1 });
    expect(scoring.trialCount()).toBe(1);
    expect(() => scoring.recordLabel({ snapshotId: 999n, cfgId: 'c', scenario: 'base', execModelVer: 'x', entryFilled: false, blocked: false, censored: true, labelledAt: 7 }))
      .toThrow(/no feature snapshot 999/);
    scoring.close();
    ledger.close();
    const reader = openScoringReader(scoringPath);
    expect(reader.gateResults(MARKER)).toEqual([{ gate: 'G1', strategyVer: MARKER, evaluatedTs: 6, passed: false, reasons: [MARKER], metrics: { dsr: 0.1 } }]);
    reader.close();
  });

  it('the ledger file holds no outcome table and attaches nothing', () => {
    const { ledger, scoring, ledgerPath } = setup();
    const db = connectionOf(ledger);
    const names = db.prepare("SELECT name FROM sqlite_master").all().map((r) => String(r['name']));
    for (const t of SCORING_TABLES) expect(names).not.toContain(t);
    expect(db.prepare('PRAGMA database_list').all().map((r) => r['name'])).toEqual(['main']);
    scoring.close();
    ledger.close();
    // Nothing from the scoring file ever lands in the ledger file.
    expect(readFileSync(ledgerPath).includes(MARKER)).toBe(false);
  });

  it('the ledger API refuses to open the scoring file, as writer or reader', () => {
    const { ledger, scoring, scoringPath } = setup();
    scoring.close();
    expect(() => openLedger(scoringPath, 'backtest')).toThrow(/does not match this code's ledger migration/);
    expect(() => openLedgerReader(scoringPath)).toThrow(/does not match this code's ledger migration/);
    ledger.close();
  });

  it('the engine entry point exposes no way to reach outcomes', () => {
    const exported = Object.keys(engineApi).sort();
    expect(exported).toEqual(['Ledger', 'LedgerError', 'LedgerReader', 'openLedger', 'openLedgerReader']);
    // No raw SQL or handle: the connection is not a property, so the only reads are the fixed queries below.
    const ledger = openLedger(tempPath(), 'backtest');
    expect(Object.keys(ledger)).toEqual([]);
    expect((ledger as unknown as Record<string, unknown>)['db']).toBeUndefined();
    ledger.close();
    const reads = Object.getOwnPropertyNames(Object.getPrototypeOf(engineApi.LedgerReader.prototype)).filter((n) => n !== 'constructor' && n !== 'db');
    for (const name of reads) expect(name).not.toMatch(/label|trial|gate|sql|query|exec|attach/i);
  });

  it('no file the engine entry point imports mentions the scoring store or its tables', () => {
    const files = moduleGraph(join(LEDGER_DIR, 'index.ts'));
    expect(files.some((f) => f.endsWith('ledger/ledger.ts'))).toBe(true);
    for (const f of files) {
      expect(f).not.toContain(`${LEDGER_DIR}/scoring`);
      const text = readFileSync(f, 'utf8');
      for (const t of [...SCORING_TABLES, 'ATTACH']) expect(text.includes(t), `${f} mentions ${t}`).toBe(false);
    }
  });

  it('outside the ledger and the stats stage, no source file imports the scoring store or ledger internals', () => {
    // Allowed: the ledger itself and the scoring stage (STATS-1). A new importer is added here only after review.
    const ALLOWED = [`${CORE_SRC}/ledger/`, `${CORE_SRC}/stats/`];
    const sources = readdirSync(PACKAGES, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('node_modules') && /^[^/]+\/src\//.test(f))
      .map((f) => join(PACKAGES, f));
    expect(sources.length).toBeGreaterThan(5);
    for (const f of sources) {
      if (ALLOWED.some((a) => f.startsWith(a))) continue;
      for (const m of readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1]!;
        const target = spec.startsWith('.') ? resolve(dirname(f), spec) : spec;
        const internal = target.includes('ledger/scoring') || (target.startsWith(`${CORE_SRC}/ledger/`) && target !== `${CORE_SRC}/ledger/index.ts`);
        expect(internal, `${f} imports ${spec}`).toBe(false);
      }
    }
  });

  it('every engine read returns the same answer with or without labels present', () => {
    const plain = tempPath();
    const a = openLedger(plain, 'backtest');
    a.recordIntent(entryIntent(1), { status: 'candidate', ts: 1 });
    a.recordFeatureSnapshot({ mint: MINT, venue: 'pumpswap', quoteMint: 'So11111111111111111111111111111111111111112', decisionTs: 5, asOfSlot: 9n, maxReceiptTs: 5, featuresetVer: 'f1', features: { a: 1 } });
    const { ledger, scoring } = setup();
    const view = (l: engineApi.Ledger) => JSON.stringify([
      l.unresolvedIntents(), l.heldReservations(), l.pendingOutbox(), l.positions(), l.pendingCommands(), l.intent('e1'), l.hasSnapshot(1n), l.purpose(),
    ], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(view(ledger)).toBe(view(a));
    expect(view(ledger)).not.toContain(MARKER);
    a.close();
    scoring.close();
    ledger.close();
  });
});
