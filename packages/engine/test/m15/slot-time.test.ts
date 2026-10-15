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
  blockTimeAnchor, historySlotTimeBasis, liveSlotTimeBasis, MAX_ANCHOR_GAP_MS, slotDelta, slotSpanMs, slotToTimeMs, slotToUnixMs, timeToSlot, type SlotTimeAnchor, type SlotTimeBasis,
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

describe('B1 on recorded daily anchors: each day has its own slot length (2026-07-23 ≈ 420 ms, 2026-09-06 ≈ 316 ms)', () => {
  // Recorded daily anchors from 2026-07-22 to 2026-09-07 (research/launch-probe): slot time fell from about 420 ms to
  // about 316 ms over those weeks. Too far apart for a basis (ruling Z06-7), so these tests use the anchors directly.
  const daily = anchorsOf('daily_2026_07_22_to_09_07');
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
    it(`${label}: the old 400 ms rule dates the day's end slot minutes away from its block time`, () => {
      const start = daily[i] as SlotTimeAnchor, end = daily[i + 1] as SlotTimeAnchor;
      const check = (dated: number): void => assert.ok(Math.abs(dated - end.atMs) <= 1_000, `${dated - end.atMs} ms`);
      check(start.atMs + slotDelta(start.slot, end.slot) * dayRate(i));   // the day's own slot length
      assert.throws(() => check(oldDate(start, end.slot)));
      assert.ok(Math.abs(oldDate(start, end.slot) - end.atMs) > 60_000);
    });
  }

  it('ruling Z06-7: a basis from daily anchors is refused, and the 60 s maximum can be tightened but never widened', () => {
    assert.throws(() => historySlotTimeBasis(daily), /E_SLOT_BASIS: anchors \d+ ms apart, more than 60000 ms/);
    assert.throws(() => historySlotTimeBasis(daily, { maxAnchorGapMs: 86_400_000 }), /maximum anchor gap/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(0), 0), blockTimeAnchor(S(150), 61)]), /more than 60000/);
    assert.equal(historySlotTimeBasis([blockTimeAnchor(S(0), 0), blockTimeAnchor(S(150), 60)]).kind, 'history');
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(0), 0), blockTimeAnchor(S(150), 40)], { maxAnchorGapMs: 30_000 }), /more than 30000/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(0), 0), blockTimeAnchor(S(10), 3)], { maxAnchorGapMs: 0 }), /maximum anchor gap/);
  });
});

/** Runs of a recorded set whose neighbours are at most 60 s apart; in each, anchors kept greedily at most 60 s apart. */
function keptAndHeld(set: readonly SlotTimeAnchor[]): { bases: SlotTimeBasis[]; held: Array<{ a: SlotTimeAnchor; b: SlotTimeBasis }>; kept: number } {
  const runs: SlotTimeAnchor[][] = [];
  for (const a of set) {
    const run = runs.at(-1), last = run?.at(-1);
    if (run !== undefined && last !== undefined && a.atMs - last.atMs <= MAX_ANCHOR_GAP_MS) run.push(a); else runs.push([a]);
  }
  const bases: SlotTimeBasis[] = [], held: Array<{ a: SlotTimeAnchor; b: SlotTimeBasis }> = [];
  let kept = 0;
  for (const run of runs) {
    if (run.length < 3) continue;
    // Keep the first anchor, then the farthest anchor within 60 s of the last kept one; the ones skipped are held out.
    const keep: SlotTimeAnchor[] = [run[0] as SlotTimeAnchor], skipped: SlotTimeAnchor[] = [];
    let i = 0;
    while (i < run.length - 1) {
      let j = i + 1;
      while (j + 1 < run.length && (run[j + 1] as SlotTimeAnchor).atMs - (run[i] as SlotTimeAnchor).atMs <= MAX_ANCHOR_GAP_MS) j++;
      for (let k = i + 1; k < j; k++) skipped.push(run[k] as SlotTimeAnchor);
      keep.push(run[j] as SlotTimeAnchor);
      i = j;
    }
    if (keep.length < 2 || new Set(keep.map((a) => a.atMs)).size < 2) continue;
    const b = historySlotTimeBasis(keep);
    bases.push(b);
    kept += keep.length;
    for (const a of skipped) held.push({ a, b });
  }
  return { bases, held, kept };
}

describe('A10 acceptance (ruling Z06-7): with anchors at most 60 s apart, slots convert within ±1 s at the anchors and ±2 s between them, on two dates', () => {
  // Recorded October sets (no live call): 2026-10-01/02 (mean 267.6 ms a slot) and 2026-10-06/07 (269.4 ms). A10's ±1 s
  // holds at the anchors (whole-second block times); between anchors at most 60 s apart the tolerance is ±2 s.
  const mean = (set: readonly SlotTimeAnchor[]): number => ((set.at(-1) as SlotTimeAnchor).atMs - (set[0] as SlotTimeAnchor).atMs) / slotDelta((set[0] as SlotTimeAnchor).slot, (set.at(-1) as SlotTimeAnchor).slot);

  it('the two dates have different mean slot lengths', () => {
    const a = mean(anchorsOf('dense_2026_10_01')), b = mean(anchorsOf('dense_2026_10_06'));
    assert.ok(a > 265 && a < 272 && b > 265 && b < 272 && Math.abs(a - b) > 1, `${a} ${b}`);
  });

  for (const [key, minHeld] of [['dense_2026_10_01', 200], ['dense_2026_10_06', 1]] as const) {
    it(`${key}: every kept anchor within ±1 s, every held-out anchor between them within ±2 s`, () => {
      const { bases, held, kept } = keptAndHeld(anchorsOf(key));
      assert.ok(bases.length > 0 && kept >= 2);
      assert.ok(held.length >= minHeld, `${held.length} held out`);
      for (const b of bases) for (const a of (b as { anchors: readonly SlotTimeAnchor[] }).anchors) assert.ok(Math.abs(slotToTimeMs(a.slot, b) - a.atMs) <= 1_000);
      for (const { a, b } of held) {
        assert.ok(Math.abs(slotToTimeMs(a.slot, b) - a.atMs) <= 2_000, `${a.slot}: ${slotToTimeMs(a.slot, b) - a.atMs} ms`);
        assert.ok(Math.abs(slotToUnixMs(a.slot, b) - a.atMs) <= 2_000);
      }
    });
  }
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
      const n = 1 + (rng.nextU32() % 130);                             // at most 58.5 s apart (ruling Z06-7)
      s += n;
      t += Math.floor((n * (200 + rng.nextFloat() * 250)) / 1_000);   // whole seconds, sometimes flat
    }
    anchors.push(blockTimeAnchor(S(s), t), blockTimeAnchor(S(s + 130), t + 40));   // ends with a sloped pair (130 slots in 40 s)
    return historySlotTimeBasis(anchors);
  };

  it('property: timeToSlot gives the first slot at or after the time, inside, before and after the anchors', () => {
    for (let seed = 0; seed < 300; seed++) {
      const basis = randomBasis(seed), rng = createRng(10_000 + seed);
      // Live: anywhere around the anchor; history: within the 60 s extrapolation limit (Z06-10) on either side.
      const lo = basis.kind === 'live' ? basis.anchor.atMs - 600_000 : (basis.anchors[0] as SlotTimeAnchor).atMs - basis.maxGapMs;
      const hi = basis.kind === 'live' ? basis.anchor.atMs + 2_400_000 : (basis.anchors.at(-1) as SlotTimeAnchor).atMs + basis.maxGapMs;
      for (let k = 0; k < 40; k++) {
        const ms = lo + rng.nextFloat() * (hi - lo);
        const s = timeToSlot(ms, basis);
        assert.ok(slotToTimeMs(s, basis) >= ms, `seed ${seed}`);
        if (s > 0n) {
          // The slot before may lie beyond the 60 s extrapolation limit (Z06-10); then it is refused, not dated.
          let before: number | null = null;
          try { before = slotToTimeMs((s - 1n) as Slot, basis); } catch (e) { assert.match(String(e), /outside the anchors/); }
          if (before !== null) assert.ok(before < ms, `seed ${seed}`);
        }
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
    const h = historySlotTimeBasis([blockTimeAnchor(S(100), 1_000), blockTimeAnchor(S(300), 1_060)]);
    assert.equal(timeToSlot(1_060_000, h), S(300));
    assert.equal(timeToSlot(1_000_000, h), S(100));
  });

  it('slot time never falls as slots rise (history bases)', () => {
    for (let seed = 0; seed < 100; seed++) {
      const basis = randomBasis(seed);
      if (basis.kind !== 'history') continue;
      const first = (basis.anchors[0] as SlotTimeAnchor).slot, last = (basis.anchors.at(-1) as SlotTimeAnchor).slot;
      let prev = -Infinity;
      // 100 slots on either side stay within the 60 s extrapolation limit (these bases run at most 450 ms a slot).
      for (let x = first - 100n; x <= last + 100n; x += 7n) {
        const t = slotToTimeMs(x as Slot, basis);
        assert.ok(t >= prev);
        prev = t;
      }
    }
  });

  it('outside the anchors, history extrapolates at the nearest pair with a positive rate (a flat end pair is skipped)', () => {
    const b = historySlotTimeBasis([blockTimeAnchor(S(100), 1_000), blockTimeAnchor(S(102), 1_000), blockTimeAnchor(S(302), 1_050), blockTimeAnchor(S(304), 1_050)]);
    assert.equal(slotToTimeMs(S(0), b), 1_000_000 - 100 * 250);
    assert.equal(slotToTimeMs(S(504), b), 1_050_000 + 200 * 250);
    assert.equal(timeToSlot(999_000, b), S(96));
    assert.equal(timeToSlot(1_000_000, b), S(100));               // slots 100-102 share that second (the flat pair)
    assert.equal(timeToSlot(1_000_001, b), S(103));
  });

  it('ruling Z06-10: a history basis extrapolates at most 60 s beyond its first or last anchor, both ways', () => {
    const b = historySlotTimeBasis([blockTimeAnchor(S(1_000), 1_000), blockTimeAnchor(S(1_200), 1_050)]);   // 250 ms a slot
    assert.equal(slotToTimeMs(S(760), b), 940_000);                    // exactly 60 s before the first anchor
    assert.equal(slotToTimeMs(S(1_440), b), 1_110_000);                // exactly 60 s after the last
    assert.throws(() => slotToTimeMs(S(759), b), /E_SLOT_BASIS: slot 759 is more than 60000 ms outside the anchors/);
    assert.throws(() => slotToTimeMs(S(1_441), b), /more than 60000 ms outside/);
    assert.equal(timeToSlot(940_000, b), S(760));
    assert.equal(timeToSlot(1_110_000, b), S(1_440));
    assert.throws(() => timeToSlot(939_999, b), /E_SLOT_BASIS: time 939999 is more than 60000 ms outside the anchors/);
    assert.throws(() => timeToSlot(1_110_001, b), /more than 60000 ms outside/);
    // A tightened basis tightens the limit too.
    const t = historySlotTimeBasis([blockTimeAnchor(S(1_000), 1_000), blockTimeAnchor(S(1_080), 1_020)], { maxAnchorGapMs: 30_000 });
    assert.throws(() => slotToTimeMs(S(1_201), t), /more than 30000 ms outside/);
  });

  it('refuses a basis that is not a sound clock (E_SLOT_BASIS)', () => {
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(1), 1)]), /E_SLOT_BASIS/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(1), 1), blockTimeAnchor(S(1), 2)]), /one slot/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(1), 5), blockTimeAnchor(S(10), 4)]), /falls/);
    assert.throws(() => historySlotTimeBasis([blockTimeAnchor(S(0), 0), blockTimeAnchor(S(10), 59)]), /slot time outside/);
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
