// The one slot-to-time function (B-M15-01, C-61; addendum A10; bug B1). Each B1 test also runs the old Zeroed rule
// (a fixed 400 ms slot, `SLOT_MS = 400`, docs/MIGRATION.md "Known bugs" B1) through the same check and asserts that
// the check rejects it: the test fails on the old behaviour and passes on the new.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { Slot } from '@bot/types';
import { createRng } from '../../src/m10/rng.ts';
import {
  blockTimeAnchor, historySlotTimeBasis, liveSlotTimeBasis, slotDelta, slotSpanMs, slotToTimeMs, slotToUnixMs, timeToSlot, type SlotTimeAnchor, type SlotTimeBasis,
} from '../../src/m15/slot-time.ts';

const S = (n: number | bigint): Slot => BigInt(n) as Slot;
type Pairs = Array<[number, number]>;
const FX = JSON.parse(readFileSync(new URL('./fixtures/block-times.json', import.meta.url), 'utf8')) as Record<string, { anchors: Pairs }>;
const anchorsOf = (key: string): SlotTimeAnchor[] => (FX[key]?.anchors ?? []).map(([s, t]) => blockTimeAnchor(S(s), t));

/** Zeroed's rule (B1): every slot is 400 ms after the anchor. */
const OLD_SLOT_MS = 400;
const oldDate = (anchor: SlotTimeAnchor, s: Slot): number => anchor.atMs + slotDelta(anchor.slot, s) * OLD_SLOT_MS;

describe('B1: dating uses the measured slot time, never 400 ms', () => {
  it('MIGRATION B1 case 1: anchors 250 ms apart, a pool update 100 slots later is dated anchor + 25,000 ms (old: + 40,000)', () => {
    const a0 = { slot: S(1_000), atMs: 1_790_000_000_000 }, a1 = { slot: S(1_001), atMs: 1_790_000_000_250 };
    const basis = historySlotTimeBasis([a0, a1]);
    const check = (dated: number): void => assert.equal(dated, a0.atMs + 25_000);
    check(slotToTimeMs(S(1_100), basis));
    assert.throws(() => check(oldDate(a0, S(1_100))));            // old: anchor + 40,000 ms, 15 s late
    // Up to the 150-slot cap the old error reaches 22.5 s.
    assert.equal(oldDate(a0, S(1_150)) - slotToTimeMs(S(1_150), basis), 22_500);
  });

  it('MIGRATION B1 case 2: a landing 23 slots after the decision is dated at the measured 250 ms (5,750 ms, old: 9,200 ms)', () => {
    const decision = { slot: S(5_000), atMs: 1_790_000_000_000 };
    const basis = liveSlotTimeBasis(decision, 250);
    const check = (ms: number): void => assert.equal(ms, 5_750);
    check(slotSpanMs(decision.slot, S(5_023), basis));
    assert.throws(() => check(oldDate(decision, S(5_023)) - decision.atMs));
  });
});

describe('A10 acceptance: slots convert within ±1 s of getBlockTime anchors on two dates with different slot lengths', () => {
  // Recorded daily anchors from 2026-07-22 to 2026-09-07 (research/launch-probe): slot time fell from about 420 ms to
  // about 316 ms over those weeks.
  const daily = anchorsOf('daily_2026_07_22_to_09_07');
  const basis = historySlotTimeBasis(daily);
  const dayRate = (i: number): number => ((daily[i + 1] as SlotTimeAnchor).atMs - (daily[i] as SlotTimeAnchor).atMs) / slotDelta((daily[i] as SlotTimeAnchor).slot, (daily[i + 1] as SlotTimeAnchor).slot);
  const july = 1, september = daily.length - 2;                       // 2026-07-23 and 2026-09-06 (UTC)

  it('the two dates have different slot lengths', () => {
    // Anchors sit at UTC day boundaries (within seconds); a pair is named by the day its midpoint falls in.
    const day = (i: number): string => new Date(((daily[i] as SlotTimeAnchor).atMs + (daily[i + 1] as SlotTimeAnchor).atMs) / 2).toISOString().slice(0, 10);
    assert.equal(day(july), '2026-07-23');
    assert.equal(day(september), '2026-09-06');
    assert.ok(dayRate(july) > 415 && dayRate(july) < 425, String(dayRate(july)));
    assert.ok(dayRate(september) > 310 && dayRate(september) < 320, String(dayRate(september)));
  });

  for (const [label, i] of [['2026-07-23', july], ['2026-09-06', september]] as const) {
    it(`${label}: the day's start and end slots convert within ±1 s of their block times; the old 400 ms rule misses by minutes`, () => {
      const start = daily[i] as SlotTimeAnchor, end = daily[i + 1] as SlotTimeAnchor;
      const check = (dated: number, anchor: SlotTimeAnchor): void => assert.ok(Math.abs(dated - anchor.atMs) <= 1_000, `${dated - anchor.atMs} ms`);
      check(slotToTimeMs(start.slot, basis), start);
      check(slotToTimeMs(end.slot, basis), end);
      check(slotToUnixMs(end.slot, basis), end);
      // A slot inside the day is dated at that day's own slot length.
      const mid = start.slot + (end.slot - start.slot) / 2n;
      assert.ok(Math.abs(slotSpanMs(start.slot, mid, basis) / slotDelta(start.slot, mid) - dayRate(i)) < 1e-6);
      assert.throws(() => check(oldDate(start, end.slot), end));
      assert.ok(Math.abs(oldDate(start, end.slot) - end.atMs) > 60_000);
    });
  }

  it('every recorded anchor (48 days and both dense October sets) converts within ±1 s on a basis built from its set', () => {
    for (const key of ['daily_2026_07_22_to_09_07', 'dense_2026_10_01', 'dense_2026_10_06']) {
      const set = anchorsOf(key), b = historySlotTimeBasis(set);
      for (const a of set) assert.ok(Math.abs(slotToTimeMs(a.slot, b) - a.atMs) <= 1_000, key);
    }
  });

  // Measured on the recorded October sets (finding for the supervisor, PR body): slot time drifts within a day, so a
  // slot between anchors is dated only as well as the anchors are dense. Per-day anchors are off by tens of seconds at
  // mid-day; anchors one minute apart give about ±2 s on held-out anchors, the floor of a whole-second block time.
  it('held-out anchors: per-day spacing misses by > 30 s mid-day; one-minute spacing stays within ±2 s', () => {
    for (const key of ['dense_2026_10_01']) {
      const set = anchorsOf(key);
      const ends = historySlotTimeBasis([set[0] as SlotTimeAnchor, set[set.length - 1] as SlotTimeAnchor]);
      const worstEnds = Math.max(...set.map((a) => Math.abs(slotToTimeMs(a.slot, ends) - a.atMs)));
      assert.ok(worstEnds > 30_000, String(worstEnds));
      const grid = new Map<number, SlotTimeAnchor>();
      for (const a of set) if (!grid.has(Math.floor(a.atMs / 60_000))) grid.set(Math.floor(a.atMs / 60_000), a);
      const kept = new Set(grid.values()), b = historySlotTimeBasis([...kept]);
      const held = set.filter((a) => !kept.has(a));
      assert.ok(held.length > 300);
      for (const a of held) assert.ok(Math.abs(slotToTimeMs(a.slot, b) - a.atMs) <= 2_000, `${a.slot}`);
    }
  });
});

describe('A10: the 12-, 20- and 8-slot thresholds rechecked at 400, 267 and 200 ms per slot', () => {
  // Recheck result (C-61): every threshold is counted in slots, so it follows the chain; in wall time it shrinks as
  // slots shorten, which is stricter for staleness (12 slots: entry rejected; 8 slots: fresh read and supersede) and
  // for landing (20 slots: LS-4 window, sent→confirmed alarm). No threshold needs to change.
  const at = (slots: number, slotMs: number): number => slotSpanMs(S(0), S(slots), liveSlotTimeBasis({ slot: S(0), atMs: 0 }, slotMs));
  const table: Array<[number, number, number, number]> = [[12, 4_800, 3_204, 2_400], [20, 8_000, 5_340, 4_000], [8, 3_200, 2_136, 1_600]];
  for (const [slots, ms400, ms267, ms200] of table) {
    it(`${slots} slots = ${ms400} / ${ms267} / ${ms200} ms`, () => {
      assert.ok(Math.abs(at(slots, 400) - ms400) < 1e-9);
      assert.ok(Math.abs(at(slots, 267) - ms267) < 1e-9);
      assert.ok(Math.abs(at(slots, 200) - ms200) < 1e-9);
    });
  }
});

describe('slot-time inverse and bases', () => {
  const randomBasis = (seed: number): SlotTimeBasis => {
    const rng = createRng(seed);
    if (rng.nextFloat() < 0.3) return liveSlotTimeBasis({ slot: S(400_000_000 + (rng.nextU32() % 1_000_000)), atMs: 1.79e12 + (rng.nextU32() % 1e6) }, 150 + rng.nextFloat() * 400);
    const anchors: SlotTimeAnchor[] = [];
    let s = 400_000_000, t = 1_790_000_000;
    for (let i = 0, k = 2 + (rng.nextU32() % 20); i < k; i++) {
      anchors.push(blockTimeAnchor(S(s), t));
      const n = 1 + (rng.nextU32() % 5_000);
      s += n;
      t += Math.floor((n * (200 + rng.nextFloat() * 250)) / 1_000);   // whole seconds, sometimes flat
    }
    return historySlotTimeBasis(anchors);
  };

  it('property: timeToSlot gives the first slot at or after the time, inside, before and after the anchors', () => {
    for (let seed = 0; seed < 300; seed++) {
      const basis = randomBasis(seed), rng = createRng(10_000 + seed);
      const ref = basis.kind === 'live' ? basis.anchor : (basis.anchors[0] as SlotTimeAnchor);
      for (let k = 0; k < 40; k++) {
        const ms = ref.atMs + (rng.nextFloat() - 0.2) * 3_000_000;
        const s = timeToSlot(ms, basis);
        assert.ok(slotToTimeMs(s, basis) >= ms, `seed ${seed}`);
        if (s > 0n) assert.ok(slotToTimeMs((s - 1n) as Slot, basis) < ms, `seed ${seed}`);
      }
    }
  });

  it('ruling Z06-6: at a slot\'s exact time, timeToSlot returns that slot even when the first guess overshoots', () => {
    // Slot 1002's time on this basis divides back to just over 2 slots, so the first guess is 1003; only the
    // `>=` step-back (slot-time.ts, the settle loop) returns 1002.
    const b = liveSlotTimeBasis({ slot: S(1_000), atMs: 1_790_000_000_000 }, 267.66);
    const ms = slotToTimeMs(S(1_002), b);
    assert.ok(Math.ceil((ms - 1_790_000_000_000) / 267.66) === 3);
    assert.equal(timeToSlot(ms, b), S(1_002));
    // At an exact anchor time in a history basis too.
    const h = historySlotTimeBasis([blockTimeAnchor(S(100), 1_000), blockTimeAnchor(S(4_100), 2_000)]);
    assert.equal(timeToSlot(2_000_000, h), S(4_100));
    assert.equal(timeToSlot(1_000_000, h), S(100));
  });

  it('slot time never falls as slots rise (history bases)', () => {
    for (let seed = 0; seed < 100; seed++) {
      const basis = randomBasis(seed);
      if (basis.kind !== 'history') continue;
      const first = (basis.anchors[0] as SlotTimeAnchor).slot;
      let prev = -Infinity;
      for (let d = -2_000n; d < 30_000n; d += 37n) {
        const t = slotToTimeMs((first + d) as Slot, basis);
        assert.ok(t >= prev);
        prev = t;
      }
    }
  });

  it('outside the anchors, history extrapolates at the nearest pair with a positive rate (a flat end pair is skipped)', () => {
    const b = historySlotTimeBasis([blockTimeAnchor(S(100), 1_000), blockTimeAnchor(S(102), 1_000), blockTimeAnchor(S(4_102), 2_000), blockTimeAnchor(S(4_104), 2_000)]);
    assert.equal(slotToTimeMs(S(0), b), 1_000_000 - 100 * 250);
    assert.equal(slotToTimeMs(S(8_104), b), 2_000_000 + 4_000 * 250);
    assert.equal(timeToSlot(999_000, b), S(96));
    assert.equal(timeToSlot(1_000_000, b), S(100));               // slots 100-102 share that second (the flat pair)
    assert.equal(timeToSlot(1_000_001, b), S(103));
  });

  it('refuses a basis that is not a sound clock (E_SLOT_BASIS)', () => {
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(1), 1)]), /E_SLOT_BASIS/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(1), 1), blockTimeAnchor(S(1), 2)]), /one slot/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(1), 5), blockTimeAnchor(S(10), 4)]), /falls/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(0), 0), blockTimeAnchor(S(10), 100)]), /slot time outside/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(0), 0), blockTimeAnchor(S(100_000), 1)]), /slot time outside/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(0), 7), blockTimeAnchor(S(2), 7)]), /same time/);
    assert.throws(() => liveSlotTimeBasis({ slot: S(1), atMs: 0 }, 99), /E_SLOT_BASIS/);
    assert.throws(() => liveSlotTimeBasis({ slot: S(1), atMs: 0 }, Number.NaN), /E_SLOT_BASIS/);
    assert.throws(() => blockTimeAnchor(S(1), 1.5), /whole seconds/);
    assert.throws(() => timeToSlot(Number.NaN, liveSlotTimeBasis({ slot: S(1), atMs: 0 }, 250)), /finite/);
  });
});

describe('A10 acceptance: no other slot-duration constant dates anything in the Blueprint packages', () => {
  // Zeroed's six `SLOT_MS = 400` sites stay in the Zeroed folders (not migrated). This guards the new code.
  const ROOT = new URL('../../../', import.meta.url).pathname;
  const PACKAGES = ['botctl', 'contract', 'dashboard', 'decoders', 'engine', 'exitpath', 'research', 'sentinel', 'signer', 'types', 'venue'];
  const BANNED = /\b(SLOT_MS|slotMsAssumed|msPerSlot|MS_PER_SLOT|SLOT_DURATION_MS)\b/;
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
  it('none of SLOT_MS, slotMsAssumed, msPerSlot, MS_PER_SLOT or SLOT_DURATION_MS appears in package sources', () => {
    const hits: string[] = [];
    for (const pkg of PACKAGES) {
      const src = join(ROOT, pkg, 'src');
      let list: string[] = [];
      try { list = files(src); } catch { continue; }
      // Code only: comments may name the removed constants (for example params.ts on `slotMsAssumed`).
      for (const f of list) if (BANNED.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))) hits.push(f);
    }
    assert.deepEqual(hits, []);
  });
});
