// A-M01-04 pool orientation and the orientation guard (card Z07). Acceptance criteria are "AC<n>"; synthetic pools say
// so in the test name (ruling Z07-5). The recorded swaps are the CORE-2 goldens: each event's pool reserves are the
// pre-swap state (fixtures/core2/README.md), which serves as the snapshot one slot earlier.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { createDecoders, verifyPinnedIdls, VENDORED_IDL_DIR, type DecodedAccount } from '@bot/decoders';
import type { BaseUnits, Bps, Clock, DecodedEvent, Lamports, RawTransaction, Signature, Slot, UnixMs } from '@bot/types';
import { MINTS, PROGRAMS, pumpPoolAuthorityPda } from '../src/constants.ts';
import { checkGuardSettings, createOrientationGuard, createOrientationSampler, DEVIATION_WARN_BPS, GUARD_DEFAULTS, QUARANTINE_ALERT_ENTRIES, type PoolQuarantined, type SwapSource } from '../src/guard.ts';
import { checkOrientation, normalisePool, type SwapEvent } from '../src/orientation.ts';
import type { CpPoolState } from '../src/pool.ts';
import { pool, readJson } from './helpers.ts';

const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
assert.ok(idls.ok);
const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });
type FxAccount = { role: string; pubkey: string; owner: string; data_base64: string; context_slot: number };
const poolSet = (name: string) => {
  const f = readJson<{ accounts: FxAccount[]; selection: { pool_authority: string } }>(`fixtures/mainnet/pumpswap/pools/pool_${name}.json`);
  const acc = (role: string) => {
    const a = f.accounts.find((x) => x.role === role) as FxAccount;
    return { pubkey: a.pubkey, decoded: decoders.decodeAccount(a.owner, new Uint8Array(Buffer.from(a.data_base64, 'base64'))), slot: a.context_slot };
  };
  return { pool: acc('pool'), base: acc('base_vault'), quote: acc('quote_vault'), mint: acc('base_mint'), authority: f.selection.pool_authority };
};
const ctx = (poolId: string, canonicalCreator: string | null) => ({ poolId, asOfSlot: 100n as Slot, commitment: 'confirmed' as const, observedAtMs: 5 as UnixMs, canonicalCreator });
const S = <K extends DecodedAccount['kind']>(a: DecodedAccount, kind: K) => { assert.equal(a.kind, kind); return a as Extract<DecodedAccount, { kind: K }>; };
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

describe('A-M01-04 normalisation', () => {
  it('AC1: recorded pool 9jkXWMyt (quote wSOL): base is the token and the reserves are the matching vaults; canonical by the pool-authority PDA', async () => {
    const f = poolSet('9jkXWMyt');
    const p = S(f.pool.decoded, 'pumpswap_pool');
    const mint = S(f.mint.decoded, 'spl_mint');
    const authority = await pumpPoolAuthorityPda(p.baseMint);
    assert.equal(authority, f.authority);
    const n = ok(normalisePool('pumpswap', p, { baseVault: f.base.decoded, quoteVault: f.quote.decoded }, { address: p.baseMint, supplyBase: mint.supply, decimals: mint.decimals }, ctx(f.pool.pubkey, authority)));
    assert.equal(n.baseMint, p.baseMint);
    assert.equal(n.quoteMint, MINTS.wsol);
    assert.equal(n.baseReserve, S(f.base.decoded, 'spl_token_account').amount);
    assert.equal(n.quoteReserveReal, S(f.quote.decoded, 'spl_token_account').amount);
    assert.equal(n.quoteReserveVirtual, 17_584_326_063n);                            // [EX-09]
    assert.deepEqual([n.isCanonical, n.baseDecimals, n.baseMintSupply, n.coinCreatorSet, n.swappedMints], [true, 6, mint.supply, true, false]);
    assert.equal(ok(normalisePool('pumpswap', p, { baseVault: f.base.decoded, quoteVault: f.quote.decoded }, { address: p.baseMint, supplyBase: mint.supply, decimals: 6 }, ctx(f.pool.pubkey, 'someone-else'))).isCanonical, false);
    assert.equal(ok(normalisePool('pumpswap', p, { baseVault: f.base.decoded, quoteVault: f.quote.decoded }, { address: p.baseMint, supplyBase: mint.supply, decimals: 6 }, ctx(f.pool.pubkey, null))).isCanonical, null);
  });

  // Synthetic accounts built from the pinned IDL's field names (no such pools were recorded).
  const pid = 'pool-x';
  const tokenAcct = (mint: string, owner: string, amount: bigint): DecodedAccount => ({ kind: 'spl_token_account', mint, owner, amount, delegate: null, state: 'initialized' });
  const synthPool = (baseMint: string, quoteMint: string, virtual = 0n): DecodedAccount => ({
    kind: 'pumpswap_pool', baseMint, quoteMint, creator: 'creator', virtualQuoteReserves: virtual, baseVault: 'v-base', quoteVault: 'v-quote',
    lpMint: 'lp', lpSupply: 1n, coinCreator: 'cc', isMayhemMode: false, creatorFeeBps: 0 as Bps, canEditCreatorFee: false,
  });
  const MINT = { address: 'token', supplyBase: 10n ** 15n, decimals: 6 };

  it('AC2 (synthetic pool): with the two mints swapped, the state equals the correctly ordered one, flagged swappedMints; its fee is unknown', () => {
    const ordered = ok(normalisePool('pumpswap', synthPool('token', MINTS.wsol), { baseVault: tokenAcct('token', pid, 500n), quoteVault: tokenAcct(MINTS.wsol, pid, 70n) }, MINT, ctx(pid, 'creator')));
    const swapped = ok(normalisePool('pumpswap', synthPool(MINTS.wsol, 'token'), { baseVault: tokenAcct(MINTS.wsol, pid, 70n), quoteVault: tokenAcct('token', pid, 500n) }, MINT, ctx(pid, 'creator')));
    assert.deepEqual({ ...swapped, swappedMints: false }, ordered);
    assert.equal(swapped.swappedMints, true);
    const bad = normalisePool('pumpswap', synthPool(MINTS.wsol, 'token', 5n), { baseVault: tokenAcct(MINTS.wsol, pid, 70n), quoteVault: tokenAcct('token', pid, 500n) }, MINT, ctx(pid, 'creator'));
    assert.ok(!bad.ok && bad.error.code === 'E_LAYOUT');
  });

  it('AC3 (synthetic USDC pool from the IDL): E_NOT_SOL_QUOTED', () => {
    const r = normalisePool('pumpswap', synthPool('token', MINTS.usdc), { baseVault: tokenAcct('token', pid, 1n), quoteVault: tokenAcct(MINTS.usdc, pid, 1n) }, MINT, ctx(pid, null));
    assert.ok(!r.ok && r.error.code === 'E_NOT_SOL_QUOTED');
  });

  it('logic 2-3 (synthetic): a vault of another mint, another owner, not a token account, a wrong mint read, no vaults, a non-pool, Raydium', () => {
    const vaults = (b: DecodedAccount, q: DecodedAccount) => ({ baseVault: b, quoteVault: q });
    const layout = (r: ReturnType<typeof normalisePool>) => assert.ok(!r.ok && r.error.code === 'E_LAYOUT', JSON.stringify(r));
    const good = synthPool('token', MINTS.wsol);
    layout(normalisePool('pumpswap', good, vaults(tokenAcct('other', pid, 1n), tokenAcct(MINTS.wsol, pid, 1n)), MINT, ctx(pid, null)));
    layout(normalisePool('pumpswap', good, vaults(tokenAcct('token', 'thief', 1n), tokenAcct(MINTS.wsol, pid, 1n)), MINT, ctx(pid, null)));
    layout(normalisePool('pumpswap', good, vaults(tokenAcct('token', pid, 1n), tokenAcct(MINTS.wsol, 'thief', 1n)), MINT, ctx(pid, null)));
    layout(normalisePool('pumpswap', good, vaults({ kind: 'unknown', owner: 'x', discriminatorHex: '' }, tokenAcct(MINTS.wsol, pid, 1n)), MINT, ctx(pid, null)));
    layout(normalisePool('pumpswap', good, vaults(tokenAcct('token', pid, 1n), tokenAcct(MINTS.wsol, pid, 1n)), { ...MINT, address: 'other' }, ctx(pid, null)));
    layout(normalisePool('pumpswap', good, null, MINT, ctx(pid, null)));
    layout(normalisePool('pumpswap', { kind: 'unknown', owner: 'x', discriminatorHex: '' }, null, MINT, ctx(pid, null)));
    layout(normalisePool('pump_curve', good, null, MINT, ctx(pid, null)));
    const r = normalisePool('raydium_cpmm', good, null, MINT, ctx(pid, null));
    assert.ok(!r.ok && r.error.code === 'E_VENUE_NOT_SPECIFIED');
    const both = normalisePool('pumpswap', synthPool(MINTS.wsol, MINTS.wsol), vaults(tokenAcct(MINTS.wsol, pid, 1n), tokenAcct(MINTS.wsol, pid, 1n)), MINT, ctx(pid, null));
    assert.ok(!both.ok && both.error.code === 'E_NOT_SOL_QUOTED');
  });

  it('a pump curve (synthetic) normalises to its virtual reserves with the real token reserve kept', () => {
    const curve: DecodedAccount = { kind: 'pump_bonding_curve', virtualQuote: 30_000_000_000n, virtualToken: 1_073_000_000_000_000n, realQuote: 0n, realToken: 793_100_000_000_000n, complete: false, quoteMint: null, creator: 'c' };
    const n = ok(normalisePool('pump_curve', curve, null, MINT, ctx('curve', null)));
    assert.deepEqual([n.baseMint, n.baseReserve, n.quoteReserveReal, n.quoteReserveVirtual, n.realBaseReserve, n.curveComplete, n.coinCreatorSet], ['token', 1_073_000_000_000_000n, 0n, 30_000_000_000n, 793_100_000_000_000n, false, true]);
  });
});

type Str = Record<string, string>;
interface PoolVector { signature: string; slot: number; kind: 'buy' | 'sell'; ixName: string; event: Str; pool: { address: string } }
const G = readJson<{ pumpswap: PoolVector[] }>('fixtures/core2/golden.json').pumpswap;
const n = (s: string | undefined): bigint => BigInt(s ?? 'missing');
const eventOf = (v: PoolVector): SwapEvent => ({
  kind: v.kind === 'buy' ? 'pumpswap_buy' : 'pumpswap_sell', pool: v.pool.address, slot: BigInt(v.slot) as Slot, signature: v.signature,
  baseAmount: n(v.kind === 'buy' ? v.event.base_amount_out : v.event.base_amount_in), quoteAmount: n(v.kind === 'buy' ? v.event.quote_amount_in : v.event.quote_amount_out) as Lamports,
  lpFeeBps: Number(v.event.lp_fee_basis_points), protocolFeeBps: Number(v.event.protocol_fee_basis_points), coinCreatorFeeBps: Number(v.event.coin_creator_fee_basis_points),
  virtualQuoteReserves: n(v.event.virtual_quote_reserves),
});
/** Our snapshot one slot before the swap: the event's pre-swap reserves. */
const snapshotOf = (v: PoolVector, slotsBefore = 1n): CpPoolState => pool({
  poolId: v.pool.address, asOfSlot: (BigInt(v.slot) - slotsBefore) as Slot,
  baseReserve: n(v.event.pool_base_token_reserves), quoteReserveReal: n(v.event.pool_quote_token_reserves), quoteReserveVirtual: n(v.event.virtual_quote_reserves),
});
/** Swaps of more than 0.001 SOL: always evaluable. */
const BIG = G.filter((v) => n(v.kind === 'buy' ? v.event.quote_amount_in : v.event.quote_amount_out) > 1_000_000n);
const inverted = (p: CpPoolState): CpPoolState => ({ ...p, baseReserve: (p.quoteReserveReal + p.quoteReserveVirtual) as BaseUnits, quoteReserveReal: p.baseReserve as bigint as Lamports, quoteReserveVirtual: 0n });
const settings = { maxSlotGap: 2 };

describe('A-M01-04 spot-vs-swap check', () => {
  /** The raw price ratio (lamports per raw base unit) is in the band where inversion cannot show by price (Z07-20). */
  const blind = (p: CpPoolState): boolean => {
    const Q = p.quoteReserveReal + p.quoteReserveVirtual;
    return Q * 1_000n >= p.baseReserve * 316n && Q * 100n <= p.baseReserve * 316n;
  };

  it('AC4 (ruling Z07-20): every recorded swap (353) passes on the snapshot one slot earlier (dust under 10,000 lamports is not evaluable); an inverted pool fails on every evaluable swap outside the raw-price blind band', () => {
    let worst = 0, passed = 0, dust = 0, invertedFail = 0, blindSwaps = 0;
    for (const v of G) {
      const r = checkOrientation(snapshotOf(v), eventOf(v), settings);
      const label = `${v.ixName} ${v.signature.slice(0, 12)} ${r.reason}`;
      if (r.status === 'not_evaluable') {
        assert.equal(r.reason, 'swap too small to compare', label);
        dust++;
        continue;
      }
      assert.equal(r.status, 'pass', label);
      worst = Math.max(worst, r.observedBps as number);
      passed++;
      // Raw ratios within about [0.316, 3.16]: the inverse price is within a factor 10, so price cannot tell; the
      // mint guard (`normalisePool`) is what catches an inversion there.
      if (blind(snapshotOf(v))) { blindSwaps++; continue; }
      assert.equal(checkOrientation(inverted(snapshotOf(v)), eventOf(v), settings).status, 'fail', v.signature);
      invertedFail++;
    }
    assert.deepEqual([passed, dust, invertedFail, blindSwaps], [292, 61, 280, 12]);
    assert.ok(worst <= 100, `worst ${worst} bps`);
  });

  it('rulings Z07-15 and Z07-20: AC4 on a snapshot from the same pool\'s previous event in an earlier slot, over every CORE-2 pool that has one (33 pools, 262 swaps): no false quarantine with the factor-10 band', () => {
    // The snapshot is the previous event's own pre-swap reserves at its slot, so the trades in between (that event's
    // swap and any unrecorded ones) are inside the check. At the old 1% this failed 58 of 171 (33.9%, 105 to 1,524 bps).
    const counts = { pass: 0, fail: 0, not_evaluable: 0 };
    const pools = new Set<string>();
    let worst = 0;
    for (const v of G) {
      const prev = G.filter((u) => u.pool.address === v.pool.address && u.slot < v.slot).sort((x, y) => x.slot - y.slot).at(-1);
      if (prev === undefined) continue;
      pools.add(v.pool.address);
      const snap = pool({
        poolId: v.pool.address, asOfSlot: BigInt(prev.slot) as Slot,
        baseReserve: n(prev.event.pool_base_token_reserves), quoteReserveReal: n(prev.event.pool_quote_token_reserves), quoteReserveVirtual: n(prev.event.virtual_quote_reserves),
      });
      const r = checkOrientation(snap, eventOf(v), settings);
      counts[r.status]++;
      if (r.status === 'pass') worst = Math.max(worst, r.observedBps as number);
    }
    assert.equal(pools.size, 33);
    // 171 evaluable swaps all pass; 91 are past the 2-slot gap or dust.
    assert.deepEqual(counts, { pass: 171, fail: 0, not_evaluable: 91 });
    assert.equal(worst, 1_524);                                    // the widest real move: 15%, far inside a factor of 10
  });

  it('ruling Z07-28: every evaluated swap\'s deviation goes to orientation_deviation_bps; a passing swap past 2,000 bps warns and quarantines nothing', () => {
    const lines: Array<[string, string, Record<string, unknown>]> = [];
    const deviations: number[] = [];
    const guard = createOrientationGuard({ clock: { kind: 'sim', nowMs: () => 0 as UnixMs }, log: { event: (l, c, f) => lines.push([l, c, { ...f }]) }, publish: () => {},
      metrics: { orientationCheck: () => {}, poolQuarantined: () => {}, quarantinedPools: () => {}, orientationDeviation: (bps) => deviations.push(bps) } });
    const v = BIG.find((x) => x.kind === 'sell') as PoolVector;
    assert.equal(guard.checkAgainstEvent(snapshotOf(v), eventOf(v)).status, 'pass');
    assert.equal(lines.filter(([, c]) => c === 'm01.orientation_deviation').length, 0);
    assert.equal(guard.checkAgainstEvent({ ...snapshotOf(v), poolId: 'other' }, eventOf(v)).status, 'not_evaluable');   // nothing to record
    // The same swap on a snapshot whose quote reserve is 30% higher: about 2,300 bps off, still within a factor 10.
    const moved = { ...snapshotOf(v), quoteReserveReal: (snapshotOf(v).quoteReserveReal * 13n) / 10n as Lamports };
    const r = guard.checkAgainstEvent(moved, eventOf(v));
    assert.equal(r.status, 'pass');
    assert.ok((r.observedBps as number) > DEVIATION_WARN_BPS, `${r.observedBps}`);
    assert.deepEqual(lines.filter(([, c]) => c === 'm01.orientation_deviation'), [['warn', 'm01.orientation_deviation', { pool: v.pool.address, observed_bps: r.observedBps, slot: BigInt(v.slot) }]]);
    assert.equal(deviations.length, 2);
    assert.equal(deviations[1], r.observedBps);
    assert.equal(guard.quarantined(v.pool.address), false);
  });

  it('ruling Z07-19: the quarantine set is never pruned; a gauge follows it; at 10,000 pools one critical alert and nothing is evicted', async () => {
    const clock = { t: 0, kind: 'sim' as const, nowMs: () => clock.t as UnixMs };
    const lines: Array<[string, string, Record<string, unknown>]> = [];
    const gauge: number[] = [];
    const guard = createOrientationGuard({ clock, log: { event: (l, c, f) => lines.push([l, c, { ...f }]) }, publish: () => {},
      metrics: { orientationCheck: () => {}, poolQuarantined: () => {}, quarantinedPools: (k) => gauge.push(k), orientationDeviation: () => {} } });
    for (let i = 0; i <= QUARANTINE_ALERT_ENTRIES; i++) guard.quarantine(`p${i}`, 'owner_changed');
    assert.equal(gauge.at(-1), QUARANTINE_ALERT_ENTRIES + 1);
    assert.deepEqual(lines.filter(([, c]) => c === 'm01.quarantine_set_large'), [['critical', 'm01.quarantine_set_large', { entries: 10_000, alert_entries: 10_000 }]]);
    assert.ok(guard.quarantined('p0') && guard.quarantined(`p${QUARANTINE_ALERT_ENTRIES}`));
    // Unwatched, then watched again: still quarantined, and never sampled.
    const reads = { n: 0 };
    const sampler = createOrientationSampler({ clock, guard, log: { event: () => {} }, decode: () => [], snapshotBefore: () => null,
      source: { signatures: async () => { reads.n++; return { ok: true, value: [] }; }, transaction: async () => ({ ok: true, value: null }) } });
    await sampler.tick(['p0']);
    await sampler.tick([]);
    clock.t += 3_600_000;
    await sampler.tick(['p0']);
    assert.equal(guard.quarantined('p0'), true);
    assert.equal(reads.n, 0);
  });

  it('AC4 with the guard: inverted reserves quarantine the pool and publish once; correct reserves pass', () => {
    const published: PoolQuarantined[] = [];
    const clock = { t: 1_000, kind: 'sim' as const, nowMs: () => clock.t as UnixMs };
    const guard = createOrientationGuard({ clock, log: { event: () => {} }, publish: (e) => published.push(e) });
    const v = BIG[0] as PoolVector;
    assert.equal(guard.checkAgainstEvent(snapshotOf(v), eventOf(v)).status, 'pass');
    assert.equal(guard.quarantined(v.pool.address), false);
    assert.equal(guard.checkAgainstEvent(inverted(snapshotOf(v)), eventOf(v)).status, 'fail');
    assert.equal(guard.quarantined(v.pool.address), true);
    assert.deepEqual(published, [{ poolId: v.pool.address, reason: 'orientation', atMs: 1_000 }]);
    clock.t += 3_599_999;
    guard.checkAgainstEvent(inverted(snapshotOf(v)), eventOf(v));
    assert.equal(published.length, 1);                      // no re-publish within 1 h
    clock.t += 1;
    guard.quarantine(v.pool.address, 'owner_changed');
    assert.equal(published.length, 2);
  });

  it('not evaluable: another pool, no snapshot before the swap within 2 slots, an empty pool, a zero swap, a sub-lamport sell', () => {
    const v = BIG.find((x) => x.kind === 'sell') as PoolVector;
    const e = eventOf(v);
    const status = (p: CpPoolState, ev: SwapEvent = e) => checkOrientation(p, ev, settings).status;
    assert.equal(status({ ...snapshotOf(v), poolId: 'other' }), 'not_evaluable');
    assert.equal(status(snapshotOf(v, 0n)), 'not_evaluable');
    assert.equal(status(snapshotOf(v, 3n)), 'pass');
    assert.equal(status(snapshotOf(v, 4n)), 'not_evaluable');
    assert.equal(status({ ...snapshotOf(v), baseReserve: 0n }), 'not_evaluable');
    assert.equal(status(snapshotOf(v), { ...e, baseAmount: 0n }), 'not_evaluable');
    assert.equal(status(snapshotOf(v), { ...e, quoteAmount: 9_999n as Lamports }), 'not_evaluable');
    // A sell the model prices at nothing, while the event got 10,000+ lamports, fails.
    assert.equal(status({ ...snapshotOf(v), quoteReserveReal: 1n, quoteReserveVirtual: 0n }, { ...e, baseAmount: 1n }), 'fail');
    const b = BIG.find((x) => x.kind === 'buy') as PoolVector;
    // A buy of the whole base reserve cannot be filled by the model: fail.
    assert.equal(status(snapshotOf(b), { ...eventOf(b), baseAmount: n(b.event.pool_base_token_reserves) }), 'fail');
  });

  it('settings: the A-M01-04 config ranges are enforced and a bad setting refuses to build the guard', () => {
    assert.ok(checkGuardSettings(GUARD_DEFAULTS).ok);
    for (const bad of [{ checkIntervalMs: 59_999 }, { sampleSignatures: 21 }, { maxSlotGap: 11 }]) {
      assert.ok(!checkGuardSettings({ ...GUARD_DEFAULTS, ...bad }).ok, JSON.stringify(bad));
    }
    assert.throws(() => createOrientationGuard({ clock: { kind: 'sim', nowMs: () => 0 as UnixMs }, log: { event: () => {} }, publish: () => {}, settings: { ...GUARD_DEFAULTS, maxSlotGap: 11 } }));
  });
});

describe('A-M01-04 sampler (logic 4; failure injection)', () => {
  const v = BIG.find((x) => x.kind === 'sell') as PoolVector;
  const tx = (sig: string, err: unknown = null): RawTransaction => ({ signature: sig, slot: BigInt(v.slot) as Slot, blockTimeS: null, version: 0, message: { accountKeys: [], loadedAddresses: { writable: [], readonly: [] }, instructions: [] }, meta: { err, feeLamports: 0n, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: null, computeUnitsConsumed: null } });
  const setup = (snapshot: (p: CpPoolState) => CpPoolState) => {
    const clock: Clock & { t: number } = { t: 0, kind: 'sim', nowMs: () => clock.t as UnixMs };
    const published: PoolQuarantined[] = [];
    const guard = createOrientationGuard({ clock, log: { event: () => {} }, publish: (e) => published.push(e) });
    const reads = { sigs: 0, txs: 0 };
    const source: SwapSource & { fail: boolean; failTx: boolean } = {
      fail: false, failTx: false,
      async signatures(_pool, limit) { reads.sigs++; assert.equal(limit, 5); return source.fail ? { ok: false, error: { code: 'E_TIMEOUT' } } : { ok: true, value: ['s-failed', 's-ok'] as Signature[] }; },
      async transaction(sig) { reads.txs++; return source.failTx ? { ok: false, error: { code: 'E_RPC' } } : { ok: true, value: sig === 's-failed' ? tx(sig, { InstructionError: [0, 'x'] }) : tx(sig) }; },
    };
    const sampler = createOrientationSampler({
      clock, guard, source, log: { event: () => {} },
      decode: (t) => (t.meta.err === null ? [eventOf(v)] as DecodedEvent[] : assert.fail('a failed transaction is never decoded')),
      snapshotBefore: (poolId, slot) => (poolId === v.pool.address && slot === BigInt(v.slot) ? snapshot(snapshotOf(v)) : null),
    });
    return { clock, published, guard, reads, source, sampler };
  };

  it('inverted reserves are quarantined within one check interval; correct reserves are not; failed transactions are skipped', async () => {
    const good = setup((p) => p);
    await good.sampler.tick([v.pool.address]);
    assert.equal(good.guard.quarantined(v.pool.address), false);
    const bad = setup(inverted);
    await bad.sampler.tick([v.pool.address]);
    assert.equal(bad.guard.quarantined(v.pool.address), true);
    assert.equal(bad.published.length, 1);
  });

  it('runs each pool once per interval, skips quarantined pools and pools no longer watched, and never overlaps itself', async () => {
    const s = setup((p) => p);
    await s.sampler.tick([v.pool.address]);
    await s.sampler.tick([v.pool.address]);
    assert.equal(s.reads.sigs, 1);
    s.clock.t += 600_000;
    const a = s.sampler.tick([v.pool.address]);
    const b = s.sampler.tick([v.pool.address]);                 // skipped: a tick is running
    await Promise.all([a, b]);
    assert.equal(s.reads.sigs, 2);
    await s.sampler.tick([]);                                   // forgets unwatched pools
    await s.sampler.tick([v.pool.address]);
    assert.equal(s.reads.sigs, 3);
    s.guard.quarantine(v.pool.address, 'owner_changed');
    s.clock.t += 600_000;
    await s.sampler.tick([v.pool.address]);
    assert.equal(s.reads.sigs, 3);
  });

  it('edge 5: a failed read never quarantines; the pool is read again at the next interval', async () => {
    const s = setup(inverted);
    s.source.fail = true;
    await s.sampler.tick([v.pool.address]);
    s.source.fail = false;
    s.source.failTx = true;
    s.clock.t += 600_000;
    await s.sampler.tick([v.pool.address]);
    assert.equal(s.guard.quarantined(v.pool.address), false);
    s.source.failTx = false;
    s.clock.t += 600_000;
    await s.sampler.tick([v.pool.address]);
    assert.equal(s.guard.quarantined(v.pool.address), true);
  });

  it('own fills (fill.events) are checked the same way; other kinds, other pools and swaps with no snapshot are ignored', () => {
    const s = setup(inverted);
    s.sampler.onFillEvent(v.pool.address, [{ kind: 'pump_complete', mint: 'm', slot: 1n as Slot, signature: 's' }, { ...eventOf(v), pool: 'other' }, { ...eventOf(v), slot: 5n as Slot }]);
    assert.equal(s.guard.quarantined(v.pool.address), false);
    s.sampler.onFillEvent(v.pool.address, [eventOf(v)]);
    assert.equal(s.guard.quarantined(v.pool.address), true);
  });
});
