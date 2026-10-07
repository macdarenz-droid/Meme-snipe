// H5-POOL-TAILS: TAIL-PROOF (`../chain/tail-proof.test.ts`) measured the PumpSwap trade tail after B5 as the pool's
// unswept creator fee, which leaves a trade's money unchanged. H5 now passes a pool tail of 8 bytes with any value
// when that u64 is at most the event's own pre-trade quote vault. The real mainnet events in fixtures/tail-proof.json
// must pass as live stores them (the decoded event). These stay refused: a tail above the vault, a non-zero tail with
// no readable vault, a non-zero curve tail, a wrong length, and a non-zero tail in the boundary slot itself.
import { describe, expect, it } from 'vitest';
import { decodeEventInstruction, fromHex } from '../../src/chain/index.ts';
import { EVENT_TAIL_UPGRADE_SLOT } from '../../src/config/index.ts';
import { AsOfStore, OFF_CHAIN, SimClock, type AsOfEntry, type Moment } from '../../src/engine/index.ts';
import { checkCurveTails, checkPoolTails, curveTradeKeys, evaluateHardRejects, poolTradeKeys, tradeTailCollapse, type GateContext, type TailCheck } from '../../src/gates/index.ts';
import { readFixture } from '../chain/helpers.ts';
import { MINT, NOW, POOL_ADDRESS, SLOT, T, deps, drop, passingFacts, request, type Facts } from './world.ts';

interface Vector { signature: string; slot: number; eventData: string; tail: string; vaults: { quotePre: string } | null }
const fx = readFixture<{ nonzero: Vector[]; zero: Vector[] }>('tail-proof.json');

const u64le = (hex: string): bigint => BigInt(`0x${(hex.match(/../g) ?? []).reverse().join('')}`);
const ORIGIN: Moment = { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 };
const at = (slot: bigint, receivedAt = 1_000): Moment => ({ slot, txIndex: 0, ixIndex: 0, receivedAt });

type PoolEvent = { readonly name: string; readonly program: string; readonly data: Record<string, unknown>; readonly trailing: number; readonly extra: string };
/** The value live stores for a fetched pool trade (`ev:` source): the decoded event, its slot and signature. */
const liveValue = (v: Vector) => {
  const event = decodeEventInstruction('pump_amm', fromHex(v.eventData)) as unknown as PoolEvent;
  return { event, txSlot: BigInt(v.slot), signature: v.signature };
};
const withEvent = (v: ReturnType<typeof liveValue>, patch: Partial<PoolEvent>, txSlot = v.txSlot) => ({ ...v, txSlot, event: { ...v.event, ...patch } });

/** One pool tape holding `values` (each at its own slot), checked from the start, as of after the last. */
const poolTape = (values: readonly ({ readonly txSlot: bigint } & Record<string, unknown>)[], key = poolTradeKeys(POOL_ADDRESS)[0]!): TailCheck => {
  const clock = new SimClock(ORIGIN);
  const store = new AsOfStore(clock);
  const sorted = [...values].sort((a, b) => (a.txSlot < b.txSlot ? -1 : a.txSlot > b.txSlot ? 1 : 0));
  sorted.forEach((v, i) => { clock.advanceTo(at(v.txSlot, 1_000 + i)); store.record(key, v, at(v.txSlot, 1_000 + i), `ev:${i}`); });
  return checkPoolTails({ now: clock.now(), history: (k, f, t) => store.history(k, f, t) as readonly AsOfEntry[] }, POOL_ADDRESS, { slot: 0n, ms: 0 });
};

const first = fx.nonzero[0]!;

describe('H5-POOL-TAILS: the creator-fee tail on PumpSwap pools', () => {
  it('the fixture vectors are real post-B5 trades whose tail is within the pre-trade vault (the bound holds on every one)', () => {
    expect(fx.nonzero.length).toBeGreaterThanOrEqual(200);
    for (const v of [...fx.nonzero, ...fx.zero]) {
      const e = liveValue(v).event;
      expect(BigInt(v.slot)).toBeGreaterThan(EVENT_TAIL_UPGRADE_SLOT.pump_amm);
      expect(e.extra).toBe(v.tail);
      expect(u64le(e.extra)).toBeLessThanOrEqual(e.data['poolQuoteTokenReserves'] as bigint);
      // The event's vault is the vault's real balance before the trade, where the unswept fee sits.
      if (v.vaults !== null) expect(e.data['poolQuoteTokenReserves']).toBe(BigInt(v.vaults.quotePre));
    }
  });

  it.each(fx.nonzero.map((v) => [`${v.signature.slice(0, 12)} tail ${v.tail}`, v] as const))('a real non-zero pool tail passes: %s', (_, v) => {
    expect(poolTape([liveValue(v)])).toEqual({ ok: true, events: 1 });
  });

  it('every real event on one pool tape, zero and non-zero, passes together', () => {
    expect(poolTape([...fx.nonzero, ...fx.zero].map(liveValue))).toEqual({ ok: true, events: fx.nonzero.length + fx.zero.length });
  });

  it('a real non-zero tail passes H5 through the hard rejects (no H5 or H16-for-H5 reason)', () => {
    const v = liveValue(first);
    const BUY = `pump_amm:BuyEvent:${POOL_ADDRESS}`;
    const base: Facts = drop(passingFacts(), BUY);
    const ctx = (value: unknown): GateContext => {
      const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
      const store = new AsOfStore(clock);
      const m: Moment = { slot: SLOT - 700n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: T - 5 * 60_000 };
      const rows: [string, unknown, Moment][] = [...[...base].map(([k, { value: x, moment }]) => [k, x, moment] as [string, unknown, Moment]), [BUY, value, m]];
      rows.sort((a, b) => (a[2].slot < b[2].slot ? -1 : a[2].slot > b[2].slot ? 1 : a[2].receivedAt - b[2].receivedAt));
      for (const [k, x, mm] of rows) { clock.advanceTo(mm); store.record(k, x, mm, `${k}@${mm.slot}`); }
      clock.advanceTo(NOW);
      return { now: NOW, observedTip: NOW.slot, lookup: (k, a) => store.lookup(k, a), history: (k, f, t) => store.history(k, f, t) };
    };
    const h5 = (value: unknown) => evaluateHardRejects(ctx(value), deps('live'), request(), { stopAtFirst: false }).reasons.filter((r) => r.gate === 'H5' || r.neededBy === 'H5');
    expect(h5({ ...v, txSlot: SLOT - 700n })).toEqual([]);
    // The same event with its vault below the tail is refused under H5.
    const fee = u64le(v.event.extra);
    expect(h5(withEvent(v, { data: { ...v.event.data, poolQuoteTokenReserves: fee - 1n } }, SLOT - 700n))).toEqual([expect.objectContaining({ gate: 'H5', code: 'event-tail', value: first.signature })]);
  });

  it('the bound: a tail equal to the vault passes; one lamport above it rejects (event-tail), naming the event', () => {
    const v = liveValue(first);
    const fee = u64le(v.event.extra);
    expect(poolTape([withEvent(v, { data: { ...v.event.data, poolQuoteTokenReserves: fee } })]).ok).toBe(true);
    expect(poolTape([withEvent(v, { data: { ...v.event.data, poolQuoteTokenReserves: fee - 1n } })])).toEqual(expect.objectContaining({ ok: false, code: 'event-tail', signature: first.signature, detail: expect.stringContaining('above the pool\'s quote vault') }));
    // The largest tail the 8 bytes can hold is above any vault.
    expect(poolTape([withEvent(v, { extra: 'ffffffffffffffff' })])).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
  });

  it('a non-zero pool tail with no readable vault is unreadable (malformed, H16); a zero tail needs no vault', () => {
    const v = liveValue(first);
    for (const data of [{}, { poolQuoteTokenReserves: 5 }, { poolQuoteTokenReserves: '999999999999' }, { poolQuoteTokenReserves: -1n }]) {
      expect(poolTape([withEvent(v, { data })]), JSON.stringify(Object.keys(data))).toEqual(expect.objectContaining({ ok: false, code: 'malformed', signature: first.signature }));
    }
    expect(poolTape([{ txSlot: v.txSlot, signature: 'X', event: { trailing: 8, extra: '1200000000000000' } }])).toEqual(expect.objectContaining({ ok: false, code: 'malformed' }));
    expect(poolTape([withEvent(v, { data: {}, extra: '00'.repeat(8) })])).toEqual({ ok: true, events: 1 });
  });

  it('a wrong length still rejects (event-tail), whatever the vault', () => {
    const v = liveValue(first);
    for (const [trailing, extra] of [[0, ''], [4, '01000000'], [16, `${first.tail}${first.tail}`], [8, first.tail.slice(2)], [8, `${first.tail}00`]] as const) {
      expect(poolTape([withEvent(v, { trailing, extra })]), `${trailing}/${extra}`).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
    }
    // Not hex: never read as a fee.
    expect(poolTape([withEvent(v, { extra: '0g00000000000000' })])).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
  });

  it('a non-zero pool tail at or before the boundary slot rejects: the rule starts after B5', () => {
    const v = liveValue(first);
    const b = EVENT_TAIL_UPGRADE_SLOT.pump_amm;
    expect(poolTape([withEvent(v, {}, b)])).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
    expect(poolTape([withEvent(v, {}, b - 1n)])).toEqual(expect.objectContaining({ ok: false, code: 'event-tail' }));
    expect(poolTape([withEvent(v, {}, b + 1n)])).toEqual({ ok: true, events: 1 });
  });

  it('a non-zero CURVE tail still rejects, even the real fee value with a vault field: the proof does not cover the curve', () => {
    const v = liveValue(first);
    const curve = { txSlot: EVENT_TAIL_UPGRADE_SLOT.pump + 10n, signature: 'SigCurve', event: { name: 'TradeEvent', program: 'pump', trailing: 8, extra: first.tail, data: { poolQuoteTokenReserves: v.event.data['poolQuoteTokenReserves'] } } };
    const clock = new SimClock(ORIGIN);
    const store = new AsOfStore(clock);
    clock.advanceTo(at(curve.txSlot));
    store.record(curveTradeKeys(MINT)[1]!, curve, at(curve.txSlot), 'logs:1');
    expect(checkCurveTails({ now: clock.now(), history: (k, f, t) => store.history(k, f, t) as readonly AsOfEntry[] }, MINT)).toEqual(expect.objectContaining({ ok: false, code: 'event-tail', signature: 'SigCurve' }));
  });

  it('no trade since migration is still not covered', () => {
    expect(poolTape([])).toEqual(expect.objectContaining({ ok: false, code: 'not-covered' }));
  });
});

describe('H5-POOL-TAILS: the store collapse follows the same verdict', () => {
  const keep = (key: string, values: readonly unknown[], slot0: bigint) => {
    const clock = new SimClock(ORIGIN);
    const store = new AsOfStore(clock, null, tradeTailCollapse);
    values.forEach((x, i) => { const m = at(slot0 + BigInt(i), 1_000 + i); clock.advanceTo(m); store.record(key, x, m, `ev:${i}`); });
    return (store.history(key, ORIGIN) as readonly AsOfEntry[]).map((e) => e.source);
  };

  it('real non-zero pool tails within the vault are collapsed like passing entries: only the newest stays', () => {
    const values = fx.nonzero.slice(0, 50).map(liveValue);
    expect(keep(poolTradeKeys(POOL_ADDRESS)[0]!, values, EVENT_TAIL_UPGRADE_SLOT.pump_amm + 1n)).toEqual(['ev:49']);
  });

  it('a pool tail above its vault, and a non-zero curve tail, are still kept as failing entries', () => {
    const v = liveValue(first);
    const above = withEvent(v, { data: { ...v.event.data, poolQuoteTokenReserves: 0n } });
    const ok = liveValue(fx.nonzero[1]!);
    expect(keep(poolTradeKeys(POOL_ADDRESS)[0]!, [ok, above, ok, ok], EVENT_TAIL_UPGRADE_SLOT.pump_amm + 1n)).toEqual(['ev:1', 'ev:3']);
    const curve = (sig: string, extra: string) => ({ txSlot: EVENT_TAIL_UPGRADE_SLOT.pump + 1n, signature: sig, event: { trailing: 8, extra } });
    expect(keep(curveTradeKeys(MINT)[0]!, [curve('a', '00'.repeat(8)), curve('b', first.tail), curve('c', '00'.repeat(8))], EVENT_TAIL_UPGRADE_SLOT.pump + 1n)).toEqual(['ev:1', 'ev:2']);
  });
});
