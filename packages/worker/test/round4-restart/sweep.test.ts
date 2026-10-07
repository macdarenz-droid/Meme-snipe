// Measurement only (not a probe): the latency at which a fully passing candidate is still entered live.
import { describe, expect, it } from 'vitest';
import { blockNetwork } from '../helpers.ts';
import { runRig, SLOT_MS } from './rig.ts';

blockNetwork();

describe('sweep', () => {
  for (const [rpc, x, sim] of [[1, 400, 400], [1, 500, 400], [1, 600, 400], [1, 400, 600], [1, 1200, 400]] as const) {
    it(`rpc ${rpc} slots, xcheck ${x} ms, sim ${sim} ms`, async () => {
      const r = await runRig(29000 + rpc * 100 + x / 10 + sim / 100, { slotsPerCall: rpc, xcheckMs: x, simMs: sim });
      console.log(`SWEEP rpc=${rpc * SLOT_MS}ms xcheck=${x}ms sim=${sim}ms entered=${r.entered} closes=${r.atClose.length} lastClose=${r.atClose.at(-1)?.slice(0, 200)}`);
      expect(true).toBe(true);
    }, 120_000);
  }
});
