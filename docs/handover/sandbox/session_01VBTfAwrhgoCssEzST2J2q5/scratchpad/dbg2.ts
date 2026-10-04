import { studyWorld } from '/home/user/Meme-snipe/packages/backtest/test/study-world.ts';
import { FactProjector } from '/home/user/Meme-snipe/packages/backtest/src/sim/facts.ts';
import { Market } from '/home/user/Meme-snipe/packages/backtest/src/sim/market.ts';
import { RUG_CONFIG } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
const { rows, mints } = studyWorld({ mints: [{ label: 'good', createSlot: 10, graduateAfter: 20 * 150, devBuyBps: 300, devDelegate: 1000n }], slots: 10 + 92 * 150 });
const facts = new FactProjector({ sampleRate: 1, rugs: RUG_CONFIG, windows: [], solUsd: [], solUsdPoints: 30, candlesHead: 10, candlesTail: 360, tieSalt: 's' });
const market = new Market({ heartbeatBlocks: 1_000_000, discoveryLag: () => 1, active: () => false, schedule: () => {}, facts });
let n = 0;
for (const r of rows) { market.release(r); if (r.kind === 'raw' && n++ < 2) { const st = facts.state(mints[0]!.mint) as any; console.log(r.signature.slice(0,6), st?.holders ? [...st.holders.values()].map((h: any) => h.delegate) : st); } }
const st = facts.state(mints[0]!.mint) as any; console.log('end', st?.holders ? [...st.holders.values()].filter((h: any) => h.delegate).length : st, st?.holderProblem);
