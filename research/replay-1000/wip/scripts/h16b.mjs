import { readFileSync, createReadStream } from 'node:fs';
import readline from 'node:readline';
const [j, coinsF] = process.argv.slice(2);
const cs = new Map(JSON.parse(readFileSync(coinsF,'utf8')).map(c=>[c.mint,c]));
const first = new Map(), lastAny = new Map();
for await (const s of readline.createInterface({ input: createReadStream(j) })) {
  if (!s.includes('"decision"')) continue;
  const l = JSON.parse(s); const mint = l.reasons?.[2]; if (!cs.has(mint) || l.action!=='reject') continue;
  const miss = (l.gate_reasons??[]).filter(g=>g.gate==='H16'&&g.code==='missing').map(g=>g.detail.split(' as of')[0]);
  if (miss.length && !first.has(mint)) first.set(mint,{ts:l.ts,miss:[...new Set(miss)]});
  lastAny.set(mint,{ts:l.ts,miss:miss.length, n:(lastAny.get(mint)?.n??0)+1, missN:(lastAny.get(mint)?.missN??0)+(miss.length?1:0)});
}
for (const [m,f] of first) { const c=cs.get(m); const la=lastAny.get(m);
  console.log(m.slice(0,8), 'mig', new Date(c.migrationTime*1000).toISOString(), 'firstMissing', f.ts, f.miss.join(','), '| rejects', la.n, 'withMissing', la.missN, 'lastHasMissing', la.miss>0); }
