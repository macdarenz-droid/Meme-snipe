// DiffView (C38, UI-T07): the change a config or limits dialog applies, line by line: the setting, its current and new
// value, each with its unit, and the risk direction. States: no-changes, changes, conflict (the server's version
// changed after the preview, so the values must be reviewed again). Values arrive formatted (lib/money.ts).
import { createElement as h, type ReactElement } from 'react';
import { ArrowRight } from 'lucide-react';
import { Icon } from './icon.ts';
import { Badge, Banner } from './status.ts';

export type RiskDirection = 'raises' | 'lowers' | 'neutral';

export interface DiffLine {
  key: string;
  /** The setting, as the Risk or Config page names it. */
  label: string;
  /** Formatted current value, without the unit. */
  before: string;
  /** Formatted new value, without the unit. */
  after: string;
  /** `SOL`, `bps`, `%`, `ms`, `positions`. */
  unit: string;
  direction: RiskDirection;
}

export interface DiffViewProps {
  kind: 'config' | 'limits';
  lines: readonly DiffLine[];
  /** The server's version changed since the preview. */
  conflict?: boolean;
}

export type DiffState = 'no-changes' | 'changes' | 'conflict';

export function diffState(props: DiffViewProps): DiffState {
  if (props.conflict === true) return 'conflict';
  return props.lines.length === 0 ? 'no-changes' : 'changes';
}

const DIRECTION: Readonly<Record<RiskDirection, { text: string; tone: 'warn' | 'info' | 'neutral' }>> = {
  raises: { text: 'Raises risk', tone: 'warn' },
  lowers: { text: 'Lowers risk', tone: 'info' },
  neutral: { text: 'No risk change', tone: 'neutral' },
};

export function DiffView(props: DiffViewProps): ReactElement {
  const state = diffState(props);
  const caption = props.kind === 'limits' ? 'Limit changes' : 'Configuration changes';
  return h('div', { className: 'diff', 'data-state': state },
    state === 'conflict' ? h(Banner, { tone: 'warning', title: 'The server’s version changed' }, 'Review the new values before you confirm.') : null,
    props.lines.length === 0
      ? h('p', { className: 'diff__empty' }, 'No changes.')
      : h('div', { className: 'diff__scroll' }, h('table', { className: 'diff__table' },
        h('caption', { className: 'visually-hidden' }, caption),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Setting'), h('th', { scope: 'col', className: 'num' }, 'Current'), h('th', { scope: 'col' }, h('span', { className: 'visually-hidden' }, 'to')),
          h('th', { scope: 'col', className: 'num' }, 'New'), h('th', { scope: 'col' }, 'Effect'))),
        h('tbody', null, props.lines.map((l) => h('tr', { key: l.key, 'data-direction': l.direction },
          h('th', { scope: 'row', className: 'diff__label' }, l.label),
          h('td', { className: 'num diff__value' }, `${l.before} ${l.unit}`),
          h('td', { className: 'diff__arrow' }, h(Icon, { icon: ArrowRight })),
          h('td', { className: 'num diff__value diff__value--new' }, `${l.after} ${l.unit}`),
          h('td', null, h(Badge, { tone: DIRECTION[l.direction].tone }, DIRECTION[l.direction].text))))))));
}
