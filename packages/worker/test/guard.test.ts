// Static guards for the worker's I/O layer: no keys or environment reads in source, and no test wired to the real
// network (the opt-in probe lives in scripts/ and never runs under vitest).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

describe('worker I/O guards', () => {
  it('source never reads the environment: keys come only through the injected Secrets', () => {
    for (const f of files('src')) expect(read(f), f).not.toMatch(/process\.env|process\[/);
  });

  it('no key literal in source: every key reaches a URL or header from Secrets', () => {
    for (const f of files('src')) {
      const text = read(f);
      expect(text, f).not.toMatch(/api-key=[A-Za-z0-9-]{8,}/);
      expect(text, f).not.toMatch(/['"]x-api-key['"]\s*:\s*['"]/);
      expect(text, f).not.toMatch(/\/v2\/[A-Za-z0-9_-]{16,}/);
    }
  });

  it('tests never use the real fetch, WebSocket or clock adapters', () => {
    for (const f of files('test')) {
      if (f.endsWith('guard.test.ts')) continue;
      expect(read(f), f).not.toMatch(/\b(fetchHttp|globalSocketFactory|systemTimers|credentialsDirectorySecrets)\b/);
    }
  });

  it('the worker process hands every provider reader, the fact readers included, the drop-rpc cut client', () => {
    const main = read('src/main.ts');
    expect(main).toMatch(/liveFacts\(\{[^)]*http: http\.facts/);
    // The raw client goes only into the process's clients (`liveHttp`), which cut every provider read.
    expect(main.match(/\bfetchHttp\b/g)?.length).toBe(2);
    expect(main).toContain('liveHttp(rpcCut, fetchHttp)');
  });

  it('only boot/environment.ts reads the environment and the credentials, and it hands keys on only as Secrets', () => {
    for (const f of files('boot')) {
      if (f.endsWith('environment.ts')) continue;
      expect(read(f), f).not.toMatch(/process\.env|process\[|CREDENTIALS_DIRECTORY/);
    }
    const env = read('boot/environment.ts');
    // Nothing that prints or writes: the values leave only through the returned Secrets and host credentials.
    expect(env).not.toMatch(/console\.|writeFileSync|appendFileSync/);
  });

  it('the worker has no path that sends a transaction (paper only)', () => {
    for (const f of [...files('src/run'), ...files('src/engine'), 'src/main.ts']) {
      expect(read(f), f).not.toMatch(/sendTransaction|sendRawTransaction|sendBundle|\/execute\b/);
    }
  });

  it('the live probe is opt-in and outside the test glob', () => {
    const probe = read('scripts/live-probe.ts');
    expect(probe).toContain("ZEROED_LIVE_PROBE !== '1'");
    expect(files('test').some((f) => f.includes('probe'))).toBe(false);
  });
});
