// Tooltip (UI-T04, C13) on Radix Tooltip: opens 400 ms after the pointer rests and at once on keyboard focus, and
// stays open while its trigger has focus (Radix alone delays focus too, and closes a tooltip whenever the page
// scrolls, which focusing an element below the fold does). Escape and blur close it. Text or rich content (value,
// exact value, source); it never holds the only copy of what is needed to act.
import { cloneElement, createElement as h, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import * as RT from '@radix-ui/react-tooltip';

/** Hover delay before a tooltip opens (C13). */
export const TOOLTIP_DELAY_MS = 400;

interface TriggerProps {
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
}

export interface TooltipProps {
  content: ReactNode;
  /** The trigger: one focusable element that accepts a ref. */
  children?: ReactElement<TriggerProps>;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Fixed open state, for the catalogue's static states. */
  open?: boolean;
}

export function Tooltip(props: TooltipProps): ReactElement {
  const [open, setOpen] = useState(false);
  const focused = useRef<HTMLElement | null>(null);
  const child = props.children as ReactElement<TriggerProps>;
  const trigger = cloneElement(child, {
    onFocus: (e: FocusEvent<HTMLElement>) => {
      child.props.onFocus?.(e);
      focused.current = e.currentTarget;
      setOpen(true);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      child.props.onBlur?.(e);
      focused.current = null;
      setOpen(false);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      child.props.onKeyDown?.(e);
      if (e.key === 'Escape') {
        focused.current = null;
        setOpen(false);
      }
    },
  });
  // A close request while the trigger still has focus (a scroll, the pointer leaving) is ignored; Escape and blur
  // clear `focused` first.
  const onOpenChange = (next: boolean): void => {
    if (!next && focused.current !== null) return;
    setOpen(next);
  };
  const root = h(RT.Root, { open: props.open ?? open, onOpenChange },
    h(RT.Trigger, { asChild: true }, trigger),
    h(RT.Portal, null,
      h(RT.Content, { className: 'tooltip', side: props.side ?? 'top', sideOffset: 6, collisionPadding: 8 }, props.content)));
  return h(RT.Provider, { delayDuration: TOOLTIP_DELAY_MS, skipDelayDuration: 300, children: root });
}
