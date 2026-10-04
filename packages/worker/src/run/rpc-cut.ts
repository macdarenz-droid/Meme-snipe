// RUN-1d's drop-rpc drill: every RPC call is refused while the cut lasts (the WebSocket feeds are dropped by the
// worker itself). A refused call fails as a network error, exactly as a provider outage would.
import { type HttpClient, ProviderError } from '../providers/index.ts';
import type { Timers } from '../scheduler/index.ts';

export class RpcCut {
  readonly #timers: Timers;
  #until = 0;

  constructor(timers: Timers) {
    this.#timers = timers;
  }

  cut(ms: number): void {
    this.#until = Math.max(this.#until, this.#timers.now() + ms);
  }

  get down(): boolean {
    return this.#timers.now() < this.#until;
  }

  /** `inner`, refused while the cut lasts. */
  http(inner: HttpClient): HttpClient {
    return async (req) => {
      if (this.down) throw new ProviderError('rpc-cut', 'network', 'every provider cut by the drop-rpc drill');
      return inner(req);
    };
  }
}

/**
 * The process's HTTP clients. Every provider read goes through the cut: the providers' RPC, the dry-run simulator and
 * the fact readers (Helius, RugCheck, GoPlus, Jupiter, Coinbase, GitHub). Only the heartbeat to the watchdog is not a
 * provider and stays up. The facts' client was the raw one, so a drop-rpc drill left their reads working.
 */
export const liveHttp = (cut: RpcCut, base: HttpClient): { readonly providers: HttpClient; readonly facts: HttpClient; readonly heartbeat: HttpClient } => ({
  providers: cut.http(base), facts: cut.http(base), heartbeat: base,
});
