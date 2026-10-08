// PATHS-FIX (docs/research/DISK-BUDGET.md §2.9; docs/reviews/DISKBUDGET.md rulings 6, 8, 9, 11–18): every place the
// engine writes on the host, in one list. The engine runs in zeroed-worker.service under ProtectSystem=strict, which
// can write only its StateDirectory (/var/lib/zeroed, 0700) and its ReadWritePaths (/var/lib/zeroed-md and
// /var/lib/zeroed-spool, made by the installer with their own group and mode, because one unit has one
// StateDirectoryMode). A test checks that each path below sits inside one of them.

/** The unit's StateDirectory: the worker's private state (ledger, logs, recovery journal). */
export const STATE_DIR = '/var/lib/zeroed';
/** Market-data segments (M07), group `zeroed-pull`, 2750; the pull account reads it through a read-only bind. */
export const MD_DIR = '/var/lib/zeroed-md';
/** Import spool (M13), group `zeroed-spool` = {operator, zeroed-worker}, 2730. */
export const SPOOL_DIR = '/var/lib/zeroed-spool';

export const ENGINE_PATHS = {
  /** M24 ledger (`m24.db_path`); its writer lock `<db>-writer.lock` sits beside it. */
  db: `${STATE_DIR}/bot.db`,
  /** M24 pre-migration backup (`backupPath`); the extension keeps it out of the database-file glob zeroed-backup copies. */
  preMigrationBackup: `${STATE_DIR}/premigrate/bot.premigrate`,
  /** M24 first-start marker (`initMarker`), outside the database's own name but inside the state folder. */
  initMarker: `${STATE_DIR}/init/first-start`,
  /** M24 recovery journal folder (`exits_only`): `recovery-<ts>.ndjson`, never deleted. */
  recoveryDir: `${STATE_DIR}/recovery`,
  /** M24 disk-guard reserve file (500 MB). */
  diskReserve: `${STATE_DIR}/reserve`,
  /** M27 log folder (`m27.log_dir`). */
  logDir: `${STATE_DIR}/log`,
  /** M14 provider usage ledger. */
  rpcUsageDb: `${STATE_DIR}/rpc-usage.db`,
  /** M07 recorder data folder (`recorder.data_dir`). */
  mdDir: MD_DIR,
  /** M07 pull receipts, the only folder the pull account may write. */
  receiptsDir: `${MD_DIR}/receipts`,
  /** M13 import spool. */
  importSpool: SPOOL_DIR,
} as const;

/** The M24 writer lock that goes with a database path (`m24/db.ts`). */
export const writerLockPath = (dbPath: string): string => `${dbPath}-writer.lock`;
