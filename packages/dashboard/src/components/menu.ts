// Popover, Menu and ContextMenu (UI-T04, C14) on Radix: roving focus, Escape closes, focus returns to the trigger.
// States: open, submenu-open, item-disabled (the reason is shown in the item, not only in a tooltip). Menus and
// popovers are non-modal: the modal variants lock scrolling through react-remove-scroll, which injects a <style>
// element the dashboard CSP refuses.
import { createElement as h, type ReactElement, type ReactNode } from 'react';
import * as CM from '@radix-ui/react-context-menu';
import * as DM from '@radix-ui/react-dropdown-menu';
import * as RP from '@radix-ui/react-popover';
import { ChevronRight } from 'lucide-react';
import { Icon } from './icon.ts';
import { Kbd } from './kbd.ts';

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Why the item is disabled (shown under its label). */
  reason?: string;
  shortcut?: readonly string[];
  /** A submenu. */
  items?: readonly MenuItem[];
}

type Parts = typeof DM | typeof CM;

function itemBody(item: MenuItem): ReactNode[] {
  return [
    h('span', { key: 'l', className: 'menu__text' }, item.label,
      item.disabled === true && item.reason !== undefined ? h('span', { className: 'menu__reason' }, item.reason) : null),
    item.shortcut === undefined ? null : h(Kbd, { key: 'k', keys: item.shortcut }),
  ];
}

function renderItems(parts: Parts, items: readonly MenuItem[]): ReactNode[] {
  return items.map((item) => {
    if (item.items !== undefined) {
      return h(parts.Sub, { key: item.label },
        h(parts.SubTrigger, { className: 'menu__item', ...(item.disabled === true ? { disabled: true } : {}) }, ...itemBody(item), h(Icon, { icon: ChevronRight })),
        h(parts.Portal, null, h(parts.SubContent, { className: 'menu', sideOffset: 4, collisionPadding: 8 }, renderItems(parts, item.items))));
    }
    return h(parts.Item, {
      key: item.label,
      className: 'menu__item',
      ...(item.disabled === true ? { disabled: true } : {}),
      ...(item.onSelect === undefined ? {} : { onSelect: item.onSelect }),
    }, ...itemBody(item));
  });
}

/** A menu button: the menu is named by its trigger (aria-labelledby, WAI-ARIA menu button pattern). */
export interface MenuProps { trigger: ReactElement; items: readonly MenuItem[]; defaultOpen?: boolean }

export function Menu(props: MenuProps): ReactElement {
  return h(DM.Root, { modal: false, ...(props.defaultOpen === true ? { defaultOpen: true } : {}) },
    h(DM.Trigger, { asChild: true }, props.trigger),
    h(DM.Portal, null, h(DM.Content, { className: 'menu', sideOffset: 4, collisionPadding: 8, align: 'start' }, renderItems(DM, props.items))));
}

/** A context menu has no trigger to name it, so it takes a label. */
export interface ContextMenuProps { children?: ReactElement; items: readonly MenuItem[]; label: string }

export function ContextMenu(props: ContextMenuProps): ReactElement {
  return h(CM.Root, { modal: false },
    h(CM.Trigger, { asChild: true }, props.children),
    h(CM.Portal, null, h(CM.Content, { className: 'menu', collisionPadding: 8, 'aria-label': props.label }, renderItems(CM, props.items))));
}

export interface PopoverProps { trigger: ReactElement; label: string; children?: ReactNode; defaultOpen?: boolean }

export function Popover(props: PopoverProps): ReactElement {
  return h(RP.Root, props.defaultOpen === true ? { defaultOpen: true } : {},
    h(RP.Trigger, { asChild: true }, props.trigger),
    h(RP.Portal, null, h(RP.Content, { className: 'popover', sideOffset: 6, collisionPadding: 8, align: 'start', 'aria-label': props.label }, props.children)));
}
