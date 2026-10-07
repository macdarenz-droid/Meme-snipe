// RED TEAM C: the host's hourly backup (ops/host/files/usr/local/sbin/zeroed-backup) packs only SQLite files
// (`find -name '*.sqlite' -o -name '*.db'`). A host-loss restore therefore brings back ledger.sqlite alone, and the
// worker, seeing a ledger, boots as a normal restart: control.json (the R10 kill latch, the R9 weekly latch, the owner's
// pause), account.json (paper wallet, R11 entry count, NAV peak, day marks) and credits.json read as their defaults.
// Golden rule: a kill switch the owner never re-armed must not come back un-latched.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOL_PRICE_KEY } from '../../src/engine/strategy.ts';
import { controlFile, NO_CONTROL } from '../../src/run/state.ts';
import { Market, SOL_PRICE, makeWorker } from '../worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const priced = (h: H, m: Market, ppm: bigint): void => {
  m.slot();
  m.fact(SOL_PRICE_KEY, { value: (SOL_PRICE * ppm) / 1_000_000n, atMs: m.now - 50 });
  h.worker.step();
};
/**
 * What `zeroed-backup` keeps. RC-STATE (builder): it packed the SQLite files only when this probe was written (959d801);
 * it now packs the whole state dir but the journal, the recording, the deployer index, WAL, lock and temp files and the
 * one-boot markers (ops/test/backup-state.test.ts). Everything it leaves out is gone after a host loss.
 */
const hostLossRestore = (dir: string): string[] => {
  const gone: string[] = [];
  const kept = (name: string): boolean => /\.(sqlite|db)$/.test(name)
    || (!/^journal\.jsonl/.test(name) && name !== 'recorder' && name !== 'deployers.jsonl' && name !== 'deployer-state.json'
      && !/\.(lock|tmp|new)$/.test(name) && !/-(wal|shm|journal|writer\.lock)$/.test(name)
      && !['clean_stop', 'planned_restart', 'cold_start', 'drill.token', 'last_exit.json', 'refused.json'].includes(name));
  for (const name of readdirSync(dir)) {
    if (kept(name)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    gone.push(name);
  }
  return gone;
};

describe('red team C: host-loss restore from the SQLite-only backup', () => {
  it('a latched kill switch survives the restore, or the worker refuses to start without it', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    await m.run(4_000, 400, () => priced(h, m, 1_000_000n));
    // SOL at 44%: NAV under the kill line; R10 latches. Then the price recovers.
    await m.run(4_000, 400, () => priced(h, m, 440_000n));
    const at = controlFile(h.stateDir).read(NO_CONTROL).latches.killTrippedAtMs;
    expect(at).not.toBeNull();
    await m.run(2_000, 400, () => priced(h, m, 1_000_000n));
    await h.worker.stop();

    const gone = hostLossRestore(h.stateDir);
    // RC-STATE (builder): the backup now keeps control.json and the state-version marker; it is the journal and the
    // recording that are gone.
    expect(gone).not.toContain('control.json');
    expect(gone).toContain('journal.jsonl');
    let started = false;
    let latch: number | null = null;
    try {
      const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
      started = (await h2.worker.reconcile()).ok === true;
      const m2 = new Market(h2);
      await m2.run(2_000, 400, () => priced(h2, m2, 1_000_000n));
      latch = controlFile(h2.stateDir).read(NO_CONTROL).latches.killTrippedAtMs;
      await h2.worker.stop();
    } catch {
      started = false;
    }
    expect(!started || latch !== null, `restored files lost: ${gone.join(', ')}; worker started=${started}, killTrippedAtMs=${latch}`).toBe(true);
  });
});
