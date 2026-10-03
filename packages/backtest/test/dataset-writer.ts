// Writes rows in DATA-1's on-disk layout (schema 3): manifest.json and days/<day>/<table>-000.<csv|jsonl>.zst.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import type { CoverageRow, DatasetRow, MovementRow } from '../src/dataset/rows.ts';

// DATA-1's column lists (research/historical/scanner/scan.go, schema 3).
export const AMM_COLS = ['slot', 'block_time', 'tx_idx', 'ev_idx', 'signature', 'signer', 'tx_fee', 'cu', 'pool', 'base_mint', 'quote_mint', 'side', 'base_amount',
  'quote_amount', 'limit_quote', 'user', 'timestamp', 'pool_base_token_reserves', 'pool_quote_token_reserves', 'lp_fee_basis_points', 'lp_fee',
  'protocol_fee_basis_points', 'protocol_fee', 'quote_amount_lp_adjusted', 'user_quote_amount', 'protocol_fee_recipient', 'coin_creator',
  'coin_creator_fee_basis_points', 'coin_creator_fee', 'track_volume', 'min_base_amount_out', 'ix_name', 'cashback_fee_basis_points', 'cashback',
  'buyback_fee_basis_points', 'buyback_fee', 'virtual_quote_reserves', 'can_boost', 'base_supply', 'holder_rewards_bps', 'holder_rewards', 'extra_hex',
  'layout_fields', 'last_in_tx', 'chain_pool_base', 'chain_pool_quote', 'user_token_account', 'user_token_owner'];
export const MOVEMENT_COLS = ['slot', 'block_time', 'tx_idx', 'outer_ix', 'inner_ix', 'mint', 'kind', 'from_owner', 'to_owner', 'amount', 'from_account', 'to_account'];
export const COVERAGE_COLS = ['mint', 'scope', 'slot', 'reason', 'count', 'tx_idx', 'from_slot', 'to_slot'];
export const BLOCK_COLS = ['slot', 'block_time', 'parent_slot', 'n_tx', 'n_vote', 'n_pump_tx', 'n_pump_ok', 'n_pump_failed', 'n_events'];

const csv = (cols: readonly string[], rows: Record<string, string>[]): string =>
  [cols.join(','), ...rows.map((r) => cols.map((c) => {
    const v = r[c] ?? '';
    return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
  }).join(','))].join('\n') + '\n';

const day = (blockTime: number): string => new Date(blockTime * 1000).toISOString().slice(0, 10);

export const writeDataset = (dir: string, rows: readonly DatasetRow[], extra: {
  readonly movements?: readonly MovementRow[]; readonly coverage?: readonly CoverageRow[];
  /** Recorded as manifest window.lead_in_days. */
  readonly leadInDays?: number;
  /** Write SHA256SUMS over every file, the manifest included (as a release does). */
  readonly sums?: boolean;
} = {}): void => {
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
      ix_name: r.ixName, user: r.user, user_token_account: r.userTokenAccount, user_token_owner: r.userTokenOwner,
    }]);
    const blocks = list.flatMap((r) => r.kind !== 'block' ? [] : [{ slot: String(r.slot), block_time: String(r.blockTime), parent_slot: String(r.parentSlot) }]);
    const events = list.flatMap((r) => r.kind !== 'event' ? [] : [JSON.stringify({ slot: Number(r.slot), block_time: r.blockTime, tx_idx: r.txIdx, ev_idx: r.evIdx, signature: r.signature, signer: '', program: r.program, event: r.event, layout_fields: 1, fields: r.fields })]);
    put('amm_trades-000.csv.zst', csv(AMM_COLS, amm), amm.length);
    put('blocks-000.csv.zst', csv(BLOCK_COLS, blocks), blocks.length);
    put('events-000.jsonl.zst', events.join('\n') + (events.length ? '\n' : ''), events.length);
    const moves = (extra.movements ?? []).filter((m) => day(m.blockTime) === d).map((m) => ({
      slot: String(m.slot), block_time: String(m.blockTime), tx_idx: String(m.txIdx), outer_ix: String(m.outerIx), inner_ix: m.innerIx === null ? '' : String(m.innerIx),
      mint: m.mint, kind: m.kind, from_owner: m.fromOwner, to_owner: m.toOwner, amount: String(m.amount), from_account: m.fromAccount, to_account: m.toAccount,
    }));
    if (extra.movements !== undefined) put('movements-000.csv.zst', csv(MOVEMENT_COLS, moves), moves.length);
    days.push({ day: d, blocks_expected: blocks.length, blocks_scanned: blocks.length, complete: true, warm_up: false, rows: { amm_trades: amm.length }, files });
  }
  const mintsFiles: { path: string; bytes: number; sha256: string; rows: number }[] = [];
  if (extra.coverage !== undefined) {
    const raw = zstdCompressSync(Buffer.from(csv(COVERAGE_COLS, extra.coverage.map((c) => ({
      mint: c.mint, scope: c.scope, slot: c.slot === null ? '' : String(c.slot), reason: c.reason, count: c.count === null ? '' : String(c.count),
      tx_idx: c.txIdx === null ? '' : String(c.txIdx), from_slot: String(c.fromSlot), to_slot: String(c.toSlot),
    })))));
    writeFileSync(join(dir, 'movement_coverage-000.csv.zst'), raw);
    mintsFiles.push({ path: 'movement_coverage-000.csv.zst', bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'), rows: extra.coverage.length });
  }
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    schema: 3, window: { from: days[0]!.day, to_exclusive: days[days.length - 1]!.day, ...(extra.leadInDays === undefined ? {} : { lead_in_days: extra.leadInDays }) },
    coverage: { first_slot: Number(first.slot), last_slot: Number(last.slot), first_block_time: first.blockTime, last_block_time: last.blockTime },
    days,
    mints_files: mintsFiles,
  }, null, 1));
  if (extra.sums === true) {
    const all = [{ path: 'manifest.json' }, ...days.flatMap((d) => d.files), ...mintsFiles];
    writeFileSync(join(dir, 'SHA256SUMS'), all.map((f) => `${createHash('sha256').update(readFileSync(join(dir, f.path))).digest('hex')}  ${f.path}`).join('\n') + '\n');
  }
};
