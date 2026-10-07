// M07 stream catalogue (A-M07-01, SPEC-A "Interfaces"). The order is the drop priority under backpressure: the first
// entry is dropped last, the last first. The first five are never dropped (A-M07-01 logic 4).

export const STREAM_NAMES = [
  'order_event',
  'fill',
  'universe_manifest',
  'coverage',
  'venue_config',
  'pool_snapshot_position',
  'decision',
  'signal',
  'screen',
  'pool_snapshot',
  'poll_counts',
  'discovery',
  'pumpportal_notice',
  'pool_snapshot_tail',
] as const;

export type StreamName = (typeof STREAM_NAMES)[number];

/** Streams that are never dropped, whatever the queue holds. */
export const PROTECTED_STREAMS: ReadonlySet<StreamName> = new Set<StreamName>(['order_event', 'fill', 'universe_manifest', 'coverage', 'venue_config']);

/** Pool-snapshot streams: change-only, written as keyframes and deltas (A-M07-01 logic 2). M04 picks the stream by priority class. */
export const SNAPSHOT_STREAMS: ReadonlySet<StreamName> = new Set<StreamName>(['pool_snapshot_position', 'pool_snapshot', 'pool_snapshot_tail']);

const RANK = new Map<string, number>(STREAM_NAMES.map((s, i) => [s, i]));

export function isStreamName(s: unknown): s is StreamName {
  return typeof s === 'string' && RANK.has(s);
}

/** 0 for the stream dropped last; higher numbers are dropped first. */
export function dropRank(s: StreamName): number {
  return RANK.get(s) as number;
}
