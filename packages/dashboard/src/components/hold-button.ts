// HoldButton (C03, UI-T07): the header's HALT control. Pressing and holding with a pointer for 1000 ms
// (`--hold-to-confirm`) fills a progress ring and then calls onConfirm; releasing, cancelling (touch cancel) or losing
// the pointer before that rewinds the ring over 160 ms and does nothing. Enter and Space never hold: they open the
// HALT dialog (onOpenDialog), and so does a click that no pointer press started (a screen reader's activation).
// The server-side states (sending, acked, unconfirmed after 5 s, failed) come from the caller (UI-T13).
import { createElement as h, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement } from 'react';
import { HOLD_REWIND_MS, HOLD_TO_CONFIRM_MS } from '../lib/safety.ts';
import { cx } from './cx.ts';
import { Icon, STATE_ICONS } from './icon.ts';
import type { LucideIcon } from 'lucide-react';

export type HoldServerStatus = 'idle' | 'sending' | 'acked' | 'unconfirmed' | 'failed';
export type HoldState = 'idle' | 'holding' | 'released-early' | Exclude<HoldServerStatus, 'idle'>;

export interface HoldButtonProps {
  /** The server side of the HALT command (default idle). */
  status?: HoldServerStatus;
  onConfirm(): void;
  onOpenDialog(): void;
  label?: string;
  /** Shows a gesture state without a pointer (the catalogue's static stories only). */
  preview?: 'holding' | 'released-early';
}

const STATUS_TEXT: Readonly<Record<Exclude<HoldServerStatus, 'idle'>, string>> = {
  sending: 'Halting…', acked: 'Halted', unconfirmed: 'Halt not confirmed', failed: 'Halt failed',
};

/** The ring's circumference (r = 8 in a 20 px box), the stroke-dasharray the fill animates. */
export const RING_LENGTH = 50.27;

export function HoldButton(props: HoldButtonProps): ReactElement {
  const id = useId();
  const [phase, setPhase] = useState<'idle' | 'holding' | 'released-early'>('idle');
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rewind = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerPress = useRef(false);
  const status = props.status ?? 'idle';
  const state: HoldState = status === 'idle' ? props.preview ?? phase : status;
  const label = props.label ?? 'Halt';

  useEffect(() => () => {
    if (hold.current !== null) clearTimeout(hold.current);
    if (rewind.current !== null) clearTimeout(rewind.current);
  }, []);

  const start = (e: PointerEvent<HTMLButtonElement>): void => {
    pointerPress.current = true;
    if (e.button !== 0 || status === 'sending' || hold.current !== null) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (rewind.current !== null) { clearTimeout(rewind.current); rewind.current = null; }
    setPhase('holding');
    hold.current = setTimeout(() => {
      hold.current = null;
      setPhase('idle');
      props.onConfirm();
    }, HOLD_TO_CONFIRM_MS);
  };
  const release = (): void => {
    if (hold.current === null) return;
    clearTimeout(hold.current);
    hold.current = null;
    setPhase('released-early');
    rewind.current = setTimeout(() => { rewind.current = null; setPhase('idle'); }, HOLD_REWIND_MS);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (!e.repeat) props.onOpenDialog();
  };
  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    if (pointerPress.current) { pointerPress.current = false; return; }
    props.onOpenDialog();
  };

  const text = status === 'idle' ? label : STATUS_TEXT[status];
  return h('span', { className: 'hold-wrap' },
    h('button', {
      type: 'button',
      className: cx('hold-btn', `hold-btn--${state}`),
      'data-state': state,
      'aria-describedby': `${id}-hint`,
      'aria-busy': status === 'sending' || undefined,
      onPointerDown: start,
      onPointerUp: release,
      onPointerCancel: release,
      onLostPointerCapture: release,
      onKeyDown,
      onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => { if (e.key === ' ') e.preventDefault(); },
      onClick,
      onContextMenu: (e: MouseEvent<HTMLButtonElement>) => e.preventDefault(),
    },
    h('svg', { className: 'hold-btn__ring', viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': true },
      h('circle', { className: 'hold-btn__track', cx: 10, cy: 10, r: 8 }),
      h('circle', { className: 'hold-btn__fill', cx: 10, cy: 10, r: 8, strokeDasharray: RING_LENGTH })),
    h(Icon, { icon: STATE_ICONS['halt'] as LucideIcon, className: 'hold-btn__icon' }),
    h('span', { className: 'hold-btn__label' }, text)),
    h('span', { id: `${id}-hint`, className: 'visually-hidden' }, `Press and hold for 1 second to ${label.toLowerCase()}. Enter opens the ${label.toLowerCase()} dialog.`),
    h('span', { className: 'visually-hidden', role: 'status' }, status === 'idle' ? '' : STATUS_TEXT[status]));
}
