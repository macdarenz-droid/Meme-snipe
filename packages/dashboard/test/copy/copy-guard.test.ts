// No AI wording in the dashboard (CLAUDE.md "No AI wording in the UI"; card Z05): the apps/web copy guard, on the
// dashboard's own text. Scans every string and template literal under src/ (components, the catalogue, the app), the
// HTML templates' text and labels, and the stylesheets' `content:` strings.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'vitest';
import { PACKAGE_DIR } from '../tooling/build.ts';
import { BANNED, findBanned } from './banned-copy.ts';
import { stringLiterals } from './copy-scan.ts';

const REPO_ROOT = join(PACKAGE_DIR, '..', '..');

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    return d.isDirectory() ? filesUnder(path, ext) : ext.test(d.name) ? [path] : [];
  });
}

const scan = (code: string): string[] => stringLiterals(code).flatMap((text) => findBanned(text).map((label) => `${label}: "${text}"`));

/** The entries of a `BANNED` array, one per line as written (`word('robust'),`), so a weakened pattern differs. */
function bannedEntries(source: string): string[] {
  const body = source.split('export const BANNED: Banned[] = [')[1]?.split('\n];')[0];
  assert.ok(body !== undefined, 'BANNED array not found');
  return body.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

describe('dashboard copy guard', () => {
  it('finds no banned words in any string under src/', () => {
    const sources = filesUnder(join(PACKAGE_DIR, 'src'), /\.ts$/);
    assert.ok(sources.length > 20);
    const hits = sources.flatMap((f) => scan(readFileSync(f, 'utf8')).map((h) => `${relative(PACKAGE_DIR, f)} ${h}`));
    assert.deepEqual(hits, []);
  });

  it('finds no banned words in the HTML templates or stylesheet content', () => {
    const texts = ['index.html', 'catalogue.html'].flatMap((name) => {
      const html = readFileSync(join(PACKAGE_DIR, name), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
      const attrs = [...html.matchAll(/(?:title|alt|aria-label|content|placeholder)="([^"]*)"/g)].map((m) => m[1] ?? '');
      return [html.replace(/<[^>]+>/g, ' '), ...attrs];
    });
    const css = filesUnder(join(PACKAGE_DIR, 'src'), /\.css$/)
      .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/content:\s*(['"])(.*?)\1/g)].map((m) => m[2] ?? ''));
    assert.ok(texts.length >= 2);
    assert.deepEqual([...texts, ...css].flatMap((t) => findBanned(t).map((l) => `${l}: "${t}"`)), []);
  });

  it('fails on seeded createElement text, attributes and string literals; ignores comments', () => {
    const seeded = [
      "export const A = () => h('p', { title: 'Smart entries' }, 'Unlock seamless trades');",
      "const label: string = 'Powered by AI';",
      'const t = `Here\'s your ${label} journey`;',
      '// insights in a comment are not shown, so they are ignored',
    ].join('\n');
    assert.deepEqual(scan(seeded).map((h) => h.split(':')[0]).sort(), ['AI', "Here's", 'journey', 'powered by', 'seamless', 'smart', 'unlock'].sort());
  });

  it('allows ordinary trading copy', () => {
    assert.deepEqual(scan("export const B = () => h('div', { 'aria-label': 'Daily loss' }, h('h2', null, 'Open trade'), 'Pause new entries');"), []);
  });

  it('keeps every entry of the apps/web list, written the same way (same list or longer, never shorter)', () => {
    const ours = bannedEntries(readFileSync(join(PACKAGE_DIR, 'test/copy/banned-copy.ts'), 'utf8'));
    const web = bannedEntries(readFileSync(join(REPO_ROOT, 'apps/web/test/banned-copy.ts'), 'utf8'));
    assert.ok(web.length > 30);
    assert.deepEqual(web.filter((e) => !ours.includes(e)), []);
    assert.ok(BANNED.length >= web.length);
  });

  it('still lists every phrase quoted in the CLAUDE.md rule', () => {
    const rule = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8').split('\n').find((l) => l.includes('No AI wording in the UI'));
    assert.ok(rule !== undefined);
    // The examples after "Use short, specific labels" are allowed labels, not banned ones.
    const bannedPart = rule.split('Use short')[0] ?? '';
    const phrases = [...bannedPart.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] ?? '').split('/')).filter((q) => q.length > 1);
    assert.ok(phrases.length > 15);
    const labels = BANNED.map((b) => b.label.toLowerCase());
    for (const p of phrases) assert.ok(findBanned(p).length > 0 || labels.includes(p.toLowerCase()), p);
    for (const w of ['ai', 'models', 'assistants', 'sparkles']) assert.ok(labels.includes(w), w);
  });
});
