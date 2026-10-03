// Strict verdict of the data quality report (used by check.mjs, tested by
// verdict.test.mjs). A miss is anything not explained in docs/research/historical-data.md.

// Event discriminators the 2026-10-02 program upgrade added without a published IDL
// (kept raw as Unknown events). Anything else unknown fails the verdict.
export const ALLOWED_UNKNOWN = new Set(['pump:742b4dbd117a482b', 'amm:82a42461e48287a5', 'pump:a943276d6686b6e8']);
// The same upgrade appended 8 bytes to these trade events (kept as extra_hex).
export const EXTRA8_EVENTS = new Set(['pump:TradeEvent', 'amm:BuyEvent', 'amm:SellEvent']);

// Regime boundaries found by UPG-1b (PR #44), listed in the QA report. B4 (2026-09-12
// 15:24 UTC) added holder_rewards_bps and holder_rewards (16 bytes) to TradeEvent,
// BuyEvent and SellEvent; before it those events are exactly two fields shorter.
export const REGIME_BOUNDARIES = [
  { id: 'B2', utc: '2026-07-21 14:23', slots: { admin: 434319990 }, what: 'admin BOOST on, migration economics' },
  { id: 'B3', utc: '2026-09-09 19:30', slots: { pump: 445690911, pump_amm: 445691021, other: 445691085, admin: 445691266 }, what: 'fee and creator-fee config changes' },
  { id: 'B4', utc: '2026-09-12 15:24', slots: { pump_amm: 446462733, pump: 446462760, admin: 446462883 }, what: 'Trade/Buy/Sell events +16 bytes (holder_rewards_bps, holder_rewards)' },
  { id: 'B5', utc: '2026-10-02 ~20:00', slots: {}, what: 'undocumented upgrade: +8 bytes on trade events, new discriminators (regime boundary day)' },
];
// Pre-B4 layouts: event key -> [fields in that layout, first slot of B4 on that program].
export const PRE_B4_LAYOUTS = new Map([
  ['pump:TradeEvent:32', 446462760],
  ['amm:BuyEvent:37', 446462733],
  ['amm:SellEvent:30', 446462733],
]);

const DAY = 86400;
// The 2026-10-02 program upgrade is a regime boundary (supervisor ruling, 2026-10-03):
// decision days stay before it, so an assembled dataset (lead-in > 0) may not include
// this day or later. Single-day checks (lead-in 0) may.
export const REGIME_BOUNDARY_DAY = '2026-10-02';
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// windowDays lists the UTC days of [from, to).
export function windowDays(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z') / 1000; t < Date.parse(to + 'T00:00:00Z') / 1000; t += DAY) out.push(iso(t));
  return out;
}

// strictMisses(man, report, { leadInDays }) returns the list of misses.
export function strictMisses(man, report, { leadInDays = 14 } = {}) {
  const misses = [];
  // Coverage: every day of the window is present, complete and has its lead-in.
  const byDay = new Map((man.days || []).map((d) => [d.day, d]));
  for (const day of windowDays(man.window.from, man.window.to_exclusive)) {
    const d = byDay.get(day);
    if (!d) misses.push(`day ${day} absent`);
    else if (!d.complete) misses.push(`day ${day} incomplete`);
    else if (d.warm_up) misses.push(`day ${day} lacks its lead-in`);
  }
  if (leadInDays > 0 && man.window.to_exclusive > REGIME_BOUNDARY_DAY) misses.push(`window reaches ${REGIME_BOUNDARY_DAY}, the program-upgrade regime boundary`);
  if ((man.window.lead_in_days ?? 0) < leadInDays) misses.push(`lead-in ${man.window.lead_in_days ?? 0} days, ${leadInDays} required`);
  if (man.decode_failures > 0) misses.push(`decode failures ${man.decode_failures}`);
  if ((man.chain_breaks || []).length > 0) misses.push(`parent-link breaks ${man.chain_breaks.length}`);
  if ((man.coverage_gaps || []).length > 0) misses.push(`coverage gaps ${man.coverage_gaps.length}`);
  // Decoding: only the documented upgrade may differ from the published IDL.
  const sum = (key) => {
    const o = {};
    for (const u of man.units || []) for (const [k, v] of Object.entries(u[key] || {})) o[k] = (o[k] || 0) + v;
    return o;
  };
  for (const [k, v] of Object.entries(sum('unknown_events'))) if (!ALLOWED_UNKNOWN.has(k)) misses.push(`unknown event ${k} x${v}`);
  for (const [k, v] of Object.entries(sum('extra_bytes'))) {
    const i = k.lastIndexOf(':');
    const ev = k.slice(0, i), n = Number(k.slice(i + 1));
    if (n !== 0 && !(n === 8 && EXTRA8_EVENTS.has(ev))) misses.push(`extra bytes ${k} x${v}`);
  }
  for (const [k, v] of Object.entries(sum('newer_layouts'))) if (!EXTRA8_EVENTS.has(k)) misses.push(`newer layout ${k} x${v}`);
  // Older layouts: only the pre-B4 layout, and only in units that start before B4 on
  // that program (the unit holding the boundary may carry both).
  for (const u of man.units || []) {
    for (const [k, v] of Object.entries(u.older_layouts || {})) {
      const b4 = PRE_B4_LAYOUTS.get(k);
      if (b4 === undefined || !(u.from_slot < b4)) misses.push(`older layout ${k} x${v}${b4 === undefined ? '' : ` in unit from slot ${u.from_slot}, after B4 (${b4})`}`);
    }
  }
  const anomalies = (man.units || []).reduce((s, u) => s + (u.length_anomalies || 0), 0);
  if (anomalies > 0) misses.push(`event length anomalies ${anomalies}`);
  // Reserve chains and recorded balances.
  const c = report.curve, a = report.amm;
  if (c) {
    if (c.real_ok !== c.real_pairs) misses.push(`curve real reserves ${c.real_ok}/${c.real_pairs}`);
    if (c.virtual_ok !== c.virtual_pairs) misses.push(`curve virtual reserves ${c.virtual_ok}/${c.virtual_pairs}`);
    if (c.token_exact !== c.token_checks) misses.push(`curve token balances ${c.token_exact}/${c.token_checks}`);
    if (c.quote_balance_ge !== c.quote_balance_checks) misses.push(`quote balance below reserves ${c.quote_balance_checks - c.quote_balance_ge}`);
  }
  if (a) {
    if (a.chain_ok !== a.chain_pairs) misses.push(`pool reserve chain ${a.chain_ok}/${a.chain_pairs}`);
    if (a.chain_exact !== a.chain_checks) misses.push(`pool vault balances ${a.chain_exact}/${a.chain_checks}`);
  }
  if (report.raw) {
    if (report.raw.signature_mismatch > 0) misses.push(`raw signature mismatches ${report.raw.signature_mismatch}`);
    if ((report.raw.create_rows_with_raw ?? 0) !== (report.raw.create_rows ?? 0)) misses.push(`create transactions without raw record ${report.raw.create_rows - report.raw.create_rows_with_raw}`);
    if (report.raw.trade_txs_with_raw !== report.raw.trade_txs) misses.push(`trade transactions without raw record ${report.raw.trade_txs - report.raw.trade_txs_with_raw}`);
  }
  const liveFail = (report.live || []).filter((x) => !x.pass).length;
  if (liveFail > 0) misses.push(`live on-chain mismatches ${liveFail}`);
  return misses;
}
