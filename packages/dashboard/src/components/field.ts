// TextInput (C07) and AmountInput (C08), UI-T04. The label is always visible (never a placeholder-only label). States:
// filled, invalid (message and icon), warning (valid but risky: amber message), read-only and dirty (changed from the
// saved value: a 2px left marker). A unit adornment (SOL, bps, %, ms) is read as part of the description.
// AmountInput parses exactly (src/lib/amount.ts): `0.25` SOL is "250000000" lamports, more than 9 decimals is invalid
// and never rounded, and out-of-range or over-limit values show the bounds or the limit, with a link to the limit.
import { createElement as h, useId, type ReactElement, type ReactNode } from 'react';
import { CircleX, Search, TriangleAlert } from 'lucide-react';
import { parseAmountInput, readBack, type AmountResult, type AmountSpec } from '../lib/amount.ts';
import { cx } from './cx.ts';
import { Icon } from './icon.ts';

export type FieldTone = 'invalid' | 'warning';

export interface TextInputProps {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  /** Unit adornment shown after the value. */
  unit?: string;
  variant?: 'default' | 'search';
  message?: string;
  tone?: FieldTone;
  readOnly?: boolean;
  dirty?: boolean;
  inputMode?: 'text' | 'decimal' | 'numeric' | 'search';
  /** Extra content under the message (for example a link). */
  extra?: ReactNode;
}

export function TextInput(props: TextInputProps): ReactElement {
  const id = useId();
  const described = [props.unit === undefined ? null : `${id}-unit`, props.message === undefined ? null : `${id}-msg`].filter(Boolean).join(' ');
  return h('div', { className: cx('field', props.tone !== undefined && `field--${props.tone}`, props.dirty === true && 'field--dirty', props.readOnly === true && 'field--readonly') },
    h('label', { className: 'field__label', htmlFor: id }, props.label),
    h('div', { className: 'field__control' },
      props.variant === 'search' ? h(Icon, { icon: Search, className: 'field__lead' }) : null,
      h('input', {
        id,
        className: 'field__input',
        type: props.variant === 'search' ? 'search' : 'text',
        value: props.value,
        readOnly: props.readOnly,
        inputMode: props.inputMode,
        autoComplete: 'off',
        spellCheck: false,
        'aria-invalid': props.tone === 'invalid' || undefined,
        'aria-describedby': described === '' ? undefined : described,
        onChange: (e) => props.onChange?.(e.currentTarget.value),
      }),
      props.unit === undefined ? null : h('span', { id: `${id}-unit`, className: 'field__unit' }, props.unit)),
    props.message === undefined ? null : h('p', { id: `${id}-msg`, className: 'field__message' },
      props.tone === undefined ? null : h(Icon, { icon: props.tone === 'invalid' ? CircleX : TriangleAlert }), props.message),
    props.extra ?? null);
}

export interface AmountInputProps {
  label: string;
  value: string;
  spec: AmountSpec;
  /** The unit shown (SOL, the token symbol, bps, %). */
  unit: string;
  onChange?: (text: string, result: AmountResult) => void;
  /** Where the limit is managed, linked from an exceeds-limit message. */
  limitHref?: string;
  dirty?: boolean;
  readOnly?: boolean;
}

export function AmountInput(props: AmountInputProps): ReactElement {
  const result = parseAmountInput(props.value, props.spec);
  const error = result.kind === 'invalid' || result.kind === 'out-of-range' || result.kind === 'exceeds-limit' ? result.message : undefined;
  // The parsed value is always shown back (Z05 round 2, red team M4), with any error before it.
  const back = readBack(result, props.spec);
  const message = error === undefined ? back ?? undefined : back === null ? error : `${error}. ${back}`;
  const link = result.kind === 'exceeds-limit' && props.limitHref !== undefined
    ? h('a', { className: 'field__link', href: props.limitHref }, 'Risk limits') : null;
  return h(TextInput, {
    label: props.label,
    value: props.value,
    unit: props.unit,
    inputMode: props.spec.unit === 'bps' ? 'numeric' : 'decimal',
    onChange: (text: string) => props.onChange?.(text, parseAmountInput(text, props.spec)),
    ...(message === undefined ? {} : { message }),
    ...(error === undefined ? {} : { tone: 'invalid' as const }),
    ...(props.dirty === undefined ? {} : { dirty: props.dirty }),
    ...(props.readOnly === undefined ? {} : { readOnly: props.readOnly }),
    extra: link,
  });
}
