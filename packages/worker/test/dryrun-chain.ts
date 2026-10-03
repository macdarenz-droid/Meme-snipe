// A stub Solana RPC for the dry-run tests: accounts, largest holders and a scripted `simulateTransaction`, served
// as an HttpClient. Every request is recorded so the tests can check methods, parameters and that no key leaks.
import { type Address, TOKEN_2022_PROGRAM, addressBytes, decodeTransaction, encodeBase58, fromBase64, toBase64, toAddress } from '../../core/src/chain/index.ts';
import type { HttpClient, HttpRequest } from '../src/providers/index.ts';

export const SYSTEM = '11111111111111111111111111111111';

export interface StubAccount {
  readonly owner: string;
  readonly lamports: bigint;
  readonly data: Uint8Array;
  readonly executable?: boolean;
}

/** A Token-2022 account (165 base bytes, account type, ImmutableOwner), as the associated token program creates. */
export const tokenAccountData = (mint: Address, owner: Address, amount: bigint, state = 1): Uint8Array => {
  const d = new Uint8Array(170);
  d.set(addressBytes(mint), 0);
  d.set(addressBytes(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  d[165] = 2; // AccountType::Account
  d[166] = 7; // ExtensionType::ImmutableOwner, length 0
  return d;
};

export const tokenAccount = (mint: Address, owner: Address, amount: bigint, lamports = 2_039_280n): StubAccount => ({
  owner: TOKEN_2022_PROGRAM,
  lamports,
  data: tokenAccountData(mint, owner, amount),
});
export const wallet = (lamports: bigint): StubAccount => ({ owner: SYSTEM, lamports, data: new Uint8Array() });

export interface SimRequest {
  readonly wire: Uint8Array;
  readonly config: Record<string, unknown>;
  readonly addresses: readonly string[];
}

/** What a scripted simulation returns: post accounts (null = closed or absent), or an error with logs. */
export type SimScript = (req: SimRequest, accounts: ReadonlyMap<string, StubAccount>) =>
  | { readonly post: readonly (StubAccount | null)[]; readonly units?: number }
  | { readonly err: unknown; readonly logs: readonly string[] }
  | { readonly raw: unknown };

export interface StubChain {
  readonly accounts: Map<string, StubAccount>;
  largest: { address: string; amount: string }[];
  slot: number;
  simulate: SimScript;
  /** Replaces the whole JSON-RPC response of a method (malformed-response tests). */
  override: Partial<Record<string, (params: unknown[]) => { status: number; text: string }>>;
  readonly requests: { readonly method: string; readonly params: unknown[]; readonly url: string }[];
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));
const accountJson = (a: StubAccount | null | undefined) =>
  a == null ? null : { owner: a.owner, lamports: Number(a.lamports), data: [toBase64(a.data), 'base64'], executable: a.executable ?? false, rentEpoch: 0 };

export const stubChain = (): { chain: StubChain; http: HttpClient } => {
  const chain: StubChain = {
    accounts: new Map(),
    largest: [],
    slot: 1_000,
    simulate: () => ({ err: 'no simulation scripted', logs: [] }),
    override: {},
    requests: [],
  };
  const http: HttpClient = async (req: HttpRequest) => {
    const body = JSON.parse(req.body ?? '{}') as { id: number; method: string; params: unknown[] };
    chain.requests.push({ method: body.method, params: body.params, url: req.url });
    const reply = (result: unknown) => ({ status: 200, header: () => null, text: json({ jsonrpc: '2.0', id: body.id, result }) });
    const o = chain.override[body.method];
    if (o) {
      const r = o(body.params);
      return { status: r.status, header: () => null, text: r.text };
    }
    const context = { slot: chain.slot, apiVersion: '3.0.0' };
    switch (body.method) {
      case 'getMultipleAccounts':
        return reply({ context, value: (body.params[0] as string[]).map((a) => accountJson(chain.accounts.get(a))) });
      case 'getTokenLargestAccounts':
        return reply({ context, value: chain.largest.map((x) => ({ ...x, decimals: 6, uiAmount: null, uiAmountString: '0' })) });
      case 'simulateTransaction': {
        const cfg = body.params[1] as Record<string, unknown>;
        const addresses = (cfg.accounts as { addresses: string[] }).addresses;
        const r = chain.simulate({ wire: fromBase64(body.params[0] as string), config: cfg, addresses }, chain.accounts);
        if ('raw' in r) return reply(r.raw);
        if ('err' in r) return reply({ context, value: { err: r.err, logs: r.logs, accounts: null, unitsConsumed: 1234 } });
        return reply({ context, value: { err: null, logs: ['Program log: ok'], accounts: r.post.map(accountJson), unitsConsumed: r.units ?? 50_000, innerInstructions: [] } });
      }
      default:
        return { status: 200, header: () => null, text: json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }) };
    }
  };
  return { chain, http };
};

/** The fee payer of a simulated wire transaction. */
export const feePayerOf = (wire: Uint8Array): Address => decodeTransaction(wire).staticAccountKeys[0]!;

/** A distinct valid address for tests. */
export const testAddress = (n: number): Address => {
  const b = new Uint8Array(32);
  b[0] = 200;
  b[31] = n;
  return toAddress(encodeBase58(b));
};
