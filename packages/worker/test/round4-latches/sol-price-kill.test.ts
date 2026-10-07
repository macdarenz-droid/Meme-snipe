// ROUND 4 PARALYSIS PROBE (red team, latches): a SOL/USD fall alone trips and LATCHES the R10 kill switch.
// core/src/risk/evaluate.ts:118-124 values economic NAV in dollars (wallet SOL x the live SOL/USD price) and :309-321
// trips `kill_switch` at NAV <= 70% of its dollar high-water mark, latched until an owner re-arm; :320 adds the
// unlatched `wallet_below_kill_line` on the same dollar basis. With zero trades and the SOL quantity unchanged, a 31%
// SOL/USD fall stops every entry for good. The owner's rule (CLAUDE.md, 2026-10-05 "Profit is counted in SOL"): "a SOL/USD
// move alone must never count as a gain or loss or trip a limit". SOL-BOOKS (#197, HANDOVER) is the card; at cd4d7a6 it
// is not in. Nothing at cd4d7a6 writes killRearmedAtMs (OWNER-REVIEW paused), so the latch is permanent in practice.
// Frequency: SOL/USD fell 30%+ from a local peak several times a year in 2024-2025. Non-paralysed behaviour asserted:
// the same SOL, no trade, a lower SOL/USD price: no kill-switch trip, no kill-line refusal. FAILS on cd4d7a6.
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY, usd } from '../../../core/src/config/index.ts';
import { evaluateEntry } from '../../../core/src/risk/index.ts';
import { lamports, microUsdToLamports } from '../../../core/src/units/index.ts';
import { NOW, PRICE, baseInput, baseRequest, codes } from '../../../core/test/risk/helpers.ts';

describe('round4 latches: SOL/USD alone never trips R10', () => {
  it('the bankroll in SOL is unchanged, SOL/USD falls 31%: entries are still allowed and nothing latches', () => {
    // The opening $20 bankroll held as SOL at the start price, plus the operations floor.
    const held = microUsdToLamports(usd('20'), PRICE, 'ceil') + TRIAL_POLICY.reserve.opsFloor;
    const at = (price: bigint) => {
      const i = baseInput();
      return { ...i, market: { ...i.market, solBalance: { value: lamports(held), atMs: NOW }, solPrice: { value: price as typeof PRICE, atMs: NOW } } };
    };
    expect(evaluateEntry(at(PRICE), baseRequest()).allow).toBe(true);
    const lower = ((PRICE * 69n) / 100n) as typeof PRICE;
    const d = evaluateEntry(at(lower), baseRequest());
    const killCodes = codes(d).filter((c) => c === 'kill_switch' || c === 'wallet_below_kill_line');
    expect({ killCodes, trips: d.trips }).toEqual({ killCodes: [], trips: [] });
  });
});
