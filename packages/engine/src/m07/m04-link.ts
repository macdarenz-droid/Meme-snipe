// The M04 → M07 recorder integration (card Z08; Z04 review rulings 1 and 14, docs/MIGRATION.md Z08 row). M04 calls
// `Recorder.unwatch` for every pool it stops watching (evicted, closed or quarantined: `TrackerOutputs.unwatched`), so
// the recorder's per-minute poll counts stop for it; every watch and unwatch also goes to the watch log, which is the
// coverage report's denominator (never poll_counts). Snapshots go to the recorder by class (A-M04-01 logic 8).
import type { Pubkey, UnixMs } from '@bot/types';
import { snapshotRecord } from '../m04/record.ts';
import type { PoolTracker } from '../m04/tracker.ts';
import type { PoolClass, PoolModelPort, PoolSnapshot, PoolStateLike, TrackerOutputs } from '../m04/types.ts';
import type { AppendInput, AppendResult } from '../recorder/queue.ts';

export interface RecorderSide {
  append(e: AppendInput): AppendResult;
  watch(poolId: string, priorityClass: string, nowMs: UnixMs): boolean;
  unwatch(poolId: string, nowMs: UnixMs): void;
}
export interface WatchHistory { watch(poolId: string, c: PoolClass, atMs: UnixMs): void; unwatch(poolId: string, atMs: UnixMs): void }

/**
 * The recorder-facing part of M04's outputs (`snapshot`, `unwatched`), and `watch` to call instead of the tracker's
 * own so a watch the tracker accepts is also recorded. The composition root (Z10) merges these outputs with M04's
 * other outputs (bus topics, M01, M14).
 */
export function linkTrackerToRecorder<P extends PoolStateLike>(o: {
  recorder: RecorderSide; history: WatchHistory; model: PoolModelPort<P>; nowMs: () => UnixMs;
}): {
  outputs: Pick<TrackerOutputs<P>, 'snapshot' | 'unwatched'>;
  watch(tracker: Pick<PoolTracker<P>, 'watch'>, poolId: Pubkey, cls: PoolClass): boolean;
} {
  return {
    outputs: {
      snapshot(s: PoolSnapshot<P>, cls: PoolClass): void { o.recorder.append(snapshotRecord(s, cls, o.model)); },
      unwatched(poolId: Pubkey): void {
        const now = o.nowMs();
        o.recorder.unwatch(poolId, now);
        o.history.unwatch(poolId, now);
      },
    },
    watch(tracker, poolId, cls): boolean {
      if (!tracker.watch(poolId, cls)) return false;                    // refused by M04's class cap: not watched anywhere
      const now = o.nowMs();
      o.recorder.watch(poolId, cls, now);
      o.history.watch(poolId, cls, now);
      return true;
    },
  };
}
