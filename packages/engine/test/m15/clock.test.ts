// B-M15-01 slot clock: acceptance criteria 1-4, the outlier rule, the property test, failure injection (primary
// timeouts, a provider 1,000,000 slots ahead) and the fixture tests FX-RPC-EPOCHINFO / FX-RPC-PERFSAMPLES.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import type { Config, EventBus, Result, Slot } from '@bot/types';
import { createSlotClock, DEGRADED_POLL_MS, LAG_UNKNOWN, parseEpochInfo, slotMsFromSamples } from '../../src/m15/clock.ts';
import { CONTEXT_SLOT_TOPIC, type CallOptions, type CallValue, type ContextSlotEvent, type GatewayMode, type RpcError, type RpcGateway } from '../../src/m14/types.ts';
import { prepareParams } from '../../src/m14/methods.ts';
import { slotToTimeMs } from '../../src/m15/slot-time.ts';
import { m15Settings } from '../../src/m15/settings.ts';
import { CONFIG_FIELDS } from '../../src/m25/registry.ts';
import { createRng } from '../../src/m10/rng.ts';
import { FakeTime, RecordingLog, RecordingMetrics, flush } from '../m14/helpers.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/rpc-docs-examples.json', import.meta.url), 'utf8')) as Record<string, { response: { result: unknown } }>;
const SETTINGS = { heightPollMs: 2_000, heightTimeoutMs: 1_500, maxFutureSlotJump: 2_000, slotMsInitial: 267 };
const S = (n: number): Slot => BigInt(n) as Slot;

class Bus implements EventBus {
  private handlers = new Map<string, Array<(e: unknown) => void>>();
  publish<T>(topic: string, e: T): void { for (const h of this.handlers.get(topic) ?? []) h(e); }
  subscribe<T>(topic: string, h: (e: T) => void): () => void {
    const list = this.handlers.get(topic) ?? [];
    list.push(h as (e: unknown) => void);
    this.handlers.set(topic, list);
    return () => { this.handlers.set(topic, (this.handlers.get(topic) ?? []).filter((x) => x !== h)); };
  }
}

type Answer = Result<CallValue<unknown>, RpcError>;
/** A recording gateway: every call is kept; `answer` decides each reply. Parameters are checked as M14 checks them. */
class FakeGateway implements RpcGateway {
  calls: Array<{ method: string; params: unknown[]; o: CallOptions }> = [];
  gatewayMode: GatewayMode = 'normal';
  epoch: (o: CallOptions) => Answer = (o) => ok({ absoluteSlot: 1_000, blockHeight: 900 }, o.provider ?? 'A');
  samples: () => Answer = () => ok(FX['FX-RPC-PERFSAMPLES']?.response.result, 'A');
  async call<T>(method: string, params: unknown[], o: CallOptions): Promise<Result<CallValue<T>, RpcError>> {
    const p = prepareParams(method, params, o.role, o.commitment);
    assert.equal(p.ok, true, `M14 would refuse ${method}: ${JSON.stringify(p)}`);
    this.calls.push({ method, params, o });
    return (method === 'getEpochInfo' ? this.epoch(o) : this.samples()) as Result<CallValue<T>, RpcError>;
  }
  mode(): GatewayMode { return this.gatewayMode; }
}
const ok = (value: unknown, providerLabel: string): Answer => ({ ok: true, value: { value, providerLabel, latencyMs: 5, contextSlot: null } });
const fail = (code: RpcError['code']): Answer => ({ ok: false, error: { code, message: code } });

function setup(providers = ['A', 'B', 'C']) {
  const time = new FakeTime(), bus = new Bus(), gw = new FakeGateway(), log = new RecordingLog(), metrics = new RecordingMetrics();
  const clock = createSlotClock({ gateway: gw, bus, clock: time, scheduler: time, log, metrics, settings: SETTINGS, primaryProvider: 'A', providers });
  const emit = (providerLabel: string, contextSlot: number, method = 'getAccountInfo'): void =>
    bus.publish<ContextSlotEvent>(CONTEXT_SLOT_TOPIC, { providerLabel, contextSlot: S(contextSlot), method, atMs: time.nowMs() });
  return { time, bus, gw, log, metrics, clock, emit };
}
const epochCalls = (gw: FakeGateway) => gw.calls.filter((c) => c.method === 'getEpochInfo');

describe('B-M15-01 acceptance', () => {
  it('AC1: context slots 100 (A), 105 (B), 103 (A) give highest 105 and A lagging 2', () => {
    const { clock, emit } = setup();
    emit('A', 100); emit('B', 105); emit('A', 103);
    assert.equal(clock.highestSeenSlot(), 105n);
    assert.equal(clock.providerSlotLag('A'), 2);
    assert.equal(clock.providerSlotLag('B'), 0);
    assert.equal(clock.providerSlotLag('C'), null);
  });

  it('AC2: a read at context slot 95 with highest seen 105 lags 10 slots; never negative', () => {
    const { clock, emit } = setup();
    emit('B', 105);
    assert.equal(clock.observationLagSlots(S(95)), 10);
    assert.equal(clock.observationLagSlots(S(200)), 0);
  });

  it("AC3: heightOn('B') makes exactly one call with provider B and returns that one response's slot and height", async () => {
    const { clock, gw } = setup();
    gw.epoch = (o) => ok(o.provider === 'B' ? { absoluteSlot: 5_000, blockHeight: 4_321 } : { absoluteSlot: 9, blockHeight: 9 }, o.provider ?? 'A');
    const r = await clock.heightOn('B');
    assert.equal(r.ok, true);
    assert.equal(gw.calls.length, 1);
    assert.equal(gw.calls[0]?.o.provider, 'B');
    assert.equal(gw.calls[0]?.o.priority, 0);
    assert.equal(gw.calls[0]?.o.commitment, 'confirmed');
    if (r.ok) {
      assert.equal(r.value.providerLabel, 'B');
      assert.equal(r.value.slot, 5_000n);
      assert.equal(r.value.blockHeight, 4_321n);
      assert.equal(r.value.commitment, 'confirmed');
    }
  });

  it('AC4: 30 samples totalling 6,725 slots in 1,800 s give 267.66 ± 0.01 ms per slot', async () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({ slot: 1_000 + i, numTransactions: 1, numSlots: i < 25 ? 224 : 225, samplePeriodSecs: 60, numNonVoteTransactions: 0 }));
    assert.equal(samples.reduce((a, s) => a + s.numSlots, 0), 6_725);
    const { clock, gw } = setup();
    gw.samples = () => ok(samples, 'A');
    await clock.start();
    assert.ok(Math.abs(clock.slotDurationMsEstimate() - 267.66) <= 0.01, String(clock.slotDurationMsEstimate()));
    const call = gw.calls.find((c) => c.method === 'getRecentPerformanceSamples');
    assert.equal(call?.o.priority, 4);
    assert.deepEqual(call?.params, [30]);
    clock.stop();
  });
});

describe('B-M15-01 logic and edge cases', () => {
  it('starts from slot_ms_initial and keeps the previous estimate on empty, malformed or failed samples', async () => {
    const { clock, gw, log, time } = setup();
    gw.samples = () => ok([], 'A');
    await clock.start();
    assert.equal(clock.slotDurationMsEstimate(), 267);
    assert.ok(log.events.some((e) => e.code === 'm15.samples_empty' && e.fields.reason === 'empty'));
    gw.samples = () => ok([{ numSlots: 100, samplePeriodSecs: 40 }], 'A');           // 400 ms
    await time.advance(60_000);
    assert.equal(clock.slotDurationMsEstimate(), 400);
    gw.samples = () => ok([{ numSlots: 1, samplePeriodSecs: 60 }], 'A');             // 60 s a slot: not a slot time
    await time.advance(60_000);
    assert.equal(clock.slotDurationMsEstimate(), 400);
    assert.ok(log.events.some((e) => e.code === 'm15.samples_empty' && e.fields.reason === 'invalid'));
    gw.samples = () => fail('E_TIMEOUT');
    await time.advance(60_000);
    assert.equal(clock.slotDurationMsEstimate(), 400);
    clock.stop();
  });

  it('polls the primary at P0 every height_poll_ms, and every 10,000 ms in degraded reads', async () => {
    const { clock, gw, time } = setup();
    await clock.start();
    assert.equal(epochCalls(gw).length, 1);
    assert.deepEqual(epochCalls(gw)[0]?.o, { priority: 0, role: 'read', commitment: 'confirmed', timeoutMs: 1_500, provider: 'A' });
    await time.advance(2_000);
    assert.equal(epochCalls(gw).length, 2);
    gw.gatewayMode = 'degraded_reads';
    await time.advance(2_000);                                       // the timer armed before the switch fires
    assert.equal(epochCalls(gw).length, 3);
    await time.advance(DEGRADED_POLL_MS - 1);
    assert.equal(epochCalls(gw).length, 3);
    await time.advance(1);
    assert.equal(epochCalls(gw).length, 4);
    clock.stop();
    await time.advance(60_000);
    assert.equal(epochCalls(gw).length, 4);
    assert.equal(time.pending(), 0);
  });

  it('edge 1: before any context slot, highest seen is the primary reading; with nothing at all, lag is unknown', async () => {
    const { clock } = setup();
    assert.equal(clock.observationLagSlots(S(1)), LAG_UNKNOWN);
    assert.throws(() => clock.slot(), /no height reading/);
    assert.equal(clock.lastReadingAgeMs(), Infinity);
    await clock.start();
    assert.equal(clock.slot(), 1_000n);
    assert.equal(clock.blockHeight(), 900n);
    assert.equal(clock.highestSeenSlot(), 1_000n);
    assert.equal(clock.observationLagSlots(S(990)), 10);
    clock.stop();
  });

  it('edge 2 (failure injection): after 3 primary timeouts the read leaves the provider to M14, logs the failover, keeps the last good slot', async () => {
    const { clock, gw, log, time } = setup();
    await clock.start();
    const good = time.nowMs();
    gw.epoch = (o) => (o.provider === 'A' ? fail('E_TIMEOUT') : ok({ absoluteSlot: 1_050, blockHeight: 950 }, 'B'));
    await time.advance(6_000);                                       // three failed polls
    assert.equal(clock.slot(), 1_000n);
    assert.equal(clock.lastReadingAgeMs(), time.nowMs() - good);
    assert.equal(log.events.filter((e) => e.code === 'm15.height_failover').length, 1);
    await time.advance(2_000);                                       // the fourth call omits the provider
    const last = epochCalls(gw).at(-1);
    assert.equal(last?.o.provider, undefined);
    assert.equal(clock.slot(), 1_050n);
    assert.equal(clock.lastReadingAgeMs(), 0);
    // M14 routes back to A once it answers: the clock returns to asking A by name.
    gw.epoch = (o) => ok({ absoluteSlot: 1_060, blockHeight: 960 }, o.provider ?? 'A');
    await time.advance(2_000);
    await time.advance(2_000);
    assert.equal(epochCalls(gw).at(-1)?.o.provider, 'A');
    clock.stop();
  });

  it('heightOn refuses an unknown label and a lagging provider without a call, and never mixes providers', async () => {
    const { clock, gw, log, emit } = setup();
    const unknown = await clock.heightOn('Z');
    assert.deepEqual(unknown, { ok: false, error: { code: 'E_PROVIDER_UNKNOWN' } });
    assert.ok(log.events.some((e) => e.code === 'm15.provider_unknown' && e.level === 'warn'));
    emit('A', 1_000); emit('C', 989);
    const lagging = await clock.heightOn('C');
    assert.deepEqual(lagging, { ok: false, error: { code: 'E_PROVIDER_LAGGING' } });
    assert.equal(gw.calls.length, 0);
    gw.epoch = () => ok({ absoluteSlot: 1_001, blockHeight: 1 }, 'A');                 // the gateway answered from A, not B
    assert.deepEqual(await clock.heightOn('B'), { ok: false, error: { code: 'E_RPC' } });
    gw.epoch = () => fail('E_TIMEOUT');
    assert.deepEqual(await clock.heightOn('B'), { ok: false, error: { code: 'E_TIMEOUT' } });
    gw.epoch = () => ok({ absoluteSlot: -1, blockHeight: 1 }, 'B');
    assert.deepEqual(await clock.heightOn('B'), { ok: false, error: { code: 'E_RPC' } });
  });

  it('outlier rule (failure injection): a provider 1,000,000 slots ahead is ignored while another agrees with the old value', () => {
    const { clock, emit, log } = setup();
    emit('A', 1_000); emit('B', 995);
    emit('C', 1_001_000);
    assert.equal(clock.highestSeenSlot(), 1_000n);
    assert.equal(clock.providerSlotLag('C'), null);
    const o = log.events.find((e) => e.code === 'm15.slot_outlier');
    assert.deepEqual(o?.fields, { provider: 'C', context_slot: 1_001_000n, highest_seen_slot: 1_000n, method: 'getAccountInfo' });
    emit('C', 1_002);                                                // within the jump limit: accepted
    assert.equal(clock.highestSeenSlot(), 1_002n);
  });

  it('outlier rule: a jump is accepted when no other provider is within 10 slots of the old value', () => {
    const { clock, emit } = setup();
    emit('A', 1_000); emit('B', 900);
    emit('A', 5_000);
    assert.equal(clock.highestSeenSlot(), 5_000n);
  });

  it('property: over random interleavings, highest seen never falls and is at least every accepted context slot', () => {
    for (let seed = 0; seed < 200; seed++) {
      const rng = createRng(seed);
      const { clock, emit, log } = setup();
      let prev = -1n;
      const accepted: bigint[] = [];
      for (let i = 0; i < 60; i++) {
        const p = ['A', 'B', 'C'][rng.nextU32() % 3] as string;
        const jump = rng.nextFloat() < 0.05 ? 1_000_000 : 0;
        const s = 10_000 + (rng.nextU32() % 500) + jump;
        const before = log.events.length;
        emit(p, s);
        if (log.events.length === before) accepted.push(BigInt(s));
        const h = clock.highestSeenSlot();
        assert.ok(h >= prev, `seed ${seed}: fell from ${prev} to ${h}`);
        prev = h;
      }
      for (const s of accepted) assert.ok(clock.highestSeenSlot() >= s, `seed ${seed}`);
    }
  });

  it('duplicate events are harmless (monotonic max)', () => {
    const { clock, emit } = setup();
    for (let i = 0; i < 5; i++) emit('A', 700);
    assert.equal(clock.highestSeenSlot(), 700n);
    assert.equal(clock.providerSlotLag('A'), 0);
  });

  it('slotTimeBasis dates slots from the primary reading at the measured slot time', async () => {
    const { clock, gw, time } = setup();
    gw.samples = () => ok([{ numSlots: 240, samplePeriodSecs: 60 }], 'A');           // 250 ms
    await clock.start();
    const at = time.nowMs();
    const basis = clock.slotTimeBasis();
    assert.equal(slotToTimeMs(S(1_000), basis), at);
    assert.equal(slotToTimeMs(S(1_100), basis), at + 25_000);
    clock.stop();
  });

  it('metrics: highest_seen_slot, provider_slot_lag, slot_duration_ms_estimate and height_reading_age_ms', async () => {
    const { clock, metrics, emit, gw } = setup();
    gw.samples = () => ok([{ numSlots: 240, samplePeriodSecs: 60 }], 'A');
    await clock.start();
    emit('B', 1_005);
    assert.equal(metrics.gauges.get('highest_seen_slot{}'), 1_005);
    assert.equal(metrics.gauges.get('provider_slot_lag{"provider":"A"}'), 5);
    assert.equal(metrics.gauges.get('slot_duration_ms_estimate{}'), 250);
    assert.equal(metrics.gauges.get('height_reading_age_ms{}'), 0);
    clock.stop();
  });

  it('start is idempotent and stop cancels both loops', async () => {
    const { clock, time } = setup();
    await clock.start();
    await clock.start();
    assert.equal(time.pending(), 2);
    clock.stop();
    assert.equal(time.pending(), 0);
    await flush();
  });

  it('refuses a primary provider M14 does not know', () => {
    const time = new FakeTime();
    assert.throws(() => createSlotClock({ gateway: new FakeGateway(), bus: new Bus(), clock: time, scheduler: time, log: new RecordingLog(),
      metrics: new RecordingMetrics(), settings: SETTINGS, primaryProvider: 'X', providers: ['A'] }), /primary provider/);
  });
});

describe('B-M15-01 fixtures (FX-RPC-EPOCHINFO, FX-RPC-PERFSAMPLES: the official docs examples)', () => {
  it('reads slot and height from one getEpochInfo result', () => {
    assert.deepEqual(parseEpochInfo(FX['FX-RPC-EPOCHINFO']?.response.result), { slot: 166_598n, blockHeight: 166_500n });
    assert.equal(parseEpochInfo({ absoluteSlot: 1 }), null);
    assert.equal(parseEpochInfo({ absoluteSlot: 1.5, blockHeight: 1 }), null);
    assert.deepEqual(parseEpochInfo({ absoluteSlot: 2n ** 60n, blockHeight: 1 }), { slot: 2n ** 60n, blockHeight: 1n });
  });

  it('estimates the slot time from the samples: 120 s over 252 slots', () => {
    const r = slotMsFromSamples(FX['FX-RPC-PERFSAMPLES']?.response.result);
    assert.ok('ms' in r);
    if ('ms' in r) assert.ok(Math.abs(r.ms - 120_000 / 252) < 1e-9);
    assert.deepEqual(slotMsFromSamples('x'), { problem: 'invalid' });
    assert.deepEqual(slotMsFromSamples([{ numSlots: 0, samplePeriodSecs: 60 }]), { problem: 'empty' });
    assert.deepEqual(slotMsFromSamples([{ numSlots: 10, samplePeriodSecs: 0 }]), { problem: 'invalid' });
  });

  it('M14 accepts both calls as the clock makes them, and refuses a second positional parameter', () => {
    assert.equal(prepareParams('getEpochInfo', [], 'read', 'confirmed').ok, true);
    assert.deepEqual(prepareParams('getEpochInfo', [], 'read', 'confirmed'), { ok: true, params: [{ commitment: 'confirmed' }] });
    assert.deepEqual(prepareParams('getRecentPerformanceSamples', [30], 'read', undefined), { ok: true, params: [30] });
    assert.deepEqual(prepareParams('getRecentPerformanceSamples', [30, 1], 'read', undefined), { ok: false, problem: 'bad_params' });
    assert.deepEqual(prepareParams('getRecentPerformanceSamples', [30], 'read', 'confirmed'), { ok: false, problem: 'commitment_not_supported' });
    assert.deepEqual(prepareParams('getHealth', [1], 'read', undefined), { ok: false, problem: 'bad_params' });
  });
});


describe('B-M15-01 config', () => {
  it('registers the four m15 keys with the ticket defaults and ranges, and m15Settings reads them', () => {
    const want: Record<string, [number, string, string]> = {
      'm15.height_poll_ms': [2_000, '400', '10000'], 'm15.height_timeout_ms': [1_500, '200', '5000'],
      'm15.max_future_slot_jump': [2_000, '100', '100000'], 'm15.slot_ms_initial': [267, '100', '1000'],
    };
    for (const [key, [def, min, max]] of Object.entries(want)) {
      const f = CONFIG_FIELDS.find((x) => x.key === key);
      assert.deepEqual([f?.default, f?.min, f?.max, f?.affectsReturns, f?.requiresRestart], [def, min, max, false, false], key);
    }
    const config = { version: 'v', ...Object.fromEntries(Object.entries(want).map(([k, [d]]) => [k, d])) } as unknown as Config;
    assert.deepEqual(m15Settings(config), SETTINGS);
  });
});
