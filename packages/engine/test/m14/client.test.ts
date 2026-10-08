// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { createRpcClient, DEFAULT_MAX_RESPONSE_BYTES, parseRetryAfterMs, type RequestOptions, type TooLargeInfo } from '../../src/m14/client.ts';
import { parseJsonLossless } from '../../src/m14/json.ts';
import { REDACTED, scrubberFor, secretParts } from '../../src/m14/redact.ts';
import { MAX_TIMER_MS } from '../../src/m14/timers.ts';
import type { ResolvedProvider } from '../../src/m14/types.ts';
import { FakeTime, hang, json, MockServer, provider, RecordingBus, RecordingLog, RecordingMetrics, rpcResult } from './helpers.ts';

const KEYED_URL = 'https://rpc.example.test/v1/0123456789abcdef?api-key=Kx7q2Zp';
const P: ResolvedProvider = { config: provider({ label: 'shyft', unmeteredPrimary: true }), url: KEYED_URL };
const READ: RequestOptions = { role: 'read', commitment: 'confirmed', timeoutMs: 2_000 };

function setup(maxResponseBytes?: number) {
  const time = new FakeTime();
  const server = new MockServer();
  const bus = new RecordingBus();
  const metrics = new RecordingMetrics();
  const client = createRpcClient({
    fetch: server.fetch, clock: time, scheduler: time, bus, metrics, scrub: scrubberFor([KEYED_URL]),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });
  return { time, server, bus, metrics, client };
}

describe('A-M14-01 JSON-RPC client', () => {
  it('sends JSON-RPC 2.0 with the injected parameters and returns value, label, latency and context slot', async () => {
    const { server, bus, metrics, client } = setup();
    server.route(KEYED_URL, rpcResult({ context: { slot: 453967949 }, value: { lamports: 5 } }));
    const r = await client.request(P, 'getAccountInfo', ['pk', { encoding: 'base64' }], READ);
    assert.ok(r.ok);
    assert.deepEqual(r.value, { value: { context: { slot: 453967949 }, value: { lamports: 5 } }, providerLabel: 'shyft', latencyMs: 0, contextSlot: 453967949n });
    const sent = server.seen[0]?.body;
    assert.equal(sent?.jsonrpc, '2.0');
    assert.equal(sent?.method, 'getAccountInfo');
    assert.deepEqual(sent?.params, ['pk', { encoding: 'base64', commitment: 'confirmed' }]);
    assert.deepEqual(bus.published, [{ topic: 'rpc.context_slot', e: { providerLabel: 'shyft', contextSlot: 453967949n, method: 'getAccountInfo', atMs: 1_000_000 } }]);
    assert.equal(metrics.count('rpc_requests_total', { provider: 'shyft', method: 'getAccountInfo', status: 'ok' }), 1);
    assert.equal(metrics.observations[0]?.name, 'rpc_latency_ms');
  });

  it('every getTransaction request carries maxSupportedTransactionVersion: 1 on the wire', async () => {
    const { server, client } = setup();
    server.route(KEYED_URL, rpcResult(null));
    await client.request(P, 'getTransaction', ['sig', { encoding: 'json', maxSupportedTransactionVersion: 0 }], READ);
    await client.request(P, 'getTransaction', ['sig'], READ);
    for (const s of server.seen) assert.equal((s.body.params[1] as { maxSupportedTransactionVersion: number }).maxSupportedTransactionVersion, 1);
  });

  it('writes bigint parameters as exact JSON integers and reads integers above 2^53 as bigint', async () => {
    const { server, client } = setup();
    let raw = '';
    server.route(KEYED_URL, (req) => {
      raw = JSON.stringify(req.body.params);
      return new Response(`{"jsonrpc":"2.0","id":${req.body.id},"result":{"context":{"slot":7},"value":18446744073709551615}}`);
    });
    const r = await client.request<{ value: bigint }>(P, 'getBalance', ['pk'], READ);
    assert.ok(r.ok);
    assert.equal(r.value.value.value, 18_446_744_073_709_551_615n);
    const b = await client.request(P, 'getBlock', [453967079n], { ...READ, commitment: 'finalized' });
    assert.ok(b.ok);
    assert.match(raw, /^\[453967079,/);
  });

  it('a 429 with Retry-After: 3 is E_RATE_LIMITED with retryAfterMs = 3000', async () => {
    const { server, metrics, client } = setup();
    server.route(KEYED_URL, () => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }));
    const r = await client.request(P, 'getSlot', [], READ);
    assert.deepEqual(r, { ok: false, error: { code: 'E_RATE_LIMITED', message: 'http_429', httpStatus: 429, retryAfterMs: 3000 } });
    assert.equal(metrics.count('rpc_requests_total', { provider: 'shyft', method: 'getSlot', status: 'E_RATE_LIMITED' }), 1);
  });

  it('a 429 without Retry-After has no retryAfterMs; a 403 is E_HTTP and keeps its Retry-After', async () => {
    const { server, client } = setup();
    server.route(KEYED_URL, () => new Response(null, { status: 429 }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_RATE_LIMITED', message: 'http_429', httpStatus: 429 } });
    server.route(KEYED_URL, () => new Response('blocked', { status: 403, headers: { 'retry-after': '10' } }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'http_403', httpStatus: 403, retryAfterMs: 10_000 } });
    server.route(KEYED_URL, () => new Response('oops', { status: 502 }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'http_502', httpStatus: 502 } });
  });

  it('cancels the body of a refused answer even when that body is broken', async () => {
    const { server, client } = setup();
    const broken = () => new ReadableStream({ start(c) { c.error(new TypeError('reset')); } });
    server.route(KEYED_URL, () => new Response(broken(), { status: 429, headers: { 'retry-after': '1' } }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_RATE_LIMITED', message: 'http_429', httpStatus: 429, retryAfterMs: 1000 } });
    server.route(KEYED_URL, () => new Response(broken(), { status: 503 }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'http_503', httpStatus: 503 } });
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    assert.equal(parseRetryAfterMs('3', 0), 3000);
    assert.equal(parseRetryAfterMs(' 0 ', 0), 0);
    assert.equal(parseRetryAfterMs('Wed, 07 Oct 2026 10:00:05 GMT', Date.parse('Wed, 07 Oct 2026 10:00:00 GMT')), 5000);
    assert.equal(parseRetryAfterMs('Wed, 07 Oct 2026 10:00:00 GMT', Date.parse('Wed, 07 Oct 2026 10:00:09 GMT')), 0);
    assert.equal(parseRetryAfterMs('soon', 0), undefined);
    assert.equal(parseRetryAfterMs(null, 0), undefined);
  });

  it('maps a JSON-RPC error to E_RPC with its code kept and the URL and key scrubbed (logs show [redacted])', async () => {
    const { server, client } = setup();
    server.route(KEYED_URL, (req) => json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32015, message: `Transaction version (1) is not supported; endpoint ${KEYED_URL}` } }));
    const r = await client.request(P, 'getTransaction', ['sig'], READ);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'E_RPC');
    assert.equal(r.error.rpcCode, -32015);
    assert.ok(r.error.message.includes(REDACTED));
    assert.ok(!r.error.message.includes('Kx7q2Zp') && !r.error.message.includes('rpc.example.test'));
    server.route(KEYED_URL, (req) => json({ jsonrpc: '2.0', id: req.body.id, error: { code: 'x', message: 7 } }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_RPC', message: 'rpc_error' } });
  });

  it('a response that is not JSON, not an object, or has neither result nor error is E_HTTP', async () => {
    const { server, client } = setup();
    server.route(KEYED_URL, () => new Response('<html>'));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'not_json', httpStatus: 200 } });
    server.route(KEYED_URL, () => new Response('[1]'));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'bad_response', httpStatus: 200 } });
    server.route(KEYED_URL, (req) => json({ jsonrpc: '2.0', id: req.body.id }));            // echoes the id (Z03 m8)
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'bad_response', httpStatus: 200 } });
    server.route(KEYED_URL, (req) => json({ jsonrpc: '2.0', id: req.body.id, error: null, result: 9 }));
    const r = await client.request(P, 'getSlot', [], READ);
    assert.ok(r.ok && r.value.value === 9 && r.value.contextSlot === null);
  });

  it('a response larger than the cap is aborted as E_HTTP too_large (declared or streamed)', async () => {
    const { server, client } = setup(64);
    server.route(KEYED_URL, () => new Response('x'.repeat(65), { headers: { 'content-length': '65' } }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'too_large', httpStatus: 200 } });
    server.route(KEYED_URL, () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(40))); c.enqueue(new TextEncoder().encode('y'.repeat(40))); c.close(); },
    })));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'too_large', httpStatus: 200 } });
    // A per-call cap above the default lets an enumeration read more (A-M03-03).
    server.route(KEYED_URL, (req) => json({ jsonrpc: '2.0', id: req.body.id, result: 'z'.repeat(100) }));
    assert.ok((await client.request(P, 'getSlot', [], { ...READ, maxResponseBytes: 1_000 })).ok);
    assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 52_428_800);
    assert.throws(() => createRpcClient({ fetch: server.fetch, clock: new FakeTime(), scheduler: new FakeTime(), bus: new RecordingBus(), metrics: new RecordingMetrics(), scrub: (s) => s, maxResponseBytes: 0 }), RangeError);
  });

  it('reports the body bytes read and aborts an answer above the byte budget (review C03 R3)', async () => {
    const { server, client } = setup();
    const counted: number[] = [];
    const onBytes = (n: number): void => { counted.push(n); };
    const body = (req: { body: { id: number } }): string => JSON.stringify({ jsonrpc: '2.0', id: req.body.id, result: 'z'.repeat(100) });
    server.route(KEYED_URL, (req) => new Response(body(req)));
    assert.ok((await client.request(P, 'getSlot', [], { ...READ, onBytes, byteBudget: 1_000 })).ok);
    assert.deepEqual(counted, [body({ body: { id: 1 } }).length]);
    // The budget wins over every cap: a streamed answer stops at the chunk that crosses it; a declared one is not read.
    server.route(KEYED_URL, () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(40))); c.enqueue(new TextEncoder().encode('y'.repeat(40))); c.close(); },
    })));
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, onBytes, byteBudget: 50, maxResponseBytes: 1_000 }),
      { ok: false, error: { code: 'E_HTTP', message: 'too_large', httpStatus: 200 } });
    assert.deepEqual(counted.slice(1), [80]);
    server.route(KEYED_URL, () => new Response('x'.repeat(65), { headers: { 'content-length': '65' } }));
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, onBytes, byteBudget: 64 }), { ok: false, error: { code: 'E_HTTP', message: 'too_large', httpStatus: 200 } });
    assert.equal(counted.length, 2);
    // A connection lost mid-body still reports what was read.
    let pulls = 0;
    server.route(KEYED_URL, () => new Response(new ReadableStream({
      pull(c) { if (pulls++ === 0) c.enqueue(new TextEncoder().encode('{"a"')); else c.error(new TypeError('reset')); },
    })));
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, onBytes }), { ok: false, error: { code: 'E_HTTP', message: 'network_error' } });
    assert.deepEqual(counted.slice(2), [4]);
  });

  it('tells how a too_large answer was refused: its least size, on a declared length or not, and above its own cap or only the budget (review C03 N1, red team R8-2)', async () => {
    const { server, client } = setup(64);                                                  // the client's own cap: 64 bytes
    const seen: TooLargeInfo[] = [];
    const onTooLarge = (t: TooLargeInfo): void => { seen.push(t); };
    const TOO_LARGE = { ok: false, error: { code: 'E_HTTP', message: 'too_large', httpStatus: 200 } };
    server.route(KEYED_URL, () => new Response('x'.repeat(700), { headers: { 'content-length': '700' } }));
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, onTooLarge, byteBudget: 300, maxResponseBytes: 1_000 }), TOO_LARGE);
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, onTooLarge, byteBudget: 300 }), TOO_LARGE);
    server.route(KEYED_URL, () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(40))); c.enqueue(new TextEncoder().encode('y'.repeat(40))); c.close(); },
    })));
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, onTooLarge, byteBudget: 50, maxResponseBytes: 1_000 }), TOO_LARGE);
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, onTooLarge }), TOO_LARGE);
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, onTooLarge, byteBudget: 64 }), TOO_LARGE);   // budget = own cap
    server.route(KEYED_URL, (req) => json({ jsonrpc: '2.0', id: req.body.id, result: 1 }));
    assert.ok((await client.request(P, 'getSlot', [], { ...READ, onTooLarge })).ok);       // not called for an answer read in full
    assert.deepEqual(seen, [
      { atLeastBytes: 700, declared: true, overOwnCap: false },                             // the budget refused it; 1,000 would read it
      { atLeastBytes: 700, declared: true, overOwnCap: true },
      { atLeastBytes: 80, declared: false, overOwnCap: false },
      { atLeastBytes: 80, declared: false, overOwnCap: true },                              // cut at its own cap: it can never succeed
      { atLeastBytes: 80, declared: false, overOwnCap: true },
    ]);
  });

  it('refuses a timeout Node timers cannot keep (above 2^31 − 1 ms) before any request (review C03 R7)', async () => {
    const { server, client } = setup();
    server.route(KEYED_URL, rpcResult(1));
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, timeoutMs: 3e9 }), { ok: false, error: { code: 'E_RPC', message: 'bad_options' } });
    assert.deepEqual(await client.request(P, 'getSlot', [], { ...READ, timeoutMs: 0 }), { ok: false, error: { code: 'E_RPC', message: 'bad_options' } });
    assert.equal(server.seen.length, 0);
    assert.ok((await client.request(P, 'getSlot', [], { ...READ, timeoutMs: MAX_TIMER_MS })).ok);
  });

  it('measures latency on the monotonic clock, so a wall-clock step does not distort it (review C03 R5)', async () => {
    const time = new FakeTime();
    const server = new MockServer();
    const metrics = new RecordingMetrics();
    let wall = 5_000_000;
    const client = createRpcClient({ fetch: server.fetch, clock: { kind: 'wall', nowMs: () => wall as UnixMs }, scheduler: time, bus: new RecordingBus(), metrics, scrub: (x) => x });
    server.route(KEYED_URL, async (req) => {
      wall -= 3_600_000;                                                  // NTP steps the wall clock back an hour
      await new Promise<void>((r) => time.set(r, 120));
      return json({ jsonrpc: '2.0', id: req.body.id, result: 1 });
    });
    const p = client.request(P, 'getSlot', [], READ);
    await time.advance(120);
    const r = await p;
    assert.ok(r.ok && r.value.latencyMs === 120, JSON.stringify(r));
    assert.equal(metrics.observations[0]?.value, 120);
  });

  it('times out through AbortController (E_TIMEOUT), before or during the body', async () => {
    const { time, server, client } = setup();
    server.route(KEYED_URL, hang);
    const p = client.request(P, 'getSlot', [], { ...READ, timeoutMs: 500 });
    await time.advance(499);
    assert.equal(server.seen.length, 1);
    await time.advance(1);
    assert.deepEqual(await p, { ok: false, error: { code: 'E_TIMEOUT', message: 'timeout' } });
    server.route(KEYED_URL, (req) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"jsonrpc":'));
        req.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    })));
    const q = client.request(P, 'getSlot', [], { ...READ, timeoutMs: 500 });
    await time.advance(500);
    assert.deepEqual(await q, { ok: false, error: { code: 'E_TIMEOUT', message: 'timeout' } });
    assert.equal(time.pending(), 0);
  });

  it('a network error is E_HTTP network_error, before or during the body', async () => {
    const { server, client } = setup();
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'network_error' } });
    server.route(KEYED_URL, () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('socket hang up')); } })));
    // No httpStatus: the gateway treats it like any network error and fails over (review C03-R1-2).
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'network_error' } });
  });

  it('refuses bad parameters before any request (E_RPC)', async () => {
    const { server, client } = setup();
    assert.deepEqual(await client.request(P, 'getSlot', [], { role: 'read', timeoutMs: 1 }), { ok: false, error: { code: 'E_RPC', message: 'missing_commitment' } });
    assert.equal(server.seen.length, 0);
  });

  it('handles an empty body and ignores context slots that are not slots', async () => {
    const { server, client } = setup();
    server.route(KEYED_URL, () => new Response(null, { status: 200 }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'not_json', httpStatus: 200 } });
    for (const result of [{ context: null }, { context: { x: 1 } }, { context: { slot: -1 } }, { context: { slot: 1.5 } }, { context: { slot: 'x' } }, 5]) {
      server.route(KEYED_URL, (req) => json({ jsonrpc: '2.0', id: req.body.id, result }));
      const r = await client.request(P, 'getSlot', [], READ);
      assert.ok(r.ok && r.value.contextSlot === null, JSON.stringify(result));
    }
    server.route(KEYED_URL, (req) => new Response(`{"jsonrpc":"2.0","id":${req.body.id},"result":{"context":{"slot":18446744073709551615}}}`));
    const big = await client.request(P, 'getSlot', [], READ);
    assert.ok(big.ok && big.value.contextSlot === 18_446_744_073_709_551_615n);
  });
});

describe('A-M14-01 redaction (logic 2)', () => {
  it('scrubs the URL, its path and query parts, keyed parameters, and truncates to 200 characters', () => {
    const scrub = scrubberFor([KEYED_URL, 'https://user:pw-secret@chainstack.example/abcdefghijk']);
    assert.equal(scrub(`failed at ${KEYED_URL} now`), `failed at ${REDACTED} now`);
    assert.equal(scrub('see rpc.example.test/v1/0123456789abcdef'), `see ${REDACTED}`);
    assert.equal(scrub('key Kx7q2Zp leaked'), `key ${REDACTED} leaked`);
    assert.equal(scrub('path 0123456789abcdef'), `path ${REDACTED}`);
    const keyed = scrub('other https://x.example/?token=abc&api_key=def');
    assert.ok(keyed.startsWith('other https://x.example/?token=') && !keyed.includes('abc') && !keyed.includes('def'));
    assert.equal(keyed.split(REDACTED).length, 3);
    assert.equal(scrub('auth pw-secret'), `auth ${REDACTED}`);
    assert.equal(scrub('a'.repeat(300)).length, 200);
    assert.deepEqual(secretParts('not a url'), ['not%20a%20url', 'not a url']);
    const parts = secretParts('https://h.example/?v=1&key=ab&cluster=mainnet');
    for (const p of ['https://h.example/?v=1&key=ab&cluster=mainnet', 'v=1&key=ab&cluster=mainnet', 'https://h.example/', 'h.example/', 'h.example', 'mainnet', 'ab']) {
      assert.ok(parts.includes(p), p);
    }
    assert.ok(!parts.includes('1') && !parts.includes('v=1'));
    assert.deepEqual(parts, [...parts].sort((a, b) => b.length - a.length));
    assert.equal(scrubberFor([''])('abc'), 'abc');
  });

  it('scrubs percent-encoded parts, path keys from 4 characters and the host (review C03 R10)', () => {
    const scrub = scrubberFor(['https://mainnet.helius-rpc.com/?api-key=ab-c/ef', 'https://x.solana-mainnet.quiknode.pro/abc1234/', 'https://abcdef0123456789.rpc.example/v1/k%2Fy9']);
    assert.equal(scrub('see https%3A%2F%2Fmainnet.helius-rpc.com%2F%3Fapi-key%3Dab-c%2Fef'), `see ${REDACTED}`);
    assert.equal(scrub('key ab-c%2Fef bad'), `key ${REDACTED} bad`);
    assert.equal(scrub('key ab-c%2fef bad'), `key ${REDACTED} bad`);
    assert.equal(scrub('path /abc1234/ here'), `path /${REDACTED}/ here`);
    assert.equal(scrub('host abcdef0123456789.rpc.example'), `host ${REDACTED}`);
    assert.equal(scrub('decoded k/y9 and encoded k%2Fy9'), `decoded ${REDACTED} and encoded ${REDACTED}`);
    assert.equal(scrub('version v1 ok'), 'version v1 ok');                 // segments under 4 characters stay
    const malformed = secretParts('https://h.example/%zzabc');            // a malformed escape: the raw segment only
    assert.ok(malformed.includes('%zzabc') && malformed.includes('%25zzabc'));
  });

  it('scrubs a query value as written, with its + kept, as well as decoded (review C03 N3)', () => {
    const scrub = scrubberFor(['https://rpc.example.test/?api-key=A1+c/E=&cluster=main+net&token=x%2By+z&bad=%zz12&Bare9key']);
    assert.equal(scrub('bare Bare9key'), `bare ${REDACTED}`);                 // a parameter without `=` is all value
    assert.equal(scrub('invalid api key A1+c/E='), `invalid api key ${REDACTED}`);
    assert.equal(scrub('invalid api key A1 c/E='), `invalid api key ${REDACTED}`);
    assert.equal(scrub('key A1%2Bc%2FE%3D'), `key ${REDACTED}`);
    assert.equal(scrub('cluster main+net'), `cluster ${REDACTED}`);
    for (const t of ['x%2By+z', 'x+y+z', 'x+y z']) assert.equal(scrub(`token ${t}`), `token ${REDACTED}`, t);
    assert.equal(scrub('value %zz12'), `value ${REDACTED}`);                 // a malformed escape: the raw value
  });
});

describe('A-M14-01 secrets scan of everything the client emits', () => {
  it('no URL or key reaches errors, metrics, events or logs', async () => {
    const { server, bus, metrics, client } = setup();
    const log = new RecordingLog();
    const replies = [
      () => new Response(`bad ${KEYED_URL}`, { status: 500 }),
      (id: number) => json({ jsonrpc: '2.0', id, error: { code: -32000, message: `upstream ${KEYED_URL} failed for api-key=Kx7q2Zp` } }),
      (id: number) => json({ jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: null } }),
    ];
    const outputs: unknown[] = [];
    for (const reply of replies) {
      server.route(KEYED_URL, (req) => reply(req.body.id));
      const r = await client.request(P, 'getAccountInfo', ['pk', { encoding: 'base64' }], READ);
      outputs.push(r);
      if (!r.ok) log.event('warn', 'm14.call_failed', { provider: P.config.label, code: r.error.code, message: r.error.message });
    }
    const captured = JSON.stringify({ outputs, bus: bus.published, metrics: [...metrics.counts.keys()], obs: metrics.observations, log: log.events },
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    for (const s of secretParts(KEYED_URL)) assert.ok(!captured.includes(s), `leaked ${s.length}-char secret part`);
  });
});

describe('lossless JSON', () => {
  it('keeps safe integers and fractions as numbers', () => {
    assert.deepEqual(parseJsonLossless('{"a":1,"b":1.5,"c":"18446744073709551615"}'), { a: 1, b: 1.5, c: '18446744073709551615' });
    assert.deepEqual(parseJsonLossless('[9007199254740993, 1e300, 1234567890123456.5]'), [9_007_199_254_740_993n, 1e300, 1234567890123456.5]);
  });
});

describe('Z03 round 2: Retry-After forms and the JSON-RPC envelope (rulings 1, m8)', () => {
  it('Retry-After is delta-seconds or an IMF-fixdate; every other form counts as absent', () => {
    const now = Date.parse('Thu, 08 Oct 2026 10:00:00 GMT');
    assert.equal(parseRetryAfterMs('3', now), 3_000);
    assert.equal(parseRetryAfterMs('0', now), 0);
    assert.equal(parseRetryAfterMs('Thu, 08 Oct 2026 10:00:07 GMT', now), 7_000);
    assert.equal(parseRetryAfterMs('Wed, 07 Oct 2026 10:00:00 GMT', now), 0);          // a past date: 0, never negative
    for (const junk of ['-5', '1.5', 'garbage 7', '7 garbage', '2026-10-08T10:00:07Z', 'Thursday, 08-Oct-26 10:00:07 GMT', '']) {
      assert.equal(parseRetryAfterMs(junk, now), undefined, junk);
    }
  });

  it('an answer with another id or without jsonrpc "2.0" is a protocol error', async () => {
    const { server, client } = setup();
    server.route(KEYED_URL, (req) => json({ jsonrpc: '2.0', id: req.body.id + 1, result: 1 }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'protocol_error', httpStatus: 200 } });
    server.route(KEYED_URL, (req) => json({ jsonrpc: '1.0', id: req.body.id, result: 1 }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'protocol_error', httpStatus: 200 } });
    server.route(KEYED_URL, (req) => json({ id: req.body.id, result: 1 }));
    assert.deepEqual(await client.request(P, 'getSlot', [], READ), { ok: false, error: { code: 'E_HTTP', message: 'protocol_error', httpStatus: 200 } });
    server.route(KEYED_URL, (req) => json({ jsonrpc: '2.0', id: req.body.id, result: 1 }));
    assert.ok((await client.request(P, 'getSlot', [], READ)).ok);
  });
});
