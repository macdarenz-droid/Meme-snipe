// Test helpers: read the C11 mainnet fixtures and the C03 decoder fixtures from the repository (files, not imports).
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { readFileSync } from 'node:fs';
import { createDecoders, verifyPinnedIdls, VENDORED_IDL_DIR, type Decoders, type PinnedIdl } from '../src/index.ts';

const ROOT = new URL('../../../fixtures/', import.meta.url);

export interface FixtureAccount { role?: string; pubkey: string; owner: string; data_base64: string; space?: number }
export function fixture<T = Record<string, unknown>>(rel: string): T {
  return JSON.parse(readFileSync(new URL(rel, ROOT), 'utf8')) as T;
}
export function accountsOf(rel: string): FixtureAccount[] {
  return fixture<{ accounts: FixtureAccount[] }>(rel).accounts;
}
export const bytes = (a: FixtureAccount): Uint8Array => new Uint8Array(Buffer.from(a.data_base64, 'base64'));
export const role = (rel: string, r: string): FixtureAccount => {
  const a = accountsOf(rel).find((x) => x.role === r);
  if (a === undefined) throw new Error(`${rel}: no ${r}`);
  return a;
};

export function idls(): PinnedIdl[] {
  const r = verifyPinnedIdls(VENDORED_IDL_DIR);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}
export const programOf = (name: PinnedIdl['name']): string => (idls().find((i) => i.name === name) as PinnedIdl).program;

/** Token program IDs as the fixtures record them (owners of a Token-2022 base mint and of the wSOL quote mint). */
export const TOKEN_PROGRAMS = {
  splToken: role('mainnet/pumpswap/pools/pool_9jkXWMyt.json', 'quote_mint').owner,
  token2022: role('mainnet/pumpswap/pools/pool_9jkXWMyt.json', 'base_mint').owner,
};

/** The wSOL mint as the fixtures record it (the quote mint of a C11 pool); the decoders take it from A-M01-01 in production. */
export const WSOL = role('mainnet/pumpswap/pools/pool_9jkXWMyt.json', 'quote_mint').pubkey;

export function decoders(): Decoders {
  return createDecoders(idls(), { tokenPrograms: TOKEN_PROGRAMS, wsolMint: WSOL });
}

export const DEFAULT_PUBKEY = '11111111111111111111111111111111';
