// The only network code of TX-1: JSON-RPC over HTTPS to Helius Sender and our RPC. Everything it sends was planned
// by landing.ts; tests use a stub `Transport` and never reach the network.
import type { HttpCall } from '../landing.ts';

export type TransportResult =
  | { readonly kind: 'ok'; readonly result: unknown }
  | { readonly kind: 'rpc-error'; readonly message: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'http-error'; readonly status: number };

export interface Transport {
  call(call: HttpCall): Promise<TransportResult>;
}

/** `timeoutMs` bounds each call; a timeout is reported as such (the outcome is unknown, never "failed"). */
export const httpTransport = (timeoutMs: number): Transport => ({
  async call(c: HttpCall): Promise<TransportResult> {
    let res: Response;
    try {
      res = await fetch(c.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(c.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      // An abort or a dropped connection: the request may or may not have reached the node.
      return name === 'TimeoutError' || name === 'AbortError' ? { kind: 'timeout' } : { kind: 'rpc-error', message: (e as Error).message };
    }
    if (!res.ok) return { kind: 'http-error', status: res.status };
    let body: { result?: unknown; error?: { message?: string } };
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      return { kind: 'rpc-error', message: `unreadable response: ${(e as Error).message}` };
    }
    if (body.error) return { kind: 'rpc-error', message: body.error.message ?? JSON.stringify(body.error) };
    return { kind: 'ok', result: body.result };
  },
});
