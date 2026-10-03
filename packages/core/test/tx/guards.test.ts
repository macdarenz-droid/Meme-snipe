// TX-1 constraints as checks: no @solana/web3.js anywhere, no keys and no signing in the transaction code, and no
// network outside tx/adapters (the ENG-1 purity guard enforces the same once it merges).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const TX = join(ROOT, 'packages', 'core', 'src', 'tx');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.')) return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe('TX-1 guards', () => {
  test('no @solana/web3.js import or dependency in the repo', () => {
    const offenders = files(join(ROOT, 'packages'))
      .concat(files(join(ROOT, 'apps')))
      .filter((f) => /\.(ts|tsx|js|mjs|json)$/.test(f))
      .filter((f) => /from\s*['"]@solana\/web3\.js|require\(\s*['"]@solana\/web3\.js|import\(\s*['"]@solana\/web3\.js|"@solana\/web3\.js"\s*:/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(ROOT, 'package.json'), 'utf8')).not.toContain('@solana/');
    expect(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')).not.toContain('@solana/web3.js');
  });

  test('the transaction code holds no key material and never signs', () => {
    for (const f of files(TX)) {
      const src = readFileSync(f, 'utf8');
      expect(src, relative(ROOT, f)).not.toMatch(/node:crypto|createPrivateKey|privateKey|secretKey|\bsign\s*\(|ed25519\.sign|Keypair/);
    }
  });

  test('network calls live only under tx/adapters', () => {
    for (const f of files(TX)) {
      if (relative(TX, f).startsWith('adapters')) continue;
      expect(readFileSync(f, 'utf8'), relative(ROOT, f)).not.toMatch(/\bfetch\s*\(|WebSocket|node:(http|https|net)|XMLHttpRequest/);
    }
  });
});
