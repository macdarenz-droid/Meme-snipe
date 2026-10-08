// Countdown (C44, UI-T07): a scheduled change (an A3 action's 60-second delay, D-UI-13) counting down to the server's
// effective time. Time left = effective_at − (local now + server clock offset), so it follows the server clock, not
// the browser's, and never goes below 0:00. States: running, cancelled, elapsed (time is up; the server has not yet
// confirmed) and server-confirmed. Cancelling is A1 (one click); the caller wires it.
import { createElement as h, type ReactElement } from 'react';
import { formatCountdown, parseAt } from '../lib/money.ts';
import { remainingMs } from '../lib/safety.ts';
import { Button } from './button.ts';
import { cx } from './cx.ts';
import { useNow, type ClockSource } from './states.ts';

export type CountdownState = 'running' | 'cancelled' | 'elapsed' | 'server-confirmed';

export interface CountdownProps {
  /** What happens, as the mode bar names it (`LIVE-SMALL`, `RAISE MAXPOS 0.30`). */
  label: string;
  /** The server's effective time (`scheduled_change.effective_at`, RFC 3339 UTC with milliseconds). */
  effectiveAt: string;
  source: ClockSource;
  /** Set by the caller from VM-03: the change was cancelled, or the server reports it applied. */
  outcome?: 'cancelled' | 'server-confirmed';
  onCancel?: () => void;
}

/** The countdown's state at a time left of `leftMs`. */
export function countdownState(leftMs: number, outcome: CountdownProps['outcome']): CountdownState {
  if (outcome !== undefined) return outcome;
  return leftMs > 0 ? 'running' : 'elapsed';
}

function atOrNull(iso: string): number | null {
  try {
    return parseAt(iso);
  } catch {
    return null;
  }
}

export function Countdown(props: CountdownProps): ReactElement {
  const now = useNow(props.source.clock, 1000, `${props.effectiveAt} ${props.source.offsetMs ?? 0}`);
  // A malformed effective time (refused upstream by the schema check) shows as unknown, never a throw out of render,
  // and never as time left. Cancel (A1, it reduces risk) stays offered while the change is still pending.
  const at = atOrNull(props.effectiveAt);
  const left = at === null ? 0 : remainingMs(at, now, props.source.offsetMs ?? 0);
  const state = countdownState(left, props.outcome);
  const text = at === null && state === 'elapsed' ? `${props.label} at an unknown time · waiting for the server`
    : state === 'running' ? `${props.label} in ${formatCountdown(left)}`
    : state === 'elapsed' ? `${props.label} due · waiting for the server`
      : state === 'cancelled' ? `${props.label} cancelled` : `${props.label} applied`;
  return h('div', { className: cx('countdown', `countdown--${state}`), 'data-state': state },
    h('span', { className: 'countdown__text', role: 'timer', 'aria-label': text }, text),
    (state === 'running' || (at === null && props.outcome === undefined)) && props.onCancel !== undefined ? h(Button, { variant: 'secondary', size: 'sm', onClick: props.onCancel }, 'Cancel') : null);
}
