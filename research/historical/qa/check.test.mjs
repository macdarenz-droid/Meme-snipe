// node --test research/historical/qa/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const CHECK = path.join(import.meta.dirname, 'check.mjs');
const run = (...a) => spawnSync(process.execPath, [CHECK, ...a], { encoding: 'utf8' });

const CURVE = ['slot', 'block_time', 'tx_idx', 'ev_idx', 'signature', 'mint', 'is_buy', 'sol_amount', 'token_amount',
  'virtual_sol_reserves', 'virtual_token_reserves', 'real_sol_reserves', 'real_token_reserves', 'quote_mint', 'last_in_tx',
  'chain_curve_base', 'chain_curve_lamports', 'mayhem_mode', 'user', 'user_token_account', 'user_token_owner'];
const csv = (head, rows) => zlib.zstdCompressSync(Buffer.from([head, ...rows].map((r) => r.join(',')).join('\n') + '\n'));

const MOVE = ['slot', 'block_time', 'tx_idx', 'outer_ix', 'inner_ix', 'mint', 'kind', 'from_owner', 'to_owner', 'amount', 'from_account', 'to_account'];
const jsonl = (xs) => zlib.zstdCompressSync(Buffer.from(xs.map((x) => JSON.stringify(x) + '\n').join('')));

// A one-day dataset with two curve trades; `bad` breaks the second trade's reserves.
// opts: movements and coverage rows, events and raw lines, manifest additions.
function dataset(bad, { movements = [], coverage = null, events = [], raw = [], man: more = {}, attr = [['U', 'A', 'U'], ['U', 'A', 'U']] } = {}) {
  const ds = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
  const dir = path.join(ds, 'days', '2026-09-02');
  fs.mkdirSync(dir, { recursive: true });
  const t = (s, tx, sol, tok, vs, vt, rs, rt) => [s, 1788307300, tx, 0, 'sig', 'M', 1, sol, tok, vs, vt, rs, rt, '', 0, '', '', 0];
  const rows = [t(10, 0, 100, 1000, 30000000100, 1072999999000, 100, 792999999000), t(11, 0, 50, 400, 30000000150, 1072999998600, bad ? 151 : 150, 792999998600)]
    .map((r, i) => (attr[i] ? [...r, ...attr[i]] : r));
  const files = [];
  const put = (name, buf) => { fs.writeFileSync(path.join(dir, name), buf); files.push({ path: `days/2026-09-02/${name}` }); };
  put('curve_trades-000.csv.zst', csv(CURVE, rows));
  put('amm_trades-000.csv.zst', csv(['slot'], []));
  put('events-000.jsonl.zst', jsonl(events));
  put('raw-000.jsonl.zst', jsonl(raw));
  put('movements-000.csv.zst', csv(MOVE, movements));
  if (coverage) fs.writeFileSync(path.join(ds, 'movement_coverage-000.csv.zst'), csv(coverage[0]?.length === 8 ? ['mint', 'scope', 'slot', 'reason', 'count', 'tx_idx', 'from_slot', 'to_slot'] : ['mint', 'scope', 'from_slot', 'to_slot'], coverage));
  const man = {
    window: { from: '2026-09-02', to_exclusive: '2026-09-03', lead_in_days: 0 },
    coverage: { first_slot: 1, last_slot: 99, first_block_time: 1788220800, last_block_time: 1788393600 },
    days: [{ day: '2026-09-02', complete: true, warm_up: false, blocks_scanned: 5, rows: { curve_trades: 2, amm_trades: 0 }, files }],
    decode_failures: 0, chain_breaks: [], coverage_gaps: [], units: [], mints_files: [], ...more,
  };
  fs.writeFileSync(path.join(ds, 'manifest.json'), JSON.stringify(man));
  return ds;
}

test('--help prints usage and exits 0; a missing dataset exits 2', () => {
  const h = run('--help');
  assert.equal(h.status, 0);
  assert.match(h.stderr, /usage:/);
  assert.equal(run().status, 2);
  assert.equal(run('/nonexistent').status, 2);
  assert.equal(run(dataset(false), '--live', 'x').status, 2);
});

test('strict passes a consistent day and fails a broken reserve chain', () => {
  const ok = run(dataset(false), '--strict', '--lead-in-days', '0');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /PASS/);
  const bad = run(dataset(true), '--strict', '--lead-in-days', '0');
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /curve real reserves 0\/1/);
});

test('strict fails a window without its lead-in', () => {
  const r = run(dataset(false), '--strict');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /lead-in 0 days, 14 required/);
});

// ---- token movements ----
const PMINT = 'zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';
const mv = (o) => { const r = { slot: 10, block_time: 1788307300, tx_idx: 5, outer_ix: 0, inner_ix: '', mint: PMINT, kind: 'transfer', from_owner: 'A', to_owner: 'B', amount: 100, from_account: 'a', to_account: 'b', ...o }; return MOVE.map((c) => r[c]); };
const strict = (opts) => run(dataset(false, opts), '--strict', '--lead-in-days', '0');

test('strict passes well-formed movement rows, a zero amount included', () => {
  const r = strict({ movements: [mv({}), mv({ inner_ix: 0, kind: 'burn', to_owner: '', to_account: '' }), mv({ inner_ix: 1, kind: 'mint', from_owner: '', from_account: '', amount: 0 })] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /## Token movements/);
  assert.match(r.stdout, /1 with amount 0/);
});

test('strict fails malformed movement rows', () => {
  const r = strict({ movements: [mv({ amount: -1 }), mv({ amount: '18446744073709551616' }), mv({ kind: 'burn' }), mv({ to_account: '' }), mv({ kind: 'swap' }), mv({ kind: 'mint', from_owner: '' })] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /malformed movement rows 6/);
});

test('rows of mints not ending in "pump" need movement_coverage of their slot', () => {
  const rows = [mv({ mint: 'OTHER', slot: 10 })];
  assert.match(strict({ movements: rows }).stdout, /movement rows of non-pump mints outside movement_coverage 1/);
  assert.match(strict({ movements: rows, coverage: [['OTHER', 'pump_transactions', 11, 20]] }).stdout, /outside movement_coverage 1/);
  assert.equal(strict({ movements: rows, coverage: [['OTHER', 'pump_transactions', 1, 10]] }).status, 0);
  assert.match(strict({ movements: rows, coverage: [['OTHER', 'pump_transactions', 1, 10], ['X', 'all', 1, 2]] }).stdout, /movement coverage rows with an unknown scope 1/);
});

test('the supply of a "pump" mint with its create may not go below zero', () => {
  const ev = (event, fields) => ({ slot: 9, tx_idx: 0, ev_idx: 0, event, fields });
  const opts = (boost) => ({
    events: [ev('CreateEvent', { mint: PMINT, token_total_supply: '1000', real_token_reserves: '800', bonding_curve: 'C' }), ev('BoostBuyAndBurnEvent', { mint: PMINT, base_amount_burned: String(boost) })],
    movements: [mv({ kind: 'burn', to_owner: '', to_account: '', amount: 600 }), mv({ kind: 'mint', inner_ix: 0, from_owner: '', from_account: '', amount: 50 })],
  });
  assert.equal(strict(opts(450)).status, 0, strict(opts(450)).stdout);
  const r = strict(opts(451));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /token supply below zero for 1 mints/);
});

test('per-owner balance changes of a plain token transaction equal its movement rows', () => {
  const tb = (accountIndex, owner, amount) => ({ accountIndex, mint: PMINT, owner, uiTokenAmount: { amount: String(amount) } });
  const record = (extra = []) => ({
    slot: 10, txIndex: 5, signature: '1'.repeat(64), transaction: Buffer.from([1, ...new Array(64).fill(0), 7, ...extra]).toString('base64'), err: null,
    meta: { loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: [tb(1, 'A', 500), tb(2, 'B', 0)], postTokenBalances: [tb(1, 'A', 300), tb(2, 'B', 200)] },
  });
  const opts = (rows, rec = record()) => ({ raw: [rec], movements: rows, man: { schema: 2, sampling: { unit_sample_rate_min: 0 } } });
  const ok = strict(opts([mv({ amount: 150 }), mv({ inner_ix: 0, amount: 50 })]));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Balances: 1 of 1/);
  const bad = strict(opts([mv({ amount: 150 })]));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /token balance changes unexplained by movement rows 1/);
  // A transaction that references pump is outside this check.
  const pump = [...Buffer.from('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'.split('').reduce((n, ch) => n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(ch)), 0n).toString(16).padStart(64, '0'), 'hex')];
  const skipped = strict(opts([mv({ amount: 150 })], record(pump)));
  assert.equal(skipped.status, 0, skipped.stdout);
  assert.match(skipped.stdout, /Balances: 0 of 0 .* 1 raw records that touch pump/s);
});

test('an unresolved mark skips only its own transaction; later transactions stay checked', () => {
  const tb = (accountIndex, owner, amount) => ({ accountIndex, mint: PMINT, owner, uiTokenAmount: { amount: String(amount) } });
  const rec = { slot: 10, txIndex: 5, signature: '1'.repeat(64), transaction: Buffer.from([1, ...new Array(64).fill(0), 7]).toString('base64'), err: null,
    meta: { loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: [tb(1, 'A', 500), tb(2, 'B', 0)], postTokenBalances: [tb(1, 'A', 300), tb(2, 'B', 200)] } };
  const opts = (coverage) => ({ raw: [rec], movements: [mv({ amount: 150 })], coverage, man: { schema: 2, sampling: { unit_sample_rate_min: 0 } } });
  // marked on this transaction: skipped
  assert.equal(strict(opts([[PMINT, 'unresolved', 10, 'owner_change', 1, 5, 1, 20]])).status, 0);
  // marked on an earlier transaction only: this one is still checked and fails
  const later = strict(opts([[PMINT, 'unresolved', 9, 'owner_change', 1, 1, 1, 20]]));
  assert.equal(later.status, 1, later.stdout);
  assert.match(later.stdout, /token balance changes unexplained by movement rows 1/);
});

test('swap attribution: owner differing from user is counted; an empty owner needs its mark', () => {
  const cov = (tx) => [['M', 'unresolved', 11, 'swap_owner_unknown', 1, tx, '', '']];
  const other = strict({ attr: [['U', 'A', 'U'], ['U', 'B', 'O']] });
  assert.equal(other.status, 0, other.stdout);
  assert.match(other.stdout, /1 with user_token_owner different from user/);
  const unmarked = strict({ attr: [['U', 'A', 'U'], ['U', 'B', '']] });
  assert.equal(unmarked.status, 1);
  assert.match(unmarked.stdout, /trade rows with an empty user_token_owner and no swap_owner_unknown mark 1/);
  // the mark must name this transaction
  assert.match(strict({ attr: [['U', 'A', 'U'], ['U', 'B', '']], coverage: cov(1) }).stdout, /no swap_owner_unknown mark 1/);
  const marked = strict({ attr: [['U', 'A', 'U'], ['U', 'B', '']], coverage: cov(0) });
  assert.equal(marked.status, 0, marked.stdout);
  assert.match(marked.stdout, /1 with an empty owner, 1 of them marked swap_owner_unknown/);
  // no user account (boost buy-and-burn): credits nobody, needs no mark
  assert.equal(strict({ attr: [['U', 'A', 'U'], ['U', '', '']] }).status, 0);
  const old = strict({ attr: [] });
  assert.equal(old.status, 1);
  assert.match(old.stdout, /trade rows without user_token_account \/ user_token_owner 2/);
});
