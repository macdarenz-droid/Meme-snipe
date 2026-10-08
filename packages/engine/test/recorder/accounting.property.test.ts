// Rulings 25, 26 and 30 (docs/reviews/Z04.md): every counted poll ends in exactly one (pool, minute) poll_counts
// record, and every pool-minute whose count differs from the polls stamped in it is explained by a gap on poll_counts
// (clock_step or late) or by a skippedMinutes record. Random polls, failed polls, unwatches, ticks, forward and
// backward clock steps, forward recvMs on any stream, and rejected records. Fixed seed so a run is reproducible for
// the exact commit it ran on.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { UnixMs } from '@bot/types';
import { MINUTE_MS, RecorderQueue, type EncodedRecord, type Gap } from '../../src/index.ts';
import { SEG, T0, payloadOf, snap } from './helpers.ts';

const ms = (n: number): UnixMs => n as UnixMs;
const params = { seed: 20261008, numRuns: 300 };

const op = fc.oneof(
  fc.record({ kind: fc.constant('poll' as const), pool: fc.integer({ min: 0, max: 4 }), state: fc.integer({ min: 0, max: 2 }), back: fc.integer({ min: 0, max: 90_000 }), position: fc.boolean() }),
  fc.record({ kind: fc.constant('fail' as const), pool: fc.integer({ min: 0, max: 4 }), position: fc.boolean() }),
  fc.record({ kind: fc.constant('unwatch' as const), pool: fc.integer({ min: 0, max: 4 }), ahead: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 86_400_000 })) }),
  fc.record({ kind: fc.constant('tick' as const), ahead: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 7_200_000 })) }),
  fc.record({ kind: fc.constant('advance' as const), by: fc.integer({ min: 1, max: 150_000 }) }),
  // Ruling 30: a backward step of the shared clock, a forward recvMs on another stream, and rejected records.
  fc.record({ kind: fc.constant('back' as const), by: fc.integer({ min: 1, max: 7_200_000 }) }),
  fc.record({ kind: fc.constant('forwardRecord' as const), ahead: fc.integer({ min: 0, max: 86_400_000 }) }),
  fc.record({ kind: fc.constant('rejected' as const), ahead: fc.integer({ min: 0, max: 86_400_000 }) }),
);

describe('poll accounting across clock steps and unwatches (rulings 25, 26 and 30)', () => {
  it('polls counted equal polls appended, no (pool, minute) twice, and every differing pool-minute is explained', () => {
    fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 300 }), (ops) => {
      const q = new RecorderQueue({ config: { maxWatchedPools: 3 } });
      const out: EncodedRecord[] = [];
      const gaps: Gap[] = [];
      // Polls stamped per (pool, minute), from the accepted ones.
      const stamped = new Map<string, { s: number; f: number }>();
      const stamp = (pool: string, recvMs: number, kind: 's' | 'f'): void => {
        const k = `${pool}@${Math.floor(recvMs / MINUTE_MS) * MINUTE_MS}`;
        const c = stamped.get(k) ?? { s: 0, f: 0 };
        c[kind]++;
        stamped.set(k, c);
      };
      const drain = (): void => {
        out.push(...q.take(Number.MAX_SAFE_INTEGER, SEG));
        for (const g of q.drainGaps().poll_counts ?? []) gaps.push(g);
      };
      let clock: number = T0;
      let polls = 0;
      let failed = 0;
      for (const o of ops) {
        if (o.kind === 'poll') {
          // recvMs up to 90 s behind the clock: late polls into minutes already written.
          const stream = o.position ? 'pool_snapshot_position' : 'pool_snapshot';
          const t = clock - o.back;
          const r = q.append(snap(`p${o.pool}`, o.state, t, stream, o.position ? 'position' : 'normal'));
          if (typeof r !== 'object') {
            polls++;
            stamp(`p${o.pool}`, t, 's');
          }
        } else if (o.kind === 'fail') {
          if (q.notePollFailed(`p${o.pool}`, 'normal', ms(clock), o.position)) {
            failed++;
            stamp(`p${o.pool}`, clock, 'f');
          }
        } else if (o.kind === 'unwatch') {
          q.unwatch(`p${o.pool}`, ms(clock + o.ahead));
        } else if (o.kind === 'tick') {
          q.tick(ms(clock + o.ahead));
        } else if (o.kind === 'advance') {
          clock += o.by;
        } else if (o.kind === 'back') {
          clock -= o.by;
        } else if (o.kind === 'forwardRecord') {
          q.append({ stream: 'discovery', recvMs: ms(clock + o.ahead), slot: null, commitment: null, source: 'prop', payload: {} });
        } else {
          const r = q.append({ stream: 'discovery', recvMs: ms(clock + o.ahead), slot: null, commitment: null, source: 'prop', payload: new Map() });
          assert.deepEqual(r, { rejected: 'E_PAYLOAD' });
        }
        drain();
      }
      // Close out: the writer and the feed reach a later minute, every pool is unwatched, and a last tick.
      clock = Math.max(clock, ...out.map((r) => r.recvMs)) + 180_000;
      q.tick(ms(clock - 60_000));
      q.append({ stream: 'decision', recvMs: ms(clock), slot: null, commitment: null, source: 'prop', payload: {} });
      for (let i = 0; i < 5; i++) q.unwatch(`p${i}`, ms(clock));
      q.tick(ms(clock));
      drain();

      const counts = out.filter((r) => r.stream === 'poll_counts').map(payloadOf);
      const keys = counts.map((p) => `${String(p.poolId)}@${String(p.minuteStartMs)}`);
      assert.equal(new Set(keys).size, keys.length, 'a (pool, minute) record appears twice');
      // Ruling 32: every record expanded into the minutes it covers (a skippedMinutes record covers its whole span):
      // no pool's minute is covered twice.
      const minutesCovered = new Set<string>();
      for (const c of counts) {
        const span = typeof c.skippedMinutes === 'number' ? c.skippedMinutes : 1;
        for (let i = 0; i < span; i++) {
          const k = `${String(c.poolId)}@${(c.minuteStartMs as number) + i * MINUTE_MS}`;
          assert.ok(!minutesCovered.has(k), `${k} covered twice`);
          minutesCovered.add(k);
        }
      }
      assert.equal(counts.reduce((a, p) => a + (p.successfulPolls as number), 0), polls, 'successful polls lost or double counted');
      assert.equal(counts.reduce((a, p) => a + (p.failedPolls as number), 0), failed, 'failed polls lost or double counted');
      assert.equal(q.stats().droppedTotal.poll_counts, 0);

      // Per-minute resolution (rulings 30 and 33): for each pool-minute not covered by that pool's clock_step gap or a
      // skippedMinutes span, the polls stamped in it equal the polls recorded for it, where a record's latePolls came
      // from the minute before.
      const covered = (pool: string, minuteMs: number): boolean =>
        gaps.some((g) => (g.poolId === undefined || g.poolId === pool) && g.fromMs <= minuteMs && g.toMs >= minuteMs + MINUTE_MS - 1)
        || counts.some((c) => c.poolId === pool && typeof c.skippedMinutes === 'number'
          && (c.minuteStartMs as number) <= minuteMs && minuteMs < (c.minuteStartMs as number) + (c.skippedMinutes) * MINUTE_MS);
      const recorded = new Map<string, { n: number; late: number }>();
      for (const c of counts) {
        const n = (c.successfulPolls as number) + (c.failedPolls as number);
        const late = typeof c.latePolls === 'number' ? c.latePolls : 0;
        if (late > 0) assert.equal(c.lateFromMinuteStartMs, (c.minuteStartMs as number) - MINUTE_MS);
        recorded.set(`${String(c.poolId)}@${String(c.minuteStartMs)}`, { n, late });
      }
      const minutesToCheck = new Set<string>([...stamped.keys(), ...recorded.keys()]);
      for (const k of minutesToCheck) {
        const [pool, minute] = k.split('@') as [string, string];
        const m = Number(minute);
        if (covered(pool, m)) continue;
        const st = stamped.get(k) ?? { s: 0, f: 0 };
        const here = recorded.get(k) ?? { n: 0, late: 0 };
        const next = recorded.get(`${pool}@${m + MINUTE_MS}`) ?? { n: 0, late: 0 };
        // Recorded here, minus what came in from the minute before, plus what went on to the next minute.
        const accounted = here.n - here.late + next.late;
        assert.equal(accounted, st.s + st.f, `${k}: stamped ${st.s + st.f}, accounted ${accounted}, no gap explains it`);
      }
      // Ruling 33: gaps exclude at most the two pool-minutes of each poll moved more than one minute.
      const excluded = new Set<string>();
      for (const g of gaps) {
        assert.ok(g.poolId !== undefined || gaps.length > 1_000, 'a poll_counts gap without its pool');
        for (let t = g.fromMs; t <= g.toMs; t += MINUTE_MS) excluded.add(`${String(g.poolId)}@${t}`);
      }
      assert.ok(excluded.size <= 2 * q.stats().movedPolls, `${excluded.size} pool-minutes excluded for ${q.stats().movedPolls} moved polls`);
    }), params);
  });
});
