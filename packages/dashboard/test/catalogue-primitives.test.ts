// UI-T04 catalogue sections: Primitives renders every state and its demos respond; the open-overlay sections render.
import './dom.ts';
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { createElement as h } from 'react';
import { DANGER_STACK, MENU_ITEMS, STRATEGIES, menuOpenSection, overlaysSection, popoverOpenSection, primitivesSection, toastStackSection } from '../src/catalogue/sections/primitives.ts';
import { click, fire, key, render, typeInto } from './dom.ts';

describe('UI-T04 catalogue: Primitives', () => {
  it('renders every primitive and the demos respond', () => {
    const r = render(h('div', null, primitivesSection.render()));
    const c = r.container;
    assert.equal(c.querySelectorAll('.demo').length, 15);
    const amount = c.querySelector('.demo__cell input') as HTMLInputElement;
    typeInto(amount, '0.5');
    assert.equal(c.querySelector('.demo__out')?.textContent, 'value 500000000');
    typeInto(amount, 'x');
    assert.equal(c.querySelector('.demo__out')?.textContent, 'invalid');
    const select = c.querySelector('[role="combobox"]') as HTMLElement;
    key(select, 'keydown', { key: 'ArrowDown' });
    key(select, 'keydown', { key: 'ArrowDown' });
    key(select, 'keydown', { key: 'Enter' });
    assert.equal(select.textContent, 'Pool momentum');
    for (const sw of [...c.querySelectorAll('[role="switch"]')].slice(0, 2)) click(sw);
    assert.deepEqual([...c.querySelectorAll('[role="switch"]')].slice(0, 2).map((s) => s.getAttribute('aria-checked')), ['false', 'true']);
    click(c.querySelector('.check input') as HTMLElement);
    for (const radio of [...c.querySelectorAll('input[type="radio"]')]) click(radio);
    fire(c.querySelectorAll('[role="tab"]')[1] as HTMLElement, new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    assert.equal(c.querySelectorAll('[role="tab"]')[1]?.getAttribute('aria-selected'), 'true');
    const save = [...c.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Save changes')) as HTMLElement;
    click(save);
    assert.equal(save.getAttribute('aria-busy'), 'true');
    const show = [...c.querySelectorAll('button')].find((b) => b.textContent === 'Show a toast') as HTMLElement;
    click(show);
    click(show);
    assert.equal(document.querySelectorAll('.toasts:not(.toasts--inline) .toast').length, 2);
    assert.equal(c.querySelectorAll('.banner').length, 7);
    click(c.querySelector('.banner--info button') as HTMLElement);
    assert.equal(c.querySelectorAll('.banner').length, 6);
    r.unmount();
  });

  it('demo data: one strategy is disabled with a reason; the menu has a disabled item and a submenu', () => {
    assert.equal(STRATEGIES.filter((s) => s.disabled === true && s.reason !== undefined).length, 1);
    assert.ok(MENU_ITEMS.some((i) => i.disabled === true && i.reason !== undefined));
    assert.ok(MENU_ITEMS.some((i) => i.items !== undefined));
  });

  it('the overlay sections are standalone and render open', () => {
    for (const s of [overlaysSection, menuOpenSection, popoverOpenSection]) assert.equal(s.standalone, true);
    const o = render(h('div', null, overlaysSection.render()));
    assert.equal(o.container.querySelectorAll('[role="listbox"]').length, 4);
    o.unmount();
    const m = render(h('div', null, menuOpenSection.render()));
    assert.ok(document.querySelector('[role="menu"]'));
    m.unmount();
    const p = render(h('div', null, popoverOpenSection.render()));
    assert.ok(document.querySelector('[role="dialog"]'));
    p.unmount();
  });

  it('the toast stack section is standalone: twelve danger toasts, four shown and "8 more" (review M2)', () => {
    assert.equal(toastStackSection.standalone, true);
    assert.equal(DANGER_STACK.length, 12);
    assert.ok(DANGER_STACK.every((t) => t.tone === 'danger'));
    const t = render(h('div', null, toastStackSection.render()));
    assert.equal(t.container.querySelectorAll('.toast').length, 4);
    assert.equal(t.container.querySelector('.toasts__more')?.textContent, '8 more');
    t.unmount();
  });
});
