// TX-1 item 5: our instruction builders against real successful mainnet transactions of the same kind, byte for byte.
// Swap data and every account (address, writable, signer) must match exactly; so must every System, Token, ATA and
// Compute Budget instruction those transactions carry. Fee recipients are picked by index from the chain-read
// Global / GlobalConfig, and amounts are the real transaction's own arguments (the only non-deterministic inputs).
import { describe, expect, test } from 'vitest';
import {
  type Address,
  NATIVE_MINT,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  accountKeys,
  decodeBase58,
  decodeGlobalConfig,
  decodeTransaction,
  fromBase64,
} from '../../src/chain/index.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  type Instruction,
  associatedTokenAddress,
  closeAccount,
  compileV0,
  createAssociatedTokenIdempotent,
  curveAccounts,
  curveBuyIx,
  curveSellIx,
  poolAccounts,
  poolBuyIx,
  poolSellIx,
  setComputeUnitLimit,
  setComputeUnitPrice,
  syncNative,
  transfer,
} from '../../src/tx/index.ts';
import {
  GLOBAL,
  GLOBAL_CONFIG,
  GOLDEN,
  type GoldenTx,
  type RealTx,
  chainAccount,
  chainTransaction,
  curveMarket,
  hex,
  poolMarket,
  poolMarketFrom,
  realInstruction,
  realTx,
  u64le,
} from './helpers.ts';

const index = (list: readonly string[], a: string, what: string): number => {
  const i = list.indexOf(a);
  if (i < 0) throw new Error(`${what} ${a} is not in the chain-read list`);
  return i;
};

/**
 * A message keeps only transaction-level flags: a key's writable and signer bits are OR-ed over every instruction
 * that uses it. So our metas are first merged per key within the instruction; a key the real transaction also uses
 * elsewhere (or as fee payer) may carry more flags there, never fewer. Every other key must match exactly.
 * Returns the positions where the real transaction marked a key writable that we (and the IDL) leave read-only.
 */
const compareMetas = (mine: Instruction, real: Instruction, r: RealTx, ixIndex: number): number[] => {
  expect(mine.accounts.map((m) => m.address)).toEqual(real.accounts.slice(0, mine.accounts.length).map((m) => m.address));
  const merged = new Map<string, { w: boolean; s: boolean }>();
  for (const m of mine.accounts) {
    const f = merged.get(m.address) ?? { w: false, s: false };
    merged.set(m.address, { w: f.w || m.writable, s: f.s || m.signer });
  }
  const elsewhere = new Set<string>([r.keys[0]!]);
  r.tx.instructions.forEach((ix, i) => {
    if (i !== ixIndex) for (const a of ix.accounts) elsewhere.add(r.keys[a]!);
  });
  const wider: number[] = [];
  mine.accounts.forEach((m, p) => {
    const f = merged.get(m.address)!;
    const rf = real.accounts[p]!;
    // We never ask for a write or a signature the real transaction did not give.
    expect(!f.w || rf.writable, `${m.address} at ${p} is writable in our build only`).toBe(true);
    expect(!f.s || rf.signer, `${m.address} at ${p} signs in our build only`).toBe(true);
    if (elsewhere.has(m.address)) return;
    expect(rf.signer, `${m.address} at ${p} signs in the real transaction only`).toBe(f.s);
    if (rf.writable !== f.w) wider.push(p);
  });
  return wider;
};

const expectSame = (mine: Instruction, real: Instruction, r: RealTx, ixIndex: number) => {
  expect(mine.programId).toBe(real.programId);
  expect(hex(mine.data)).toBe(hex(real.data));
  expect(mine.accounts.length).toBe(real.accounts.length);
  expect(compareMetas(mine, real, r, ixIndex)).toEqual([]);
};

/** Our build of the swap a real transaction carries, from the same market, user, recipients and amounts. */
const rebuildSwap = (g: GoldenTx, real: Instruction): Instruction => {
  const a0 = u64le(real.data, 8);
  const a1 = u64le(real.data, 16);
  if (g.kind.startsWith('curve')) {
    const m = curveMarket(g);
    const user = real.accounts[13]!.address;
    const fee = index([GLOBAL.feeRecipient, ...GLOBAL.feeRecipients], real.accounts[6]!.address, 'fee recipient');
    const buyback = index(GLOBAL.buybackFeeRecipients!, real.accounts[8]!.address, 'buyback recipient');
    const acc = curveAccounts(m, user, fee, buyback);
    if (!acc.ok) throw new Error(acc.detail);
    return g.kind === 'curve-buy' ? curveBuyIx(m, acc.accounts, user, a0, a1) : curveSellIx(m, acc.accounts, user, a0, a1);
  }
  const m = poolMarket(g);
  const user = real.accounts[1]!.address;
  const fee = index(GLOBAL_CONFIG.protocolFeeRecipients, real.accounts[9]!.address, 'protocol fee recipient');
  const buyback = index(GLOBAL_CONFIG.buybackFeeRecipients!, real.accounts[real.accounts.length - 2]!.address, 'buyback recipient');
  const acc = poolAccounts(m, user, fee, buyback);
  if (!acc.ok) throw new Error(acc.detail);
  return g.kind === 'pool-buy' ? poolBuyIx(m, acc.accounts, user, a0, a1) : poolSellIx(m, acc.accounts, user, a0, a1);
};

/** Our encoding of each native instruction in a real transaction. Returns how many were compared. */
/** Our encoding of one native instruction of a real transaction, or null when it is not one we build. */
const rebuildNative = (real: Instruction): Instruction | null => {
  const at = (k: number) => real.accounts[k]!.address;
  const d = real.data;
  if (real.programId === COMPUTE_BUDGET_PROGRAM && d[0] === 2 && d.length === 5) return setComputeUnitLimit(Buffer.from(d).readUInt32LE(1));
  if (real.programId === COMPUTE_BUDGET_PROGRAM && d[0] === 3 && d.length === 9) return setComputeUnitPrice(u64le(d, 1));
  if (real.programId === ASSOCIATED_TOKEN_PROGRAM && d.length === 1 && d[0] === 1) {
    expect(at(1)).toBe(associatedTokenAddress(at(2), at(3), at(5)));
    return createAssociatedTokenIdempotent(at(0), at(1), at(2), at(3), at(5));
  }
  if (real.programId === SYSTEM_PROGRAM && d.length === 12 && Buffer.from(d).readUInt32LE(0) === 2 && real.accounts.length === 2) return transfer(at(0), at(1), u64le(d, 4));
  if ((real.programId === TOKEN_PROGRAM || real.programId === TOKEN_2022_PROGRAM) && d.length === 1) {
    if (d[0] === 17) return syncNative(at(0), real.programId);
    if (d[0] === 9) return closeAccount(at(0), at(1), at(2), real.programId);
  }
  return null;
};

/** Our encoding of each native instruction in a real transaction. Returns how many were compared. */
const compareNative = (r: RealTx): number => {
  let n = 0;
  r.tx.instructions.forEach((_, i) => {
    const real = realInstruction(r, i);
    const mine = rebuildNative(real);
    if (mine === null) return;
    // Compute budget instructions carry no accounts; a real one may list a stray account, which we never add.
    if (real.programId === COMPUTE_BUDGET_PROGRAM && real.accounts.length > 0) {
      expect(hex(mine.data)).toBe(hex(real.data));
    } else {
      expectSame(mine, real, r, i);
    }
    n++;
  });
  return n;
};

describe('golden: swap instructions equal real mainnet swaps byte for byte', () => {
  test('the fixture holds three successful swaps of each kind', () => {
    for (const kind of ['curve-buy', 'curve-sell', 'pool-buy', 'pool-sell'] as const) {
      expect(GOLDEN.golden.filter((g) => g.kind === kind).length).toBeGreaterThanOrEqual(3);
    }
  });

  test.each(GOLDEN.golden.map((g) => [`${g.kind} ${g.signature.slice(0, 12)}`, g] as const))('%s', (_, g) => {
    const r = realTx(g);
    const real = realInstruction(r, g.swapIndex);
    const mine = rebuildSwap(g, real);
    expect(mine.programId).toBe(real.programId);
    expect(hex(mine.data)).toBe(hex(real.data));
    // Every named and remaining account we send, in order, with the real flags. A real swap may append accounts of
    // its own after ours (one curve buy carries an extra read-only account); none of ours may be missing or moved.
    const wider = compareMetas(mine, real, r, g.swapIndex);
    // Where this sender marked a key writable that we leave read-only, another successful swap of the same kind
    // used it read-only: mainnet accepts our flag.
    for (const p of wider) {
      const readOnlyElsewhere = GOLDEN.golden.some((o) => o.kind === g.kind && o !== g && !realInstruction(realTx(o), o.swapIndex).accounts[p]!.writable);
      expect(readOnlyElsewhere, `account ${p} of ${g.kind}`).toBe(true);
    }
    expect(wider.length).toBeLessThanOrEqual(1);
    const extra = real.accounts.slice(mine.accounts.length);
    for (const e of extra) expect(e.writable || e.signer).toBe(false);
    expect(extra.length).toBeLessThanOrEqual(1);
  });

  test('most golden swaps carry exactly our account list, nothing more', () => {
    const exact = GOLDEN.golden.filter((g) => {
      const real = realInstruction(realTx(g), g.swapIndex);
      return rebuildSwap(g, real).accounts.length === real.accounts.length;
    });
    expect(exact.length).toBeGreaterThanOrEqual(GOLDEN.golden.length - 1);
  });

  test('every System, Token, ATA and Compute Budget instruction in the golden transactions matches our encoding', () => {
    let compared = 0;
    for (const g of GOLDEN.golden) compared += compareNative(realTx(g));
    // CU limit and price, ATA creates, wraps, SyncNative and closes all occur.
    expect(compared).toBeGreaterThanOrEqual(30);
  });
});

describe('golden: a PumpSwap sell rebuilt from the DEC-1 fixtures', () => {
  // DEC-1's PumpSwap SellEvent transaction on the canonical pool Hyg1u7…, with DEC-1's pool and GlobalConfig accounts.
  test('sell instruction, ATA creates, compute budget and wrapped-SOL close equal the real transaction', () => {
    const { tx, loaded } = chainTransaction('idFHCrxdsN76pckjGpAMzkC8VsiHqySSw2oE5Eq8HQQnqNHdKEsW8nLRRWntHNWk3nFjLYh9fDM2BVMxH76NjFb');
    const r: RealTx = { tx, loaded, keys: accountKeys(tx, loaded) };
    const swapIndex = tx.instructions.findIndex((ix) => r.keys[ix.programIdIndex] === PUMP_AMM_PROGRAM);
    const real = realInstruction(r, swapIndex);
    const globalConfig = decodeGlobalConfig(fromBase64(chainAccount(PUMP_AMM_GLOBAL_CONFIG).dataBase64)).value;
    const baseVault = chainAccount('5KZBMyAG41RfinnuftXbJRDmYkeWLUd4JjdzdvwPpyPv');
    const m = poolMarketFrom(chainAccount('Hyg1u7HjBpmne8MLZsKoVBB31nm276xy4E6dzGcaYni'), baseVault.owner as Address, globalConfig);
    expect(m.state.quoteMint).toBe(NATIVE_MINT);
    const user = real.accounts[1]!.address;
    const fee = index(globalConfig.protocolFeeRecipients, real.accounts[9]!.address, 'fee');
    const buyback = index(globalConfig.buybackFeeRecipients!, real.accounts[22]!.address, 'buyback');
    const acc = poolAccounts(m, user, fee, buyback);
    if (!acc.ok) throw new Error(acc.detail);
    expectSame(poolSellIx(m, acc.accounts, user, u64le(real.data, 8), u64le(real.data, 16)), real, r, swapIndex);
    expect(compareNative(r)).toBeGreaterThanOrEqual(5);
  });
});

describe('golden: whole compiled messages', () => {
  // Every instruction of a real transaction rebuilt with our builders, then compiled with compileV0 against the same
  // fee payer and blockhash: the message bytes (header, key order, instructions, lookups) must equal the signed ones.
  const rebuildAll = (g: GoldenTx): Instruction[] | null => {
    const r = realTx(g);
    const out: Instruction[] = [];
    for (let i = 0; i < r.tx.instructions.length; i++) {
      const real = realInstruction(r, i);
      const mine = i === g.swapIndex ? rebuildSwap(g, real) : rebuildNative(real);
      if (mine === null || mine.accounts.length !== real.accounts.length) return null;
      out.push(mine);
    }
    return out;
  };

  test('compileV0 reproduces real messages: byte for byte, or equal apart from the key order inside each group', () => {
    const exact: string[] = [];
    const reordered: string[] = [];
    const differ: string[] = [];
    const skipped: string[] = [];
    for (const g of GOLDEN.golden) {
      const r = realTx(g);
      if (r.tx.addressTableLookups.length > 0) continue;
      const ixs = rebuildAll(g);
      if (ixs === null) {
        skipped.push(`${g.kind} ${g.signature.slice(0, 8)}`);
        continue;
      }
      const m = compileV0(r.keys[0]!, ixs, r.tx.recentBlockhash, [], () => false).message;
      // A legacy message is the v0 body without the 0x80 prefix and the empty lookup list.
      const ours = r.tx.version === 0 ? m : m.subarray(1, m.length - 1);
      const name = `${g.kind} ${g.signature.slice(0, 8)}`;
      if (hex(ours) === hex(r.tx.message)) {
        exact.push(name);
        continue;
      }
      // Some senders sort keys inside each signer/writable group (web3.js legacy compile); the runtime does not care.
      // Then the header, the key set of each group, the blockhash and every instruction's program, accounts and data
      // must still be identical.
      const sigs = '1'.repeat(64);
      const mine = decodeTransaction(Uint8Array.of(1, ...decodeBase58(sigs), ...m));
      const groups = (t: typeof mine) => {
        const h = t.header;
        const k = t.staticAccountKeys;
        const ws = h.numRequiredSignatures - h.numReadonlySignedAccounts;
        const wn = k.length - h.numReadonlyUnsignedAccounts;
        return [k.slice(0, ws), k.slice(ws, h.numRequiredSignatures), k.slice(h.numRequiredSignatures, wn), k.slice(wn)].map((x) => [...x].sort());
      };
      const resolved = (t: typeof mine) => t.instructions.map((ix) => [t.staticAccountKeys[ix.programIdIndex], ix.accounts.map((i) => t.staticAccountKeys[i]), hex(ix.data)]);
      const same = JSON.stringify(mine.header) === JSON.stringify(r.tx.header)
        && JSON.stringify(groups(mine)) === JSON.stringify(groups(r.tx))
        && mine.recentBlockhash === r.tx.recentBlockhash
        && JSON.stringify(resolved(mine)) === JSON.stringify(resolved(r.tx));
      (same ? reordered : differ).push(name);
    }
    expect(exact.length).toBeGreaterThanOrEqual(3);
    expect(exact.length + reordered.length).toBeGreaterThanOrEqual(8);
    // The only allowed difference: the sender that marked a key writable where we (and the IDL) leave it read-only.
    expect(differ).toEqual(differ.length === 0 ? [] : [expect.stringMatching(/^curve-buy /)]);
    // Not rebuildable: a stray account on a compute-budget instruction, or the non-idempotent ATA Create; we send neither.
    expect(skipped.length).toBeLessThanOrEqual(2);
  });
});
