import { loadIndex } from '/home/user/Meme-snipe/research/replay-1000/coins.ts';
import { DATA_DIR, PublicRpc } from '/home/user/Meme-snipe/research/replay-1000/rpc.ts';
const [fromIso, toIso] = process.argv.slice(2);
const a = Date.parse(fromIso!) / 1000, b = Date.parse(toIso!) / 1000;
const rpc = new PublicRpc([], DATA_DIR);
const idx = loadIndex().filter((x) => x.err === null && (x.blockTime ?? 0) >= a && (x.blockTime ?? 0) < b);
let cut = 0, miss = 0, n = 0;
const perHour: Record<string, [number, number]> = {};
for (const s of idx) {
  let t: { meta: { logMessages?: string[] } } | null = null;
  try { t = (await rpc.tx(s.signature)) as never; } catch { miss++; continue; }
  if (t === null) { miss++; continue; }
  n++;
  const h = new Date(s.blockTime! * 1000).toISOString().slice(0, 13);
  perHour[h] ??= [0, 0]; perHour[h][1]++;
  if ((t.meta.logMessages ?? []).some((l) => l.includes('Log truncated'))) { cut++; perHour[h][0]++; }
}
console.log(JSON.stringify({ creates: n, cut, notCached: miss, perHour }));
