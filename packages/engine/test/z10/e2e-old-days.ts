// Card Z10, ops e2e only (ruling Z10-5: the cycle seal → pull → receipt → delete on the real host): writes two sealed
// TEST days into the M07 folder with M07's own writer, at a fixed past time, so the recorder's retention rule
// (`recorder.retention_days`, 7) applies to them at once. SYNTHETIC payloads; run as the worker, with the recorder
// stopped:  node --no-warnings e2e-old-days.ts <md dir> <YYYY-MM-DD> [<YYYY-MM-DD> ...]
import type { UnixMs } from '@bot/types';
import { SegmentWriter } from '../../src/m07/segments.ts';
import { RecorderQueue } from '../../src/recorder/queue.ts';

const [dir, ...days] = process.argv.slice(2) as [string, ...string[]];
for (const day of days) {
  const at = Date.parse(`${day}T12:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(at)) throw new RangeError(`not a day: ${day}`);
  let now = at;
  const rec = SegmentWriter.recover({ dataDir: dir, nowMs: now as UnixMs, log: () => undefined });
  const q = new RecorderQueue({ firstSeq: rec.nextSeq });
  q.markProcessStart('e2e-old-days', now as UnixMs);
  const w = new SegmentWriter({ dataDir: dir, codec: 'gzip', queue: q, nowMs: () => now as UnixMs, log: () => undefined }, rec);
  for (let i = 0; i < 20; i++) {
    now = at + i * 1_000;
    q.append({ stream: 'universe_manifest', recvMs: now as UnixMs, slot: null, commitment: null, source: 'e2e', payload: { synthetic: true, day, i } });
    w.pump();
  }
  w.rotate();
  process.stdout.write(`sealed ${day}\n`);
}
