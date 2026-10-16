// The bar engine's replay feeder (rulings Z09-32, Z09-40, Z09-47 and Z09-48; A-M11-03 logic 1 delivers records this
// way). Pure: it takes the recorded events and returns every `bar.closed` batch with its sim time.
//
// - Records are delivered in recvMs order; at each event time and each `stepMs`, every record with recvMs ≤ t is
//   delivered before `closeDue(t)`, as live (M07 `tick(now)`, then `closeDue(now)`).
// - Restarts (Z09-40, rule (a)): the recording is split at each `process_start` marker. A record with a stream seq
//   belongs to the process whose marker's `firstSeq` for that stream is the latest at or below it (Z09-48), so neither a
//   count stamped with a later bar close nor a backward clock step across the restart misassigns it. A snapshot given
//   without a seq is split by its recvMs (the recorder gives every recorded snapshot a seq; the fallback is for inputs
//   that lost it). Before a marker the engine closes nothing past that process's close frontier, the newest recvMs of
//   its non-partial `poll_counts` (the latest bar close its last tick reached), so bars the stopped process never
//   closed are not closed in replay either. At the marker the engine is reset and starts cold, as the restarted
//   worker's engine does.
// - Z09-47/55: markers whose seqs do not separate the processes are refused (`E_MARKER_SEQ`), never guessed at. Each
//   stream's records come in seq order (as its segments are read) and must rise strictly: a seq that does not (a
//   process that restarted its seqs below the previous one's last record, e.g. from the last sealed manifest instead of
//   the recovered tail) is refused, checked on the fly with one number per stream, so memory does not grow with the
//   replay. So is a marker's `firstSeq` below an earlier marker's, or a marker without a first seq for every marked
//   stream (Z10 sets all four from `recover().nextSeq`). A record's time is not used for this, so a backward clock
//   step across a restart is not refused.
// - A recording with no marker starts cold at its first record, as before.
import type { Result, UnixMs } from '@bot/types';
import type { Bar, BarEngine, BarSnapshot, PollCountsIn } from './bars.ts';

export type ReplayEvent =
  | { kind: 'snapshot'; atMs: number; s: BarSnapshot; expectedIntervalMs: number; stream?: string; seq?: bigint }
  | { kind: 'poll_counts'; atMs: number; seq: bigint; partial: boolean; c: PollCountsIn }
  | { kind: 'process_start'; atMs: number; firstSeq: Readonly<Record<string, bigint>> };
type Recorded = Exclude<ReplayEvent, { kind: 'process_start' }>;
/** The streams every marker carries a first seq for (`recorder/queue.ts` MARKED_STREAMS). */
const MARKED = ['poll_counts', 'pool_snapshot_position', 'pool_snapshot', 'pool_snapshot_tail'] as const;
type Marker = Extract<ReplayEvent, { kind: 'process_start' }>;
export interface ReplayError { code: 'E_MARKER_SEQ'; atMs: number; stream: string }

const streamOf = (e: Recorded): string | null => (e.kind === 'poll_counts' ? 'poll_counts' : e.stream !== undefined && e.seq !== undefined ? e.stream : null);
const seqOf = (e: Recorded): bigint | null => (e.kind === 'poll_counts' ? e.seq : e.seq ?? null);

export function replayBars(engine: BarEngine, events: readonly ReplayEvent[], o: { fromMs: number; endMs: number; stepMs: number }): Result<Array<[number, Bar[]]>, ReplayError> {
  const markers = events.filter((e): e is Marker => e.kind === 'process_start').sort((a, b) => a.atMs - b.atMs);
  const recorded = events.filter((e): e is Recorded => e.kind !== 'process_start');
  // Z09-47/55: each stream's seqs rise strictly in input order (one number per stream); every marker names all four
  // marked streams; first seqs never go backwards from marker to marker.
  const last = new Map<string, bigint>();
  for (const e of recorded) {
    const st = streamOf(e), sq = seqOf(e);
    if (st === null || sq === null) continue;
    const prev = last.get(st);
    if (prev !== undefined && sq <= prev) return { ok: false, error: { code: 'E_MARKER_SEQ', atMs: e.atMs, stream: st } };
    last.set(st, sq);
  }
  for (const m of markers) {
    const missing = MARKED.find((st) => m.firstSeq[st] === undefined);
    if (missing !== undefined) return { ok: false, error: { code: 'E_MARKER_SEQ', atMs: m.atMs, stream: missing } };
  }
  for (let k = 1; k < markers.length; k++) {
    for (const [st, sq] of Object.entries((markers[k] as Marker).firstSeq)) {
      const prev = (markers[k - 1] as Marker).firstSeq[st];
      if (prev !== undefined && sq < prev) return { ok: false, error: { code: 'E_MARKER_SEQ', atMs: (markers[k] as Marker).atMs, stream: st } };
    }
  }
  const segmentOf = (e: Recorded): number => {
    const st = streamOf(e), sq = seqOf(e);
    if (st === null || sq === null) return markers.filter((m) => m.atMs <= e.atMs).length;
    let seg = 0;
    for (let k = 0; k < markers.length; k++) {
      const first = (markers[k] as Marker).firstSeq[st];
      if (first !== undefined && first <= sq) seg = k + 1;
    }
    return seg;
  };
  const segments: Recorded[][] = Array.from({ length: markers.length + 1 }, () => []);
  for (const e of recorded) (segments[segmentOf(e)] as Recorded[]).push(e);
  const out: Array<[number, Bar[]]> = [];
  for (let k = 0; k <= markers.length; k++) {
    const evs = (segments[k] as Recorded[]).sort((a, b) => a.atMs - b.atMs);
    const start = k === 0 ? o.fromMs : (markers[k - 1] as Marker).atMs;
    const final = k === markers.length;
    const end = final ? o.endMs : (markers[k] as Marker).atMs;
    let frontier = Infinity;
    if (!final) {
      frontier = -Infinity;
      for (const e of evs) if (e.kind === 'poll_counts' && !e.partial && e.atMs > frontier) frontier = e.atMs;
    }
    const times = new Set<number>();
    for (const e of evs) if (e.atMs < end) times.add(e.atMs);
    for (let t = start; t < end; t += o.stepMs) times.add(t);
    if (final) times.add(end);
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
    if (!final) engine.reset();
  }
  return { ok: true, value: out };
}
