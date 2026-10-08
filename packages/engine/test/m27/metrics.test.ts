import { strict as assert } from 'node:assert';
import { describe, it, vi } from 'vitest';
import { BUCKETS, METRICS } from '../../src/m27/catalog.ts';
import { bucketQuantile, CHUNK_BYTES, labelsHash, MetricsRegistry, quantile, type RollupRow } from '../../src/m27/metrics.ts';
import { fakeClock } from '../helpers.ts';

function registry(over: Partial<{ seriesCap: number; ringBudgetBytes: number }> = {}) {
  const clock = fakeClock(Date.UTC(2026, 9, 7, 12, 0, 0));
  const rows: RollupRow[] = [];
  const reg = new MetricsRegistry({ clock, seriesCap: 5_000, ringBudgetBytes: 64 * 1024 * 1024, sink: { append: (r) => { rows.push(...r); } }, ...over });
  return { clock, rows, reg };
}

describe('metric catalog (B-M27-01 logic 1)', () => {
  it('names every metric of ARCH 13.1 with its labels', () => {
    const arch = {
      observation_lag_slots: ['pool', 'provider'], pool_snapshot_age_ms: ['pool'], poll_batch_latency_ms: ['provider'], provider_slot_lag: ['provider'],
      stream_lag_ms: ['source'], stream_reconnects_total: ['source'], bar_missing_ratio: ['pool'], recorder_queue_depth: [], recorder_gap_seconds_total: [],
      screen_duration_ms: ['purpose'], screen_verdict_total: ['verdict', 'check_id'], blacklist_size: [], signals_total: ['strategy'],
      decisions_total: ['decision', 'reason'], decision_latency_ms: [], attempts_total: ['side', 'path', 'status'], failure_class_total: ['class'],
      landing_rate_bps: ['window'], slots_to_confirm: ['path'], confirm_latency_ms: [], send_bucket_wait_ms: ['path'], send_429_total: ['path'],
      exit_supersede_total: [], cu_used: ['route'], cu_price_micro_lamports: ['side'], tip_lamports: ['path'], quote_drift_bps: [], exit_rung_total: ['rung'],
      signer_refusals_total: ['code'], signer_latency_ms: [], expiry_proofs_total: ['method'], equity_lamports: ['mode'], exposure_lamports: [],
      stressed_risk_lamports: [], daily_loss_used_lamports: [], fee_spend_today_lamports: [], exit_fee_float_lamports: [], reconcile_diff_lamports: [],
      hot_balance_lamports: [], sim_payer_balance_lamports: [], cash_flow_lamports_total: ['kind'], signer_lock_state: [], signer_latch_state: [],
      exit_lease_holder: [], sentinel_heartbeat_age_ms: [], notifier_last_success_age_s: [], rpc_projected_month_end_bps: ['provider'],
      cost_lamports_total: ['kind'], cost_model_error_bps: ['kind'], event_loop_lag_ms: [], rss_bytes: [], db_write_latency_ms: [], disk_free_bytes: [],
      ntp_offset_ms: [], rpc_requests_total: ['provider', 'method', 'status'], rpc_credits_used: ['provider'],
    } as const;
    for (const [name, labels] of Object.entries(arch)) {
      const def = (METRICS as Record<string, { labels: readonly string[] }>)[name];
      assert.ok(def, name);
      assert.deepEqual([...def.labels], [...labels], name);
    }
  });

  it('makes every *_total a counter and gives every histogram ascending buckets', () => {
    for (const [name, def] of Object.entries(METRICS)) {
      if (name.endsWith('_total')) assert.equal(def.kind, 'counter', name);
      if (def.kind === 'histogram') assert.ok(def.buckets.every((b, i) => i === 0 || b > (def.buckets[i - 1] as number)), name);
    }
    for (const b of Object.values(BUCKETS)) assert.ok(b.length > 0);
  });
});

describe('MetricsRegistry handles (hot path in memory only)', () => {
  it('refuses unknown names, a wrong kind, wrong labels and invalid values', () => {
    const { reg } = registry();
    assert.throws(() => reg.counter('nope_total' as 'sweeps_total', {}), /not in the catalog/);
    assert.throws(() => reg.counter('rss_bytes' as 'sweeps_total', {}), /is a gauge, not a counter/);
    assert.throws(() => reg.counter('send_429_total', {} as { path: string }), /takes labels \[path\]/);
    assert.throws(() => reg.counter('send_429_total', { path: 'rpc', extra: 'x' } as { path: string }), /takes labels/);
    assert.throws(() => reg.counter('send_429_total', { peth: 'rpc' } as unknown as { path: string }), /takes labels/);
    assert.throws(() => reg.counter('send_429_total', { path: 1 } as unknown as { path: string }), /takes labels/);
    const c = reg.counter('sweeps_total', {});
    assert.throws(() => c.inc(-1), /finite and >= 0/);
    assert.throws(() => c.inc(Number.NaN), /finite and >= 0/);
    assert.throws(() => c.inc(Number.POSITIVE_INFINITY), /finite and >= 0/);
    assert.throws(() => reg.gauge('rss_bytes', {}).set(Number.NaN), /must be finite/);
    assert.throws(() => reg.histogram('confirm_latency_ms', {}).observe(Number.POSITIVE_INFINITY), /must be finite/);
    assert.throws(() => new MetricsRegistry({ clock: fakeClock(), seriesCap: 3, ringBudgetBytes: 0, sink: { append() {} } }), RangeError);
    assert.throws(() => new MetricsRegistry({ clock: fakeClock(), seriesCap: 3.5, ringBudgetBytes: 0, sink: { append() {} } }), RangeError);
    assert.throws(() => new MetricsRegistry({ clock: fakeClock(), seriesCap: 10, ringBudgetBytes: -1, sink: { append() {} } }), RangeError);
    assert.throws(() => new MetricsRegistry({ clock: fakeClock(), seriesCap: 10, ringBudgetBytes: 0.5, sink: { append() {} } }), RangeError);
  });

  it('returns one series per name and label set, and renders the text exposition', () => {
    const { reg } = registry();
    reg.counter('send_429_total', { path: 'rpc' }).inc();
    reg.counter('send_429_total', { path: 'rpc' }).inc(2);
    reg.counter('send_429_total', { path: 'sen"d\\er\n' }).inc();
    reg.gauge('rss_bytes', {}).set(1234);
    const h = reg.histogram('slots_to_confirm', { path: 'rpc' });
    h.observe(0);
    h.observe(5);
    h.observe(1_000);
    const text = reg.render();
    assert.match(text, /^# TYPE metrics_series gauge$/m);
    assert.match(text, /^send_429_total\{path="rpc"\} 3$/m);
    assert.match(text, /^send_429_total\{path="sen\\"d\\\\er\\n"\} 1$/m);
    assert.match(text, /^rss_bytes 1234$/m);
    assert.match(text, /^slots_to_confirm_bucket\{path="rpc",le="0"\} 1$/m);
    assert.match(text, /^slots_to_confirm_bucket\{path="rpc",le="6"\} 2$/m);
    assert.match(text, /^slots_to_confirm_bucket\{path="rpc",le="\+Inf"\} 3$/m);
    assert.match(text, /^slots_to_confirm_sum\{path="rpc"\} 1005$/m);
    assert.match(text, /^slots_to_confirm_count\{path="rpc"\} 3$/m);
    assert.match(text, /^metrics_series 8$/m);
    assert.equal(reg.size(), 8);
  });

  it('caps the number of series and counts the dropped ones (no-op handles)', () => {
    const { reg } = registry({ seriesCap: 5 });
    const kept = reg.counter('send_429_total', { path: 'a' });
    const dropped = reg.counter('send_429_total', { path: 'b' });
    dropped.inc();
    reg.gauge('rss_bytes', {}).set(5);
    reg.histogram('confirm_latency_ms', {}).observe(5);
    kept.inc();
    assert.equal(reg.size(), 5);
    assert.match(reg.render(), /^metrics_series_dropped_total 3$/m);
    assert.doesNotMatch(reg.render(), /path="b"/);
  });
});

describe('series lifetime: pool labels only while the pool is watched (B-M27-01 logic 1; review R1)', () => {
  const poolSeries = (reg: MetricsRegistry, pool: string) => {
    reg.gauge('pool_snapshot_age_ms', { pool }).set(250);
    reg.gauge('bar_missing_ratio', { pool }).set(0);
    reg.histogram('observation_lag_slots', { pool, provider: 'shyft' }).observe(1);
  };

  it('rotates more than 5,000 series through the cap while a 30-pool watchlist stays fully exported', () => {
    const { reg, clock } = registry({ ringBudgetBytes: 200 * CHUNK_BYTES });
    const watched = Array.from({ length: 30 }, (_, i) => `W${i}`);
    for (const pool of watched) poolSeries(reg, pool);
    for (let i = 0; i < 2_000; i++) {                  // 6,000 series in all, one pool watched and dropped each second
      const pool = `R${i}`;
      poolSeries(reg, pool);
      reg.tick();
      clock.advance(1_000);
      assert.equal(reg.releaseWhere({ pool }), 3);
    }
    const text = reg.render();
    assert.match(text, /^metrics_series_dropped_total 0$/m);
    assert.match(text, /^metrics_ring_evicted_total 0$/m);
    for (const pool of watched) {
      assert.match(text, new RegExp(`^pool_snapshot_age_ms\\{pool="${pool}"\\} 250$`, 'm'));
      assert.match(text, new RegExp(`^bar_missing_ratio\\{pool="${pool}"\\} 0$`, 'm'));
      assert.match(text, new RegExp(`^observation_lag_slots_count\\{pool="${pool}",provider="shyft"\\} 1$`, 'm'));
    }
    assert.doesNotMatch(text, /pool="R/);
    assert.equal(reg.size(), 4 + 90);
    assert.equal(reg.ringBytes(), (4 + 90) * CHUNK_BYTES); // the released series' hours are freed
    poolSeries(reg, 'NEW');                            // a newly watched pool is exported, not dropped
    assert.match(reg.render(), /^pool_snapshot_age_ms\{pool="NEW"\} 250$/m);
  });

  it('frees the 1 s history at once and writes the released minute once, also when the series comes back that minute', () => {
    const { reg, clock, rows } = registry();
    const c = reg.counter('send_429_total', { path: 'a' });
    const g = reg.gauge('pool_snapshot_age_ms', { pool: 'P' });
    c.inc(2);
    g.set(7);
    reg.tick();
    const sec = Math.floor(clock.nowMs() / 1000);
    assert.deepEqual(reg.points('pool_snapshot_age_ms', { pool: 'P' }, sec, sec), [{ sec, value: 7 }]);
    const before = reg.ringBytes();
    assert.equal(reg.release('send_429_total', { path: 'a' }), true);
    assert.equal(reg.release('send_429_total', { path: 'a' }), false);
    assert.equal(reg.release('pool_snapshot_age_ms', { pool: 'P' }), true);
    assert.equal(reg.ringBytes(), before - 2 * CHUNK_BYTES);
    assert.deepEqual(reg.points('pool_snapshot_age_ms', { pool: 'P' }, sec, sec), []);
    assert.doesNotMatch(reg.render(), /path="a"|pool="P"/);
    reg.counter('send_429_total', { path: 'a' }).inc(1); // back in the same minute: the same series, one row
    clock.advance(60_000);
    reg.tick();
    const mine = rows.filter((r) => r.metric === 'send_429_total' || r.metric === 'pool_snapshot_age_ms');
    assert.deepEqual(mine.map((r) => [r.metric, r.count, r.sum]), [['send_429_total', 2, 3], ['pool_snapshot_age_ms', 1, 7]]);
    rows.length = 0;
    clock.advance(60_000);
    reg.tick();                                        // the released gauge is gone for good
    assert.deepEqual(rows.filter((r) => r.metric === 'pool_snapshot_age_ms'), []);
    assert.equal(reg.releaseWhere({ pool: 'nobody' }), 0);
    assert.throws(() => reg.releaseWhere({}), /at least one label/);
    assert.throws(() => reg.release('metrics_series', {}), /cannot be released/);
  });

  it('a handle kept after its release throws instead of writing to a series nobody reads (red team n2)', () => {
    const { reg, clock, rows } = registry();
    const c = reg.counter('send_429_total', { path: 'a' });
    const g = reg.gauge('pool_snapshot_age_ms', { pool: 'P' });
    const h = reg.histogram('observation_lag_slots', { pool: 'P', provider: 'shyft' });
    reg.tick();
    assert.equal(reg.release('send_429_total', { path: 'a' }), true);
    assert.equal(reg.releaseWhere({ pool: 'P' }), 2);
    clock.advance(60_000);
    reg.tick();                                        // the minute ends: the released series are forgotten
    assert.throws(() => c.inc(), /send_429_total handle was used after its series was released/);
    assert.throws(() => g.set(5), /pool_snapshot_age_ms handle was used after its series was released/);
    assert.throws(() => h.observe(1), /observation_lag_slots handle was used after its series was released/);
    const fresh = reg.counter('send_429_total', { path: 'a' });   // a new handle is a new series, written and exported
    fresh.inc(4);
    assert.throws(() => c.inc(), /released/);          // the old one stays refused
    clock.advance(60_000);
    reg.tick();
    assert.deepEqual(rows.filter((r) => r.metric === 'send_429_total').map((r) => [r.count, r.sum]), [[1, 4]]);
    assert.match(reg.render(), /^send_429_total\{path="a"\} 4$/m);
    reg.release('send_429_total', { path: 'a' });
    assert.throws(() => fresh.inc(), /released/);      // refused at once, also within the minute
    reg.counter('send_429_total', { path: 'a' });      // taken again the same minute: the same series, live again
    fresh.inc(1);
    assert.match(reg.render(), /^send_429_total\{path="a"\} 5$/m);
  });
});

describe('1 s history and 1-minute rollups (B-M27-01 logic 2)', () => {
  it('writes one row per active counter and histogram per minute, and gauge rows only when the value changed', () => {
    const { reg, clock, rows } = registry();
    const c = reg.counter('send_429_total', { path: 'rpc' });
    const g = reg.gauge('rss_bytes', {});
    const h = reg.histogram('confirm_latency_ms', {});
    reg.counter('sweeps_total', {});                  // never incremented: no row
    g.set(100);
    reg.tick();
    c.inc();
    c.inc(4);
    for (const v of [3, 7, 15, 40, 400_000]) h.observe(v);
    clock.advance(1_000);
    g.set(300);
    reg.tick();
    clock.advance(59_000);                             // next minute
    reg.tick();
    const minute = Date.UTC(2026, 9, 7, 12, 0, 0);
    const by = (m: string) => rows.filter((r) => r.metric === m);
    assert.deepEqual(by('send_429_total'), [{ metric: 'send_429_total', labelsHash: labelsHash({ path: 'rpc' }), minute, scope: 'aggregate', count: 2, sum: 5, p50: null, p95: null, p99: null }]);
    assert.equal(by('sweeps_total').length, 0);
    assert.deepEqual(by('confirm_latency_ms'), [{ metric: 'confirm_latency_ms', labelsHash: labelsHash({}), minute, scope: 'aggregate', count: 5, sum: 400_065, p50: 20, p95: 400_000, p99: 400_000 }]);
    const rss = by('rss_bytes');
    assert.equal(rss.length, 1);
    assert.deepEqual({ count: rss[0]?.count, sum: rss[0]?.sum, p50: rss[0]?.p50, p99: rss[0]?.p99 }, { count: 2, sum: 400, p50: 100, p99: 300 });
    rows.length = 0;
    clock.advance(60_000);                             // a minute with the gauge unchanged and no activity
    reg.tick();
    assert.deepEqual(rows.filter((r) => !r.metric.startsWith('metrics_')), []);
    clock.advance(1_000);
    reg.tick();
    clock.advance(30_000);
    reg.tick();                                        // same minute: nothing written
    assert.deepEqual(rows.filter((r) => r.metric === 'rss_bytes'), []);
  });

  it('keeps 1 s points for 24 h and frees older hours', () => {
    const { reg, clock } = registry();
    const g = reg.gauge('rss_bytes', {});
    const start = Math.floor(clock.nowMs() / 1000);
    g.set(1);
    reg.tick();
    clock.advance(1_000);
    g.set(2);
    reg.tick();
    assert.deepEqual(reg.points('rss_bytes', {}, start, start + 5), [{ sec: start, value: 1 }, { sec: start + 1, value: 2 }]);
    assert.deepEqual(reg.points('confirm_latency_ms', {}, start, start + 1), []);
    clock.advance(25 * 3_600_000);
    reg.tick();
    assert.deepEqual(reg.points('rss_bytes', {}, start, start + 5), []);
    assert.equal(reg.ringBytes(), 5 * CHUNK_BYTES);    // the current hour of the 5 series
  });

  it('stays inside the memory budget: the oldest hour is freed first and counted', () => {
    const { reg, clock } = registry({ ringBudgetBytes: 5 * CHUNK_BYTES });
    reg.gauge('rss_bytes', {}).set(1);
    reg.tick();                                        // 5 series × 1 chunk = budget
    const first = Math.floor(clock.nowMs() / 1000);
    clock.advance(3_600_000);
    reg.tick();                                        // next hour: each new chunk frees an old one
    assert.equal(reg.ringBytes(), 5 * CHUNK_BYTES);
    assert.deepEqual(reg.points('rss_bytes', {}, first, first), []);
    assert.match(reg.render(), /^metrics_ring_evicted_total 5$/m);
    const none = registry({ ringBudgetBytes: 0 });
    none.reg.tick();
    assert.equal(none.reg.ringBytes(), 0);
  });

  it('a rollup write that fails is counted and logged at error, never thrown out of tick()', () => {
    const clock = fakeClock(Date.UTC(2026, 9, 7, 12, 0, 0));
    const events: Array<{ level: string; code: string; fields: unknown }> = [];
    let fail = true;
    const written: RollupRow[] = [];
    const reg = new MetricsRegistry({ clock, seriesCap: 100, ringBudgetBytes: 0, log: { event: (level, code, fields) => events.push({ level, code, fields }) },
      sink: { append: (r) => { if (fail) throw new Error('database or disk is full'); written.push(...r); } } });
    const c = reg.counter('sweeps_total', {});
    reg.tick();
    c.inc();
    clock.advance(60_000);
    assert.doesNotThrow(() => reg.tick());
    assert.deepEqual(events, [{ level: 'error', code: 'm27.rollup_write_failed',
      fields: { minute_start_ms: Date.UTC(2026, 9, 7, 12, 0, 0), row_count: 2, error_message: 'Error: database or disk is full' } }]);   // sweeps_total, metrics_series
    assert.match(reg.render(), /^metrics_rollup_failed_total 1$/m);
    fail = false;                                      // the next minute writes again
    c.inc();
    clock.advance(60_000);
    reg.tick();
    assert.deepEqual(written.filter((r) => r.metric !== 'metrics_series').map((r) => [r.metric, r.count]),
      [['metrics_rollup_failed_total', 1], ['sweeps_total', 1]]);
    const broken = new MetricsRegistry({ clock, seriesCap: 100, ringBudgetBytes: 0, sink: { append: () => { throw new Error('x'); } } });
    broken.counter('sweeps_total', {}).inc();
    broken.tick();                                     // no logger: counted only
    clock.advance(60_000);
    assert.doesNotThrow(() => broken.tick());
    assert.match(broken.render(), /^metrics_rollup_failed_total 1$/m);
  });

  it('a failure report that throws too (onError writing to the same full database) never escapes tick() (review n1)', () => {
    const clock = fakeClock(Date.UTC(2026, 9, 7, 12, 0, 0));
    const reg = new MetricsRegistry({ clock, seriesCap: 100, ringBudgetBytes: 0, log: { event: () => { throw new Error('alert store: disk is full'); } },
      sink: { append: () => { throw new Error('database or disk is full'); } } });
    reg.counter('sweeps_total', {}).inc();
    reg.tick();
    clock.advance(60_000);
    assert.doesNotThrow(() => reg.tick());
    assert.match(reg.render(), /^metrics_rollup_failed_total 1$/m);
  });

  it('a gauge value whose rollup write failed is written in the next minute even when unchanged (review m4)', () => {
    const clock = fakeClock(Date.UTC(2026, 9, 7, 12, 0, 0));
    let fail = false;
    const written: RollupRow[] = [];
    const reg = new MetricsRegistry({ clock, seriesCap: 100, ringBudgetBytes: 0,
      sink: { append: (r) => { if (fail) throw new Error('database or disk is full'); written.push(...r); } } });
    const g = reg.gauge('rss_bytes', {});
    const runTo = (minute: number): void => {
      while (clock.nowMs() < Date.UTC(2026, 9, 7, 12, minute, 0)) { reg.tick(); clock.advance(1_000); }
      reg.tick();                                      // the first second of the next minute writes the ended one
    };
    g.set(100);
    runTo(1);                                          // 12:00 written: 100
    g.set(200);
    fail = true;
    runTo(2);                                          // 12:01 (200) fails
    fail = false;
    runTo(3);                                          // 12:02: still 200, written now
    assert.deepEqual(written.filter((r) => r.metric === 'rss_bytes').map((r) => [r.minute, r.p50]),
      [[Date.UTC(2026, 9, 7, 12, 0, 0), 100], [Date.UTC(2026, 9, 7, 12, 2, 0), 200]]);
  });

  it('reads only the stored hours, whatever range is asked for (review m6)', () => {
    const { reg, clock } = registry();
    reg.gauge('rss_bytes', {}).set(3);
    reg.tick();
    const now = Math.floor(clock.nowMs() / 1000);
    const started = process.hrtime.bigint();
    assert.deepEqual(reg.points('rss_bytes', {}, 0, now), [{ sec: now, value: 3 }]);
    assert.ok(process.hrtime.bigint() - started < 1_000_000_000n, 'from epoch 0 the per-second loop took about 18 s');
    assert.deepEqual(reg.points('rss_bytes', {}, -1e15, 1e15), [{ sec: now, value: 3 }]);
    assert.deepEqual(reg.points('rss_bytes', {}, now + 1, now - 1), []);
    clock.advance(3_600_000);                          // a second stored hour: read in time order
    reg.gauge('rss_bytes', {}).set(4);
    reg.tick();
    assert.deepEqual(reg.points('rss_bytes', {}, 0, now + 3_600), [{ sec: now, value: 3 }, { sec: now + 3_600, value: 4 }]);
    assert.deepEqual(reg.points('rss_bytes', {}, now + 1, now + 3_600), [{ sec: now + 3_600, value: 4 }]);
    assert.throws(() => reg.points('rss_bytes', {}, 0.5, now), /whole epoch seconds/);
    assert.throws(() => reg.points('rss_bytes', {}, 0, Number.POSITIVE_INFINITY), /whole epoch seconds/);
  });

  it('runs tick() on an unreferenced timer until stopped', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { reg, clock } = registry();
      const g = reg.gauge('rss_bytes', {});
      g.set(9);
      const stop = reg.start();
      vi.advanceTimersByTime(1_000);
      const sec = Math.floor(clock.nowMs() / 1000);
      assert.deepEqual(reg.points('rss_bytes', {}, sec, sec), [{ sec, value: 9 }]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('quantiles', () => {
  it('nearest rank over sorted samples and over bucket counts', () => {
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
    assert.equal(quantile([1, 2, 3, 4], 0.99), 4);
    assert.equal(quantile([7], 0.01), 7);
    const counts = new Float64Array([1, 0, 2, 1]);
    assert.equal(bucketQuantile(counts, [1, 2, 3], 4, 0.25, 99), 1);
    assert.equal(bucketQuantile(counts, [1, 2, 3], 4, 0.5, 99), 3);
    assert.equal(bucketQuantile(counts, [1, 2, 3], 4, 1, 99), 99);
    assert.equal(bucketQuantile(new Float64Array([0, 0]), [1], 0, 0.5, 5), 5);
  });
});
