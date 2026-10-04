// A keyed RPC address never reaches a committed fixture: the redaction helper masks every place a key can sit, every
// core fixture fetch script records its RPC through it, and no committed fixture file holds a keyed address.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { redactRpc } from './redact-rpc.ts';

const TEST = import.meta.dirname;
const PACKAGES = join(TEST, '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/** A key-shaped value that is not the redaction mark. */
const KEYED = [
  /api[-_]?key=(?!…)[^&"\s]/i,
  /[?&](?:key|token|access[-_]?token|auth|secret)=(?!…)[^&"\s]/i,
  /https?:\/\/[^/\s"@]+:[^/\s"@]+@/i,
  /https?:\/\/[^/\s"]*(?:helius-rpc\.com|quiknode\.pro|alchemy\.com|alchemyapi\.io|ankr\.com|chainstack\.com|triton\.one|rpcpool\.com)\/(?!…)[^\s"?]/i,
];

describe('RPC redaction for fixtures', () => {
  test.each<[string, string]>([
    ['https://api.mainnet-beta.solana.com', 'https://api.mainnet-beta.solana.com'],
    ['https://api.mainnet-beta.solana.com/', 'https://api.mainnet-beta.solana.com'],
    ['https://mainnet.helius-rpc.com/?api-key=0a1b2c3d-secret', 'https://mainnet.helius-rpc.com/?api-key=…'],
    ['https://mainnet.helius-rpc.com/?cluster=x&api-key=0a1b2c3d-secret', 'https://mainnet.helius-rpc.com/?cluster=…&api-key=…'],
    ['https://x-y.solana-mainnet.quiknode.pro/abcdef0123456789secret/', 'https://x-y.solana-mainnet.quiknode.pro/…'],
    ['https://solana-mainnet.g.alchemy.com/v2/secretKey123', 'https://solana-mainnet.g.alchemy.com/…'],
    ['https://user:secretpass@rpc.example.com:8899/', 'https://rpc.example.com:8899'],
    ['https://rpc.example.com/#secret', 'https://rpc.example.com'],
    ['not a url secret', '…'],
  ])('%s', (url, expected) => {
    const out = redactRpc(url);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/secret/i);
    for (const re of KEYED) expect(out).not.toMatch(re);
  });

  test('the keyed-address patterns catch every keyed form above', () => {
    for (const keyed of [
      'https://mainnet.helius-rpc.com/?api-key=0a1b2c3d',
      'https://x.solana-mainnet.quiknode.pro/abcdef0123/',
      'https://solana-mainnet.g.alchemy.com/v2/abc',
      'https://user:pass@rpc.example.com/',
      'https://rpc.example.com/?token=abc',
    ]) expect(KEYED.some((re) => re.test(`"rpc": "${keyed}"`)), keyed).toBe(true);
  });

  test('every core fixture fetch script records its RPC through the helper', () => {
    const scripts = walk(TEST).filter((p) => /\/fixtures\/fetch-[^/]+\.ts$/.test(p));
    expect(scripts.length).toBeGreaterThanOrEqual(5);
    for (const p of scripts) {
      const src = readFileSync(p, 'utf8');
      if (!/process\.env\[['"]SOLANA_RPC['"]\]/.test(src)) continue;
      const name = relative(TEST, p);
      expect(src, name).toMatch(/\bredactRpc\(RPC\)/);
      // The raw address is only ever passed to fetch, never written: no `rpc: RPC`, `source: RPC` or own regex.
      expect(src, name).not.toMatch(/\b(?:rpc|source)\s*:\s*RPC\b/);
      expect(src, name).not.toMatch(/\bRPC\.replace\(/);
      expect(src, name).not.toMatch(/`[^`]*\$\{RPC\}[^`]*`/);
    }
  });

  test('no committed fixture file holds a keyed RPC address', () => {
    const files = walk(PACKAGES).filter((p) => /\/test\/.*fixtures\/[^/]+\.(?:json|jsonl|txt|csv)$/.test(p));
    expect(files.length).toBeGreaterThan(5);
    for (const p of files) {
      const text = readFileSync(p, 'utf8');
      for (const re of KEYED) expect(re.test(text), `${relative(PACKAGES, p)} matches ${re}`).toBe(false);
    }
  });
});
