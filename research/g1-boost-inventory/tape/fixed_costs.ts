// Prints the fixed costs per filled round trip exactly as packages/backtest/src/research/edge-costs.ts charges them.
//   cd research/g1-boost-inventory/tape && node --no-warnings fixed_costs.ts > fixed_costs.json
import { terms, expectedFailedExits, expectedFixed, rentBack } from '../../../packages/backtest/src/research/edge-costs.ts';
const big = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
console.log(JSON.stringify({ source: 'packages/backtest/src/research/edge-costs.ts', terms: big(terms), expectedFailedExits: expectedFailedExits(), rentBack, expectedFixedLamports: expectedFixed() }, null, 1));
