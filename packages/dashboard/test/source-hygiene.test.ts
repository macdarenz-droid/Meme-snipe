// Trojan Source guard (UI-T03 context: untrusted text is sanitised at run time, so the source itself must not carry the
// same invisible characters): no dashboard file holds a raw bidi control, bidi mark or zero-width character; tests and
// code write them as \u escapes.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'vitest';
import { PACKAGE_DIR } from './tooling/build.ts';

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u061C]/u;
const SKIP = new Set(['node_modules', 'dist', '.dev-build', '.e2e-build', 'test-results', 'playwright-report', '__screenshots__']);

function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (SKIP.has(d.name)) return [];
    const path = join(dir, d.name);
    return d.isDirectory() ? textFiles(path) : /\.(ts|css|json|html|md)$/.test(d.name) ? [path] : [];
  });
}

describe('dashboard source hygiene', () => {
  it('no raw bidi or zero-width character in any source, style, fixture or document', () => {
    const files = textFiles(PACKAGE_DIR);
    assert.ok(files.length > 20);
    assert.deepEqual(files.filter((f) => INVISIBLE.test(readFileSync(f, 'utf8'))).map((f) => relative(PACKAGE_DIR, f)), []);
  });
});
