// AUDIT-RM4 F3: once the owner approves size step-up (`sizeStepUpApproved`), risk sizes above q_min. The strategy judged
// the gates and the simulation at q_min, so every entry was refused as a size mismatch. The gates and H15's simulation
// must judge the size risk will use.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { RAW } from '../../core/src/facts/index.ts';
import { simKey } from '../../core/src/gates/index.ts';
import { NO_LATCHES } from '../../core/src/risk/index.ts';
import { type Lamports, lamportsToMicroUsd, microUsdToLamports, type MicroUsd } from '../../core/src/units/index.ts';
import { poolBuyExactQuoteIn, poolSell } from '../../core/src/amm/index.ts';
import { BASE_VAULT, FEE_CONTEXT, POOL, QUOTE_VAULT } from '../../core/test/gates/world.ts';
import { LiveFacts, type LiveReaders } from '../src/facts/index.ts';
import { controlFile } from '../src/run/state.ts';
import { accountFile } from '../src/run/account.ts';
import { markedHistory } from '../src/engine/marks.ts';
import type { WorkerDeps } from '../src/run/worker.ts';
import { blockNetwork } from './helpers.ts';
import { MINT, SOL_PRICE, T, dueTimers, makeWorker, passingMarket, tempState } from './worker-harness.ts';

blockNetwork();

const DAY = 86_400_000;
const MIN_SPEND = microUsdToLamports(TRIAL_POLICY.capital.minNotional, SOL_PRICE as MicroUsd, 'ceil');

/** An honest simulation at `spend` on the passing pool: the buy, then the sale of its tokens at once on the pool it left. */
const simulated = (spend: bigint) => {
  const b = poolBuyExactQuoteIn({ baseReserve: BASE_VAULT, quoteVault: QUOTE_VAULT, virtualQuoteReserves: POOL.virtualQuoteReserves ?? 0n }, spend, FEE_CONTEXT);
  if (!b.ok) return null;
  const x = poolSell(b.trade.after, b.trade.base, FEE_CONTEXT);
  return x.ok ? { paid: b.trade.userQuote, proceeds: x.trade.userQuote } : null;
};

/** H15 live: no simulation fact is published; the fact source simulates each candidate at the spend the gates ask for. */
const simulating = (asked: bigint[]) => new LiveFacts({
  readers: (ctx) => {
    const none = async () => false;
    const r: LiveReaders = {
      readAccounts: none, readHolders: none, readHoldersAll: none, readCrossChecks: async () => [], readMintHistory: none, readSolUsd: none,
      readSim: async (mint, spend) => {
        asked.push(spend);
        const q = simulated(spend);
        if (q === null) return false;
        ctx.ingest.ingest('helius', { type: 'offchain', key: RAW.sim(mint), value: { mint, slot: ctx.tip() ?? 0n, spend, ok: true, ...q, error: null } }, { receivedAt: ctx.timers.now() });
        return true;
      },
    };
    return r;
  },
  tickMs: 1_000, minReadGapMs: 60_000, survivalAfterMs: 30 * 60_000, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
  mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
});

type Line = { kind: string; action?: string; reasons?: string[]; gate_reasons?: { gate: string; code: string; detail?: string }[] };

/** A trade won 0.02 SOL 18 days ago (a file from before: its size in micro-dollars, its result in lamports). */
const WON = { positionId: 'p:won:1', mint: 'WonMint', openedAtMs: T - 19 * DAY, notional: TRIAL_POLICY.capital.minNotional, closedAtMs: T - 18 * DAY, netLamports: 20_000_000n, netPnl: 3_000_000n, stoppedOut: false, booked: 20_000_000n };

const run = async (stepUp: boolean, port: number, sizeProbe?: WorkerDeps['sizeProbe'], markedHistory?: WorkerDeps['markedHistory'], after?: () => void, seen?: (h: ReturnType<typeof makeWorker>) => void) => {
  const stateDir = tempState();
  controlFile(stateDir).write({ paused: false, pausedAtMs: null, latches: { ...NO_LATCHES, sizeStepUpApproved: stepUp } });
  // A wallet that has grown past the bankroll (about $23 of SOL on a $20 bankroll, its setup paid): above every
  // high-water mark, so no drawdown returns the size to the minimum and the owner's step-up applies. SOL-BOOKS (risk
  // review F1): the growth is a booked winning trade, so the wallet's funded SOL is the bankroll at the passing price.
  accountFile(stateDir).write({ openedAtMs: T - 20 * DAY, openingEquity: TRIAL_POLICY.capital.bankroll, walletLamports: 153_333_334n, trades: [WON], entries: [], oneTimePaid: true } as never);
  const asked: bigint[] = [];
  const h = makeWorker({ stateDir, timers: dueTimers(T - 16 * DAY), facts: [simulating(asked)], ...(sizeProbe === undefined ? {} : { sizeProbe }), ...(markedHistory === undefined ? {} : { markedHistory }), config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port}`, ZEROED_API_ADDR: `127.0.0.1:${port + 1}` } });
  seen?.(h);
  let started: unknown = null;
  void h.worker.start().then((r) => void (started = r));
  for (let k = 0; k < 200 && started === null; k++) {
    h.timers.set(h.timers.now() + 100);
    for (let j = 0; j < 4; j++) await new Promise<void>((r) => setImmediate(r));
  }
  expect(started).toEqual({ ok: true });
  h.worker.feed.ingest('helius', { type: 'offchain', key: 'feed:status:helius', value: { state: 'up' } }, { receivedAt: h.timers.now() });
  const m = await passingMarket(h, { heldPoolFacts: true, omit: [simKey(MINT)] });
  await m.run(120_000, 400, () => {
    m.slot();
    m.pool();
  });
  // A second stretch after `after` (a test changes the world mid-run).
  if (after !== undefined) {
    after();
    await m.run(120_000, 400, () => {
      m.slot();
      m.pool();
    });
  }
  await h.worker.stop();
  const lines = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line);
  const decisions = lines.filter((l) => l.kind === 'decision');
  return { h, asked, decisions };
};

describe('size step-up: the gates and the simulation judge the size risk uses', () => {
  it('with the latch set, the coin is entered above the minimum, simulated at that size (today: every entry a size mismatch)', async () => {
    const { h, asked, decisions } = await run(true, 19010);
    const rejects = decisions.filter((l) => l.action === 'reject').map((l) => (l.gate_reasons ?? []).map((g) => `${g.gate} ${g.code} ${g.detail ?? ''}`).join(' | '));
    expect(rejects.some((r) => r.includes('size-mismatch')), rejects.join('\n')).toBe(false);
    const entries = Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'entry');
    expect(entries.length, rejects.slice(-4).join('\n')).toBeGreaterThan(0);
    const spend = BigInt((entries[0]!.intent as { spend: bigint }).spend);
    expect(spend).toBeGreaterThan(MIN_SPEND);
    // H15 was judged on a simulation at the very size risk approved.
    expect(asked).toContain(spend);
  }, 120_000);

  it('SOL-BOOKS: the gates judge the stepped-up size in dollars at the opening SOL price (risk sizes it in lamports)', async () => {
    const sizes: { spend: bigint; notional: bigint }[] = [];
    const { h } = await run(true, 19026, (sized) => (sizes.push(sized), sized));
    const up = sizes.filter((x) => x.spend > MIN_SPEND);
    expect(up.length).toBeGreaterThan(0);
    for (const x of up) expect(x.notional).toBe(lamportsToMicroUsd(x.spend as Lamports, SOL_PRICE as MicroUsd, 'floor'));
    expect(accountFile(h.stateDir).read(null as never).openingSolPrice).toBe(SOL_PRICE);
  }, 120_000);

  it('a size the probe did not settle on is refused as a size mismatch after the gates, and nothing is booked', async () => {
    // The probe's answer forced back to q_min while risk, with the latch set, sizes above it: the gates and H15 judge
    // one size, risk another (as when a size does not settle in three rounds). The guard must refuse it.
    const seen: bigint[] = [];
    const { h, decisions } = await run(true, 19018, (sized) => (seen.push(sized.spend), { spend: MIN_SPEND, notional: TRIAL_POLICY.capital.minNotional }));
    // The real probe had sized above q_min, so the forced answer differs from risk's own.
    expect(seen.some((s) => s > MIN_SPEND)).toBe(true);
    const codes = decisions.filter((l) => l.action === 'reject').flatMap((l) => (l.gate_reasons ?? []).map((g) => g.code));
    expect(codes).toContain('size-mismatch');
    expect(Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'entry')).toEqual([]);
    expect(Object.values(h.worker.book.positions)).toEqual([]);
  }, 120_000);

  it('risk unable to evaluate while the latch is set: the probe stays at q_min, the entry is refused as a risk fault, the worker keeps stepping (review of #189 B2)', async () => {
    // RISK-FAULT's seam: the marked account made unreadable to risk (closed trades not a list), so evaluateEntry throws.
    const seam = { broken: true };
    const mark: typeof markedHistory = (...args) => {
      const r = markedHistory(...args);
      return seam.broken ? { ...r, closedTrades: null as never } : r;
    };
    let entriesWhileBroken = -1;
    let h0: { worker: { book: { intents: Record<string, { intent: { purpose: string } }> } } } | null = null;
    const { h, decisions } = await run(true, 19022, undefined, mark, () => {
      entriesWhileBroken = Object.values(h0!.worker.book.intents).filter((i) => i.intent.purpose === 'entry').length;
      seam.broken = false;
    }, (x) => void (h0 = x));
    // While broken: refused as a risk fault, nothing booked, no step failed.
    expect(entriesWhileBroken).toBe(0);
    expect(decisions.some((l) => l.action === 'reject' && (l.gate_reasons ?? []).some((g) => g.code === 'risk_fault'))).toBe(true);
    expect(h.logs.some((l) => l.includes('Engine step failed'))).toBe(false);
    // It kept stepping: once risk can evaluate again, the coin is entered above q_min.
    const entries = Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'entry');
    expect(entries.length).toBeGreaterThan(0);
    expect(BigInt((entries[0]!.intent as { spend: bigint }).spend)).toBeGreaterThan(MIN_SPEND);
  }, 120_000);

  it('without the latch, the coin is entered at the minimum, as before', async () => {
    const { h, asked } = await run(false, 19014);
    const entries = Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'entry');
    expect(entries.length).toBeGreaterThan(0);
    expect(BigInt((entries[0]!.intent as { spend: bigint }).spend)).toBe(MIN_SPEND);
    expect(asked.every((s) => s === MIN_SPEND)).toBe(true);
  }, 120_000);
});
