// B-M28-01 property tests (ARCH 16.2): random valid payloads parse and round-trip through JSON unchanged; random big
// integers round-trip through their decimal-string scalars and BigInt.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { I64_MAX, I64_MIN, I128_MAX, I128_MIN, U64_MAX } from '@bot/types';
import { DecimalStr, I128Str, I64Str, U64Str, UntrustedName, UntrustedSymbol, VM_IDS, VM_SCHEMAS, VM06Trade, VM05Positions } from '@bot/contract';
import { ENTITY_FIXTURES, FIXTURES } from '@bot/contract/fixtures';

const SEED = 20261007;
const runs = { seed: SEED, numRuns: 1_000 };

describe('scalar round trips', () => {
  it('u64, i64 and i128 decimal strings parse and come back to the same BigInt', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), (x) => U64Str.safeParse(x.toString()).success && BigInt(x.toString()) === x), runs);
    fc.assert(fc.property(fc.bigInt({ min: I64_MIN, max: I64_MAX }), (x) => I64Str.safeParse(x.toString()).success), runs);
    fc.assert(fc.property(fc.bigInt({ min: I128_MIN, max: I128_MAX }), (x) => I128Str.safeParse(x.toString()).success), runs);
    fc.assert(fc.property(fc.bigInt({ min: U64_MAX + 1n, max: U64_MAX * 4n }), (x) => !U64Str.safeParse(x.toString()).success), runs);
  });

  it('exact decimals without exponent parse; untrusted strings pass exactly up to their byte limit', () => {
    const decimal = fc.tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.option(fc.stringMatching(/^[0-9]{1,30}$/), { nil: null }))
      .map(([neg, int, frac]) => `${neg ? '-' : ''}${int}${frac === null ? '' : `.${frac}`}`);
    fc.assert(fc.property(decimal, (d) => DecimalStr.safeParse(d).success), runs);
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (s) => {
      const bytes = new TextEncoder().encode(s).length;
      return UntrustedSymbol.safeParse(s).success === (bytes <= 32) && UntrustedName.safeParse(s).success === (bytes <= 64);
    }), runs);
  });
});

describe('random valid payloads round-trip', () => {
  it('every fixture survives JSON serialisation and parses to the same value', () => {
    for (const vm of VM_IDS) {
      for (const fixture of Object.values(FIXTURES[vm])) {
        const again = JSON.parse(JSON.stringify(fixture)) as unknown;
        assert.deepEqual(VM_SCHEMAS[vm].parse(again), fixture);
      }
    }
  });

  it('VM-06 trades with random amounts that keep the invariant parse and round-trip', () => {
    const u = fc.bigInt({ min: 0n, max: 10n ** 15n });
    fc.assert(fc.property(u, u, u, u, u, fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (a, b, c, d, e, gross) => {
      const total = a + b + c + d + e;
      const trade = { ...ENTITY_FIXTURES['VM-06'], gross_pnl_lamports: gross.toString(), total_costs_lamports: total.toString(), net_pnl_lamports: (gross - total).toString(),
        costs: { network_base_lamports: `${a}`, priority_lamports: `${b}`, tips_lamports: `${c}`, venue_fees_lamports: `${d}`, failed_tx_lamports: `${e}` } };
      const parsed = VM06Trade.safeParse(JSON.parse(JSON.stringify(trade)));
      return parsed.success && BigInt(parsed.data.net_pnl_lamports) === gross - total;
    }), runs);
  });

  it('VM-05 positions with random sizes, slots and PnL parse and round-trip', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), fc.bigInt({ min: I64_MIN, max: I64_MAX }), fc.integer({ min: -100_000, max: 100_000 }),
      (size, pnl, bps) => {
        const payload = { schema_version: 2, items: [{ ...ENTITY_FIXTURES['VM-05'], size_base: `${size}`, opened_slot: `${size}`,
          unrealized_pnl_net_lamports: `${pnl}`, unrealized_pnl_net_bps: bps }] };
        const parsed = VM05Positions.safeParse(JSON.parse(JSON.stringify(payload)));
        return parsed.success && isDeepStrictEqual(parsed.data, payload);
      }), runs);
  });
});
