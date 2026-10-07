// REPLAY-1000: the worker's HTTP, answered as of the virtual moment of each request. Every answer is delivered after a
// fixed virtual latency through the virtual clock (VirtualClock.reserve), so arrival order never depends on the real
// network. Routes:
// - Helius and Alchemy JSON-RPC: the chain as of the moment (RpcWorld);
// - Coinbase REST candles: only bars closed by the moment;
// - GitHub releases (chain volume): only releases published by the moment, assets as published;
// - RugCheck, GoPlus: the provider's answer read once now, kept only for the mint and freeze authorities, which cannot
//   change after a pump create revokes them (see README "Third parties");
// - Jupiter: refused (its API needs a key, and the bot's keys are never used here);
// - anything else: refused and counted.
import type { HttpClient, HttpRequest, HttpResponse } from '../../../packages/worker/src/providers/http.ts';
import type { PublicRpc } from '../rpc.ts';
import type { VirtualClock } from './vclock.ts';
import type { RpcWorld } from './rpc-world.ts';

export const RPC_LATENCY_MS = 150;
export const REST_LATENCY_MS = 250;

const respond = (status: number, text: string, headers: Record<string, string> = {}): HttpResponse => ({
  status, text, header: (name) => headers[name.toLowerCase()] ?? null,
});

export interface HttpWorldDeps {
  readonly clock: VirtualClock;
  readonly rpc: RpcWorld;
  readonly net: PublicRpc;
  /** Real third-party and public reads, cached on disk under a name (net.cached). */
  readonly fetchJson: (name: string, url: string) => Promise<{ status: number; text: string }>;
  readonly coinbaseCandles: (startIso: string, endIso: string, granularity: number, nowMs: number) => Promise<{ status: number; text: string }>;
  readonly github: (url: string, nowMs: number) => Promise<{ status: number; text: string; headers?: Record<string, string> }>;
}

export class HttpWorld {
  readonly #d: HttpWorldDeps;
  readonly counts = new Map<string, number>();

  constructor(d: HttpWorldDeps) {
    this.#d = d;
  }

  #count(k: string): void {
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  readonly client: HttpClient = (req: HttpRequest): Promise<HttpResponse> => {
    const { clock } = this.#d;
    const t = clock.now();
    const host = new URL(req.url).host;
    const latency = host.includes('helius') || host.includes('alchemy') ? RPC_LATENCY_MS : REST_LATENCY_MS;
    const slot = clock.reserve(t + latency);
    return new Promise<HttpResponse>((resolve) => {
      this.#answer(req, host, t)
        .catch((e: unknown) => respond(599, `replay world error: ${e instanceof Error ? e.message : String(e)}`))
        .then((r) => slot.fill(() => resolve(r)));
    });
  };

  async #answer(req: HttpRequest, host: string, t: number): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (host === 'mainnet.helius-rpc.com' || host === 'solana-mainnet.g.alchemy.com') {
      const body = JSON.parse(req.body ?? '{}') as { id: unknown; method: string; params?: unknown[] };
      this.#count(`rpc:${body.method}`);
      const a = await this.#d.rpc.handle(body.method, body.params ?? [], t);
      return respond(200, JSON.stringify({ jsonrpc: '2.0', id: body.id, ...a }));
    }
    if (host === 'api.exchange.coinbase.com' && url.pathname.endsWith('/candles')) {
      this.#count('coinbase:candles');
      const r = await this.#d.coinbaseCandles(url.searchParams.get('start') ?? '', url.searchParams.get('end') ?? '', Number(url.searchParams.get('granularity') ?? '3600'), t);
      return respond(r.status, r.text);
    }
    if (host === 'api.github.com' || host === 'github.com' || host.endsWith('githubusercontent.com')) {
      this.#count('github');
      const r = await this.#d.github(req.url, t);
      return respond(r.status, r.text, r.headers ?? {});
    }
    if (host === 'api.rugcheck.xyz' || host === 'api.gopluslabs.io') {
      this.#count(host);
      const r = await this.#d.fetchJson(`${host}${url.pathname}${url.search}`, req.url);
      return respond(r.status, r.text);
    }
    this.#count(`refused:${host}`);
    return respond(403, `replay: ${host} is not served`);
  }
}
