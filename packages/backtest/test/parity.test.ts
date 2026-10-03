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
  ParityChecker,
  ammRow,
  csvObjects,
  curveRow,
  failed,
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

const raw = (n: number, over: Partial<RawLine> = {}): RawLine => ({
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
      { index: 0, instructions: [eventIx(1, TradeEventLayout.discriminator, encode(tradeFields, trade))] },
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

const check = (rows: Record<string, string>[][], raws: RawLine[], mints = universe) => {
  const c = new ParityChecker(mints);
  const [curve = [], amm = []] = rows;
  for (const v of curve) c.addRow(curveRow(v));
  for (const v of amm) c.addRow(ammRow(v));
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
    expect(s.explained_unrowed).toEqual({ non_universe: 1, outside_tape: 1, other_events: 0 });
  });

  it('fails a row whose transaction failed, and a raw record the decoder refuses', () => {
    const s = check([[curveValues(7)], []], [raw(7, { err: { hex: '08000000041900000072170000' } }), raw(8, { transaction: toBase64(Uint8Array.of(1, 2, 3)) })]);
    expect(s.mismatches.map((m) => [m.kind, m.field, m.decoded?.slice(0, 18)])).toEqual([
      ['curve', '(event)', 'transaction failed'],
      ['decode', 'transaction', expect.any(String)],
    ]);
    expect(s.raw_failed).toBe(1);
  });

  it('counts rows without a raw record instead of matching them', () => {
    const s = check([[curveValues(9)], []], [raw(7)]);
    expect(s.rows_without_raw).toBe(1);
  });

  it('reads CSV rows as objects keyed by the header, quoted fields included', () => {
    expect(csvObjects('a,b\n"x,""y""",\n"multi\nline",z\n')).toEqual([{ a: 'x,"y"', b: '' }, { a: 'multi\nline', b: 'z' }]);
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
    z(join(dir, 'mints-000.csv.zst'), csv(universe.map((m) => ({ mint: m.mint, pool: m.pool, tape_from: String(m.tapeFrom), tape_to: String(m.tapeTo) }))));
    z(join(day, 'curve_trades-000.csv.zst'), csv([curve]));
    z(join(day, 'amm_trades-000.csv.zst'), csv([ammValues(7)]));
    z(join(day, 'raw-000.jsonl.zst'), `${JSON.stringify(raw(7))}\n`);
    return dir;
  };

  it('reads the zstd files of every day', async () => {
    const s = await runParity(dataset(curveValues(7)));
    expect(s).toMatchObject({ raw_records: 1, rows_checked: 2, rows_matched: 2, mismatch_count: 0, missing_row_count: 0 });
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
