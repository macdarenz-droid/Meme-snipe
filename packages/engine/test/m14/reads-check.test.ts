// The M0 exit read check (reads-check.ts): both providers pass, one fails, and no URL or key appears in the output.
import { describe, expect, it } from 'vitest';
import { runReadCheck, type ReadCheckResult } from '../../src/m14/reads-check.ts';
import { FakeTime, MockServer, flush, json } from './helpers.ts';

const SHYFT = 'https://rpc.shyft.example/shyft-secret-key-1';
const CHAIN = 'https://chainstack.example/chainstack-secret-path-2';
const env = { RPC_SHYFT_URL: SHYFT, RPC_CHAINSTACK_URL: CHAIN };

const methodAnswer = (slot: number) => ((req: { body: { id: number; method: string } }) =>
  json({ jsonrpc: '2.0', id: req.body.id, result: req.body.method === 'getHealth' ? 'ok' : slot }));

async function run(server: MockServer, e: Record<string, string | undefined> = env): Promise<ReadCheckResult> {
  const time = new FakeTime();
  let done: ReadCheckResult | undefined;
  const p = runReadCheck({ env: e, fetch: server.fetch, clock: time, scheduler: time }).then((r) => { done = r; });
  for (let i = 0; i < 400 && done === undefined; i++) { await time.advance(500); await flush(); }
  await p;
  return done!;
}

describe('M0 exit read check', () => {
  it('passes when both providers answer getSlot and getHealth', async () => {
    const server = new MockServer();
    server.route(SHYFT, methodAnswer(111));
    server.route(CHAIN, methodAnswer(222));
    const r = await run(server);
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(['shyft PASS slot=111 latency_ms=0', 'chainstack PASS slot=222 latency_ms=0']);
    expect(server.seen.filter((s) => s.url === SHYFT).map((s) => s.body.method)).toEqual(['getSlot', 'getHealth']);
    expect(server.seen.filter((s) => s.url === CHAIN).map((s) => s.body.method)).toEqual(['getSlot', 'getHealth']);
  });

  it('fails when one provider is down, and still reports the other', async () => {
    const server = new MockServer();
    server.route(SHYFT, methodAnswer(111));
    server.route(CHAIN, (req) => json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32000, message: `boom ${CHAIN}` } }));
    const r = await run(server);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/^shyft PASS slot=111 /);
    expect(r.lines[1]).toBe('chainstack FAIL slot=- latency_ms=-');
  });

  it('fails a provider whose secret is missing', async () => {
    const server = new MockServer();
    server.route(SHYFT, methodAnswer(111));
    const r = await run(server, { RPC_SHYFT_URL: SHYFT });
    expect(r.ok).toBe(false);
    expect(r.lines[1]).toBe('chainstack FAIL slot=- latency_ms=-');
  });

  it('never prints a URL, key or path, on pass or fail', async () => {
    const server = new MockServer();
    server.route(SHYFT, methodAnswer(111));
    server.route(CHAIN, (req) => json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32000, message: `${CHAIN} ${SHYFT}` } }));
    const text = (await run(server)).lines.join('\n');
    for (const s of ['https', 'example', 'shyft-secret-key-1', 'chainstack-secret-path-2']) expect(text).not.toContain(s);
  });
});
