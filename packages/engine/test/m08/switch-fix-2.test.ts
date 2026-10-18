// Card SWITCH-FIX-2 SW-43 (amends ruling Z09-23): a stopped pool is kept for idleForgetMs after its stop, refusing late
// events, then forgotten; resume() lets a re-watched pool's bars start again. Before, a stopped pool was kept for ever
// (the 192 h probe: 1,966 entries at h96, 3,874 at h192) and a re-watched pool never had bars again.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { BAR_DEFAULTS, createBarEngine, renderSpot, type BarSnapshot, type PollCountsIn } from '../../src/m08/bars.ts';

const T0 = Date.UTC(2026, 9, 16, 0, 0, 0);
const BAR = 15_000;
const CLOSE = BAR + 1_500;
const FORGET = BAR_DEFAULTS.idleForgetMs;
const snap = (atMs: number, price: bigint, poolId = 'pool-a'): BarSnapshot =>
  ({ poolId, observedAtMs: atMs as UnixMs, spotSolPerToken: renderSpot(price), effectiveQuoteLamports: 10n ** 12n, realQuoteLamports: 10n ** 12n });
const counts = (barStartMs: number, successfulPolls: number, poolId = 'pool-a'): PollCountsIn =>
  ({ poolId, barStartMs: barStartMs as UnixMs, durationMs: BAR, successfulPolls, receivedAtMs: (barStartMs + CLOSE) as UnixMs });
const at = (ms: number): UnixMs => ms as UnixMs;

describe('SW-43: stopped pools in the bar engine', () => {
  it('a stopped pool is kept for idleForgetMs after its stop, then forgotten and counted (fails before: kept for ever)', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n), 1_000);
    e.onPollCounts(counts(T0, 15));
    assert.equal(e.closeDue(at(T0 + CLOSE)).length, 1);
    e.stop('pool-a', at(T0 + 20_000));
    e.closeDue(at(T0 + 20_000 + FORGET - 1));
    assert.equal(e.size(), 1, 'kept inside the window');
    e.closeDue(at(T0 + 20_000 + FORGET));
    assert.equal(e.size(), 0, 'forgotten once the window has passed');
    assert.equal(e.stats().forgotten, 1);
  });

  it('inside the window a stopped pool\'s late snapshots and counts are refused (no bar), and do not extend it (fails before: never forgotten)', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n), 1_000);
    e.stop('pool-a', at(T0 + 5_000));
    e.onSnapshot(snap(T0 + 6_000, 101n), 1_000);
    e.onPollCounts(counts(T0, 15));
    e.onSnapshot(snap(T0 + 20_000, 102n), 1_000);
    e.onPollCounts(counts(T0 + BAR, 15));
    assert.deepEqual(e.closeDue(at(T0 + 5_000 + FORGET - 1)), []);
    assert.equal(e.size(), 1);
    assert.deepEqual(e.closeDue(at(T0 + 5_000 + FORGET)), []);
    assert.equal(e.size(), 0, 'the window runs from the stop, not from the refused events');
  });

  it('stop() of a pool the engine never saw is forgotten after the window too (fails before: a permanent entry)', () => {
    const e = createBarEngine();
    e.stop('pool-x', at(T0));
    assert.equal(e.size(), 1);
    e.onSnapshot(snap(T0 + 1_000, 100n, 'pool-x'), 1_000);                            // refused: stopped
    assert.deepEqual(e.closeDue(at(T0 + FORGET - 1)), []);
    assert.equal(e.size(), 1);
    e.closeDue(at(T0 + FORGET));
    assert.equal(e.size(), 0);
  });

  it('1,000 pools watched then stopped: memory stays bounded (fails before: all 1,000 kept)', () => {
    const e = createBarEngine();
    for (let i = 0; i < 1_000; i++) {
      const t = T0 + i * 60_000;
      const id = `pool-${i}`;
      e.onSnapshot(snap(t, 100n + BigInt(i), id), 1_000);
      e.onPollCounts(counts(t, 15, id));
      e.stop(id, at(t + 30_000));
      e.closeDue(at(t + 30_000));
      assert.ok(e.size() <= Math.ceil(FORGET / 60_000) + 1, `${e.size()} pools held at ${i}`);
    }
    assert.ok(e.stats().forgotten >= 989);
  });

  it('a re-watched pool gets bars again, opening at its carried state (fails before: no bar after a stop)', () => {
    const e = createBarEngine();
    e.onSnapshot(snap(T0, 100n), 1_000);
    e.onPollCounts(counts(T0, 15));
    assert.equal(e.closeDue(at(T0 + CLOSE)).length, 1);
    e.stop('pool-a', at(T0 + 20_000));
    e.resume('pool-a');
    const b0 = T0 + 4 * BAR;
    e.onSnapshot(snap(b0 + 1_000, 105n), 1_000);
    e.onPollCounts(counts(b0, 15));
    const bars = e.closeDue(at(b0 + CLOSE));
    assert.equal(bars.length, 1);
    assert.equal(bars[0]?.startMs, b0);
    assert.equal(bars[0]?.open, renderSpot(100n), 'opens at the carried state, as replay would');
    assert.equal(bars[0]?.close, renderSpot(105n));
    e.closeDue(at(b0 + CLOSE + FORGET));
    assert.equal(e.size(), 0, 'a resumed pool idles out as any other');
  });
});
