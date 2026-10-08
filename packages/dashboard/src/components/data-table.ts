// DataTable (UI-T06, C23) on TanStack Table 9 and TanStack Virtual 3: a native <table> (rows are focusable, cells are
// not, so no grid role), column formats from the money module, numbers right-aligned in tabular figures, min/max
// widths, client sorting for streamed sets or server sorting for paged sets, pinning, resizing by pointer, touch and
// keyboard, a column-visibility menu (controlled, so the preferences store can persist it), and virtual rows above 200.
// Keyboard: J/K or arrows move the focused row (roving tabindex), Home/End, Enter opens, Space selects. New rows carry
// a 2 s marker; a changed cell flashes at most once a second (a static marker under reduced motion) while its text is
// always current. When the user has scrolled or focused a row, rows streamed in above do not move the view: a "n new"
// pill counts them instead. The row context menu copies the raw view-model entity as JSON.
// States (C23): loading (skeleton rows after 200 ms), empty and filtered-empty (reason and next step), error (keeps the
// rows, shows the error with Retry above them); stale is a badge in the `status` slot.
// Rows are memoised: a scroll renders only the rows entering the virtual window, and a streamed change re-renders only
// the rows whose entity changed.
import {
  createElement as h, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode,
} from 'react';
import * as DM from '@radix-ui/react-dropdown-menu';
import {
  columnPinningFeature, columnResizingFeature, columnSizingFeature, columnVisibilityFeature, createSortedRowModel, functionalUpdate, rowSortingFeature, tableFeatures, useTable,
  type ColumnDef, type Header, type RowData, type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Columns3 } from 'lucide-react';
import type { Clock } from '@bot/types';
import { wallClock, type ElapsedClock } from '../lib/clock.ts';
import { sanitizeUntrusted, type Formatted } from '../lib/money.ts';
import { NEW_ROW_MS, columnGroups, compareValues, insertedAbove, nextRowIndex, resizeByKey, rowCopyText, shouldFlash, type CellValue, type SortType } from '../lib/table.ts';
import { cx } from './cx.ts';
import { Icon } from './icon.ts';
import { ContextMenu } from './menu.ts';
import { Num } from './num.ts';
import { Skeleton, StateView, useDelayedFlag, type StateViewProps } from './states.ts';

/** Rows above this count are virtualised. */
export const VIRTUAL_THRESHOLD = 200;

export interface ColumnSpec<T> {
  id: string;
  header: string;
  /** The raw value: sorting, change detection and copy use it. */
  value: (row: T) => CellValue;
  /**
   * The display: a money-module value or any node. Defaults to the raw value as text. A cell re-renders when its row
   * entity or the column specs change, so a display that depends on time (an age) needs new specs as time passes.
   */
  format?: (row: T) => Formatted | ReactNode;
  /** Numbers: right-aligned, tabular figures. */
  numeric?: boolean;
  sort?: SortType | false;
  size?: number;
  minSize?: number;
  maxSize?: number;
  pin?: 'start' | 'end';
  /** Untrusted text (token symbol 12, name 32): cleaned, capped with an ellipsis, full text kept for the tooltip. */
  untrusted?: number;
  /** Header group label (the grouped variant). */
  group?: string;
  hideable?: boolean;
}

export type RowState = 'closing' | 'disabled';

export type TableStateKind = 'loading' | 'empty' | 'filtered-empty' | 'error';

export interface DataTableProps<T> {
  /** The table's name (caption and menu labels). */
  label: string;
  columns: readonly ColumnSpec<T>[];
  rows: readonly T[];
  rowId: (row: T) => string;
  variant?: 'standard' | 'dense';
  /** server: rows arrive sorted; sorting changes go to onSortingChange. */
  sortMode?: 'client' | 'server';
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  columnVisibility?: Record<string, boolean>;
  onColumnVisibilityChange?: (visibility: Record<string, boolean>) => void;
  selected?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  onOpenRow?: (row: T) => void;
  rowState?: (row: T) => RowState | undefined;
  /** The raw entity copied by "Copy row as JSON" (defaults to the row). */
  raw?: (row: T) => unknown;
  /** Toolbar content beside the title, e.g. a freshness indicator or a stale badge. */
  status?: ReactNode;
  /** loading, empty or filtered-empty (shown when there are no rows) or error (shown above the kept rows). */
  state?: StateViewProps & { kind: TableStateKind };
  /** Height of the scrolling body in px. */
  height?: number;
  /** The data clock: new-row markers and the flash throttle. */
  clock?: Clock;
  /** Measures the loading skeleton's 200 ms delay and 400 ms minimum in real time (default: monotonic), whatever the data clock. */
  loadingClock?: ElapsedClock;
}

const isFormatted = (v: unknown): v is Formatted => typeof v === 'object' && v !== null && 'text' in v && 'label' in v && 'tooltip' in v;

function display<T>(col: ColumnSpec<T>, row: T): ReactNode {
  const value = col.format === undefined ? col.value(row) : col.format(row);
  if (isFormatted(value)) return h('span', { title: value.tooltip }, h(Num, { value }));
  if (col.untrusted !== undefined && typeof value === 'string') {
    const s = sanitizeUntrusted(value, col.untrusted);
    return h('span', { className: 'dt__text', title: s.full },
      h('span', { 'aria-hidden': true }, s.text),
      h('span', { className: 'visually-hidden' }, s.full),
      s.nonLatin ? h('span', { className: 'dt__flag', title: 'Contains non-Latin or mixed scripts' }, '?') : null);
  }
  return value === null || value === undefined ? h('span', { title: 'Not available' }, '—') : (value as ReactNode);
}

/** The row height from the density token (`--row-h`) as seen by `el`, or the variant's default. */
export function rowHeightOf(el: HTMLElement, dense: boolean): number {
  const px = Number.parseFloat(getComputedStyle(el).getPropertyValue('--row-h'));
  return Number.isFinite(px) && px > 0 ? px : dense ? 28 : 32;
}

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
  columnPinningFeature,
});

/** A visible column as the rows draw it. */
interface CellLayout<T> { spec: ColumnSpec<T>; width: number; pin: Record<string, number>; pinned: boolean }

interface DataRowProps<T> {
  original: T;
  id: string;
  domId: string;
  rowIndex: number;
  tabbable: boolean;
  focused: boolean;
  selected: boolean;
  isNew: boolean;
  state: RowState | undefined;
  /** The columns flashing now and their flash times, as JSON entries (a string, so memo compares it by value). */
  flashing: string;
  layout: readonly CellLayout<T>[];
  onFocusRow: (id: string) => void;
  onOpen: (row: T) => void;
}

function DataRowImpl<T>(props: DataRowProps<T>): ReactElement {
  const flashes = new Map(JSON.parse(props.flashing) as Array<[string, number]>);
  return h('tr', {
    id: props.domId,
    'data-row-id': props.id,
    'aria-rowindex': props.rowIndex,
    tabIndex: props.tabbable ? 0 : -1,
    className: cx('dt__row', props.selected && 'dt__row--selected', props.isNew && 'dt__row--new', props.state !== undefined && `dt__row--${props.state}`, props.focused && 'dt__row--focused'),
    onFocus: () => props.onFocusRow(props.id),
    onDoubleClick: () => props.onOpen(props.original),
  }, props.layout.map((c, ci) => {
    const flash = flashes.get(c.spec.id);
    return h('td', {
      // A new flash remounts the cell, which restarts its CSS animation.
      key: `${c.spec.id}:${flash ?? ''}`,
      className: cx('dt__td', c.spec.numeric === true && 'dt__td--num', c.pinned && 'dt__td--pinned'),
      style: { width: c.width, ...c.pin },
      'data-flash': flash === undefined ? undefined : '',
    }, display(c.spec, props.original), ci === 0 && (props.selected || props.state !== undefined)
      ? h('span', { className: 'visually-hidden' }, `, ${[props.selected ? 'selected' : null, props.state].filter(Boolean).join(', ')}`) : null);
  }));
}

const DataRow = memo(DataRowImpl) as typeof DataRowImpl;

export function DataTable<T extends RowData>(props: DataTableProps<T>): ReactElement {
  const clock = props.clock ?? wallClock;
  const dense = props.variant === 'dense';
  const domId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sortingState, setSortingState] = useState<SortingState>([]);
  const [visibilityState, setVisibilityState] = useState<Record<string, boolean>>({});
  const sorting = props.sorting ?? sortingState;
  const visibility = props.columnVisibility ?? visibilityState;

  const columns = useMemo(() => props.columns.map((c): ColumnDef<typeof features, T> => ({
    id: c.id,
    header: c.header,
    accessorFn: (row: T) => c.value(row) ?? undefined,
    size: c.size ?? 160,
    minSize: c.minSize ?? 64,
    maxSize: c.maxSize ?? 480,
    enableSorting: c.sort !== false,
    // Every column sorts ascending first (TanStack would start numbers descending).
    sortDescFirst: false,
    enableHiding: c.hideable !== false,
    sortUndefined: 'last',
    sortFn: (a, b, id) => compareValues(a.getValue(id) as string | number, b.getValue(id) as string | number, c.sort === false || c.sort === undefined ? 'text' : c.sort),
  })), [props.columns]);

  const table = useTable<typeof features, T>({
    features,
    columns,
    data: props.rows as T[],
    getRowId: (row: T) => props.rowId(row),
    manualSorting: props.sortMode === 'server',
    enableSortingRemoval: true,
    columnResizeMode: 'onChange',
    state: { sorting, columnVisibility: visibility },
    initialState: { columnPinning: { start: props.columns.filter((c) => c.pin === 'start').map((c) => c.id), end: props.columns.filter((c) => c.pin === 'end').map((c) => c.id) } },
    onSortingChange: (u) => {
      const next = functionalUpdate(u, sorting);
      setSortingState(next);
      props.onSortingChange?.(next);
    },
    onColumnVisibilityChange: (u) => {
      const next = functionalUpdate(u, visibility);
      setVisibilityState(next);
      props.onColumnVisibilityChange?.(next);
    },
  });

  const rows = table.getRowModel().rows;
  const ids = rows.map((r) => r.id);
  const virtual = rows.length > VIRTUAL_THRESHOLD;
  // The density token decides the row height: read on mount and when the density preference changes.
  const [rowHeight, setRowHeight] = useState(dense ? 28 : 32);
  useLayoutEffect(() => {
    const read = (): void => setRowHeight(rowHeightOf(scrollRef.current as HTMLDivElement, dense));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-density'] });
    return () => observer.disconnect();
  }, [dense]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    enabled: virtual,
    initialRect: { width: 1024, height: props.height ?? 480 },
  });
  const measuredHeight = useRef(rowHeight);
  useEffect(() => {
    if (measuredHeight.current === rowHeight) return;
    measuredHeight.current = rowHeight;
    virtualizer.measure();
  }, [rowHeight]);

  // Focus, new rows, flashes and the "n new" pill.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const pendingFocus = useRef(false);
  const [pill, setPill] = useState(0);
  const prevIds = useRef<string[] | null>(null);
  const seenAt = useRef(new Map<string, number>());
  const prevRows = useRef(new Map<string, T>());
  const lastFlash = useRef(new Map<string, Map<string, number>>());
  const [, setRenderTick] = useState(0);

  useLayoutEffect(() => {
    const now = clock.nowMs();
    const prev = prevIds.current;
    const el = scrollRef.current as HTMLDivElement;
    // New rows and flashes are drawn by one more render.
    let changed = false;
    // The first rows (on mount, or after an empty or loading table) are a snapshot, not streamed inserts.
    if (prev !== null && prev.length > 0) {
      const focusInside = focusedId !== null && el.contains(document.activeElement);
      const engaged = focusInside || el.scrollTop > 0;
      // Without focus, the anchor is the first row that was visible before this change.
      const anchor = focusInside ? focusedId : (prev[Math.floor(el.scrollTop / rowHeight)] ?? null);
      const above = engaged ? insertedAbove(prev, ids, anchor) : 0;
      if (above > 0) {
        el.scrollTop += above * rowHeight;
        setPill((n) => n + above);
      }
      const before = new Set(prev);
      for (const id of ids) {
        if (before.has(id)) continue;
        seenAt.current.set(id, now);
        changed = true;
      }
    }
    prevIds.current = ids;
    // Forget removed rows, then flash changed cells, at most once a second each.
    const present = new Set(ids);
    for (const id of [...prevRows.current.keys()]) {
      if (present.has(id)) continue;
      prevRows.current.delete(id);
      seenAt.current.delete(id);
      lastFlash.current.delete(id);
    }
    for (const r of rows) {
      const old = prevRows.current.get(r.id);
      prevRows.current.set(r.id, r.original);
      if (old === undefined || old === r.original) continue;
      const cells = lastFlash.current.get(r.id) ?? new Map<string, number>();
      lastFlash.current.set(r.id, cells);
      for (const c of props.columns) {
        if (c.value(old) === c.value(r.original) || !shouldFlash(cells.get(c.id), now)) continue;
        cells.set(c.id, now);
        changed = true;
      }
    }
    if (changed) setRenderTick((t) => t + 1);
    // Runs once per new rows array (a snapshot or a streamed change), not on focus or scroll.
  }, [props.rows]);

  // Re-render when the new-row markers and flashes of this change expire.
  useEffect(() => {
    const timer = setTimeout(() => setRenderTick((t) => t + 1), NEW_ROW_MS);
    return () => clearTimeout(timer);
  }, [props.rows]);

  const rowDomId = (id: string): string => `${domId}-row-${id}`;
  // A keyboard move focuses its row once it is rendered (a virtual row appears after the scroll it caused).
  useEffect(() => {
    if (!pendingFocus.current || focusedId === null) return;
    const el = document.getElementById(rowDomId(focusedId));
    if (el === null && ids.includes(focusedId)) return;
    pendingFocus.current = false;
    el?.focus();
  });

  // Stable callbacks for the memoised rows; they read the latest props.
  const latest = useRef(props);
  latest.current = props;
  const onFocusRow = useCallback((id: string) => setFocusedId(id), []);
  const onOpen = useCallback((row: T) => latest.current.onOpenRow?.(row), []);

  const focusIndex = Math.max(0, focusedId === null ? 0 : ids.indexOf(focusedId));
  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>): void => {
    const target = e.target as HTMLElement;
    if (target.dataset['rowId'] === undefined) return;
    const at = ids.indexOf(target.dataset['rowId']);
    const row = rows[at] as (typeof rows)[number];
    if (e.key === 'Enter') { e.preventDefault(); props.onOpenRow?.(row.original); return; }
    if (e.key === ' ') { e.preventDefault(); props.onToggleSelect?.(row.id); return; }
    const next = nextRowIndex(at, e.key, rows.length);
    if (next === null || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (virtual) virtualizer.scrollToIndex(next, { align: 'auto' });
    pendingFocus.current = true;
    setFocusedId(ids[next] as string);
  };

  // The row under the context menu. Right click and touch long press (Radix opens on both) pick the row first;
  // elsewhere in the body no menu opens.
  const [menuRowId, setMenuRowId] = useState<string | null>(null);
  const menuRow = rows.find((r) => r.id === menuRowId);
  const pickMenuRow = (e: MouseEvent<HTMLTableSectionElement>): void => {
    const id = (e.target as HTMLElement).closest('tr')?.dataset['rowId'];
    setMenuRowId(id ?? null);
    if (id === undefined && e.type === 'contextmenu') e.preventDefault();
  };

  const onScroll = (): void => {
    if ((scrollRef.current as HTMLDivElement).scrollTop === 0) setPill(0);
  };
  const showNew = (): void => {
    (scrollRef.current as HTMLDivElement).scrollTop = 0;
    setPill(0);
  };

  const visibleColumns = table.getVisibleLeafColumns();
  const specOf = (id: string): ColumnSpec<T> => props.columns.find((c) => c.id === id) as ColumnSpec<T>;
  const now = clock.nowMs();
  const pinStyle = (colId: string): Record<string, number> => {
    const col = table.getColumn(colId) as NonNullable<ReturnType<typeof table.getColumn>>;
    const pin = col.getIsPinned();
    return pin === 'start' ? { left: col.getStart('start') } : pin === 'end' ? { right: col.getAfter('end') } : {};
  };
  // The cell layout, rebuilt only when columns, visibility or sizes change, so memoised rows can skip a render.
  const layoutKey = visibleColumns.map((c) => `${c.id}:${c.getSize()}:${String(c.getIsPinned())}`).join('|');
  const layout = useMemo((): CellLayout<T>[] => visibleColumns.map((c) => ({
    spec: specOf(c.id), width: c.getSize(), pin: pinStyle(c.id), pinned: c.getIsPinned() !== false,
  })), [layoutKey, props.columns]);

  const header = (hd: Header<typeof features, T, unknown>): ReactElement => {
    const col = hd.column;
    const spec = specOf(col.id);
    const dir = col.getIsSorted();
    const sortable = col.getCanSort();
    const label = spec.header;
    const [min, max] = [col.columnDef.minSize as number, col.columnDef.maxSize as number];
    return h('th', {
      key: hd.id,
      scope: 'col',
      className: cx('dt__th', spec.numeric === true && 'dt__th--num', col.getIsResizing() && 'dt__th--resizing', col.getIsPinned() !== false && 'dt__th--pinned'),
      style: { width: hd.getSize(), ...pinStyle(col.id) },
      'aria-sort': dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : sortable ? 'none' : undefined,
    },
    sortable
      ? h('button', { type: 'button', className: 'dt__sort', onClick: col.getToggleSortingHandler() },
        h('span', { className: 'dt__label' }, label),
        h(Icon, { icon: dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown, className: cx('dt__sort-icon', dir === false && 'dt__sort-icon--idle') }))
      : h('span', { className: 'dt__label' }, label),
    h('div', {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': `Resize ${label}`,
      'aria-valuenow': hd.getSize(),
      'aria-valuemin': min,
      'aria-valuemax': max,
      tabIndex: 0,
      className: 'dt__resize',
      onMouseDown: hd.getResizeHandler(),
      onTouchStart: hd.getResizeHandler(),
      onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
        const size = resizeByKey(hd.getSize(), e.key, e.shiftKey, min, max);
        if (size === null) return;
        e.preventDefault();
        table.setColumnSizing((s) => ({ ...s, [col.id]: size }));
      },
    }));
  };

  const groups = props.columns.some((c) => c.group !== undefined) ? columnGroups(visibleColumns.map((c) => specOf(c.id).group)) : null;
  const items = virtual ? virtualizer.getVirtualItems() : rows.map((_, index) => ({ index, start: index * rowHeight, end: (index + 1) * rowHeight }));
  // Roving tabindex: the focused row, or the first rendered row when the virtual window has left the focused one.
  const tabbable = items.some((i) => i.index === focusIndex) ? focusIndex : (items[0]?.index ?? 0);
  const headerRows = groups === null ? 1 : 2;
  const padTop = virtual ? (items[0]?.start ?? 0) : 0;
  const padBottom = virtual ? virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0) : 0;
  const state = props.state;
  const loading = state?.kind === 'loading';
  const skeleton = useDelayedFlag(loading && rows.length === 0, props.loadingClock);
  const span = visibleColumns.length;

  const placeholder = (): ReactNode => {
    if (rows.length > 0) return null;
    if (loading) return skeleton ? h('tr', { className: 'dt__placeholder' }, h('td', { colSpan: span }, h(Skeleton, { shape: 'row', count: 5 }))) : null;
    const kind = state?.kind === 'filtered-empty' ? 'filtered-empty' : 'empty';
    return h('tr', { className: 'dt__placeholder' }, h('td', { colSpan: span }, h(StateView, { ...state, kind })));
  };

  const flashingOf = (id: string): string => {
    const cells = lastFlash.current.get(id);
    return JSON.stringify(cells === undefined ? [] : [...cells].filter(([, at]) => now - at < NEW_ROW_MS));
  };

  return h('div', { className: cx('dt-wrap', dense && 'dt-wrap--dense') },
    h('div', { className: 'dt__toolbar' },
      h('span', { className: 'dt__title', id: `${domId}-title` }, props.label),
      props.status ?? null,
      h('span', { className: 'dt__spacer' }),
      pill > 0 ? h('button', { type: 'button', className: 'dt__pill', onClick: showNew }, `${pill} new`) : null,
      h(ColumnsMenu, { label: props.label, columns: table.getAllLeafColumns().filter((c) => c.getCanHide()).map((c) => ({ id: c.id, header: specOf(c.id).header, visible: c.getIsVisible(), toggle: () => c.toggleVisibility() })) })),
    state?.kind === 'error' ? h('div', { className: 'dt__error' }, h(StateView, { ...state, lastGood: undefined })) : null,
    h('div', { className: 'dt__scroll', ref: scrollRef, onScroll, style: props.height === undefined ? undefined : { maxHeight: props.height } },
      h('table', { className: 'dt', style: { width: table.getTotalSize() }, 'aria-labelledby': `${domId}-title`, 'aria-rowcount': rows.length + headerRows, 'aria-busy': loading },
        h('thead', { className: 'dt__head' },
          groups === null ? null : h('tr', { className: 'dt__groups' }, groups.map((g, i) => h('th', { key: i, colSpan: g.span, scope: 'colgroup', className: 'dt__group' }, g.label))),
          table.getHeaderGroups().map((hg) => h('tr', { key: hg.id }, hg.headers.map((hd) => header(hd))))),
        h(ContextMenu, { label: `${props.label} row`, items: menuRow === undefined ? [] : [
          { label: 'Copy row as JSON', onSelect: () => { void navigator.clipboard.writeText(rowCopyText(props.raw === undefined ? menuRow.original : props.raw(menuRow.original))); } },
          ...(props.onOpenRow === undefined ? [] : [{ label: 'Open', onSelect: () => props.onOpenRow?.(menuRow.original) }]),
        ] }, h('tbody', { onKeyDown, onContextMenu: pickMenuRow, onPointerDown: pickMenuRow },
          padTop > 0 ? h('tr', { 'aria-hidden': true, className: 'dt__pad' }, h('td', { colSpan: span, style: { height: padTop } })) : null,
          placeholder(),
          items.map((item) => {
            const row = rows[item.index] as (typeof rows)[number];
            return h(DataRow<T>, {
              key: row.id,
              original: row.original,
              id: row.id,
              domId: rowDomId(row.id),
              rowIndex: item.index + headerRows + 1,
              tabbable: item.index === tabbable,
              focused: row.id === focusedId,
              selected: props.selected?.has(row.id) === true,
              isNew: (seenAt.current.get(row.id) ?? Number.NEGATIVE_INFINITY) > now - NEW_ROW_MS,
              state: props.rowState?.(row.original),
              flashing: flashingOf(row.id),
              layout,
              onFocusRow,
              onOpen,
            });
          }),
          padBottom > 0 ? h('tr', { 'aria-hidden': true, className: 'dt__pad' }, h('td', { colSpan: span, style: { height: padBottom } })) : null)))));
}

function ColumnsMenu(props: { label: string; columns: ReadonlyArray<{ id: string; header: string; visible: boolean; toggle: () => void }> }): ReactElement {
  return h(DM.Root, { modal: false },
    h(DM.Trigger, { asChild: true }, h('button', { type: 'button', className: 'icon-btn icon-btn--outline', 'aria-label': `Columns of ${props.label}` }, h(Icon, { icon: Columns3 }))),
    h(DM.Portal, null, h(DM.Content, { className: 'menu', sideOffset: 4, collisionPadding: 8, align: 'end' }, props.columns.map((c) =>
      h(DM.CheckboxItem, { key: c.id, className: 'menu__item', checked: c.visible, onSelect: (e: Event) => e.preventDefault(), onCheckedChange: c.toggle },
        h('span', { className: 'menu__text' }, c.header),
        h(DM.ItemIndicator, null, h(Icon, { icon: Check })))))));
}
