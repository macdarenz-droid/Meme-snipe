// A-M01-02 fee-schedule selection and the venue config cache (card Z07). Each acceptance criterion is one test named
// "AC<n>"; the old Zeroed boundary rule (`packages/core/src/amm/fees.ts:29-31`, `>=` keeps the cheaper tier on an
// exact threshold) is re-run through the same check and must be rejected (MIGRATION Rules 1, ruling Z07-2).
import { strict as assert } from 'node:assert';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import type { Bps, Clock, Pubkey, Slot, UnixMs } from '@bot/types';
import { createDecoders, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import { createVenueConfigCache, createVenueModel, checkVenueConfigSettings, feeConfigView, type AccountsReader, type RawAccount } from '../src/cache.ts';
import { ACCOUNTS, MINTS, PROGRAMS } from '../src/constants.ts';
import { candidateSplits, chainTierIndex, checkTiers, dearest, feeScheduleFor, marketCapAt, marketCapOf, tierIndicesAt, totalBps, type FeeInputs, type FeeTierView } from '../src/fees.ts';
import { quoteDetail } from '../src/quote.ts';
import { pool, poolAtMarketCap, readJson, SOL, split3 } from './helpers.ts';

const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
assert.ok(idls.ok);
const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });

type Fixture = { accounts: Array<{ pubkey: string; owner: string; data_base64: string; context_slot: number }> };
const raw = (name: string): RawAccount & { slot: number } => {
  const a = readJson<Fixture>(`fixtures/mainnet/config/${name}.json`).accounts[0] as Fixture['accounts'][number];
  return { owner: a.owner, data: new Uint8Array(Buffer.from(a.data_base64, 'base64')), slot: a.context_slot };
};
const RAW = { curve: raw('fee_config_curve'), pumpswap: raw('fee_config_pumpswap'), global: raw('pumpswap_global_config'), pumpGlobal: raw('pump_global') };
const ORDER = [RAW.curve, RAW.pumpswap, RAW.global, RAW.pumpGlobal];

/** A reader replaying the 2026-10-06 config accounts; `fail` makes it time out, `edit` changes one account's bytes. */
function fakeReader(): AccountsReader & { fail: boolean; accounts: Array<RawAccount | null>; reads: number } {
  const r = {
    fail: false, reads: 0, accounts: ORDER.map((a) => ({ owner: a.owner, data: a.data }) as RawAccount | null),
    async read(keys: readonly Pubkey[]) {
      r.reads++;
      assert.deepEqual(keys, [ACCOUNTS.feeConfigCurve, ACCOUNTS.feeConfigPumpSwap, ACCOUNTS.pumpSwapGlobalConfig, ACCOUNTS.pumpGlobal]);
      if (r.fail) return { ok: false as const, error: { code: 'E_TIMEOUT' } };
      return { ok: true as const, value: { contextSlot: BigInt(RAW.pumpswap.slot) as Slot, accounts: r.accounts } };
    },
  };
  return r;
}
const fakeClock = (): Clock & { t: number } => {
  const c = { t: 1_790_000_000_000, kind: 'sim' as const, nowMs: () => c.t as UnixMs };
  return c;
};
const logs: Array<{ level: string; code: string; fields: Record<string, unknown> }> = [];
const log = { event: (level: string, code: string, fields: Readonly<Record<string, unknown>>) => { logs.push({ level, code, fields: { ...fields } }); } };

async function liveCache() {
  const reader = fakeReader();
  const clock = fakeClock();
  const cache = createVenueConfigCache({ reader, decoder: decoders, clock, log });
  await cache.refresh();
  return { reader, clock, cache, model: createVenueModel(cache) };
}

const inputsOf = async (): Promise<FeeInputs> => {
  const { cache } = await liveCache();
  const i = cache.inputs('pumpswap');
  assert.ok(i.ok);
  const c = cache.inputs('pump_curve');
  assert.ok(c.ok);
  return { ...i.value, curve: c.value.curve };
};
const INPUTS = await inputsOf();
const TIERS = INPUTS.pumpswap?.tiers as readonly FeeTierView[];
const EX07_BOUNDARIES_SOL = [420n, 1_470n, 2_460n, 3_440n, 4_420n, 9_820n, 14_740n];

describe('A-M01-02 acceptance', () => {
  it('AC1: the 2026-10-06 PumpSwap FeeConfig has 25 tiers, first 2/93/30 below 420 SOL, last 20/5/5 at ≥ 98,240 SOL, flat 25/5/0 [EX-07, EX-08]', () => {
    assert.equal(TIERS.length, 25);
    assert.deepEqual(TIERS[0]?.fees, split3(2, 93, 30));
    assert.equal(TIERS[1]?.thresholdLamports, 420n * SOL);
    assert.deepEqual(TIERS[24], { thresholdLamports: 98_240n * SOL, fees: split3(20, 5, 5) });
    assert.deepEqual(INPUTS.pumpswap?.flat, split3(25, 5, 0));
    for (const sol of EX07_BOUNDARIES_SOL) assert.ok(TIERS.some((t) => t.thresholdLamports === sol * SOL), `${sol} SOL`);
  });

  it('AC2: pre-trade 419.999 SOL, post-trade 420.001 SOL: charged 2/93/30 (the dearer); and a sell crossing back down too', () => {
    const p = poolAtMarketCap(419_999_000_000n);
    // A buy whose post-trade market cap is above 420 SOL.
    const buy = quoteDetail(p, 'buy', 2_000_000n, INPUTS);
    assert.ok(buy.ok);
    assert.ok(marketCapAt(p, buy.value.leg.afterQuote, buy.value.leg.afterBase) >= 420n * SOL);
    assert.deepEqual(buy.value.leg.split, split3(2, 93, 30));
    // A sell from 420.001 SOL to below 420: the chain charges the 420 tier (20/5/95 = 1.20%), the engine 2/93/30 (1.25%).
    const q = poolAtMarketCap(420_001_000_000n);
    const sell = quoteDetail(q, 'sell', 3_000_000_000n, INPUTS);
    const chain = quoteDetail(q, 'sell', 3_000_000_000n, INPUTS, 'chain');
    assert.ok(sell.ok && chain.ok);
    assert.ok(marketCapAt(q, sell.value.leg.afterQuote, sell.value.leg.afterBase) < 420n * SOL);
    assert.deepEqual(chain.value.leg.split, split3(20, 5, 95));
    assert.deepEqual(sell.value.leg.split, split3(2, 93, 30));
    assert.ok(sell.value.quote.amountOut < chain.value.quote.amountOut);
  });

  it('AC3: below the first threshold the first tier applies; an exotic quote pays flat while exotic is all zero, else exotic [VF-04]', () => {
    const tiers: FeeTierView[] = [{ thresholdLamports: 100n, fees: split3(1, 1, 1) }, { thresholdLamports: 200n, fees: split3(0, 1, 1) }];
    assert.equal(chainTierIndex(tiers, 5n), 0);
    const base = INPUTS.pumpswap as NonNullable<FeeInputs['pumpswap']>;
    const exotic = pool({ quoteMint: 'exotic-mint' });
    const zero = feeScheduleFor(exotic, { ...INPUTS, pumpswap: { ...base, exoticFlat: split3(0, 0, 0) } });
    assert.ok(zero.ok);
    assert.deepEqual([zero.value.lpBps, zero.value.protocolBps, zero.value.creatorBps], [25, 5, 0]);
    const set = feeScheduleFor(exotic, { ...INPUTS, pumpswap: { ...base, exoticFlat: split3(20, 5, 5) } });
    assert.ok(set.ok);
    assert.deepEqual([set.value.lpBps, set.value.protocolBps, set.value.creatorBps], [20, 5, 5]);
  });

  it('AC4: a pool exactly at a threshold pays the dearer of the two adjacent tiers; the old Zeroed `>=` rule is rejected', () => {
    // Zeroed core/src/amm/fees.ts:29-31 (selectFeeTier): the last tier whose threshold is <= the market cap.
    const oldRule = (tiers: readonly FeeTierView[], m: bigint) => (tiers[[...tiers.keys()].reverse().find((i) => m >= (tiers[i] as FeeTierView).thresholdLamports) ?? 0] as FeeTierView).fees;
    for (const sol of EX07_BOUNDARIES_SOL) {
      const at = sol * SOL;
      const f = feeScheduleFor(poolAtMarketCap(at), INPUTS);
      assert.ok(f.ok);
      const i = chainTierIndex(TIERS, at);
      const dearer = Math.max(totalBps((TIERS[i] as FeeTierView).fees), totalBps((TIERS[i - 1] as FeeTierView).fees));
      const check = (total: number) => assert.equal(total, dearer, `${sol} SOL`);
      check(f.value.totalBps);
      assert.throws(() => check(totalBps(oldRule(TIERS, at))));
    }
  });

  it('AC5: the curve FeeConfig gives 0/95/30, fee added on top [EX-05]', () => {
    const curve = pool({ venue: 'pump_curve', quoteReserveReal: 0n, quoteReserveVirtual: 30n * SOL, baseReserve: 1_073_000_000_000_000n, curveComplete: false, realBaseReserve: 793_100_000_000_000n, isCanonical: null });
    const f = feeScheduleFor(curve, INPUTS);
    assert.ok(f.ok);
    assert.deepEqual([f.value.lpBps, f.value.protocolBps, f.value.creatorBps, f.value.feeOnBuy], [0, 95, 30, 'added_on_top']);
    assert.equal(f.value.sourceAccount, ACCOUNTS.feeConfigCurve);
  });

  it('AC6: with no successful refresh for 601 s, feeFor returns E_CONFIG_STALE (failure injection: RPC timeouts for 11 minutes)', async () => {
    const { reader, clock, cache, model } = await liveCache();
    const p = pool();
    assert.ok(model.feeFor(p).ok);
    reader.fail = true;
    for (let m = 0; m < 11; m++) { clock.t += 60_000; await cache.refresh(); }
    const at600 = model.feeFor(p);
    assert.ok(!at600.ok && at600.error.code === 'E_CONFIG_STALE');
    const q = model.quoteExactIn(p, 'buy', SOL);
    assert.ok(!q.ok && q.error.code === 'E_CONFIG_STALE');
    // Exactly 600 s old is still fresh; 601 s is not.
    const { reader: r2, clock: c2, cache: k2, model: m2 } = await liveCache();
    r2.fail = true;
    c2.t += 600_000;
    await k2.refresh();
    assert.ok(m2.feeFor(p).ok);
    c2.t += 1_000;
    const stale = m2.feeFor(p);
    assert.ok(!stale.ok && stale.error.code === 'E_CONFIG_STALE');
  });
});

describe('A-M01-02 tiers', () => {
  it('every tier threshold ±1 lamport of market cap: below → the tier under it; at → the dearer of the two; above → its own tier', () => {
    for (let i = 1; i < TIERS.length; i++) {
      const th = (TIERS[i] as FeeTierView).thresholdLamports;
      const below = (TIERS[i - 1] as FeeTierView).fees;
      const own = (TIERS[i] as FeeTierView).fees;
      const at = (m: bigint) => { const f = feeScheduleFor(poolAtMarketCap(m), INPUTS); assert.ok(f.ok); return [f.value.lpBps, f.value.protocolBps, f.value.creatorBps]; };
      assert.deepEqual(at(th - 1n), [below.lpBps, below.protocolBps, below.creatorBps]);
      assert.deepEqual(at(th + 1n), [own.lpBps, own.protocolBps, own.creatorBps]);
      const d = totalBps(below) >= totalBps(own) ? below : own;
      assert.deepEqual(at(th), [d.lpBps, d.protocolBps, d.creatorBps]);
      assert.deepEqual(tierIndicesAt(TIERS, th), [i, i - 1]);
    }
  });

  it('property (ARCH 16.2): for canonical pools feeFor(...).totalBps is non-increasing in market cap', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 200_000n * SOL }), fc.bigInt({ min: 0n, max: 200_000n * SOL }), (a, b) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const fl = feeScheduleFor(poolAtMarketCap(lo), INPUTS);
      const fh = feeScheduleFor(poolAtMarketCap(hi), INPUTS);
      return fl.ok && fh.ok && fh.value.totalBps <= fl.value.totalBps;
    }), { numRuns: 10_000, seed: 7_07 });
  });

  it('splits that two tiers make equal (no creator fee) are considered once; dearest keeps the first on a tie and finds a dearer later one', () => {
    const c = candidateSplits(poolAtMarketCap(2_460n * SOL, { coinCreatorSet: false }), INPUTS, [2_460n * SOL]);
    assert.ok(c.ok);
    assert.deepEqual(c.value.splits, [split3(20, 5, 0)]);
    assert.deepEqual(dearest([split3(1, 0, 0), split3(0, 1, 0)]), split3(1, 0, 0));
    assert.deepEqual(dearest([split3(1, 0, 0), split3(0, 2, 0)]), split3(0, 2, 0));
  });

  it('edge 5: unsorted tiers are sorted; a duplicate threshold with the same fees collapses, with different fees is E_FEE_UNKNOWN', () => {
    const a = { thresholdLamports: 10n, fees: split3(1, 2, 3) };
    const b = { thresholdLamports: 0n, fees: split3(3, 2, 1) };
    const sorted = checkTiers([a, b, { ...a }]);
    assert.ok(sorted.ok);
    assert.deepEqual(sorted.value, [b, a]);
    const bad = checkTiers([a, { thresholdLamports: 10n, fees: split3(1, 2, 4) }]);
    assert.ok(!bad.ok && bad.error.code === 'E_FEE_UNKNOWN');
    assert.ok(!checkTiers([]).ok);
    const base = INPUTS.pumpswap as NonNullable<FeeInputs['pumpswap']>;
    const viaPool = feeScheduleFor(pool(), { ...INPUTS, pumpswap: { ...base, tiers: [a, { thresholdLamports: 10n, fees: split3(1, 2, 4) }] } });
    assert.ok(!viaPool.ok && viaPool.error.code === 'E_FEE_UNKNOWN');
    const curveBad = feeScheduleFor(pool({ venue: 'pump_curve' }), { ...INPUTS, curve: { ...base, tiers: [] } });
    assert.ok(!curveBad.ok);
  });

  it('logic 3: non-canonical pays flat 25/5/0 [EX-08]; canonicality unknown, USDC, Raydium, unread configs and a zero base are E_FEE_UNKNOWN', () => {
    const flat = feeScheduleFor(pool({ isCanonical: false }), INPUTS);
    assert.ok(flat.ok);
    assert.deepEqual([flat.value.lpBps, flat.value.protocolBps, flat.value.creatorBps], [25, 5, 0]);
    const unknown = (p: ReturnType<typeof pool>, i: FeeInputs = INPUTS) => { const f = feeScheduleFor(p, i); assert.ok(!f.ok && f.error.code === 'E_FEE_UNKNOWN', JSON.stringify(f)); };
    unknown(pool({ isCanonical: null }));
    unknown(pool({ swappedMints: true, isCanonical: false }));                       // C-83
    unknown(pool({ quoteMint: MINTS.usdc }));
    unknown(pool({ venue: 'raydium_cpmm' }));
    unknown(pool(), { ...INPUTS, pumpswap: null });
    unknown(pool({ venue: 'pump_curve' }), { ...INPUTS, curve: null });
    unknown(pool({ baseReserve: 0n }));
    unknown(pool({ quoteReserveVirtual: -100n * SOL }));
  });

  it('A08 / VF-04: mayhem pools use a supply of 10^15; a per-pool creator_fee_bps of 50 is charged when configurable; a default coin_creator pays 0', () => {
    // Mint supply 2 × 10^15 puts the pool at 840 SOL (tier 420); mayhem's fixed 10^15 puts it at 420 SOL exactly (dearer: tier 0).
    const p = poolAtMarketCap(420n * SOL, { baseMintSupply: 2_000_000_000_000_000n });
    const normal = feeScheduleFor(p, INPUTS);
    const mayhem = feeScheduleFor({ ...p, isMayhemMode: true }, INPUTS);
    assert.ok(normal.ok && mayhem.ok);
    assert.equal(marketCapOf(p), 840n * SOL);
    assert.equal(marketCapOf({ ...p, isMayhemMode: true }), 420n * SOL);
    assert.deepEqual([mayhem.value.lpBps, mayhem.value.protocolBps, mayhem.value.creatorBps], [2, 93, 30]);
    assert.deepEqual([normal.value.lpBps, normal.value.protocolBps, normal.value.creatorBps], [20, 5, 95]);
    const own = feeScheduleFor(poolAtMarketCap(500n * SOL, { creatorFeeBps: 50 as Bps }), INPUTS);
    assert.ok(own.ok && own.value.creatorBps === 50 && own.value.lpBps === 20);
    const gated = feeScheduleFor(poolAtMarketCap(500n * SOL, { creatorFeeBps: 50 as Bps }), { ...INPUTS, creatorFeeConfigurable: false });
    assert.ok(gated.ok && gated.value.creatorBps === 95);
    const unread = feeScheduleFor(pool({ creatorFeeBps: 50 as Bps }), { ...INPUTS, creatorFeeConfigurable: null });
    assert.ok(!unread.ok && unread.error.code === 'E_FEE_UNKNOWN');
    const none = feeScheduleFor(pool({ coinCreatorSet: false, creatorFeeBps: 50 as Bps }), INPUTS);
    assert.ok(none.ok && none.value.creatorBps === 0);
    // A tier table alone (no per-pool rate) is wrong for such a pool (A08).
    const table = candidateSplits(pool({ creatorFeeBps: 0 }), INPUTS, [marketCapOf(pool()) as bigint]);
    assert.ok(table.ok && table.value.splits[0]?.creatorBps !== 50);
  });
});

describe('A-M01-02 cache', () => {
  it('decodes the four 2026-10-06 config fixtures; re-reading identical data keeps version 1; a changed account bumps it once', async () => {
    const { reader, clock, cache } = await liveCache();
    const e = cache.entry(ACCOUNTS.feeConfigPumpSwap);
    assert.ok(e !== null && e.version === 1 && e.configHash.length === 64 && e.venue === 'pumpswap');
    assert.equal(cache.entry(ACCOUNTS.pumpGlobal)?.decoded.kind, 'pump_global');
    assert.equal(cache.entry('not-a-config'), null);
    const seen: string[] = [];
    const off = cache.onEvent((ev) => seen.push(ev.kind));
    clock.t += 60_000;
    await cache.refresh();
    assert.equal(cache.entry(ACCOUNTS.feeConfigPumpSwap)?.version, 1);
    assert.equal(cache.entry(ACCOUNTS.feeConfigPumpSwap)?.changedAtMs, e.changedAtMs);
    assert.deepEqual(seen, []);
    const data = new Uint8Array(RAW.pumpswap.data);
    data[data.length - 1] = (data[data.length - 1] as number) ^ 1;
    reader.accounts[1] = { owner: RAW.pumpswap.owner, data };
    clock.t += 60_000;
    await cache.refresh();
    const changed = cache.entry(ACCOUNTS.feeConfigPumpSwap);
    assert.ok(changed !== null && changed.version === 2 && changed.changedAtMs === clock.t && changed.configHash !== e.configHash);
    assert.deepEqual(seen, ['changed']);
    off();
    assert.ok(logs.some((l) => l.code === 'm01.fee_config_changed' && l.fields.version === 2));
  });

  it('edges 1-2: a missing account, a wrong owner or an unknown layout is a decode failure: E_FEE_UNKNOWN and a critical log', async () => {
    for (const bad of [null, { owner: PROGRAMS.pumpSwap, data: RAW.pumpswap.data }, { owner: PROGRAMS.pumpFees, data: new Uint8Array(40) }]) {
      const { reader, cache, model } = await liveCache();
      const events: string[] = [];
      cache.onEvent((ev) => events.push(ev.kind === 'decode_failed' ? `${ev.name}:${ev.reason}` : ev.kind));
      reader.accounts[1] = bad;
      await cache.refresh();
      assert.ok(cache.decodeFailed('feeConfigPumpSwap'));
      const f = model.feeFor(pool());
      assert.ok(!f.ok && f.error.code === 'E_FEE_UNKNOWN');
      assert.equal(events.length, 1);
      assert.ok(logs.some((l) => l.code === 'm01.fee_config_decode_failed' && l.level === 'critical'));
      // The curve keeps quoting: its own config is fine.
      assert.ok(model.feeFor(pool({ venue: 'pump_curve', curveComplete: false })).ok);
      // Recovers on the next good read.
      reader.accounts[1] = { owner: RAW.pumpswap.owner, data: RAW.pumpswap.data };
      await cache.refresh();
      assert.ok(!cache.decodeFailed('feeConfigPumpSwap') && model.feeFor(pool()).ok);
    }
  });

  it('inputs: unread configs are E_FEE_UNKNOWN; the global config gates the per-pool creator rate; Raydium has no inputs', async () => {
    const cache = createVenueConfigCache({ reader: fakeReader(), decoder: decoders, clock: fakeClock(), log });
    const i = cache.inputs('pumpswap');
    assert.ok(!i.ok && i.error.code === 'E_FEE_UNKNOWN');
    assert.ok(!cache.inputs('raydium_amm_v4').ok);
    assert.deepEqual(cache.candidateTiers(pool()), []);
    const { cache: live } = await liveCache();
    const g = live.inputs('pumpswap');
    assert.ok(g.ok && g.value.creatorFeeConfigurable === true);
    const { reader, cache: k } = await liveCache();
    reader.accounts[2] = { owner: PROGRAMS.pumpSwap, data: new Uint8Array(16) };
    await k.refresh();
    const noGlobal = k.inputs('pumpswap');
    assert.ok(!noGlobal.ok && noGlobal.error.code === 'E_FEE_UNKNOWN');
  });

  it('candidateTiers lists every schedule considered at the pool market cap (A-M01-05); feeConfigView reads the exotic schedule', async () => {
    const { cache } = await liveCache();
    const at = cache.candidateTiers(poolAtMarketCap(420n * SOL));
    assert.deepEqual(at.map((s) => s.totalBps), [120, 125]);
    assert.deepEqual(cache.candidateTiers(poolAtMarketCap(100n * SOL)).map((s) => s.totalBps), [125]);
    assert.deepEqual(cache.candidateTiers(pool({ baseReserve: 0n })), []);
    assert.deepEqual(cache.candidateTiers(pool({ isCanonical: null })), []);
    const e = cache.entry(ACCOUNTS.feeConfigPumpSwap);
    assert.ok(e !== null);
    assert.deepEqual(feeConfigView(e).exoticFlat, split3(20, 5, 5));
  });

  it('config validation: refresh 10 s..300 s, max age ≥ 2 × refresh and ≤ 600 s; a bad setting refuses to build the cache', () => {
    assert.ok(checkVenueConfigSettings({ refreshMs: 60_000, maxAgeMs: 600_000 }).ok);
    for (const s of [{ refreshMs: 9_999, maxAgeMs: 600_000 }, { refreshMs: 300_001, maxAgeMs: 600_000 }, { refreshMs: 60_000, maxAgeMs: 119_999 }, { refreshMs: 60_000, maxAgeMs: 600_001 }, { refreshMs: 1.5e4 + 0.5, maxAgeMs: 600_000 }]) {
      assert.ok(!checkVenueConfigSettings(s).ok, JSON.stringify(s));
    }
    assert.throws(() => createVenueConfigCache({ reader: fakeReader(), decoder: decoders, clock: fakeClock(), log, settings: { refreshMs: 1, maxAgeMs: 2 } }));
  });

  it('VenueModel: marketCapLamports, effectiveQuote, and the non-pump venues', async () => {
    const { model } = await liveCache();
    assert.equal(model.marketCapLamports(poolAtMarketCap(500n * SOL)), 500n * SOL);
    assert.throws(() => model.marketCapLamports(pool({ baseReserve: 0n })), (e: unknown) => (e as { code: string }).code === 'E_ZERO_RESERVE');
    assert.throws(() => model.marketCapLamports(pool({ quoteReserveVirtual: -100n * SOL })), (e: unknown) => (e as { code: string }).code === 'E_NEGATIVE_EFFECTIVE');
    const r = model.quoteExactIn(pool({ venue: 'raydium_cpmm' }), 'buy', SOL);
    assert.ok(!r.ok && r.error.code === 'E_VENUE_NOT_SPECIFIED');
    const f = model.feeFor(pool({ venue: 'raydium_amm_v4' }));
    assert.ok(!f.ok && f.error.code === 'E_FEE_UNKNOWN');
    assert.equal(model.isAllowedVenue(PROGRAMS.pumpSwap), 'pumpswap');
  });
});
