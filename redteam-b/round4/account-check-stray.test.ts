// RED TEAM B round 4 (integration merge), RC-STATE x SOL-BOOKS: SOL-BOOKS books a stray entry fee by its lamports
// with `cost: null` when no SOL price is known (account.ts `settle`: during a restart reconcile, or with a stale price),
// valued later by `priceLate`. RC-STATE's whole-file check (`checkAccount`, `isFee`) needs `cost` to be a non-negative
// bigint, so it refuses that file: the next start throws reading account.json and the worker cannot start (the unit
// restarts into the same refusal) while the file holds an unpriced stray fee. FAILS on the merge.
import { describe, expect, it } from 'vitest';
import { checkAccount } from '../src/run/account.ts';

describe('RB-17 RC-STATE checkAccount x SOL-BOOKS unpriced fees', () => {
  const base = { openedAtMs: 1, openingEquity: 20_000_000n, books: 'sol', walletLamports: 133_000_000n, trades: [], entries: [], oneTimePaid: true };
  it('RB-17a a stray fee booked with no SOL price (cost null, as settle writes it) is a valid file', () => {
    expect(checkAccount({ ...base, strayFees: { sig1: { atMs: 2, lamports: 25_000n, cost: null } } })).not.toBeNull();
  });
  it('RB-17b the same in the folded total (strayFolded.cost null, which priceLate also handles)', () => {
    expect(checkAccount({ ...base, strayFolded: { atMs: 2, lamports: 25_000n, cost: null } })).not.toBeNull();
  });
});
