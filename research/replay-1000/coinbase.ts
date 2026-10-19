// REPLAY-1000: Coinbase SOL-USD history for the replay's ticker and hourly bars (public REST, no key).
//   node research/replay-1000/coinbase.ts trades <fromIso> <toIso>   every trade (time, price) in the range
//   node research/replay-1000/coinbase.ts candles <fromIso> <toIso>  hourly candles in the range
// Trades are paged back by trade id (`after`), newest first, and stored oldest first.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readZ, writeZ } from './rpc.ts';
import type { CoinbaseTrade } from './world/ws-world.ts';

const BASE = 'https://api.exchange.coinbase.com/products/SOL-USD';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const TRADES_FILE = join(DATA_DIR, 'coinbase-trades.json.zst');
export const CANDLES_FILE = join(DATA_DIR, 'coinbase-candles-3600.json.zst');

const get = async (url: string): Promise<{ body: unknown; after: string | null }> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = await fetch(url, { headers: { 'user-agent': 'zeroed-replay' } });
    if (r.status === 429 || r.status >= 500) {
      await sleep(1_000 * (attempt + 1));
      continue;
    }
    if (r.status !== 200) throw new Error(`${url}: HTTP ${r.status}`);
    return { body: await r.json(), after: r.headers.get('cb-after') };
  }
  throw new Error(`${url}: gave up`);
};

export const loadTrades = (dir?: string): CoinbaseTrade[] => {
  const f = dir === undefined ? TRADES_FILE : join(dir, 'coinbase-trades.json.zst');
  return existsSync(f) ? (readZ(f) as CoinbaseTrade[]) : [];
};
export const loadCandles = (dir?: string): number[][] => {
  const f = dir === undefined ? CANDLES_FILE : join(dir, 'coinbase-candles-3600.json.zst');
  return existsSync(f) ? (readZ(f) as number[][]) : [];
};

const main = async () => {
  const [cmd, fromIso, toIso] = process.argv.slice(2);
  const from = Date.parse(fromIso!);
  const to = Date.parse(toIso!);
  if (cmd === 'trades') {
    const out: CoinbaseTrade[] = [];
    let after: string | null = null;
    for (let n = 1; ; n++) {
      const { body, after: next } = await get(`${BASE}/trades?limit=1000${after === null ? '' : `&after=${after}`}`);
      const rows = body as { time: string; price: string; trade_id: number }[];
      if (rows.length === 0) break;
      for (const r of rows) {
        const t = Date.parse(r.time);
        if (t >= from && t <= to) out.push({ t, price: r.price });
      }
      after = next;
      const oldest = Date.parse(rows.at(-1)!.time);
      if (n % 50 === 0) console.error(`trades: ${n} pages, at ${rows.at(-1)!.time}, kept ${out.length}`);
      if (oldest < from || after === null) break;
      await sleep(120);
    }
    out.sort((a, b) => a.t - b.t);
    writeZ(TRADES_FILE, out);
    console.error(`trades: ${out.length} from ${new Date(out[0]?.t ?? 0).toISOString()} to ${new Date(out.at(-1)?.t ?? 0).toISOString()}`);
    return;
  }
  if (cmd === 'candles') {
    const rows: number[][] = [];
    for (let s = from; s < to; s += 300 * 3_600_000) {
      const e = Math.min(to, s + 300 * 3_600_000);
      const { body } = await get(`${BASE}/candles?granularity=3600&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`);
      rows.push(...(body as number[][]));
      await sleep(200);
    }
    const uniq = [...new Map(rows.map((r) => [r[0]!, r])).values()].sort((a, b) => a[0]! - b[0]!);
    writeZ(CANDLES_FILE, uniq);
    console.error(`candles: ${uniq.length}`);
    return;
  }
  throw new Error('usage: coinbase.ts trades|candles <fromIso> <toIso>');
};

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
void readFileSync;
