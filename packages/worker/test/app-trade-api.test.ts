// APP-TRADE: the open trade's price now, its P&L net of every fee paid so far, and Discovered's liquidity before the
// pool's fee terms are known. The P&L has one definition (api.ts openPnl); a closed trade's net is the same sum.
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { openPnl, openUsd, pnlMicroUsd, priceText, route, usdText } from '../src/run/api.ts';
import { toMicro } from '../../../apps/web/src/lib/money.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import type { MicroUsd } from '../../core/src/units/index.ts';
import { MINT, makeWorker, passingMarket } from './worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;

const fill = (purpose: 'entry' | 'exit', sol: bigint, fees: bigint): PaperAttempt =>
  ({ purpose, trade: 'p1', outcome: 'filled', fill: { sol, fees, tokens: 1n } }) as unknown as PaperAttempt;

describe('the open trade\'s P&L (APP-TRADE)', () => {
  it('is the rest\'s liquidation value plus exits sold, less the entry and every network fee, exactly', () => {
    // A gain: bought for 1 SOL (5000 lamports fee), the rest now sells for 1.2 SOL.
    expect(openPnl(1_200_000_000n, [fill('entry', 1_000_000_000n, 5_000n)])).toEqual({ gross: 200_000_000n, fees: 5_000n, net: 199_995_000n });
    // A loss, and a partial exit already sold: its proceeds and its fee count.
    expect(openPnl(300_000_000n, [fill('entry', 1_000_000_000n, 5_000n), fill('exit', 500_000_000n, 7_000n)])).toEqual({ gross: -200_000_000n, fees: 12_000n, net: -200_012_000n });
    // Flat before fees is a loss of the fees, never zero.
    expect(openPnl(1_000n, [fill('entry', 1_000n, 1n)]).net).toBe(-1n);
    // A rest that cannot be quoted counts as worth nothing (the safe side); fills not filled do not count.
    const failed = { ...fill('exit', 9n, 9n), fill: null } as unknown as PaperAttempt;
    expect(openPnl(null, [fill('entry', 10n, 1n), failed])).toEqual({ gross: -10n, fees: 1n, net: -11n });
    // Big sizes stay exact (no floats).
    expect(openPnl(10n ** 18n + 1n, [fill('entry', 10n ** 18n, 3n)]).net).toBe(-2n);
  });

  it('the three rows round one way and P&L is their exact difference: a loss at a cent boundary (review N2)', () => {
    const price = 150_000_000n as MicroUsd; // $150 per SOL: a lamport is 0.15 micro-dollars
    // Gross −33,334 lamports is −$0.0050001; fees 33,333 lamports are $0.00499995.
    const usd = openUsd({ gross: -33_334n, fees: 33_333n, net: -66_667n }, price);
    expect(usd).toEqual({ unrealized: -5_001n, costs: 5_000n, pnl: -10_001n });
    // Rounded toward zero, the rows would be −$0.005000 and $0.004999, and P&L −$0.010001 would not be their difference.
    expect(usd.pnl).toBe(usd.unrealized - usd.costs);
    // A lamport each way: Unrealized −$0.000001, Costs $0.000001, so P&L −$0.000002 (rounding the net alone gives −$0.000001).
    expect(openUsd({ gross: -1n, fees: 1n, net: -2n }, price)).toEqual({ unrealized: -1n, costs: 1n, pnl: -2n });
    // A gain rounds down; costs round up.
    expect(openUsd({ gross: 33_334n, fees: 1n, net: 33_333n }, price)).toEqual({ unrealized: 5_000n, costs: 1n, pnl: 4_999n });
  });

  it('in dollars rounds like a closed trade: gains down, losses up', () => {
    const price = 150_000_000n as MicroUsd; // $150 per SOL
    expect(pnlMicroUsd(1n, price)).toBe(0n); // 0.00000015 dollars, down
    expect(pnlMicroUsd(-1n, price)).toBe(-1n); // a loss rounds up to a whole micro-dollar
    expect(pnlMicroUsd(1_000_000_000n, price)).toBe(150_000_000n);
  });

  it('a real worker serves the mark, when it was read, and the P&L, which the app\'s schema accepts; a closed trade\'s net is the same sum', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    const inputs = h.worker.apiInputs();
    const r = route(PATHS.position('paper'), () => inputs);
    const pos = checkEnvelope(JSON.parse(JSON.stringify(r.body)), 'paper', schemaFor('position', 'paper')).data as Record<string, string | null> | null;
    expect(pos).not.toBeNull();
    const p = Object.values(inputs.book.positions).find((x) => x.status === 'open')!;
    const o = inputs.open(p)!;
    expect(o.liquidation).not.toBeNull();
    const fills = [...inputs.attempts.values()].filter((a) => a.trade === p.id && a.outcome === 'filled');
    const fees = fills.reduce((s, a) => s + a.fill!.fees, 0n);
    expect(fees).toBeGreaterThan(0n);
    const gross = o.liquidation! - p.cost;
    expect(pos!['unrealizedUsd']).toBe(usdText(pnlMicroUsd(gross, inputs.solPrice!)));
    expect(pos!['costsSoFarUsd']).toBe(usdText(-pnlMicroUsd(-fees, inputs.solPrice!)));
    // P&L = Unrealized − Costs so far, exactly (review N2), at SOL prices that leave fractions of a micro-dollar.
    expect(toMicro(pos!['pnlUsd']!)).toBe(toMicro(pos!['unrealizedUsd']!) - toMicro(pos!['costsSoFarUsd']!));
    for (const solPrice of [150_000_001n, 123_456_789n, 7n, 1_000_003n] as MicroUsd[]) {
      const at = (route(PATHS.position('paper'), () => ({ ...inputs, solPrice })).body as { data: Record<string, string> }).data;
      expect(toMicro(at['pnlUsd']!), String(solPrice)).toBe(toMicro(at['unrealizedUsd']!) - toMicro(at['costsSoFarUsd']!));
    }
    expect(pos!['markPriceUsd']).toBe(priceText(o.liquidation!, p.quantity, inputs.solPrice));
    expect(pos!['markedAt']).toBe(new Date(h.worker.poolOf(MINT)!.atMs).toISOString());
    expect(o.markedAtMs).toBe(h.worker.poolOf(MINT)!.atMs);

    // No SOL price: no P&L and no mark, never a made-up zero.
    const noPrice = (route(PATHS.position('paper'), () => ({ ...inputs, solPrice: null })).body as { data: Record<string, unknown> }).data;
    expect(noPrice).toMatchObject({ pnlUsd: null, markPriceUsd: null, markedAt: null });
    // The rest cannot be quoted: no mark.
    const noQuote = (route(PATHS.position('paper'), () => ({ ...inputs, open: (q) => ({ ...inputs.open(q)!, liquidation: null }) })).body as { data: Record<string, unknown> }).data;
    expect(noQuote).toMatchObject({ markPriceUsd: null, markedAt: null });

    // The price falls through the stop and the trade closes: account.ts's net is openPnl of its fills with nothing left.
    await m.run(6_000, 400, () => { m.slot(); m.pool(700_000n); });
    const after = h.worker.apiInputs();
    const closed = after.trades.find((t) => t.closedAtMs !== null)!;
    const closedFills = [...after.attempts.values()].filter((a) => a.trade === closed.positionId && a.outcome === 'filled');
    expect(closedFills.map((a) => a.purpose)).toEqual(['entry', 'exit']);
    expect(openPnl(0n, closedFills).net).toBe(closed.netLamports);
    await h.worker.stop();
  });
});

describe('Unrealized after a partial exit (APP-TRADE, review N1)', () => {
  it('counts what the partial sold for: openPnl\'s gross, not the rest\'s value less the whole entry', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    // +15%: past 1.5R, so the first partial sells half and the rest stays open.
    await m.run(8_000, 400, () => { m.slot(); m.pool(1_150_000n); });
    const inputs = h.worker.apiInputs();
    const p = Object.values(inputs.book.positions).find((x) => x.status === 'open')!;
    expect(p.sold > 0n && p.quantity > 0n).toBe(true);
    const fills = [...inputs.attempts.values()].filter((a) => a.trade === p.id && a.outcome === 'filled');
    expect(fills.map((a) => a.purpose)).toEqual(['entry', 'exit']);
    const liq = inputs.open(p)!.liquidation!;
    const pos = checkEnvelope(JSON.parse(JSON.stringify(route(PATHS.position('paper'), () => inputs).body)), 'paper', schemaFor('position', 'paper')).data as Record<string, string>;
    const gross = openPnl(liq, fills).gross;
    expect(gross).toBe(liq + fills[1]!.fill!.sol - p.cost);
    expect(pos['unrealizedUsd']).toBe(usdText(pnlMicroUsd(gross, inputs.solPrice!)));
    // The old rows (the rest's value less the whole entry) read a large loss here; the served one does not.
    expect(pos['unrealizedUsd']).not.toBe(usdText(pnlMicroUsd(liq - p.cost, inputs.solPrice!)));
    expect(toMicro(pos['pnlUsd']!)).toBe(toMicro(pos['unrealizedUsd']!) - toMicro(pos['costsSoFarUsd']!));
    await h.worker.stop();
  });
});

describe('Discovered liquidity (APP-TRADE)', () => {
  it('shows once the pool is read, before its fee terms are known (no swap seen yet)', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    await passingMarket(h, { fees: false });
    expect(h.worker.poolOf(MINT)).toBeNull();
    const tok = h.worker.apiInputs().discovered.find((t) => t.mint === MINT)!;
    expect(tok.quoteReserve).not.toBeNull();
    expect(tok.quoteReserve! > 0n).toBe(true);
    await h.worker.stop();
  });
});
