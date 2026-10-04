// Audit B3 (#115 definitions.holderGrowth): H3's holder growth counts distinct owners holding a positive balance,
// wallets only (pool vault, curve, mayhem vault, burns, lockers and program-owned accounts excluded), from complete
// coverage; anything less is unknown.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Address, encodeBase58, findProgramAddress } from '../../core/src/chain/index.ts';
import type { Lookup } from '../../core/src/engine/index.ts';
import { holdersKey, poolKey, RAYDIUM_LOCKER_PROGRAM, type HolderAccount } from '../../core/src/gates/index.ts';
import { walletHolders } from '../src/strategy/study.ts';

const wallet = (): Address => encodeBase58(new Uint8Array(generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))) as Address;
const MINT = wallet();
const POOL = findProgramAddress(['pool'], wallet()).address;
const VAULT = wallet();
const [W1, W2, W3, LOCKED, VAULT_OWNER] = [wallet(), wallet(), wallet(), wallet(), wallet()];
const PDA = findProgramAddress(['escrow'], wallet()).address;

const acct = (owner: string, amount: bigint, over: Partial<HolderAccount> = {}): HolderAccount => ({ address: wallet(), mint: MINT, owner, ownerProgram: null, amount, delegate: null, delegatedAmount: 0n, ...over });
const ACCOUNTS: HolderAccount[] = [
  acct(W1, 5n), acct(W1, 7n), // one owner, two accounts: one holder
  acct(W2, 0n), // an emptied account: not a holder
  acct(W3, 10n),
  acct(LOCKED, 10n, { ownerProgram: RAYDIUM_LOCKER_PROGRAM }),
  acct(PDA, 10n), // program-owned
  acct(VAULT_OWNER, 1_000n, { address: VAULT }), // the pool's base vault (an on-curve owner here, so only the vault rule excludes it)
];
const supply = ACCOUNTS.reduce((s, a) => s + a.amount, 0n);
const obs = { provider: 'test', slot: 10n, receivedAt: 1_000, quality: [] };
const holders = (over: Record<string, unknown> = {}) => ({ obs, supply, coverage: 'all', accounts: ACCOUNTS, ...over });
const pool = (address = POOL) => ({
  obs, address, owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  pool: { index: 0, creator: W1, baseMint: MINT, quoteMint: 'So11111111111111111111111111111111111111112', lpMint: wallet(), poolBaseTokenAccount: VAULT, poolQuoteTokenAccount: wallet(), lpSupply: 1n },
  baseVault: 1_000n, quoteVault: 1n,
});
const ctx = (facts: Record<string, unknown>) => ({
  lookup: (k: string): Lookup => (k in facts ? { ok: true, value: facts[k], moment: { slot: 10n, txIndex: 0, ixIndex: 0, receivedAt: 1_000 } } as Lookup : { ok: false, reason: 'missing' }),
});

describe('holder growth counts distinct owners (audit B3)', () => {
  it('counts each wallet owner with a positive summed balance once; vault, locker, program-owned and empty accounts are not holders', () => {
    expect(walletHolders(ctx({ [holdersKey(MINT)]: holders(), [poolKey(MINT)]: pool() }), MINT, POOL)).toBe(2);
  });

  it('is unknown without complete coverage: a largest-accounts view, a quality flag, or accounts that do not sum to the supply', () => {
    const p = { [poolKey(MINT)]: pool() };
    expect(walletHolders(ctx({ ...p, [holdersKey(MINT)]: holders({ coverage: 'largest' }) }), MINT, POOL)).toBeNull();
    expect(walletHolders(ctx({ ...p, [holdersKey(MINT)]: holders({ obs: { ...obs, quality: ['partial'] } }) }), MINT, POOL)).toBeNull();
    expect(walletHolders(ctx({ ...p, [holdersKey(MINT)]: holders({ supply: supply + 1n }) }), MINT, POOL)).toBeNull();
  });

  it('is unknown when the pool vault cannot be named: no pool fact, or one for another pool than the tape\'s', () => {
    expect(walletHolders(ctx({ [holdersKey(MINT)]: holders() }), MINT, POOL)).toBeNull();
    expect(walletHolders(ctx({ [holdersKey(MINT)]: holders(), [poolKey(MINT)]: pool(wallet()) }), MINT, POOL)).toBeNull();
  });

  it('counts control, not addresses: owners whose accounts are delegated to one party count once with it (HANDOVER: delegates count as control)', () => {
    const D = wallet();
    const delegated = (owner: string, amount: bigint) => acct(owner, amount, { delegate: D, delegatedAmount: amount });
    const accounts = [...ACCOUNTS.filter((a) => a.owner !== W3), delegated(W3, 10n), delegated(wallet(), 4n), delegated(wallet(), 6n)];
    const h = { obs, supply: accounts.reduce((t, a) => t + a.amount, 0n), coverage: 'all', accounts };
    // W1 alone, then W3 and the two new owners all moved by D: 2 holders, not 4.
    expect(walletHolders(ctx({ [holdersKey(MINT)]: h, [poolKey(MINT)]: pool() }), MINT, POOL)).toBe(2);
    // A delegation of nothing (0 delegated) controls nothing: those owners count on their own.
    const none = accounts.map((a) => (a.delegate === D ? { ...a, delegatedAmount: 0n } : a));
    expect(walletHolders(ctx({ [holdersKey(MINT)]: { ...h, accounts: none }, [poolKey(MINT)]: pool() }), MINT, POOL)).toBe(4);
  });
});
