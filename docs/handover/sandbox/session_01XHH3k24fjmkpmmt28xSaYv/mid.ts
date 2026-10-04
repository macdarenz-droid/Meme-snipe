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
    mismatches: [],
    missing_rows: [],
  };

  constructor(mints: readonly MintInfo[], idl: ReadonlyMap<string, IdlEvent> = loadScannerIdl()) {
    this.idl = idl;
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
      if (keys.includes(PUMP_PROGRAM) || keys.includes(PUMP_AMM_PROGRAM)) {
        this.mismatch({ kind: 'decode', key: txRef, signature: line.signature, field: 'innerInstructions', row: null, decoded: 'null: the pump / PumpSwap events of this transaction cannot be decoded' });
      }
    }
    this.s.decoded_events += events.length;
    const ctx: Ctx = { line, rec, tx, keys };

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
        if (row.kind === 'event' && this.tape(mint, Number(row.values.block_time ?? 0)) !== 'in') {
          this.s.rows_without_raw++;
          continue;
        }
        const key = row.kind === 'failed' ? { slot: row.slot, tx_idx: row.txIdx } : { slot: row.slot, tx_idx: row.txIdx, outer_ix: row.outerIx, inner_ix: row.innerIx };
        this.mismatch({ kind: row.kind, key, signature: row.signature, field: '(raw record)', row: `${row.event} ${mint}`, decoded: 'none' });
      }
    }
    this.rows = new Map();
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
