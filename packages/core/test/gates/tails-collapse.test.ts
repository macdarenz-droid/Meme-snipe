// OOM-SWAPS: the live store keeps, of a trade-event key, only its newest entry and the entries whose tail would fail
// (`tradeTailCollapse`). The tail checks must answer exactly as with every entry: proved over random tapes.
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
  if (kind < 93) return { event: { trailing: 8, extra: '0100000000000000' }, txSlot: slot, signature: sig };
  if (kind < 95) return { event: { trailing: clean, extra: '0'.repeat(2 * clean + 1) }, txSlot: slot, signature: sig };
  if (kind < 97) return { event: { trailing: clean, extra: '00'.repeat(clean) }, signature: sig };
  if (kind < 99) return { event: null, txSlot: slot };
  return null;
};

const strip = (r: ReturnType<typeof checkPoolTails>) => (r.ok ? { ok: true } : r);

describe('the trade-tail collapse keeps every answer of the tail checks', () => {
  it('over 400 random tapes on both programs, checked after every record, with every kind of since', () => {
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
          if (since !== null) expect(strip(checkPoolTails(ctx(kept), POOL, since)), `seed ${seed} record ${i}`).toEqual(strip(checkPoolTails(ctx(full), POOL, since)));
        }
        expect(strip(checkCurveTails(ctx(kept), MINT)), `seed ${seed} record ${i}`).toEqual(strip(checkCurveTails(ctx(full), MINT)));
      }
    }
  });

  it('a clean tape keeps one entry per key however long it runs; offenders and unreadable entries all stay', () => {
    const clock = new SimClock(ORIGIN);
    const store = new AsOfStore(clock, null, tradeTailCollapse);
    const [buy] = poolTradeKeys(POOL);
    const slot = EVENT_TAIL_UPGRADE_SLOT.pump_amm + 10n;
    const clean = { event: { trailing: 8, extra: '0000000000000000' }, txSlot: slot, signature: 'S' };
    for (let k = 1; k <= 5_000; k++) {
      const m = { slot: slot + BigInt(k), txIndex: 0, ixIndex: 0, receivedAt: k };
      clock.advanceTo(m);
      store.record(buy!, k === 100 ? { event: { trailing: 8, extra: 'ff00000000000000' }, txSlot: slot, signature: 'Bad' } : k === 200 ? { event: {} } : clean, m, `ev:${k}`);
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
