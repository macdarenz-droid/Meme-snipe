// RC-H4 (red team C, docs/redteam-c/REPORT.md on claude/redteam-c): an exit intent stuck past its deadline must reach the
// watchdog's intent alert, in this process and after a restart. Before: intent times were kept only for entries and
// only in memory, so a stuck exit, or any intent restored after a restart, reported `oldest_age_s: null` and the
// watchdog never alerted.
import { describe, expect, it } from 'vitest';
import type { BookEvent } from '../../../core/src/lifecycle/index.ts';
import { evaluate, limitsFrom, parseHeartbeat } from '../../../ops/src/watchdog/logic.ts';
import { heartbeatBody } from '../../src/run/heartbeat.ts';
import type { Health } from '../../../runner/src/contract.ts';
import { Market, makeWorker, passingMarket, until } from '../worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const HELD = { heldPoolFacts: true } as const;
const L = limitsFrom({});
const tick = (m: Market, scalePpm = 1_000_000n) => (): void => {
  m.slot();
  m.pool(scalePpm);
};
const alerts = (h: Health, now: number) => evaluate({ hb: parseHeartbeat(heartbeatBody(h, null, null))!, receivedAt: now }, now, L, { slot: null, heldMints: null }).map((a) => a.key);
const stuckExits = (h: H) => Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'exit' && ['submitted', 'pending', 'unknown'].includes(i.status));

describe('RC-H4: a stuck exit intent alerts the owner, also after a restart', () => {
  it('an exit that never resolves is aged from its decision; past the deadline the watchdog alerts, and the restart keeps its age', async () => {
    let h: H | null = null;
    // The paper world accepts the exit's send, then nothing about it ever comes back (no status, no fill, no expiry).
    const silent = (e: BookEvent): BookEvent | null => {
      if (h === null) return e;
      const exitLive = stuckExits(h).length > 0;
      if (e.type === 'tick' && exitLive) return null;
      if (e.type === 'intent' && h.worker.book.intents[e.intentId]?.intent.purpose === 'exit' && e.event.type !== 'send_accepted') return null;
      return e;
    };
    h = makeWorker({ worldFault: silent });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    expect(await until(m, 30_000, () => Object.values(h!.worker.book.positions).some((p) => p.status === 'open'), tick(m))).toBe(true);
    // The price falls through the stop: the exit is decided and sent, then stays unresolved.
    expect(await until(m, 30_000, () => stuckExits(h!).length === 1, tick(m, 700_000n))).toBe(true);
    const decidedAt = h.timers.now();
    expect(h.worker.health().unresolved_intents).toMatchObject({ count: 1, oldest_age_s: expect.any(Number) });
    await until(m, 120_000, () => h!.worker.health().unresolved_intents.oldest_age_s! > L.intentMaxAgeS, () => m.slot());
    const before = h.worker.health();
    expect(stuckExits(h)).toHaveLength(1);
    expect(before.unresolved_intents.oldest_age_s).toBeGreaterThan(L.intentMaxAgeS);
    expect(before.unresolved_intents.oldest_age_s).toBeLessThanOrEqual(Math.ceil((h.timers.now() - decidedAt) / 1000) + 30);
    expect(alerts(before, before.ts)).toContain('intent');
    await h.worker.kill();

    // The restart: the restored exit keeps the age the ledger shows, before the reconcile settles it.
    h.timers.set(h.timers.now() + 30_000);
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    const after = h2.worker.health();
    expect(after.unresolved_intents.count).toBe(1);
    expect(after.unresolved_intents.oldest_age_s).toBeGreaterThanOrEqual(before.unresolved_intents.oldest_age_s! + 30);
    expect(alerts(after, after.ts)).toContain('intent');
    await h2.worker.stop();
  });
});
