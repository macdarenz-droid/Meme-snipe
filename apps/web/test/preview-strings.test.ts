import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = fileURLToPath(new URL('..', import.meta.url));
const out = join(app, 'dist-strings-test');

describe('production bundle', () => {
  it('ships no sample route, sample title or marker text', () => {
    try {
      execSync(`pnpm exec vite build --outDir ${out} --emptyOutDir`, { cwd: app, stdio: 'pipe', env: { ...process.env, VITE_PREVIEW: '', NODE_ENV: 'production' } });
      const js = readdirSync(join(out, 'assets'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(join(out, 'assets', f), 'utf8'))
        .join('\n');
      for (const s of ['dev/fixtures', 'Samples', 'Sample data', 'ZEROED_FIXTURES_DEV_ONLY']) expect(js, s).not.toContain(s);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
