// Mock API (UI-T01): fixture-driven REST and SSE, so the dashboard is built and tested before the backend exists. It
// reads only files under the fixtures directory and makes no network request. Paths follow the PROPOSED contract
// (docs/UI.md, Data freshness model): `GET /api/v1/vm/{VM-nn}` returns `vm/VM-nn.json`; `GET /api/v1/stream` is an SSE
// stream that sends `retry`, then the events of `stream/<script>.json` (`?script=<name>`, each after its `delay_ms`),
// and a heartbeat built from `vm/VM-01.json` every `heartbeatMs`. Each event carries `id: <seq>`; a reconnect with
// `Last-Event-ID: n` continues at n + 1 (UI-F37).
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Clock } from '@bot/types';

export interface MockApiOptions { fixturesDir: string; clock: Clock; heartbeatMs: number; retryMs: number }
type Envelope = Record<string, unknown>;
interface ScriptStep { delay_ms: number; event: Envelope }

const VM_PATH = /^\/api\/v1\/vm\/(VM-\d{2})$/;
const SCRIPT_NAME = /^[a-z0-9-]{1,40}$/;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The SSE frame for one envelope. */
export function sseFrame(seq: bigint, envelope: Envelope): string {
  return `id: ${seq}\nevent: ${String(envelope['kind'])}\ndata: ${JSON.stringify({ ...envelope, seq: String(seq) })}\n\n`;
}

/** The sequence number after `Last-Event-ID` (1 when absent or not a decimal integer). */
export function nextSeq(lastEventId: string | undefined): bigint {
  return lastEventId !== undefined && /^(0|[1-9][0-9]{0,19})$/.test(lastEventId) ? BigInt(lastEventId) + 1n : 1n;
}

/** Returns a request handler for `/api/` paths; it answers every request it is given. */
export function createMockApi(options: MockApiOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const read = (file: string): unknown => JSON.parse(readFileSync(join(options.fixturesDir, file), 'utf8'));
  return (req, res) => {
    const target = req.url ?? '/';
    // A target that is not a URL (a raw `GET // HTTP/1.1`) is answered, never thrown out of the server.
    if (!URL.canParse(target, 'http://127.0.0.1')) return json(res, 400, { error: 'bad_request' });
    const url = new URL(target, 'http://127.0.0.1');
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
    const vm = VM_PATH.exec(url.pathname);
    if (vm !== null) {
      const file = `vm/${vm[1] as string}.json`;
      return existsSync(join(options.fixturesDir, file)) ? json(res, 200, read(file)) : json(res, 404, { error: 'not_found', vm: vm[1] });
    }
    if (url.pathname !== '/api/v1/stream') return json(res, 404, { error: 'not_found' });
    const script = url.searchParams.get('script');
    if (script !== null && (!SCRIPT_NAME.test(script) || !existsSync(join(options.fixturesDir, `stream/${script}.json`)))) {
      return json(res, 404, { error: 'unknown_script' });
    }
    const steps = script === null ? [] : read(`stream/${script}.json`) as ScriptStep[];
    let seq = nextSeq(req.headers['last-event-id'] as string | undefined);
    const send = (envelope: Envelope): void => { res.write(sseFrame(seq, { ...envelope, emitted_at: new Date(options.clock.nowMs()).toISOString() })); seq += 1n; };
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`retry: ${options.retryMs}\n\n`);
    const timers = steps.map((step) => setTimeout(() => send(step.event), step.delay_ms));
    const template = read('vm/VM-01.json') as Envelope;
    const beat = (): void => {
      const now = new Date(options.clock.nowMs()).toISOString();
      send({ ...template, as_of: now, server_time: now });
    };
    beat();
    const heartbeat = setInterval(beat, options.heartbeatMs);
    req.on('close', () => { clearInterval(heartbeat); for (const t of timers) clearTimeout(t); });
  };
}
