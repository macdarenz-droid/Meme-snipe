// RC-FIXES-2c (#281 review item 3): a restart's downtime fill reads creates from the first slot after the last saved one
// (seed-start.ts runSeed → buildSeed fill.fromSlot), so a span the store lost after its last saved event is re-read.
// buildSeed is captured; nothing is fetched.
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as unknown[]);
vi.mock('../../src/seed/seed.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/seed/seed.ts')>();
  return {
    ...real,
    buildSeed: async (o: unknown) => {
      calls.push(o);
      return { creates: [], coverage: [], report: { mode: 'fill', creates: 0, gaps: [], rpc: null } };
    },
  };
});
const { runSeed } = await import('../../src/run/seed-start.ts');
const { ManualTimers } = await import('../../src/scheduler/index.ts');

const asOf = { slot: 1_000n, txIndex: 0, ixIndex: 0, receivedAt: 2_000 };
const req = (last: { slot: bigint; ms: number } | null, untilSlot: bigint) => ({
  saved: { creates: [], rugs: [], coverage: [], last }, close: { via: 'logs:V', fromSlot: null }, untilSlot, liveStart: null, asOf, signal: new AbortController().signal,
});

describe('RC-FIXES-2c: the downtime fill starts at the first slot after the last saved one', () => {
  it('fill.fromSlot = last.slot + 1, from the last saved moment', async () => {
    calls.length = 0;
    await runSeed(req({ slot: 500n, ms: 1_500 }, 900n) as never, { rpc: {} as never, timers: new ManualTimers(2_000) });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { fill: { fromSlot: bigint; fromMs: number } }).fill).toMatchObject({ fromSlot: 501n, fromMs: 1_500 });
  });

  it('never past the live watch: a last saved slot at or after untilSlot starts the fill at untilSlot + 1', async () => {
    calls.length = 0;
    await runSeed(req({ slot: 950n, ms: 1_900 }, 900n) as never, { rpc: {} as never, timers: new ManualTimers(2_000) });
    expect((calls[0] as { fill: { fromSlot: bigint } }).fill.fromSlot).toBe(901n);
  });

  it('a first start (nothing saved) reads no history', async () => {
    calls.length = 0;
    await runSeed(req(null, 900n) as never, { rpc: {} as never, timers: new ManualTimers(2_000) });
    expect((calls[0] as { fill?: unknown }).fill).toBeUndefined();
  });
});
