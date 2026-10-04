import { bracketTrades } from '/home/user/Meme-snipe/packages/core/test/stats-fixtures.ts';
const dry = bracketTrades(41, 0.1, 2, 30).map((t) => t.rNet);
const rank = [...dry].sort((x, y) => x - y);
const fc = dry.map((x) => `k${Math.min(2, Math.floor((3 * rank.indexOf(x)) / dry.length))}`);
const m = new Map<string, number>(); for (const c of fc) m.set(c, (m.get(c) ?? 0) + 1);
console.log(dry.length, [...m], new Set(dry).size);
