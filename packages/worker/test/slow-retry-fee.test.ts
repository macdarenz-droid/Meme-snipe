// RB-5 risk ruling (EXIT-FILL-FIXES): a slow blocked-exit retry's fee is paid when it lands, not when the trade closes.
// A failed landing pays base and priority (PAPER-1, M4); the account books it into the wallet at once, while the
// position is still blocked and open. Risk takes capital as the lower of ledger and wallet-marked equity, so the fee
// shrinks R5's and R6's room at once (core/test/risk/slow-retry-room.test.ts); the ledger's day and week loss count an
// open trade's fees when paid with SOL-BOOKS (#197, ACCOUNT-RATE F1).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { slowRetryWaitMs } from '../../core/src/exits/index.ts';
import { attemptFee } from '../../core/src/fills/index.ts';
import { accountFile } from '../src/run/account.ts';
import { parseTyped } from '../src/run/json.ts';
import type { PaperAttempt } from '../src/run/paper-world.ts';
import { LANDS, Market, makeWorker, passingMarket } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const exits = (h: H): PaperAttempt[] => {
  const p = join(h.stateDir, 'paper.json');
  if (!existsSync(p)) return [];
  return Object.values((parseTyped(readFileSync(p, 'utf8')) as { attempts: Record<string, PaperAttempt> }).attempts)
    .filter((a) => a.purpose === 'exit').sort((x, y) => (x.sentAtMs ?? 0) - (y.sentAtMs ?? 0));
};
const until = async (m: Market, done: () => boolean, maxMs: number, each: () => void): Promise<boolean> => {
  const end = m.now + maxMs;
  while (!done() && m.now < end) await m.run(400, 400, () => { m.slot(); each(); });
  return done();
};

describe('RB-5 a slow retry\'s fee is booked when it lands, not at close', () => {
  it('every exit attempt lands failed: the first slow retry takes its fee off the wallet at once, the position still open', async () => {
    // Enter with every attempt landing; then restart where every attempt lands failed.
    const h = makeWorker({ scenario: LANDS });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    const open = () => Object.values(h.worker.book.positions).some((p) => p.status === 'open');
    expect(await until(m, open, 30_000, () => m.pool())).toBe(true);
    await h.worker.stop();
    const failing = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n };
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario: failing });
    expect((await h2.worker.start()).ok).toBe(true);
    const m2 = new Market(h2, { heldPoolFacts: true });
    const bound = TRIAL_POLICY.exits.ladder.maxAttempts + TRIAL_POLICY.exits.blockedRetryAttempts;
    // The price falls 30%: the stop fires; the ladder and the bounded retries all land failed; then the first slow retry.
    const slowSent = () => exits(h2).length > bound;
    expect(await until(m2, slowSent, 3 * 3_600_000, () => m2.pool(700_000n))).toBe(true);
    const slow = exits(h2)[bound]!;
    expect(slow.outcome).toBe('in_flight');
    // It is a slow retry: sent at least the first slow wait after the last bounded retry.
    expect(slow.sentAtMs! - exits(h2)[bound - 1]!.sentAtMs!).toBeGreaterThanOrEqual(slowRetryWaitMs(TRIAL_POLICY.exits.blockedRetryMs, 0));
    const before = accountFile(h2.stateDir).read(null as never).walletLamports!;
    const landed = () => exits(h2)[bound]!.outcome !== 'in_flight';
    expect(await until(m2, landed, 60_000, () => m2.pool(700_000n))).toBe(true);
    expect(exits(h2)[bound]!.outcome).toBe('failed');
    const after = accountFile(h2.stateDir).read(null as never).walletLamports!;
    expect(before - after).toBe(attemptFee(FILL_CONFIG.network, slow.priorityFee, 'failed'));
    // Still held: the fee is booked while the trade is open, not at its close.
    expect(Object.values(h2.worker.book.positions).every((p) => p.status !== 'closed')).toBe(true);
    expect(accountFile(h2.stateDir).read(null as never).trades.every((t) => t.closedAtMs === null)).toBe(true);
    await h2.worker.stop();
  }, 600_000);
});
