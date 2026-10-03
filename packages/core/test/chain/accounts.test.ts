// Golden vectors for pump, PumpSwap and pump-fees accounts read from mainnet. Oracles: the IDL-driven decoder,
// PDA derivations (each account must sit at the address its own fields imply), and the token vaults.
import { describe, expect, it } from 'vitest';
import { type Address, DecodeError, fromBase64 } from '../../src/chain/bytes.ts';
import { decodeFeeConfig, feeSchedules } from '../../src/chain/fees.ts';
import { bondingCurveAddress, decodeBondingCurve, decodeGlobal, pumpPoolAuthority } from '../../src/chain/pump.ts';
import { PoolLayout, decodeGlobalConfig, decodePool, isCanonicalPool, poolAddress, poolVirtualQuoteReserves } from '../../src/chain/pump-amm.ts';
import { BondingCurveLayout } from '../../src/chain/pump.ts';
import { isOnCurve } from '../../src/chain/address.ts';
import { decodeAddressBytes } from '../../src/chain/base58.ts';
import { recordFromRpc, transactionEvents } from '../../src/chain/transaction.ts';
import type { FeeConfig } from '../../src/amm/fees.ts';
import { decodeMint, decodeTokenAccount } from '../../src/chain/token.ts';
import { PUMP_AMM_PROGRAM, PUMP_FEES_PROGRAM, PUMP_PROGRAM, NATIVE_MINT } from '../../src/chain/programs.ts';
import { ACCOUNTS, TRANSACTIONS, type AccountFixture, account, accountsLabelled, idlDecode, normalize } from './helpers.ts';

const data = (a: AccountFixture) => fromBase64(a.dataBase64);
const oracle = (program: 'pump' | 'pump_amm' | 'pump_fees', name: string, a: AccountFixture) => idlDecode(program, name, data(a).subarray(8));

describe('pump accounts', () => {
  it('Global decodes and equals the IDL decode', () => {
    const a = account('pump Global');
    expect(a.owner).toBe(PUMP_PROGRAM);
    const g = decodeGlobal(data(a));
    expect(normalize(g.value)).toEqual(normalize(oracle('pump', 'Global', a).value));
    expect(g.value.initialized).toBe(true);
    // CORE-2 read these launch parameters from the same account on 2026-10-03.
    expect(g.value.initialVirtualTokenReserves).toBe(1_073_000_000_000_000n);
    expect(g.value.tokenTotalSupply).toBe(1_000_000_000_000_000n);
  });

  const curves = ACCOUNTS.filter((a) => a.label.includes('bonding curve'));
  it.each(curves.map((a) => [`${a.label} ${a.address}`, a] as const))('%s', (_n, a) => {
    expect(a.owner).toBe(PUMP_PROGRAM);
    const c = decodeBondingCurve(data(a));
    expect(normalize(c.value)).toEqual(normalize(oracle('pump', 'BondingCurve', a).value));
    // A graduated curve is emptied by migrate; a live one always has virtual reserves.
    if (!c.value.complete) expect(c.value.virtualTokenReserves).toBeGreaterThan(0n);
  });

  it('reads a 2024 curve: allocated at 150 bytes, so later fields read as the zeros the program also reads', () => {
    const a = account('Fartcoin bonding curve (2024 layout)');
    expect(bondingCurveAddress('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' as Address)).toBe(a.address);
    const c = decodeBondingCurve(data(a));
    expect(c.value.complete).toBe(true);
    expect(c.value.isHolderReward).toBe(false);
    expect(c.trailing).toBe(150 - 8 - 117);
    expect(c.trailingNonZero).toBe(false);
  });

  it('reads a curve shorter than the current layout with the missing fields absent, never defaulted', () => {
    const bytes = data(account('Fartcoin bonding curve (2024 layout)'));
    // The 2025-04 layout (6 fields) ends at 8 + 5 * 8 + 1 = 49 bytes; with `creator` (2025-05) at 81.
    const first = decodeBondingCurve(bytes.subarray(0, 49)).value;
    expect(Object.keys(first)).toHaveLength(6);
    expect(first.creator).toBeUndefined();
    const second = decodeBondingCurve(bytes.subarray(0, 81)).value;
    expect(second.creator).toBeDefined();
    expect(second.isMayhemMode).toBeUndefined();
    expect(() => decodeBondingCurve(bytes.subarray(0, 60))).toThrow(DecodeError);
  });

  it('sits each current curve at PDA(["bonding-curve", mint]) of its create_v2 mint', () => {
    const mints = accountsLabelled('pump create_v2 mint');
    expect(mints.length).toBeGreaterThan(0);
    for (const m of mints) {
      const curve = ACCOUNTS.find((a) => a.label === 'pump bonding curve (current layout)' && a.address === bondingCurveAddress(m.address as Address));
      expect(curve).toBeDefined();
      const c = decodeBondingCurve(data(curve!)).value;
      expect(c.isMayhemMode).toBeTypeOf('boolean');
      const mint = decodeMint(data(m), m.owner as Address);
      expect(mint.program).toBe('token-2022');
      expect(mint.mintAuthority).toBeNull();
      expect(mint.freezeAuthority).toBeNull();
      expect(mint.extensions.map((e) => e.kind)).toEqual(expect.arrayContaining(['MetadataPointer', 'TokenMetadata']));
    }
  });

  it('refuses data with the wrong discriminator (the check itself, not a later field)', () => {
    const curve = data(account('pump bonding curve (mayhem coin)')).slice();
    curve.set(PoolLayout.discriminator, 0);
    expect(() => decodeBondingCurve(curve)).toThrow(/discriminator/);
    const pool = data(accountsLabelled('canonical PumpSwap pool')[0]!).slice();
    pool.set(BondingCurveLayout.discriminator, 0);
    expect(() => decodePool(pool)).toThrow(/discriminator/);
  });

  it('reads the mayhem flag from the curve of a mayhem coin', () => {
    const c = decodeBondingCurve(data(account('pump bonding curve (mayhem coin)'))).value;
    expect(c.isMayhemMode).toBe(true);
    const normal = ACCOUNTS.filter((a) => a.label === 'pump bonding curve (current layout)').map((a) => decodeBondingCurve(data(a)).value.isMayhemMode);
    expect(normal.length).toBeGreaterThan(0);
    expect(normal.every((m) => m === false)).toBe(true);
  });
});

describe('PumpSwap GlobalConfig', () => {
  it('decodes, equals the IDL decode and names a boost authority', () => {
    const a = account('PumpSwap GlobalConfig');
    expect(a.owner).toBe(PUMP_AMM_PROGRAM);
    const g = decodeGlobalConfig(data(a));
    expect(normalize(g.value)).toEqual(normalize(oracle('pump_amm', 'GlobalConfig', a).value));
    expect(g.value.boostAuthority).toBeDefined();
    expect(g.value.mayhemModeEnabled).toBeTypeOf('boolean');
  });
});

describe('fee configs', () => {
  it.each(['pump FeeConfig', 'PumpSwap FeeConfig'])('%s decodes, equals the IDL decode and has ascending tiers', (label) => {
    const a = account(label);
    expect(a.owner).toBe(PUMP_FEES_PROGRAM);
    const c = decodeFeeConfig(data(a));
    expect(normalize(c.value)).toEqual(normalize(oracle('pump_fees', 'FeeConfig', a).value));
    const s = feeSchedules(c.value);
    expect(s.feeTiers.length).toBeGreaterThan(0);
    for (let i = 1; i < s.feeTiers.length; i++) expect(s.feeTiers[i]!.marketCapThreshold).toBeGreaterThanOrEqual(s.feeTiers[i - 1]!.marketCapThreshold);
    expect(s.exoticFlatFees).toBeDefined();
  });

  it('feeSchedules returns core/amm FeeConfig and refuses a config that predates exotic fees', () => {
    const c = decodeFeeConfig(data(account('PumpSwap FeeConfig'))).value;
    const forAmm: FeeConfig = feeSchedules(c);
    expect(forAmm.exoticFlatFees).toBeDefined();
    const { exoticFlatFees: _gone, ...old } = c;
    expect(() => feeSchedules(old)).toThrow(DecodeError);
  });

  it('PumpSwap tiers match docs/ARCHITECTURE.md section 4: 1.25% under 420 SOL, 0.30% from 98,240 SOL, 0.30% flat for non-canonical', () => {
    const s = feeSchedules(decodeFeeConfig(data(account('PumpSwap FeeConfig'))).value);
    const total = (f: { lp: number; protocol: number; creator: number }) => f.lp + f.protocol + f.creator;
    expect(total(s.feeTiers[0]!.fees)).toBe(125);
    const last = s.feeTiers.at(-1)!;
    expect(last.marketCapThreshold).toBe(98_240_000_000_000n);
    expect(total(last.fees)).toBe(30);
    expect(total(s.flatFees)).toBe(30);
  });
});

describe('PumpSwap pools', () => {
  const pools = ACCOUNTS.filter((a) => a.owner === PUMP_AMM_PROGRAM && a.label.toLowerCase().includes('pool') && !a.label.includes('vault'));

  it.each(pools.map((a) => [`${a.label} ${a.address}`, a] as const))('%s equals the IDL decode and sits at its pool PDA', (_n, a) => {
    const p = decodePool(data(a)).value;
    const o = oracle('pump_amm', 'Pool', a).value as Record<string, unknown>;
    expect(normalize(p)).toEqual(normalize(o));
    expect(poolAddress(p.index, p.creator, p.baseMint, p.quoteMint)).toBe(a.address);
  });

  it('classifies pools the same way independent evidence does', () => {
    // Canonical: the migration fixture's own events say pump's migrate created this pool with this creator.
    const migration = TRANSACTIONS.find((t) => t.label.startsWith('migration'))!;
    const evs = transactionEvents(recordFromRpc(migration.signature, migration.base64 as never));
    const mig = evs.find((e) => e.name === 'CompletePumpAmmMigrationEvent');
    const created = evs.find((e) => e.name === 'CreatePoolEvent');
    if (mig?.name !== 'CompletePumpAmmMigrationEvent' || created?.name !== 'CreatePoolEvent') throw new Error('migration events missing');
    const migrated = account('canonical PumpSwap pool (recent migration)');
    expect(mig.data.pool).toBe(migrated.address);
    const mp = decodePool(data(migrated)).value;
    expect([mp.creator, mp.index]).toEqual([created.data.creator, created.data.index]);
    expect(isCanonicalPool(mp, migrated.address as Address)).toBe(true);
    // Non-canonical: its creator is a wallet key (on the curve), and a pool-authority PDA never is.
    for (const a of accountsLabelled('non-canonical PumpSwap pool')) {
      const p = decodePool(data(a)).value;
      expect(isOnCurve(decodeAddressBytes(p.creator))).toBe(true);
      expect(isCanonicalPool(p, a.address as Address)).toBe(false);
    }
  });

  it('classifies canonical and non-canonical pools', () => {
    const canon = accountsLabelled('canonical PumpSwap pool');
    expect(canon.length).toBeGreaterThan(0);
    for (const a of canon) {
      const p = decodePool(data(a)).value;
      expect(isCanonicalPool(p, a.address as Address)).toBe(true);
      expect(p.creator).toBe(pumpPoolAuthority(p.baseMint));
    }
    const non = accountsLabelled('non-canonical PumpSwap pool');
    for (const a of non) expect(isCanonicalPool(decodePool(data(a)).value, a.address as Address)).toBe(false);
  });

  it('poolAddress refuses any index that is not a u16 instead of wrapping it', () => {
    const p = decodePool(data(accountsLabelled('canonical PumpSwap pool')[0]!)).value;
    for (const bad of [65536, 2 ** 32, 2 ** 32 + 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => poolAddress(bad, p.creator, p.baseMint, p.quoteMint), String(bad)).toThrow(RangeError);
    }
    expect(poolAddress(65535, p.creator, p.baseMint, p.quoteMint)).not.toBe(poolAddress(0, p.creator, p.baseMint, p.quoteMint));
  });

  it('a canonical pool refuses another account address, index 1, or a foreign creator', () => {
    const a = accountsLabelled('canonical PumpSwap pool')[0]!;
    const p = decodePool(data(a)).value;
    expect(isCanonicalPool(p, account('pump Global').address as Address)).toBe(false);
    expect(isCanonicalPool({ ...p, index: 1 }, a.address as Address)).toBe(false);
    expect(isCanonicalPool({ ...p, creator: NATIVE_MINT }, a.address as Address)).toBe(false);
  });

  it('decodes a negative virtual_quote_reserves as a signed i128', () => {
    const negatives = accountsLabelled('PumpSwap pool with negative virtual_quote_reserves');
    expect(negatives.length).toBeGreaterThan(0);
    const values = negatives.map((a) => poolVirtualQuoteReserves(decodePool(data(a)).value));
    // The pool was negative at the fixture trade; it is still checked to decode exactly as the oracle says.
    for (const [i, a] of negatives.entries()) expect(values[i]).toBe((oracle('pump_amm', 'Pool', a).value as { virtualQuoteReserves: bigint }).virtualQuoteReserves);
    expect(values.some((v) => v < 0n)).toBe(true);
  });

  it('flags non-zero bytes after the documented Pool layout (pump wrote fields no IDL describes)', () => {
    const d = decodePool(data(account('PumpSwap pool with negative virtual_quote_reserves at trade')));
    expect(d.trailing).toBeGreaterThan(0);
    expect(d.trailingNonZero).toBe(true);
    const old = decodeBondingCurve(data(account('Fartcoin bonding curve (2024 layout)')));
    expect([old.trailing, old.trailingNonZero]).toEqual([25, false]);
  });

  it('reads a pool without virtual_quote_reserves as 0 (pump NEGATIVE_VIRTUAL_QUOTE_RESERVES.md)', () => {
    const a = accountsLabelled('canonical PumpSwap pool')[0]!;
    const bytes = data(a);
    // The first 9 fields (2025-04 layout) end at byte 8 + 1 + 2 + 32*6 + 8 = 211.
    const old = decodePool(bytes.subarray(0, 211)).value;
    expect(old.virtualQuoteReserves).toBeUndefined();
    expect(poolVirtualQuoteReserves(old)).toBe(0n);
  });

  it('vaults of a canonical pool hold its base and quote mints and belong to the pool', () => {
    let checked = 0;
    for (const pool of accountsLabelled('canonical PumpSwap pool')) {
      const p = decodePool(data(pool)).value;
      const base = ACCOUNTS.find((v) => v.address === p.poolBaseTokenAccount);
      const quote = ACCOUNTS.find((v) => v.address === p.poolQuoteTokenAccount);
      if (!base || !quote) continue;
      const b = decodeTokenAccount(data(base), base.owner as Address);
      const q = decodeTokenAccount(data(quote), quote.owner as Address);
      expect([b.mint, b.owner]).toEqual([p.baseMint, pool.address]);
      expect([q.mint, q.owner]).toEqual([p.quoteMint, pool.address]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
