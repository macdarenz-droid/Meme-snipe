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
  'chain_curve_base', 'chain_curve_lamports', 'mayhem_mode'];
const csv = (head, rows) => zlib.zstdCompressSync(Buffer.from([head, ...rows].map((r) => r.join(',')).join('\n') + '\n'));

// A one-day dataset with two curve trades; `bad` breaks the second trade's reserves.
function dataset(bad) {
  const ds = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
  const dir = path.join(ds, 'days', '2026-09-02');
  fs.mkdirSync(dir, { recursive: true });
  const t = (s, tx, sol, tok, vs, vt, rs, rt) => [s, 1788307300, tx, 0, 'sig', 'M', 1, sol, tok, vs, vt, rs, rt, '', 0, '', '', 0];
  const rows = [t(10, 0, 100, 1000, 30000000100, 1072999999000, 100, 792999999000), t(11, 0, 50, 400, 30000000150, 1072999998600, bad ? 151 : 150, 792999998600)];
  const files = [];
  const put = (name, buf) => { fs.writeFileSync(path.join(dir, name), buf); files.push({ path: `days/2026-09-02/${name}` }); };
  put('curve_trades-000.csv.zst', csv(CURVE, rows));
  put('amm_trades-000.csv.zst', csv(['slot'], []));
  put('events-000.jsonl.zst', zlib.zstdCompressSync(Buffer.from('')));
  put('raw-000.jsonl.zst', zlib.zstdCompressSync(Buffer.from('')));
  const man = {
    window: { from: '2026-09-02', to_exclusive: '2026-09-03', lead_in_days: 0 },
    coverage: { first_slot: 1, last_slot: 99, first_block_time: 1788220800, last_block_time: 1788393600 },
    days: [{ day: '2026-09-02', complete: true, warm_up: false, blocks_scanned: 5, rows: { curve_trades: 2, amm_trades: 0 }, files }],
    decode_failures: 0, chain_breaks: [], coverage_gaps: [], units: [], mints_files: [],
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
