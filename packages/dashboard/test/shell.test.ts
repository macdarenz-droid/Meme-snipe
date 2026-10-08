// UI-T01 sample test: the blank shell renders, and start() mounts it into #root.
import './dom.ts';
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { act, createElement } from 'react';
import { APP_NAME, Shell } from '../src/app/shell.ts';
import { start } from '../src/index.ts';
import { render } from './dom.ts';

describe('UI-T01 blank shell', () => {
  it('renders the header, a main landmark and the page title', () => {
    const r = render(createElement(Shell));
    assert.equal(r.container.querySelector('header')?.textContent, APP_NAME);
    assert.equal(r.container.querySelector('main h1')?.textContent, 'Overview');
    r.unmount();
  });

  it('start() mounts the shell into #root', () => {
    const el = document.createElement('div');
    el.id = 'root';
    document.body.append(el);
    let root: ReturnType<typeof start> | undefined;
    act(() => { root = start(document); });
    assert.match(el.innerHTML, /app-shell/);
    act(() => root?.unmount());
    el.remove();
  });

  it('start() throws a clear error when the page has no #root', () => {
    assert.throws(() => start(document), /no #root element/);
  });
});
