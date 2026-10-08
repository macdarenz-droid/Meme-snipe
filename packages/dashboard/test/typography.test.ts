// UI-T03 rendering: the Num component, the Typography and Numbers catalogue sections, and the OFL texts.
import './dom.ts';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { createElement } from 'react';
import { GALLERY, numbersSection, typographySection } from '../src/catalogue/sections/typography.ts';
import { Num } from '../src/components/num.ts';
import { formatPrice } from '../src/lib/money.ts';
import { TYPE } from '../src/theme/tokens.ts';
import { render } from './dom.ts';
import { PACKAGE_DIR } from './tooling/build.ts';

describe('UI-T03 Num', () => {
  it('hides the visible text from assistive technology and exposes the unabbreviated label', () => {
    const r = render(createElement(Num, { value: formatPrice('0.000004321') }));
    const outer = r.container.firstElementChild as HTMLElement;
    assert.equal(outer.className, 'num');
    assert.equal(outer.querySelector('[aria-hidden="true"]')?.textContent, '0.0₅4321');
    assert.equal(outer.querySelector('.visually-hidden')?.textContent, '0.000004321');
    r.rerender(createElement(Num, { value: formatPrice('1'), className: 'x' }));
    assert.equal((r.container.firstElementChild as HTMLElement).className, 'num x');
    r.unmount();
  });
});

describe('UI-T03 catalogue sections', () => {
  it('the number gallery has a row per example with the tooltip text', () => {
    const r = render(createElement('div', null, numbersSection.render()));
    const rows = r.container.querySelectorAll('tbody tr');
    assert.equal(rows.length, GALLERY.length);
    assert.match(rows[1]?.textContent ?? '', /<0\.0001 SOL.*0\.000000001 SOL \(1 lamport\)/);
    assert.match(r.container.querySelector('.gallery__ids')?.textContent ?? '', /^So11…1112 BONK USDC Тест v… \? mixed scripts$/);
    r.unmount();
  });

  it('the typography specimen shows every type token', () => {
    const r = render(createElement('div', null, typographySection.render()));
    assert.equal(r.container.querySelectorAll('.typography__sample').length, Object.keys(TYPE).length);
    r.unmount();
  });
});

describe('UI-T03 licences', () => {
  it('licenses/ holds the OFL texts of the installed font packages, unchanged', () => {
    for (const [file, pkg] of [['inter-OFL.txt', 'inter'], ['jetbrains-mono-OFL.txt', 'jetbrains-mono']]) {
      const ours = readFileSync(join(PACKAGE_DIR, 'licenses', file as string), 'utf8');
      assert.equal(ours, readFileSync(join(PACKAGE_DIR, 'node_modules/@fontsource-variable', pkg as string, 'LICENSE'), 'utf8'));
      assert.match(ours, /SIL Open Font License, Version 1\.1/);
    }
  });
});
