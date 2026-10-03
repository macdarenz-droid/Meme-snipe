// FACTS-1b: the live fact source on WORKER-1's FactSource hook. Reads follow each candidate's last reasons
// (staging), raw answers go on the worker's Feed, and the engine's FactFeed makes the gate facts, live and in a
// replay of the recording alike.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RAW, producerOptions } from '../../core/src/facts/index.ts';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { holdersKey, migrationKey, mintKey, parsePool, poolKey } from '../../core/src/gates/index.ts';
import { FEE_CONTEXT } from '../../core/test/gates/world.ts';
import { FIX } from '../../core/test/facts/helpers.ts';
import { feesKey, type CandidateReason } from '../src/engine/strategy.ts';
import { FACT_READS_KEY, LiveFacts, liveFacts, readsFor, type LiveReaders, type MintHistoryOptions } from '../src/facts/index.ts';
import { replayRecorded, type Frame, type HttpRequest, type HttpResponse, type Release, type Secrets } from '../src/providers/index.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { parseTyped } from '../src/run/json.ts';
import type { FactContext } from '../src/run/facts.ts';
import { ALCHEMY_FREE, COINBASE_PUBLIC, GOPLUS_FREE, HELIUS_FREE, JUPITER_FREE, ManualTimers, RUGCHECK_FREE, Scheduler, type SchedulerSpec } from '../src/scheduler/index.ts';
import { blockNetwork } from './helpers.ts';
import { MINT, Market, T, makeWorker, passingMarket } from './worker-harness.ts';

/** Each worker in this file binds its own health and API ports. */
const ports = (n: number) => ({ ZEROED_HEALTH_ADDR: `127.0.0.1:${18860 + 2 * n}`, ZEROED_API_ADDR: `127.0.0.1:${18861 + 2 * n}` });

const MINT2 = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

blockNetwork();

const H16 = (input: string, code = 'missing'): CandidateReason => ({ gate: 'H16', code, input });

describe('readsFor: what a candidate\'s last reasons ask for', () => {
  it('reads nothing before the first evaluation or after a pass', () => {
    expect(readsFor(null)).toEqual([]);
    expect(readsFor([])).toEqual([]);
  });

  it('reads nothing while any reason is not missing evidence (regime, a stream-built reject, a disagreement)', () => {
    expect(readsFor([{ gate: 'regime', code: 'unknown', input: 'curve-volume' }])).toEqual([]);
    expect(readsFor([H16('mint'), { gate: 'H11', code: 'candle-spike', input: 'candles' }])).toEqual([]);
    expect(readsFor([H16('mint'), { gate: 'H16', code: 'xcheck-disagree', input: 'xcheck' }])).toEqual([]);
    expect(readsFor([H16('mint'), { gate: 'H16', code: 'future', input: 'pool' }])).toEqual([]);
    expect(readsFor([{ gate: 'H16', code: 'missing' }])).toEqual([]);
    // Only H16 judges evidence: another gate's reason never asks for a read, whatever its code.
    expect(readsFor([{ gate: 'H12', code: 'missing', input: 'holders' }])).toEqual([]);
  });

  it('maps each evidence input to its read; inputs with no live read ask for nothing', () => {
    expect(readsFor([H16('mint'), H16('pool', 'stale'), H16('lp', 'inconsistent')])).toEqual(['accounts']);
    expect(readsFor([H16('xcheck', 'stale')])).toEqual(['xcheck']);
    expect(readsFor([H16('insiders', 'not-covered')])).toEqual(['mint-history']);
    expect(readsFor([H16('holders')])).toEqual(['holders']);
    expect(readsFor([H16('sim'), H16('stream', 'gap'), H16('candles', 'not-covered')])).toEqual([]);
    expect(readsFor([{ gate: 'worker', code: 'no-market' }])).toEqual(['accounts']);
    expect(readsFor([{ gate: 'worker', code: 'no-sol-price' }])).toEqual([]);
  });

  it('asks for the complete holder scan only when the holder set is the last thing missing', () => {
    expect(readsFor([H16('holders', 'not-covered')])).toEqual(['holders-all']);
    expect(readsFor([H16('holders', 'not-covered'), H16('mint')])).toEqual(['accounts', 'holders']);
    expect(readsFor([H16('holders', 'not-covered'), { gate: 'worker', code: 'no-market' }])).toEqual(['accounts', 'holders']);
    expect(readsFor([H16('holders', 'not-covered'), H16('sim')])).toEqual(['holders']);
  });
});

type Call = readonly [string, ...unknown[]];

const fake = () => {
  const calls: Call[] = [];
  const pending: { resolve: (ok: boolean) => void; reject: (e: unknown) => void }[] = [];
  let mode: 'ok' | 'fail' | 'throw' | 'hold' = 'ok';
  const answer = (c: Call): Promise<boolean> => {
    calls.push(c);
    if (mode === 'hold') return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    if (mode === 'throw') return Promise.reject(new Error('down'));
    return Promise.resolve(mode === 'ok');
  };
  const readers: LiveReaders = {
    readAccounts: (m) => answer(['accounts', m]),
    readHolders: (m) => answer(['holders', m]),
    readHoldersAll: (m) => answer(['holders-all', m]),
    readCrossChecks: async (m) => [await answer(['xcheck', m]), false, false],
    readMintHistory: (m, o: MintHistoryOptions) => answer(['mint-history', m, o.asOfSlot]),
    readSolUsd: (h) => answer(['sol-usd', h]),
  };
  return { readers, calls, pending, set: (m: typeof mode) => void (mode = m) };
};

const T0 = Date.UTC(2026, 9, 3, 12, 30);
const MIN = 60_000;

const setup = (o: { tip?: bigint | null } = {}) => {
  const timers = new ManualTimers(T0);
  const f = fake();
  const facts: { key: string; value: unknown }[] = [];
  const cands = new Map<string, { migratedAtMs: number; gates: readonly CandidateReason[] | null }>();
  const ctx = {
    sink: { fact: (key: string, value: unknown) => void facts.push({ key, value }), now: () => timers.now() },
    timers, watched: () => new Set(cands.keys()), candidates: () => cands, tip: () => (o.tip === undefined ? 1_000n : o.tip),
  } as unknown as FactContext;
  const src = new LiveFacts({
    readers: () => f.readers, tickMs: 1_000, minReadGapMs: MIN, survivalAfterMs: 30 * MIN, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
    mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
  });
  const flush = async (): Promise<void> => {
    for (let k = 0; k < 5; k++) await Promise.resolve();
  };
  return { timers, f, facts, cands, ctx, src, flush };
};

const of = (calls: readonly Call[], kind: string) => calls.filter((c) => c[0] === kind);

describe('LiveFacts', () => {
  it('reads SOL/USD at start with the kept window, then 3 hours each new hour; nothing for a candidate not yet evaluated', async () => {
    const s = setup();
    s.cands.set('M1', { migratedAtMs: T0, gates: null });
    s.src.start(s.ctx);
    await s.flush();
    expect(s.f.calls).toEqual([['sol-usd', 27]]);
    s.timers.advance(29 * MIN);
    await s.flush();
    expect(s.f.calls).toEqual([['sol-usd', 27]]);
    s.timers.advance(MIN);
    await s.flush();
    expect(of(s.f.calls, 'sol-usd')).toEqual([['sol-usd', 27], ['sol-usd', 3]]);
    s.src.stop();
  });

  it('reads what the evidence reasons name, at most once a gap per kind and mint', async () => {
    const s = setup();
    s.src.start(s.ctx);
    s.cands.set('M1', { migratedAtMs: T0, gates: [H16('mint'), H16('xcheck', 'stale'), H16('holders')] });
    s.timers.advance(1_000);
    await s.flush();
    expect(s.f.calls.slice(1)).toEqual([['accounts', 'M1'], ['holders', 'M1'], ['xcheck', 'M1']]);
    s.timers.advance(MIN - 2_000);
    await s.flush();
    expect(s.f.calls).toHaveLength(4);
    s.timers.advance(2_000);
    await s.flush();
    expect(s.f.calls.slice(4)).toEqual([['accounts', 'M1'], ['holders', 'M1'], ['xcheck', 'M1']]);
    s.src.stop();
  });

  it('reads nothing for a candidate blocked by a non-evidence reason, and the complete scan only when holders are last', async () => {
    const s = setup();
    s.src.start(s.ctx);
    s.cands.set('M1', { migratedAtMs: T0, gates: [{ gate: 'regime', code: 'regime-off' }] });
    s.cands.set('M2', { migratedAtMs: T0, gates: [H16('holders', 'not-covered')] });
    s.timers.advance(1_000);
    await s.flush();
    expect(s.f.calls.slice(1)).toEqual([['holders-all', 'M2']]);
    s.src.stop();
  });

  it('never runs two reads of one kind for one mint at once', async () => {
    const s = setup();
    s.src.start(s.ctx);
    s.f.set('hold');
    s.cands.set('M1', { migratedAtMs: T0, gates: [H16('mint')] });
    s.timers.advance(1_000);
    s.timers.advance(3 * MIN);
    await s.flush();
    expect(of(s.f.calls, 'accounts')).toHaveLength(1);
    s.f.set('ok');
    s.f.pending.forEach((p) => p.resolve(true));
    await s.flush();
    s.timers.advance(1_000);
    await s.flush();
    expect(of(s.f.calls, 'accounts')).toHaveLength(2);
    s.src.stop();
  });

  it('reads a mint\'s history as of the feed tip, once it succeeds; never without a tip', async () => {
    const none = setup({ tip: null });
    none.src.start(none.ctx);
    none.cands.set('M1', { migratedAtMs: T0, gates: [H16('insiders', 'not-covered')] });
    none.timers.advance(5 * MIN);
    await none.flush();
    expect(of(none.f.calls, 'mint-history')).toEqual([]);
    none.src.stop();

    const s = setup({ tip: 1_234n });
    s.src.start(s.ctx);
    s.f.set('fail');
    s.cands.set('M1', { migratedAtMs: T0, gates: [H16('insiders', 'not-covered')] });
    s.timers.advance(1_000);
    await s.flush();
    s.f.set('ok');
    s.timers.advance(MIN);
    await s.flush();
    s.timers.advance(5 * MIN);
    await s.flush();
    expect(of(s.f.calls, 'mint-history')).toEqual([['mint-history', 'M1', 1_234n], ['mint-history', 'M1', 1_234n]]);
    s.src.stop();
  });

  it('reads each shortlisted graduate\'s pool once just after its survival mark, even after its window ended', async () => {
    const s = setup();
    s.src.start(s.ctx);
    s.cands.set('G1', { migratedAtMs: T0, gates: null });
    s.timers.advance(1_000);
    s.cands.delete('G1');
    s.timers.advance(30 * MIN + 2_000);
    await s.flush();
    expect(of(s.f.calls, 'accounts')).toEqual([]);
    s.timers.advance(3_000);
    await s.flush();
    expect(of(s.f.calls, 'accounts')).toEqual([['accounts', 'G1']]);
    s.timers.advance(60 * MIN);
    await s.flush();
    expect(of(s.f.calls, 'accounts')).toEqual([['accounts', 'G1']]);
    // Still shortlisted after its mark: still one read.
    s.cands.set('G2', { migratedAtMs: s.timers.now(), gates: null });
    s.timers.advance(31 * MIN);
    await s.flush();
    s.timers.advance(10 * MIN);
    await s.flush();
    expect(of(s.f.calls, 'accounts')).toEqual([['accounts', 'G1'], ['accounts', 'G2']]);
    s.src.stop();
  });

  it('counts every read by kind and outcome per UTC day, a throw as a failure; the count resets each day', async () => {
    const s = setup();
    s.f.set('throw');
    s.src.start(s.ctx);
    s.cands.set('M1', { migratedAtMs: T0, gates: [H16('mint')] });
    s.timers.advance(1_000);
    await s.flush();
    const last = () => s.facts.filter((x) => x.key === FACT_READS_KEY).at(-1)!.value as { day: string; counts: Record<string, { ok: number; failed: number }> };
    expect(last()).toMatchObject({ day: '2026-10-03', counts: { 'sol-usd': { ok: 0, failed: 1 }, accounts: { ok: 0, failed: 1 } } });
    s.f.set('ok');
    s.cands.set('M1', { migratedAtMs: T0 + 12 * 60 * MIN, gates: [H16('mint')] });
    s.timers.advance(12 * 60 * MIN);
    await s.flush();
    expect(last().day).toBe('2026-10-04');
    expect(last().counts['accounts']).toEqual({ ok: 1, failed: 0 });
    s.src.stop();
  });

  it('a read that ends after the stop puts nothing on the feed', async () => {
    const s = setup();
    s.f.set('hold');
    s.src.start(s.ctx);
    s.src.stop();
    s.f.pending.forEach((p) => p.resolve(true));
    await s.flush();
    expect(s.facts).toEqual([]);
  });

  it('stops reading once stopped', async () => {
    const s = setup();
    s.src.start(s.ctx);
    s.src.stop();
    s.cands.set('M1', { migratedAtMs: T0, gates: [H16('mint')] });
    s.timers.advance(10 * MIN);
    await s.flush();
    expect(s.f.calls).toEqual([['sol-usd', 27]]);
  });
});

/** The recorder's sealed files of one kind, day by day (DATA-1's layout). */
const rows = <T>(dir: string, re: RegExp, parse: (l: string) => T): T[] =>
  readdirSync(join(dir, 'days')).sort().flatMap((d) => readdirSync(join(dir, 'days', d)).filter((f) => re.test(f)).sort()
    .flatMap((f) => zstdDecompressSync(readFileSync(join(dir, 'days', d, f))).toString('utf8').split('\n').filter((l) => l !== '').map(parse)));

describe('the worker reads through core\'s FactFeed (FACTS-1b)', () => {
  it('a raw account read on the live Feed becomes the gate facts, and the recording replays to the same facts', async () => {
    let ctx: FactContext | null = null;
    const h = makeWorker({ config: ports(0), facts: [{ name: 'capture', start: (c) => void (ctx = c), stop: () => undefined }] });
    expect(await h.worker.start()).toEqual({ ok: true });
    const c = ctx as unknown as FactContext;
    const mint = FIX.accountsRead.mint;
    const before = h.worker.factsReleased;
    expect(h.worker.poolOf(mint)).toBeNull();
    c.ingest.ingest('helius', { type: 'offchain', key: RAW.accounts(mint), value: { ...FIX.accountsRead, slot: BigInt(FIX.accountsRead.slot) } }, { receivedAt: c.sink.now() });
    c.sink.fact(feesKey(mint), FEE_CONTEXT);
    const m = new Market(h);
    await m.run(3_000, 100, () => m.slot());
    expect(h.worker.factsReleased).toBeGreaterThan(before);
    const live = h.worker.poolOf(mint);
    expect(live?.address).toBe(FIX.accountsRead.accounts[1]!.address);
    await h.worker.stop();

    const dir = join(h.stateDir, 'recorder', h.worker.boot);
    const frames = rows(dir, /^frames-/, (l) => parseTyped(l) as Frame);
    const releases = rows(dir, /^releases-/, (l) => JSON.parse(l) as Release);
    const { feed } = replayRecorded(frames, releases);
    const seen = new Map<string, unknown>();
    const replay = engineFeed(feed, h.session.policy, (e) => void seen.set(e.key, e.value));
    while (replay.feed.next() !== null);
    expect(replay.released()).toBe(h.worker.factsReleased);
    expect(parsePool(seen.get(poolKey(mint)))?.address).toBe(live?.address);
    expect(seen.has(mintKey(mint))).toBe(true);
  });
});

describe('the strategy keeps each candidate\'s last reasons with their inputs (what the source reads from)', () => {
  it('null before the first evaluation, then the typed reasons of the last one with the inputs evidence names', async () => {
    let ctx: FactContext | null = null;
    const h = makeWorker({ config: ports(1), facts: [{ name: 'capture', start: (c) => void (ctx = c), stop: () => undefined }] });
    expect(await h.worker.start()).toEqual({ ok: true });
    const c = ctx as unknown as FactContext;
    const obs = { provider: 'test', slot: null, receivedAt: c.sink.now(), quality: [], commitment: 'confirmed' };
    // Shortlisted, its window still ahead: never evaluated.
    c.sink.fact(migrationKey(MINT2), { obs, graduatedAtMs: T + 3 * MIN, migratedAtMs: T + 3 * MIN, pool: MINT2, quoteAtMigration: 1n, price: { quote: 1n, base: 1n } });
    // The critical feed is up, so entries are not halted and candidates are evaluated.
    h.worker.feed.ingest('helius', { type: 'offchain', key: 'feed:status:helius', value: { state: 'up' } }, { receivedAt: c.sink.now() });
    const m = await passingMarket(h);
    expect(c.candidates().get(MINT2)).toEqual({ migratedAtMs: T + 3 * MIN, gates: null });
    // Every fact kept current except a holder read that cannot be parsed: the reject names the holders as evidence.
    await m.run(3_000, 400, () => {
      m.slot();
      m.pool();
      m.fact(holdersKey(MINT), { unreadable: true });
    });
    const gates = c.candidates().get(MINT)?.gates ?? null;
    expect(gates).not.toBeNull();
    expect(gates).toContainEqual({ gate: 'H16', code: 'malformed', input: 'holders' });
    expect(readsFor(gates)).toEqual(['holders']);
    await h.worker.stop();
  });
});

describe('a passing evaluation clears the candidate\'s reasons', () => {
  it('after the entry, candidates() gives no reasons for the mint, so the source reads nothing more for it', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h);
    // Earlier evaluations rejected (the ramp before every fact was there), so a reason list exists to be cleared.
    await m.run(4_000, 100, () => m.pool());
    const journal = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8');
    expect(journal).toContain('"reject"');
    expect(journal).toContain('"enter"');
    expect(h.worker.strategy.candidates().get(MINT)?.gates).toEqual([]);
    expect(readsFor(h.worker.strategy.candidates().get(MINT)!.gates)).toEqual([]);
    await h.worker.stop();
  });
});

describe('liveFacts: the production source', () => {
  it('builds FACTS-1\'s readers on the worker\'s Feed and reads the policy\'s SOL/USD window at start', async () => {
    const timers = new ManualTimers(Date.parse(FIX.meta.fetchedAt));
    const urls: string[] = [];
    const frames: { key: string; value: unknown }[] = [];
    const http = async (req: HttpRequest): Promise<HttpResponse> => {
      urls.push(req.url);
      return { status: 200, text: FIX.coinbase, header: () => null } as unknown as HttpResponse;
    };
    const sched = (spec: SchedulerSpec) => new Scheduler(spec, { timers });
    const ctx = {
      sink: { fact: () => undefined, now: () => timers.now() }, timers, watched: () => new Set<string>(), candidates: () => new Map(), tip: () => null,
      schedulers: { helius: sched(HELIUS_FREE), alchemy: sched(ALCHEMY_FREE), jupiter: sched(JUPITER_FREE), rugcheck: sched(RUGCHECK_FREE) },
      ingest: { ingest: (_s: unknown, body: { type: string; key: string; value: unknown }) => void frames.push({ key: body.key, value: body.value }) },
    } as unknown as FactContext;
    const src = liveFacts({ policy: TRIAL_POLICY, secrets: { get: () => 'k' } as unknown as Secrets, http, goplus: sched(GOPLUS_FREE), coinbase: sched(COINBASE_PUBLIC) });
    src.start(ctx);
    for (let k = 0; k < 50 && frames.length === 0; k++) {
      await new Promise<void>((r) => setImmediate(r));
      timers.advance(10);
    }
    src.stop();
    const hours = Math.ceil(producerOptions(TRIAL_POLICY).solUsdKeepMs / 3_600_000);
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]!);
    expect(u.host).toBe('api.exchange.coinbase.com');
    expect(Date.parse(u.searchParams.get('end')!) - Date.parse(u.searchParams.get('start')!)).toBe(hours * 3_600_000);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.key === RAW.solUsd)).toBe(true);
  });
});
