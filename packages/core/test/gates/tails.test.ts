// GATE-1c: refuse a SOL-quoted pool whose trade events carry the 2026-10-02 upgrade's unpublished tail as non-zero, or
// at a length the upgrade boundary does not allow (UPG-1, venues.md §2.7). Missing tail evidence is not covered.
import { describe, expect, it } from 'vitest';
import { EVENT_TAIL_UPGRADE_SLOT } from '../../src/config/index.ts';
import { AsOfStore, OFF_CHAIN, SimClock, type Moment } from '../../src/engine/index.ts';
import { checkPoolTails, evaluateHardRejects, type GateContext, type GateReason } from '../../src/gates/index.ts';
import { MIGRATED_AT, MINT, NOW, POOL_ADDRESS, SLOT, T, deps, drop, passingFacts, request, tradeEvent, type Facts } from './world.ts';

const at = (receivedAt: number, slot: bigint): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt });
type Row = readonly [string, unknown, Moment];
const BUY = `pump_amm:BuyEvent:${POOL_ADDRESS}`;
const SELL_LOGS = `logs:pump_amm:SellEvent:${POOL_ADDRESS}`;
const ZERO = '0000000000000000';

const contextWith = (rows: readonly Row[], base: Facts = passingFacts()): GateContext => {
  const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
  const store = new AsOfStore(clock);
  const all: Row[] = [...[...base].map(([k, { value, moment }]) => [k, value, moment] as Row), ...rows];
  all.sort((a, b) => (a[2].slot < b[2].slot ? -1 : a[2].slot > b[2].slot ? 1 : a[2].receivedAt - b[2].receivedAt));
  for (const [k, v, m] of all) {
    if (m.slot > NOW.slot || m.receivedAt > NOW.receivedAt) continue;
    clock.advanceTo(m);
    store.record(k, v, m, `${k}@${m.slot}`);
  }
  clock.advanceTo(NOW);
  return { now: NOW, lookup: (k, a) => store.lookup(k, a), history: (k, f, t) => store.history(k, f, t) };
};
const h5 = (rows: readonly Row[], base?: Facts): readonly GateReason[] =>
  evaluateHardRejects(contextWith(rows, base), deps('live'), request(), { stopAtFirst: false }).reasons.filter((r) => r.gate === 'H5' || r.neededBy === 'H5');
const recent = (k: number) => at(T - 5 * 60_000 + k, SLOT - 700n + BigInt(k));

describe('trade-event tails on the pool (GATE-1c)', () => {
  it('a zero 8-byte tail after the upgrade passes', () => {
    expect(h5([[SELL_LOGS, tradeEvent('SellEvent', 8, ZERO, SLOT - 700n, 'SigSell'), recent(0)]])).toEqual([]);
  });

  it('a non-zero tail rejects H5, naming the rule and the first offending signature', () => {
    const r = h5([
      [SELL_LOGS, tradeEvent('SellEvent', 8, '0100000000000000', SLOT - 700n, 'SigFirst'), recent(0)],
      [BUY, tradeEvent('BuyEvent', 8, 'ff00000000000000', SLOT - 600n, 'SigLater'), recent(100)],
    ]);
    expect(r).toEqual([expect.objectContaining({ gate: 'H5', code: 'event-tail', input: 'trades', value: 'SigFirst', detail: expect.stringContaining('first offending signature SigFirst') })]);
  });

  it('a wrong tail length rejects: none after the boundary, or not 8', () => {
    for (const [trailing, extra] of [[0, ''], [4, '00000000'], [16, ZERO + ZERO]] as const) {
      const r = h5([[BUY, tradeEvent('BuyEvent', trailing, extra, SLOT - 700n, `SigLen${trailing}`), recent(0)]]);
      expect(r).toEqual([expect.objectContaining({ gate: 'H5', code: 'event-tail', value: `SigLen${trailing}` })]);
    }
    // A length that does not match its own hex is refused too.
    expect(h5([[BUY, tradeEvent('BuyEvent', 8, '00', SLOT - 700n, 'SigBad'), recent(0)]])).toEqual([expect.objectContaining({ code: 'event-tail' })]);
  });

  it('before the PumpSwap boundary no tail passes and 8 bytes reject; in the boundary slot either passes', () => {
    const b = EVENT_TAIL_UPGRADE_SLOT.pump_amm;
    const ctx = (trailing: number, slot: bigint) => contextWith([[BUY, tradeEvent('BuyEvent', trailing, '00'.repeat(trailing), slot, 'S'), recent(0)]], drop(passingFacts(), BUY));
    expect(checkPoolTails(ctx(0, b - 1n), POOL_ADDRESS, MIGRATED_AT)).toEqual({ ok: true, events: 1 });
    expect(checkPoolTails(ctx(8, b - 1n), POOL_ADDRESS, MIGRATED_AT)).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
    expect(checkPoolTails(ctx(0, b), POOL_ADDRESS, MIGRATED_AT).ok).toBe(true);
    expect(checkPoolTails(ctx(8, b), POOL_ADDRESS, MIGRATED_AT).ok).toBe(true);
    expect(checkPoolTails(ctx(0, b + 1n), POOL_ADDRESS, MIGRATED_AT)).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
  });

  it('no trade event since migration is not covered, never a pass', () => {
    const r = h5([], drop(passingFacts(), BUY));
    expect(r).toEqual([expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'trades', neededBy: 'H5' })]);
    // An event before migration does not count.
    const old: Row = [BUY, tradeEvent('BuyEvent', 8, ZERO, SLOT - 30_000n, 'SigOld'), at(MIGRATED_AT - 1, SLOT - 30_000n)];
    expect(h5([old], drop(passingFacts(), BUY))).toEqual([expect.objectContaining({ code: 'not-covered', input: 'trades' })]);
  });

  it('an event without a readable tail is malformed', () => {
    const r = h5([[BUY, { event: { name: 'BuyEvent', data: {} }, txSlot: SLOT - 700n, signature: 'SigNoTail' }, recent(0)]]);
    expect(r).toEqual([expect.objectContaining({ gate: 'H16', code: 'malformed', input: 'trades', value: 'SigNoTail' })]);
  });

  it('a non-zero tail on an event dated after now is not seen (as of now)', () => {
    expect(h5([[BUY, tradeEvent('BuyEvent', 8, '0100000000000000', SLOT + 1n, 'SigFuture'), at(T + 1, SLOT + 1n)]])).toEqual([]);
  });

  it('the boundary slots are the upgrade transactions of UPG-1', () => {
    expect(EVENT_TAIL_UPGRADE_SLOT).toEqual({ pump_amm: 452_654_882n, pump: 452_654_932n });
    expect(MINT).toBeTruthy();
  });
});
