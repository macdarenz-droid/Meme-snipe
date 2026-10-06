// HELIUS-PLAN: the owner's Helius Developer plan (2026-10-07: 10M credits a month, 50 RPC requests a second). One
// setting picks it (ZEROED_HELIUS_PLAN, default developer); the worker's Helius scheduler and the plan-derived figures
// follow it. Provider limits, not risk limits.
import { describe, expect, it } from 'vitest';
import { DEFAULT_HELIUS_PLAN, HELIUS_DEVELOPER, HELIUS_FREE, HELIUS_PLANS, ManualTimers, P0, P1, P2, P3, Scheduler } from '../src/scheduler/index.ts';
import { CreditBook, HELIUS_WORKER, LiveProviders, heliusWorker } from '../src/run/sources.ts';
import { CAPPED_READ_CREDITS_PER_DAY, FILL_SHARE, PLAN_FILL_CREDITS_PER_DAY, SEED_CREDIT_CAP, planFillCreditsPerDay, seedCreditCap } from '../src/run/seed-start.ts';
import { FILL_CREDITS_PER_DAY, parseConfig } from '../src/run/config.ts';
import { blockNetwork, testSecrets } from './helpers.ts';
import { tempState } from './worker-harness.ts';

blockNetwork();

const providers = (plan?: 'free' | 'developer') => new LiveProviders({
  tradeStreams: false, ...(plan === undefined ? {} : { heliusPlan: plan }), secrets: testSecrets, http: async () => ({ status: 500, header: () => null, text: '' }),
  factory: () => { throw new Error('no sockets in this test'); }, credits: new CreditBook(tempState(), new ManualTimers(0)),
});

describe('HELIUS-PLAN: the Developer plan', () => {
  it('the spec: 50 requests a second, the free floors scaled by five (P0–P1 keep half the window), 10M a month, the same halt share', () => {
    expect(HELIUS_DEVELOPER.window).toEqual({ limit: 50, windowMs: 1_000 });
    expect(HELIUS_DEVELOPER.floors).toEqual(HELIUS_FREE.floors.map((f) => f * 5));
    expect(HELIUS_DEVELOPER.budget).toEqual({ monthlyCredits: 10_000_000, haltShare: HELIUS_FREE.budget!.haltShare });
    expect(HELIUS_PLANS).toEqual({ free: HELIUS_FREE, developer: HELIUS_DEVELOPER });
    expect(DEFAULT_HELIUS_PLAN).toBe('developer');
  });

  it('its window allows 50 requests in a second: P2 and P3 stop at 25, P0 and P1 get the other 25, the 51st waits', () => {
    const s = new Scheduler(heliusWorker('developer'), { timers: new ManualTimers(1_000_000) });
    let low = 0;
    while (s.tryAcquire(low % 2 === 0 ? P2 : P3).ok) low++;
    expect(low).toBe(25);
    let high = 0;
    while (s.tryAcquire(high % 2 === 0 ? P0 : P1).ok) high++;
    expect(high).toBe(25);
    expect(s.check(P0)).toMatchObject({ ok: false, reason: 'window' });
  });

  it('the worker picks the configured plan: Developer by default and when set, Free when set; no monthly halt of its own', () => {
    expect(providers().helius.spec.window.limit).toBe(50);
    expect(providers('developer').helius.spec).toEqual(heliusWorker('developer'));
    expect(providers('free').helius.spec.window.limit).toBe(10);
    expect(providers().helius.spec.budget).toBeUndefined();
    expect(HELIUS_WORKER).toEqual(heliusWorker('developer'));
    // The quota report names the plan's month.
    expect(providers().ops().quota.find((q) => q.provider === 'helius')?.monthly_credits).toBe(10_000_000);
    expect(providers('free').ops().quota.find((q) => q.provider === 'helius')?.monthly_credits).toBe(1_000_000);
  });

  it('one setting: ZEROED_HELIUS_PLAN, developer by default, free accepted, anything else refused', () => {
    const base = { ZEROED_STATE_DIR: tempState(), ZEROED_MODE: 'paper' };
    const read = (env: Record<string, string>) => parseConfig({ ...base, ...env }, () => null);
    const ok = (r: ReturnType<typeof read>) => ('config' in r ? r.config.heliusPlan : null);
    expect(ok(read({}))).toBe('developer');
    expect(ok(read({ ZEROED_HELIUS_PLAN: 'free' }))).toBe('free');
    expect(ok(read({ ZEROED_HELIUS_PLAN: 'developer' }))).toBe('developer');
    expect(read({ ZEROED_HELIUS_PLAN: 'business' })).toMatchObject({ message: expect.stringContaining('ZEROED_HELIUS_PLAN') });
  });

  it('the plan-derived figures follow the formula: the fills\' plan share and the seed cap', () => {
    const share = (monthly: number, halt: number) => Math.floor((monthly * halt - 31 * CAPPED_READ_CREDITS_PER_DAY) * FILL_SHARE / 31);
    expect(planFillCreditsPerDay(HELIUS_DEVELOPER)).toBe(share(10_000_000, 0.7));
    expect(planFillCreditsPerDay(HELIUS_FREE)).toBe(share(1_000_000, 0.7));
    expect(CAPPED_READ_CREDITS_PER_DAY).toBe(14_840);
    expect(planFillCreditsPerDay(HELIUS_DEVELOPER)).toBe(105_483);
    expect(planFillCreditsPerDay(HELIUS_FREE)).toBe(3_870);
    expect(PLAN_FILL_CREDITS_PER_DAY).toBe(105_483);
    expect(seedCreditCap(HELIUS_DEVELOPER)).toBe(1_500_000);
    expect(seedCreditCap(HELIUS_FREE)).toBe(150_000);
    expect(SEED_CREDIT_CAP).toBe(1_500_000);
    // The fills' configured daily budget is not raised by the plan (S1 raises it once the real burn is measured).
    expect(FILL_CREDITS_PER_DAY).toBe(20_000);
  });
});
