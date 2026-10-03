// BT-2 fact projector: historical gate facts as of each check moment, creates for the deployer index, rug coverage
// and unjudged mints outside the sample.
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { isCanonicalPool, type Pool, TOKEN_2022_PROGRAM, toAddress } from '../../core/src/chain/index.ts';
import type { FeedEvent, MarketEvent } from '../../core/src/engine/index.ts';
import {
  coverageKeys, createKey, holdersKey, insidersKey, lpKey, migrationKey, mintKey, parseCandles, parseCreate, parseHolders, parseInsiders, parseLp,
  parseMigration, parseMint, parsePool, parseSolUsd, poolKey, RUG_UNJUDGED_PREFIX, SOL_USD_KEY, TX_CREATE_PREFIX, candlesKey,
} from '../../core/src/gates/index.ts';
import { seriesReleases } from '../src/dataset/offchain.ts';
import { FactProjector, mintHashFraction } from '../src/sim/facts.ts';
import { Market, rowMoment } from '../src/sim/market.ts';
import { SOL_USD } from './synthetic.ts';
import { SLOT_MS, studyWorld, SUPPLY, W0, type MintPlan } from './study-world.ts';

const MIN = 60_000 / SLOT_MS;
const U2 = { universe: 'U2', fromMs: 60 * 60_000, toMs: 70 * 60_000, everyMs: 5 * 60_000, minQuoteLamports: 0n };

const solUsd = { ...SOL_USD, bars: SOL_USD.bars.map((b, k) => ({ ...b, start: W0 - 6 * 3_600_000 + k * 3_600_000 })) };

const replay = (plans: readonly MintPlan[], slots: number, sampleRate: number | null = 1) => {
  const { rows, mints } = studyWorld({ mints: plans, slots });
  const facts = new FactProjector({
    sampleRate, rugs: RUG_CONFIG, windows: [U2], solUsd: seriesReleases(solUsd), solUsdPoints: 30, candlesHead: 10, candlesTail: 360,
  });
  const market = new Market({ heartbeatBlocks: 1_000_000, discoveryLag: () => 1, active: () => false, schedule: () => {}, facts });
  const events: FeedEvent[] = [];
  for (const r of rows) {
    const out = market.release(r);
    for (const e of out) expect(e.moment).toEqual(rowMoment(r));
    events.push(...out);
  }
  return { events: events.filter((e): e is MarketEvent => e.kind === 'market'), mints, facts };
};

const PLAN: MintPlan = { label: 'good', createSlot: 10, graduateAfter: 20 * MIN };
const SLOTS = 10 + 20 * MIN + 72 * MIN;

describe('fact projector', () => {
  const { events, mints } = replay([PLAN], SLOTS);
  const m = mints[0]!;
  const checks = events.filter((e) => e.key === `check:${m.mint}`);
  const at = (key: string, check: MarketEvent) => events.filter((e) => e.key === key && e.moment.slot === check.moment.slot).at(-1)?.value;

  it('checks a graduate inside its window, at the set cadence, never outside it', () => {
    expect(checks.map((c) => (c.value as { n: number }).n)).toEqual([1, 2, 3]);
    for (const c of checks) {
      const since = c.moment.receivedAt - (W0 + m.migrateSlot * SLOT_MS);
      expect(since).toBeGreaterThanOrEqual(U2.fromMs - 1000);
      expect(since).toBeLessThanOrEqual(U2.toMs);
      expect(typeof (c.value as { blockHeight: unknown }).blockHeight).toBe('bigint');
    }
  });

  it('builds every gate fact in the shape the gates read, as of the check', () => {
    const c = checks[0]!;
    const mint = parseMint(at(mintKey(m.mint), c))!;
    expect(mint.owner).toBe(TOKEN_2022_PROGRAM);
    expect(mint.account).toMatchObject({ mintAuthority: null, freezeAuthority: null, supply: SUPPLY });
    expect(mint.account!.extensions.map((e) => e.kind)).toEqual(['MetadataPointer', 'TokenMetadata']);
    const pool = parsePool(at(poolKey(m.mint), c))!;
    expect(pool.address).toBe(m.pool);
    expect(isCanonicalPool(pool.pool as unknown as Pool, toAddress(m.pool))).toBe(true);
    expect(pool.pool.isMayhemMode).toBe(false);
    expect(parseLp(at(lpKey(m.mint), c))).toMatchObject({ lpMint: m.lpMint, supply: 0n });
    expect(parseCreate(at(createKey(m.mint), c))!.creator).toBe(m.creator);
    const mig = parseMigration(at(migrationKey(m.mint), c))!;
    expect(mig.migratedAtMs).toBe(Math.floor((W0 + m.migrateSlot * SLOT_MS) / 1000) * 1000);
    const holders = parseHolders(at(holdersKey(m.mint), c))!;
    expect(holders.obs.quality).toEqual([]);
    expect(holders.accounts.reduce((t, a) => t + a.amount, 0n)).toBe(SUPPLY);
    const candles = parseCandles(at(candlesKey(m.mint), c))!;
    expect(candles.candles.length).toBeGreaterThan(0);
    expect(candles.candles.every((k) => k.startMs <= c.moment.receivedAt)).toBe(true);
    expect(parseInsiders(at(insidersKey(m.mint), c))!.complete).toBe(false);
    const sol = parseSolUsd(at(SOL_USD_KEY, c))!;
    expect(sol.points.every((p) => p.tMs <= c.moment.receivedAt + 3_600_000)).toBe(true);
    // Every state fact is observed at the check's own slot: fresh by construction, never from a later row.
    for (const key of [mintKey(m.mint), poolKey(m.mint), holdersKey(m.mint), candlesKey(m.mint)]) {
      expect((at(key, c) as { obs: { slot: bigint } }).obs.slot).toBe(c.moment.slot);
    }
    expect(TRIAL_POLICY.gates.maxStateSlotLag).toBeGreaterThanOrEqual(0);
  });

  it('sends every create to the deployer index and starts creates and rug coverage at the first row', () => {
    expect(events.filter((e) => e.key === `${TX_CREATE_PREFIX}${m.mint}`)).toHaveLength(1);
    for (const stream of ['creates', 'rugs']) expect(events.filter((e) => e.key === coverageKeys(stream).start)).toHaveLength(1);
  });

  it('marks a create outside the sample unjudged, and keeps no state for it', () => {
    const r = replay([PLAN], 20, 0);
    const u = r.events.filter((e) => e.key === `${RUG_UNJUDGED_PREFIX}${r.mints[0]!.mint}`);
    expect(u).toHaveLength(1);
    expect((u[0]!.value as { reason: string }).reason).toMatch(/outside the dataset sample/);
    expect(r.facts.state(r.mints[0]!.mint)).toBeUndefined();
  });

  it('follows the scanner hash for the sample', () => {
    const h = mintHashFraction(m.mint)!;
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(1);
    expect(mintHashFraction('not-an-address')).toBeNull();
  });

  it('flags holders and the mint partial after a missed token movement', () => {
    const r = replay([{ ...PLAN, dropBalancesAfter: 30 * MIN }], SLOTS);
    const c = r.events.filter((e) => e.key === `check:${r.mints[0]!.mint}`)[0]!;
    const h = r.events.filter((e) => e.key === holdersKey(r.mints[0]!.mint) && e.moment.slot === c.moment.slot).at(-1)!;
    expect(parseHolders(h.value)!.obs.quality).toEqual(['partial']);
    expect(r.facts.state(r.mints[0]!.mint)!.holderProblem).toMatch(/held .* before/);
  });

  it('leaves out the mint fact when the create was not recorded', () => {
    const r = replay([{ ...PLAN, noCreateRaw: true }], SLOTS);
    const mint = r.mints[0]!.mint;
    expect(r.events.some((e) => e.key === mintKey(mint))).toBe(false);
    expect(r.events.some((e) => e.key === holdersKey(mint))).toBe(false);
  });
});
