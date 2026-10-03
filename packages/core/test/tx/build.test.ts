// TX-1 items 1 and 2: unsigned buy and sell transactions for both venues, serialized as v0 with lookup tables. Every
// built transaction is decoded by the DEC-1 decoder and checked account by account, program by program and amount by
// amount against the intent. Rent, fees and tip add up exactly to the worst-case SOL out.
import { describe, expect, test } from 'vitest';
import {
  type Address,
  type DecodedTransaction,
  type LoadedAddresses,
  type LookupTable,
  type Mint,
  NATIVE_MINT,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  U64_MAX,
  accountKeys,
  decodeTransaction,
  isSigner,
  isWritable,
  resolveLookups,
} from '../../src/chain/index.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  type BuiltTransaction,
  COMPUTE_BUDGET_PROGRAM,
  DISC,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_DONT_FRONT,
  MAX_TRANSACTION_BYTES,
  MICRO_LAMPORTS_PER_LAMPORT,
  type TradeRequest,
  associatedTokenAccountSize,
  associatedTokenAddress,
  buildTrade,
  compileV0,
  minOutFromQuote,
  rentExempt,
  transfer,
  userVolumeAccumulator,
  poolCoinCreatorVaultAuthority,
  pumpCreatorVault,
} from '../../src/tx/index.ts';
import { bps, lamports } from '../../src/units/index.ts';
import { CALIBRATION, POLICY, RATES, SPEND, common, goldenOf, request } from './fixtures-policy.ts';
import { type Kind, goldenAccount, hex, mintOf, u64le } from './helpers.ts';

const KINDS: readonly Kind[] = ['curve-buy', 'curve-sell', 'pool-buy', 'pool-sell'];

const build = (req: TradeRequest, over: Parameters<typeof common>[1] = {}, policy = POLICY): BuiltTransaction => {
  const g = goldenOf(`${req.venue}-${req.side}` as Kind);
  const r = buildTrade(req, common(g, over), policy);
  if (!r.ok) throw new Error(`${r.reason}: ${r.detail}`);
  return r.tx;
};

/** Decodes the wire bytes with DEC-1 and checks each instruction maps back to exactly what was built. */
const roundTrip = (tx: BuiltTransaction, loaded: LoadedAddresses = { writable: [], readonly: [] }): { decoded: DecodedTransaction; keys: Address[] } => {
  const decoded = decodeTransaction(tx.compiled.wire);
  expect(decoded.version).toBe(0);
  expect(decoded.signatures).toEqual(['1111111111111111111111111111111111111111111111111111111111111111']);
  expect(decoded.message).toEqual(tx.compiled.message);
  const keys = accountKeys(decoded, loaded);
  expect(decoded.instructions.length).toBe(tx.instructions.length);
  decoded.instructions.forEach((ix, i) => {
    const built = tx.instructions[i]!;
    expect(keys[ix.programIdIndex]).toBe(built.programId);
    expect(ix.accounts.map((a) => keys[a])).toEqual(built.accounts.map((m) => m.address));
    expect(hex(ix.data)).toBe(hex(built.data));
    ix.accounts.forEach((a, j) => {
      const m = built.accounts[j]!;
      if (m.writable) expect(isWritable(decoded, a, loaded)).toBe(true);
      expect(isSigner(decoded, a)).toBe(m.address === decoded.staticAccountKeys[0]);
      if (m.signer) expect(isSigner(decoded, a)).toBe(true);
    });
  });
  return { decoded, keys };
};

const programsOf = (tx: BuiltTransaction) => tx.instructions.map((ix) => ix.programId);

describe('built transactions decode back to the intent (DEC-1 round trip)', () => {
  test.each(KINDS)('%s', (kind) => {
    const req = request(kind);
    const g = goldenOf(kind);
    const tx = build(req);
    const { decoded, keys } = roundTrip(tx);
    const c = common(g);
    expect(decoded.staticAccountKeys[0]).toBe(c.wallet);
    expect(decoded.header.numRequiredSignatures).toBe(1);
    expect(decoded.recentBlockhash).toBe(c.recentBlockhash);
    expect(tx.compiled.wire.length).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);

    // Compute budget from the calibration table and the requested priority fee.
    const limit = CALIBRATION[tx.shape]!;
    expect(tx.computeUnitLimit).toBe(limit);
    expect(hex(decoded.instructions[0]!.data)).toBe(hex(Uint8Array.of(2, limit & 0xff, (limit >> 8) & 0xff, (limit >> 16) & 0xff, limit >>> 24)));
    const price = (20_000n * MICRO_LAMPORTS_PER_LAMPORT) / BigInt(limit);
    expect(u64le(decoded.instructions[1]!.data, 1)).toBe(price);
    expect(tx.priorityFee).toBe((price * BigInt(limit) + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT);
    expect(tx.priorityFee).toBeLessThanOrEqual(20_000n);

    // The swap: program, discriminator, amount and min-out from the quote and the slippage.
    const swap = decoded.instructions.find((ix) => keys[ix.programIdIndex] === PUMP_PROGRAM || keys[ix.programIdIndex] === PUMP_AMM_PROGRAM)!;
    const quoted = req.side === 'buy' ? (req.venue === 'curve' ? req.quote.tokens : req.quote.base) : req.quote.userQuote;
    const amountIn = req.side === 'buy' ? req.spend : req.venue === 'curve' ? req.quote.tokens : req.quote.base;
    const disc = { 'curve-buy': DISC.curveBuyExactQuoteInV2, 'curve-sell': DISC.curveSellV2, 'pool-buy': DISC.poolBuyExactQuoteIn, 'pool-sell': DISC.poolSell }[kind];
    expect(hex(swap.data.subarray(0, 8))).toBe(disc);
    expect(u64le(swap.data, 8)).toBe(amountIn);
    expect(u64le(swap.data, 16)).toBe(minOutFromQuote(quoted, bps(250)));
    expect(u64le(swap.data, 16)).toBe((quoted * 9_750n) / 10_000n);
    expect(tx.quote).toEqual({ provider: `direct-${req.venue}`, requestId: null, inAmount: amountIn, quotedOut: quoted, minOut: (quoted * 9_750n) / 10_000n, slippage: 250, quotedAtSlot: BigInt(g.slot) });
    // The swap's user and token accounts are the wallet's own.
    const at = (p: number) => keys[swap.accounts[p]!]!;
    const baseProgram = req.market.baseTokenProgram;
    if (req.venue === 'curve') {
      expect([at(13), at(14), at(15)]).toEqual([c.wallet, associatedTokenAddress(c.wallet, req.market.mint, baseProgram), associatedTokenAddress(c.wallet, NATIVE_MINT, TOKEN_PROGRAM)]);
      expect(at(16)).toBe(pumpCreatorVault(req.market.curve.creator!));
    } else {
      expect([at(1), at(5), at(6)]).toEqual([c.wallet, associatedTokenAddress(c.wallet, req.market.state.baseMint, baseProgram), associatedTokenAddress(c.wallet, NATIVE_MINT, TOKEN_PROGRAM)]);
      expect(at(0)).toBe(req.market.pool);
    }

    // The Sender tip: last, to the chosen tip account, with the jitodontfront marker read-only.
    const tip = decoded.instructions.at(-1)!;
    expect(keys[tip.programIdIndex]).toBe(SYSTEM_PROGRAM);
    expect(tip.accounts.map((a) => keys[a])).toEqual([c.wallet, HELIUS_SENDER_TIP_ACCOUNTS[2], JITO_DONT_FRONT]);
    expect(u64le(tip.data, 4)).toBe(5_000n);
    expect(isWritable(decoded, tip.accounts[2]!)).toBe(false);
  });

  test('instruction sequences per kind', () => {
    const cb = [COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM];
    const t22 = TOKEN_2022_PROGRAM;
    expect(programsOf(build(request('curve-buy')))).toEqual([...cb, ASSOCIATED_TOKEN_PROGRAM, PUMP_PROGRAM, SYSTEM_PROGRAM]);
    expect(programsOf(build(request('curve-sell', false)))).toEqual([...cb, PUMP_PROGRAM, SYSTEM_PROGRAM]);
    expect(programsOf(build(request('curve-sell', true)))).toEqual([...cb, PUMP_PROGRAM, t22, SYSTEM_PROGRAM]);
    expect(programsOf(build(request('pool-buy')))).toEqual([
      ...cb, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, PUMP_AMM_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM,
    ]);
    expect(programsOf(build(request('pool-sell', false)))).toEqual([...cb, ASSOCIATED_TOKEN_PROGRAM, PUMP_AMM_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM]);
    expect(programsOf(build(request('pool-sell', true)))).toEqual([...cb, ASSOCIATED_TOKEN_PROGRAM, PUMP_AMM_PROGRAM, TOKEN_PROGRAM, t22, SYSTEM_PROGRAM]);
  });

  test('a full sell closes the token account back to the wallet; the pool buy wraps exactly the spend and closes the wrap', () => {
    const sell = build(request('curve-sell', true));
    const close = sell.instructions[3]!;
    const g = goldenOf('curve-sell');
    const wallet = common(g).wallet;
    const req = request('curve-sell');
    if (req.venue !== 'curve') throw new Error('curve');
    expect(close.accounts.map((m) => m.address)).toEqual([associatedTokenAddress(wallet, req.market.mint, TOKEN_2022_PROGRAM), wallet, wallet]);
    const buy = build(request('pool-buy'));
    const wrap = buy.instructions[3]!;
    expect(u64le(wrap.data, 4)).toBe(SPEND);
    expect(buy.instructions[7]!.accounts[0]!.address).toBe(associatedTokenAddress(common(goldenOf('pool-buy')).wallet, NATIVE_MINT, TOKEN_PROGRAM));
  });

  test('identical inputs build identical bytes; seeded choices move the fee recipients', () => {
    for (const kind of KINDS) expect(build(request(kind)).compiled.wire).toEqual(build(request(kind)).compiled.wire);
    const a = build(request('pool-buy'));
    const b = build(request('pool-buy'), { choice: { feeRecipient: 4, buybackRecipient: 6, tipAccount: 3 } });
    expect(a.compiled.wire).not.toEqual(b.compiled.wire);
  });
});

describe('lookup tables', () => {
  test.each(KINDS)('%s: venue accounts load from a table, user-side accounts stay static, DEC-1 resolves the same keys', (kind) => {
    const req = request(kind);
    const plain = build(req);
    // A table holding every key of the transaction, user-side ones included: the compiler must still keep those static.
    const all = [...new Set(plain.instructions.flatMap((ix) => ix.accounts.map((m) => m.address)))];
    const tableAddress = 'AddressLookupTab1e1111111111111111111111111' as Address;
    const table: LookupTable = { deactivationSlot: U64_MAX, lastExtendedSlot: 1n, lastExtendedSlotStartIndex: 0, authority: null, addresses: all };
    const tx = build(req, { lookupTables: [{ address: tableAddress, addresses: all }] });
    expect(tx.compiled.wire.length).toBeLessThan(plain.compiled.wire.length);
    const decoded = decodeTransaction(tx.compiled.wire);
    expect(decoded.addressTableLookups.length).toBe(1);
    const loaded = resolveLookups(decoded.addressTableLookups, new Map([[tableAddress, table]]), 10n);
    roundTrip(tx, loaded);
    const wallet = common(goldenOf(kind)).wallet;
    const userSide = [
      wallet,
      associatedTokenAddress(wallet, NATIVE_MINT, TOKEN_PROGRAM),
      associatedTokenAddress(wallet, req.venue === 'curve' ? req.market.mint : req.market.state.baseMint, req.market.baseTokenProgram),
      ...(kind === 'curve-buy' || kind === 'curve-sell'
        ? [userVolumeAccumulator(PUMP_PROGRAM, wallet), associatedTokenAddress(userVolumeAccumulator(PUMP_PROGRAM, wallet), NATIVE_MINT, TOKEN_PROGRAM)]
        : kind === 'pool-buy' ? [userVolumeAccumulator(PUMP_AMM_PROGRAM, wallet)] : []),
    ];
    let checked = 0;
    for (const k of userSide) {
      if (!plain.instructions.some((ix) => ix.accounts.some((m) => m.address === k))) continue;
      expect(decoded.staticAccountKeys).toContain(k);
      expect([...loaded.writable, ...loaded.readonly]).not.toContain(k);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
    // Something did load from the table.
    expect(loaded.writable.length + loaded.readonly.length).toBeGreaterThan(5);
    // Programs are never loaded from a table either.
    for (const ix of decoded.instructions) expect(ix.programIdIndex).toBeLessThan(decoded.staticAccountKeys.length);
  });
});

describe('worst-case SOL out (SIMD-0437 rent, fees, tip)', () => {
  const T22_ATA = 1_513_840n; // (128 + 170) × 5,080, execution.md F2
  const SPL_ATA = 1_488_440n; // (128 + 165) × 5,080
  const UVA = 1_346_200n; // (128 + 137) × 5,080, execution.md F3
  const VAULT_TOP_UP = 650_240n; // (128 + 0) × 5,080

  test('rent helpers reproduce the measured on-chain rent', () => {
    expect(rentExempt(165, RATES.rent)).toBe(SPL_ATA);
    expect(rentExempt(170, RATES.rent)).toBe(T22_ATA);
    expect(rentExempt(137, RATES.rent)).toBe(UVA);
    expect(associatedTokenAccountSize(mintOf(goldenAccount(goldenOf('curve-buy').mint)).mint, TOKEN_2022_PROGRAM)).toEqual({ ok: true, bytes: 170 });
  });

  test('curve buy with nothing known to exist: ATA, volume accumulator, creator vault and curve growth are all charged', () => {
    const req = request('curve-buy');
    const tx = build(req);
    const growth = BigInt(Math.max(0, 151 - (req.venue === 'curve' ? req.market.accountBytes : 0))) * 5_080n;
    expect(tx.solOut).toEqual({
      baseFee: 5_000n, priorityFee: tx.priorityFee, tip: 5_000n, swap: SPEND,
      rent: T22_ATA + UVA + VAULT_TOP_UP + growth, total: 5_000n + tx.priorityFee + 5_000n + SPEND + T22_ATA + UVA + VAULT_TOP_UP + growth,
    });
  });

  test('accounts read as existing are not charged', () => {
    const req = request('curve-buy');
    if (req.venue !== 'curve') throw new Error('curve');
    const wallet = common(goldenOf('curve-buy')).wallet;
    const existing = new Set<Address>([
      associatedTokenAddress(wallet, req.market.mint, TOKEN_2022_PROGRAM), userVolumeAccumulator(PUMP_PROGRAM, wallet), pumpCreatorVault(req.market.curve.creator!),
    ]);
    const tx = build({ ...req, market: { ...req.market, accountBytes: 151 } }, { existing });
    expect(tx.solOut.rent).toBe(0n);
    expect(tx.solOut.total).toBe(5_000n + tx.priorityFee + 5_000n + SPEND);
  });

  test('pool buy: base ATA, PumpSwap volume accumulator, protocol-fee, coin-creator and buyback quote ATAs; the wrap nets to zero', () => {
    const req = request('pool-buy');
    if (req.venue !== 'pool') throw new Error('pool');
    const tx = build(req);
    expect(tx.solOut.rent).toBe(T22_ATA + UVA + 3n * SPL_ATA);
    const wallet = common(goldenOf('pool-buy')).wallet;
    const existing = new Set<Address>([
      associatedTokenAddress(wallet, req.market.state.baseMint, TOKEN_2022_PROGRAM),
      userVolumeAccumulator(PUMP_AMM_PROGRAM, wallet),
      associatedTokenAddress(req.market.globalConfig.protocolFeeRecipients[3]!, NATIVE_MINT, TOKEN_PROGRAM),
      associatedTokenAddress(req.market.globalConfig.buybackFeeRecipients![5]!, NATIVE_MINT, TOKEN_PROGRAM),
      associatedTokenAddress(poolCoinCreatorVaultAuthority(req.market.state.coinCreator!), NATIVE_MINT, TOKEN_PROGRAM),
    ]);
    expect(build(req, { existing }).solOut.rent).toBe(0n);
  });

  test('sells pay no swap SOL; a closed token account is never charged', () => {
    const tx = build(request('pool-sell', true));
    expect(tx.solOut.swap).toBe(0n);
    expect(tx.solOut.rent).toBe(3n * SPL_ATA);
  });
});

describe('refusals (no trade, with a reason)', () => {
  const refused = (req: TradeRequest, over: Parameters<typeof common>[1] = {}, policy = POLICY) => {
    const r = buildTrade(req, common(goldenOf(`${req.venue}-${req.side}` as Kind), over), policy);
    expect(r.ok).toBe(false);
    return r.ok ? null : r.reason;
  };

  test('policy limits: slippage, priority fee, tip ceiling, missing calibration', () => {
    expect(refused(request('curve-buy'), { slippageBps: 301 })).toBe('over-policy');
    expect(refused(request('curve-buy'), { priorityFeeLamports: lamports(50_001n) })).toBe('over-policy');
    expect(refused(request('curve-buy'), {}, { ...POLICY, tipLamports: lamports(10_001n) })).toBe('over-policy');
    expect(refused(request('curve-buy'), {}, { ...POLICY, calibration: {} })).toBe('over-policy');
    expect(refused(request('curve-buy'), {}, { ...POLICY, tipAccounts: [] })).toBe('over-policy');
  });

  test('amounts: a quote that spends more than the request, a min-out that rounds to zero, a fee too small to price', () => {
    const buy = request('curve-buy');
    if (buy.venue !== 'curve' || buy.side !== 'buy') throw new Error('curve buy');
    expect(refused({ ...buy, quote: { spend: SPEND, tokens: 10n, userQuote: SPEND + 1n } })).toBe('invalid-amount');
    expect(refused({ ...buy, quote: { spend: SPEND, tokens: 1n, userQuote: SPEND } })).toBe('invalid-amount');
    expect(refused(buy, { priorityFeeLamports: lamports(0n) })).toBe('invalid-amount');
  });

  test('review item 3: a quote computed for another spend is refused, so min-out is never sized for a smaller trade', () => {
    for (const kind of ['curve-buy', 'pool-buy'] as const) {
      const buy = request(kind);
      if (buy.side !== 'buy') throw new Error('buy');
      const out = buy.venue === 'curve' ? { tokens: buy.quote.tokens } : { base: buy.quote.base };
      // A 0.5 SOL quote used for a 2 SOL spend.
      const big = lamports(2_000_000_000n);
      const small = { ...out, spend: 500_000_000n, userQuote: 500_000_000n };
      expect(refused({ ...buy, spend: big, quote: small } as TradeRequest)).toBe('invalid-amount');
      // The quote names the right spend but leaves more than fee rounding unspent.
      expect(refused({ ...buy, quote: { ...out, spend: SPEND, userQuote: SPEND - 4n } } as TradeRequest)).toBe('invalid-amount');
      // Within rounding it builds.
      const ok = buildTrade({ ...buy, quote: { ...out, spend: SPEND, userQuote: SPEND - 3n } } as TradeRequest, common(goldenOf(kind)), POLICY);
      expect(ok.ok).toBe(true);
    }
  });

  test('coins and markets the builders do not trade', () => {
    const c = request('curve-buy');
    if (c.venue !== 'curve') throw new Error('curve');
    expect(refused({ ...c, market: { ...c.market, curve: { ...c.market.curve, isMayhemMode: true } } })).toBe('unsupported-coin');
    expect(refused({ ...c, market: { ...c.market, curve: { ...c.market.curve, isCashbackCoin: true } } })).toBe('unsupported-coin');
    expect(refused({ ...c, market: { ...c.market, curve: { ...c.market.curve, complete: true } } })).toBe('curve-complete');
    expect(refused({ ...c, market: { ...c.market, curve: { ...c.market.curve, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address } } })).toBe('not-sol-quoted');
    const p = request('pool-sell');
    if (p.venue !== 'pool') throw new Error('pool');
    expect(refused({ ...p, market: { ...p.market, accountBytes: 299 } })).toBe('pool-layout-outdated');
    expect(refused({ ...p, market: { ...p.market, state: { ...p.market.state, isMayhemMode: true } } })).toBe('unsupported-coin');
    expect(refused({ ...p, market: { ...p.market, state: { ...p.market.state, isCashbackCoin: true } } })).toBe('unsupported-coin');
    expect(refused({ ...p, market: { ...p.market, state: { ...p.market.state, quoteMint: TOKEN_PROGRAM } } })).toBe('not-sol-quoted');
    const feeMint: Mint = { ...p.mint, extensions: [...p.mint.extensions, { kind: 'TransferFeeConfig', type: 1, fields: {} as never, data: '' }] };
    expect(refused({ ...p, mint: feeMint })).toBe('unsupported-mint');
    expect(refused({ ...p, market: { ...p.market, baseTokenProgram: TOKEN_PROGRAM } })).toBe('unsupported-mint');
  });
});

describe('compiler limits', () => {
  test('a transaction over 1,232 bytes and a program used as a writable account are refused', () => {
    const wallet = common(goldenOf('pool-buy')).wallet;
    const many = HELIUS_SENDER_TIP_ACCOUNTS.flatMap(() => HELIUS_SENDER_TIP_ACCOUNTS).map((to, i) => transfer(wallet, to, BigInt(i + 1)));
    expect(() => compileV0(wallet, many, wallet, [], () => false)).toThrow(/1232/);
    const bad = { programId: SYSTEM_PROGRAM, accounts: [{ address: SYSTEM_PROGRAM, signer: false, writable: true }], data: new Uint8Array() };
    expect(() => compileV0(wallet, [bad], wallet, [], () => false)).toThrow(/program/);
  });
});
