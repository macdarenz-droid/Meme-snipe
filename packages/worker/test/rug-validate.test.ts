// RUG-1c validation helpers: the launch analysis on real chain data, the minimum-peak test, the sweep and the misses.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG, type RugConfig } from '../../core/src/config/index.ts';
import { analyzeLaunch, collapses, collapsesSustained, misses, saleBuckets, sustainedPeak, sweep, type FullRpcTransaction, type LaunchReport } from '../src/research/rug-validate.ts';

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
      report({ mint: 'C', firstSaleBps: 50, firstSaleAtMs: 1, collapseAtMs: 2, executableLoss: '7' }),
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
      report({ mint: 'B', bundleSoldBps: 300 }), report({ mint: 'L', creatorDumpAtMs: 1, transferSoldBps: 900, bundleSoldBps: 900 }),
    ];
    expect(misses(rs, CFG)).toEqual({ launches: 4, unlabelled: 3, transferThenSell: ['T'], bundleDump: ['B'], anyTransferThenSell: ['T', 'L'], anyBundleDump: ['B', 'L'] });
  });
});
