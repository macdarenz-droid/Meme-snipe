// HoldButton (C03, UI-T07): the header's HALT control. Pressing and holding with a pointer for 1000 ms
// (`--hold-to-confirm`) fills a progress ring and then calls onConfirm; releasing, cancelling (touch cancel), losing
// the pointer, leaving the button or moving more than 10 px (a finger resting on HALT while the page scrolls) before
// that rewinds the ring over 160 ms and does nothing. Enter and Space never hold: they open the
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

/** A pointer that moves farther than this during a hold cancels it (a scroll, not a hold). */
export const HOLD_MOVE_PX = 10;
/** How long after a pointer up its click may arrive; a later click is a new activation. */
export const CLICK_AFTER_UP_MS = 1000;

/** The ring's circumference (r = 8 in a 20 px box), the stroke-dasharray the fill animates. */
export const RING_LENGTH = 50.27;

export function HoldButton(props: HoldButtonProps): ReactElement {
  const id = useId();
  const [phase, setPhase] = useState<'idle' | 'holding' | 'released-early'>('idle');
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rewind = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The pointer press in progress or just released (its click follows); null when there is none. */
  const press = useRef<{ x: number; y: number; up: boolean } | null>(null);
  const upTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The window-level listener that sees the press's pointer up or cancel wherever it lands (no pointer capture): an up
   * starts the claim's expiry, a cancel ends the claim (Z05 rounds 5 and 6, rulings 22 and 27).
   */
  const windowUp = useRef<((e: globalThis.PointerEvent) => void) | null>(null);
  const stopWindowUp = (): void => {
    const listener = windowUp.current;
    if (listener === null) return;
    window.removeEventListener('pointerup', listener, true);
    window.removeEventListener('pointercancel', listener, true);
    windowUp.current = null;
  };
  const status = props.status ?? 'idle';
  const state: HoldState = status === 'idle' ? props.preview ?? phase : status;
  const label = props.label ?? 'Halt';

  useEffect(() => () => {
    if (hold.current !== null) clearTimeout(hold.current);
    if (rewind.current !== null) clearTimeout(rewind.current);
    if (upTimer.current !== null) clearTimeout(upTimer.current);
    stopWindowUp();
  }, []);

  const start = (e: PointerEvent<HTMLButtonElement>): void => {
    // Checks first: only a primary-button press that starts a hold marks the next click as the pointer's own (Z05 round
    // 2, reviewer m3: a refused press must not swallow a later screen-reader click).
    if (e.button !== 0 || status === 'sending' || hold.current !== null) return;
    press.current = { x: e.clientX, y: e.clientY, up: false };
    if (upTimer.current !== null) { clearTimeout(upTimer.current); upTimer.current = null; }
    // The press's pointer up starts the claim's expiry wherever it lands: on the button, or outside it when the
    // browser gave no pointer capture (Z05 round 5, ruling 22); a cancel anywhere ends the claim (round 6, ruling 27).
    const id = e.pointerId;
    stopWindowUp();
    windowUp.current = (w) => {
      if (w.pointerId !== id) return;
      if (w.type === 'pointercancel') abort(); else up();
    };
    window.addEventListener('pointerup', windowUp.current, true);
    window.addEventListener('pointercancel', windowUp.current, true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (rewind.current !== null) { clearTimeout(rewind.current); rewind.current = null; }
    setPhase('holding');
    hold.current = setTimeout(() => {
      hold.current = null;
      setPhase('idle');
      props.onConfirm();
    }, HOLD_TO_CONFIRM_MS);
  };
  /** Stops a hold that has not completed: the ring rewinds and nothing is sent. */
  const rewindHold = (): void => {
    if (hold.current === null) return;
    clearTimeout(hold.current);
    hold.current = null;
    setPhase('released-early');
    rewind.current = setTimeout(() => { rewind.current = null; setPhase('idle'); }, HOLD_REWIND_MS);
  };
  /** The press's claim on its click ends CLICK_AFTER_UP_MS from now. */
  const expireClaim = (): void => {
    if (upTimer.current !== null) clearTimeout(upTimer.current);
    upTimer.current = setTimeout(() => { upTimer.current = null; press.current = null; }, CLICK_AFTER_UP_MS);
  };
  /** The press's pointer went up: a click on the button may follow, which belongs to this press and opens nothing. */
  const up = (): void => {
    rewindHold();
    stopWindowUp();
    if (press.current === null) return;
    press.current.up = true;
    // If the browser sends no click after all, the mark expires, so it never swallows a later activation.
    expireClaim();
  };
  /** The press ended without a pointer up on the button (touch cancel, lost capture): no click follows. */
  const abort = (): void => {
    rewindHold();
    stopWindowUp();
    if (press.current !== null && !press.current.up) press.current = null;
  };
  /**
   * A finger resting on HALT while the page scrolls is not a hold: a move over HOLD_MOVE_PX, or leaving the button,
   * cancels it. The press keeps its claim on the click its pointer up brings, so releasing on the button opens nothing
   * (Z05 round 3, ruling 13). The claim is kept while the pointer is down, however long; its expiry starts from the
   * pointer up, on the button or anywhere on the page (Z05 round 5, ruling 22, replacing round 4's expiry from the
   * move), or the claim ends on touch cancel or lost capture.
   */
  const moveAway = (): void => {
    const p = press.current;
    if (p === null || p.up) return;
    rewindHold();
  };
  const move = (e: PointerEvent<HTMLButtonElement>): void => {
    const p = press.current;
    if (p === null || p.up || hold.current === null) return;
    if ((e.clientX - p.x) ** 2 + (e.clientY - p.y) ** 2 > HOLD_MOVE_PX ** 2) moveAway();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (!e.repeat) props.onOpenDialog();
  };
  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    if (press.current !== null) {
      press.current = null;
      if (upTimer.current !== null) { clearTimeout(upTimer.current); upTimer.current = null; }
      return;
    }
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
      onPointerUp: up,
      onPointerCancel: abort,
      onLostPointerCapture: abort,
      onPointerLeave: moveAway,
      onPointerMove: move,
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
