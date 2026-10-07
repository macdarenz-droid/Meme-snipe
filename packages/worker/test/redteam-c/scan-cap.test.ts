// RED TEAM C probe M1 (docs/redteam-c/REPORT.md on claude/redteam-c, providers.test.ts › RC-4): the holder-scan daily
// cap must survive a restart even when its count could not be saved. A scan whose count is not on disk is not granted.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../../src/providers/http.ts';
import { HELIUS_FREE, ManualTimers, Scheduler } from '../../src/scheduler/index.ts';
import { FactReaders, FactRpc } from '../../src/facts/index.ts';
import { blockNetwork } from '../helpers.ts';

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
    // Process 1 asks for the day's one scan; its count cannot be written.
    await fresh().readHoldersAll('So11111111111111111111111111111111111111112');
    // Process 2 (a restart the same UTC day) starts from no file.
    const second = fresh();
    await second.readHoldersAll('So11111111111111111111111111111111111111112');
    expect(mintReads).toBe(0);
    expect(second.outcomes.at(-1)).toMatchObject({ ok: false });
  });
});
