// RED TEAM C: the fill's daily credit budget only rolls forward, by design, so a clock stepped back keeps today's spend.
// But one boot with the clock far ahead (an RTC reading 2027, a VM restore with a wrong clock) dates the file in the
// future, and every later day, once the clock is right, reads "already spent" until that future date: no restart fill
// for months, so every restart gap stays open and H14 reads not covered (no trades, with no alert). A day more than one
// day ahead of the clock cannot be a real UTC day already spent.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DailyBudget } from '../../src/persist/state.ts';
import { CUT_CREATE_FETCHES_PER_DAY, CUT_TRADE_FETCHES_PER_DAY, REREAD_CREDITS_PER_DAY, rolledFetchCaps } from '../../src/run/worker.ts';
import { tempState } from '../worker-harness.ts';
import { RUG_CHECK_CONFIG, RUG_CONFIG } from '../../../core/src/config/index.ts';
import { DeployerChecks, FactReaders, FactRpc } from '../../src/facts/index.ts';
import type { HttpClient } from '../../src/providers/http.ts';
import { HELIUS_FREE, ManualTimers, Scheduler } from '../../src/scheduler/index.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7, 3);

describe('red team C: fill budget dated in the far future', () => {
  it('a budget file dated a year ahead does not hold the budget at zero for a week of correct clocks', () => {
    const path = join(tempState(), 'fill-budget.json');
    // Written by one boot whose clock read 2027-10-07.
    writeFileSync(path, JSON.stringify({ version: 1, day: '2027-10-07', spent: 5_000 }));
    const b = DailyBudget.load(path, 5_000, NOW);
    expect(b.remaining(NOW + 7 * DAY)).toBeGreaterThan(0);
  });
});

describe('RC-M3: one rule for every daily budget dated in the future', () => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const file = () => join(tempState(), 'b.json');

  it('fill budget: dated tomorrow keeps its spend (a clock stepped back under a day); dated further ahead, today is spent and tomorrow is whole', () => {
    const p1 = file();
    writeFileSync(p1, JSON.stringify({ version: 1, day: day(NOW + DAY), spent: 3_000 }));
    const b1 = DailyBudget.load(p1, 5_000, NOW);
    expect(b1.remaining(NOW)).toBe(2_000);
    expect(b1.remaining(NOW + DAY)).toBe(2_000);
    expect(b1.remaining(NOW + 2 * DAY)).toBe(5_000);

    const p2 = file();
    writeFileSync(p2, JSON.stringify({ version: 1, day: day(NOW + 2 * DAY), spent: 0 }));
    const b2 = DailyBudget.load(p2, 5_000, NOW);
    expect(b2.remaining(NOW)).toBe(0);
    // Written back: a restart today reads today spent, never the far date.
    expect(JSON.parse(readFileSync(p2, 'utf8'))).toEqual({ version: 1, day: day(NOW), spent: 5_000 });
    expect(DailyBudget.load(p2, 5_000, NOW + 60_000).remaining(NOW + 60_000)).toBe(0);
    expect(b2.remaining(NOW + DAY)).toBe(5_000);
    expect(DailyBudget.load(p2, 5_000, NOW + DAY).remaining(NOW + DAY)).toBe(5_000);
  });

  it('fill budget: a clock that ran far ahead inside one process and came back spends today only', () => {
    const p = file();
    const b = DailyBudget.load(p, 5_000, NOW);
    b.spend(100, NOW + 365 * DAY);
    expect(b.remaining(NOW)).toBe(0);
    expect(b.remaining(NOW + DAY)).toBe(5_000);
  });

  it('fill budget: a day that is not a date counts today as spent', () => {
    const p = file();
    writeFileSync(p, JSON.stringify({ version: 1, day: 'zzzz', spent: 0 }));
    expect(DailyBudget.load(p, 5_000, NOW).remaining(NOW)).toBe(0);
  });

  it('holder scans: a count file dated far ahead refuses today only; one dated tomorrow keeps its spend until that day has passed (never locked when unspent)', async () => {
    const today = Math.floor(NOW / DAY);
    const readers = (f: string, timers: ManualTimers) => new FactReaders({
      feed: { ingest: () => {} }, rpc: new FactRpc({ url: () => 'x', http: refuse, scheduler: new Scheduler(HELIUS_FREE, { timers, creditsUsed: 0 }), timeoutMs: 1000 }),
      http: refuse, timers, timeoutMs: 1000, holderScansPerDay: 1, scansFile: f,
    });
    const scanned = async (r: FactReaders) => {
      await r.readHoldersAll('So11111111111111111111111111111111111111112');
      return r.outcomes.at(-1)?.detail !== 'daily scan cap reached';
    };
    const far = file();
    writeFileSync(far, JSON.stringify({ day: today + 400, scans: 0 }));
    const t = new ManualTimers(NOW);
    expect(await scanned(readers(far, t))).toBe(false);
    expect(JSON.parse(readFileSync(far, 'utf8')).day).toBe(today);
    t.advance(DAY);
    expect(await scanned(readers(far, t))).toBe(true);

    // Dated tomorrow and unspent: today's scan is granted and counts into tomorrow's record; then the cap (1) holds.
    const near = file();
    writeFileSync(near, JSON.stringify({ day: today + 1, scans: 0 }));
    const t2 = new ManualTimers(NOW);
    expect(await scanned(readers(near, t2))).toBe(true);
    expect(JSON.parse(readFileSync(near, 'utf8'))).toEqual({ day: today + 1, scans: 1 });
    expect(await scanned(readers(near, t2))).toBe(false);
    t2.advance(DAY);
    expect(await scanned(readers(near, t2))).toBe(false);
    t2.advance(DAY);
    expect(await scanned(readers(near, t2))).toBe(true);
  });

  it('deployer checks: a spend file dated far ahead spends today only; one dated tomorrow keeps its spend', () => {
    const today = Math.floor(NOW / DAY);
    const checks = (f: string) => new DeployerChecks({ history: {} as never, rugs: RUG_CONFIG, config: RUG_CHECK_CONFIG, minGapMs: 60_000, creditsPerDay: 1_000, spendFile: f });
    const far = file();
    writeFileSync(far, JSON.stringify({ day: today + 400, spent: 1_000 }));
    const a = checks(far);
    expect(a.remaining(NOW)).toBe(0);
    expect(JSON.parse(readFileSync(far, 'utf8')).day).toBe(today);
    expect(a.remaining(NOW + DAY)).toBe(1_000);
    expect(checks(far).remaining(NOW + DAY)).toBe(1_000);

    const near = file();
    writeFileSync(near, JSON.stringify({ day: today + 1, spent: 400 }));
    const b = checks(near);
    expect(b.remaining(NOW)).toBe(600);
    expect(b.remaining(NOW + DAY)).toBe(600);
    expect(b.remaining(NOW + 2 * DAY)).toBe(1_000);
  });
});

const refuse = (async () => {
  throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
}) as unknown as HttpClient;

describe('RC-M3: cut-log fetch and re-read counts', () => {
  const today = Math.floor(NOW / DAY);
  const caps = { cutCreate: 10, cutTrade: 20, reread: 30 };
  it('a new day starts at zero; today and tomorrow keep their counts; further ahead, today is spent', () => {
    expect(rolledFetchCaps({ day: today - 1, ...caps }, today)).toEqual({ day: today, cutCreate: 0, cutTrade: 0, reread: 0 });
    expect(rolledFetchCaps({ day: today, ...caps }, today)).toBeNull();
    expect(rolledFetchCaps({ day: today + 1, ...caps }, today)).toBeNull();
    expect(rolledFetchCaps({ day: today + 2, ...caps }, today)).toEqual({ day: today, cutCreate: CUT_CREATE_FETCHES_PER_DAY, cutTrade: CUT_TRADE_FETCHES_PER_DAY, reread: REREAD_CREDITS_PER_DAY });
    expect(rolledFetchCaps({ day: today, cutCreate: CUT_CREATE_FETCHES_PER_DAY, cutTrade: CUT_TRADE_FETCHES_PER_DAY, reread: REREAD_CREDITS_PER_DAY }, today + 1)).toEqual({ day: today + 1, cutCreate: 0, cutTrade: 0, reread: 0 });
  });
});
