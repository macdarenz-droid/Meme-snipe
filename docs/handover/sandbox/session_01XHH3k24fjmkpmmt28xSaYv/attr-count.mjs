// Swap attribution counts of one unit: trades with user_token_owner != user, empty owners, marks.
import fs from 'node:fs';
import zlib from 'node:zlib';
const dir = process.argv[2];
const table = (f) => {
  const lines = zlib.zstdDecompressSync(fs.readFileSync(`${dir}/${f}`)).toString().split('\n').filter(Boolean);
  const h = lines[0].split(',');
  return lines.slice(1).map((l) => { const v = l.split(','); return Object.fromEntries(h.map((c, i) => [c, v[i]])); });
};
const out = {};
const marks = new Set(table('movement_coverage.csv.zst').filter((c) => c.reason === 'swap_owner_unknown').map((c) => `${c.mint}|${c.slot}:${c.tx_idx}`));
out.swap_owner_unknown_mark_rows = marks.size;
out.swap_owner_unknown_mints = new Set([...marks].map((k) => k.split('|')[0])).size;
for (const [f, mintCol] of [['curve_trades.csv.zst', 'mint'], ['amm_trades.csv.zst', 'base_mint']]) {
  const s = { trades: 0, owner_ne_user: 0, owner_ne_signer: 0, owner_empty: 0, owner_empty_no_account: 0, owner_empty_marked: 0, examples: [] };
  for (const r of table(f)) {
    s.trades++;
    if (r.user_token_owner === '') {
      s.owner_empty++;
      if (r.user_token_account === '') s.owner_empty_no_account++;
      if (marks.has(`${r[mintCol]}|${r.slot}:${r.tx_idx}`)) s.owner_empty_marked++;
    } else {
      if (r.user_token_owner !== r.user) { s.owner_ne_user++; if (s.examples.length < 3) s.examples.push(r.signature); }
      if (r.user_token_owner !== r.signer) s.owner_ne_signer++;
    }
  }
  out[f] = s;
}
console.log(JSON.stringify(out, null, 1));
