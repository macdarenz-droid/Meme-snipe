// Decoder parity check of the historical dataset (src/dataset/parity.ts; CLI research/historical/qa/parity.ts): synthetic raw records with
// pump and PumpSwap self-CPI events, built byte by byte here, against matching and broken dataset rows.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BuyEventLayout,
  EVENT_IX_TAG,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  TradeEventLayout,
  decodeBase58,
  encodeBase58,
  toBase64,
} from '../../core/src/chain/index.ts';
import {
  type MintInfo,
  type RawLine,
  type Row,
  DROP_EVENTS,
  ParityChecker,
  SAMPLED_ONLY_EVENTS,
  ammRow,
  csvObjects,
  curveRow,
  eventRow,
  failed,
  failedRow,
  mintHash,
  parseTapes,
  runParity,
} from '../src/dataset/parity.ts';

// ---- byte builders ----

const le = (v: bigint, n: number) => {
  const out: number[] = [];
  let x = BigInt.asUintN(n * 8, v);
  for (let i = 0; i < n; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
};

/** Borsh-encodes `values` for the fields of a layout, from each codec's IDL type. */
const encode = (fields: readonly (readonly [string, { idl: unknown }])[], values: Record<string, unknown>): number[] =>
  fields.flatMap(([name, c]) => {
    const v = values[name];
    switch (c.idl) {
      case 'pubkey':
        return [...decodeBase58(v as string)];
      case 'u64':
      case 'i64':
        return le(BigInt(v as bigint), 8);
      case 'i128':
        return le(BigInt(v as bigint), 16);
      case 'u16':
        return le(BigInt(v as number), 2);
      case 'u8':
        return [v as number];
      case 'bool':
        return [v ? 1 : 0];
      case 'string': {
        const b = new TextEncoder().encode(v as string);
        return [...le(BigInt(b.length), 4), ...b];
      }
      default:
        throw new Error(`fixture encoder: unsupported type ${JSON.stringify(c.idl)} of ${name}`);
    }
  });

const key = (b: number) => encodeBase58(new Uint8Array(32).fill(b));
const PAYER = key(1);
const USER = key(2);
const MINT = key(3);
const POOL = key(4);
const BASE = key(5);
const QUOTE = key(6);
const FEE_RECIPIENT = key(7);
// Static keys: payer, pump, PumpSwap, then nine accounts of the PumpSwap buy (base mint at its account 3, quote at 4).
const AMM_ACCOUNT_KEYS = [POOL, USER, key(8), BASE, QUOTE, key(9), key(10), key(11), key(12)];
const STATIC_KEYS = [PAYER, PUMP_PROGRAM, PUMP_AMM_PROGRAM, ...AMM_ACCOUNT_KEYS];

const sig = (n: number) => {
  const b = new Uint8Array(64);
  b[0] = n;
  return b;
};

/** A legacy transaction: one signature, a pump instruction (0) and a PumpSwap instruction (1). */
const wire = (n: number) =>
  Uint8Array.from([
    1, ...sig(n),
    1, 0, 0,
    STATIC_KEYS.length, ...STATIC_KEYS.flatMap((k) => [...decodeBase58(k)]),
    ...new Array(32).fill(9),
    2,
    1, 1, 0, 1, 0xaa,
    2, 9, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 0xbb,
  ]);

const BLOCK_TIME = 1790968137;
const trade = {
  mint: MINT, solAmount: 4541976n, tokenAmount: 20825930166n, isBuy: false, user: USER, timestamp: BigInt(BLOCK_TIME),
  virtualSolReserves: 83785516724n, virtualTokenReserves: 384195282731858n, realSolReserves: 53785516724n, realTokenReserves: 104295282731858n,
  feeRecipient: FEE_RECIPIENT, feeBasisPoints: 95n, fee: 43149n,
};
const buy = {
  timestamp: BigInt(BLOCK_TIME - 1), baseAmountOut: 132472017024n, maxQuoteAmountIn: 55000000n, userBaseTokenReserves: 0n, userQuoteTokenReserves: 60000000n,
  poolBaseTokenReserves: 206900000000000n, poolQuoteTokenReserves: 67405854936n, quoteAmountIn: 54382022n, lpFeeBasisPoints: 2n, lpFee: 10877n,
  protocolFeeBasisPoints: 93n, protocolFee: 505753n, quoteAmountInWithLpFee: 54392899n, userQuoteAmountIn: 54898652n, pool: POOL, user: USER,
  userBaseTokenAccount: key(13), userQuoteTokenAccount: key(14), protocolFeeRecipient: key(15), protocolFeeRecipientTokenAccount: key(16),
  coinCreator: key(17), coinCreatorFeeBasisPoints: 30n, coinCreatorFee: 163147n,
};
const tradeFields = [...TradeEventLayout.base, ...TradeEventLayout.added.slice(0, 3)];
const buyFields = [...BuyEventLayout.base, ...BuyEventLayout.added.slice(0, 3)];
const eventIx = (programIdIndex: number, disc: Uint8Array, body: number[]) => ({
  programIdIndex,
  accounts: [],
  data: toBase64(Uint8Array.from([...EVENT_IX_TAG, ...disc, ...body])),
  stackHeight: 2,
});

const raw = (n: number, over: Partial<RawLine> = {}, extra: ReturnType<typeof eventIx>[] = []): RawLine => ({
  slot: 452700000,
  blockTime: BLOCK_TIME,
  txIndex: n,
  signature: encodeBase58(sig(n)),
  transaction: toBase64(wire(n)),
  err: null,
  mints: [MINT],
  meta: {
    fee: 105000,
    computeUnitsConsumed: 72082,
    loadedAddresses: { writable: [], readonly: [] },
    innerInstructions: [
      // An older TradeEvent version: the base fields and the first three added ones.
      { index: 0, instructions: [eventIx(1, TradeEventLayout.discriminator, encode(tradeFields, trade)), ...extra] },
      { index: 1, instructions: [eventIx(2, BuyEventLayout.discriminator, encode(buyFields, buy))] },
    ],
    logMessages: null,
  },
  ...over,
});

const ctxCols = (n: number) => ({ slot: '452700000', block_time: String(BLOCK_TIME), tx_idx: String(n), signature: encodeBase58(sig(n)), signer: PAYER, tx_fee: '105000', cu: '72082', jito_tip: '0', last_in_tx: '1' });
const curveValues = (n: number): Record<string, string> => ({
  ...ctxCols(n), ev_idx: '0', outer_ix: '0', inner_ix: '0',
  mint: MINT, is_buy: '0', sol_amount: '4541976', token_amount: '20825930166', user: USER, timestamp: '',
  virtual_sol_reserves: '83785516724', virtual_token_reserves: '384195282731858', real_sol_reserves: '53785516724', real_token_reserves: '104295282731858',
  fee_recipient: FEE_RECIPIENT, fee_basis_points: '95', fee: '43149', creator: '', creator_fee_basis_points: '', creator_fee: '',
  track_volume: '', ix_name: '', mayhem_mode: '', cashback_fee_basis_points: '', cashback: '', buyback_fee_basis_points: '', buyback_fee: '',
  shareholders: '', quote_mint: '', quote_amount: '', virtual_quote_reserves: '', real_quote_reserves: '', holder_rewards_bps: '', holder_rewards: '',
  extra_hex: '', layout_fields: '13', chain_curve_lamports: '1', chain_curve_base: '2', chain_curve_quote: '',
});
const ammValues = (n: number): Record<string, string> => ({
  ...ctxCols(n), ev_idx: '1', outer_ix: '1', inner_ix: '0',
  pool: POOL, base_mint: BASE, quote_mint: QUOTE, side: 'buy', base_amount: '132472017024', quote_amount: '54382022', limit_quote: '55000000',
  user: USER, timestamp: String(BLOCK_TIME - 1), pool_base_token_reserves: '206900000000000', pool_quote_token_reserves: '67405854936',
  lp_fee_basis_points: '2', lp_fee: '10877', protocol_fee_basis_points: '93', protocol_fee: '505753', quote_amount_lp_adjusted: '54392899',
  user_quote_amount: '54898652', protocol_fee_recipient: key(15), coin_creator: key(17), coin_creator_fee_basis_points: '30', coin_creator_fee: '163147',
  track_volume: '', min_base_amount_out: '', ix_name: '', cashback_fee_basis_points: '', cashback: '', buyback_fee_basis_points: '', buyback_fee: '',
  virtual_quote_reserves: '', can_boost: '', base_supply: '', holder_rewards_bps: '', holder_rewards: '',
  extra_hex: '', layout_fields: '23', chain_pool_base: '1', chain_pool_quote: '2',
});

const universe: MintInfo[] = [
  { mint: MINT, pool: '', tapeFrom: BLOCK_TIME - 100, tapeTo: BLOCK_TIME + 100 },
  { mint: BASE, pool: POOL, tapeFrom: BLOCK_TIME - 100, tapeTo: BLOCK_TIME + 100 },
];

const check = (rows: Record<string, string>[][], raws: RawLine[], mints = universe, other: Row[] = []) => {
  const c = new ParityChecker(mints);
  const [curve = [], amm = []] = rows;
  for (const v of curve) c.addRow(curveRow(v));
  for (const v of amm) c.addRow(ammRow(v));
  for (const r of other) c.addRow(r);
  for (const r of raws) c.checkRaw(r);
  c.endBatch();
  return c.s;
};

describe('historical dataset decoder parity', () => {
  it('matches curve and PumpSwap rows equal to the decoded events, field by field', () => {
    const s = check([[curveValues(7)], [ammValues(7)]], [raw(7)]);
    expect(s.mismatches).toEqual([]);
    expect(s.missing_rows).toEqual([]);
    expect(s).toMatchObject({ raw_records: 1, decoded_events: 2, rows_checked: 2, rows_matched: 2, rows_without_raw: 0 });
    expect(failed(s)).toBe(false);
  });

  it('reports a value that differs from the decoder, with both values', () => {
    const s = check([[{ ...curveValues(7), sol_amount: '4541977' }], [ammValues(7)]], [raw(7)]);
    expect(failed(s)).toBe(true);
    expect(s.mismatches).toEqual([
      { kind: 'curve', key: { slot: 452700000, tx_idx: 7, outer_ix: 0, inner_ix: 0 }, signature: encodeBase58(sig(7)), field: 'sol_amount', row: '4541977', decoded: '4541976' },
    ]);
  });

  it('checks base and quote mint against the emitting instruction, and empty columns against absent fields', () => {
    const s = check([[{ ...curveValues(7), creator: key(30) }], [{ ...ammValues(7), base_mint: key(31), min_base_amount_out: '5' }]], [raw(7)]);
    expect(s.mismatches.map((m) => [m.field, m.row, m.decoded])).toEqual([
      ['creator', key(30), '(absent)'],
      ['min_base_amount_out', '5', '(absent)'],
      ['base_mint', key(31), BASE],
    ]);
  });

  it('accepts an empty signer only when it equals the user', () => {
    const s = check([[{ ...curveValues(7), signer: '' }], [ammValues(7)]], [raw(7)]);
    expect(s.mismatches.map((m) => m.field)).toEqual(['signer']);
  });

  it('reports a decoded trade of a universe mint inside its tape that has no row', () => {
    const s = check([[], [ammValues(7)]], [raw(7)]);
    expect(failed(s)).toBe(true);
    expect(s.missing_rows).toEqual([
      { key: { slot: 452700000, tx_idx: 7, outer_ix: 0, inner_ix: 0 }, signature: encodeBase58(sig(7)), event: 'TradeEvent', mint: MINT, block_time: BLOCK_TIME },
    ]);
  });

  it('explains trades without rows of mints outside the universe or outside their tape', () => {
    const s = check([[], []], [raw(7)], [{ mint: BASE, pool: POOL, tapeFrom: BLOCK_TIME + 1, tapeTo: BLOCK_TIME + 100 }]);
    expect(failed(s)).toBe(false);
    expect(s.explained_unrowed).toEqual({ non_universe: 1, outside_tape: 1, dropped_events: 0 });
  });

  it('fails a row whose transaction failed, and a raw record the decoder refuses', () => {
    const s = check([[curveValues(7)], []], [raw(7, { err: { hex: '08000000041900000072170000' } }), raw(8, { transaction: toBase64(Uint8Array.of(1, 2, 3)) })]);
    expect(s.mismatches.map((m) => [m.kind, m.field, m.decoded?.slice(0, 18)])).toEqual([
      ['curve', '(event)', 'transaction failed'],
      ['decode', 'transaction', expect.any(String)],
    ]);
    expect(s.raw_failed).toBe(1);
  });

  it('fails a trade row without its raw record', () => {
    const s = check([[curveValues(9)], []], [raw(7)]);
    expect(s.mismatches.filter((m) => m.key.tx_idx === 9).map((m) => [m.kind, m.field, m.row])).toEqual([['curve', '(raw record)', `TradeEvent ${MINT}`]]);
    expect(s.rows_without_raw).toBe(0);
  });

  it('reads CSV rows as objects keyed by the header, quoted fields included', () => {
    expect(csvObjects('a,b\n"x,""y""",\n"multi\nline",z\n')).toEqual([{ a: 'x,"y"', b: '' }, { a: 'multi\nline', b: 'z' }]);
  });
});

// ---- events DEC-1 keeps as 'other' (decoded with the scanner's IDL), failed rows, missing raw records ----

const REPO = join(import.meta.dirname, '../../..');
const idlDoc = (file: string) =>
  JSON.parse(readFileSync(join(REPO, 'research/historical/scanner/idl', file), 'utf8')) as { events: { name: string; discriminator: number[] }[] };
const idlDisc = (name: string) => Uint8Array.from(idlDoc('pump.json').events.find((e) => e.name === name)!.discriminator);
const hex = (b: Iterable<number>) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const UNKNOWN_DISC = '742b4dbd117a482b';
const extendBody = [...decodeBase58(key(20)), ...decodeBase58(USER), ...le(100n, 8), ...le(200n, 8), ...le(BigInt(BLOCK_TIME), 8)];
const unknownBody = [1, 2, 3, 4, 5];
const dropBody = [...decodeBase58(PAYER), ...decodeBase58(USER), ...le(BigInt(BLOCK_TIME), 8)];
const setCreatorBody = (mint: string) => [...le(BigInt(BLOCK_TIME), 8), ...decodeBase58(mint), ...decodeBase58(key(21)), ...decodeBase58(key(22))];
/** Group 0 after the TradeEvent: ExtendAccountEvent (inner 1), an Unknown (2), InitUserVolumeAccumulatorEvent (3, dropped), SetCreatorEvent (4). */
const extras = (creatorMint = MINT) => [
  eventIx(1, idlDisc('ExtendAccountEvent'), extendBody),
  eventIx(1, Uint8Array.from(Buffer.from(UNKNOWN_DISC, 'hex')), unknownBody),
  eventIx(1, idlDisc('InitUserVolumeAccumulatorEvent'), dropBody),
  eventIx(1, idlDisc('SetCreatorEvent'), setCreatorBody(creatorMint)),
];
const rich = (n: number, creatorMint = MINT) => raw(n, {}, extras(creatorMint));
const evCtx = (n: number, inner: number, evIdx: number) => ({
  slot: 452700000, block_time: BLOCK_TIME, tx_idx: n, ev_idx: evIdx, signature: encodeBase58(sig(n)), signer: PAYER, program: 'pump', outer_ix: 0, inner_ix: inner, jito_tip: '0',
});
const extendRow = (n: number, f: Record<string, string> = {}) =>
  eventRow({ ...evCtx(n, 1, 1), event: 'ExtendAccountEvent', layout_fields: 5, fields: { account: key(20), user: USER, current_size: '100', new_size: '200', timestamp: String(BLOCK_TIME), ...f } });
const unknownRow = (n: number, dataHex = hex(unknownBody)) => eventRow({ ...evCtx(n, 2, 2), event: 'Unknown', discriminator: UNKNOWN_DISC, data_hex: dataHex });
const setCreatorRow = (n: number, mint = MINT) =>
  eventRow({ ...evCtx(n, 4, 4), event: 'SetCreatorEvent', layout_fields: 4, fields: { timestamp: String(BLOCK_TIME), mint, bonding_curve: key(21), creator: key(22) } });
const richAmm = (n: number) => ({ ...ammValues(n), ev_idx: '5' });
const failedValues = (n: number): Record<string, string> => ({
  slot: '452700000', block_time: String(BLOCK_TIME), tx_idx: String(n), signature: encodeBase58(sig(n)), signer: PAYER, tx_fee: '105000', cu: '72082',
  programs: 'pump', mint_hint: MINT, error: '08000000041900000072170000',
});
const failedRaw = (n: number) => raw(n, { err: { hex: '08000000041900000072170000' } });

describe('decoder parity: every kept event, each decoded event once, raw records present', () => {
  it('matches events DEC-1 keeps as other on their bytes, and explains a dropped event', () => {
    const s = check([[curveValues(7)], [richAmm(7)]], [rich(7)], universe, [extendRow(7), unknownRow(7), setCreatorRow(7)]);
    expect(s.mismatches).toEqual([]);
    expect(s.missing_rows).toEqual([]);
    expect(s).toMatchObject({ decoded_events: 6, rows_matched: 5, name_only_matches: 3 });
    expect(s.explained_unrowed).toEqual({ non_universe: 0, outside_tape: 0, dropped_events: 1 });
  });

  it('fails a decoded event matched by two rows, of the same kind or across trade and events rows', () => {
    const dup = check([[curveValues(7), curveValues(7)], [ammValues(7)]], [raw(7)]);
    expect(dup.mismatches.map((m) => [m.kind, m.field, m.decoded])).toEqual([['curve', '(duplicate row)', 'event already matched by a curve row']]);
    const tradeAsEvent = eventRow({
      ...evCtx(7, 0, 0), event: 'TradeEvent', layout_fields: 13,
      fields: {
        mint: MINT, sol_amount: '4541976', token_amount: '20825930166', is_buy: '0', user: USER, timestamp: String(BLOCK_TIME),
        virtual_sol_reserves: '83785516724', virtual_token_reserves: '384195282731858', real_sol_reserves: '53785516724', real_token_reserves: '104295282731858',
        fee_recipient: FEE_RECIPIENT, fee_basis_points: '95', fee: '43149',
      },
    });
    // The events row alone matches the TradeEvent in full; with the curve row it is a second use of the same event.
    expect(check([[], [ammValues(7)]], [raw(7)], universe, [tradeAsEvent]).mismatches).toEqual([]);
    const cross = check([[curveValues(7)], [ammValues(7)]], [raw(7)], universe, [tradeAsEvent]);
    expect(cross.mismatches.map((m) => [m.kind, m.field, m.decoded])).toEqual([['event', '(duplicate row)', 'event already matched by a curve row']]);
  });

  it('reports a kept named event and an Unknown event without a row', () => {
    const s = check([[curveValues(7)], [richAmm(7)]], [rich(7)], universe, [setCreatorRow(7)]);
    expect(s.missing_rows.map((m) => [m.key.inner_ix, m.event])).toEqual([[1, 'ExtendAccountEvent'], [2, `Unknown pump:${UNKNOWN_DISC}`]]);
    expect(failed(s)).toBe(true);
  });

  it('requires a sampled-only event only when its mint is inside a tape', () => {
    const inTape = check([[curveValues(7)], [richAmm(7)]], [rich(7)], universe, [extendRow(7), unknownRow(7)]);
    expect(inTape.missing_rows).toEqual([
      { key: { slot: 452700000, tx_idx: 7, outer_ix: 0, inner_ix: 4 }, signature: encodeBase58(sig(7)), event: 'SetCreatorEvent', mint: MINT, block_time: BLOCK_TIME },
    ]);
    const other = check([[curveValues(7)], [richAmm(7)]], [rich(7, key(40))], universe, [extendRow(7), unknownRow(7)]);
    expect(other.missing_rows).toEqual([]);
    expect(other.explained_unrowed).toEqual({ non_universe: 1, outside_tape: 0, dropped_events: 1 });
  });

  it('compares the bytes of a name-only match: Unknown data_hex and the fields of a named event', () => {
    const s = check([[curveValues(7)], [richAmm(7)]], [rich(7)], universe, [extendRow(7, { new_size: '201' }), unknownRow(7, '0102030406'), setCreatorRow(7)]);
    expect(s.mismatches.map((m) => [m.field, m.row, m.decoded])).toEqual([
      ['fields.new_size', '201', '200'],
      ['data_hex', '0102030406', '0102030405'],
    ]);
  });

  it('treats a sampled-only event of a mint between two tape intervals as outside the tape', () => {
    const gapped: MintInfo[] = [{ ...universe[0]!, tapes: [[BLOCK_TIME - 100, BLOCK_TIME - 1], [BLOCK_TIME + 1, BLOCK_TIME + 100]] }, universe[1]!];
    const s = check([[], [richAmm(7)]], [rich(7)], gapped, [extendRow(7), unknownRow(7)]);
    expect(s.missing_rows).toEqual([]);
    expect(s.explained_unrowed).toEqual({ non_universe: 0, outside_tape: 2, dropped_events: 1 });
    expect(parseTapes('launch:1-5|pool:9-12')).toEqual([[1, 5], [9, 12]]);
    expect(parseTapes('')).toEqual([]);
  });

  it('fails an events row of a mint inside its tape without a raw record, and counts the others', () => {
    const s = check([[], []], [], universe, [extendRow(9), setCreatorRow(9), setCreatorRow(9, key(40))]);
    expect(s.mismatches.map((m) => [m.kind, m.field, m.row])).toEqual([['event', '(raw record)', `SetCreatorEvent ${MINT}`]]);
    expect(s.rows_without_raw).toBe(2);
  });

  it('matches failed rows to failed raw records, and fails one without its record or on a success', () => {
    const c = new ParityChecker(universe);
    c.addRow(failedRow(failedValues(7)));
    c.addRow(failedRow({ ...failedValues(8), error: '00' }));
    c.addRow(failedRow(failedValues(9)));
    c.addRow(failedRow(failedValues(10)));
    c.checkRaw(failedRaw(7));
    c.checkRaw(failedRaw(8));
    c.checkRaw(raw(10));
    c.endBatch();
    expect(c.s.mismatches.map((m) => [m.kind, m.key.tx_idx, m.field, m.row, m.decoded])).toEqual([
      ['failed', 8, 'error', '00', '08000000041900000072170000'],
      ['failed', 10, '(failed)', '08000000041900000072170000', 'transaction succeeded'],
      ['failed', 9, '(raw record)', `failed ${MINT}`, 'none'],
    ]);
    expect(c.s.rows_matched).toBe(1);
  });

  it('fails a successful record without inner instructions unless its full logs show no inner invocation', () => {
    const noInner = (logMessages: string[] | null) => raw(7, { meta: { ...raw(7).meta, innerInstructions: null, logMessages } });
    const top = [`Program ${PUMP_PROGRAM} invoke [1]`, 'Program log: Instruction: MigrateV2', `Program ${PUMP_PROGRAM} success`];
    const field = (r: RawLine) => check([[], []], [r]).mismatches.map((m) => [m.kind, m.field]);
    expect(field(noInner(null))).toEqual([['decode', 'innerInstructions']]);
    expect(field(noInner([...top.slice(0, 2), `Program ${PUMP_PROGRAM} invoke [2]`, `Program ${PUMP_PROGRAM} success`, top[2]!]))).toEqual([['decode', 'innerInstructions']]);
    expect(field(noInner([...top.slice(0, 2), 'Log truncated']))).toEqual([['decode', 'innerInstructions']]);
    expect(field(noInner(top))).toEqual([]);
  });

  it('keeps the dropped and sampled-only event lists equal to the scanner (sample.go)', () => {
    const go = readFileSync(join(REPO, 'research/historical/scanner/sample.go'), 'utf8');
    const goMap = (name: string) => new Set([...go.match(new RegExp(`var ${name} = map\\[string\\]bool\\{([^}]*)\\}`))![1]!.matchAll(/"(\w+)": true/g)].map((m) => m[1]!));
    expect(goMap('dropEvents')).toEqual(new Set(DROP_EVENTS));
    expect(goMap('sampledOnlyEvents')).toEqual(new Set(SAMPLED_ONLY_EVENTS));
  });
});

describe('parity over a dataset directory', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const csv = (rows: Record<string, string>[]) => {
    const cols = Object.keys(rows[0]!);
    return `${cols.join(',')}\n${rows.map((r) => cols.map((c) => r[c]).join(',')).join('\n')}\n`;
  };
  const dataset = (curve: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-'));
    dirs.push(dir);
    const day = join(dir, 'days', '2026-10-02');
    mkdirSync(day, { recursive: true });
    const z = (path: string, text: string) => writeFileSync(path, zstdCompressSync(Buffer.from(text)));
    const tapes = (m: MintInfo) => `launch:${m.tapeFrom}-${m.tapeTo}`;
    z(join(dir, 'mints-000.csv.zst'), csv(universe.map((m) => ({ mint: m.mint, pool: m.pool, tape_from: String(m.tapeFrom), tape_to: String(m.tapeTo), tapes: tapes(m) }))));
    z(join(day, 'curve_trades-000.csv.zst'), csv([curve]));
    z(join(day, 'amm_trades-000.csv.zst'), csv([ammValues(7)]));
    z(join(day, 'failed-000.csv.zst'), csv([failedValues(8)]));
    z(join(day, 'raw-000.jsonl.zst'), `${JSON.stringify(raw(7))}\n${JSON.stringify(failedRaw(8))}\n`);
    return dir;
  };

  it('reads the zstd files of every day, failed rows and tape intervals included', async () => {
    const s = await runParity(dataset(curveValues(7)));
    expect(s).toMatchObject({ raw_records: 2, raw_failed: 1, rows_checked: 3, rows_matched: 3, mismatch_count: 0, missing_row_count: 0 });
  });

  it('exits 1 on a mismatch and writes qa/parity.json', () => {
    const script = join(import.meta.dirname, '../../../research/historical/qa/parity.ts');
    const bad = dataset({ ...curveValues(7), fee: '1' });
    const run = spawnSync(process.execPath, ['--no-warnings', script, bad], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(existsSync(join(bad, 'qa', 'parity.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(bad, 'qa', 'parity.json'), 'utf8')).mismatches[0]).toMatchObject({ field: 'fee', row: '1', decoded: '43149' });
    expect(spawnSync(process.execPath, ['--no-warnings', script, dataset(curveValues(7))]).status).toBe(0);
  });
});

describe('decoder parity: raw records only for the hash sample', () => {
  it('requires a raw record only for rows of mints below the units\' sample rate', () => {
    const h = mintHash(MINT);
    const run = (rate: number) => {
      const c = new ParityChecker(universe, undefined, rate);
      c.addRow(curveRow(curveValues(9)));
      c.endBatch();
      return c.s;
    };
    const outside = run(h); // h(MINT) is not below its own value: outside the sample
    expect(outside.mismatches).toEqual([]);
    expect(outside.rows_without_raw).toBe(1);
    const inside = run(Math.min(1, h + 1e-9) === h ? 1 : h + 1e-9);
    expect(inside.mismatches.map((m) => m.field)).toEqual(['(raw record)']);
  });
});
