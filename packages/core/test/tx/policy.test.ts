// TX-1 item 3 and the card's accept line "built transactions pass the signer policy checks (shared decoder)": every
// built transaction passes; every deny rule has a transaction that trips it. Transactions are decoded by DEC-1.
import { describe, expect, test } from 'vitest';
import {
  type Address,
  type LoadedAddresses,
  type LookupTable,
  NATIVE_MINT,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  U64_MAX,
  decodeTransaction,
  fromBase64,
  resolveLookups,
} from '../../src/chain/index.ts';
import {
  type BuiltTransaction,
  HELIUS_SENDER_TIP_ACCOUNTS,
  type Instruction,
  JITO_DONT_FRONT,
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
  maxRentPerAccount: rentExempt(170, RATES.rent),
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
    // Base ATA created and not closed (1) + three venue creations; the wrapped-SOL ATA is closed in the same transaction.
    expect(v.solOut).toBe(5_000n + fee + 5_000n + 40_000_000n + 4n * rentExempt(170, RATES.rent));
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
    // Someone hands the policy a lookup result that contains the wallet.
    const forged: LoadedAddresses = { writable: [WALLET, ...loaded.writable.slice(1)], readonly: loaded.readonly };
    expect(checkSignerPolicy(decoded, forged, ctxFor(WALLET)).violations).toContain('the bot wallet is loaded from a lookup table');
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

  test('a v1 transaction from mainnet is refused (DEC-1 fixture)', async () => {
    const { readFileSync } = await import('node:fs');
    const fx = JSON.parse(readFileSync(new URL('../chain/fixtures/transactions.json', import.meta.url), 'utf8')) as { transactions: { version: unknown; base64: { transaction: [string, string] } }[] };
    const v1 = fx.transactions.find((t) => t.version === 1)!;
    const decoded = decodeTransaction(fromBase64(v1.base64.transaction[0]));
    const v = checkSignerPolicy(decoded, NONE, ctxFor(decoded.staticAccountKeys[0]!));
    expect(v.violations).toContain('transaction version 1 is not allowed');
    expect(v.ok).toBe(false);
  });
});
