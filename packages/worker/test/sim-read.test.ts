// WORKER-1e: H15's simulation read. A candidate's round trip is simulated at the gate's own spend on the pool the
// worker prices from (SIM-1's simulator, P2, never sent), at most `perHour` an hour; the answer goes onto the feed and
// every attempt is recorded, a skipped one with its reason. No answer is never a pass.
import { describe, expect, it } from 'vitest';
import { fromBase64 } from '../../core/src/chain/index.ts';
import { PUMP_AMM_GLOBAL_CONFIG } from '../../core/src/chain/index.ts';
import type { SimRead } from '../../core/src/facts/raw.ts';
import { CALIBRATION, goldenOf } from '../../core/test/tx/fixtures-policy.ts';
import { goldenAccount } from '../../core/test/tx/helpers.ts';
import { BASE_VAULT, FEE_CONTEXT, QUOTE_VAULT } from '../../core/test/gates/world.ts';
import type { DryRunRpc } from '../src/dryrun/index.ts';
import { RENT_SYSVAR } from '../src/run/live-sim.ts';
import { simReader, type SimReadOptions } from '../src/run/sim-read.ts';
import type { RoundTripRequest, SimResult } from '../src/sim/roundtrip.ts';

const g = goldenOf('pool-buy');
const POOL = g.market;
const MINT = g.mint;
const STAND_IN = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
const SPEND = 13_000_000n;
const HOUR = 3_600_000;

const rent = (): Uint8Array => {
  const b = new Uint8Array(17);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, 2_540n, true);
  v.setFloat64(8, 2, true);
  return b;
};
const acc = (address: string) => {
  const a = goldenAccount(address);
  return { owner: a.owner, data: fromBase64(a.dataBase64), lamports: BigInt(a.lamports) };
};

const setup = (over: Partial<SimReadOptions> = {}, rpcFails = false) => {
  let now = 1_791_039_600_000;
  const reqs: RoundTripRequest[] = [];
  const records: unknown[] = [];
  const reads: SimRead[] = [];
  const rpc = {
    getMultipleAccounts: async (keys: string[], slot: bigint, priority: number) => {
      if (rpcFails) throw new Error('rpc timeout');
      expect(keys).toEqual([POOL, MINT, PUMP_AMM_GLOBAL_CONFIG, RENT_SYSVAR]);
      expect(priority).toBe(2);
      return { slot, accounts: [acc(POOL), acc(MINT), acc(PUMP_AMM_GLOBAL_CONFIG), { owner: 'Sysvar1111111111111111111111111111111111111', data: rent(), lamports: 1n }] };
    },
  } as unknown as DryRunRpc;
  const read = simReader({
    rpc,
    simulator: {
      simulate: async (req): Promise<SimResult> => {
        reqs.push(req);
        const r: SimRead = { mint: MINT, slot: req.minContextSlot, spend: req.spend, ok: true, paid: req.spend, proceeds: req.spend - 1n, error: null };
        return { read: r, record: { mint: MINT, spend: req.spend, outcome: 'simulated', credits: 1 } as never };
      },
    },
    wallet: STAND_IN, calibration: CALIBRATION,
    poolOf: (m) => (m === MINT ? { address: POOL, state: { baseReserve: BASE_VAULT, quoteVault: QUOTE_VAULT, virtualQuoteReserves: 0n }, ctx: FEE_CONTEXT } : null),
    head: () => 452_957_000n, maxSlippageBps: 800, priorityFee: 20_000n, maxPriorityFee: 100_000n, tip: 1_000n, maxTip: 2_000n,
    lamportsPerSignature: 5_000n, now: () => now, perHour: 2, record: (r) => void records.push(r),
    ...over,
  });
  return { read: (m = MINT) => read(m, SPEND, (r) => void reads.push(r)), reqs, records, reads, advance: (ms: number) => void (now += ms) };
};

describe('H15 simulation read', () => {
  it('simulates the round trip at the spend asked, on the priced pool, from the feed head, and puts the answer on the feed', async () => {
    const s = setup();
    expect(await s.read()).toBe(true);
    expect(s.reqs).toHaveLength(1);
    const r = s.reqs[0]!;
    expect(r.spend).toBe(SPEND);
    expect(r.quote.spend).toBe(SPEND);
    expect(r.minContextSlot).toBe(452_957_000n);
    expect(String(r.common.wallet)).toBe(STAND_IN);
    expect(r.venue.venue).toBe('pool');
    expect(s.reads).toEqual([expect.objectContaining({ mint: MINT, spend: SPEND, ok: true })]);
    // The simulation's credit plus the market read's.
    expect(s.records).toEqual([expect.objectContaining({ outcome: 'simulated', credits: 2 })]);
  });

  it('runs at most perHour in any rolling hour; a skipped one is recorded with its reason and puts nothing on the feed', async () => {
    const s = setup();
    expect(await s.read()).toBe(true);
    expect(await s.read()).toBe(true);
    expect(await s.read()).toBe(false);
    expect(s.reqs).toHaveLength(2);
    expect(s.records.at(-1)).toEqual({ mint: MINT, spend: SPEND, outcome: 'not-run', reason: 'hourly cap: 2 simulations in the last hour', credits: 0 });
    s.advance(HOUR);
    expect(await s.read()).toBe(true);
    expect(s.reqs).toHaveLength(3);
    expect(s.reads).toHaveLength(3);
  });

  it('without a stand-in, a pool, a slot or a chain read: no simulation, no fact, the reason recorded', async () => {
    const cases: [Partial<SimReadOptions>, string, boolean, number][] = [
      [{ wallet: null }, 'no stand-in address (ZEROED_STANDINS)', false, 0],
      [{ calibration: null }, 'no compute-unit calibration table', false, 0],
      [{ poolOf: () => null }, 'pool state unknown', false, 0],
      [{ head: () => null }, 'no slot seen yet', false, 0],
      [{}, 'rpc timeout', true, 1],
    ];
    for (const [over, reason, rpcFails, credits] of cases) {
      const s = setup(over, rpcFails);
      expect(await s.read()).toBe(false);
      expect(s.reqs).toEqual([]);
      expect(s.reads).toEqual([]);
      expect(s.records).toEqual([{ mint: MINT, spend: SPEND, outcome: 'not-run', reason, credits }]);
    }
  });
});
