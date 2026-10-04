import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
const dirs = process.argv.slice(2).flatMap(r => fs.readdirSync(r).flatMap(e => fs.readdirSync(path.join(r,e)).map(u => path.join(r,e,u)))).filter(d => !d.endsWith('.tmp') && fs.existsSync(path.join(d,'stats.json')));
const rd = f => fs.existsSync(f) && fs.statSync(f).size ? zlib.zstdDecompressSync(fs.readFileSync(f)).toString() : '';
const csv = t => t.split('\n').filter(Boolean).map(l => l.split(','));  // census and rows: no quoted commas in used cols (approx)
const creator = new Map(), grads = new Set(), poolOfMint = new Map(), canonPools = new Set(), createPoolEv = [];
let t0 = Infinity, t1 = 0, sample = 0; const bytes = {}; let curveRowsSampled = 0, ammRowsSampled = 0;
const agg = [];
for (const d of dirs) {
  const st = JSON.parse(fs.readFileSync(path.join(d,'stats.json'))); sample = st.sample_rate || 0.25;
  t0 = Math.min(t0, st.first_block_time); t1 = Math.max(t1, st.last_block_time);
  for (const f of fs.readdirSync(d)) bytes[f] = (bytes[f]||0) + fs.statSync(path.join(d,f)).size;
  for (const l of rd(path.join(d,'events.jsonl.zst')).split('\n').filter(Boolean)) {
    const e = JSON.parse(l), F = e.fields || {};
    if (e.event === 'CreateEvent') creator.set(F.mint, F.creator);
    else if (e.event === 'CompletePumpAmmMigrationEvent') { grads.add(F.mint); poolOfMint.set(F.mint, F.pool); canonPools.add(F.pool); }
    else if (e.event === 'CreatePoolEvent') createPoolEv.push(F);
  }
  const a = csv(rd(path.join(d,'agg_hourly.csv.zst'))); const h = a.shift();
  for (const r of a) agg.push(Object.fromEntries(h.map((k,i)=>[k,r[i]])));
  curveRowsSampled += Math.max(0, csv(rd(path.join(d,'curve_trades.csv.zst'))).length - 1);
  ammRowsSampled += Math.max(0, csv(rd(path.join(d,'amm_trades.csv.zst'))).length - 1);
}
const hours = (t1 - t0) / 3600;
const gradCreators = new Set([...grads].map(m => creator.get(m)).filter(Boolean));
const cat = { a: 0, b: 0, c: 0, d: 0, amm_noncanon_pump: 0, amm_other: 0, curve_total: 0, amm_total: 0 };
let curveMintsByGradCreators = new Set();
for (const r of agg) {
  const n = Number(r.n_buy) + Number(r.n_sell);
  if (r.venue === 'curve') {
    cat.curve_total += n;
    if (grads.has(r.mint)) cat.b += n;
    else if (gradCreators.has(creator.get(r.mint))) { cat.c += n; curveMintsByGradCreators.add(r.mint); }
    else cat.d += n;
  } else {
    cat.amm_total += n;
    // canonical: the migration pool of a pump mint, known when migrated in coverage; else heuristic: base mint ends with "pump"
    if (canonPools.has(r.pool) || (r.mint.endsWith('pump') && r.quote_mint === 'So11111111111111111111111111111111111111112')) cat.a += n;
    else cat.d += n;
  }
}
const total = cat.curve_total + cat.amm_total;
const pct = x => (100 * x / total).toFixed(1) + '%';
console.log(JSON.stringify({ units: dirs.length, hours: hours.toFixed(2), sample, creates: creator.size, graduations_in_coverage: grads.size, grads_per_day: (grads.size * 24 / hours).toFixed(0), creates_per_day: (creator.size*24/hours).toFixed(0), grad_creators: gradCreators.size,
  trades_total: total, per_day: Math.round(total*24/hours), curve: cat.curve_total, amm: cat.amm_total,
  a_canonical_pool: [cat.a, pct(cat.a)], b_curve_of_graduates: [cat.b, pct(cat.b)], c_curve_of_grad_deployers_other_mints: [cat.c, pct(cat.c)], d_rest: [cat.d, pct(cat.d)],
  sampled_rows: { curve: curveRowsSampled, amm: ammRowsSampled }, bytes_by_file_MB: Object.fromEntries(Object.entries(bytes).map(([k,v])=>[k,(v/1e6).toFixed(1)])) }, null, 1));
const canon = new Set(), curveMints = new Set();
for (const r of agg) { if (r.venue !== 'curve' && (canonPools.has(r.pool) || (r.mint.endsWith('pump') && r.quote_mint === 'So11111111111111111111111111111111111111112'))) canon.add(r.pool); if (r.venue === 'curve') curveMints.add(r.mint); }
console.log('distinct canonical(-like) pools trading in window', canon.size, 'curve mints trading', curveMints.size, 'non-suffix pump creates', [...creator.keys()].filter(m=>!m.endsWith('pump')).length);
