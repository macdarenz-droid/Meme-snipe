// UI-T02 design tokens: the contrast test over tokens.json (acceptance 1), the generated files match their source,
// and the theme, polarity (acceptance 2), density, reduced-motion and forced-colour rules of tokens.css.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import {
  COLOURS, CONTRAST_PAIRS, POLARITY_ALT, REDUCED_MOTION_KEEP, SCALE, contrastRatio, minimumRatio, relativeLuminance, tokenValue,
  tokensCss, tokensJson, type TokensJson,
} from '../src/theme/tokens.ts';
import { TOKENS_CSS, TOKENS_JSON, tokensJsonText } from './tooling/tokens.ts';

/** Every DS pair whose computed ratio misses its DS value by more than 0.01 or its WCAG minimum. */
function contrastFailures(json: TokensJson): string[] {
  return json.contrastPairs.flatMap((p) => {
    const colour = (name: string): string => (name.startsWith('alt:') ? json.polarityAlt[p.theme][name.slice(4)] : json.colours[p.theme][name]) as string;
    const ratio = contrastRatio(colour(p.fg), colour(p.bg));
    const out: string[] = [];
    if (Math.abs(ratio - p.expected) > 0.01) out.push(`${p.theme} ${p.fg} on ${p.bg}: ${ratio.toFixed(2)} != DS ${p.expected}`);
    if (ratio < minimumRatio(p.kind)) out.push(`${p.theme} ${p.fg} on ${p.bg}: ${ratio.toFixed(2)} < ${minimumRatio(p.kind)}:1`);
    return out;
  });
}

describe('UI-T02 contrast calculator (WCAG 2.2)', () => {
  it('known pairs: white on black is 21.00, equal colours 1.00, and the order does not matter', () => {
    assert.equal(contrastRatio('#ffffff', '#000000').toFixed(2), '21.00');
    assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
    assert.equal(contrastRatio('#777777', '#777777'), 1);
    assert.equal(contrastRatio('#eceef1', '#0b0c0e').toFixed(2), '16.83');
    assert.equal(relativeLuminance('#FFFFFF'), 1);
    assert.equal(relativeLuminance('#000000'), 0);
  });

  it('refuses anything but #rrggbb', () => {
    for (const bad of ['#fff', 'red', '#12345g', 'rgba(0,0,0,1)']) assert.throws(() => relativeLuminance(bad), /is not #rrggbb/);
  });

  it('minimum ratios: text 4.5, non-text 3, exempt (disabled) none', () => {
    assert.deepEqual([minimumRatio('text'), minimumRatio('non-text'), minimumRatio('exempt')], [4.5, 3, 0]);
  });
});

describe('UI-T02 acceptance 1: every DS pair in tokens.json meets WCAG and matches the DS tables to ±0.01', () => {
  const json = JSON.parse(readFileSync(TOKENS_JSON, 'utf8')) as TokensJson;

  it('covers every pair of the DS tables', () => {
    assert.equal(json.contrastPairs.length, 48 + 48 + 13 + 13 + 10 + 9 + 8);
    assert.equal(json.contrastPairs.filter((p) => p.kind === 'exempt').length, 8);
  });

  it('has no failure', () => {
    assert.deepEqual(contrastFailures(json), []);
  });

  it('fails on a regression: a lighter light-theme profit text on its tint, or a darker dark border-control', () => {
    const worse = structuredClone(json);
    worse.colours.light['pos'] = '#1e8f57';
    worse.colours.dark['border-control'] = '#4a505b';
    const failures = contrastFailures(worse);
    assert.ok(failures.some((f) => f.startsWith('light pos on pos-tint') && f.endsWith('< 4.5:1')), failures.join('\n'));
    assert.ok(failures.some((f) => f.startsWith('dark border-control on bg-surface-1') && f.endsWith('< 3:1')), failures.join('\n'));
  });
});

describe('UI-T02 generated files', () => {
  it('tokens.css and tokens.json are exactly what src/theme/tokens.ts generates (run npm run tokens)', () => {
    assert.equal(readFileSync(TOKENS_CSS, 'utf8'), tokensCss());
    assert.equal(readFileSync(TOKENS_JSON, 'utf8'), tokensJsonText());
    assert.deepEqual(JSON.parse(tokensJsonText()), JSON.parse(JSON.stringify(tokensJson())));
  });

  it('tokenValue reads COLOURS and the alt: polarity tokens; unknown names throw', () => {
    assert.equal(tokenValue('bg-canvas', 'light'), '#f7f8fa');
    assert.equal(tokenValue('alt:pos-mark', 'dark'), '#3987e5');
    assert.throws(() => tokenValue('nope', 'dark'), /unknown colour token nope/);
    assert.throws(() => tokenValue('alt:nope', 'dark'), /unknown colour token alt:nope/);
  });
});

/** The declarations of the first rule whose selector is exactly `selector` (inside a media block when `media` is given). */
function rule(css: string, selector: string, media?: string): Record<string, string> {
  const scope = media === undefined ? css : css.slice(css.indexOf(`@media ${media} {`));
  const start = scope.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no rule ${selector}`);
  const body = scope.slice(start + selector.length + 2, scope.indexOf('}', start));
  return Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')), d.slice(d.indexOf(':') + 1).trim()]));
}

describe('UI-T02 tokens.css rules', () => {
  const css = tokensCss();

  it('dark is the default, light applies by attribute, and by the OS only when the preference is system', () => {
    assert.equal(rule(css, ':root')['--c-bg-canvas'], '#0b0c0e');
    assert.equal(rule(css, ':root')['color-scheme'], 'dark');
    assert.equal(rule(css, ':root[data-theme="light"]')['--c-bg-canvas'], '#f7f8fa');
    assert.equal(rule(css, ':root[data-theme="light"]')['color-scheme'], 'light');
    assert.equal(rule(css, ':root[data-theme="system"]', '(prefers-color-scheme: light)')['--c-bg-canvas'], '#f7f8fa');
    assert.equal(Object.keys(rule(css, ':root[data-theme="light"]')).length, Object.keys(COLOURS).length + 3);
  });

  it('acceptance 2: blue-orange polarity sets --c-pos-mark to #3987e5 in dark (and #2a78d6 in light)', () => {
    assert.equal(rule(css, ':root[data-polarity="blue-orange"]')['--c-pos-mark'], '#3987e5');
    assert.equal(rule(css, ':root[data-theme="light"][data-polarity="blue-orange"]')['--c-pos-mark'], '#2a78d6');
    assert.equal(rule(css, ':root[data-theme="system"][data-polarity="blue-orange"]', '(prefers-color-scheme: light)')['--c-neg'], '#b54708');
    assert.deepEqual(Object.keys(rule(css, ':root[data-polarity="blue-orange"]')).sort(), Object.keys(POLARITY_ALT).map((k) => `--c-${k}`).sort());
  });

  it('density sets --row-h to 28 / 32 / 40 px', () => {
    assert.equal(rule(css, ':root')['--row-h'], '32px');
    assert.equal(rule(css, ':root[data-density="compact"]')['--row-h'], '28px');
    assert.equal(rule(css, ':root[data-density="comfortable"]')['--row-h'], '40px');
  });

  it('reduced motion (OS or in-app) sets every --d-* to 0ms except --d-fast', () => {
    const durations = Object.keys(SCALE).filter((k) => k.startsWith('--d-'));
    for (const r of [rule(css, ':root[data-motion="reduced"]'), rule(css, ':root', '(prefers-reduced-motion: reduce)')]) {
      assert.deepEqual(Object.keys(r).sort(), durations.filter((d) => !REDUCED_MOTION_KEEP.includes(d)).sort());
      assert.ok(Object.values(r).every((v) => v === '0ms'));
    }
    assert.equal(rule(css, ':root')['--d-fast'], '100ms');
  });

  it('forced colours: borders and focus use system colours in every theme', () => {
    const forced = rule(css, ':root,\n  :root[data-theme]', '(forced-colors: active)');
    assert.equal(forced['--c-border-control'], 'CanvasText');
    assert.equal(forced['--c-focus'], 'Highlight');
  });

  it('every DS pair names a defined token', () => {
    for (const p of CONTRAST_PAIRS) for (const t of [p.fg, p.bg]) assert.doesNotThrow(() => tokenValue(t, p.theme), t);
  });
});
