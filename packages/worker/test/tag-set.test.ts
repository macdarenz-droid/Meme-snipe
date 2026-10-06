// FEED-KEYS: the live feed's dedupe tags in an open-addressing table.
import { describe, expect, it } from 'vitest';
import { TagSet, keyTag } from '../src/providers/tag-set.ts';

describe('TagSet', () => {
  it('a key tag is two 48-bit numbers, the same for the same key', () => {
    const t = keyTag('seen:5Abc');
    expect(t.every((n) => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 48)).toBe(true);
    expect(keyTag('seen:5Abc')).toEqual(t);
    expect(keyTag('logs:5Abc')).not.toEqual(t);
  });

  it('agrees with a Set through 200,000 random adds and deletes, growing and shrinking, with crowded homes', () => {
    const s = new TagSet();
    const model = new Set<string>();
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    // Small numbers: many tags share a home bucket, so runs, wraps and backward shifts are exercised.
    const tag = (): [number, number] => [Math.floor(rnd() * 64), Math.floor(rnd() * 4096)];
    for (let k = 0; k < 200_000; k++) {
      const t = tag();
      const id = t.join(':');
      const phase = Math.floor(k / 50_000) % 2 === 0 ? 0.7 : 0.3;
      if (rnd() < phase) expect(s.add(t)).toBe(!model.has(id)), model.add(id);
      else expect(s.delete(t)).toBe(model.delete(id));
      if (k % 997 === 0) for (const x of model) expect(s.has(x.split(':').map(Number) as [number, number])).toBe(true);
      expect(s.size).toBe(model.size);
    }
    for (let a = 0; a < 64; a++) for (let b = 0; b < 4096; b += 37) expect(s.has([a, b])).toBe(model.has(`${a}:${b}`));
  }, 120_000);

  it('a run that wraps past the table\'s end keeps every entry findable through deletes', () => {
    // Capacity 256: these all have home 255 or 0, so their run wraps from the last slot to the first.
    const near = (k: number): [number, number] => [k, 255 - k + (k % 2) * 256];
    const ends: [number, number][] = [[1, 254], [2, 509], [0, 256], [3, 253]];
    for (let pass = 0; pass < 4; pass++) {
      const s = new TagSet();
      const all = [...Array.from({ length: 6 }, (_, k) => near(k)), ...ends];
      expect(new Set(all.map((t) => t.join(":"))).size).toBe(all.length);
      for (const t of all) s.add(t);
      // Delete one at a time in a different order each pass; the rest stay findable.
      const order = [...all.keys()].map((k) => (k * (pass + 3)) % all.length);
      const gone = new Set<number>();
      for (const k of order) {
        if (gone.has(k)) continue;
        expect(s.delete(all[k]!)).toBe(true);
        gone.add(k);
        all.forEach((t, j) => expect(s.has(t), `pass ${pass} after ${k}: ${j}`).toBe(!gone.has(j)));
      }
    }
  });

  it('an entry sitting at its own home just past the wrap stays put when the hole is the last slot', () => {
    const s = new TagSet();
    const last: [number, number] = [0, 255];
    const first: [number, number] = [0, 256];
    s.add(last);
    s.add(first);
    expect(s.delete(last)).toBe(true);
    expect([s.has(first), s.has(last), s.size]).toEqual([true, false, 1]);
  });
});

