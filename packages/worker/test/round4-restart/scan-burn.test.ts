// ROUND-4 PARALYSIS PROBE (P-3): the complete holder scan (getProgramAccounts) runs inside the batch, alongside the
// bank, and the close waits for it (readers.ts readBatch). A scan slower than about one slot after the bank makes the
// close stale (H16 stale mint/lp). Once a candidate is in `#scanTurn` (source.ts #batchFor), every later batch whose
// reasons are only aged inputs (stale mint/lp/xcheck/sim) scans again: one batch a minute, each a scan off the SHARED
// daily cap (HOLDER_SCANS_PER_DAY = 100). Measured (Helius 400 ms, scan 1.2 s, everything else passing): never entered,
// 18 scans in 20 minutes; over its 3-hour window one such coin alone spends the whole UTC day's cap, after which H12/H13
// are not covered for every other coin until 00:00 UTC (11 AM Melbourne).
// Both tests assert the NON-paralysed behaviour and FAIL on cd4d7a6. Smallest fix: bank last (see P-1), and do not scan
// again on a batch whose reasons are only age when the previous scan's batch closed stale (or cap rescans per coin).
import { describe, expect, it } from 'vitest';
import { blockNetwork } from '../helpers.ts';
import { runRig } from './rig.ts';

blockNetwork();

describe('ROUND-4 P-3: a slow complete scan never lands fresh and burns the shared daily scan cap', () => {
  it('P-3a: a coin whose complete scan answers in 1.2 s (Helius 400 ms otherwise) is entered within 20 minutes', async () => {
    const r = await runRig(29840, { scanMs: 1_200, minutes: 20 });
    expect(r.entered, r.rejects.slice(-2).join('\n')).toBe(true);
  }, 300_000);

  it('P-3b: one coin whose scan batches keep closing stale spends at most 5 of the 100 shared daily scans in 20 minutes', async () => {
    const r = await runRig(29850, { scanMs: 1_200, minutes: 20 });
    const scans = r.chain.calls.filter((c) => c.method === 'getProgramAccounts').length;
    expect(scans).toBeLessThanOrEqual(5);
  }, 300_000);
});
