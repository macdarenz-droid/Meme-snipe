// Card Z03: the C03 read path wired onto Z02 (M25 config, M27 logging and metrics), the default providers at no more
// than 50% of their documented limits, and SPEC-A A-M14-02's owner cap (Chainstack at 0.5 req/s). Fixtures and fakes
// only: no network.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { Config, Result } from '@bot/types';
import { createDecoders, M02_LOG_CODES, readRpcTransaction, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import { M01_LOG_CODES, PROGRAMS } from '@bot/venue/constants';
import type { RequestOptions, RpcClient } from '../../src/m14/client.ts';
import { M14_CONFIG } from '../../src/m14/config.ts';
import { DEFAULT_PROVIDERS } from '../../src/m14/defaults.ts';
import { createRpcGateway, JSON_RPC_NODE_UNHEALTHY, STOP_AFTER_LIMITED } from '../../src/m14/gateway.ts';
import { M14_LOG_CODES } from '../../src/m14/log.ts';
import { envSecrets, loadProviders, maxRpsUnder, P0_READ_METHODS, validateProviderConfigs, withOwnerCap } from '../../src/m14/providers.ts';
import { m14Settings } from '../../src/m14/settings.ts';
import type { CallValue, ProviderConfig, ResolvedProvider, RpcError } from '../../src/m14/types.ts';
import { M24_LOG_CODES } from '../../src/m24/db.ts';
import { resolveConfig } from '../../src/m25/bootstrap.ts';
import { CONFIG_FIELDS } from '../../src/m25/registry.ts';
import { createLogger, M27_LOG_CODES, mergeLogCodes, REDACTED } from '../../src/m27/log.ts';
import { MetricsRegistry } from '../../src/m27/metrics.ts';
import { FakeTime, flush, MemoryStopStore } from './helpers.ts';

type Reply = Result<CallValue<unknown>, RpcError>;

/** A fake client that records each request's start time; `answer` decides the reply. */
class FakeClient implements RpcClient {
  sent: Array<{ label: string; at: number; byteBudget?: number }> = [];
  answer: (label: string) => Reply = (label) => ({ ok: true, value: { value: 1, providerLabel: label, latencyMs: 0, contextSlot: null } });
  private readonly time: FakeTime;
  constructor(time: FakeTime) { this.time = time; }
  async request<T>(p: ResolvedProvider, _m: string, _params: readonly unknown[], o: RequestOptions): Promise<Result<CallValue<T>, RpcError>> {
    this.sent.push({ label: p.config.label, at: this.time.now, ...(o.byteBudget === undefined ? {} : { byteBudget: o.byteBudget }) });
    return this.answer(p.config.label) as Result<CallValue<T>, RpcError>;
  }
}

const registryOf = (configs: readonly ProviderConfig[]) =>
  ({ providers: configs.map((config) => ({ config, url: `https://${config.label}.example.test/` })), disabled: [], warnings: [], liveModesAllowed: true });

/** The real M27 logger and metrics registry, with every Z03 code table merged. */
function m27(time: FakeTime) {
  const lines: Array<Record<string, unknown>> = [];
  const codes = mergeLogCodes(M27_LOG_CODES, M24_LOG_CODES, M14_LOG_CODES, M02_LOG_CODES, M01_LOG_CODES);
  const log = createLogger({ clock: time, codes, runId: 'R', mode: 'paper', sink: { write: (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); return 'written'; } } });
  const metrics = new MetricsRegistry({ clock: time, seriesCap: 1_000, ringBudgetBytes: 0, sink: { append: () => undefined } });
  return { lines, log, metrics };
}

async function settle<T>(time: FakeTime, p: Promise<T>, stepMs = 50, maxMs = 120_000): Promise<T> {   // stepMs 1: inspect a pause before it ends
  let done = false;
  let value: T | undefined;
  void p.then((v) => { done = true; value = v; });
  await flush();
  for (let t = 0; !done && t < maxMs; t += stepMs) await time.advance(stepMs);
  assert.ok(done, 'the call did not settle');
  return value as T;
}

describe('Z03 default providers (A-M14-01 config; owner rule: at most 50% of documented limits)', () => {
  it('validate for the engine: two live read providers, one unmetered primary, no send role', () => {
    const r = validateProviderConfigs(DEFAULT_PROVIDERS, { context: 'engine' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.value.map((c) => c.label), ['shyft', 'chainstack']);
    assert.ok(r.value.every((c) => !c.roles.includes('send')));
  });

  it('every configured rate is at most half of each documented limit, and each limit names its fact', () => {
    for (const c of DEFAULT_PROVIDERS) {
      for (const l of c.documentedLimits) {
        assert.match(l.fact, /^(VF|LD)-\d+$/);
        if (l.scope === 'total') assert.ok(c.limits.rps <= maxRpsUnder(l), `${c.label} ${c.limits.rps} > ${maxRpsUnder(l)}`);
      }
    }
    // Shyft Free 10 req/s [VF-09] → 5; Chainstack Developer 5 RPS [VF-10] → 2.5.
    assert.deepEqual(DEFAULT_PROVIDERS.map((c) => [c.label, c.limits.rps]), [['shyft', 5], ['chainstack', 2.5]]);
  });

  it('acceptance: a Chainstack config of 2.5 req/s runs its bucket at 0.5 req/s (the owner\'s one read every 2 s)', async () => {
    const r = validateProviderConfigs(DEFAULT_PROVIDERS, { context: 'engine' });
    assert.ok(r.ok);
    assert.equal((r.value[1] as ProviderConfig).limits.rps, 0.5);
    const time = new FakeTime();
    const client = new FakeClient(time);
    const { log, metrics } = m27(time);
    const gw = createRpcGateway({ registry: registryOf(r.value), context: 'engine', client, clock: time, scheduler: time, log, metrics,
      stopStore: new MemoryStopStore(), usage: { projectedOver80: () => false } });
    const calls = Array.from({ length: 12 }, () => gw.call('getSlot', [], { priority: 0, role: 'read', commitment: 'confirmed', timeoutMs: 60_000, provider: 'chainstack' }));
    await settle(time, Promise.all(calls));
    const at = client.sent.filter((s) => s.label === 'chainstack').map((s) => s.at);
    assert.equal(at.length, 12);
    for (let i = 1; i < at.length; i++) assert.ok((at[i] as number) - (at[i - 1] as number) >= 2_000, `gap ${i}: ${(at[i] as number) - (at[i - 1] as number)} ms`);
  });

  it('a configured rate above 50% of a documented limit is refused even with a lower owner cap', () => {
    const over = { ...(DEFAULT_PROVIDERS[1] as ProviderConfig), limits: { rps: 2.6, ownerMaxRps: 0.5 } };
    const r = validateProviderConfigs([DEFAULT_PROVIDERS[0], over], { context: 'engine' });
    assert.ok(!r.ok && r.error.problems.some((p) => p.key === 'rpc.providers[1].limits.rps'));
    const bad = { ...(DEFAULT_PROVIDERS[1] as ProviderConfig), limits: { rps: 2.5, ownerMaxRps: 0 } };
    const r2 = validateProviderConfigs([DEFAULT_PROVIDERS[0], bad], { context: 'engine' });
    assert.ok(!r2.ok && r2.error.problems.some((p) => p.key === 'rpc.providers[1].limits.ownerMaxRps'));
  });

  it('the owner cap lowers every rate of the provider and nothing else', () => {
    const c = withOwnerCap({ ...(DEFAULT_PROVIDERS[1] as ProviderConfig), roles: ['read', 'send'], limits: { rps: 2, sendRps: 1, heavyRps: 0.2, perMethodRps: 2, ownerMaxRps: 0.5 } });
    assert.deepEqual(c.limits, { rps: 0.5, ownerMaxRps: 0.5, sendRps: 0.5, heavyRps: 0.2, perMethodRps: 0.5 });
    const plain = DEFAULT_PROVIDERS[0] as ProviderConfig;
    assert.equal(withOwnerCap(plain), plain);
  });
});

describe('Z03 wiring onto M27 (logging and metrics)', () => {
  it('the M14, M02 and M01 code tables merge with M27\'s rules (lower-case module.event, no shadowed field)', () => {
    const codes = mergeLogCodes(M27_LOG_CODES, M14_LOG_CODES, M02_LOG_CODES, M01_LOG_CODES);
    for (const code of Object.keys(codes).filter((c) => !c.startsWith('m27.'))) assert.match(code, /^m(14|02|01)\./);
  });

  it('a 429 with Retry-After: 3 is honoured, logged with its fields and counted; the third in ten minutes stops the provider', async () => {
    const time = new FakeTime();
    const client = new FakeClient(time);
    client.answer = () => ({ ok: false, error: { code: 'E_RATE_LIMITED', message: 'http_429', httpStatus: 429, retryAfterMs: 3_000 } });
    const { lines, log, metrics } = m27(time);
    const research = [{ ...(DEFAULT_PROVIDERS[0] as ProviderConfig) }];
    const gw = createRpcGateway({ registry: registryOf(research), context: 'research', client, clock: time, scheduler: time, log, metrics,
      stopStore: new MemoryStopStore() });
    const call = () => gw.call('getSlot', [], { priority: 3, role: 'read', commitment: 'confirmed', timeoutMs: 120_000 });
    const first = await settle(time, call());
    assert.ok(!first.ok && first.error.code === 'E_RATE_LIMITED' && first.error.retryAfterMs === 3_000);
    const paused = lines.find((l) => l.code === 'm14.provider_paused');
    assert.deepEqual(paused && { provider: paused.provider, pause_ms: paused.pause_ms, http_status: paused.http_status }, { provider: 'shyft', pause_ms: 3_000, http_status: 429 });
    const t1 = time.now;
    await settle(time, call());
    assert.ok((client.sent[1]?.at as number) - t1 >= 3_000, 'the second request waited for Retry-After');
    for (let i = 2; i < STOP_AFTER_LIMITED; i++) await settle(time, call());
    const stopped = lines.find((l) => l.code === 'm14.provider_stopped');
    assert.equal(stopped?.level, 'critical');
    assert.equal(stopped?.reason, 'rate_limited');
    assert.equal(stopped?.limited_in_window, STOP_AFTER_LIMITED);
    assert.ok(!Object.values(stopped ?? {}).includes(REDACTED), 'every field is declared, so none is redacted');
    const sent = client.sent.length;
    const after = await settle(time, call());
    assert.ok(!after.ok && after.error.code === 'E_ALL_PROVIDERS_DOWN');
    assert.equal(client.sent.length, sent, 'a stopped provider gets no request');
    assert.match(metrics.render(), /rpc_429_total\{provider="shyft"\} 3/);
  });

  it('the decoders count events into the M27 registry and log m02.idl_verified with declared fields', () => {
    const time = new FakeTime();
    const { lines, log, metrics } = m27(time);
    const idls = verifyPinnedIdls(VENDORED_IDL_DIR, log);
    assert.ok(idls.ok);
    assert.ok(lines.filter((l) => l.code === 'm02.idl_verified').every((l) => typeof l.program === 'string' && l.program !== REDACTED));
    const d = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 }, metrics });
    const tx = readRpcTransaction('sig', { slot: 1, version: 0, transaction: { message: { accountKeys: [PROGRAMS.pumpCurve], instructions: [] } }, meta: { err: null, fee: 5000, innerInstructions: [] } });
    assert.ok(tx.ok);
    assert.deepEqual(d.decodeTransactionEvents(tx.value), []);
    assert.match(metrics.render(), /decode_gap_total\{reason="no_inner"\} 1/);
  });
});

describe('Z03 wiring onto M25 (config)', () => {
  it('the rpc.* fields resolve to the SPEC-A defaults and m14Settings reads them', () => {
    const resolved = resolveConfig({ 'm24.db_path': '/x/bot.db' }, CONFIG_FIELDS);
    assert.ok(resolved.ok);
    const s = m14Settings({ ...resolved.value, version: 'v' } as Config);
    assert.deepEqual(s, {
      providersFile: '/etc/bot/rpc-providers.json', maxResponseBytes: 52_428_800, p0ReserveBps: 2_000,
      defaultTimeoutMs: { 0: 2_000, 1: 3_000, 2: 5_000, 3: 10_000, 4: 30_000 }, sendEnabled: false,
    });
  });

  it('rpc.p0_reserve_bps keeps 1,000-5,000 and rpc.send_enabled is off by default and raises risk', () => {
    const bad = resolveConfig({ 'm24.db_path': '/x/bot.db', 'rpc.p0_reserve_bps': 6_000 }, CONFIG_FIELDS);
    assert.ok(!bad.ok);
    const send = M14_CONFIG.find((f) => f.key === 'rpc.send_enabled');
    assert.equal(send?.default, false);
    assert.equal(send?.riskDirectionOnIncrease, 'increases_risk');
  });
});

// ---- Z03 round 2 (supervisor rulings 1, 4, m9, m12 of 8 Oct; docs/reviews/Z03.md). Each case fails on 5702022e. ----
describe('Z03 round 2: gateway pauses, served methods, JSON-RPC rate limits, 503 and the allocation', () => {
  const engineOf = (configs: readonly ProviderConfig[], client: FakeClient, time: FakeTime) => {
    const { log, metrics, lines } = m27(time);
    const gw = createRpcGateway({ registry: registryOf(configs), context: 'engine', client, clock: time, scheduler: time, log, metrics,
      stopStore: new MemoryStopStore(), usage: { projectedOver80: () => false } });
    return { gw, lines, metrics };
  };
  const shyft = DEFAULT_PROVIDERS[0] as ProviderConfig;
  const chainstack = DEFAULT_PROVIDERS[1] as ProviderConfig;
  const read = (priority: 0 | 1 | 2 | 3 | 4, extra: Record<string, unknown> = {}) =>
    ({ priority, role: 'read' as const, commitment: 'confirmed' as const, timeoutMs: 60_000, ...extra });

  it('ruling 1: a Retry-After of 0 (or a past date, or junk read as absent) still pauses for the back-off', async () => {
    for (const retryAfterMs of [0, undefined]) {
      const time = new FakeTime();
      const client = new FakeClient(time);
      client.answer = () => ({ ok: false, error: { code: 'E_RATE_LIMITED', message: 'http_429', httpStatus: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } });
      const { gw } = engineOf([shyft, chainstack], client, time);
      await settle(time, gw.call('getSlot', [], read(2)), 1);
      assert.equal((gw.status()[0]?.pausedUntilMs as number) - time.now >= 999, true, `Retry-After ${String(retryAfterMs)}`);
    }
  });

  it('ruling 4: a method a provider does not serve is never sent to it; with no provider serving it the call fails by name', async () => {
    const time = new FakeTime();
    const client = new FakeClient(time);
    const { gw } = engineOf([shyft, chainstack], client, time);
    const opts = { commitment: 'confirmed' as const, timeoutMs: 60_000, role: 'read' as const, priority: 0 as const };
    const r = await settle(time, gw.call('getProgramAccounts', ['x', { encoding: 'base64' }], opts));
    assert.deepEqual(r, { ok: false, error: { code: 'E_RPC', message: 'method_not_served' } });
    assert.equal(client.sent.length, 0);
    const served = { ...chainstack, methods: [...chainstack.methods, 'getProgramAccounts'] };
    const { gw: gw2 } = engineOf([shyft, served], client, time);
    const r2 = await settle(time, gw2.call('getProgramAccounts', ['x', { encoding: 'base64' }], opts));
    assert.ok(r2.ok && r2.value.providerLabel === 'chainstack');
    assert.deepEqual(client.sent.map((s) => s.label), ['chainstack']);
    assert.deepEqual(DEFAULT_PROVIDERS.map((c) => c.methods.includes('getProgramAccounts')), [false, false]);
  });

  it('ruling 4: a JSON-RPC error the provider documents as a rate limit (code and message) pauses, counts toward the stop and fails over', async () => {
    const time = new FakeTime();
    const client = new FakeClient(time);
    client.answer = (label) => (label === 'chainstack'
      ? { ok: false, error: { code: 'E_RPC', message: 'rate limited', rpcCode: -32099 } }
      : { ok: true, value: { value: 1, providerLabel: label, latencyMs: 0, contextSlot: null } });
    // A provider documenting { -32099, "rate limited" } (synthetic: neither default provider documents one; ruling 13).
    const primaryFirst = { ...chainstack, unmeteredPrimary: true, metering: null, failoverOrder: 0, rateLimitRpcErrors: [{ code: -32099, message: 'rate limited' }] };
    const backup = { ...shyft, unmeteredPrimary: false, failoverOrder: 1 };
    const { gw, lines } = engineOf([primaryFirst, backup], client, time);
    const r = await settle(time, gw.call('getSlot', [], read(1)));
    assert.ok(r.ok && r.value.providerLabel === 'shyft', JSON.stringify(r.ok ? r.value.providerLabel : r.error));
    assert.ok((gw.status().find((s) => s.label === 'chainstack')?.recentLimited as number) === 1);
    assert.ok(lines.some((l) => l.code === 'm14.provider_paused' && l.provider === 'chainstack'));
    // A code the provider does not document stays an E_RPC answer: no pause.
    client.answer = () => ({ ok: false, error: { code: 'E_RPC', message: 'other', rpcCode: -32002 } });
    const time2 = new FakeTime();
    const c2 = new FakeClient(time2);
    c2.answer = client.answer;
    const { gw: gw2 } = engineOf([primaryFirst, backup], c2, time2);
    const r2 = await settle(time2, gw2.call('getSlot', [], read(1)));
    assert.deepEqual(r2, { ok: false, error: { code: 'E_RPC', message: 'other', rpcCode: -32002 } });
    assert.equal(gw2.status()[0]?.recentLimited, 0);
  });

  it('ruling 13: Shyft 503, Chainstack HTTP 200 -32005 "Node is behind by 42 slots" on 3 P0 getSlot calls: Chainstack is never stopped', async () => {
    const time = new FakeTime();
    const client = new FakeClient(time);
    client.answer = (label) => (label === 'shyft'
      ? { ok: false, error: { code: 'E_HTTP', message: 'http_503', httpStatus: 503 } }
      : { ok: false, error: { code: 'E_RPC', message: 'Node is behind by 42 slots', rpcCode: JSON_RPC_NODE_UNHEALTHY } });
    const { gw, lines } = engineOf([shyft, chainstack], client, time);
    for (let i = 0; i < 3; i++) {
      const r = await settle(time, gw.call('getSlot', [], read(0)));
      // Both providers were tried: the node-behind answer fails over like a 503 does, and is no rate limit.
      assert.deepEqual(r, { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'all_failed:E_RPC' } }, `call ${i}`);
      await time.advance(3_000);
    }
    const cs = gw.status().find((s) => s.label === 'chainstack');
    assert.deepEqual([cs?.stopped, cs?.recentLimited], [false, 0]);
    assert.ok(!lines.some((l) => l.code === 'm14.provider_stopped' || l.code === 'm14.provider_paused'));
    assert.deepEqual(DEFAULT_PROVIDERS.map((c) => c.rateLimitRpcErrors), [[], []]);
    // A node-behind answer to a P0 read on Chainstack first fails over to Shyft.
    client.answer = (label) => (label === 'shyft'
      ? { ok: true, value: { value: 7, providerLabel: label, latencyMs: 0, contextSlot: null } }
      : { ok: false, error: { code: 'E_RPC', message: 'Node is behind by 42 slots', rpcCode: JSON_RPC_NODE_UNHEALTHY } });
    const first = { ...chainstack, unmeteredPrimary: true, metering: null, failoverOrder: 0 };
    const second = { ...shyft, unmeteredPrimary: false, failoverOrder: 1 };
    const { gw: gw2 } = engineOf([first, second], client, time);
    const r = await settle(time, gw2.call('getSlot', [], read(0)));
    assert.ok(r.ok && r.value.providerLabel === 'shyft');
  });

  it('ruling m9: a 503 with Retry-After pauses that provider (not counted toward the stop)', async () => {
    const time = new FakeTime();
    const client = new FakeClient(time);
    client.answer = () => ({ ok: false, error: { code: 'E_HTTP', message: 'http_503', httpStatus: 503, retryAfterMs: 20_000 } });
    const { gw, lines } = engineOf([shyft, chainstack], client, time);
    await settle(time, gw.call('getSlot', [], read(2)), 1);
    const st = gw.status()[0];
    assert.ok((st?.pausedUntilMs as number) - time.now >= 19_000, String((st?.pausedUntilMs as number) - time.now));
    assert.equal(st?.recentLimited, 0);
    assert.ok(lines.some((l) => l.code === 'm14.provider_paused' && l.http_status === 503 && l.pause_ms === 20_000));
  });

  it('ruling m12: the engine needs the allocation; shares scale every rate; shares above 10,000 or a share of 0 refuse or disable', () => {
    const secrets = envSecrets({ RPC_SHYFT_URL: 'https://shyft.example/k', RPC_CHAINSTACK_URL: 'https://chainstack.example/k' });
    const log = new RecordingLogPort();
    const none = loadProviders(DEFAULT_PROVIDERS, secrets, { context: 'engine', p0ReserveBps: 2_000 }, log);
    assert.ok(!none.ok && none.error.problems[0]?.key === 'rpc.allocation');
    const split = { consumer: 'engine', shares: { shyft: { engine: 8_000, sentinel: 2_000 }, chainstack: { engine: 5_000, sentinel: 4_000, signer: 1_000 } } };
    const ok = loadProviders(DEFAULT_PROVIDERS, secrets, { context: 'engine', p0ReserveBps: 2_000, allocation: split }, log);
    assert.ok(ok.ok);
    assert.deepEqual(ok.value.providers.map((p) => [p.config.label, p.config.limits.rps]), [['shyft', 4], ['chainstack', 0.25]]);
    const over = { consumer: 'engine', shares: { shyft: { engine: 8_000, sentinel: 3_000 }, chainstack: { engine: 10_000 } } };
    const r = loadProviders(DEFAULT_PROVIDERS, secrets, { context: 'engine', p0ReserveBps: 2_000, allocation: over }, log);
    assert.ok(!r.ok && r.error.problems.some((p) => p.key === 'rpc.allocation[shyft]' && /allocation_exceeds_cap/.test(p.message)));
    const sentinelOnly = { consumer: 'sentinel', shares: { shyft: { engine: 10_000 }, chainstack: { engine: 9_000, sentinel: 1_000 } } };
    const s = loadProviders(DEFAULT_PROVIDERS, secrets, { context: 'research', p0ReserveBps: 2_000, allocation: sentinelOnly }, log);
    assert.ok(s.ok);
    assert.deepEqual(s.value.disabled, [{ label: 'shyft', reason: 'no_allocation' }]);
    assert.deepEqual(s.value.providers.map((p) => [p.config.label, p.config.limits.rps]), [['chainstack', 0.05]]);
  });
});

class RecordingLogPort { events: Array<{ code: string }> = []; event(_l: string, code: string): void { this.events.push({ code }); } }

describe('Z03 round 3, ruling 15: byte budgets are split across processes like rate budgets', () => {
  const publicRpc: ProviderConfig = {
    label: 'public', transport: 'https', urlSecretRef: 'RPC_PUBLIC_URL', roles: ['read'], unmeteredPrimary: true, failoverOrder: 0,
    limits: { rps: 5, perMethodRps: 2 }, documentedLimits: [{ scope: 'total', count: 100, windowMs: 10_000, fact: 'LD-26' }],
    methods: ['getSlot'], rateLimitRpcErrors: [], metering: null, allowInLivePaths: false,
  };
  const firstByteBudget = async (shareBps: number): Promise<number | undefined> => {
    const secrets = envSecrets({ RPC_PUBLIC_URL: 'https://api.mainnet-beta.solana.com/' });
    const loaded = loadProviders([publicRpc], secrets, { context: 'research', p0ReserveBps: 2_000, allocation: { consumer: 'research', shares: { public: { research: shareBps, other: 10_000 - shareBps } } } }, new RecordingLogPort());
    assert.ok(loaded.ok);
    assert.equal(loaded.value.providers[0]?.config.budgetShareBps, shareBps);
    const time = new FakeTime();
    const client = new FakeClient(time);
    const { log, metrics } = m27(time);
    const gw = createRpcGateway({ registry: loaded.value, context: 'research', client, clock: time, scheduler: time, log, metrics,
      stopStore: new MemoryStopStore(), overshootBytes: 0 });
    await settle(time, gw.call('getSlot', [], { priority: 3, role: 'read', commitment: 'confirmed', timeoutMs: 60_000 }));
    return client.sent[0]?.byteBudget;
  };

  it('the research process reads public-RPC bytes under its share: 20% of the 50 MB budget, less the 10% reserve', async () => {
    // LD-26: 100 MB per 30 s per IP → 50 MB at the owner's 50%; a read of unknown size keeps a 10% reserve.
    assert.equal(await firstByteBudget(10_000), 45_000_000);
    assert.equal(await firstByteBudget(2_000), 9_000_000);
  });

  it('shares above 10,000 bps on one provider are refused, research included', () => {
    const secrets = envSecrets({ RPC_PUBLIC_URL: 'https://api.mainnet-beta.solana.com/' });
    const r = loadProviders([publicRpc], secrets, { context: 'research', p0ReserveBps: 2_000, allocation: { consumer: 'research', shares: { public: { research: 6_000, engine: 5_000 } } } }, new RecordingLogPort());
    assert.ok(!r.ok && r.error.problems.some((p) => p.key === 'rpc.allocation[public]'));
    const none = loadProviders([publicRpc], secrets, { context: 'research', p0ReserveBps: 2_000 }, new RecordingLogPort());
    assert.ok(!none.ok && none.error.problems[0]?.key === 'rpc.allocation');
  });
});

describe('Z03 round 4: allocation checks (rulings 22, 23, 24)', () => {
  const secrets = envSecrets({ RPC_SHYFT_URL: 'https://shyft.example/k', RPC_CHAINSTACK_URL: 'https://chainstack.example/k' });
  const load = (allocation: unknown, context: 'engine' | 'research' = 'engine') =>
    loadProviders(DEFAULT_PROVIDERS, secrets, { context, p0ReserveBps: 2_000, allocation: allocation as never }, new RecordingLogPort());
  const keys = (r: ReturnType<typeof load>): string[] => (r.ok ? [] : r.error.problems.map((p) => p.key));

  it('ruling 22: a malformed allocation is E_CONFIG, never a TypeError', () => {
    for (const bad of [{ consumer: 'engine' }, { consumer: 'engine', shares: null }, { consumer: 'engine', shares: 7 }, { consumer: 'engine', shares: [] },
      { consumer: 'engine', shares: 'x' }, { shares: {} }, null, 'engine', { consumer: 'engine', shares: { shyft: 5, chainstack: { engine: 10_000 } } }]) {
      let r: ReturnType<typeof load> | undefined;
      assert.doesNotThrow(() => { r = load(bad); }, JSON.stringify(bad));
      assert.ok(r !== undefined && !r.ok && r.error.code === 'E_CONFIG', JSON.stringify(bad));
    }
    assert.deepEqual(keys(load({ consumer: 'engine', shares: [] })), ['rpc.allocation']);
  });

  it('ruling 23: the engine refuses to start with a share of fewer than two live read providers', () => {
    const one = { consumer: 'engine', shares: { shyft: { engine: 10_000 }, chainstack: { sentinel: 10_000 } } };
    assert.deepEqual(keys(load(one)), ['rpc.allocation']);
    const unknownConsumer = { consumer: 'nobody', shares: { shyft: { engine: 10_000 }, chainstack: { engine: 10_000 } } };
    assert.deepEqual(keys(load(unknownConsumer)), ['rpc.allocation']);
    const proto = JSON.parse('{"consumer":"__proto__","shares":{"shyft":{"engine":10000},"chainstack":{"engine":10000}}}') as unknown;
    assert.deepEqual(keys(load(proto)), ['rpc.allocation']);
    const protoShare = JSON.parse('{"consumer":"engine","shares":{"__proto__":{"engine":10000},"shyft":{"engine":10000}}}') as unknown;
    assert.deepEqual(keys(load(protoShare)), ['rpc.allocation']);           // __proto__ names no provider: one live reader
    assert.ok(load({ consumer: 'engine', shares: { shyft: { engine: 5_000 }, chainstack: { engine: 5_000 } } }).ok);
    // A research process may read one provider.
    assert.ok(load({ consumer: 'research', shares: { shyft: { research: 10_000 } } }, 'research').ok);
  });

  it('ruling 24: a nonzero share below one request a minute is refused; 0 turns the provider off', () => {
    // Chainstack runs at 0.5 req/s: 3 bps of it is 0.00015 req/s, about one request every 111 minutes.
    const tiny = { consumer: 'engine', shares: { shyft: { engine: 10_000 }, chainstack: { engine: 3, sentinel: 9_997 } } };
    assert.deepEqual([...new Set(keys(load(tiny)))], ['rpc.allocation[chainstack]']);     // its rate and the part below P0
    // 417 bps of 0.5 req/s is 0.0209 req/s, and its part below P0 (80%) 0.0167 req/s, just above one a minute (ruling
    // 25 counts the part below P0 too: 334 bps, enough before round 5, now leaves it at 0.0134).
    assert.ok(load({ consumer: 'engine', shares: { shyft: { engine: 10_000 }, chainstack: { engine: 417 } } }).ok);
    assert.deepEqual(keys(load({ consumer: 'engine', shares: { shyft: { engine: 10_000 }, chainstack: { engine: 334 } } })), ['rpc.allocation[chainstack]']);
    const off = load({ consumer: 'research', shares: { shyft: { research: 10_000 }, chainstack: { research: 0 } } }, 'research');
    assert.ok(off.ok && off.value.disabled.some((x) => x.label === 'chainstack' && x.reason === 'no_allocation'));
  });
});

describe('Z03 round 5: every scaled rate keeps one request a minute (ruling 25); backups serve every P0 read (ruling 26)', () => {
  const secrets = envSecrets({ RPC_SHYFT_URL: 'https://shyft.example/k', RPC_CHAINSTACK_URL: 'https://chainstack.example/k' });
  const shyft = DEFAULT_PROVIDERS[0] as ProviderConfig;
  const chainstack = DEFAULT_PROVIDERS[1] as ProviderConfig;
  const both = { consumer: 'engine', shares: { shyft: { engine: 5_000 }, chainstack: { engine: 10_000 } } };
  const problems = (configs: ProviderConfig[], allocation = both) => {
    const r = loadProviders(configs, secrets, { context: 'engine', p0ReserveBps: 2_000, allocation }, new RecordingLogPort());
    return r.ok ? [] : r.error.problems.map((p) => `${p.key} ${p.message}`);
  };

  it('ruling 25: Shyft heavyRps 0.01 with a 5,000 bps share is refused', () => {
    const p = problems([{ ...shyft, limits: { rps: 5, heavyRps: 0.01 } }, chainstack]);
    assert.equal(p.length, 1);
    assert.match(p[0] as string, /^rpc\.allocation\[shyft\] .*heavyRps at 0\.005 req\/s/);
  });

  it('ruling 25: perMethodRps, sendRps and the part of rps below P0 are held to the floor too', () => {
    assert.match(problems([{ ...shyft, limits: { rps: 5, perMethodRps: 0.02 } }, chainstack]).join(), /perMethodRps/);
    assert.match(problems([{ ...shyft, roles: ['read', 'send'], limits: { rps: 5, sendRps: 0.02 }, documentedLimits: [...shyft.documentedLimits, { scope: 'send', count: 1, windowMs: 1_000, fact: 'VF-09' }] }, chainstack]).join(), /sendRps/);
    const r = loadProviders([shyft, { ...chainstack, limits: { rps: 2.5, ownerMaxRps: 0.04 } }], secrets,
      { context: 'engine', allocation: { consumer: 'engine', shares: { shyft: { engine: 10_000 }, chainstack: { engine: 5_000 } } }, p0ReserveBps: 5_000 }, new RecordingLogPort());
    // 0.04 req/s × 50% share = 0.02 (above the floor), but its half below P0 is 0.01: refused.
    assert.ok(!r.ok && r.error.problems.some((x) => /rps below P0/.test(x.message)));
  });

  it('ruling 26: a provider serving only getHealth does not count as the engine\'s backup', () => {
    const p = problems([shyft, { ...chainstack, methods: ['getHealth'] }]);
    assert.deepEqual(p.map((x) => x.split(' ')[0]), ['rpc.allocation']);
    assert.match(p[0] as string, /serving every P0 read method; it has 1/);
    assert.deepEqual(P0_READ_METHODS, ['getAccountInfo', 'getMultipleAccounts', 'getTransaction', 'getSlot', 'getSignatureStatuses', 'getLatestBlockhash', 'getTokenAccountBalance']);
    assert.ok(DEFAULT_PROVIDERS.every((c) => P0_READ_METHODS.every((m) => c.methods.includes(m))));
  });
});

describe('Z03 round 5 addendum (rulings 27, 28)', () => {
  it('ruling 27: a listed rate-limit code with a different message is not a rate limit', async () => {
    const time = new FakeTime();
    const client = new FakeClient(time);
    client.answer = () => ({ ok: false, error: { code: 'E_RPC', message: 'Node is behind by 3 slots', rpcCode: -32099 } });
    const listed = { ...(DEFAULT_PROVIDERS[0] as ProviderConfig), rateLimitRpcErrors: [{ code: -32099, message: 'rate limited' }] };
    const { log, metrics, lines } = m27(time);
    const gw = createRpcGateway({ registry: registryOf([listed, DEFAULT_PROVIDERS[1] as ProviderConfig]), context: 'engine', client, clock: time, scheduler: time, log, metrics,
      stopStore: new MemoryStopStore(), usage: { projectedOver80: () => false } });
    const r = await settle(time, gw.call('getSlot', [], { priority: 2, role: 'read', commitment: 'confirmed', timeoutMs: 60_000 }));
    assert.deepEqual(r, { ok: false, error: { code: 'E_RPC', message: 'Node is behind by 3 slots', rpcCode: -32099 } });
    assert.equal(gw.status()[0]?.recentLimited, 0);
    assert.ok(!lines.some((l) => l.code === 'm14.provider_paused'));
  });

  it('ruling 28: shares: { shyft: null } is E_CONFIG, never a TypeError', () => {
    const secrets = envSecrets({ RPC_SHYFT_URL: 'https://shyft.example/k', RPC_CHAINSTACK_URL: 'https://chainstack.example/k' });
    let r: ReturnType<typeof loadProviders> | undefined;
    assert.doesNotThrow(() => {
      r = loadProviders(DEFAULT_PROVIDERS, secrets, { context: 'engine', p0ReserveBps: 2_000, allocation: { consumer: 'engine', shares: { shyft: null, chainstack: { engine: 10_000 } } } as never }, new RecordingLogPort());
    });
    assert.ok(r !== undefined && !r.ok && r.error.problems.some((p) => p.key === 'rpc.allocation[shyft]'));
  });
});

describe('Z03 round 6 (rulings 30, 31)', () => {
  const secrets = envSecrets({ RPC_SHYFT_URL: 'https://shyft.example/k', RPC_CHAINSTACK_URL: 'https://chainstack.example/k' });
  const shyft = DEFAULT_PROVIDERS[0] as ProviderConfig;
  const chainstack = DEFAULT_PROVIDERS[1] as ProviderConfig;

  it('ruling 30: a backup that does not serve getTokenAccountBalance does not count', () => {
    const noBalance = { ...chainstack, methods: chainstack.methods.filter((m) => m !== 'getTokenAccountBalance') };
    const r = loadProviders([shyft, noBalance], secrets, { context: 'engine', p0ReserveBps: 2_000, allocation: { consumer: 'engine', shares: { shyft: { engine: 10_000 }, chainstack: { engine: 10_000 } } } }, new RecordingLogPort());
    assert.ok(!r.ok && r.error.problems.some((p) => p.key === 'rpc.allocation' && /it has 1$/.test(p.message)));
  });

  it('ruling 31: a registry checked at reserve 2,000 is refused by a gateway at 5,000 when a 417 bps Chainstack share falls below the floor', () => {
    const allocation = { consumer: 'engine', shares: { shyft: { engine: 10_000 }, chainstack: { engine: 417 } } };
    const loaded = loadProviders(DEFAULT_PROVIDERS, secrets, { context: 'engine', p0ReserveBps: 2_000, allocation }, new RecordingLogPort());
    assert.ok(loaded.ok);
    const time = new FakeTime();
    const { log, metrics } = m27(time);
    const make = (p0ReserveBps: number) => createRpcGateway({ registry: loaded.value, context: 'engine', client: new FakeClient(time), clock: time, scheduler: time,
      log, metrics, stopStore: new MemoryStopStore(), p0ReserveBps });
    assert.doesNotThrow(() => make(2_000));
    assert.throws(() => make(5_000), /provider chainstack: with rpc\.p0_reserve_bps 5000/);
    // At 5,000 the registry itself refuses the same share; the reserve is required, never a default.
    const at5000 = loadProviders(DEFAULT_PROVIDERS, secrets, { context: 'engine', p0ReserveBps: 5_000, allocation }, new RecordingLogPort());
    assert.ok(!at5000.ok && at5000.error.problems.some((p) => p.key === 'rpc.allocation[chainstack]'));
    const noReserve = loadProviders(DEFAULT_PROVIDERS, secrets, { context: 'engine', allocation } as never, new RecordingLogPort());
    assert.ok(!noReserve.ok && noReserve.error.problems[0]?.key === 'rpc.p0_reserve_bps');
  });
});
