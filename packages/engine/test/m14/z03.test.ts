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
import { createRpcGateway, STOP_AFTER_LIMITED } from '../../src/m14/gateway.ts';
import { M14_LOG_CODES } from '../../src/m14/log.ts';
import { maxRpsUnder, validateProviderConfigs, withOwnerCap } from '../../src/m14/providers.ts';
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
  sent: Array<{ label: string; at: number }> = [];
  answer: (label: string) => Reply = (label) => ({ ok: true, value: { value: 1, providerLabel: label, latencyMs: 0, contextSlot: null } });
  private readonly time: FakeTime;
  constructor(time: FakeTime) { this.time = time; }
  async request<T>(p: ResolvedProvider, _m: string, _params: readonly unknown[], _o: RequestOptions): Promise<Result<CallValue<T>, RpcError>> {
    this.sent.push({ label: p.config.label, at: this.time.now });
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

async function settle<T>(time: FakeTime, p: Promise<T>, stepMs = 50, maxMs = 120_000): Promise<T> {
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
