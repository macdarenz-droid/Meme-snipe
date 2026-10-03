// RUG-1c: judging one prior mint as of a moment, and reading a deployer check fact.
import { describe, expect, it } from 'vitest';
import type { MarketEvent, Moment } from '../../src/engine/index.ts';
import { RUG_CHECK_CONFIG, rugCheckConfigIssues, type RugConfig } from '../../src/config/index.ts';
import { MintJudge, deployerCheckCovers, parseRugCheck, type MintStatus, type RugCheckFact } from '../../src/gates/index.ts';

const DEV = 'Dev1111111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const T0 = 1_790_000_000n;
const CFG: RugConfig = { version: 'rugs-test', creatorDump: { supplyBps: 200, windowMs: 10_000 }, collapse: { dropBps: 9_900, windowMs: 10_000, minPeakLamports: 0 }, materiality: { referenceLamports: 1_000, maxExitCostBps: 1_000 } };

let n = 0;
const ev = (name: string, data: Record<string, unknown>, slot: bigint): MarketEvent =>
  ({ kind: 'market', id: `e${++n}`, moment: { slot, txIndex: 0, ixIndex: n, receivedAt: Number(data['timestamp']) * 1_000 }, key: `pump:${name}:${MINT}`, value: { event: { program: 'pump', name, data } } });
const create = (supply: bigint | null = 1_000_000n) => ev('CreateEvent', { mint: MINT, creator: DEV, user: DEV, timestamp: T0, ...(supply === null ? {} : { tokenTotalSupply: supply }) }, 100n);
const dump = (slot: bigint, ts = T0 + 2n) => ev('TradeEvent', { mint: MINT, user: DEV, isBuy: false, tokenAmount: 900_000n, solAmount: 1n, realSolReserves: 5n, virtualSolReserves: 1n, virtualTokenReserves: 1n, timestamp: ts }, slot);
const asOf = (slot: bigint): Moment => ({ slot, txIndex: 0, ixIndex: 0, receivedAt: 0 });
const T0MS = Number(T0) * 1_000;

const judge = (events: readonly MarketEvent[], at: Moment, asOfMs: number) => {
  const j = new MintJudge(CFG, MINT, T0MS, at);
  for (const e of events) j.observe(e);
  return j.result(asOfMs);
};

describe('MintJudge', () => {
  it('a dump at or before the as-of moment is a rug; one after it is not seen', () => {
    expect(judge([create(), dump(105n)], asOf(106n), T0MS + 3_000)).toMatchObject({ status: 'rug', label: { rule: 'creator-dump', creator: DEV } });
    expect(judge([create(), dump(105n)], asOf(104n), T0MS + 3_000)).toMatchObject({ status: 'open' });
  });

  it('an event at exactly the as-of moment counts', () => {
    const d = dump(105n);
    expect(judge([create(), d], d.moment, T0MS + 3_000).status).toBe('rug');
  });

  it('a mint it cannot judge is decided at its create', () => {
    const j = new MintJudge(CFG, MINT, T0MS, asOf(200n));
    expect(j.observe(create(null))).toBe(true);
  });

  it('stops at the first label', () => {
    const j = new MintJudge(CFG, MINT, T0MS, asOf(200n));
    expect(j.observe(create())).toBe(false);
    expect(j.observe(dump(105n))).toBe(true);
    expect(j.decided).toBe(true);
  });

  it('no label: open while a window can still close after the as-of time, clear once both ended before it', () => {
    const end = T0MS + 10_000;
    expect(judge([create()], asOf(200n), end).status).toBe('open');
    expect(judge([create()], asOf(200n), end + 1).status).toBe('clear');
    const wide: RugConfig = { ...CFG, collapse: { ...CFG.collapse, windowMs: 20_000 } };
    const j = new MintJudge(wide, MINT, T0MS, asOf(200n));
    j.observe(create());
    expect(j.result(end + 1).status).toBe('open');
    expect(j.result(T0MS + 20_001).status).toBe('clear');
  });

  it('history without the create is unfetched; a create without supply is unjudged', () => {
    expect(judge([dump(105n)], asOf(200n), T0MS + 99_000)).toMatchObject({ status: 'unfetched', detail: 'the history read holds no create of this mint' });
    expect(judge([create(null), dump(105n)], asOf(200n), T0MS + 99_000)).toMatchObject({ status: 'unjudged', detail: 'the create carries no total supply' });
  });

  it('labels of another mint in the same history are not this mint\'s', () => {
    const other = ev('CreateEvent', { mint: 'Other', creator: DEV, user: DEV, timestamp: T0, tokenTotalSupply: 1_000_000n }, 100n);
    const otherDump = ev('TradeEvent', { mint: 'Other', user: DEV, isBuy: false, tokenAmount: 900_000n, solAmount: 1n, realSolReserves: 5n, virtualSolReserves: 1n, virtualTokenReserves: 1n, timestamp: T0 + 1n }, 101n);
    expect(judge([create(), other, otherDump], asOf(200n), T0MS + 3_000).status).toBe('open');
  });
});

describe('deployerCheckCovers', () => {
  const f = (slot: bigint, mints: RugCheckFact['mints'] = []): RugCheckFact => ({
    obs: { provider: 'rug-check', slot, receivedAt: 0, quality: [], commitment: 'confirmed' }, creator: DEV, version: 'v', fromMs: 0, asOfMs: 0, mints, credits: 0,
  });
  const cfg = { version: 'v', creditCapPerCandidate: 1, maxLagSlots: 5 };
  it('refuses a check dated after now, by even one slot', () => {
    expect(deployerCheckCovers(f(101n), DEV, [], 0, asOf(100n), cfg)).toEqual({ covered: false, detail: 'the check is dated after now (slot 101)' });
    expect(deployerCheckCovers(f(100n), DEV, [], 0, asOf(100n), cfg)).toEqual({ covered: true, rugs: [] });
  });
  it('counts only rugs as rugs', () => {
    const m = (mint: string, status: MintStatus) => ({ mint, createdAtMs: 0, status, detail: '' });
    const lab = { mint: 'D', creator: DEV, rule: 'creator-dump' as const, evidence: 'observed' as const, atMs: 0, slot: 1n, version: 'v', detail: '', venue: 'curve' as const, amounts: { sold: 1n, supply: 1n } };
    expect(deployerCheckCovers(f(100n, [m('A', 'rug'), m('B', 'open'), m('C', 'clear'), { ...m('D', 'rug'), label: lab }]), DEV, ['A', 'B', 'C', 'D'], 0, asOf(100n), cfg))
      .toEqual({ covered: true, rugs: [{ mint: 'A' }, { mint: 'D', kind: 'creator-dump' }] });
  });
});

describe('check fact and config', () => {
  const fact: RugCheckFact = {
    obs: { provider: 'rug-check', slot: 5n, receivedAt: 1, quality: [], commitment: 'confirmed' },
    creator: DEV, version: 'rug-check-1', fromMs: 0, asOfMs: 1, mints: [{ mint: MINT, createdAtMs: 0, status: 'clear', detail: '' }], credits: 3,
  };

  it('reads a fact plain or wrapped by the feed, and refuses other shapes', () => {
    expect(parseRugCheck(fact)).toBe(fact);
    expect(parseRugCheck({ value: fact, source: 'worker', seq: 1 })).toBe(fact);
    for (const bad of [null, { ...fact, obs: { ...fact.obs, slot: null } }, { ...fact, obs: { ...fact.obs, commitment: 'processed' } }, { ...fact, credits: 1.5 },
      { ...fact, mints: [{ mint: MINT, createdAtMs: 0, status: 'maybe' }] }, { ...fact, mints: [null] }, { ...fact, creator: 1 }, { ...fact, fromMs: '0' }]) {
      expect(parseRugCheck(bad)).toBeNull();
    }
  });

  it('the shipped check config is valid; bad values are refused', () => {
    expect(rugCheckConfigIssues(RUG_CHECK_CONFIG)).toEqual([]);
    // Changing a value needs a new version and a DECISIONS entry (docs/DECISIONS.md "Rug labels").
    expect(RUG_CHECK_CONFIG).toEqual({ version: 'rug-check-1', creditCapPerCandidate: 500, maxLagSlots: 300 });
    expect(rugCheckConfigIssues({ version: '', creditCapPerCandidate: 0, maxLagSlots: -1 })).toHaveLength(3);
    expect(rugCheckConfigIssues({ version: 'v', creditCapPerCandidate: 1, maxLagSlots: 0 })).toEqual([]);
    expect(rugCheckConfigIssues({ version: 'v', creditCapPerCandidate: 1.5, maxLagSlots: 0.5 })).toHaveLength(2);
  });
});
