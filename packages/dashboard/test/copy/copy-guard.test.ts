// No AI wording in the dashboard (CLAUDE.md "No AI wording in the UI"; card Z05): the apps/web copy guard, on the
// dashboard's own text. Scans every string and template literal under src/ (components, the catalogue, the app), each
// with the literal after it (a phrase split over two strings, 'Sm' + 'art'), the HTML templates' text and labels, the
// stylesheets' `content:` strings and every string in the built bundle. Text is matched as a reader sees it
// (normaliseCopy: NFKC, no format characters, look-alike letters as Latin). test/e2e/copy.e2e.ts checks the rendered
// pages' text too.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { APP_PAGE, CATALOGUE_PAGE, PACKAGE_DIR, build } from '../tooling/build.ts';
import { BANNED, BUNDLE_ALLOWED, findBanned, normaliseCopy } from './banned-copy.ts';
import { stringLiterals } from './copy-scan.ts';

const REPO_ROOT = join(PACKAGE_DIR, '..', '..');

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    return d.isDirectory() ? filesUnder(path, ext) : ext.test(d.name) ? [path] : [];
  });
}

/** Hits in each literal, and in each literal joined to the next one (a phrase split over two strings). */
function scan(code: string): string[] {
  const literals = stringLiterals(code);
  const hits = new Set<string>();
  literals.forEach((text, i) => {
    for (const label of findBanned(text)) hits.add(`${label}: "${text}"`);
    const next = literals[i + 1];
    if (next === undefined) return;
    const single = new Set([...findBanned(text), ...findBanned(next)]);
    for (const label of findBanned(`${text}${next}`)) if (!single.has(label)) hits.add(`${label}: "${text}" + "${next}"`);
  });
  return [...hits];
}

const tmp = mkdtempSync(join(tmpdir(), 'copy-guard-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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
    assert.deepEqual([...new Set(scan(seeded).map((h) => h.split(':')[0]))].sort(), ['AI', 'AI (any case)', "Here's", 'journey', 'powered by', 'seamless', 'smart', 'unlock'].sort());
  });

  it('Z05 round 2 (red team m1): split strings, look-alike letters, zero-width characters, fullwidth letters and "Ai" are caught', () => {
    const bypasses: ReadonlyArray<[string, string]> = [
      ["h('p', null, 'Sm' + 'art entries');", 'smart'],
      ["h('p', null, 'Unl', 'ock trades');", 'unlock'],
      ["const t = 'Powered ' + 'by Zeroed';", 'powered by'],
      ["const t = '\u0405mart sizing';", 'smart'],
      ["const t = 's\u0435amless fills';", 'seamless'],
      ["const t = 'Sm\u200Bart entries';", 'smart'],
      ["const t = 'In\u00ADsights';", 'insights'],
      ["const t = 'Built with Ai';", 'AI (any case)'],
      ["const t = 'ai picks';", 'AI (any case)'],
      ["const t = '\uFF21\uFF29 picks';", 'AI'],
      ["const t = 'r\u043Ebust';", 'robust'],
    ];
    for (const [code, label] of bypasses) assert.ok(scan(code).some((hit) => hit.startsWith(`${label}:`)), `${code} → ${scan(code).join(' | ')}`);
  });

  it('normaliseCopy reads text as a reader sees it, and leaves plain text alone', () => {
    assert.equal(normaliseCopy('\u0405m\u200Bart'), 'Smart');
    assert.equal(normaliseCopy('\uFF21\uFF29'), 'AI');
    assert.equal(normaliseCopy('Daily loss · 0.25 SOL'), 'Daily loss · 0.25 SOL');
    // Words that only look close stay allowed.
    assert.deepEqual(findBanned('Paid fees · Aim price · aide'), []);
  });

  it('finds no banned words in any string of the built app and catalogue (one reviewed allow-list entry)', async () => {
    const out = join(tmp, 'build');
    await build({ outDir: out, pages: [APP_PAGE, CATALOGUE_PAGE], mode: 'production' });
    const scripts = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
    assert.ok(scripts.length >= 2);
    const hits = scripts.flatMap((f) => stringLiterals(readFileSync(join(out, 'assets', f), 'utf8'))
      .filter((text) => !BUNDLE_ALLOWED.includes(text))
      .flatMap((text) => findBanned(text).map((label) => `${f} ${label}: "${text.slice(0, 80)}"`)));
    assert.deepEqual(hits, []);
    // The allow-list is exact: the same word inside a sentence is still caught.
    assert.deepEqual(findBanned('A seamless switch').length > 0, true);
  }, 120_000);

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
