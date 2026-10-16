// Rulings 25, 26 and 30 (docs/reviews/Z04.md), in 15-second bars since ruling Z09-32: every counted poll ends in
// exactly one (pool, bar) poll_counts
// record, and every pool-bar whose count differs from the polls stamped in it is explained by a gap on poll_counts
// (clock_step or late) or by a skippedBars record. Random polls, failed polls, unwatches, ticks, forward and
// backward clock steps, forward recvMs on any stream, and rejected records. Fixed seed so a run is reproducible for
// the exact commit it ran on.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { UnixMs } from '@bot/types';
import { POLL_BAR_MS, RecorderQueue, type EncodedRecord, type Gap } from '../../src/index.ts';
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
  it('polls counted equal polls appended, no (pool, bar) twice, and every differing pool-bar is explained', () => {
    fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 300 }), (ops) => {
      const q = new RecorderQueue({ config: { maxWatchedPools: 3 } });
      const out: EncodedRecord[] = [];
      const gaps: Gap[] = [];
      // Polls stamped per (pool, bar), from the accepted ones.
      const stamped = new Map<string, { s: number; f: number }>();
      const stamp = (pool: string, recvMs: number, kind: 's' | 'f'): void => {
        const k = `${pool}@${Math.floor(recvMs / POLL_BAR_MS) * POLL_BAR_MS}`;
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
          // recvMs up to 90 s behind the clock: late polls into bars already written.
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

      const countRecs = out.filter((r) => r.stream === 'poll_counts');
      const counts = countRecs.map(payloadOf);
      // Ruling Z09-32: a per-bar record carries its bar's close as recvMs when written on time, else a later time, so a
      // reader keyed to the close never sees a late one as on time.
      for (const r of countRecs) {
        const p = payloadOf(r);
        if (typeof p.skippedBars === 'number') continue;
        assert.ok(r.recvMs >= (p.barStartMs as number) + POLL_BAR_MS + 1_500, `bar ${String(p.barStartMs)} stamped before its close`);
      }
      const keys = counts.map((p) => `${String(p.poolId)}@${String(p.barStartMs)}`);
      assert.equal(new Set(keys).size, keys.length, 'a (pool, bar) record appears twice');
      // Ruling 32: every record expanded into the bars it covers (a skippedBars record covers its whole span):
      // no pool's bar is covered twice.
      const barsCovered = new Set<string>();
      for (const c of counts) {
        const span = typeof c.skippedBars === 'number' ? c.skippedBars : 1;
        for (let i = 0; i < span; i++) {
          const k = `${String(c.poolId)}@${(c.barStartMs as number) + i * POLL_BAR_MS}`;
          assert.ok(!barsCovered.has(k), `${k} covered twice`);
          barsCovered.add(k);
        }
      }
      assert.equal(counts.reduce((a, p) => a + (p.successfulPolls as number), 0), polls, 'successful polls lost or double counted');
      assert.equal(counts.reduce((a, p) => a + (p.failedPolls as number), 0), failed, 'failed polls lost or double counted');
      assert.equal(q.stats().droppedTotal.poll_counts, 0);

      // Per-bar resolution (rulings 30 and 33): for each pool-bar not covered by that pool's clock_step gap or a
      // skippedBars span, the polls stamped in it equal the polls recorded for it, where a record's latePolls came
      // from the bar before.
      const covered = (pool: string, barMs: number): boolean =>
        gaps.some((g) => (g.poolId === undefined || g.poolId === pool) && g.fromMs <= barMs && g.toMs >= barMs + POLL_BAR_MS - 1)
        || counts.some((c) => c.poolId === pool && typeof c.skippedBars === 'number'
          && (c.barStartMs as number) <= barMs && barMs < (c.barStartMs as number) + (c.skippedBars) * POLL_BAR_MS);
      const recorded = new Map<string, { n: number; late: number }>();
      for (const c of counts) {
        const n = (c.successfulPolls as number) + (c.failedPolls as number);
        const late = typeof c.latePolls === 'number' ? c.latePolls : 0;
        if (late > 0) assert.equal(c.lateFromBarStartMs, (c.barStartMs as number) - POLL_BAR_MS);
        recorded.set(`${String(c.poolId)}@${String(c.barStartMs)}`, { n, late });
      }
      const barsToCheck = new Set<string>([...stamped.keys(), ...recorded.keys()]);
      for (const k of barsToCheck) {
        const [pool, bar] = k.split('@') as [string, string];
        const m = Number(bar);
        if (covered(pool, m)) continue;
        const st = stamped.get(k) ?? { s: 0, f: 0 };
        const here = recorded.get(k) ?? { n: 0, late: 0 };
        const next = recorded.get(`${pool}@${m + POLL_BAR_MS}`) ?? { n: 0, late: 0 };
        // Recorded here, minus what came in from the bar before, plus what went on to the next bar.
        const accounted = here.n - here.late + next.late;
        assert.equal(accounted, st.s + st.f, `${k}: stamped ${st.s + st.f}, accounted ${accounted}, no gap explains it`);
      }
      // Ruling 33: gaps exclude at most the two pool-bars of each poll moved more than one bar.
      const excluded = new Set<string>();
      for (const g of gaps) {
        assert.ok(g.poolId !== undefined || gaps.length > 1_000, 'a poll_counts gap without its pool');
        for (let t = g.fromMs; t <= g.toMs; t += POLL_BAR_MS) excluded.add(`${String(g.poolId)}@${t}`);
      }
      assert.ok(excluded.size <= 2 * q.stats().movedPolls, `${excluded.size} pool-bars excluded for ${q.stats().movedPolls} moved polls`);
    }), params);
  });
});
