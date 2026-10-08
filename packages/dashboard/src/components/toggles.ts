// Switch (C10), Checkbox, Radio group and SegmentedControl (C11), UI-T04. Native inputs where they exist (checkbox and
// radio, so forms, keyboard and assistive technology work as the platform does); the switch is a button with
// role="switch". A server-backed switch shows pending (aria-busy, no further toggling) and failed (the error below).
// Switches are never used for money-affecting toggles that need confirmation; those open a dialog.
import { createElement as h, useEffect, useId, useRef, type ReactElement } from 'react';
import { CircleX } from 'lucide-react';
import { cx } from './cx.ts';
import { Icon, Spinner } from './icon.ts';

export interface SwitchProps {
  label: string;
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  status?: 'pending' | 'failed';
  error?: string;
}

export function Switch(props: SwitchProps): ReactElement {
  const id = useId();
  const pending = props.status === 'pending';
  const failed = props.status === 'failed' && props.error !== undefined;
  return h('div', { className: 'switch-field' },
    h('button', {
      type: 'button',
      role: 'switch',
      id,
      className: cx('switch', props.checked && 'switch--on', pending && 'switch--pending'),
      'aria-checked': props.checked,
      'aria-busy': pending || undefined,
      'aria-describedby': failed ? `${id}-error` : undefined,
      onClick: () => { if (!pending) props.onCheckedChange?.(!props.checked); },
    }, h('span', { className: 'switch__thumb' }, pending ? h(Spinner) : null)),
    h('label', { className: 'switch-field__label', htmlFor: id }, props.label),
    failed ? h('p', { id: `${id}-error`, className: 'field__message field__message--error', role: 'alert' }, h(Icon, { icon: CircleX }), props.error) : null);
}

export interface CheckboxProps {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export function Checkbox(props: CheckboxProps): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  const indeterminate = props.indeterminate === true;
  useEffect(() => { (ref.current as HTMLInputElement).indeterminate = indeterminate; }, [indeterminate]);
  return h('label', { className: 'check' },
    h('input', { ref, type: 'checkbox', className: 'check__box', checked: props.checked, onChange: (e: { currentTarget: HTMLInputElement }) => props.onCheckedChange?.(e.currentTarget.checked) }),
    h('span', { className: 'check__label' }, props.label));
}

export interface ChoiceOption { value: string; label: string }

export interface RadioGroupProps {
  legend: string;
  options: readonly ChoiceOption[];
  value: string;
  onValueChange?: (value: string) => void;
  /** `segmented` is the SegmentedControl (time ranges, density). */
  variant?: 'list' | 'segmented';
}

export function RadioGroup(props: RadioGroupProps): ReactElement {
  const name = useId();
  const segmented = props.variant === 'segmented';
  return h('fieldset', { className: cx('choice', segmented ? 'segmented' : 'radio-list') },
    h('legend', { className: cx('field__label', segmented && 'segmented__legend') }, props.legend),
    h('div', { className: segmented ? 'segmented__track' : 'radio-list__items' }, props.options.map((o) =>
      h('label', { key: o.value, className: cx(segmented ? 'segmented__item' : 'radio', props.value === o.value && 'is-checked') },
        h('input', {
          type: 'radio', name, value: o.value, className: segmented ? 'segmented__input' : 'radio__input', checked: props.value === o.value,
          onChange: () => props.onValueChange?.(o.value),
        }),
        h('span', { className: segmented ? 'segmented__label' : 'radio__label' }, o.label)))));
}

/** SegmentedControl (C11): a radio group drawn as joined segments. */
export function SegmentedControl(props: Omit<RadioGroupProps, 'variant'>): ReactElement {
  return h(RadioGroup, { ...props, variant: 'segmented' });
}
