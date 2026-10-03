// Shared test helpers: recorded mainnet transactions from DEC-1's fixtures, and a guard that fails any test that
// reaches the real network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import { recordFromRpc, type RpcTransactionBase64, type TransactionRecord } from '../../core/src/chain/index.ts';
import type { Secrets } from '../src/providers/index.ts';

interface TxFixture {
  readonly label: string;
  readonly signature: string;
  readonly slot: string;
  readonly txIndex: string;
  readonly base64: RpcTransactionBase64;
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../core/test/chain/fixtures/transactions.json');

/** Real `getTransaction` (base64) results recorded from mainnet on 2026-10-03 by DEC-1. */
export const TXS: readonly TxFixture[] = (JSON.parse(readFileSync(FIXTURES, 'utf8')) as { transactions: TxFixture[] }).transactions;

export const tx = (label: string, n = 0): TxFixture => {
  const t = TXS.filter((x) => x.label.startsWith(label))[n];
  if (t === undefined) throw new Error(`no fixture ${label} #${n}`);
  return t;
};

export const recordOf = (t: TxFixture): TransactionRecord => recordFromRpc(t.signature, t.base64);

/** Test keys. Distinctive, so a test can prove no key reaches a URL in a log, a frame or an error. */
export const KEYS = { HELIUS_API_KEY: 'helius-test-key-7f3a', ALCHEMY_API_KEY: 'alchemy-test-key-9c1d', JUPITER_API_KEY: 'jup-test-key-2b8e' } as const;
export const testSecrets: Secrets = { get: (n) => KEYS[n] };

/** Any real fetch or WebSocket in this file throws. */
export const blockNetwork = (): void => {
  const g = globalThis as Record<string, unknown>;
  let saved: { fetch: unknown; WebSocket: unknown } | null = null;
  beforeAll(() => {
    saved = { fetch: g.fetch, WebSocket: g.WebSocket };
    g.fetch = () => { throw new Error('network blocked in unit tests'); };
    g.WebSocket = function blocked() { throw new Error('network blocked in unit tests'); };
  });
  afterAll(() => {
    if (saved) {
      g.fetch = saved.fetch;
      g.WebSocket = saved.WebSocket;
    }
  });
};

/** Lets pending promise callbacks run (async adapters resolve over several microtask turns). */
export const settle = async (turns = 20): Promise<void> => {
  for (let k = 0; k < turns; k++) await Promise.resolve();
};
