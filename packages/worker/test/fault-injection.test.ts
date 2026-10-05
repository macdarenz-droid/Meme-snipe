// TEST-3: the §18 acceptance cases as scripted faults on the real worker (virtual time, scripted market). Every wait is
// "until the effect, within a virtual-time bound", never a fixed window: a slow CI host only makes a run take longer.
import { appendFileSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { Ledger, openLedger, openLedgerReader } from '../../core/src/ledger/index.ts';
import { type BookEvent, emptyBook, type IntentState } from '../../core/src/lifecycle/index.ts';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import { FACT_READS_KEY, FactRpc, liveFacts } from '../src/facts/index.ts';
import type { FactSource } from '../src/run/facts.ts';
import { ProviderError, rpcHandler, type Secrets, type Source, scriptedHttp } from '../src/providers/index.ts';
import { ALCHEMY_FREE, COINBASE_PUBLIC, GOPLUS_FREE, HELIUS_FREE, JUPITER_FREE, P1, P3, RUGCHECK_FREE, Scheduler, type SchedulerSpec } from '../src/scheduler/index.ts';
import { LANDS, MINT, Market, POOL_ADDRESS, T, dueTimers, makeWorker, passingMarket, scriptedSource, tempState } from './worker-harness.ts';
import { POOL, QUOTE_VAULT, account } from '../../core/test/gates/world.ts';
import { poolSell } from '../../core/src/amm/index.ts';
import { withSlippage } from '../../core/src/fills/index.ts';
import { FEE_CONTEXT } from '../../core/test/gates/world.ts';
import { PUMP_AMM_GLOBAL_CONFIG, fromBase64 } from '../../core/src/chain/index.ts';
import { PUMP_AMM_FEE_CONFIG, type ReadAccount, decodeSnapshot } from '../src/run/snapshot.ts';
import type { WatchRead } from '../src/run/watch.ts';
import { SLOT_MS, parseConfig } from '../src/run/config.ts';
import { DEFAULT_LIVE_FEED } from '../src/providers/live-feed.ts';
import { SECOND_PATH_UNAVAILABLE } from '../src/run/worker.ts';
import { gatesOfStages, parsePool, xcheckKey } from '../../core/src/gates/index.ts';
import { NOT_EVALUATED } from '../src/engine/strategy.ts';
import { DEFAULT_DISK_POLICY, DISK_LOW, type DiskSample } from '../src/run/disk.ts';
import { STORE_GAP_VIA } from '../src/run/deployer-store.ts';
import { typedText } from '../src/run/json.ts';

type H = ReturnType<typeof makeWorker>;
const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8');
const lines = (dir: string) => journal(dir).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const kinds = (dir: string, kind: string) => lines(dir).filter((l) => l['kind'] === kind);
const entries = (h: H): IntentState[] => Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'entry');

/** Steps the worker `every` virtual ms until `done`; fails past `maxMs` of virtual time. Returns the virtual ms taken. */
const until = async (m: Market, done: () => boolean, maxMs: number, each?: () => void, every = 400, io = false): Promise<number> => {
  const start = m.now;
  while (!done()) {
    if (m.now - start > maxMs) throw new Error(`not within ${maxMs} virtual ms`);
    await m.run(every, every, each);
    if (io) await new Promise<void>((r) => setTimeout(r, 1));
  }
  return m.now - start;
};

/** The market moves: a new slot and a pool read at `scalePpm` of the passing price. */
const tick = (m: Market, scalePpm = 1_000_000n) => () => {
  m.slot();
  m.pool(scalePpm);
};

describe('§18: an API timeout after a buy landed (TEST-3)', () => {
  it('the send times out and the landing report is lost: the status read finds the fill, booked once, never bought twice', async () => {
    const seen = new Set<string>();
    let lost = 0;
    const fault = (e: BookEvent): BookEvent | null => {
      if (e.type !== 'intent') return e;
      // The send call times out after the transaction reached the network.
      if (e.event.type === 'send_accepted') return { ...e, event: { type: 'send_timeout' } };
      // The landing notice never arrives; only a status read can find the fill.
      if (e.event.type === 'status' && e.event.result === 'succeeded' && !seen.has(e.event.signature)) {
        seen.add(e.event.signature);
        lost++;
        return null;
      }
      return e;
    };
    const h = makeWorker({ worldFault: fault });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    await until(m, () => entries(h).some((i) => i.status === 'unknown'), 20_000, tick(m), 100);
    const id = entries(h)[0]!.intent.id;
    await until(m, () => h.worker.book.intents[id]!.status === 'reconciled', 180_000, tick(m));
    expect(lost).toBe(1);
    const i = h.worker.book.intents[id]!;
    expect(i.fills).toHaveLength(1);
    expect(i.reservation?.status).toBe('kept');
    // One entry, one position, one entry line: nothing bought twice.
    expect(entries(h).map((x) => x.intent.mint)).toEqual([MINT]);
    const open = Object.values(h.worker.book.positions).filter((p) => p.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.quantity).toBe(i.fills[0]!.tokens);
    expect(kinds(h.stateDir, 'entry')).toHaveLength(1);
    expect(h.worker.desk.illegal).toBe(0);
    expect(checkJournal(journal(h.stateDir)).problems).toEqual([]);
    await h.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });
});

/**
 * The state a process leaves when it dies after storing an intent's signed attempt and before the submit: the ledger
 * up to (not including) that intent's `submit`, every other state file as it was, and no paper attempt (the network
 * never saw the bytes). Built from a real run's stored events through the ledger's own write path.
 */
const diedAfterSign = (from: string, intentId: string, maxOpen: number): string => {
  const src = openLedgerReader(join(from, Ledger.FILE));
  const { events } = src.storedBookEvents({ maxOpenPositions: maxOpen });
  src.close();
  const cut = events.findIndex((e) => e.type === 'intent' && e.intentId === intentId && e.event.type === 'submit');
  expect(cut).toBeGreaterThan(0);
  const dir = tempState();
  for (const f of readdirSync(from)) if (!f.startsWith('ledger.sqlite') && f !== 'paper.json') cpSync(join(from, f), join(dir, f), { recursive: true });
  const led = openLedger(join(dir, Ledger.FILE), 'paper');
  let book = emptyBook({ maxOpenPositions: maxOpen });
  for (const e of events.slice(0, cut)) {
    book = led.recordBookEvent(book, e, { ts: 0, limits: { maxHeld: (2n ** 62n) as never, maxCount: Number.MAX_SAFE_INTEGER }, accountVersion: led.accountVersion() }).book;
  }
  led.close();
  expect(book.intents[intentId as never]?.status).toBe('signed');
  return dir;
};

describe('§18: a restart with a signed, unsent transaction (TEST-3)', () => {
  it('the bytes are never sent: the intent becomes unknown, settles as expired with no fill, and is released before any entry', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    await until(m, () => entries(h).some((i) => i.status === 'pending' || i.status === 'submitted'), 20_000, () => m.pool(), 100);
    const entry = entries(h)[0]!;
    const sig = entry.attempts[0]!.signature;
    await h.worker.kill();
    const dir = diedAfterSign(h.stateDir, entry.intent.id, h.session.policy.positions.maxOpen);

    const h2 = makeWorker({ stateDir: dir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const i = h2.worker.book.intents[entry.intent.id]!;
    expect(['abandoned', 'cancelled']).toContain(i.status);
    expect(i.fills).toEqual([]);
    expect(i.reservation?.status).toBe('released');
    // The restart moved it to unknown (never back to submitted), and the status read searched history.
    const events = (() => {
      const l = openLedgerReader(join(dir, Ledger.FILE));
      try {
        return l.intentEvents().filter((x) => x.intentId === entry.intent.id).map((x) => `${x.event}:${x.status}`);
      } finally {
        l.close();
      }
    })();
    expect(events).toContain('restart:unknown');
    expect(events).toContain('status:expired_unfilled');
    expect(events.filter((x) => x.startsWith('submit'))).toEqual([]);
    // Never sent: the paper network has no attempt with that signature, now or after the market moves on.
    const m2 = new Market(h2);
    await m2.run(4_000, 400, tick(m2));
    expect(h2.worker.apiInputs().attempts.has(sig)).toBe(false);
    expect(Object.values(h2.worker.book.positions).filter((p) => p.entryIntentId === entry.intent.id && p.quantity > 0n)).toEqual([]);
    await h2.worker.stop();
    expect(replayLedgerFile(join(dir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });
});

/** Reconciles, then lets the passing candidate enter and its entry land. */
const enter = async (h: H): Promise<Market> => {
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  // The price path is not this file's subject: the pool fact keeps coming while held (POS-1's test switch).
  const m = await passingMarket(h, { heldPoolFacts: true });
  await until(m, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), 30_000, tick(m), 100);
  return m;
};

describe('§18: a kill mid-trade (TEST-3)', () => {
  it('killed with the stop exit in flight: the restart settles that attempt unfilled before any entry, then the stop exits once, in full', async () => {
    const h = makeWorker();
    const m = await enter(h);
    const p0 = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!;
    const exitsInFlight = (x: H) => Object.values(x.worker.book.intents).filter((i) => i.intent.purpose === 'exit' && ['submitted', 'pending'].includes(i.status));
    // The price falls 30%: the stop fires; the kill comes while its attempt is on the network, before it lands.
    await until(m, () => exitsInFlight(h).length === 1, 20_000, tick(m, 700_000n), 100);
    const exit = exitsInFlight(h)[0]!;
    await h.worker.kill();

    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    // Settled before any entry: the attempt the old process sent never lands, nothing was sold, the position is whole.
    const settled = h2.worker.book.intents[exit.intent.id]!;
    expect(settled.fills).toEqual([]);
    expect(h2.worker.apiInputs().attempts.get(exit.attempts[0]!.signature)).toMatchObject({ outcome: 'expired' });
    expect(h2.worker.book.positions[p0.id]).toMatchObject({ status: expect.not.stringMatching(/^closed$/), quantity: p0.quantity, sold: 0n });
    // The market stays down: the stop fires again and the position closes, with one exit fill for the whole holding.
    // The market stays down: the stop fires again on the first slot and goes out on the ladder, not as a blocked retry
    // a minute later; the position closes with one exit fill for the whole holding.
    const m2 = new Market(h2, { heldPoolFacts: true });
    const sent = () => lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot && l['action'] === 'submit');
    const took = await until(m2, () => sent().length > 0, 10_000, tick(m2, 700_000n), 100);
    expect(took).toBeLessThanOrEqual(1_000);
    expect(lines(h.stateDir).some((l) => l['boot'] === h2.worker.boot && l['action'] === 'exit_blocked')).toBe(false);
    await until(m2, () => h2.worker.book.positions[p0.id]!.status === 'closed', 30_000, tick(m2, 700_000n));
    const exits = Object.values(h2.worker.book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === p0.id);
    const fills = exits.flatMap((i) => i.fills);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.tokens).toBe(p0.quantity);
    expect(h2.worker.book.positions[p0.id]!.sold).toBe(p0.quantity);
    // No entry in the second boot before its reconcile line, and the two boots' journal checks clean.
    const second = lines(h.stateDir).filter((l) => l['boot'] === h2.worker.boot);
    const rec = second.findIndex((l) => l['kind'] === 'reconcile');
    expect(rec).toBeGreaterThanOrEqual(0);
    expect(second.slice(0, rec).some((l) => l['kind'] === 'entry')).toBe(false);
    const report = checkJournal(journal(h.stateDir));
    expect(report.problems).toEqual([]);
    expect(report.boots).toBe(2);
    // The only refused world events are repeated answers about intents already settled.
    const refused = kinds(h.stateDir, 'decision').filter((l) => l['action'] === 'world_refused').map((l) => String((l['reasons'] as string[])[0]));
    expect(refused.every((r) => /\(from (reconciled|abandoned|cancelled)\)$/.test(r))).toBe(true);
    expect(h2.worker.desk.ledgerRefusals).toBe(0);
    await h2.worker.stop();
    expect(replayLedgerFile(join(h.stateDir, 'ledger.sqlite'))).toMatchObject({ ok: true });
  });
});


/** A frame from `source` that says its feed is up (each one also counts as the feed's latest frame). */
const up = (h: H, m: Market, source: Source) => h.worker.feed.ingest(source, { type: 'offchain', key: `feed:status:${source}`, value: { state: 'up' } }, { receivedAt: m.now });

/** Starts the worker (servers, its own loop, the seed) with `feeds` up. */
const boot = async (h: H, m: Market, feeds: readonly ReturnType<typeof scriptedSource>[]): Promise<void> => {
  const started = h.worker.start();
  let result: unknown = null;
  void started.then((r) => void (result = r));
  // The servers listen on real sockets: each virtual step also yields to the event loop's I/O.
  await until(m, () => feeds.every((f) => f.starts === 1), 60_000, undefined, 100, true);
  for (const f of feeds) for (const src of f.sources) up(h, m, src as Source);
  await until(m, () => result !== null, 60_000, undefined, 100, true);
  expect(result).toEqual({ ok: true });
};

describe('§18: a feed gap (TEST-3)', () => {
  it('a critical feed goes silent past the stale limit: no entry is proposed while it is out, exits stay able, and entries come back with it', async () => {
    const feeds = [scriptedSource('helius-ws', true, ['helius']), scriptedSource('coinbase-ws', true, ['coinbase'])];
    const h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18900', ZEROED_API_ADDR: '127.0.0.1:18901' } });
    const m = new Market(h);
    const frame = (source: Source) => up(h, m, source);
    await boot(h, m, feeds);
    // The SOL price feed says nothing from here on; the chain feed keeps its slots coming.
    await until(m, () => h.worker.health().halt_reasons.includes('feed coinbase-ws stale'), 30_000, () => m.slot(), 400);
    const haltAt = m.now;
    expect(kinds(h.stateDir, 'halt').at(-1)!['reasons']).toEqual(['feed coinbase-ws stale']);
    // The candidate passes every gate during the gap: nothing is proposed, and an exit could still go out.
    await passingMarket(h);
    await m.run(20_000, 400, tick(m));
    const proposed = () => kinds(h.stateDir, 'decision').filter((l) => l['action'] === 'enter').map((l) => Date.parse(String(l['ts'])));
    expect(proposed()).toEqual([]);
    expect(entries(h)).toEqual([]);
    expect(h.worker.health()).toMatchObject({ entries_halted: true, halt_reasons: ['feed coinbase-ws stale'], exit_capable: true });
    expect(m.now - haltAt).toBeGreaterThan(20_000);
    // The feed comes back: entries resume and the candidate enters.
    await until(m, () => !h.worker.health().entries_halted, 10_000, () => {
      frame('coinbase');
      tick(m)();
    }, 400);
    const resumeAt = m.now;
    expect(kinds(h.stateDir, 'resume').at(-1)!['reasons']).toEqual(['all critical feeds fresh, no pause']);
    await until(m, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), 30_000, () => {
      frame('coinbase');
      tick(m)();
    }, 400);
    expect(proposed().length).toBeGreaterThan(0);
    expect(proposed().every((t) => t >= resumeAt - 400)).toBe(true);
    // The chain feed goes silent with the position open: entries halt and the worker says no exit can go out.
    await until(m, () => h.worker.health().halt_reasons.includes('feed helius-ws stale'), 30_000, () => {
      frame('coinbase');
      m.pool();
    }, 400);
    expect(h.worker.health().exit_capable).toBe(false);
    await h.worker.stop();
  });
});

describe('§18: a provider rate-limits (TEST-3)', () => {
  it('every read answers 429: no fact is made, the provider is left alone for its window, an exit-class read goes before the queued reads, and the open position still exits', async () => {
    const timers = dueTimers(T - 16 * 86_400_000);
    const sched = (spec: SchedulerSpec) => new Scheduler(spec, { timers });
    const schedulers = { helius: sched(HELIUS_FREE), alchemy: sched(ALCHEMY_FREE), jupiter: sched(JUPITER_FREE), rugcheck: sched(RUGCHECK_FREE) };
    const at: number[] = [];
    const http = scriptedHttp(rpcHandler(() => undefined), { fault: () => (at.push(timers.now()), { kind: 'status', status: 429 }) });
    const live = liveFacts({ policy: TRIAL_POLICY, secrets: { get: () => 'k' } as unknown as Secrets, http, goplus: sched(GOPLUS_FREE), coinbase: sched(COINBASE_PUBLIC) });
    // What the fact source puts on the feed: raw reads (none may come from a 429) and its read counts.
    const raw: string[] = [];
    let reads: { counts: Record<string, { ok: number; failed: number }> } | null = null;
    const facts: FactSource = {
      name: live.name,
      start: (ctx) => live.start({
        ...ctx,
        ingest: { ingest: (src, body, o) => (raw.push('key' in body ? String(body.key) : body.type), ctx.ingest.ingest(src, body, o)) },
        sink: { ...ctx.sink, fact: (k, v) => (k === FACT_READS_KEY && (reads = v as typeof reads), ctx.sink.fact(k, v)) },
      }),
      stop: () => live.stop(),
    };
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    const h = makeWorker({ timers, facts: [facts], schedulers, sources: () => feeds, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18902', ZEROED_API_ADDR: '127.0.0.1:18903' } });
    const m = new Market(h, { heldPoolFacts: true });
    await boot(h, m, feeds);
    // The fact source's first read (SOL/USD bars) was refused 429: counted failed, and nothing went on the feed.
    await until(m, () => reads !== null, 10_000, undefined, 100);
    expect(reads!.counts['sol-usd']).toEqual({ ok: 0, failed: 1 });
    expect(raw).toEqual([]);
    await passingMarket(h);
    await until(m, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), 30_000, tick(m), 100);
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;

    // A busy minute of candidate reads (P3) on the worker's Helius scheduler, every one answered 429.
    const rpc = new FactRpc({ url: () => 'https://rpc.example/', http, scheduler: schedulers.helius, timeoutMs: 10_000 });
    const method = (k: number) => (JSON.parse(http.calls[k]!.body ?? '{}') as { method: string }).method;
    const n0 = http.calls.length;
    const settled: string[] = [];
    for (let k = 0; k < 12; k++) void rpc.call('getMultipleAccounts', [], P3).catch((e: unknown) => void settled.push(e instanceof ProviderError ? e.kind : String(e)));
    await until(m, () => settled.length >= 1, 5_000, undefined, 10);
    const firstAt = timers.now();
    // An exit-class read (P1) asked right after the first 429.
    let exitRead: string | null = null;
    void rpc.call('getTransaction', [], P1).catch((e: unknown) => void (exitRead = e instanceof ProviderError ? e.kind : String(e)));
    await until(m, () => exitRead !== null, 5_000, undefined, 10);
    const sentAt = at.slice(n0);
    expect(exitRead).toBe('rate_limited');
    const calls = Array.from({ length: http.calls.length - n0 }, (_, k) => method(n0 + k));
    const p1 = calls.indexOf('getTransaction');
    // The first burst fits the window above the exit floor; after the 429 nothing more goes for one window.
    const burst = sentAt.filter((t) => t <= firstAt).length;
    expect(burst).toBeLessThanOrEqual(HELIUS_FREE.window.limit - HELIUS_FREE.floors[P3]);
    expect(sentAt.slice(burst).every((t) => t >= sentAt[0]! + HELIUS_FREE.window.windowMs)).toBe(true);
    // When the window opens, the exit-class read goes before every queued candidate read.
    expect(p1).toBe(burst);

    // Every read failed and none became a fact; the stop still exits the open position.
    await until(m, () => settled.length === 12, 30_000, undefined, 100);
    expect(settled.every((k) => k === 'rate_limited' || /ScheduleRefused|shed|expired/.test(k))).toBe(true);
    await until(m, () => h.worker.book.positions[pid]!.status === 'closed', 30_000, tick(m, 700_000n));
    expect(raw).toEqual([]);
    await h.worker.stop();
  });

  it('entries stop through the gates, not a global halt: a candidate whose fact can only come from a refused read is rejected for that fact and never entered', async () => {
    const timers = dueTimers(T - 16 * 86_400_000);
    const sched = (spec: SchedulerSpec) => new Scheduler(spec, { timers });
    const schedulers = { helius: sched(HELIUS_FREE), alchemy: sched(ALCHEMY_FREE), jupiter: sched(JUPITER_FREE), rugcheck: sched(RUGCHECK_FREE) };
    const http = scriptedHttp(rpcHandler(() => undefined), { fault: () => ({ kind: 'status', status: 429 }) });
    const live = liveFacts({ policy: TRIAL_POLICY, secrets: { get: () => 'k' } as unknown as Secrets, http, goplus: sched(GOPLUS_FREE), coinbase: sched(COINBASE_PUBLIC) });
    let reads: { counts: Record<string, { ok: number; failed: number }> } | null = null;
    const facts: FactSource = {
      name: live.name,
      start: (ctx) => live.start({ ...ctx, sink: { ...ctx.sink, fact: (k, v) => (k === FACT_READS_KEY && (reads = v as typeof reads), ctx.sink.fact(k, v)) } }),
      stop: () => live.stop(),
    };
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    const h = makeWorker({ timers, facts: [facts], schedulers, sources: () => feeds, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18908', ZEROED_API_ADDR: '127.0.0.1:18909' } });
    const m = new Market(h);
    await boot(h, m, feeds);
    // Every gate passes but the third-party cross-check, which only a read can bring, and every read answers 429.
    const pm = await passingMarket(h, { omit: [xcheckKey(MINT)] });
    const entered = () => kinds(h.stateDir, 'decision').filter((l) => l['action'] === 'enter');
    // Until the read has been refused twice, or an entry happens.
    await until(pm, () => (reads?.counts['xcheck']?.failed ?? 0) >= 2 || entered().length > 0, 180_000, tick(pm), 400);
    await pm.run(10_000, 400, tick(pm));
    expect(entered()).toEqual([]);
    expect(reads!.counts['xcheck']).toMatchObject({ ok: 0 });
    expect(Object.values(h.worker.book.positions)).toEqual([]);
    // Not a global halt: no halt reason names the provider; the gate says which fact is missing.
    expect(h.worker.health().halt_reasons).toEqual([]);
    // From T on (every other fact passing), each reject names only the cross-check, missing; the cross-check is a stage-2
    // gate, so stages 3 and 4 are named as not evaluated (FACTS-1f, BT-2's stages).
    const later = `; ${NOT_EVALUATED}${gatesOfStages([3, 4]).join(',')}`;
    const rejects = kinds(h.stateDir, 'decision').filter((l) => l['action'] === 'reject' && Date.parse(String(l['ts'])) >= T).map((l) => (l['reasons'] as string[]).slice(3));
    expect(rejects.length).toBeGreaterThan(0);
    for (const r of rejects) expect(r).toEqual([expect.stringMatching(new RegExp(`^hard reject H16: H16 missing no xcheck as of slot \\d+${later}$`))]);
    await h.worker.stop();
  }, 60_000);
});

/** The harness pool's real accounts (core's chain fixtures), with the quote vault at `scalePpm` of its balance. */
const chainAccount = (address: string): ReadAccount => {
  const a = account(address);
  return { owner: a.owner, data: fromBase64(a.dataBase64) };
};
const scaledRead = (h: H, scalePpm: () => bigint, calls: string[][], latencyMs = 0) => async (addresses: readonly string[]): Promise<WatchRead> => {
  calls.push([...addresses]);
  if (latencyMs > 0) await new Promise<void>((r) => h.timers.setTimeout(r, latencyMs));
  const accounts = addresses.map((address) => {
    const acc = chainAccount(address);
    if (address !== POOL.poolQuoteTokenAccount || acc === null) return acc;
    const data = acc.data.slice();
    new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(64, (QUOTE_VAULT * scalePpm()) / 1_000_000n, true);
    return { owner: acc.owner, data };
  });
  // A confirmed read's context slot: behind the tip, so a later pool fact from the feed is newer.
  return { slot: h.worker.feed.releasedThrough, accounts };
};

describe('§18: the feed dies for 5 minutes with a position open and the pool falls 40% (WATCH-1)', () => {
  it('the watch sees the stale market on its own timer, reads a coherent snapshot by the second path, and the exit goes out priced from it alone', async () => {
    let scale = 1_000_000n;
    const calls: string[][] = [];
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    const timers = dueTimers(T - 16 * 86_400_000);
    let h!: H;
    h = makeWorker({ timers, sources: () => feeds, watchRead: (a) => scaledRead(h, () => scale, calls)(a), config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18904', ZEROED_API_ADDR: '127.0.0.1:18905' } });
    // The pool fact keeps coming until the feed dies (POS-1's test switch), so the watch has nothing to read before.
    const m = new Market(h, { heldPoolFacts: true });
    await boot(h, m, feeds);
    await passingMarket(h);
    await until(m, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), 30_000, tick(m), 100);
    const p0 = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!;
    // The entry in flight and the open were watched already (risk review B1): the vault layout was learned then.
    expect(calls[0]).toEqual([POOL_ADDRESS]);
    const before = calls.length;
    // A held minute on a healthy feed: no read at all (the CU projection at the defaults: one read at the open, 20 CU,
    // and nothing after it while the pool's facts keep coming).
    await m.run(60_000, 100, tick(m));
    expect(calls.length).toBe(before);
    // Swaps on the pool give the strategy observed fee terms of its own, before the feed dies.
    for (let k = 0; k < 3; k++) {
      m.swap('BuyEvent', `buyer${k}`, 1_000_000n);
      await m.run(400, 100, tick(m));
    }
    const observed = h.worker.strategy.observedFees(MINT);
    expect(observed).toBeDefined();
    // While the feed is alive the watch reads nothing: each slot releases a new pool fact.
    expect(calls.length).toBe(before);
    // The feed dies: no slot, no pool fact, nothing. The pool falls 40% on chain.
    scale = 600_000n;
    const deadAt = m.now;
    const mine = () => kinds(h.stateDir, 'decision').filter((l) => Date.parse(String(l['ts'])) >= deadAt);
    const took = await until(m, () => mine().some((l) => l['action'] === 'submit'), 60_000, undefined, 100);
    // Within the set time: the stale limit, one watch period, the feed's stale release, and a step.
    const w = (parseConfig({ ZEROED_STATE_DIR: '/x', ZEROED_MODE: 'paper' }, () => null) as { config: { watch: { staleMs: number; everyMs: number } } }).config.watch;
    expect(took).toBeLessThanOrEqual(w.staleMs + w.everyMs + 2_000 + 500);
    // The vault layout is known: the first read after the feed died is the coherent read (pool, vaults, mint, GlobalConfig, FeeConfig).
    expect(calls[before]).toEqual([POOL_ADDRESS, POOL.poolBaseTokenAccount, POOL.poolQuoteTokenAccount, MINT, PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_FEE_CONFIG]);
    // The exit is the price stop, priced from the snapshot alone: its reserves and its fee context.
    expect(mine().find((l) => l['action'] === 'trigger_exit')!['reasons']).toEqual(expect.arrayContaining([expect.stringMatching(/^price_stop/)]));
    const snap = decodeSnapshot(MINT, POOL_ADDRESS, 0n, calls[before]!.map((a) => (a === POOL.poolQuoteTokenAccount ? { ...chainAccount(a)!, data: (() => {
      const d = chainAccount(a)!.data.slice();
      new DataView(d.buffer, d.byteOffset, d.byteLength).setBigUint64(64, (QUOTE_VAULT * 600_000n) / 1_000_000n, true);
      return d;
    })() } : chainAccount(a))));
    if (!snap.ok) throw new Error(snap.reason);
    const exit = Object.values(h.worker.book.intents).find((i) => i.intent.purpose === 'exit' && i.intent.positionId === p0.id)!;
    const q = poolSell(snap.snapshot.state, exit.attempts[0]!.quote.inAmount, snap.snapshot.ctx);
    if (!q.ok) throw new Error(q.detail);
    expect(exit.attempts[0]!.quote.quotedOut).toBe(q.trade.userQuote);
    // The feed's own fee terms, the published ones and those observed on the pool's swaps, would price it differently:
    // the snapshot's fee context is the one used.
    for (const feed of [FEE_CONTEXT, observed!]) {
      const mixed = poolSell(snap.snapshot.state, exit.attempts[0]!.quote.inAmount, feed);
      expect(mixed.ok && mixed.trade.userQuote).not.toBe(q.trade.userQuote);
    }
    expect(kinds(h.stateDir, 'alert')).toEqual([]);
    // Still dead for the rest of the 5 minutes: entries halted, no exit able to land, the watch keeps the price fresh.
    await m.run(5 * 60_000 - (m.now - deadAt), 1_000);
    expect(h.worker.health()).toMatchObject({ entries_halted: true, critical: [] });
    expect(calls.length).toBeGreaterThan(50);
    // The feed comes back at the fallen price: the exit lands and the position closes in full.
    await until(m, () => h.worker.book.positions[p0.id]!.status === 'closed', 60_000, tick(m, 600_000n), 400);
    expect(h.worker.book.positions[p0.id]!.sold).toBe(p0.quantity);
    await h.worker.stop();
  }, 60_000);

  it('a second path that fails raises the critical alert once, keeps trying every period, and never prices the position meanwhile', async () => {
    let failing = true;
    const calls: string[][] = [];
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    let h!: H;
    h = makeWorker({
      timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds,
      watchRead: (a) => (failing ? (calls.push([...a]), Promise.reject(new Error('alchemy timed out'))) : scaledRead(h, () => 600_000n, calls)(a)),
      config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18906', ZEROED_API_ADDR: '127.0.0.1:18907' },
    });
    const m = new Market(h, { heldPoolFacts: true });
    await boot(h, m, feeds);
    await passingMarket(h);
    await until(m, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), 30_000, tick(m), 100);
    const p0 = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!;
    const deadAt = m.now;
    await until(m, () => h.worker.health().critical.length > 0, 10_000, undefined, 100);
    expect(h.worker.health().critical).toEqual([`${MINT}: no fresh price (alchemy timed out)`]);
    const n = calls.length;
    await m.run(20_000, 500);
    // Tried again every period, alerted once, and nothing was sent on a price it does not have.
    expect(calls.length - n).toBeGreaterThanOrEqual(15);
    expect(kinds(h.stateDir, 'alert').map((l) => l['level'])).toEqual(['critical']);
    expect(kinds(h.stateDir, 'decision').filter((l) => Date.parse(String(l['ts'])) >= deadAt && l['action'] === 'submit')).toEqual([]);
    expect(h.worker.book.positions[p0.id]!.status).toBe('open');
    // The path recovers: the alert clears and the stop goes out on the snapshot.
    failing = false;
    await until(m, () => kinds(h.stateDir, 'decision').some((l) => Date.parse(String(l['ts'])) >= deadAt && l['action'] === 'submit'), 10_000, undefined, 100);
    expect(kinds(h.stateDir, 'alert').map((l) => l['level'])).toEqual(['critical', 'cleared']);
    expect(h.worker.health().critical).toEqual([]);
    await h.worker.stop();
  }, 60_000);

  it('a flagged pool fact is no market: the watch reads on its next look, never waiting out the stale limit as for a fresh release', async () => {
    const readAt: number[] = [];
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    let h!: H;
    h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, watchRead: (a) => {
      readAt.push(h.timers.now());
      return scaledRead(h, () => 1_000_000n, [])(a);
    }, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18916', ZEROED_API_ADDR: '127.0.0.1:18917' } });
    const m = new Market(h);
    await boot(h, m, feeds);
    // The pool's facts keep coming while held (a trading pool), so the watch has nothing to read.
    const pm = await passingMarket(h, { heldPoolFacts: true });
    const readSlot = h.worker.feed.releasedThrough;
    pm.tradesStart(readSlot - 100n);
    pm.accountsRead(readSlot);
    await until(m, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), 30_000, tick(pm), 100);
    await m.run(3_000, 100, tick(pm));
    const quiet = readAt.length;
    await m.run(2_000, 100, tick(pm));
    expect(readAt.length).toBe(quiet);
    // The swap stream gaps: POS-1 re-releases the pool fact flagged, and no fresh one follows.
    pm.heldPoolFacts = false;
    pm.tradesGap(h.worker.feed.openSlot, null);
    await until(m, () => (parsePool(h.worker.poolFact(MINT))?.obs.quality ?? []).includes('partial'), 4_000, () => m.slot(), 100);
    const flaggedAt = m.now;
    await until(m, () => readAt.length > quiet, 2_000, () => m.slot(), 100);
    const w = (parseConfig({ ZEROED_STATE_DIR: '/x', ZEROED_MODE: 'paper' }, () => null) as { config: { watch: { staleMs: number; everyMs: number } } }).config.watch;
    expect(readAt[quiet]! - flaggedAt).toBeLessThanOrEqual(w.everyMs);
    await h.worker.stop();
  }, 60_000);

  it('a held position whose swap stream gapped (POS-1 flags its pool fact) with no swap after: the snapshot alone sees a 30% drop, and the stop fires within the stale limit, one period and a step', async () => {
    let scale = 1_000_000n;
    const calls: string[][] = [];
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    let h!: H;
    const isOpen = () => Object.values(h.worker.book.positions).some((p) => p.status !== 'closed' && p.quantity > 0n);
    const readAt: { ms: number; open: boolean }[] = [];
    h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, watchRead: (a) => {
      readAt.push({ ms: h.timers.now(), open: isOpen() });
      return scaledRead(h, () => scale, calls)(a);
    }, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18912', ZEROED_API_ADDR: '127.0.0.1:18913' } });
    const m = new Market(h);
    await boot(h, m, feeds);
    const pm = await passingMarket(h);
    const readSlot = h.worker.feed.releasedThrough;
    pm.tradesStart(readSlot - 100n);
    pm.accountsRead(readSlot);
    let seenOpenAt = Number.NaN;
    await until(m, () => isOpen(), 30_000, () => {
      tick(pm)();
      if (Number.isNaN(seenOpenAt) && isOpen()) seenOpenAt = m.now;
    }, 100);
    if (Number.isNaN(seenOpenAt)) seenOpenAt = m.now;
    // The open is read at once, in the step that books it, whatever its market's age (no later than the test sees it).
    expect(readAt.find((r) => r.open)!.ms).toBeLessThanOrEqual(seenOpenAt);
    const p0 = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!;
    // The re-subscribe leaves a gap: the producer re-releases the pool fact flagged, and no swap comes after it.
    pm.tradesGap(h.worker.feed.openSlot, null);
    await until(m, () => (parsePool(h.worker.poolFact(MINT))?.obs.quality ?? []).includes('partial'), 4_000, () => m.slot(), 100);
    // A flagged pool fact is no market (poolOf would be null): the market is the snapshot.
    await m.run(3_000, 100, () => m.slot());
    expect(h.worker.poolOf(MINT)).not.toBeNull();
    expect(h.worker.book.positions[p0.id]!.status).toBe('open');
    // The pool falls 30%, seen by the snapshot alone: the stop goes out in time.
    scale = 700_000n;
    const dropAt = m.now;
    const mine = () => kinds(h.stateDir, 'decision').filter((l) => Date.parse(String(l['ts'])) >= dropAt);
    const took = await until(m, () => mine().some((l) => l['action'] === 'submit'), 30_000, () => m.slot(), 100);
    const w = (parseConfig({ ZEROED_STATE_DIR: '/x', ZEROED_MODE: 'paper' }, () => null) as { config: { watch: { staleMs: number; everyMs: number } } }).config.watch;
    expect(took).toBeLessThanOrEqual(w.staleMs + w.everyMs + 100);
    expect(mine().find((l) => l['action'] === 'trigger_exit')!['reasons']).toEqual(expect.arrayContaining([expect.stringMatching(/^price_stop/)]));
    await h.worker.stop();
  }, 60_000);

  it('an entry in flight is watched on its decision\'s pool, and once it settles unfilled the watch stops reading for it', async () => {
    const calls: string[][] = [];
    const at: number[] = [];
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    let h!: H;
    // Nothing lands: the entry stays in flight until it expires unfilled.
    h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), scenario: { ...LANDS, landPpm: { pumpswap: 0n, 'pump-curve': 0n } }, sources: () => feeds, watchRead: (a) => {
      at.push(h.timers.now());
      return scaledRead(h, () => 1_000_000n, calls)(a);
    }, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18914', ZEROED_API_ADDR: '127.0.0.1:18915' } });
    const m = new Market(h);
    await boot(h, m, feeds);
    const pm = await passingMarket(h);
    const entries = () => Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'entry');
    const live = new Set(['exposure_reserved', 'prepared', 'signed', 'submitted', 'pending', 'unknown']);
    await until(m, () => entries().some((i) => live.has(i.status)), 30_000, tick(pm), 100);
    // In flight: the pool fact stops (held), and the watch keeps the market younger than the quote age.
    const ages: number[] = [];
    await until(m, () => !entries().some((i) => live.has(i.status)), 60_000, () => {
      m.slot();
      if (entries().some((i) => live.has(i.status))) ages.push(m.now - h.worker.poolOf(MINT)!.atMs);
    }, 100);
    expect(ages.length).toBeGreaterThan(5);
    // The pool's facts stop when the entry is sent (a quiet pool): once, the last feed fact (up to one release old) ages
    // until the first snapshot lands, at most release + stale + every + latency + release; from then on the snapshots
    // keep it under the quote age.
    const w = (parseConfig({ ZEROED_STATE_DIR: '/x', ZEROED_MODE: 'paper' }, () => null) as { config: { watch: { staleMs: number; everyMs: number; latencyMs: number } } }).config.watch;
    const release = DEFAULT_LIVE_FEED.horizonSlots * SLOT_MS;
    expect(Math.max(...ages)).toBeLessThanOrEqual(release + w.staleMs + w.everyMs + w.latencyMs + release);
    // The quiet pool is read before its last fact passes the quote age.
    const factAt = parsePool(h.worker.poolFact(MINT))!.obs.receivedAt;
    expect(at.find((t) => t > factAt)! - factAt).toBeLessThan(TRIAL_POLICY.gates.maxQuoteAgeMs);
    const peak = ages.indexOf(Math.max(...ages));
    expect(ages.slice(peak + 1).length).toBeGreaterThan(3);
    expect(Math.max(...ages.slice(peak + 1))).toBeLessThan(TRIAL_POLICY.gates.maxQuoteAgeMs);
    expect(calls.length).toBeGreaterThan(0);
    // Settled unfilled: no read starts after it.
    const settledAt = m.now;
    await m.run(10_000, 100, () => m.slot());
    expect(at.filter((t) => t > settledAt)).toEqual([]);
    await h.worker.stop();
  }, 60_000);

  it('slots arrive but no pool fact does: the watched market stays younger than the quote age every step, and the paper exit fills on the snapshot\'s reserves', async () => {
    let scale = 1_000_000n;
    const calls: string[][] = [];
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    let h!: H;
    // Every read answers 300 ms late (inside the 400 ms the timing allows).
    const isOpen = () => Object.values(h.worker.book.positions).some((p) => p.status !== 'closed' && p.quantity > 0n);
    const readAt: { ms: number; open: boolean }[] = [];
    h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, watchRead: (a) => {
      readAt.push({ ms: h.timers.now(), open: isOpen() });
      return scaledRead(h, () => scale, calls, 300)(a);
    }, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18910', ZEROED_API_ADDR: '127.0.0.1:18911' } });
    const m = new Market(h);
    await boot(h, m, feeds);
    await passingMarket(h);
    await until(m, () => isOpen(), 30_000, tick(m), 100);
    const p0 = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!;
    // From here only slot notices and no swap: the position's pool fact never moves again (a quiet pool under POS-1).
    // Measured from the step the position opens: the watch kept the entry's pool fresh while it was in flight.
    const ages: number[] = [m.now - h.worker.poolOf(MINT)!.atMs];
    const seen = new Set<number>();
    for (let k = 0; k < 200; k++) {
      await m.run(100, 100, () => m.slot());
      const at = h.worker.poolOf(MINT)!.atMs;
      seen.add(at);
      ages.push(m.now - at);
    }
    expect(Math.max(...ages)).toBeLessThan(TRIAL_POLICY.gates.maxQuoteAgeMs);
    // marketAt moves: many snapshots, one after another.
    expect(seen.size).toBeGreaterThan(10);
    expect(h.worker.book.positions[p0.id]!.status).toBe('open');
    // The pool falls 40%: the stop exits, and the paper fill is priced on the snapshot's reserves, not the old pool fact.
    scale = 600_000n;
    await until(m, () => h.worker.book.positions[p0.id]!.status === 'closed', 30_000, () => m.slot(), 100);
    const exit = Object.values(h.worker.book.intents).find((i) => i.intent.purpose === 'exit' && i.intent.positionId === p0.id && i.fills.length > 0)!;
    const sold = exit.fills[0]!;
    // The expected fill from the scripted read itself, decoded on its own (not through the worker).
    const snap = decodeSnapshot(MINT, POOL_ADDRESS, 0n, (await scaledRead(h, () => 600_000n, [])(calls.at(-1)!)).accounts);
    if (!snap.ok) throw new Error(snap.reason);
    const at = poolSell(snap.snapshot.state, sold.tokens, snap.snapshot.ctx);
    if (!at.ok) throw new Error(at.detail);
    const attempt = exit.attempts.find((a) => a.signature === sold.signature)!;
    expect(sold.sol).toBe(withSlippage(at.trade.userQuote, attempt.quote.quotedOut, LANDS.slippagePpm));
    expect(snap.snapshot.state.quoteVault).toBe((QUOTE_VAULT * 600_000n) / 1_000_000n);
    // Closed: the watch reads nothing more for it (its entry no longer counts either).
    const closedAt = m.now;
    await m.run(5_000, 100, () => m.slot());
    expect(readAt.filter((r) => r.ms > closedAt)).toEqual([]);
    await h.worker.stop();
  }, 60_000);

  it('entries stop while the second price path cannot serve: none configured, or its budget halted', async () => {
    for (const o of [{ watchRead: null }, { watchHalted: () => true }] as const) {
      const h = makeWorker(o);
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      h.worker.step();
      expect(h.worker.health().halt_reasons).toEqual([SECOND_PATH_UNAVAILABLE]);
      const m = await passingMarket(h);
      await m.run(10_000, 400, tick(m));
      expect(Object.values(h.worker.book.positions)).toEqual([]);
      expect(h.worker.health().halt_reasons).toContain(SECOND_PATH_UNAVAILABLE);
      await h.worker.stop();
    }
    // With the path back, nothing names it.
    let halted = true;
    const h = makeWorker({ watchHalted: () => halted });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    h.worker.step();
    expect(h.worker.health().halt_reasons).toEqual([SECOND_PATH_UNAVAILABLE]);
    halted = false;
    h.worker.step();
    expect(h.worker.health().halt_reasons).toEqual([]);
    await h.worker.stop();
  });
});

describe('DISK-GUARD: free space runs low (golden rule: a full disk is an outage)', () => {
  it('the recorder pauses first, then entries are refused with exits going on; each comes back above its resume line', async () => {
    const P = DEFAULT_DISK_POLICY;
    let free = 10 * 1024 ** 3;
    const reads: number[] = [];
    const disk = (atMs: number): DiskSample => (reads.push(atMs), { atMs, freeBytes: free, totalBytes: 25 * 1024 ** 3, recorderBytes: 7 });
    const feeds = [scriptedSource('helius-ws', true, ['helius']), scriptedSource('coinbase-ws', true, ['coinbase'])];
    const h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, disk, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18904', ZEROED_API_ADDR: '127.0.0.1:18905' } });
    const m = new Market(h, { heldPoolFacts: true });
    await boot(h, m, feeds);
    // Both feeds stay fresh throughout: the SOL price feed says it is up with every market step.
    const step = (scalePpm = 1_000_000n) => () => {
      up(h, m, 'coinbase');
      tick(m, scalePpm)();
    };
    await until(m, () => h.worker.health().disk?.free_bytes === free, 70_000, step(), 400);
    expect(h.worker.health().disk).toEqual({ free_bytes: free, total_bytes: 25 * 1024 ** 3, recorder_bytes: 7, days_to_full: null, recorder: 'on', entries_refused: false });
    // Read once a minute, not every step.
    const n = reads.length;
    await m.run(30_000, 400, step());
    expect(reads.length - n).toBeLessThanOrEqual(1);
    await passingMarket(h);
    await until(m, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), 30_000, step(), 400);
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;

    // Below the recorder's line: recording pauses, entries do not stop.
    free = P.recorderPauseBytes - 1;
    await until(m, () => h.worker.health().disk?.recorder === 'paused', 70_000, step(), 400);
    expect(h.worker.health().disk?.entries_refused).toBe(false);
    expect(h.worker.health().halt_reasons).not.toContain(DISK_LOW);
    expect(kinds(h.stateDir, 'disk').map((l) => l['step'])).toEqual(['recorder_paused']);
    const man = JSON.parse(readFileSync(join(h.stateDir, 'recorder', readdirSync(join(h.stateDir, 'recorder'))[0]!, 'manifest.json'), 'utf8')) as { coverage_gaps: { reason: string; to_ms: unknown }[] };
    expect(man.coverage_gaps.filter((g) => g.reason.startsWith('recorder paused'))).toEqual([expect.objectContaining({ to_ms: null })]);

    // Below the entry floor: entries are refused ('disk low') and the open position still exits on its stop.
    free = P.entryFloorBytes - 1;
    await until(m, () => h.worker.health().halt_reasons.includes(DISK_LOW), 70_000, step(), 400);
    expect(h.worker.health()).toMatchObject({ entries_halted: true, disk: { entries_refused: true, recorder: 'paused' } });
    expect(kinds(h.stateDir, 'halt').at(-1)!['reasons']).toEqual([DISK_LOW]);
    await until(m, () => h.worker.book.positions[pid]!.status === 'closed', 30_000, step(700_000n));
    const entered = entries(h).length;
    await passingMarket(h);
    await m.run(20_000, 400, step());
    expect(entries(h).length).toBe(entered);

    // Back above the entry floor but under its resume line: still refused. At the resume line: allowed, recorder still paused.
    free = P.entryResumeBytes - 1;
    await m.run(70_000, 400, step());
    expect(h.worker.health().disk?.entries_refused).toBe(true);
    free = P.entryResumeBytes;
    await until(m, () => !h.worker.health().halt_reasons.includes(DISK_LOW), 70_000, step(), 400);
    expect(h.worker.health().disk?.recorder).toBe('paused');
    free = P.recorderResumeBytes;
    await until(m, () => h.worker.health().disk?.recorder === 'on', 70_000, step(), 400);
    expect(kinds(h.stateDir, 'disk').map((l) => l['step'])).toEqual(['recorder_paused', 'entries_refused', 'entries_allowed', 'recorder_resumed']);
    await h.worker.stop();
  });

  /** Appends that fail with ENOSPC for the files named in `full` (by basename), as on a full disk. */
  const fullDisk = () => {
    const full = new Set<string>();
    const append = (path: string, text: string): void => {
      if (full.has(path.split('/').at(-1)!)) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      appendFileSync(path, text);
    };
    return { full, append };
  };

  it('a journal line that does not fit: no crash, entries refused while lines are lost, exits go on, and the gap is journaled once it fits', async () => {
    const { full, append } = fullDisk();
    const feeds = [scriptedSource('helius-ws', true, ['helius']), scriptedSource('coinbase-ws', true, ['coinbase'])];
    const h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, append, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18908', ZEROED_API_ADDR: '127.0.0.1:18909' } });
    const m = new Market(h, { heldPoolFacts: true });
    await boot(h, m, feeds);
    const step = (scalePpm = 1_000_000n) => () => {
      up(h, m, 'coinbase');
      tick(m, scalePpm)();
    };
    await passingMarket(h);
    await until(m, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), 30_000, step(), 400);
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    const seq = h.worker.health().journal_seq;

    // The disk fills. The open position still exits on its stop, though none of its lines can be journaled, and entries
    // stop from the first line lost.
    full.add('journal.jsonl');
    await until(m, () => h.worker.book.positions[pid]!.status === 'closed', 30_000, step(700_000n));
    await m.run(2_000, 400, step());
    expect(h.worker.health().halt_reasons).toContain(DISK_LOW);
    expect(h.worker.health().journal_seq).toBe(seq);
    const entered = entries(h).length;
    await passingMarket(h);
    await m.run(20_000, 400, step());
    expect(entries(h).length).toBe(entered);
    expect(h.worker.health().journal_seq).toBe(seq);

    full.delete('journal.jsonl');
    await until(m, () => !h.worker.health().halt_reasons.includes(DISK_LOW), 70_000, step(), 400);
    const gaps = kinds(h.stateDir, 'journal_gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!['seq']).toBe(seq + 1);
    expect(gaps[0]!['lost']).toBeGreaterThan(0);
    const r = checkJournal(journal(h.stateDir));
    expect(r.problems).toEqual([expect.stringMatching(new RegExp(`^seq ${seq + 1}: \\d+ line\\(s\\) not written from .+ \\(no space left on the device\\)$`))]);
    await h.worker.stop();
  });

  it('a deployers.jsonl line that does not fit: entries refused until it writes again, then the lost range is saved as coverage gaps', async () => {
    const { full, append } = fullDisk();
    const feeds = [scriptedSource('helius-ws', true, ['helius']), scriptedSource('coinbase-ws', true, ['coinbase'])];
    const h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, append, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18910', ZEROED_API_ADDR: '127.0.0.1:18911' } });
    const m = new Market(h);
    await boot(h, m, feeds);
    const coverage = (k: number) => h.worker.feed.ingest('helius', { type: 'fact', key: 'coverage:creates:start', value: { fromSlot: BigInt(k), via: `logs:test-${k}` } }, { receivedAt: m.now });
    const step = () => {
      up(h, m, 'coinbase');
      m.slot();
    };
    await m.run(2_000, 400, step);
    expect(h.worker.health().halt_reasons).not.toContain(DISK_LOW);

    full.add('deployers.jsonl');
    coverage(1);
    await until(m, () => h.worker.health().halt_reasons.includes(DISK_LOW), 30_000, step, 400);
    full.delete('deployers.jsonl');
    await m.run(10_000, 400, step);
    expect(h.worker.health().halt_reasons).toContain(DISK_LOW);
    coverage(2);
    await until(m, () => !h.worker.health().halt_reasons.includes(DISK_LOW), 30_000, step, 400);
    const saved = readFileSync(join(h.stateDir, 'deployers.jsonl'), 'utf8').split('\n').filter((l) => l.includes(STORE_GAP_VIA));
    expect(saved.map((l) => (JSON.parse(l) as { key: string }).key)).toEqual(['coverage:creates:gap', 'coverage:rugs:gap']);
    await h.worker.stop();
  });

  it('deployers.jsonl is cut to the look-back once a day while the worker runs, not only at start', async () => {
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    const h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18912', ZEROED_API_ADDR: '127.0.0.1:18913' } });
    const m = new Market(h);
    await boot(h, m, feeds);
    // A create from before the look-back, as a long run leaves behind.
    const old = { kind: 'market', id: 'old-create', moment: { slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: T - 60 * 86_400_000 }, key: 'pump:CreateEvent:old', value: { event: { name: 'CreateEvent', program: 'pump', data: { mint: 'OLD', creator: 'D', timestamp: 1 } } } };
    appendFileSync(join(h.stateDir, 'deployers.jsonl'), `${typedText(old)}\n`);
    await m.run(2_000, 400, () => m.slot());
    expect(readFileSync(join(h.stateDir, 'deployers.jsonl'), 'utf8')).toContain('old-create');
    h.timers.set(m.now + 86_400_000);
    await m.run(2_000, 400, () => m.slot());
    expect(readFileSync(join(h.stateDir, 'deployers.jsonl'), 'utf8')).not.toContain('old-create');
    await h.worker.stop();
  });

  it('without a reading (statfs failed) entries are refused; the recorder keeps recording', async () => {
    let ok = true;
    const feeds = [scriptedSource('helius-ws', true, ['helius'])];
    const h = makeWorker({ timers: dueTimers(T - 16 * 86_400_000), sources: () => feeds, disk: (atMs) => (ok ? { atMs, freeBytes: 10 * 1024 ** 3, totalBytes: 25 * 1024 ** 3, recorderBytes: 0 } : null), config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18906', ZEROED_API_ADDR: '127.0.0.1:18907' } });
    const m = new Market(h);
    await boot(h, m, feeds);
    ok = false;
    await until(m, () => h.worker.health().halt_reasons.includes(DISK_LOW), 70_000, () => m.slot(), 400);
    expect(h.worker.health().disk).toMatchObject({ free_bytes: null, recorder: 'on', entries_refused: true });
    await h.worker.stop();
  });
});
