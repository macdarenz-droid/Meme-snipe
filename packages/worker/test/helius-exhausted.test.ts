// HELIUS-EXHAUSTED (owner, 5 Oct): the worker uses Helius until Helius itself refuses for credits (429 "max usage
// reached"), tells that apart from a rate limit, holds Helius's non-exit calls and re-checks every 10 minutes, halts
// entries by name while it lasts, and reports the count, its first time and the credits by class in the daily summary.
// getProgramAccounts is metered at its published 10 credits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FactRpc } from '../src/facts/index.ts';
import { HELIUS_EXHAUSTED, type HttpClient, ProviderError, RpcHttp, type Source } from '../src/providers/index.ts';
import { DryRunRpc } from '../src/dryrun/rpc.ts';
import { EXHAUSTED_RECHECK_MS, HELIUS_FREE, HELIUS_GPA_CREDITS, ManualTimers, P0, P1, P2, P3, ScheduleRefused, Scheduler } from '../src/scheduler/index.ts';
import { CreditBook, HELIUS_WORKER, LiveProviders } from '../src/run/sources.ts';
import { haltCode, buildSummary, Summarizer, withoutCreditDetail, type SummaryInputs } from '../src/run/summary.ts';
import { checkSummary } from '../../ops/src/watchdog/summary.ts';
import { creditsFile } from '../src/run/state.ts';
import { testSecrets } from './helpers.ts';
import { Market, T, dueTimers, makeWorker, scriptedSource, tempState, type Harness } from './worker-harness.ts';

const NOW = Date.parse('2026-10-05T05:00:00Z');
const EXHAUSTED_BODY = '{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":1}';
const answer = (status: number, text: string): HttpClient => async () => ({ status, header: () => null, text });

describe('a 429 that says the credits are used up', () => {
  it('is "exhausted", not a rate limit: the scheduler holds non-exit calls and the window stays free; an ordinary 429 is a rate limit', async () => {
    const timers = new ManualTimers(NOW);
    const s = new Scheduler(HELIUS_WORKER, { timers });
    let status = 429;
    let text = EXHAUSTED_BODY;
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://helius.test', http: async () => ({ status, header: () => null, text }), scheduler: s, timeoutMs: 1_000 });
    const e = await rpc.call('getAccountInfo', [], P2).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).kind).toBe('exhausted');
    expect(s.status()).toMatchObject({ exhausted: true, exhaustedCount: 1, exhaustedFirstAtMs: NOW });
    // Not a rate limit: the window was not filled, so an exit call goes out at once.
    expect(s.check(P0).ok).toBe(true);
    // An ordinary 429 on another scheduler: a rate limit, the window full, nothing exhausted.
    const r = new Scheduler(HELIUS_WORKER, { timers });
    text = '{"jsonrpc":"2.0","error":{"code":-32429,"message":"rate limited"},"id":1}';
    const rpc2 = new RpcHttp({ provider: 'helius', url: () => 'https://helius.test', http: async () => ({ status, header: () => null, text }), scheduler: r, timeoutMs: 1_000 });
    const e2 = await rpc2.call('getAccountInfo', [], P2).catch((x: unknown) => x);
    expect((e2 as ProviderError).kind).toBe('rate_limited');
    expect(r.status()).toMatchObject({ exhausted: false, exhaustedCount: 0, exhaustedFirstAtMs: null });
    expect(r.check(P0).ok).toBe(false);
    status = 200;
  });

  it('the fact reads and the dry run read it the same way', async () => {
    const timers = new ManualTimers(NOW);
    const s = new Scheduler(HELIUS_WORKER, { timers });
    const facts = new FactRpc({ url: () => 'https://helius.test', http: answer(429, EXHAUSTED_BODY), scheduler: s, timeoutMs: 1_000 });
    expect(((await facts.call('getAccountInfo', [], P2).catch((x: unknown) => x)) as ProviderError).kind).toBe('exhausted');
    const d = new Scheduler(HELIUS_WORKER, { timers });
    const dry = new DryRunRpc({ url: () => 'https://helius.test', http: answer(429, EXHAUSTED_BODY), scheduler: d, timeoutMs: 1_000 });
    expect(((await dry.call('getMultipleAccounts', [], P2).catch((x: unknown) => x)) as ProviderError).kind).toBe('exhausted');
    expect([s.status().exhaustedCount, d.status().exhaustedCount]).toEqual([1, 1]);
  });
});

describe('the Helius scheduler while exhausted', () => {
  it('refuses P1–P3 (queued ones too) and serves P0; re-checks after 10 minutes; a success ends it; another refusal repeats it', async () => {
    const timers = new ManualTimers(NOW);
    const s = new Scheduler({ ...HELIUS_WORKER, window: { limit: 6, windowMs: 1_000 } }, { timers });
    // Fill the window so one P3 waits in the queue.
    for (let k = 0; k < 6; k++) expect(s.tryAcquire(P0).ok).toBe(true);
    const queued = s.run(P3, 1, async () => 'late').catch((x: unknown) => x);
    s.exhausted();
    expect(await queued).toBeInstanceOf(ScheduleRefused);
    timers.advance(1_000);
    for (const p of [P1, P2, P3]) await expect(s.run(p, 1, async () => 'no')).rejects.toBeInstanceOf(ScheduleRefused);
    expect(await s.run(P0, 1, async () => 'exit')).toBe('exit');
    // A P0 success is an answer too: the provider serves again, so the halt ends; the re-check wait still runs.
    expect(s.status().exhausted).toBe(false);
    s.exhausted();
    timers.advance(EXHAUSTED_RECHECK_MS - 1);
    await expect(s.run(P2, 1, async () => 'no')).rejects.toBeInstanceOf(ScheduleRefused);
    timers.advance(1);
    // The re-check: calls go out; another "used up" answer repeats the hold, the first time kept.
    await expect(s.run(P2, 1, async () => { s.exhausted(); throw new Error('429'); })).rejects.toThrow('429');
    expect(s.status()).toMatchObject({ exhausted: true, exhaustedCount: 3, exhaustedFirstAtMs: NOW });
    await expect(s.run(P2, 1, async () => 'no')).rejects.toBeInstanceOf(ScheduleRefused);
    timers.advance(EXHAUSTED_RECHECK_MS);
    expect(await s.run(P2, 1, async () => 'served')).toBe('served');
    expect(s.status().exhausted).toBe(false);
  });

  it('the worker\'s own count never halts Helius: no monthly halt, however much credits.json holds; other providers keep theirs', () => {
    expect(HELIUS_WORKER.budget).toBeUndefined();
    expect(HELIUS_FREE.budget).toBeDefined();
    const dir = tempState();
    const timers = new ManualTimers(NOW);
    creditsFile(dir).write({ month: '2026-10', used: { helius: 5_000_000, alchemy: 29_000_000 } });
    const p = new LiveProviders({ tradeStreams: false, secrets: testSecrets, http: answer(200, '{}'), factory: () => { throw new Error('no sockets'); }, credits: new CreditBook(dir, timers) });
    expect(p.helius.halted).toBe(false);
    expect(p.alchemy.halted).toBe(true);
  });

  it('getProgramAccounts is metered at its published 10 credits, a standard call at 1', async () => {
    const s = new Scheduler(HELIUS_WORKER, { timers: new ManualTimers(NOW) });
    const rpc = new FactRpc({ url: () => 'https://helius.test', http: answer(200, '{"jsonrpc":"2.0","id":1,"result":[]}'), scheduler: s, timeoutMs: 1_000 });
    await rpc.call('getProgramAccounts', [], P2);
    expect(s.status().creditsUsed).toBe(HELIUS_GPA_CREDITS);
    await rpc.call('getAccountInfo', [], P2);
    expect(s.status().creditsUsed).toBe(HELIUS_GPA_CREDITS + 1);
  });
});

const up = (h: Harness, m: Market, source: Source) => h.worker.feed.ingest(source, { type: 'offchain', key: `feed:status:${source}`, value: { state: 'up' } }, { receivedAt: m.now });
const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const run = async (m: Market, done: () => boolean, maxMs: number, each?: () => void): Promise<void> => {
  const start = m.now;
  while (!done()) {
    if (m.now - start > maxMs) throw new Error(`not within ${maxMs} virtual ms`);
    await m.run(400, 400, each);
    await new Promise<void>((r) => setTimeout(r, 1));
  }
};

describe('a worker while Helius refuses for credits', () => {
  it('halts entries by name (summary code helius-exhausted) and lifts the halt when Helius serves again', async () => {
    const state = { exhausted: false, count: 0, firstAtMs: null as number | null };
    const feeds = [scriptedSource('helius-ws', true, ['helius']), scriptedSource('coinbase-ws', true, ['coinbase'])];
    const h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, heliusExhaustion: () => state, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18874', ZEROED_API_ADDR: '127.0.0.1:18875' } });
    const m = new Market(h);
    const started = h.worker.start();
    let result: unknown = null;
    void started.then((r) => void (result = r));
    const frames = () => {
      m.slot();
      for (const f of feeds) for (const src of f.sources) up(h, m, src as Source);
    };
    await run(m, () => feeds.every((f) => f.starts === 1), 60_000);
    await run(m, () => result !== null, 60_000, frames);
    expect(result).toEqual({ ok: true });
    await run(m, () => !h.worker.health().halt_reasons.includes('seeding'), 60_000, frames);
    expect(h.worker.health().halt_reasons).not.toContain(HELIUS_EXHAUSTED);
    state.exhausted = true;
    state.count = 1;
    state.firstAtMs = m.now;
    await run(m, () => h.worker.health().halt_reasons.includes(HELIUS_EXHAUSTED), 5_000, frames);
    expect(lines(h.stateDir).filter((l) => l['kind'] === 'halt').at(-1)!['reasons']).toContain(HELIUS_EXHAUSTED);
    expect(haltCode(HELIUS_EXHAUSTED)).toBe('helius-exhausted');
    state.exhausted = false;
    await run(m, () => !h.worker.health().halt_reasons.includes(HELIUS_EXHAUSTED), 5_000, frames);
    await h.worker.stop();
  });
});

describe('the summary\'s credit detail', () => {
  const base: Omit<SummaryInputs, 'credits' | 'heliusExhaustion'> = {
    day: '2026-10-05', final: false, nowMs: NOW, fold: undefined, gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'on', uptimeS: 60, trades: [], openPositions: 0, solPrice: null,
  };
  const credits = [
    { provider: 'helius', credits_used: 10, monthly_credits: 1_000_000, credits_by_class: [0, 1, 4.2, 4.8] },
    { provider: 'alchemy', credits_used: 3, monthly_credits: 30_000_000, credits_by_class: [3, 0, 0, 0] },
  ];

  it('Helius\'s credits by class and its "used up" count with the first time, accepted by the watchdog\'s guard; stripped, the old shape', () => {
    const s = buildSummary({ ...base, credits, heliusExhaustion: { count: 4, firstAtMs: NOW } });
    expect(s.provider_credits).toEqual([
      { provider: 'helius', used_since_boot: 10, monthly: 1_000_000, by_class: [0, 1, 5, 5], exhausted: { count: 4, first_at: '2026-10-05T05:00:00.000Z' } },
      { provider: 'alchemy', used_since_boot: 3, monthly: 30_000_000, by_class: [3, 0, 0, 0] },
    ]);
    expect(checkSummary(JSON.stringify(s))).toMatchObject({ ok: true });
    const none = buildSummary({ ...base, credits, heliusExhaustion: { count: 0, firstAtMs: null } });
    expect(none.provider_credits[0]!.exhausted).toEqual({ count: 0, first_at: null });
    expect(checkSummary(JSON.stringify(none))).toMatchObject({ ok: true });
    const old = withoutCreditDetail(s);
    expect(old.provider_credits.map((c) => Object.keys(c).sort())).toEqual([['monthly', 'provider', 'used_since_boot'], ['monthly', 'provider', 'used_since_boot']]);
    expect(checkSummary(JSON.stringify(old))).toMatchObject({ ok: true });
    // Not the shape: a count with no first time; the count on another provider.
    const noTime = { ...s, provider_credits: [{ ...s.provider_credits[0]!, exhausted: { count: 1, first_at: null } }] };
    expect(checkSummary(JSON.stringify(noTime))).toMatchObject({ ok: false });
    const other = { ...s, provider_credits: [{ ...s.provider_credits[1]!, exhausted: s.provider_credits[0]!.exhausted }] };
    expect(checkSummary(JSON.stringify(other))).toMatchObject({ ok: false });
  });

  it('a watchdog from before the credit detail refuses it: the day goes again without it, the restart counts kept; one from before both gets neither', async () => {
    const dir = tempState();
    const bodies: string[] = [];
    const logs: string[] = [];
    let status = (body: string): number => (body.includes('"by_class"') ? 400 : 200);
    const sz = new Summarizer({
      journalPath: join(dir, 'journal.jsonl'), stateDir: dir,
      http: (async (req) => (bodies.push(String(req.body)), { status: status(String(req.body)), header: () => null, text: '{"ok":true,"written":true}' })) as HttpClient,
      watchdogUrl: 'https://w.test', key: 'k', now: () => NOW, log: (l) => void logs.push(l),
      live: () => ({ ...base, credits, heliusExhaustion: null }),
    });
    await sz.tick();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('"by_class"');
    const second = JSON.parse(bodies[1]!) as { worker: Record<string, unknown>; provider_credits: Record<string, unknown>[] };
    expect(second.provider_credits.every((c) => !('by_class' in c))).toBe(true);
    expect(Object.keys(second.worker)).toEqual(expect.arrayContaining(['restarts', 'exits', 'crash_sites']));
    expect(logs).toEqual(['Summary for 2026-10-05 refused; sent again without the credit detail.']);
    bodies.length = 0;
    logs.length = 0;
    status = (body) => (body.includes('"by_class"') || body.includes('"crash_sites"') ? 400 : 200);
    await sz.tick();
    expect(bodies).toHaveLength(3);
    expect(Object.keys((JSON.parse(bodies[2]!) as { worker: Record<string, unknown> }).worker)).not.toContain('crash_sites');
    expect(logs.at(-1)).toBe('Summary for 2026-10-05 refused; sent again without the restart counts.');
  });
});
