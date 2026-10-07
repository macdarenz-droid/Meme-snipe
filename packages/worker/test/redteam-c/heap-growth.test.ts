// RED TEAM C round 2 (probe, not product code): the real Worker driven for hours of simulated time by heap-drive.ts in
// a child process run as live runs it (node --max-old-space-size=560, plus --expose-gc to read the retained heap). Each
// simulated hour the child prints heapUsed after a full GC and the worker's own MEM-PROBE counts. These tests assert
// the bound each structure should have, so a structure that grows with simulated time fails here.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

type Hour = { hour: number; heap_mb: number; rss_mb: number; creates: number; migrations: number; counts: Record<string, number> };

const drive = (args: readonly (string | number)[], env: Record<string, string>): Hour[] => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=560', '--no-warnings', join(import.meta.dirname, 'heap-drive.ts'), ...args.map(String)], {
    // A port block of its own (the harness derives ports from VITEST_POOL_ID).
    env: { ...process.env, VITEST_POOL_ID: String(30 + Math.floor(Math.random() * 9)), ...env }, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 900_000,
  });
  const hours = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('{"hour"')).map((l) => JSON.parse(l) as Hour);
  if (hours.length === 0) throw new Error(`drive failed (status ${r.status}): ${(r.stderr ?? '').slice(-2_000)}`);
  return hours;
};
const c = (h: Hour, k: string): number => h.counts[k] ?? 0;
const line = (h: Hour, keys: readonly string[]): string => `h${h.hour} heap ${h.heap_mb} MB rss ${h.rss_mb} MB ${keys.map((k) => `${k}=${c(h, k)}`).join(' ')}`;

describe('RED TEAM C heap: per-pool state after a candidate leaves (3 h, 25 creates/min, 4 migrations/min, 30 min window, a late read after each)', () => {
  let hours: Hour[] = [];
  beforeAll(() => {
    // MEM-FIXES: LATE=1 adds a pool fact and fee terms landing 5 s after each candidate left (a read in flight then).
    hours = drive([3, 25, 4, 1000], { WINDOW_MIN: '30', LATE: '1' });
    for (const h of hours) console.log(line(h, ['strategy_cands', 'strategy_tail', 'worker_pools', 'worker_fees', 'strategy_coverage_facts', 'store_k_coverage_trades', 'store_keys']));
  }, 900_000);

  it('HIGH: the worker\'s per-mint pool maps (#pools, #poolReleasedAt, #fees) hold only live candidates and tails', () => {
    const last = hours.at(-1)!;
    const live = c(last, 'strategy_cands') + c(last, 'strategy_tail') + c(last, 'worker_opened');
    // Observed: worker_pools 719 at 120 live candidates, +240 an hour (every migrated mint ever seen); never deleted.
    expect({ pools: c(last, 'worker_pools'), released: c(last, 'worker_pool_released'), fees: c(last, 'worker_fees') }).toEqual({ pools: live, released: live, fees: live });
  });

  it('HIGH: the strategy\'s coverage facts and the store\'s coverage:trades keys stay bounded by the pools watched now', () => {
    const last = hours.at(-1)!;
    const live = c(last, 'strategy_cands') + c(last, 'strategy_tail');
    // A watch's start, its last gap and resume: a few per pool watched now. Observed: 2,637 events and 1,398 keys at 120
    // live candidates, rising every hour with every pool ever watched and every gap.
    expect(c(last, 'strategy_coverage_facts')).toBeLessThanOrEqual(4 * live + 50);
    expect(c(last, 'store_k_coverage_trades')).toBeLessThanOrEqual(4 * live + 50);
  });
});

describe('RED TEAM C heap: 240 candidates in their 4 h window, each batch-read once a minute (minReadGapMs)', () => {
  let hours: Hour[] = [];
  beforeAll(() => {
    hours = drive([4.5, 5, 1, 1000], { READS: '1', NODUP: '1' });
    for (const h of hours) console.log(line(h, ['strategy_cands', 'store_entries', 'store_k_gates_holders', 'store_e_gates_holders', 'store_e_read_holders', 'store_e_gates_sim']));
  }, 900_000);

  it('CRITICAL: a candidate\'s re-read facts keep a bounded series (not one entry per read); the heap stays far below 560 MB', () => {
    const last = hours.at(-1)!;
    const perKey = (kind: string) => c(last, `store_e_${kind}`) / Math.max(1, c(last, `store_k_${kind}`));
    // Observed (NODUP: gates/holders and gates/sim made by the producer from the raw reads, as live): one entry per read
    // kept for gates/holders, read:holders, gates/sim, read:sim, gates/lp, gates/soft, gates/xcheck, worker:fees (120 a
    // key on average at h4, 240 by a candidate's window end); heap 293.7 MB after GC, RSS 468 MB, with 239 candidates.
    expect({ holders: perKey('gates_holders') <= 4, rawHolders: perKey('read_holders') <= 4, sim: perKey('gates_sim') <= 4 }).toEqual({ holders: true, rawHolders: true, sim: true });
    // A bounded series costs at most ~100 KB a candidate (24 MB for 240) over this run's ~70 MB base (no reads).
    expect(last.heap_mb).toBeLessThan(150);
  });
});
