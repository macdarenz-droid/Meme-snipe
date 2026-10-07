// RED TEAM C (probe, not product code): FactReaders keeps every holder owner it ever saw per mint (#owners) and puts
// them all in the next bank. Top-20 holders churn on a live coin; once layout + listed + remembered owners pass 100
// addresses, `readBatch` refuses the bank ("N accounts do not fit one bank") on every later batch for that mint, for
// the life of the process: the candidate's accounts never land again (a starved candidate = a missed trade).
import { describe, expect, it } from 'vitest';
import { type Address } from '../../../core/src/chain/index.ts';
import { ACC, W, account } from '../../../core/test/gates/world.ts';
import { FactReaders, type FactRpc } from '../../src/facts/index.ts';
import { ManualTimers } from '../../src/scheduler/index.ts';
import { tokenAccountData } from '../dryrun-chain.ts';
import { MINT, POOL, POOL_ADDRESS } from '../worker-harness.ts';
import { toBase64 } from '../../../core/src/chain/index.ts';
import { blockNetwork } from '../helpers.ts';

blockNetwork();

describe('RED TEAM C: per-mint owner memory', () => {
  it('a coin whose top-20 holders churn keeps getting its accounts bank (owners remembered stay bounded)', async () => {
    const timers = new ManualTimers(1_700_000_000_000);
    const mintAcc = account(MINT);
    let round = 0;
    const tok = new Map<string, string>();
    const rpc = {
      async getMultipleAccounts(addresses: readonly string[]) {
        return {
          slot: 1000n + BigInt(round),
          accounts: addresses.map((a) => {
            if (a === MINT) return { owner: mintAcc.owner, data: mintAcc.dataBase64 };
            if (!tok.has(a)) { try { const x = account(a); return { owner: x.owner, data: x.dataBase64 }; } catch { return null; } }
            const t = tok.get(a);
            return t === undefined ? null : { owner: mintAcc.owner, data: t };
          }),
        };
      },
      async getTokenLargestAccounts() {
        // 20 fresh holders each round (a busy coin's top 20 churns).
        const accounts = [] as { address: string; amount: bigint }[];
        for (let i = 0; i < 20; i++) {
          const owner = W(`r${round}-h${i}`);
          const address = ACC(owner);
          tok.set(address, toBase64(tokenAccountData(MINT as Address, owner as Address, 1_000n)));
          accounts.push({ address, amount: 1_000n });
        }
        return { slot: 1000n + BigInt(round), accounts };
      },
    } as unknown as FactRpc;
    const readers = new FactReaders({ feed: { ingest: () => undefined }, rpc, http: (async () => { throw new Error('no http'); }) as never, timers, timeoutMs: 1_000 });
    const results: boolean[] = [];
    for (round = 0; round < 8; round++) {
      const r = await readers.readBatch(MINT, { holders: 'largest', spend: null, xcheck: false });
      results.push(r.accounts === true);
    }
    const refused = readers.outcomes.filter((o) => o.detail.includes('do not fit one bank')).map((o) => o.detail);
    // Expected: every round banks. Observed: from round ~4 on the bank is refused forever.
    expect({ results, refused }).toEqual({ results: results.map(() => true), refused: [] });
  });
});
