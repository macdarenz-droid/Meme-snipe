// RED TEAM B probes RB-1b and RB-2 at the worker level (SOL-BOOKS): the owner counts success in SOL (CLAUDE.md,
// 2026-10-05), so a SOL/USD move alone must never trip or loosen a limit, and a trade that lost SOL is a loss whatever
// its dollar figure. Black-box through the worker harness and its state files, so the same file runs on 959d8017
// (where each test fails: risk is kept in micro-dollars there) and on SOL-BOOKS (where each passes).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { RAW } from '../../core/src/facts/index.ts';
import { simKey } from '../../core/src/gates/index.ts';
import { poolBuyExactQuoteIn, poolSell } from '../../core/src/amm/index.ts';
import { BASE_VAULT, FEE_CONTEXT, POOL, QUOTE_VAULT } from '../../core/test/gates/world.ts';
import { LiveFacts, type LiveReaders } from '../src/facts/index.ts';
import { NO_LATCHES } from '../../core/src/risk/index.ts';
import { type MicroUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import { SOL_PRICE_KEY } from '../src/engine/strategy.ts';
import { accountFile } from '../src/run/account.ts';
import { NO_CONTROL, controlFile } from '../src/run/state.ts';
import { MINT, Market, SOL_PRICE, T, dueTimers, makeWorker, passingMarket, tempState } from './worker-harness.ts';

const DAY = 86_400_000;
const MIN_SPEND = microUsdToLamports(TRIAL_POLICY.capital.minNotional, SOL_PRICE as MicroUsd, 'ceil');
type Line = { kind: string; action?: string; gate_reasons?: { gate: string; code: string }[] };
const decisions = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line).filter((l) => l.kind === 'decision');
const rejectCodes = (dir: string) => decisions(dir).filter((l) => l.action === 'reject').flatMap((l) => (l.gate_reasons ?? []).map((g) => g.code));
const entries = (h: ReturnType<typeof makeWorker>) => Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'entry');

/** H15 live, as size-step-up.test.ts: the fact source simulates each candidate at the spend the gates ask for. */
const simulating = () => new LiveFacts({
  readers: (ctx) => {
    const none = async () => false;
    const r: LiveReaders = {
      readAccounts: none, readHolders: none, readHoldersAll: none, readCrossChecks: async () => [], readMintHistory: none, readSolUsd: none,
      readSim: async (mint, spend) => {
        const b = poolBuyExactQuoteIn({ baseReserve: BASE_VAULT, quoteVault: QUOTE_VAULT, virtualQuoteReserves: POOL.virtualQuoteReserves ?? 0n }, spend, FEE_CONTEXT);
        if (!b.ok) return false;
        const x = poolSell(b.trade.after, b.trade.base, FEE_CONTEXT);
        if (!x.ok) return false;
        ctx.ingest.ingest('helius', { type: 'offchain', key: RAW.sim(mint), value: { mint, slot: ctx.tip() ?? 0n, spend, ok: true, paid: b.trade.userQuote, proceeds: x.trade.userQuote, error: null } }, { receivedAt: ctx.timers.now() });
        return true;
      },
    };
    return r;
  },
  tickMs: 1_000, minReadGapMs: 60_000, survivalAfterMs: 30 * 60_000, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
  mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
});

const boot = async (h: ReturnType<typeof makeWorker>) => {
  let started: unknown = null;
  void h.worker.start().then((r) => void (started = r));
  for (let k = 0; k < 200 && started === null; k++) {
    h.timers.set(h.timers.now() + 100);
    for (let j = 0; j < 4; j++) await new Promise<void>((r) => setImmediate(r));
  }
  expect(started).toEqual({ ok: true });
  h.worker.feed.ingest('helius', { type: 'offchain', key: 'feed:status:helius', value: { state: 'up' } }, { receivedAt: h.timers.now() });
};

describe('RB-1b: a SOL/USD fall alone never returns the size to the minimum', () => {
  it('with the owner\'s step-up approved and the wallet above every high-water mark, an 11% SOL/USD fall leaves the entry above q_min', async () => {
    const stateDir = tempState();
    controlFile(stateDir).write({ paused: false, pausedAtMs: null, latches: { ...NO_LATCHES, sizeStepUpApproved: true } });
    // A wallet grown past the bankroll (about $23 of SOL on $20 at the passing price), its setup paid, no trade yet; its
    // NAV peak is that SOL at the passing price, as a file from before SOL-BOOKS records it (micro-dollars).
    accountFile(stateDir).write({ openedAtMs: T - 20 * DAY, openingEquity: TRIAL_POLICY.capital.bankroll, walletLamports: 153_333_333n, trades: [], entries: [], oneTimePaid: true, navPeak: { atMs: T - 17 * DAY, nav: 23_000_000n } } as never);
    const h = makeWorker({ stateDir, timers: dueTimers(T - 16 * DAY), facts: [simulating()], config: { ZEROED_HEALTH_ADDR: '127.0.0.1:19140', ZEROED_API_ADDR: '127.0.0.1:19141' } });
    await boot(h);
    // The first SOL price is the passing one, while nothing is a candidate yet (SOL-BOOKS: the opening price). After it,
    // no price until the coin is ready; then SOL/USD is 11% lower for good.
    const m = await passingMarket(h, {
      heldPoolFacts: true, omit: [SOL_PRICE_KEY, simKey(MINT)],
      before: { atMs: T - 30 * 60_000, run: (x) => { x.omit = new Set([simKey(MINT)]); x.solPrice(); x.omit = new Set([SOL_PRICE_KEY, simKey(MINT)]); } },
    });
    expect(entries(h)).toEqual([]);
    m.solUsd = (SOL_PRICE * 89n) / 100n;
    m.omit = new Set([simKey(MINT)]);
    await m.run(120_000, 400, () => { m.slot(); m.pool(); });
    await h.worker.stop();
    const made = entries(h);
    expect(made.length, rejectCodes(stateDir).slice(-6).join(', ')).toBeGreaterThan(0);
    // The SOL is the same and so is every SOL figure: the owner's step-up still applies.
    // q_min in lamports is at most its value at the lower price (dollar books sized it there), so above both.
    const minAtFall = microUsdToLamports(TRIAL_POLICY.capital.minNotional, ((SOL_PRICE * 89n) / 100n) as MicroUsd, 'ceil');
    expect(BigInt((made[0]!.intent as { spend: bigint }).spend), `q_min ${MIN_SPEND} at the passing price, ${minAtFall} after the fall`).toBeGreaterThan(minAtFall);
  }, 120_000);
});

describe('RB-1m: the deploy of SOL-BOOKS onto a file from before', () => {
  it('a dollar NAV peak recorded when SOL/USD was 45% higher latches no kill switch at the first price after the deploy', async () => {
    const stateDir = tempState();
    // The wallet's SOL never changed (no trade): its peak in dollars was that SOL at the passing price.
    accountFile(stateDir).write({ openedAtMs: T - 20 * DAY, openingEquity: TRIAL_POLICY.capital.bankroll, walletLamports: 153_333_333n, trades: [], entries: [], oneTimePaid: true, navPeak: { atMs: T - 17 * DAY, nav: 23_000_000n } } as never);
    const h = makeWorker({ stateDir, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:19146', ZEROED_API_ADDR: '127.0.0.1:19147' } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h);
    // SOL/USD now 69% of then: in dollars a 31% fall from the peak, past R10's 30%; in SOL nothing moved.
    m.solUsd = (SOL_PRICE * 69n) / 100n;
    await m.run(4_000, 400, () => { m.slot(); m.solPrice(); h.worker.step(); });
    expect(controlFile(stateDir).read(NO_CONTROL).latches.killTrippedAtMs).toBeNull();
    expect(h.logs.some((l) => l.startsWith('Risk tripped on the account valuation'))).toBe(false);
    await h.worker.stop();
  });
});

describe('RB-2: a trade that lost SOL is a loss, whatever SOL/USD did', () => {
  it('RB-2a/b: two closed trades that each lost SOL while SOL/USD rose (a dollar gain) start R8\'s loss cooldown', async () => {
    const stateDir = tempState();
    // As the worker at 959d8017 booked them when SOL/USD rose 6% during each: SOL lost, dollars gained.
    const lost = 700_000n;
    const trade = (id: string, closedAtMs: number) => ({ positionId: `p:${id}:1`, mint: id, openedAtMs: closedAtMs - 600_000, notional: TRIAL_POLICY.capital.minNotional, closedAtMs, netLamports: -lost, netPnl: 50_000n, stoppedOut: false, booked: -lost, openSolPrice: SOL_PRICE, closeSolPrice: (SOL_PRICE * 106n) / 100n });
    const bankroll = microUsdToLamports(TRIAL_POLICY.capital.bankroll, SOL_PRICE as MicroUsd, 'floor');
    accountFile(stateDir).write({ openedAtMs: T - 20 * DAY, openingEquity: TRIAL_POLICY.capital.bankroll, walletLamports: bankroll - 2n * lost, trades: [trade('MintA', T - 30 * 60_000), trade('MintB', T - 25 * 60_000)], entries: [], oneTimePaid: true } as never);
    const h = makeWorker({ stateDir, timers: dueTimers(T - 16 * DAY), config: { ZEROED_HEALTH_ADDR: '127.0.0.1:19142', ZEROED_API_ADDR: '127.0.0.1:19143' } });
    await boot(h);
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(30_000, 400, () => { m.slot(); m.pool(); });
    await h.worker.stop();
    expect(rejectCodes(stateDir)).toContain('loss_cooldown');
    expect(entries(h)).toEqual([]);
  }, 120_000);

  it('RB-2c: SOL/USD 34% higher hides none of an open position\'s loss in SOL: today\'s loss stays as it was', async () => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:19144', ZEROED_API_ADDR: '127.0.0.1:19145' } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    const p = Object.values(h.worker.book.positions).find((x) => String(x.mint) === MINT && x.status === 'open');
    expect(p).toBeDefined();
    const dayLoss = () => h.worker.apiInputs().stops?.dayLoss ?? null;
    // Open at its executable mark (the entry's costs and the sale's impact): already a loss in SOL.
    const before = dayLoss();
    expect(before !== null && before > 0n).toBe(true);
    // The same pool (the same SOL for the tokens), SOL/USD 34% higher: more dollars, not more SOL.
    m.solUsd = (SOL_PRICE * 134n) / 100n;
    await m.run(4_000, 400, () => { m.slot(); m.pool(); });
    expect(Object.values(h.worker.book.positions).find((x) => x.id === p!.id)?.status).toBe('open');
    expect(dayLoss()).toBe(before);
    await h.worker.stop();
  }, 120_000);
});
