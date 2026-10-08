// UI-T01 component catalogue scaffold: section selection and mounting.
import './dom.ts';
import { strict as assert } from 'node:assert';
import { describe, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { Catalogue, SECTIONS, selectSections, type Section } from '../src/catalogue/catalogue.ts';
import { startCatalogue } from '../src/catalogue/main.ts';
import { render } from './dom.ts';

const a: Section = { id: 'a', title: 'A', render: () => createElement('p', null, 'state a') };
const b: Section = { id: 'b', title: 'B', render: () => createElement('p', null, 'state b') };

describe('UI-T01 catalogue', () => {
  it('?section=<id> selects one section; absent or unknown selects all but the standalone ones', () => {
    const c: Section = { ...b, id: 'c', standalone: true };
    assert.deepEqual(selectSections('?section=b', [a, b, c]), [b]);
    assert.deepEqual(selectSections('?section=c', [a, b, c]), [c]);
    assert.deepEqual(selectSections('', [a, b, c]), [a, b]);
    assert.deepEqual(selectSections('?section=zz', [a, b, c]), [a, b]);
  });

  it('renders each section as a labelled region with its states', () => {
    const r = render(createElement(Catalogue, { sections: [a, b] }));
    const regions = [...r.container.querySelectorAll('section')];
    assert.deepEqual(regions.map((s) => s.getAttribute('aria-labelledby')), ['a-title', 'b-title']);
    assert.equal(r.container.querySelector('#b p')?.textContent, 'state b');
    r.unmount();
  });

  it('startCatalogue mounts into #root and needs one', () => {
    // The Positions section reads the fixture API: no request leaves the test.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => undefined));
    assert.throws(() => startCatalogue(document), /no #root element/);
    const el = document.createElement('div');
    el.id = 'root';
    document.body.append(el);
    let root: ReturnType<typeof startCatalogue> | undefined;
    act(() => { root = startCatalogue(document); });
    assert.equal(el.querySelectorAll('section').length, SECTIONS.filter((s) => s.standalone !== true).length);
    assert.equal(el.querySelector('h1')?.textContent, 'Catalogue');
    act(() => root?.unmount());
    el.remove();
    assert.equal(String(fetchMock.mock.calls[0]?.[0]), '/api/v1/vm/VM-05');
    fetchMock.mockRestore();
  });
});
