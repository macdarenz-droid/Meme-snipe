// Catalogue sections "Primitives" and "Overlays" (UI-T04): every state of C01, C02, C07-C14, C19-C22 and C43.
// Hover, pressed and focus are shown statically with the is-hover, is-active and is-focus classes. Overlays (open
// tooltip, menu with an open submenu, popover, open select states) move focus, so they have their own section.
import { createElement as h, useState, type ReactElement, type ReactNode } from 'react';
import { Activity, Bell, Copy, LayoutDashboard, Pause, Settings, ShieldAlert, X } from 'lucide-react';
import { Button, IconButton, type ButtonVariant } from '../../components/button.ts';
import { AmountInput, TextInput } from '../../components/field.ts';
import { Kbd } from '../../components/kbd.ts';
import { ContextMenu, Menu, Popover, type MenuItem } from '../../components/menu.ts';
import { Select } from '../../components/select.ts';
import { Badge, Banner, NavItem, type BadgeTone, type BannerTone } from '../../components/status.ts';
import { Tabs } from '../../components/tabs.ts';
import { ToastRegion, useToasts } from '../../components/toast.ts';
import { Checkbox, RadioGroup, SegmentedControl, Switch } from '../../components/toggles.ts';
import { Tooltip } from '../../components/tooltip.ts';
import type { AmountResult, AmountSpec } from '../../lib/amount.ts';
import type { ListOption } from '../../lib/listbox.ts';
import type { ToastItem } from '../../lib/toasts.ts';
import type { Section } from '../catalogue.ts';

const VARIANTS: ReadonlyArray<[ButtonVariant, string]> = [['primary', 'Primary'], ['secondary', 'Secondary'], ['ghost', 'Ghost'], ['danger', 'Danger'], ['live-confirm', 'Go live']];

export const STRATEGIES: readonly ListOption[] = [
  { value: 'mr', label: 'Mean reversion' },
  { value: 'pm', label: 'Pool momentum' },
  { value: 'lb', label: 'Launch breakout', disabled: true, reason: 'Disabled in paper mode until the readiness gates pass' },
  { value: 'ar', label: 'Arbitrage watch' },
];

export const MENU_ITEMS: readonly MenuItem[] = [
  { label: 'Copy mint', shortcut: ['Mod', 'C'] },
  { label: 'Open inspector' },
  { label: 'Export', items: [{ label: 'As CSV' }, { label: 'As JSON' }] },
  { label: 'Close position', disabled: true, reason: 'Needs the operator role' },
];

function Row(props: { title: string; children?: ReactNode }): ReactElement {
  return h('div', { className: 'demo' }, h('h3', { className: 'demo__title' }, props.title), h('div', { className: 'demo__row' }, props.children));
}

/** A controlled amount input for the demos. */
function Amount(props: { label: string; unit: string; spec: AmountSpec; initial: string; limitHref?: string }): ReactElement {
  const [text, setText] = useState(props.initial);
  const [result, setResult] = useState<AmountResult | null>(null);
  return h('div', { className: 'demo__cell' },
    h(AmountInput, { label: props.label, unit: props.unit, spec: props.spec, value: text, ...(props.limitHref === undefined ? {} : { limitHref: props.limitHref }),
      onChange: (t: string, r: AmountResult) => { setText(t); setResult(r); } }),
    h('output', { className: 'demo__out' }, result === null ? '' : result.kind === 'valid' ? `value ${result.value}` : result.kind));
}

/** A button that switches between idle and loading on each click (acceptance 1: the width and name do not change). */
function LoadingDemo(): ReactElement {
  const [loading, setLoading] = useState(false);
  return h(Button, { variant: 'primary', status: loading ? 'loading' : 'idle', onClick: () => setLoading(true) }, 'Save changes');
}

function ControlledSelect(props: { label: string; initial: string[]; multi?: boolean; searchable?: boolean; placeholder?: string }): ReactElement {
  const [value, setValue] = useState(props.initial);
  return h(Select, { label: props.label, options: STRATEGIES, value, onChange: setValue,
    ...(props.multi === true ? { multi: true } : {}), ...(props.searchable === true ? { searchable: true } : {}), ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }) });
}

function Toggles(): ReactElement {
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [checked, setChecked] = useState(true);
  const [range, setRange] = useState('24h');
  const [mode, setMode] = useState('exit_quote');
  return h('div', { className: 'demo__row' },
    h(Switch, { label: 'Sound alerts', checked: on, onCheckedChange: setOn }),
    h(Switch, { label: 'Pause feed', checked: off, onCheckedChange: setOff }),
    h(Switch, { label: 'Auto-reconnect', checked: true, status: 'pending' }),
    h(Switch, { label: 'Notifications', checked: false, status: 'failed', error: 'Not saved: the server did not answer' }),
    h(Checkbox, { label: 'Show gross figures', checked, onCheckedChange: setChecked }),
    h(Checkbox, { label: 'Hide closed', checked: false }),
    h(Checkbox, { label: 'All strategies', checked: false, indeterminate: true }),
    h(RadioGroup, { legend: 'Mark method', value: mode, onValueChange: setMode,
      options: [{ value: 'exit_quote', label: 'Exit quote' }, { value: 'mid', label: 'Mid' }, { value: 'last_trade', label: 'Last trade' }] }),
    h(SegmentedControl, { legend: 'Range', value: range, onValueChange: setRange,
      options: [{ value: '1h', label: '1h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }] }));
}

function TabsDemo(): ReactElement {
  const [tab, setTab] = useState('overview');
  return h(Tabs, { label: 'Token', value: tab, onValueChange: setTab, tabs: [
    { value: 'overview', label: 'Overview', content: 'Overview panel' },
    { value: 'risk', label: 'Risk checks', alert: 'warn', content: 'Risk checks panel' },
    { value: 'trades', label: 'Trades', alert: 'danger', content: 'Trades panel' },
    { value: 'price', label: 'Price', content: 'Price panel' },
  ] });
}

const STATIC_TOASTS: readonly ToastItem[] = [
  { id: 'i', tone: 'info', title: 'Config saved', body: 'Version 42 applies on the next candidate.', phase: 'visible', paused: true },
  { id: 's', tone: 'success', title: 'Position closed', phase: 'visible', paused: true },
  { id: 'w', tone: 'warning', title: 'Provider degraded', body: 'Landing rate 82% over 5 min.', phase: 'visible', paused: true },
  { id: 'd', tone: 'danger', title: 'Close failed', body: 'Slippage above the limit. Recorded in Alerts.', phase: 'visible', paused: false },
];

function Toasts(): ReactElement {
  const live = useToasts();
  const staticToasts = useToasts(STATIC_TOASTS);
  return h('div', { className: 'demo__stack' },
    h(ToastRegion, { toasts: staticToasts.toasts, dispatch: staticToasts.dispatch, inline: true }),
    h(Button, { onClick: () => live.push({ id: `t${live.toasts.length}-${live.toasts.map((t) => t.id).join('')}`, tone: 'info', title: 'Filters applied' }) }, 'Show a toast'),
    h(ToastRegion, { toasts: live.toasts, dispatch: live.dispatch }));
}

/** Twelve danger toasts: more than the stack shows at once (review M2; checked at 360 px in primitives.e2e.ts). */
export const DANGER_STACK: readonly ToastItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: `d${i + 1}`, tone: 'danger', title: `Close failed (${i + 1} of 12)`, body: 'Slippage above the limit. Recorded in Alerts.', phase: 'visible', paused: false,
}));

function ToastStack(): ReactElement {
  const stack = useToasts(DANGER_STACK);
  return h(ToastRegion, { toasts: stack.toasts, dispatch: stack.dispatch });
}

const BANNERS: ReadonlyArray<[BannerTone, string, string]> = [
  ['info', 'Update available', 'Reload to use dashboard 0.4.'],
  ['warning', 'Approaching the daily loss limit', 'Usage 82% of 0.60 SOL.'],
  ['danger', 'Risk status unknown', 'Raise-limit actions are disabled.'],
  ['stale', 'Stale · 12s', 'Showing data as of 14:02:11 UTC.'],
  ['disconnected', 'Disconnected from bot', 'Trading continues on the server under its own risk limits. Reconnecting (attempt 3, next in 4s).'],
  ['paper', 'Paper trading', 'Simulated fills; no real funds.'],
  ['live', 'Live trading', 'Real funds; max 0.25 SOL per trade.'],
];

function Banners(): ReactElement {
  const [infoShown, setInfoShown] = useState(true);
  return h('div', { className: 'demo__stack' }, BANNERS.filter(([tone]) => tone !== 'info' || infoShown).map(([tone, title, body]) =>
    h(Banner, { key: tone, tone, title, ...(tone === 'info' ? { onDismiss: () => setInfoShown(false) } : {}) }, body)));
}

const BADGES: ReadonlyArray<[BadgeTone, string]> = [
  ['neutral', 'Neutral'], ['pos', 'Profit'], ['neg', 'Loss'], ['warn', 'Stale'], ['danger', 'Halted'], ['info', 'Info'], ['paper', 'Paper'], ['live', 'Live'], ['sim', 'SIM'],
];

function Primitives(): ReactElement {
  return h('div', { className: 'demos' },
    h(Row, { title: 'Buttons' }, VARIANTS.map(([v, label]) => h(Button, { key: v, variant: v }, label))),
    h(Row, { title: 'Button states' },
      h(Button, { variant: 'primary', className: 'is-hover' }, 'Hover'),
      h(Button, { variant: 'primary', className: 'is-active' }, 'Pressed'),
      h(Button, { variant: 'secondary', className: 'is-focus' }, 'Focus'),
      h(Button, { variant: 'primary', disabledReason: 'Risk status is stale' }, 'Raise limit'),
      h(Button, { variant: 'primary', status: 'loading' }, 'Saving'),
      h(Button, { variant: 'danger', status: 'pending', icon: Pause }, 'Halt'),
      h(Button, { variant: 'primary', status: 'confirmed' }, 'Apply'),
      h(Button, { variant: 'primary', status: 'failed', error: 'Rejected: config version changed' }, 'Apply'),
      h(Button, { variant: 'secondary', status: 'idle', icon: Copy }, 'Copy row'),
      h(LoadingDemo)),
    h(Row, { title: 'Button sizes' }, h(Button, { size: 'sm' }, 'Small 28'), h(Button, null, 'Standard 32'), h(Button, { size: 'lg', variant: 'primary' }, 'Large 40')),
    h(Row, { title: 'Icon buttons' },
      h(IconButton, { icon: Settings, label: 'Settings', shortcut: ['Mod', ','] }),
      h(IconButton, { icon: Bell, label: 'Alerts', variant: 'outline' }),
      h(IconButton, { icon: Activity, label: 'Live tail', pressed: true }),
      h(IconButton, { icon: Activity, label: 'Live tail off', pressed: false, className: 'is-hover' }),
      h(IconButton, { icon: Copy, label: 'Copy', loading: true }),
      h(IconButton, { icon: X, label: 'Close', size: 'sm' })),
    h(Row, { title: 'Text inputs' },
      h(TextInput, { label: 'Label', value: '' }),
      h(TextInput, { label: 'Strategy name', value: 'Mean reversion' }),
      h(TextInput, { label: 'Max latency', value: '250', unit: 'ms' }),
      h(TextInput, { label: 'Search tokens', value: '', variant: 'search' }),
      h(TextInput, { label: 'Endpoint label', value: 'a b', tone: 'invalid', message: 'Use letters, digits and dashes' }),
      h(TextInput, { label: 'Slippage', value: '900', unit: 'bps', tone: 'warning', message: 'Above 500 bps raises risk' }),
      h(TextInput, { label: 'Run ID', value: '01K6Y3V2Q8ZQ4D5M7N9P1R3T5W', readOnly: true }),
      h(TextInput, { label: 'Take profit', value: '1200', unit: 'bps', dirty: true })),
    h(Row, { title: 'Amount inputs' },
      h(Amount, { label: 'Size', unit: 'SOL', spec: { unit: 'sol' }, initial: '0.25' }),
      h(Amount, { label: 'Size (10 decimals)', unit: 'SOL', spec: { unit: 'sol' }, initial: '0.1234567891' }),
      h(Amount, { label: 'Comma in SOL', unit: 'SOL', spec: { unit: 'sol' }, initial: '1,500' }),
      h(Amount, { label: 'Comma decimal', unit: 'SOL', spec: { unit: 'sol' }, initial: '0,25' }),
      h(Amount, { label: 'Per-trade size', unit: 'SOL', spec: { unit: 'sol', min: '10000000', max: '500000000' }, initial: '0.75' }),
      h(Amount, { label: 'Trade size', unit: 'SOL', spec: { unit: 'sol', limit: '250000000' }, initial: '0.3', limitHref: '#risk' }),
      h(Amount, { label: 'Token amount', unit: 'BONK', spec: { unit: 'token', decimals: 5 }, initial: '1234.56789' }),
      h(Amount, { label: 'Max slippage', unit: 'bps', spec: { unit: 'bps', max: '1000' }, initial: '35' }),
      h(Amount, { label: 'Daily loss', unit: '%', spec: { unit: 'percent' }, initial: '2.5' })),
    h(Row, { title: 'Selects' },
      h(ControlledSelect, { label: 'Strategy', initial: ['mr'] }),
      h(ControlledSelect, { label: 'Placeholder', initial: [], placeholder: 'Choose a strategy' }),
      h(ControlledSelect, { label: 'Strategies', initial: ['mr', 'pm', 'ar'], multi: true }),
      h(ControlledSelect, { label: 'Search strategies', initial: [], searchable: true })),
    h(Row, { title: 'Toggles' }, h(Toggles)),
    h(Row, { title: 'Tabs' }, h(TabsDemo)),
    h(Row, { title: 'Overlays' },
      h(Tooltip, { content: 'Exact: 0.000000001 SOL (1 lamport)' }, h('button', { type: 'button', className: 'btn btn--secondary btn--md' }, 'Tooltip')),
      h(Menu, { items: MENU_ITEMS, trigger: h('button', { type: 'button', className: 'btn btn--secondary btn--md' }, 'Menu') }),
      h(Popover, { label: 'Filters', trigger: h('button', { type: 'button', className: 'btn btn--secondary btn--md' }, 'Popover') }, h('p', { className: 'demo__text' }, 'Filter content')),
      h(ContextMenu, { label: 'Row actions', items: MENU_ITEMS }, h('div', { className: 'demo__target', tabIndex: 0 }, 'Context menu target'))),
    h(Row, { title: 'Toasts' }, h(Toasts)),
    h(Row, { title: 'Banners' }, h(Banners)),
    h(Row, { title: 'Badges' }, BADGES.map(([tone, text]) => h(Badge, { key: tone, tone }, text)), h(Badge, { tone: 'live', pill: true }, 'Live pill')),
    h(Row, { title: 'Keys' }, h(Kbd, { keys: ['Mod', 'K'], apple: true }), h(Kbd, { keys: ['Mod', 'K'], apple: false }), h(Kbd, { sequence: ['G', 'P'] }), h(Kbd, { keys: ['?'] })),
    h(Row, { title: 'Navigation' }, h('nav', { 'aria-label': 'Demo navigation', className: 'demo__nav' },
      h(NavItem, { href: '#overview', label: 'Overview', icon: LayoutDashboard, active: true }),
      h(NavItem, { href: '#positions', label: 'Positions', icon: Activity, count: 12 }),
      h(NavItem, { href: '#alerts', label: 'Alerts', icon: Bell, count: 3, alert: 'danger' }),
      h(NavItem, { href: '#risk', label: 'Risk limits', icon: ShieldAlert, alert: 'warn' }),
      h(NavItem, { href: '#config', label: 'Configuration', icon: Settings, className: 'is-hover' }),
      h(NavItem, { href: '#alerts', label: 'Alerts', icon: Bell, alert: 'danger', collapsed: true }))));
}

function Overlays(): ReactElement {
  return h('div', { className: 'overlays' },
    h('div', { className: 'overlays__cell' }, h(Tooltip, { content: 'Raise limit: needs a fresh passkey assertion', open: true, side: 'bottom' }, h('button', { type: 'button', className: 'btn btn--secondary btn--md' }, 'Tooltip open'))),
    h('div', { className: 'overlays__cell' }, h(Tooltip, { open: true, side: 'bottom', content: h('span', { className: 'tooltip__rich' }, h('strong', null, '+0.0123 SOL'), h('span', null, 'Exact 0.012300000 SOL'), h('span', null, 'Source: exit quote, 14:02:11 UTC')) },
      h('button', { type: 'button', className: 'btn btn--secondary btn--md' }, 'Rich tooltip'))),
    h('div', { className: 'overlays__cell overlays__cell--tall' }, h(Select, { label: 'Strategy (disabled option active)', options: STRATEGIES, value: ['mr'], defaultOpen: true, defaultActive: 2 })),
    h('div', { className: 'overlays__cell overlays__cell--tall' }, h(Select, { label: 'Strategies (multi)', options: STRATEGIES, value: ['mr', 'pm'], multi: true, defaultOpen: true, defaultActive: 1 })),
    h('div', { className: 'overlays__cell' }, h(Select, { label: 'Search (no results)', options: STRATEGIES, value: [], searchable: true, defaultOpen: true, defaultQuery: 'zzz' })),
    h('div', { className: 'overlays__cell' }, h(Select, { label: 'Loading options', options: [], value: [], loading: true, defaultOpen: true })));
}

/** An open menu (the browser tests open its submenu with the keyboard), or an open popover: one per section, because each takes focus when it opens. */
function OpenMenu(): ReactElement {
  return h('div', { className: 'overlays__cell overlays__cell--tall' },
    h(Menu, { defaultOpen: true, items: MENU_ITEMS, trigger: h('button', { type: 'button', className: 'btn btn--secondary btn--md' }, 'Menu open') }));
}

function OpenPopover(): ReactElement {
  return h('div', { className: 'overlays__cell overlays__cell--tall' },
    h(Popover, { label: 'Filters', defaultOpen: true, trigger: h('button', { type: 'button', className: 'btn btn--secondary btn--md' }, 'Popover open') },
      h('p', { className: 'demo__text' }, 'Filters apply to the journal and the charts.')));
}

export const primitivesSection: Section = { id: 'primitives', title: 'Primitives', render: () => h(Primitives) };
export const overlaysSection: Section = { id: 'overlays', title: 'Overlays', render: () => h(Overlays), standalone: true };
export const menuOpenSection: Section = { id: 'menu-open', title: 'Menu', render: () => h(OpenMenu), standalone: true };
export const popoverOpenSection: Section = { id: 'popover-open', title: 'Popover', render: () => h(OpenPopover), standalone: true };
export const toastStackSection: Section = { id: 'toast-stack', title: 'Toast stack', render: () => h(ToastStack), standalone: true };
