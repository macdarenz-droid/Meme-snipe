// RC-STATE (red team B, RB-14): the hourly backup keeps deployer-state.json, which holds the regime's graduates series
// and A2-GATE's saved holes (PERSIST-2). A host-loss restore from it brings the survival history back, so no entry is
// judged on a series rebuilt from nothing; restored without it, survival is unknown (the regime fails closed) until
// about 15 days of graduates are seen again (14 daily shares and the last 24 h, DECISIONS "regime gate").
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { GRADUATES_KEY, survivalCondition } from '../../core/src/gates/index.ts';
import { runSeed } from '../src/run/seed-start.ts';
import type { SeedRequest } from '../src/run/worker.ts';
import { Market, T, makeWorker, slotAt, tempState, virtualTimers } from './worker-harness.ts';

const emptyRpc = { getSignaturesForAddress: async () => [{ signature: 'before-the-range', slot: 0n, err: null, blockTime: 0 }], getTransaction: async () => null };
const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

const boot = async (h: ReturnType<typeof makeWorker>) => {
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
  expect(await started).toEqual({ ok: true });
  await m.run(3_000, 400, () => m.slot());
  return m;
};

/** What zeroed-backup packs (ops/test/backup-state.test.ts): everything but the journal, the recording, the deployer
 * store, WAL, lock and temp files and the one-boot markers. */
const restore = (from: string, drop: readonly string[] = []): string => {
  const to = mkdtempSync(join(tmpdir(), 'restored-'));
  const left = (n: string) => /^journal\.jsonl/.test(n) || n === 'recorder' || n === 'deployers.jsonl' || /\.(lock|tmp|new)$/.test(n)
    || /-(wal|shm|journal|writer\.lock)$/.test(n) || ['clean_stop', 'planned_restart', 'cold_start', 'drill.token', 'last_exit.json', 'refused.json'].includes(n);
  for (const n of readdirSync(from)) if (!left(n) && !drop.includes(n)) cpSync(join(from, n), join(to, n), { recursive: true });
  return to;
};

describe('RC-STATE (RB-14): the regime\'s graduates series comes back with a restore', () => {
  it('restored from the backup, survival is known at once; restored without deployer-state.json, it is unknown (fail closed)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const h = makeWorker({ stateDir, timers, seed });
    const m = await boot(h);
    const P = TRIAL_POLICY.regime;
    // 16 days of graduates, one every 6 hours (as PERSIST-2's test).
    const items = Array.from({ length: 64 }, (_, k) => ({ mint: `Grad${k}`, migratedAtMs: m.now - 2 * 3_600_000 - k * 6 * 3_600_000, reserveAfter: k % 3 === 0 ? 1n : 100_000_000_000n }))
      .sort((a, b) => a.migratedAtMs - b.migratedAtMs);
    m.fact(GRADUATES_KEY, { obs: { provider: 'facts', slot: null, receivedAt: m.now, quality: [] }, items });
    await m.run(1_000, 200, () => m.slot());
    await h.worker.stop();
    timers.set(timers.now() + 10 * 60_000);

    const whole = restore(stateDir);
    expect(readdirSync(whole)).toContain('deployer-state.json');
    const h2 = makeWorker({ stateDir: whole, timers, seed });
    const m2 = await boot(h2);
    const back = h2.worker.strategy.persistable(0)?.state.graduates;
    expect(back?.items).toEqual(items);
    expect(survivalCondition({ obs: { provider: 'facts', slot: null, receivedAt: m2.now, quality: [] }, items: back!.items }, m2.now, P).ok).not.toBeNull();
    expect(h2.worker.health().graduates_seed).toEqual({ source: 'persist', accepted: true, added: items.length, reason: null });
    await h2.worker.stop();

    const without = restore(stateDir, ['deployer-state.json']);
    const h3 = makeWorker({ stateDir: without, timers, seed });
    const m3 = await boot(h3);
    const none = h3.worker.strategy.persistable(0)?.state.graduates?.items ?? [];
    expect(none).toEqual([]);
    expect(survivalCondition({ obs: { provider: 'facts', slot: null, receivedAt: m3.now, quality: [] }, items: none }, m3.now, P).ok).toBeNull();
    await h3.worker.stop();
    for (const d of [whole, without]) rmSync(d, { recursive: true, force: true });
  }, 60_000);
});
