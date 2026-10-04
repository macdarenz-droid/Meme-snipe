import { it, expect } from 'vitest';
import { item4 } from '../../../../../home/user/Meme-snipe/packages/runner/src/item4.ts';
const L = (o: Record<string, unknown>) => ({ seq: 1, ts: 'x', boot: 'b', kind: 'simulation', trade: 't', leg: 'entry', success: true, outcome: 'simulated', amountErrorE4: 0, ...o }) as never;
it('probe', () => {
  const a = item4([...Array.from({ length: 19 }, () => L({})), ...Array.from({ length: 5 }, () => L({ outcome: 'bogus', success: false })), L({ outcome: undefined, success: false })], 'vps', false);
  const b = item4([...Array.from({ length: 19 }, () => L({})), L({ amountErrorE4: -999999 })], 'vps', false);
  const c = item4([...Array.from({ length: 19 }, () => L({})), L({ amountErrorE4: 1.5e-9 })], 'vps', false);
  console.log(JSON.stringify({ a: [a.trades, a.pass], b: [b.bounds.each, b.pass], c: c.pass }));
  expect(1).toBe(1);
});
