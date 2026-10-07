// POOL-FIRST-READ part 2: the PumpSwap events proven on mainnet to leave the reserves unchanged
// (research/pool-noop-events), matched only by program and exact discriminator.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PUMP_AMM_NO_CHANGE_EVENTS, decodeEventBytes, isNoChangePoolEvent } from '../../src/chain/index.ts';

describe('PumpSwap no-change events', () => {
  it('each discriminator is the Anchor hash of its event name: sha256("event:<Name>")[0..8]', () => {
    for (const [d, { name }] of PUMP_AMM_NO_CHANGE_EVENTS) expect(createHash('sha256').update(`event:${name}`).digest('hex').slice(0, 16)).toBe(d);
    expect([...PUMP_AMM_NO_CHANGE_EVENTS.values()].map((x) => x.name).sort()).toEqual(['CloseUserVolumeAccumulatorEvent', 'ExtendAccountEvent']);
  });

  it('DEC-1 gives these two their size (mainnet: 80 and 96 bytes); a changed size is not proven', () => {
    const bytes = (d: string, n: number) => Uint8Array.from([...Buffer.from(d, 'hex'), ...new Array<number>(n - 8).fill(7)]);
    for (const [d, n] of [['929fbdac925838f4', 80], ['6161d7905d92167c', 96]] as const) {
      const e = decodeEventBytes('pump_amm', bytes(d, n));
      expect(e).toEqual({ program: 'pump_amm', name: 'other', discriminator: d, size: n });
      expect(isNoChangePoolEvent(e)).toBe(true);
      expect(isNoChangePoolEvent(decodeEventBytes('pump_amm', bytes(d, n + 8)))).toBe(false);
      expect(isNoChangePoolEvent(decodeEventBytes('pump_amm', bytes(d, n - 8)))).toBe(false);
      // The pump (curve) program: not proven, and no size given.
      expect(decodeEventBytes('pump', bytes(d, n))).toEqual({ program: 'pump', name: 'other', discriminator: d });
    }
    // Any other unnamed event keeps its shape (no size).
    expect(decodeEventBytes('pump_amm', bytes('0011223344556677', 80))).toEqual({ program: 'pump_amm', name: 'other', discriminator: '0011223344556677' });
  });

  it('matches only an unnamed PumpSwap event with one of those exact discriminators and sizes', () => {
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other', discriminator: '929fbdac925838f4', size: 80 })).toBe(true);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other', discriminator: '6161d7905d92167c', size: 96 })).toBe(true);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other', discriminator: '929fbdac925838f4' })).toBe(false);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other', discriminator: '929fbdac925838f4', size: 96 })).toBe(false);
    // The pump (curve) program, a named event, another discriminator, or none: not proven.
    expect(isNoChangePoolEvent({ program: 'pump', name: 'other', discriminator: '929fbdac925838f4' })).toBe(false);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'BuyEvent', discriminator: '929fbdac925838f4' })).toBe(false);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other', discriminator: '929fbdac925838f5' })).toBe(false);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other' })).toBe(false);
    expect(isNoChangePoolEvent(undefined)).toBe(false);
  });
});
