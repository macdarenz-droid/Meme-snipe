import { describe, expect, it } from 'vitest';
import {
  HELIUS_FREE, JUPITER_FLOORS_OPEN_POSITION, JUPITER_FREE, ManualTimers, P0, P1, P2, P3, ScheduleRefused, Scheduler,
  SlidingWindow, type Priority, type SchedulerSpec,
} from '../src/scheduler/index.ts';
import { blockNetwork, settle } from './helpers.ts';

blockNetwork();

const make = (spec: SchedulerSpec, used = 0) => {
  const timers = new ManualTimers(1_000_000);
  const spends: number[] = [];
  const s = new Scheduler(spec, { timers, creditsUsed: used, onSpend: (u) => spends.push(u) });
  return { timers, s, spends };
};

/** Queues one request and records how it ended. */
const queue = (s: Scheduler, p: Priority, credits = 0, lane?: string) => {
  const out: { state: 'waiting' | 'ran' | ScheduleRefused['reason'] } = { state: 'waiting' };
  s.run(p, credits, async () => { out.state = 'ran'; }, lane).catch((e: unknown) => {
    out.state = e instanceof ScheduleRefused ? e.reason : 'ran';
  });
  return out;
};

describe('sliding window', () => {
  it('never lets more than the limit fall inside any window', () => {
    const w = new SlidingWindow({ limit: 3, windowMs: 1_000 });
    w.take(0); w.take(100); w.take(200);
    expect(w.free(999)).toBe(0);
    expect(w.freeAt(999)).toBe(1_000);
    expect(w.free(1_000)).toBe(1);
    expect(w.freeAt(1_000, 3)).toBe(1_200);
  });
});

describe('quota scheduler', () => {
  it('keeps 5 of Helius 10 RPS for P0–P1: P2 and P3 stop at 5, P0 and P1 still get the rest', () => {
    const { s } = make(HELIUS_FREE);
    let p3 = 0;
    while (s.tryAcquire(P3).ok) p3++;
    expect(p3).toBe(5);
    expect(s.check(P2)).toMatchObject({ ok: false, reason: 'floor' });
    let high = 0;
    while (s.tryAcquire(high % 2 === 0 ? P0 : P1).ok) high++;
    expect(high).toBe(5);
    expect(s.check(P0)).toMatchObject({ ok: false, reason: 'window' });
  });

  it('serves the queue in class order when the window frees', async () => {
    const { s, timers } = make(HELIUS_FREE);
    for (let k = 0; k < 10; k++) expect(s.tryAcquire(P0).ok).toBe(true);
    const order: string[] = [];
    const add = (p: Priority, tag: string) => s.run(p, 0, async () => { order.push(tag); }).catch(() => order.push(`${tag}!`));
    void add(P3, 'p3'); void add(P2, 'p2'); void add(P1, 'p1'); void add(P0, 'p0');
    timers.advance(1_000);
    await settle();
    // 10 free again: P0 and P1 first; P2 then P3 only while 5 stay free.
    expect(order).toEqual(['p0', 'p1', 'p2', 'p3']);
  });

  it('sheds P3 first when the queue is full, then P2, and never P0', async () => {
    const { s } = make({ ...HELIUS_FREE, maxQueue: 3 });
    while (s.tryAcquire(P0).ok) { /* fill the window */ }
    const a = queue(s, P3); const b = queue(s, P2); const c = queue(s, P0); const d = queue(s, P0);
    await settle();
    expect([a.state, b.state, c.state, d.state]).toEqual(['shed', 'waiting', 'waiting', 'waiting']);
    const e = queue(s, P0); const f = queue(s, P0);
    await settle();
    expect(b.state).toBe('shed'); // P2 goes once no P3 is left
    expect([c.state, d.state, e.state, f.state]).toEqual(['waiting', 'waiting', 'waiting', 'waiting']); // P0 is never shed, even past maxQueue
    expect(s.status().shed).toEqual([0, 0, 1, 1]);
  });

  it('expires waiting P1–P3 requests but lets P0 wait as long as it takes', async () => {
    const { s, timers } = make({ ...HELIUS_FREE, window: { limit: 1, windowMs: 60_000 }, floors: [0, 0, 0, 0] });
    expect(s.tryAcquire(P0).ok).toBe(true);
    const p3 = queue(s, P3); const p0 = queue(s, P0);
    timers.advance(5_000);
    await settle();
    expect(p3.state).toBe('expired');
    expect(p0.state).toBe('waiting');
    timers.advance(55_000);
    await settle();
    expect(p0.state).toBe('ran');
  });

  it('halts every class but P0 at 70% of the monthly credits; exits still run', async () => {
    const { s } = make(HELIUS_FREE, 699_999);
    expect(s.halted).toBe(false);
    while (s.tryAcquire(P0).ok) { /* fill so P2 waits */ }
    const waiting = queue(s, P2);
    expect(s.tryAcquire(P0, 1)).toMatchObject({ ok: false, reason: 'window' });
    s.meter(1); // a stream byte crosses 70%
    await settle();
    expect(s.halted).toBe(true);
    expect(waiting.state).toBe('halted');
    for (const p of [P1, P2, P3]) expect(s.check(p)).toMatchObject({ ok: false, reason: 'halted' });
    await expect(s.run(P1, 1, async () => 'x')).rejects.toMatchObject({ reason: 'halted' });
  });

  it('P0 is granted past the halt and past the whole budget', async () => {
    const { s, timers } = make(HELIUS_FREE, 1_000_000);
    expect(s.halted).toBe(true);
    await expect(s.run(P0, 1, async () => 'exit quote')).resolves.toBe('exit quote');
    timers.advance(1_000);
    expect(s.tryAcquire(P0, 1).ok).toBe(true);
    expect(s.status().creditsUsed).toBe(1_000_002);
  });

  it('a restart keeps the month: the loaded use counts and every spend is reported for storage', () => {
    const { s, spends } = make(HELIUS_FREE, 500_000);
    s.tryAcquire(P1, 1);
    s.meter(2.5);
    expect(spends).toEqual([500_001, 500_003.5]);
    expect(s.status().budgetShare).toBeCloseTo(0.5000035);
  });

  it('caps Jupiter discovery and Tokens at 6 a minute, and holds 30 for exits while a position is open', () => {
    const { s, timers } = make(JUPITER_FREE);
    let tokens = 0;
    while (s.tryAcquire(P2, 0, 'tokens').ok) tokens++;
    expect(tokens).toBe(6);
    expect(s.check(P3)).toMatchObject({ ok: false, reason: 'cap' });
    expect(s.tryAcquire(P2, 0, 'swap').ok).toBe(true); // other lanes are not capped
    expect(s.tryAcquire(P0, 0, 'tokens').ok).toBe(true); // P0 is never capped
    timers.advance(60_000);
    s.setFloors(JUPITER_FLOORS_OPEN_POSITION);
    let entries = 0;
    while (s.tryAcquire(P2, 0, 'swap').ok) entries++;
    expect(entries).toBe(30);
    let exits = 0;
    while (s.tryAcquire(P0, 0, 'swap').ok) exits++;
    expect(exits).toBe(30);
  });

  it('trusts the provider count: x-ratelimit-remaining below ours shrinks the window, a 429 fills it', () => {
    const { s, timers } = make(JUPITER_FREE);
    s.observeRemaining(2);
    expect(s.tryAcquire(P0).ok).toBe(true);
    expect(s.tryAcquire(P0).ok).toBe(true);
    expect(s.tryAcquire(P0).ok).toBe(false);
    timers.advance(60_000);
    s.observeRemaining(100); // never assumes more room than its own window
    s.penalize();
    expect(s.check(P0)).toMatchObject({ ok: false, reason: 'window', retryAt: 1_000_000 + 120_000 });
  });

  it('rejects specs that would let a lower class undercut a higher one, cap P0, or limit P0 waits', () => {
    expect(() => make({ ...HELIUS_FREE, floors: [0, 5, 2, 5] })).toThrow(/non-decreasing/);
    expect(() => make({ ...HELIUS_FREE, caps: [{ classes: [P0], limit: 1, windowMs: 1 }] })).toThrow(/never capped/);
    expect(() => make({ ...HELIUS_FREE, maxWaitMs: [1_000, 1, 1, 1] })).toThrow(/without limit/);
    expect(() => make({ ...HELIUS_FREE, budget: { monthlyCredits: 1, haltShare: 1.5 } })).toThrow(/haltShare/);
  });
});
