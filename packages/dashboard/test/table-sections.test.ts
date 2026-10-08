// UI-T06 catalogue sections: the Positions fixture page (DoD: the DataTable is used by the Positions fixture page) on
// the VM-05 fixture, with loading, error and retry, empty, selection, opening, column visibility, streamed inserts after
// 2 s and mark updates; the table states in both variants; the performance page with its 20-per-second cell; and the
// helpers (fetch, decimals, generated rows, `?rows=`).
import './dom.ts';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import {
  DEMO_ROWS, PositionsPage, STREAM_DELAY_MS, TablePerf, TableStates, baseToDecimal, fetchJson, moveMarks, perfRows, positionColumns, positionsSection,
  rowsFromSearch, streamedPosition, tableDenseSection, tablePerfSection, tableStatesSection, type FixturePosition, type Loader, type Vm05Snapshot,
} from '../src/catalogue/sections/table.ts';
import { demoClock } from '../src/catalogue/sections/states.ts';
import type { ElapsedClock } from '../src/lib/clock.ts';
import { actAsync, actSync, click, key, render, type Rendered } from './dom.ts';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/vm/VM-05.json', import.meta.url), 'utf8')) as Vm05Snapshot;

const mounted: Rendered[] = [];
const mount = (el: ReactElement): Rendered => { const r = render(el); mounted.push(r); return r; };
/** Real elapsed time for the loading skeleton: advances with the fake timers (the data clock does not). */
let elapsedMs = 0;
const loadingClock: ElapsedClock = { nowMs: () => elapsedMs };
const tick = (ms: number): void => {
  for (let left = ms; left > 0; left -= 10) actSync(() => { elapsedMs += Math.min(10, left); vi.advanceTimersByTime(Math.min(10, left)); });
};
const bodyRows = (r: Rendered): HTMLTableRowElement[] => [...r.container.querySelectorAll('tbody tr[data-row-id]')] as HTMLTableRowElement[];
const button = (r: Rendered, name: string): HTMLButtonElement => [...r.container.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;
const out = (r: Rendered): string => r.container.querySelector('[data-testid="positions-out"]')?.textContent ?? '';
/** Lets a resolved loader promise settle inside act(). */
const settle = (): Promise<void> => actAsync(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => { while (mounted.length > 0) mounted.pop()?.unmount(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('UI-T06 Positions fixture page', () => {
  it('loads VM-05 from the fixture API and shows every position formatted by the money module', async () => {
    const paths: string[] = [];
    const load: Loader = async (path) => { paths.push(path); return structuredClone(FIXTURE); };
    const r = mount(h(PositionsPage, { load }));
    assert.equal(r.container.querySelector('table')?.getAttribute('aria-busy'), 'true');
    await settle();
    assert.deepEqual(paths, ['/api/v1/vm/VM-05']);
    assert.equal(bodyRows(r).length, 8);
    assert.equal(r.container.querySelectorAll('.dt__row--new').length, 0, 'the loaded snapshot is not marked new');
    const bonk = bodyRows(r)[0] as HTMLTableRowElement;
    const cells = [...bonk.cells].map((c) => c.querySelector('[aria-hidden]')?.textContent ?? c.textContent);
    assert.deepEqual(cells, ['BONK', 'Bonk', 'mr', 'open', '1,234,567.8901', '0.5330 SOL', '0.0₅4321', '0.0₅4712', '0.5747 SOL', '▲ ', '42 bps', '21m 11s']);
    assert.equal(bonk.cells[9]?.textContent?.includes('+0.0417 SOL · +7.82%'), true);
    assert.equal(r.container.querySelector('.freshness__text')?.textContent, 'Delayed · 6s');
    const max = bodyRows(r).find((tr) => tr.textContent?.includes('MAX')) as HTMLTableRowElement;
    assert.ok(max.cells[9]?.querySelector('.dt__neg'));
    const nomark = bodyRows(r).find((tr) => tr.textContent?.includes('NOMARK')) as HTMLTableRowElement;
    assert.equal(nomark.cells[7]?.querySelector('[aria-hidden]')?.textContent, '—');
    assert.equal(nomark.cells[9]?.querySelector('.dt__pos, .dt__neg'), null);
    const closing = bodyRows(r).find((tr) => tr.textContent?.includes('CLOSE')) as HTMLTableRowElement;
    assert.ok(closing.classList.contains('dt__row--closing'));
  });

  it('selects with Space, opens with Enter, hides a column, streams 3 positions after 2 s and updates marks', async () => {
    const r = mount(h(PositionsPage, { load: async () => structuredClone(FIXTURE) }));
    await settle();
    const first = bodyRows(r)[0] as HTMLTableRowElement;
    actSync(() => first.focus());
    key(first, 'keydown', { key: ' ' });
    assert.match(out(r), /^selected 1 · opened - · hidden -$/);
    key(first, 'keydown', { key: ' ' });
    key(first, 'keydown', { key: 'Enter' });
    assert.equal(out(r), `selected 0 · opened ${FIXTURE.positions[0]?.position_id as string} · hidden -`);
    key(r.container.querySelector('button[aria-label="Columns of Open positions"]') as HTMLElement, 'keydown', { key: 'Enter' });
    click([...document.querySelectorAll('[role="menuitemcheckbox"]')].find((i) => i.textContent === 'Name') as HTMLElement);
    assert.match(out(r), /hidden name$/);
    key(document.querySelector('[role="menu"]') as HTMLElement, 'keydown', { key: 'Escape' });
    tick(10);
    click(button(r, 'Stream 3 new positions in 2 s'));
    actSync(() => first.focus());
    tick(STREAM_DELAY_MS - 10);
    assert.equal(bodyRows(r).length, 8);
    assert.ok(document.activeElement === first);
    tick(10);
    assert.equal(bodyRows(r).length, 11);
    assert.deepEqual(bodyRows(r).slice(0, 3).map((tr) => tr.cells[0]?.querySelector('[aria-hidden]')?.textContent), ['NEW3', 'NEW2', 'NEW1']);
    assert.ok(document.activeElement === first, 'the focused position keeps focus');
    assert.equal(r.container.querySelector('.dt__pill')?.textContent, '3 new');
    click(button(r, 'Stream 3 new positions in 2 s'));
    tick(STREAM_DELAY_MS);
    assert.equal(bodyRows(r)[0]?.cells[0]?.querySelector('[aria-hidden]')?.textContent, 'NEW6');
    click(button(r, 'Update marks'));
    assert.ok(r.container.querySelectorAll('td[data-flash]').length > 0);
    click(button(r, 'Update marks'));
  });

  it('shows the error with Retry, then the data; an empty snapshot shows the empty state', async () => {
    let calls = 0;
    const load: Loader = async () => {
      calls += 1;
      if (calls === 1) throw new Error('HTTP 503');
      return { ...structuredClone(FIXTURE), positions: [] };
    };
    const r = mount(h(PositionsPage, { load }));
    await settle();
    assert.equal(r.container.querySelector('.dt__error .state__reason')?.textContent?.includes('Positions could not be loaded'), true);
    assert.equal(button(r, 'Stream 3 new positions in 2 s').getAttribute('aria-disabled'), 'true');
    click(button(r, 'Retry'));
    await settle();
    assert.equal(calls, 2);
    assert.equal(r.container.querySelector('.dt__placeholder .state__reason')?.textContent, 'No open positions');
    assert.equal(r.container.querySelector('.dt__placeholder .state__context')?.textContent, 'Bot in paper mode');
  });

  it('ignores a response that arrives after unmounting', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    let reject: (e: unknown) => void = () => undefined;
    const ok = render(h(PositionsPage, { load: () => new Promise((res) => { resolve = res; }) }));
    ok.unmount();
    resolve(structuredClone(FIXTURE));
    const bad = render(h(PositionsPage, { load: () => new Promise((_, rej) => { reject = rej; }) }));
    bad.unmount();
    reject(new Error('late'));
    await settle();
  });

  it('drops a pending stream on unmount', async () => {
    const r = render(h(PositionsPage, { load: async () => structuredClone(FIXTURE) }));
    await settle();
    click(button(r, 'Stream 3 new positions in 2 s'));
    r.unmount();
    tick(STREAM_DELAY_MS);
  });

  it('the section loads through fetch from the page origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = mount(h('div', null, positionsSection.render()));
    await actAsync(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
    await actAsync(async () => { await new Promise((res) => { setImmediate(res); }); });
    assert.equal(String(fetchMock.mock.calls[0]?.[0]), '/api/v1/vm/VM-05');
    assert.equal(bodyRows(r).length, 8);
  });
});

describe('UI-T06 catalogue helpers', () => {
  it('fetchJson asks for JSON and refuses an error status', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (String(url).endsWith('ok')
      ? new Response('{"a":1}', { status: 200 }) : new Response('no', { status: 503 })));
    assert.deepEqual(await fetchJson('/x/ok'), { a: 1 });
    await assert.rejects(fetchJson('/x/bad'), /HTTP 503/);
    assert.deepEqual(fetchMock.mock.calls[0]?.[1], { headers: { accept: 'application/json' } });
  });

  it('baseToDecimal places the point by decimals and needs decimals', () => {
    assert.equal(baseToDecimal('123456789012', 5), '1234567.89012');
    assert.equal(baseToDecimal('5', 6), '0.000005');
    assert.equal(baseToDecimal('18446744073709551615', 0), '18446744073709551615');
    assert.equal(baseToDecimal('5', null), null);
  });

  it('streamed positions, mark moves and generated rows are deterministic', () => {
    const p = streamedPosition(7, '2026-10-06T14:02:17.123Z');
    assert.equal(p.position_id.length, 26);
    assert.equal(p.symbol, 'NEW7');
    const moved = moveMarks([...DEMO_ROWS], 2);
    assert.equal(moved[0]?.unrealized_pnl_net_lamports, '13111111');
    assert.equal(moved[1], DEMO_ROWS[1], 'odd rows keep their mark');
    assert.equal(moved[3], DEMO_ROWS[3], 'a position without PnL keeps its mark');
    assert.deepEqual(perfRows(3), perfRows(3));
    assert.equal(perfRows(5000).length, 5000);
    assert.equal(new Set(perfRows(5000).map((r) => r.position_id)).size, 5000);
  });

  it('?rows= takes 1 to 10,000 rows, else 5,000', () => {
    assert.equal(rowsFromSearch(''), 5000);
    assert.equal(rowsFromSearch('?rows=10000'), 10000);
    assert.equal(rowsFromSearch('?rows=1'), 1);
    assert.equal(rowsFromSearch('?rows=0'), 5000);
    assert.equal(rowsFromSearch('?rows=10001'), 5000);
    assert.equal(rowsFromSearch('?rows=many'), 5000);
  });

  it('the position columns sort token amounts as decimals across tokens', () => {
    const cols = positionColumns(demoClock);
    const size = cols.find((c) => c.id === 'size');
    assert.equal(size?.sort, 'decimal');
    assert.equal(size?.value(DEMO_ROWS[0] as FixturePosition), '1111.1111');
    assert.equal(size?.value(DEMO_ROWS[3] as FixturePosition), null);
    assert.ok(positionColumns(demoClock, true).every((c) => c.group !== undefined));
  });
});

describe('UI-T06 catalogue: table states and performance', () => {
  for (const variant of ['standard', 'dense'] as const) {
    it(`renders every table state (${variant})`, () => {
      const r = mount(h(TableStates, { variant, loadingClock }));
      assert.deepEqual([...r.container.querySelectorAll('.demo__title')].map((t) => t.textContent),
        ['Rows', 'Grouped', 'Streamed', 'Loading', 'Empty', 'Filtered empty', 'Error', 'Stale']);
      assert.equal(r.container.querySelectorAll('.dt-wrap--dense').length, variant === 'dense' ? 8 : 0);
      assert.equal(r.container.querySelectorAll('.dt__row--new').length, 1, 'the streamed row is new on the frozen demo clock');
      assert.ok(r.container.querySelector('.dt__row--disabled'));
      assert.ok(r.container.querySelector('.dt__row--closing'));
      tick(200);
      assert.ok(r.container.querySelector('.dt__placeholder .skeleton'));
      click([...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Clear filters') as HTMLElement);
      click([...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Retry') as HTMLElement);
      key(r.container.querySelector('tbody tr[data-row-id]') as HTMLElement, 'keydown', { key: ' ' });
    });
  }

  it('the performance page updates a cell 20 times a second and streams rows after 2 s', () => {
    const r = mount(h(TablePerf, { count: 150 }));
    assert.equal(r.container.querySelector('.dt__title')?.textContent, '150 rows');
    const pnl = (): string => (r.container.querySelector('tr[data-row-id="P000000"]') as HTMLTableRowElement | null)?.cells[9]?.textContent ?? '';
    const before = pnl();
    click(r.container.querySelector('[role="switch"]') as HTMLElement);
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) { tick(50); seen.add(pnl()); }
    assert.equal(seen.size, 20, 'every value is shown');
    assert.notEqual(pnl(), before);
    click(r.container.querySelector('[role="switch"]') as HTMLElement);
    const stopped = pnl();
    tick(200);
    assert.equal(pnl(), stopped);
    click(button(r, 'Stream 3 rows in 2 s'));
    tick(STREAM_DELAY_MS);
    assert.equal(r.container.querySelector('table')?.getAttribute('aria-rowcount'), '154');
  });

  it('registers the sections; the performance page is standalone and reads ?rows=', () => {
    assert.deepEqual([tableStatesSection.id, tableDenseSection.id, positionsSection.id, tablePerfSection.id], ['table', 'table-dense', 'positions', 'table-perf']);
    assert.equal(tablePerfSection.standalone, true);
    const r = mount(h('div', null, tablePerfSection.render(), tableStatesSection.render(), tableDenseSection.render()));
    assert.ok([...r.container.querySelectorAll('.dt__title')].some((t) => t.textContent === '5000 rows'));
  });
});
