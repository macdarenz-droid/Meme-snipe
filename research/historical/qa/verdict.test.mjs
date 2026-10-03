// node --test research/historical/qa/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { strictMisses, windowDays } from './verdict.mjs';

const okDay = (day) => ({ day, complete: true, warm_up: false });
const base = () => ({
  window: { from: '2026-09-02', to_exclusive: '2026-09-04', lead_in_days: 14 },
  days: [okDay('2026-09-02'), okDay('2026-09-03')],
  decode_failures: 0, chain_breaks: [], coverage_gaps: [],
  units: [{ unknown_events: { 'pump:742b4dbd117a482b': 3 }, extra_bytes: { 'pump:TradeEvent:8': 5, 'pump:CreateEvent:0': 1 }, newer_layouts: { 'amm:BuyEvent': 2 }, older_layouts: {} }],
});
const report = { curve: { real_ok: 1, real_pairs: 1, virtual_ok: 1, virtual_pairs: 1, token_exact: 0, token_checks: 0, quote_balance_ge: 0, quote_balance_checks: 0 }, amm: { chain_ok: 0, chain_pairs: 0, chain_exact: 0, chain_checks: 0 }, live: [] };

test('windowDays lists [from, to)', () => {
  assert.deepEqual(windowDays('2026-09-30', '2026-10-02'), ['2026-09-30', '2026-10-01']);
});

test('a clean window passes', () => {
  assert.deepEqual(strictMisses(base(), report), []);
});

test('an absent, incomplete or lead-in-less day is a miss', () => {
  const m = base();
  m.days = [{ ...okDay('2026-09-02'), complete: false }];
  assert.deepEqual(strictMisses(m, report), ['day 2026-09-02 incomplete', 'day 2026-09-03 absent']);
  m.days = [okDay('2026-09-02'), { ...okDay('2026-09-03'), warm_up: true }];
  assert.deepEqual(strictMisses(m, report), ['day 2026-09-03 lacks its lead-in']);
});

test('the configured lead-in is enforced', () => {
  const m = base();
  m.window.lead_in_days = 0;
  assert.deepEqual(strictMisses(m, report), ['lead-in 0 days, 14 required']);
  assert.deepEqual(strictMisses(m, report, { leadInDays: 0 }), []);
});

test('only the documented upgrade may differ from the IDL', () => {
  const m = base();
  m.units.push({ unknown_events: { 'amm:0102030405060708': 1 }, extra_bytes: { 'pump:TradeEvent:4': 1, 'amm:CreatePoolEvent:8': 2 }, newer_layouts: { 'pump:CreateEvent': 1 }, older_layouts: { 'pump:TradeEvent:4': 7 } });
  assert.deepEqual(strictMisses(m, report), [
    'unknown event amm:0102030405060708 x1',
    'extra bytes pump:TradeEvent:4 x1',
    'extra bytes amm:CreatePoolEvent:8 x2',
    'newer layout pump:CreateEvent x1',
    'older layout pump:TradeEvent:4 x7',
  ]);
});

test('reserve, raw and live misses are counted', () => {
  const r = structuredClone(report);
  r.curve.real_ok = 0;
  r.raw = { signature_mismatch: 1, trade_txs: 2, trade_txs_with_raw: 1 };
  r.live = [{ pass: false }];
  assert.deepEqual(strictMisses(base(), r), ['curve real reserves 0/1', 'raw signature mismatches 1', 'trade transactions without raw record 1', 'live on-chain mismatches 1']);
});

test('an assembled window may not reach the 2026-10-02 regime boundary', () => {
  const m = base();
  m.window = { from: '2026-10-01', to_exclusive: '2026-10-03', lead_in_days: 14 };
  m.days = [okDay('2026-10-01'), okDay('2026-10-02')];
  assert.deepEqual(strictMisses(m, report), ['window reaches 2026-10-02, the program-upgrade regime boundary']);
  m.window.lead_in_days = 0;
  assert.deepEqual(strictMisses(m, report, { leadInDays: 0 }), []);
});

test('every create transaction must have its raw record', () => {
  const r = structuredClone(report);
  r.raw = { signature_mismatch: 0, trade_txs: 0, trade_txs_with_raw: 0, create_rows: 3, create_rows_with_raw: 2 };
  assert.deepEqual(strictMisses(base(), r), ['create transactions without raw record 1']);
});
