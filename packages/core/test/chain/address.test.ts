import { describe, expect, it } from 'vitest';
import { createProgramAddress, findProgramAddress, isOnCurve } from '../../src/chain/address.ts';
import { decodeAddressBytes } from '../../src/chain/base58.ts';
import { fromBase64 } from '../../src/chain/bytes.ts';
import { decodeTransaction } from '../../src/chain/message.ts';
import { TRANSACTIONS } from './helpers.ts';
import { feeConfigAddress } from '../../src/chain/fees.ts';
import {
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
} from '../../src/chain/programs.ts';

describe('program-derived addresses', () => {
  it('derives the pump accounts the docs name', () => {
    expect(findProgramAddress(['global'], PUMP_PROGRAM).address).toBe(PUMP_GLOBAL);
    expect(findProgramAddress(['global_config'], PUMP_AMM_PROGRAM).address).toBe(PUMP_AMM_GLOBAL_CONFIG);
    expect(feeConfigAddress(PUMP_PROGRAM)).toBe(PUMP_FEE_CONFIG);
    expect(feeConfigAddress(PUMP_AMM_PROGRAM)).toBe(PUMP_AMM_FEE_CONFIG);
  });

  it('never returns an on-curve address, and returns the first off-curve bump from 255 down', () => {
    const { address, bump } = findProgramAddress(['global'], PUMP_PROGRAM);
    expect(isOnCurve(decodeAddressBytes(address))).toBe(false);
    for (let b = 255; b > bump; b--) expect(createProgramAddress(['global', Uint8Array.of(b)], PUMP_PROGRAM)).toBeNull();
  });

  it('accepts every signer of the mainnet fixture transactions as a curve point', () => {
    // A signer's key verified an ed25519 signature on chain, so it must decompress.
    let n = 0;
    for (const t of TRANSACTIONS) {
      const tx = decodeTransaction(fromBase64(t.base64.transaction[0]));
      for (const k of tx.staticAccountKeys.slice(0, tx.header.numRequiredSignatures)) {
        expect(isOnCurve(decodeAddressBytes(k))).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(10);
  });

  it('rejects too many or too long seeds', () => {
    expect(() => findProgramAddress(Array.from({ length: 16 }, () => 'a'), PUMP_PROGRAM)).toThrow(RangeError);
    expect(() => findProgramAddress(['x'.repeat(33)], PUMP_PROGRAM)).toThrow(RangeError);
  });
});
