// The worker's capped maps (create signatures, token symbols) forget the oldest key in O(1), however many keys were
// forgotten before (review of #179: `keys().next()` after many deletes walks V8's deleted slots).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CappedMap } from '../src/run/capped-map.ts';
import { recordFromRpc, type RpcTransactionBase64 } from '../../core/src/chain/index.ts';
import { migrationKey } from '../../core/src/gates/index.ts';
import { Market, makeWorker, slotAt, virtualTimers } from './worker-harness.ts';

describe('CappedMap', () => {
  it('keeps the newest `max` keys, forgets the oldest-inserted first, and an update keeps its place', () => {
    const m = new CappedMap<string, number>(3);
    m.set('a', 1).set('b', 2).set('c', 3);
    m.set('a', 10); // an update: 'a' stays the oldest
    m.set('d', 4);
    expect([m.size, m.has('a'), m.get('b'), m.get('c'), m.get('d')]).toEqual([3, false, 2, 3, 4]);
    m.set('e', 5).set('f', 6);
    expect([m.has('b'), m.has('c'), m.get('d'), m.get('e'), m.get('f')]).toEqual([false, false, 4, 5, 6]);
    expect(() => new CappedMap(0)).toThrow(RangeError);
  });

  it('matches a Map trimmed oldest-first on a long mixed run', () => {
    const m = new CappedMap<string, number>(50);
    const ref = new Map<string, number>();
    for (let i = 0; i < 5_000; i++) {
      const k = `k${(i * 7919) % 400}`;
      m.set(k, i);
      ref.set(k, i);
      if (ref.size > 50) ref.delete(ref.keys().next().value!);
      if (i % 97 === 0) expect([...ref].every(([key, v]) => m.get(key) === v) && m.size === ref.size).toBe(true);
    }
  });

  it('eviction cost does not grow with the keys forgotten: 600,000 inserts at a cap of 50,000 well under the old 17 s', () => {
    const m = new CappedMap<string, number>(50_000);
    const t = performance.now();
    for (let i = 0; i < 600_000; i++) m.set(`k${i}`, i);
    expect(m.size).toBe(50_000);
    expect(m.has('k549999')).toBe(false);
    expect(m.get('k599999')).toBe(599_999);
    expect(performance.now() - t).toBeLessThan(5_000);
  });
});

describe('no oldest-key eviction by iteration in the worker (guard)', () => {
  it('worker.ts trims no map with keys().next()', () => {
    expect(readFileSync(join(import.meta.dirname, '..', 'src', 'run', 'worker.ts'), 'utf8')).not.toMatch(/keys\(\)\.next\(\)/);
  });
});

describe('the live create signatures stay at their cap (review of #179)', () => {
  interface Case { readonly mint: string; readonly transactions: readonly (RpcTransactionBase64 & { readonly signature: string })[] }
  // Real mainnet creates (each case's first transaction is its pump CreateV2), three different mints.
  const CASES = (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rug-replay.json'), 'utf8')) as { cases: Case[] }).cases.slice(0, 3);

  it('three live creates at a cap of two keep the newest two; the oldest mint\'s shortlist reads nothing', async () => {
    const recs = CASES.map((c) => recordFromRpc(c.transactions[0]!.signature, c.transactions[0]!, null));
    const fetched: string[] = [];
    const h = makeWorker({ timers: virtualTimers(Math.max(...recs.map((r) => (r.blockTime ?? 0) * 1000))), fetched, createSigsMax: 2 });
    await h.worker.reconcile();
    for (const [i, rec] of recs.entries()) {
      h.worker.feed.ingest('helius', { type: 'slot', slot: rec.slot + 3n, parent: rec.slot + 2n, root: null }, { receivedAt: h.timers.now() });
      h.worker.feed.ingest('helius', { type: 'logs', signature: CASES[i]!.transactions[0]!.signature, slot: rec.slot, err: rec.err, via: 'pump', logs: rec.logMessages ?? [] }, { receivedAt: h.timers.now() });
      h.worker.step();
    }
    const m = new Market(h);
    m.slot(slotAt(h.timers.now()) + 10n ** 9n);
    const migrate = (mint: string): void => m.fact(migrationKey(mint), { obs: { provider: 'test', slot: null, receivedAt: h.timers.now(), quality: [], commitment: 'confirmed' }, graduatedAtMs: h.timers.now(), migratedAtMs: h.timers.now(), pool: mint, quoteAtMigration: 1n, price: { quote: 1n, base: 1n } });
    for (const c of CASES) migrate(c.mint);
    await m.run(3_000);
    // The oldest (first) create was forgotten; the two newest are read by their signatures.
    expect(fetched.sort()).toEqual([CASES[1]!.transactions[0]!.signature, CASES[2]!.transactions[0]!.signature].sort());
    expect(h.logs.some((l) => l.includes(`Shortlisted ${CASES[0]!.mint}`))).toBe(true);
    await h.worker.stop();
  });
});

