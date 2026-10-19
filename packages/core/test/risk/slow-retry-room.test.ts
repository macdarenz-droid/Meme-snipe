// RB-16 under S1's rule B (EXIT-FILL-FIXES): C (q + C, R6) keeps the planned ladder (5 + 5 attempts); R4's reserve holds
// day 1 of RB-5's slow retries; every later slow retry is paid out of the account's room as it lands, and the exit
// never waits for money. A failed landing's fee leaves the wallet at once (PAPER-1, M4; worker slow-retry-fee.test.ts),
// and risk takes capital as the lower of ledger and wallet-marked equity, so the room shrinks with each fee paid.
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY } from '../../src/config/index.ts';
import { exitSettings, slowRetriesWithin } from '../../src/exits/index.ts';
import { evaluateEntry, maxTradeCosts, opsReserve, SLOW_RETRY_RESERVE_MS } from '../../src/risk/index.ts';
import { lamports } from '../../src/units/index.ts';
import { NETWORK, NOW, PRICE, RENT, baseInput, baseRequest, codes } from './helpers.ts';

const G = TRIAL_POLICY.exits;
const WEEK_MS = 7 * SLOW_RETRY_RESERVE_MS;
const retryCost = exitSettings(TRIAL_POLICY, 'close', FILL_CONFIG.network).retryCost;
const withWallet = (v: bigint) => {
  const i = baseInput();
  return { ...i, market: { ...i.market, solBalance: { value: lamports(v), atMs: NOW }, solPrice: { value: PRICE, atMs: NOW } } };
};
const allowed = (v: bigint) => evaluateEntry(withWallet(v), baseRequest()).allow;

describe('RB-16 slow retries under rule B: reserved for day 1, counted when paid after it, never holding an exit back', () => {
  test('C covers the planned ladder only; R4\'s reserve covers day 1\'s slow retries; the rest of a week is the account\'s to pay', () => {
    const c = maxTradeCosts(TRIAL_POLICY, { network: NETWORK, rent: RENT });
    expect(c.ladderWorst).toBe(BigInt(G.ladder.maxAttempts + G.blockedRetryAttempts) * c.perExitAttempt);
    const day1 = slowRetriesWithin(G.blockedRetryMs, SLOW_RETRY_RESERVE_MS);
    expect(day1).toBe(4);
    const big = { ...RENT, oneTime: 3_000_000n, transient: 20_000_000n };
    expect(opsReserve(TRIAL_POLICY, { rent: big }, c.perExitAttempt)).toBe(big.tokenAccount + big.oneTime + big.transient + BigInt(TRIAL_POLICY.reserve.exitAttempts + G.blockedRetryAttempts + day1) * c.perExitAttempt);
    // A week blocked: 4 slow retries in day 1 (reserved), the rest after it (paid as they land).
    const week = slowRetriesWithin(G.blockedRetryMs, WEEK_MS);
    expect(week - day1).toBeGreaterThan(0);
    expect(BigInt(week - day1) * retryCost).toBeLessThanOrEqual(BigInt(week) * 510_000n);
  });

  test('a blocked week\'s slow-retry fees, each paid from the wallet, take the room away: entries are refused, by the money controls', () => {
    // The least wallet that still allows the entry (allowed is monotone in the wallet), found to the lamport.
    let lo = 0n;
    let hi = 1_000_000_000_000n;
    expect(allowed(hi)).toBe(true);
    expect(allowed(lo)).toBe(false);
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (allowed(mid)) hi = mid;
      else lo = mid;
    }
    const edge = hi;
    const fees = BigInt(slowRetriesWithin(G.blockedRetryMs, WEEK_MS)) * retryCost;
    expect(allowed(edge)).toBe(true);
    // Every fee counts: the same wallet less one week of slow retries, or less any one of them, is refused.
    const refused = evaluateEntry(withWallet(edge - fees), baseRequest());
    expect(refused.allow).toBe(false);
    expect(allowed(edge - retryCost)).toBe(false);
    // R6's full-loss room is what runs out (at the trial settings: full_loss_kill_line); only money controls refuse.
    expect(codes(refused).some((c) => c.startsWith('full_loss_'))).toBe(true);
    // Refused for money (cash after the reserve, or the full-loss room), never for anything else.
    for (const code of codes(refused)) expect(['ops_reserve', 'full_loss_kill_line', 'full_loss_week', 'planned_risk', 'wallet_below_kill_line', 'size_below_minimum']).toContain(code);
  });

  // The exit side is RB-5b (core/test/redteam-b/exits.test.ts): a week of failing slow retries keeps sending them, and
  // decideExit reads no risk or money state, so no refusal here can hold an exit back.
});
