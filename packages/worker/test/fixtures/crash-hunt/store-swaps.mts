// Retained heap per pool swap in the live AsOfStore (liveRetention/liveCollapse/liveShape/liveForget at 5efb9ae0 = HEAD for
// these files), using real mainnet swap logs (swaps.json) passed through eventsOfFrame and deepFreeze as the LiveFeed does.
// Mode 'live': tails as on mainnet now. Mode 'zero': the same logs with the 8 tail bytes zeroed (what the fixtures had).
import { readFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { AsOfStore } from '/home/user/wt-crash/packages/core/src/engine/asof.ts';
import { deepFreeze } from '/home/user/wt-crash/packages/core/src/engine/freeze.ts';
import { liveRetention, liveCollapse, liveShape, liveForget } from '/home/user/wt-crash/packages/worker/src/run/store-rules.ts';
import { eventsOfFrame } from '/home/user/wt-crash/packages/worker/src/providers/canonical.ts';
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const mode = process.argv[2] ?? 'live';
const N = Number(process.argv[3] ?? 30000);
const swaps: { signature: string; slot: number; logs: string[] }[] = JSON.parse(readFileSync('/tmp/claude-0/-home-user/d5c7ba26-609b-51db-bbda-9009df99229c/scratchpad/crash-hunt/final/swaps.json', 'utf8'));
// zero mode: rewrite the pump_amm 'Program data:' payloads with the last 8 bytes zeroed
const zeroTail = (line: string): string => {
  if (!line.startsWith('Program data: ')) return line;
  const b = Buffer.from(line.slice(14), 'base64');
  if (b.length < 16) return line;
  b.fill(0, b.length - 8);
  return `Program data: ${b.toString('base64')}`;
};
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sig = (i: number) => { let s = ''; let x = i * 2654435761 + 12345; for (let k = 0; k < 88; k++) { s += B58[(x + k * 7) % 58]; x = (x * 1103515245 + 12345) >>> 0; } return s; };
let now = { slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: 1_759_700_000_000 };
const clock = { now: () => now };
const TRADE = /^(?:logs:)?(pump_amm):(?:BuyEvent|SellEvent):|^(?:logs:)?(pump):TradeEvent:/;
// scratch fix: a trade key keeps its newest entry and only its EARLIEST failing entry
const fixedCollapse = (key: string) => { const t = liveCollapse(key); if (t === null || !TRADE.test(key)) return t; let kept = false; return (older: any) => { if (kept) return false; if (!t(older)) return false; kept = true; return true; }; };
const store = new AsOfStore(clock, liveRetention, process.env.FIX === '1' ? fixedCollapse : liveCollapse, liveShape, liveForget);
const ranks = { get: () => 0 };
gc(); gc();
const before = process.memoryUsage().heapUsed;
let events = 0;
for (let i = 0; i < N; i++) {
  const s = swaps[i % swaps.length]!;
  const slot = 453_000_000n + BigInt(i);
  const receivedAt = 1_759_700_000_000 + i * 20;
  // the socket hands over freshly parsed strings each time
  const msg = JSON.parse(JSON.stringify({ signature: sig(i), logs: mode === 'zero' ? s.logs.map(zeroTail) : s.logs }));
  const frame = Object.freeze({ seq: i, receivedAt, source: 'helius' as const, backfilled: false, duplicate: false, place: Object.freeze({ at: 'chain' as const, slot }), body: Object.freeze({ type: 'logs' as const, signature: msg.signature, slot, err: null, via: 'logs:POOLPOOLPOOLPOOLPOOLPOOLPOOLPOOLPOOLPOOL', logs: msg.logs, commitment: 'confirmed' as const }) });
  now = { slot, txIndex: Number.MAX_SAFE_INTEGER, ixIndex: Number.MAX_SAFE_INTEGER, receivedAt };
  for (const e of eventsOfFrame(frame as any, ranks as any)) {
    const ev = deepFreeze(e) as any;
    store.record(ev.key, ev.value, ev.moment, ev.id);
    events++;
  }
}
gc(); gc();
const after = process.memoryUsage().heapUsed;
const sz = store.sizes();
const tradeKeys = [...sz.byPrefix].filter(([k]) => k.startsWith('logs:pump_amm'));
console.log(JSON.stringify({ mode, notices: N, events, keys: sz.keys, entries: sz.entries, tradeKinds: tradeKeys, retainedMB: +((after - before) / 1048576).toFixed(1), bytesPerEntry: Math.round((after - before) / sz.entries) }));
(globalThis as any).keep = store;
if (process.argv[4] === 'keys') {
  const counts = new Map<string, number>();
  for (const s of swaps) {
    const msg = { signature: sig(1), logs: s.logs };
  }
  // per key entry count through history()
  const all = (store as any);
  const keys: string[] = [];
  for (const s of swaps) for (const e of eventsOfFrame({ seq: 0, receivedAt: 0, source: 'helius', backfilled: false, duplicate: false, place: { at: 'chain', slot: 1n }, body: { type: 'logs', signature: sig(1), slot: 1n, err: null, via: 'logs:x', logs: s.logs, commitment: 'confirmed' } } as any, ranks as any)) keys.push(e.key);
  for (const k of new Set(keys)) { const h = store.history(k, { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 }) as any[]; counts.set(k.replace(/:[1-9A-HJ-NP-Za-km-z]{32,44}$/, ':<pool>'), (counts.get(k.replace(/:[1-9A-HJ-NP-Za-km-z]{32,44}$/, ':<pool>')) ?? 0) + h.length); }
  console.log([...counts]);
}
