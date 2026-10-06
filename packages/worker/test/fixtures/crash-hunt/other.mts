import { readFileSync } from 'node:fs';
import { logEvents } from '/home/user/wt-crash/packages/core/src/chain/transaction.ts';
const swaps = JSON.parse(readFileSync('/tmp/claude-0/-home-user/d5c7ba26-609b-51db-bbda-9009df99229c/scratchpad/crash-hunt/final/swaps.json', 'utf8'));
const t = new Map<string, number>();
for (const s of swaps) for (const e of logEvents(s.logs, null).events as any[]) { const k = `${e.program}:${e.name}${e.name === 'other' ? ':' + e.discriminator : ''}`; t.set(k, (t.get(k) ?? 0) + 1); }
console.log(swaps.length, [...t]);
