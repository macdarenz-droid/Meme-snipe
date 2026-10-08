// The engine-facing ledger API cannot read labels, trials or gate results. Outcomes live in a separate
// scoring file that the ledger code never opens, attaches or imports.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as engineApi from '../../src/ledger/index.ts';
import { openLedger, openLedgerReader } from '../../src/ledger/index.ts';
import { connectionOf } from '../../src/ledger/ledger.ts';
import { openScoringReader, openScoringStore } from '../../src/ledger/scoring/index.ts';
import { entryIntent, MINT } from '../fixtures.ts';
import { importViolations } from './guard.ts';
import { tempPath } from './helpers.ts';

const CORE_SRC = resolve(dirname(new URL(import.meta.url).pathname), '../../src');
const LEDGER_DIR = join(CORE_SRC, 'ledger');
const REPO = resolve(CORE_SRC, '../../..');
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

  it('outside the ledger and the stats stage, nothing reaches the scoring store, ledger internals or node:sqlite', () => {
    expect(importViolations(REPO)).toEqual([]);
  });

  it('the import guard catches every bypass, directly or through another module', () => {
    const root = dirname(tempPath());
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put('packages/core/src/ledger/index.ts', "export * from './ledger.ts';\n");
    put('packages/core/src/ledger/ledger.ts', "import { DatabaseSync } from 'node:sqlite';\n");
    put('packages/core/src/ledger/scoring/index.ts', "import '../ledger.ts';\n");
    put('packages/core/src/stats/index.ts', "import { x } from '../ledger/scoring/index.ts';\n");
    put('packages/core/src/engine/ok.ts', "import { openLedger } from '@meme-snipe/core/ledger';\nimport { y } from '../units/index.ts';\n");
    put('packages/core/src/units/index.ts', 'export const y = 1;\n');
    put('packages/engine/src/m24/db.ts', "import { DatabaseSync } from 'node:sqlite';\n");    // M24 owns its SQLite file
    put('packages/engine/src/m25/boot.ts', "import { openDb } from '../m24/db.ts';\n");         // and is reached through it
    expect(importViolations(root)).toEqual([]);
    put('packages/signer/src/db.ts', "import { DatabaseSync } from 'node:sqlite';\n");          // any other package: flagged
    put('packages/engine/src/m09/db.ts', "import { DatabaseSync } from 'node:sqlite';\n");      // and so is the rest of @bot/engine
    const sqliteFound = importViolations(root);
    expect(sqliteFound).toContain('packages/signer/src/db.ts (imports node:sqlite)');
    expect(sqliteFound).toContain('packages/engine/src/m09/db.ts (imports node:sqlite)');
    expect(sqliteFound.every((f) => f.startsWith('packages/signer/') || f.startsWith('packages/engine/src/m09/'))).toBe(true);
    rmSync(join(root, 'packages/signer'), { recursive: true });
    rmSync(join(root, 'packages/engine/src/m09'), { recursive: true });
    put('packages/worker/src/old.ts', "import { openDb } from '../../engine/src/m24/db.ts';\n");   // a Zeroed file reaching M24 (ruling 20)
    put('packages/core/src/units/via.ts', "export * from '../../../engine/src/m25/boot.ts';\n");      // or reaching it through @bot/engine
    const reach = importViolations(root);
    expect(reach).toContain('packages/worker/src/old.ts -> packages/engine/src/m24/db.ts (reaches packages/engine/src/m24)');
    expect(reach).toContain('packages/core/src/units/via.ts -> packages/engine/src/m25/boot.ts -> packages/engine/src/m24/db.ts (reaches packages/engine/src/m24)');
    rmSync(join(root, 'packages/worker/src/old.ts'));
    rmSync(join(root, 'packages/core/src/units/via.ts'));
    expect(importViolations(root)).toEqual([]);

    const probes: Record<string, string> = {
      'sqlite.ts': "import { DatabaseSync } from 'node:sqlite';",
      'dynamic.ts': "const s = await import('../ledger/scoring/index.ts');",
      'computed.ts': "const p = '../ledger/scoring/index.ts'; await import(p);",
      'require.ts': "const s = require('../ledger/scoring/index.ts');",
      'reexport.ts': "export { x } from '../ledger/scoring/index.ts';",
      'internal.ts': "import '../ledger/ledger.ts';",
      'subpath.ts': "import { s } from '@meme-snipe/core/ledger/scoring';",
      'via-stats.ts': "import { z } from '../stats/index.ts';",
      'via-two.ts': "import '../units/two.ts';",
      'builtin.ts': "const S = process.getBuiltinModule('node:sqlite');",
      'builtin-computed.ts': "const S = process.getBuiltinModule(['node', 'sql' + 'ite'].join(':'));",
      'create-require.ts': "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);",
      'require-computed.ts': "const s = require(['node', 'x'].join(':'));",
      'sqlite-string.ts': "const name = `node:${'sqlite'}`;",
      'binding.ts': "const b = process.binding('fs');",
    };
    put('packages/core/src/units/two.ts', "import '../stats/index.ts';\n");
    for (const [name, text] of Object.entries(probes)) put(`packages/core/src/engine/${name}`, `${text}\n`);
    const found = importViolations(root).join('\n');
    for (const name of Object.keys(probes)) expect(found, name).toContain(`engine/${name}`);
    expect(found).toContain('units/two.ts -> packages/core/src/stats/index.ts');
    expect(found).not.toContain('engine/ok.ts');
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
