import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BANNED, findBanned } from './banned-copy.ts';
import { extractText, stringLiterals } from './copy-scan.ts';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(appRoot, '..', '..');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

async function scan(code: string, filename: string): Promise<string[]> {
  const hits: string[] = [];
  for (const text of await extractText(code, filename)) {
    for (const label of findBanned(text)) hits.push(`${label}: "${text}"`);
  }
  return hits;
}

describe('copy guard', () => {
  it('finds no banned words in apps/web/src text', async () => {
    const sources = filesUnder(join(appRoot, 'src')).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(sources.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const file of sources) {
      for (const hit of await scan(readFileSync(file, 'utf8'), file)) hits.push(`${relative(appRoot, file)} ${hit}`);
    }
    expect(hits).toEqual([]);
  });

  it('finds no banned words in index.html or stylesheet content', () => {
    const html = readFileSync(join(appRoot, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    const text = html.replace(/<[^>]+>/g, ' ');
    const attrs = [...html.matchAll(/(?:title|alt|aria-label|content)="([^"]*)"/g)].map((m) => m[1] ?? '');
    const css = filesUnder(join(appRoot, 'src'))
      .filter((f) => f.endsWith('.css'))
      .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/content:\s*(['"])(.*?)\1/g)].map((m) => m[2] ?? ''));
    expect([text, ...attrs, ...css].flatMap(findBanned)).toEqual([]);
  });

  it('finds no banned words in the Android app strings', () => {
    // Android: every <string> in res/values*/ (the launcher and task-switcher name come from here).
    const res = join(appRoot, 'android/app/src/main/res');
    const xml = readdirSync(res).filter((d) => d.startsWith('values')).flatMap((d) => filesUnder(join(res, d))).filter((f) => f.endsWith('.xml'));
    const strings = xml.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/<string[^>]*>([^<]*)<\/string>/g)].map((m) => m[1] ?? ''));
    expect(strings).toContain('Zeroed');
    expect(strings.flatMap((t) => findBanned(t).map((l) => `${l}: "${t}"`))).toEqual([]);
  });

  it('fails on seeded JSX text, attributes and string literals', async () => {
    const seeded = `
      export const A = () => <p title="Smart entries">Unlock seamless trades</p>;
      const label = 'Powered by AI';
      const t = \`Here's your \${label} journey\`;
      // insights in a comment are not shown, so they are ignored
    `;
    const hits = await scan(seeded, 'seeded.tsx');
    expect(hits.map((h) => h.split(':')[0]).sort()).toEqual(
      ['AI', "Here's", 'journey', 'powered by', 'seamless', 'smart', 'unlock'].sort(),
    );
  });

  it('allows ordinary trading copy', async () => {
    const ok = `export const B = () => <div aria-label="Daily loss"><h2>Open trade</h2><p>{'Pause new entries'}</p></div>;`;
    expect(await scan(ok, 'ok.tsx')).toEqual([]);
  });

  it('lexes regex literals and nested templates without losing strings', () => {
    const js = 'const r = /["\']/g; const x = a / b; const s = `a ${`inner ${"deep"}`} b`; const q = "after";';
    expect(stringLiterals(js)).toEqual(expect.arrayContaining(['inner ', 'deep', 'after']));
  });

  it('still lists every phrase quoted in the CLAUDE.md rule', () => {
    const rule = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')
      .split('\n')
      .find((l) => l.includes('No AI wording in the UI'));
    expect(rule).toBeDefined();
    // The examples after "Use short, specific labels" are allowed labels, not banned ones.
    const bannedPart = (rule ?? '').split('Use short')[0] ?? '';
    const quoted = [...bannedPart.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    const phrases = quoted.flatMap((q) => q.split('/')).filter((q) => q.length > 1);
    expect(phrases.length).toBeGreaterThan(15);
    const labels = BANNED.map((b) => b.label.toLowerCase());
    for (const p of phrases) {
      expect(findBanned(p).length > 0 || labels.includes(p.toLowerCase()), p).toBe(true);
    }
    for (const w of ['AI', 'models', 'assistants', 'sparkles']) expect(labels).toContain(w.toLowerCase());
  });
});
