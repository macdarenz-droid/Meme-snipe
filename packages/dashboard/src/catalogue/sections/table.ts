// Catalogue sections for the DataTable (UI-T06): the Positions fixture page (VM-05 from the fixture API, formatted by
// the money module), every table state in the standard and dense variants on a fixed demo clock, and a standalone
// performance page of 5,000 generated rows (`?rows=` up to 10,000) with a cell that can change 20 times a second.
import { createElement as h, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { Clock, PositionState } from '@bot/types';
import { Button } from '../../components/button.ts';
import { DataTable, type ColumnSpec, type RowState } from '../../components/data-table.ts';
import { FreshnessIndicator, type ClockSource } from '../../components/states.ts';
import { Badge, type BadgeTone } from '../../components/status.ts';
import { Switch } from '../../components/toggles.ts';
import { wallClock, type ElapsedClock } from '../../lib/clock.ts';
import { thresholdsFor } from '../../lib/freshness.ts';
import { formatAge, formatBps, formatPrice, formatSol, formatTokenAmount, type Formatted } from '../../lib/money.ts';
import type { Section } from '../catalogue.ts';
import { DEMO_NOW, demoClock } from './states.ts';

/**
 * The VM-05 position fields the fixture page shows. A local projection until `@bot/contract` (B-M28-01) exports the
 * VM-05 schema; UI-T08 validates against that schema and the screens use it.
 */
export interface FixturePosition {
  position_id: string;
  strategy_id: string;
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  state: PositionState;
  opened_at: string;
  size_base: string;
  entry_cost_lamports: string;
  entry_price_sol_per_token: string;
  mark_price_sol_per_token: string | null;
  exit_value_est_lamports: string | null;
  unrealized_pnl_net_lamports: string | null;
  unrealized_pnl_net_bps: number | null;
  price_impact_exit_bps: number | null;
  close_failed_reason: string | null;
}

export interface Vm05Snapshot { mode: string; as_of: string; positions: FixturePosition[] }

/** Reads JSON from the dashboard's own origin. */
export type Loader = (path: string) => Promise<unknown>;

export const fetchJson: Loader = async (path) => {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
};

/** `base / 10^decimals` as a decimal string, for sorting token amounts of different tokens; null without decimals. */
export function baseToDecimal(base: string, decimals: number | null): string | null {
  if (decimals === null) return null;
  const digits = base.padStart(decimals + 1, '0');
  return decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

const STATE_TONE: Readonly<Record<PositionState, BadgeTone>> = {
  opening: 'info', open: 'neutral', partially_closed: 'info', closing: 'warn', close_failed: 'danger', stuck: 'danger',
  closed: 'neutral', open_failed: 'danger', orphan: 'warn', written_off: 'neutral',
};

const signClass = (lamports: string | null): string | undefined =>
  lamports === null || /^0+$/.test(lamports) ? undefined : lamports.startsWith('-') ? 'dt__neg' : 'dt__pos';

function pnl(p: FixturePosition): ReactNode {
  const sol = formatSol(p.unrealized_pnl_net_lamports, { signed: true });
  const pct = formatBps(p.unrealized_pnl_net_bps, { as: 'pct', signed: true });
  const cls = signClass(p.unrealized_pnl_net_lamports);
  const arrow = cls === 'dt__pos' ? '▲ ' : cls === 'dt__neg' ? '▼ ' : '';
  return h('span', { className: cls, title: `${sol.tooltip} · ${pct.tooltip}` }, h('span', { 'aria-hidden': true }, arrow), h(Num2, { a: sol, b: pct }));
}

/** Two formatted numbers in one cell, each read by its label. */
function Num2(props: { a: Formatted; b: Formatted }): ReactElement {
  return h('span', { className: 'num' },
    h('span', { 'aria-hidden': true }, `${props.a.text} · ${props.b.text}`),
    h('span', { className: 'visually-hidden' }, `${props.a.label}, ${props.b.label}`));
}

/** The Positions columns (docs/UI.md S-02) that VM-05 alone can fill; ages are read from `clock`. */
export function positionColumns(clock: Clock, grouped = false): ColumnSpec<FixturePosition>[] {
  const g = (label: string): { group?: string } => (grouped ? { group: label } : {});
  return [
    { id: 'symbol', header: 'Token', value: (p) => p.symbol, untrusted: 12, pin: 'start', size: 120, hideable: false, ...g('Position') },
    { id: 'name', header: 'Name', value: (p) => p.name, untrusted: 32, size: 180, ...g('Position') },
    { id: 'strategy', header: 'Strategy', value: (p) => p.strategy_id, size: 96, ...g('Position') },
    { id: 'state', header: 'State', value: (p) => p.state, size: 128, ...g('Position'),
      format: (p) => h(Badge, { tone: STATE_TONE[p.state] }, p.state.replace('_', ' ')) },
    { id: 'size', header: 'Size', numeric: true, sort: 'decimal', size: 168, value: (p) => baseToDecimal(p.size_base, p.decimals), format: (p) => formatTokenAmount(p.size_base, p.decimals), ...g('Entry') },
    { id: 'entry_cost', header: 'Entry cost', numeric: true, sort: 'bigint', size: 136, value: (p) => p.entry_cost_lamports, format: (p) => formatSol(p.entry_cost_lamports), ...g('Entry') },
    { id: 'entry_price', header: 'Entry price', numeric: true, sort: 'decimal', size: 128, value: (p) => p.entry_price_sol_per_token, format: (p) => formatPrice(p.entry_price_sol_per_token), ...g('Entry') },
    { id: 'mark', header: 'Mark', numeric: true, sort: 'decimal', size: 128, value: (p) => p.mark_price_sol_per_token, format: (p) => formatPrice(p.mark_price_sol_per_token), ...g('Now') },
    { id: 'exit_value', header: 'Exit value (est.)', numeric: true, sort: 'bigint', size: 160, value: (p) => p.exit_value_est_lamports, format: (p) => formatSol(p.exit_value_est_lamports), ...g('Now') },
    { id: 'pnl', header: 'Unrealised PnL (net)', numeric: true, sort: 'bigint', size: 240, value: (p) => p.unrealized_pnl_net_lamports, format: pnl, ...g('Now') },
    { id: 'impact', header: 'Exit impact', numeric: true, sort: 'number', size: 112, value: (p) => p.price_impact_exit_bps, format: (p) => formatBps(p.price_impact_exit_bps, { as: 'bps' }), ...g('Now') },
    { id: 'age', header: 'Age', numeric: true, sort: 'time', size: 104, value: (p) => p.opened_at, format: (p) => formatAge(p.opened_at, clock.nowMs(), 0), ...g('Now') },
  ];
}

const rowStateOf = (p: FixturePosition): RowState | undefined => (p.state === 'closing' ? 'closing' : undefined);

/** A deterministic position streamed in by the demo. */
export function streamedPosition(n: number, at: string): FixturePosition {
  return {
    position_id: `01K6Z${String(n).padStart(21, '0')}`, strategy_id: 'mr', mint: `Demo${String(n).padStart(40, '1')}`,
    symbol: `NEW${n}`, name: `Streamed ${n}`, decimals: 6, state: 'opening', opened_at: at, size_base: `${n}000000`,
    entry_cost_lamports: `${n}0000000`, entry_price_sol_per_token: '0.01', mark_price_sol_per_token: null, exit_value_est_lamports: null,
    unrealized_pnl_net_lamports: null, unrealized_pnl_net_bps: null, price_impact_exit_bps: null, close_failed_reason: null,
  };
}

/** The mark of each open position moves by `step` thousandths of a SOL per token. */
export function moveMarks(positions: readonly FixturePosition[], step: number): FixturePosition[] {
  return positions.map((p, i) => {
    if (i % 2 === 1 || p.unrealized_pnl_net_lamports === null) return p;
    const pnlLamports = (BigInt(p.unrealized_pnl_net_lamports) + BigInt(step) * 1_000_000n).toString();
    return { ...p, unrealized_pnl_net_lamports: pnlLamports, mark_price_sol_per_token: `0.0${100 + step}` };
  });
}

/** Streamed inserts arrive this long after the button, so a test or a person can focus a row first (acceptance 2). */
export const STREAM_DELAY_MS = 2000;

/** Runs `fn` after STREAM_DELAY_MS; pending runs are dropped on unmount. */
function useLater(): (fn: () => void) => void {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);
  return (fn) => {
    const t = setTimeout(() => { timers.current.delete(t); fn(); }, STREAM_DELAY_MS);
    timers.current.add(t);
  };
}

export interface PositionsPageProps { load?: Loader; clock?: Clock; source?: ClockSource }

/** The Positions fixture page: VM-05 from `/api/v1/vm/VM-05` in a DataTable, with streamed inserts and mark updates. */
export function PositionsPage(props: PositionsPageProps): ReactElement {
  const clock = props.clock ?? demoClock;
  const [snapshot, setSnapshot] = useState<Vm05Snapshot | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const [attempt, setAttempt] = useState(0);
  const streamed = useRef(0);
  const step = useRef(0);
  const later = useLater();
  useEffect(() => {
    let live = true;
    (props.load ?? fetchJson)('/api/v1/vm/VM-05').then(
      (body) => { if (live) { setSnapshot(body as Vm05Snapshot); setFailure(null); } },
      (e: unknown) => { if (live) setFailure(String(e)); });
    return () => { live = false; };
  }, [attempt]);
  const columns = useMemo(() => positionColumns(clock), [clock]);
  const toggle = (id: string): void => setSelected((s) => {
    const next = new Set(s);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const stream = (): void => later(() => {
    const at = new Date(clock.nowMs()).toISOString();
    const n = (streamed.current += 3);
    setSnapshot((s) => ({ ...(s as Vm05Snapshot), positions: [streamedPosition(n, at), streamedPosition(n - 1, at), streamedPosition(n - 2, at), ...(s as Vm05Snapshot).positions] }));
  });
  const update = (): void => {
    step.current += 1;
    const by = step.current;
    setSnapshot((s) => ({ ...(s as Vm05Snapshot), positions: moveMarks((s as Vm05Snapshot).positions, by) }));
  };
  const source = props.source ?? { clock };
  const blocked = snapshot === null ? { disabledReason: 'Loading positions' } : {};
  const state = failure !== null
    ? { kind: 'error' as const, reason: 'Positions could not be loaded', onRetry: () => setAttempt((n) => n + 1), diagnostics: { vm: 'VM-05', message: failure } }
    : snapshot === null ? { kind: 'loading' as const }
      : snapshot.positions.length === 0 ? { kind: 'empty' as const, reason: 'No open positions', context: `Bot in ${snapshot.mode} mode` } : undefined;
  return h('div', { className: 'demo__stack demo__stack--wide' },
    h('div', { className: 'demo__row' },
      h(Button, { onClick: stream, ...blocked }, 'Stream 3 new positions in 2 s'),
      h(Button, { onClick: update, ...blocked }, 'Update marks')),
    h(DataTable<FixturePosition>, {
      label: 'Open positions',
      columns,
      rows: snapshot?.positions ?? [],
      rowId: (p) => p.position_id,
      height: 360,
      clock,
      selected,
      onToggleSelect: toggle,
      onOpenRow: (p) => setOpened(p.position_id),
      rowState: rowStateOf,
      columnVisibility: visibility,
      onColumnVisibilityChange: setVisibility,
      ...(state === undefined ? {} : { state }),
      status: snapshot === null ? null : h(FreshnessIndicator, { label: 'Open positions', vm: 'VM-05', input: { ...thresholdsFor('VM-05'), as_of: snapshot.as_of, clock: 'wall' }, source }),
    }),
    h('output', { className: 'demo__out', 'data-testid': 'positions-out' },
      `selected ${selected.size} · opened ${opened ?? '-'} · hidden ${Object.entries(visibility).filter(([, v]) => !v).map(([k]) => k).join(',') || '-'}`));
}

const DEMO_AS_OF = '2026-10-06T14:02:11.123Z';

/** Fixed demo rows: digits that show tabular alignment, untrusted text, and the row states. */
export const DEMO_ROWS: readonly FixturePosition[] = [
  { position_id: 'R1', strategy_id: 'mr', mint: 'MintA', symbol: 'ONES', name: 'Ones', decimals: 4, state: 'open', opened_at: '2026-10-06T13:41:05.512Z',
    size_base: '11111111', entry_cost_lamports: '1111111111', entry_price_sol_per_token: '0.1111', mark_price_sol_per_token: '0.1111', exit_value_est_lamports: '1111111111',
    unrealized_pnl_net_lamports: '11111111', unrealized_pnl_net_bps: 111, price_impact_exit_bps: 11, close_failed_reason: null },
  { position_id: 'R2', strategy_id: 'pm', mint: 'MintB', symbol: 'EIGHTS', name: 'Eights', decimals: 4, state: 'open', opened_at: '2026-10-06T13:58:05.512Z',
    size_base: '88888888', entry_cost_lamports: '8888888888', entry_price_sol_per_token: '0.8888', mark_price_sol_per_token: '0.8888', exit_value_est_lamports: '8888888888',
    unrealized_pnl_net_lamports: '-88888888', unrealized_pnl_net_bps: -888, price_impact_exit_bps: 88, close_failed_reason: null },
  { position_id: 'R3', strategy_id: 'mr', mint: 'MintC', symbol: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', name: 'NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', decimals: 9,
    state: 'open', opened_at: '2026-10-06T14:01:05.512Z', size_base: '1000000000', entry_cost_lamports: '500000000', entry_price_sol_per_token: '0.51',
    mark_price_sol_per_token: '0.000004712', exit_value_est_lamports: '509620000', unrealized_pnl_net_lamports: '0', unrealized_pnl_net_bps: 0, price_impact_exit_bps: 42, close_failed_reason: null },
  { position_id: 'R4', strategy_id: 'pm', mint: 'MintD', symbol: 'US\u202EDC', name: 'Ꮪolana Ꭰollar', decimals: null, state: 'closing', opened_at: '2026-10-06T14:02:01.512Z',
    size_base: '5000000', entry_cost_lamports: '27500000', entry_price_sol_per_token: '0.0054', mark_price_sol_per_token: null, exit_value_est_lamports: null,
    unrealized_pnl_net_lamports: null, unrealized_pnl_net_bps: null, price_impact_exit_bps: null, close_failed_reason: null },
  { position_id: 'R5', strategy_id: 'mr', mint: 'MintE', symbol: 'STUCK', name: 'Close failed', decimals: 6, state: 'close_failed', opened_at: '2026-10-06T12:02:11.123Z',
    size_base: '4000000', entry_cost_lamports: '40000000', entry_price_sol_per_token: '0.0098', mark_price_sol_per_token: '0.0098', exit_value_est_lamports: '39200000',
    unrealized_pnl_net_lamports: '-800000', unrealized_pnl_net_bps: -200, price_impact_exit_bps: 42, close_failed_reason: 'Slippage above the limit' },
];

const DEMO_COLUMNS = positionColumns(demoClock);
const GROUPED_COLUMNS = positionColumns(demoClock, true);
const demoId = (p: FixturePosition): string => p.position_id;
const demoState = (p: FixturePosition): RowState | undefined => (p.state === 'closing' ? 'closing' : p.state === 'close_failed' ? 'disabled' : undefined);
const noop = (): void => undefined;

/** One row streamed in after mount: on the frozen demo clock its 2 s "new" marker stays for the screenshot. */
function StreamedDemo(props: { variant: 'standard' | 'dense' }): ReactElement {
  const [rows, setRows] = useState<readonly FixturePosition[]>(DEMO_ROWS.slice(0, 2));
  useEffect(() => { setRows((r) => [streamedPosition(1, new Date(DEMO_NOW).toISOString()), ...r]); }, []);
  return h(DataTable<FixturePosition>, { label: 'Streamed', columns: DEMO_COLUMNS, rows, rowId: demoId, variant: props.variant, clock: demoClock });
}

function demo(title: string, body: ReactNode): ReactElement {
  return h('div', { className: 'demo' }, h('h3', { className: 'demo__title' }, title), body);
}

/** Every C23 state in one variant. */
export function TableStates(props: { variant: 'standard' | 'dense'; loadingClock?: ElapsedClock }): ReactElement {
  const v = props.variant;
  const base = { columns: DEMO_COLUMNS, rowId: demoId, variant: v, clock: demoClock, ...(props.loadingClock === undefined ? {} : { loadingClock: props.loadingClock }) } as const;
  return h('div', { className: 'demos' },
    demo('Rows', h(DataTable<FixturePosition>, { ...base, label: 'Rows', rows: DEMO_ROWS, rowState: demoState, selected: new Set(['R2']), onToggleSelect: noop,
      sorting: [{ id: 'pnl', desc: true }], columnVisibility: { name: false } })),
    demo('Grouped', h(DataTable<FixturePosition>, { ...base, label: 'Grouped', columns: GROUPED_COLUMNS, rows: DEMO_ROWS.slice(0, 3), sorting: [{ id: 'symbol', desc: false }] })),
    demo('Streamed', h(StreamedDemo, { variant: v })),
    demo('Loading', h(DataTable<FixturePosition>, { ...base, label: 'Loading', rows: [], state: { kind: 'loading' } })),
    demo('Empty', h(DataTable<FixturePosition>, { ...base, label: 'Empty', rows: [], state: { kind: 'empty', reason: 'No open positions', context: 'Bot running in paper mode · last candidate 2m ago' } })),
    demo('Filtered empty', h(DataTable<FixturePosition>, { ...base, label: 'Filtered empty', rows: [], state: { kind: 'filtered-empty', reason: 'No positions match these filters', action: { label: 'Clear filters', onClick: noop } } })),
    demo('Error', h(DataTable<FixturePosition>, { ...base, label: 'Error', rows: DEMO_ROWS.slice(0, 2), state: { kind: 'error', reason: 'Positions could not be refreshed', onRetry: noop,
      diagnostics: { vm: 'VM-05', http_status: 503, code: 'E_UPSTREAM', message: 'Gateway unavailable' } } })),
    demo('Stale', h(DataTable<FixturePosition>, { ...base, label: 'Stale', rows: DEMO_ROWS.slice(0, 2),
      status: h(FreshnessIndicator, { label: 'Stale', vm: 'VM-05', input: { ...thresholdsFor('VM-05'), as_of: '2026-10-06T14:02:05.123Z', clock: 'wall' }, source: { clock: demoClock } }) })));
}

/** Generated rows for the performance page: each row differs, all values deterministic. */
export function perfRows(count: number): FixturePosition[] {
  return Array.from({ length: count }, (_, i) => {
    const n = BigInt(i);
    return {
      position_id: `P${String(i).padStart(6, '0')}`, strategy_id: i % 3 === 0 ? 'mr' : 'pm', mint: `Mint${i}`, symbol: `TK${i}`, name: `Token ${i}`, decimals: 6,
      state: 'open', opened_at: new Date(Date.parse(DEMO_AS_OF) - i * 1000).toISOString(), size_base: ((n * 7919n) % 100000000n * 1000n).toString(),
      entry_cost_lamports: ((n * 104729n) % 10000000000n).toString(), entry_price_sol_per_token: `0.${String((i * 37) % 10000).padStart(4, '0')}1`,
      mark_price_sol_per_token: `0.${String((i * 53) % 10000).padStart(4, '0')}1`, exit_value_est_lamports: ((n * 15485863n) % 10000000000n).toString(),
      unrealized_pnl_net_lamports: (((n * 7727n) % 2000000000n) - 1000000000n).toString(), unrealized_pnl_net_bps: (i * 13) % 2000 - 1000,
      price_impact_exit_bps: (i * 7) % 500, close_failed_reason: null,
    };
  });
}

/** `?rows=` between 1 and 10,000; 5,000 otherwise. */
export function rowsFromSearch(search: string): number {
  const n = Number.parseInt(new URLSearchParams(search).get('rows') ?? '', 10);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 5000;
}

/**
 * The performance page: `count` rows; "Fast updates" changes the first row's PnL every 50 ms (20 times a second);
 * "Stream 3 rows in 2 s" inserts three rows at the top.
 */
export function TablePerf(props: { count: number; clock?: Clock }): ReactElement {
  const [rows, setRows] = useState(() => perfRows(props.count));
  const [fast, setFast] = useState(false);
  const streamed = useRef(0);
  const later = useLater();
  useEffect(() => {
    if (!fast) return undefined;
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      setRows((r) => [{ ...(r[0] as FixturePosition), unrealized_pnl_net_lamports: String(tick * 1_000_000) }, ...r.slice(1)]);
    }, 50);
    return () => clearInterval(timer);
  }, [fast]);
  const stream = (): void => later(() => {
    const n = (streamed.current += 3);
    const at = new Date(DEMO_NOW).toISOString();
    setRows((r) => [streamedPosition(n, at), streamedPosition(n - 1, at), streamedPosition(n - 2, at), ...r]);
  });
  return h('div', { className: 'demo__stack demo__stack--wide' },
    h('div', { className: 'demo__row' },
      h(Switch, { label: 'Fast updates', checked: fast, onCheckedChange: setFast }),
      h(Button, { onClick: stream }, 'Stream 3 rows in 2 s')),
    h(DataTable<FixturePosition>, { label: `${props.count} rows`, columns: DEMO_COLUMNS, rows, rowId: demoId, height: 480, clock: props.clock ?? wallClock }));
}

const search = (): string => globalThis.location.search;

export const positionsSection: Section = { id: 'positions', title: 'Positions', render: () => h(PositionsPage, {}) };
export const tableStatesSection: Section = { id: 'table', title: 'Table', render: () => h(TableStates, { variant: 'standard' }) };
export const tableDenseSection: Section = { id: 'table-dense', title: 'Dense table', render: () => h(TableStates, { variant: 'dense' }) };
export const tablePerfSection: Section = { id: 'table-perf', title: 'Table performance', standalone: true, render: () => h(TablePerf, { count: rowsFromSearch(search()) }) };
