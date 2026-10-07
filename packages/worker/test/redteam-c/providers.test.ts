// RED TEAM C (providers lens): provider outages, rate limits and restarts must fail closed and never overrun a budget.
// Each test asserts the CORRECT behaviour, so it fails on the code as it stands (commit 959d801). No network: fake
// sockets, scripted HTTP and manual timers only.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_FEED, FakeSocketHub, LiveFeed, ReconnectingSocket, rpcHandler, scriptedHttp } from '../../src/providers/index.ts';
import type { HttpClient } from '../../src/providers/http.ts';
import { HELIUS_FREE, ManualTimers, Scheduler } from '../../src/scheduler/index.ts';
import { CreditBook, LiveProviders } from '../../src/run/sources.ts';
import { FactReaders, FactRpc } from '../../src/facts/index.ts';
import { blockNetwork, settle, testSecrets } from '../helpers.ts';

blockNetwork();

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'redteam-c-'));

/** Advances the manual clock in small steps, letting promise callbacks run between them. */
const run = async (timers: ManualTimers, ms: number, step = 100, each?: () => void): Promise<void> => {
  for (let t = 0; t < ms; t += step) {
    each?.();
    timers.advance(step);
    await settle(10);
  }
};

describe('RC-1: a socket that opens and is closed at once by the server backs off', () => {
  it('a server that accepts and immediately drops (open-then-close) is retried with growing waits, not every initialMs', () => {
    const timers = new ManualTimers(0);
    const hub = new FakeSocketHub();
    const sock = new ReconnectingSocket('helius-ws', () => 'wss://test', hub.factory, timers, { initialMs: 1_000, maxMs: 30_000, idleMs: 30_000 }, {
      onOpen: () => {}, onMessage: () => {}, onDown: () => {},
    });
    sock.start();
    let handled = 0;
    for (let t = 0; t < 600_000; t += 100) {
      // Every new connection: the server accepts it, then closes it (policy violation, credits used up, too many connections).
      while (handled < hub.sockets.length) {
        const s = hub.sockets[handled++]!;
        s.open();
        s.drop(1008, 'policy violation');
      }
      timers.advance(100);
    }
    sock.stop();
    // With doubling from 1 s to 30 s, ten minutes of refusals cost about 25 connections. The current code resets the
    // backoff on every open, so it reconnects every second: about 600.
    expect(hub.sockets.length).toBeLessThanOrEqual(30);
  });

  it('the Helius stream under an open-then-close storm keeps its credit spend bounded (connection credit + backfill per reconnect)', async () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const hub = new FakeSocketHub();
    const http = scriptedHttp(rpcHandler((m) => (m === 'getSignaturesForAddress' ? [] : m === 'getTransaction' ? null : undefined)));
    const providers = new LiveProviders({ tradeStreams: false, secrets: testSecrets, http, factory: hub.factory, credits: new CreditBook(tempDir(), timers) });
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
    const sources = providers.feeds({ feed, timers, pools: () => new Map() });
    const hel = sources.find((s) => s.name === 'helius-ws')!;
    hel.start();
    let handled = 0;
    await run(timers, 600_000, 100, () => {
      const helius = hub.sockets.filter((s) => s.url.includes('helius-rpc'));
      while (handled < helius.length) {
        const s = helius[handled++]!;
        s.open();
        s.drop(1008, 'policy violation');
      }
    });
    hel.stop();
    const opened = hub.sockets.filter((s) => s.url.includes('helius-rpc')).length;
    const used = providers.helius.status().creditsUsed;
    // Bounded by a backoff: about 25 reconnects in ten minutes, each a connection credit and one backfill page per log watch.
    expect({ opened, credits: used }).toEqual({ opened: expect.toBeLessThanOrEqualTo(30) as unknown as number, credits: expect.toBeLessThanOrEqualTo(100) as unknown as number });
  });
});

describe('RC-2: one fetchTx is booked as 1 credit by the re-read budget, but the fetcher spends up to 4 Helius credits', () => {
  it('a migration re-read by signature (worker #rereadMigration: used += 1) spends at most the 1 credit it books', async () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const hub = new FakeSocketHub();
    // The node does not have the transaction yet (null at confirmed), on both providers.
    const http = scriptedHttp(rpcHandler((m) => (m === 'getTransaction' ? null : m === 'getSignaturesForAddress' ? [] : undefined)));
    const providers = new LiveProviders({ tradeStreams: false, secrets: testSecrets, http, factory: hub.factory, credits: new CreditBook(tempDir(), timers) });
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, horizonSlots: 0 });
    providers.feeds({ feed, timers, pools: () => new Map() });
    let found: boolean | null = null;
    void providers.fetchTx('5'.repeat(88), 2).then((f) => { found = f; });
    await run(timers, 10_000);
    expect(found).toBe(false);
    const heliusCalls = http.calls.filter((c) => c.url.includes('helius-rpc')).length;
    // The re-read budget (REREAD_CREDITS_PER_DAY) charged this fetch 1 credit; Helius billed every attempt.
    expect({ heliusCalls, heliusCredits: providers.helius.status().creditsUsed }).toEqual({ heliusCalls: 1, heliusCredits: 1 });
  });
});

describe('RC-3: the credit book\'s deferred save never throws out of its timer (a throw there is an uncaughtException: the worker exits)', () => {
  it('a credits.json write that fails (disk full, EISDIR) one second after a spend does not crash the process', () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const dir = tempDir();
    const book = new CreditBook(dir, timers);
    const helius = book.scheduler({ ...HELIUS_FREE });
    // The disk refuses the next write (here the temp path is a directory, as an ENOSPC would refuse it).
    mkdirSync(join(dir, 'credits.json.tmp'));
    helius.meter(5);
    // systemTimers runs this callback from Node's setTimeout: a throw is an uncaughtException, and main.ts's `fatal`
    // exits the worker (EXIT.crash). The recorder's ENOSPC path stays up (disk-crash.test.ts); this one must too.
    expect(() => timers.advance(1_000)).not.toThrow();
  });
});

describe('RC-4: the holder-scan daily cap survives a restart even when its count could not be saved', () => {
  it('a scan whose count was not written is not granted again by the next process on the same day', async () => {
    const timers = new ManualTimers(1_791_100_000_000);
    const dir = tempDir();
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
