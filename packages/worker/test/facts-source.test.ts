// FACTS-1b: the live fact source on WORKER-1's FactSource hook. Reads follow each candidate's last reasons
// (staging), raw answers go on the worker's Feed, and the engine's FactFeed makes the gate facts, live and in a
// replay of the recording alike.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MARKET_MISS_CODES } from '../src/engine/strategy.ts';
import { RAW, producerOptions } from '../../core/src/facts/index.ts';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { RUG_LABELS_UNAVAILABLE, holdersKey, migrationKey, mintKey, parsePool, poolKey, rugCheckFromMs } from '../../core/src/gates/index.ts';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { OFF_CHAIN } from '../../core/src/engine/index.ts';
import type { RugCheckRequest } from '../src/providers/index.ts';
import { FEE_CONTEXT } from '../../core/test/gates/world.ts';
import { FIX } from '../../core/test/facts/helpers.ts';
import { ACCOUNT_KEY, feesKey, type CandidateReason } from '../src/engine/strategy.ts';
import { CHAIN_VOLUME_ALERT_KEY, DEPLOYER_CHECK_SPEND_FILE, FACT_READS_KEY, LiveFacts, liveFacts, readsFor, type LiveReaders, type MintHistoryOptions } from '../src/facts/index.ts';
import { replayRecorded, type Frame, type HttpRequest, type HttpResponse, type Release, type Secrets } from '../src/providers/index.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { parseTyped } from '../src/run/json.ts';
import type { FactContext } from '../src/run/facts.ts';
import { ALCHEMY_FREE, COINBASE_PUBLIC, GITHUB_DOWNLOADS, GITHUB_RELEASES, GOPLUS_FREE, HELIUS_FREE, JUPITER_FREE, ManualTimers, RUGCHECK_FREE, Scheduler, type SchedulerSpec } from '../src/scheduler/index.ts';
import { blockNetwork } from './helpers.ts';
import { MINT, Market, T, makeWorker, passingMarket } from './worker-harness.ts';

const MINT2 = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

blockNetwork();

const H16 = (input: string, code = 'missing'): CandidateReason => ({ gate: 'H16', code, input });

describe('readsFor: what a candidate\'s last reasons ask for', () => {
  it('H14\'s rug half not covered asks for a deployer check; the creates half and a missing labeller do not (WORKER-1c)', () => {
    const cov = (detail: string, neededBy = 'H14'): CandidateReason => ({ gate: 'H16', code: 'not-covered', input: 'coverage', neededBy, detail });
    const rugHalf = `${RUG_LABELS_UNAVAILABLE}: rugs-1 coverage: no rugs coverage; deployer check: no rug-check fact`;
    expect(readsFor([cov(rugHalf)])).toEqual(['deployer-check']);
    expect(readsFor([cov(rugHalf), H16('pool')])).toEqual(['accounts', 'deployer-check']);
    expect(readsFor([cov('no creates coverage from 1 to 2')])).toEqual([]);
    expect(readsFor([cov(RUG_LABELS_UNAVAILABLE)])).toEqual([]);
    expect(readsFor([cov(rugHalf, 'H13')])).toEqual([]);
    expect(readsFor([{ ...cov(rugHalf), code: 'missing' }])).toEqual([]);
    // A reject that is not missing evidence still means no read at all.
    expect(readsFor([cov(rugHalf), { gate: 'H14', code: 'prior-rug' }])).toEqual([]);
  });

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
    expect(readsFor([H16('stream', 'gap'), H16('candles', 'not-covered')])).toEqual([]);
    // WORKER-1e: H15's simulation is a live read now.
    expect(readsFor([H16('sim'), H16('stream', 'gap'), H16('candles', 'not-covered')])).toEqual(['sim']);
    // POOL-DATA: each of #market's typed cases asks for the account read, as the one `no-market` did.
    for (const code of MARKET_MISS_CODES) expect(readsFor([{ gate: 'worker', code }])).toEqual(['accounts']);
    expect(readsFor([{ gate: 'worker', code: 'no-market' }])).toEqual([]);
    expect(readsFor([{ gate: 'worker', code: 'no-sol-price' }])).toEqual([]);
  });

  it('asks for the complete holder scan only when the holder set is the last thing missing', () => {
    expect(readsFor([H16('holders', 'not-covered')])).toEqual(['holders-all']);
    expect(readsFor([H16('holders', 'not-covered'), H16('mint')])).toEqual(['accounts', 'holders']);
    expect(readsFor([H16('holders', 'not-covered'), { gate: 'worker', code: 'no-pool-state' }])).toEqual(['accounts', 'holders']);
    expect(readsFor([H16('holders', 'not-covered'), H16('sim')])).toEqual(['holders', 'sim']);
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

  it('reads chain volume at start and each new hour with the policy window, only when wired', async () => {
    const s = setup();
    const w = { volumeLagDays: TRIAL_POLICY.regime.volumeLagDays, volumeWindowDays: TRIAL_POLICY.regime.volumeWindowDays };
    const calls: unknown[] = [];
    const readers: LiveReaders = { ...s.f.readers, readChainVolume: async (r) => (calls.push(r), true) };
    const src = new LiveFacts({
      readers: () => readers, tickMs: 1_000, minReadGapMs: MIN, survivalAfterMs: 30 * MIN, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
      mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 }, chainVolume: w,
    });
    src.start(s.ctx);
    await s.flush();
    expect(calls).toEqual([w]);
    s.timers.advance(29 * MIN);
    await s.flush();
    expect(calls).toEqual([w]);
    s.timers.advance(MIN);
    await s.flush();
    expect(calls).toEqual([w, w]);
    expect(s.facts.at(-1)?.value).toMatchObject({ counts: { 'chain-volume': { ok: 2, failed: 0 } } });
    src.stop();
    // The reader alone, without the window: no read.
    const t = setup();
    const quiet: unknown[] = [];
    const src2 = new LiveFacts({
      readers: () => ({ ...t.f.readers, readChainVolume: async (r) => (quiet.push(r), true) }), tickMs: 1_000, minReadGapMs: MIN, survivalAfterMs: 30 * MIN,
      survivalReadDelayMs: 5_000, solUsdStartHours: 27, mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
    });
    src2.start(t.ctx);
    await t.flush();
    expect(quiet).toEqual([]);
    src2.stop();
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

  it('WORKER-1e: simulates at the spend the candidate was judged at, never without one, once a gap', async () => {
    const s = setup();
    const sims: [string, bigint][] = [];
    const src = new LiveFacts({
      readers: () => ({ ...s.f.readers, readSim: async (m, spend) => (sims.push([m, spend]), true) }), tickMs: 1_000, minReadGapMs: MIN, survivalAfterMs: 30 * MIN,
      survivalReadDelayMs: 5_000, solUsdStartHours: 27, mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
    });
    src.start(s.ctx);
    s.cands.set('M1', { migratedAtMs: T0, gates: [H16('sim')], spend: null } as never);
    s.cands.set('M2', { migratedAtMs: T0, gates: [H16('sim', 'stale')], spend: 13_000_000n } as never);
    s.timers.advance(1_000);
    await s.flush();
    expect(sims).toEqual([['M2', 13_000_000n]]);
    s.timers.advance(MIN - 2_000);
    await s.flush();
    expect(sims).toHaveLength(1);
    s.timers.advance(2_000);
    await s.flush();
    expect(sims).toEqual([['M2', 13_000_000n], ['M2', 13_000_000n]]);
    src.stop();
  });

  it('WORKER-1e: publishes the execution statistics every period, only when wired', async () => {
    const s = setup();
    const got: unknown[] = [];
    const stats = { attempts: 2, failed: 1, landingSlotsP50: 3, quoteErrorBpsP50: 40 };
    const src = new LiveFacts({
      readers: () => ({ ...s.f.readers, ingestExecStats: (x) => void got.push(x) }), tickMs: 1_000, minReadGapMs: MIN, survivalAfterMs: 30 * MIN,
      survivalReadDelayMs: 5_000, solUsdStartHours: 27, mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
      execStats: { read: () => stats, everyMs: 10_000 },
    });
    src.start(s.ctx);
    expect(got).toEqual([stats]);
    s.timers.advance(9_000);
    expect(got).toHaveLength(1);
    s.timers.advance(1_000);
    expect(got).toEqual([stats, stats]);
    src.stop();
    // Not wired: nothing, whatever the readers can do.
    const t = setup();
    const quiet: unknown[] = [];
    const src2 = new LiveFacts({
      readers: () => ({ ...t.f.readers, ingestExecStats: (x) => void quiet.push(x) }), tickMs: 1_000, minReadGapMs: MIN, survivalAfterMs: 30 * MIN,
      survivalReadDelayMs: 5_000, solUsdStartHours: 27, mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
    });
    src2.start(t.ctx);
    t.timers.advance(30_000);
    expect(quiet).toEqual([]);
    src2.stop();
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

  it('the regime turning on releases the reads (supervisor ruling: staging stays, a live volume source unblocks it)', async () => {
    const s = setup();
    s.src.start(s.ctx);
    s.cands.set('M1', { migratedAtMs: T0, gates: [{ gate: 'regime', code: 'unknown', input: 'curve-volume' }] });
    s.timers.advance(5_000);
    await s.flush();
    expect(s.f.calls.slice(1)).toEqual([]);
    // The regime is on: the next evaluation reaches the hard rejects and names the missing evidence.
    s.cands.set('M1', { migratedAtMs: T0, gates: [H16('mint'), H16('xcheck')] });
    s.timers.advance(1_000);
    await s.flush();
    expect(s.f.calls.slice(1)).toEqual([['accounts', 'M1'], ['xcheck', 'M1']]);
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
  it('hands fact sources the deployer index\'s prior mints (RUG-1c) and puts the account marks on the feed (WORKER-1c)', async () => {
    let ctx: FactContext | null = null;
    const h = makeWorker({ facts: [{ name: 'capture', start: (c) => void (ctx = c), stop: () => undefined }] });
    expect(await h.worker.start()).toEqual({ ok: true });
    const c = ctx as unknown as FactContext;
    expect(typeof c.priorMints).toBe('function');
    expect(c.priorMints!('NoSuchCreator', c.sink.now())).toEqual([]);
    h.worker.step();
    await h.worker.stop();
    // The account fact recorded after the first step carries this day's and week's marks.
    const dir = join(h.stateDir, 'recorder', h.worker.boot);
    const frames = rows(dir, /^frames-/, (l) => parseTyped(l) as Frame);
    const accounts = frames.filter((f) => f.body.type === 'fact' && f.body.key === ACCOUNT_KEY).map((f) => (f.body as { value: { history: { markedAtDayStart: unknown; markedAtWeekStart: unknown } } }).value.history);
    expect(accounts.some((a) => typeof a.markedAtDayStart === 'bigint' && typeof a.markedAtWeekStart === 'bigint')).toBe(true);
  });

  it('a raw account read on the live Feed becomes the gate facts, and the recording replays to the same facts', async () => {
    let ctx: FactContext | null = null;
    const h = makeWorker({ facts: [{ name: 'capture', start: (c) => void (ctx = c), stop: () => undefined }] });
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
    const h = makeWorker({ facts: [{ name: 'capture', start: (c) => void (ctx = c), stop: () => undefined }] });
    expect(await h.worker.start()).toEqual({ ok: true });
    const c = ctx as unknown as FactContext;
    const obs = { provider: 'test', slot: null, receivedAt: c.sink.now(), quality: [], commitment: 'confirmed' };
    // Shortlisted, its window still ahead: never evaluated.
    c.sink.fact(migrationKey(MINT2), { obs, graduatedAtMs: T + 3 * MIN, migratedAtMs: T + 3 * MIN, pool: MINT2, quoteAtMigration: 1n, price: { quote: 1n, base: 1n } });
    // The critical feed is up, so entries are not halted and candidates are evaluated.
    h.worker.feed.ingest('helius', { type: 'offchain', key: 'feed:status:helius', value: { state: 'up' } }, { receivedAt: c.sink.now() });
    const m = await passingMarket(h);
    expect(c.candidates().get(MINT2)).toEqual({ migratedAtMs: T + 3 * MIN, lastEvalMs: null, gates: null, spend: null, creator: null });
    // Every fact kept current except a holder read that cannot be parsed: the reject names the holders as evidence.
    await m.run(3_000, 400, () => {
      m.slot();
      m.pool();
      m.fact(holdersKey(MINT), { unreadable: true });
    });
    const gates = c.candidates().get(MINT)?.gates ?? null;
    expect(gates).not.toBeNull();
    expect(gates).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'malformed', input: 'holders', neededBy: expect.any(String), detail: expect.any(String) }));
    expect(readsFor(gates)).toEqual(['holders']);
    // Evaluated: the candidate's creator is known from its released create (RUG-1c checks that deployer).
    expect(c.candidates().get(MINT)?.creator).toEqual(expect.any(String));
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

describe('LiveFacts: the deployer check (WORKER-1c)', () => {
  const rugHalf: CandidateReason = { gate: 'H16', code: 'not-covered', input: 'coverage', neededBy: 'H14', detail: `${RUG_LABELS_UNAVAILABLE}: x coverage: y; deployer check: z` };
  const lookbackMs = TRIAL_POLICY.gates.deployerRugLookbackDays * 86_400_000;
  const make = (creator: string | null, tip: bigint | null = 900n) => {
    const timers = new ManualTimers(T0);
    const asked: RugCheckRequest[] = [];
    const f = fake();
    const readers: LiveReaders = { ...f.readers, readDeployerCheck: async (r) => (asked.push(r), true) };
    const cands = new Map([['CAND', { migratedAtMs: T0, lastEvalMs: T0, gates: [rugHalf], creator }]]);
    const from = rugCheckFromMs(T0 - lookbackMs, RUG_CONFIG);
    const prior = [{ mint: 'OLD', createdAtMs: from - 1 }, { mint: 'EDGE', createdAtMs: from }, { mint: 'NEW', createdAtMs: T0 - 1_000 }, { mint: 'CAND', createdAtMs: T0 - 500 }];
    const ctx = {
      sink: { fact: () => undefined, now: () => timers.now() }, timers, watched: () => new Set<string>(), candidates: () => cands, tip: () => tip,
      priorMints: (c: string) => (c === creator ? prior : []),
    } as unknown as FactContext;
    const src = new LiveFacts({
      readers: () => readers, tickMs: 1_000, minReadGapMs: MIN, survivalAfterMs: 30 * MIN, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
      mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 }, deployerCheck: { lookbackMs, rugs: RUG_CONFIG },
    });
    return { timers, asked, ctx, src, from };
  };
  const flush = async (): Promise<void> => {
    for (let k = 0; k < 5; k++) await Promise.resolve();
  };

  it('checks the candidate\'s creator with the index\'s mints from rugCheckFromMs on (the candidate excepted), as of the tip, at most once a gap', async () => {
    const m = make('DEV');
    m.src.start(m.ctx);
    await flush();
    expect(m.asked).toEqual([{ creator: 'DEV', mints: [{ mint: 'EDGE', createdAtMs: m.from }, { mint: 'NEW', createdAtMs: T0 - 1_000 }], fromMs: m.from, asOf: { slot: 900n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: T0 }, asOfMs: T0 }]);
    m.timers.advance(MIN - 1_000);
    await flush();
    expect(m.asked).toHaveLength(1);
    m.timers.advance(1_000);
    await flush();
    expect(m.asked).toHaveLength(2);
    m.src.stop();
  });

  it('no creator seen yet, or no tip: nothing is checked', async () => {
    for (const m of [make(null), make('DEV', null)]) {
      m.src.start(m.ctx);
      await flush();
      expect(m.asked).toEqual([]);
      m.src.stop();
    }
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

  it('checks a candidate\'s deployer over Helius RPC when H14\'s rug half is not covered (RUG-1c wiring)', async () => {
    const timers = new ManualTimers(T0);
    const methods: { method: string; address: unknown }[] = [];
    const http = async (req: HttpRequest): Promise<HttpResponse> => {
      if (req.body !== undefined) {
        const b = JSON.parse(req.body) as { method: string; params: unknown[] };
        methods.push({ method: b.method, address: b.params[0] });
        return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), header: () => null } as unknown as HttpResponse;
      }
      return { status: 404, text: '', header: () => null } as unknown as HttpResponse;
    };
    const sched = (spec: SchedulerSpec) => new Scheduler(spec, { timers });
    const rugHalf: CandidateReason = { gate: 'H16', code: 'not-covered', input: 'coverage', neededBy: 'H14', detail: `${RUG_LABELS_UNAVAILABLE}: x; deployer check: y` };
    const ingested: string[] = [];
    const ctx = {
      sink: { fact: () => undefined, now: () => timers.now() }, timers, watched: () => new Set<string>(), tip: () => 1_000n,
      candidates: () => new Map([['CAND', { migratedAtMs: T0, lastEvalMs: T0, gates: [rugHalf], creator: 'DEV' }]]),
      priorMints: () => [{ mint: 'PriorMint1111111111111111111111111111111111', createdAtMs: T0 - 3_600_000 }],
      schedulers: { helius: sched(HELIUS_FREE), alchemy: sched(ALCHEMY_FREE), jupiter: sched(JUPITER_FREE), rugcheck: sched(RUGCHECK_FREE) },
      ingest: { ingest: (_s: unknown, body: { key: string }) => void ingested.push(body.key) },
    } as unknown as FactContext;
    const stateDir = mkdtempSync(join(tmpdir(), 'facts-source-'));
    const src = liveFacts({ policy: TRIAL_POLICY, secrets: { get: () => 'k' } as unknown as Secrets, http, goplus: sched(GOPLUS_FREE), coinbase: sched(COINBASE_PUBLIC), stateDir });
    src.start(ctx);
    for (let k = 0; k < 200 && !ingested.includes('coverage:rugs:deployer:DEV'); k++) {
      await new Promise<void>((r) => setImmediate(r));
      timers.advance(100);
    }
    src.stop();
    expect(methods).toContainEqual({ method: 'getSignaturesForAddress', address: 'PriorMint1111111111111111111111111111111111' });
    expect(ingested).toContain('coverage:rugs:deployer:DEV');
    // The day's spend is kept in the state dir.
    expect(readdirSync(stateDir)).toContain(DEPLOYER_CHECK_SPEND_FILE);
  });

  it('with GitHub wired, lists releases through the API, downloads from github.com from the window\'s first day (lag plus cap), keeps verified days in the state dir and alerts on a changed release', async () => {
    const DAYMS = 86_400_000;
    const today = 20_654 + 500;
    const first = today - TRIAL_POLICY.regime.volumeLagDays - TRIAL_POLICY.regime.volumeWindowDays + 1;
    const timers = new ManualTimers(today * DAYMS + 3_600_000);
    const name = (d: number) => new Date(d * DAYMS).toISOString().slice(0, 10);
    const csvOf = (d: number) => ['hour_start_ms,lamports,covered', ...Array.from({ length: 24 }, (_, h) => `${d * DAYMS + h * 3_600_000},5,1`)].join('\n') + '\n';
    const checkOf = (d: number) => JSON.stringify({ day: name(d), hours: 24, mismatches: [], problems: [] });
    const bot = { login: 'github-actions[bot]', id: 41_898_282 };
    let forged = false;
    const rel = (d: number) => {
      const asset = (id: number, file: string, text: string) => ({ id, name: file, state: 'uploaded', uploader: bot, digest: `sha256:${createHash('sha256').update(forged ? `${text}x` : text).digest('hex')}`, browser_download_url: `https://github.com/macdarenz-droid/Meme-snipe/releases/download/data-volume-${name(d)}/${file}` });
      return { tag_name: `data-volume-${name(d)}`, author: bot, draft: false, prerelease: true, assets: [asset(d * 10 + 1, `volume-hours-${name(d)}.csv`, csvOf(d)), asset(d * 10 + 2, `volume-check-${name(d)}.json`, checkOf(d))] };
    };
    const urls: string[] = [];
    const http = async (req: HttpRequest): Promise<HttpResponse> => {
      urls.push(req.url);
      const ok = (text: string) => ({ status: 200, text, header: () => null }) as unknown as HttpResponse;
      if (req.url.startsWith('https://api.github.com/repos/macdarenz-droid/Meme-snipe/releases?per_page=100&page=')) return ok(JSON.stringify([rel(first - 1), rel(first)]));
      const m = /releases\/download\/data-volume-(\d{4}-\d{2}-\d{2})\/volume-(hours|check)-/.exec(req.url);
      if (m !== null) {
        const d = Date.parse(`${m[1]}T00:00:00Z`) / DAYMS;
        return ok(m[2] === 'hours' ? csvOf(d) : checkOf(d));
      }
      return { status: 404, text: 'Not Found', header: () => null } as unknown as HttpResponse;
    };
    const sched = (spec: SchedulerSpec) => new Scheduler(spec, { timers });
    const frames: { key: string; value: unknown }[] = [];
    const facts: { key: string; value: unknown }[] = [];
    const ctx = {
      sink: { fact: (key: string, value: unknown) => void facts.push({ key, value }), now: () => timers.now() }, timers, watched: () => new Set<string>(), candidates: () => new Map(), tip: () => null,
      schedulers: { helius: sched(HELIUS_FREE), alchemy: sched(ALCHEMY_FREE), jupiter: sched(JUPITER_FREE), rugcheck: sched(RUGCHECK_FREE) },
      ingest: { ingest: (_s: unknown, body: { type: string; key: string; value: unknown }) => void frames.push({ key: body.key, value: body.value }) },
    } as unknown as FactContext;
    const stateDir = mkdtempSync(join(tmpdir(), 'facts-source-'));
    const src = liveFacts({
      policy: TRIAL_POLICY, secrets: { get: () => 'k' } as unknown as Secrets, http, goplus: sched(GOPLUS_FREE), coinbase: sched(COINBASE_PUBLIC),
      github: { api: sched(GITHUB_RELEASES), downloads: sched(GITHUB_DOWNLOADS), stateDir },
    });
    src.start(ctx);
    const settleAll = async () => {
      for (let k = 0; k < 400; k++) {
        await new Promise<void>((r) => setImmediate(r));
        timers.advance(500);
      }
    };
    await settleAll();
    const gh = urls.filter((u) => u.includes('github.com'));
    expect(gh).toEqual([
      'https://api.github.com/repos/macdarenz-droid/Meme-snipe/releases?per_page=100&page=1',
      `https://github.com/macdarenz-droid/Meme-snipe/releases/download/data-volume-${name(first)}/volume-check-${name(first)}.json`,
      `https://github.com/macdarenz-droid/Meme-snipe/releases/download/data-volume-${name(first)}/volume-hours-${name(first)}.csv`,
    ]);
    expect(frames.filter((f) => f.key === RAW.volumeHour).length).toBe(24);
    expect(readdirSync(join(stateDir, 'chain-volume'))).toEqual([`data-volume-${name(first)}.json`]);
    // The next hour the listing shows another digest for that day: unknown, with an alert fact.
    forged = true;
    timers.advance(3_600_000);
    await settleAll();
    src.stop();
    expect(facts.filter((f) => f.key === CHAIN_VOLUME_ALERT_KEY)).toEqual([{ key: CHAIN_VOLUME_ALERT_KEY, value: expect.objectContaining({ detail: expect.stringContaining(`data-volume-${name(first)} changed`) }) }]);
  });
});
