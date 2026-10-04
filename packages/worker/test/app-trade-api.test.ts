// APP-TRADE: the open trade's price now, its P&L net of every fee paid so far, and Discovered's liquidity before the
// pool's fee terms are known. The P&L has one definition (api.ts openPnl); a closed trade's net is the same sum.
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { openPnl, pnlMicroUsd, priceText, route, usdText } from '../src/run/api.ts';
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
    const net = o.liquidation! - p.cost - fees;
    expect(pos!['pnlUsd']).toBe(usdText(pnlMicroUsd(net, inputs.solPrice!)));
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
