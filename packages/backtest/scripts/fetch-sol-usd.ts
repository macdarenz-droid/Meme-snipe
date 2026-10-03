// Fetches hourly SOL-USD candles from Coinbase Exchange's public market-data API (no key) into the off-chain series
// format (src/dataset/offchain.ts). Closed exchange candles do not change, so the series is tagged "fixed".
// Usage: node packages/backtest/scripts/fetch-sol-usd.ts <from YYYY-MM-DD> <to-exclusive YYYY-MM-DD> <out.csv>
import { writeFileSync } from 'node:fs';

const [from, to, out] = process.argv.slice(2);
if (!from || !to || !out) throw new Error('usage: fetch-sol-usd.ts <from> <to-exclusive> <out.csv>');
const HOUR = 3_600_000;
const start = Date.parse(`${from}T00:00:00Z`);
const end = Date.parse(`${to}T00:00:00Z`);
const fetchedAt = Date.now();
const bars = new Map<number, string>();
for (let t = start; t < end; t += 300 * HOUR) {
  const stop = Math.min(t + 300 * HOUR, end);
  const url = `https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=3600&start=${new Date(t).toISOString()}&end=${new Date(stop - 1).toISOString()}`;
  const res = await fetch(url, { headers: { 'user-agent': 'zeroed-backtest' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // [time, low, high, open, close, volume], newest first. Read from the raw text so the close keeps its exact digits
  // (a JS number could round it).
  const text = await res.text();
  const NUM = '(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)';
  const candle = new RegExp(`\\[\\s*(\\d+)\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*\\]`, 'g');
  for (const m of text.matchAll(candle)) {
    const time = Number(m[1]);
    const close = m[5]!;
    if (!/^\d+(\.\d+)?$/.test(close)) throw new Error(`close "${close}" is not a plain decimal`);
    const ms = time * 1000;
    // Only closed candles: a candle still open at fetch time would change, so it is not a fixed value.
    if (ms >= start && ms < end && ms + HOUR <= fetchedAt) bars.set(ms, close);
  }
  await new Promise((r) => setTimeout(r, 400));
}
const rows = [...bars.entries()].sort((a, b) => a[0] - b[0]).map(([ms, c]) => `${new Date(ms).toISOString()},${c}`);
const expected = (Math.min(end, Math.floor(fetchedAt / HOUR) * HOUR) - start) / HOUR;
writeFileSync(out, [
  '# name: SOL/USD',
  '# source: Coinbase Exchange SOL-USD 1h candles, close (api.exchange.coinbase.com/products/SOL-USD/candles)',
  '# tag: fixed',
  `# bar_ms: ${HOUR}`,
  `# fetched_at: ${new Date(fetchedAt).toISOString()}`,
  `# bars: ${rows.length} of ${expected} hours (a missing hour had no trades; the previous close stays in force)`,
  'start,close',
  ...rows,
  '',
].join('\n'));
console.log(`${rows.length} of ${expected} hourly bars written to ${out}`);
