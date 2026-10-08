// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { Result, UnixMs } from '@bot/types';
import { createRpcClient, type RequestOptions, type RpcClient, type TooLargeInfo } from '../../src/m14/client.ts';
import {
  BACKOFF_MAX_MS, createRpcGateway, DEFAULT_TIMEOUT_MS, type GatewayDeps, MAX_PAUSE_MS, OVERSHOOT_BYTES, OVERSIZED_HOLD_MS,
  STOP_AFTER_LIMITED, STOP_WINDOW_MS, type StopState, type StopStore,
} from '../../src/m14/gateway.ts';
import type { ProviderRegistry } from '../../src/m14/providers.ts';
import { scrubberFor } from '../../src/m14/redact.ts';
import type { CallOptions, CallValue, ProviderConfig, ResolvedProvider, RpcError } from '../../src/m14/types.ts';
import { MAX_TIMER_MS, systemTimers } from '../../src/m14/timers.ts';
import { FakeTime, flush, MemoryStopStore, MockServer, provider, PUBLIC_RPC_LIMITS, RecordingBus, RecordingLog, RecordingMetrics, rpcResult } from './helpers.ts';

type Reply = Result<CallValue<unknown>, RpcError>;
interface Sent { label: string; method: string; at: number; o: RequestOptions }

/** A fake client: records every request with its start time; `answer` decides the reply (instant unless it waits). */
class FakeClient implements RpcClient {
  sent: Sent[] = [];
  inFlight = new Map<string, number>();
  maxInFlight = 0;
  answer: (label: string, method: string, o: RequestOptions) => Reply | Promise<Reply> = okAnswer;
  private readonly time: FakeTime;
  constructor(time: FakeTime) { this.time = time; }
  async request<T>(p: ResolvedProvider, method: string, _params: readonly unknown[], o: RequestOptions): Promise<Result<CallValue<T>, RpcError>> {
    const label = p.config.label;
    this.sent.push({ label, method, at: this.time.now, o });
    const n = (this.inFlight.get(label) ?? 0) + 1;
    this.inFlight.set(label, n);
    this.maxInFlight = Math.max(this.maxInFlight, n);
    try {
      return await this.answer(label, method, o) as Result<CallValue<T>, RpcError>;
    } finally {
      this.inFlight.set(label, (this.inFlight.get(label) as number) - 1);
    }
  }
  to(label: string): Sent[] { return this.sent.filter((s) => s.label === label); }
}
const okAnswer = (label: string): Reply => ({ ok: true, value: { value: label, providerLabel: label, latencyMs: 0, contextSlot: null } });
const limited = (retryAfterMs?: number): Reply => ({ ok: false, error: { code: 'E_RATE_LIMITED', message: 'http_429', httpStatus: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } });

const PRIMARY = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0, limits: { rps: 5 } });
const SECOND = provider({
  label: 'chainstack', failoverOrder: 1, limits: { rps: 10 }, documentedLimits: [{ scope: 'total', count: 25, windowMs: 1_000, fact: 'LD-32' }],
  metering: { unit: 'requests', monthlyAllowance: 3_000_000, methodCost: {} },
});
const THIRD = provider({
  label: 'helius', roles: ['read', 'send'], failoverOrder: 2, limits: { rps: 5, sendRps: 0.5 },
  documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-27' }, { scope: 'send', count: 1, windowMs: 1_000, fact: 'LD-27' }],
  metering: { unit: 'credits', monthlyAllowance: 1_000_000, methodCost: { getProgramAccounts: 10 } },
});
const PUBLIC = provider({ label: 'public', failoverOrder: 3, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 }, documentedLimits: [...PUBLIC_RPC_LIMITS] });

function registry(configs: ProviderConfig[]): ProviderRegistry {
  return { providers: configs.map((config) => ({ config, url: `https://${config.label}.example.test/` })), disabled: [], warnings: [], liveModesAllowed: true };
}

/**
 * A gateway on a fake clock and client. The overshoot allowance is 0 unless a case sets it (the default,
 * OVERSHOOT_BYTES, would leave no room in the 1,000-byte budgets most cases use; the fakes' chunks raise it).
 */
function setup(configs: ProviderConfig[] = [PRIMARY, SECOND, THIRD], over: Partial<GatewayDeps> & { noUsage?: boolean } = {}) {
  const time = new FakeTime();
  const client = new FakeClient(time);
  const log = new RecordingLog();
  const metrics = new RecordingMetrics();
  const { noUsage, ...rest } = over;
  const gw = createRpcGateway({
    registry: registry(configs), context: 'engine', client, clock: time, scheduler: time, log, metrics, stopStore: new MemoryStopStore(),
    overshootBytes: 0, ...(noUsage === true ? {} : { usage: { projectedOver80: () => false } }), ...rest,
  });
  return { time, client, log, metrics, gw };
}

const READ = (priority: CallOptions['priority'], extra: Partial<CallOptions> = {}): CallOptions =>
  ({ priority, role: 'read', commitment: 'confirmed', timeoutMs: DEFAULT_TIMEOUT_MS[priority], ...extra });
const slot = (gw: ReturnType<typeof setup>['gw'], o: CallOptions) => gw.call<string>('getSlot', [], o);

/** Advances the fake clock in 50 ms steps until `p` settles (a call may wait for a token or a pause). */
async function run<T>(time: FakeTime, p: Promise<T>, maxMs = 300_000): Promise<T> {
  let done = false;
  let value: T | undefined;
  void p.then((v) => { done = true; value = v; });
  await flush();
  for (let t = 0; !done && t < maxMs; t += 50) await time.advance(50);
  assert.ok(done, 'the call did not settle');
  return value as T;
}

describe('A-M14-02 priorities and the P0 reserve', () => {
  it('under saturated P2 traffic a P0 call is served within one token interval', async () => {
    const { time, client, gw } = setup();
    const p2 = Array.from({ length: 40 }, () => slot(gw, READ(2)));
    await time.advance(1_000);                                  // P2 now runs at its 80% share of 5/s
    const before = client.to('shyft').length;
    const t0 = time.now;
    const p0 = slot(gw, READ(0));
    await time.advance(200);                                     // one token interval at 5/s
    const r = await p0;
    assert.ok(r.ok && r.value.providerLabel === 'shyft');
    const p0Sent = client.sent.find((s, i) => i >= before && s.o.timeoutMs <= DEFAULT_TIMEOUT_MS[0]);
    assert.ok(p0Sent !== undefined && p0Sent.at - t0 <= 200);
    await time.advance(20_000);
    await Promise.all(p2);
  });

  it('P2 alone uses at most 80% of the bucket; P0 alone may use all of it', async () => {
    const a = setup();
    const p2 = Array.from({ length: 30 }, () => slot(a.gw, READ(2, { timeoutMs: 60_000 })));
    await a.time.advance(10_000);
    assert.ok(a.client.to('shyft').length <= 41, `${a.client.to('shyft').length}`);   // 4/s × 10 s, plus the first
    await a.time.advance(60_000);
    await Promise.all(p2);
    const b = setup();
    const p0 = Array.from({ length: 60 }, () => slot(b.gw, READ(0, { timeoutMs: 60_000 })));
    await b.time.advance(9_999);
    assert.equal(b.client.to('shyft').length, 50);                                    // 5/s × 10 s
    await b.time.advance(60_000);
    await Promise.all(p0);
  });

  it('serves waiting requests highest priority first, FIFO within a priority', async () => {
    const { time, client, gw } = setup([PRIMARY, SECOND]);
    const first = slot(gw, READ(4));                            // takes the token now
    const order: string[] = [];
    const calls = [
      gw.call('getSlot', [], READ(3)).then(() => order.push('P3a')),
      gw.call('getSlot', [], READ(2)).then(() => order.push('P2')),
      gw.call('getSlot', [], READ(3)).then(() => order.push('P3b')),
      gw.call('getSlot', [], READ(1)).then(() => order.push('P1')),
    ];
    await time.advance(5_000);
    await Promise.all([first, ...calls]);
    assert.deepEqual(order, ['P1', 'P2', 'P3a', 'P3b']);
    assert.equal(client.maxInFlight, 1);
  });

  it('a request that cannot get a token before its timeout returns E_RATE_LIMITED', async () => {
    const { time, gw } = setup([PRIMARY, SECOND]);
    const calls = Array.from({ length: 5 }, () => slot(gw, READ(3, { timeoutMs: 300 })));
    await time.advance(400);
    const results = await Promise.all(calls);
    assert.equal(results.filter((r) => r.ok).length, 2);       // at 0 ms and 250 ms (4/s for P3)
    for (const r of results.filter((x) => !x.ok)) assert.deepEqual(r, { ok: false, error: { code: 'E_RATE_LIMITED', message: 'no_token_before_timeout' } });
  });
});

describe('A-M14-02 pinning and failover', () => {
  it('primary 429 for 5 s: P1 succeeds on the secondary; P2 waits or times out on the primary only', async () => {
    const { time, client, metrics, log, gw } = setup();
    client.answer = (label) => (label === 'shyft' && time.now < 1_005_000 ? limited(5_000) : okAnswer(label));
    const first = await run(time, slot(gw, READ(1)));                      // primary answers 429 (Retry-After 5 s) → secondary
    assert.ok(first.ok && first.value.providerLabel === 'chainstack');
    const p1 = await run(time, slot(gw, READ(1)));                         // the primary is paused: the secondary answers at once
    assert.ok(p1.ok && p1.value.providerLabel === 'chainstack');
    const p2short = slot(gw, READ(2, { timeoutMs: 2_000 }));
    const p2long = slot(gw, READ(2, { timeoutMs: 10_000 }));
    await time.advance(2_000);
    assert.deepEqual(await p2short, { ok: false, error: { code: 'E_RATE_LIMITED', message: 'no_token_before_timeout' } });
    await time.advance(4_000);
    const late = await p2long;
    assert.ok(late.ok && late.value.providerLabel === 'shyft');
    assert.equal(client.sent.filter((s) => s.label !== 'shyft').length, 2);   // only the two P1 calls left the primary
    assert.equal(metrics.count('rpc_failover_total', { from: 'shyft', to: 'chainstack' }), 1);
    assert.equal(metrics.count('rpc_429_total', { provider: 'shyft' }), 1);
    assert.deepEqual(log.events.map((e) => e.code), ['m14.provider_paused']);
  });

  it('with o.provider set, no other provider is used even if it fails', async () => {
    const { time, client, gw } = setup();
    client.answer = (label) => (label === 'chainstack' ? { ok: false, error: { code: 'E_HTTP', message: 'http_502', httpStatus: 502 } } : okAnswer(label));
    const r = await run(time, slot(gw, READ(0, { provider: 'chainstack' })));
    assert.deepEqual(r, { ok: false, error: { code: 'E_HTTP', message: 'http_502', httpStatus: 502 } });
    assert.deepEqual(client.sent.map((s) => s.label), ['chainstack']);
    assert.deepEqual(await run(time, slot(gw, READ(0, { provider: 'nope' }))), { ok: false, error: { code: 'E_RPC', message: 'unknown_provider' } });
  });

  it('fails over on timeouts, 5xx, 403 and network errors, not on JSON-RPC errors or other 4xx', async () => {
    const errors: RpcError[] = [
      { code: 'E_TIMEOUT', message: 'timeout' },
      { code: 'E_HTTP', message: 'http_503', httpStatus: 503 },
      { code: 'E_HTTP', message: 'http_403', httpStatus: 403 },
      { code: 'E_HTTP', message: 'network_error' },
    ];
    for (const e of errors) {
      const { time, client, gw } = setup();
      client.answer = (label) => (label === 'shyft' ? { ok: false, error: e } : okAnswer(label));
      const r = await run(time, slot(gw, READ(0)));
      assert.ok(r.ok && r.value.providerLabel === 'chainstack', e.message);
    }
    for (const e of [{ code: 'E_RPC', message: 'x', rpcCode: -32602 }, { code: 'E_HTTP', message: 'http_400', httpStatus: 400 }] as RpcError[]) {
      const { time, client, gw } = setup();
      client.answer = () => ({ ok: false, error: e });
      assert.deepEqual(await run(time, slot(gw, READ(0))), { ok: false, error: e });
      assert.equal(client.sent.length, 1);
    }
  });

  it('all eligible providers failing → E_ALL_PROVIDERS_DOWN', async () => {
    const { time, client, gw } = setup();
    client.answer = () => ({ ok: false, error: { code: 'E_HTTP', message: 'network_error' } });
    assert.deepEqual(await run(time, slot(gw, READ(0))), { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'all_failed:E_HTTP' } });
    assert.deepEqual(client.sent.map((s) => s.label), ['shyft', 'chainstack', 'helius']);
    client.answer = () => limited(2_000);
    const r = await run(time, slot(gw, READ(0)));
    assert.deepEqual(r, { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'all_failed:E_RATE_LIMITED', retryAfterMs: 2_000 } });
  });

  it('stops failing over when the call\'s time is spent', async () => {
    const { time, client, gw } = setup();
    client.answer = async (label) => {
      await new Promise<void>((r) => time.set(r, 1_500));
      return { ok: false, error: { code: 'E_TIMEOUT', message: `timeout ${label}` } };
    };
    const p = slot(gw, READ(1, { timeoutMs: 1_000 }));
    await time.advance(2_000);
    assert.deepEqual(await p, { ok: false, error: { code: 'E_TIMEOUT', message: 'timeout shyft' } });
    assert.equal(client.sent.length, 1);
  });

  it('a P0 call queued behind a slow request on the primary fails over within its timeout', async () => {
    const { time, client, gw } = setup();
    client.answer = async (label) => {
      if (label === 'shyft') await new Promise<void>((r) => time.set(r, 30_000));
      return okAnswer(label);
    };
    const slow = slot(gw, READ(4));
    const t0 = time.now;
    const p0 = slot(gw, READ(0));
    await time.advance(DEFAULT_TIMEOUT_MS[0]);
    const r = await p0;
    assert.ok(r.ok && r.value.providerLabel === 'chainstack');
    const sent = client.to('chainstack')[0];
    // Half of 2 s waiting at the primary; then half of the remaining 1 s at the secondary (one provider is left after it).
    assert.equal(sent?.at, t0 + 1_000);
    assert.equal(sent?.o.timeoutMs, 500);
    await time.advance(30_000);
    assert.ok((await slow).ok);
  });

  it('P2-P4 are pinned to the unmetered primary; P0/P1 try it first', async () => {
    const { time, client, gw } = setup([SECOND, THIRD, PRIMARY]);
    for (const p of [0, 1, 2, 3, 4] as const) assert.ok((await run(time, slot(gw, READ(p)))).ok);
    assert.deepEqual(client.sent.map((s) => s.label), ['shyft', 'shyft', 'shyft', 'shyft', 'shyft']);
    client.answer = (label) => (label === 'shyft' ? { ok: false, error: { code: 'E_HTTP', message: 'network_error' } } : okAnswer(label));
    assert.deepEqual(await run(time, slot(gw, READ(3))), { ok: false, error: { code: 'E_HTTP', message: 'network_error' } });
  });
});

describe('A-M14-02 metered protection, degraded mode and contexts', () => {
  it('without a usage projection, P1-P4 never reach a metered provider (fail closed); P0 may', async () => {
    const { time, client, gw } = setup(undefined, { noUsage: true });
    client.answer = (label) => (label === 'shyft' ? { ok: false, error: { code: 'E_HTTP', message: 'network_error' } } : okAnswer(label));
    assert.deepEqual(await run(time, slot(gw, READ(1))), { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'all_failed:E_HTTP' } });
    const p0 = await run(time, slot(gw, READ(0)));
    assert.ok(p0.ok && p0.value.providerLabel === 'chainstack');
  });

  it('a metered provider projected above 80% is skipped by P1, not by P0', async () => {
    const { time, client, gw } = setup(undefined, { usage: { projectedOver80: (l) => l === 'chainstack' } });
    client.answer = (label) => (label === 'shyft' ? { ok: false, error: { code: 'E_HTTP', message: 'network_error' } } : okAnswer(label));
    const p1 = await run(time, slot(gw, READ(1)));
    assert.ok(p1.ok && p1.value.providerLabel === 'helius');
    const p0 = await run(time, slot(gw, READ(0)));
    assert.ok(p0.ok && p0.value.providerLabel === 'chainstack');
  });

  it('degraded_reads: P2-P4 fail at once; P1 may fail over to metered providers', async () => {
    const { time, client, gw } = setup(undefined, { usage: { projectedOver80: () => true }, mode: () => 'degraded_reads' });
    assert.equal(gw.mode(), 'degraded_reads');
    for (const p of [2, 3, 4] as const) assert.deepEqual(await run(time, slot(gw, READ(p))), { ok: false, error: { code: 'E_RATE_LIMITED', message: 'degraded' } });
    assert.equal(client.sent.length, 0);
    client.answer = (label) => (label === 'shyft' ? { ok: false, error: { code: 'E_HTTP', message: 'network_error' } } : okAnswer(label));
    const p1 = await run(time, slot(gw, READ(1)));
    assert.ok(p1.ok && p1.value.providerLabel === 'chainstack');
  });

  it('the engine never routes to a provider with allowInLivePaths = false; research processes may', async () => {
    const research = { ...PUBLIC, unmeteredPrimary: true, failoverOrder: 0 };
    const e = setup([PRIMARY, SECOND, { ...PUBLIC, failoverOrder: 5 }]);
    e.client.answer = () => ({ ok: false, error: { code: 'E_HTTP', message: 'network_error' } });
    await run(e.time, slot(e.gw, READ(0)));
    assert.ok(!e.client.sent.some((s) => s.label === 'public'));
    const r = setup([research], { context: 'research' });
    assert.ok((await run(r.time, slot(r.gw, READ(4)))).ok);
    assert.deepEqual(r.client.sent.map((s) => s.label), ['public']);
    assert.equal(r.gw.mode(), 'normal');
  });

  it('refuses every send before any request unless rpc.send_enabled is on (default off until M4; review C03-R1-6)', async () => {
    for (const over of [{}, { sendEnabled: false }]) {
      const { client, gw } = setup(undefined, over);
      assert.deepEqual(await gw.call('sendTransaction', ['tx', { encoding: 'base64' }], { priority: 0, role: 'send', timeoutMs: 2_000 }),
        { ok: false, error: { code: 'E_RPC', message: 'send_disabled' } });
      assert.deepEqual(await gw.call('getSlot', [], { priority: 0, role: 'send', timeoutMs: 2_000 }),
        { ok: false, error: { code: 'E_RPC', message: 'send_disabled' } });
      assert.equal(client.sent.length, 0);
    }
  });

  it('with sends enabled, sends go only to send-role providers, without failover', async () => {
    const { client, gw } = setup(undefined, { sendEnabled: true });
    client.answer = () => ({ ok: false, error: { code: 'E_HTTP', message: 'network_error' } });
    const r = await gw.call('sendTransaction', ['tx', { encoding: 'base64' }], { priority: 0, role: 'send', timeoutMs: 2_000 });
    assert.deepEqual(r, { ok: false, error: { code: 'E_HTTP', message: 'network_error' } });
    assert.deepEqual(client.sent.map((s) => s.label), ['helius']);
    const noSend = setup([PRIMARY, SECOND], { sendEnabled: true });
    assert.deepEqual(await noSend.gw.call('sendTransaction', ['tx'], { priority: 0, role: 'send', timeoutMs: 2_000 }),
      { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'no_eligible_provider' } });
  });

  it('refuses bad options and unknown methods before queueing', async () => {
    const { client, gw } = setup();
    assert.deepEqual(await gw.call('getSlot', [], { ...READ(0), priority: 5 as 0 }), { ok: false, error: { code: 'E_RPC', message: 'bad_options' } });
    assert.deepEqual(await gw.call('getSlot', [], { ...READ(0), timeoutMs: 0 }), { ok: false, error: { code: 'E_RPC', message: 'bad_options' } });
    assert.deepEqual(await gw.call('getSlot', [], { ...READ(0), timeoutMs: Number.NaN }), { ok: false, error: { code: 'E_RPC', message: 'bad_options' } });
    assert.deepEqual(await gw.call('requestAirdrop', [], READ(0)), { ok: false, error: { code: 'E_RPC', message: 'unknown_method' } });
    assert.equal(client.sent.length, 0);
    assert.throws(() => setup(undefined, { p0ReserveBps: 500 }), RangeError);
    assert.throws(() => setup(undefined, { p0ReserveBps: 5_001 }), RangeError);
    assert.throws(() => setup(undefined, { p0ReserveBps: 1_500.5 }), RangeError);
  });
});

describe('A-M14-02 429/403 handling (owner rule: Retry-After, back-off, stop after 3)', () => {
  it('pauses for Retry-After or 1 s, doubling up to 60 s, and stops the provider at the third answer', async () => {
    const { time, client, log, gw } = setup([{ ...PRIMARY }, SECOND]);
    client.answer = (label) => (label === 'shyft' ? limited() : okAnswer(label));
    await run(time, slot(gw, READ(1)));                                    // 429 #1 → pause 1 s
    assert.equal(gw.status()[0]?.pausedUntilMs, time.now + 1_000);
    await time.advance(1_000);
    await run(time, slot(gw, READ(1)));                                    // 429 #2 → pause 2 s
    assert.equal(gw.status()[0]?.pausedUntilMs, time.now + 2_000);
    await time.advance(2_000);
    await run(time, slot(gw, READ(1)));                                    // 429 #3 → stopped
    assert.equal(gw.status()[0]?.stopped, true);
    assert.deepEqual(log.events.map((e) => [e.level, e.code]), [['warn', 'm14.provider_paused'], ['warn', 'm14.provider_paused'], ['critical', 'm14.provider_stopped']]);
    const n = client.to('shyft').length;
    await time.advance(120_000);
    const r = await run(time, slot(gw, READ(2)));                          // the stopped primary is never called again
    assert.deepEqual(r, { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'no_eligible_provider' } });
    assert.equal(client.to('shyft').length, n);
    assert.equal(n, STOP_AFTER_LIMITED);
    assert.equal(gw.resumeProvider('shyft'), true);
    assert.equal(gw.resumeProvider('shyft'), false);
    assert.equal(gw.resumeProvider('nope'), false);
    client.answer = okAnswer;
    assert.ok((await run(time, slot(gw, READ(2)))).ok);
    assert.equal(gw.status()[0]?.recentLimited, 0);
  });

  it('counts 429s within ten minutes even with successes between them; older ones drop out', async () => {
    const { time, client, log, gw } = setup([PRIMARY, SECOND]);
    let answers = [limited(), okAnswer('shyft'), limited(), okAnswer('shyft')];
    client.answer = (label) => (label === 'shyft' ? answers.shift() ?? okAnswer(label) : okAnswer(label));
    for (let i = 0; i < 4; i++) await run(time, slot(gw, READ(2, { timeoutMs: 30_000 })));
    assert.equal(gw.status()[0]?.recentLimited, 2);
    await time.advance(STOP_WINDOW_MS);
    assert.equal(gw.status()[0]?.recentLimited, 0);
    answers = [limited()];
    await run(time, slot(gw, READ(2, { timeoutMs: 30_000 })));
    assert.equal(gw.status()[0]?.stopped, false);
    assert.equal(gw.status()[0]?.pausedUntilMs, time.now + 1_000);      // the count restarted: 1 s, not 4 s
    answers = [limited(), limited()];
    await run(time, slot(gw, READ(2, { timeoutMs: 30_000 })));
    await run(time, slot(gw, READ(2, { timeoutMs: 30_000 })));
    assert.equal(gw.status()[0]?.stopped, true);
    assert.equal(log.events.at(-1)?.fields.limited_in_window, 3);
  });

  it('honours a long Retry-After and a 403; the pause is capped at 60 s without Retry-After', async () => {
    const { time, client, gw } = setup([PRIMARY, SECOND]);
    client.answer = (label) => (label === 'shyft' ? { ok: false, error: { code: 'E_HTTP', message: 'http_403', httpStatus: 403, retryAfterMs: 90_000 } } : okAnswer(label));
    await run(time, slot(gw, READ(1)));
    assert.equal(gw.status()[0]?.pausedUntilMs, time.now + 90_000);
    await time.advance(90_000);
    client.answer = okAnswer;
    assert.ok((await run(time, slot(gw, READ(2)))).ok);
    assert.equal(gw.status()[0]?.recentLimited, 1);
    assert.equal(BACKOFF_MAX_MS, 60_000);
  });

  it('counts a rate-limit answer without an HTTP status the same way (status 0 in the log)', async () => {
    const { time, client, log, gw } = setup([PRIMARY, SECOND]);
    client.answer = (label) => (label === 'shyft' ? { ok: false, error: { code: 'E_RATE_LIMITED', message: 'limited' } } : okAnswer(label));
    for (let i = 0; i < 3; i++) await run(time, slot(gw, READ(2, { timeoutMs: 30_000 })));
    assert.deepEqual(log.events.map((e) => [e.code, e.fields.http_status]),
      [['m14.provider_paused', 0], ['m14.provider_paused', 0], ['m14.provider_stopped', 0]]);
  });

  it('a stopped provider fails its queued calls, which fail over', async () => {
    const { time, client, gw } = setup([PRIMARY, SECOND]);
    let n = 0;
    client.answer = (label) => (label === 'shyft' ? (n++ < 3 ? limited() : okAnswer(label)) : okAnswer(label));
    const calls = Array.from({ length: 4 }, () => slot(gw, READ(2, { timeoutMs: 30_000 })));
    await time.advance(30_000);
    const results = await Promise.all(calls);
    assert.equal(gw.status()[0]?.stopped, true);
    assert.deepEqual(results.map((r) => (r.ok ? 'ok' : r.error.message)), ['http_429', 'http_429', 'http_429', 'provider_stopped']);
  });
});

describe('A-M14-02 one request in flight per provider', () => {
  it('never sends a second request to a provider before the first answers', async () => {
    const { time, client, gw } = setup([PRIMARY, SECOND]);
    client.answer = async (label) => {
      await new Promise<void>((r) => time.set(r, 700));
      return okAnswer(label);
    };
    const calls = Array.from({ length: 6 }, () => slot(gw, READ(3, { timeoutMs: 30_000 })));
    await time.advance(10_000);
    assert.equal((await Promise.all(calls)).filter((r) => r.ok).length, 6);
    assert.equal(client.maxInFlight, 1);
    const starts = client.to('shyft').map((s) => s.at);
    for (let i = 1; i < starts.length; i++) assert.ok((starts[i] as number) - (starts[i - 1] as number) >= 700);
  });

  it('a client that throws still frees the provider', async () => {
    const { time, client, gw } = setup([PRIMARY, SECOND]);
    client.answer = () => { throw new Error('bug'); };
    assert.deepEqual(await run(time, slot(gw, READ(2))), { ok: false, error: { code: 'E_HTTP', message: 'internal_error' } });
    client.answer = okAnswer;
    assert.ok((await run(time, slot(gw, READ(2)))).ok);
  });
});

describe('A-M14-02 rate compliance (property)', () => {
  it('requests to a provider never exceed its configured rate (no burst) in any window, total and per method', async () => {
    const methods = ['getSlot', 'getBalance', 'getProgramAccounts', 'getMultipleAccounts'] as const;
    const heavy = { ...PRIMARY, limits: { rps: 5, heavyRps: 1, perMethodRps: 2 }, documentedLimits: [...PUBLIC_RPC_LIMITS] };
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        atMs: fc.integer({ min: 0, max: 5_000 }), priority: fc.constantFrom(0, 1, 2, 3, 4), method: fc.constantFrom(...methods),
        latencyMs: fc.integer({ min: 0, max: 400 }),
      }), { minLength: 1, maxLength: 80 }),
      async (load) => {
        const { time, client, gw } = setup([heavy, SECOND]);
        const latency = new Map<number, number>();
        client.answer = async (label) => {
          const ms = latency.get(client.sent.length - 1) ?? 0;
          if (ms > 0) await new Promise<void>((r) => time.set(r, ms));
          return okAnswer(label);
        };
        const calls: Array<Promise<unknown>> = [];
        const sorted = [...load].sort((a, b) => a.atMs - b.atMs);
        for (const [i, c] of sorted.entries()) {
          await time.advance(c.atMs - (time.now - 1_000_000));
          latency.set(i, c.latencyMs);
          const params = c.method === 'getSlot' ? [] : ['x', { encoding: 'base64' }];
          calls.push(gw.call(c.method, params, { priority: c.priority as CallOptions['priority'], role: 'read', commitment: 'confirmed', timeoutMs: 30_000 }));
        }
        await time.advance(60_000);
        await Promise.all(calls);
        const check = (sent: Sent[], rps: number, windowMs: number): void => {
          const t = sent.map((s) => s.at);
          for (let i = 0; i < t.length; i++) {
            const inWindow = t.filter((x) => x >= (t[i] as number) && x < (t[i] as number) + windowMs).length;
            assert.ok(inWindow <= Math.ceil((rps * windowMs) / 1000), `${inWindow} > ${rps}/s in ${windowMs} ms`);
          }
        };
        const shyft = client.to('shyft');
        check(shyft, 5, 1_000);
        check(shyft, 5, 10_000);                                   // ≤ 50 per 10 s: half of 100 [LD-26]
        for (const m of methods) check(shyft.filter((s) => s.method === m), 2, 10_000);   // ≤ 20 per 10 s: half of 40
        check(shyft.filter((s) => s.method === 'getProgramAccounts'), 1, 1_000);
        check(client.to('chainstack'), 10, 1_000);
        assert.equal(client.maxInFlight, 1);
      },
    ), { numRuns: 40 });
  });
});

describe('A-M14-02 with the real client', () => {
  it('a 429 with Retry-After from the server pauses that provider; metrics count queue, wait and 429', async () => {
    const time = new FakeTime();
    const server = new MockServer();
    const reg = registry([PRIMARY, SECOND]);
    const metrics = new RecordingMetrics();
    const client = createRpcClient({ fetch: server.fetch, clock: time, scheduler: time, bus: new RecordingBus(), metrics, scrub: scrubberFor(reg.providers.map((p) => p.url)) });
    const gw = createRpcGateway({ registry: reg, context: 'engine', client, clock: time, scheduler: time, log: new RecordingLog(), metrics, stopStore: new MemoryStopStore() });
    server.route('https://shyft.example.test/', () => new Response('', { status: 429, headers: { 'retry-after': '3' } }));
    server.route('https://chainstack.example.test/', rpcResult(7));
    assert.deepEqual(await run(time, slot(gw, READ(2))), { ok: false, error: { code: 'E_RATE_LIMITED', message: 'http_429', httpStatus: 429, retryAfterMs: 3_000 } });
    const p = slot(gw, READ(2, { timeoutMs: 10_000 }));
    await time.advance(2_999);
    assert.equal(server.seen.length, 1);
    server.route('https://shyft.example.test/', rpcResult(8));
    await time.advance(1);
    const r = await p;
    assert.ok(r.ok && (r.value.value as unknown) === 8);
    assert.equal(metrics.count('rpc_429_total', { provider: 'shyft' }), 1);
    assert.ok(metrics.observations.some((o) => o.name === 'rpc_wait_ms' && o.labels.priority === 'P2' && o.value === 3_000));
    assert.equal(metrics.gauges.get('rpc_queue_depth{"provider":"shyft","priority":"P2"}'), 0);
  });

  it('a connection lost while reading the body fails a P0 read over to the secondary (review C03-R1-2)', async () => {
    const time = new FakeTime();
    const server = new MockServer();
    const reg = registry([PRIMARY, SECOND]);
    const client = createRpcClient({ fetch: server.fetch, clock: time, scheduler: time, bus: new RecordingBus(), metrics: new RecordingMetrics(), scrub: scrubberFor(reg.providers.map((p) => p.url)) });
    const metrics = new RecordingMetrics();
    const gw = createRpcGateway({ registry: reg, context: 'engine', client, clock: time, scheduler: time, log: new RecordingLog(), metrics, stopStore: new MemoryStopStore() });
    // Headers arrive (200), then the body stream breaks.
    server.route('https://shyft.example.test/', () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"res')); c.error(new TypeError('socket hang up')); },
    }), { status: 200 }));
    server.route('https://chainstack.example.test/', rpcResult(9));
    const r = await run(time, slot(gw, READ(0)));
    assert.ok(r.ok && r.value.providerLabel === 'chainstack' && (r.value.value as unknown) === 9, JSON.stringify(r));
    assert.deepEqual(server.seen.map((s) => s.url), ['https://shyft.example.test/', 'https://chainstack.example.test/']);
    assert.equal(metrics.count('rpc_failover_total', { from: 'shyft', to: 'chainstack' }), 1);
  });

  it('system timers run and cancel Node timers on the given monotonic clock', async () => {
    let fired = 0;
    const timers = systemTimers(() => 42);
    assert.equal(timers.nowMs(), 42);
    timers.set(() => { fired++; }, 1);
    const cancel = timers.set(() => { fired += 10; }, 1);
    cancel();
    await new Promise<void>((r) => setTimeout(r, 20));
    await flush();
    assert.equal(fired, 1);
  });
});

/** Yields to the timers phase: if synchronous work overran the test's `timeout`, the runner's timer fires first. */
const yieldToTimers = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 1); });

describe('review C03 round 4: queue, bytes, clocks and stops', () => {
  it('queues a 50,000-call P4 burst without stalling the event loop; P0 still goes first; the rest expire (R1)', { timeout: 20_000 }, async () => {
    const { time, client, gw, metrics } = setup([PRIMARY, SECOND], { maxQueued: 50_000 });
    let release = (): void => undefined;
    client.answer = (label) => new Promise<Reply>((r) => { release = () => { r(okAnswer(label)); }; });
    const first = slot(gw, READ(4));
    await flush();
    const burst = Array.from({ length: 50_000 }, () => slot(gw, READ(4)));
    const p0 = slot(gw, READ(0));
    await yieldToTimers();
    assert.deepEqual(await slot(gw, READ(4)), { ok: false, error: { code: 'E_RATE_LIMITED', message: 'queue_full' } });
    assert.equal(gw.status()[0]?.queued, 50_001);
    assert.equal(metrics.gauges.get('rpc_queue_depth{"provider":"shyft","priority":"P4"}'), 50_000);
    client.answer = okAnswer;
    release();
    assert.ok((await run(time, p0)).ok);
    assert.ok((client.sent[1]?.o.timeoutMs as number) <= DEFAULT_TIMEOUT_MS[0]);      // P0 was the next request sent
    assert.ok((await first).ok);
    await time.advance(DEFAULT_TIMEOUT_MS[4]);
    const results = await Promise.all(burst);
    const served = results.filter((r) => r.ok).length;
    const expired = results.filter((r) => !r.ok && r.error.message === 'no_token_before_timeout').length;
    assert.equal(served + expired, 50_000);
    assert.ok(served >= 100 && served <= 125, `${served}`);                             // P4 at 80% of 5/s for 30 s
    assert.equal(gw.status()[0]?.queued, 0);
    assert.equal(metrics.gauges.get('rpc_queue_depth{"provider":"shyft","priority":"P4"}'), 0);
    await yieldToTimers();
  });

  it('keeps FIFO order across methods within a priority (per-method queues, R1)', async () => {
    const { time, client, gw } = setup([PRIMARY, SECOND]);
    let release = (): void => undefined;
    client.answer = (label) => new Promise<Reply>((r) => { release = () => { r(okAnswer(label)); }; });
    const calls = [slot(gw, READ(2))];                                       // in flight; its method's queue exists first
    await flush();
    calls.push(gw.call('getBalance', ['pk'], READ(2)), slot(gw, READ(2)));   // heads: getSlot seq 3, getBalance seq 2
    client.answer = okAnswer;
    release();
    await run(time, Promise.all(calls));
    assert.deepEqual(client.sent.map((x) => x.method), ['getSlot', 'getBalance', 'getSlot']);
  });

  it('a full queue answers queue_full at once, per priority, and a P1 read fails over (R1)', async () => {
    const { time, client, gw } = setup([PRIMARY, SECOND], { maxQueued: 2 });
    client.answer = (label) => (label === 'shyft' ? new Promise<Reply>(() => undefined) : okAnswer(label));
    void slot(gw, READ(2, { timeoutMs: 30_000 }));                                      // in flight, never answered
    await flush();
    const queued = [slot(gw, READ(2, { timeoutMs: 30_000 })), slot(gw, READ(2, { timeoutMs: 30_000 }))];
    assert.deepEqual(await slot(gw, READ(2)), { ok: false, error: { code: 'E_RATE_LIMITED', message: 'queue_full' } });
    const p1 = [slot(gw, READ(1)), slot(gw, READ(1))];                                // the P1 queue is separate
    const third = await slot(gw, READ(1));
    assert.ok(third.ok && third.value.providerLabel === 'chainstack');
    for (const r of await run(time, Promise.all(p1))) assert.ok(r.ok && r.value.providerLabel === 'chainstack');
    await time.advance(30_000);
    for (const r of await Promise.all(queued)) assert.deepEqual(r, { ok: false, error: { code: 'E_RATE_LIMITED', message: 'no_token_before_timeout' } });
    assert.throws(() => setup(undefined, { maxQueued: 0 }), RangeError);
  });

  it('meters response bytes against half of a documented byte limit: no 30 s window above 50 MB, no read cut once the size is known (R3, LD-26, R6-1)', async () => {
    const pub = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 },
      documentedLimits: [...PUBLIC_RPC_LIMITS, { scope: 'bytes', count: 100_000_000, windowMs: 30_000, fact: 'LD-26' }] });
    const { time, client, gw } = setup([pub], { context: 'research' });
    const BLOCK = 3_710_000;                                // one live getBlock answer, 2026-10-07 (review C03 R3)
    const CHUNK = 65_536;                                   // the client stops at the chunk that crosses the budget
    const got: Array<{ at: number; bytes: number }> = [];
    client.answer = (label, _m, o) => {
      const room = o.byteBudget as number;
      const bytes = BLOCK > room ? Math.min(BLOCK, room + CHUNK) : BLOCK;
      got.push({ at: time.now, bytes });
      o.onBytes?.(bytes);
      return BLOCK > room ? { ok: false, error: { code: 'E_HTTP', message: 'too_large', httpStatus: 200 } } : okAnswer(label);
    };
    // Callers retry each byte_budget refusal after its retryAfterMs (nothing waits inside the gateway; R6-1).
    const calls = Array.from({ length: 60 }, () => untilServed(time, () => gw.call('getBlock', [1n, { encoding: 'json' }], READ(4, { timeoutMs: 120_000 }))));
    await time.advance(300_000);
    const results = await Promise.all(calls);
    assert.ok(results.every((x) => x.r.ok));
    assert.ok(results.some((x) => x.refusals > 0));
    assert.ok(got.every((g) => g.bytes === BLOCK));         // the size is known after the first answer: no read is cut
    for (const g of got) {
      const inWindow = got.filter((x) => x.at > g.at - 30_000 && x.at <= g.at);
      assert.ok(inWindow.length <= 13, `${inWindow.length} answers in the 30 s before ${g.at}`);   // 13 × 3.71 MB = 48.2 MB
    }
  });

  it('a byte budget refuses a call at once until enough bytes leave the window, and compacts its log (R3, R6-1)', async () => {
    const small = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0, limits: { rps: 5 },
      documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-33' }, { scope: 'bytes', count: 2_000, windowMs: 10_000, fact: 'test' }] });
    const { time, client, gw } = setup([small, SECOND]);
    const sizes = [1, 5_000];
    const budgets: number[] = [];
    client.answer = (label, _m, o) => {
      budgets.push(o.byteBudget as number);
      const size = sizes.shift() ?? 100;
      const bytes = size > (o.byteBudget as number) ? (o.byteBudget as number) + 200 : size;
      o.onBytes?.(bytes);
      return size > bytes ? { ok: false, error: { code: 'E_HTTP', message: 'too_large', httpStatus: 200 } } : okAnswer(label);
    };
    assert.ok((await run(time, slot(gw, READ(2)))).ok);
    // Another method reads past the budget (1,099 bytes), so getSlot is not held to a probe afterwards (red team R5-1).
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), { ok: false, error: { code: 'E_HTTP', message: 'too_large', httpStatus: 200 } });
    // Both reads are of unknown size: each keeps 10% of the budget for other methods (supervisor ruling 2, R9-1).
    assert.deepEqual(budgets, [900, 899]);
    // The window now holds 1 + 1,099 bytes: a getSlot (need 1) is refused at once until both leave.
    const tB = client.to('shyft').at(-1)?.at as number;
    const t0 = time.now;
    assert.deepEqual(await run(time, slot(gw, READ(2, { timeoutMs: 30_000 }))),
      { ok: false, error: { code: 'E_RATE_LIMITED', message: 'byte_budget', retryAfterMs: tB + 10_000 - t0 } });
    assert.equal(client.to('shyft').length, 2);
    await time.advance(tB + 10_000 - time.now);
    assert.ok((await run(time, slot(gw, READ(2)))).ok);
    // 100-byte answers from callers that retry after retryAfterMs: ten per 10 s window, over 200 s (the log drops old
    // entries as it goes).
    const later = Array.from({ length: 200 }, () => untilServed(time, () => slot(gw, READ(4, { timeoutMs: 300_000 }))));
    await time.advance(200_000);
    const sent = client.to('shyft').slice(3).map((x) => x.at);
    for (const at of sent) assert.ok(sent.filter((x) => x > at - 10_000 && x <= at).length <= 10);
    assert.ok(sent.length >= 190, `${sent.length}`);
    await time.advance(100_000);
    assert.equal((await Promise.all(later)).filter((x) => x.r.ok).length, 200);
  });

  it('pacing, pauses, deadlines and the stop window run on the monotonic clock: wall-clock steps change nothing (R5)', async () => {
    let wallOffset = 0;
    const s = setup([PRIMARY, SECOND], { clock: { kind: 'wall', nowMs: () => (s.time.now + wallOffset) as UnixMs } });
    assert.ok((await run(s.time, slot(s.gw, READ(2)))).ok);
    wallOffset = -3_600_000;                                // NTP steps the wall clock back an hour
    const four = await run(s.time, Promise.all(Array.from({ length: 4 }, () => slot(s.gw, READ(2)))));
    assert.ok(four.every((r) => r.ok));
    s.client.answer = (label) => (label === 'shyft' ? limited(5_000) : okAnswer(label));
    await run(s.time, slot(s.gw, READ(2)));
    const limitedAt = s.time.now;
    s.client.answer = okAnswer;
    wallOffset = 7_200_000;                                 // and forward two hours
    assert.equal(s.gw.status()[0]?.recentLimited, 1);
    assert.ok((await run(s.time, slot(s.gw, READ(2, { timeoutMs: 30_000 })))).ok);
    assert.ok((s.client.to('shyft').at(-1)?.at as number) >= limitedAt + 5_000);      // the Retry-After pause held
  });

  it('a Retry-After longer than 10 minutes stops the provider with the critical log (R6)', async () => {
    const { time, client, log, gw } = setup([PRIMARY, SECOND]);
    client.answer = async (label) => {
      await new Promise<void>((r) => time.set(r, 100));
      return label === 'shyft' ? limited(99_999_999_999_000) : okAnswer(label);
    };
    const first = slot(gw, READ(2));
    const queued = slot(gw, READ(2));                                       // waits behind it, with a wake timer set
    assert.deepEqual(await run(time, first), limited(99_999_999_999_000));
    assert.deepEqual(await queued, { ok: false, error: { code: 'E_RATE_LIMITED', message: 'provider_stopped' } });
    assert.equal(time.pending(), 0);
    assert.equal(gw.status()[0]?.stopped, true);
    assert.equal(gw.status()[0]?.pausedUntilMs, time.now + MAX_PAUSE_MS);
    assert.deepEqual(log.events.map((e) => [e.level, e.code, e.fields.reason]), [['critical', 'm14.provider_stopped', 'retry_after_too_long']]);
    assert.equal(log.events[0]?.fields.retry_after_ms, 99_999_999_999_000);
    const edge = setup([PRIMARY, SECOND]);                  // exactly 10 minutes is still a pause
    edge.client.answer = (label) => (label === 'shyft' ? limited(MAX_PAUSE_MS) : okAnswer(label));
    await run(edge.time, slot(edge.gw, READ(2)));
    assert.equal(edge.gw.status()[0]?.stopped, false);
    assert.deepEqual(edge.log.events.map((e) => [e.code, e.fields.pause_ms]), [['m14.provider_paused', MAX_PAUSE_MS]]);
  });

  it('refuses a timeout Node timers cannot keep (above 2^31 − 1 ms) as bad_options (R7)', async () => {
    const { time, client, gw } = setup();
    assert.deepEqual(await gw.call('getSlot', [], READ(4, { timeoutMs: 3e9 })), { ok: false, error: { code: 'E_RPC', message: 'bad_options' } });
    assert.equal(client.sent.length, 0);
    assert.ok((await run(time, slot(gw, READ(4, { timeoutMs: MAX_TIMER_MS })))).ok);
  });

  it('a stop survives a restart through the StopStore; resume clears it (R8)', async () => {
    const store = new MemoryStopStore();
    store.stopped = [{ label: 'gone', stoppedAtMs: 1, reason: 'rate_limited' }];        // a provider this process lacks
    const a = setup([PRIMARY, SECOND], { stopStore: store });
    a.client.answer = (label) => (label === 'shyft' ? limited() : okAnswer(label));
    for (let i = 0; i < 3; i++) await run(a.time, slot(a.gw, READ(2, { timeoutMs: 30_000 })));
    assert.deepEqual(store.stopped, [{ label: 'gone', stoppedAtMs: 1, reason: 'rate_limited' }, { label: 'shyft', stoppedAtMs: a.time.now, reason: 'rate_limited' }]);
    // The process restarts: a fresh monotonic clock; wall time runs on from a's (the stored 4 s pause still holds).
    const b = setup([PRIMARY, SECOND], { stopStore: store, clock: { kind: 'wall', nowMs: () => a.time.now as UnixMs } });
    assert.deepEqual(b.log.events.map((e) => [e.level, e.code, e.fields.provider, e.fields.restored]), [['critical', 'm14.provider_stopped', 'shyft', true]]);
    assert.equal(b.gw.status()[0]?.stopped, true);
    assert.deepEqual(await run(b.time, slot(b.gw, READ(2))), { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'no_eligible_provider' } });
    assert.equal(b.client.to('shyft').length, 0);
    assert.equal(b.gw.resumeProvider('shyft'), true);                                   // the operator resumes it
    assert.deepEqual(store.stopped.map((x) => x.label), ['gone']);
    assert.ok((await run(b.time, slot(b.gw, READ(2)))).ok);
  });

  it('a StopStore that cannot save logs m14.stop_store_failed; the stop still holds (R8)', async () => {
    const failing: StopStore = { load: () => ({ stopped: [], recent: [] }), save: () => { throw new Error('disk full'); } };
    const { time, client, log, gw } = setup([PRIMARY, SECOND], { stopStore: failing });
    client.answer = (label) => (label === 'shyft' ? limited() : okAnswer(label));
    for (let i = 0; i < 3; i++) await run(time, slot(gw, READ(2, { timeoutMs: 30_000 })));
    assert.deepEqual(log.events.slice(-2).map((e) => [e.level, e.code]), [['critical', 'm14.provider_stopped'], ['error', 'm14.stop_store_failed']]);
    assert.equal(gw.status()[0]?.stopped, true);
  });
});

const TOO_LARGE: Reply = { ok: false, error: { code: 'E_HTTP', message: 'too_large', httpStatus: 200 } };
/** What the client tells of a too_large answer refused on its declared length (nothing read). */
const declaredLen = (n: number): TooLargeInfo => ({ atLeastBytes: n, declared: true, overOwnCap: false });
/** What the client tells of a too_large answer cut by the byte budget after `n` bytes (no Content-Length). */
const cutAfter = (n: number): TooLargeInfo => ({ atLeastBytes: n, declared: false, overOwnCap: false });
/** A byte_budget refusal. */
const byteBudget = (retryAfterMs: number): Reply => ({ ok: false, error: { code: 'E_RATE_LIMITED', message: 'byte_budget', retryAfterMs } });
/** A byte limit of 2,000 per 10 s: a budget of 1,000 bytes. */
const BYTES_2K = { scope: 'bytes', count: 2_000, windowMs: 10_000, fact: 'test' } as const;

/** Calls until the call is not refused for bytes, waiting each `byte_budget` refusal's retryAfterMs on the fake clock. */
async function untilServed(time: FakeTime, call: () => Promise<Reply>): Promise<{ r: Reply; refusals: number }> {
  for (let refusals = 0; ; refusals += 1) {
    const r = await call();
    if (r.ok || r.error.message !== 'byte_budget') return { r, refusals };
    await new Promise<void>((resolve) => { time.set(resolve, r.error.retryAfterMs as number); });
  }
}

/** Processes that restart one after another on one StopStore: each has a fresh monotonic clock; wall time runs on. */
function restarts(store: MemoryStopStore) {
  let wallBase = 1_700_000_000_000;
  let current: FakeTime | null = null;
  const clock: GatewayDeps['clock'] = { kind: 'wall', nowMs: () => (wallBase + (current === null ? 0 : current.now - 1_000_000)) as UnixMs };
  return (gapMs: number) => {
    if (current !== null) wallBase += current.now - 1_000_000 + gapMs;
    current = null;
    const s = setup([PRIMARY, SECOND], { stopStore: store, clock });
    current = s.time;
    return { ...s, wall: () => clock.nowMs() as number };
  };
}

describe('review C03 round 5: byte starvation, host names, raw query values, restarts', () => {
  it('one too_large of unknown size: the method sends nothing until room for its need or its hold ends, then succeeds; other traffic is refused at once only while the window is full (N1, R6-1, R8-1)', async () => {
    const pub = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 },
      documentedLimits: [...PUBLIC_RPC_LIMITS, BYTES_2K] });
    const { time, client, gw } = setup([pub], { context: 'research' });
    let first = true;
    client.answer = (label, method, o) => {
      if (method === 'getBalance' && first) { first = false; o.onBytes?.((o.byteBudget as number) + 1); return TOO_LARGE; }
      o.onBytes?.(method === 'getBalance' ? 8 : 10);
      return okAnswer(label);
    };
    const slots: Array<Promise<Reply>> = [];
    const traffic = async (ms: number): Promise<void> => {
      for (let k = 0; k < ms / 500; k++) { slots.push(slot(gw, READ(4, { timeoutMs: 2_000 }))); await time.advance(500); }
    };
    await traffic(10_000);
    const r1 = gw.call('getBalance', ['pk'], READ(4));
    await time.advance(1_000);
    assert.deepEqual(await r1, TOO_LARGE);                   // it read all the room left and a byte: it needs an empty window now
    const balances = (): Sent[] => client.sent.filter((s) => s.method === 'getBalance');
    const tH = balances()[0]?.at as number;
    // getSlot traffic never empties the window, so getBalance sends nothing until its hold ends (no probe; R8-1). The
    // caller retries after each retryAfterMs (when the window could have room, or the end of the hold).
    const firstOk = untilServed(time, () => gw.call('getBalance', ['pk'], READ(4)));
    await traffic(OVERSIZED_HOLD_MS + 10_000);
    const { r, refusals } = await firstOk;
    assert.ok(r.ok);
    assert.ok(refusals >= 50, `${refusals}`);
    const at = balances().map((s) => s.at);
    assert.equal(at.length, 2);
    assert.ok((at[1] as number) >= tH + OVERSIZED_HOLD_MS && (at[1] as number) < tH + OVERSIZED_HOLD_MS + 1_000, `${(at[1] as number) - tH}`);
    // Its need is now its 8-byte answer: later calls go at once.
    for (let i = 0; i < 19; i++) {
      const t = time.now;
      const bal = untilServed(time, () => gw.call('getBalance', ['pk'], READ(4)));
      await traffic(30_000);
      const x = await bal;
      assert.ok(x.r.ok && x.refusals === 0, `getBalance ${i}`);
      assert.ok((balances().at(-1)?.at as number) - t <= 500);
    }
    await time.advance(2_000);
    // getSlot at P4 may use 80% of 2/s: about 1,900 of the 2,380 in these 1,190 s; the rest expire. It is held by
    // nothing: it fails at once only until older answers leave the window the cut read filled.
    const all = await Promise.all(slots);
    const okSlots = all.filter((x) => x.ok).length;
    assert.ok(okSlots >= 1_895, `${okSlots}/${all.length}`);
    assert.ok(all.filter((x) => !x.ok && x.error.message === 'byte_budget').length <= 10);
    assert.ok(all.every((x) => x.ok || x.error.message === 'byte_budget' || x.error.message === 'no_token_before_timeout'));
  });

  it('after too_large a method is refused at once until there is room for twice the bytes read, or for the declared length (N1, R6-1)', async () => {
    const small = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0, limits: { rps: 5 },
      documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-33' }, BYTES_2K] });
    type Step = number | 'read' | 'declared';
    // 'read' after 100 bytes: 701 bytes read of an answer without a length, its cap 700 (900 left minus a reserve of
    // 200, twice the other method's answer; ruling 2). It needs twice that, at most an empty window's room (899: 900
    // minus the 1-byte overshoot seen), so room comes when both answers leave; then it goes with 899.
    // 'declared' after 300 and 30 bytes: refused on a length of 700 with a cap of 70 (670 left minus a reserve of 600,
    // twice the first answer; ruling 2), so it needs 700: room when the 300 leave; then all 970 left, as its size is known.
    const cases: Array<{ steps: Step[]; cap: number; freeAfter: 't0' | 'cut'; lastBudget: number }> = [
      { steps: [100, 'read', 50], cap: 700, freeAfter: 'cut', lastBudget: 899 },
      { steps: [300, 30, 'declared', 50], cap: 70, freeAfter: 't0', lastBudget: 970 },
    ];
    for (const { steps, cap, freeAfter, lastBudget } of cases) {
      const { time, client, gw } = setup([small, SECOND]);
      const given: number[] = [];
      client.answer = (label, _m, o) => {
        const s = steps.shift() ?? 50;
        given.push(o.byteBudget as number);
        if (s === 'read') { o.onBytes?.((o.byteBudget as number) + 1); return TOO_LARGE; }
        if (s === 'declared') { o.onTooLarge?.(declaredLen(700)); return TOO_LARGE; }
        o.onBytes?.(s);
        return okAnswer(label);
      };
      assert.ok((await run(time, slot(gw, READ(2)))).ok);                  // 100 or 300 bytes at t0
      const t0 = client.to('shyft').at(-1)?.at as number;
      await time.advance(3_000);
      if (steps[0] === 30) assert.ok((await run(time, gw.call('getBlockHeight', [], READ(2)))).ok);   // 30 bytes
      assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);
      assert.equal(given.at(-1), cap);
      const tCut = client.to('shyft').at(-1)?.at as number;
      const sent = client.to('shyft').length;
      const t1 = time.now;
      const free = (freeAfter === 't0' ? t0 : tCut) + 10_000;
      assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2, { timeoutMs: 30_000 }))),
        { ok: false, error: { code: 'E_RATE_LIMITED', message: 'byte_budget', retryAfterMs: free - t1 } });
      assert.equal(client.to('shyft').length, sent);                       // refused before any request
      await time.advance(free - time.now);
      assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);
      assert.equal(given.at(-1), lastBudget);
    }
  });

  it('rate-limit answers and their pause survive restarts: a crash loop still stops at the third answer (N4)', async () => {
    const store = new MemoryStopStore();
    const next = restarts(store);
    const a = next(0);
    a.client.answer = (label) => (label === 'shyft' ? limited(5_000) : okAnswer(label));
    assert.deepEqual(await run(a.time, slot(a.gw, READ(2))), limited(5_000));
    assert.deepEqual(store.recent, [{ label: 'shyft', limitedAtMs: [a.wall()], pausedUntilMs: a.wall() + 5_000 }]);
    const b = next(1_000);                                       // the process dies and restarts one second later
    assert.equal(b.gw.status()[0]?.recentLimited, 1);
    assert.equal(b.gw.status()[0]?.pausedUntilMs, b.time.now + 4_000);
    b.client.answer = a.client.answer;
    assert.deepEqual(await run(b.time, slot(b.gw, READ(2, { timeoutMs: 30_000 }))), limited(5_000));
    assert.equal(b.client.to('shyft')[0]?.at, 1_000_000 + 4_000);   // the Retry-After pause held across the restart
    const c = next(1_000);
    c.client.answer = a.client.answer;
    assert.deepEqual(await run(c.time, slot(c.gw, READ(2, { timeoutMs: 30_000 }))), limited(5_000));
    assert.equal(c.gw.status()[0]?.stopped, true);
    assert.deepEqual(c.log.events.map((e) => [e.level, e.code, e.fields.limited_in_window]), [['critical', 'm14.provider_stopped', 3]]);
    assert.deepEqual(store.stopped.map((x) => x.label), ['shyft']);
  });

  it('restores stored answers by age: older than ten minutes dropped, ahead of the clock counted now, pause capped (N4)', () => {
    const store = new MemoryStopStore();
    const wall = 1_700_000_000_000;
    const gone = { label: 'gone', limitedAtMs: [wall], pausedUntilMs: 0 };       // a provider this process lacks: kept
    store.stopped = [{ label: 'chainstack', stoppedAtMs: wall, reason: 'rate_limited' }];
    store.recent = [
      { label: 'shyft', limitedAtMs: [wall - STOP_WINDOW_MS - 1, wall - 60_000, Number.NaN], pausedUntilMs: wall - 1 },  // the pause ended
      { label: 'chainstack', limitedAtMs: [wall + 3_600_000], pausedUntilMs: Number.POSITIVE_INFINITY },   // the wall clock stepped back
      gone,
    ];
    const { time, gw } = setup([PRIMARY, SECOND], { stopStore: store, clock: { kind: 'wall', nowMs: () => wall as UnixMs } });
    assert.deepEqual(gw.status().map((s) => [s.label, s.recentLimited, s.pausedUntilMs - time.now]),
      [['shyft', 1, Number.NEGATIVE_INFINITY], ['chainstack', 1, MAX_PAUSE_MS]]);
    assert.equal(gw.resumeProvider('chainstack'), true);        // saves; the resume clears the answers, not the pause
    assert.deepEqual(store.recent, [gone, { label: 'shyft', limitedAtMs: [wall - 60_000], pausedUntilMs: 0 },
      { label: 'chainstack', limitedAtMs: [], pausedUntilMs: wall + MAX_PAUSE_MS }]);
    const nan = setup([PRIMARY, SECOND], { stopStore: { load: () => ({ stopped: [], recent: [{ label: 'shyft', limitedAtMs: [], pausedUntilMs: Number.NaN }] }), save: () => undefined } });
    assert.equal(nan.gw.status()[0]?.pausedUntilMs, Number.NEGATIVE_INFINITY);   // a NaN pause end is no pause
  });
});

describe('red team C03 round 3: oversized answers and the stop store', () => {
  const small = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0, limits: { rps: 5 },
    documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-33' }, BYTES_2K] });

  it('a method known above a whole budget sends nothing and fails at once until its hold ends; then one request goes with the room left (R3-1, R5-1, R8-1)', async () => {
    const { time, client, gw } = setup([small, SECOND]);
    const sizes: Record<string, number> = { getBalance: 5_000, getSlot: 300, getBlockHeight: 695 };
    client.answer = (label, method, o) => {
      const n = sizes[method] as number;
      if (n > (o.byteBudget as number)) { o.onTooLarge?.(declaredLen(n)); return TOO_LARGE; }   // refused on its length
      o.onBytes?.(n);
      return okAnswer(label);
    };
    assert.ok((await run(time, slot(gw, READ(2)))).ok);                                    // 300 bytes in the window
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);  // 5,000: above the 1,000 budget
    // Its size is unknown: 700 left minus a reserve of 600 (twice getSlot's answer; ruling 2).
    assert.equal(client.to('shyft').at(-1)?.o.byteBudget, 100);
    const tH = client.to('shyft').at(-1)?.at as number;                                    // refused on its length at once
    // During the hold getBalance sends nothing: it fails at once with the end of the hold (R8-1). A newer lower-priority
    // call is not held.
    const sent = client.to('shyft').length;
    const t0 = time.now;
    const bal = gw.call('getBalance', ['pk'], READ(2, { timeoutMs: 30_000 }));
    const p3 = slot(gw, READ(3));
    assert.deepEqual(await run(time, bal), byteBudget(tH + OVERSIZED_HOLD_MS - t0));
    assert.ok((await run(time, p3)).ok);
    assert.deepEqual(client.to('shyft').slice(sent).map((x) => [x.method, x.o.byteBudget, x.at - t0 < 1_000]), [['getSlot', 700, true]]);
    // An answer that shrank does not end the hold early: nothing is sent to find out (no probe).
    sizes.getBalance = 8;
    await time.advance(60_000);
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), byteBudget(tH + OVERSIZED_HOLD_MS - time.now));
    assert.equal(client.to('shyft').length, sent + 1);
    // After the hold one request goes with the room left minus the reserve (ruling 2), at once, holding nothing (R3-1).
    // Still too large: the hold starts again.
    sizes.getBalance = 5_000;
    await time.advance(tH + OVERSIZED_HOLD_MS - time.now);
    assert.ok((await run(time, slot(gw, READ(2)))).ok);                                    // 300 bytes in the window
    const t1 = time.now;
    const again = gw.call('getBalance', ['pk'], READ(2, { timeoutMs: 30_000 }));
    const p3b = slot(gw, READ(3));
    assert.deepEqual(await run(time, again), TOO_LARGE);
    assert.ok((await run(time, p3b)).ok);
    const [b2, s2] = client.to('shyft').slice(-2);
    assert.deepEqual([b2?.method, b2?.o.byteBudget, s2?.method, s2?.o.byteBudget], ['getBalance', 100, 'getSlot', 700]);
    assert.ok((s2?.at as number) < t1 + 1_000, `${(s2?.at as number) - t1}`);
    const tH2 = b2?.at as number;
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), byteBudget(tH2 + OVERSIZED_HOLD_MS - time.now));
    // After that hold a complete answer ends it: the method then needs room for that answer (8 bytes). With 5 left it is
    // refused at once until the 695 leave, not for a hold.
    sizes.getBalance = 8;
    await time.advance(tH2 + OVERSIZED_HOLD_MS - time.now);
    assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);
    assert.equal(client.to('shyft').at(-1)?.o.byteBudget, 900);                            // the empty window minus the reserve
    await time.advance(10_000);                                                             // the 8 leave
    assert.ok((await run(time, gw.call('getBlockHeight', [], READ(2)))).ok);                // 695 bytes
    const tB = client.to('shyft').at(-1)?.at as number;
    assert.ok((await run(time, slot(gw, READ(2)))).ok);                                    // 300 bytes: 5 left
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), byteBudget(tB + 10_000 - time.now));
    await time.advance(tB + 10_000 - time.now);
    assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);
    assert.equal(client.to('shyft').at(-1)?.o.byteBudget, 700);                            // its size is known: all the room left
  });

  it('after the hold, a method needing more than a budget needs only 1 byte of room; with none it fails at once (R3-1, R6-1, R9-1)', async () => {
    const { time, client, gw } = setup([small, SECOND]);
    client.answer = (label, method, o) => {
      const cap = o.byteBudget as number;
      const n = method === 'getBalance' ? 5_000 : 1_100;
      const read = n > cap ? cap + 200 : n;                                                  // streamed: one chunk past the cap
      o.onBytes?.(read);
      if (n > cap) { o.onTooLarge?.(cutAfter(read)); return TOO_LARGE; }
      return okAnswer(label);
    };
    // 1,100 read (cap 900: the budget minus the 100 reserve): more than an empty window's room (900 minus the 200-byte
    // overshoot seen), so the hold starts.
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);
    await time.advance(OVERSIZED_HOLD_MS);
    // 900 read (cap 700): 100 left, less than the reserve (twice that read; ruling 2), so getBalance has no room.
    assert.deepEqual(await run(time, slot(gw, READ(2))), TOO_LARGE);
    const tS = client.to('shyft').at(-1)?.at as number;
    const sent = client.to('shyft').length;
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2, { timeoutMs: 30_000 }))), byteBudget(10_000));
    assert.equal(client.to('shyft').length, sent);
    await time.advance(tS + 10_000 - time.now);
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);
    const last = client.to('shyft').at(-1);
    assert.deepEqual([last?.method, (last?.at as number) - tS, last?.o.byteBudget], ['getBalance', 10_000, 700]);
  });

  it('a too_large never lowers the need: refused on a smaller length after the hold, the method stays held, not waiting for room for 500 (R5-1, R8-1)', async () => {
    const { time, client, gw } = setup([small, SECOND]);
    const sizes: Record<string, number> = { getBalance: 5_000, getSlot: 300 };
    client.answer = (label, method, o) => {
      const n = sizes[method] as number;
      if (n > (o.byteBudget as number)) { o.onTooLarge?.(declaredLen(n)); return TOO_LARGE; }
      o.onBytes?.(n);
      return okAnswer(label);
    };
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);  // 5,000
    await time.advance(OVERSIZED_HOLD_MS);
    assert.ok((await run(time, slot(gw, READ(2)))).ok);                                    // 300 bytes: 700 left
    sizes.getBalance = 500;                                                                  // declared 500: too large for 100
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);
    assert.equal(client.to('shyft').at(-1)?.o.byteBudget, 100);                            // 700 left minus twice getSlot's 300 (ruling 2)
    // The need stays 5,000 (not 500, which the 700 left would hold): the hold starts again and nothing is sent.
    const tH = client.sent.at(-1)?.at as number;
    const sent = client.sent.length;
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2, { timeoutMs: 30_000 }))), byteBudget(tH + OVERSIZED_HOLD_MS - time.now));
    assert.equal(client.sent.length, sent);
  });

  it('after a hold, a request that fails at any size starts the hold again; a complete answer ends it (R5-1, R8-1)', async () => {
    const { time, client, gw } = setup([small, SECOND]);
    const sizes: Record<string, number> = { getBalance: 5_000, getSlot: 300, getBlockHeight: 300 };
    client.answer = (label, method, o) => {
      const n = sizes[method] as number;
      if (n > (o.byteBudget as number)) { o.onTooLarge?.(declaredLen(n)); return TOO_LARGE; }
      o.onBytes?.(n);
      return okAnswer(label);
    };
    const balance = (timeoutMs = 5_000): Promise<Reply> => run(time, gw.call('getBalance', ['pk'], READ(2, { timeoutMs })));
    const lastBudget = (): number | undefined => client.to('shyft').at(-1)?.o.byteBudget;
    assert.ok((await run(time, gw.call('getBlockHeight', [], READ(2)))).ok);             // its size is known from here on
    assert.deepEqual(await balance(), TOO_LARGE);                                       // 5,000: the hold starts
    const tH = client.sent.at(-1)?.at as number;
    sizes.getBalance = 8;
    assert.deepEqual(await balance(), byteBudget(tH + OVERSIZED_HOLD_MS - time.now));  // nothing sent during the hold
    assert.equal(client.sent.length, 2);
    await time.advance(tH + OVERSIZED_HOLD_MS - time.now);
    assert.ok((await run(time, slot(gw, READ(2)))).ok);                                  // 300 bytes: 700 left
    sizes.getBalance = 600;
    assert.deepEqual(await balance(), TOO_LARGE);                                       // the request after the hold
    assert.equal(lastBudget(), 100);                                                    // 700 left minus twice getSlot's 300 (ruling 2)
    const tH2 = client.sent.at(-1)?.at as number;
    assert.deepEqual(await balance(), byteBudget(tH2 + OVERSIZED_HOLD_MS - time.now));  // 600 < 1,000, but the hold starts again
    await time.advance(tH2 + OVERSIZED_HOLD_MS - time.now);
    assert.ok((await balance()).ok);                                                     // 600 fits the empty window: the hold ends
    assert.equal(lastBudget(), 900);                                                    // the empty window minus the reserve
    // Without a hold the method is refused at once only until there is room for its need: its last answer (600), then
    // its declared length (800, which starts a hold that room for 800 ends first). Its size is known: it may use all
    // the room left.
    const t6 = client.to('shyft').at(-1)?.at as number;
    assert.ok((await run(time, gw.call('getBlockHeight', [], READ(2)))).ok);             // 900 in the window: 100 left
    const tS = client.to('shyft').at(-1)?.at as number;
    sizes.getBalance = 800;
    assert.deepEqual(await balance(30_000), byteBudget(t6 + 10_000 - time.now));       // room for 600 when the 600 leave
    await time.advance(t6 + 10_000 - time.now);
    assert.deepEqual(await balance(), TOO_LARGE);                                       // declared 800, 700 left
    assert.equal(lastBudget(), 700);
    assert.deepEqual(await balance(30_000), byteBudget(tS + 10_000 - time.now));       // room for 800 when the 300 leave
    await time.advance(tS + 10_000 - time.now);
    assert.ok((await balance()).ok);
    assert.equal(lastBudget(), 1_000);
  });

  it('without a Content-Length, a method known above a whole budget sends nothing during its hold: P3 keeps 120/120 (R5-1, R8-1)', async () => {
    const pub = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 },
      documentedLimits: [...PUBLIC_RPC_LIMITS, { scope: 'bytes', count: 100_000_000, windowMs: 30_000, fact: 'LD-26' }] });
    const { time, client, gw } = setup([pub], { context: 'research', overshootBytes: OVERSHOOT_BYTES });
    const CHUNK = 65_536;                                   // the client stops at the chunk that crosses its cap
    // An empty window's room for a read of unknown size: the 50 MB budget minus the 5 MB reserve and the overshoot.
    const ROOM = 45_000_000 - OVERSHOOT_BYTES;
    let size = 60_000_000;
    const gpa: number[] = [];                               // bytes each getProgramAccounts request read
    client.answer = (label, method, o) => {
      const cap = o.byteBudget as number;
      const n = method === 'getProgramAccounts' ? size : 1_000;
      const read = n > cap ? cap + CHUNK : n;               // streamed: no length to refuse it on (red team R5-1)
      if (method === 'getProgramAccounts') gpa.push(read);
      o.onBytes?.(read);
      if (n > cap) { o.onTooLarge?.(cutAfter(read)); return TOO_LARGE; }
      return okAnswer(label);
    };
    const gpaCall = (): Promise<Reply> => gw.call('getProgramAccounts', ['prog', { encoding: 'base64' }], READ(2, { timeoutMs: 60_000 }));
    // The first answer's size is unknown: it reads that room and one chunk, and fails.
    assert.deepEqual(await run(time, gpaCall()), TOO_LARGE);
    assert.deepEqual(gpa, [ROOM + CHUNK]);
    const tH = client.sent[0]?.at as number;
    await time.advance(30_000);                             // that read leaves the 30 s window
    // The red team's scenario: four more calls, one per 30 s, beside one P3 getSlot per second.
    const slots: Array<Promise<Reply>> = [];
    const gpas: Array<{ at: number; r: Promise<Reply> }> = [];
    for (let i = 0; i < 4; i++) {
      gpas.push({ at: time.now, r: gpaCall() });
      for (let k = 0; k < 30; k++) { slots.push(slot(gw, READ(3, { timeoutMs: 5_000 }))); await time.advance(1_000); }
    }
    await time.advance(10_000);
    assert.equal((await Promise.all(slots)).filter((r) => r.ok).length, 120);
    for (const x of gpas) assert.deepEqual(await x.r, byteBudget(tH + OVERSIZED_HOLD_MS - x.at));
    assert.deepEqual(gpa, [ROOM + CHUNK]);                  // nothing more was read (before: a 64 KiB probe per call)
    // An answer that shrank is not found out during the hold: one method can answer small and large (other filters).
    size = 40_000;
    assert.deepEqual(await run(time, gpaCall()), byteBudget(tH + OVERSIZED_HOLD_MS - time.now));
    size = 40_000_000;                                      // now below the budget
    await time.advance(tH + OVERSIZED_HOLD_MS - 1_000 - time.now);
    assert.deepEqual(await run(time, gpaCall()), byteBudget(1_000));
    assert.equal(gpa.length, 1);
    // When the hold ends one request reads the room left, and succeeds.
    await time.advance(tH + OVERSIZED_HOLD_MS - time.now);
    assert.ok((await run(time, gpaCall())).ok);
    assert.equal(client.sent.at(-1)?.o.byteBudget, ROOM);
  });

  it('a 60 MB getProgramAccounts answer on the public endpoint no longer stalls P3 traffic (R3-1 repro)', async () => {
    const pub = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 },
      documentedLimits: [...PUBLIC_RPC_LIMITS, { scope: 'bytes', count: 100_000_000, windowMs: 30_000, fact: 'LD-26' }] });
    const { time, client, gw } = setup([pub], { context: 'research' });
    client.answer = (label, method, o) => {
      if (method === 'getProgramAccounts') { o.onTooLarge?.(declaredLen(60_000_000)); return TOO_LARGE; }
      o.onBytes?.(1_000);
      return okAnswer(label);
    };
    const slots: Array<Promise<Reply>> = [];
    const gpas: Array<Promise<Reply>> = [];
    for (let i = 0; i < 4; i++) {
      gpas.push(gw.call('getProgramAccounts', ['prog', { encoding: 'base64' }], READ(2, { timeoutMs: 60_000 })));
      for (let k = 0; k < 30; k++) { slots.push(slot(gw, READ(3, { timeoutMs: 5_000 }))); await time.advance(1_000); }
    }
    await time.advance(10_000);
    assert.equal((await Promise.all(slots)).filter((r) => r.ok).length, 120);
    assert.deepEqual((await Promise.all(gpas)).map((r) => (r.ok ? 'ok' : r.error.message)), ['too_large', 'byte_budget', 'byte_budget', 'byte_budget']);
    const sent = client.sent.filter((s) => s.method === 'getProgramAccounts');
    assert.deepEqual(sent.map((s) => s.at), [1_000_000]);
  });

  it('a stop store that fails to load or has a bad shape stops every configured provider with a critical log (R3-2)', async () => {
    const bad: unknown[] = [
      [], { stopped: [] }, { stopped: [], recent: [{ label: 'shyft', limitedAtMs: 'x', pausedUntilMs: 0 }] },
      { stopped: [{ label: 'shyft', stoppedAtMs: 1, reason: 'tired' }], recent: [] }, null, 'x',
      { stopped: [], recent: [{ label: 'shyft', limitedAtMs: [1], pausedUntilMs: '0' }] }, 'throw',
    ];
    for (const content of bad) {
      let saves = 0;
      const store: StopStore = {
        load: () => { if (content === 'throw') throw new Error('unreadable'); return content as StopState; },
        save: () => { saves += 1; },
      };
      const { time, client, log, gw } = setup([PRIMARY, SECOND], { stopStore: store });
      const label = JSON.stringify(content);
      assert.deepEqual(log.events.map((e) => [e.level, e.code, e.fields.problem ?? e.fields.provider, e.fields.reason]), [
        ['critical', 'm14.stop_store_invalid', content === 'throw' ? 'load_failed' : 'bad_shape', undefined],
        ['critical', 'm14.provider_stopped', 'shyft', 'stop_store_invalid'],
        ['critical', 'm14.provider_stopped', 'chainstack', 'stop_store_invalid'],
      ], label);
      assert.deepEqual(gw.status().map((s) => s.stopped), [true, true], label);
      assert.deepEqual(await run(time, slot(gw, READ(1))), { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'no_eligible_provider' } });
      assert.equal(client.sent.length, 0);
      assert.equal(saves, 0, label);                                                 // the bad store is kept for the operator
    }
    // The operator resumes a provider: it answers, and the store is written in the current shape (the other stays stopped).
    const store = new MemoryStopStore();
    const broken = { load: () => [] as unknown as StopState, save: (s: StopState) => store.save(s) };
    const { time, gw } = setup([PRIMARY, SECOND], { stopStore: broken });
    const started = time.now;
    assert.equal(gw.resumeProvider('shyft'), true);
    assert.ok((await run(time, slot(gw, READ(2)))).ok);
    assert.deepEqual(store.stopped, [{ label: 'chainstack', stoppedAtMs: started, reason: 'stop_store_invalid' }]);
    assert.deepEqual(store.recent, []);
    const again = setup([PRIMARY, SECOND], { stopStore: store });                     // and loads again after a restart
    assert.deepEqual(again.gw.status().map((s) => s.stopped), [false, true]);
  });

  it('after the wall clock steps back, a restart restores a pause no longer than it was set and re-bases the store once (R3-3)', async () => {
    const store = new MemoryStopStore();
    const W = 1_700_000_000_000;
    const a = setup([PRIMARY, SECOND], { stopStore: store, clock: { kind: 'wall', nowMs: () => W as UnixMs } });
    a.client.answer = (label) => (label === 'shyft' ? limited(5_000) : okAnswer(label));
    assert.deepEqual(await run(a.time, slot(a.gw, READ(2))), limited(5_000));
    assert.deepEqual(store.recent, [{ label: 'shyft', limitedAtMs: [W], pausedUntilMs: W + 5_000 }]);
    let wall = W - 3_600_000;                                                          // the clock steps back one hour
    const clock: GatewayDeps['clock'] = { kind: 'wall', nowMs: () => wall as UnixMs };
    const b = setup([PRIMARY, SECOND], { stopStore: store, clock });
    assert.deepEqual([b.gw.status()[0]?.recentLimited, (b.gw.status()[0]?.pausedUntilMs as number) - b.time.now], [1, 5_000]);
    assert.deepEqual(store.recent, [{ label: 'shyft', limitedAtMs: [wall], pausedUntilMs: wall + 5_000 }]);   // re-based once
    wall += STOP_WINDOW_MS + 1;                                                        // a restart ten minutes later
    const c = setup([PRIMARY, SECOND], { stopStore: store, clock });
    assert.deepEqual([c.gw.status()[0]?.recentLimited, c.gw.status()[0]?.pausedUntilMs], [0, Number.NEGATIVE_INFINITY]);
    assert.deepEqual(store.recent, []);
    // A stored pause after a resume (no answers kept) is still capped at MAX_PAUSE_MS, and re-based too.
    store.recent = [{ label: 'shyft', limitedAtMs: [], pausedUntilMs: wall + 3_600_000 }];
    const d = setup([PRIMARY, SECOND], { stopStore: store, clock });
    assert.equal((d.gw.status()[0]?.pausedUntilMs as number) - d.time.now, MAX_PAUSE_MS);
    assert.deepEqual(store.recent, [{ label: 'shyft', limitedAtMs: [], pausedUntilMs: wall + MAX_PAUSE_MS }]);
  });
});

describe('red team C03 round 6: the byte budget never makes a call wait or hold another (supervisor directive)', () => {
  const small = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0, limits: { rps: 5 },
    documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-33' }, BYTES_2K] });
  const pub = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 },
    documentedLimits: [...PUBLIC_RPC_LIMITS, { scope: 'bytes', count: 100_000_000, windowMs: 30_000, fact: 'LD-26' }] });
  const CHUNK = 65_536;                                     // the client stops at the chunk that crosses its cap
  /** An empty window's room for a read of unknown size: the 50 MB budget minus the 5 MB reserve and the overshoot. */
  const ROOM = 45_000_000 - OVERSHOOT_BYTES;
  /** A call and how long it took to settle on the fake clock. */
  const timed = (time: FakeTime, p: Promise<Reply>): Promise<{ r: Reply; tookMs: number }> => {
    const t = time.now;
    return p.then((r) => ({ r, tookMs: time.now - t }));
  };
  /**
   * Answers each method once, 10 s apart, so their sizes are known and the window is empty again. A first read is of
   * unknown size: it is refused while twice the largest answer of another method takes all the bytes left (ruling 2
   * as written, R11-1).
   */
  const known = async (time: FakeTime, gw: ReturnType<typeof setup>['gw'], methods: readonly string[]): Promise<void> => {
    for (const method of methods) {
      assert.ok((await run(time, gw.call(method, [], READ(2)))).ok, method);
      await time.advance(10_000);
    }
  };

  /**
   * The red team's R6-1 setup on the public endpoint: answers by method size, streamed (no Content-Length: read one
   * chunk past the cap) or declared (refused on the length, nothing read); 20 s of P1 getBlock every 2 s and one P3
   * getSlot, so both sizes are known before the first getProgramAccounts (the reserve of ruling 2 is for answers of
   * known size; a method's first read beside a large answer is refused, see the R11-1 cases); then rounds of one P2
   * getProgramAccounts, beside a P1 getBlock every 2 s and a P3 getSlot (5 s timeout) every second.
   */
  async function steadyTraffic(sizes: Record<string, number>, streamed: boolean, rounds: number, roundS: number) {
    const s = setup([pub], { context: 'research', overshootBytes: OVERSHOOT_BYTES });
    const reads: Record<string, number[]> = {};
    s.client.answer = (label, method, o) => {
      const cap = o.byteBudget as number;
      const n = sizes[method] as number;
      if (n > cap && !streamed) { (reads[method] ??= []).push(0); o.onTooLarge?.(declaredLen(n)); return TOO_LARGE; }
      const r = n > cap ? cap + CHUNK : n;
      (reads[method] ??= []).push(r);
      o.onBytes?.(r);
      if (n > cap) { o.onTooLarge?.(cutAfter(r)); return TOO_LARGE; }
      return okAnswer(label);
    };
    const { time, gw } = s;
    const block = (): Promise<{ r: Reply; tookMs: number }> => timed(time, gw.call('getBlock', [1n, { encoding: 'json' }], READ(1, { timeoutMs: 10_000 })));
    const blocks: Array<Promise<{ r: Reply; tookMs: number }>> = [];
    const slots: Array<Promise<{ r: Reply; tookMs: number }>> = [];
    const gpas: Array<Promise<{ r: Reply; tookMs: number }>> = [];
    let warm: Promise<Reply> = Promise.resolve(okAnswer('none'));
    for (let k = 0; k < 20; k++) {
      if (k % 2 === 0) blocks.push(block());
      if (k === 1) warm = slot(gw, READ(3));
      await time.advance(1_000);
    }
    assert.ok((await warm).ok);
    for (let i = 0; i < rounds; i++) {
      gpas.push(timed(time, gw.call('getProgramAccounts', ['prog', { encoding: 'base64' }], READ(2, { timeoutMs: 60_000 }))));
      for (let k = 0; k < roundS; k++) {
        if (k % 2 === 0) blocks.push(block());
        slots.push(timed(time, slot(gw, READ(3, { timeoutMs: 5_000 }))));
        await time.advance(1_000);
      }
    }
    await time.advance(70_000);
    return { ...s, reads, gpas: await Promise.all(gpas), slots: await Promise.all(slots), blocks: await Promise.all(blocks) };
  }

  it('streamed: a 60 MB getProgramAccounts read beside steady getBlock and getSlot traffic refuses no other call for bytes; two requests in 20 minutes (R6-1, R8-1, R9-1)', async () => {
    const { reads, gpas, slots, blocks, metrics } = await steadyTraffic({ getProgramAccounts: 60_000_000, getBlock: 100_000, getSlot: 1_000 }, true, 40, 30);
    // Each read of unknown size keeps the reserve for other methods (supervisor ruling 2), so getSlot and getBlock, whose
    // sizes are known, are never refused with byte_budget (before: P3 refused at once for about 30 s after each cut
    // read). These answers are instant, so the one request in flight (ruling 4) costs no call either.
    for (const method of ['getSlot', 'getBlock']) assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'public', method }), 0, method);
    assert.equal(slots.filter((x) => x.r.ok).length, 1_200);
    assert.equal(blocks.filter((x) => x.r.ok).length, 610);
    // Two requests in 20 minutes: the first, cut at the room left minus the reserve (it then needs an empty window, which
    // steady traffic never leaves), and the one when its 10-minute hold ends. Nothing else is sent (no probe; R8-1).
    const g = reads.getProgramAccounts as number[];
    assert.equal(g.length, 2, g.join());
    assert.ok(g.every((n) => n > 43_000_000 && n <= ROOM + CHUNK), g.join());
    assert.deepEqual(gpas.flatMap((x, i) => (!x.r.ok && x.r.error.message === 'too_large' ? [i] : [])), [0, 20]);
    // No call waited for bytes: every other getProgramAccounts call is refused with byte_budget, at once, with the time
    // until room frees.
    for (const x of gpas) {
      if (x.r.ok || x.r.error.message === 'too_large') continue;
      assert.equal(x.r.error.message, 'byte_budget');
      assert.equal(x.tookMs, 0);
      assert.ok((x.r.error.retryAfterMs as number) > 0 && (x.r.error.retryAfterMs as number) <= 30_000, `${x.r.error.retryAfterMs}`);
    }
  });

  it('declared length: an answer larger than the room fails at once and never holds P3; above a budget it sends one request per hold (R6-1, R8-1)', async () => {
    // 30 MB fits a budget but not the room left by the last one: 1 of 3 calls goes, the others fail at once.
    const a = await steadyTraffic({ getProgramAccounts: 30_000_000, getBlock: 100_000, getSlot: 1_000 }, false, 30, 10);
    assert.equal(a.slots.filter((x) => x.r.ok).length, 300);
    assert.equal(a.blocks.filter((x) => x.r.ok).length, 160);
    assert.deepEqual(a.gpas.map((x) => (x.r.ok ? 'ok' : x.r.error.retryAfterMs)), Array.from({ length: 10 }, () => ['ok', 20_000, 10_000]).flat());
    assert.ok(a.gpas.every((x) => x.r.ok || (x.r.error.message === 'byte_budget' && x.tookMs === 0)));
    assert.deepEqual(a.reads.getProgramAccounts, Array.from({ length: 10 }, () => 30_000_000));
    // 60 MB: refused on its length (nothing read), the hold starts; the calls during it send nothing; after it one
    // request goes with the room left and is refused again. P3 and getBlock never lose a call.
    const b = await steadyTraffic({ getProgramAccounts: 60_000_000, getBlock: 100_000, getSlot: 1_000 }, false, 24, 30);
    assert.equal(b.slots.filter((x) => x.r.ok).length, 720);
    assert.equal(b.blocks.filter((x) => x.r.ok).length, 370);
    assert.deepEqual(b.reads.getProgramAccounts, [0, 0]);
    assert.deepEqual(b.gpas.map((x) => (x.r.ok ? 'ok' : x.r.error.message)), Array.from({ length: 24 }, (_, i) => (i % 20 === 0 ? 'too_large' : 'byte_budget')));
    assert.ok(b.gpas.every((x) => x.tookMs === 0));
  });

  it('a call without room for its need fails at once with byte_budget and retryAfterMs; newer and lower-priority calls go', async () => {
    const { time, client, gw } = setup([small, SECOND]);
    const sizes: Record<string, number> = { getBlockHeight: 450, getBalance: 500, getSlot: 10 };
    client.answer = (label, method, o) => { o.onBytes?.(sizes[method] as number); return okAnswer(label); };
    await known(time, gw, ['getBalance', 'getBlockHeight', 'getSlot']);
    const base = client.to('shyft').length;
    assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);           // getBalance answers 500 bytes
    const tA = client.to('shyft').at(-1)?.at as number;
    assert.ok((await run(time, gw.call('getBlockHeight', [], READ(2)))).ok);            // the window now holds 950
    await time.advance(2_000);
    const t0 = time.now;
    const bal = timed(time, gw.call('getBalance', ['pk'], READ(2, { timeoutMs: 30_000 })));   // needs 500, 50 left
    const p2 = slot(gw, READ(2, { timeoutMs: 30_000 }));
    const p3 = slot(gw, READ(3, { timeoutMs: 30_000 }));
    await time.advance(1_000);
    // Room for 500 comes when the first 500 leave: tA + 10 s.
    assert.deepEqual(await bal, { r: byteBudget(tA + 10_000 - t0), tookMs: 0 });
    assert.ok((await p2).ok && (await p3).ok);
    assert.deepEqual(client.to('shyft').slice(base + 2).map((s) => [s.method, s.at - t0 < 1_000]), [['getSlot', true], ['getSlot', true]]);
    // Retrying after retryAfterMs succeeds, with all the room left.
    await time.advance(tA + 10_000 - time.now);
    assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);
    assert.equal(client.to('shyft').at(-1)?.o.byteBudget, 1_000 - 450 - 20);
    // A call queued behind a request in flight is checked again when its turn comes: no room then, it fails at once.
    await time.advance(5_000);                                                              // only the retry's 500 in the window
    let release = (): void => undefined;
    client.answer = (label, method, o) => {
      if (method !== 'getBlockHeight') { o.onBytes?.(sizes[method] as number); return okAnswer(label); }
      return new Promise<Reply>((res) => { release = () => { o.onBytes?.(450); res(okAnswer(label)); }; });   // counted at the end
    };
    const slow = gw.call('getBlockHeight', [], READ(2));
    await flush();
    const queued = timed(time, gw.call('getBalance', ['pk'], READ(2, { timeoutMs: 30_000 })));   // 500 left when queued
    await time.advance(500);
    release();
    assert.ok((await slow).ok);
    const q = await queued;
    assert.deepEqual([q.r.ok ? 'ok' : q.r.error.message, q.tookMs], ['byte_budget', 500]);
  });

  it('with two byte limits a call needs room in both; retryAfterMs is when the later one has it', async () => {
    const two = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0, limits: { rps: 5 },
      documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-33' }, BYTES_2K, { scope: 'bytes', count: 3_000, windowMs: 60_000, fact: 'test' }] });
    const { time, client, gw } = setup([two, SECOND]);
    client.answer = (label, _m, o) => { o.onBytes?.(700); return okAnswer(label); };
    assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);           // 700 in both windows
    const t0 = client.sent.at(-1)?.at as number;
    await time.advance(11_000);
    assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);           // 10 s window: 1,000 left; 60 s: 800
    assert.equal(client.sent.at(-1)?.o.byteBudget, 800);
    await time.advance(11_000);
    const t1 = time.now;                                                                // 10 s window empty; 60 s: 100 left
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))),
      { ok: false, error: { code: 'E_RATE_LIMITED', message: 'byte_budget', retryAfterMs: t0 + 60_000 - t1 } });
  });

  it('a P0/P1 read without room for its bytes fails over at once', async () => {
    const { time, client, gw } = setup([small, SECOND]);
    client.answer = (label, method, o) => { o.onBytes?.(method === 'getBalance' ? 500 : 450); return okAnswer(label); };
    await known(time, gw, ['getBalance', 'getBlockHeight']);
    const base = client.sent.length;
    assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);
    assert.ok((await run(time, gw.call('getBlockHeight', [], READ(2)))).ok);            // 50 left
    const t0 = time.now;
    const r = await run(time, gw.call('getBalance', ['pk'], READ(1)));
    assert.ok(r.ok && r.value.providerLabel === 'chainstack');
    assert.deepEqual(client.sent.slice(base + 2).map((s) => [s.label, s.at - t0]), [['chainstack', 0]]);
  });

  it('an answer of unknown size (no Content-Length) needs twice the bytes read, at most an empty window\'s room; past that the hold starts (R6-1, R8-1, R9-1)', async () => {
    const { time, client, gw } = setup([small, SECOND]);
    const sizes: Record<string, number> = { getBalance: 300, getSlot: 300 };
    client.answer = (label, method, o) => {
      const cap = o.byteBudget as number;
      const n = sizes[method] as number;
      const read = n > cap ? cap + 50 : n;                                                 // streamed: one chunk past the cap
      o.onBytes?.(read);
      if (n > cap) { o.onTooLarge?.(cutAfter(read)); return TOO_LARGE; }
      return okAnswer(label);
    };
    assert.ok((await run(time, slot(gw, READ(2)))).ok);                                    // 300 bytes: 700 left
    const t1 = client.sent.at(-1)?.at as number;
    // Its size is unknown: 700 left minus a reserve of 600, twice getSlot's answer (ruling 2). 150 read: it needs 300 now.
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);
    assert.equal(client.sent.at(-1)?.o.byteBudget, 100);
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), byteBudget(t1 + 10_000 - time.now));
    await time.advance(t1 + 10_000 - time.now);
    assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);
    // 850 left minus the 100 reserve (its own 150 bytes do not count) and the 50-byte overshoot seen.
    assert.equal(client.sent.at(-1)?.o.byteBudget, 700);
    // A read cut above half an empty window's room by a busy window (750 of an answer, 300 already in the window) needs
    // that room, not the 10-minute hold (R8-1: a 35 MB answer cut at 30 MB fits an emptier window).
    await time.advance(10_000);
    sizes.getSlot = 300;
    sizes.getBalance = 800;
    assert.ok((await run(time, slot(gw, READ(2)))).ok);
    const tS = client.sent.at(-1)?.at as number;
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);
    assert.equal(client.sent.at(-1)?.o.byteBudget, 700);
    const tC = client.sent.at(-1)?.at as number;
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), byteBudget(Math.max(tS, tC) + 10_000 - time.now));
    await time.advance(Math.max(tS, tC) + 10_000 - time.now);
    assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);              // the empty window's room holds it
    assert.equal(client.sent.at(-1)?.o.byteBudget, 850);
    // A read cut past an empty window's room (1,050 of a 5,000-byte answer; its size was known, so it had all 1,000
    // left) can never fit: the hold starts, nothing is sent.
    await time.advance(10_000);
    sizes.getBalance = 5_000;
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);
    assert.equal(client.sent.at(-1)?.o.byteBudget, 1_000);
    const tH = client.sent.at(-1)?.at as number;
    const sent = client.sent.length;
    await time.advance(10_000);
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), byteBudget(tH + OVERSIZED_HOLD_MS - time.now));
    assert.equal(client.sent.length, sent);
  });
});

describe('red team C03 round 8: no probe, the client\'s own cap, answers that take time, hold metrics', () => {
  const pub = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 },
    documentedLimits: [...PUBLIC_RPC_LIMITS, { scope: 'bytes', count: 100_000_000, windowMs: 30_000, fact: 'LD-26' }] });
  const small = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0, limits: { rps: 5 },
    documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-33' }, BYTES_2K] });
  const CHUNK = 65_536;                                     // the client stops at the chunk that crosses its cap
  /** An empty window's room for a read of unknown size: the 50 MB budget minus the 5 MB reserve and the overshoot. */
  const ROOM = 45_000_000 - OVERSHOOT_BYTES;
  const research = { context: 'research', overshootBytes: OVERSHOOT_BYTES } as const;
  const gpaCall = (gw: ReturnType<typeof setup>['gw']): Promise<Reply> =>
    gw.call('getProgramAccounts', ['prog', { encoding: 'base64' }], READ(2, { timeoutMs: 60_000 }));
  /** Answers by method size, streamed: no Content-Length, so an answer above the cap is read one chunk past it. */
  const streamed = (sizes: Record<string, number>) => (label: string, method: string, o: RequestOptions): Reply => {
    const cap = o.byteBudget as number;
    const n = sizes[method] as number;
    const r = n > cap ? cap + CHUNK : n;
    o.onBytes?.(r);
    if (n > cap) { o.onTooLarge?.(cutAfter(r)); return TOO_LARGE; }
    return okAnswer(label);
  };

  it('after a read cut past an empty window\'s room, every call in the hold sends nothing and fails at once with byte_budget and the end of the hold; refusals are counted and the hold logged (R8-1, R8-3, R9-1)', async () => {
    const { time, client, gw, log, metrics } = setup([pub], research);
    client.answer = streamed({ getProgramAccounts: 60_000_000, getSlot: 1_000, getBlock: 100_000 });
    assert.ok((await run(time, slot(gw, READ(3)))).ok);                                  // getSlot's size is now known
    await time.advance(30_000);                                                          // its answer leaves the window
    assert.deepEqual(await run(time, gpaCall(gw)), TOO_LARGE);
    const tH = client.sent.at(-1)?.at as number;
    assert.deepEqual(log.events.filter((e) => e.code === 'm14.byte_hold_started'), [{ level: 'warn', code: 'm14.byte_hold_started', fields: {
      provider: 'public', method: 'getProgramAccounts', need_bytes: null, at_least_bytes: ROOM + CHUNK, declared: false, over_own_cap: false,
      hold_ms: OVERSIZED_HOLD_MS,
    } }]);
    // The cut read kept the reserve: a P3 getSlot, whose size is known, still goes (ruling 2; before R9-1 it was refused
    // until the read left the window). A first getBlock read, of unknown size, is refused until then: twice the cut read
    // is above the bytes left (ruling 2 as written, R11-1).
    assert.ok((await run(time, slot(gw, READ(3)))).ok);
    assert.deepEqual(await run(time, gw.call('getBlock', [1n, { encoding: 'json' }], READ(3))), byteBudget(tH + 30_000 - time.now));
    // The red team's repro A: five calls during the hold. Before: each sent a request with a 64 KiB cap and got too_large
    // with no retryAfterMs.
    for (let i = 0; i < 5; i++) {
      await time.advance(60_000);
      assert.deepEqual(await run(time, gpaCall(gw)), byteBudget(tH + OVERSIZED_HOLD_MS - time.now));
    }
    assert.equal(client.to('public').filter((x) => x.method === 'getProgramAccounts').length, 1);
    assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'public', method: 'getProgramAccounts' }), 5);
    assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'public', method: 'getSlot' }), 0);
    assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'public', method: 'getBlock' }), 1);
  });

  it('a read cut by a busy window waits for an emptier window, not for the hold: a 35 MB answer cut at 34.8 MB succeeds once an empty window\'s room holds it (R8-1, R9-1)', async () => {
    const { time, client, gw, log } = setup([pub], research);
    client.answer = streamed({ getProgramAccounts: 35_000_000, getBlock: 5_000_000 });
    assert.ok((await run(time, gw.call('getBlock', [1n, { encoding: 'json' }], READ(1)))).ok);   // 5 MB in the window
    assert.deepEqual(await run(time, gpaCall(gw)), TOO_LARGE);
    // 45 MB left minus a reserve of 10 MB (twice getBlock's answer) and the overshoot (ruling 2).
    assert.equal(client.sent.at(-1)?.o.byteBudget, 35_000_000 - OVERSHOOT_BYTES);
    assert.equal(log.events.find((e) => e.code === 'm14.byte_hold_started')?.fields.need_bytes, ROOM);   // an empty window's room
    const free = (client.sent.at(-1)?.at as number) + 30_000;                                   // when both answers left
    assert.deepEqual(await run(time, gpaCall(gw)), byteBudget(free - time.now));
    await time.advance(free - time.now);
    const r = await run(time, gpaCall(gw));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(client.sent.at(-1)?.o.byteBudget, ROOM);
  });

  /**
   * The red team's repro B with answers that take time: getProgramAccounts (60 MB, streamed) waits 2 s for its first
   * byte, then reads 5 MB/s (a cut read of about 49 MB takes about 12 s); every other answer takes 100 ms. Over 20
   * minutes: a P2 getProgramAccounts every 30 s from 10 s on (optional; by then getBlock and getSlot have answered, so
   * their sizes are known: the reserve of ruling 2 is for them, R11-1), a P1 getBlock (100 KB, 10 s timeout) every 2 s
   * and a P3 getSlot (1 KB, 5 s timeout) every second.
   */
  async function timedTraffic(withGpa: boolean) {
    const { time, client, gw, metrics } = setup([pub], research);
    const sizes: Record<string, number> = { getProgramAccounts: 60_000_000, getBlock: 100_000, getSlot: 1_000 };
    const reads: Array<{ at: number; endsAt: number }> = [];               // each getProgramAccounts request
    client.answer = (label, method, o) => {
      const cap = o.byteBudget as number;
      const n = sizes[method] as number;
      const r = n > cap ? cap + CHUNK : n;
      const ms = method === 'getProgramAccounts' ? 2_000 + Math.ceil(r / 5_000) : 100;
      if (method === 'getProgramAccounts') reads.push({ at: time.now, endsAt: time.now + ms });
      return new Promise<Reply>((resolve) => {
        time.set(() => {
          o.onBytes?.(r);
          if (n > cap) { o.onTooLarge?.(cutAfter(r)); resolve(TOO_LARGE); } else resolve(okAnswer(label));
        }, ms);
      });
    };
    const calls: Array<{ at: number; p1: boolean; r: Promise<Reply> }> = [];
    for (let k = 0; k < 20 * 60; k++) {
      if (withGpa && k % 30 === 10) void gpaCall(gw);
      if (k % 2 === 0) calls.push({ at: time.now, p1: true, r: gw.call('getBlock', [1n, { encoding: 'json' }], READ(1, { timeoutMs: 10_000 })) });
      calls.push({ at: time.now, p1: false, r: slot(gw, READ(3, { timeoutMs: 5_000 })) });
      await time.advance(1_000);
    }
    await time.advance(70_000);
    const settled = await Promise.all(calls.map(async (c) => ({ ...c, r: await c.r })));
    return {
      p3: settled.filter((c) => !c.p1 && c.r.ok).length, p1: settled.filter((c) => c.p1 && c.r.ok).length, reads, maxInFlight: client.maxInFlight,
      failed: settled.flatMap((c) => (c.r.ok ? [] : [{ at: c.at, p1: c.p1, error: c.r.error }])),
      byteBudget: ['getSlot', 'getBlock'].map((method) => metrics.count('rpc_byte_budget_refused_total', { provider: 'public', method })),
    };
  }

  it('steady traffic with answers that take time: an oversized getProgramAccounts sends two requests in 20 minutes; no other call is refused for bytes; P3 and P1 lose calls only while those reads hold the one request in flight (R8-1 B, R9-1)', async () => {
    const base = await timedTraffic(false);
    assert.deepEqual([base.p3, base.p1, base.reads.length, base.maxInFlight], [1_200, 600, 0, 1]);
    const g = await timedTraffic(true);
    // Before R8-1: 40 requests, a 64 KiB probe every 30 s between the two full reads (red team repro B).
    assert.equal(g.reads.length, 2);
    assert.equal(g.maxInFlight, 1);
    // Each read of unknown size keeps the reserve (supervisor ruling 2): no getSlot or getBlock call, their sizes known,
    // is refused with byte_budget (red team R9-1 repro A: 35 and 26 before).
    assert.deepEqual(g.byteBudget, [0, 0]);
    // The only losses: each cut read holds the provider's one request in flight while it transfers (about 11 s), so
    // calls that arrive then time out in the queue. That is the owner's one-request-in-flight rule (AGENTS.md data
    // sources), accepted by supervisor ruling (4).
    for (const f of g.failed) {
      assert.deepEqual(f.error, f.p1 ? { code: 'E_ALL_PROVIDERS_DOWN', message: 'all_failed:E_RATE_LIMITED' } : { code: 'E_RATE_LIMITED', message: 'no_token_before_timeout' });
      assert.ok(g.reads.some((x) => f.at >= x.at && f.at <= x.endsAt), `a call at ${f.at - 1_000_000} failed`);
    }
    assert.ok(g.p3 >= 1_185, `P3 ${g.p3}/1,200`);
    assert.ok(g.p1 >= 595, `P1 ${g.p1}/600`);
  });

  it('the client\'s own cap below the budget: an answer cut at that cap holds its method, so it sends one request per hold (R8-2, real client)', async () => {
    const time = new FakeTime();
    const server = new MockServer();
    const reg = registry([small]);                          // a byte budget of 1,000 bytes per 10 s
    const log = new RecordingLog();
    const metrics = new RecordingMetrics();
    // rpc.max_response_bytes = 200, below the budget (red team repro C, scaled down).
    const client = createRpcClient({ fetch: server.fetch, clock: time, scheduler: time, bus: new RecordingBus(), metrics, scrub: scrubberFor(reg.providers.map((p) => p.url)), maxResponseBytes: 200 });
    // The overshoot allowance is this server's 100-byte chunk (the default would leave no room in a 1,000-byte budget).
    const gw = createRpcGateway({ registry: reg, context: 'engine', client, clock: time, scheduler: time, log, metrics, stopStore: new MemoryStopStore(), overshootBytes: 100 });
    // A 600-byte answer streamed in 100-byte chunks without a Content-Length: the client stops at 300 bytes.
    server.route('https://shyft.example.test/', () => new Response(new ReadableStream({
      start(c) { for (let i = 0; i < 6; i++) c.enqueue(new TextEncoder().encode('x'.repeat(100))); c.close(); },
    })));
    const results: Reply[] = [];
    for (let k = 0; k < 40; k++) {                          // one call every 30 s for 20 minutes
      results.push(await run(time, slot(gw, READ(2))));
      await time.advance(30_000);
    }
    // Before: twice the 300 bytes read fit the budget, so no hold started and all 40 calls read the cap again.
    assert.equal(server.seen.length, 2);
    assert.deepEqual(results.flatMap((r, i) => (!r.ok && r.error.message === 'too_large' ? [i] : [])), [0, 20]);
    assert.ok(results.every((r, i) => !r.ok && r.error.message === (i % 20 === 0 ? 'too_large' : 'byte_budget')));
    const holds = log.events.filter((e) => e.code === 'm14.byte_hold_started');
    assert.equal(holds.length, 2);
    assert.deepEqual(holds[0]?.fields, {
      provider: 'shyft', method: 'getSlot', need_bytes: null, at_least_bytes: 300, declared: false, over_own_cap: true, hold_ms: OVERSIZED_HOLD_MS,
    });
    assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'shyft', method: 'getSlot' }), 38);
  });

  it('the one request after a hold that ends without an answer (a timeout) starts the next hold: the next call sends nothing (R8-1)', async () => {
    const { time, client, gw } = setup([small]);
    let hangs = false;
    client.answer = (_label, _m, o) => {
      if (hangs) return new Promise<Reply>((resolve) => { time.set(() => { resolve({ ok: false, error: { code: 'E_TIMEOUT', message: 'timeout' } }); }, o.timeoutMs); });
      o.onTooLarge?.(declaredLen(5_000));
      return TOO_LARGE;
    };
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), TOO_LARGE);
    await time.advance(OVERSIZED_HOLD_MS);
    hangs = true;
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), { ok: false, error: { code: 'E_TIMEOUT', message: 'timeout' } });
    const tR = client.sent.at(-1)?.at as number;
    hangs = false;
    // Before: the hold had passed, so every call sent a full read again until one ended too_large.
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(2))), byteBudget(tR + OVERSIZED_HOLD_MS - time.now));
    assert.equal(client.sent.length, 2);
  });
});

describe('red team C03 round 9: the reserve for other methods; the own-cap hold on every provider', () => {
  const pub = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 },
    documentedLimits: [...PUBLIC_RPC_LIMITS, { scope: 'bytes', count: 100_000_000, windowMs: 30_000, fact: 'LD-26' }] });
  const small = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0, limits: { rps: 5 },
    documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-33' }, BYTES_2K] });
  const holds = (log: RecordingLog): Array<Record<string, unknown>> => log.events.filter((e) => e.code === 'm14.byte_hold_started').map((e) => e.fields);

  it('a read of unknown size keeps the larger of 10% of the budget and twice the largest answer of another method; a known size may use all the room left (R9-1, ruling 2)', async () => {
    const { time, client, gw } = setup([small]);
    const sizes: Record<string, number> = { getBlockHeight: 200, getBalance: 50, getSlot: 10 };
    client.answer = (label, method, o) => { o.onBytes?.(sizes[method] as number); return okAnswer(label); };
    const budgetOf = async (p: Promise<Reply>): Promise<number | undefined> => { assert.ok((await run(time, p)).ok); return client.sent.at(-1)?.o.byteBudget; };
    assert.equal(await budgetOf(gw.call('getBlockHeight', [], READ(2))), 900);              // an empty window: 10% kept
    assert.equal(await budgetOf(gw.call('getBalance', ['pk'], READ(2))), 400);              // 800 left, twice 200 kept
    assert.equal(await budgetOf(slot(gw, READ(2))), 350);                                   // 750 left, twice 200 kept
    assert.equal(await budgetOf(gw.call('getBlockHeight', [], READ(2))), 740);              // its size is known: all 740 left
    // The default overshoot allowance comes off the room of a read of unknown size.
    const time2 = new FakeTime();
    const fake = new FakeClient(time2);
    const gw2 = createRpcGateway({ registry: registry([pub]), context: 'research', client: fake, clock: time2, scheduler: time2, log: new RecordingLog(), metrics: new RecordingMetrics(), stopStore: new MemoryStopStore() });
    assert.ok((await run(time2, slot(gw2, READ(2)))).ok);
    assert.equal(fake.sent[0]?.o.byteBudget, 45_000_000 - OVERSHOOT_BYTES);
    for (const overshootBytes of [-1, 1.5]) assert.throws(() => setup([small], { overshootBytes }), RangeError);
  });

  it('the first read of a method after a 40 MB answer of another method is refused until that answer leaves: twice it is above the bytes left (R11-1: ruling 2 as written, no 10% floor)', async () => {
    const { time, client, gw, metrics } = setup([pub], { context: 'research', overshootBytes: OVERSHOOT_BYTES });
    const sizes: Record<string, number> = { getProgramAccounts: 40_000_000, getBlock: 100_000, getSlot: 1_000 };
    client.answer = (label, method, o) => { o.onBytes?.(sizes[method] as number); return okAnswer(label); };
    assert.ok((await run(time, gw.call('getProgramAccounts', ['prog', { encoding: 'base64' }], READ(2)))).ok);
    const tG = client.sent.at(-1)?.at as number;
    // 10 MB left minus a reserve of 80 MB: no room, nothing sent (before R11-1: 10% of the 10 MB left).
    for (const call of [() => gw.call('getBlock', [1n, { encoding: 'json' }], READ(2)), () => slot(gw, READ(3))]) {
      assert.deepEqual(await run(time, call()), byteBudget(tG + 30_000 - time.now));
    }
    assert.equal(client.sent.length, 1);
    await time.advance(tG + 30_000 - time.now);
    assert.ok((await run(time, gw.call('getBlock', [1n, { encoding: 'json' }], READ(2)))).ok);
    assert.equal(client.sent.at(-1)?.o.byteBudget, 45_000_000 - OVERSHOOT_BYTES);
    for (const method of ['getBlock', 'getSlot']) assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'public', method }), 1);
  });

  it('on a provider without a byte limit, an answer above the client\'s own cap holds its method: one request per hold; a complete answer ends it (R9-2, ruling 3, real client)', async () => {
    const time = new FakeTime();
    const server = new MockServer();
    const reg = registry([PRIMARY]);                        // no byte limit
    const log = new RecordingLog();
    const metrics = new RecordingMetrics();
    const client = createRpcClient({ fetch: server.fetch, clock: time, scheduler: time, bus: new RecordingBus(), metrics, scrub: scrubberFor(reg.providers.map((p) => p.url)), maxResponseBytes: 200 });
    const gw = createRpcGateway({ registry: reg, context: 'engine', client, clock: time, scheduler: time, log, metrics, stopStore: new MemoryStopStore() });
    // A 600-byte answer streamed in 100-byte chunks without a Content-Length: the client stops at 300 bytes.
    server.route('https://shyft.example.test/', () => new Response(new ReadableStream({
      start(c) { for (let i = 0; i < 6; i++) c.enqueue(new TextEncoder().encode('x'.repeat(100))); c.close(); },
    })));
    const results: Reply[] = [];
    for (let k = 0; k < 40; k++) {                          // one call every 30 s for 20 minutes
      results.push(await run(time, slot(gw, READ(2))));
      await time.advance(30_000);
    }
    // Before: every call sent a request and read 300 bytes (red team repro D: 40 of 40).
    assert.equal(server.seen.length, 2);
    assert.ok(results.every((r, i) => !r.ok && r.error.message === (i % 20 === 0 ? 'too_large' : 'byte_budget')));
    const held = { provider: 'shyft', method: 'getSlot', need_bytes: null, at_least_bytes: 300, declared: false, over_own_cap: true, hold_ms: OVERSIZED_HOLD_MS };
    assert.deepEqual(holds(log), [held, held]);
    assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'shyft', method: 'getSlot' }), 38);
    // The answer shrinks: the request after the hold succeeds and ends the hold, so the next call goes at once.
    server.route('https://shyft.example.test/', rpcResult(5));
    assert.ok((await run(time, slot(gw, READ(2)))).ok);
    assert.ok((await run(time, slot(gw, READ(2)))).ok);
    assert.equal(server.seen.length, 4);
  });

  it('an answer above the client\'s own cap holds its method on every provider; other methods go (R9-2, ruling 3)', async () => {
    const { time, client, gw, log } = setup([PRIMARY, SECOND]);
    client.answer = (label, method, o) => {
      if (method === 'getSlot') { o.onTooLarge?.({ atLeastBytes: 300, declared: false, overOwnCap: true }); return TOO_LARGE; }
      if (method === 'getBalance') return TOO_LARGE;       // no detail: without a byte budget only the client's own cap refuses
      return okAnswer(label);
    };
    assert.deepEqual(await run(time, slot(gw, READ(1))), TOO_LARGE);                      // a too_large does not fail over
    const tH = client.sent[0]?.at as number;
    assert.deepEqual(holds(log).map((f) => [f.provider, f.method]), [['shyft', 'getSlot'], ['chainstack', 'getSlot']]);
    // During the hold no provider is sent getSlot: a P1 read finds both held, and so does a call pinned to the second.
    assert.deepEqual(await run(time, slot(gw, READ(1))),
      { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'all_failed:E_RATE_LIMITED', retryAfterMs: tH + OVERSIZED_HOLD_MS - time.now } });
    assert.deepEqual(await run(time, slot(gw, READ(0, { provider: 'chainstack' }))), byteBudget(tH + OVERSIZED_HOLD_MS - time.now));
    assert.ok((await run(time, gw.call('getBlockHeight', [], READ(1)))).ok);
    assert.deepEqual(await run(time, gw.call('getBalance', ['pk'], READ(1))), TOO_LARGE);
    assert.deepEqual(holds(log).slice(2).map((f) => [f.provider, f.method, f.over_own_cap]), [['shyft', 'getBalance', true], ['chainstack', 'getBalance', true]]);
    assert.deepEqual(client.sent.map((x) => [x.label, x.method]), [['shyft', 'getSlot'], ['shyft', 'getBlockHeight'], ['shyft', 'getBalance']]);
    // After the hold one request goes; a complete answer ends the hold there.
    client.answer = (label) => okAnswer(label);
    await time.advance(tH + OVERSIZED_HOLD_MS - time.now);
    assert.ok((await run(time, slot(gw, READ(1)))).ok);
    assert.ok((await run(time, slot(gw, READ(1)))).ok);
    assert.equal(client.to('shyft').filter((x) => x.method === 'getSlot').length, 3);
  });
});

describe('red team C03 round 11: ruling 2 as written; a finite retryAfterMs', () => {
  const pub = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 },
    documentedLimits: [...PUBLIC_RPC_LIMITS, { scope: 'bytes', count: 100_000_000, windowMs: 30_000, fact: 'LD-26' }] });
  const small = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0, limits: { rps: 5 },
    documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-33' }, BYTES_2K] });
  /** Instant answers by method size; one above the cap is read one 64 KiB chunk past it (no Content-Length). */
  const bySize = (sizes: Record<string, number>) => (label: string, method: string, o: RequestOptions): Reply => {
    const cap = o.byteBudget as number;
    const n = sizes[method] as number;
    const r = n > cap ? cap + 65_536 : n;
    o.onBytes?.(r);
    if (n > cap) { o.onTooLarge?.(cutAfter(r)); return TOO_LARGE; }
    return okAnswer(label);
  };

  it('a read of unknown size never takes the room of a method whose size is known: getBlock\'s first read is refused, so getProgramAccounts (20 MB) still goes (R11-1, red team repro A)', async () => {
    const { time, client, gw, metrics } = setup([pub], { context: 'research', overshootBytes: OVERSHOOT_BYTES });
    client.answer = bySize({ getMultipleAccounts: 8_500_000, getProgramAccounts: 20_000_000, getBlock: 5_000_000 });
    assert.ok((await run(time, gw.call('getMultipleAccounts', [['a']], READ(2)))).ok);
    assert.ok((await run(time, gw.call('getProgramAccounts', ['p'], READ(2)))).ok);      // 20 MB, its size now known: 21.5 MB left
    const tP = client.sent.at(-1)?.at as number;
    // 21.5 MB left minus a reserve of 40 MB (twice getProgramAccounts' answer): no room, nothing sent. Before: it read
    // 10% of the 21.5 MB left less the overshoot (1,887,856) and a chunk, and the next getProgramAccounts was refused.
    assert.deepEqual(await run(time, gw.call('getBlock', [1n], READ(2))), byteBudget(tP + 30_000 - time.now));
    assert.equal(client.sent.length, 2);
    assert.ok((await run(time, gw.call('getProgramAccounts', ['p'], READ(2)))).ok);
    assert.equal(client.sent.at(-1)?.o.byteBudget, 21_500_000);
    assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'public', method: 'getProgramAccounts' }), 0);
  });

  it('ruling 2 protects only methods with an answer in the window: once getProgramAccounts\' answer has left, getBlock\'s first read takes 35 MB and the next getProgramAccounts is refused (R12-1, red team repro D)', async () => {
    const { time, client, gw, metrics } = setup([pub], { context: 'research', overshootBytes: OVERSHOOT_BYTES });
    client.answer = bySize({ getProgramAccounts: 20_000_000, getBlock: 35_000_000 });
    assert.ok((await run(time, gw.call('getProgramAccounts', ['p'], READ(2)))).ok);      // 20 MB, its size now known
    await time.advance(31_000);                                                          // its answer leaves the window
    // An empty window: the reserve is 10% of the 50 MB budget, so getBlock's first read may take 45 MB less the overshoot.
    assert.ok((await run(time, gw.call('getBlock', [1n], READ(2)))).ok);
    assert.equal(client.sent.at(-1)?.o.byteBudget, 45_000_000 - OVERSHOOT_BYTES);
    const tB = client.sent.at(-1)?.at as number;
    // 15 MB left; getProgramAccounts needs 20 MB: refused, nothing sent, until getBlock's answer leaves.
    assert.deepEqual(await run(time, gw.call('getProgramAccounts', ['p'], READ(2))), byteBudget(tB + 30_000 - time.now));
    assert.equal(client.sent.length, 2);
    assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'public', method: 'getProgramAccounts' }), 1);
  });

  it('ruling 2 as written: while another method\'s answers keep twice their size above the bytes left, a method\'s first read is refused every time; it goes once they leave (R11-1)', async () => {
    const { time, client, gw, metrics } = setup([small]);
    const sizes: Record<string, number> = { getBalance: 350, getSlot: 10 };
    client.answer = (label, method, o) => { o.onBytes?.(sizes[method] as number); return okAnswer(label); };
    // getBalance answers 350 bytes every 5 s, so 300-650 bytes are left and the reserve for a getSlot read is 700.
    for (let k = 0; k < 12; k++) {
      assert.ok((await run(time, gw.call('getBalance', ['pk'], READ(2)))).ok);
      const tB = client.sent.at(-1)?.at as number;
      assert.deepEqual(await run(time, slot(gw, READ(3))), byteBudget(tB + 10_000 - time.now));
      await time.advance(5_000);
    }
    assert.equal(client.sent.filter((x) => x.method === 'getSlot').length, 0);
    assert.equal(metrics.count('rpc_byte_budget_refused_total', { provider: 'shyft', method: 'getSlot' }), 12);
    await time.advance(5_000);                                                           // the last 350 leave
    assert.ok((await run(time, slot(gw, READ(3)))).ok);
    assert.equal(client.sent.at(-1)?.o.byteBudget, 900);
  });

  it('an overshoot allowance that leaves an empty byte window less than 1 byte is refused when the gateway is created (R11-2)', () => {
    assert.throws(() => setup([pub], { context: 'research', overshootBytes: 45_000_000 }), RangeError);   // red team repro B
    assert.throws(() => setup([small], { overshootBytes: OVERSHOOT_BYTES }), RangeError);                 // the default on a 1,000-byte budget
    assert.throws(() => setup([PRIMARY, small], { overshootBytes: 900 }), RangeError);
    assert.doesNotThrow(() => setup([small], { overshootBytes: 899 }));                                  // 1 byte of room
    assert.doesNotThrow(() => setup([PRIMARY], { overshootBytes: Number.MAX_SAFE_INTEGER }));            // no byte limit
  });

  it('a byte_budget refusal never carries a non-finite retryAfterMs: with an overshoot seen past an empty window\'s room it is a hold\'s length (R11-2)', async () => {
    const { time, client, gw } = setup([small]);
    client.answer = (label, method, o) => {
      if (method !== 'getBlock') { o.onBytes?.(10); return okAnswer(label); }
      const n = (o.byteBudget as number) + 1_000;                                        // one 1,000-byte chunk past the cap
      o.onBytes?.(n);
      o.onTooLarge?.(cutAfter(n));
      return TOO_LARGE;
    };
    assert.deepEqual(await run(time, gw.call('getBlock', [1n], READ(2))), TOO_LARGE);   // 1,900 read past a cap of 900
    // The allowance is now 1,000, above an empty window's 900: no read of unknown size can go in this process. Before:
    // retryAfterMs was Infinity (JSON null), a 1 ms timer for a caller that waits it.
    for (const call of [() => slot(gw, READ(2)), () => gw.call('getBlock', [1n], READ(2))]) {
      assert.deepEqual(await run(time, call()), byteBudget(OVERSIZED_HOLD_MS));
    }
    await time.advance(OVERSIZED_HOLD_MS);
    assert.deepEqual(await run(time, gw.call('getBlock', [1n], READ(2))), byteBudget(OVERSIZED_HOLD_MS));
    assert.equal(client.sent.length, 1);
  });
});
