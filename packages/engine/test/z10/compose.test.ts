// Card Z10: the recorder's composition root on the fake chain (SYNTHETIC evolution of real mainnet fixture accounts).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { tempDir } from '../helpers.ts';
import { startRig } from './rig.ts';

describe('Z10 composition root', () => {
  it('starts: anchors on two providers, writes the process_start marker, then records the discovered pools', async () => {
    const r = await startRig(tempDir('z10-start'));
    try {
      assert.equal(r.rec.status().anchored, false);
      await r.run(10_000);
      const s = r.rec.status();
      assert.equal(s.anchored, true, 'two providers agreed');
      assert.deepEqual(s.anchor?.providers, ['chainstack', 'shyft']);
      assert.ok(r.codes().includes('recorder.started'));
      assert.ok(!r.codes().includes('m27.unknown_code'), r.lines.filter((l) => l.includes('unknown_code')).join('\n'));
      // The real migrations become visible; the backfill verifies them. PM-01 waits until migration + 20 min (Z09-43),
      // so the two pools (migrated 17:23 and 17:25 UTC) are watched from about 17:45.
      r.chain.migrationsVisible = 3;
      await r.run(30 * 60_000);
      const states = (r.rec.parts.db.reader().all("SELECT * FROM candidate") as Array<Record<string, unknown>>).map((c) => JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      const st = r.rec.status();
      assert.ok(st.watched >= 1, `watched ${st.watched}; ${states.join(',')}`);
    } finally {
      await r.rec.stop();
    }
  }, 120_000);
});
