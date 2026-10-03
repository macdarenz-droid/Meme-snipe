// HolderBook (BT-1d, schema 3): per token account, causal, owner from user_token_owner; the same account set as live's
// complete holder set (venue accounts and supply included).
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { bondingCurveAddress, decodeBase58, encodeBase58, isOnCurve, pumpPoolAuthority, TOKEN_PROGRAM, type Address } from '../../core/src/chain/index.ts';
import { classifyHolder, concentration, mintAccounts, RAYDIUM_LOCKER_PROGRAM } from '../../core/src/gates/index.ts';
import { bps } from '../../core/src/units/index.ts';
import { associatedTokenAddress, HolderBook, type HoldersAsOf } from '../src/dataset/holders.ts';
import type { AmmSwapRow, CoverageRow, CurveTradeRow, EventRow, MovementRow } from '../src/dataset/rows.ts';

const raw = (label: string): string => encodeBase58(createHash('sha256').update(label).digest());
/** A wallet-like (on-curve) address, deterministic from the label. */
const wallet = (label: string): string => {
  for (let k = 0; ; k++) {
    const a = raw(`${label}:${k}`);
    if (isOnCurve(decodeBase58(a))) return a;
  }
};
/** An off-curve address (a PDA-like owner). */
const pda = (label: string): string => {
  for (let k = 0; ; k++) {
    const a = raw(`${label}:${k}`);
    if (!isOnCurve(decodeBase58(a))) return a;
  }
};

const M = raw('mint');
const POOL = raw('pool');
const TOTAL = 1_000_000_000_000_000n;
const INITIAL_REAL = 793_100_000_000_000n;
const O = wallet('owner');
const R = wallet('receiver');
const ata = (owner: string) => associatedTokenAddress(owner, M, TOKEN_PROGRAM);

const event = (slot: number, name: string, fields: Record<string, string>): EventRow =>
  ({ kind: 'event', slot: BigInt(slot), blockTime: slot, txIdx: 0, evIdx: 0, signature: `e${slot}:${name}`, program: 'pump', event: name, fields });
const create = (slot = 1) => event(slot, 'CreateEvent', {
  mint: M, bonding_curve: bondingCurveAddress(M as Address), token_total_supply: String(TOTAL), real_token_reserves: String(INITIAL_REAL), token_program: TOKEN_PROGRAM,
});
let real = INITIAL_REAL;
const curve = (slot: number, isBuy: boolean, tokens: bigint, owner = O, over: Partial<CurveTradeRow> = {}): CurveTradeRow => {
  real = isBuy ? real - tokens : real + tokens;
  return {
    kind: 'curve', slot: BigInt(slot), blockTime: slot, txIdx: 1, evIdx: 0, signature: `c${slot}`, mint: M, isBuy, solAmount: 0n, tokenAmount: tokens,
    virtualSolReserves: 0n, virtualTokenReserves: 0n, realSolReserves: 0n, realTokenReserves: real, mayhem: false, quoteMint: '', user: 'SIGNER',
    userTokenAccount: owner === '' ? '' : ata(owner), userTokenOwner: owner, ...over,
  };
};
const amm = (slot: number, side: 'buy' | 'sell', base: bigint, pre: bigint, owner = O, over: Partial<AmmSwapRow> = {}): AmmSwapRow => ({
  kind: 'amm', slot: BigInt(slot), blockTime: slot, txIdx: 1, evIdx: 0, signature: `s${slot}`, pool: POOL, baseMint: M, quoteMint: 'Q', side,
  mode: 'exact-base', amount: base, baseAmount: base, quoteAmount: 0n, userQuote: 0n, pre: { baseReserve: pre, quoteVault: 0n, virtualQuoteReserves: 0n },
  fees: { split: { lp: bps(0), protocol: bps(0), creator: bps(0) }, buybackFeeBps: bps(0), instruction: 'v1' }, baseSupply: 0n, ixName: side, user: 'SIGNER',
  userTokenAccount: owner === '' ? '' : ata(owner), userTokenOwner: owner, ...over,
});
const move = (slot: number, kind: MovementRow['kind'], from: string, to: string, amount: bigint): MovementRow => ({
  slot: BigInt(slot), blockTime: slot, txIdx: 2, outerIx: 0, innerIx: null, mint: M, kind, fromOwner: from, toOwner: to, amount,
  fromAccount: from === '' ? '' : ata(from), toAccount: to === '' ? '' : ata(to),
});
const ok = (h: HoldersAsOf) => {
  if (h.unresolved) throw new Error(`unresolved: ${h.reason}`);
  return h;
};
const byOwner = (h: HoldersAsOf) => Object.fromEntries(ok(h).accounts.map((a) => [a.owner, a.amount]));
const fresh = (options?: ConstructorParameters<typeof HolderBook>[0]) => {
  real = INITIAL_REAL;
  const b = new HolderBook(options);
  b.event(create());
  return b;
};
const curvePda = bondingCurveAddress(M as Address);

describe('HolderBook', () => {
  test('a swap credits its user token owner, never the signer; the curve account and supply complete the set (sum = supply)', () => {
    const b = fresh();
    b.swap(curve(2, true, 100n));
    b.swap(curve(3, false, 40n));
    const h = ok(b.holdersAsOf(M));
    expect(h.supply).toBe(TOTAL);
    expect(byOwner(h)).toEqual({ [O]: 60n, [curvePda]: TOTAL - 60n });
    expect(h.accounts.find((a) => a.owner === O)).toMatchObject({ address: ata(O), mint: M, ownerProgram: null, delegate: null, delegatedAmount: 0n });
    expect(h.accounts.find((a) => a.owner === curvePda)!.address).toBe(associatedTokenAddress(curvePda, M, TOKEN_PROGRAM));
  });

  test('curve, migration and pool: the sum stays the supply, and concentration equals a live-shaped fact (R1)', () => {
    const b = fresh();
    b.swap(curve(2, true, 300_000_000_000_000n));
    b.swap(curve(3, true, 200_000_000_000_000n, R));
    const left = TOTAL - 500_000_000_000_000n;
    b.event(event(4, 'CompletePumpAmmMigrationEvent', { mint: M, mint_amount: String(left), pool: POOL }));
    b.event(event(4, 'CreatePoolEvent', { base_mint: M, pool: POOL, creator: pumpPoolAuthority(M as Address), base_amount_in: String(left), pool_base_amount: String(left), user_base_token_account: 'x' }));
    b.swap(amm(5, 'buy', 1_000n, left));
    b.swap(amm(6, 'sell', 400n, left - 1_000n, R));
    const h = ok(b.holdersAsOf(M));
    const vault = associatedTokenAddress(POOL, M, TOKEN_PROGRAM);
    expect(h.accounts.reduce((t, a) => t + a.amount, 0n)).toBe(h.supply);
    expect(byOwner(h)).toEqual({ [O]: 300_000_000_001_000n, [R]: 199_999_999_999_600n, [POOL]: left - 600n });
    // The gate's view: the pool vault excluded, everything else circulating.
    const c = concentration({ obs: { slot: 6n } as never, supply: h.supply, coverage: 'all', accounts: h.accounts }, mintAccounts(M, { address: POOL, baseVault: vault }));
    expect(c.excluded).toBe(left - 600n);
    expect(c.circulating).toBe(TOTAL - (left - 600n));
    expect(c.unaccounted).toBe(0n);
    expect(c.top1).toEqual({ owner: O, amount: 300_000_000_001_000n });
  });

  test('a boost buy-and-burn credits nobody and lowers the supply; burns and mints move it too', () => {
    const b = fresh();
    b.swap(curve(2, true, 100n));
    b.event(event(3, 'CompletePumpAmmMigrationEvent', { mint: M, mint_amount: String(TOTAL - 100n), pool: POOL }));
    b.event(event(3, 'CreatePoolEvent', { base_mint: M, pool: POOL, creator: pumpPoolAuthority(M as Address), base_amount_in: String(TOTAL - 100n), pool_base_amount: String(TOTAL - 100n) }));
    b.swap(amm(4, 'buy', 50n, TOTAL - 100n, '', { ixName: 'boost_buy_and_burn' }));
    b.movement(move(5, 'burn', O, '', 10n));
    b.movement(move(6, 'mint', '', R, 7n));
    const h = ok(b.holdersAsOf(M));
    expect(h.supply).toBe(TOTAL - 50n - 10n + 7n);
    expect(byOwner(h)).toEqual({ [O]: 90n, [R]: 7n, [POOL]: TOTAL - 150n });
  });

  test('movements move between accounts; a row with an empty owner is left out whole', () => {
    const b = fresh();
    b.swap(curve(2, true, 100n));
    b.movement(move(3, 'transfer', O, R, 30n));
    b.movement(move(4, 'transfer', O, '', 1n));
    expect(byOwner(b.holdersAsOf(M))).toMatchObject({ [O]: 70n, [R]: 30n });
  });

  test('no create, an empty swap owner, a pool vault out of step: unresolved', () => {
    const none = new HolderBook();
    none.swap(amm(1, 'buy', 1n, 10n));
    expect(none.holdersAsOf(M)).toMatchObject({ unresolved: true, reason: 'no_create' });
    const b = fresh();
    b.swap(curve(2, true, 5n, ''));
    expect(b.holdersAsOf(M)).toEqual({ unresolved: true, reason: 'swap_owner_unknown', fromSlot: 2n });
    const odd = fresh();
    odd.swap(amm(2, 'buy', 1n, 10n));
    expect(odd.holdersAsOf(M)).toMatchObject({ unresolved: true, reason: 'sum_mismatch' });
  });

  test('coverage notes take effect only when the replay reaches them; lead-in and pump-only mints are unresolved', () => {
    const coverage: CoverageRow[] = [{ mint: M, scope: 'unresolved', slot: 5n, reason: 'transfer_fee', count: 1, txIdx: 3, fromSlot: 1n, toSlot: 9n }];
    const b = fresh({ coverage });
    b.swap({ ...curve(5, true, 10n), txIdx: 2 });
    expect(ok(b.holdersAsOf(M)).supply).toBe(TOTAL);
    b.swap({ ...curve(5, true, 10n), txIdx: 3 });
    expect(b.holdersAsOf(M)).toEqual({ unresolved: true, reason: 'transfer_fee', fromSlot: 5n });
    const lead = new HolderBook({ coverage: [{ mint: '*', scope: 'no_movements', slot: null, reason: 'lead_in', count: null, txIdx: null, fromSlot: 0n, toSlot: 10n }] });
    lead.event(create(3));
    expect(lead.holdersAsOf(M)).toMatchObject({ unresolved: true, reason: 'no_movements' });
    const pumpOnly = new HolderBook({ coverage: [{ mint: M, scope: 'pump_transactions', slot: null, reason: '', count: null, txIdx: null, fromSlot: 0n, toSlot: 10n }] });
    pumpOnly.event(create(3));
    expect(pumpOnly.holdersAsOf(M)).toMatchObject({ unresolved: true, reason: 'pump_transactions' });
  });

  test('owner programs from the supplement: a locker is classified as one; an off-curve owner missing from it is unresolved (R2)', () => {
    const locker = pda('locker-owner');
    const missing = fresh();
    missing.swap(curve(2, true, 100n, locker));
    expect(missing.holdersAsOf(M)).toMatchObject({ unresolved: true, reason: 'owner_program_unknown' });
    const known = fresh({ ownerPrograms: new Map([[locker, RAYDIUM_LOCKER_PROGRAM]]) });
    known.swap(curve(2, true, 100n, locker));
    const a = ok(known.holdersAsOf(M)).accounts.find((x) => x.owner === locker)!;
    expect(a.ownerProgram).toBe(RAYDIUM_LOCKER_PROGRAM);
    expect(classifyHolder(a, mintAccounts(M, null))).toBe('locker');
    // A wallet (on-curve) owner needs no entry.
    expect(ok(known.holdersAsOf(M)).accounts.find((x) => x.owner === curvePda)).toBeDefined();
  });

  test('delegates from account operations; an owner change or a negative balance is unresolved', () => {
    const b = fresh();
    b.swap(curve(2, true, 100n));
    b.applyAccountOps({ slot: 3n, txIdx: 0 }, [{ kind: 'approve', mint: M, account: ata(O), delegate: R, amount: 50n }]);
    expect(ok(b.holdersAsOf(M)).accounts.find((a) => a.owner === O)).toMatchObject({ delegate: R, delegatedAmount: 50n });
    b.applyAccountOps({ slot: 4n, txIdx: 0 }, [{ kind: 'revoke', mint: M, account: ata(O) }]);
    expect(ok(b.holdersAsOf(M)).accounts.find((a) => a.owner === O)).toMatchObject({ delegate: null });
    b.applyAccountOps({ slot: 5n, txIdx: 0 }, [{ kind: 'owner', mint: M, account: ata(O), newOwner: R }]);
    expect(b.holdersAsOf(M)).toMatchObject({ unresolved: true, reason: 'owner_change', fromSlot: 5n });
    const n = fresh();
    n.swap(curve(2, false, 5n));
    expect(n.holdersAsOf(M)).toMatchObject({ unresolved: true, reason: 'negative_balance' });
    // Within one transaction the order of a swap and a movement does not matter.
    const t = fresh();
    t.movement({ ...move(7, 'transfer', O, R, 10n), txIdx: 1 });
    t.swap(curve(7, true, 10n));
    expect(byOwner(t.holdersAsOf(M))).toMatchObject({ [R]: 10n });
  });

  test('inputs out of chain order are refused', () => {
    const b = fresh();
    b.swap({ ...curve(5, true, 1n), txIdx: 2 });
    expect(() => b.swap({ ...curve(5, true, 1n), txIdx: 1 })).toThrow(/chain order/);
    expect(() => b.movement(move(4, 'mint', '', R, 1n))).toThrow(/chain order/);
  });
});

describe('owner-program supplement (R2)', () => {
  test('written once with its hash and cost, read back exactly; a tampered file is refused; at most 100 owners per call', async () => {
    const { mkdtempSync, rmSync, appendFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fetchOwnerPrograms, readOwnerPrograms, writeOwnerPrograms, OWNER_PROGRAMS_FILE } = await import('../src/dataset/owner-programs.ts');
    const owners = Array.from({ length: 250 }, (_, k) => pda(`o${k}`));
    const asked: number[] = [];
    const { rows, calls } = await fetchOwnerPrograms([...owners, owners[0]!], async (batch) => {
      asked.push(batch.length);
      return batch.map((o, i) => (i === 0 ? null : o === owners[1] ? RAYDIUM_LOCKER_PROGRAM : 'Prog'));
    });
    expect(asked).toEqual([100, 100, 50]);
    expect(calls).toBe(3);
    const dir = mkdtempSync(join(tmpdir(), 'op-'));
    try {
      const m = writeOwnerPrograms(dir, rows, { calls, source: 'test', fetchedAt: '2026-10-04T00:00:00Z' });
      expect(m).toMatchObject({ rows: 250, calls: 3, accounts: 250 });
      const back = readOwnerPrograms(dir);
      expect(back.size).toBe(250);
      expect(back.get(owners[1]!)).toBe(RAYDIUM_LOCKER_PROGRAM);
      appendFileSync(join(dir, OWNER_PROGRAMS_FILE), '{"owner":"x","program":null}\n');
      expect(() => readOwnerPrograms(dir)).toThrow(/sha256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
