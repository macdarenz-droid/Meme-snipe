// A-M04-01 logic 8: every snapshot goes to M07 (`append`, a `pool_snapshot*` stream by class) with its `rawHash`; M07
// decides whether it changed (change-only keyframes and deltas, A-M07-01). Pure.
import type { AppendInput } from '../recorder/queue.ts';
import type { StreamName } from '../recorder/streams.ts';
import type { PoolClass, PoolModelPort, PoolSnapshot, PoolStateLike } from './types.ts';

export const STREAM_OF: Readonly<Record<PoolClass, StreamName>> = { position: 'pool_snapshot_position', candidate: 'pool_snapshot', tail: 'pool_snapshot_tail' };

export function snapshotRecord<P extends PoolStateLike>(s: PoolSnapshot<P>, cls: PoolClass, model: PoolModelPort<P>): AppendInput {
  return {
    stream: STREAM_OF[cls], recvMs: s.pool.observedAtMs, slot: s.providerSlot, commitment: 'confirmed', source: 'M04',
    payload: {
      poolId: s.pool.poolId, rawHash: s.rawHash, priorityClass: cls,
      fields: {
        ...model.recordFields(s.pool), effectiveQuoteLamports: s.effectiveQuoteLamports.toString(), spotSolPerToken: s.spotSolPerToken,
        feeTotalBps: s.feeTotalBps, providerLabel: s.providerLabel, providerSlot: s.providerSlot.toString(), readLatencyMs: s.readLatencyMs,
        observationLagSlots: s.observationLagSlots,
      },
    },
  };
}
