// OOM-MINT: the worker's capped signature and symbol maps are sized to the 12-hour create rule, and a kept mint is a
// flat copy that never holds the key it was cut from.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CREATE_KEEP_MS } from '../src/engine/strategy.ts';
import { CREATE_SIGS_MAX, SYMBOLS_MAX, TX_SIGS_MAX, flat } from '../src/run/worker.ts';
import { CappedMap } from '../src/run/capped-map.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const text = (i: number, n: number): string => JSON.parse(JSON.stringify(Array.from({ length: n }, (_, k) => B58[(i * 7 + k * 13 + (i >> k % 16)) % 58]).join(''))) as string;

describe('capped signatures and symbols (OOM-MINT)', () => {
  it('cover the 12 hours a create is kept at three times the live 25 creates a minute, and no more than 60,000', () => {
    const creates = (CREATE_KEEP_MS / 60_000) * 75;
    for (const cap of [CREATE_SIGS_MAX, SYMBOLS_MAX]) {
      expect(cap).toBeGreaterThanOrEqual(creates);
      expect(cap).toBeLessThanOrEqual(60_000);
    }
    // Curve completions and migrations: a week at one a minute, where a candidate's window is hours.
    expect(TX_SIGS_MAX).toBeGreaterThanOrEqual(7 * 24 * 60);
    expect(TX_SIGS_MAX).toBeLessThanOrEqual(20_000);
  });

  it('a full create-signature map costs under 230 B an entry: the mint never keeps its 66-character key alive', () => {
    const map = new CappedMap<string, string>(CREATE_SIGS_MAX);
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < CREATE_SIGS_MAX; i++) {
      const key = `logs:pump:CreateEvent:${text(i, 44)}`;
      map.set(flat(key.slice('logs:pump:CreateEvent:'.length)), flat(text(i + 1e6, 88)));
    }
    gc();
    expect(map.size).toBe(CREATE_SIGS_MAX);
    expect((process.memoryUsage().heapUsed - before) / CREATE_SIGS_MAX).toBeLessThan(230);
  });
});
