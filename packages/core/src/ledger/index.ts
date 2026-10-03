// Engine-facing ledger API. Labels, experiment trials and gate results are not reachable from here:
// they live in a separate file opened only by `@meme-snipe/core/ledger/scoring`.
// The SQLite code lives in ./adapters, the only place in core allowed to touch files (docs/ARCHITECTURE.md §16.1).
export {
  Ledger, LedgerReader, openLedger, openLedgerReader,
  type AuthLevel, type DecisionInput, type DecisionMode, type FeatureSnapshotInput, type FeeKind, type HeldReservation,
  type IntentRecord, type IntentTransition, type Issuer, type LedgerPurpose, type Millis, type ObservationInput, type OperatorCommandInput,
  type OperatorCommandName, type OutboxItem, type PendingCommand, type PositionRecord, type RecordIntentResult,
  type ReservationLimits, type ReserveResult,
} from './adapters/ledger.ts';
export { LedgerError } from './adapters/sqlite.ts';
