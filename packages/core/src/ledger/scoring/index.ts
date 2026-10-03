// The scoring store: labels, the experiment registry and promotion gate results. Outcomes live here,
// in a file of their own that the engine-facing ledger API can never open or attach, so the engine
// cannot read a result before (or after) it happens. Written by the scoring stage after the engine runs.

import type { DatabaseSync } from 'node:sqlite';
import { fromJson, toJson } from '../codec.ts';
import { openLedgerReader, type LedgerReader, type Millis } from '../ledger.ts';
import { amountOf, appendOnly, inTransaction, LedgerError, openReader, openWriter, signedAmountCheck, signedAmountText, type Migration } from '../sqlite.ts';

export const SCENARIOS = ['base', 'conservative', 'optimistic'] as const;
export const GATES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'demote'] as const;

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

const init = `
-- execution-aware triple-barrier labels, one per snapshot x barrier config x scenario x execution model (quant.md §9)
CREATE TABLE label_tb (
  snapshot_id     INTEGER NOT NULL,
  cfg_id          TEXT NOT NULL,
  scenario        TEXT NOT NULL CHECK (scenario IN (${list(SCENARIOS)})),
  exec_model_ver  TEXT NOT NULL,
  entry_filled    INTEGER NOT NULL CHECK (entry_filled IN (0, 1)),
  entry_slot      INTEGER,
  exit_slot       INTEGER,
  touch_slot      INTEGER,
  y_tb            INTEGER CHECK (y_tb IS NULL OR y_tb IN (-1, 0, 1)),
  r_net           REAL,
  net_lamports    TEXT CHECK (net_lamports IS NULL OR ${signedAmountCheck('net_lamports')}),
  mfe             REAL,
  mae             REAL,
  n_exit_attempts INTEGER CHECK (n_exit_attempts IS NULL OR n_exit_attempts >= 0),
  blocked         INTEGER NOT NULL CHECK (blocked IN (0, 1)),
  censored        INTEGER NOT NULL CHECK (censored IN (0, 1)),
  y_meta          INTEGER GENERATED ALWAYS AS (CASE WHEN r_net IS NULL THEN NULL WHEN r_net > 0 THEN 1 ELSE 0 END) VIRTUAL,
  y_severe        INTEGER GENERATED ALWAYS AS (CASE WHEN blocked = 1 THEN 1 WHEN r_net IS NULL THEN NULL WHEN r_net <= -0.5 THEN 1 ELSE 0 END) VIRTUAL,
  labelled_at     INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, cfg_id, scenario, exec_model_ver)
) STRICT;

-- every configuration ever evaluated: N for the deflated Sharpe ratio and the PBO matrix
CREATE TABLE experiment_trial (
  trial_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts      INTEGER NOT NULL,
  strategy_ver    TEXT,
  model_ver       TEXT,
  cfg_id          TEXT,
  featureset_ver  TEXT,
  data_from       INTEGER,
  data_to         INTEGER,
  split           TEXT NOT NULL,
  n_trades        INTEGER NOT NULL CHECK (n_trades >= 0),
  mean_net        REAL,
  sd_net          REAL,
  sharpe          REAL,
  skew            REAL,
  kurt            REAL,
  per_day_returns TEXT NOT NULL DEFAULT '[]' CHECK (json_type(per_day_returns) = 'array')
) STRICT;

-- gate evaluations, immutable
CREATE TABLE promotion_gate_result (
  gate         TEXT NOT NULL CHECK (gate IN (${list(GATES)})),
  strategy_ver TEXT NOT NULL,
  evaluated_ts INTEGER NOT NULL,
  passed       INTEGER NOT NULL CHECK (passed IN (0, 1)),
  reasons      TEXT NOT NULL CHECK (json_type(reasons) = 'array'),
  metrics      TEXT NOT NULL CHECK (json_type(metrics) = 'object'),
  PRIMARY KEY (gate, strategy_ver, evaluated_ts)
) STRICT;
${['label_tb', 'experiment_trial', 'promotion_gate_result'].map(appendOnly).join('\n')}
`;

export const SCORING_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'labels, trials and gate results', sql: init },
];

export interface LabelInput {
  readonly snapshotId: bigint;
  readonly cfgId: string;
  readonly scenario: (typeof SCENARIOS)[number];
  readonly execModelVer: string;
  readonly entryFilled: boolean;
  readonly entrySlot?: bigint | null;
  readonly exitSlot?: bigint | null;
  readonly touchSlot?: bigint | null;
  readonly yTb?: -1 | 0 | 1 | null;
  /** Net return as a fraction of notional, all costs. */
  readonly rNet?: number | null;
  /** The same result in exact lamports. */
  readonly netLamports?: bigint | null;
  readonly mfe?: number | null;
  readonly mae?: number | null;
  readonly nExitAttempts?: number | null;
  readonly blocked: boolean;
  readonly censored: boolean;
  readonly labelledAt: Millis;
}

export interface Label extends Required<LabelInput> {
  readonly yMeta: 0 | 1 | null;
  readonly ySevere: 0 | 1 | null;
}

export interface TrialInput {
  readonly createdTs: Millis;
  readonly strategyVer?: string | null;
  readonly modelVer?: string | null;
  readonly cfgId?: string | null;
  readonly featuresetVer?: string | null;
  readonly dataFrom?: Millis | null;
  readonly dataTo?: Millis | null;
  readonly split: string;
  readonly nTrades: number;
  readonly meanNet?: number | null;
  readonly sdNet?: number | null;
  readonly sharpe?: number | null;
  readonly skew?: number | null;
  readonly kurt?: number | null;
  readonly perDayReturns?: readonly number[];
}

export interface GateResultInput {
  readonly gate: (typeof GATES)[number];
  readonly strategyVer: string;
  readonly evaluatedTs: Millis;
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly metrics: Readonly<Record<string, unknown>>;
}

const optBig = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(v as bigint));
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

class ScoringReads {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  protected get db(): DatabaseSync {
    return this.#db;
  }

  labels(snapshotId: bigint): Label[] {
    return this.#db.prepare('SELECT * FROM label_tb WHERE snapshot_id = ? ORDER BY cfg_id, scenario, exec_model_ver').all(snapshotId).map((r) => ({
      snapshotId: BigInt(r['snapshot_id'] as bigint),
      cfgId: String(r['cfg_id']),
      scenario: String(r['scenario']) as Label['scenario'],
      execModelVer: String(r['exec_model_ver']),
      entryFilled: r['entry_filled'] === 1n,
      entrySlot: optBig(r['entry_slot']),
      exitSlot: optBig(r['exit_slot']),
      touchSlot: optBig(r['touch_slot']),
      yTb: optNum(r['y_tb']) as Label['yTb'],
      rNet: optNum(r['r_net']),
      netLamports: r['net_lamports'] === null ? null : amountOf(r['net_lamports']),
      mfe: optNum(r['mfe']),
      mae: optNum(r['mae']),
      nExitAttempts: optNum(r['n_exit_attempts']),
      blocked: r['blocked'] === 1n,
      censored: r['censored'] === 1n,
      yMeta: optNum(r['y_meta']) as Label['yMeta'],
      ySevere: optNum(r['y_severe']) as Label['ySevere'],
      labelledAt: Number(r['labelled_at']),
    }));
  }

  /** Every trial ever registered: the N behind the deflated Sharpe ratio. */
  trialCount(): number {
    return Number(this.#db.prepare('SELECT COUNT(*) AS n FROM experiment_trial').get()?.['n'] ?? 0n);
  }

  gateResults(strategyVer: string): (GateResultInput & { readonly metrics: Record<string, unknown> })[] {
    return this.#db.prepare('SELECT * FROM promotion_gate_result WHERE strategy_ver = ? ORDER BY evaluated_ts, gate').all(strategyVer).map((r) => ({
      gate: String(r['gate']) as GateResultInput['gate'],
      strategyVer: String(r['strategy_ver']),
      evaluatedTs: Number(r['evaluated_ts']),
      passed: r['passed'] === 1n,
      reasons: fromJson<string[]>(r['reasons']),
      metrics: fromJson<Record<string, unknown>>(r['metrics']),
    }));
  }
}

export class ScoringReader extends ScoringReads {
  close(): void {
    this.db.close();
  }
}

/** The scoring stage's writer. Reads the ledger (read-only) to check what it labels; never the other way round. */
export class ScoringStore extends ScoringReads {
  readonly #release: () => void;
  readonly #ledger: LedgerReader;

  constructor(db: DatabaseSync, release: () => void, ledger: LedgerReader) {
    super(db);
    this.#release = release;
    this.#ledger = ledger;
  }

  close(): void {
    try {
      this.db.close();
      this.#ledger.close();
    } finally {
      this.#release();
    }
  }

  atomically<T>(fn: () => T): T {
    return inTransaction(this.db, fn);
  }

  recordLabel(l: LabelInput): void {
    if (!this.#ledger.hasSnapshot(l.snapshotId)) throw new LedgerError(`no feature snapshot ${l.snapshotId} in the ledger`);
    this.atomically(() => this.db.prepare(`INSERT INTO label_tb (snapshot_id, cfg_id, scenario, exec_model_ver, entry_filled, entry_slot,
      exit_slot, touch_slot, y_tb, r_net, net_lamports, mfe, mae, n_exit_attempts, blocked, censored, labelled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      l.snapshotId, l.cfgId, l.scenario, l.execModelVer, l.entryFilled ? 1 : 0, l.entrySlot ?? null, l.exitSlot ?? null,
      l.touchSlot ?? null, l.yTb ?? null, l.rNet ?? null, l.netLamports === undefined || l.netLamports === null ? null : signedAmountText(l.netLamports),
      l.mfe ?? null, l.mae ?? null, l.nExitAttempts ?? null, l.blocked ? 1 : 0, l.censored ? 1 : 0, l.labelledAt));
  }

  recordTrial(t: TrialInput): bigint {
    return this.atomically(() => BigInt(this.db.prepare(`INSERT INTO experiment_trial (created_ts, strategy_ver, model_ver, cfg_id,
      featureset_ver, data_from, data_to, split, n_trades, mean_net, sd_net, sharpe, skew, kurt, per_day_returns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      t.createdTs, t.strategyVer ?? null, t.modelVer ?? null, t.cfgId ?? null, t.featuresetVer ?? null, t.dataFrom ?? null,
      t.dataTo ?? null, t.split, t.nTrades, t.meanNet ?? null, t.sdNet ?? null, t.sharpe ?? null, t.skew ?? null, t.kurt ?? null,
      JSON.stringify(t.perDayReturns ?? [])).lastInsertRowid));
  }

  recordGateResult(g: GateResultInput): void {
    this.atomically(() => this.db.prepare(`INSERT INTO promotion_gate_result (gate, strategy_ver, evaluated_ts, passed, reasons, metrics)
      VALUES (?, ?, ?, ?, ?, ?)`).run(g.gate, g.strategyVer, g.evaluatedTs, g.passed ? 1 : 0, JSON.stringify(g.reasons), toJson(g.metrics)));
  }
}

/** Opens the scoring file as its one writer, with the ledger it scores opened read-only. The two paths must differ. */
export const openScoringStore = (path: string, ledgerPath: string): ScoringStore => {
  if (path === ledgerPath) throw new LedgerError('the scoring store must be a separate file from the ledger');
  const ledger = openLedgerReader(ledgerPath);
  let opened: ReturnType<typeof openWriter>;
  try {
    opened = openWriter(path, 'scoring', SCORING_MIGRATIONS);
  } catch (err) {
    ledger.close();
    throw err;
  }
  return new ScoringStore(opened.db, opened.release, ledger);
};

export const openScoringReader = (path: string): ScoringReader => new ScoringReader(openReader(path, 'scoring', SCORING_MIGRATIONS));
