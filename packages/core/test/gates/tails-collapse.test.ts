// OOM-SWAPS, F1: the live store keeps, of a trade-event key, its newest entry and, per kind of failing tail, the earliest,
// the latest and the one received last (`tradeTailCollapse`). The tail checks must give the same verdict (pass, reject,
// not covered) as with every entry for any since, and the same answer, offending entry included, for a since at or
// before the tape's start (production: the migration): proved over random tapes. Supervisor ruling (F1): comparing the
// verdict class for an arbitrary since is not a loosening; before F1 the store kept every failing entry, which live
// mainnet tapes (non-zero tails on most swaps since 2026-10-06) turned into every swap.
import { describe, expect, it } from 'vitest';
import { EVENT_TAIL_UPGRADE_SLOT } from '../../src/config/index.ts';
import { AsOfStore, SimClock, compareMoments, type AsOfEntry, type Moment } from '../../src/engine/index.ts';
import { checkCurveTails, checkPoolTails, curveTradeKeys, poolTradeKeys, tradeTailCollapse, type Since } from '../../src/gates/index.ts';

const POOL = 'Pool1111111111111111111111111111111111111111';
const MINT = 'Mint1111111111111111111111111111111111111111';
const ORIGIN: Moment = { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 };

/** A small seeded generator, so a failure names its tape. */
const rng = (seed: number) => {
  let x = seed >>> 0 || 1;
  return (n: number): number => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x % n;
  };
};

/** A trade event value of every kind the check meets: clean, wrong length, non-zero, unreadable. */
const valueOf = (r: (n: number) => number, program: 'pump_amm' | 'pump', slot: bigint): unknown => {
  const b = EVENT_TAIL_UPGRADE_SLOT[program];
  const clean = slot < b ? 0 : slot > b ? 8 : r(2) === 0 ? 0 : 8;
  const sig = `Sig${r(1_000_000)}`;
  const kind = r(100);
  if (kind < 85) return { event: { trailing: clean, extra: '00'.repeat(clean) }, txSlot: slot, signature: sig };
  if (kind < 89) return { event: { trailing: 8 - clean, extra: '00'.repeat(8 - clean) }, txSlot: slot, signature: sig };
  if (kind < 93) {
    // H5-POOL-TAILS: a non-zero tail with no vault, under the vault (passes on a pool after its boundary), or above it.
    const vault = [undefined, 1n, 0n][r(3)];
    return { event: { trailing: 8, extra: '0100000000000000', ...(vault === undefined ? {} : { data: { poolQuoteTokenReserves: vault } }) }, txSlot: slot, signature: sig };
  }
  if (kind < 95) return { event: { trailing: clean, extra: '0'.repeat(2 * clean + 1) }, txSlot: slot, signature: sig };
  if (kind < 97) return { event: { trailing: clean, extra: '00'.repeat(clean) }, signature: sig };
  if (kind < 99) return { event: null, txSlot: slot };
  return null;
};

const strip = (r: ReturnType<typeof checkPoolTails>) => (r.ok ? { ok: true } : r);
/** The verdict class as H5 and H16 map it (hard.ts): pass; `event-tail` an H5 reject; `malformed` or not covered an H16 refusal. */
const verdict = (r: ReturnType<typeof checkPoolTails>) => (r.ok ? 'pass' : r.code === 'event-tail' ? 'H5' : 'H16');
const START: Since = { slot: 0n, ms: Number.MIN_SAFE_INTEGER };
/** H5-POOL-TAILS: a pool tail refused under the new rule (above the event's quote vault). */
const ABOVE = { poolQuoteTokenReserves: 0n };

describe('the trade-tail collapse keeps every answer of the tail checks', () => {
  it('over 400 random tapes on both programs, checked after every record: the same verdict for every kind of since, the same answer from the tape\'s start, at most eight entries a key', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const clock = new SimClock(ORIGIN);
      const full = new AsOfStore(clock);
      const kept = new AsOfStore(clock, null, tradeTailCollapse);
      const keys = [...poolTradeKeys(POOL).map((k) => [k, 'pump_amm'] as const), ...curveTradeKeys(MINT).map((k) => [k, 'pump'] as const)];
      // Moments: slots around both boundaries, receipt times not tied to slots (a late fill can be received after a later slot).
      const rows: { key: string; program: 'pump_amm' | 'pump'; m: Moment }[] = [];
      const n = 1 + r(40);
      for (let i = 0; i < n; i++) {
        const [key, program] = keys[r(keys.length)]!;
        const slot = EVENT_TAIL_UPGRADE_SLOT[program] - 6n + BigInt(r(14));
        rows.push({ key, program, m: { slot, txIndex: r(3), ixIndex: r(3), receivedAt: 1_000 + r(50) } });
      }
      rows.sort((a, b) => compareMoments(a.m, b.m));
      const sinces: (Since | null)[] = [null, { slot: rows[r(rows.length)]!.m.slot, ms: 0 }, { slot: null, ms: 1_000 + r(50) }, { slot: EVENT_TAIL_UPGRADE_SLOT.pump_amm + 100n, ms: 0 }];
      let i = 0;
      for (const row of rows) {
        clock.advanceTo(row.m);
        const v = valueOf(r, row.program, row.m.slot);
        full.record(row.key, v, row.m, `ev:${row.key}:${i}`);
        kept.record(row.key, v, row.m, `ev:${row.key}:${i}`);
        i++;
        const ctx = (s: AsOfStore) => ({ now: clock.now(), history: (k: string, f: Moment, t?: Moment) => s.history(k, f, t) });
        for (const since of sinces) {
          if (since !== null) expect(verdict(checkPoolTails(ctx(kept), POOL, since)), `seed ${seed} record ${i}`).toBe(verdict(checkPoolTails(ctx(full), POOL, since)));
        }
        // A since at or before the tape's start (the migration, in production): the same answer, offending entry included.
        expect(strip(checkPoolTails(ctx(kept), POOL, START)), `seed ${seed} record ${i}`).toEqual(strip(checkPoolTails(ctx(full), POOL, START)));
        expect(strip(checkCurveTails(ctx(kept), MINT)), `seed ${seed} record ${i}`).toEqual(strip(checkCurveTails(ctx(full), MINT)));
        // F1: bounded whatever the tape: the newest and at most three a failing kind, and one more received later.
        for (const [key] of keys) expect((kept.history(key, ORIGIN) as readonly AsOfEntry[]).length, `seed ${seed} ${key}`).toBeLessThanOrEqual(8);
      }
    }
  });

  it('F1: 5,000 records with a refused non-zero tail (above the vault) keep three entries: the earliest, the latest and the newest are one', () => {
    const clock = new SimClock(ORIGIN);
    const store = new AsOfStore(clock, null, tradeTailCollapse);
    const [buy] = poolTradeKeys(POOL);
    const slot = EVENT_TAIL_UPGRADE_SLOT.pump_amm + 10n;
    for (let k = 1; k <= 5_000; k++) {
      const m = { slot: slot + BigInt(k), txIndex: 0, ixIndex: 0, receivedAt: k };
      clock.advanceTo(m);
      store.record(buy!, { event: { trailing: 8, extra: '546c140000000000', data: ABOVE }, txSlot: m.slot, signature: `S${k}` }, m, `ev:${k}`);
    }
    const h = store.history(buy!, ORIGIN) as readonly AsOfEntry[];
    expect(h.length).toBeLessThanOrEqual(3);
    expect(h.map((e) => e.source)).toEqual(['ev:1', 'ev:4999', 'ev:5000']);
    const ctx = { now: clock.now(), history: (k: string, f: Moment, t?: Moment) => store.history(k, f, t) };
    // Rejected, naming the first offending signature from the migration on.
    expect(checkPoolTails(ctx, POOL, START)).toMatchObject({ ok: false, code: 'event-tail', signature: 'S1' });
  });

  it('F1: the failing entry received last stays though not last in order, so a since by receipt time still rejects', () => {
    const clock = new SimClock(ORIGIN);
    const full = new AsOfStore(clock);
    const kept = new AsOfStore(clock, null, tradeTailCollapse);
    const [buy] = poolTradeKeys(POOL);
    const slot = EVENT_TAIL_UPGRADE_SLOT.pump_amm + 10n;
    const bad = (sig: string) => ({ event: { trailing: 8, extra: '546c140000000000', data: ABOVE }, txSlot: slot, signature: sig });
    const clean = { event: { trailing: 8, extra: '0000000000000000' }, txSlot: slot, signature: 'C' };
    // In order: failing (received 100), failing (received 300: a late fill), failing (200), failing (210), clean (150).
    for (const [s, recv, v, id] of [[1n, 100, bad('A'), 'a'], [2n, 300, bad('B'), 'b'], [3n, 200, bad('C'), 'c'], [4n, 210, bad('D'), 'd'], [5n, 150, clean, 'e']] as const) {
      const m = { slot: slot + s, txIndex: 0, ixIndex: 0, receivedAt: recv };
      clock.advanceTo({ ...m, receivedAt: Math.max(recv, clock.now().receivedAt) });
      full.record(buy!, v, m, id);
      kept.record(buy!, v, m, id);
    }
    expect((kept.history(buy!, ORIGIN) as readonly AsOfEntry[]).map((e) => e.source)).toEqual(['a', 'b', 'd', 'e']);
    const ctx = (st: AsOfStore) => ({ now: clock.now(), history: (k: string, f: Moment, t?: Moment) => st.history(k, f, t) });
    // Only the entry received at 300 is at or after a since of 250 by receipt time: it fails, so both reject.
    const since: Since = { slot: null, ms: 250 };
    expect(verdict(checkPoolTails(ctx(kept), POOL, since))).toBe('H5');
    expect(verdict(checkPoolTails(ctx(full), POOL, since))).toBe('H5');
  });

  it('F1 (facts review B1): the answer is by kind, not by order across kinds, so a dropped middle entry of one kind never lets the other kind answer', () => {
    const clock = new SimClock(ORIGIN);
    const full = new AsOfStore(clock);
    const kept = new AsOfStore(clock, null, tradeTailCollapse);
    const [buy] = poolTradeKeys(POOL);
    const base = EVENT_TAIL_UPGRADE_SLOT.pump_amm + 10n;
    // No readable tail (no `extra`): `malformed`, an H16 refusal.
    const unreadable = { event: { trailing: 8 }, txSlot: base, signature: 'M' };
    const bad = { event: { trailing: 8, extra: '546c140000000000', data: ABOVE }, txSlot: base, signature: 'T' };
    const clean = { event: { trailing: 8, extra: '0000000000000000' }, txSlot: base, signature: 'C' };
    // The reviewer's tape: M@s1 (received 99), M@s4 (150), T@s6 (160), M@s9 (400), C@s10 (410).
    for (const [s, recv, v, id] of [[1n, 99, unreadable, 'm1'], [4n, 150, unreadable, 'm4'], [6n, 160, bad, 't6'], [9n, 400, unreadable, 'm9'], [10n, 410, clean, 'c10']] as const) {
      const m = { slot: base + s, txIndex: 0, ixIndex: 0, receivedAt: recv };
      clock.advanceTo(m);
      full.record(buy!, v, m, id);
      kept.record(buy!, v, m, id);
    }
    const ctx = (st: AsOfStore) => ({ now: clock.now(), history: (k: string, f: Moment, t?: Moment) => st.history(k, f, t) });
    for (const since of [{ slot: base + 3n, ms: 0 }, { slot: null, ms: 140 }, START] as Since[]) {
      expect(checkPoolTails(ctx(full), POOL, since), JSON.stringify(String(since.slot))).toMatchObject({ ok: false, code: 'event-tail', signature: 'T' });
      expect(checkPoolTails(ctx(kept), POOL, since), JSON.stringify(String(since.slot))).toMatchObject({ ok: false, code: 'event-tail', signature: 'T' });
    }
  });

  it('a clean tape keeps one entry per key however long it runs; a single offender and a single unreadable entry stay', () => {
    const clock = new SimClock(ORIGIN);
    const store = new AsOfStore(clock, null, tradeTailCollapse);
    const [buy] = poolTradeKeys(POOL);
    const slot = EVENT_TAIL_UPGRADE_SLOT.pump_amm + 10n;
    const clean = { event: { trailing: 8, extra: '0000000000000000' }, txSlot: slot, signature: 'S' };
    for (let k = 1; k <= 5_000; k++) {
      const m = { slot: slot + BigInt(k), txIndex: 0, ixIndex: 0, receivedAt: k };
      clock.advanceTo(m);
      store.record(buy!, k === 100 ? { event: { trailing: 8, extra: 'ff00000000000000', data: ABOVE }, txSlot: slot, signature: 'Bad' } : k === 200 ? { event: {} } : clean, m, `ev:${k}`);
    }
    const h = store.history(buy!, ORIGIN) as readonly AsOfEntry[];
    expect(h.map((e) => e.source)).toEqual(['ev:100', 'ev:200', 'ev:5000']);
  });

  it('an older clean entry received later than the new one stays (the time-based since reads receipt times)', () => {
    const clock = new SimClock(ORIGIN);
    const store = new AsOfStore(clock, null, tradeTailCollapse);
    const [buy] = poolTradeKeys(POOL);
    const slot = EVENT_TAIL_UPGRADE_SLOT.pump_amm + 10n;
    const clean = { event: { trailing: 8, extra: '0000000000000000' }, txSlot: slot, signature: 'S' };
    for (const [s, recv, id] of [[1n, 50, 'a'], [2n, 20, 'b'], [3n, 30, 'c']] as const) {
      const m = { slot: slot + s, txIndex: 0, ixIndex: 0, receivedAt: recv };
      clock.advanceTo(m.receivedAt >= clock.now().receivedAt ? m : { ...m, receivedAt: m.receivedAt });
      store.record(buy!, clean, m, id);
    }
    expect((store.history(buy!, ORIGIN) as readonly AsOfEntry[]).map((e) => e.source)).toEqual(['a', 'c']);
  });

  it('other keys keep every entry', () => {
    expect(tradeTailCollapse('gates/pool:X')).toBeNull();
    expect(tradeTailCollapse('coverage:trades:X:gap')).toBeNull();
    expect(tradeTailCollapse(`pump:CreateEvent:${MINT}`)).toBeNull();
    for (const k of [...poolTradeKeys(POOL), ...curveTradeKeys(MINT)]) expect(tradeTailCollapse(k)).not.toBeNull();
  });
});
