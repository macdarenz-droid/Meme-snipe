// UI-T02 catalogue section "Tokens": swatches for every colour token, and the motion demo drawer toggles.
import './dom.ts';
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { createElement } from 'react';
import { MotionDemo, swatchGroups, tokensSection } from '../src/catalogue/sections/tokens.ts';
import { COLOURS } from '../src/theme/tokens.ts';
import { click, render } from './dom.ts';

describe('UI-T02 catalogue tokens section', () => {
  it('groups every colour token exactly once', () => {
    const groups = swatchGroups(Object.keys(COLOURS));
    assert.deepEqual(groups.map(([t]) => t), ['Neutrals', 'Data visualisation', 'Semantic']);
    assert.deepEqual(groups.flatMap(([, n]) => n).sort(), Object.keys(COLOURS).sort());
  });

  it('renders a swatch per colour token, with the blue-orange values on the polarity tokens', () => {
    const r = render(createElement('div', null, tokensSection.render()));
    assert.equal(r.container.querySelectorAll('.swatch').length, Object.keys(COLOURS).length);
    const pos = [...r.container.querySelectorAll('.swatch')].find((s) => s.querySelector('code')?.textContent === '--c-pos-mark');
    assert.match(pos?.textContent ?? '', /blue-orange: #3987e5 \/ #2a78d6/);
    r.unmount();
  });

  it('the motion demo opens and closes its drawer', () => {
    const r = render(createElement(MotionDemo));
    const button = r.container.querySelector('button') as HTMLButtonElement;
    const drawer = r.container.querySelector('#motion-demo-drawer') as HTMLElement;
    assert.equal(drawer.dataset['open'], 'false');
    click(button);
    assert.equal(drawer.dataset['open'], 'true');
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(button.textContent, 'Close drawer');
    click(button);
    assert.equal(drawer.dataset['open'], 'false');
    r.unmount();
  });
});
