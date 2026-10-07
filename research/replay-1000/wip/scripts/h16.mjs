import { readFileSync, createReadStream } from 'node:fs';
import readline from 'node:readline';
const [j, coinsF] = process.argv.slice(2);
const full = new Set(JSON.parse(readFileSync(coinsF,'utf8')).map(c=>c.mint));
const lines = new Map(), coins = new Map(), ex = new Map(), lastCoin = new Map();
const rl = readline.createInterface({ input: createReadStream(j) });
for await (const s of rl) {
  if (!s.includes('"missing"')) continue;
  const l = JSON.parse(s); if (l.kind!=='decision') continue;
  const mint = l.reasons?.[2]; if (!full.has(mint)) continue;
  const keys = new Set();
  for (const g of l.gate_reasons ?? []) {
    if (g.gate!=='H16' || g.code!=='missing') continue;
    const k = g.detail.replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g,'<addr>').replace(/\d{6,}/g,'<n>');
    keys.add(k); lines.set(k,(lines.get(k)??0)+1);
    if (!ex.has(k)) ex.set(k, g.detail);
    (coins.get(k) ?? coins.set(k,new Set()).get(k)).add(mint);
  }
  lastCoin.set(mint, keys);
}
const last = new Map(); for (const ks of lastCoin.values()) for (const k of ks) last.set(k,(last.get(k)??0)+1);
for (const [k,n] of [...lines].sort((a,b)=>b[1]-a[1])) console.log(`${coins.get(k).size} coins | ${last.get(k)??0} in last | ${n} lines | ${k}\n    e.g. ${ex.get(k).slice(0,200)}`);
