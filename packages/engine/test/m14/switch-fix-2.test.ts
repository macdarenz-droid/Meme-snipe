// Card SWITCH-FIX-2 SW-24 (RT3): Chainstack's archive cost table is pinned. The eight Solana methods its docs bill as
// archive cost 2 RU each (docs.chainstack.com/docs/request-units, read 2026-10-17; DECISIONS SW-21); every other
// method stays at the full-node 1 RU default, so the ledger can only over-count.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { CHAINSTACK_ARCHIVE_COST, DEFAULT_PROVIDERS } from '../../src/m14/defaults.ts';

describe('SW-24: CHAINSTACK_ARCHIVE_COST', () => {
  it('is exactly the eight archive-billable methods at 2 RU, frozen, and is what the chainstack provider meters with', () => {
    assert.deepEqual({ ...CHAINSTACK_ARCHIVE_COST }, {
      getTransaction: 2, getBlock: 2, getBlockTime: 2, getBlocks: 2, getBlocksWithLimit: 2,
      getSignaturesForAddress: 2, getFirstAvailableBlock: 2, getSignatureStatuses: 2,
    });
    assert.ok(Object.isFrozen(CHAINSTACK_ARCHIVE_COST));
    const chainstack = DEFAULT_PROVIDERS.find((p) => p.label === 'chainstack');
    assert.equal(chainstack?.metering?.methodCost, CHAINSTACK_ARCHIVE_COST);
  });
});
