// RC-FIXES-2b (S1, from #149 DISK-GUARD): a full disk while the deployer store appends must never crash the worker. A
// failed append is cut back, logged at most once a minute, and the first append that works again writes a closed
// creates gap and a closed rugs gap over the lost slots, so a restart reading the file takes that span as not covered.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ full: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const appendFileSync = ((path: string, data: string) => {
    if (disk.full > 0 && String(path).endsWith('deployers.jsonl')) {
      disk.full--;
      fs.appendFileSync(path, data.slice(0, Math.floor(data.length / 2)));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    return fs.appendFileSync(path, data);
  }) as typeof fs.appendFileSync;
  return { ...fs, appendFileSync, default: { ...fs, appendFileSync } };
});
const { DeployerStore, STORE_GAP_VIA } = await import('../../src/run/deployer-store.ts');
const { parseTyped } = await import('../../src/run/json.ts');

const dir = mkdtempSync(join(tmpdir(), 'rc-store-disk-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const rug = (slot: number, ms: number) => ({ kind: 'market' as const, id: `rug-${slot}`, moment: { slot: BigInt(slot), txIndex: 0, ixIndex: 0, receivedAt: ms }, key: `rug:Mint${slot}`, value: { rug: true } });

describe('RC-FIXES-2b: deployer store on a full disk', () => {
  it('never throws, cuts back every partial line, logs once a minute, and leaves a closed gap over the lost slots', () => {
    let now = 1_000_000;
    const logs: string[] = [];
    const s = new DeployerStore(dir, { log: (l) => logs.push(l), now: () => now });
    s.keep(rug(100, now) as never);
    disk.full = 3;
    for (const slot of [101, 102, 103]) {
      now += 10_000;
      expect(() => s.keep(rug(slot, now) as never)).not.toThrow();
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/append failed \(ENOSPC\); slots 101\.\.101/);
    now += 10_000;
    s.keep(rug(104, now) as never);
    // The gap is written once: the next append writes only its event.
    s.keep(rug(1040, now) as never);
    // Every line is whole; the lost events are not in it; a closed gap per stream covers 101..103, then 104.
    const text = readFileSync(join(dir, 'deployers.jsonl'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trim().split('\n').map((l) => parseTyped(l) as { key: string; value: { value?: Record<string, unknown> } });
    expect(lines.map((l) => l.key)).toEqual(['rug:Mint100', 'coverage:creates:gap', 'coverage:rugs:gap', 'rug:Mint104', 'rug:Mint1040']);
    for (const g of lines.slice(1, 3)) expect(g.value.value).toEqual({ fromSlot: 101n, toSlot: 103n, reason: 'deployer store append failed', via: STORE_GAP_VIA });
    // The store's own load reads the gaps back as coverage facts for the restart.
    const saved = new DeployerStore(dir).load(0);
    expect(saved.coverage.map((c) => c.key)).toEqual(['coverage:creates:gap', 'coverage:rugs:gap']);
    // A minute later, another failure is logged again.
    disk.full = 1;
    now += 61_000;
    s.keep(rug(105, now) as never);
    expect(logs).toHaveLength(2);
  });
});
