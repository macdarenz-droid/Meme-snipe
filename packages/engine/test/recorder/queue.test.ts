// A-M07-01 logic, edge cases and security notes, beyond the two acceptance criteria.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { canonicalJson, type UnixMs } from '@bot/types';
import {
  DEFAULT_CONFIG, DeltaDecodeError, RECORD_OVERHEAD_BYTES, RecorderError, RecorderQueue, SnapshotDecoder, SnapshotEncoder, recordLine,
  type EncodedSnapshot, type LogLevel, type PoolSnapshotPayload,
} from '../../src/index.ts';
import { SEG, T0, payloadOf, rec, snap } from './helpers.ts';

const ms = (n: number): UnixMs => n as UnixMs;

describe('append validation (logic 1, logic 5, edge case 1)', () => {
  it('rejects unknown streams, bad envelope fields, unserialisable and oversized payloads, and counts them', () => {
    const logs: Array<[LogLevel, string]> = [];
    const q = new RecorderQueue({ log: (l, c) => logs.push([l, c]) });
    assert.deepEqual(q.append({ ...rec('decision', T0), stream: 'nope' }), { rejected: 'E_STREAM' });
    assert.deepEqual(q.append({ ...rec('decision', T0), recvMs: ms(Number.NaN) }), { rejected: 'E_ENVELOPE' });
    assert.deepEqual(q.append({ ...rec('decision', T0), slot: -1n as never }), { rejected: 'E_ENVELOPE' });
    assert.deepEqual(q.append({ ...rec('decision', T0), commitment: 'final' as never }), { rejected: 'E_ENVELOPE' });
    assert.deepEqual(q.append(rec('decision', T0, new Map())), { rejected: 'E_PAYLOAD' });
    assert.deepEqual(q.append(rec('decision', T0, { x: Number.POSITIVE_INFINITY })), { rejected: 'E_PAYLOAD' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.deepEqual(q.append(rec('decision', T0, cyclic)), { rejected: 'E_PAYLOAD' });
    assert.deepEqual(q.append(rec('pool_snapshot', T0, { poolId: 'p', rawHash: '', priorityClass: 'n', fields: {} })), { rejected: 'E_PAYLOAD' });
    assert.deepEqual(q.append(rec('decision', T0, { s: 'y'.repeat(DEFAULT_CONFIG.recordMaxBytes) })), { rejected: 'E_TOO_LARGE' });
    // Just under the cap is accepted: {"s":"..."} is 8 bytes of framing.
    assert.equal(q.append(rec('decision', T0, { s: 'y'.repeat(DEFAULT_CONFIG.recordMaxBytes - 8) })), 'queued');
    const st = q.stats();
    assert.deepEqual(st.rejectedTotal, { E_STREAM: 1, E_ENVELOPE: 3, E_PAYLOAD: 4, E_TOO_LARGE: 1, E_POOL_CAP: 0 });
    assert.equal(st.queueDepth, 1);
    // One log line per stream and code, not one per bad record.
    assert.equal(logs.filter(([, c]) => c === 'M07.rejected').length, 5);
  });

  it('writes bigints as decimal strings and keeps the payload as it was when appended', () => {
    const q = new RecorderQueue();
    const payload = { amount: 18_446_744_073_709_551_615n, list: [1, 2] };
    q.append({ stream: 'fill', recvMs: ms(T0), slot: 7n as never, commitment: 'finalized', source: 'M19', payload });
    payload.list.push(3);
    const [r] = q.take(1, SEG);
    assert.equal(r!.payloadJson, '{"amount":"18446744073709551615","list":[1,2]}');
    // The line is canonical JSON of the whole envelope.
    const line = recordLine(r!);
    assert.equal(line, canonicalJson({ ...JSON.parse(line) as object }));
    assert.deepEqual(JSON.parse(line), { commitment: 'finalized', payload: { amount: '18446744073709551615', list: [1, 2] }, recvMs: T0, seq: '0', slot: '7', source: 'M19', stream: 'fill' });
  });

  it('checks its config against the ticket range', () => {
    assert.throws(() => new RecorderQueue({ config: { queueMax: 999 } }), RecorderError);
    assert.throws(() => new RecorderQueue({ config: { queueMax: 500_001 } }), RecorderError);
    assert.throws(() => new RecorderQueue({ config: { queueMax: 1_500.5 } }), RecorderError);
    assert.throws(() => new RecorderQueue({ config: { queueMaxBytes: 1_000 } }), RecorderError);
    assert.throws(() => new RecorderQueue({ firstSeq: { fill: -1n } }), RecorderError);
    assert.ok(new RecorderQueue({ config: { queueMax: 1_000 } }));
    assert.ok(new RecorderQueue({ config: { queueMax: 500_000 } }));
  });
});

describe('redaction (security notes)', () => {
  it('replaces key-shaped URL strings in the source and anywhere in the payload', () => {
    const q = new RecorderQueue();
    q.append({ stream: 'discovery', recvMs: ms(T0), slot: null, commitment: null, source: 'https://rpc.example/?api-key=abc', payload: { url: 'wss://x.example/ws?token=s3cret', nested: [{ 'https://y/?a=1&key=zz': 1 }], ok: 'https://z.example/?page=2' } });
    const [r] = q.take(1, SEG);
    assert.equal(r!.source, '[redacted]');
    assert.ok(!r!.payloadJson.includes('abc') && !r!.payloadJson.includes('s3cret') && !r!.payloadJson.includes('zz'));
    // Numbered within the record, and the payload is canonical JSON again (keys sorted).
    assert.deepEqual(JSON.parse(r!.payloadJson), { nested: [{ '[redacted:1]': 1 }], ok: 'https://z.example/?page=2', url: '[redacted:2]' });
    assert.equal(r!.payloadJson, canonicalJson(JSON.parse(r!.payloadJson)));
    assert.equal(q.stats().redactedTotal, 3);
  });

  it('refuses a payload that already has a "[redacted:" key, or whose redaction would merge two keys (ruling 13)', () => {
    const q = new RecorderQueue();
    assert.deepEqual(q.append(rec('discovery', T0, { '[redacted:1]': 1, u: 'https://a.example/?key=1' })), { rejected: 'E_PAYLOAD' });
    assert.deepEqual(q.append(rec('discovery', T0, { m: { '[redacted:9]': 1 } })), { rejected: 'E_PAYLOAD' });
    // A value that looks like the marker is a value, not a key: accepted.
    assert.equal(q.append(rec('discovery', T0, { m: '[redacted:1]' })), 'queued');
    assert.equal(q.stats().rejectedTotal.E_PAYLOAD, 2);
  });

  it('two redacted keys of one object stay two keys', () => {
    const q = new RecorderQueue();
    q.append(rec('discovery', T0, { m: { 'https://a.example/?key=1': 1, 'https://b.example/?token=2': 2 } }));
    const [r] = q.take(1, SEG);
    assert.deepEqual(JSON.parse(r!.payloadJson), { m: { '[redacted:1]': 1, '[redacted:2]': 2 } });
  });
});

describe('seq (logic 1)', () => {
  it('is per stream, dense over written records, and continues from the last manifest after a restart', () => {
    const q = new RecorderQueue({ firstSeq: { decision: 41n } });
    q.append(rec('decision', T0));
    q.append(rec('signal', T0 + 1));
    q.append(rec('decision', T0 + 2));
    assert.deepEqual(q.take(10, SEG).map((r) => [r.stream, r.seq]), [['decision', 41n], ['signal', 0n], ['decision', 42n]]);
    assert.equal(q.peekNextSeq('decision'), 43n);
  });

  it('keeps append order across streams, and a clock step back changes recvMs only', () => {
    const q = new RecorderQueue();
    q.append(rec('decision', T0 + 5_000));
    q.append(rec('order_event', T0 + 1_000));
    q.append(rec('decision', T0));
    const out = q.take(10, SEG);
    assert.deepEqual(out.map((r) => [r.stream, r.seq, r.recvMs]), [['decision', 0n, T0 + 5_000], ['order_event', 0n, T0 + 1_000], ['decision', 1n, T0]]);
  });
});

describe('change-only snapshots (logic 2, edge case 3)', () => {
  it('starts a new keyframe for each pool when the segment changes, and after a restart', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0));
    q.append(snap('a', 2, T0 + 10_000));
    assert.deepEqual(q.take(10, 'seg-10').map((r) => payloadOf(r).kind), ['keyframe', 'delta']);
    q.append(snap('a', 3, T0 + 20_000));
    q.append(snap('a', 4, T0 + 30_000));
    assert.deepEqual(q.take(10, 'seg-11').map((r) => payloadOf(r).kind), ['keyframe', 'delta']);
    // A new process (restart): the first change of each pool is a keyframe.
    const r = new RecorderQueue();
    r.append(snap('a', 4, T0 + 3_601_000));
    r.append(snap('a', 5, T0 + 3_602_000));
    assert.deepEqual(r.take(10, 'seg-11').map((x) => payloadOf(x).kind), ['keyframe', 'delta']);
  });

  it('a record from 10:59:59.9 taken into the 11:00 segment is a keyframe (the segment decides, not recvMs)', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 3_599_000));
    assert.deepEqual(q.take(10, 'seg-10').map((r) => payloadOf(r).kind), ['keyframe']);
    q.append(snap('a', 2, T0 + 3_599_900));
    const [r] = q.take(10, 'seg-11');
    assert.equal(payloadOf(r!).kind, 'keyframe');
    assert.equal(r!.recvMs, T0 + 3_599_900);
  });

  it('a rotate inside one batch: records queued together, taken into two segments, each segment starts with keyframes', () => {
    const q = new RecorderQueue();
    for (let i = 0; i < 6; i++) {
      q.append(snap('a', i, T0 + i * 1_000));
      q.append(snap('b', i, T0 + i * 1_000 + 1));
    }
    const first = q.take(5, 'seg-10');
    const second = q.take(100, 'seg-11');
    const kinds = (rs: typeof first): string[] => rs.map((r) => `${String(payloadOf(r).poolId)}:${String(payloadOf(r).kind)}`);
    assert.deepEqual(kinds(first), ['a:keyframe', 'b:keyframe', 'a:delta', 'b:delta', 'a:delta']);
    assert.deepEqual(kinds(second), ['b:keyframe', 'a:keyframe', 'b:delta', 'a:delta', 'b:delta', 'a:delta', 'b:delta']);
    // Each segment decodes on its own.
    for (const seg of [first, second]) {
      const d = new SnapshotDecoder();
      for (const r of seg) d.apply(payloadOf(r) as unknown as EncodedSnapshot);
    }
  });

  it('a stream or priority class change with the same rawHash is a change', () => {
    const q = new RecorderQueue();
    assert.equal(q.append(snap('a', 1, T0, 'pool_snapshot', 'normal')), 'queued');
    assert.equal(q.append(snap('a', 1, T0 + 1, 'pool_snapshot', 'normal')), 'unchanged');
    assert.equal(q.append(snap('a', 1, T0 + 2, 'pool_snapshot', 'tail')), 'queued');
    assert.equal(q.append(snap('a', 1, T0 + 3, 'pool_snapshot_position', 'position')), 'queued');
    const out = q.take(10, SEG);
    assert.deepEqual(out.map((r) => [r.stream, payloadOf(r).kind, payloadOf(r).priorityClass]), [
      ['pool_snapshot', 'keyframe', 'normal'], ['pool_snapshot', 'delta', 'tail'], ['pool_snapshot_position', 'keyframe', 'position'],
    ]);
  });

  it('changedPolls counts a change of rawHash only, not of stream or class (ruling 15)', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0, 'pool_snapshot', 'normal'));
    q.append(snap('a', 1, T0 + 1_000, 'pool_snapshot', 'tail'));
    q.append(snap('a', 1, T0 + 2_000, 'pool_snapshot_tail', 'tail'));
    q.append(snap('a', 2, T0 + 3_000, 'pool_snapshot_tail', 'tail'));
    q.tick(ms(T0 + 60_000));
    const [c] = q.take(100, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf);
    assert.equal(c!.successfulPolls, 4);
    // The first poll of a watch has no previous hash, so it is not a change (ruling 18): only h1 → h2 is.
    assert.equal(c!.changedPolls, 1);
  });

  it('the encoder writes a record when only the stream or the class changed, and nothing when all three match (ruling 16)', () => {
    const e = new SnapshotEncoder();
    const p = (cls: string): PoolSnapshotPayload => ({ poolId: 'a', rawHash: 'h1', priorityClass: cls, fields: { x: '1' } });
    assert.equal(e.encode('pool_snapshot', SEG, p('normal'))?.kind, 'keyframe');
    assert.equal(e.encode('pool_snapshot', SEG, p('normal')), null);
    assert.deepEqual(e.encode('pool_snapshot', SEG, p('tail')), { kind: 'delta', poolId: 'a', rawHash: 'h1', priorityClass: 'tail', set: Object.create(null) as Record<string, unknown>, unset: [] });
    assert.equal(e.encode('pool_snapshot_tail', SEG, p('tail'))?.kind, 'keyframe');
    assert.equal(e.encode('pool_snapshot_tail', SEG, p('tail')), null);
  });

  it('refuses a snapshot with a top-level key outside the four', () => {
    const q = new RecorderQueue();
    const p = { ...(snap('a', 1, T0).payload as object), extra: 1 };
    assert.deepEqual(q.append(rec('pool_snapshot', T0, p)), { rejected: 'E_PAYLOAD' });
    assert.equal(q.stats().rejectedTotal.E_PAYLOAD, 1);
  });

  it('keeps a separate chain per stream, so each stream decodes alone', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0, 'pool_snapshot'));
    q.append(snap('a', 2, T0 + 1, 'pool_snapshot_position', 'position'));
    q.append(snap('a', 3, T0 + 2, 'pool_snapshot'));
    const out = q.take(10, SEG);
    assert.deepEqual(out.map((r) => [r.stream, payloadOf(r).kind]), [['pool_snapshot', 'keyframe'], ['pool_snapshot_position', 'keyframe'], ['pool_snapshot', 'delta']]);
    const d = new SnapshotDecoder();
    d.apply(payloadOf(out[0]!) as unknown as EncodedSnapshot);
    assert.equal(canonicalJson(d.apply(payloadOf(out[2]!) as unknown as EncodedSnapshot)), canonicalJson(snap('a', 3, 0).payload));
  });

  it('a delta holds only changed fields, removals and a changed priority class', () => {
    const q = new RecorderQueue();
    const base = { poolId: 'a', priorityClass: 'normal' };
    q.append(rec('pool_snapshot', T0, { ...base, rawHash: 'h1', fields: { x: '1', y: '2', z: '3' } }));
    q.append(rec('pool_snapshot', T0 + 1, { ...base, priorityClass: 'tail', rawHash: 'h2', fields: { x: '1', y: '5', w: '9' } }));
    const [, d] = q.take(10, SEG);
    assert.deepEqual(payloadOf(d!), { kind: 'delta', poolId: 'a', rawHash: 'h2', priorityClass: 'tail', set: { w: '9', y: '5' }, unset: ['z'] });
  });

  it('a snapshot dropped in the queue does not hide the same state polled again, nor break the chain', () => {
    const q = new RecorderQueue({ config: { queueMax: 1_000 } });
    q.append(snap('a', 1, T0, 'pool_snapshot_tail'));
    q.take(10, SEG);
    q.append(snap('a', 2, T0 + 1, 'pool_snapshot_tail'));
    // Fill the queue with higher-priority records; the tail snapshot of state 2 is the one dropped.
    for (let i = 0; i < 1_000; i++) q.append(rec('decision', T0 + 2 + i));
    assert.equal(q.stats().droppedTotal.pool_snapshot_tail, 1);
    q.take(1_000, SEG);
    // State 2 polled again: it was never written, so it is a change and is written as a delta against state 1.
    assert.equal(q.append(snap('a', 2, T0 + 5_000, 'pool_snapshot_tail')), 'queued');
    const [r] = q.take(10, SEG);
    const d = new SnapshotDecoder();
    d.apply({ kind: 'keyframe', ...(snap('a', 1, 0).payload as object) } as EncodedSnapshot);
    assert.equal(canonicalJson(d.apply(payloadOf(r!) as unknown as EncodedSnapshot)), canonicalJson(snap('a', 2, 0).payload));
  });

  it('a decoder refuses a delta with no keyframe before it', () => {
    assert.throws(() => new SnapshotDecoder().apply({ kind: 'delta', poolId: 'a', rawHash: 'h', set: {}, unset: [] }), DeltaDecodeError);
  });
});

describe('poll counts (logic 3)', () => {
  it('writes one record per watched pool per minute, with zero minutes, failed polls and late polls', () => {
    const q = new RecorderQueue();
    q.watch('quiet', 'normal', ms(T0));
    q.append(snap('busy', 1, T0 + 1_000));
    q.append(snap('busy', 1, T0 + 2_000));
    q.notePollFailed('busy', 'normal', ms(T0 + 3_000), false);
    q.tick(ms(T0 + 60_000));
    // A poll stamped in the minute already written is counted in the next one.
    q.append(snap('busy', 2, T0 + 59_000));
    q.append(rec('decision', T0 + 180_400));
    q.tick(ms(T0 + 180_500));
    const counts = q.take(100, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf);
    const by = (pool: string): unknown[] => counts.filter((p) => p.poolId === pool).map((p) => [p.minuteStartMs, p.successfulPolls, p.changedPolls, p.failedPolls]);
    assert.deepEqual(by('quiet'), [[T0, 0, 0, 0], [T0 + 60_000, 0, 0, 0], [T0 + 120_000, 0, 0, 0]]);
    // The first poll of a watch is not a change (ruling 18).
    assert.deepEqual(by('busy'), [[T0, 2, 0, 1], [T0 + 60_000, 1, 1, 0], [T0 + 120_000, 0, 0, 0]]);
    assert.equal(q.stats().latePolls, 1);
  });

  it('unwatch writes the last partial minute and forgets the pool', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 1_000));
    q.unwatch('a', ms(T0 + 30_000));
    q.tick(ms(T0 + 600_000));
    const counts = q.take(100, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf);
    assert.deepEqual(counts.map((p) => [p.minuteStartMs, p.successfulPolls]), [[T0, 1]]);
    assert.equal(q.stats().watchedPools, 0);
    assert.equal(q.stats().acceptedHashes, 0);
  });

  it('a silent feed (an outage) longer than pollCatchUpMaxMinutes resumes as one skippedMinutes record per pool', () => {
    const q = new RecorderQueue();
    q.append(snap('a', 1, T0 + 5_000));
    q.append(snap('a', 2, T0 + 125_000));
    // The writer ticks every minute; the feed is silent from minute 3 to minute 30.
    for (let m = 0; m < 30; m++) q.tick(ms(T0 + m * 60_000 + 500));
    let counts = q.take(10_000, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf);
    // Minutes 0-2 one by one; nothing past the newest received minute + 1 while the feed is silent (ruling 25).
    assert.deepEqual(counts.map((c) => [c.minuteStartMs, c.successfulPolls, c.skippedMinutes]), [[T0, 1, undefined], [T0 + 60_000, 0, undefined], [T0 + 120_000, 1, undefined]]);
    assert.equal(q.stats().outages, 1, 'named an outage, not a clock step (ruling 29)');
    assert.equal(q.stats().clockSteps, 0);
    // The feed resumes at minute 30: the silent minutes 3-29 arrive as one record.
    q.append(snap('a', 3, T0 + 30 * 60_000 + 1));
    q.tick(ms(T0 + 30 * 60_000 + 500));
    counts = q.take(10_000, SEG).filter((r) => r.stream === 'poll_counts').map(payloadOf);
    assert.deepEqual(counts, [{ poolId: 'a', minuteStartMs: T0 + 180_000, successfulPolls: 0, changedPolls: 0, failedPolls: 0, priorityClass: 'normal', skippedMinutes: 27 }]);
    assert.equal(q.stats().skippedPollMinutes, 27);
    // Then minute by minute again.
    for (let m = 31; m <= 33; m++) {
      q.append(snap('a', 3, T0 + m * 60_000 + 1));
      q.tick(ms(T0 + m * 60_000 + 500));
    }
    assert.equal(q.take(100, SEG).filter((r) => r.stream === 'poll_counts').length, 3);
  });
});

describe('backpressure (logic 4, failure modes)', () => {
  it('drops the lowest-priority stream first, newest first, and opens one gap per overload with one warning', () => {
    const logs: Array<[LogLevel, string, Record<string, string | number>]> = [];
    const q = new RecorderQueue({ config: { queueMax: 1_000 }, log: (l, c, f) => logs.push([l, c, f]) });
    for (let i = 0; i < 1_000; i++) q.append(rec(i < 500 ? 'discovery' : 'screen', T0 + i));
    // Full. A signal pushes out the newest discovery; another discovery is itself dropped (discovery is lowest).
    assert.equal(q.append(rec('signal', T0 + 2_000)), 'queued');
    assert.equal(q.append(rec('discovery', T0 + 2_001)), 'dropped');
    // A screen record pushes out discovery, not screen.
    assert.equal(q.append(rec('screen', T0 + 2_002)), 'queued');
    const st = q.stats();
    assert.equal(st.droppedTotal.discovery, 3);
    assert.equal(st.droppedTotal.screen, 0);
    assert.deepEqual(q.drainGaps(), { discovery: [{ fromMs: T0 + 498, toMs: T0 + 2_001, reason: 'backpressure' }] });
    assert.deepEqual(logs.filter(([, c]) => c === 'M07.backpressure').map(([l, , f]) => [l, f.stream]), [['warning', 'discovery']]);
    // The kept discovery records are the oldest 498, in order.
    const kept = q.take(2_000, SEG).filter((r) => r.stream === 'discovery').map((r) => r.recvMs);
    assert.deepEqual(kept, Array.from({ length: 498 }, (_, i) => T0 + i));
  });

  it('closes a gap when the stream is accepted again, and counts gap seconds', () => {
    const q = new RecorderQueue({ config: { queueMax: 1_000, gapMergeMs: 0 } });
    for (let i = 0; i < 1_000; i++) q.append(rec('decision', T0 + i));
    q.append(rec('discovery', T0 + 10_000));
    q.append(rec('discovery', T0 + 13_000));
    q.take(10, SEG);
    q.append(rec('discovery', T0 + 20_000));
    const st = q.stats();
    assert.equal(st.gapSecondsTotal.discovery, 3);
    assert.deepEqual(q.drainGaps(), { discovery: [{ fromMs: T0 + 10_000, toMs: T0 + 13_000, reason: 'backpressure' }] });
    assert.deepEqual(q.drainGaps(), {});
  });

  it('never drops a never-dropped record: it refuses one loudly when nothing else is left to drop', () => {
    const logs: string[] = [];
    const q = new RecorderQueue({ config: { queueMax: 1_000 }, log: (l, c) => logs.push(`${l}:${c}`) });
    for (let i = 0; i < 999; i++) q.append(rec(i % 2 === 0 ? 'order_event' : 'fill', T0 + i));
    q.append(rec('pool_snapshot_tail', T0 + 999, { poolId: 'p', rawHash: 'h', priorityClass: 'tail', fields: {} }));
    // The tail snapshot makes way for a fill.
    assert.equal(q.append(rec('fill', T0 + 1_000)), 'queued');
    assert.equal(q.stats().droppedTotal.pool_snapshot_tail, 1);
    assert.throws(() => q.append(rec('order_event', T0 + 1_001)), (e: unknown) => e instanceof RecorderError && e.code === 'E_QUEUE_FULL');
    assert.ok(logs.includes('critical:M07.queue_full'));
    // A droppable record is simply dropped.
    assert.equal(q.append(rec('decision', T0 + 1_002)), 'dropped');
    assert.equal(q.stats().queueDepth, 1_000);
  });

  it('bounds the bytes held as well as the count', () => {
    const queueMaxBytes = 4 * 1_048_576;
    const q = new RecorderQueue({ config: { queueMaxBytes } });
    const big = 'b'.repeat(60_000);
    for (let i = 0; i < 1_000; i++) q.append(rec('discovery', T0 + i, { big }));
    const st = q.stats();
    assert.ok(st.peakBytes <= queueMaxBytes, `peak bytes ${st.peakBytes}`);
    assert.equal(st.queueDepth, Math.floor(queueMaxBytes / (60_000 + 10 + RECORD_OVERHEAD_BYTES)));
    assert.equal(st.queueDepth + st.droppedTotal.discovery, 1_000);
  });

  it('keeps at most GAPS_MAX_PER_STREAM closed gaps per stream by widening the oldest', () => {
    const q = new RecorderQueue({ config: { queueMax: 1_000, gapMergeMs: 0 } });
    for (let i = 0; i < 1_000; i++) q.append(rec('decision', T0));
    for (let g = 0; g < 3_000; g++) {
      q.append(rec('discovery', T0 + g * 10));
      q.take(1, SEG);
      q.append(rec('discovery', T0 + g * 10 + 5));
      q.append(rec('decision', T0));
    }
    const gaps = q.drainGaps().discovery ?? [];
    assert.ok(gaps.length <= 1_025, `${gaps.length} gaps`);
    assert.equal(gaps[0]!.fromMs, T0);
  });
});
