// Toast region (UI-T04, C19): polite toasts in a role="status" region, danger toasts in a role="alert" region. At most
// MAX_TOASTS show; older ones wait behind an "n more" button that expands the stack. The fixed stack never grows past
// the viewport: beyond it, it scrolls. Each toast is announced once: a toast shown again after it was announced and
// hidden renders beside its live region, not in it, so a screen reader does not announce an old failure as new; a
// toast that waited beyond the maximum from the start renders in its live region when it first shows.
import { createElement as h, useEffect, useLayoutEffect, useReducer, useState, type Dispatch, type ReactElement } from 'react';
import { CircleCheck, Info, OctagonAlert, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { TOAST_ENTER_MS, TOAST_EXIT_MS, autoDismissMs, toastReducer, toastStack, type ToastAction, type ToastInput, type ToastItem, type ToastTone } from '../lib/toasts.ts';
import { IconButton } from './button.ts';
import { Icon } from './icon.ts';

const TONE_ICON: Readonly<Record<ToastTone, LucideIcon>> = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: OctagonAlert };

function Toast(props: { toast: ToastItem; dispatch: Dispatch<ToastAction> }): ReactElement {
  const { toast, dispatch } = props;
  const { id, phase, paused, tone } = toast;
  useEffect(() => {
    const delay = phase === 'entering' ? TOAST_ENTER_MS : phase === 'exiting' ? TOAST_EXIT_MS : paused ? null : autoDismissMs(tone);
    if (delay === null) return undefined;
    const type = phase === 'entering' ? 'shown' : phase === 'exiting' ? 'remove' : 'dismiss';
    const timer = setTimeout(() => dispatch({ type, id }), delay);
    return () => clearTimeout(timer);
  }, [id, phase, paused, tone, dispatch]);
  return h('div', {
    className: `toast toast--${tone}`,
    'data-phase': phase,
    'data-paused': paused,
    onMouseEnter: () => dispatch({ type: 'pause', id }),
    onMouseLeave: () => dispatch({ type: 'resume', id }),
    onFocus: () => dispatch({ type: 'pause', id }),
    onBlur: () => dispatch({ type: 'resume', id }),
  },
  h(Icon, { icon: TONE_ICON[tone], className: 'toast__icon' }),
  h('div', { className: 'toast__text' }, h('p', { className: 'toast__title' }, toast.title), toast.body === undefined ? null : h('p', { className: 'toast__body' }, toast.body)),
  h(IconButton, { icon: X, label: 'Dismiss', size: 'sm', onClick: () => dispatch({ type: 'dismiss', id }) }));
}

export interface ToastRegionProps {
  toasts: readonly ToastItem[];
  dispatch: Dispatch<ToastAction>;
  /** In the page flow instead of fixed at the bottom right (the catalogue). */
  inline?: boolean;
}

export function ToastRegion(props: ToastRegionProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const { dispatch } = props;
  const { shown, more } = toastStack(props.toasts, expanded);
  // Once nothing waits, the next overflow starts collapsed again.
  useEffect(() => {
    if (more === 0) setExpanded(false);
  }, [more]);
  // Before the browser paints: toasts now in a live region are marked announced, and announced toasts the stack hides
  // are marked hidden. A toast that never rendered (it waited beyond the maximum from the start) is not marked hidden,
  // so it is announced in its live region when it first shows.
  const showing = new Set(shown.map((t) => t.id));
  const marks = JSON.stringify([
    ...shown.filter((t) => t.hiddenOnce !== true && t.announced !== true).map((t) => ({ type: 'announced', id: t.id })),
    ...props.toasts.filter((t) => t.announced === true && t.phase !== 'exiting' && t.hiddenOnce !== true && !showing.has(t.id)).map((t) => ({ type: 'hidden', id: t.id })),
  ]);
  useLayoutEffect(() => {
    for (const action of JSON.parse(marks) as ToastAction[]) dispatch(action);
  }, [marks, dispatch]);
  const list = (danger: boolean, hiddenOnce: boolean): ReactElement[] => shown
    .filter((t) => (t.tone === 'danger') === danger && (t.hiddenOnce === true) === hiddenOnce)
    .map((t) => h(Toast, { key: t.id, toast: t, dispatch }));
  // Shown again after being hidden: above the live region (they are older), outside it.
  const again = (danger: boolean): ReactElement | null => {
    const items = list(danger, true);
    return items.length === 0 ? null : h('div', { className: 'toasts__again' }, items);
  };
  return h('div', { className: props.inline === true ? 'toasts toasts--inline' : 'toasts' },
    more === 0 ? null : h('button', { type: 'button', className: 'btn btn--secondary btn--sm toasts__more', 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) },
      h('span', { className: 'btn__label' }, expanded ? 'Show fewer' : `${more} more`)),
    again(false),
    h('div', { role: 'status', 'aria-live': 'polite', className: 'toasts__region' }, list(false, false)),
    again(true),
    h('div', { role: 'alert', 'aria-live': 'assertive', className: 'toasts__region' }, list(true, false)));
}

/** Toast state for a page: the toasts, the dispatcher, and push() to add one. */
export function useToasts(initial: readonly ToastItem[] = []): { toasts: ToastItem[]; dispatch: Dispatch<ToastAction>; push(t: ToastInput): void } {
  const [toasts, dispatch] = useReducer(toastReducer, [...initial]);
  return { toasts, dispatch, push: (toast) => dispatch({ type: 'add', toast }) };
}
