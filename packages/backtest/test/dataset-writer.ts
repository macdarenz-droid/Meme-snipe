// Writes rows in DATA-1's on-disk layout (schema 1, or 2 with raw records): manifest.json and
// days/<day>/<table>-000.<csv|jsonl>.zst.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import type { DatasetRow } from '../src/dataset/rows.ts';

// DATA-1's column lists (research/historical/scanner/scan.go, schema 1).
export const AMM_COLS = ['slot', 'block_time', 'tx_idx', 'ev_idx', 'signature', 'signer', 'tx_fee', 'cu', 'pool', 'base_mint', 'quote_mint', 'side', 'base_amount',
  'quote_amount', 'limit_quote', 'user', 'timestamp', 'pool_base_token_reserves', 'pool_quote_token_reserves', 'lp_fee_basis_points', 'lp_fee',
  'protocol_fee_basis_points', 'protocol_fee', 'quote_amount_lp_adjusted', 'user_quote_amount', 'protocol_fee_recipient', 'coin_creator',
  'coin_creator_fee_basis_points', 'coin_creator_fee', 'track_volume', 'min_base_amount_out', 'ix_name', 'cashback_fee_basis_points', 'cashback',
  'buyback_fee_basis_points', 'buyback_fee', 'virtual_quote_reserves', 'can_boost', 'base_supply', 'holder_rewards_bps', 'holder_rewards', 'extra_hex',
  'layout_fields', 'last_in_tx', 'chain_pool_base', 'chain_pool_quote'];
export const CURVE_COLS = ['slot', 'block_time', 'tx_idx', 'ev_idx', 'signature', 'mint', 'is_buy', 'sol_amount', 'token_amount', 'virtual_sol_reserves',
  'virtual_token_reserves', 'real_sol_reserves', 'real_token_reserves', 'mayhem_mode', 'quote_mint', 'user'];
export const BLOCK_COLS = ['slot', 'block_time', 'parent_slot', 'n_tx', 'n_vote', 'n_pump_tx', 'n_pump_ok', 'n_pump_failed', 'n_events'];

const csv = (cols: readonly string[], rows: Record<string, string>[]): string =>
  [cols.join(','), ...rows.map((r) => cols.map((c) => {
    const v = r[c] ?? '';
    return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
  }).join(','))].join('\n') + '\n';

const day = (blockTime: number): string => new Date(blockTime * 1000).toISOString().slice(0, 10);

export interface WriteOptions {
  readonly schema?: 1 | 2;
  /** Raw record lines (schema 2), each placed in the day of its blockTime. */
  readonly raw?: readonly string[];
  /** Extra manifest fields (rules, upgrade marks). */
  readonly manifest?: Readonly<Record<string, unknown>>;
}

export const writeDataset = (dir: string, rows: readonly DatasetRow[], opts: WriteOptions = {}): void => {
  const rawByDay = new Map<string, string[]>();
  for (const l of opts.raw ?? []) {
    const d = day((JSON.parse(l) as { blockTime: number }).blockTime);
    rawByDay.set(d, [...(rawByDay.get(d) ?? []), l]);
  }
  const byDay = new Map<string, DatasetRow[]>();
  for (const r of rows) byDay.set(day(r.blockTime), [...(byDay.get(day(r.blockTime)) ?? []), r]);
  const days = [];
  for (const [d, list] of [...byDay].sort()) {
    const files: { path: string; bytes: number; sha256: string; rows: number }[] = [];
    const put = (name: string, text: string, n: number) => {
      const raw = zstdCompressSync(Buffer.from(text));
      mkdirSync(join(dir, 'days', d), { recursive: true });
      writeFileSync(join(dir, 'days', d, name), raw);
      files.push({ path: `days/${d}/${name}`, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'), rows: n });
    };
    const amm = list.flatMap((r) => r.kind !== 'amm' ? [] : [{
      slot: String(r.slot), block_time: String(r.blockTime), tx_idx: String(r.txIdx), ev_idx: String(r.evIdx), signature: r.signature, pool: r.pool,
      base_mint: r.baseMint, quote_mint: r.quoteMint, side: r.side,
      base_amount: String(r.mode === 'exact-quote-in' ? r.baseAmount : r.amount), quote_amount: String(r.mode === 'exact-quote-in' ? r.amount : r.quoteAmount),
      user_quote_amount: String(r.userQuote), pool_base_token_reserves: String(r.pre.baseReserve), pool_quote_token_reserves: String(r.pre.quoteVault),
      virtual_quote_reserves: String(r.pre.virtualQuoteReserves), lp_fee_basis_points: String(r.fees.split.lp), protocol_fee_basis_points: String(r.fees.split.protocol),
      coin_creator_fee_basis_points: String(r.fees.split.creator), buyback_fee_basis_points: String(r.fees.buybackFeeBps), base_supply: String(r.baseSupply),
      ix_name: r.ixName, user: r.user,
    }]);
    const curve = list.flatMap((r) => r.kind !== 'curve' ? [] : [{
      slot: String(r.slot), block_time: String(r.blockTime), tx_idx: String(r.txIdx), ev_idx: String(r.evIdx), signature: r.signature, mint: r.mint,
      is_buy: String(r.isBuy), sol_amount: String(r.solAmount), token_amount: String(r.tokenAmount), virtual_sol_reserves: String(r.virtualSolReserves),
      virtual_token_reserves: String(r.virtualTokenReserves), real_sol_reserves: String(r.realSolReserves), real_token_reserves: String(r.realTokenReserves),
      mayhem_mode: String(r.mayhem), quote_mint: r.quoteMint, user: r.user,
    }]);
    const blocks = list.flatMap((r) => r.kind !== 'block' ? [] : [{ slot: String(r.slot), block_time: String(r.blockTime), parent_slot: String(r.parentSlot) }]);
    const events = list.flatMap((r) => r.kind !== 'event' ? [] : [JSON.stringify({ slot: Number(r.slot), block_time: r.blockTime, tx_idx: r.txIdx, ev_idx: r.evIdx, signature: r.signature, signer: '', program: r.program, event: r.event, layout_fields: 1, fields: r.fields })]);
    put('amm_trades-000.csv.zst', csv(AMM_COLS, amm), amm.length);
    if (curve.length > 0) put('curve_trades-000.csv.zst', csv(CURVE_COLS, curve), curve.length);
    put('blocks-000.csv.zst', csv(BLOCK_COLS, blocks), blocks.length);
    const raw = rawByDay.get(d) ?? [];
    if (raw.length > 0) put('raw-000.jsonl.zst', raw.join('\n') + '\n', raw.length);
    put('events-000.jsonl.zst', events.join('\n') + (events.length ? '\n' : ''), events.length);
    days.push({ day: d, blocks_expected: blocks.length, blocks_scanned: blocks.length, complete: true, warm_up: false, rows: { amm_trades: amm.length }, files });
  }
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    schema: opts.schema ?? 1, ...(opts.manifest ?? {}), window: { from: days[0]!.day, to_exclusive: days[days.length - 1]!.day },
    coverage: { first_slot: Number(first.slot), last_slot: Number(last.slot), first_block_time: first.blockTime, last_block_time: last.blockTime },
    days,
  }, null, 1));
};
