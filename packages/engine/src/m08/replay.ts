// The bar engine's replay feeder (rulings Z09-32 and Z09-40; A-M11-03 logic 1 delivers records this way). Pure: it
// takes the recorded events and returns every `bar.closed` batch with its sim time.
//
// - Records are delivered in recvMs order; at each event time and each `stepMs`, every record with recvMs ≤ t is
//   delivered before `closeDue(t)`, as live (M07 `tick(now)`, then `closeDue(now)`).
// - Restarts (Z09-40, rule (a)): the recording is split at each `process_start` marker. A process's records are the
//   snapshots received before the next marker and the `poll_counts` with a seq below the next marker's
//   `pollCountsFirstSeq` (a record stamped with a later bar close can still be one of them). Before a marker the
//   engine closes nothing past that process's close frontier: the newest recvMs of its non-partial `poll_counts`,
//   which is the latest bar close its last tick reached, so bars the stopped process never closed are not closed in
//   replay either. At the marker the engine is reset and starts cold, as the restarted worker's engine does.
// - A recording with no marker starts cold at its first record, as before.
import type { UnixMs } from '@bot/types';
import type { Bar, BarEngine, BarSnapshot, PollCountsIn } from './bars.ts';

export type ReplayEvent =
  | { kind: 'snapshot'; atMs: number; s: BarSnapshot; expectedIntervalMs: number }
  | { kind: 'poll_counts'; atMs: number; seq: bigint; partial: boolean; c: PollCountsIn }
  | { kind: 'process_start'; atMs: number; pollCountsFirstSeq: bigint };

type Recorded = Exclude<ReplayEvent, { kind: 'process_start' }>;

export function replayBars(engine: BarEngine, events: readonly ReplayEvent[], o: { fromMs: number; endMs: number; stepMs: number }): Array<[number, Bar[]]> {
  const markers = events.filter((e): e is Extract<ReplayEvent, { kind: 'process_start' }> => e.kind === 'process_start').sort((a, b) => a.atMs - b.atMs);
  const out: Array<[number, Bar[]]> = [];
  const segmentOf = (e: Recorded): number => {
    if (e.kind === 'poll_counts') return markers.filter((m) => m.pollCountsFirstSeq <= e.seq).length;
    return markers.filter((m) => m.atMs <= e.atMs).length;
  };
  const segments: Recorded[][] = Array.from({ length: markers.length + 1 }, () => []);
  for (const e of events) if (e.kind !== 'process_start') (segments[segmentOf(e)] as Recorded[]).push(e);
  for (let k = 0; k <= markers.length; k++) {
    const evs = (segments[k] as Recorded[]).sort((a, b) => a.atMs - b.atMs);
    const start = k === 0 ? o.fromMs : (markers[k - 1] as { atMs: number }).atMs;
    const last = k === markers.length;
    const end = last ? o.endMs : (markers[k] as { atMs: number }).atMs;
    let frontier = Infinity;
    if (!last) {
      frontier = -Infinity;
      for (const e of evs) if (e.kind === 'poll_counts' && !e.partial && e.atMs > frontier) frontier = e.atMs;
    }
    const times = new Set<number>();
    for (const e of evs) if (e.atMs < end) times.add(e.atMs);
    for (let t = start; t < end; t += o.stepMs) times.add(t);
    if (last) times.add(end);
    let i = 0;
    const deliver = (e: Recorded): void => {
      if (e.kind === 'snapshot') engine.onSnapshot(e.s, e.expectedIntervalMs);
      else engine.onPollCounts(e.c);
    };
    for (const t of [...times].sort((a, b) => a - b)) {
      for (; i < evs.length && (evs[i] as Recorded).atMs <= t; i++) deliver(evs[i] as Recorded);
      const bars = engine.closeDue(Math.min(t, frontier) as UnixMs);
      if (bars.length > 0) out.push([t, bars]);
    }
    // A stopped process's records stamped after its stop (a partial bar's close) reach the engine but never close a bar.
    for (; i < evs.length; i++) deliver(evs[i] as Recorded);
    if (!last) engine.reset();
  }
  return out;
}
