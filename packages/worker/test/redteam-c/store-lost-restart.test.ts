// RC-FIXES-2c (S1 on #279): the deployer store keeps the span a full disk made it lose in memory only, until the next
// append that works writes it as closed gaps. A death before that loses the record. This proves the restart covers
// those slots anyway: nothing after the loss reaches the file, so the store's last saved event is before the first lost
// slot, and the restart's seed starts from just after it, as an open downtime gap (no fill) or as the fill's start.
// The rugs half: a start never seeds rug coverage (seed.ts RUGS_NOT_SEEDED), so H14's rug coverage reads not covered
// after any restart until a new start is older than the look-back (an on-demand deployer check can still cover one
// creator, from a fresh read).
import { readdirSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ full: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const appendFileSync = ((path: string, ...rest: unknown[]) => {
    if (disk.full && String(path).endsWith('deployers.jsonl')) {
      // A full disk takes part of the write, then fails.
      fs.appendFileSync(path, String(rest[0]).slice(0, Math.floor(String(rest[0]).length / 2)));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    return (fs.appendFileSync as (...a: unknown[]) => void)(path, ...rest);
  }) as typeof fs.appendFileSync;
  return { ...fs, appendFileSync, default: { ...fs, appendFileSync } };
});
const { Market, T, makeWorker, slotAt, tempState, virtualTimers } = await import('../worker-harness.ts');
const { DeployerStore } = await import('../../src/run/deployer-store.ts');
const { TX_CREATE_PREFIX } = await import('../../../core/src/gates/index.ts');
const { SEED_KEY } = await import('../../src/engine/strategy.ts');
const { parseTyped } = await import('../../src/run/json.ts');
const { createsCoverage } = await import('../../../core/src/gates/index.ts');
type SeedRequest = import('../../src/run/worker.ts').SeedRequest;
type MarketEvent = import('../../../core/src/engine/index.ts').MarketEvent;
type Moment = import('../../../core/src/engine/index.ts').Moment;

const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

const firstBoot = async (stateDir: string, timers: ReturnType<typeof virtualTimers>) => {
  const h = makeWorker({ stateDir, timers, seed: async () => ({ mode: 'none' as const, creates: [], coverage: [], report: 'test' }) });
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
  m.offchain('coverage:rugs:start', { fromSlot: slotAt(m.now), via: VIA });
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

    // The rugs half: the store kept the first boot's rugs start, but the restart's seed (as recorded) carries creates
    // coverage only, so after the restart H14's rug coverage is not covered, with or without a new live rugs start.
    expect(new DeployerStore(stateDir).load(0).coverage.some((e) => e.key === 'coverage:rugs:start')).toBe(true);
    const rec = join(stateDir, 'recorder', h.worker.boot, 'days');
    const frames = readdirSync(rec).flatMap((d) => readdirSync(join(rec, d)).filter((f) => /^frames-\d{3}\.jsonl\.zst$/.test(f)).map((f) => zstdDecompressSync(readFileSync(join(rec, d, f))).toString('utf8')))
      .join('\n').split('\n').filter((l) => l !== '').map((l) => parseTyped(l) as { body: { type: string; key?: string; value?: unknown } });
    const seed = frames.find((f) => f.body.type === 'fact' && f.body.key === SEED_KEY);
    const seeded = (seed!.body.value as { coverage: MarketEvent[] }).coverage;
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((e) => e.key.startsWith('coverage:creates:'))).toBe(true);
    const now: Moment = { slot: 1n << 40n, txIndex: 0, ixIndex: 0, receivedAt: timers.now() };
    const windowStart = now.receivedAt - 15 * 86_400_000;
    const history = (facts: readonly MarketEvent[]) => (key: string, _from: Moment, to?: Moment) => facts
      .filter((e) => e.key === key && (to === undefined || e.moment.receivedAt <= to.receivedAt))
      .map((e) => ({ moment: e.moment, value: e.value, source: e.id }));
    const none = createsCoverage(history(seeded), now, windowStart, 'rugs');
    expect(none).toEqual({ covered: false, detail: 'no rugs coverage start' });
    const liveStart: MarketEvent = { kind: 'market', id: 'live-rugs-start', moment: { slot: 1n << 39n, txIndex: 0, ixIndex: 0, receivedAt: timers.now() - 60_000 }, key: 'coverage:rugs:start', value: { value: { fromSlot: 1n << 39n, via: VIA }, source: 'helius', backfilled: false, seq: 0 } };
    const afterStart = createsCoverage(history([...seeded, liveStart]), now, windowStart, 'rugs');
    expect(afterStart.covered).toBe(false);
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
