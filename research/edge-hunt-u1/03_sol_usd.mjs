// SOL/USD hourly closes (Raydium SOL/USDC pool on GeckoTerminal), only bars that end at or before the wall.
import fs from 'node:fs';
import { gt, DATA, WALL_S } from './lib.mjs';
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const T0 = Date.parse('2026-07-15T00:00:00Z') / 1000;
let before = WALL_S - 1, bars = [];
while (before > T0) {
  const r = await gt(`/networks/solana/pools/${POOL}/ohlcv/hour?aggregate=1&limit=1000&before_timestamp=${before}`);
  const l = r?.data?.attributes?.ohlcv_list;
  if (!l?.length) { console.log('err', JSON.stringify(r).slice(0, 200)); break; }
  bars.push(...l); before = Math.min(...l.map(b => b[0])) - 1;
}
bars = [...new Map(bars.filter(b => b[0] + 3600 <= WALL_S && b[0] >= T0).map(b => [b[0], b])).values()].sort((a, b) => a[0] - b[0]);
fs.writeFileSync(DATA + 'sol_usd_hour.json', JSON.stringify(bars));
console.log(bars.length, new Date(bars[0][0] * 1000).toISOString(), new Date(bars.at(-1)[0] * 1000).toISOString(), 'min', Math.min(...bars.map(b => b[3])), 'max', Math.max(...bars.map(b => b[2])));
