// Ledger schema, forward-only. Never edit a released migration: add the next version instead.
// Amounts are canonical decimal TEXT (u64 token amounts overflow SQLite's signed 64-bit INTEGER);
// slots and block heights are INTEGER; times are integer milliseconds from the caller's clock
// (live or simulated), never read from the wall clock here.

import { amountCheck as amount, appendOnly, type Migration } from './adapters/sqlite.ts';

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');
const json = (column: string): string => `json_valid(${column})`;

// Frozen copies for migration 1. A test fails when the domain lists change, so the change lands as a new migration.
export const V1_VENUES = ['pump-curve', 'pumpswap'] as const;
export const V1_INTENT_STATUSES = [
  'candidate', 'eligible', 'risk_approved', 'exposure_reserved', 'prepared', 'signed', 'submitted', 'pending', 'unknown',
  'confirmed_fill', 'failed', 'expired_unfilled', 'reconciled', 'rejected', 'cancelled', 'abandoned',
] as const;
export const V1_POSITION_STATUSES = ['opening', 'open', 'exit_requested', 'exit_pending', 'exit_blocked', 'closed'] as const;
export const INTENT_END_STATUSES = ['rejected', 'cancelled', 'abandoned', 'reconciled'] as const;
export const FEE_KINDS = ['network_base', 'priority', 'tip', 'venue', 'rent_paid', 'rent_recovered'] as const;
export const OPERATOR_COMMANDS = ['pause', 'resume', 'close_position', 'session_start', 'session_stop'] as const;
export const AUTH_LEVELS = ['telegram', 'dashboard', 'dashboard_passkey', 'host'] as const;
/** Role labels only, so no Telegram id, email or other personal data can be stored as the issuer. */
export const ISSUERS = ['owner', 'system'] as const;
export const DECISION_MODES = ['replay', 'shadow', 'paper', 'live'] as const;

const TABLES = [
  'ledger_meta', 'observation', 'feature_snapshot', 'decision', 'intent', 'intent_event', 'reservation', 'reservation_event',
  'attempt', 'fill', 'position', 'position_event', 'fee', 'outbox', 'outbox_done', 'operator_command', 'command_result',
] as const;

const init = `
CREATE TABLE ledger_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- what was known, when
CREATE TABLE observation (
  obs_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL,
  mint          TEXT NOT NULL,
  pool          TEXT,
  kind          TEXT NOT NULL,
  slot          INTEGER CHECK (slot IS NULL OR slot >= 0),
  event_ts      INTEGER,
  receipt_ts    INTEGER NOT NULL,
  commitment    TEXT CHECK (commitment IS NULL OR commitment IN ('processed', 'confirmed', 'finalized')),
  payload       TEXT NOT NULL CHECK (${json('payload')}),
  quality_flags TEXT NOT NULL DEFAULT '[]' CHECK (json_type(quality_flags) = 'array')
) STRICT;
CREATE INDEX observation_mint_slot ON observation (mint, slot);

-- one immutable feature row per candidate, decision moment and feature-set version
CREATE TABLE feature_snapshot (
  snapshot_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  mint            TEXT NOT NULL,
  pool            TEXT,
  venue           TEXT NOT NULL CHECK (venue IN (${list(V1_VENUES)})),
  quote_mint      TEXT NOT NULL,
  decision_ts     INTEGER NOT NULL,
  as_of_slot      INTEGER NOT NULL CHECK (as_of_slot >= 0),
  max_receipt_ts  INTEGER NOT NULL CHECK (max_receipt_ts <= decision_ts),
  featureset_ver  TEXT NOT NULL,
  creator_cluster TEXT,
  features        TEXT NOT NULL CHECK (json_type(features) = 'object'),
  missing         TEXT NOT NULL DEFAULT '[]' CHECK (json_type(missing) = 'array'),
  regime_tags     TEXT NOT NULL DEFAULT '[]' CHECK (json_type(regime_tags) = 'array')
) STRICT;

-- the decision taken (or not) by a strategy version, with its reasons
CREATE TABLE decision (
  decision_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id   INTEGER NOT NULL REFERENCES feature_snapshot (snapshot_id),
  decided_ts    INTEGER NOT NULL,
  strategy_ver  TEXT NOT NULL,
  model_ver     TEXT,
  calib_ver     TEXT,
  p_meta        REAL CHECK (p_meta IS NULL OR (p_meta >= 0 AND p_meta <= 1)),
  p_severe      REAL CHECK (p_severe IS NULL OR (p_severe >= 0 AND p_severe <= 1)),
  conformal_thr REAL,
  action        TEXT NOT NULL CHECK (action IN ('enter', 'reject', 'abstain')),
  reasons       TEXT NOT NULL CHECK (json_type(reasons) = 'array' AND json_array_length(reasons) > 0),
  mode          TEXT NOT NULL CHECK (mode IN (${list(DECISION_MODES)}))
) STRICT;
CREATE INDEX decision_snapshot ON decision (snapshot_id);

-- trade intents; the idempotency key is unique so a retried decision can never create a second trade
CREATE TABLE intent (
  intent_id   TEXT PRIMARY KEY,
  idem_key    TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL,
  side        TEXT NOT NULL,
  mint        TEXT NOT NULL,
  venue       TEXT NOT NULL CHECK (venue IN (${list(V1_VENUES)})),
  position_id TEXT NOT NULL,
  spend       TEXT CHECK (spend IS NULL OR ${amount('spend')}),
  quantity    TEXT CHECK (quantity IS NULL OR ${amount('quantity')}),
  decision_id INTEGER REFERENCES decision (decision_id),
  created_ts  INTEGER NOT NULL,
  CHECK ((purpose = 'entry' AND side = 'buy' AND spend IS NOT NULL AND quantity IS NULL)
      OR (purpose = 'exit' AND side = 'sell' AND quantity IS NOT NULL AND spend IS NULL))
) STRICT;

-- every intent status change, in order; the last row is the current status
CREATE TABLE intent_event (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL REFERENCES intent (intent_id),
  status    TEXT NOT NULL CHECK (status IN (${list(V1_INTENT_STATUSES)})),
  event     TEXT NOT NULL,
  detail    TEXT CHECK (detail IS NULL OR ${json('detail')}),
  ts        INTEGER NOT NULL
) STRICT;
CREATE INDEX intent_event_intent ON intent_event (intent_id, seq);

-- exposure reservations: held until one release or keep row ends them
CREATE TABLE reservation (
  reservation_id TEXT PRIMARY KEY,
  intent_id      TEXT NOT NULL UNIQUE REFERENCES intent (intent_id),
  amount         TEXT NOT NULL CHECK (${amount('amount')} AND amount <> '0'),
  created_ts     INTEGER NOT NULL
) STRICT;
CREATE TABLE reservation_event (
  reservation_id TEXT PRIMARY KEY REFERENCES reservation (reservation_id),
  status         TEXT NOT NULL CHECK (status IN ('released', 'kept')),
  ts             INTEGER NOT NULL
) STRICT;

-- signed transactions, stored before the first broadcast; one signature per intent and blockhash
CREATE TABLE attempt (
  attempt_id              TEXT PRIMARY KEY,
  intent_id               TEXT NOT NULL REFERENCES intent (intent_id),
  signed_bytes_ref        TEXT NOT NULL,
  signature               TEXT NOT NULL UNIQUE,
  blockhash               TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL CHECK (last_valid_block_height >= 0),
  quote                   TEXT NOT NULL CHECK (${json('quote')}),
  created_ts              INTEGER NOT NULL,
  UNIQUE (intent_id, blockhash)
) STRICT;

-- fills measured from balance changes; a signature fills at most once
CREATE TABLE fill (
  fill_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id  TEXT NOT NULL REFERENCES intent (intent_id),
  signature  TEXT NOT NULL UNIQUE,
  slot       INTEGER NOT NULL CHECK (slot >= 0),
  commitment TEXT NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
  tokens     TEXT NOT NULL CHECK (${amount('tokens')}),
  sol        TEXT NOT NULL CHECK (${amount('sol')}),
  fees       TEXT NOT NULL CHECK (${amount('fees')}),
  ts         INTEGER NOT NULL
) STRICT;

CREATE TABLE position (
  position_id     TEXT PRIMARY KEY,
  mint            TEXT NOT NULL,
  venue           TEXT NOT NULL CHECK (venue IN (${list(V1_VENUES)})),
  entry_intent_id TEXT NOT NULL UNIQUE REFERENCES intent (intent_id),
  created_ts      INTEGER NOT NULL
) STRICT;
CREATE TABLE position_event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT NOT NULL REFERENCES position (position_id),
  status      TEXT NOT NULL CHECK (status IN (${list(V1_POSITION_STATUSES)})),
  quantity    TEXT NOT NULL CHECK (${amount('quantity')}),
  cost        TEXT NOT NULL CHECK (${amount('cost')}),
  event       TEXT NOT NULL,
  detail      TEXT CHECK (detail IS NULL OR ${json('detail')}),
  ts          INTEGER NOT NULL
) STRICT;
CREATE INDEX position_event_position ON position_event (position_id, seq);

-- every lamport paid or recovered outside the swap amount
CREATE TABLE fee (
  fee_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT REFERENCES intent (intent_id),
  signature TEXT,
  kind      TEXT NOT NULL CHECK (kind IN (${list(FEE_KINDS)})),
  lamports  TEXT NOT NULL CHECK (${amount('lamports')}),
  ts        INTEGER NOT NULL
) STRICT;

-- transactional outbox: effects are written in the same transaction as the state that caused them
CREATE TABLE outbox (
  outbox_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id   TEXT REFERENCES intent (intent_id),
  effect_type TEXT NOT NULL,
  effect      TEXT NOT NULL CHECK (${json('effect')}),
  created_ts  INTEGER NOT NULL
) STRICT;
CREATE TABLE outbox_done (
  outbox_id INTEGER PRIMARY KEY REFERENCES outbox (outbox_id),
  result    TEXT NOT NULL CHECK (result IN ('done', 'skipped')),
  detail    TEXT CHECK (detail IS NULL OR ${json('detail')}),
  ts        INTEGER NOT NULL
) STRICT;

-- operator commands with the auth level they arrived with; Telegram may only pause; the issuer is a role, never a person's id
CREATE TABLE operator_command (
  command_id TEXT PRIMARY KEY,
  command    TEXT NOT NULL CHECK (command IN (${list(OPERATOR_COMMANDS)})),
  args       TEXT NOT NULL DEFAULT '{}' CHECK (json_type(args) = 'object'),
  auth_level TEXT NOT NULL CHECK (auth_level IN (${list(AUTH_LEVELS)})),
  issued_by  TEXT NOT NULL CHECK (issued_by IN (${list(ISSUERS)})),
  issued_ts  INTEGER NOT NULL,
  CHECK (auth_level <> 'telegram' OR command = 'pause')
) STRICT;
CREATE TABLE command_result (
  command_id TEXT PRIMARY KEY REFERENCES operator_command (command_id),
  accepted   INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  reason     TEXT NOT NULL,
  ts         INTEGER NOT NULL
) STRICT;
${TABLES.map(appendOnly).join('\n')}
`;

export const LEDGER_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'ledger tables', sql: init },
];
