// A-M14-03 (card Z08): service HTTP clients and the Jupiter exit budget. Acceptance bullets of SPEC-A A-M14-03 and the
// rate pins of ruling Z08-10 (DexScreener ≤ 150/min) each have a named case. No network: a mock fetch answers.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { monthlyCapOn, openUsageLedger } from '../../src/m14/ledger.ts';
import {
  createServiceClients, EXIT_WORK_EXPIRY_MS, redactUrl, SERVICE_LIMITS, type HttpFetch, type ServiceConfig, type ServiceDeps,
} from '../../src/m14/services.ts';
import { tempDir } from '../helpers.ts';
import { FakeTime, flush, RecordingLog, RecordingMetrics } from './helpers.ts';

const WALL0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const CONFIGS: ServiceConfig[] = [
  { name: 'jupiter', baseUrl: 'https://api.jup.ag', key: { secretRef: 'JUPITER_API_KEY', header: 'x-api-key' } },
  { name: 'dexscreener', baseUrl: 'https://api.dexscreener.com' },
  { name: 'rugcheck', baseUrl: 'https://api.rugcheck.xyz/' },
  { name: 'coingecko', baseUrl: 'https://api.coingecko.com', key: { secretRef: 'COINGECKO_DEMO_KEY', header: 'x-cg-demo-api-key' } },
  { name: 'helius_sender', baseUrl: 'https://sender.example.test' },
];
const SECRETS: Record<string, string> = { JUPITER_API_KEY: 'jup-SECRET-key', COINGECKO_DEMO_KEY: 'cg-SECRET-key' };

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }

function setup(over: Partial<ServiceDeps> & { answer?: (s: Seen) => Response | Promise<Response>; keys?: Record<string, string> } = {}) {
  const time = new FakeTime();
  const log = new RecordingLog();
  const metrics = new RecordingMetrics();
  const seen: Seen[] = [];
  const answer = over.answer ?? (() => new Response('{"ok":true}', { status: 200 }));
  const fetch: HttpFetch = async (url, init) => {
    const s: Seen = { url, method: init.method, headers: init.headers, signal: init.signal, ...(init.body === undefined ? {} : { body: init.body }) };
    seen.push(s);
    return answer(s);
  };
  const keys = over.keys ?? SECRETS;
  const { answer: _a, keys: _k, ...rest } = over;
  const svc = createServiceClients({
    services: CONFIGS, secrets: { get: (n) => keys[n] }, fetch, scheduler: time, nowMs: () => (WALL0 + time.now - 1_000_000) as UnixMs,
    monthly: { take: () => true }, log, metrics, ...rest,
  });
  return { time, log, metrics, seen, svc };
}

/** Settles `p`, advancing the fake clock in 100 ms steps (a call may wait for its window). */
async function settle<T>(time: FakeTime, p: Promise<T>, maxMs = 300_000): Promise<T> {
  let done = false;
  let v: T | undefined;
  void p.then((x) => { done = true; v = x; });
  await flush();
  for (let t = 0; !done && t < maxMs; t += 100) await time.advance(100);
  assert.ok(done, 'did not settle');
  return v as T;
}

const GET = (path: string, endpoint?: 'price' | 'tokens' | 'swap' | 'execute' | 'pairs' | 'profiles') =>
  ({ method: 'GET' as const, path, ...(endpoint === undefined ? {} : { endpoint }) });

describe('A-M14-03 Jupiter exit budget (CA-10)', () => {
  it('acceptance: with an exit marked in flight, a Price V3 call returns exit_reserved immediately (Tokens too); swap still goes', async () => {
    const { svc, seen, metrics, time } = setup();
    svc.beginExitWork('pos-1');
    const t0 = time.now;
    const price = await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 5_000 });
    assert.ok(!price.ok && price.error.code === 'E_RATE_LIMITED' && price.error.message === 'exit_reserved');
    const tokens = await svc.http('jupiter', GET('/tokens/v2/search', 'tokens'), { priority: 2, timeoutMs: 5_000 });
    assert.ok(!tokens.ok && tokens.error.message === 'exit_reserved');
    assert.equal(time.now, t0);
    assert.equal(seen.length, 0);
    assert.equal(metrics.count('jupiter_exit_reserved_total', {}), 2);
    assert.ok((await svc.http('jupiter', GET('/swap/v2/order', 'swap'), { priority: 0, timeoutMs: 5_000 })).ok);
    svc.endExitWork('pos-1');
    assert.ok((await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 5_000 })).ok);
  });

  it('an exit-work key left open expires after 120 s', async () => {
    const { svc, time } = setup();
    svc.beginExitWork('pos-2');
    await time.advance(EXIT_WORK_EXPIRY_MS - 1);
    assert.equal((await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 5_000 })).ok, false);
    await time.advance(1);
    assert.ok((await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 5_000 })).ok);
  });

  it('acceptance: a Jupiter 429 on an exit request returns E_RATE_LIMITED at once (no clock time passes; well within 5 ms)', async () => {
    const { svc, time } = setup({ answer: () => new Response('', { status: 429, headers: { 'retry-after': '30' } }) });
    const t0 = time.now;
    const r = await svc.http('jupiter', GET('/swap/v2/order', 'swap'), { priority: 0, timeoutMs: 5_000 });
    assert.ok(!r.ok && r.error.code === 'E_RATE_LIMITED' && r.error.retryAfterMs === 30_000);
    assert.equal(time.now, t0);                                           // no clock time passed: the call never waited
    // The service is paused: another exit request is refused at once instead of waiting.
    const again = await svc.http('jupiter', GET('/swap/v2/order', 'swap'), { priority: 0, timeoutMs: 5_000 });
    assert.ok(!again.ok && again.error.message === 'no_room_for_exit');
  });
});

describe('A-M14-03 limits (≤ 50% of documented; ruling Z08-10 pins)', () => {
  it('acceptance: 51 CoinGecko calls in a minute at 50/min: the 51st waits for the window', async () => {
    const { svc, time, seen } = setup();
    for (let i = 0; i < 50; i += 1) assert.ok((await svc.http('coingecko', GET('/api/v3/ping'), { priority: 3, timeoutMs: 120_000 })).ok);
    const t0 = time.now;
    const r = await settle(time, svc.http('coingecko', GET('/api/v3/ping'), { priority: 3, timeoutMs: 120_000 }));
    assert.ok(r.ok);
    assert.ok(time.now - t0 >= 60_000 - 100);
    assert.equal(seen.length, 51);
    assert.equal(SERVICE_LIMITS.coingecko.count, 50);
  });

  it('acceptance: with the CoinGecko monthly cap reached every call is refused; a cap that cannot be read refuses too', async () => {
    const path = join(tempDir('z08-cg'), 'rpc-usage.db');
    const capped = setup({ monthly: monthlyCapOn(() => openUsageLedger(path)), coingeckoMonthlyCap: 3 });
    for (let i = 0; i < 3; i += 1) assert.ok((await capped.svc.http('coingecko', GET('/api/v3/ping'), { priority: 3, timeoutMs: 5_000 })).ok);
    const r = await capped.svc.http('coingecko', GET('/api/v3/ping'), { priority: 3, timeoutMs: 5_000 });
    assert.ok(!r.ok && r.error.message === 'monthly_cap');
    // A restart keeps the count (the ledger file).
    const again = setup({ monthly: monthlyCapOn(() => openUsageLedger(path)), coingeckoMonthlyCap: 3 });
    assert.equal((await again.svc.http('coingecko', GET('/api/v3/ping'), { priority: 3, timeoutMs: 5_000 })).ok, false);
    // Next UTC month: free again.
    const next = setup({ monthly: monthlyCapOn(() => openUsageLedger(path)), coingeckoMonthlyCap: 3, nowMs: () => Date.UTC(2026, 10, 1) as UnixMs });
    assert.ok((await next.svc.http('coingecko', GET('/api/v3/ping'), { priority: 3, timeoutMs: 5_000 })).ok);
    let opens = 0;
    const broken = setup({ monthly: monthlyCapOn(() => { opens += 1; throw new Error('unreadable'); }) });
    assert.equal((await broken.svc.http('coingecko', GET('/api/v3/ping'), { priority: 3, timeoutMs: 5_000 })).ok, false);
    assert.equal((await broken.svc.http('coingecko', GET('/api/v3/ping'), { priority: 3, timeoutMs: 5_000 })).ok, false);
    assert.equal(opens, 2);                                               // tried again, never stuck
    assert.throws(() => setup({ coingeckoMonthlyCap: 2_001 }), RangeError);
  });

  it('pin: DexScreener pairs/tokens run at ≤ 150 per minute (151st waits), profiles at 30', async () => {
    assert.deepEqual([SERVICE_LIMITS.dexscreener.pairs.count, SERVICE_LIMITS.dexscreener.pairs.windowMs], [150, 60_000]);
    assert.deepEqual([SERVICE_LIMITS.dexscreener.profiles.count, SERVICE_LIMITS.dexscreener.profiles.windowMs], [30, 60_000]);
    const { svc, time } = setup();
    for (let i = 0; i < 150; i += 1) assert.ok((await svc.http('dexscreener', GET('/tokens/v1/solana/x', 'pairs'), { priority: 3, timeoutMs: 120_000 })).ok);
    const late = await svc.http('dexscreener', GET('/tokens/v1/solana/x'), { priority: 3, timeoutMs: 1_000 });
    assert.ok(!late.ok && late.error.message === 'window_full');          // 151st cannot start within its 1 s timeout
    const t0 = time.now;
    assert.ok((await settle(time, svc.http('dexscreener', GET('/tokens/v1/solana/x'), { priority: 3, timeoutMs: 120_000 }))).ok);
    assert.ok(time.now - t0 >= 59_900);
    for (let i = 0; i < 30; i += 1) assert.ok((await svc.http('dexscreener', GET('/token-profiles/latest/v1', 'profiles'), { priority: 3, timeoutMs: 1_000 })).ok);
    assert.equal((await svc.http('dexscreener', GET('/token-profiles/latest/v1', 'profiles'), { priority: 3, timeoutMs: 1_000 })).ok, false);
    const r = svc.remaining();
    assert.deepEqual(r.find((x) => x.bucket === 'profiles'), { service: 'dexscreener', bucket: 'profiles', left: 0 });
  });

  it('pin: Jupiter keyed 30 / keyless 15 per 60 s, execute 25 / 10 per second; RugCheck 7/min', async () => {
    assert.deepEqual(SERVICE_LIMITS.jupiter.keyed.shared, { count: 30, windowMs: 60_000, fact: 'EX-29' });
    assert.deepEqual(SERVICE_LIMITS.jupiter.keyless.shared, { count: 15, windowMs: 60_000, fact: 'EX-29' });
    assert.equal(SERVICE_LIMITS.rugcheck.count, 7);
    const keyless = setup({ keys: {} });
    for (let i = 0; i < 15; i += 1) assert.ok((await keyless.svc.http('jupiter', GET('/swap/v2/order', 'swap'), { priority: 2, timeoutMs: 1_000 })).ok);
    assert.equal((await keyless.svc.http('jupiter', GET('/swap/v2/order', 'swap'), { priority: 2, timeoutMs: 1_000 })).ok, false);
    assert.equal(keyless.seen[0]?.headers['x-api-key'], undefined);
    for (let i = 0; i < 10; i += 1) assert.ok((await keyless.svc.http('jupiter', { method: 'POST', path: '/swap/v2/execute', endpoint: 'execute', body: { a: 1 } }, { priority: 2, timeoutMs: 500 })).ok);
    assert.equal((await keyless.svc.http('jupiter', { method: 'POST', path: '/swap/v2/execute', endpoint: 'execute' }, { priority: 2, timeoutMs: 500 })).ok, false);
    assert.equal(keyless.seen.at(-1)?.body, '{"a":1}');
    const rug = setup();
    for (let i = 0; i < 7; i += 1) assert.ok((await rug.svc.http('rugcheck', GET('/v1/tokens/x/report/summary'), { priority: 3, timeoutMs: 1_000 })).ok);
    assert.equal((await rug.svc.http('rugcheck', GET('/v1/tokens/x/report/summary'), { priority: 3, timeoutMs: 1_000 })).ok, false);
    assert.equal(rug.seen[0]?.url, 'https://api.rugcheck.xyz/v1/tokens/x/report/summary');
  });

  it('429/403 pause the service for max(Retry-After, back-off); three in ten minutes stop it until resumed', async () => {
    let status = 429;
    const { svc, time, log } = setup({ answer: () => new Response(status === 200 ? '{}' : '', { status, headers: status === 429 ? { 'retry-after': '2' } : {} }) });
    const a = await svc.http('rugcheck', GET('/v1/x'), { priority: 3, timeoutMs: 1_000 });
    assert.ok(!a.ok && a.error.code === 'E_RATE_LIMITED' && a.error.httpStatus === 429);
    const paused = await svc.http('rugcheck', GET('/v1/x'), { priority: 3, timeoutMs: 1_000 });
    assert.ok(!paused.ok && paused.error.message === 'window_full');      // paused 2 s, longer than the 1 s timeout
    await time.advance(2_000);
    status = 403;
    const b = await svc.http('rugcheck', GET('/v1/x'), { priority: 3, timeoutMs: 10_000 });
    assert.ok(!b.ok && b.error.code === 'E_HTTP' && b.error.httpStatus === 403);
    await time.advance(2_000);                                            // back-off 2 s on the second
    status = 429;
    await settle(time, svc.http('rugcheck', GET('/v1/x'), { priority: 3, timeoutMs: 10_000 }));
    assert.ok(log.events.some((e) => e.code === 'm14.service_stopped' && e.level === 'critical'));
    const stopped = await svc.http('rugcheck', GET('/v1/x'), { priority: 3, timeoutMs: 10_000 });
    assert.ok(!stopped.ok && stopped.error.message === 'service_stopped');
    assert.equal(svc.resumeService('rugcheck'), true);
    assert.equal(svc.resumeService('rugcheck'), false);
    assert.equal(svc.resumeService('birdeye'), false);
    status = 200;
    assert.ok((await settle(time, svc.http('rugcheck', GET('/v1/x'), { priority: 3, timeoutMs: 120_000 }))).ok);
  });

  it('Jupiter x-ratelimit-remaining 0 waits for x-ratelimit-reset (Unix seconds, DA-30), at most one window', async () => {
    let reset: string | null = null;
    const { svc, time } = setup({
      answer: () => new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': '0', ...(reset === null ? {} : { 'x-ratelimit-reset': reset }) } }),
    });
    const wallNow = (): number => WALL0 + time.now - 1_000_000;
    reset = String(Math.floor((wallNow() + 5_000) / 1_000));
    assert.ok((await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 1_000 })).ok);
    assert.equal((await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 1_000 })).ok, false);
    await time.advance(5_000);
    reset = 'soon';                                                       // unreadable: the whole window
    assert.ok((await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 1_000 })).ok);
    await time.advance(59_000);
    assert.equal((await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 500 })).ok, false);
    await time.advance(1_000);
    reset = String(Math.floor(wallNow() / 1_000) + 3_600);              // an hour away: capped at one window
    assert.ok((await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 500 })).ok);
    await time.advance(60_000);
    assert.ok((await svc.http('jupiter', GET('/price/v3', 'price'), { priority: 2, timeoutMs: 500 })).ok);
  });
});

describe('A-M14-03 keys and requests', () => {
  it('keys are added by M14 only; a caller passing a secret header or a keyed query parameter is refused', async () => {
    const { svc, seen } = setup();
    assert.ok((await svc.http('jupiter', { ...GET('/price/v3', 'price'), query: { ids: 'mintA,mintB' } }, { priority: 2, timeoutMs: 1_000 })).ok);
    assert.equal(seen[0]?.headers['x-api-key'], 'jup-SECRET-key');
    assert.equal(seen[0]?.url, 'https://api.jup.ag/price/v3?ids=mintA%2CmintB');
    assert.ok((await svc.http('coingecko', GET('/api/v3/ping'), { priority: 3, timeoutMs: 1_000 })).ok);
    assert.equal(seen[1]?.headers['x-cg-demo-api-key'], 'cg-SECRET-key');
    for (const headers of [{ 'X-API-KEY': 'x' }, { Authorization: 'Bearer x' }, { 'x-cg-demo-api-key': 'x' }]) {
      const r = await svc.http('dexscreener', { ...GET('/tokens/v1/solana/x'), headers }, { priority: 3, timeoutMs: 1_000 });
      assert.ok(!r.ok && r.error.message === 'secret_header');
    }
    const q = await svc.http('dexscreener', { ...GET('/tokens/v1/solana/x'), query: { 'api-key': 'x' } }, { priority: 3, timeoutMs: 1_000 });
    assert.ok(!q.ok && q.error.message === 'secret_query');
    const h = await svc.http('dexscreener', { ...GET('/tokens/v1/solana/x'), headers: [] as unknown as Record<string, string> }, { priority: 3, timeoutMs: 1_000 });
    assert.ok(!h.ok && h.error.message === 'bad_headers');
    assert.ok((await svc.http('dexscreener', { ...GET('/x'), headers: { 'user-agent': 'zeroed' } }, { priority: 3, timeoutMs: 1_000 })).ok);
  });

  it('a keyed Sender URL is logged with no key in any line (redactUrl)', () => {
    const log = new RecordingLog();
    const url = 'https://sender.helius-rpc.com/fast?api-key=SENDER-SECRET-123&swqos_only=true';
    log.event('info', 'm14.example', { url: redactUrl(url) });
    log.event('info', 'm14.example', { url: redactUrl('https://user:pw-SECRET@x.example.test/?myKey=SENDER-SECRET-123', ['myKey']) });
    log.event('info', 'm14.example', { url: redactUrl('not a url SENDER-SECRET-123') });
    const text = JSON.stringify(log.events);
    assert.ok(!text.includes('SECRET'), text);
    assert.equal(redactUrl(url), 'https://sender.helius-rpc.com/fast?api-key=[redacted]&swqos_only=true');
  });

  it('paths stay below the base URL; endpoints are checked; unknown services and sends are refused', async () => {
    const { svc, seen } = setup();
    for (const path of ['//evil.test/x', '/a/../b', 'x', '/a?b=1', '/a#b', '/a\\b', '/./a']) {
      const r = await svc.http('dexscreener', GET(path), { priority: 3, timeoutMs: 1_000 });
      assert.ok(!r.ok && r.error.message === 'bad_path', path);
    }
    const noEndpoint = await svc.http('jupiter', GET('/price/v3'), { priority: 2, timeoutMs: 1_000 });
    assert.ok(!noEndpoint.ok && noEndpoint.error.message === 'endpoint_required');
    const badEndpoint = await svc.http('dexscreener', GET('/x', 'swap'), { priority: 2, timeoutMs: 1_000 });
    assert.ok(!badEndpoint.ok && badEndpoint.error.message === 'bad_endpoint');
    const absent = await svc.http('birdeye', GET('/x'), { priority: 2, timeoutMs: 1_000 });
    assert.ok(!absent.ok && absent.error.message === 'service_not_configured');
    for (const s of ['helius_sender', 'jito'] as const) {
      const r = await svc.http(s, GET('/x'), { priority: 0, timeoutMs: 1_000, sendGrantId: 'g' });
      assert.ok(!r.ok && r.error.message === 'send_disabled');
    }
    for (const timeoutMs of [0, Number.NaN, 600_001]) {
      const r = await svc.http('dexscreener', GET('/x'), { priority: 3, timeoutMs });
      assert.ok(!r.ok && r.error.message === 'bad_options');
    }
    assert.equal(seen.length, 0);
  });

  it('answers: non-2xx, too large (declared or read), not JSON, network error and timeout', async () => {
    let mode = 'status';
    const { svc, time } = setup({
      answer: (s) => {
        if (mode === 'status') return new Response('', { status: 500 });
        if (mode === 'declared') return new Response('{}', { status: 200, headers: { 'content-length': String(6 * 1_048_576) } });
        if (mode === 'big') return new Response('x'.repeat(5 * 1_048_576 + 1), { status: 200 });
        if (mode === 'text') return new Response('<html>', { status: 200 });
        if (mode === 'net') throw new TypeError('fetch failed');
        if (mode === 'bodyfail') return new Response(new ReadableStream({ start(c) { c.error(new Error('reset')); } }), { status: 200 });
        return new Promise<Response>((_r, reject) => { s.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
      },
    });
    const call = () => svc.http('dexscreener', GET('/x'), { priority: 3, timeoutMs: 1_000 });
    let r = await call();
    assert.ok(!r.ok && r.error.message === 'http_500' && r.error.httpStatus === 500);
    mode = 'declared'; r = await call();
    assert.ok(!r.ok && r.error.message === 'too_large');
    mode = 'big'; r = await call();
    assert.ok(!r.ok && r.error.message === 'too_large');
    mode = 'text'; r = await call();
    assert.ok(!r.ok && r.error.message === 'not_json');
    mode = 'net'; r = await call();
    assert.ok(!r.ok && r.error.message === 'network_error');
    mode = 'bodyfail'; r = await call();
    assert.ok(!r.ok && r.error.message === 'network_error');
    mode = 'hang';
    const p = svc.http('dexscreener', GET('/x'), { priority: 3, timeoutMs: 1_000 });
    await time.advance(1_000);
    r = await p;
    assert.ok(!r.ok && r.error.code === 'E_TIMEOUT');
  });

  it('config: https only, no duplicates, Birdeye has no configured limit, a key header must be a known secret header', () => {
    const mk = (services: ServiceConfig[]) => () => setup({ services });
    assert.throws(mk([{ name: 'dexscreener', baseUrl: 'http://api.dexscreener.com' }]), /https/);
    assert.throws(mk([{ name: 'dexscreener', baseUrl: 'nope' }]), /not a URL/);
    assert.throws(mk([{ name: 'dexscreener', baseUrl: 'https://a.test' }, { name: 'dexscreener', baseUrl: 'https://a.test' }]), /twice/);
    assert.throws(mk([{ name: 'birdeye', baseUrl: 'https://a.test' }]), /no documented limit/);
    assert.throws(mk([{ name: 'jupiter', baseUrl: 'https://a.test', key: { secretRef: 'K', header: 'x-other' } }]), /secret header/);
  });
});
