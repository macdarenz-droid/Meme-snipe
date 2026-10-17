// Card SWITCH-FIX-2 SW-30 (RT2-f), checked by `pnpm typecheck`: a segment writer's queue must give back the records it
// took but never wrote (SW-10). On 3439ee02 `unwrite` was optional, so a queue without it lost them silently.
import type { SegmentWriterDeps } from '../../src/m07/segments.ts';

type Queue = SegmentWriterDeps['queue'];
// @ts-expect-error a queue without unwrite is not a writer's queue
export const noUnwrite: Queue = { take: () => [], drainGaps: () => ({}) };
export const withUnwrite: Queue = { take: () => [], drainGaps: () => ({}), unwrite: () => undefined };
