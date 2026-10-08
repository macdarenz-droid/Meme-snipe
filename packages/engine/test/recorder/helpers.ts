// Test helpers for the M07 recorder queue.
import type { UnixMs } from '@bot/types';
import type { AppendInput, EncodedRecord, PoolSnapshotPayload, StreamName } from '../../src/index.ts';

// 2026-10-01T10:00:00Z, on an hour boundary.
export const T0 = 1_790_848_800_000 as UnixMs;

export function snap(poolId: string, state: number, recvMs: number, stream: StreamName = 'pool_snapshot', priorityClass = 'normal'): AppendInput {
  const payload: PoolSnapshotPayload = {
    poolId,
    rawHash: `h${state}`,
    priorityClass,
    fields: { baseReserve: `${1_000_000 + state}`, quoteReserve: `${2_000_000 - state}`, lpSupply: '500', slotSeen: `${state}` },
  };
  return { stream, recvMs: recvMs as UnixMs, slot: BigInt(state), commitment: 'confirmed', source: 'test', payload };
}

export function rec(stream: StreamName, recvMs: number, payload: unknown = { n: recvMs }): AppendInput {
  return { stream, recvMs: recvMs as UnixMs, slot: null, commitment: null, source: 'test', payload };
}

export function payloadOf(r: EncodedRecord): Record<string, unknown> {
  return JSON.parse(r.payloadJson) as Record<string, unknown>;
}
export const SEG = '2026-10-01T10';
