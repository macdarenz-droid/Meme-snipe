// Test-only: turns a written window into a stand-in for an assembled release (DATA-1 mode=assemble), whose manifest has
// no synthetic flag. src/dataset/writer.ts always marks its windows synthetic (BT-WALL W1); only tests may strip it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const asRelease = (dir: string): string => {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  delete m['synthetic'];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
  const sums = join(dir, 'SHA256SUMS');
  if (existsSync(sums)) {
    writeFileSync(sums, readFileSync(sums, 'utf8').split('\n').map((l) => {
      const path = l.slice(66);
      return path === 'manifest.json' ? `${createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')}  ${path}` : l;
    }).join('\n'));
  }
  return dir;
};

/** A release tag in the assembled-window form. */
export const RELEASE = 'data-2026-09-06-2026-09-20';
