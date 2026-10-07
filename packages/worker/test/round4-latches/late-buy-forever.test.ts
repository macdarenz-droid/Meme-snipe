// ROUND 4 PARALYSIS PROBE (red team, latches): LATE_BUY halts entries for ever, even after the late position is closed.
// worker.ts:2306 halts on `Object.keys(this.#desk.book.positions).some((id) => lateFillOf(id) !== null)`: every position
// in the book, CLOSED ones included, and the book is rebuilt from the ledger at each start. So one late-landing buy
// (`orphan_fill` of an entry: an attempt that landed after its intent ended, e.g. across a kill in the paper-save /
// ledger-write window) stops every entry permanently: closing the late position does not clear it, a restart does not,
// and no owner control exists. The stated reason (worker.ts:991-993, "while the book holds such a position") is about
// an OPEN, unsettled late position; once it is flat nothing unsettled is held. Non-paralysed behaviour asserted: once
// the late position is no longer open, LATE_BUY leaves the halt. FAILS on cd4d7a6.
// Probe caveat: like paper-settlement.test.ts, the late fill is injected as an `orphan_fill`, so paper's token accounts
// never hold it and every paper sell of it fails "sell beyond balance" (paper-world.ts:342); the position therefore stays
// exit_blocked here. In a real paper late landing the attempt settled in paper's accounts, so it can be sold; the halt
// still never clears because worker.ts:2306 counts CLOSED positions too (static proof: `Object.keys(book.positions)`).
import { describe, expect, it } from 'vitest';
import { isTerminal } from '../../../core/src/lifecycle/index.ts';
import type { Fill } from '../../../core/src/domain/index.ts';
import { LATE_BUY } from '../../src/run/worker.ts';
import { LANDS, Market, makeWorker, passingMarket, until } from '../worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;

describe('round4 latches: LATE_BUY clears when the late position is flat', () => {
  it('a late buy whose position has been closed no longer halts entries (also after a restart)', async () => {
    const noLand = { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n }, dropPpm: 0n };
    const h = makeWorker({ scenario: noLand });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    const ended = () => Object.values(h.worker.book.intents).find((i) => i.intent.purpose === 'entry' && isTerminal(i) && i.fills.length === 0);
    expect(await until(m, 60_000, () => ended() !== undefined, () => { m.slot(); m.pool(); })).toBe(true);
    const i = ended()!;
    const fill = { intentId: i.intent.id, signature: i.attempts[0]!.signature, slot: 1n, commitment: 'confirmed', tokens: 1_000_000n, sol: 20_000_000n, fees: 0n } as Fill;
    h.worker.feed.ingest('worker', { type: 'world', event: { type: 'orphan_fill', fill } }, { receivedAt: m.now });
    m.slot();
    await m.run(800, 100, () => { m.slot(); m.pool(); });
    const pid = `${i.intent.positionId}.o1`;
    expect(h.worker.book.positions[pid]).toBeDefined();
    expect(h.worker.health().halt_reasons).toContain(LATE_BUY);
    await h.worker.stop();
    // A restart where sells land: the late position is flattened (sell-only recovery / its stop).
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, scenario: LANDS });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    await until(m2, 600_000, () => h2.worker.book.positions[pid]?.status === 'closed', () => {
      m2.solPrice();
      m2.slot();
      m2.pool(500_000n);
    });
    // Ten minutes on a live market after the restart: entries must not still be off for this one late buy.
    expect({ lateBuyHalt: h2.worker.health().halt_reasons.includes(LATE_BUY), latePosition: h2.worker.book.positions[pid]?.status })
      .toEqual({ lateBuyHalt: false, latePosition: expect.anything() });
    await h2.worker.stop();
  }, 180_000);
});
