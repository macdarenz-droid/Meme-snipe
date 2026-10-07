// POOL-FIRST-READ part 2: the PumpSwap events proven on mainnet to leave the reserves unchanged
// (research/pool-noop-events), matched only by program and exact discriminator.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PUMP_AMM_NO_CHANGE_EVENTS, isNoChangePoolEvent } from '../../src/chain/index.ts';

describe('PumpSwap no-change events', () => {
  it('each discriminator is the Anchor hash of its event name: sha256("event:<Name>")[0..8]', () => {
    for (const [d, name] of PUMP_AMM_NO_CHANGE_EVENTS) expect(createHash('sha256').update(`event:${name}`).digest('hex').slice(0, 16)).toBe(d);
    expect([...PUMP_AMM_NO_CHANGE_EVENTS.values()].sort()).toEqual(['CloseUserVolumeAccumulatorEvent', 'ExtendAccountEvent']);
  });

  it('matches only an unnamed PumpSwap event with one of those exact discriminators', () => {
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other', discriminator: '929fbdac925838f4' })).toBe(true);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other', discriminator: '6161d7905d92167c' })).toBe(true);
    // The pump (curve) program, a named event, another discriminator, or none: not proven.
    expect(isNoChangePoolEvent({ program: 'pump', name: 'other', discriminator: '929fbdac925838f4' })).toBe(false);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'BuyEvent', discriminator: '929fbdac925838f4' })).toBe(false);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other', discriminator: '929fbdac925838f5' })).toBe(false);
    expect(isNoChangePoolEvent({ program: 'pump_amm', name: 'other' })).toBe(false);
    expect(isNoChangePoolEvent(undefined)).toBe(false);
  });
});
