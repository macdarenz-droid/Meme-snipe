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
import { FactProjector, type FactOptions, mintHashFraction, tieHash } from '../src/sim/facts.ts';
import { Market, rowMoment } from '../src/sim/market.ts';
import { SOL_USD } from './synthetic.ts';
import { SLOT_MS, studyWorld, SUPPLY, W0, type MintPlan } from './study-world.ts';

const MIN = 60_000 / SLOT_MS;
const U2 = { universe: 'U2', fromMs: 60 * 60_000, toMs: 70 * 60_000, everyMs: 5 * 60_000, minQuoteLamports: 0n };

const solUsd = { ...SOL_USD, bars: SOL_USD.bars.map((b, k) => ({ ...b, start: W0 - 6 * 3_600_000 + k * 3_600_000 })) };

const replay = (plans: readonly MintPlan[], slots: number, sampleRate: number | null = 1, tradesFromMs?: number, tieSalt = 'test-salt', poolAccounts?: FactOptions['poolAccounts'], delegatesComplete = true) => {
  const { rows, mints } = studyWorld({ mints: plans, slots });
  const facts = new FactProjector({
    sampleRate, rugs: RUG_CONFIG, windows: [U2], solUsd: seriesReleases(solUsd), solUsdPoints: 30, candlesHead: 10, candlesTail: 360, tieSalt, delegatesComplete,
    ...(tradesFromMs === undefined ? {} : { tradesFromMs }), ...(poolAccounts === undefined ? {} : { poolAccounts }),
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

  it('in an assembled window, a launch from a lead-in day keeps its create but is unjudged, and rug coverage starts with the trades', () => {
    const from = W0 + 5 * 60_000;
    const r = replay([PLAN], SLOTS, 1, from);
    const mint = r.mints[0]!.mint;
    const u = r.events.filter((e) => e.key === `${RUG_UNJUDGED_PREFIX}${mint}`);
    expect((u[0]!.value as { reason: string }).reason).toMatch(/lead-in day/);
    const start = r.events.find((e) => e.key === coverageKeys('rugs').start)!;
    expect(start.moment.receivedAt).toBeGreaterThanOrEqual(from);
    expect(r.events.some((e) => e.key === createKey(mint))).toBe(true);
  });

  it('follows the scanner hash for the sample', () => {
    const h = mintHashFraction(m.mint)!;
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(1);
    expect(mintHashFraction('not-an-address')).toBeNull();
  });

  it('carries a delegate approved on a token account into the holder read (GATE-1e)', () => {
    const r = replay([{ ...PLAN, devBuyBps: 300, devDelegate: 1_000n }], SLOTS);
    const c = r.events.find((e) => e.key.startsWith('check:'))!;
    const holders = parseHolders(r.events.filter((e) => e.key === holdersKey(r.mints[0]!.mint) && e.moment.slot === c.moment.slot).at(-1)?.value)!;
    const delegated = holders.accounts.filter((a) => a.delegate !== null);
    expect(delegated).toHaveLength(1);
    expect(delegated[0]!.delegatedAmount).toBe(1_000n);
    expect(delegated[0]!.owner).toBe(r.mints[0]!.creator);
    expect(holders.accounts.filter((a) => a.delegate === null).every((a) => a.delegatedAmount === 0n)).toBe(true);
  });

  it('adds the pool account record (H17) only as of the moment it is known; without it the fields stay absent', () => {
    const poolOf = (r: ReturnType<typeof replay>) => {
      const c = r.events.find((e) => e.key.startsWith('check:'))!;
      return parsePool(r.events.filter((e) => e.key === poolKey(r.mints[0]!.mint) && e.moment.slot === c.moment.slot).at(-1)?.value)!;
    };
    const none = poolOf(replay([PLAN], SLOTS));
    expect(none.accountBytes).toBeUndefined();
    expect(none.pool.isCashbackCoin).toBeUndefined();
    const rec = { knownAtMs: 0, accountBytes: 300, isCashbackCoin: false, coinCreator: 'C' };
    const known = poolOf(replay([PLAN], SLOTS, 1, undefined, 'test-salt', () => rec));
    expect(known).toMatchObject({ accountBytes: 300, pool: { isCashbackCoin: false, coinCreator: 'C' } });
    const late = poolOf(replay([PLAN], SLOTS, 1, undefined, 'test-salt', () => ({ ...rec, knownAtMs: Number.MAX_SAFE_INTEGER })));
    expect(late.accountBytes).toBeUndefined();
    expect(late.pool.isCashbackCoin).toBeUndefined();
  });

  it('marks every holder read partial while the dataset may miss approvals (the permissive direction)', () => {
    const r = replay([PLAN], SLOTS, 1, undefined, 'test-salt', undefined, false);
    const c = r.events.find((e) => e.key.startsWith('check:'))!;
    const h = parseHolders(r.events.filter((e) => e.key === holdersKey(r.mints[0]!.mint) && e.moment.slot === c.moment.slot).at(-1)?.value)!;
    expect(h.obs.quality).toEqual(['partial']);
    // The mint read is unaffected.
    const mint = parseMint(r.events.filter((e) => e.key === mintKey(r.mints[0]!.mint) && e.moment.slot === c.moment.slot).at(-1)?.value)!;
    expect(mint.obs.quality).toEqual([]);
  });

  it('flags holders and the mint partial after a missed token movement', () => {
    const r = replay([{ ...PLAN, dropBalancesAfter: 30 * MIN }], SLOTS);
    const c = r.events.filter((e) => e.key === `check:${r.mints[0]!.mint}`)[0]!;
    const h = r.events.filter((e) => e.key === holdersKey(r.mints[0]!.mint) && e.moment.slot === c.moment.slot).at(-1)!;
    expect(parseHolders(h.value)!.obs.quality).toEqual(['partial']);
    expect(r.facts.state(r.mints[0]!.mint)!.holderProblem).toMatch(/held .* before/);
  });

  it('releases a pool\'s first trade event since migration and every event with a tail, for H5', () => {
    expect(events.filter((e) => e.key.startsWith(`pump_amm:`) && e.key.endsWith(m.pool))).toHaveLength(1);
    const r = replay([{ ...PLAN, tail: { after: 30 * MIN, hex: '0100000000000000' } }], SLOTS);
    const tails = r.events.filter((e) => e.key.startsWith('pump_amm:'));
    expect(tails).toHaveLength(2);
    expect(tails[1]!.value).toMatchObject({ event: { trailing: 8, extra: '0100000000000000' } });
    expect(typeof (tails[1]!.value as { txSlot: unknown }).txSlot).toBe('bigint');
  });

  it('releases checks due at one block in salted-hash order, so a fixed salt decides true ties', () => {
    const plans: MintPlan[] = ['a', 'b', 'c', 'd'].map((label) => ({ ...PLAN, label }));
    const firstBlock = (salt: string) => {
      const checks = replay(plans, SLOTS, 1, undefined, salt).events.filter((e) => e.key.startsWith('check:'));
      const at = checks[0]!.moment.slot;
      return checks.filter((e) => e.moment.slot === at).map((e) => (e.value as { mint: string }).mint);
    };
    for (const salt of ['test-salt', 'other-salt']) {
      const order = firstBlock(salt);
      expect(order).toHaveLength(4);
      expect(order).toEqual([...order].sort((x, y) => (tieHash(salt, 'U2', x) < tieHash(salt, 'U2', y) ? -1 : 1)));
    }
    // The same salt always gives the same order.
    expect(firstBlock('test-salt')).toEqual(firstBlock('test-salt'));
  });

  it('drops a launch that never graduates after a week, and a graduate past every window', () => {
    const { rows, mints } = studyWorld({ mints: [{ ...PLAN, graduateAfter: 10 ** 9 }, PLAN], slots: SLOTS });
    const facts = new FactProjector({ sampleRate: 1, rugs: RUG_CONFIG, windows: [U2], solUsd: [], solUsdPoints: 30, candlesHead: 10, candlesTail: 360, tieSalt: 'test-salt' });
    const market = new Market({ heartbeatBlocks: 1_000_000, discoveryLag: () => 1, active: () => false, schedule: () => {}, facts });
    for (const r of rows) market.release(r);
    expect(facts.state(mints[0]!.mint)).toBeDefined();
    const last = rows[rows.length - 1]!;
    for (let h = 1; h <= 8 * 24; h++) {
      const slot = last.slot + BigInt(h * 9000);
      market.release({ kind: 'block', slot, blockTime: last.blockTime + h * 3600, parentSlot: slot - 1n });
    }
    expect(facts.state(mints[0]!.mint)).toBeUndefined();
    expect(facts.state(mints[1]!.mint)).toBeUndefined();
    expect(facts.tracked).toBe(0);
  });

  it('leaves out the mint fact when the create was not recorded', () => {
    const r = replay([{ ...PLAN, noCreateRaw: true }], SLOTS);
    const mint = r.mints[0]!.mint;
    expect(r.events.some((e) => e.key === mintKey(mint))).toBe(false);
    expect(r.events.some((e) => e.key === holdersKey(mint))).toBe(false);
  });
});
