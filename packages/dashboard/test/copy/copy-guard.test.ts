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

  it('Z05 round 3 (ruling 14): default-ignorable code points, small capitals and Cherokee look-alikes are caught', () => {
    const seeded: ReadonlyArray<[string, string, string]> = [
      ['combining grapheme joiner', "const t = 'Sm\u034Fart entries';", 'smart'],
      ['Hangul filler', "const t = 'Unl\u3164ock trades';", 'unlock'],
      ['variation selector', "const t = 'rob\uFE0Fust';", 'robust'],
      ['tag character', "const t = 'Smar\u{E0074}t';", 'smart'],
      ['Latin small capitals', "const t = '\u1D00\u026A picks';", 'AI (any case)'],
      ['small capitals in a word', "const t = '\u0280\u1D0F\u0299\u1D1C\uA731\u1D1B';", 'robust'],
      ['Cherokee capitals', "const t = '\u13AA\u13A5 picks';", 'AI (any case)'],
      ['Cherokee in a word', "const t = '\u13DAmart';", 'smart'],
    ];
    for (const [form, code, label] of seeded) {
      assert.ok(scan(code).some((hit) => hit.startsWith(`${label}:`)), `${form}: ${code} → ${scan(code).join(' | ')}`);
    }
    assert.equal(normaliseCopy('\u13AA'), 'A');
    assert.equal(normaliseCopy('\u13AA'.toLowerCase()), 'a', 'the Cherokee small letter maps with its capital');
    assert.equal(normaliseCopy('\u1D00\u026A'), 'ai');
  });

  it('Z05 round 4 (ruling 17): every single-letter confusable skeleton, both l/I readings, and combining overlays are caught', () => {
    const seeded: ReadonlyArray<[string, string, string]> = [
      ['Lisu', "const t = '\uA4E2\uA4DF\uA4EE\uA4E3\uA4D4 entries';", 'smart'],
      ['Lisu A and I', "const t = '\uA4EE\uA4F2 picks';", 'AI'],
      ['Greek lunate sigma', "const t = '\u03F2utting-edge';", 'cutting-edge'],
      ['Coptic o', "const t = 'r\u2C9Fbust';", 'robust'],
      ['short solidus overlay', "const t = 's\u0337mart';", 'smart'],
      ['long stroke overlay', "const t = 's\u0336mart';", 'smart'],
      ['combining accent', "const t = 'se\u0301amless';", 'seamless'],
    ];
    for (const [form, code, label] of seeded) {
      assert.ok(scan(code).some((hit) => hit.startsWith(`${label}:`)), `${form}: ${code} → ${scan(code).join(' | ')}`);
    }
    assert.equal(normaliseCopy('\uA4EE\uA4F2', 'I'), 'AI');
    assert.equal(normaliseCopy('\uA4EE\uA4F2'), 'Al');
    // Plain trading copy with real l and I is not a hit (round 5, ruling 21, reads ASCII "Al" as AI: see below).
    assert.deepEqual(findBanned('Daily loss · Pool momentum · Limit 1 · Fill'), []);
  });

  it('Z05 round 5 (ruling 21): letter pairs, ASCII l/I/|, dashes, apostrophes, white space and marks are read as a reader sees them', () => {
    const seeded: ReadonlyArray<[string, string]> = [
      ['srnart', 'smart'], ['rnodels', 'models'], ['lnsights', 'insights'], ['unIock', 'unlock'], ['Al picks', 'AI'],
      ['cutting\u2011edge', 'cutting-edge'], ['game\u2010changer', 'game-changer'], ['Here\u02BCs', "Here's"], ['Let\u2032s', "Let's"],
      ['powered  by', 'powered by'], ['s\u20DDmart', 'smart'], ['sm\u0903art', 'smart'],
      // The other pairs and characters the ruling names.
      ['vvizard journey', 'journey'], ['cleep dive', 'deep dive'], ['A| picks', 'AI'],
      ['powered\u00A0\u2003by', 'powered by'],
      // Words with both a capital I and a small l (round 6, ruling 29).
      ['Intelligent entries', 'intelligent'], ['In plain words', 'in plain words'], ['Unlock Insights', 'insights'],
    ];
    for (const [text, label] of seeded) {
      const code = `const t = '${text}';`;
      assert.ok(scan(code).some((hit) => hit.startsWith(`${label}:`)), `${JSON.stringify(text)} → ${scan(code).join(' | ')}`);
    }
    // A banned word that holds a pair is still caught as written: the pairs reduce the word too.
    assert.ok(findBanned('harness the data').includes('harness'));
    assert.ok(findBanned('Pick your jou\u0072\u006Eey').includes('journey'));
    // Ordinary trading copy with pairs, digits and dashes stays allowed.
    assert.deepEqual(findBanned('Modern turn · Close all · Slippage 1\u20132% · Tier 1 · Fill rate'), []);
    // UI.md's action classes are copy: A1 reads as A1, not AI (round 6, ruling 26).
    for (const honest of ['A1', '(A1)', 'Action class A1', 'tier A1', 'Cancel (A1)']) assert.deepEqual(findBanned(honest), [], honest);
  });

  it('Z05 round 5 (ruling 25): look-alikes that only appear after NFKC/NFD are mapped by the second pass', () => {
    // Each precomposed Greek letter has no table entry; NFD splits off its accent and leaves a Greek look-alike.
    const seeded: ReadonlyArray<[string, string]> = [['r\u03CCbust', 'robust'], ['\u0386I picks', 'AI'], ['sm\u0386rt', 'smart']];
    for (const [text, label] of seeded) {
      assert.ok(findBanned(text).includes(label), `${JSON.stringify(text)} → ${findBanned(text).join(' | ')}`);
    }
    assert.equal(normaliseCopy('r\u03CCbust'), 'robust');
  });

  it('normaliseCopy reads text as a reader sees it, and leaves plain text alone', () => {
    assert.equal(normaliseCopy('\u0405m\u200Bart'), 'Smart');
    assert.equal(normaliseCopy('\uFF21\uFF29', 'I'), 'AI');
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
