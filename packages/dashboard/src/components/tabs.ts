// Tabs (UI-T04, C12) on Radix Tabs: underline style; selected and has-alert-dot states; arrow keys, Home and End move
// between tabs (WAI-ARIA tabs pattern, automatic activation). The value is controlled, so the router can keep it in
// the URL (UI-T10).
import { createElement as h, type ReactElement, type ReactNode } from 'react';
import * as RTabs from '@radix-ui/react-tabs';

export interface TabSpec { value: string; label: string; alert?: 'warn' | 'danger'; content: ReactNode }

export interface TabsProps { label: string; tabs: readonly TabSpec[]; value: string; onValueChange?: (value: string) => void }

export function Tabs(props: TabsProps): ReactElement {
  return h(RTabs.Root, { className: 'tabs', value: props.value, ...(props.onValueChange === undefined ? {} : { onValueChange: props.onValueChange }) },
    h(RTabs.List, { className: 'tabs__list', 'aria-label': props.label }, props.tabs.map((t) =>
      h(RTabs.Trigger, { key: t.value, value: t.value, className: 'tabs__tab' },
        t.label,
        t.alert === undefined ? null : h('span', { className: `tabs__dot tabs__dot--${t.alert}` },
          h('span', { className: 'visually-hidden' }, t.alert === 'danger' ? ', critical alerts' : ', warnings'))))),
    props.tabs.map((t) => h(RTabs.Content, { key: t.value, value: t.value, className: 'tabs__panel' }, t.content)));
}
