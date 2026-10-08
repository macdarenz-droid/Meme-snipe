// UI-T05 logic: the freshness state machine on the wall and simulation clocks, clock skew, missing timestamps, the
// loading window (acceptances 1 and 2), the stale-action reason (acceptance 3) and the diagnostics text.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { diagnosticsText } from '../src/lib/diagnostics.ts';
import { CLOCK_SKEW_TOLERANCE_MS, VM_THRESHOLDS, blockedReason, freshness, thresholdsFor, type FreshnessInput } from '../src/lib/freshness.ts';
import { LOADING_DELAY_MS, LOADING_MIN_MS, skeletonWindow } from '../src/lib/loading.ts';
import { PACKAGE_DIR } from './tooling/build.ts';

const AS_OF = '2026-10-06T14:02:11.123Z';
const T = Date.parse(AS_OF);
const vm12 = (as_of: string | null, extra: Partial<FreshnessInput> = {}): FreshnessInput => ({ ...thresholdsFor('VM-12'), as_of, clock: 'wall', ...extra });

describe('UI-T05 freshness state machine', () => {
  it('VM-12: live up to 3 s, delayed up to 5 s, stale after (acceptance 3: 6 s is stale)', () => {
    const at = (ms: number): string => freshness(vm12(AS_OF), { nowMs: T + ms, offsetMs: 0 }).state;
    assert.deepEqual([0, 1000, 3000, 3001, 5000, 5001, 6000].map(at), ['live', 'live', 'live', 'delayed', 'delayed', 'stale', 'stale']);
    assert.deepEqual(freshness(vm12(AS_OF), { nowMs: T + 6000, offsetMs: 0 }), { state: 'stale', ageState: 'stale', ageMs: 6000 });
  });

  it('uses the server clock offset, so a wrong local clock cannot make stale data look fresh', () => {
    assert.equal(freshness(vm12(AS_OF), { nowMs: T, offsetMs: 6000 }).state, 'stale');
    assert.equal(freshness(vm12(AS_OF), { nowMs: T + 60000, offsetMs: -59000 }).state, 'live');
  });

  it('Z05 round 2 (red team M1): data ahead of the server clock beyond the tolerance is stale, "clock skew", and reports the skew', () => {
    assert.deepEqual(freshness(vm12(AS_OF), { nowMs: T - 2500, offsetMs: 0 }), { state: 'stale', ageState: 'stale', ageMs: 0, reason: 'clock skew', skewMs: 2500 });
    // An as_of a day ahead never reads as live, however long it waits.
    const ahead = vm12('2026-10-07T14:02:11.123Z');
    for (const wait of [0, 60_000, 3_600_000]) assert.equal(freshness(ahead, { nowMs: T + wait, offsetMs: 0 }).state, 'stale');
  });

  it('a negative age within the skew tolerance (the offset estimate\'s error) counts as 0 and is not reported', () => {
    assert.equal(CLOCK_SKEW_TOLERANCE_MS, 1000);
    assert.deepEqual(freshness(vm12(AS_OF), { nowMs: T - 40, offsetMs: 0 }), { state: 'live', ageState: 'live', ageMs: 0 });
    assert.deepEqual(freshness(vm12(AS_OF), { nowMs: T, offsetMs: -1000 }), { state: 'live', ageState: 'live', ageMs: 0 });
    assert.deepEqual(freshness(vm12(AS_OF), { nowMs: T - 1001, offsetMs: 0 }), { state: 'stale', ageState: 'stale', ageMs: 0, reason: 'clock skew', skewMs: 1001 });
  });

  it('a missing as_of is stale with the reason "no timestamp"', () => {
    assert.deepEqual(freshness(vm12(null), { nowMs: T, offsetMs: 0 }), { state: 'stale', ageState: 'stale', ageMs: null, reason: 'no timestamp' });
  });

  it('a malformed as_of or sim_time is stale with a reason, never a throw (review m5)', () => {
    for (const bad of ['2026-10-07T14:02:11Z', '2026-02-30T00:00:00.000Z', '']) {
      assert.deepEqual(freshness(vm12(bad), { nowMs: T, offsetMs: 0 }), { state: 'stale', ageState: 'stale', ageMs: null, reason: 'invalid timestamp' }, bad);
    }
    assert.deepEqual(freshness(vm12('2026-10-07T14:02:11Z', { disconnected: true }), { nowMs: T, offsetMs: 0 }), { state: 'disconnected', ageState: 'stale', ageMs: null, reason: 'invalid timestamp' });
    const sim = vm12(AS_OF, { clock: 'sim' });
    assert.deepEqual(freshness(sim, { nowMs: T, offsetMs: 0, simTime: '2026-10-07T14:02:11Z' }), { state: 'stale', ageState: 'stale', ageMs: null, reason: 'no simulation time' });
  });

  it('acceptance 4: simulated data ages against sim_clock.sim_time, not the wall clock', () => {
    const replay = JSON.parse(readFileSync(join(PACKAGE_DIR, 'test/fixtures/vm-03/replay-paused.json'), 'utf8')) as { sim_clock: { sim_time: string; paused: boolean } };
    assert.equal(replay.sim_clock.paused, true);
    const sim = vm12('2026-09-30T14:02:10.123Z', { clock: 'sim' });
    for (const wall of [T, T + 3_600_000]) {
      assert.deepEqual(freshness(sim, { nowMs: wall, offsetMs: 0, simTime: replay.sim_clock.sim_time }), { state: 'live', ageState: 'live', ageMs: 1000 });
    }
    assert.deepEqual(freshness(sim, { nowMs: T, offsetMs: 0 }), { state: 'stale', ageState: 'stale', ageMs: null, reason: 'no simulation time' });
    assert.deepEqual(freshness(sim, { nowMs: T, offsetMs: 0, simTime: null }), { state: 'stale', ageState: 'stale', ageMs: null, reason: 'no simulation time' });
  });

  it('disconnected beats paused, which beats the age', () => {
    const clock = { nowMs: T + 60000, offsetMs: 0 };
    assert.equal(freshness(vm12(AS_OF, { paused: true }), clock).state, 'paused');
    assert.equal(freshness(vm12(AS_OF, { paused: true, disconnected: true }), clock).state, 'disconnected');
    assert.equal(freshness(vm12(AS_OF, { paused: false, disconnected: false }), clock).state, 'stale');
  });

  it('Z05 round 2 (red team M2): paused and disconnected keep the age state', () => {
    const old = { nowMs: T + 60000, offsetMs: 0 };
    assert.equal(freshness(vm12(AS_OF, { paused: true }), old).ageState, 'stale');
    assert.equal(freshness(vm12(AS_OF, { disconnected: true }), old).ageState, 'stale');
    assert.equal(freshness(vm12(AS_OF, { paused: true }), { nowMs: T + 1000, offsetMs: 0 }).ageState, 'live');
  });

  it('thresholds come from the DS table; every one is ordered expected <= delayed < stale', () => {
    assert.deepEqual(thresholdsFor('VM-05'), { expected_ms: 1000, delayed_ms: 5000, stale_ms: 10000 });
    for (const [vm, t] of Object.entries(VM_THRESHOLDS)) assert.ok(t.expected_ms <= t.delayed_ms && t.delayed_ms < t.stale_ms, vm);
    assert.throws(() => thresholdsFor('VM-06'), /VM-06 has no freshness thresholds/);
  });

  it('acceptance 3: stale risk data blocks raising a limit with "Risk status is stale"', () => {
    const at = (ms: number, extra: Partial<FreshnessInput> = {}): string | undefined => blockedReason(freshness(vm12(AS_OF, extra), { nowMs: T + ms, offsetMs: 0 }), 'Risk status');
    assert.equal(at(6000), 'Risk status is stale');
    assert.equal(at(4000), undefined);
    assert.equal(at(1000), undefined);
    assert.equal(at(1000, { disconnected: true }), 'Disconnected from bot');
  });

  it('Z05 round 2 (red team M1, M2): clock skew, paused updates and stale data under paused or disconnected all block', () => {
    const at = (ms: number, extra: Partial<FreshnessInput> = {}): string | undefined => blockedReason(freshness(vm12(AS_OF, extra), { nowMs: T + ms, offsetMs: 0 }), 'Risk status');
    assert.equal(at(-2500), 'Risk status is ahead of the server clock');
    assert.equal(at(-2500, { paused: true }), 'Risk status is ahead of the server clock');
    assert.equal(at(-500), undefined, 'within the skew tolerance');
    assert.equal(at(1000, { paused: true }), 'Risk status updates are paused', 'paused always blocks risk-increasing actions');
    assert.equal(at(60000, { paused: true }), 'Risk status updates are paused');
    assert.equal(at(60000, { disconnected: true }), 'Disconnected from bot');
    // Paused while the age is stale is still blocked even if a caller ignores the paused rule: the age state decides.
    const f = freshness(vm12(AS_OF, { paused: true }), { nowMs: T + 60000, offsetMs: 0 });
    assert.equal(blockedReason({ ...f, state: 'live' }, 'Risk status'), 'Risk status is stale');
  });

  it('every VM-12 fixture yields a freshness state', () => {
    const dir = join(PACKAGE_DIR, 'test/fixtures/vm-12');
    const states = readdirSync(dir).sort().map((f) => {
      const vm = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { as_of: string | null };
      return `${f}:${freshness(vm12(vm.as_of), { nowMs: T + 6000, offsetMs: 0 }).state}`;
    });
    assert.deepEqual(states, ['breached.json:stale', 'empty.json:stale', 'happy.json:stale', 'live.json:stale', 'no-timestamp.json:stale', 'nulls.json:stale', 'u64-max.json:stale']);
  });
});

describe('UI-T05 loading window', () => {
  it('acceptance 1: a request that resolves in 150 ms shows no skeleton', () => {
    assert.equal(skeletonWindow(0, 150), null);
    assert.equal(skeletonWindow(1000, 1199), null);
  });
  it('acceptance 2: a request that resolves in 250 ms shows the skeleton from 200 ms to at least 600 ms', () => {
    assert.deepEqual(skeletonWindow(0, 250), { showAt: 200, hideAt: 600 });
    assert.deepEqual(skeletonWindow(0, 200), { showAt: 200, hideAt: 600 });
    assert.deepEqual(skeletonWindow(0, 1000), { showAt: 200, hideAt: 1000 });
    assert.deepEqual([LOADING_DELAY_MS, LOADING_MIN_MS], [200, 400]);
  });
});

describe('UI-T05 diagnostics', () => {
  it('copies only the VM ID, field path, HTTP status, seq, code and message', () => {
    const input = { vm: 'VM-05', field_path: 'positions[3].size_base', http_status: 200, seq: '1842', code: 'E_SCHEMA', message: 'size_base is not a U64Str',
      cookie: '__Host-session=abc', csrf_token: 'tok', headers: { authorization: 'Bearer x' } };
    const text = diagnosticsText(input);
    assert.deepEqual(JSON.parse(text), { vm: 'VM-05', field_path: 'positions[3].size_base', http_status: 200, seq: '1842', code: 'E_SCHEMA', message: 'size_base is not a U64Str' });
    assert.doesNotMatch(text, /session|tok|Bearer/);
  });
  it('drops malformed values and clips long strings', () => {
    assert.deepEqual(JSON.parse(diagnosticsText({ vm: 'VM-12', http_status: 1.5, seq: '01', field_path: null, code: null, message: 'x'.repeat(500) })),
      { vm: 'VM-12', message: `${'x'.repeat(199)}…` });
    assert.deepEqual(JSON.parse(diagnosticsText({ vm: 'VM-12' })), { vm: 'VM-12' });
  });
});
