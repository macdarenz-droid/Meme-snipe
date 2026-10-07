// RC-FIXES: the socket's backoff and hourly ceiling, and the credit book's fail-closed saves (red team C, 959d8017).
import { mkdirSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONNECTS_PER_HOUR, FakeSocketHub, ReconnectingSocket } from '../src/providers/index.ts';
import { ALCHEMY_FREE, HELIUS_FREE, ManualTimers, P0, P2 } from '../src/scheduler/index.ts';
import { CREDIT_MONTHS_KEPT, CREDIT_RESERVE, CreditBook, HELIUS_WORKER } from '../src/run/sources.ts';
import { creditsFile } from '../src/run/state.ts';
import { blockNetwork } from './helpers.ts';

blockNetwork();

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'rc-fixes-'));

describe('RC-FIXES: the socket backs off until a connection proves healthy, and never passes its hourly ceiling', () => {
  const rig = (opts: { healthyMs?: number; maxConnectsPerHour?: number } = {}) => {
    const timers = new ManualTimers(0);
    const hub = new FakeSocketHub();
    const downs: string[] = [];
    const sock = new ReconnectingSocket('t', () => 'wss://test', hub.factory, timers, { initialMs: 1_000, maxMs: 30_000, idleMs: 30_000, ...opts }, {
      onOpen: () => {}, onMessage: () => {}, onDown: (reason) => void downs.push(reason),
    });
    return { timers, hub, sock, downs };
  };

  it('a connection that stays up past healthyMs and delivers a message resets the backoff to initialMs', () => {
    const { timers, hub, sock } = rig({ healthyMs: 5_000 });
    sock.start();
    // Three quick open-then-close rounds grow the wait: 1 s, 2 s, 4 s.
    for (const wait of [1_000, 2_000, 4_000]) {
      const s = hub.sockets.at(-1)!;
      s.open();
      s.drop(1008, 'policy');
      const n = hub.sockets.length;
      timers.advance(wait - 1);
      expect(hub.sockets.length).toBe(n);
      timers.advance(1);
      expect(hub.sockets.length).toBe(n + 1);
    }
    // A healthy one: up 5 s with a message after that. Its drop is retried after initialMs again.
    const s = hub.sockets.at(-1)!;
    s.open();
    timers.advance(5_000);
    s.push('{}');
    s.drop(1006, 'gone');
    const n = hub.sockets.length;
    timers.advance(1_000);
    expect(hub.sockets.length).toBe(n + 1);
    sock.stop();
  });

  it('an open with a message before healthyMs is not healthy: its close keeps backing off', () => {
    const { timers, hub, sock } = rig({ healthyMs: 5_000 });
    sock.start();
    for (const wait of [1_000, 2_000, 4_000, 8_000]) {
      const s = hub.sockets.at(-1)!;
      s.open();
      s.push('{"subscribed":true}');
      s.drop(1008, 'policy');
      const n = hub.sockets.length;
      timers.advance(wait - 1);
      expect(hub.sockets.length).toBe(n);
      timers.advance(1);
      expect(hub.sockets.length).toBe(n + 1);
    }
    sock.stop();
  });

  it('never more connection attempts in any hour than the ceiling; the down reason names it', () => {
    const { timers, hub, sock, downs } = rig({ maxConnectsPerHour: 10 });
    sock.start();
    let handled = 0;
    const opensAt: number[] = [];
    for (let t = 0; t < 3 * 3_600_000; t += 500) {
      while (handled < hub.sockets.length) {
        const s = hub.sockets[handled++]!;
        opensAt.push(timers.now());
        // Fails before it opens: the backoff alone would allow about 120 an hour at the 30 s cap.
        s.drop(1006, 'refused');
      }
      timers.advance(500);
    }
    sock.stop();
    for (const at of opensAt) expect(opensAt.filter((x) => x > at - 3_600_000 && x <= at).length).toBeLessThanOrEqual(10);
    expect(opensAt.length).toBeGreaterThanOrEqual(20);
    expect(sock.ceilingHits).toBeGreaterThan(0);
    expect(downs.some((d) => d.includes('reconnect ceiling 10/h reached'))).toBe(true);
    expect(DEFAULT_CONNECTS_PER_HOUR).toBe(60);
  });
});

describe('RC-FIXES: the credit book never throws, never loses count across a restart, and fails closed', () => {
  it('a spend is on disk before the next save is due: a death with no flush restarts at or above what was spent', () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const dir = tempDir();
    const book = new CreditBook(dir, timers, () => {});
    const helius = book.scheduler(HELIUS_WORKER);
    const alchemy = book.scheduler(ALCHEMY_FREE);
    helius.meter(7);
    alchemy.meter(2_500);
    // No timer fired, no flush: the process dies here.
    const saved = creditsFile(dir).read({ month: '', used: {} }).used;
    expect(saved['helius']).toBeGreaterThanOrEqual(7);
    expect(saved['alchemy']).toBeGreaterThanOrEqual(2_500);
    // At most the reserve over (a restart over-counts a little, never under).
    expect(saved['alchemy']! - 2_500).toBeLessThanOrEqual(CREDIT_RESERVE);
    const again = new CreditBook(dir, timers, () => {});
    expect(again.used['alchemy']).toBeGreaterThanOrEqual(2_500);
  });

  it('a failed save never throws, logs once per kind, holds budgeted providers to P0, and lifts once a save lands', () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const dir = tempDir();
    const logs: string[] = [];
    const book = new CreditBook(dir, timers, (l) => void logs.push(l));
    const helius = book.scheduler(HELIUS_WORKER);
    const alchemy = book.scheduler(ALCHEMY_FREE);
    // The disk refuses writes from here (the temp path is a directory).
    mkdirSync(join(dir, 'credits.json.tmp'));
    expect(() => alchemy.meter(CREDIT_RESERVE + 1)).not.toThrow();
    expect(book.fault).toContain('EISDIR');
    expect(alchemy.halted).toBe(true);
    expect(alchemy.check(P2).ok).toBe(false);
    expect(alchemy.check(P0).ok).toBe(true);
    // Helius's count gates nothing (HELIUS-EXHAUSTED): never held by it.
    expect(helius.halted).toBe(false);
    for (let k = 0; k < 5; k++) expect(() => timers.advance(1_000)).not.toThrow();
    expect(logs.filter((l) => l.includes('not saved'))).toHaveLength(1);
    // The disk recovers: the next retry lands, the hold lifts, and the file holds at least what was spent.
    rmdirSync(join(dir, 'credits.json.tmp'));
    timers.advance(1_000);
    expect(book.fault).toBeNull();
    expect(alchemy.halted).toBe(false);
    expect(creditsFile(dir).read({ month: '', used: {} }).used['alchemy']).toBeGreaterThanOrEqual(CREDIT_RESERVE + 1);
    expect(() => book.flush()).not.toThrow();
  });

  it('a failed save that still leaves the reserve ahead holds nothing (disk still covers the spend)', () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const dir = tempDir();
    const book = new CreditBook(dir, timers, () => {});
    const alchemy = book.scheduler(ALCHEMY_FREE);
    alchemy.meter(10);
    mkdirSync(join(dir, 'credits.json.tmp'));
    alchemy.meter(10);
    expect(() => timers.advance(1_000)).not.toThrow();
    expect(() => book.flush()).not.toThrow();
    expect(book.fault).toBeNull();
    expect(alchemy.halted).toBe(false);
  });

  it('a book made while the disk refuses still starts, and a scheduler made during a fault is held', () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const dir = tempDir();
    mkdirSync(join(dir, 'credits.json.tmp'));
    let book: CreditBook | null = null;
    expect(() => (book = new CreditBook(dir, timers, () => {}))).not.toThrow();
    const b = book!;
    const first = b.scheduler(ALCHEMY_FREE);
    expect(first.halted).toBe(false);
    first.meter(CREDIT_RESERVE + 1);
    expect(b.fault).not.toBeNull();
    expect(b.scheduler({ ...HELIUS_FREE, provider: 'other' }).halted).toBe(true);
  });

  it('counts never go backwards', () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const dir = tempDir();
    const book = new CreditBook(dir, timers, () => {});
    const alchemy = book.scheduler(ALCHEMY_FREE);
    alchemy.meter(50);
    alchemy.resetBudget(0);
    expect(book.used['alchemy']).toBe(50);
    book.flush();
    expect(creditsFile(dir).read({ month: '', used: {} }).used['alchemy']).toBeGreaterThanOrEqual(50);
  });
});

describe('RC-FIXES: credits.json across clock steps between months', () => {
  const OCT = Date.UTC(2026, 9, 7, 3);
  const at = (ms: number) => new ManualTimers(ms);
  it('a new month starts from zero and keeps the old month; going back to it finds its count', () => {
    const dir = tempDir();
    const oct = new CreditBook(dir, at(OCT), () => {});
    oct.scheduler(ALCHEMY_FREE).meter(5_000);
    oct.flush();
    const nov = new CreditBook(dir, at(Date.UTC(2026, 10, 2)), () => {});
    expect(nov.used['alchemy'] ?? 0).toBe(0);
    nov.scheduler(ALCHEMY_FREE).meter(7);
    nov.flush();
    expect(creditsFile(dir).read({ month: '', used: {} })).toEqual({ month: '2026-11', used: { alchemy: 7 }, months: { '2026-10': { alchemy: 5_000 } } });
  });

  it('a clock behind the saved month counts under the saved month from the larger count, and logs it', () => {
    const dir = tempDir();
    const logs: string[] = [];
    const nov = new CreditBook(dir, at(Date.UTC(2026, 10, 2)), () => {});
    nov.scheduler(ALCHEMY_FREE).meter(9);
    nov.flush();
    // October's count was larger (kept from before the step), and the clock now reads October.
    creditsFile(dir).write({ month: '2026-11', used: { alchemy: 9 }, months: { '2026-10': { alchemy: 5_000 } } });
    const back = new CreditBook(dir, at(OCT), (l) => void logs.push(l));
    expect(back.used['alchemy']).toBe(5_000);
    expect(logs.some((l) => l.includes('behind the saved 2026-11'))).toBe(true);
    back.flush();
    const f = creditsFile(dir).read({ month: '', used: {} });
    expect(f.month).toBe('2026-11');
    expect(f.used['alchemy']).toBe(5_000);
    expect(f.months?.['2026-10']?.['alchemy']).toBe(5_000);
  });

  it('only the last CREDIT_MONTHS_KEPT other months are kept', () => {
    const dir = tempDir();
    for (let m = 0; m < 6; m++) {
      const b = new CreditBook(dir, at(Date.UTC(2026, m, 15)), () => {});
      b.scheduler(ALCHEMY_FREE).meter(m + 1);
      b.flush();
    }
    expect(Object.keys(creditsFile(dir).read({ month: '', used: {} }).months ?? {})).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(CREDIT_MONTHS_KEPT).toBe(3);
  });
});
