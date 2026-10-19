// Step 6: 1-minute bars (price in SOL) for each candidate entry in data/need.json [{pool, T}], covering
// [T, T + 130 min]. Entries of one pool within ~14 h share one call. Never a bar ending after the wall.
import fs from 'node:fs';
import { gt, DATA, WALL_S } from './lib.mjs';
const need = JSON.parse(fs.readFileSync(DATA + (process.argv[2] || 'need.json')));
const MD = DATA + 'm1/'; fs.mkdirSync(MD, { recursive: true });
const byPool = new Map();
for (const e of need) { if (!byPool.has(e.pool)) byPool.set(e.pool, []); byPool.get(e.pool).push(e.T); }
let calls = 0, n = 0;
for (let [pool, Ts] of byPool) {
  Ts.sort((a, b) => a - b);
  const f = MD + pool + '.json';
  const have = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : [];
  const sf = MD + pool + '.spans.json';
  const old = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf)) : [];
  const todo = Ts.filter(T => !old.some(([a, z]) => a <= T && Math.min(T + 7800, WALL_S) <= z));
  if (!todo.length) continue;
  Ts = todo;
  let bars = have, spans = [];
  let i = 0;
  while (i < Ts.length) {
    const first = Ts[i]; let j = i;
    while (j + 1 < Ts.length && Ts[j + 1] + 7800 - first <= 990 * 60) j++;
    const before = Math.min(Ts[j] + 7800, WALL_S) - 1;
    const r = await gt(`/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&currency=token&token=base&before_timestamp=${before}`); calls++;
    const l = r?.data?.attributes?.ohlcv_list;
    if (!l) { console.log('err', pool, JSON.stringify(r).slice(0, 150)); i = j + 1; continue; }
    bars = bars.concat(l.filter(b => b[0] + 60 <= WALL_S));
    spans.push([before + 1 - 1000 * 60, before + 1]);
    i = j + 1;
  }
  bars = [...new Map(bars.map(b => [b[0], b])).values()].sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(f, JSON.stringify(bars));
  fs.writeFileSync(sf, JSON.stringify(old.concat(spans)));
  if (++n % 10 === 0) console.log(new Date().toISOString(), 'pools', n, '/', byPool.size, 'calls', calls);
}
console.log('done pools', n, 'calls', calls);
