import { beforeEach, describe, expect, it } from 'vitest';
import { isUnresolved, type Effect } from '../src/lifecycle/index.ts';
import {
  AsOfStore, canonical, checkCausality, compareEvents, createReplay, createRng, Engine, leakTest, OFF_CHAIN, ReconcileGuard, replayHashes,
  replayOnce, runToEnd, shiftTest, SimClock, type AsOfEntry, type Decision, type Feed, type FeedEvent, type Marker, type Strategy,
} from '../src/engine/index.ts';
import { CONFIG, MINT, SPEND } from './fixtures.ts';
import { at, generateStream, POOL, PRICE, stubRun, stubStrategy, stubWorld, TRADE } from './engine-fixtures.ts';

const market = (id: string, slot: number, tx = 0, ix = 0, key = PRICE, value: unknown = { price: 1n }): FeedEvent =>
  ({ kind: 'market', id, moment: at(slot, tx, ix), key, value });

describe('event order', () => {
  it('orders by slot, transaction, instruction, receipt time, then id, whatever the input order', () => {
    const events: FeedEvent[] = [
      market('b', 2, 0, 0),
      market('a', 2, 0, 0),
      { kind: 'market', id: 'r', moment: { ...at(2, 0, 0), receivedAt: at(2, 0, 0).receivedAt + 1 }, key: PRICE, value: 1 },
      market('ix', 2, 0, 1),
      market('tx', 2, 1, 0),
      { kind: 'world', id: 'tick', moment: at(2), event: { type: 'tick', blockHeight: 1n } },
      market('early', 1, 9, 9),
    ];
    const expected = ['early', 'a', 'b', 'r', 'ix', 'tx', 'tick'];
    const rng = createRng('order');
    for (let trial = 0; trial < 20; trial++) {
      const shuffled = [...events];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const replay = createReplay(shuffled);
      const got: string[] = [];
      while (replay.advance()) for (let e = replay.feed.next(); e; e = replay.feed.next()) got.push(e.id);
      expect(got).toEqual(expected);
    }
  });

  it('refuses duplicate ids, malformed moments and events before the start', () => {
    expect(() => createReplay([market('a', 1), market('a', 2)])).toThrow(/duplicate/);
    expect(() => createReplay([{ ...market('a', 1), moment: { ...at(1), slot: -1n } }])).toThrow(/slot/);
    expect(() => createReplay([{ ...market('a', 1), moment: { ...at(1), txIndex: 1.5 } }])).toThrow(/txIndex/);
    expect(() => createReplay([market('a', 1)], at(5))).toThrow(/before the replay start/);
  });

  it('compares ids by code unit, not locale', () => {
    const m = at(1, 0, 0);
    expect(compareEvents({ moment: m, id: 'B' }, { moment: m, id: 'a' })).toBeLessThan(0);
  });
});

describe('clock and replay feed', () => {
  it('the clock only moves forward', () => {
    const clock = new SimClock(at(5));
    clock.advanceTo(at(6));
    expect(() => clock.advanceTo(at(5))).toThrow(/backwards/);
    expect(clock.now()).toEqual(at(6));
  });

  it('releases an event only once the clock reaches it', () => {
    const replay = createReplay([market('a', 3), market('b', 7)]);
    expect(replay.feed.next()).toBeNull();
    expect(replay.advance()).toBe(true);
    expect(replay.clock.now()).toEqual(at(3, 0, 0));
    expect(replay.feed.next()?.id).toBe('a');
    expect(replay.feed.next()).toBeNull();
    expect(replay.pending()).toBe(1);
    expect(replay.advance()).toBe(true);
    expect(replay.feed.next()?.id).toBe('b');
    expect(replay.advance()).toBe(false);
  });

  it('schedules world results only after now, in order among pending events', () => {
    const replay = createReplay([market('a', 3), market('c', 9)]);
    replay.advance();
    replay.feed.next();
    expect(() => replay.schedule(market('past', 2))).toThrow(/after now/);
    expect(() => replay.schedule(market('now', 3))).toThrow(/after now/);
    replay.schedule(market('b', 5));
    const got: string[] = [];
    while (replay.advance()) for (let e = replay.feed.next(); e; e = replay.feed.next()) got.push(e.id);
    expect(got).toEqual(['b', 'c']);
  });

  it('freezes released events so no module can rewrite the data', () => {
    const replay = createReplay([market('a', 1, 0, 0, PRICE, { price: 5n, nested: { x: 1 } })]);
    replay.advance();
    const e = replay.feed.next()!;
    expect(Object.isFrozen(e) && Object.isFrozen((e as { value: { nested: object } }).value.nested)).toBe(true);
  });
});

describe('as-of store', () => {
  const setup = () => {
    const clock = new SimClock(at(10, 0, 0));
    const store = new AsOfStore(clock);
    store.record('k', 'v1', at(2, 0, 0), 'e1');
    store.record('k', 'v2', at(6, 0, 0), 'e2');
    return { clock, store };
  };

  it('answers with the latest value at or before the asked moment', () => {
    const { store } = setup();
    expect(store.lookup('k')).toMatchObject({ ok: true, value: 'v2', source: 'e2' });
    expect(store.lookup('k', at(5))).toMatchObject({ ok: true, value: 'v1', source: 'e1' });
    expect(store.lookup('k', at(1))).toEqual({ ok: false, reason: 'missing' });
    expect(store.lookup('other')).toEqual({ ok: false, reason: 'missing' });
  });

  it('refuses lookups for moments after now', () => {
    const { store } = setup();
    expect(store.lookup('k', at(11, 0, 0))).toEqual({ ok: false, reason: 'future' });
    expect(store.lookup('k', at(10, 0, 1))).toEqual({ ok: false, reason: 'future' });
    expect(store.history('k', at(0), at(11))).toEqual({ ok: false, reason: 'future' });
  });

  it('refuses values dated after now or out of time order', () => {
    const { clock, store } = setup();
    expect(() => store.record('k', 'v3', at(11), 'e3')).toThrow(/future/);
    expect(() => store.record('k', 'v0', at(1), 'e0')).toThrow(/time order/);
    clock.advanceTo(at(11));
    store.record('k', 'v3', at(11), 'e3');
    expect(store.lookup('k')).toMatchObject({ value: 'v3' });
  });

  it('returns history inside the window, oldest first', () => {
    const { store } = setup();
    expect((store.history('k', at(0)) as readonly AsOfEntry[]).map((x) => x.source)).toEqual(['e1', 'e2']);
    expect((store.history('k', at(3)) as readonly AsOfEntry[]).map((x) => x.source)).toEqual(['e2']);
    expect((store.history('k', at(0), at(5)) as readonly AsOfEntry[]).map((x) => x.source)).toEqual(['e1']);
  });
});

describe('seeded randomness', () => {
  it('the same seed gives the same draws; different seeds differ', () => {
    const draw = (seed: string) => { const r = createRng(seed); return Array.from({ length: 50 }, () => r.nextU32()); };
    expect(draw('a')).toEqual(draw('a'));
    expect(draw('a')).not.toEqual(draw('b'));
    const r = createRng('range');
    for (let i = 0; i < 1000; i++) {
      const f = r.next();
      const k = r.int(7);
      expect(f >= 0 && f < 1 && Number.isInteger(k) && k >= 0 && k < 7).toBe(true);
    }
    expect(() => createRng('')).toThrow();
  });
});

describe('engine reads only its Clock and Feed', () => {
  const seenBy = (): { strategy: Strategy; seen: string[] } => {
    const seen: string[] = [];
    return { seen, strategy: { onMarket: (e) => { seen.push(e.id); return []; } } };
  };
  const listFeed = (events: FeedEvent[]): Feed => ({ next: () => events.shift() ?? null });

  it('refuses an event dated after now and never shows it to the strategy', () => {
    const clock = new SimClock(at(5));
    const { strategy, seen } = seenBy();
    const engine = new Engine({ clock, feed: listFeed([market('now', 5, 0, 0), market('future', 6, 0, 0)]), strategy, runner: { run: () => {} }, seed: 's', book: CONFIG });
    engine.drain();
    expect(seen).toEqual(['now']);
    expect(engine.records.at(-1)).toMatchObject({ type: 'fault', eventId: 'future', fault: 'future_event' });
  });

  it('refuses an event out of order or repeated', () => {
    const clock = new SimClock(at(9));
    const { strategy, seen } = seenBy();
    const engine = new Engine({ clock, feed: listFeed([market('b', 5), market('a', 4), market('b', 5)]), strategy, runner: { run: () => {} }, seed: 's', book: CONFIG });
    engine.drain();
    expect(seen).toEqual(['b']);
    expect(engine.records.filter((r) => r.type === 'fault').map((r) => r.type === 'fault' && r.fault)).toEqual(['out_of_order', 'out_of_order']);
  });

  it('a lookup after now is refused inside the engine too', () => {
    const replay = createReplay([market('p', 1, 0, 0, POOL, 'x'), market('a', 2)]);
    const asked: unknown[] = [];
    const strategy: Strategy = { onMarket: (e, ctx) => { if (e.id === 'a') asked.push(ctx.lookup(POOL, at(3)), ctx.lookup(POOL)); return []; } };
    runToEnd(replay, new Engine({ clock: replay.clock, feed: replay.feed, strategy, runner: { run: () => {} }, seed: 's', book: CONFIG }));
    expect(asked).toEqual([{ ok: false, reason: 'future' }, expect.objectContaining({ ok: true, value: 'x', source: 'p' })]);
  });
});

describe('engine drives the CORE-1 lifecycle through the effect runner', () => {
  it('enters, fills, exits and reconciles with no illegal transition and nothing left unresolved', () => {
    const effects: Effect[] = [];
    const run = { ...stubRun(generateStream('drive', 400)), world: (r: Parameters<typeof stubWorld>[0]) => stubWorld(r, effects) };
    const { records } = replayOnce(run);
    const decisions = records.filter((r) => r.type === 'decision');
    const world = records.filter((r) => r.type === 'world');
    expect(decisions.filter((r) => r.result === 'illegal')).toEqual([]);
    expect(world.filter((r) => r.result === 'illegal')).toEqual([]);
    const entries = decisions.filter((r) => r.action?.type === 'propose_entry').length;
    const exits = decisions.filter((r) => r.action?.type === 'trigger_exit').length;
    expect(entries).toBeGreaterThanOrEqual(5);
    expect(exits).toBeGreaterThanOrEqual(entries - 1);
    expect(decisions.some((r) => r.result === 'abstained' && r.reasons.length > 0)).toBe(true);
    expect(new Set(effects.flatMap((e) => (e.type === 'broadcast' ? [e.intentId] : []))).size).toBe(entries + exits);
    // Persist always reaches the runner before the broadcast it guards.
    for (const r of decisions) {
      const types = r.effects.map((d) => d.effect.type);
      if (types.includes('broadcast')) expect(types.indexOf('persist')).toBeLessThan(types.indexOf('broadcast'));
    }
  });

  it('ends with every intent resolved and every finished position closed', () => {
    const replay = createReplay(generateStream('drive', 400));
    const engine = new Engine({ clock: replay.clock, feed: replay.feed, strategy: stubStrategy(), runner: stubWorld(replay), seed: 'seed-1', book: CONFIG });
    runToEnd(replay, engine);
    expect(Object.values(engine.book.intents).filter(isUnresolved)).toEqual([]);
    const statuses = Object.values(engine.book.positions).map((p) => p.status);
    expect(statuses.filter((s) => s === 'closed').length).toBeGreaterThanOrEqual(4);
    expect(statuses.filter((s) => s !== 'closed' && s !== 'open')).toEqual([]);
    expect(engine.book.reserved).toBe(0n);
  });
});

describe('runner rule: repeated reconciles are de-duplicated and rate-limited', () => {
  const rb = (n: number): Effect => ({ type: 'reconcile_balances', intentId: `i${n}` as never });
  const limits = { minSlotsBetween: 10n, windowSlots: 20n, maxPerWindow: 3 };

  it('sends one reconcile per key per interval', () => {
    const g = new ReconcileGuard({ ...limits, maxPerWindow: 10 });
    expect(g.admit(rb(1), at(100))).toBe('sent');
    expect(g.admit(rb(1), at(100))).toBe('duplicate');
    expect(g.admit(rb(1), at(109))).toBe('duplicate');
    expect(g.admit(rb(1), at(110))).toBe('sent');
    const orphan = (s: string): Effect => ({ type: 'reconcile_orphan', intentId: 'i1' as never, signature: s as never });
    expect(g.admit(orphan('s1'), at(110))).toBe('sent');
    expect(g.admit(orphan('s1'), at(111))).toBe('duplicate');
    expect(g.admit(orphan('s2'), at(111))).toBe('sent');
  });

  it('caps reconciles of any key in a window', () => {
    const g = new ReconcileGuard(limits);
    expect([1, 2, 3, 4].map((n) => g.admit(rb(n), at(200)))).toEqual(['sent', 'sent', 'sent', 'rate_limited']);
    expect(g.admit(rb(4), at(219))).toBe('rate_limited');
    expect(g.admit(rb(4), at(220))).toBe('sent');
  });

  it('passes every other effect straight through', () => {
    const g = new ReconcileGuard(limits);
    const persist: Effect = { type: 'persist', entity: 'book', id: 'book' };
    expect([g.admit(persist, at(1)), g.admit(persist, at(1))]).toEqual(['sent', 'sent']);
  });

  it('in the engine, ticks that re-emit a reconcile reach the runner once per interval', () => {
    // An entry confirmed but never reconciled: every tick asks for the balances again.
    const effects: Effect[] = [];
    const events = generateStream('stuck', 120);
    const replay = createReplay(events);
    const world = stubWorld(replay);
    const silentReconcile = { run: (fx: Effect, now: Parameters<typeof world.run>[1]) => { effects.push(fx); if (fx.type !== 'reconcile_balances') world.run(fx, now); } };
    const engine = new Engine({ clock: replay.clock, feed: replay.feed, strategy: stubStrategy(), runner: silentReconcile, seed: 'seed-1', book: CONFIG, reconcileLimits: { minSlotsBetween: 25n, windowSlots: 150n, maxPerWindow: 20 } });
    runToEnd(replay, engine);
    const asked = engine.records.flatMap((r) => (r.type === 'world' || r.type === 'decision' ? r.effects : [])).filter((d) => d.effect.type === 'reconcile_balances');
    const sent = asked.filter((d) => d.dispatch === 'sent').length;
    expect(asked.length).toBeGreaterThan(50);
    expect(sent).toBeGreaterThanOrEqual(2);
    expect(sent).toBeLessThanOrEqual(Math.ceil(120 / 25) + 1);
    expect(effects.filter((e) => e.type === 'reconcile_balances').length).toBe(sent);
  });
});

describe('deterministic replay', () => {
  it('10 replays of the same event stream give identical decision-log hashes', () => {
    const run = stubRun(generateStream('replay', 600));
    const hashes = replayHashes(run, 10);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    // The hash covers decisions: a different seed changes the draws and so the log.
    expect(replayOnce({ ...run, seed: 'seed-2' }).hash).not.toBe(hashes[0]);
  });

  it('canonical form is stable: key order and bigints', () => {
    expect(canonical({ b: 1n, a: [undefined, 'x'], c: undefined })).toBe('{"a":[null,"x"],"b":{"$n":"1"}}');
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
  });
});

// ---------- Leak and +1-slot shift tests ----------

const TOKEN = 'FUTURE-ONLY-7f3a';
const T = 300;
const marker: Marker = { token: TOKEN, at: at(T, 0, 0) };

/** The stream with a future-only event (a trade) and account state (the pool) planted at T. */
const planted = (): FeedEvent[] => [
  ...generateStream('leak', 500),
  { kind: 'market', id: 'planted-trade', moment: at(T, 0, 0), key: TRADE, value: { note: TOKEN } },
  { kind: 'market', id: 'planted-pool', moment: at(T, 0, 1), key: POOL, value: { reserves: 1n, note: TOKEN } },
];
const labels = { [MINT]: { outcome: TOKEN } };

/** A strategy that keeps memory across runs: the kind of bug (a module-level cache) that leaks the future. */
const memory = new Set<string>();
const remembering = (isTrigger: (e: FeedEvent) => boolean): (() => Strategy) => () => {
  const base = stubStrategy();
  let previous: string | null = null;
  return {
    onMarket: (e, ctx) => {
      const out: Decision[] = [...base.onMarket(e, ctx)];
      if (memory.has(e.id)) out.push({ action: null, reasons: ['seen in an earlier run'] });
      if (isTrigger(e) && previous !== null) memory.add(previous);
      previous = e.id;
      return out;
    },
  };
};

describe('leak test', () => {
  beforeEach(() => memory.clear());

  it('the planted marker stays invisible to every module until its time, and no earlier decision changes', () => {
    const report = leakTest(stubRun(planted()), marker, labels);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('catches look-ahead in the data: a feature fetched later attached to an earlier event', () => {
    const contaminated = [...planted(), { kind: 'market' as const, id: 'holders-early', moment: at(T - 50, 60, 0), key: `holders:${MINT}`, value: { top10: TOKEN } }];
    const report = leakTest(stubRun(contaminated), marker, labels);
    expect(report.ok).toBe(false);
    expect(report.violations.join('\n')).toMatch(/strategy event saw the marker/);
  });

  it('catches a module that carries knowledge of the future between runs', () => {
    const run = { ...stubRun(planted()), strategy: remembering((e) => e.id === 'planted-trade') };
    const report = leakTest(run, marker, labels);
    expect(report.ok).toBe(false);
    expect(report.violations.join('\n')).toMatch(/decisions before the marker differ/);
  });

  it('refuses to pass when the marker was not planted', () => {
    expect(leakTest(stubRun(generateStream('leak', 500)), marker, labels).ok).toBe(false);
    expect(leakTest(stubRun(planted()), marker, {}).ok).toBe(false);
  });
});

describe('+1-slot shift test', () => {
  beforeEach(() => memory.clear());

  it('delaying every event by one slot delays every decision by exactly one slot', () => {
    const report = shiftTest(stubRun(generateStream('shift', 500)));
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(shiftTest(stubRun(generateStream('shift', 500)), 3n).ok).toBe(true);
  });

  it('catches a decision that uses delayed data early', () => {
    const events = generateStream('shift', 500);
    const trigger = events.filter((e) => e.kind === 'market' && e.key === PRICE)[200]!.id;
    const report = shiftTest({ ...stubRun(events), strategy: remembering((e) => e.id === trigger) });
    expect(report.ok).toBe(false);
    expect(report.violations.join('\n')).toMatch(/delayed run differs/);
  });

  it('catches a decision that read an event before it was due', () => {
    // As a feed that stamps a later fact with an earlier moment would produce: the decision at slot 5 read an event due at slot 9.
    const result = replayOnce(stubRun(generateStream('shift', 200)));
    expect(checkCausality('honest', result)).toEqual([]);
    const first = result.records.find((r) => r.type === 'decision')!;
    const forged = result.records.map((r) => (r === first && r.type === 'decision' ? { ...r, at: at(0, 0, 0) } : r));
    const lines = checkCausality('forged', { ...result, records: forged });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/forged: decision at slot 0 .* read /);
  });
});

describe('off-chain moments', () => {
  it('sort after every transaction in their slot', () => {
    expect(compareEvents({ moment: at(4), id: 'a' }, { moment: at(4, OFF_CHAIN - 1, 0), id: 'z' })).toBeGreaterThan(0);
  });
});

// ---------- Review fixes (PR #10) ----------

describe('reconcile guard is fair under the cap', () => {
  it('serves every key when more keys are re-asked each tick than the cap allows', () => {
    const g = new ReconcileGuard();
    const keys: Effect[] = [
      ...Array.from({ length: 25 }, (_, n): Effect => ({ type: 'reconcile_balances', intentId: `i${String(n).padStart(2, '0')}` as never })),
      // Orphans come last in tick order, so they starve first under first come, first served.
      ...Array.from({ length: 5 }, (_, n): Effect => ({ type: 'reconcile_orphan', intentId: `o${n}` as never, signature: `s${n}` as never })),
    ];
    const sent = new Map<number, number>();
    for (let slot = 1; slot <= 3000; slot++) {
      keys.forEach((fx, k) => { if (g.admit(fx, at(slot)) === 'sent') sent.set(k, (sent.get(k) ?? 0) + 1); });
    }
    expect(sent.size).toBe(30);
    const counts = [...sent.values()];
    // Within a kind, rounds keep every key level (orphans go first, so they are sent more often).
    const balances = keys.flatMap((fx, k) => (fx.type === 'reconcile_balances' ? [sent.get(k)!] : []));
    expect(Math.max(...balances) - Math.min(...balances)).toBeLessThanOrEqual(2);
    // The cap still holds: 20 per 150 slots over 3000 slots.
    expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20 * (3000 / 150) + 20);
  });

  it('unbooked-landing reconciles go first: each is served within one window and at its repeat interval after', () => {
    const g = new ReconcileGuard();
    const balances = Array.from({ length: 30 }, (_, n): Effect => ({ type: 'reconcile_balances', intentId: `i${String(n).padStart(2, '0')}` as never }));
    const orphans = Array.from({ length: 5 }, (_, n): Effect => ({ type: 'reconcile_orphan', intentId: `o${n}` as never, signature: `s${n}` as never }));
    const lastOrphanSend = new Map<number, number>();
    const balanceSent = new Set<number>();
    let worstGap = 0;
    for (let slot = 1; slot <= 3000; slot++) {
      balances.forEach((fx, k) => { if (g.admit(fx, at(slot)) === 'sent') balanceSent.add(k); });
      orphans.forEach((fx, k) => {
        if (g.admit(fx, at(slot)) !== 'sent') return;
        worstGap = Math.max(worstGap, slot - (lastOrphanSend.get(k) ?? 1));
        lastOrphanSend.set(k, slot);
      });
    }
    expect(lastOrphanSend.size).toBe(5);
    // Asked last in tick order, an orphan still waits at most one window, then repeats every minSlotsBetween.
    expect(worstGap).toBeLessThanOrEqual(150);
    expect(balanceSent.size).toBe(30);
  });

  it('a waiter that is no longer asked for gives up its place', () => {
    const g = new ReconcileGuard({ minSlotsBetween: 1n, windowSlots: 10n, maxPerWindow: 1 });
    const fx = (n: number): Effect => ({ type: 'reconcile_balances', intentId: `i${n}` as never });
    expect(g.admit(fx(1), at(1))).toBe('sent');
    expect(g.admit(fx(2), at(1))).toBe('rate_limited');
    // i2 resolved and is never asked again; once the window frees, i3 is not held behind it forever.
    expect(g.admit(fx(3), at(30))).toBe('sent');
  });
});

describe('a strategy cannot change engine state outside the lifecycle', () => {
  it('the book it sees is frozen', () => {
    const replay = createReplay([market('a', 1)]);
    const errors: unknown[] = [];
    const strategy: Strategy = { onMarket: (_e, ctx) => {
      try { (ctx.book as { reserved: bigint }).reserved = 123n; } catch (err) { errors.push(err); }
      try { (ctx as { now: unknown }).now = at(9); } catch (err) { errors.push(err); }
      return [];
    } };
    const engine = new Engine({ clock: replay.clock, feed: replay.feed, strategy, runner: { run: () => {} }, seed: 's', book: CONFIG });
    runToEnd(replay, engine);
    expect(errors).toHaveLength(2);
    expect(engine.book.reserved).toBe(0n);
  });

  it('a decision kept after it was made cannot be rewritten', () => {
    const replay = createReplay(generateStream('frozen', 200));
    let kept: { spend: bigint } | null = null;
    const base = stubStrategy();
    const strategy: Strategy = { onMarket: (e, ctx) => {
      const out = base.onMarket(e, ctx);
      const entry = out.find((d) => d.action?.type === 'propose_entry');
      if (kept === null && entry?.action?.type === 'propose_entry') kept = entry.action.intent as { spend: bigint };
      return out;
    } };
    const engine = new Engine({ clock: replay.clock, feed: replay.feed, strategy, runner: stubWorld(replay), seed: 'seed-1', book: CONFIG });
    runToEnd(replay, engine);
    expect(kept).not.toBeNull();
    expect(() => { kept!.spend = 999_999_999n; }).toThrow(TypeError);
    expect(Object.values(engine.book.intents).every((i) => i.intent.purpose !== 'entry' || i.intent.spend === SPEND)).toBe(true);
    expect(engine.records.every((r) => Object.isFrozen(r))).toBe(true);
  });
});

describe('runtime trap', () => {
  const trapped = <T>(fn: () => T): T => {
    const g = globalThis as Record<string, unknown>;
    const proc = process as unknown as Record<string, unknown>;
    const perf = performance as unknown as Record<string, unknown>;
    const RealDate = Date;
    const saved = {
      Date: g.Date, random: Math.random, perfNow: perf.now, setTimeout: g.setTimeout, setInterval: g.setInterval,
      setImmediate: g.setImmediate, queueMicrotask: g.queueMicrotask, nextTick: proc.nextTick, hrtime: proc.hrtime,
      getBuiltinModule: proc.getBuiltinModule,
    };
    const trap = (name: string) => () => { throw new Error(`trap: ${name} called during replay`); };
    class TrapDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) throw new Error('trap: new Date() called during replay');
        super(...(args as [number]));
      }
      static override now(): number { throw new Error('trap: Date.now called during replay'); }
    }
    g.Date = TrapDate;
    Math.random = trap('Math.random');
    perf.now = trap('performance.now');
    for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask']) g[name] = trap(name);
    proc.nextTick = trap('process.nextTick');
    proc.hrtime = trap('process.hrtime');
    proc.getBuiltinModule = trap('process.getBuiltinModule');
    try {
      return fn();
    } finally {
      g.Date = saved.Date;
      Math.random = saved.random;
      perf.now = saved.perfNow;
      for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] as const) g[name] = saved[name];
      proc.nextTick = saved.nextTick;
      proc.hrtime = saved.hrtime;
      proc.getBuiltinModule = saved.getBuiltinModule;
    }
  };

  it('10 replays run with the clock, randomness, timers and module loading replaced by traps', () => {
    const run = stubRun(generateStream('replay', 600));
    const hashes = trapped(() => replayHashes(run, 10));
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(replayOnce(run).hash);
  });

  it('the trap fires on a forbidden call (positive control)', () => {
    expect(() => trapped(() => Date.now())).toThrow(/trap/);
    expect(() => trapped(() => new Date())).toThrow(/trap/);
    expect(() => trapped(() => Math.random())).toThrow(/trap/);
    expect(trapped(() => new Date(0).getTime())).toBe(0);
  });
});

describe('log and runner contracts', () => {
  it('canonical refuses anything but plain objects and arrays', () => {
    expect(() => canonical(new Map([['a', 1]]))).toThrow(TypeError);
    expect(() => canonical(new Set([1]))).toThrow(TypeError);
    expect(() => canonical(new Date(0))).toThrow(TypeError);
    expect(() => canonical({ x: new (class Foo { a = 1; })() })).toThrow(TypeError);
    expect(canonical(Object.assign(Object.create(null) as object, { a: 1 }))).toBe('{"a":1}');
  });

  it('an async effect runner is refused instead of losing its results', () => {
    const replay = createReplay(generateStream('async', 200));
    const asyncRunner = { run: async () => {} };
    const engine = new Engine({ clock: replay.clock, feed: replay.feed, strategy: stubStrategy(), runner: asyncRunner, seed: 'seed-1', book: CONFIG });
    expect(() => runToEnd(replay, engine)).toThrow(/synchronous/);
  });

  it('a replay copies its input instead of freezing the caller\'s objects', () => {
    const value = { price: 1n };
    const event: FeedEvent = { kind: 'market', id: 'a', moment: at(1, 0, 0), key: PRICE, value };
    const replay = createReplay([event]);
    expect(Object.isFrozen(event) || Object.isFrozen(value)).toBe(false);
    value.price = 2n;
    replay.advance();
    expect(replay.feed.next()).toMatchObject({ value: { price: 1n } });
  });
});
