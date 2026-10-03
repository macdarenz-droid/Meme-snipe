// Decoder parity for the historical dataset (docs/research/historical-data.md, schema 2). CLI:
//
//   node --no-warnings research/historical/qa/parity.ts <dataset-dir>
//
// Proves the scanner's rows equal the shared chain decoder (packages/core/src/chain, DEC-1) on the raw records:
//   1. Every curve_trades, amm_trades and events row whose transaction has a raw record is matched by exactly one
//      decoded event with the same (slot, tx_idx, outer_ix, inner_ix), program and event name, and every value the
//      row carries equals the decoded value (base_mint and quote_mint of PumpSwap rows: the accounts of the
//      instruction that emitted the event, resolved through the transaction's loaded addresses).
//   2. Every decoded TradeEvent, BuyEvent and SellEvent of a successful raw record whose mint is a universe mint
//      inside its tape has a row; every decoded create, complete, migration, pool-creation and boost event has an
//      events row (the scanner keeps those for every mint). Events of mints outside the universe or outside their
//      tape are counted as explained.
// A raw record the decoder refuses is a mismatch. The CLI prints the summary, writes <dataset-dir>/qa/parity.json and
// exits 1 on any mismatch or missing row.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
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
  accountKeys,
  decodeTransaction,
  fromBase64,
  hasDiscriminator,
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
  };
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

export type RowKind = 'curve' | 'amm' | 'event';

export interface Row {
  readonly kind: RowKind;
  readonly slot: number;
  readonly txIdx: number;
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

/** Events the decoder names in full and the scanner keeps for every mint (sample.go keepEvent). */
const ALWAYS_KEPT = new Set(['CreateEvent', 'CompleteEvent', 'CompletePumpAmmMigrationEvent', 'CreatePoolEvent', 'InitBoostEvent', 'BoostBuyAndBurnEvent']);

/** Anchor event discriminator: sha256("event:<Name>")[0..8], hex. */
const anchorDiscriminator = (name: string) => createHash('sha256').update(`event:${name}`).digest('hex').slice(0, 16);

// ---- the check ----

export interface Key {
  readonly slot: number;
  readonly tx_idx: number;
  readonly outer_ix: number;
  readonly inner_ix: number;
}

export interface Mismatch {
  readonly kind: RowKind | 'decode';
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
  readonly tapeFrom: number;
  readonly tapeTo: number;
}

export interface ParitySummary {
  raw_records: number;
  raw_failed: number;
  raw_without_inner: number;
  decoded_events: number;
  rows_checked: number;
  rows_matched: number;
  rows_without_raw: number;
  name_only_matches: number;
  explained_unrowed: { non_universe: number; outside_tape: number; other_events: number };
  mismatch_count: number;
  missing_row_count: number;
  unchecked_columns: readonly string[];
  mismatches: Mismatch[];
  missing_rows: MissingRow[];
}

const LIST_LIMIT = 100;
const txKey = (slot: number, tx: number) => `${slot}:${tx}`;

export class ParityChecker {
  private readonly mints = new Map<string, MintInfo>();
  private readonly poolMint = new Map<string, string>();
  private rows = new Map<string, Row[]>();
  readonly s: ParitySummary = {
    raw_records: 0,
    raw_failed: 0,
    raw_without_inner: 0,
    decoded_events: 0,
    rows_checked: 0,
    rows_matched: 0,
    rows_without_raw: 0,
    name_only_matches: 0,
    explained_unrowed: { non_universe: 0, outside_tape: 0, other_events: 0 },
    mismatch_count: 0,
    missing_row_count: 0,
    unchecked_columns: UNCHECKED_COLUMNS,
    mismatches: [],
    missing_rows: [],
  };

  constructor(mints: readonly MintInfo[]) {
    for (const m of mints) {
      this.mints.set(m.mint, m);
      if (m.pool) this.poolMint.set(m.pool, m.mint);
    }
  }

  /** Adds the rows of one batch (a day). Call `checkRaw` for the batch's raw records, then `endBatch`. */
  addRow(r: Row): void {
    const k = txKey(r.slot, r.txIdx);
    const list = this.rows.get(k);
    if (list) list.push(r);
    else this.rows.set(k, [r]);
    if (r.kind === 'amm' && r.values.pool && r.values.base_mint) this.poolMint.set(r.values.pool, r.values.base_mint);
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
    const rows = this.rows.get(k) ?? [];
    this.rows.delete(k);
    this.s.rows_checked += rows.length;
    const txRef = { slot: line.slot, tx_idx: line.txIndex };
    const failed = line.err !== null && line.err !== undefined;
    if (failed) this.s.raw_failed++;
    if (!failed && line.meta.innerInstructions === null) this.s.raw_without_inner++;

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
    this.s.decoded_events += events.length;
    const ctx = { line, rec, tx, keys, events };

    // Rule 1: every row matches exactly one decoded event.
    const byKey = new Map<string, number>();
    events.forEach((ev, i) => byKey.set(`${ev.outerIx}:${ev.innerIx}`, i));
    const seen = new Set<string>();
    for (const row of rows) {
      const key: Key = { slot: row.slot, tx_idx: row.txIdx, outer_ix: row.outerIx, inner_ix: row.innerIx };
      const kk = `${row.kind === 'event' ? 'e' : 't'}:${row.outerIx}:${row.innerIx}`;
      if (seen.has(kk)) {
        this.mismatch({ kind: row.kind, key, signature: row.signature, field: '(duplicate row)', row: row.event, decoded: null });
        continue;
      }
      seen.add(kk);
      const i = byKey.get(`${row.outerIx}:${row.innerIx}`);
      const ev = i === undefined ? undefined : events[i];
      if (ev === undefined || i === undefined) {
        const why = failed ? 'transaction failed' : rec.innerInstructions === null ? 'no inner instructions recorded' : 'none';
        this.mismatch({ kind: row.kind, key, signature: row.signature, field: '(event)', row: `${row.program}:${row.event}`, decoded: why });
        continue;
      }
      const errs = this.compare(row, ev, i, ctx);
      for (const [field, rv, dv] of errs) this.mismatch({ kind: row.kind, key, signature: row.signature, field, row: rv, decoded: dv });
      if (errs.length === 0) this.s.rows_matched++;
    }

    // Rule 2: decoded trades of universe mints inside their tape, and always-kept events, have rows.
    if (failed) return;
    for (const ev of events) {
      const key: Key = { slot: line.slot, tx_idx: line.txIndex, outer_ix: ev.outerIx, inner_ix: ev.innerIx };
      if (ev.name === 'other') {
        if (!rows.some((r) => r.kind === 'event' && r.outerIx === ev.outerIx && r.innerIx === ev.innerIx)) this.s.explained_unrowed.other_events++;
        continue;
      }
      const isTrade = ev.name === 'TradeEvent' || ev.name === 'BuyEvent' || ev.name === 'SellEvent';
      const has = rows.some((r) => (isTrade ? r.kind !== 'event' : r.kind === 'event') && r.outerIx === ev.outerIx && r.innerIx === ev.innerIx);
      if (has) continue;
      if (!isTrade) {
        if (ALWAYS_KEPT.has(ev.name)) this.missing({ key, signature: line.signature, event: ev.name, mint: str((ev.data as { mint?: unknown; baseMint?: unknown }).mint ?? (ev.data as { baseMint?: unknown }).baseMint), block_time: line.blockTime });
        continue;
      }
      let mint = '';
      if (ev.name === 'TradeEvent') mint = ev.data.mint;
      else if (ev.name === 'BuyEvent' || ev.name === 'SellEvent') mint = emitterMints(ctx, ev)?.base ?? this.poolMint.get(ev.data.pool) ?? '';
      const mi = this.mints.get(mint);
      if (!mi || mi.tapeFrom === 0) {
        this.s.explained_unrowed.non_universe++;
        continue;
      }
      const t = line.blockTime ?? 0;
      if (t < mi.tapeFrom || t > mi.tapeTo) {
        this.s.explained_unrowed.outside_tape++;
        continue;
      }
      this.missing({ key, signature: line.signature, event: ev.name, mint, block_time: line.blockTime });
    }
  }

  /** Ends a batch: rows whose transaction had no raw record are counted (not checked). */
  endBatch(): void {
    for (const list of this.rows.values()) this.s.rows_without_raw += list.length;
    this.rows = new Map();
  }

  private compare(row: Row, ev: LocatedEvent, evIdx: number, ctx: Ctx): [string, string | null, string | null][] {
    const out: [string, string | null, string | null][] = [];
    const v = row.values;
    const eq = (field: string, rv: string | undefined, dv: string) => {
      if ((rv ?? '') !== dv) out.push([field, rv ?? null, dv]);
    };
    if (ev.program !== row.program || ev.name !== row.event) {
      // An event the scanner names but the decoder keeps as 'other': the discriminator must be that name's.
      if (ev.name === 'other' && row.kind === 'event' && ev.program === row.program) {
        const want = row.event === 'Unknown' ? (v.discriminator ?? '') : anchorDiscriminator(row.event);
        if (want === ev.discriminator) {
          this.s.name_only_matches++;
          eq('ev_idx', v.ev_idx, String(evIdx));
          eq('signature', row.signature, ctx.line.signature);
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
    const signer = ctx.keys[0] ?? '';
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

interface Ctx {
  readonly line: RawLine;
  readonly rec: TransactionRecord;
  readonly tx: DecodedTransaction;
  readonly keys: readonly Address[];
}

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

export const readMints = (dir: string): MintInfo[] =>
  filesWith(dir, 'mints').flatMap((f) =>
    csvObjects(zstText(f)).map((m) => ({ mint: m.mint ?? '', pool: m.pool ?? '', tapeFrom: Number(m.tape_from ?? 0), tapeTo: Number(m.tape_to ?? 0) })),
  );

/** Runs the check over every day of a dataset directory and returns the summary (does not exit). */
export const runParity = async (dir: string): Promise<ParitySummary> => {
  const checker = new ParityChecker(readMints(dir));
  const daysDir = join(dir, 'days');
  for (const day of readdirSync(daysDir).sort()) {
    const d = join(daysDir, day);
    for (const f of filesWith(d, 'curve_trades')) for (const v of csvObjects(zstText(f))) checker.addRow(curveRow(v));
    for (const f of filesWith(d, 'amm_trades')) for (const v of csvObjects(zstText(f))) checker.addRow(ammRow(v));
    for (const f of filesWith(d, 'events')) for await (const l of zstLines(f)) checker.addRow(eventRow(JSON.parse(l) as Record<string, unknown>));
    for (const f of filesWith(d, 'raw')) for await (const l of zstLines(f)) checker.checkRaw(JSON.parse(l) as RawLine);
    checker.endBatch();
  }
  return checker.s;
};

export const failed = (s: ParitySummary): boolean => s.mismatch_count > 0 || s.missing_row_count > 0;
