// Banner (C20), Badge / StatusPill (C21) and NavItem (C43), UI-T04.
import { createElement as h, type ReactElement, type ReactNode } from 'react';
import { Info, X, type LucideIcon } from 'lucide-react';
import { IconButton } from './button.ts';
import { cx } from './cx.ts';
import { Icon, STATE_ICONS } from './icon.ts';
import { Tooltip } from './tooltip.ts';

export type BannerTone = 'info' | 'warning' | 'danger' | 'stale' | 'disconnected' | 'paper' | 'live';

const BANNER_ICON: Readonly<Record<BannerTone, LucideIcon>> = {
  info: Info, warning: STATE_ICONS['warning'] as LucideIcon, danger: STATE_ICONS['danger'] as LucideIcon, stale: STATE_ICONS['stale'] as LucideIcon,
  disconnected: STATE_ICONS['disconnected'] as LucideIcon, paper: STATE_ICONS['paper'] as LucideIcon, live: STATE_ICONS['live'] as LucideIcon,
};

export interface BannerProps { tone: BannerTone; title: string; children?: ReactNode; onDismiss?: () => void }

/**
 * An inline banner above the page content. Only info banners can be dismissed; danger, stale and disconnected banners
 * persist while their condition holds. Danger and disconnected banners are alerts; the others are status messages.
 */
export function Banner(props: BannerProps): ReactElement {
  const dismissible = props.tone === 'info' && props.onDismiss !== undefined;
  const alert = props.tone === 'danger' || props.tone === 'disconnected';
  return h('div', { className: `banner banner--${props.tone}`, role: alert ? 'alert' : 'status' },
    h(Icon, { icon: BANNER_ICON[props.tone], className: 'banner__icon' }),
    h('div', { className: 'banner__text' }, h('p', { className: 'banner__title' }, props.title), props.children === undefined ? null : h('div', { className: 'banner__body' }, props.children)),
    dismissible ? h(IconButton, { icon: X, label: 'Dismiss', size: 'sm', onClick: props.onDismiss as () => void }) : null);
}

export type BadgeTone = 'neutral' | 'pos' | 'neg' | 'warn' | 'danger' | 'info' | 'paper' | 'live' | 'sim';

const BADGE_ICON: Readonly<Record<BadgeTone, LucideIcon | null>> = {
  neutral: null, pos: STATE_ICONS['profit'] as LucideIcon, neg: STATE_ICONS['loss'] as LucideIcon, warn: STATE_ICONS['warning'] as LucideIcon,
  danger: STATE_ICONS['danger'] as LucideIcon, info: Info, paper: STATE_ICONS['paper'] as LucideIcon, live: STATE_ICONS['live'] as LucideIcon, sim: null,
};

/** A badge or status pill: icon and text, never colour alone. */
export function Badge(props: { tone: BadgeTone; children?: ReactNode; pill?: boolean }): ReactElement {
  const icon = BADGE_ICON[props.tone];
  return h('span', { className: cx('badge', `badge--${props.tone}`, props.pill === true && 'badge--pill') },
    icon === null ? null : h(Icon, { icon }), props.children);
}

export interface NavItemProps {
  href: string;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  count?: number;
  alert?: 'warn' | 'danger';
  collapsed?: boolean;
  className?: string;
}

/** A sidebar link: active (aria-current), count, alert dot, and a collapsed icon-only form with a tooltip. */
export function NavItem(props: NavItemProps): ReactElement {
  const collapsed = props.collapsed === true;
  const extra = [
    props.count === undefined ? null : h('span', { key: 'c', className: 'nav-item__count' }, String(props.count)),
    props.alert === undefined ? null : h('span', { key: 'a', className: `nav-item__dot nav-item__dot--${props.alert}` },
      h('span', { className: 'visually-hidden' }, props.alert === 'danger' ? 'critical alerts' : 'warnings')),
  ];
  const name = [props.label, props.count === undefined ? null : `${props.count}`, props.alert === undefined ? null : props.alert === 'danger' ? 'critical alerts' : 'warnings']
    .filter(Boolean).join(', ');
  const link = h('a', {
    href: props.href,
    className: cx('nav-item', props.active === true && 'nav-item--active', collapsed && 'nav-item--collapsed', props.className),
    'aria-current': props.active === true ? 'page' : undefined,
    'aria-label': collapsed ? name : undefined,
  }, h(Icon, { icon: props.icon }), collapsed ? null : h('span', { className: 'nav-item__label' }, props.label), ...extra);
  return collapsed ? h(Tooltip, { content: props.label, side: 'right' }, link) : link;
}

