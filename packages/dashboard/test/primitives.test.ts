// UI-T04 components in a DOM: Button (acceptance 1's state and name), IconButton, Kbd, Icon, TextInput, AmountInput
// (acceptance 2), Select (acceptance 3: keyboard, disabled option reason), Switch, Checkbox, radios, Tabs, Tooltip,
// Menu, ContextMenu, Popover, Toast, Banner, Badge and NavItem.
import './dom.ts';
import { strict as assert } from 'node:assert';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { createElement as h, useState, type ReactElement } from 'react';
import { Copy, Settings } from 'lucide-react';
import { Button, IconButton } from '../src/components/button.ts';
import { AmountInput, TextInput } from '../src/components/field.ts';
import { Icon, Spinner } from '../src/components/icon.ts';
import { Kbd } from '../src/components/kbd.ts';
import { ContextMenu, Menu, Popover } from '../src/components/menu.ts';
import { Select } from '../src/components/select.ts';
import { Badge, Banner, NavItem } from '../src/components/status.ts';
import { Tabs } from '../src/components/tabs.ts';
import { ToastRegion, useToasts } from '../src/components/toast.ts';
import { Checkbox, RadioGroup, SegmentedControl, Switch } from '../src/components/toggles.ts';
import { Tooltip } from '../src/components/tooltip.ts';
import type { AmountResult } from '../src/lib/amount.ts';
import type { ListOption } from '../src/lib/listbox.ts';
import type { ToastItem } from '../src/lib/toasts.ts';
import { actSync, click, fire, key, render, typeInto, type Rendered } from './dom.ts';

const mounted: Rendered[] = [];
const mount = (el: ReactElement): Rendered => { const r = render(el); mounted.push(r); return r; };
beforeEach(() => { while (mounted.length > 0) mounted.pop()?.unmount(); document.body.innerHTML = ''; });
afterAll(() => { for (const r of mounted) r.unmount(); });

/**
 * Counts, per toast title, each time a toast element is inserted into a live region (role="alert" or "status"): each
 * insertion is one screen-reader announcement.
 */
function announcements(root: HTMLElement): { counts(): Record<string, number> } {
  const counts: Record<string, number> = {};
  const record = (records: MutationRecord[]): void => {
    for (const m of records) {
      if ((m.target as Element).closest('[role="alert"], [role="status"]') === null) continue;
      for (const node of m.addedNodes) {
        const el = node as Element;
        for (const t of el.matches('.toast') ? [el] : [...el.querySelectorAll('.toast')]) {
          const title = t.querySelector('.toast__title')?.textContent ?? '';
          counts[title] = (counts[title] ?? 0) + 1;
        }
      }
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(root, { childList: true, subtree: true });
  return { counts: () => { record(observer.takeRecords()); return { ...counts }; } };
}

/** The accessible name of a button the way its text content gives it (hidden layers are aria-hidden). */
function nameOf(el: Element): string {
  const walk = (n: Node): string => (n.nodeType === 3 ? n.textContent ?? '' : (n as Element).getAttribute?.('aria-hidden') === 'true' ? '' : [...n.childNodes].map(walk).join(''));
  return (el.getAttribute('aria-label') ?? walk(el)).trim();
}

describe('UI-T04 Button', () => {
  // First in the file: React reports a missing key once per component.
  it('renders its icon and label without React key warnings', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    try {
      render(h(Button, { icon: Copy }, 'Copy')).unmount();
    } finally {
      spy.mockRestore();
    }
    assert.deepEqual(errors.filter((e) => e.includes('unique "key"')), []);
  });

  it('acceptance 1 (state and name): loading keeps the label as the accessible name, sets aria-busy, and stacks idle and busy content', () => {
    const r = mount(h(Button, { status: 'idle', variant: 'primary' }, 'Save'));
    const button = r.container.querySelector('button') as HTMLButtonElement;
    assert.equal(nameOf(button), 'Save');
    assert.equal(button.getAttribute('aria-busy'), null);
    r.rerender(h(Button, { status: 'loading', variant: 'primary' }, 'Save'));
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(nameOf(button), 'Save');
    assert.equal(button.querySelector('.btn__stack')?.getAttribute('data-status'), 'loading');
    assert.ok(button.querySelector('.btn__layer--busy .spinner'), 'spinner left of the label');
    r.rerender(h(Button, { status: 'pending', variant: 'danger' }, 'Halt'));
    assert.equal(button.getAttribute('aria-busy'), 'true');
    r.rerender(h(Button, { status: 'confirmed' }, 'Apply'));
    assert.equal(button.getAttribute('aria-busy'), null);
    assert.equal(button.querySelector('.btn__stack')?.getAttribute('data-status'), 'confirmed');
  });

  it('clicks only when idle; busy and disabled buttons swallow the click', () => {
    const onClick = vi.fn();
    const r = mount(h(Button, { onClick, icon: Copy }, 'Copy'));
    click(r.container.querySelector('button') as Element);
    assert.equal(onClick.mock.calls.length, 1);
    assert.ok(r.container.querySelector('.btn__icon svg'));
    r.rerender(h(Button, { onClick, status: 'loading' }, 'Copy'));
    click(r.container.querySelector('button') as Element);
    r.rerender(h(Button, { onClick, disabledReason: 'Risk status is stale' }, 'Raise limit'));
    click(r.container.querySelector('button') as Element);
    assert.equal(onClick.mock.calls.length, 1);
    r.rerender(h(Button, { disabledReason: 'x' }, 'No handler'));
    click(r.container.querySelector('button') as Element);
    r.rerender(h(Button, null, 'No handler'));
    click(r.container.querySelector('button') as Element);
  });

  it('a disabled button stays focusable (aria-disabled) and is described by its reason', () => {
    const r = mount(h(Button, { disabledReason: 'Risk status is stale', type: 'submit' }, 'Raise limit'));
    const button = r.container.querySelector('button') as HTMLButtonElement;
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.type, 'submit');
    assert.equal(document.getElementById(button.getAttribute('aria-describedby') as string)?.textContent, 'Risk status is stale');
  });

  it('failed shows the inline error as an alert that describes the button', () => {
    const r = mount(h(Button, { status: 'failed', error: 'Rejected: config version changed', size: 'lg', className: 'is-focus' }, 'Apply'));
    const button = r.container.querySelector('button') as HTMLButtonElement;
    const error = r.container.querySelector('[role="alert"]') as HTMLElement;
    assert.equal(error.textContent, 'Rejected: config version changed');
    assert.equal(button.getAttribute('aria-describedby'), error.id);
    assert.match(button.className, /btn--secondary btn--lg is-focus/);
    r.rerender(h(Button, { status: 'failed' }, 'Apply'));
    assert.equal(r.container.querySelector('[role="alert"]'), null);
  });
});

describe('UI-T04 IconButton, Kbd and Icon', () => {
  it('has an accessible name, a pressed state and a busy state that swallows clicks', () => {
    const onClick = vi.fn();
    const r = mount(h(IconButton, { icon: Settings, label: 'Settings', shortcut: ['Mod', ','], pressed: true, onClick, variant: 'outline', size: 'sm', className: 'x' }));
    const b = r.container.querySelector('button') as HTMLButtonElement;
    assert.equal(b.getAttribute('aria-label'), 'Settings');
    assert.equal(b.getAttribute('aria-pressed'), 'true');
    assert.match(b.className, /icon-btn--outline icon-btn--sm x/);
    click(b);
    assert.equal(onClick.mock.calls.length, 1);
    r.rerender(h(IconButton, { icon: Settings, label: 'Settings', loading: true, onClick }));
    assert.equal(b.getAttribute('aria-busy'), 'true');
    assert.ok(b.querySelector('.spinner'));
    click(b);
    assert.equal(onClick.mock.calls.length, 1);
  });

  it('Kbd shows combinations for the platform and sequences with "then"', () => {
    const r = mount(h('div', null, h(Kbd, { keys: ['Mod', 'K'], apple: true }), h(Kbd, { keys: ['Mod', 'K'], apple: false }), h(Kbd, { sequence: ['G', 'P'], apple: false }), h(Kbd, {})));
    const groups = [...r.container.querySelectorAll('.kbd-group')].map((g) => g.textContent);
    assert.deepEqual(groups, ['⌘K', 'CtrlK', 'G then P', '']);
    const auto = mount(h(Kbd, { keys: ['Mod'] }));
    assert.match(auto.container.textContent ?? '', /^(⌘|Ctrl)$/, 'platform read from navigator');
  });

  it('Icon draws a 1.5px stroke at 16 or 20 px, hidden from assistive technology', () => {
    const r = mount(h('div', null, h(Icon, { icon: Copy }), h(Icon, { icon: Copy, size: 20, className: 'x' }), h(Spinner)));
    const svgs = [...r.container.querySelectorAll('svg')];
    assert.deepEqual(svgs.map((s) => s.getAttribute('width')), ['16', '20', '16']);
    assert.ok(svgs.every((s) => s.getAttribute('aria-hidden') === 'true'));
    assert.match(svgs[1]?.getAttribute('class') ?? '', /icon x/);
    assert.equal(svgs[0]?.getAttribute('stroke-width'), String(1.5 * 24 / 16));
  });
});

describe('UI-T04 TextInput and AmountInput', () => {
  it('labels the input, describes it by unit and message, and reports changes', () => {
    const onChange = vi.fn();
    const r = mount(h(TextInput, { label: 'Slippage', value: '900', unit: 'bps', tone: 'warning', message: 'Above 500 bps raises risk', onChange, dirty: true }));
    const input = r.container.querySelector('input') as HTMLInputElement;
    assert.equal(r.container.querySelector('label')?.getAttribute('for'), input.id);
    const described = (input.getAttribute('aria-describedby') as string).split(' ').map((id) => document.getElementById(id)?.textContent);
    assert.deepEqual(described, ['bps', 'Above 500 bps raises risk']);
    assert.equal(input.getAttribute('aria-invalid'), null);
    assert.match(r.container.firstElementChild?.className ?? '', /field--warning field--dirty/);
    typeInto(input, '950');
    assert.deepEqual(onChange.mock.calls[0], ['950']);
  });

  it('invalid, read-only and search variants', () => {
    const r = mount(h(TextInput, { label: 'Endpoint', value: 'a b', tone: 'invalid', message: 'Use letters' }));
    assert.equal(r.container.querySelector('input')?.getAttribute('aria-invalid'), 'true');
    r.rerender(h(TextInput, { label: 'Run ID', value: 'x', readOnly: true }));
    const input = r.container.querySelector('input') as HTMLInputElement;
    assert.equal(input.readOnly, true);
    assert.equal(input.getAttribute('aria-describedby'), null);
    typeInto(input, 'y');
    r.rerender(h(TextInput, { label: 'Search', value: '', variant: 'search' }));
    assert.equal((r.container.querySelector('input') as HTMLInputElement).type, 'search');
    assert.ok(r.container.querySelector('.field__lead'));
    r.rerender(h(TextInput, { label: 'Plain', value: '', message: 'Helper text' }));
    assert.equal(r.container.querySelector('.field__message svg'), null);
  });

  it('acceptance 2: typing 0.25 in a SOL AmountInput reports "250000000" lamports', () => {
    const changes: Array<[string, AmountResult]> = [];
    function Controlled(): ReactElement {
      const [text, setText] = useState('');
      return h(AmountInput, { label: 'Size', unit: 'SOL', spec: { unit: 'sol' }, value: text, onChange: (t: string, res: AmountResult) => { changes.push([t, res]); setText(t); } });
    }
    const r = mount(h(Controlled));
    const input = r.container.querySelector('input') as HTMLInputElement;
    assert.equal(input.inputMode, 'decimal');
    typeInto(input, '0.25');
    assert.deepEqual(changes.at(-1), ['0.25', { kind: 'valid', value: '250000000' }]);
    assert.equal(input.value, '0.25');
    typeInto(input, '0.1234567891');
    assert.equal(r.container.querySelector('.field__message')?.textContent, 'SOL has at most 9 decimals');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
  });

  it('shows the range or the limit with its link; bps inputs are numeric; props are optional', () => {
    const r = mount(h(AmountInput, { label: 'Trade size', unit: 'SOL', spec: { unit: 'sol', limit: '250000000' }, value: '0.3', limitHref: '#risk', dirty: true, readOnly: false }));
    assert.equal(r.container.querySelector('.field__message')?.textContent, 'Above the limit of 0.25 SOL. Reads as 0.3 SOL');
    assert.equal(r.container.querySelector('a')?.getAttribute('href'), '#risk');
    r.rerender(h(AmountInput, { label: 'Trade size', unit: 'SOL', spec: { unit: 'sol', limit: '250000000' }, value: '0.3' }));
    assert.equal(r.container.querySelector('a'), null);
    r.rerender(h(AmountInput, { label: 'Slippage', unit: 'bps', spec: { unit: 'bps', max: '1000' }, value: '1200' }));
    assert.equal(r.container.querySelector('.field__message')?.textContent, 'Enter at most 1,000 bps. Reads as 1,200 bps');
    assert.equal((r.container.querySelector('input') as HTMLInputElement).inputMode, 'numeric');
    typeInto(r.container.querySelector('input') as HTMLInputElement, '5');
    r.rerender(h(AmountInput, { label: 'Size', unit: 'SOL', spec: { unit: 'sol' }, value: '' }));
    assert.equal(r.container.querySelector('.field__message'), null);
  });

  it('Z05 round 2 (red team M4): the parsed value is always shown back; 0,250 SOL is refused, not read as 250', () => {
    const r = mount(h(AmountInput, { label: 'Size', unit: 'SOL', spec: { unit: 'sol' }, value: '0.25' }));
    const msg = (): string | null | undefined => r.container.querySelector('.field__message')?.textContent;
    assert.equal(msg(), 'Reads as 0.25 SOL');
    assert.equal(r.container.querySelector('input')?.getAttribute('aria-invalid'), null);
    for (const comma of ['0,250', '1,500']) {
      r.rerender(h(AmountInput, { label: 'Size', unit: 'SOL', spec: { unit: 'sol' }, value: comma }));
      assert.equal(msg(), 'Use a dot for decimals; no commas in SOL amounts', comma);
      assert.equal(r.container.querySelector('input')?.getAttribute('aria-invalid'), 'true');
    }
  });
});

const OPTIONS: ListOption[] = [
  { value: 'mr', label: 'Mean reversion' },
  { value: 'pm', label: 'Pool momentum' },
  { value: 'lb', label: 'Launch breakout', disabled: true, reason: 'Disabled in paper mode' },
  { value: 'x', label: 'No reason', disabled: true },
];

/** A controlled select for the tests. */
function TestSelect(props: { multi?: boolean; searchable?: boolean; onChange?: (v: string[]) => void; initial?: string[] }): ReactElement {
  const [value, setValue] = useState(props.initial ?? []);
  return h(Select, { label: 'Strategy', options: OPTIONS, value, ...(props.multi === true ? { multi: true } : {}), ...(props.searchable === true ? { searchable: true } : {}),
    onChange: (v: string[]) => { props.onChange?.(v); setValue(v); } });
}

describe('UI-T04 Select / Combobox (WAI-ARIA combobox)', () => {
  const combo = (r: Rendered): HTMLElement => r.container.querySelector('[role="combobox"]') as HTMLElement;
  const active = (r: Rendered): string | null => {
    const id = combo(r).getAttribute('aria-activedescendant');
    return id === null ? null : document.getElementById(id)?.textContent ?? null;
  };

  it('opens with ArrowDown, moves the active descendant, chooses with Enter and closes', () => {
    const onChange = vi.fn();
    const r = mount(h(TestSelect, { onChange }));
    const c = combo(r);
    assert.equal(c.getAttribute('aria-expanded'), 'false');
    assert.equal(document.getElementById((c.getAttribute('aria-labelledby') as string).split(' ')[1] as string)?.textContent, 'Select');
    key(c, 'keydown', { key: 'ArrowDown' });
    assert.equal(c.getAttribute('aria-expanded'), 'true');
    assert.equal(active(r), 'Mean reversion');
    key(c, 'keydown', { key: 'ArrowDown' });
    assert.equal(active(r), 'Pool momentum');
    key(c, 'keydown', { key: 'Enter' });
    assert.deepEqual(onChange.mock.calls[0], [['pm']]);
    assert.equal(c.getAttribute('aria-expanded'), 'false');
    assert.equal(c.textContent, 'Pool momentum');
    key(c, 'keydown', { key: 'x' });
    key(c, 'keydown', { key: 'End' });
    assert.equal(active(r), 'Pool momentum', 'reopens on the selected option');
    key(c, 'keydown', { key: 'End' });
    assert.equal(active(r), 'No reasonNot available', 'a disabled option without a reason says so');
    key(c, 'keydown', { key: 'Home' });
    key(c, 'keydown', { key: 'ArrowUp' });
    assert.equal(active(r), 'Mean reversion');
    key(c, 'keydown', { key: 'Escape' });
    assert.equal(c.getAttribute('aria-expanded'), 'false');
    key(c, 'keydown', { key: 'ArrowUp' });
    key(c, 'keydown', { key: 'Tab' });
    assert.equal(c.getAttribute('aria-expanded'), 'false');
  });

  it('acceptance 3: a disabled option, focused or hovered, shows its reason as a tooltip that describes it and is announced', () => {
    const onChange = vi.fn();
    const r = mount(h(TestSelect, { onChange }));
    const c = combo(r);
    key(c, 'keydown', { key: ' ' });
    key(c, 'keydown', { key: 'ArrowDown' });
    key(c, 'keydown', { key: 'ArrowDown' });
    const option = document.getElementById(c.getAttribute('aria-activedescendant') as string) as HTMLElement;
    assert.equal(option.getAttribute('aria-disabled'), 'true');
    const tip = document.getElementById(option.getAttribute('aria-describedby') as string) as HTMLElement;
    assert.equal(tip.getAttribute('role'), 'tooltip');
    assert.equal(tip.textContent, 'Disabled in paper mode');
    assert.equal(r.container.querySelector('[role="status"].visually-hidden')?.textContent, 'Unavailable: Disabled in paper mode');
    key(c, 'keydown', { key: 'Enter' });
    assert.equal(onChange.mock.calls.length, 0, 'a disabled option cannot be chosen');
    const options = [...r.container.querySelectorAll('[role="option"]')] as HTMLElement[];
    fire(options[3] as HTMLElement, new MouseEvent('mouseover', { bubbles: true }));
    assert.match(r.container.querySelector('[role="tooltip"]')?.textContent ?? '', /^Not available$/);
    click(options[3] as HTMLElement);
    assert.equal(onChange.mock.calls.length, 0);
    fire(options[0] as HTMLElement, new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    click(options[0] as HTMLElement);
    assert.deepEqual(onChange.mock.calls[0], [['mr']]);
  });

  it('multi keeps the list open and toggles; more than two show a count', () => {
    const r = mount(h(TestSelect, { multi: true, initial: ['mr', 'pm'] }));
    const c = combo(r);
    assert.equal(c.textContent, 'Mean reversion, Pool momentum');
    click(c);
    assert.equal(r.container.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable'), 'true');
    key(c, 'keydown', { key: ' ' });
    assert.equal(c.getAttribute('aria-expanded'), 'true');
    assert.equal(c.textContent, 'Pool momentum');
    click(c);
    assert.equal(c.getAttribute('aria-expanded'), 'false');
  });

  it('searchable filters as you type, shows No results, and closes on an outside pointer', () => {
    const onChange = vi.fn();
    const r = mount(h(TestSelect, { searchable: true, onChange }));
    const input = combo(r) as HTMLInputElement;
    assert.equal(input.getAttribute('aria-autocomplete'), 'list');
    click(input);
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    click(input);
    typeInto(input, 'pool');
    assert.equal(r.container.querySelectorAll('[role="option"]').length, 1);
    key(input, 'keydown', { key: ' ' });
    key(input, 'keydown', { key: 'Enter' });
    assert.deepEqual(onChange.mock.calls[0], [['pm']]);
    typeInto(input, 'zzz');
    assert.equal(r.container.querySelector('.select__note')?.textContent, 'No results');
    fire(r.container.querySelector('.select__popup') as HTMLElement, new PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(input.getAttribute('aria-expanded'), 'true', 'a pointer inside keeps it open');
    fire(document.body, new PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    key(input, 'keydown', { key: ' ' });
    assert.equal(input.getAttribute('aria-expanded'), 'false', 'space types in a search box');
  });

  it('loading options and initial open state', () => {
    const r = mount(h(Select, { label: 'L', options: [], value: [], loading: true, defaultOpen: true, placeholder: 'Pick' }));
    assert.match(r.container.querySelector('.select__note')?.textContent ?? '', /Loading options/);
    assert.equal(r.container.querySelectorAll('.select__note').length, 1);
    const s = mount(h(Select, { label: 'S', options: OPTIONS, value: [], defaultOpen: true, defaultActive: 1, defaultQuery: '' }));
    key(s.container.querySelector('[role="combobox"]') as HTMLElement, 'keydown', { key: 'Enter' });
  });
});

describe('UI-T04 Switch, Checkbox, radios and segmented control', () => {
  it('Switch toggles, holds while pending, and shows a failure', () => {
    const onCheckedChange = vi.fn();
    const r = mount(h(Switch, { label: 'Sound', checked: false, onCheckedChange }));
    const sw = r.container.querySelector('[role="switch"]') as HTMLButtonElement;
    assert.equal(sw.getAttribute('aria-checked'), 'false');
    assert.equal(r.container.querySelector('label')?.getAttribute('for'), sw.id);
    click(sw);
    assert.deepEqual(onCheckedChange.mock.calls[0], [true]);
    r.rerender(h(Switch, { label: 'Sound', checked: true, onCheckedChange, status: 'pending' }));
    assert.equal(sw.getAttribute('aria-busy'), 'true');
    click(sw);
    assert.equal(onCheckedChange.mock.calls.length, 1);
    r.rerender(h(Switch, { label: 'Sound', checked: true, status: 'failed', error: 'Not saved' }));
    assert.equal(document.getElementById(sw.getAttribute('aria-describedby') as string)?.textContent, 'Not saved');
    click(sw);
  });

  it('Checkbox sets indeterminate and reports changes; radios and segments report their value', () => {
    const onCheckedChange = vi.fn();
    const r = mount(h(Checkbox, { label: 'All', checked: false, indeterminate: true, onCheckedChange }));
    const box = r.container.querySelector('input') as HTMLInputElement;
    assert.equal(box.indeterminate, true);
    click(box);
    assert.deepEqual(onCheckedChange.mock.calls[0], [true]);
    r.rerender(h(Checkbox, { label: 'All', checked: true }));
    assert.equal(box.indeterminate, false);
    click(box);
    const onValueChange = vi.fn();
    const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
    const g = mount(h('div', null, h(RadioGroup, { legend: 'Mode', options: opts, value: 'a', onValueChange }), h(SegmentedControl, { legend: 'Range', options: opts, value: 'a', onValueChange })));
    const radios = [...g.container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    assert.equal(radios.length, 4);
    assert.equal(g.container.querySelectorAll('fieldset legend').length, 2);
    click(radios[1] as HTMLInputElement);
    click(radios[3] as HTMLInputElement);
    assert.deepEqual(onValueChange.mock.calls.map((c) => c[0]), ['b', 'b']);
    const plain = mount(h(RadioGroup, { legend: 'X', options: opts, value: 'a' }));
    click(plain.container.querySelectorAll('input')[1] as HTMLInputElement);
  });
});

describe('UI-T04 Tabs, Tooltip, Menu, ContextMenu and Popover', () => {
  it('Tabs mark the selected tab and announce alert dots', () => {
    const onValueChange = vi.fn();
    const tabs = [{ value: 'a', label: 'Overview', content: 'A' }, { value: 'b', label: 'Risk', alert: 'warn' as const, content: 'B' }, { value: 'c', label: 'Trades', alert: 'danger' as const, content: 'C' }];
    const r = mount(h(Tabs, { label: 'Token', tabs, value: 'a', onValueChange }));
    const triggers = [...r.container.querySelectorAll('[role="tab"]')] as HTMLElement[];
    assert.equal(triggers[0]?.getAttribute('aria-selected'), 'true');
    assert.equal(triggers[1]?.textContent, 'Risk, warnings');
    assert.equal(triggers[2]?.textContent, 'Trades, critical alerts');
    fire(triggers[1] as HTMLElement, new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    assert.deepEqual(onValueChange.mock.calls[0], ['b']);
    mount(h(Tabs, { label: 'Uncontrolled', tabs, value: 'a' }));
  });

  it('Tooltip renders its content when open, as a tooltip', () => {
    mount(h(Tooltip, { content: 'Exact value', open: true, side: 'bottom' }, h('button', { type: 'button' }, 'T')));
    assert.ok([...document.querySelectorAll('[role="tooltip"]')].some((t) => t.textContent === 'Exact value'));
  });

  it('Tooltip opens at once on focus, stays open while focused, closes on Escape and blur, and keeps the trigger handlers', () => {
    const calls: string[] = [];
    const r = mount(h(Tooltip, { content: 'Reason' }, h('button', { type: 'button', onFocus: () => calls.push('focus'), onBlur: () => calls.push('blur'), onKeyDown: () => calls.push('key') }, 'T')));
    const b = r.container.querySelector('button') as HTMLButtonElement;
    const shown = (): boolean => [...document.querySelectorAll('[role="tooltip"]')].some((t) => t.textContent === 'Reason');
    actSync(() => b.focus());
    assert.equal(shown(), true, 'no hover delay for focus');
    fire(window, new Event('scroll'));
    fire(b, new PointerEvent('pointerleave', { bubbles: false }));
    assert.equal(shown(), true, 'a scroll or the pointer leaving does not close it while focused');
    key(b, 'keydown', { key: 'Escape' });
    assert.equal(shown(), false);
    key(b, 'keydown', { key: 'a' });
    actSync(() => b.blur());
    actSync(() => b.focus());
    assert.equal(shown(), true);
    actSync(() => b.blur());
    assert.equal(shown(), false);
    assert.deepEqual(calls, ['focus', 'key', 'key', 'blur', 'focus', 'blur']);
    const plain = mount(h(Tooltip, { content: 'P' }, h('button', { type: 'button' }, 'P')));
    const pb = plain.container.querySelector('button') as HTMLButtonElement;
    actSync(() => pb.focus());
    key(pb, 'keydown', { key: 'x' });
    actSync(() => pb.blur());
  });

  it('Menu opens from the keyboard, runs an item and shows a disabled item with its reason', () => {
    const onSelect = vi.fn();
    const r = mount(h(Menu, { trigger: h('button', { type: 'button' }, 'Actions'), items: [
      { label: 'Copy', onSelect, shortcut: ['Mod', 'C'] }, { label: 'Close', disabled: true, reason: 'Needs the operator role' }, { label: 'Export', items: [{ label: 'CSV' }] },
      { label: 'Gone', disabled: true, items: [{ label: 'Never' }] }] }));
    const trigger = r.container.querySelector('button') as HTMLButtonElement;
    key(trigger, 'keydown', { key: 'Enter' });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    assert.equal(menu.getAttribute('aria-labelledby'), trigger.id, 'named by its trigger');
    const items = [...menu.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    assert.deepEqual(items.map((i) => i.textContent), ['CopyCtrlC', 'CloseNeeds the operator role', 'Export', 'Gone']);
    assert.equal(items[1]?.getAttribute('aria-disabled'), 'true');
    click(items[0] as HTMLElement);
    assert.equal(onSelect.mock.calls.length, 1);
  });

  it('an initially open menu opens its submenu with ArrowRight', () => {
    mount(h(Menu, { defaultOpen: true, trigger: h('button', { type: 'button' }, 'M'), items: [{ label: 'Export', items: [{ label: 'As CSV' }] }] }));
    const sub = document.querySelector('[role="menuitem"][aria-haspopup="menu"]') as HTMLElement;
    key(sub, 'keydown', { key: 'ArrowRight' });
    assert.equal(sub.getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelectorAll('[role="menu"]').length, 2);
  });

  it('ContextMenu opens on contextmenu; Popover opens from its trigger', () => {
    const r = mount(h('div', null,
      h(ContextMenu, { label: 'Row actions', items: [{ label: 'Inspect' }] }, h('div', { tabIndex: 0, className: 'target' }, 'Target')),
      h(Popover, { label: 'Filters', trigger: h('button', { type: 'button', className: 'pop' }, 'Filters') }, h('p', null, 'Content'))));
    fire(r.container.querySelector('.target') as HTMLElement, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    assert.equal(document.querySelector('[role="menu"]')?.getAttribute('aria-label'), 'Row actions');
    click(r.container.querySelector('.pop') as HTMLElement);
    assert.ok([...document.querySelectorAll('[role="dialog"]')].some((d) => d.getAttribute('aria-label') === 'Filters' && d.textContent === 'Content'));
    mount(h(Popover, { label: 'Open', defaultOpen: true, trigger: h('button', { type: 'button' }, 'O') }));
  });
});

describe('UI-T04 Toast', () => {
  it('enters, shows, pauses on hover and focus, leaves after 5 s and is removed; danger stays', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let api: ReturnType<typeof useToasts> | undefined;
      function Host(): ReactElement {
        api = useToasts();
        return h(ToastRegion, { toasts: api.toasts, dispatch: api.dispatch });
      }
      const r = mount(h(Host));
      const push = api?.push as (t: { id: string; tone: 'info' | 'danger'; title: string; body?: string }) => void;
      actSync(() => { push({ id: 'a', tone: 'info', title: 'Saved', body: 'Version 42' }); push({ id: 'd', tone: 'danger', title: 'Close failed' }); });
      const [polite, assertive] = [...r.container.querySelectorAll('.toasts__region')] as HTMLElement[];
      assert.equal(polite?.getAttribute('role'), 'status');
      assert.equal(assertive?.getAttribute('role'), 'alert');
      const toast = polite?.querySelector('.toast') as HTMLElement;
      assert.equal(toast.dataset['phase'], 'entering');
      actSync(() => vi.advanceTimersByTime(160));
      assert.equal(toast.dataset['phase'], 'visible');
      fire(toast, new MouseEvent('mouseover', { bubbles: true }));
      assert.equal(toast.dataset['paused'], 'true');
      actSync(() => vi.advanceTimersByTime(10000));
      assert.equal(toast.dataset['phase'], 'visible', 'paused while hovered');
      fire(toast, new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      fire(toast, new FocusEvent('focusin', { bubbles: true }));
      fire(toast, new FocusEvent('focusout', { bubbles: true }));
      actSync(() => vi.advanceTimersByTime(5000));
      assert.equal(toast.dataset['phase'], 'exiting');
      actSync(() => vi.advanceTimersByTime(100));
      assert.equal(polite?.querySelector('.toast'), null);
      actSync(() => vi.advanceTimersByTime(60000));
      const danger = assertive?.querySelector('.toast') as HTMLElement;
      assert.equal(danger.dataset['phase'], 'visible', 'danger stays');
      click(danger.querySelector('button') as HTMLElement);
      assert.equal(danger.dataset['phase'], 'exiting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows at most four toasts, danger included; "n more" expands and collapses the stack (review M2)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let api: ReturnType<typeof useToasts> | undefined;
      function Host(): ReactElement {
        api = useToasts();
        return h(ToastRegion, { toasts: api.toasts, dispatch: api.dispatch });
      }
      const r = mount(h(Host));
      const push = api?.push as (t: { id: string; tone: 'danger'; title: string }) => void;
      const toasts = (): string[] => [...r.container.querySelectorAll('.toast .toast__title')].map((e) => e.textContent ?? '');
      const more = (): HTMLButtonElement | null => r.container.querySelector('.toasts__more');
      actSync(() => { for (let i = 1; i <= 6; i++) push({ id: `d${i}`, tone: 'danger', title: `D${i}` }); });
      assert.deepEqual(toasts(), ['D3', 'D4', 'D5', 'D6']);
      assert.equal(more()?.textContent, '2 more');
      assert.equal(more()?.getAttribute('aria-expanded'), 'false');
      assert.equal(more()?.closest('[role]')?.getAttribute('role') ?? null, null, 'the button is outside the live regions');
      click(more() as HTMLButtonElement);
      assert.equal(toasts().length, 6);
      assert.equal(more()?.textContent, 'Show fewer');
      assert.equal(more()?.getAttribute('aria-expanded'), 'true');
      click(more() as HTMLButtonElement);
      assert.deepEqual(toasts(), ['D3', 'D4', 'D5', 'D6']);
      // Expanded, then dismissed down to four: the button goes, and the next overflow starts collapsed.
      click(more() as HTMLButtonElement);
      for (const id of ['D1', 'D2']) {
        const t = [...r.container.querySelectorAll('.toast')].find((e) => e.textContent?.includes(id)) as HTMLElement;
        click(t.querySelector('button') as HTMLElement);
      }
      actSync(() => vi.advanceTimersByTime(100));
      assert.deepEqual(toasts(), ['D3', 'D4', 'D5', 'D6']);
      assert.equal(more()?.textContent ?? null, null);
      actSync(() => push({ id: 'd7', tone: 'danger', title: 'D7' }));
      assert.deepEqual(toasts(), ['D4', 'D5', 'D6', 'D7']);
      assert.equal(more()?.textContent, '1 more');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an announced toast hidden and shown again is not put back in a live region, so it is not announced twice (review n2)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let api: ReturnType<typeof useToasts> | undefined;
      function Host(): ReactElement {
        api = useToasts();
        return h(ToastRegion, { toasts: api.toasts, dispatch: api.dispatch });
      }
      const r = mount(h(Host));
      const log = announcements(r.container);
      const push = api?.push as (t: { id: string; tone: 'danger'; title: string }) => void;
      const titles = (sel: string): string[] => [...r.container.querySelectorAll(`${sel} .toast__title`)].map((e) => e.textContent ?? '');
      const dismiss = (title: string): void => {
        const t = [...r.container.querySelectorAll('.toast')].find((e) => e.querySelector('.toast__title')?.textContent === title) as HTMLElement;
        click(t.querySelector('button') as HTMLElement);
        actSync(() => vi.advanceTimersByTime(100));
      };
      actSync(() => { for (let i = 1; i <= 4; i++) push({ id: `d${i}`, tone: 'danger', title: `D${i}` }); });
      actSync(() => push({ id: 'd5', tone: 'danger', title: 'D5' }));
      assert.deepEqual(titles('[role="alert"]'), ['D2', 'D3', 'D4', 'D5'], 'D1 was announced, then hidden behind "1 more"');
      dismiss('D5');
      assert.deepEqual(titles(''), ['D1', 'D2', 'D3', 'D4'], 'D1 shows again, in age order');
      assert.deepEqual(titles('[role="alert"]'), ['D2', 'D3', 'D4'], 'D1 is outside the alert region');
      assert.equal(r.container.querySelector('.toasts__again')?.closest('[role]'), null);
      // Re-added under the same id, it is new: announced again, in the alert region.
      actSync(() => push({ id: 'd1', tone: 'danger', title: 'D1' }));
      assert.deepEqual(titles('[role="alert"]'), ['D2', 'D3', 'D4', 'D1']);
      assert.equal(r.container.querySelector('.toasts__again'), null);
      // Expanded, the toasts beyond the maximum show without leaving their region; only hidden ones are marked.
      actSync(() => push({ id: 'd6', tone: 'danger', title: 'D6' }));
      click(r.container.querySelector('.toasts__more') as HTMLElement);
      actSync(() => push({ id: 'd7', tone: 'danger', title: 'D7' }));
      assert.deepEqual(titles('[role="alert"]'), ['D3', 'D4', 'D1', 'D6', 'D7']);
      assert.deepEqual(titles('.toasts__again'), ['D2']);
      assert.deepEqual(log.counts(), { D1: 2, D2: 1, D3: 1, D4: 1, D5: 1, D6: 1, D7: 1 }, 'D1 twice: pushed again under its id, it is a new toast');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a danger toast that waited beyond the maximum from the start is announced in the alert region when it first shows (red-team 3 RT3-1)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let api: ReturnType<typeof useToasts> | undefined;
      function Host(): ReactElement {
        api = useToasts();
        return h(ToastRegion, { toasts: api.toasts, dispatch: api.dispatch });
      }
      const r = mount(h(Host));
      const log = announcements(r.container);
      const titles = (sel: string): string[] => [...r.container.querySelectorAll(`${sel} .toast__title`)].map((e) => e.textContent ?? '');
      actSync(() => { for (let i = 1; i <= 5; i++) api?.push({ id: `d${i}`, tone: 'danger', title: `D${i}` }); });
      assert.deepEqual(titles('[role="alert"]'), ['D2', 'D3', 'D4', 'D5']);
      assert.equal(api?.toasts[0]?.hiddenOnce, undefined, 'D1 never rendered, so it is not marked hidden');
      const d5 = [...r.container.querySelectorAll('.toast')].find((e) => e.querySelector('.toast__title')?.textContent === 'D5') as HTMLElement;
      click(d5.querySelector('button') as HTMLElement);
      actSync(() => vi.advanceTimersByTime(100));
      assert.deepEqual(titles('[role="alert"]'), ['D1', 'D2', 'D3', 'D4']);
      assert.equal(r.container.querySelector('.toasts__again'), null);
      assert.deepEqual(log.counts(), { D1: 1, D2: 1, D3: 1, D4: 1, D5: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  for (const n of [5, 9]) {
    it(`a batch of ${n} danger toasts: each is announced exactly once, through expanding, collapsing and dismissing (red-team 3 RT3-1)`, () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let api: ReturnType<typeof useToasts> | undefined;
        function Host(): ReactElement {
          api = useToasts();
          return h(ToastRegion, { toasts: api.toasts, dispatch: api.dispatch });
        }
        const r = mount(h(Host));
        const log = announcements(r.container);
        const more = (): HTMLElement => r.container.querySelector('.toasts__more') as HTMLElement;
        actSync(() => { for (let i = 1; i <= n; i++) api?.push({ id: `d${i}`, tone: 'danger', title: `D${i}` }); });
        // Collapse and expand twice: the waiting toasts are announced on the first expand only.
        for (let i = 0; i < 4; i++) click(more());
        // Collapsed again: dismiss the newest shown toast until none is left; each one behind it moves up.
        click(more());
        while (r.container.querySelector('.toast') !== null) {
          const toasts = r.container.querySelectorAll('.toast');
          click((toasts[toasts.length - 1] as HTMLElement).querySelector('button') as HTMLElement);
          actSync(() => vi.advanceTimersByTime(100));
        }
        const once = Object.fromEntries(Array.from({ length: n }, (_, i) => [`D${i + 1}`, 1]));
        assert.deepEqual(log.counts(), once);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('a polite toast that waited from the start is announced when it first shows, then sits outside the status region (review n2, RT3-1)', () => {
    const initial: ToastItem[] = Array.from({ length: 6 }, (_, i) => ({ id: `i${i + 1}`, tone: 'info', title: `I${i + 1}`, phase: 'visible', paused: true }));
    let api: ReturnType<typeof useToasts> | undefined;
    function Host(): ReactElement {
      api = useToasts(initial);
      return h(ToastRegion, { toasts: api.toasts, dispatch: api.dispatch });
    }
    const r = mount(h(Host));
    const flags = (): Array<[boolean, boolean]> => (api?.toasts ?? []).map((t) => [t.announced === true, t.hiddenOnce === true]);
    assert.deepEqual(flags(), [[false, false], [false, false], [true, false], [true, false], [true, false], [true, false]]);
    const titles = (sel: string): string[] => [...r.container.querySelectorAll(`${sel} .toast__title`)].map((e) => e.textContent ?? '');
    const more = (): HTMLElement => r.container.querySelector('.toasts__more') as HTMLElement;
    click(more());
    assert.deepEqual(titles('[role="status"]'), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'], 'first shown: in the status region');
    click(more());
    assert.deepEqual(flags().slice(0, 2), [[true, true], [true, true]]);
    click(more());
    assert.deepEqual(titles('.toasts__again'), ['I1', 'I2']);
    assert.deepEqual(titles('[role="status"]'), ['I3', 'I4', 'I5', 'I6']);
  });

  it('renders inline for the catalogue', () => {
    const toasts: ToastItem[] = [{ id: 'x', tone: 'warning', title: 'W', phase: 'visible', paused: true }];
    const r = mount(h(ToastRegion, { toasts, dispatch: () => undefined, inline: true }));
    assert.equal(r.container.firstElementChild?.className, 'toasts toasts--inline');
  });
});

describe('UI-T04 Banner, Badge and NavItem', () => {
  it('Banner: alerts for danger and disconnected, status otherwise; only info can be dismissed', () => {
    const onDismiss = vi.fn();
    const r = mount(h('div', null,
      h(Banner, { tone: 'danger', title: 'Risk status unknown' }, 'Body'), h(Banner, { tone: 'disconnected', title: 'Disconnected' }),
      h(Banner, { tone: 'stale', title: 'Stale', onDismiss }), h(Banner, { tone: 'info', title: 'Update', onDismiss })));
    const banners = [...r.container.querySelectorAll('.banner')];
    assert.deepEqual(banners.map((b) => b.getAttribute('role')), ['alert', 'alert', 'status', 'status']);
    assert.deepEqual(banners.map((b) => b.querySelector('button') !== null), [false, false, false, true]);
    click(banners[3]?.querySelector('button') as HTMLElement);
    assert.equal(onDismiss.mock.calls.length, 1);
  });

  it('Badge carries an icon and text, never colour alone', () => {
    const r = mount(h('div', null, h(Badge, { tone: 'pos' }, 'Profit'), h(Badge, { tone: 'sim', pill: true }, 'SIM'), h(Badge, { tone: 'neutral' }, 'N')));
    const badges = [...r.container.querySelectorAll('.badge')];
    assert.deepEqual(badges.map((b) => b.querySelector('svg') !== null), [true, false, false]);
    assert.equal(badges[1]?.className, 'badge badge--sim badge--pill');
  });

  it('NavItem: active page, count, alert dot, collapsed with a name and tooltip', () => {
    const r = mount(h('nav', null,
      h(NavItem, { href: '#a', label: 'Alerts', icon: Settings, active: true, count: 3, alert: 'danger', className: 'x' }),
      h(NavItem, { href: '#r', label: 'Risk', icon: Settings, alert: 'warn' }),
      h(NavItem, { href: '#c', label: 'Alerts', icon: Settings, count: 3, alert: 'danger', collapsed: true }),
      h(NavItem, { href: '#p', label: 'Positions', icon: Settings, collapsed: true })));
    const links = [...r.container.querySelectorAll('a')];
    assert.equal(links[0]?.getAttribute('aria-current'), 'page');
    assert.equal(links[0]?.textContent, 'Alerts3critical alerts');
    assert.equal(links[1]?.textContent, 'Riskwarnings');
    assert.equal(links[2]?.getAttribute('aria-label'), 'Alerts, 3, critical alerts');
    assert.equal(links[3]?.getAttribute('aria-label'), 'Positions');
    assert.equal(links[1]?.getAttribute('aria-current'), null);
  });
});
