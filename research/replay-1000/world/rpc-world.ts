// REPLAY-1000: the Solana JSON-RPC as it would have answered at a virtual moment. Each method reads the chain as of
// the confirmed slot of that moment (ChainView). State that cannot be rebuilt exactly as of that slot is refused with
// a JSON-RPC error, so the bot reads it as a failed read and refuses the coin itself (fail closed); every refusal is
// counted by reason (`refusals`).
import type { ChainView } from './chain.ts';
import type { AccountWorld } from './accounts.ts';

export interface RpcAnswer {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** The code the world refuses with: no node ever sends it, so a refusal is never mistaken for a provider error. */
export const REFUSED = -32099;

export class Refused extends Error {
  readonly reason: string;
  constructor(reason: string, detail = '') {
    super(`${reason}${detail === '' ? '' : `: ${detail}`}`);
    this.reason = reason;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export class RpcWorld {
  readonly #chain: ChainView;
  readonly #accounts: AccountWorld;
  readonly refusals = new Map<string, number>();
  readonly calls = new Map<string, number>();
  /** The last few refusals with detail, for the run log. */
  readonly recent: string[] = [];

  constructor(chain: ChainView, accounts: AccountWorld) {
    this.#chain = chain;
    this.#accounts = accounts;
  }

  #refuse(method: string, e: unknown): RpcAnswer {
    const reason = e instanceof Refused ? e.reason : 'world-error';
    const key = `${method}:${reason}`;
    this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
    const msg = e instanceof Error ? e.message : String(e);
    this.recent.push(`${method} ${msg}`);
    if (this.recent.length > 200) this.recent.shift();
    return { error: { code: REFUSED, message: `replay: ${msg}` } };
  }

  /** One call at virtual time `ms`. `commitment` decides the as-of slot (processed: produced by then; else confirmed). */
  async handle(method: string, params: readonly unknown[], ms: number): Promise<RpcAnswer> {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    const cfg = params.find(isObj) as Obj | undefined;
    const processed = cfg?.['commitment'] === 'processed';
    const asOf = processed ? this.#chain.clock.slotAt(ms) : this.#chain.confirmedSlot(ms);
    const min = typeof cfg?.['minContextSlot'] === 'number' ? (cfg['minContextSlot'] as number) : null;
    // A node behind the asked slot refuses (-32016), as live: the bot's read fails and it reads again later.
    if (min !== null && min > asOf) return { error: { code: -32016, message: `Minimum context slot has not been reached` } };
    try {
      switch (method) {
        case 'getTransaction': {
          const t = await this.#chain.transaction(params[0] as string, asOf);
          return { result: t };
        }
        case 'getSignaturesForAddress': {
          const limit = typeof cfg?.['limit'] === 'number' ? (cfg['limit'] as number) : 1000;
          const before = typeof cfg?.['before'] === 'string' ? (cfg['before'] as string) : undefined;
          const until = typeof cfg?.['until'] === 'string' ? (cfg['until'] as string) : undefined;
          const sigs = await this.#chain.signatures(params[0] as string, asOf, { limit, ...(before === undefined ? {} : { before }), ...(until === undefined ? {} : { until }) });
          return { result: sigs.map((x) => ({ signature: x.signature, slot: x.slot, err: x.err, memo: null, blockTime: x.blockTime, confirmationStatus: 'confirmed' })) };
        }
        case 'getAccountInfo': {
          const a = await this.#accounts.read([params[0] as string], asOf, cfg);
          return { result: { context: { slot: asOf }, value: a[0] ?? null } };
        }
        case 'getMultipleAccounts': {
          const a = await this.#accounts.read(params[0] as string[], asOf, cfg);
          return { result: { context: { slot: asOf }, value: a } };
        }
        case 'getTokenLargestAccounts': {
          const v = await this.#accounts.largest(params[0] as string, asOf);
          return { result: { context: { slot: asOf }, value: v } };
        }
        case 'getProgramAccounts': {
          const v = await this.#accounts.programAccounts(params[0] as string, cfg, asOf);
          return { result: { context: { slot: asOf }, value: v } };
        }
        case 'getSlot':
          return { result: asOf };
        default:
          throw new Refused('method-not-served', method);
      }
    } catch (e) {
      return this.#refuse(method, e);
    }
  }
}
