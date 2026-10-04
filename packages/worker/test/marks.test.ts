// RISK-MARK: each open position's mark is its executable value now (the full-size sell after fees, less the exit's
// accepted slippage and network cost) from a fresh market, and null otherwise. These tests run the marks through core
// risk unchanged (no limit touched) and show what they change: NAV, R10's high-water mark and kill line, the day and
// week limits, and entries while a position is open under the configured maxOpen.
import { describe, expect, it } from 'vitest';
import { type PoolFeeContext, type PoolState, poolBuyExactQuoteIn, poolSell } from '../../core/src/amm/index.ts';
import { TRIAL_POLICY, startSession, usd } from '../../core/src/config/index.ts';
import { executableMark } from '../../core/src/exits/index.ts';
import { type AccountHistory, evaluateEntry, evaluateExit } from '../../core/src/risk/index.ts';
import { type Lamports, type MicroUsd, bps, lamportsToMicroUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import { AMM_FEE_CONFIG, NORMAL_COIN, PUMP_GLOBAL } from '../../core/test/amm/helpers.ts';
import { DEEP_POOL, MINT_A, MINT_B, NOW, PRICE, account, baseInput, baseRequest } from '../../core/test/risk/helpers.ts';
import { type HeldMarket, type MarkSettings, latchable, markSettings, markedHistory, riskAccount } from '../src/engine/marks.ts';

const CTX: PoolFeeContext = { feeConfig: AMM_FEE_CONFIG, canonical: true, quote: 'sol', baseSupply: PUMP_GLOBAL.tokenTotalSupply, creatorFeeCharged: true, coin: NORMAL_COIN, instruction: 'v1', buybackFeeBps: bps(5_000) };
const SETTINGS: MarkSettings = { slippageBps: 300, exitCost: 30_000n, maxAgeMs: TRIAL_POLICY.gates.maxQuoteAgeMs };
const SOL = { value: PRICE, atMs: NOW - 500 };

/** A $4.50 position in MINT_A bought from the deep pool: its tokens, the pool after the buy, and its cost basis. */
const NOTIONAL = usd('4.5');
const bought = (() => {
  const q = poolBuyExactQuoteIn(DEEP_POOL, microUsdToLamports(NOTIONAL, PRICE, 'ceil'), CTX);
  if (!q.ok) throw new Error(q.reason);
  return { tokens: q.trade.base, pool: q.trade.after };
})();
/** The pool after someone sells `share` of its base reserve: the position's price falls. */
const sold = (share: bigint): PoolState => {
  const q = poolSell(bought.pool, (bought.pool.baseReserve * share) / 100n, CTX);
  if (!q.ok) throw new Error(q.reason);
  return q.trade.after;
};

const history = (): AccountHistory => account({ openPositions: [{ mint: MINT_A, openedAtMs: NOW - 60_000, notional: NOTIONAL, mark: null, markAtMs: null }] });
const held = (pool: PoolState | null, atMs = NOW - 300): ((mint: string) => HeldMarket | undefined) => (mint) =>
  mint === MINT_A ? { quantity: bought.tokens, market: pool === null ? null : { pool, ctx: CTX, atMs } } : undefined;
const marked = (pool: PoolState | null, atMs?: number) => markedHistory(history(), held(pool, atMs), SOL, NOW, SETTINGS);

describe('the executable mark (RISK-MARK)', () => {
  it('is the full-size sell after fees, less the exit slippage and network cost, never below zero', () => {
    const m = { venue: 'pumpswap' as const, pool: bought.pool, ctx: CTX };
    const sale = poolSell(bought.pool, bought.tokens, CTX);
    if (!sale.ok) throw new Error(sale.reason);
    const v = executableMark(m, bought.tokens, { slippageBps: 300, exitCost: 30_000n });
    expect(v).toEqual({ ok: true, value: (sale.trade.userQuote * 9_700n) / 10_000n - 30_000n });
    expect(executableMark(m, bought.tokens, { slippageBps: 0, exitCost: 0n })).toEqual({ ok: true, value: sale.trade.userQuote });
    expect(executableMark(m, bought.tokens, { slippageBps: 300, exitCost: 10n ** 18n })).toEqual({ ok: true, value: 0n });
    expect(executableMark(m, 0n, { slippageBps: 300, exitCost: 0n }).ok).toBe(false);
    expect(() => executableMark(m, 1n, { slippageBps: 10_001, exitCost: 0n })).toThrow(RangeError);
    expect(() => executableMark(m, 1n, { slippageBps: 0, exitCost: -1n })).toThrow(RangeError);
  });

  it('marks a position from a fresh market, in micro-dollars at the SOL price, dated at the market', () => {
    const p = marked(bought.pool).openPositions[0]!;
    const v = executableMark({ venue: 'pumpswap', pool: bought.pool, ctx: CTX }, bought.tokens, SETTINGS);
    if (!v.ok) throw new Error('no mark');
    expect(p).toMatchObject({ mark: lamportsToMicroUsd(v.value as Lamports, PRICE, 'floor'), markAtMs: NOW - 300 });
    // Below the cost: fees both ways, slippage and the exit's network cost.
    expect(p.mark! < NOTIONAL).toBe(true);
    expect(p.mark! > (NOTIONAL * 9n) / 10n).toBe(true);
  });

  it('keeps the mark null with no market, a stale or future market, no SOL price, or nothing held', () => {
    const nulls = [
      marked(null),
      marked(bought.pool, NOW - SETTINGS.maxAgeMs - 1),
      marked(bought.pool, NOW + 1),
      markedHistory(history(), held(bought.pool), null, NOW, SETTINGS),
      markedHistory(history(), held(bought.pool), { value: 0n as MicroUsd, atMs: NOW }, NOW, SETTINGS),
      // A stale or future-dated SOL price (risk's freshness rule) values nothing.
      markedHistory(history(), held(bought.pool), { value: PRICE, atMs: NOW - SETTINGS.maxAgeMs - 1 }, NOW, SETTINGS),
      markedHistory(history(), held(bought.pool), { value: PRICE, atMs: NOW + 1 }, NOW, SETTINGS),
      markedHistory(history(), () => undefined, SOL, NOW, SETTINGS),
      markedHistory(history(), () => ({ quantity: 0n, market: { pool: bought.pool, ctx: CTX, atMs: NOW } }), SOL, NOW, SETTINGS),
    ];
    for (const h of nulls) expect(h.openPositions[0]).toMatchObject({ mark: null, markAtMs: null });
    // Exactly maxAgeMs old is still fresh.
    expect(marked(bought.pool, NOW - SETTINGS.maxAgeMs).openPositions[0]!.mark).not.toBeNull();
    expect(markedHistory(history(), held(bought.pool), { value: PRICE, atMs: NOW - SETTINGS.maxAgeMs }, NOW, SETTINGS).openPositions[0]!.mark).not.toBeNull();
  });

  it('is valued at the ladder\'s worst accepted slippage and that rung\'s network cost (ruling N1)', () => {
    const last = TRIAL_POLICY.exits.ladder.steps.at(-1)!;
    const n = { signaturesPerTx: 2n, baseFeePerSignature: 5_000n, tip: 7_000n };
    expect(markSettings(startSession(TRIAL_POLICY).policy, n)).toEqual({
      slippageBps: last.minOutBelowTriggerBps, exitCost: 2n * 5_000n + last.priorityFeeLamports + 7_000n, maxAgeMs: TRIAL_POLICY.gates.maxQuoteAgeMs,
    });
    // The last rung is the worst: no rung accepts more slippage.
    expect(TRIAL_POLICY.exits.ladder.steps.every((x) => x.minOutBelowTriggerBps <= last.minOutBelowTriggerBps)).toBe(true);
  });

  it('on an exit, a failure while marking gives back the unmarked account; on an entry it is not swallowed', () => {
    const boom = (): HeldMarket => {
      throw new Error('no market');
    };
    const h = history();
    expect(riskAccount(h, boom, SOL, NOW, SETTINGS, { fallback: true })).toBe(h);
    expect(() => riskAccount(h, boom, SOL, NOW, SETTINGS, { fallback: false })).toThrow('no market');
    expect(riskAccount(h, held(bought.pool), SOL, NOW, SETTINGS, { fallback: true })).toEqual(marked(bought.pool));
  });
});

describe('when a valuation may latch R9 or R10 (RISK-LATCH review)', () => {
  const AGE = SETTINGS.maxAgeMs;
  const empty: AccountHistory = { ...history(), openPositions: [] };
  it('only at a fresh SOL price with every open position marked and fresh', () => {
    const m = marked(bought.pool);
    expect(m.openPositions[0]!.mark).not.toBeNull();
    expect(latchable(m, SOL, NOW, AGE)).toBe(true);
    // Nothing held: the SOL price alone decides.
    expect(latchable(empty, SOL, NOW, AGE)).toBe(true);
    // No SOL price, a stale one, or one stamped after now.
    expect(latchable(m, null, NOW, AGE)).toBe(false);
    expect(latchable(empty, { value: PRICE, atMs: NOW - AGE - 1 }, NOW, AGE)).toBe(false);
    expect(latchable(empty, { value: PRICE, atMs: NOW + 1 }, NOW, AGE)).toBe(false);
    expect(latchable(empty, { value: PRICE, atMs: NOW - AGE }, NOW, AGE)).toBe(true);
    // An open position with no mark, a stale mark, or one stamped after now.
    const with_ = (mark: bigint | null, markAtMs: number | null) => ({ ...m, openPositions: m.openPositions.map((o) => ({ ...o, mark: mark as never, markAtMs })) });
    expect(latchable(with_(null, null), SOL, NOW, AGE)).toBe(false);
    expect(latchable(with_(1n, null), SOL, NOW, AGE)).toBe(false);
    expect(latchable(with_(1n, NOW - AGE - 1), SOL, NOW, AGE)).toBe(false);
    expect(latchable(with_(1n, NOW + 1), SOL, NOW, AGE)).toBe(false);
    expect(latchable(with_(1n, NOW - AGE), SOL, NOW, AGE)).toBe(true);
    // A negative mark is no mark to core (a total-loss stand-in), so it never latches; zero is a real mark.
    expect(latchable(with_(-1n, NOW), SOL, NOW, AGE)).toBe(false);
    expect(latchable(with_(0n, NOW), SOL, NOW, AGE)).toBe(true);
  });
});

describe('what the mark changes in risk (limits unchanged)', () => {
  it('NAV: unknown without a mark, the wallet plus the mark with one', () => {
    const none = evaluateEntry(baseInput({ account: history() }), baseRequest({ mint: MINT_B }));
    expect(none.snapshot?.nav ?? null).toBeNull();
    const h = marked(bought.pool);
    const d = evaluateEntry(baseInput({ account: h }), baseRequest({ mint: MINT_B }));
    expect(d.snapshot!.nav).not.toBeNull();
    const without = evaluateEntry(baseInput({ account: account() }), baseRequest({ mint: MINT_B }));
    expect(d.snapshot!.nav! - without.snapshot!.nav!).toBe(h.openPositions[0]!.mark!);
    // R10's NAV high-water mark is known and at least NAV.
    expect(d.snapshot!.navHighWaterMark! >= d.snapshot!.nav!).toBe(true);
  });

  it('the day and week: an unmarked $4.50 position is a total loss that trips the weekly limit on an exit; marked near cost it trips nothing', () => {
    const unmarked = evaluateExit(baseInput({ account: history() }));
    expect(unmarked.tripped.map((r) => r.code)).toEqual(expect.arrayContaining(['mark_unknown', 'daily_loss', 'weekly_loss']));
    expect(unmarked.trips).toContain('weekly_loss');
    const ok = evaluateExit(baseInput({ account: marked(bought.pool) }));
    expect(ok.trips).toEqual([]);
    expect(ok.tripped.map((r) => r.code)).not.toEqual(expect.arrayContaining(['daily_loss']));
    expect(ok.tripped.map((r) => r.code)).not.toContain('weekly_loss');
    expect(ok.tripped.map((r) => r.code)).not.toContain('mark_unknown');
  });

  it('a real fall is counted: the pool sold down to a $1.60 loss trips the daily limit from the mark', () => {
    // Sellers take ~40% of the base: the position's executable value falls well below its cost.
    const h = marked(sold(40n));
    const loss = NOTIONAL - h.openPositions[0]!.mark!;
    expect(loss >= usd('1.5')).toBe(true);
    const d = evaluateExit(baseInput({ account: h }));
    expect(d.tripped.map((r) => r.code)).toContain('daily_loss');
    expect(d.tripped.map((r) => r.code)).not.toContain('mark_unknown');
  });

  it('the kill line (R10) is judged on the mark: a near-total fall trips it, the position marked near cost does not', () => {
    const big = account({ openingEquity: usd('20'), openPositions: [{ mint: MINT_A, openedAtMs: NOW - 60_000, notional: usd('7'), mark: null, markAtMs: null }] });
    const crashed = { ...big, openPositions: [{ ...big.openPositions[0]!, mark: usd('0.5') as MicroUsd, markAtMs: NOW - 300 }] };
    expect(evaluateExit(baseInput({ account: crashed })).trips).toContain('kill_switch');
    const nearCost = markedHistory(history(), held(bought.pool), SOL, NOW, SETTINGS);
    expect(evaluateExit(baseInput({ account: nearCost })).trips).not.toContain('kill_switch');
  });

  it('entries while a position is open follow the configured maxOpen: refused at 1; at 2, unknown or stale marks refuse and a fresh mark leaves only the loss limits', () => {
    const one = evaluateEntry(baseInput({ account: marked(bought.pool) }), baseRequest({ mint: MINT_B }));
    expect(!one.allow && one.reasons.map((r) => r.code)).toContain('max_open_positions');
    // Code never raises a cap (startSession refuses it); this is the session an owner-approved maxOpen of 2 would give.
    expect(() => startSession({ ...TRIAL_POLICY, positions: { ...TRIAL_POLICY.positions, maxOpen: 2 } })).toThrow(/raises a cap/);
    const base = startSession(TRIAL_POLICY);
    const two = { ...base, policy: { ...base.policy, positions: { ...base.policy.positions, maxOpen: 2 } } };
    const refused = evaluateEntry(baseInput({ session: two, account: marked(null) }), baseRequest({ mint: MINT_B }));
    expect(!refused.allow && refused.reasons.map((r) => r.code)).toContain('mark_unknown');
    const stale = evaluateEntry(baseInput({ session: two, account: marked(bought.pool, NOW - SETTINGS.maxAgeMs - 1) }), baseRequest({ mint: MINT_B }));
    expect(!stale.allow && stale.reasons.map((r) => r.code)).toContain('mark_unknown');
    const allowed = evaluateEntry(baseInput({ session: two, account: marked(bought.pool) }), baseRequest({ mint: MINT_B }));
    // Neither the mark nor maxOpen refuses it now; a new trade's full loss on top of the $4.50 at risk still meets the
    // week and kill limits, which apply unchanged.
    expect(allowed.allow ? [] : allowed.reasons.map((r) => r.code).sort()).toEqual(['full_loss_kill_line', 'full_loss_week']);
  });
});
