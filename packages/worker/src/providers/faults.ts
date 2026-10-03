// Fault-injection seams for unit tests and the fault drills (TEST-3). No network: sockets and HTTP are scripted.
// - `FakeSocketHub`: a socket factory whose connections a test opens, feeds, drops, silences or refuses.
// - `scriptedHttp`: an HTTP client that answers from a handler, with injected timeouts, 429s and delays.
import type { Timers } from '../scheduler/timers.ts';
import type { HttpClient, HttpRequest, HttpResponse, SocketFactory, SocketLike } from './http.ts';

export class FakeSocket implements SocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null = null;
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.closed) throw new Error('send on a closed socket');
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.closed ??= { code, reason };
  }

  /** The server accepts the connection. */
  open(): void {
    this.onopen?.({});
  }

  /** The server sends a frame. */
  push(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v)) });
  }

  /** The server drops the connection (a disconnect, or a refused open when it never opened). */
  drop(code = 1006, reason = 'dropped'): void {
    this.closed ??= { code, reason };
    this.onerror?.({});
    this.onclose?.({ code, reason });
  }

  /** Requests sent so far, parsed. */
  requests(): { id?: number; method: string; params?: unknown[] }[] {
    return this.sent.map((s) => JSON.parse(s) as { id?: number; method: string; params?: unknown[] });
  }
}

export class FakeSocketHub {
  readonly sockets: FakeSocket[] = [];
  /** When set, the factory throws instead of connecting (e.g. DNS failure). */
  refuse = false;

  readonly factory: SocketFactory = (url) => {
    if (this.refuse) throw new Error('connection refused');
    const s = new FakeSocket(url);
    this.sockets.push(s);
    return s;
  };

  get last(): FakeSocket {
    const s = this.sockets.at(-1);
    if (s === undefined) throw new Error('no socket was opened');
    return s;
  }

  /** Sockets not closed by either side. */
  live(): FakeSocket[] {
    return this.sockets.filter((s) => s.closed === null);
  }
}

export type HttpFault =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' }
  | { readonly kind: 'status'; readonly status: number; readonly text?: string; readonly headers?: Readonly<Record<string, string>> };

export const response = (status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): HttpResponse => {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, header: (n) => lower.get(n.toLowerCase()) ?? null, text: typeof body === 'string' ? body : JSON.stringify(body) };
};

/**
 * An HTTP client answered by `handler`. `fault` runs first and can turn any request into a timeout, a network
 * error or a status (429, 500). `delayMs` holds the answer on the injected timers, as a slow provider would.
 */
export const scriptedHttp = (
  handler: (req: HttpRequest) => HttpResponse,
  opts: { readonly fault?: (req: HttpRequest) => HttpFault | null; readonly timers?: Timers; readonly delayMs?: (req: HttpRequest) => number } = {},
): HttpClient & { readonly calls: HttpRequest[] } => {
  const calls: HttpRequest[] = [];
  const client = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    const delay = opts.delayMs?.(req) ?? 0;
    if (delay > 0 && opts.timers) await new Promise<void>((r) => opts.timers!.setTimeout(r, delay));
    const f = opts.fault?.(req) ?? null;
    if (f?.kind === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    if (f?.kind === 'network') throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
    if (f?.kind === 'status') return response(f.status, f.text ?? '', f.headers);
    return handler(req);
  };
  return Object.assign(client, { calls });
};

/** A JSON-RPC handler from a method → result map; unknown methods answer a JSON-RPC error. */
export const rpcHandler = (results: (method: string, params: readonly unknown[]) => unknown) => (req: HttpRequest): HttpResponse => {
  const body = JSON.parse(req.body ?? '{}') as { id: number; method: string; params: unknown[] };
  const result = results(body.method, body.params);
  if (result === undefined) return response(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not scripted' } });
  return response(200, { jsonrpc: '2.0', id: body.id, result });
};
