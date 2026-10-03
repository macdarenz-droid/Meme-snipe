import { simulateG2Power } from '../src/stats/index.ts';
import { bracketTrades } from './stats-fixtures.ts';
const own = (ts: { day: string; rNet: number }[]) => ts.map(({ day, rNet }, i) => ({ day, rNet, creatorCluster: `c${i}`, funderCluster: `f${i}` }));
const wf = own(bracketTrades(801, 0, 80, 5));
const control = bracketTrades(802, -0.3, 80, 5).map(({ day, rNet }) => ({ day, rNet }));
console.time('p');
const r = simulateG2Power({ walkForward: wf, control, seed: 1, simulations: 100, replicates: 400, familySize: 1 });
console.timeEnd('p'); console.log(r.nPower, r.evaluations.length);
