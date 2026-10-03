// Data quality report for the historical dataset (docs/research/historical-data.md).
//
//   node research/historical/qa/check.mjs <dataset-dir> [--live 60] [--gecko 10]
//
// Offline checks (every row):
//   1. coverage: blocks expected vs scanned per day (from the manifest)
//   2. decoding: decode failures, unknown events, newer layouts (from the manifest)
//   3. reserve chain: each trade's reserves follow from the previous trade of the same
//      curve or pool plus the trade amounts; PumpSwap liquidity events and boosts are
//      applied in between
//   4. chain state: for the last trade of a curve or pool in a transaction, rebuilt
//      reserves vs the account balances the validator recorded after that transaction
//   5. token movements (movements-NNN.csv.zst, movement_coverage-NNN.csv.zst): row
//      sanity, coverage of mints not ending in "pump", supply conservation of fully
//      covered mints, and per-owner balance deltas of plain token transactions with a
//      raw record against their movement rows (see the "Token movements" section)
// Live checks (--live N): curves and pools with no transaction since the end of the
//   scanned coverage are read from mainnet now; their on-chain reserves must equal
//   the reserves rebuilt from our last event (1 raw unit tolerance).
// GeckoTerminal (--gecko N): our per-minute last price vs GeckoTerminal 1-minute close
//   for N graduated pools. Only summary statistics are kept (GeckoTerminal's terms do
//   not allow storing their data).
//
// Writes <dataset-dir>/qa/report.json and report.md.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { REGIME_BOUNDARIES, strictMisses } from './verdict.mjs';

const USAGE = 'usage: node research/historical/qa/check.mjs <dataset-dir> [--live N] [--gecko N] [--strict] [--lead-in-days N]';
const args = process.argv.slice(2);
const ds = args[0];
if (!ds || ds.startsWith('-') || !fs.existsSync(path.join(ds, 'manifest.json'))) {
  console.error(ds && !ds.startsWith('-') ? `no manifest.json in ${ds}\n${USAGE}` : USAGE);
  process.exit(args.includes('--help') ? 0 : 2);
}
const opt = (k, d) => {
  const i = args.indexOf(k);
  if (i < 0) return d;
  const v = Number(args[i + 1]);
  if (!Number.isInteger(v) || v < 0) { console.error(`${k} needs a whole number\n${USAGE}`); process.exit(2); }
  return v;
};
const LIVE = opt('--live', 0), GECKO = opt('--gecko', 0);
const LEAD_IN = opt('--lead-in-days', 14); // strict: the lead-in the window must carry
const STRICT = args.includes('--strict'); // exit 1 on any miss (CI)
const RPC = 'https://api.mainnet-beta.solana.com';
const man = JSON.parse(fs.readFileSync(path.join(ds, 'manifest.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CSV helpers (RFC 4180, zstd) ----
function parseCSV(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function readTable(rel) {
  const rows = parseCSV(zlib.zstdDecompressSync(fs.readFileSync(path.join(ds, rel))).toString());
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
function dayFiles(base) {
  return man.days.flatMap((d) => d.files.filter((f) => path.basename(f.path).startsWith(base + '-')).map((f) => f.path));
}
const B = (s) => (s === '' || s === undefined ? null : BigInt(s));

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const U64_MAX = (1n << 64n) - 1n;
const isQuoted = (r) => r.quote_mint !== '' && r.quote_mint !== '11111111111111111111111111111111' && r.quote_mint !== 'So11111111111111111111111111111111111111112';

// ---- base58 ----
function b58decode(str) {
  let n = 0n;
  for (const ch of str) n = n * 58n + BigInt(ALPH.indexOf(ch));
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const lead = str.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(n === 0n ? '' : hex, 'hex')]);
}
// h(mint): first 8 bytes of sha256(mint pubkey bytes), big-endian, / 2^64 (scanner sample.go).
const mintHash = (m) => Number(crypto.createHash('sha256').update(b58decode(m)).digest().readBigUInt64BE(0)) / 2 ** 64;
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0')); let s = '';
  while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}

const report = { dataset: path.resolve(ds), generated_at: new Date().toISOString(), coverage: [], decoding: {}, curve: {}, amm: {}, live: [], gecko: null };

// 1-2. coverage and decoding
// A day is complete when it lies wholly inside the parent-linked coverage; then no
// block is missing by construction. Partly covered days are flagged, not counted.
for (const d of man.days) report.coverage.push({ day: d.day, complete: d.complete, blocks_scanned: d.blocks_scanned, warm_up: d.warm_up, rows: d.rows });
const unknown = {}, newer = {};
for (const u of man.units) {
  for (const [k, v] of Object.entries(u.unknown_events || {})) unknown[k] = (unknown[k] || 0) + v;
  for (const [k, v] of Object.entries(u.newer_layouts || {})) newer[k] = (newer[k] || 0) + v;
}
report.decoding = { decode_failures: man.decode_failures, unknown_events: unknown, newer_layouts: newer, units: man.units.length, coverage_gaps: man.coverage_gaps || [] };

// 3-4. curves
const curveLast = new Map(); // mint -> last row
const curveAddr = new Map(); // mint -> bonding curve account (from CreateEvent)
{
  const created = new Map(); // mint -> tokens kept out of the curve's real reserves
  const extendAt = new Map(); // account -> [order keys of ExtendAccountEvent]
  const ordk = (s, t, v) => BigInt(s) * 1000000000000n + BigInt(t) * 1000000n + BigInt(v);
  for (const f of dayFiles('events')) {
    for (const l of zlib.zstdDecompressSync(fs.readFileSync(path.join(ds, f))).toString().trim().split('\n').filter(Boolean)) {
      const e = JSON.parse(l);
      if (e.event === 'CreateEvent') {
        curveAddr.set(e.fields.mint, e.fields.bonding_curve);
        created.set(e.fields.mint, { reserved: B(e.fields.token_total_supply) - B(e.fields.real_token_reserves), mayhem: e.fields.is_mayhem_mode === '1' });
      } else if (e.event === 'ExtendAccountEvent') {
        const k = e.fields.account;
        if (!extendAt.has(k)) extendAt.set(k, []);
        extendAt.get(k).push(ordk(e.slot, e.tx_idx, e.ev_idx));
      }
    }
  }
  const st = { trades: 0, quote_curve_trades: 0, quote_balance_checks: 0, quote_balance_exact: 0, quote_balance_ge: 0, real_pairs: 0, real_ok: 0, virtual_pairs: 0, virtual_ok: 0, virtual_pairs_mayhem: 0, virtual_ok_mayhem: 0, chain_bad: [],
    chain_checks: 0, token_checks: 0, token_exact: 0, sol_checks: 0, sol_exact: 0, sol_changed_at_extend: 0, chain_bad_rows: [], offsets: {} };
  const prev = new Map(), prevSol = new Map();
  for (const f of dayFiles('curve_trades')) {
    for (const r of readTable(f)) {
      st.trades++;
      const m = r.mint;
      const p = prev.get(m);
      // Curves quoted in another token keep their quote side in the *_quote_* fields
      // (the SOL fields are 0); SOL curves report quote_mint as the system program.
      const quoted = isQuoted(r);
      const vs = B(quoted ? r.virtual_quote_reserves : r.virtual_sol_reserves), vt = B(r.virtual_token_reserves);
      const rs = B(quoted ? r.real_quote_reserves : r.real_sol_reserves), rt = B(r.real_token_reserves);
      const sol = B(quoted ? r.quote_amount : r.sol_amount), tok = B(r.token_amount), buy = r.is_buy === '1';
      const mayhem = r.mayhem_mode === '1';
      if (quoted) st.quote_curve_trades++;
      if (p) {
        // real reserves move by exactly the trade amounts
        st.real_pairs++;
        const ers = buy ? p.rs + sol : p.rs - sol, ert = buy ? p.rt - tok : p.rt + tok;
        const realOk = ers === rs && ert === rt;
        if (realOk) st.real_ok++;
        // virtual reserves too, except where the program re-prices (mayhem mode)
        const evs = buy ? p.vs + sol : p.vs - sol, evt = buy ? p.vt - tok : p.vt + tok;
        const virtOk = evs === vs && evt === vt;
        if (mayhem) { st.virtual_pairs_mayhem++; if (virtOk) st.virtual_ok_mayhem++; } else { st.virtual_pairs++; if (virtOk) st.virtual_ok++; }
        if ((!realOk || (!virtOk && !mayhem)) && st.chain_bad.length < 20) st.chain_bad.push({ mint: m, mayhem, slot: r.slot, tx_idx: r.tx_idx, d_vsol: String(vs - evs), d_vtok: String(vt - evt), d_rsol: String(rs - ers), d_rtok: String(rt - ert) });
      }
      prev.set(m, { vs, vt, rs, rt });
      curveLast.set(m, r);
      if (quoted && r.last_in_tx === '1' && r.chain_curve_quote !== '') {
        // the curve's quote token account holds exactly real_quote_reserves
        st.quote_balance_checks++;
        if (B(r.chain_curve_quote) >= rs) st.quote_balance_ge++;
        if (B(r.chain_curve_quote) === rs) st.quote_balance_exact++;
        else if (B(r.chain_curve_quote) > rs) {}
        else if (st.chain_bad_rows.length < 20) st.chain_bad_rows.push({ mint: m, slot: r.slot, tx_idx: r.tx_idx, kind: 'quote', balance: r.chain_curve_quote, real_quote_reserves: String(rs) });
      }
      if (r.last_in_tx === '1' && r.chain_curve_base !== '' && r.chain_curve_lamports !== '') {
        st.chain_checks++;
        const to = B(r.chain_curve_base) - rt, so = quoted ? B(r.chain_curve_lamports) : B(r.chain_curve_lamports) - rs;
        st.offsets[`${to}|${so}`] = (st.offsets[`${to}|${so}`] || 0) + 1;
        // tokens: the curve's token account holds real_token_reserves plus the tokens
        // reserved for migration (token_total_supply - initial real_token_reserves)
        const c = created.get(m);
        if (c) {
          st.token_checks++;
          if (to === c.reserved) st.token_exact++;
          else if (st.chain_bad_rows.length < 20) st.chain_bad_rows.push({ mint: m, slot: r.slot, tx_idx: r.tx_idx, kind: 'token', offset: String(to), expected: String(c.reserved) });
        }
        // lamports: real_sol_reserves plus the account's rent; the rent only changes
        // when the account is extended
        const k = ordk(r.slot, r.tx_idx, r.ev_idx);
        const ps = prevSol.get(m);
        if (ps) {
          st.sol_checks++;
          if (ps.so === so) st.sol_exact++;
          else {
            const acct = curveAddr.get(m);
            const ext = acct && (extendAt.get(acct) || []).some((x) => x > ps.k && x <= k);
            if (ext) { st.sol_exact++; st.sol_changed_at_extend++; }
            else if (st.chain_bad_rows.length < 20) st.chain_bad_rows.push({ mint: m, slot: r.slot, tx_idx: r.tx_idx, kind: 'lamports', offset: String(so), previous: String(ps.so) });
          }
        }
        prevSol.set(m, { so, k });
      }
    }
  }
  st.top_offsets = Object.entries(st.offsets).sort((a, b) => b[1] - a[1]).slice(0, 5);
  delete st.offsets;
  report.curve = st;
}

// 3-4. PumpSwap pools: trades plus liquidity events and boosts, in order
const poolLast = new Map(); // pool -> {row, post}
{
  const st = { trades: 0, chain_pairs: 0, chain_ok: 0, chain_bad: [], chain_checks: 0, chain_exact: 0, chain_bad_rows: [], liquidity_events: 0, by_event: {} };
  // liquidity / boost events by pool, keyed for ordering
  const liq = new Map();
  for (const f of dayFiles('events')) {
    const lines = zlib.zstdDecompressSync(fs.readFileSync(path.join(ds, f))).toString().trim().split('\n').filter(Boolean);
    for (const l of lines) {
      const e = JSON.parse(l);
      if (!['DepositEvent', 'WithdrawEvent', 'InitBoostEvent', 'CreatePoolEvent'].includes(e.event)) continue;
      const pool = e.fields.pool;
      if (!liq.has(pool)) liq.set(pool, []);
      liq.get(pool).push(e);
    }
  }
  const ord = (s, t, v) => BigInt(s) * 1000000000000n + BigInt(t) * 1000000n + BigInt(v);
  const state = new Map(); // pool -> {base, quote} post-state
  const liqIdx = new Map();
  const applyLiq = (pool, upto) => {
    const evs = liq.get(pool); if (!evs) return;
    let i = liqIdx.get(pool) || 0;
    while (i < evs.length && ord(evs[i].slot, evs[i].tx_idx, evs[i].ev_idx) < upto) {
      const e = evs[i]; const f = e.fields; let s = state.get(pool);
      st.liquidity_events++;
      st.by_event[e.event] = (st.by_event[e.event] || 0) + 1;
      if (e.event === 'CreatePoolEvent') s = { base: B(f.pool_base_amount), quote: B(f.pool_quote_amount) };
      else if (e.event === 'DepositEvent' && s) s = { base: B(f.pool_base_token_reserves) + B(f.base_amount_in), quote: B(f.pool_quote_token_reserves) + B(f.quote_amount_in) };
      else if (e.event === 'WithdrawEvent' && s) s = { base: B(f.pool_base_token_reserves) - B(f.base_amount_out), quote: B(f.pool_quote_token_reserves) - B(f.quote_amount_out) };
      // InitBoost moves quote from the vault into virtual_quote_reserves. A boost
      // buy-and-burn is an ordinary BuyEvent (the bought tokens are burned outside
      // the pool), so the trade row already accounts for it.
      else if (e.event === 'InitBoostEvent' && s) s = { base: s.base, quote: B(f.real_quote_reserves_after) };
      if (s) state.set(pool, s);
      i++;
    }
    liqIdx.set(pool, i);
  };
  for (const f of dayFiles('amm_trades')) {
    for (const r of readTable(f)) {
      st.trades++;
      const pool = r.pool;
      applyLiq(pool, ord(r.slot, r.tx_idx, r.ev_idx));
      const preB = B(r.pool_base_token_reserves), preQ = B(r.pool_quote_token_reserves);
      const p = state.get(pool);
      if (p) {
        st.chain_pairs++;
        if (p.base === preB && p.quote === preQ) st.chain_ok++;
        else if (st.chain_bad.length < 20) st.chain_bad.push({ pool, slot: r.slot, tx_idx: r.tx_idx, d_base: String(preB - p.base), d_quote: String(preQ - p.quote) });
      }
      // vault change: base by the trade amount; quote by the amount net of fees that
      // leave the pool (quote_amount_in_with_lp_fee for buys, ..._without_lp_fee for sells)
      const base = B(r.base_amount), adj = B(r.quote_amount_lp_adjusted);
      const post = r.side === 'buy' ? { base: preB - base, quote: preQ + adj } : { base: preB + base, quote: preQ - adj };
      state.set(pool, post);
      poolLast.set(pool, { row: r, post });
      if (r.last_in_tx === '1' && r.chain_pool_base !== '' && r.chain_pool_quote !== '') {
        st.chain_checks++;
        if (B(r.chain_pool_base) === post.base && B(r.chain_pool_quote) === post.quote) st.chain_exact++;
        else if (st.chain_bad_rows.length < 20) st.chain_bad_rows.push({ pool, slot: r.slot, tx_idx: r.tx_idx, d_base: String(B(r.chain_pool_base) - post.base), d_quote: String(B(r.chain_pool_quote) - post.quote) });
      }
    }
  }
  // events after a pool's last trade (withdrawals, deposits) also move the vaults
  for (const [pool, evs] of liq) {
    applyLiq(pool, 1n << 120n); // beyond any (slot, tx, event) key
    const last = evs[evs.length - 1];
    const pl = poolLast.get(pool);
    if (pl && state.has(pool)) {
      pl.post = state.get(pool);
      const lk = ord(last.slot, last.tx_idx, last.ev_idx);
      if (lk > ord(pl.row.slot, pl.row.tx_idx, pl.row.ev_idx)) pl.lastSlot = Number(last.slot);
    }
  }
  report.amm = st;
}

// ---- raw records (schema 2): one per universe transaction, signature matches the wire bytes ----
const movementBalance = new Map(); // slot:tx -> { balances: mint -> owner -> delta, moves: same from movement rows }
let movementBalanceSkipped = 0;
if (man.schema >= 2) {
  const st = { records: 0, v1: 0, signature_mismatch: 0, trade_txs: 0, trade_txs_with_raw: 0, missing: [] };
  const rawKeys = new Set();
  const pumpBytes = [PUMP_PROGRAM, PUMP_AMM_PROGRAM].map(b58decode);
  for (const f of dayFiles('raw')) {
    const lines = zlib.zstdDecompressSync(fs.readFileSync(path.join(ds, f))).toString().split('\n').filter(Boolean);
    for (const l of lines) {
      const r = JSON.parse(l);
      st.records++;
      const w = Buffer.from(r.transaction, 'base64');
      if (w[0] === 0x81) {
        // v1 (SIMD-0385): message first, then the signatures, with no count prefix;
        // the first signature starts a 64-byte-aligned block counted from the end
        const sig = b58decode(r.signature);
        const at = w.lastIndexOf(sig);
        if (at < 0 || (w.length - at) % 64 !== 0) st.signature_mismatch++;
        st.v1++;
      } else if (b58encode(w.subarray(1, 65)) !== r.signature) {
        // legacy and v0: compact-u16 count (always < 128 here), then the signatures
        st.signature_mismatch++;
      }
      rawKeys.add(`${r.slot}:${r.txIndex}`);
      // Balance check of token movements: successful transactions that do not reference
      // pump or PumpSwap (statically or through a lookup table), so every token change of
      // a "pump" mint in them is a movement row. Per owner, post minus pre of each token
      // account, the owner taken as the movement rows take it (post over pre).
      if (r.err != null) continue;
      const loaded = [...(r.meta.loadedAddresses?.writable || []), ...(r.meta.loadedAddresses?.readonly || [])];
      if (pumpBytes.some((b) => w.includes(b)) || loaded.includes(PUMP_PROGRAM) || loaded.includes(PUMP_AMM_PROGRAM)) { movementBalanceSkipped++; continue; }
      const acct = new Map();
      for (const [side, list] of [[-1n, r.meta.preTokenBalances || []], [1n, r.meta.postTokenBalances || []]]) {
        for (const b of list) {
          if (!b.mint.endsWith('pump')) continue;
          const a = acct.get(b.accountIndex) || { mint: b.mint, owner: '', delta: 0n };
          a.mint = b.mint; a.owner = b.owner || '';
          a.delta += side * BigInt(b.uiTokenAmount?.amount || '0');
          acct.set(b.accountIndex, a);
        }
      }
      const byMint = new Map();
      for (const a of acct.values()) {
        if (!byMint.has(a.mint)) byMint.set(a.mint, new Map());
        const o = byMint.get(a.mint);
        o.set(a.owner, (o.get(a.owner) || 0n) + a.delta);
      }
      if (byMint.size) movementBalance.set(`${r.slot}:${r.txIndex}`, { balances: byMint, moves: new Map() });
    }
  }
  // Every create and migration transaction keeps its raw record, whatever the mint's hash.
  st.create_rows = 0; st.create_rows_with_raw = 0;
  for (const f of dayFiles('events')) {
    for (const l of zlib.zstdDecompressSync(fs.readFileSync(path.join(ds, f))).toString().split('\n').filter(Boolean)) {
      const e = JSON.parse(l);
      // Creates and migrations (whose transaction also creates the canonical pool).
      if (e.event !== 'CreateEvent' && e.event !== 'CompletePumpAmmMigrationEvent') continue;
      st.create_rows++;
      if (rawKeys.has(`${e.slot}:${e.tx_idx}`)) st.create_rows_with_raw++;
      else if (st.missing.length < 10) st.missing.push(`create ${e.slot}:${e.tx_idx}`);
    }
  }
  const sampleRate = man.sampling?.unit_sample_rate_min ?? 1;
  const inRawSample = (m) => m !== '' && mintHash(m) < sampleRate;
  const seen = new Set();
  for (const base of ['curve_trades', 'amm_trades', 'failed']) {
    for (const f of dayFiles(base)) {
      for (const r of readTable(f)) {
        // Raw records exist for transactions of hash-sampled mints only (retention
        // "curve-all,canonical-all,sample": other mints' rows have none).
        if (!inRawSample(r.mint ?? r.base_mint ?? r.mint_hint ?? '')) continue;
        const k = `${r.slot}:${r.tx_idx}`;
        if (seen.has(k)) continue;
        seen.add(k);
        st.trade_txs++;
        if (rawKeys.has(k)) st.trade_txs_with_raw++;
        else if (st.missing.length < 10) st.missing.push(k);
      }
    }
  }
  report.raw = st;
}

// ---- token movements ----
// Coverage rule: mints ending in "pump" have every movement of every successful
// transaction (complete); other mints only movements inside transactions that carry a
// pump or PumpSwap event of that mint, listed in movement_coverage with scope
// "pump_transactions" for the units' slot ranges; their ownership outside those rows is
// unresolved.
{
  const st = { files: 0, rows: 0, by_kind: {}, zero_amount: 0, malformed: 0, malformed_rows: [], partial_rows: 0, outside_coverage: 0, outside_coverage_rows: [],
    coverage_rows: 0, coverage_bad_scope: 0, supply_mints: 0, supply_negative: 0, supply_bad: [], balance_checks: 0, balance_exact: 0, balance_bad: [], balance_skipped_pump_txs: movementBalanceSkipped };
  const cover = new Map(); // mint -> [[from, to]]
  for (const f of fs.readdirSync(ds).filter((x) => x.startsWith('movement_coverage-')).sort()) {
    for (const c of readTable(f)) {
      st.coverage_rows++;
      if (c.scope !== 'pump_transactions') { st.coverage_bad_scope++; continue; }
      if (!cover.has(c.mint)) cover.set(c.mint, []);
      cover.get(c.mint).push([BigInt(c.from_slot), BigInt(c.to_slot)]);
    }
  }
  // Supply of fully covered mints ("pump" mints whose CreateEvent is in the dataset, so
  // every movement since the create is too): token_total_supply + mints - burns. Burns
  // inside PumpSwap (boost_buy_and_burn burns from the pool vault by CPI, so no movement
  // row) come from BoostBuyAndBurnEvent base_amount_burned.
  const supply = new Map(); // mint -> { total, minted, burned, event_burned }
  const eventBurn = new Map();
  for (const f of dayFiles('events')) {
    for (const l of zlib.zstdDecompressSync(fs.readFileSync(path.join(ds, f))).toString().split('\n').filter(Boolean)) {
      const e = JSON.parse(l);
      if (e.event === 'CreateEvent' && e.fields.mint?.endsWith('pump') && e.fields.token_total_supply) supply.set(e.fields.mint, { total: BigInt(e.fields.token_total_supply), minted: 0n, burned: 0n });
      else if (e.event === 'BoostBuyAndBurnEvent' && e.fields.base_amount_burned) eventBurn.set(e.fields.mint, (eventBurn.get(e.fields.mint) || 0n) + BigInt(e.fields.base_amount_burned));
    }
  }
  const bad = (list, x) => { if (list.length < 10) list.push(x); };
  const add = (m, k, v) => m.set(k, (m.get(k) || 0n) + v);
  for (const f of dayFiles('movements')) {
    st.files++;
    for (const r of readTable(f)) {
      st.rows++;
      st.by_kind[r.kind] = (st.by_kind[r.kind] || 0) + 1;
      const id = `${r.slot}:${r.tx_idx}:${r.outer_ix}:${r.inner_ix}`;
      const amountOk = /^\d+$/.test(r.amount ?? '') && BigInt(r.amount) <= U64_MAX;
      const shapeOk = r.kind === 'transfer' ? r.from_account !== '' && r.to_account !== ''
        : r.kind === 'burn' ? r.from_account !== '' && r.to_account === '' && r.to_owner === ''
        : r.kind === 'mint' ? r.to_account !== '' && r.from_account === '' && r.from_owner === '' : false;
      if (!amountOk || !shapeOk || !r.mint) { st.malformed++; bad(st.malformed_rows, `${id} ${r.kind} ${r.amount}`); continue; }
      const a = BigInt(r.amount);
      if (a === 0n) st.zero_amount++; // zero-amount transfers are valid on chain (address poisoning); reported, not a miss
      if (!r.mint.endsWith('pump')) {
        st.partial_rows++;
        const s = BigInt(r.slot);
        if (!(cover.get(r.mint) || []).some(([lo, hi]) => s >= lo && s <= hi)) { st.outside_coverage++; bad(st.outside_coverage_rows, `${id} ${r.mint}`); }
        continue;
      }
      const sp = supply.get(r.mint);
      if (sp && r.kind === 'burn') sp.burned += a;
      if (sp && r.kind === 'mint') sp.minted += a;
      const tx = movementBalance.get(`${r.slot}:${r.tx_idx}`);
      if (tx) {
        if (!tx.moves.has(r.mint)) tx.moves.set(r.mint, new Map());
        const o = tx.moves.get(r.mint);
        if (r.kind !== 'mint') add(o, r.from_owner, -a);
        if (r.kind !== 'burn') add(o, r.to_owner, a);
      }
    }
  }
  for (const [mint, sp] of supply) {
    st.supply_mints++;
    const left = sp.total + sp.minted - sp.burned - (eventBurn.get(mint) || 0n);
    if (left < 0n) { st.supply_negative++; bad(st.supply_bad, { mint, total: String(sp.total), minted: String(sp.minted), burned: String(sp.burned), event_burned: String(eventBurn.get(mint) || 0n) }); }
  }
  for (const [k, tx] of movementBalance) {
    for (const [mint, bal] of tx.balances) {
      st.balance_checks++;
      const mv = tx.moves.get(mint) || new Map();
      const diff = [...new Set([...bal.keys(), ...mv.keys()])].filter((o) => (bal.get(o) || 0n) !== (mv.get(o) || 0n));
      if (diff.length === 0) st.balance_exact++;
      else bad(st.balance_bad, { tx: k, mint, owners: diff.map((o) => ({ owner: o, balance_delta: String(bal.get(o) || 0n), movement_delta: String(mv.get(o) || 0n) })) });
    }
  }
  report.movements = st;
}

// ---- live checks ----
async function rpc(method, params) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(Math.min(30000, 2000 * 2 ** i)); continue; }
    const j = await r.json();
    if (j.error && (j.error.code === 429 || /rate/i.test(j.error.message))) { await sleep(Math.min(30000, 2000 * 2 ** i)); continue; }
    await sleep(1100); // public RPC: 10 requests per 10 s per method
    return j;
  }
  throw new Error('rpc ' + method + ' failed');
}
const u64 = (b, o) => b.readBigUInt64LE(o);
const i128 = (b, o) => { const lo = b.readBigUInt64LE(o), hi = b.readBigInt64LE(o + 8); return (hi << 64n) + lo; };

if (LIVE > 0) {
  const coverageEnd = man.coverage.last_slot;
  // deterministic candidate order: by mint string
  const curves = [...curveLast.keys()].filter((m) => curveAddr.has(m)).sort();
  const pools = [...poolLast.keys()].sort();
  const want = { curve: Math.ceil(LIVE * 0.6), pool: LIVE - Math.ceil(LIVE * 0.6) };
  const tried = { curve: 0, pool: 0 };
  for (const m of curves) {
    if (report.live.filter((x) => x.kind === 'curve').length >= want.curve || tried.curve >= want.curve * 4) break;
    tried.curve++;
    const acct = curveAddr.get(m);
    const sigs = await rpc('getSignaturesForAddress', [acct, { limit: 20 }]);
    const latest = (sigs.result || []).find((x) => x.err === null); // failed transactions change nothing
    if (!latest || latest.slot > coverageEnd) continue; // traded after our coverage
    const ai = await rpc('getAccountInfo', [acct, { encoding: 'base64' }]);
    const v = ai.result?.value; if (!v) continue;
    const buf = Buffer.from(v.data[0], 'base64');
    const chain = { vtok: u64(buf, 8), vsol: u64(buf, 16), rtok: u64(buf, 24), rsol: u64(buf, 32), complete: buf[48] === 1 };
    const r = curveLast.get(m);
    const q = isQuoted(r);
    const ours = { vtok: B(r.virtual_token_reserves), vsol: B(q ? r.virtual_quote_reserves : r.virtual_sol_reserves), rtok: B(r.real_token_reserves), rsol: B(q ? r.real_quote_reserves : r.real_sol_reserves) };
    const maxDiff = ['vtok', 'vsol', 'rtok', 'rsol'].reduce((a, k) => { const d = chain[k] - ours[k]; const ad = d < 0n ? -d : d; return ad > a ? ad : a; }, 0n);
    report.live.push({ kind: 'curve', mint: m, account: acct, last_event_slot: Number(r.slot), latest_chain_tx_slot: latest.slot, complete: chain.complete, max_abs_diff_raw: String(maxDiff), pass: maxDiff <= 1n });
  }
  for (const pool of pools) {
    if (report.live.filter((x) => x.kind === 'pool').length >= want.pool || tried.pool >= want.pool * 6) break;
    tried.pool++;
    const sigs = await rpc('getSignaturesForAddress', [pool, { limit: 20 }]);
    const latest = (sigs.result || []).find((x) => x.err === null);
    const { row, post, lastSlot } = poolLast.get(pool);
    if (!latest || latest.slot > coverageEnd) continue; // traded after our coverage
    const ai = await rpc('getAccountInfo', [pool, { encoding: 'base64' }]);
    const v = ai.result?.value; if (!v) continue;
    const buf = Buffer.from(v.data[0], 'base64');
    const baseVault = b58encode(buf.subarray(139, 171)), quoteVault = b58encode(buf.subarray(171, 203));
    const vq = i128(buf, 245);
    const accs = await rpc('getMultipleAccounts', [[baseVault, quoteVault], { encoding: 'jsonParsed' }]);
    const [bv, qv] = accs.result.value.map((a) => BigInt(a.data.parsed.info.tokenAmount.amount));
    const db = bv - post.base, dq = qv - post.quote;
    const ad = (x) => (x < 0n ? -x : x);
    report.live.push({ kind: 'pool', pool, mint: row.base_mint, last_event_slot: lastSlot ?? Number(row.slot), latest_chain_tx_slot: latest.slot, virtual_quote_reserves: String(vq), d_base_raw: String(db), d_quote_raw: String(dq), pass: ad(db) <= 1n && ad(dq) <= 1n });
  }
}

// ---- GeckoTerminal comparison ----
if (GECKO > 0) {
  const mints = readTable(man.mints_files[0].path).filter((m) => m.grad === '1' && m.pool);
  const sample = mints.sort((a, b) => a.mint.localeCompare(b.mint)).slice(0, GECKO);
  const minuteLast = new Map(); // pool -> Map(minute -> price SOL/token)
  const pools = new Set(sample.map((m) => m.pool));
  for (const f of dayFiles('amm_trades')) {
    for (const r of readTable(f)) {
      if (!pools.has(r.pool) || r.quote_mint !== 'So11111111111111111111111111111111111111112') continue;
      const base = B(r.base_amount), adj = B(r.quote_amount_lp_adjusted);
      const preB = B(r.pool_base_token_reserves), preQ = B(r.pool_quote_token_reserves);
      const vq = r.virtual_quote_reserves === '' ? 0n : B(r.virtual_quote_reserves);
      const postB = r.side === 'buy' ? preB - base : preB + base, postQ = r.side === 'buy' ? preQ + adj : preQ - adj;
      const px = (Number(postQ + vq) / Number(postB)) * 1e-3; // SOL per token (9 vs 6 decimals)
      const minute = Math.floor(Number(r.block_time) / 60) * 60;
      if (!minuteLast.has(r.pool)) minuteLast.set(r.pool, new Map());
      minuteLast.get(r.pool).set(minute, px);
    }
  }
  const diffs = []; const perPool = [];
  for (const m of sample) {
    const ours = minuteLast.get(m.pool); if (!ours || ours.size < 5) continue;
    const before = Math.max(...ours.keys()) + 60;
    await sleep(4500);
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${m.pool}/ohlcv/minute?aggregate=1&limit=1000&currency=token&before_timestamp=${before}`, { headers: { accept: 'application/json' } });
    if (!r.ok) { perPool.push({ pool: m.pool, status: r.status }); continue; }
    const j = await r.json();
    const list = j?.data?.attributes?.ohlcv_list || [];
    let n = 0; const d = [];
    for (const [t, , , , c] of list) {
      const o = ours.get(t);
      if (o === undefined || !(c > 0)) continue;
      d.push(Math.abs(o / c - 1)); n++;
    }
    d.sort((a, b) => a - b);
    if (n) { diffs.push(...d); perPool.push({ pool: m.pool, minutes_compared: n, median_abs_rel_diff: d[n >> 1], p90: d[Math.floor(n * 0.9)] }); }
  }
  diffs.sort((a, b) => a - b);
  report.gecko = { pools_requested: sample.length, pools_compared: perPool.filter((p) => p.minutes_compared).length, minutes_compared: diffs.length,
    median_abs_rel_diff: diffs[diffs.length >> 1] ?? null, p90_abs_rel_diff: diffs[Math.floor(diffs.length * 0.9)] ?? null, per_pool: perPool,
    note: 'Our price: post-trade (pool quote + virtual quote) / pool base of the last trade in each minute. GeckoTerminal: 1-minute close in SOL (currency=token). Only these statistics are kept.' };
}

fs.mkdirSync(path.join(ds, 'qa'), { recursive: true });
fs.writeFileSync(path.join(ds, 'qa', 'report.json'), JSON.stringify(report, null, 2));
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(4) + '%' : 'n/a');
const md = [];
md.push(`# Data quality report`, '', `Dataset window ${man.window.from} to ${man.window.to_exclusive} (exclusive). Generated ${report.generated_at}.`, '');
md.push('## Coverage', '', `Scanned slots ${man.coverage.first_slot} to ${man.coverage.last_slot} (block times ${new Date(man.coverage.first_block_time * 1000).toISOString()} to ${new Date(man.coverage.last_block_time * 1000).toISOString()}). Every block's parent is the previous scanned block (${(man.chain_breaks || []).length} breaks), so no block is missing in between.`, '', '| Day | Whole day covered | Blocks | Warm-up | Curve trades | AMM trades |', '|---|---|---|---|---|---|');
for (const c of report.coverage) md.push(`| ${c.day} | ${c.complete ? 'yes' : 'partly'} | ${c.blocks_scanned} | ${c.warm_up ? 'yes' : 'no'} | ${c.rows.curve_trades} | ${c.rows.amm_trades} |`);
md.push('', '## Decoding', '', `Decode failures: ${report.decoding.decode_failures}. Unknown events: ${JSON.stringify(report.decoding.unknown_events)}. Newer layouts than the IDL: ${JSON.stringify(report.decoding.newer_layouts)}. Coverage gaps: ${JSON.stringify(report.decoding.coverage_gaps)}.`);
const c = report.curve, a = report.amm;
md.push('', '## Reserve chain', '', `Bonding curve real reserves: ${c.real_ok} of ${c.real_pairs} consecutive trade pairs rebuild exactly (${pct(c.real_ok, c.real_pairs)}). Virtual reserves: ${c.virtual_ok} of ${c.virtual_pairs} (${pct(c.virtual_ok, c.virtual_pairs)}) on regular curves; on mayhem-mode curves, where the program re-prices virtual reserves, ${c.virtual_ok_mayhem} of ${c.virtual_pairs_mayhem}.`, `PumpSwap: ${a.chain_ok} of ${a.chain_pairs} trades start from exactly the rebuilt reserves (${pct(a.chain_ok, a.chain_pairs)}); ${a.liquidity_events} liquidity, boost and pool-creation events applied.`);
md.push('', '## Against recorded account balances', '', `Curves quoted in a token other than SOL: ${c.quote_curve_trades} trades; their quote token account equals real_quote_reserves in ${c.quote_balance_exact} of ${c.quote_balance_checks} checks and is never below it in ${c.quote_balance_ge} (the excess is quote tokens held by the curve outside its reserves, such as fees awaiting distribution; real reserves themselves rebuild exactly). Bonding curve token account: ${c.token_exact} of ${c.token_checks} checks equal real_token_reserves plus the reserved migration tokens exactly (${pct(c.token_exact, c.token_checks)}). Lamports: ${c.sol_exact} of ${c.sol_checks} checks keep the same rent offset as the previous check (${c.sol_changed_at_extend} of them changed exactly at an account extension) (${pct(c.sol_exact, c.sol_checks)}). Most common offsets (reserved tokens | rent): ${JSON.stringify(c.top_offsets)}.`, `PumpSwap: ${a.chain_exact} of ${a.chain_checks} checks match both vault balances exactly (${pct(a.chain_exact, a.chain_checks)}).`);
{
  const m = report.movements;
  md.push('', '## Token movements', '', 'Coverage: mints ending in "pump" have every token movement of every successful transaction (complete); other mints have only the movements inside transactions that carry a pump or PumpSwap event of that mint, listed in movement_coverage (scope pump_transactions) for the units\' slot ranges, and their ownership outside those rows is unresolved.',
    '', `${m.rows} rows in ${m.files} files (${JSON.stringify(m.by_kind)}); ${m.malformed} malformed; ${m.zero_amount} with amount 0 (valid on chain, not a miss); ${m.partial_rows} rows of other mints, ${m.outside_coverage} of them outside movement_coverage (${m.coverage_rows} coverage rows, ${m.coverage_bad_scope} with an unknown scope).`,
    '', `Supply: ${m.supply_mints} "pump" mints with their CreateEvent in the dataset; token_total_supply + mints - burns (movement rows) - BoostBuyAndBurnEvent burns is below zero for ${m.supply_negative}. Ownership per holder is not rebuilt here.`,
    '', `Balances: ${m.balance_exact} of ${m.balance_checks} (transaction, "pump" mint) pairs match exactly: per owner, the token balance change in the raw record equals the sum of that transaction's movement rows. Scope: successful raw records of transactions that reference neither pump nor PumpSwap (plain token transactions of hash-sampled mints); ${m.balance_skipped_pump_txs} raw records that touch pump or PumpSwap are not balance-checked here (their movement rows are checked against the instructions by the parity check).`);
}
if (report.live.length) {
  const pass = report.live.filter((x) => x.pass).length;
  md.push('', '## Live on-chain checks', '', `${pass} of ${report.live.length} idle curves and pools match their current on-chain state within 1 raw unit.`, '', '| Kind | Account | Last event slot | Latest chain tx slot | Result |', '|---|---|---|---|---|');
  for (const x of report.live) md.push(`| ${x.kind} | ${x.kind === 'curve' ? x.account : x.pool} | ${x.last_event_slot} | ${x.latest_chain_tx_slot} | ${x.pass ? 'match' : 'DIFF ' + (x.max_abs_diff_raw ?? `${x.d_base_raw}/${x.d_quote_raw}`)} |`);
}
if (report.gecko) {
  const g = report.gecko;
  md.push('', '## GeckoTerminal comparison', '', `${g.pools_compared} pools, ${g.minutes_compared} minutes: median absolute relative difference ${g.median_abs_rel_diff}, 90th percentile ${g.p90_abs_rel_diff}.`, '', g.note);
}
// ---- strict verdict ----
// Misses: anything that is not explained in docs/research/historical-data.md (mayhem
// virtual re-pricing, rent changes without an extension event and quote-token excess
// are documented and not counted). See verdict.mjs.
const misses = strictMisses(man, report, { leadInDays: LEAD_IN });
report.strict = { pass: misses.length === 0, misses };
report.regime_boundaries = REGIME_BOUNDARIES;
md.push('', '## Regime boundaries', '', 'Program and configuration changes that split the data into regimes (UPG-1b, PR #44). Before B4 the trade events are exactly two fields (16 bytes) shorter; the strict QA allows that layout only in units that start before B4.', '', '| Id | UTC | Slots | Change |', '|---|---|---|---|');
for (const b of REGIME_BOUNDARIES) md.push(`| ${b.id} | ${b.utc} | ${Object.entries(b.slots).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a'} | ${b.change} |`);
md.push('', '## Verdict', '', misses.length ? `FAIL: ${misses.join('; ')}` : 'PASS: no unexplained miss.');
if (report.raw) md.push('', `Parity scope: raw records, and so the decoder parity check (qa/parity.json), cover only transactions of hash-sampled mints (h(mint) < ${man.sampling?.unit_sample_rate_min ?? 1}, retention ${man.sampling?.retention || 'sample only'}). Rows of other mints come from the same decoder but are not re-decoded one by one; this is sample parity, not full-row parity.`);
if (report.raw) md.push('', `Raw records: ${report.raw.records}; signature mismatches ${report.raw.signature_mismatch}; ${report.raw.trade_txs_with_raw} of ${report.raw.trade_txs} trade and failed transactions of hash-sampled mints have their raw record.`);
fs.writeFileSync(path.join(ds, 'qa', 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(ds, 'qa', 'report.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
if (STRICT && misses.length) process.exit(1);
