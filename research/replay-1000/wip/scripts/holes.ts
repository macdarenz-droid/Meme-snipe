// Classifies every creates-watch hole (a create-authority transaction whose log the bot reads as cut or undecodable)
// by what its fetched transaction gives the bot, with the bot's own decoders (core logEvents / transactionEvents).
import { loadIndex } from '/home/user/replay-957/research/replay-1000/coins.ts';
import { DATA_DIR, PublicRpc } from '/home/user/replay-957/research/replay-1000/rpc.ts';
import { logEvents, recordFromRpc, transactionEvents } from '/home/user/replay-957/packages/core/src/chain/index.ts';
const [fromIso, toIso] = process.argv.slice(2);
const a = Date.parse(fromIso!) / 1000, b = Date.parse(toIso!) / 1000;
const rpc = new PublicRpc([], DATA_DIR);
const idx = loadIndex().filter((x) => (x.blockTime ?? 0) >= a && (x.blockTime ?? 0) < b);
const kinds = ['heals: create event', 'heals: other events, no create', 'open: no events at all', 'open: tx undecodable', 'open: never returned'] as const;
const per: Record<string, Record<string, number>> = {};
const tot: Record<string, number> = {};
let scanned = 0, holes = 0, failedTx = 0, notCached = 0;
const examples: Record<string, string> = {};
for (const s of idx) {
  let t: { meta: { logMessages?: string[]; err: unknown } } | null = null;
  try { t = (await rpc.tx(s.signature)) as never; } catch { notCached++; continue; }
  scanned++;
  if (t === null) { notCached++; continue; }
  let cut = false;
  try { cut = logEvents(t.meta.logMessages ?? [], t.meta.err as never).truncated === true; } catch { cut = true; }
  if (!cut) continue;
  holes++;
  if (t.meta.err !== null) failedTx++;
  let kind: (typeof kinds)[number];
  try {
    const ev = transactionEvents(recordFromRpc(s.signature, t as never) as never) as unknown as { name: string }[];
    kind = ev.some((e) => e.name === 'CreateEvent') ? kinds[0] : ev.length > 0 ? kinds[1] : kinds[2];
  } catch { kind = kinds[3]; }
  const h = new Date(s.blockTime! * 1000).toISOString().slice(0, 13);
  per[h] ??= {}; per[h][kind] = (per[h][kind] ?? 0) + 1;
  tot[kind] = (tot[kind] ?? 0) + 1;
  examples[kind] ??= s.signature;
}
console.log(JSON.stringify({ window: [fromIso, toIso], scanned, holes, failedTxAmongHoles: failedTx, notCachedOrNull: notCached, totals: tot, examples }));
for (const h of Object.keys(per).sort()) console.log(h, JSON.stringify(per[h]));
