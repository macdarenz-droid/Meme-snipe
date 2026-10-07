// One quota scheduler per provider (docs/ARCHITECTURE.md §6.2, data.md §8.1D). Four priority classes:
// P0 exits and reconciliation, P1 open-position monitoring, P2 shortlist, P3 discovery.
// - A grant to class c must leave `floors[c]` grants free in the window, so lower classes cannot use up what
//   higher classes have reserved (Helius: ≥ 5 RPS kept for P0–P1; Jupiter: ≥ 30/min kept while a position is open).
// - `caps` limit groups of classes further (Jupiter: discovery and Tokens ≤ 6/min).
// - When the queue is full, P3 is shed first, then P2, then P1; P0 is never shed or expired.
// - At `haltShare` of the monthly credit budget every class but P0 is refused: exits are never starved.
import type { Timers, TimerHandle } from './timers.ts';
import { SlidingWindow, checkWindow, type WindowSpec } from './window.ts';

export type Priority = 0 | 1 | 2 | 3;
export const P0: Priority = 0;
export const P1: Priority = 1;
export const P2: Priority = 2;
export const P3: Priority = 3;
const CLASSES: readonly Priority[] = [P0, P1, P2, P3];

/** A further limit on the requests of some classes or some lanes (a lane names a kind of call, e.g. Jupiter Tokens). Never applies to P0. */
export interface CapSpec extends WindowSpec {
  readonly classes?: readonly Priority[];
  readonly lanes?: readonly string[];
}

const capMatches = (cap: CapSpec, p: Priority, lane: string | undefined): boolean =>
  p !== P0 && ((cap.classes?.includes(p) ?? false) || (lane !== undefined && (cap.lanes?.includes(lane) ?? false)));

export interface BudgetSpec {
  /** Credits (Helius) or compute units (Alchemy) in the billing month. */
  readonly monthlyCredits: number;
  /** Share of the month's budget at which every class but P0 halts (0.7 per §6.2). */
  readonly haltShare: number;
}

export interface SchedulerSpec {
  readonly provider: string;
  readonly window: WindowSpec;
  /** Grants that must stay free after a grant to each class. P0's is always 0; never lower for a lower class. */
  readonly floors: readonly [0, number, number, number];
  readonly caps?: readonly CapSpec[];
  /** How long a request of each class may wait before it is refused. P0 waits as long as it takes. */
  readonly maxWaitMs: readonly [number, number, number, number];
  /** Queued requests beyond this are shed, lowest class and newest first. */
  readonly maxQueue: number;
  readonly budget?: BudgetSpec;
  /**
   * HELIUS-EXHAUSTED: after the provider answers that its credits are used up, how long every class but P0 is held
   * before calls go out again to re-check (default 10 minutes).
   */
  readonly exhaustedRecheckMs?: number;
}

/** HELIUS-EXHAUSTED: the default wait before re-checking a provider whose credits were used up. */
export const EXHAUSTED_RECHECK_MS = 600_000;

export type Refusal = 'window' | 'floor' | 'cap' | 'halted';
export type Admission = { readonly ok: true } | { readonly ok: false; readonly reason: Refusal; readonly retryAt: number };

/** Why a scheduled request did not run. */
export class ScheduleRefused extends Error {
  readonly reason: 'shed' | 'expired' | 'halted';
  readonly priority: Priority;
  constructor(provider: string, priority: Priority, reason: 'shed' | 'expired' | 'halted') {
    super(`${provider}: P${priority} request ${reason}`);
    this.name = 'ScheduleRefused';
    this.reason = reason;
    this.priority = priority;
  }
}

export interface SchedulerStatus {
  readonly provider: string;
  readonly creditsUsed: number;
  /** Share of the monthly budget used; 0 without a budget. */
  readonly budgetShare: number;
  readonly halted: boolean;
  readonly queued: readonly [number, number, number, number];
  readonly granted: readonly [number, number, number, number];
  readonly shed: readonly [number, number, number, number];
  /** Credits spent since this process started, by class (stream metering counts as P3: bulk discovery traffic). */
  readonly creditsByClass: readonly [number, number, number, number];
  /** HELIUS-EXHAUSTED: the provider's last answer said its credits are used up (until a call succeeds). */
  readonly exhausted: boolean;
  /** Such answers since this process started, and when the first came (null: none). */
  readonly exhaustedCount: number;
  readonly exhaustedFirstAtMs: number | null;
}

interface Waiter {
  readonly priority: Priority;
  readonly lane: string | undefined;
  readonly credits: number;
  readonly since: number;
  readonly start: () => void;
  readonly refuse: (e: ScheduleRefused) => void;
}

const checkSpec = (s: SchedulerSpec): SchedulerSpec => {
  checkWindow(s.window, s.provider);
  if (s.floors[0] !== 0) throw new RangeError(`${s.provider}: P0 floor must be 0`);
  for (let c = 1; c < 4; c++) {
    const f = s.floors[c]!;
    if (!Number.isSafeInteger(f) || f < s.floors[c - 1]! || f >= s.window.limit) throw new RangeError(`${s.provider}: floors must be integers, non-decreasing and below the limit`);
  }
  if (s.maxWaitMs[0] !== Number.POSITIVE_INFINITY) throw new RangeError(`${s.provider}: P0 must wait without limit`);
  for (const cap of s.caps ?? []) {
    checkWindow(cap, `${s.provider} cap`);
    if (cap.classes?.includes(P0)) throw new RangeError(`${s.provider}: P0 is never capped`);
  }
  if (!Number.isSafeInteger(s.maxQueue) || s.maxQueue < 0) throw new RangeError(`${s.provider}: maxQueue must be an integer >= 0`);
  if (s.budget && !(s.budget.monthlyCredits > 0 && s.budget.haltShare > 0 && s.budget.haltShare <= 1)) throw new RangeError(`${s.provider}: budget needs monthlyCredits > 0 and 0 < haltShare <= 1`);
  return s;
};

export class Scheduler {
  readonly spec: SchedulerSpec;
  readonly #timers: Timers;
  readonly #window: SlidingWindow;
  readonly #caps: readonly { readonly spec: CapSpec; readonly window: SlidingWindow }[];
  readonly #queues: Waiter[][] = [[], [], [], []];
  readonly #granted = [0, 0, 0, 0];
  readonly #shed = [0, 0, 0, 0];
  readonly #byClass = [0, 0, 0, 0];
  #floors: readonly [0, number, number, number];
  #used: number;
  #wake: TimerHandle | null = null;
  readonly #onSpend: ((used: number) => void) | undefined;
  #exhausted = false;
  #exhaustedUntil = Number.NEGATIVE_INFINITY;
  #exhaustedCount = 0;
  #exhaustedFirstAt: number | null = null;
  #hold: string | null = null;

  /**
   * `creditsUsed` is the month's use so far, loaded from storage: a restart must never reset the budget.
   * `onSpend` is told the new total after every spend, so the worker can persist it.
   */
  constructor(spec: SchedulerSpec, deps: { readonly timers: Timers; readonly creditsUsed?: number; readonly onSpend?: (used: number) => void }) {
    this.spec = checkSpec(spec);
    this.#timers = deps.timers;
    this.#window = new SlidingWindow(spec.window, spec.provider);
    this.#caps = (spec.caps ?? []).map((c) => ({ spec: c, window: new SlidingWindow(c, `${spec.provider} cap`) }));
    this.#floors = spec.floors;
    this.#used = deps.creditsUsed ?? 0;
    this.#onSpend = deps.onSpend;
  }

  get halted(): boolean {
    const b = this.spec.budget;
    return this.#hold !== null || (b !== undefined && this.#used >= b.haltShare * b.monthlyCredits);
  }

  /**
   * RC-FIXES: halts every class but P0, as the budget halt does, while `reason` is set (the month's count could not be
   * saved, so after a restart it would under-count). Null lifts it.
   */
  hold(reason: string | null): void {
    this.#hold = reason;
  }

  get held(): string | null {
    return this.#hold;
  }

  /** Changes the reservations, e.g. hold Jupiter's 30/min for exits only while a position is open. */
  setFloors(floors: readonly [0, number, number, number]): void {
    this.#floors = checkSpec({ ...this.spec, floors }).floors;
    this.#pump();
  }

  /** Whether a request of class `p` (in `lane`) could be granted now. Pure: grants nothing. */
  check(p: Priority, lane?: string): Admission {
    const now = this.#timers.now();
    if (p !== P0 && this.halted) return { ok: false, reason: 'halted', retryAt: Number.POSITIVE_INFINITY };
    if (p !== P0 && now < this.#exhaustedUntil) return { ok: false, reason: 'halted', retryAt: this.#exhaustedUntil };
    const need = 1 + this.#floors[p];
    if (this.#window.free(now) < need) return { ok: false, reason: p === P0 || this.#window.free(now) < 1 ? 'window' : 'floor', retryAt: this.#window.freeAt(now, need) };
    for (const cap of this.#caps) {
      if (capMatches(cap.spec, p, lane) && cap.window.free(now) < 1) return { ok: false, reason: 'cap', retryAt: cap.window.freeAt(now) };
    }
    return { ok: true };
  }

  /** Grants one request of class `p` now if it fits; spends its credits. */
  tryAcquire(p: Priority, credits = 0, lane?: string): Admission {
    // Earlier requests of the same or a higher class go first.
    for (let c = 0; c <= p; c++) {
      if (this.#queues[c]!.length > 0) return { ok: false, reason: 'window', retryAt: this.#timers.now() };
    }
    const a = this.check(p, lane);
    if (a.ok) this.#grant(p, credits, lane);
    return a;
  }

  /** Runs `task` once class `p` is granted. Refused with `ScheduleRefused` when shed, expired or halted. */
  run<T>(p: Priority, credits: number, task: () => Promise<T>, lane?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        try {
          task().then((v) => {
            // An answer that is not an error: the provider serves again (HELIUS-EXHAUSTED).
            this.#exhausted = false;
            resolve(v);
          }, reject);
        } catch (e) {
          reject(e);
        }
      };
      const a = this.tryAcquire(p, credits, lane);
      if (a.ok) return start();
      if (!a.ok && a.reason === 'halted') {
        this.#shed[p]!++;
        return reject(new ScheduleRefused(this.spec.provider, p, 'halted'));
      }
      this.#queues[p]!.push({ priority: p, lane, credits, since: this.#timers.now(), start, refuse: reject });
      this.#trim();
      this.#pump();
    });
  }

  /** Records stream usage (WebSocket bytes, Parsed Streams events) against the budget. */
  meter(credits: number): void {
    this.#spend(credits, 3);
    this.#pump();
  }

  /** Aligns with the provider's own count (`x-ratelimit-remaining`): never assume more room than it reports. */
  observeRemaining(remaining: number): void {
    const now = this.#timers.now();
    const free = this.#window.free(now);
    if (Number.isFinite(remaining) && remaining >= 0 && remaining < free) this.#window.take(now, free - Math.floor(remaining));
  }

  /**
   * HELIUS-EXHAUSTED: the provider answered that its credits are used up. Every class but P0 is refused for
   * `exhaustedRecheckMs`, then calls go out again; the next one that succeeds ends it, another such answer repeats it.
   */
  exhausted(): void {
    const now = this.#timers.now();
    this.#exhausted = true;
    this.#exhaustedCount++;
    this.#exhaustedFirstAt ??= now;
    this.#exhaustedUntil = now + (this.spec.exhaustedRecheckMs ?? EXHAUSTED_RECHECK_MS);
    this.#pump();
  }

  /** After a 429: treat the window as full. */
  penalize(): void {
    const now = this.#timers.now();
    this.#window.take(now, this.#window.free(now));
    this.#pump();
  }

  /** Starts a new billing month. */
  resetBudget(used = 0): void {
    this.#used = used;
    this.#onSpend?.(used);
    this.#pump();
  }

  status(): SchedulerStatus {
    const b = this.spec.budget;
    const q = this.#queues.map((x) => x.length);
    return {
      provider: this.spec.provider,
      creditsUsed: this.#used,
      budgetShare: b ? this.#used / b.monthlyCredits : 0,
      halted: this.halted,
      queued: [q[0]!, q[1]!, q[2]!, q[3]!],
      granted: [this.#granted[0]!, this.#granted[1]!, this.#granted[2]!, this.#granted[3]!],
      shed: [this.#shed[0]!, this.#shed[1]!, this.#shed[2]!, this.#shed[3]!],
      creditsByClass: [this.#byClass[0]!, this.#byClass[1]!, this.#byClass[2]!, this.#byClass[3]!],
      exhausted: this.#exhausted, exhaustedCount: this.#exhaustedCount, exhaustedFirstAtMs: this.#exhaustedFirstAt,
    };
  }

  #grant(p: Priority, credits: number, lane: string | undefined): void {
    const now = this.#timers.now();
    this.#window.take(now);
    for (const cap of this.#caps) if (capMatches(cap.spec, p, lane)) cap.window.take(now);
    this.#granted[p]!++;
    this.#spend(credits, p);
  }

  #spend(credits: number, p: Priority): void {
    if (!(credits >= 0) || !Number.isFinite(credits)) throw new RangeError(`${this.spec.provider}: credits must be a finite number >= 0`);
    if (credits === 0) return;
    this.#used += credits;
    this.#byClass[p]! += credits;
    this.#onSpend?.(this.#used);
  }

  /** Sheds the lowest class, newest first, until the queue fits. P0 is never shed. */
  #trim(): void {
    let total = this.#queues.reduce((n, q) => n + q.length, 0);
    for (let c = 3; c >= 1 && total > this.spec.maxQueue; c--) {
      const q = this.#queues[c]!;
      while (q.length > 0 && total > this.spec.maxQueue) {
        const w = q.pop()!;
        total--;
        this.#shed[c]!++;
        w.refuse(new ScheduleRefused(this.spec.provider, w.priority, 'shed'));
      }
    }
  }

  /** Serves queued requests in class order, refuses expired or halted ones, and sets one timer for the next chance. */
  #pump(): void {
    const now = this.#timers.now();
    let wakeAt = Number.POSITIVE_INFINITY;
    for (const p of CLASSES) {
      const q = this.#queues[p]!;
      while (q.length > 0) {
        const w = q[0]!;
        if (p !== P0 && (this.halted || now < this.#exhaustedUntil)) {
          q.shift();
          this.#shed[p]!++;
          w.refuse(new ScheduleRefused(this.spec.provider, p, 'halted'));
          continue;
        }
        if (now - w.since >= this.spec.maxWaitMs[p]) {
          q.shift();
          this.#shed[p]!++;
          w.refuse(new ScheduleRefused(this.spec.provider, p, 'expired'));
          continue;
        }
        const a = this.check(p, w.lane);
        if (!a.ok) {
          wakeAt = Math.min(wakeAt, a.retryAt, w.since + this.spec.maxWaitMs[p]);
          break;
        }
        q.shift();
        this.#grant(p, w.credits, w.lane);
        w.start();
      }
    }
    if (this.#wake !== null) this.#timers.clearTimeout(this.#wake);
    this.#wake = null;
    if (Number.isFinite(wakeAt)) this.#wake = this.#timers.setTimeout(() => { this.#wake = null; this.#pump(); }, Math.max(1, wakeAt - now));
  }
}
