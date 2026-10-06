// RECORD-BUDGET in the worker: a pass right after the leftovers are sealed (before the deployer store is loaded and
// rewritten), then one a minute beside the memory sample, whether the recorder is on, off or failed. A pass that deletes
// writes a `recorder_prune` line; one that fails, or is still over with nothing left, raises the critical alert at
// most once an hour.
import { linkSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packFile } from '../src/persist/index.ts';
import { runSeed } from '../src/run/seed-start.ts';
import { SAVED_STATES, type SeedRequest } from '../src/run/worker.ts';
import { Market, T, makeWorker, slotAt, tempState, virtualTimers } from './worker-harness.ts';

const GiB = 1024 ** 3;
const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const emptyRpc = { getSignaturesForAddress: async () => [{ signature: 'before-the-range', slot: 0n, err: null, blockTime: 0 }], getTransaction: async () => null };
const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
const OLD = `${(T - 30 * 86_400_000).toString(36)}-1`;
const put = (path: string, bytes: number | string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 7));
};
const turns = async (n: number): Promise<void> => {
  for (let k = 0; k < n; k++) await new Promise<void>((r) => setImmediate(r));
};

const boot = async (h: ReturnType<typeof makeWorker>) => {
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
  expect(await started).toEqual({ ok: true });
  return m;
};

type Manifest = { days: { files: { path: string }[] }[]; pruned: { path: string; bytes: number; sha256: string | null; reason: string }[] };

describe('the recorder budget in the worker (RECORD-BUDGET)', () => {
  it('T8, T4: the start pass runs before the deployer store loads, the minute pass deletes the running boot\'s sealed files, and the recorder stays on', async () => {
    const stateDir = tempState();
    const old = join(stateDir, 'recorder', OLD, 'days', '2026-09-01', 'frames-000.jsonl.zst');
    put(old, 5_000);
    const deployers = join(stateDir, 'deployers.jsonl');
    put(deployers, 'not an event\n');
    const ino = statSync(deployers).ino;
    // The fake statfs notes the deployer store's file at each pass: its load rewrites it (a new inode).
    const seen: number[] = [];
    const timers = virtualTimers(T);
    const h = makeWorker({ stateDir, timers, recorderRotateBytes: 2_048, config: { ZEROED_RECORDER_MAX_BYTES: '1' }, diskFree: () => (seen.push(statSync(deployers).ino), 100 * GiB) });
    expect(seen).toEqual([ino]);
    expect(statSync(deployers).ino).not.toBe(ino);
    expect(existsSync(join(stateDir, 'recorder', OLD))).toBe(false);
    const m = await boot(h);
    await m.run(120_000, 1_000, () => m.slot());
    expect(seen.length).toBeGreaterThan(1);
    const lines = journal(stateDir).filter((l) => l['boot'] === h.worker.boot);
    expect(lines[0]!['kind']).toBe('start');
    const prunes = lines.filter((l) => l['kind'] === 'recorder_prune');
    expect(prunes[0]).toMatchObject({ reason: 'cap', boots: 1, files: 1, bytes: 5_000 });
    expect(prunes.length).toBeGreaterThan(1);
    for (const p of prunes) expect(Object.keys(p)).toEqual(expect.arrayContaining(['reason', 'files', 'bytes', 'boots', 'free_bytes', 'recorder_bytes']));
    // A cap of one byte cannot be met (the manifest stays): the alert goes up once in the hour, and /health lists it.
    expect(lines.filter((l) => l['kind'] === 'alert' && l['code'] === 'recorder_budget')).toHaveLength(1);
    const health = h.worker.health();
    expect(health.recorder).toBe('on');
    expect(health.critical.some((c) => c.startsWith('recordings at'))).toBe(true);
    await h.worker.stop();
    const man = JSON.parse(readFileSync(join(stateDir, 'recorder', h.worker.boot, 'manifest.json'), 'utf8')) as Manifest;
    expect(man.pruned.length).toBeGreaterThan(0);
    for (const p of man.pruned) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(stateDir, 'recorder', h.worker.boot, p.path))).toBe(false);
    }
    // No number of a deleted file is used again (the high-water mark).
    const listed = man.days.flatMap((d) => d.files.map((f) => f.path));
    expect(listed.filter((f) => man.pruned.some((p) => p.path === f))).toEqual([]);
    expect(h.logs.some((l) => l.startsWith('Recorder failed'))).toBe(false);
  }, 60_000);

  it('T2: under the floor with nothing to delete, the alert is written and nothing throws; a pass that fails alerts too', async () => {
    const low = makeWorker({ diskFree: () => 0 });
    const alerts = journal(low.stateDir).filter((l) => l['kind'] === 'alert' && l['code'] === 'recorder_budget');
    expect(alerts).toHaveLength(1);
    expect((alerts[0]!['reasons'] as string[])[0]).toMatch(/^disk low: 0 bytes free, under the floor of 3221225472/);
    expect(low.logs.some((l) => l.startsWith('ALERT disk low'))).toBe(true);
    expect(low.worker.health().recorder).toBe('on');
    await low.worker.kill();
    const failing = makeWorker({ diskFree: () => {
      throw new Error('statfs failed');
    } });
    expect(journal(failing.stateDir).filter((l) => l['kind'] === 'alert' && l['code'] === 'recorder_budget').map((l) => (l['reasons'] as string[])[0])).toEqual(['recorder budget pass failed: Error: statfs failed']);
    await failing.worker.kill();
    // The recorder off: the pass still runs.
    const off = makeWorker({ diskFree: () => 0, config: { ZEROED_RECORDER: 'off' } });
    expect(off.logs.some((l) => l.startsWith('ALERT disk low'))).toBe(true);
    await off.worker.kill();
  });

  it('T6: a past boot\'s folder that goes while the leftovers are sealed causes no recorder fault', async () => {
    const stateDir = tempState();
    mkdirSync(join(stateDir, 'recorder', OLD, 'days'), { recursive: true });
    symlinkSync(join(stateDir, 'gone'), join(stateDir, 'recorder', OLD, 'days', '2026-09-01'));
    const h = makeWorker({ stateDir });
    expect(h.worker.health().recorder).toBe('on');
    expect(h.logs.some((l) => l.startsWith('Recorder failed'))).toBe(false);
    await h.worker.kill();
  });

  it('T7: a stored saved state no boot links to goes only once the pack is done', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers });
    const first = makeWorker({ stateDir, timers, seed });
    const m = await boot(first);
    m.create();
    await m.run(1_000, 200, () => m.slot());
    await first.worker.stop();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let free = 100 * GiB;
    const h = makeWorker({ stateDir, timers, seed, diskFree: () => free, pack: async (path, content) => (await gate, packFile(path, content)) });
    const started = h.worker.start();
    for (let k = 0; k < 200 && !h.order.includes('start helius-ws'); k++) await turns(1);
    // An unlinked store file appears, and the disk runs low while the pack is held.
    const orphan = join(stateDir, 'recorder', SAVED_STATES, `${'d'.repeat(64)}.zst`);
    put(orphan, 1_000);
    const linked = join(stateDir, 'recorder', SAVED_STATES, `${'e'.repeat(64)}.zst`);
    put(linked, 1_000);
    linkSync(linked, join(stateDir, 'recorder', h.worker.boot, 'kept-link.zst'));
    free = 0;
    const passes = (): number => journal(stateDir).filter((l) => l['boot'] === h.worker.boot && l['kind'] === 'alert' && l['code'] === 'recorder_budget').length;
    for (let k = 0; k < 100 && passes() === 0; k++) await turns(1);
    expect(passes()).toBe(1);
    expect(existsSync(orphan)).toBe(true);
    release();
    await h.worker.whenPacked();
    for (let k = 0; k < 100 && existsSync(orphan); k++) await turns(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(linked)).toBe(true);
    await h.worker.stop();
    await started;
  }, 60_000);
});
