// Card SWITCH-FIX-3 SW-34 (red team 1 on 512ee4c6): a retention step that fails the same way every time backs off
// (1 s doubling to 1 h), logs one line a failure, and raises the held state code recorder.retention_failed from the third
// failure in a row until a step succeeds.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { STATE_CODES } from '../../src/recorder-main/compose.ts';
import { RETENTION_BACKOFF_MAX_MS, retentionGate } from '../../src/recorder-main/retention.ts';
import { tempDir } from '../helpers.ts';
import { startRig } from './rig.ts';

describe('SW-34: a failing retention step backs off and is held', () => {
  it('the gate: waits 1 s, 2 s, 4 s ... at most 1 h; failing from the third; one success clears it (fails before: no gate)', () => {
    const g = retentionGate();
    let t = 0;
    const waits: number[] = [];
    for (let i = 0; i < 16; i++) {
      assert.ok(g.due(t));
      const b = g.failed(t);
      waits.push(b.waitMs);
      assert.equal(g.failing(), b.failures >= 3);
      assert.ok(!g.due(t + b.waitMs - 1));
      t += b.waitMs;
    }
    assert.deepEqual(waits.slice(0, 6), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]);
    assert.equal(waits.at(-1), RETENTION_BACKOFF_MAX_MS);
    assert.equal(Math.max(...waits), 3_600_000);
    g.succeeded();
    assert.ok(g.due(t) && !g.failing());
  });

  it('in the recorder: one line a failure, not one a second; the held code from the third failure; cleared by the next step that works', async () => {
    const r = await startRig(tempDir('sw34'));
    try {
      await r.run(5_000);
      assert.ok(STATE_CODES.has('recorder.retention_failed'));
      const db = r.rec.parts.db as { withRetentionClock: unknown };
      const orig = db.withRetentionClock;
      db.withRetentionClock = () => { throw Object.assign(new Error('busy'), { code: 'E_BUSY' }); };
      const before = r.lines.length;
      r.rec.parts.retention.start();
      await r.run(60_000);
      const lines = r.lines.slice(before).map((l) => JSON.parse(l) as { code: string; where?: string; error_code?: string; failures?: number; retry_in_ms?: number });
      const failed = lines.filter((l) => l.code === 'recorder.retention_failed');
      // Tries at about 0, 1, 3, 7, 15, 31 s (and 63 s is past the minute): 6, against one a loop tick before.
      assert.ok(failed.length >= 5 && failed.length <= 6, `${failed.length} lines in a minute`);
      assert.deepEqual(failed.slice(0, 4).map((l) => [l.error_code, l.failures, l.retry_in_ms]), [['E_BUSY', 1, 1_000], ['E_BUSY', 2, 2_000], ['E_BUSY', 3, 4_000], ['E_BUSY', 4, 8_000]]);
      assert.equal(lines.filter((l) => l.code === 'recorder.internal_error' && l.where === 'retention').length, 0);
      assert.ok(r.rec.status().activeCodes.includes('recorder.retention_failed'));
      db.withRetentionClock = orig;
      await r.run(70_000);                                                  // the next try (64 s after the last) works
      assert.ok(!r.rec.status().activeCodes.includes('recorder.retention_failed'), 'cleared');
      assert.ok(r.lines.slice(before).some((l) => (JSON.parse(l) as { code: string }).code === 'recorder.retention'), 'the pass finished');
    } finally {
      await r.rec.stop();
    }
  }, 120_000);
});

// SW-42 (red team on #336): a series refused at m27.series_cap was only counted; nothing reached the owner.
describe('SW-42: refused metric series raise a held code', () => {
  it('under the cap no code; once a series is refused m27.series_dropped is held and logged once (fails before: counted only)', async () => {
    const r = await startRig(tempDir('sw42'), { config: { 'm27.series_cap': 100 } });
    try {
      await r.run(5_000);
      assert.equal(r.rec.parts.metrics.droppedSeries(), 0);
      assert.ok(!r.rec.status().activeCodes.includes('m27.series_dropped'));
      // More pool series than the cap (the fake chain has too few pools to reach it by watching).
      for (let i = 0; i < 120; i++) r.rec.parts.metrics.gauge('pool_snapshot_age_ms', { pool: `P${i}` }).set(1);
      await r.run(2_000);
      assert.ok(r.rec.parts.metrics.droppedSeries() > 0, `${r.rec.parts.metrics.size()} series held, none refused: the test needs the cap reached`);
      assert.ok(r.rec.status().activeCodes.includes('m27.series_dropped'), String(r.rec.status().activeCodes));
      assert.ok(STATE_CODES.has('m27.series_dropped'));
      await r.run(10_000);
      assert.equal(r.codes().filter((c) => c === 'm27.series_dropped').length, 1, 'one line, not one a tick');
    } finally {
      await r.rec.stop();
    }
  }, 120_000);
});
