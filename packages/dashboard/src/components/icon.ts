// Icons (UI-T04, DS Iconography): Lucide at 16px (20px in empty states) with a 1.5px stroke at every size, in
// currentColor. Lucide marks icons aria-hidden; an icon never carries state alone (a text label or accessible name
// sits beside it). The reserved state icons exist in lucide-react 1.47.0 (test/primitives.test.ts).
import { createElement as h, type ReactElement } from 'react';
import {
  ClockAlert, FlaskConical, History, LoaderCircle, LockKeyhole, OctagonAlert, OctagonX, Radio, TrendingDown, TrendingUp, TriangleAlert, Unplug,
  type LucideIcon,
} from 'lucide-react';
import { cx } from './cx.ts';

/** The DS reserved state icons (Iconography). */
export const STATE_ICONS: Readonly<Record<string, LucideIcon>> = {
  profit: TrendingUp, loss: TrendingDown, warning: TriangleAlert, danger: OctagonAlert, halt: OctagonX, paper: FlaskConical,
  live: Radio, offline: History, stale: ClockAlert, disconnected: Unplug, 'step-up': LockKeyhole,
};

export interface IconProps { icon: LucideIcon; size?: 16 | 20; className?: string }

export function Icon(props: IconProps): ReactElement {
  return h(props.icon, { size: props.size ?? 16, strokeWidth: 1.5, absoluteStrokeWidth: true, className: cx('icon', props.className), 'aria-hidden': true });
}

/** The busy spinner (static under reduced motion). */
export function Spinner(): ReactElement {
  return h(Icon, { icon: LoaderCircle, className: 'spinner' });
}
