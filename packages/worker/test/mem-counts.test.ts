// MEM-PROBE: every minute the worker keeps the heap's old and large-object MB and the size of every major collection
// (counts only); the last ten ride in mem.json, the next boot's death_mem and the summary's last_death, with a mark on
// the samples around the state save. So the next death says what grew.
import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEM_FILE, PROBE_EVERY_MS, PROBE_FILE, PROBE_KEEP, PROBE_MAX_COUNTS, PROBE_STORE_KINDS, deathMem, parseDeathMem, probeCode, probeCounts, readMem, readProbe, writeMem, writeProbe,
  type MemSample, type ProbeSample,
} from '../src/run/mem-trace.ts';
import { buildSummary, emptySummaryState, foldText, summaryBody, withoutProbe } from '../src/run/summary.ts';
import { SUMMARY_MAX_BYTES, checkSummary } from '../../ops/src/watchdog/summary.ts';
import { melbourneDate } from '../src/run/api.ts';
import { STATE_FILES } from '../../runner/src/contract.ts';
import { Market, makeWorker, tempState, virtualTimers, T } from './worker-harness.ts';
import { AsOfStore, PROBE_KIND_SAMPLE } from '../../core/src/engine/asof.ts';

const MB = 1_048_576;
const sample = (over: Partial<MemSample> = {}): MemSample => ({ at: 1_000_000, heap_used: 100 * MB, heap_limit: 500 * MB, rss: 300 * MB, external: 1, array_buffers: 1, cgroup_max: null, ...over });
const probe = (at: number, over: Partial<ProbeSample> = {}): ProbeSample => ({ at, heap_used_mb: 300, old_mb: 250, large_object_mb: 40, saving: false, counts: [{ code: 'store_keys', count: 120_000 }, { code: 'feed_keys', count: 90_000 }], ...over });

describe('the counts', () => {
  it('flattens groups to codes in order, the store\'s largest key kinds after them; whole, non-negative, at most the cap', () => {
    const byPrefix = new Map(Object.entries({ 'logs:pump': 500, 'read:accounts': 900, gates: 20, 'Weird Kind!': 7 }));
    const c = probeCounts({ store: { keys: 1_427, entries: 3_000.4 }, feed: { keys: 12, held: -3 } }, byPrefix);
    expect(c).toEqual([
      { code: 'store_keys', count: 1_427 }, { code: 'store_entries', count: 3_000 }, { code: 'feed_keys', count: 12 }, { code: 'feed_held', count: 0 },
      { code: 'store_k_read_accounts', count: 900 }, { code: 'store_k_logs_pump', count: 500 }, { code: 'store_k_gates', count: 20 }, { code: 'store_k_weird_kind_', count: 7 },
    ]);
    const many = new Map(Array.from({ length: 40 }, (_, i) => [`k${i}`, 1_000 - i] as const));
    expect(probeCounts({}, many).map((x) => x.code)).toEqual(Array.from({ length: PROBE_STORE_KINDS }, (_, i) => `store_k_k${i}`));
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`n${i}`, i]));
    expect(probeCounts({ g: wide })).toHaveLength(PROBE_MAX_COUNTS);
    expect(probeCounts({ g: { nan: Number.NaN, inf: Number.POSITIVE_INFINITY } })).toEqual([]);
    // No address reaches a published kind: a long or address-shaped segment counts as `x`, and kinds that merge are summed.
    const mint = 'So11111111111111111111111111111111111111112';
    expect(probeCounts({}, new Map([[`read:${mint}`, 3], [`pump:${'z'.repeat(25)}`, 2], ['read:x', 1], ['gates:mint', 9]]))).toEqual([
      { code: 'store_k_gates_mint', count: 9 }, { code: 'store_k_read_x', count: 4 }, { code: 'store_k_pump_x', count: 2 },
    ]);
    expect(probeCode('A'.repeat(80))).toBe('a'.repeat(48));
    expect(probeCode('123')).toBe('other');
  });

  it('the store counts keys, entries and tails exactly; key kinds exactly up to the sample size, evenly sampled and scaled beyond', () => {
    const now = { slot: 10n, txIndex: 0, ixIndex: 0, receivedAt: 1 };
    const small = new AsOfStore({ now: () => now });
    small.record('logs:pump:CreateEvent:a', 1, now, 'i1');
    small.record('logs:pump:CreateEvent:b', 1, now, 'i2');
    small.record('logs:pump:CreateEvent:b', 2, now, 'i3');
    small.record('gates:mint:m', 1, now, 'i4');
    small.record('plain', 1, now, 'i5');
    // A key with no `:` has no tail to index.
    small.record('plain', 2, now, 'i6');
    small.record('plain', 3, now, 'i7');
    // STORE-GROWTH: entries per kind too: one key (`plain`) with three entries outweighs two keys with three between them.
    expect(small.sizes()).toEqual({ keys: 4, entries: 7, tails: 3, byPrefix: new Map([['logs:pump', 2], ['gates:mint', 1], ['plain', 1]]), entriesByPrefix: new Map([['logs:pump', 3], ['gates:mint', 1], ['plain', 3]]) });
    const big = new AsOfStore({ now: () => now });
    const n = 3 * PROBE_KIND_SAMPLE;
    for (let i = 0; i < n; i++) big.record(`${i % 3 === 0 ? 'read:accounts' : 'pump:TradeEvent'}:${i}`, i, now, `i${i}`);
    const z = big.sizes();
    expect([z.keys, z.entries]).toEqual([n, n]);
    // Kinds repeating every third key (the period a plain stride would alias with): each estimated within 5%.
    const est = (k: string) => z.byPrefix.get(k) ?? 0;
    expect(Math.abs(est('read:accounts') - n / 3)).toBeLessThan(0.05 * n / 3);
    expect(Math.abs(est('pump:TradeEvent') - 2 * n / 3)).toBeLessThan(0.05 * 2 * n / 3);
    expect(Math.abs((z.entriesByPrefix.get('read:accounts') ?? 0) - n / 3)).toBeLessThan(0.05 * n / 3);
  });

  it('STORE-GROWTH: the largest kinds by entries follow the kinds by keys, masked and summed the same way', () => {
    const mint = 'So11111111111111111111111111111111111111112';
    const keys = new Map([['logs:pump', 500], ['worker:fact-reads', 1]]);
    const entries = new Map([['logs:pump', 500], ['worker:fact-reads', 5_723], [`read:${mint}`, 3], ['read:x', 1]]);
    expect(probeCounts({ store: { keys: 501 } }, keys, entries)).toEqual([
      { code: 'store_keys', count: 501 },
      { code: 'store_k_logs_pump', count: 500 }, { code: 'store_k_worker_fact-reads', count: 1 },
      { code: 'store_e_worker_fact-reads', count: 5_723 }, { code: 'store_e_logs_pump', count: 500 }, { code: 'store_e_read_x', count: 4 },
    ]);
    const many = new Map(Array.from({ length: 40 }, (_, i) => [`k${i}`, 1_000 - i] as const));
    expect(probeCounts({}, new Map(), many).map((x) => x.code)).toEqual(Array.from({ length: PROBE_STORE_KINDS }, (_, i) => `store_e_k${i}`));
  });

  it('mem.json keeps the sample and the recent probes; only well-formed probes are read back', () => {
    const dir = tempState();
    const recent = [probe(1), probe(2, { saving: true })];
    writeMem(dir, sample());
    writeProbe(dir, recent);
    expect(readMem(dir)!.heap_used).toBe(100 * MB);
    expect(readProbe(dir)).toEqual(recent);
    // The 10-second sample is written alone: the probes stay as they were (ops review: no rewrite every 10 s).
    writeMem(dir, sample({ at: 2_000_000 }));
    expect(readProbe(dir)).toEqual(recent);
    for (const bad of [
      [{ ...probe(1), saving: 'yes' }], [probe(1, { counts: [{ code: 'Bad Code', count: 1 }] })],
      [probe(1, { heap_used_mb: -1 })], Array.from({ length: PROBE_KEEP + 1 }, (_, i) => probe(i)), 'x',
    ]) {
      writeFileSync(join(dir, PROBE_FILE), JSON.stringify(bad));
      expect(readProbe(dir), JSON.stringify(bad).slice(0, 80)).toEqual([]);
    }
    rmSync(join(dir, PROBE_FILE));
    expect(readProbe(dir)).toEqual([]);
  });

  it('a death carries the probes when its sample is fresh, none when it is old; a malformed probe drops the record', () => {
    const dir = tempState();
    writeMem(dir, sample({ at: 995_000 }));
    writeProbe(dir, [probe(940_000), probe(994_000, { saving: true })]);
    expect(deathMem(dir, 1_000_000, 400_000)!.recent).toEqual([probe(940_000), probe(994_000, { saving: true })]);
    expect(deathMem(dir, 1_000_000 + 30_000, 400_000)?.recent).toBeUndefined();
    const d = deathMem(dir, 1_000_000, 400_000)!;
    expect(parseDeathMem(JSON.parse(JSON.stringify(d)))).toEqual(d);
    // A malformed `recent` drops only itself; the rest of the record stands (ops review).
    const { recent: _r, ...rest } = d;
    expect(parseDeathMem({ ...d, recent: [{ ...probe(1), saving: 1 }] })).toEqual(rest);
    expect(parseDeathMem({ ...d, recent: Array.from({ length: PROBE_KEEP + 1 }, (_, i) => probe(i)) })).toEqual(rest);
    expect(parseDeathMem({ ...d, recent: 'x' })).toEqual(rest);
    expect(parseDeathMem({ ...d, at: -1 })).toBeNull();
  });
});

describe('in the worker', () => {
  it('keeps a probe sample each minute with the major collections, and one just before and just after each save', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const h = makeWorker({ stateDir, timers, seedWaitMs: 0 });
    const m = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m.slot();
    expect(await started).toEqual({ ok: true });
    await m.run(PROBE_EVERY_MS + 11_000, 500, () => m.slot());
    const recent = readProbe(stateDir);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(readFileSync(join(stateDir, MEM_FILE), 'utf8'))).not.toHaveProperty('recent');
    const codes = new Set(recent.at(-1)!.counts.map((c) => c.code));
    for (const c of ['store_keys', 'store_entries', 'store_records', 'feed_keys', 'feed_held', 'facts_books', 'facts_queue', 'strategy_cands', 'strategy_deployer_mints', 'worker_pools', 'worker_create_sig', 'worker_exits_chars', 'loop_max_ms', 'loop_p95_ms', 'fills_active', 'fills_waiting']) {
      expect(codes.has(c), c).toBe(true);
    }
    expect(recent.at(-1)!.counts.find((c) => c.code === 'store_keys')!.count).toBeGreaterThan(0);
    // Past the save period: a sample marked saving, then the one right after it, unmarked.
    await m.run(5 * PROBE_EVERY_MS + 11_000, 500, () => m.slot());
    const after = readProbe(stateDir);
    const i = after.findIndex((p) => p.saving);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(after[i + 1]?.saving).toBe(false);
    expect(after.length).toBeLessThanOrEqual(PROBE_KEEP);
    expect(await h.worker.stop()).toBe(0);
  });

  it('the next boot\'s start line and the day\'s summary carry the probes; the watchdog\'s guard takes the body', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const a = makeWorker({ stateDir, timers });
    await a.worker.reconcile();
    await a.worker.kill();
    const last = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8').trimEnd().split('\n').at(-1)!;
    const death = Date.parse((JSON.parse(last) as { ts: string }).ts);
    const recent = [probe(death - 61_000), probe(death - 2_000, { saving: true, large_object_mb: 90 })];
    writeMem(stateDir, sample({ at: death - 2_000, heap_used: 560 * MB, heap_limit: 572 * MB }));
    writeProbe(stateDir, recent);
    const pre = makeWorker({ stateDir, timers, phase: 'reconcile' });
    expect(await pre.worker.reconcileOnly()).toEqual({ ok: true });
    rmSync(join(stateDir, MEM_FILE));
    rmSync(join(stateDir, PROBE_FILE));
    const b = makeWorker({ stateDir, timers });
    await b.worker.stop();
    const text = readFileSync(join(stateDir, STATE_FILES.journal), 'utf8');
    const main = JSON.parse(text.split('\n').filter((l) => l.includes('"kind":"start"')).at(-1)!) as { death_mem: { recent: unknown } };
    expect(main.death_mem.recent).toEqual(recent);
    const st = emptySummaryState();
    for (const l of text.split('\n')) foldText(st, l, new Date(T - 30 * 86_400_000).toISOString());
    const day = melbourneDate(timers.now());
    const sum = buildSummary({ day, final: false, nowMs: timers.now(), fold: st.days[day], gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'off', uptimeS: 1, trades: [], openPositions: 0, solPrice: null, credits: [] });
    expect(sum.worker.last_death?.recent).toEqual(recent.map((p) => ({ ...p, at: new Date(p.at).toISOString() })));
    const body = summaryBody(sum);
    expect('body' in body && checkSummary(body.body).ok).toBe(true);
    // Without the probes it is exactly the shape a watchdog from before MEM-PROBE takes.
    const old = withoutProbe(sum);
    expect(Object.keys(old.worker.last_death!).sort()).toEqual(['at', 'heap_limit_mb', 'heap_used_mb', 'sample', 'spaces', 'uptime_s']);
    expect(withoutProbe(old)).toBe(old);
  });

  it('over the size cap, the oldest probe samples go first; the newest stays and the trades stay listed', () => {
    const counts = Array.from({ length: PROBE_MAX_COUNTS }, (_, i) => ({ code: `${'c'.repeat(40)}_${String(i).padStart(3, '0')}`, count: 999_999_999 }));
    const recent = Array.from({ length: PROBE_KEEP }, (_, i) => ({ at: new Date(T + i * 60_000).toISOString(), heap_used_mb: 500, old_mb: 400, large_object_mb: 60, saving: false, counts }));
    const base = buildSummary({ day: melbourneDate(T), final: false, nowMs: T, fold: undefined, gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'off', uptimeS: 1, trades: [], openPositions: 0, solPrice: null, credits: [] });
    const sum = { ...base, worker: { ...base.worker, restarts: { planned: 0, deploy: 0, unplanned: 1 }, exits: [], crash_sites: [], last_death: { at: new Date(T).toISOString(), uptime_s: 1_808, heap_used_mb: 563, heap_limit_mb: 572, spaces: [], sample: null, recent } } };
    expect(new TextEncoder().encode(JSON.stringify(sum)).length).toBeGreaterThan(SUMMARY_MAX_BYTES);
    const b = summaryBody(sum);
    if (!('body' in b)) throw new Error(b.refused);
    expect(new TextEncoder().encode(b.body).length).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    const sent = JSON.parse(b.body) as { trades_dropped: number; worker: { last_death: { recent: { at: string }[] } } };
    expect(sent.trades_dropped).toBe(0);
    expect(sent.worker.last_death.recent.length).toBeGreaterThan(0);
    expect(sent.worker.last_death.recent.length).toBeLessThan(PROBE_KEEP);
    expect(sent.worker.last_death.recent.at(-1)!.at).toBe(recent.at(-1)!.at);
  });
});
