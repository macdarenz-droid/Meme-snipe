// Provider endpoints. Each URL that carries a key is built from `Secrets` at the moment it is used and is never
// stored, logged or put in an error (errors name the provider and the call only).
import type { Secrets } from './http.ts';

const key = (secrets: Secrets, name: 'HELIUS_API_KEY' | 'ALCHEMY_API_KEY'): string => encodeURIComponent(secrets.get(name));

/** Helius RPC and standard WebSockets (data.md §1.3). */
export const heliusRpcUrl = (s: Secrets): string => `https://mainnet.helius-rpc.com/?api-key=${key(s, 'HELIUS_API_KEY')}`;
export const heliusWsUrl = (s: Secrets): string => `wss://mainnet.helius-rpc.com/?api-key=${key(s, 'HELIUS_API_KEY')}`;
/** Parsed Streams are served only on the Gatekeeper host (Fact-check F5). */
export const heliusParsedUrl = (s: Secrets): string => `wss://beta.helius-rpc.com/?api-key=${key(s, 'HELIUS_API_KEY')}`;
/** Alchemy Solana mainnet; the key is the last path segment. */
export const alchemyRpcUrl = (s: Secrets): string => `https://solana-mainnet.g.alchemy.com/v2/${key(s, 'ALCHEMY_API_KEY')}`;
export const alchemyWsUrl = (s: Secrets): string => `wss://solana-mainnet.g.alchemy.com/v2/${key(s, 'ALCHEMY_API_KEY')}`;
