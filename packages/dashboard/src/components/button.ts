// Button (C01) and IconButton (C02), UI-T04.
// - Variants: primary, secondary, ghost, danger, live-confirm (only inside LIVE dialogs); sizes 28 / 32 / 40 px.
// - `status` makes a button money-affecting: loading and pending show a spinner left of the unchanged label with
//   aria-busy; confirmed shows a check; failed shows the inline error below. The idle, busy and confirmed contents are
//   stacked in one grid cell, so the width never changes between states (the widest decides), and the idle label
//   stays in the accessibility tree (transparent, not hidden), so the accessible name never changes.
// - `disabledReason` disables the button with aria-disabled (it stays focusable and hoverable) and shows the reason in
//   a tooltip that is also its description. Never pre-disable to block a form; validate on submit.
import { createElement as h, Fragment, useId, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { Check, CircleX, type LucideIcon } from 'lucide-react';
import { cx } from './cx.ts';
import { Icon, Spinner } from './icon.ts';
import { Kbd } from './kbd.ts';
import { Tooltip } from './tooltip.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'live-confirm';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonStatus = 'idle' | 'loading' | 'pending' | 'confirmed' | 'failed';

export interface ButtonProps {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  status?: ButtonStatus;
  /** The inline error shown below when status is failed. */
  error?: string;
  disabledReason?: string;
  type?: 'button' | 'submit';
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Extra classes (the catalogue's static `is-hover`, `is-active` and `is-focus` states). */
  className?: string;
}

/** Calls `onClick` unless the control is disabled or busy (aria-disabled controls still receive clicks). */
function guarded(onClick: ((e: MouseEvent<HTMLButtonElement>) => void) | undefined, blocked: boolean): (e: MouseEvent<HTMLButtonElement>) => void {
  return (e) => {
    if (blocked) e.preventDefault();
    else onClick?.(e);
  };
}

export function Button(props: ButtonProps): ReactElement {
  const id = useId();
  const status = props.status;
  const busy = status === 'loading' || status === 'pending';
  const disabled = props.disabledReason !== undefined;
  const lead = (icon: ReactNode): ReactNode => (icon === null ? null : h('span', { className: 'btn__icon' }, icon));
  const idleIcon = props.icon === undefined ? null : h(Icon, { icon: props.icon });
  const label = h('span', { className: 'btn__label' }, props.children);
  const content = status === undefined
    ? h(Fragment, null, lead(idleIcon), label)
    : h('span', { className: 'btn__stack', 'data-status': status },
      h('span', { className: 'btn__layer btn__layer--idle' }, lead(idleIcon), label),
      h('span', { className: 'btn__layer btn__layer--busy', 'aria-hidden': true }, lead(h(Spinner)), h('span', { className: 'btn__label' }, props.children)),
      h('span', { className: 'btn__layer btn__layer--confirmed', 'aria-hidden': true }, lead(h(Icon, { icon: Check })), h('span', { className: 'btn__label' }, props.children)));
  const describedBy = [disabled ? `${id}-reason` : null, status === 'failed' && props.error !== undefined ? `${id}-error` : null].filter(Boolean).join(' ');
  const button = h('button', {
    type: props.type ?? 'button',
    className: cx('btn', `btn--${props.variant ?? 'secondary'}`, `btn--${props.size ?? 'md'}`, props.className),
    'aria-busy': busy || undefined,
    'aria-disabled': disabled || undefined,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    onClick: guarded(props.onClick, disabled || busy),
  }, content);
  return h('span', { className: 'btn-wrap' },
    disabled ? h(Tooltip, { content: props.disabledReason }, button) : button,
    disabled ? h('span', { id: `${id}-reason`, className: 'visually-hidden' }, props.disabledReason) : null,
    status === 'failed' && props.error !== undefined
      ? h('span', { id: `${id}-error`, className: 'btn__error', role: 'alert' }, h(Icon, { icon: CircleX }), props.error)
      : null);
}

export interface IconButtonProps {
  icon: LucideIcon;
  /** The accessible name, also the tooltip text. */
  label: string;
  /** Keys of the shortcut shown in the tooltip, e.g. ['Mod', 'K']. */
  shortcut?: readonly string[];
  variant?: 'ghost' | 'outline';
  size?: 'sm' | 'md';
  loading?: boolean;
  /** A toggle button's state (aria-pressed). */
  pressed?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}

export function IconButton(props: IconButtonProps): ReactElement {
  const loading = props.loading === true;
  return h(Tooltip, { content: h('span', { className: 'tooltip__row' }, props.label, props.shortcut === undefined ? null : h(Kbd, { keys: props.shortcut })) },
    h('button', {
      type: 'button',
      className: cx('icon-btn', `icon-btn--${props.variant ?? 'ghost'}`, `icon-btn--${props.size ?? 'md'}`, props.className),
      'aria-label': props.label,
      'aria-pressed': props.pressed,
      'aria-busy': loading || undefined,
      onClick: guarded(props.onClick, loading),
    }, loading ? h(Spinner) : h(Icon, { icon: props.icon })));
}
