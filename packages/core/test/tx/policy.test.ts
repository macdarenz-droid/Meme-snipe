// TX-1 item 3 and the card's accept line "built transactions pass the signer policy checks (shared decoder)": every
// built transaction passes; every deny rule has a transaction that trips it. Transactions are decoded by DEC-1.
import { describe, expect, test } from 'vitest';
import {
  type Address,
  type LoadedAddresses,
  type LookupTable,
  NATIVE_MINT,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM,
  PUMP_FEES_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  U64_MAX,
  addressBytes,
  decodeTransaction,
  fromBase64,
  resolveLookups,
} from '../../src/chain/index.ts';
import {
  type BuiltTransaction,
  HELIUS_SENDER_TIP_ACCOUNTS,
  type Instruction,
  JITO_DONT_FRONT,
  MAX_CREATED_ACCOUNT_BYTES,
  type SignerPolicyContext,
  associatedTokenAddress,
  buildTrade,
  checkSignerPolicy,
  closeAccount,
  compileV0,
  createAssociatedTokenIdempotent,
  rentExempt,
  setComputeUnitLimit,
  setComputeUnitPrice,
  syncNative,
  transfer,
} from '../../src/tx/index.ts';
import { POLICY, RATES, common, goldenOf, request } from './fixtures-policy.ts';
import { type Kind, realTx } from './helpers.ts';

const KINDS: readonly Kind[] = ['curve-buy', 'curve-sell', 'pool-buy', 'pool-sell'];
const OWNER = '7xQYoUjUJF1Kg6WVczoTAkaNhn5syQYcbvjmFrhjWpx' as Address;
const STRANGER = '9yJtCgjHJrzh6pJTFVNHdmEH3crWatP9cnZZW7K5myQt' as Address;

const built = (kind: Kind, closeTokenAccount = true, over: Parameters<typeof common>[1] = {}): BuiltTransaction => {
  const r = buildTrade(request(kind, closeTokenAccount), common(goldenOf(kind), over), POLICY);
  if (!r.ok) throw new Error(r.detail);
  return r.tx;
};

const ctxFor = (wallet: Address, over: Partial<SignerPolicyContext> = {}): SignerPolicyContext => ({
  wallet,
  kind: 'trade',
  maxSolOut: 10n ** 12n,
  maxPriorityFeeLamports: POLICY.maxPriorityFeeLamports,
  maxTipLamports: POLICY.maxTipLamports,
  tipAccounts: POLICY.tipAccounts,
  withdrawalAddress: OWNER,
  lamportsPerSignature: RATES.lamportsPerSignature,
  rent: RATES.rent,
  ...over,
});

const NONE: LoadedAddresses = { writable: [], readonly: [] };
const verdict = (wire: Uint8Array, ctx: SignerPolicyContext, loaded = NONE) => checkSignerPolicy(decodeTransaction(wire), loaded, ctx);

const WALLET = common(goldenOf('pool-buy')).wallet;
const BLOCKHASH = common(goldenOf('pool-buy')).recentBlockhash;
const CB = [setComputeUnitLimit(100_000), setComputeUnitPrice(200_000n)];
const TIP = transfer(WALLET, HELIUS_SENDER_TIP_ACCOUNTS[0]!, 5_000n, [JITO_DONT_FRONT]);
const compile = (ixs: readonly Instruction[], payer = WALLET) => compileV0(payer, ixs, BLOCKHASH, [], () => false).wire;
const violations = (ixs: readonly Instruction[], over: Partial<SignerPolicyContext> = {}, payer = WALLET) => verdict(compile(ixs, payer), ctxFor(WALLET, over)).violations;

describe('built transactions pass the signer policy', () => {
  test.each(KINDS)('%s', (kind) => {
    for (const close of [true, false]) {
      const tx = built(kind, close);
      const wallet = common(goldenOf(kind)).wallet;
      const v = verdict(tx.compiled.wire, ctxFor(wallet));
      expect(v.violations).toEqual([]);
      // The policy's own worst case, from the bytes, covers the builder's itemised one.
      expect(v.solOut).toBeGreaterThanOrEqual(tx.solOut.total);
      // Exactly at the limit passes; one lamport less fails.
      expect(verdict(tx.compiled.wire, ctxFor(wallet, { maxSolOut: v.solOut })).ok).toBe(true);
      expect(verdict(tx.compiled.wire, ctxFor(wallet, { maxSolOut: v.solOut - 1n })).violations).toEqual([`worst-case SOL out ${v.solOut} is above the allowed ${v.solOut - 1n}`]);
    }
  });

  test.each(KINDS)('%s with lookup tables (resolved by DEC-1)', (kind) => {
    const plain = built(kind);
    const all = [...new Set(plain.instructions.flatMap((ix) => ix.accounts.map((m) => m.address)))];
    const table = 'AddressLookupTab1e1111111111111111111111111' as Address;
    const tx = built(kind, true, { lookupTables: [{ address: table, addresses: all }] });
    const decoded = decodeTransaction(tx.compiled.wire);
    const lt: LookupTable = { deactivationSlot: U64_MAX, lastExtendedSlot: 1n, lastExtendedSlotStartIndex: 0, authority: null, addresses: all };
    const loaded = resolveLookups(decoded.addressTableLookups, new Map([[table, lt]]), 10n);
    expect(checkSignerPolicy(decoded, loaded, ctxFor(common(goldenOf(kind)).wallet)).violations).toEqual([]);
  });

  test('the worst case for a pool buy is fees + tip + the wrapped spend + charged creations', () => {
    const tx = built('pool-buy');
    const v = verdict(tx.compiled.wire, ctxFor(WALLET));
    const fee = tx.priorityFee;
    // Base ATA created and not closed (1) + four venue creations (accumulator, protocol-fee, coin-creator and buyback
    // quote ATAs); the wrapped-SOL ATA is closed in the same transaction. The wrap and the spend are both 0.04 SOL.
    expect(v.solOut).toBe(5_000n + fee + 5_000n + 40_000_000n + 5n * rentExempt(170, RATES.rent));
  });
});

describe('deny rules', () => {
  test('fee payer and signers', () => {
    expect(verdict(built('pool-buy').compiled.wire, ctxFor(STRANGER)).violations).toContain('fee payer is not the bot wallet');
    const second = { ...transfer(STRANGER, HELIUS_SENDER_TIP_ACCOUNTS[0]!, 5_000n) };
    expect(violations([...CB, TIP, second])).toEqual(expect.arrayContaining(['exactly one signer is allowed, got 2', 'instruction 3: transfer must come from the bot wallet']));
  });

  test('programs and instructions outside the allowlist', () => {
    const jupiter = { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUJoi5QNyVTaV4' as Address, accounts: [], data: Uint8Array.of(1) };
    expect(violations([...CB, TIP, jupiter])).toContain('instruction 3: program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUJoi5QNyVTaV4 is not allowed');
    const wsol = associatedTokenAddress(WALLET, NATIVE_MINT, TOKEN_PROGRAM);
    const approve = { programId: TOKEN_PROGRAM, accounts: [{ address: wsol, signer: false, writable: true }, { address: STRANGER, signer: false, writable: false }, { address: WALLET, signer: true, writable: false }], data: Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 0, 0) };
    expect(violations([...CB, TIP, approve])).toContain('instruction 3: token instruction 4 is not allowed');
    const setAuthority = { ...approve, data: Uint8Array.of(6, 2, 1, ...new Uint8Array(32)) };
    expect(violations([...CB, TIP, setAuthority])).toContain('instruction 3: token instruction 6 is not allowed');
    const heap = { programId: CB[0]!.programId, accounts: [], data: Uint8Array.of(1, 0, 0, 1, 0) };
    expect(violations([...CB, TIP, heap])).toContain('instruction 3: compute budget instruction 1 is not allowed');
    const createAccount = { ...transfer(WALLET, STRANGER, 1n), data: Uint8Array.of(0, 0, 0, 0, ...new Uint8Array(8)) };
    expect(violations([...CB, TIP, createAccount])).toContain('instruction 3: only System transfer is allowed');
    const legacyCreate = { ...createAssociatedTokenIdempotent(WALLET, associatedTokenAddress(WALLET, NATIVE_MINT, TOKEN_PROGRAM), WALLET, NATIVE_MINT, TOKEN_PROGRAM), data: new Uint8Array() };
    expect(violations([...CB, TIP, legacyCreate])).toContain('instruction 3: only CreateIdempotent is allowed on the associated token program');
  });

  test('transfers: only tips (capped, at most one), the wallet\'s own wrap, and withdrawals to the saved address', () => {
    expect(violations([...CB, transfer(WALLET, STRANGER, 10n)])).toContain(`instruction 2: transfer to ${STRANGER} is not allowed`);
    expect(violations([...CB, transfer(WALLET, HELIUS_SENDER_TIP_ACCOUNTS[0]!, 10_001n)])).toContain('tip 10001 is above the 10000 ceiling');
    expect(violations([...CB, TIP, transfer(WALLET, HELIUS_SENDER_TIP_ACCOUNTS[1]!, 1n)])).toContain('at most one tip, got 2');
    expect(violations([...CB, transfer(WALLET, HELIUS_SENDER_TIP_ACCOUNTS[0]!, 5_000n, [STRANGER])])).toContain(`instruction 2: extra transfer account ${STRANGER} is not allowed`);
    const writableMarker = { ...TIP, accounts: [...TIP.accounts.slice(0, 2), { address: JITO_DONT_FRONT, signer: false, writable: true }] };
    expect(violations([...CB, writableMarker])).toContain(`instruction 2: extra transfer account ${JITO_DONT_FRONT} is not allowed`);
    // Withdrawals: the saved owner address only, and only as a withdrawal.
    expect(violations([...CB, TIP, transfer(WALLET, OWNER, 1_000_000n)], { kind: 'withdraw' })).toEqual([]);
    expect(violations([...CB, TIP, transfer(WALLET, STRANGER, 1_000_000n)], { kind: 'withdraw' })).toContain(`instruction 3: transfer to ${STRANGER} is not allowed`);
    expect(violations([...CB, TIP, transfer(WALLET, OWNER, 1_000_000n)])).toContain(`instruction 3: transfer to ${OWNER} is not allowed`);
    expect(violations([...CB, TIP, transfer(WALLET, OWNER, 1_000_000n)], { kind: 'withdraw', withdrawalAddress: null })).toContain(`instruction 3: transfer to ${OWNER} is not allowed`);
    expect(verdict(built('pool-buy').compiled.wire, ctxFor(WALLET, { kind: 'withdraw' })).violations).toEqual(
      expect.arrayContaining([expect.stringMatching(/program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA is not allowed/)]),
    );
  });

  test('wrapped SOL must be closed back to the wallet; closes return lamports to the wallet only', () => {
    const wsol = associatedTokenAddress(WALLET, NATIVE_MINT, TOKEN_PROGRAM);
    const wrap = [createAssociatedTokenIdempotent(WALLET, wsol, WALLET, NATIVE_MINT, TOKEN_PROGRAM), transfer(WALLET, wsol, 1_000n), syncNative(wsol, TOKEN_PROGRAM)];
    expect(violations([...CB, TIP, ...wrap])).toContain('wrapped SOL is never closed back to the wallet');
    expect(violations([...CB, TIP, ...wrap, closeAccount(wsol, WALLET, WALLET, TOKEN_PROGRAM)], { kind: 'trade' })).toEqual(['a trade carries exactly one swap, got 0']);
    expect(violations([...CB, TIP, ...wrap, closeAccount(wsol, STRANGER, WALLET, TOKEN_PROGRAM)])).toContain('instruction 6: close must return lamports to the bot wallet');
    expect(violations([...CB, TIP, syncNative(STRANGER, TOKEN_PROGRAM)])).toContain("instruction 3: SyncNative only on the wallet's wrapped-SOL account");
    expect(violations([...CB, TIP, createAssociatedTokenIdempotent(WALLET, associatedTokenAddress(STRANGER, NATIVE_MINT, TOKEN_PROGRAM), STRANGER, NATIVE_MINT, TOKEN_PROGRAM)])).toContain(
      'instruction 3: ATA owner must be the bot wallet',
    );
  });

  test('compute budget: both instructions required, priority fee capped', () => {
    expect(violations([setComputeUnitLimit(100_000), TIP])).toContain('compute-unit limit and price are both required');
    expect(violations([setComputeUnitLimit(100_000), setComputeUnitPrice(500_001n), TIP])).toContain('priority fee 50001 is above the 50000 cap');
    expect(violations([...CB, ...CB, TIP])).toEqual(expect.arrayContaining(['instruction 2: second compute-unit limit', 'instruction 3: second compute-unit price']));
  });

  test('user-side accounts loaded from a lookup table are refused, and so is the wallet itself', () => {
    const plain = built('pool-buy');
    const all = [...new Set(plain.instructions.flatMap((ix) => ix.accounts.map((m) => m.address)))];
    const table = 'AddressLookupTab1e1111111111111111111111111' as Address;
    // A compiler that loads everything it can: the wallet's ATAs and accumulator come from the table.
    const wire = compileV0(WALLET, plain.instructions, BLOCKHASH, [{ address: table, addresses: all }], () => true).wire;
    const decoded = decodeTransaction(wire);
    const lt: LookupTable = { deactivationSlot: U64_MAX, lastExtendedSlot: 1n, lastExtendedSlotStartIndex: 0, authority: null, addresses: all };
    const loaded = resolveLookups(decoded.addressTableLookups, new Map([[table, lt]]), 10n);
    const v = checkSignerPolicy(decoded, loaded, ctxFor(WALLET)).violations;
    expect(v).toEqual(expect.arrayContaining([expect.stringMatching(/account 5 must be a static key/), expect.stringMatching(/account 6 must be a static key/), expect.stringMatching(/the new ATA must be a static key/)]));
    // Someone hands the policy a lookup result that contains the wallet. The wallet is always the static fee payer, so
    // a loaded copy is a repeated key and refused before anything else is read.
    const forged: LoadedAddresses = { writable: [WALLET, ...loaded.writable.slice(1)], readonly: loaded.readonly };
    expect(checkSignerPolicy(decoded, forged, ctxFor(WALLET)).violations).toEqual(['an account key appears more than once']);
  });

  test('swaps: the user, base account, quote account and accumulator must be the wallet\'s', () => {
    const tx = built('pool-buy');
    const swapAt = tx.instructions.findIndex((ix) => ix.programId === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    const swap = tx.instructions[swapAt]!;
    const replace = (p: number, address: Address) => tx.instructions.map((ix, i) => (i === swapAt ? { ...swap, accounts: swap.accounts.map((m, j) => (j === p ? { ...m, address } : m)) } : ix));
    expect(violations(replace(5, STRANGER))).toContain(`instruction ${swapAt}: PumpSwap buy_exact_quote_in base account is not the wallet's ATA`);
    expect(violations(replace(6, STRANGER))).toContain(`instruction ${swapAt}: PumpSwap buy_exact_quote_in quote account is not the wallet's wrapped-SOL ATA`);
    expect(violations(replace(20, STRANGER))).toContain(`instruction ${swapAt}: PumpSwap buy_exact_quote_in volume accumulator is not the wallet's`);
    expect(violations(replace(4, STRANGER))).toContain(`instruction ${swapAt}: PumpSwap buy_exact_quote_in must be quoted in wrapped SOL`);
    // Two swaps in one trade.
    expect(violations([...tx.instructions, swap])).toContain('a trade carries exactly one swap, got 2');
    // An unknown discriminator on an allowed venue program.
    const unknown = { ...swap, data: Uint8Array.of(...swap.data.subarray(0, 7), swap.data[7]! ^ 1, ...swap.data.subarray(8)) };
    expect(violations(tx.instructions.map((ix, i) => (i === swapAt ? unknown : ix)))).toEqual(expect.arrayContaining([expect.stringMatching(/instruction .* is not allowed/)]));
  });

  test('UPG-1: the undocumented pump sell_v3 and buy_exact_quote_in_v3 (live since the 2026-10-02 upgrade) are refused', () => {
    // sha256("global:sell_v3")[0..8] and sha256("global:buy_exact_quote_in_v3")[0..8]; seen on mainnet on token-quoted curves.
    for (const [kind, disc] of [['curve-sell', '1c92de7726c469d5'], ['curve-buy', 'e1f7501ed5b38488']] as const) {
      const tx = built(kind);
      const wallet = common(goldenOf(kind)).wallet;
      const at = tx.instructions.findIndex((ix) => ix.programId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
      const ix = tx.instructions[at]!;
      const v3 = { ...ix, data: Uint8Array.of(...(disc.match(/../g) ?? []).map((h) => parseInt(h, 16)), ...ix.data.subarray(8)) };
      const ixs = tx.instructions.map((x, i) => (i === at ? v3 : x));
      // A curve swap only fits with accounts in a lookup table (wallet-owned ones then add their own refusals).
      const venue = [...new Set(ixs.flatMap((x) => x.accounts.filter((m) => !m.signer && m.address !== wallet).map((m) => m.address)))];
      const table = 'AddressLookupTab1e1111111111111111111111111' as Address;
      const decoded = decodeTransaction(compileV0(wallet, ixs, BLOCKHASH, [{ address: table, addresses: venue }], () => true).wire);
      const lt: LookupTable = { deactivationSlot: U64_MAX, lastExtendedSlot: 1n, lastExtendedSlotStartIndex: 0, authority: null, addresses: venue };
      const v = checkSignerPolicy(decoded, resolveLookups(decoded.addressTableLookups, new Map([[table, lt]]), 10n), ctxFor(wallet));
      expect(v.ok).toBe(false);
      expect(v.violations).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^instruction ${at}: .+ instruction ${disc} is not allowed$`))]));
    }
  });

  test('a v1 transaction from mainnet is refused (DEC-1 fixture)', async () => {
    const { readFileSync } = await import('node:fs');
    const fx = JSON.parse(readFileSync(new URL('../chain/fixtures/transactions.json', import.meta.url), 'utf8')) as { transactions: { version: unknown; base64: { transaction: [string, string] } }[] };
    const v1 = fx.transactions.find((t) => t.version === 1)!;
    const decoded = decodeTransaction(fromBase64(v1.base64.transaction[0]));
    const v = checkSignerPolicy(decoded, NONE, ctxFor(decoded.staticAccountKeys[0]!));
    expect(v.violations).toContain('transaction version 1 is not allowed');
    expect(v.ok).toBe(false);
  });

  test('review item 1: a PumpSwap spend is charged even with no wrap transfer funding it (wSOL already in the ATA)', () => {
    const tx = built('pool-buy');
    const swapAt = tx.instructions.findIndex((ix) => ix.programId === PUMP_AMM_PROGRAM);
    const swap = tx.instructions[swapAt]!;
    const data = swap.data.slice();
    new DataView(data.buffer).setBigUint64(8, 10_000_000_000n, true); // spendable_quote_in = 10 SOL
    // Drop the wrap transfer and SyncNative; keep everything else, including the wSOL ATA create and close.
    const ixs = tx.instructions
      .map((ix, i) => (i === swapAt ? { ...swap, data } : ix))
      .filter((ix) => !(ix.programId === SYSTEM_PROGRAM && ix.accounts[1]!.address === associatedTokenAddress(WALLET, NATIVE_MINT, TOKEN_PROGRAM)))
      .filter((ix) => !(ix.programId === TOKEN_PROGRAM && ix.data.length === 1 && ix.data[0] === 17));
    const v = verdict(compile(ixs), ctxFor(WALLET, { maxSolOut: 100_000_000n }));
    expect(v.ok).toBe(false);
    expect(v.solOut).toBeGreaterThan(10_000_000_000n);
    expect(v.violations).toEqual([`worst-case SOL out ${v.solOut} is above the allowed 100000000`]);
    // The normal build charges the spend once, not wrap plus spend.
    const normal = verdict(tx.compiled.wire, ctxFor(WALLET));
    expect(normal.solOut).toBeLessThan(2n * 40_000_000n);
  });

  test('review item 2: a repeated account key is refused (static or loaded)', () => {
    const wire = built('pool-buy').compiled.wire.slice();
    const decoded = decodeTransaction(wire);
    const at = decoded.staticAccountKeys.indexOf(PUMP_AMM_GLOBAL_CONFIG);
    expect(at).toBeGreaterThan(0);
    // Overwrite the static GlobalConfig key with the pump-fees program key, which is already a static key.
    const offset = wire.indexOf(0x80, 65) + 4 + 1 + 32 * at;
    wire.set(addressBytes(PUMP_FEES_PROGRAM), offset);
    const forged = decodeTransaction(wire);
    expect(forged.staticAccountKeys[at]).toBe(PUMP_FEES_PROGRAM);
    expect(new Set(forged.staticAccountKeys).size).toBe(forged.staticAccountKeys.length - 1);
    expect(checkSignerPolicy(forged, NONE, ctxFor(WALLET))).toEqual({ ok: false, violations: ['an account key appears more than once'], solOut: 0n });
    // A loaded key equal to a static key is refused the same way.
    const plain = built('pool-buy');
    const all = [...new Set(plain.instructions.flatMap((ix) => ix.accounts.map((m) => m.address)))];
    const table = 'AddressLookupTab1e1111111111111111111111111' as Address;
    const lt = built('pool-buy', true, { lookupTables: [{ address: table, addresses: all }] });
    const d2 = decodeTransaction(lt.compiled.wire);
    const loaded = resolveLookups(d2.addressTableLookups, new Map([[table, { deactivationSlot: U64_MAX, lastExtendedSlot: 1n, lastExtendedSlotStartIndex: 0, authority: null, addresses: all }]]), 10n);
    const twice: LoadedAddresses = { writable: loaded.writable, readonly: [d2.staticAccountKeys[1]!, ...loaded.readonly.slice(1)] };
    expect(checkSignerPolicy(d2, twice, ctxFor(WALLET)).violations).toEqual(['an account key appears more than once']);
  });

  test('review note: every possible creation is charged at the largest account size, never a caller figure', () => {
    expect(MAX_CREATED_ACCOUNT_BYTES).toBe(170);
    // Every size the real builders can create or top up fits under it. Sizes are read from the builders' own rent
    // accounting at one lamport per byte: with every other account read as existing, the extra rent charged for one
    // missing account is (overhead + its bytes); what is charged with nothing missing is a top-up in bytes.
    const perByte = { ...RATES, rent: { lamportsPerByte: 1n } };
    const overhead = rentExempt(0, perByte.rent);
    const sizes = new Set<number>();
    const rentOf = (req: ReturnType<typeof request>, kind: Kind, existing: ReadonlySet<Address>): bigint => {
      const r = buildTrade(req, common(goldenOf(kind), { rates: perByte, existing }), POLICY);
      if (!r.ok) throw new Error(r.detail);
      return r.tx.solOut.rent;
    };
    for (const kind of KINDS) {
      // Closing the token account only changes sells.
      for (const close of kind.endsWith('sell') ? [true, false] : [true]) {
        const real = request(kind, close);
        const { instructions } = built(kind, close);
        const keys = [...new Set(instructions.flatMap((ix) => ix.accounts.map((m) => m.address)))];
        // Only a writable account can be created or topped up; read-only keys are kept as existing.
        const writable = new Set(instructions.flatMap((ix) => ix.accounts.filter((m) => m.writable).map((m) => m.address)));
        // The real curve, and the smallest curve the builder accepts (the largest growth to the target size).
        const reqs = real.venue === 'curve' ? [real, { ...real, market: { ...real.market, accountBytes: 0 } }] : [real];
        for (const req of reqs) {
          const topUp = rentOf(req, kind, new Set(keys));
          sizes.add(Number(topUp));
          for (const k of writable) {
            const extra = rentOf(req, kind, new Set(keys.filter((x) => x !== k))) - topUp;
            if (extra > 0n) sizes.add(Number(extra - overhead));
          }
        }
      }
    }
    // Creator-vault top-up to rent-exempt (0), accumulator, curve growth, venue quote ATA, Token-2022 base ATA.
    expect([...sizes].sort((x, y) => x - y)).toEqual([0, 137, 151, 165, 170]);
    for (const bytes of sizes) expect(bytes).toBeLessThanOrEqual(MAX_CREATED_ACCOUNT_BYTES);
    // The bound is tight: some builder really creates an account of the largest size.
    expect(Math.max(...sizes)).toBe(MAX_CREATED_ACCOUNT_BYTES);
    expect('maxRentPerAccount' in ctxFor(WALLET)).toBe(false);
  });
});

