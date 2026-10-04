// APP-TRADE: the open trade's price now, its P&L net of every fee paid so far, and Discovered's liquidity before the
// pool's fee terms are known. The P&L has one definition (api.ts openPnl); a closed trade's net is the same sum.
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import { closeFee, openPnl, openUsd, pnlMicroUsd, priceText, route, usdText } from '../src/run/api.ts';
import { toMicro } from '../../../apps/web/src/lib/money.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import type { MicroUsd } from '../../core/src/units/index.ts';
import { attemptFee } from '../../core/src/fills/index.ts';
import { attemptRung, nextExitRung } from '../../core/src/exits/index.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { lamports } from '../../core/src/units/index.ts';
import { closeRungOf } from '../src/engine/strategy.ts';
import { MINT, makeWorker, passingMarket } from './worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;

const fill = (purpose: 'entry' | 'exit', sol: bigint, fees: bigint): PaperAttempt =>
  ({ purpose, trade: 'p1', outcome: 'filled', fill: { sol, fees, tokens: 1n } }) as unknown as PaperAttempt;

describe('the open trade\'s P&L (APP-TRADE)', () => {
  it('is the rest\'s liquidation value plus exits sold, less the entry and every network fee, exactly', () => {
    // A gain: bought for 1 SOL (5000 lamports fee), the rest now sells for 1.2 SOL.
    expect(openPnl(1_200_000_000n, [fill('entry', 1_000_000_000n, 5_000n)], 0n)).toEqual({ gross: 200_000_000n, fees: 5_000n, net: 199_995_000n });
    // A loss, and a partial exit already sold: its proceeds and its fee count.
    expect(openPnl(300_000_000n, [fill('entry', 1_000_000_000n, 5_000n), fill('exit', 500_000_000n, 7_000n)], 0n)).toEqual({ gross: -200_000_000n, fees: 12_000n, net: -200_012_000n });
    // Flat before fees is a loss of the fees, never zero.
    expect(openPnl(1_000n, [fill('entry', 1_000n, 1n)], 0n).net).toBe(-1n);
    // A close costs its own network fee: the rest's value less that fee (review ruling a: net if closed now).
    expect(openPnl(1_200_000_000n, [fill('entry', 1_000_000_000n, 5_000n)], 25_000n)).toEqual({ gross: 199_975_000n, fees: 5_000n, net: 199_970_000n });
    // A rest that cannot be quoted counts as worth nothing (the safe side); fills not filled do not count.
    const failed = { ...fill('exit', 9n, 9n), fill: null } as unknown as PaperAttempt;
    expect(openPnl(null, [fill('entry', 10n, 1n), failed], 0n)).toEqual({ gross: -10n, fees: 1n, net: -11n });
    expect(openPnl(null, [fill('entry', 10n, 1n)], 3n)).toEqual({ gross: -13n, fees: 1n, net: -14n });
    // Big sizes stay exact (no floats).
    expect(openPnl(10n ** 18n + 1n, [fill('entry', 10n ** 18n, 3n)], 0n).net).toBe(-2n);
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
    // The close's own fee: base + tip + the first rung's priority fee (no exit attempt yet), as a filled exit pays.
    const fee = inputs.exitFee(p);
    expect(fee).toBe(attemptFee(FILL_CONFIG.network, BigInt(inputs.policy.exits.ladder.steps[0]!.priorityFeeLamports), 'filled'));
    expect(fee > 0n).toBe(true);
    const gross = o.liquidation! - fee - p.cost;
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

    // Nothing left to sell (all of it sold, the close not booked yet): no close to pay for.
    const empty = { ...inputs, book: { ...inputs.book, positions: { ...inputs.book.positions, [p.id]: { ...p, quantity: 0n as typeof p.quantity } } }, open: () => ({ ...o, liquidation: 0n }) };
    const emptyPos = (route(PATHS.position('paper'), () => empty).body as { data: Record<string, string> }).data;
    expect(emptyPos['unrealizedUsd']).toBe(usdText(pnlMicroUsd(-p.cost, inputs.solPrice!)));

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
    expect(openPnl(0n, closedFills, 0n).net).toBe(closed.netLamports);
    await h.worker.stop();
  });
});

describe('the close fee\'s rung (APP-TRADE follow-up): the rung the next exit attempt uses, as core\'s exit does', () => {
  it('one above the highest tried; the attempt count after a restart; held at the last rung', () => {
    expect(nextExitRung(null, 0, 2)).toBe(0);
    // An unfilled attempt at rung 0: the next goes at rung 1.
    expect(nextExitRung(0, 1, 2)).toBe(1);
    expect(nextExitRung(1, 2, 2)).toBe(2);
    expect(nextExitRung(2, 3, 2)).toBe(2);
    // A restart forgets the rung: two attempts made means at least rung 2.
    expect(nextExitRung(null, 2, 3)).toBe(2);
    // A rung skipped upward is not undone: rung 1 tried on the first attempt, the next goes at rung 2.
    expect(nextExitRung(1, 1, 3)).toBe(2);
  });

  it('a new exit owner with no signed attempt goes at its own start rung (a blocked retry\'s is the last); later attempts climb', () => {
    // Blocked after one attempt at rung 0: the retry owner starts at the last rung, though the next rung up would be 1.
    expect(attemptRung(0, 1, 3, { startRung: 3, signed: 0 })).toBe(3);
    expect(nextExitRung(0, 1, 3)).toBe(1);
    expect(attemptRung(0, 1, 3, { startRung: 9, signed: 0 })).toBe(3);
    // Once it has signed, the ladder climbs as before; with no owner known (a restart), as before.
    expect(attemptRung(3, 2, 3, { startRung: 3, signed: 1 })).toBe(3);
    expect(attemptRung(0, 1, 3, { startRung: 0, signed: 1 })).toBe(1);
    expect(attemptRung(0, 1, 3, null)).toBe(1);
  });

  it('closeRungOf: a live unsigned owner uses its start rung (a blocked retry\'s is the last), not the next rung up (EXIT review C1)', () => {
    // Blocked after one attempt at rung 0, the retry decided at the last rung, its first send not yet signed.
    expect(closeRungOf({ last: 3, status: 'exit_requested', lastRung: 0, used: 1, owner: { startRung: 3, signed: 0 } })).toBe(3);
    // Once signed, the next rung up from the highest tried (held at the last).
    expect(closeRungOf({ last: 3, status: 'exit_pending', lastRung: 3, used: 2, owner: { startRung: 3, signed: 1 } })).toBe(3);
    expect(closeRungOf({ last: 3, status: 'exit_pending', lastRung: 0, used: 1, owner: { startRung: 0, signed: 1 } })).toBe(1);
    // No owner: blocked retries at the last rung; otherwise the next rung up; no saved plan: the last rung.
    expect(closeRungOf({ last: 3, status: 'exit_blocked', lastRung: 0, used: 1, owner: null })).toBe(3);
    expect(closeRungOf({ last: 3, status: 'open', lastRung: 0, used: 1, owner: null })).toBe(1);
    expect(closeRungOf({ last: 3, status: 'open', lastRung: undefined, used: 0, owner: null })).toBe(3);
  });

  it('the fee: that rung\'s priority fee, capped at the per-attempt maximum', () => {
    const net = FILL_CONFIG.network;
    const ladder = { ...TRIAL_POLICY.exits.ladder, maxFeePerAttempt: lamports(100_000n) };
    const at = (fee: bigint) => attemptFee(net, fee, 'filled');
    expect(closeFee(ladder, net, 0)).toBe(at(20_000n));
    expect(closeFee(ladder, net, 1)).toBe(at(60_000n));
    // Rung 2's 150,000 and rung 3's 500,000 are capped at 100,000.
    expect(closeFee(ladder, net, 2)).toBe(at(100_000n));
    expect(closeFee(ladder, net, 3)).toBe(at(100_000n));
    expect(closeFee(TRIAL_POLICY.exits.ladder, net, 3)).toBe(at(500_000n));
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
    // One exit attempt went at the first rung, so the next close goes one rung up and pays that rung's fee (the follow-up).
    const ladder = inputs.policy.exits.ladder;
    expect(h.worker.strategy.saved()[p.id]!.tracker.lastRung).toBe(0);
    const fee = inputs.exitFee(p);
    expect(fee).toBe(attemptFee(FILL_CONFIG.network, BigInt(ladder.steps[1]!.priorityFeeLamports), 'filled'));
    expect(fee).toBeGreaterThan(attemptFee(FILL_CONFIG.network, BigInt(ladder.steps[0]!.priorityFeeLamports), 'filled'));
    const gross = openPnl(liq, fills, fee).gross;
    expect(gross).toBe(liq - fee + fills[1]!.fill!.sol - p.cost);
    // The worker reads the position's own tracker and attempt count: a remembered rung 2 means rung 3 next; a rung
    // forgotten (as after a restart that lost it) leaves the attempt count, 1, as the floor (test-only: the tracker is set here).
    const tracker = h.worker.strategy.saved()[p.id]!.tracker as { lastRung: number | null };
    tracker.lastRung = 2;
    expect(inputs.exitFee(p)).toBe(attemptFee(FILL_CONFIG.network, BigInt(ladder.steps[3]!.priorityFeeLamports), 'filled'));
    tracker.lastRung = null;
    expect(inputs.exitFee(p)).toBe(fee);
    tracker.lastRung = 0;
    // A position with no saved plan (unknown): the last rung, the dearest.
    expect(h.worker.strategy.closeRung('p:unknown', 'open', h.worker.book)).toBe(ladder.steps.length - 1);
    // Blocked: the last rung, the highest fee (capped at the policy's per-attempt maximum).
    const top = ladder.steps[ladder.steps.length - 1]!.priorityFeeLamports;
    expect(inputs.exitFee({ ...p, status: 'exit_blocked' })).toBe(attemptFee(FILL_CONFIG.network, BigInt(top < ladder.maxFeePerAttempt ? top : ladder.maxFeePerAttempt), 'filled'));
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
