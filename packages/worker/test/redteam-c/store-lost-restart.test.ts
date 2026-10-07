// RC-FIXES-2c (S1 on #279): the deployer store keeps the span a full disk made it lose in memory only, until the next
// append that works writes it as closed gaps. A death before that loses the record. This proves the restart covers
// those slots anyway: nothing after the loss reaches the file, so the store's last saved event is before the first lost
// slot, and the restart's seed starts from just after it, as an open downtime gap (no fill) or as the fill's start.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ full: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const appendFileSync = ((path: string, ...rest: unknown[]) => {
    if (disk.full && String(path).endsWith('deployers.jsonl')) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    return (fs.appendFileSync as (...a: unknown[]) => void)(path, ...rest);
  }) as typeof fs.appendFileSync;
  return { ...fs, appendFileSync, default: { ...fs, appendFileSync } };
});
const { Market, T, makeWorker, slotAt, tempState, virtualTimers } = await import('../worker-harness.ts');
const { DeployerStore } = await import('../../src/run/deployer-store.ts');
const { TX_CREATE_PREFIX } = await import('../../../core/src/gates/index.ts');
type SeedRequest = import('../../src/run/worker.ts').SeedRequest;

const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

const firstBoot = async (stateDir: string, timers: ReturnType<typeof virtualTimers>) => {
  const h = makeWorker({ stateDir, timers, seed: async () => ({ mode: 'none' as const, creates: [], coverage: [], report: 'test' }) });
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
  expect(await started).toEqual({ ok: true });
  await m.run(2_000, 400, () => m.slot());
  // The disk fills; a create is released and its append fails. Then the worker dies before any append works again.
  disk.full = true;
  const lostSlot = slotAt(m.now);
  m.create();
  await m.run(1_200, 400, () => m.slot());
  expect(h.logs.some((l) => /Deployer store: an append failed \(ENOSPC\)/.test(l))).toBe(true);
  await h.worker.kill();
  disk.full = false;
  const text = readFileSync(join(stateDir, 'deployers.jsonl'), 'utf8');
  expect(text.includes(TX_CREATE_PREFIX)).toBe(false);
  expect(text.endsWith('\n')).toBe(true);
  return { lostSlot };
};

describe('RC-FIXES-2c: a death before the lost span is written as gaps', () => {
  it('no downtime fill: the restart opens a creates gap from at or before the first lost slot', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const { lostSlot } = await firstBoot(stateDir, timers);
    timers.set(timers.now() + 60_000);
    let req: SeedRequest | undefined;
    const h = makeWorker({ stateDir, timers, seed: async (r) => {
      req = r;
      return { mode: 'none' as const, creates: [], coverage: [], report: 'test' };
    } });
    const m = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m.slot();
    expect(await started).toEqual({ ok: true });
    await m.run(1_000, 400, () => m.slot());
    expect(req!.saved.last!.slot < lostSlot).toBe(true);
    expect(req!.close).not.toBeNull();
    const gaps = new DeployerStore(stateDir).load(0).coverage.filter((e) => e.id === 'worker:downtime-gap');
    expect(gaps).toHaveLength(1);
    const v = (gaps[0]!.value as { value: { fromSlot: bigint; toSlot: bigint | null } }).value;
    expect(v.fromSlot <= lostSlot).toBe(true);
    expect(v.toSlot).toBeNull();
    await h.worker.stop();
  });

  it('a downtime fill starts at or before the first lost slot', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const { lostSlot } = await firstBoot(stateDir, timers);
    timers.set(timers.now() + 60_000);
    let req: SeedRequest | undefined;
    const h = makeWorker({ stateDir, timers, seed: async (r) => {
      req = r;
      return { mode: 'none' as const, creates: [], coverage: [], report: 'test' };
    } });
    const m = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m.slot();
    expect(await started).toEqual({ ok: true });
    // A fill reads creates from the slot after the last saved one (seed-start.ts `fill.fromSlot`): the lost create is in it.
    expect(req!.saved.last!.slot + 1n <= lostSlot).toBe(true);
    expect(req!.saved.creates.some((e) => e.key.startsWith(TX_CREATE_PREFIX))).toBe(false);
    await h.worker.stop();
  });
});
