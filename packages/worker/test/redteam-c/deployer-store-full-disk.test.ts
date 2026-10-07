// RC-FIXES-2b/2c (S1, from #149 DISK-GUARD): a full disk while the deployer store appends must never crash the worker,
// and must never leave lost slots read as covered after a restart. The disk is modelled as a byte budget: an append
// past it writes what fits and fails (ENOSPC); removing the store's reserve file gives its bytes back.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ free: Number.POSITIVE_INFINITY }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const take = (path: string, data: string | Buffer, write: (d: string | Buffer) => void) => {
    const n = Buffer.byteLength(data as string);
    if (n <= disk.free) {
      disk.free -= n;
      return write(data);
    }
    const fit = Math.max(0, disk.free);
    disk.free = 0;
    if (fit > 0) write(Buffer.from(data as string).subarray(0, fit));
    throw Object.assign(new Error(`no space left on device, write ${path}`), { code: 'ENOSPC' });
  };
  const appendFileSync = ((path: string, data: string) => take(String(path), data, (d) => fs.appendFileSync(path, d))) as typeof fs.appendFileSync;
  const writeFileSync = ((path: string, data: string | Buffer, ...rest: unknown[]) => (String(path).endsWith('.reserve')
    ? take(String(path), data, (d) => (fs.writeFileSync as (...a: unknown[]) => void)(path, d, ...rest))
    : (fs.writeFileSync as (...a: unknown[]) => void)(path, data, ...rest))) as typeof fs.writeFileSync;
  const rmSync = ((path: string, ...rest: unknown[]) => {
    if (String(path).endsWith('.reserve') && fs.existsSync(path)) disk.free += fs.statSync(path).size;
    return (fs.rmSync as (...a: unknown[]) => void)(path, ...rest);
  }) as typeof fs.rmSync;
  const out = { ...fs, appendFileSync, writeFileSync, rmSync };
  return { ...out, default: out };
});
const { DeployerStore, STORE_GAP_VIA, STORE_RESERVE_BYTES } = await import('../../src/run/deployer-store.ts');
const { parseTyped } = await import('../../src/run/json.ts');

const tmp = mkdtempSync(join(tmpdir(), 'rc-store-disk-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(tmp, `c${++n}`);
const rug = (slot: number, ms: number) => ({ kind: 'market' as const, id: `rug-${slot}`, moment: { slot: BigInt(slot), txIndex: 0, ixIndex: 0, receivedAt: ms }, key: `rug:Mint${slot}`, value: { rug: true } });
const linesOf = (dir: string) => {
  const text = readFileSync(join(dir, 'deployers.jsonl'), 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text.trim().split('\n').map((l) => parseTyped(l) as { key: string; value: { value?: Record<string, unknown> } });
};
const gap = (from: bigint, to: bigint | null) => ({ fromSlot: from, toSlot: to, reason: 'deployer store append failed', via: STORE_GAP_VIA });

describe('RC-FIXES-2b/2c: deployer store on a full disk', () => {
  it('never throws; the first loss writes open gaps from the reserve; recovery closes them, once; every line whole; logs once a minute', async () => {
    const dir = fresh();
    (await import('node:fs')).mkdirSync(dir);
    disk.free = Number.POSITIVE_INFINITY;
    let now = 1_000_000;
    const logs: string[] = [];
    const s = new DeployerStore(dir, { log: (l) => logs.push(l), now: () => now });
    expect(readFileSync(join(dir, 'deployers.jsonl.reserve')).length).toBe(STORE_RESERVE_BYTES);
    s.keep(rug(100, now) as never);
    disk.free = 0;
    now += 10_000;
    expect(() => s.keep(rug(101, now) as never)).not.toThrow();
    // The reserve went to the open gaps; the rest of the disk is taken again by others.
    disk.free = 0;
    for (const slot of [102, 103]) {
      now += 10_000;
      expect(() => s.keep(rug(slot, now) as never)).not.toThrow();
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/append failed \(ENOSPC\); slots 101\.\.101/);
    disk.free = Number.POSITIVE_INFINITY;
    now += 10_000;
    s.keep(rug(104, now) as never);
    s.keep(rug(1040, now) as never);
    const lines = linesOf(dir);
    expect(lines.map((l) => l.key)).toEqual(['rug:Mint100', 'coverage:creates:gap', 'coverage:rugs:gap', 'coverage:creates:gap', 'coverage:rugs:gap', 'rug:Mint104', 'rug:Mint1040']);
    for (const g of lines.slice(1, 3)) expect(g.value.value).toEqual(gap(101n, null));
    for (const g of lines.slice(3, 5)) expect(g.value.value).toEqual(gap(101n, 103n));
    // The reserve is back once a write works.
    expect(readFileSync(join(dir, 'deployers.jsonl.reserve')).length).toBe(STORE_RESERVE_BYTES);
    // The load keeps the closed pair as written.
    const saved = new DeployerStore(dir).load(0);
    expect(saved.coverage.map((c) => (c.value as { value: { toSlot: bigint | null } }).value.toSlot)).toEqual([null, null, 103n, 103n]);
    // A minute later, another failure is logged again.
    disk.free = 0;
    now += 61_000;
    s.keep(rug(105, now) as never);
    expect(logs).toHaveLength(2);
  });

  it('a death before any write works again: the next load closes the open gaps up to the newest saved slot', async () => {
    const dir = fresh();
    (await import('node:fs')).mkdirSync(dir);
    disk.free = Number.POSITIVE_INFINITY;
    const s = new DeployerStore(dir, { now: () => 1 });
    s.keep(rug(200, 1) as never);
    s.keep(rug(201, 2) as never);
    disk.free = 0;
    s.keep(rug(201, 3) as never); // lost, in the same slot as the last saved event
    disk.free = 0;
    s.keep(rug(202, 4) as never); // lost too
    // Killed. The next start, with room again.
    disk.free = Number.POSITIVE_INFINITY;
    const saved = new DeployerStore(dir).load(0);
    const gaps = saved.coverage.filter((c) => (c.value as { value: { via?: string } }).value.via === STORE_GAP_VIA);
    expect(gaps.map((g) => [g.key, (g.value as { value: unknown }).value])).toEqual([
      ['coverage:creates:gap', gap(201n, 201n)],
      ['coverage:rugs:gap', gap(201n, 201n)],
    ]);
    expect(saved.last?.slot).toBe(201n);
    // Rewritten closed: a second load reads the same.
    expect(new DeployerStore(dir).load(0).coverage.map((c) => (c.value as { value: unknown }).value)).toEqual([gap(201n, 201n), gap(201n, 201n)]);
  });

  it('a lost event older than the newest saved one (an out-of-order keep): the load closes its gap up to the newest saved slot', async () => {
    const dir = fresh();
    (await import('node:fs')).mkdirSync(dir);
    disk.free = Number.POSITIVE_INFINITY;
    const s = new DeployerStore(dir, { now: () => 1 });
    s.keep(rug(300, 1) as never);
    disk.free = 0;
    s.keep(rug(250, 2) as never);
    disk.free = Number.POSITIVE_INFINITY;
    const gaps = new DeployerStore(dir).load(0).coverage.map((c) => (c.value as { value: unknown }).value);
    expect(gaps).toEqual([gap(250n, 300n), gap(250n, 300n)]);
  });
});

