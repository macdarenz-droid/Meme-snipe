// Writes rows in DATA-1's on-disk layout (schema 3, with raw records when given): manifest.json and
// days/<day>/<table>-000.<csv|jsonl>.zst. The manifest always says `synthetic: true` (no opt-out, not even through
// `manifest`): a window written here is never gate evidence (BT-WALL W1).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import type { CoverageRow, DatasetRow, MovementRow } from './rows.ts';

// DATA-1's column lists (research/historical/scanner/scan.go, schema 3).
export const AMM_COLS = ['slot', 'block_time', 'tx_idx', 'ev_idx', 'signature', 'signer', 'tx_fee', 'cu', 'pool', 'base_mint', 'quote_mint', 'side', 'base_amount',
  'quote_amount', 'limit_quote', 'user', 'timestamp', 'pool_base_token_reserves', 'pool_quote_token_reserves', 'lp_fee_basis_points', 'lp_fee',
  'protocol_fee_basis_points', 'protocol_fee', 'quote_amount_lp_adjusted', 'user_quote_amount', 'protocol_fee_recipient', 'coin_creator',
  'coin_creator_fee_basis_points', 'coin_creator_fee', 'track_volume', 'min_base_amount_out', 'ix_name', 'cashback_fee_basis_points', 'cashback',
  'buyback_fee_basis_points', 'buyback_fee', 'virtual_quote_reserves', 'can_boost', 'base_supply', 'holder_rewards_bps', 'holder_rewards', 'extra_hex',
  'layout_fields', 'last_in_tx', 'chain_pool_base', 'chain_pool_quote', 'user_token_account', 'user_token_owner'];
export const CURVE_COLS = ['slot', 'block_time', 'tx_idx', 'ev_idx', 'signature', 'mint', 'is_buy', 'sol_amount', 'token_amount', 'virtual_sol_reserves',
  'virtual_token_reserves', 'real_sol_reserves', 'real_token_reserves', 'mayhem_mode', 'quote_mint', 'user', 'extra_hex', 'user_token_account', 'user_token_owner'];
export const MOVEMENT_COLS = ['slot', 'block_time', 'tx_idx', 'outer_ix', 'inner_ix', 'mint', 'kind', 'from_owner', 'to_owner', 'amount', 'from_account', 'to_account'];
export const COVERAGE_COLS = ['mint', 'scope', 'slot', 'reason', 'count', 'tx_idx', 'from_slot', 'to_slot'];
export const BLOCK_COLS = ['slot', 'block_time', 'parent_slot', 'n_tx', 'n_vote', 'n_pump_tx', 'n_pump_ok', 'n_pump_failed', 'n_events'];

const csv = (cols: readonly string[], rows: Record<string, string>[]): string =>
  [cols.join(','), ...rows.map((r) => cols.map((c) => {
    const v = r[c] ?? '';
    return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
  }).join(','))].join('\n') + '\n';

const day = (blockTime: number): string => new Date(blockTime * 1000).toISOString().slice(0, 10);

export interface WriteOptions {
  readonly movements?: readonly MovementRow[];
  readonly coverage?: readonly CoverageRow[];
  /** Raw record lines, each placed in the day of its blockTime. */
  readonly raw?: readonly string[];
  /** Extra manifest fields (rules, upgrade marks, window lead-in). */
  readonly manifest?: Readonly<Record<string, unknown>>;
  /** DATA-1c volume-hours CSV text by day (`days/DAY/volume_hours-000.csv.zst`). */
  readonly volumeHours?: Readonly<Record<string, string>>;
  /** The manifest's schema (default 3, the only one the reader accepts; another value tests the refusal). */
  readonly schema?: number;
  /** Recorded as manifest window.lead_in_days. */
  readonly leadInDays?: number;
  /** Write SHA256SUMS over every file, the manifest included (as a release does). */
  readonly sums?: boolean;
}

export const writeDataset = (dir: string, rows: readonly DatasetRow[], extra: WriteOptions = {}): void => {
  const rawByDay = new Map<string, string[]>();
  for (const l of extra.raw ?? []) {
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
      ix_name: r.ixName, user: r.user, user_token_account: r.userTokenAccount, user_token_owner: r.userTokenOwner, extra_hex: r.extraHex,
      lp_fee: String(r.lpFee), quote_amount_lp_adjusted: String(r.quoteLpAdjusted),
    }]);
    const curve = list.flatMap((r) => r.kind !== 'curve' ? [] : [{
      slot: String(r.slot), block_time: String(r.blockTime), tx_idx: String(r.txIdx), ev_idx: String(r.evIdx), signature: r.signature, mint: r.mint,
      is_buy: String(r.isBuy), sol_amount: String(r.solAmount), token_amount: String(r.tokenAmount), virtual_sol_reserves: String(r.virtualSolReserves),
      virtual_token_reserves: String(r.virtualTokenReserves), real_sol_reserves: String(r.realSolReserves), real_token_reserves: String(r.realTokenReserves),
      mayhem_mode: String(r.mayhem), quote_mint: r.quoteMint, user: r.user, extra_hex: r.extraHex, user_token_account: r.userTokenAccount, user_token_owner: r.userTokenOwner,
    }]);
    const blocks = list.flatMap((r) => r.kind !== 'block' ? [] : [{ slot: String(r.slot), block_time: String(r.blockTime), parent_slot: String(r.parentSlot) }]);
    const events = list.flatMap((r) => r.kind !== 'event' ? [] : [JSON.stringify({ slot: Number(r.slot), block_time: r.blockTime, tx_idx: r.txIdx, ev_idx: r.evIdx, signature: r.signature, signer: '', program: r.program, event: r.event, layout_fields: 1, fields: r.fields })]);
    put('amm_trades-000.csv.zst', csv(AMM_COLS, amm), amm.length);
    if (curve.length > 0) put('curve_trades-000.csv.zst', csv(CURVE_COLS, curve), curve.length);
    put('blocks-000.csv.zst', csv(BLOCK_COLS, blocks), blocks.length);
    const vh = extra.volumeHours?.[d];
    if (vh !== undefined) put('volume_hours-000.csv.zst', vh, 24);
    const rawLines = rawByDay.get(d) ?? [];
    if (rawLines.length > 0) put('raw-000.jsonl.zst', rawLines.join('\n') + '\n', rawLines.length);
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
    // Everything this writer makes is synthetic, always marked so (BT-WALL W1): never gate evidence. It goes after the
    // extra manifest fields, so they cannot unset it.
    schema: extra.schema ?? 3, ...(extra.manifest ?? {}), synthetic: true,
    window: {
      from: days[0]!.day, to_exclusive: new Date(Date.parse(`${days[days.length - 1]!.day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
      ...(extra.leadInDays === undefined ? {} : { lead_in_days: extra.leadInDays }), ...((extra.manifest?.['window'] as object | undefined) ?? {}),
    },
    coverage: { first_slot: Number(first.slot), last_slot: Number(last.slot), first_block_time: first.blockTime, last_block_time: last.blockTime },
    days,
    mints_files: mintsFiles,
  }, null, 1));
  if (extra.sums === true) {
    const all = [{ path: 'manifest.json' }, ...days.flatMap((d) => d.files), ...mintsFiles];
    writeFileSync(join(dir, 'SHA256SUMS'), all.map((f) => `${createHash('sha256').update(readFileSync(join(dir, f.path))).digest('hex')}  ${f.path}`).join('\n') + '\n');
  }
};
