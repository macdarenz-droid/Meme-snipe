// A formatted number (UI-T03): the visible text is hidden from assistive technology and the unabbreviated label is
// read instead, so `0.0₅4321` is announced as 0.000004321 and `−0.0045 SOL` as "minus 0.0045 SOL" (DS Accessibility,
// "Language and numbers"). Tabular figures come from the `.num` class.
import { createElement as h, type ReactElement } from 'react';
import type { Formatted } from '../lib/money.ts';

export interface NumProps { value: Formatted; className?: string }

export function Num(props: NumProps): ReactElement {
  const { text, label } = props.value;
  return h('span', { className: props.className === undefined ? 'num' : `num ${props.className}` },
    h('span', { 'aria-hidden': true }, text),
    h('span', { className: 'visually-hidden' }, label));
}
