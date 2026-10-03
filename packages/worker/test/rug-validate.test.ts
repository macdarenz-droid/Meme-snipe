// RUG-1c validation helpers: the launch analysis on real chain data, the minimum-peak test, the sweep and the misses.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG, type RugConfig } from '../../core/src/config/index.ts';
import { analyzeLaunch, analyzeSteps, collapses, collapsesSustained, misses, saleBuckets, sustainedPeak, sweep, type LaunchStep, type FullRpcTransaction, type LaunchReport } from '../src/research/rug-validate.ts';

type Tx = FullRpcTransaction & { readonly signature: string };
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rug-replay.json'), 'utf8')) as { cases: { name: string; mint: string; transactions: Tx[] }[] };
const RUG = FIXTURE.cases.find((c) => c.name === 'rug')!;

const report = (over: Partial<LaunchReport>): LaunchReport => ({
  mint: 'M', creator: 'D', createdAtMs: 0, supply: '1000000', transactions: 1, creatorDumpAtMs: null, deployerSoldBps: 0, levels: [],
  peak: '0', peakAtMs: null, peakVenue: null, peakExitCostBps: null, afterPeakBps: null, peakAtMigration: false, firstSaleBps: null, firstSaleAtMs: null, collapseAtMs: null,
  outsiderIn: '0', outsiderOut: '0', finalQuote: '0', executableLoss: '0', transferredBps: 0, transferSoldBps: 0, bundleBoughtBps: 0, bundleSoldBps: 0, ...over,
});
const lv = (atMs: number, level: number, peak: number) => ({ atMs, level: String(level), peak: String(peak) });

describe('launch analysis on the known rug', () => {
  it('finds the deployer dump at its time, the 5.06% sold, and the outsiders\' flows', () => {
    const r = analyzeLaunch(RUG.transactions.map((t) => ({ signature: t.signature, rpc: t })), RUG_CONFIG)!;
    expect(r).toMatchObject({ mint: RUG.mint, creator: 'GaMPRt9yhnhRAB134imiwkmXAtVYkcTtZFzF1nBeqw6H', transactions: RUG.transactions.length, deployerSoldBps: 505 });
    expect(r.creatorDumpAtMs).toBe(r.createdAtMs + 126_000);
    expect(BigInt(r.outsiderIn)).toBeGreaterThan(0n);
    expect(BigInt(r.executableLoss)).toBe(BigInt(r.outsiderIn) - BigInt(r.outsiderOut) - BigInt(r.finalQuote));
    expect(r.levels.length).toBeGreaterThan(0);
    const top = r.levels.reduce((a, l) => (BigInt(l.level) > BigInt(a.level) ? l : a));
    expect(r).toMatchObject({ peak: top.level, peakAtMs: top.atMs, peakVenue: 'curve' });
    expect(r.peakExitCostBps).not.toBeNull();
    expect(r.firstSaleBps).toBe(505);
    expect(r.firstSaleAtMs).toBe(r.creatorDumpAtMs);
    expect(r.peakAtMigration).toBe(false);
    const i = r.levels.indexOf(top);
    expect(r.afterPeakBps).toBe(i + 1 < r.levels.length ? Number((BigInt(r.levels[i + 1]!.level) * 10_000n) / BigInt(top.level)) : null);
  });

  it('a history without a create gives no report', () => {
    expect(analyzeLaunch(RUG.transactions.slice(1).map((t) => ({ signature: t.signature, rpc: t })), RUG_CONFIG)).toBeNull();
  });
});

describe('minimum peak, sweep and misses', () => {
  const CFG: RugConfig = { ...RUG_CONFIG, collapse: { ...RUG_CONFIG.collapse, windowMs: 10_000 } };
  it('collapses only from a peak at or above the minimum, inside the window', () => {
    const r = report({ levels: [lv(1, 100, 100), lv(2, 1, 100)] });
    expect(collapses(r, CFG, 100n)).toBe(true);
    expect(collapses(r, CFG, 101n)).toBe(false);
    expect(collapses(report({ levels: [lv(1, 100, 100), lv(2, 2, 100)] }), CFG, 0n)).toBe(false);
    expect(collapses(report({ levels: [lv(10_001, 0, 100)] }), CFG, 0n)).toBe(false);
    expect(collapses(report({ levels: [lv(10_000, 0, 100)] }), CFG, 0n)).toBe(true);
  });

  it('sustained reserve: a one-transaction spike does not count, a level held to the next trade does', () => {
    const spike = report({ levels: [lv(1, 10, 10), lv(2, 900, 900), lv(3, 5, 900)] });
    expect(sustainedPeak(spike)).toBe(10n);
    expect(collapsesSustained(spike, CFG, 500n)).toBe(false);
    expect(collapsesSustained(spike, CFG, 10n)).toBe(true);
    expect(collapsesSustained(spike, CFG, 11n)).toBe(false);
    const held = report({ levels: [lv(1, 900, 900), lv(2, 800, 900), lv(3, 5, 900)] });
    expect(sustainedPeak(held)).toBe(800n);
    expect(sustainedPeak(held, 1)).toBe(800n);
    expect(sustainedPeak(held, 0)).toBe(0n);
    expect(collapsesSustained(held, CFG, 800n)).toBe(true);
    expect(collapsesSustained(held, CFG, 801n)).toBe(false);
  });

  it('scores labels against the loss outcome: precision and recall per minimum peak', () => {
    const rs = [
      report({ mint: 'A', levels: [lv(1, 0, 50)], executableLoss: '5' }),
      report({ mint: 'B', levels: [lv(1, 0, 500)], executableLoss: '0' }),
      report({ mint: 'C', creatorDumpAtMs: 1, executableLoss: '9' }),
      report({ mint: 'D', executableLoss: '7' }),
    ];
    expect(sweep(rs, CFG, [0n, 100n], 5n)).toEqual([
      { minPeak: '0', labelled: 3, truePositive: 2, falsePositive: 1, falseNegative: 1, precision: 2 / 3, recall: 2 / 3 },
      { minPeak: '100', labelled: 2, truePositive: 1, falsePositive: 1, falseNegative: 2, precision: 1 / 2, recall: 1 / 3 },
    ]);
    expect(sweep([], CFG, [0n], 1n)).toEqual([{ minPeak: '0', labelled: 0, truePositive: 0, falsePositive: 0, falseNegative: 0, precision: null, recall: null }]);
  });

  it('groups launches by the deployer\'s first sale and counts collapses after it', () => {
    const rs = [
      report({ mint: 'A', firstSaleBps: 10, firstSaleAtMs: 5, collapseAtMs: 9, executableLoss: '3' }),
      report({ mint: 'B', firstSaleBps: 49, firstSaleAtMs: 5, collapseAtMs: 4, executableLoss: '1' }),
      report({ mint: 'C', firstSaleBps: 50, firstSaleAtMs: 2, collapseAtMs: 2, executableLoss: '7' }),
      report({ mint: 'D', executableLoss: '0' }),
    ];
    expect(saleBuckets(rs)).toEqual([
      { group: '0+', launches: 2, collapsedAfterSale: 1, medianLoss: '1' },
      { group: '50+', launches: 1, collapsedAfterSale: 1, medianLoss: '7' },
      { group: 'none', launches: 1, collapsedAfterSale: 0, medianLoss: '0' },
    ]);
  });

  it('counts transfer-then-sell and creation-slot dumps rugs-1 does not label, at the dump share', () => {
    const rs = [
      report({ mint: 'T', transferSoldBps: 200 }), report({ mint: 'U', transferSoldBps: 199 }),
      report({ mint: 'B', bundleSoldBps: 200 }), report({ mint: 'C', bundleSoldBps: 199 }), report({ mint: 'L', creatorDumpAtMs: 1, transferSoldBps: 900, bundleSoldBps: 900 }),
    ];
    expect(misses(rs, CFG)).toEqual({ launches: 5, unlabelled: 4, transferThenSell: ['T'], bundleDump: ['B'], anyTransferThenSell: ['T', 'L'], anyBundleDump: ['B', 'L'] });
  });
});

describe('launch analysis on decoded steps', () => {
  const M = 'Mint11111111111111111111111111111111111111';
  const D = 'Dev111111111111111111111111111111111111111';
  const BC = 'Curve1111111111111111111111111111111111111';
  const P = 'Pool111111111111111111111111111111111111111';
  const T0 = 1_790_000_000;
  const CFG: RugConfig = { ...RUG_CONFIG, creatorDump: { supplyBps: 200, windowMs: 100_000 }, collapse: { ...RUG_CONFIG.collapse, windowMs: 100_000 } };
  let n = 0;
  type Ev = { program: string; name: string; data: Record<string, unknown> };
  const step = (slot: number, dt: number, events: Ev[], o: { err?: unknown; pre?: [string, number][]; post?: [string, number][] } = {}): LaunchStep => ({
    slot: BigInt(slot), blockTime: T0 + dt, err: o.err ?? null, events,
    market: events.map((e) => ({ kind: 'market' as const, id: `e${++n}`, moment: { slot: BigInt(slot), txIndex: n, ixIndex: 0, receivedAt: (T0 + dt) * 1_000 }, key: `${e.program}:${e.name}:x`, value: { event: e } })),
    preTokenBalances: (o.pre ?? []).map(([owner, amount]) => ({ mint: M, owner, uiTokenAmount: { amount: String(amount) } })),
    postTokenBalances: (o.post ?? []).map(([owner, amount]) => ({ mint: M, owner, uiTokenAmount: { amount: String(amount) } })),
  });
  const trade = (dt: number, user: string, isBuy: boolean, tokens: number, sol: number, real: number): Ev =>
    ({ program: 'pump', name: 'TradeEvent', data: { mint: M, user, isBuy, tokenAmount: BigInt(tokens), solAmount: BigInt(sol), realSolReserves: BigInt(real), virtualSolReserves: BigInt(real + 30), virtualTokenReserves: 1_000_000n, timestamp: BigInt(T0 + dt) } });
  const createEv: Ev = { program: 'pump', name: 'CreateEvent', data: { mint: M, creator: D, user: D, bondingCurve: BC, tokenTotalSupply: 1_000_000n, timestamp: BigInt(T0) } };

  const history = (): LaunchStep[] => [
    step(9, -1, [trade(-1, 'Early', true, 1, 999, 1)]), // before the create: not read
    step(10, 0, [createEv, trade(0, D, true, 500_000, 40, 40), trade(0, 'Bundle', true, 100_000, 10, 50)]),
    step(11, 1, [trade(1, 'Out', true, 50_000, 100, 150)]),
    step(12, 2, [trade(2, 'Out', true, 1, 5_000, 5_150)], { err: { failed: true } }), // failed: not read
    // The deployer moves 100,000 tokens to R (no sale), R sells 30,000, the bundle sells 40,000.
    // X's balance falls in the same transaction: X is not a recipient, so its later sale is not counted as one.
    step(13, 3, [], { pre: [[D, 500_000], [BC, 1], ['X', 10_000]], post: [[D, 400_000], ['R', 100_000], [BC, 2], ['X', 0]] }),
    step(14, 4, [trade(4, 'R', false, 30_000, 20, 130), trade(4, 'Bundle', false, 40_000, 25, 105), trade(4, 'X', false, 10_000, 5, 105)]),
    // The deployer sells 25,000 (2.5%): the dump; its own balance falls by the sale only.
    step(15, 5, [trade(5, D, false, 25_000, 15, 90)], { pre: [[D, 400_000]], post: [[D, 375_000]] }),
    step(16, 6, [trade(6, 'Out', false, 50_000, 60, 0)]),
    step(17, 200, [trade(200, 'Late', true, 1, 777, 777)]), // after the window: stops
  ];

  it('reads flows, transfers, the bundle, the first sale and the collapse, inside the window only', () => {
    const r = analyzeSteps(history(), CFG)!;
    expect(r).toMatchObject({
      mint: M, creator: D, createdAtMs: T0 * 1_000, supply: '1000000', transactions: 6,
      creatorDumpAtMs: (T0 + 5) * 1_000, deployerSoldBps: 250, firstSaleBps: 250, firstSaleAtMs: (T0 + 5) * 1_000,
      outsiderIn: '110', outsiderOut: '110', finalQuote: '0', executableLoss: '0',
      transferredBps: 1_000, transferSoldBps: 300, bundleBoughtBps: 1_000, bundleSoldBps: 400,
      peak: '150', peakAtMs: (T0 + 1) * 1_000, peakVenue: 'curve', peakAtMigration: false, collapseAtMs: (T0 + 6) * 1_000,
    });
    expect(r.afterPeakBps).toBe(8_666);
  });

  it('a first sale under the dump share is recorded, and a dump past the window is not', () => {
    const small = [step(10, 0, [createEv, trade(0, D, true, 500_000, 40, 40)]), step(11, 1, [trade(1, D, false, 10_000, 1, 39)]), step(12, 150, [trade(150, D, false, 90_000, 1, 38)])];
    const wide = { ...CFG, collapse: { ...CFG.collapse, windowMs: 200_000 } };
    const r = analyzeSteps(small, wide)!;
    expect(r).toMatchObject({ firstSaleBps: 100, firstSaleAtMs: (T0 + 1) * 1_000, creatorDumpAtMs: null, deployerSoldBps: 1_000 });
    const exact = analyzeSteps([step(10, 0, [createEv, trade(0, D, true, 500_000, 40, 40)]), step(11, 1, [trade(1, D, false, 20_000, 1, 39)])], CFG)!;
    expect(exact.creatorDumpAtMs).toBe((T0 + 1) * 1_000);
    const under = analyzeSteps([step(10, 0, [createEv, trade(0, D, true, 500_000, 40, 40)]), step(11, 1, [trade(1, D, false, 19_999, 1, 39)])], CFG)!;
    expect(under.creatorDumpAtMs).toBeNull();
  });

  it('marks a peak that is the first pool level after migration', () => {
    const pool = (dt: number, vault: number): Ev => ({ program: 'pump_amm', name: 'BuyEvent', data: { pool: P, user: 'Out', poolQuoteTokenReserves: BigInt(vault), virtualQuoteReserves: 0n, poolBaseTokenReserves: 1_000n, baseAmountOut: 1n, userQuoteAmountIn: 1n, timestamp: BigInt(T0 + dt) } });
    const r = analyzeSteps([
      step(10, 0, [createEv, trade(0, 'Out', true, 1, 1, 50)]),
      step(11, 1, [{ program: 'pump', name: 'CompletePumpAmmMigrationEvent', data: { mint: M, pool: P, timestamp: BigInt(T0 + 1) } }]),
      step(12, 2, [pool(2, 900)]), step(13, 3, [pool(3, 800)]),
    ], CFG)!;
    expect(r).toMatchObject({ peak: '900', peakVenue: 'pool', peakAtMigration: true, outsiderIn: '3' });
    const later = analyzeSteps([
      step(10, 0, [createEv, trade(0, 'Out', true, 1, 1, 50)]),
      step(11, 1, [{ program: 'pump', name: 'CompletePumpAmmMigrationEvent', data: { mint: M, pool: P, timestamp: BigInt(T0 + 1) } }]),
      step(12, 2, [pool(2, 800)]), step(13, 3, [pool(3, 900)]),
    ], CFG)!;
    expect(later.peakAtMigration).toBe(false);
  });

  it('only the first create counts, and a history without one gives nothing', () => {
    const other: Ev = { program: 'pump', name: 'CreateEvent', data: { ...createEv.data, mint: 'Other' } };
    expect(analyzeSteps([step(10, 0, [createEv]), step(11, 1, [other])], CFG)!.mint).toBe(M);
    expect(analyzeSteps([step(11, 1, [trade(1, 'Out', true, 1, 1, 1)])], CFG)).toBeNull();
  });
});

describe('what rugs-1 misses, on real launches (fixtures/rug-misses.json)', () => {
  const MISSES = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rug-misses.json'), 'utf8')) as { cases: { name: string; mint: string; transactions: Tx[] }[] };
  const txsOf = (name: string) => MISSES.cases.find((c) => c.name === name)!.transactions.map((t) => ({ signature: t.signature, rpc: t }));

  it('transfer-then-sell: the deployer moved 7.44% to other wallets that sold it all, and none of it is a deployer sale', () => {
    const r = analyzeLaunch(txsOf('transfer-then-sell'), RUG_CONFIG)!;
    expect(r).toMatchObject({ mint: '5wBy5RdjRzdKdkdcyZ3fhBUhrEd9HS8PREkomhdZX2s2', transferredBps: 744, transferSoldBps: 744, deployerSoldBps: 0, creatorDumpAtMs: null });
  });

  it('bundle dump: creation-slot buyers bought and sold 4.58% while the deployer sold nothing; no deployer-sale label', () => {
    const r = analyzeLaunch(txsOf('bundle-dump'), RUG_CONFIG)!;
    expect(r).toMatchObject({ mint: 'BH5poyjNJp2r9ktMC8XTLH3gcAteQKMjnQQmKKTapaid', bundleBoughtBps: 458, bundleSoldBps: 458, deployerSoldBps: 0, creatorDumpAtMs: null, firstSaleBps: null });
  });
});
