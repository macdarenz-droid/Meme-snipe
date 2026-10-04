// GATE-1c: refuse a SOL-quoted pool whose trade events carry the 2026-10-02 upgrade's unpublished tail as non-zero, or
// at a length the upgrade boundary does not allow (UPG-1, venues.md §2.7). Missing tail evidence is not covered.
import { describe, expect, it } from 'vitest';
import { EVENT_TAIL_UPGRADE_SLOT } from '../../src/config/index.ts';
import { AsOfStore, OFF_CHAIN, SimClock, type Moment } from '../../src/engine/index.ts';
import { checkCurveTails, checkPoolTails, evaluateHardRejects, type GateContext, type GateReason } from '../../src/gates/index.ts';
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
  return { now: NOW, observedTip: NOW.slot, lookup: (k, a) => store.lookup(k, a), history: (k, f, t) => store.history(k, f, t) };
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
    expect(checkPoolTails(ctx(0, b - 1n), POOL_ADDRESS, { slot: null, ms: MIGRATED_AT })).toEqual({ ok: true, events: 1 });
    expect(checkPoolTails(ctx(8, b - 1n), POOL_ADDRESS, { slot: null, ms: MIGRATED_AT })).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
    expect(checkPoolTails(ctx(0, b), POOL_ADDRESS, { slot: null, ms: MIGRATED_AT }).ok).toBe(true);
    expect(checkPoolTails(ctx(8, b), POOL_ADDRESS, { slot: null, ms: MIGRATED_AT }).ok).toBe(true);
    expect(checkPoolTails(ctx(0, b + 1n), POOL_ADDRESS, { slot: null, ms: MIGRATED_AT })).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
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

  it('reads history only as of now: an entry after now is never checked (a history that would hand it over)', () => {
    const good = { moment: at(T - 60_000, SLOT - 150n), value: tradeEvent('BuyEvent', 8, ZERO, SLOT - 150n, 'SigNow'), source: 'ev:SigNow:000:000' };
    const future = { moment: at(T + 1, SLOT + 1n), value: tradeEvent('BuyEvent', 8, '0100000000000000', SLOT + 1n, 'SigFuture'), source: 'ev:SigFuture:000:000' };
    // A history that returns whatever lies before `to`, and everything when `to` is not given.
    const history: GateContext['history'] = (key, _from, to) =>
      key === BUY ? [good, future].filter((e) => to === undefined || e.moment.slot <= to.slot) : [];
    expect(checkPoolTails({ now: NOW, history }, POOL_ADDRESS, { slot: SLOT - 15_000n, ms: MIGRATED_AT })).toEqual({ ok: true, events: 1 });
  });

  it('a refused history is not covered', () => {
    const history: GateContext['history'] = () => ({ ok: false, reason: 'future' });
    expect(checkPoolTails({ now: NOW, history }, POOL_ADDRESS, { slot: SLOT - 15_000n, ms: MIGRATED_AT })).toEqual(expect.objectContaining({ ok: false, code: 'not-covered' }));
    expect(checkCurveTails({ now: NOW, history }, MINT)).toEqual(expect.objectContaining({ ok: false, code: 'not-covered' }));
  });

  it('the pool tape starts at the migration slot when the migration fact has one, else at its time', () => {
    const migSlot = SLOT - 15_000n;
    // Received after the migration time but in a slot before the migration: not part of the pool's tape.
    const early: Row = [BUY, tradeEvent('BuyEvent', 8, '0100000000000000', migSlot - 1n, 'SigEarly'), at(MIGRATED_AT + 5, migSlot - 1n)];
    const ctx = contextWith([early], drop(passingFacts(), BUY));
    expect(checkPoolTails(ctx, POOL_ADDRESS, { slot: migSlot, ms: MIGRATED_AT })).toEqual(expect.objectContaining({ code: 'not-covered' }));
    expect(checkPoolTails(ctx, POOL_ADDRESS, { slot: null, ms: MIGRATED_AT })).toEqual(expect.objectContaining({ code: 'event-tail', signature: 'SigEarly' }));
    // In the migration slot itself: part of the tape.
    const same: Row = [BUY, tradeEvent('BuyEvent', 8, '0100000000000000', migSlot, 'SigSame'), at(MIGRATED_AT, migSlot)];
    expect(checkPoolTails(contextWith([same], drop(passingFacts(), BUY)), POOL_ADDRESS, { slot: migSlot, ms: MIGRATED_AT })).toEqual(expect.objectContaining({ code: 'event-tail', signature: 'SigSame' }));
  });
});

describe("the mint's own curve tape (GATE-1c N1)", () => {
  const CURVE = `pump:TradeEvent:${MINT}`;
  const CURVE_LOGS = `logs:pump:TradeEvent:${MINT}`;
  const curveEvent = (trailing: number, extra: string, txSlot: bigint, signature: string) =>
    ({ ...tradeEvent('BuyEvent', trailing, extra, txSlot, signature), event: { name: 'TradeEvent', program: 'pump', data: {}, trailing, extra } });
  const old = (k: number) => at(MIGRATED_AT - 60_000 + k, SLOT - 16_000n + BigInt(k));

  it('a curve trade with a non-zero tail rejects H5, naming its signature', () => {
    const r = h5([[CURVE_LOGS, curveEvent(8, '0000000000000001', SLOT - 16_000n, 'SigCurve'), old(0)]]);
    expect(r).toEqual([expect.objectContaining({ gate: 'H5', code: 'event-tail', value: 'SigCurve', detail: expect.stringContaining('curve of') })]);
  });

  it("uses pump's own boundary: 8 bytes before slot 452,654,932 reject, none passes; in that slot either passes", () => {
    const b = EVENT_TAIL_UPGRADE_SLOT.pump;
    const ctx = (trailing: number, slot: bigint) => contextWith([[CURVE, curveEvent(trailing, '00'.repeat(trailing), slot, 'S'), old(0)]]);
    expect(checkCurveTails(ctx(0, b - 1n), MINT)).toEqual({ ok: true, events: 1 });
    expect(checkCurveTails(ctx(8, b - 1n), MINT)).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
    expect(checkCurveTails(ctx(8, b), MINT).ok).toBe(true);
    expect(checkCurveTails(ctx(0, b), MINT).ok).toBe(true);
    // Between the two programs' boundaries the PumpSwap rule would want 8 bytes; the curve rule wants none.
    expect(checkCurveTails(ctx(0, EVENT_TAIL_UPGRADE_SLOT.pump_amm + 1n), MINT).ok).toBe(true);
    expect(checkCurveTails(ctx(8, b + 1n), MINT).ok).toBe(true);
    expect(checkCurveTails(ctx(0, b + 1n), MINT)).toEqual(expect.objectContaining({ code: 'event-tail' }));
  });

  it('a curve tape that is not there is not a failure (the pool tape is the required evidence)', () => {
    expect(checkCurveTails(contextWith([]), MINT)).toEqual({ ok: true, events: 0 });
    expect(h5([])).toEqual([]);
  });

  it('the boundary slots are the upgrade transactions of UPG-1', () => {
    expect(EVENT_TAIL_UPGRADE_SLOT).toEqual({ pump_amm: 452_654_882n, pump: 452_654_932n });
    expect(MINT).toBeTruthy();
  });
});
