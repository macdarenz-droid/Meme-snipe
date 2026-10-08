// Select / Combobox (UI-T04, C09): single, multi and searchable, on the WAI-ARIA combobox pattern (UI-F42): DOM focus
// stays on the combobox; arrows, Home and End move `aria-activedescendant`; Enter (and Space when not searchable)
// chooses; Escape and Tab close. States: open, no-results, loading-options and option-disabled. A disabled option can
// be reached by keyboard or pointer and shows its reason in a tooltip that is its description and is announced.
// Built here, not on Radix Select: Radix Select 2.3.7 skips disabled items, moves DOM focus into the list instead of
// using aria-activedescendant, has no multi or search mode, and injects a <style> element (react-remove-scroll) that
// the dashboard CSP refuses (recorded in the pull request).
import { createElement as h, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { chooseValue, filterOptions, moveActive, openingIndex, type ListOption, type MoveKey } from '../lib/listbox.ts';
import { cx } from './cx.ts';
import { Icon, Spinner } from './icon.ts';

export interface SelectProps {
  label: string;
  options: readonly ListOption[];
  value: readonly string[];
  onChange?: (value: string[]) => void;
  multi?: boolean;
  searchable?: boolean;
  loading?: boolean;
  placeholder?: string;
  /** Initial state, for the catalogue's static states. */
  defaultOpen?: boolean;
  defaultQuery?: string;
  defaultActive?: number;
}

const MOVES = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export function Select(props: SelectProps): ReactElement {
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(props.defaultOpen === true);
  const [query, setQuery] = useState(props.defaultQuery ?? '');
  const [active, setActive] = useState(props.defaultActive ?? -1);
  const multi = props.multi === true;
  const searchable = props.searchable === true;
  const visible = searchable ? filterOptions(props.options, query) : [...props.options];
  const activeOption = open && active >= 0 ? visible[active] : undefined;
  const optionId = (i: number): string => `${id}-opt-${i}`;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (!(wrap.current as HTMLDivElement).contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const openAt = (last: boolean): void => {
    setOpen(true);
    setActive(openingIndex(visible, props.value, last));
  };
  const choose = (i: number): void => {
    const option = visible[i];
    if (option === undefined || option.disabled === true) return;
    props.onChange?.(chooseValue(props.value, option.value, multi));
    if (!multi) setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const key = e.key;
    if (!open) {
      if (MOVES.has(key) || key === 'Enter' || (key === ' ' && !searchable)) {
        e.preventDefault();
        openAt(key === 'ArrowUp' || key === 'End');
      }
      return;
    }
    if (MOVES.has(key)) {
      e.preventDefault();
      setActive(moveActive(active, key as MoveKey, visible.length));
    } else if (key === 'Enter' || (key === ' ' && !searchable)) {
      e.preventDefault();
      choose(active);
    } else if (key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (key === 'Tab') {
      setOpen(false);
    }
  };

  const selectedLabels = props.options.filter((o) => props.value.includes(o.value)).map((o) => o.label);
  const shown = selectedLabels.length === 0 ? (props.placeholder ?? 'Select') : multi && selectedLabels.length > 2 ? `${selectedLabels.length} selected` : selectedLabels.join(', ');
  const common = {
    role: 'combobox',
    'aria-expanded': open,
    'aria-controls': `${id}-listbox`,
    'aria-haspopup': 'listbox' as const,
    'aria-activedescendant': activeOption === undefined ? undefined : optionId(active),
    onKeyDown,
  };
  const control = searchable
    ? h('input', {
      ...common,
      id: `${id}-input`,
      className: 'select__input',
      type: 'text',
      value: query,
      placeholder: shown,
      autoComplete: 'off',
      'aria-autocomplete': 'list' as const,
      'aria-labelledby': `${id}-label`,
      onChange: (e: { currentTarget: HTMLInputElement }) => { setQuery(e.currentTarget.value); setOpen(true); setActive(0); },
      onClick: () => { if (!open) openAt(false); },
    })
    : h('div', {
      ...common,
      tabIndex: 0,
      className: 'select__trigger',
      'aria-labelledby': `${id}-label ${id}-value`,
      onClick: () => { if (open) setOpen(false); else openAt(false); },
    }, h('span', { id: `${id}-value`, className: cx('select__value', selectedLabels.length === 0 && 'select__value--placeholder') }, shown));

  const reason = activeOption?.disabled === true ? activeOption.reason ?? 'Not available' : null;
  return h('div', { className: cx('select', open && 'select--open'), ref: wrap },
    h('div', { id: `${id}-label`, className: 'field__label' }, props.label),
    h('div', { className: 'select__control' }, control, h(Icon, { icon: ChevronDown, className: 'select__chevron' })),
    h('div', { className: 'visually-hidden', role: 'status' }, reason === null ? '' : `Unavailable: ${reason}`),
    open ? h('div', { className: 'select__popup' },
      props.loading === true ? h('div', { className: 'select__note', role: 'status' }, h(Spinner), 'Loading options') : null,
      props.loading !== true && visible.length === 0 ? h('div', { className: 'select__note', role: 'status' }, 'No results') : null,
      h('ul', { id: `${id}-listbox`, role: 'listbox', className: 'select__list', 'aria-labelledby': `${id}-label`, 'aria-multiselectable': multi || undefined },
        visible.map((o, i) => {
          const selected = props.value.includes(o.value);
          const isActive = i === active;
          return h('li', {
            key: o.value,
            id: optionId(i),
            role: 'option',
            className: cx('select__option', isActive && 'select__option--active', o.disabled === true && 'select__option--disabled'),
            'aria-selected': selected,
            'aria-disabled': o.disabled === true || undefined,
            'aria-describedby': isActive && o.disabled === true ? `${id}-reason` : undefined,
            onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
            onMouseEnter: () => setActive(i),
            onClick: () => choose(i),
          },
          h('span', { className: 'select__check' }, selected ? h(Icon, { icon: Check }) : null),
          o.label,
          isActive && o.disabled === true ? h('span', { id: `${id}-reason`, role: 'tooltip', className: 'select__reason' }, o.reason ?? 'Not available') : null);
        }))) : null);
}
