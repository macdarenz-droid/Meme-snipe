// Decoder parity for the historical dataset (docs/research/historical-data.md, schema 2). CLI:
//
//   node --no-warnings research/historical/qa/parity.ts <dataset-dir>
//
// Proves the scanner's rows equal the raw records, decoded by the shared chain decoder (packages/core/src/chain, DEC-1):
//   1. Every curve_trades, amm_trades and events row whose transaction has a raw record is matched to one decoded
//      event with the same (slot, tx_idx, outer_ix, inner_ix), program and event name, and every value the row carries
//      equals the decoded value (base_mint and quote_mint of PumpSwap rows: the accounts of the instruction that emitted
//      the event, resolved through the transaction's loaded addresses). A decoded event matched by a second row, of
//      either kind, fails. Events DEC-1 does not decode in full ('other') are compared byte for byte: an Unknown row's
//      discriminator and data_hex, a named row's fields, layout_fields and extra_hex against the event bytes read with
//      the scanner's own IDL (research/historical/scanner/idl). Every failed row matches a failed raw record.
//   2. Every decoded event of a successful raw record that the scanner keeps has a row (scanner sample.go keepEvent and
//      finalize.go routing): trades of universe mints inside a tape interval; every other event except dropEvents,
//      with sampledOnlyEvents only when their mint is inside a tape interval at the block time. Unrowed trades and
//      sampled-only events of other mints and dropped events are counted as explained.
//   3. Every curve, amm and failed row, and every events row whose mint is inside a tape interval, has its raw record
//      (the scanner writes a raw record for every transaction touching such a mint). Events rows of other mints have
//      none and are counted. A successful raw record touching pump or PumpSwap without inner instructions fails (its
//      events cannot be decoded) unless its complete logs show no cross-program invocation, so it has no events.
//   4. Token movements (scanner movements.go): the movement rows of every raw record's transaction equal the movements
//      re-derived here from that record (same rows, every column): SPL Token and Token-2022 Transfer, TransferChecked,
//      Burn, BurnChecked, MintTo and MintToChecked with no pump or PumpSwap instruction among their callers (by stack
//      height), owners from the record's token balances (post over pre), for mints ending in "pump" and for mints with a
//      decoded pump or PumpSwap event in that transaction. A failed transaction has none. Movement rows of transactions
//      without a raw record are counted (movements_without_raw).
// A raw record the decoder refuses is a mismatch. The CLI prints the summary, writes <dataset-dir>/qa/parity.json and
// exits 1 on any mismatch or missing row.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import {
  type Address,
  type DecodedTransaction,
  type LocatedEvent,
  type TransactionRecord,
  EVENT_IX_TAG,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  accountKeys,
  decodeBase58,
  decodeTransaction,
  encodeBase58,
  fromBase64,
  hasDiscriminator,
  toHex,
  transactionEvents,
} from '../../../core/src/chain/index.ts';
import { parseCsv } from './csv.ts';

// ---- raw records ----

export interface RawInstruction {
  readonly programIdIndex: number;
  readonly accounts: readonly number[];
  /** Base64. */
  readonly data: string;
  readonly stackHeight?: number | null;
}

export interface RawLine {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly txIndex: number;
  readonly signature: string;
  readonly transaction: string;
  readonly err: null | { readonly hex: string };
  readonly mints?: readonly string[];
  readonly meta: {
    readonly fee: number;
    readonly computeUnitsConsumed?: number | null;
    readonly loadedAddresses?: { readonly writable: readonly string[]; readonly readonly: readonly string[] } | null;
    readonly innerInstructions: readonly { readonly index: number; readonly instructions: readonly RawInstruction[] }[] | null;
    readonly logMessages?: readonly string[] | null;
    readonly preTokenBalances?: readonly RawTokenBalance[] | null;
    readonly postTokenBalances?: readonly RawTokenBalance[] | null;
  };
}

export interface RawTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount?: { readonly amount: string };
}

/** A raw-NNN.jsonl line as the decoder's TransactionRecord (inner data base64 to bytes, `err` kept as given). */
export const recordFromRaw = (line: RawLine): TransactionRecord => ({
  slot: BigInt(line.slot),
  blockTime: line.blockTime ?? null,
  txIndex: line.txIndex,
  signature: line.signature,
  transaction: fromBase64(line.transaction),
  err: line.err ?? null,
  loadedAddresses: {
    writable: (line.meta.loadedAddresses?.writable ?? []) as Address[],
    readonly: (line.meta.loadedAddresses?.readonly ?? []) as Address[],
  },
  innerInstructions:
    line.meta.innerInstructions === null || line.meta.innerInstructions === undefined
      ? null
      : line.meta.innerInstructions.map((g) => ({
          index: g.index,
          instructions: g.instructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accounts: ix.accounts,
            data: fromBase64(ix.data),
            stackHeight: ix.stackHeight ?? null,
          })),
        })),
  logMessages: line.meta.logMessages ?? null,
});

// ---- CSV ----

/** Header + rows as objects keyed by column name. */
export const csvObjects = (text: string): Record<string, string>[] => {
  let header: string[] | null = null;
  const out: Record<string, string>[] = [];
  parseCsv(text, (r) => {
    if (header === null) {
      header = r;
      return;
    }
    const h: string[] = header;
    if (r.length !== h.length) throw new Error(`CSV row has ${r.length} fields, header has ${h.length}`);
    out.push(Object.fromEntries(h.map((name, i) => [name, r[i]!])));
  });
  return out;
};

// ---- rows ----

export type RowKind = 'curve' | 'amm' | 'event' | 'failed';

export interface Row {
  readonly kind: RowKind;
  readonly slot: number;
  readonly txIdx: number;
  /** -1 for failed rows (a transaction, not an event). */
  readonly outerIx: number;
  readonly innerIx: number;
  readonly program: 'pump' | 'pump_amm';
  readonly event: string;
  readonly signature: string;
  /** Column (CSV) or field values; for event rows the top-level keys and `fields.*`. */
  readonly values: Readonly<Record<string, string>>;
  /** Event rows: the event's own fields (snake_case), as written. */
  readonly fields?: Readonly<Record<string, string>>;
}

const int = (s: string | undefined, what: string): number => {
  if (s === undefined || !/^-?\d+$/.test(s)) throw new Error(`${what} is not an integer: ${JSON.stringify(s)}`);
  return Number(s);
};

export const curveRow = (v: Record<string, string>): Row => ({
  kind: 'curve',
  slot: int(v.slot, 'slot'),
  txIdx: int(v.tx_idx, 'tx_idx'),
  outerIx: int(v.outer_ix, 'outer_ix'),
  innerIx: int(v.inner_ix, 'inner_ix'),
  program: 'pump',
  event: 'TradeEvent',
  signature: v.signature ?? '',
  values: v,
});

export const ammRow = (v: Record<string, string>): Row => ({
  kind: 'amm',
  slot: int(v.slot, 'slot'),
  txIdx: int(v.tx_idx, 'tx_idx'),
  outerIx: int(v.outer_ix, 'outer_ix'),
  innerIx: int(v.inner_ix, 'inner_ix'),
  program: 'pump_amm',
  event: v.side === 'sell' ? 'SellEvent' : v.side === 'buy' ? 'BuyEvent' : `side:${v.side}`,
  signature: v.signature ?? '',
  values: v,
});

export const failedRow = (v: Record<string, string>): Row => ({
  kind: 'failed',
  slot: int(v.slot, 'slot'),
  txIdx: int(v.tx_idx, 'tx_idx'),
  outerIx: -1,
  innerIx: -1,
  program: 'pump',
  event: 'failed',
  signature: v.signature ?? '',
  values: v,
});

const str = (x: unknown): string => (x === null || x === undefined ? '' : typeof x === 'string' ? x : String(x));

export const eventRow = (o: Record<string, unknown>): Row => {
  const fields: Record<string, string> = {};
  for (const [k, x] of Object.entries((o.fields ?? {}) as Record<string, unknown>)) fields[k] = str(x);
  const values: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) if (k !== 'fields') values[k] = str(x);
  return {
    kind: 'event',
    slot: int(values.slot, 'slot'),
    txIdx: int(values.tx_idx, 'tx_idx'),
    outerIx: int(values.outer_ix, 'outer_ix'),
    innerIx: int(values.inner_ix, 'inner_ix'),
    program: values.program === 'amm' ? 'pump_amm' : 'pump',
    event: values.event ?? '',
    signature: values.signature ?? '',
    values,
    fields,
  };
};

// ---- value comparison ----

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

interface Shareholder {
  readonly address: string;
  readonly shareBps: number;
}

/** Canonical text of a decoded value, in the dataset's notation (decimal integers, booleans 0/1, base58 keys). */
const canon = (x: unknown): string => {
  if (typeof x === 'boolean') return x ? '1' : '0';
  if (Array.isArray(x)) return JSON.stringify((x as Shareholder[]).map((s) => ({ address: s.address, share_bps: String(s.shareBps) })));
  return str(x);
};

/** The dataset's text of a value, normalised the same way (shareholders: the JSON re-serialised). */
const canonRow = (s: string, decoded: unknown): string => {
  if (Array.isArray(decoded) && s !== '') {
    try {
      const a = JSON.parse(s) as { address: unknown; share_bps: unknown }[];
      return JSON.stringify(a.map((e) => ({ address: str(e.address), share_bps: str(e.share_bps) })));
    } catch {
      return s;
    }
  }
  return s;
};

const AMM_COLUMN_FIELD: Record<string, { buy: string | null; sell: string | null }> = {
  base_amount: { buy: 'baseAmountOut', sell: 'baseAmountIn' },
  quote_amount: { buy: 'quoteAmountIn', sell: 'quoteAmountOut' },
  limit_quote: { buy: 'maxQuoteAmountIn', sell: 'minQuoteAmountOut' },
  quote_amount_lp_adjusted: { buy: 'quoteAmountInWithLpFee', sell: 'quoteAmountOutWithoutLpFee' },
  user_quote_amount: { buy: 'userQuoteAmountIn', sell: 'userQuoteAmountOut' },
};
const AMM_EVENT_COLUMNS = [
  'pool', 'user', 'timestamp', 'pool_base_token_reserves', 'pool_quote_token_reserves', 'lp_fee_basis_points', 'lp_fee',
  'protocol_fee_basis_points', 'protocol_fee', 'protocol_fee_recipient', 'coin_creator', 'coin_creator_fee_basis_points',
  'coin_creator_fee', 'track_volume', 'min_base_amount_out', 'ix_name', 'cashback_fee_basis_points', 'cashback',
  'buyback_fee_basis_points', 'buyback_fee', 'virtual_quote_reserves', 'can_boost', 'base_supply', 'holder_rewards_bps', 'holder_rewards',
];
const CURVE_EVENT_COLUMNS = [
  'mint', 'is_buy', 'sol_amount', 'token_amount', 'user', 'timestamp', 'virtual_sol_reserves', 'virtual_token_reserves',
  'real_sol_reserves', 'real_token_reserves', 'fee_recipient', 'fee_basis_points', 'fee', 'creator', 'creator_fee_basis_points',
  'creator_fee', 'track_volume', 'ix_name', 'mayhem_mode', 'cashback_fee_basis_points', 'cashback', 'buyback_fee_basis_points',
  'buyback_fee', 'shareholders', 'quote_mint', 'quote_amount', 'virtual_quote_reserves', 'real_quote_reserves',
  'holder_rewards_bps', 'holder_rewards',
];
/** Row columns this check does not compare: not event fields and not derivable from the decoder's output. */
export const UNCHECKED_COLUMNS = ['jito_tip', 'last_in_tx', 'chain_curve_lamports', 'chain_curve_base', 'chain_curve_quote', 'chain_pool_base', 'chain_pool_quote', 'chain_pool_balances', 'chain_curve_balances'];

/** Events DEC-1 decodes in full that are not trades: the scanner keeps them for every mint (sample.go keepEvent). */
const FULL_NON_TRADE = new Set(['CreateEvent', 'CompleteEvent', 'CompletePumpAmmMigrationEvent', 'CreatePoolEvent', 'InitBoostEvent', 'BoostBuyAndBurnEvent']);

/** research/historical/scanner/sample.go dropEvents: per-user bookkeeping, never written. */
export const DROP_EVENTS: ReadonlySet<string> = new Set([
  'CloseUserVolumeAccumulatorEvent', 'InitUserVolumeAccumulatorEvent', 'SyncUserVolumeAccumulatorEvent',
  'ClaimCashbackEvent', 'ClaimTokenIncentivesEvent', 'CollectCreatorFeeEvent',
  'CollectCoinCreatorFeeEvent', 'MinimumDistributableFeeEvent',
]);

/** sample.go sampledOnlyEvents: written only when their mint (fields mint, else base_mint) is inside its tape (finalize.go). */
export const SAMPLED_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'DistributeCreatorFeesEvent', 'DistributeFeeToHoldersEvent', 'MigrateBondingCurveCreatorEvent',
  'MigratePoolCoinCreatorEvent', 'SetMetaplexCreatorEvent', 'SetMetaplexCoinCreatorEvent',
  'SetCreatorEvent', 'SetBondingCurveCoinCreatorEvent',
]);

// ---- the scanner's IDL decoder (research/historical/scanner/events.go decodeValue), for events DEC-1 keeps as 'other' ----

type IdlType = string | { vec: IdlType } | { option: IdlType } | { array: [IdlType, number] } | { defined: { name: string } | string };
interface IdlField {
  readonly name: string;
  readonly type: IdlType;
}
interface IdlTypeDef {
  readonly name: string;
  readonly type: { readonly kind: string; readonly fields?: readonly IdlField[]; readonly variants?: readonly { readonly name: string }[] };
}
interface IdlDoc {
  readonly events: readonly { readonly name: string; readonly discriminator: readonly number[] }[];
  readonly types: readonly IdlTypeDef[];
}

export interface IdlEvent {
  readonly name: string;
  readonly fields: readonly IdlField[];
  readonly types: ReadonlyMap<string, IdlTypeDef>;
}

/** An IDL event's body read as the scanner writes it: values of the fields this version carries, and trailing bytes. */
export interface IdlDecoded {
  readonly fields: Record<string, string>;
  readonly n: number;
  readonly extraHex: string;
}

const IDL_DIR = join(import.meta.dirname, '../../../../research/historical/scanner/idl');

/** The scanner's embedded IDLs (events.go: pump.json, pump_amm.json), keyed `<program>:<discriminator hex>`. */
export const loadScannerIdl = (dir = IDL_DIR): Map<string, IdlEvent> => {
  const out = new Map<string, IdlEvent>();
  for (const [program, file] of [['pump', 'pump.json'], ['pump_amm', 'pump_amm.json']] as const) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as IdlDoc;
    const types = new Map(doc.types.map((t) => [t.name, t]));
    for (const e of doc.events) {
      const td = types.get(e.name);
      if (!td?.type.fields) throw new Error(`IDL ${file}: no fields for event ${e.name}`);
      out.set(`${program}:${toHex(Uint8Array.from(e.discriminator))}`, { name: e.name, fields: td.type.fields, types });
    }
  }
  return out;
};

class Short extends Error {}

const quoteScalar = (t: IdlType, v: string, types: ReadonlyMap<string, IdlTypeDef>): string => {
  if (typeof t === 'object' && ('vec' in t || 'array' in t)) return v;
  if (typeof t === 'object' && 'defined' in t) {
    const td = types.get(typeof t.defined === 'string' ? t.defined : t.defined.name);
    if (td && td.type.kind !== 'enum') return v;
  }
  return JSON.stringify(v);
};

const readValue = (t: IdlType, b: Uint8Array, p: { i: number }, types: ReadonlyMap<string, IdlTypeDef>): string => {
  const need = (n: number) => {
    if (p.i + n > b.length) throw new Short();
  };
  const uint = (n: number) => {
    need(n);
    let x = 0n;
    for (let k = n - 1; k >= 0; k--) x = (x << 8n) | BigInt(b[p.i + k]!);
    p.i += n;
    return x;
  };
  if (typeof t === 'string') {
    switch (t) {
      case 'pubkey': {
        need(32);
        const v = encodeBase58(b.subarray(p.i, p.i + 32));
        p.i += 32;
        return v;
      }
      case 'u8': case 'u16': case 'u32': case 'u64': case 'u128':
        return String(uint(Number(t.slice(1)) / 8));
      case 'i8': case 'i16': case 'i32': case 'i64': case 'i128': {
        const bits = Number(t.slice(1));
        return String(BigInt.asIntN(bits, uint(bits / 8)));
      }
      case 'bool':
        return uint(1) !== 0n ? '1' : '0';
      case 'string': {
        const n = Number(uint(4));
        need(n);
        const v = new TextDecoder().decode(b.subarray(p.i, p.i + n));
        p.i += n;
        return v;
      }
    }
    throw new Error(`IDL type ${t} is not supported`);
  }
  if ('vec' in t || 'array' in t) {
    let n: number;
    let inner: IdlType;
    if ('vec' in t) {
      n = Number(uint(4));
      inner = t.vec;
      if (n > b.length) throw new Short();
    } else [inner, n] = t.array;
    const parts: string[] = [];
    for (let k = 0; k < n; k++) parts.push(quoteScalar(inner, readValue(inner, b, p, types), types));
    return `[${parts.join(',')}]`;
  }
  if ('option' in t) return uint(1) === 0n ? '' : readValue(t.option, b, p, types);
  const td = types.get(typeof t.defined === 'string' ? t.defined : t.defined.name);
  if (!td) throw new Error(`IDL type ${JSON.stringify(t)} is not defined`);
  if (td.type.kind === 'enum') {
    const k = Number(uint(1));
    return td.type.variants?.[k]?.name ?? String(k);
  }
  return `{${(td.type.fields ?? []).map((f) => `${JSON.stringify(f.name)}:${quoteScalar(f.type, readValue(f.type, b, p, types), types)}`).join(',')}}`;
};

/** events.go decodeEvent: fields in order until the body ends (older layouts), the rest as extra. Null when a field is cut. */
export const decodeIdlEvent = (ev: IdlEvent, body: Uint8Array): IdlDecoded | null => {
  const fields: Record<string, string> = {};
  const p = { i: 0 };
  let n = 0;
  try {
    for (const f of ev.fields) {
      if (p.i === body.length) break;
      fields[f.name] = readValue(f.type, body, p, ev.types);
      n++;
    }
  } catch (e) {
    if (e instanceof Short) return null;
    throw e;
  }
  return { fields, n, extraHex: toHex(body.subarray(p.i)) };
};

// ---- the check ----

export interface Key {
  readonly slot: number;
  readonly tx_idx: number;
  readonly outer_ix: number;
  readonly inner_ix: number;
}

export interface Mismatch {
  readonly kind: RowKind | 'decode' | 'movement';
  readonly key: Key | { readonly slot: number; readonly tx_idx: number };
  readonly signature: string;
  readonly field: string;
  readonly row: string | null;
  readonly decoded: string | null;
}

export interface MissingRow {
  readonly key: Key;
  readonly signature: string;
  readonly event: string;
  readonly mint: string;
  readonly block_time: number | null;
}

export interface MintInfo {
  readonly mint: string;
  readonly pool: string;
  /** Hull of the tape intervals; 0 when the mint has no tape. */
  readonly tapeFrom: number;
  readonly tapeTo: number;
  /** The tape intervals [from, to] (mints `tapes` column); the hull when not given. */
  readonly tapes?: readonly (readonly [number, number])[];
}

export interface ParitySummary {
  raw_records: number;
  raw_failed: number;
  raw_without_inner: number;
  decoded_events: number;
  rows_checked: number;
  rows_matched: number;
  /** Events rows without a raw record whose mint is not inside a tape interval (the scanner keeps no raw for them). */
  rows_without_raw: number;
  /** Rows of events DEC-1 keeps as 'other', matched on the event's bytes. */
  name_only_matches: number;
  explained_unrowed: { non_universe: number; outside_tape: number; dropped_events: number };
  mismatch_count: number;
  missing_row_count: number;
  unchecked_columns: readonly string[];
  /** Raw records exist only for mints with h(mint) below this rate (and for every create), so this is sample parity, not full-row parity. */
  raw_sample_rate: number;
  /** Movement rows of transactions with a raw record (each compared with the re-derived movements). */
  movements_checked: number;
  /** Of those, rows equal to a re-derived movement in every column. */
  movements_matched: number;
  /** Movement rows whose transaction has no raw record (raw records exist only for the hash sample, creates and migrations). */
  movements_without_raw: number;
  scope: string;
  mismatches: Mismatch[];
  missing_rows: MissingRow[];
}

const LIST_LIMIT = 100;
const txKey = (slot: number, tx: number) => `${slot}:${tx}`;
const isTradeName = (name: string) => name === 'TradeEvent' || name === 'BuyEvent' || name === 'SellEvent';

export class ParityChecker {
  private readonly mints = new Map<string, MintInfo>();
  private readonly poolMint = new Map<string, string>();
  private readonly idl: ReadonlyMap<string, IdlEvent>;
  private rows = new Map<string, Row[]>();
  private moves = new Map<string, MovementRow[]>();
  readonly s: ParitySummary = {
    raw_records: 0,
    raw_failed: 0,
    raw_without_inner: 0,
    decoded_events: 0,
    rows_checked: 0,
    rows_matched: 0,
    rows_without_raw: 0,
    name_only_matches: 0,
    explained_unrowed: { non_universe: 0, outside_tape: 0, dropped_events: 0 },
    mismatch_count: 0,
    missing_row_count: 0,
    unchecked_columns: UNCHECKED_COLUMNS,
    raw_sample_rate: 1,
    movements_checked: 0,
    movements_matched: 0,
    movements_without_raw: 0,
    scope: 'rows of mints with h < raw_sample_rate, and every CreateEvent and migration row; movement rows of transactions with a raw record',
    mismatches: [],
    missing_rows: [],
  };

  /**
   * rawSampleRate: the units' hash sample (manifest sampling.unit_sample_rate_min). Raw records exist only for
   * transactions of mints with h(mint) below it (retention "curve-all,canonical-all,sample"), so only those rows
   * must have one; 1 requires a raw record for every row.
   */
  private readonly rawSampleRate: number;

  constructor(mints: readonly MintInfo[], idl: ReadonlyMap<string, IdlEvent> = loadScannerIdl(), rawSampleRate = 1) {
    this.idl = idl;
    this.rawSampleRate = rawSampleRate;
    this.s.raw_sample_rate = rawSampleRate;
    for (const m of mints) {
      this.mints.set(m.mint, m);
      if (m.pool) this.poolMint.set(m.pool, m.mint);
    }
  }

  /** 'in' when `t` is inside one of the mint's tape intervals (finalize.go inTape). */
  private tape(mint: string, t: number): 'in' | 'non_universe' | 'outside_tape' {
    const mi = this.mints.get(mint);
    const tapes = mi ? (mi.tapes ?? (mi.tapeFrom === 0 ? [] : [[mi.tapeFrom, mi.tapeTo] as const])) : [];
    if (tapes.length === 0) return 'non_universe';
    return tapes.some(([from, to]) => t >= from && t <= to) ? 'in' : 'outside_tape';
  }

  /** Adds the rows of one batch (a day). Call `checkRaw` for the batch's raw records, then `endBatch`. */
  addRow(r: Row): void {
    const k = txKey(r.slot, r.txIdx);
    const list = this.rows.get(k);
    if (list) list.push(r);
    else this.rows.set(k, [r]);
    if (r.kind === 'amm' && r.values.pool && r.values.base_mint) this.poolMint.set(r.values.pool, r.values.base_mint);
  }

  /** Adds one movements row of the batch (movements-NNN.csv.zst). */
  addMovement(v: Record<string, string>): void {
    const m = movementRow(v);
    const k = txKey(m.slot, m.txIdx);
    const list = this.moves.get(k);
    if (list) list.push(m);
    else this.moves.set(k, [m]);
  }

  private mismatch(m: Mismatch): void {
    this.s.mismatch_count++;
    if (this.s.mismatches.length < LIST_LIMIT) this.s.mismatches.push(m);
  }

  private missing(m: MissingRow): void {
    this.s.missing_row_count++;
    if (this.s.missing_rows.length < LIST_LIMIT) this.s.missing_rows.push(m);
  }

  checkRaw(line: RawLine): void {
    this.s.raw_records++;
    const k = txKey(line.slot, line.txIndex);
    const all = this.rows.get(k) ?? [];
    this.rows.delete(k);
    this.s.rows_checked += all.length;
    const moveRows = this.moves.get(k) ?? [];
    this.moves.delete(k);
    this.s.movements_checked += moveRows.length;
    const txRef = { slot: line.slot, tx_idx: line.txIndex };
    const failed = line.err !== null && line.err !== undefined;
    if (failed) this.s.raw_failed++;

    let rec: TransactionRecord;
    let tx: DecodedTransaction;
    let keys: Address[];
    let events: LocatedEvent[];
    try {
      rec = recordFromRaw(line);
      tx = decodeTransaction(rec.transaction);
      keys = accountKeys(tx, rec.loadedAddresses);
      events = failed || rec.innerInstructions === null ? [] : transactionEvents(rec, tx);
    } catch (e) {
      this.mismatch({ kind: 'decode', key: txRef, signature: line.signature, field: 'transaction', row: null, decoded: (e as Error).message });
      return;
    }
    if (!failed && rec.innerInstructions === null) {
      this.s.raw_without_inner++;
      if ((keys.includes(PUMP_PROGRAM) || keys.includes(PUMP_AMM_PROGRAM)) && !logsShowNoCpi(line.meta.logMessages)) {
        this.mismatch({ kind: 'decode', key: txRef, signature: line.signature, field: 'innerInstructions', row: null, decoded: 'null: the pump / PumpSwap events of this transaction cannot be decoded' });
      }
    }
    this.s.decoded_events += events.length;
    const ctx: Ctx = { line, rec, tx, keys };

    // Rule 4: movement rows equal the movements re-derived from the record.
    this.compareMovements(line, moveRows, failed ? [] : deriveMovements(ctx, events, this.idl));

    // Failed rows: one per failed transaction, equal to its record.
    const rows: Row[] = [];
    let failedSeen = false;
    for (const row of all) {
      if (row.kind !== 'failed') {
        rows.push(row);
        continue;
      }
      const errs: [string, string | null, string | null][] = [];
      if (failedSeen) errs.push(['(duplicate row)', 'failed', null]);
      else if (!failed) errs.push(['(failed)', row.values.error ?? '', 'transaction succeeded']);
      else {
        const eq = (field: string, rv: string | undefined, dv: string) => {
          if ((rv ?? '') !== dv) errs.push([field, rv ?? null, dv]);
        };
        eq('signature', row.signature, line.signature);
        eq('block_time', row.values.block_time, str(line.blockTime));
        eq('signer', row.values.signer, keys[0] ?? '');
        eq('tx_fee', row.values.tx_fee, str(line.meta.fee));
        eq('cu', row.values.cu, str(line.meta.computeUnitsConsumed));
        eq('error', row.values.error, line.err?.hex ?? '');
      }
      failedSeen = true;
      for (const [field, rv, dv] of errs) this.mismatch({ kind: 'failed', key: txRef, signature: row.signature, field, row: rv, decoded: dv });
      if (errs.length === 0) this.s.rows_matched++;
    }

    // Rule 1: every row matches one decoded event, and no decoded event is matched twice.
    const byKey = new Map<string, number>();
    events.forEach((ev, i) => byKey.set(`${ev.outerIx}:${ev.innerIx}`, i));
    const used = new Map<number, Row>();
    for (const row of rows) {
      const key: Key = { slot: row.slot, tx_idx: row.txIdx, outer_ix: row.outerIx, inner_ix: row.innerIx };
      const i = byKey.get(`${row.outerIx}:${row.innerIx}`);
      const ev = i === undefined ? undefined : events[i];
      if (ev === undefined || i === undefined) {
        const why = failed ? 'transaction failed' : rec.innerInstructions === null ? 'no inner instructions recorded' : 'none';
        this.mismatch({ kind: row.kind, key, signature: row.signature, field: '(event)', row: `${row.program}:${row.event}`, decoded: why });
        continue;
      }
      const prev = used.get(i);
      if (prev) {
        this.mismatch({ kind: row.kind, key, signature: row.signature, field: '(duplicate row)', row: `${row.kind}:${row.program}:${row.event}`, decoded: `event already matched by a ${prev.kind} row` });
        continue;
      }
      used.set(i, row);
      const errs = this.compare(row, ev, i, ctx);
      for (const [field, rv, dv] of errs) this.mismatch({ kind: row.kind, key, signature: row.signature, field, row: rv, decoded: dv });
      if (errs.length === 0) this.s.rows_matched++;
    }

    // Rule 2: every decoded event the scanner keeps has a row.
    events.forEach((ev, i) => {
      if (used.has(i)) return;
      const key: Key = { slot: line.slot, tx_idx: line.txIndex, outer_ix: ev.outerIx, inner_ix: ev.innerIx };
      const t = line.blockTime ?? 0;
      const miss = (event: string, mint: string) => this.missing({ key, signature: line.signature, event, mint, block_time: line.blockTime });
      const explain = (state: 'in' | 'non_universe' | 'outside_tape', event: string, mint: string) => {
        if (state === 'in') miss(event, mint);
        else this.s.explained_unrowed[state]++;
      };
      if (ev.name === 'other') {
        const def = this.idl.get(`${ev.program}:${ev.discriminator}`);
        if (def === undefined) return miss(`Unknown ${ev.program}:${ev.discriminator}`, '');
        if (DROP_EVENTS.has(def.name)) {
          this.s.explained_unrowed.dropped_events++;
          return;
        }
        const d = decodeIdlEvent(def, eventBody(ctx, ev));
        const mint = d?.fields.mint || d?.fields.base_mint || '';
        if (d === null) return miss(`${def.name} (cut: the scanner cannot read it)`, '');
        if (SAMPLED_ONLY_EVENTS.has(def.name)) return explain(this.tape(mint, t), def.name, mint);
        return miss(def.name, mint);
      }
      if (FULL_NON_TRADE.has(ev.name)) {
        const data = ev.data as { mint?: unknown; baseMint?: unknown };
        return miss(ev.name, str(data.mint ?? data.baseMint));
      }
      let mint = '';
      if (ev.name === 'TradeEvent') mint = ev.data.mint;
      else if (ev.name === 'BuyEvent' || ev.name === 'SellEvent') mint = emitterMints(ctx, ev)?.base ?? this.poolMint.get(ev.data.pool) ?? '';
      explain(this.tape(mint, t), ev.name, mint);
    });
  }

  /**
   * Ends a batch. Rows whose transaction had no raw record: a curve, amm or failed row, or an events row of a mint
   * inside a tape interval, is a mismatch; other events rows are counted.
   */
  endBatch(): void {
    for (const list of this.rows.values()) {
      for (const row of list) {
        const mint = row.kind === 'curve' ? (row.values.mint ?? '') : row.kind === 'amm' ? (row.values.base_mint ?? '') : row.kind === 'failed' ? (row.values.mint_hint ?? '') : row.fields?.mint || row.fields?.base_mint || '';
        // Every CreateEvent and migration row needs its raw record (the scanner keeps them all);
        // other rows only for hash-sampled mints, and events rows only inside a tape.
        const isCreate = row.kind === 'event' && (row.event === 'CreateEvent' || row.event === 'CompletePumpAmmMigrationEvent');
        if (!isCreate && (!(mint !== '' && mintHash(mint) < this.rawSampleRate) || (row.kind === 'event' && this.tape(mint, Number(row.values.block_time ?? 0)) !== 'in'))) {
          this.s.rows_without_raw++;
          continue;
        }
        const key = row.kind === 'failed' ? { slot: row.slot, tx_idx: row.txIdx } : { slot: row.slot, tx_idx: row.txIdx, outer_ix: row.outerIx, inner_ix: row.innerIx };
        this.mismatch({ kind: row.kind, key, signature: row.signature, field: '(raw record)', row: `${row.event} ${mint}`, decoded: 'none' });
      }
    }
    this.rows = new Map();
    for (const list of this.moves.values()) this.s.movements_without_raw += list.length;
    this.moves = new Map();
  }

  /** Rule 4: same rows in every column; rows at one instruction position are compared column by column. */
  private compareMovements(line: RawLine, rows: readonly MovementRow[], derived: readonly MovementRow[]): void {
    const byPos = new Map<string, { rows: MovementRow[]; derived: MovementRow[] }>();
    const at = (m: MovementRow) => {
      const p = `${m.values.outer_ix}:${m.values.inner_ix}`;
      let e = byPos.get(p);
      if (!e) byPos.set(p, (e = { rows: [], derived: [] }));
      return e;
    };
    for (const m of rows) at(m).rows.push(m);
    for (const m of derived) at(m).derived.push(m);
    for (const { rows: rs, derived: ds } of byPos.values()) {
      const ref = rs[0] ?? ds[0]!;
      const key: Key = { slot: line.slot, tx_idx: line.txIndex, outer_ix: Number(ref.values.outer_ix), inner_ix: ref.values.inner_ix === '' ? -1 : Number(ref.values.inner_ix) };
      const report = (field: string, row: string | null, decoded: string | null) => this.mismatch({ kind: 'movement', key, signature: line.signature, field, row, decoded });
      if (rs.length === 1 && ds.length === 1) {
        let ok = true;
        for (const c of MOVEMENT_COLUMNS) {
          if (rs[0]!.values[c] !== ds[0]!.values[c]) {
            ok = false;
            report(c, rs[0]!.values[c] ?? null, ds[0]!.values[c] ?? null);
          }
        }
        if (ok) this.s.movements_matched++;
        continue;
      }
      const left = ds.map(movementText);
      for (const r of rs) {
        const i = left.indexOf(movementText(r));
        if (i >= 0) {
          left.splice(i, 1);
          this.s.movements_matched++;
        } else report('(movement row)', movementText(r), 'none');
      }
      for (const d of left) report('(movement row)', null, d);
    }
  }

  private compare(row: Row, ev: LocatedEvent, evIdx: number, ctx: Ctx): [string, string | null, string | null][] {
    const out: [string, string | null, string | null][] = [];
    const v = row.values;
    const eq = (field: string, rv: string | undefined, dv: string) => {
      if ((rv ?? '') !== dv) out.push([field, rv ?? null, dv]);
    };
    const signer = ctx.keys[0] ?? '';
    if (ev.program !== row.program || ev.name !== row.event) {
      // An event DEC-1 keeps as 'other': the row must carry its exact bytes (Unknown: discriminator and data_hex;
      // a name from the scanner's IDL: that name's discriminator, and the fields read from the body as the scanner reads them).
      if (ev.name === 'other' && row.kind === 'event' && ev.program === row.program) {
        const def = this.idl.get(`${ev.program}:${ev.discriminator}`);
        const body = eventBody(ctx, ev);
        let matched = false;
        if (row.event === 'Unknown' && def === undefined && v.discriminator === ev.discriminator) {
          matched = true;
          eq('data_hex', v.data_hex, toHex(body));
        } else if (def !== undefined && def.name === row.event) {
          matched = true;
          const d = decodeIdlEvent(def, body);
          if (d === null) out.push(['(event)', row.event, 'body cut inside a field']);
          else {
            const f = row.fields ?? {};
            for (const name of new Set([...Object.keys(f), ...Object.keys(d.fields)])) {
              const rv = Object.hasOwn(f, name) ? f[name]! : '(absent)';
              const dv = Object.hasOwn(d.fields, name) ? d.fields[name]! : '(absent)';
              if (rv !== dv) out.push([`fields.${name}`, rv, dv]);
            }
            eq('layout_fields', v.layout_fields, String(d.n));
            eq('extra_hex', v.extra_hex, d.extraHex);
          }
        }
        if (matched) {
          this.s.name_only_matches++;
          eq('signature', row.signature, ctx.line.signature);
          eq('block_time', v.block_time, str(ctx.line.blockTime));
          eq('ev_idx', v.ev_idx, String(evIdx));
          eq('signer', v.signer, signer);
          return out;
        }
      }
      return [['(event)', `${row.program}:${row.event}`, `${ev.program}:${ev.name}`]];
    }
    if (ev.name === 'other') return [['(event)', `${row.program}:${row.event}`, `${ev.program}:other`]];
    const data = ev.data as unknown as Record<string, unknown>;
    const user = str(data.user);
    // Context columns.
    eq('signature', row.signature, ctx.line.signature);
    eq('block_time', v.block_time, str(ctx.line.blockTime));
    eq('ev_idx', v.ev_idx, String(evIdx));
    if (row.kind === 'event') eq('signer', v.signer, signer);
    else if (v.signer === '') {
      if (signer !== user) out.push(['signer', '', `${signer} (user ${user})`]);
    } else eq('signer', v.signer, signer);
    if (row.kind !== 'event') {
      eq('tx_fee', v.tx_fee, str(ctx.line.meta.fee));
      eq('cu', v.cu, str(ctx.line.meta.computeUnitsConsumed));
    }
    eq('layout_fields', v.layout_fields, String(Object.keys(data).length));
    eq('extra_hex', v.extra_hex, ev.extra);

    const field = (col: string, name: string | null, rv: string | undefined) => {
      const present = name !== null && Object.hasOwn(data, name);
      const dv = present ? data[name!] : undefined;
      const r = rv ?? '';
      if (r === '') {
        if (!present) return;
        if (col === 'timestamp' && row.kind !== 'event' && canon(dv) === str(ctx.line.blockTime)) return;
        if (typeof dv === 'string' && dv === '') return; // an empty string is written empty
        out.push([col, '', canon(dv)]);
        return;
      }
      if (!present) {
        out.push([col, r, '(absent)']);
        return;
      }
      const d = canon(dv);
      if (canonRow(r, dv) !== d) out.push([col, r, d]);
    };

    if (row.kind === 'curve') {
      for (const c of CURVE_EVENT_COLUMNS) field(c, camel(c), v[c]);
    } else if (row.kind === 'amm') {
      const side = ev.name === 'SellEvent' ? 'sell' : 'buy';
      for (const [c, f] of Object.entries(AMM_COLUMN_FIELD)) field(c, f[side], v[c]);
      for (const c of AMM_EVENT_COLUMNS) field(c, camel(c), v[c]);
      const em = emitterMints(ctx, ev);
      eq('base_mint', v.base_mint, em?.base ?? '');
      eq('quote_mint', v.quote_mint, em?.quote ?? '');
    } else {
      const f = row.fields ?? {};
      for (const [k, rv] of Object.entries(f)) field(`fields.${k}`, camel(k), rv);
      for (const name of Object.keys(data)) {
        if (!Object.keys(f).some((k) => camel(k) === name)) out.push([`fields.${name}`, '(absent)', canon(data[name])]);
      }
    }
    return out;
  }
}

// ---- token movements (scanner movements.go), re-derived from a raw record ----

export const MOVEMENT_COLUMNS = ['slot', 'block_time', 'tx_idx', 'outer_ix', 'inner_ix', 'mint', 'kind', 'from_owner', 'to_owner', 'amount', 'from_account', 'to_account'] as const;

export interface MovementRow {
  readonly slot: number;
  readonly txIdx: number;
  readonly values: Readonly<Record<string, string>>;
}

export const movementRow = (v: Record<string, string>): MovementRow => ({ slot: int(v.slot, 'slot'), txIdx: int(v.tx_idx, 'tx_idx'), values: v });

const movementText = (m: MovementRow) => MOVEMENT_COLUMNS.map((c) => m.values[c] ?? '').join(',');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Kind and account positions (source, destination, mint; -1 when absent) of an SPL Token / Token-2022 instruction that
 * moves tokens: Transfer 3 (src 0, dst 1), TransferChecked 12 (src 0, mint 1, dst 2), Burn 8 and BurnChecked 15
 * (src 0, mint 1), MintTo 7 and MintToChecked 14 (mint 0, dst 1). The amount is the u64 at data[1..9].
 */
const tokenMove = (data: Uint8Array): { kind: 'transfer' | 'burn' | 'mint'; src: number; dst: number; mint: number } | null => {
  if (data.length < 9) return null;
  switch (data[0]) {
    case 3: return { kind: 'transfer', src: 0, dst: 1, mint: -1 };
    case 12: return { kind: 'transfer', src: 0, dst: 2, mint: 1 };
    case 8: case 15: return { kind: 'burn', src: 0, dst: -1, mint: 1 };
    case 7: case 14: return { kind: 'mint', src: -1, dst: 1, mint: 0 };
  }
  return null;
};

/** The mints of a transaction's decoded pump and PumpSwap events (scanner processTx eventMints), WSOL excepted. */
const eventMintSet = (ctx: Ctx, events: readonly LocatedEvent[], idl: ReadonlyMap<string, IdlEvent>): Set<string> => {
  const out = new Set<string>();
  const add = (m: unknown) => {
    if (typeof m === 'string' && m !== '' && m !== WSOL_MINT) out.add(m);
  };
  for (const ev of events) {
    if (ev.name === 'TradeEvent') add(ev.data.mint);
    else if (ev.name === 'BuyEvent' || ev.name === 'SellEvent') add(emitterMints(ctx, ev)?.base);
    else if (ev.name === 'other') {
      const def = idl.get(`${ev.program}:${ev.discriminator}`);
      const d = def === undefined ? null : decodeIdlEvent(def, eventBody(ctx, ev));
      add(d?.fields.mint);
      add(d?.fields.base_mint);
    } else {
      const data = ev.data as { mint?: unknown; baseMint?: unknown };
      add(data.mint);
      add(data.baseMint);
    }
  }
  return out;
};

/**
 * The movement rows of a successful raw record: token-program movement instructions with no pump or PumpSwap
 * instruction among their callers, for mints ending in "pump" and mints of the transaction's decoded events.
 * Callers come from stack heights: the top-level instruction is height 1, an inner one without a recorded height is
 * taken as called by it (height 2).
 */
export const deriveMovements = (ctx: Ctx, events: readonly LocatedEvent[], idl: ReadonlyMap<string, IdlEvent>): MovementRow[] => {
  const { line, rec, tx, keys } = ctx;
  const active = eventMintSet(ctx, events, idl);
  const want = (m: string) => m.endsWith('pump') || active.has(m);
  const bal = new Map<number, { mint: string; owner: string }>();
  for (const b of line.meta.preTokenBalances ?? []) bal.set(b.accountIndex, { mint: b.mint, owner: b.owner ?? '' });
  for (const b of line.meta.postTokenBalances ?? []) bal.set(b.accountIndex, { mint: b.mint, owner: b.owner ?? '' });
  const out: MovementRow[] = [];
  tx.instructions.forEach((top, gi) => {
    const seq: { programIdIndex: number; accounts: readonly number[]; data: Uint8Array; height: number }[] = [
      { programIdIndex: top.programIdIndex, accounts: top.accounts, data: top.data, height: 1 },
    ];
    for (const g of rec.innerInstructions ?? []) {
      if (g.index !== gi) continue;
      for (const ix of g.instructions) seq.push({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: ix.data, height: ix.stackHeight || 2 });
    }
    // callers[h - 1] is the program running at height h.
    const callers: string[] = [];
    seq.forEach((ix, k) => {
      const h = k === 0 ? 1 : ix.height;
      if (h - 1 < callers.length) callers.length = h - 1;
      const inSwap = callers.some((p) => p === PUMP_PROGRAM || p === PUMP_AMM_PROGRAM);
      const program = keys[ix.programIdIndex] ?? '';
      callers.push(program);
      if (inSwap || (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM)) return;
      const mv = tokenMove(ix.data);
      if (mv === null) return;
      const acct = (pos: number) => (pos >= 0 && pos < ix.accounts.length ? ix.accounts[pos]! : -1);
      const src = acct(mv.src);
      const dst = acct(mv.dst);
      let mint = mv.mint >= 0 ? (keys[acct(mv.mint)] ?? '') : '';
      if (mint === '') mint = (mv.src >= 0 ? bal.get(src)?.mint : undefined) ?? (mv.dst >= 0 ? bal.get(dst)?.mint : undefined) ?? '';
      if (mint === '' || !want(mint)) return;
      let amount = 0n;
      for (let i = 8; i >= 1; i--) amount = (amount << 8n) | BigInt(ix.data[i]!);
      const values: Record<string, string> = {
        slot: String(line.slot),
        block_time: str(line.blockTime),
        tx_idx: String(line.txIndex),
        outer_ix: String(gi),
        inner_ix: k === 0 ? '' : String(k - 1),
        mint,
        kind: mv.kind,
        from_owner: mv.src >= 0 ? (bal.get(src)?.owner ?? '') : '',
        to_owner: mv.dst >= 0 ? (bal.get(dst)?.owner ?? '') : '',
        amount: String(amount),
        from_account: mv.src >= 0 ? (keys[src] ?? '') : '',
        to_account: mv.dst >= 0 ? (keys[dst] ?? '') : '',
      };
      out.push({ slot: line.slot, txIdx: line.txIndex, values });
    });
  });
  return out;
};

export interface Ctx {
  readonly line: RawLine;
  readonly rec: TransactionRecord;
  readonly tx: DecodedTransaction;
  readonly keys: readonly Address[];
}

/**
 * True when the logs are recorded in full and show no cross-program invocation (no `invoke [2]` or deeper): the
 * transaction then had no inner instructions, so no self-CPI event. The archive writes such a transaction's
 * innerInstructions as null (schema-2 test unit: all 10 null records have complete logs without one, and no record has []).
 */
export const logsShowNoCpi = (logs: readonly string[] | null | undefined): boolean =>
  Array.isArray(logs) && logs.length > 0 && !logs.some((l) => l === 'Log truncated' || /^Program \w+ invoke \[(?:[2-9]|\d{2,})\]$/.test(l));

/** The event's body: its inner instruction's data after EVENT_IX_TAG and the 8-byte discriminator. */
const eventBody = (ctx: Ctx, ev: LocatedEvent): Uint8Array =>
  ctx.rec.innerInstructions?.find((g) => g.index === ev.outerIx)?.instructions[ev.innerIx]?.data.subarray(16) ?? new Uint8Array();

/**
 * Base and quote mint of a PumpSwap trade: accounts 3 and 4 of the pump_amm instruction that emitted the event (the
 * nearest earlier pump_amm instruction one level up the stack in the same top-level group; pump_amm IDL buy, sell,
 * buy_exact_quote_in and boost_buy_and_burn all put base_mint and quote_mint there). Null when not found.
 */
export const emitterMints = (ctx: Ctx, ev: LocatedEvent): { base: string; quote: string } | null => {
  const outer = ctx.tx.instructions[ev.outerIx];
  const group = ctx.rec.innerInstructions?.find((g) => g.index === ev.outerIx);
  if (!outer || !group) return null;
  const seq = [{ programIdIndex: outer.programIdIndex, accounts: outer.accounts, data: outer.data, stackHeight: 1 as number | null }, ...group.instructions];
  const at = ev.innerIx + 1;
  const h = seq[at]?.stackHeight ?? 0;
  for (let i = at - 1; i >= 0; i--) {
    const ix = seq[i]!;
    if (ctx.keys[ix.programIdIndex] !== PUMP_AMM_PROGRAM) continue;
    if (h !== 0 && ix.stackHeight !== h - 1) continue;
    if (hasDiscriminator(ix.data, EVENT_IX_TAG)) continue;
    if (ix.accounts.length <= 8) return null;
    return { base: ctx.keys[ix.accounts[3]!] ?? '', quote: ctx.keys[ix.accounts[4]!] ?? '' };
  }
  return null;
};

// ---- dataset files ----

const zstText = (path: string) => zstdDecompressSync(readFileSync(path)).toString('utf8');

async function* zstLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path).pipe(createZstdDecompress()), crlfDelay: Infinity });
  for await (const l of rl) if (l !== '') yield l;
}

const filesWith = (dir: string, prefix: string) =>
  readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`))
    .sort()
    .map((f) => join(dir, f));

/** finalize.go tapeList: `kind:from-to` intervals joined by `|`. */
export const parseTapes = (s: string): [number, number][] =>
  s === ''
    ? []
    : s.split('|').map((t) => {
        const m = /^[^:]*:(-?\d+)-(-?\d+)$/.exec(t);
        if (!m) throw new Error(`tape interval ${JSON.stringify(t)} is not kind:from-to`);
        return [Number(m[1]), Number(m[2])];
      });

export const readMints = (dir: string): MintInfo[] =>
  filesWith(dir, 'mints').flatMap((f) =>
    csvObjects(zstText(f)).map((m) => ({
      mint: m.mint ?? '',
      pool: m.pool ?? '',
      tapeFrom: Number(m.tape_from ?? 0),
      tapeTo: Number(m.tape_to ?? 0),
      ...(m.tapes === undefined ? {} : { tapes: parseTapes(m.tapes) }),
    })),
  );

/** Runs the check over every day of a dataset directory and returns the summary (does not exit). */
export const runParity = async (dir: string): Promise<ParitySummary> => {
  // Without a manifest every row must have its raw record (rate 1, the strictest reading).
  const mp = join(dir, 'manifest.json');
  const man = (existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : {}) as { sampling?: { unit_sample_rate_min?: number } };
  const checker = new ParityChecker(readMints(dir), loadScannerIdl(), man.sampling?.unit_sample_rate_min ?? 1);
  const daysDir = join(dir, 'days');
  for (const day of readdirSync(daysDir).sort()) {
    const d = join(daysDir, day);
    for (const f of filesWith(d, 'curve_trades')) for (const v of csvObjects(zstText(f))) checker.addRow(curveRow(v));
    for (const f of filesWith(d, 'amm_trades')) for (const v of csvObjects(zstText(f))) checker.addRow(ammRow(v));
    for (const f of filesWith(d, 'failed')) for (const v of csvObjects(zstText(f))) checker.addRow(failedRow(v));
    for (const f of filesWith(d, 'events')) for await (const l of zstLines(f)) checker.addRow(eventRow(JSON.parse(l) as Record<string, unknown>));
    for (const f of filesWith(d, 'movements')) for (const v of csvObjects(zstText(f))) checker.addMovement(v);
    for (const f of filesWith(d, 'raw')) for await (const l of zstLines(f)) checker.checkRaw(JSON.parse(l) as RawLine);
    checker.endBatch();
  }
  return checker.s;
};

/** h(mint): first 8 bytes of sha256(mint pubkey bytes), big-endian, / 2^64 (scanner sample.go mintHashFraction). */
export const mintHash = (mint: string): number => Number(createHash('sha256').update(decodeBase58(mint)).digest().readBigUInt64BE(0)) / 2 ** 64;

export const failed = (s: ParitySummary): boolean => s.mismatch_count > 0 || s.missing_row_count > 0;
