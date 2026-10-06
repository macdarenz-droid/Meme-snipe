// SAVE-SPIKE: the 5-min save must not allocate its payload whole. Live (5efb9ae0, crash 27) died at a save: about
// 100 MB of large objects on top of old space, from the payload line (41.2k coverage facts, about 23 MB of text) made
// as one string and copied again for its newline, then written whole. The payload now goes out piece by piece,
// byte for byte the same text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapSpaceStatistics } from 'node:v8';
import { writeSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import type { MarketEvent, Moment } from '../../core/src/engine/index.ts';
import { DeployerIndex, RugLabeller } from '../../core/src/gates/index.ts';
import { loadState, saveState, streamJson, type SavedState } from '../src/persist/index.ts';
import { tempState } from './worker-harness.ts';

const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? { $bigint: v.toString() } : v);
const streamed = (v: unknown, depth: number): { text: string; pieces: string[] } => {
  const pieces: string[] = [];
  streamJson(v, (t) => pieces.push(t), depth);
  return { text: pieces.join(''), pieces };
};

const SLOT = 400_000_000n;
const T = 1_790_000_000_000;
const ASOF: Moment = { slot: SLOT, txIndex: 5, ixIndex: 0, receivedAt: T };
/** A saved state with `n` coverage facts (live had 41.2k), the shape the worker saves. */
const stateWith = (n: number): SavedState => {
  const coverage: MarketEvent[] = [];
  for (let k = 0; k < n; k++) {
    const slot = SLOT - BigInt(n - k);
    coverage.push({ kind: 'market', id: `cov:${k}`, moment: { slot, txIndex: 9_007_199_254_740_991, ixIndex: k, receivedAt: T - (n - k) * 400 }, key: k % 2 === 0 ? 'coverage:trades:gap' : 'coverage:trades:resume', value: { value: { fromSlot: slot - 10n, toSlot: slot, reason: 'disconnect', via: `logs:${'P'.repeat(43)}${k % 500}` }, source: 'worker', backfilled: false, seq: k } });
  }
  return { asOf: ASOF, index: new DeployerIndex().snapshot(ASOF), labeller: new RugLabeller(RUG_CONFIG).snapshot(), coverage, candidates: [], tails: [] };
};

describe('SAVE-SPIKE: the payload streamed', () => {
  it('streamJson is JSON.stringify with the bigint replacer, byte for byte, at every depth', () => {
    const date = new Date(T);
    const cases: unknown[] = [
      { a: 1n, b: [1, 'x"\\n\u2028', null, undefined, () => 1, Symbol('s'), { c: undefined, d: 2n }], e: undefined, f: () => 0, g: date, h: {}, i: [], j: [[[]]], k: { toJSON: (key: string) => `j:${key}` } },
      [1n, [2n, [3n, [4n]]], { z: [{ y: -0, x: 1.5e300 }] }],
      'plain', 7, null, true, 12n, date,
    ];
    for (const v of cases) for (const d of [0, 1, 2, 3, 4, 8]) expect(streamed(v, d).text).toBe(JSON.stringify(v, replacer));
  });

  it('a saved file is byte for byte what the one-string payload wrote, and loads', () => {
    const s = stateWith(2_000);
    const path = join(tempState(), 'deployer-state.json');
    saveState(path, s);
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines[1]).toBe(JSON.stringify({ ...s, index: { ...s.index, mints: [] } }, replacer));
    const back = loadState(path, RUG_CONFIG);
    expect(back.ok ? back.coverage.filter((e) => e.id.startsWith('cov:')).length : back.reason).toBe(2_000);
  });

  it('at live size (41.2k coverage facts) no write and no piece is near the payload: each write is about 1 MiB at most', () => {
    const s = stateWith(41_200);
    const writes: number[] = [];
    const write = (fd: number, buf: Uint8Array, off: number, len: number): number => {
      writes.push(len);
      return writeSync(fd, buf, off, len);
    };
    const payload = JSON.stringify({ ...s, index: { ...s.index, mints: [] } }, replacer).length;
    expect(payload).toBeGreaterThan(15 << 20);
    saveState(join(tempState(), 'deployer-state.json'), s, { write });
    // A batch is flushed once it reaches 1 MiB, so it is at most 1 MiB plus one piece (a coverage fact, under 1 KiB).
    expect(writes.reduce((m, n) => Math.max(m, n), 0)).toBeLessThan((1 << 20) + 1024);
    expect(streamed({ ...s, index: { ...s.index, mints: [] } }, 3).pieces.reduce((m, p) => Math.max(m, p.length), 0)).toBeLessThan(1024);
  });

  it('at live size a save adds under 4 MB to large-object space (before: about twice the payload, 30 MB and more)', () => {
    const s = stateWith(41_200);
    const path = join(tempState(), 'deployer-state.json');
    const lo = () => getHeapSpaceStatistics().find((x) => x.space_name === 'large_object_space')!.space_used_size;
    saveState(path, stateWith(10));
    const before = lo();
    saveState(path, s);
    // Measured without a collection: what the save allocated large is still counted (a collection can only lower it).
    expect((lo() - before) / 1048576).toBeLessThan(4);
  });
});
