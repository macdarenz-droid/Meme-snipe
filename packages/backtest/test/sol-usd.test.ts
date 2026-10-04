// SOL/USD for the books (owner rule: paper is real money): closes and marks always book at the latest close, never
// dropping a loss, and are flagged when that close is older than the entry bound, so the report shows the conversion.
import { describe, expect, it } from 'vitest';
import type { Lookup } from '../../core/src/engine/index.ts';
import { SOL_USD_KEY } from '../../core/src/gates/index.ts';
import { SOL_USD_MAX_AGE_MS, solUsdForBooks } from '../src/strategy/study.ts';

const ctx = (points: { tMs: number; price: bigint }[]) => ({
  lookup: (k: string): Lookup => (k === SOL_USD_KEY
    ? { ok: true, value: { obs: { provider: 'sol-usd', slot: null, receivedAt: 0, quality: [] }, points }, moment: { slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: 0 } } as Lookup
    : { ok: false, reason: 'missing' }),
});

describe('SOL/USD for closes and marks', () => {
  it('books at the latest close however old, flagged stale past the entry bound; current closes are not flagged', () => {
    const c = ctx([{ tMs: 0, price: 150_000_000n }, { tMs: 3_600_000, price: 151_000_000n }]);
    expect(solUsdForBooks(c, 3_600_000 + SOL_USD_MAX_AGE_MS)).toEqual({ tMs: 3_600_000, price: 151_000_000n, stale: false });
    expect(solUsdForBooks(c, 3_600_000 + SOL_USD_MAX_AGE_MS + 1)).toEqual({ tMs: 3_600_000, price: 151_000_000n, stale: true });
    expect(solUsdForBooks(c, 30 * 3_600_000)!.stale).toBe(true);
    expect(solUsdForBooks(ctx([]), 0)).toBeNull();
  });
});
