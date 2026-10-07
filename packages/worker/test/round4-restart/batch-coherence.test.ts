// ROUND-4 PARALYSIS PROBE (P-1, P-2): a READ-COHERENT batch fires its bank (mint, pool, LP: judged by slot lag, 2 slots)
// at the SAME time as the cross-checks and the simulation (judged by age, 2 s), and closes only when the slowest part
// has answered (readers.ts readBatch: `Promise.all(parts)` before the close). So any off-chain part slower than about one
// slot after the bank turns into chain staleness at the close (H16 stale mint/lp), every minute, for the whole window.
// Measured with the real LiveFacts + FactReaders + LiveStrategy (rig.ts, a copy of read-coherent.test.ts's rig):
//   Helius 400 ms, RugCheck/GoPlus 400 ms, sim 400 ms  -> entered (read-coherent.test.ts's own numbers)
//   Helius 400 ms, RugCheck/GoPlus 500 ms              -> never entered in 5 min (H16 stale mint at every close)
//   Helius 400 ms, sim 600 ms                          -> never entered
//   Helius 400 ms, cross-checks 400 ms, but another candidate's batch took RugCheck's / GoPlus's free-tier window
//   (1 per 4.5 s / 1 per 5 s, limits.ts) just before ours                -> never entered
// Measured 7 Oct 2026 from the build sandbox (curl, 3 tries each): RugCheck /v1/tokens/<mint>/report 1.00-1.04 s,
// GoPlus solana token_security 0.57-0.98 s; both above the ~0.5 s the batch tolerates.
// Each test asserts the NON-paralysed behaviour (a fully passing candidate is entered within 5 minutes) and FAILS on
// cd4d7a6. Smallest fix: run the bank as the batch's last round, after the off-chain parts have answered (they have a
// 2 s age budget, the bank 2 slots), so the close lands one RPC round after the bank whatever the third parties do.
import { describe, expect, it } from 'vitest';
import { P2 } from '../../src/scheduler/index.ts';
import { blockNetwork } from '../helpers.ts';
import { runRig } from './rig.ts';

blockNetwork();

describe('ROUND-4 P-1/P-2: one slow off-chain part makes every batch stale', () => {
  it('P-1a: cross-checks answering in 1 s (measured RugCheck /report latency; Helius in 400 ms): a fully passing candidate is still entered within 5 minutes', async () => {
    const r = await runRig(29810, { xcheckMs: 1_000 });
    expect(r.entered, r.rejects.slice(-2).join('\n')).toBe(true);
  }, 120_000);

  it('P-1b: a simulation answering in 600 ms (Helius in 400 ms): a fully passing candidate is still entered within 5 minutes', async () => {
    const r = await runRig(29820, { simMs: 600 });
    expect(r.entered, r.rejects.slice(-2).join('\n')).toBe(true);
  }, 120_000);

  it('P-2: a second candidate\'s batch takes the RugCheck/GoPlus free-tier window just before ours: ours is still entered within 5 minutes', async () => {
    const r = await runRig(29830, {
      beforeBatch: ({ rugcheck, goplus }) => {
        // Another candidate in its window, batched in the same LiveFacts step a moment earlier (FACT_READS_IN_FLIGHT = 4).
        void rugcheck.run(P2, 0, () => Promise.resolve(null)).catch(() => undefined);
        void goplus.run(P2, 0, () => Promise.resolve(null)).catch(() => undefined);
      },
    });
    expect(r.entered, r.rejects.slice(-2).join('\n')).toBe(true);
  }, 120_000);
});
