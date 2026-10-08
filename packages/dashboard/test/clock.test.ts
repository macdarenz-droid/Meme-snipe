// The dashboard's clocks (src/lib/clock.ts): the wall clock in epoch milliseconds, and the monotonic clock for durations.
import { strict as assert } from 'node:assert';
import { describe, it, vi } from 'vitest';
import { monotonicClock, wallClock } from '../src/lib/clock.ts';

describe('wallClock', () => {
  it('reads the wall clock in epoch milliseconds', () => {
    const a = wallClock.nowMs();
    const b = wallClock.nowMs();
    assert.ok(Number.isInteger(a) && a > Date.parse('2026-01-01T00:00:00Z'));
    assert.ok(b >= a);
    assert.equal(wallClock.kind, 'wall');
  });
});

describe('monotonicClock', () => {
  it('reads performance.now, which a wall-clock correction does not move', () => {
    const a = monotonicClock.nowMs();
    const b = monotonicClock.nowMs();
    assert.ok(b >= a);
    const now = vi.spyOn(performance, 'now').mockImplementation(() => 1234.5);
    try {
      assert.equal(monotonicClock.nowMs(), 1234.5);
      assert.equal(now.mock.calls.length, 1);
    } finally {
      now.mockRestore();
    }
  });
});
