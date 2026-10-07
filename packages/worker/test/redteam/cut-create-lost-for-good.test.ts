// RED TEAM A, probe RT-A8 (H16-WHY C, worker.ts #cutCreateLog / #cutCreateTry / #readLostCreates).
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
import { CUT_CREATE_FETCHES_PER_DAY, CUT_CREATE_RETRY_MS, LOST_CREATE_REASKS_PER_DAY } from '../../src/run/worker.ts';
import { fetchCapsFile } from '../../src/run/state.ts';
import { Market, makeWorker, tempState, virtualTimers } from '../worker-harness.ts';

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

// A-FACTS-FIXES: the day's cap is spent through `fetch-caps.json` (as a busy day leaves it) rather than by 3,000 fetches
// the harness answers "found" without releasing their transactions: those would stay holes the next day's re-ask
// also asks for, which a real found fetch (its `ev:` events clear the hole) never leaves.
const boot = async (h: ReturnType<typeof makeWorker>) => {
  expect(await h.worker.start()).toEqual({ ok: true });
  const m = new Market(h);
  m.slot(1_000n);
  m.offchain('coverage:creates:start', { fromSlot: 900n, via: VIA });
  await m.run(1_000, 200, () => m.slot());
  return m;
};
const nextDay = async (h: ReturnType<typeof makeWorker>, m: Market) => {
  h.timers.set((Math.floor(h.timers.now() / DAY_MS) + 1) * DAY_MS + 1_000);
  await m.run(60_000, 1_000, () => m.slot());
  await settle(h);
};

describe('RT-A8: a cut creates log refused by the day\'s cap is never asked for again in the process', () => {
  it('the cap is spent when the log arrives; on the next UTC day (cap back) its transaction is fetched', async () => {
    const fetchedWhy: [string, string][] = [];
    const stateDir = tempState();
    const timers = virtualTimers(1_791_000_000_000);
    fetchCapsFile(stateDir).write({ day: Math.floor(timers.now() / DAY_MS), cutCreate: CUT_CREATE_FETCHES_PER_DAY, cutTrade: 0, reread: 0 });
    const h = makeWorker({ stateDir, timers, found: true, fetchedWhy });
    const m = await boot(h);
    // The day's cap is spent: X's log arrives now and is not fetched (fail closed for today, as documented).
    const X = sig(7);
    cut(h, X, 1_005n);
    await m.run(2_000, 200, () => m.slot());
    expect(fetchedWhy.some(([s]) => s === X)).toBe(false);
    expect(h.worker.strategy.deployers.isLost(X)).toBe(true);
    // A later step the same day asks nothing.
    await m.run(60_000, 1_000, () => m.slot());
    expect(fetchedWhy).toEqual([]);
    // The next UTC day: the cap is back, X is still a hole that blocks H14 for every coin.
    await nextDay(h, m);
    expect(h.worker.strategy.deployers.lostCreate(0, now(h))).not.toBeNull();
    // Correct behaviour: X is asked for again once the budget is back (as FACTS-REREAD's parked chains are).
    expect(fetchedWhy.filter(([s]) => s === X)).toEqual([[X, 'cut-create']]);
    await h.worker.stop();
  }, 60_000);

  it('a hole whose tries all failed is asked for again on the next UTC day, once, under that day\'s cap', async () => {
    const fetchedWhy: [string, string][] = [];
    let up = false;
    const h = makeWorker({ found: () => up, fetchedWhy });
    const m = await boot(h);
    const X = sig(9);
    cut(h, X, 1_005n);
    await m.run(2_000, 200, () => m.slot());
    await m.run(CUT_CREATE_RETRY_MS.reduce((a, b) => a + b, 0) + 60_000, 10_000, () => m.slot());
    await settle(h);
    const tries = CUT_CREATE_RETRY_MS.length + 1;
    expect(fetchedWhy.filter(([s]) => s === X)).toHaveLength(tries);
    // The provider is back; the same day asks nothing more.
    up = true;
    await m.run(60_000, 1_000, () => m.slot());
    expect(fetchedWhy.filter(([s]) => s === X)).toHaveLength(tries);
    await nextDay(h, m);
    expect(fetchedWhy.filter(([s]) => s === X)).toHaveLength(tries + 1);
    expect(fetchedWhy.at(-1)).toEqual([X, 'cut-create']);
    // One re-ask a day: later steps of the same day ask nothing more.
    await m.run(60_000, 1_000, () => m.slot());
    expect(fetchedWhy.filter(([s]) => s === X)).toHaveLength(tries + 1);
    await h.worker.stop();
  }, 60_000);

  it('a chain still running at midnight is left to finish (no second chain); a hole still lost after a found fetch is asked again the next day', async () => {
    const fetchedWhy: [string, string][] = [];
    // 10 minutes before midnight UTC: the chain's waits (2, 4, 8, 16 minutes) cross it.
    const timers = virtualTimers((Math.floor(1_791_000_000_000 / DAY_MS) + 1) * DAY_MS - 10 * 60_000);
    const h = makeWorker({ timers, found: false, fetchedWhy });
    const m = await boot(h);
    const X = sig(11);
    cut(h, X, 1_005n);
    await m.run(2_000, 200, () => m.slot());
    await m.run(CUT_CREATE_RETRY_MS.reduce((a, b) => a + b, 0) + 60_000, 10_000, () => m.slot());
    await settle(h);
    // Its 5 tries, and no more: the new day's re-ask found it running.
    expect(fetchedWhy.filter(([s]) => s === X)).toHaveLength(CUT_CREATE_RETRY_MS.length + 1);
    await h.worker.stop();

    // A fetch that answers found ends its chain; a hole that is somehow still there the next day is asked for again.
    const again: [string, string][] = [];
    const h2 = makeWorker({ found: true, fetchedWhy: again });
    const m2 = await boot(h2);
    cut(h2, X, 1_005n);
    await m2.run(2_000, 200, () => m2.slot());
    expect(again).toEqual([[X, 'cut-create']]);
    await nextDay(h2, m2);
    expect(again).toEqual([[X, 'cut-create'], [X, 'cut-create']]);
    await h2.worker.stop();
  }, 60_000);

  // The red team's original probe (1b5fb0f), restored at the review of #273: a backlog of holes larger than the day's
  // cap (here 3,000 fetches the harness answers "found" without releasing their transactions, so their holes stay). The
  // next day's re-ask goes newest first, so the newest hole X is asked for; the re-asks stop at their share, and a fresh
  // cut log that day is still fetched from the rest of the cap.
  it('original probe: a backlog bigger than the cap; the next UTC day asks for the newest hole first, within its share, and fresh logs keep the rest', async () => {
    const fetchedWhy: [string, string][] = [];
    const h = makeWorker({ found: true, fetchedWhy });
    const m = await boot(h);
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
    const before = fetchedWhy.length;
    await nextDay(h, m);
    expect(h.worker.strategy.deployers.lostCreate(0, now(h))).not.toBeNull();
    // X, the newest, is asked for (once); the day's re-asks stop at their share.
    expect(fetchedWhy.filter(([s]) => s === X)).toEqual([[X, 'cut-create']]);
    expect(fetchedWhy.slice(before)[0]).toEqual([X, 'cut-create']);
    expect(fetchedWhy.length - before).toBe(LOST_CREATE_REASKS_PER_DAY);
    // A fresh cut log that day is fetched from the rest of the cap.
    const Y = sig(CUT_CREATE_FETCHES_PER_DAY + 9);
    cut(h, Y, 1_007n);
    await m.run(2_000, 200, () => m.slot());
    expect(fetchedWhy.filter(([s]) => s === Y)).toEqual([[Y, 'cut-create']]);
    // Later steps of the same day ask no more re-asks.
    await m.run(60_000, 1_000, () => m.slot());
    expect(fetchedWhy.length - before).toBe(LOST_CREATE_REASKS_PER_DAY + 1);
    await h.worker.stop();
  }, 60_000);
});
