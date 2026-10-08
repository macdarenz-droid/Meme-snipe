// UI-T06 DataTable in a DOM: native table semantics, formats, client and server sorting with BigInt strings, keyboard
// rows (roving tabindex, J/K, arrows, Home/End, Enter, Space), keyboard resizing, the column-visibility menu, pinning,
// header groups, the C23 states, new-row markers, the flash throttle with current text, the "n new" pill keeping focus
// (acceptance 2), copy as JSON, virtualisation (acceptance 1's DOM bound) and the density row height.
import './dom.ts';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import type { Clock, UnixMs } from '@bot/types';
import { DataTable, VIRTUAL_THRESHOLD, rowHeightOf, type ColumnSpec, type DataTableProps } from '../src/components/data-table.ts';
import type { ElapsedClock } from '../src/lib/clock.ts';
import { formatSol } from '../src/lib/money.ts';
import { actAsync, actSync, click, fire, key, render, type Rendered } from './dom.ts';

interface Row { id: string; sym: string; lamports: string | null; n: number; note?: string }

let nowMs = 1_000_000;
const clock: Clock = { nowMs: () => nowMs as UnixMs, kind: 'wall' };

const COLUMNS: ColumnSpec<Row>[] = [
  { id: 'sym', header: 'Token', value: (r) => r.sym, untrusted: 12, pin: 'start', hideable: false },
  { id: 'lamports', header: 'Amount', value: (r) => r.lamports, numeric: true, sort: 'bigint', format: (r) => formatSol(r.lamports), size: 200, pin: 'end' },
  { id: 'n', header: 'Count', value: (r) => r.n, numeric: true, sort: 'number' },
  { id: 'note', header: 'Note', value: (r) => r.note, sort: false },
];

const rowsOf = (n: number, prefix = 'r'): Row[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, sym: `T${i}`, lamports: String(i * 1_000_000_000), n: i }));

const mounted: Rendered[] = [];
const mount = (el: ReactElement): Rendered => { const r = render(el); mounted.push(r); return r; };
const table = (props: Partial<DataTableProps<Row>> & { rows: readonly Row[] }): ReactElement =>
  h(DataTable<Row>, { label: 'Positions', columns: COLUMNS, rowId: (r: Row) => r.id, clock, ...props });
const bodyRows = (r: Rendered): HTMLTableRowElement[] => [...r.container.querySelectorAll('tbody tr[data-row-id]')] as HTMLTableRowElement[];
const ids = (r: Rendered): string[] => bodyRows(r).map((tr) => tr.dataset['rowId'] as string);
const header = (r: Rendered, name: string): HTMLTableCellElement =>
  [...r.container.querySelectorAll('th')].find((th) => th.textContent?.startsWith(name)) as HTMLTableCellElement;
/** Real elapsed time for the loading skeleton: advances with the fake timers (the data clock does not). */
let elapsedMs = 0;
const loadingClock: ElapsedClock = { nowMs: () => elapsedMs };
const tick = (ms: number): void => {
  for (let left = ms; left > 0; left -= 10) actSync(() => { elapsedMs += Math.min(10, left); vi.advanceTimersByTime(Math.min(10, left)); });
};

beforeEach(() => { nowMs = 1_000_000; vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
afterEach(() => { while (mounted.length > 0) mounted.pop()?.unmount(); vi.useRealTimers(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('UI-T06 DataTable rendering', () => {
  it('is a native table named by its title, numbers right-aligned in tabular cells, formats and untrusted text', () => {
    const r = mount(table({ rows: [{ id: 'a', sym: 'US\u202EDC', lamports: '1500000000', n: 3 }, { id: 'b', sym: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', lamports: null, n: 4, note: 'hi' }] }));
    const el = r.container.querySelector('table') as HTMLTableElement;
    assert.equal(el.getAttribute('role'), null, 'no grid role: cells are not navigable');
    assert.equal(document.getElementById(el.getAttribute('aria-labelledby') as string)?.textContent, 'Positions');
    assert.equal(el.getAttribute('aria-rowcount'), '3');
    const [a, b] = bodyRows(r) as [HTMLTableRowElement, HTMLTableRowElement];
    assert.equal(a.getAttribute('aria-rowindex'), '2');
    const amount = a.cells[1] as HTMLTableCellElement;
    assert.ok(amount.classList.contains('dt__td--num'));
    assert.equal(amount.querySelector('[aria-hidden]')?.textContent, '1.5000 SOL');
    assert.equal(amount.querySelector('span')?.getAttribute('title'), '1.500000000 SOL (1,500,000,000 lamports)');
    // Untrusted text: the RTL override is removed; long text is capped with an ellipsis and kept whole for the tooltip.
    assert.equal(a.cells[0]?.textContent?.includes('\u202E'), false);
    const long = b.cells[0]?.querySelector('.dt__text') as HTMLElement;
    assert.equal(long.getAttribute('title'), 'X'.repeat(32));
    assert.match(long.querySelector('[aria-hidden]')?.textContent ?? '', /^X+…$/);
    assert.equal(b.cells[1]?.querySelector('[aria-hidden]')?.textContent, '—');
    assert.equal(b.cells[3]?.textContent, 'hi');
    assert.equal(a.cells[3]?.querySelector('span')?.getAttribute('title'), 'Not available');
    assert.equal(header(r, 'Note').getAttribute('aria-sort'), null, 'an unsortable column has no aria-sort');
    assert.equal(header(r, 'Count').getAttribute('aria-sort'), 'none');
  });

  it('pins columns to the start and end, and draws header groups with offset row indexes', () => {
    const grouped = COLUMNS.map((c, i) => ({ ...c, ...(i < 2 ? { group: 'Position' } : {}) }));
    const r = mount(h(DataTable<Row>, { label: 'G', columns: grouped, rows: rowsOf(2), rowId: (x: Row) => x.id, variant: 'dense', clock }));
    assert.ok(r.container.querySelector('.dt-wrap')?.classList.contains('dt-wrap--dense'));
    const groups = [...r.container.querySelectorAll('.dt__group')].map((g) => [g.textContent, (g as HTMLTableCellElement).colSpan]);
    assert.deepEqual(groups, [['Position', 2], ['', 2]]);
    assert.equal(r.container.querySelector('table')?.getAttribute('aria-rowcount'), '4');
    assert.equal(bodyRows(r)[0]?.getAttribute('aria-rowindex'), '3');
    const token = header(r, 'Token');
    assert.ok(token.classList.contains('dt__th--pinned'));
    assert.equal(token.style.left, '0px');
    assert.ok(header(r, 'Amount').classList.contains('dt__th--pinned'));
    assert.equal(header(r, 'Amount').style.right, '0px');
    assert.ok(bodyRows(r)[0]?.cells[0]?.classList.contains('dt__td--pinned'));
  });

  it('runs on the wall clock by default', () => {
    const r = mount(h(DataTable<Row>, { label: 'Wall', columns: COLUMNS, rows: rowsOf(1), rowId: (x: Row) => x.id }));
    assert.equal(bodyRows(r).length, 1);
  });

  it('reads the row height from the density token, else the variant default', () => {
    const el = document.createElement('div');
    document.body.append(el);
    assert.equal(rowHeightOf(el, false), 32);
    assert.equal(rowHeightOf(el, true), 28);
    el.style.setProperty('--row-h', '40px');
    assert.equal(rowHeightOf(el, false), 40);
  });
});

describe('UI-T06 sorting', () => {
  const big = [
    { id: 'max', sym: 'MAX', lamports: '18446744073709551615', n: 1 },
    { id: 'p53', sym: 'P53', lamports: '9007199254740993', n: 2 },
    { id: 'none', sym: 'NONE', lamports: null, n: 3 },
    { id: 'q53', sym: 'Q53', lamports: '9007199254740992', n: 4 },
    { id: 'zero', sym: 'ZERO', lamports: '0', n: 5 },
  ];

  it('sorts BigInt strings exactly on the client: ascending, descending, then unsorted; missing values last', () => {
    const onSortingChange = vi.fn();
    const r = mount(table({ rows: big, onSortingChange }));
    const button = header(r, 'Amount').querySelector('button') as HTMLButtonElement;
    click(button);
    assert.equal(header(r, 'Amount').getAttribute('aria-sort'), 'ascending');
    assert.deepEqual(ids(r), ['zero', 'q53', 'p53', 'max', 'none']);
    click(button);
    assert.equal(header(r, 'Amount').getAttribute('aria-sort'), 'descending');
    assert.deepEqual(ids(r), ['max', 'p53', 'q53', 'zero', 'none']);
    click(button);
    assert.equal(header(r, 'Amount').getAttribute('aria-sort'), 'none');
    assert.deepEqual(ids(r), ['max', 'p53', 'none', 'q53', 'zero']);
    assert.deepEqual(onSortingChange.mock.calls.map((c) => c[0]), [[{ id: 'lamports', desc: false }], [{ id: 'lamports', desc: true }], []]);
    // Text columns sort without a declared type.
    click(header(r, 'Token').querySelector('button') as HTMLButtonElement);
    assert.deepEqual(ids(r), ['max', 'none', 'p53', 'q53', 'zero']);
  });

  it('server mode keeps the rows as delivered and reports the sorting; a controlled sorting is shown', () => {
    const onSortingChange = vi.fn();
    const r = mount(table({ rows: big, sortMode: 'server', onSortingChange }));
    click(header(r, 'Count').querySelector('button') as HTMLButtonElement);
    assert.deepEqual(ids(r), ['max', 'p53', 'none', 'q53', 'zero']);
    assert.deepEqual(onSortingChange.mock.calls[0]?.[0], [{ id: 'n', desc: false }]);
    const c = mount(table({ rows: big, sorting: [{ id: 'n', desc: true }] }));
    assert.deepEqual(ids(c), ['zero', 'q53', 'none', 'p53', 'max']);
    assert.equal(header(c, 'Count').getAttribute('aria-sort'), 'descending');
  });
});

describe('UI-T06 keyboard', () => {
  it('roving tabindex; J/K, arrows, Home and End move focus; Enter opens; Space selects; other keys pass', () => {
    const onOpenRow = vi.fn();
    const onToggleSelect = vi.fn();
    const r = mount(table({ rows: rowsOf(5), onOpenRow, onToggleSelect, selected: new Set(['r1']) }));
    const tabbable = (): string[] => bodyRows(r).filter((tr) => tr.tabIndex === 0).map((tr) => tr.dataset['rowId'] as string);
    assert.deepEqual(tabbable(), ['r0']);
    const first = bodyRows(r)[0] as HTMLTableRowElement;
    actSync(() => first.focus());
    const press = (k: string, init: KeyboardEventInit = {}): string | undefined => {
      key(document.activeElement as Element, 'keydown', { key: k, ...init });
      return (document.activeElement as HTMLElement).dataset['rowId'];
    };
    assert.equal(press('j'), 'r1');
    assert.equal(press('ArrowDown'), 'r2');
    assert.equal(press('k'), 'r1');
    assert.equal(press('ArrowUp'), 'r0');
    assert.equal(press('End'), 'r4');
    assert.deepEqual(tabbable(), ['r4']);
    assert.ok(bodyRows(r)[4]?.classList.contains('dt__row--focused'));
    assert.equal(press('Home'), 'r0');
    assert.equal(press('j', { ctrlKey: true }), 'r0', 'modified keys are left to the browser');
    assert.equal(press('x'), 'r0');
    press('Enter');
    assert.equal(onOpenRow.mock.calls[0]?.[0].id, 'r0');
    press(' ');
    assert.deepEqual(onToggleSelect.mock.calls[0], ['r0']);
    // Selected rows say so to screen readers.
    assert.ok(bodyRows(r)[1]?.classList.contains('dt__row--selected'));
    assert.equal(bodyRows(r)[1]?.cells[0]?.lastElementChild?.textContent, ', selected');
    // A double click opens too; keys from a control inside a cell are not row keys.
    fire(bodyRows(r)[2] as HTMLElement, new MouseEvent('dblclick', { bubbles: true }));
    assert.equal(onOpenRow.mock.calls[1]?.[0].id, 'r2');
    key(bodyRows(r)[2]?.cells[0] as HTMLElement, 'keydown', { key: 'Enter' });
    assert.equal(onOpenRow.mock.calls.length, 2);
  });

  it('works without handlers', () => {
    const r = mount(table({ rows: rowsOf(2) }));
    const first = bodyRows(r)[0] as HTMLTableRowElement;
    actSync(() => first.focus());
    key(first, 'keydown', { key: 'Enter' });
    key(first, 'keydown', { key: ' ' });
    fire(first, new MouseEvent('dblclick', { bubbles: true }));
    assert.ok(document.activeElement === first);
  });

  it('resizes a column by keyboard within its bounds', () => {
    const r = mount(table({ rows: rowsOf(1) }));
    const handle = header(r, 'Amount').querySelector('[role="separator"]') as HTMLElement;
    assert.equal(handle.getAttribute('aria-label'), 'Resize Amount');
    assert.equal(handle.getAttribute('aria-valuenow'), '200');
    assert.equal(handle.tabIndex, 0);
    key(handle, 'keydown', { key: 'ArrowRight' });
    assert.equal(handle.getAttribute('aria-valuenow'), '208');
    key(handle, 'keydown', { key: 'ArrowLeft', shiftKey: true });
    assert.equal(handle.getAttribute('aria-valuenow'), '176');
    key(handle, 'keydown', { key: 'Home' });
    assert.equal(handle.getAttribute('aria-valuenow'), '64');
    key(handle, 'keydown', { key: 'Tab' });
    assert.equal(handle.getAttribute('aria-valuenow'), '64');
    assert.equal(header(r, 'Amount').style.width, '64px');
    assert.equal(bodyRows(r)[0]?.cells[1]?.style.width, '64px');
  });

  it('resizes a column by dragging its handle, marked as resizing while dragging', () => {
    const r = mount(table({ rows: rowsOf(1) }));
    const handle = header(r, 'Count').querySelector('[role="separator"]') as HTMLElement;
    fire(handle, new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
    fire(document, new MouseEvent('mousemove', { bubbles: true, clientX: 140 }));
    assert.ok(header(r, 'Count').classList.contains('dt__th--resizing'));
    assert.equal(handle.getAttribute('aria-valuenow'), '200');
    fire(document, new MouseEvent('mouseup', { bubbles: true, clientX: 140 }));
    assert.equal(header(r, 'Count').classList.contains('dt__th--resizing'), false);
  });

  it('the column-visibility menu hides and shows columns (controlled and uncontrolled); fixed columns are not listed', () => {
    const onColumnVisibilityChange = vi.fn();
    const r = mount(table({ rows: rowsOf(1), onColumnVisibilityChange }));
    const trigger = r.container.querySelector('button[aria-label="Columns of Positions"]') as HTMLButtonElement;
    key(trigger, 'keydown', { key: 'Enter' });
    const items = [...document.querySelectorAll('[role="menuitemcheckbox"]')] as HTMLElement[];
    assert.deepEqual(items.map((i) => i.textContent), ['Amount', 'Count', 'Note']);
    assert.ok(items.every((i) => i.getAttribute('aria-checked') === 'true'));
    click(items[1] as HTMLElement);
    assert.equal(header(r, 'Count'), undefined);
    assert.deepEqual({ ...onColumnVisibilityChange.mock.calls[0]?.[0] }, { n: false });
    assert.equal(document.querySelector('[role="menu"]') !== null, true, 'the menu stays open for more changes');
    assert.equal(bodyRows(r)[0]?.cells.length, 3);
    const c = mount(table({ rows: rowsOf(1), columnVisibility: { note: false } }));
    assert.equal(header(c, 'Note'), undefined);
  });
});

describe('UI-T06 states', () => {
  it('loading without rows shows nothing for 200 ms, then skeleton rows; with rows it keeps them, busy', () => {
    // The data clock stays frozen: the skeleton's timing runs on loadingClock, in real time.
    const r = mount(table({ rows: [], state: { kind: 'loading' }, loadingClock }));
    assert.equal(r.container.querySelector('table')?.getAttribute('aria-busy'), 'true');
    assert.equal(r.container.querySelector('.skeleton'), null);
    tick(200);
    assert.equal(r.container.querySelectorAll('.dt__placeholder .skeleton').length, 5);
    r.rerender(table({ rows: rowsOf(2), state: { kind: 'loading' }, loadingClock }));
    assert.equal(bodyRows(r).length, 2);
    assert.equal(r.container.querySelector('.dt__placeholder'), null);
  });

  it('empty, filtered-empty and error states', () => {
    const plain = mount(table({ rows: [] }));
    assert.equal(plain.container.querySelector('.dt__placeholder .state__reason')?.textContent, 'Nothing here yet');
    const empty = mount(table({ rows: [], state: { kind: 'empty', reason: 'No open positions', context: 'Bot in paper mode' } }));
    assert.equal(empty.container.querySelector('.dt__placeholder .state__context')?.textContent, 'Bot in paper mode');
    const onClick = vi.fn();
    const filtered = mount(table({ rows: [], state: { kind: 'filtered-empty', action: { label: 'Clear filters', onClick } } }));
    assert.equal(filtered.container.querySelector('.dt__placeholder .state__reason')?.textContent, 'Nothing matches these filters');
    click(filtered.container.querySelector('.dt__placeholder button') as HTMLElement);
    assert.equal(onClick.mock.calls.length, 1);
    const onRetry = vi.fn();
    const error = mount(table({ rows: rowsOf(2), state: { kind: 'error', reason: 'Refresh failed', onRetry } }));
    assert.equal(error.container.querySelector('.dt__error [role="alert"]')?.textContent?.includes('Refresh failed'), true);
    assert.equal(bodyRows(error).length, 2, 'the last data stays');
    click(error.container.querySelector('.dt__error button') as HTMLElement);
    assert.equal(onRetry.mock.calls.length, 1);
    const status = mount(table({ rows: rowsOf(1), status: h('span', { className: 'stale-badge' }, 'Stale · 12s') }));
    assert.equal(status.container.querySelector('.dt__toolbar .stale-badge')?.textContent, 'Stale · 12s');
  });

  it('row states closing and disabled are marked and announced', () => {
    const r = mount(table({ rows: rowsOf(3), rowState: (x: Row) => (x.id === 'r1' ? 'closing' : x.id === 'r2' ? 'disabled' : undefined), selected: new Set(['r2']) }));
    assert.ok(bodyRows(r)[1]?.classList.contains('dt__row--closing'));
    assert.equal(bodyRows(r)[1]?.cells[0]?.lastElementChild?.textContent, ', closing');
    assert.equal(bodyRows(r)[2]?.cells[0]?.lastElementChild?.textContent, ', selected, disabled');
  });
});

describe('UI-T06 streaming', () => {
  it('marks new rows for 2 s; forgets removed rows', () => {
    const r = mount(table({ rows: rowsOf(3) }));
    assert.equal(r.container.querySelectorAll('.dt__row--new').length, 0, 'the first snapshot is not new');
    r.rerender(table({ rows: [{ id: 'n1', sym: 'NEW', lamports: '1', n: 9 }, ...rowsOf(2)] }));
    assert.deepEqual([...r.container.querySelectorAll('.dt__row--new')].map((tr) => (tr as HTMLElement).dataset['rowId']), ['n1']);
    nowMs += 2000;
    tick(2000);
    assert.equal(r.container.querySelectorAll('.dt__row--new').length, 0);
  });

  it('flashes a changed cell at most once a second while its text stays current', () => {
    let rows = rowsOf(2);
    const r = mount(table({ rows }));
    const amountCell = (): HTMLTableCellElement => bodyRows(r)[0]?.cells[1] as HTMLTableCellElement;
    const update = (lamports: string): void => {
      rows = [{ ...(rows[0] as Row), lamports }, rows[1] as Row];
      r.rerender(table({ rows }));
    };
    update('2000000000');
    const first = amountCell();
    assert.equal(first.getAttribute('data-flash'), '');
    assert.equal(first.querySelector('[aria-hidden]')?.textContent, '2.0000 SOL');
    assert.equal(bodyRows(r)[0]?.cells[2]?.hasAttribute('data-flash'), false, 'unchanged cells do not flash');
    nowMs += 400;
    update('3000000000');
    assert.ok(amountCell() === first, 'no new flash within the second: the cell is not remounted');
    assert.equal(amountCell().querySelector('[aria-hidden]')?.textContent, '3.0000 SOL');
    nowMs += 600;
    update('4000000000');
    assert.ok(amountCell() !== first, 'a second later the cell flashes again');
    assert.equal(amountCell().getAttribute('data-flash'), '');
    nowMs += 2000;
    tick(2000);
    assert.equal(amountCell().hasAttribute('data-flash'), false);
    // A new array with the same row objects changes nothing; a removed row is forgotten.
    r.rerender(table({ rows: [...rows] }));
    r.rerender(table({ rows: [rows[1] as Row] }));
    assert.deepEqual(ids(r), ['r1']);
  });

  it('acceptance 2: with focus on row 10, 3 inserts at the top keep focus and the view and show "3 new"', () => {
    let rows = rowsOf(20);
    const r = mount(table({ rows, height: 320 }));
    const scroller = r.container.querySelector('.dt__scroll') as HTMLElement;
    const row10 = bodyRows(r)[9] as HTMLTableRowElement;
    actSync(() => row10.focus());
    rows = [...rowsOf(3, 'new'), ...rows];
    r.rerender(table({ rows, height: 320 }));
    assert.ok(document.activeElement === row10);
    assert.equal(row10.dataset['rowId'], 'r9');
    assert.equal(row10.getAttribute('aria-rowindex'), '14');
    assert.equal(scroller.scrollTop, 96, 'the view moved down by the 3 inserted rows');
    const pill = [...r.container.querySelectorAll('.dt__pill')] as HTMLButtonElement[];
    assert.deepEqual(pill.map((p) => p.textContent), ['3 new']);
    click(pill[0] as HTMLButtonElement);
    assert.equal(scroller.scrollTop, 0);
    assert.equal(r.container.querySelector('.dt__pill'), null);
  });

  it('counts inserts above the first visible row when scrolled without focus; none at the top', () => {
    let rows = rowsOf(20);
    const r = mount(table({ rows }));
    const scroller = r.container.querySelector('.dt__scroll') as HTMLElement;
    rows = [...rowsOf(2, 'a'), ...rows];
    r.rerender(table({ rows }));
    assert.equal(r.container.querySelector('.dt__pill'), null, 'at the top with no focus, new rows simply appear');
    actSync(() => { scroller.scrollTop = 64; });
    rows = [...rowsOf(1, 'b'), ...rows];
    r.rerender(table({ rows }));
    assert.equal(r.container.querySelector('.dt__pill')?.textContent, '1 new');
    assert.equal(scroller.scrollTop, 96);
    actSync(() => { scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll')); });
    assert.equal(r.container.querySelector('.dt__pill'), null, 'scrolling back to the top clears the pill');
    actSync(() => { scroller.scrollTop = 32; scroller.dispatchEvent(new Event('scroll')); });
    // Every row removed while scrolled: no anchor, nothing counted.
    r.rerender(table({ rows: [] }));
    assert.equal(r.container.querySelector('.dt__pill'), null);
  });

  it('the first visible row removed with a row appended at the bottom: no pill and no jump (review M1)', () => {
    let rows = rowsOf(20);
    const r = mount(table({ rows }));
    const scroller = r.container.querySelector('.dt__scroll') as HTMLElement;
    actSync(() => { scroller.scrollTop = 64; });
    // r2 is the first visible row; it leaves while z0 lands at the bottom. r3 takes its place in the view.
    rows = [...rows.filter((x) => x.id !== 'r2'), ...rowsOf(1, 'z')];
    r.rerender(table({ rows }));
    // Compared as text: a failing assert would otherwise print the whole DOM element.
    assert.equal(r.container.querySelector('.dt__pill')?.textContent ?? null, null);
    assert.equal(scroller.scrollTop, 64);
    // r3 leaves while y0 lands above it: anchored to r4, y0 is counted and the view keeps r4 in place.
    rows = [...rowsOf(1, 'y'), ...rows.filter((x) => x.id !== 'r3')];
    r.rerender(table({ rows }));
    assert.equal(r.container.querySelector('.dt__pill')?.textContent, '1 new');
    assert.equal(scroller.scrollTop, 96);
  });

  it('without focus, the anchor is the first row visible before the inserts, also when they straddle it', () => {
    let rows = rowsOf(20);
    const r = mount(table({ rows }));
    const scroller = r.container.querySelector('.dt__scroll') as HTMLElement;
    actSync(() => { scroller.scrollTop = 320; });
    // r10 is the first visible row. 3 rows land between r7 and r8 (above it) and 2 between r10 and r11 (below it).
    rows = [...rows.slice(0, 8), ...rowsOf(3, 'x'), ...rows.slice(8, 11), ...rowsOf(2, 'z'), ...rows.slice(11)];
    r.rerender(table({ rows }));
    assert.equal(r.container.querySelector('.dt__pill')?.textContent, '3 new');
    assert.equal(scroller.scrollTop, 416, 'r10 stays the first visible row: (10 + 3) rows of 32 px');
    // Scrolled past the last row, there is no first visible row to anchor to: nothing is counted or moved.
    actSync(() => { scroller.scrollTop = 1280; });
    r.rerender(table({ rows: [...rowsOf(1, 'y'), ...rows] }));
    assert.equal(r.container.querySelector('.dt__pill')?.textContent, '3 new');
    assert.equal(scroller.scrollTop, 1280);
  });
});

describe('UI-T06 copy as JSON', () => {
  it('the row context menu copies the raw entity with big integers as strings, and opens the row', async () => {
    const writes: string[] = [];
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (t: string) => { writes.push(t); });
    const onOpenRow = vi.fn();
    const raw = { id: 'r0', size_base: '18446744073709551615', extra: 18446744073709551615n };
    const r = mount(table({ rows: rowsOf(2), raw: (x: Row) => (x.id === 'r0' ? raw : x), onOpenRow }));
    fire(bodyRows(r)[0]?.cells[2] as HTMLElement, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    assert.equal(menu.getAttribute('aria-label'), 'Positions row');
    const items = [...menu.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    assert.deepEqual(items.map((i) => i.textContent), ['Copy row as JSON', 'Open']);
    click(items[0] as HTMLElement);
    assert.deepEqual(JSON.parse(writes[0] as string), { id: 'r0', size_base: '18446744073709551615', extra: '18446744073709551615' });
    fire(bodyRows(r)[1] as HTMLElement, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    click([...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === 'Open') as HTMLElement);
    assert.equal(onOpenRow.mock.calls[0]?.[0].id, 'r1');
  });

  it('copies the row itself without `raw`; no Open item without a handler; no menu outside rows', () => {
    const writes: string[] = [];
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (t: string) => { writes.push(t); });
    const r = mount(table({ rows: rowsOf(1) }));
    fire(bodyRows(r)[0] as HTMLElement, new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    fire(bodyRows(r)[0] as HTMLElement, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const items = [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    assert.deepEqual(items.map((i) => i.textContent), ['Copy row as JSON']);
    click(items[0] as HTMLElement);
    assert.equal(JSON.parse(writes[0] as string).lamports, '0');
    const empty = mount(table({ rows: [] }));
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fire(empty.container.querySelector('.dt__placeholder td') as HTMLElement, event);
    assert.equal(event.defaultPrevented, true);
  });
});

describe('UI-T06 virtualisation', () => {
  // happy-dom has no layout: the scroll box reports the size a browser would.
  const sized = (fn: () => void): void => {
    const proto = HTMLElement.prototype;
    const saved = ['offsetHeight', 'offsetWidth'].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('dt__scroll') ? 480 : 0; } });
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('dt__scroll') ? 1024 : 0; } });
    try { fn(); } finally { for (const [k, d] of saved) Object.defineProperty(proto, k, d as PropertyDescriptor); }
  };

  it(`acceptance 1: above ${VIRTUAL_THRESHOLD} rows only the window is in the DOM; the tab stop stays on a rendered row`, () => sized(() => {
    let rows = rowsOf(5000);
    const r = mount(table({ rows, height: 480 }));
    assert.equal(r.container.querySelector('table')?.getAttribute('aria-rowcount'), '5001');
    const rendered = bodyRows(r).length;
    assert.ok(rendered > 10 && rendered <= 60, `rendered ${rendered}`);
    assert.ok(r.container.querySelector('.dt__pad'), 'the bottom spacer stands for the rest');
    const scroller = r.container.querySelector('.dt__scroll') as HTMLElement;
    actSync(() => { scroller.scrollTop = 32_000; scroller.dispatchEvent(new Event('scroll')); });
    const pads = [...r.container.querySelectorAll('.dt__pad td')].map((td) => (td as HTMLElement).style.height);
    assert.equal(pads.length, 2, 'spacers above and below the window');
    assert.ok(bodyRows(r).some((tr) => tr.dataset['rowId'] === 'r1000'));
    assert.ok(bodyRows(r).length <= 60);
    actSync(() => { scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll')); });
    const first = bodyRows(r)[0] as HTMLTableRowElement;
    actSync(() => first.focus());
    // End moves focus to the last row, which renders once the virtualizer has scrolled (checked in the browser test);
    // until then the first rendered row keeps the tab stop, so Tab can always reach the body.
    key(first, 'keydown', { key: 'End' });
    assert.equal(r.container.querySelector('tr[data-row-id="r4999"]'), null);
    assert.deepEqual(bodyRows(r).filter((tr) => tr.tabIndex === 0).map((tr) => tr.dataset['rowId']), ['r0']);
    // The pending row is removed before it renders: nothing is focused for it later.
    rows = rows.slice(0, 4999);
    r.rerender(table({ rows, height: 480 }));
    assert.ok(document.activeElement === first);
    key(first, 'keydown', { key: 'j' });
    assert.equal((document.activeElement as HTMLElement).dataset['rowId'], 'r1');
    assert.ok(bodyRows(r).length <= 60);
  }));

  it('a 200-row table is not virtualised', () => {
    const r = mount(table({ rows: rowsOf(VIRTUAL_THRESHOLD) }));
    assert.equal(bodyRows(r).length, VIRTUAL_THRESHOLD);
    assert.equal(r.container.querySelector('.dt__pad'), null);
  });

  it('re-reads the row height when the density preference changes', async () => {
    const proto = HTMLElement.prototype;
    const saved = ['offsetHeight', 'offsetWidth'].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('dt__scroll') ? 480 : 0; } });
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('dt__scroll') ? 1024 : 0; } });
    try {
      const r = mount(table({ rows: rowsOf(300), height: 480 }));
      const before = bodyRows(r).length;
      const scroller = r.container.querySelector('.dt__scroll') as HTMLElement;
      scroller.style.setProperty('--row-h', '40px');
      document.documentElement.dataset['density'] = 'comfortable';
      // The observer reports after the current task.
      await actAsync(async () => { await new Promise((resolve) => { setImmediate(resolve); }); });
      // 40 px rows: fewer rows fill the same window.
      assert.ok(bodyRows(r).length < before, `${bodyRows(r).length} < ${before}`);
    } finally {
      for (const [k, d] of saved) Object.defineProperty(proto, k, d as PropertyDescriptor);
      delete document.documentElement.dataset['density'];
    }
  });

});
