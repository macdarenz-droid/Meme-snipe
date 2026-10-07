// RED TEAM A, probe RT-A3 (H16-WHY C, worker.ts #cutCreateLog / #cutCreateTry / #readLostCreates).
//
// H14 refuses EVERY coin (H16 not-covered, input coverage) while ANY creates-watch log inside its 14-day look-back was
// cut and its transaction never released (hard.ts: `deployers.lostCreate(need, now)` is not per deployer). A cut
// creates log is asked for only (a) when its log arrives and (b) at boot (#readLostCreates). Nothing asks again later
// in the same process:
//   - a cut log that arrives while the UTC day's CUT_CREATE_FETCHES_PER_DAY (3,000) is spent is dropped before it is
//     even remembered (`if (!this.#takeCutCreateFetch()) return;`), and the next UTC day, with the cap back, never
//     asks for it;
//   - a cut log whose 5 tries (about 30 minutes) all failed (a provider outage longer than that) is never asked again.
// Either way the transaction a single read could fetch is never fetched, and H14 refuses every candidate for 14 days
// or until the process happens to restart. FACTS-REREAD parks and resumes on the next UTC day for exactly this reason
// (#resumeRereads); the cut-create chain has no such resume.
//
// Realism: DECISIONS "H16-WHY C" expects about 2,000 cut creates logs a day (41 of 600 sampled creates cut, ~30,000
// creates a day) against a 3,000 cap that also pays retries and the boot re-ask of every lost hole in the look-back. A
// busy day (more creates, or a restart re-asking a backlog) spends the cap; from then on every new cut log is a
// 14-day block on all coins. Golden rule: every wrongly refused coin is a real loss.
import { describe, expect, it } from 'vitest';
import { CUT_CREATE_FETCHES_PER_DAY } from '../../src/run/worker.ts';
import { Market, makeWorker } from '../worker-harness.ts';

const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const DAY_MS = 86_400_000;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sig = (k: number) => `${B58[k % 58]}${B58[Math.floor(k / 58) % 58]}${B58[Math.floor(k / 3364) % 58]}${'4'.repeat(85)}`;
const now = (h: { timers: { now(): number } }) => ({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: h.timers.now() });
const cut = (h: ReturnType<typeof makeWorker>, signature: string, slot: bigint) =>
  h.worker.feed.ingest('helius', { type: 'logs', signature, slot, err: null, via: VIA, logs: ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]', 'Log truncated'] }, { receivedAt: h.timers.now() });
const settle = async (h: ReturnType<typeof makeWorker>, turns = 60) => {
  for (let i = 0; i < turns; i++) {
    h.worker.step();
    await new Promise<void>((r) => setImmediate(r));
  }
};

describe('RT-A3: a cut creates log refused by the day\'s cap is never asked for again in the process', () => {
  it('the cap is spent when the log arrives; on the next UTC day (cap back) its transaction is fetched', async () => {
    const fetchedWhy: [string, string][] = [];
    const h = makeWorker({ found: true, fetchedWhy });
    await h.worker.reconcile();
    const m = new Market(h);
    m.slot(1_000n);
    m.offchain('coverage:creates:start', { fromSlot: 900n, via: VIA });
    await m.run(1_000, 200, () => m.slot());
    for (let k = 1; k <= CUT_CREATE_FETCHES_PER_DAY; k++) cut(h, sig(k), 1_003n);
    await m.run(2_000, 200, () => m.slot());
    expect(fetchedWhy).toHaveLength(CUT_CREATE_FETCHES_PER_DAY);
    // The day's cap is spent: X's log arrives now and is not fetched (fail closed for today, as documented).
    const X = sig(CUT_CREATE_FETCHES_PER_DAY + 7);
    cut(h, X, 1_005n);
    await m.run(2_000, 200, () => m.slot());
    expect(fetchedWhy.some(([s]) => s === X)).toBe(false);
    expect(h.worker.strategy.deployers.isLost(X)).toBe(true);
    // The next UTC day: the cap is back, X is still a hole that blocks H14 for every coin.
    h.timers.set((Math.floor(h.timers.now() / DAY_MS) + 1) * DAY_MS + 1_000);
    await m.run(60_000, 1_000, () => m.slot());
    await settle(h);
    expect(h.worker.strategy.deployers.lostCreate(0, now(h))).not.toBeNull();
    // Correct behaviour: X is asked for again once the budget is back (as FACTS-REREAD's parked chains are).
    expect(fetchedWhy.filter(([s]) => s === X)).toEqual([[X, 'cut-create']]);
    await h.worker.stop();
  }, 60_000);
});
