// RED TEAM 3 / R3-1: a graduate whose PumpSwap pool is quoted in a token other than SOL (USDC-quoted pump coins,
// live since 2026-05-21, docs/research/historical-data.md "Quote-token curves") enters the regime gate's survival
// series with `reserveAfter` in that token's raw units, compared against `survivalReserveFloor` in lamports.
//
// Scenario: CompleteEvent -> CompletePumpAmmMigrationEvent -> CreatePoolEvent with quoteMint = USDC (6 decimals). The
// producer's #migration never looks at the quote mint, #resolve records the pool's quote reserve (here 20,000 USDC =
// 2e10 raw) as `reserveAfter`, and regime.ts survivalCondition counts it against a 30 SOL (3e10 lamport) floor. The
// survival share (recent day vs 14-day median) therefore moves with the USDC/SOL mix of graduates, not with SOL
// survival: a day with fewer USDC graduates can lift the recent share above the median and pass the regime gate on
// data that is not SOL survival. The backtest uses the same producer (sim/facts.ts #feedSurvival), so it is parity-equal
// but equally wrong. Correct (fail-closed) behaviour: only SOL-quoted graduates enter the series (H5 already refuses
// such a pool as a candidate: hard.ts:218).
import { describe, expect, it } from 'vitest';
import { FactProducer, producerOptions } from '../../../core/src/facts/index.ts';
import { GRADUATES_KEY } from '../../../core/src/gates/facts.ts';
import { TRIAL_POLICY } from '../../../core/src/config/policy.ts';
import type { MarketEvent } from '../../../core/src/engine/index.ts';

const MINT = 'Mint111111111111111111111111111111111111111';
const POOL = 'Poo1111111111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const T0 = 1_790_000_000; // seconds
let seq = 0;
const ev = (key: string, value: unknown, slot: bigint, receivedAt: number): MarketEvent =>
  ({ kind: 'market', id: `x:${seq++}`, moment: { slot, txIndex: 0, ixIndex: seq, receivedAt }, key, value });
const program = (prog: string, name: string, data: Record<string, unknown>, slot: bigint, at: number): MarketEvent =>
  ev(`${prog}:${name}:${MINT}`, { event: { program: prog, name, data, signature: `sig${seq}` }, txSlot: slot, source: 'helius' }, slot, at);

describe('R3-1 graduates series: quote mint', () => {
  it('a USDC-quoted graduate must not enter the SOL survival series', () => {
    const o = producerOptions(TRIAL_POLICY);
    const p = new FactProducer({ ...o, preReadKeep: 0 } as never);
    const at = T0 * 1000;
    const writes: { key: string; value: unknown }[] = [];
    const feed = (e: MarketEvent) => writes.push(...p.observe(e));
    feed(program('pump', 'CompleteEvent', { user: 'u', mint: MINT, bondingCurve: 'bc', timestamp: BigInt(T0) }, 100n, at));
    feed(ev(`coverage:trades:${POOL}:start`, { via: 'helius', fromSlot: 101n }, 101n, at));
    feed(program('pump', 'CompletePumpAmmMigrationEvent', { user: 'u', mint: MINT, mintAmount: 1n, solAmount: 1n, poolMigrationFee: 0n, bondingCurve: 'bc', timestamp: BigInt(T0), pool: POOL }, 101n, at));
    feed(program('pump_amm', 'CreatePoolEvent', {
      timestamp: BigInt(T0), index: 0, creator: 'c', baseMint: MINT, quoteMint: USDC, baseMintDecimals: 6, quoteMintDecimals: 6,
      baseAmountIn: 206_900_000_000_000n, quoteAmountIn: 20_000_000_000n, poolBaseAmount: 206_900_000_000_000n, poolQuoteAmount: 20_000_000_000n,
      minimumLiquidity: 0n, initialLiquidity: 0n, lpTokenAmountOut: 0n, poolBump: 255, pool: POOL, lpMint: 'lp', userBaseTokenAccount: 'a', userQuoteTokenAccount: 'b',
    }, 101n, at));
    const mark = at + o.survivalAfterMs + 1000;
    feed(ev('chain:slot', { slot: 6000n }, 6000n, mark));
    feed(ev('chain:slot', { slot: 6001n }, 6001n, mark + 1));
    const g = writes.filter((w) => w.key === GRADUATES_KEY).at(-1)?.value as { items?: { mint: string; reserveAfter: bigint }[] } | undefined;
    const items = g?.items ?? [];
    // Diagnostic: on 959d801 the USDC pool's 2e10 raw USDC units are recorded as a SOL reserve.
    expect(items.map((i) => [i.mint, i.reserveAfter])).toEqual([]);
  });
});
