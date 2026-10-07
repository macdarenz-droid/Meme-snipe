// Round 4 red team, paralysis hunt. P-CAPS-WRITE: FAILS on integration commit cd4d7a6.
// worker.ts #takeFetch (about line 1632): when the fetch-caps.json save throws ONCE (a transient EIO/ENOSPC, the file
// briefly unwritable), the kind's count is set to the whole day's cap, so every later cut-creates-log fetch that UTC day
// is refused even after the disk is fine again. Each unfetched cut create (~2,000 a day, S1) is a hole H14 refuses
// across for every coin: 14 days without the S0 diagnostic, and with it until a later lossy coverage event moves the
// creates coverage start past the hole. Refusing the one fetch whose count could not be saved is the proven-safe part;
// spending the rest of the day is not. Non-paralysed behaviour asserted: after one failed save, once the file can be
// written again, the next cut create is fetched.
import { mkdirSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchCapsFile } from '../../src/run/state.ts';
import { Market, makeWorker } from '../worker-harness.ts';

describe('round 4 paralysis: one failed fetch-caps save', () => {
  const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const sig = (k: number) => `${B58[k % 58]}${B58[Math.floor(k / 58)]}${'4'.repeat(86)}`;

  it('P-CAPS-WRITE: a single failed save does not refuse every cut-create fetch for the rest of the UTC day', async () => {
    const fetchedWhy: [string, string][] = [];
    const h = makeWorker({ found: true, fetchedWhy });
    await h.worker.reconcile();
    const m = new Market(h);
    m.slot(1_000n);
    m.offchain('coverage:creates:start', { fromSlot: 900n, via: VIA });
    await m.run(1_000, 200, () => m.slot());
    const cut = (signature: string, slot: bigint) =>
      h.worker.feed.ingest('helius', { type: 'logs', signature, slot, err: null, via: VIA, logs: ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]', 'Log truncated'] }, { receivedAt: h.timers.now() });
    // Control: a cut create is fetched while the file saves.
    cut(sig(1), 1_002n);
    await m.run(1_000, 200, () => m.slot());
    expect(fetchedWhy.filter(([, w]) => w === 'cut-create').map(([s]) => s)).toEqual([sig(1)]);
    // The save fails once: the file's path is briefly a directory, so the write's rename throws.
    const path = fetchCapsFile(h.stateDir).path;
    rmSync(path, { force: true });
    mkdirSync(path);
    cut(sig(2), 1_004n);
    await m.run(1_000, 200, () => m.slot());
    rmSync(path, { recursive: true, force: true });
    // The disk is fine again: the next cut create, minutes later the same day, must be fetched.
    cut(sig(3), 1_006n);
    await m.run(1_000, 200, () => m.slot());
    await h.worker.stop();
    expect(fetchedWhy.filter(([, w]) => w === 'cut-create').map(([s]) => s)).toContain(sig(3));
  });
});
