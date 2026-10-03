// Holder concentration excludes the curve ATA, pool vaults, the mayhem vault, lockers, burns and program accounts
// (docs/research/safety.md §4). Real mainnet token accounts (fixtures/holders.json, read at the slot they carry)
// are classified; the locker has no public mainnet example reachable from the free RPC, so it is the one built case.
import { describe, expect, it } from 'vitest';
import { decodeTokenAccount, fromBase64, PUMP_AMM_PROGRAM, PUMP_PROGRAM, type Address } from '../../src/chain/index.ts';
import {
  INCINERATOR, MAYHEM_VAULT_OWNER, RAYDIUM_LOCKER_PROGRAM, classifyHolder, concentration, evaluateHardRejects, holdersKey, insidersKey, mintAccounts,
  ownerBalance, shareBps, type HolderAccount, type HoldersFact,
} from '../../src/gates/index.ts';
import { ACC, HOLDER_ACCOUNTS, POOL, POOL_ADDRESS, W, byLabel, contextOf, deps, obs, passingFacts, patch, request, MINT } from './world.ts';

const holderOf = (label: string, ownerProgram: string | null = null): HolderAccount & { mint: string; slot: string } => {
  const a = byLabel(label);
  const t = decodeTokenAccount(fromBase64(a.dataBase64), a.owner as Address);
  return { address: a.address, owner: t.owner, ownerProgram, amount: t.amount, mint: t.mint, slot: a.slot };
};
const mintOf = (label: string) => byLabel(label).address;

describe('classification on mainnet accounts', () => {
  it('the mayhem vault owner is PDA(["sol-vault"], mayhem program), as safety.md derived', () => {
    expect(MAYHEM_VAULT_OWNER).toBe('BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s');
  });

  it('every fixture carries its slot', () => {
    for (const a of HOLDER_ACCOUNTS) expect(BigInt(a.slot)).toBeGreaterThan(452_000_000n);
  });

  it('the bonding-curve ATA of a fresh coin is the curve', () => {
    const h = holderOf('fresh curve coin: bonding-curve ATA', PUMP_PROGRAM);
    expect(h.mint).toBe(mintOf('fresh curve coin: mint'));
    expect(classifyHolder(h, mintAccounts(h.mint, null))).toBe('curve');
  });

  it("a mayhem coin's agent vault is the mayhem vault, and its curve ATA the curve", () => {
    const mint = mintOf('mayhem coin: mint');
    const vault = holderOf('mayhem coin: mayhem vault (owner BwWK17cb)');
    expect(vault.owner).toBe(MAYHEM_VAULT_OWNER);
    expect(vault.mint).toBe(mint);
    expect(classifyHolder(vault, mintAccounts(mint, null))).toBe('mayhem-vault');
    expect(classifyHolder(holderOf('mayhem coin: bonding-curve ATA'), mintAccounts(mint, null))).toBe('curve');
  });

  it('the canonical pool base vault is a pool vault, by address and by owner', () => {
    const v = holderOf('graduated coin: canonical pool base vault');
    expect(v.owner).toBe(POOL_ADDRESS);
    expect(classifyHolder(v, mintAccounts(v.mint, { address: POOL_ADDRESS, baseVault: POOL.poolBaseTokenAccount }))).toBe('pool-vault');
    // Without knowing the pool, the PDA owner of a known program is still excluded; unknown owner program is kept.
    expect(classifyHolder(v, mintAccounts(v.mint, null))).toBe('unknown-program');
    expect(classifyHolder({ ...v, ownerProgram: PUMP_AMM_PROGRAM }, mintAccounts(v.mint, null))).toBe('program');
  });

  it('a buyer from a mainnet BuyEvent is a wallet', () => {
    const b = holderOf('PumpSwap buyer: base token account (from a mainnet BuyEvent)');
    expect(classifyHolder(b, mintAccounts(b.mint, { address: POOL_ADDRESS, baseVault: POOL.poolBaseTokenAccount }))).toBe('wallet');
  });

  it('tokens sent to the incinerator are a burn', () => {
    const b = holderOf('burned coin: incinerator token account');
    expect(b.owner).toBe(INCINERATOR);
    expect(b.amount).toBeGreaterThan(0n);
    expect(classifyHolder(b, mintAccounts(b.mint, null))).toBe('burn');
  });

  it('an account owned by a Raydium locker PDA is a locker (built case)', () => {
    const locker = { address: ACC('locker'), owner: ACC('locker-pda'), ownerProgram: RAYDIUM_LOCKER_PROGRAM, amount: 5n };
    expect(classifyHolder(locker, mintAccounts(MINT, null))).toBe('locker');
  });
});

describe('concentration', () => {
  const vault = holderOf('graduated coin: canonical pool base vault');
  const known = mintAccounts(vault.mint, { address: POOL_ADDRESS, baseVault: POOL.poolBaseTokenAccount });
  const fact = (accounts: HolderAccount[], supply: bigint, coverage: HoldersFact['coverage'] = 'all'): HoldersFact => ({ obs: obs(), supply, coverage, accounts });

  it('measures shares of circulating supply after every exclusion, grouped by owner', () => {
    const accounts: HolderAccount[] = [
      vault, // pool vault
      { address: ACC('c'), owner: mintAccounts(vault.mint, null).curve, ownerProgram: PUMP_PROGRAM, amount: 100n }, // curve
      { address: ACC('m'), owner: MAYHEM_VAULT_OWNER, ownerProgram: null, amount: 100n },
      { address: ACC('b'), owner: INCINERATOR, ownerProgram: null, amount: 100n },
      { address: ACC('l'), owner: ACC('lp'), ownerProgram: RAYDIUM_LOCKER_PROGRAM, amount: 100n },
      { address: ACC('w1'), owner: W(1), ownerProgram: null, amount: 300n },
      { address: ACC('w1b'), owner: W(1), ownerProgram: null, amount: 100n },
      { address: ACC('w2'), owner: W(2), ownerProgram: null, amount: 600n },
    ];
    const supply = vault.amount + 1_400n;
    const c = concentration(fact(accounts, supply), known);
    expect(c.classes.map((x) => x.cls).sort()).toEqual(['burn', 'curve', 'locker', 'mayhem-vault', 'pool-vault', 'wallet', 'wallet', 'wallet']);
    expect(c.excluded).toBe(vault.amount + 400n);
    expect(c.circulating).toBe(1_000n);
    expect(c.owners).toEqual([{ owner: W(2), amount: 600n }, { owner: W(1), amount: 400n }]);
    expect(shareBps(c.top1!.amount, c.circulating)).toBe(6_000n);
    expect(c.top10).toBe(1_000n);
  });

  it('keeps a PDA of an unknown program as a holder (it may be the dev)', () => {
    const c = concentration(fact([{ address: ACC('x'), owner: POOL_ADDRESS, ownerProgram: null, amount: 10n }], 10n), mintAccounts(MINT, null));
    expect(c.classes[0]?.cls).toBe('unknown-program');
    expect(c.circulating).toBe(10n);
  });

  it('bounds an unlisted owner of a largest-accounts list by the smallest listed account', () => {
    const c = concentration(fact([{ address: ACC('a'), owner: W(1), ownerProgram: null, amount: 50n }, { address: ACC('b'), owner: W(2), ownerProgram: null, amount: 7n }], 1_000n, 'largest'), known);
    expect(ownerBalance(c, W(3))).toEqual({ amount: 7n, listed: false });
    const all = concentration(fact([{ address: ACC('a'), owner: W(1), ownerProgram: null, amount: 50n }], 1_000n), known);
    expect(ownerBalance(all, W(3))).toEqual({ amount: 0n, listed: true });
  });

  it('rounds shares up, so a share at a limit is not under it', () => {
    expect(shareBps(1n, 3n)).toBe(3_334n);
    expect(shareBps(1n, 4n)).toBe(2_500n);
  });

  it('H13 counts a missing insider at the bound and notes it', () => {
    const world = passingFacts();
    const largest = patch(world, holdersKey(MINT), { coverage: 'largest' });
    const r = evaluateHardRejects(contextOf(patch(largest, insidersKey(MINT), { insiders: [W('absent')] })), deps(), request(), { stopAtFirst: false });
    expect(r.notes).toContainEqual(expect.objectContaining({ gate: 'H13', code: 'missing-insider-bounded' }));
  });
});
