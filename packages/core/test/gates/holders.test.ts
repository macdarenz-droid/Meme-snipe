// Holder concentration excludes the curve ATA, pool vaults, the mayhem vault, lockers, burns and program accounts
// (docs/research/safety.md §4). Real mainnet token accounts (fixtures/holders.json, read at the slot they carry)
// are classified; the locker has no public mainnet example reachable from the free RPC, so it is the one built case.
import { describe, expect, it } from 'vitest';
import { decodeTokenAccount, fromBase64, PUMP_AMM_PROGRAM, PUMP_PROGRAM, type Address } from '../../src/chain/index.ts';
import {
  INCINERATOR, MAYHEM_VAULT_OWNER, RAYDIUM_LOCKER_PROGRAM, classifyHolder, concentration, evaluateHardRejects, holdersKey, mintAccounts,
  ownerBalance, shareBps, type HolderAccount, type HoldersFact,
} from '../../src/gates/index.ts';
import { ACC, HOLDER_ACCOUNTS, POOL, POOL_ADDRESS, W, byLabel, contextOf, deps, holderAccounts, obs, passingFacts, patch, request, MINT } from './world.ts';

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

  it('only the stored canonical base vault is a pool vault; another account the pool owns is not', () => {
    const v = holderOf('graduated coin: canonical pool base vault');
    expect(v.owner).toBe(POOL_ADDRESS);
    const known = mintAccounts(v.mint, { address: POOL_ADDRESS, baseVault: POOL.poolBaseTokenAccount });
    expect(classifyHolder(v, known)).toBe('pool-vault');
    expect(classifyHolder({ ...v, address: ACC('other-pool-account') }, known)).toBe('unknown-program');
    // Only the canonical pool's vault is excluded. Any other PDA owner, even one of PumpSwap or pump, stays a holder.
    expect(classifyHolder(v, mintAccounts(v.mint, null))).toBe('unknown-program');
    expect(classifyHolder({ ...v, ownerProgram: PUMP_AMM_PROGRAM }, mintAccounts(v.mint, null))).toBe('unknown-program');
    expect(classifyHolder({ ...v, ownerProgram: PUMP_PROGRAM }, mintAccounts(v.mint, null))).toBe('unknown-program');
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

  it('an account owned by a Raydium locker PDA is classed as a locker and kept as a holder (built case)', () => {
    const locker = { mint: MINT, address: ACC('locker'), owner: ACC('locker-pda'), ownerProgram: RAYDIUM_LOCKER_PROGRAM, amount: 5n };
    expect(classifyHolder(locker, mintAccounts(MINT, null))).toBe('locker');
    const c = concentration({ obs: obs(), supply: 10n, coverage: 'all', accounts: [locker] }, mintAccounts(MINT, null));
    expect(c.excluded).toBe(0n);
    expect(c.owners).toEqual([{ owner: locker.owner, amount: 5n }]);
  });
});

describe('concentration', () => {
  const vault = holderOf('graduated coin: canonical pool base vault');
  const known = mintAccounts(vault.mint, { address: POOL_ADDRESS, baseVault: POOL.poolBaseTokenAccount });
  const fact = (accounts: HolderAccount[], supply: bigint, coverage: HoldersFact['coverage'] = 'all'): HoldersFact => ({ obs: obs(), supply, coverage, accounts });

  it('measures shares of circulating supply after every exclusion, grouped by owner', () => {
    const accounts: HolderAccount[] = [
      vault, // pool vault
      { mint: MINT, address: ACC('c'), owner: mintAccounts(vault.mint, null).curve, ownerProgram: PUMP_PROGRAM, amount: 100n }, // curve
      { mint: MINT, address: ACC('m'), owner: MAYHEM_VAULT_OWNER, ownerProgram: null, amount: 100n },
      { mint: MINT, address: ACC('b'), owner: INCINERATOR, ownerProgram: null, amount: 100n },
      { mint: MINT, address: ACC('l'), owner: ACC('lp'), ownerProgram: RAYDIUM_LOCKER_PROGRAM, amount: 100n },
      { mint: MINT, address: ACC('w1'), owner: W(1), ownerProgram: null, amount: 300n },
      { mint: MINT, address: ACC('w1b'), owner: W(1), ownerProgram: null, amount: 100n },
      { mint: MINT, address: ACC('w2'), owner: W(2), ownerProgram: null, amount: 600n },
    ];
    const supply = vault.amount + 1_400n;
    const c = concentration(fact(accounts, supply), known);
    expect(c.classes.map((x) => x.cls).sort()).toEqual(['burn', 'curve', 'locker', 'mayhem-vault', 'pool-vault', 'wallet', 'wallet', 'wallet']);
    expect(c.excluded).toBe(vault.amount + 300n);
    expect(c.circulating).toBe(1_100n);
    expect(c.owners).toEqual([{ owner: W(2), amount: 600n }, { owner: W(1), amount: 400n }, { owner: ACC('lp'), amount: 100n }]);
    expect(shareBps(c.top1!.amount, c.circulating)).toBe(5_455n);
    expect(c.top10).toBe(1_100n);
  });

  it('keeps a PDA of an unknown program as a holder (it may be the dev)', () => {
    const c = concentration(fact([{ mint: MINT, address: ACC('x'), owner: POOL_ADDRESS, ownerProgram: null, amount: 10n }], 10n), mintAccounts(MINT, null));
    expect(c.classes[0]?.cls).toBe('unknown-program');
    expect(c.circulating).toBe(10n);
  });

  it('counts what no listed account holds as unaccounted, and an owner only by its listed accounts', () => {
    const two = [{ mint: MINT, address: ACC('a'), owner: W(1), ownerProgram: null, amount: 50n }, { mint: MINT, address: ACC('b'), owner: W(2), ownerProgram: null, amount: 7n }];
    const c = concentration(fact(two, 1_000n, 'largest'), known);
    expect(c.unaccounted).toBe(943n);
    expect(ownerBalance(c, W(1))).toBe(50n);
    expect(ownerBalance(c, W(3))).toBe(0n);
    const all = concentration(fact(two, 57n), known);
    expect(all.unaccounted).toBe(0n);
  });

  it('rounds shares up, so a share at a limit is not under it', () => {
    expect(shareBps(1n, 3n)).toBe(3_334n);
    expect(shareBps(1n, 4n)).toBe(2_500n);
  });

  it('a largest-accounts view whose unlisted tokens could breach a limit is not covered (GATE-1d)', () => {
    const world = passingFacts();
    const largest = patch(world, holdersKey(MINT), { coverage: 'largest' });
    expect(evaluateHardRejects(contextOf(largest), deps(), request(), { stopAtFirst: false }).reasons).toEqual([]); // nothing unlisted
    const accounts = holderAccounts().filter((a) => a.amount !== 1_000_000_000_000n); // drop the full small wallets
    const r = evaluateHardRejects(contextOf(patch(largest, holdersKey(MINT), { accounts })), deps(), request(), { stopAtFirst: false });
    expect(r.reasons).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'holders', neededBy: 'H12' }));
  });
});
