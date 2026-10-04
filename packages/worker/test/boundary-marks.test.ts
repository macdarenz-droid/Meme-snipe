// WORKER-1c on RISK-MARK: the day and week boundary marks and the NAV peak come from the marked account (each open
// position at its executable mark, marks.ts), never the raw account fact, whose marks are null (a total loss). A
// boundary is recorded only once every open position has a fresh mark. The harness's market is anchored at one moment
// and the hold is at most 2 hours, so a Melbourne midnight cannot pass while a position is held; each boundary test
// restarts the worker with the account's day and week marks dated to the day before, which is the same first look at
// or after a boundary with the position open.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executableMark } from '../../core/src/exits/index.ts';
import { NO_LATCHES, melbourneDay, melbourneWeek, riskSnapshot } from '../../core/src/risk/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import { type Lamports, microUsdToLamports } from '../../core/src/units/index.ts';
import { markSettings } from '../src/engine/marks.ts';
import { MARK_PREFIX, TRIPPED_PREFIX } from '../src/engine/strategy.ts';
import { type AccountState, PaperAccount, accountFile } from '../src/run/account.ts';
import { MINT, Market, makeWorker, passingMarket } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const lines = (h: H) => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const decisions = (h: H): string[][] => lines(h).filter((l) => l['kind'] === 'decision' && l['boot'] === h.worker.boot).map((l) => (l['reasons'] as string[]) ?? []);
const position = (h: H) => Object.values(h.worker.book.positions).find((p) => String(p.mint) === MINT);
const account = (h: H): AccountState => accountFile(h.stateDir).read(null as unknown as AccountState);

/** A new slot and a pool read at `scalePpm` of the passing price (with a fresh SOL price): the mark stays fresh. */
const tick = (m: Market, scalePpm = 1_000_000n) => (): void => {
  m.slot();
  m.pool(scalePpm);
};

const until = async (m: Market, done: () => boolean, maxMs: number, each: () => void): Promise<boolean> => {
  const end = m.now + maxMs;
  while (!done() && m.now < end) await m.run(400, 400, each);
  return done();
};

/** The passing market (the pool fact keeps coming while held, POS-1's test switch) and the entry. */
const entered = async (): Promise<{ h: H; m: Market }> => {
  const h = makeWorker();
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, { heldPoolFacts: true });
  expect(await until(m, () => position(h)?.status === 'open', 30_000, tick(m))).toBe(true);
  // The entry plan is made on the market event after the fill and saved with it: stopped before then, a restart has no
  // plan for the position and sends it to sell-only recovery (EXIT-1g). These tests need the planned position.
  expect(await until(m, () => h.worker.strategy.saved()[position(h)!.id] !== undefined, 30_000, tick(m))).toBe(true);
  return { h, m };
};

/**
 * Stops the worker with the position open, dates the day and week marks to the day before (so the next look is the
 * first at or after a boundary), moves the clock past maxQuoteAgeMs (every market and price read is then stale), and
 * starts it again. Returns the new worker, its market and today's Melbourne day start.
 */
const acrossBoundary = async (h: H): Promise<{ h2: H; m2: Market; day: number; pid: string }> => {
  const pid = position(h)!.id;
  await h.worker.stop();
  const file = accountFile(h.stateDir);
  const a = account(h);
  const now = h.timers.now();
  const day = melbourneDay(now).start;
  file.write({ ...a, dayMark: { ...a.dayMark!, startMs: day - 86_400_000, atMs: day - 86_400_000 }, weekMark: { ...a.weekMark!, startMs: melbourneWeek(now).start - 7 * 86_400_000, atMs: day - 86_400_000 } });
  h.timers.set(now + h.session.policy.gates.maxQuoteAgeMs + 1_000);
  const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
  expect(await h2.worker.reconcile()).toEqual({ ok: true });
  expect(h2.worker.book.positions[pid]?.status).toBe('open');
  return { h2, m2: new Market(h2, { heldPoolFacts: true }), day, pid };
};

/** The position's executable mark now (marks.ts's settings, the worker's newest market), lamports (SOL-BOOKS). */
const markNow = (h: H): bigint => {
  const p = position(h)!;
  const pool = h.worker.poolOf(MINT)!;
  const v = executableMark({ venue: 'pumpswap', pool: pool.state, ctx: pool.ctx }, p.quantity, markSettings(h.session.policy, h.worker.strategyConfig.network));
  expect(v.ok).toBe(true);
  return v.ok ? v.value : 0n;
};

describe('boundary marks from the marked account (RISK-MARK)', () => {
  it('a day boundary with an open position records equity at the executable mark, not as a total loss', async () => {
    const { h } = await entered();
    const cost = position(h)!.cost;
    const { h2, m2, day } = await acrossBoundary(h);
    expect(await until(m2, () => account(h2).dayMark?.startMs === day, 20_000, tick(m2))).toBe(true);
    expect(position(h2)!.status).toBe('open');
    const a = account(h2);
    // A total loss would leave at most the opening equity less the entry's cost (fees and rent take a little more);
    // the marked equity carries the position's executable value on top, less those fees.
    // Opening equity in lamports: the bankroll at the opening (the harness's) SOL price.
    const totalLoss = microUsdToLamports(a.openingEquity, a.openingSolPrice!, 'floor') - cost;
    expect(a.dayMark!.equity - totalLoss).toBeGreaterThan(markNow(h2) / 2n);
    expect(a.weekMark!.equity).toBe(a.dayMark!.equity);
    await h2.worker.stop();
  });

  it('a boundary seen with a stale mark is not recorded until a fresh one arrives', async () => {
    const { h } = await entered();
    const { h2, m2, day } = await acrossBoundary(h);
    // Slots go on, but no pool read and no SOL price: the mark stays stale, so the boundary waits.
    expect(await until(m2, () => false, 4_000, () => m2.slot())).toBe(false);
    expect(position(h2)!.status).toBe('open');
    expect(account(h2).dayMark!.startMs).toBe(day - 86_400_000);
    const waitedTo = m2.now;
    expect(await until(m2, () => account(h2).dayMark?.startMs === day, 20_000, tick(m2))).toBe(true);
    expect(account(h2).dayMark!.atMs).toBeGreaterThanOrEqual(waitedTo);
    await h2.worker.stop();
  });

  it('a fall in the mark after the boundary is the marked measure\'s day loss, and daily_loss trips', async () => {
    const { h } = await entered();
    const { h2, m2, day, pid } = await acrossBoundary(h);
    expect(await until(m2, () => account(h2).dayMark?.startMs === day, 20_000, tick(m2))).toBe(true);
    const atBoundary = markNow(h2);
    expect(account(h2).trades.filter((t) => t.closedAtMs != null)).toEqual([]);
    // The price falls 85%: the stop fires, and risk judges the exit on the marked account.
    expect(await until(m2, () => decisions(h2).some((r) => r[0] === 'exit'), 20_000, tick(m2, 150_000n))).toBe(true);
    const exit = decisions(h2).find((r) => r[0] === 'exit')!;
    expect(JSON.stringify(exit)).toContain(MINT);
    expect(exit.find((x) => x.startsWith(TRIPPED_PREFIX))?.slice(TRIPPED_PREFIX.length).split(',')).toContain('daily_loss');
    const exitMark = BigInt(exit.find((x) => x.startsWith(MARK_PREFIX))!.slice(MARK_PREFIX.length));
    const at = m2.now;
    await h2.worker.stop();
    // Risk's day loss at the exit, from the account as the worker hands it over with the exit's mark. The marked
    // measure (the recorded day start less marked equity now) is exactly the fall in the position's executable value
    // since the boundary (each capped at its notional, as risk counts no unrealized gain). Recorded from the raw
    // account (a total loss), the day start sat below today's marked equity and this measure saw no loss at all. At
    // trial sizes the realized measure (the whole open loss since entry) is the larger of the two, and risk takes the
    // larger, so the trip itself does not single out either measure.
    const ledger = openLedger(join(h.stateDir, 'ledger.sqlite'), 'paper');
    const a = new PaperAccount(accountFile(h.stateDir), account(h2).openingEquity, at, 0n);
    const fact = a.fact(ledger, h2.worker.book, NO_LATCHES, at);
    ledger.close();
    const history = { ...fact.history, openPositions: fact.history.openPositions.map((o) => ({ ...o, mark: exitMark as Lamports, markAtMs: at })) };
    const snap = riskSnapshot({
      session: h2.session, mode: 'paper', clock: { now: () => ({ slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: at }) },
      account: history, latches: NO_LATCHES, market: { solBalance: fact.solBalance, regime: 'unknown' },
    })!;
    expect(history.markedAtDayStart).toBe(account(h2).dayMark!.equity);
    const notional = history.openPositions[0]!.notional;
    const capped = (v: bigint) => (v < notional ? v : notional);
    const markedLoss = account(h2).dayMark!.equity - snap.equity;
    expect(markedLoss).toBe(capped(atBoundary) - capped(exitMark));
    expect(markedLoss).toBeGreaterThan(0n);
    expect(snap.dayLoss).toBeGreaterThanOrEqual(markedLoss);
    expect(snap.dayLoss).toBeGreaterThanOrEqual(snap.dailyLimit);
    expect(h2.worker.book.positions[pid]).toBeDefined();
  });

  it('the NAV peak rises while a position is open', async () => {
    const { h, m } = await entered();
    const openAt = m.now;
    const before = account(h).navPeak!;
    // The price rises 40%: the marked NAV passes the peak taken before the entry, with the position still open. (30% no
    // longer does since PAPER-1: the token account's rent now leaves the paper wallet at entry, as it does on chain.)
    expect(await until(m, () => account(h).navPeak!.atMs >= openAt, 20_000, tick(m, 1_400_000n))).toBe(true);
    expect(position(h)!.status).toBe('open');
    expect(account(h).navPeak!.nav).toBeGreaterThan(before.nav);
    await h.worker.stop();
  });
});
