// RC-FIXES-2c (S1 on #279 and #281's review): a full disk makes the deployer store lose events, and the worker dies
// before any write works again. Through the real restart:
// - creates: the first loss wrote open store gaps from the store's reserve; the next load closes them up to the newest
//   saved slot, and the restart's downtime gap starts after it. A loss in the same slot as the last saved event (which
//   the downtime gap alone misses, and a fill would not re-read) is therefore not covered either;
// - rugs: the seed's history (what H14's coverage reads, strategy.ts #seedHistory) carries the saved rugs coverage, and
//   the restart adds an open rugs downtime gap (no fill reads rugs), so rug coverage reads not covered after a restart
//   instead of continuous.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ full: false, freed: false, fullOn: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const appendFileSync = ((path: string, ...rest: unknown[]) => {
    // The disk fills exactly when the first append holding `fullOn` comes (here: the create's).
    if (disk.fullOn !== null && String(path).endsWith('deployers.jsonl') && String(rest[0]).includes(disk.fullOn)) {
      disk.full = true;
      disk.fullOn = null;
    }
    if (disk.full && String(path).endsWith('deployers.jsonl')) {
      // The space the store's reserve gave back takes one small write; anything else on a full disk fails part-way.
      if (disk.freed) {
        disk.freed = false;
        return (fs.appendFileSync as (...a: unknown[]) => void)(path, ...rest);
      }
      fs.appendFileSync(path, String(rest[0]).slice(0, Math.floor(String(rest[0]).length / 2)));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    return (fs.appendFileSync as (...a: unknown[]) => void)(path, ...rest);
  }) as typeof fs.appendFileSync;
  const rmSync = ((path: string, ...rest: unknown[]) => {
    if (disk.full && String(path).endsWith('deployers.jsonl.reserve') && fs.existsSync(path)) disk.freed = true;
    return (fs.rmSync as (...a: unknown[]) => void)(path, ...rest);
  }) as typeof fs.rmSync;
  const out = { ...fs, appendFileSync, rmSync };
  return { ...out, default: out };
});
const { Market, T, makeWorker, slotAt, tempState, virtualTimers } = await import('../worker-harness.ts');
const { DeployerStore, STORE_GAP_VIA } = await import('../../src/run/deployer-store.ts');
const { TX_CREATE_PREFIX, createsCoverage } = await import('../../../core/src/gates/index.ts');
const { SEED_KEY } = await import('../../src/engine/strategy.ts');
const { parseTyped } = await import('../../src/run/json.ts');
type SeedRequest = import('../../src/run/worker.ts').SeedRequest;
type MarketEvent = import('../../../core/src/engine/index.ts').MarketEvent;
type Moment = import('../../../core/src/engine/index.ts').Moment;

const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const DAY = 86_400_000;
const none = async () => ({ mode: 'none' as const, creates: [], coverage: [], report: 'test' });
const val = (e: MarketEvent) => (e.value as { value: Record<string, unknown> }).value;
const history = (facts: readonly MarketEvent[]) => (key: string, _from: Moment, to?: Moment) => facts
  .filter((e) => e.key === key && (to === undefined || e.moment.receivedAt <= to.receivedAt))
  .map((e) => ({ moment: e.moment, value: e.value, source: e.id }));
const at = (ms: number, slot: bigint): Moment => ({ slot, txIndex: 0, ixIndex: 0, receivedAt: ms });

/** Boot 1: creates and rugs coverage start; then a full disk, a create lost in the same slot as a saved rug fact; killed. */
const firstBoot = async (stateDir: string, timers: ReturnType<typeof virtualTimers>) => {
  const h = makeWorker({ stateDir, timers, seed: none });
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
  m.offchain('coverage:rugs:start', { fromSlot: slotAt(m.now), via: VIA });
  expect(await started).toEqual({ ok: true });
  await m.run(2_000, 400, () => m.slot());
  m.slot();
  const lostSlot = slotAt(m.now);
  // A rug fact and the create in one slot: the rug fact is saved, then the disk fills on the create.
  disk.fullOn = TX_CREATE_PREFIX;
  m.fact('rug:SavedInThisSlot', { rug: true });
  m.create();
  await m.run(1_200, 400);
  expect(h.logs.some((l) => /Deployer store: an append failed \(ENOSPC\)/.test(l))).toBe(true);
  await h.worker.kill();
  expect(disk.fullOn).toBeNull();
  disk.full = false;
  disk.freed = false;
  const text = readFileSync(join(stateDir, 'deployers.jsonl'), 'utf8');
  expect(text.includes(TX_CREATE_PREFIX)).toBe(false);
  expect(text.endsWith('\n')).toBe(true);
  return { lostSlot };
};

const restart = async (stateDir: string, timers: ReturnType<typeof virtualTimers>, seed: (r: SeedRequest) => Promise<{ mode: 'none'; creates: never[]; coverage: never[]; report: string }>) => {
  timers.set(timers.now() + 60_000);
  const h = makeWorker({ stateDir, timers, seed });
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  expect(await started).toEqual({ ok: true });
  await m.run(1_000, 400, () => m.slot());
  await h.worker.stop();
  const rec = join(stateDir, 'recorder', h.worker.boot, 'days');
  const frames = readdirSync(rec).flatMap((d) => readdirSync(join(rec, d)).filter((f) => /^frames-\d{3}\.jsonl\.zst$/.test(f)).map((f) => zstdDecompressSync(readFileSync(join(rec, d, f))).toString('utf8')))
    .join('\n').split('\n').filter((l) => l !== '').map((l) => parseTyped(l) as { body: { type: string; key?: string; value?: unknown } });
  const seedFrame = frames.find((f) => f.body.type === 'fact' && f.body.key === SEED_KEY);
  return { seedHistory: (seedFrame!.body.value as { history: MarketEvent[] }).history };
};

describe('RC-FIXES-2c: a death before the deployer store writes its lost span', () => {
  it('creates: a loss in the same slot as the last saved event stays not covered through the restart (the store gap)', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const { lostSlot } = await firstBoot(stateDir, timers);
    let req: SeedRequest | undefined;
    const { seedHistory } = await restart(stateDir, timers, async (r) => {
      req = r;
      return none();
    });
    // The restart's downtime gap starts after the last saved slot, which is the lost slot itself.
    expect(req!.saved.last!.slot).toBe(lostSlot);
    const down = seedHistory.find((e) => e.key === 'coverage:creates:gap' && val(e)['reason'] === 'worker down; no downtime fill')!;
    expect(val(down)['fromSlot']).toBe(lostSlot + 1n);
    // The store's own gap covers the lost slot, closed, in the seed's history.
    const store = seedHistory.filter((e) => e.key === 'coverage:creates:gap' && val(e)['via'] === STORE_GAP_VIA);
    expect(store.map(val)).toEqual([{ fromSlot: lostSlot, toSlot: lostSlot, reason: 'deployer store append failed', via: STORE_GAP_VIA }]);
    // H14's creates coverage, even if a fill had settled the downtime gap: not covered, for the store gap.
    const now = at(timers.now(), 1n << 40n);
    const filled = seedHistory.filter((e) => e !== down);
    // The window from boot 1's own start: the stream ran the whole window, so only a gap can make it not covered.
    const windowStart = Math.min(...filled.filter((e) => e.key === 'coverage:creates:start').map((e) => e.moment.receivedAt));
    expect(createsCoverage(history(filled.filter((e) => val(e)['via'] !== STORE_GAP_VIA)), now, windowStart, 'creates').covered).toBe(true);
    const cov = createsCoverage(history(filled), now, windowStart, 'creates');
    expect(cov.covered).toBe(false);
    expect(cov.covered ? '' : cov.detail).toMatch(new RegExp(`gap ${lostSlot}\\.\\.${lostSlot} on ${STORE_GAP_VIA}`));
  });

  it('rugs: the seed history carries the rugs coverage and a rugs downtime gap; rug coverage reads not covered after the restart', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    await firstBoot(stateDir, timers);
    const { seedHistory } = await restart(stateDir, timers, none);
    expect(seedHistory.some((e) => e.key === 'coverage:rugs:start' && val(e)['via'] === VIA)).toBe(true);
    const gap = seedHistory.find((e) => e.id.startsWith('worker:downtime-gap:rugs'))!;
    expect(gap.key).toBe('coverage:rugs:gap');
    expect(val(gap)).toMatchObject({ toSlot: null, via: VIA, reason: 'worker down; rugs are never filled' });
    // Written to the store too, so a later restart still reads it.
    expect(new DeployerStore(stateDir).load(0).coverage.some((e) => e.id === 'worker:downtime-gap:rugs')).toBe(true);
    const now = at(timers.now(), 1n << 40n);
    expect(createsCoverage(history(seedHistory), now, now.receivedAt - 15 * DAY, 'rugs').covered).toBe(false);
    const liveStart: MarketEvent = { kind: 'market', id: 'live-rugs-start', moment: at(timers.now() - 1_000, 1n << 39n), key: 'coverage:rugs:start', value: { value: { fromSlot: 1n << 39n, via: VIA }, source: 'helius', backfilled: false, seq: 0 } };
    expect(createsCoverage(history([...seedHistory, liveStart]), now, now.receivedAt - 15 * DAY, 'rugs').covered).toBe(false);
  });

  it("the reviewer's model: rugs start 30 d ago, 2 d down, a new start 1 d ago, window 15 d: covered without the downtime gap, not with it", () => {
    const NOW = 1_800_000_000_000;
    const start = (ms: number, id: string): MarketEvent => ({ kind: 'market', id, moment: at(ms, BigInt(ms / 400)), key: 'coverage:rugs:start', value: { value: { fromSlot: BigInt(ms / 400), via: VIA }, source: 'helius', backfilled: false, seq: 0 } });
    const before = start(NOW - 30 * DAY, 'start-30d');
    const after = start(NOW - DAY, 'start-1d');
    const downGap: MarketEvent = { kind: 'market', id: 'worker:downtime-gap:rugs', moment: at(NOW - DAY - 1, BigInt((NOW - 3 * DAY) / 400)), key: 'coverage:rugs:gap', value: { value: { fromSlot: BigInt((NOW - 3 * DAY) / 400), toSlot: null, reason: 'worker down; rugs are never filled', via: VIA }, source: 'worker', backfilled: false, seq: 0 } };
    const now = at(NOW, BigInt(NOW / 400));
    expect(createsCoverage(history([before, after]), now, NOW - 15 * DAY, 'rugs').covered).toBe(true);
    expect(createsCoverage(history([before, downGap, after]), now, NOW - 15 * DAY, 'rugs').covered).toBe(false);
  });
});
