import { studyWorld } from '/home/user/Meme-snipe/packages/backtest/test/study-world.ts';
const { rows, mints } = studyWorld({ mints: [{ label: 'good', createSlot: 10, graduateAfter: 20 * 150, devBuyBps: 300, devDelegate: 1000n }], slots: 10 + 92 * 150 });
const raws = rows.filter((r) => r.kind === 'raw');
console.log(JSON.stringify(raws[0], (k, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 1500));
console.log(JSON.stringify(raws[0]!.ops.at(-1), (k, v) => typeof v === 'bigint' ? v.toString() : v));
import { FactProjector } from '/home/user/Meme-snipe/packages/backtest/src/sim/facts.ts';
import { RUG_CONFIG } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
const f = new FactProjector({ sampleRate: 1, rugs: RUG_CONFIG, windows: [], solUsd: [], solUsdPoints: 30, candlesHead: 10, candlesTail: 360, tieSalt: 's' });
const m = { slot: 0n, receivedAt: 0, seq: 0 } as never;
for (const r of rows.slice(0, 40)) { try { (f as any).project?.(r, m); } catch (e) {} }
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(f)));
