// RED TEAM C probe M1 (claude/redteam-c providers.test.ts › RC-4, verbatim): the holder-scan daily cap must survive a
// restart even when its count could not be saved the usual way. Round 3: the temporary path unusable (a folder), the
// count is written in place, so the first process's scan counts and the restart refuses. Both writes failing (a full
// disk): the scan is refused, fail closed, and one line is logged.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ full: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = ((path: string, ...rest: unknown[]) => {
    if (disk.full && String(path).includes('holder-scans')) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    return (fs.writeFileSync as (...a: unknown[]) => void)(path, ...rest);
  }) as typeof fs.writeFileSync;
  return { ...fs, writeFileSync, default: { ...fs, writeFileSync } };
});
const { HELIUS_FREE, ManualTimers, Scheduler } = await import('../../src/scheduler/index.ts');
const { FactReaders, FactRpc } = await import('../../src/facts/index.ts');
const { blockNetwork } = await import('../helpers.ts');
type HttpClient = import('../../src/providers/http.ts').HttpClient;

blockNetwork();

describe('RC-4: the holder-scan daily cap survives a restart even when its count could not be saved', () => {
  it('a scan whose count was not written is not granted again by the next process on the same day', async () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const dir = mkdtempSync(join(tmpdir(), 'redteam-c-'));
    const scansFile = join(dir, 'holder-scans.json');
    // The write of the count fails (the temp path is a directory; a full disk does the same).
    mkdirSync(`${scansFile}.tmp`);
    let mintReads = 0;
    const http = (async (req: { body?: string }) => {
      if ((req.body ?? '').includes('getAccountInfo')) mintReads++;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as HttpClient;
    const fresh = () => new FactReaders({
      feed: { ingest: () => {} }, rpc: new FactRpc({ url: () => 'x', http, scheduler: new Scheduler(HELIUS_FREE, { timers, creditsUsed: 0 }), timeoutMs: 1000 }),
      http, timers, timeoutMs: 1000, holderScansPerDay: 1, scansFile,
    });
    // Process 1 takes the day's one scan (its count stays in memory only).
    await fresh().readHoldersAll('So11111111111111111111111111111111111111112');
    // Process 2 (a restart the same UTC day) starts from no file: a fresh cap.
    const second = fresh();
    await second.readHoldersAll('So11111111111111111111111111111111111111112');
    expect(mintReads).toBe(1);
    expect(second.outcomes.at(-1)).toMatchObject({ ok: false, detail: 'daily scan cap reached' });
  });
});

describe('RC-M1: a scan whose count cannot be written at all is refused', () => {
  it('both writes fail (a full disk): no scan, one line logged, and a restart refuses too', async () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const scansFile = join(mkdtempSync(join(tmpdir(), 'redteam-c-')), 'holder-scans.json');
    let mintReads = 0;
    const http = (async (req: { body?: string }) => {
      if ((req.body ?? '').includes('getAccountInfo')) mintReads++;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as HttpClient;
    const lines: string[] = [];
    const fresh = () => new FactReaders({
      feed: { ingest: () => {} }, rpc: new FactRpc({ url: () => 'x', http, scheduler: new Scheduler(HELIUS_FREE, { timers, creditsUsed: 0 }), timeoutMs: 1000 }),
      http, timers, timeoutMs: 1000, holderScansPerDay: 1, scansFile, log: (l: string) => lines.push(l),
    });
    disk.full = true;
    try {
      const first = fresh();
      await first.readHoldersAll('So11111111111111111111111111111111111111112');
      await fresh().readHoldersAll('So11111111111111111111111111111111111111112');
      expect(mintReads).toBe(0);
      expect(first.outcomes.at(-1)).toMatchObject({ ok: false, detail: 'daily scan cap reached' });
      expect(lines).toEqual(['Holder scan count not saved: it is kept in this process only.', 'Holder scan count not saved: it is kept in this process only.']);
    } finally {
      disk.full = false;
    }
  });
});
