// TEST-3: the §18 acceptance cases as scripted faults on the real worker (virtual time, scripted market). Every wait is
// "until the effect, within a virtual-time bound", never a fixed window: a slow CI host only makes a run take longer.
import { cpSync, readdirSync, readFileSync } from 'node:fs';
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
import { MINT, Market, T, dueTimers, makeWorker, passingMarket, scriptedSource, tempState } from './worker-harness.ts';

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
  const m = await passingMarket(h);
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
    const m2 = new Market(h2);
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
    const m = new Market(h);
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
});
